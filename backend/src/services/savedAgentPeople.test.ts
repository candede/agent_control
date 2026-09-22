import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPeopleRepository } from "../db/agentPeople.js";
import { DataSyncRepository, type SavedCopilotUsageSource } from "../db/dataSync.js";
import type { CopilotDirectoryUser } from "./copilotUsageGraph.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { agentColumnValue } from "../types/agentPresentation.js";
import { SavedAgentPeopleService } from "./savedAgentPeople.js";

const scope = { tenantId: "people-tenant", principalId: "people-reader" };
const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observedAt = "2026-09-15T10:00:00.000Z";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.spyOn(AgentPeopleRepository.prototype, "read").mockResolvedValue([]);
});

function directoryUser(id = firstId, displayName: string | null = "Saved Person"): CopilotDirectoryUser {
  return {
    identity: {
      objectId: id, displayName, userPrincipalName: "saved#EXT#@example.onmicrosoft.com",
      accountEnabled: true, userType: "Guest", employeeType: null, department: null, companyName: null,
    },
    serviceEvidenceVersion: 1, copilotServiceState: "unknown", servicePlans: [],
  };
}

function source(value: CopilotDirectoryUser[] | null = [directoryUser()]): SavedCopilotUsageSource<CopilotDirectoryUser[]> {
  return {
    source: "directory", attemptStatus: "available", message: "Saved directory.", attemptedAt: observedAt,
    lastSuccessAt: observedAt, rowCount: value?.length ?? null, observedAt: value ? observedAt : null, value,
  };
}

function record(ownerId = firstId, createdBy: string | null = firstId, lastModifiedBy = firstId): UnifiedAgentRecord {
  return {
    id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Agent", presence: "power_platform",
    environmentId: "environment", packages: [],
    powerPlatformResource: {
      tenantId: scope.tenantId, nativeId: "native", type: "microsoft.copilotstudio/agents",
      environmentId: "environment", location: null, displayName: "Agent", createdAt: null,
      createdBy, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null,
      creatorType: "unknown", agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native",
      identifiers: [], provenance: {}, details: { ownerId, lastModifiedBy }, unknownFieldCount: 0,
    },
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
  };
}

describe("saved directory agent people", () => {
  it("projects unlicensed cached people and honors newer conclusive results over older roster names", async () => {
    const cache = new AgentPeopleRepository();
    vi.mocked(cache.read).mockResolvedValue([
      { objectId: firstId, status: "not_found", displayName: null, userPrincipalName: null,
        observedAt: "2026-09-16T10:00:00.000Z", checkedAt: "2026-09-16T10:00:00.000Z", lastConclusiveAt: "2026-09-16T10:00:00.000Z" },
      { objectId: secondId, status: "resolved", displayName: "Unlicensed Creator", userPrincipalName: null, observedAt, lastConclusiveAt: observedAt },
    ]);
    const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => source()) }, cache);
    const [value] = await service.project(scope, [record(firstId, secondId)]);
    expect(value.people?.owner).toMatchObject({ status: "not_found", displayName: null });
    expect(value.people?.createdBy).toMatchObject({ displayName: "Unlicensed Creator", userPrincipalName: null });
  });

  it.each([true, false])("retains the newest known identity on failed lookup with previous cache %s", async hasPrevious => {
    const cache = new AgentPeopleRepository();
    vi.mocked(cache.read).mockResolvedValue([
      { objectId: firstId, status: "lookup_failed", displayName: hasPrevious ? "Old name" : null, userPrincipalName: null,
        observedAt: hasPrevious ? "2026-09-14T10:00:00.000Z" : "2026-09-16T10:00:00.000Z", checkedAt: "2026-09-16T10:00:00.000Z",
        lastConclusiveAt: hasPrevious ? "2026-09-14T10:00:00.000Z" : null, errorCode: "provider_timeout" },
    ]);
    const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => source()) }, cache);
    expect((await service.project(scope, [record()]))[0].people?.owner).toMatchObject({
      displayName: "Saved Person", status: "lookup_failed", observedAt, errorCode: "provider_timeout",
    });
  });

  it("uses only exact case-normalized GUIDs, consistent observations and existing snapshot clients without provider calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider requests are forbidden."));
    const getDirectorySource = vi.fn(async () => source([directoryUser(firstId.toUpperCase())]));
    const service = new SavedAgentPeopleService({ getDirectorySource });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const native = record(firstId.toUpperCase(), firstId, firstId.toUpperCase());
    const linked = { ...native, id: "linked", presence: "both" as const, packages: [{ id: "package", displayName: "Linked", isBlocked: false }] };
    const result = await service.project(scope, [native, linked], client);
    const person = { objectId: firstId, displayName: "Saved Person", userPrincipalName: "saved#EXT#@example.onmicrosoft.com", observedAt };
    expect(getDirectorySource).toHaveBeenCalledExactlyOnceWith(scope, client);
    expect(AgentPeopleRepository.prototype.read).toHaveBeenCalledExactlyOnceWith(scope, [firstId], client);
    for (const value of result) {
      expect(value.people).toEqual({ owner: person, createdBy: person, lastModifiedBy: person });
      expect(value.people?.owner).toBe(value.people?.createdBy);
      expect(value.people?.owner).toBe(value.people?.lastModifiedBy);
      expect(value.powerPlatformResource).toBe(native.powerPlatformResource);
      expect(value.identity).toBe(native.identity);
    }
    expect(result[1].packages).toBe(linked.packages);
    expect(native.people).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not guess identities from names, UPNs, report-like identifiers or partial GUIDs", async () => {
    const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => source()) });
    const values = [
      record("Saved Person", "saved#EXT#@example.onmicrosoft.com", firstId.slice(1)),
      record(secondId, null, `{${firstId}}`),
      { ...record(), powerPlatformResource: null, presence: "graph_packages" as const },
    ];
    expect((await service.project(scope, values)).every(value => value.people === undefined)).toBe(true);
  });

  it.each([null, "available", "failed", "permission_required", "waiting_authorization"] as const)(
    "keeps native IDs usable without a current observation after status %s", async attemptStatus => {
      const unavailable = { ...source(null), attemptStatus };
      const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => unavailable) });
      const native = record();
      const [result] = await service.project(scope, [native]);
      expect(result).toEqual(native);
      expect(result.people).toBeUndefined();
    },
  );

  it("retains a valid saved observation after a failed refresh without presenting it as newly observed", async () => {
    const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => ({
      ...source(), attemptStatus: "failed", attemptedAt: "2026-09-20T10:00:00.000Z",
    })) });
    expect((await service.project(scope, [record()]))[0].people?.owner?.observedAt).toBe(observedAt);
  });

  it("removes previous enrichment when a subsequent current directory observation has no exact match", async () => {
    const getDirectorySource = vi.fn().mockResolvedValueOnce(source()).mockResolvedValue(source([]));
    const service = new SavedAgentPeopleService({ getDirectorySource });
    const before = await service.project(scope, [record()]);
    expect(before[0].people?.owner).toBeDefined();
    expect((await service.project(scope, before))[0].people).toBeUndefined();
  });

  it("preserves null display names and UPNs as UPNs, without manufacturing an email", async () => {
    const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => source([directoryUser(firstId, null)])) });
    expect((await service.project(scope, [record()]))[0].people?.owner).toEqual({
      objectId: firstId, displayName: null, userPrincipalName: "saved#EXT#@example.onmicrosoft.com", observedAt,
    });
  });

  it.each([
    { value: {} },
    { value: [null] },
    { value: [{ ...directoryUser(), identity: null }] },
    { value: [{ ...directoryUser(), identity: { ...directoryUser().identity, objectId: "not-a-guid" } }] },
    { value: [{ ...directoryUser(), identity: { ...directoryUser().identity, userPrincipalName: "" } }] },
    { value: [{ ...directoryUser(), identity: { ...directoryUser().identity, displayName: 1 } }] },
    { value: [{ ...directoryUser(), copilotServiceState: null }] },
    { value: [{ ...directoryUser(), copilotServiceState: "assigned" }] },
    { value: [{ identity: directoryUser().identity, licenses: [], servicePlans: [] }] },
    { value: [directoryUser(), directoryUser(firstId.toUpperCase())], rowCount: 2 },
    { rowCount: 2 },
    { observedAt: null },
    { observedAt: "invalid-date" },
    { source: "app_activity" },
  ])("rejects malformed or ambiguous saved data explicitly: %j", async invalid => {
    const getDirectorySource = vi.fn(async () => ({ ...source(), ...invalid }) as SavedCopilotUsageSource<CopilotDirectoryUser[]>);
    await expect(new SavedAgentPeopleService({ getDirectorySource }).project(scope, [record()]))
      .rejects.toMatchObject({ status: 409, code: "copilot_usage_snapshot_invalid" });
  });

  it("enforces the saved snapshot row bound and propagates repository failures", async () => {
    const getDirectorySource = vi.fn(async () => source(Array.from({ length: 100_001 }, () => directoryUser())));
    await expect(new SavedAgentPeopleService({ getDirectorySource }).project(scope, [record()]))
      .rejects.toMatchObject({ status: 413, code: "copilot_usage_snapshot_limit" });
    getDirectorySource.mockRejectedValueOnce(new Error("Saved directory database unavailable."));
    await expect(new SavedAgentPeopleService({ getDirectorySource }).project(scope, [record()]))
      .rejects.toThrow("Saved directory database unavailable.");
  });

  it("refuses inventory from another tenant", async () => {
    const native = record();
    native.powerPlatformResource!.tenantId = "other-tenant";
    await expect(new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => source()) }).project(scope, [native]))
      .rejects.toMatchObject({ code: "scope_mismatch" });
  });
});

describe("saved directory repository query", () => {
  it.each([
    { snapshot: { serviceEvidenceVersion: 1, users: [] }, users: [] },
    { snapshot: { serviceEvidenceVersion: 1, users: [directoryUser()] }, users: [directoryUser()] },
  ])("reads only current service snapshots, including verified empty ones: %#", async ({ snapshot, users }) => {
    const database = new pg.Pool();
    vi.spyOn(database, "query").mockResolvedValue({
      rows: [{
        source_id: "directory", attempt_status: "available", observed_at: new Date(observedAt),
        snapshot_data: snapshot, row_count: users.length,
      }], rowCount: 1, command: "SELECT", oid: 0, fields: [],
    });
    const saved = await new DataSyncRepository(database).getDirectorySource(scope);
    expect(saved).toMatchObject({ value: users, rowCount: users.length });
    expect((await new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => saved) }).project(scope, [record()]))[0].people?.owner?.displayName)
      .toBe(users.length ? "Saved Person" : undefined);
    await database.end();
  });

  it.each([
    [], [directoryUser()], {}, { serviceEvidenceVersion: 2, users: [] }, { serviceEvidenceVersion: 1, users: null },
    { serviceEvidenceVersion: 1, users: [{ identity: directoryUser().identity, licenses: [], servicePlans: [] }] },
    { serviceEvidenceVersion: 1, users: [{ ...directoryUser(), copilotServiceState: "assigned" }] },
  ])(
    "rejects unsupported saved service envelopes explicitly: %j", async snapshot => {
      const database = new pg.Pool();
      vi.spyOn(database, "query").mockResolvedValue({
        rows: [{ source_id: "directory", snapshot_data: snapshot }], rowCount: 1, command: "SELECT", oid: 0, fields: [],
      });
      await expect(new DataSyncRepository(database).getDirectorySource(scope))
        .rejects.toMatchObject({ code: "copilot_usage_snapshot_invalid" });
      await database.end();
    },
  );

  it("persists a versioned Copilot service snapshot without changing its user row count", async () => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockResolvedValue(client);
    const query = vi.spyOn(client, "query").mockResolvedValue({ rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] });
    const users = [directoryUser()];
    await new DataSyncRepository(database).publishDirectory(scope, users, observedAt, "Saved Copilot services.");
    const insert = query.mock.calls.find(call => String(call[0]).includes("INSERT INTO copilot_usage_snapshots"));
    expect(insert).toBeDefined();
    expect(insert?.[1]?.[5]).toBe(1);
    expect(JSON.parse(String(insert?.[1]?.[4]))).toEqual({ serviceEvidenceVersion: 1, users });
    expect(query.mock.calls.some(call => call[0] === "COMMIT")).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
    await database.end();
  });

  it("uses only the exact scoped current unexpired directory pointer on the supplied snapshot client", async () => {
    const database = new pg.Pool();
    const unexpected = vi.spyOn(database, "query").mockRejectedValue(new Error("Do not use a different database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
    const saved = await new DataSyncRepository(database).getDirectorySource(scope, client);
    expect(saved).toMatchObject({ source: "directory", value: null, observedAt: null });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [scope.tenantId, scope.principalId, ["directory"]]);
    const sql = String(query.mock.calls[0][0]);
    for (const condition of [
      "snapshot.id=state.current_snapshot_id", "snapshot.tenant_id=state.tenant_id",
      "snapshot.principal_id=state.principal_id", "snapshot.source_id=state.source_id",
      "snapshot.is_current", "snapshot.expires_at>clock_timestamp()",
      "state.tenant_id=$1", "state.principal_id=$2", "state.source_id=ANY($3::text[])",
    ]) expect(sql).toContain(condition);
    expect(unexpected).not.toHaveBeenCalled();
    await database.end();
  });
});

describe("saved agent people cache precedence", () => {
  it("retains the prior not-found check time when a failed lookup replaces the cache result", async () => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockResolvedValue(client);
    const empty = { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    const query = vi.spyOn(client, "query").mockResolvedValue(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({ ...empty, rows: [{ generation: "initial" }], rowCount: 1 })
      .mockResolvedValueOnce({ ...empty, rows: [{ count: 0 }], rowCount: 1 });
    try {
      await new AgentPeopleRepository(database).save(scope, [{
        objectId: firstId, status: "lookup_failed", displayName: null, userPrincipalName: null,
        checkedAt: observedAt, errorCode: "provider_timeout",
      }], { generation: "initial" });
      const insert = query.mock.calls.find(call => String(call[0]).includes("INSERT INTO agent_people_cache"));
      expect(insert).toBeDefined();
      expect(String(insert?.[0])).toContain(`resolved_at=CASE WHEN EXCLUDED.status='lookup_failed' THEN
              CASE WHEN agent_people_cache.status='not_found' THEN agent_people_cache.checked_at ELSE agent_people_cache.resolved_at END`);
      expect(query).toHaveBeenLastCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      await database.end();
    }
  });

  it.each([
    { lastConclusiveAt: null, expectedName: "Saved Person", expectedObservedAt: observedAt },
    { lastConclusiveAt: "2026-09-14T10:00:00.000Z", expectedName: "Saved Person", expectedObservedAt: observedAt },
    { lastConclusiveAt: observedAt, expectedName: null, expectedObservedAt: observedAt },
    { lastConclusiveAt: "2026-09-16T10:00:00.000Z", expectedName: null, expectedObservedAt: "2026-09-16T10:00:00.000Z" },
    { lastConclusiveAt: "2026-09-18T10:00:00.000Z", expectedName: null, expectedObservedAt: "2026-09-18T10:00:00.000Z" },
  ])("does not resurrect older labels after a conclusive nameless observation at $lastConclusiveAt", async ({
    lastConclusiveAt, expectedName, expectedObservedAt,
  }) => {
    vi.mocked(AgentPeopleRepository.prototype.read).mockRestore();
    const database = new pg.Pool();
    const checkedAt = "2026-09-18T10:00:00.000Z";
    const expiresAt = "2026-09-18T10:15:00.000Z";
    const query = vi.spyOn(database, "query").mockResolvedValue({
      rows: [{
        object_id: firstId, status: "lookup_failed", display_name: null, user_principal_name: null,
        checked_at: new Date(checkedAt), resolved_at: lastConclusiveAt ? new Date(lastConclusiveAt) : null,
        expires_at: new Date(expiresAt), error_code: "provider_timeout",
      }], rowCount: 1, command: "SELECT", oid: 0, fields: [],
    });
    try {
      const service = new SavedAgentPeopleService({ getDirectorySource: vi.fn(async () => source()) },
        new AgentPeopleRepository(database));
      const [value] = await service.project(scope, [record()]);
      expect(value.people?.owner).toEqual({
        objectId: firstId, status: "lookup_failed", displayName: expectedName,
        userPrincipalName: expectedName ? directoryUser().identity.userPrincipalName : null,
        observedAt: expectedObservedAt, checkedAt, expiresAt, errorCode: "provider_timeout",
      });
      for (const field of ["owner", "createdBy"] as const) {
        expect(agentColumnValue(value, field)).toBe(expectedName
          ? `${expectedName} (${directoryUser().identity.userPrincipalName}) (lookup failed)` : `${firstId} (lookup failed)`);
      }
      expect(query).toHaveBeenCalledExactlyOnceWith(expect.any(String), [scope.tenantId, scope.principalId, [firstId]]);
    } finally {
      await database.end();
    }
  });
});
