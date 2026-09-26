import { supportsAutomaticCapabilityCheck } from "../../backend/src/types/capability";
import type { CapabilityStatus, CapabilityView } from "./api/client";

export const statusLabels: Record<CapabilityStatus, string> = {
  available: "Available", missing_permission: "Missing app permission", missing_internal_role: "Missing internal role",
  missing_role: "Missing Microsoft role", missing_license: "Missing license", not_configured: "Not configured",
  unsupported: "Unsupported", preview_disabled: "Preview disabled", provider_error: "Provider error", unknown: "Unknown",
};

export function evidenceIsFresh(view: CapabilityView, now = Date.now()) {
  if (view.definition.mode === "local") return true;
  return providerEvidenceIsFresh(view, now);
}

export function providerActionAllowed(view: CapabilityView | undefined, _write?: boolean, now = Date.now()) {
  if (!view || !hasCurrentAuthorization(view)) return false;
  if (view.decision.verification === "on_demand") return isOnDemandDecision(view);
  if (evidenceIsFresh(view, now)) return true;
  const { definition, decision } = view;
  const checkedAt = Date.parse(decision.checkedAt ?? "");
  const expiresAt = Date.parse(decision.expiresAt ?? "");
  // Expired diagnostics are not a revoked grant. Submitted operations enforce current authorization.
  return definition.mode === "delegated" && (decision.verification === "provider" || decision.verification === "token")
    && Number.isFinite(checkedAt) && checkedAt <= now && expiresAt > checkedAt && expiresAt <= now;
}

function hasCurrentAuthorization(view: CapabilityView) {
  return view.definition.probe.adapterRegistered && view.decision.capabilityId === view.definition.id
    && capabilityModeEnabled(view) && view.decision.authorized && view.decision.status === "available";
}

function isOnDemandDecision(view: CapabilityView) {
  const { definition, decision } = view;
  return definition.probe.kind === "on_demand"
    && definition.mode === "delegated" && definition.probe.adapterRegistered
    && decision.capabilityId === definition.id
    && decision.status === "available" && decision.authorized === true && decision.fresh === true
    && decision.verification === "on_demand" && decision.previewQualification === "not_required"
    && decision.checkedAt === undefined && decision.expiresAt === undefined && decision.lastSuccessAt === undefined;
}

export function capabilityModeEnabled(view: CapabilityView) {
  return view.definition.mode !== "application" || (view.enabled ?? view.configuration?.enabled ?? true);
}

export function evidenceIsStale(view: CapabilityView, now = Date.now()) {
  return view.definition.mode !== "local" && Boolean(view.decision.checkedAt) && !providerEvidenceIsFresh(view, now);
}

export function currentVerification(view: CapabilityView, now = Date.now()) {
  const { definition, decision } = view;
  if (!hasCurrentAuthorization(view)) return undefined;
  if (decision.verification === "on_demand") return isOnDemandDecision(view) ? "on_demand" : undefined;
  if (definition.mode === "local") return decision.verification === "local" ? "local" : undefined;
  if (!evidenceIsFresh(view, now)) return undefined;
  return decision.verification === "provider" || decision.verification === "token" ? decision.verification : undefined;
}

export function verificationLabel(view: CapabilityView, now = Date.now()) {
  switch (currentVerification(view, now)) {
    case "provider": return "Provider-verified";
    case "token": return "Token acquired; provider authorization not verified";
    case "local": return "Authorized by local policy; no provider check";
    case "on_demand": return "Ready to try; Microsoft validates permission on the actual operation";
  }
  if (!capabilityModeEnabled(view)) return "Disabled; no current verification";
  if (view.definition.mode === "local") return "Local policy authorization not established";
  if (evidenceIsStale(view, now)) return "Stale evidence; no current verification";
  if (!view.decision.checkedAt) return "Not checked; no current verification";
  if (view.decision.status !== "available") return "Check did not establish current availability";
  if (!view.decision.authorized) return "Not authorized; no current verification";
  return "Current verification unavailable";
}

export function operationAccessLabel(view: CapabilityView, now = Date.now()) {
  const { definition } = view;
  if (definition.probe.kind === "on_demand") return "Microsoft validates permission when the operation is requested";
  if (definition.probe.kind === "live_qualification") {
    return currentVerification(view, now) === "provider"
      ? "Bounded provider operation succeeded"
      : definition.mode === "application"
        ? "Requires an explicitly approved bounded application-scope operation"
        : "Provider access is checked by an explicit bounded operation; no separate pre-approval required";
  }
  return "No separate operation check";
}

function capabilityCheckGuidance(view: CapabilityView) {
  if (view.definition.mode === "application") {
    return "Use an explicitly approved bounded application-scope operation to check access. Check status does not run application checks.";
  }
  if (supportsAutomaticCapabilityCheck(view.definition.id)) return "Use Check status to retry.";
  if (view.definition.probe.kind === "on_demand") return "Request the read from the dashboard; Check status does not run this capability.";
  if (view.definition.mode === "local") return "Local policy does not run provider checks.";
  return "This adapter is not implemented; permission checks cannot make it available.";
}

export function capabilityExplanation(view: CapabilityView, now = Date.now()) {
  const { definition, decision } = view;
  const permissions = definition.permissions.join(" and ");
  if (!capabilityModeEnabled(view)) return "This optional application mode is disabled. Previous checks do not establish current availability.";
  if (definition.mode === "application" && ["interaction_required", "authorization_expired"].includes(decision.evidence?.category ?? "")) {
    return "An administrator must verify the app registration's credentials and application API permissions. User sign-in does not repair app-only authorization.";
  }
  if (decision.evidence?.category === "interaction_required") {
    return "Microsoft Entra requires interaction. Sign in again for MFA or Conditional Access; an administrator must configure any missing API permissions and admin consent outside this app.";
  }
  if (decision.evidence?.category === "authorization_expired") {
    return "Microsoft authorization expired. Sign in again to reauthorize this delegated capability.";
  }
  switch (decision.status) {
    case "missing_permission": return `Admin prerequisite: add ${definition.mode} ${permissions} for ${definition.audience} in the app registration and grant admin consent.`;
    case "missing_internal_role": return `Requires ${definition.internalRoles.join(" or ")}.`;
    case "missing_role": return definition.providerRoles.length ? `Requires ${definition.providerRoles.join(" or ")}.` : "Microsoft role requirements are not fully visible; verify the documented provider contract.";
    case "missing_license": return `Requires ${definition.licenses.join(" or ") || "the documented service license"}.`;
    case "not_configured": return `Requires ${definition.configuration.join("; ") || "provider configuration"}.`;
    case "unsupported": return `Unsupported endpoint, resource, or cloud. Required cloud: ${definition.cloud}.`;
    case "preview_disabled": return definition.probe.kind === "live_qualification"
          ? `${operationAccessLabel(view, now)}. A token check alone does not establish provider access.`
          : "This capability is not currently available. Review the returned reason and remediation.";
    case "provider_error":
      if (decision.evidence?.category === "provider_timeout") {
        const stage = decision.evidence.phase === "token_acquisition" ? "Microsoft token acquisition" : "The bounded provider check";
        const budget = decision.evidence.timeoutMs ? ` after ${decision.evidence.timeoutMs / 1000} seconds` : "";
        return `${stage} timed out${budget}. ${capabilityCheckGuidance(view)} This does not establish missing permissions, roles, or licensing; authorized saved data remains readable.`;
      }
      if (decision.evidence?.category === "provider_network_error") return `The provider could not be reached. Check connectivity. ${capabilityCheckGuidance(view)} Additional consent is not indicated.`;
      if (decision.evidence?.category === "provider_throttled") return "The provider throttled the check. Wait until the current evidence cooldown expires before retrying; changing permissions will not resolve throttling.";
      return "The latest capability check failed. Permission, role, and license causes are not established; authorized saved data remains readable.";
    case "unknown": return evidenceIsStale(view, now) ? staleExplanation(view)
      : definition.probe.kind === "live_qualification" && definition.mode === "application"
        ? "Provider operation access is not currently verified. An Admin must explicitly approve a bounded application-scope operation; automatic refresh does not run it."
      : decision.checkedAt ? "The check did not establish availability. Review the evidence and remediation; authorized saved data remains readable."
        : supportsAutomaticCapabilityCheck(definition.id)
          ? "Not checked yet. Use Check status to check access."
          : `Not checked yet. ${capabilityCheckGuidance(view)}`;
    case "available":
      if (!decision.authorized) return "Current authorization is not established. Previous successful checks do not grant access.";
      if (currentVerification(view, now) === "on_demand") {
        const confirmation = definition.dataClass === "package_control" ? " Review and confirm the exact targets before submitting a change." : "";
        return `Ready to try. Microsoft validates delegated permissions and provider roles on the actual operation.${confirmation}`;
      }
      if (definition.mode !== "local" && !decision.checkedAt) return "Not checked yet. Current token or provider verification is not established.";
      if (definition.mode !== "local" && !providerEvidenceIsFresh(view, now)) return staleExplanation(view);
      if (currentVerification(view, now) === "token") return "Token acquired. Ready to try; provider role, license, and operation access have not been verified.";
      if (currentVerification(view, now) === "local") return "Authorized by current local application policy.";
      if (currentVerification(view, now) === "provider") return "The bounded provider request succeeded. Documented role and license metadata are not independently verified.";
      return decision.verification
        ? "Authorization is available, but current verification evidence is missing or inconsistent."
        : "Authorization is available, but the verification level was not reported.";
  }
}

export function capabilityStatusLabel(view: CapabilityView, now = Date.now()) {
  if (!capabilityModeEnabled(view)) return "Disabled";
  if (view.decision.evidence?.category === "interaction_required") return "Interaction required";
  if (view.decision.evidence?.category === "authorization_expired") return "Authorization expired";
  if (view.decision.status === "provider_error" && view.decision.evidence?.category === "provider_timeout") return "Check timed out";
  if (view.decision.status === "available") {
    if (!view.decision.authorized) return "Not authorized";
    if (currentVerification(view, now) === "on_demand") return "Ready to try";
    if (evidenceIsStale(view, now)) return "Evidence stale";
    if (view.definition.mode !== "local" && !view.decision.checkedAt) return "Not checked";
    if (!currentVerification(view, now)) return "Verification unavailable";
    if (currentVerification(view, now) === "token") return "Ready to try";
  }
  return statusLabels[view.decision.status];
}

export function capabilityNextStep(view: CapabilityView, now = Date.now()): { text: string; href?: string; label?: string } | undefined {
  if (view.decision.status === "missing_permission") return {
    text: "Ask your administrator to add the required API permissions and grant admin consent in the existing Entra app registration. Then sign in again and check status.",
    href: "https://entra.microsoft.com/", label: "Admin setup",
  };
  if (["interaction_required", "authorization_expired"].includes(view.decision.evidence?.category ?? "")) return view.definition.mode === "application" ? {
    text: "Ask an administrator to verify the app registration's credentials and previously granted application API permissions. Then retry the explicit application-scope operation.",
    href: "https://entra.microsoft.com/", label: "Admin setup",
  } : {
    text: "Normal sign-in can complete MFA or refresh your session. It does not configure feature permissions; those remain administrator prerequisites.",
    href: "/api/auth/login?returnTo=%2Fpermissions", label: "Sign in again",
  };
  const verification = currentVerification(view, now);
  if (verification !== "token" && verification !== "on_demand") return undefined;
  if (view.definition.probe.kind === "on_demand" && view.definition.id.startsWith("graph.package.")) return {
    text: "Package changes require administrator-pregranted delegated CopilotPackages.ReadWrite.All. Open Agents to review and confirm the exact package targets. Microsoft validates access on each operation.",
    href: "/agents", label: "Open Agents",
  };
  if (view.definition.id.startsWith("powerPlatform.quarantine.")) return {
    text: "Open Agents to check status or confirm a change for exact inventoried Copilot Studio agents. Microsoft validates permission on each operation.",
    href: "/agents", label: "Open Agents",
  };
  if (view.definition.id.startsWith("purview.audit.search.")) return {
    text: "Open Audit and explicitly submit a bounded Purview search to verify operation access. Ready to try is not a failure; permission checks do not start searches.",
    href: "/audit", label: "Open Audit",
  };
  if (view.definition.id.startsWith("defender.hunting.")) return {
    text: "Open Agents, select an agent, and use its Activity tab to run a bounded Defender investigation. The agent identity is filled automatically. Permission checks do not run hunting queries.",
    href: "/agents", label: "Open Agents",
  };
  return undefined;
}

function providerEvidenceIsFresh(view: CapabilityView, now: number) {
  const checkedAt = Date.parse(view.decision.checkedAt ?? "");
  const expiresAt = Date.parse(view.decision.expiresAt ?? "");
  return view.decision.fresh && Number.isFinite(checkedAt) && checkedAt <= now && expiresAt > now;
}

function staleExplanation(view: CapabilityView) {
  return view.definition.probe.kind === "live_qualification" && view.definition.mode === "application"
      ? "Provider operation evidence is stale. An Admin must explicitly approve a new bounded application-scope operation; automatic refresh does not run it. Authorized saved data remains readable."
    : `Evidence is stale; authorized saved data remains readable. ${capabilityCheckGuidance(view)}`;
}