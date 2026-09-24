import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AgentIdentityRepository, AgentIdentitySource } from "../db/agentIdentity.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import { verifiedAgentIdentityClientIdProvenance, type AgentInvestigationContext, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { CapabilityId } from "../types/capability.js";
import { AgentIdentityResolutionService } from "./agentIdentityResolution.js";
import type { GraphAgentIdentityClient } from "./graphAgentIdentity.js";
import type { CapabilityService } from "./capabilities.js";

const observeOperation: CapabilityService["observeOperation"] = async (_id, _user, operation) => operation(() => undefined);

const objectId = "11111111-1111-4111-8111-111111111111";
const applicationId = objectId;
const otherId = "22222222-2222-4222-8222-222222222222";
const resolvedIdentity: VerifiedAgentIdentityIds = { objectId, applicationId, runtimeStatus: "available",
  runtimeProvenance: verifiedAgentIdentityClientIdProvenance };
const recordId = "agent:33333333-3333-4333-8333-333333333333";

function setup() {
  const user: AuthenticatedUser = { tenantId: randomUUID(), homeAccountId: randomUUID(),
    displayName: "Fixture", username: "fixture@example.invalid", roles: ["AgentControl.Viewer"] };
  const source: AgentIdentitySource = { recordId, snapshotId: randomUUID(), nativeId: "native-agent", environmentId: "environment",
    candidateId: objectId, sourceRevision: "a".repeat(64) };
  const state: { inventoryRevision: string; identitySource?: AgentIdentitySource; context: AgentInvestigationContext } = {
    identitySource: source, inventoryRevision: "revision-1", context: { recordId, displayName: "Current agent",
      defender: { status: "unavailable", entraAgentIds: [], entraAgentApplicationIds: [],
        resolution: { canResolve: true, capabilityId: "graph.agentIdentity.read" } },
      purview: { status: "unavailable", mode: "saved_only" } },
  };
  const inventory = { resolve: vi.fn(async () => structuredClone(state)) };
  const repository = {
    invalidate: vi.fn<AgentIdentityRepository["invalidate"]>(async () => { state.context.defender.entraAgentIds = []; }),
    save: vi.fn<AgentIdentityRepository["save"]>(async (_scope, _source, value, fence) => {
      await fence();
      state.context.defender.entraAgentIds = [value.objectId];
      state.context.defender.entraAgentApplicationIds = value.applicationId ? [value.applicationId] : [];
      state.context.defender.status = "available";
      state.context.defender.resolution = { canResolve: true, capabilityId: "graph.agentIdentity.read",
        cacheStatus: "resolved", runtimeStatus: value.runtimeStatus, runtimeProvenance: value.runtimeProvenance };
    }),
    saveFailure: vi.fn<AgentIdentityRepository["saveFailure"]>(async (_scope, _source, failure, fence) => {
      await fence();
      state.context.defender.entraAgentIds = [];
      state.context.defender.entraAgentApplicationIds = [];
      state.context.defender.status = "unavailable";
      state.context.defender.resolution = { canResolve: true, capabilityId: "graph.agentIdentity.read",
        cacheStatus: failure.status, lastErrorCode: failure.code };
    }),
  };
  const directory = { resolve: vi.fn<GraphAgentIdentityClient["resolve"]>(async (_token, _candidate, _signal, beforeRequest) => {
    await beforeRequest();
    return resolvedIdentity;
  }) };
  const revalidateUser = vi.fn(async () => structuredClone(user));
  const delegatedToken = vi.fn(async () => "fixture");
  const requireAvailable = vi.fn(async (capabilityId: CapabilityId) => ({ capabilityId, status: "available" as const,
    authorized: true, fresh: true, verification: "on_demand" as const, previewQualification: "not_required" as const, remediation: [] }));
  const admissions = vi.fn(() => undefined);
  const service = new AgentIdentityResolutionService({ inventory, repository, directory, revalidateUser, delegatedToken, requireAvailable, admissions, observeOperation });
  return { user, source, state, inventory, repository, directory, revalidateUser, delegatedToken, requireAvailable, admissions, service };
}

describe("explicit saved-source identity resolution", () => {
  it("checks the same account/source before requests and publication, then returns only the saved context", async () => {
    const f = setup();
    const result = await f.service.resolve(f.user, recordId);
    expect(result.defender).toMatchObject({ status: "available", entraAgentIds: [objectId], entraAgentApplicationIds: [applicationId] });
    expect(f.delegatedToken).toHaveBeenCalledExactlyOnceWith(f.user.homeAccountId, "graph.agentIdentity.read");
    expect(f.directory.resolve).toHaveBeenCalledExactlyOnceWith("fixture", objectId, expect.any(AbortSignal), expect.any(Function));
    expect(f.repository.save).toHaveBeenCalledExactlyOnceWith({ tenantId: f.user.tenantId, principalId: f.user.homeAccountId },
      f.source, resolvedIdentity, expect.any(Function));
    expect(f.revalidateUser).toHaveBeenCalledTimes(3);
    expect(f.repository.invalidate).toHaveBeenCalledOnce();
    expect(f.inventory.resolve.mock.calls.length).toBeGreaterThan(4);
  });

  it("does not return a one-sided cached result after successful typed identity verification", async () => {
    const f = setup();
    f.repository.save.mockImplementation(async (_scope, _source, _identity, fence) => {
      await fence();
      f.state.context.defender.entraAgentIds = [objectId];
      f.state.context.defender.entraAgentApplicationIds = [];
    });
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
  });

  it("does not acquire tokens or call Graph for unsupported/invisible or unassigned targets", async () => {
    const f = setup();
    f.state.identitySource = undefined;
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ code: "agent_identity_resolution_unavailable" });
    await expect(f.service.resolve({ ...f.user, roles: [] }, recordId)).rejects.toMatchObject({ status: 403 });
    f.inventory.resolve.mockRejectedValue(new AppError(404, "agent_not_found", "Not visible"));
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status: 404 });
    expect(f.delegatedToken).not.toHaveBeenCalled();
    expect(f.directory.resolve).not.toHaveBeenCalled();
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it.each(["tenant", "account", "role", "snapshot", "candidate", "revision", "ambiguous"] as const)(
    "withholds results after %s changes during Graph resolution", async kind => {
      const f = setup();
      f.directory.resolve.mockImplementation(async (_token, _candidate, _signal, before) => {
        await before();
        if (kind === "tenant") f.user.tenantId = randomUUID();
        if (kind === "account") f.user.homeAccountId = randomUUID();
        if (kind === "role") f.user.roles = [];
        if (kind === "snapshot") f.state.identitySource!.snapshotId = randomUUID();
        if (kind === "candidate") f.state.identitySource!.candidateId = otherId;
        if (kind === "revision") f.state.inventoryRevision = "revision-2";
        if (kind === "ambiguous") f.state.identitySource = undefined;
        return resolvedIdentity;
      });
      await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status: ["tenant", "account", "role"].includes(kind) ? 403 : 409 });
      expect(f.repository.save).not.toHaveBeenCalled();
    },
  );

  it("rejects revoked sessions even after a successful provider read", async () => {
    const f = setup();
    f.directory.resolve.mockImplementation(async () => {
      await revokeAccountSessionMutations(f.user.tenantId!, f.user.homeAccountId, async () => {});
      return resolvedIdentity;
    });

    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status: 401 });
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it("rechecks the session epoch inside the final database publication fence", async () => {
    const f = setup();
    let revoked: Promise<void> | undefined;
    f.repository.save.mockImplementation(async (_scope, _source, _value, publicationFence) => {
      await publicationFence();
      // Revocation advances the epoch immediately, while its mutation waits behind this publication.
      revoked = revokeAccountSessionMutations(f.user.tenantId!, f.user.homeAccountId, async () => {});
      await publicationFence();
      throw new Error("Revoked publication was allowed");
    });
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status: 401 });
    await revoked;
    expect(f.state.context.defender.entraAgentIds).toEqual([]);
  });

  it("propagates consent and setup errors and never substitutes a broad permission", async () => {
    const f = setup();
    f.delegatedToken.mockRejectedValue(new AppError(403, "consent_required", "Consent required"));
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ code: "consent_required" });
    expect(f.directory.resolve).not.toHaveBeenCalled();
    expect(f.repository.save).not.toHaveBeenCalled();
    expect(f.delegatedToken).toHaveBeenCalledOnce();
    f.delegatedToken.mockResolvedValue("fixture");
    f.directory.resolve.mockRejectedValue(new AppError(403, "agent_identity_permission_required", "Role required"));
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ code: "agent_identity_permission_required" });
    expect(f.repository.invalidate).toHaveBeenCalledOnce();
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it.each([
    ["agent_identity_permission_required", 403, "authorization_required"], ["agent_identity_not_found", 404, "not_found"],
    ["provider_timeout", 504, "provider_error"], ["agent_identity_mismatch", 502, "provider_error"],
    ["auth_not_configured", 503, "setup_required"],
  ] as const)("persists the source-bound %s outcome but still rejects the explicit request", async (code, status, cacheStatus) => {
    const f = setup();
    f.directory.resolve.mockRejectedValue(new AppError(status, code, "Provider fixture"));
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status });
    expect(f.repository.saveFailure).toHaveBeenCalledWith({ tenantId: f.user.tenantId, principalId: f.user.homeAccountId },
      f.source, { status: cacheStatus, code }, expect.any(Function));
    expect(f.state.context.defender.resolution?.cacheStatus).toBe(cacheStatus);
    expect(f.repository.save).not.toHaveBeenCalled();
  });

  it("preserves a meaningful cached throttle diagnostic even when Graph omits an error code", async () => {
    const f = setup();
    f.directory.resolve.mockRejectedValue(new AppError(429, "graph_error", "Throttled"));
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status: 429 });
    expect(f.state.context.defender.resolution).toMatchObject({ cacheStatus: "provider_error", lastErrorCode: "provider_throttled" });
  });

  it("does not publish a cached denial when the source changed during the failed request", async () => {
    const f = setup();
    f.directory.resolve.mockImplementation(async () => {
      f.state.identitySource = undefined;
      throw new AppError(403, "agent_identity_permission_required", "Denied");
    });
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(f.repository.saveFailure).not.toHaveBeenCalled();
  });

  it("stops dispatch on changed admission and bounds concurrent operations per account", async () => {
    const f = setup();
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    f.directory.resolve.mockImplementation(async (_token, _candidate, _signal, before) => {
      await paused;
      await before();
      return resolvedIdentity;
    });
    const running = f.service.resolve(f.user, recordId);
    await vi.waitFor(() => expect(f.directory.resolve).toHaveBeenCalledOnce());
    await expect(f.service.resolve(f.user, recordId)).rejects.toMatchObject({ status: 429 });
    f.admissions.mockImplementation(() => { throw new AppError(503, "admissions_closed", "Read admission closed"); });
    release();
    await expect(running).rejects.toMatchObject({ code: "admissions_closed" });
    expect(f.repository.save).not.toHaveBeenCalled();
  });
});
