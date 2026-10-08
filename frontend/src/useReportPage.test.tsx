import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api/reportData";
import { ApiError } from "./api/client";
import { CapabilityContext, type useCapabilityContext } from "./capabilityContext";
import { createSavedQueryClient } from "./savedQueries";
import { deferred } from "./test/deferred";
import { reportPage, reportSelection } from "./test/reportDataFixture";
import { useReportPage } from "./useReportPage";
import { PublicationContext } from "./publicationContext";

vi.mock("./api/reportData", async original => ({
  ...await original<typeof import("./api/reportData")>(), readReportPage: vi.fn(),
}));

function page(id: string) {
  const result = reportPage([id]);
  return { ...result, selection: { ...result.selection, id, validatedAt: new Date().toISOString() },
    page: { limit: 50, nextCursor: "next", previousCursor: null } };
}
const invalidated = new ApiError(409, "selection_invalidated", "Saved data changed.");
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function sharedQueries() {
  const client = createSavedQueryClient();
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
beforeEach(() => { vi.mocked(api.readReportPage).mockResolvedValue(page("initial")); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("report page selection lifetimes", () => {
  it.each(["page-first", "observer-first"] as const)("compares the admitted report vector %s without a startup reread", async order => {
    const initial = page("initial"), published = initial.selection.publicationRevisions;
    const pending = deferred<typeof initial>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const admit = vi.fn(), Wrapper = sharedQueries();
    const context = { admit, revisions: order === "observer-first" ? published : undefined };
    const hook = renderHook(() => useReportPage("copilot-usage/users"), { wrapper: ({ children }) =>
      <Wrapper><PublicationContext value={context}>{children}</PublicationContext></Wrapper> });
    await act(async () => pending.resolve(initial));
    await waitFor(() => expect(hook.result.current.data).toBeDefined());
    context.revisions = published;
    hook.rerender();
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(published);
  });

  it.each(["fresh", "page", "detail", "export", "report", "lease-end"] as const)(
    "scopes publication synchronization to %s ownership without replaying a frozen capture", async ownership => {
      const initial = page("initial");
      vi.mocked(api.readReportPage).mockImplementation(async (_path, request) =>
        request?.selectionId ? { ...initial, selection: { ...initial.selection, validatedAt: new Date().toISOString() } } : initial);
      const Wrapper = sharedQueries(), context = { admit: vi.fn(), revisions: initial.selection.publicationRevisions };
      const hook = renderHook(() => useReportPage("copilot-usage/users",
        ownership === "report" ? { setId: initial.reports.setId! } : {}), { wrapper: ({ children }) =>
        <Wrapper><PublicationContext value={context}>{children}</PublicationContext></Wrapper> });
      await waitFor(() => expect(hook.result.current.data).toBeDefined());
      if (ownership === "page") {
        act(() => hook.result.current.next());
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
      }
      if (ownership === "detail" || ownership === "export") act(() => hook.result.current.ownPublication());
      if (ownership === "lease-end") {
        vi.spyOn(performance, "now").mockReturnValue(performance.now() + 20 * 60_000);
      }
      const before = vi.mocked(api.readReportPage).mock.calls.length;
      context.revisions = { ...context.revisions, users: "4".repeat(64) };
      hook.rerender();
      if (ownership === "lease-end") {
        expect(api.readReportPage).toHaveBeenCalledTimes(before);
        expect(hook.result.current.data?.selection.id).toBe("initial");
      } else {
        await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(before + 1));
        await waitFor(() => expect(hook.result.current.loading).toBe(false));
        expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBe(ownership === "fresh" ? undefined : "initial");
      }
      hook.rerender();
      expect(api.readReportPage).toHaveBeenCalledTimes(before + (ownership === "lease-end" ? 0 : 1));
    });

  it("shares concurrent base report synchronization while unrelated source publications do not reread Users", async () => {
    const initial = page("initial"), pending = deferred<typeof initial>();
    const Wrapper = sharedQueries(), context = { admit: vi.fn(), revisions: initial.selection.publicationRevisions };
    const hook = renderHook(() => [useReportPage("copilot-usage/users"), useReportPage("copilot-usage/users")], {
      wrapper: ({ children }) => <Wrapper><PublicationContext value={context}>{children}</PublicationContext></Wrapper>,
    });
    await waitFor(() => expect(hook.result.current.every(read => read.data)).toBe(true));
    context.revisions = { ...context.revisions, graph_packages: "4".repeat(64) };
    hook.rerender();
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    context.revisions = { ...context.revisions, users: "4".repeat(64) };
    hook.rerender();
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    await act(async () => pending.resolve(initial));
    await waitFor(() => expect(hook.result.current.every(read => read.data)).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each(["account", "revision"] as const)("keeps isolated realistic captures behind the %s owner when cancelled transports finish late", async boundary => {
    const old = reportPage(["private-old"], { selection: reportSelection(20) });
    const current = reportPage(["current"], { selection: reportSelection(21),
      reports: { ...old.reports, historyRevision: "36" } });
    const abandoned = deferred<typeof old>(), pending = deferred<typeof current>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(pending.promise);
    const props = { account: "first", revision: 0 }, Wrapper = sharedQueries();
    const viewer: ReturnType<typeof useCapabilityContext> = {
      user: { tenantId: "tenant", homeAccountId: "first", username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
      now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(async () => {}), openPermissions: vi.fn(),
    };
    const { result, rerender } = renderHook(({ revision }) => ({
      first: useReportPage<string>("copilot-usage/users", {}, revision),
      second: useReportPage<string>("copilot-usage/users", {}, revision),
    }), { initialProps: props, wrapper: ({ children }) => <Wrapper><CapabilityContext value={{
      ...viewer, user: { ...viewer.user!, homeAccountId: props.account },
    }}>{children}</CapabilityContext></Wrapper> });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    if (boundary === "account") props.account = "second";
    else props.revision = 1;
    rerender({ ...props });
    expect(signal?.aborted).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => abandoned.resolve(old));
    expect(result.current.first.data).toBeUndefined();
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.first.loading).toBe(true);
    await act(async () => pending.resolve(current));
    await waitFor(() => expect(result.current.first.data).toEqual(current));
    expect(result.current.second.data).toEqual(current);
    expect(result.current.first.data?.selection).not.toEqual(old.selection);
    expect(result.current.first.error).toBeNull();
    rerender({ ...props });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    act(() => result.current.first.invalidateSelection());
    expect(result.current.first.data).toBeUndefined();
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.first.invalidated).toBe(true);
    expect(result.current.second.invalidated).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it.each(["account", "tenant", "roles"] as const)(
    "retires abandoned reads and callbacks through an A-B-A %s round trip", async boundary => {
      const first = deferred<ReturnType<typeof page>>(), second = deferred<ReturnType<typeof page>>();
      const returned = deferred<ReturnType<typeof page>>();
      vi.mocked(api.readReportPage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        .mockReturnValueOnce(returned.promise);
      const wrapper = sharedQueries();
      const viewer: ReturnType<typeof useCapabilityContext> = {
        user: { tenantId: "tenant", homeAccountId: "first", username: "viewer@example.invalid", displayName: "Viewer",
          roles: ["AgentControl.Viewer"] },
        now: Date.now(), views: [], loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
      };
      const original = viewer.user!;
      const props = { user: original };
      const { result, rerender } = renderHook(() => useReportPage<string>("copilot-usage/users"), {
        initialProps: props,
        wrapper: ({ children }) => {
          const Wrapper = wrapper;
          return <Wrapper><CapabilityContext value={{ ...viewer, user: props.user }}>{children}</CapabilityContext></Wrapper>;
        },
      });
      const abandonedActions = result.current, firstSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      props.user = { ...original, ...(boundary === "account" ? { homeAccountId: "second" }
        : boundary === "tenant" ? { tenantId: "other" } : { roles: ["AgentControl.Viewer", "AgentControl.Admin"] }) };
      rerender({ ...props });
      const secondSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      props.user = original;
      rerender({ ...props });
      expect(firstSignal?.aborted).toBe(true);
      expect(secondSignal?.aborted).toBe(true);
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      act(() => {
        abandonedActions.retry(); abandonedActions.next(); abandonedActions.restart(); abandonedActions.invalidateSelection();
      });
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      expect(abandonedActions.isCurrentData(true)).toBe(false);
      await act(async () => { first.reject(invalidated); second.resolve(page("other-scope")); });
      expect(result.current.loading).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toBeUndefined();
      expect(result.current.selectionId).toBeUndefined();
      await act(async () => returned.resolve(page("current-scope")));
      await waitFor(() => expect(result.current.data?.selection.id).toBe("current-scope"));
      expect(result.current.error).toBeNull();
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      rerender({ ...props });
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
    });

  it.each([false, true])("does not retry expired evidence before the expiry timer renders (pinned=%s)", async pinned => {
    const initial = page("initial"), replacement = deferred<ReturnType<typeof page>>();
    initial.selection.expiresAt = new Date(Date.now() + 20_000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockRejectedValueOnce(new Error("Page unavailable."))
      .mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useReportPage<string>("official-usage/aggregate",
      pinned ? { selectionId: "initial" } : {}), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.next());
    await waitFor(() => expect(result.current.error?.message).toBe("Page unavailable."));
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 20_001);
    act(() => result.current.retry());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(result.current.invalidated).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("ignores a failed page's stale retry after that page has recovered", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Page unavailable."));
    const { result } = renderHook(() => useReportPage<string>("official-usage/aggregate"), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.error?.message).toBe("Page unavailable."));
    const staleRetry = result.current.retry;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => staleRetry());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBeDefined();
  });

  it.each([401, 403])("does not automatically recover a %i denial when the retained selection expires", async status => {
    vi.useFakeTimers();
    const initial = page("initial");
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockRejectedValueOnce(new ApiError(status, "forbidden", "Access denied."));
    const { result } = renderHook(() => useReportPage("official-usage/aggregate"), { wrapper: sharedQueries() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    act(() => result.current.next());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.error?.message).toBe("Access denied.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.error).toMatchObject({ status });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    act(() => { result.current.retry(); window.dispatchEvent(new Event("focus")); });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("replacement"));
    act(() => result.current.restart());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.selection.id).toBe("replacement");
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });

  it.each([false, true].flatMap(failed => [false, true].map(beforeTimer => ({ failed, beforeTimer }))))(
    "does not replay a locally expired pinned selection on cache invalidation (failed=$failed, beforeTimer=$beforeTimer)", async ({ failed, beforeTimer }) => {
    vi.useFakeTimers();
    const wrapper = sharedQueries(), client = clients.at(-1)!, initial = page("initial");
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial);
    const { result } = renderHook(() => useReportPage("official-usage/aggregate", { selectionId: "initial" }), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    if (failed) {
      vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Page unavailable."));
      act(() => result.current.next());
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    }
    if (beforeTimer) vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
    else {
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(result.current.leaseEnded).toBe(true);
    }
    const count = vi.mocked(api.readReportPage).mock.calls.length;
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.readReportPage).toHaveBeenCalledTimes(count);
    expect(result.current.leaseEnded).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBe(failed ? undefined : initial);
  });

  it.each(["failure", "invalidation", "expiry", "revalidation"] as const)(
    "checks live cache and expiry before paging through a just-started %s", async boundary => {
      const wrapper = sharedQueries(), client = clients.at(-1)!;
      const initial = page("initial");
      vi.mocked(api.readReportPage).mockResolvedValue(initial);
      const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      const cached = client.getQueryCache().find({ queryKey: ["saved", "record-page"], exact: false })!;
      const pending = deferred<ReturnType<typeof page>>();
      vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
      act(() => {
        if (boundary === "failure") cached.setState({ status: "error", error: new Error("Read failed.") });
        if (boundary === "invalidation") result.current.invalidateSelection();
        if (boundary === "expiry") vi.spyOn(performance, "now").mockReturnValue(performance.now() + 600_001);
        if (boundary === "revalidation") window.dispatchEvent(new Event("focus"));
        result.current.next();
      });
      expect(api.readReportPage).toHaveBeenCalledTimes(boundary === "revalidation" ? 2 : 1);
      expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.cursor).toBeUndefined();
      if (boundary === "revalidation") expect(vi.mocked(api.readReportPage).mock.lastCall?.[2]?.aborted).toBe(false);
    });

  it("rejects a previous page's handlers without cancelling or restarting the current page", async () => {
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const stale = result.current;
    const second = page("initial");
    second.value = ["second"];
    vi.mocked(api.readReportPage).mockResolvedValueOnce(second);
    act(() => stale.next());
    await waitFor(() => expect(result.current.data?.value).toEqual(["second"]));
    const count = vi.mocked(api.readReportPage).mock.calls.length;
    act(() => { stale.next(); stale.retry(); });
    expect(stale.isCurrentData(true)).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(count);
    expect(result.current.data?.value).toEqual(["second"]);
  });

  it("fences actions immediately after invalidated revalidation is cancelled, before observers render", async () => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    act(() => {
      void client.invalidateQueries({ queryKey: ["saved", "record-page"] });
      void client.cancelQueries({ queryKey: ["saved", "record-page"] });
      expect(result.current.isCurrentData(true)).toBe(false);
      result.current.next();
    });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.cursor).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBeUndefined());
    expect(result.current.loading).toBe(false);
    expect(result.current.error?.message).toBe("Saved data needs reloading. Retry saved data.");
  });

  it.each([false, true])("does not let prior peer retirement mask a cancelled invalidation (revalidated=%s)", async revalidated => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const { result } = renderHook(() => ({
      first: useReportPage<string>("copilot-usage/users"),
      second: useReportPage<string>("copilot-usage/users"),
    }), { wrapper });
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("replacement"));
    act(() => result.current.first.restart());
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("replacement"));
    expect(result.current.second.data?.selection.id).toBe("initial");
    if (revalidated) {
      act(() => result.current.second.retry());
      await waitFor(() => expect(result.current.second.data?.selection.id).toBe("initial"));
    }
    const cached = client.getQueryCache().getAll().find(query => query.queryKey[4] === 0)!;
    expect(cached.state.isInvalidated).toBe(false);
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => {
      void client.invalidateQueries({ queryKey: cached.queryKey, exact: true });
      void client.cancelQueries({ queryKey: cached.queryKey, exact: true });
      expect(result.current.second.isCurrentData(true)).toBe(false);
      result.current.second.next();
    });
    expect(api.readReportPage).toHaveBeenCalledTimes(revalidated ? 4 : 3);
    await waitFor(() => expect(result.current.second.error?.message).toBe("Saved data needs reloading. Retry saved data."));
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.second.selectionId).toBeUndefined();
    expect(result.current.second.loading).toBe(false);
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => page(query?.selectionId ?? "initial"));
    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => pending.resolve(page("initial")));
    expect(api.readReportPage).toHaveBeenCalledTimes(revalidated ? 5 : 4);
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.first.data?.selection.id).toBe("replacement");
    const count = vi.mocked(api.readReportPage).mock.calls.length;
    act(() => { result.current.second.retry(); result.current.second.retry(); });
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("initial"));
    expect(api.readReportPage).toHaveBeenCalledTimes(count + 1);
    expect(result.current.second.error).toBeNull();
  });

  it.each(["query", "revision", "disabled", "restart", "account", "unmount"] as const)(
    "retires old page and selection callbacks after %s changes, even if their cache is retained", async boundary => {
      const wrapper = sharedQueries();
      const viewer: ReturnType<typeof useCapabilityContext> = {
        user: { tenantId: "tenant", homeAccountId: "first", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
        views: [], loading: false, pending: false, error: undefined, now: Date.now(), reload: vi.fn(), openPermissions: vi.fn(),
      };
      const props = { search: "", revision: 0, enabled: true, account: "first" };
      const { result, rerender, unmount } = renderHook(({ search, revision, enabled, account }) => {
        const read = useReportPage<string>("copilot-usage/users", { search }, revision, enabled);
        return { ...read, account };
      }, { wrapper: ({ children }) => {
        const Wrapper = wrapper;
        return <Wrapper><CapabilityContext value={{ ...viewer, user: { ...viewer.user!, homeAccountId: props.account } }}>{children}</CapabilityContext></Wrapper>;
      }, initialProps: props });
      await waitFor(() => expect(result.current.data).toBeDefined());
      const stale = result.current;
      if (boundary === "restart") {
        vi.mocked(api.readReportPage).mockResolvedValueOnce(page("replacement"));
        act(() => result.current.restart());
        await waitFor(() => expect(result.current.data?.selection.id).toBe("replacement"));
      } else if (boundary === "unmount") unmount();
      else {
        Object.assign(props, boundary === "query" ? { search: "new" } : boundary === "revision" ? { revision: 1 }
          : boundary === "disabled" ? { enabled: false } : { account: "second" });
        rerender({ ...props });
        if (boundary !== "disabled") await waitFor(() => expect(result.current.loading).toBe(false));
      }
      const count = vi.mocked(api.readReportPage).mock.calls.length;
      act(() => { stale.next(); stale.retry(); stale.restart(); stale.invalidateSelection(); });
      await act(async () => {});
      expect(stale.isCurrentData(true)).toBe(false);
      expect(api.readReportPage).toHaveBeenCalledTimes(count);
      if (boundary !== "unmount") expect(result.current.invalidated).toBe(false);
    });

  it("admits only the first navigation direction before React commits the page transition", async () => {
    const initial = page("initial");
    vi.mocked(api.readReportPage).mockResolvedValueOnce({ ...initial, page: { ...initial.page, previousCursor: "previous" } });
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => { result.current.next(); result.current.previous(); });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.cursor).toBe("next");
  });

  it("retries a just-rejected cursor from the first page before the error notification renders", async () => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.next());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const cached = client.getQueryCache().getAll().find(query => query.queryKey[6] === "next")!;
    act(() => {
      cached.setState({ status: "error", error: new ApiError(400, "invalid_cursor", "Cursor expired.") });
      result.current.retry();
      result.current.retry();
    });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toEqual({ selectionId: "initial", limit: 50 });
  });

  it("deduplicates parent restart admission without permanently blocking another recovery attempt", async () => {
    const restartParent = vi.fn();
    vi.mocked(api.readReportPage).mockRejectedValue(invalidated);
    const { result } = renderHook(() => useReportPage("official-usage/history/set/observations", { selectionId: "initial" },
      0, true, restartParent), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    act(() => { result.current.restart(); result.current.restart(); });
    expect(restartParent).toHaveBeenCalledOnce();
    await act(async () => {});
    act(() => result.current.restart());
    expect(restartParent).toHaveBeenCalledTimes(2);
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("does not retry a %i denial on focus before its observer notification renders", async status => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const { result } = renderHook(() => useReportPage<string>("official-usage/history/options"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const cached = client.getQueryCache().find({ queryKey: ["saved", "record-page"], exact: false })!;
    act(() => {
      cached.setState({ status: "error", error: new ApiError(status, "forbidden", "Report access denied") });
      window.dispatchEvent(new Event("focus"));
    });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.error?.message).toBe("Report access denied"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("requires explicit restart after server invalidation instead of replaying on focus (pinned=%s)", async pinned => {
    const restart = vi.fn(), wrapper = sharedQueries(), client = clients.at(-1)!;
    vi.mocked(api.readReportPage).mockRejectedValue(invalidated);
    const { result } = renderHook(() => useReportPage<string>("official-usage/aggregate",
      pinned ? { selectionId: "initial" } : {}, 0, true, restart), { wrapper });
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    const reads = 1;
    expect(api.readReportPage).toHaveBeenCalledTimes(reads);
    act(() => { result.current.retry(); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus")); });
    await act(async () => {});
    expect(api.readReportPage).toHaveBeenCalledTimes(reads);
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
    expect(api.readReportPage).toHaveBeenCalledTimes(reads);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeUndefined();
    vi.mocked(api.readReportPage).mockResolvedValue(page("replacement"));
    act(() => result.current.restart());
    if (pinned) {
      expect(restart).toHaveBeenCalledOnce();
      expect(api.readReportPage).toHaveBeenCalledTimes(reads);
    } else {
      await waitFor(() => expect(result.current.data?.selection.id).toBe("replacement"));
      expect(api.readReportPage).toHaveBeenCalledTimes(reads + 1);
    }
  });

  it("does not replay a just-rejected selection on retry or focus before its observer notification renders", async () => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const { result } = renderHook(() => useReportPage<string>("official-usage/aggregate",
      { selectionId: "initial" }), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const cached = client.getQueryCache().find({ queryKey: ["saved", "record-page"], exact: false })!;
    act(() => {
      cached.setState({ status: "error", error: invalidated });
      result.current.retry();
      window.dispatchEvent(new Event("focus"));
    });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.invalidated).toBe(true));
  });

  it("does not let cache invalidation restart a child-rejected capture or admit its late response", async () => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const { result } = renderHook(() => useReportPage<string>("official-usage/aggregate"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => {
      result.current.invalidateSelection();
      result.current.retry();
      void client.invalidateQueries({ queryKey: ["saved", "record-page"] });
    });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(page("initial")));
    expect(result.current.data).toBeUndefined();
    expect(result.current.invalidated).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it("lets a parent own focus revalidation without replacing the page or disabling explicit retry", async () => {
    const { result, rerender } = renderHook(({ revalidateOnFocus }) => useReportPage<string>(
      "agent-inventory/agent/usage-users", { selectionId: "initial" }, 0, true, undefined, revalidateOnFocus),
    { wrapper: sharedQueries(), initialProps: { revalidateOnFocus: false } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => { result.current.retry(); result.current.retry(); });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    rerender({ revalidateOnFocus: true });
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(page("initial")));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
  });

  it("still checks selection expiry on focus when the parent owns network revalidation", async () => {
    const now = Date.now(), initial = page("initial");
    initial.selection.expiresAt = new Date(now + 20_000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValue(initial);
    const { result } = renderHook(() => useReportPage<string>(
      "agent-inventory/agent/usage-users", { selectionId: "initial" }, 0, true, undefined, false), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 21_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current.data).toBe(initial);
    expect(result.current.leaseEnded).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it.each([true, false])("retries a rejected cursor without recapturing its selection (pinned=%s)", async pinned => {
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => {
      if (query?.cursor) throw new ApiError(400, "invalid_cursor", "Cursor expired.");
      return page("initial");
    });
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users",
      { ...(pinned ? { selectionId: "initial" } : {}), search: "person" }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.next());
    await waitFor(() => expect(result.current.error?.message).toBe("Cursor expired."));
    act(() => { result.current.retry(); result.current.retry(); });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.error).toBeNull();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/users",
      { selectionId: "initial", search: "person", limit: 50 }, expect.any(AbortSignal));
  });

  it.each([true, false])("preserves the selection deadline while retrying a rejected cursor (pinned=%s)", async pinned => {
    vi.useFakeTimers();
    const initial = page("initial"), retry = deferred<ReturnType<typeof page>>();
    const restartParent = vi.fn();
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new ApiError(400, "invalid_cursor", "Cursor expired."))
      .mockReturnValueOnce(retry.promise);
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users",
      pinned ? { selectionId: "initial" } : {}, 0, true, restartParent), { wrapper: sharedQueries() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    act(() => result.current.next());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.error?.message).toBe("Cursor expired.");
    act(() => { result.current.retry(); result.current.retry(); });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toEqual({ selectionId: "initial", limit: 50 });
    expect(result.current.data).toBeUndefined();
    expect(result.current.selectionId).toBe("initial");
    expect(result.current.loading).toBe(true);
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(signal?.aborted).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(result.current.selectionId).toBeUndefined();
    expect(result.current.leaseEnded).toBe(true);
    expect(result.current.loading).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    await act(async () => { retry.resolve(initial); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data).toBe(initial);
    expect(result.current.leaseEnded).toBe(true);
  });

  it("retains an expired displayed selection until explicit replacement", async () => {
    vi.useFakeTimers();
    const initial = page("initial"), replacement = deferred<ReturnType<typeof page>>();
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper: sharedQueries() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.selection.id).toBe("initial");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(result.current.data).toBe(initial);
    expect(result.current.leaseEnded).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    act(() => result.current.restart());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => { replacement.resolve(page("replacement")); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.selection.id).toBe("replacement");
  });
  it("does not cancel or repin already-admitted pagination when its local lease ends", async () => {
    vi.useFakeTimers();
    const initial = page("initial"), next = deferred<ReturnType<typeof page>>(), replacement = deferred<ReturnType<typeof page>>();
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(next.promise).mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useReportPage<string>("official-usage/aggregate"), { wrapper: sharedQueries() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    act(() => result.current.next());
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(signal?.aborted).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBe("initial");
    await act(async () => { next.resolve(initial); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data).toBe(initial);
    expect(result.current.leaseEnded).toBe(true);
    act(() => result.current.restart());
    await act(async () => { replacement.resolve(page("replacement")); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.selection.id).toBe("replacement");
  });
  it("keeps an admitted pinned page through lease end and delegates explicit replacement to its parent", async () => {
    vi.useFakeTimers();
    const initial = page("initial"), next = deferred<ReturnType<typeof page>>(), restart = vi.fn();
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useReportPage<string>("official-usage/agents/agent/users",
      { selectionId: "initial" }, 0, true, restart), { wrapper: sharedQueries() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    act(() => result.current.next());
    expect(result.current.selectionId).toBe("initial");
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(signal?.aborted).toBe(false);
    expect(result.current.selectionId).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(result.current.leaseEnded).toBe(true);
    act(() => { window.dispatchEvent(new Event("focus")); result.current.restart(); });
    expect(restart).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => { next.resolve(initial); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data).toBe(initial);
    expect(result.current.leaseEnded).toBe(true);
  });
  it.each(["copilot-usage/users", "official-usage/users", "official-usage/overview", "official-usage/history/options"])("reuses a recent first %s page on remount without another capture", async path => {
    const wrapper = sharedQueries();
    const first = renderHook(() => useReportPage<string>(path), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    first.unmount();
    const returned = renderHook(() => useReportPage<string>(path), { wrapper });
    expect(returned.result.current.data?.selection.id).toBe("initial");
    expect(returned.result.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    vi.mocked(api.readReportPage).mockResolvedValueOnce({ ...page("initial"), value: ["focused"] });
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(returned.result.current.data?.value).toEqual(["focused"]));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBe("initial");
  });

  it.each(["copilot-usage/users", "official-usage/users", "official-usage/overview"])("reuses a recent %s filter visit without an empty intermediate result", async path => {
    const { result, rerender } = renderHook(({ search }) => useReportPage<string>(path, { search }),
      { wrapper: sharedQueries(), initialProps: { search: "" } });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("filtered"));
    rerender({ search: "Ada" });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("filtered"));
    rerender({ search: "" });
    expect(result.current.data?.selection.id).toBe("initial");
    expect(result.current.loading).toBe(false);
    rerender({ search: "Ada" });
    expect(result.current.data?.selection.id).toBe("filtered");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it.each(["ttl", "expiry", "revision"] as const)("reloads a retained cohort after its %s boundary", async boundary => {
    const now = Date.now(), wrapper = sharedQueries();
    const initial = page("initial");
    initial.selection.expiresAt = new Date(now + (boundary === "ttl" ? 60_000 : 20_000)).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial);
    const first = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    first.unmount();
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + (boundary === "ttl" ? 31_000 : boundary === "expiry" ? 21_000 : 0));
    const returned = renderHook(() => useReportPage<string>("copilot-usage/users", {}, boundary === "revision" ? 1 : 0), { wrapper });
    expect(returned.result.current.loading).toBe(true);
    expect(returned.result.current.data).toBeUndefined();
    await act(async () => pending.resolve(page("replacement")));
    await waitFor(() => expect(returned.result.current.data?.selection.id).toBe("replacement"));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("retains a new source revision arriving during the initial read without resetting cohort filters", async () => {
    const wrapper = sharedQueries();
    vi.mocked(api.readReportPage).mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(page("published"));
    const first = renderHook(({ revision }) => useReportPage<string>("copilot-usage/users", { cohort: "needs_attention" }, revision),
      { wrapper, initialProps: { revision: 0 } });
    first.rerender({ revision: 1 });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("published"));
    first.unmount();
    const returned = renderHook(() => useReportPage<string>("copilot-usage/users", { cohort: "needs_attention" }, 1), { wrapper });
    expect(returned.result.current.data?.selection.id).toBe("published");
    expect(returned.result.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("does not revive a retained page after an explicit restart", async () => {
    const wrapper = sharedQueries(), first = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => first.result.current.restart());
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("restarted"));
    first.unmount();
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const returned = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    expect(returned.result.current.data).toBeUndefined();
    expect(returned.result.current.loading).toBe(true);
    await act(async () => pending.resolve(page("returned")));
    await waitFor(() => expect(returned.result.current.data?.selection.id).toBe("returned"));
  });

  it.each(["retry", "next"] as const)("withdraws an export-rejected selection from a peer's pending %s and rejects late evidence", async action => {
    const pending = deferred<ReturnType<typeof page>>();
    const { result } = renderHook(() => ({
      first: useReportPage<string>("copilot-usage/users"),
      second: useReportPage<string>("copilot-usage/users"),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => result.current.second[action]());
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    act(() => result.current.first.invalidateSelection());
    expect(signal?.aborted).toBe(true);
    expect(result.current.first.invalidated).toBe(true);
    expect(result.current.second.invalidated).toBe(true);
    expect(result.current.first.data).toBeUndefined();
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.first.loading).toBe(false);
    expect(result.current.second.loading).toBe(false);
    await act(async () => pending.resolve(page("initial")));
    await waitFor(() => expect(result.current.second.loading).toBe(false));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(result.current.first.invalidated).toBe(true);
    expect(result.current.second.invalidated).toBe(true);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("replacement"));
    act(() => result.current.first.restart());
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("replacement"));
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.second.invalidated).toBe(true);
  });

  it("does not retire a peer's newer selection when the original export is rejected", async () => {
    const { result } = renderHook(() => ({
      first: useReportPage<string>("copilot-usage/users"),
      second: useReportPage<string>("copilot-usage/users"),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("newer"));
    act(() => result.current.second.restart());
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("newer"));
    act(() => result.current.first.invalidateSelection());
    expect(result.current.first.invalidated).toBe(true);
    expect(result.current.second.data?.selection.id).toBe("newer");
    expect(result.current.second.invalidated).toBe(false);
    expect(result.current.second.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("retires the pinned selection when a child rejects it during parent pagination", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => result.current.next());
    expect(result.current.data).toBeUndefined();
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    act(() => result.current.invalidateSelection());
    expect(signal?.aborted).toBe(true);
    expect(result.current.invalidated).toBe(true);
    expect(result.current.loading).toBe(false);
    await act(async () => pending.resolve(page("initial")));
    expect(result.current.data).toBeUndefined();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("replacement"));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("replacement"));
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toEqual({ limit: 50 });
  });

  it.each(["manual", "rejected"] as const)("retires standalone cached evidence across filter visits after %s explicit restart", async kind => {
    const { result, rerender } = renderHook(({ search }) =>
      useReportPage<string>("copilot-usage/users", { search }), { initialProps: { search: "" } });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("initial"));
    if (kind === "rejected") {
      vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
      act(() => result.current.next());
      await waitFor(() => expect(result.current.invalidated).toBe(true));
    }
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("restarted"));
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("filtered"));
    rerender({ search: "Ada" });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("filtered"));

    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    rerender({ search: "" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ search: "", limit: 50 });
    await act(async () => pending.resolve(page("returned")));
    await waitFor(() => expect(result.current.data?.selection.id).toBe("returned"));
  });

  it.each(["selectionId", "setId"] as const)("accepts a case-equivalent %s UUID without recapturing evidence", async field => {
    const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
    const response = { ...page(id), reports: { ...page(id).reports, setId: id } };
    vi.mocked(api.readReportPage).mockResolvedValue(response);
    const { result } = renderHook(() => useReportPage<string>("official-usage/users", { [field]: id.toUpperCase() }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(response);
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it.each(["selectionId", "setId"] as const)("rejects a genuinely mismatched %s UUID", async field => {
    const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
    const response = { ...page(id), reports: { ...page(id).reports, setId: id } };
    vi.mocked(api.readReportPage).mockResolvedValue(response);
    const { result } = renderHook(() => useReportPage<string>("official-usage/users",
      { [field]: "abcdef12-abcd-4abc-8abc-abcdef123457" }));
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toMatchObject({ code: "selection_invalidated" });
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it.each(["selectionId", "setId", "inventorySelectionId"] as const)(
    "shares case-equivalent %s requests and preserves their immutable request filters on focus", async field => {
    const id = "abcdef12-abcd-4abc-8abc-abcdef123456", pending = deferred<ReturnType<typeof page>>();
    const path = field === "inventorySelectionId" ? "agent-inventory/agent/usage-users" : "official-usage/users";
    const response = { ...page(id), reports: { ...page(id).reports, setId: id } };
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise).mockResolvedValue(response);
    const wrapper = sharedQueries();
    const first = renderHook(({ value }) => useReportPage<string>(path, { [field]: value }),
      { wrapper, initialProps: { value: id.toUpperCase() } });
    const second = renderHook(() => useReportPage<string>(path, { [field]: id }), { wrapper });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    first.rerender({ value: id });
    expect(signal?.aborted).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(response));
    await waitFor(() => expect(first.result.current.data).toEqual(response));
    expect(second.result.current.data).toEqual(response);
    first.rerender({ value: id.toUpperCase() });
    expect(first.result.current.data).toEqual(response);
    expect(first.result.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(api.readReportPage).mock.calls) expect(call[1]).toMatchObject({ [field]: id });
  });

  it.each(["property-order", "default-limit"] as const)(
    "shares equivalent request identities across %s edits and retires their peers together", async difference => {
    const pending = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const firstQuery: api.ReportPageRequest = { company: "Contoso", department: null };
    const equivalent: api.ReportPageRequest = difference === "property-order"
      ? { department: null, company: "Contoso" } : { ...firstQuery, limit: 50 };
    const wrapper = sharedQueries();
    const first = renderHook(({ query }) => useReportPage<string>("official-usage/users", query),
      { wrapper, initialProps: { query: firstQuery } });
    const second = renderHook(() => useReportPage<string>("official-usage/users", equivalent), { wrapper });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    first.rerender({ query: equivalent });
    expect(signal?.aborted).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(page("initial")));
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    expect(second.result.current.data?.selection.id).toBe("initial");
    first.rerender({ query: firstQuery });
    expect(first.result.current.loading).toBe(false);
    expect(first.result.current.data?.selection.id).toBe("initial");
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const next = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(next.promise);
    act(() => first.result.current.next());
    const nextSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    first.rerender({ query: equivalent });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.cursor).toBe("next");
    expect(nextSignal?.aborted).toBe(false);
    await act(async () => next.resolve(page("initial")));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.data?.selection.id).toBe("initial");
    act(() => first.result.current.invalidateSelection());
    await waitFor(() => expect(second.result.current.invalidated).toBe(true));
    expect(first.result.current.data).toBeUndefined();
    expect(second.result.current.data).toBeUndefined();
    expect(first.result.current.loading).toBe(false);
    expect(second.result.current.loading).toBe(false);
  });

  it("keeps missing, null and empty facet values and different page sizes in separate caches", async () => {
    const wrapper = sharedQueries();
    const inputs: api.ReportPageRequest[] = [{}, { company: null }, { company: "" }, { limit: 25 }];
    const readers = inputs.map(query => renderHook(() => useReportPage<string>("official-usage/users", query), { wrapper }));
    await waitFor(() => expect(readers.every(reader => reader.result.current.data)).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(inputs.length);
    act(() => readers[1].result.current.invalidateSelection());
    expect(readers[1].result.current.invalidated).toBe(true);
    for (const index of [0, 2, 3]) {
      expect(readers[index].result.current.invalidated).toBe(false);
      expect(readers[index].result.current.data).toBeDefined();
    }
  });

  it("withdraws every case-equivalent page of a rejected selection", async () => {
    const id = "abcdef12-abcd-4abc-8abc-abcdef123456";
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page(id.toUpperCase())).mockResolvedValue(page(id));
    const { result } = renderHook(() => ({
      first: useReportPage<string>("official-usage/users"),
      second: useReportPage<string>("official-usage/users"),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe(id.toUpperCase()));
    act(() => result.current.second.next());
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe(id));
    act(() => result.current.first.invalidateSelection());
    expect(result.current.first.invalidated).toBe(true);
    expect(result.current.second.invalidated).toBe(true);
    expect(result.current.first.data).toBeUndefined();
    expect(result.current.second.data).toBeUndefined();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("does not let another observer's pending retry hide a restarted selection or settle its retry", async () => {
    const retry = deferred<ReturnType<typeof page>>(), restartedRetry = deferred<ReturnType<typeof page>>();
    const { result } = renderHook(() => ({
      first: useReportPage<string>("copilot-usage/users"),
      second: useReportPage<string>("copilot-usage/users"),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(retry.promise);
    act(() => result.current.first.retry());
    expect(result.current.first.data).toBeUndefined();
    const retrySignal = vi.mocked(api.readReportPage).mock.calls.at(-1)?.[2];
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => result.current.first.restart());
    await waitFor(() => expect(result.current.first.loading).toBe(false));
    expect(retrySignal?.aborted).toBe(false);
    expect(result.current.first.data?.selection.id).toBe("restarted");
    vi.mocked(api.readReportPage).mockReturnValueOnce(restartedRetry.promise);
    act(() => result.current.first.retry());
    await act(async () => retry.resolve(page("initial")));
    await waitFor(() => expect(result.current.second.loading).toBe(false));
    expect(result.current.first.loading).toBe(true);
    expect(result.current.first.data).toBeUndefined();
    await act(async () => restartedRetry.resolve(page("restarted")));
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("restarted"));
    expect(result.current.second.data?.selection.id).toBe("initial");
  });

  it("shares simultaneous saved-data retries without aborting and duplicating the pending request", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const { result } = renderHook(() => ({
      first: useReportPage<string>("copilot-usage/users"),
      second: useReportPage<string>("copilot-usage/users"),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Read failed."));
    act(() => result.current.first.retry());
    await waitFor(() => expect(result.current.second.error?.message).toBe("Read failed."));
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    act(() => { result.current.first.retry(); result.current.second.retry(); result.current.first.retry(); });
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[2]?.aborted).toBe(false);
    expect(result.current.first.data).toBeUndefined();
    expect(result.current.second.data).toBeUndefined();
    await act(async () => pending.resolve(page("initial")));
    await waitFor(() => expect(result.current.first.loading).toBe(false));
    expect(result.current.first.data?.selection.id).toBe("initial");
    expect(result.current.second.data?.selection.id).toBe("initial");
    expect(result.current.first.error).toBeNull();
    expect(result.current.second.error).toBeNull();
  });

  it("does not let a pending retry hide an explicit selection revalidated at a new revision", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const { result, rerender } = renderHook(({ revision }) => ({
      first: useReportPage<string>("official-usage/agents/agent/users", { selectionId: "initial" }, revision),
      second: useReportPage<string>("official-usage/agents/agent/users", { selectionId: "initial" }),
    }), { wrapper: sharedQueries(), initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => result.current.first.retry());
    const pendingSignal = vi.mocked(api.readReportPage).mock.calls.at(-1)?.[2];
    vi.mocked(api.readReportPage).mockResolvedValueOnce({ ...page("initial"), value: ["revalidated"] });
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.first.data?.value).toEqual(["revalidated"]));
    expect(pendingSignal?.aborted).toBe(false);
    await act(async () => pending.resolve(page("initial")));
    await waitFor(() => expect(result.current.second.loading).toBe(false));
    expect(result.current.first.data?.value).toEqual(["revalidated"]);
  });

  it.each(["success", "failure"] as const)(
    "withdraws a retained placeholder after cancelled revision revalidation and ignores late %s", async outcome => {
      const wrapper = sharedQueries(), client = clients.at(-1)!;
      const abandoned = deferred<ReturnType<typeof page>>(), recovery = deferred<ReturnType<typeof page>>();
      const { result, rerender } = renderHook(({ revision }) => useReportPage<string>(
        "official-usage/agents/agent/users", { selectionId: "initial" }, revision),
      { wrapper, initialProps: { revision: 0 } });
      await waitFor(() => expect(result.current.data).toBeDefined());
      const initial = result.current.data;
      vi.mocked(api.readReportPage).mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(recovery.promise);
      rerender({ revision: 1 });
      expect(result.current.data).toEqual(initial);
      expect(result.current.loading).toBe(true);
      expect(result.current.isCurrentData(true)).toBe(false);
      const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      await act(async () => { await client.cancelQueries({ queryKey: ["saved", "record-page"] }); });
      expect(signal?.aborted).toBe(true);
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.data).toBeUndefined();
      expect(result.current.selectionId).toBeUndefined();
      expect(result.current.error?.message).toBe("The saved-data read was cancelled. Retry saved data.");
      expect(result.current.invalidated).toBe(false);
      act(() => { window.dispatchEvent(new Event("focus")); result.current.next(); });
      expect(api.readReportPage).toHaveBeenCalledTimes(2);
      act(() => { result.current.retry(); result.current.retry(); });
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeUndefined();
      await act(async () => {
        if (outcome === "success") abandoned.resolve(page("initial"));
        else abandoned.reject(invalidated);
      });
      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeUndefined();
      expect(result.current.invalidated).toBe(false);
      await act(async () => recovery.resolve({ ...page("initial"), value: ["revalidated"] }));
      await waitFor(() => expect(result.current.data?.value).toEqual(["revalidated"]));
      expect(result.current.error).toBeNull();
      expect(result.current.selectionId).toBe("initial");
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
    });

  it.each(["success", "failure"] as const)(
    "keeps manual retry evidence hidden until an invalidation replacement settles (%s)", async outcome => {
      const wrapper = sharedQueries(), client = clients.at(-1)!;
      const retry = deferred<ReturnType<typeof page>>(), replacement = deferred<ReturnType<typeof page>>();
      const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
      await waitFor(() => expect(result.current.data).toBeDefined());
      vi.mocked(api.readReportPage).mockReturnValueOnce(retry.promise).mockReturnValueOnce(replacement.promise);
      act(() => result.current.retry());
      const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
      act(() => { void client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
      await act(async () => {});
      expect(signal?.aborted).toBe(true);
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeUndefined();
      expect(result.current.selectionId).toBeUndefined();
      await act(async () => retry.reject(invalidated));
      expect(result.current.invalidated).toBe(false);
      expect(result.current.loading).toBe(true);
      expect(result.current.data).toBeUndefined();
      await act(async () => {
        if (outcome === "success") replacement.resolve(page("initial"));
        else replacement.reject(new Error("Replacement failed."));
      });
      await waitFor(() => expect(result.current.loading).toBe(false));
      if (outcome === "success") {
        expect(result.current.data?.selection.id).toBe("initial");
        expect(result.current.error).toBeNull();
      } else {
        expect(result.current.data).toBeUndefined();
        expect(result.current.error?.message).toBe("Replacement failed.");
      }
      expect(api.readReportPage).toHaveBeenCalledTimes(3);
    });

  it.each(["manual", "rejected"] as const)("does not revive a cache entry when a pending read settles after %s explicit restart", async kind => {
    const wrapper = sharedQueries(), pending = deferred<ReturnType<typeof page>>();
    const first = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    const second = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    if (kind === "rejected") {
      const next = page("initial");
      vi.mocked(api.readReportPage).mockResolvedValueOnce({ ...next, page: { ...next.page, nextCursor: "last" } });
      act(() => first.result.current.next());
      await waitFor(() => expect(first.result.current.data?.page.nextCursor).toBe("last"));
    }
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => second.result.current.retry());
    const pendingSignal = vi.mocked(api.readReportPage).mock.calls.at(-1)?.[2];
    if (kind === "rejected") {
      vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
      act(() => first.result.current.next());
      await waitFor(() => expect(first.result.current.invalidated).toBe(true));
    }
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => first.result.current.restart());
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("restarted"));
    expect(pendingSignal?.aborted).toBe(kind === "rejected");
    await act(async () => pending.resolve(page("initial")));
    if (kind === "rejected") {
      await waitFor(() => expect(second.result.current.invalidated).toBe(true));
      expect(second.result.current.data).toBeUndefined();
      expect(second.result.current.loading).toBe(false);
    } else await waitFor(() => expect(second.result.current.data?.selection.id).toBe("initial"));
    first.unmount();
    second.unmount();

    const replacement = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(replacement.promise);
    const returned = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    expect(returned.result.current.data).toBeUndefined();
    expect(returned.result.current.loading).toBe(true);
    await act(async () => replacement.resolve(page("returned")));
    await waitFor(() => expect(returned.result.current.data?.selection.id).toBe("returned"));
    returned.unmount();
    const requests = vi.mocked(api.readReportPage).mock.calls.length;
    const remounted = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    expect(remounted.result.current.data?.selection.id).toBe("returned");
    expect(api.readReportPage).toHaveBeenCalledTimes(requests);
  });

  it("does not admit a retired shared response for a new observer joining its pending read", async () => {
    const wrapper = sharedQueries(), pending = deferred<ReturnType<typeof page>>();
    const first = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    const second = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => second.result.current.retry());
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => first.result.current.restart());
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("restarted"));
    const exposed: string[] = [];
    const replacement = deferred<ReturnType<typeof page>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(replacement.promise);
    const returned = renderHook(() => {
      const read = useReportPage<string>("copilot-usage/users");
      if (read.data) exposed.push(read.data.selection.id);
      return read;
    }, { wrapper });
    expect(returned.result.current.data).toBeUndefined();
    await act(async () => pending.resolve(page("initial")));
    expect(returned.result.current.data).toBeUndefined();
    await act(async () => replacement.resolve(page("returned")));
    await waitFor(() => expect(returned.result.current.data?.selection.id).toBe("returned"));
    expect(exposed).not.toContain("initial");
    expect(first.result.current.data?.selection.id).toBe("restarted");
    expect(second.result.current.data?.selection.id).toBe("initial");
  });

  it("does not make a retired capture reusable when a pinned peer refetches after restart", async () => {
    const wrapper = sharedQueries();
    const first = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    const second = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => first.result.current.restart());
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("restarted"));
    act(() => second.result.current.retry());
    await waitFor(() => expect(second.result.current.data?.selection.id).toBe("initial"));
    first.unmount();
    second.unmount();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("returned"));
    const returned = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    expect(returned.result.current.data).toBeUndefined();
    await waitFor(() => expect(returned.result.current.data?.selection.id).toBe("returned"));
  });

  it("retains at most four inactive cohort pages and never retains details", async () => {
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    for (let index = 0; index < 7; index++) {
      const hook = renderHook(() => useReportPage<string>("copilot-usage/users", { search: String(index) }), { wrapper });
      await waitFor(() => expect(hook.result.current.data).toBeDefined());
      hook.unmount();
    }
    expect(client.getQueryCache().getAll().filter(query => query.meta?.retainReportPage)).toHaveLength(4);
    const detail = renderHook(() => useReportPage<string>("copilot-usage/users/user/agents", { selectionId: "initial" }), { wrapper });
    await waitFor(() => expect(detail.result.current.data).toBeDefined());
    detail.unmount();
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(4));
  });

  it("does not evict a newly admitted query while switching through more than four filters", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => page(query?.search ?? "initial"));
    const { result, rerender } = renderHook(({ search }) => useReportPage<string>("copilot-usage/users", { search }),
      { wrapper: sharedQueries(), initialProps: { search: "0" } });
    for (let index = 0; index < 8; index++) {
      rerender({ search: String(index) });
      await waitFor(() => expect(result.current.data?.selection.id).toBe(String(index)));
      expect(result.current.loading).toBe(false);
    }
    expect(api.readReportPage).toHaveBeenCalledTimes(8);
  });

  it("keeps a revisited cached page attached when switching at the inactive-page limit", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async (_path, query) => page(query?.search ?? "initial"));
    const wrapper = sharedQueries(), client = clients.at(-1)!;
    const hook = renderHook(({ search }) => useReportPage<string>("copilot-usage/users", { search }),
      { wrapper, initialProps: { search: "0" } });
    for (let index = 0; index < 5; index++) {
      hook.rerender({ search: String(index) });
      await waitFor(() => expect(hook.result.current.data?.selection.id).toBe(String(index)));
    }
    for (const search of ["0", "4", "1", "3", "2"]) {
      hook.rerender({ search });
      expect(hook.result.current.data?.selection.id).toBe(search);
      expect(hook.result.current.loading).toBe(false);
      const active = client.getQueryCache().getAll().find(query => query.state.data === hook.result.current.data);
      expect(active?.getObserversCount()).toBe(1);
      expect(client.getQueryCache().getAll().filter(query => query.getObserversCount() === 0)).toHaveLength(4);
      const peer = renderHook(() => useReportPage<string>("copilot-usage/users", { search }), { wrapper });
      expect(peer.result.current.data).toBe(hook.result.current.data);
      expect(active?.getObserversCount()).toBe(2);
      peer.unmount();
    }
    expect(api.readReportPage).toHaveBeenCalledTimes(5);
    hook.unmount();
    expect(client.getQueryCache().getAll()).toHaveLength(4);
    expect(client.getQueryCache().getAll().every(query => query.getObserversCount() === 0)).toBe(true);
  });

  it("exposes invalidation without replay and captures a replacement only on explicit restart", async () => {
    const pending = deferred<ReturnType<typeof page>>(), errors: unknown[] = [];
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => {
      const read = useReportPage("copilot-usage/users");
      if (read.error) errors.push(read.error);
      return read;
    });
    expect(result.current.selectionRevision).toBe(0);
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(errors).toContain(invalidated);
    act(() => result.current.restart());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    const selectionRevision = result.current.selectionRevision;
    expect(selectionRevision).toBe(1);
    await act(async () => pending.resolve(page("replacement")));
    await waitFor(() => expect(result.current.data?.selection.id).toBe("replacement"));
    expect(result.current.selectionRevision).toBe(selectionRevision);
  });
  it.each(["manual", "rejected"] as const)("does not reuse another observer's cached selection on %s explicit restart", async kind => {
    const replacement = deferred<ReturnType<typeof page>>();
    const { result } = renderHook(() => ({
      first: useReportPage<string>("official-usage/history"),
      second: useReportPage<string>("official-usage/history"),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("initial"));
    expect(result.current.first.data?.selection.id).toBe("initial");
    expect(api.readReportPage).toHaveBeenCalledOnce();

    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("first-restart"));
    act(() => result.current.first.restart());
    await waitFor(() => expect(result.current.first.data?.selection.id).toBe("first-restart"));
    expect(result.current.second.data?.selection.id).toBe("initial");

    if (kind === "rejected") {
      vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
      act(() => result.current.second.next());
      await waitFor(() => expect(result.current.second.invalidated).toBe(true));
    }
    vi.mocked(api.readReportPage).mockReturnValueOnce(replacement.promise);
    act(() => result.current.second.restart());
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(kind === "manual" ? 3 : 4));
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.second.loading).toBe(true);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ limit: 50 });
    await act(async () => replacement.resolve(page("second-restart")));
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("second-restart"));
    expect(result.current.first.data?.selection.id).toBe("first-restart");
  });

  it("captures fresh evidence when returning to a filter still cached by another observer", async () => {
    const replacement = deferred<ReturnType<typeof page>>();
    const { result, rerender } = renderHook(({ search }) => ({
      first: useReportPage<string>("official-usage/history", { search: undefined }),
      second: useReportPage<string>("official-usage/history", { search: search || undefined }),
    }), { wrapper: sharedQueries(), initialProps: { search: "" } });
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("initial"));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("filtered")).mockReturnValueOnce(replacement.promise);
    rerender({ search: "changed" });
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("filtered"));
    rerender({ search: "" });
    expect(result.current.second.data).toBeUndefined();
    expect(result.current.second.loading).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ search: undefined, limit: 50 });
    await act(async () => replacement.resolve(page("returned")));
    await waitFor(() => expect(result.current.second.data?.selection.id).toBe("returned"));
    expect(result.current.first.data?.selection.id).toBe("initial");
  });

  it("requires explicit replacement on each rejected filter visit", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("recovered"))
      .mockResolvedValueOnce(page("filtered")).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("returned"));
    const { result, rerender } = renderHook(({ search }) =>
      useReportPage<string>("official-usage/history", { search }), { initialProps: { search: "" } });
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("recovered"));
    rerender({ search: "changed" });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("filtered"));
    rerender({ search: "" });
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(4);
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("returned"));
    expect(api.readReportPage).toHaveBeenCalledTimes(5);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ search: "", limit: 50 });
  });

  it("stops persistent invalidation at one read and allows an explicit restart", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(invalidated);
    const { result } = renderHook(() => useReportPage("official-usage/history"));
    await waitFor(() => {
      expect(result.current.invalidated).toBe(true);
      expect(result.current.loading).toBe(false);
    });
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(result.current.data).toBeUndefined();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("manual"));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("manual"));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ limit: 50 });
  });

  it("never replays rejected paging or replacement reads", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("recovered"));
    const { result } = renderHook(() => useReportPage("official-usage/history"));
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("recovered"));
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
    act(() => result.current.next());
    await waitFor(() => {
      expect(result.current.invalidated).toBe(true);
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.data).toBeUndefined();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ limit: 50, selectionId: "recovered", cursor: "next" });
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("manual"));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(4);
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("manual"));
    expect(api.readReportPage).toHaveBeenCalledTimes(5);
    for (const call of vi.mocked(api.readReportPage).mock.calls.slice(3)) expect(call[1]).toEqual({ limit: 50 });
  });

  it("leaves an invalidated explicit selection pinned and delegates restart to its parent", async () => {
    const restartParent = vi.fn();
    vi.mocked(api.readReportPage).mockRejectedValue(invalidated);
    const { result } = renderHook(() =>
      useReportPage("official-usage/history/set/observations", { selectionId: "parent" }, 0, true, restartParent));
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(result.current.data).toBeUndefined();
    act(() => result.current.restart());
    expect(restartParent).toHaveBeenCalledOnce();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
});
