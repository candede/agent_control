import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { usageAudit } from "../db/agentUsageTestSupport.js";
import { seedDisjointReportUnion, seedReportSet, seedUserFact } from "../../scripts/officialReportFixtures.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { OfficialReportExports } from "./officialReportExports.js";
import { schemaRegistry } from "./officialReportFields.js";
import { reportExportColumns, type ReportAgent, type ReportPage, type ReportQuery, type ReportRelationship, type ReportUser } from "../types/officialReportData.js";
import type { CopilotDirectoryUser, CopilotServiceSummaryState } from "../types/copilotUsage.js";
import type { SelectionIdentity } from "./dataSelections.js";
import type { ExportSource } from "./dataExports.js";

type Rows = Record<"agents" | "userAgents" | "users", string[]>;
let fixture: Awaited<ReturnType<typeof testDatabase>>, imports: OfficialReportImports, reports: LargeTenantUsersReports, today: Date;
const unionIdentity = { ...selectionIdentity, tenantId: `native-union-${randomUUID()}` };
let unionSet: string;
beforeAll(async () => {
  fixture = await testDatabase(); imports = new OfficialReportImports(fixture.runtime);
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-native-view-semantics-secret", 35);
  today = (await fixture.runtime.query("SELECT clock_timestamp() AS now")).rows[0].now;
  unionSet = (await seedDisjointReportUnion(fixture.operator, unionIdentity.tenantId, 50000)).id;
  await reports.history.ensure(unionIdentity.tenantId);
  await reports.history.connections.run(client => reports.history.accepted(client, unionIdentity.tenantId, unionSet));
}, 30_000);
afterAll(async () => { await fixture?.close(); });
const owner = (): SelectionIdentity => ({ ...selectionIdentity, tenantId: `native-views-${randomUUID()}` });
const day = (offset = 0) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
const baseline = (): Rows => ({
  agents: [`usage-a,Agent A,Declarative,2,1,9,${day()}`, `usage-b,Agent B,Custom,1,0,4,${day(-35)}`],
  userAgents: [`usage-a,Agent A,Declarative,CaseSensitiveUser,5,${day()}`, `usage-b,Agent B,Custom,CaseSensitiveUser,4,${day(-35)}`,
    `usage-a,Agent A,Declarative,casesensitiveuser,4,${day(-1)}`, `usage-report-only,Report-only agent,Your Users,CaseSensitiveUser,2,${day()}`],
  users: [`CaseSensitiveUser,Pseudonym A,2,9,${day()}`, `casesensitiveuser,Pseudonym B,1,4,${day(-1)}`],
});
async function stage(identity: SelectionIdentity, kind: keyof Rows, rows: string[], bundleId: string) {
  return imports.stage(identity, { bundleId }, (async function* () {
    yield Buffer.from(schemaRegistry[kind].headers.join(",") + "\n");
    for (const row of rows) yield Buffer.from(row + "\n");
  })());
}
async function publish(identity: SelectionIdentity, rows = baseline()) {
  const bundleId = randomUUID();
  for (const kind of ["agents", "userAgents", "users"] as const) await stage(identity, kind, rows[kind], bundleId);
  return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
}
async function users(identity: SelectionIdentity, query: ReportQuery = {}, limit = 50) {
  const selection = await reports.capture(identity, "delegated", "official_users", query);
  return reports.page(selection.id, identity, { limit }) as Promise<ReportPage<ReportUser>>;
}
async function agents(identity: SelectionIdentity, query: ReportQuery = {}, limit = 50) {
  const selection = await reports.capture(identity, "delegated", "official_agents", query);
  return reports.page(selection.id, identity, { limit }) as Promise<ReportPage<ReportAgent>>;
}
async function relationships(identity: SelectionIdentity, selectionId: string, child: string, limit = 50, childQuery?: ReportQuery) {
  return reports.page(selectionId, identity, { endpoint: "relationships", child, limit, childQuery }) as Promise<ReportPage<ReportRelationship>>;
}
function directoryUser(index: number, upn: string, state: CopilotServiceSummaryState = "disabled", company: string | null = null, department: string | null = null): CopilotDirectoryUser {
  return { serviceEvidenceVersion: 1, identity: { objectId: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    userPrincipalName: upn, displayName: upn, companyName: company?.trim() || null, department: department?.trim() || null,
    employeeType: null, accountEnabled: true, userType: "Member" },
  copilotServiceState: state, servicePlans: state === "disabled" ? [] : [{
    servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS", displayName: "Copilot",
    state: state === "partially_enabled" ? "enabled" : state, capabilityStatus: state === "enabled" ? "Enabled" : null, assignedDateTime: null,
  }, ...(state === "partially_enabled" ? [{ servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS",
    displayName: "Teams", state: "disabled" as const, capabilityStatus: null, assignedDateTime: null }] : [])] };
}
async function directory(identity: SelectionIdentity, rows: CopilotDirectoryUser[]) {
  const stages = new UserSourceStages(fixture.runtime);
  return stages.execute(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId } }), async lease => {
    const key = await stages.query(lease, "discovery", "synthetic:native-view-directory");
    await stages.page(lease, key, "synthetic:native-view-directory", rows.length, rows.length);
    for (let start = 0; start < rows.length; start += 250) await stages.directory(lease, key, rows.slice(start, start + 250));
    await stages.finishQuery(lease, key);
  }, { beforePublish: async () => {} });
}

describe("native report row semantics and exact children", () => {
  it.each(["official_users", "official_agents"] as const)("preserves the disjoint 50k plus 50k %s union without materializing a tenant", async endpoint => {
    const settingsSql = "SELECT current_setting('enable_nestloop') AS nested,current_setting('enable_mergejoin') AS merge,current_setting('jit') AS jit";
    const settings = (await fixture.runtime.query(settingsSql)).rows;
    const selection = await reports.capture(unionIdentity, "delegated", endpoint, { setId: unionSet });
    await reports.read(selection.id, unionIdentity, async (client, context) => {
      const first = await reports.pageInRead(client, context, { limit: 50 });
      expect(first.counts).toEqual({ total: 100000, filtered: 100000 }); expect(first.value).toHaveLength(50);
      expect(first.page.nextCursor).toEqual(expect.any(String)); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1048576);
      expect((await client.query(settingsSql)).rows).toEqual([{ nested: "off", merge: "off", jit: "off" }]);
      const tailIds = endpoint === "official_users" ? ["bridge-49999", "user-49999"] : ["agent-49999", "agents-report-49999"];
      const tails = await reports.rowsInRead(client, context, { exactIds: tailIds, limit: 2 });
      expect(tails.counts).toEqual({ total: 2, filtered: 2 }); expect(tails.value).toHaveLength(2);
      for (const id of tailIds) expect(tails.value).toContainEqual(expect.objectContaining(
        endpoint === "official_users" ? { username: id } : { agentId: id }));
    });
    expect((await fixture.runtime.query(settingsSql)).rows).toEqual(settings);
  });
  it("keeps small-tenant lineage probes indexed after shared fact-table statistics are collected", async () => {
    await fixture.operator.query("ANALYZE official_usage_row_facts; ANALYZE official_usage_version_rows; ANALYZE official_usage_versions; ANALYZE official_usage_set_versions");
    const identity = owner(); await publish(identity);
    await reports.history.connections.selectedRead(async client => {
      const root = await reports.history.root(client, identity.tenantId, new Date());
      const original = client.query, query = client.query.bind(client);
      let captured: { text: string; values: unknown[] } | undefined;
      client.query = ((text: string, values: unknown[] = []) => {
        if (text.startsWith("WITH snapshot_sets AS MATERIALIZED")) captured = { text, values };
        return query(text, values);
      }) as typeof client.query;
      try { await reports.history.validateRoot(client, root, identity); }
      finally { client.query = original; }
      if (!captured) throw new Error("lineage_probe_missing");
      const plan = (await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${captured.text}`, captured.values)).rows[0]["QUERY PLAN"][0];
      expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThanOrEqual(1048576);
      type PlanNode = { "Relation Name"?: string; "Actual Rows"?: number; "Rows Removed by Filter"?: number; "Actual Loops"?: number; Plans?: PlanNode[] };
      const pending: PlanNode[] = [plan.Plan];
      let probes = 0;
      while (pending.length) {
        const node = pending.pop()!;
        pending.push(...node.Plans ?? []);
        if (node["Relation Name"] === "official_usage_membership_counts") {
          probes++;
          expect(((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 0)).toBeLessThanOrEqual(250);
        }
        expect(node["Relation Name"]).not.toBe("official_usage_row_facts");
      }
      expect(probes).toBeGreaterThan(0);
    });
    expect((await users(identity)).counts).toEqual({ total: 2, filtered: 2 });
  });
  it("keeps authoritative totals, reconciliation and nonadditive active identities separate", async () => {
    const identity = owner(); await publish(identity);
    const page = await agents(identity);
    expect(page.summary).toMatchObject({ reportedResponses: 13, bridgeResponses: 15, userReportedResponses: 13,
      distinctActiveReportUsers: 2, licensedOccurrences: 3, unlicensedOccurrences: 1,
      responseReconciliation: "mismatch", activeUsersAreNonAdditive: true });
    expect(page.counts).toEqual({ total: 3, filtered: 3 });
    expect(page.value.find(row => row.agentId === "usage-a")).toMatchObject({ activeUsers: 2, activeUsersBasis: "userAgents_distinct_identity", identityStatus: "unresolved" });
    expect(page.value.find(row => row.agentId === "usage-report-only")).toMatchObject({ responses: 2, responseSource: "userAgents", licensedUserOccurrences: null });
    expect(page.analytics).toMatchObject({ basis: "filtered_rows", responses: 15, agents: { anchorDateUtc: day(), windowResponses: 11, windowDistinctActiveUsers: 2 } });
  });
  it("ranks response analytics numerically across digit widths", async () => {
    const identity = owner();
    await publish(identity, { agents: ["nine,Nine,Custom,1,0,9,", "ten,Ten,Custom,1,0,10,", "hundred,Hundred,Custom,1,0,100,"], users: [], userAgents: [] });
    const page = await agents(identity);
    expect(page.analytics.agents?.mostResponses.map(row => row.responses)).toEqual([100, 10, 9]);
    expect(page.analytics.agents?.leastResponses.map(row => row.responses)).toEqual([9, 10, 100]);
  });
  it.each([["absent", "unknown"], ["unresolved", "unknown"], ["empty", "none"]] as const)(
    "preserves the no-matching-report activity golden with %s evidence", async (evidence, state) => {
      const identity = owner(); await directory(identity, [directoryUser(1, "person@example.invalid", "enabled")]);
      if (evidence !== "absent") await publish(identity, { agents: [], users: [],
        userAgents: evidence === "unresolved" ? ["agent,Agent,Custom,unresolved,1,"] : [] });
      const selected = await reports.capture(identity, "delegated", "copilot_users");
      expect((await reports.page(selected.id, identity)).value).toMatchObject([{ agentActivityState: state }]);
    });
  it("preserves case-distinct pseudonyms, full Users totals and separately paged report-only relationships", async () => {
    const identity = owner(); await publish(identity);
    const page = await users(identity, { sort: "responses", order: "desc" }, 1);
    expect(page.counts).toEqual({ total: 2, filtered: 2 });
    expect(page.value).toMatchObject([{ username: "CaseSensitiveUser", displayName: "Pseudonym A", reportedResponses: 9,
      reportedAgentsUsed: 2, bridgeResponses: 11, relationshipCount: 3, hasReportMismatch: true, objectId: null, userLastActivityDateUtc: day() }]);
    expect(page.value[0]).not.toHaveProperty("rows");
    const child = await relationships(identity, page.selection.id, "CaseSensitiveUser", 1);
    expect(child.counts).toEqual({ total: 3, filtered: 3 }); expect(child.value).toHaveLength(1);
    expect(child.value[0].identityStatus).toBe("unresolved"); expect(child.page.nextCursor).toEqual(expect.any(String));
    const next = await reports.page(page.selection.id, identity, { limit: 1, cursor: page.page.nextCursor! });
    expect(next.value).toMatchObject([{ username: "casesensitiveuser", reportedResponses: 4, relationshipCount: 1, hasReportMismatch: false }]);
    await expect(reports.exact(page.selection.id, identity, "CASESENSITIVEUSER")).rejects.toMatchObject({ status: 404 });
  });
  it("filters and orders server rows before paging without inventing identities", async () => {
    const identity = owner(); await publish(identity);
    expect((await users(identity, { search: "pseudonym b" }, 1)).value).toMatchObject([{ username: "casesensitiveuser" }]);
    expect((await agents(identity, { search: "Agent A" }, 1)).value).toMatchObject([{ agentId: "usage-a" }]);
    for (const sort of ["responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity", "name"] as const) {
      for (const order of ["asc", "desc"] as const) {
        const full = await agents(identity, { sort, order }), first = await agents(identity, { sort, order }, 1);
        const second = await reports.page(first.selection.id, identity, { limit: 1, cursor: first.page.nextCursor! });
        expect(first.value).toEqual(full.value.slice(0, 1)); expect(second.value).toEqual(full.value.slice(1, 2));
        expect(second.counts).toEqual(full.counts); expect(second.summary).toEqual(first.summary);
      }
    }
  });
  it("retains unknown activity until an inclusive civil-date predicate is selected", async () => {
    const identity = owner(), rows = baseline();
    rows.agents.push("undated,Unknown,Custom,1,0,0,"); await publish(identity, rows);
    const all = await agents(identity, { sort: "lastActivity", order: "asc" });
    expect(all.value.at(-1)).toMatchObject({ agentId: "undated", lastActivityDateUtc: null });
    const exact = await agents(identity, { startDate: day(), endDate: day() });
    expect(exact.value.map(row => row.agentId).sort()).toEqual(["usage-a", "usage-report-only"]);
    expect((await agents(identity, { endDate: day(-35) })).value).toMatchObject([{ agentId: "usage-b" }]);
  });
  it("keeps wide Unicode name/identity cursors within 4 KiB without dropping either sort direction", async () => {
    const identity = owner(), rows: Rows = { agents: [], userAgents: [], users: [] };
    for (let n = 0; n < 4; n++) rows.agents.push(`${`id${n}`.padEnd(512, "語")},${`Name${n}`.padEnd(512, "語")},Custom,1,0,${n + 1},`);
    await publish(identity, rows);
    for (const order of ["asc", "desc"] as const) {
      const first = await agents(identity, { sort: "name", order }, 2);
      expect(first.value).toHaveLength(2); expect(Buffer.byteLength(first.page.nextCursor!)).toBeLessThanOrEqual(4096);
      const next = await reports.page(first.selection.id, identity, { limit: 2, cursor: first.page.nextCursor! }) as ReportPage<ReportAgent>;
      const expected = order === "asc" ? [0, 1, 2, 3] : [3, 2, 1, 0];
      expect([...first.value, ...next.value].map(row => Number(row.agentId[2]))).toEqual(expected);
      expect(next.page.nextCursor).toBeNull(); expect(Buffer.byteLength(next.page.previousCursor!)).toBeLessThanOrEqual(4096);
      expect((await reports.page(first.selection.id, identity, { limit: 2, cursor: next.page.previousCursor! })).value).toEqual(first.value);
    }
  });
  it("distinguishes absent selection, incomplete imports, unselected retained sets, deletion and stale evidence", async () => {
    const identity = owner();
    expect((await users(identity)).reports.availability).toBe("never_imported");
    const draft = await stage(identity, "users", ["person,Person,1,1,"], randomUUID());
    const partial = await imports.accept(identity, { stagingId: draft.id, revision: draft.revision, contentHash: draft.contentHash, expectedActiveRevision: draft.activeRevision });
    expect((await users(identity)).reports.availability).toBe("incomplete");
    await imports.confirm(identity, await imports.confirmPreview(identity, partial.setId, "delete"));
    const first = await publish(identity, { agents: [], userAgents: [], users: ["person,Person,1,1,"] });
    const active = await users(identity);
    expect(active.reports).toMatchObject({ availability: "active", periodAgeDays: null, acceptedAgeDays: 0,
      reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range" } });
    await fixture.operator.query("UPDATE official_usage_sets SET accepted_at=clock_timestamp()-interval '40 days' WHERE id=$1", [first.setId]);
    expect((await users(identity)).reports).toMatchObject({ availability: "stale", acceptedAgeDays: 40 });
    const second = await publish(identity, { agents: [], userAgents: [], users: ["person,Person,1,2,"] });
    await imports.confirm(identity, await imports.confirmPreview(identity, second.setId, "delete"));
    expect((await users(identity)).reports.availability).toBe("not_selected");
    await imports.confirm(identity, await imports.confirmPreview(identity, first.setId, "delete"));
    expect((await users(identity)).reports.availability).toBe("deleted");
  });
  it("does not replace missing Users observations or missing relationship evidence with inferred zero", async () => {
    const identity = owner();
    await publish(identity, { agents: ["agent,Agent,Custom,4,0,7,"], userAgents: ["agent,Agent,Custom,bridge,7,"], users: [] });
    const page = await users(identity);
    expect(page.summary.userReportedResponses).toBe(0);
    expect(page.value).toMatchObject([{ username: "bridge", missingUserReport: true, reportedResponses: null,
      reportedAgentsUsed: null, bridgeResponses: 7, userLastActivityDateUtc: null, hasReportMismatch: false, reviewCohort: "unknown" }]);
    await publish(identity, { agents: ["agent,Agent,Custom,4,0,7,"], userAgents: [], users: ["user,User,1,7,"] });
    expect((await users(identity)).value).toMatchObject([{ hasReportMismatch: false, bridgeResponses: null, relationshipCount: 0 }]);
    expect((await agents(identity)).value).toMatchObject([{ activeUsers: null, activeUsersBasis: "unknown", responseComparison: "not_comparable" }]);
  });
  it("keeps explicit zero-response companions distinct from absent companions", async () => {
    const identity = owner();
    await publish(identity, { agents: ["zero,Zero,Custom,9,5,0,", "missing,Missing,Custom,8,3,0,"],
      userAgents: ["zero,Zero,Custom,user,0,"], users: ["user,User,0,0,"] });
    const page = await agents(identity);
    expect(page.value.find(row => row.agentId === "zero")).toMatchObject({ activeUsers: 0, activeUsersBasis: "userAgents_distinct_identity" });
    expect(page.value.find(row => row.agentId === "missing")).toMatchObject({ activeUsers: null, activeUsersBasis: "unknown" });
    expect(page.summary.distinctActiveReportUsers).toBe(0);
  });
  it("rejects inexact aggregate totals instead of rounding safe individual rows", async () => {
    const identity = owner(), value = 4503599627370496;
    await expect(publish(identity, { agents: [], userAgents: [], users: [`one,One,1,${value},`, `two,Two,1,${value},`] }))
      .rejects.toMatchObject({ status: 400, code: "numeric_overflow" });
    expect((await users(identity)).reports.availability).toBe("never_imported");
    const restored = await seedReportSet(fixture.operator, identity.tenantId, 1, "restored-overflow-fixture", { users: 2 });
    await seedUserFact(fixture.operator, identity.tenantId, restored.versions.users, 0, "one", value);
    await seedUserFact(fixture.operator, identity.tenantId, restored.versions.users, 1, "two", value);
    await reports.history.connections.run(client => reports.history.accepted(client, identity.tenantId, restored.id));
    await expect(users(identity, { setId: restored.id })).rejects.toMatchObject({ status: 409, code: "official_usage_total_limit" });
  });
  it("applies inclusive cohort thresholds and anchors inactivity to observed Users dates", async () => {
    const identity = owner();
    await publish(identity, { agents: [], userAgents: ["agent,Agent,Custom,bridge,4,"], users: [
      `zero,Zero,0,0,${day(-40)}`, `one,One,1,1,${day(-40)}`, `five,Five,1,5,${day(-41)}`,
      `six,Six,1,6,${day(-69)}`, `old,Old,1,7,${day(-70)}`, "undated,Undated,1,2,",
    ] });
    expect((await users(identity, { cohort: "zero" })).value.map(row => row.username)).toEqual(["zero"]);
    expect((await users(identity, { cohort: "low", sort: "responses", order: "asc" })).value.map(row => row.username)).toEqual(["one", "undated", "five"]);
    expect((await users(identity, { cohort: "review", lowResponseThreshold: 1 })).value.map(row => row.username).sort()).toEqual(["one", "zero"]);
    expect((await users(identity, { reportActivity: "recent", inactiveDays: 30 })).value.map(row => row.username).sort()).toEqual(["five", "one", "six", "zero"]);
    expect((await users(identity, { reportActivity: "inactive", inactiveDays: 30 })).value.map(row => row.username)).toEqual(["old"]);
    expect((await users(identity, { reportActivity: "no-activity" })).value.map(row => row.username).sort()).toEqual(["bridge", "undated"]);
  });
  it("keeps agent/creator/positive-response predicates on the same relationship while preserving full user details", async () => {
    const identity = owner();
    await publish(identity, { agents: [], users: ["one,One,2,50,", "two,Two,2,40,", "three,Three,1,0,"], userAgents: [
      "A,Alpha,Custom,one,0,", "B,Beta,Declarative,one,5,", "A,Alpha,Custom,two,4,", "B,Beta,Declarative,two,6,", "A,Alpha,Declarative,three,0,",
    ] });
    expect((await users(identity, { agentId: "A", creatorType: "Declarative", responsesOnly: true })).value).toEqual([]);
    const page = await users(identity, { agentId: "A", creatorType: "Custom", responsesOnly: true });
    expect(page.value).toMatchObject([{ username: "two", reportedResponses: 40, relationshipCount: 2, bridgeResponses: 10 }]);
    expect((await relationships(identity, page.selection.id, "two")).value.map(row => row.agentId)).toEqual(["A", "B"]);
    expect((await users(identity, { agentId: "a" })).value).toEqual([]);
    expect((await users(identity, { agentId: "A", responsesOnly: true, search: "Beta" })).value).toEqual([]);
  });
  it("keeps exact parent identity and metrics independent of child search and paging", async () => {
    const identity = owner(); await publish(identity);
    const page = await agents(identity), detail = await reports.exact(page.selection.id, identity, "usage-a");
    expect(detail).toMatchObject({ value: { agentId: "usage-a", responses: 9, bridgeResponses: 9, activeUsers: 2 } });
    const children = await relationships(identity, page.selection.id, "usage-a", 1, { search: "casesensitiveuser", sort: "responses", order: "asc" });
    expect(children.counts.filtered).toBe(2); expect(children.value).toMatchObject([{ username: "casesensitiveuser", responses: 4 }]);
    const reread = await reports.exact(page.selection.id, identity, "usage-a");
    expect(Date.parse(reread.selection.validatedAt)).toBeGreaterThanOrEqual(Date.parse(detail.selection.validatedAt));
    expect(reread).toEqual({ ...detail, selection: { ...detail.selection, validatedAt: reread.selection.validatedAt } });
    for (const id of ["USAGE-A", "Agent A", "inventory:usage-a"]) await expect(reports.exact(page.selection.id, identity, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("native current licensing and organization evidence", () => {
  async function organization() {
    const identity = owner(), entries = [
      ["first", " Alpha ", " Engineering ", "disabled", 9], ["second", "Alpha", "Sales", "disabled", 8],
      ["third", "Beta", "Engineering", "suspended", 7], ["fourth", "Alpha", "Engineering", "disabled", 6],
      ["fifth", "alpha", "engineering", "disabled", 5], ["missing", " \t ", null, "disabled", 4],
      ["paid", "Paid only", "Paid department", "enabled", 3], ["unknown", "Unknown only", "Unknown department", "unknown", 2],
      ["inactive", "Inactive only", "Inactive department", "disabled", 0],
    ] as const;
    await publish(identity, { agents: [], userAgents: [], users: entries.map(([name, , , , responses]) => `${name}@example.invalid,${name},1,${responses},`) });
    const generation = await directory(identity, entries.map(([name, company, department, state], index) => directoryUser(index + 1, `${name}@example.invalid`, state, company, department)));
    return { identity, generation };
  }
  it("returns trimmed case-preserving complete eligible facets rather than page-local organizations", async () => {
    const { identity } = await organization(), page = await users(identity, { licenseCohort: "active_without_paid", sort: "responses", order: "desc" }, 1);
    expect(page.counts.filtered).toBe(6);
    expect(page.value).toMatchObject([{ username: "first@example.invalid", company: "Alpha", department: "Engineering" }]);
    const companies = await reports.facets(page.selection.id, identity, { field: "company", limit: 100 });
    const departments = await reports.facets(page.selection.id, identity, { field: "department", limit: 100 });
    expect(companies.value.map(row => row.value)).toEqual(["Alpha", "alpha", "Beta", null]);
    expect(departments.value.map(row => row.value)).toEqual(["Engineering", "engineering", "Sales", null]);
    expect((await users(identity, { licenseCohort: "active_without_paid", company: "Alpha", department: "Engineering", search: "first" })).value)
      .toMatchObject([{ username: "first@example.invalid" }]);
    expect((await users(identity, { licenseCohort: "active_without_paid", company: null })).value).toMatchObject([{ username: "missing@example.invalid", company: null }]);
  });
  it.each([
    [{ company: "Alpha" }, ["first", "fourth", "second"]], [{ department: "Engineering" }, ["first", "fourth", "third"]],
    [{ company: "Alpha", department: "Engineering" }, ["first", "fourth"]], [{ company: "Alpha", department: "engineering" }, []],
    [{ company: "alpha", department: "engineering" }, ["fifth"]], [{ company: "Al" }, []], [{ department: "Missing" }, []], [{ company: "Paid only" }, []],
  ] as const)("uses exact organization values with AND semantics: %j", async (query, names) => {
    const { identity } = await organization();
    expect((await users(identity, { licenseCohort: "active_without_paid", ...query })).value.map(row => row.username)).toEqual(names.map(name => `${name}@example.invalid`));
  });
  it.each(["enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"] as const)(
    "classifies current %s evidence independently of the report window", async state => {
      const identity = owner();
      await publish(identity, { agents: [], userAgents: [], users: [`person@example.invalid,Person,1,1,${day(-80)}`] });
      await directory(identity, [directoryUser(1, "person@example.invalid", state)]);
      const page = await users(identity, { licenseCohort: "active_without_paid" });
      expect(page.counts.filtered).toBe(["disabled", "suspended", "locked_out"].includes(state) ? 1 : 0);
      expect(page.summary).toMatchObject({ paidActiveReportUsers: ["enabled", "warning", "partially_enabled"].includes(state) ? 1 : 0,
        activeWithoutPaidUsers: ["disabled", "suspended", "locked_out"].includes(state) ? 1 : 0, unknownLicenseActiveReportUsers: state === "unknown" ? 1 : 0 });
    });
  it("does not leak unpaid licensing across principals or infer an object identity from display names", async () => {
    const identity = owner();
    await publish(identity, { agents: [], userAgents: [], users: ["person@example.invalid,Person,1,4,"] });
    await directory(identity, [directoryUser(1, "person@example.invalid", "disabled", "Private", "Private")]);
    const other = { ...identity, principalId: "different-reader" }, page = await users(other, { licenseCohort: "active_without_paid" });
    expect(page.value).toEqual([]); expect(page.sources.directory.state).toBe("unavailable");
    expect(page.summary.activeWithoutPaidUsers).toBeNull();
    expect((await users(other)).value).toMatchObject([{ username: "person@example.invalid", objectId: null, company: null, department: null }]);
    await directory(other, [{ ...directoryUser(2, "unrelated@example.invalid"), identity: { ...directoryUser(2, "unrelated@example.invalid").identity, displayName: "person@example.invalid" } }]);
    expect((await users(other, { licenseCohort: "active_without_paid" })).value).toEqual([]);
  });
  it.each(["report", "directory"] as const)("preserves %s ambiguity instead of calling it verified unpaid", async ambiguity => {
    const identity = owner(), first = directoryUser(1, "case@example.invalid"), second = directoryUser(2, "CASE@example.invalid");
    await directory(identity, ambiguity === "directory" ? [first, second] : [first]);
    await publish(identity, { agents: [], userAgents: [], users: [
      "case@example.invalid,Case,1,2,", `${ambiguity === "directory" ? second.identity.objectId : "CASE@example.invalid"},Other,1,3,`,
      `${first.identity.objectId},Object alias,1,4,`,
    ] });
    const page = await users(identity, { licenseCohort: "active_without_paid" });
    expect(page.value).toEqual([]); expect(page.summary).toMatchObject({ activeWithoutPaidUsers: 0, unknownLicenseActiveReportUsers: 3, unresolvedIdentities: 3 });
  });
  it("does not poison unique exact object IDs merely because unused directory aliases collide", async () => {
    const identity = owner(), first = directoryUser(1, "case@example.invalid"), second = directoryUser(2, "CASE@example.invalid");
    await directory(identity, [first, second]);
    await publish(identity, { agents: [], userAgents: [], users: [
      `${first.identity.objectId},First,1,2,`, `${second.identity.objectId},Second,1,3,`,
    ] });
    expect((await users(identity, { licenseCohort: "active_without_paid" })).value.map(row => row.objectId)).toEqual([first.identity.objectId, second.identity.objectId]);
  });
  it("includes 501-user tail organizations without draining users or deriving facets from the first 100 rows", async () => {
    const identity = owner(), rows: Rows = { agents: [], userAgents: [], users: [] }, directoryRows: CopilotDirectoryUser[] = [];
    for (let n = 0; n < 501; n++) {
      const username = `person-${n}@example.invalid`;
      rows.users.push(`${username},Person ${n},1,${501 - n},`);
      directoryRows.push(directoryUser(n + 1, username, "disabled", n === 500 ? "Tail company" : "First company", n === 500 ? "Tail department" : "First department"));
    }
    await publish(identity, rows); await directory(identity, directoryRows);
    const first = await users(identity, { licenseCohort: "active_without_paid", sort: "responses", order: "desc" }, 100);
    expect(first.value).toHaveLength(100); expect(first.counts.filtered).toBe(501);
    expect(first.value.some(row => row.username === "person-500@example.invalid")).toBe(false);
    expect((await reports.facets(first.selection.id, identity, { field: "company" })).value.map(row => row.value)).toEqual(["First company", "Tail company"]);
    expect((await reports.facets(first.selection.id, identity, { field: "department" })).value.map(row => row.value)).toEqual(["First department", "Tail department"]);
    expect((await users(identity, { licenseCohort: "active_without_paid", company: "Tail company", department: "Tail department", search: "person-500" }, 1)).value)
      .toMatchObject([{ username: "person-500@example.invalid" }]);
  });
  it("preserves pinned metadata and excludes failed latest-attempt licensing on new captures without erasing reports", async () => {
    const identity = owner();
    await publish(identity, { agents: [], userAgents: [], users: ["person@example.invalid,Person,1,1,"] });
    await directory(identity, [directoryUser(1, "person@example.invalid")]);
    const prior = await users(identity, { licenseCohort: "active_without_paid" });
    expect(prior.counts.filtered).toBe(1);
    const stages = new UserSourceStages(fixture.runtime);
    await expect(stages.execute(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId } }),
      async () => { throw new Error("synthetic directory failure"); }, { beforePublish: async () => {} })).rejects.toThrow("synthetic directory failure");
    const reread = await reports.page(prior.selection.id, identity);
    expect(Date.parse(reread.selection.validatedAt)).toBeGreaterThanOrEqual(Date.parse(prior.selection.validatedAt));
    expect(reread).toEqual({ ...prior, selection: { ...prior.selection, validatedAt: reread.selection.validatedAt } });
    const page = await users(identity, { licenseCohort: "active_without_paid" });
    expect(page.value).toEqual([]); expect(page.sources.directory).toMatchObject({ state: "partial", attemptStatus: "failed" });
    expect(page.summary.activeWithoutPaidUsers).toBeNull();
    expect((await reports.facets(page.selection.id, identity, { field: "company" })).value).toEqual([]);
    expect((await users(identity)).value).toMatchObject([{ username: "person@example.invalid", reportedResponses: 1 }]);
  });
});

describe("bounded native user CSV relationship batches", () => {
  async function build(identity: SelectionIdentity, selectionId: string) {
    const exports = new OfficialReportExports(reports, usageAudit(identity).actor);
    const job = await exports.create(identity, { selectionId, kind: "official_users" }), source = exports.source(identity);
    let reads = 0;
    const measured: ExportSource = (signal, context) => source(signal, { ...context, read: async work => { reads++; return context.read(work); } });
    await exports.engine.build(job, identity, reportExportColumns.official_users, measured);
    return { exports, job, reads };
  }
  function download(identity: SelectionIdentity, exports: OfficialReportExports, job: string) {
    return Readable.from(exports.engine.download(job, identity, new AbortController().signal))
      .pipe(parse({ columns: true, bom: true, max_record_size: 262144 }));
  }
  it("writes one relationship/unknown row per person without one fenced query per user", async () => {
    const identity = owner(), rows: Rows = { agents: ["agent,Agent,Custom,1,0,100,"], userAgents: [], users: [] };
    for (let n = 0; n < 100; n++) {
      rows.users.push(`user-${n},User ${n},1,1,`);
      if (n % 2) rows.userAgents.push(`agent,Agent,Custom,user-${n},1,`);
    }
    await publish(identity, rows);
    const page = await users(identity), { exports, job, reads } = await build(identity, page.selection.id);
    expect(await exports.status(job, identity)).toMatchObject({ status: "ready", rows: 100 });
    expect(reads).toBeLessThanOrEqual(3);
    const chunks = await fixture.runtime.query("SELECT octet_length(bytes)::int AS n FROM data_export_chunks WHERE export_id=$1 ORDER BY ordinal LIMIT 250", [job]);
    expect(chunks.rows.length).toBeGreaterThan(0); expect(chunks.rows.every(row => row.n <= 262144)).toBe(true);
    let count = 0;
    for await (const row of download(identity, exports, job)) {
      const ordinal = Number(row.username.slice(5));
      expect(row.responsesSentToUsers).toBe(ordinal % 2 ? "1" : "Unknown");
      expect(row.reportedResponsesReceived).toBe("1"); expect(row.missingBridgeRows).toBe(String(!(ordinal % 2)));
      count++;
    }
    expect(count).toBe(100);
  });
  it("continues a 501-relationship child through row boundaries and preserves parent order, totals and formula safety", async () => {
    const identity = owner(), rows: Rows = { agents: [], userAgents: [], users: ["one,Alpha,501,1234,", "two,Zeta,0,0,"] };
    for (let n = 0; n < 501; n++) rows.userAgents.push(`agent-${n},${n === 17 ? "=Bad" : `Agent ${String(n).padStart(3, "0")}`},Custom,one,1,`);
    await publish(identity, rows);
    const { exports, job, reads } = await build(identity, (await users(identity)).selection.id);
    expect(await exports.status(job, identity)).toMatchObject({ status: "ready", rows: 502 });
    expect(reads).toBeLessThanOrEqual(8);
    let count = 0;
    for await (const row of download(identity, exports, job)) {
      if (count < 501) {
        const expected = count === 0 ? 17 : count <= 17 ? count - 1 : count;
        expect(row).toMatchObject({ username: "one", reportedResponsesReceived: "1234", agentId: `agent-${expected}`, responsesSentToUsers: "1" });
        if (!count) expect(row.agentName).toBe("'=Bad");
      } else expect(row).toMatchObject({ username: "two", agentId: "", reportedResponsesReceived: "0", responsesSentToUsers: "Unknown" });
      count++;
    }
    expect(count).toBe(502);
  });
  it("continues byte-short wide relationship batches rather than treating fewer than 100 rows as EOF", async () => {
    const identity = owner(), username = "person".padEnd(512, "語"), rows: Rows = { agents: [], userAgents: [], users: [`${username},Person,350,350,`] };
    for (let n = 0; n < 350; n++) rows.userAgents.push(`${`a${String(n).padStart(3, "0")}`.padEnd(512, "語")},${"語".repeat(512)},${"語".repeat(128)},${username},1,`);
    await publish(identity, rows);
    const { exports, job, reads } = await build(identity, (await users(identity)).selection.id);
    expect(await exports.status(job, identity)).toMatchObject({ status: "ready", rows: 350 });
    expect(reads).toBeGreaterThan(5); expect(reads).toBeLessThanOrEqual(12);
    const seen = new Set<number>();
    for await (const row of download(identity, exports, job)) {
      const ordinal = Number(row.agentId.slice(1, 4));
      expect(ordinal).toBeGreaterThanOrEqual(0); expect(ordinal).toBeLessThan(350); expect(seen.has(ordinal)).toBe(false); seen.add(ordinal);
      expect(row).toMatchObject({ username, reportedResponsesReceived: "350", responsesSentToUsers: "1" });
    }
    expect(seen.size).toBe(350);
  });
  it("does not serialize failed latest-attempt licensing as a verified unpaid verdict", async () => {
    const identity = owner();
    await publish(identity, { agents: [], userAgents: [], users: ["person@example.invalid,Person,1,1,"] });
    await directory(identity, [directoryUser(1, "person@example.invalid")]);
    const stages = new UserSourceStages(fixture.runtime);
    await expect(stages.execute(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId, principalId: identity.principalId } }),
      async () => { throw new Error("synthetic directory failure"); }, { beforePublish: async () => {} })).rejects.toThrow("synthetic directory failure");
    const page = await users(identity);
    expect(page.sources.directory.state).toBe("partial");
    const { exports, job } = await build(identity, page.selection.id);
    let count = 0;
    for await (const row of download(identity, exports, job)) {
      expect(row).toMatchObject({ username: "person@example.invalid", entitlement: "unknown", licenseAssignmentStatus: "unavailable" });
      count++;
    }
    expect(count).toBe(1);
  });
});
