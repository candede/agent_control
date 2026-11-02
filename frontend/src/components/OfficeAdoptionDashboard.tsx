import { useId, useState } from "react";
import { ArrowUpRight, Building2, ChartNoAxesCombined, CircleAlert, LoaderCircle, Users } from "lucide-react";
import { officeApps, type OfficeGroup, type OfficeHistoryPoint, type OfficeMetrics, type OfficeQuery } from "../../../backend/src/types/officeAppAdoption";
import { orderedOfficeHistory, officeChange, officeMonthHistory, officeFourWeekBaseline, officeParticipationChange } from "../officeAdoptionTrends";
import { useOfficeAdoption, useOfficeHistory, useOfficePage, useOfficeSummary, type OfficeReadOwner } from "../useOfficeAdoption";
import { usersRouteSearch, workbenchUrl, type DashboardRouteState } from "../workbenchRouting";
import { usageCount, usageDate } from "../usageInsights";
import { DashboardPanelHeading, InsightCard } from "./DashboardInsights";
import { DashboardObservationChart } from "./DashboardObservationChart";
import { OfficeObservationContext, OfficeObservationNotices } from "./OfficeObservationContext";
import { OfficeFacet } from "./OfficeFacet";
import { OfficeAppBreakdown } from "./OfficeAppBreakdown";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";

export function OfficeAdoptionDashboard({ route, revision, change }: {
  route: DashboardRouteState; revision: number; change: (next: DashboardRouteState) => void;
}) {
  const query: OfficeQuery = { ...(route.officeSnapshot ? { officeSnapshot: route.officeSnapshot } : {}),
    ...(route.officeBaseline ? { officeBaseline: route.officeBaseline } : {}), ...(route.company !== undefined ? { company: route.company } : {}) };
  const owner = useOfficeAdoption(query, revision, officeNotice => change({ ...route, officeSnapshot: undefined, officeBaseline: undefined, officeNotice }));
  const summary = useOfficeSummary(owner), history = useOfficeHistory(owner);
  const ordered = orderedOfficeHistory(history.data?.value ?? []);
  const data = summary.data, metrics = data?.organization;
  const href = (filters: Partial<OfficeQuery> = {}) => workbenchUrl("users", usersRouteSearch({
    view: "licenses", section: "adoption", adoption: "office", search: "", page: 0,
    officeSnapshot: owner.context?.observation?.id ?? route.officeSnapshot, officeBaseline: route.officeBaseline,
    reportSetId: route.reportSetId, baselineId: route.baselineId, ...filters,
  }));
  return <section className="adoption-dashboard" aria-label="Copilot in Office apps">
    <OfficeObservationContext owner={owner} history={ordered} route={route} change={next => change({ ...route, ...next })} />
    <OfficeObservationNotices owner={owner} route={route} change={next => change({ ...route, ...next })} />
    <section className="dashboard-panel dashboard-panel-purple" aria-label="Office participation">
      <DashboardPanelHeading id={useId()} icon={Users} title="Office participation"
        description="Copilot use in the seven Office apps during the reported 28-day window." />
      <ReportReadStatus read={summary} />
      <div className="dashboard-insight-cards office-overview-cards">
        <InsightCard icon={Users} tone="blue" label="Enabled paid Copilot users" value={metrics?.savedLicensedPeople} unit="people"
          description="The enabled paid-feature cohort at capture, not organizational headcount." />
        <InsightCard icon={Users} tone="teal" label="Active Office users" value={metrics?.reportedActiveUsers} unit="people"
          description={metrics?.savedLicensedPeople ? `${(metrics.reportedActiveUsers/metrics.savedLicensedPeople*100).toFixed(1)}% of enabled users have recent Copilot activity reported in at least one Office app.`
            : "Participation is unavailable until an enabled-user cohort is measured."} />
        <InsightCard icon={CircleAlert} tone="rose" label="No recent Office activity reported" value={metrics?.noRecentEvidencePeople} unit="people"
          description="No qualifying app date in this window. Not proof of inactivity or unused licenses." />
      </div>
      {metrics && owner.context?.observation ? <details className="office-coverage"><summary>Activity report coverage</summary>
        <p>{usageCount(metrics.unknownEvidencePeople)} of the {usageCount(metrics.noRecentEvidencePeople)} people without recent activity have unknown activity evidence.</p>
        <p>{usageCount(owner.context.observation.coverage.unknownReasons.no_app_dates)} have no Office-app dates reported.
          Blank dates can reflect reporting limitations; people may still use Copilot Chat.</p>
        {Object.entries(owner.context.observation.coverage.unknownReasons).filter(([reason,count])=>reason!=="no_app_dates" && count>0)
          .map(([reason,count])=><p key={reason}>{reason.replaceAll("_"," ")}: {usageCount(count)}</p>)}
        <p>Reason counts can overlap. Reported participation is a confirmed lower bound when evidence is incomplete.</p>
      </details> : null}
    </section>
    <div className="dashboard-overview-grid">
      <section className="dashboard-panel dashboard-panel-gold" aria-label="Copilot adoption by app">
        <DashboardPanelHeading id={useId()} icon={ChartNoAxesCombined} title="Copilot adoption by app"
          description="Reported users and share of the enabled paid Copilot cohort." />
        <OfficeAppBreakdown metrics={metrics} href={app => href({ app })} />
        <p className="dashboard-panel-note">Organization-wide. Users can appear in several apps; do not add the rows to count people.</p>
      </section>
      <OfficeDepartments owner={owner} route={route} change={change} href={href} />
    </div>
    <ReportReadStatus read={history} quietLoading />
    <OfficeAppTrends metrics={metrics} points={ordered} end={owner.context?.observation?.reportRefreshDate} baselineId={route.officeBaseline} />
    <a className="dashboard-text-link" href={href()}>Explore Office groups <ArrowUpRight size={15} aria-hidden="true" /></a>
    {ordered.length ? <details className="dashboard-definitions"><summary>Weekly Office history</summary>
      <OfficeObservationTable points={[...ordered].reverse()} /></details> : null}
    <details className="dashboard-definitions"><summary>What these Office measures mean</summary><ul>
      <li>Recent is the provider refresh date minus 27 days through refresh inclusive. Older dates remain evidence, not recent use.</li>
      <li>Only Word, Excel, PowerPoint, Outlook, OneNote, Loop and Teams participate. Chat, overall activity and agent reports never count.</li>
      <li>Paid features and organization membership are frozen at observation capture, not reconstructed daily license or workforce history.</li>
      <li>Unknown evidence is a subset of no recent evidence, not a separate inactive population. Reported participation is a lower bound.</li>
      <li>Weekly history stores app and group totals for twelve months, not individual-person activity records.</li>
    </ul></details>
  </section>;
}

function OfficeAppTrends({ metrics, points, end, baselineId }: {
  metrics?: OfficeMetrics | null; points: OfficeHistoryPoint[]; end?: string; baselineId?: string;
}) {
  const [format,setFormat] = useState<"percent"|"count">("percent");
  const title = useId();
  const month = end ? officeMonthHistory(points,end) : [];
  if (month.length<2) return <section className="dashboard-notice office-history-building" aria-label="App adoption over time">
    <p><strong>App adoption history is building.</strong> Graphs for all seven apps will appear automatically once two weekly snapshots are available.
      {" "}Current adoption is shown above.</p>
  </section>;
  const baseline = points.find(point=>point.observation.id===baselineId)
    ?? (end ? officeFourWeekBaseline(points,end) : undefined);
  const comparison = baseline ?? month[0];
  const apps = metrics ? [...officeApps].sort((left,right)=>metrics.perApp[right.id]-metrics.perApp[left.id]) : officeApps;
  return <section className="dashboard-panel dashboard-panel-blue office-app-trends" aria-label="App adoption over time">
    <div className="office-trends-header">
    <DashboardPanelHeading id={title} icon={ChartNoAxesCombined} title="App adoption over time"
      description="All seven apps together. Weekly report snapshots across the last 30 days." />
    <div className="office-trend-controls">
      <label>Measure<select aria-label="App trend measure" value={format}
        onChange={event=>setFormat(event.target.value==="count" ? "count" : "percent")}>
        <option value="percent">Share of enabled users</option><option value="count">Active users</option>
      </select></label>
    </div></div>
    <p className="dashboard-panel-note">Changes compared with {usageDate(comparison.observation.reportRefreshDate)}.
      {!baseline ? " More weekly history is needed for a four-week comparison." : ""}</p>
    {metrics && comparison.metrics.savedLicensedPeople!==metrics.savedLicensedPeople ? <p className="dashboard-panel-note">
      Enabled cohort changed from {usageCount(comparison.metrics.savedLicensedPeople)} to {usageCount(metrics.savedLicensedPeople)} people.</p> : null}
    <div className="office-trend-grid">{apps.map(({id:app,label})=>{
      const users = metrics?.perApp[app], licensed = metrics?.savedLicensedPeople;
      const percent = users!==undefined && licensed ? users/licensed*100 : undefined;
      const delta = users!==undefined && licensed!==undefined
        ? format==="count" ? officeChange(comparison.metrics.perApp[app],users)
          : officeParticipationChange(comparison.metrics.perApp[app],comparison.metrics.savedLicensedPeople,users,licensed) : undefined;
      return <article key={app} className="office-app-trend-card" aria-label={`${label} adoption trend`}>
        <DashboardObservationChart label={`${label} ${format==="percent" ? "participation" : "active users"}`}
          source="weekly snapshots" format={format} points={month.map(point=>({
            id:point.observation.id,date:point.observation.reportRefreshDate,label:usageDate(point.observation.reportRefreshDate),
            value:format==="count" ? point.metrics.perApp[app] : point.metrics.savedLicensedPeople
              ? point.metrics.perApp[app]/point.metrics.savedLicensedPeople*100 : null,connected:true,
          }))} caption={format==="percent" ? "Share of enabled users at each capture; gaps mean no measured cohort."
            : "Reported Copilot users at each capture."} />
        <div className="office-trend-current"><strong>{format==="percent" ? percent===undefined ? "Unavailable" : `${percent.toFixed(1)}%`
          : users===undefined ? "Unknown" : usageCount(users)}</strong>
          <span>{format==="percent" ? `${usageCount(users)} reported users` : percent===undefined ? "Share unavailable" : `${percent.toFixed(1)}% of enabled users`}</span></div>
        {delta ? <p className={`dashboard-change is-${delta.direction}`}><strong>{delta.label}</strong></p> : null}
      </article>;
    })}</div>
    <p className="dashboard-panel-note">Each point is a rolling 28-day report, sampled weekly. These are not daily activity counts; overlapping snapshots must never be summed.</p>
  </section>;
}

function OfficeDepartments({ owner, route, change, href }: {
  owner: OfficeReadOwner; route: DashboardRouteState; change: (next: DashboardRouteState) => void;
  href: (filters?: Partial<OfficeQuery>) => string;
}) {
  const read = useOfficePage<OfficeGroup>(owner, "departments", { limit: 10 });
  const [retainedLayout, setRetainedLayout] = useState<OfficeGroup[]>();
  if (read.data && retainedLayout !== read.data.value) setRetainedLayout(read.data.value);
  const skeleton = read.loading && !read.data;
  const departments = read.data?.value ?? (skeleton ? retainedLayout ?? Array.from({ length: 10 }, () => undefined) : []);
  return <section className="dashboard-panel dashboard-panel-teal" aria-label="Adoption by department">
    <div className="dashboard-department-heading"><DashboardPanelHeading id={useId()} icon={Building2} title="Adoption by department"
      description="Largest numbers of people without recent reported activity first." />
      <OfficeFacet owner={owner} kind="company" value={route.company} dropdown onChange={company => change({ ...route, company })} /></div>
    <div className="dashboard-department-columns"><span>Department</span><span>Reported active / saved licensed</span></div>
    <ReportReadStatus read={read} quietLoading />
    <div className={`dashboard-department-results${skeleton ? " dashboard-department-placeholder" : ""}`} aria-busy={read.loading}>
      {skeleton ? <span className="dashboard-department-loading" aria-hidden="true"><LoaderCircle size={16} /> Updating departments...</span> : null}
      <ul className="dashboard-departments" aria-hidden={skeleton || undefined}>
      {departments.map((group, index) => <li key={group?.id ?? index} className={`dashboard-department dashboard-bar-${index % 8}`}>
        {skeleton ? <span className="dashboard-department-name">{group?.department ?? "Loading department"}<small>{group?.company ?? "Loading company"}</small></span>
          : <a href={href({ company: group!.company, department: group!.department })}>{group!.department ?? "Department not provided"}
            <small>{group!.company ?? "Company not provided"}</small></a>}
        <span className="dashboard-department-bar" aria-hidden="true"><span style={{ width: `${group?.participation == null ? 0 : Math.round(group.participation * 100)}%` }} /></span>
        <span className="dashboard-department-value"><strong>{group?.participation == null ? "Unknown" : `${Math.round(group.participation * 100)}%`}</strong>
          <small>{usageCount(group?.metrics.reportedActiveUsers)} / {usageCount(group?.metrics.savedLicensedPeople)}</small>
          <small>{usageCount(group?.metrics.noRecentEvidencePeople)} without recent activity reported</small></span>
      </li>)}
    </ul></div>
    {read.data?.value.length === 0 ? <p className="dashboard-panel-note">{read.data.context.observation
      ? "No saved licensed departments match this observation and company." : "No measured Office observation yet."}</p> : null}
    <p className="dashboard-panel-note">Saved licensed denominator at capture, not headcount. Unknown evidence lowers confirmed participation.</p>
    <ReportPageControls {...read} compact label="departments" />
  </section>;
}

function OfficeObservationTable({ points }: { points: OfficeHistoryPoint[] }) {
  return <section className="dashboard-snapshots" aria-label="Office observations and comparisons"><h3>Office observations and comparisons</h3>
    <div className="table-shell" role="region" aria-label="Office observation table" tabIndex={0}><table><thead><tr>
      <th scope="col">Provider refresh (UTC)</th><th scope="col">Active Office users</th><th scope="col">Participation</th>
      <th scope="col">Enabled paid Copilot users</th><th scope="col">Activity evidence</th></tr></thead><tbody>{points.map(point => <tr key={point.observation.id}>
        <th scope="row">{usageDate(point.observation.reportRefreshDate)}<small>D28 / v2</small></th>
        <td>{usageCount(point.metrics.reportedActiveUsers)}</td><td>{point.metrics.savedLicensedPeople
          ? `${(point.metrics.reportedActiveUsers/point.metrics.savedLicensedPeople*100).toFixed(1)}%` : "Unavailable"}</td>
        <td>{usageCount(point.metrics.savedLicensedPeople)}</td><td>{point.observation.coverage.state}
          <small>{usageCount(point.metrics.unknownEvidencePeople)} unknown (subset of no recent evidence)</small></td>
      </tr>)}</tbody></table></div></section>;
}
