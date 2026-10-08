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

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(),
  getInventoryMembers: vi.fn(), getInventorySections: vi.fn(), getInventoryChildren: vi.fn(),
}));
type Members = Awaited<ReturnType<typeof api.getInventoryMembers>>;
type Sections = Awaited<ReturnType<typeof api.getInventorySections>>;
type Rows = Awaited<ReturnType<typeof api.getInventoryChildren>>;
const member: api.InventoryMember = {
  source_scope_id: "scope", source_identity: "source", source_generation_id: "generation",
  domain: "packages", native_id: "opaque/Package", environment_id: null, display_name: "Primary package",
  observed_at: "2026-10-01", expires_at: "2026-10-10",
};
const firstMembers: Members = { value: [member], total: 6000, nextCursor: "next-members" };
const firstSections: Sections = { value: [{ kind: "element", total: 9000 }], nextCursor: "next-sections" };
const firstRows: Rows = {
  value: [{ ordinal: 0, kind: "element", value: "First detail", payload: {} }], total: 9000, nextCursor: "next-rows",
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
function client() {
  const value = createSavedQueryClient();
  clients.push(value);
  return value;
}
function panel(selectionId = "selected", recordId = "agent:one") {
  return <InventoryMembers selectionId={selectionId} recordId={recordId} />;
}
async function openDetails() {
  fireEvent.click(await screen.findByRole("button", { name: "Primary package" }));
  await screen.findByText("First detail");
}
beforeEach(() => {
  vi.mocked(api.getInventoryMembers).mockResolvedValue(firstMembers);
  vi.mocked(api.getInventorySections).mockResolvedValue(firstSections);
  vi.mocked(api.getInventoryChildren).mockResolvedValue(firstRows);
});
afterEach(() => { cleanup(); clients.splice(0).forEach(value => value.clear()); vi.resetAllMocks(); });

describe("source member read ownership", () => {
  it("retries a failed member read once with honest pending and empty states", async () => {
    const pending = deferred<Members>();
    vi.mocked(api.getInventoryMembers).mockRejectedValueOnce(new Error("Members unavailable"));
    render(panel());
    expect(await screen.findByRole("alert")).toHaveTextContent("Members unavailable");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Inventory source members" })).toHaveAttribute("aria-busy", "false");
    vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
    const retry = screen.getByRole("button", { name: "Retry source members" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(api.getInventoryMembers).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading source members");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => pending.resolve({ value: [], total: 0, nextCursor: null }));
    expect(await screen.findByText("No source members on this page.")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["selection", "record", "account", "tenant", "roles"] as const)(
    "does not revive a selected member after a %s round-trip", async change => {
      const view = render(scope(panel()));
      await openDetails();
      const nextUser = change === "account" ? { ...user, homeAccountId: "next" }
        : change === "tenant" ? { ...user, tenantId: "next" }
          : change === "roles" ? { ...user, roles: ["AgentControl.Admin"] as api.AppRole[] } : user;
      view.rerender(scope(panel(change === "selection" ? "replacement" : "selected",
        change === "record" ? "agent:two" : "agent:one"), nextUser));
      await screen.findByRole("button", { name: "Primary package" });
      expect(screen.queryByRole("region", { name: "Source detail rows" })).not.toBeInTheDocument();
      view.rerender(scope(panel()));
      await waitFor(() => expect(api.getInventoryMembers).toHaveBeenCalledTimes(3));
      await screen.findByRole("button", { name: "Primary package" });
      expect(screen.queryByRole("region", { name: "Source detail rows" })).not.toBeInTheDocument();
      expect(api.getInventorySections).toHaveBeenCalledOnce();
      expect(api.getInventoryChildren).toHaveBeenCalledOnce();
    });

  it("withdraws the old page on a quick owner round-trip before either replacement read settles", async () => {
    const other = deferred<Members>(), replacement = deferred<Members>();
    const view = render(scope(panel()));
    await screen.findByRole("button", { name: "Primary package" });
    vi.mocked(api.getInventoryMembers).mockReturnValueOnce(other.promise).mockReturnValueOnce(replacement.promise);
    view.rerender(scope(panel(), { ...user, homeAccountId: "other" }));
    const otherSignal = vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal;
    view.rerender(scope(panel()));
    expect(otherSignal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Primary package" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading source members");
    await act(async () => other.resolve({ ...firstMembers, value: [{ ...member, display_name: "Other account" }] }));
    expect(screen.queryByRole("button", { name: "Other account" })).not.toBeInTheDocument();
    await act(async () => replacement.resolve(firstMembers));
    expect(await screen.findByRole("button", { name: "Primary package" })).toBeVisible();
  });

  it.each(["members", "sections", "rows"] as const)(
    "shares concurrent %s reads and cancels only the final observer", async phase => {
      const shared = client();
      const pending = deferred<Members & Sections & Rows>();
      if (phase === "members") vi.mocked(api.getInventoryMembers).mockReturnValue(pending.promise);
      if (phase === "sections") vi.mocked(api.getInventorySections).mockReturnValue(pending.promise);
      if (phase === "rows") vi.mocked(api.getInventoryChildren).mockReturnValue(pending.promise);
      const panels = (left: boolean) => <QueryClientProvider client={shared}>
        {left ? <div key="left" data-testid="left">{panel()}</div> : null}
        <div key="right" data-testid="right">{panel()}</div>
      </QueryClientProvider>;
      const view = render(panels(true));
      if (phase !== "members") {
        const buttons = await screen.findAllByRole("button", { name: "Primary package" });
        act(() => { for (const button of buttons) fireEvent.click(button); });
      }
      const read = phase === "members" ? vi.mocked(api.getInventoryMembers)
        : phase === "sections" ? vi.mocked(api.getInventorySections) : vi.mocked(api.getInventoryChildren);
      await waitFor(() => expect(read).toHaveBeenCalledOnce());
      const signal = phase === "members" ? vi.mocked(api.getInventoryMembers).mock.lastCall?.[3]?.signal
        : phase === "sections" ? vi.mocked(api.getInventorySections).mock.lastCall?.[3]?.signal
          : vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
      view.rerender(panels(false));
      expect(signal?.aborted).toBe(false);
      expect(read).toHaveBeenCalledOnce();
      view.unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () => pending.resolve({ value: [], total: 0, nextCursor: null }));
      expect(shared.getQueryCache().getAll().some(query => query.state.status === "success" && query.queryKey.includes(
        phase === "members" ? "agent-versions" : phase === "sections" ? "inventory-sections" : "inventory-children"))).toBe(false);
    });

  it("shares the identical member request with published versions", async () => {
    const pending = deferred<Members>(), shared = client();
    vi.mocked(api.getInventoryMembers).mockReturnValue(pending.promise);
    const record: api.UnifiedAgentRecord = {
      id: "agent:one", displayName: "Agent", presence: "graph_packages", environmentId: null,
      packages: [], powerPlatformResource: null, identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
      observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
    };
    render(<QueryClientProvider client={shared}>{panel()}
      <AgentPublishedVersions selectionId="selected" record={record} disabled={false} onSelect={vi.fn()} />
    </QueryClientProvider>);
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(firstMembers));
    expect(await screen.findByRole("option", { name: "Primary package" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Primary package" })).toBeVisible();
  });

  it("reacts to saved-cache invalidation but not equivalent props, focus or reconnect", async () => {
    const shared = client(), pending = deferred<Members>();
    const content = () => <QueryClientProvider client={shared}>{scope(panel(), { ...user, roles: [...user.roles] })}</QueryClientProvider>;
    const view = render(content());
    await openDetails();
    view.rerender(content());
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    expect(api.getInventorySections).toHaveBeenCalledOnce();
    expect(api.getInventoryChildren).toHaveBeenCalledOnce();
    vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
    act(() => { void shared.invalidateQueries({ queryKey: ["saved", "agent-versions"] }); });
    await waitFor(() => expect(api.getInventoryMembers).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Primary package" })).not.toBeInTheDocument();
    expect(screen.queryByText("First detail")).not.toBeInTheDocument();
    await act(async () => pending.resolve({ ...firstMembers, value: [{ ...member, display_name: "Updated package" }] }));
    expect(await screen.findByRole("button", { name: "Updated package" })).toBeVisible();
  });
});

describe("source member recovery and paging", () => {
  it.each(["members", "sections", "rows"] as const)(
    "keeps %s navigation focused through pending and failed pages and permits returning to the first page", async phase => {
      const pending = deferred<Members & Sections & Rows>();
      render(panel());
      await screen.findByRole("button", { name: "Primary package" });
      if (phase !== "members") await openDetails();
      if (phase === "members") vi.mocked(api.getInventoryMembers).mockReturnValueOnce(pending.promise);
      if (phase === "sections") vi.mocked(api.getInventorySections).mockReturnValueOnce(pending.promise);
      if (phase === "rows") vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
      const nextName = phase === "members" ? "Next members" : phase === "sections" ? "More detail sections" : "Next detail rows";
      const firstName = phase === "members" ? "First members" : phase === "sections" ? "First detail sections" : "First detail rows";
      const next = screen.getByRole("button", { name: nextName });
      next.focus(); fireEvent.click(next);
      expect(next).toHaveFocus();
      expect(next).toHaveAttribute("aria-disabled", "true");
      const read = phase === "members" ? vi.mocked(api.getInventoryMembers)
        : phase === "sections" ? vi.mocked(api.getInventorySections) : vi.mocked(api.getInventoryChildren);
      fireEvent.click(next);
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => pending.reject(new api.ApiError(400, "invalid_cursor", "Cursor rejected")));
      expect(await screen.findByRole("alert")).toHaveTextContent("Cursor rejected");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      const first = screen.getByRole("button", { name: firstName });
      first.focus(); fireEvent.click(first);
      expect(first).toHaveFocus();
      await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
      if (phase === "members") await screen.findByRole("button", { name: "Primary package" });
      else await screen.findByText("First detail");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(first).toHaveFocus();
      expect(first).toHaveAttribute("aria-disabled", "true");
    });

  it.each(["members", "sections", "rows"] as const)(
    "retires the whole member view on %s invalidation instead of retrying a rejected selection", async phase => {
      const invalidated = vi.fn(), inspect = vi.fn();
      const failure = new api.ApiError(409, "selection_invalidated", "Selection expired");
      if (phase === "members") vi.mocked(api.getInventoryMembers).mockRejectedValueOnce(failure);
      if (phase === "sections") vi.mocked(api.getInventorySections).mockRejectedValueOnce(failure);
      if (phase === "rows") vi.mocked(api.getInventoryChildren).mockRejectedValueOnce(failure);
      const content = (selectionId: string) => <InventoryMembers selectionId={selectionId} recordId="agent:one"
        onInspectPackage={inspect} onInvalidated={invalidated} />;
      const view = render(content("selected"));
      if (phase !== "members") fireEvent.click(await screen.findByRole("button", { name: "Primary package" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Reload saved inventory");
      await waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
      expect(screen.queryByRole("button", { name: /Retry|Inspect published|Next|First|More/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Primary package" })).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(inspect).not.toHaveBeenCalled();
      view.rerender(content("replacement"));
      expect(await screen.findByRole("button", { name: "Primary package" })).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

  it.each(["sections", "rows"] as const)("ignores late %s invalidation after the principal changes", async phase => {
    const pending = deferred<Sections & Rows>(), invalidated = vi.fn();
    if (phase === "sections") vi.mocked(api.getInventorySections).mockReturnValueOnce(pending.promise);
    else vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
    const content = () => <InventoryMembers selectionId="selected" recordId="agent:one" onInvalidated={invalidated} />;
    const view = render(scope(content()));
    fireEvent.click(await screen.findByRole("button", { name: "Primary package" }));
    const read = phase === "sections" ? vi.mocked(api.getInventorySections) : vi.mocked(api.getInventoryChildren);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const signal = phase === "sections" ? vi.mocked(api.getInventorySections).mock.lastCall?.[3]?.signal
      : vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
    view.rerender(scope(content(), { ...user, homeAccountId: "replacement" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.reject(new api.ApiError(409, "selection_invalidated", "Retired")));
    expect(await screen.findByRole("button", { name: "Primary package" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("selects a replacement section at its first row page and ignores cancelled rows", async () => {
    const pending = deferred<Rows>();
    vi.mocked(api.getInventorySections).mockResolvedValueOnce({
      value: [{ kind: "element", total: 9000 }, { kind: "owner", total: 1 }], nextCursor: null,
    });
    render(panel());
    await openDetails();
    vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next detail rows" }));
    const signal = vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
    vi.mocked(api.getInventoryChildren).mockResolvedValueOnce({ value: [], total: 0, nextCursor: null });
    fireEvent.change(screen.getByRole("combobox", { name: "Detail section" }), { target: { value: "owner" } });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenLastCalledWith("selected", "agent:one",
      member, "owner", undefined, { signal: expect.any(AbortSignal) }));
    expect(await screen.findByText("No saved owner rows on this page.")).toBeVisible();
    await act(async () => pending.resolve({ ...firstRows, value: [{ ...firstRows.value[0], value: "Cancelled detail" }] }));
    expect(screen.queryByText("Cancelled detail")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Source detail rows" })).queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["sections", "rows"] as const)("shares a pending %s retry without reloading parent pages", async phase => {
    const pending = deferred<Sections & Rows>();
    const read = phase === "sections" ? vi.mocked(api.getInventorySections) : vi.mocked(api.getInventoryChildren);
    read.mockRejectedValueOnce(new Error("Temporarily unavailable"));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Primary package" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporarily unavailable");
    read.mockReturnValueOnce(pending.promise);
    const retry = screen.getByRole("button", { name: `Retry detail ${phase}` });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(read).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("status")).toHaveTextContent(`Loading detail ${phase}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    if (phase === "rows") expect(api.getInventorySections).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ value: [], total: 0, nextCursor: null }));
    expect(await screen.findByText(phase === "sections"
      ? "No saved child collections on this page." : "No saved element rows on this page.")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cancels a replaced member's details without reloading membership or accepting late rows", async () => {
    const pending = deferred<Rows>();
    const replacement = { ...member, source_identity: "other", native_id: "other", display_name: "Other package" };
    vi.mocked(api.getInventoryMembers).mockResolvedValue({ ...firstMembers, value: [member, replacement] });
    render(panel());
    await openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Primary package" }));
    expect(api.getInventorySections).toHaveBeenCalledOnce();
    expect(api.getInventoryChildren).toHaveBeenCalledOnce();
    vi.mocked(api.getInventoryChildren).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Next detail rows" }));
    const signal = vi.mocked(api.getInventoryChildren).mock.lastCall?.[5]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "Other package" }));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(api.getInventoryChildren).toHaveBeenLastCalledWith("selected", "agent:one",
      replacement, "element", undefined, { signal: expect.any(AbortSignal) }));
    await screen.findByText("First detail");
    expect(api.getInventoryMembers).toHaveBeenCalledOnce();
    expect(api.getInventorySections).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ ...firstRows, value: [{ ...firstRows.value[0], value: "Old source" }] }));
    expect(screen.queryByText("Old source")).not.toBeInTheDocument();
  });
});
