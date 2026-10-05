import type { ReportMetadata } from "../../../backend/src/types/officialReportData";
import { usageAvailabilityLabel, usageDate } from "../usageInsights";
export function UsageReportContext({ reports, inlineSources = false }: { reports: ReportMetadata; inlineSources?: boolean }) {
  const sources = <><dl>{reports.lineages.map(lineage => <div key={lineage.kind}><dt>{lineage.kind}</dt>
    <dd>{lineage.rowCount.toLocaleString()} rows; version {lineage.versionId}; source freshness {lineage.sourceFreshness};
      source as of {usageDate(lineage.sourceAsOf)} ({lineage.sourceAsOfProvenance})</dd></div>)}</dl>
    <p>History revision {reports.historyRevision}; selected set {reports.setId ?? "None"}. Activity dates do not prove continuous coverage. Counts across reports are not additive. Import time does not establish source freshness.</p></>;
  return <section className="usage-report-context" aria-label="Report provenance">
    <span>{usageAvailabilityLabel(reports.availability)}</span>
    <span>Reporting period: {reports.reportingPeriod?.startDate ?? "Not supplied"} to {reports.reportingPeriod?.endDate ?? "Not supplied"}</span>
    <span>Provenance: {reports.reportingPeriod?.provenance ?? "Unknown"}</span><span>Imported {usageDate(reports.acceptedAt)}</span>
    {reports.availability === "stale" ? <p role="status">Reports are out of date. Historical totals remain visible, not current activity.</p> : null}
    {reports.reportingPeriod?.provenance === "activity_range" ? <p>Observed dates are last-activity dates, not a proven reporting window.</p> : null}
    {inlineSources ? <section className="usage-report-sources" aria-label="Report sources"><h4>Report sources</h4>{sources}</section>
      : <details><summary>Report sources</summary>{sources}</details>}
  </section>;
}
