import { useEffect, useRef, useState } from "react";
import {
  removeAgentUsageAssociation,
  type AgentUsageAssociation,
  type AgentUsageContext,
  type AgentUsageTarget,
  type UnifiedAgentRecord,
} from "../api/client";
import { usageCount, usageCoverageLabel, usageDate, reportedUserActivityUrl } from "../usageInsights";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { UsageReportContext } from "./UsageReportContext";
import "./agentInsights.css";

type Props = {
  record: UnifiedAgentRecord;
  context?: AgentUsageContext;
  inventoryRevision?: string;
  canRemoveReviewedAssociations: boolean;
  disabled?: boolean;
  onChanged?: () => void;
};
type ReviewedAssociation = Extract<AgentUsageAssociation, { basis: "admin_reviewed" }>;
type Confirmation = { association: ReviewedAssociation; contextKey: string };

export function AgentUsagePanel({ record, context, inventoryRevision, canRemoveReviewedAssociations, disabled = false, onChanged }: Props) {
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const hadConfirmation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus();
    else if (hadConfirmation.current && reviewTrigger.current?.isConnected) reviewTrigger.current.focus();
    hadConfirmation.current = Boolean(confirmation);
  }, [confirmation]);

  const report = context?.reportSet;
  const usableReport = Boolean(report?.complete && (context?.availability === "active" || context?.availability === "stale"));
  const usage = usableReport && record.usage?.status === "linked" && record.usage.reportSetId === report?.id ? record.usage : undefined;
  const editable = canRemoveReviewedAssociations && Boolean(usage && inventoryRevision && onChanged);
  const busy = disabled || saving;
  const contextKey = JSON.stringify([record.id, report?.id, context?.availability, context?.revision, inventoryRevision]);
  const currentConfirmation = confirmation?.contextKey === contextKey
    && usage?.associations.some(association => association.basis === "admin_reviewed"
      && association.reportAgentId === confirmation.association.reportAgentId) ? confirmation : undefined;
  const automaticMatches = usage?.associations.filter(association => association.basis === "exact_package_id").length ?? 0;
  const missingReason = !context
    ? "The selected report context is unavailable. Reload saved inventory and usage to load this agent's report metrics."
    : !usableReport
      ? "No complete usable usage report is selected. Import or select a complete report bundle to see saved-inventory matches."
      : !record.usage || record.usage.status === "unavailable" || record.usage.reportSetId === null
        ? "The selected report's usage projection is unavailable for this saved agent. Reload saved inventory and usage."
        : record.usage.reportSetId !== report?.id
          ? "This agent's saved usage belongs to a different report snapshot. Reload saved inventory and usage for the selected report."
          : "No report Agent ID in this selected snapshot matches a full, case-sensitive package ID in this agent's saved inventory, and no existing administrator-reviewed association applies. Names alone are not used to match agents.";

  function review(association: ReviewedAssociation) {
    reviewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation({ association, contextKey });
    setConfirmed(false);
    setError(undefined);
  }

  async function save() {
    if (!currentConfirmation || !confirmed || !editable || !report || !context || !inventoryRevision || busy) {
      setError("Review and confirm removal of the current report and inventory association before applying it.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await removeAgentUsageAssociation(record.id, {
        reportSetId: report.id,
        expectedInventoryRevision: inventoryRevision, expectedUsageRevision: context.revision, confirmed: true,
        reportAgentId: currentConfirmation.association.reportAgentId,
      });
      onChanged?.();
      if (mounted.current) setConfirmation(undefined);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The reviewed usage association could not be removed.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return <section className="agent-usage-insights" aria-label={`Usage and users for ${record.displayName}`}>
    <h3>Usage &amp; users</h3>
    {context ? <UsageReportContext data={{ availability: context.availability, activeSet: report ?? null, lineages: context.lineages }} /> : null}
    {usage ? <>
      <dl className="agent-usage-metrics" aria-label="Selected agent report metrics">
        <UsageMetric label="Responses" value={usageCount(usage.responses)} note="Total responses in this report." />
        <UsageMetric label="Active users" value={usageCount(usage.activeUsers)} note="Distinct reported user identities with positive responses; licensed and unlicensed counts are not added." />
        <UsageMetric label="Last reported activity" value={usageDate(usage.lastActivityDateUtc)} />
        <UsageMetric label="Report identities" value={usage.associations.length.toLocaleString()} note="Each matched or reviewed report identity is counted once." />
      </dl>
      {automaticMatches > 0 ? <p className="agent-insight-note">Usage matched automatically by exact report Agent ID and saved Graph package ID, including prefix and case. Existing saved inventory links determine the logical agent; display names are not used.</p> : null}
      <p className="agent-insight-note">Totals cover this selected Microsoft 365 report only, not lifetime usage or every host and channel. Overlapping reports are not added. Reporting matches are not provider-verified identity links and do not grant management permissions. Last reported activity can fall outside the reporting period.</p>
      <h4>Matched report identities</h4>
      <ul className="agent-usage-association-list">{usage.associations.map(association => <li key={association.reportAgentId}>
        <div><strong>{association.reportAgentName}</strong><code>{association.reportAgentId}</code>
          <span>{targetLabel(association.target)}</span>
          <small>{association.basis === "exact_package_id"
            ? "Automatically matched: exact report Agent ID = saved Graph package ID."
            : `Existing administrator-reviewed association, reviewed on ${usageDate(association.reviewedAt)}.`}</small></div>
        <div className="agent-insight-actions">
          <a href={reportedUserActivityUrl(association.reportAgentId, usage.reportSetId ?? undefined)}>View reported users</a>
          {editable && association.basis === "admin_reviewed" ? <WorkbenchActionGate actionId="agentUsage.remove" compact><button type="button" className="secondary"
            disabled={busy} aria-label={`Remove association for ${association.reportAgentName} (${association.reportAgentId})`}
            onClick={() => review(association)}>Remove reviewed association</button></WorkbenchActionGate> : null}
        </div>
      </li>)}</ul>
    </> : <div className="agent-insight-empty">
      <h4>No matched usage data for this agent</h4>
      <p>No matching usage is available for <strong>{record.displayName}</strong>. Its response totals, active users, and last-used date are unavailable.</p>
      <p>{missingReason}</p>
      <p>Missing usage data does not mean zero usage. Availability and installation describe access, not who used this agent.</p>
    </div>}
    {report ? <p className="agent-insight-note">Selected report snapshot: <code>{report.id}</code></p> : null}

    {error ? <div className="error-banner" role="alert"><span>{error}</span>
      {onChanged ? <button type="button" className="secondary" disabled={busy} onClick={onChanged}>Reload saved usage</button> : null}
    </div> : null}

    {currentConfirmation && editable ? <section className="agent-usage-confirmation" role="region" aria-label="Confirm reviewed association removal">
      <h4 ref={confirmationHeading} tabIndex={-1}>Remove reviewed association</h4>
      <dl>
        <dt>Inventory agent</dt><dd>{record.displayName}<code>{record.id}</code></dd>
        <dt>Report set</dt><dd><code>{report?.id}</code>{usageCoverageLabel(report ?? null)}</dd>
        <dt>Report identity</dt><dd>{currentConfirmation.association.reportAgentName}
          <code>{currentConfirmation.association.reportAgentId}</code></dd>
      </dl>
      <p>{targetLabel(currentConfirmation.association.target)}</p>
      <p>Removing this reviewed override does not remove report data. An exact saved-package ID match may still apply automatically.</p>
      <label className="agent-usage-confirm-checkbox"><input type="checkbox" checked={confirmed} disabled={busy}
        onChange={event => setConfirmed(event.target.checked)} />
        <span>I confirm this reporting association should be removed.</span>
      </label>
      <div className="agent-insight-actions">
        <WorkbenchActionGate actionId="agentUsage.remove" compact>
          <button type="button" disabled={busy || !confirmed} onClick={() => void save()}>
            {saving ? "Removing association..." : "Confirm removal"}
          </button>
        </WorkbenchActionGate>
        <button type="button" className="secondary" disabled={saving} onClick={() => setConfirmation(undefined)}>Cancel association change</button>
      </div>
    </section> : null}
    {context?.lineages.length ? <details className="agent-insight-provenance">
      <summary>Report provenance</summary>
      <ul>{context.lineages.map(lineage => <li key={lineage.versionId}>
        {lineage.kind}: source as of {usageDate(lineage.sourceAsOf)} ({lineage.sourceAsOfProvenance}); accepted {usageDate(lineage.acceptedAt)}.
        {lineage.warnings.length ? ` ${lineage.warnings.join(" ")}` : ""}
      </li>)}</ul>
    </details> : null}
  </section>;
}

function targetLabel(target: AgentUsageTarget) {
  return target.source === "graph_packages" ? `Graph package: ${target.packageId}`
    : `Power Platform: ${target.nativeId} - Environment: ${target.environmentId ?? "not reported"}`;
}

function UsageMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="agent-usage-metric"><dt>{label}</dt><dd><strong>{value}</strong>{note ? <small>{note}</small> : null}</dd></div>;
}
