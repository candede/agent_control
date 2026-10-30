import { describe, expect, it, vi } from "vitest";
import { seedBrowserCapabilityEvidence } from "./browserFixtureCapabilities.js";
import { type CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision } from "../src/db/capabilities.js";
import { capabilityDefinitions } from "../src/services/capabilityRegistry.js";
import type { AuthenticatedUser } from "../src/types/session.js";

const tenants = vi.hoisted(() => [
  { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222" },
  { tenantId: "55555555-5555-4555-8555-555555555555", clientId: "66666666-6666-4666-8666-666666666666" },
]);
vi.mock("../src/config.js", () => ({
  getTenantConfiguration: (tenantId: string) => {
    const tenant = tenants.find(value => value.tenantId === tenantId);
    if (!tenant) throw new Error("Unknown synthetic tenant.");
    return tenant;
  },
}));

const providerReads = capabilityDefinitions.filter(definition => definition.probe.kind === "provider_read");
function setup(scenario = "available", tenantId = tenants[1].tenantId) {
  const user: AuthenticatedUser = {
    tenantId, homeAccountId: `fixture-${scenario}`, displayName: "Synthetic account",
    username: "fixture@example.invalid", roles: ["AgentControl.Viewer"],
  };
  const repository = {
    configuration: vi.fn<CapabilityRepository["configuration"]>().mockResolvedValue({
      enabled: true, sharedDataScope: true, previewQualified: false, revision: 17,
    }),
    recordEvidence: vi.fn<CapabilityRepository["recordEvidence"]>().mockResolvedValue({
      status: "available", details: {}, observedAt: "2026-09-09T10:00:00.000Z",
      expiresAt: "2026-09-09T10:04:00.000Z", lastSuccessAt: undefined,
    }),
  };
  return { user, repository };
}

describe("browser capability evidence", () => {
  it.each(tenants)("uses the signed-in tenant and its application identity: $tenantId", async tenant => {
    const { user, repository } = setup("lifecycle-desktop-running", tenant.tenantId);
    await seedBrowserCapabilityEvidence(repository, user);
    expect(providerReads.some(definition => definition.mode === "application")).toBe(true);
    expect(repository.configuration).toHaveBeenCalledTimes(providerReads.length);
    expect(repository.recordEvidence).toHaveBeenCalledTimes(providerReads.length);
    for (const definition of providerReads) {
      expect(repository.configuration).toHaveBeenCalledWith(tenant.tenantId, definition.id);
      expect(repository.recordEvidence).toHaveBeenCalledWith({
        tenantId: tenant.tenantId, principalId: definition.mode === "application" ? tenant.clientId : user.homeAccountId,
        authorizationPrincipalId: user.homeAccountId, capabilityId: definition.id, resourceAudience: definition.audience,
        environmentId: definition.cloud, tokenMode: definition.mode,
        permissionRevision: capabilityPermissionRevision(definition), contractRevision: capabilityContractRevision(definition),
        configurationRevision: 17,
      }, "available", expect.any(Object), 240000, expect.any(Function));
    }
  });

  it.each([
    "available", "missing_permission", "missing_internal_role", "missing_role", "missing_license",
    "not_configured", "unsupported", "preview_disabled", "provider_error", "unknown",
  ])("preserves the explicit scenario status: %s", async status => {
    const { user, repository } = setup(status);
    await seedBrowserCapabilityEvidence(repository, user);
    expect(repository.recordEvidence).toHaveBeenCalledTimes(providerReads.length);
    for (const [key, observed, details, ttl] of repository.recordEvidence.mock.calls) {
      expect(observed).toBe(status);
      expect(details).toEqual({
        category: status === "provider_error" ? "provider_error" : undefined,
        verification: key.capabilityId === "powerPlatform.quarantine.read" ? "token" : "provider",
      });
      expect(ttl).toBe(240000);
    }
  });

  it.each(["stale", "role-Viewer", "role-Admin", "lifecycle-mobile-failed"])("preserves synthetic available evidence: %s", async scenario => {
    const { user, repository } = setup(scenario);
    await seedBrowserCapabilityEvidence(repository, user);
    expect(repository.recordEvidence).toHaveBeenCalledTimes(providerReads.length);
    for (const [, status, , ttl] of repository.recordEvidence.mock.calls) {
      expect(status).toBe("available");
      expect(ttl).toBe(scenario === "stale" ? -1000 : 240000);
    }
  });

  it.each(["missing_delegated_grant", "unrecognized"])("does not seed unrelated scenarios: %s", async scenario => {
    const { user, repository } = setup(scenario);
    await seedBrowserCapabilityEvidence(repository, user);
    expect(repository.configuration).not.toHaveBeenCalled();
    expect(repository.recordEvidence).not.toHaveBeenCalled();
  });

  it.each(["configuration", "recordEvidence"] as const)("propagates %s failures", async method => {
    const { user, repository } = setup();
    const failure = new Error("Synthetic evidence failure.");
    repository[method].mockRejectedValueOnce(failure);
    await expect(seedBrowserCapabilityEvidence(repository, user)).rejects.toBe(failure);
  });
});
