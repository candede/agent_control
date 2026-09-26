import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilityIds, type CapabilityId } from "../types/capability.js";
import type { CapabilityConfiguration, CapabilityEvidence, EvidenceKey } from "../db/capabilities.js";
import { AppError } from "../errors.js";
import { CapabilityService } from "./capabilities.js";
import { GraphPackagesClient } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { capabilityDefinitions } from "./capabilityRegistry.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";

vi.hoisted(() => {
  process.env.TENANTS_JSON = JSON.stringify([
    { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
      clientSecret: "synthetic-capability-a", domains: ["example.invalid"] },
    { tenantId: "33333333-3333-3333-3333-333333333333", clientId: "44444444-4444-4444-4444-444444444444",
      clientSecret: "synthetic-capability-b", domains: ["other.example.invalid"] },
  ]);
});

const reader: AuthenticatedUser = { tenantId: "11111111-1111-1111-1111-111111111111", homeAccountId: "reader-a", username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer"] };

class MemoryRepository {
  configurations = new Map<string, CapabilityConfiguration>();
  evidenceRows = new Map<string, CapabilityEvidence>();
  configuration = vi.fn(async (_tenantId: string, id: string) => this.configurations.get(id) ?? { enabled: false, sharedDataScope: false, previewQualified: false, revision: 1 });
  evidence = vi.fn(async (key: EvidenceKey) => this.evidenceRows.get(JSON.stringify(key)));
  recordEvidence = vi.fn(async (key: EvidenceKey, status: CapabilityEvidence["status"], details: Record<string, unknown>, ttl: number) => {
    const now = new Date(); const value = { status, details, observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl).toISOString(), lastSuccessAt: status === "available" ? now.toISOString() : undefined };
    this.evidenceRows.set(JSON.stringify(key), value); return value;
  });
  setApplicationConfiguration = vi.fn(async (_tenantId: string, id: string, enabled: boolean, sharedDataScope: boolean) => {
    const revision = (this.configurations.get(id)?.revision ?? 1) + 1;
    const value = { enabled, sharedDataScope, previewQualified: false, revision };
    this.configurations.set(id, value);
    for (const [key] of this.evidenceRows) if ((JSON.parse(key) as EvidenceKey).capabilityId === id) this.evidenceRows.delete(key);
    return value;
  });
  invalidatePrincipal = vi.fn(async (tenantId: string, principalId: string) => {
    for (const [key] of this.evidenceRows) {
      const scope = JSON.parse(key) as EvidenceKey;
      if (scope.tenantId === tenantId && scope.authorizationPrincipalId === principalId) this.evidenceRows.delete(key);
    }
  });
  invalidateCapability = vi.fn(async (_tenantId: string, capabilityId: string) => {
    for (const [key] of this.evidenceRows) if ((JSON.parse(key) as EvidenceKey).capabilityId === capabilityId) this.evidenceRows.delete(key);
  });
}

function service(repository = new MemoryRepository(), overrides: Partial<{ delegatedToken: (tenantId: string, accountId: string, capabilityId: CapabilityId) => Promise<string>; applicationToken: () => Promise<string>; packageProbe: (token: string) => Promise<unknown>; directoryProbe: (token: string) => Promise<unknown>; inventoryProbe: (token: string) => Promise<unknown> }> = {}) {
  const probes = {
    delegatedToken: vi.fn(async () => "delegated-token"), applicationToken: vi.fn(async () => "application-token"),
    packageProbe: vi.fn(async () => []), directoryProbe: vi.fn(async () => []), inventoryProbe: vi.fn(async () => []),
    ...overrides,
  };
  return { repository, probes, value: new CapabilityService(repository as never, probes as never) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe.each(["automatic", "targeted"] as const)("%s check cancellation ownership", mode => {
  it.each([0, 1])("cancels caller %i without cancelling the other shared caller", async cancelled => {
    const held = deferred<unknown>();
    const controllers = [new AbortController(), new AbortController()];
    const packageProbe = vi.fn((_token: string, _signal?: AbortSignal) => held.promise);
    const { value } = service(new MemoryRepository(), { packageProbe });
    const settled = [false, false];
    const pending = controllers.map((controller, index) => (mode === "automatic"
      ? value.check(reader, { signal: controller.signal })
      : value.refresh("graph.package.read.delegated", reader, controller.signal))
      .finally(() => { settled[index] = true; }));
    const results = Promise.allSettled(pending);
    const cancellation = new AppError(499, "request_cancelled", "This caller disconnected.");
    try {
      await vi.waitFor(() => expect(packageProbe).toHaveBeenCalledOnce());
      controllers[cancelled].abort(cancellation);
      await vi.waitFor(() => expect(settled[cancelled]).toBe(true));
      expect(settled[1 - cancelled]).toBe(false);
      expect(packageProbe.mock.calls[0][1]?.aborted).toBe(false);
      if (mode === "automatic") expect(value.checkProgress(reader)).not.toBeNull();
    } finally { held.resolve([]); }
    const outcomes = await results;
    expect(outcomes[cancelled]).toEqual({ status: "rejected", reason: cancellation });
    expect(outcomes[1 - cancelled].status).toBe("fulfilled");
    expect(packageProbe).toHaveBeenCalledOnce();
  });

  it("does not attach an immediate replacement to abandoned work", async () => {
    const held = deferred<unknown>();
    const controller = new AbortController();
    const packageProbe = vi.fn((_token: string, _signal?: AbortSignal) => Promise.resolve<unknown>([]))
      .mockImplementationOnce(() => held.promise);
    const { value, repository } = service(new MemoryRepository(), { packageProbe });
    const start = (signal?: AbortSignal) => mode === "automatic"
      ? value.check(reader, { signal })
      : value.refresh("graph.package.read.delegated", reader, signal);
    const cancelled = start(controller.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ code: "request_cancelled" });
    try {
      await vi.waitFor(() => expect(packageProbe).toHaveBeenCalledOnce());
      controller.abort(new AppError(499, "request_cancelled", "Disconnected"));
      await expect(start()).resolves.toBeDefined();
      expect(packageProbe).toHaveBeenCalledTimes(2);
      expect(packageProbe.mock.calls[0][1]?.aborted).toBe(true);
      expect(repository.recordEvidence.mock.calls.filter(([key]) => key.capabilityId === "graph.package.read.delegated")).toHaveLength(1);
    } finally { held.resolve([]); await rejection; }
  });

  it("does not cancel a provider probe also awaited by the other check kind", async () => {
    const held = deferred<unknown>();
    const controller = new AbortController();
    const packageProbe = vi.fn((_token: string, _signal?: AbortSignal) => held.promise);
    const { value } = service(new MemoryRepository(), { packageProbe });
    const automatic = (signal?: AbortSignal) => value.check(reader, { signal });
    const targeted = (signal?: AbortSignal) => value.refresh("graph.package.read.delegated", reader, signal);
    const cancelled = (mode === "automatic" ? automatic : targeted)(controller.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ code: "request_cancelled" });
    const survivor = (mode === "automatic" ? targeted : automatic)();
    const success = expect(survivor).resolves.toBeDefined();
    try {
      await vi.waitFor(() => expect(packageProbe).toHaveBeenCalledOnce());
      controller.abort(new AppError(499, "request_cancelled", "Disconnected"));
      await rejection;
      expect(packageProbe.mock.calls[0][1]?.aborted).toBe(false);
    } finally { held.resolve([]); await success; }
    expect(packageProbe).toHaveBeenCalledOnce();
  });
});

describe("live automatic check progress", () => {
  it("is read-only and empty when no check is running", () => {
    const { value, repository, probes } = service();
    expect(value.checkProgress(reader)).toBeNull();
    expect(repository.evidence).not.toHaveBeenCalled();
    for (const probe of Object.values(probes)) expect(probe).not.toHaveBeenCalled();
    expect(() => value.checkProgress({ ...reader, roles: [] })).toThrow(/Viewer/);
  });

  it("reports real active checks, completed reviews and only the matching account, role and retry scope", async () => {
    const held = deferred<unknown>();
    const packageProbe = vi.fn(() => held.promise);
    const { value, probes } = service(new MemoryRepository(), { packageProbe });
    const pending = value.check(reader, { retryFailed: true });
    await vi.waitFor(() => expect(value.checkProgress(reader, true)?.checks.filter(check => check.state !== "complete"))
      .toEqual([{ capabilityId: "graph.package.read.delegated", state: "checking" }]));
    const snapshot = value.checkProgress(reader, true)!;
    expect(snapshot.checks.some(check => check.capabilityId === "graph.licenses.read")).toBe(false);
    expect(snapshot.checks.some(check => check.capabilityId === "reports.copilotUsage.read")).toBe(false);
    expect(snapshot.checks.some(check => check.capabilityId.endsWith(".application"))).toBe(false);
    expect(value.checkProgress({ ...reader, homeAccountId: "another" }, true)).toBeNull();
    expect(value.checkProgress({ ...reader, tenantId: "another" }, true)).toBeNull();
    expect(value.checkProgress({ ...reader, roles: ["AgentControl.Admin"] }, true)).toBeNull();
    expect(value.checkProgress(reader, false)).toBeNull();
    snapshot.checks[0].state = "complete";
    expect(value.checkProgress(reader, true)?.checks[0].state).toBe("checking");
    const coalesced = value.check(reader, { retryFailed: true });
    held.resolve([]);
    await Promise.all([pending, coalesced]);
    expect(packageProbe).toHaveBeenCalledOnce();
    expect(probes.applicationToken).not.toHaveBeenCalled();
    expect(value.checkProgress(reader, true)).toBeNull();
  });

  it("counts reused evidence as reviewed without calling its provider again", async () => {
    const held = deferred<unknown>();
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => held.promise) });
    await value.refresh("graph.directory.read", reader);
    const pending = value.check(reader);
    await vi.waitFor(() => expect(value.checkProgress(reader)?.checks.find(check => check.capabilityId === "graph.directory.read")?.state).toBe("complete"));
    expect(probes.directoryProbe).toHaveBeenCalledOnce();
    held.resolve([]);
    await pending;
  });

  it.each(["cancel", "invalidate"] as const)("discards live progress on %s", async action => {
    const held = deferred<unknown>();
    const controller = new AbortController();
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => held.promise) });
    const pending = value.check(reader, { signal: controller.signal });
    const failure = expect(pending).rejects.toBeInstanceOf(AppError);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledOnce());
    if (action === "cancel") controller.abort(new AppError(499, "request_cancelled", "Cancelled"));
    else {
      await value.invalidatePrincipal(reader);
      expect(value.checkProgress(reader)).toBeNull();
      held.resolve([]);
    }
    await failure;
    expect(value.checkProgress(reader)).toBeNull();
  });
});

describe("recent actual operation failures", () => {
  const id = "graph.licenses.read";
  const denied = () => new AppError(403, "missing_permission", "private provider text", {
    httpStatus: 403, providerErrorCode: "Authorization_RequestDenied", accessToken: "private-token", body: "private-body",
  });
  const failure = async (value: CapabilityService, user = reader) =>
    (await value.list(user)).find(view => view.definition.id === id)?.operationFailure;

  it("keeps untouched on-demand capabilities issue-free without provider calls", async () => {
    const { value, probes, repository } = service();
    expect(await failure(value)).toBeUndefined();
    expect(await value.decision(id, reader)).toMatchObject({ authorized: true, verification: "on_demand" });
    for (const probe of Object.values(probes)) expect(probe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
  });

  it("persists a separate failure across service instances and clears it only after an actual success", async () => {
    const { value, repository } = service();
    const original = denied();
    await expect(value.observeOperation(id, reader, async () => { throw original; })).rejects.toBe(original);
    const observed = await failure(value);
    expect(observed).toMatchObject({ status: "missing_permission", evidence: { httpStatus: 403 } });
    expect(Date.parse(observed!.expiresAt) - Date.parse(observed!.checkedAt)).toBe(86_400_000);
    expect(observed!.remediation.join(" ")).toContain("Grant admin consent");
    expect(JSON.stringify([...repository.evidenceRows.values()])).not.toContain("private");
    expect(await value.decision(id, reader)).toMatchObject({ authorized: true, verification: "on_demand" });
    const restarted = service(repository).value;
    expect(await failure(restarted)).toEqual(observed);
    await restarted.refresh(id, reader);
    await restarted.observeOperation(id, reader, async () => "token only", { clearOnSuccess: false });
    expect(await failure(restarted)).toEqual(observed);
    await expect(restarted.observeOperation(id, reader, async () => ["actual result"])).resolves.toEqual(["actual result"]);
    expect(await failure(restarted)).toBeUndefined();
    expect(repository.evidenceRows.size).toBe(2);
  });

  it.each([
    [new AppError(403, "missing_role", "private"), "missing_role"],
    [new AppError(403, "missing_license", "private"), "missing_license"],
    [new AppError(403, "missing_provider_scope", "private"), "missing_permission"],
    [new AppError(403, "missing_provider_role", "private"), "missing_role"],
    [new AppError(401, "interaction_required", "private"), "unknown"],
    [new AppError(401, "authorization_expired", "private"), "unknown"],
    [new AppError(403, "conditional_access_required", "private"), "unknown"],
    [new AppError(403, "provider_authorization_error", "private"), "provider_error"],
    [new AppError(403, "agent_identity_permission_required", "private"), "provider_error"],
    [new AppError(403, "provider_denied", "private"), "provider_error"],
    [new AppError(502, "graph_error", "private", { httpStatus: 403 }), "provider_error"],
  ] as const)("reports only explicit provider/authentication evidence from %s", async (error, status) => {
    const { value } = service();
    const operation = vi.fn(async () => { throw error; });
    await expect(value.observeOperation(id, reader, operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(await failure(value)).toMatchObject({ status });
    expect(await value.decision(id, reader)).toMatchObject({ authorized: true, verification: "on_demand" });
    if (status === "unknown") expect((await failure(value))!.remediation.join(" ")).toContain("Sign in again");
  });

  it.each([
    new TypeError("network failed"), new DOMException("deadline", "TimeoutError"),
    new AppError(503, "provider_error", "private", { httpStatus: 503 }),
    new AppError(429, "provider_throttled", "private", { httpStatus: 429 }),
    new AppError(401, "unauthorized", "local account mismatch"),
    new AppError(401, "interaction_required", "cached readiness failure", { capabilityId: id, authorized: false }),
    new AppError(403, "missing_internal_role", "local role"), new AppError(403, "scope_mismatch", "local scope"),
    new AppError(400, "unsupported", "unsupported mapping"),
  ])("does not invent a permission issue or overwrite existing evidence for %s", async error => {
    const { value, repository } = service();
    await expect(value.observeOperation(id, reader, async () => { throw error; })).rejects.toBe(error);
    expect(await failure(value)).toBeUndefined();
    await expect(value.observeOperation(id, reader, async () => { throw denied(); })).rejects.toMatchObject({ code: "missing_permission" });
    const previous = await failure(value);
    await expect(value.observeOperation(id, reader, async () => { throw error; })).rejects.toBe(error);
    expect(await failure(value)).toEqual(previous);
    expect(repository.recordEvidence).toHaveBeenCalledOnce();
  });

  it.each(["tenant", "principal", "role", "configuration", "contract", "expired", "invalid-expiry"] as const)(
    "does not disclose a failure outside its current %s scope", async change => {
      const { value, repository } = service();
      await expect(value.observeOperation(id, reader, async () => { throw denied(); })).rejects.toThrow();
      const user = { ...reader };
      if (change === "tenant") user.tenantId = "33333333-3333-3333-3333-333333333333";
      if (change === "principal") user.homeAccountId = "another-reader";
      if (change === "role") user.roles = [];
      if (change === "configuration") repository.configurations.set(id, { enabled: false, sharedDataScope: false, previewQualified: false, revision: 2 });
      const [key, row] = [...repository.evidenceRows][0];
      if (change === "contract") {
        repository.evidenceRows.delete(key);
        repository.evidenceRows.set(JSON.stringify({ ...JSON.parse(key), contractRevision: "old-contract" }), row);
      }
      if (change === "expired") row.expiresAt = new Date(0).toISOString();
      if (change === "invalid-expiry") row.expiresAt = "invalid";
      expect(await failure(value, user)).toBeUndefined();
    },
  );

  it("keeps application failures private to the initiating principal and current shared-scope configuration", async () => {
    const { value, repository } = service();
    const applicationId = "graph.package.read.application";
    repository.configurations.set(applicationId, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 1 });
    await expect(value.observeOperation(applicationId, reader, async () => { throw denied(); })).rejects.toThrow();
    expect((await value.list(reader)).find(view => view.definition.id === applicationId)?.operationFailure?.status).toBe("missing_permission");
    expect((await value.list({ ...reader, homeAccountId: "another-initiator" })).find(view => view.definition.id === applicationId)?.operationFailure).toBeUndefined();
    expect(repository.recordEvidence.mock.calls[0][0]).toMatchObject({
      principalId: "22222222-2222-2222-2222-222222222222", authorizationPrincipalId: reader.homeAccountId,
    });
    await expect(value.observeOperation(applicationId, reader, async () => {
      throw new AppError(401, "authorization_expired", "Application authorization expired");
    })).rejects.toThrow();
    const authenticationFailure = (await value.list(reader)).find(view => view.definition.id === applicationId)!.operationFailure!;
    expect(authenticationFailure.remediation.join(" ")).toContain("administrator");
    expect(authenticationFailure.remediation.join(" ")).not.toContain("Sign in again");
    repository.configurations.set(applicationId, { enabled: true, sharedDataScope: false, previewQualified: false, revision: 2 });
    expect((await value.list(reader)).find(view => view.definition.id === applicationId)?.operationFailure).toBeUndefined();
  });

  it.each(["invalidation", "session-revocation", "cancellation"] as const)("rejects stale operation publication after %s", async change => {
    const { value, repository } = service();
    const user = { ...reader, homeAccountId: `operation-${change}` };
    const held = deferred<number>();
    const controller = new AbortController();
    const pending = value.observeOperation(id, user, () => held.promise, { signal: controller.signal });
    await vi.waitFor(() => expect(repository.configuration).toHaveBeenCalled());
    if (change === "invalidation") await value.invalidatePrincipal(user);
    if (change === "session-revocation") await revokeAccountSessionMutations(user.tenantId, user.homeAccountId, async () => undefined);
    if (change === "cancellation") controller.abort();
    held.resolve(7);
    await expect(pending).resolves.toBe(7);
    expect(repository.recordEvidence).not.toHaveBeenCalled();
    if (change === "session-revocation") await activateAccountSession(user.tenantId, user.homeAccountId, async () => undefined);
  });

  it("never retries business writes and never turns reporting-storage errors into a failed write", async () => {
    const { value, repository } = service();
    repository.recordEvidence.mockRejectedValue(new Error("storage unavailable"));
    const write = vi.fn(async () => "written");
    await expect(value.observeOperation("graph.package.block.manage", reader, write)).resolves.toBe("written");
    expect(write).toHaveBeenCalledOnce();
    const original = denied();
    const deniedWrite = vi.fn(async () => { throw original; });
    await expect(value.observeOperation("graph.package.block.manage", reader, deniedWrite)).rejects.toBe(original);
    expect(deniedWrite).toHaveBeenCalledOnce();
  });

  it("excludes local progress failures and does not clear a write failure after a no-op read", async () => {
    const { value, repository } = service();
    await expect(value.observeOperation(id, reader, async () => { throw denied(); }, { shouldRecordError: () => false })).rejects.toThrow();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
    await expect(value.observeOperation(id, reader, async () => { throw denied(); })).rejects.toThrow();
    await value.observeOperation(id, reader, async () => "already in requested state", { clearOnSuccess: () => false });
    expect(await failure(value)).toMatchObject({ status: "missing_permission" });
  });

  it("retains real errors that a partial-result operation handles internally without retrying the operation", async () => {
    const { value, repository } = service();
    const operation = vi.fn(async (reportFailure: (error: unknown) => void) => {
      reportFailure(denied());
      reportFailure(new TypeError("a later unrelated network failure"));
      return { failed: 2 };
    });
    await expect(value.observeOperation(id, reader, operation)).resolves.toEqual({ failed: 2 });
    expect(operation).toHaveBeenCalledOnce();
    expect(repository.recordEvidence).toHaveBeenCalledOnce();
    expect(await failure(value)).toMatchObject({ status: "missing_permission" });
    await value.observeOperation(id, reader, async () => ({ complete: false }), { clearOnSuccess: result => result.complete });
    expect(await failure(value)).toMatchObject({ status: "missing_permission" });
  });
});

describe("bounded safe-readiness retries", () => {
  it("limits the real catalog adapter to two total GET attempts rather than multiplying nested retries", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "InternalServerError" } }, { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const repository = new MemoryRepository();
      const value = new CapabilityService(repository as never, { delegatedToken: async () => "fixture-token" });
      await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "provider_error" });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.every(([, options]) => (options?.method ?? "GET") === "GET")).toBe(true);
      expect(repository.recordEvidence).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([new TypeError("network"), new DOMException("request timeout", "TimeoutError"),
    new AppError(503, "provider_error", "unavailable", { httpStatus: 503 })])("retries %s once before publishing", async error => {
    const packageProbe = vi.fn().mockRejectedValueOnce(error).mockResolvedValue([]);
    const { value, repository } = service(new MemoryRepository(), { packageProbe });
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    expect(packageProbe).toHaveBeenCalledTimes(2);
    expect(repository.recordEvidence).toHaveBeenCalledOnce();
    expect([...repository.evidenceRows.values()][0].status).toBe("available");
  });

  it("retries only explicitly transient token failures", async () => {
    const delegatedToken = vi.fn().mockRejectedValueOnce(new AppError(502, "identity_provider_error", "temporary", { retryable: true })).mockResolvedValue("token");
    const { value, probes } = service(new MemoryRepository(), { delegatedToken });
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    expect(delegatedToken).toHaveBeenCalledTimes(2);
    expect(probes.packageProbe).toHaveBeenCalledOnce();
  });

  it.each([new AppError(403, "missing_permission", "denied"), new AppError(403, "missing_role", "denied"),
    new AppError(403, "missing_license", "denied"), new AppError(502, "provider_schema", "unsupported"),
    new AppError(502, "identity_provider_error", "not proven transient")])("never retries %s", async error => {
    const delegatedToken = vi.fn().mockRejectedValue(error);
    const { value, probes } = service(new MemoryRepository(), { delegatedToken });
    await value.refresh("graph.package.read.delegated", reader);
    expect(delegatedToken).toHaveBeenCalledOnce();
    expect(probes.packageProbe).not.toHaveBeenCalled();
  });

  it("honors short Retry-After and preserves a long throttle cooldown without another request", async () => {
    const shortProbe = vi.fn().mockRejectedValueOnce(new AppError(429, "provider_throttled", "wait", { retryAfterMs: 100 })).mockResolvedValue([]);
    const short = service(new MemoryRepository(), { packageProbe: shortProbe });
    const started = performance.now();
    await expect(short.value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(95);
    expect(shortProbe).toHaveBeenCalledTimes(2);
    const packageProbe = vi.fn().mockRejectedValue(new AppError(429, "provider_throttled", "wait", { retryAfterMs: 600_000 }));
    const { value } = service(new MemoryRepository(), { packageProbe });
    const result = await value.refresh("graph.package.read.delegated", reader);
    expect(Date.parse(result.expiresAt!) - Date.parse(result.checkedAt!)).toBeGreaterThanOrEqual(600_000);
    await value.refresh("graph.package.read.delegated", reader);
    await value.requireAvailable("graph.package.read.delegated", reader, { retryFailed: true }).catch(error => {
      expect(error).toMatchObject({ code: "provider_throttled" });
    });
    expect(packageProbe).toHaveBeenCalledOnce();
  });

  it("honors a Retry-After on temporary server failures without relabeling them as missing permissions", async () => {
    const packageProbe = vi.fn().mockRejectedValue(new AppError(503, "provider_error", "maintenance", { httpStatus: 503, retryAfterMs: 600_000 }));
    const { value } = service(new MemoryRepository(), { packageProbe });
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({
      status: "provider_error", evidence: { category: "provider_error", httpStatus: 503 },
    });
    await value.refresh("graph.package.read.delegated", reader);
    await expect(value.requireAvailable("graph.package.read.delegated", reader, { retryFailed: true })).rejects.toMatchObject({ code: "provider_error" });
    expect(packageProbe).toHaveBeenCalledOnce();
  });

  it.each(["cancellation", "session-revocation"] as const)("does not retry or publish after %s during backoff", async change => {
    const user = { ...reader, homeAccountId: `readiness-${change}` };
    const controller = new AbortController();
    const packageProbe = vi.fn(async () => { throw new TypeError("network"); });
    const { value, repository } = service(new MemoryRepository(), { packageProbe });
    const result = expect(value.refresh("graph.package.read.delegated", user, controller.signal)).rejects.toBeInstanceOf(AppError);
    await vi.waitFor(() => expect(packageProbe).toHaveBeenCalledOnce());
    if (change === "cancellation") controller.abort(new AppError(499, "request_cancelled", "cancelled"));
    else await revokeAccountSessionMutations(user.tenantId, user.homeAccountId, async () => undefined);
    await result;
    expect(packageProbe).toHaveBeenCalledOnce();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
    if (change === "session-revocation") await activateAccountSession(user.tenantId, user.homeAccountId, async () => undefined);
  });
});

describe("capability decisions", () => {
  it.each(capabilityDefinitions.filter(definition => definition.mode !== "local" && definition.probe.adapterRegistered))(
    "directs missing $id grants to external administrator prerequisites", async definition => {
      const denied = async () => { throw new AppError(403, "missing_permission", "Synthetic missing grant"); };
      const { value, repository } = service(new MemoryRepository(), { delegatedToken: denied, applicationToken: denied });
      const admin: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
      if (definition.mode === "application") {
        repository.configurations.set(definition.id, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 1 });
      }
      const decision = definition.id === "purview.audit.search.application"
        ? await value.recordAuditQualificationEvidence(definition.id, admin, "missing_permission", { category: "missing_permission" }, 1)
        : definition.id === "defender.hunting.application"
          ? await value.recordHuntingQualificationEvidence(definition.id, admin, "missing_permission", { category: "missing_permission" }, 1)
          : await value.refresh(definition.id, admin);
      expect(decision.status).toBe("missing_permission");
      const message = decision.remediation.join(" ");
      expect(message).toContain("API permissions");
      expect(message).toContain("existing Entra app registration");
      expect(message).toContain("Grant admin consent");
      expect(message).toContain(`Required ${definition.mode} permissions: ${definition.permissions.join(", ")}`);
      expect(message).not.toContain("using the signed-in account");
    },
  );

  it("keeps MFA and Conditional Access recovery separate from missing API grants", async () => {
    const { value } = service(new MemoryRepository(), {
      delegatedToken: async () => { throw new AppError(401, "interaction_required", "Synthetic MFA required"); },
    });
    const decision = await value.refresh("graph.agentIdentity.read", reader);
    expect(decision.remediation.join(" ")).toContain("Sign in again");
    expect(decision.remediation.join(" ")).toContain("MFA");
    expect(decision.remediation.join(" ")).toContain("Conditional Access");
    expect(decision.remediation.join(" ")).not.toContain("Grant admin consent");
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)(
    "lists the complete registry for %s without implicitly resolving agent identities", async role => {
      const { value, probes, repository } = service();
      const user: AuthenticatedUser = { ...reader, roles: [role] };
      const views = await value.list(user);
      expect(views.map(view => view.definition.id)).toEqual(capabilityIds);
      expect(views.find(view => view.definition.id === "graph.agentIdentity.read")).toMatchObject({
        definition: { consentGroup: "graph.agentIdentity.read", permissions: ["AgentIdentity.Read.All"] },
        decision: { status: "available", authorized: true, verification: "on_demand" },
      });
      for (const probe of Object.values(probes)) expect(probe).not.toHaveBeenCalled();
      expect(repository.recordEvidence).not.toHaveBeenCalled();

      expect((await value.check(user)).map(view => view.definition.id)).toEqual(capabilityIds);
      expect(probes.delegatedToken).not.toHaveBeenCalledWith(user.tenantId, user.homeAccountId, "graph.agentIdentity.read");
    },
  );

  it.each(["graph.agentIdentity.read", "graph.licenses.read", "reports.copilotUsage.read"] as const)(
    "describes an on-demand %s read without target confirmation", async id => {
      const { value, probes, repository } = service();
      const decision = await value.decision(id, reader);
      expect(decision).toMatchObject({ status: "available", authorized: true, verification: "on_demand" });
      expect(decision.remediation.join(" ")).toMatch(/read/i);
      expect(decision.remediation.join(" ")).not.toMatch(/choose a target|confirm/i);
      expect(probes.delegatedToken).not.toHaveBeenCalled();
      expect(repository.recordEvidence).not.toHaveBeenCalled();
    },
  );

  it.each(["graph.package.read.application", "purview.audit.search.application", "defender.hunting.application"] as const)(
    "does not recommend delegated automatic checks for unverified %s", async id => {
      const { value, probes, repository } = service();
      repository.configurations.set(id, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
      const decision = await value.decision(id, reader);
      expect(decision.status).toBe("unknown");
      expect(decision.remediation.join(" ")).toMatch(/explicit.*application-scope/i);
      expect(decision.remediation.join(" ")).not.toMatch(/Run the automatic/i);
      await value.check(reader, { retryFailed: true });
      expect(probes.applicationToken).not.toHaveBeenCalled();
      expect((await value.decision(id, reader)).status).toBe("unknown");
      await expect(value.requireAvailable(id, reader)).rejects.toMatchObject({ code: "capability_unavailable" });
      expect(probes.applicationToken).not.toHaveBeenCalled();
    },
  );

  it.each(["graph.agentIdentity.read", "graph.licenses.read", "reports.copilotUsage.read"] as const)(
    "directs expired %s evidence to an explicit read rather than Check status", async id => {
      const delegatedToken = vi.fn(async () => "delegated-token");
      const { value, repository } = service(new MemoryRepository(), { delegatedToken });
      await value.refresh(id, reader);
      const evidence = [...repository.evidenceRows.values()][0];
      evidence.expiresAt = new Date(0).toISOString();
      const decision = await value.decision(id, reader);
      expect(decision.status).toBe("unknown");
      expect(decision.remediation.join(" ")).toMatch(/read from the dashboard/);
      expect(decision.remediation.join(" ")).not.toMatch(/Run the automatic/i);
      delegatedToken.mockClear();
      await value.check(reader, { retryFailed: true });
      expect(delegatedToken).not.toHaveBeenCalledWith(reader.tenantId, reader.homeAccountId, id);
      expect((await value.decision(id, reader)).status).toBe("unknown");
      await expect(value.requireAvailable(id, { ...reader, roles: [] })).rejects.toMatchObject({
        code: "capability_unavailable", details: { status: "missing_internal_role" },
      });
      expect(delegatedToken).not.toHaveBeenCalledWith(reader.tenantId, reader.homeAccountId, id);
      await expect(value.requireAvailable(id, reader)).resolves.toMatchObject({
        status: "available", authorized: true, fresh: true, verification: "token",
      });
      expect(delegatedToken).toHaveBeenCalledWith(reader.tenantId, reader.homeAccountId, id);
    },
  );

  it.each(["graph.agentIdentity.read", "graph.licenses.read", "reports.copilotUsage.read"] as const)(
    "preserves fresh %s failures and rechecks expired failures only for an explicit read", async id => {
      const delegatedToken = vi.fn(async () => "delegated-token");
      const { value, repository, probes } = service(new MemoryRepository(), { delegatedToken });
      await value.refresh(id, reader);
      const evidence = [...repository.evidenceRows.values()][0];
      evidence.expiresAt = new Date(0).toISOString();
      delegatedToken.mockRejectedValueOnce(new AppError(403, "missing_permission", "Consent required"));

      await expect(value.requireAvailable(id, reader)).rejects.toMatchObject({
        code: "capability_unavailable",
        details: { status: "missing_permission", authorized: false, fresh: true },
      });
      expect(delegatedToken).toHaveBeenCalledTimes(2);
      await expect(value.requireAvailable(id, reader)).rejects.toMatchObject({
        code: "capability_unavailable", details: { status: "missing_permission" },
      });
      expect(delegatedToken).toHaveBeenCalledTimes(2);

      const failedEvidence = [...repository.evidenceRows.values()][0];
      failedEvidence.expiresAt = new Date(0).toISOString();
      await expect(value.requireAvailable(id, reader)).resolves.toMatchObject({
        status: "available", authorized: true, fresh: true, verification: "token",
      });
      expect(delegatedToken).toHaveBeenCalledTimes(3);
      expect(probes.applicationToken).not.toHaveBeenCalled();
      expect(probes.packageProbe).not.toHaveBeenCalled();
      expect(probes.directoryProbe).not.toHaveBeenCalled();
      expect(probes.inventoryProbe).not.toHaveBeenCalled();
    },
  );

  it("allows implemented Admin actions immediately without inventing provider or canary evidence", async () => {
    const { value, probes, repository } = service();
    const admin: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    for (const id of ["graph.package.access.manage", "graph.package.block.manage", "powerPlatform.quarantine.manage"] as const) {
      const decision = await value.requireAvailable(id, admin);
      expect(decision).toMatchObject({ status: "available", authorized: true, fresh: true, verification: "on_demand", previewQualification: "not_required" });
      expect(decision.checkedAt).toBeUndefined();
      expect(decision.lastSuccessAt).toBeUndefined();
      expect(decision.remediation.join(" ")).toContain("Choose a target and confirm the operation");
      await expect(value.requireAvailable(id, reader)).rejects.toMatchObject({ code: "capability_unavailable", details: { status: "missing_internal_role" } });
    }
    expect(probes.delegatedToken).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(await value.decision("graph.package.read.delegated", admin)).toMatchObject({ status: "unknown", authorized: false });
    expect(await value.decision("graph.package.read.application", admin)).toMatchObject({ status: "not_configured", authorized: false });
    expect(await value.decision("graph.package.reassign.manage", admin)).toMatchObject({ status: "not_configured", authorized: false });
  });

  it.each(["graph.package.access.manage", "graph.package.block.manage", "powerPlatform.quarantine.manage"] as const)(
    "checks %s consent without performing a provider operation and preserves real failures until recovery", async id => {
      const admin: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
      const delegatedToken = vi.fn(async () => "delegated-token");
      const { value, probes, repository } = service(new MemoryRepository(), { delegatedToken });
      expect(await value.decision(id, admin)).toMatchObject({ verification: "on_demand" });
      expect(await value.refresh(id, admin)).toMatchObject({
        status: "available", verification: "token", authorized: true, previewQualification: "not_required",
        checkedAt: expect.any(String), expiresAt: expect.any(String),
      });
      for (const [code, status] of [
        ["missing_permission", "missing_permission"],
        ["interaction_required", "unknown"],
        ["authorization_expired", "unknown"],
        ["identity_provider_error", "provider_error"],
      ]) {
        delegatedToken.mockRejectedValueOnce(new AppError(403, code, "private identity detail"));
        expect(await value.refresh(id, admin)).toMatchObject({
          status, authorized: false, evidence: { category: code, phase: "token_acquisition" },
        });
        await expect(value.requireAvailable(id, admin)).rejects.toMatchObject({
          code: status === "missing_permission" ? "capability_unavailable"
            : status === "provider_error" ? "provider_error" : code,
        });
      }
      expect(await value.refresh(id, admin)).toMatchObject({ status: "available", verification: "token" });
      const evidence = [...repository.evidenceRows.values()][0];
      evidence.expiresAt = new Date(Date.now() - 1).toISOString();
      expect(await value.decision(id, admin)).toMatchObject({ status: "unknown", fresh: false, authorized: false });
      await expect(value.requireAvailable(id, admin)).resolves.toMatchObject({ verification: "token" });
      expect(await value.decision(id, { ...admin, homeAccountId: "another-admin" })).toMatchObject({ verification: "on_demand" });
      expect(await value.decision(id, reader)).toMatchObject({ status: "missing_internal_role" });
      expect(delegatedToken).toHaveBeenCalledWith(admin.tenantId, admin.homeAccountId, id);
      expect(probes.packageProbe).not.toHaveBeenCalled();
      expect(probes.directoryProbe).not.toHaveBeenCalled();
      expect(probes.inventoryProbe).not.toHaveBeenCalled();
      expect(probes.applicationToken).not.toHaveBeenCalled();
    },
  );

  it("automatically checks Admin write scopes, reuses successful token evidence, and retries missing consent", async () => {
    const admin: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    let consented = false;
    const delegatedToken = vi.fn(async (_tenantId: string, _accountId: string, id: CapabilityId) => {
      if (!consented && id.startsWith("graph.package.") && id.endsWith(".manage")) {
        throw new AppError(403, "missing_permission", "Consent required");
      }
      return "delegated-token";
    });
    const { value, probes } = service(new MemoryRepository(), { delegatedToken });
    const first = await value.check(admin);
    for (const id of ["graph.package.access.manage", "graph.package.block.manage"]) {
      expect(first.find(view => view.definition.id === id)?.decision).toMatchObject({ status: "missing_permission", authorized: false });
    }
    expect(first.find(view => view.definition.id === "powerPlatform.quarantine.manage")?.decision.verification).toBe("token");
    expect(delegatedToken).toHaveBeenCalledTimes(9);
    await value.check(admin);
    expect(delegatedToken).toHaveBeenCalledTimes(9);
    consented = true;
    const recovered = await value.check(admin, { retryFailed: true });
    expect(delegatedToken).toHaveBeenCalledTimes(11);
    for (const id of ["graph.package.access.manage", "graph.package.block.manage"]) {
      expect(recovered.find(view => view.definition.id === id)?.decision).toMatchObject({ status: "available", verification: "token" });
    }
    expect(probes.packageProbe).toHaveBeenCalledOnce();
    expect(probes.directoryProbe).toHaveBeenCalledOnce();
    expect(probes.inventoryProbe).toHaveBeenCalledOnce();
    expect(probes.applicationToken).not.toHaveBeenCalled();
  });

  it("publishes verification only for successful current evidence, not absent, failed, expired, or disabled checks", async () => {
    const { value, repository } = service();
    const administrator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    for (const id of ["graph.package.read.delegated", "purview.audit.search.delegated", "powerPlatform.quarantine.read",
      "graph.package.read.application", "graph.package.reassign.manage"] as const) {
      expect((await value.decision(id, administrator)).verification).toBeUndefined();
    }
    expect((await value.decision("reports.official.import", reader)).verification).toBeUndefined();
    expect((await value.decision("reports.official.import", administrator)).verification).toBe("local");
    expect((await value.refresh("graph.package.read.delegated", reader)).verification).toBe("provider");
    const evidence = [...repository.evidenceRows.values()][0];
    for (const verification of [undefined, "local", "qualification", "token"]) {
      evidence.details.verification = verification;
      expect((await value.decision("graph.package.read.delegated", reader)).verification).toBeUndefined();
    }
    evidence.details.verification = "provider";
    evidence.status = "provider_error";
    expect((await value.decision("graph.package.read.delegated", reader)).verification).toBeUndefined();
    evidence.status = "available";
    for (const expiresAt of [new Date(Date.now() - 1).toISOString(), "invalid"]) {
      evidence.expiresAt = expiresAt;
      expect(await value.decision("graph.package.read.delegated", reader)).toMatchObject({ status: "unknown", fresh: false, authorized: false });
      expect((await value.decision("graph.package.read.delegated", reader)).verification).toBeUndefined();
    }
  });

  it("does not label failed token acquisition or explicit provider qualification as successful proof", async () => {
    const { value } = service(new MemoryRepository(), {
      delegatedToken: async () => { throw new AppError(403, "missing_permission", "Denied"); },
    });
    expect((await value.refresh("powerPlatform.quarantine.read", reader)).verification).toBeUndefined();
    expect((await value.recordAuditQualificationEvidence("purview.audit.search.delegated", reader, "provider_error", {})).verification).toBeUndefined();
    expect((await value.recordHuntingQualificationEvidence("defender.hunting.delegated", reader, "provider_error", {})).verification).toBeUndefined();
  });

  it("publishes bounded Graph diagnostics without copying provider messages, bodies, or tokens", async () => {
    const client = new GraphPackagesClient(async () => Response.json({
      error: { code: "Authorization_RequestDenied", message: "person@example.invalid private-token", innerError: { private: "private-body" } },
    }, { status: 403, headers: { "request-id": "provider-request-123" } }));
    const { value, repository } = service(new MemoryRepository(), { packageProbe: token => client.checkCatalogAccess(token) });
    const result = await value.refresh("graph.package.read.delegated", reader);
    expect(result).toMatchObject({ status: "provider_error", authorized: false, evidence: {
      category: "provider_error", httpStatus: 403, providerErrorCode: "Authorization_RequestDenied", correlationId: "provider-request-123",
    } });
    expect(result.verification).toBeUndefined();
    expect(JSON.stringify(repository.recordEvidence.mock.calls)).not.toMatch(/person@|private-token|private-body/);
    expect(JSON.stringify(await value.list(reader))).not.toMatch(/person@|private-token|private-body/);
  });

  it.each([
    [new DOMException("private timeout detail", "TimeoutError"), "provider_timeout", /timed out/],
    [new TypeError("private network detail"), "provider_network_error", /connectivity/],
    [new AppError(429, "TooManyRequests", "private detail"), "provider_throttled", /Wait/],
    [new AppError(502, "provider_schema", "private detail"), "provider_schema", /contract/],
    [new AppError(502, "provider_result_limit", "private detail"), "provider_result_limit", /contract/],
  ])("retains a safe actionable category for %s", async (error, category, guidance) => {
    const { value } = service(new MemoryRepository(), { packageProbe: async () => { throw error; } });
    const result = await value.refresh("graph.package.read.delegated", reader);
    expect(result.evidence?.category).toBe(category);
    expect(result.verification).toBeUndefined();
    expect(result.remediation.join(" ")).toMatch(guidance);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects unsafe and oversized provider evidence fields before persistence and publication", async () => {
    const { value, repository } = service();
    const result = await value.recordAuditQualificationEvidence("purview.audit.search.delegated", reader, "provider_error", {
      category: "person@example.invalid", correlationId: "person@example.invalid", httpStatus: "403 private",
      providerErrorCode: "x".repeat(129), accessToken: "private-token", body: "private-body",
    });
    expect(result.evidence).toEqual({});
    expect(repository.recordEvidence).toHaveBeenCalledWith(expect.any(Object), "provider_error", { verification: "provider" }, expect.any(Number));
  });

  it.each([
    [403, 403], ["403", 403], [99, undefined], [600, undefined], [403.5, undefined],
    [Number.NaN, undefined], [Number.POSITIVE_INFINITY, undefined], [" 403", undefined], ["403 private", undefined],
  ])("publishes only bounded integral provider HTTP status from %s", async (httpStatus, expected) => {
    const { value, repository } = service();
    const result = await value.recordAuditQualificationEvidence("purview.audit.search.delegated", reader, "provider_error", { httpStatus });
    expect(result.evidence?.httpStatus).toBe(expected);
    expect([...repository.evidenceRows.values()][0].details.httpStatus).toBe(expected);
  });

  it("records a deadline failure even when the token provider never settles", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const { value, probes } = service(new MemoryRepository(), { delegatedToken: vi.fn(() => new Promise<string>(() => {})) });
      const pending = value.refresh("graph.package.read.delegated", reader);
      await vi.waitFor(() => expect(probes.delegatedToken).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(10_000);
      controller.abort(new DOMException("private deadline", "TimeoutError"));
      const result = await pending;
      expect(result).toMatchObject({ status: "provider_error", authorized: false, evidence: { category: "provider_timeout", phase: "token_acquisition", timeoutMs: 10_000 } });
      expect(result.verification).toBeUndefined();
      expect(probes.packageProbe).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("lets Admin inherit Viewer authority without sharing another principal's evidence", async () => {
    const { value } = service();
    const administrator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    expect((await value.decision("graph.package.read.delegated", administrator)).status).toBe("unknown");
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    expect((await value.decision("graph.package.read.delegated", { ...reader, homeAccountId: "reader-b" })).status).toBe("unknown");
  });

  it("gives catalog reads an independent bounded budget after token acquisition", async () => {
    const tokenDeadline = new AbortController();
    const providerDeadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(tokenDeadline.signal).mockReturnValueOnce(providerDeadline.signal);
    const held = deferred<unknown>();
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => held.promise) });
    try {
      const pending = value.refresh("graph.package.read.delegated", reader);
      await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledOnce());
      expect(timeout.mock.calls.map(call => call[0])).toEqual([10_000, 30_000]);
      tokenDeadline.abort(new DOMException("token budget elapsed", "TimeoutError"));
      held.resolve([]);
      await expect(pending).resolves.toMatchObject({ status: "available", verification: "provider" });
    } finally { timeout.mockRestore(); }
  });

  it("identifies a stalled catalog provider read separately from token acquisition", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout")
      .mockReturnValue(controller.signal).mockReturnValueOnce(new AbortController().signal);
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => new Promise(() => {})) });
    try {
      const pending = value.refresh("graph.package.read.delegated", reader);
      await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledOnce());
      controller.abort(new DOMException("private provider detail", "TimeoutError"));
      await expect(pending).resolves.toMatchObject({
        status: "provider_error", authorized: false,
        evidence: { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000 },
      });
    } finally { timeout.mockRestore(); }
  });

  it.each([
    ["token", true], ["token", false], ["provider", true], ["provider", false],
  ] as const)("retries a real %s deadline with a fresh budget (recovery: %s)", async (phase, recover) => {
    const firstDeadline = new AbortController();
    const secondDeadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    if (phase === "provider") timeout.mockReturnValueOnce(new AbortController().signal);
    timeout.mockReturnValueOnce(firstDeadline.signal).mockReturnValueOnce(secondDeadline.signal);
    const held = deferred<string>();
    const operation = vi.fn().mockImplementationOnce(() => new Promise<string>(() => {})).mockImplementationOnce(() => held.promise);
    const { value, repository } = service(new MemoryRepository(), phase === "token"
      ? { delegatedToken: operation } : { packageProbe: operation });
    try {
      const pending = value.refresh("graph.package.read.delegated", reader);
      await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
      firstDeadline.abort(new DOMException("first attempt deadline", "TimeoutError"));
      await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
      expect(repository.recordEvidence).not.toHaveBeenCalled();
      if (recover) held.resolve("successful second attempt");
      else secondDeadline.abort(new DOMException("second attempt deadline", "TimeoutError"));
      await expect(pending).resolves.toMatchObject(recover ? { status: "available" }
        : { status: "provider_error", evidence: { category: "provider_timeout", phase: phase === "token" ? "token_acquisition" : "provider_read" } });
      expect(repository.recordEvidence).toHaveBeenCalledOnce();
      expect(operation).toHaveBeenCalledTimes(2);
      const budget = phase === "token" ? 10_000 : 30_000;
      expect(timeout.mock.calls.filter(([duration]) => duration === budget)).toHaveLength(2);
    } finally { timeout.mockRestore(); }
  });

  it("explicitly retries a fresh failed check without repeating successful or write probes", async () => {
    const packageProbe = vi.fn()
      .mockRejectedValueOnce(new DOMException("private", "TimeoutError"))
      .mockRejectedValueOnce(new DOMException("private", "TimeoutError"))
      .mockResolvedValue([]);
    const { value, probes } = service(new MemoryRepository(), { packageProbe });
    await value.check(reader);
    await value.check(reader);
    expect(packageProbe).toHaveBeenCalledTimes(2);
    const result = await value.check(reader, { retryFailed: true });
    expect(packageProbe).toHaveBeenCalledTimes(3);
    expect(probes.directoryProbe).toHaveBeenCalledTimes(1);
    expect(probes.inventoryProbe).toHaveBeenCalledTimes(1);
    expect(probes.applicationToken).not.toHaveBeenCalled();
    expect(result.find(view => view.definition.id === "graph.package.read.delegated")?.decision.status).toBe("available");
    expect(result.find(view => view.definition.id === "graph.package.block.manage")?.decision.authorized).toBe(false);
  });

  it.each([
    [new DOMException("private timeout", "TimeoutError"), 504, "provider_timeout"],
    [new TypeError("private transport error"), 503, "provider_error"],
    [new AppError(403, "graph_error", "private denial"), 503, "provider_error"],
    [new AppError(429, "TooManyRequests", "private throttle"), 429, "provider_throttled"],
    [new AppError(403, "missing_permission", "private consent"), 403, "capability_unavailable"],
    [new AppError(401, "interaction_required", "private authentication"), 401, "interaction_required"],
  ])("preserves the readiness failure category for %s", async (error, status, code) => {
    const packageProbe = vi.fn().mockRejectedValue(error);
    const { value } = service(new MemoryRepository(), { packageProbe });
    await value.refresh("graph.package.read.delegated", reader);
    await expect(value.requireAvailable("graph.package.read.delegated", reader)).rejects.toMatchObject({
      status, code, details: { authorized: false },
    });
    expect(packageProbe).toHaveBeenCalledTimes(error instanceof TypeError || error.name === "TimeoutError" ? 2 : 1);
  });

  it("rechecks only the requested capability on an explicit failed-read retry", async () => {
    const packageProbe = vi.fn().mockRejectedValueOnce(new DOMException("private", "TimeoutError"))
      .mockRejectedValueOnce(new DOMException("private", "TimeoutError")).mockResolvedValue([]);
    const { value, probes } = service(new MemoryRepository(), { packageProbe });
    await value.refresh("graph.package.read.delegated", reader);
    await expect(value.requireAvailable("graph.package.read.delegated", reader)).rejects.toMatchObject({ code: "provider_timeout" });
    expect(packageProbe).toHaveBeenCalledTimes(2);
    await expect(value.requireAvailable("graph.package.read.delegated", reader, { retryFailed: true }))
      .resolves.toMatchObject({ authorized: true });
    await value.requireAvailable("graph.package.read.delegated", reader, { retryFailed: true });
    expect(packageProbe).toHaveBeenCalledTimes(3);
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(probes.applicationToken).not.toHaveBeenCalled();
  });

  it("keeps explicit read retries blocked when rechecking fails and honors throttling cooldowns", async () => {
    const packageProbe = vi.fn()
      .mockRejectedValueOnce(new DOMException("private", "TimeoutError"))
      .mockRejectedValue(new AppError(429, "TooManyRequests", "private"));
    const { value } = service(new MemoryRepository(), { packageProbe });
    await value.refresh("graph.package.read.delegated", reader);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(value.requireAvailable("graph.package.read.delegated", reader, { retryFailed: true }))
        .rejects.toMatchObject({ status: 429, code: "provider_throttled" });
    }
    expect(packageProbe).toHaveBeenCalledTimes(2);
  });

  it.each([429, 424])("preserves a fresh provider throttling cooldown for HTTP %i during explicit retry", async status => {
    const packageProbe = vi.fn(async () => { throw new AppError(status, "TooManyRequests", "private", { throttled: true }); });
    const { value } = service(new MemoryRepository(), { packageProbe });
    await value.check(reader);
    const result = await value.check(reader, { retryFailed: true });
    expect(packageProbe).toHaveBeenCalledOnce();
    expect(result.find(view => view.definition.id === "graph.package.read.delegated")?.decision.evidence?.category).toBe("provider_throttled");
  });

  it("preserves the cooldown for the inventory adapter's generic HTTP 429 error", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
    const client = new PowerPlatformResourceQueryClient(fetcher, { maxAttempts: 1 });
    const { value } = service(new MemoryRepository(), { inventoryProbe: token => client.checkAccess(token) });
    const first = await value.check(reader);
    expect(first.find(view => view.definition.id === "powerPlatform.inventory.read")?.decision).toMatchObject({
      status: "provider_error", evidence: { category: "provider_throttled" },
    });
    await value.check(reader, { retryFailed: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("accepts a bounded inventory access sample when the tenant total exceeds the refresh ceiling", async () => {
    const fetcher = vi.fn(async () => Response.json({
      totalRecords: 5_001, count: 1, resultTruncated: 1, skipToken: "next",
      data: [{ tenantId: reader.tenantId, name: "environment-a", type: "microsoft.powerplatform/environments", properties: {} }],
    }));
    const client = new PowerPlatformResourceQueryClient(fetcher);
    const { value } = service(new MemoryRepository(), { inventoryProbe: token => client.checkAccess(token) });

    expect(await value.refresh("powerPlatform.inventory.read", reader)).toMatchObject({
      status: "available", authorized: true, verification: "provider",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("activates the inventory read adapter without pretending it qualifies preview writes", async () => {
    const { value } = service();
    expect((await value.refresh("powerPlatform.inventory.read", reader)).status).toBe("available");
    const operator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    expect(await value.refresh("graph.package.block.manage", operator)).toMatchObject({ status: "available", verification: "token", previewQualification: "not_required" });
  });

  it("defers quarantine authorization to Microsoft instead of optional ID-token role claims", async () => {
    const { value, probes } = service();
    const operator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    const viewer = { ...reader, providerRoleIds: ["00000000-0000-0000-0000-000000000000"] };
    expect(await value.refresh("powerPlatform.quarantine.read", viewer)).toMatchObject({ status: "available", authorized: true });
    expect((await value.decision("powerPlatform.quarantine.manage", viewer)).status).toBe("missing_internal_role");
    expect(await value.refresh("powerPlatform.quarantine.manage", operator)).toMatchObject({ status: "available", authorized: true, previewQualification: "not_required" });
    expect((await value.list(operator)).find(view => view.definition.id === "powerPlatform.quarantine.manage")).toMatchObject({
      definition: { probe: { kind: "on_demand" } },
      decision: { status: "available", authorized: true, verification: "token", previewQualification: "not_required" },
    });
    expect(probes.delegatedToken).toHaveBeenCalledWith(operator.tenantId, operator.homeAccountId, "powerPlatform.quarantine.manage");
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(await value.quarantineAuthorityContext(operator)).toMatchObject({ contractRevision: expect.stringMatching(/^[a-f0-9]{64}$/), permissionRevision: expect.stringMatching(/^[a-f0-9]{64}$/), configurationRevision: 1 });

    const unrecognizedClaims = { ...operator, providerRoleIds: ["00000000-0000-0000-0000-000000000000"] };
    expect(await value.refresh("powerPlatform.quarantine.manage", unrecognizedClaims)).toMatchObject({ status: "available", authorized: true });
    expect(probes.delegatedToken).toHaveBeenCalledTimes(3);
    await expect(value.quarantineAuthorityContext(unrecognizedClaims)).resolves.toMatchObject({ configurationRevision: 1 });
    await expect(value.quarantineApprovalAuthorityContext(reader)).rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(value.quarantineApprovalAuthorityContext(operator)).resolves.toMatchObject({ configurationRevision: 1 });

    const providerDenied = service(new MemoryRepository(), {
      delegatedToken: async () => { throw new AppError(403, "missing_permission", "Microsoft denied delegated access."); },
    });
    expect(await providerDenied.value.refresh("powerPlatform.quarantine.read", viewer)).toMatchObject({ status: "missing_permission", authorized: false });
  });

  it("read-through checks Admin quarantine readiness without running a provider mutation or canary", async () => {
    const administrator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    const { value, probes } = service();

    await expect(value.requireAvailable("powerPlatform.quarantine.manage", administrator)).resolves.toMatchObject({
      status: "available",
      authorized: true,
      verification: "on_demand",
    });
    expect(probes.delegatedToken).not.toHaveBeenCalled();
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
  });

  it("records token-only readiness without creating a Purview query", async () => {
    const securityReader: AuthenticatedUser = { ...reader, roles: ["AgentControl.Viewer"] };
    const { value, probes, repository } = service();

    await expect(value.refresh("purview.audit.search.delegated", securityReader)).resolves.toMatchObject({
      status: "available",
      authorized: true,
      verification: "token",
    });
    expect(probes.delegatedToken).toHaveBeenCalledWith(securityReader.tenantId, securityReader.homeAccountId, "purview.audit.search.delegated");
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).toHaveBeenCalledWith(expect.any(Object), "available",
      expect.objectContaining({ verification: "token" }), expect.any(Number));
  });

  it("does not turn application qualification into token-only readiness", async () => {
    const operator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    const { value, probes, repository } = service();
    repository.configurations.set("purview.audit.search.application", { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });

    await expect(value.refresh("purview.audit.search.application", operator)).resolves.toMatchObject({
      status: "unknown",
      authorized: false,
    });
    expect(probes.applicationToken).not.toHaveBeenCalled();
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("records explicit Audit and Hunting execution as provider verification", async () => {
    const { value, repository } = service();
    await value.recordAuditQualificationEvidence("purview.audit.search.delegated", reader, "available", { providerRequestId: "audit-request" });
    await value.recordHuntingQualificationEvidence("defender.hunting.delegated", reader, "available", { providerRequestId: "hunting-request" });
    expect(repository.recordEvidence).toHaveBeenNthCalledWith(1, expect.any(Object), "available",
      expect.objectContaining({ verification: "provider" }), expect.any(Number));
    expect(repository.recordEvidence).toHaveBeenNthCalledWith(2, expect.any(Object), "available",
      expect.objectContaining({ verification: "provider" }), expect.any(Number));
  });

  it("coalesces automatic Viewer checks and reuses fresh cooldown evidence without requesting write or application tokens", async () => {
    const held = deferred<unknown>();
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => held.promise) });
    const first = value.check(reader);
    const second = value.check(reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    held.resolve([]);
    const [firstViews, secondViews] = await Promise.all([first, second]);
    expect(firstViews).toEqual(secondViews);
    expect(probes.delegatedToken).toHaveBeenCalledTimes(6);
    expect(probes.packageProbe).toHaveBeenCalledTimes(1);
    expect(probes.directoryProbe).toHaveBeenCalledTimes(1);
    expect(probes.inventoryProbe).toHaveBeenCalledTimes(1);
    expect(firstViews).toEqual(expect.arrayContaining([
      expect.objectContaining({ definition: expect.objectContaining({ id: "purview.audit.search.delegated" }), decision: expect.objectContaining({ verification: "token", authorized: true }) }),
      expect.objectContaining({ definition: expect.objectContaining({ id: "reports.official.import" }), decision: expect.objectContaining({ status: "missing_internal_role" }) }),
      expect.objectContaining({ definition: expect.objectContaining({ id: "graph.package.read.delegated" }), enabled: true }),
      expect.objectContaining({ definition: expect.objectContaining({ id: "graph.package.read.application" }), enabled: false, configuration: { enabled: false, sharedDataScope: false } }),
    ]));
    await value.check(reader);
    expect(probes.delegatedToken).toHaveBeenCalledTimes(6);
    expect(probes.packageProbe).toHaveBeenCalledTimes(1);
  });

  it("coalesces read probes but does not skip Admin token checks when a Viewer check is already running", async () => {
    const held = deferred<unknown>();
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => held.promise) });
    const administrator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    const viewerCheck = value.check(reader);
    const adminCheck = value.check(administrator);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    held.resolve([]);
    const [adminViews, viewerViews] = await Promise.all([adminCheck, viewerCheck]);
    expect(adminViews.find(view => view.definition.id === "powerPlatform.quarantine.manage")?.decision).toMatchObject({
      status: "available",
      authorized: true,
      verification: "token",
    });
    expect(viewerViews.find(view => view.definition.id === "powerPlatform.quarantine.manage")?.decision.status).toBe("missing_internal_role");
    expect(probes.delegatedToken).toHaveBeenCalledWith(administrator.tenantId, administrator.homeAccountId, "powerPlatform.quarantine.manage");
    expect(probes.delegatedToken).toHaveBeenCalledWith(administrator.tenantId, administrator.homeAccountId, "graph.package.access.manage");
    expect(probes.delegatedToken).toHaveBeenCalledWith(administrator.tenantId, administrator.homeAccountId, "graph.package.block.manage");
    expect(probes.packageProbe).toHaveBeenCalledTimes(1);
    expect(probes.directoryProbe).toHaveBeenCalledTimes(1);
    expect(probes.inventoryProbe).toHaveBeenCalledTimes(1);
  });

  it("requires explicit shared application configuration", async () => {
    const { value, repository } = service();
    expect((await value.decision("graph.package.read.application", reader)).status).toBe("not_configured");
    repository.configurations.set("graph.package.read.application", { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    expect((await value.refresh("graph.package.read.application", reader)).status).toBe("available");
  });

  it("stores redacted provider failure categories without messages or tokens", async () => {
    const repository = new MemoryRepository();
    const value = new CapabilityService(repository as never, {
      delegatedToken: vi.fn(async () => { throw Object.assign(new AppError(502, "provider_error", "secret bearer-token", { accessToken: "never-persist", responseBody: "private-provider-response" }), { correlationId: "safe-correlation" }); }),
      applicationToken: vi.fn(), packageProbe: vi.fn(), directoryProbe: vi.fn(), inventoryProbe: vi.fn(),
    });
    expect(await value.refresh("graph.package.read.delegated", reader)).toMatchObject({ status: "provider_error", evidence: { category: "provider_error", correlationId: "safe-correlation" } });
    expect(repository.recordEvidence).toHaveBeenCalledWith(expect.any(Object), "provider_error",
      { category: "provider_error", correlationId: "safe-correlation", phase: "token_acquisition", timeoutMs: 10_000, verification: "provider" }, expect.any(Number));
    expect(JSON.stringify(repository.recordEvidence.mock.calls)).not.toMatch(/secret bearer-token|never-persist|private-provider-response/);
    expect(JSON.stringify(await value.list(reader))).not.toMatch(/secret bearer-token|never-persist|private-provider-response/);
  });

  it("shares one non-mutating request for concurrent complete-key callers", async () => {
    const held = deferred<unknown>();
    const { value, probes } = service(new MemoryRepository(), { packageProbe: vi.fn(() => held.promise) });
    const first = value.refresh("graph.package.read.delegated", reader);
    const second = value.refresh("graph.package.read.delegated", reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    held.resolve([]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "available" }),
      expect.objectContaining({ status: "available" }),
    ]);
    expect(probes.delegatedToken).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a newer generation after configuration lookup and allows a fresh recheck", async () => {
    const held = deferred<CapabilityConfiguration>();
    const repository = new MemoryRepository();
    repository.configuration.mockImplementationOnce(() => held.promise);
    const { value, probes } = service(repository);
    const refresh = value.refresh("graph.package.read.delegated", reader);
    await vi.waitFor(() => expect(repository.configuration).toHaveBeenCalledOnce());
    await value.invalidatePrincipal(reader);
    held.resolve({ enabled: false, sharedDataScope: false, previewQualified: false, revision: 1 });

    await expect(refresh).rejects.toMatchObject({ code: "authorization_expired" });
    expect(probes.delegatedToken).not.toHaveBeenCalled();
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
    expect(repository.evidenceRows.size).toBe(0);

    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    expect(probes.delegatedToken).toHaveBeenCalledTimes(1);
    expect(probes.packageProbe).toHaveBeenCalledTimes(1);
    expect(repository.evidenceRows.size).toBe(1);
  });

  it("rejects a decision whose evidence read crossed principal invalidation", async () => {
    const { value, repository } = service();
    await value.refresh("graph.package.read.delegated", reader);
    const evidence = [...repository.evidenceRows.values()][0];
    const held = deferred<CapabilityEvidence>();
    repository.evidence.mockClear().mockImplementationOnce(() => held.promise);
    const pending = value.decision("graph.package.read.delegated", reader);
    await vi.waitFor(() => expect(repository.evidence).toHaveBeenCalledOnce());
    await value.invalidatePrincipal(reader);
    held.resolve(evidence);
    await expect(pending).rejects.toMatchObject({ code: "authorization_expired" });
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("waits for pending invalidation before reading evidence under the new generation", async () => {
    const { value, repository } = service();
    await value.refresh("graph.package.read.delegated", reader);
    const held = deferred<void>();
    repository.invalidatePrincipal.mockImplementationOnce(async () => {
      await held.promise;
      repository.evidenceRows.clear();
    });
    const invalidation = value.invalidatePrincipal(reader);
    await vi.waitFor(() => expect(repository.invalidatePrincipal).toHaveBeenCalledOnce());
    const pending = value.decision("graph.package.read.delegated", reader);
    held.resolve();
    await invalidation;
    await expect(pending).resolves.toMatchObject({ status: "unknown", authorized: false });
  });

  it("blocks stale evidence after failed principal invalidation until cleanup succeeds", async () => {
    const { value, repository, probes } = service();
    await value.refresh("graph.package.read.delegated", reader);
    expect(repository.evidenceRows.size).toBe(1);
    const failure = new Error("Evidence invalidation failed");
    repository.invalidatePrincipal.mockRejectedValueOnce(failure);

    await expect(value.invalidatePrincipal(reader)).rejects.toBe(failure);
    await expect(value.decision("graph.package.read.delegated", reader)).rejects.toMatchObject({
      status: 503,
      code: "capability_invalidation_failed",
    });
    await expect(value.refresh("graph.package.read.delegated", reader)).rejects.toMatchObject({
      status: 503,
      code: "capability_invalidation_failed",
    });
    expect(probes.packageProbe).toHaveBeenCalledOnce();
    expect(repository.evidenceRows.size).toBe(1);

    await value.invalidatePrincipal(reader);
    expect(repository.evidenceRows.size).toBe(0);
    await expect(value.decision("graph.package.read.delegated", reader)).resolves.toMatchObject({
      status: "unknown",
      authorized: false,
    });
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({
      status: "available",
      authorized: true,
    });
    expect(probes.packageProbe).toHaveBeenCalledTimes(2);
  });

  it("waits for pending application configuration before granting scope or starting a probe", async () => {
    const { value, repository, probes } = service();
    const id = "graph.package.read.application";
    repository.configurations.set(id, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    const held = deferred<void>();
    const configure = repository.setApplicationConfiguration.getMockImplementation()!;
    repository.setApplicationConfiguration.mockImplementationOnce(async (...args) => {
      await held.promise;
      return configure(...args);
    });
    const configured = value.configureApplication(id, { ...reader, roles: ["AgentControl.Admin"] }, false, false);
    await vi.waitFor(() => expect(repository.setApplicationConfiguration).toHaveBeenCalledOnce());
    const scope = value.requireApplicationDataScope(id, reader);
    const probe = value.refresh(id, reader);
    held.resolve();
    await Promise.all([
      configured,
      expect(scope).rejects.toMatchObject({ code: "not_configured" }),
      expect(probe).resolves.toMatchObject({ status: "not_configured", authorized: false }),
    ]);
    expect(probes.applicationToken).not.toHaveBeenCalled();
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
  });

  it("rejects a catalog assembled across an application configuration change", async () => {
    const { value, repository } = service();
    const id = "graph.package.read.application";
    const configuration = { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 };
    repository.configurations.set(id, configuration);
    await value.refresh(id, reader);
    const held = deferred<CapabilityConfiguration>();
    const readConfiguration = repository.configuration.getMockImplementation()!;
    let applicationReads = 0;
    repository.configuration.mockImplementation((tenantId, capabilityId) => {
      if (capabilityId === id && ++applicationReads === 2) return held.promise;
      return readConfiguration(tenantId, capabilityId);
    });
    const decisions = vi.spyOn(value, "decision");
    const pending = value.list(reader);
    await vi.waitFor(() => expect(decisions).toHaveResolvedWith(expect.objectContaining({ capabilityId: id, authorized: true })));
    await value.configureApplication(id, { ...reader, roles: ["AgentControl.Admin"] }, false, false);
    held.resolve(configuration);
    await expect(pending).rejects.toMatchObject({ code: "authorization_expired" });
  });

  describe.each([
    {
      name: "Audit",
      applicationId: "purview.audit.search.application" as const,
      record: (value: CapabilityService, mode: "delegated" | "application" = "delegated", configurationRevision?: number, status: CapabilityEvidence["status"] = "available") =>
        value.recordAuditQualificationEvidence(`purview.audit.search.${mode}`, reader, status, {}, configurationRevision),
    },
    {
      name: "Hunting",
      applicationId: "defender.hunting.application" as const,
      record: (value: CapabilityService, mode: "delegated" | "application" = "delegated", configurationRevision?: number, status: CapabilityEvidence["status"] = "available") =>
        value.recordHuntingQualificationEvidence(`defender.hunting.${mode}`, reader, status, {}, configurationRevision),
    },
  ])("$name evidence invalidation", ({ applicationId, record }) => {
    it.each([undefined, 1])("rejects application evidence without a matching approved revision (%s)", async revision => {
      const { value, repository } = service();
      repository.configurations.set(applicationId, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
      for (const status of ["available", "provider_error"] as const) {
        await expect(record(value, "application", revision, status)).rejects.toMatchObject({ code: "qualification_superseded" });
      }
      expect(repository.recordEvidence).not.toHaveBeenCalled();
      expect(repository.evidenceRows.size).toBe(0);
      await expect(value.decision(applicationId, reader)).resolves.toMatchObject({ status: "unknown", authorized: false });
    });

    it("records application evidence only for the still-enabled approved revision", async () => {
      const { value, repository } = service();
      repository.configurations.set(applicationId, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
      await expect(record(value, "application", 2)).resolves.toMatchObject({ status: "available", verification: "provider" });
      expect(repository.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ configurationRevision: 2 }),
        "available", { verification: "provider" }, expect.any(Number));
      for (const configuration of [{ enabled: false, sharedDataScope: true }, { enabled: true, sharedDataScope: false }]) {
        repository.configurations.set(applicationId, { ...configuration, previewQualified: false, revision: 2 });
        await expect(record(value, "application", 2)).rejects.toMatchObject({ code: "qualification_superseded" });
      }
      expect(repository.recordEvidence).toHaveBeenCalledOnce();
    });

    it("does not replace current evidence with a late result from a previous application configuration", async () => {
      const { value, repository } = service();
      const admin: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
      const approved = await value.configureApplication(applicationId, admin, true, true);
      const current = await value.configureApplication(applicationId, admin, true, true);
      await record(value, "application", current.revision);
      for (const status of ["available", "provider_error"] as const) {
        await expect(record(value, "application", approved.revision, status)).rejects.toMatchObject({ code: "qualification_superseded" });
      }
      expect(repository.recordEvidence).toHaveBeenCalledOnce();
      await expect(value.decision(applicationId, reader)).resolves.toMatchObject({ status: "available", verification: "provider" });
    });

    it("does not adopt a newer principal generation during configuration lookup", async () => {
      const { value, repository } = service();
      const held = deferred<CapabilityConfiguration>();
      repository.configuration.mockImplementationOnce(() => held.promise);
      const pending = record(value);
      await vi.waitFor(() => expect(repository.configuration).toHaveBeenCalledOnce());
      await value.invalidatePrincipal(reader);
      held.resolve({ enabled: false, sharedDataScope: false, previewQualified: false, revision: 1 });
      await expect(pending).rejects.toMatchObject({ code: "authorization_expired" });
      expect(repository.recordEvidence).not.toHaveBeenCalled();
      expect(repository.evidenceRows.size).toBe(0);
      await expect(record(value)).resolves.toMatchObject({ status: "available", verification: "provider" });
    });

    it("does not adopt a newer application generation during configuration lookup", async () => {
      const { value, repository } = service();
      const configuration = { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 };
      repository.configurations.set(applicationId, configuration);
      const held = deferred<CapabilityConfiguration>();
      repository.configuration.mockImplementationOnce(() => held.promise);
      const pending = record(value, "application", 2);
      await vi.waitFor(() => expect(repository.configuration).toHaveBeenCalledOnce());
      await value.configureApplication(applicationId, { ...reader, roles: ["AgentControl.Admin"] }, false, false);
      held.resolve(configuration);
      await expect(pending).rejects.toMatchObject({ code: "authorization_expired" });
      expect(repository.recordEvidence).not.toHaveBeenCalled();
      expect(repository.evidenceRows.size).toBe(0);
    });

    it("rejects evidence invalidated while persistence is pending", async () => {
      const { value, repository } = service();
      const held = deferred<void>();
      const persist = repository.recordEvidence.getMockImplementation()!;
      repository.recordEvidence.mockImplementationOnce(async (...args) => {
        await held.promise;
        return persist(...args);
      });
      const pending = record(value);
      await vi.waitFor(() => expect(repository.recordEvidence).toHaveBeenCalledOnce());
      const rejected = expect(pending).rejects.toMatchObject({ code: "authorization_expired" });
      const invalidation = value.invalidatePrincipal(reader);
      held.resolve();
      await invalidation;
      await rejected;
      expect(repository.evidenceRows.size).toBe(0);
    });

    it("rejects invalidation during the final evidence read", async () => {
      const { value, repository } = service();
      const held = deferred<void>();
      repository.evidence.mockImplementationOnce(async key => {
        const evidence = repository.evidenceRows.get(JSON.stringify(key));
        await held.promise;
        return evidence;
      });
      const pending = record(value);
      await vi.waitFor(() => expect(repository.evidence).toHaveBeenCalledOnce());
      await value.invalidatePrincipal(reader);
      held.resolve();
      await expect(pending).rejects.toMatchObject({ code: "authorization_expired" });
      expect(repository.evidenceRows.size).toBe(0);
    });

    it("propagates persistence failures and permits a subsequent recording", async () => {
      const { value, repository } = service();
      const error = new Error("Evidence persistence failed");
      repository.recordEvidence.mockRejectedValueOnce(error);
      await expect(record(value)).rejects.toBe(error);
      expect(repository.evidenceRows.size).toBe(0);
      await expect(record(value)).resolves.toMatchObject({ status: "available", verification: "provider" });
    });
  });

  it("stops every queued automatic probe at its original generation after invalidation", async () => {
    const held = deferred<CapabilityConfiguration>();
    const repository = new MemoryRepository();
    repository.configuration.mockImplementation(() => held.promise);
    const { value, probes } = service(repository);
    const check = value.check(reader);
    await vi.waitFor(() => expect(repository.configuration).toHaveBeenCalled());
    await value.invalidatePrincipal(reader);
    held.resolve({ enabled: false, sharedDataScope: false, previewQualified: false, revision: 1 });

    await expect(check).rejects.toMatchObject({ code: "authorization_expired" });
    expect(probes.delegatedToken).not.toHaveBeenCalled();
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("does not let held success resurrect after consent or role invalidation", async () => {
    const held = deferred<unknown>();
    const repository = new MemoryRepository();
    const { value, probes } = service(repository, { packageProbe: vi.fn(() => held.promise) });
    const refresh = value.refresh("graph.package.read.delegated", reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    const invalidation = value.invalidatePrincipal(reader);
    held.resolve([]);
    await invalidation;
    await expect(refresh).rejects.toMatchObject({ code: "authorization_expired" });
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("does not return an automatic check assembled from invalidated principal evidence", async () => {
    const held = deferred<unknown>();
    const repository = new MemoryRepository();
    const { value, probes } = service(repository, { packageProbe: vi.fn(() => held.promise) });
    const check = value.check(reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    const invalidation = value.invalidatePrincipal(reader);
    held.resolve([]);
    await invalidation;
    await expect(check).rejects.toMatchObject({ code: "authorization_expired" });
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("does not let held application success survive a configuration revision", async () => {
    const held = deferred<unknown>();
    const repository = new MemoryRepository();
    repository.configurations.set("graph.package.read.application", { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    const { value, probes } = service(repository, { packageProbe: vi.fn(() => held.promise) });
    const refresh = value.refresh("graph.package.read.application", reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    const administrator: AuthenticatedUser = { ...reader, roles: ["AgentControl.Admin"] };
    const configured = value.configureApplication("graph.package.read.application", administrator, false, false);
    held.resolve([]);
    await configured;
    await expect(refresh).rejects.toMatchObject({ code: "authorization_expired" });
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("isolates principal failures and records complete application/environment scope", async () => {
    const repository = new MemoryRepository();
    repository.configurations.set("graph.package.read.application", { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    const { value } = service(repository, { delegatedToken: vi.fn(async (_tenantId, accountId) => {
      if (accountId === "reader-b") throw new Error("provider unavailable");
      return "delegated-token";
    }) });
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    await expect(value.refresh("graph.package.read.delegated", { ...reader, homeAccountId: "reader-b" })).resolves.toMatchObject({ status: "provider_error" });
    await expect(value.refresh("graph.package.read.application", reader)).resolves.toMatchObject({ status: "available" });
    const keys = repository.recordEvidence.mock.calls.map(call => call[0] as EvidenceKey);
    expect(keys).toEqual(expect.arrayContaining([
      expect.objectContaining({ principalId: "reader-a", authorizationPrincipalId: "reader-a", environmentId: "global", tokenMode: "delegated" }),
      expect.objectContaining({ principalId: "reader-b", authorizationPrincipalId: "reader-b", environmentId: "global", tokenMode: "delegated" }),
      expect.objectContaining({ principalId: "22222222-2222-2222-2222-222222222222", authorizationPrincipalId: "reader-a", environmentId: "global", tokenMode: "application" }),
    ]));
    for (const key of keys) expect(key.contractRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("partitions application identity, provider tokens, and invalidation by tenant even for the same account", async () => {
    const repository = new MemoryRepository();
    const applicationId = "graph.package.read.application";
    repository.configurations.set(applicationId, { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    const { value, probes } = service(repository);
    const other = { ...reader, tenantId: "33333333-3333-3333-3333-333333333333" };
    await Promise.all([
      value.refresh(applicationId, reader), value.refresh(applicationId, other),
      value.refresh("graph.package.read.delegated", reader), value.refresh("graph.package.read.delegated", other),
    ]);
    expect(probes.applicationToken).toHaveBeenCalledWith(reader.tenantId, applicationId);
    expect(probes.applicationToken).toHaveBeenCalledWith(other.tenantId, applicationId);
    expect(probes.delegatedToken).toHaveBeenCalledWith(reader.tenantId, reader.homeAccountId, "graph.package.read.delegated");
    expect(probes.delegatedToken).toHaveBeenCalledWith(other.tenantId, reader.homeAccountId, "graph.package.read.delegated");
    expect(repository.recordEvidence.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: reader.tenantId, principalId: "22222222-2222-2222-2222-222222222222", tokenMode: "application" }),
      expect.objectContaining({ tenantId: other.tenantId, principalId: "44444444-4444-4444-4444-444444444444", tokenMode: "application" }),
    ]));
    await value.invalidatePrincipal(reader);
    expect(await value.decision("graph.package.read.delegated", reader)).toMatchObject({ status: "unknown" });
    expect(await value.decision("graph.package.read.delegated", other)).toMatchObject({ status: "available" });
    expect(await value.decision(applicationId, other)).toMatchObject({ status: "available" });
  });

  it("never authorizes expired success evidence", async () => {
    const { value, repository, probes } = service();
    await value.refresh("graph.package.read.delegated", reader);
    const [key, evidence] = [...repository.evidenceRows.entries()][0];
    repository.evidenceRows.set(key, { ...evidence, expiresAt: new Date(Date.now() - 1).toISOString() });
    await expect(value.decision("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "unknown", authorized: false, fresh: false });
    await expect(value.requireAvailable("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available", verification: "provider" });
    expect(probes.packageProbe).toHaveBeenCalledTimes(2);
  });

  it("distinguishes interaction and expired authorization from confirmed missing permission", async () => {
    for (const [code, status] of [
      ["interaction_required", "unknown"],
      ["authorization_expired", "unknown"],
      ["missing_permission", "missing_permission"],
    ] as const) {
      const { value } = service(new MemoryRepository(), {
        delegatedToken: async () => { throw new AppError(403, code, code); },
      });
      await expect(value.refresh("purview.audit.search.delegated", reader)).resolves.toMatchObject({
        status,
        evidence: { category: code },
        verification: undefined,
      });
    }
  });

  it.each([
    ["authorization_not_yet_valid", undefined, /host clock and time synchronization/],
    ["identity_provider_error", "AADSTS900144", /identity-provider troubleshooting/],
  ] as const)("retains actionable %s diagnostics without claiming token proof", async (code, providerErrorCode, guidance) => {
    const { value, repository } = service(new MemoryRepository(), {
      delegatedToken: async () => { throw new AppError(502, code, "private token diagnostic", { correlationId: "identity-request-123", providerErrorCode }); },
    });
    const result = await value.refresh("powerPlatform.quarantine.read", reader);
    expect(result).toMatchObject({ status: "provider_error", authorized: false, evidence: { category: code, correlationId: "identity-request-123" } });
    expect(result.evidence?.providerErrorCode).toBe(providerErrorCode);
    expect(result.evidence?.httpStatus).toBeUndefined();
    expect(result.verification).toBeUndefined();
    expect(result.remediation.join(" ")).toMatch(guidance);
    expect(JSON.stringify(repository.recordEvidence.mock.calls)).not.toContain("private token diagnostic");
  });

  it("retains Entra consent error codes and correlation IDs without confusing them with provider verification", async () => {
    const { value } = service(new MemoryRepository(), {
      delegatedToken: async () => { throw new AppError(403, "missing_permission", "private", { correlationId: "identity-request-123", providerErrorCode: "AADSTS65001" }); },
    });
    const result = await value.refresh("graph.package.read.delegated", reader);
    expect(result).toMatchObject({ status: "missing_permission", authorized: false, evidence: {
      category: "missing_permission", correlationId: "identity-request-123", providerErrorCode: "AADSTS65001",
    } });
    expect(result.verification).toBeUndefined();
    expect(result.evidence?.httpStatus).toBeUndefined();
  });
});