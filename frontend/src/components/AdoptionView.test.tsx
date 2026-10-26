import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionGroup, AdoptionPage } from "../../../backend/src/types/adoption";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { reportPage, reportSelection, reports, source } from "../test/reportDataFixture";
import { PublicationContext } from "../publicationContext";
import { parseUsersRoute, usersRouteSearch } from "../workbenchRouting";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { deferred } from "../test/deferred";
import { AdoptionView } from "./AdoptionView";
import { CopilotUsersView } from "./CopilotUsersView";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn(), readReportFacet: vi.fn(),
}));
const group: AdoptionGroup = {
  id: "group-hr", company: "Contoso", department: "HR",
  people: [
    { id: "person-1", name: "Maya", agents: 10, responses: 200, champion: true },
    { id: "person-2", name: "Alex", agents: 2, responses: 40, champion: true },
    { id: "person-3", name: "Robin", agents: 0, responses: null, champion: false },
  ],
  agents: [{ id: "agent:10000000-0000-4000-8000-000000000001", name: "Policy Assistant",
    description: "Answers employee policy questions.", type: "Microsoft 365 Copilot Agent Builder" }],
};
function page(value: AdoptionGroup[] = [group], number = 1, total = value.length): AdoptionPage {
  const result = reportPage(value, { counts: { total, filtered: total } });
  return { ...result, page: { ...result.page, limit: 5, number, offset: (number - 1) * 5, anchor: value[0]?.id }, directory: source("directory"), inventoryAvailable: true,
    summary: { people: value.reduce((sum, group) => sum + group.people.length, 0),
      champs: value.reduce((sum, group) => sum + group.people.filter(person => person.champion).length, 0),
      agents: new Set(value.flatMap(group => group.agents.map(agent => agent.id))).size } };
}
const route = { ...parseUsersRoute(""), section: "adoption" as const };
const change = vi.fn(), onOpenAgent = vi.fn(), onOpenPerson = vi.fn();
const pages = () => within(screen.getByRole("navigation", { name: "groups pages" }));
function mount() {
  return render(<SavedQueryProvider><AdoptionView route={route} change={change} revision={0}
    reportContext={<span>Selected reports</span>} onOpenAgent={onOpenAgent} onOpenPerson={onOpenPerson} /></SavedQueryProvider>);
}
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.mocked(api.readReportPage).mockResolvedValue(page());
  vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, field) => ({
    ...reportPage([{ value: field === "company" ? "Contoso" : "HR", count: 1 }]),
  }));
});
afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });

describe("Adoption", () => {
  it("shows both independent lists without collapsed sections or creator details", async () => {
    mount();
    const section = within(await screen.findByRole("region", { name: "Contoso / HR" }));
    expect(section.getByRole("button", { name: "Maya" })).toBeVisible();
    expect(section.getByRole("button", { name: "Robin" })).toBeVisible();
    expect(section.getAllByText("Copilot Champ")).toHaveLength(2);
    expect(section.getByText("10/200")).toBeVisible();
    expect(section.getByText("0/Unknown")).toBeVisible();
    expect(section.getByText("3 users · 1 agent")).toBeVisible();
    expect(section.getByText("Answers employee policy questions.")).toBeVisible();
    expect(section.getByText("Agent Builder")).toBeVisible();
    expect(document.querySelector("details")).toBeNull();
    expect(screen.queryByText(/Built in group|Used by|Created by/)).not.toBeInTheDocument();
    fireEvent.click(section.getByRole("button", { name: "Policy Assistant" }));
    expect(onOpenAgent).toHaveBeenCalledWith(group.agents[0].id);
    fireEvent.click(section.getByRole("button", { name: "Maya" }));
    expect(onOpenPerson).toHaveBeenCalledWith("person-1");
  });
  it("searches group names and clears only search", async () => {
    mount(); await screen.findByText("Maya");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search groups" }), { target: { value: "Contoso HR" } });
    expect(change).toHaveBeenCalledWith({ ...route, search: "Contoso HR" });
    render(<SavedQueryProvider><AdoptionView route={{ ...route, search: "HR", reportSetId: reports.setId! }} change={change}
      revision={0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(change).toHaveBeenLastCalledWith({ ...route, reportSetId: reports.setId, search: "" });
  });
  it("waits for typing to settle before reading matching groups", async () => {
    const content = (search: string) => <SavedQueryProvider><AdoptionView route={{ ...route, search, company: "Contoso" }}
      change={change} revision={0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>;
    const view = render(content(""));
    await screen.findByText("Maya");
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    view.rerender(content("h"));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    view.rerender(content("hr"));
    expect(screen.getByRole("searchbox", { name: "Search groups" })).toHaveValue("hr");
    expect(screen.queryByText("Maya")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Matching groups" })).toHaveTextContent("Updating...");
    await act(async () => { await vi.advanceTimersByTimeAsync(299); });
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/adoption",
      expect.objectContaining({ search: "hr", company: "Contoso", limit: 5 }), expect.any(AbortSignal));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Maya")).toBeVisible();
  });
  it("does not start a pending search after leaving Adoption", async () => {
    const content = (search: string) => <SavedQueryProvider><AdoptionView route={{ ...route, search }}
      change={change} revision={0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>;
    const view = render(content(""));
    await screen.findByText("Maya");
    vi.useFakeTimers();
    view.rerender(content("hr"));
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
  });
  it.each(["HR", " "])("uses the shared inline X for entered search %j and preserves group filters", async text => {
    const filtered = { ...route, search: text, company: "Contoso", department: "HR",
      adoptionChamps: "with" as const, adoptionAgents: "with" as const, reportSetId: reports.setId! };
    const content = (search: string) => <SavedQueryProvider><AdoptionView route={{ ...filtered, search }} change={change}
      revision={0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>;
    const view = render(content(text));
    const search = screen.getByRole("searchbox", { name: "Search groups" });
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveClass("agent-search-clear");
    expect(search.parentElement).toHaveClass("agent-search-field-clearable");
    expect(clear.parentElement).toBe(search.parentElement);
    expect(clear.querySelector("svg")).toHaveClass("lucide-x");
    expect(clear.textContent).toBe("");
    expect(clear).toHaveAttribute("title", "Clear search");
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(change).toHaveBeenLastCalledWith({ ...filtered, search: "" });
    expect(search).toHaveFocus();
    view.rerender(content(""));
    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove company filter" })).toHaveTextContent("Contoso");
    expect(screen.getByRole("button", { name: "Remove copilot champs filter" })).toBeVisible();
  });
  it("pages groups with one numbered request pinned to the existing selection", async () => {
    const first = page(undefined, 1, 6);
    first.page.nextCursor = "group-next";
    vi.mocked(api.readReportPage).mockResolvedValue(first);
    mount(); await screen.findByText("Maya");
    fireEvent.click(pages().getByRole("button", { name: "Next groups" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/adoption",
      expect.objectContaining({ limit: 5, selectionId: first.selection.id, pageNumber: 2 }), expect.any(AbortSignal)));
  });
  it("keeps the current groups and summary mounted while the next page loads", async () => {
    const first = page(undefined, 1, 6), pending = deferred<AdoptionPage>();
    first.page.nextCursor = "group-next";
    vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    mount();
    const region = await screen.findByRole("region", { name: "Contoso / HR" });
    fireEvent.click(pages().getByRole("button", { name: "Next groups" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("region", { name: "Contoso / HR" })).toBe(region);
    expect(screen.getByRole("status", { name: "Matching groups" })).toHaveTextContent("6 matching groups");
    expect(pages().getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Maya" }));
    expect(onOpenPerson).not.toHaveBeenCalled();
    const second = page([{ ...group, id: "group-it", department: "IT" }], 2, 6);
    second.page.previousCursor = "group-previous";
    await act(async () => pending.resolve(second));
    expect(await screen.findByRole("region", { name: "Contoso / IT" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Contoso / HR" })).not.toBeInTheDocument();
  });
  it("jumps directly to page four in one request, focuses results, and synchronizes both controls", async () => {
    const first = page(undefined, 1, 20), fourth = page([{ ...group, id: "group-finance", department: "Finance" }], 4, 20);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockResolvedValueOnce(fourth);
    mount();
    await screen.findByText("Maya");
    fireEvent.click(pages().getByRole("button", { name: "Page 4" }));
    await screen.findByRole("region", { name: "Contoso / Finance" });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/adoption",
      expect.objectContaining({ pageNumber: 4, selectionId: first.selection.id }), expect.any(AbortSignal));
    expect(screen.getByRole("heading", { name: "Company & department adoption" })).toHaveFocus();
    for (const name of ["groups pages", "groups pages (bottom)"]) {
      expect(within(screen.getByRole("navigation", { name })).getByRole("button", { name: "Page 4" })).toHaveAttribute("aria-current", "page");
    }
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start" });
  });
  it.each(["publication", "revision", "expiry"] as const)(
    "preserves the displayed group position when %s refreshes a later page", async boundary => {
      const first = page(undefined, 1, 6), second = page([{ ...group, id: "group-it", department: "IT" }], 2, 6);
      first.page.nextCursor = "group-next";
      second.page.previousCursor = "group-previous";
      const pending = deferred<AdoptionPage>();
      vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockReturnValueOnce(pending.promise);
      let revisions = first.selection.publicationRevisions;
      const content = (revision = 0) => <SavedQueryProvider><PublicationContext value={{ admit: vi.fn(), revisions }}>
        <AdoptionView route={route} change={change} revision={revision} reportContext={null} onOpenPerson={onOpenPerson} />
      </PublicationContext></SavedQueryProvider>;
      const view = render(content());
      await screen.findByRole("region", { name: "Contoso / HR" });
      fireEvent.click(pages().getByRole("button", { name: "Next groups" }));
      const region = await screen.findByRole("region", { name: "Contoso / IT" });
      if (boundary === "publication") {
        revisions = { ...revisions, users: "4".repeat(64) };
        view.rerender(content());
      } else if (boundary === "revision") view.rerender(content(1));
      else {
        vi.spyOn(performance, "now").mockReturnValue(performance.now() + 600_001);
        act(() => window.dispatchEvent(new Event("focus")));
      }
      await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
      const request = vi.mocked(api.readReportPage).mock.lastCall?.[1];
      expect(request).toEqual(expect.objectContaining({ anchor: second.value[0].id, limit: 5 }));
      expect(request).not.toHaveProperty("selectionId");
      expect(request).not.toHaveProperty("cursor");
      expect(screen.getByRole("region", { name: "Contoso / IT" })).toBe(region);
      fireEvent.click(screen.getByRole("button", { name: "Maya" }));
      expect(onOpenPerson).not.toHaveBeenCalled();
      const fresh = { ...page(second.value, 2, 6), selection: { ...reportSelection(3), publicationRevisions: revisions } };
      fresh.page.previousCursor = "fresh-previous";
      await act(async () => pending.resolve(fresh));
      await waitFor(() => expect(pages().getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", "false"));
      expect(screen.getByRole("region", { name: "Contoso / IT" })).toBe(region);
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      vi.mocked(api.readReportPage).mockResolvedValue({ ...first, selection: fresh.selection });
      fireEvent.click(pages().getByRole("button", { name: "Previous groups" }));
      await screen.findByRole("region", { name: "Contoso / HR" });
      expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/adoption",
        expect.objectContaining({ pageNumber: 1, selectionId: fresh.selection.id }), expect.any(AbortSignal));
      expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).not.toHaveProperty("anchor");
    });
  it("starts new filtered results at the beginning without showing or replaying the previous page", async () => {
    const first = page(undefined, 1, 6), second = page([{ ...group, id: "group-it", department: "IT" }], 2, 6);
    first.page.nextCursor = "group-next";
    second.page.previousCursor = "group-previous";
    const pending = deferred<AdoptionPage>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockReturnValueOnce(pending.promise);
    const content = (company?: string) => <SavedQueryProvider><AdoptionView route={{ ...route, company }} change={change}
      revision={company ? 1 : 0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>;
    const view = render(content());
    await screen.findByText("Maya");
    fireEvent.click(pages().getByRole("button", { name: "Next groups" }));
    await screen.findByRole("region", { name: "Contoso / IT" });
    view.rerender(content("Fabrikam"));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("region", { name: "Contoso / IT" })).not.toBeInTheDocument();
    const request = vi.mocked(api.readReportPage).mock.lastCall?.[1];
    expect(request).toEqual(expect.objectContaining({ company: "Fabrikam" }));
    expect(request).not.toHaveProperty("anchor");
    expect(request).not.toHaveProperty("cursor");
    expect(request).not.toHaveProperty("selectionId");
    await act(async () => pending.resolve(page([{ ...group, id: "group-fabrikam", company: "Fabrikam" }])));
    expect(await screen.findByRole("region", { name: "Fabrikam / HR" })).toBeVisible();
    expect(pages().getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", "true");
  });
  it("carries the group anchor through overlapping refreshes and ignores a cancelled late response", async () => {
    const first = page(undefined, 1, 6), second = page([{ ...group, id: "group-it", department: "IT" }], 2, 6);
    first.page.nextCursor = "group-next";
    second.page.previousCursor = "group-previous";
    const superseded = deferred<AdoptionPage>(), latest = deferred<AdoptionPage>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
      .mockReturnValueOnce(superseded.promise).mockReturnValueOnce(latest.promise);
    const content = (revision: number) => <SavedQueryProvider><AdoptionView route={route} change={change}
      revision={revision} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>;
    const view = render(content(0));
    await screen.findByText("Maya");
    fireEvent.click(pages().getByRole("button", { name: "Next groups" }));
    const region = await screen.findByRole("region", { name: "Contoso / IT" });
    view.rerender(content(1));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    const supersededSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(content(2));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(4));
    expect(supersededSignal?.aborted).toBe(true);
    for (const call of vi.mocked(api.readReportPage).mock.calls.slice(2)) {
      expect(call[1]).toEqual(expect.objectContaining({ anchor: second.value[0].id }));
      expect(call[1]).not.toHaveProperty("selectionId");
      expect(call[1]).not.toHaveProperty("cursor");
    }
    expect(screen.getByRole("region", { name: "Contoso / IT" })).toBe(region);
    await act(async () => latest.resolve({ ...second, selection: reportSelection(4) }));
    await waitFor(() => expect(pages().getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", "false"));
    await act(async () => superseded.resolve({ ...first, selection: reportSelection(3) }));
    expect(screen.getByRole("region", { name: "Contoso / IT" })).toBe(region);
    expect(api.readReportPage).toHaveBeenCalledTimes(4);
  });
  it.each([403, 409])("withdraws retained group evidence when a page read is rejected with %i", async status => {
    const first = page(undefined, 1, 6), pending = deferred<AdoptionPage>();
    first.page.nextCursor = "group-next";
    vi.mocked(api.readReportPage).mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    mount();
    await screen.findByText("Maya");
    fireEvent.click(pages().getByRole("button", { name: "Next groups" }));
    expect(screen.getByRole("region", { name: "Contoso / HR" })).toBeVisible();
    await act(async () => pending.reject(new ApiError(status, status === 403 ? "forbidden" : "selection_invalidated", "Saved access changed.")));
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Contoso / HR" })).not.toBeInTheDocument();
    expect(pages().getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", "true");
  });
  it("shows empty groups and missing agent descriptions without inventing data", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page([{ ...group, agents: [] }]));
    mount();
    expect(await screen.findByText("No organization-built agents found.")).toBeVisible();
    expect(screen.getByText("Robin")).toBeVisible();
  });
  it("shows About markup as sanitized plain text", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page([{ ...group, agents: [{
      ...group.agents[0], description: '<p>Finds <strong>HR policies</strong> and onboarding guidance.</p><img src="x" onerror="alert(1)"><script>alert(1)</script>',
    }] }]));
    mount();
    const text = await screen.findByText("Finds HR policies and onboarding guidance.");
    expect(text.tagName).toBe("P");
    expect(text.children).toHaveLength(0);
    expect(text).not.toHaveTextContent("alert(1)");
  });
  it("limits long About previews without changing agent detail navigation", async () => {
    const description = "Useful guidance ".repeat(40);
    const result = page([{ ...group, agents: [{ ...group.agents[0], description }] }]);
    vi.mocked(api.readReportPage).mockResolvedValue(result);
    mount();
    const agent = await screen.findByRole("button", { name: "Policy Assistant" });
    const preview = agent.closest("li")!.querySelector("p")!.textContent!;
    expect(Array.from(preview).length).toBeLessThanOrEqual(300);
    expect(preview).toMatch(/…$/);
    expect(screen.queryByText(description.trim())).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show more/ })).not.toBeInTheDocument();
    fireEvent.click(agent);
    expect(onOpenAgent).toHaveBeenCalledWith(group.agents[0].id);
    expect(result.value[0].agents[0].description).toBe(description);
  });
  it("surfaces unavailable sources", async () => {
    const missing = page([]);
    missing.directory = { ...missing.directory, state: "unavailable" };
    missing.inventoryAvailable = false;
    missing.reports = { ...missing.reports, setId: null, availability: "never_imported" };
    vi.mocked(api.readReportPage).mockResolvedValue(missing);
    mount();
    expect(await screen.findByText(/Agent inventory is unavailable/)).toBeVisible();
    expect(screen.getByText(/Usage is unavailable/)).toBeVisible();
    expect(screen.getByText(/Group membership uses unavailable/)).toBeVisible();
  });
  it("surfaces read errors without showing successful empty results", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(403, "forbidden", "Viewer access required."));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Viewer access required.");
    expect(screen.queryByText(/No saved users|No groups match/)).not.toBeInTheDocument();
  });
  it("keeps Users selected by default and mounts Adoption only when selected", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path === "copilot-usage/adoption" ? page() : reportPage([]));
    render(<SavedQueryProvider><CopilotUsersView /></SavedQueryProvider>);
    expect(screen.getByRole("button", { name: "Users view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Users view" }).closest(".copilot-users-header")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "User cohort" })).toBeVisible();
    expect(api.readReportPage).not.toHaveBeenCalledWith("copilot-usage/adoption", expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Adoption" }));
    expect(await screen.findByText("Maya")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "User cohort" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Users view" }));
    expect(screen.getByRole("combobox", { name: "User cohort" })).toBeVisible();
    expect(screen.queryByText("Maya")).not.toBeInTheDocument();
  });
  it("round trips Adoption without changing existing cohort URLs", () => {
    const state = { ...route, search: "Contoso HR", reportSetId: reports.setId!, company: "~null", department: null,
      adoptionChamps: "with" as const, adoptionAgents: "without" as const };
    expect(parseUsersRoute(usersRouteSearch(state).toString())).toEqual(state);
    expect(usersRouteSearch(parseUsersRoute("")).toString()).toBe("");
    expect(parseUsersRoute("section=invalid").section).toBeUndefined();
    expect(parseUsersRoute("section=adoption&champs=invalid&groupAgents=invalid").adoptionChamps).toBeUndefined();
    expect(parseUsersRoute("company=Contoso&champs=with").company).toBeUndefined();
  });
  it("uses the shared filter popover for organization and group evidence", async () => {
    mount(); await screen.findByText("Maya");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const filters = within(screen.getByRole("dialog", { name: "Filter groups" }));
    expect(filters.getByRole("searchbox", { name: "Search company options" })).toBeVisible();
    expect(filters.getByRole("searchbox", { name: "Search department options" })).toBeVisible();
    await waitFor(() => expect(filters.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(filters.getByRole("combobox", { name: "Company" }), { target: { value: "~string:Contoso" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, company: "Contoso" });
    fireEvent.change(filters.getByRole("combobox", { name: "Department" }), { target: { value: "~string:HR" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, department: "HR" });
    fireEvent.change(filters.getByRole("combobox", { name: "Copilot Champs" }), { target: { value: "with" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, adoptionChamps: "with" });
    fireEvent.change(filters.getByRole("combobox", { name: "Group agents" }), { target: { value: "without" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, adoptionAgents: "without" });
  });
  it("applies filters to server reads and removes chips without clearing unrelated context", async () => {
    const filtered = { ...route, company: "Contoso", adoptionChamps: "with" as const, adoptionAgents: "without" as const,
      reportSetId: reports.setId!, search: "HR" };
    render(<SavedQueryProvider><AdoptionView route={filtered} change={change} revision={0} reportContext={null}
      onOpenPerson={onOpenPerson} /></SavedQueryProvider>);
    await screen.findByText("Maya");
    expect(api.readReportPage).toHaveBeenCalledWith("copilot-usage/adoption",
      expect.objectContaining({ company: "Contoso", adoptionChamps: "with", adoptionAgents: "without", search: "hr", setId: reports.setId }), expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove company filter" }));
    expect(change).toHaveBeenLastCalledWith({ ...filtered, company: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(change).toHaveBeenLastCalledWith({ ...filtered, company: undefined, department: undefined,
      adoptionChamps: undefined, adoptionAgents: undefined, search: "" });
  });
  it("refreshes on inventory publication, not merely reordered revision properties", async () => {
    const revisions = page().selection.publicationRevisions;
    const admit = vi.fn();
    const renderPage = (powerPlatform: string) => <SavedQueryProvider>
      <PublicationContext value={{ admit, revisions: {
        users: revisions.users, power_platform: powerPlatform, graph_packages: revisions.graph_packages,
      } }}>
        <AdoptionView route={route} change={change} revision={0} reportContext={null} onOpenPerson={onOpenPerson} />
      </PublicationContext>
    </SavedQueryProvider>;
    const view = render(renderPage(revisions.power_platform));
    await screen.findByText("Maya");
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    const next = page();
    next.selection = { ...reportSelection(3), publicationRevisions: { ...revisions, power_platform: "4".repeat(64) } };
    vi.mocked(api.readReportPage).mockResolvedValue(next);
    view.rerender(renderPage("4".repeat(64)));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
    await waitFor(() => expect(admit).toHaveBeenLastCalledWith(next.selection.publicationRevisions));
  });
});
