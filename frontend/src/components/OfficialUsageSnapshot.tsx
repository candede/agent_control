import { useEffect, useState } from "react";
import { ApiError, getOfficialUsageAggregate, type OfficialUsageAgentQuery, type OfficialUsageAggregateView } from "../api/client";
import { useSavedRead } from "../savedQueries";
import { ReportingView, type AgentFilters } from "./ReportingView";

export function OfficialUsageSnapshot({ setId, activityWindowDays, revision, onBack }: {
  setId?: string;
  activityWindowDays: number;
  revision: number;
  onBack: () => void;
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
      <button type="button" className="secondary" onClick={onBack}>Back to reports</button>
      <p>Viewing this report does not change the selected report set.</p>
    </header>
    <ReportingView data={data} query={query} offset={offset} loading={loading} error={currentRead?.error}
      onRetry={() => setReload(value => value + 1)} onAgentPageChange={setOffset}
      onAgentQueryChange={next => { setQuery(next); setOffset(0); }} />
  </section>;
}
