import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialReportDetail } from "../../../backend/src/types/officialReportApi";
import type { ReportRelationship } from "../../../backend/src/types/officialReportData";
import { ApiError, getAgentResponsibility } from "../api/client";
import { readReportDetail, readReportPage } from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { createSavedQueryClient } from "../savedQueries";
import { responsibilityFixture } from "../test/agentResponsibilityFixture";
import { deferred } from "../test/deferred";
import { mockNativeDialogs } from "../test/dialog";
import { combinedUser, reportPage, reportSelection, reportUser } from "../test/reportDataFixture";
import { UserDetailModal } from "./UserDetailModal";
import { WorkbenchDialog } from "./WorkbenchDialog";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportDetail: vi.fn(), readReportPage: vi.fn(),
}));
vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getAgentResponsibility: vi.fn(),
}));
mockNativeDialogs();
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); vi.restoreAllMocks(); });

function evidence<T>(value: T): OfficialReportDetail<T> {
  const { selection, sources, reports } = reportPage([]);
  return { value, selection: { ...selection, validatedAt: new Date().toISOString() }, sources, reports };
}
function props(overrides: Partial<ComponentProps<typeof UserDetailModal>> = {}): ComponentProps<typeof UserDetailModal> {
  return { kind: "directory", identity: combinedUser().directory.objectId, returnFocusTo: createRef<HTMLButtonElement>(),
    closeLabel: "Close user details", onClose: vi.fn(), ...overrides };
}
const capability: ReturnType<typeof useCapabilityContext> = {
  user: { homeAccountId: "viewer", tenantId: "tenant", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
  views: [], loading: false, pending: false, error: undefined, now: Date.now(),
  reload: vi.fn(async () => {}), openPermissions: vi.fn(),
};
beforeEach(() => {
  vi.mocked(readReportDetail).mockResolvedValue(evidence(combinedUser()));
  vi.mocked(readReportPage).mockResolvedValue(reportPage([]));
  vi.mocked(getAgentResponsibility).mockImplementation(async query => responsibilityFixture(query?.objectId));
});

describe("user detail lifecycle", () => {
  it.each(["visibility", "connectivity"] as const)("renews direct details when returning from suspended %s after expiry", async boundary => {
    const saved = evidence(combinedUser());
    saved.selection.expiresAt = new Date(Date.now() + 60_000).toISOString();
    const pending = deferred<typeof saved>();
    vi.mocked(readReportDetail).mockResolvedValueOnce(saved).mockReturnValueOnce(pending.promise);
    render(<UserDetailModal {...props()} />);
    await screen.findByText("Contoso");
    const availability = boundary === "visibility"
      ? vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
      : vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_001);
    fireEvent(window, new Event(boundary === "visibility" ? "focus" : "offline"));
    expect(readReportDetail).toHaveBeenCalledOnce();
    availability.mockRestore();
    if (boundary === "visibility") fireEvent(document, new Event("visibilitychange"));
    else fireEvent(window, new Event("online"));
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Contoso")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
    const fresh = { ...evidence(combinedUser()), selection: reportSelection(9, Date.now()) };
    await act(async () => pending.resolve(fresh));
    expect(screen.getByText("Contoso")).toBeVisible();
    fireEvent.focus(window);
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it("does not let an old license rejection disable a pending replacement detail", async () => {
    const saved = evidence(combinedUser()), fresh = { ...saved, selection: reportSelection(9) };
    const plans = deferred<ReturnType<typeof reportPage>>(), pending = deferred<typeof saved>();
    vi.mocked(readReportDetail).mockResolvedValueOnce(saved).mockReturnValueOnce(pending.promise);
    vi.mocked(readReportPage).mockReturnValueOnce(plans.promise).mockResolvedValue(reportPage([], { selection: fresh.selection }));
    const settings = props({ selectionId: saved.selection.id, initialTab: "licenses", onSelectionInvalidated: vi.fn() });
    const view = render(<UserDetailModal {...settings} />);
    await waitFor(() => expect(readReportPage).toHaveBeenCalledOnce());
    view.rerender(<UserDetailModal {...settings} selectionId={fresh.selection.id} />);
    const signal = vi.mocked(readReportDetail).mock.lastCall?.[2];
    await act(async () => plans.reject(new ApiError(409, "selection_invalidated", "Old license evidence changed.")));
    expect(signal?.aborted).toBe(false);
    expect(settings.onSelectionInvalidated).not.toHaveBeenCalled();
    await act(async () => pending.resolve(fresh));
    await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(await screen.findByText("Contoso")).toBeVisible();
  });

  it("withdraws retained directory details when a newly synced report identity loses its directory link", async () => {
    const linked = evidence(reportUser()), directory = evidence(combinedUser());
    const unlinked = { ...linked, value: { ...linked.value, objectId: null }, selection: reportSelection(9) };
    vi.mocked(readReportDetail).mockResolvedValueOnce(linked).mockResolvedValueOnce(directory).mockResolvedValueOnce(unlinked);
    const settings = props({ kind: "report", identity: linked.value.username, selectionId: linked.selection.id });
    const view = render(<UserDetailModal {...settings} />);
    await screen.findByText("Contoso");
    view.rerender(<UserDetailModal {...settings} selectionId={unlinked.selection.id} />);
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("Contoso")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    expect(screen.getByText("Detailed license assignments are unavailable for this report identity.")).toBeVisible();
    expect(readReportDetail).toHaveBeenCalledTimes(3);
  });

  it("does not carry the previous profile into a replacement report directory link", async () => {
    const linked = evidence(reportUser()), directory = evidence(combinedUser());
    const replacement = { ...evidence(combinedUser(2)), selection: reportSelection(9) };
    replacement.value.directory.companyName = "Replacement company";
    const changed = { ...linked, value: { ...linked.value, objectId: replacement.value.directory.objectId }, selection: replacement.selection };
    const pending = deferred<typeof replacement>();
    vi.mocked(readReportDetail).mockResolvedValueOnce(linked).mockResolvedValueOnce(directory)
      .mockResolvedValueOnce(changed).mockReturnValueOnce(pending.promise);
    const settings = props({ kind: "report", identity: linked.value.username, selectionId: linked.selection.id });
    const view = render(<UserDetailModal {...settings} />);
    await screen.findByText("Contoso");
    view.rerender(<UserDetailModal {...settings} selectionId={changed.selection.id} />);
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledTimes(4));
    expect(screen.queryByText("Contoso")).not.toBeInTheDocument();
    await act(async () => pending.resolve(replacement));
    expect(await screen.findByText("Replacement company")).toBeVisible();
    expect(screen.queryByText("Contoso")).not.toBeInTheDocument();
  });

  it.each(["target", "ref"] as const)("restores the current return-focus %s without reopening user details", async replacement => {
    const previous = createRef<HTMLHeadingElement>(), current = createRef<HTMLHeadingElement>();
    const settings = props();
    const content = (open: boolean, updated: boolean) => <>
      {updated ? <h2 key="current" ref={replacement === "target" ? previous : current} tabIndex={-1}>Current users heading</h2>
        : <h2 key="previous" ref={previous} tabIndex={-1}>Previous users heading</h2>}
      {open ? <UserDetailModal {...settings} returnFocusTo={replacement === "ref" && updated ? current : previous} /> : null}
    </>;
    const { rerender } = render(content(true, false));
    await screen.findByText("Contoso");
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal"), close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const tab = screen.getByRole("tab", { name: "Overview" });
    tab.focus();
    rerender(content(true, true));
    expect(tab).toHaveFocus();
    expect(showModal).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(readReportDetail).toHaveBeenCalledOnce();
    rerender(content(false, true));
    expect(screen.getByRole("heading", { name: "Current users heading" })).toHaveFocus();
  });

  it.each(["user", "workbench"] as const)("retains the shared scroll lock when %s details close first", first => {
    const overflow = document.body.style.overflow;
    const settings = props();
    const content = (userOpen: boolean, workbenchOpen: boolean) => <>
      {userOpen ? <UserDetailModal {...settings} /> : null}
      <WorkbenchDialog open={workbenchOpen} title="Sync status">Status</WorkbenchDialog>
    </>;
    const { rerender, unmount } = render(content(first === "user", first === "workbench"));
    try {
      rerender(content(true, true));
      rerender(content(first !== "user", first !== "workbench"));
      expect(document.body.style.overflow).toBe("hidden");
      rerender(content(false, false));
      expect(document.body.style.overflow).toBe(overflow);
    } finally {
      unmount();
      document.body.style.overflow = overflow;
    }
  });

  describe.each(["user", "directory"] as const)("%s detail cancellation", target => {
    it.each(["initial", "revalidation"] as const)("offers local recovery after cancelling %s without reviving stale evidence", async phase => {
      const client = createSavedQueryClient(), report = evidence(reportUser()), saved = evidence(combinedUser());
      const pending = deferred<typeof saved>();
      const settings = props(target === "directory" ? { kind: "report", identity: report.value.username, selectionId: report.selection.id } : {});
      const key = ["saved", target === "directory" ? "report-directory-detail" : "report-detail"];
      vi.mocked(readReportDetail).mockImplementation(async path => target === "directory" && !path.endsWith("/directory")
        ? report : phase === "initial" ? pending.promise : saved);
      render(<QueryClientProvider client={client}><UserDetailModal {...settings} /></QueryClientProvider>);
      if (phase === "revalidation") {
        await screen.findByText("Contoso");
        vi.mocked(readReportDetail).mockReturnValue(pending.promise);
        act(() => { void client.invalidateQueries({ queryKey: key }); });
      }
      await screen.findByText(target === "user" ? "Loading exact user details..." : "Loading directory details...");
      const request = vi.mocked(readReportDetail).mock.calls.at(-1)!;
      await act(async () => { await client.cancelQueries({ queryKey: key }); });
      expect(request[2]?.aborted).toBe(true);
      expect(await screen.findByRole("button", { name: `Retry ${target} details` })).toBeVisible();
      expect(screen.queryByText(/Loading (exact user|directory) details/)).not.toBeInTheDocument();
      expect(screen.queryByText("Contoso")).not.toBeInTheDocument();
      const requests = vi.mocked(readReportDetail).mock.calls.length;
      fireEvent.focus(window);
      await act(async () => pending.resolve(saved));
      expect(readReportDetail).toHaveBeenCalledTimes(requests);
      expect(screen.queryByText("Contoso")).not.toBeInTheDocument();

      const retry = deferred<typeof saved>();
      vi.mocked(readReportDetail).mockReturnValue(retry.promise);
      const button = screen.getByRole("button", { name: `Retry ${target} details` });
      act(() => { fireEvent.click(button); fireEvent.click(button); });
      expect(readReportDetail).toHaveBeenCalledTimes(requests + 1);
      expect(await screen.findByText(target === "user" ? "Loading exact user details..." : "Loading directory details...")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => retry.resolve(saved));
      expect(await screen.findByText("Contoso")).toBeVisible();
    });
  });

  it("does not revive a rejected child selection when its direct-user restart is cancelled", async () => {
    const client = createSavedQueryClient();
    vi.mocked(readReportPage).mockRejectedValue(new ApiError(409, "selection_invalidated", "User selection changed."));
    render(<QueryClientProvider client={client}><UserDetailModal {...props({ activeTab: "licenses" })} /></QueryClientProvider>);
    const restart = await screen.findByRole("button", { name: "Restart selection" });
    const pending = deferred<ReturnType<typeof evidence>>();
    vi.mocked(readReportDetail).mockReturnValue(pending.promise);
    fireEvent.click(restart);
    await screen.findByText("Loading exact user details...");
    await act(async () => { await client.cancelQueries({ queryKey: ["saved", "report-detail"] }); });
    expect(await screen.findByRole("button", { name: "Retry user details" })).toBeVisible();
    expect(screen.queryByText(/Loading exact user details/)).not.toBeInTheDocument();
    expect(readReportPage).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(evidence(combinedUser())));
    expect(screen.getByRole("button", { name: "Retry user details" })).toBeVisible();
    expect(readReportPage).toHaveBeenCalledOnce();
  });

  it("requires an explicit restart rather than replaying rejected exact evidence on cache invalidation", async () => {
    const client = createSavedQueryClient();
    vi.mocked(readReportDetail).mockRejectedValue(new ApiError(409, "selection_invalidated", "User selection changed."));
    render(<QueryClientProvider client={client}><UserDetailModal {...props()} /></QueryClientProvider>);
    const restart = await screen.findByRole("button", { name: "Restart selection" });
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-detail"] }); });
    fireEvent.focus(window);
    expect(readReportDetail).toHaveBeenCalledOnce();
    vi.mocked(readReportDetail).mockResolvedValue(evidence(combinedUser()));
    fireEvent.click(restart);
    expect(await screen.findByText("Contoso")).toBeVisible();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it("does not cancel or repin an admitted exact read at lease end and retains the historical result", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = createSavedQueryClient(), saved = evidence(combinedUser());
    saved.selection.expiresAt = new Date(Date.now() + 5000).toISOString();
    vi.mocked(readReportDetail).mockResolvedValue(saved);
    render(<QueryClientProvider client={client}><UserDetailModal {...props({
      selectionId: saved.selection.id, onRestartSelection: vi.fn(),
    })} /></QueryClientProvider>);
    await screen.findByText("Contoso");
    const pending = deferred<typeof saved>();
    vi.mocked(readReportDetail).mockReturnValue(pending.promise);
    act(() => { void client.invalidateQueries({ queryKey: ["saved", "report-detail"] }); });
    await screen.findByText("Loading exact user details...");
    const signal = vi.mocked(readReportDetail).mock.calls.at(-1)![2];
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
    fireEvent.focus(window);
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
    expect(signal?.aborted).toBe(false);
    expect(screen.getByText("Loading exact user details...")).toBeVisible();
    await act(async () => pending.resolve(saved));
    expect(await screen.findByText("Contoso")).toBeVisible();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it.each((["user", "directory"] as const).flatMap(target => [false, true].map(focus => ({ target, focus }))))(
    "expires failed pinned $target evidence without replaying its stale retry (focus=$focus)", async ({ target, focus }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = createSavedQueryClient(), saved = evidence(combinedUser()), report = evidence(reportUser());
    saved.selection.expiresAt = new Date(Date.now() + 5000).toISOString();
    report.selection = saved.selection;
    vi.mocked(readReportDetail).mockImplementation(async path => target === "directory" && !path.endsWith("/directory") ? report : saved);
    render(<QueryClientProvider client={client}><UserDetailModal {...props({
      ...(target === "directory" ? { kind: "report", identity: report.value.username } : {}),
      selectionId: saved.selection.id, onRestartSelection: vi.fn(),
    })} /></QueryClientProvider>);
    await screen.findByText("Contoso");
    vi.mocked(readReportDetail).mockRejectedValue(new Error("User details unavailable."));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", target === "user" ? "report-detail" : "report-directory-detail"] }); });
    const retry = await screen.findByRole("button", { name: `Retry ${target} details` });
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 6000);
    if (focus) fireEvent.focus(window);
    else { fireEvent.click(retry); fireEvent.focus(window); }
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledTimes(target === "user" ? 2 : 3);
    expect(screen.queryByText("Contoso")).not.toBeInTheDocument();
  });

  it("shares exact reads until their final modal closes and does not retain abandoned evidence on reopen", async () => {
    const client = createSavedQueryClient(), pending = deferred<ReturnType<typeof evidence>>();
    vi.mocked(readReportDetail).mockReturnValue(pending.promise);
    const settings = props();
    const first = render(<QueryClientProvider client={client}><UserDetailModal {...settings} /></QueryClientProvider>);
    const second = render(<QueryClientProvider client={client}><UserDetailModal {...settings} /></QueryClientProvider>);
    await waitFor(() => expect(readReportDetail).toHaveBeenCalledOnce());
    const signal = vi.mocked(readReportDetail).mock.calls[0][2];
    second.unmount();
    expect(signal?.aborted).toBe(false);
    first.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(evidence(combinedUser())));
    vi.mocked(readReportDetail).mockResolvedValue(evidence(combinedUser(1)));
    render(<QueryClientProvider client={client}><UserDetailModal {...settings} /></QueryClientProvider>);
    expect(await screen.findByText("Contoso")).toBeVisible();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
  });

  it("retains externally visited paid-feature panels and their pending read across tab changes", async () => {
    const pending = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(readReportPage).mockReturnValue(pending.promise);
    const settings = props({ activeTab: "overview" });
    const view = render(<UserDetailModal {...settings} />);
    await screen.findByText("Contoso");
    view.rerender(<UserDetailModal {...settings} activeTab="licenses" />);
    await waitFor(() => expect(readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(readReportPage).mock.calls[0][2];
    view.rerender(<UserDetailModal {...settings} activeTab="overview" />);
    expect(signal?.aborted).toBe(false);
    view.rerender(<UserDetailModal {...settings} activeTab="licenses" />);
    expect(readReportPage).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(reportPage([], { counts: { total: 0, filtered: 0 } })));
    expect(await screen.findByText("Paid-feature status is unavailable. Refresh Users in Sync.")).toBeVisible();
    view.rerender(<UserDetailModal {...settings} activeTab="overview" />);
    view.rerender(<UserDetailModal {...settings} activeTab="licenses" />);
    expect(readReportPage).toHaveBeenCalledOnce();
    expect(readReportDetail).toHaveBeenCalledOnce();
  });

  describe.each(["licenses", "usage"] as const)("%s child cancellation", tab => {
    it.each(["initial", "revalidation"] as const)("recovers a cancelled %s without keeping stale rows or replaying on focus", async phase => {
      const client = createSavedQueryClient(), saved = reportPage([], { counts: { total: 0, filtered: 0 } });
      const pending = deferred<typeof saved>();
      const ready = tab === "licenses" ? "Paid-feature status is unavailable. Refresh Users in Sync." : "No agent relationships reported";
      vi.mocked(readReportPage).mockReturnValue(phase === "initial" ? pending.promise : Promise.resolve(saved));
      render(<QueryClientProvider client={client}><UserDetailModal {...props({ activeTab: tab })} /></QueryClientProvider>);
      if (phase === "revalidation") {
        await screen.findByText(ready);
        vi.mocked(readReportPage).mockReturnValue(pending.promise);
        act(() => { void client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
        await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(2));
      } else await screen.findByText("Loading saved data...");
      const signal = vi.mocked(readReportPage).mock.calls.at(-1)![2];
      await act(async () => { await client.cancelQueries({ queryKey: ["saved", "record-page"] }); });
      expect(signal?.aborted).toBe(true);
      expect(await screen.findByRole("button", { name: "Retry saved data" })).toBeVisible();
      expect(screen.queryByText(ready)).not.toBeInTheDocument();
      expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
      const requests = vi.mocked(readReportPage).mock.calls.length;
      fireEvent.focus(window);
      await act(async () => pending.resolve(saved));
      expect(readReportPage).toHaveBeenCalledTimes(requests);
      expect(screen.queryByText(ready)).not.toBeInTheDocument();
      vi.mocked(readReportPage).mockResolvedValue(saved);
      const retry = screen.getByRole("button", { name: "Retry saved data" });
      act(() => { fireEvent.click(retry); fireEvent.click(retry); });
      expect(await screen.findByText(ready)).toBeVisible();
      expect(readReportPage).toHaveBeenCalledTimes(requests + 1);
      expect(readReportDetail).toHaveBeenCalledOnce();
    });
  });

  it.each(["selection", "revision"] as const)("preserves same-user tabs and drafts but replaces evidence and cursors on a new %s", async boundary => {
    const saved = evidence(combinedUser()), replacement = evidence(combinedUser());
    replacement.selection.id = "20000000-0000-4000-8000-000000000009";
    const row: ReportRelationship = { id: "relationship-1", agentId: "agent-1", agentName: "Previous agent", creatorType: "Your org",
      username: saved.value.directory.userPrincipalName, responses: 3, lastActivityDateUtc: null, identityStatus: "unresolved" };
    const initial = reportPage([row], { page: { limit: 50, nextCursor: "old-next-page", previousCursor: null } });
    const obsolete = deferred<typeof initial>(), pending = deferred<typeof saved>();
    vi.mocked(readReportPage).mockImplementation(async (path, query) => path.endsWith("/service-plans")
      ? reportPage([], { counts: { total: 0, filtered: 0 } }) : query?.cursor ? obsolete.promise : initial);
    const settings = props({ selectionId: boundary === "selection" ? saved.selection.id : undefined, filters: { agentId: "filtered-agent" } });
    const view = render(<UserDetailModal {...settings} />);
    await screen.findByText("Contoso");
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    await screen.findByText("Paid-feature status is unavailable. Refresh Users in Sync.");
    fireEvent.click(screen.getByRole("tab", { name: "Usage & agents" }));
    const search = await screen.findByRole("searchbox", { name: "Search this user's agents" });
    fireEvent.change(search, { target: { value: " Private Draft " } });
    fireEvent.click(screen.getByRole("button", { name: "Show all this user's agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const next = screen.getByRole("button", { name: "Next agents" });
    await waitFor(() => expect(next).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(next);
    await screen.findByText("Loading saved data...");
    expect(readReportPage).toHaveBeenLastCalledWith(expect.any(String),
      { selectionId: saved.selection.id, search: "private draft", sort: "name", order: "asc", cursor: "old-next-page", limit: 50 }, expect.any(AbortSignal));
    const signal = vi.mocked(readReportPage).mock.calls.at(-1)![2];
    const requests = vi.mocked(readReportPage).mock.calls.length;
    vi.mocked(readReportDetail).mockReturnValue(pending.promise);
    view.rerender(<UserDetailModal {...settings} {...(boundary === "selection" ? { selectionId: replacement.selection.id } : { dataRevision: 1 })} />);
    expect(screen.getByRole("tab", { name: "Usage & agents" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Loading exact user details...")).toBeVisible();
    expect(screen.getByText("Contoso")).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue(" Private Draft ");
    expect(signal?.aborted).toBe(false);
    expect(readReportPage).toHaveBeenCalledTimes(requests);

    vi.mocked(readReportPage).mockImplementation(async path => reportPage(path.endsWith("/service-plans") ? [] : [{ ...row, agentName: "Replacement agent" }],
      { selection: replacement.selection, counts: { total: 1, filtered: 1 } }));
    await act(async () => pending.resolve(replacement));
    expect(await screen.findByRole("searchbox", { name: "Search this user's agents" })).toHaveValue(" Private Draft ");
    expect(await screen.findByText("Replacement agent")).toBeVisible();
    expect(screen.getByRole("button", { name: "Show matching relationships" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Agent" })).toHaveAttribute("aria-sort", "ascending");
    await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(requests + 2));
    expect(vi.mocked(readReportPage).mock.calls.slice(requests).map(([path, query]) => [path.split("/").at(-1), query])).toEqual([
      ["agents", { selectionId: replacement.selection.id, search: "private draft", sort: "name", order: "asc", limit: 50 }],
      ["service-plans", { selectionId: replacement.selection.id, limit: 50 }],
    ]);
    await act(async () => obsolete.reject(new ApiError(409, "selection_invalidated", "Obsolete relationship page.")));
    fireEvent.click(screen.getByRole("tab", { name: "Licenses" }));
    fireEvent.click(screen.getByRole("tab", { name: "Usage & agents" }));
    expect(screen.getByText("Replacement agent")).toBeVisible();
    expect(screen.queryByText("Previous agent")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(readReportDetail).toHaveBeenCalledTimes(2);
    expect(readReportPage).toHaveBeenCalledTimes(requests + 2);
  });

  it.each(["identity", "principal", "tenant", "roles", "session"] as const)("clears private relationship filters and visited panels when the %s owner changes", async boundary => {
    const plans = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(readReportPage).mockImplementation(async path => path.endsWith("/service-plans") ? plans.promise : reportPage([]));
    const settings = props({ activeTab: "licenses", filters: { agentId: "filtered-agent" } });
    const view = render(<CapabilityContext key="initial" value={capability}><UserDetailModal {...settings} /></CapabilityContext>);
    await waitFor(() => expect(readReportPage).toHaveBeenCalledOnce());
    const signal = vi.mocked(readReportPage).mock.calls[0][2];
    view.rerender(<CapabilityContext key="initial" value={capability}><UserDetailModal {...settings} activeTab="usage" /></CapabilityContext>);
    const search = await screen.findByRole("searchbox", { name: "Search this user's agents" });
    fireEvent.change(search, { target: { value: "private previous search" } });
    fireEvent.click(screen.getByRole("button", { name: "Show all this user's agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    expect(search).toHaveValue("private previous search");
    expect(signal?.aborted).toBe(false);
    const saved = evidence(combinedUser(boundary === "identity" ? 2 : 1));
    vi.mocked(readReportDetail).mockResolvedValue(saved);
    vi.mocked(readReportPage).mockResolvedValue(reportPage([], { selection: saved.selection }));
    view.rerender(<CapabilityContext key={boundary === "session" ? "replacement" : "initial"} value={{ ...capability, user: { ...capability.user!,
      ...(boundary === "principal" ? { homeAccountId: "another" } : {}),
      ...(boundary === "tenant" ? { tenantId: "another" } : {}),
      ...(boundary === "roles" ? { roles: ["AgentControl.Viewer", "AgentControl.Admin"] } : {}),
    } }}>
      <UserDetailModal {...settings} activeTab="usage" identity={saved.value.directory.objectId} />
    </CapabilityContext>);
    expect(await screen.findByRole("searchbox", { name: "Search this user's agents" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Show all this user's agents" })).toBeVisible();
    expect(readReportPage).toHaveBeenLastCalledWith(expect.any(String),
      { selectionId: saved.selection.id, agentId: "filtered-agent", search: undefined, sort: "responses", order: "desc", limit: 50 }, expect.any(AbortSignal));
    expect(signal?.aborted).toBe(true);
    expect(vi.mocked(readReportPage).mock.calls.filter(([path]) => path.endsWith("/service-plans"))).toHaveLength(1);
    await act(async () => plans.reject(new ApiError(409, "selection_invalidated", "Obsolete paid features.")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
