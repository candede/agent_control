import type { CopilotServicePlan, CopilotServiceSummaryState } from "../api/client";
import { CopilotPaidFeatureStatus } from "./CopilotLicenseStatus";
import { usageDate } from "../usageInsights";

export function CopilotServiceDetails({ servicePlans, copilotServiceState, current }: {
  servicePlans: readonly CopilotServicePlan[];
  copilotServiceState: CopilotServiceSummaryState;
  current: boolean;
}) {
  return <section aria-label="Microsoft 365 Copilot paid features">
    <h3>Microsoft 365 Copilot paid features</h3>
    {!current ? <p className="copilot-users-notice">Refresh Users in Sync to verify current paid-feature status.</p> : null}
    {servicePlans.length ? <>
      <ul className="copilot-service-plans" aria-label="Paid feature states">
        {servicePlans.map(plan => <li key={plan.servicePlanId}>
          <strong>{plan.displayName}</strong>
          <CopilotPaidFeatureStatus state={plan.state} current={current} />
          {plan.assignedDateTime ? <small>Assigned {usageDate(plan.assignedDateTime)}</small> : null}
        </li>)}
      </ul>
    </> : copilotServiceState === "disabled"
      ? <p>{current ? "No paid Copilot services are assigned." : "Last saved: no paid Copilot services were assigned."}</p>
      : <p>Paid-feature status is unavailable. Refresh Users in Sync.</p>}
  </section>;
}
