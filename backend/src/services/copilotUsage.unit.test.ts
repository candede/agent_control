import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { acquireApplicationToken } from "../auth/msal.js";
import { requireUserPublication } from "../db/dataSync.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { directoryNeedsReportRefresh } from "../db/officialReportStatus.js";
import { pool } from "../db/pool.js";
import { activateAccountSession, assertAccountSessionValidation, beginAccountSessionValidation } from "../db/sessions.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { UserSourcesRepository } from "../db/userSources.js";
import { AppError } from "../errors.js";
import type { UserSourceKind, UserSourceMetadata } from "../types/userSources.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { CapabilityId } from "../types/capability.js";
import { CopilotUsageService } from "./copilotUsage.js";
import { UserSourceProvider, streamAppActivity } from "./userSourceProvider.js";
import { parseDirectoryUser, parseReportUser, reportHeaders } from "./userSourceGraphFields.js";
import { activitySourceRecord, directorySourceRecord } from "./userSourceRecords.js";
import { reportIdentity } from "./reportIdentity.js";
import type { FetchLike } from "./graphPackages.js";
import { observePeakMemory, observeTransactionResult } from "./peakMemory.js";

beforeEach(() => { vi.spyOn(UserSourceStages.prototype, "preserveUnseen").mockResolvedValue(0); });

vi.mock("../db/pool.js", () => ({
  pool: { options: { max: 4 },
    query: vi.fn(async () => { throw new Error("Unit tests must not query a database."); }),
    connect: vi.fn(async () => { throw new Error("Unit tests must not open a database connection."); }),
  },
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-copilot-unit-session-secret" : undefined),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("./reportIdentity.js", () => ({
  reportIdentity: vi.fn(async (_database, user: AuthenticatedUser) => ({
    tenantId: user.tenantId!, principalId: user.homeAccountId, sessionEpoch: 0, authorizationHash: "synthetic",
  })),
}));
vi.mock("../db/officialReportStatus.js", async original => ({
  ...await original<typeof import("../db/officialReportStatus.js")>(),
  directoryNeedsReportRefresh: vi.fn(async () => false),
}));
vi.mock("../db/dataSync.js", async original => ({
  ...await original<typeof import("../db/dataSync.js")>(),
  requireUserPublication: vi.fn(async () => undefined),
}));

const now = new Date("2026-10-10T10:00:00.000Z");
const user: AuthenticatedUser = {
  tenantId: "synthetic-user-cadence", homeAccountId: "synthetic-viewer",
  username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"],
};

function sourceMetadata(source: UserSourceKind): UserSourceMetadata {
  return {
    source, generationId: `${source}-saved`, scopeId: `${source}-scope`, revision: "1",
    observedAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
    attemptedAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
    attemptStatus: "available", attemptObservedCount: 0, errorCode: null, message: "Saved source.",
    rowCount: 0, state: "available", reportRefreshDate: source === "app_activity" ? "2026-10-10" : null,
    period: source === "app_activity" ? "D28" : null, reportVersion: source === "app_activity" ? "v2" : null,
  };
}

function fixture(denied: UserSourceKind, status: "waiting_authorization" | "permission_required" | "failed", minutes: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const sources = {
    directory: sourceMetadata("directory"),
    app_activity: sourceMetadata("app_activity"),
  };
  Object.assign(sources[denied], {
    attemptStatus: status, attemptedAt: new Date(now.getTime() - minutes * 60_000).toISOString(),
    state: "partial", message: "The latest source attempt did not complete.",
  });
  const saved = { status: "partial" as const, count: 0, sources };
  const statusRead = vi.spyOn(UserSourcesRepository.prototype, "refreshStatus").mockResolvedValue(saved);
  const provider = new UserSourceProvider();
  const refresh = vi.spyOn(provider, "refresh").mockResolvedValue({
    generationId: randomUUID(), scopeId: randomUUID(), revision: "1",
    rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0,
  });
  const assertAuthority = vi.fn(() => undefined);
  const beginOperationValidation = vi.fn<(capability: CapabilityId, user: AuthenticatedUser) => () => void>(() => assertAuthority);
  const revalidateUser = vi.fn(async () => user), applicationToken = vi.fn<typeof acquireApplicationToken>(async () => "synthetic-token");
  const service = new CopilotUsageService(pool, {
    provider, admissions: () => undefined,
    revalidateUser, applicationToken, requireAvailable: async () => undefined,
    beginOperationValidation,
    observeOperation: async (_capability, _user, operation) => operation(() => undefined),
  });
  return { service, refresh, sources, saved, statusRead, assertAuthority, beginOperationValidation, revalidateUser, applicationToken,
    publication: { runId: randomUUID(), jobId: randomUUID() } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(directoryNeedsReportRefresh).mockReset().mockResolvedValue(false);
  vi.mocked(requireUserPublication).mockReset();
  vi.mocked(requireUserPublication).mockResolvedValue(undefined);
  observeTransactionResult(undefined);
});

describe("Users refresh session boundaries", () => {
  it.each(["identity", "initial-status"] as const)("retains initiating source authority during the %s read", async boundary => {
    const f = fixture("app_activity", "failed", 16);
    let directoryGeneration = 0;
    f.beginOperationValidation.mockImplementation(capability => {
      const generation = directoryGeneration;
      return () => {
        if (capability === "graph.licenses.read" && generation !== directoryGeneration) {
          throw new AppError(401, "authorization_expired", "Directory authority changed.");
        }
      };
    });
    if (boundary === "identity") {
      const read = vi.mocked(reportIdentity).getMockImplementation()!;
      vi.mocked(reportIdentity).mockImplementationOnce(async (database, current) => {
        directoryGeneration++;
        return read(database, current);
      });
    } else f.statusRead.mockImplementationOnce(async () => {
      directoryGeneration++;
      return f.saved;
    });
    f.refresh.mockImplementation(async (_stages, input, options) => {
      await options.authorize(input.scope.source as UserSourceKind, new AbortController().signal);
      return { generationId: randomUUID(), scopeId: randomUUID(), revision: "1",
        rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0 };
    });
    await expect(f.service.refreshUsers(user, undefined, { publication: f.publication }))
      .resolves.toMatchObject({ status: "partial" });
    expect(f.applicationToken.mock.calls.map(([, capability]) => capability)).toEqual(["reports.copilotUsage.read"]);
  });

  it("retains the original session generation while obtaining the report identity", async () => {
    const f = fixture("app_activity", "failed", 16);
    const readIdentity = vi.mocked(reportIdentity).getMockImplementation()!;
    vi.mocked(reportIdentity).mockImplementationOnce(async (database, current) => {
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return readIdentity(database, current);
    });
    await expect(f.service.refreshUsers(user, undefined, { publication: f.publication }))
      .rejects.toMatchObject({ status: 401 });
    expect(f.statusRead).not.toHaveBeenCalled();
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "superseded"] as const)("does not return saved status after the initial read is %s", async boundary => {
    const f = fixture("app_activity", "waiting_authorization", 1), controller = new AbortController();
    f.sources.directory.observedAt = now.toISOString();
    f.statusRead.mockImplementationOnce(async () => {
      if (boundary === "cancelled") controller.abort(new AppError(409, "read_job_cancelled", "Cancelled."));
      else await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
      return f.saved;
    });
    await expect(f.service.refreshUsers(user, controller.signal, { publication: f.publication, automatic: true }))
      .rejects.toMatchObject({ status: boundary === "cancelled" ? 409 : 401 });
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not return a final saved status read superseded by sign-in", async () => {
    const f = fixture("app_activity", "failed", 16);
    f.statusRead.mockResolvedValueOnce(f.saved).mockImplementationOnce(async () => {
      await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
      return f.saved;
    });
    await expect(f.service.refreshUsers(user, undefined, { publication: f.publication }))
      .rejects.toMatchObject({ status: 401 });
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["publication-lock", "progress-write"] as const)("rejects source completion superseded during %s", async boundary => {
    const f = fixture("app_activity", "waiting_authorization", 1);
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const completed = vi.fn();
    const supersede = () => activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
    const write = vi.spyOn(client, "query").mockImplementation(async () => {
      if (boundary === "progress-write") await supersede();
      return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
    });
    if (boundary === "publication-lock") vi.mocked(requireUserPublication).mockImplementationOnce(supersede);
    f.refresh.mockImplementationOnce(async (_stages, input, options) => {
      await options.completeJob?.(client, {
        jobId: input.jobId, runId: input.runId ?? null, source: "directory",
        generationId: randomUUID(), rows: 1, bytes: 1,
      });
      completed();
      return { generationId: randomUUID(), scopeId: randomUUID(), revision: "1",
        rows: 1, children: 0, batches: 1, pages: 1, wireRows: 1, bytes: 1 };
    });
    await expect(f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true }))
      .rejects.toMatchObject({ status: 401 });
    expect(completed).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(boundary === "publication-lock" ? 0 : 1);
  });

  it("does not renew publication authorization under a superseding capability generation", async () => {
    const f = fixture("app_activity", "waiting_authorization", 1);
    const rejected = vi.fn();
    f.refresh.mockImplementationOnce(async (_stages, _input, options) => {
      const signal = new AbortController().signal;
      await options.authorize("directory", signal);
      f.assertAuthority.mockImplementation(() => { throw new AppError(401, "authorization_expired", "Capability authority changed."); });
      try { await options.authorize("directory", signal); }
      catch (error) { rejected(error); throw error; }
      return { generationId: randomUUID(), scopeId: randomUUID(), revision: "1",
        rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0 };
    });
    expect(await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true }))
      .toMatchObject({ status: "partial" });
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: "authorization_expired" }));
    expect(f.revalidateUser).toHaveBeenCalledOnce();
    expect(f.applicationToken).toHaveBeenCalledOnce();
  });

  it("rolls back generation publication superseded after source completion but before COMMIT", async () => {
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const query = vi.spyOn(client, "query").mockImplementation(async sql => ({
      rows: typeof sql === "string" && sql.includes("SELECT generation_id") ? [{ generation_id: null }] : [{ revision: "1" }],
      rowCount: 1, command: "UPDATE", oid: 0, fields: [],
    }));
    const generations = new DataGenerations(database);
    vi.spyOn(generations, "fence").mockResolvedValue({
      row_count: 1, job_kind: "fixture", state: "validating", validated: true,
      job_id: randomUUID(), run_id: null, byte_count: 1,
    });
    const validation = beginAccountSessionValidation(user.tenantId!, user.homeAccountId);
    observeTransactionResult(async () => {
      await activateAccountSession(user.tenantId!, user.homeAccountId, async () => undefined);
      return undefined;
    });
    await expect(generations.publish({
      id: randomUUID(), scopeId: randomUUID(), tenantId: user.tenantId!,
      owner: randomUUID(), version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
    }, { beforeCommit: () => assertAccountSessionValidation(validation) })).rejects.toMatchObject({ status: 401 });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("Users source failure diagnostics", () => {
  it.each(["plain", "details-accessor", "error-details-accessor", "status-accessor", "code-accessor", "code-object",
    "details-proxy", "error-proxy"] as const)(
    "records %s without executing diagnostic accessors or proxy traps", async mode => {
      const trap = vi.fn(() => { throw new Error("Diagnostics must not execute customer code."); });
      let failure = new AppError(502, "report_download_failed", "Synthetic failure.", { httpStatus: 403 });
      if (mode === "details-accessor") Object.defineProperty(failure.details, "httpStatus", { get: trap });
      else if (mode === "error-details-accessor") Object.defineProperty(failure, "details", { get: trap });
      else if (mode === "status-accessor") Object.defineProperty(failure, "status", { get: trap });
      else if (mode === "code-accessor") Object.defineProperty(failure, "code", { get: trap });
      else if (mode === "code-object") Object.defineProperty(failure, "code", { value: { toString: trap } });
      else if (mode === "details-proxy") failure.details = new Proxy({}, { get: trap, has: trap, getOwnPropertyDescriptor: trap });
      else if (mode === "error-proxy") failure = new Proxy(failure, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
      const stages = new UserSourceStages(pool);
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const query = vi.spyOn(client, "query").mockResolvedValue({ rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] });
      const lease = { id: randomUUID(), scopeId: randomUUID(), tenantId: "synthetic-tenant",
        owner: randomUUID(), version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
      vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
      vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
      vi.spyOn(stages.generations, "execute").mockImplementation(async (_input, work) => work(lease, new AbortController().signal));
      const result = await stages.execute({
        scope: { kind: "tenant", tenantId: lease.tenantId, principalId: null,
          tokenMode: "tenant", source: "app_activity", selector: "complete" },
        actorPrincipalId: "synthetic-principal",
        sessionEpoch: "0", schemaVersion: 1, jobKind: "fixture", jobId: randomUUID(),
        observedAt: new Date(), expiresAt: new Date(), deadlineAt: new Date(Date.now() + 60_000), reserveBytes: 1,
      }, async () => { throw failure; }, { beforePublish: async () => undefined })
        .then(() => ({ failure: undefined }), error => ({ failure: error }));
      expect(result.failure === failure).toBe(true);
      expect(trap).not.toHaveBeenCalled();
      const values = query.mock.calls.at(-1)?.[1];
      expect(values).toEqual([lease.id, "failed",
        mode === "error-proxy" || mode === "code-accessor" || mode === "code-object" ? "user_source_failed" : "report_download_failed",
        expect.any(String)]);
      expect(values?.[3]).not.toContain("Synthetic failure.");
      if (mode === "plain" || mode === "status-accessor") expect(values?.[3]).toContain("(HTTP 403)");
      else expect(values?.[3]).not.toContain("(HTTP");
    },
  );
});

describe("Users source deadline and durable publication boundaries", () => {
  function stageFixture() {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const database = new pg.Pool({ max: 4 });
    const stages = new UserSourceStages(database);
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    let commits = 0;
    const query = vi.spyOn(client, "query").mockImplementation(async sql => {
      if (sql === "COMMIT") commits++;
      return {
        rows: typeof sql === "string" && sql.includes("SELECT generation_id") ? [{ generation_id: null }]
          : typeof sql === "string" && sql.includes("RETURNING revision") ? [{ revision: "8" }] : [],
        rowCount: 1, command: sql === "COMMIT" ? "COMMIT" : "UPDATE", oid: 0, fields: [],
      };
    });
    const lease = { id: randomUUID(), scopeId: randomUUID(), tenantId: "synthetic-deadline-tenant",
      owner: randomUUID(), version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "7", schemaVersion: 1 };
    vi.spyOn(stages.generations, "execute").mockImplementation(async (_input, work, signal) =>
      work(lease, signal ?? new AbortController().signal));
    vi.spyOn(stages.generations, "fence").mockResolvedValue({
      row_count: 1, job_kind: "fixture", state: "validating", validated: true,
      job_id: randomUUID(), run_id: null, byte_count: 10,
    });
    const validate = vi.spyOn(stages, "validate").mockResolvedValue(undefined);
    const counts = { rows: 1, children: 0, batches: 1, pages: 1, wireRows: 1, bytes: 10 };
    const readCounts = vi.spyOn(stages, "counts").mockResolvedValue(counts);
    const input = {
      scope: { kind: "tenant" as const, tenantId: lease.tenantId, principalId: null,
        tokenMode: "tenant" as const, source: "app_activity", selector: "complete" },
      actorPrincipalId: "synthetic-principal",
      sessionEpoch: "0", schemaVersion: 1, jobKind: "fixture" as const, jobId: randomUUID(),
      observedAt: now, expiresAt: new Date(now.getTime() + 60_000),
      deadlineAt: new Date(now.getTime() + 1000), reserveBytes: 100,
    };
    return { stages, client, query, validate, counts, readCounts, input, lease, commits: () => commits };
  }

  it.each(["work", "validation", "authorization", "completion", "pre-commit"] as const)(
    "rejects expiry during %s even before the deadline timer gets a turn", async boundary => {
      const f = stageFixture();
      const expire = () => vi.setSystemTime(f.input.deadlineAt);
      const work = vi.fn(async () => { if (boundary === "work") expire(); });
      if (boundary === "validation") f.validate.mockImplementation(async () => { expire(); });
      const beforePublish = vi.fn(async () => { if (boundary === "authorization") expire(); });
      const completeJob = vi.fn(async () => { if (boundary === "completion") expire(); });
      if (boundary === "pre-commit") observeTransactionResult(async () => {
        if (f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("RETURNING revision"))) expire();
        return undefined;
      });
      await expect(f.stages.execute(f.input, work, { beforePublish, completeJob }))
        .rejects.toMatchObject({ status: 504, code: "provider_timeout" });
      expect(f.commits()).toBe(2); // Attempt creation and failure recording, never publication.
      if (boundary === "completion" || boundary === "pre-commit") expect(f.query).toHaveBeenCalledWith("ROLLBACK");
      if (boundary === "work" || boundary === "validation") expect(beforePublish).not.toHaveBeenCalled();
      if (["work", "validation", "authorization"].includes(boundary)) expect(completeJob).not.toHaveBeenCalled();
    },
  );

  it("aborts a pending provider request at the persisted source deadline and disposes its late body", async () => {
    const f = stageFixture();
    f.input.scope.source = "directory";
    vi.spyOn(f.stages, "query").mockResolvedValue("synthetic-query");
    vi.spyOn(f.stages, "assertNewPage").mockResolvedValue(undefined);
    const delivery = Promise.withResolvers<Response>();
    const fetcher = vi.fn<FetchLike>(() => delivery.promise);
    const cancel = vi.fn();
    const settled = Promise.allSettled([new UserSourceProvider(fetcher).refresh(f.stages, f.input, {
      authorize: async () => "synthetic-token",
    })]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await Promise.race([settled, Promise.resolve("still pending")]))
        .toMatchObject([{ status: "rejected", reason: { code: "provider_timeout" } }]);
      delivery.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
      await vi.advanceTimersByTimeAsync(0);
      await settled;
      expect(cancel).toHaveBeenCalledOnce();
      expect(f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("RETURNING revision"))).toBe(false);
    } finally {
      delivery.resolve(new Response(null));
      await settled;
    }
  });

  it.each(["client-release", "after-commit-observer", "late-count-read"] as const)(
    "retains durable success despite %s without recording a failed source", async boundary => {
      const f = stageFixture();
      const failure = new Error("Synthetic post-commit failure.");
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      if (boundary === "client-release") f.client.release.mockImplementation(() => {
        if (f.commits() === 2) throw failure;
      });
      else if (boundary === "after-commit-observer") observeTransactionResult(async () => () => {
        if (f.commits() === 2) throw failure;
      });
      else f.readCounts.mockImplementation(async () => {
        if (f.commits() === 2) throw failure;
        return f.counts;
      });
      await expect(f.stages.execute(f.input, async () => undefined, { beforePublish: async () => undefined }))
        .resolves.toEqual({ generationId: f.lease.id, scopeId: f.lease.scopeId, revision: "8", ...f.counts });
      expect(f.commits()).toBe(2);
      expect(f.readCounts).toHaveBeenCalledOnce();
      expect(f.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("AND status='running'"))).toBe(false);
      if (boundary !== "late-count-read") expect(warning).toHaveBeenCalledWith(expect.stringContaining("user_source_publication_cleanup_failed"));
    },
  );
});

describe("Users provider HTTP failure boundaries", () => {
  function providerFixture(fetcher: FetchLike) {
    const stages = new UserSourceStages(pool), wait = vi.fn(async () => undefined);
    if (vi.isFakeTimers()) vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out.", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    vi.spyOn(stages, "query").mockResolvedValue("synthetic-query");
    vi.spyOn(stages, "assertNewPage").mockResolvedValue(undefined);
    const provider = new UserSourceProvider(fetcher, wait);
    const lease = { id: randomUUID(), scopeId: randomUUID(), tenantId: "synthetic-tenant",
      owner: randomUUID(), version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
    return { provider, stages, lease, wait };
  }

  it.each((["directory", "report", "signed-download"] as const).flatMap(source =>
    (["cancelled", "timeout"] as const).map(boundary => ({ source, boundary })),
  ))("settles $source $boundary without cooperative fetch and disposes a late redirect", async ({ source, boundary }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new AppError(409, "read_job_cancelled", "Cancelled source collection.");
    const delivery = Promise.withResolvers<Response>();
    const cancel = vi.fn();
    const late = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      status: 302, headers: { location: "https://reports.office.com/data/download/late" },
    });
    let requests = 0;
    const fetcher = vi.fn<FetchLike>(async () => source === "signed-download" && ++requests === 1
      ? new Response(null, { status: 302, headers: { location: "https://reports.office.com/data/download/synthetic" } })
      : delivery.promise);
    const f = providerFixture(fetcher);
    let outcome: unknown;
    const operation = source === "directory"
      ? f.provider.directory(f.stages, f.lease, "synthetic-token", controller.signal)
      : f.provider.activity(f.stages, f.lease, "synthetic-token", controller.signal);
    const settled = operation.then(() => { outcome = "unexpected success"; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(source === "signed-download" ? 2 : 1);
      if (boundary === "cancelled") controller.abort(reason);
      await vi.advanceTimersByTimeAsync(boundary === "timeout" ? 15_000 : 0);
      if (boundary === "cancelled") expect(outcome).toBe(reason);
      else expect(outcome).toMatchObject({ status: 504, code: "provider_timeout" });
      delivery.resolve(late);
      await settled;
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(source === "signed-download" ? 2 : 1);
      expect(f.wait).not.toHaveBeenCalled();
    } finally {
      controller.abort(reason);
      delivery.resolve(late);
      await settled;
    }
  });

  it("reports a stalled successful JSON body as a provider timeout without staging a page", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    const f = providerFixture(fetcher);
    const page = vi.spyOn(f.stages, "page").mockRejectedValue(new Error("An incomplete page must not be staged."));
    const settled = Promise.allSettled([
      f.provider.directory(f.stages, f.lease, "synthetic-token", new AbortController().signal),
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toMatchObject([{ status: "rejected", reason: { status: 504, code: "provider_timeout" } }]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(page).not.toHaveBeenCalled();
    expect(f.wait).not.toHaveBeenCalled();
  });

  it("retains revoked source authority when a noncooperative request reaches its deadline", async () => {
    vi.useFakeTimers();
    const reason = new AppError(401, "authorization_expired", "Source authority changed.");
    const delivery = Promise.withResolvers<Response>();
    const fetcher = vi.fn<FetchLike>(() => delivery.promise), f = providerFixture(fetcher);
    let current = true;
    const settled = Promise.allSettled([f.provider.directory(f.stages, f.lease, "synthetic-token",
      new AbortController().signal, undefined, () => { if (!current) throw reason; })]);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toMatchObject([{ status: "rejected", reason }]);
    delivery.resolve(new Response(null));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.wait).not.toHaveBeenCalled();
  });

  it.each(["catalog", "discovery", "identity"] as const)(
    "rejects an empty %s continuation instead of completing the source", async source => {
      const skuId = "639dec6b-bb19-468b-871c-c5c441c4b0cb";
      const fetcher = vi.fn<FetchLike>(async target => {
        const url = new URL(String(target));
        const current = url.pathname.endsWith("subscribedSkus") ? "catalog"
          : url.searchParams.get("$filter")!.includes("assignedLicenses") ? "discovery" : "identity";
        return Response.json({
          value: [],
          ...(current === "catalog" ? {} : { "@odata.count": 0 }),
          ...(current === source ? { "@odata.nextLink": "" } : {}),
        });
      });
      const f = providerFixture(fetcher);
      vi.spyOn(f.stages, "page").mockResolvedValue(undefined);
      const finish = vi.spyOn(f.stages, "finishQuery").mockResolvedValue(undefined);
      vi.spyOn(f.stages, "skuBatch").mockResolvedValueOnce(source === "discovery"
        ? [{ skuId, servicePlanIds: ["a62f8878-de10-42f3-b68f-6149a25ceb97"] }] : []).mockResolvedValue([]);
      vi.spyOn(f.stages, "verificationBatch").mockResolvedValueOnce(source === "identity"
        ? ["reported@example.invalid"] : []).mockResolvedValue([]);
      const verified = vi.spyOn(f.stages, "verified").mockRejectedValue(new Error("Unexpected verification completion."));
      vi.spyOn(f.stages, "progress").mockResolvedValue(0);

      await expect(f.provider.directory(f.stages, f.lease, "synthetic-token", new AbortController().signal))
        .rejects.toMatchObject({ status: 502, code: "invalid_provider_link" });
      expect(fetcher).toHaveBeenCalledTimes(source === "catalog" ? 1 : 2);
      expect(finish).toHaveBeenCalledTimes(source === "catalog" ? 0 : 1);
      expect(verified).not.toHaveBeenCalled();
    },
  );

  it.each((["catalog", "discovery", "identity"] as const).flatMap(source =>
    ["projection", "extra", ...(source === "catalog" ? [] : ["count", "page-size", "filter"])].map(change => ({ source, change })),
  ))("rejects $source continuation query drift ($change) before another authenticated request", async ({ source, change }) => {
    const skuId = "639dec6b-bb19-468b-871c-c5c441c4b0cb";
    let returnedContinuation = false;
    const fetcher = vi.fn<FetchLike>(async target => {
      if (returnedContinuation) throw new Error("Unbounded continuation was dispatched.");
      const url = new URL(String(target));
      const current = url.pathname.endsWith("subscribedSkus") ? "catalog"
        : url.searchParams.get("$filter")!.includes("assignedLicenses") ? "discovery" : "identity";
      const next = new URL(url);
      next.searchParams.set("$skiptoken", "next");
      if (change === "projection") next.searchParams.set("$select", "id,userPrincipalName,assignedLicenses,assignedPlans");
      else if (change === "extra") next.searchParams.set("$expand", "manager");
      else if (change === "count") next.searchParams.set("$count", "false");
      else if (change === "page-size") next.searchParams.set("$top", "1000");
      else next.searchParams.set("$filter", "accountEnabled eq true");
      returnedContinuation = current === source;
      return Response.json({ value: [], ...(current === "catalog" ? {} : { "@odata.count": 0 }),
        ...(current === source ? { "@odata.nextLink": next.toString() } : {}) });
    });
    const f = providerFixture(fetcher);
    vi.spyOn(f.stages, "page").mockResolvedValue(undefined);
    const finish = vi.spyOn(f.stages, "finishQuery").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "skuBatch").mockResolvedValueOnce(source === "discovery"
      ? [{ skuId, servicePlanIds: ["a62f8878-de10-42f3-b68f-6149a25ceb97"] }] : []).mockResolvedValue([]);
    vi.spyOn(f.stages, "verificationBatch").mockResolvedValueOnce(source === "identity"
      ? ["reported@example.invalid"] : []).mockResolvedValue([]);
    const verified = vi.spyOn(f.stages, "verified").mockRejectedValue(new Error("Unexpected verification completion."));
    vi.spyOn(f.stages, "progress").mockResolvedValue(0);
    await expect(f.provider.directory(f.stages, f.lease, "synthetic-token", new AbortController().signal))
      .rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(source === "catalog" ? 1 : 2);
    expect(finish).toHaveBeenCalledTimes(source === "catalog" ? 0 : 1);
    expect(verified).not.toHaveBeenCalled();
  });

  it.each(["catalog", "discovery", "identity"] as const)("follows a bounded %s continuation without changing opaque tokens", async source => {
    const skuId = "639dec6b-bb19-468b-871c-c5c441c4b0cb", token = "opaque+/=%token";
    const fetcher = vi.fn<FetchLike>(async target => {
      const url = new URL(String(target));
      const current = url.pathname.endsWith("subscribedSkus") ? "catalog"
        : url.searchParams.get("$filter")!.includes("assignedLicenses") ? "discovery" : "identity";
      const next = new URL(url);
      next.searchParams.set("$skiptoken", token);
      if (url.searchParams.has("$skiptoken")) expect(url.searchParams.get("$skiptoken")).toBe(token);
      return Response.json({ value: [], ...(current === "catalog" ? {} : { "@odata.count": 0 }),
        ...(current === source && !url.searchParams.has("$skiptoken") ? { "@odata.nextLink": next.toString() } : {}) });
    });
    const f = providerFixture(fetcher);
    vi.spyOn(f.stages, "page").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "finishQuery").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "skuBatch").mockResolvedValueOnce(source === "discovery"
      ? [{ skuId, servicePlanIds: ["a62f8878-de10-42f3-b68f-6149a25ceb97"] }] : []).mockResolvedValue([]);
    vi.spyOn(f.stages, "verificationBatch").mockResolvedValueOnce(source === "identity"
      ? ["reported@example.invalid"] : []).mockResolvedValue([]);
    vi.spyOn(f.stages, "verified").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "progress").mockResolvedValue(0);
    await expect(f.provider.directory(f.stages, f.lease, "synthetic-token", new AbortController().signal)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(source === "catalog" ? 2 : 3);
  });

  it.each(["/data/download/report?format=json", "/data/v1.0/download?token=signed&format=json"])(
    "rejects undocumented signed download queries before dispatch: %s", async path => {
      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 302,
        headers: { location: `https://reports.office.com${path}` } }));
      const f = providerFixture(fetcher);
      await expect(f.provider.activity(f.stages, f.lease, "synthetic-token", new AbortController().signal))
        .rejects.toMatchObject({ status: 502, code: "invalid_provider_link" });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(["catalog-continuation", "signed-download", "throttle-retry"] as const)(
    "stops %s dispatch when source authority changes during a provider await", async boundary => {
      const reason = new AppError(401, "authorization_expired", "Source authority changed.");
      let current = true;
      let fetched = 0;
      const assertCurrent = () => { if (!current) throw reason; };
      const fetcher = vi.fn<FetchLike>(async () => {
        current = false;
        if (boundary === "signed-download") return new Response(null, { status: 302,
          headers: { location: "https://reports.office.com/data/download/synthetic" } });
        if (boundary === "throttle-retry") return Response.json({}, { status: 429, headers: { "Retry-After": "1" } });
        return Response.json({ value: [], ...(++fetched === 1
          ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/subscribedSkus?$skiptoken=next" } : {}) });
      });
      const f = providerFixture(fetcher);
      vi.spyOn(f.stages, "page").mockResolvedValue(undefined);
      vi.spyOn(f.stages, "finishQuery").mockResolvedValue(undefined);
      vi.spyOn(f.stages, "skuBatch").mockResolvedValue([]);
      vi.spyOn(f.stages, "verificationBatch").mockResolvedValue([]);
      vi.spyOn(f.stages, "progress").mockResolvedValue(0);
      vi.spyOn(f.stages, "execute").mockImplementation(async (_input, work) => {
        await work(f.lease, new AbortController().signal);
        assertCurrent();
        return { generationId: f.lease.id, scopeId: f.lease.scopeId, revision: "1",
          rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0 };
      });
      await expect(f.provider.refresh(f.stages, {
        scope: { kind: "tenant", tenantId: f.lease.tenantId, principalId: null,
          tokenMode: "tenant", source: boundary === "signed-download" ? "app_activity" : "directory", selector: "complete" },
        actorPrincipalId: user.homeAccountId,
        sessionEpoch: "0", schemaVersion: 1, jobKind: "data_sync", jobId: randomUUID(), runId: randomUUID(),
        observedAt: now, expiresAt: now, deadlineAt: now, reserveBytes: 1,
      }, { authorize: async () => "synthetic-token", assertCurrent })).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(f.wait).not.toHaveBeenCalled();
    },
  );

  it.each(["before-reader", "next-row"] as const)("cancels a report body losing authority at %s", async boundary => {
    const reason = new AppError(401, "authorization_expired", "Report authority changed.");
    let current = boundary !== "before-reader", cancelled = false;
    const day = "2026-10-10";
    const csv = `${reportHeaders.join(",")}\n${["one", "two"].map(name =>
      [day, `${name}@example.invalid`, name, day, "", "", "", "", "", "", "", "", "28"].join(","),
    ).join("\n")}\n`;
    let continueBody: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(csv));
        continueBody = () => controller.enqueue(new TextEncoder().encode("\n"));
      },
      cancel() { cancelled = true; },
    });
    const rows = streamAppActivity(new Response(body), new AbortController().signal,
      () => { if (!current) throw reason; });
    try {
      if (boundary === "next-row") {
        expect((await rows.next()).value).toMatchObject({ normalizedUserPrincipalName: "one@example.invalid" });
        current = false;
        continueBody();
      }
      await expect(rows.next()).rejects.toBe(reason);
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally { await rows.return(undefined); }
  });

  it.each((["directory", "app_activity"] as const).flatMap(source =>
    [401, 403, 429].map(status => ({ source, status })),
  ))("preserves $source HTTP $status and Retry-After when the Graph error body stalls", async ({ source, status }) => {
    vi.useFakeTimers();
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }),
      { status, headers: { "Retry-After": "601" } });
    const fetcher = vi.fn<FetchLike>(async () => response), f = providerFixture(fetcher);
    const signal = new AbortController().signal;
    const result = source === "directory" ? f.provider.directory(f.stages, f.lease, "synthetic-token", signal)
      : f.provider.activity(f.stages, f.lease, "synthetic-token", signal);
    const settled = Promise.allSettled([result]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toMatchObject([{ status: "rejected", reason: { status, details: { httpStatus: status, retryAfterMs: 601_000 } } }]);
    expect(cancelled).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.wait).not.toHaveBeenCalled();
  });

  it("retries a received throttle after an error-body deadline using its Retry-After", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>(), { status: 429, headers: { "Retry-After": "3" } }))
      .mockResolvedValueOnce(Response.json({ value: [] }));
    const f = providerFixture(fetcher);
    vi.spyOn(f.stages, "page").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "finishQuery").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "skuBatch").mockResolvedValue([]);
    vi.spyOn(f.stages, "verificationBatch").mockResolvedValue([]);
    vi.spyOn(f.stages, "progress").mockResolvedValue(0);
    const result = f.provider.directory(f.stages, f.lease, "synthetic-token", new AbortController().signal);
    const settled = Promise.allSettled([result]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled).toMatchObject([{ status: "fulfilled" }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.wait).toHaveBeenCalledWith(3000, expect.any(AbortSignal));
  });

  it("honors source cancellation rather than recovering an observed error as a retry", async () => {
    const controller = new AbortController(), reason = new AppError(409, "read_job_cancelled", "Cancelled.");
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream<Uint8Array>(), { status: 429 }));
    const f = providerFixture(fetcher);
    const settled = Promise.allSettled([f.provider.directory(f.stages, f.lease, "synthetic-token", controller.signal)]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(reason);
    expect(await settled).toMatchObject([{ status: "rejected", reason }]);
    expect(f.wait).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([403, 429])("preserves signed-host HTTP %i Retry-After without treating it as Graph authorization", async status => {
    const fetcher = vi.fn<FetchLike>(async url => String(url).startsWith("https://graph.microsoft.com/")
      ? new Response(null, { status: 302, headers: { location: "https://reports.office.com/data/download/synthetic" } })
      : new Response(null, { status, headers: { "Retry-After": "601" } }));
    const f = providerFixture(fetcher);
    await expect(f.provider.activity(f.stages, f.lease, "synthetic-token", new AbortController().signal))
      .rejects.toMatchObject({ status: 502, code: "report_download_failed", details: { httpStatus: status, retryAfterMs: 601_000 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.wait).not.toHaveBeenCalled();
  });

  it.each([0, 3])("rejects a year-zero CSV date at column %i before staging activity", async column => {
    const row = ["2026-10-10", "person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28"];
    row[column] = "0000-01-01";
    const fetcher = vi.fn<FetchLike>(async () => new Response(`${reportHeaders.join(",")}\n${row.join(",")}\n`));
    const f = providerFixture(fetcher);
    const page = vi.spyOn(f.stages, "page").mockRejectedValue(new Error("Invalid dates must not stage a page."));
    const activity = vi.spyOn(f.stages, "activity").mockRejectedValue(new Error("Invalid dates must not reach storage."));
    await expect(f.provider.activity(f.stages, f.lease, "synthetic-token", new AbortController().signal))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(page).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  });

  it.each(["report_refresh_date", "last_activity_date"] as const)(
    "rejects a year-zero typed %s before appending records", async field => {
      const f = providerFixture(vi.fn<FetchLike>());
      const row = activitySourceRecord(parseReportUser([
        "2026-10-10", "person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28",
      ]), 1);
      row[field] = "0000-01-01";
      const append = vi.spyOn(f.stages, "append").mockRejectedValue(new Error("Invalid dates must not be appended."));
      await expect(f.stages.activity(f.lease, "synthetic-query", [row]))
        .rejects.toMatchObject({ status: 502, code: "provider_schema" });
      expect(append).not.toHaveBeenCalled();
    },
  );

  it.each(["directory", "activity"] as const)("rejects accessor-backed %s staging batches before serialization or persistence", async kind => {
    const f = providerFixture(vi.fn<FetchLike>());
    const getter = vi.fn(() => { throw new Error("Staging must not execute source getters."); });
    const batch = Object.defineProperty([], "0", { get: getter, enumerable: true });
    const append = vi.spyOn(f.stages, "append").mockResolvedValue(undefined);
    const result = kind === "directory" ? f.stages.directory(f.lease, "synthetic-query", batch)
      : f.stages.activity(f.lease, "synthetic-query", batch);
    const error = await result.catch(failure => failure);
    expect(getter).not.toHaveBeenCalled();
    expect(error).toMatchObject({ status: 502, code: "provider_schema" });
    expect(append).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("stages child evidence from the same snapshot as the parent hash after an asynchronous lookup", async () => {
    const f = providerFixture(vi.fn<FetchLike>());
    const servicePlanId = "a62f8878-de10-42f3-b68f-6149a25ceb97", skuId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const original = parseDirectoryUser({
      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", userPrincipalName: "person@example.invalid",
      assignedLicenses: [{ skuId, disabledPlans: [] }],
      assignedPlans: [{ servicePlanId, service: "Copilot", capabilityStatus: "Enabled", assignedDateTime: "2026-01-01T00:00:00Z" }],
    }, new Map([[skuId, [servicePlanId]]]), { kind: "products", skuIds: [skuId] })!;
    const expected = directorySourceRecord(original);
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT identity")) original.servicePlans[0].assignedDateTime = "2026-02-01T00:00:00Z";
      return { rows: sql.startsWith("SELECT byte_count") ? [{ byte_count: 0, reserved_bytes: 1_000_000 }] : [], rowCount: 0 };
    });
    const client = { query } as unknown as pg.PoolClient;
    vi.spyOn(f.stages.generations, "fence").mockResolvedValue({ state: "staging" });
    vi.spyOn(f.stages.generations.connections, "run").mockImplementation(async work => work(client));
    const append = vi.spyOn(f.stages, "append").mockResolvedValue(undefined);
    await f.stages.directory(f.lease, "synthetic-query", [original]);
    expect(append).toHaveBeenCalledWith(f.lease, "directory", [expected]);
    const children = append.mock.calls.find(([, kind]) => kind === "plans")?.[2];
    expect(children).toMatchObject([{ assigned_at: "2026-01-01T00:00:00.000Z" }]);
    expect(original.servicePlans[0].assignedDateTime).toBe("2026-02-01T00:00:00Z");
  });

  it.each(["toJSON", "cyclic", "nonfinite", "sparse-residual"] as const)(
    "rejects %s activity residuals before handing evidence to persistence", async boundary => {
      const f = providerFixture(vi.fn<FetchLike>());
      const row = activitySourceRecord(parseReportUser([
        "2026-10-10", "person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28",
      ]), 1);
      const serialize = vi.fn(() => { throw new Error("Source residuals must be owned data."); });
      if (boundary === "toJSON") row.residual = { toJSON: serialize };
      if (boundary === "cyclic") row.residual.self = row.residual;
      if (boundary === "nonfinite") row.residual.value = Infinity;
      if (boundary === "sparse-residual") row.residual.value = Object.assign(new Array(1), { 4294967295: "outside-index-range" });
      const append = vi.spyOn(f.stages, "append").mockResolvedValue(undefined);
      await expect(f.stages.activity(f.lease, "synthetic-query", [row])).rejects.toMatchObject({ code: "provider_schema" });
      expect(serialize).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it.each(["null-row", "array-row", "null-residual", "missing-residual", "blank-date"] as const)(
    "fails %s activity evidence explicitly before appending a batch", async boundary => {
      const f = providerFixture(vi.fn<FetchLike>());
      const row = activitySourceRecord(parseReportUser([
        "2026-10-10", "person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28",
      ]), 1);
      const rows = [row];
      if (boundary === "null-row") Object.defineProperty(rows, "0", { value: null });
      if (boundary === "array-row") Object.defineProperty(rows, "0", { value: [] });
      if (boundary === "null-residual") Object.defineProperty(row, "residual", { value: null });
      if (boundary === "missing-residual") Reflect.deleteProperty(row, "residual");
      if (boundary === "blank-date") row.last_activity_date = "";
      const append = vi.spyOn(f.stages, "append").mockResolvedValue(undefined);
      await expect(f.stages.activity(f.lease, "synthetic-query", rows)).rejects.toMatchObject({ status: 502, code: "provider_schema" });
      expect(append).not.toHaveBeenCalled();
    },
  );

  it("accepts a bounded lowercased activity key expanded from the provider identity", async () => {
    const f = providerFixture(vi.fn<FetchLike>());
    const upn = `${"İ".repeat(200)}@example.invalid`;
    const row = activitySourceRecord(parseReportUser([
      "2026-10-10", upn, "Person", "", "", "", "", "", "", "", "", "", "28",
    ]), 1);
    vi.spyOn(f.stages, "append").mockResolvedValue(undefined);
    vi.spyOn(f.stages.generations, "fence").mockResolvedValue({ state: "staging" });
    const query = vi.fn(async (sql: string) => ({
      rows: sql.startsWith("SELECT byte_count") ? [{ byte_count: 0, reserved_bytes: 1_000_000 }] : [],
    }));
    vi.spyOn(f.stages.generations.connections, "run").mockImplementation(async work => work({ query } as unknown as pg.PoolClient));
    await expect(f.stages.activity(f.lease, "synthetic-query", [row])).resolves.toBeUndefined();
    expect(f.stages.append).toHaveBeenCalledWith(f.lease, "activity", [expect.objectContaining({ upn_key: upn.toLowerCase() })]);
  });

  it("copies borrowed CSV chunks before yielding decoded slices under backpressure", async () => {
    const line = ["2026-10-10", "person@example.invalid", "x".repeat(512), "", "", "", "", "", "", "", "", "", "28"].join(",") + "\n";
    const borrowed = Buffer.from(`${reportHeaders.join(",")}\n${line.repeat(1000)}`);
    const rows = streamAppActivity(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(borrowed); controller.close(); },
    })), new AbortController().signal);
    let count = 0;
    try {
      expect((await rows.next()).value).toMatchObject({ normalizedUserPrincipalName: "person@example.invalid" });
      count++;
      borrowed.fill(0xff, 64 * 1024);
      for await (const row of rows) {
        expect(row.normalizedUserPrincipalName).toBe("person@example.invalid");
        count++;
      }
      expect(count).toBe(1000);
    } finally { await rows.return(undefined); }
  });

  it("preserves the CSV byte-limit error through Node stream isolation and releases its reader", async () => {
    const limit = 64 * 1024 ** 2;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(limit + 1)); },
      cancel,
    });
    const consume = async () => {
      for await (const row of streamAppActivity(new Response(body), new AbortController().signal)) void row;
    };
    await expect(consume()).rejects.toMatchObject({ code: "provider_report_bytes", details: { limit, observed: limit + 1 } });
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each((["json", "csv"] as const).flatMap(format =>
    (["proxy", "message-accessor"] as const).map(boundary => ({ format, boundary })),
  ))("does not execute $boundary diagnostics when a $format transport rejects", async ({ format, boundary }) => {
    const trap = vi.fn(() => { throw new Error("Error handling must not execute transport code."); });
    const original = new Error("Synthetic transport failure.");
    const failure = boundary === "proxy" ? new Proxy(original, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }) : original;
    if (boundary === "message-accessor") Object.defineProperty(original, "message", { get: trap });
    const f = providerFixture(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure); },
    })));
    const operation = format === "json"
      ? f.provider.directory(f.stages, f.lease, "synthetic-token", new AbortController().signal)
      : f.provider.activity(f.stages, f.lease, "synthetic-token", new AbortController().signal);
    const result = await operation.then(() => ({ error: undefined }), error => ({ error }));
    expect(trap).not.toHaveBeenCalled();
    if (format === "json") expect(result.error === failure).toBe(true);
    else expect(result.error).toMatchObject({ code: "provider_schema" });
  });

  it.each(["code-accessor", "error-proxy"] as const)("summarizes %s source failures without executing customer code", async boundary => {
    const trap = vi.fn(() => { throw new Error("Summary must not execute diagnostic code."); });
    const original = new AppError(502, "provider_schema", "Synthetic provider failure.");
    const failure = boundary === "error-proxy" ? new Proxy(original, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }) : original;
    if (boundary === "code-accessor") Object.defineProperty(original, "code", { get: trap });
    const f = providerFixture(vi.fn<FetchLike>());
    vi.spyOn(f.provider, "refresh").mockRejectedValue(failure);
    const repository = new UserSourcesRepository(pool, "synthetic-source-summary-secret-at-least-32-bytes");
    vi.spyOn(repository, "refreshStatus").mockResolvedValue({
      status: "succeeded", count: 0, sources: { directory: sourceMetadata("directory"), app_activity: sourceMetadata("app_activity") },
    });
    const identity = { tenantId: f.lease.tenantId, principalId: "synthetic-principal", sessionEpoch: "0", authorizationHash: "synthetic" };
    const input = {
      scope: { kind: "tenant" as const, tenantId: identity.tenantId, principalId: null,
        tokenMode: "tenant" as const, source: "directory", selector: "complete" },
      actorPrincipalId: identity.principalId,
      sessionEpoch: "0", schemaVersion: 1, jobKind: "fixture" as const, jobId: randomUUID(),
      observedAt: now, expiresAt: now, deadlineAt: now, reserveBytes: 1,
    };
    const result = await f.provider.refreshSources(f.stages, repository, identity, [input], { authorize: async () => "synthetic-token" });
    expect(trap).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "partial", outcomes: [{ errorCode: "user_source_failed" }] });
  });

  it.each(["code-accessor", "error-proxy"] as const)("preserves %s batch failures without executing diagnostic code", async boundary => {
    const trap = vi.fn(() => { throw new Error("Batch failure handling must not execute diagnostic code."); });
    const original = new AppError(413, "data_batch_bytes", "Synthetic batch failure.");
    const failure = boundary === "error-proxy" ? new Proxy(original, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }) : original;
    if (boundary === "code-accessor") Object.defineProperty(original, "code", { get: trap });
    const f = providerFixture(vi.fn<FetchLike>());
    const rows = Array.from({ length: 2 }, (_, index) => activitySourceRecord(parseReportUser([
      "2026-10-10", "person@example.invalid", "Person", "", "", "", "", "", "", "", "", "", "28",
    ]), index + 1));
    const remove = observePeakMemory(() => { throw failure; });
    try {
      const result = await f.stages.append(f.lease, "activity", rows).then(() => ({ error: undefined }), error => ({ error }));
      expect(trap).not.toHaveBeenCalled();
      expect(result.error === failure).toBe(true);
    } finally { remove(); }
  });

  it("rechecks source authority before the publication authorization callback", async () => {
    const f = providerFixture(vi.fn<FetchLike>()), reason = new AppError(401, "authorization_expired", "Source authority changed.");
    let current = true;
    const authorize = vi.fn(async () => "synthetic-token");
    vi.spyOn(f.provider, "directory").mockResolvedValue(undefined);
    vi.spyOn(f.stages, "execute").mockImplementation(async (_input, work, options) => {
      const signal = new AbortController().signal;
      await work(f.lease, signal);
      current = false;
      await options.beforePublish(signal);
      return { generationId: f.lease.id, scopeId: f.lease.scopeId, revision: "1",
        rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0 };
    });
    await expect(f.provider.refresh(f.stages, {
      scope: { kind: "tenant", tenantId: f.lease.tenantId, principalId: null,
        tokenMode: "tenant", source: "directory", selector: "complete" },
      actorPrincipalId: "synthetic-principal",
      sessionEpoch: "0", schemaVersion: 1, jobKind: "fixture", jobId: randomUUID(),
      observedAt: now, expiresAt: now, deadlineAt: now, reserveBytes: 1,
    }, { authorize, assertCurrent: () => { if (!current) throw reason; } })).rejects.toBe(reason);
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("does not return a source summary cancelled during its saved-status read", async () => {
    const f = providerFixture(vi.fn<FetchLike>()), controller = new AbortController();
    const reason = new AppError(409, "read_job_cancelled", "Cancelled.");
    vi.spyOn(f.provider, "refresh").mockResolvedValue({ generationId: f.lease.id, scopeId: f.lease.scopeId, revision: "1",
      rows: 0, children: 0, batches: 0, pages: 1, wireRows: 0, bytes: 0 });
    const repository = new UserSourcesRepository(pool, "synthetic-source-summary-secret-at-least-32-bytes");
    vi.spyOn(repository, "refreshStatus").mockImplementation(async () => {
      controller.abort(reason);
      return { status: "succeeded", count: 0, sources: { directory: sourceMetadata("directory"), app_activity: sourceMetadata("app_activity") } };
    });
    const identity = { tenantId: f.lease.tenantId, principalId: "synthetic-principal", sessionEpoch: "0", authorizationHash: "synthetic" };
    await expect(f.provider.refreshSources(f.stages, repository, identity, [{
      scope: { kind: "tenant", tenantId: identity.tenantId, principalId: null,
        tokenMode: "tenant", source: "directory", selector: "complete" },
      actorPrincipalId: identity.principalId,
      sessionEpoch: "0", schemaVersion: 1, jobKind: "fixture", jobId: randomUUID(),
      observedAt: now, expiresAt: now, deadlineAt: now, reserveBytes: 1,
    }], { authorize: async () => "synthetic-token", signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("automatic Users source cadence", () => {
  it.each(["not_collected", "invalidated"] as const)("automatically collects both sources when saved data is %s", async state => {
    const f = fixture("app_activity", "failed", 16);
    for (const metadata of Object.values(f.sources)) {
      Object.assign(metadata, {
        generationId: null, scopeId: null, revision: null, rowCount: null, state: "unavailable",
        observedAt: state === "not_collected" ? null : now.toISOString(),
        attemptedAt: state === "not_collected" ? null : now.toISOString(),
        attemptStatus: state === "not_collected" ? null : "available",
      });
    }
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source)).toEqual(["directory", "app_activity"]);
  });

  it.each([true, false])("refreshes a fresh directory for a changed report without recollecting fresh activity or repeating acknowledged work, automatic: %s", async automatic => {
    const f = fixture("app_activity", "failed", 16);
    for (const source of Object.values(f.sources)) {
      Object.assign(source, { attemptStatus: "available", observedAt: now.toISOString(), attemptedAt: now.toISOString() });
    }
    vi.mocked(directoryNeedsReportRefresh).mockResolvedValueOnce(true);
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic, incompleteOnly: true });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source)).toEqual(["directory"]);
    expect(directoryNeedsReportRefresh).toHaveBeenCalledWith(pool, { tenantId: user.tenantId, principalId: user.homeAccountId });
    f.refresh.mockClear();
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic, incompleteOnly: true });
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("surfaces a failed report-context check instead of treating the directory as current", async () => {
    const f = fixture("app_activity", "failed", 16), failure = new Error("Report context unavailable.");
    vi.mocked(directoryNeedsReportRefresh).mockRejectedValueOnce(failure);
    await expect(f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true })).rejects.toBe(failure);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("fences cancellation while checking whether a report changed", async () => {
    const f = fixture("app_activity", "failed", 16), controller = new AbortController(), reason = new Error("Cancelled.");
    vi.mocked(directoryNeedsReportRefresh).mockImplementationOnce(async () => { controller.abort(reason); return true; });
    await expect(f.service.refreshUsers(user, controller.signal, { publication: f.publication, automatic: true })).rejects.toBe(reason);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it.each((["directory", "app_activity"] as const).flatMap(source =>
    (["waiting_authorization", "permission_required"] as const).map(status => ({ source, status })),
  ))("keeps a mixed $source $status failure cooling down despite a changed report while refreshing the healthy source", async ({ source, status }) => {
    const f = fixture(source, status, 16);
    vi.mocked(directoryNeedsReportRefresh).mockResolvedValue(true);
    expect(await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true }))
      .toMatchObject({ status: "partial" });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source))
      .toEqual([source === "directory" ? "app_activity" : "directory"]);
  });

  it.each(["directory", "app_activity"] as const)("retries an ordinary %s failure after one hour", async source => {
    const f = fixture(source, "failed", 60);
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true });
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it.each((["directory", "app_activity"] as const).flatMap(source =>
    (["failed", "waiting_authorization", "permission_required"] as const).flatMap(status =>
      [3_600_000 - 1, 3_600_000, 3_600_000 + 1].map(elapsed => ({ source, status, elapsed })),
    ),
  ))("retries $source $status with a recent saved generation at the one-hour boundary, elapsed: $elapsed ms", async ({ source, status, elapsed }) => {
    const f = fixture(source, status, 60);
    for (const metadata of Object.values(f.sources)) {
      metadata.observedAt = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
    }
    f.sources[source].attemptedAt = new Date(now.getTime() - elapsed).toISOString();
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source))
      .toEqual(elapsed >= 3_600_000 ? [source] : []);
  });

  it.each(["directory", "app_activity"] as const)("does not retry an ordinary %s failure after fifteen minutes", async source => {
    const f = fixture(source, "failed", 16);
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source))
      .toEqual([source === "directory" ? "app_activity" : "directory"]);
  });

  it.each([15, 359, 360])("collects healthy user sources after six hours, not after %i minutes alone", async minutes => {
    const f = fixture("app_activity", "failed", 60);
    for (const source of Object.values(f.sources)) {
      Object.assign(source, { attemptStatus: "available", observedAt: new Date(now.getTime() - minutes * 60_000).toISOString() });
    }
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true });
    expect(f.refresh).toHaveBeenCalledTimes(minutes >= 360 ? 2 : 0);
  });

  it.each(["waiting_authorization", "permission_required"] as const)("retries %s after the hour boundary", async status => {
    const f = fixture("app_activity", status, 60);
    await f.service.refreshUsers(user, undefined, { publication: f.publication, automatic: true });
    expect(f.refresh).toHaveBeenCalledTimes(2);
  });

  it("lets sign-in renew an older authentication failure without bypassing a permission denial", async () => {
    const f = fixture("app_activity", "waiting_authorization", 1);
    await f.service.refreshUsers(user, undefined, {
      publication: f.publication, automatic: true, signedInAt: now.getTime(),
    });
    expect(f.refresh).toHaveBeenCalledTimes(2);
    const denied = fixture("app_activity", "permission_required", 1);
    await denied.service.refreshUsers(user, undefined, {
      publication: denied.publication, automatic: true, signedInAt: now.getTime(),
    });
    expect(denied.refresh.mock.calls.map(([, input]) => input.scope.source)).toEqual(["directory"]);
  });

  it.each(["waiting_authorization", "permission_required"] as const)("preserves sign-in recovery rules for %s with recent saved data", async status => {
    const f = fixture("app_activity", status, 1);
    for (const metadata of Object.values(f.sources)) metadata.observedAt = now.toISOString();
    await f.service.refreshUsers(user, undefined, {
      publication: f.publication, automatic: true, signedInAt: now.getTime(),
    });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source))
      .toEqual(status === "waiting_authorization" ? ["app_activity"] : []);
  });

  it("lets an explicit incomplete-source retry bypass automatic authorization cooldown", async () => {
    const f = fixture("app_activity", "waiting_authorization", 1);
    await f.service.refreshUsers(user, undefined, { publication: f.publication, incompleteOnly: true });
    expect(f.refresh.mock.calls.map(([, input]) => input.scope.source)).toEqual(["app_activity"]);
  });
});
