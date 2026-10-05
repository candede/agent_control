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
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });

describe("report page selection lifetimes", () => {
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
