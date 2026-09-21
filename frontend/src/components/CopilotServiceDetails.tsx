import type { CopilotServicePlan } from "../api/client";
import { CopilotPaidFeatureStatus } from "./CopilotLicenseStatus";

export function CopilotServiceDetails({ servicePlans, current }: {
  servicePlans: readonly CopilotServicePlan[];
  current: boolean;
}) {
  return <section aria-label="Microsoft 365 Copilot paid features">
    <h3>Microsoft 365 Copilot paid features</h3>
    <p>A paid license can remain assigned when paid features are not enabled. Basic Copilot Chat access is not assessed here.</p>
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
    </> : <p>Paid-feature evidence not reported. Run Users Sync to verify paid features.</p>}
  </section>;
}
