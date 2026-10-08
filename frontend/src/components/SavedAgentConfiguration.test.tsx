import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { SavedAgentChannels, SavedAgentConnectors } from "./SavedAgentConfiguration";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getInventoryChildren: vi.fn(),
}));

const props = { selectionId: "selected", recordId: "agent:canonical",
  source: { scopeId: "source-scope", identity: "native-agent" } };
type Page = Awaited<ReturnType<typeof api.getInventoryChildren>>;
type Section = "channels" | "connectors" | "operations";
const kindFor = (section: Section) => section === "operations" ? "connectorOperation" : `detail:${section}`;
const labelFor = (section: Section) => section === "channels" ? "First channel"
  : section === "connectors" ? "First connector" : "First operation";
function page(kind: string, name = "First"): Page {
  return { value: [{ ordinal: 0, kind, value: kind === "detail:channels" ? `${name} channel` : "0",
    payload: kind === "detail:connectors" ? { connectorId: `${name} connector`, operations: [] }
      : kind === "connectorOperation" ? { operationId: `${name} operation` } : {} }],
  total: 20, nextCursor: `next-${kind}` };
}
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function client() {
  const queries = createSavedQueryClient();
  clients.push(queries);
  return queries;
}
beforeEach(() => {
  vi.mocked(api.getInventoryChildren).mockImplementation(async (_selection, _record, _source, kind) => page(kind));
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(queries => queries.clear());
  vi.resetAllMocks();
});

describe("saved configuration ownership and action admission", () => {
  it.each(["channels", "connectors", "operations"] as const)(
    "does not leave a %s page when revalidation starts before React renders", async section => {
      const queries = client(), pending = deferred<Page>();
      const kind = kindFor(section);
      render(<QueryClientProvider client={queries}>{section === "channels"
        ? <SavedAgentChannels {...props} /> : <SavedAgentConnectors {...props} />}</QueryClientProvider>);
      await screen.findByText(labelFor(section));
      if (section !== "channels") await screen.findByText("First operation");
      const calls = vi.mocked(api.getInventoryChildren).mock.calls.length;
      vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
      const next = screen.getByRole("button", { name: `Next ${section}` });
      next.focus();
      let signal: AbortSignal | undefined;
      act(() => {
        void queries.invalidateQueries({ predicate: query => query.queryKey[6] === kind });
        signal = vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
        fireEvent.click(next);
      });
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(calls + 1);
      expect(signal?.aborted).toBe(false);
      expect(next).toHaveFocus();
      await waitFor(() => expect(next).toHaveAttribute("aria-disabled", "true"));
      expect(screen.queryByText(labelFor(section))).not.toBeInTheDocument();
      await act(async () => pending.resolve(page(kind, "Current")));
      expect(await screen.findByText(section === "operations" ? "Current operation"
        : section === "connectors" ? "Current connector" : "Current channel")).toBeVisible();
      expect(screen.getByRole("button", { name: `Previous ${section}` })).toHaveAttribute("aria-disabled", "true");
    });

  it.each(["channels", "connectors", "operations"] as const)(
    "does not follow a superseded %s cursor before the cache notification renders", async section => {
      const queries = client();
      const kind = kindFor(section);
      render(<QueryClientProvider client={queries}>{section === "channels"
        ? <SavedAgentChannels {...props} /> : <SavedAgentConnectors {...props} />}</QueryClientProvider>);
      await screen.findByText(labelFor(section));
      if (section !== "channels") await screen.findByText("First operation");
      const calls = vi.mocked(api.getInventoryChildren).mock.calls.length;
      const key = queries.getQueryCache().findAll().find(query => query.queryKey[6] === kind)!.queryKey;
      const next = screen.getByRole("button", { name: `Next ${section}` });
      act(() => {
        queries.setQueryData(key, { ...page(kind, "Current"), nextCursor: "current-cursor" });
        fireEvent.click(next);
      });
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(calls);
      expect(await screen.findByText(section === "operations" ? "Current operation"
        : section === "connectors" ? "Current connector" : "Current channel")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: `Next ${section}` }));
      expect(api.getInventoryChildren).toHaveBeenLastCalledWith(props.selectionId, props.recordId,
        expect.anything(), kind, "current-cursor", expect.anything());
    });

  it.each(["channels", "connectors"] as const)(
    "shares settled %s with a later observer without reloading or cancelling child reads", async section => {
      const queries = client(), operations = deferred<Page>();
      vi.mocked(api.getInventoryChildren).mockImplementation(async (_s, _r, _m, kind) =>
        kind === "connectorOperation" ? operations.promise : page(kind));
      const panel = (key: string) => section === "channels"
        ? <section key={key} aria-label={key}><SavedAgentChannels {...props} source={{ ...props.source }} /></section>
        : <SavedAgentConnectors key={key} {...props} source={{ ...props.source }} />;
      const view = render(<QueryClientProvider client={queries}>{panel("left")}</QueryClientProvider>);
      await screen.findByText(labelFor(section));
      const calls = vi.mocked(api.getInventoryChildren).mock.calls.length;
      const signal = vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
      view.rerender(<QueryClientProvider client={queries}>{panel("left")}{panel("right")}</QueryClientProvider>);
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(calls);
      expect(screen.getAllByText(labelFor(section))).toHaveLength(2);
      expect(signal?.aborted).toBe(false);
      await act(async () => operations.resolve(page("connectorOperation")));
      if (section === "connectors") expect(await screen.findAllByText("First operation")).toHaveLength(2);
      view.rerender(<QueryClientProvider client={queries}>{panel("right")}</QueryClientProvider>);
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(calls);
      expect(screen.getByText(labelFor(section))).toBeVisible();
    });

  it.each(["channels", "connectors", "operations"] as const)(
    "retires %s after selection rejection, including later invalidations and observers", async section => {
      const queries = client(), invalidated = vi.fn();
      const kind = kindFor(section);
      const panel = (key: string, selectionId = props.selectionId) => section === "channels"
        ? <SavedAgentChannels key={key} {...props} selectionId={selectionId} onInvalidated={invalidated} />
        : <SavedAgentConnectors key={key} {...props} selectionId={selectionId} onInvalidated={invalidated} />;
      const view = render(<QueryClientProvider client={queries}>{panel("left")}</QueryClientProvider>);
      await screen.findByText(labelFor(section));
      if (section !== "channels") await screen.findByText("First operation");
      vi.mocked(api.getInventoryChildren).mockRejectedValueOnce(new api.ApiError(409, "selection_invalidated", "Selection expired"));
      await act(async () => { await queries.invalidateQueries({ predicate: query => query.queryKey[6] === kind }); });
      expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory");
      expect(screen.queryByText(labelFor(section))).not.toBeInTheDocument();
      expect(invalidated).toHaveBeenCalledOnce();
      const calls = vi.mocked(api.getInventoryChildren).mock.calls.length;
      await act(async () => { await queries.invalidateQueries(); });
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(calls);
      view.rerender(<QueryClientProvider client={queries}>{panel("left")}{panel("right")}</QueryClientProvider>);
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(calls);
      expect(screen.queryByText("First connector")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry|Next|Previous/ })).not.toBeInTheDocument();
      view.rerender(<QueryClientProvider client={queries}>{panel("left", "replacement")}</QueryClientProvider>);
      expect(await screen.findByText(labelFor(section))).toBeVisible();
    });

  it("keeps Previous on its current page when revalidation starts before the click renders", async () => {
    const queries = client(), pending = deferred<Page>();
    render(<QueryClientProvider client={queries}><SavedAgentChannels {...props} /></QueryClientProvider>);
    await screen.findByText("First channel");
    fireEvent.click(screen.getByRole("button", { name: "Next channels" }));
    await screen.findByText("First channel");
    vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
    act(() => {
      void queries.invalidateQueries();
      fireEvent.click(screen.getByRole("button", { name: "Previous channels" }));
    });
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(page("detail:channels", "Current")));
    expect(await screen.findByText("Current channel")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous channels" })).toHaveAttribute("aria-disabled", "false");
  });

  it("does not let a queued retry replace selection rejection before React renders it", async () => {
    const queries = client(), invalidated = vi.fn();
    vi.mocked(api.getInventoryChildren).mockRejectedValueOnce(new Error("Read unavailable"));
    render(<QueryClientProvider client={queries}><SavedAgentChannels {...props} onInvalidated={invalidated} /></QueryClientProvider>);
    const retry = await screen.findByRole("button", { name: "Retry configuration" });
    const cached = queries.getQueryCache().findAll()[0];
    act(() => {
      cached.setState({ error: new api.ApiError(409, "selection_invalidated", "Selection expired"), status: "error" });
      fireEvent.click(retry);
    });
    expect(api.getInventoryChildren).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory");
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it("retires standalone connectors when an operation invalidates their selection", async () => {
    const invalidated = vi.fn();
    vi.mocked(api.getInventoryChildren).mockResolvedValueOnce(page("detail:connectors"))
      .mockRejectedValueOnce(new api.ApiError(409, "selection_invalidated", "Operation selection expired"));
    render(<SavedAgentConnectors {...props} onInvalidated={invalidated} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory");
    await waitFor(() => expect(screen.queryByText("First connector")).not.toBeInTheDocument());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(invalidated).toHaveBeenCalledOnce();
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(2);
  });

  it("cancels sibling configuration reads after operation rejection without retiring another selection", async () => {
    const queries = client(), rejected = deferred<Page>(), sibling = deferred<Page>(), channels = deferred<Page>();
    const connectorInvalidated = vi.fn(), channelInvalidated = vi.fn(), otherInvalidated = vi.fn();
    vi.mocked(api.getInventoryChildren).mockImplementation(async (selection, _record, _source, kind, _cursor, options) => {
      if (selection === "other-selection") return page(kind, "Other");
      if (kind === "detail:channels") return channels.promise;
      if (kind === "detail:connectors") return { ...page(kind),
        value: [...page(kind).value, { ...page(kind, "Sibling").value[0], ordinal: 1, value: "1" }] };
      return options?.value === "0" ? rejected.promise : sibling.promise;
    });
    render(<QueryClientProvider client={queries}>
      <SavedAgentConnectors {...props} onInvalidated={connectorInvalidated} />
      <section><SavedAgentChannels {...props} onInvalidated={channelInvalidated} /></section>
      <section><SavedAgentChannels {...props} selectionId="other-selection" onInvalidated={otherInvalidated} /></section>
    </QueryClientProvider>);
    await screen.findByText("Sibling connector");
    await screen.findByText("Other channel");
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledTimes(5));
    const signalFor = (kind: string, value?: string) => vi.mocked(api.getInventoryChildren).mock.calls
      .find(call => call[0] === props.selectionId && call[3] === kind && call[5]?.value === value)?.[5]?.signal;
    const channelSignal = signalFor("detail:channels"), siblingSignal = signalFor("connectorOperation", "1");
    await act(async () => rejected.reject(new api.ApiError(409, "selection_invalidated", "Operation selection expired")));
    await waitFor(() => expect(screen.queryByText("Sibling connector")).not.toBeInTheDocument());
    expect(channelSignal?.aborted).toBe(true);
    expect(siblingSignal?.aborted).toBe(true);
    expect(screen.queryByText("First connector")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Other channel")).toBeVisible();
    expect(connectorInvalidated).toHaveBeenCalledOnce();
    expect(channelInvalidated).toHaveBeenCalledOnce();
    expect(otherInvalidated).not.toHaveBeenCalled();
    await act(async () => {
      channels.resolve(page("detail:channels", "Retired"));
      sibling.reject(new api.ApiError(409, "selection_invalidated", "Abandoned operation"));
    });
    expect(screen.queryByText("Retired channel")).not.toBeInTheDocument();
    expect(connectorInvalidated).toHaveBeenCalledOnce();
    expect(channelInvalidated).toHaveBeenCalledOnce();
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(5);
  });
});
