import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useQueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSavedQueryClient, readSavedQuery, useSavedQuery } from "../savedQueries";
import { deferred } from "../test/deferred";
import { SavedQueryProvider } from "./SavedQueryProvider";

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function createClient() {
  const client = createSavedQueryClient();
  clients.push(client);
  return client;
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
});

function Reader({ read }: { read: (signal: AbortSignal) => Promise<string> }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState(false);
  const query = useSavedQuery({
    queryKey: ["saved", "private-data"],
    queryFn: ({ signal }) => read(signal),
    staleTime: Infinity,
  });
  return <>
    <p>{query.isFetching ? "Loading saved data" : query.isError ? query.error.message : query.data}</p>
    <button onClick={() => setSelected(true)}>{selected ? "Selected" : "Select"}</button>
    <button onClick={() => void query.refetch({ cancelRefetch: false })}>Retry</button>
    <button onClick={() => void client.invalidateQueries({ queryKey: ["saved", "private-data"] })}>Invalidate</button>
  </>;
}

describe("saved query provider ownership", () => {
  it("replaces observers and local state with the supplied client without clearing borrowed caches", async () => {
    const first = createClient();
    const second = createClient();
    first.setQueryData(["saved", "private-data"], "First account");
    second.setQueryData(["saved", "private-data"], "Second account");
    const clearFirst = vi.spyOn(first, "clear");
    const clearSecond = vi.spyOn(second, "clear");
    const read = vi.fn().mockResolvedValue("Updated second account");
    const view = render(<SavedQueryProvider client={first}><Reader read={read} /></SavedQueryProvider>);
    expect(screen.getByText("First account")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    view.rerender(<SavedQueryProvider client={second}><Reader read={read} /></SavedQueryProvider>);
    expect(screen.queryByText("First account")).not.toBeInTheDocument();
    expect(screen.getByText("Second account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Invalidate" }));
    await screen.findByText("Updated second account");
    expect(second.getQueryData(["saved", "private-data"])).toBe("Updated second account");
    expect(read).toHaveBeenCalledOnce();
    view.unmount();
    expect(clearFirst).not.toHaveBeenCalled();
    expect(clearSecond).not.toHaveBeenCalled();
  });

  it.each([false, true])("retires the replaced observer and preserves remaining readers (peer: %s)", async withPeer => {
    const first = createClient();
    const second = createClient();
    const pending = deferred<string>();
    let requestSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return pending.promise;
    });
    const peer = withPeer ? readSavedQuery(first, ["private-data"], read, new AbortController().signal)
      .then(value => ({ value }), (error: unknown) => ({ error })) : undefined;
    const view = render(<SavedQueryProvider client={first}><Reader read={read} /></SavedQueryProvider>);
    second.setQueryData(["saved", "private-data"], "Second account");
    view.rerender(<SavedQueryProvider client={second}><Reader read={read} /></SavedQueryProvider>);
    expect(screen.getByText("Second account")).toBeInTheDocument();
    expect(requestSignal.aborted).toBe(!withPeer);
    await act(async () => {
      pending.resolve("First account");
      if (peer) await expect(peer).resolves.toEqual({ value: "First account" });
    });
    expect(screen.queryByText("First account")).not.toBeInTheDocument();
    expect(screen.getByText("Second account")).toBeInTheDocument();
    expect(read).toHaveBeenCalledOnce();
  });

  it("creates a fresh reader when returning A-B-A and ignores the abandoned A response", async () => {
    const first = createClient(), second = createClient();
    second.setQueryDefaults(["saved", "private-data"], { gcTime: 60_000 });
    second.setQueryData(["saved", "private-data"], "Second account");
    const abandoned = deferred<string>(), replacement = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? abandoned.promise : replacement.promise;
    });
    const view = render(<SavedQueryProvider client={first}><Reader read={read} /></SavedQueryProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    view.rerender(<SavedQueryProvider client={second}><Reader read={read} /></SavedQueryProvider>);
    expect(signals[0].aborted).toBe(true);
    expect(screen.getByText("Second account")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    view.rerender(<SavedQueryProvider client={first}><Reader read={read} /></SavedQueryProvider>);
    expect(screen.getByRole("button", { name: "Select" })).toBeInTheDocument();
    expect(screen.getByText("Loading saved data")).toBeInTheDocument();
    expect(screen.queryByText("Second account")).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => abandoned.resolve("Obsolete first account"));
    expect(screen.queryByText("Obsolete first account")).not.toBeInTheDocument();
    expect(screen.getByText("Loading saved data")).toBeInTheDocument();
    expect(signals[1].aborted).toBe(false);
    await act(async () => replacement.resolve("Current first account"));
    await screen.findByText("Current first account");
    expect(first.getQueryData(["saved", "private-data"])).toBe("Current first account");
    expect(second.getQueryData(["saved", "private-data"])).toBe("Second account");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not clear a borrowed client when replacing it with an owned scope", async () => {
    const borrowed = createClient();
    borrowed.setQueryData(["saved", "private-data"], "Borrowed account");
    const clearBorrowed = vi.spyOn(borrowed, "clear");
    const read = vi.fn().mockResolvedValue("Owned account");
    const view = render(<SavedQueryProvider client={borrowed}><Reader read={read} /></SavedQueryProvider>);
    expect(screen.getByText("Borrowed account")).toBeInTheDocument();
    view.rerender(<SavedQueryProvider><Reader read={read} /></SavedQueryProvider>);
    expect(screen.queryByText("Borrowed account")).not.toBeInTheDocument();
    await screen.findByText("Owned account");
    view.unmount();
    expect(clearBorrowed).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it("clears an owned client when replaced and creates a fresh one when ownership returns", async () => {
    const borrowed = createClient();
    borrowed.setQueryData(["saved", "private-data"], "Borrowed account");
    const owned: ReturnType<typeof createSavedQueryClient>[] = [];
    function Capture() {
      const client = useQueryClient();
      if (!owned.includes(client)) owned.push(client);
      return null;
    }
    const pending = deferred<string>();
    let requestSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return pending.promise;
    });
    const view = render(<SavedQueryProvider><Capture /><Reader read={read} /></SavedQueryProvider>);
    const first = owned[0];
    first.setQueryData(["retained-private-data"], "Private snapshot");
    const clearing = vi.spyOn(first, "clear");
    view.rerender(<SavedQueryProvider client={borrowed}><Capture /><Reader read={read} /></SavedQueryProvider>);
    expect(screen.getByText("Borrowed account")).toBeInTheDocument();
    expect(requestSignal.aborted).toBe(true);
    expect(clearing).toHaveBeenCalledOnce();
    expect(first.getQueryCache().getAll()).toHaveLength(0);
    await act(async () => pending.resolve("Obsolete private data"));
    expect(first.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByText("Obsolete private data")).not.toBeInTheDocument();

    const replacement = deferred<string>();
    read.mockImplementation(() => replacement.promise);
    view.rerender(<SavedQueryProvider><Capture /><Reader read={read} /></SavedQueryProvider>);
    expect(owned).toHaveLength(3);
    expect(owned[2]).not.toBe(first);
    expect(owned[2]).not.toBe(borrowed);
    expect(screen.getByText("Loading saved data")).toBeInTheDocument();
    expect(screen.queryByText("Borrowed account")).not.toBeInTheDocument();
    await act(async () => replacement.resolve("New owned account"));
    await screen.findByText("New owned account");
    view.unmount();
    expect(owned[2].getQueryCache().getAll()).toHaveLength(0);
  });

  it.each([false, true])("preserves an unchanged client and local state on rerender (borrowed: %s)", async borrowed => {
    const client = borrowed ? createClient() : undefined;
    const read = vi.fn().mockResolvedValue("Current account");
    const content = () => <SavedQueryProvider client={client}><Reader read={read} /></SavedQueryProvider>;
    const view = render(content());
    await screen.findByText("Current account");
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    view.rerender(content());
    expect(screen.getByRole("button", { name: "Selected" })).toBeInTheDocument();
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
  });
});
