import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  associateAgentUsage,
  getAgentUsageCandidates,
  removeAgentUsageAssociation,
  type AgentUsageAssociation,
  type AgentUsageCandidatePage,
  type AgentUsageContext,
  type AgentUsageTarget,
  type UnifiedAgentRecord,
} from "../api/client";
import { usageCount, usageCoverageLabel, usageDate, usagePageLabel, userAgentMatrixUrl } from "../usageInsights";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { UsageReportContext } from "./UsageReportContext";
import "./agentInsights.css";

type Props = {
  record: UnifiedAgentRecord;
  context?: AgentUsageContext;
  inventoryRevision?: string;
  canManage: boolean;
  disabled?: boolean;
  onChanged?: () => void;
};
type Candidate = AgentUsageCandidatePage["value"][number];
type Confirmation = { kind: "add"; candidate: Candidate } | { kind: "remove"; association: AgentUsageAssociation };

export function AgentUsagePanel({ record, context, inventoryRevision, canManage, disabled = false, onChanged }: Props) {
  const [browsing, setBrowsing] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [candidates, setCandidates] = useState<AgentUsageCandidatePage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [targetKey, setTargetKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const browseButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const confirmationHeading = useRef<HTMLHeadingElement>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const hadBrowsing = useRef(false);
  const hadConfirmation = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (browsing) searchInput.current?.focus();
    else if (hadBrowsing.current) browseButton.current?.focus();
    hadBrowsing.current = browsing;
  }, [browsing]);

  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus();
    else if (hadConfirmation.current) {
      (reviewTrigger.current?.isConnected ? reviewTrigger.current : browseButton.current)?.focus();
    }
    hadConfirmation.current = Boolean(confirmation);
  }, [confirmation]);

  const report = context?.reportSet;
  const usableReport = Boolean(report && (context?.availability === "active" || context?.availability === "stale"));
  const usage = usableReport && record.usage?.status === "linked" && record.usage.reportSetId === report?.id ? record.usage : undefined;
  const editable = canManage && usableReport && Boolean(inventoryRevision && onChanged);
  const busy = disabled || saving;
  const targets: AgentUsageTarget[] = [
    ...[...new Set(record.packages.map(item => item.id))].map((packageId): AgentUsageTarget => ({ source: "graph_packages", packageId })),
    ...(record.powerPlatformResource ? [{
      source: "power_platform" as const,
      nativeId: record.powerPlatformResource.nativeId,
      environmentId: record.powerPlatformResource.environmentId,
    }] : []),
  ];
  const selectedTarget = targets.find(target => JSON.stringify(target) === targetKey);

  async function browse(search = "", offset = 0) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBrowsing(true);
    setLoading(true);
    setCandidates(undefined);
    setError(undefined);
    setSubmittedSearch(search);
    try {
      const page = await getAgentUsageCandidates(record.id, { search, offset, limit: 20 }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (page.context.revision !== context?.revision || page.context.reportSet?.id !== report?.id) {
        setError("The selected report or its associations changed. Reload saved usage before reviewing an association.");
        return;
      }
      setCandidates(page);
    } catch (cause) {
      if (controller.signal.aborted || cause instanceof ApiError && cause.kind === "aborted") return;
      setError(cause instanceof Error ? cause.message : "Usage report candidates could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function review(value: Confirmation) {
    reviewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation(value);
    setConfirmed(false);
    setTargetKey(targets.length === 1 ? JSON.stringify(targets[0]) : "");
    setError(undefined);
  }

  async function save() {
    if (!confirmation || !confirmed || !editable || !report || !context || !inventoryRevision || busy) {
      setError("Review and confirm the current report and inventory association before applying it.");
      return;
    }
    if (confirmation.kind === "add" && !selectedTarget) {
      setError("Choose the exact inventory target for this reporting association.");
      return;
    }
    setSaving(true);
    setError(undefined);
    const common = {
      reportSetId: report.id,
      expectedInventoryRevision: inventoryRevision,
      expectedUsageRevision: context.revision,
      confirmed: true as const,
    };
    try {
      if (confirmation.kind === "add" && selectedTarget) {
        await associateAgentUsage(record.id, { ...common, reportAgentId: confirmation.candidate.agentId, target: selectedTarget });
      } else if (confirmation.kind === "remove") {
        await removeAgentUsageAssociation(record.id, { ...common, reportAgentId: confirmation.association.reportAgentId });
      }
      onChanged?.();
      if (mounted.current) {
        setConfirmation(undefined);
        setCandidates(undefined);
        setBrowsing(false);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "The usage association could not be saved.");
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return <section className="agent-usage-insights" aria-label={`Usage and users for ${record.displayName}`}>
    <h3>Usage &amp; users</h3>
    {context ? <UsageReportContext data={{ availability: context.availability, activeSet: report ?? null, lineages: context.lineages }} /> : null}
    {usage ? <>
      <p className="agent-insight-note">Administrator-reviewed usage, not a provider-verified identity link. Totals cover this selected Microsoft 365 report only, not lifetime usage or every host and channel. Last reported activity can fall outside the reporting period.</p>
      <dl className="agent-usage-metrics" aria-label="Selected agent report metrics">
        <UsageMetric label="Responses" value={usageCount(usage.responses)} note="Total responses in this report." />
        <UsageMetric label="Active users" value={usageCount(usage.activeUsers)} note="Distinct report identities with positive responses; licensed and unlicensed counts are not added." />
        <UsageMetric label="Last reported activity" value={usageDate(usage.lastActivityDateUtc)} />
        <UsageMetric label="Report identities" value={usage.associations.length.toLocaleString()} note="Each associated report identity is counted once." />
      </dl>
      <h4>Usage report associations</h4>
      <ul className="agent-usage-association-list">{usage.associations.map(association => <li key={association.reportAgentId}>
        <div><strong>{association.reportAgentName}</strong><code>{association.reportAgentId}</code>
          <span>{targetLabel(association.target)}</span>
          <small>Administrator-reviewed on {usageDate(association.reviewedAt)}</small></div>
        <div className="agent-insight-actions">
          <a href={userAgentMatrixUrl(association.reportAgentId, usage.reportSetId ?? undefined)}>View reported users</a>
          {editable ? <WorkbenchActionGate actionId="agentUsage.remove" compact><button type="button" className="secondary"
            disabled={busy} aria-label={`Remove association for ${association.reportAgentName} (${association.reportAgentId})`}
            onClick={() => review({ kind: "remove", association })}>Remove association</button></WorkbenchActionGate> : null}
        </div>
      </li>)}</ul>
    </> : <div className="agent-insight-empty">
      <h4>No verified usage data for this agent</h4>
      <p>No usage report is linked to <strong>{record.displayName}</strong> through a verified identity or administrator-reviewed association. Its response totals, active users, and last-used date are unavailable.</p>
      <p>Missing usage data does not mean zero usage. Availability and installation describe access, not who used this agent.</p>
      {context && !usableReport ? <p>Import and select a complete official usage report bundle to review report associations.</p> : null}
    </div>}

    {editable ? <div className="agent-insight-actions"><WorkbenchActionGate actionId="agentUsage.candidates" compact>
      <button ref={browseButton} type="button" className="secondary" disabled={busy || loading} onClick={() => void browse(searchDraft.trim())}>Associate a usage report</button>
    </WorkbenchActionGate></div> : null}
    {error ? <div className="error-banner" role="alert"><span>{error}</span>
      {onChanged ? <button type="button" className="secondary" disabled={busy} onClick={onChanged}>Reload saved usage</button> : null}
    </div> : null}

    {browsing && editable ? <section className="agent-selected-report" aria-label="Usage report candidates">
      <h4>Review an exact reporting association</h4>
      <p className="agent-insight-note">Names and equal-looking IDs do not prove identity. Associate a report identity only after checking that it refers to this agent. Associations are shared with authorized inventory viewers, apply only to this report set, and never authorize management actions.</p>
      <form className="agent-insight-toolbar" onSubmit={event => { event.preventDefault(); void browse(searchDraft.trim()); }}>
        <label>Search report agents<input ref={searchInput} type="search" value={searchDraft} maxLength={200} disabled={busy} onChange={event => setSearchDraft(event.target.value)} /></label>
        <button type="submit" className="secondary" disabled={busy || loading}>Search reports</button>
        <button type="button" className="secondary" disabled={saving} onClick={() => {
          request.current?.abort();
          setLoading(false);
          setBrowsing(false);
          setConfirmation(undefined);
        }}>Close report search</button>
      </form>
      {loading ? <p role="status">Loading report candidates...</p> : null}
      {candidates ? <>
        <p>{candidates.count.toLocaleString()} report identities{submittedSearch ? ` matching "${submittedSearch}"` : ""}. Already-associated identities must be removed from their existing inventory target before reassignment.</p>
        <div className="agent-report-candidates">{candidates.value.map(candidate => <button key={candidate.agentId} type="button"
          className="agent-report-candidate" disabled={busy || candidate.associated}
          aria-label={`Review association for ${candidate.agentName} (${candidate.agentId})`}
          onClick={() => review({ kind: "add", candidate })}>
          <span><strong>{candidate.agentName}</strong><small>{candidate.creatorType}</small><code>{candidate.agentId}</code></span>
          <span>{usageCount(candidate.responsesSentToUsers)} responses<small>{candidate.associated ? "Already associated" : "Review association"}</small></span>
        </button>)}</div>
        <div className="agent-insight-pagination">
          <span>{usagePageLabel(candidates, "report identities")}</span>
          <button type="button" className="secondary" disabled={busy || loading || candidates.offset === 0}
            onClick={() => void browse(submittedSearch, Math.max(0, candidates.offset - candidates.limit))}>Previous reports</button>
          <button type="button" className="secondary" disabled={busy || loading || candidates.offset + candidates.limit >= candidates.count}
            onClick={() => void browse(submittedSearch, candidates.offset + candidates.limit)}>Next reports</button>
        </div>
      </> : null}
    </section> : null}

    {confirmation && editable ? <section className="agent-usage-confirmation" role="region" aria-label="Confirm usage association">
      <h4 ref={confirmationHeading} tabIndex={-1}>{confirmation.kind === "add" ? "Confirm reporting association" : "Remove reporting association"}</h4>
      <dl>
        <dt>Inventory agent</dt><dd>{record.displayName}<code>{record.id}</code></dd>
        <dt>Report set</dt><dd><code>{report?.id}</code>{usageCoverageLabel(report ?? null)}</dd>
        <dt>Report identity</dt><dd>{confirmation.kind === "add" ? confirmation.candidate.agentName : confirmation.association.reportAgentName}
          <code>{confirmation.kind === "add" ? confirmation.candidate.agentId : confirmation.association.reportAgentId}</code></dd>
      </dl>
      {confirmation.kind === "add" ? <label>Exact inventory target
        <select value={targetKey} disabled={busy} onChange={event => { setTargetKey(event.target.value); setConfirmed(false); }}>
          <option value="">Choose a source-qualified target</option>
          {targets.map(target => <option key={JSON.stringify(target)} value={JSON.stringify(target)}>{targetLabel(target)}</option>)}
        </select>
      </label> : <p>{targetLabel(confirmation.association.target)}</p>}
      <label className="agent-usage-confirm-checkbox"><input type="checkbox" checked={confirmed} disabled={busy}
        onChange={event => setConfirmed(event.target.checked)} />
        <span>{confirmation.kind === "add" ? "I reviewed the report identity and exact inventory target; they refer to the same agent." : "I confirm this reporting association should be removed."}</span>
      </label>
      <div className="agent-insight-actions">
        <WorkbenchActionGate actionId={confirmation.kind === "add" ? "agentUsage.associate" : "agentUsage.remove"} compact>
          <button type="button" disabled={busy || !confirmed || confirmation.kind === "add" && !selectedTarget} onClick={() => void save()}>
            {saving ? "Saving association..." : confirmation.kind === "add" ? "Confirm association" : "Confirm removal"}
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
