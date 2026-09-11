import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { bootstrap, grantRuntime, migrate, retain } from "../../scripts/database.js";
import type { AuthenticatedUser } from "../types/session.js";
import { runBulkJob } from "../services/bulkJobs.js";
import { GraphPackagesClient } from "../services/graphPackages.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { assessCanaryRestoration, PackageMutationQualificationRepository } from "./packageMutationQualifications.js";
import { migrations, verifySchema } from "./schema.js";
import { transaction } from "./pool.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let qualifications: PackageMutationQualificationRepository;
let jobs: JobRepository;
const administrator: AuthenticatedUser = { homeAccountId: "admin-1", tenantId: "tenant-1", displayName: "Administrator", username: "admin@example.invalid", roles: ["AgentControl.Administrator"] };
const operator: AuthenticatedUser = { homeAccountId: "operator-1", tenantId: "tenant-1", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Operator"] };
const prestate = { kind: "block" as const, isBlocked: false };
const poststate = { kind: "block" as const, isBlocked: true };

beforeAll(async () => {
  fixture = await testDatabase(false);
  await bootstrap(fixture.operator, fixturePassword);
  await migrate(fixture.operator, migrations.slice(0, 11));
  await grantRuntime(fixture.operator);
  qualifications = new PackageMutationQualificationRepository(fixture.runtime);
  jobs = new JobRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

describe("Package mutation qualifications", () => {
  it("requires separate approvals and durable verification of both exact directions", async () => {
    await expect(qualifications.createApproved({ ...administrator, roles: ["AgentControl.Operator"] }, qualificationInput())).rejects.toMatchObject({ code: "missing_internal_role" });
    const approvals = await createApprovals("package-1");
    expect(approvals.original).toMatchObject({ status: "approved", action: "block", workflowVersion: 3, actorPrincipalId: null, approvedByPrincipalId: "admin-1" });
    await expect(qualifications.claimCycle({ ...operator, homeAccountId: "admin-1" }, approvals.original.id, approvals.restoration.id, identity(), identity())).rejects.toMatchObject({ code: "separate_approval_required" });
    const claimed = await qualifications.claimCycle(operator, approvals.original.id, approvals.restoration.id, identity(), identity());
    expect(claimed).toMatchObject({
      original: { status: "restoring", action: "block", cycleStage: "original", actorPrincipalId: "operator-1", pairedQualificationId: approvals.restoration.id },
      restoration: { status: "restoring", action: "unblock", cycleStage: "restoration", actorPrincipalId: "operator-1", pairedQualificationId: approvals.original.id },
    });
    await expect(qualifications.completeCycle(operator, approvals.original.id, approvals.restoration.id, { status: "qualified" }, identity(), identity())).rejects.toMatchObject({ code: "canary_cycle_unverified" });
    const recorded = await executeClaimedCycle(claimed);
    expect(recorded).toMatchObject({ original: { status: "qualified", action: "block" }, restoration: { status: "qualified", action: "unblock" } });
    expect(await qualifications.current("tenant-1", "block", "a".repeat(64), 7)).toMatchObject({ id: recorded.original.id });
    expect(await qualifications.current("tenant-1", "unblock", "a".repeat(64), 7)).toMatchObject({ id: recorded.restoration.id });
    expect(await qualifications.current("tenant-1", "block", "b".repeat(64), 7)).toBeUndefined();
    expect(await qualifications.current("tenant-1", "block", "a".repeat(64), 8)).toBeUndefined();
    expect(await qualifications.current("tenant-2", "block", "a".repeat(64), 7)).toBeUndefined();
  });

  it("atomically supersedes the current record for the same deployed contract", async () => {
    const approvals = await createApprovals("package-2");
    const replacement = await executeClaimedCycle(await qualifications.claimCycle(operator, approvals.original.id, approvals.restoration.id, identity(), identity()));
    expect(await qualifications.current("tenant-1", "block", "a".repeat(64), 7)).toMatchObject({ id: replacement.original.id, targetId: "package-2" });
    const records = (await qualifications.list(administrator)).value.filter(record => record.action === "block");
    expect(records.filter(record => record.status === "qualified")).toHaveLength(1);
    expect(records.filter(record => record.status === "expired")).toHaveLength(1);
  });

  it("rejects no-op, action-mismatched, and unknown state fields", async () => {
    await expect(qualifications.createApproved(administrator, { ...qualificationInput(), targetId: "noop", poststate: prestate })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    await expect(qualifications.createApproved(administrator, { ...qualificationInput(), targetId: "wrong-action", action: "unblock" })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    await expect(qualifications.createApproved(administrator, { ...qualificationInput(), targetId: "raw-json", prestate: { ...prestate, arbitraryMetadata: { secret: true } } })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    await expect(qualifications.createApproved(administrator, {
      ...qualificationInput(), targetId: "array-scalar", action: "update-availability",
      prestate: { kind: "access", availableTo: ["none"], deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] },
      poststate: { kind: "access", availableTo: "some", deployedTo: "none", allowedUsersAndGroups: [{ resourceType: "user", resourceId: "12345678-1234-1234-1234-123456789abc" }], acquireUsersAndGroups: [] },
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
  });

  it("restores only touched fields and stops on an intervening external change", () => {
    expect(assessCanaryRestoration(prestate, poststate, poststate)).toEqual({ status: "restore", touchedFields: { isBlocked: false } });
    expect(assessCanaryRestoration(prestate, poststate, prestate)).toEqual({ status: "already_restored" });
    expect(assessCanaryRestoration(prestate, poststate, { kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] })).toMatchObject({ status: "conflict" });
  });

  it("qualifies an access target only when the other target is preserved", async () => {
    const accessPrestate = { kind: "access" as const, availableTo: "none" as const, deployedTo: "some" as const, allowedUsersAndGroups: [], acquireUsersAndGroups: [{ resourceType: "group", resourceId: "11111111-1111-4111-8111-111111111111" }] };
    const accessPoststate = { ...accessPrestate, availableTo: "some" as const, allowedUsersAndGroups: [{ resourceType: "user", resourceId: "22222222-2222-4222-8222-222222222222" }] };
    await expect(qualifications.createApproved(administrator, {
      ...qualificationInput(), action: "update-availability", prestate: accessPrestate, poststate: accessPoststate,
    })).resolves.toMatchObject({ action: "update-availability", status: "approved", restorationCriteria: { touchedFields: ["allowedUsersAndGroups"] } });
    await expect(qualifications.createApproved(administrator, {
      ...qualificationInput(), targetId: "opaque-entra-object-id", action: "update-availability", prestate: accessPrestate,
      poststate: { ...accessPoststate, allowedUsersAndGroups: [{ resourceType: "user", resourceId: "12345678-1234-1234-1234-123456789abc" }] },
    })).resolves.toMatchObject({ status: "approved" });
    await expect(qualifications.createApproved(administrator, {
      ...qualificationInput(), action: "update-availability", prestate: accessPrestate,
      poststate: { ...accessPoststate, deployedTo: "none", acquireUsersAndGroups: [] },
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
  });

  it("invalidates an approved intent when its contract or configuration changes", async () => {
    const approvals = await createApprovals("invalidated");
    await expect(qualifications.claimCycle(operator, approvals.original.id, approvals.restoration.id, { ...identity(), configurationRevision: 8 }, identity())).rejects.toMatchObject({ code: "qualification_invalidated" });
    expect((await qualifications.list(administrator)).value.filter(record => record.id === approvals.original.id || record.id === approvals.restoration.id)).toEqual([
      expect.objectContaining({ status: "expired" }), expect.objectContaining({ status: "expired" }),
    ]);
  });

  it("marks an interrupted claimed cycle inconclusive and never activates it", async () => {
    const approvals = await createApprovals("interrupted");
    await qualifications.claimCycle(operator, approvals.original.id, approvals.restoration.id, identity(), identity());
    expect(await qualifications.recoverInterrupted("tenant-1")).toBe(2);
    const records = (await qualifications.list(administrator)).value.filter(record => record.id === approvals.original.id || record.id === approvals.restoration.id);
    expect(records).toEqual([
      expect.objectContaining({ status: "inconclusive", errorCode: "process_interrupted" }),
      expect.objectContaining({ status: "inconclusive", errorCode: "process_interrupted" }),
    ]);
    expect(await qualifications.current("tenant-1", "block", "a".repeat(64), 7)).not.toMatchObject({ targetId: "interrupted" });
  });

  it("retains verified evidence independently of jobs and expires the inverse pair atomically", async () => {
    const approvals = await createApprovals("retained-cycle");
    const completed = await executeClaimedCycle(await qualifications.claimCycle(operator, approvals.original.id, approvals.restoration.id, identity(), identity()));
    const jobIds = [completed.original.jobId, completed.restoration.jobId];
    await migrate(fixture.operator);
    await verifySchema(fixture.runtime);
    await transaction(fixture.operator, async client => {
      await client.query("ALTER TABLE jobs DISABLE TRIGGER USER");
      await client.query(`UPDATE jobs SET created_at=clock_timestamp()-interval '8 days',deadline_at=clock_timestamp()-interval '7 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=ANY($1::uuid[])`, [jobIds]);
      await client.query("ALTER TABLE jobs ENABLE TRIGGER USER");
    });
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT id FROM jobs WHERE id=ANY($1::uuid[])", [jobIds])).rows).toEqual([]);
    expect(await qualifications.current("tenant-1", "block", "a".repeat(64), 7)).toMatchObject({ id: completed.original.id, jobId: completed.original.jobId });
    expect(await qualifications.current("tenant-1", "unblock", "a".repeat(64), 7)).toMatchObject({ id: completed.restoration.id });
    await migrate(fixture.operator);
    await fixture.operator.query(`UPDATE package_mutation_qualifications SET qualified_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [completed.original.id]);
    await expect(fixture.runtime.query("DELETE FROM package_mutation_qualifications WHERE id=$1", [completed.original.id])).rejects.toThrow();
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT id FROM package_mutation_qualifications WHERE id=ANY($1::uuid[])", [[completed.original.id, completed.restoration.id]])).rows).toEqual([]);
  });
});

function qualificationInput() {
  return { targetId: "package-1", action: "block" as const, contractRevision: "a".repeat(64), configurationRevision: 7, prestate, poststate };
}

function identity() { return { contractRevision: "a".repeat(64), configurationRevision: 7, authMode: "delegated" as const }; }

async function createApprovals(targetId: string) {
  const original = await qualifications.createApproved(administrator, { ...qualificationInput(), targetId });
  const restoration = await qualifications.createApproved(administrator, { ...qualificationInput(), targetId, action: "unblock", prestate: poststate, poststate: prestate });
  return { original, restoration };
}

async function executeClaimedCycle(claimed: Awaited<ReturnType<PackageMutationQualificationRepository["claimCycle"]>>) {
  let blocked = false;
  const provider = new GraphPackagesClient(async (url, request) => {
    if (request?.method === "POST") {
      blocked = new URL(url).pathname.endsWith("/block");
      return new Response(null, { status: 204 });
    }
    return Response.json({ id: claimed.original.targetId, displayName: "Canary", isBlocked: blocked });
  });
  for (const approval of [claimed.original, claimed.restoration]) {
    const intent: JobIntentInput = {
      action: approval.action,
      targets: [{ id: approval.targetId, displayName: "Canary", prestate: approval.prestate }],
      actor: operator,
      requestPath: `/fixture/canary/${approval.cycleStage}`,
      scope: "single",
    };
    const job = await jobs.submit({ tenantId: "tenant-1", principalId: "operator-1" }, { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash });
    await qualifications.recordCycleJob(operator, approval.id, job.id);
    await runBulkJob(job.id, { tenantId: "tenant-1", principalId: "operator-1" }, false, jobs, provider, async () => "ephemeral-token");
    expect(await jobs.get(job.id, { tenantId: "tenant-1", principalId: "operator-1" })).toMatchObject({ status: "succeeded", succeeded: 1 });
  }
  return qualifications.completeCycle(operator, claimed.original.id, claimed.restoration.id, { status: "qualified" }, identity(), identity());
}