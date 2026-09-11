import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retain, retainUntilConverged } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import type { OfficialUsageMetadata } from "../types/officialUsage.js";
import { OfficialUsageRepository } from "./officialUsage.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: OfficialUsageRepository;
const administrator = { tenantId: "tenant-usage", principalId: "administrator-a" };
const otherAdministrator = { ...administrator, principalId: "administrator-b" };
const metadata: OfficialUsageMetadata = {
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
  sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
};

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new OfficialUsageRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function csv(kind: "agents" | "userAgents" | "users", marker = "1") {
  if (kind === "agents") return `Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nagent-${marker},Agent ${marker},Your org,1,1,4,2026-07-06`;
  if (kind === "userAgents") return `Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nagent-${marker},Agent ${marker},Your org,User-${marker}@example.invalid,4,2026-07-06`;
  return `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nUser-${marker}@example.invalid,User ${marker},1,4,2026-07-06`;
}

async function stage(kind: "agents" | "userAgents" | "users", bundleId: string, options: { marker?: string; correctionOfSetId?: string; scope?: typeof administrator; metadata?: OfficialUsageMetadata } = {}) {
  const content = csv(kind, options.marker);
  return repository.stage(options.scope ?? administrator, {
    report: parseOfficialUsageReport(Buffer.from(content), options.metadata ?? metadata),
    fileHash: createHash("sha256").update(content).digest("hex"),
    bundleId,
    correctionOfSetId: options.correctionOfSetId,
  });
}

async function accept(staging: Awaited<ReturnType<typeof stage>>, scope = administrator) {
  return repository.accept(scope, staging.id, {
    stagingRevision: staging.revision,
    fileHash: staging.fileHash,
    expectedActiveRevision: staging.activeRevision,
  });
}

async function completeSet(marker = "1", correctionOfSetId?: string, sourceMetadata = metadata) {
  const bundleId = randomUUID();
  const previews = await Promise.all(["agents", "userAgents", "users"].map(kind => stage(kind as "agents" | "userAgents" | "users", bundleId, { marker, correctionOfSetId, metadata: sourceMetadata })));
  const first = await accept(previews[0]);
  const second = await accept(previews[1]);
  const third = await accept(previews[2]);
  return { bundleId, previews, first, second, third };
}

describe.sequential("Official usage repository", () => {
  it("keeps incomplete submissions durable without replacing active data, then activates all three compatible kinds atomically", async () => {
    const bundleId = randomUUID();
    const agents = await stage("agents", bundleId);
    const acceptedAgents = await accept(agents);
    expect(acceptedAgents).toMatchObject({ complete: false, activeRevision: 1 });
    expect(await repository.getAdminState(administrator)).toMatchObject({ activeSetId: null, activeRevision: 1, sets: [{ complete: false, kinds: ["agents"] }] });

    const userAgents = await stage("userAgents", bundleId);
    const users = await stage("users", bundleId);
    await accept(userAgents);
    const completed = await accept(users);
    expect(completed).toMatchObject({ complete: true, activeRevision: 2, setId: acceptedAgents.setId });
    expect(await repository.getAdminState(administrator)).toMatchObject({ activeSetId: completed.setId, activeRevision: 2, sets: [{ complete: true, kinds: ["agents", "userAgents", "users"] }] });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows")).rows[0].count).toBe(3);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staged_rows")).rows[0].count).toBe(0);
  });

  it("accepts different download times for one exact source snapshot but rejects mixed periods", async () => {
    const bundleId = randomUUID();
    const first = await stage("agents", bundleId, { correctionOfSetId: (await repository.getAdminState(administrator)).activeSetId!, metadata: { ...metadata, downloadedAt: "2026-07-08T12:00:00Z" } });
    const second = await stage("userAgents", bundleId, { correctionOfSetId: first.correctionOfSetId ?? undefined, metadata: { ...metadata, downloadedAt: "2026-07-08T12:05:00Z" } });
    await expect(stage("users", bundleId, { correctionOfSetId: first.correctionOfSetId ?? undefined, metadata: { ...metadata, reportingPeriod: { ...metadata.reportingPeriod, startDate: "2026-06-08" } } }))
      .rejects.toMatchObject({ code: "invalid_reporting_period" });
    await accept(first);
    await accept(second);
    expect((await repository.getAdminState(administrator)).activeSetId).not.toBeNull();
  });

  it("rejects companion reports from an incompatible source snapshot basis", async () => {
    const activeSetId = (await repository.getAdminState(administrator)).activeSetId!;
    const bundleId = randomUUID();
    const first = await stage("agents", bundleId, { correctionOfSetId: activeSetId });
    const incompatible = await stage("userAgents", bundleId, {
      correctionOfSetId: activeSetId,
      metadata: { ...metadata, sourceAsOf: { value: "2026-07-08T12:00:01Z", provenance: "operator_asserted" } },
    });
    await accept(first);
    await expect(accept(incompatible)).rejects.toMatchObject({ code: "incompatible_bundle" });
  });

  it("requires explicit immutable correction and makes retries idempotent", async () => {
    const activeBefore = (await repository.getAdminState(administrator)).activeSetId!;
    const unlabelledBundle = randomUUID();
    const unlabelled = await Promise.all(["agents", "userAgents", "users"].map(kind => stage(kind as "agents" | "userAgents" | "users", unlabelledBundle, { marker: "2" })));
    await accept(unlabelled[0]);
    await accept(unlabelled[1]);
    await expect(accept(unlabelled[2])).rejects.toMatchObject({ code: "correction_required" });
    expect((await repository.getAdminState(administrator)).activeSetId).toBe(activeBefore);

    const corrected = await completeSet("2", activeBefore);
    expect(corrected.third.complete).toBe(true);
    expect(corrected.third.setId).not.toBe(activeBefore);
    expect(await accept(corrected.previews[2])).toEqual(corrected.third);
    expect((await fixture.runtime.query("SELECT supersedes_set_id FROM official_usage_sets WHERE id=$1", [corrected.third.setId])).rows).toEqual([{ supersedes_set_id: activeBefore }]);
    const published = await repository.getPublished(administrator.tenantId);
    expect(published.activeSet).toMatchObject({ id: corrected.third.setId, complete: true, kinds: ["agents", "userAgents", "users"] });
    expect(published.reports).toMatchObject({
      agents: { kind: "agents", rows: [{ agentId: "agent-2" }], lineage: { rowCount: 1 } },
      userAgents: { kind: "userAgents", rows: [{ username: "User-2@example.invalid" }], lineage: { rowCount: 1 } },
      users: { kind: "users", rows: [{ username: "User-2@example.invalid" }], lineage: { rowCount: 1 } },
    });
  });

  it("makes a newly staged exact three-file duplicate idempotent", async () => {
    const beforeState = await repository.getAdminState(administrator);
    const beforeCounts = (await fixture.runtime.query<{ sets: number; versions: number; artifacts: number }>(`SELECT
      (SELECT count(*)::int FROM official_usage_sets) AS sets,
      (SELECT count(*)::int FROM official_usage_versions) AS versions,
      (SELECT count(*)::int FROM official_usage_artifacts) AS artifacts`)).rows[0];
    const bundleId = randomUUID();
    const previews = await Promise.all(["agents", "userAgents", "users"].map(kind =>
      stage(kind as "agents" | "userAgents" | "users", bundleId, { marker: "2" })));

    const accepted = await Promise.all(previews.map(preview => accept(preview)));

    expect(accepted.every(result => result.setId === beforeState.activeSetId && result.complete)).toBe(true);
    expect(await repository.getAdminState(administrator)).toMatchObject({
      activeSetId: beforeState.activeSetId,
      activeRevision: beforeState.activeRevision,
    });
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_sets) AS sets,
      (SELECT count(*)::int FROM official_usage_versions) AS versions,
      (SELECT count(*)::int FROM official_usage_artifacts) AS artifacts`)).rows[0]).toEqual(beforeCounts);
  });

  it("rejects wrong-actor, replaced and expired previews without leaking rows", async () => {
    const bundleId = randomUUID();
    const replaced = await stage("agents", bundleId);
    const current = await stage("agents", bundleId, { marker: "3" });
    await expect(accept(replaced)).rejects.toMatchObject({ code: "staging_unavailable" });
    await expect(accept(current, otherAdministrator)).rejects.toMatchObject({ code: "staging_not_found" });
    await fixture.operator.query("UPDATE official_usage_staging SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [current.id]);
    await expect(accept(current)).rejects.toMatchObject({ code: "staging_unavailable" });
    expect(await repository.cleanupExpiredStaging()).toBeGreaterThanOrEqual(1);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staged_rows WHERE staging_id IN ($1,$2)", [replaced.id, current.id])).rows[0].count).toBe(0);
  });

  it("binds an unpublished bundle to its initiating actor and fences accepted receipt retries to the original revision", async () => {
    const bundleId = randomUUID();
    const preview = await stage("agents", bundleId);
    await expect(stage("users", bundleId, { scope: otherAdministrator })).rejects.toMatchObject({ code: "bundle_owner_mismatch" });
    const accepted = await accept(preview);
    await expect(repository.accept(administrator, preview.id, {
      stagingRevision: preview.revision,
      fileHash: preview.fileHash,
      expectedActiveRevision: preview.activeRevision + 1,
    })).rejects.toMatchObject({ code: "active_revision_mismatch" });
    expect(await accept(preview)).toEqual(accepted);
  });

  it("atomically accepts a reviewed three-kind bundle and rejects an unseen companion replacement", async () => {
    const scope = { tenantId: "tenant-bundle-atomic", principalId: "administrator-bundle" };
    const bundleId = randomUUID();
    await Promise.all(["agents", "userAgents", "users"].map(kind =>
      stage(kind as "agents" | "userAgents" | "users", bundleId, { scope })));
    const stalePreview = await repository.previewBundle(scope, bundleId);
    expect(stalePreview.missingKinds).toEqual([]);
    await stage("users", bundleId, { scope, marker: "replacement" });
    await expect(repository.acceptBundle(scope, bundleId, stalePreview)).rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_versions WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);

    const reviewed = await repository.previewBundle(scope, bundleId);
    const concurrent = await Promise.all([
      repository.acceptBundle(scope, bundleId, reviewed),
      repository.acceptBundle(scope, bundleId, reviewed),
    ]);
    const accepted = concurrent[0];
    expect(concurrent[1]).toEqual(accepted);
    expect(accepted.complete).toBe(true);
    await expect(repository.acceptBundle(scope, bundleId, { ...reviewed, bundleHash: "f".repeat(64) }))
      .rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    await expect(repository.acceptBundle(scope, bundleId, { ...reviewed, expectedActiveRevision: reviewed.expectedActiveRevision + 1 }))
      .rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    await expect(repository.acceptBundle({ ...scope, principalId: "administrator-other" }, bundleId, reviewed))
      .rejects.toMatchObject({ code: "bundle_owner_mismatch" });
    await expect(repository.acceptBundle({ ...scope, tenantId: "tenant-other" }, bundleId, reviewed))
      .rejects.toMatchObject({ code: "bundle_not_found" });
    await fixture.operator.query(`UPDATE official_usage_staging SET created_at=clock_timestamp()-interval '2 days'
      WHERE tenant_id=$1 AND bundle_id=$2`, [scope.tenantId, bundleId]);
    await retain(fixture.operator);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE tenant_id=$1 AND bundle_id=$2", [scope.tenantId, bundleId])).rows[0].count).toBe(0);
    expect(await repository.acceptBundle(scope, bundleId, reviewed)).toEqual(accepted);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_bundle_receipts WHERE tenant_id=$1 AND bundle_id=$2) AS receipts,
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions`, [scope.tenantId, bundleId])).rows[0])
      .toEqual({ receipts: 1, sets: 1, versions: 3 });
    expect((await repository.getPublished(scope.tenantId)).reports).toMatchObject({ agents: {}, userAgents: {}, users: {} });

    const deletion = await repository.previewSetOperation(scope, "delete", accepted.setId);
    await repository.confirmSetOperation(scope, deletion.id, { ...deletion, operation: "delete", setId: accepted.setId });
    expect(await repository.acceptBundle(scope, bundleId, reviewed)).toEqual(accepted);
    expect(await repository.getAdminState(scope)).toMatchObject({ activeSetId: null, activeRevision: accepted.activeRevision + 1 });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_versions WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(3);
  });

  it("rejects incompatible companion basis during bundle preview", async () => {
    const scope = { tenantId: "tenant-bundle-basis", principalId: "administrator-basis" };
    const bundleId = randomUUID();
    await stage("agents", bundleId, { scope });
    await stage("userAgents", bundleId, {
      scope,
      metadata: { ...metadata, sourceAsOf: { value: "2026-07-08T12:00:01Z", provenance: "operator_asserted" } },
    });
    await stage("users", bundleId, { scope });
    await expect(repository.previewBundle(scope, bundleId)).rejects.toMatchObject({ code: "incompatible_bundle" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_versions WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
  });

  it("rolls back atomic bundle publication after one or two persisted memberships", async () => {
    await fixture.operator.query(`CREATE FUNCTION phase06_fail_bundle_membership() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE membership_count integer;
      BEGIN
        SELECT count(*) INTO membership_count FROM official_usage_set_versions WHERE set_id=NEW.set_id;
        IF (NEW.tenant_id='tenant-bundle-rollback-one' AND membership_count>=1)
          OR (NEW.tenant_id='tenant-bundle-rollback-two' AND membership_count>=2)
        THEN RAISE EXCEPTION 'phase06 local membership failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER phase06_fail_bundle_membership BEFORE INSERT ON official_usage_set_versions
        FOR EACH ROW EXECUTE FUNCTION phase06_fail_bundle_membership()`);
    try {
      for (const suffix of ["one", "two"]) {
        const scope = { tenantId: `tenant-bundle-rollback-${suffix}`, principalId: "administrator-rollback" };
        const bundleId = randomUUID();
        await Promise.all(["agents", "userAgents", "users"].map(kind =>
          stage(kind as "agents" | "userAgents" | "users", bundleId, { scope })));
        const reviewed = await repository.previewBundle(scope, bundleId);
        await expect(repository.acceptBundle(scope, bundleId, reviewed)).rejects.toThrow("phase06 local membership failure");
        expect((await fixture.runtime.query(`SELECT
          (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
          (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
          (SELECT count(*)::int FROM official_usage_artifacts WHERE tenant_id=$1) AS artifacts,
          (SELECT count(*)::int FROM official_usage_bundle_receipts WHERE tenant_id=$1) AS receipts`, [scope.tenantId])).rows[0])
          .toEqual({ sets: 0, versions: 0, artifacts: 0, receipts: 0 });
        expect(await repository.getAdminState(scope)).toMatchObject({ activeSetId: null, activeRevision: 1 });
      }
    } finally {
      await fixture.operator.query("DROP TRIGGER phase06_fail_bundle_membership ON official_usage_set_versions; DROP FUNCTION phase06_fail_bundle_membership()");
    }
  });

  it("resumes an actor-owned incomplete retained set with missing companions", async () => {
    const scope = { tenantId: "tenant-bundle-resume", principalId: "administrator-resume" };
    const bundleId = randomUUID();
    await accept(await stage("agents", bundleId, { scope }), scope);
    await stage("userAgents", bundleId, { scope });
    await stage("users", bundleId, { scope });
    const reviewed = await repository.previewBundle(scope, bundleId);
    expect(reviewed.acceptedVersions.map(version => version.kind)).toEqual(["agents"]);
    expect(reviewed.missingKinds).toEqual([]);
    expect((await repository.acceptBundle(scope, bundleId, reviewed)).complete).toBe(true);
  });

  it("revision-fences concurrent selection and delete confirmations and never falls back after active deletion", async () => {
    const scope = { tenantId: "tenant-selection-race", principalId: "administrator-selection" };
    const firstBundleId = randomUUID();
    await Promise.all(["agents", "userAgents", "users"].map(kind =>
      stage(kind as "agents" | "userAgents" | "users", firstBundleId, { scope, marker: "selection-1" })));
    const prior = await repository.acceptBundle(scope, firstBundleId, await repository.previewBundle(scope, firstBundleId));
    const secondBundleId = randomUUID();
    await Promise.all(["agents", "userAgents", "users"].map(kind =>
      stage(kind as "agents" | "userAgents" | "users", secondBundleId, { scope, marker: "selection-2", correctionOfSetId: prior.setId })));
    const active = await repository.acceptBundle(scope, secondBundleId, await repository.previewBundle(scope, secondBundleId));
    const selectPreview = await repository.previewSetOperation(scope, "select", prior.setId);
    const deletePreview = await repository.previewSetOperation(scope, "delete", active.setId);
    const [selected, deleted] = await Promise.allSettled([
      repository.confirmSetOperation(scope, selectPreview.id, { ...selectPreview, operation: "select", setId: prior.setId }),
      repository.confirmSetOperation(scope, deletePreview.id, { ...deletePreview, operation: "delete", setId: active.setId }),
    ]);
    expect([selected.status, deleted.status].sort()).toEqual(["fulfilled", "rejected"]);

    const state = await repository.getAdminState(scope);
    if (selected.status === "fulfilled") {
      expect(state.activeSetId).toBe(prior.setId);
      const finalDeletePreview = await repository.previewSetOperation(scope, "delete", prior.setId);
      const afterDelete = await repository.confirmSetOperation(scope, finalDeletePreview.id, { ...finalDeletePreview, operation: "delete", setId: prior.setId });
      expect(afterDelete.activeSetId).toBeNull();
      expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows row JOIN official_usage_set_versions membership ON membership.version_id=row.version_id WHERE membership.set_id=$1", [prior.setId])).rows[0].count).toBe(0);
    } else {
      expect(state.activeSetId).toBeNull();
      expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows row JOIN official_usage_set_versions membership ON membership.version_id=row.version_id WHERE membership.set_id=$1", [active.setId])).rows[0].count).toBe(0);
      expect(state.sets.find(reportSet => reportSet.id === prior.setId)?.deletedAt).toBeNull();
    }
  });

  it("applies finite retention and keeps runtime from mutating immutable accepted content", async () => {
    const version = (await fixture.runtime.query<{ id: string; tenant_id: string; kind: string }>(`SELECT version.id,version.tenant_id,version.kind
      FROM official_usage_versions version JOIN official_usage_set_versions membership ON membership.version_id=version.id
      WHERE version.deleted_at IS NULL LIMIT 1`)).rows[0];
    if (version) {
      await expect(fixture.runtime.query("UPDATE official_usage_versions SET row_count=row_count+1 WHERE id=$1", [version.id])).rejects.toThrow("immutable");
      await expect(fixture.runtime.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,row_data)
        VALUES($1,$2,$3,49999,'{}')`, [version.id, version.tenant_id, version.kind])).rejects.toThrow("published or deleted");
    }
    await fixture.operator.query("UPDATE official_usage_staging SET expires_at=clock_timestamp()-interval '1 second' WHERE status='active'");
    await retain(fixture.operator);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staged_rows")).rows[0].count).toBe(0);
  });

  it("retains populated accepted content after day-one staging expiry and removes content independently at 180 days", async () => {
    const scope = { tenantId: "tenant-retention", principalId: "administrator-retention" };
    const bundleId = randomUUID();
    const previews = await Promise.all(["agents", "userAgents", "users"].map(kind =>
      stage(kind as "agents" | "userAgents" | "users", bundleId, { scope, metadata })));
    for (const preview of previews) await accept(preview, scope);
    const published = await repository.getPublished(scope.tenantId);
    expect(published.activeSet).not.toBeNull();
    expect(Object.keys(published.reports).sort()).toEqual(["agents", "userAgents", "users"]);

    await fixture.operator.query(`UPDATE official_usage_staging SET created_at=clock_timestamp()-interval '2 days'
      WHERE tenant_id=$1 AND status='accepted'`, [scope.tenantId]);
    await retain(fixture.operator);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_staging WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
    expect((await repository.getPublished(scope.tenantId)).reports.agents?.rows).toHaveLength(1);

    await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [scope.tenantId]);
    await fixture.operator.query("UPDATE official_usage_versions SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [scope.tenantId]);
    await fixture.operator.query("UPDATE official_usage_artifacts SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [scope.tenantId]);
    await fixture.operator.query(`INSERT INTO official_usage_sets
      (id,tenant_id,bundle_id,reporting_start,reporting_end,complete,accepted_at,deleted_at,expires_at,actor_principal_id)
      SELECT gen_random_uuid(),$1,gen_random_uuid(),'2026-01-01','2026-01-31',true,clock_timestamp(),clock_timestamp(),
        clock_timestamp()-interval '1 second','retention-terminal'
      FROM generate_series(1,5001)`, [scope.tenantId]);
    const firstPreview=await retain(fixture.operator,{batchSize:5000,dryRun:true});
    const secondPreview=await retain(fixture.operator,{batchSize:5000,dryRun:true});
    expect(firstPreview.affected.officialSetsExpired).toBe(1);
    expect(secondPreview.affected.officialSetsExpired).toBe(1);
    const convergence=await retainUntilConverged(fixture.operator,{batchSize:5000});
    expect(convergence.affected.officialSetsExpired).toBe(1);
    expect(convergence.passes).toBeGreaterThan(1);
    expect(Object.values((await retain(fixture.operator,{batchSize:5000})).affected).every(count=>count===0)).toBe(true);
    const afterContentExpiry = await repository.getPublished(scope.tenantId);
    expect(afterContentExpiry.activeSet).toBeNull();
    expect(afterContentExpiry.hasImportHistory).toBe(true);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
    await fixture.operator.query("DELETE FROM official_usage_sets WHERE tenant_id=$1 AND actor_principal_id='retention-terminal'", [scope.tenantId]);

    await fixture.operator.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1", [scope.tenantId]);
    await fixture.operator.query("UPDATE official_usage_versions SET deleted_at=clock_timestamp()-interval '91 days' WHERE tenant_id=$1", [scope.tenantId]);
    await fixture.operator.query("UPDATE official_usage_audit SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [scope.tenantId]);
    await retain(fixture.operator);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
      (SELECT count(*)::int FROM official_usage_artifacts WHERE tenant_id=$1) AS artifacts`, [scope.tenantId])).rows[0])
      .toEqual({ sets: 0, versions: 0, artifacts: 0 });
  });

  it("records legacy cleanup acknowledgement without receiving legacy report content", async () => {
    await repository.acknowledgeLegacyCleanup(administrator);
    expect((await fixture.runtime.query("SELECT action,row_count,target_kind FROM official_usage_audit WHERE action='legacy_cleanup_acknowledged'")).rows).toEqual([
      { action: "legacy_cleanup_acknowledged", row_count: null, target_kind: null },
    ]);
  });
});