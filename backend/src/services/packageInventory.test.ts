import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import { PackageInventoryService, scanPackages } from "./packageInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { GraphPackagesClient, packageInventoryReadPolicy, type FetchLike } from "./graphPackages.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("connect-pg-simple", () => ({
  default: () => class {
    constructor() { throw new Error("Unit tests must not construct a session store."); }
  },
}));

const user: AuthenticatedUser = {
  tenantId: "tenant-package",
  homeAccountId: "principal-package",
  displayName: "Package Reader",
  username: "reader@example.invalid",
  roles: ["AgentControl.Viewer"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const job = {
    id: "11111111-1111-1111-1111-111111111111",
    authorizationPrincipalId: user.homeAccountId,
    tokenMode: "delegated" as const,
    scopeKind: "broad" as const,
    requestedIds: [],
    status: "waiting_authorization" as const,
    pageCount: 0,
    observedCount: 0,
    totalRecords: null,
    snapshotId: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    attemptedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: null,
  };
  const repository = {
    submit: vi.fn(async () => job),
    getJob: vi.fn(async (_scope?: unknown, id = job.id) => ({ ...job, id })),
    markRunning: vi.fn(async () => true),
    recordProgress: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
    markWaitingAuthorization: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ ...job, status: "cancelled" as const })),
    recoverInterrupted: vi.fn(async () => 0),
    ...overrides,
  };
  const dependencies = {
    delegatedToken: vi.fn(async () => "delegated-token"),
    applicationToken: vi.fn(async () => "application-token"),
    revalidateUser: vi.fn(async () => user),
    requireAvailable: vi.fn(async () => undefined),
    requireApplicationDataScope: vi.fn(async () => undefined),
    scan: vi.fn<typeof scanPackages>(async () => ({ packages: [], totalRecords: 0, pages: 1 })),
    applicationPrincipalId: vi.fn(() => "application-id"),
  };
  return { job, repository, dependencies, service: new PackageInventoryService(repository as never, dependencies as never) };
}

describe("Package refresh service", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("publishes only after current delegated authorization and a complete explicit scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("graph.package.read.delegated", user);
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.scan);
  });

  describe("bounded identity detail refresh", () => {
    const packageValue = (id: string) => allowlistedPackage({ id, displayName: id, isBlocked: false });

    it("completes a 1,010-package identity scan through the real client despite transient detail failures", async () => {
      const listed = Array.from({ length: 1010 }, (_, index) => ({ id: `package-${index}`, displayName: `Agent ${index}`, isBlocked: false }));
      const definition = JSON.stringify({ SourceIds: { EnvironmentId: "environment", CdsBotId: "bot", SchemaName: "agent_schema" } });
      let attempts = 0;
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = new URL(input);
        if (url.pathname.endsWith("/packages")) return Response.json(url.searchParams.has("page")
          ? { value: listed.slice(500) }
          : { value: listed.slice(0, 500), "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2" });
        const id = url.pathname.split("/").at(-1)!;
        if (id === "package-20" && ++attempts <= 2) {
          return Response.json({ error: { code: "InternalServerError", message: "private provider message" } }, { status: attempts === 1 ? 500 : 502 });
        }
        return Response.json({ id, displayName: id, isBlocked: false,
          elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition }] }] });
      });
      const retryDelay = vi.fn(async () => undefined);
      const client = new GraphPackagesClient(fetcher, { delay: retryDelay });
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockImplementation((token, ids, signal, progress) => scanPackages(token, ids, signal, progress, client));

      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce(), { timeout: 5_000 });

      expect(repository.publish).toHaveBeenCalledWith(expect.anything(), job.id, expect.objectContaining({
        totalRecords: 1010, pages: 2, packages: expect.arrayContaining([
          expect.objectContaining({ id: "package-20", identityDetailsCollected: true,
            elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition }] }] }),
        ]),
      }));
      expect(repository.recordProgress).toHaveBeenLastCalledWith(expect.anything(), job.id, 2, 1010, 1010,
        "Matching agent records (1010/1010 identities checked).");
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1014);
      expect(retryDelay.mock.calls).toEqual([[2000, expect.any(AbortSignal)], [4000, expect.any(AbortSignal)]]);
    });

    it.each([400, 424, 500])("retains the old snapshot and sanitized HTTP %i diagnostics when a real detail read fails", async status => {
      const requestId = "22222222-2222-2222-2222-222222222222";
      const providerCode = status === 500 ? "InternalServerError" : status === 424 ? "UnknownError" : "BadRequest";
      const fetcher = vi.fn<FetchLike>(async input => new URL(input).pathname.endsWith("/packages")
        ? Response.json({ value: [{ id: "package", displayName: "Agent", isBlocked: false }] })
        : Response.json({ error: { code: providerCode, message: `${status === 424 ? "Too many requests " : ""}private-token person@example.invalid` } },
          { status, headers: { "request-id": requestId } }));
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, minimumReadIntervalMs: 0, delay: async () => undefined });
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockImplementation((token, ids, signal, progress) => scanPackages(token, ids, signal, progress, client));
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await service.start(user, job.id, "delegated");
        await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
        expect(repository.publish).not.toHaveBeenCalled();
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, `graph_http_${status}`,
          expect.stringContaining(`HTTP ${status}, ${providerCode}`));
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, `graph_http_${status}`,
          expect.stringContaining(requestId));
        expect(fetcher).toHaveBeenCalledTimes(status === 500 ? 4 : status === 424 ? 7 : 2);
        expect(log.mock.calls.flat().join("\n")).toContain('"event":"package_refresh_failed"');
        expect(log.mock.calls.flat().join("\n")).toContain(`"status":${status}`);
        expect(JSON.stringify([repository.markFailed.mock.calls, log.mock.calls])).not.toMatch(/private-token|person@/);
      } finally { log.mockRestore(); }
    });

    it("collects every listed identity automatically beyond the manual 100-target limit", async () => {
      const listed = Array.from({ length: 105 }, (_, index) => ({ ...packageValue(`package-${index}`), publisher: "Saved publisher" }));
      let active = 0;
      let maximumActive = 0;
      const client = {
        listCopilotAgents: vi.fn(async () => listed),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          if (id === "package-104") throw new AppError(404, "not_found", "Removed after listing");
          return { ...packageValue(id), elementDetails: [{ elementType: "AgentMetadatas", elements: [] }] };
        }),
      };
      const progress = vi.fn(async () => undefined);
      const result = await scanPackages("token", [], new AbortController().signal, progress, client);
      expect(result).toMatchObject({ totalRecords: 104, pages: 1 });
      expect(result.packages.every(value => value.identityDetailsCollected === true && value.publisher === "Saved publisher")).toBe(true);
      expect(result.packages.map(value => value.id)).toEqual(listed.slice(0, 104).map(value => value.id));
      expect(client.getPackageDetails).toHaveBeenCalledTimes(105);
      expect(maximumActive).toBe(4);
      expect(progress).toHaveBeenLastCalledWith(1, 105, 105, "Matching agent records (105/105 identities checked).");
    });

    it("distinguishes a completed detail read with no metadata from a broad summary", async () => {
      const client = {
        listCopilotAgents: vi.fn(async () => [packageValue("one")]),
        getPackageDetails: vi.fn(async () => packageValue("one")),
      };
      const result = await scanPackages("token", [], new AbortController().signal, async () => undefined, client);
      expect(result.packages[0]).toMatchObject({ id: "one", identityDetailsCollected: true });
      expect(result.packages[0].elementDetails).toBeUndefined();
    });

    it("does not advance identity collection after cancellation or a failed detail read", async () => {
      const controller = new AbortController();
      const client = {
        listCopilotAgents: vi.fn(async () => Array.from({ length: 8 }, (_, index) => packageValue(`package-${index}`))),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "package-1") controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
          return packageValue(id);
        }),
      };
      await expect(scanPackages("token", [], controller.signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "read_job_cancelled" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(4);
      client.getPackageDetails.mockRejectedValue(new AppError(403, "missing_permission", "Denied"));
      await expect(scanPackages("token", [], new AbortController().signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "missing_permission" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(8);
    });

    it("reads exact details in bounded batches and retains complete deterministic results", async () => {
      let active = 0;
      let maximumActive = 0;
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async () => undefined);
      const ids = Array.from({ length: 9 }, (_, index) => `package-${index}`);
      const result = await scanPackages("token", ids, new AbortController().signal, progress, client);
      expect(result.packages.map(value => value.id)).toEqual(ids);
      expect(result).toMatchObject({ pages: 9, totalRecords: 9 });
      expect(maximumActive).toBe(4);
      expect(progress.mock.calls).toEqual([[4, 4, 4], [8, 8, 8], [9, 9, 9]]);
      expect(client.listCopilotAgents).not.toHaveBeenCalled();
    });

    it("records a missing exact package as absence without substituting another identity", async () => {
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "gone") throw new AppError(404, "not_found", "No longer present");
          return packageValue(id);
        }),
      };
      expect(await scanPackages("token", ["gone", "present"], new AbortController().signal, async () => undefined, client))
        .toMatchObject({ packages: [{ id: "present" }], totalRecords: 1, pages: 2 });
      client.getPackageDetails.mockResolvedValue(packageValue("different"));
      await expect(scanPackages("token", ["requested"], new AbortController().signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "target_mismatch" });
    });

    it("does not publish a partial scan or dispatch the next batch after an error", async () => {
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "bad") throw new AppError(403, "not_authorized", "Denied");
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async () => undefined);
      await expect(scanPackages("token", ["a", "bad", "b", "c", "not-dispatched"], new AbortController().signal, progress, client))
        .rejects.toMatchObject({ code: "not_authorized" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(4);
      expect(progress).not.toHaveBeenCalled();
    });
  });

  it("keeps application reads independent and requires approved shared scope", async () => {
    const applicationJob = { ...fixture().job, tokenMode: "application" as const };
    const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
    await service.submit(user, { tokenMode: "application", idempotencyKey: "application-read" });
    expect(repository.submit).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: "application-id" }, expect.objectContaining({ authorizationPrincipalId: user.homeAccountId, tokenMode: "application" }));
    await service.start(user, applicationJob.id, "application");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.applicationToken).toHaveBeenCalledWith("graph.package.read.application");
    expect(dependencies.delegatedToken).not.toHaveBeenCalled();
    expect(dependencies.requireApplicationDataScope).toHaveBeenCalled();
  });

  it("lets Admin inherit every Viewer package read mode", async () => {
    const admin = { ...user, roles: ["AgentControl.Admin" as const] };
    const direct = fixture();
    await expect(direct.service.submit(admin, { tokenMode: "delegated", idempotencyKey: "broad" })).resolves.toBeDefined();
    await expect(direct.service.submit(admin, { tokenMode: "application", idempotencyKey: "application" })).resolves.toBeDefined();
    await expect(direct.service.submit(admin, { tokenMode: "delegated", idempotencyKey: "exact", requestedIds: ["package-1"] })).resolves.toBeDefined();
  });

  it("lets only the owning Viewer cancel a read refresh", async () => {
    const direct = fixture();
    await expect(direct.service.cancel(user, direct.job.id, "delegated")).resolves.toMatchObject({ status: "cancelled" });
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id, user.homeAccountId);
    await expect(direct.service.cancel({ ...user, roles: [] }, direct.job.id, "delegated")).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("leaves authorization failure waiting without starting the scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.delegatedToken.mockRejectedValue(new AppError(401, "interaction_required", "reauthenticate"));
    await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "interaction_required" });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it("aborts logout work and never publishes after the principal changes", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    await service.start(user, job.id, "delegated");
    await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await service.drain();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("does not consume capacity when tenant or application scope validation fails", async () => {
    const { service, dependencies, job } = fixture();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.start({ ...user, tenantId: undefined }, job.id, "delegated"))
        .rejects.toMatchObject({ code: "unauthorized" });
    }
    dependencies.applicationPrincipalId.mockReturnValue("");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.start(user, job.id, "application")).rejects.toMatchObject({ code: "not_configured" });
    }
    await expect(service.start(user, job.id, "delegated")).resolves.toBeDefined();
    await service.drain();
  });

  it("counts each refresh once while its running-job response is pending", async () => {
    const { service, repository, dependencies, job } = fixture();
    const response = deferred<typeof job>();
    repository.getJob.mockResolvedValueOnce(job).mockReturnValueOnce(response.promise);
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const first = service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.scan).toHaveBeenCalledTimes(1));
    try {
      for (let index = 2; index <= 4; index += 1) {
        await expect(service.start(user, `job-${index}`, "delegated")).resolves.toBeDefined();
      }
      await expect(service.start(user, "job-5", "delegated")).rejects.toMatchObject({ code: "package_refresh_capacity" });
    } finally {
      response.resolve(job);
      await first;
      await service.drain();
    }
  });

  it.each(["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const)(
    "stops startup paused at %s when its principal signs out",
    async stage => {
      const { service, repository, dependencies, job } = fixture();
      const pending = deferred<void>();
      if (stage === "getJob") repository.getJob.mockImplementationOnce(async () => { await pending.promise; return job; });
      if (stage === "revalidateUser") dependencies.revalidateUser.mockImplementationOnce(async () => { await pending.promise; return user; });
      if (stage === "requireAvailable") dependencies.requireAvailable.mockImplementationOnce(async () => { await pending.promise; });
      if (stage === "delegatedToken") dependencies.delegatedToken.mockImplementationOnce(async () => { await pending.promise; return "token"; });
      if (stage === "markRunning") repository.markRunning.mockImplementationOnce(async () => { await pending.promise; return true; });
      const boundary = stage === "getJob" || stage === "markRunning" ? repository[stage] : dependencies[stage];
      const starting = service.start(user, job.id, "delegated");
      const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
      await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce());
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      pending.resolve();
      await stopped;
      await service.drain();
      expect(dependencies.scan).not.toHaveBeenCalled();
      expect(repository.publish).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(stage === "markRunning" ? 1 : 0);
    },
  );

  it("drains in-flight admission before completing shutdown and rejects new starts", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    const drained = vi.fn();
    const draining = service.drain().then(drained);
    await Promise.resolve();
    await Promise.resolve();
    const returnedEarly = drained.mock.calls.length > 0;
    pending.resolve(user);
    await stopped;
    await draining;
    expect(returnedEarly).toBe(false);
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
    await expect(service.start(user, "after-shutdown", "delegated")).rejects.toMatchObject({ code: "package_refresh_shutdown" });
  });

  it("rejects a duplicate admission without consuming another slot", async () => {
    const { service, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "package_refresh_state" });
    pending.resolve(user);
    await starting;
    await service.drain();
    expect(dependencies.scan).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "logout"] as const)("drains admission already stopped by %s", async action => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<boolean>();
    repository.markRunning.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({
      code: action === "cancel" ? "read_job_cancelled" : "interaction_required",
    });
    await vi.waitFor(() => expect(repository.markRunning).toHaveBeenCalledOnce());
    if (action === "cancel") await service.cancel(user, job.id, "delegated");
    else await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    const draining = service.drain();
    pending.resolve(true);
    await stopped;
    await draining;
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(action === "logout" ? 1 : 0);
    expect(repository.cancel).toHaveBeenCalledTimes(action === "cancel" ? 2 : 0);
  });

  it.each(["starting", "running"] as const)("conceals a %s job from other principals and tenants", async phase => {
    const { service, dependencies, repository, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    if (phase === "starting") dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const starting = service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    if (phase === "running") await starting;
    try {
      const reads = repository.getJob.mock.calls.length;
      for (const other of [{ ...user, homeAccountId: "other-principal" }, { ...user, tenantId: "other-tenant" }]) {
        await expect(service.start(other, job.id, "delegated")).rejects.toMatchObject({ status: 404, code: "not_found" });
      }
      expect(repository.getJob).toHaveBeenCalledTimes(reads);
      expect(dependencies.revalidateUser).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(user);
      await starting;
      await service.drain();
    }
  });

  it.each(["uppercase", "lowercase"] as const)("matches mixed-case UUID resume and cancellation after %s admission", async casing => {
    const { service, dependencies, job, repository } = fixture();
    job.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    repository.markRunning.mockResolvedValueOnce(true).mockResolvedValue(false);
    let scanSignal: AbortSignal | undefined;
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) => {
      scanSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const startId = casing === "uppercase" ? job.id.toUpperCase() : job.id;
    const otherId = casing === "uppercase" ? job.id : job.id.toUpperCase();
    await service.start(user, startId, "delegated");
    try {
      await expect(service.start(user, otherId, "delegated")).rejects.toMatchObject({ code: "package_refresh_state" });
      await service.cancel(user, otherId, "delegated");
      expect(scanSignal?.aborted).toBe(true);
      expect(scanSignal?.reason).toMatchObject({ code: "read_job_cancelled" });
      expect(dependencies.scan).toHaveBeenCalledOnce();
      expect(repository.markRunning).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, job.id);
    } finally {
      await service.drain();
    }
  });

  it.each(["cancel", "logout", "shutdown", "deadline"] as const)(
    "preserves the %s outcome when pending publication authorization rejects later",
    async interruption => {
      const { service, dependencies, repository, job } = fixture();
      const pending = deferred<AuthenticatedUser>();
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
      let draining: Promise<void> | undefined;
      if (interruption === "cancel") await service.cancel(user, job.id, "delegated");
      else if (interruption === "logout") await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      else if (interruption === "shutdown") draining = service.drain();
      else deadline.abort(new DOMException("Execution deadline", "TimeoutError"));
      pending.reject(interruption === "deadline"
        ? new AppError(401, "interaction_required", "Late authorization failure.")
        : new Error("Late authorization transport failure."));
      await (draining ?? service.drain());
      expect(repository.publish).not.toHaveBeenCalled();
      if (interruption === "deadline") {
        expect(repository.markFailed).toHaveBeenCalledWith(
          { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id,
          "package_refresh_timeout", expect.stringContaining("execution deadline"),
        );
        expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      } else {
        expect(repository.markFailed).not.toHaveBeenCalled();
        expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(interruption === "cancel" ? 0 : 1);
        expect(repository.cancel).toHaveBeenCalledTimes(interruption === "cancel" ? 2 : 0);
      }
    },
  );

  it("does not join pending authorization while logout holds the account mutation lock", async () => {
    const { service, repository, dependencies, job } = fixture();
    const scopedUser = { ...user, homeAccountId: "package-start-lock" };
    repository.getJob.mockResolvedValue({ ...job, authorizationPrincipalId: scopedUser.homeAccountId });
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(scopedUser, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    await revokeAccountSessionMutations(user.tenantId!, scopedUser.homeAccountId, async () => {
      pending.resolve(scopedUser);
      await Promise.resolve();
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: scopedUser.homeAccountId });
    });
    await stopped;
    await service.drain();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it.each(["requireApplicationDataScope", "applicationToken"] as const)(
    "stops an application read paused at %s using the authorizing user's scope",
    async stage => {
      const applicationJob = { ...fixture().job, tokenMode: "application" as const };
      const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
      const pending = deferred<void>();
      if (stage === "requireApplicationDataScope") dependencies.requireApplicationDataScope.mockImplementationOnce(async () => { await pending.promise; });
      else dependencies.applicationToken.mockImplementationOnce(async () => { await pending.promise; return "token"; });
      const starting = service.start(user, applicationJob.id, "application");
      const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
      await vi.waitFor(() => expect(dependencies[stage]).toHaveBeenCalledOnce());
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      pending.resolve();
      await stopped;
      await service.drain();
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(dependencies.scan).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...user, roles: [] },
    { ...user, homeAccountId: "different-principal" },
    { ...user, tenantId: "different-tenant" },
  ])("does not publish when the current user changes to %j", async freshUser => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockResolvedValueOnce(freshUser);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(repository.publish).not.toHaveBeenCalled();
    await service.drain();
  });

  it("reports background persistence failure even when no caller is draining", async () => {
    const { service, repository, dependencies, job } = fixture();
    const failure = new Error("private database failure detail");
    dependencies.scan.mockRejectedValue(new AppError(502, "provider_error", "Provider failed."));
    repository.markFailed.mockRejectedValueOnce(failure);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"package_refresh_status_failed"'),
    ));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("observes sanitized background persistence failures and still rejects an in-flight drain", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<void>();
    const failure = new Error("private database failure detail");
    dependencies.scan.mockRejectedValue(new AppError(502, "provider_error", "Provider failed."));
    repository.markFailed.mockReturnValueOnce(pending.promise);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(failure);
    await drained;
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"package_refresh_status_failed"'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`"jobId":"${job.id}"`));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });

  it("still reports persistence failure when shutdown wins over a late authorization rejection", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    const failure = new Error("private authorization-wait persistence failure");
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
    repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(new Error("Late authorization transport failure."));
    await drained;
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"package_refresh_status_failed"'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });
});