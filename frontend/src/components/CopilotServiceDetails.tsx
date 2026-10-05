import type { CopilotServiceSummaryState } from "../api/client";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { useReportPage } from "../useReportPage";
import { CopilotPaidFeatureStatus } from "./CopilotLicenseStatus";
import { usageDate } from "../usageInsights";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
export function CopilotServiceDetails({ path, selectionId, copilotServiceState, current, onRestartSelection }: {
  path: string; selectionId: string; copilotServiceState: CopilotServiceSummaryState; current: boolean; onRestartSelection?: () => void;
}) {
  const read = useReportPage<UserSourcePlan>(path, { selectionId }, 0, true, onRestartSelection);
  return <section aria-label="Microsoft 365 Copilot paid features"><h3>Microsoft 365 Copilot paid features</h3>
    {!current ? <p>Refresh Users in Sync to verify current paid-feature status.</p> : null}<ReportReadStatus read={read} />
    {read.data?.value.length ? <ul className="copilot-service-plans" aria-label="Paid feature states">{read.data.value.map(plan => <li key={plan.servicePlanId}>
      <strong>{plan.displayName}</strong><CopilotPaidFeatureStatus state={plan.state} current={current} /><small>{plan.service}</small>
      {plan.assignedDateTime ? <small>Assigned {usageDate(plan.assignedDateTime)}</small> : null}<small>Provider state: {plan.capabilityStatus ?? "Unknown"}</small>
    </li>)}</ul> : read.data?.counts.filtered === 0 ? <p>{copilotServiceState === "disabled" ? current ? "No paid Copilot services are assigned." : "Last saved: no paid Copilot services were assigned." : "Paid-feature status is unavailable. Refresh Users in Sync."}</p>
      : read.data ? <p>No service-plan rows on this page. Continue using the page controls.</p> : null}
    <ReportPageControls {...read} label="plans" />
  </section>;
}
