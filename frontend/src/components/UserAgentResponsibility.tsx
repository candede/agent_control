import { useContext, useEffect, useMemo, useState } from "react";
import { isDirectoryObjectId } from "../../../backend/src/types/copilotPackage";
import { responsibilityLabels, type ResponsibilityPerson } from "../../../backend/src/types/agentResponsibility";
import { getAgentResponsibility, type AgentResponsibilityPage } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { usageDate } from "../usageInsights";
import { hasAppRole } from "../../../backend/src/types/capability";

type Props = {
  objectId?: string;
  dataRevision?: number;
  agentInventoryRevision?: number;
  onOpenAgent?: (id: string) => void;
  onPersonLoaded?: (person: ResponsibilityPerson | undefined) => void;
};

export function UserAgentResponsibility({ objectId, dataRevision = 0, agentInventoryRevision = 0, onOpenAgent, onPersonLoaded }: Props) {
  const context = useContext(CapabilityContext);
  const canRead = !context || hasAppRole(context.user?.roles ?? [], "AgentControl.Viewer");
  const scope = JSON.stringify([context?.user?.tenantId, context?.user?.homeAccountId, [...(context?.user?.roles ?? [])].sort()]);
  const [result, setResult] = useState<{ key: { query: object }; value?: AgentResponsibilityPage; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [navigation, setNavigation] = useState<{ scope: string; page: number; selectionId: string; cursor: string }>();
  const personId = objectId?.toLowerCase();
  const valid = personId !== undefined && isDirectoryObjectId(personId);
  const boundary = JSON.stringify([scope, personId, dataRevision, agentInventoryRevision, retry]);
  const local = navigation?.scope === boundary ? navigation : undefined;
  const selectionId = local?.selectionId, cursor = local?.cursor, page = local?.page ?? 0;
  const query = useMemo(() => ({ scope, personId, page, selectionId, cursor }), [scope, personId, page, selectionId, cursor]);
  const key = useMemo(() => ({ query, dataRevision, agentInventoryRevision, retry }), [query, dataRevision, agentInventoryRevision, retry]);
  const scoped = result?.key === key ? result : undefined;
  useEffect(() => {
    if (!valid || !canRead) return;
    const controller = new AbortController();
    void getAgentResponsibility({ objectId: personId, selectionId, cursor, limit: 50 }, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        if (value.selected?.person.objectId !== personId) throw new Error("Saved responsibility did not match the exact requested user.");
        if (selectionId && value.selection.id !== selectionId) throw new Error("Saved responsibility did not match the selected inventory.");
        setResult({ key, value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ key, error: error instanceof Error ? error.message : "Saved responsibility could not be loaded." });
        }
      });
    return () => controller.abort();
  }, [valid, canRead, key, personId, selectionId, cursor]);
  const data = canRead && valid && result?.key.query === query ? result.value : undefined;
  const selected = data?.selected;
  useEffect(() => {
    if (selected || !canRead || !valid || scoped?.error) onPersonLoaded?.(selected?.person);
  }, [onPersonLoaded, selected, canRead, valid, scoped?.error]);
  const changePage = (direction: "next" | "previous") => {
    const nextCursor = direction === "next" ? data?.page.nextCursor : data?.page.previousCursor;
    if (!data || !nextCursor) return;
    setNavigation({ scope: boundary, page: page + (direction === "next" ? 1 : -1), selectionId: data.selection.id, cursor: nextCursor });
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
        {!scoped && !data ? <p role="status">Loading saved responsibility...</p> : null}
        {!scoped && data ? <p className="sr-only" role="status">Refreshing saved responsibility. Showing the last loaded relationships.</p> : null}
        {scoped?.error ? <p role="alert" className="error-banner">{scoped.error} <button type="button" className="secondary"
          onClick={() => setRetry(value => value + 1)}>Retry saved responsibility</button></p> : null}
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
                  onClick={() => onOpenAgent(agent.id)}>{agent.displayName}</button> : <strong>{agent.displayName}</strong>}
                <small>Source observed {usageDate(agent.observedAt)}</small>
              </div>
              <ul className="responsibility-roles" aria-label={`Relationships for ${agent.displayName}`}>
                {agent.roles.map(role => <li key={role}>{responsibilityLabels[role]}</li>)}
              </ul>
            </li>)}</ul>
            }
            {selected.agents.some(agent => agent.roles.includes("lastModifiedBy")) ? <p className="responsibility-description">Last modified by records an edit, not ongoing ownership or maintenance.</p> : null}
          </> : null}
          {data.page.nextCursor || data.page.previousCursor ? <nav aria-label="Responsibility pages">
            <button type="button" className="secondary" disabled={!data.page.previousCursor} onClick={() => changePage("previous")}>Previous</button>
            <span>Page {page + 1} · {selected?.agents.length} of {selected?.count.toLocaleString()} agents</span>
            <button type="button" className="secondary" disabled={!data.page.nextCursor} onClick={() => changePage("next")}>Next</button>
          </nav> : null}
        </> : null}
      </>}
  </section>;
}
