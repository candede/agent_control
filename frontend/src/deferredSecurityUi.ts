import type { CapabilityId } from "./api/client";

// Presentation only: provider capabilities and authorization remain unchanged.
const deferredCapabilities = new Set<CapabilityId>([
  "graph.agentIdentity.read",
  "purview.audit.search.delegated",
  "purview.audit.search.application",
  "defender.hunting.delegated",
  "defender.hunting.application",
]);

export function isDeferredSecurityCapability(id: CapabilityId) {
  return deferredCapabilities.has(id);
}
