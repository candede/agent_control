import { useContext, useEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
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
    [...props.roles].sort(), props.recordId]);
  if (!hasAppRole(props.roles, "AgentControl.Viewer")) {
    return <p className="agent-insight-note">An AgentControl.Viewer role is required to view agent logs.</p>;
  }
  if (!capability?.user) return <p className="agent-insight-note">Sign in to load agent investigation access.</p>;
  return <InvestigationSession key={identity} {...props} identity={identity} />;
}

function InvestigationSession({ recordId, agentName, identity, revision }: Props & { identity: string }) {
  const capability = useContext(CapabilityContext);
  const [source, setSource] = useState<"defender" | "purview">("defender");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const contextKey = JSON.stringify([identity, revision,
    capability?.views.filter(view => /^(defender\.hunting\.|purview\.audit\.search\.|graph\.agentIdentity\.read$)/.test(view.definition.id))
      .map(view => [view.definition.id, view.decision.status, view.decision.authorized, view.decision.fresh,
        view.decision.verification, view.decision.previewQualification, view.enabled, view.configuration])]);
  const [resolution, setResolution] = useState<{ key: string; pending?: boolean; error?: string }>();
  const resolving = resolution?.key === contextKey && Boolean(resolution.pending);
  const resolutionError = resolution?.key === contextKey ? resolution.error : undefined;
  const resolutionRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => {
    resolutionRequest.current?.abort();
    resolutionRequest.current = undefined;
  }, [contextKey]);
  const context = useSavedQuery({
    queryKey: ["agent-investigation-context", contextKey],
    queryFn: ({ signal }) => getAgentInvestigationContext(recordId, { signal }),
    placeholderData: previous => previous,
  });
  const current = !context.isFetching && !context.isError && !context.isPlaceholderData;
  const defenderActive = current && source === "defender" && !resolving;
  const purviewActive = current && source === "purview" && context.data?.purview.status === "available";
  async function resolveIdentity() {
    if (resolutionRequest.current) return;
    const controller = new AbortController();
    resolutionRequest.current = controller;
    setResolution({ key: contextKey, pending: true });
    try {
      await resolveAgentInvestigationIdentity(recordId, { signal: controller.signal });
    } catch (cause) {
      if (!controller.signal.aborted) setResolution({ key: contextKey, pending: true,
        error: cause instanceof Error ? cause.message : "Agent identity lookup failed. Retry or check Setup & permissions." });
    } finally {
      if (!controller.signal.aborted) await context.refetch();
      if (!controller.signal.aborted) {
        resolutionRequest.current = undefined;
        setResolution(value => value?.key === contextKey ? { ...value, pending: false } : value);
      }
    }
  }
  return <section className="agent-investigations" aria-label={`Investigations for ${agentName}`}>
    <header className="agent-insight-toolbar agent-log-toolbar">
      <h3>Agent logs</h3>
      <button type="button" className="secondary" onClick={capability?.openPermissions}>Setup &amp; permissions</button>
      <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh investigation access" title="Refresh investigation access" disabled={context.isFetching || resolving} onClick={() => {
        setRefreshVersion(value => value + 1);
        void context.refetch();
      }}><RefreshCw size={15} aria-hidden="true" /></button>
    </header>
    <div className="agent-log-sources" role="group" aria-label="Investigation source">
      <button type="button" className="agent-log-source" aria-label="Defender & Agent 365" aria-pressed={source === "defender"} onClick={() => setSource("defender")}>
        <strong>Defender &amp; Agent 365</strong><span>Agent runs, tool calls and inventory</span><small>Query in this app</small>
      </button>
      <button type="button" className="agent-log-source" aria-label="Purview audit" aria-pressed={source === "purview"} onClick={() => setSource("purview")}>
        <strong>Purview audit</strong><span>Copilot Studio administrative changes</span><small>Browse saved records</small>
      </button>
    </div>
    <section className="agent-log-guide" aria-label={source === "defender" ? "Defender log coverage and setup" : "Purview log coverage and setup"}>
      {source === "defender" ? <>
        <h4>What you can investigate</h4>
        <ul>
          <li><strong>Agent activity:</strong> invocations and model inference, with timestamps, actors, duration and reported errors.</li>
          <li><strong>Tool activity:</strong> SDK, gateway and MCP tool calls, including tool names and outcomes.</li>
          <li><strong>Agent inventory:</strong> Defender's agent metadata and lifecycle state from the AgentsInfo preview table.</li>
        </ul>
        <p>Activity and tool events come from CloudAppEvents. These views contain metadata, not conversation transcripts.</p>
        <h4>Setup to query logs</h4>
        <p>Defender XDR access, applicable Agent 365/service licensing, and delegated <code>ThreatHunting.Read.All</code> with admin consent.
          Runtime events also require the relevant service to send telemetry to Defender.</p>
      </> : <>
        <h4>What these records show</h4>
        <p>Copilot Studio creation, deletion, publishing, sharing, authentication changes, and component or plugin changes.
          Each record shows when it happened, who made the change and its reported result.</p>
        <p><strong>Saved records only:</strong> this tab searches audit events already collected by this app and matched to this agent's bot and environment.
          It does not start a new Purview search or show conversation transcripts.</p>
        <h4>Setup to collect audit records</h4>
        <p>Purview auditing enabled, an Audit Logs or View-Only Audit Logs role, and delegated <code>AuditLogsQuery.Read.All</code> with admin consent.
          The app's user-level Purview search can collect records for a known administrator; agent-level collection is not available here.</p>
      </>}
    </section>
    {resolutionError ? <p className="error-banner" role="alert">Identity lookup: {resolutionError}</p> : null}
    {context.isFetching ? <p role="status">Checking saved agent identity...</p>
      : context.isError ? <p className="error-banner" role="alert">{context.error.message}</p>
        : context.data && source === "defender" ? <>
          {context.data.defender.resolution?.canResolve ? <div className="agent-insight-empty">
            <p>{resolutionSummary(context.data.defender.resolution)}</p>
            <button type="button" className="secondary" disabled={resolving} onClick={() => void resolveIdentity()}>
              {resolving ? "Resolving log identity..." : context.data.defender.resolution.resolvedAt ? "Refresh log identity" : "Resolve log identity"}
            </button>
            {resolving ? <p role="status">Verifying the selected agent with Microsoft Graph...</p> : null}
            <p>Identity lookup requires delegated <code>AgentIdentity.Read.All</code> with admin consent and access to the agent identity
              (Agent ID Administrator for nonowners).</p>
          </div> : null}
          {context.data.defender.status !== "available" && !context.data.defender.resolution?.canResolve
            ? <IdentityUnavailable source="Defender" reason={context.data.defender.reason} reasonCode={context.data.defender.reasonCode} /> : null}
        </>
        : context.data?.purview.status === "unavailable"
          ? <IdentityUnavailable source="Purview" reason={context.data.purview.reason} reasonCode={context.data.purview.reasonCode} /> : null}
    {context.data?.defender.status === "available" ? <DefenderHuntingView active={defenderActive}
      agentRecordId={recordId} agentName={agentName} entraAgentIds={context.data.defender.entraAgentIds}
      entraAgentApplicationIds={context.data.defender.entraAgentApplicationIds} templates={context.data.defender.templates} /> : null}
    <AgentPurviewRecords recordId={recordId} expectedRecordId={context.data?.recordId} identity={identity}
      revision={JSON.stringify([contextKey, refreshVersion])} active={purviewActive} />
  </section>;
}

function IdentityUnavailable({ source, reason, reasonCode }: { source: string; reason?: string; reasonCode?: AgentInvestigationContext["defender"]["reasonCode"] }) {
  const unsupported = reasonCode === "unsupported_agent_type" || reasonCode === "unsupported_identity_crosswalk";
  return <div className="agent-insight-empty">
    <h4>{unsupported ? `${source} linking not supported for this agent` : `${source} identity not mapped`}</h4>
    <p>{unsupported ? "This app cannot reliably match this agent to this log source. Changing permissions will not create a missing identity mapping."
      : reasonCode === "stale_source" ? "Refresh this agent's saved inventory source, then check again."
        : reason ?? (source === "Purview" ? "No Studio bot and environment mapping is saved."
          : "No verified Entra identity is saved for this agent. Refresh its inventory details.")}</p>
  </div>;
}

function resolutionSummary(resolution: NonNullable<AgentInvestigationContext["defender"]["resolution"]>) {
  switch (resolution.cacheStatus) {
    case "authorization_required": return "Admin prerequisite missing: check the app registration's AgentIdentity.Read.All grant and your Entra role, then retry.";
    case "not_found": return "Microsoft Graph found no accessible agent identity for this saved ID. Refresh the agent's inventory before retrying.";
    case "provider_error": return "The identity lookup failed. Retry or check Setup & permissions.";
    case "setup_required": return "Microsoft sign-in setup is incomplete. Review Setup & permissions before retrying.";
    case "expired": return "The saved identity verification expired. Resolve it again before hunting.";
  }
  return resolution.resolvedAt ? "Directory identity verified."
    : "Verify the agent's Entra identity to enable hunting.";
}

function AgentPurviewRecords({ recordId, expectedRecordId, identity, revision, active }: {
  recordId: string; expectedRecordId?: string; identity: string; revision: string; active: boolean;
}) {
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState("");
  const [query, setQuery] = useState({ search: "", operation: "", limit: 50, offset: 0 });
  const records = useSavedQuery({
    queryKey: ["agent-purview-records", identity, revision, query],
    enabled: active,
    queryFn: async ({ signal }) => {
      const page = await getAgentPurviewRecords(recordId, query, { signal });
      if (page.recordId !== expectedRecordId) throw new Error("Audit records do not match the selected agent. Refresh investigation access.");
      return page;
    },
  });
  if (!active) return null;
  return <section className="agent-investigation-records" aria-label="Agent Purview audit">
    <h4>Saved Purview audit records</h4>
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
          <p>{records.data.count} matching saved records.</p>
          {records.data.value.length ? <div className="agent-insight-table-shell" role="region" aria-label="Agent Purview records" tabIndex={0}>
            <table className="agent-insight-table agent-audit-table"><thead><tr><th scope="col">Time</th><th scope="col">Operation</th><th scope="col">Actor</th><th scope="col">Result</th><th scope="col">Details</th></tr></thead>
              <tbody>{records.data.value.map((record, index) => <tr key={`${record.wrapperId}:${index}`}>
                <td data-label="Time">{new Date(record.eventDateTime).toLocaleString()}</td><th scope="row" data-label="Operation">{record.operation}</th>
                <td data-label="Actor">{record.actorUserPrincipalName ?? record.actorUserId ?? "Not supplied"}</td><td data-label="Result">{record.resultStatus ?? "Not supplied"}</td>
                <td data-label="Details"><AuditRecordDetails record={record} /></td>
              </tr>)}</tbody></table>
          </div> : <p className="agent-insight-note">No matching saved audit records. Try another search or check audit collection in Setup &amp; permissions.</p>}
          <div className="agent-insight-pagination">
            <button type="button" className="secondary" disabled={query.offset === 0} onClick={() => setQuery(current => ({ ...current, offset: Math.max(0, current.offset - current.limit) }))}>Previous audit records</button>
            <span>{records.data.value.length ? `${query.offset + 1}-${query.offset + records.data.value.length} of ${records.data.count}` : records.data.count ? "No records on this page; return to the previous page." : "0 records"}</span>
            <button type="button" className="secondary" disabled={query.offset + query.limit >= records.data.count} onClick={() => setQuery(current => ({ ...current, offset: current.offset + current.limit }))}>Next audit records</button>
          </div>
        </> : null}
  </section>;
}

function AuditRecordDetails({ record }: { record: PurviewAuditRecord }) {
  return <dl className="agent-audit-event-details">
    {([
      ["Event ID", record.nativeEventId ?? record.wrapperId], ["Source", record.service],
      ["Correlation", record.correlationId], ["Component", record.botComponentId], ["Plugin operation", record.aiPluginOperationId],
    ] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}
