import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, type Query } from "@tanstack/react-query";
import { isDirectoryObjectId } from "../../../backend/src/types/copilotPackage";
import { responsibilityLabels, type AgentResponsibilityQuery, type ResponsibilityPerson } from "../../../backend/src/types/agentResponsibility";
import { ApiError, getAgentResponsibility, type AgentResponsibilityPage } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { useSavedQueryClient } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";
import { usageDate } from "../usageInsights";
import { hasAppRole } from "../../../backend/src/types/capability";

type Props = {
  objectId?: string;
  dataRevision?: number;
  agentInventoryRevision?: number;
  onOpenAgent?: (id: string) => void;
  onPersonLoaded?: (person: ResponsibilityPerson | undefined) => void;
};

async function readResponsibility(query: AgentResponsibilityQuery, signal: AbortSignal, selection?: AgentResponsibilityPage["selection"]) {
  const value = await getAgentResponsibility(query, { signal });
  signal.throwIfAborted();
  if (value.selected?.person.objectId.toLowerCase() !== query.objectId) {
    throw new ApiError(409, "selection_invalidated", "Saved responsibility did not match the exact requested user.");
  }
  if (query.selectionId && (value.selection.id.toLowerCase() !== query.selectionId
    || selection && (value.selection.revision !== selection.revision
      || Date.parse(value.selection.evaluatedAt) !== Date.parse(selection.evaluatedAt)
      || Date.parse(value.selection.expiresAt) !== Date.parse(selection.expiresAt)))) {
    throw new ApiError(409, "selection_invalidated", "Saved responsibility did not match the selected inventory.");
  }
  if (!(Date.parse(value.selection.expiresAt) > Date.now())) {
    throw new ApiError(409, "selection_invalidated", "The responsibility selection has expired. Retry saved responsibility.");
  }
  return value;
}

function rejectsResponsibility(query: Query, scope: string, selectionId: string) {
  return query.queryKey[0] === "saved" && query.queryKey[1] === "agent-responsibility" && query.queryKey[2] === scope
    && query.state.error instanceof ApiError && query.state.error.code === "selection_invalidated"
    && (query.queryKey[7] === selectionId || (query.state.data as AgentResponsibilityPage | undefined)?.selection.id.toLowerCase() === selectionId);
}

export function UserAgentResponsibility({ objectId, dataRevision = 0, agentInventoryRevision = 0, onOpenAgent, onPersonLoaded }: Props) {
  const context = useContext(CapabilityContext);
  const canRead = !context || hasAppRole(context.user?.roles ?? [], "AgentControl.Viewer");
  const scope = useReportPrincipalScope(), client = useSavedQueryClient();
  const [retry, setRetry] = useState(0);
  const [navigation, setNavigation] = useState<{ scope: string; page: number; selection: AgentResponsibilityPage["selection"]; cursor: string }>();
  const personId = objectId?.toLowerCase();
  const valid = personId !== undefined && isDirectoryObjectId(personId);
  const owner = JSON.stringify([scope, personId, retry]);
  const boundary = JSON.stringify([scope, personId, dataRevision, agentInventoryRevision, retry]);
  // Retained relationships must not turn a cancelled replacement query into a success.
  const [retained, setRetained] = useState<{ owner: string; cursor?: string; data: AgentResponsibilityPage }>();
  if (retained && retained.owner !== owner) setRetained(undefined);
  const [evidence, setEvidence] = useState<{ boundary: string; selectionId?: string; expiresAt?: number }>({ boundary });
  const current = evidence.boundary === boundary ? evidence : { boundary };
  if (evidence.boundary !== boundary) setEvidence(current);
  const local = navigation?.scope === boundary ? navigation : undefined;
  if (navigation && !local) setNavigation(undefined);
  const selectionId = local?.selection.id.toLowerCase(), cursor = local?.cursor, page = local?.page ?? 0;
  const [observedNow, setObservedNow] = useState(Date.now);
  const now = Math.max(observedNow, context?.now ?? 0);
  const expired = current.expiresAt !== undefined && !(current.expiresAt > now);
  const queryKey = ["saved", "agent-responsibility", scope, personId, dataRevision, agentInventoryRevision, retry, selectionId, cursor];
  const observed = client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount();
  const read = useQuery<AgentResponsibilityPage>({
    queryKey, enabled: cached => valid && canRead && !expired
      && !(cached.state.error instanceof ApiError && (cached.state.error.code === "selection_invalidated" || [401, 403].includes(cached.state.error.status))),
    staleTime: observed ? Infinity : 0, gcTime: 0,
    queryFn: ({ signal }) => readResponsibility({ objectId: personId, selectionId, cursor, limit: 50 }, signal, local?.selection),
  }, client);
  const incompleteRead = !read.isFetching && !read.isError
    && (read.isPending || read.isStale && client.getQueryState(queryKey)?.isInvalidated);
  if (read.data && !read.isError && !read.isFetching && !incompleteRead && (retained?.owner !== owner || retained.cursor !== cursor || retained.data !== read.data)) {
    setRetained({ owner, cursor, data: read.data });
  } else if (retained && (read.isError || incompleteRead)) setRetained(undefined);
  if (read.data && !read.isError && !read.isFetching && !incompleteRead
    && (current.selectionId !== read.data.selection.id.toLowerCase() || current.expiresAt !== Date.parse(read.data.selection.expiresAt))) {
    setEvidence({ boundary, selectionId: read.data.selection.id.toLowerCase(), expiresAt: Date.parse(read.data.selection.expiresAt) });
  }
  const retainedPage = !read.data && read.isFetching && retained?.owner === owner && retained.cursor === cursor && !selectionId ? retained : undefined;
  const value = read.data ?? retainedPage?.data;
  const invalidated = expired || read.error instanceof ApiError && read.error.code === "selection_invalidated";
  const error = !read.isFetching ? expired ? "The responsibility selection has expired. Retry saved responsibility."
    : read.error?.message ?? (incompleteRead ? read.isPending ? "Saved responsibility was cancelled. Retry saved responsibility."
      : "Saved responsibility needs reloading. Retry saved responsibility." : undefined) : undefined;
  const data = canRead && valid && !invalidated && !read.isError && !incompleteRead && value
    && Date.parse(value.selection.expiresAt) > now ? value : undefined;
  const selected = data?.selected;
  const paginationOwner = JSON.stringify([scope, personId]);
  const hasPages = Boolean(data?.page.nextCursor || data?.page.previousCursor);
  const [pagination, setPagination] = useState({ owner: paginationOwner, visible: false });
  if (pagination.owner !== paginationOwner || hasPages && !pagination.visible) setPagination({ owner: paginationOwner, visible: hasPages });
  const expiresAt = current.expiresAt ?? (value ? Date.parse(value.selection.expiresAt) : undefined);
  useEffect(() => {
    if (!retainedPage) return;
    const retire = (query: Query) => {
      if (rejectsResponsibility(query, scope, retainedPage.data.selection.id.toLowerCase())) {
        setRetained(previous => previous === retainedPage ? undefined : previous);
      }
    };
    const cache = client.getQueryCache();
    cache.findAll({ queryKey: ["saved", "agent-responsibility", scope] }).forEach(retire);
    return cache.subscribe(event => { if (event.type === "updated") retire(event.query); });
  }, [client, retainedPage, scope]);
  useEffect(() => {
    if (expiresAt === undefined || !(expiresAt > now) || invalidated) return;
    const checkExpiry = () => setObservedNow(Date.now());
    window.addEventListener("focus", checkExpiry);
    const timer = window.setTimeout(checkExpiry, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())));
    return () => { window.removeEventListener("focus", checkExpiry); window.clearTimeout(timer); };
  }, [expiresAt, invalidated, now]);
  useEffect(() => {
    if (!invalidated || !current.selectionId) return;
    for (const cached of client.getQueryCache().findAll({ queryKey: ["saved", "agent-responsibility", scope],
      predicate: query => query.queryKey[7] === current.selectionId
        || (query.state.data as AgentResponsibilityPage | undefined)?.selection.id.toLowerCase() === current.selectionId,
    })) {
      if (cached.state.error instanceof ApiError && cached.state.error.code === "selection_invalidated") continue;
      // An unpinned first-page revalidation can replace the retired evidence.
      if (cached.queryKey[7] !== undefined || cached.state.fetchStatus !== "fetching") {
        void client.cancelQueries({ queryKey: cached.queryKey, exact: true });
      }
      cached.setState({ error: new ApiError(409, "selection_invalidated", "The responsibility selection changed or expired. Retry saved responsibility."),
        errorUpdatedAt: Date.now(), errorUpdateCount: cached.state.errorUpdateCount + 1, status: "error", isInvalidated: true });
    }
  }, [client, current.selectionId, invalidated, scope]);
  useEffect(() => {
    if (selected || !canRead || !valid || error || invalidated || !current.selectionId) onPersonLoaded?.(selected?.person);
  }, [onPersonLoaded, selected, canRead, valid, error, invalidated, current.selectionId]);
  useEffect(() => () => onPersonLoaded?.(undefined), [onPersonLoaded]);
  const [actionOwner, setActionOwner] = useState({ boundary, cursor, client });
  if (actionOwner.boundary !== boundary || actionOwner.cursor !== cursor || actionOwner.client !== client) setActionOwner({ boundary, cursor, client });
  const actions = useRef<{ owner: object; moved: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    actions.current = { owner: actionOwner, moved: false };
    return () => { actions.current = undefined; };
  }, [actionOwner]);
  function availableAtAction(checkedAt: number) {
    if (actions.current?.owner !== actionOwner || actions.current.moved || !data) return false;
    if (!(Date.parse(data.selection.expiresAt) > checkedAt)) { setObservedNow(checkedAt); return false; }
    const cached = client.getQueryState(queryKey);
    return !cached?.error && !(cached?.isInvalidated && cached.fetchStatus !== "fetching")
      && (read.data ? cached?.data === data : cached?.fetchStatus === "fetching"
      && !client.getQueryCache().find({ queryKey: ["saved", "agent-responsibility", scope], exact: false,
        predicate: query => rejectsResponsibility(query, scope, data.selection.id.toLowerCase()) }));
  }
  const changePage = (direction: "next" | "previous", checkedAt: number) => {
    const nextCursor = direction === "next" ? data?.page.nextCursor : data?.page.previousCursor;
    if (!nextCursor || !data || !availableAtAction(checkedAt) || read.isFetching || client.getQueryState(queryKey)?.fetchStatus === "fetching") return;
    actions.current!.moved = true;
    setNavigation({ scope: boundary, page: page + (direction === "next" ? 1 : -1), selection: data.selection, cursor: nextCursor });
  };
  const retryRead = () => {
    const cached = client.getQueryState(queryKey);
    if (actions.current?.owner !== actionOwner || actions.current.moved || !error || cached?.fetchStatus === "fetching"
      || !expired && !cached?.error && cached?.status !== "pending" && !cached?.isInvalidated) return;
    actions.current.moved = true;
    setRetry(value => value + 1);
  };
  return <section className="user-detail-card user-responsibility" aria-label="Agent responsibility">
    <div className="responsibility-heading">
      <h3>Agent responsibility</h3>
      {selected && selected.state !== "unavailable" ? <span className="responsibility-count">{selected.count.toLocaleString()} {selected.count === 1 ? "agent" : "agents"}</span> : null}
    </div>
    <p className="responsibility-description">Agents this user owns, created, or last modified. These saved relationships do not grant access or permission to manage agents.</p>
    {!canRead ? <p role="alert">Responsibility unavailable: current Viewer access is required.</p>
      : !valid ? <p>Link this user to a directory identity through Users sync to view agent responsibilities. Report-only or concealed identities are not matched by name.</p>
      : <>
        {!error && read.isFetching && !data ? <p role="status">Loading saved responsibility...</p> : null}
        {!error && read.isFetching && data ? <p className="sr-only" role="status">Refreshing saved responsibility. Showing the last loaded relationships.</p> : null}
        {error ? <p role="alert" className="error-banner">{error} <button type="button" className="secondary"
          onClick={retryRead}>Retry saved responsibility</button></p> : null}
        {data ? <>
          {selected?.state === "unavailable" ? <p className="copilot-users-notice" role="status">
            Agent responsibility is unavailable; relationships are unknown, not zero. {data.sources.powerPlatform.error?.message} Refresh agent inventory in Sync.
          </p> : null}
          {selected && selected.state !== "unavailable" ? <>
            {selected.state === "no_reported_relationships" ? <div className="responsibility-empty">
              <strong>No reported responsibilities</strong>
              <p>No responsibilities reported for this user in the available inventory. This does not rule out relationships outside that inventory.</p>
            </div> : <ul className="responsibility-list" aria-label="Agents with saved responsibility">{selected.agents.map(agent => <li key={agent.id}>
              <div className="responsibility-agent">
                {onOpenAgent ? <button type="button" className="agent-name-button" aria-label={`Open agent ${agent.displayName}`}
                  onClick={() => { if (availableAtAction(Date.now())) onOpenAgent(agent.id); }}>{agent.displayName}</button> : <strong>{agent.displayName}</strong>}
                <small>Source observed {usageDate(agent.observedAt)}</small>
              </div>
              <ul className="responsibility-roles" aria-label={`Relationships for ${agent.displayName}`}>
                {agent.roles.map(role => <li key={role}>{responsibilityLabels[role]}</li>)}
              </ul>
            </li>)}</ul>
            }
            {selected.agents.some(agent => agent.roles.includes("lastModifiedBy")) ? <p className="responsibility-description">Last modified by records an edit, not ongoing ownership or maintenance.</p> : null}
          </> : null}
        </> : null}
        {pagination.owner === paginationOwner && pagination.visible ? <nav className="copilot-users-pagination" aria-label="Responsibility pages" aria-busy={read.isFetching}>
          <button type="button" className="secondary" aria-disabled={!data?.page.previousCursor || read.isFetching} onClick={() => changePage("previous", Date.now())}>Previous</button>
          <span>{read.isFetching ? "Loading responsibility page..." : !selected || selected.state === "unavailable" ? "Responsibility page unavailable"
            : `Page ${page + 1} · ${selected.agents.length} of ${selected.count.toLocaleString()} agents`}</span>
          <button type="button" className="secondary" aria-disabled={!data?.page.nextCursor || read.isFetching} onClick={() => changePage("next", Date.now())}>Next</button>
        </nav> : null}
      </>}
  </section>;
}
