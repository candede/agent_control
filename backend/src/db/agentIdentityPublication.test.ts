import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifiedAgentIdentityClientIdProvenance, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";
import { AgentIdentityRepository, type AgentIdentitySource } from "./agentIdentity.js";

const scope = { tenantId: "publication-tenant", principalId: "publication-reader" };
const source: AgentIdentitySource = {
  recordId: "agent:33333333-3333-4333-8333-333333333333", snapshotId: "11111111-1111-4111-8111-111111111111",
  nativeId: "native-agent", environmentId: "environment-a",
  candidateId: "22222222-2222-4222-8222-222222222222", sourceRevision: "a".repeat(64),
};
const mapping: VerifiedAgentIdentityIds = {
  objectId: source.candidateId, applicationId: source.candidateId, runtimeStatus: "available",
  runtimeProvenance: verifiedAgentIdentityClientIdProvenance,
};
const emptyResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };

function fixture(currentSource = 1, inserted = 1, finalSource = 1, failure = false, cachedSuccess = false) {
  const query = vi.fn<(statement: string, parameters?: unknown[]) => Promise<pg.QueryResult>>()
    .mockRejectedValue(new Error("Unexpected identity publication query."));
  const client = Object.assign(new pg.Client(), { query, release: vi.fn() });
  const connect = vi.fn(async () => client);
  const read = vi.fn<(statement: string, parameters?: unknown[]) => Promise<pg.QueryResult>>()
    .mockRejectedValue(new Error("Unexpected identity publication read."));
  const database = Object.assign(new pg.Pool({ max: 4 }), { connect, query: read });
  query.mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce({ ...emptyResult, rowCount: currentSource, rows: [{
      source_scope_id: "55555555-5555-4555-8555-555555555555", canonical_scope_id: "44444444-4444-4444-8444-444444444444",
    }] })
    .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id: "44444444-4444-4444-8444-444444444444" }] })
    .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id: "55555555-5555-4555-8555-555555555555" }] });
  if (failure) query.mockResolvedValueOnce({ ...emptyResult, rowCount: cachedSuccess ? 1 : 0 });
  if (!cachedSuccess) {
    query.mockResolvedValueOnce(emptyResult)
      .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ principal_count: 0, tenant_count: 0 }] })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: inserted })
      .mockResolvedValueOnce({ ...emptyResult, rowCount: finalSource });
  }
  query.mockResolvedValueOnce({ ...emptyResult, command: "COMMIT" });
  return { client, query, read, connect, repository: new AgentIdentityRepository(database) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("identity publication privilege and source fences", () => {
  it("returns only the current verified object/client mapping from a resolved cache row", async () => {
    const { repository, read, connect } = fixture();
    const checkedAt = new Date(), expiresAt = new Date(Date.now() + 60_000);
    read.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{
      candidate_id: mapping.objectId, application_id: mapping.applicationId, checked_at: checkedAt, expires_at: expiresAt,
      fresh: true, outcome: "resolved", runtime_status: "available", runtime_provenance: verifiedAgentIdentityClientIdProvenance,
      last_error_code: null,
    }] });
    await expect(repository.readState(scope, source)).resolves.toEqual({
      status: "resolved", checkedAt: checkedAt.toISOString(), expiresAt: expiresAt.toISOString(),
      value: { ...mapping, checkedAt: checkedAt.toISOString(), expiresAt: expiresAt.toISOString() },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires unexpired effective source authority for cache reads and competing identities", async () => {
    const { repository, read, connect } = fixture();
    read.mockResolvedValueOnce(emptyResult);
    await expect(repository.readState(scope, source)).resolves.toEqual({ status: "missing" });
    expect(read).toHaveBeenCalledOnce();
    const statement = read.mock.calls[0][0];
    expect(statement).toContain("membership.authority_expires_at>clock_timestamp()");
    expect(statement).toContain("other.authority_expires_at>clock_timestamp()");
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    { application_id: null },
    { application_id: "44444444-4444-4444-8444-444444444444" },
    { runtime_status: "unverified" },
    { runtime_provenance: null },
    { runtime_provenance: "unverified" },
  ])("rejects a resolved row without exact typed client-ID provenance: %j", async change => {
    const { repository, read, connect } = fixture();
    read.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{
      candidate_id: mapping.objectId, application_id: mapping.applicationId, checked_at: new Date(),
      expires_at: new Date(Date.now() + 60_000), fresh: true, outcome: "resolved",
      runtime_status: "available", runtime_provenance: verifiedAgentIdentityClientIdProvenance, last_error_code: null,
      ...change,
    }] });
    await expect(repository.readState(scope, source)).rejects.toMatchObject({ code: "invalid_agent_identity_cache" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["expired", "authorization_required", "not_found", "provider_error", "setup_required"] as const)(
    "never returns candidate IDs as verified mappings for %s cache state", async status => {
      const { repository, read } = fixture();
      read.mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{
        candidate_id: mapping.objectId, application_id: null, checked_at: new Date(),
        expires_at: new Date(Date.now() + 60_000), fresh: status !== "expired",
        outcome: status === "expired" ? "resolved" : status, runtime_status: "unverified",
        runtime_provenance: null, last_error_code: "fixture_error",
      }] });
      const state = await repository.readState(scope, source);
      expect(state).toMatchObject({ status, lastErrorCode: "fixture_error" });
      expect(state.value).toBeUndefined();
    },
  );

  it("rejects an all-zero internal snapshot before cache reads, invalidation or publication", async () => {
    const { repository, query, read, connect } = fixture();
    const invalid = { ...source, snapshotId: "00000000-0000-0000-0000-000000000000" };
    const fence = vi.fn(async () => {});
    for (const operation of [
      () => repository.readState(scope, invalid),
      () => repository.invalidate(scope, invalid),
      () => repository.save(scope, invalid, mapping, fence),
      () => repository.saveFailure(scope, invalid, { status: "not_found", code: "not_found" }, fence),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: "invalid_agent_identity_source" });
    }
    expect(read).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
  });

  it.each(["resolved", "not_found"] as const)("publishes %s using ordered current-scope locks and the exact live source predicate", async outcome => {
    const { repository, query, read, client } = fixture(1, 1, 1, outcome !== "resolved");
    const fence = vi.fn(() => {});
    if (outcome === "resolved") await repository.save(scope, source, mapping, fence);
    else await repository.saveFailure(scope, source, { status: outcome, code: "not_found" }, fence);

    expect(query.mock.calls[2][1]).toEqual([`data-sync:${scope.tenantId}`]);
    expect(query.mock.calls[3][1]).toEqual([`agent-identity:${scope.tenantId}`]);
    for (const index of [5, 6]) expect(query.mock.calls[index][0]).toMatch(/FROM data_scope_epochs.*FOR UPDATE$/);
    expect(query.mock.calls[5][1]).toEqual(["44444444-4444-4444-8444-444444444444", scope.tenantId]);
    expect(query.mock.calls[6][1]).toEqual(["55555555-5555-4555-8555-555555555555", scope.tenantId]);
    const insert = outcome === "resolved" ? 9 : 10;
    expect(query.mock.calls[insert][0]).toContain("INSERT INTO agent_identity_cache");
    for (const predicate of ["FROM inventory_live_sources membership", "membership.tenant_id=$1", "$2::text IS NOT NULL", "membership.source='power_platform'",
      "membership.authority_expires_at>clock_timestamp()", "other.authority_expires_at>clock_timestamp()",
      "resource.generation_id=$3", "membership.agent_id=substr($7,7)", "resource.native_id=$4", "resource.environment_id=$5",
      "resource.resource_type='microsoft.copilotstudio/agents'", "resource.residual->>'agentKind'='copilot_studio_agent'",
      "resource.residual->'provenance'->'entraAgentId'->>'sourceSystem'='power_platform'",
      "resource.residual->'provenance'->'entraAgentId'->>'path'='properties.entraAgentId'",
      "lower(identifier.value)=$6", "lower(identifier.value) IS DISTINCT FROM $6", "other.agent_id<>membership.agent_id"]) {
      for (const index of [4, insert, insert + 1]) expect(query.mock.calls[index][0]).toContain(predicate);
    }
    expect(query.mock.calls[insert][0]).toContain("$6::text::uuid");
    expect(query.mock.calls[insert][0]).toContain("membership.authority_expires_at");
    expect(fence).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[insert + 2][0]).toBe("COMMIT");
    expect(read).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects a source invalidated before current-scope locks are acquired", async () => {
    const { repository, query, client } = fixture(0);
    await expect(repository.save(scope, source, mapping, async () => {}))
      .rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(query.mock.calls[5][0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects a source invalidated between the locking read and insertion", async () => {
    const { repository, query, client } = fixture(1, 0);
    await expect(repository.save(scope, source, mapping, async () => {}))
      .rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(query.mock.calls[10][0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects expiry or source invalidation after the final authorization check", async () => {
    const { repository, query, client } = fixture(1, 1, 0);
    await expect(repository.save(scope, source, mapping, async () => {}))
      .rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(query.mock.calls[11][0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back rather than publishing after final authorization is revoked", async () => {
    const { repository, query, client } = fixture();
    const fence = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("session changed"); });
    await expect(repository.save(scope, source, mapping, fence)).rejects.toThrow("session changed");
    expect(query.mock.calls[10][0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rechecks authority synchronously before COMMIT after the final source query completes", async () => {
    const { repository, query, client } = fixture();
    const fence = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error("authority changed after final read"); });
    await expect(repository.save(scope, source, mapping, fence)).rejects.toThrow("authority changed after final read");
    expect(query.mock.calls[10][0]).toContain("SELECT snapshot.id");
    expect(query.mock.calls[11][0]).toBe("ROLLBACK");
    expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not replace a fresh exact-source success with a late failed lookup", async () => {
    const { repository, query, client } = fixture(1, 1, 1, true, true);
    const fence = vi.fn(() => {});
    await repository.saveFailure(scope, source, { status: "provider_error", code: "provider_timeout" }, fence);
    const guard = query.mock.calls[7];
    for (const predicate of ["tenant_id=$1", "principal_id=$2", "snapshot_id=$3", "native_id=$4", "environment_id=$5",
      "candidate_id=$6::uuid", "record_id=$7", "source_revision=$8", "outcome='resolved'", "expires_at>clock_timestamp()"]) {
      expect(guard[0]).toContain(predicate);
    }
    expect(guard[1]).toEqual([scope.tenantId, scope.principalId, source.snapshotId, source.nativeId,
      source.environmentId, source.candidateId, source.recordId, source.sourceRevision]);
    expect(query.mock.calls.some(([statement]) => /(?:INSERT INTO|DELETE FROM) agent_identity_cache/.test(String(statement)))).toBe(false);
    expect(query.mock.calls[8][0]).toBe("COMMIT");
    expect(fence).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
