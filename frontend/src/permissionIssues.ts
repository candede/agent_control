import type { CapabilityId, CapabilityView } from "./api/client";
import { supportsAutomaticCapabilityCheck, type CapabilityDecision } from "../../backend/src/types/capability";
import { capabilityModeEnabled } from "./capabilityState";

const featureNames: Partial<Record<CapabilityId, string>> = {
  "graph.package.read.delegated": "Agent inventory",
  "graph.package.read.application": "App-only agent inventory",
  "graph.package.access.manage": "Package settings",
  "graph.package.block.manage": "Package blocking",
  "graph.directory.read": "Agent people",
  "graph.agentIdentity.read": "Agent log identity",
  "graph.licenses.read": "Copilot license sync",
  "reports.copilotUsage.read": "Copilot activity reports",
  "powerPlatform.inventory.read": "Power Platform inventory",
  "powerPlatform.quarantine.read": "Studio quarantine status",
  "powerPlatform.quarantine.manage": "Studio quarantine",
  "purview.audit.search.delegated": "Purview audit",
  "purview.audit.search.application": "App-only Purview audit",
  "defender.hunting.delegated": "Defender / Agent 365 logs",
  "defender.hunting.application": "App-only Defender logs",
};

export type PermissionIssue = {
  view: CapabilityView;
  decision: CapabilityDecision;
  name: string;
  message: string;
  action?: { label: string; href: string };
};

export function permissionFeatureName(view: CapabilityView) {
  return featureNames[view.definition.id] ?? view.definition.displayName;
}

export function isTransientPermissionCheck(view: CapabilityView) {
  const evidence = view.decision.evidence;
  return view.definition.mode === "delegated" && supportsAutomaticCapabilityCheck(view.definition.id)
    && view.decision.status === "provider_error" && (
      ["provider_timeout", "provider_network_error"].includes(evidence?.category ?? "")
      || [408, 500, 502, 503, 504].includes(evidence?.httpStatus ?? 0));
}

export function permissionIssues(views: CapabilityView[], now = Date.now(), awaitingInitialCheck = false) {
  return views.map(view => permissionIssue(view, now, awaitingInitialCheck)).filter(issue => issue !== undefined);
}

export function permissionIssue(view: CapabilityView, now = Date.now(), awaitingInitialCheck = false): PermissionIssue | undefined {
  const { definition } = view;
  if (!definition.probe.adapterRegistered || !capabilityModeEnabled(view) || definition.mode === "local"
    || view.decision.capabilityId !== definition.id || view.decision.status === "missing_internal_role"
    || view.decision.status === "preview_disabled") return undefined;
  const failure = view.operationFailure;
  const operationCheckedAt = Date.parse(failure?.checkedAt ?? "");
  const operationExpiresAt = Date.parse(failure?.expiresAt ?? "");
  const decision: CapabilityDecision = failure && Number.isFinite(operationCheckedAt) && operationCheckedAt <= now
    && Number.isFinite(operationExpiresAt) && operationExpiresAt > now
    ? { ...failure, capabilityId: definition.id, authorized: false, fresh: true, previewQualification: "not_required" }
    : view.decision;
  if (decision === view.decision && awaitingInitialCheck && isTransientPermissionCheck(view)) return undefined;
  const checkedAt = Date.parse(decision.checkedAt ?? "");
  const expiresAt = Date.parse(decision.expiresAt ?? "");
  if (!decision.fresh
    || !Number.isFinite(checkedAt) || checkedAt > now || !Number.isFinite(expiresAt) || expiresAt <= now
    || decision.status === "available" || decision.status === "missing_internal_role") return undefined;
  const issue = { view, decision, name: permissionFeatureName(view) };
  if (["interaction_required", "authorization_expired"].includes(decision.evidence?.category ?? "")) return {
    ...issue, message: "Sign in again to restore Microsoft access.",
    action: { label: "Sign in again", href: "/api/auth/login?returnTo=%2Fpermissions" },
  };
  switch (decision.status) {
    case "missing_permission": return {
      ...issue, message: "Microsoft denied the required API permission.",
      action: { label: "Admin setup", href: "https://entra.microsoft.com/" },
    };
    case "missing_role": return {
      ...issue, message: "Microsoft denied access for this account's role.",
      action: { label: "Review roles", href: "https://entra.microsoft.com/" },
    };
    case "missing_license": return {
      ...issue, message: "Microsoft reported a missing license.",
      action: { label: "Review licenses", href: "https://admin.microsoft.com/" },
    };
    case "not_configured": return { ...issue, message: "The requested feature needs administrator setup." };
    case "unsupported": return { ...issue, message: "Microsoft does not support this request for the current service or cloud." };
    case "provider_error": return {
      ...issue, message: [401, 403].includes(decision.evidence?.httpStatus ?? 0) ? "Microsoft denied this operation. Review the details."
        : decision.evidence?.category === "provider_throttled" ? "Microsoft is limiting requests. Try again after the cooldown."
        : decision.evidence?.category === "provider_timeout" ? "Microsoft did not respond after retrying."
          : decision.evidence?.category === "provider_network_error" ? "Microsoft could not be reached after retrying."
            : "The Microsoft service check failed.",
    };
    default: return undefined;
  }
}
