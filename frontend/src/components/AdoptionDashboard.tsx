import { useId } from "react";
import { ArrowDownRight, ArrowUpRight, Bot, Minus, Users } from "lucide-react";
import type { AdoptionSnapshot } from "../../../backend/src/types/adoptionDashboard";
import { adoptionChange, adoptionDirection, adoptionSnapshotLabel, orderedAdoptionSnapshots, type AdoptionMetric } from "../adoptionTrends";
import { useAdoptionHistory } from "../useAdoptionHistory";
import { isValidUsageCount, usageCount, usageDate, usageDateRange } from "../usageInsights";
import { ReportReadStatus } from "./ReportPageControls";
import "./adoptionDashboard.css";

export function AdoptionDashboard({ revision, baselineId, onBaselineChange }: {
  revision: number; baselineId?: string; onBaselineChange: (id: string) => void;
}) {
  const history = useAdoptionHistory(revision);
  const snapshots = history.snapshots;
  return <section className="adoption-dashboard" aria-labelledby="adoption-dashboard-title">
    <header className="dashboard-header">
      <div><p className="eyebrow">Dashboard</p><h2 id="adoption-dashboard-title">Adoption trends</h2>
        <p>Where agent adoption started, where it is now, and its recent direction.</p></div>
      <a className="secondary dashboard-link" href="/sync?reports=manage">Saved reports</a>
    </header>
    <ReportReadStatus read={history.read} />
    {!snapshots && !history.read.error && !history.read.leaseEnded ? <p role="status">
      Loading report history{history.total ? `: ${usageCount(history.loaded)} of ${usageCount(history.total)} snapshots` : "..."}
    </p> : null}
    {snapshots?.length === 0 ? <div className="dashboard-empty">
      <h3>No saved usage reports yet</h3><p>Import the three companion Microsoft 365 CSV reports in Sync.
        Each retained report adds an observation to this long-term view. Automatic inventory sync remains independent.</p>
      <a href="/sync">Open Sync</a>
    </div> : snapshots ? <DashboardResults snapshots={snapshots} baselineId={baselineId} onBaselineChange={onBaselineChange} /> : null}
  </section>;
}

function DashboardResults({ snapshots, baselineId, onBaselineChange }: {
  snapshots: AdoptionSnapshot[]; baselineId?: string; onBaselineChange: (id: string) => void;
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
  const unverified = dated.some(snapshot => snapshot.periodProvenance === "activity_range");
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
    <p className="dashboard-notice">{unverified
      ? "Snapshot comparison: observed activity dates are not verified reporting windows. Changes describe saved reports, not a daily or monthly growth rate."
      : "Counts describe each report's stated window. Overlapping periods are compared, never added."}
      {" "}Report source refresh times are not established by import dates.</p>
    {latest ? <>
      <div className="dashboard-headlines">
        <AdoptionMetricCard label="Active users" metric="activeUsers" latest={latest} baseline={baseline} previous={previous} />
        <AdoptionMetricCard label="Active agents" metric="activeAgents" latest={latest} baseline={baseline} previous={previous} />
      </div>
      <section className="dashboard-direction" aria-labelledby="dashboard-direction-title">
        <h3 id="dashboard-direction-title">Recent direction</h3>
        <p><strong>Users:</strong> {adoptionDirection(previous, latest, "activeUsers")}.
          {" "}<strong>Agents:</strong> {adoptionDirection(previous, latest, "activeAgents")}.</p>
        <small>Observed report-to-report movement, not a forecast. A single report establishes a baseline, not a trend.</small>
      </section>
      <div className="dashboard-charts">
        <AdoptionChart snapshots={visible} metric="activeUsers" label="Active users" />
        <AdoptionChart snapshots={visible} metric="activeAgents" label="Active agents" />
      </div>
      <section className="dashboard-volume" aria-label="Supporting response volume">
        <div><span>Agent responses in latest report</span><strong>{usageCount(latest.responses)}</strong></div>
        <p>{adoptionChange(baseline?.id === latest.id ? undefined : baseline, latest, "responses").label} versus baseline.
          {" "}Agents export only; response volume supports, but does not replace, adoption counts.</p>
      </section>
    </> : <p className="dashboard-notice">Saved counts are available below, but dates are missing.
      Import order is not usage chronology, so no direction or latest-activity claim is shown.</p>}
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
  const x = (snapshot: AdoptionSnapshot) => first === last ? 340 : 64 + (Date.parse(snapshot.reportingEnd!) - first) / (last - first) * 548;
  const y = (snapshot: AdoptionSnapshot) => 184 - (isValidUsageCount(snapshot[metric]) ? snapshot[metric] : 0) / maximum * 146;
  return <section className="dashboard-chart" aria-labelledby={title}>
    <h3 id={title}>{label} over saved reports</h3>
    <svg viewBox="0 0 660 236" role="img" aria-labelledby={title} aria-describedby={caption}>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1="64" x2="612" y1={184 - fraction * 146} y2={184 - fraction * 146} className="dashboard-grid" />
        <text x="54" y={188 - fraction * 146} textAnchor="end">{(maximum * fraction).toLocaleString(undefined, { maximumFractionDigits: 1, notation: "compact" })}</text>
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
      <text x="64" y="208">{usageDate(snapshots[0].reportingEnd)}</text>
      {first !== last ? <text x="612" y="208" textAnchor="end">{usageDate(snapshots.at(-1)!.reportingEnd)}</text> : null}
      <text x="338" y="230" textAnchor="middle">Report end / latest observed activity (UTC)</text>
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
