import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundRefreshIndicator } from "./BackgroundRefreshIndicator";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";
import { deferred } from "../test/deferred";

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function createClient() {
  const client = createSavedQueryClient();
  clients.push(client);
  return client;
}

function indicator(active = true, client?: ReturnType<typeof createSavedQueryClient>) {
  return <SavedQueryProvider client={client}><BackgroundRefreshIndicator active={active} /></SavedQueryProvider>;
}

describe("background refresh indicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    clients.splice(0).forEach(client => client.clear());
    vi.useRealTimers();
  });

  it("only announces work lasting at least half a second and disappears when it finishes", () => {
    const view = render(indicator());
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    const status = screen.getByRole("status", { name: "Background refresh" });
    expect(status.textContent).toBe("");
    expect(status.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(status.childElementCount).toBe(1);
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).not.toHaveAttribute("tabindex");
    view.rerender(indicator(false));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["success", "failure", "cancelled"] as const)("removes the icon when the final saved read finishes with %s", async outcome => {
    const client = createClient();
    const controller = new AbortController();
    const pending = deferred<string>();
    const failure = new Error("Saved read failed");
    const reader = vi.fn(() => pending.promise);
    render(indicator(false, client));
    const read = readSavedQuery(client, ["copilot-usage-users"], reader, controller.signal)
      .then(data => ({ data }), (error: unknown) => ({ error }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    await act(async () => {
      if (outcome === "cancelled") controller.abort();
      else if (outcome === "failure") pending.reject(failure);
      else pending.resolve("saved users");
      expect(await read).toEqual(outcome === "success" ? { data: "saved users" }
        : { error: outcome === "failure" ? failure : expect.objectContaining({ kind: "aborted" }) });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    expect(reader).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve("late saved users");
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByRole("status", { name: "Background refresh" })).not.toBeInTheDocument();
    expect(client.isFetching()).toBe(0);
  });

  it("restarts the delay after short work or completed activity rather than flashing the next request", () => {
    const view = render(indicator());
    act(() => vi.advanceTimersByTime(250));
    view.rerender(indicator(false));
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(indicator());
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    view.rerender(indicator(false));
    view.rerender(indicator());
    act(() => vi.advanceTimersByTime(499));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
  });

  it("keeps one indicator through overlapping browser activity and saved reads until the final owner finishes", async () => {
    const client = createClient();
    const first = deferred<string>();
    const second = deferred<string>();
    const view = render(indicator(true, client));
    act(() => vi.advanceTimersByTime(250));
    const firstRead = readSavedQuery(client, ["source-job", "first"], () => first.promise, new AbortController().signal);
    const secondRead = readSavedQuery(client, ["source-job", "second"], () => second.promise, new AbortController().signal);
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.rerender(indicator(false, client));
    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    const status = screen.getByRole("status", { name: "Background refresh" });
    expect(status).toBeVisible();
    await act(async () => {
      first.resolve("first source job");
      await expect(firstRead).resolves.toBe("first source job");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status", { name: "Background refresh" })).toBe(status);
    view.rerender(indicator(true, client));
    await act(async () => {
      second.resolve("second source job");
      await expect(secondRead).resolves.toBe("second source job");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("status", { name: "Background refresh" })).toBe(status);
    view.rerender(indicator(false, client));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shares duplicate reads and keeps activity after one caller cancels without refetching on focus or rerender", async () => {
    const client = createClient();
    const pending = deferred<string>();
    const reader = vi.fn<(signal: AbortSignal) => Promise<string>>(() => pending.promise);
    const first = new AbortController();
    const second = new AbortController();
    const view = render(indicator(false, client));
    const firstRead = readSavedQuery(client, ["source-job", "same-job"], reader, first.signal);
    const secondRead = readSavedQuery(client, ["source-job", "same-job"], reader, second.signal);
    const cancelled = expect(firstRead).rejects.toMatchObject({ kind: "aborted" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(500));
    const status = screen.getByRole("status", { name: "Background refresh" });
    await act(async () => {
      first.abort();
      await cancelled;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reader.mock.calls[0][0].aborted).toBe(false);
    expect(screen.getByRole("status", { name: "Background refresh" })).toBe(status);
    view.rerender(indicator(false, client));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    expect(reader).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve("current source job");
      await expect(secondRead).resolves.toBe("current source job");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(reader).toHaveBeenCalledOnce();
  });

  it.each(["remove", "clear"] as const)("retires activity on cache %s and ignores an obsolete response while a replacement is pending", async retirement => {
    const client = createClient();
    const obsolete = deferred<string>();
    const replacement = deferred<string>();
    const oldReader = vi.fn<(signal: AbortSignal) => Promise<string>>(() => obsolete.promise);
    const currentReader = vi.fn(() => replacement.promise);
    render(indicator(false, client));
    const oldRead = readSavedQuery(client, ["source-job"], oldReader, new AbortController().signal);
    const cancelled = expect(oldRead).rejects.toMatchObject({ kind: "aborted" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    await act(async () => {
      if (retirement === "remove") client.removeQueries({ queryKey: ["saved", "source-job"], exact: true });
      else client.clear();
      await cancelled;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(oldReader.mock.calls[0][0].aborted).toBe(true);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const currentRead = readSavedQuery(client, ["source-job"], currentReader, new AbortController().signal);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    await act(async () => {
      obsolete.resolve("old account source job");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.getQueryData(["saved", "source-job"])).toBeUndefined();
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    await act(async () => {
      replacement.resolve("new account source job");
      await expect(currentRead).resolves.toBe("new account source job");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(oldReader).toHaveBeenCalledOnce();
    expect(currentReader).toHaveBeenCalledOnce();
  });

  it("does not treat retained source-job data, invalidation or unrelated queries as active saved work", async () => {
    const client = createClient();
    client.setQueryDefaults(["saved", "source-job"], { gcTime: Infinity });
    client.setQueryData(["saved", "source-job"], { status: "running" });
    const pending = deferred<string>();
    const reader = vi.fn(() => pending.promise);
    const unrelated = client.fetchQuery({ queryKey: ["unrelated"], queryFn: reader });
    render(indicator(false, client));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["saved"] });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(client.isFetching()).toBe(1);
    expect(client.getQueryData(["saved", "source-job"])).toEqual({ status: "running" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve("unrelated result");
      await expect(unrelated).resolves.toBe("unrelated result");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(reader).toHaveBeenCalledOnce();
  });

  it("shows only the fresh explicit retry after a failed read, without silently retrying or retaining activity", async () => {
    const client = createClient();
    const failure = new Error("Source status unavailable");
    const pending = deferred<string>();
    const reader = vi.fn().mockRejectedValueOnce(failure).mockReturnValueOnce(pending.promise);
    render(indicator(false, client));
    await act(async () => {
      await expect(readSavedQuery(client, ["source-job"], reader, new AbortController().signal)).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(reader).toHaveBeenCalledOnce();
    const retry = readSavedQuery(client, ["source-job"], reader, new AbortController().signal);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
    await act(async () => {
      pending.resolve("recovered source job");
      await expect(retry).resolves.toBe("recovered source job");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("does not flash for short requests or leave a pending timer after unmount", () => {
    const view = render(indicator());
    act(() => vi.advanceTimersByTime(250));
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    render(indicator());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByRole("status", { name: "Background refresh" })).toBeVisible();
  });
});
