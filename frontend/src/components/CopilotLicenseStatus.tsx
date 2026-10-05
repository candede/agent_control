import { isCopilotServiceActive, type CopilotServiceSummaryState } from "../api/client";
import type { CopilotDirectoryUser } from "../../../backend/src/types/copilotUsage";
import type { ReportUser } from "../../../backend/src/types/officialReportData";
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

export function CopilotLicenseStatus({ user, current = true, entitlement }: {
  user?: Pick<CopilotDirectoryUser, "copilotServiceState"> | null;
  current?: boolean;
  entitlement?: ReportUser["entitlement"];
}) {
  const inactive = user?.copilotServiceState === "disabled" || user?.copilotServiceState === "suspended" || user?.copilotServiceState === "locked_out";
  if ((entitlement === "no_paid" || entitlement === "paid_inactive") && !current) {
    return <span className="copilot-user-badge unknown">Last saved: No active M365 Copilot license</span>;
  }
  if ((entitlement === "no_paid" || entitlement === "paid_inactive") && !inactive) {
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
