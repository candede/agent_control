import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import type { UsersRouteState } from "../workbenchRouting";
import { copilotUsageFixture } from "../test/copilotUsageFixture";
import { usageAgentDetailFixture, usageFixtureSetId, usageUsersFixture } from "../test/usageInsightsFixture";
import { UserAgentMatrix } from "./UserAgentMatrix";

const initialRoute: UsersRouteState = { view: "matrix", search: "", page: 0 };
function directoryFixture() {
  const data = structuredClone(copilotUsageFixture);
  data.users = data.users.map(user => ({
    ...user,
    importedUsage: usageUsersFixture().users.value.find(row => row.username === user.directory.userPrincipalName) ?? null,
  }));
  return data;
}

function renderMatrix(route = initialRoute, directoryData = directoryFixture()) {
  const onInspectUser = vi.fn();
  const changed = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(route);
    return <UserAgentMatrix route={current} directoryData={directoryData} onInspectUser={onInspectUser} onRouteChange={(next, replace) => { setCurrent(next); changed(next, replace); }} />;
  }
  return { ...render(<Harness />), onInspectUser, changed };
}

beforeEach(() => {
  vi.spyOn(api, "getOfficialUsageUsers").mockImplementation(async query => usageUsersFixture({
    staleAfterDays: 35, ...query, userSortBy: query?.sortBy,
  }));
  vi.spyOn(api, "getOfficialUsageAgentDetail").mockImplementation(async id => usageAgentDetailFixture(id));
});
afterEach(() => vi.restoreAllMocks());

describe("user-agent matrix", () => {
  it("shows all report identities and distinguishes explicit zero from absent relationships", async () => {
    const { onInspectUser } = renderMatrix();
    const matrix = await screen.findByRole("region", { name: "User-agent response matrix" });
    const rows = within(matrix).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(matrix).getByRole("row", { name: /Ben/ })).toHaveTextContent("0");
    expect(within(matrix).getByRole("row", { name: /Cleo/ })).toHaveTextContent("Not reported");
    expect(within(matrix).getByRole("row", { name: /Concealed report user/ })).toHaveTextContent("Unknown");
    expect(within(matrix).queryByText(/Sep 12/)).not.toBeInTheDocument();
    await userEvent.click(within(matrix).getByRole("button", { name: "Ada" }));
    expect(onInspectUser).toHaveBeenCalledWith(expect.objectContaining({ directory: expect.objectContaining({ userPrincipalName: "ada@example.invalid" }) }));
    expect(screen.getByText(/All-agent responses come from the Users report/)).toBeVisible();
  });

  it("focuses exact report IDs including opaque punctuation before paging", async () => {
    const { changed } = renderMatrix();
    await userEvent.click(await screen.findByRole("button", { name: "Helpdesk" }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "helpdesk/report:2", reportSetId: usageFixtureSetId, page: 0 }), undefined);
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "helpdesk/report:2", setId: usageFixtureSetId, offset: 0, limit: 50 }), expect.anything()));
    const matrix = await screen.findByRole("region", { name: "User-agent response matrix" });
    expect(within(matrix).queryByRole("button", { name: "Researcher" })).not.toBeInTheDocument();
    expect(within(matrix).getAllByRole("row")).toHaveLength(3);
    expect(await screen.findByRole("region", { name: "Usage report for Helpdesk" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Show all agents" }));
    expect(await screen.findByRole("button", { name: "Researcher" })).toBeVisible();
  });

  it("pins a column drilldown to the displayed snapshot when the tenant selection changes", async () => {
    let selectedSetId = usageFixtureSetId;
    vi.mocked(api.getOfficialUsageUsers).mockImplementation(async query => {
      const data = usageUsersFixture({ ...query, staleAfterDays: 35 });
      data.activeSet = { ...data.activeSet!, id: query?.setId ?? selectedSetId };
      return data;
    });
    const { changed } = renderMatrix();
    const column = await screen.findByRole("button", { name: "Researcher" });
    selectedSetId = "33333333-3333-4333-8333-333333333333";
    await userEvent.click(column);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: "synthetic-researcher", reportSetId: usageFixtureSetId,
    }), undefined);
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(
      expect.objectContaining({ setId: usageFixtureSetId }), expect.anything()));
    expect(api.getOfficialUsageAgentDetail).toHaveBeenLastCalledWith("synthetic-researcher",
      expect.objectContaining({ setId: usageFixtureSetId }), expect.anything());
    expect(screen.getByText(/Viewing the exact retained report snapshot/)).toBeVisible();
  });

  it.each(["version", "case", "ambiguous", "unavailable"] as const)("does not assign a license when the saved identity link is %s", async scenario => {
    const directory = directoryFixture();
    const ada = directory.users[0];
    if (scenario === "version") ada.importedUsage!.datasetScope.usersVersionId = "older-version";
    if (scenario === "case") ada.importedUsage!.username = "ADA@example.invalid";
    if (scenario === "ambiguous") directory.users.push({ ...ada, directory: { ...ada.directory, objectId: "another-directory-user" } });
    if (scenario === "unavailable") directory.sources.directory.state = "unavailable";
    renderMatrix(initialRoute, directory);
    const matrix = await screen.findByRole("region", { name: "User-agent response matrix" });
    const row = within(matrix).getByRole("row", { name: /Ada/ });
    expect(row).toHaveTextContent("Unknown");
    expect(within(row).queryByRole("button", { name: "Ada" })).not.toBeInTheDocument();
  });

  it("pins a linked report snapshot and never falls back to current data on failure", async () => {
    vi.mocked(api.getOfficialUsageUsers).mockRejectedValueOnce(new Error("The selected report was deleted"));
    const { changed } = renderMatrix({ ...initialRoute, reportSetId: usageFixtureSetId, agentId: "synthetic-researcher" });
    expect(await screen.findByRole("alert")).toHaveTextContent("The selected report was deleted");
    expect(screen.queryByLabelText("Matrix coverage")).not.toBeInTheDocument();
    expect(api.getOfficialUsageUsers).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "synthetic-researcher", setId: usageFixtureSetId }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Use current reports" }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ reportSetId: undefined, page: 0 }), undefined);
    expect(await screen.findByLabelText("Matrix coverage")).toBeVisible();
  });

  it("does not present a missing companion as zero relationships", async () => {
    const data = usageUsersFixture();
    data.lineages = data.lineages.filter(lineage => lineage.kind !== "userAgents");
    data.counts.accessRows = 0;
    for (const user of data.users.value) user.rows = [];
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(data);
    renderMatrix();
    const coverage = await screen.findByLabelText("Matrix coverage");
    expect(within(coverage).getByText("User-agent relationships").parentElement).toHaveTextContent("Unknown");
    expect(screen.getByText(/Relationships are unknown, not zero/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Review the report bundle" })).toBeVisible();
  });

  it("recovers an out-of-range user page without claiming no matching identities", async () => {
    const { changed } = renderMatrix({ ...initialRoute, page: 1, reportSetId: usageFixtureSetId });
    expect(await screen.findByRole("heading", { name: "No reported users on this page" })).toBeVisible();
    expect(screen.getByLabelText("Matrix user pages")).toHaveTextContent("No reported users on this page (4 matching)");
    expect(screen.getByLabelText("Matrix user pages")).not.toHaveTextContent("51-4");
    await userEvent.click(screen.getByRole("button", { name: "First user page" }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0, reportSetId: usageFixtureSetId }), undefined);
    expect(await screen.findByRole("region", { name: "User-agent response matrix" })).toBeVisible();
  });

  it("keeps search focused, resets paging and aborts obsolete requests", async () => {
    const { changed, unmount } = renderMatrix({ ...initialRoute, page: 1 });
    await screen.findByLabelText("Matrix coverage");
    const search = screen.getByRole("searchbox", { name: "Search the user-agent matrix" });
    const firstSignal = vi.mocked(api.getOfficialUsageUsers).mock.calls[0][1]?.signal;
    await userEvent.type(search, "Ada");
    expect(search).toHaveFocus();
    expect(search).toHaveValue("Ada");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Ada", page: 0 }), true);
    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => expect(api.getOfficialUsageUsers).toHaveBeenLastCalledWith(expect.objectContaining({ search: "Ada", offset: 0 }), expect.anything()));
    const lastSignal = vi.mocked(api.getOfficialUsageUsers).mock.calls.at(-1)?.[1]?.signal;
    unmount();
    expect(lastSignal?.aborted).toBe(true);
  });

  it("pages agent columns instead of silently dropping relationships", async () => {
    const data = usageUsersFixture();
    const user = data.users.value[0];
    user.rows = Array.from({ length: 8 }, (_, index) => ({ ...user.rows[0], agentId: `report-${index}`, displayAgentName: `Reported agent ${index}`, responsesSentToUsers: index }));
    data.users.value = [user];
    vi.mocked(api.getOfficialUsageUsers).mockResolvedValue(data);
    renderMatrix();
    const matrix = await screen.findByRole("region", { name: "User-agent response matrix" });
    expect(within(matrix).getAllByRole("columnheader")).toHaveLength(9);
    expect(within(matrix).queryByText("Reported agent 6")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next columns" }));
    expect(within(matrix).getByText("Reported agent 6")).toBeVisible();
    expect(within(matrix).getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByText(/Agent columns 7-8 of 8/)).toBeVisible();
  });

  it("does not show late success after an exact filter has changed", async () => {
    let finish!: (value: api.OfficialUsageUserView) => void;
    vi.mocked(api.getOfficialUsageUsers).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    renderMatrix();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search the user-agent matrix" }), "Ben");
    const matrix = await screen.findByRole("region", { name: "User-agent response matrix" });
    await act(async () => finish(usageUsersFixture()));
    expect(within(matrix).getAllByRole("row")).toHaveLength(2);
    expect(within(matrix).queryByText("Ada")).not.toBeInTheDocument();
  });
});
