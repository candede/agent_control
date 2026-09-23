import { useEffect, useState } from "react";
import { ApiError, getOfficialUsageAggregate, type OfficialUsageAgentQuery, type OfficialUsageAggregateView } from "../api/client";
import { useSavedRead } from "../savedQueries";
import { ReportingView, type AgentFilters } from "./ReportingView";

export function OfficialUsageSnapshot({ setId, activityWindowDays, revision, onBack, onCurrentSnapshot }: {
  setId?: string;
  activityWindowDays: number;
  revision: number;
  onBack: () => void;
  onCurrentSnapshot: () => void;
}) {
  const [query, setQuery] = useState<AgentFilters>({});
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ scope: string; data: OfficialUsageAggregateView }>();
  const [read, setRead] = useState<{ key: string; error?: string }>();
  const readSaved = useSavedRead();
  const scope = JSON.stringify([setId, activityWindowDays, revision, reload]);
  const readKey = JSON.stringify([scope, query, offset]);
  const dateError = Boolean(query.startDate && query.endDate && query.startDate > query.endDate);
  const currentRead = read?.key === readKey ? read : undefined;
  const data = result?.scope === scope ? result.data : undefined;
  const loading = !dateError && !currentRead;
  const unavailable = Boolean(currentRead?.error) || dateError || (!loading && !data?.activeSet);

  useEffect(() => {
    if (dateError) return;
    const controller = new AbortController();
    const request: OfficialUsageAgentQuery = { ...query, setId, activityWindowDays, limit: 25, offset };
    void readSaved(["official-usage-aggregate", request, revision, reload],
      signal => getOfficialUsageAggregate(request, { signal }), controller.signal)
      .then(next => {
        if (controller.signal.aborted) return;
        if (setId && next.activeSet?.id !== setId) {
          throw new Error("The requested retained set is unavailable. No current snapshot has been substituted.");
        }
        setResult({ scope, data: next });
        setRead({ key: readKey });
      })
      .catch(reason => {
        if (controller.signal.aborted || (reason instanceof ApiError && reason.kind === "aborted")) return;
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setResult(undefined);
        setRead({ key: readKey, error: reason instanceof Error ? reason.message : "The report snapshot could not be loaded." });
      });
    return () => controller.abort();
  }, [activityWindowDays, dateError, offset, query, readKey, readSaved, reload, revision, scope, setId]);

  return <section className="usage-snapshot" aria-label="Snapshot inspection" tabIndex={0}>
    <header className="report-section-header">
      <div>
        <h3>{setId ? `Retained snapshot ${setId.slice(0, 8)}` : "Current snapshot"}</h3>
        {setId ? <p role="status"><strong>{loading ? "Loading retained set" : unavailable ? "Retained set unavailable" : "Showing retained set"}</strong> {setId}</p> : null}
        <p>This read-only inspection includes report-only identities, not an inventory comparison. Opening a snapshot does not change the tenant&apos;s current report selection.</p>
      </div>
      <div className="table-actions">
        <button type="button" className="secondary" onClick={onBack}>Back to reports</button>
        <button type="button" className="secondary" disabled={dateError} onClick={() => setReload(value => value + 1)}>Refresh snapshot</button>
        {setId ? <button type="button" className="secondary" onClick={onCurrentSnapshot}>View current snapshot</button> : null}
      </div>
    </header>
    <ReportingView data={data} query={query} offset={offset} loading={loading} error={currentRead?.error}
      onRetry={() => setReload(value => value + 1)} onAgentPageChange={setOffset}
      onAgentQueryChange={next => { setQuery(next); setOffset(0); }} />
  </section>;
}
