import type { CapabilityStatus, CapabilityView } from "./api/client";

export const statusLabels: Record<CapabilityStatus, string> = {
  available: "Available", missing_permission: "Missing app permission", missing_internal_role: "Missing internal role",
  missing_role: "Missing Microsoft role", missing_license: "Missing license", not_configured: "Not configured",
  unsupported: "Unsupported", preview_disabled: "Preview disabled", provider_error: "Provider error", unknown: "Unknown",
};

export function evidenceIsFresh(view: CapabilityView, now = Date.now()) {
  return view.definition.mode === "local" || (view.decision.fresh && Boolean(view.decision.expiresAt) && Date.parse(view.decision.expiresAt!) > now);
}

export function providerActionAllowed(view: CapabilityView | undefined, write = false, now = Date.now()) {
  return Boolean(view?.definition.probe.adapterRegistered && view.decision.authorized && view.decision.status === "available"
    && evidenceIsFresh(view, now) && (!write || view.decision.previewQualification !== "unqualified"));
}

export function capabilityExplanation(view: CapabilityView, now = Date.now()) {
  const { definition, decision } = view;
  const permissions = definition.permissions.join(" and ");
  switch (decision.status) {
    case "missing_permission": return `Requires ${definition.mode} ${permissions} for ${definition.audience}.`;
    case "missing_internal_role": return `Requires ${definition.internalRoles.join(" or ")}.`;
    case "missing_role": return definition.providerRoles.length ? `Requires ${definition.providerRoles.join(" or ")}.` : "Microsoft role requirements are not fully visible; verify the documented provider contract.";
    case "missing_license": return `Requires ${definition.licenses.join(" or ") || "the documented service license"}.`;
    case "not_configured": return `Requires ${definition.configuration.join("; ") || "provider configuration"}.`;
    case "unsupported": return `Unsupported endpoint, resource, or cloud. Required cloud: ${definition.cloud}.`;
    case "preview_disabled": return definition.id === "graph.package.access.manage"
      ? "Package access writes are disabled because the documented beta endpoint exposes no If-Match or equivalent lost-update protection."
      : "Preview write qualification is missing. A successful read probe does not qualify writes.";
    case "provider_error": return "The provider probe failed. Permission, role, and license causes are not established; authorized saved data remains readable.";
    case "unknown": return decision.checkedAt ? "Evidence is stale. Run an explicit probe; authorized saved data remains readable." : "No current probe evidence. Run an explicit probe.";
    case "available": return !evidenceIsFresh(view, now) ? "Evidence is stale. Run an explicit probe; authorized saved data remains readable."
      : decision.previewQualification === "unqualified" ? "Read evidence is available; writes remain unqualified." : "Requirements satisfied for this capability.";
  }
}