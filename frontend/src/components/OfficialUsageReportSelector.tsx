import { useEffect, useRef, useState } from "react";
import {
  ApiError, confirmOfficialUsageSetOperation, getOfficialUsageAdminState, getOfficialUsageHistory,
  previewOfficialUsageSetOperation, type OfficialUsageSetSummary,
} from "../api/client";
import { useSavedQuery } from "../savedQueries";
import "./officialUsage.css";

const pageSize = 100;

export function OfficialUsageReportSelector({ principalKey, revision, onChanged }: {
  principalKey: string;
  revision: number;
  onChanged: (selectionChanged: boolean) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [unverifiedRead, setUnverifiedRead] = useState<string>();
  const [deniedRead, setDeniedRead] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const readKey = JSON.stringify([revision, offset, reload]);
  const read = useSavedQuery({
    queryKey: ["saved", "report-set-selector", principalKey, revision, offset, reload],
    queryFn: async ({ signal }) => {
      const [admin, history] = await Promise.all([
        getOfficialUsageAdminState({ signal }),
        getOfficialUsageHistory({ limit: pageSize, offset }, { signal }),
      ]);
      return { admin, history };
    },
  });
  const loading = read.isPending || read.isFetching;
  const data = !read.isError && !loading && deniedRead !== readKey ? read.data : undefined;
  const sets = data?.history.bundles.value ?? [];
  const activeId = data?.admin.activeSetId ?? "";
  const active = data?.admin.sets.find(set => set.id === activeId);
  const candidateId = selection ?? activeId;
  const candidate = sets.find(set => set.id === candidateId) ?? (candidateId === activeId ? active : undefined);
  const needsRefresh = unverifiedRead === readKey;
  const disabled = busy || !data || needsRefresh;
  const count = data?.history.bundles.count ?? 0;
  const placeholder = loading ? "Loading report sets..." : !data ? "Report sets unavailable"
    : count === 0 ? "No report sets available" : activeId ? "Choose a report set" : "No report set selected";

  async function selectReport(setId: string) {
    if (disabled || setId === activeId || !sets.some(set => set.id === setId)) return;
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    setSelection(setId);
    setBusy(true);
    setErrorMessage(undefined);
    let confirming = false;
    try {
      const preview = await previewOfficialUsageSetOperation(setId, "select");
      if (signal.aborted) return;
      if (preview.expectedRevision !== data.admin.activeRevision || preview.activeSetId !== data.admin.activeSetId) {
        throw new Error("The shared report selection changed.");
      }
      confirming = true;
      await confirmOfficialUsageSetOperation(preview);
      if (signal.aborted) return;
      setSelection(undefined);
      setReload(value => value + 1);
      onChanged(true);
    } catch (error) {
      if (signal.aborted) return;
      setSelection(undefined);
      setUnverifiedRead(readKey);
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setDeniedRead(readKey);
      const uncertain = confirming && (!(error instanceof ApiError) || error.status === 0 || error.status >= 500);
      setErrorMessage(`${error instanceof Error ? error.message : "Report selection could not be verified."} ${uncertain
        ? "The selection may have been saved. Retry to check its status."
        : "Retry to reload report sets before selecting again."}`);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  return <section className="usage-report-selector" aria-label="Report set selection" aria-busy={loading || busy}>
    <select aria-label="Report set" value={candidateId} disabled={disabled || count === 0}
      title={candidate ? reportSetLabel(candidate) : "Report set"}
      onChange={event => void selectReport(event.target.value)}>
      <option value="" disabled>{placeholder}</option>
      {activeId && !sets.some(set => set.id === activeId) ? <option value={activeId}>
        {active ? reportSetLabel(active) : `Current report ${activeId.slice(0, 8)} (outside this page)`} - selected
      </option> : null}
      {selection && selection !== activeId && !candidate ? <option value={selection} disabled>Report not on this page</option> : null}
      {sets.map(set => <option key={set.id} value={set.id}>{reportSetLabel(set)}{set.id === activeId ? " - selected" : ""}</option>)}
    </select>
    <span className="sr-only" role="status">{busy ? "Selecting report set..." : ""}</span>
    {data && (count > pageSize || offset > 0) ? <div className="usage-report-selector-pages">
      <button type="button" className="secondary" disabled={busy || offset === 0}
        onClick={() => { setSelection(undefined); setOffset(value => Math.max(0, value - pageSize)); }}>Newer report sets</button>
      <span>{sets.length ? `Report sets ${offset + 1}-${Math.min(offset + sets.length, count)} of ${count.toLocaleString()}`
        : "No report sets remain on this page. Use Newer report sets to return."}</span>
      <button type="button" className="secondary" disabled={busy || offset + pageSize >= count}
        onClick={() => { setSelection(undefined); setOffset(value => value + pageSize); }}>Older report sets</button>
    </div> : null}
    {read.isError || errorMessage ? <div className="report-status error" role="alert">
      {read.isError ? read.error.message : errorMessage}{" "}
      <button type="button" className="secondary" disabled={busy || loading}
        onClick={() => { setSelection(undefined); setErrorMessage(undefined); setReload(value => value + 1); onChanged(false); }}>Retry</button>
    </div> : null}
  </section>;
}

function reportSetLabel(set: OfficialUsageSetSummary) {
  const period = set.reportingPeriod;
  const dates = period.startDate && period.endDate ? `${period.startDate} to ${period.endDate}` : "No activity dates";
  const basis = period.provenance === "activity_range" ? "Observed activity" : "Reporting window";
  return `${basis}: ${dates} | ${set.id.slice(0, 8)}`;
}
