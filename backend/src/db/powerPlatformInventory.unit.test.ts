import pg from "pg";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExactInventoryIdentity, type InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { powerPlatformResourceTypes, type InventoryRoleScope, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

const scope = { tenantId: "tenant-a", principalId: "reader-a" };
const agentType = "microsoft.copilotstudio/agents";
const environmentType = "microsoft.powerplatform/environments";
const snapshotId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const database = new pg.Pool();
  const snapshot = {
    id: snapshotId, role_scope: "full", environment_scope: "", requested_types: [agentType], queried_types: [agentType],
    observed_count: 1, total_records: 1, page_count: 1, unknown_field_count: 0,
    observed_at: new Date(Date.now() - 1_000), expires_at: new Date(Date.now() + 60_000), selected_type: agentType,
  };
  const resource = { native_id: "native-a", resource_type: agentType, environment_id: "environment-a",
    identifiers: [{ kind: "cds_bot_id", value: botId }] };
  const state = { selected: [snapshot] };
  const response = (rows: object[]) => ({ rows, rowCount: rows.length, command: "", oid: 0, fields: [] });
  const query = vi.fn(async (text: unknown) => {
    if (typeof text !== "string") throw new Error("Expected a SQL query.");
    if (text.includes("SELECT DISTINCT ON (queried.type)")) return response(structuredClone(state.selected));
    if (text.includes("SELECT DISTINCT native_id")) return response([resource]);
    if (text.includes("AS unique_count")) return response([{
      snapshot_id: snapshot.id, resource_type: agentType, count: 1, unique_count: 1, environment_matches: true,
    }]);
    throw new Error("Unexpected identity-read query.");
  });
  vi.spyOn(database, "query").mockImplementation(query);
  return { database, repository: new PowerPlatformInventoryRepository(database), query, snapshot, state };
}

describe("current inventory identity candidates without a database", () => {
  it("resolves verified current candidates and uses the supplied reader for every query", async () => {
    const f = fixture();
    const candidates = await new PowerPlatformInventoryRepository().readIdentityCandidates(scope, [agentType], f.database);
    const source: InventoryIdentityRecord = { tenantId: scope.tenantId, nativeId: "audit-record",
      environmentId: "environment-a", sourceSystem: "power_platform", resourceType: agentType,
      identifiers: [{ kind: "cds_bot_id", value: botId }] };
    expect(resolveExactInventoryIdentity(source, candidates)).toMatchObject({
      status: "resolved", candidate: { nativeId: "native-a" }, matchedKind: "cds_bot_id",
    });
    expect(f.database.query).toHaveBeenCalledTimes(4);
    for (const [, values] of vi.mocked(f.database.query).mock.calls) {
      expect(values).toEqual(expect.arrayContaining([scope.tenantId, scope.principalId]));
    }
  });

  it.each(["resource", "verification"] as const)("rejects replacement during the awaited %s read", async stage => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const result = await query(text);
      if (typeof text === "string" && text.includes(stage === "resource" ? "SELECT DISTINCT native_id" : "AS unique_count")) {
        f.state.selected = [{ ...f.snapshot, id: "33333333-3333-4333-8333-333333333333" }];
      }
      return result;
    });
    await expect(f.repository.readIdentityCandidates(scope, [agentType])).rejects.toMatchObject({
      status: 409, code: "snapshot_invalidated",
    });
  });

  it.each(["withdrawn", "additional type", "reassigned type"] as const)("rejects a %s selection after verification", async change => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async text => {
      const result = await query(text);
      if (typeof text === "string" && text.includes("AS unique_count")) {
        f.state.selected = change === "withdrawn" ? []
          : change === "additional type" ? [f.snapshot, { ...f.snapshot, selected_type: environmentType }]
            : [{ ...f.snapshot, selected_type: environmentType }];
      }
      return result;
    });
    await expect(f.repository.readIdentityCandidates(scope, [agentType, environmentType])).rejects.toMatchObject({
      status: 409, code: "snapshot_invalidated",
    });
  });

  it.each(["verification", "final selection"] as const)("rejects expiry during the awaited %s read", async stage => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    const clock = vi.spyOn(Date, "now");
    let selections = 0;
    f.query.mockImplementation(async text => {
      const result = await query(text);
      if (typeof text === "string") {
        if (text.includes("SELECT DISTINCT ON (queried.type)")) selections += 1;
        if (stage === "verification" && text.includes("AS unique_count") || stage === "final selection" && selections === 2) {
          clock.mockReturnValue(f.snapshot.expires_at.getTime());
        }
      }
      return result;
    });
    await expect(f.repository.readIdentityCandidates(scope, [agentType])).rejects.toMatchObject({
      status: 409, code: "snapshot_invalidated",
    });
  });

  it("does not mask failures in the final selection read", async () => {
    const f = fixture();
    const query = f.query.getMockImplementation()!;
    const failure = new Error("Inventory selection failed.");
    let selections = 0;
    f.query.mockImplementation(async text => {
      if (typeof text === "string" && text.includes("SELECT DISTINCT ON (queried.type)") && ++selections === 2) throw failure;
      return query(text);
    });
    await expect(f.repository.readIdentityCandidates(scope, [agentType])).rejects.toBe(failure);
  });

  it("returns no candidates when no current authorized snapshot was selected", async () => {
    const f = fixture();
    f.state.selected = [];
    await expect(f.repository.readIdentityCandidates(scope, [agentType])).resolves.toEqual([]);
    expect(f.database.query).toHaveBeenCalledOnce();
  });
});

function refreshFixture(roleScope: InventoryRoleScope = "full") {
  const database = new pg.Pool();
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const empty = { rows: [], rowCount: 0, command: "", oid: 0, fields: [] };
  const job = {
    id: "33333333-3333-4333-8333-333333333333", role_scope: roleScope, environment_scope: "",
    requested_types: [...powerPlatformResourceTypes], status: "running",
    page_count: 0, observed_count: 0, total_records: null, unknown_field_count: 0,
    snapshot_id: null, error_code: null, message: null,
    created_at: new Date(), attempted_at: new Date(), updated_at: new Date(), finished_at: null,
    request_hash: createHash("sha256").update(JSON.stringify({
      cloud: "global", roleScope, environmentScope: "", requestedTypes: powerPlatformResourceTypes,
    })).digest("hex"),
  };
  const query = vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected refresh query."));
  vi.spyOn(database, "connect").mockResolvedValue(client);
  const read = vi.spyOn(database, "query").mockResolvedValue({ ...empty, rows: [job], rowCount: 1 });
  return { job, client, query, read, empty, repository: new PowerPlatformInventoryRepository(database) };
}

describe("inventory request identity without a database", () => {
  it.each(["full", "ai", "unknown"] as const)("replays a retained %s request after its optional role hint changes", async roleScope => {
    const f = refreshFixture(roleScope);
    f.query.mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty)
      .mockResolvedValueOnce({ ...f.empty, rows: [f.job], rowCount: 1 }).mockResolvedValueOnce(f.empty);
    await expect(f.repository.submit(scope, {
      idempotencyKey: "retained", roleScope: roleScope === "unknown" ? "full" : "unknown",
      requestedTypes: [...powerPlatformResourceTypes].reverse(),
    })).resolves.toMatchObject({ id: f.job.id, roleScope });
    expect(f.query.mock.calls.some(([sql]) => String(sql).includes("INSERT"))).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith("COMMIT");
  });

  it.each([
    { environmentScope: "environment-a", requestedTypes: powerPlatformResourceTypes },
    { environmentScope: undefined, requestedTypes: [agentType] as PowerPlatformResourceType[] },
  ])("still rejects a replay with different request scope: %j", async input => {
    const f = refreshFixture();
    f.query.mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty)
      .mockResolvedValueOnce({ ...f.empty, rows: [f.job], rowCount: 1 }).mockResolvedValueOnce(f.empty);
    await expect(f.repository.submit(scope, { idempotencyKey: "retained", roleScope: "full", ...input }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("rejects an expired replay rather than returning an undefined accepted job", async () => {
    const f = refreshFixture();
    f.query.mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty)
      .mockResolvedValueOnce({ ...f.empty, rows: [f.job], rowCount: 1 }).mockResolvedValueOnce(f.empty);
    f.read.mockResolvedValueOnce(f.empty);
    await expect(f.repository.submit(scope, {
      idempotencyKey: "expired", roleScope: "full", requestedTypes: powerPlatformResourceTypes,
    })).rejects.toMatchObject({ status: 409, code: "inventory_job_expired" });
    expect(f.query.mock.calls.some(([sql]) => String(sql).includes("INSERT"))).toBe(false);
  });

  it.each(["full", "ai", "unknown"] as const)("uses one query hash when submitting a new %s request", async roleScope => {
    const f = refreshFixture(roleScope);
    f.query.mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty)
      .mockResolvedValueOnce({ ...f.empty, rows: [{ count: 0 }], rowCount: 1 })
      .mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty);
    await f.repository.submit(scope, { idempotencyKey: "new", roleScope, requestedTypes: powerPlatformResourceTypes });
    const hash = createHash("sha256").update(JSON.stringify({
      cloud: "global", environmentScope: "", requestedTypes: powerPlatformResourceTypes,
    })).digest("hex");
    expect(f.query.mock.calls[4][1]).toEqual([
      expect.any(String), scope.tenantId, scope.principalId, "new", hash, roleScope, "", JSON.stringify(powerPlatformResourceTypes),
    ]);
  });

  it("checks newer work by requested types and environment, independent of retained role-derived hashes", async () => {
    const f = refreshFixture();
    f.query.mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty)
      .mockResolvedValueOnce({ ...f.empty, rows: [f.job], rowCount: 1 })
      .mockResolvedValueOnce({ ...f.empty, rows: [{ id: "newer-ai-hint-job" }], rowCount: 1 })
      .mockResolvedValueOnce(f.empty);
    await expect(f.repository.publish(scope, f.job.id, {
      resources: [], queriedTypes: [...powerPlatformResourceTypes], environmentScope: null,
      totalRecords: 0, pages: 1, unknownFieldCount: 0,
    })).rejects.toMatchObject({ code: "inventory_job_superseded" });
    const [sql, values] = f.query.mock.calls[3];
    expect(sql).toContain("environment_scope=$3");
    expect(sql).toContain("requested_types=$4::jsonb");
    expect(sql).toContain("status IN ('running','succeeded')");
    expect(sql).not.toContain("request_hash=");
    expect(sql).not.toContain("role_scope=");
    expect(values).toEqual([scope.tenantId, scope.principalId, "", JSON.stringify(powerPlatformResourceTypes), f.job.id]);
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["full", "ai", "unknown"] as const)("replaces equivalent snapshots across role hints when publishing a retained %s job", async roleScope => {
    const f = refreshFixture(roleScope);
    f.query.mockResolvedValueOnce(f.empty).mockResolvedValueOnce(f.empty)
      .mockResolvedValueOnce({ ...f.empty, rows: [f.job], rowCount: 1 });
    for (let index = 0; index < 5; index += 1) f.query.mockResolvedValueOnce(f.empty);
    await f.repository.publish(scope, f.job.id, {
      resources: [], queriedTypes: [...powerPlatformResourceTypes], environmentScope: null,
      totalRecords: 0, pages: 1, unknownFieldCount: 0,
    });
    const [sql, values] = f.query.mock.calls[4];
    expect(sql).toContain("SET is_current=false");
    expect(sql).toContain("environment_scope=$3");
    expect(sql).toContain("requested_types=$4::jsonb");
    expect(sql).not.toContain("query_hash=");
    expect(sql).not.toContain("role_scope=");
    expect(values).toEqual([scope.tenantId, scope.principalId, "", JSON.stringify(powerPlatformResourceTypes)]);
    const hash = createHash("sha256").update(JSON.stringify({
      cloud: "global", environmentScope: "", requestedTypes: powerPlatformResourceTypes,
    })).digest("hex");
    expect(f.query.mock.calls[5][1]).toEqual([
      expect.any(String), f.job.id, scope.tenantId, scope.principalId, hash, roleScope, "",
      JSON.stringify(powerPlatformResourceTypes), JSON.stringify(powerPlatformResourceTypes), 0, 0, 1, 0,
    ]);
    expect(f.query).toHaveBeenLastCalledWith("COMMIT");
    expect(f.client.release).toHaveBeenCalledOnce();
  });
});
