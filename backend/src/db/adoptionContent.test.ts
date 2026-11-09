import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AdoptionContent } from "../services/adoptionContent.js";
import { manualDraft } from "../services/adoptionContentTestSupport.js";
import { config } from "../config.js";
import { DataGenerations } from "./dataGenerations.js";
import type { AuthenticatedUser } from "../types/session.js";
import { backupTableKeys } from "../../scripts/backupInventory.js";
import { validateBackupInventory } from "../../scripts/backup.js";
import { eraseAdoptionPrivate } from "../../scripts/database.js";
import { departmentEvidence, departmentEvidencePeople, publishDepartmentEvidenceOffice, publishDepartmentEvidenceReports } from "../../scripts/departmentEvidenceFixtures.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { deleteUsageSet } from "./agentUsageTestSupport.js";
import { retainRecordData } from "./dataRetention.js";
import { transaction } from "./pool.js";
import * as officeSemantics from "../services/officeAppAdoption.js";
import { verifyAdoptionContentSchema } from "./adoptionContentSchema.js";

describe("durable tenant adoption records and receipts", () => {
  let f: Awaited<ReturnType<typeof testDatabase>>, content: AdoptionContent;
  const actor = (id: string, roles: AuthenticatedUser["roles"] = ["AgentControl.Viewer"], tenantId = "adoption-tenant"): AuthenticatedUser =>
    ({ homeAccountId: id, localAccountId: id, tenantId, roles, username: `${id}@example.invalid`, displayName: id });
  const key = () => `${Date.now()}.${randomUUID()}`;
  beforeEach(async () => { f = await testDatabase(); content = new AdoptionContent(f.runtime); }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  it("rejects actual stored JSONB overflow as a known unsaved bound without orphan receipts or lost updates", async () => {
    const draft = manualDraft("action"), fields = Object.keys(draft.narrative) as Array<keyof typeof draft.narrative>;
    for (const field of fields.slice(0, 7)) draft.narrative[field] = '"'.repeat(2048);
    draft.narrative[fields[7]] = '"'.repeat(1500);
    draft.progress = "x".repeat(32768 - Buffer.byteLength(JSON.stringify(draft)));
    expect(draft.progress.length).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(draft))).toBe(32768);
    const a = actor("creator");
    await expect(content.create(a, key(), draft)).rejects.toMatchObject({ status: 413, code: "adoption_payload_limit" });
    expect((await f.runtime.query("SELECT * FROM adoption_content")).rowCount).toBe(0);
    expect((await f.runtime.query("SELECT * FROM adoption_content_receipts")).rowCount).toBe(0);
    const original = await content.create(a, key(), manualDraft("action"));
    await expect(content.update(a, original.id, { expectedRevision: 1, draft }))
      .rejects.toMatchObject({ status: 413, code: "adoption_payload_limit" });
    expect(await content.detail(a, original.id)).toMatchObject({ revision: 1, title: "Department activation" });
  });
  it("survives reload and shares staff reads across accounts but never tenants/roles", async () => {
    const saved = await content.create(actor("creator"), key(), manualDraft());
    expect((await new AdoptionContent(f.runtime).detail(actor("reader"), saved.id)).title).toBe("Department activation");
    expect((await content.list(actor("reader"), {})).value).toHaveLength(1);
    await expect(content.detail(actor("other", ["AgentControl.Admin"], "other-tenant"), saved.id)).rejects.toMatchObject({ status: 404 });
    await expect(content.detail(actor("reader", []), saved.id)).rejects.toMatchObject({ status: 403 });
    await expect(content.create(actor("reader", []), key(), manualDraft())).rejects.toMatchObject({ status: 403 });
    await expect(content.update(actor("reader"), saved.id, { expectedRevision: 1, draft: manualDraft() })).rejects.toMatchObject({ status: 403 });
  });
  it("resolves lost responses/idempotent races, conflicts changed payload, separates actors and never resurrects a deletion", async () => {
    const request = key(), draft = manualDraft(), a = actor("creator");
    const results = await Promise.all([content.create(a, request, draft), content.create(a, request, draft)]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter(result => result.replayed)).toHaveLength(1);
    await expect(content.create(a, request, { ...draft, title: "Changed" })).rejects.toMatchObject({ status: 409, code: "adoption_request_conflict" });
    const other = await content.create(actor("other"), request, draft);
    expect(other.id).not.toBe(results[0].id);
    await content.delete(a, results[0].id, { expectedRevision: 1, confirmation: `delete:${results[0].id}` });
    expect(await content.create(a, request, draft)).toMatchObject({ id: results[0].id, record: null, state: "deleted", replayed: true });
    await expect(content.create(a, `${Date.now() - 9 * 86400000}.${randomUUID()}`, draft)).rejects.toMatchObject({ code: "adoption_request_expired" });
    expect((await content.list(a, {})).value.map(record => record.id)).toEqual([other.id]);
  });
  it("concurrent expected revisions preserve one writer; assignee only progresses and independent linked content survives deletion", async () => {
    const creator = actor("creator"), admin = actor("admin", ["AgentControl.Admin"]);
    const parent = await content.create(creator, key(), manualDraft());
    const card = await content.create(actor("other"), key(), { ...manualDraft("card"), linkedIds: [parent.id] });
    const action = await content.create(creator, key(), { ...manualDraft("action"), linkedIds: [parent.id], assigneeId: "creator" });
    const updates = await Promise.allSettled([
      content.update(creator, action.id, { expectedRevision: 1, status: "in_progress", progress: "First" }),
      content.update(creator, action.id, { expectedRevision: 1, status: "completed", progress: "Second" }),
    ]);
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(updates.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "adoption_revision_conflict" } });
    await expect(content.delete(admin, parent.id, { expectedRevision: 1, confirmation: `delete:${card.id}` })).rejects.toMatchObject({ status: 400 });
    await content.delete(admin, parent.id, { expectedRevision: 1, confirmation: `delete:${parent.id}` });
    expect((await content.detail(actor("other"), card.id)).links).toEqual([{ id: parent.id, state: "removed" }]);
    expect((await content.detail(creator, action.id)).links).toEqual([{ id: parent.id, state: "removed" }]);
    await new DataGenerations(f.runtime).revokePrincipal(creator.tenantId!, creator.homeAccountId, { preserveSources: true });
    expect((await content.detail(actor("other"), card.id)).title).toBe("Department activation");
  });
  it("current backup inventory and storage account for records/receipts; receipt expiry is bounded", async () => {
    const a = actor("creator"), request = key();
    const saved = await content.create(a, request, manualDraft());
    expect(await validateBackupInventory(f.operator)).toContain("adoption_content");
    expect(backupTableKeys.adoption_content_receipts).toEqual(["tenant_id", "actor_id", "request_id"]);
    const before = (await f.runtime.query("SELECT * FROM adoption_content_storage WHERE tenant_id=$1", [a.tenantId])).rows[0];
    expect(Number(before.records)).toBe(2); expect(Number(before.bytes)).toBeGreaterThan(100);
    await content.delete(a, saved.id, { expectedRevision: 1, confirmation: `delete:${saved.id}` });
    const after = (await f.runtime.query("SELECT * FROM adoption_content_storage WHERE tenant_id=$1", [a.tenantId])).rows[0];
    expect(Number(after.records)).toBe(1); expect(Number(after.bytes)).toBeLessThan(Number(before.bytes));
    const receipt = (await f.runtime.query("SELECT * FROM adoption_content_receipts")).rows[0];
    expect(receipt.deleted).toBe(true); expect(receipt).not.toHaveProperty("payload");
    expect(receipt.expires_at.getTime() - Number(request.slice(0, 13))).toBe(8 * 86400000);
    expect(config.employeePrivacy).toBeDefined();
  });
  it("requires each effective current CRUD grant, not merely one privilege from a comma list", async () => {
    await f.operator.query("REVOKE UPDATE ON adoption_content_receipts FROM agentcontrol_app");
    try { await expect(verifyAdoptionContentSchema(f.runtime)).rejects.toThrow("adoption_content_schema_invalid"); }
    finally { await f.operator.query("GRANT UPDATE ON adoption_content_receipts TO agentcontrol_app"); }
    await verifyAdoptionContentSchema(f.runtime);
  });
  it("saves exact API aggregates, rebinds other callers after lease expiry, and compares changed denominators without original-person claims", async () => {
    vi.spyOn(officeSemantics, "officeExpiry").mockImplementation(() => new Date(Date.now() + 5000));
    const a = actor("baseline-author"), identity = await reportIdentity(f.runtime, a);
    await publishDepartmentEvidenceOffice(f.runtime, identity);
    const imported = await publishDepartmentEvidenceReports(f.runtime, identity);
    const scope = { company: departmentEvidence.company, department: departmentEvidence.department };
    const page = await content.opportunities.page(identity, scope);
    const group = page.value[0], baseline = { groupId: group.id, query: group.drilldowns.audience.query };
    const request = key(), draft = { ...manualDraft(), scope, baseline };
    const saved = await content.create(a, request, draft);
    expect(saved.record!.baseline!.group.agentEvidence.noReported).toBe(15);
    const raw = (await f.runtime.query("SELECT payload,baseline FROM adoption_content WHERE id=$1", [saved.id])).rows[0];
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain("selectionId"); expect(serialized).not.toContain("SelectionId");
    expect(serialized).not.toContain("person-"); expect(serialized).not.toContain("cursor");
    await f.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp() WHERE id=ANY($1::uuid[])",
      [[baseline.query.officeSelectionId, baseline.query.reportSelectionId]]);
    expect((await content.create(a, request, draft)).replayed).toBe(true);
    const reloaded = await content.detail(actor("another-staff"), saved.id);
    expect(reloaded.baseline).toEqual(saved.record!.baseline);
    expect(reloaded.evidence.state).toBe("available");
    await expect(content.create(a, key(), draft)).rejects.toMatchObject({ status: 409, code: "selection_invalidated" });
    const changed = departmentEvidencePeople();
    changed[0].servicePlans = []; changed[0].copilotServiceState = "unknown";
    await publishDepartmentEvidenceOffice(f.runtime, identity, changed);
    const follow = await content.opportunities.page(identity, scope);
    const comparison = await content.followUp(a, saved.id, { groupId: follow.value[0].id, query: follow.value[0].drilldowns.audience.query });
    expect(comparison.baseline.group.denominators.officePaid).toBe(22);
    expect(comparison.current.group.denominators.officePaid).toBe(21);
    expect(comparison.sameOriginalPeople).toBe(false);
    expect(comparison.caveats.join(" ")).toContain("drift");
    expect(comparison.caveats.join(" ")).toContain("overlap");
    expect(comparison.caveats).toContain("The selected Office D28 windows overlap and are non-additive.");
    expect(comparison.caveats).toContain("The selected report activity ranges overlap and are non-additive.");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(saved.record!.baseline!.office.expiresAt) - Date.now()) + 20));
    expect((await content.detail(a, saved.id)).evidence).toMatchObject({ state: "unavailable", reason: "exact_source_deleted_cleared_or_expired" });
    await deleteUsageSet(f.runtime, identity, imported.setId);
    const after = await content.detail(a, saved.id);
    expect(after.evidence.state).toBe("unavailable");
    expect(after.baseline).toEqual(saved.record!.baseline);
  }, 30000);
  it("actual SQL follow-up keeps missing report activity dates unknown instead of borrowing the Office D28 window", async () => {
    const a = actor("unknown-report-window"), identity = await reportIdentity(f.runtime, a);
    const scope = { company: departmentEvidence.company, department: departmentEvidence.department };
    await publishDepartmentEvidenceOffice(f.runtime, identity);
    await publishDepartmentEvidenceReports(f.runtime, identity, { reportDate: null });
    const page = await content.opportunities.page(identity, scope), group = page.value[0];
    expect(page.context.report.reports.reportingPeriod).toMatchObject({ startDate: null, endDate: null });
    const saved = await content.create(a, key(), { ...manualDraft(), scope,
      baseline: { groupId: group.id, query: group.drilldowns.audience.query } });
    const follow = await content.followUp(a, saved.id, { groupId: group.id, query: group.drilldowns.audience.query });
    expect(follow.baseline.report.reportingPeriod).toMatchObject({ startDate: null, endDate: null });
    expect(follow.current.report.reportingPeriod).toMatchObject({ startDate: null, endDate: null });
    expect(follow.caveats).toContain("The selected Office D28 windows overlap and are non-additive.");
    expect(follow.caveats).toContain("Report activity-range overlap is unavailable; do not assume the report evidence is additive.");
    expect(follow.caveats).not.toContain("The selected report activity ranges overlap and are non-additive.");
    expect(follow.sameOriginalPeople).toBe(false);
  });
  it("ordinary edits preserve exact unavailable agent sources instead of silently rebinding a newer canonical source", async () => {
    const a = actor("stale-reference-owner"), agentId = randomUUID(), generationId = randomUUID();
    const saved = await content.create(a, key(), manualDraft("card"));
    await f.operator.query("UPDATE adoption_content SET agent_references=$2 WHERE id=$1", [saved.id, JSON.stringify([{
      id: agentId, state: "available", agent: null, sources: [{ source: "graph_packages", generationId, sourceIdentity: "exact-original", revision: "1",
        observedAt: new Date().toISOString(), descriptionField: "longDescription", descriptionState: "unavailable" }],
    }])]);
    const updated = await content.update(a, saved.id, { expectedRevision: 1, draft: { ...manualDraft("card"), title: "Edited narrative",
      agentIds: [agentId] } });
    expect(updated.agents).toHaveLength(1);
    expect(updated.agents[0]).toMatchObject({ id: agentId, state: "unavailable", agent: null,
      sources: [{ generationId, sourceIdentity: "exact-original", revision: "1" }] });
    expect(updated.title).toBe("Edited narrative");
  });
  it("corrected exact reports remain superseded instead of silently using a replacement", async () => {
    const a = actor("correction-author"), identity = await reportIdentity(f.runtime, a);
    await publishDepartmentEvidenceOffice(f.runtime, identity);
    const imported = await publishDepartmentEvidenceReports(f.runtime, identity);
    const scope = { company: departmentEvidence.company, department: departmentEvidence.department };
    const page = await content.opportunities.page(identity, scope), group = page.value[0];
    const saved = await content.create(a, key(), { ...manualDraft(), scope, baseline: { groupId: group.id, query: group.drilldowns.audience.query } });
    await publishDepartmentEvidenceReports(f.runtime, identity, { correctionOfSetId: imported.setId, extraUsers: ["changed@example.invalid,Correction,1,1,"] });
    expect((await content.detail(a, saved.id)).evidence).toMatchObject({ state: "superseded", freshQuery: null });
  }, 30000);
  it("real principal privacy erasure removes private payload/assignment/receipts, preserves revocation and prevents replay; sign-out alone does not erase", async () => {
    const a = actor("private-author"), request = `${Date.now() + 30_000}.${randomUUID()}`,
      saved = await content.create(a, request, manualDraft());
    const independent = await content.create(actor("other"), key(), { ...manualDraft("action"), linkedIds: [saved.id],
      assigneeId: a.homeAccountId, progress: "Private author progress" });
    await new DataGenerations(f.runtime).revokePrincipal(a.tenantId!, a.homeAccountId, { preserveSources: true });
    expect((await content.detail(actor("other"), saved.id)).title).toBe("Department activation");
    await expect(eraseAdoptionPrivate(f.operator, a.tenantId!, a.homeAccountId, "wrong")).rejects.toThrow();
    const erased = await eraseAdoptionPrivate(f.operator, a.tenantId!, a.homeAccountId,
      `${f.operator.options.database}/${a.tenantId}/${a.homeAccountId}`);
    expect(erased).toEqual({ removedRecords: 1, removedReceipts: 1 });
    await expect(content.detail(actor("other"), saved.id)).rejects.toMatchObject({ status: 404 });
    expect((await content.detail(actor("other"), independent.id))).toMatchObject({ assigneeId: null, progress: "" });
    expect((await f.runtime.query("SELECT * FROM adoption_content_receipts WHERE actor_id=$1", [a.homeAccountId])).rows).toHaveLength(0);
    expect(Number((await f.runtime.query("SELECT bearer_issued_after FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2",
      [a.tenantId, a.homeAccountId])).rows[0].bearer_issued_after)).toBeGreaterThan(0);
    const fence = (await f.runtime.query<{ bearer: string; request: string }>(`SELECT bearer_issued_after::text AS bearer,
      adoption_request_cutoff::text AS request FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2`,
    [a.tenantId, a.homeAccountId])).rows[0];
    expect(Number(fence.request)).toBe(Number(request.slice(0, 13)));
    expect(Number(fence.bearer)).toBeLessThan(Number(fence.request));
    await expect(content.create(a, request, manualDraft())).rejects.toMatchObject({ code: "adoption_request_revoked" });
  });
  it("existing lifecycle slice removes expired receipts within its batch rather than retaining unlimited tombstones", async () => {
    const a = actor("retention-author"), saved = await content.create(a, key(), manualDraft());
    await content.delete(a, saved.id, { expectedRevision: 1, confirmation: `delete:${saved.id}` });
    await f.operator.query("UPDATE adoption_content_receipts SET expires_at=clock_timestamp()");
    const affected = await transaction(f.runtime, client => retainRecordData(client, 1));
    expect(affected.adoptionReceipts).toBe(1);
    expect((await f.runtime.query("SELECT * FROM adoption_content_receipts")).rowCount).toBe(0);
  });
  it("the count cap reserves both the content and retry receipt without crossing 20,000 rows", async () => {
    const a = actor("capacity-author"), draft = manualDraft();
    await f.operator.query(`INSERT INTO adoption_content(id,tenant_id,creator_id,kind,payload,agent_references,linked_references)
      SELECT gen_random_uuid(),$1,$2,'brief',$3,'[]','[]' FROM generate_series(1,19999)`,
    [a.tenantId, a.homeAccountId, JSON.stringify(draft)]);
    await expect(content.create(a, key(), draft)).rejects.toMatchObject({ status: 413, code: "adoption_storage_limit" });
    expect((await f.runtime.query("SELECT records::int AS records FROM adoption_content_storage WHERE tenant_id=$1", [a.tenantId])).rows[0].records).toBe(19999);
    expect((await f.runtime.query("SELECT * FROM adoption_content_receipts")).rowCount).toBe(0);
  }, 30000);
});
