import { useContext, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { getAgentInvestigationContext, resolveAgentInvestigationIdentity, type AgentInvestigationContext, type AppRole } from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { CapabilityContext } from "../capabilityContext";
import { useSavedQueryClient } from "../savedQueries";
import { DefenderHuntingView } from "./DefenderHuntingView";
import { PurviewAuditView } from "./PurviewAuditView";

type Props = { recordId: string; agentName: string; roles: AppRole[]; revision?: string; active?: boolean;
  user?: { objectId: string; userPrincipalName: string } };

export function AgentInvestigationsPanel(props: Props) {
  const capability = useContext(CapabilityContext);
  const identity = JSON.stringify([capability?.user?.tenantId, capability?.user?.homeAccountId,
    [...(capability?.user?.roles ?? [])].sort(), [...props.roles].sort(), props.recordId, props.user]);
  if (props.active === false) return null;
  if (!hasAppRole(props.roles, "AgentControl.Viewer") || capability?.user && !hasAppRole(capability.user.roles, "AgentControl.Viewer")) {
    return <p className="agent-insight-note">An AgentControl.Viewer role is required to view agent logs.</p>;
  }
  if (!capability?.user) return <p className="agent-insight-note">Sign in to load agent investigation access.</p>;
  return <InvestigationSession key={identity} {...props} identity={identity} />;
}

function InvestigationSession({ recordId, agentName, identity, revision, user }: Props & { identity: string }) {
  const capability = useContext(CapabilityContext);
  const client = useSavedQueryClient();
  const [selectedSource, setSource] = useState<"defender" | "purview">();
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
  const source = selectedSource ?? ((user ? data?.defender.templates?.agent_activity.status : data?.defender.status) === "available" ? "defender" : "purview");
  const defenderActive = source === "defender" && !resolving;
  const purviewActive = source === "purview" && data?.purview.status === "available";
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
      <h3>{user ? `Logs on ${agentName}` : "Agent logs"}</h3>
      <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh investigation access" title="Refresh investigation access" disabled={context.isFetching || resolving} onClick={refreshAccess}><RefreshCw size={15} aria-hidden="true" /></button>
    </header>
    <label className="agent-log-source-picker"><span>Source</span><select value={source} onChange={event => setSource(event.target.value as "defender" | "purview")}>
      <option value="defender">Defender</option><option value="purview">Purview audit</option>
    </select></label>
    {resolutionError ? <p className="error-banner" role="alert">Identity lookup: {resolutionError}</p> : null}
    {context.isFetching ? <p role="status" className={data ? "sr-only" : undefined}>{data ? "Refreshing investigation access. Showing the last loaded saved data." : "Checking saved agent identity..."}</p> : null}
    {context.isError && !context.isFetching ? <p className="error-banner" role="alert">{context.error.message}</p>
        : data && source === "defender" ? <>
          {data.defender.resolution?.canResolve && (data.defender.status !== "available"
            || !user && data.defender.templates?.agents_inventory.status !== "available") ? <div className="agent-insight-empty">
            <p>{resolutionSummary(data.defender.resolution)}</p>
            <button type="button" className="secondary" disabled={!current || resolving} onClick={() => void resolveIdentity()}>
              {resolving ? "Resolving log identity..." : data.defender.resolution.resolvedAt ? "Refresh log identity" : "Resolve log identity"}
            </button>
            {resolving ? <p role="status">Verifying the selected agent with Microsoft Graph...</p> : null}
            {["authorization_required", "setup_required"].includes(data.defender.resolution.cacheStatus ?? "")
              ? <button type="button" className="secondary" onClick={capability?.openPermissions}>Open Permissions</button> : null}
          </div> : null}
          {data.defender.status !== "available" && !data.defender.resolution?.canResolve
            ? <IdentityUnavailable source="Defender" reason={data.defender.reason} reasonCode={data.defender.reasonCode} /> : null}
        </>
        : data?.purview.status === "unavailable"
          ? <IdentityUnavailable source="Purview" reason={data.purview.reason} reasonCode={data.purview.reasonCode} /> : null}
    {data?.defender.status === "available" ? <DefenderHuntingView active={defenderActive} contextCurrent={current}
      revision={JSON.stringify([contextKey, refreshVersion])}
      agentRecordId={recordId} agentName={agentName} entraAgentIds={data.defender.entraAgentIds}
      entraAgentApplicationIds={data.defender.entraAgentApplicationIds} templates={data.defender.templates} userObjectId={user?.objectId} /> : null}
    {data?.purview.status === "available" ? <PurviewAuditView agentRecordId={recordId} userPrincipalName={user?.userPrincipalName}
      presets={data.purview.presets} active={purviewActive} contextCurrent={current} /> : null}
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
