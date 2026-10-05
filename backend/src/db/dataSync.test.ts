import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { copilotServicePlanDefinitions, resolveCopilotServicePlan, summarizeCopilotServices } from "../services/copilotServicePlans.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { publishFixtureDirectory, publishFixtureEmptyActivity } from "../../scripts/userSourceFixture.js";
import { UserSourcesRepository } from "./userSources.js";
import { UserSourceStages } from "./userSourceStages.js";
import { DataGenerations } from "./dataGenerations.js";
import { AppError } from "../errors.js";
import { DataSyncRepository } from "./dataSync.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
const scope = { tenantId: "tenant-data-sync", principalId: "viewer-a" };
const identity = (owner: typeof scope) => ({ ...selectionIdentity, ...owner });
const sourceReader = () => new UserSourcesRepository(fixture.runtime, "synthetic-data-sync-source-read-secret");
async function sourcePage(owner: typeof scope) {
  const reader = sourceReader(), selected = await reader.capture(identity(owner), "delegated");
  return reader.page(selected.id, identity(owner));
}
function failSource(owner: typeof scope, source: "directory" | "app_activity", error: Error) {
  return new UserSourceStages(fixture.runtime).execute(generationInput({
    scope: { ...generationInput().scope, ...owner, source },
  }), async () => { throw error; }, { beforePublish: async () => {} });
}

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

describe.sequential("Data sync repository", () => {
  it("distinguishes an empty database from a successful zero-row sync", async () => {
    expect(await repository.getLatestRun(scope)).toBeUndefined();
    expect(await repository.listMarkers(scope)).toEqual([
      expect.objectContaining({ source: "users", status: "not_started", count: null }),
      expect.objectContaining({ source: "graph_packages", status: "not_started", count: null }),
      expect.objectContaining({ source: "power_platform", status: "not_started", count: null }),
      expect.objectContaining({ source: "usage_reports", status: "not_started", count: null }),
    ]);
  });

  it("creates one durable onboarding run and deduplicates concurrent equivalent starts", async () => {
    const [left, right] = await Promise.all([
      repository.submit(scope, { mode: "initial" }),
      repository.submit(scope, { mode: "initial" }),
    ]);
    expect(left.run.id).toBe(right.run.id);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    expect(left.run.sources.map(source => source.source)).toEqual([
      "graph_packages", "power_platform", "users",
    ]);
    await expect(repository.submit(scope, { mode: "full" })).rejects.toMatchObject({ code: "data_sync_active" });
    expect(await repository.listRuns(scope, 1)).toEqual([
      expect.objectContaining({ id: left.run.id, sources: expect.any(Array) }),
    ]);
    expect(await repository.listRuns({ ...scope, principalId: "viewer-b" }, 50)).toEqual([]);
    await expect(repository.listRuns(scope, 51)).rejects.toMatchObject({ code: "invalid_data_sync_limit" });
  });

  it.each(["initial", "incremental", "full"] as const)("defaults %s to automatic sources and respects explicit narrower requests", async mode => {
    const owner = { ...scope, principalId: `default-${mode}` };
    const { run } = await repository.submit(owner, { mode });
    expect(run.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
    expect(run.sources.every(source => source.count === null)).toBe(true);
    for (const source of run.sources) await repository.updateSource(owner, run.id, source.source, {
      status: "succeeded", count: 0, message: "Saved a valid zero-row source.", canRetry: false,
    });
    expect((await repository.getRun(owner, run.id))?.status).toBe("completed");
    const usersOnly = await repository.submit(owner, { mode, sources: ["users"] });
    expect(usersOnly.run.sources).toEqual([expect.objectContaining({
      source: "users", status: "queued", count: null, lastSuccessAt: expect.any(String),
    })]);
    await repository.cancel(owner, usersOnly.run.id);
  });

  it("keeps explicit legacy four-source runs waiting for manual usage and accepts a complete zero-row bundle", async () => {
    const owner = { ...scope, principalId: "manual-usage" };
    const { run } = await repository.submit(owner, {
      mode: "full", sources: ["users", "graph_packages", "power_platform", "usage_reports"],
    });
    for (const source of run.sources) await repository.updateSource(owner, run.id, source.source, source.source === "usage_reports"
      ? { status: "awaiting_upload", count: null, message: "Waiting for official reports.", canRetry: false }
      : { status: "succeeded", count: 0, message: "Saved a valid zero-row source.", canRetry: false });
    const retained = new DataSyncRepository(fixture.runtime);
    expect(await retained.getRun(owner, run.id)).toMatchObject({ status: "waiting", sources: expect.any(Array) });
    await retained.updateSource(owner, run.id, "usage_reports", {
      status: "succeeded", count: 0, message: "Accepted a complete zero-row usage bundle.", canRetry: false,
    });
    expect((await retained.getRun(owner, run.id))?.status).toBe("completed");
    expect((await retained.listMarkers(owner)).every(marker => marker.status === "succeeded" && marker.count === 0)).toBe(true);
  });

  it("starts new and retried counts unknown, preserves completed sources and markers, and fences old progress", async () => {
    const owner = { ...scope, principalId: "observed-counts" };
    await repository.recordSuccessMarker(owner, "users", 40, "2026-09-15T10:00:00.000Z");
    await repository.recordSuccessMarker(owner, "graph_packages", 120, "2026-09-15T10:00:00.000Z");
    const { run } = await repository.submit(owner, { mode: "incremental", sources: ["users", "graph_packages"] });
    expect(run.sources.every(source => source.count === null)).toBe(true);
    await repository.updateSource(owner, run.id, "graph_packages", {
      status: "succeeded", count: 130, message: "Saved a complete package snapshot.", canRetry: false,
    });
    const completed = (await repository.getRun(owner, run.id))!.sources.find(source => source.source === "graph_packages")!;
    const previousJobId = randomUUID();
    await repository.attachJob(owner, run.id, "users", previousJobId);
    await repository.updateSource(owner, run.id, "users", {
      status: "running", jobId: previousJobId, count: 5, message: "Read five distinct licensed users.", canRetry: false,
    });
    await repository.updateSource(owner, run.id, "users", {
      status: "failed", jobId: previousJobId, message: "A later directory page failed.", canRetry: true,
    });
    expect((await repository.getRun(owner, run.id))?.sources.find(source => source.source === "users"))
      .toMatchObject({ status: "failed", count: 5 });
    expect((await repository.listMarkers(owner)).find(source => source.source === "users"))
      .toMatchObject({ status: "succeeded", count: 40 });

    await repository.retry(owner, run.id, ["users"]);
    await repository.updateSource(owner, run.id, "users", {
      status: "running", jobId: previousJobId, count: 99, message: "Late progress from the old attempt.", canRetry: false,
    });
    const retry = (await repository.getRun(owner, run.id))!;
    expect(retry.sources.find(source => source.source === "users")).toMatchObject({ status: "queued", count: null, jobId: null });
    expect(retry.sources.find(source => source.source === "graph_packages")).toEqual(completed);
    const newJobId = randomUUID();
    await repository.attachJob(owner, run.id, "users", newJobId);
    await repository.updateSource(owner, run.id, "users", {
      status: "running", jobId: newJobId, count: 2, message: "Read two distinct licensed users.", canRetry: false,
    });
    const cancelled = await repository.cancel(owner, run.id);
    expect(cancelled.sources.find(source => source.source === "users")).toMatchObject({ status: "cancelled", count: 2 });
    expect(cancelled.sources.find(source => source.source === "graph_packages")).toEqual(completed);
    expect((await repository.listMarkers(owner)).filter(source => ["users", "graph_packages"].includes(source.source))).toEqual([
      expect.objectContaining({ source: "users", status: "succeeded", count: 40 }),
      expect.objectContaining({ source: "graph_packages", status: "succeeded", count: 130 }),
    ]);
    const next = await repository.submit(owner, { mode: "incremental", sources: ["users"] });
    await repository.updateSource(owner, next.run.id, "users", { status: "failed", message: "Failed before the first page.", canRetry: true });
    expect((await repository.getRun(owner, next.run.id))?.sources[0]).toMatchObject({ status: "failed", count: null });
    expect((await repository.listMarkers(owner))[0]).toMatchObject({ status: "succeeded", count: 40 });
  });

  it("uses persisted success markers so a successful zero-row source is not first-use again", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "users", {
      status: "succeeded", count: 0, message: "Saved zero licensed users.", canRetry: false,
    });
    const marker = (await repository.listMarkers(scope)).find(source => source.source === "users");
    expect(marker).toMatchObject({ status: "succeeded", count: 0 });
  });

  it("reconciles usage marker changes without changing its saved timestamp on every state read", async () => {
    const owner = { ...scope, principalId: "usage-marker" };
    const acceptedAt = "2026-09-15T10:00:00.000Z";
    await repository.recordSuccessMarker(owner, "usage_reports", 0, acceptedAt);
    const before = (await repository.listMarkers(owner))[3];
    expect(before).toMatchObject({ status: "succeeded", count: 0, lastSuccessAt: acceptedAt });
    await repository.recordSuccessMarker(owner, "usage_reports", 0, acceptedAt);
    expect((await repository.listMarkers(owner))[3]).toEqual(before);
    await repository.recordSuccessMarker(owner, "usage_reports", 4, acceptedAt);
    expect((await repository.listMarkers(owner))[3]).toMatchObject({ status: "succeeded", count: 4, lastSuccessAt: acceptedAt });
  });

  it("keeps run and saved user data private to the tenant and principal", async () => {
    expect(await repository.getRun({ ...scope, principalId: "viewer-b" }, (await repository.getLatestRun(scope))!.id)).toBeUndefined();
    await publishFixtureDirectory(fixture.runtime, identity(scope), [directoryUser("saved@example.com")]);
    expect((await sourcePage(scope)).value).toHaveLength(1);
    for (const owner of [{ ...scope, principalId: "viewer-b" }, { tenantId: "other-tenant", principalId: scope.principalId }]) {
      const page = await sourcePage(owner);
      expect(page.value).toEqual([]);
      expect(page.sources.directory).toMatchObject({ generationId: null, rowCount: null });
    }
  });

  it("preserves the last good record generation when a later independent source attempt fails", async () => {
    await publishFixtureEmptyActivity(fixture.runtime, identity(scope));
    await expect(failSource(scope, "directory", new AppError(403, "permission_required", "Directory permission was denied.")))
      .rejects.toMatchObject({ code: "permission_required" });
    const saved = await sourcePage(scope);
    expect(saved.sources.directory).toMatchObject({ attemptStatus: "permission_required", rowCount: 1 });
    expect(saved.value).toEqual([expect.objectContaining({ directory: expect.objectContaining({ userPrincipalName: "saved@example.com" }) })]);
    expect(saved.sources.app_activity).toMatchObject({ attemptStatus: "available", rowCount: 0, reportRefreshDate: null });
  });

  it("withholds expired source rows and counts at the captured read time even when the last attempt succeeded", async () => {
    const owner = { ...scope, principalId: "expired-user-sources" };
    await publishFixtureDirectory(fixture.runtime, identity(owner), []);
    await publishFixtureEmptyActivity(fixture.runtime, identity(owner));
    const reader = sourceReader();
    await reader.connections.selectedRead(async client => {
      const saved = await reader.metadataInRead(client, { ...owner, tokenMode: "delegated" }, new Date(Date.now() + 2 * 86400000));
      for (const source of [saved.directory, saved.app_activity]) expect(source).toMatchObject({
        state: "unavailable", generationId: null, rowCount: null, observedAt: null,
      });
    });
  });

  it.each(["clear", "revoke"] as const)("does not revive old attempt counts after a %s fence", async operation => {
    const owner = { ...scope, principalId: `fenced-user-attempt-${operation}` };
    let current = identity(owner);
    await publishFixtureDirectory(fixture.runtime, current, [directoryUser("fenced@example.invalid")]);
    await publishFixtureEmptyActivity(fixture.runtime, current);
    expect((await sourcePage(owner)).sources.directory.rowCount).toBe(1);
    if (operation === "clear") await repository.submit(owner, { mode: "full", clearSavedData: true });
    else current = { ...current, sessionEpoch: await new DataGenerations(fixture.runtime).revokePrincipal(owner.tenantId, owner.principalId) };
    const reader = sourceReader(), selected = await reader.capture(current, "delegated");
    const page = await reader.page(selected.id, current);
    expect(page.value).toEqual([]);
    for (const source of [page.sources.directory, page.sources.app_activity]) expect(source).toMatchObject({
      generationId: null, attemptStatus: null, attemptedAt: null, attemptObservedCount: null, rowCount: null, state: "unavailable",
    });
  });

  it("persists company and department in native user rows across repository instances", async () => {
    const owner = { ...scope, principalId: "organization-reader" };
    const user = directoryUser("organization@example.invalid");
    user.identity.companyName = "Example Health";
    user.identity.department = "Clinical Services";
    await publishFixtureDirectory(fixture.runtime, identity(owner), [user]);
    expect(await sourcePage(owner)).toMatchObject({
      counts: { total: 1, filtered: 1 }, value: [{ directory: {
        userPrincipalName: "organization@example.invalid", companyName: "Example Health", department: "Clinical Services",
      } }],
    });
    expect((await sourcePage({ ...owner, principalId: "other-reader" })).sources.directory.rowCount).toBeNull();
  });

  it("losslessly pages distinct immutable service-plan sets without sharing mutable feature evidence between users", async () => {
    const owner = { ...scope, principalId: "mixed-paid-license-roster" };
    const enabled = [...copilotServicePlanDefinitions.keys()].map(servicePlanId => resolveCopilotServicePlan(
      servicePlanId, true, [{ servicePlanId, assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }],
    ));
    const changed = enabled.toReversed().map((plan, index) => ({
      ...plan,
      state: index === 0 ? "disabled" as const : "unknown" as const,
      assignedDateTime: index === 0 ? "2026-02-02T12:34:56Z" : null,
      capabilityStatus: index === 0 ? "Deleted" as const : null,
    }));
    const sets = [enabled, changed, [], enabled, changed, enabled.slice(1)];
    const users = sets.map((servicePlans, index) => ({
      ...directoryUser(`person${index}@example.com`), servicePlans,
      copilotServiceState: servicePlans.length ? summarizeCopilotServices(servicePlans) : "disabled" as const,
    }));
    await publishFixtureDirectory(fixture.runtime, identity(owner), users);
    const reader = sourceReader(), selected = await reader.capture(identity(owner), "delegated");
    const first = await reader.plans(selected.id, identity(owner), users[0].identity.objectId);
    for (const user of users) {
      const plans = await reader.plans(selected.id, identity(owner), user.identity.objectId);
      expect(plans.counts.total).toBe(user.servicePlans.length);
      expect(plans.value).toEqual(user.servicePlans.toSorted((left, right) => left.servicePlanId.localeCompare(right.servicePlanId)));
      expect(plans.value).not.toBe(first.value);
      if (plans.value.length) expect(plans.value[0]).not.toBe(first.value[0]);
    }
  });

  it("removes the old snapshot containers and whole-source getter/writer surface instead of decoding or converting them", async () => {
    expect((await fixture.runtime.query(`SELECT to_regclass('public.copilot_usage_snapshots') AS snapshots,
      to_regclass('public.copilot_usage_source_state') AS source_state`)).rows[0]).toEqual({ snapshots: null, source_state: null });
    const methods = Object.getOwnPropertyNames(DataSyncRepository.prototype);
    for (const method of ["getDirectorySource", "getUserSources", "publishDirectory", "publishAppActivity"]) expect(methods).not.toContain(method);
  });

  it.each(["directory", "app_activity"] as const)(
    "rejects invalid typed %s evidence before replacing its complete saved head",
    async source => {
      const owner = { ...scope, principalId: `record-bound-${source}` };
      const user = directoryUser("byte-bound@example.invalid");
      const before = source === "directory"
        ? await publishFixtureDirectory(fixture.runtime, identity(owner), [user])
        : await publishFixtureEmptyActivity(fixture.runtime, identity(owner));
      if (source === "directory") {
        user.identity.department = "é".repeat(257);
        await expect(publishFixtureDirectory(fixture.runtime, identity(owner), [user])).rejects.toMatchObject({ code: "provider_schema" });
      } else {
        const stages = new UserSourceStages(fixture.runtime);
        await expect(stages.execute(generationInput({ scope: { ...generationInput().scope, ...owner, source } }), async lease => {
          const key = await stages.query(lease, "activity", "synthetic:invalid-date");
          await stages.activity(lease, key, [{
            identity: "000000", upn_key: "person@example.invalid", period: "D30", report_refresh_date: "2026-02-30",
            last_activity_date: null, chat_date: null, teams_date: null, word_date: null, excel_date: null,
            powerpoint_date: null, outlook_date: null, onenote_date: null, loop_date: null, residual: {},
          }]);
        }, { beforePublish: async () => {} })).rejects.toMatchObject({ code: "provider_schema" });
      }
      expect((await sourcePage(owner)).sources[source]).toMatchObject({
        generationId: before.generationId, rowCount: source === "directory" ? 1 : 0, attemptStatus: "failed",
      });
    },
  );

  it("retries only incomplete top-level sources and retains every child association", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "graph_packages", {
      status: "failed", message: "Provider failed.", canRetry: true,
    });
    await repository.updateSource(scope, run.id, "power_platform", {
      status: "succeeded", count: 0, message: "Saved zero resources.", canRetry: false,
    });
    await repository.updateSource(scope, run.id, "usage_reports", {
      status: "awaiting_upload", message: "requiresAdmin: upload three reports.", canRetry: false,
    });
    await expect(repository.retry(scope, run.id, ["power_platform"])).rejects.toMatchObject({ code: "data_sync_source_complete" });
    await expect(repository.retry(scope, run.id, ["usage_reports"])).rejects.toMatchObject({ code: "data_sync_source_complete" });
    expect(await repository.retry(scope, run.id, ["graph_packages"])).toEqual(["graph_packages"]);
    const packages = new PackageRefreshJobs(fixture.runtime);
    const firstJob = (await packages.submit(scope, { tokenMode: "delegated",
      authorizationPrincipalId: scope.principalId, idempotencyKey: `${run.id}-first` })).id;
    await repository.attachJob(scope, run.id, "graph_packages", firstJob);
    await repository.updateSource(scope, run.id, "graph_packages", {
      status: "failed", jobId: firstJob, message: "Failed again.", canRetry: true,
    });
    expect(await repository.retry(scope, run.id, ["graph_packages"])).toEqual(["graph_packages"]);
    const secondJob = (await packages.submit(scope, { tokenMode: "delegated",
      authorizationPrincipalId: scope.principalId, idempotencyKey: `${run.id}-second` })).id;
    await repository.attachJob(scope, run.id, "graph_packages", secondJob);
    const associations = await fixture.runtime.query<{ job_id: string }>(
      "SELECT job_id FROM data_sync_source_jobs WHERE run_id=$1 ORDER BY attempt",
      [run.id],
    );
    expect(associations.rows.map(row => row.job_id)).toEqual([firstJob, secondJob]);
  });

  it("pauses provider work on sign-out/restart and cancels without erasing successful sources", async () => {
    const run = (await repository.getLatestRun(scope))!;
    await repository.updateSource(scope, run.id, "graph_packages", {
      status: "running", message: "Reading packages.", canRetry: false,
    });
    expect(await repository.pausePrincipal(scope)).toBe(1);
    expect((await repository.getRun(scope, run.id))?.sources.find(source => source.source === "graph_packages"))
      .toMatchObject({ status: "waiting_authorization", canRetry: true });
    const cancelled = await repository.cancel(scope, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.sources.find(source => source.source === "power_platform")?.status).toBe("succeeded");

    const restartScope = { tenantId: scope.tenantId, principalId: "restart-viewer" };
    const restarted = await repository.submit(restartScope, { mode: "incremental", sources: ["users"] });
    expect(await repository.recoverInterrupted()).toBeGreaterThanOrEqual(1);
    expect((await repository.getRun(restartScope, restarted.run.id))?.sources[0]).toMatchObject({
      status: "waiting_authorization",
      canRetry: true,
    });
  });

  it("keeps a historical retry current through completion without reordering retained history", async () => {
    const retryScope = { ...scope, principalId: "historical-retry-viewer" };
    const older = await repository.submit(retryScope, { mode: "incremental", sources: ["users"] });
    await repository.updateSource(retryScope, older.run.id, "users", {
      status: "failed", message: "Retry required.", canRetry: true,
    });
    const newer = await repository.submit(retryScope, { mode: "incremental", sources: ["users"] });
    await repository.updateSource(retryScope, newer.run.id, "users", {
      status: "succeeded", count: 0, message: "Saved zero users.", canRetry: false,
    });
    expect((await repository.getLatestRun(retryScope))?.id).toBe(newer.run.id);

    await repository.retry(retryScope, older.run.id, ["users"]);
    expect(await repository.getLatestRun(retryScope)).toMatchObject({ id: older.run.id, status: "running" });
    await repository.updateSource(retryScope, older.run.id, "users", {
      status: "succeeded", count: 0, message: "Retry completed with zero users.", canRetry: false,
    });
    expect(await repository.getLatestRun(retryScope)).toMatchObject({ id: older.run.id, status: "completed" });
    expect((await repository.listRuns(retryScope)).map(run => run.id)).toEqual([newer.run.id, older.run.id]);
  });
});

function directoryUser(userPrincipalName: string): CopilotDirectoryUser {
  return {
    identity: {
      objectId: randomUUID(),
      userPrincipalName,
      displayName: "Saved User",
      accountEnabled: true,
      userType: "Member",
      employeeType: "Employee",
      department: "Engineering",
      companyName: null,
    },
    serviceEvidenceVersion: 1,
    copilotServiceState: "unknown",
    servicePlans: [],
  };
}
