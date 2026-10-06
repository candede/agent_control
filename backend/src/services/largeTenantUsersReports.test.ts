import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { seedReportSet, seedUserFact } from "../../scripts/officialReportFixtures.js";
import { directoryRecord, generationInput } from "../../scripts/largeTenantFixtures.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { reportRelationsSql } from "../db/officialReportQueries.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { streamOfficialReport } from "./officialReportStream.js";
import { schemaRegistry } from "./officialReportFields.js";
import { randomUUID } from "node:crypto";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { OfficialReportExports } from "./officialReportExports.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan } from "./copilotServicePlans.js";
import { reportExportColumns, type CombinedUser, type ReportUser } from "../types/officialReportData.js";
import { saveUsageInventory, usageAudit } from "../db/agentUsageTestSupport.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import type { SelectionIdentity } from "./dataSelections.js";
import type { CopilotDirectoryUser, CopilotServiceSummaryState } from "../types/copilotUsage.js";
import { reportQuery } from "./largeTenantUsersReports.js";
import express from "express";
import type pg from "pg";
import session from "express-session";
import type { Server } from "node:http";
import { config } from "../config.js";
import { errorHandler } from "../errors.js";
import { createOfficialReportDataRouter } from "../routes/officialReportData.js";
import { declaredRoutePolicies } from "../routes/policy.js";
import { checkpointQueries, observePeakMemory, observeQueryWork } from "./peakMemory.js";

const secret = "candidate-report-secret-never-production-000000";
vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-candidate-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "candidate-synthetic-session-secret";
});

async function plannerSettings(database: pg.Pool) {
  const client = await database.connect();
  try {
    return (await client.query<{ indexPlanning: string; cachePlanning: string }>(
      `SELECT current_setting('enable_seqscan') AS "indexPlanning",current_setting('plan_cache_mode') AS "cachePlanning"`,
    )).rows[0];
  } finally { client.release(); }
}

const today = new Date().toISOString().slice(0, 10);
async function* csvSource(kind: keyof typeof schemaRegistry, rows: string[]) {
  yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows.join("\n")}\n`);
}
async function publish(imports: OfficialReportImports, identity: SelectionIdentity, rows: { users: string[]; agents: string[]; userAgents: string[] }, correctionOfSetId?: string) {
  const bundleId = randomUUID();
  for (const kind of ["users", "agents", "userAgents"] as const) await imports.stage(identity, { bundleId, correctionOfSetId }, csvSource(kind, rows[kind]));
  return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
}
function sourceUser(n: number, state: CopilotServiceSummaryState = "enabled"): CopilotDirectoryUser {
  const id = `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  return { serviceEvidenceVersion: 1, identity: { objectId: id, userPrincipalName: `user${n}@example.invalid`, displayName: n === 1 ? "=DANGER" : `User ${n}`,
    companyName: n % 2 ? "Company" : null, department: n % 3 ? "Department" : null, employeeType: null, accountEnabled: true, userType: "Member" },
  copilotServiceState: state, servicePlans: state === "disabled" ? [] : [{ servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97",
    service: "M365_COPILOT_APPS", displayName: "Copilot", state: state === "partially_enabled" ? "enabled" : state,
    capabilityStatus: state === "enabled" ? "Enabled" : null, assignedDateTime: null },
  ...(state === "partially_enabled" ? [{ servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
    displayName: "Teams", state: "disabled" as const, capabilityStatus: null, assignedDateTime: null }] : [])] };
}
async function directory(database: Parameters<typeof saveUsageInventory>[0], identity: SelectionIdentity, users: CopilotDirectoryUser[], expiresAt?: Date) {
  const stages = new UserSourceStages(database);
  return stages.execute(generationInput({ ...(expiresAt ? { expiresAt } : {}),
    scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId } }), async lease => {
    const key = await stages.query(lease, "discovery", "synthetic:combined");
    await stages.page(lease, key, "synthetic:combined", users.length, users.length);
    for (let n = 0; n < users.length; n += 250) await stages.directory(lease, key, users.slice(n, n + 250));
    await stages.finishQuery(lease, key);
  }, { beforePublish: async () => {} });
}

describe("live selected users and reports", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it.each(["running", "failed", "permission_required", "waiting_authorization"] as const)(
    "keeps valid saved license metrics during a running refresh but preserves %s attempt semantics",
    async status => {
      const identity = { ...selectionIdentity, tenantId: randomUUID(), principalId: randomUUID() };
      await directory(fixture.runtime, identity, [sourceUser(1), sourceUser(2, "disabled")]);
      await publish(new OfficialReportImports(fixture.runtime), identity, {
        users: [`user1@example.invalid,One,1,5,${today}`, `user2@example.invalid,Two,1,3,${today}`],
        agents: [`agent,Agent,User,1,1,8,${today}`],
        userAgents: [`agent,Agent,User,user1@example.invalid,5,${today}`, `agent,Agent,User,user2@example.invalid,3,${today}`],
      });
      const generations = new DataGenerations(fixture.runtime);
      const lease = await generations.begin(generationInput({
        scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId },
      }));
      try {
        await fixture.runtime.query(`INSERT INTO user_source_attempts(generation_id,scope_id,tenant_id,source,status)
          VALUES($1,$2,$3,'directory',$4)`, [lease.id, lease.scopeId, identity.tenantId, status]);
        const reader = new LargeTenantUsersReports(fixture.runtime, secret, 30);
        const selection = await reader.capture(identity, "delegated", "copilot_users", { cohort: "licensed" });
        const saved = await reader.page(selection.id, identity);
        expect(saved.sources.directory).toMatchObject({ state: status === "running" ? "available" : "partial", attemptStatus: status, rowCount: 2 });
        expect(saved.summary).toMatchObject({
          licensedUsers: status === "running" ? 1 : null, usingAgentsUsers: status === "running" ? 1 : null,
          noAgentActivityUsers: status === "running" ? 0 : null,
        });
        expect(saved.value).toHaveLength(1);
        const unpaid = await reader.capture(identity, "delegated", "official_users", { licenseCohort: "active_without_paid" });
        expect((await reader.page(unpaid.id, identity)).value).toHaveLength(status === "running" ? 1 : 0);
      } finally { await generations.abort(lease); }
    },
  );

  it.each(["missing", "expired"])("does not invent license metrics when a refresh has %s saved directory evidence", async evidence => {
    const identity = { ...selectionIdentity, tenantId: randomUUID(), principalId: randomUUID() };
    if (evidence === "expired") {
      const expiresAt = new Date(Date.now() + 5_000);
      await directory(fixture.runtime, identity, [sourceUser(1)], expiresAt);
      await vi.waitFor(async () => {
        const result = await fixture.runtime.query("SELECT clock_timestamp()>$1::timestamptz AS expired", [expiresAt]);
        expect(result.rows[0].expired).toBe(true);
      }, { timeout: 6_000 });
    }
    const generations = new DataGenerations(fixture.runtime);
    const lease = await generations.begin(generationInput({
      scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId },
    }));
    try {
      await fixture.runtime.query(`INSERT INTO user_source_attempts(generation_id,scope_id,tenant_id,source)
        VALUES($1,$2,$3,'directory')`, [lease.id, lease.scopeId, identity.tenantId]);
      const reader = new LargeTenantUsersReports(fixture.runtime, secret, 30);
      const selection = await reader.capture(identity, "delegated", "copilot_users");
      const saved = await reader.page(selection.id, identity);
      expect(saved.sources.directory).toMatchObject({ state: "unavailable", attemptStatus: "running", generationId: null });
      expect(saved.summary.licensedUsers).toBeNull();
    } finally { await generations.abort(lease); }
  }, 10_000);

  it.each(["official_users","official_agents","relationships"] as const)("bounds warm %s name pages without truncating wide names or cursor order",async endpoint => {
    const identity = { ...selectionIdentity,tenantId: randomUUID(),principalId: randomUUID() };
    const imports = new OfficialReportImports(fixture.runtime),reader = new LargeTenantUsersReports(fixture.runtime,secret,30);
    const name = (index: number) => index<2 ? "\u337F".repeat(511)+(index===0 ? "b" : "a") : `Name ${String(index).padStart(4,"0")}`;
    const rows = {
      users: Array.from({ length: 100 },(_,index) => `user${index}@example.invalid,${name(index)},2,3,${today}`),
      agents: Array.from({ length: 100 },(_,index) => `agent-${index},${name(index)},User,2,0,3,${today}`),
      userAgents: Array.from({ length: 200 },(_,index) => `agent-${Math.floor(index/2)},${name(Math.floor(index/2))},User,user${index%100}@example.invalid,${index%2+1},${today}`),
    };
    await directory(fixture.runtime,identity,Array.from({ length: 100 },(_,index) => sourceUser(index)));
    await publish(imports,identity,rows);
    let boundedQueries = 0,sharedEnvelopeQueries = 0;
    observePeakMemory(() => {});
    observeQueryWork(value => {
      if (value.sql.includes("selected_report_keys AS MATERIALIZED")) boundedQueries++;
      if (value.sql.includes("AS envelope_summary")) sharedEnvelopeQueries++;
    });
    fixture.runtime.on("acquire",checkpointQueries);
    try {
      for (const order of ["asc","desc"] as const) {
        const selection = await reader.capture(identity,"delegated",endpoint,{ sort: "name",order });
        const all: Array<Record<string,unknown>> = [],pages: Array<Array<Record<string,unknown>>> = [];
        let cursor: string | undefined,previous: string | null = null;
        do {
          const page = await reader.page(selection.id,identity,{ limit: 7,cursor });
          expect(page.counts).toEqual({ total: endpoint==="relationships" ? 200 : 100,filtered: endpoint==="relationships" ? 200 : 100 });
          pages.push(page.value as Array<Record<string,unknown>>);all.push(...page.value as Array<Record<string,unknown>>);
          cursor = page.page.nextCursor ?? undefined;previous = page.page.previousCursor;
        } while (cursor);
        const field = endpoint==="official_users" ? "displayName" : "agentName";
        for (let index=1;index<all.length;index++) {
          const compare = Buffer.compare(Buffer.from(String(all[index-1][field]).normalize("NFKC").toLowerCase()),
            Buffer.from(String(all[index][field]).normalize("NFKC").toLowerCase()));
          expect(order==="asc" ? compare<=0 : compare>=0).toBe(true);
        }
        const ids = all.map(row => endpoint==="official_users" ? row.username : endpoint==="official_agents" ? row.agentId : `${row.agentId}/${row.username}`);
        const expected = endpoint==="relationships" ? Array.from({ length: 200 },(_,index) => `agent-${Math.floor(index/2)}/user${index%100}@example.invalid`)
          : Array.from({ length: 100 },(_,index) => endpoint==="official_users" ? `user${index}@example.invalid` : `agent-${index}`);
        expect([...ids].sort()).toEqual(expected.sort());
        expect(new Set(ids).size).toBe(expected.length);
        expect((await reader.page(selection.id,identity,{ limit: 7,cursor: previous! })).value).toEqual(pages.at(-2));
        expect(all.some(row => String(row[field])===name(0))).toBe(true);
        expect(all.some(row => String(row[field])===name(1))).toBe(true);
      }
      expect(boundedQueries).toBeGreaterThan(20);
      if (endpoint==="official_agents") expect(sharedEnvelopeQueries).toBe(0);
    } finally {
      fixture.runtime.removeListener("acquire",checkpointQueries);observeQueryWork();observePeakMemory();
    }
  }, 60_000);

  it("keeps bridge-only users and agents on the complete fallback relation after warming counts",async () => {
    const identity = { ...selectionIdentity,tenantId: randomUUID(),principalId: randomUUID() };
    const reader = new LargeTenantUsersReports(fixture.runtime,secret,30);
    await publish(new OfficialReportImports(fixture.runtime),identity,{
      users: [`a@example.invalid,AA Primary,1,3,${today}`],
      agents: [`primary,AA Primary,User,1,0,3,${today}`],
      userAgents: [`primary,AA Primary,User,a@example.invalid,3,${today}`,`bridge,ZZ Bridge,User,z@example.invalid,7,${today}`],
    });
    let boundedQueries = 0;
    observePeakMemory(() => {});observeQueryWork(value => { if (value.sql.includes("selected_report_keys AS MATERIALIZED")) boundedQueries++; });
    fixture.runtime.on("acquire",checkpointQueries);
    try {
      for (const endpoint of ["official_users","official_agents"] as const) {
        const selection = await reader.capture(identity,"delegated",endpoint,{ sort: "name",order: "asc" });
        const first = await reader.page(selection.id,identity,{ limit: 1 });
        const second = await reader.page(selection.id,identity,{ limit: 1,cursor: first.page.nextCursor! });
        expect(second.counts).toEqual({ total: 2,filtered: 2 });
        expect(second.value[0]).toMatchObject(endpoint==="official_users"
          ? { username: "z@example.invalid",reportedResponses: null,bridgeResponses: 7,missingUserReport: true }
          : { agentId: "bridge",responses: 7,responseSource: "userAgents" });
      }
      expect(boundedQueries).toBe(0);
    } finally {
      fixture.runtime.removeListener("acquire",checkpointQueries);observeQueryWork();observePeakMemory();
    }
  });

  it("streams UTF-8 with bounded examples and publishes only a complete three-kind bundle", async () => {
    const imports = new OfficialReportImports(fixture.runtime), identity = { ...selectionIdentity, tenantId: "stream-import" };
    const bundleId = randomUUID();
    const data = {
      users: "user@example.invalid,Émployee,1,5,2026-09-01",
      agents: "agent,Agent,User,1,0,5,2026-09-01",
      userAgents: "agent,Agent,User,user@example.invalid,5,2026-09-01",
    };
    for (const kind of ["users", "agents", "userAgents"] as const) {
      const bytes = Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${data[kind]}\n`);
      async function* source() { for (const byte of bytes) yield Buffer.from([byte]); }
      const preview = await imports.stage(identity, { bundleId }, source());
      expect(preview.rowCount).toBe(1);
      expect(preview.examples).toHaveLength(1);
      expect((await fixture.runtime.query("SELECT active_set_id FROM official_usage_state WHERE tenant_id=$1", [identity.tenantId])).rows[0].active_set_id).toBeNull();
    }
    const preview = await imports.bundle(identity, bundleId);
    expect(preview.complete).toBe(true);
    const accepted = await imports.acceptBundle(identity, bundleId, preview);
    expect(accepted.complete).toBe(true);
    expect(await imports.acceptBundle(identity, bundleId, preview)).toEqual(accepted);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_row_facts WHERE tenant_id=$1", [identity.tenantId])).rows[0].n).toBe(3);
    const queries = new LargeTenantUsersReports(fixture.runtime, "candidate-report-secret-never-production-000000", 30);
    for (const endpoint of ["official_agents", "official_users", "relationships", "history", "overview", "unresolved"] as const) {
      const selected = await queries.capture({ ...identity, principalId: "viewer-not-importer" }, "delegated", endpoint);
      const page = await queries.page(selected.id, { ...identity, principalId: "viewer-not-importer" });
      expect(page.value).toHaveLength(1);
      expect(page.counts).toEqual({ total: 1, filtered: 1 });
      expect(page.reports.historyRevision).toBe("1");
    }
    const selectedHistory = await queries.capture(identity, "delegated", "history");
    expect((await queries.page(selectedHistory.id, identity, { endpoint: "observations", child: accepted.setId })).value).toHaveLength(3);
  });

  it("does not rewrite dependency tuples during repeated captures or idle history maintenance", async () => {
    const identity = { ...selectionIdentity, tenantId: "read-only-scope-initialization" };
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    await reports.capture(identity, "delegated", "copilot_users");
    const versions = async () => (await fixture.runtime.query(`SELECT id,xmin::text AS version FROM data_scope_epochs
      WHERE tenant_id=$1 ORDER BY id LIMIT 16`, [identity.tenantId])).rows;
    const before = await versions();
    expect(before.length).toBeGreaterThan(0);
    await Promise.all([
      reports.capture(identity, "delegated", "official_users"),
      reports.capture(identity, "delegated", "official_agents"),
      reports.history.ensure(identity.tenantId).then(async () => {
        await reports.history.expire(identity.tenantId); await reports.history.collect(identity.tenantId);
      }),
    ]);
    expect(await versions()).toEqual(before);
  });

  it.each([
    ["9007199254740991,0", "1,0"], ["0,9007199254740991", "0,1"],
  ])("rejects overflow within either Users metric before publication: %s", async (first, second) => {
    await expect(streamOfficialReport(csvSource("users", [`first,First,${first},`, `second,Second,${second},`]),
      undefined, new AbortController().signal, { batch: async () => {} })).rejects.toMatchObject({ code: "numeric_overflow", status: 400 });
  });

  it("rejects malformed UTF-8 without retaining a preview", async () => {
    async function* broken() { yield Buffer.from([0xc3, 0x28]); }
    await expect(streamOfficialReport(broken(), undefined, new AbortController().signal, { batch: async () => {} }))
      .rejects.toMatchObject({ code: "invalid_utf8" });
  });

  it("freezes licensing, missing/zero, bridge-only, unresolved, facets, child and three export goldens", async () => {
    const identity = { ...selectionIdentity, tenantId: "combined-golden" };
    const users = ["enabled", "warning", "partially_enabled", "suspended", "locked_out", "disabled", "unknown"].map((state, index) => sourceUser(index + 1, state as CopilotServiceSummaryState));
    await directory(fixture.runtime, identity, users);
    const imports = new OfficialReportImports(fixture.runtime);
    await publish(imports, identity, {
      users: users.slice(0, 6).map((user, index) => `${user.identity.userPrincipalName},${user.identity.displayName},1,${index === 1 ? 0 : 5},${today}`),
      agents: [`agent,=FORMULA,User,99,99,25,${today}`],
      userAgents: [...users.map((user, index) => `agent,=FORMULA,User,${user.identity.userPrincipalName},${index === 1 ? 0 : 5},${today}`),
        `agent,=FORMULA,User,unknown@example.invalid,2,${today}`],
    });

    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    const selected = await reports.capture(identity, "delegated", "copilot_users");
    const page = await reports.page(selected.id, identity), rows = page.value as CombinedUser[];
    expect(rows.map(user => [user.directory.objectId.slice(-1), user.entitlement, user.reportedResponses, user.agentActivityState])).toEqual([
      ["1", "paid_active", 5, "active"], ["2", "paid_active", 0, "none"], ["3", "paid_active", 5, "active"],
      ["4", "paid_inactive", 5, "active"], ["5", "paid_inactive", 5, "active"], ["6", "no_paid", 5, "active"], ["7", "unknown", null, "active"],
    ]);
    expect(page.summary).toMatchObject({ checkedUsers: 7, licensedUsers: 3, usingAgentsUsers: 2, noAgentActivityUsers: 1, activeWithoutPaidUsers: 3, unresolvedIdentities: 1 });
    expect(rows.map(user => user.userLastActivityDateUtc)).toEqual([today, today, today, today, today, today, null]);
    const unpaid = await reports.capture(identity, "delegated", "copilot_users", { licenseCohort: "active_without_paid" });
    expect((await reports.page(unpaid.id, identity)).counts).toEqual({ total: 7, filtered: 3 });
    expect((await reports.facets(selected.id, identity, { field: "company" })).value).toEqual([{ value: "Company", count: 4 }, { value: null, count: 3 }]);
    for (const [search, count] of [["USER1@EXAMPLE.INVALID", 1], ["cOmPaNy", 4], ["DEPARTMENT", 5]] as const) {
      const searched = await reports.capture(identity, "delegated", "copilot_users", { search });
      expect((await reports.page(searched.id, identity)).counts).toEqual({ total: 7, filtered: count });
    }
    expect((await reports.page(selected.id, identity, { endpoint: "plans", child: users[0].identity.objectId })).value).toHaveLength(1);
    const official = await reports.capture(identity, "delegated", "official_users");
    const reportUsers = (await reports.page(official.id, identity)).value as ReportUser[];
    expect(reportUsers.find(user => user.username === "user7@example.invalid")).toMatchObject({ missingUserReport: true, reportedResponses: null, bridgeResponses: 5, reviewCohort: "unknown" });
    expect((await reports.page(official.id, identity, { endpoint: "relationships", child: "user1@example.invalid" })).value).toHaveLength(1);
    for (const [endpoint, sorts] of [
      ["copilot_users", ["name", "upn", "company", "department", "service", "appActivity", "responses", "agentsUsed", "lastActivity"]],
      ["official_users", ["name", "responses", "agentsUsed", "lastActivity"]],
      ["official_agents", ["name", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"]],
    ] as const) {
      for (const sort of sorts) {
        const selectedSort = await reports.capture(identity, "delegated", endpoint, { sort, order: "desc" });
        const first = await reports.page(selectedSort.id, identity, { limit: 2 });
        expect(first.value.length).toBeGreaterThan(0);
        if (first.page.nextCursor) {
          const second = await reports.page(selectedSort.id, identity, { limit: 2, cursor: first.page.nextCursor });
          const back = await reports.page(selectedSort.id, identity, { limit: 2, cursor: second.page.previousCursor! });
          expect(back.value).toEqual(first.value);
          await expect(reports.page(selectedSort.id, identity, { cursor: first.page.nextCursor + "x" })).rejects.toMatchObject({ code: "invalid_cursor" });
        }
      }
    }
    for (const [filters, count] of [
      [{ username: "user1@example.invalid" }, 1], [{ company: null }, 3], [{ department: null }, 2],
      [{ cohort: "zero" }, 1], [{ cohort: "low", lowResponseThreshold: 3 }, 0],
      [{ cohort: "using_agents" }, 2], [{ cohort: "no_agent_activity" }, 1],
      [{ reportActivity: "recent", inactiveDays: 1 }, 6], [{ reportActivity: "no-activity" }, 1],
      [{ agentId: "agent", responsesOnly: true }, 6], [{ creatorType: "Other" }, 0], [{ serviceState: "unknown" }, 1],
      [{ entitlement: "paid_active" }, 3], [{ appActivity: "unknown" }, 7], [{ startDate: today, endDate: today }, 6],
    ] as const) {
      const filtered = await reports.capture(identity, "delegated", "copilot_users", filters);
      expect((await reports.page(filtered.id, identity)).counts.filtered, JSON.stringify(filters)).toBe(count);
    }
    const exports = new OfficialReportExports(reports, usageAudit(identity).actor);
    for (const kind of ["copilot_users", "official_users", "official_agents"] as const) {
      const selectedExport = await reports.capture(identity, "delegated", kind);
      const id = await exports.create(identity, { selectionId: selectedExport.id, kind });
      await exports.build(id, identity, kind);
      expect(await exports.engine.status(id, identity)).toMatchObject({ status: "ready" });
      let csv = "";
      for await (const chunk of exports.engine.download(id, identity, new AbortController().signal)) { expect(chunk.byteLength).toBeLessThanOrEqual(262144); csv += chunk.toString(); }
      expect(csv.split("\r\n")[0].replace(/^\uFEFF/, "")).toBe(reportExportColumns[kind].join(","));
      expect(csv).toContain(kind === "official_agents" ? "'=FORMULA" : "'=DANGER");
      expect(csv).not.toContain("[object Object]");
    }
    const explicit = await exports.create(identity, { selectionId: selected.id, kind: "copilot_users", ids: [users[0].identity.objectId] });
    await exports.build(explicit, identity, "copilot_users");
    expect(await exports.engine.status(explicit, identity)).toMatchObject({ status: "ready", rows: 1 });
    const audit = (await fixture.runtime.query("SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1 AND action='export-official-usage-users' AND status='succeeded'", [identity.tenantId])).rows[0];
    expect(audit.n).toBeGreaterThanOrEqual(3);
    const stages = new UserSourceStages(fixture.runtime), inputs = vi.spyOn(stages, "identities");
    await stages.execute(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId } }), async lease => {
      const key = await stages.query(lease, "discovery", "synthetic:report-identities");
      await stages.directory(lease, key, users); await stages.finishQuery(lease, key);
      const positive = await reports.captureReportIdentities(identity);
      await reports.feedPositiveIdentities(positive.id, identity, stages, lease);
      expect(await stages.verificationBatch(lease)).toEqual(["unknown@example.invalid"]);
      await stages.verified(lease, ["unknown@example.invalid"]);
      expect(await stages.verificationBatch(lease)).toEqual([]);
      expect(inputs.mock.calls.every(([, rows]) => rows.length <= 250)).toBe(true);
    }, { beforePublish: async () => {} });
    inputs.mockRestore();
  });

  it.each([{ checked: 3993, licensed: 2206 }, { checked: 30001, licensed: 30001 }])(
    "keeps $checked checked candidates and $licensed effectively paid people exact without a tenant response array", async ({ checked, licensed }) => {
      const identity = { ...selectionIdentity, tenantId: `cutover-paid-count-${checked}` }, stages = new UserSourceStages(fixture.runtime);
      const planning = await plannerSettings(fixture.runtime);
      const started = performance.now();
      let collectionMs = 0;
      const allPlans = [...copilotServicePlanDefinitions.keys()].map(servicePlanId => resolveCopilotServicePlan(
        servicePlanId, true, [{ servicePlanId, assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }],
      ));
      const published = await stages.execute(generationInput({ reserveBytes: 8 * 1024 ** 3,
        scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId } }), async lease => {
        const query = await stages.query(lease, "discovery", "synthetic:paid-count");
        await stages.page(lease, query, "synthetic:paid-count", checked, checked);
        for (let offset = 0; offset < checked; offset += 250) {
          const batch = Array.from({ length: Math.min(250, checked - offset) }, (_, index) => {
            const number = offset + index + 1, user = sourceUser(number);
            if (checked === 30001) user.servicePlans = allPlans;
            if (number > licensed) {
              user.copilotServiceState = "disabled";
              user.servicePlans = user.servicePlans.map(plan => ({ ...plan, state: "disabled" }));
            }
            return user;
          });
          await stages.directory(lease, query, batch);
        }
        await stages.finishQuery(lease, query);
        collectionMs = performance.now() - started;
      }, { beforePublish: async () => {} });
      const publicationMs = performance.now() - started - collectionMs;
      expect(await plannerSettings(fixture.runtime)).toEqual(planning);
      const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
      const selected = await reports.capture(identity, "delegated", "copilot_users", { cohort: "licensed" });
      const missing = await reports.page(selected.id, identity);
      expect(missing.counts).toEqual({ total: checked, filtered: licensed });
      expect(missing.value).toHaveLength(50);
      expect(missing.summary).toMatchObject({ checkedUsers: checked, licensedUsers: licensed, usingAgentsUsers: null, noAgentActivityUsers: null });
      expect(missing.value.every(row => "reportedResponses" in row && row.reportedResponses === null)).toBe(true);
      await publish(new OfficialReportImports(fixture.runtime), identity, {
        users: Array.from({ length: 10 }, (_, index) => `user${index + 1}@example.invalid,User ${index + 1},1,1,${today}`),
        agents: [`agent,Agent,Your org,10,0,10,${today}`],
        userAgents: Array.from({ length: 10 }, (_, index) => `agent,Agent,Your org,user${index + 1}@example.invalid,1,${today}`),
      });
      const current = await reports.capture(identity, "delegated", "copilot_users", { cohort: "licensed", sort: "responses", order: "desc" });
      const first = await reports.page(current.id, identity);
      expect(first.summary).toMatchObject({ checkedUsers: checked, licensedUsers: licensed, usingAgentsUsers: 10, noAgentActivityUsers: licensed - 10 });
      expect(first.counts).toEqual({ total: checked, filtered: licensed });
      expect(first.value).toHaveLength(50);
      expect(first.page.nextCursor).toEqual(expect.any(String));
      const next = await reports.page(current.id, identity, { cursor: first.page.nextCursor! });
      expect(next.value).toHaveLength(50);
      expect(next.counts).toEqual(first.counts);
      expect(next.summary).toEqual(first.summary);
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(1024 ** 2);
      const all = await reports.capture(identity, "delegated", "copilot_users");
      const exact = await reports.exact(all.id, identity, sourceUser(checked).identity.objectId);
      expect(exact.value).toMatchObject({ directory: { objectId: sourceUser(checked).identity.objectId },
        entitlement: licensed === checked ? "paid_active" : "paid_inactive" });
      if (checked === 30001) {
        expect((await fixture.runtime.query(`SELECT plan_id,count(*)::int AS users FROM directory_service_plan_rows
          WHERE generation_id=$1 GROUP BY plan_id ORDER BY plan_id LIMIT 250`, [published.generationId])).rows)
          .toEqual(allPlans.map(plan => ({ plan_id: plan.servicePlanId, users: checked })).sort((left, right) => left.plan_id.localeCompare(right.plan_id)));
        for (const number of [1, checked]) {
          const plans = await reports.page(all.id, identity, { endpoint: "plans", child: sourceUser(number).identity.objectId });
          expect(plans.counts.total).toBe(3);
          expect(plans.value).toEqual(allPlans.toSorted((left, right) => right.servicePlanId.localeCompare(left.servicePlanId)));
        }
      }
      process.stdout.write(JSON.stringify({ contract: "paid_source_measurement", checked, licensed,
        plansPerUser: checked === 30001 ? 3 : 1, collectionMs, publicationMs,
        totalMs: performance.now() - started }) + "\n");
    }, 60000);

  it("uses exact current package references and reviewed CAS mappings without full inventory reads", async () => {
    const identity = { ...selectionIdentity, tenantId: "agent-golden" };
    const records = await saveUsageInventory(fixture.runtime, identity, [{ packages: ["agent"] }, { packages: ["other"] }]);
    await publish(new OfficialReportImports(fixture.runtime), identity, { users: [`user,User,1,5,${today}`],
      agents: [`agent,Agent,User,1,0,5,${today}`], userAgents: [`agent,Agent,User,user,5,${today}`, `bridge,Bridge,User,user,3,${today}`] });
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30), usage = new OfficialAgentUsage(reports);
    const selected = await reports.capture(identity, "delegated", "official_agents");
    expect((await usage.summaries(selected.id, identity, records.map(record => record.id))).map(row => [row.status, row.responses, row.activeUsers]))
      .toEqual([["linked", 5, 1], ["unlinked", null, null]]);
    const candidates = await usage.candidates(selected.id, identity, records[1].id, {});
    expect(candidates.value).toHaveLength(1);
    const { selectionId, reportSetId, inventoryRevision, usageRevision } = candidates.context;
    const confirmation = { selectionId, reportSetId, inventoryRevision, usageRevision };
    const context = await usage.mutate(identity, records[1].id, { ...confirmation, reportAgentId: "agent", confirmed: true,
      target: { source: "graph_packages", packageId: "other" } }, usageAudit(identity).actor);
    expect((await usage.summaries(selected.id, identity, records.map(record => record.id))).map(row => row.status)).toEqual(["unlinked", "linked"]);
    expect((await usage.associations(selected.id, identity, records[1].id, {})).value).toMatchObject([{ reportAgentId: "agent", basis: "reviewed" }]);
    await expect(usage.mutate(identity, records[1].id, { ...confirmation, reportAgentId: "agent", confirmed: true }, usageAudit(identity).actor))
      .rejects.toMatchObject({ code: "agent_usage_changed" });
    await usage.mutate(identity, records[1].id, { ...confirmation, usageRevision: context.usageRevision, reportAgentId: "agent", confirmed: true }, usageAudit(identity).actor);
    expect((await usage.summaries(selected.id, identity, [records[0].id]))[0].responses).toBe(5);
    await reports.read(selected.id, identity, async (client, read) => {
      const reference = records[0].observations.packageSnapshots!.agent;
      expect(await usage.packagesInRead(client, read, [{ snapshotId: reference.snapshotId, nativeId: "agent" }])).toHaveLength(1);
      expect(await usage.packagesInRead(client, read, [{ snapshotId: reference.snapshotId, nativeId: "Agent" }])).toEqual([]);
    });
  });

  it("deduplicates normalized content independent of download time and rejects empty duplicate kinds", async () => {
    const identity = { ...selectionIdentity, tenantId: "content-hash" }, imports = new OfficialReportImports(fixture.runtime);
    const input = { users: [`user,User,1,1,${today}`], agents: [`agent,Agent,User,1,0,1,${today}`], userAgents: [`agent,Agent,User,user,1,${today}`] };
    const first = await publish(imports, identity, input), bundleId = randomUUID();
    for (const kind of ["users", "agents", "userAgents"] as const) await imports.stage(identity, { bundleId }, csvSource(kind, input[kind]), { downloadedAt: new Date().toISOString() });
    expect((await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId))).setId).toBe(first.setId);
    const empty = randomUUID();
    const original = await imports.stage(identity, { bundleId: empty }, csvSource("users", []));
    await expect(imports.stage(identity, { bundleId: empty, rejectDuplicateKind: true }, csvSource("users", []))).rejects.toMatchObject({ code: "duplicate_report_kind" });
    const replacement = await imports.stage(identity, { bundleId: empty }, csvSource("users", []));
    expect(replacement.contentHash).toBe(original.contentHash);
    await expect(imports.preview(identity, original.id)).rejects.toBeInstanceOf(Error);
    expect((await imports.preview(identity, replacement.id)).rowCount).toBe(0);
  });
  it("preserves individual acceptance and valid prior previews when a replacement stream fails", async () => {
    const identity = { ...selectionIdentity, tenantId: "individual-acceptance" }, imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
    const first = await imports.stage(identity, { bundleId }, csvSource("users", [`user,User,1,1,${today}`]));
    await expect(imports.stage(identity, { bundleId }, csvSource("users", [`user,User,1,1,${today}`, "bad"]))).rejects.toBeInstanceOf(Error);
    expect((await imports.preview(identity, first.id)).contentHash).toBe(first.contentHash);
    const partial = await imports.accept(identity, { stagingId: first.id, revision: first.revision, contentHash: first.contentHash, expectedActiveRevision: first.activeRevision });
    expect(partial.complete).toBe(false);
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    const incomplete = await reports.capture(identity, "delegated", "official_users");
    expect((await reports.page(incomplete.id, identity)).reports.availability).toBe("incomplete");
    expect((await imports.accept(identity, { stagingId: first.id, revision: first.revision, contentHash: first.contentHash, expectedActiveRevision: first.activeRevision })).complete).toBe(false);
    for (const kind of ["agents", "userAgents"] as const) {
      const stage = await imports.stage(identity, { bundleId }, csvSource(kind, [kind === "agents" ? `agent,Agent,User,1,0,1,${today}` : `agent,Agent,User,user,1,${today}`]));
      const accepted = await imports.accept(identity, { stagingId: stage.id, revision: stage.revision, contentHash: stage.contentHash, expectedActiveRevision: stage.activeRevision });
      expect(accepted.complete).toBe(kind === "userAgents");
    }
  });

  it.each([0, 1, 2, 3])("resumes a bundle with %i already accepted companions without republishing saved facts", async saved => {
    const identity = { ...selectionIdentity, tenantId: `resumed-bundle-${saved}` }, imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
    const stages = [];
    for (const kind of ["users", "agents", "userAgents"] as const) {
      stages.push(await imports.stage(identity, { bundleId }, csvSource(kind, [kind === "users" ? `user,User,1,1,${today}`
        : kind === "agents" ? `agent,Agent,User,1,0,1,${today}` : `agent,Agent,User,user,1,${today}`])));
    }
    for (const stage of stages.slice(0, saved)) await imports.accept(identity, {
      stagingId: stage.id, revision: stage.revision, contentHash: stage.contentHash, expectedActiveRevision: stage.activeRevision,
    });
    const preview = await imports.bundle(identity, bundleId);
    expect(preview.complete).toBe(true); expect(preview.stages).toHaveLength(3);
    const accepted = await imports.acceptBundle(identity, bundleId, preview);
    expect(accepted).toMatchObject({ complete: true, activeRevision: "2" });
    expect(await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId))).toEqual(accepted);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_versions WHERE tenant_id=$1", [identity.tenantId])).rows[0].count).toBe(3);
    expect((await fixture.runtime.query("SELECT revision::text FROM official_usage_state WHERE tenant_id=$1", [identity.tenantId])).rows[0].revision).toBe("2");
    for (const stage of stages) expect((await imports.preview(identity, stage.id)).status).toBe("accepted");
  });

  it.each(["asc", "desc"] as const)("pages creator-type relationship sorting with unknown values last: %s", async order => {
    const identity = { ...selectionIdentity, tenantId: `creator-sort-${order}` }, imports = new OfficialReportImports(fixture.runtime);
    await publish(imports, identity, { users: [`user,User,3,3,${today}`], agents: [], userAgents: [
      `agent-b,Agent B,Team B,user,1,${today}`, `agent-a,Agent A,Team A,user,1,${today}`, "agent-missing,Missing,,user,1,",
    ] });
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    const selected = await reports.capture(identity, "delegated", "official_users");
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reports.page(selected.id, identity, { endpoint: "relationships", child: "user",
        childQuery: { sort: "creatorType", order }, limit: 1, cursor });
      expect(page.counts).toEqual({ total: 3, filtered: 3 });
      expect(page.value).toHaveLength(1);
      const row = page.value[0] as import("../types/officialReportData.js").ReportRelationship;
      ids.push(row.agentId);
      if (!page.page.nextCursor) expect(row.creatorType).toBe("");
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(order === "asc" ? ["agent-a", "agent-b", "agent-missing"] : ["agent-b", "agent-a", "agent-missing"]);
  });

  it.each([
    ["users", "user,Name,1,-1,", "invalid_number"],
    ["users", "user,Name,1,1,2026-02-30", "invalid_date"],
    ["users", `user,${"x".repeat(4097)},1,1,`, "field_limit_exceeded"],
  ])("rejects strict %s field/count/date boundaries", async (kind, row) => {
    await expect(streamOfficialReport(csvSource(kind as "users", [row]), undefined, new AbortController().signal, { batch: async () => {} })).rejects.toBeInstanceOf(Error);
  });
  it("enforces serial backpressure, 250 rows and one MiB including staging envelopes", async () => {
    let simultaneous = 0, maximum = 0, count = 0, maximumBatch = 0;
    async function* source() {
      yield Buffer.from(`${schemaRegistry.userAgents.headers.join(",")}\n`);
      for (let n = 0; n < 1000; n++) yield Buffer.from(`${`a${n}`.padEnd(512, "語")},${"語".repeat(512)},${"語".repeat(128)},${`u${n}`.padEnd(512, "語")},1,\n`);
    }
    await streamOfficialReport(source(), undefined,
      new AbortController().signal, { batch: async (_kind, rows) => {
        maximum = Math.max(maximum, ++simultaneous); expect(rows.length).toBeLessThanOrEqual(250);
        maximumBatch = Math.max(maximumBatch, rows.length);
        expect(Buffer.byteLength(JSON.stringify(rows.map(row => ({ ordinal: 999999, natural_key: "f".repeat(64), row_data: row }))))).toBeLessThan(1048576);
        await new Promise(resolve => setImmediate(resolve)); count += rows.length; simultaneous--;
      } });
    expect([count, maximum]).toEqual([1000, 1]);
    expect(maximumBatch).toBeLessThan(250);
    const identity = { ...selectionIdentity, tenantId: "wide-stream" }, imports = new OfficialReportImports(fixture.runtime);
    const bundleId = randomUUID(), preview = await imports.stage(identity, { bundleId }, source());
    expect(preview.rowCount).toBe(1000); expect(preview.examples).toHaveLength(20);
    for (const kind of ["users", "agents"] as const) await imports.stage(identity, { bundleId }, csvSource(kind, []));
    await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30), selected = await reports.capture(identity, "delegated", "official_agents");
    const first = await reports.page(selected.id, identity, { limit: 100 });
    expect(first.value.length).toBeGreaterThan(0); expect(first.value.length).toBeLessThan(100);
    expect(first.page.nextCursor).not.toBeNull(); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1048576);
    const exports = new OfficialReportExports(reports, usageAudit(identity).actor);
    const id = await exports.create(identity, { selectionId: selected.id, kind: "official_agents" });
    await exports.build(id, identity, "official_agents");
    expect(await exports.status(id, identity)).toMatchObject({ status: "ready", rows: 1000 });
  }, 60_000);
  it("measures 1000/10000 directory users and observed facts with actual SQL plans and bounded parameters/results", async () => {
    for (const size of [1000, 10000]) {
      const identity = { ...selectionIdentity, tenantId: `combined-measure-${size}` }, stages = new UserSourceStages(fixture.runtime);
      const started = performance.now();
      await stages.execute(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId } }), async lease => {
        const key = await stages.query(lease, "discovery", "synthetic:measurement");
        for (let start = 0; start < size; start += 250) await stages.directory(lease, key, Array.from({ length: Math.min(250, size - start) }, (_, n) => sourceUser(start + n + 1, n % 2 ? "enabled" : "disabled")));
        await stages.finishQuery(lease, key);
      }, { beforePublish: async () => {} });
      const directoryMs = performance.now() - started;
      const imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
      let maximumRows = 0, parameterBytes = 0, maximumResultRows = 0, maximumResultBytes = 0;
      let pageStatement: { sql: string; parameters: unknown[] } | undefined;
      const query = fixture.runtime.connect.bind(fixture.runtime);
      const connections = vi.spyOn(fixture.runtime, "connect").mockImplementation((async () => {
        const client = await query();
        const previousQuery = client.query;
        const original = client.query.bind(client);
        const observed = ((sql: unknown, values?: unknown[]) => {
          if (values) {
            parameterBytes = Math.max(parameterBytes, Buffer.byteLength(JSON.stringify(values)));
            for (const value of values) if (typeof value === "string" && value.startsWith("[{")) maximumRows = Math.max(maximumRows, (JSON.parse(value) as unknown[]).length);
          }
          const projection = typeof sql === "string" && sql.startsWith("WITH ") && sql.includes("SELECT * FROM ordered WHERE");
          if (projection) pageStatement = { sql, parameters: [...values ?? []] };
          return original(sql as string, values).then(result => {
            const rows = (Array.isArray(result) ? result : [result]).flatMap(part => part.rows);
            maximumResultRows = Math.max(maximumResultRows, rows.length);
            maximumResultBytes = Math.max(maximumResultBytes, Buffer.byteLength(JSON.stringify(rows)));
            return result;
          });
        }) as typeof client.query;
        client.query = observed;
        const release = client.release.bind(client);
        client.release = (...args: Parameters<typeof client.release>) => { client.query = previousQuery; client.release = release; release(...args); };
        return client;
      }) as typeof fixture.runtime.connect);
      try {
        const staged = performance.now();
        for (const kind of ["users", "userAgents", "agents"] as const) {
          async function* source() {
            yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n`);
            if (kind === "agents") { yield Buffer.from(`agent,Agent,User,${size},0,${size},${today}\n`); return; }
            for (let start = 0; start < size; start += 250) yield Buffer.from(Array.from({ length: Math.min(250, size - start) }, (_, n) =>
              kind === "users" ? `user${start + n + 1}@example.invalid,User ${start + n + 1},1,1,${today}\n`
                : `agent,Agent,User,user${start + n + 1}@example.invalid,1,${today}\n`).join(""));
          }
          await imports.stage(identity, { bundleId }, source());
        }
        const stageMs = performance.now() - staged;
        const accepting = performance.now();
        const planning = await plannerSettings(fixture.runtime);
        const bundle = await imports.bundle(identity, bundleId);
        await imports.acceptBundle(identity, bundleId, bundle);
        expect(await plannerSettings(fixture.runtime)).toEqual(planning);
        const acceptMs = performance.now() - accepting;
        const importMs = performance.now() - started - directoryMs;
        const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30), selected = await reports.capture(identity, "delegated", "copilot_users", { licenseCohort: "active_without_paid" });
        const page = await reports.page(selected.id, identity);
        expect(page.counts).toEqual({ total: size, filtered: size / 2 });
        expect(page.value).toHaveLength(50);
        const measured = pageStatement!;
        const reportUsers = await reports.capture(identity, "delegated", "official_users", { licenseCohort: "active_without_paid" });
        expect((await reports.page(reportUsers.id, identity)).counts).toEqual({ total: size, filtered: size / 2 });
        const readMs = performance.now() - started - directoryMs - importMs;
        await reports.read(selected.id, identity, async (client, context) => {
          expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
          const statement = measured.sql, values = measured.parameters;
          expect(context.query.licenseCohort).toBe("active_without_paid");
          const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`, values)).rows[0]["QUERY PLAN"];
          expect(plan[0].Plan["Actual Rows"]).toBe(51);
          expect(JSON.stringify(plan)).toContain("Index");
          expect(JSON.stringify(plan)).not.toContain('"Node Type":"Merge Join"');
          type PlanNode = { "Node Type": string; "Rows Removed by Join Filter"?: number; Plans?: PlanNode[] };
          const nodes: PlanNode[] = [plan[0].Plan];
          while (nodes.length) {
            const node = nodes.pop()!;
            nodes.push(...node.Plans ?? []);
            if (node["Node Type"] === "Nested Loop") expect(node["Rows Removed by Join Filter"] ?? 0).toBeLessThanOrEqual(250);
          }
          const observed = (await client.query("SELECT count(*)::int AS n FROM official_usage_row_facts WHERE tenant_id=$1 AND kind='users'", [identity.tenantId])).rows[0].n;
          expect(observed).toBe(size);
          process.stdout.write(JSON.stringify({ contract: "combined_user_report_measurement", size, observedUserFacts: observed,
            directoryMs, stageMs, acceptMs, importMs, readMs,
            rowsReturned: 50, sqlRowsWithLookahead: 51, maximumBatchRows: maximumRows, maximumParameterBytes: parameterBytes,
            maximumResultRows, maximumResultBytes,
            responseBytes: Buffer.byteLength(JSON.stringify(page)), sourceParameterBytes: stages.maximumParameterBytes,
            query: statement, parameters: values, plan }) + "\n");
        });

        expect(maximumRows).toBeLessThanOrEqual(250); expect(parameterBytes).toBeLessThanOrEqual(1048576);
        expect(maximumResultRows).toBeLessThanOrEqual(250); expect(maximumResultBytes).toBeLessThanOrEqual(1048576);
      } finally { connections.mockRestore(); }
    }
  }, 120000);

  it("counts CSV records at the real 100000-row boundary and stops before malformed trailing input", async () => {
    const run = async (count: number) => {
      async function* source() {
        yield Buffer.from(`\n${schemaRegistry.users.headers.join(",")}\n\n`);
        for (let offset = 0; offset < count; offset += 250) {
          const rows = Array.from({ length: Math.min(250, count - offset) }, (_, n) =>
            `u${offset + n},"Research\nassistant",1,1,\n\n`).join("");
          yield Buffer.from(rows + (count > 100000 && offset + 250 >= count ? '"unterminated trailing record' : ""));
        }
      }
      return streamOfficialReport(source(), undefined, new AbortController().signal, { batch: async () => {} });
    };
    expect((await run(100000)).rowCount).toBe(100000);
    await expect(run(100001)).rejects.toMatchObject({ code: "row_limit_exceeded" });
  }, 60000);
  it("rejects duplicate report identities in persisted staging without retaining a tenant-wide identity set", async () => {
    const imports = new OfficialReportImports(fixture.runtime), identity = { ...selectionIdentity, tenantId: "duplicate-natural-identity" };
    await expect(imports.stage(identity, { bundleId: randomUUID() }, csvSource("userAgents", [
      "agent-1,Research,Declarative,User@Example.com,42,2026-07-06",
      "agent-1,Other,Declarative,User@Example.com,1,2026-07-06",
    ]))).rejects.toMatchObject({ code: "duplicate_identity" });
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_ingestion_rows
      WHERE tenant_id=$1`, [identity.tenantId])).rows[0].count).toBe(0);
  });
  it("enforces the exact 256 MiB wire limit with bounded input chunks", async () => {
    const run = async (extra: number) => {
      const header = Buffer.from(`${schemaRegistry.users.headers.join(",")}\n`), chunk = Buffer.alloc(16384, 32);
      chunk[chunk.length - 1] = 10;
      async function* source() {
        yield header;
        for (let remaining = 268435456 - header.length + extra; remaining > 0; remaining -= chunk.length) yield chunk.subarray(0, Math.min(remaining, chunk.length));
      }
      return streamOfficialReport(source(), undefined, new AbortController().signal, { batch: async () => {} });
    };
    expect((await run(0)).wireBytes).toBe(268435456);
    await expect(run(1)).rejects.toMatchObject({ code: "report_too_large" });
  }, 60000);
  it("cancels abandoned uploads, fences revoked sessions and shares admission with user-source jobs", async () => {
    const identity = { ...selectionIdentity, tenantId: "cancel-stream" }, imports = new OfficialReportImports(fixture.runtime);
    const first = await imports.open(identity, { bundleId: randomUUID() }), second = await imports.open(identity, { bundleId: randomUUID() });
    await expect(new DataGenerations(fixture.runtime).begin(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId } })))
      .rejects.toMatchObject({ code: "data_ingestion_admission" });
    await first.cancel(); await second.cancel();
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_ingestion_rows WHERE tenant_id=$1", [identity.tenantId])).rows[0].n).toBe(0);
    const abandoned = await imports.open(identity, { bundleId: randomUUID() });
    await fixture.operator.query("UPDATE official_usage_ingestions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [abandoned.id]);
    expect(await imports.sweep(identity.tenantId)).toBe(1);
    expect((await fixture.runtime.query("SELECT state,stored_bytes::text FROM official_usage_ingestions WHERE id=$1", [abandoned.id])).rows[0])
      .toEqual({ state: "cancelled", stored_bytes: "0" });
    await abandoned.cancel();
    const revoking = await imports.open(identity, { bundleId: randomUUID() });
    await fixture.runtime.query("UPDATE data_principal_epochs SET epoch=epoch+1 WHERE tenant_id=$1", [identity.tenantId]);
    await expect(revoking.receive(csvSource("users", ["user,Name,1,1,"]))).rejects.toBeInstanceOf(Error);
  });
  it.each(["bogus", "responsesOnly", "startDate", "username"])("rejects meaningless history filter %s", key => {
    expect(() => reportQuery("history", { [key]: "value" })).toThrow();
  });

  it("exercises real auth/CSRF multipart factories including fields after file and disconnect cleanup", async () => {
    const identity = { ...selectionIdentity, tenantId: config.tenants[0].tenantId!, principalId: "candidate-http" };
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30), app = express();
    app.use(express.json());
    app.use(session({ secret, resave: false, saveUninitialized: false }));
    app.use((request, _response, next) => {
      request.session.accountId = identity.principalId; request.session.tenantId = identity.tenantId; request.session.clientId = config.tenants[0].clientId;
      request.session.csrfToken = "candidate-csrf"; request.session.rolesValidatedAt = Date.now();
      request.session.user = { ...usageAudit(identity).actor, roles: request.get("x-fixture-role") === "viewer" ? ["AgentControl.Viewer"] : ["AgentControl.Admin"] };
      next();
    });
    const enqueue = vi.fn(async () => {});
    app.use("/api", createOfficialReportDataRouter({ reports, identity: async () => ({ identity, tokenMode: "delegated" }), enqueueExport: enqueue }));
    for (const [key, policy] of declaredRoutePolicies) {
      expect(policy.access).toBe("authenticated");
      if (policy.access === "authenticated" && !key.startsWith("GET ")) expect(policy.csrf).toBe(true);
    }
    app.use(errorHandler);
    const server = await new Promise<Server>(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    try {
      const form = () => { const data = new FormData(); data.set("file", new Blob([`${schemaRegistry.users.headers.join(",")}\nuser,Name,1,1,${today}`]), "users.csv");
        data.set("downloadedAt", new Date().toISOString()); return data; };
      expect((await fetch(`${base}/official-usage/staging?bundleId=${randomUUID()}`, { method: "POST", body: form() })).status).toBe(403);
      expect((await fetch(`${base}/official-usage/staging?bundleId=${randomUUID()}`, { method: "POST", body: form(), headers: { "x-csrf-token": "candidate-csrf", "x-fixture-role": "viewer" } })).status).toBe(403);
      const uploaded = await fetch(`${base}/official-usage/staging?bundleId=${randomUUID()}`, { method: "POST", body: form(), headers: { "x-csrf-token": "candidate-csrf" } });
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      const preview = await uploaded.json() as { id: string };
      expect((await fetch(`${base}/official-usage/staging/${preview.id}/diagnostics`)).status).toBe(200);
      expect((await fetch(`${base}/official-usage/staging/${preview.id}`, { method: "DELETE", headers: { "x-csrf-token": "candidate-csrf" } })).status).toBe(204);
      expect((await fetch(`${base}/copilot-usage/users/unresolved-identities`)).status).toBe(200);
      const repeated = form(); repeated.append("downloadedAt", new Date().toISOString());
      expect((await fetch(`${base}/official-usage/staging?bundleId=${randomUUID()}`, { method: "POST", body: repeated, headers: { "x-csrf-token": "candidate-csrf" } })).status).toBe(400);
      const disconnectedBundle = randomUUID(), controller = new AbortController(), boundary = "candidate-disconnect";
      const body = new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\n${schemaRegistry.users.headers.join(",")}\n`));
      } });
      const disconnected = fetch(`${base}/official-usage/staging?bundleId=${disconnectedBundle}`, { method: "POST", body, signal: controller.signal,
        duplex: "half", headers: { "x-csrf-token": "candidate-csrf", "content-type": `multipart/form-data; boundary=${boundary}` } } as RequestInit);
      const rejected = disconnected.catch(error => error);
      await vi.waitFor(async () => expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_ingestions WHERE bundle_id=$1 AND state='streaming'", [disconnectedBundle])).rows[0].n).toBe(1), { timeout: 5000 });
      controller.abort();
      expect(await rejected).toBeInstanceOf(Error);
      await vi.waitFor(async () => expect((await fixture.runtime.query("SELECT state FROM official_usage_ingestions WHERE bundle_id=$1", [disconnectedBundle])).rows[0].state).toBe("cancelled"), { timeout: 5000 });
      expect(enqueue).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it("preserves UPN/object-ID ambiguity and blank Agents dates without assigning paid status", async () => {
    const identity = { ...selectionIdentity, tenantId: "combined-ambiguous" }, users = [sourceUser(1), sourceUser(2), sourceUser(3)];
    users[0].identity.userPrincipalName = users[1].identity.objectId;
    await directory(fixture.runtime, identity, users);
    const username = users[1].identity.objectId;
    await publish(new OfficialReportImports(fixture.runtime), identity, { users: [`${username},Ambiguous,1,5,${today}`],
      agents: ["agent,Agent,User,1,0,5,"], userAgents: [`agent,Agent,User,${username},5,${today}`] });
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    const selected = await reports.capture(identity, "delegated", "copilot_users");
    const combined = await reports.page<CombinedUser>(selected.id, identity);
    expect(combined.summary).toMatchObject({ licensedUsers: 3, usingAgentsUsers: 0, noAgentActivityUsers: 0, unresolvedIdentities: 1 });
    expect(combined.value.every(row => row.reportedResponses === null && row.agentActivityState === "unknown")).toBe(true);
    const official = await reports.capture(identity, "delegated", "official_users");
    expect((await reports.page<ReportUser>(official.id, identity)).value[0]).toMatchObject({ objectId: null, entitlement: null, reportedResponses: 5 });
    const agents = await reports.capture(identity, "delegated", "official_agents");
    expect((await reports.page(agents.id, identity)).value[0]).toMatchObject({ lastActivityDateUtc: null, responses: 5 });
  });

  it("keeps idle immutable selection aggregates bounded without losing ambiguity, known zero, fences or reverse cursors", async () => {
    const identity = { ...selectionIdentity, tenantId: `bounded-report-${randomUUID()}` };
    const users = Array.from({ length: 6 }, (_, index) => sourceUser(index + 1));
    users.forEach((user, index) => { user.identity.displayName = `${String.fromCharCode(65 + index)} User`; });
    users[2].identity.userPrincipalName = users[3].identity.userPrincipalName = "shared@example.invalid";
    await directory(fixture.runtime, identity, users);
    await publish(new OfficialReportImports(fixture.runtime), identity, {
      users: [`user2@example.invalid,Zero,0,0,${today}`, `shared@example.invalid,Ambiguous,1,2,${today}`,
        `${users[4].identity.objectId},Alias,1,2,${today}`, `user5@example.invalid,Alias,1,3,${today}`,
        `unresolved@example.invalid,Outside page,1,4,${today}`],
      agents: [`agent,Agent,User,1,0,4,${today}`],
      userAgents: [`agent,Agent,User,unresolved@example.invalid,4,${today}`],
    });
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    const selected = await reports.capture(identity, "delegated", "copilot_users");
    const first = await reports.page(selected.id, identity, { limit: 2 });
    expect(first.counts).toEqual({ total: 6, filtered: 6 });
    expect(first.summary.unresolvedIdentities).toBe(4);
    expect(first.value).toMatchObject([
      { directory: { objectId: users[0].identity.objectId }, agentActivityState: "unknown", reportedResponses: null },
      { directory: { objectId: users[1].identity.objectId }, agentActivityState: "none", reportedResponses: 0 },
    ]);
    const another = new LargeTenantUsersReports(fixture.runtime, secret, 30);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    let second: Awaited<ReturnType<typeof reports.page>>;
    try {
      second = await reports.read(selected.id, identity, async (client, context) => {
        const queries = vi.spyOn(client, "query");
        try {
          const page = await another.pageInRead(client, context, { limit: 2, cursor: first.page.nextCursor! });
          expect(queries.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("selected_directory AS MATERIALIZED"))).toBe(true);
          expect(queries.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("AS envelope_summary"))).toBe(false);
          return page;
        } finally { queries.mockRestore(); }
      });
    } finally { clock.mockRestore(); }
    expect(second.value).toMatchObject(users.slice(2, 4).map(user => ({
      directory: { objectId: user.identity.objectId }, agentActivityState: "unknown", reportedResponses: null,
    })));
    expect(second.summary).toEqual(first.summary);
    expect(second.analytics).toEqual(first.analytics);
    const last = await another.page(selected.id, identity, { limit: 2, cursor: second.page.nextCursor! });
    expect(last.value).toMatchObject(users.slice(4).map(user => ({
      directory: { objectId: user.identity.objectId }, agentActivityState: "unknown", reportedResponses: null,
    })));
    expect(last.page.nextCursor).toBeNull();
    expect((await another.exact(selected.id, identity, users[2].identity.objectId)).value)
      .toEqual(second.value[0]);
    expect((await another.page(selected.id, identity, { limit: 2, cursor: second.page.previousCursor! })).value).toEqual(first.value);
    await expect(another.page(selected.id, { ...identity, principalId: "other" })).rejects.toMatchObject({ code: "selection_invalidated" });
    await new DataGenerations(fixture.runtime).invalidate(await reports.sources.ensureScope(identity, "delegated"), identity.tenantId);
    await expect(another.page(selected.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("retains stale observed values but never treats them as current activity or trusted freshness", async () => {
    const identity = { ...selectionIdentity, tenantId: "combined-stale" };
    await directory(fixture.runtime, identity, [sourceUser(1)]);
    await publish(new OfficialReportImports(fixture.runtime), identity, { users: ["user1@example.invalid,User,1,5,2000-01-01"],
      agents: ["agent,Agent,User,1,0,5,2000-01-01"], userAgents: ["agent,Agent,User,user1@example.invalid,5,2000-01-01"] });
    const reports = new LargeTenantUsersReports(fixture.runtime, secret, 30), selected = await reports.capture(identity, "delegated", "copilot_users");
    const page = await reports.page<CombinedUser>(selected.id, identity);
    expect(page.reports.availability).toBe("stale");
    expect(page.reports.lineages.every(row => row.sourceFreshness === "unknown")).toBe(true);
    expect(page.summary).toMatchObject({ licensedUsers: 1, usingAgentsUsers: null, noAgentActivityUsers: null });
    expect(page.value[0]).toMatchObject({ reportedResponses: 5, agentActivityState: "unknown" });
  });

  it("joins exact tenant report identities to principal evidence and excludes unknown paid status", async () => {
    const input = generationInput();
    const generations = new DataGenerations(fixture.runtime);
    const lease = await generations.begin(input);
    const records = ["paid", "unpaid", "unknown"].map((id, n) => ({
      ...directoryRecord(id), upn: `${id}@example.invalid`, upn_key: `${id}@example.invalid`,
      service_state: (["enabled", "disabled", "unknown"] as const)[n],
    }));
    await generations.append(lease, "directory", 0, records);
    await generations.validate(lease, { rows: 3, children: 0, batches: 1, pages: 0, wireRows: 0 });
    await generations.publish(lease);
    const set = await seedReportSet(fixture.operator, input.scope.tenantId, 0);
    for (const [n, record] of records.entries()) await seedUserFact(fixture.operator, input.scope.tenantId, set.versions.users, n, record.upn, 5);
    await generations.connections.selectedRead(async client => {
      const rows = (await client.query(`${reportRelationsSql} SELECT identity,responses::text FROM combined
        WHERE entitlement IN ('no_paid','paid_inactive') AND responses>0`, [lease.id, null, false, input.scope.tenantId, set.id, 5])).rows;
      expect(rows).toEqual([{ identity: "unpaid", responses: "5" }]);
      expect((await client.query(`${reportRelationsSql} SELECT count(*) AS n FROM combined WHERE responses IS NOT NULL`,
        [lease.id, null, false, "other-tenant", set.id, 5])).rows[0].n).toBe("0");
    });
  });
});
