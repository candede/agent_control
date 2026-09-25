import type { OfficialUsageBundlePreview } from "../api/client";
import { formatCoverage, formatProvenance, kindLabel } from "./officialUsageImportPresentation";

export function OfficialUsageImportReview({ preview }: { preview: OfficialUsageBundlePreview }) {
  const responses = preview.reconciliation.responses;
  const totals = responses && typeof responses === "object"
    ? Object.entries(responses).filter((entry): entry is [string, number] => ["agents", "userAgents", "users"].includes(entry[0]) && typeof entry[1] === "number")
    : [];
  const differ = new Set(totals.map(([, value]) => value)).size > 1;
  return (
    <section className="official-usage-preview" aria-label="Validated report previews">
      <p>All three report kinds are present. Review the server&apos;s coverage, warnings, and source totals before accepting.</p>
      <div className="table-shell usage-review-table" role="region" aria-label="Validated report rows" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Report</th><th scope="col">Rows</th><th scope="col">Activity coverage / source basis</th><th scope="col">Warnings</th></tr></thead>
          <tbody>
            {preview.staging.map(stage => (
              <tr key={stage.id}>
                <th scope="row"><span>{kindLabel(stage.kind)}</span></th>
                <td><span>{stage.rowCount.toLocaleString()}</span></td>
                <td>{formatCoverage(stage.reportingPeriod)}<small>{formatProvenance(stage.reportingPeriod.provenance)}; freshness {stage.sourceFreshness}{stage.sourceAsOf ? `; source as-of ${stage.sourceAsOf} (${stage.sourceAsOfProvenance})` : ""}</small></td>
                <td>{stage.warnings.length ? <ul className="official-usage-warnings">{stage.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : "None reported"}</td>
              </tr>
            ))}
            {preview.acceptedVersions.map(version => (
              <tr key={version.versionId}>
                <th scope="row"><span>{kindLabel(version.kind)} (accepted)</span></th><td><span>Retained</span></td>
                <td>{formatCoverage(version.reportingPeriod)}<small>{formatProvenance(version.reportingPeriod.provenance)}{version.sourceAsOf ? `; source as-of ${version.sourceAsOf} (${version.sourceAsOfProvenance})` : "; source refresh time unknown"}</small></td>
                <td>Immutable retained companion</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="usage-context-warning">Observed activity dates do not prove a reporting window or source freshness. Aggregate snapshots are non-additive; report identities are not joined across snapshots.</p>
      <section className="usage-review-reconciliation" aria-label="Source reconciliation">
        <h4>{differ ? "Source totals differ" : "Source reconciliation"}</h4>
        {totals.length ? <ul>{totals.map(([kind, count]) => <li key={kind}>{kindLabel(kind as "agents" | "userAgents" | "users")}: {count.toLocaleString()} responses</li>)}</ul>
          : <p>The server&apos;s reconciliation details are retained below. No combined response total is inferred.</p>}
        <p>Each export&apos;s values remain separate. A source discrepancy is not resolved by adding, replacing, or discarding reported values.</p>
      </section>
      <details className="usage-review-technical">
        <summary>Technical validation details</summary>
        <dl>
          <div><dt>Bundle hash</dt><dd><code>{preview.bundleHash}</code></dd></div>
          <div><dt>Reviewed selection revision</dt><dd>{preview.expectedActiveRevision}</dd></div>
        </dl>
        {preview.staging.map(stage => (
          <div key={stage.id}>
            <strong>{kindLabel(stage.kind)}</strong>
            <p>Hash <code>{stage.fileHash}</code> · schema {stage.schemaVersion} · parser {stage.parserVersion}</p>
            <p>Staging expires {stage.expiresAt}.{stage.correctionOfSetId ? ` Corrects snapshot ${stage.correctionOfSetId}.` : ""}</p>
          </div>
        ))}
        {preview.acceptedVersions.map(version => <p key={version.versionId}>{kindLabel(version.kind)}: retained version <code>{version.versionId}</code>; hash <code>{version.fileHash}</code></p>)}
        <h4>Server reconciliation</h4>
        <pre>{JSON.stringify(preview.reconciliation, null, 2)}</pre>
      </details>
      <p>Changed reports are retained as independent report sets, even for the same known reporting window. Exact duplicate observations reuse their original retained identity and acceptance time. No cumulative response total is inferred. The server rechecks the reviewed hash and selection revision atomically.</p>
    </section>
  );
}
