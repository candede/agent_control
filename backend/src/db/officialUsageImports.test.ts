import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import type { OfficialUsageMetadata, OfficialUsageReportKind } from "../types/officialUsage.js";
import { OfficialUsageRepository, type OfficialUsageScope } from "./officialUsage.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: OfficialUsageRepository;
const kinds = ["agents", "userAgents", "users"] as const;
const metadata: OfficialUsageMetadata = {
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
  sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
};

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new OfficialUsageRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function owner(): OfficialUsageScope {
  return { tenantId: `tenant-import-${randomUUID()}`, principalId: "import-administrator" };
}

function csv(kind: OfficialUsageReportKind, responses = 4) {
  if (kind === "agents") return `Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nagent-1,Agent 1,Your org,1,1,${responses},2026-07-06`;
  if (kind === "userAgents") return `Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nagent-1,Agent 1,Your org,User@example.invalid,${responses},2026-07-06`;
  return `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nUser@example.invalid,User,1,${responses},2026-07-06`;
}

async function stage(scope: OfficialUsageScope, bundleId: string, kind: OfficialUsageReportKind, options: {
  responses?: number; correctionOfSetId?: string; rejectDuplicateKind?: boolean;
  reportMetadata?: OfficialUsageMetadata; reformatted?: boolean;
} = {}) {
  const content = options.reformatted ? csv(kind, options.responses).replaceAll("\n", "\r\n") + "\r\n" : csv(kind, options.responses);
  return repository.stage(scope, {
    report: parseOfficialUsageReport(Buffer.from(content), options.reportMetadata ?? metadata),
    fileHash: createHash("sha256").update(content).digest("hex"),
    bundleId,
    correctionOfSetId: options.correctionOfSetId,
    rejectDuplicateKind: options.rejectDuplicateKind,
  });
}

async function bundle(scope: OfficialUsageScope, options: Parameters<typeof stage>[3] = {}) {
  const bundleId = randomUUID();
  const stages = await Promise.all(kinds.map(kind => stage(scope, bundleId, kind, options)));
  const preview = await repository.previewBundle(scope, bundleId);
  return { bundleId, stages, preview, accept: () => repository.acceptBundle(scope, bundleId, preview) };
}

async function setOperation(scope: OfficialUsageScope, operation: "select" | "delete", setId: string) {
  const preview = await repository.previewSetOperation(scope, operation, setId);
  return repository.confirmSetOperation(scope, preview.id, { ...preview, operation, setId });
}

async function counts(scope: OfficialUsageScope) {
  return (await fixture.runtime.query(`SELECT
    (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
    (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
    (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts,
    (SELECT count(*)::int FROM official_usage_version_rows WHERE tenant_id=$1) AS rows,
    (SELECT count(*)::int FROM official_usage_set_versions WHERE tenant_id=$1) AS memberships`,
  [scope.tenantId])).rows[0];
}

describe("official usage automatic import semantics", () => {
  it.each([false, true])("appends independent changed known-window snapshots (advanced source=%s)", async advancedSource => {
    const scope = owner();
    const original = await (await bundle(scope)).accept();
    const originalPublished = await repository.getPublished(scope.tenantId);
    const bundleId = randomUUID();
    await Promise.all(kinds.map(kind => stage(scope, bundleId, kind, {
      responses: kind === "agents" ? 7 : 4,
      reportMetadata: advancedSource ? { ...metadata, sourceAsOf: { value: "2026-07-09T12:00:00Z", provenance: "operator_asserted" } } : metadata,
    })));
    const preview = await repository.previewBundle(scope, bundleId);
    const accepted = await repository.acceptBundle(scope, bundleId, preview);
    expect(accepted).toMatchObject({ complete: true, reusedExistingSet: false, activeRevision: original.activeRevision + 1 });
    expect(accepted.setId).not.toBe(original.setId);
    expect((await repository.getPublished(scope.tenantId)).activeSet).toMatchObject({ id: accepted.setId, supersedesSetId: null });
    expect((await repository.getPublished(scope.tenantId, original.setId)).reports).toEqual(originalPublished.reports);
    expect(await counts(scope)).toEqual({
      sets: 2, versions: advancedSource ? 6 : 4, facts: 4, rows: advancedSource ? 6 : 4, memberships: 6,
    });
    expect(await repository.acceptBundle(scope, bundleId, preview)).toEqual(accepted);
  });

  it("reuses an old semantic duplicate outside the admin listing without changing selection, acceptance time, or receipts", async () => {
    const scope = owner();
    const original = await (await bundle(scope)).accept();
    const originalSet = (await repository.getPublished(scope.tenantId)).activeSet;
    const active = await (await bundle(scope, { responses: 7 })).accept();
    await fixture.operator.query(`INSERT INTO official_usage_sets
      (id,tenant_id,bundle_id,actor_principal_id,period_provenance)
      SELECT gen_random_uuid(),$1,gen_random_uuid(),$2,'activity_range' FROM generate_series(1,100)`,
    [scope.tenantId, scope.principalId]);
    expect((await repository.getAdminState(scope)).sets.some(set => set.id === original.setId)).toBe(false);
    const before = await counts(scope);
    const duplicate = await bundle({ ...scope, principalId: "second-administrator" }, {
      reformatted: true, reportMetadata: { ...metadata, downloadedAt: "2026-07-10T12:00:00Z" },
    });
    const accepted = await duplicate.accept();
    expect(accepted).toMatchObject({ setId: original.setId, complete: true, reusedExistingSet: true, activeRevision: active.activeRevision });
    expect((await repository.getPublished(scope.tenantId)).activeSet?.id).toBe(active.setId);
    expect((await repository.getPublished(scope.tenantId, original.setId)).activeSet).toEqual(originalSet);
    expect(await counts(scope)).toEqual(before);
    await fixture.operator.query(`UPDATE official_usage_staging SET created_at=clock_timestamp()-interval '2 days'
      WHERE tenant_id=$1 AND bundle_id=$2`, [scope.tenantId, duplicate.bundleId]);
    await retain(fixture.operator);
    expect((await fixture.runtime.query("SELECT id FROM official_usage_staging WHERE tenant_id=$1 AND bundle_id=$2",
      [scope.tenantId, duplicate.bundleId])).rows).toEqual([]);
    expect(await duplicate.accept()).toEqual(accepted);
    await setOperation(scope, "delete", original.setId);
    await expect(duplicate.accept()).rejects.toMatchObject({ code: "deleted_report_duplicate" });
  });

  it.each([false, true])("creates a correction using another set's report versions (resumed legacy draft=%s)", async resumeDraft => {
    const scope = owner();
    const original = await (await bundle(scope)).accept();
    const unrelated = await (await bundle(scope, { responses: 7 })).accept();
    const unrelatedPublished = await repository.getPublished(scope.tenantId);
    const selected = await setOperation(scope, "select", original.setId);
    let correction = await bundle(scope, { responses: 7, correctionOfSetId: original.setId });
    if (resumeDraft) {
      const stage = correction.stages[0];
      expect(await repository.accept(scope, stage.id, {
        stagingRevision: stage.revision, fileHash: stage.fileHash, expectedActiveRevision: stage.activeRevision,
      })).toMatchObject({ complete: false, activeRevision: selected.activeRevision });
      const bundleId = correction.bundleId;
      const preview = await repository.previewBundle(scope, bundleId);
      expect(preview.acceptedVersions.map(version => version.kind)).toEqual(["agents"]);
      correction = { ...correction, preview, accept: () => repository.acceptBundle(scope, bundleId, preview) };
    }
    const accepted = await correction.accept();
    expect(accepted).toMatchObject({ complete: true, reusedExistingSet: false, activeRevision: selected.activeRevision + 1 });
    expect([original.setId, unrelated.setId]).not.toContain(accepted.setId);
    const published = await repository.getPublished(scope.tenantId);
    expect(published.activeSet).toMatchObject({ id: accepted.setId, supersedesSetId: original.setId });
    expect(published.reports).toEqual(unrelatedPublished.reports);
    expect((await repository.getPublished(scope.tenantId, unrelated.setId)).activeSet).toEqual(unrelatedPublished.activeSet);
    expect(await counts(scope)).toEqual({ sets: 3, versions: 6, facts: 6, rows: 6, memberships: 9 });
    expect(await correction.accept()).toEqual(accepted);
    const duplicateCorrection = await (await bundle(scope, { responses: 7, correctionOfSetId: original.setId })).accept();
    expect(duplicateCorrection).toMatchObject({ setId: accepted.setId, reusedExistingSet: true, activeRevision: accepted.activeRevision });
    await setOperation(scope, "delete", unrelated.setId);
    expect((await repository.getPublished(scope.tenantId)).reports).toEqual(published.reports);
  });

  it("makes an unchanged explicit correction to an inactive target an idempotent complete result", async () => {
    const scope = owner();
    const original = await (await bundle(scope)).accept();
    const active = await (await bundle(scope, { responses: 7 })).accept();
    const correction = await bundle(scope, { correctionOfSetId: original.setId });
    expect(await correction.accept()).toMatchObject({
      setId: original.setId, activeRevision: active.activeRevision, complete: true, reusedExistingSet: true,
    });
    expect((await repository.getPublished(scope.tenantId)).activeSet?.id).toBe(active.setId);
    expect(await counts(scope)).toEqual({ sets: 2, versions: 6, facts: 6, rows: 6, memberships: 6 });
    const legacy = await bundle(scope, { correctionOfSetId: original.setId });
    const stage = legacy.stages[0];
    expect(await repository.accept(scope, stage.id, {
      stagingRevision: stage.revision, fileHash: stage.fileHash, expectedActiveRevision: stage.activeRevision,
    })).toMatchObject({ setId: original.setId, complete: true, activeRevision: active.activeRevision });
  });

  it.each(["dates", "provenance"] as const)("validates correction target %s before reusing unrelated duplicate content", async mismatch => {
    const scope = owner();
    const original = await (await bundle(scope, { reportMetadata: {
      ...metadata,
      reportingPeriod: mismatch === "dates"
        ? { ...metadata.reportingPeriod!, startDate: "2026-06-06", endDate: "2026-07-05" }
        : undefined,
    } })).accept();
    await (await bundle(scope, { responses: 7 })).accept();
    const correction = await bundle(scope, { responses: 7, correctionOfSetId: original.setId });
    const before = await counts(scope);
    await expect(correction.accept()).rejects.toMatchObject({ code: "invalid_correction" });
    expect(await counts(scope)).toEqual(before);
    expect(await repository.previewBundle(scope, correction.bundleId)).toEqual(correction.preview);
    const stage = correction.stages[0];
    await expect(repository.accept(scope, stage.id, {
      stagingRevision: stage.revision, fileHash: stage.fileHash, expectedActiveRevision: stage.activeRevision,
    })).rejects.toMatchObject({ code: "invalid_correction" });
  });

  it("keeps deleted correction content fenced even when its correction target is still available", async () => {
    const scope = owner();
    const original = await (await bundle(scope)).accept();
    const removed = await (await bundle(scope, { responses: 7 })).accept();
    await setOperation(scope, "delete", removed.setId);
    await setOperation(scope, "select", original.setId);
    const correction = await bundle(scope, { responses: 7, correctionOfSetId: original.setId });
    await expect(correction.accept()).rejects.toMatchObject({ code: "deleted_report_duplicate" });
    expect((await repository.getPublished(scope.tenantId)).activeSet?.id).toBe(original.setId);
    await setOperation(scope, "delete", original.setId);
    await expect(bundle(scope, { correctionOfSetId: original.setId })).rejects.toMatchObject({ code: "invalid_correction" });
  });

  it("revalidates an unavailable correction target before the duplicate shortcut, including legacy accept", async () => {
    const scope = owner();
    const original = await (await bundle(scope)).accept();
    await (await bundle(scope, { responses: 7 })).accept();
    const correction = await bundle(scope, { responses: 7, correctionOfSetId: original.setId });
    await fixture.operator.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp() WHERE id=$1", [original.setId]);
    const before = await counts(scope);
    await expect(correction.accept()).rejects.toMatchObject({ code: "invalid_correction" });
    const stage = correction.stages[0];
    await expect(repository.accept(scope, stage.id, {
      stagingRevision: stage.revision, fileHash: stage.fileHash, expectedActiveRevision: stage.activeRevision,
    })).rejects.toMatchObject({ code: "invalid_correction" });
    expect(await counts(scope)).toEqual(before);
    expect(await repository.getStaging(scope, stage.id)).toEqual(stage);
  });

  it("rejects duplicate report kinds before mutation, preserves retries, and allows replacement after discard", async () => {
    const scope = owner();
    const bundleId = randomUUID();
    const original = await stage(scope, bundleId, "agents", { rejectDuplicateKind: true });
    const before = await repository.previewBundle(scope, bundleId);
    const client = await fixture.runtime.connect();
    const query = vi.spyOn(client, "query");
    const connect = vi.spyOn(fixture.runtime, "connect").mockResolvedValueOnce(client);
    try {
      await expect(stage(scope, bundleId, "agents", { responses: 7, rejectDuplicateKind: true }))
        .rejects.toMatchObject({ status: 409, code: "duplicate_report_kind", message: expect.stringContaining("Discard the draft") });
      expect(query.mock.calls.map(([sql]) => String(sql)).filter(sql => /\b(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([]);
    } finally {
      query.mockRestore();
      connect.mockRestore();
    }
    expect(await repository.getStaging(scope, original.id)).toEqual(original);
    expect(await repository.previewBundle(scope, bundleId)).toEqual(before);
    expect((await fixture.runtime.query("SELECT row_data FROM official_usage_staged_rows WHERE staging_id=$1", [original.id])).rows)
      .toMatchObject([{ row_data: { responsesSentToUsers: 4 } }]);
    await repository.discardStaging(scope, original.id);
    expect(await stage(scope, bundleId, "agents", { responses: 7, rejectDuplicateKind: true })).toMatchObject({ kind: "agents", status: "active" });
  });

  it("serializes simultaneous guarded uploads and retains default API replacement behavior", async () => {
    const scope = owner();
    const bundleId = randomUUID();
    const results = await Promise.allSettled([4, 7].map(responses =>
      stage(scope, bundleId, "agents", { responses, rejectDuplicateKind: true })));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "duplicate_report_kind" } });
    const original = (await repository.previewBundle(scope, bundleId)).staging[0];
    const replacement = await stage(scope, bundleId, "agents", { responses: 9 });
    expect(await repository.getStaging(scope, original.id)).toMatchObject({ status: "replaced" });
    expect((await fixture.runtime.query("SELECT ordinal FROM official_usage_staged_rows WHERE staging_id=$1", [original.id])).rows).toEqual([]);
    expect((await repository.previewBundle(scope, bundleId)).staging.map(stage => stage.id)).toEqual([replacement.id]);
    await fixture.operator.query("UPDATE official_usage_staging SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [replacement.id]);
    expect(await stage(scope, bundleId, "agents", { rejectDuplicateKind: true })).toMatchObject({ kind: "agents", status: "active" });
  });
});
