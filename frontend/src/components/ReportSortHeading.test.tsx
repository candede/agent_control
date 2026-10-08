import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState, type ComponentProps, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportPage, ReportQuery, ReportRelationship } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import { readReportPage } from "../api/reportData";
import { deferred } from "../test/deferred";
import { combinedUser, reportPage, reportUser, selectionId } from "../test/reportDataFixture";
import { CopilotUsersView } from "./CopilotUsersView";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { ReportedUserAgents, type UserRelationshipQuery } from "./ReportedUserAgents";
import { ReportSortHeading } from "./ReportSortHeading";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn(), readReportFacet: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); });

type Props = ComponentProps<typeof ReportSortHeading>;
function clickHandler(heading: ReactElement<{ children: ReactElement<{ onClick: () => void }> }>) {
  return heading.props.children.props.onClick;
}

describe("report sort heading admission", () => {
  it("admits one callback per committed heading and retires handlers after query changes and A-B-A returns", () => {
    const onChange = vi.fn();
    const props: Props = { label: "User", sort: "name", query: { sort: "responses", order: "desc", company: "Contoso" }, onChange };
    const { result, rerender, unmount } = renderHook(ReportSortHeading, { initialProps: props, wrapper: StrictMode });
    const original = clickHandler(result.current);
    act(() => { original(); original(); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ ...props.query, sort: "name", order: "asc" });
    rerender({ ...props, query: { ...props.query, company: "Fabrikam" } });
    act(original);
    expect(onChange).toHaveBeenCalledOnce();
    const replacement = clickHandler(result.current);
    act(replacement);
    expect(onChange).toHaveBeenLastCalledWith({ ...props.query, company: "Fabrikam", sort: "name", order: "asc" });
    rerender(props);
    act(() => { original(); replacement(); });
    expect(onChange).toHaveBeenCalledTimes(2);
    const current = clickHandler(result.current);
    unmount();
    act(current);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("rejects callbacks from a previous owner even when the sort and query are unchanged", () => {
    const previous = vi.fn(), current = vi.fn();
    const props: Props = { label: "User", sort: "name", query: { sort: "name", order: "asc" }, onChange: previous };
    const { result, rerender } = renderHook(ReportSortHeading, { initialProps: props });
    const stale = clickHandler(result.current);
    rerender({ ...props, onChange: current });
    act(stale);
    expect(previous).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    act(clickHandler(result.current));
    expect(current).toHaveBeenCalledExactlyOnceWith({ sort: "name", order: "desc" });
  });

  it.each([
    ["name", "asc"], ["upn", "asc"], ["company", "asc"], ["department", "asc"], ["creatorType", "asc"],
    ["responses", "desc"], ["agentsUsed", "desc"], ["lastActivity", "desc"],
  ] as const)("starts %s in %s order, toggles with the keyboard, and preserves every filter", async (sort, order) => {
    const initial: ReportQuery = { sort: "acceptedAt", order: "desc", search: "needle", company: null, department: "Engineering" };
    const changed = vi.fn();
    function Heading() {
      const [query, setQuery] = useState(initial);
      return <table><thead><tr><ReportSortHeading label="Column" sort={sort} query={query}
        onChange={next => { changed(next); setQuery(next); }} /></tr></thead></table>;
    }
    render(<Heading />);
    const button = screen.getByRole("button", { name: "Column" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(changed).toHaveBeenLastCalledWith({ ...initial, sort, order });
    expect(screen.getByRole("columnheader")).toHaveAttribute("aria-sort", order === "asc" ? "ascending" : "descending");
    expect(button).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(changed).toHaveBeenLastCalledWith({ ...initial, sort, order: order === "asc" ? "desc" : "asc" });
    expect(button).toHaveFocus();
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

const kinds = ["licensed", "reported", "relationships"] as const;
type Kind = typeof kinds[number];
const relationshipPath = "official-usage/users/exact-user%40example.invalid/agents";
const regions = { licensed: "M365 Copilot license status", reported: "Reported user activity", relationships: "User agent breakdown" };
function savedPage(kind: Kind, index: number): ReportPage<unknown> {
  const relationship: ReportRelationship = { id: `relationship-${index}`, username: "exact-user@example.invalid",
    agentId: `agent-${index}`, agentName: `Agent ${index}`, creatorType: "Your org", responses: index, lastActivityDateUtc: null, identityStatus: "unresolved" };
  return reportPage([kind === "licensed" ? combinedUser(index) : kind === "reported" ? reportUser(index) : relationship]);
}
function Consumer({ kind, revision = 0 }: { kind: Kind; revision?: number }) {
  const [query, setQuery] = useState<UserRelationshipQuery>({ search: "", showAll: false, sort: "responses", order: "desc" });
  return kind === "licensed" ? <CopilotUsersView dataRevision={revision} />
    : kind === "reported" ? <ReportedUserActivity route={{ view: "activity", search: "", page: 0 }} onRouteChange={vi.fn()} dataRevision={revision} />
      : <ReportedUserAgents path={relationshipPath} selectionId={selectionId} query={query} onQueryChange={setQuery} />;
}
function rowLabel(kind: Kind, index: number) { return `${kind === "relationships" ? "Agent" : "User"} ${index}`; }

describe.each(["licensed", "reported"] as const)("%s retained paging", kind => {
  it("keeps paging focused after an empty revision and admits no unavailable navigation", async () => {
    const pending = deferred<ReportPage<unknown>>();
    vi.mocked(readReportPage).mockResolvedValueOnce({
      ...savedPage(kind, 1), page: { limit: 50, nextCursor: "next", previousCursor: null },
    }).mockReturnValueOnce(pending.promise);
    const view = render(<Consumer kind={kind} />);
    await screen.findByText(rowLabel(kind, 1));
    const next = screen.getByRole("button", { name: "Next users" });
    next.focus();
    view.rerender(<Consumer kind={kind} revision={1} />);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    await act(async () => pending.resolve(reportPage([], { counts: { total: 0, filtered: 0 } })));
    await screen.findByRole("heading", { name: kind === "licensed" ? "No users match" : "No matching reported users" });
    expect(screen.queryByText(rowLabel(kind, 1))).not.toBeInTheDocument();
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter} ");
    await userEvent.click(next);
    expect(readReportPage).toHaveBeenCalledTimes(2);

    vi.mocked(readReportPage).mockResolvedValueOnce({
      ...savedPage(kind, 2), page: { limit: 50, nextCursor: "next", previousCursor: null },
    });
    view.rerender(<Consumer kind={kind} revision={2} />);
    await screen.findByText(rowLabel(kind, 2));
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "false");
    expect(readReportPage).toHaveBeenCalledTimes(3);
  });
});

describe.each(kinds)("%s server sorting", kind => {
  it.each(["empty", "error"] as const)("retains the focused heading after an %s result and allows recovery", async outcome => {
    const pending = deferred<ReportPage<unknown>>();
    vi.mocked(readReportPage).mockResolvedValueOnce(savedPage(kind, 1)).mockReturnValueOnce(pending.promise);
    render(<Consumer kind={kind} />);
    await screen.findByText(rowLabel(kind, 1));
    const heading = within(screen.getByRole("region", { name: regions[kind] })).getByRole("button", {
      name: kind === "relationships" ? "Responses to this user" : "Agent responses",
    });
    heading.focus();
    await userEvent.keyboard("{Enter}");
    expect(readReportPage).toHaveBeenCalledTimes(2);
    expect(heading).toHaveFocus();
    expect(heading.closest("th")).toHaveAttribute("aria-sort", "ascending");
    expect(screen.getByText("Loading saved data...")).toBeInTheDocument();
    expect(screen.queryByText(rowLabel(kind, 1))).not.toBeInTheDocument();
    await act(async () => {
      if (outcome === "error") pending.reject(new Error("Sorted page unavailable."));
      else pending.resolve(reportPage([], { counts: { total: 0, filtered: 0 } }));
    });
    if (outcome === "error") expect(await screen.findByRole("alert")).toHaveTextContent("Sorted page unavailable.");
    else await screen.findByRole("heading", { name: kind === "relationships" ? "No agent relationships reported"
      : kind === "licensed" ? "No users match" : "No matching reported users" });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveFocus();
    vi.mocked(readReportPage).mockResolvedValue(savedPage(kind, 1));
    await userEvent.keyboard("{Enter}");
    await screen.findByText(rowLabel(kind, 1));
    expect(heading).toHaveFocus();
    expect(heading.closest("th")).toHaveAttribute("aria-sort", "descending");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Top-level sorting can return to its bounded, still-current cached capture.
    expect(readReportPage).toHaveBeenCalledTimes(kind === "relationships" ? 3 : 2);
  });

  it("resets the page, cancels a superseded sort, and ignores its late invalidation", async () => {
    vi.mocked(readReportPage).mockResolvedValueOnce({ ...savedPage(kind, 1), page: { limit: 50, nextCursor: "next", previousCursor: null } })
      .mockResolvedValueOnce(savedPage(kind, 2));
    render(<Consumer kind={kind} />);
    await screen.findByText(rowLabel(kind, 1));
    await userEvent.click(screen.getByRole("button", { name: `Next ${kind === "relationships" ? "agents" : "users"}` }));
    await screen.findByText(rowLabel(kind, 2));
    const obsolete = deferred<ReportPage<unknown>>(), latest = deferred<ReportPage<unknown>>();
    vi.mocked(readReportPage).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(latest.promise);
    const table = within(screen.getByRole("region", { name: regions[kind] }));
    await userEvent.click(table.getByRole("button", { name: kind === "relationships" ? "Responses to this user" : "Agent responses" }));
    const request = vi.mocked(readReportPage).mock.calls[2];
    expect(request[1]).toMatchObject({ sort: "responses", order: "asc" });
    expect(request[1]?.cursor).toBeUndefined();
    expect(request[1]?.selectionId).toBe(kind === "relationships" ? selectionId : undefined);
    await userEvent.click(table.getByRole("button", { name: kind === "relationships" ? "Agent" : "User" }));
    expect(request[2]?.aborted).toBe(true);
    expect(readReportPage).toHaveBeenCalledTimes(4);
    await act(async () => latest.resolve(savedPage(kind, 4)));
    await screen.findByText(rowLabel(kind, 4));
    await act(async () => obsolete.reject(new ApiError(409, "selection_invalidated", "Obsolete selection.")));
    expect(screen.getByText(rowLabel(kind, 4))).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readReportPage).toHaveBeenCalledTimes(4);
  });
});
