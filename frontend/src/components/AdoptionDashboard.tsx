import { useId } from "react";
import { ArrowDownRight, ArrowUpRight, Bot, ChartNoAxesCombined, Minus, Sparkles, Users } from "lucide-react";
import type { AdoptionSnapshot } from "../../../backend/src/types/adoptionDashboard";
import { adoptionChange, adoptionDirection, adoptionSnapshotLabel, orderedAdoptionSnapshots, type AdoptionMetric } from "../adoptionTrends";
import { useAdoptionHistory } from "../useAdoptionHistory";
import { isValidUsageCount, usageCount, usageDate, usageDateRange } from "../usageInsights";
import { ReportReadStatus } from "./ReportPageControls";
import { DashboardInsights, DashboardPanelHeading } from "./DashboardInsights";
import "./adoptionDashboard.css";

export function AdoptionDashboard({ revision, baselineId, onBaselineChange, company, onCompanyChange }: {
  revision: number; baselineId?: string; onBaselineChange: (id: string) => void;
  company?: string | null; onCompanyChange: (company: string | null | undefined) => void;
}) {
  const history = useAdoptionHistory(revision);
  const snapshots = history.snapshots;
  return <section className="adoption-dashboard" aria-labelledby="adoption-dashboard-title">
    <header className="dashboard-header">
      <div><p className="eyebrow"><Sparkles size={15} aria-hidden="true" /> Adoption insights</p>
        <h2 id="adoption-dashboard-title">Understand adoption. Empower your people.</h2>
        <p>See who is getting involved, where to focus, and who is leading the way.</p></div>
      <a className="secondary dashboard-link" href="/sync?reports=manage">View saved reports</a>
    </header>
    <ReportReadStatus read={history.read} />
    {!snapshots && !history.read.error && !history.read.leaseEnded ? <p role="status">
      Loading report history{history.total ? `: ${usageCount(history.loaded)} of ${usageCount(history.total)} snapshots` : "..."}
    </p> : null}
    {snapshots?.length === 0 ? <div className="dashboard-empty">
      <h3>No saved usage reports yet</h3><p>Import the three companion Microsoft 365 CSV reports in Sync.
        Each retained report adds an observation to this long-term view. Automatic inventory sync remains independent.</p>
      <a href="/sync">Open Sync</a>
    </div> : snapshots ? <DashboardResults snapshots={snapshots} baselineId={baselineId} onBaselineChange={onBaselineChange}
      revision={revision} company={company} onCompanyChange={onCompanyChange} /> : null}
  </section>;
}

function DashboardResults({ snapshots, baselineId, onBaselineChange, revision, company, onCompanyChange }: {
  snapshots: AdoptionSnapshot[]; baselineId?: string; onBaselineChange: (id: string) => void;
  revision: number; company?: string | null; onCompanyChange: (company: string | null | undefined) => void;
}) {
  const baselineInput = useId();
  const ordered = orderedAdoptionSnapshots(snapshots);
  const dated = ordered.filter(snapshot => usageDateRange(snapshot.reportingStart, snapshot.reportingEnd));
  const undated = ordered.filter(snapshot => !usageDateRange(snapshot.reportingStart, snapshot.reportingEnd));
  const latest = dated.at(-1), previous = dated.at(-2);
  const baselines = dated.length > 1 ? dated.slice(0, -1) : dated;
  const baseline = baselines.find(snapshot => snapshot.id === baselineId) ?? dated[0];
  const visible = baseline ? dated.slice(dated.indexOf(baseline)) : [];
  const missingBaseline = Boolean(baselineId && !baselines.some(snapshot => snapshot.id === baselineId));
  return <>
    <div className="dashboard-context">
      <div><strong>{usageCount(snapshots.length)} saved report snapshots</strong>
        <p>{dated[0] && latest ? `${usageDate(dated[0].reportingEnd)} to ${usageDate(latest.reportingEnd)} (UTC observation dates)` : "No dated observations"}</p></div>
      {dated.length > 1 ? <label htmlFor={baselineInput}>Compare latest with baseline
        <select id={baselineInput} value={baseline.id} onChange={event => onBaselineChange(event.target.value)}>
          {baselines.map(snapshot => <option key={snapshot.id} value={snapshot.id}>
            {adoptionSnapshotLabel(snapshot)}{dated.filter(point => point.reportingEnd === snapshot.reportingEnd).length > 1
              ? ` (imported ${usageDate(snapshot.acceptedAt)}, ${snapshot.id.slice(-8)})` : ""}
          </option>)}
        </select>
      </label> : null}
    </div>
    {missingBaseline ? <p className="dashboard-notice" role="status">The bookmarked baseline is not available as a dated retained report.
      Showing the earliest dated report instead.</p> : null}
    <div className="dashboard-overview-grid">
      <section className="dashboard-panel dashboard-panel-blue" aria-labelledby="dashboard-trends-title">
        <DashboardPanelHeading id="dashboard-trends-title" icon={ChartNoAxesCombined} title="Adoption over time"
          description="How agent usage is changing across saved reports." />
        {latest ? <>
          <div className="dashboard-trend-tiles">
            {(["activeUsers", "activeAgents"] as const).map(metric => {
              const label = metric === "activeUsers" ? "Active users" : "Active agents";
              return <div key={metric} className={`dashboard-trend-tile dashboard-trend-${metric}`}>
                <AdoptionMetricCard label={label} metric={metric} latest={latest} baseline={baseline} previous={previous} />
                <AdoptionChart snapshots={visible} metric={metric} label={label} />
              </div>;
            })}
          </div>
          <div className="dashboard-direction">
            <h4>Recent direction</h4>
            <p><strong>Users:</strong> {adoptionDirection(previous, latest, "activeUsers")}.
              {" "}<strong>Agents:</strong> {adoptionDirection(previous, latest, "activeAgents")}.</p>
            <small>Report-to-report movement, not a forecast.</small>
          </div>
        </> : <p className="dashboard-notice">Saved counts are available below, but dates are missing.
          Import order is not usage chronology, so no direction or latest-activity claim is shown.</p>}
      </section>
      <DashboardInsights key={latest?.id ?? undated.at(-1)!.id} snapshot={latest ?? undated.at(-1)!}
        baseline={baseline} revision={revision} company={company} onCompanyChange={onCompanyChange} />
    </div>
    <SnapshotTable snapshots={[...visible].reverse()} heading="Report snapshots and comparisons" />
    {undated.length ? <SnapshotTable snapshots={undated} heading="Reports without activity dates" /> : null}
    <details className="dashboard-definitions">
      <summary>What these measures mean</summary>
      <ul>
        <li><strong>Active users:</strong> distinct exact reported usernames with positive responses in Users or Users &amp; agents.
          A person using several agents is counted once per report. No usernames are joined across reports.</li>
        <li><strong>Active agents:</strong> distinct reported agent IDs with positive responses in Agents or Users &amp; agents.
          This is the report's agent/app identity, not a count of inventory records.</li>
        <li><strong>Scope:</strong> Microsoft 365 Copilot Agents report coverage, including licensed and unlicensed usage,
          not every agent interaction across every channel. Licensed and unlicensed source counts are never added together.</li>
        <li><strong>History:</strong> complete retained reports only. Deleted, superseded, or unavailable reports do not contribute.
          Missing reports are gaps, not zero use. Counts across overlapping snapshots must not be summed.</li>
        <li><strong>Creation is separate:</strong> an agent's creation or publication date is not evidence that anyone used it.
          Historical license and inventory denominators are not inferred from today's inventory.</li>
        <li><strong>Departments:</strong> active, unambiguously matched people divided by saved directory members in each
          company / department. This is not a workforce census or historical membership. Unmatched report identities are excluded.</li>
        <li><strong>Copilot champions:</strong> up to three people per company / department, ranked by reported responses,
          then agents used. These are usage-based suggestions, not assigned roles or measures of productivity.</li>
      </ul>
    </details>
  </>;
}

function AdoptionMetricCard({ label, metric, latest, baseline, previous }: {
  label: string; metric: "activeUsers" | "activeAgents"; latest: AdoptionSnapshot; baseline?: AdoptionSnapshot; previous?: AdoptionSnapshot;
}) {
  const change = adoptionChange(baseline?.id === latest.id ? undefined : baseline, latest, metric);
  const prior = adoptionChange(previous, latest, metric);
  const Icon = metric === "activeUsers" ? Users : Bot;
  const Direction = change.direction === "up" ? ArrowUpRight : change.direction === "down" ? ArrowDownRight : Minus;
  return <section className="dashboard-metric" aria-label={label}>
    <div className="dashboard-metric-label"><span>{label}</span><Icon size={20} aria-hidden="true" /></div>
    <strong className="dashboard-metric-value">{usageCount(latest[metric])}</strong>
    <p className={`dashboard-change is-${change.direction}`}><Direction size={19} aria-hidden="true" />
      <strong>{change.label}</strong><span>vs baseline</span></p>
    <p className="dashboard-prior"><span className={`dashboard-change is-${prior.direction}`}>{prior.label}</span> vs previous report</p>
    <small>Latest report: {adoptionSnapshotLabel(latest)}</small>
  </section>;
}

function AdoptionChart({ snapshots, metric, label }: { snapshots: AdoptionSnapshot[]; metric: AdoptionMetric; label: string }) {
  const title = useId(), caption = useId();
  const maximum = Math.max(1, ...snapshots.map(snapshot => isValidUsageCount(snapshot[metric]) ? snapshot[metric] : 0));
  const first = Date.parse(snapshots[0].reportingEnd!), last = Date.parse(snapshots.at(-1)!.reportingEnd!);
  const x = (snapshot: AdoptionSnapshot) => first === last ? 190 : 44 + (Date.parse(snapshot.reportingEnd!) - first) / (last - first) * 292;
  const y = (snapshot: AdoptionSnapshot) => 154 - (isValidUsageCount(snapshot[metric]) ? snapshot[metric] : 0) / maximum * 118;
  return <section className="dashboard-chart" aria-labelledby={title}>
    <h3 id={title}>{label} over saved reports</h3>
    <svg viewBox="0 0 360 210" role="img" aria-labelledby={title} aria-describedby={caption}>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1="44" x2="336" y1={154 - fraction * 118} y2={154 - fraction * 118} className="dashboard-grid" />
        <text x="36" y={158 - fraction * 118} textAnchor="end">{(maximum * fraction).toLocaleString(undefined, { maximumFractionDigits: 1, notation: "compact" })}</text>
      </g>)}
      {snapshots.map((snapshot, index) => {
        const previous = snapshots[index - 1];
        const connected = previous && adoptionChange(previous, snapshot, metric).direction !== "unknown";
        return <g key={snapshot.id}>
          {connected ? <line className="dashboard-trend-line" x1={x(previous)} y1={y(previous)} x2={x(snapshot)} y2={y(snapshot)} /> : null}
          {isValidUsageCount(snapshot[metric]) ? <circle className="dashboard-trend-point" cx={x(snapshot)} cy={y(snapshot)}
            r={index === 0 || index === snapshots.length - 1 ? 5 : 3.5}>
            <title>{adoptionSnapshotLabel(snapshot)}: {usageCount(snapshot[metric])} {label.toLowerCase()}</title>
          </circle> : null}
        </g>;
      })}
      <text x="44" y="178">{usageDate(snapshots[0].reportingEnd)}</text>
      {first !== last ? <text x="336" y="178" textAnchor="end">{usageDate(snapshots.at(-1)!.reportingEnd)}</text> : null}
      <text x="190" y="203" textAnchor="middle">Report observations (UTC)</text>
    </svg>
    <p id={caption}>One point per saved report, from the selected baseline. {snapshots.length === 1 ? "One observation is not a trend. " : ""}
      No daily values or missing periods are estimated. Exact counts appear below.</p>
  </section>;
}

function SnapshotTable({ snapshots, heading }: { snapshots: AdoptionSnapshot[]; heading: string }) {
  const title = useId();
  if (!snapshots.length) return null;
  return <section className="dashboard-snapshots" aria-labelledby={title}>
    <h3 id={title}>{heading}</h3>
    <div className="table-shell" role="region" aria-label={`${heading} table`} tabIndex={0}>
      <table><thead><tr><th scope="col">Report dates</th><th scope="col">Active users</th><th scope="col">Active agents</th>
        <th scope="col">Agent responses</th><th scope="col">Source context</th><th scope="col">Report</th></tr></thead>
      <tbody>{snapshots.map(snapshot => <tr key={snapshot.id}>
        <th scope="row">{adoptionSnapshotLabel(snapshot)}<small>{snapshot.periodProvenance === "activity_range" ? "Observed activity"
          : snapshot.periodProvenance === "operator_asserted" ? "Admin-supplied reporting window" : "Reporting window"}</small></th>
        <td>{usageCount(snapshot.activeUsers)}</td><td>{usageCount(snapshot.activeAgents)}</td><td>{usageCount(snapshot.responses)}</td>
        <td><small>Active users: Users {usageCount(snapshot.userReportActiveUsers)}; Users &amp; agents {usageCount(snapshot.relationshipActiveUsers)}.</small>
          <small>Responses: Agents {usageCount(snapshot.responses)}; Users {usageCount(snapshot.userReportResponses)};
            {" "}Users &amp; agents {usageCount(snapshot.relationshipResponses)}.</small></td>
        <td><a href={`/sync?reports=snapshot&snapshot=${encodeURIComponent(snapshot.id)}`}>Inspect report</a>
          <small>Imported {usageDate(snapshot.acceptedAt)}</small></td>
      </tr>)}</tbody></table>
    </div>
  </section>;
}
