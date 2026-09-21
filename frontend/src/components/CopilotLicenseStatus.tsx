import { isCopilotServiceActive, type CopilotServiceSummaryState, type CopilotUsageUser } from "../api/client";
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

export function CopilotLicenseStatus({ user, current = true }: {
  user?: Pick<CopilotUsageUser, "copilotServiceState"> | null;
  current?: boolean;
}) {
  if (!user) return <span className="copilot-user-badge unknown">License not verified</span>;
  const active = isCopilotServiceActive(user.copilotServiceState);
  const inactive = user.copilotServiceState === "disabled" || user.copilotServiceState === "suspended" || user.copilotServiceState === "locked_out";
  const label = active ? "M365 Copilot licensed" : inactive ? "No active M365 Copilot license" : "License not verified";
  const tone = !current || !active && !inactive ? "unknown" : active ? "" : "attention";
  return <div className="copilot-license-status">
    <strong className={`copilot-user-badge ${tone}`}>{current ? label : `Last saved: ${label}`}</strong>
    <small>Paid features: <CopilotPaidFeatureStatus state={user.copilotServiceState} current={current} /></small>
  </div>;
}
