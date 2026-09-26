import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { CopilotDirectoryUser } from "../services/copilotUsageGraph.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { AuthenticatedUser } from "../types/session.js";
import { AgentIdentityRepository, type AgentIdentitySource } from "./agentIdentity.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import { AgentUsageRepository } from "./agentUsage.js";
import { saveUsageInventory } from "./agentUsageTestSupport.js";
import { CapabilityRepository, type EvidenceKey } from "./capabilities.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import { createJobConfirmation, JobRepository, type JobIntentInput } from "./jobs.js";
import { OfficialUsageRepository } from "./officialUsage.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PackageMutationQualificationRepository } from "./packageMutationQualifications.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

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
  it("isolates package catalogs, detail caches, snapshots and child foreign keys", async () => {
    const repository = new PackageInventoryRepository(fixture.runtime);
    const scopes = partitions("packages");
    const saved = [];
    for (const scope of scopes) {
      const job = await repository.submit(scope, {
        authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "shared-refresh",
      });
      await repository.markRunning(scope, job.id);
      const result = await repository.publish(scope, job.id, {
        packages: [allowlistedPackage({ id: "shared-package", displayName: label(scope), isBlocked: false,
          appId: identityId, manifestId: "shared-manifest", supportedHosts: ["Copilot"] })],
        totalRecords: 1, pages: 1,
      });
      saved.push({ scope, job, snapshotId: result.snapshotId });
    }
    expect(new Set(saved.map(value => value.job.id)).size).toBe(3);
    for (const current of saved) {
      const page = await repository.list(current.scope);
      expect(page).toMatchObject({ count: 1, value: [{ id: "shared-package", displayName: label(current.scope) }] });
      expect(await repository.get(current.scope, "shared-package"))
        .toMatchObject({ package: { displayName: label(current.scope), appId: identityId } });
      expect(await repository.getMany(current.scope, ["shared-package", "missing"]))
        .toMatchObject([{ id: "shared-package", package: { displayName: label(current.scope) } }, { id: "missing", package: null }]);
      expect((await repository.readUnifiedSource(current.scope)).packages).toMatchObject([{ displayName: label(current.scope) }]);
      for (const other of saved.filter(value => value !== current)) {
        expect(await repository.getJob(current.scope, other.job.id)).toBeUndefined();
        expect(await repository.markRunning(current.scope, other.job.id)).toBe(false);
        expect(await repository.cancel(current.scope, other.job.id, current.scope.principalId)).toBeUndefined();
        await expect(repository.list(current.scope, { snapshotId: other.snapshotId })).rejects.toMatchObject({ code: "not_found" });
        await expect(repository.assertSnapshotCurrent(current.scope, other.snapshotId)).rejects.toMatchObject({ code: "not_found" });
      }
    }
    for (const scope of scopes.slice(1)) {
      await expect(fixture.runtime.query(`INSERT INTO package_inventory_resources
        (snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data)
        VALUES($1,$2,$3,'foreign-child','Foreign child',false,'[{"kind":"package_id","value":"foreign-child"}]','{}')`,
      [saved[0].snapshotId, scope.tenantId, scope.principalId])).rejects.toMatchObject({ code: "23503" });
    }
    const identities = await fixture.runtime.query(`SELECT tenant_id FROM source_identifiers
      WHERE source='graph_packages' AND identifier_kind='package_id' AND identifier_value='shared-package' ORDER BY tenant_id`);
    expect(identities.rows).toEqual(scopes.slice(0, 2).map(scope => ({ tenant_id: scope.tenantId })));
  });

  it("keeps native agents, environments, identity candidates and verified identity caches scoped", async () => {
    const repository = new PowerPlatformInventoryRepository(fixture.runtime);
    const identities = new AgentIdentityRepository(fixture.runtime);
    const saved = [];
    for (const scope of partitions("native")) {
      const agent = nativeResource(scope);
      const environment: PowerPlatformResource = {
        ...agent, nativeId: environmentId, type: environmentType, displayName: `Environment ${label(scope)}`,
        agentKind: "environment", lifecycle: "not_applicable", identifiers: [{ kind: "environment_id", value: environmentId }],
        provenance: {}, details: { environmentType: "Sandbox" },
      };
      const job = await repository.submit(scope, { idempotencyKey: "shared-refresh", roleScope: "full", requestedTypes: [agentType, environmentType] });
      await repository.markRunning(scope, job.id);
      const result = await repository.publish(scope, job.id, {
        resources: [agent, environment], queriedTypes: [agentType, environmentType], environmentScope: null,
        totalRecords: 2, pages: 1, unknownFieldCount: 0,
      });
      const source: AgentIdentitySource = { recordId: "shared-record", snapshotId: result.snapshotId, nativeId,
        environmentId, candidateId: identityId, sourceRevision: "a".repeat(64) };
      await identities.save(scope, source, { objectId: identityId, applicationId: identityId, runtimeStatus: "available",
        runtimeProvenance: verifiedAgentIdentityClientIdProvenance }, async () => {});
      saved.push({ scope, source, job });
    }
    for (const current of saved) {
      expect((await repository.readUnifiedSource(current.scope)).resources).toMatchObject([{ tenantId: current.scope.tenantId, displayName: label(current.scope) }]);
      expect((await repository.readAgentEnvironments(current.scope, [environmentId]))[environmentId])
        .toMatchObject({ displayName: `Environment ${label(current.scope)}`, observation: { snapshotId: current.source.snapshotId } });
      expect(await repository.readIdentityCandidates(current.scope, [agentType])).toMatchObject([{ tenantId: current.scope.tenantId, nativeId }]);
      expect(await identities.read(current.scope, current.source)).toMatchObject({ objectId: identityId, applicationId: identityId });
      for (const other of saved.filter(value => value !== current)) {
        await expect(repository.getResource(current.scope, other.source.snapshotId, agentType, environmentId, nativeId))
          .rejects.toMatchObject({ code: "not_found" });
        await expect(repository.getQuarantineSelection(current.scope, other.source.snapshotId, [nativeId]))
          .rejects.toMatchObject({ code: "not_found" });
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
    await expect(repository.publish(owner.scope, pending.id, {
      resources: [nativeResource(saved[1].scope)], queriedTypes: [agentType], environmentScope: null,
      totalRecords: 1, pages: 1, unknownFieldCount: 0,
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect((await repository.readUnifiedSource(owner.scope)).snapshot?.id).toBe(owner.source.snapshotId);
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
      await repository.publishDirectory(scope, [user], checkedAt, "Saved users.", publication);
      await people.save(scope, [{ objectId: personId, status: "resolved", displayName: label(scope),
        userPrincipalName: "same@example.invalid", checkedAt }], { generation: "initial", publication });
      saved.push({ scope, run, publication, user });
    }
    for (const current of saved) {
      expect((await repository.getDirectorySource(current.scope)).value).toMatchObject([{ identity: { displayName: label(current.scope) } }]);
      expect(await people.read(current.scope, [personId])).toMatchObject([{ displayName: label(current.scope) }]);
      expect((await repository.listRuns(current.scope)).map(run => run.id)).toEqual([current.run.id]);
      for (const other of saved.filter(value => value !== current)) {
        expect(await repository.getRun(current.scope, other.run.id)).toBeUndefined();
        await expect(repository.publishDirectory(current.scope, [other.user], new Date().toISOString(), "Foreign source.", other.publication))
          .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
      }
    }
    const owner = saved[0];
    await repository.cancel(owner.scope, owner.run.id);
    await repository.submit(owner.scope, { mode: "full", clearSavedData: true });
    expect((await repository.getDirectorySource(owner.scope)).value).toBeNull();
    expect(await people.read(owner.scope, [personId])).toEqual([]);
    for (const other of saved.slice(1)) {
      expect((await repository.getDirectorySource(other.scope)).value).toMatchObject([{ identity: { displayName: label(other.scope) } }]);
      expect(await people.read(other.scope, [personId])).toMatchObject([{ displayName: label(other.scope) }]);
      expect(await repository.getRun(other.scope, other.run.id)).toMatchObject({ status: "running" });
    }
  });

  it("isolates identical report files, bundle receipts, active selections and private import previews", async () => {
    const repository = new OfficialUsageRepository(fixture.runtime);
    const [owner, otherTenant, otherAccount] = partitions("reports");
    const bundleId = randomUUID();
    const csvs = [
      "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nshared-agent,Shared agent,Your org,1,0,4,2026-09-01",
      "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nshared-agent,Shared agent,Your org,shared@example.invalid,4,2026-09-01",
      "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nshared@example.invalid,Shared person,1,4,2026-09-01",
    ];
    const saved = [];
    for (const scope of [owner, otherTenant]) {
      const stages = [];
      for (const content of csvs) {
        stages.push(await repository.stage(scope, {
          bundleId, report: parseOfficialUsageReport(Buffer.from(content)), fileHash: createHash("sha256").update(content).digest("hex"),
        }));
      }
      saved.push({ scope, stages, preview: await repository.previewBundle(scope, bundleId) });
    }
    for (const unauthorized of [otherTenant, otherAccount]) {
      const stage = saved[0].stages[0];
      expect(await repository.getStaging(unauthorized, stage.id)).toBeUndefined();
      await expect(repository.accept(unauthorized, stage.id, {
        stagingRevision: stage.revision, fileHash: stage.fileHash, expectedActiveRevision: stage.activeRevision,
      })).rejects.toMatchObject({ code: "staging_not_found" });
      await expect(repository.discardStaging(unauthorized, stage.id)).rejects.toMatchObject({ code: "staging_unavailable" });
    }
    expect((await repository.getAdminState(otherAccount)).staging).toEqual([]);
    await expect(repository.acceptBundle(otherTenant, bundleId, saved[0].preview)).rejects.toMatchObject({ code: "bundle_fence_mismatch" });
    const accepted = [];
    for (const current of saved) accepted.push(await repository.acceptBundle(current.scope, bundleId, current.preview));
    expect(accepted[0].setId).not.toBe(accepted[1].setId);
    const first = await repository.getPublished(owner.tenantId);
    const second = await repository.getPublished(otherTenant.tenantId);
    expect(first.reports.agents?.rows).toEqual(second.reports.agents?.rows);
    expect(first.reports.agents?.lineage.versionId).not.toBe(second.reports.agents?.lineage.versionId);
    await expect(repository.getPublished(owner.tenantId, accepted[1].setId)).rejects.toMatchObject({ code: "official_usage_set_not_found" });
    await expect(repository.previewSetOperation(owner, "select", accepted[1].setId)).rejects.toMatchObject({ code: "set_unavailable" });
    await expect(repository.stage(owner, { bundleId: randomUUID(), correctionOfSetId: accepted[1].setId,
      report: parseOfficialUsageReport(Buffer.from(csvs[0])), fileHash: createHash("sha256").update(csvs[0]).digest("hex") }))
      .rejects.toMatchObject({ code: "invalid_correction" });
    const confirmation = await repository.previewSetOperation(owner, "delete", accepted[0].setId);
    await expect(repository.confirmSetOperation(otherTenant, confirmation.id, confirmation)).rejects.toMatchObject({ code: "confirmation_mismatch" });
    await repository.confirmSetOperation(owner, confirmation.id, confirmation);
    expect((await repository.getPublished(owner.tenantId)).activeSet).toBeNull();
    expect((await repository.getPublished(otherTenant.tenantId)).activeSet?.id).toBe(accepted[1].setId);
    expect(await repository.acceptBundle(otherTenant, bundleId, saved[1].preview)).toMatchObject({ setId: accepted[1].setId });
    const facts = await fixture.runtime.query("SELECT tenant_id,count(*)::int AS count FROM official_usage_row_facts GROUP BY tenant_id ORDER BY tenant_id");
    expect(facts.rows).toEqual([{ tenant_id: owner.tenantId, count: 3 }, { tenant_id: otherTenant.tenantId, count: 3 }]);
  });

  it.each(["graph_packages", "power_platform"] as const)("rejects foreign %s job IDs in sync attachments and progress", async source => {
    const repository = new DataSyncRepository(fixture.runtime);
    const packages = new PackageInventoryRepository(fixture.runtime);
    const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
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
      ? await new PackageInventoryRepository(fixture.runtime).submit(scope, {
        authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: "retained-child",
      })
      : await new PowerPlatformInventoryRepository(fixture.runtime).submit(scope, {
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
    const repository = new AgentUsageRepository(fixture.runtime);
    const saved = [];
    for (const scope of partitions("canonical")) {
      const [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["shared-package"], native: { nativeId, environmentId } }]);
      saved.push({ scope, record });
    }
    expect(new Set(saved.map(value => value.record.id)).size).toBe(3);
    for (const current of saved) {
      await repository.withSnapshot(current.scope, async client => {
        expect((await repository.resolveRecord(current.scope, current.record.id, client)).id).toBe(current.record.id);
        for (const other of saved.filter(value => value !== current)) {
          await expect(repository.resolveRecord(current.scope, other.record.id, client)).rejects.toMatchObject({ code: "agent_not_found" });
        }
      });
    }
  });
});
