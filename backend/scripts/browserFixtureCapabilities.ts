import { getTenantConfiguration } from "../src/config.js";
import { type CapabilityRepository, capabilityContractRevision, capabilityPermissionRevision } from "../src/db/capabilities.js";
import { capabilityDefinitions } from "../src/services/capabilityRegistry.js";
import type { CapabilityStatus } from "../src/types/capability.js";
import type { AuthenticatedUser } from "../src/types/session.js";

const statuses: readonly CapabilityStatus[] = ["available", "missing_permission", "missing_internal_role", "missing_role", "missing_license", "not_configured", "unsupported", "preview_disabled", "provider_error", "unknown"];

export async function seedBrowserCapabilityEvidence(repository: Pick<CapabilityRepository, "configuration" | "recordEvidence">,
  user: AuthenticatedUser) {
  const scenario = user.homeAccountId.replace(/^fixture-/, "");
  const status = statuses.find(value => value === scenario);
  if (!status && !["stale", "role-Viewer", "role-Admin"].includes(scenario) && !scenario.startsWith("lifecycle-")) return;
  const tenant = getTenantConfiguration(user.tenantId!);
  for (const definition of capabilityDefinitions.filter(definition => definition.probe.kind === "provider_read")) {
    const configuration = await repository.configuration(tenant.tenantId, definition.id);
    await repository.recordEvidence({
      tenantId: tenant.tenantId, principalId: definition.mode === "application" ? tenant.clientId : user.homeAccountId,
      authorizationPrincipalId: user.homeAccountId, capabilityId: definition.id, resourceAudience: definition.audience,
      environmentId: definition.cloud, tokenMode: definition.mode as "delegated" | "application",
      permissionRevision: capabilityPermissionRevision(definition), contractRevision: capabilityContractRevision(definition),
      configurationRevision: configuration.revision,
    }, status ?? "available", {
      category: scenario === "provider_error" ? "provider_error" : undefined,
      verification: definition.id === "powerPlatform.quarantine.read" ? "token" : "provider",
    }, scenario === "stale" ? -1000 : 240000, () => undefined);
  }
}
