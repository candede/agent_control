import { useContext, useEffect, useEffectEvent, useState } from "react";
import type { ReportHistorySet, ReportListPage } from "../../../backend/src/types/officialReportData";
import { ApiError } from "../api/client";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { useBrowserAvailability } from "../useBrowserAvailability";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { usageCoverageLabel } from "../usageInsights";
import { ReportReadStatus } from "./ReportPageControls";
import "./officialUsage.css";

type Props = {
  principalKey: string;
  revision: number;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  onLatestReportObserved: (id: string | null, revision: string) => void;
};

export function OfficialUsageReportSelector(props: Props) {
  const scope = useReportPrincipalScope();
  const [deniedRetry, setDeniedRetry] = useState(0);
  return <Selector key={JSON.stringify([props.principalKey, scope, deniedRetry])} {...props}
    onRetryDenied={() => setDeniedRetry(attempt => attempt + 1)} />;
}

function reportLabel(set: ReportHistorySet) {
  const dates = set.reportingStart && set.reportingEnd ? `${set.reportingStart} to ${set.reportingEnd}` : "No activity dates";
  return `${set.periodProvenance === "activity_range" ? "Observed activity" : "Reporting window"}: ${dates} | ${set.id.slice(0, 8)}`;
}

function Selector({ revision, selectedId, onSelect, onLatestReportObserved, onRetryDenied }: Props & { onRetryDenied: () => void }) {
  const capability = useContext(CapabilityContext);
  const canRead = !capability || hasRole(capability.user, "AgentControl.Viewer");
  const available = useBrowserAvailability();
  const [denied, setDenied] = useState<ApiError>();
  const [notice, setNotice] = useState<string>();
  const selected = selectedId?.toLowerCase();
  const read = useReportPage<ReportHistorySet, ReportListPage<ReportHistorySet>>("official-usage/history/options",
    { sort: "reportingPeriod", order: "desc", setId: selected }, revision, canRead && !denied, undefined, false, true);
  if (!denied && read.error instanceof ApiError && [401, 403].includes(read.error.status)) setDenied(read.error);
  const data = denied || !canRead ? undefined : read.data;
  const { loading, error, isCurrentData } = read;
  const unavailable = Boolean(selected && error instanceof ApiError && error.code === "usage_report_unavailable");
  if (unavailable && notice === undefined) {
    setNotice("Your selected report is no longer available. Showing the latest available report instead.");
  }
  const select = useEffectEvent(onSelect);
  const observeLatest = useEffectEvent(onLatestReportObserved);
  const refresh = useEffectEvent(() => read.restart());

  useEffect(() => {
    if (unavailable) select(undefined);
  }, [unavailable]);
  useEffect(() => {
    if (data && !loading && !error && isCurrentData()) {
      observeLatest(data.reports.activeSetId, data.reports.activeRevision);
    }
  }, [data, loading, error, isCurrentData]);
  useEffect(() => {
    if (!available || !canRead || denied) return;
    const timer = window.setInterval(refresh, 60_000);
    const focus = () => refresh();
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [available, canRead, denied]);

  const latest = data?.value.find(set => set.id.toLowerCase() === data.reports.activeSetId?.toLowerCase());
  const chosen = data?.value.find(set => set.id.toLowerCase() === selected);
  const latestLabel = latest ? `Latest report - ${reportLabel(latest)}` : "Latest report";
  const currentLabel = chosen ? reportLabel(chosen) : data ? `${usageCoverageLabel(data.reports)} | ${selected?.slice(0, 8)}` : "Selected report";
  const disabled = !canRead || Boolean(denied) || read.loading || read.leaseEnded || !data || Boolean(read.error);
  function change(id: string) {
    if (disabled || !read.isCurrentData()) return;
    if (id === "older-reports" && data?.page.nextCursor) { read.next(); return; }
    if (id === "newer-reports" && data?.page.previousCursor) { read.previous(); return; }
    const next = id.toLowerCase() || undefined;
    if (next === selected || next && !data?.value.some(set => set.id.toLowerCase() === next)) return;
    setNotice(undefined);
    onSelect(next);
  }
  return <section className="usage-report-selector" aria-label="Report set selection" aria-busy={read.loading}>
    <select aria-label="Report set" value={selected ?? ""} disabled={disabled}
      title={`${selected ? currentLabel : latestLabel}. This changes only your Users and Agents view.`}
      onChange={event => change(event.target.value)}>
      <option value="">{!data ? read.loading ? "Loading report sets..." : "Latest report - report sets unavailable"
        : !data.counts.filtered ? "Latest report - no reports available" : latestLabel}</option>
      {selected && !chosen ? <option value={selected}>{currentLabel} (outside this page)</option> : null}
      {data?.value.map(set => <option key={set.id.toLowerCase()} value={set.id.toLowerCase()}>{reportLabel(set)}</option>)}
      {data?.page.previousCursor ? <option value="newer-reports">Newer report sets...</option> : null}
      {data?.page.nextCursor ? <option value="older-reports">Older report sets...</option> : null}
    </select>
    {notice ? <p role="status">{notice}</p> : null}
    {!canRead ? <p role="alert">Current Viewer access is required to read saved reports.</p> : null}
    <ReportReadStatus read={{ ...read, data, error: denied ?? read.error,
      retry: denied ? onRetryDenied : read.restart, restart: denied ? onRetryDenied : read.restart }} quietLoading />
  </section>;
}
