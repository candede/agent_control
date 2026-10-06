import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api/reportData";
import { ApiError } from "./api/client";
import { createSavedQueryClient } from "./savedQueries";
import { deferred } from "./test/deferred";
import { reportPage } from "./test/reportDataFixture";
import { useReportPage } from "./useReportPage";

vi.mock("./api/reportData", async original => ({
  ...await original<typeof import("./api/reportData")>(), readReportPage: vi.fn(),
}));

function page(id: string) {
  const result = reportPage([id]);
  return { ...result, selection: { ...result.selection, id },
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
  it("renews an expired displayed selection without waiting for a focus or navigation event", async () => {
    vi.useFakeTimers();
    const initial = page("initial"), replacement = deferred<ReturnType<typeof page>>();
    initial.selection.expiresAt = new Date(Date.now() + 1000).toISOString();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(initial).mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper: sharedQueries() });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.selection.id).toBe("initial");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBeNull();
    await act(async () => { replacement.resolve(page("replacement")); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.selection.id).toBe("replacement");
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
    vi.spyOn(Date, "now").mockReturnValue(now + (boundary === "ttl" ? 31_000 : boundary === "expiry" ? 21_000 : 0));
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

  it.each(["manual", "automatic"] as const)("retires standalone cached evidence across filter visits after %s restart", async kind => {
    const { result, rerender } = renderHook(({ search }) =>
      useReportPage<string>("copilot-usage/users", { search }), { initialProps: { search: "" } });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("initial"));
    if (kind === "automatic") vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => kind === "manual" ? result.current.restart() : result.current.next());
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
    expect(api.readReportPage).toHaveBeenCalledTimes(field === "selectionId" ? 1 : 2);
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

  it.each(["manual", "automatic"] as const)("does not revive a cache entry when a pending read settles after %s restart", async kind => {
    const wrapper = sharedQueries(), pending = deferred<ReturnType<typeof page>>();
    const first = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    const second = renderHook(() => useReportPage<string>("copilot-usage/users"), { wrapper });
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("initial"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    act(() => second.result.current.retry());
    const pendingSignal = vi.mocked(api.readReportPage).mock.calls.at(-1)?.[2];
    if (kind === "automatic") vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("restarted"));
    act(() => kind === "manual" ? first.result.current.restart() : first.result.current.next());
    await waitFor(() => expect(first.result.current.data?.selection.id).toBe("restarted"));
    expect(pendingSignal?.aborted).toBe(false);
    await act(async () => pending.resolve(page("initial")));
    await waitFor(() => expect(second.result.current.data?.selection.id).toBe("initial"));
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
    const returned = renderHook(() => {
      const read = useReportPage<string>("copilot-usage/users");
      if (read.data) exposed.push(read.data.selection.id);
      return read;
    }, { wrapper });
    expect(returned.result.current.data).toBeUndefined();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("returned"));
    await act(async () => pending.resolve(page("initial")));
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

  it("does not expose a recoverable invalidation as an error while capturing its replacement", async () => {
    const pending = deferred<ReturnType<typeof page>>(), errors: unknown[] = [];
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => {
      const read = useReportPage("copilot-usage/users");
      if (read.error) errors.push(read.error);
      return read;
    });
    expect(result.current.recoveryRevision).toBe(-1);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(errors).toEqual([]);
    expect(result.current.loading).toBe(true);
    const recoveryRevision = result.current.recoveryRevision;
    expect(recoveryRevision).toBeGreaterThan(-1);
    await act(async () => pending.resolve(page("replacement")));
    await waitFor(() => expect(result.current.data?.selection.id).toBe("replacement"));
    expect(result.current.recoveryRevision).toBe(recoveryRevision);
  });
  it.each(["manual", "automatic"] as const)("does not reuse another observer's cached selection on %s restart", async kind => {
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

    if (kind === "automatic") vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated);
    vi.mocked(api.readReportPage).mockReturnValueOnce(replacement.promise);
    act(() => kind === "manual" ? result.current.second.restart() : result.current.second.next());
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

  it("gives a new filter visit its own bounded automatic recovery attempt", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("recovered"))
      .mockResolvedValueOnce(page("filtered")).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("returned"));
    const { result, rerender } = renderHook(({ search }) =>
      useReportPage<string>("official-usage/history", { search }), { initialProps: { search: "" } });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("recovered"));
    rerender({ search: "changed" });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("filtered"));
    rerender({ search: "" });
    await waitFor(() => expect(result.current.data?.selection.id).toBe("returned"));
    expect(api.readReportPage).toHaveBeenCalledTimes(5);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ search: "", limit: 50 });
  });

  it("stops persistent invalidation after one automatic recovery and allows an explicit restart", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(invalidated);
    const { result } = renderHook(() => useReportPage("official-usage/history"));
    await waitFor(() => {
      expect(result.current.invalidated).toBe(true);
      expect(result.current.loading).toBe(false);
    });
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBeUndefined();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page("manual"));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data?.selection.id).toBe("manual"));
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]).toEqual({ limit: 50 });
  });

  it("does not renew automatic recovery by paging, but does renew it on explicit restart", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(invalidated).mockResolvedValueOnce(page("recovered"));
    const { result } = renderHook(() => useReportPage("official-usage/history"));
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
