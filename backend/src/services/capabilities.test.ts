import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../types/session.js";
import type { CapabilityConfiguration, CapabilityEvidence, EvidenceKey } from "../db/capabilities.js";
import { AppError } from "../errors.js";
import { inventoryProviderRoleIds } from "./inventoryRoleScope.js";
import { CapabilityService } from "./capabilities.js";

vi.hoisted(() => { process.env.CLIENT_ID = "22222222-2222-2222-2222-222222222222"; });

const reader: AuthenticatedUser = { tenantId: "tenant", homeAccountId: "reader-a", username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Reader"] };

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

class MemoryQualifications {
  qualified = new Set<string>();
  current = vi.fn(async (_tenantId: string, action: string) => this.qualified.has(action) ? { id: action } : undefined);
}

function service(repository = new MemoryRepository(), overrides: Partial<{ delegatedToken: (accountId: string) => Promise<string>; applicationToken: () => Promise<string>; packageProbe: (token: string) => Promise<unknown>; directoryProbe: (token: string) => Promise<unknown>; inventoryProbe: (token: string) => Promise<unknown> }> = {}, qualifications = new MemoryQualifications()) {
  const probes = {
    delegatedToken: vi.fn(async () => "delegated-token"), applicationToken: vi.fn(async () => "application-token"),
    packageProbe: vi.fn(async () => []), directoryProbe: vi.fn(async () => []), inventoryProbe: vi.fn(async () => []),
    ...overrides,
  };
  return { repository, probes, qualifications, value: new CapabilityService(repository as never, probes as never, qualifications as never) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("capability decisions", () => {
  it("does not inherit administrator authority or another principal's evidence", async () => {
    const { value } = service();
    const administrator = { ...reader, roles: ["AgentControl.Administrator"] as const };
    expect((await value.decision("graph.package.read.delegated", administrator)).status).toBe("missing_internal_role");
    await expect(value.refresh("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "available" });
    expect((await value.decision("graph.package.read.delegated", { ...reader, homeAccountId: "reader-b" })).status).toBe("unknown");
  });

  it("activates the inventory read adapter without pretending it qualifies preview writes", async () => {
    const { value } = service();
    expect((await value.refresh("powerPlatform.inventory.read", reader)).status).toBe("available");
    const operator = { ...reader, roles: ["AgentControl.Operator"] as const };
    expect((await value.refresh("graph.package.block.manage", operator)).status).toBe("preview_disabled");
  });

  it("activates quarantine consent without a target probe and requires an exact supported provider role", async () => {
    const { value, probes } = service();
    const operator = { ...reader, roles: ["AgentControl.Operator"] as const, providerRoleIds: [inventoryProviderRoleIds.aiAdministrator] };
    expect(await value.refresh("powerPlatform.quarantine.manage", operator)).toMatchObject({ status: "available", authorized: true, previewQualification: "not_required" });
    expect(probes.delegatedToken).toHaveBeenCalledWith(operator.homeAccountId, "powerPlatform.quarantine.manage");
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(await value.quarantineAuthorityContext(operator)).toMatchObject({ contractRevision: expect.stringMatching(/^[a-f0-9]{64}$/), permissionRevision: expect.stringMatching(/^[a-f0-9]{64}$/), configurationRevision: 1 });

    const missingRole = { ...operator, providerRoleIds: [inventoryProviderRoleIds.aiReader] };
    expect(await value.refresh("powerPlatform.quarantine.manage", missingRole)).toMatchObject({ status: "missing_role", authorized: false });
    expect(probes.delegatedToken).toHaveBeenCalledTimes(1);
    await expect(value.quarantineAuthorityContext(missingRole)).rejects.toMatchObject({ code: "missing_role" });
    await expect(value.quarantineApprovalAuthorityContext({ ...reader, roles: ["AgentControl.Administrator"] })).resolves.toMatchObject({ configurationRevision: 1 });
    await expect(value.quarantineApprovalAuthorityContext(operator)).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("never creates or qualifies a Purview query during routine capability refresh", async () => {
    const securityReader = { ...reader, roles: ["AgentControl.SecurityReader"] as const };
    const { value, probes, repository } = service();

    await expect(value.refresh("purview.audit.search.delegated", securityReader)).resolves.toMatchObject({
      status: "unknown",
      authorized: false,
    });
    expect(probes.delegatedToken).not.toHaveBeenCalled();
    expect(probes.packageProbe).not.toHaveBeenCalled();
    expect(probes.directoryProbe).not.toHaveBeenCalled();
    expect(probes.inventoryProbe).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
  });

  it("requires current qualification for both operations in a package write capability", async () => {
    const qualifications = new MemoryQualifications();
    const { value } = service(new MemoryRepository(), {}, qualifications);
    const operator = { ...reader, roles: ["AgentControl.Operator"] as const };
    qualifications.qualified.add("block");
    expect(await value.decision("graph.package.block.manage", operator)).toMatchObject({ status: "preview_disabled", authorized: false });
    qualifications.qualified.add("unblock");
    expect(await value.decision("graph.package.block.manage", operator)).toMatchObject({ status: "available", authorized: true, previewQualification: "qualified" });
  });

  it("keeps access writes disabled even when both generic qualifications exist", async () => {
    const qualifications = new MemoryQualifications();
    qualifications.qualified.add("update-availability");
    qualifications.qualified.add("update-installation");
    const { value } = service(new MemoryRepository(), {}, qualifications);
    const operator = { ...reader, roles: ["AgentControl.Operator"] as const };
    expect(await value.decision("graph.package.access.manage", operator)).toMatchObject({ status: "preview_disabled", authorized: false });
    expect(qualifications.current).not.toHaveBeenCalled();
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
      applicationToken: vi.fn(), packageProbe: vi.fn(), directoryProbe: vi.fn(),
    }, new MemoryQualifications() as never);
    expect(await value.refresh("graph.package.read.delegated", reader)).toMatchObject({ status: "provider_error", evidence: { category: "provider_error", correlationId: "safe-correlation" } });
    expect(repository.recordEvidence).toHaveBeenCalledWith(expect.any(Object), "provider_error", { category: "provider_error", correlationId: "safe-correlation" }, expect.any(Number));
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

  it("does not let held success resurrect after consent or role invalidation", async () => {
    const held = deferred<unknown>();
    const repository = new MemoryRepository();
    const { value, probes } = service(repository, { packageProbe: vi.fn(() => held.promise) });
    const refresh = value.refresh("graph.package.read.delegated", reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    const invalidation = value.invalidatePrincipal(reader);
    held.resolve([]);
    await invalidation;
    await expect(refresh).resolves.toMatchObject({ status: "unknown" });
    expect(repository.evidenceRows.size).toBe(0);
  });

  it("does not let held application success survive a configuration revision", async () => {
    const held = deferred<unknown>();
    const repository = new MemoryRepository();
    repository.configurations.set("graph.package.read.application", { enabled: true, sharedDataScope: true, previewQualified: false, revision: 2 });
    const { value, probes } = service(repository, { packageProbe: vi.fn(() => held.promise) });
    const refresh = value.refresh("graph.package.read.application", reader);
    await vi.waitFor(() => expect(probes.packageProbe).toHaveBeenCalledTimes(1));
    const administrator = { ...reader, roles: ["AgentControl.Administrator"] as const };
    const configured = value.configureApplication("graph.package.read.application", administrator, false, false);
    held.resolve([]);
    await configured;
    await expect(refresh).resolves.toMatchObject({ status: "not_configured" });
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
    const { value, repository } = service();
    await value.refresh("graph.package.read.delegated", reader);
    const [key, evidence] = [...repository.evidenceRows.entries()][0];
    repository.evidenceRows.set(key, { ...evidence, expiresAt: new Date(Date.now() - 1).toISOString() });
    await expect(value.decision("graph.package.read.delegated", reader)).resolves.toMatchObject({ status: "unknown", authorized: false, fresh: false });
  });
});