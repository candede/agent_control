import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DefenderHuntingRepository, huntingTargetScopeHash, type DefenderHuntingReadScope } from "./defenderHunting.js";
import { PurviewAuditRepository } from "./purviewAudit.js";
import type { DefenderHuntingFilters } from "../types/defenderHunting.js";

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
