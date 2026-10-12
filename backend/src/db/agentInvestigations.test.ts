import { createHash } from "node:crypto";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { DefenderHuntingRepository, huntingTargetScopeHash, type DefenderHuntingReadScope } from "./defenderHunting.js";
import { PurviewAuditRepository } from "./purviewAudit.js";
import { LiveInventory } from "./liveInventory.js";
import type { DefenderHuntingFilters } from "../types/defenderHunting.js";
import { AgentInvestigationsService } from "../services/agentInvestigations.js";
import type { AgentIdentityCacheState } from "./agentIdentity.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";

const entra = "11111111-1111-4111-8111-111111111111";
const bot = "22222222-2222-4222-8222-222222222222";
const resultScope = { kind: "principal" as const, scopeId: "reader-a", configurationRevision: null };
const scope: DefenderHuntingReadScope = {
  tenantId: "tenant-a", authorizationPrincipalId: "reader-a", resultScopes: [resultScope], entraAgentIds: [entra],
  qualifications: [{ resultScope, authority: { capabilityId: "defender.hunting.delegated", configurationRevision: 1, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64) } }],
};
const filters: DefenderHuntingFilters = { templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z",
  agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] };

function database() {
  const query = vi.fn(async (sql: string, _values: unknown[]) => ({
    rows: sql.includes("count(*)") ? [{ count: 0 }] : [], rowCount: 0,
  }));
  return { query };
}

function expectExactFilter(sql: string, values: unknown[], column: string) {
  expect(sql).toContain(`${column}->'entraAgentIds'=$${values.indexOf(JSON.stringify([entra])) + 1}::jsonb`);
  expect(sql).toContain(`${column}->'agentIds'='[]'::jsonb`);
  expect(sql).toContain(`${column}->'blueprintIds'='[]'::jsonb`);
}

describe("agent-scoped saved-query isolation", () => {
  it("reports an unavailable saved agent without suggesting refresh will restore it", async () => {
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
    await expect(new LiveInventory().record({ tenantId: "tenant-a", principalId: "reader-a" }, `agent:${entra}`,
      { client, evaluatedAt: new Date() })).rejects.toMatchObject({
      status: 404, code: "agent_not_found", message: "This agent is not available in the current saved inventory.",
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each(["entra_app_id", "entra_agent_id"] as const)(
    "withholds %s investigation scope when another environment changes during the identity read", async kind => {
      const database = new pg.Pool({ max: 4 });
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const connect = vi.spyOn(database, "connect").mockResolvedValue(client);
      const now = new Date(), expiresAt = new Date(now.getTime() + 60_000);
      let inventoryRevision = "1", changed = false;
      const query = vi.spyOn(client, "query").mockImplementation(async (sql: string) => {
        let rows: pg.QueryResultRow[] = [];
        if (sql.includes("SELECT clock_timestamp() AS now")) rows = [{ now }];
        else if (sql.includes("selected AS")) rows = [{
          identity: entra, generation_id: "33333333-3333-4333-8333-333333333333",
          inventory_baseline_id: "44444444-4444-4444-8444-444444444444", inventory_revision: inventoryRevision,
          display_name: "Saved agent", environment_id: "environment-a", link_state: "unmatched",
          residual: { identity: { evidence: [], packageEvidence: [], reason: null } },
        }];
        else if (sql.includes("SELECT r.generation_id,r.identity,r.residual")) rows = [{
          generation_id: "55555555-5555-4555-8555-555555555555", identity: "native-a", observed_at: now, expires_at: expiresAt,
          residual: { type: "microsoft.copilotstudio/agents", tenantId: "tenant-a", nativeId: "native-a",
            environmentId: "environment-a", agentKind: "copilot_studio_agent", provenance: {
              entraAppId: { sourceSystem: "power_platform", path: "properties.entraAppId", maturity: "ga" },
              entraAgentId: { sourceSystem: "power_platform", path: "properties.entraAgentId", maturity: "ga" },
            } },
        }];
        else if (sql.includes("SELECT kinds.kind,identifier.value")) rows = [{ kind, value: entra }];
        else if (sql.includes("SELECT DISTINCT c.normalized_native_id")) {
          rows = [
            { normalized_native_id: "native-a", normalized_environment_id: "environment-a", tenant_id: "tenant-a" },
            ...(inventoryRevision === "2" ? [{
              normalized_native_id: "native-b", normalized_environment_id: "environment-b", tenant_id: "tenant-a",
            }] : []),
          ];
          // A cross-environment collision changes the root, not this agent's row or native snapshot.
          if (changed) inventoryRevision = "2";
        } else if (!["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"].includes(sql)
          && !sql.includes("SELECT substr(kind,8) AS role")) throw new Error("Unexpected live investigation query.");
        return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
      });
      const mappings = { readState: vi.fn(async (): Promise<AgentIdentityCacheState> => ({
        status: "resolved", value: { objectId: entra, applicationId: entra, checkedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
          runtimeStatus: "available", runtimeProvenance: verifiedAgentIdentityClientIdProvenance },
      })) };
      const inventory = new LiveInventory(database);
      const service = new AgentInvestigationsService(inventory, inventory, mappings);
      const actor = { tenantId: "tenant-a", principalId: "reader-a" };
      try {
        await expect(service.defenderScope(actor, `agent:${entra}`)).resolves.toMatchObject({
          entraAgentApplicationIds: [entra], entraAgentIds: kind === "entra_agent_id" ? [entra] : [],
        });
        changed = true;
        await expect(service.resolve(actor, `agent:${entra}`)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
        const refreshed = await service.resolve(actor, `agent:${entra}`);
        expect(refreshed.context.defender).toMatchObject({ status: "unavailable", entraAgentIds: [], entraAgentApplicationIds: [] });
        expect(refreshed.identitySource).toBeUndefined();
      } finally {
        query.mockRestore();
        connect.mockRestore();
        await database.end();
      }
    },
  );

  it("separates object-ID inventory jobs from application-ID runtime jobs before pagination", async () => {
    const db = database();
    const repository = new DefenderHuntingRepository(db as never);
    await repository.listJobs({ ...scope, entraAgentIds: [], entraAgentApplicationIds: [entra] }, 2, 4);
    for (const [sql, values] of db.query.mock.calls) {
      expect(sql).toContain("job.filters->>'templateId' IN ('agent_activity','agent_tools')");
      expect(sql).toContain(`job.filters->'entraAgentApplicationIds'=$${values.indexOf(JSON.stringify([entra])) + 1}::jsonb`);
      expect(sql).toContain("COALESCE(job.filters->'entraAgentIds','[]'::jsonb)='[]'::jsonb");
      expect(sql).not.toContain("job.filters->>'templateId'='agents_inventory'");
      expect(sql).toContain("job.filters->'agentIds'='[]'::jsonb");
    }
    const target = { ...filters, templateId: "agent_activity" as const, operations: ["InvokeAgent"] };
    expect(huntingTargetScopeHash({ ...target, entraAgentApplicationIds: [entra] })).not.toBe(huntingTargetScopeHash({ ...target, entraAgentIds: [entra] }));
  });

  it("filters exact single-agent history in SQL before both pagination and counting", async () => {
    const db = database();
    const repository = new DefenderHuntingRepository(db as never);
    await expect(repository.listJobs(scope, 2, 4)).resolves.toEqual({ value: [], count: 0, limit: 2, offset: 4 });
    expect(db.query).toHaveBeenCalledTimes(2);
    for (const [sql, values] of db.query.mock.calls) {
      expectExactFilter(sql, values, "job.filters");
      expect(values[0]).toBe("tenant-a");
      expect(sql).toContain("job.authorization_principal_id=");
      expect(sql).toContain("retained.revoked_at IS NULL");
    }
    const pageSql = db.query.mock.calls[0][0];
    expect(pageSql.indexOf("job.filters->'entraAgentIds'")).toBeLessThan(pageSql.lastIndexOf("LIMIT"));
    expect(db.query.mock.calls[0][1].slice(-2)).toEqual([2, 4]);
  });

  it("uses the same exact identity binding for job, qualifications, retained scopes and mutations", async () => {
    const db = database();
    const repository = new DefenderHuntingRepository(db as never);
    await repository.getJob(scope, bot);
    await repository.listQualificationEvidence(scope);
    await repository.listRetainedScopes(scope);
    await expect(repository.cancel(scope, bot)).rejects.toMatchObject({ code: "hunting_job_state" });
    await expect(repository.delete(scope, bot)).rejects.toMatchObject({ code: "hunting_job_state" });
    await expect(repository.revokeRetainedScope(scope, bot, "delegated", "reader-a")).rejects.toMatchObject({ code: "not_found" });
    for (const [index, [sql, values]] of db.query.mock.calls.entries()) {
      expectExactFilter(sql, values, index === 1 ? "evidence.approved_scope" : index === 2 || index === 5 ? "retained.approved_scope" : "job.filters");
    }
    for (const entraAgentIds of [[], [entra, bot], ["not-an-entra-id"]]) {
      await expect(repository.listJobs({ ...scope, entraAgentIds })).rejects.toMatchObject({ code: "scope_mismatch" });
    }
  });

  it("preserves the legacy hash when typed filters are absent and separates it from typed identity scopes", () => {
    const legacy = createHash("sha256").update(JSON.stringify({
      templateId: "agents_inventory", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [],
    })).digest("hex");
    expect(huntingTargetScopeHash(filters)).toBe(legacy);
    expect(huntingTargetScopeHash({ ...filters, entraAgentIds: [entra] })).not.toBe(legacy);
    expect(huntingTargetScopeHash({ ...filters, agentIds: [entra] })).not.toBe(huntingTargetScopeHash({ ...filters, entraAgentIds: [entra] }));
  });

  it("restricts saved Purview rows to current authorized scopes and exact environment/bot before paging/count/search", async () => {
    const db = database();
    const repository = new PurviewAuditRepository(db as never);
    await expect(repository.agentRecords({ tenantId: "tenant-a", resultScopes: [resultScope,
      { kind: "application", scopeId: "application-a", configurationRevision: 7 }] },
    { environmentId: "Environment-A", botId: bot }, { limit: 10, offset: 30, search: "some%actor", operation: "BotCreate" }))
      .resolves.toEqual({ value: [], count: 0, limit: 10, offset: 30 });
    for (const [sql, values] of db.query.mock.calls) {
      expect(sql).toContain("job.tenant_id=$1");
      expect(sql).toContain("job.result_scope_id=record.result_scope_id");
      expect(sql).toContain("job.result_scope_configuration_revision IS NOT DISTINCT FROM record.result_scope_configuration_revision");
      expect(sql).toContain("job.expires_at>clock_timestamp()");
      expect(sql).toContain("record.audit_log_record_type='powerPlatformAdministratorActivity'");
      expect(sql).toContain("record.service='PowerPlatform'");
      expect(sql).toContain(`lower(record.environment_id)=$${values.indexOf("environment-a") + 1}`);
      expect(sql).toContain(`lower(record.bot_id)=$${values.indexOf(bot) + 1}`);
      expect(sql).toContain("record.operation=ANY");
      expect(sql).toContain(`record.operation=$${values.indexOf("BotCreate") + 1}`);
      expect(sql).toContain("strpos(lower(concat_ws");
      expect(sql).not.toContain("some%actor");
      expect(values).toContain("some%actor");
      expect(values).toContain(7);
    }
    const pageSql = db.query.mock.calls[0][0];
    expect(pageSql.indexOf("lower(record.bot_id)")).toBeLessThan(pageSql.indexOf("ORDER BY"));
    expect(db.query.mock.calls[0][1].slice(-2)).toEqual([10, 30]);
    expect(db.query.mock.calls[1][0]).not.toContain("OFFSET");
  });
});
