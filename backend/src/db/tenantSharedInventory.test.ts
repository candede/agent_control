import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { fixtureDirectoryUser, publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture, streamedPackageFixture } from "../../scripts/inventoryFixtures.js";
import { DataGenerations } from "./dataGenerations.js";
import { UserSourceStages } from "./userSourceStages.js";
import type { ActivityRecord } from "./dataGenerations.js";
import { DataSyncRepository } from "./dataSync.js";
import { UserSourcesRepository } from "./userSources.js";
import { DataSyncService } from "../services/dataSync.js";
import { CopilotUsageService } from "../services/copilotUsage.js";
import { AppError } from "../errors.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import type { AuthenticatedUser } from "../types/session.js";

vi.hoisted(() => { process.env.SESSION_SECRET = "synthetic-tenant-shared-inventory-secret"; });
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

function actors() {
  const tenantId = randomUUID();
  const actor = (role: "AgentControl.Viewer" | "AgentControl.Admin"): AuthenticatedUser => ({
    tenantId, homeAccountId: randomUUID(), displayName: role, username: `${randomUUID()}@example.invalid`, roles: [role],
  });
  return { tenantId, a: actor("AgentControl.Admin"), b: actor("AgentControl.Viewer"), c: actor("AgentControl.Admin") };
}
const scope = (user: AuthenticatedUser) => ({ tenantId: user.tenantId!, principalId: user.homeAccountId });
const identity = (user: AuthenticatedUser) => ({ ...selectionIdentity, ...scope(user) });

async function seed(user: AuthenticatedUser) {
  await publishFixtureDirectory(fixture.runtime, identity(user), [fixtureDirectoryUser(randomUUID())]);
  await publishFixtureEmptyActivity(fixture.runtime, identity(user));
  await streamedPackageFixture(fixture.runtime, scope(user), [allowlistedPackage({ id: "shared-package", displayName: "Shared package", isBlocked: false })]);
  await nativeInventoryFixture(fixture.runtime, scope(user), [], { resourceTypes: [...powerPlatformResourceTypes] });
  await reconcileInventoryFixture(fixture.runtime, scope(user));
  const sync = new DataSyncRepository(fixture.runtime);
  for (const source of ["users", "graph_packages", "power_platform"] as const) {
    await sync.recordSuccessMarker(scope(user), source, 1, new Date().toISOString());
  }
}

describe("tenant-owned saved inventory and actor-owned collection authority", () => {
  it("preserves unseen directory plans and stale activity after a successful narrower collector replaces the shared roots", async () => {
    const { a, b, c } = actors(), first = randomUUID(), unseen = randomUUID();
    const plan = { servicePlanId: "c1ec4a95-1f05-45b3-a911-aa3fa01094f5", service: "M365_COPILOT_APPS" as const,
      displayName: "Copilot", state: "enabled" as const, capabilityStatus: "Enabled" as const, assignedDateTime: null };
    const users = [first, unseen].map(id => ({ ...fixtureDirectoryUser(id, id, `${id}@example.invalid`),
      copilotServiceState: "enabled" as const, servicePlans: [plan] }));
    const old = new Date(Date.now() - 10 * 86_400_000), oldDate = old.toISOString().slice(0, 10);
    const directory = await publishFixtureDirectory(fixture.runtime, identity(a), users, { observedAt: old });
    const stages = new UserSourceStages(fixture.runtime);
    const activity = async (actor: AuthenticatedUser, ids: string[], date: string) => {
      const input = generationInput({ ...{ actorPrincipalId: actor.homeAccountId }, observedAt: date === oldDate ? old : new Date(),
        scope: { tenantId: actor.tenantId!, principalId: null, kind: "tenant", tokenMode: "tenant", source: "app_activity", selector: "complete" } });
      return stages.execute(input, async lease => {
        const key = await stages.query(lease, "activity", "synthetic:limited-activity");
        await stages.page(lease, key, "synthetic:limited-activity", ids.length, ids.length);
        const rows: ActivityRecord[] = ids.map((id, index) => ({ identity: `ordinal-${index + (ids.length === 1 ? 1 : 0)}`, upn_key: id,
          report_refresh_date: date, last_activity_date: date, chat_date: null, teams_date: null, word_date: null, excel_date: null,
          powerpoint_date: null, outlook_date: null, onenote_date: null, loop_date: null, period: "D28", residual: {} }));
        await stages.activity(lease, key, rows);
        await stages.finishQuery(lease, key);
      }, { beforePublish: async () => {} });
    };
    const originalActivity = await activity(a, [first, unseen], oldDate);
    const replacement = await publishFixtureDirectory(fixture.runtime, identity(c), [{ ...users[0],
      identity: { ...users[0].identity, displayName: "Updated by C" } }]);
    const replacedActivity = await activity(c, [first], new Date().toISOString().slice(0, 10));
    expect(replacement.scopeId).toBe(directory.scopeId);
    expect(replacedActivity.scopeId).toBe(originalActivity.scopeId);
    const sources = new UserSourcesRepository(fixture.runtime, "synthetic-limited-shared-source-cursor-secret");
    const selected = await sources.capture(identity(b));
    const page = await sources.page(selected.id, identity(b));
    expect(page.value).toHaveLength(2);
    expect(page.value.find(row => row.directory.objectId === first)).toMatchObject({
      directory: { displayName: "Updated by C" }, activityState: "active", servicePlanCount: 1 });
    expect(page.value.find(row => row.directory.objectId === unseen)).toMatchObject({
      activityState: "unknown", appActivity: { reportRefreshDate: oldDate }, servicePlanCount: 1 });
    expect(page.sources.directory.state).toBe("partial");
    expect(page.sources.app_activity.state).toBe("partial");
    const provenance = await fixture.runtime.query(`SELECT residual->>'retainedObservedAt' AS observed_at,
      residual->>'retainedCollectorPrincipalId' AS principal_id FROM directory_user_rows WHERE generation_id=$1 AND identity=$2`,
    [replacement.generationId, unseen]);
    expect(provenance.rows).toEqual([{ observed_at: old.toISOString(), principal_id: a.homeAccountId }]);
    expect(await sources.people(selected.id, identity(b), [unseen])).toMatchObject([{ objectId: unseen, observedAt: old.toISOString() }]);
  });

  it("lets a provider-denied Viewer read A's data and C refresh the same roots without personal onboarding", async () => {
    const { tenantId, a, b, c } = actors();
    await seed(a);
    const sources = new UserSourcesRepository(fixture.runtime, "synthetic-shared-source-cursor-secret");
    const selected = await sources.capture(identity(b));
    expect((await sources.page(selected.id, identity(b))).value).toHaveLength(1);
    const inventory = await inventorySelectionFixture(fixture.runtime, scope(b));
    expect(inventory.raw.counts.total).toBe(1);
    expect(await new DataSyncService(fixture.runtime).state(b)).toMatchObject({ onboardingRequired: false, run: null });
    expect(await new DataSyncRepository(fixture.runtime).submitDue(scope(c))).toMatchObject({ created: false, run: null });

    await streamedPackageFixture(fixture.runtime, scope(c), [allowlistedPackage({ id: "second-package", displayName: "C's package", isBlocked: false })]);
    await reconcileInventoryFixture(fixture.runtime, scope(c));
    expect((await inventorySelectionFixture(fixture.runtime, scope(b))).raw.counts.total).toBe(2);
    const roots = (await fixture.runtime.query(`SELECT source,count(*)::int AS count FROM data_scope_epochs
      WHERE tenant_id=$1 AND source IN ('directory','app_activity','inventory_packages','inventory_canonical')
      GROUP BY source`, [tenantId])).rows;
    expect(roots).toHaveLength(4);
    expect(roots.every(root => root.count === 1)).toBe(true);
    expect((await fixture.runtime.query(`SELECT 1 FROM data_scope_epochs WHERE tenant_id=$1 AND
      (scope_kind<>'tenant' OR principal_id IS NOT NULL OR token_mode<>'tenant')`, [tenantId])).rowCount).toBe(0);
    await expect(sources.page(selected.id, identity(c))).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(inventory.queries.page(inventory.selection.id, { ...identity(b), tenantId: randomUUID() }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("preserves saved tenant data when B lacks provider permission and never borrows A's token", async () => {
    const { a, b } = actors();
    await seed(a);
    const sync = new DataSyncRepository(fixture.runtime);
    const run = await sync.submit(scope(b), { mode: "full", sources: ["users"] });
    const jobId = randomUUID();
    await sync.attachJob(scope(b), run.run.id, "users", jobId);
    await sync.updateSource(scope(b), run.run.id, "users", { status: "running", jobId, message: "Checking B's authority.", canRetry: false });
    const token = vi.fn(async () => { throw new Error("No token may be acquired after provider denial."); });
    const service = new CopilotUsageService(fixture.runtime, {
      admissions: () => {}, beginOperationValidation: () => () => {},
      revalidateUser: async (tenant, principal) => {
        expect([tenant, principal]).toEqual([b.tenantId, b.homeAccountId]);
        return b;
      },
      requireAvailable: async () => { throw new AppError(403, "permission_required", "B lacks source-read permission."); },
      delegatedToken: token,
      observeOperation: async (_capability, _user, operation) => operation(() => {}),
    });
    const result = await service.refreshUsers(b, undefined, { publication: { runId: run.run.id, jobId } });
    expect(result.status).toBe("partial");
    expect(token).not.toHaveBeenCalled();
    await sync.updateSource(scope(b), run.run.id, "users", { status: "permission_required", message: "B lacks source-read permission.", canRetry: true });
    expect(await new DataSyncService(fixture.runtime).state(b)).toMatchObject({ onboardingRequired: false });
    const sources = new UserSourcesRepository(fixture.runtime, "synthetic-shared-source-cursor-secret");
    const selected = await sources.capture(identity(b));
    expect((await sources.page(selected.id, identity(b))).value).toHaveLength(1);
    expect((await inventorySelectionFixture(fixture.runtime, scope(b))).raw.counts.total).toBe(1);
  });

  it("deduplicates first-run admission across actors and fences only the revoked collector, not tenant readers", async () => {
    const { tenantId, a, b, c } = actors();
    const sync = new DataSyncRepository(fixture.runtime);
    const admissions = await Promise.all([sync.submitDue(scope(a)), sync.submitDue(scope(c))]);
    expect(admissions.filter(admission => admission.created)).toHaveLength(1);
    expect(admissions.find(admission => admission.created)!.run!.sources).toHaveLength(3);
    const admitted = admissions[0].created ? a : c;
    await sync.cancel(scope(admitted), admissions.find(admission => admission.created)!.run!.id);
    await seed(a);
    const sources = new UserSourcesRepository(fixture.runtime, "synthetic-shared-source-cursor-secret");
    const selected = await sources.capture(identity(b));
    const generations = new DataGenerations(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, tenantId }, actorPrincipalId: a.homeAccountId });
    const lease = await generations.begin(input);
    await expect(generations.begin({ ...input, jobId: randomUUID(), actorPrincipalId: c.homeAccountId }))
      .rejects.toMatchObject({ code: "data_source_active" });
    await generations.revokePrincipal(tenantId, a.homeAccountId);
    await expect(generations.renew(lease)).rejects.toThrow("data_writer_fenced");
    expect((await sources.page(selected.id, identity(b))).value).toHaveLength(1);
    expect((await inventorySelectionFixture(fixture.runtime, scope(b))).raw.counts.total).toBe(1);
    expect(await new DataSyncService(fixture.runtime).state(b)).toMatchObject({ onboardingRequired: false });
  });
});
