import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { lifecycleEvidence, withCollectorClock, withQueries } from "../../scripts/lifecycleEvidence.js";
import { retain, retainUntilConverged } from "../../scripts/database.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { DataGenerations } from "./dataGenerations.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let evidence: Awaited<ReturnType<typeof lifecycleEvidence>>;
beforeAll(async () => { fixture = await testDatabase(); evidence = await lifecycleEvidence(fixture.operator); });
afterAll(async () => { await fixture?.close(); });
const identity = () => ({ ...selectionIdentity, tenantId: `repair-${randomUUID()}` });
async function stage(owner: ReturnType<typeof identity>, rows: number) {
  async function* csv() {
    yield Buffer.from(`${schemaRegistry.users.headers.join(",")}\n`);
    for (let n = 0; n < rows; n++) yield Buffer.from(`user-${n}@example.invalid,User ${n},1,4,2026-07-06\n`);
  }
  return new OfficialReportImports(fixture.runtime).stage(owner, { bundleId: randomUUID() }, csv(), {
    reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
    sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
  });
}
function accept(owner: ReturnType<typeof identity>, preview: Awaited<ReturnType<typeof stage>>) {
  return new OfficialReportImports(fixture.runtime).accept(owner, {
    stagingId: preview.id, revision: preview.revision, contentHash: preview.contentHash, expectedActiveRevision: preview.activeRevision,
  });
}
async function physical(owner: ReturnType<typeof identity>) {
  return (await fixture.operator.query(`SELECT
    (SELECT count(*)::int FROM official_usage_staged_rows WHERE tenant_id=$1) AS staged,
    (SELECT count(*)::int FROM official_usage_ingestion_rows WHERE tenant_id=$1) AS ingested,
    (SELECT count(*)::int FROM official_usage_ingestions WHERE tenant_id=$1) AS ingestions,
    (SELECT coalesce(sum(stored_bytes),0)::text FROM official_usage_ingestions WHERE tenant_id=$1) AS reserved,
    (SELECT count(*)::int FROM official_usage_staging WHERE tenant_id=$1) AS staging,
    (SELECT coalesce(sum(row_count),0)::int FROM official_usage_versions WHERE tenant_id=$1 AND deleted_at IS NULL) AS quota,
    (SELECT count(*)::int FROM official_usage_version_rows WHERE tenant_id=$1) AS rows,
    (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts`, [owner.tenantId])).rows[0];
}
async function complete(owner: ReturnType<typeof identity>) {
  const imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
  for (const kind of ["users", "agents", "userAgents"] as const) {
    async function* csv() {
      yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n`);
      yield Buffer.from(kind === "users" ? "user-0@example.invalid,User 0,1,4,2026-07-06\n"
        : kind === "agents" ? "agent,Agent,Your org,1,0,4,2026-07-06\n"
          : "agent,Agent,Your org,user-0@example.invalid,4,2026-07-06\n");
    }
    await imports.stage(owner, { bundleId }, csv(), {
      reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
      sourceAsOf: { value: "2026-07-08T12:00:00Z", provenance: "operator_asserted" },
    });
  }
  return imports.acceptBundle(owner, bundleId, await imports.bundle(owner, bundleId));
}

it("acceptance repair: accepted staging drains child-first within every physical transaction and releases its reservation", async () => {
  const owner = identity(), peer = identity();
  const preview = await stage(owner, 5025);
  await accept(owner, preview);
  const published = await complete(peer);
  expect(published.complete).toBe(true);
  const history = () => fixture.runtime.query(`SELECT row_to_json(s) AS state,
    (SELECT jsonb_agg(h ORDER BY h.set_id,h.valid_from_revision) FROM official_usage_history_memberships h WHERE h.tenant_id=s.tenant_id) AS history
    FROM official_usage_state s WHERE tenant_id=$1`, [peer.tenantId]);
  const protectedHistory = (await history()).rows;
  const before = await physical(owner), peerBefore = await physical(peer);
  expect(before.staged).toBe(5000);
  expect(Number(before.reserved)).toBeGreaterThan(0);
  await evidence.reset();
  let slices = 0, remaining = before;
  await withCollectorClock(fixture.operator, 2, async () => {
    for (; slices < 120 && remaining.staging; slices++) {
      // A new operator invocation uses the persisted shared cursor each time.
      const started = performance.now();
      await retain(fixture.operator);
      expect(performance.now() - started).toBeLessThan(5000);
      await evidence.check();
      remaining = await physical(owner);
      if (remaining.staged || remaining.ingested) {
        expect(remaining.ingestions).toBe(1);
        expect(Number(remaining.reserved)).toBeGreaterThan(0);
      }
    }
  });
  expect(slices).toBeGreaterThan(5);
  expect(remaining).toMatchObject({ staged: 0, ingested: 0, ingestions: 0, reserved: "0", staging: 0,
    quota: 5025, rows: 5025, facts: 5025 });
  expect(await physical(peer)).toMatchObject({ quota: peerBefore.quota, rows: peerBefore.rows, facts: peerBefore.facts });
  expect((await history()).rows).toEqual(protectedHistory);
  await evidence.report("accepted-staging");
});

it("acceptance repair: interrupted committed copies remain leased, then lose provenance without leaking payload or quota", async () => {
  const owner = identity(), imports = new OfficialReportImports(fixture.runtime);
  await accept(owner, await stage(owner, 1));
  const published = await physical(owner), preview = await stage(owner, 150);
  let copied = false, entered!: () => void, stop!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const interrupted = new Promise<void>(resolve => { stop = resolve; });
  const accepting = withQueries(fixture.runtime, async (text, values) => {
    if (text.includes("INSERT INTO official_usage_version_rows")) {
      if (Number(values[3]) >= 50) {
        entered();
        await interrupted;
        throw new Error("fixture_process_interruption_after_committed_copy");
      }
      copied = true;
    }
    return text;
  }, () => accept(owner, preview));
  const failure = expect(accepting).rejects.toThrow("fixture_process_interruption");
  await paused;
  try {
    const live = (await fixture.runtime.query(`SELECT state,lease_until>clock_timestamp() AS live,version_id
      FROM official_usage_ingestions WHERE staging_id=$1`, [preview.id])).rows[0];
    expect(live).toMatchObject({ state: "accepting", live: true });
    await retainUntilConverged(fixture.operator);
    expect((await fixture.runtime.query("SELECT deleted_at FROM official_usage_versions WHERE id=$1", [live.version_id])).rows[0].deleted_at).toBeNull();
  } finally { stop(); await failure; }
  expect(copied).toBe(true);
  const ingestion = (await fixture.operator.query("SELECT id,version_id FROM official_usage_ingestions WHERE staging_id=$1", [preview.id])).rows[0];
  expect((await physical(owner)).rows).toBe(published.rows + 50);
  // The failed attempt returns to ready with a valid immutable expiry, so cleanup must not retire it.
  await retainUntilConverged(fixture.operator);
  expect((await fixture.runtime.query("SELECT deleted_at FROM official_usage_versions WHERE id=$1", [ingestion.version_id])).rows[0].deleted_at).toBeNull();
  await evidence.reset();
  await withCollectorClock(fixture.operator, 2, async () => {
    for (let n = 0; n < 30 && (await physical(owner)).ingestions; n++) {
      await retain(fixture.operator);
      await evidence.check();
    }
  });
  expect((await physical(owner)).ingestions).toBe(0);
  await expect(accept(owner, preview)).rejects.toMatchObject({ code: "staging_unavailable" });
  await retainUntilConverged(fixture.operator);
  await evidence.check();
  expect(await physical(owner)).toMatchObject({ quota: published.quota, rows: published.rows, facts: published.facts,
    staged: 0, ingested: 0, ingestions: 0, reserved: "0", staging: 0 });
  expect((await fixture.runtime.query("SELECT deleted_at IS NOT NULL AS retired FROM official_usage_versions WHERE id=$1", [ingestion.version_id])).rows[0].retired).toBe(true);
  expect(await imports.sweep(owner.tenantId)).toBe(0);
  await evidence.report("interrupted-report");
});

it.each([false, true])("acceptance repair: wide legal access confirmations charge repeated parent revisions (attempts=%s)", async attempts => {
  const owner = identity(), jobs = new JobRepository(fixture.runtime);
  const principals = Array.from({ length: 8 }, () => ({ resourceType: "user" as const, resourceId: randomUUID() }));
  const intent: JobIntentInput = {
    action: "update-availability", scope: "bulk", requestPath: "/api/agents/access",
    actor: { tenantId: owner.tenantId, homeAccountId: owner.principalId, displayName: "Fixture", username: "fixture@example.invalid" },
    targets: Array.from({ length: 64 }, (_, n) => ({ id: `access-${n}`, displayName: `Access ${n}`,
      prestate: { kind: "access", availableTo: "some", deployedTo: "none", allowedUsersAndGroups: principals, acquireUsersAndGroups: [] } })),
    accessUpdate: { target: "availability", mode: "replace", scope: "specific", principals },
  };
  const confirmation = createJobConfirmation(intent);
  expect(Buffer.byteLength(JSON.stringify(confirmation.summary))).toBeGreaterThan(30000);
  const job = await jobs.submit(owner, { ...intent, idempotencyKey: randomUUID(), confirmationHash: confirmation.confirmationHash });
  await new DataGenerations(fixture.runtime).sessionEpoch(owner.tenantId, owner.principalId);
  if (attempts) {
    const lease = (await jobs.claim(job.id, owner, randomUUID()))!;
    for (let n = 0; n < 64; n++) {
      const item = (await jobs.beginItem(lease))!.item;
      if (n < 4) await jobs.markSent(lease, item.id, item.prestate_hash);
    }
    await fixture.operator.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  } else await fixture.operator.query("UPDATE jobs SET attempts=10 WHERE id=$1", [job.id]);
  const before = (await jobs.get(job.id, owner))!;
  const page = await jobs.items(job.id, owner, { limit: 1 });
  expect(page.page.nextCursor).toBeTruthy();
  const frozen = async () => (await fixture.runtime.query(`SELECT ordinal,target_id,prestate_hash,prestate,
    source_generation_id,source_identity,agent_id,authority_expires_at
    FROM job_items WHERE job_id=$1 ORDER BY ordinal`, [job.id])).rows;
  const authority = await frozen();
  await evidence.reset();
  let slices = 0;
  for (; slices < 64; slices++) {
    if (!await new JobRepository(fixture.runtime).recover(owner.tenantId, false, job.id)) break;
    await evidence.check();
  }
  const after = (await jobs.get(job.id, owner))!;
  expect(after).toMatchObject({ ...(attempts ? { status: "partial", inconclusive: 4, queued: 60, canResume: true }
    : { status: "failed", failed: 64, canResume: false }), confirmationHash: before.confirmationHash });
  expect(BigInt(after.resultRevision)).toBeGreaterThan(BigInt(before.resultRevision));
  await expect(jobs.items(job.id, owner, { limit: 1, cursor: page.page.nextCursor!, revision: page.revision }))
    .rejects.toMatchObject({ code: "selection_invalidated" });
  expect(await frozen()).toEqual(authority);
  expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM job_attempts WHERE job_id=$1", [job.id])).rows[0].n).toBe(attempts ? 64 : 0);
  if (attempts) expect((await fixture.runtime.query(`SELECT outcome,count(*)::int AS n FROM job_attempts
    WHERE job_id=$1 AND finished_at IS NOT NULL GROUP BY outcome ORDER BY outcome`, [job.id])).rows)
    .toEqual([{ outcome: "cancelled", n: 60 }, { outcome: "inconclusive", n: 4 }]);
  expect(slices).toBeGreaterThan(1);
  expect(slices).toBeLessThan(64);
  await evidence.report(`package-recovery-attempts-${attempts}`);
});
