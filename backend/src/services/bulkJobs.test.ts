import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { createJobConfirmation, JobRepository, type JobInput, type JobIntentInput } from "../db/jobs.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { reconcileBulkJob, runBulkJob } from "./bulkJobs.js";
import { GraphPackagesClient, type FetchLike } from "./graphPackages.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let jobs: JobRepository;
const scope = { tenantId: "fixture-tenant", principalId: "fixture-principal" };
const input = (): JobInput => confirmedInput({ targets: [{ id: "package-1", displayName: "Fixture", prestate: { kind: "block", isBlocked: false } }], action: "block", scope: "single", actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: "Fixture", username: "fixture@example.invalid" }, requestPath: "/api/agents/package-1/block" });
function confirmedInput(intent: JobIntentInput): JobInput { return { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash }; }
beforeAll(async () => { fixture = await testDatabase(); jobs = new JobRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

describe("Durable bulk execution", () => {
  it("persists intent before sending and verifies the resulting state", async () => {
    let blocked = false;
    const correlations = new Set<string>();
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      correlations.add(new Headers(request?.headers).get("client-request-id") ?? "");
      if (request?.method === "POST") {
        const sent = await fixture.runtime.query("SELECT 1 FROM job_items WHERE sent_at IS NOT NULL");
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
      event: "job_write_uncertain", jobId: job.id, outcome: "requires_reconciliation",
    });
    log.mockRestore();
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
      event: "job_execution_stopped", jobId: job.id, outcome: "deadline_exceeded",
    });
    log.mockRestore();
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

  it("keeps access writes disabled even with current authorization", async () => {
    const candidate = input();
    candidate.action = "update-availability";
    candidate.accessUpdate = { target: "availability", mode: "replace", scope: "specific", principals: [{ resourceType: "user", resourceId: "user-1" }] };
    candidate.targets = [{ id: "package-1", displayName: "Fixture", prestate: { kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] } }];
    candidate.confirmationHash = createJobConfirmation(candidate).confirmationHash;
    const job = await jobs.submit(scope, candidate);
    let authorizations = 0;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      expect(request?.method).not.toBe("PATCH");
      return Response.json({ id: "package-1", displayName: "Fixture", isBlocked: false, availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [] });
    });
    await runBulkJob(job.id, scope, false, jobs, new GraphPackagesClient(fetcher), async () => `dispatch-token-${++authorizations}`);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "failed", failed: 1 });
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "PATCH")).toHaveLength(0);
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