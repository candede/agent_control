import {
  isCopilotServiceActive,
  type CopilotServicePlan,
  type CopilotServiceSummaryState,
} from "../types/copilotUsage.js";

export const copilotServicePlanDefinitions = new Map([
  ["a62f8878-de10-42f3-b68f-6149a25ceb97", {
    service: "M365_COPILOT_APPS", displayName: "Microsoft 365 Copilot in Productivity Apps",
  }],
  ["b95945de-b3bd-46db-8437-f2beb6ea2347", {
    service: "M365_COPILOT_TEAMS", displayName: "Microsoft 365 Copilot in Microsoft Teams",
  }],
  ["3f30311c-6b1e-48a4-ab79-725b469da960", {
    service: "M365_COPILOT_BUSINESS_CHAT", displayName: "Microsoft 365 Copilot with Graph-grounded chat",
  }],
]);

export type CopilotPlanObservation = Pick<CopilotServicePlan, "servicePlanId" | "assignedDateTime" | "capabilityStatus">;

export function resolveCopilotServicePlan(
  servicePlanId: string,
  enabledInAssignment: boolean,
  observations: readonly CopilotPlanObservation[],
): CopilotServicePlan {
  const definition = copilotServicePlanDefinitions.get(servicePlanId);
  if (!definition) throw new Error("Unsupported Microsoft 365 Copilot service-plan ID.");
  const matching = observations.filter(plan => plan.servicePlanId === servicePlanId);
  const statuses = new Set(matching.map(plan => plan.capabilityStatus));
  const capabilityStatus = statuses.size === 1 ? matching[0].capabilityStatus
    : statuses.has("Enabled") && [...statuses].every(status => status === "Enabled" || status === "Warning") ? "Enabled" : null;
  const dates = matching.flatMap(plan => plan.assignedDateTime ? [plan.assignedDateTime] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  // Historical capabilities cannot override an explicit current per-user disable.
  const state = !enabledInAssignment ? "disabled"
    : capabilityStatus === "Enabled" ? "enabled"
      : capabilityStatus === "Warning" ? "warning"
        : capabilityStatus === "Suspended" ? "suspended"
          : capabilityStatus === "LockedOut" ? "locked_out"
            : capabilityStatus === "Deleted" ? "disabled" : "unknown";
  return {
    servicePlanId,
    ...definition,
    state,
    assignedDateTime: dates.at(-1) ?? null,
    capabilityStatus,
  };
}

export function summarizeCopilotServices(plans: readonly CopilotServicePlan[]): CopilotServiceSummaryState {
  if (!plans.length) return "unknown";
  const active = plans.filter(plan => isCopilotServiceActive(plan.state));
  if (active.length) {
    if (active.length !== plans.length) return "partially_enabled";
    return active.some(plan => plan.state === "warning") ? "warning" : "enabled";
  }
  if (plans.some(plan => plan.state === "unknown")) return "unknown";
  if (plans.some(plan => plan.state === "locked_out")) return "locked_out";
  if (plans.some(plan => plan.state === "suspended")) return "suspended";
  return "disabled";
}
