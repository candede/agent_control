import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { getAgentInvestigationContext, getAgentPurviewRecords, resolveAgentInvestigationIdentity, type AgentInvestigationContext, type AppRole, type PurviewAuditRecord } from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { purviewAuditPresets } from "../../../backend/src/types/purviewAudit";
import { CapabilityContext } from "../capabilityContext";
import { useSavedQueryClient } from "../savedQueries";
import { DefenderHuntingView } from "./DefenderHuntingView";

type Props = { recordId: string; agentName: string; roles: AppRole[]; revision?: string };

export function AgentInvestigationsPanel(props: Props) {
  const capability = useContext(CapabilityContext);
  const identity = JSON.stringify([capability?.user?.tenantId, capability?.user?.homeAccountId,
    [...(capability?.user?.roles ?? [])].sort(), [...props.roles].sort(), props.recordId]);
  if (!hasAppRole(props.roles, "AgentControl.Viewer") || capability?.user && !hasAppRole(capability.user.roles, "AgentControl.Viewer")) {
    return <p className="agent-insight-note">An AgentControl.Viewer role is required to view agent logs.</p>;
  }
  if (!capability?.user) return <p className="agent-insight-note">Sign in to load agent investigation access.</p>;
  return <InvestigationSession key={identity} {...props} identity={identity} />;
}

function InvestigationSession({ recordId, agentName, identity, revision }: Props & { identity: string }) {
  const capability = useContext(CapabilityContext);
  const client = useSavedQueryClient();
  const [source, setSource] = useState<"defender" | "purview">("defender");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const contextScope = JSON.stringify([identity,
    capability?.views.filter(view => /^(defender\.hunting\.|purview\.audit\.search\.|graph\.agentIdentity\.read$)/.test(view.definition.id))
      .map(view => [view.definition.id, view.decision.status, view.decision.authorized,
        view.enabled, view.configuration])]);
  const contextKey = JSON.stringify([contextScope, revision]);
  const [resolution, setResolution] = useState<{ key: string; pending?: boolean; error?: string }>();
  if (resolution && resolution.key !== contextKey) setResolution(undefined);
  const resolving = resolution?.key === contextKey && Boolean(resolution.pending);
  const resolutionError = resolution?.key === contextKey ? resolution.error : undefined;
  const resolutionRequest = useRef<AbortController | undefined>(undefined);
  const accessRefreshRequest = useRef<Promise<unknown> | undefined>(undefined);
  useEffect(() => () => {
    resolutionRequest.current?.abort();
    resolutionRequest.current = undefined;
    accessRefreshRequest.current = undefined;
  }, [contextKey]);
  // An unsuccessful replacement query can retain its earlier successful placeholder.
  const [retainContext, setRetainContext] = useState(true);
  const contextQueryKey = ["agent-investigation-context", contextScope, revision];
  const context = useQuery({
    queryKey: contextQueryKey,
    queryFn: async ({ signal }) => {
      const value = await getAgentInvestigationContext(recordId, { signal });
      if (value.recordId !== recordId) throw new Error("Investigation access does not match the selected agent.");
      return value;
    },
    placeholderData: (previous, query) => retainContext && query?.queryKey[1] === contextScope && query.state.status === "success" ? previous : undefined,
  }, client);
  const current = context.isSuccess && !context.isFetching && !context.isPlaceholderData;
  if (context.isError && retainContext) setRetainContext(false);
  else if (current && !retainContext) setRetainContext(true);
  const data = context.isError || !retainContext && !current ? undefined : context.data;
  const defenderActive = source === "defender" && !resolving;
  const purviewActive = source === "purview" && data?.purview.status === "available";
  function canUseContext() {
    const cached = client.getQueryState(contextQueryKey);
    return current && cached?.status === "success" && cached.fetchStatus === "idle"
      && !cached.isInvalidated && cached.data === data;
  }
  function refreshAccess() {
    if (context.isFetching || resolutionRequest.current || accessRefreshRequest.current) return;
    setRefreshVersion(value => value + 1);
    const pending = context.refetch({ cancelRefetch: false });
    accessRefreshRequest.current = pending;
    void pending.finally(() => {
      if (accessRefreshRequest.current === pending) accessRefreshRequest.current = undefined;
    });
  }
  async function resolveIdentity() {
    if (!current || !data?.defender.resolution?.canResolve || resolutionRequest.current || accessRefreshRequest.current) return;
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
      <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh investigation access" title="Refresh investigation access" disabled={context.isFetching || resolving} onClick={refreshAccess}><RefreshCw size={15} aria-hidden="true" /></button>
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
    {context.isFetching ? <p role="status" className={data ? "sr-only" : undefined}>{data ? "Refreshing investigation access. Showing the last loaded saved data." : "Checking saved agent identity..."}</p> : null}
    {context.isError && !context.isFetching ? <p className="error-banner" role="alert">{context.error.message}</p>
        : data && source === "defender" ? <>
          {data.defender.resolution?.canResolve ? <div className="agent-insight-empty">
            <p>{resolutionSummary(data.defender.resolution)}</p>
            <button type="button" className="secondary" disabled={!current || resolving} onClick={() => void resolveIdentity()}>
              {resolving ? "Resolving log identity..." : data.defender.resolution.resolvedAt ? "Refresh log identity" : "Resolve log identity"}
            </button>
            {resolving ? <p role="status">Verifying the selected agent with Microsoft Graph...</p> : null}
            <p>Identity lookup requires delegated <code>AgentIdentity.Read.All</code> with admin consent and access to the agent identity
              (Agent ID Administrator for nonowners).</p>
          </div> : null}
          {data.defender.status !== "available" && !data.defender.resolution?.canResolve
            ? <IdentityUnavailable source="Defender" reason={data.defender.reason} reasonCode={data.defender.reasonCode} /> : null}
        </>
        : data?.purview.status === "unavailable"
          ? <IdentityUnavailable source="Purview" reason={data.purview.reason} reasonCode={data.purview.reasonCode} /> : null}
    {data?.defender.status === "available" ? <DefenderHuntingView active={defenderActive} contextCurrent={current}
      revision={JSON.stringify([contextKey, refreshVersion])}
      agentRecordId={recordId} agentName={agentName} entraAgentIds={data.defender.entraAgentIds}
      entraAgentApplicationIds={data.defender.entraAgentApplicationIds} templates={data.defender.templates} /> : null}
    <AgentPurviewRecords recordId={recordId} expectedRecordId={data?.recordId} identity={contextScope}
      revision={JSON.stringify([contextKey, refreshVersion])} active={purviewActive} contextCurrent={current}
      available={data?.purview.status === "available"} canUseContext={canUseContext} />
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

function AgentPurviewRecords({ recordId, expectedRecordId, identity, revision, active, contextCurrent, available, canUseContext }: {
  recordId: string; expectedRecordId?: string; identity: string; revision: string; active: boolean; contextCurrent: boolean; available: boolean;
  canUseContext: () => boolean;
}) {
  const client = useSavedQueryClient();
  const [search, setSearch] = useState("");
  const [operation, setOperation] = useState("");
  const [query, setQuery] = useState({ search: "", operation: "", limit: 50, offset: 0 });
  const [access, setAccess] = useState({ identity, available, generation: 0 });
  if (access.identity !== identity || access.available !== available) {
    setAccess({ identity, available, generation: access.generation + 1 });
  }
  const [retainRecords, setRetainRecords] = useState(true);
  const queryKey = ["agent-purview-records", identity, query, revision, access.generation];
  const records = useQuery({
    queryKey,
    enabled: active && contextCurrent,
    subscribed: active && contextCurrent,
    queryFn: async ({ signal }) => {
      const page = await getAgentPurviewRecords(recordId, query, { signal });
      if (page.recordId !== expectedRecordId) throw new Error("Audit records do not match the selected agent. Refresh investigation access.");
      return page;
    },
    placeholderData: (previous, saved) => retainRecords && saved?.queryKey[1] === identity && saved.queryKey[2] === query && saved.queryKey[4] === access.generation
      && saved.state.status === "success" ? previous : undefined,
  }, client);
  const current = active && contextCurrent && records.isSuccess && !records.isFetching && !records.isPlaceholderData;
  if (records.isError && retainRecords) setRetainRecords(false);
  else if (current && !retainRecords) setRetainRecords(true);
  const data = records.isError || !retainRecords && !current ? undefined : records.data;
  const pending = !contextCurrent || records.isFetching || records.isPending;
  const canPrevious = !pending && query.offset > 0;
  const canNext = current && Boolean(data && query.offset + query.limit < data.count);
  const actionOwner = {};
  const actions = useRef<{ owner: object; admitted: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    actions.current = { owner: actionOwner, admitted: false };
    return () => { actions.current = undefined; };
  });
  function currentAction() {
    const action = actions.current;
    if (!active || !canUseContext() || !action || action.owner !== actionOwner || action.admitted) return;
    const state = client.getQueryState(queryKey);
    // Shared invalidation can retire a page before its observer disables the controls.
    if (!state || state.fetchStatus !== "idle") return;
    return { action, state };
  }
  function movePage(direction: "previous" | "next") {
    const admitted = currentAction();
    if (!admitted || (direction === "previous" ? !canPrevious : !canNext
      || admitted.state.status !== "success" || admitted.state.isInvalidated || admitted.state.data !== data)) return;
    admitted.action.admitted = true;
    setQuery({ ...query, offset: direction === "previous" ? Math.max(0, query.offset - query.limit) : query.offset + query.limit });
  }
  if (!active) return null;
  return <section className="agent-investigation-records" aria-label="Agent Purview audit">
    <h4>Saved Purview audit records</h4>
    <form className="agent-insight-toolbar" onSubmit={event => {
      event.preventDefault();
      const admitted = currentAction();
      if (!admitted) return;
      admitted.action.admitted = true;
      const next = { search: search.trim(), operation: operation.trim(), limit: 50, offset: 0 };
      if (JSON.stringify(query) === JSON.stringify(next)) void records.refetch({ cancelRefetch: false });
      else setQuery(next);
    }}>
      <label>Search saved audit metadata<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} placeholder="Operation, actor or correlation" /></label>
      <label>Exact audit operation<select value={operation} onChange={event => setOperation(event.target.value)}>
        <option value="">All supported operations</option>
        {purviewAuditPresets.copilot_studio_admin.operationFilters.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <button type="submit" className="secondary" aria-disabled={pending}><Search size={15} aria-hidden="true" /> Search saved audit</button>
    </form>
    {pending ? <p role="status" className={data ? "sr-only" : undefined}>{data ? "Refreshing saved audit records. Showing the last loaded results." : "Loading agent audit records..."}</p> : null}
    {records.isError && !pending ? <p className="error-banner" role="alert">{records.error.message}</p>
        : data ? <>
          <p>{data.count} matching saved records.</p>
          {data.value.length ? <div className="agent-insight-table-shell" role="region" aria-label="Agent Purview records" tabIndex={0}>
            <table className="agent-insight-table agent-audit-table"><thead><tr><th scope="col">Time</th><th scope="col">Operation</th><th scope="col">Actor</th><th scope="col">Result</th><th scope="col">Details</th></tr></thead>
              <tbody>{data.value.map((record, index) => <tr key={`${record.wrapperId}:${index}`}>
                <td data-label="Time">{new Date(record.eventDateTime).toLocaleString()}</td><th scope="row" data-label="Operation">{record.operation}</th>
                <td data-label="Actor">{record.actorUserPrincipalName ?? record.actorUserId ?? "Not supplied"}</td><td data-label="Result">{record.resultStatus ?? "Not supplied"}</td>
                <td data-label="Details"><AuditRecordDetails record={record} /></td>
              </tr>)}</tbody></table>
          </div> : <p className="agent-insight-note">No matching saved audit records. Try another search or check audit collection in Setup &amp; permissions.</p>}
        </> : null}
    <div className="agent-insight-pagination">
      <button type="button" className="secondary" aria-disabled={!canPrevious} onClick={() => movePage("previous")}>Previous audit records</button>
      {data ? <span>{data.value.length ? `${query.offset + 1}-${query.offset + data.value.length} of ${data.count}` : data.count ? "No records on this page; return to the previous page." : "0 records"}</span> : null}
      <button type="button" className="secondary" aria-disabled={!canNext} onClick={() => movePage("next")}>Next audit records</button>
    </div>
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
