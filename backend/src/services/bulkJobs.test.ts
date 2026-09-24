import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { createJobConfirmation, JobRepository, type JobInput, type JobIntentInput } from "../db/jobs.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { reconcileBulkJob, runBulkJob } from "./bulkJobs.js";
import { capabilities } from "./capabilities.js";
import { GraphPackagesClient, type FetchLike } from "./graphPackages.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { UnifiedAgentRegistry } from "../db/unifiedAgentRegistry.js";
import { readUnifiedInventoryRevision } from "../db/unifiedInventoryRevision.js";
import { UnifiedAgentsService } from "./unifiedAgents.js";
import { AgentUsageService } from "./agentUsage.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { allowlistedPackage } from "./packageObservation.js";
import { capturePackageMutationState } from "./packageMutationState.js";
import { AuditLog } from "./auditLog.js";
import { DataSyncRepository } from "../db/dataSync.js";
import { loadOperationalState } from "./operationalState.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let jobs: JobRepository;
const scope = { tenantId: "fixture-tenant", principalId: "fixture-principal" };
const input = (): JobInput => confirmedInput({ targets: [{ id: "package-1", displayName: "Fixture", prestate: { kind: "block", isBlocked: false } }], action: "block", scope: "single", actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: "Fixture", username: "fixture@example.invalid" }, requestPath: "/api/agents/package-1/block" });
function confirmedInput(intent: JobIntentInput): JobInput { return { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash }; }
beforeAll(async () => { fixture = await testDatabase(); jobs = new JobRepository(fixture.runtime); });
beforeEach(() => { vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined)); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture?.close(); });

async function savedReadbackInventory(owner: { tenantId: string; principalId: string }) {
  const packages = new PackageInventoryRepository(fixture.runtime);
  const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
  const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const manifestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const refresh = await packages.submit(owner, {
    authorizationPrincipalId: owner.principalId, tokenMode: "delegated", idempotencyKey: randomUUID(),
  });
  await packages.markRunning(owner, refresh.id);
  await packages.publish(owner, refresh.id, {
    packages: ["readback-package", "untouched-package"].map(id => allowlistedPackage({
      id, displayName: id === "readback-package" ? "Reviewed package" : "Untouched package",
      isBlocked: false, availableTo: "some", deployedTo: "some",
      ...(id === "readback-package" ? {
        manifestId, platform: "Microsoft 365 Copilot Agent Builder", elementTypes: ["DeclarativeCopilots"],
        elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition: "{}" }] }],
      } : {}),
    })),
    totalRecords: 2, pages: 1,
  });
  const native = await powerPlatform.submit(owner, {
    idempotencyKey: randomUUID(), roleScope: "unknown", requestedTypes: ["microsoft.copilotstudio/agents"],
  });
  await powerPlatform.markRunning(owner, native.id);
  await powerPlatform.publish(owner, native.id, {
    resources: [{
      tenantId: owner.tenantId, nativeId: manifestId, type: "microsoft.copilotstudio/agents", environmentId,
      displayName: "Reviewed package", location: null, createdAt: null,
      createdBy: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", lastPublishedAt: null,
      sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent",
      lifecycle: "published", identityConfidence: "exact_native",
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: manifestId }],
      provenance: {}, details: { schemaName: manifestId, isQuarantined: false }, unknownFieldCount: 0,
    }],
    queriedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null, totalRecords: 1, pages: 1, unknownFieldCount: 0,
  });
  const service = new UnifiedAgentsService({
    packages, powerPlatform,
    usage: new AgentUsageService(fixture.runtime), registry: new UnifiedAgentRegistry(fixture.runtime),
    resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
    readRevision: (scope, database = fixture.runtime) => readUnifiedInventoryRevision(scope, database),
  });
  return { packages, service };
}

describe("Durable bulk execution", () => {
  it.each(["block", "availability", "installation", "skipped"] as const)("publishes verified %s readback before exposing its terminal result", async operation => {
    const owner = { tenantId: "readback-tenant", principalId: randomUUID() };
    const saved = await savedReadbackInventory(owner);
    const before = await saved.service.list(owner);
    let providerState = {
      id: "readback-package", displayName: "Reviewed package", isBlocked: operation === "skipped",
      availableTo: "some", deployedTo: "some",
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "11111111-1111-4111-8111-111111111111" }],
      acquireUsersAndGroups: [{ resourceType: "user", resourceId: "22222222-2222-4222-8222-222222222222" }],
    };
    const action = operation === "availability" ? "update-availability" : operation === "installation" ? "update-installation" : "block";
    const accessUpdate: JobIntentInput["accessUpdate"] = operation === "availability" || operation === "installation"
      ? { target: operation, mode: "replace", scope: "none", principals: [] } : undefined;
    const intent: JobIntentInput = {
      action, targets: [{ id: providerState.id, displayName: providerState.displayName, prestate: capturePackageMutationState(allowlistedPackage(providerState), action) }],
      ...(accessUpdate ? { accessUpdate } : {}),
      scope: "single", actor: { tenantId: owner.tenantId, homeAccountId: owner.principalId, username: "readback@example.invalid", displayName: "Readback operator" },
      requestPath: "/api/agents/readback-package",
    };
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") {
        providerState = { ...providerState, isBlocked: true };
        return new Response(null, { status: 204 });
      }
      if (request?.method === "PATCH") {
        const payload: Pick<typeof providerState, "allowedUsersAndGroups" | "acquireUsersAndGroups"> = JSON.parse(String(request.body));
        providerState = {
          ...providerState, ...payload,
          availableTo: payload.allowedUsersAndGroups.length ? "some" : "none",
          deployedTo: payload.acquireUsersAndGroups.length ? "some" : "none",
        };
        return new Response(null, { status: 204 });
      }
      return Response.json(providerState);
    });
    const job = await jobs.submit(owner, confirmedInput(intent));
    await runBulkJob(job.id, owner, false, jobs, new GraphPackagesClient(fetcher), async () => "synthetic-token");
    expect(await jobs.get(job.id, owner)).toMatchObject({
      status: "succeeded", succeeded: operation === "skipped" ? 0 : 1, skipped: operation === "skipped" ? 1 : 0,
    });
    const after = await saved.service.list(owner);
    expect(after.revision).not.toBe(before.revision);
    const changed = after.value.flatMap(row => row.packages).find(item => item.id === providerState.id)!;
    const stored = (await saved.packages.get(owner, providerState.id))?.package;
    if (operation === "availability" || operation === "installation") {
      expect(stored).toMatchObject({
        allowedUsersAndGroups: providerState.allowedUsersAndGroups,
        acquireUsersAndGroups: providerState.acquireUsersAndGroups,
      });
    } else {
      expect(stored).not.toHaveProperty("allowedUsersAndGroups");
      expect(stored).not.toHaveProperty("acquireUsersAndGroups");
    }
    expect(after.count).toBe(before.count);
    expect(after.value.find(row => row.presence === "both")?.id).toBe(before.value.find(row => row.presence === "both")?.id);
    expect(changed).toMatchObject({
      id: providerState.id, isBlocked: providerState.isBlocked,
      availableTo: providerState.availableTo, deployedTo: providerState.deployedTo,
    });
    expect(after.value.flatMap(row => row.packages).find(item => item.id === "untouched-package")).toMatchObject({
      isBlocked: false, availableTo: "some", deployedTo: "some",
    });
    const filtered = await saved.service.list(owner, operation === "block" || operation === "skipped"
      ? { blocked: false } : { availableTo: "some" });
    expect(filtered.count).toBe(operation === "installation" ? 2 : 1);
    expect(filtered.filteredSummary.total).toBe(filtered.count);
    await expect(saved.service.forExport(owner, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    const exported = await saved.service.forExport(owner, after.revision!);
    expect(exported.value.flatMap(row => row.packages).find(item => item.id === providerState.id)).toMatchObject(changed);
    expect((await saved.service.list({ ...owner, principalId: "another-reader" })).count).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(operation === "skipped" ? 1 : 4);
    expect((await saved.packages.listJobs(owner, owner.principalId)).value).toHaveLength(1);
    const receipt = await fixture.runtime.query("SELECT metadata FROM audit_events WHERE operation_id=$1 AND status=$2", [job.id, operation === "skipped" ? "skipped" : "succeeded"]);
    expect(receipt.rows[0].metadata.snapshotId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("keeps one canonical agent through sparse block and unblock readbacks across all saved views", async () => {
    const owner = { tenantId: "block-cycle-tenant", principalId: randomUUID() };
    const saved = await savedReadbackInventory(owner);
    const before = await saved.service.list(owner, { search: "Reviewed" });
    expect(before.count).toBe(1);
    const original = before.value[0];
    let blocked = false;
    const provider = new GraphPackagesClient(async (url, request) => {
      if (request?.method === "POST") {
        blocked = String(url).endsWith("/block");
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: "readback-package", displayName: "Reviewed package", isBlocked: blocked, elementDetails: [], elementTypes: [] });
    });
    for (const action of ["block", "unblock"] as const) {
      const job = await jobs.submit(owner, confirmedInput({
        action, targets: [{ id: "readback-package", displayName: "Reviewed package", prestate: { kind: "block", isBlocked: blocked } }],
        scope: "single", actor: { tenantId: owner.tenantId, homeAccountId: owner.principalId, username: "cycle@example.invalid", displayName: "Cycle" },
        requestPath: `/api/agents/readback-package/${action}`,
      }));
      await runBulkJob(job.id, owner, false, jobs, provider, async () => "synthetic-token");
      expect(await jobs.get(job.id, owner)).toMatchObject({ status: "succeeded", succeeded: 1 });
      const membership = await fixture.runtime.query(`SELECT package_snapshot_id,matching_evidence FROM unified_agent_sources
        WHERE tenant_id=$1 AND principal_id=$2 AND source='graph_packages' AND native_id='readback-package'`,
      [owner.tenantId, owner.principalId]);
      expect(membership.rows[0]).toMatchObject({
        package_snapshot_id: original.observations.packageSnapshots["readback-package"].snapshotId,
        matching_evidence: original.identity.packageEvidence[0].evidence,
      });
      const page = await saved.service.list(owner, { search: "Reviewed" });
      expect(page.count).toBe(1);
      expect(page.value[0]).toMatchObject({
        id: original.id, presence: "both", identity: original.identity,
        powerPlatformResource: original.powerPlatformResource,
        packages: [{ isBlocked: action === "block", manifestId: original.packages[0].manifestId }],
      });
      expect(page.value[0].observations.packageSnapshots).toEqual(original.observations.packageSnapshots);
      expect((await saved.service.list(owner, { recordId: original.id })).count).toBe(1);
      const expected = { id: "readback-package", isBlocked: action === "block", manifestId: original.packages[0].manifestId };
      expect((await saved.packages.get(owner, expected.id))?.package).toMatchObject(expected);
      expect((await saved.packages.getMany(owner, [expected.id]))[0].package).toMatchObject(expected);
      const list = await saved.packages.list(owner, { search: "Reviewed", blocked: action === "block" });
      expect(list).toMatchObject({ count: 1, value: [expected], summary: { total: 2, blocked: action === "block" ? 1 : 0 } });
      const exported = await saved.service.forExport(owner, page.revision!);
      expect(exported.value.filter(row => row.packages.some(pkg => pkg.id === expected.id))).toHaveLength(1);
      expect(exported.value.find(row => row.id === original.id)?.packages[0]).toMatchObject(expected);
    }
    const baseline = await fixture.runtime.query(`SELECT resource.package_data FROM package_inventory_resources resource
      JOIN package_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
      WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.observation_kind='inventory'
        AND resource.native_id='readback-package'`, [owner.tenantId, owner.principalId]);
    expect(baseline.rows[0].package_data).not.toHaveProperty("controlObservations");
    expect(baseline.rows[0].package_data.isBlocked).toBe(false);
  });

  it("rolls back readback inventory and revisions when the success audit cannot be stored", async () => {
    const owner = { tenantId: "readback-tenant", principalId: randomUUID() };
    const saved = await savedReadbackInventory(owner);
    const before = await saved.service.list(owner);
    let blocked = false;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") { blocked = true; return new Response(null, { status: 204 }); }
      return Response.json({ id: "readback-package", displayName: "Reviewed package", isBlocked: blocked });
    });
    const job = await jobs.submit(owner, confirmedInput({
      action: "block", targets: [{ id: "readback-package", displayName: "Reviewed package", prestate: { kind: "block", isBlocked: false } }],
      scope: "single", actor: { tenantId: owner.tenantId, homeAccountId: owner.principalId, username: "readback@example.invalid", displayName: "Readback operator" },
      requestPath: "/api/agents/readback-package/block",
    }));
    vi.spyOn(AuditLog.prototype, "completeEvent").mockRejectedValueOnce(new Error("synthetic audit failure"));
    await runBulkJob(job.id, owner, false, jobs, new GraphPackagesClient(fetcher), async () => "synthetic-token");
    expect(await jobs.get(job.id, owner)).toMatchObject({ status: "partial", inconclusive: 1, succeeded: 0 });
    expect((await saved.service.list(owner)).revision).toBe(before.revision);
    expect(await saved.packages.get(owner, "readback-package")).toMatchObject({ package: { isBlocked: false } });
    const snapshots = await fixture.runtime.query("SELECT scope_kind FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2", [owner.tenantId, owner.principalId]);
    expect(snapshots.rows).toEqual([{ scope_kind: "broad" }]);
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });

  it("does not republish an in-flight readback across a confirmed saved-data clear", async () => {
    const owner = { tenantId: "readback-tenant", principalId: randomUUID() };
    const saved = await savedReadbackInventory(owner);
    let blocked = false;
    let cleared = false;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") { blocked = true; return new Response(null, { status: 204 }); }
      const response = Response.json({ id: "readback-package", displayName: "Reviewed package", isBlocked: blocked });
      if (blocked && !cleared) {
        await new DataSyncRepository(fixture.runtime).submit(owner, { mode: "full", clearSavedData: true });
        cleared = true;
      }
      return response;
    });
    const job = await jobs.submit(owner, confirmedInput({
      action: "block", targets: [{ id: "readback-package", displayName: "Reviewed package", prestate: { kind: "block", isBlocked: false } }],
      scope: "single", actor: { tenantId: owner.tenantId, homeAccountId: owner.principalId, username: "readback@example.invalid", displayName: "Readback operator" },
      requestPath: "/api/agents/readback-package/block",
    }));
    const provider = new GraphPackagesClient(fetcher);
    await runBulkJob(job.id, owner, false, jobs, provider, async () => "synthetic-token");
    expect(await jobs.get(job.id, owner)).toMatchObject({
      status: "partial", inconclusive: 1, results: [{ errorCode: "package_readback_superseded" }],
    });
    expect(await saved.packages.get(owner, "readback-package")).toBeUndefined();
    const reconciled = await reconcileBulkJob(job.id, owner, jobs, provider, async () => "synthetic-token");
    expect(reconciled).toMatchObject({ status: "succeeded", reconciliation: { attempted: 1, failed: 0 } });
    expect(await saved.packages.get(owner, "readback-package")).toMatchObject({ package: { isBlocked: true } });
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });

  it("persists intent before sending and verifies the resulting state", async () => {
    let blocked = false;
    const correlations = new Set<string>();
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      correlations.add(new Headers(request?.headers).get("client-request-id") ?? "");
      if (request?.method === "POST") {
        const sent = await fixture.runtime.query("SELECT 1 FROM job_items WHERE job_id=$1 AND sent_at IS NOT NULL", [job.id]);
        expect(sent.rowCount).toBe(1); blocked = true; return new Response(null, { status: 204 });
      }
      return Response.json({ id: "package-1", displayName: "Fixture", isBlocked: blocked });
    });

    const job = await jobs.submit(scope, input());
    await runBulkJob(job.id, scope, false, jobs, new GraphPackagesClient(fetcher), async () => "ephemeral-token");
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "succeeded", succeeded: 1 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(correlations.size).toBe(1);
    expect([...correlations][0]).toMatch(/^[a-f0-9-]{36}$/);
    const stored = await fixture.operator.query("SELECT row_to_json(jobs) AS value FROM jobs");
    expect(JSON.stringify(stored.rows)).not.toContain("ephemeral-token");
  });
  it("does not retry an ambiguous write or replay an inconclusive item", async () => {
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    const fetcher = vi.fn<FetchLike>(async (_url, request) => request?.method === "POST"
      ? Response.json({ error: { code: "ServiceUnavailable", message: "unavailable" } }, { status: 503 })
      : Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false }));
    const provider = new GraphPackagesClient(fetcher, { delay: async () => undefined });
    const job = await jobs.submit(scope, input());
    await runBulkJob(job.id, scope, false, jobs, provider, async () => "ephemeral-token");
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "partial", inconclusive: 1 });
    await runBulkJob(job.id, scope, true, jobs, provider, async () => "ephemeral-token");
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual({
      timestamp: expect.any(String), level: "error",
      event: "job_write_uncertain", jobId: job.id, outcome: "requires_reconciliation",
    });
  });
  it("emits a redacted stopped event when the finite item deadline expires before dispatch", async () => {
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    const provider = new GraphPackagesClient(
      vi.fn(async () => { throw new DOMException("synthetic deadline","TimeoutError"); }),
      { delay: async () => undefined },
    );
    const job=await jobs.submit(scope,input());
    await runBulkJob(job.id,scope,false,jobs,provider,async () => "ephemeral-token");
    expect(await jobs.get(job.id,scope)).toMatchObject({ status: "failed", failed: 1 });
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual({
      timestamp: expect.any(String), level: "error",
      event: "job_execution_stopped", jobId: job.id, outcome: "deadline_exceeded",
    });
  });
  it("reconciles ambiguous outcomes by read only and never dispatches again", async () => {
    for (const applied of [false, true]) {
      let blocked = false;
      const fetcher = vi.fn<FetchLike>(async (_url, request) => {
        if (request?.method === "POST") {
          blocked = applied;
          return Response.json({ error: { code: "ServiceUnavailable", message: "ambiguous" } }, { status: 503 });
        }
        return Response.json({ id: "package-1", displayName: "Fixture", isBlocked: blocked });
      });
      const provider = new GraphPackagesClient(fetcher, { maxAttempts: 1 });
      const job = await jobs.submit(scope, input());
      await runBulkJob(job.id, scope, false, jobs, provider, async () => "ephemeral-token");
      const previousRevision = await readUnifiedInventoryRevision(scope, fixture.runtime);
      const authorizationCapabilities: string[] = [];
      const reconciled = await reconcileBulkJob(job.id, scope, jobs, provider, async (_scope, capabilityId) => {
        authorizationCapabilities.push(capabilityId);
        return "ephemeral-token";
      });
      expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
      expect(authorizationCapabilities).toEqual([
        "graph.package.read.delegated",
        "graph.package.read.delegated",
        "graph.package.read.delegated",
      ]);
      expect(reconciled).toMatchObject(applied
        ? { status: "succeeded", succeeded: 1, reconciliation: { attempted: 1, failed: 0 } }
        : { status: "partial", inconclusive: 1, results: [{ reconciliationStatus: "verified_not_applied", retryEligible: true }], reconciliation: { attempted: 1, failed: 0 } });
      expect(await readUnifiedInventoryRevision(scope, fixture.runtime)).not.toBe(previousRevision);
      expect(await new PackageInventoryRepository(fixture.runtime).get(scope, "package-1")).toMatchObject({ package: { isBlocked: applied } });
    }
  });

  it("does not publish reconciliation after read authority is revoked or the job is cancelled", async () => {
    const provider = new GraphPackagesClient(async (_url, request) => request?.method === "POST"
      ? Response.json({ error: { code: "ServiceUnavailable", message: "ambiguous" } }, { status: 503 })
      : Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false }), { maxAttempts: 1 });
    const revokedJob = await jobs.submit(scope, input());
    await runBulkJob(revokedJob.id, scope, false, jobs, provider, async () => "ephemeral-token");
    let authorizationCount = 0;
    await expect(reconcileBulkJob(revokedJob.id, scope, jobs, provider, async (_scope, capabilityId) => {
      expect(capabilityId).toBe("graph.package.read.delegated");
      authorizationCount += 1;
      if (authorizationCount > 1) throw new AppError(403, "missing_internal_role", "Operator role revoked");
      return "ephemeral-token";
    })).rejects.toMatchObject({ code: "missing_internal_role" });
    expect(await jobs.get(revokedJob.id, scope)).toMatchObject({ results: [{ reconciliationStatus: "required" }] });

    const cancelledJob = await jobs.submit(scope, input());
    await runBulkJob(cancelledJob.id, scope, false, jobs, provider, async () => "ephemeral-token");
    await jobs.cancel(cancelledJob.id, scope);
    const readCount = vi.fn(async () => "ephemeral-token");
    const cancelled = await reconcileBulkJob(cancelledJob.id, scope, jobs, provider, readCount);
    expect(cancelled).toMatchObject({ reconciliation: { attempted: 1, failed: 1 }, results: [{ reconciliationStatus: "required" }] });
  });

  it.each(["maintenance", "provider_requalification_required"] as const)(
    "stops reconciliation at every admission boundary when %s applies",
    async errorCode => {
      for (const stage of ["start", "authorization", "lock", "readback", "publication", "next-item"] as const) {
        const owner = { ...scope, principalId: randomUUID() };
        const targets = stage === "next-item" ? ["package-1", "package-2"] : ["package-1"];
        const job = await jobs.submit(owner, confirmedInput({
          ...input(), actor: { ...input().actor, homeAccountId: owner.principalId },
          targets: targets.map(id => ({ id, displayName: id, prestate: { kind: "block", isBlocked: false } })),
        }));
        const provider = new GraphPackagesClient(async (url, request) => request?.method === "POST"
          ? Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 })
          : Response.json({ id: decodeURIComponent(new URL(url).pathname.split("/").at(-1)!), displayName: "Fixture", isBlocked: false }),
        { maxAttempts: 1 });
        await runBulkJob(job.id, owner, false, jobs, provider, async () => "ephemeral-token");
        const revision = await readUnifiedInventoryRevision(owner, fixture.runtime);
        const closeAdmissions = async () => {
          if (errorCode === "maintenance") vi.stubEnv("MAINTENANCE_MODE", "true");
          else {
            await fixture.operator.query("UPDATE operational_state SET provider_work_enabled=false WHERE singleton=true");
            await loadOperationalState(fixture.runtime);
          }
        };
        const read = provider.getPackageDetails.bind(provider);
        const reads = vi.spyOn(provider, "getPackageDetails").mockImplementation(async (...args) => {
          const details = await read(...args);
          if (stage === "readback") await closeAdmissions();
          return details;
        });
        const lock = jobs.withReconciliationLock.bind(jobs);
        vi.spyOn(jobs, "withReconciliationLock").mockImplementation((owner, item, operation) => lock(owner, item, async () => {
          if (stage === "lock") await closeAdmissions();
          return operation();
        }));
        const record = jobs.recordReconciliation.bind(jobs);
        const publications = vi.spyOn(jobs, "recordReconciliation").mockImplementation(async (...args) => {
          await record(...args);
          if (stage === "next-item") await closeAdmissions();
        });
        let authorizations = 0;
        const authorize = vi.fn(async () => {
          authorizations += 1;
          if (stage === "authorization" && authorizations === 1 || stage === "publication" && authorizations === 2) await closeAdmissions();
          return "ephemeral-token";
        });
        try {
          if (stage === "start") await closeAdmissions();
          await expect(reconcileBulkJob(job.id, owner, jobs, provider, authorize), stage).rejects.toMatchObject({ code: errorCode });
          expect(publications, stage).toHaveBeenCalledTimes(stage === "next-item" ? 1 : 0);
          expect(reads, stage).toHaveBeenCalledTimes(["readback", "publication", "next-item"].includes(stage) ? 1 : 0);
          expect(authorize, stage).toHaveBeenCalledTimes(stage === "start" ? 0 : ["publication", "next-item"].includes(stage) ? 2 : 1);
          const current = await jobs.get(job.id, owner);
          expect(current?.results.filter(item => item.reconciliationStatus === "required"), stage).toHaveLength(1);
          if (stage !== "next-item") expect(await readUnifiedInventoryRevision(owner, fixture.runtime), stage).toBe(revision);
        } finally {
          vi.unstubAllEnvs();
          await fixture.operator.query("UPDATE operational_state SET provider_work_enabled=true WHERE singleton=true");
          await loadOperationalState(fixture.runtime);
          vi.restoreAllMocks();
        }
        const resumed = await reconcileBulkJob(job.id, owner, jobs, provider, async () => "ephemeral-token");
        expect(resumed.reconciliation, stage).toMatchObject({ attempted: 1, failed: 0 });
      }
    },
  );

  it("requires a current credential before claiming recovered work", async () => {
    const job = await jobs.submit(scope, input());
    await jobs.recover(scope.tenantId, true);
    await expect(runBulkJob(job.id, scope, true, jobs, new GraphPackagesClient(), async () => { throw new Error("reauthenticate"); })).rejects.toThrow("reauthenticate");
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "waiting_authorization" });
    await jobs.cancel(job.id, scope);
  });

  it("reauthorizes before every unsent item and pauses without dispatching the next item", async () => {
    const candidate = confirmedInput({ ...input(), targets: ["package-1", "package-2"].map(id => ({ id, displayName: id, prestate: { kind: "block" as const, isBlocked: false } })) });
    const job = await jobs.submit(scope, candidate);
    const blocked = new Set<string>();
    const writes: string[] = [];
    const provider = new GraphPackagesClient(async (url, request) => {
      const parts = new URL(url).pathname.split("/");
      const id = decodeURIComponent(request?.method === "POST" ? parts.at(-2)! : parts.at(-1)!);
      if (request?.method === "POST") { writes.push(id); blocked.add(id); return new Response(null, { status: 204 }); }
      return Response.json({ id, displayName: "Fixture", isBlocked: blocked.has(id) });
    });
    let authorizations = 0;
    await runBulkJob(job.id, scope, false, jobs, provider, async (_scope, capabilityId) => {
      expect(capabilityId).toBe("graph.package.block.manage");
      authorizations += 1;
      if (authorizations >= 5) throw new AppError(401, "interaction_required", "reauthenticate");
      return "ephemeral-token";
    });
    expect(writes).toHaveLength(1);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "waiting_authorization", succeeded: 1 });
    await jobs.cancel(job.id, scope);
  });

  it("does not dispatch when account revocation occurs during the immediate pre-write read", async () => {
    const raceScope = { tenantId: "fixture-tenant", principalId: `dispatch-race-${randomUUID()}` };
    const candidate = confirmedInput({ ...input(), actor: { ...input().actor, homeAccountId: raceScope.principalId }, requestPath: "/api/agents/package-1/block" });
    const raceJobs = new JobRepository(fixture.runtime);
    const job = await raceJobs.submit(raceScope, candidate);
    let releaseImmediate!: (value: Response) => void;
    const immediate = new Promise<Response>(resolve => { releaseImmediate = resolve; });
    let reads = 0;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") return new Response(null, { status: 204 });
      reads += 1;
      return reads === 2 ? immediate : Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false });
    });
    const execution = runBulkJob(job.id, raceScope, false, raceJobs, new GraphPackagesClient(fetcher), async () => "ephemeral-token");
    await vi.waitFor(() => expect(reads).toBe(2));
    await revokeAccountSessionMutations(raceScope.tenantId, raceScope.principalId, async () => undefined);
    releaseImmediate(Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false }));
    await execution;
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(0);
    expect(await raceJobs.get(job.id, raceScope)).toMatchObject({ status: "waiting_authorization", completed: 0 });
    await raceJobs.cancel(job.id, raceScope);
  });

  it("does not publish success when account revocation occurs during provider readback", async () => {
    const raceScope = { tenantId: "fixture-tenant", principalId: `readback-race-${randomUUID()}` };
    const candidate = confirmedInput({ ...input(), actor: { ...input().actor, homeAccountId: raceScope.principalId }, requestPath: "/api/agents/package-1/block" });
    const raceJobs = new JobRepository(fixture.runtime);
    const job = await raceJobs.submit(raceScope, candidate);
    let releaseReadback!: (value: Response) => void;
    const readback = new Promise<Response>(resolve => { releaseReadback = resolve; });
    let blocked = false;
    let reads = 0;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") { blocked = true; return new Response(null, { status: 204 }); }
      reads += 1;
      if (reads === 3) return readback;
      return Response.json({ id: "package-1", displayName: "Fixture", isBlocked: blocked });
    });
    const execution = runBulkJob(job.id, raceScope, false, raceJobs, new GraphPackagesClient(fetcher), async () => "ephemeral-token");
    await vi.waitFor(() => expect(reads).toBe(3));
    await revokeAccountSessionMutations(raceScope.tenantId, raceScope.principalId, async () => undefined);
    releaseReadback(Response.json({ id: "package-1", displayName: "Fixture", isBlocked: true }));
    await execution;
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
    expect(await raceJobs.get(job.id, raceScope)).toMatchObject({ status: "partial", succeeded: 0, inconclusive: 1 });
  });

  it("preserves queued unsent work when authorization is revoked during a held pre-read", async () => {
    const job = await jobs.submit(scope, input());
    let releaseRead!: (response: Response) => void;
    const heldRead = new Promise<Response>(resolve => { releaseRead = resolve; });
    const fetcher = vi.fn<FetchLike>(async (_url, request) => request?.method === "POST" ? new Response(null, { status: 204 }) : heldRead);
    let authorized = true;
    let calls = 0;
    const execution = runBulkJob(job.id, scope, false, jobs, new GraphPackagesClient(fetcher), async () => {
      calls += 1;
      if (!authorized) throw new AppError(403, "missing_internal_role", "role revoked");
      return `ephemeral-token-${calls}`;
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    authorized = false;
    releaseRead(Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false }));
    await execution;
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(0);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "waiting_authorization", completed: 0, canResume: true });
    await jobs.cancel(job.id, scope);
  });

  it("moves unsent provider 401 and 403 pre-reads to authorization wait", async () => {
    for (const providerStatus of [401, 403]) {
      const job = await jobs.submit(scope, input());
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: providerStatus }));
      await runBulkJob(job.id, scope, false, jobs, new GraphPackagesClient(fetcher), async () => "ephemeral-token");
      expect(await jobs.get(job.id, scope)).toMatchObject({ status: "waiting_authorization", completed: 0, canResume: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await jobs.cancel(job.id, scope);
    }
  });

  it("executes an explicitly confirmed access update once, preserving existing and unselected principals", async () => {
    const retained = { resourceType: "user", resourceId: "existing-user" };
    const added = { resourceType: "user", resourceId: "new-user" };
    const installed = { resourceType: "group", resourceId: "installed-group" };
    const candidate = confirmedInput({
      ...input(), action: "update-availability",
      accessUpdate: { target: "availability", mode: "add", scope: "specific", principals: [retained, added] },
      targets: [{ id: "package-1", displayName: "Fixture", prestate: { kind: "access", availableTo: "some", deployedTo: "some", allowedUsersAndGroups: [retained], acquireUsersAndGroups: [installed] } }],
    });
    let allowed = [retained];
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "PATCH") {
        expect(JSON.parse(String(request.body))).toEqual({ allowedUsersAndGroups: [retained, added], acquireUsersAndGroups: [installed] });
        allowed = [retained, added];
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false, availableTo: "some", deployedTo: "some", allowedUsersAndGroups: allowed, acquireUsersAndGroups: [installed] });
    });
    const job = await jobs.submit(scope, candidate);
    await runBulkJob(job.id, scope, false, jobs, new GraphPackagesClient(fetcher), async () => "testing-token");
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "succeeded", succeeded: 1 });
    await runBulkJob(job.id, scope, true, jobs, new GraphPackagesClient(fetcher), async () => "testing-token");
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "PATCH")).toHaveLength(1);
  });

  it("surfaces provider rejection of an installation update without a local qualification gate", async () => {
    const candidate = confirmedInput({
      ...input(), action: "update-installation",
      accessUpdate: { target: "installation", mode: "replace", scope: "specific", principals: [{ resourceType: "user", resourceId: "new-user" }] },
      targets: [{ id: "package-1", displayName: "Fixture", prestate: { kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] } }],
    });
    const job = await jobs.submit(scope, candidate);
    const fetcher = vi.fn<FetchLike>(async (_url, request) => request?.method === "PATCH"
      ? Response.json({ error: { code: "Authorization_RequestDenied", message: "Provider rejected the update." } }, { status: 403 })
      : Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false, availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] }));
    await runBulkJob(job.id, scope, false, jobs, new GraphPackagesClient(fetcher), async () => "testing-token");
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "partial", inconclusive: 1 });
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "PATCH")).toHaveLength(1);
  });

  it("rejects wrong-principal execution and application-mode substitution", async () => {
    const wrongPrincipalJob = await jobs.submit(scope, input());
    const authorizeWrongPrincipal = vi.fn(async () => "ephemeral-token");
    await expect(runBulkJob(wrongPrincipalJob.id, { ...scope, principalId: "other-principal" }, true, jobs, new GraphPackagesClient(), authorizeWrongPrincipal)).rejects.toMatchObject({ code: "not_found" });
    expect(authorizeWrongPrincipal).not.toHaveBeenCalled();
    await jobs.cancel(wrongPrincipalJob.id, scope);

    const applicationJob = await jobs.submit(scope, input());
    await fixture.operator.query("ALTER TABLE jobs DISABLE TRIGGER immutable_job_intent");
    try { await fixture.operator.query("UPDATE jobs SET token_mode='application' WHERE id=$1", [applicationJob.id]); }
    finally { await fixture.operator.query("ALTER TABLE jobs ENABLE TRIGGER immutable_job_intent"); }
    const authorizeApplication = vi.fn(async () => "delegated-token");
    await expect(runBulkJob(applicationJob.id, scope, true, jobs, new GraphPackagesClient(), authorizeApplication)).rejects.toMatchObject({ code: "invalid_token_mode" });
    expect(authorizeApplication).not.toHaveBeenCalled();
    expect(await jobs.get(applicationJob.id, scope)).toMatchObject({ tokenMode: "application", canResume: false });
    await jobs.cancel(applicationJob.id, scope);
  });
});