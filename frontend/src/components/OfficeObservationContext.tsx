import type { OfficeHistoryPoint } from "../../../backend/src/types/officeAppAdoption";
import type { OfficeRouteState } from "../workbenchRouting";
import type { OfficeReadOwner } from "../useOfficeAdoption";
import { usageDate } from "../usageInsights";
import { ReportReadStatus } from "./ReportPageControls";

export function OfficeObservationContext({ owner, history, route, change, summaryCard = false }: {
  owner: OfficeReadOwner; history?: OfficeHistoryPoint[]; route: OfficeRouteState;
  change: (next: OfficeRouteState) => void;
  summaryCard?: boolean;
}) {
  const context = owner.context, observation = context?.observation;
  const choices = [...(history ?? [])].reverse();
  const baselines = choices.filter(point => point.observation.reportRefreshDate < (observation?.reportRefreshDate ?? ""));
  return <div className={`${summaryCard ? "agent-report-context office-observation-card" : "dashboard-context"} office-observation-context`}>
      <div><strong>{observation ? `${summaryCard ? "Refreshed" : "Office report refreshed"} ${usageDate(observation.reportRefreshDate)}`
        : summaryCard ? "No Office report yet" : "Office evidence not yet available"}</strong>
        {!summaryCard ? <p>{observation ? <>Recent window: {usageDate(observation.windowStart)}–{usageDate(observation.reportRefreshDate)} inclusive (UTC).
          {" "}Cohort captured {usageDate(observation.capturedAt)} · {observation.coverage.state} activity evidence.</> :
          "Saved Office evidence synchronizes automatically after ordinary sign-in. Agent CSV reports are not required."}</p> : null}</div>
      <label>{summaryCard ? "Observation" : "Office observation"}<select aria-label="Office observation" value={route.officeSnapshot ?? ""}
        disabled={!context || owner.loading} onChange={event => change({ ...route, officeSnapshot: event.target.value || undefined,
          officeBaseline: undefined, officeNotice: undefined })}>
        <option value="">Latest</option>
        {choices.map(point => <option key={point.observation.id} value={point.observation.id}>{usageDate(point.observation.reportRefreshDate)} (weekly summary)</option>)}
        {route.officeSnapshot && !choices.some(point => point.observation.id === route.officeSnapshot)
          ? <option value={route.officeSnapshot}>{observation?.id === route.officeSnapshot
            ? `${usageDate(observation.reportRefreshDate)} (selected observation)` : "Selected observation"}</option> : null}
      </select></label>
      {baselines.length || route.officeBaseline ? <label>{summaryCard ? "Compare with" : "Compare with Office baseline"}<select aria-label="Office baseline" value={route.officeBaseline ?? ""}
        disabled={!context || owner.loading} onChange={event => change({ ...route, officeBaseline: event.target.value || undefined, officeNotice: undefined })}>
        <option value="">About four weeks earlier</option>
        {baselines.map(point =>
          <option key={point.observation.id} value={point.observation.id}>{usageDate(point.observation.reportRefreshDate)}</option>)}
        {route.officeBaseline && !baselines.some(point => point.observation.id === route.officeBaseline)
          ? <option value={route.officeBaseline}>{context?.baseline?.id === route.officeBaseline
            ? `${usageDate(context.baseline.reportRefreshDate)} (selected baseline)` : "Selected baseline"}</option> : null}
      </select></label> : null}
    </div>;
}

export function OfficeObservationNotices({ owner, route, change }: {
  owner: OfficeReadOwner; route: OfficeRouteState; change: (next: OfficeRouteState) => void;
}) {
  const context = owner.context, observation = context?.observation;
  return <>
    <ReportReadStatus read={owner} />
    {route.officeNotice ? <p className="dashboard-notice" role="status">{route.officeNotice}</p> : null}
    {context && context.status.state !== "available" ? <p className="dashboard-notice" role={context.status.state === "failed" ? "alert" : "status"}>
      Current Office source status: {context.status.state.replaceAll("_", " ")}.
      {" "}{context.status.message ?? "Automatic source synchronization and local recovery will update this view."}
      {observation ? " The measured saved observation above is unchanged; current source status is not historical usage." : ""}
    </p> : null}
    {observation?.kind==="weekly" ? <p className="dashboard-panel-note office-history-note">
      <span>Weekly history contains app and group totals, not individual-person records.</span>
      <button type="button" className="secondary" onClick={()=>change({ ...route,officeSnapshot:undefined,
        officeBaseline:undefined,officeNotice:undefined })}>Explore current people</button>
    </p> : null}
  </>;
}
