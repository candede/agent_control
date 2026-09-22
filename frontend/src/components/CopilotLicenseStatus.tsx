import { isCopilotServiceActive, type CopilotServiceSummaryState, type CopilotUsageUser, type OfficialUsageUserSummary } from "../api/client";
import { copilotServicePresentation } from "../copilotServicePresentation";

export function CopilotPaidFeatureStatus({ state, current = true }: {
  state: CopilotServiceSummaryState;
  current?: boolean;
}) {
  const status = copilotServicePresentation(state);
  return <span className={`copilot-user-badge ${current ? status.tone : "unknown"}`}>
    {current ? status.label : `Last saved: ${status.label}`}
  </span>;
}

export function CopilotLicenseStatus({ user, current = true, licenseAssignmentStatus }: {
  user?: Pick<CopilotUsageUser, "copilotServiceState"> | null;
  current?: boolean;
  licenseAssignmentStatus?: OfficialUsageUserSummary["licenseAssignmentStatus"];
}) {
  const inactive = user?.copilotServiceState === "disabled" || user?.copilotServiceState === "suspended" || user?.copilotServiceState === "locked_out";
  if (licenseAssignmentStatus === "no_active_paid_license" && (!current || !inactive)) {
    return <span className="copilot-user-badge attention">No active M365 Copilot license</span>;
  }
  if (!user) return <span className="copilot-user-badge unknown">License not verified</span>;
  const active = isCopilotServiceActive(user.copilotServiceState);
  const label = active ? "M365 Copilot licensed" : inactive ? "No active M365 Copilot license" : "License not verified";
  const tone = !current || !active && !inactive ? "unknown" : active ? "" : "attention";
  return <div className="copilot-license-status">
    <strong className={`copilot-user-badge ${tone}`}>{current ? label : `Last saved: ${label}`}</strong>
    <small>Paid features: <CopilotPaidFeatureStatus state={user.copilotServiceState} current={current} /></small>
  </div>;
}
