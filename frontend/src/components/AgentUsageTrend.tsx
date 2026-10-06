import { useId } from "react";
import type { AgentUsageHistoryPoint, CandidateAgentUsageHistory } from "../../../backend/src/types/officialReportApi";
import { snapshotChange, usagePeriodLabel } from "../agentUsageTrends";
import { usageCount, usageDate } from "../usageInsights";

export function AgentUsageTrend({ data, sharedSetId, onPage, loading, disabled }: {
  data: CandidateAgentUsageHistory; sharedSetId?: string | null;
  onPage: (cursor: string) => void; loading: boolean; disabled?: boolean;
}) {
  const caption = useId();
  const dated = data.value.filter(point => point.reportingEnd).reverse();
  const points = [...dated, ...data.value.filter(point => !point.reportingEnd)];
  const latest = dated.at(-1), change = latest ? snapshotChange(latest, dated.at(-2)) : undefined;
  const maximum = Math.max(1, ...dated.map(point => point.responses ?? 0));
  const firstDate = Date.parse(dated[0]?.reportingEnd ?? ""), lastDate = Date.parse(latest?.reportingEnd ?? "");
  const x = (point: AgentUsageHistoryPoint) => firstDate === lastDate ? 340
    : 64 + (Date.parse(point.reportingEnd!) - firstDate) / (lastDate - firstDate) * 548;
  const y = (point: AgentUsageHistoryPoint) => 184 - (point.responses ?? 0) / maximum * 146;
  return <section className="agent-usage-trend" aria-label="Reported usage trend" aria-busy={loading}>
    <header><div><h4>Reported usage trend</h4><p>Response counts across saved report snapshots</p></div>
      {change ? <strong className={change.comparable && change.difference ? change.difference > 0 ? "trend-up" : "trend-down" : undefined}>
        {change.comparable && change.difference ? change.difference > 0 ? "Increasing: " : "Decreasing: "
          : latest?.responses === null ? "Latest report: " : ""}{change.label}
        {change.comparable ? <small>versus the previous report shown</small> : null}
      </strong> : null}
    </header>
    {dated.some(point => point.responses !== null) ? <svg viewBox="0 0 660 236" role="img"
      aria-label="Reported responses by report end date" aria-describedby={caption}>
      <text x="12" y="18" className="trend-axis-label">Responses</text>
      {[0, 0.5, 1].map(fraction => <g key={fraction}>
        <line x1="64" x2="612" y1={184 - fraction * 146} y2={184 - fraction * 146} className="trend-grid" />
        <text x="55" y={188 - fraction * 146} textAnchor="end" className="trend-axis-label">
          {(maximum * fraction).toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}</text>
      </g>)}
      {dated.map((point, index) => {
        const previous = dated[index - 1], change = snapshotChange(point, previous);
        return <g key={point.setId}>
          {previous && change.comparable ? <line x1={x(previous)} y1={y(previous)} x2={x(point)} y2={y(point)} className="trend-line" /> : null}
          <g className="trend-point">
            <title>{usagePeriodLabel(point)}: {usageCount(point.responses)} responses. {change.label}</title>
            {point.responses === null
              ? <path d={`M${x(point) - 5},179 l10,10 m-10,0 l10,-10`} className="trend-missing" />
              : <circle className="trend-dot" cx={x(point)} cy={y(point)} r="5" />}
          </g>
        </g>;
      })}
      <text x="64" y="208" className="trend-axis-label">{usageDate(dated[0].reportingEnd)}</text>
      {dated.length > 1 ? <text x="612" y="208" textAnchor="end" className="trend-axis-label">{usageDate(latest?.reportingEnd)}</text> : null}
      <text x="338" y="230" textAnchor="middle" className="trend-axis-label">Report end / latest observed date</text>
    </svg> : <p>{data.latestReported ? "No reported response counts in this page's dated reports." : "No usage reported in saved reports."}</p>}
    <p id={caption} className="agent-trend-caption">Each point represents an uploaded report. Periods may overlap; values are compared, not added.
      Missing usage is a gap, not zero. Observed activity dates are not verified reporting windows.</p>
    {points.length ? <div className="agent-trend-snapshots">
      <h5>Report snapshots and changes ({points.length})</h5>
      <div className="table-shell"><table role="table" className="agent-insight-table agent-trend-table">
      <caption className="sr-only">Report snapshots and changes in responses</caption>
      <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Report dates</th><th role="columnheader" scope="col">Responses</th><th role="columnheader" scope="col">Change</th></tr></thead>
      <tbody role="rowgroup">{points.map((point, index) => <tr role="row" key={point.setId}>
        <th role="rowheader" scope="row">{usagePeriodLabel(point)}
          <small>{point.periodProvenance === "activity_range" ? "Observed activity" : "Reporting window"}
            {point.setId === sharedSetId ? " - shared report" : ""}</small></th>
        <td role="cell"><span className="agent-trend-cell-label" aria-hidden="true">Responses</span>{point.responses === null ? "Not reported" : usageCount(point.responses)}</td>
        <td role="cell"><span className="agent-trend-cell-label" aria-hidden="true">Change</span>{snapshotChange(point, points[index - 1]).label}</td>
      </tr>)}</tbody>
    </table></div></div> : null}
    {data.page.nextCursor || data.page.previousCursor ? <nav className="agent-insight-actions" aria-label="Usage history pages">
      <button type="button" className="secondary" disabled={disabled || loading || !data.page.previousCursor}
        onClick={() => { if (data.page.previousCursor) onPage(data.page.previousCursor); }}>Newer reports</button>
      <span>{data.value.length} of {data.counts.total} reports</span>
      <button type="button" className="secondary" disabled={disabled || loading || !data.page.nextCursor}
        onClick={() => { if (data.page.nextCursor) onPage(data.page.nextCursor); }}>Older reports</button>
    </nav> : null}
  </section>;
}
