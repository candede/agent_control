import { useEffect, useState } from "react";
import type { CopilotServiceSummaryState } from "../api/client";
import type { UserSourcePlan } from "../../../backend/src/types/userSources";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { CopilotPaidFeatureStatus } from "./CopilotLicenseStatus";
import { usageDate } from "../usageInsights";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
export function CopilotServiceDetails({ path, selectionId, copilotServiceState, current, onRestartSelection, onSelectionInvalidated }: {
  path: string; selectionId: string; copilotServiceState: CopilotServiceSummaryState; current: boolean; onRestartSelection?: () => void;
  onSelectionInvalidated?: (error: Error) => void;
}) {
  const read = useReportPage<UserSourcePlan>(path, { selectionId }, 0, true, onRestartSelection);
  const owner = JSON.stringify([useReportPrincipalScope(), path, selectionId.toLowerCase()]);
  const hasPages = Boolean(read.data?.page.nextCursor || read.data?.page.previousCursor);
  const [pagination, setPagination] = useState({ owner, visible: false });
  if (pagination.owner !== owner || hasPages && !pagination.visible) setPagination({ owner, visible: hasPages });
  useEffect(() => {
    if (read.invalidated && read.error) onSelectionInvalidated?.(read.error);
  }, [read.invalidated, read.error, onSelectionInvalidated]);
  if (read.invalidated && onSelectionInvalidated) return null;
  return <section aria-label="Microsoft 365 Copilot paid features"><h3>Microsoft 365 Copilot paid features</h3>
    {!current ? <p className="copilot-users-notice">Refresh Users in Sync to verify current paid-feature status.</p> : null}<ReportReadStatus read={read} />
    {read.data?.value.length ? <ul className="copilot-service-plans" aria-label="Paid feature states">{read.data.value.map(plan => <li key={plan.servicePlanId}>
      <strong>{plan.displayName}</strong><CopilotPaidFeatureStatus state={plan.state} current={current} />
      {plan.assignedDateTime ? <small>Assigned {usageDate(plan.assignedDateTime)}</small> : null}
    </li>)}</ul> : read.data?.counts.filtered === 0 ? <p>{copilotServiceState === "disabled" ? current ? "No paid Copilot services are assigned." : "Last saved: no paid Copilot services were assigned." : "Paid-feature status is unavailable. Refresh Users in Sync."}</p>
      : read.data ? <p>No service-plan rows on this page. Continue using the page controls.</p> : null}
    {pagination.owner === owner && pagination.visible ? <ReportPageControls {...read} label="plans" /> : null}
  </section>;
}
