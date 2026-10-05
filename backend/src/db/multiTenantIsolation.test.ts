import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput } from "../../scripts/largeTenantFixtures.js";
import { inventoryInput, inventorySelectionFixture, refreshInventoryFixture } from "../../scripts/inventoryFixtures.js";
import type { CopilotDirectoryUser } from "../types/copilotUsage.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AgentIdentityRepository, type AgentIdentitySource } from "./agentIdentity.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import { saveUsageInventory, usageIdentity } from "./agentUsageTestSupport.js";
import { CapabilityRepository, type EvidenceKey } from "./capabilities.js";
import { DataSyncRepository, requireUserPublication, type DataSyncScope, type UserSourcePublication } from "./dataSync.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { UserSourceStages } from "./userSourceStages.js";
import { UserSourcesRepository } from "./userSources.js";
import { PackageRefreshJobs } from "./packageRefreshJobs.js";
import { PackageMutationQualificationRepository } from "./packageMutationQualifications.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { packageInventoryRecord, powerPlatformInventoryRecord } from "../services/inventoryRecordProjection.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { DataGenerations } from "./dataGenerations.js";
import { LiveInventory } from "./liveInventory.js";
import { NativeInventory } from "./nativeInventory.js";
import { InventoryIdentityQueries } from "./inventoryIdentityQueries.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const principalId = "overlapping-principal";
const environmentId = "11111111-1111-4111-8111-111111111111";
const personId = "22222222-2222-4222-8222-222222222222";
const identityId = "33333333-3333-4333-8333-333333333333";
const botId = "44444444-4444-4444-8444-444444444444";
const nativeId = "overlapping-native-agent";
const agentType = "microsoft.copilotstudio/agents";
const environmentType = "microsoft.powerplatform/environments";

beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
afterAll(async () => { await fixture?.close(); });

function partitions(label: string): DataSyncScope[] {
  return [
    { tenantId: `${label}-tenant-a`, principalId },
    { tenantId: `${label}-tenant-b`, principalId },
    { tenantId: `${label}-tenant-a`, principalId: "private-account" },
  ];
}

function label(scope: DataSyncScope) {
  return `${scope.tenantId}/${scope.principalId}`;
}

async function directoryPage(scope: DataSyncScope) {
  const source = new UserSourcesRepository(fixture.runtime, "synthetic-multi-tenant-directory-key"), identity = await usageIdentity(fixture.runtime, scope);
  const selection = await source.capture(identity, "delegated");
  return source.page(selection.id, identity);
}
function collectDirectory(scope: DataSyncScope, user: CopilotDirectoryUser, publication: UserSourcePublication) {
  const stages = new UserSourceStages(fixture.runtime);
  return stages.execute(generationInput({
    scope: { ...generationInput().scope, ...scope, source: "directory" }, jobKind: "data_sync", ...publication,
  }), async lease => {
    const key = await stages.query(lease, "discovery", "synthetic:isolation");
    await stages.page(lease, key, "synthetic:isolation", 1, 1);
    await stages.directory(lease, key, [user]);
    await stages.finishQuery(lease, key);
  }, { beforePublish: async () => {}, completeJob: client => requireUserPublication(client, scope, publication) });
}

function nativeResource(scope: DataSyncScope): PowerPlatformResource {
  return {
    tenantId: scope.tenantId, nativeId, environmentId, type: agentType, displayName: label(scope),
    location: "unitedstates", createdAt: null, createdBy: personId, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
    agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native", unknownFieldCount: 0,
    identifiers: [{ kind: "power_platform_resource_id", value: nativeId }, { kind: "environment_id", value: environmentId },
      { kind: "entra_agent_id", value: identityId }, { kind: "cds_bot_id", value: botId }],
    provenance: { entraAgentId: { sourceSystem: "power_platform", path: "properties.entraAgentId", maturity: "ga" } },
    details: { ownerId: personId, isQuarantined: false },
  };
}

describe("multi-tenant repositories with overlapping provider and principal identities", () => {
  it("isolates typed package pages, pinned details and composite child foreign keys", async () => {
    const repository = new PackageRefreshJobs(fixture.runtime);
    const scopes = partitions("packages");
    const saved = [];
    for (const scope of scopes) {
      const job = await repository.submit(scope, {
        authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "shared-refresh",
      });
      await repository.markRunning(scope, job.id);
      const root = await refreshInventoryFixture(fixture.runtime, scope, job.id, "packages", [
        packageInventoryRecord(allowlistedPackage({ id: "shared-package", displayName: label(scope), isBlocked: false,
          appId: identityId, manifestId: "shared-manifest", supportedHosts: ["Copilot"] })),
      ]);
      saved.push({ scope, job, root, selected: await inventorySelectionFixture(fixture.runtime, scope, {}, "packages") });
    }
    expect(new Set(saved.map(value => value.job.id)).size).toBe(3);
    for (const current of saved) {
      const { queries, selection, identity, raw } = current.selected;
      expect(raw).toMatchObject({ counts: { total: 1 }, value: [{ id: "shared-package", displayName: label(current.scope) }] });
      expect(await queries.packageDetail(selection.id, identity, "shared-package"))
        .toMatchObject({ displayName: label(current.scope), appId: identityId });
      expect(await queries.exact(selection.id, identity, ["shared-package", "missing"]))
        .toMatchObject([{ identity: "shared-package", residual: { displayName: label(current.scope) } }]);
      expect((await queries.children(selection.id, identity, "shared-package", { kind: "supportedHosts" })).total).toBe(1);
      for (const other of saved.filter(value => value !== current)) {
        expect(await repository.getJob(current.scope, other.job.id)).toBeUndefined();
        expect(await repository.markRunning(current.scope, other.job.id)).toBe(false);
        expect(await repository.cancel(current.scope, other.job.id, current.scope.principalId)).toBeUndefined();
        await expect(queries.page(other.selected.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
        await expect(queries.capture(identity, other.root.scopeId)).rejects.toMatchObject({ code: "selection_invalidated" });
      }
    }
    const stages = new DataGenerations(fixture.runtime), input = inventoryInput(scopes[0].principalId);
    input.scope.tenantId = scopes[0].tenantId;
    const lease = await stages.begin(input);
    try {
      for (const other of saved.slice(1)) {
        await expect(fixture.runtime.query(`INSERT INTO inventory_keys
          (generation_id,scope_id,tenant_id,identity,schema_version,content_hash) VALUES($1,$2,$3,'foreign-child',1,$4)`,
        [lease.id, other.root.scopeId, other.scope.tenantId, "a".repeat(64)])).rejects.toMatchObject({ code: "23503" });
      }
    } finally { await stages.abort(lease); }
    const identities = await fixture.runtime.query(`SELECT r.tenant_id,s.principal_id FROM package_record_rows r
      JOIN data_scope_epochs s ON s.id=r.scope_id WHERE r.native_id='shared-package' ORDER BY r.tenant_id,s.principal_id`);
    expect(identities.rows).toHaveLength(3);
    expect(identities.rows).toEqual(expect.arrayContaining(scopes.map(scope => ({ tenant_id: scope.tenantId, principal_id: scope.principalId }))));
    for (const current of saved) {
      await current.selected.queries.selections.invalidate(current.selected.selection.id, current.selected.identity);
    }
  });

  it("keeps native agents, environments, identity candidates and verified identity caches scoped", async () => {
    const repository = new PowerPlatformRefreshJobs(fixture.runtime);
    const identities = new AgentIdentityRepository(fixture.runtime);
    const saved = [];
    for (const scope of partitions("native")) {
      const agent = nativeResource(scope);
      const environment: PowerPlatformResource = {
        ...agent, nativeId: environmentId, environmentId: null, type: environmentType, displayName: `Environment ${label(scope)}`,
        agentKind: "environment", lifecycle: "not_applicable", identifiers: [{ kind: "environment_id", value: environmentId }],
        provenance: {}, details: { environmentType: "Sandbox" },
      };
      const job = await repository.submit(scope, { idempotencyKey: "shared-refresh", roleScope: "full", requestedTypes: [agentType, environmentType] });
      await repository.markRunning(scope, job.id);
      const root = await refreshInventoryFixture(fixture.runtime, scope, job.id, "power_platform",
        [agent, environment].map(powerPlatformInventoryRecord), [agentType, environmentType]);
      const selected = await inventorySelectionFixture(fixture.runtime, scope);
      const page = inventoryPresentation(selected.raw);
      const record = await new LiveInventory(fixture.runtime).record(scope, page.value[0].id);
      const source: AgentIdentitySource = { recordId: record.id, snapshotId: record.native!.observation.snapshotId, nativeId,
        environmentId, candidateId: identityId, sourceRevision: record.revision };
      await identities.save(scope, source, { objectId: identityId, applicationId: identityId, runtimeStatus: "available",
        runtimeProvenance: verifiedAgentIdentityClientIdProvenance }, async () => {});
      saved.push({ scope, source, job, root, selected, page });
    }
    for (const current of saved) {
      expect(current.page.value).toMatchObject([{ powerPlatformResource: { tenantId: current.scope.tenantId, displayName: label(current.scope) },
        environment: { displayName: `Environment ${label(current.scope)}`, observation: { snapshotId: current.source.snapshotId } } }]);
      const native = new InventoryIdentityQueries(fixture.runtime);
      expect(await native.read(client => native.resolve(client, current.scope, [agentType], {
        tenantId: current.scope.tenantId, sourceSystem: "power_platform", nativeId, resourceType: agentType, environmentId,
        identifiers: [{ kind: "entra_agent_id", value: identityId }],
      }))).toMatchObject({ status: "resolved", candidate: { tenantId: current.scope.tenantId, nativeId } });
      expect(await identities.read(current.scope, current.source)).toMatchObject({ objectId: identityId, applicationId: identityId });
      for (const other of saved.filter(value => value !== current)) {
        await expect(current.selected.queries.page(other.selected.selection.id, current.selected.identity))
          .rejects.toMatchObject({ code: "selection_invalidated" });
        await expect(new NativeInventory(fixture.runtime).resolveQuarantineTargets(current.scope, other.source.snapshotId, [nativeId]))
          .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
        expect(await repository.getJob(current.scope, other.job.id)).toBeUndefined();
        expect(await identities.read(current.scope, other.source)).toBeNull();
        await identities.invalidate(current.scope, other.source);
        expect(await identities.read(other.scope, other.source)).not.toBeNull();
        await expect(identities.saveFailure(current.scope, other.source, { status: "authorization_required", code: "missing_permission" }, async () => {}))
          .rejects.toMatchObject({ code: "agent_identity_source_changed" });
      }
    }
    const owner = saved[0];
    const pending = await repository.submit(owner.scope, { idempotencyKey: "reject-foreign-publication", roleScope: "full", requestedTypes: [agentType] });
    await repository.markRunning(owner.scope, pending.id);
    await expect(refreshInventoryFixture(fixture.runtime, owner.scope, pending.id, "power_platform",
      [powerPlatformInventoryRecord(nativeResource(saved[1].scope))], [agentType])).rejects.toThrow("inventory_resource_scope");
    expect((await new LiveInventory(fixture.runtime).record(owner.scope, owner.source.recordId)).native?.observation.snapshotId)
      .toBe(owner.source.snapshotId);
    for (const current of saved) await current.selected.queries.selections.invalidate(current.selected.selection.id, current.selected.identity);
  });

  it("retains account-private directory users and sync lineage while clearing only the requested scope", async () => {
    const repository = new DataSyncRepository(fixture.runtime);
    const people = new AgentPeopleRepository(fixture.runtime);
    const saved = [];
    for (const scope of partitions("directory")) {
      const run = (await repository.submit(scope, { mode: "incremental", sources: ["users"] })).run;
      const publication = { runId: run.id, jobId: randomUUID() };
      await repository.attachJob(scope, run.id, "users", publication.jobId);
      await repository.updateSource(scope, run.id, "users", { status: "running", jobId: publication.jobId, message: "Reading users.", canRetry: false });
      const user: CopilotDirectoryUser = { identity: { objectId: personId, displayName: label(scope), userPrincipalName: "same@example.invalid",
        accountEnabled: true, userType: "Member", employeeType: null, department: null, companyName: null },
      serviceEvidenceVersion: 1, copilotServiceState: "unknown", servicePlans: [] };
      const checkedAt = new Date().toISOString();
      await collectDirectory(scope, user, publication);
      await people.save(scope, [{ objectId: personId, status: "resolved", displayName: label(scope),
        userPrincipalName: "same@example.invalid", checkedAt }], { generation: await people.generation(scope), publication });
      saved.push({ scope, run, publication, user });
    }
    for (const current of saved) {
      expect((await directoryPage(current.scope)).value).toMatchObject([{ directory: { displayName: label(current.scope) } }]);
      expect(await people.read(current.scope, [personId])).toMatchObject([{ displayName: label(current.scope) }]);
      expect((await repository.listRuns(current.scope)).map(run => run.id)).toEqual([current.run.id]);
      for (const other of saved.filter(value => value !== current)) {
        expect(await repository.getRun(current.scope, other.run.id)).toBeUndefined();
        await expect(collectDirectory(current.scope, other.user, other.publication)).rejects.toThrow("data_source_job_fenced");
      }
    }
    const owner = saved[0];
    await repository.cancel(owner.scope, owner.run.id);
    await repository.submit(owner.scope, { mode: "full", clearSavedData: true });
    expect(await directoryPage(owner.scope)).toMatchObject({ value: [], sources: { directory: { state: "unavailable", generationId: null } } });
    expect(await people.read(owner.scope, [personId])).toEqual([]);
    for (const other of saved.slice(1)) {
      expect((await directoryPage(other.scope)).value).toMatchObject([{ directory: { displayName: label(other.scope) } }]);
      expect(await people.read(other.scope, [personId])).toMatchObject([{ displayName: label(other.scope) }]);
      expect(await repository.getRun(other.scope, other.run.id)).toMatchObject({ status: "running" });
    }
  });

  it("isolates identical report files, bundle receipts, active selections and private import previews", async () => {
    const repository = new OfficialReportImports(fixture.runtime);
    const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-multi-tenant-report-key", 35);
    const [owner, otherTenant, otherAccount] = partitions("reports");
    const bundleId = randomUUID();
    const csvs = [
      "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nshared-agent,Shared agent,Your org,1,0,4,2026-09-01",
      "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nshared-agent,Shared agent,Your org,shared@example.invalid,4,2026-09-01",
      "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nshared@example.invalid,Shared person,1,4,2026-09-01",
    ];
    const saved = [];
    for (const scope of [owner, otherTenant]) {
      const identity = await usageIdentity(fixture.runtime, scope);
      const stages = [];
      for (const content of csvs) {
        stages.push(await repository.stage(identity, { bundleId }, (async function* () { yield Buffer.from(content); })()));
      }
      saved.push({ scope, identity, stages, preview: await repository.bundle(identity, bundleId) });
    }
    for (const unauthorized of [otherTenant, otherAccount]) {
      const identity = await usageIdentity(fixture.runtime, unauthorized);
      const stage = saved[0].stages[0];
      await expect(repository.preview(identity, stage.id)).rejects.toMatchObject({ code: "staging_unavailable" });
      await expect(repository.accept(identity, {
        stagingId: stage.id, revision: stage.revision, contentHash: stage.contentHash, expectedActiveRevision: stage.activeRevision,
      })).rejects.toMatchObject({ code: "staging_unavailable" });
      await expect(repository.discard(identity, stage.id)).rejects.toMatchObject({ code: "staging_unavailable" });
    }
    expect((await repository.bundle(await usageIdentity(fixture.runtime, otherAccount), bundleId)).stages).toEqual([]);
    await expect(repository.acceptBundle(saved[1].identity, bundleId, saved[0].preview)).rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    const accepted = [];
    for (const current of saved) accepted.push(await repository.acceptBundle(current.identity, bundleId, current.preview));
    expect(accepted[0].setId).not.toBe(accepted[1].setId);
    const read = async (scope: DataSyncScope) => {
      const identity = await usageIdentity(fixture.runtime, scope), selection = await reports.capture(identity, "delegated", "official_agents");
      return reports.page(selection.id, identity);
    };
    const first = await read(owner), second = await read(otherTenant);
    expect(first.value).toEqual(second.value);
    expect(first.reports.lineages.find(lineage => lineage.kind === "agents")?.versionId)
      .not.toBe(second.reports.lineages.find(lineage => lineage.kind === "agents")?.versionId);
    expect((await read(otherAccount)).value).toEqual(first.value);
    await expect(reports.capture(saved[0].identity, "delegated", "official_agents", { setId: accepted[1].setId }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(repository.confirmPreview(saved[0].identity, accepted[1].setId, "select")).rejects.toMatchObject({ code: "staging_unavailable" });
    await expect(repository.stage(saved[0].identity, { bundleId: randomUUID(), correctionOfSetId: accepted[1].setId },
      (async function* () { yield Buffer.from(csvs[0]); })()))
      .rejects.toMatchObject({ code: "invalid_correction" });
    const confirmation = await repository.confirmPreview(saved[0].identity, accepted[0].setId, "delete");
    await expect(async () => repository.confirm(saved[1].identity, confirmation)).rejects.toMatchObject({ code: "confirmation_mismatch" });
    await repository.confirm(saved[0].identity, confirmation);
    expect((await read(owner)).reports.activeSetId).toBeNull();
    expect((await read(otherTenant)).reports.activeSetId).toBe(accepted[1].setId);
    expect(await repository.acceptBundle(saved[1].identity, bundleId, saved[1].preview)).toMatchObject({ setId: accepted[1].setId });
    const facts = await fixture.runtime.query("SELECT tenant_id,count(*)::int AS count FROM official_usage_row_facts GROUP BY tenant_id ORDER BY tenant_id");
    expect(facts.rows).toEqual([{ tenant_id: owner.tenantId, count: 3 }, { tenant_id: otherTenant.tenantId, count: 3 }]);
  });

  it.each(["graph_packages", "power_platform"] as const)("rejects foreign %s job IDs in sync attachments and progress", async source => {
    const repository = new DataSyncRepository(fixture.runtime);
    const packages = new PackageRefreshJobs(fixture.runtime);
    const powerPlatform = new PowerPlatformRefreshJobs(fixture.runtime);
    const saved = [];
    for (const scope of partitions(`${source}-lineage`)) {
      const job = source === "graph_packages"
        ? await packages.submit(scope, { authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "same-child" })
        : await powerPlatform.submit(scope, { roleScope: "full", requestedTypes: [agentType], idempotencyKey: "same-child" });
      const { run } = await repository.submit(scope, { mode: "incremental", sources: [source] });
      saved.push({ scope, run, job });
    }
    for (const current of saved) {
      for (const other of saved.filter(value => value !== current)) {
        await expect(repository.attachJob(current.scope, current.run.id, source, other.job.id))
          .rejects.toMatchObject({ code: "data_sync_source_job_scope" });
        await expect(repository.updateSource(current.scope, current.run.id, source, {
          status: "succeeded", jobId: other.job.id, count: 1, message: "Foreign progress.", canRetry: false,
        })).rejects.toMatchObject({ code: "data_sync_source_job_scope" });
      }
      expect((await repository.getRun(current.scope, current.run.id))?.sources).toMatchObject([{ jobId: null, status: "queued" }]);
      await repository.attachJob(current.scope, current.run.id, source, current.job.id);
      await repository.updateSource(current.scope, current.run.id, source, {
        status: "succeeded", jobId: current.job.id, count: 0, message: "Saved local results.", canRetry: false,
      });
      expect((await repository.getRun(current.scope, current.run.id))?.sources).toMatchObject([{ jobId: current.job.id, status: "succeeded" }]);
    }
  });

  it.each(["graph_packages", "power_platform"] as const)("retains authorized %s lineage after provider-job retention", async source => {
    const repository = new DataSyncRepository(fixture.runtime);
    const [scope, other] = partitions(`${source}-retention`);
    const job = source === "graph_packages"
      ? await new PackageRefreshJobs(fixture.runtime).submit(scope, {
        authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "retained-child",
      })
      : await new PowerPlatformRefreshJobs(fixture.runtime).submit(scope, {
        roleScope: "full", requestedTypes: [agentType], idempotencyKey: "retained-child",
      });
    const { run } = await repository.submit(scope, { mode: "incremental", sources: [source] });
    const foreign = await repository.submit(other, { mode: "incremental", sources: [source] });
    await repository.attachJob(scope, run.id, source, job.id);
    const table = source === "graph_packages" ? "package_refresh_jobs" : "power_platform_refresh_jobs";
    await fixture.operator.query(`DELETE FROM ${table} WHERE id=$1`, [job.id]);
    await repository.updateSource(scope, run.id, source, {
      status: "failed", jobId: job.id, message: "The retained child job is no longer available.", canRetry: true,
    });
    expect((await repository.getRun(scope, run.id))?.sources).toMatchObject([{ jobId: job.id, status: "failed", canRetry: true }]);
    await expect(repository.attachJob(other, foreign.run.id, source, job.id)).rejects.toMatchObject({ code: "data_sync_source_job_scope" });
    await expect(repository.updateSource(other, foreign.run.id, source, {
      status: "failed", jobId: job.id, message: "Foreign retained child.", canRetry: true,
    })).rejects.toMatchObject({ code: "data_sync_source_job_scope" });
  });

  it("attaches package canary provenance only to the executing account's tenant-scoped job", async () => {
    const qualifications = new PackageMutationQualificationRepository(fixture.runtime);
    const jobs = new JobRepository(fixture.runtime);
    const scopes = partitions("qualification");
    const user = (scope: DataSyncScope): AuthenticatedUser => ({
      tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: label(scope),
      username: "same@example.invalid", roles: ["AgentControl.Admin"],
    });
    const prestate = { kind: "block" as const, isBlocked: false };
    const poststate = { kind: "block" as const, isBlocked: true };
    const approval = { targetId: "shared-package", contractRevision: "a".repeat(64), configurationRevision: 1, prestate, poststate };
    const administrator = user({ ...scopes[0], principalId: "separate-approver" });
    const original = await qualifications.createApproved(administrator, { ...approval, action: "block" });
    const restoration = await qualifications.createApproved(administrator, { ...approval, action: "unblock", prestate: poststate, poststate: prestate });
    const identity = { contractRevision: approval.contractRevision, configurationRevision: 1, authMode: "delegated" as const };
    await qualifications.claimCycle(user(scopes[0]), original.id, restoration.id, identity, identity);
    const submitted = [];
    for (const scope of scopes) {
      const intent: JobIntentInput = { action: "block", actor: user(scope), requestPath: "/fixture/canary", scope: "single",
        targets: [{ id: "shared-package", displayName: "Shared package", prestate }] };
      submitted.push(await jobs.submit(scope, { ...intent, idempotencyKey: "shared-job", confirmationHash: createJobConfirmation(intent).confirmationHash }));
    }
    for (const job of submitted.slice(1)) {
      expect(await jobs.get(job.id, scopes[0])).toBeUndefined();
      expect(await jobs.claim(job.id, scopes[0], randomUUID())).toBeUndefined();
      expect(await jobs.cancel(job.id, scopes[0])).toBeUndefined();
      await expect(qualifications.recordCycleJob(user(scopes[0]), original.id, job.id)).rejects.toMatchObject({ code: "canary_cycle_state" });
      await expect(qualifications.authorizeCycleJob(user(scopes[0]), original.id, job.id, identity))
        .rejects.toMatchObject({ code: "qualification_invalidated" });
    }
    expect(await qualifications.recordCycleJob(user(scopes[0]), original.id, submitted[0].id)).toMatchObject({ jobId: submitted[0].id });
    expect(await qualifications.authorizeCycleJob(user(scopes[0]), original.id, submitted[0].id, identity)).toMatchObject({ jobId: submitted[0].id });
    for (const [index, scope] of scopes.entries()) expect((await jobs.list(scope)).value.map(job => job.id)).toEqual([submitted[index].id]);
  });

  it("keeps configuration, readiness and operation evidence separate despite identical application and principal IDs", async () => {
    const repository = new CapabilityRepository(fixture.runtime);
    const scopes = partitions("capabilities");
    const key = (scope: DataSyncScope): EvidenceKey => ({
      ...scope, principalId: "shared-application-result", authorizationPrincipalId: scope.principalId,
      capabilityId: "graph.package.read.application", resourceAudience: "https://graph.microsoft.com", environmentId,
      tokenMode: "application", permissionRevision: "a".repeat(64), contractRevision: "b".repeat(64), configurationRevision: 1,
    });
    for (const scope of scopes) {
      await repository.recordEvidence(key(scope), "available", { source: label(scope) }, 60_000);
      await repository.recordEvidence({ ...key(scope), contractRevision: `operation-v1:${"b".repeat(64)}` }, "missing_permission", { source: label(scope) }, 60_000);
    }
    for (const scope of scopes) expect((await repository.evidence(key(scope)))?.details).toEqual({ source: label(scope) });
    await repository.invalidatePrincipal(scopes[0].tenantId, scopes[0].principalId);
    expect(await repository.evidence(key(scopes[0]))).toBeUndefined();
    expect(await repository.evidence({ ...key(scopes[0]), contractRevision: `operation-v1:${"b".repeat(64)}` })).toBeUndefined();
    for (const scope of scopes.slice(1)) expect((await repository.evidence(key(scope)))?.details).toEqual({ source: label(scope) });
    await repository.setApplicationConfiguration(scopes[0].tenantId, key(scopes[0]).capabilityId, true, true, principalId);
    expect(await repository.configuration(scopes[0].tenantId, key(scopes[0]).capabilityId)).toMatchObject({ enabled: true, sharedDataScope: true });
    expect(await repository.configuration(scopes[1].tenantId, key(scopes[1]).capabilityId)).toMatchObject({ enabled: false, sharedDataScope: false });
    expect(await repository.evidence(key(scopes[2]))).toBeUndefined();
    expect((await repository.evidence(key(scopes[1])))?.details).toEqual({ source: label(scopes[1]) });
  });

  it("keeps canonical internal agent IDs and usage source memberships private for matching native identities", async () => {
    const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-canonical-isolation-report-key", 35);
    const repository = new OfficialAgentUsage(reports);
    const saved = [];
    for (const scope of partitions("canonical")) {
      const [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["shared-package"], native: { nativeId, environmentId } }]);
      saved.push({ scope, record });
    }
    expect(new Set(saved.map(value => value.record.id)).size).toBe(3);
    for (const current of saved) {
      const identity = await usageIdentity(fixture.runtime, current.scope), selection = await reports.capture(identity, "delegated", "official_agents");
      expect((await repository.summaries(selection.id, identity, [current.record.id]))[0].recordId).toBe(current.record.id);
      for (const other of saved.filter(value => value !== current)) {
        await expect(repository.summaries(selection.id, identity, [other.record.id])).rejects.toMatchObject({ code: "agent_not_found" });
      }
    }
  });
});
