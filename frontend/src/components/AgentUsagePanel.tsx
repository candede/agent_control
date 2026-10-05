import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CandidateAgentUsageSummary, CandidateAgentUsageAssociations, CandidateAgentUsageCandidates, CandidateAgentUsageMutation } from "../../../backend/src/types/officialReportApi";
import type { AgentUsageTarget } from "../../../backend/src/types/agentUsageTarget";
import type { InventoryReportContext, UnifiedAgentRecord } from "../../../backend/src/types/unifiedAgents";
import { readAgentReportSummary, readAgentReportAssociations, readAgentReportCandidates, mutateAgentReportAssociation } from "../api/reportData";
import { ApiError } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { useSavedQuery } from "../savedQueries";
import { usageCount, usageDate } from "../usageInsights";
import { ReportPageControls } from "./ReportPageControls";
import { ReportAgentDetail } from "./ReportingView";
import { UsageReportContext } from "./UsageReportContext";
import { WorkbenchActionGate } from "../workbenchActionContext";
import "./agentInsights.css";

type Props = { record: UnifiedAgentRecord; context?: InventoryReportContext; inventoryRevision?: string; dataRevision?: number;
  canRemoveReviewedAssociations: boolean; disabled?: boolean; onChanged?: () => void };
export function AgentUsagePanel(props: Props) {
  const capability = useContext(CapabilityContext), user = capability?.user;
  const principalScope = JSON.stringify([user?.tenantId, user?.homeAccountId, user?.roles]);
  if (capability && !hasRole(user, "AgentControl.Viewer")) return <p role="alert">Current Viewer access is required to read agent usage.</p>;
  const readScope = JSON.stringify([principalScope, props.record.id, props.context?.revision, props.context?.reports.setId, props.inventoryRevision]);
  return <ExactAgentUsage key={readScope} principalScope={readScope} {...props}
    canRemoveReviewedAssociations={props.canRemoveReviewedAssociations && (!capability || hasRole(user, "AgentControl.Admin"))} />;
}
function ExactAgentUsage({ record, context: inventoryContext, dataRevision = 0, canRemoveReviewedAssociations: canManage, disabled, onChanged, principalScope }: Props & { principalScope: string }) {
  const [reload, setReload] = useState(0), [cursor, setCursor] = useState<string>();
  const [capturedSelection, setCapturedSelection] = useState<string>();
  const [detail, setDetail] = useState<string | null>(), [linking, setLinking] = useState(false);
  const [remove, setRemove] = useState<{ row: CandidateAgentUsageAssociations["value"][number]; context: CandidateAgentUsageSummary["context"] }>();
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState<{ message: string; invalidated: boolean }>(), [busy, setBusy] = useState(false);
  const [confirmationVersion, setConfirmationVersion] = useState({ revision: dataRevision, disabled: Boolean(disabled) });
  const removalTrigger = useRef<HTMLButtonElement>(null), confirmationHeading = useRef<HTMLHeadingElement>(null);
  const restoreRemovalFocus = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useLayoutEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, [dataRevision, disabled]);
  useEffect(() => { if (remove) confirmationHeading.current?.focus(); }, [remove]);
  useLayoutEffect(() => {
    if (remove) restoreRemovalFocus.current = true;
    else if (!disabled && restoreRemovalFocus.current) {
      removalTrigger.current?.focus(); restoreRemovalFocus.current = false;
    }
  }, [disabled, remove]);
  if (confirmationVersion.revision !== dataRevision || confirmationVersion.disabled !== Boolean(disabled)) {
    setConfirmationVersion({ revision: dataRevision, disabled: Boolean(disabled) });
    setRemove(undefined); setConfirmed(false); setLinking(false); setBusy(false);
  }
  const summary = useSavedQuery<CandidateAgentUsageSummary>({
    queryKey: ["saved", "exact-inventory-report", principalScope, record.id, reload, dataRevision], gcTime: 0,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principalScope && previousQuery.queryKey[4] === reload ? previous : undefined,
    queryFn: async ({ signal }) => {
      const setId = inventoryContext?.reports.setId ?? undefined;
      const value = await readAgentReportSummary(record.id, { selectionId: capturedSelection, setId }, signal);
      if (value.recordId !== record.id || value.context.reportSetId !== value.context.reports.setId
        || setId !== undefined && value.context.reportSetId !== setId
        || capturedSelection !== undefined && value.context.selectionId !== capturedSelection) {
        throw new ApiError(409, "selection_invalidated", "Exact agent evidence does not match the requested report selection.");
      }
      return value;
    },
  });
  if (summary.data && !summary.isError && capturedSelection !== summary.data.context.selectionId) setCapturedSelection(summary.data.context.selectionId);
  const context = summary.data?.context, selectionId = context?.selectionId;
  const associations = useSavedQuery<CandidateAgentUsageAssociations>({
    queryKey: ["saved", "exact-inventory-associations", principalScope, record.id, selectionId, cursor, dataRevision], gcTime: 0, enabled: Boolean(selectionId) && !summary.isError,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principalScope
      && previousQuery.queryKey[4] === selectionId && previousQuery.queryKey[5] === cursor ? previous : undefined,
    queryFn: ({ signal }) => readAgentReportAssociations(record.id, { selectionId: selectionId!, cursor, limit: 50 }, signal),
  });
  const refetchSummary = summary.refetch, refetchAssociations = associations.refetch;
  useEffect(() => {
    const revalidate = () => { void refetchSummary({ cancelRefetch: false }); if (selectionId) void refetchAssociations({ cancelRefetch: false }); };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [refetchSummary, refetchAssociations, selectionId]);
  const changed = Boolean(context && associations.data && (["selectionId", "reportSetId", "usageRevision", "inventoryRevision"] as const)
    .some(field => context[field] !== associations.data!.context[field])) || Boolean(summary.data && summary.data.recordId !== record.id);
  const unavailable = summary.isError || associations.isError || changed || error?.invalidated;
  const singleAutomatic = !unavailable && summary.data?.status === "linked" && summary.data.associationCount === 1
    && associations.data?.counts.total === 1 && associations.data.value.length === 1
    && associations.data.value[0].basis === "exact_package_id" ? associations.data.value[0].reportAgentId : undefined;
  const selectedDetail = detail === undefined ? singleAutomatic : detail;
  function restartUsage() {
    setCursor(undefined); setDetail(undefined); setRemove(undefined); setLinking(false); setError(undefined);
    setCapturedSelection(undefined); setReload(value => value + 1);
  }
  async function saveRemoval() {
    if (!remove || !confirmed || unavailable || !canManage || disabled) return;
    setBusy(true); setError(undefined);
    const signal = lifetime.current?.signal;
    try {
      const input: CandidateAgentUsageMutation = { selectionId: remove.context.selectionId, reportSetId: remove.context.reportSetId,
        usageRevision: remove.context.usageRevision, inventoryRevision: remove.context.inventoryRevision, reportAgentId: remove.row.reportAgentId, confirmed: true };
      await mutateAgentReportAssociation(record.id, input, "remove", signal);
      if (!signal?.aborted) { restartUsage(); onChanged?.(); }
    } catch (cause) {
      if (!signal?.aborted) setError({ message: cause instanceof Error ? cause.message : "Association removal failed.",
        invalidated: cause instanceof ApiError && [401, 403, 409].includes(cause.status) });
    } finally { if (!signal?.aborted) setBusy(false); }
  }
  return <section className="agent-usage-insights" aria-label={`Usage and users for ${record.displayName}`}><h3>Usage &amp; users</h3>
    {summary.isFetching ? <p role="status">Loading exact agent report evidence...</p> : null}
    {unavailable ? <p role="alert">{changed ? "Exact source references or reviewed associations changed. Restart before reviewing this evidence." : summary.error?.message ?? associations.error?.message ?? error?.message}
      <button type="button" onClick={restartUsage}>Restart usage selection</button></p> : null}
    {context && !unavailable ? <UsageReportContext reports={context.reports} /> : null}
    {summary.data && !unavailable ? <><dl className="agent-usage-metrics" aria-label="Selected agent report metrics">
      <div><dt>Responses</dt><dd>{usageCount(summary.data.responses)}</dd></div><div><dt>Active users</dt><dd>{usageCount(summary.data.activeUsers)}</dd></div>
      <div><dt>Last reported activity</dt><dd>{usageDate(summary.data.lastActivityDateUtc)}</dd></div></dl>
      {summary.data.status !== "linked" ? <p>This agent has no linked evidence in the selected report. Unknown is not zero.</p> : null}</> : null}
    <section aria-label="Report links"><h4>Reported agent identities</h4><ul>{!unavailable ? associations.data?.value.map(row => <li key={row.reportAgentId}>
      <button type="button" onClick={() => setDetail(row.reportAgentId)}>{row.agentName || row.reportAgentId}</button><code>{row.reportAgentId}</code>
      <small>{row.basis}; target {row.target.source === "graph_packages" ? row.target.packageId : row.target.nativeId}; snapshot {row.target.snapshotId}</small>
      {canManage && row.basis === "reviewed" ? <WorkbenchActionGate actionId="agentUsage.remove" compact><button type="button" disabled={disabled || busy}
        onClick={event => { removalTrigger.current = event.currentTarget; if (context) setRemove({ row, context }); setConfirmed(false); }}>Remove reviewed association</button></WorkbenchActionGate> : null}</li>) : null}</ul>
      <ReportPageControls data={unavailable ? undefined : associations.data} loading={associations.isFetching} label="report links"
        previous={() => setCursor(associations.data?.page.previousCursor ?? undefined)} next={() => setCursor(associations.data?.page.nextCursor ?? undefined)} /></section>
    {selectedDetail && selectionId && !unavailable ? <ReportAgentDetail key={selectionId + selectedDetail} agentId={selectedDetail} selectionId={selectionId}
      revision={dataRevision} onClose={() => setDetail(null)} onRestartSelection={restartUsage} /> : null}
    {canManage && context?.reportSetId && !unavailable && !singleAutomatic ? <button type="button" disabled={disabled || busy} onClick={() => setLinking(value => !value)}>Review report association</button> : null}
    {linking && !unavailable ? <LinkReportAgent record={record} principalScope={principalScope} disabled={disabled} onChanged={() => { setLinking(false); setReload(value => value + 1); onChanged?.(); }} /> : null}
    {remove && !unavailable ? <section aria-label="Confirm association removal"><h4 ref={confirmationHeading} tabIndex={-1}>Remove reviewed association for {remove.row.agentName}?</h4>
      <p>This does not delete the official report. Review applies only to the exact current source fingerprint.</p>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm this exact report association removal</label>
      <button type="button" disabled={!confirmed || busy || disabled} onClick={() => void saveRemoval()}>Confirm removal</button>
      <button type="button" disabled={busy} onClick={() => { setRemove(undefined); removalTrigger.current?.focus(); }}>Cancel removal</button></section> : null}
    {error && !error.invalidated ? <p role="alert">{error.message}</p> : null}
  </section>;
}
function LinkReportAgent({ record, disabled, onChanged, principalScope }: { record: UnifiedAgentRecord; disabled?: boolean; onChanged: () => void; principalScope: string }) {
  const [search, setSearch] = useState(""), [navigation, setNavigation] = useState<{ key: string; cursor?: string; selectionId?: string; inventoryRevision?: string }>({ key: "" });
  const [restart, setRestart] = useState(0);
  const [candidate, setCandidate] = useState<{ row: CandidateAgentUsageCandidates["value"][number]; context: CandidateAgentUsageCandidates["context"] }>();
  const [source, setSource] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  const page = navigation.key === search ? navigation : { key: search };
  const read = useSavedQuery<CandidateAgentUsageCandidates>({
    queryKey: ["saved", "usage-candidates", principalScope, record.id, restart, search, page.cursor, page.selectionId, page.inventoryRevision], gcTime: 0,
    queryFn: ({ signal }) => readAgentReportCandidates(record.id, {
      search: search || undefined, selectionId: page.selectionId, cursor: page.cursor, limit: 50, inventoryRevision: page.inventoryRevision,
    }, signal),
  });
  const targets: AgentUsageTarget[] = [...record.packages.map(item => ({ source: "graph_packages" as const, packageId: item.id })),
    ...(record.powerPlatformResource ? [{ source: "power_platform" as const, nativeId: record.powerPlatformResource.nativeId, environmentId: record.powerPlatformResource.environmentId }] : [])];
  const targetKey = (target: AgentUsageTarget) => JSON.stringify(target.source === "graph_packages"
    ? [target.source, target.packageId] : [target.source, target.environmentId, target.nativeId]);
  function move(cursor: string | null) {
    if (cursor && read.data) {
      setNavigation({ key: search, cursor, selectionId: read.data.selection.id, inventoryRevision: read.data.context.inventoryRevision });
      setCandidate(undefined); setConfirmed(false);
    }
  }
  async function save() {
    const context = candidate?.context, target = targets.find(item => targetKey(item) === source);
    if (!candidate || !context || !target || !confirmed || read.isError || disabled || busy) return;
    setBusy(true);
    try {
      const input: CandidateAgentUsageMutation = { selectionId: context.selectionId, reportSetId: context.reportSetId,
        usageRevision: context.usageRevision, inventoryRevision: context.inventoryRevision, reportAgentId: candidate.row.agentId, target, confirmed: true };
      await mutateAgentReportAssociation(record.id, input, "associate", lifetime.current?.signal);
      if (!lifetime.current?.signal.aborted) onChanged();
    } catch (cause) { if (!lifetime.current?.signal.aborted) setError(cause instanceof Error ? cause.message : "Association failed."); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  }
  return <section aria-label="Review exact report association"><label>Search report candidates<input type="search" value={search} maxLength={256}
    onChange={event => { setSearch(event.target.value); setCandidate(undefined); setConfirmed(false); }} /></label>
    {read.error ? <p role="alert">{read.error.message}<button type="button" onClick={() => {
      setNavigation({ key: search }); setRestart(value => value + 1); setCandidate(undefined); setConfirmed(false);
    }}>Restart candidates</button></p> : <ul>{read.data?.value.map(row => <li key={row.agentId}>
      <button type="button" disabled={row.associated || busy || disabled} onClick={() => { if (read.data) setCandidate({ row, context: read.data.context }); setConfirmed(false); }}>{row.agentName || row.agentId}</button>
      {row.associated ? "Already reviewed" : null}<small>{row.agentId}; {usageCount(row.responses)} responses</small></li>)}</ul>}
    <ReportPageControls data={read.isError ? undefined : read.data} loading={read.isFetching} label="candidates" next={() => move(read.data?.page.nextCursor ?? null)} previous={() => move(read.data?.page.previousCursor ?? null)} />
    {candidate && !read.isError ? <><p>Report {candidate.row.agentId}: {candidate.row.agentName}</p><label>Exact inventory source<select value={source} onChange={event => { setSource(event.target.value); setConfirmed(false); }}>
      <option value="">Choose a verified source</option>{targets.map(target => <option key={targetKey(target)} value={targetKey(target)}>{target.source}: {target.source === "graph_packages" ? target.packageId : `${target.environmentId ?? ""}/${target.nativeId}`}</option>)}</select></label>
      <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm these exact identities represent the same agent</label>
      <button type="button" disabled={!confirmed || source === "" || busy || disabled} onClick={() => void save()}>Confirm association</button></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
