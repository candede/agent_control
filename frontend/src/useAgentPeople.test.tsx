import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import * as api from "./api/client";
import type { CapabilityView, UnifiedAgentRecord } from "./api/client";
import { CapabilityContext } from "./capabilityContext";
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

function authorized({ children }: { children: ReactNode }) {
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
    views: [directory], user: { tenantId: "tenant", homeAccountId: "reader", username: "reader@example.invalid",
      displayName: "Reader", roles: ["AgentControl.Viewer"] },
    now, loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}>{children}</CapabilityContext>;
}

afterEach(() => vi.restoreAllMocks());

describe("authoritative saved agent people responses", () => {
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

  it("automatically refreshes newly expired returned people even when another field was omitted", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const createdBy = { ...savedPerson, objectId: creatorId, expiresAt: new Date(now + 1_000).toISOString() };
    const lookup = vi.spyOn(api, "resolveAgentPeople")
      .mockResolvedValueOnce({ people: { createdBy }, changed: true })
      .mockResolvedValue({ people: undefined, changed: false });
    const { result, rerender } = renderHook(() => useAgentPeople(record, ["AgentControl.Viewer"]), { wrapper: authorized });
    await waitFor(() => expect(result.current.people.createdBy?.displayName).toBe("Saved owner"));
    expect(result.current.people.owner?.status).toBe("unverified");
    expect(lookup).toHaveBeenCalledOnce();
    vi.mocked(Date.now).mockReturnValue(now + 2_000);
    rerender();
    await waitFor(() => expect(result.current.people.createdBy?.status).toBe("unverified"));
    expect(result.current.loading).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith(record.id, { signal: expect.any(AbortSignal) });
  });
});
