import type { CopilotServicePlan, CopilotServiceSummaryState } from "../api/client";
import { CopilotPaidFeatureStatus } from "./CopilotLicenseStatus";

export function CopilotServiceDetails({ servicePlans, copilotServiceState, current }: {
  servicePlans: readonly CopilotServicePlan[];
  copilotServiceState: CopilotServiceSummaryState;
  current: boolean;
}) {
  return <section aria-label="Microsoft 365 Copilot paid features">
    <h3>Microsoft 365 Copilot paid features</h3>
    <p>A containing bundle alone does not establish paid Copilot entitlement; at least one paid feature must be active. Basic Chat access can depend on policy; access and usage are not measured here.</p>
    {!current ? <p>Last saved paid-feature evidence. Current paid-feature status is unverified until Users Sync.</p> : null}
    {servicePlans.length ? <>
      <ul className="copilot-service-plans" aria-label="Paid feature states">
        {servicePlans.map(plan => <li key={plan.servicePlanId}>
          <strong>{plan.displayName}</strong>
          <small>{plan.service}</small>
          <CopilotPaidFeatureStatus state={plan.state} current={current} />
        </li>)}
      </ul>
      <details className="copilot-users-provenance">
        <summary>Technical service-plan evidence</summary>
        <ul>{servicePlans.map(plan => <li key={plan.servicePlanId}>
          <strong>{plan.service}</strong>
          <p>Service-plan ID: {plan.servicePlanId}</p>
          <p>Raw capability status: <strong>{plan.capabilityStatus ?? "Not reported"}</strong></p>
          <p>Assigned at: {plan.assignedDateTime ?? "Not reported"}</p>
        </li>)}</ul>
        <p>Raw capability status is supporting evidence, not the effective paid-feature state. A paid feature can remain not enabled even when raw evidence says Enabled. Warning is a usable grace period.</p>
      </details>
    </> : copilotServiceState === "disabled"
      ? <p>{current ? "No paid Copilot services are assigned." : "Last saved: no paid Copilot services were assigned."}</p>
      : <p>Paid-feature evidence not reported. Run Users Sync to verify paid features.</p>}
  </section>;
}
