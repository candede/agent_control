import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retain, retainUntilConverged } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import type { OfficialUsageMetadata } from "../types/officialReportRecords.js";
import type { ReportEndpoint, ReportQuery } from "../types/officialReportData.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { retainDeletedReportRows, retainRecordData } from "./dataRetention.js";

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
  fixture = await testDatabase();
  imports = new OfficialReportImports(fixture.runtime);
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-native-repository-secret", 35);
}, 30_000);
afterAll(async () => { await fixture?.close(); });

const owner = (): SelectionIdentity => ({ ...selectionIdentity, tenantId: `native-repository-${randomUUID()}` });
function csv(kind: Kind, marker = "1") {
  const row = kind === "agents" ? `agent-${marker},Agent ${marker},Your org,1,1,4,2026-07-06`
    : kind === "userAgents" ? `agent-${marker},Agent ${marker},Your org,User-${marker}@example.invalid,4,2026-07-06`
      : `User-${marker}@example.invalid,User ${marker},1,4,2026-07-06`;
  return `${schemaRegistry[kind].headers.join(",")}\n${row}\n`;
}
async function stage(identity: SelectionIdentity, bundleId: string, kind: Kind, options: {
  marker?: string; correctionOfSetId?: string; metadata?: OfficialUsageMetadata | null; content?: string;
} = {}) {
  async function* chunks() { yield Buffer.from(options.content ?? csv(kind, options.marker)); }
  return imports.stage(identity, { bundleId, correctionOfSetId: options.correctionOfSetId }, chunks(),
    options.metadata === null ? undefined : options.metadata ?? metadata);
}
function accept(identity: SelectionIdentity, preview: Awaited<ReturnType<typeof stage>>) {
  return imports.accept(identity, { stagingId: preview.id, revision: preview.revision,
    contentHash: preview.contentHash, expectedActiveRevision: preview.activeRevision });
}
async function bundle(identity: SelectionIdentity, options: Parameters<typeof stage>[3] = {}) {
  const bundleId = randomUUID();
  for (const kind of kinds) await stage(identity, bundleId, kind, options);
  const preview = await imports.bundle(identity, bundleId);
  return { bundleId, preview, accept: () => imports.acceptBundle(identity, bundleId, preview) };
}
async function page(identity: SelectionIdentity, endpoint: ReportEndpoint, query: ReportQuery = {}) {
  return reports.page((await reports.capture(identity, "delegated", endpoint, query)).id, identity, { limit: 50 });
}
async function head(identity: SelectionIdentity) {
  return (await fixture.runtime.query<{ activeSetId: string | null; activeRevision: string }>(
    `SELECT active_set_id AS "activeSetId",revision::text AS "activeRevision" FROM official_usage_state WHERE tenant_id=$1`,
    [identity.tenantId])).rows[0];
}
async function operation(identity: SelectionIdentity, setId: string, operation: "select" | "delete") {
  return imports.confirm(identity, await imports.confirmPreview(identity, setId, operation));
}
async function ageSyntheticUploads(identity: SelectionIdentity, stagingId?: string) {
  const client = await fixture.operator.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE official_usage_ingestions DISABLE TRIGGER official_upload_intent_guard");
    await client.query(`UPDATE official_usage_ingestions SET expires_at=clock_timestamp()-interval '2 days',
      created_at=clock_timestamp()-interval '2 days' WHERE tenant_id=$1 AND ($2::uuid IS NULL OR staging_id=$2)`, [identity.tenantId, stagingId ?? null]);
    await client.query(`UPDATE official_usage_staging SET expires_at=clock_timestamp()-interval '2 days',
      created_at=clock_timestamp()-interval '2 days' WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id=$2)`, [identity.tenantId, stagingId ?? null]);
    await client.query("ALTER TABLE official_usage_ingestions ENABLE TRIGGER official_upload_intent_guard");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

describe("native immutable official report authority", () => {
  it("atomically accepts metadata-free reports with distinct activity ranges and grouped numeric cells", async () => {
    const identity = owner(), bundleId = randomUUID();
    const contents = {
      agents: csv("agents").replace(",4,", ',"1,175",'),
      userAgents: csv("userAgents").replace(",4,", ',"1,175",').replace("2026-07-06", "2026-07-04"),
      users: csv("users").replace(",4,", ',"1,179",').replace("2026-07-06", "2026-06-29"),
    };
    for (const kind of kinds) {
      const preview = await stage(identity, bundleId, kind, { metadata: null, content: contents[kind] });
      expect(preview.reportingPeriod.provenance).toBe("activity_range");
    }
    const reviewed = await imports.bundle(identity, bundleId);
    expect(reviewed.complete).toBe(true); expect(reviewed.stages).toHaveLength(3);
    const accepted = await imports.acceptBundle(identity, bundleId, reviewed);
    const agents = await page(identity, "official_agents"), users = await page(identity, "official_users");
    expect(agents.reports).toMatchObject({ setId: accepted.setId,
      reportingPeriod: { startDate: "2026-06-29", endDate: "2026-07-06", provenance: "activity_range" } });
    expect(agents.reports.lineages.map(lineage => lineage.periodProvenance)).toEqual(["activity_range", "activity_range", "activity_range"]);
    expect(agents.value).toMatchObject([{ responses: 1175, bridgeResponses: 1175 }]);
    expect(users.value).toMatchObject([{ reportedResponses: 1179 }]);
  });

  it("preserves empty complete files as zero observations and unknown coverage", async () => {
    const identity = owner(), bundleId = randomUUID();
    for (const kind of kinds) await stage(identity, bundleId, kind, { metadata: null, content: csv(kind).split("\n")[0] });
    await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    const result = await page(identity, "official_agents");
    expect(result.reports.reportingPeriod).toEqual({ startDate: null, endDate: null, days: null, provenance: "activity_range" });
    expect(result.reports.lineages).toHaveLength(3);
    expect(result.reports.lineages.every(lineage => lineage.rowCount === 0)).toBe(true);
    expect(result.counts).toEqual({ total: 0, filtered: 0 });
    expect(result.summary.reportedResponses).toBe(0);
  });

  it("keeps individual partial acceptance durable and non-active until all three kinds validate", async () => {
    const identity = owner(), bundleId = randomUUID();
    const first = await accept(identity, await stage(identity, bundleId, "agents"));
    expect(first).toMatchObject({ complete: false, activeRevision: "1" });
    expect(await head(identity)).toEqual({ activeSetId: null, activeRevision: "1" });
    expect((await page(identity, "official_agents")).value).toEqual([]);
    const second = await accept(identity, await stage(identity, bundleId, "userAgents"));
    expect(second).toMatchObject({ complete: false, setId: first.setId });
    const third = await accept(identity, await stage(identity, bundleId, "users"));
    expect(third).toEqual({ complete: true, activeRevision: "2", setId: first.setId });
    expect(await head(identity)).toEqual({ activeSetId: first.setId, activeRevision: "2" });
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_version_rows WHERE tenant_id=$1) AS accepted,
      (SELECT count(*)::int FROM official_usage_staged_rows WHERE tenant_id=$1) AS staged`, [identity.tenantId])).rows)
      .toEqual([{ accepted: 3, staged: 0 }]);
  });

  it("accepts different download times for the same observation basis but rejects mixed reporting periods", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), bundleId = randomUUID();
    const first = await stage(identity, bundleId, "agents", { correctionOfSetId: original.setId,
      metadata: { ...metadata, downloadedAt: "2026-07-08T12:00:00Z" } });
    const second = await stage(identity, bundleId, "userAgents", { correctionOfSetId: original.setId,
      metadata: { ...metadata, downloadedAt: "2026-07-08T12:05:00Z" } });
    await expect(stage(identity, bundleId, "users", { correctionOfSetId: original.setId,
      metadata: { ...metadata, reportingPeriod: { ...metadata.reportingPeriod, startDate: "2026-06-08" } } }))
      .rejects.toMatchObject({ code: "invalid_reporting_period" });
    await accept(identity, first); await accept(identity, second);
    expect((await head(identity)).activeSetId).toBe(original.setId);
  });

  it("rejects incompatible companion source snapshots without publishing partial acceptance", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept(), bundleId = randomUUID();
    const first = await stage(identity, bundleId, "agents", { correctionOfSetId: original.setId });
    const incompatible = await stage(identity, bundleId, "userAgents", { correctionOfSetId: original.setId,
      metadata: { ...metadata, sourceAsOf: { value: "2026-07-08T12:00:01Z", provenance: "operator_asserted" } } });
    await accept(identity, first);
    await expect(accept(identity, incompatible)).rejects.toMatchObject({ code: "incompatible_bundle" });
    expect((await head(identity)).activeSetId).toBe(original.setId);
  });

  it("preserves immutable explicit corrections and identical receipt retries", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept();
    const correction = await bundle(identity, { marker: "2", correctionOfSetId: original.setId }), corrected = await correction.accept();
    expect(corrected.complete).toBe(true); expect(corrected.setId).not.toBe(original.setId);
    expect(await correction.accept()).toEqual(corrected);
    expect((await fixture.runtime.query("SELECT supersedes_set_id FROM official_usage_sets WHERE id=$1", [corrected.setId])).rows)
      .toEqual([{ supersedes_set_id: original.setId }]);
    const agents = await page(identity, "official_agents"), users = await page(identity, "official_users");
    expect(agents.reports.setId).toBe(corrected.setId);
    expect(agents.reports.lineages).toHaveLength(3);
    expect(agents.reports.lineages.every(lineage => lineage.rowCount === 1)).toBe(true);
    expect(agents.value).toMatchObject([{ agentId: "agent-2" }]);
    expect(users.value).toMatchObject([{ username: "User-2@example.invalid", relationshipCount: 1 }]);
    expect((await page(identity, "relationships", { username: "User-2@example.invalid" })).value)
      .toMatchObject([{ agentId: "agent-2", username: "User-2@example.invalid" }]);
  });

  it("reuses a reviewed exact bundle without advancing selection or retained history", async () => {
    const identity = owner(), original = await (await bundle(identity)).accept();
    const before = await page(identity, "history"), repeated = await bundle(identity), accepted = await repeated.accept();
    expect(accepted).toEqual(original);
    expect(await head(identity)).toEqual({ activeSetId: original.setId, activeRevision: original.activeRevision });
    const after = await page(identity, "history");
    expect(after.value).toEqual(before.value); expect(after.analytics.history).toEqual(before.analytics.history);
    expect(after.reports.historyRevision).toBe(before.reports.historyRevision);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM official_usage_versions WHERE tenant_id=$1`, [identity.tenantId])).rows)
      .toEqual([{ n: 3 }]);
    expect(await repeated.accept()).toEqual(accepted);
  });

  it("rejects wrong-actor, replaced and expired previews without leaking rows", async () => {
    const identity = owner(), bundleId = randomUUID();
    const replaced = await stage(identity, bundleId, "agents"), current = await stage(identity, bundleId, "agents", { marker: "3" });
    await expect(accept(identity, replaced)).rejects.toMatchObject({ code: "staging_unavailable" });
    await expect(accept({ ...identity, principalId: "another-administrator" }, current)).rejects.toMatchObject({ code: "staging_unavailable" });
    await ageSyntheticUploads(identity, current.id);
    await expect(accept(identity, current)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect(await imports.sweep(identity.tenantId)).toBeGreaterThanOrEqual(1);
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM official_usage_staged_rows WHERE staging_id IN ($1,$2)`,
      [replaced.id, current.id])).rows).toEqual([{ n: 0 }]);
  });

  it("binds drafts to their initiating actor and immutable receipt retries to the reviewed revision", async () => {
    const identity = owner(), bundleId = randomUUID(), preview = await stage(identity, bundleId, "agents");
    await expect(stage({ ...identity, principalId: "another-administrator" }, bundleId, "users")).rejects.toMatchObject({ code: "bundle_owner_mismatch" });
    const accepted = await accept(identity, preview);
    await expect(imports.accept(identity, { stagingId: preview.id, revision: preview.revision, contentHash: preview.contentHash,
      expectedActiveRevision: String(BigInt(preview.activeRevision) + 1n) })).rejects.toMatchObject({ code: "active_revision_mismatch" });
    expect(await accept(identity, preview)).toEqual(accepted);
  });

  it("records the actual reviewed revision when accepting a draft created before another publication", async () => {
    const identity = owner(), preview = await stage(identity, randomUUID(), "agents");
    const current = await (await bundle(identity, { marker: "current" })).accept();
    const confirmation = { stagingId: preview.id, revision: preview.revision, contentHash: preview.contentHash,
      expectedActiveRevision: current.activeRevision };
    const accepted = await imports.accept(identity, confirmation);
    expect(accepted.complete).toBe(false);
    expect(await imports.accept(identity, confirmation)).toEqual(accepted);
    await expect(accept(identity, preview)).rejects.toMatchObject({ code: "active_revision_mismatch" });
    expect((await head(identity)).activeSetId).toBe(current.setId);
  });

  it("guards the durable acceptance revision against changes after publication", async () => {
    const identity = owner(); await (await bundle(identity)).accept();
    await expect(fixture.runtime.query(`UPDATE official_usage_ingestions SET acceptance_revision=acceptance_revision+1
      WHERE tenant_id=$1 AND kind='agents'`, [identity.tenantId])).rejects.toThrow("official_acceptance_receipt_immutable");
  });

  it("rejects unseen companion replacement and altered, foreign or cross-tenant bundle confirmations", async () => {
    const identity = owner(), staged = await bundle(identity), stale = staged.preview;
    await stage(identity, staged.bundleId, "users", { marker: "replacement" });
    await expect(staged.accept()).rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM official_usage_versions WHERE tenant_id=$1`, [identity.tenantId])).rows).toEqual([{ n: 0 }]);
    const reviewed = await imports.bundle(identity, staged.bundleId), accepted = await imports.acceptBundle(identity, staged.bundleId, reviewed);
    expect(await imports.acceptBundle(identity, staged.bundleId, reviewed)).toEqual(accepted);
    for (const input of [{ ...reviewed, bundleHash: "f".repeat(64) },
      { ...reviewed, expectedActiveRevision: String(BigInt(reviewed.expectedActiveRevision) + 1n) }, stale]) {
      await expect(imports.acceptBundle(identity, staged.bundleId, input)).rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    }
    for (const outsider of [{ ...identity, principalId: "another-administrator" }, owner()]) {
      await expect(imports.acceptBundle(outsider, staged.bundleId, reviewed)).rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    }
    await ageSyntheticUploads(identity);
    await retain(fixture.operator);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_staging WHERE tenant_id=$1", [identity.tenantId])).rows).toEqual([{ n: 0 }]);
    expect(await imports.acceptBundle(identity, staged.bundleId, reviewed)).toEqual(accepted);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_bundle_receipts WHERE tenant_id=$1) AS receipts,
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions`, [identity.tenantId])).rows)
      .toEqual([{ receipts: 1, sets: 1, versions: 3 }]);
    await operation(identity, accepted.setId, "delete");
    await expect(imports.acceptBundle(identity, staged.bundleId, reviewed)).rejects.toMatchObject({ code: "deleted_report_duplicate" });
    expect(await head(identity)).toEqual({ activeSetId: null, activeRevision: String(BigInt(accepted.activeRevision) + 1n) });
  });

  it("rejects incompatible observation bases while reviewing a complete bundle", async () => {
    const identity = owner(), bundleId = randomUUID();
    await stage(identity, bundleId, "agents");
    await stage(identity, bundleId, "userAgents", {
      metadata: { ...metadata, sourceAsOf: { value: "2026-07-08T12:00:01Z", provenance: "operator_asserted" } } });
    await stage(identity, bundleId, "users");
    await expect(imports.bundle(identity, bundleId)).rejects.toMatchObject({ code: "incompatible_bundle" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_versions WHERE tenant_id=$1", [identity.tenantId])).rows).toEqual([{ n: 0 }]);
  });

  it("idempotently serializes concurrent acceptance of the same immutable bundle confirmation", async () => {
    const identity = owner(), staged = await bundle(identity);
    const other = new OfficialReportImports(fixture.runtime);
    const [first, second] = await Promise.all([staged.accept(), other.acceptBundle(identity, staged.bundleId, staged.preview)]);
    expect(first).toEqual(second);
    expect((await page(identity, "history")).counts.total).toBe(1);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_bundle_receipts WHERE tenant_id=$1) AS receipts,
      (SELECT count(*)::int FROM official_usage_audit WHERE tenant_id=$1 AND action='accepted') AS audits`, [identity.tenantId])).rows)
      .toEqual([{ receipts: 1, audits: 3 }]);
  });

  it.each([1, 2])("atomically rejects publication failure after %i pending memberships and retries the same review", async count => {
    const identity = owner(), staged = await bundle(identity), failedTenant = identity.tenantId.replaceAll("'", "''");
    await fixture.operator.query(`CREATE FUNCTION phase02b_fail_membership() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id='${failedTenant}' AND (SELECT count(*) FROM official_usage_set_versions WHERE set_id=NEW.set_id)>=${count}
        THEN RAISE EXCEPTION 'synthetic membership failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER phase02b_fail_membership BEFORE INSERT ON official_usage_set_versions FOR EACH ROW EXECUTE FUNCTION phase02b_fail_membership()`);
    try {
      await expect(staged.accept()).rejects.toThrow("synthetic membership failure");
      expect(await head(identity)).toEqual({ activeSetId: null, activeRevision: "1" });
      expect((await page(identity, "history")).counts.total).toBe(0);
      expect((await page(identity, "official_agents")).value).toEqual([]);
      expect((await fixture.runtime.query(`SELECT
        (SELECT count(*)::int FROM official_usage_set_versions WHERE tenant_id=$1) AS memberships,
        (SELECT count(*)::int FROM official_usage_history_memberships WHERE tenant_id=$1) AS history,
        (SELECT count(*)::int FROM official_usage_bundle_receipts WHERE tenant_id=$1) AS receipts,
        (SELECT count(*)::int FROM official_usage_audit WHERE tenant_id=$1 AND action='accepted') AS audits`, [identity.tenantId])).rows)
        .toEqual([{ memberships: 0, history: 0, receipts: 0, audits: 0 }]);
    } finally {
      await fixture.operator.query("DROP TRIGGER phase02b_fail_membership ON official_usage_set_versions; DROP FUNCTION phase02b_fail_membership()");
    }
    const accepted = await staged.accept(); expect(accepted.complete).toBe(true);
    expect((await page(identity, "official_agents")).counts.total).toBe(1);
  });

  it("resumes a partially accepted actor-owned bundle without copying accepted versions again", async () => {
    const identity = owner(), bundleId = randomUUID();
    const first = await accept(identity, await stage(identity, bundleId, "agents"));
    for (const kind of ["userAgents", "users"] as const) await stage(identity, bundleId, kind);
    const reviewed = await imports.bundle(identity, bundleId);
    expect(reviewed.complete).toBe(true); expect(reviewed.stages.map(stage => stage.kind)).toEqual(["agents", "userAgents", "users"]);
    expect(await imports.acceptBundle(identity, bundleId, reviewed)).toMatchObject({ complete: true, setId: first.setId });
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_versions WHERE tenant_id=$1", [identity.tenantId])).rows).toEqual([{ n: 3 }]);
  });

  it("revision-fences concurrent selection and deletion without falling back after active deletion", async () => {
    const identity = owner(), prior = await (await bundle(identity)).accept(), active = await (await bundle(identity, { marker: "2" })).accept();
    const select = await imports.confirmPreview(identity, prior.setId, "select"), remove = await imports.confirmPreview(identity, active.setId, "delete");
    const [selected, deleted] = await Promise.allSettled([imports.confirm(identity, select), imports.confirm(identity, remove)]);
    expect([selected.status, deleted.status].sort()).toEqual(["fulfilled", "rejected"]);
    if (selected.status === "fulfilled") {
      expect((await head(identity)).activeSetId).toBe(prior.setId);
      expect((await operation(identity, prior.setId, "delete")).activeSetId).toBeNull();
    } else expect((await head(identity)).activeSetId).toBeNull();
    expect((await page(identity, "official_agents")).value).toEqual([]);
    expect((await page(identity, "history")).counts.total).toBe(1);
  });

  it("protects immutable accepted content and reclaims expired pending row copies", async () => {
    const identity = owner(); await (await bundle(identity)).accept();
    const version = (await fixture.runtime.query(`SELECT id,kind FROM official_usage_versions WHERE tenant_id=$1 ORDER BY id LIMIT 1`, [identity.tenantId])).rows[0];
    await expect(fixture.runtime.query("UPDATE official_usage_versions SET row_count=row_count+1 WHERE id=$1", [version.id])).rejects.toThrow("immutable");
    await expect(fixture.runtime.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
      SELECT $1,$2,$3,49999,payload_hash FROM official_usage_row_facts WHERE tenant_id=$2 AND kind=$3 LIMIT 1`,
    [version.id, identity.tenantId, version.kind])).rejects.toThrow("published or deleted");
    const pending = await stage(identity, randomUUID(), "agents", { marker: "pending" });
    await ageSyntheticUploads(identity, pending.id);
    await retain(fixture.operator);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_staged_rows WHERE staging_id=$1", [pending.id])).rows).toEqual([{ n: 0 }]);
  });

  it("keeps deleted rows pinned and reclaims them in at most 250-row runtime batches after release", async () => {
    const identity = owner(), bundleId = randomUUID();
    for (const kind of kinds) {
      async function* chunks() {
        yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n`);
        if (kind === "agents") for (let n = 0; n < 251; n++) yield Buffer.from(csv(kind, String(n)).split("\n")[1] + "\n");
      }
      await imports.stage(identity, { bundleId }, chunks(), metadata);
    }
    const accepted = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    const selected = await reports.capture(identity, "delegated", "history");
    await operation(identity, accepted.setId, "delete");
    const rows = async () => (await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_version_rows WHERE tenant_id=$1", [identity.tenantId])).rows[0].n;
    expect(await rows()).toBe(251);
    await expect(reports.page(selected.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await imports.connections.run(client => retainDeletedReportRows(client))).toBe(0);
    await retain(fixture.operator, { dryRun: true });
    expect(await rows()).toBe(251);
    await reports.selections.invalidate(selected.id, identity);
    expect((await imports.connections.run(client => retainRecordData(client))).recordDeletedReportRows).toBe(250);
    expect(await rows()).toBe(1);
    expect((await imports.connections.run(client => retainRecordData(client))).recordDeletedReportRows).toBe(1);
    expect(await rows()).toBe(0);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_row_facts WHERE tenant_id=$1", [identity.tenantId])).rows)
      .toEqual([{ n: 251 }]);
    await retainUntilConverged(fixture.operator, { batchSize: 250 });
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_row_facts WHERE tenant_id=$1", [identity.tenantId])).rows)
      .toEqual([{ n: 0 }]);
  }, 30_000);

  it("retains accepted null-expiry content and receipts until explicit deletion and bounded purge", async () => {
    const identity = owner(), staged = await bundle(identity), accepted = await staged.accept();
    await ageSyntheticUploads(identity);
    await fixture.operator.query("UPDATE official_usage_sets SET accepted_at=clock_timestamp()-interval '181 days' WHERE tenant_id=$1", [identity.tenantId]);
    await retain(fixture.operator);
    expect((await page(identity, "official_agents")).value).toHaveLength(1);
    expect(await staged.accept()).toEqual(accepted);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1 AND expires_at IS NOT NULL) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1 AND expires_at IS NOT NULL) AS versions,
      (SELECT count(*)::int FROM official_usage_artifacts WHERE tenant_id=$1 AND expires_at IS NOT NULL) AS artifacts`, [identity.tenantId])).rows)
      .toEqual([{ sets: 0, versions: 0, artifacts: 0 }]);
    await operation(identity, accepted.setId, "delete");
    expect((await page(identity, "official_agents")).value).toEqual([]);
    await fixture.operator.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1", [identity.tenantId]);
    await fixture.operator.query("UPDATE official_usage_versions SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1", [identity.tenantId]);
    await fixture.operator.query("UPDATE official_usage_audit SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [identity.tenantId]);
    const selections = await fixture.runtime.query("SELECT id FROM data_read_selections WHERE tenant_id=$1 ORDER BY id LIMIT 250", [identity.tenantId]);
    for (const selected of selections.rows) await reports.selections.invalidate(selected.id, identity);
    // Model a restarted operator whose persisted traversal has already passed this tenant.
    await fixture.operator.query(`UPDATE data_lifecycle_progress SET cursor=jsonb_build_object('step',0,'tenant',$1::text)
      WHERE worker='operator'`, [identity.tenantId]);
    await retainUntilConverged(fixture.operator, { batchSize: 250 });
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
      (SELECT count(*)::int FROM official_usage_artifacts WHERE tenant_id=$1) AS artifacts,
      (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts`, [identity.tenantId])).rows)
      .toEqual([{ sets: 0, versions: 0, artifacts: 0, facts: 0 }]);
  }, 30_000);

  it("does not recreate the retired cleanup-acknowledgement mutation", () => {
    expect(imports).not.toHaveProperty("acknowledgeLegacyCleanup");
  });
});
