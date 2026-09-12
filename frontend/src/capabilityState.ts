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
  return Boolean(view?.definition.probe.adapterRegistered && capabilityModeEnabled(view) && view.decision.authorized && view.decision.status === "available"
    && (view.decision.verification === "on_demand" ? isOnDemandDecision(view) : evidenceIsFresh(view, now)));
}

function isOnDemandDecision(view: CapabilityView) {
  const { definition, decision } = view;
  const packageWrite = definition.id === "graph.package.block.manage" || definition.id === "graph.package.access.manage";
  return (packageWrite || definition.id === "powerPlatform.quarantine.manage")
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
  if (!capabilityModeEnabled(view) || !decision.authorized || decision.status !== "available") return undefined;
  if (decision.verification === "on_demand") return isOnDemandDecision(view) ? "on_demand" : undefined;
  if (definition.mode === "local") return decision.verification === "local" ? "local" : undefined;
  const checkedAt = Date.parse(decision.checkedAt ?? "");
  if (!Number.isFinite(checkedAt) || checkedAt > now || !evidenceIsFresh(view, now)) return undefined;
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

export function capabilityExplanation(view: CapabilityView, now = Date.now()) {
  const { definition, decision } = view;
  const permissions = definition.permissions.join(" and ");
  if (!capabilityModeEnabled(view)) return "This optional application mode is disabled. Previous checks do not establish current availability.";
  if (decision.evidence?.category === "interaction_required") {
    return "Microsoft Entra requires interactive authorization, which may include consent, MFA, or Conditional Access. Continue sign-in or consent when you are ready.";
  }
  if (decision.evidence?.category === "authorization_expired") {
    return "Microsoft authorization expired. Sign in again to reauthorize this delegated capability.";
  }
  switch (decision.status) {
    case "missing_permission": return `Requires ${definition.mode} ${permissions} for ${definition.audience}.`;
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
        return `${stage} timed out${budget}. Use Check status to retry. This does not establish missing permissions, roles, or licensing; authorized saved data remains readable.`;
      }
      if (decision.evidence?.category === "provider_network_error") return "The provider could not be reached. Check connectivity and use Check status to retry; additional consent is not indicated.";
      if (decision.evidence?.category === "provider_throttled") return "The provider throttled the check. Wait until the current evidence cooldown expires before retrying; changing permissions will not resolve throttling.";
      return "The latest capability check failed. Permission, role, and license causes are not established; authorized saved data remains readable.";
    case "unknown": return evidenceIsStale(view, now) ? staleExplanation(view)
      : definition.probe.kind === "live_qualification" && definition.mode === "application"
        ? "Provider operation access is not currently verified. An Admin must explicitly approve a bounded application-scope operation; automatic refresh does not run it."
      : decision.checkedAt ? "The check did not establish availability. Review the evidence and remediation; authorized saved data remains readable."
        : "Not checked yet. Automatic safe checks run while this signed-in UI is active.";
    case "available":
      if (!decision.authorized) return "Current authorization is not established. Previous successful checks do not grant access.";
      if (currentVerification(view, now) === "on_demand") return "Ready to try. Microsoft validates delegated permissions and provider roles on the actual operation. Review and confirm the exact targets before submitting a change.";
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
  const verification = currentVerification(view, now);
  if (verification !== "token" && verification !== "on_demand") return undefined;
  if (view.definition.probe.kind === "on_demand" && view.definition.id.startsWith("graph.package.")) return {
    text: "Package changes use delegated CopilotPackages.ReadWrite.All, requested during normal sign-in. Open Agents to review and confirm the exact package targets. Microsoft validates access on each operation.",
    href: "/agents", label: "Open Agents",
  };
  if (view.definition.id.startsWith("powerPlatform.quarantine.")) return {
    text: "Open Power Platform to check status or confirm a change for exact inventoried Copilot Studio agents. Microsoft validates permission on each operation.",
    href: "/power-platform", label: "Open Power Platform",
  };
  if (view.definition.id.startsWith("purview.audit.search.")) return {
    text: "Open Audit and explicitly submit a bounded Purview search to verify operation access. Ready to try is not a failure; permission checks do not start searches.",
    href: "/audit", label: "Open Audit",
  };
  if (view.definition.id.startsWith("defender.hunting.")) return {
    text: "Open Security and explicitly run a curated, bounded investigation to verify operation access. Permission checks do not run hunting queries.",
    href: "/security", label: "Open Security",
  };
  return undefined;
}

function providerEvidenceIsFresh(view: CapabilityView, now: number) {
  return view.decision.fresh && Boolean(view.decision.expiresAt) && Date.parse(view.decision.expiresAt!) > now;
}

function staleExplanation(view: CapabilityView) {
  return view.definition.probe.kind === "live_qualification" && view.definition.mode === "application"
      ? "Provider operation evidence is stale. An Admin must explicitly approve a new bounded application-scope operation; automatic refresh does not run it. Authorized saved data remains readable."
    : "Evidence is stale. An automatic safe check is pending; authorized saved data remains readable.";
}