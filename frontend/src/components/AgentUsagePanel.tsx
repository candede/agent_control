import { useContext, useDeferredValue, useEffect, useRef, useState } from "react";
import {
  getOfficialUsageAgentUsers,
  removeAgentUsageAssociation,
  type AgentUsageAssociation,
  type AgentUsageContext,
  type AgentUsageTarget,
  type UnifiedAgentRecord,
} from "../api/client";
import { usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate } from "../usageInsights";
import { CapabilityContext } from "../capabilityContext";
import { useSavedQuery } from "../savedQueries";
import { WorkbenchActionGate } from "../workbenchActionContext";
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
  const reviewedAssociations = usage?.associations.filter(association => association.basis === "admin_reviewed") ?? [];
  const missingReason = !context
    ? "Report data is unavailable. Reload usage to try again."
    : !usableReport
      ? "Select a complete CSV report in Sync to see usage."
      : !record.usage || record.usage.status === "unavailable" || record.usage.reportSetId === null
        ? "Usage could not be loaded for this agent. Reload usage to try again."
        : record.usage.reportSetId !== report?.id
          ? "The selected report changed. Reload usage to update this agent."
          : "This agent is not included in the selected CSV report.";

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
    {report ? <div className="agent-usage-date-range" aria-label="CSV report dates">
      <span>CSV report dates</span>
      <strong>{report.reportingPeriod.startDate && report.reportingPeriod.endDate
        ? <><time dateTime={report.reportingPeriod.startDate}>{usageDate(report.reportingPeriod.startDate)}</time>{" - "}
          <time dateTime={report.reportingPeriod.endDate}>{usageDate(report.reportingPeriod.endDate)}</time></>
        : "Dates not supplied"}</strong>
      {context?.availability === "stale" ? <small>{usageAvailabilityLabel(context.availability)}</small> : null}
    </div> : null}
    {usage ? <>
      <dl className="agent-usage-metrics" aria-label="Selected agent report metrics">
        <UsageMetric label="Responses" value={usageCount(usage.responses)} />
        <UsageMetric label="Active users" value={usageCount(usage.activeUsers)} />
        <UsageMetric label="Last reported activity" value={usageDate(usage.lastActivityDateUtc)} />
      </dl>
      <AgentUsers key={contextKey} contextKey={contextKey} setId={report!.id}
        agentIds={usage.associations.map(association => association.reportAgentId)} />
      {editable && reviewedAssociations.length ? <details className="agent-insight-provenance">
        <summary>Reviewed report links</summary>
      <ul className="agent-usage-association-list">{reviewedAssociations.map(association => <li key={association.reportAgentId}>
        <div><strong>{association.reportAgentName}</strong><code>{association.reportAgentId}</code>
          <span>{targetLabel(association.target)}</span>
          <small>Reviewed {usageDate(association.reviewedAt)}</small></div>
        <div className="agent-insight-actions">
          <WorkbenchActionGate actionId="agentUsage.remove" compact><button type="button" className="secondary"
            disabled={busy} aria-label={`Remove association for ${association.reportAgentName} (${association.reportAgentId})`}
            onClick={() => review(association)}>Remove reviewed association</button></WorkbenchActionGate>
        </div>
      </li>)}</ul></details> : null}
    </> : <div className="agent-insight-empty">
      <h4>Usage unavailable</h4>
      <p>{missingReason}</p>
      {onChanged ? <button type="button" className="secondary" disabled={busy} onClick={onChanged}>Reload usage</button> : null}
    </div>}

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
  </section>;
}

function targetLabel(target: AgentUsageTarget) {
  return target.source === "graph_packages" ? `Graph package: ${target.packageId}`
    : `Power Platform: ${target.nativeId} - Environment: ${target.environmentId ?? "not reported"}`;
}

function UsageMetric({ label, value }: { label: string; value: string }) {
  return <div className="agent-usage-metric"><dt>{label}</dt><dd><strong>{value}</strong></dd></div>;
}

function AgentUsers({ setId, agentIds, contextKey }: { setId: string; agentIds: string[]; contextKey: string }) {
  const principal = useContext(CapabilityContext)?.user;
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const deferredSearch = useDeferredValue(search);
  const limit = 25;
  const read = useSavedQuery({
    queryKey: ["saved", "agent-users", principal?.tenantId, principal?.homeAccountId, contextKey, agentIds, deferredSearch, offset],
    queryFn: async ({ signal }) => {
      const result = await getOfficialUsageAgentUsers({ setId, agentIds, search: deferredSearch, offset, limit }, { signal });
      if (result.activeSet?.id !== setId || result.agentIds.length !== new Set(agentIds).size
        || agentIds.some(id => !result.agentIds.includes(id))) {
        throw new Error("The report changed. Reload agent usage.");
      }
      return result;
    },
  });
  const pending = read.isPending || read.isFetching || search !== deferredSearch;
  const users = !pending && !read.isError ? read.data?.users : undefined;
  return <section className="agent-usage-users" aria-label="Agent users">
    <div className="agent-insight-toolbar">
      <h4>Users{users ? ` (${users.count.toLocaleString()})` : ""}</h4>
      <input type="search" aria-label="Search agent users" placeholder="Search by name or email" value={search}
        onChange={event => { setSearch(event.target.value); setOffset(0); }} />
    </div>
    {pending ? <p role="status">Loading users...</p> : read.isError ? <div role="alert" className="error-banner">
      {read.error.message} <button type="button" className="secondary" onClick={() => void read.refetch()}>Retry users</button>
    </div> : users?.count === 0 ? <p>{search ? "No users match your search." : "No users listed in this report."}</p> : users ? <>
      <div className="table-shell">
        <table className="agent-insight-table"><caption className="sr-only">Users of this agent in the selected CSV report</caption>
          <thead><tr><th scope="col">User</th><th scope="col">Responses</th></tr></thead>
          <tbody>{users.value.map(user => <tr key={user.username}>
            <th scope="row">{user.displayName !== user.username ? <><span>{user.displayName}</span><small>{user.username}</small></> : user.username}</th>
            <td>{user.responsesSentToUsers.toLocaleString()}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="agent-insight-pagination">
        <span>{users.value.length ? offset + 1 : 0}-{Math.min(offset + users.value.length, users.count)} of {users.count.toLocaleString()} users</span>
        <button type="button" className="secondary" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - limit))}>Previous users</button>
        <button type="button" className="secondary" disabled={offset + limit >= users.count} onClick={() => setOffset(value => value + limit)}>Next users</button>
      </div>
    </> : null}
  </section>;
}
