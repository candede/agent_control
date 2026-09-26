import { useContext, useEffect, useMemo, useState } from "react";
import { isDirectoryObjectId } from "../../../backend/src/types/copilotPackage";
import { responsibilityLabels, type ResponsibilityPerson } from "../../../backend/src/types/agentResponsibility";
import { getAgentResponsibility, type AgentResponsibilityPage } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { useSavedRead } from "../savedQueries";
import { usageDate } from "../usageInsights";
import type { UsersRouteState } from "../workbenchRouting";
import { hasAppRole } from "../../../backend/src/types/capability";

type Props = {
  compact?: boolean;
  objectId?: string;
  dataRevision?: number;
  agentInventoryRevision?: number;
  onOpenAgent?: (id: string) => void;
  route?: UsersRouteState;
  onRouteChange?: (route: UsersRouteState) => void;
};

export function UserAgentResponsibility({ compact = false, objectId, dataRevision = 0, agentInventoryRevision = 0, onOpenAgent, route, onRouteChange }: Props) {
  const context = useContext(CapabilityContext);
  const canRead = !context || hasAppRole(context.user?.roles ?? [], "AgentControl.Viewer");
  const scope = JSON.stringify([context?.user?.tenantId, context?.user?.homeAccountId, context?.user?.roles]);
  const [result, setResult] = useState<{ key: { query: object }; value?: AgentResponsibilityPage; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [localPage, setLocalPage] = useState(0);
  const readSaved = useSavedRead();
  const page = route?.page ?? localPage;
  const personId = route?.personId ?? objectId;
  const search = route?.search ?? "";
  const valid = personId === undefined ? Boolean(route) : isDirectoryObjectId(personId);
  const query = useMemo(() => ({ scope, personId, search, page, readSaved }), [scope, personId, search, page, readSaved]);
  const key = useMemo(() => ({ query, dataRevision, agentInventoryRevision, retry }), [query, dataRevision, agentInventoryRevision, retry]);
  const scoped = result?.key === key ? result : undefined;
  useEffect(() => {
    if (!valid || !canRead) return;
    const controller = new AbortController();
    void readSaved(["agent-responsibility", scope, personId, search, page, dataRevision, agentInventoryRevision, retry],
      signal => getAgentResponsibility({ objectId: personId, search, offset: page * 50, limit: 50 }, { signal }), controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        if (personId && value.selected?.person.objectId !== personId.toLowerCase()) throw new Error("Saved responsibility did not match the exact requested user.");
        setResult({ key, value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "Saved responsibility could not be loaded." });
      });
    return () => controller.abort();
  }, [valid, canRead, key, scope, personId, search, page, dataRevision, agentInventoryRevision, retry, readSaved]);
  const data = canRead && valid && result?.key.query === query ? result.value : undefined;
  const selected = data?.selected;
  const count = selected?.count ?? data?.count ?? 0;
  const changePage = (next: number) => route ? onRouteChange?.({ ...route, page: next }) : setLocalPage(next);
  return <section className="user-responsibility" aria-label="Agent responsibility">
    <h3>Agent responsibility</h3>
    {!compact ? <p>Owner, Created by and Last modified by are explicit saved source relationships, not usage, access assignments or permission to manage agents. A last modifier is not necessarily a maintainer.</p> : null}
    {!canRead ? <p role="alert">Responsibility unavailable: current Viewer access is required.</p>
      : !valid ? <p>{compact ? "Link this user to a directory identity through Users sync to view agent responsibilities." : "Responsibility unavailable: no exact verified directory object ID is established for this user. Report-only or concealed identities are not matched by name."}</p>
      : <>
        {route && personId ? <button type="button" className="secondary" onClick={() => onRouteChange?.({ view: "responsibility", search: "", page: 0 })}>All responsible people</button> : null}
        {route && !personId ? <label>Search responsible people<input aria-label="Search responsible people" value={search}
          onChange={event => onRouteChange?.({ ...route, search: event.target.value, page: 0 })} /></label> : null}
        {!scoped && !data ? <p role="status">Loading saved responsibility...</p> : null}
        {scoped?.error ? <p role="alert" className="error-banner">{scoped.error} <button type="button" className="secondary"
          onClick={() => setRetry(value => value + 1)}>Retry saved responsibility</button></p> : null}
        {data ? <>
          {compact ? <>
            {data.coverage === "unavailable" ? <p className="copilot-users-notice" role="status">Agent responsibility is unavailable. {data.sources.powerPlatform.error?.message} Refresh agent inventory in Sync.</p>
              : data.coverage === "partial" ? <p className="reported-users-note">Partial agent inventory</p> : null}
          </> : <><p className="copilot-users-notice">{data.coverage === "unavailable"
            ? "Responsibility source unavailable. No current authorized saved Power Platform agent source is available; relationships are unknown, not zero."
            : data.coverage === "partial"
              ? `Partial responsibility coverage. ${data.unknownAgentCount.toLocaleString()} agents have missing or invalid responsibility fields; other agents may be outside the saved source scope.`
              : "Responsibility covers the current authorized saved Power Platform agent source, not all tenant relationships."}</p>
          {data.invalidReferenceCount ? <p>{data.invalidReferenceCount} invalid responsibility identifiers were not joined to users.</p> : null}</>}
          {selected ? <>
            {!compact ? <ResponsibilityIdentity person={selected.person} /> : null}
            {route ? <p>License and observed usage are not established by responsibility. Use the separate paid-license and report cohorts for that evidence.</p> : null}
            {selected.state !== "unavailable" ? <p>{selected.count.toLocaleString()} {selected.count === 1 ? "agent" : "agents"} {compact ? "with a reported responsibility." : "with reported responsibility in the saved source."}</p> : null}
            {selected.state === "no_reported_relationships" ? <p>{compact ? "No responsibilities reported for this user in the available inventory." : "No reported responsibility relationships for this exact user in the available saved source. This is not proof of no responsibility elsewhere."}</p> : null}
            <ul className="responsibility-list">{selected.agents.map(agent => <li key={agent.id}>
              <strong>{agent.displayName}</strong>
              <span>{agent.roles.map(role => responsibilityLabels[role]).join(" · ")}</span>
              {!compact ? <><small>{agent.presence === "power_platform" ? "Power Platform-only agent" : "Canonical agent"} · Source observed {usageDate(agent.observedAt)}</small>
              {agent.environmentId ? <small>Environment: {agent.environmentId}</small> : null}</> : null}
              {onOpenAgent ? <button type="button" className="secondary" onClick={() => onOpenAgent(agent.id)}>Open agent {agent.displayName}</button> : null}
            </li>)}</ul>
          </> : <>
            {data.coverage !== "unavailable" ? <p>{data.count.toLocaleString()} responsible people. Includes identities outside paid-license and active-report cohorts.</p> : null}
            {!data.count && data.coverage !== "unavailable" ? <p>No reported responsibility people match this saved-source selection.</p> : null}
            <ul className="responsibility-list">{data.people.map(person => <li key={person.objectId}>
              <ResponsibilityIdentity person={person} />
              <span>{person.agentCount} agents · {person.roles.map(role => responsibilityLabels[role]).join(" · ")}</span>
              <button type="button" className="secondary" onClick={() => onRouteChange?.({ view: "responsibility", personId: person.objectId, search: "", page: 0 })}>
                View responsibility for {person.evidence?.displayName || person.objectId}
              </button>
            </li>)}</ul>
          </>}
          {count > 50 || page > 0 ? <nav aria-label="Responsibility pages">
            <button type="button" className="secondary" disabled={page === 0} onClick={() => changePage(page - 1)}>Previous</button>
            <span> Page {page + 1} of {Math.max(1, Math.ceil(count / 50))} </span>
            <button type="button" className="secondary" disabled={(page + 1) * 50 >= count} onClick={() => changePage(page + 1)}>Next</button>
          </nav> : null}
          {!compact ? <details><summary>Responsibility source coverage</summary>
            {Object.entries(data.sources).map(([source, status]) => <p key={source}>
              {source === "powerPlatform" ? "Power Platform agents" : "Graph packages"}: {status.state}.
              {status.error ? ` ${status.error.message}` : ""}
              {status.observation ? ` Observed ${usageDate(status.observation.observedAt)}; expires ${usageDate(status.observation.expiresAt)}.` : ""}
            </p>)}
            <p>Relationships use exact tenant-scoped object IDs only. Graph package names, operation creators, connectors and reported usage do not create responsibility.</p>
          </details> : null}
        </> : null}
      </>}
  </section>;
}

function ResponsibilityIdentity({ person }: { person: ResponsibilityPerson }) {
  const context = useContext(CapabilityContext);
  const [initialNow] = useState(Date.now);
  const evidence = person.evidence;
  const expired = evidence?.expiresAt !== undefined && !(Date.parse(evidence.expiresAt) > (context?.now ?? initialNow));
  return <div className="responsibility-identity">
    <strong>{evidence?.displayName || evidence?.userPrincipalName || person.objectId}</strong>
    <small>ID: {person.objectId}</small>
    {evidence?.userPrincipalName ? <small>Sign-in: {evidence.userPrincipalName}</small> : null}
    {evidence ? <small>Saved directory: {usageDate(evidence.observedAt)}</small> : null}
    {evidence?.checkedAt && evidence.checkedAt !== evidence.observedAt ? <small>Last lookup attempt: {usageDate(evidence.checkedAt)}</small> : null}
    {expired ? <small>Saved lookup expired; identity is unverified until saved data is refreshed.</small> : null}
    {!evidence ? <small>Unverified directory identity. This is a source responsibility reference, not a verified user profile.</small>
      : evidence.status === "not_found" ? <small>User not found at the last directory lookup.</small>
      : evidence.status === "lookup_failed" ? <small>Directory lookup failed ({evidence.errorCode ?? "unknown error"}). Any identity label is last-known evidence.</small>
      : !expired ? <small>Resolved saved directory identity.</small> : null}
  </div>;
}
