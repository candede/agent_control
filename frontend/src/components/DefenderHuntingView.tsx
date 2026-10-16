import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type FormEvent } from "react";
import { Download, Eye, Pause, Play, RefreshCw, Search, Trash2 } from "lucide-react";
import { defenderHuntingTemplateIds, defenderHuntingTemplates } from "../../../backend/src/types/defenderHunting";
import { useWorkbenchAction, WorkbenchActionGate } from "../workbenchActionContext";
import { ApiError, cancelDefenderHunt, deleteDefenderHunt, downloadDefenderHuntingCsv,
getDefenderHuntingCatalog, getDefenderHuntingJob, getDefenderHuntingJobs, getDefenderHuntingRows, resumeDefenderHunt,
  submitDefenderHunt, type DefenderHuntingCatalog, type DefenderHuntingFilters, type DefenderHuntingJob, type DefenderHuntingRow,
  type DefenderHuntingRowPage, type DefenderHuntingTokenMode, type DefenderInventoryDetailState, type AgentInvestigationContext } from "../api/client";
import { hasRole } from "../authorization";
import { capabilityExplanation, capabilityModeEnabled, queryReadAllowed } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
import { downloadFile } from "../downloadFile";
import { useSavedRead } from "../savedQueries";

const historyPageSize = 20;
const rowPageSize = 100;
const activeStatuses = new Set<DefenderHuntingJob["status"]>(["running"]);
const readableStatuses = new Set<DefenderHuntingJob["status"]>(["succeeded", "partial"]);
const providerAuthorizationErrors = new Set([
  "capability_unavailable", "missing_permission", "provider_denied",
  "interaction_required", "authorization_expired", "not_configured",
]);

function capabilityKey(views: ReturnType<typeof useCapabilityContext>["views"]) {
  return views.filter(view => view.definition.id.startsWith("defender.hunting.")).map(view => [view.definition.id, view.decision.status,
    view.decision.authorized, view.enabled ?? "",
    view.configuration?.enabled ?? "", view.configuration?.sharedDataScope ?? "", view.configuration?.revision ?? ""].join(":"))
    .sort().join("|");
}

type AgentHuntingProps = {
  agentRecordId?: string;
  agentName?: string;
  entraAgentIds?: string[];
  userObjectId?: string;
  entraAgentApplicationIds?: string[];
  templates?: AgentInvestigationContext["defender"]["templates"];
  active?: boolean;
  contextCurrent?: boolean;
  revision?: string;
};

export function DefenderHuntingView(props: AgentHuntingProps) {
  const capability = useCapabilityContext();
  const accountKey = JSON.stringify([capability.user?.tenantId, capability.user?.homeAccountId, [...(capability.user?.roles ?? [])].sort()]);
  const scopeKey = JSON.stringify([accountKey, capabilityKey(capability.views), props.agentRecordId,
    props.entraAgentIds, props.entraAgentApplicationIds ?? [], props.userObjectId]);
  if (!props.agentRecordId && !props.userObjectId) return <p role="alert">Select a user or agent to search Defender logs.</p>;
  return <DefenderHuntingSession key={scopeKey} {...props} scopeKey={scopeKey} />;
}

function DefenderHuntingSession({ agentRecordId, entraAgentIds = [], entraAgentApplicationIds = [], userObjectId, templates, scopeKey,
  active = true, contextCurrent = true, revision }: AgentHuntingProps & { scopeKey: string }) {
  const capability = useCapabilityContext();
  const readSaved = useSavedRead();
  const searchAction = useWorkbenchAction("defender.search");
  const generation = useRef(0);
  const activated = useRef(false);
  const actionGeneration = useRef(0);
  const actionRequest = useRef<{ key: string; controller: AbortController } | undefined>(undefined);
  const savedController = useRef(new AbortController());
  const selectedRef = useRef<DefenderHuntingJob | undefined>(undefined);
  const selectionOrigin = useRef<"history" | "action">("history");
  const draftGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const savedReadRevision = useRef<string | undefined>(undefined);
  const [catalog, setCatalog] = useState<DefenderHuntingCatalog>();
  const [jobs, setJobs] = useState<DefenderHuntingJob[]>([]);
  const [historyCount, setHistoryCount] = useState<number>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [selected, setSelected] = useState<DefenderHuntingJob>();
  // Keep history recovery available after a failed read clears private job data.
  const [canReturnToHistory, setCanReturnToHistory] = useState(false);
  const [rows, setRows] = useState<DefenderHuntingRowPage>();
  const [rowOffset, setRowOffset] = useState(0);
  const [tokenMode, setTokenMode] = useState<DefenderHuntingTokenMode>("delegated");
  const [templateId, setTemplateId] = useState<DefenderHuntingFilters["templateId"]>(() =>
    userObjectId ? "agent_activity" : (["agent_activity", "agent_tools", "agents_inventory"] as const).find(id => templates?.[id].status === "available") ?? "agents_inventory");
  const [operations, setOperations] = useState<string[]>(() => userObjectId ? ["InvokeAgent"] : fallbackTemplates.find(template => template.id === templateId)?.operations.slice().sort() ?? []);
  const [startDateTime, setStartDateTime] = useState(() => localDateTime(new Date(Date.now() - 60 * 60_000)));
  const [endDateTime, setEndDateTime] = useState(() => localDateTime(new Date()));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pollCycle, setPollCycle] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const pollBudget = useRef<{ deadline: number; attempts: number } | undefined>(undefined);
  const presentationKey = useMemo(() => ({ active }), [active]);
  const templateRevision = JSON.stringify(templates);
  const readKey = useMemo(() => ({ presentationKey, contextCurrent, revision, templateRevision }),
    [presentationKey, contextCurrent, revision, templateRevision]);
  const savedReadAttempt = useRef<object | undefined>(undefined);
  const [loaded, setLoaded] = useState<{ read: object; presentation: object }>();
  // Retained presentation is never authorization for a provider or management action.
  const savedCurrent = active && contextCurrent && loaded?.read === readKey && !historyLoading;
  const retainedPresentation = loaded?.presentation === presentationKey && !busy?.startsWith("history:");
  const actionsDisabled = Boolean(busy) || !savedCurrent;

  const capabilityId = tokenMode === "delegated" ? "defender.hunting.delegated" : "defender.hunting.application";
  const capabilityView = capability.views.find(view => view.definition.id === capabilityId);
  const applicationMode = tokenMode === "application";
  const scopedIds = templateId === "agents_inventory" ? entraAgentIds : entraAgentApplicationIds;
  const identityAvailable = (agentRecordId ? scopedIds.length === 1 : Boolean(userObjectId)) && templates?.[templateId].status !== "unavailable";
  const filters = makeFilters({ templateId, startDateTime, endDateTime, entraAgentIds, entraAgentApplicationIds, userObjectId, operations });
  const available = active && identityAvailable && queryReadAllowed(capabilityView);
  const diagnosticIssue = capabilityView && capabilityView.decision.status !== "available"
    && (capabilityView.decision.checkedAt || capabilityView.decision.evidence)
    ? capabilityExplanation(capabilityView, capability.now) : undefined;
  const rangeError = rangeMessage(filters, catalog);
  const operationError = templateId !== "agents_inventory" && operations.length === 0 ? "Select at least one operation." : undefined;
  const identityError = !identityAvailable
    ? templates?.[templateId].reason ?? (templateId === "agents_inventory"
      ? "A verified enterprise-application object ID is required for Defender inventory. An opaque Entra agent ID is not substituted."
      : "A source-verified runtime application/client ID is required. Package, bot, blueprint and enterprise-application object IDs are not substituted.")
    : undefined;

  function invalidateDraft(clearSelection = true) {
    // Draft filters do not change saved reads or operations on an existing job.
    const action = actionRequest.current;
    if (!action || /^(search|view:)/.test(action.key)) {
      actionGeneration.current += 1;
      action?.controller.abort();
      setBusy(undefined);
    }
    draftGeneration.current += 1;
    if (clearSelection) {
      selectedRef.current = undefined;
      selectionOrigin.current = "history";
      setSelected(undefined);
      setCanReturnToHistory(false);
      setRows(undefined);
      setRowOffset(0);
    }
  }

  function currentRequest(requestGeneration: number, requestAction: number) {
    return generation.current === requestGeneration && actionGeneration.current === requestAction;
  }

  const failSavedRead = useCallback((requestError: unknown, context = "") => {
    generation.current += 1;
    actionGeneration.current += 1;
    savedController.current.abort();
    actionRequest.current?.controller.abort();
    selectedRef.current = undefined;
    setBusy(undefined);
    setCatalog(undefined);
    setJobs([]);
    setHistoryCount(undefined);
    setHistoryLoading(false);
    setLoaded(undefined);
    setSelected(undefined);
    setRows(undefined);
    setRowOffset(0);
    setPollPaused(true);
    setError(`${context}${errorMessage(requestError)}`);
  }, []);

  const readSavedData = useCallback(async <T,>(
    key: readonly unknown[],
    read: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    context = "",
  ): Promise<T> => {
    const requestGeneration = generation.current;
    const currentSignal = AbortSignal.any([signal, savedController.current.signal]);
    // Another observer can keep a pre-action request alive after this view aborts.
    const revision = savedReadRevision.current;
    const currentKey = revision ? [...key, { revision }] : key;
    try {
      return await readSaved(["agent-investigation", scopeKey, agentRecordId, ...currentKey], read, currentSignal);
    } catch (requestError) {
      if (!currentSignal.aborted && generation.current === requestGeneration) failSavedRead(requestError, context);
      throw requestError;
    }
  }, [scopeKey, agentRecordId, failSavedRead, readSaved]);

  function clearPrivateSavedState(requestError: unknown, actionKey: string) {
    if (!(requestError instanceof ApiError)) return;
    const savedScopeInvalidated = /^(resume:|cancel:|delete:|export:)/.test(actionKey)
      && (requestError.status === 404 && requestError.code === "not_found"
        || requestError.status === 409 && [
          "application_scope_changed", "hunting_job_state", "agent_investigation_unavailable", "agent_identity_source_changed",
        ].includes(requestError.code));
    if (savedScopeInvalidated || (requestError.status === 401 || requestError.status === 403)
      && !providerAuthorizationErrors.has(requestError.code)) failSavedRead(requestError);
  }

  function commitHistory(history: Awaited<ReturnType<typeof getDefenderHuntingJobs>>) {
    setJobs(history.value);
    setHistoryCount(history.count);
    setHistoryOffset(history.offset);
    setHistoryLoading(false);
    const current = selectedRef.current;
    if (!current) return;
    const updated = history.value.find(job => job.id === current.id);
    if (updated) {
      selectedRef.current = updated;
      setSelected(updated);
      if (!readableStatuses.has(updated.status) || updated.snapshotId !== current.snapshotId || updated.updatedAt !== current.updatedAt) setRows(undefined);
    } else if (selectionOrigin.current !== "action") {
      selectJob(undefined, "history");
    }
  }

  async function loadHistory(offset: number, requestGeneration: number, signal: AbortSignal, requestAction?: number,
    publish = true): Promise<Awaited<ReturnType<typeof getDefenderHuntingJobs>> | undefined> {
    const historyRequest = ++historyGeneration.current;
    const result = await readSavedData(
      ["defender-hunting-jobs", { limit: historyPageSize, offset }, requestAction],
      requestSignal => getDefenderHuntingJobs(historyPageSize, offset, { signal: requestSignal, agentRecordId, userObjectId }),
      signal,
    );
    if (signal.aborted || generation.current !== requestGeneration || historyGeneration.current !== historyRequest
      || (requestAction !== undefined && actionGeneration.current !== requestAction)) return;
    const lastOffset = Math.max(Math.ceil(result.count / historyPageSize) - 1, 0) * historyPageSize;
    if (offset > lastOffset) return loadHistory(lastOffset, requestGeneration, signal, requestAction, publish);
    if (publish) commitHistory(result);
    return result;
  }

  const pollHistory = useEffectEvent(async (signal: AbortSignal) => {
    if (busy || actionRequest.current && !actionRequest.current.controller.signal.aborted) return;
    const requestGeneration = generation.current;
    try {
      const history = await loadHistory(historyOffset, requestGeneration, signal, undefined, false);
      if (!history || signal.aborted || generation.current !== requestGeneration) return;
      const current = selectedRef.current;
      const exactJob = current && selectionOrigin.current === "action" && activeStatuses.has(current.status)
        && !history.value.some(job => job.id === current.id)
        ? await readSavedData(["defender-hunting-job", current.id], requestSignal => getDefenderHuntingJob(current.id, { signal: requestSignal, agentRecordId, userObjectId }), signal)
        : undefined;
      if (signal.aborted || generation.current !== requestGeneration) return;
      // Publish catalog and job updates together so terminal status cannot abort this poll.
      const nextCatalog = await readSavedData(["defender-hunting-catalog", undefined],
        requestSignal => getDefenderHuntingCatalog({ signal: requestSignal, agentRecordId, userObjectId }), signal);
      if (signal.aborted || generation.current !== requestGeneration) return;
      setCatalog(nextCatalog);
      commitHistory(history);
      if (exactJob && selectedRef.current?.id === current?.id) {
        selectedRef.current = exactJob;
        setSelected(exactJob);
      }
    } catch (requestError) {
      if (!signal.aborted && generation.current === requestGeneration) {
        failSavedRead(requestError);
      }
    }
  });
  const hasProgressingJobs = jobs.some(job => activeStatuses.has(job.status)) || Boolean(selected && activeStatuses.has(selected.status));

  async function refreshSaved(requestGeneration: number, requestAction: number, signal: AbortSignal, background = false) {
    const selectedAtStart = selectedRef.current;
    const exactId = selectionOrigin.current === "action" ? selectedAtStart?.id : undefined;
    const currentRead = () => !signal.aborted && generation.current === requestGeneration
      && (background || actionGeneration.current === requestAction);
    setHistoryLoading(true);
    const savedJobs = Promise.all([
      readSavedData(["defender-hunting-jobs", { limit: historyPageSize, offset: historyOffset }, requestAction],
        requestSignal => getDefenderHuntingJobs(historyPageSize, historyOffset, { signal: requestSignal, agentRecordId, userObjectId }), signal),
      exactId ? readSavedData(["defender-hunting-job", exactId, requestAction],
        requestSignal => getDefenderHuntingJob(exactId, { signal: requestSignal, agentRecordId, userObjectId }), signal,
        "The exact Defender job is expired, deleted, or unavailable to this account. ") : undefined,
    ]);
    const readCatalog = () => readSavedData(["defender-hunting-catalog", requestAction],
      requestSignal => getDefenderHuntingCatalog({ signal: requestSignal, agentRecordId, userObjectId }), signal);
    const [nextCatalog, [history, exactJob]] = await Promise.all([
      hasProgressingJobs ? savedJobs.then(readCatalog) : readCatalog(),
      savedJobs,
    ]);
    if (!currentRead()) return;
    const selectedJob = exactJob ?? history.value.find(job => job.id === selectedAtStart?.id);
    let selectedRows: DefenderHuntingRowPage | undefined;
    if (selectedJob && readableStatuses.has(selectedJob.status) && rows?.job.id === selectedJob.id
      && selectedRef.current?.id === selectedJob.id && actionGeneration.current === requestAction) {
      selectedRows = await readSavedData(["defender-hunting-rows", selectedJob.id, { limit: rowPageSize, offset: rowOffset }, requestAction],
        requestSignal => getDefenderHuntingRows(selectedJob.id, rowPageSize, rowOffset, { signal: requestSignal, agentRecordId, userObjectId }), signal);
      if (selectedRows.job.id !== selectedJob.id) throw new Error("Saved hunting rows do not match the selected job.");
    }
    if (!currentRead()) return;
    setCatalog(nextCatalog);
    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (historyOffset > lastOffset) await loadHistory(lastOffset, requestGeneration, signal, background ? undefined : requestAction);
    else commitHistory(history);
    if (!currentRead() || selectedRef.current?.id !== selectedAtStart?.id || actionGeneration.current !== requestAction || !selectedJob) return;
    if (exactJob || selectedRef.current?.id === selectedJob.id) {
      const next = selectedRows?.job ?? selectedJob;
      selectedRef.current = next;
      setSelected(next);
      if (selectedRows) {
        setRows(selectedRows);
        setRowOffset(selectedRows.offset);
      } else if (!readableStatuses.has(next.status) || next.snapshotId !== selectedAtStart?.snapshotId || next.updatedAt !== selectedAtStart?.updatedAt) {
        setRows(undefined);
      }
    }
  }

  const resumeSaved = useEffectEvent(async (requestGeneration: number, signal: AbortSignal) => {
    const requestAction = actionGeneration.current;
    setError(undefined);
    try {
      await refreshSaved(requestGeneration, requestAction, signal, true);
      if (!signal.aborted && generation.current === requestGeneration) setLoaded({ read: readKey, presentation: presentationKey });
    } catch (requestError) {
      if (!signal.aborted && generation.current === requestGeneration) failSavedRead(requestError);
    } finally {
      if (!signal.aborted && generation.current === requestGeneration) {
        setHistoryLoading(false);
        setBusy(undefined);
      }
    }
  });

  useEffect(() => {
    if (!active || !contextCurrent || busy || savedReadAttempt.current === readKey) return;
    savedReadAttempt.current = readKey;
    const requestGeneration = ++generation.current;
    savedController.current.abort();
    const ownedSavedController = new AbortController();
    savedController.current = ownedSavedController;
    if (activated.current) savedReadRevision.current = crypto.randomUUID();
    activated.current = true;
    const controller = new AbortController();
    void resumeSaved(requestGeneration, controller.signal);
    return () => {
      controller.abort();
      ownedSavedController.abort();
      // A later explicit action owns its controller and generation until it settles.
      if (generation.current === requestGeneration) {
        generation.current += 1;
        if (savedReadAttempt.current === readKey) savedReadAttempt.current = undefined;
      }
    };
  }, [active, contextCurrent, readKey, busy]);

  useEffect(() => {
    if (!active) return;
    return () => {
      actionRequest.current?.controller.abort();
      savedController.current.abort();
      generation.current += 1;
      actionGeneration.current += 1;
      setBusy(undefined);
    };
  }, [active]);

  useEffect(() => {
    if (!active || !contextCurrent || !savedCurrent || !hasProgressingJobs && pollCycle === 0) return;
    // Only explicit restarts clear the budget; passive visibility changes reuse it.
    const budget = pollBudget.current ?? { deadline: Date.now() + 5 * 60_000, attempts: 0 };
    pollBudget.current = budget;
    if (!hasProgressingJobs || pollPaused) return;
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (cancelled || pollBudget.current !== budget) return;
      if (Date.now() >= budget.deadline || budget.attempts >= 200) {
        setPollPaused(true);
        return;
      }
      budget.attempts += 1;
      await pollHistory(controller.signal);
      if (!cancelled && pollBudget.current === budget) timer = window.setTimeout(() => void poll(), 1_500);
    };
    timer = window.setTimeout(() => void poll(), 1_500);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, contextCurrent, savedCurrent, hasProgressingJobs, pollCycle, pollPaused]);

  async function perform(key: string, operation: (requestGeneration: number, requestAction: number, signal: AbortSignal) => Promise<unknown>) {
    if (!active || !contextCurrent || key !== "refresh" && !savedCurrent) return;
    if (actionRequest.current && !actionRequest.current.controller.signal.aborted) return;
    savedReadRevision.current = crypto.randomUUID();
    const requestGeneration = ++generation.current;
    const requestAction = ++actionGeneration.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    actionRequest.current?.controller.abort();
    const controller = new AbortController();
    actionRequest.current = { key, controller };
    if (key.startsWith("history:")) {
      selectJob(undefined, "history");
      setHistoryLoading(true);
    }
    setBusy(key);
    setError(undefined);
    try {
      await operation(requestGeneration, requestAction, controller.signal);
      if (key === "refresh" && currentRequest(requestGeneration, requestAction)) setLoaded({ read: readKey, presentation: presentationKey });
      if (currentRequest(requestGeneration, requestAction) && /^(refresh|search|resume:)/.test(key)) {
        pollBudget.current = undefined;
        setPollPaused(false);
        setPollCycle(current => current + 1);
      }
    }
    catch (requestError) {
      if (!controller.signal.aborted && currentRequest(requestGeneration, requestAction)) {
        clearPrivateSavedState(requestError, key);
        setError(errorMessage(requestError));
        controller.abort();
      }
    } finally {
      if (actionRequest.current?.controller === controller) actionRequest.current = undefined;
      if (currentRequest(requestGeneration, requestAction)) {
        setBusy(undefined);
        setHistoryLoading(false);
      }
    }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!savedCurrent || !searchAction || !available || !catalog || !searchAction.roles.some(role => hasRole(capability.user, role))
      || busy || historyLoading || !filters || rangeError || operationError) return;
    await perform("search", async (requestGeneration, requestAction, signal) => {
      const job = await submitDefenderHunt(tokenMode, filters, { signal, agentRecordId, userObjectId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(job, "action"); await loadHistory(0, requestGeneration, signal, requestAction);
    });
  }

  async function handleView(job: DefenderHuntingJob, offset = 0) {
    if (actionsDisabled) return;
    await perform(`view:${job.id}`, async (requestGeneration, requestAction, signal) => {
      selectJob(job, selectedRef.current?.id === job.id ? selectionOrigin.current : "history");
      const page = await readSavedData(
        ["defender-hunting-rows", job.id, { limit: rowPageSize, offset }, requestAction],
        requestSignal => getDefenderHuntingRows(job.id, rowPageSize, offset, { signal: requestSignal, agentRecordId, userObjectId }),
        signal,
      );
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectedRef.current = page.job;
      setRows(page); setSelected(page.job); setRowOffset(page.offset);
    });
  }

  async function handleViewPrior(id: string) {
    if (actionsDisabled) return;
    await perform(`view:${id}`, async (requestGeneration, requestAction, signal) => {
      setRows(undefined); setRowOffset(0);
      const page = await readSavedData(
        ["defender-hunting-rows", id, { limit: rowPageSize, offset: 0 }, requestAction],
        requestSignal => getDefenderHuntingRows(id, rowPageSize, 0, { signal: requestSignal, agentRecordId, userObjectId }),
        signal,
      );
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(page.job, "action"); setRows(page);
    });
  }

  async function handleResume(job: DefenderHuntingJob) {
    await perform(`resume:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const draft = draftGeneration.current;
      const resumed = await resumeDefenderHunt(job.id, { signal, agentRecordId, userObjectId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      if (draftGeneration.current === draft) selectJob(resumed, "action");
      await loadHistory(historyOffset, requestGeneration, signal, requestAction);
    });
  }

  async function handleCancel(job: DefenderHuntingJob) {
    if (actionsDisabled || job.authorizationPrincipalId !== capability.user?.homeAccountId) return;
    await perform(`cancel:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const draft = draftGeneration.current;
      const cancelled = await cancelDefenderHunt(job.id, { signal, agentRecordId, userObjectId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      if (draftGeneration.current === draft) selectJob(cancelled, "action");
      await loadHistory(historyOffset, requestGeneration, signal, requestAction);
    });
  }

  async function handleDelete(job: DefenderHuntingJob) {
    if (actionsDisabled || job.authorizationPrincipalId !== capability.user?.homeAccountId) return;
    if (!window.confirm("Delete this minimized local hunting cache? Defender source data is unchanged.")) return;
    await perform(`delete:${job.id}`, async (requestGeneration, requestAction, signal) => {
      await deleteDefenderHunt(job.id, { signal, agentRecordId, userObjectId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      if (selectedRef.current?.id === job.id) selectJob(undefined);
      await loadHistory(historyOffset, requestGeneration, signal, requestAction);
    });
  }

  async function handleExport(job: DefenderHuntingJob) {
    await perform(`export:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const blob = await downloadDefenderHuntingCsv(job.id, { signal, agentRecordId, userObjectId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      downloadFile(`defender-hunting-${job.id}.csv`, blob);
    });
  }

  function selectJob(job: DefenderHuntingJob | undefined, origin: "history" | "action" = "history") {
    selectedRef.current = job;
    selectionOrigin.current = origin;
    setSelected(job);
    setCanReturnToHistory(Boolean(job));
    setRows(undefined);
    setRowOffset(0);
  }

  if (!active) return null;
  return (
    <section className="defender-hunting" aria-label="Microsoft Defender hunting">
      <header className="hunting-heading">
        <div><h4>Search Defender logs</h4></div>
        <div className="hunting-heading-actions">
          <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh hunting history" title="Refresh hunting history" disabled={!contextCurrent || Boolean(busy)} onClick={() => void perform("refresh", refreshSaved)}><RefreshCw aria-hidden="true" /></button>
        </div>
      </header>

      {error || capability.error ? <div className="error-banner" role="alert">{error ?? capability.error}
        {error && canReturnToHistory ? <button type="button" className="secondary" disabled={!contextCurrent || Boolean(busy)} onClick={() => {
          selectJob(undefined);
          void perform("refresh", refreshSaved);
        }}>Return to hunting history</button> : null}
      </div> : null}
      {diagnosticIssue ? <p role="status">Last provider check: {diagnosticIssue} You can retry this search; Microsoft checks current access.</p> : null}
      {pollPaused ? <p role="status">Automatic history refresh paused. Refresh hunting history to retry saved reads.</p> : null}
      {retainedPresentation && (!contextCurrent || historyLoading) ? <p className="sr-only" role="status">Refreshing hunting access and saved results. Provider actions remain unavailable until verification finishes.</p> : null}

      <form className="hunting-form" onSubmit={handleSearch}>
        <div className="hunting-primary-fields">
          {capability.views.some(view => view.definition.id === "defender.hunting.application" && capabilityModeEnabled(view)) ? <label><span>Authorization</span><select value={tokenMode} onChange={event => { setTokenMode(event.target.value as DefenderHuntingTokenMode); invalidateDraft(); }}><option value="delegated">My access</option><option value="application">Shared application</option></select></label> : null}
          <label><span>Log type</span><select value={templateId} onChange={event => {
            const next = event.target.value as DefenderHuntingFilters["templateId"];
            setTemplateId(next); setOperations(userObjectId ? ["InvokeAgent"] : catalog?.templates.find(template => template.id === next)?.operations ?? []); invalidateDraft();
          }}>{(catalog?.templates ?? fallbackTemplates).filter(template => userObjectId ? template.id === "agent_activity"
            : template.id === templateId || templates?.[template.id].status !== "unavailable")
            .map(template => <option key={template.id} value={template.id} disabled={templates?.[template.id].status === "unavailable"}>{userObjectId ? "Agent invocations" : template.label}</option>)}</select></label>
          <label><span>Start</span><input type="datetime-local" step="1" value={startDateTime} onChange={event => { setStartDateTime(event.target.value); invalidateDraft(); }} required /></label>
          <label><span>End</span><input type="datetime-local" step="1" value={endDateTime} onChange={event => { setEndDateTime(event.target.value); invalidateDraft(); }} required /></label>
        </div>
        <p className="agent-log-template-description">{userObjectId
          ? "Invocations attributed to this user. Tool and inference events identify the agent account, not necessarily the person."
          : templateDescriptions[templateId]}</p>

        {rangeError || operationError || identityError
          ? <div className="error-banner" role="alert">{rangeError ?? operationError ?? identityError}</div> : null}

        {!identityAvailable ? <p className="agent-insight-note">This template cannot run for the selected agent until its required identity is available. No broader query will be used.</p> : !available ? <section className="hunting-authorization" aria-label="Hunting authorization pending"><div><strong>{applicationMode ? "Application authorization is not ready" : "Delegated authorization is not ready"}</strong>
            <p>{capabilityView?.decision.remediation.join(" ") || "Open Permissions to resolve the reported authorization issue."}</p></div>
            <button type="button" className="secondary" onClick={capability.openPermissions}>Open Permissions</button>
          </section> : null}

        <div className="hunting-search-actions"><WorkbenchActionGate actionId="defender.search"><button type="submit" disabled={actionsDisabled || !available || !catalog || !filters || Boolean(rangeError || operationError)}><Search aria-hidden="true" /> Run hunt</button></WorkbenchActionGate>
          {!available ? <span>Resolve the reported authorization issue before running a hunt.</span> : null}</div>
      </form>

      <section className="hunting-history" aria-labelledby="hunting-history-title"><header><div><h3 id="hunting-history-title">Hunting history</h3></div><span>{historyCount === undefined ? "Unknown" : historyCount.toLocaleString()} jobs</span></header>
        {historyLoading && !retainedPresentation ? <div className="compact-empty-state" role="status">Loading hunting history...</div>
          : historyCount === undefined ? <div className="compact-empty-state"><strong>Hunting history unavailable</strong><span>Refresh hunting history to try again.</span></div>
          : jobs.length === 0 ? <div className="compact-empty-state"><strong>No hunting history</strong><span>Run a hunt to collect results for this selection.</span></div>
          : <HistoryTable jobs={jobs} selectedId={selected?.id} busy={actionsDisabled} currentPrincipalId={capability.user?.homeAccountId}
            onView={handleView} onResume={handleResume} onCancel={handleCancel} onDelete={handleDelete} onExport={handleExport} />}
        {historyCount !== undefined && historyCount > historyPageSize ? <div className="hunting-page-actions"><button type="button" className="secondary" disabled={actionsDisabled || historyOffset === 0}
          onClick={() => void perform("history:previous", (requestGeneration, requestAction, signal) => loadHistory(Math.max(0, historyOffset - historyPageSize), requestGeneration, signal, requestAction))}>Previous</button>
          <span>{historyOffset + 1}-{Math.min(historyOffset + jobs.length, historyCount)} of {historyCount}</span>
          <button type="button" className="secondary" disabled={actionsDisabled || historyOffset + jobs.length >= historyCount}
            onClick={() => void perform("history:next", (requestGeneration, requestAction, signal) => loadHistory(historyOffset + historyPageSize, requestGeneration, signal, requestAction))}>Next</button></div> : null}
      </section>

      {selected && (!historyLoading || retainedPresentation) ? <HuntingDetail key={selected.id} job={selected} rows={rows?.job.id === selected.id && readableStatuses.has(selected.status) ? rows : undefined} rowOffset={rowOffset} busy={actionsDisabled}
        loadingRows={Boolean(busy?.startsWith("view:"))}
        onPageChange={offset => void handleView(selected, offset)} onViewPrior={id => void handleViewPrior(id)} /> : null}
    </section>
  );
}

function HistoryTable({ jobs, selectedId, busy, currentPrincipalId, onView, onResume, onCancel, onDelete, onExport }: {
  jobs: DefenderHuntingJob[]; selectedId?: string; busy: boolean; currentPrincipalId?: string;
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
      {job.canResume && job.authorizationPrincipalId === currentPrincipalId
        ? <IconAction label={`Resume hunt ${shortId(job.id)}`} title="Resume with current authorization" disabled={busy} onClick={() => void onResume(job)}><Play /></IconAction> : null}
      {job.authorizationPrincipalId === currentPrincipalId && (activeStatuses.has(job.status) || job.status === "waiting_authorization") ? <IconAction label={`Cancel hunt ${shortId(job.id)}`} title="Cancel local execution" disabled={busy} onClick={() => void onCancel(job)}><Pause /></IconAction> : null}
      {readableStatuses.has(job.status) ? <IconAction label={`Export hunt ${shortId(job.id)}`} title="Export minimized CSV" disabled={busy} onClick={() => void onExport(job)}><Download /></IconAction> : null}
      {job.authorizationPrincipalId === currentPrincipalId && !activeStatuses.has(job.status) ? <IconAction label={`Delete hunt ${shortId(job.id)}`} title="Delete local cache" disabled={busy} onClick={() => void onDelete(job)}><Trash2 /></IconAction> : null}</div></td>
  </tr>)}</tbody></table></div>;
}

function HuntingDetail({ job, rows, rowOffset, busy, loadingRows, onPageChange, onViewPrior }: { job: DefenderHuntingJob; rows?: DefenderHuntingRowPage; rowOffset: number; busy: boolean; loadingRows: boolean;
  onPageChange: (offset: number) => void; onViewPrior: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const visibleRows = rows?.value.filter(row => (!errorsOnly || row.sourceTable === "CloudAppEvents" && row.outcome === "error")
    && Object.values(row).filter(value => typeof value === "string" || typeof value === "number").join(" ").toLowerCase()
      .includes(search.trim().toLowerCase())) ?? [];
  return <section className="hunting-results" aria-labelledby="hunting-results-title"><header><div><h3 id="hunting-results-title">{templateLabel(job.filters.templateId)} result</h3></div>
    <span>{job.storedRowCount.toLocaleString()} rows</span></header>
    <div className="hunting-result-facts"><div><span>Source</span><strong>{rows?.snapshot.sourceTable ?? (job.filters.templateId === "agents_inventory" ? "AgentsInfo preview" : "CloudAppEvents")}</strong></div>
      <div><span>Requested range</span><strong>{formatRange(job.filters.startDateTime, job.filters.endDateTime)}</strong></div>
      <div><span>Coverage</span><strong>{job.complete ? "Complete bounded request" : job.partialReason === "hunting_row_limit" ? "Row cap reached" : "Not complete"}</strong></div></div>
    {job.noData ? <div className="hunting-no-data"><strong>No data returned</strong><span>No rows matched this hunt. Try another time range or check log setup in Permissions.</span></div> : null}
    {job.status === "partial" ? <div className="warning-banner">{job.partialReason === "hunting_row_limit" ? "The 200-row local cap was reached."
      : `The saved result is partial${job.partialReason ? ` (${statusLabel(job.partialReason)})` : ""}.`} Results are incomplete for the requested interval.
      </div> : null}
    {job.message && (job.status === "failed" || job.status === "inconclusive")
      ? <div className={job.status === "failed" ? "error-banner" : "warning-banner"} role="alert">{job.message}</div> : null}
    {job.priorSuccessfulJobId && !readableStatuses.has(job.status) ? <div className="hunting-prior-result"><span>The previous successful result is still available.</span>
      <button type="button" className="secondary" disabled={busy} onClick={() => onViewPrior(job.priorSuccessfulJobId!)}><Eye aria-hidden="true" /> View prior successful result</button></div> : null}
    {loadingRows ? <p role="status">Loading minimized rows...</p> : null}
    {rows?.value.length ? <>
      <div className="agent-insight-toolbar">
        <label>Filter loaded metadata<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} placeholder="Tool, actor, conversation, span or error" /></label>
        {job.filters.templateId !== "agents_inventory" ? <label><input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)} /> Reported errors only</label> : null}
        <span>{visibleRows.length} of {rows.value.length} rows on this page. CSV includes all saved rows.</span>
      </div>
      {visibleRows.length ? <ResultTable value={visibleRows} /> : <p>No loaded rows match these filters.</p>}
    </> : !job.noData && readableStatuses.has(job.status) ? <button type="button" className="secondary" disabled={busy} onClick={() => onPageChange(0)}><Eye aria-hidden="true" /> Load minimized rows</button> : null}
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
      <RuntimeActor row={row} /><td><code>{display(row.spanId)}</code><small>{row.rootSpanObserved ? "Observed root span metadata" : row.parentSpanId ? `Child of ${row.parentSpanId}` : "Root span not observed"}</small></td>
      <td>{display(row.toolName ?? row.errorType)}<small>{row.outcome} / {statusLabel(row.spanRole)} / {row.durationMilliseconds === null ? "duration not supplied" : `${row.durationMilliseconds} ms`}</small>
        <dl className="agent-audit-event-details">
          {([
            ["Error", row.errorType], ["Conversation", row.conversationId], ["Thread", row.conversationThreadId],
            ["Session", row.sessionIdentity], ["Channel", row.channelName], ["Tool type", row.toolType], ["Tool call", row.toolCallId],
            ["Target agent", row.targetAgentId],
            ["Acting agent", row.agentId], ["Invoked from", row.invokeSource], ["Completed", row.completionTime],
          ] as const).filter(([, value]) => value !== null && value !== undefined && value !== "")
            .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}
        </dl>
      </td><td>{associationLabel(row.association)}</td></tr>)}</tbody></table></div>;
}

function RuntimeActor({ row }: { row: Extract<DefenderHuntingRow, { sourceTable: "CloudAppEvents" }> }) {
  const human = Boolean(row.humanActorUserObjectId || row.humanActorUserPrincipalName);
  const agent = !human && Boolean(row.agentUserObjectId || row.agentUserPrincipalName);
  return <td>
    <code>{display(human ? row.humanActorUserObjectId : agent ? row.agentUserObjectId : row.actorAccountObjectId)}</code>
    <small>{display(human ? row.humanActorUserPrincipalName : agent ? row.agentUserPrincipalName : row.actorProviderAccountId)}</small>
    <small>{human ? "Human caller" : agent ? "Agent account" : "Provider account"}</small>
  </td>;
}

function IconAction({ children, disabled, label, onClick, title }: { children: React.ReactNode; disabled: boolean; label: string; onClick: () => void; title: string }) {
  return <button type="button" className="secondary icon-button control-icon-button" aria-label={label} title={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

function makeFilters(value: { templateId: DefenderHuntingFilters["templateId"]; startDateTime: string; endDateTime: string; entraAgentIds: string[]; entraAgentApplicationIds: string[]; userObjectId?: string; operations: string[] }): DefenderHuntingFilters | undefined {
  const start = toUtc(value.startDateTime); const end = toUtc(value.endDateTime);
  if (!start || !end) return undefined;
  return { templateId: value.templateId, startDateTime: start, endDateTime: end, agentIds: [], blueprintIds: [],
    ...(value.userObjectId ? { userObjectId: value.userObjectId.toLowerCase() } : {}),
    actorObjectIds: [], ...(value.templateId === "agents_inventory" ? { entraAgentIds: [...value.entraAgentIds].sort() }
      : { entraAgentApplicationIds: [...value.entraAgentApplicationIds].sort() }), operations: [...value.operations].sort() };
}

function rangeMessage(filters: DefenderHuntingFilters | undefined, catalog?: DefenderHuntingCatalog) {
  if (!filters) return "Enter valid start and end times.";
  const duration = Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime);
  if (duration <= 0) return "End must be after start.";
  if (duration > (catalog?.limits.maximumWindowHours ?? 168) * 60 * 60_000) return "The selected range exceeds the bounded hunting window.";
  return undefined;
}

function toUtc(value: string) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined; }
function localDateTime(value: Date) { const offset = value.getTimezoneOffset() * 60_000; return new Date(value.getTime() - offset).toISOString().slice(0, 19); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatRange(startDateTime: string, endDateTime: string) { return `${formatDateTime(startDateTime)} to ${formatDateTime(endDateTime)}`; }
function inventoryDetail(label: string, state: DefenderInventoryDetailState, count?: number | null) { return state === "empty" ? `${label}: empty` : state === "not_exposed" ? `${label}: not exposed`
  : state === "present_unqualified_shape" ? `${label}: present, shape not qualified` : count === null || count === undefined ? `${label}: not supplied` : `${label}: ${count}`; }
function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}...` : value; }
function display(value: string | null | undefined) { return value === null || value === undefined || value === "" ? "Not supplied" : value; }
function templateLabel(value: DefenderHuntingFilters["templateId"]) { return value === "agents_inventory" ? "Defender agent inventory" : value === "agent_tools" ? "Agent tool activity" : "Agent activity"; }
function associationLabel(value: DefenderHuntingRow["association"]) { return value?.status === "resolved" ? `Exact ${value.matchedKind}` : value?.status === "ambiguous" ? "Ambiguous exact ID" : value?.reason === "blueprint_is_parent_not_equivalence" ? "Blueprint parent only" : "Unmatched source record"; }
function statusLabel(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, character => character.toUpperCase()); }
function statusClass(value: DefenderHuntingJob["status"] | string) { return value === "succeeded" || value === "available" ? "success" : value === "running" || value === "waiting_authorization" || value === "unknown" ? "pending" : value === "partial" || value === "inconclusive" ? "warning" : "failure"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Hunting request failed."; }

const fallbackTemplates: DefenderHuntingCatalog["templates"] = defenderHuntingTemplateIds.map(id => ({ id, ...defenderHuntingTemplates[id] }));
const templateDescriptions: Record<DefenderHuntingFilters["templateId"], string> = {
  agents_inventory: "Agent metadata, platform and lifecycle state. This is an inventory snapshot, not a log of conversations.",
  agent_activity: "Agent invocations and model inference, including actors, duration, conversation references and reported errors.",
  agent_tools: "SDK, gateway and MCP tool calls, including tool names, duration and outcomes.",
};