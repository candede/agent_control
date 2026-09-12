import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../types/session.js";
import type { CapabilityId } from "../types/capability.js";
import type { CapabilityConfiguration, CapabilityEvidence, EvidenceKey } from "../db/capabilities.js";
import { AppError } from "../errors.js";
import { CapabilityService } from "./capabilities.js";
import { GraphPackagesClient } from "./graphPackages.js";

vi.hoisted(() => { process.env.CLIENT_ID = "22222222-2222-2222-2222-222222222222"; });

const reader: AuthenticatedUser = { tenantId: "tenant", homeAccountId: "reader-a", username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer"] };

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
  invalidatePrincipal = vi.fn(async (_tenantId: string, principalId: string) => {
    for (const [key] of this.evidenceRows) if ((JSON.parse(key) as EvidenceKey).authorizationPrincipalId === principalId) this.evidenceRows.delete(key);
  });
  invalidateCapability = vi.fn(async (_tenantId: string, capabilityId: string) => {
    for (const [key] of this.evidenceRows) if ((JSON.parse(key) as EvidenceKey).capabilityId === capabilityId) this.evidenceRows.delete(key);
  });
}

function service(repository = new MemoryRepository(), overrides: Partial<{ delegatedToken: (accountId: string, capabilityId: CapabilityId) => Promise<string>; applicationToken: () => Promise<string>; packageProbe: (token: string) => Promise<unknown>; directoryProbe: (token: string) => Promise<unknown>; inventoryProbe: (token: string) => Promise<unknown> }> = {}) {
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

describe("capability decisions", () => {
  it("allows implemented Admin actions immediately without inventing provider or canary evidence", async () => {
    const { value, probes, repository } = service();
    const admin = { ...reader, roles: ["AgentControl.Admin"] as const };
    for (const id of ["graph.package.access.manage", "graph.package.block.manage", "powerPlatform.quarantine.manage"] as const) {
      const decision = await value.requireAvailable(id, admin);
      expect(decision).toMatchObject({ status: "available", authorized: true, fresh: true, verification: "on_demand", previewQualification: "not_required" });
      expect(decision.checkedAt).toBeUndefined();
      expect(decision.lastSuccessAt).toBeUndefined();
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
      const admin = { ...reader, roles: ["AgentControl.Admin"] as const };
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
        await expect(value.requireAvailable(id, admin)).rejects.toMatchObject({ code: "capability_unavailable" });
      }
      expect(await value.refresh(id, admin)).toMatchObject({ status: "available", verification: "token" });
      const evidence = [...repository.evidenceRows.values()][0];
      evidence.expiresAt = new Date(Date.now() - 1).toISOString();
      expect(await value.decision(id, admin)).toMatchObject({ status: "unknown", fresh: false, authorized: false });
      await expect(value.requireAvailable(id, admin)).resolves.toMatchObject({ verification: "token" });
      expect(await value.decision(id, { ...admin, homeAccountId: "another-admin" })).toMatchObject({ verification: "on_demand" });
      expect(await value.decision(id, reader)).toMatchObject({ status: "missing_internal_role" });
      expect(delegatedToken).toHaveBeenCalledWith(admin.homeAccountId, id);
      expect(probes.packageProbe).not.toHaveBeenCalled();
      expect(probes.directoryProbe).not.toHaveBeenCalled();
      expect(probes.inventoryProbe).not.toHaveBeenCalled();
      expect(probes.applicationToken).not.toHaveBeenCalled();
    },
  );

  it("automatically checks Admin write scopes, reuses successful token evidence, and retries missing consent", async () => {
    const admin = { ...reader, roles: ["AgentControl.Admin"] as const };
    let consented = false;
    const delegatedToken = vi.fn(async (_accountId: string, id: CapabilityId) => {
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
    const administrator = { ...reader, roles: ["AgentControl.Admin"] as const };
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
    const administrator = { ...reader, roles: ["AgentControl.Admin"] as const };
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
      .mockReturnValueOnce(new AbortController().signal).mockReturnValueOnce(controller.signal);
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

  it("explicitly retries a fresh failed check without repeating successful or write probes", async () => {
    const packageProbe = vi.fn()
      .mockRejectedValueOnce(new DOMException("private", "TimeoutError"))
      .mockResolvedValue([]);
    const { value, probes } = service(new MemoryRepository(), { packageProbe });
    await value.check(reader);
    await value.check(reader);
    expect(packageProbe).toHaveBeenCalledTimes(1);
    const result = await value.check(reader, { retryFailed: true });
    expect(packageProbe).toHaveBeenCalledTimes(2);
    expect(probes.directoryProbe).toHaveBeenCalledTimes(1);
    expect(probes.inventoryProbe).toHaveBeenCalledTimes(1);
    expect(probes.applicationToken).not.toHaveBeenCalled();
    expect(result.find(view => view.definition.id === "graph.package.read.delegated")?.decision.status).toBe("available");
    expect(result.find(view => view.definition.id === "graph.package.block.manage")?.decision.authorized).toBe(false);
  });

  it.each([429, 424])("preserves a fresh provider throttling cooldown for HTTP %i during explicit retry", async status => {
    const packageProbe = vi.fn(async () => { throw new AppError(status, "TooManyRequests", "private", { throttled: true }); });
    const { value } = service(new MemoryRepository(), { packageProbe });
    await value.check(reader);
    const result = await value.check(reader, { retryFailed: true });
    expect(packageProbe).toHaveBeenCalledOnce();
    expect(result.find(view => view.definition.id === "graph.package.read.delegated")?.decision.evidence?.category).toBe("provider_throttled");
  });

  it("activates the inventory read adapter without pretending it qualifies preview writes", async () => {
    const { value } = service();
    expect((await value.refresh("powerPlatform.inventory.read", reader)).status).toBe("available");
    const operator = { ...reader, roles: ["AgentControl.Admin"] as const };
    expect(await value.refresh("graph.package.block.manage", operator)).toMatchObject({ status: "available", verification: "token", previewQualification: "not_required" });
  });

  it("defers quarantine authorization to Microsoft instead of optional ID-token role claims", async () => {
    const { value, probes } = service();
    const operator = { ...reader, roles: ["AgentControl.Admin"] as const };
    const viewer = { ...reader, providerRoleIds: ["00000000-0000-0000-0000-000000000000"] };
    expect(await value.refresh("powerPlatform.quarantine.read", viewer)).toMatchObject({ status: "available", authorized: true });
    expect((await value.decision("powerPlatform.quarantine.manage", viewer)).status).toBe("missing_internal_role");
    expect(await value.refresh("powerPlatform.quarantine.manage", operator)).toMatchObject({ status: "available", authorized: true, previewQualification: "not_required" });
    expect((await value.list(operator)).find(view => view.definition.id === "powerPlatform.quarantine.manage")).toMatchObject({
      definition: { probe: { kind: "on_demand" } },
      decision: { status: "available", authorized: true, verification: "token", previewQualification: "not_required" },
    });
    expect(probes.delegatedToken).toHaveBeenCalledWith(operator.homeAccountId, "powerPlatform.quarantine.manage");
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
    const administrator = { ...reader, roles: ["AgentControl.Admin"] as const };
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
    const securityReader = { ...reader, roles: ["AgentControl.Viewer"] as const };
    const { value, probes, repository } = service();

    await expect(value.refresh("purview.audit.search.delegated", securityReader)).resolves.toMatchObject({
      status: "available",
      authorized: true,
      verification: "token",
    });
    expect(probes.delegatedToken).toHaveBeenCalledWith(securityReader.homeAccountId, "purview.audit.search.delegated");
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).toHaveBeenCalledWith(expect.any(Object), "available",
      expect.objectContaining({ verification: "token" }), expect.any(Number));
  });

  it("does not turn application qualification into token-only readiness", async () => {
    const operator = { ...reader, roles: ["AgentControl.Admin"] as const };
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
    const administrator = { ...reader, roles: ["AgentControl.Admin"] as const };
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
    expect(probes.delegatedToken).toHaveBeenCalledWith(administrator.homeAccountId, "powerPlatform.quarantine.manage");
    expect(probes.delegatedToken).toHaveBeenCalledWith(administrator.homeAccountId, "graph.package.access.manage");
    expect(probes.delegatedToken).toHaveBeenCalledWith(administrator.homeAccountId, "graph.package.block.manage");
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
    const administrator = { ...reader, roles: ["AgentControl.Admin"] as const };
    const configured = value.configureApplication("graph.package.read.application", administrator, false, false);
    held.resolve([]);
    await configured;
    await expect(refresh).rejects.toMatchObject({ code: "authorization_expired" });
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("isolates principal failures and records complete application/environment scope", async () => {
    const repository = new MemoryRepository();
    repository.configurations.set("graph.package.read.application", { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    const { value } = service(repository, { delegatedToken: vi.fn(async accountId => {
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