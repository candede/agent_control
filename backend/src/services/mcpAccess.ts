import { requireAuthority } from "../auth/authorityContext.js";
import { config } from "../config.js";
import { declaredRoutePolicies } from "../routes/policy.js";
import { hasAppRole } from "../types/capability.js";
import { capabilityDefinitions, getCapabilityDefinition, hasAnyRole } from "./capabilityRegistry.js";
import { discoveryOperations } from "../types/agentDiscovery.js";

export function mcpAccessProfile() {
  const source = requireAuthority();
  const { roles } = source.principal;
  const operations = [...declaredRoutePolicies].flatMap(([key, policy]) => {
    if (policy.access !== "authenticated" || policy.browserOnly
      || policy.roles?.length && !hasAnyRole(roles, policy.roles)) return [];
    const capability = policy.capabilityId && getCapabilityDefinition(policy.capabilityId);
    if (capability && !hasAnyRole(roles, capability.internalRoles)) return [];
    const separator = key.indexOf(" ");
    const method = key.slice(0, separator), route = `/api${key.slice(separator + 1)}`;
    return [{ method, route, ...(key === "POST /capabilities/:id/probe" ? {
      inputChoices: { capabilityId: capabilityDefinitions.filter(definition => hasAnyRole(roles, definition.internalRoles)).map(definition => definition.id) },
    } : key === "POST /discovery/read" || key === "POST /discovery/preview"
      ? { inputChoices: { operation: [...discoveryOperations] } } : {}) }];
  }).sort((left, right) => left.route.localeCompare(right.route) || left.method.localeCompare(right.method));
  source.assertCurrent();
  return {
    audience: hasAppRole(roles, "AgentControl.Admin") ? "admin" as const : roles.length ? "adoption" as const : "end_user" as const,
    operations,
    staffPreviewAuthorized: hasAppRole(roles, "AgentControl.Viewer"),
    privacy: { ...config.employeePrivacy },
  };
}
