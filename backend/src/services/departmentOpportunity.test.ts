import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { departmentEvidence, departmentEvidencePeople, publishDepartmentEvidenceOffice, publishDepartmentEvidenceReports } from "../../scripts/departmentEvidenceFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficeAppAdoptionReads } from "./officeAppAdoptionReads.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { DepartmentOpportunities } from "./departmentOpportunity.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { deleteUsageSet, saveUsageInventory } from "../db/agentUsageTestSupport.js";
import { publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { officeFixturePerson } from "../../scripts/officeAppAdoptionFixtures.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { SavedReadContracts } from "./savedReadContracts.js";
import type { OpportunityQuery } from "../types/departmentOpportunity.js";

const secret = "synthetic-department-evidence-cursor-key-32";
const groupQuery = { company: departmentEvidence.company, department: departmentEvidence.department };
describe("department opportunity canonical SQL and independent selected-read fences", () => {
  let f: Awaited<ReturnType<typeof testDatabase>>, reports: LargeTenantUsersReports, office: OfficeAppAdoptionReads, reads: DepartmentOpportunities;
  beforeEach(async () => {
    f = await testDatabase(); reports = new LargeTenantUsersReports(f.runtime, secret, 35);
    office = new OfficeAppAdoptionReads(f.runtime, secret);
    reads = new DepartmentOpportunities(reports, office, new InventoryQueries(f.runtime, secret, 35, { source: "inventory_canonical" }));
  }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  async function seed() { await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity); return publishDepartmentEvidenceReports(f.runtime, selectionIdentity); }
  it("proves 22-paid/22-active/7-positive gives exactly 15, includes Users-only and independent windows, exhausts bounded audience", async () => {
    await seed();
    const start = performance.now();
    const aggregate = await reads.page(selectionIdentity, groupQuery);
    const group = aggregate.value[0];
    expect(group.denominators).toEqual({ officePaid: 22, officeActive: 22, currentDirectory: 22, currentAgentPaid: 22 });
    expect(group.agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
    expect(aggregate.context.inventory).toBeNull();
    expect(group.coverage.state).toBe("complete");
    expect(group.coverage.reasons).toContain("optional_inventory_unavailable");
    expect(aggregate.context.office.observation!.reportRefreshDate).not.toBe(aggregate.context.report.reports.reportingPeriod!.endDate);
    expect(group).not.toHaveProperty("people"); expect(group).not.toHaveProperty("agents");
    let calls = 1, bytes = Buffer.byteLength(JSON.stringify(aggregate)), cursor: string | undefined;
    const people: string[] = [];
    do {
      const page = await reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported",
        { limit: departmentEvidence.audiencePageSize, ...(cursor ? { cursor } : {}) });
      calls++; bytes += Buffer.byteLength(JSON.stringify(page));
      expect(page.counts.total).toBe(15);
      people.push(...page.value.map(row => row.person.identity));
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(people).size).toBe(15); expect(people).toHaveLength(15);
    const positive = await reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "positive");
    expect(positive.value.some(row => row.person.userPrincipalName === "person-7@example.invalid")).toBe(true);
    expect(positive.value).toHaveLength(7);
    calls++; bytes += Buffer.byteLength(JSON.stringify(positive));
    expect(Buffer.byteLength(JSON.stringify(aggregate))).toBeLessThanOrEqual(131072);
    expect(calls).toBe(5);
    console.log(JSON.stringify({ event: "department_evidence_retrieval", calls, bytes, elapsedMs: performance.now() - start,
      aggregateBytes: Buffer.byteLength(JSON.stringify(aggregate)), paid: 22, active: 22, positive: 7, noReported: 15, unknown: 0 }));
  });
  it("whole-observation duplicate UPN outside filtered company prevents false subtraction", async () => {
    const people = departmentEvidencePeople();
    people[22].identity.userPrincipalName = people[0].identity.userPrincipalName;
    await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity, people);
    await publishDepartmentEvidenceReports(f.runtime, selectionIdentity);
    const page = await reads.page(selectionIdentity, groupQuery);
    expect(page.value[0].agentEvidence).toEqual(departmentEvidence.ambiguous);
    expect(page.value[0].coverage).toMatchObject({ state: "partial", unresolvedReportIdentities: 1 });
    expect(page.value[0].coverage.ambiguousOfficePeople).toBe(2);
  });
  it.each(["concealed", "duplicate_alias"])("preserves %s report identities as unknown rather than negatives", async kind => {
    await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity);
    const username = kind === "concealed" ? "unresolvable-token" : departmentEvidencePeople()[0].identity.objectId;
    await publishDepartmentEvidenceReports(f.runtime, selectionIdentity, { extraUsers: [`${username},Alias,1,10,`] });
    const page = await reads.page(selectionIdentity, groupQuery), evidence = page.value[0].agentEvidence;
    expect(evidence.noReported).toBe(0);
    expect(evidence.positive! + evidence.noReported! + evidence.unknown!).toBe(22);
    expect(page.value[0].coverage.unresolvedReportIdentities).toBeGreaterThan(0);
  });
  it("frozen affiliation/licensing and UPN survive changed current directory without a fresh valid Office capture", async () => {
    await seed();
    const before = await office.context(selectionIdentity, groupQuery);
    await publishFixtureEmptyActivity(f.runtime, selectionIdentity);
    const people = departmentEvidencePeople();
    people[0].identity.userPrincipalName = "renamed@example.invalid";
    people[0].identity.department = "Moved"; people[0].servicePlans = []; people[0].copilotServiceState = "unknown";
    await publishFixtureDirectory(f.runtime, selectionIdentity, people);
    const page = await reads.page(selectionIdentity, { ...groupQuery, officeSelectionId: before.selection.id });
    expect(page.value[0].denominators).toEqual({ officePaid: 22, officeActive: 22, currentDirectory: 21, currentAgentPaid: 21 });
    expect(page.value[0].agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
    expect(page.context.office.observation!.id).toBe(before.observation!.id);
  });
  it("missing reports and unknown Office app evidence remain separate from measured zero", async () => {
    await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity);
    const page = await reads.page(selectionIdentity, {});
    const group = page.value.find(row => row.company === departmentEvidence.company && row.department === departmentEvidence.department)!;
    expect(group.agentEvidence).toEqual({ positive: 0, noReported: 0, unknown: 22 });
    const unknown = page.value.find(row => row.department === "Unknown Office")!;
    expect(unknown.office).toMatchObject({ savedLicensedPeople: 1, reportedActiveUsers: 0, unknownEvidencePeople: 1, noRecentEvidencePeople: 1 });
    expect(unknown.agentEvidence).toEqual({ positive: 0, noReported: 0, unknown: 0 });
  });
  it("ranks and sums all fourteen exact groups before returning ten, then continues without changing contexts", async () => {
    const people = departmentEvidencePeople();
    for (let index = 25; index <= 35; index++) {
      const person = officeFixturePerson(index);
      person.identity.companyName = `Company ${index}`;
      people.push(person);
    }
    await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity, people);
    await publishDepartmentEvidenceReports(f.runtime, selectionIdentity);
    const first = await reads.page(selectionIdentity, {});
    expect(first.counts).toEqual({ total: 14, filtered: 14 });
    expect(first.value).toHaveLength(10);
    expect(first.value[0]).toMatchObject({ company: "Example", department: "Office", rank: 1 });
    expect(first.summary).toEqual({ officeActive: 34, positive: 7, noReported: 27, unknown: 0 });
    expect(first.value.every(row => !Object.hasOwn(row, "people") && !Object.hasOwn(row, "agents"))).toBe(true);
    const second = await reads.page(selectionIdentity, first.value[0].drilldowns.audience.query, { cursor: first.page.nextCursor! });
    expect(second.value).toHaveLength(4);
    expect(second.value.map(row => row.rank)).toEqual([11, 12, 13, 14]);
    expect(second.summary).toEqual(first.summary);
    expect(second.page.nextCursor).toBeNull();
    expect(second.context.office.selection.id).toBe(first.context.office.selection.id);
    expect(second.context.report.selection.id).toBe(first.context.report.selection.id);
  });
  it("preserves legitimate null exact groups, unavailable Office, and usable aggregate-only weekly history", async () => {
    const absent = await reads.page(selectionIdentity, { company: null, department: null });
    expect(absent.value).toEqual([]);
    expect(absent.summary).toEqual({ officeActive: null, positive: null, noReported: null, unknown: null });
    const people = departmentEvidencePeople();
    people[22].identity.companyName = null; people[22].identity.department = null;
    await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity, people);
    await publishDepartmentEvidenceReports(f.runtime, selectionIdentity);
    const nullGroup = await reads.page(selectionIdentity, { company: null, department: null });
    expect(nullGroup.value).toHaveLength(1);
    expect(nullGroup.value[0]).toMatchObject({ company: null, department: null, denominators: { officePaid: 1, officeActive: 1 } });
    const weekly = (await office.history(selectionIdentity, {})).value[0].observation;
    const page = await reads.page(selectionIdentity, { ...groupQuery, officeSnapshot: weekly.id });
    expect(page.value[0].office.reportedActiveUsers).toBe(22);
    expect(page.value[0].agentEvidence).toEqual({ positive: null, noReported: null, unknown: null });
    expect(page.summary.officeActive).toBe(22);
    await expect(reads.people(selectionIdentity, page.value[0].drilldowns.audience.query, page.value[0].id, "no_reported"))
      .rejects.toMatchObject({ code: "office_history_aggregate_only" });
  });
  it("measures twenty warmed scalar reads over 10000 frozen people and 500 groups without returning inventories", async () => {
    const people = Array.from({ length: 10000 }, (_, index) => {
      const person = officeFixturePerson(index + 1);
      person.identity.companyName = `Company ${index % 500}`;
      return person;
    });
    await publishDepartmentEvidenceOffice(f.runtime, selectionIdentity, people);
    await publishDepartmentEvidenceReports(f.runtime, selectionIdentity);
    const first = await reads.page(selectionIdentity, {});
    expect(first.counts).toEqual({ total: 500, filtered: 500 });
    expect(first.value).toHaveLength(10);
    expect(first.summary).toEqual({ officeActive: 9999, positive: 7, noReported: 9992, unknown: 0 });
    const samples: number[] = [];
    let bytes = 0;
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      const page = await reads.page(selectionIdentity, first.value[0].drilldowns.audience.query);
      samples.push(performance.now() - started);
      bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(page)));
      expect(page.counts).toEqual(first.counts);
      expect(page.value).toHaveLength(10);
      expect(page.summary).toEqual(first.summary);
      expect(page.value.every(row => !Object.hasOwn(row, "people") && !Object.hasOwn(row, "agents"))).toBe(true);
    }
    const p95Ms = samples.slice().sort((left, right) => left - right)[18];
    console.info(JSON.stringify({ event: "department_evidence_capacity", people: people.length, groups: 500,
      requests: samples.length, p95Ms, maximumAggregateBytes: bytes }));
    expect(p95Ms).toBeLessThanOrEqual(2000);
    expect(bytes).toBeLessThanOrEqual(131072);
  }, 60000);
  it("optional all-inventory selections support stable continuations without making report reads depend on inventory", async () => {
    await seed();
    await saveUsageInventory(f.runtime, selectionIdentity, [
      { packages: ["Report-1"], native: { nativeId: "fixture-created-champion", environmentId: null, createdBy: officeFixturePerson(1).identity.objectId! } },
      { packages: ["Report-2"] },
    ]);
    const page = await reads.page(selectionIdentity, groupQuery), group = page.value[0];
    expect(page.context.inventoryState).toBe("available");
    expect(group.drilldowns.peers).toMatchObject({ path: "/api/copilot-usage/adoption/champions", requiresExactGroupCapture: false });
    const first = await reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported", { limit: 6 });
    const next = await reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported", { limit: 6, cursor: first.page.nextCursor! });
    expect(first.value[0].person.identity).not.toBe(next.value[0].person.identity);
    const pins = (await f.operator.query("SELECT root_kind FROM data_generation_pins WHERE selection_id=$1", [page.context.report.selection.id])).rows;
    expect(pins.some(pin => pin.root_kind === "inventory_delta")).toBe(false);
    const champions = await new SavedReadContracts(reports, reads.inventory).champions(page.context.report.selection.id,
      selectionIdentity, page.context.inventory!.id, { limit: 50 });
    expect(champions.champions).toHaveLength(3);
    expect(champions.value.filter(row => row.relationship === "used").map(row => row.reportAgentId).sort())
      .toEqual(departmentEvidence.agents);
    expect(champions.value.some(row => row.relationship === "created")).toBe(true);
    expect(champions.value.some(row => row.identityState === "report_only" && row.reportAgentId === "Report-3")).toBe(true);
  });
  it("selects overlapping report sets independently and never sums the same audience twice", async () => {
    const first = await seed();
    const overlapping = await publishDepartmentEvidenceReports(f.runtime, selectionIdentity,
      { extraUsers: ["unknown-overlap@example.invalid,Unknown,0,0,"] });
    expect(overlapping.setId).not.toBe(first.setId);
    const selected = await reads.page(selectionIdentity, { ...groupQuery, setId: first.setId });
    const latest = await reads.page(selectionIdentity, groupQuery);
    expect(selected.value[0].agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
    expect(latest.value[0].agentEvidence).toEqual({ positive: 7, noReported: 0, unknown: 15 });
    expect(selected.context.report.reports.setId).toBe(first.setId);
    expect(latest.context.report.reports.setId).toBe(overlapping.setId);
    expect(selected.value[0].denominators).toEqual(latest.value[0].denominators);
  });
  it("expired optional inventory cannot erase independent frozen Office/report facts", async () => {
    await seed();
    const expiresAt = new Date(Date.now() + 5000);
    await saveUsageInventory(f.runtime, selectionIdentity, [{ packages: ["Report-1"] }], { expiresAt });
    const before = await reads.page(selectionIdentity, groupQuery);
    expect(before.context.inventory).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 25));
    const page = await reads.page(selectionIdentity, groupQuery);
    expect(page.context.inventory).toBeNull();
    expect(page.context.office.observation!.id).toBe(before.context.office.observation!.id);
    expect(page.value[0].agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
    expect(page.value[0].denominators).toEqual({ officePaid: 22, officeActive: 22, currentDirectory: 22, currentAgentPaid: 22 });
  }, 15000);
  it.each(["principal", "tenant", "authorization", "query", "cursor"])("rejects mixed %s bindings", async kind => {
    await seed();
    const page = await reads.page(selectionIdentity, groupQuery), group = page.value[0];
    const actor = { ...selectionIdentity, ...(kind === "principal" ? { principalId: "other" } : {}),
      ...(kind === "tenant" ? { tenantId: "other" } : {}), ...(kind === "authorization" ? { authorizationHash: "other" } : {}) };
    const query: OpportunityQuery = { ...group.drilldowns.audience.query, ...(kind === "query" ? { company: null } : {}) };
    await expect(reads.people(actor, query, group.id, "no_reported", kind === "cursor" ? { cursor: "unsigned" } : {}))
      .rejects.toMatchObject({ code: kind === "query" || kind === "cursor" ? "invalid_cursor" : "selection_invalidated" });
  });
  it("report deletion/correction and Office clear invalidate continuations without silently recapturing", async () => {
    const set = await seed();
    let page = await reads.page(selectionIdentity, groupQuery), group = page.value[0];
    const corrected = await publishDepartmentEvidenceReports(f.runtime, selectionIdentity,
      { correctionOfSetId: set.setId, extraUsers: ["unknown-correction@example.invalid,Changed,0,0,"] });
    expect(corrected.setId).not.toBe(set.setId);
    await expect(reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported"))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    page = await reads.page(selectionIdentity, groupQuery); group = page.value[0];
    await deleteUsageSet(f.runtime, selectionIdentity, page.context.report.reports.setId!);
    await expect(reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported"))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    page = await reads.page(selectionIdentity, groupQuery); group = page.value[0];
    const scope = (await f.runtime.query("SELECT scope_id FROM data_generations WHERE id=$1", [page.context.office.observation!.id])).rows[0].scope_id;
    await new DataGenerations(f.runtime).invalidate(scope, selectionIdentity.tenantId);
    await expect(reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported"))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });
  it("current-clock Office authority expires during awaited SQL and no response is released", async () => {
    await seed();
    const page = await reads.page(selectionIdentity, groupQuery), group = page.value[0];
    await f.operator.query("UPDATE data_generation_pins SET expires_at=clock_timestamp()+interval '1 second' WHERE selection_id=$1",
      [page.context.office.selection.id]);
    const original = office.contextInRead.bind(office);
    let awaited = false;
    vi.spyOn(office, "contextInRead").mockImplementation(async (...args) => {
      const result = await original(...args);
      awaited = true;
      await args[0].query("SELECT pg_sleep(1.2)");
      return result;
    });
    await expect(reads.people(selectionIdentity, group.drilldowns.audience.query, group.id, "no_reported"))
      .rejects.toMatchObject({ code: "selection_invalidated", details: { reason: "expired" } });
    expect(awaited).toBe(true);
  });
});
