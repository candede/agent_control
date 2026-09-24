import { useContext, useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { getAgentInvestigationContext, getAgentPurviewRecords, resolveAgentInvestigationIdentity, type AgentInvestigationContext, type AppRole, type PurviewAuditRecord } from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { purviewAuditPresets } from "../../../backend/src/types/purviewAudit";
import { CapabilityContext } from "../capabilityContext";
import { useSavedQuery } from "../savedQueries";
import { DefenderHuntingView } from "./DefenderHuntingView";

type Props = { recordId: string; agentName: string; roles: AppRole[]; revision?: string };

export function AgentInvestigationsPanel(props: Props) {
  const capability = useContext(CapabilityContext);
  const identity = JSON.stringify([capability?.user?.tenantId, capability?.user?.homeAccountId,
    [...props.roles].sort(), props.recordId, props.revision,
    capability?.views.filter(view => /^(defender\.hunting\.|purview\.audit\.search\.|graph\.agentIdentity\.read$)/.test(view.definition.id))]);
  if (!hasAppRole(props.roles, "AgentControl.Viewer")) {
    return <p className="agent-insight-note">Viewer is not assigned. Audit and Defender records and counts were not requested.</p>;
  }
  if (!capability?.user) return <p className="agent-insight-note">Sign in to load agent investigation access.</p>;
  return <InvestigationSession key={identity} {...props} identity={identity} />;
}

function InvestigationSession({ recordId, agentName, identity }: Props & { identity: string }) {
  const capability = useContext(CapabilityContext);
  const [source, setSource] = useState<"defender" | "purview">("defender");
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<string>();
  const resolutionRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => resolutionRequest.current?.abort(), []);
  const context = useSavedQuery({
    queryKey: ["agent-investigation-context", identity],
    queryFn: ({ signal }) => getAgentInvestigationContext(recordId, { signal }),
  });
  async function resolveIdentity() {
    if (resolutionRequest.current) return;
    const controller = new AbortController();
    resolutionRequest.current = controller;
    setResolving(true);
    setResolutionError(undefined);
    try {
      await resolveAgentInvestigationIdentity(recordId, { signal: controller.signal });
      if (!controller.signal.aborted) await context.refetch();
    } catch (cause) {
      if (!controller.signal.aborted) setResolutionError(cause instanceof Error ? cause.message : "Agent identity lookup failed. Retry or check Setup & permissions.");
    } finally {
      if (!controller.signal.aborted) {
        resolutionRequest.current = undefined;
        setResolving(false);
      }
    }
  }
  return <section className="agent-investigations" aria-label={`Investigations for ${agentName}`}>
    <header className="agent-insight-toolbar">
      <div><h3>Agent logs</h3><p className="tab-description">Metadata only. Hunts run only when requested.</p></div>
      <button type="button" className="secondary" onClick={capability?.openPermissions}>Setup &amp; permissions</button>
      <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh investigation access" title="Refresh investigation access" disabled={context.isFetching || resolving} onClick={() => void context.refetch()}><RefreshCw size={15} aria-hidden="true" /></button>
    </header>
    <div className="agent-insight-toolbar" role="group" aria-label="Investigation source">
      <button type="button" className="secondary" aria-pressed={source === "defender"} onClick={() => setSource("defender")}>Defender &amp; Agent 365</button>
      <button type="button" className="secondary" aria-pressed={source === "purview"} onClick={() => setSource("purview")}>Purview audit</button>
    </div>
    {resolutionError ? <p className="error-banner" role="alert">Identity lookup: {resolutionError}</p> : null}
    {context.isFetching ? <p role="status">Checking saved agent identity...</p>
      : context.isError ? <p className="error-banner" role="alert">{context.error.message}</p>
        : context.data ? source === "defender" ? <>
          {context.data.defender.resolution?.canResolve ? <div className="agent-insight-empty">
            <p>{resolutionSummary(context.data.defender.resolution)}</p>
            <button type="button" className="secondary" disabled={resolving} onClick={() => void resolveIdentity()}>
              {resolving ? "Resolving log identity..." : context.data.defender.resolution.resolvedAt ? "Refresh log identity" : "Resolve log identity"}
            </button>
            {resolving ? <p role="status">Verifying the selected agent with Microsoft Graph...</p> : null}
            <details><summary>Lookup details</summary>
              <p>Prerequisite: an administrator adds delegated <code>AgentIdentity.Read.All</code> to the app registration and grants admin consent. Microsoft Entra role requirements also apply; see Setup &amp; permissions.</p>
              {context.data.defender.resolution.reason ? <p>{context.data.defender.resolution.reason}</p> : null}
            </details>
          </div> : null}
          {context.data.defender.status === "available"
          ? <DefenderHuntingView agentRecordId={recordId} agentName={agentName} entraAgentIds={context.data.defender.entraAgentIds}
            entraAgentApplicationIds={context.data.defender.entraAgentApplicationIds} templates={context.data.defender.templates} />
          : !context.data.defender.resolution?.canResolve ? <IdentityUnavailable source="Defender" reason={context.data.defender.reason} reasonCode={context.data.defender.reasonCode} /> : null}
        </>
        : <section aria-label="Agent Purview audit">
          <h4>Saved Purview audit records</h4>
          <p className="tab-description">Saved Copilot Studio admin events only. No live collection.</p>
          {context.data.purview.status === "available" ? <AgentPurviewRecords key={identity} recordId={recordId} identity={identity} />
            : <IdentityUnavailable source="Purview" reason={context.data.purview.reason} reasonCode={context.data.purview.reasonCode} />}
          <a className="primary-link secondary" href="https://purview.microsoft.com/audit/auditsearch" target="_blank" rel="noreferrer">Audit Search (not agent-scoped) <ExternalLink size={15} aria-hidden="true" /></a>
        </section> : null}
  </section>;
}

function IdentityUnavailable({ source, reason, reasonCode }: { source: string; reason?: string; reasonCode?: AgentInvestigationContext["defender"]["reasonCode"] }) {
  const unsupported = reasonCode === "unsupported_agent_type" || reasonCode === "unsupported_identity_crosswalk";
  return <div className="agent-insight-empty">
    <h4>{unsupported ? `${source} linking not supported for this agent` : `${source} identity not mapped`}</h4>
    <p>{unsupported ? "This agent type has no verified log mapping in this app. Microsoft may still hold its logs."
      : reasonCode === "stale_source" ? "Refresh this agent's saved inventory source, then check again."
        : source === "Purview" ? "No verified Studio bot/environment link is saved. Enabling auditing does not create this link."
          : "A verified log identity is missing. Portal setup alone will not fix the mapping."}</p>
    <details><summary>Technical details</summary><p>{reason ?? "An exact saved agent identity is required."}</p></details>
  </div>;
}

function resolutionSummary(resolution: NonNullable<AgentInvestigationContext["defender"]["resolution"]>) {
  switch (resolution.cacheStatus) {
    case "authorization_required": return "Admin prerequisite missing: check the app registration's AgentIdentity.Read.All grant and your Entra role, then retry.";
    case "not_found": return "Microsoft Graph found no accessible agent identity for this saved ID. Refresh the agent's inventory before retrying.";
    case "provider_error": return "The identity lookup failed. Retry; the last failure is recorded in Lookup details.";
    case "setup_required": return "Microsoft sign-in setup is incomplete. Review Setup & permissions before retrying.";
    case "expired": return "The saved identity verification expired. Resolve it again before hunting.";
  }
  return resolution.resolvedAt ? "Directory identity verified. This does not verify log collection."
    : "Verify this agent's saved Entra Agent ID with Microsoft Graph. No hunt runs automatically.";
}

function AgentPurviewRecords({ recordId, identity }: { recordId: string; identity: string }) {
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState("");
  const [query, setQuery] = useState({ search: "", operation: "", limit: 50, offset: 0 });
  const records = useSavedQuery({
    queryKey: ["agent-purview-records", identity, query],
    queryFn: ({ signal }) => getAgentPurviewRecords(recordId, query, { signal }),
  });
  return <div className="agent-investigation-records">
    <form className="agent-insight-toolbar" onSubmit={event => {
      event.preventDefault();
      const next = { search: search.trim(), operation: operation.trim(), limit: 50, offset: 0 };
      if (JSON.stringify(query) === JSON.stringify(next)) void records.refetch();
      else setQuery(next);
    }}>
      <label>Search saved audit metadata<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} placeholder="Operation, actor or correlation" /></label>
      <label>Exact audit operation<select value={operation} onChange={event => setOperation(event.target.value)}>
        <option value="">All supported operations</option>
        {purviewAuditPresets.copilot_studio_admin.operationFilters.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <button type="submit" className="secondary" disabled={records.isFetching}><Search size={15} aria-hidden="true" /> Search saved audit</button>
    </form>
    {records.isFetching ? <p role="status">Loading agent audit records...</p>
      : records.isError ? <p className="error-banner" role="alert">{records.error.message}</p>
        : records.data ? <>
          <p>{records.data.count} matching saved records. This is not a total of all activity in Microsoft Purview.</p>
          {records.data.value.length ? <div className="agent-insight-table-shell" role="region" aria-label="Agent Purview records" tabIndex={0}>
            <table className="agent-insight-table"><thead><tr><th scope="col">Time</th><th scope="col">Operation</th><th scope="col">Actor</th><th scope="col">Result</th><th scope="col">Details</th></tr></thead>
              <tbody>{records.data.value.map((record, index) => <tr key={`${record.wrapperId}:${index}`}>
                <td>{new Date(record.eventDateTime).toLocaleString()}</td><th scope="row">{record.operation}</th>
                <td>{record.actorUserPrincipalName ?? record.actorUserId ?? "Not supplied"}</td><td>{record.resultStatus ?? "Not supplied"}</td>
                <td><AuditRecordDetails record={record} /></td>
              </tr>)}</tbody></table>
          </div> : <p className="agent-insight-note">No exact matching saved records. This does not prove inactivity, full collection or absence of risk.</p>}
          <div className="agent-insight-pagination">
            <button type="button" className="secondary" disabled={query.offset === 0} onClick={() => setQuery(current => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}>Previous audit records</button>
            <span>{records.data.value.length ? `${query.offset + 1}-${query.offset + records.data.value.length} of ${records.data.count}` : records.data.count ? "No records on this page; return to the previous page." : "0 records"}</span>
            <button type="button" className="secondary" disabled={query.offset + query.limit >= records.data.count} onClick={() => setQuery(current => ({ ...current, offset: current.offset + current.limit }))}>Next audit records</button>
          </div>
        </> : null}
  </div>;
}

function AuditRecordDetails({ record }: { record: PurviewAuditRecord }) {
  return <details><summary>Event metadata</summary><dl className="inventory-identifiers">
    {([
      ["Event ID", record.nativeEventId ?? record.wrapperId], ["Source", record.service],
      ["Correlation", record.correlationId], ["Environment", record.environmentId], ["Bot", record.botId],
      ["Agent", record.agentId], ["Host", record.appHost], ["Object", record.objectId],
    ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "Not supplied"}</dd></div>)}
  </dl><p>Message references: {record.messages.length}; content is not available.</p></details>;
}
