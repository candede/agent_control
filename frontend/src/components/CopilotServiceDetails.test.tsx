import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportPage, selectionId } from "../test/reportDataFixture";
import { ApiError, type SessionUser } from "../api/client";
import { readReportPage } from "../api/reportData";
import { CapabilityContext } from "../capabilityContext";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { resolveCopilotServicePlan } from "../../../backend/src/services/copilotServicePlans";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
vi.mock("../api/reportData", () => ({ readReportPage: vi.fn() }));
const path = "copilot-usage/users/11111111-1111-4111-8111-111111111111/service-plans";
const servicePlanId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
beforeEach(() => { vi.mocked(readReportPage).mockReset().mockResolvedValue(reportPage([], { counts: { total: 0, filtered: 0 } })); });

describe("paid-feature evidence details", () => {
  it("recognizes verified disabled users with no assigned paid services", async () => {
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    expect(await screen.findByText("No paid Copilot services are assigned.")).toBeVisible();
    expect(screen.queryByText(/unverified|evidence not reported|Run Users Sync/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "plans pages" })).not.toBeInTheDocument();
  });

  it("does not infer no paid services from unknown assignments", async () => {
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="unknown" current />);
    expect(await screen.findByText("Paid-feature status is unavailable. Refresh Users in Sync.")).toBeVisible();
    expect(screen.queryByText(/No paid Copilot services are assigned/)).not.toBeInTheDocument();
  });

  it("qualifies an old no-services observation without calling that evidence missing", async () => {
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current={false} />);
    expect(await screen.findByText("Last saved: no paid Copilot services were assigned.")).toBeVisible();
    expect(screen.getByText("Refresh Users in Sync to verify current paid-feature status.")).toBeVisible();
    expect(screen.queryByText(/Paid-feature evidence not reported/)).not.toBeInTheDocument();
  });

  it("keeps assigned but disabled service evidence distinct from no assigned services", async () => {
    const plan = resolveCopilotServicePlan(servicePlanId, false, []);
    vi.mocked(readReportPage).mockResolvedValue(reportPage([plan]));
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    expect(await screen.findByRole("list", { name: "Paid feature states" })).toHaveTextContent("Not enabled");
    expect(screen.queryByText(/No paid Copilot services are assigned/)).not.toBeInTheDocument();
  });

  it("renders normalized assignment evidence without changing the effective paid-feature state", async () => {
    const plan = resolveCopilotServicePlan(servicePlanId, false, [{
      servicePlanId, assignedDateTime: "2026-01-01T01:00:00+01:00", capabilityStatus: "Enabled",
    }]);
    vi.mocked(readReportPage).mockResolvedValue(reportPage([plan]));
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    expect(await screen.findByRole("list", { name: "Paid feature states" })).toHaveTextContent("Not enabled");
    expect(screen.queryByText(/Raw capability status:/)).not.toBeInTheDocument();
    expect(screen.getByText("Assigned Jan 1, 2026")).toBeVisible();
    expect(document.querySelector("details")).toBeNull();
  });
  it("does not turn a byte-short empty page into no assigned services", async () => {
    vi.mocked(readReportPage).mockResolvedValue(reportPage([], { counts: { total: 800, filtered: 800 }, page: { limit: 50, nextCursor: "next", previousCursor: null } }));
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next plans" })).toHaveAttribute("aria-disabled", "false"));
    expect(screen.queryByText("No paid Copilot services are assigned.")).not.toBeInTheDocument();
  });

  it("keeps focused paging controls through pending, failed and retried plan reads", async () => {
    const plan = resolveCopilotServicePlan(servicePlanId, false, []);
    const first = reportPage([plan], { counts: { total: 800, filtered: 800 },
      page: { limit: 50, nextCursor: "next", previousCursor: null } });
    const pending = deferred<typeof first>();
    vi.mocked(readReportPage).mockResolvedValueOnce(first).mockReturnValueOnce(pending.promise);
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />);
    await screen.findByRole("list", { name: "Paid feature states" });
    const next = screen.getByRole("button", { name: "Next plans" });
    next.focus();
    act(() => { fireEvent.click(next); fireEvent.click(next); });
    expect(await screen.findByText("Loading saved data...")).toBeVisible();
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("navigation", { name: "plans pages" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
    expect(readReportPage).toHaveBeenCalledTimes(2);
    expect(readReportPage).toHaveBeenLastCalledWith(path, { selectionId, cursor: "next", limit: 50 }, expect.any(AbortSignal));

    await act(async () => pending.reject(new Error("Plan page unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plan page unavailable");
    expect(next).toHaveFocus();
    fireEvent.click(next);
    expect(readReportPage).toHaveBeenCalledTimes(2);
    const retry = deferred<typeof first>();
    vi.mocked(readReportPage).mockReturnValueOnce(retry.promise);
    const retryButton = screen.getByRole("button", { name: "Retry saved data" });
    retryButton.focus();
    fireEvent.click(retryButton);
    expect(await screen.findByText("Loading saved data...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => retry.resolve({ ...first, value: [], page: { limit: 50, nextCursor: "third", previousCursor: "first" } }));
    expect(await screen.findByText("No service-plan rows on this page. Continue using the page controls.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next plans" })).toBe(next);
    expect(next).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText("No paid Copilot services are assigned.")).not.toBeInTheDocument();

    const previous = screen.getByRole("button", { name: "Previous plans" });
    previous.focus();
    vi.mocked(readReportPage).mockResolvedValueOnce(first);
    fireEvent.click(previous);
    await screen.findByRole("list", { name: "Paid feature states" });
    expect(previous).toHaveFocus();
    expect(readReportPage).toHaveBeenLastCalledWith(path, { selectionId, cursor: "first", limit: 50 }, expect.any(AbortSignal));
  });

  it("shares overlapping paid-feature retries and shows loading instead of the prior failure", async () => {
    const client = createSavedQueryClient();
    render(<QueryClientProvider client={client}>
      <CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current />
    </QueryClientProvider>);
    await screen.findByText("No paid Copilot services are assigned.");
    vi.mocked(readReportPage).mockRejectedValue(new Error("Paid features unavailable"));
    await act(async () => { await client.invalidateQueries(); });
    const retry = await screen.findByRole("button", { name: "Retry saved data" });
    const pending = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(readReportPage).mockClear().mockReturnValue(pending.promise);
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(readReportPage).toHaveBeenCalledOnce();
    expect(vi.mocked(readReportPage).mock.calls[0][2]?.aborted).toBe(false);
    expect(await screen.findByText("Loading saved data...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve(reportPage([], { counts: { total: 0, filtered: 0 } })));
    expect(await screen.findByText("No paid Copilot services are assigned.")).toBeVisible();
  });

  it("shares pending feature reads and cancels only when the last reader leaves", async () => {
    const client = createSavedQueryClient(), pending = deferred<ReturnType<typeof reportPage>>();
    vi.mocked(readReportPage).mockReturnValue(pending.promise);
    const content = (readers: string[]) => <QueryClientProvider client={client}>{readers.map(key =>
      <CopilotServiceDetails key={key} path={path} selectionId={selectionId} copilotServiceState="disabled" current />
    )}</QueryClientProvider>;
    const view = render(content(["left", "right"]));
    expect(readReportPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("navigation", { name: "plans pages" })).not.toBeInTheDocument();
    const signal = vi.mocked(readReportPage).mock.calls[0][2];
    view.rerender(content(["right"]));
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    expect(readReportPage).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(reportPage([resolveCopilotServicePlan(servicePlanId, false, [])])));
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
  });

  it("reuses settled plans for equivalent selection IDs, reordered roles and presentation changes", async () => {
    const id = "abcdefab-0000-4000-8000-000000000001";
    const plan = resolveCopilotServicePlan(servicePlanId, false, []);
    const first = reportPage([plan]);
    vi.mocked(readReportPage).mockResolvedValue({ ...first, selection: { ...first.selection, id } });
    const user: SessionUser = { tenantId: "tenant", homeAccountId: "account", username: "viewer@example.invalid",
      displayName: "Viewer", roles: ["AgentControl.Viewer", "AgentControl.Admin"] };
    const content = (selected: string, roles: SessionUser["roles"], current: boolean) => <CapabilityContext value={{
      user: { ...user, roles }, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><CopilotServiceDetails path={path} selectionId={selected} copilotServiceState="disabled" current={current} /></CapabilityContext>;
    const view = render(content(id, user.roles, true));
    await screen.findByRole("list", { name: "Paid feature states" });
    view.rerender(content(id.toUpperCase(), [...user.roles].reverse(), false));
    expect(screen.getByText("Last saved: Not enabled")).toBeVisible();
    expect(screen.getByText("Refresh Users in Sync to verify current paid-feature status.")).toBeVisible();
    expect(readReportPage).toHaveBeenCalledOnce();
  });

  it.each(["user", "selection", "account", "tenant", "roles"] as const)(
    "resets pages on %s changes without admitting late invalidation or reviving old cursors", async changed => {
      const plan = resolveCopilotServicePlan(servicePlanId, false, []);
      const first = reportPage([plan], { page: { limit: 50, nextCursor: "next", previousCursor: null } });
      const obsolete = deferred<typeof first>(), replacement = deferred<typeof first>(), returning = deferred<typeof first>();
      const onSelectionInvalidated = vi.fn();
      const user: SessionUser = { tenantId: "tenant", homeAccountId: "account", username: "viewer@example.invalid",
        displayName: "Viewer", roles: ["AgentControl.Viewer"] };
      const nextUser: SessionUser = { ...user, ...(changed === "account" ? { homeAccountId: "another-account" }
        : changed === "tenant" ? { tenantId: "another-tenant" } : changed === "roles" ? { roles: ["AgentControl.Viewer", "AgentControl.Admin"] } : {}) };
      const nextPath = changed === "user" ? path.replace("11111111", "22222222") : path;
      const nextSelection = changed === "selection" ? "20000000-0000-4000-8000-000000000003" : selectionId;
      const content = (replaced = false) => <CapabilityContext value={{
        user: replaced ? nextUser : user, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
      }}><CopilotServiceDetails path={replaced ? nextPath : path} selectionId={replaced ? nextSelection : selectionId}
        copilotServiceState="disabled" current onSelectionInvalidated={onSelectionInvalidated} /></CapabilityContext>;
      vi.mocked(readReportPage).mockResolvedValueOnce(first).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(replacement.promise);
      const view = render(content());
      await screen.findByRole("list", { name: "Paid feature states" });
      fireEvent.click(screen.getByRole("button", { name: "Next plans" }));
      await waitFor(() => expect(readReportPage).toHaveBeenCalledTimes(2));
      const signal = vi.mocked(readReportPage).mock.calls[1][2];
      view.rerender(content(true));
      expect(signal?.aborted).toBe(true);
      expect(screen.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "plans pages" })).not.toBeInTheDocument();
      expect(readReportPage).toHaveBeenCalledTimes(3);
      expect(readReportPage).toHaveBeenLastCalledWith(nextPath, { selectionId: nextSelection, limit: 50 }, expect.any(AbortSignal));
      await act(async () => replacement.resolve({ ...first, value: [{ ...plan, displayName: "Replacement feature" }],
        selection: { ...first.selection, id: nextSelection } }));
      expect(await screen.findByText("Replacement feature")).toBeVisible();
      await act(async () => obsolete.reject(new ApiError(409, "selection_invalidated", "Old selection rejected")));
      expect(onSelectionInvalidated).not.toHaveBeenCalled();
      expect(screen.getByText("Replacement feature")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      vi.mocked(readReportPage).mockReturnValueOnce(returning.promise);
      view.rerender(content());
      expect(screen.queryByText("Replacement feature")).not.toBeInTheDocument();
      expect(screen.queryByText(plan.displayName)).not.toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "plans pages" })).not.toBeInTheDocument();
      expect(readReportPage).toHaveBeenCalledTimes(4);
      expect(readReportPage).toHaveBeenLastCalledWith(path, { selectionId, limit: 50 }, expect.any(AbortSignal));
      await act(async () => returning.resolve(first));
      expect(await screen.findByText(plan.displayName)).toBeVisible();
    },
  );

  it.each(["mismatched selection", "expired selection", "server invalidation"])("withdraws %s and delegates restart without recapturing child evidence", async failure => {
    const first = reportPage([resolveCopilotServicePlan(servicePlanId, false, [])]);
    const onRestartSelection = vi.fn();
    if (failure === "server invalidation") vi.mocked(readReportPage).mockRejectedValue(new ApiError(409, "selection_invalidated", "Selection changed"));
    else vi.mocked(readReportPage).mockResolvedValue({ ...first, selection: { ...first.selection,
      ...(failure === "mismatched selection" ? { id: "20000000-0000-4000-8000-000000000003" } : { expiresAt: new Date(Date.now() - 1000).toISOString() }) } });
    render(<CopilotServiceDetails path={path} selectionId={selectionId} copilotServiceState="disabled" current onRestartSelection={onRestartSelection} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(failure === "expired selection"
      ? "incomplete or inconsistent saved-read metadata" : "This selection changed or expired.");
    expect(screen.queryByRole("list", { name: "Paid feature states" })).not.toBeInTheDocument();
    expect(screen.queryByText("No paid Copilot services are assigned.")).not.toBeInTheDocument();
    if (failure === "expired selection") {
      expect(readReportPage).toHaveBeenCalledOnce();
      expect(onRestartSelection).not.toHaveBeenCalled();
      return;
    }
    expect(screen.queryByRole("button", { name: "Retry saved data" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    expect(onRestartSelection).toHaveBeenCalledOnce();
    expect(readReportPage).toHaveBeenCalledOnce();
  });
});
