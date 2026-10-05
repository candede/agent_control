import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it,vi } from "vitest";
import { retainUntilConverged } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import type { OfficialUsageMetadata } from "../types/officialReportRecords.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { OfficialReportImports } from "./officialReportImports.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let imports: OfficialReportImports;
let reports: LargeTenantUsersReports;
const kinds = ["agents", "userAgents", "users"] as const;
type Kind = typeof kinds[number];
const metadata: OfficialUsageMetadata = {
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
  sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
};
beforeAll(async () => {
  fixture = await testDatabase(); imports = new OfficialReportImports(fixture.runtime);
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-native-import-semantics-secret", 35);
}, 30_000);
afterAll(async () => { await fixture?.close(); });
const owner = (): SelectionIdentity => ({ ...selectionIdentity, tenantId: `native-imports-${randomUUID()}` });
function csv(kind: Kind, responses = 4) {
  const row = kind === "agents" ? `agent-1,Agent 1,Your org,1,1,${responses},2026-07-06`
    : kind === "userAgents" ? `agent-1,Agent 1,Your org,User@example.invalid,${responses},2026-07-06`
      : `User@example.invalid,User,1,${responses},2026-07-06`;
  return `${schemaRegistry[kind].headers.join(",")}\n${row}\n`;
}
async function stage(identity: SelectionIdentity, bundleId: string, kind: Kind, options: {
  responses?: number; correctionOfSetId?: string; rejectDuplicateKind?: boolean;
  reportMetadata?: OfficialUsageMetadata; reformatted?: boolean;
} = {}) {
  async function* chunks() { yield Buffer.from(options.reformatted ? csv(kind, options.responses).replaceAll("\n", "\r\n") : csv(kind, options.responses)); }
  return imports.stage(identity, { bundleId, correctionOfSetId: options.correctionOfSetId, rejectDuplicateKind: options.rejectDuplicateKind },
    chunks(), options.reportMetadata ?? metadata);
}
async function bundle(identity: SelectionIdentity, options: Parameters<typeof stage>[3] = {}) {
  const bundleId = randomUUID(), stages = [];
  for (const kind of kinds) stages.push(await stage(identity, bundleId, kind, options));
  const preview = await imports.bundle(identity, bundleId);
  return { bundleId, stages, preview, accept: () => imports.acceptBundle(identity, bundleId, preview) };
}
const single = (identity: SelectionIdentity, preview: Awaited<ReturnType<typeof stage>>) =>
  imports.accept(identity, { stagingId: preview.id, revision: preview.revision, contentHash: preview.contentHash, expectedActiveRevision: preview.activeRevision });
async function operation(identity: SelectionIdentity, setId: string, action: "select" | "delete") {
  return imports.confirm(identity, await imports.confirmPreview(identity, setId, action));
}
async function agents(identity: SelectionIdentity, setId?: string) {
  return reports.page((await reports.capture(identity, "delegated", "official_agents", setId ? { setId } : {})).id, identity);
}
async function counts(identity: SelectionIdentity) {
  return (await fixture.runtime.query(`SELECT
    (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
    (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
    (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts,
    (SELECT count(*)::int FROM official_usage_version_rows WHERE tenant_id=$1) AS rows,
    (SELECT count(*)::int FROM official_usage_set_versions WHERE tenant_id=$1) AS memberships`, [identity.tenantId])).rows[0];
}
async function expireSyntheticUploads(identity: SelectionIdentity) {
  const client = await fixture.operator.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE official_usage_ingestions DISABLE TRIGGER official_upload_intent_guard");
    await client.query(`UPDATE official_usage_ingestions SET expires_at=clock_timestamp()-interval '2 days' WHERE tenant_id=$1`, [identity.tenantId]);
    await client.query(`UPDATE official_usage_staging SET created_at=clock_timestamp()-interval '2 days',
      expires_at=clock_timestamp()-interval '2 days' WHERE tenant_id=$1`, [identity.tenantId]);
    await client.query("ALTER TABLE official_usage_ingestions ENABLE TRIGGER official_upload_intent_guard");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function releaseSelections(identity: SelectionIdentity) {
  const rows = await fixture.runtime.query("SELECT id FROM data_read_selections WHERE tenant_id=$1 ORDER BY id LIMIT 250", [identity.tenantId]);
  for (const row of rows.rows) await reports.selections.invalidate(row.id, identity);
}

describe("native automatic import and semantic reuse", () => {
  it("returns the durable acceptance after cleanup fails and resumes its indexed bounded deletion",async () => {
    const identity = owner(), prepared = await bundle(identity);
    const cleanup = vi.spyOn(imports,"cleanupIngestion").mockRejectedValue(new Error("synthetic_cleanup_unavailable"));
    let accepted;
    try {
      accepted = await prepared.accept();
      expect((await prepared.accept()).setId).toBe(accepted.setId);
      expect((await agents(identity)).reports.setId).toBe(accepted.setId);
      expect(cleanup).toHaveBeenCalled();
    } finally { cleanup.mockRestore(); }
    const pending = (await fixture.runtime.query("SELECT id FROM official_usage_ingestions WHERE tenant_id=$1 AND state='accepted'",[identity.tenantId])).rows;
    expect(pending).toHaveLength(3);
    for (const row of pending) await imports.cleanupIngestion(row.id);
    expect((await fixture.runtime.query("SELECT coalesce(sum(stored_bytes),0)::text AS bytes FROM official_usage_ingestions WHERE tenant_id=$1",[identity.tenantId])).rows[0].bytes).toBe("0");
    expect((await agents(identity)).reports.setId).toBe(accepted!.setId);
  });
  it("rejects incomplete fact writes atomically without replacing the previous publication",async () => {
    const identity = owner(), published = await (await bundle(identity)).accept();
    const preview = await stage(identity,randomUUID(),"agents",{ responses: 9 });
    const before = await counts(identity);
    await expect(fixture.operator.query(`INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at)
      SELECT r.tenant_id,i.kind,r.payload_hash,r.row_data,clock_timestamp()
      FROM official_usage_ingestions i JOIN official_usage_ingestion_rows r ON r.ingestion_id=i.id
      WHERE i.tenant_id=$1 AND i.staging_id=$2`,[identity.tenantId,preview.id]))
      .rejects.toMatchObject({ code: "23514", constraint: "official_usage_typed_fact" });
    expect((await agents(identity)).reports.setId).toBe(published.setId);
    expect(await counts(identity)).toEqual(before);
  });
  it("rejects staged bytes beyond the 2 GiB tenant reservation without replacing published reports", async () => {
    const identity = owner(), published = await (await bundle(identity)).accept();
    const reservations = [
      { ...identity, principalId: "reserved-first" },
      { ...identity, principalId: "reserved-second" },
    ];
    for (const actor of reservations) {
      await stage(actor, randomUUID(), "users");
      await fixture.operator.query(`UPDATE official_usage_ingestions SET stored_bytes=$3
        WHERE tenant_id=$1 AND principal_id=$2`, [actor.tenantId, actor.principalId, 1024 ** 3]);
    }
    expect((await fixture.runtime.query(`SELECT sum(stored_bytes)::text AS bytes
      FROM official_usage_ingestions WHERE tenant_id=$1`, [identity.tenantId])).rows[0].bytes).toBe(String(2 * 1024 ** 3));
    await expect(stage(identity, randomUUID(), "agents", { responses: 9 })).rejects.toMatchObject({
      status: 413, code: "staging_limit_exceeded", message: `tenant staged bytes exceed ${2 * 1024 ** 3}.`,
    });
    expect((await agents(identity)).reports.setId).toBe(published.setId);
    expect((await fixture.runtime.query(`SELECT sum(stored_bytes)::text AS bytes
      FROM official_usage_ingestions WHERE tenant_id=$1`, [identity.tenantId])).rows[0].bytes).toBe(String(2 * 1024 ** 3));
    expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM official_usage_ingestions
      WHERE tenant_id=$1 AND state IN ('streaming','validating','accepting')`, [identity.tenantId])).rows[0].count).toBe(0);
    expect(await stage(owner(), randomUUID(), "agents")).toMatchObject({ kind: "agents" });
  });

  it.each([false, true])("appends changed independent snapshots without superseding them (advanced source=%s)", async advanced => {
    const identity = owner(), original = await (await bundle(identity)).accept(), originalPage = await agents(identity), bundleId = randomUUID();
    for (const kind of kinds) await stage(identity, bundleId, kind, {
      responses: kind === "agents" ? 7 : 4,
      reportMetadata: advanced ? { ...metadata, sourceAsOf: { value: "2026-07-09T12:00:00Z", provenance: "operator_asserted" } } : metadata,
    });
    const preview = await imports.bundle(identity, bundleId), accepted = await imports.acceptBundle(identity, bundleId, preview);
    expect(accepted).toMatchObject({ complete: true, activeRevision: String(BigInt(original.activeRevision) + 1n) });
    expect(accepted.setId).not.toBe(original.setId);
    expect((await agents(identity, original.setId)).value).toEqual(originalPage.value);
    expect((await fixture.runtime.query("SELECT supersedes_set_id FROM official_usage_sets WHERE id=$1", [accepted.setId])).rows)
      .toEqual([{ supersedes_set_id: null }]);
    expect(await counts(identity)).toEqual({ sets: 2, versions: advanced ? 6 : 4, facts: 4, rows: advanced ? 6 : 4, memberships: 6 });
    expect(await imports.acceptBundle(identity, bundleId, preview)).toEqual(accepted);
  });

  it("finds semantic duplicates beyond the first history page without changing the head, time or receipt", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), originalPage = await agents(identity);
    const active = await (await bundle(identity, { responses: 7 })).accept();
    await fixture.operator.query(`INSERT INTO official_usage_sets(id,tenant_id,bundle_id,actor_principal_id,period_provenance)
      SELECT gen_random_uuid(),$1,gen_random_uuid(),$2,'activity_range' FROM generate_series(1,100)`, [identity.tenantId, identity.principalId]);
    const before = await counts(identity), duplicate = await bundle({ ...identity, principalId: "second-administrator" }, {
      reformatted: true, reportMetadata: { ...metadata, downloadedAt: "2026-07-10T12:00:00Z" },
    }), accepted = await duplicate.accept();
    expect(accepted).toEqual({ setId: original.setId, complete: true, activeRevision: active.activeRevision });
    expect((await agents(identity)).reports.setId).toBe(active.setId);
    const historic = await agents(identity, original.setId);
    expect(historic.value).toEqual(originalPage.value); expect(historic.reports.acceptedAt).toBe(originalPage.reports.acceptedAt);
    expect(await counts(identity)).toEqual(before);
    await expireSyntheticUploads(identity); await retainUntilConverged(fixture.operator, { batchSize: 250 });
    expect(await duplicate.accept()).toEqual(accepted);
    await operation(identity, original.setId, "delete");
    await expect(duplicate.accept()).rejects.toMatchObject({ code: "deleted_report_duplicate" });
  });

  it("keeps a partial acceptance receipt immutable when its completed bundle reuses a canonical duplicate", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), duplicate = await bundle(identity);
    const partial = await single(identity, duplicate.stages[0]);
    expect(partial).toMatchObject({ complete: false, activeRevision: original.activeRevision });
    expect(partial.setId).not.toBe(original.setId);
    const receiptBefore = (await fixture.runtime.query(`SELECT accepted_set_id,accepted_version_id,accepted_result_revision
      FROM official_usage_staging WHERE id=$1`, [duplicate.stages[0].id])).rows;
    const preview = await imports.bundle(identity, duplicate.bundleId);
    const accepted = await imports.acceptBundle(identity, duplicate.bundleId, preview);
    expect(accepted).toEqual(original);
    expect(await imports.acceptBundle(identity, duplicate.bundleId, preview)).toEqual(accepted);
    expect(await single(identity, duplicate.stages[0])).toEqual(partial);
    expect((await fixture.runtime.query(`SELECT accepted_set_id,accepted_version_id,accepted_result_revision
      FROM official_usage_staging WHERE id=$1`, [duplicate.stages[0].id])).rows).toEqual(receiptBefore);
    const selected = await reports.capture(identity, "delegated", "history");
    expect((await reports.page(selected.id, identity)).counts.total).toBe(1);
    expect((await agents(identity)).reports.setId).toBe(original.setId);
    await releaseSelections(identity); await retainUntilConverged(fixture.operator, { batchSize: 250 });
    expect(await single(identity, duplicate.stages[0])).toEqual(partial);
    await operation(identity, original.setId, "delete");
    await expect(single(identity, duplicate.stages[0])).rejects.toMatchObject({ status: 409 });
  });

  it.each([false, true])("reimports deleted bytes as a new set without reviving old receipts (purged=%s)", async purged => {
    const identity = owner(), original = await bundle(identity), removed = await original.accept(), originalPage = await agents(identity);
    const deletion = await operation(identity, removed.setId, "delete");
    if (purged) {
      await expireSyntheticUploads(identity); await releaseSelections(identity);
      await fixture.operator.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1", [identity.tenantId]);
      await fixture.operator.query("UPDATE official_usage_versions SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1", [identity.tenantId]);
      await retainUntilConverged(fixture.operator, { batchSize: 250 });
    }
    await expect(original.accept()).rejects.toMatchObject({ code: purged ? "bundle_fence_mismatch" : "deleted_report_duplicate" });
    const reimported = await bundle({ ...identity, principalId: "reimport-administrator" }, { reformatted: purged });
    const [accepted, retried] = await Promise.all([reimported.accept(), reimported.accept()]);
    expect(retried).toEqual(accepted);
    expect(accepted).toMatchObject({ complete: true, activeRevision: String(BigInt(deletion.activeRevision) + 1n) });
    expect(accepted.setId).not.toBe(removed.setId);
    const current = await agents(identity);
    expect(current.value).toEqual(originalPage.value); expect(current.reports.acceptedAt).not.toBe(originalPage.reports.acceptedAt);
    expect(current.reports.setId).toBe(accepted.setId);
    expect((await fixture.runtime.query("SELECT bundle_id,deleted_at FROM official_usage_sets WHERE id=$1", [removed.setId])).rows)
      .toEqual(purged ? [] : [{ bundle_id: original.bundleId, deleted_at: expect.any(Date) }]);
    await expect(agents(identity, removed.setId)).rejects.toMatchObject({ status: 409 });
    await releaseSelections(identity); await retainUntilConverged(fixture.operator, { batchSize: 250 });
    const expected = { sets: purged ? 1 : 2, versions: purged ? 3 : 6, facts: 3, rows: 3, memberships: purged ? 3 : 6 };
    expect(await counts(identity)).toEqual(expected);
    expect(await (await bundle(identity)).accept()).toEqual(accepted);
    expect(await counts(identity)).toEqual(expected);
    await expect(original.accept()).rejects.toMatchObject({ code: purged ? "bundle_fence_mismatch" : "deleted_report_duplicate" });
  });

  it("reimports historical content without changing sets that share its versions", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), bundleId = randomUUID();
    for (const kind of kinds) await stage(identity, bundleId, kind, { responses: kind === "agents" ? 7 : 4 });
    const other = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId)), otherPage = await agents(identity);
    await operation(identity, original.setId, "delete");
    expect((await agents(identity)).reports.setId).toBe(other.setId);
    const accepted = await (await bundle(identity)).accept();
    expect([original.setId, other.setId]).not.toContain(accepted.setId);
    expect((await agents(identity, other.setId)).value).toEqual(otherPage.value);
    expect((await agents(identity)).reports.setId).toBe(accepted.setId);
    await releaseSelections(identity); await retainUntilConverged(fixture.operator, { batchSize: 250 });
    expect(await counts(identity)).toEqual({ sets: 3, versions: 5, facts: 4, rows: 4, memberships: 9 });
  });

  it("fences different simultaneous reuploads and deduplicates a fresh retry", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept();
    await operation(identity, original.setId, "delete");
    const drafts = [await bundle(identity), await bundle(identity)];
    const results = await Promise.allSettled(drafts.map(draft => draft.accept()));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const accepted = results.find(result => result.status === "fulfilled");
    if (!accepted || accepted.status !== "fulfilled") throw new Error("Expected one native publication.");
    const rejected = results.findIndex(result => result.status === "rejected");
    expect(results[rejected]).toMatchObject({ reason: { code: "active_revision_mismatch" } });
    for (const preview of drafts[rejected].stages) await imports.discard(identity, preview.id);
    expect(await (await bundle(identity)).accept()).toEqual(accepted.value);
    const selected = await reports.capture(identity, "delegated", "history");
    expect((await reports.page(selected.id, identity)).counts.total).toBe(1);
  });

  it.each([false, true])("reuses version content while preserving a new correction's lineage (partial=%s)", async partial => {
    const identity = owner(), original = await (await bundle(identity)).accept(), unrelated = await (await bundle(identity, { responses: 7 })).accept();
    const unrelatedPage = await agents(identity), selected = await operation(identity, original.setId, "select");
    const correction = await bundle(identity, { responses: 7, correctionOfSetId: original.setId });
    if (partial) expect(await single(identity, correction.stages[0])).toMatchObject({ complete: false, activeRevision: selected.activeRevision });
    const preview = await imports.bundle(identity, correction.bundleId);
    const accepted = await imports.acceptBundle(identity, correction.bundleId, preview);
    expect(accepted.activeRevision).toBe(String(BigInt(selected.activeRevision) + 1n));
    expect([original.setId, unrelated.setId]).not.toContain(accepted.setId);
    expect((await agents(identity)).value).toEqual(unrelatedPage.value);
    expect((await fixture.runtime.query("SELECT supersedes_set_id FROM official_usage_sets WHERE id=$1", [accepted.setId])).rows)
      .toEqual([{ supersedes_set_id: original.setId }]);
    expect(await counts(identity)).toEqual({ sets: 3, versions: 6, facts: 6, rows: 6, memberships: 9 });
    expect(await imports.acceptBundle(identity, correction.bundleId, preview)).toEqual(accepted);
    expect(await (await bundle(identity, { responses: 7, correctionOfSetId: original.setId })).accept()).toEqual(accepted);
    await operation(identity, unrelated.setId, "delete");
    expect((await agents(identity)).value).toEqual(unrelatedPage.value);
  });

  it("makes an unchanged correction to an inactive target an idempotent result", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), active = await (await bundle(identity, { responses: 7 })).accept();
    const before = await counts(identity), current = await agents(identity);
    const correction = await bundle(identity, { correctionOfSetId: original.setId });
    expect(await correction.accept()).toEqual({ setId: original.setId, activeRevision: active.activeRevision, complete: true });
    expect((await agents(identity)).reports).toEqual(current.reports);
    expect(await counts(identity)).toEqual(before);
  });

  it.each(["dates", "provenance"] as const)("checks correction %s before any unrelated content-reuse shortcut", async mismatch => {
    const identity = owner(), original = await (await bundle(identity, { reportMetadata: { ...metadata,
      reportingPeriod: mismatch === "dates" ? { startDate: "2026-06-06", endDate: "2026-07-05", provenance: "operator_asserted" } : undefined } })).accept();
    await (await bundle(identity, { responses: 7 })).accept();
    const correction = await bundle(identity, { responses: 7, correctionOfSetId: original.setId }), before = await counts(identity);
    await expect(correction.accept()).rejects.toMatchObject({ code: "invalid_correction" });
    expect(await counts(identity)).toEqual(before);
    expect(await imports.bundle(identity, correction.bundleId)).toEqual(correction.preview);
    await expect(single(identity, correction.stages[0])).rejects.toMatchObject({ code: "invalid_correction" });
  });

  it("permits deleted content in a new correction but never an unavailable correction target", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), removed = await (await bundle(identity, { responses: 7 })).accept();
    await operation(identity, removed.setId, "delete"); await operation(identity, original.setId, "select");
    const correction = await (await bundle(identity, { responses: 7, correctionOfSetId: original.setId })).accept();
    expect([removed.setId, original.setId]).not.toContain(correction.setId);
    expect((await agents(identity)).reports.setId).toBe(correction.setId);
    await operation(identity, original.setId, "delete");
    await expect(bundle(identity, { correctionOfSetId: original.setId })).rejects.toMatchObject({ code: "invalid_correction" });
  });

  it("revalidates a deleted correction target before reuse for both individual and bundle acceptance", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept();
    await (await bundle(identity, { responses: 7 })).accept();
    const correction = await bundle(identity, { responses: 7, correctionOfSetId: original.setId });
    await fixture.operator.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp() WHERE id=$1", [original.setId]);
    const before = await counts(identity);
    await expect(correction.accept()).rejects.toMatchObject({ code: "invalid_correction" });
    await expect(single(identity, correction.stages[0])).rejects.toMatchObject({ code: "invalid_correction" });
    expect(await counts(identity)).toEqual(before);
    expect((await imports.preview(identity, correction.stages[0].id)).contentHash).toBe(correction.stages[0].contentHash);
  });

  it("revalidates a non-active correction target after bounded copying and before publication", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), active = await (await bundle(identity, { responses: 7 })).accept();
    const correction = await bundle(identity, { responses: 9, correctionOfSetId: original.setId });
    await fixture.operator.query(`CREATE FUNCTION phase02b_delete_correction_target() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id='${identity.tenantId}' THEN
        UPDATE official_usage_sets SET deleted_at=clock_timestamp() WHERE id='${original.setId}' AND deleted_at IS NULL;
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER phase02b_delete_correction_target AFTER INSERT ON official_usage_version_rows
        FOR EACH ROW EXECUTE FUNCTION phase02b_delete_correction_target()`);
    try {
      await expect(correction.accept()).rejects.toMatchObject({ code: "invalid_correction" });
      expect((await agents(identity)).reports.setId).toBe(active.setId);
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM official_usage_sets
        WHERE tenant_id=$1 AND supersedes_set_id=$2 AND complete`, [identity.tenantId, original.setId])).rows).toEqual([{ n: 0 }]);
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM official_usage_bundle_receipts
        WHERE tenant_id=$1 AND bundle_id=$2`, [identity.tenantId, correction.bundleId])).rows).toEqual([{ n: 0 }]);
    } finally {
      await fixture.operator.query("DROP TRIGGER phase02b_delete_correction_target ON official_usage_version_rows; DROP FUNCTION phase02b_delete_correction_target()");
    }
  });

  it("rejects guarded duplicate uploads without changing prior rows, review or published authority", async () => {
    const identity = owner(), bundleId = randomUUID(), original = await stage(identity, bundleId, "agents", { rejectDuplicateKind: true });
    const before = await imports.bundle(identity, bundleId), persisted = await counts(identity);
    await expect(stage(identity, bundleId, "agents", { responses: 7, rejectDuplicateKind: true })).rejects.toMatchObject({ status: 409, code: "duplicate_report_kind" });
    expect(await imports.bundle(identity, bundleId)).toEqual(before); expect(await counts(identity)).toEqual(persisted);
    expect((await imports.preview(identity, original.id)).contentHash).toBe(original.contentHash);
    expect((await fixture.runtime.query("SELECT row_data FROM official_usage_staged_rows WHERE staging_id=$1 ORDER BY ordinal LIMIT 2", [original.id])).rows)
      .toMatchObject([{ row_data: { responsesSentToUsers: 4 } }]);
    await imports.discard(identity, original.id);
    expect(await stage(identity, bundleId, "agents", { responses: 7, rejectDuplicateKind: true })).toMatchObject({ kind: "agents" });
  });

  it("serializes guarded uploads while preserving explicit default replacement and expiry recovery", async () => {
    const identity = owner(), bundleId = randomUUID();
    const results = await Promise.allSettled([4, 7].map(responses => stage(identity, bundleId, "agents", { responses, rejectDuplicateKind: true })));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "duplicate_report_kind" } });
    const original = (await imports.bundle(identity, bundleId)).stages[0], replacement = await stage(identity, bundleId, "agents", { responses: 9 });
    await expect(imports.preview(identity, original.stagingId)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect((await fixture.runtime.query("SELECT ordinal FROM official_usage_staged_rows WHERE staging_id=$1 LIMIT 2", [original.stagingId])).rows).toEqual([]);
    expect((await imports.bundle(identity, bundleId)).stages.map(stage => stage.stagingId)).toEqual([replacement.id]);
    await expireSyntheticUploads(identity);
    expect(await stage(identity, bundleId, "agents", { rejectDuplicateKind: true })).toMatchObject({ kind: "agents" });
  });
});
