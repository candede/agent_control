import type { CopilotServiceSummaryState, CopilotUsageUser } from "../api/client";
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
  return <div className="copilot-license-status">
    <strong>{current ? "Paid license assigned" : "Last saved: Paid license assigned"}</strong>
    <small>Paid features: <CopilotPaidFeatureStatus state={user.copilotServiceState} current={current} /></small>
  </div>;
}
