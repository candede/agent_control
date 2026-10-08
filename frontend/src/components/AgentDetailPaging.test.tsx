import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { AgentPublishedVersions } from "./AgentPublishedVersions";
import { InventoryMembers } from "./InventoryMembers";
import { SavedAgentChannels, SavedAgentConnectors } from "./SavedAgentConfiguration";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getInventoryChildren: vi.fn(), getInventoryMembers: vi.fn(),
}));
const source = { scopeId: "source-scope", identity: "native-agent" };
const props = { selectionId: "selected", recordId: "agent:canonical", source };
type Children = Awaited<ReturnType<typeof api.getInventoryChildren>>;
const connector = (value: string, name: string): Children["value"][number] => ({
  ordinal: Number(value), kind: "detail:connectors", value, payload: { connectorId: name, operations: [] },
});
const member = (id: string): api.InventoryMember => ({ source_scope_id: "package-scope", source_identity: id,
  source_generation_id: "generation", domain: "packages", native_id: id, environment_id: null,
  display_name: "Published agent", observed_at: "2026-09-01", expires_at: "2026-10-01" });
const record: api.UnifiedAgentRecord = {
  id: props.recordId, displayName: "Agent", presence: "graph_packages", environmentId: null, packages: [],
  packageCount: 2000, packagesComplete: false, powerPlatformResource: null,
  identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
};
const user: api.SessionUser = {
  tenantId: "tenant", homeAccountId: "account", displayName: "Viewer", username: "viewer@example.invalid",
  roles: ["AgentControl.Viewer"],
};
function scope(children: ReactNode, principal = user) {
  return <CapabilityContext value={{ user: principal, views: [], loading: false, error: undefined, pending: false,
    now: Date.now(), reload: vi.fn(), openPermissions: vi.fn() }}>{children}</CapabilityContext>;
}
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function sharedClient() {
  const client = createSavedQueryClient();
  clients.push(client);
  return client;
}
beforeEach(() => {
  vi.mocked(api.getInventoryChildren).mockImplementation(async (_selection, _record, _source, kind, cursor) => kind === "detail:connectors"
    ? { value: [connector(cursor ? "10" : "0", cursor ? "Later connector" : "Excel connector")], total: 400, nextCursor: cursor ? null : "next-connectors" }
    : kind === "detail:channels" ? { value: [{ ordinal: 1, kind, value: "microsoftTeams", payload: {} }], total: 1, nextCursor: null }
      : { value: [{ ordinal: 2, kind, value: "0", payload: { operationId: "RunScript", isEnabled: false, requiresEndUserConsent: false } }], total: 1, nextCursor: null });
  vi.mocked(api.getInventoryMembers).mockImplementation(async (_selection, _record, cursor) => ({
    value: [member(cursor ? "later-package" : "first-package")], total: 2000, nextCursor: cursor ? null : "next-versions",
  }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });

describe("restored agent detail sections over paged storage", () => {
  it("renders connector operation properties in the original layout, paging only on demand", async () => {
    render(<SavedAgentConnectors {...props} />);
    expect(await screen.findByText("RunScript")).toBeVisible();
    expect(screen.getByText("Enabled").nextElementSibling).toHaveTextContent("No");
    expect(screen.getByText("End-user consent required").nextElementSibling).toHaveTextContent("No");
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(2);
    expect(api.getInventoryChildren).toHaveBeenLastCalledWith("selected", props.recordId,
      { source_scope_id: source.scopeId, source_identity: source.identity }, "connectorOperation", undefined,
      { value: "0", limit: 10, signal: expect.any(AbortSignal) });
    expect(screen.queryByText(/Source members|Detail section|payload/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next connectors" }));
    await screen.findByText("Later connector");
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledTimes(4));
    expect(api.getInventoryChildren).toHaveBeenLastCalledWith("selected", props.recordId, expect.anything(), "connectorOperation", undefined,
      { value: "10", limit: 10, signal: expect.any(AbortSignal) });
    fireEvent.click(screen.getByRole("button", { name: "Previous connectors" }));
    expect(await screen.findByText("Excel connector")).toBeVisible();
  });
  it("surfaces configuration errors and retries without falling back to raw JSON", async () => {
    vi.mocked(api.getInventoryChildren).mockRejectedValueOnce(new Error("Selected configuration expired"));
    render(<SavedAgentConnectors {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Selected configuration expired");
    fireEvent.click(screen.getByRole("button", { name: "Retry configuration" }));
    expect(await screen.findByText("Excel connector")).toBeVisible();
  });
  it("rejects invalid operation shapes instead of rendering partial success", async () => {
    vi.mocked(api.getInventoryChildren).mockImplementation(async (_s, _r, _m, kind) => ({
      value: kind === "detail:connectors" ? [connector("0", "Excel")]
        : [{ ordinal: 2, kind, value: "0", payload: { operationId: "RunScript", isEnabled: "false" } }],
      total: 1, nextCursor: null,
    }));
    render(<SavedAgentConnectors {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved agent configuration is invalid");
    expect(screen.queryByText("RunScript")).not.toBeInTheDocument();
  });
  it("loads channels from the same pinned source without exposing storage field names", async () => {
    render(<SavedAgentChannels {...props} />);
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledOnce());
    expect(await screen.findByText("microsoft Teams")).toBeVisible();
  });
  it("pages published versions in the original selector without draining source membership", async () => {
    const onSelect = vi.fn();
    render(<AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={onSelect} />);
    const select = screen.getByRole("combobox", { name: "Published version details" });
    await within(select).findByRole("option", { name: "Published agent" });
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    fireEvent.change(select, { target: { value: "first-package" } });
    expect(onSelect).toHaveBeenCalledWith("first-package");
    fireEvent.click(screen.getByRole("button", { name: "Next versions" }));
    await waitFor(() => expect(api.getInventoryMembers).toHaveBeenLastCalledWith("selected", record.id, "next-versions", expect.anything()));
    await waitFor(() => expect(within(select).getByRole("option", { name: "Published agent" })).toHaveValue("later-package"));
    fireEvent.change(select, { target: { value: "later-package" } });
    expect(onSelect).toHaveBeenLastCalledWith("later-package");
    expect(screen.queryByText("Source members")).not.toBeInTheDocument();
  });
  it("keeps version navigation focused while loading and permits returning from a failed later page", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.getInventoryMembers>>>();
    render(<AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={vi.fn()} />);
    await screen.findByRole("option", { name: "Published agent" });
    vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
    const next = screen.getByRole("button", { name: "Next versions" });
    next.focus();
    fireEvent.click(next);
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-disabled", "true");
    const previous = screen.getByRole("button", { name: "Previous versions" });
    expect(previous).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(next);
    fireEvent.click(previous);
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("option", { name: "Published agent" })).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error("Later page unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Later page unavailable");
    expect(next).toHaveFocus();
    expect(previous).toHaveAttribute("aria-disabled", "false");
    previous.focus();
    fireEvent.click(previous);
    expect(previous).toHaveFocus();
    expect(previous).toHaveAttribute("aria-disabled", "true");
    expect(await screen.findByRole("option", { name: "Published agent" })).toHaveValue("first-package");
    expect(previous).toHaveFocus();
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(3);
    expect(api.getInventoryMembers).toHaveBeenLastCalledWith("selected", record.id, undefined, { signal: expect.any(AbortSignal) });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not offer a version choice when the current membership page contains only native sources", async () => {
    vi.mocked(api.getInventoryMembers).mockResolvedValueOnce({
      value: [{ ...member("native"), domain: "power_platform" }], total: 51, nextCursor: "next-versions",
    });
    render(<AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={vi.fn()} />);
    expect(await screen.findByText("No published versions on this page.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Published version details" })).toBeDisabled();
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Next versions" }));
    expect(await screen.findByRole("option", { name: "Published agent" })).toHaveValue("later-package");
    expect(screen.getByRole("combobox", { name: "Published version details" })).toBeEnabled();
    expect(screen.queryByText("No published versions on this page.")).not.toBeInTheDocument();
  });

  it("does not retry version membership while its parent disables selection controls", async () => {
    vi.mocked(api.getInventoryMembers).mockRejectedValueOnce(new Error("Membership unavailable"));
    const panel = (disabled: boolean) =>
      <AgentPublishedVersions selectionId="selected" record={record} disabled={disabled} onSelect={vi.fn()} />;
    const view = render(panel(true));
    const retry = await screen.findByRole("button", { name: "Retry published versions" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    view.rerender(panel(false));
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(await screen.findByRole("option", { name: "Published agent" })).toBeVisible();
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(2);
  });

  it("withdraws version navigation when a later membership page invalidates the selection", async () => {
    const onInvalidated = vi.fn();
    render(<AgentPublishedVersions selectionId="selected" record={record} disabled={false}
      onSelect={vi.fn()} onInvalidated={onInvalidated} />);
    await screen.findByRole("option", { name: "Published agent" });
    vi.mocked(api.getInventoryMembers).mockRejectedValueOnce(new api.ApiError(409, "selection_invalidated", "Expired selection"));
    fireEvent.click(screen.getByRole("button", { name: "Next versions" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory");
    expect(screen.queryByRole("option", { name: "Published agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /versions/ })).not.toBeInTheDocument();
    expect(onInvalidated).toHaveBeenCalledOnce();
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(2);
  });

  it("ignores a late membership invalidation after replacing the saved selection", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.getInventoryMembers>>>();
    const onInvalidated = vi.fn();
    const panel = (selectionId: string) => <AgentPublishedVersions selectionId={selectionId} record={record} disabled={false}
      onSelect={vi.fn()} onInvalidated={onInvalidated} />;
    const view = render(panel("selected"));
    await screen.findByRole("option", { name: "Published agent" });
    vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next versions" }));
    const signal = vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal;
    view.rerender(panel("replacement"));
    expect(signal?.aborted).toBe(true);
    await screen.findByRole("option", { name: "Published agent" });
    await act(async () => pending.reject(new api.ApiError(409, "selection_invalidated", "Retired selection")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onInvalidated).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Published version details" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Previous versions" })).toHaveAttribute("aria-disabled", "true");
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(3);
  });

  it("aborts obsolete configuration reads when the pinned selection changes", async () => {
    const pending = deferred<Children>();
    vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
    const view = render(<SavedAgentConnectors {...props} />);
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.getInventoryChildren).mock.calls[0][5]?.signal;
    view.rerender(<SavedAgentConnectors {...props} selectionId="next-selection" />);
    expect(await screen.findByText("Excel connector")).toBeVisible(); expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ value: [connector("0", "Obsolete")], total: 1, nextCursor: null }));
    expect(screen.queryByText("Obsolete")).not.toBeInTheDocument();
  });

  it.each(["selection", "record", "account", "tenant", "roles"] as const)(
    "restarts versions at the first page when the %s changes and never revives retired cursors", async change => {
      const pending = deferred<Awaited<ReturnType<typeof api.getInventoryMembers>>>();
      const onSelect = vi.fn();
      const versions = (selectionId = "selected", currentRecord = record) =>
        <AgentPublishedVersions selectionId={selectionId} record={currentRecord} disabled={false} onSelect={onSelect} />;
      const view = render(scope(versions()));
      await screen.findByRole("option", { name: "Published agent" });
      vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: "Next versions" }));
      const oldSignal = vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal;
      const nextUser = change === "account" ? { ...user, homeAccountId: "next-account" }
        : change === "tenant" ? { ...user, tenantId: "next-tenant" }
          : change === "roles" ? { ...user, roles: ["AgentControl.Admin"] as api.AppRole[] } : user;
      const nextSelection = change === "selection" ? "next-selection" : "selected";
      const nextRecord = change === "record" ? { ...record, id: "agent:next" } : record;
      view.rerender(scope(versions(nextSelection, nextRecord), nextUser));
      expect(oldSignal?.aborted).toBe(true);
      await waitFor(() => expect(api.getInventoryMembers).toHaveBeenLastCalledWith(
        nextSelection, nextRecord.id, undefined, { signal: expect.any(AbortSignal) }));
      expect(await screen.findByRole("option", { name: "Published agent" })).toHaveValue("first-package");
      expect(screen.getByRole("button", { name: "Previous versions" })).toHaveAttribute("aria-disabled", "true");
      await act(async () => pending.resolve({ value: [{ ...member("obsolete"), display_name: "Obsolete version" }],
        total: 1, nextCursor: null }));
      expect(screen.queryByRole("option", { name: "Obsolete version" })).not.toBeInTheDocument();
      view.rerender(scope(versions()));
      await waitFor(() => expect(api.getInventoryMembers).toHaveBeenLastCalledWith(
        "selected", record.id, undefined, { signal: expect.any(AbortSignal) }));
      expect(api.getInventoryMembers).toHaveBeenCalledTimes(4);
      expect(onSelect).not.toHaveBeenCalled();
    });

  it.each(["selection", "record", "source", "account"] as const)(
    "restarts configuration at the first page when the %s changes", async change => {
      const view = render(scope(<SavedAgentConnectors {...props} />));
      await screen.findByText("RunScript");
      fireEvent.click(screen.getByRole("button", { name: "Next connectors" }));
      await screen.findByText("Later connector");
      await screen.findByText("RunScript");
      const replacement = change === "selection" ? { ...props, selectionId: "next-selection" }
        : change === "record" ? { ...props, recordId: "agent:next" }
          : change === "source" ? { ...props, source: { ...source, identity: "next-source" } } : props;
      view.rerender(scope(<SavedAgentConnectors {...replacement} />,
        change === "account" ? { ...user, homeAccountId: "next-account" } : user));
      expect(await screen.findByText("Excel connector")).toBeVisible();
      expect(screen.getByRole("button", { name: "Previous connectors" })).toHaveAttribute("aria-disabled", "true");
      await screen.findByText("RunScript");
      fireEvent.click(screen.getByRole("button", { name: "Previous connectors" }));
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(6);
      view.rerender(scope(<SavedAgentConnectors {...props} />));
      expect(await screen.findByText("Excel connector")).toBeVisible();
      await screen.findByText("RunScript");
      expect(api.getInventoryChildren).toHaveBeenCalledTimes(8);
    });

  it("resets nested operation cursors when the pinned source changes without changing the connector ordinal", async () => {
    vi.mocked(api.getInventoryChildren).mockImplementation(async (_s, _r, pinned, kind, cursor) => ({
      value: kind === "detail:connectors" ? [connector("0", "Excel connector")]
        : [{ ordinal: 1, kind, value: "0", payload: { operationId: `${pinned.source_identity}-${cursor ? "last" : "first"}` } }],
      total: 20, nextCursor: kind === "connectorOperation" && !cursor ? "next-operations" : null,
    }));
    const view = render(<SavedAgentConnectors {...props} />);
    await screen.findByText("native-agent-first");
    fireEvent.click(screen.getByRole("button", { name: "Next operations" }));
    await screen.findByText("native-agent-last");
    view.rerender(<SavedAgentConnectors {...props} source={{ ...source, identity: "next-source" }} />);
    expect(await screen.findByText("next-source-first")).toBeVisible();
    expect(screen.getByRole("button", { name: "Previous operations" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Previous operations" }));
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(5);
  });

  it("retires member-page navigation and pending reads when only the account changes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.getInventoryMembers>>>();
    const panel = <InventoryMembers selectionId="selected" recordId={record.id} />;
    const view = render(scope(panel));
    await screen.findByRole("button", { name: "Published agent" });
    vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next members" }));
    const signal = vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal;
    view.rerender(scope(panel, { ...user, homeAccountId: "next-account" }));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(api.getInventoryMembers).toHaveBeenLastCalledWith(
      "selected", record.id, undefined, { signal: expect.any(AbortSignal) }));
    await act(async () => pending.resolve({
      value: [{ ...member("retired"), display_name: "Retired member" }], total: 1, nextCursor: null,
    }));
    expect(await screen.findByRole("button", { name: "Published agent" })).toBeVisible();
    expect(screen.queryByText("Retired member")).not.toBeInTheDocument();
    view.rerender(scope(panel));
    await waitFor(() => expect(api.getInventoryMembers).toHaveBeenCalledTimes(4));
    expect(api.getInventoryMembers).toHaveBeenLastCalledWith(
      "selected", record.id, undefined, { signal: expect.any(AbortSignal) });
  });

  it.each(["versions", "channels"] as const)("shows one pending %s retry after a cached read fails", async section => {
    const client = sharedClient();
    const read = section === "versions" ? vi.mocked(api.getInventoryMembers) : vi.mocked(api.getInventoryChildren);
    const pending = deferred<{ value: never[]; total: number; nextCursor: null }>();
    const nextPage = { value: [], total: 0, nextCursor: null };
    render(<QueryClientProvider client={client}>{section === "versions"
      ? <AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={vi.fn()} />
      : <SavedAgentChannels {...props} />}</QueryClientProvider>);
    await screen.findByText(section === "versions" ? "Published agent" : "microsoft Teams");
    read.mockRejectedValueOnce(new Error("Saved read failed"));
    await act(async () => { await client.invalidateQueries(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved read failed");
    expect(screen.queryByText(section === "versions" ? "Published agent" : "microsoft Teams")).not.toBeInTheDocument();
    read.mockReturnValueOnce(pending.promise);
    const retry = screen.getByRole("button", { name: section === "versions" ? "Retry published versions" : "Retry configuration" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(read).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole("status")).toHaveTextContent(/Loading/);
    expect(retry).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(read).toHaveBeenCalledTimes(3);
    const signal = section === "versions" ? vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal
      : vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(nextPage));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["versions", "channels", "connectors"] as const)(
    "withdraws invalidated %s and requires a new inventory selection instead of retrying it", async section => {
      const client = sharedClient();
      const read = section === "versions" ? vi.mocked(api.getInventoryMembers) : vi.mocked(api.getInventoryChildren);
      const panel = (selectionId: string) => <QueryClientProvider client={client}>{section === "versions"
        ? <AgentPublishedVersions selectionId={selectionId} record={{ ...record, packages: [{
          id: "preview-package", displayName: "Preview version", isBlocked: false, sourceSystem: "graph_packages", authoringTool: "unknown",
          creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
        }] }} disabled={false} onSelect={vi.fn()} />
        : section === "channels" ? <SavedAgentChannels {...props} selectionId={selectionId} />
          : <SavedAgentConnectors {...props} selectionId={selectionId} />}</QueryClientProvider>;
      const visible = section === "versions" ? "Published agent" : section === "channels" ? "microsoft Teams" : "RunScript";
      const view = render(panel("selected"));
      await screen.findByText(visible);
      read.mockRejectedValueOnce(new api.ApiError(409, "selection_invalidated", "selection_invalidated"));
      await act(async () => { await client.invalidateQueries({
        predicate: query => section !== "connectors" || query.queryKey[6] === "detail:connectors",
      }); });
      expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory");
      expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
      expect(screen.queryByText(visible)).not.toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "Preview version" })).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      const calls = read.mock.calls.length;
      act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
      expect(read).toHaveBeenCalledTimes(calls);
      await act(async () => { await client.invalidateQueries(); });
      expect(read).toHaveBeenCalledTimes(calls);
      expect(screen.queryByText(visible)).not.toBeInTheDocument();
      view.rerender(panel("replacement-selection"));
      expect(await screen.findByText(visible)).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

  it("shares settled version membership with a later reader instead of reloading its immutable page", async () => {
    const client = sharedClient();
    const versions = <AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={vi.fn()} />;
    const view = render(<QueryClientProvider client={client}>{versions}</QueryClientProvider>);
    await screen.findByRole("option", { name: "Published agent" });
    view.rerender(<QueryClientProvider client={client}>{versions}
      <InventoryMembers selectionId="selected" recordId={record.id} />
    </QueryClientProvider>);
    expect(await screen.findByRole("button", { name: "Published agent" })).toBeVisible();
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    await act(async () => { await client.invalidateQueries(); });
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(2);
  });

  it.each(["versions", "channels"] as const)(
    "shares concurrent %s reads, keeps equivalent rerenders idle, and cancels only the final observer", async section => {
      const client = sharedClient();
      const pending = deferred<{ value: never[]; total: number; nextCursor: null }>();
      const read = section === "versions" ? vi.mocked(api.getInventoryMembers) : vi.mocked(api.getInventoryChildren);
      read.mockReturnValueOnce(pending.promise);
      const panel = (key: string) => section === "versions"
        ? <AgentPublishedVersions key={key} selectionId="selected" record={{ ...record }} disabled={false} onSelect={vi.fn()} />
        : <SavedAgentChannels key={key} {...props} source={{ ...source }} />;
      const view = render(<QueryClientProvider client={client}>{panel("left")}{panel("right")}</QueryClientProvider>);
      expect(read).toHaveBeenCalledOnce();
      const signal = section === "versions" ? vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal
        : vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
      view.rerender(<QueryClientProvider client={client}>{panel("right")}</QueryClientProvider>);
      expect(read).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(false);
      view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => pending.resolve({ value: [], total: 0, nextCursor: null }));
      expect(client.getQueryCache().getAll().some(query => query.state.status === "success")).toBe(false);
    });

  it("does not reload settled configuration or versions for equivalent props, focus, or reconnect", async () => {
    const client = sharedClient();
    const panel = () => <QueryClientProvider client={client}>
      {scope(<><AgentPublishedVersions selectionId="selected" record={{ ...record }} disabled={false} onSelect={vi.fn()} />
        <SavedAgentConnectors {...props} source={{ ...source }} /></>, { ...user, roles: [...user.roles] })}
    </QueryClientProvider>;
    const view = render(panel());
    await screen.findByText("RunScript");
    await screen.findByText("Published agent");
    view.rerender(panel());
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    expect(api.getInventoryChildren).toHaveBeenCalledTimes(2);
  });
});
