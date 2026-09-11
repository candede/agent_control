import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { Download, ExternalLink, Eye, Pause, Play, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { approveDefenderHuntingQualification, cancelDefenderHunt, deleteDefenderHunt, downloadDefenderHuntingCsv,
getDefenderHuntingCatalog, getDefenderHuntingJob, getDefenderHuntingJobs, getDefenderHuntingRows, resumeDefenderHunt, startDefenderHuntingQualification,
  submitDefenderHunt, revokeDefenderHuntingRetainedScope, type DefenderHuntingCatalog, type DefenderHuntingFilters, type DefenderHuntingJob, type DefenderHuntingRow,
  type DefenderHuntingRowPage, type DefenderHuntingTokenMode, type DefenderInventoryDetailState } from "../api/client";
import { hasRole } from "../authorization";
import { useCapabilityContext } from "../capabilityContext";
import { parseSecurityRoute, securityRouteSearch, workbenchUrl } from "../workbenchRouting";

const historyPageSize = 20;
const rowPageSize = 100;
const activeStatuses = new Set<DefenderHuntingJob["status"]>(["running"]);
const readableStatuses = new Set<DefenderHuntingJob["status"]>(["succeeded", "partial"]);

function capabilityKey(views: ReturnType<typeof useCapabilityContext>["views"]) {
  return views.filter(view => view.definition.id.startsWith("defender.hunting.")).map(view => [view.definition.id, view.decision.status,
    view.decision.authorized, view.decision.fresh, view.decision.checkedAt ?? "", view.decision.expiresAt ?? ""].join(":"))
    .sort().join("|");
}

export function DefenderHuntingView() {
  const capability = useCapabilityContext();
  const accountKey = `${capability.user?.tenantId ?? ""}:${capability.user?.homeAccountId ?? ""}`;
  return <DefenderHuntingSession key={`${accountKey}:${capabilityKey(capability.views)}`} />;
}

function DefenderHuntingSession() {
  const [initialRoute] = useState(() => parseSecurityRoute(window.location.search));
  const capability = useCapabilityContext();
  const generation = useRef(0);
  const actionGeneration = useRef(0);
  const approvalGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const catalogGeneration = useRef(0);
  const [catalog, setCatalog] = useState<DefenderHuntingCatalog>();
  const [jobs, setJobs] = useState<DefenderHuntingJob[]>([]);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [selected, setSelected] = useState<DefenderHuntingJob>();
  const [rows, setRows] = useState<DefenderHuntingRowPage>();
  const [rowOffset, setRowOffset] = useState(0);
  const [tokenMode, setTokenMode] = useState<DefenderHuntingTokenMode>(initialRoute.tokenMode ?? "delegated");
  const [templateId, setTemplateId] = useState<DefenderHuntingFilters["templateId"]>(initialRoute.templateId ?? "agents_inventory");
  const [operations, setOperations] = useState<string[]>(initialRoute.operations ?? []);
  const [startDateTime, setStartDateTime] = useState(() => initialRoute.startDateTime ?? localDateTime(new Date(Date.now() - 60 * 60_000)));
  const [endDateTime, setEndDateTime] = useState(() => initialRoute.endDateTime ?? localDateTime(new Date()));
  const [agentIds, setAgentIds] = useState(initialRoute.agentIds ?? "");
  const [blueprintIds, setBlueprintIds] = useState(initialRoute.blueprintIds ?? "");
  const [actorObjectIds, setActorObjectIds] = useState(initialRoute.actorObjectIds ?? "");
  const [routeJobId, setRouteJobId] = useState(initialRoute.jobId);
  const resolvedRouteJobId = useRef<string | undefined>(undefined);
  const [approvedJob, setApprovedJob] = useState<DefenderHuntingJob>();
  const [approvalAcknowledged, setApprovalAcknowledged] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const capabilityId = tokenMode === "delegated" ? "defender.hunting.delegated" : "defender.hunting.application";
  const capabilityView = capability.views.find(view => view.definition.id === capabilityId);
  const canQualify = hasRole(capability.user, "AgentControl.SecurityReader") && hasRole(capability.user, "AgentControl.Administrator");
  const filters = makeFilters({ templateId, startDateTime, endDateTime, agentIds, blueprintIds, actorObjectIds, operations });
  const qualification = filters && catalog?.qualifications.find(evidence => evidence.capabilityId === capabilityId
    && evidence.templateId === filters.templateId && equalQualificationScope(evidence.approvedScope, filters)
    && evidence.queryVersion === 3 && Date.parse(evidence.expiresAt) > capability.now);
  const retainedScope = filters && catalog?.retainedScopes.find(scope => scope.capabilityId === capabilityId
    && scope.templateId === filters.templateId && equalQualificationScope(scope.approvedScope, filters)
    && scope.queryVersion === 3 && scope.revokedAt === null && Date.parse(scope.expiresAt) > capability.now);
  const available = Boolean(qualification && retainedScope);
  const rangeError = rangeMessage(filters, catalog);
  const operationError = templateId !== "agents_inventory" && operations.length === 0 ? "Select at least one operation." : undefined;
  const qualificationTargetError = filters && !filters.agentIds.length && !filters.blueprintIds.length && !filters.actorObjectIds.length
    ? "Select at least one exact agent, blueprint, or actor object ID for qualification."
    : undefined;

  function invalidateApproval() {
    actionGeneration.current += 1;
    approvalGeneration.current += 1;
    setApprovedJob(undefined);
    setApprovalAcknowledged(false);
    setBusy(undefined);
  }

  function currentRequest(requestGeneration: number, requestAction: number) {
    return generation.current === requestGeneration && actionGeneration.current === requestAction;
  }

  async function loadHistory(offset = historyOffset, requestGeneration = generation.current, requestAction?: number) {
    const historyRequest = ++historyGeneration.current;
    const result = await getDefenderHuntingJobs(historyPageSize, offset);
    if (generation.current !== requestGeneration || historyGeneration.current !== historyRequest
      || (requestAction !== undefined && actionGeneration.current !== requestAction)) return;
    setJobs(result.value);
    setHistoryCount(result.count);
    setHistoryOffset(result.offset);
    setSelected(current => current ? result.value.find(job => job.id === current.id) ?? current : undefined);
  }

  async function loadCatalog(requestGeneration = generation.current, requestAction?: number) {
    const catalogRequest = ++catalogGeneration.current;
    const result = await getDefenderHuntingCatalog();
    if (generation.current !== requestGeneration || catalogGeneration.current !== catalogRequest
      || (requestAction !== undefined && actionGeneration.current !== requestAction)) return;
    setCatalog(result);
  }

  const pollHistory = useEffectEvent(async () => {
    const requestGeneration = generation.current;
    try { await Promise.all([loadHistory(undefined, requestGeneration), loadCatalog(requestGeneration)]); }
    catch (requestError) { if (generation.current === requestGeneration) setError(errorMessage(requestError)); }
  });
  const hasProgressingJobs = jobs.some(job => activeStatuses.has(job.status));

  useEffect(() => {
    const requestGeneration = ++generation.current;
    Promise.all([getDefenderHuntingCatalog(), getDefenderHuntingJobs(historyPageSize, 0)]).then(([catalogResult, history]) => {
      if (generation.current !== requestGeneration) return;
      setCatalog(catalogResult);
      setJobs(history.value);
      setHistoryCount(history.count);
      setHistoryOffset(history.offset);
    }).catch((requestError: unknown) => { if (generation.current === requestGeneration) setError(errorMessage(requestError)); });
    return () => { if (generation.current === requestGeneration) generation.current += 1; };
  }, []);

  useEffect(() => {
    const restoreRoute = () => {
      const route = parseSecurityRoute(window.location.search);
      resolvedRouteJobId.current = undefined;
      setRouteJobId(route.jobId);
      setTokenMode(route.tokenMode ?? "delegated");
      setTemplateId(route.templateId ?? "agents_inventory");
      setOperations(route.operations ?? []);
      if (route.startDateTime) setStartDateTime(route.startDateTime);
      if (route.endDateTime) setEndDateTime(route.endDateTime);
      setAgentIds(route.agentIds ?? "");
      setBlueprintIds(route.blueprintIds ?? "");
      setActorObjectIds(route.actorObjectIds ?? "");
      setSelected(current => current?.id === route.jobId ? current : undefined);
      setRows(undefined);
      setRowOffset(0);
      invalidateApproval();
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  useEffect(() => {
    const next = workbenchUrl("security", securityRouteSearch({
      jobId: routeJobId,
      tokenMode,
      templateId,
      operations,
      startDateTime,
      endDateTime,
      agentIds,
      blueprintIds,
      actorObjectIds,
    }));
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "security" }, "", next);
    }
  }, [actorObjectIds, agentIds, blueprintIds, endDateTime, operations, routeJobId, startDateTime, templateId, tokenMode]);

  useEffect(() => {
    if (!routeJobId) return;
    if (resolvedRouteJobId.current === routeJobId) return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    setSelected(undefined);
    setRows(undefined);
    setRowOffset(0);
    setError(undefined);
    void getDefenderHuntingJob(routeJobId, { signal: controller.signal })
      .then(job => {
        if (!controller.signal.aborted && generation.current === requestGeneration) setSelected(job);
      })
      .catch(requestError => {
        if (!controller.signal.aborted && generation.current === requestGeneration) {
          setError(`The exact Defender job is expired, deleted, or unavailable to this account. ${errorMessage(requestError)}`);
        }
      });
    return () => controller.abort();
  }, [routeJobId]);

  useEffect(() => {
    if (!hasProgressingJobs) return;
    let cancelled = false;
    let timer: number | undefined;
    const deadline = Date.now() + 5 * 60_000;
    const poll = async () => {
      await pollHistory();
      if (!cancelled && Date.now() < deadline) timer = window.setTimeout(() => void poll(), 1_500);
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [hasProgressingJobs]);

  async function perform(key: string, operation: (requestGeneration: number, requestAction: number) => Promise<void>) {
    const requestGeneration = generation.current;
    const requestAction = ++actionGeneration.current;
    setBusy(key);
    setError(undefined);
    try { await operation(requestGeneration, requestAction); }
    catch (requestError) { if (currentRequest(requestGeneration, requestAction)) setError(errorMessage(requestError)); }
    finally { if (currentRequest(requestGeneration, requestAction)) setBusy(undefined); }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!filters || rangeError || operationError) return;
    await perform("search", async (requestGeneration, requestAction) => {
      const job = await submitDefenderHunt(tokenMode, filters);
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(job); setRows(undefined); setRowOffset(0); await loadHistory(0, requestGeneration, requestAction);
    });
  }

  async function handleApprove() {
    if (!filters || rangeError || operationError) return;
    const approvalRequest = ++approvalGeneration.current;
    await perform("approve", async (requestGeneration, requestAction) => {
      const job = await approveDefenderHuntingQualification(tokenMode, filters);
      if (!currentRequest(requestGeneration, requestAction) || approvalGeneration.current !== approvalRequest) return;
      setApprovedJob(job); setApprovalAcknowledged(false); await loadHistory(0, requestGeneration, requestAction);
    });
  }

  async function handleStartQualification() {
    if (!approvedJob) return;
    const approvalRequest = approvalGeneration.current;
    await perform("qualification", async (requestGeneration, requestAction) => {
      const job = await startDefenderHuntingQualification(approvedJob.id);
      if (!currentRequest(requestGeneration, requestAction) || approvalGeneration.current !== approvalRequest) return;
      setApprovedJob(job); selectJob(job); setRows(undefined); setRowOffset(0); await loadHistory(0, requestGeneration, requestAction);
      if (job.status === "succeeded") await Promise.all([loadCatalog(requestGeneration, requestAction), capability.reload()]);
    });
  }

  async function handleRevokeRetainedScope() {
    if (!retainedScope || !window.confirm("Revoke saved Defender hunting access for this exact retained scope? Existing provider data is unchanged.")) return;
    await perform("revoke-scope", async (requestGeneration, requestAction) => {
      await revokeDefenderHuntingRetainedScope(retainedScope.id);
      if (!currentRequest(requestGeneration, requestAction)) return;
      setSelected(undefined); setRows(undefined); setRowOffset(0);
      await Promise.all([loadCatalog(requestGeneration, requestAction), loadHistory(0, requestGeneration, requestAction)]);
    });
  }

  async function handleView(job: DefenderHuntingJob, offset = 0) {
    if (offset === 0 && selected?.id !== job.id) selectJob(job);
    else setSelected(job);
    setRows(undefined); setRowOffset(0);
    await perform(`view:${job.id}`, async (requestGeneration, requestAction) => {
      const page = await getDefenderHuntingRows(job.id, rowPageSize, offset);
      if (!currentRequest(requestGeneration, requestAction)) return;
      setRows(page); setSelected(page.job); setRowOffset(offset);
    });
  }

  async function handleViewPrior(id: string) {
    setRows(undefined); setRowOffset(0);
    await perform(`view:${id}`, async (requestGeneration, requestAction) => {
      const page = await getDefenderHuntingRows(id, rowPageSize, 0);
      if (!currentRequest(requestGeneration, requestAction)) return;
      setRows(page); selectJob(page.job);
    });
  }

  async function handleResume(job: DefenderHuntingJob) {
    await perform(`resume:${job.id}`, async (requestGeneration, requestAction) => {
      const resumed = await resumeDefenderHunt(job.id);
      if (!currentRequest(requestGeneration, requestAction)) return;
      setSelected(resumed); setRows(undefined); setRowOffset(0); await loadHistory(historyOffset, requestGeneration, requestAction);
    });
  }

  async function handleCancel(job: DefenderHuntingJob) {
    await perform(`cancel:${job.id}`, async (requestGeneration, requestAction) => {
      const cancelled = await cancelDefenderHunt(job.id);
      if (!currentRequest(requestGeneration, requestAction)) return;
      setSelected(cancelled); setRows(undefined); setRowOffset(0); await loadHistory(historyOffset, requestGeneration, requestAction);
    });
  }

  async function handleDelete(job: DefenderHuntingJob) {
    if (!window.confirm("Delete this minimized local hunting cache? Defender source data is unchanged.")) return;
    await perform(`delete:${job.id}`, async (requestGeneration, requestAction) => {
      await deleteDefenderHunt(job.id);
      if (!currentRequest(requestGeneration, requestAction)) return;
      if (selected?.id === job.id) { setSelected(undefined); setRows(undefined); }
      if (routeJobId === job.id) selectJob(undefined);
      await loadHistory(historyOffset, requestGeneration, requestAction);
    });
  }

  async function handleExport(job: DefenderHuntingJob) {
    await perform(`export:${job.id}`, async (requestGeneration, requestAction) => {
      const blob = await downloadDefenderHuntingCsv(job.id);
      if (!currentRequest(requestGeneration, requestAction)) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `defender-hunting-${job.id}.csv`; document.body.append(anchor); anchor.click();
      window.setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url); }, 0);
    });
  }

  const selectedTemplate = catalog?.templates.find(template => template.id === templateId);
  const readiness = available ? "qualified_exact_scope" : "not_qualified_exact_scope";

  function selectJob(job: DefenderHuntingJob | undefined) {
    resolvedRouteJobId.current = job?.id;
    setSelected(job);
    setRouteJobId(job?.id);
    const next = workbenchUrl("security", securityRouteSearch({
      jobId: job?.id, tokenMode, templateId, operations, startDateTime, endDateTime,
      agentIds, blueprintIds, actorObjectIds,
    }));
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view: "security" }, "", next);
    }
  }

  return (
    <section className="defender-hunting" aria-label="Microsoft Defender hunting">
      <header className="hunting-heading">
        <div><p className="eyebrow">Microsoft Graph v1.0 / Defender advanced hunting</p><h2>Defender and Agent 365 hunting</h2>
          <p>Curated investigation metadata, separate from Purview audit and official usage.</p></div>
        <div className="hunting-heading-actions">
          <a className="secondary link-button" href={catalog?.defenderPortalUrl ?? "https://security.microsoft.com/v2/advanced-hunting"} target="_blank" rel="noreferrer">Defender portal <ExternalLink aria-hidden="true" /></a>
          <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh hunting history" title="Refresh hunting history" disabled={Boolean(busy)} onClick={() => void perform("refresh", (requestGeneration, requestAction) => Promise.all([loadHistory(historyOffset, requestGeneration, requestAction), loadCatalog(requestGeneration, requestAction)]).then(() => undefined))}><RefreshCw aria-hidden="true" /></button>
        </div>
      </header>

      {error ? <div className="error-banner" role="alert">{error}</div> : null}

      <section className="hunting-readiness" aria-label="Hunting readiness">
        <div><span>Provider authorization</span><strong>{statusLabel(readiness)}</strong><small>{tokenMode} / {qualification ? `proof expires ${formatDateTime(qualification.expiresAt)}` : "selected filters require current provider proof"}</small></div>
        <div><span>Saved-data scope</span><strong>{retainedScope ? "Approved" : "Not approved"}</strong><small>{retainedScope ? `expires ${formatDateTime(retainedScope.expiresAt)}` : "No current exact retained scope"}</small></div>
        <div><span>Source table</span><strong>{selectedTemplate?.sourceTable ?? "Not selected"}</strong><small>{selectedTemplate?.sourceTable === "AgentsInfo" ? "Preview table" : "Agent 365 activity metadata"}</small></div>
        <div><span>Provider prerequisites</span><strong>Not independently proven</strong><small>{available ? "Authorization qualified; verify connector, license, rollout and table separately" : "Verify connector, license, rollout and table separately"}</small></div>
        <div><span>Local retention</span><strong>30 days</strong><small>Provider retention is separate</small></div>
      </section>

      <div className="hunting-boundary" role="note"><ShieldCheck aria-hidden="true" /><span>{catalog?.contentNotice ?? "Messages and tool content are not retained or reconstructed."}</span></div>

      {retainedScope ? <section className="hunting-qualification" aria-label="Retained hunting scope"><div><strong>Exact saved-data scope approved</strong>
        <p>Saved history remains readable until {formatDateTime(retainedScope.expiresAt)} while this local approval, current role and configuration remain valid.</p></div>
        {canQualify ? <div className="hunting-qualification-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void handleRevokeRetainedScope()}><Trash2 aria-hidden="true" /> Revoke saved-data access</button></div> : null}
      </section> : null}

      <form className="hunting-form" onSubmit={handleSearch}>
        <div className="hunting-primary-fields">
          <label><span>Authorization</span><select value={tokenMode} onChange={event => { setTokenMode(event.target.value as DefenderHuntingTokenMode); invalidateApproval(); }}><option value="delegated">Delegated</option><option value="application">Application</option></select></label>
          <label><span>Fixed template</span><select value={templateId} onChange={event => {
            const next = event.target.value as DefenderHuntingFilters["templateId"];
            setTemplateId(next); setOperations(catalog?.templates.find(template => template.id === next)?.operations ?? []); invalidateApproval();
          }}>{(catalog?.templates ?? fallbackTemplates).map(template => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
          <label><span>Start</span><input type="datetime-local" step="1" value={startDateTime} onChange={event => { setStartDateTime(event.target.value); invalidateApproval(); }} required /></label>
          <label><span>End</span><input type="datetime-local" step="1" value={endDateTime} onChange={event => { setEndDateTime(event.target.value); invalidateApproval(); }} required /></label>
        </div>

        {selectedTemplate?.operations.length ? <fieldset className="hunting-operations"><legend>Documented operations</legend><div>{selectedTemplate.operations.map(operation => <label key={operation}><input type="checkbox" checked={operations.includes(operation)} onChange={event => { setOperations(current => event.target.checked ? [...current, operation].sort() : current.filter(value => value !== operation)); invalidateApproval(); }} /><span>{operation}</span></label>)}</div></fieldset> : null}

        <details className="hunting-filters"><summary>Typed identity filters</summary><div>
          <TextFilter label="Agent IDs" value={agentIds} onChange={value => { setAgentIds(value); invalidateApproval(); }} />
          <TextFilter label="Blueprint IDs" value={blueprintIds} onChange={value => { setBlueprintIds(value); invalidateApproval(); }} />
          {templateId !== "agents_inventory" ? <TextFilter label="Actor object IDs" value={actorObjectIds} onChange={value => { setActorObjectIds(value); invalidateApproval(); }} /> : null}
        </div></details>

        {rangeError || operationError || !available && qualificationTargetError
          ? <div className="error-banner" role="alert">{rangeError ?? operationError ?? qualificationTargetError}</div> : null}

        {!available ? <section className="hunting-qualification" aria-label="Hunting qualification required"><div><strong>Live hunting is not qualified</strong>
          {(capabilityView?.decision.remediation ?? ["Open Permissions to review the exact Defender hunting contract."]).map(item => <p key={item}>{item}</p>)}</div>
          <div className="hunting-qualification-actions"><button type="button" className="secondary" onClick={capability.openPermissions}>Open Permissions</button>
            {canQualify ? <label><input type="checkbox" checked={approvalAcknowledged} onChange={event => setApprovalAcknowledged(event.target.checked)} /><span>Approve one bounded fixed-template provider query</span></label> : null}
            {canQualify ? <button type="button" disabled={!approvalAcknowledged || !filters || Boolean(rangeError || operationError || qualificationTargetError || busy)} onClick={() => void handleApprove()}><ShieldCheck aria-hidden="true" /> Approve qualification</button> : null}
            {approvedJob?.qualification && approvedJob.status === "waiting_authorization" ? <button type="button" disabled={Boolean(busy)} onClick={() => void handleStartQualification()}><Play aria-hidden="true" /> Run approved qualification</button> : null}
          </div></section> : null}

        <div className="hunting-search-actions"><WorkbenchActionGate actionId="defender.search"><button type="submit" disabled={!available || !filters || Boolean(rangeError || operationError || busy)}><Search aria-hidden="true" /> Run hunt</button></WorkbenchActionGate>
          <span>{available ? "Current qualification evidence permits an explicit hunt." : "Provider requests remain disabled until one approved qualification succeeds."}</span></div>
      </form>

      <section className="hunting-history" aria-labelledby="hunting-history-title"><header><div><h3 id="hunting-history-title">Hunting history</h3><p>Delegated results remain principal-private. Application results use only the current approved shared scope.</p></div><span>{historyCount.toLocaleString()} jobs</span></header>
        {jobs.length === 0 ? <div className="compact-empty-state"><strong>No hunting history</strong><span>Opening this view does not run a provider query.</span></div>
          : <HistoryTable jobs={jobs} selectedId={selected?.id} busy={Boolean(busy)} onView={handleView} onResume={handleResume} onCancel={handleCancel} onDelete={handleDelete} onExport={handleExport} />}
        {historyCount > historyPageSize ? <div className="hunting-page-actions"><button type="button" className="secondary" disabled={Boolean(busy) || historyOffset === 0}
          onClick={() => void perform("history:previous", (requestGeneration, requestAction) => loadHistory(Math.max(0, historyOffset - historyPageSize), requestGeneration, requestAction))}>Previous</button>
          <span>{historyOffset + 1}-{Math.min(historyOffset + jobs.length, historyCount)} of {historyCount}</span>
          <button type="button" className="secondary" disabled={Boolean(busy) || historyOffset + jobs.length >= historyCount}
            onClick={() => void perform("history:next", (requestGeneration, requestAction) => loadHistory(historyOffset + historyPageSize, requestGeneration, requestAction))}>Next</button></div> : null}
      </section>

      {selected ? <HuntingDetail job={selected} rows={rows} rowOffset={rowOffset} busy={Boolean(busy)}
        onPageChange={offset => void handleView(selected, offset)} onViewPrior={id => void handleViewPrior(id)} /> : null}
    </section>
  );
}

function TextFilter({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label><span>{label}</span><textarea rows={2} value={value} onChange={event => onChange(event.target.value)} placeholder="One exact ID per line" /></label>;
}

function HistoryTable({ jobs, selectedId, busy, onView, onResume, onCancel, onDelete, onExport }: { jobs: DefenderHuntingJob[]; selectedId?: string; busy: boolean;
  onView: (job: DefenderHuntingJob) => Promise<void>; onResume: (job: DefenderHuntingJob) => Promise<void>; onCancel: (job: DefenderHuntingJob) => Promise<void>;
  onDelete: (job: DefenderHuntingJob) => Promise<void>; onExport: (job: DefenderHuntingJob) => Promise<void> }) {
  return <div className="table-shell hunting-history-table" role="region" aria-label="Defender hunting history"><table><thead><tr><th>Template / source</th><th>Requested range</th><th>Status</th><th>Coverage</th><th>Rows</th><th>Observed</th><th>Actions</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id} className={selectedId === job.id ? "selected-row" : undefined}>
    <td><strong>{templateLabel(job.filters.templateId)}</strong><small>{job.filters.templateId === "agents_inventory" ? "AgentsInfo preview" : "CloudAppEvents"}</small></td>
    <td>{formatDateTime(job.filters.startDateTime)}<small>to {formatDateTime(job.filters.endDateTime)}</small></td>
    <td><span className={`status ${statusClass(job.status)}`}>{statusLabel(job.status)}</span><small>{job.errorCode ?? `${job.tokenMode} / ${job.resultScope.kind}`}</small></td>
    <td>{job.complete ? "Requested interval completed" : job.status === "partial" ? "Incomplete interval" : "Not published"}</td>
    <td>{job.storedRowCount.toLocaleString()}<small>{job.providerRowCount.toLocaleString()} provider rows</small></td>
    <td>{job.finishedAt ? formatDateTime(job.finishedAt) : "Pending"}<small>expires {formatDateTime(job.expiresAt)}</small></td>
    <td><div className="hunting-row-actions">{readableStatuses.has(job.status) ? <IconAction label={`View hunt ${shortId(job.id)}`} title="View minimized rows" disabled={busy} onClick={() => void onView(job)}><Eye /></IconAction> : null}
      {job.canResume ? <IconAction label={`Resume hunt ${shortId(job.id)}`} title="Resume with current authorization" disabled={busy} onClick={() => void onResume(job)}><Play /></IconAction> : null}
      {activeStatuses.has(job.status) ? <IconAction label={`Cancel hunt ${shortId(job.id)}`} title="Cancel local execution" disabled={busy} onClick={() => void onCancel(job)}><Pause /></IconAction> : null}
      {readableStatuses.has(job.status) ? <IconAction label={`Export hunt ${shortId(job.id)}`} title="Export minimized CSV" disabled={busy} onClick={() => void onExport(job)}><Download /></IconAction> : null}
      {!activeStatuses.has(job.status) ? <IconAction label={`Delete hunt ${shortId(job.id)}`} title="Delete local cache" disabled={busy} onClick={() => void onDelete(job)}><Trash2 /></IconAction> : null}</div></td>
  </tr>)}</tbody></table></div>;
}

function HuntingDetail({ job, rows, rowOffset, busy, onPageChange, onViewPrior }: { job: DefenderHuntingJob; rows?: DefenderHuntingRowPage; rowOffset: number; busy: boolean;
  onPageChange: (offset: number) => void; onViewPrior: (id: string) => void }) {
  return <section className="hunting-results" aria-labelledby="hunting-results-title"><header><div><h3 id="hunting-results-title">{templateLabel(job.filters.templateId)} result</h3>
    <p>{job.filters.templateId === "agents_inventory" ? "Defender AgentsInfo preview snapshot. Package and Power Platform authority remain separate." : "Agent 365 CloudAppEvents investigation metadata. Child spans are not reconstructed into conversations."}</p></div>
    <span>{job.storedRowCount.toLocaleString()} rows</span></header>
    <div className="hunting-result-facts"><div><span>Source</span><strong>{rows?.snapshot.sourceTable ?? (job.filters.templateId === "agents_inventory" ? "AgentsInfo preview" : "CloudAppEvents")}</strong></div>
      <div><span>Result scope</span><strong>{job.resultScope.kind} / {job.resultScope.scopeId}</strong></div>
      <div><span>Requested range</span><strong>{formatRange(job.filters.startDateTime, job.filters.endDateTime)}</strong></div>
      <div><span>Observed range</span><strong>{job.observedRange ? formatRange(job.observedRange.startDateTime, job.observedRange.endDateTime) : "Not observed"}</strong></div>
      <div><span>Unobserved range</span><strong>{job.unobservedRange ? formatRange(job.unobservedRange.startDateTime, job.unobservedRange.endDateTime) : "None reported"}</strong></div>
      <div><span>Query contract</span><strong>Version {job.queryVersion}</strong></div>
      <div><span>Correlation</span><strong>{job.localRequestId}<small>{job.providerRequestId ?? "Provider request ID not supplied"}</small></strong></div>
      <div><span>Authorizing actor</span><strong>{job.qualification?.approvedBy ?? job.authorizationPrincipalId}</strong></div>
      <div><span>Freshness</span><strong>{rows ? formatDateTime(rows.snapshot.observationTime) : job.finishedAt ? formatDateTime(job.finishedAt) : "Pending"}<small>expires {formatDateTime(job.expiresAt)}</small></strong></div>
      <div><span>Typed filters</span><strong>{filterSummary(job.filters)}</strong></div>
      <div><span>Coverage</span><strong>{job.complete ? "Complete bounded request" : job.partialReason === "hunting_row_limit" ? "Row cap reached" : "Not complete"}</strong></div>
      <div><span>Execution</span><strong>{statusLabel(job.status)}<small>{job.providerRequestCount} provider requests / {job.activationCount} activations</small></strong></div></div>
    {job.noData ? <div className="hunting-no-data"><strong>No data returned</strong><span>The request succeeded, but this does not prove complete tenant coverage or identify a missing permission, connector, license or table.</span></div> : null}
    {job.status === "partial" ? <div className="warning-banner">The 200-row local cap was reached. The requested interval remains incompletely observed; no complete total is claimed.</div> : null}
    {job.priorSuccessfulJobId && !readableStatuses.has(job.status) ? <div className="hunting-prior-result"><span>This attempt did not replace the prior successful minimized result.</span>
      <button type="button" className="secondary" disabled={busy} onClick={() => onViewPrior(job.priorSuccessfulJobId!)}><Eye aria-hidden="true" /> View prior successful result</button></div> : null}
    {rows?.value.length ? <ResultTable value={rows.value} /> : !job.noData && readableStatuses.has(job.status) ? <button type="button" className="secondary" disabled={busy} onClick={() => onPageChange(0)}><Eye aria-hidden="true" /> Load minimized rows</button> : null}
    {rows && rows.count > rowPageSize ? <div className="hunting-page-actions"><button type="button" className="secondary" disabled={busy || rowOffset === 0} onClick={() => onPageChange(Math.max(0, rowOffset - rowPageSize))}>Previous</button>
      <span>{rowOffset + 1}-{Math.min(rowOffset + rows.value.length, rows.count)} of {rows.count}</span><button type="button" className="secondary" disabled={busy || rowOffset + rows.value.length >= rows.count} onClick={() => onPageChange(rowOffset + rowPageSize)}>Next</button></div> : null}
  </section>;
}

function ResultTable({ value }: { value: DefenderHuntingRow[] }) {
  const inventory = value[0]?.sourceTable === "AgentsInfo";
  return <div className="table-shell hunting-results-table" role="region" aria-label="Minimized hunting rows" tabIndex={0}><table><thead><tr>{inventory ? <><th>Observed</th><th>Agent</th><th>Platform / lifecycle</th><th>Exact identities</th><th>Bounded metadata</th><th>Association</th></> : <><th>Time</th><th>Operation</th><th>Agent / app</th><th>Actor</th><th>Span</th><th>Tool / result</th><th>Association</th></>}</tr></thead><tbody>{value.map((row, index) => row.sourceTable === "AgentsInfo" ? <tr key={`${row.agentId}:${index}`}><td>{formatDateTime(row.observationTime)}</td><td><strong>{display(row.agentName)}</strong><small>{row.agentId}</small></td>
    <td>{display(row.platform)}<small>{display(row.lifecycleStatus)} / {display(row.publishedStatus)}</small></td><td><code>{display(row.entraAgentObjectId)}</code><small>Blueprint: {display(row.entraBlueprintId)}</small></td>
    <td>{inventoryDetail("Owners", row.detailStates.owners, row.ownerCount)}<small>{inventoryDetail("Permissions", row.detailStates.permissions, row.permissionMetadataKeyCount)}; {inventoryDetail("Authentication", row.detailStates.authentication, row.authenticationMetadataKeyCount)}; {inventoryDetail("Risk", row.detailStates.risk)}</small></td><td>{associationLabel(row.association)}</td></tr>
    : <tr key={`${row.reportId ?? row.spanId ?? index}:${index}`}><td>{formatDateTime(row.timestamp)}</td><td><strong>{row.actionType}</strong><small>{display(row.operation)}</small></td><td>{display(row.targetAgentName ?? row.agentName)}<small>{display(row.targetAgentId ?? row.agentId)} / {display(row.cloudApplication)}</small></td>
      <td><code>{display(row.actorAccountObjectId)}</code><small>{display(row.actorProviderAccountId)}</small></td><td><code>{display(row.spanId)}</code><small>{row.rootSpanObserved ? "Observed root span metadata" : row.parentSpanId ? `Child of ${row.parentSpanId}` : "Root span not observed"}</small></td>
      <td>{display(row.toolName ?? row.errorType)}<small>{row.outcome} / {statusLabel(row.spanRole)} / {row.durationMilliseconds === null ? "duration not supplied" : `${row.durationMilliseconds} ms`}; content absent</small></td><td>{associationLabel(row.association)}</td></tr>)}</tbody></table></div>;
}

function IconAction({ children, disabled, label, onClick, title }: { children: React.ReactNode; disabled: boolean; label: string; onClick: () => void; title: string }) {
  return <button type="button" className="secondary icon-button control-icon-button" aria-label={label} title={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

function makeFilters(value: { templateId: DefenderHuntingFilters["templateId"]; startDateTime: string; endDateTime: string; agentIds: string; blueprintIds: string; actorObjectIds: string; operations: string[] }): DefenderHuntingFilters | undefined {
  const start = toUtc(value.startDateTime); const end = toUtc(value.endDateTime);
  if (!start || !end) return undefined;
  return { templateId: value.templateId, startDateTime: start, endDateTime: end, agentIds: lines(value.agentIds), blueprintIds: lines(value.blueprintIds),
    actorObjectIds: value.templateId === "agents_inventory" ? [] : lines(value.actorObjectIds), operations: [...value.operations].sort() };
}

function rangeMessage(filters: DefenderHuntingFilters | undefined, catalog?: DefenderHuntingCatalog) {
  if (!filters) return "Enter valid start and end times.";
  const duration = Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime);
  if (duration <= 0) return "End must be after start.";
  if (duration > (catalog?.limits.maximumWindowHours ?? 168) * 60 * 60_000) return "The selected range exceeds the bounded hunting window.";
  return undefined;
}

function lines(value: string) { return [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))].sort(); }
function equalQualificationScope(approved: Omit<DefenderHuntingFilters, "startDateTime" | "endDateTime">, filters: DefenderHuntingFilters) {
  return approved.templateId === filters.templateId && equalStrings(approved.agentIds, filters.agentIds) && equalStrings(approved.blueprintIds, filters.blueprintIds)
    && equalStrings(approved.actorObjectIds, filters.actorObjectIds) && equalStrings(approved.operations, filters.operations);
}
function equalStrings(left: string[], right: string[]) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function toUtc(value: string) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined; }
function localDateTime(value: Date) { const offset = value.getTimezoneOffset() * 60_000; return new Date(value.getTime() - offset).toISOString().slice(0, 19); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatRange(startDateTime: string, endDateTime: string) { return `${formatDateTime(startDateTime)} to ${formatDateTime(endDateTime)}`; }
function filterSummary(filters: DefenderHuntingFilters) { const values = [...filters.agentIds.map(value => `agent ${value}`), ...filters.blueprintIds.map(value => `blueprint ${value}`),
  ...filters.actorObjectIds.map(value => `actor ${value}`), ...filters.operations.map(value => `operation ${value}`)]; return values.length ? values.join("; ") : "No target filters"; }
function inventoryDetail(label: string, state: DefenderInventoryDetailState, count?: number | null) { return state === "empty" ? `${label}: empty` : state === "not_exposed" ? `${label}: not exposed`
  : state === "present_unqualified_shape" ? `${label}: present, shape not qualified` : count === null || count === undefined ? `${label}: not supplied` : `${label}: ${count}`; }
function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}...` : value; }
function display(value: string | null | undefined) { return value === null || value === undefined || value === "" ? "Not supplied" : value; }
function templateLabel(value: DefenderHuntingFilters["templateId"]) { return value === "agents_inventory" ? "Defender agent inventory" : value === "agent_tools" ? "Agent tool activity" : "Agent activity"; }
function associationLabel(value: DefenderHuntingRow["association"]) { return value?.status === "resolved" ? `Exact ${value.matchedKind}` : value?.status === "ambiguous" ? "Ambiguous exact ID" : value?.reason === "blueprint_is_parent_not_equivalence" ? "Blueprint parent only" : "Unmatched source record"; }
function statusLabel(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase()); }
function statusClass(value: DefenderHuntingJob["status"] | string) { return value === "succeeded" || value === "available" ? "success" : value === "running" || value === "waiting_authorization" || value === "unknown" ? "pending" : value === "partial" || value === "inconclusive" ? "warning" : "failure"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Hunting request failed."; }

const fallbackTemplates: DefenderHuntingCatalog["templates"] = [
  { id: "agents_inventory", label: "Defender agent inventory", sourceTable: "AgentsInfo", operations: [] },
  { id: "agent_activity", label: "Agent activity", sourceTable: "CloudAppEvents", operations: ["InvokeAgent", "InferenceCall"] },
  { id: "agent_tools", label: "Agent tool activity", sourceTable: "CloudAppEvents", operations: ["ExecuteToolBySDK", "ExecuteToolByGateway", "ExecuteToolByMCPServer"] },
];