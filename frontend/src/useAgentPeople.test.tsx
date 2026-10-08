import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import * as api from "./api/client";
import type { CapabilityView, UnifiedAgentRecord } from "./api/client";
import { CapabilityContext } from "./capabilityContext";
import { deferred } from "./test/deferred";
import { useAgentPeople } from "./useAgentPeople";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const creatorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const savedPerson = {
  objectId: ownerId, displayName: "Saved owner", userPrincipalName: "saved.owner@example.invalid",
  observedAt: "2026-09-17T12:00:00Z",
};
const record: UnifiedAgentRecord = {
  id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Agent", presence: "power_platform",
  environmentId: "environment", packages: [],
  powerPlatformResource: {
    tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
    environmentId: "environment", location: null, displayName: "Agent", createdAt: null,
    createdBy: creatorId, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null,
    creatorType: "unknown", agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native",
    identifiers: [], provenance: {}, details: { ownerId }, unknownFieldCount: 0,
  },
  identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
};

function authorized({ children, account = "reader", allowed = true }: { children: ReactNode; account?: string; allowed?: boolean }) {
  const now = Date.now();
  const directory: CapabilityView = {
    definition: capabilityDefinitions.find(value => value.id === "graph.directory.read")!,
    decision: {
      capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
      verification: "provider", previewQualification: "not_required", remediation: [],
      checkedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    },
  };
  return <CapabilityContext value={{
    views: allowed ? [directory] : [], user: { tenantId: "tenant", homeAccountId: account, username: "reader@example.invalid",
      displayName: "Reader", roles: ["AgentControl.Viewer"] },
    now, loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}>{children}</CapabilityContext>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("authoritative saved agent people responses", () => {
  it.each(["resolved", "invalid", "absent", "denied", "no-role"] as const)(
    "does not admit lookup when its action is unavailable: %s", async state => {
      let allowed = state !== "denied";
      const original: UnifiedAgentRecord = { ...record,
        people: state === "resolved" ? { owner: savedPerson } : undefined,
        powerPlatformResource: { ...record.powerPlatformResource!, createdBy: null,
          details: { ownerId: state === "absent" ? undefined : state === "invalid" ? "source-only-person" : ownerId } },
      };
      const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({ people: {}, changed: false });
      const { result, rerender } = renderHook(() => useAgentPeople(original, state === "no-role" ? [] : ["AgentControl.Viewer"]),
        { wrapper: ({ children }) => authorized({ children, allowed }) });
      expect(result.current.canRetry).toBe(false);
      await act(async () => result.current.retry());
      allowed = true;
      rerender();
      expect(result.current.loading).toBe(false);
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("shares a pending lookup across repeated current and retained retry handlers", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.resolveAgentPeople>>>();
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockReturnValue(pending.promise);
    const changed = vi.fn();
    const { result } = renderHook(() => useAgentPeople(record, ["AgentControl.Viewer"], changed), { wrapper: authorized });
    const retry = result.current.retry;
    act(() => { retry(); retry(); });
    expect(lookup).toHaveBeenCalledOnce();
    act(() => result.current.retry());
    act(() => retry());
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve({ people: { owner: savedPerson }, changed: true }));
    expect(result.current.people.owner?.displayName).toBe("Saved owner");
    expect(result.current.loading).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    act(() => retry());
    expect(lookup).toHaveBeenCalledOnce();
    await act(async () => result.current.retry());
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(["account", "record"] as const)("retires retry handlers across a round trip to another %s", async boundary => {
    let account = "reader";
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({ people: {}, changed: false });
    const { result, rerender } = renderHook(value => useAgentPeople(value, ["AgentControl.Viewer"]),
      { initialProps: record, wrapper: ({ children }) => authorized({ children, account }) });
    const retry = result.current.retry;
    if (boundary === "account") account = "other";
    rerender(boundary === "record" ? { ...record, id: "agent:other" } : record);
    act(() => retry());
    expect(lookup).not.toHaveBeenCalled();
    account = "reader";
    rerender(record);
    act(() => retry());
    expect(lookup).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    await act(async () => result.current.retry());
    expect(lookup).toHaveBeenCalledOnce();
  });

  describe.each(["ordering", "casing"] as const)("equivalent saved-person %s", equivalence => {
    it.each(["pending", "resolved", "failed"] as const)("preserves a %s lookup", async phase => {
      const pending = deferred<Awaited<ReturnType<typeof api.resolveAgentPeople>>>();
      const lookup = vi.spyOn(api, "resolveAgentPeople").mockReturnValue(pending.promise);
      const original = { ...record, people: { owner: savedPerson } };
      const changed = vi.fn();
      const { result, rerender } = renderHook(value => useAgentPeople(value, ["AgentControl.Viewer"], changed),
        { initialProps: original, wrapper: authorized });
      act(() => result.current.retry());
      if (phase !== "pending") await act(async () => {
        if (phase === "failed") pending.reject(new Error("Current directory error"));
        else pending.resolve({ people: { owner: { ...savedPerson, displayName: "Returned owner" } }, changed: true });
      });
      rerender({ ...original, people: { owner: equivalence === "ordering" ? {
        observedAt: savedPerson.observedAt, userPrincipalName: savedPerson.userPrincipalName,
        displayName: savedPerson.displayName, objectId: ownerId,
      } : { ...savedPerson, objectId: ownerId.toUpperCase() } } });
      expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(false);
      expect(result.current.loading).toBe(phase === "pending");
      expect(result.current.error).toBe(phase === "failed" ? "Current directory error" : undefined);
      if (phase === "pending") await act(async () => pending.resolve({
        people: { owner: { ...savedPerson, displayName: "Returned owner" } }, changed: true,
      }));
      expect(result.current.people.owner?.displayName).toBe(phase === "failed" ? "Saved owner" : "Returned owner");
      expect(lookup).toHaveBeenCalledOnce();
      expect(changed).toHaveBeenCalledTimes(phase === "failed" ? 0 : 1);
    });
  });

  it.each([
    { displayName: "Replacement owner" }, { status: "not_found" as const }, { expiresAt: "2020-01-01T00:00:00Z" },
  ])("retires pending results when saved person evidence really changes: %j", async replacement => {
    const pending = deferred<Awaited<ReturnType<typeof api.resolveAgentPeople>>>();
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockReturnValue(pending.promise);
    const original: UnifiedAgentRecord = { ...record, people: { owner: savedPerson } };
    const changed = vi.fn();
    const { result, rerender } = renderHook(value => useAgentPeople(value, ["AgentControl.Viewer"], changed),
      { initialProps: original, wrapper: authorized });
    act(() => result.current.retry());
    rerender({ ...original, people: { owner: { ...savedPerson, ...replacement } } });
    const current = result.current.people.owner;
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
    await act(async () => pending.resolve({ people: { owner: { ...savedPerson, displayName: "Retired owner" } }, changed: true }));
    expect(result.current.people.owner).toEqual(current);
    expect(changed).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: "pending", boundary: "agent" }, { phase: "resolved", boundary: "agent" }, { phase: "failed", boundary: "agent" },
    { phase: "pending", boundary: "account" }, { phase: "resolved", boundary: "account" }, { phase: "failed", boundary: "account" },
  ] as const)("does not revive a $phase lookup after leaving and returning to the $boundary", async ({ phase, boundary }) => {
    let account = "reader";
    const pending = deferred<Awaited<ReturnType<typeof api.resolveAgentPeople>>>();
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockImplementation(() => phase === "pending" ? pending.promise
      : phase === "failed" ? Promise.reject(new Error("Retired directory error"))
        : Promise.resolve({ people: { owner: savedPerson }, changed: false }));
    const { result, rerender } = renderHook(value => useAgentPeople(value, ["AgentControl.Viewer"]),
      { initialProps: record, wrapper: ({ children }) => authorized({ children, account }) });
    await act(async () => result.current.retry());
    expect(lookup).toHaveBeenCalledOnce();
    if (boundary === "account") account = "other";
    rerender(boundary === "agent" ? { ...record, id: "agent:other" } : record);
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    account = "reader";
    rerender(record);
    expect(result.current.people.owner?.displayName).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(result.current.canRetry).toBe(true);
    expect(lookup).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ people: { owner: savedPerson }, changed: true }));
    expect(result.current.people.owner?.displayName).toBeUndefined();
  });

  it.each([
    { outcome: "success", phase: "before retry" }, { outcome: "failure", phase: "before retry" },
    { outcome: "success", phase: "pending retry" }, { outcome: "failure", phase: "pending retry" },
    { outcome: "success", phase: "after retry" }, { outcome: "failure", phase: "after retry" },
  ] as const)("ignores a cancelled lookup's late $outcome $phase", async ({ outcome, phase }) => {
    let allowed = true;
    const pending = deferred<Awaited<ReturnType<typeof api.resolveAgentPeople>>>();
    const replacement = deferred<Awaited<ReturnType<typeof api.resolveAgentPeople>>>();
    const lookup = vi.spyOn(api, "resolveAgentPeople").mockReturnValueOnce(pending.promise).mockReturnValueOnce(replacement.promise);
    const changed = vi.fn();
    const { result, rerender } = renderHook(() => useAgentPeople(record, ["AgentControl.Viewer"], changed),
      { wrapper: ({ children }) => authorized({ children, allowed }) });
    act(() => result.current.retry());
    expect(lookup).toHaveBeenCalledOnce();
    allowed = false;
    rerender();
    expect(lookup.mock.calls[0][1]?.signal?.aborted).toBe(true);
    allowed = true;
    rerender();
    expect(result.current.loading).toBe(false);
    expect(lookup).toHaveBeenCalledOnce();
    const settleRetired = () => act(async () => {
      if (outcome === "success") pending.resolve({ people: { owner: savedPerson }, changed: true });
      else pending.reject(new Error("Retired directory error"));
    });
    if (phase === "before retry") {
      await settleRetired();
      expect(result.current.people.owner?.displayName).toBeUndefined();
      expect(result.current.error).toBeUndefined();
      expect(result.current.loading).toBe(false);
      expect(result.current.canRetry).toBe(true);
      expect(lookup).toHaveBeenCalledOnce();
    }
    act(() => result.current.retry());
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[1][1]?.signal?.aborted).toBe(false);
    if (phase === "pending retry") await settleRetired();
    expect(result.current.people.owner?.displayName).toBeUndefined();
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(result.current.canRetry).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => replacement.resolve({
      people: { owner: { ...savedPerson, displayName: "Current owner" } }, changed: true,
    }));
    if (phase === "after retry") await settleRetired();
    expect(result.current.people.owner?.displayName).toBe("Current owner");
    expect(result.current.error).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(["saved", "returned"] as const)(
    "expires %s people independently of capability diagnostics without reloading them", async source => {
      vi.useFakeTimers();
      const now = Date.now();
      const person = { ...savedPerson, expiresAt: new Date(now + 1_000).toISOString() };
      const original = { ...record, powerPlatformResource: { ...record.powerPlatformResource!, createdBy: null },
        people: source === "saved" ? { owner: person } : undefined };
      const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({ people: { owner: person }, changed: false });
      const { result } = renderHook(() => useAgentPeople(original, ["AgentControl.Viewer"]), { wrapper: authorized });
      if (source === "returned") await act(async () => result.current.retry());
      expect(result.current.people.owner?.expired).toBe(false);
      expect(result.current.canRetry).toBe(false);
      await act(async () => vi.advanceTimersByTime(1_001));
      expect(result.current.people.owner?.expired).toBe(true);
      expect(result.current.people.owner?.displayName).toBe("Saved owner");
      expect(result.current.canRetry).toBe(true);
      expect(result.current.loading).toBe(false);
      expect(lookup).toHaveBeenCalledTimes(source === "returned" ? 1 : 0);
    },
  );

  it.each(["absent", "empty", "partial"] as const)(
    "replaces obsolete labels with an %s response, without looping, and supports explicit retry", async response => {
      const original = { ...record, people: {
        owner: { ...savedPerson, expiresAt: new Date(Date.now() - 1_000).toISOString() },
      } };
      const createdBy = { ...savedPerson, objectId: creatorId, displayName: "Current creator" };
      const people = response === "absent" ? undefined : response === "empty" ? {} : { createdBy };
      const lookup = vi.spyOn(api, "resolveAgentPeople").mockResolvedValue({ people, changed: false });
      const changed = vi.fn();
      const { result, rerender } = renderHook(value => useAgentPeople(value, ["AgentControl.Viewer"], changed),
        { initialProps: original, wrapper: authorized });
      expect(result.current.people.owner?.displayName).toBe("Saved owner");
      expect(lookup).not.toHaveBeenCalled();
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.people.owner?.status).toBe("unverified"));
      expect(result.current.people.owner).toEqual({ id: ownerId, invalidId: false, status: "unverified" });
      expect(result.current.people.createdBy?.displayName).toBe(response === "partial" ? "Current creator" : undefined);
      expect(result.current.loading).toBe(false);
      expect(result.current.canRetry).toBe(true);
      expect(lookup).toHaveBeenCalledOnce();
      expect(changed).not.toHaveBeenCalled();
      rerender(structuredClone(original));
      expect(result.current.people.owner?.displayName).toBeUndefined();
      expect(lookup).toHaveBeenCalledOnce();
      lookup.mockResolvedValue({ people: { owner: savedPerson, createdBy }, changed: true });
      act(() => result.current.retry());
      await waitFor(() => expect(result.current.people.owner?.displayName).toBe("Saved owner"));
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup).toHaveBeenLastCalledWith(record.id, { force: true, signal: expect.any(AbortSignal) });
      expect(changed).toHaveBeenCalledOnce();
    },
  );

  it("retains saved evidence on request failure but honors omissions after a successful retry", async () => {
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockRejectedValueOnce(new Error("Directory unavailable"))
      .mockResolvedValueOnce({ people: undefined, changed: false })
      .mockRejectedValueOnce(new Error("Retry unavailable"));
    const { result } = renderHook(() => useAgentPeople({ ...record, people: { owner: savedPerson } }, ["AgentControl.Viewer"]),
      { wrapper: authorized });
    expect(lookup).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBe("Directory unavailable"));
    expect(result.current.people.owner?.displayName).toBe("Saved owner");
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.people.owner?.status).toBe("unverified"));
    expect(result.current.error).toBeUndefined();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBe("Retry unavailable"));
    expect(result.current.people.owner?.displayName).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("keeps newly expired returned people visible without provider reads until explicitly refreshed", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const createdBy = { ...savedPerson, objectId: creatorId, expiresAt: new Date(now + 1_000).toISOString() };
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockResolvedValueOnce({ people: { createdBy }, changed: true })
      .mockResolvedValue({ people: undefined, changed: false });
    const { result, rerender } = renderHook(() => useAgentPeople(record, ["AgentControl.Viewer"]), { wrapper: authorized });
    expect(lookup).not.toHaveBeenCalled();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.people.createdBy?.displayName).toBe("Saved owner"));
    expect(result.current.people.owner?.status).toBe("unverified");
    expect(lookup).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(now + 2_000);
    rerender();
    expect(result.current.people.createdBy?.expired).toBe(true);
    expect(lookup).toHaveBeenCalledOnce();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.people.createdBy?.status).toBe("unverified"));
    expect(result.current.loading).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith(record.id, { force: true, signal: expect.any(AbortSignal) });
  });
});
