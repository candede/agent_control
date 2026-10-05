import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifiedAgentIdentityClientIdProvenance, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";
import { AgentIdentityRepository, type AgentIdentitySource } from "./agentIdentity.js";
import { pool } from "./pool.js";

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

function fixture(currentSource = 1, inserted = 1, finalSource = 1) {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected identity publication query."));
  vi.spyOn(pool, "connect").mockResolvedValue(client);
  const read = vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected identity publication read."));
  query.mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce({ ...emptyResult, rowCount: currentSource, rows: [{
      source_scope_id: "55555555-5555-4555-8555-555555555555", canonical_scope_id: "44444444-4444-4444-8444-444444444444",
    }] })
    .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id: "44444444-4444-4444-8444-444444444444" }] })
    .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ id: "55555555-5555-4555-8555-555555555555" }] })
    .mockResolvedValueOnce(emptyResult)
    .mockResolvedValueOnce({ ...emptyResult, rowCount: 1, rows: [{ principal_count: 0, tenant_count: 0 }] })
    .mockResolvedValueOnce({ ...emptyResult, rowCount: inserted })
    .mockResolvedValueOnce({ ...emptyResult, rowCount: finalSource })
    .mockResolvedValueOnce(emptyResult);
  return { client, query, read, repository: new AgentIdentityRepository() };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("identity publication privilege and source fences", () => {
  it.each(["resolved", "not_found"] as const)("publishes %s using ordered current-scope locks and the exact live source predicate", async outcome => {
    const { repository, query, read, client } = fixture();
    const fence = vi.fn(async () => {});
    if (outcome === "resolved") await repository.save(scope, source, mapping, fence);
    else await repository.saveFailure(scope, source, { status: outcome, code: "not_found" }, fence);

    expect(query.mock.calls[2][1]).toEqual([`data-sync:${scope.tenantId}:${scope.principalId}`]);
    expect(query.mock.calls[3][1]).toEqual([`agent-identity:${scope.tenantId}`]);
    for (const index of [5, 6]) expect(query.mock.calls[index][0]).toMatch(/FROM data_scope_epochs.*FOR UPDATE$/);
    expect(query.mock.calls[5][1]).toEqual(["44444444-4444-4444-8444-444444444444", scope.tenantId]);
    expect(query.mock.calls[6][1]).toEqual(["55555555-5555-4555-8555-555555555555", scope.tenantId]);
    expect(query.mock.calls[9][0]).toContain("INSERT INTO agent_identity_cache");
    for (const predicate of ["FROM inventory_live_sources membership", "membership.tenant_id=$1", "membership.principal_id=$2", "membership.source='power_platform'",
      "resource.generation_id=$3", "membership.agent_id=substr($7,7)", "resource.native_id=$4", "resource.environment_id=$5",
      "resource.resource_type='microsoft.copilotstudio/agents'", "resource.residual->>'agentKind'='copilot_studio_agent'",
      "resource.residual->'provenance'->'entraAgentId'->>'sourceSystem'='power_platform'",
      "resource.residual->'provenance'->'entraAgentId'->>'path'='properties.entraAgentId'",
      "lower(identifier.value)=$6", "lower(identifier.value) IS DISTINCT FROM $6", "other.agent_id<>membership.agent_id"]) {
      for (const index of [4, 9, 10]) expect(query.mock.calls[index][0]).toContain(predicate);
    }
    expect(query.mock.calls[9][0]).toContain("$6::text::uuid");
    expect(query.mock.calls[9][0]).toContain("membership.authority_expires_at");
    expect(fence).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[11][0]).toBe("COMMIT");
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
    const fence = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("session changed"));
    await expect(repository.save(scope, source, mapping, fence)).rejects.toThrow("session changed");
    expect(query.mock.calls[10][0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
