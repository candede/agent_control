import { useCallback, useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { Download, ExternalLink, Eye, Pause, Play, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useWorkbenchAction, WorkbenchActionGate } from "../workbenchActionContext";
import { ApiError, approveDefenderHuntingQualification, cancelDefenderHunt, deleteDefenderHunt, downloadDefenderHuntingCsv,
getDefenderHuntingCatalog, getDefenderHuntingJob, getDefenderHuntingJobs, getDefenderHuntingRows, resumeDefenderHunt, startDefenderHuntingQualification,
  submitDefenderHunt, revokeDefenderHuntingRetainedScope, type DefenderHuntingCatalog, type DefenderHuntingFilters, type DefenderHuntingJob, type DefenderHuntingRow,
  type DefenderHuntingRowPage, type DefenderHuntingTokenMode, type DefenderInventoryDetailState, type AgentInvestigationContext } from "../api/client";
import { hasRole } from "../authorization";
import { capabilityModeEnabled, providerActionAllowed } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
import { useSavedRead } from "../savedQueries";

const historyPageSize = 20;
const rowPageSize = 100;
const activeStatuses = new Set<DefenderHuntingJob["status"]>(["running"]);
const readableStatuses = new Set<DefenderHuntingJob["status"]>(["succeeded", "partial"]);
const providerAuthorizationErrors = new Set([
  "capability_unavailable", "hunting_scope_unqualified", "missing_permission", "provider_denied",
  "interaction_required", "authorization_expired", "not_configured",
]);

function capabilityKey(views: ReturnType<typeof useCapabilityContext>["views"]) {
  return views.filter(view => view.definition.id.startsWith("defender.hunting.")).map(view => [view.definition.id, view.decision.status,
    view.decision.authorized, view.decision.fresh, view.decision.checkedAt ?? "", view.decision.expiresAt ?? "",
    view.decision.verification ?? "", view.decision.previewQualification, view.enabled ?? "",
    view.configuration?.enabled ?? "", view.configuration?.sharedDataScope ?? ""].join(":"))
    .sort().join("|");
}

type AgentHuntingProps = {
  agentRecordId: string;
  agentName: string;
  entraAgentIds: string[];
  entraAgentApplicationIds?: string[];
  templates?: AgentInvestigationContext["defender"]["templates"];
  initialJobId?: string;
};

export function DefenderHuntingView(props: AgentHuntingProps) {
  const capability = useCapabilityContext();
  const accountKey = JSON.stringify([capability.user?.tenantId, capability.user?.homeAccountId, [...(capability.user?.roles ?? [])].sort()]);
  return <DefenderHuntingSession key={JSON.stringify([accountKey, capabilityKey(capability.views), props])} {...props} accountKey={accountKey} />;
}

function DefenderHuntingSession({ agentRecordId, agentName, entraAgentIds, entraAgentApplicationIds = [], templates, initialJobId, accountKey }: AgentHuntingProps & { accountKey: string }) {
  const capability = useCapabilityContext();
  const readSaved = useSavedRead();
  const searchAction = useWorkbenchAction("defender.search");
  const generation = useRef(0);
  const actionGeneration = useRef(0);
  const actionController = useRef<AbortController | undefined>(undefined);
  const savedController = useRef(new AbortController());
  const detailController = useRef<AbortController | undefined>(undefined);
  const selectedRef = useRef<DefenderHuntingJob | undefined>(undefined);
  const selectionOrigin = useRef<"history" | "route">("route");
  const approvalGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const savedReadRevision = useRef<string | undefined>(undefined);
  const catalogGeneration = useRef(0);
  const [catalog, setCatalog] = useState<DefenderHuntingCatalog>();
  const [jobs, setJobs] = useState<DefenderHuntingJob[]>([]);
  const [historyCount, setHistoryCount] = useState<number>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [selected, setSelected] = useState<DefenderHuntingJob>();
  const [rows, setRows] = useState<DefenderHuntingRowPage>();
  const [rowOffset, setRowOffset] = useState(0);
  const [tokenMode, setTokenMode] = useState<DefenderHuntingTokenMode>("delegated");
  const [templateId, setTemplateId] = useState<DefenderHuntingFilters["templateId"]>(() =>
    fallbackTemplates.find(template => templates?.[template.id].status === "available")?.id ?? "agents_inventory");
  const [operations, setOperations] = useState<string[]>(() => fallbackTemplates.find(template => template.id === templateId)?.operations.slice().sort() ?? []);
  const [startDateTime, setStartDateTime] = useState(() => localDateTime(new Date(Date.now() - 60 * 60_000)));
  const [endDateTime, setEndDateTime] = useState(() => localDateTime(new Date()));
  const [routeJobId, setRouteJobId] = useState(initialJobId);
  const resolvedRouteJobId = useRef<string | undefined>(undefined);
  const [approvedJob, setApprovedJob] = useState<DefenderHuntingJob>();
  const [approvalAcknowledged, setApprovalAcknowledged] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pollCycle, setPollCycle] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const pollBudget = useRef<{ deadline: number; attempts: number } | undefined>(undefined);

  const capabilityId = tokenMode === "delegated" ? "defender.hunting.delegated" : "defender.hunting.application";
  const capabilityView = capability.views.find(view => view.definition.id === capabilityId);
  const applicationMode = tokenMode === "application";
  const scopedIds = templateId === "agents_inventory" ? entraAgentIds : entraAgentApplicationIds;
  const identityAvailable = scopedIds.length === 1 && templates?.[templateId].status !== "unavailable";
  const canQualify = identityAvailable && applicationMode && hasRole(capability.user, "AgentControl.Admin");
  const filters = makeFilters({ templateId, startDateTime, endDateTime, entraAgentIds, entraAgentApplicationIds, operations });
  const qualification = filters && catalog?.qualifications.find(evidence => evidence.capabilityId === capabilityId
    && evidence.templateId === filters.templateId && equalQualificationScope(evidence.approvedScope, filters)
    && evidence.queryVersion === 3 && Date.parse(evidence.expiresAt) > capability.now);
  const retainedScope = filters && catalog?.retainedScopes.find(scope => scope.capabilityId === capabilityId
    && scope.templateId === filters.templateId && equalQualificationScope(scope.approvedScope, filters)
    && scope.queryVersion === 3 && scope.revokedAt === null && Date.parse(scope.expiresAt) > capability.now);
  const canRevokeRetainedScope = retainedScope
    ? retainedScope.tokenMode === "delegated"
      ? hasRole(capability.user, "AgentControl.Viewer")
      : hasRole(capability.user, "AgentControl.Admin")
    : false;
  const available = identityAvailable && (applicationMode
    ? Boolean(qualification && retainedScope && (!capabilityView || capabilityModeEnabled(capabilityView)
      && capabilityView.configuration?.sharedDataScope !== false))
    : providerActionAllowed(capabilityView, false, capability.now));
  const rangeError = rangeMessage(filters, catalog);
  const operationError = templateId !== "agents_inventory" && operations.length === 0 ? "Select at least one operation." : undefined;
  const qualificationTargetError = !identityAvailable
    ? templates?.[templateId].reason ?? (templateId === "agents_inventory"
      ? "A verified enterprise-application object ID is required for Defender inventory. An opaque Entra agent ID is not substituted."
      : "A source-verified runtime application/client ID is required. Package, bot, blueprint and enterprise-application object IDs are not substituted.")
    : undefined;
  const qualificationRangeError = applicationMode && !available && filters
    && Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime) > (catalog?.limits.qualificationWindowHours ?? 1) * 3_600_000
    ? `Qualification must not exceed ${catalog?.limits.qualificationWindowHours ?? 1} hours.` : undefined;
  const canStartQualification = canQualify && approvedJob?.qualification && approvedJob.status === "waiting_authorization"
    && approvedJob.canResume && Date.parse(approvedJob.expiresAt) > capability.now;

  function invalidateApproval(clearSelection = true) {
    actionGeneration.current += 1;
    actionController.current?.abort();
    detailController.current?.abort();
    approvalGeneration.current += 1;
    setApprovedJob(undefined);
    setApprovalAcknowledged(false);
    setBusy(undefined);
    if (clearSelection) {
      selectedRef.current = undefined;
      resolvedRouteJobId.current = undefined;
      selectionOrigin.current = "history";
      setSelected(undefined);
      setRows(undefined);
      setRowOffset(0);
      setRouteJobId(undefined);
    }
  }

  function currentRequest(requestGeneration: number, requestAction: number) {
    return generation.current === requestGeneration && actionGeneration.current === requestAction;
  }

  const failSavedRead = useCallback((requestError: unknown, context = "") => {
    generation.current += 1;
    actionGeneration.current += 1;
    savedController.current.abort();
    detailController.current?.abort();
    actionController.current?.abort();
    selectedRef.current = undefined;
    setBusy(undefined);
    setCatalog(undefined);
    setJobs([]);
    setHistoryCount(undefined);
    setHistoryLoading(false);
    setSelected(undefined);
    setRows(undefined);
    setRowOffset(0);
    setApprovedJob(undefined);
    setApprovalAcknowledged(false);
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
      return await readSaved(["agent-investigation", accountKey, agentRecordId, ...currentKey], read, currentSignal);
    } catch (requestError) {
      if (!currentSignal.aborted && generation.current === requestGeneration) failSavedRead(requestError, context);
      throw requestError;
    }
  }, [accountKey, agentRecordId, failSavedRead, readSaved]);

  function clearPrivateSavedState(requestError: unknown) {
    if (requestError instanceof ApiError && (requestError.status === 401 || requestError.status === 403)
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
    } else if (selectionOrigin.current !== "route") {
      selectJob(undefined, "history");
    }
  }

  async function loadHistory(offset: number, requestGeneration: number, signal: AbortSignal, requestAction?: number) {
    const historyRequest = ++historyGeneration.current;
    const result = await readSavedData(
      ["defender-hunting-jobs", { limit: historyPageSize, offset }, requestAction],
      requestSignal => getDefenderHuntingJobs(historyPageSize, offset, { signal: requestSignal, agentRecordId }),
      signal,
    );
    if (signal.aborted || generation.current !== requestGeneration || historyGeneration.current !== historyRequest
      || (requestAction !== undefined && actionGeneration.current !== requestAction)) return;
    const lastOffset = Math.max(Math.ceil(result.count / historyPageSize) - 1, 0) * historyPageSize;
    if (offset > lastOffset) return loadHistory(lastOffset, requestGeneration, signal, requestAction);
    commitHistory(result);
  }

  async function loadCatalog(requestGeneration: number, signal: AbortSignal, requestAction?: number) {
    const catalogRequest = ++catalogGeneration.current;
    const result = await readSavedData(
      ["defender-hunting-catalog", requestAction],
      requestSignal => getDefenderHuntingCatalog({ signal: requestSignal, agentRecordId }),
      signal,
    );
    if (signal.aborted || generation.current !== requestGeneration || catalogGeneration.current !== catalogRequest
      || (requestAction !== undefined && actionGeneration.current !== requestAction)) return;
    setCatalog(result);
  }

  const pollHistory = useEffectEvent(async (signal: AbortSignal) => {
    if (busy || actionController.current && !actionController.current.signal.aborted) return;
    const requestGeneration = generation.current;
    try {
      await Promise.all([
        loadHistory(historyOffset, requestGeneration, signal),
        loadCatalog(requestGeneration, signal),
      ]);
      if (signal.aborted || generation.current !== requestGeneration) return;
      const current = selectedRef.current;
      if (current && selectionOrigin.current === "route" && activeStatuses.has(current.status)) {
        const job = await readSavedData(["defender-hunting-job", current.id], requestSignal => getDefenderHuntingJob(current.id, { signal: requestSignal, agentRecordId }), signal);
        if (!signal.aborted && generation.current === requestGeneration && selectedRef.current?.id === job.id) {
          selectedRef.current = job;
          setSelected(job);
        }
      }
    } catch (requestError) {
      if (!signal.aborted && generation.current === requestGeneration) {
        failSavedRead(requestError);
      }
    }
  });
  const hasProgressingJobs = jobs.some(job => activeStatuses.has(job.status)) || Boolean(selected && activeStatuses.has(selected.status));

  useEffect(() => {
    const requestGeneration = ++generation.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    const controller = new AbortController();
    Promise.all([
      readSavedData(["defender-hunting-catalog"], signal => getDefenderHuntingCatalog({ signal, agentRecordId }), controller.signal),
      readSavedData(
        ["defender-hunting-jobs", { limit: historyPageSize, offset: 0 }],
        signal => getDefenderHuntingJobs(historyPageSize, 0, { signal, agentRecordId }),
        controller.signal,
      ),
    ]).then(([catalogResult, history]) => {
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      setCatalog(catalogResult);
      setJobs(history.value);
      setHistoryCount(history.count);
      setHistoryOffset(history.offset);
      setHistoryLoading(false);
    }).catch((requestError: unknown) => {
      if (!controller.signal.aborted && generation.current === requestGeneration) {
        failSavedRead(requestError);
      }
    });
    return () => {
      controller.abort();
      savedController.current.abort();
      generation.current += 1;
    };
  }, [agentRecordId, failSavedRead, readSavedData]);

  useEffect(() => () => actionController.current?.abort(), []);

  useEffect(() => {
    if (!routeJobId) return;
    if (resolvedRouteJobId.current === routeJobId) return;
    const requestGeneration = generation.current;
    const controller = new AbortController();
    detailController.current = controller;
    selectedRef.current = undefined;
    selectionOrigin.current = "route";
    setSelected(undefined);
    setRows(undefined);
    setRowOffset(0);
    if (savedController.current.signal.aborted) return () => controller.abort();
    void readSavedData(
      ["defender-hunting-job", routeJobId],
      signal => getDefenderHuntingJob(routeJobId, { signal, agentRecordId }),
      controller.signal,
      "The exact Defender job is expired, deleted, or unavailable to this account. ",
    )
      .then(job => {
        if (!controller.signal.aborted && generation.current === requestGeneration) {
          selectedRef.current = job;
          setSelected(job);
        }
      })
      .catch(requestError => {
        if (!controller.signal.aborted && generation.current === requestGeneration) {
          failSavedRead(requestError, "The exact Defender job is expired, deleted, or unavailable to this account. ");
        }
      });
    return () => controller.abort();
  }, [agentRecordId, failSavedRead, readSavedData, routeJobId]);

  useEffect(() => {
    if (!hasProgressingJobs && pollCycle === 0) return;
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
  }, [hasProgressingJobs, pollCycle, pollPaused]);

  async function perform(key: string, operation: (requestGeneration: number, requestAction: number, signal: AbortSignal) => Promise<void>) {
    if (actionController.current && !actionController.current.signal.aborted) return;
    savedReadRevision.current = crypto.randomUUID();
    const requestGeneration = ++generation.current;
    const requestAction = ++actionGeneration.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    detailController.current?.abort();
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    if (key.startsWith("history:")) {
      selectJob(undefined, "history");
      setHistoryLoading(true);
    }
    setBusy(key);
    setError(undefined);
    try {
      await operation(requestGeneration, requestAction, controller.signal);
      if (currentRequest(requestGeneration, requestAction) && /^(refresh|search|qualification|resume:)/.test(key)) {
        pollBudget.current = undefined;
        setPollPaused(false);
        setPollCycle(current => current + 1);
      }
    }
    catch (requestError) {
      if (!controller.signal.aborted && currentRequest(requestGeneration, requestAction)) {
        clearPrivateSavedState(requestError);
        setError(errorMessage(requestError));
        controller.abort();
      }
    } finally {
      if (actionController.current === controller) actionController.current = undefined;
      if (currentRequest(requestGeneration, requestAction)) {
        setBusy(undefined);
        setHistoryLoading(false);
      }
    }
  }

  async function refreshSaved(requestGeneration: number, requestAction: number, signal: AbortSignal) {
    const exactId = selectionOrigin.current === "route" ? selectedRef.current?.id ?? routeJobId : undefined;
    setHistoryLoading(true);
    const [nextCatalog, history, exactJob] = await Promise.all([
      readSavedData(["defender-hunting-catalog", requestAction], requestSignal => getDefenderHuntingCatalog({ signal: requestSignal, agentRecordId }), signal),
      readSavedData(["defender-hunting-jobs", { limit: historyPageSize, offset: historyOffset }, requestAction],
        requestSignal => getDefenderHuntingJobs(historyPageSize, historyOffset, { signal: requestSignal, agentRecordId }), signal),
      exactId ? readSavedData(["defender-hunting-job", exactId, requestAction],
        requestSignal => getDefenderHuntingJob(exactId, { signal: requestSignal, agentRecordId }), signal,
        "The exact Defender job is expired, deleted, or unavailable to this account. ") : undefined,
    ]);
    if (signal.aborted || !currentRequest(requestGeneration, requestAction)) return;
    setCatalog(nextCatalog);
    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (historyOffset > lastOffset) await loadHistory(lastOffset, requestGeneration, signal, requestAction);
    else commitHistory(history);
    if (exactJob && currentRequest(requestGeneration, requestAction)) selectJob(exactJob, "route");
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    if (!searchAction || !available || !catalog || !searchAction.roles.some(role => hasRole(capability.user, role))
      || busy || !filters || rangeError || operationError) return;
    await perform("search", async (requestGeneration, requestAction, signal) => {
      const job = await submitDefenderHunt(tokenMode, filters, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(job, "route"); await loadHistory(0, requestGeneration, signal, requestAction);
    });
  }

  async function handleApprove() {
    if (!canQualify || !approvalAcknowledged || !catalog || busy || !filters || rangeError || operationError || qualificationTargetError || qualificationRangeError) return;
    const approvalRequest = ++approvalGeneration.current;
    await perform("approve", async (requestGeneration, requestAction, signal) => {
      const job = await approveDefenderHuntingQualification(tokenMode, filters, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction) || approvalGeneration.current !== approvalRequest) return;
      setApprovedJob(job); setApprovalAcknowledged(false); await loadHistory(0, requestGeneration, signal, requestAction);
    });
  }

  async function handleStartQualification() {
    if (!canStartQualification || !approvedJob?.qualification || busy) return;
    const approvalRequest = approvalGeneration.current;
    await perform("qualification", async (requestGeneration, requestAction, signal) => {
      const currentApproval = await readSavedData(
        ["defender-hunting-job", approvedJob.id, requestAction],
        requestSignal => getDefenderHuntingJob(approvedJob.id, { signal: requestSignal, agentRecordId }),
        signal,
      );
      if (!currentRequest(requestGeneration, requestAction) || approvalGeneration.current !== approvalRequest) return;
      const binding = approvedJob.qualification;
      if (currentApproval.id !== approvedJob.id || !currentApproval.canResume || currentApproval.status !== "waiting_authorization"
        || !(Date.parse(currentApproval.expiresAt) > capability.now)
        || currentApproval.authorizationPrincipalId !== approvedJob.authorizationPrincipalId
        || currentApproval.tokenMode !== approvedJob.tokenMode
        || currentApproval.resultScope.kind !== approvedJob.resultScope.kind
        || currentApproval.resultScope.scopeId !== approvedJob.resultScope.scopeId
        || currentApproval.resultScope.configurationRevision !== approvedJob.resultScope.configurationRevision
        || currentApproval.filters.startDateTime !== approvedJob.filters.startDateTime
        || currentApproval.filters.endDateTime !== approvedJob.filters.endDateTime
        || !equalQualificationScope(currentApproval.filters, approvedJob.filters)
        || (["capabilityId", "contractRevision", "permissionRevision", "configurationRevision", "approvedBy"] as const)
          .some(key => currentApproval.qualification?.[key] !== binding?.[key])) {
        setApprovedJob(undefined);
        throw new Error("Qualification approval is no longer current. Review the exact scope and approve again.");
      }
      const job = await startDefenderHuntingQualification(approvedJob.id, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction) || approvalGeneration.current !== approvalRequest) return;
      setApprovedJob(job); selectJob(job, "route"); await loadHistory(0, requestGeneration, signal, requestAction);
      if (!currentRequest(requestGeneration, requestAction)) return;
      if (job.status === "succeeded") await Promise.all([loadCatalog(requestGeneration, signal, requestAction), capability.reload()]);
    });
  }

  async function handleRevokeRetainedScope() {
    if (!retainedScope || !canRevokeRetainedScope || busy || !window.confirm("Revoke saved Defender hunting access for this exact retained scope? Existing provider data is unchanged.")) return;
    await perform("revoke-scope", async (requestGeneration, requestAction, signal) => {
      await revokeDefenderHuntingRetainedScope(retainedScope.id, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(undefined);
      await Promise.all([
        loadCatalog(requestGeneration, signal, requestAction),
        loadHistory(0, requestGeneration, signal, requestAction),
      ]);
    });
  }

  async function handleView(job: DefenderHuntingJob, offset = 0) {
    if (busy || historyLoading) return;
    selectJob(job, selectedRef.current?.id === job.id ? selectionOrigin.current : "history");
    await perform(`view:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const page = await readSavedData(
        ["defender-hunting-rows", job.id, { limit: rowPageSize, offset }, requestAction],
        requestSignal => getDefenderHuntingRows(job.id, rowPageSize, offset, { signal: requestSignal, agentRecordId }),
        signal,
      );
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectedRef.current = page.job;
      setRows(page); setSelected(page.job); setRowOffset(page.offset);
    });
  }

  async function handleViewPrior(id: string) {
    if (busy || historyLoading) return;
    setRows(undefined); setRowOffset(0);
    await perform(`view:${id}`, async (requestGeneration, requestAction, signal) => {
      const page = await readSavedData(
        ["defender-hunting-rows", id, { limit: rowPageSize, offset: 0 }, requestAction],
        requestSignal => getDefenderHuntingRows(id, rowPageSize, 0, { signal: requestSignal, agentRecordId }),
        signal,
      );
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(page.job, "route"); setRows(page);
    });
  }

  async function handleResume(job: DefenderHuntingJob) {
    await perform(`resume:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const resumed = await resumeDefenderHunt(job.id, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(resumed, "route"); await loadHistory(historyOffset, requestGeneration, signal, requestAction);
    });
  }

  async function handleCancel(job: DefenderHuntingJob) {
    await perform(`cancel:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const cancelled = await cancelDefenderHunt(job.id, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      selectJob(cancelled, "route"); await loadHistory(historyOffset, requestGeneration, signal, requestAction);
    });
  }

  async function handleDelete(job: DefenderHuntingJob) {
    if (!window.confirm("Delete this minimized local hunting cache? Defender source data is unchanged.")) return;
    await perform(`delete:${job.id}`, async (requestGeneration, requestAction, signal) => {
      await deleteDefenderHunt(job.id, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      if (selectedRef.current?.id === job.id || routeJobId === job.id) selectJob(undefined);
      await loadHistory(historyOffset, requestGeneration, signal, requestAction);
    });
  }

  async function handleExport(job: DefenderHuntingJob) {
    await perform(`export:${job.id}`, async (requestGeneration, requestAction, signal) => {
      const blob = await downloadDefenderHuntingCsv(job.id, { signal, agentRecordId });
      if (!currentRequest(requestGeneration, requestAction)) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `defender-hunting-${job.id}.csv`; document.body.append(anchor); anchor.click();
      window.setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url); }, 0);
    });
  }

  const selectedTemplate = catalog?.templates.find(template => template.id === templateId);
  const readiness = available ? qualification ? "qualified_exact_scope" : "ready_to_try" : "not_ready";

  function selectJob(job: DefenderHuntingJob | undefined, origin: "history" | "route" = "history") {
    resolvedRouteJobId.current = job?.id;
    selectedRef.current = job;
    selectionOrigin.current = origin;
    setSelected(job);
    setRows(undefined);
    setRowOffset(0);
    setRouteJobId(job?.id);
  }

  return (
    <section className="defender-hunting" aria-label="Microsoft Defender hunting">
      <header className="hunting-heading">
        <div><h3>Defender and Agent 365 hunting</h3><p>{agentName}</p></div>
        <div className="hunting-heading-actions">
          <a className="primary-link secondary" href={catalog?.defenderPortalUrl ?? "https://security.microsoft.com/v2/advanced-hunting"} target="_blank" rel="noreferrer">Defender portal (not agent-scoped) <ExternalLink aria-hidden="true" /></a>
          <button type="button" className="secondary icon-button control-icon-button" aria-label="Refresh hunting history" title="Refresh hunting history" disabled={Boolean(busy)} onClick={() => void perform("refresh", refreshSaved)}><RefreshCw aria-hidden="true" /></button>
        </div>
      </header>

      {error ? <div className="error-banner" role="alert">{error}
        {routeJobId ? <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => {
          selectJob(undefined, "history");
          void perform("refresh", refreshSaved);
        }}>Return to hunting history</button> : null}
      </div> : null}
      {pollPaused ? <p role="status">Automatic history refresh paused. Refresh hunting history to retry saved reads.</p> : null}

      <details className="hunting-filters"><summary>Access, scope &amp; limits</summary>
        <section className="hunting-readiness" aria-label="Hunting readiness">
          <div><span>Provider authorization</span><strong>{statusLabel(readiness)}</strong><small>{tokenMode} / {qualification ? `proof expires ${formatDateTime(qualification.expiresAt)}` : "token authorization only; operation access is checked when a hunt runs"}</small></div>
          <div><span>Saved-data scope</span><strong>{retainedScope ? "Approved" : "Not approved"}</strong><small>{retainedScope ? `expires ${formatDateTime(retainedScope.expiresAt)}` : "No current exact retained scope"}</small></div>
          <div><span>Source table</span><strong>{selectedTemplate?.sourceTable ?? "Not selected"}</strong><small>{selectedTemplate?.sourceTable === "AgentsInfo" ? "Preview table" : "Agent 365 activity metadata"}</small></div>
          <div><span>Provider prerequisites</span><strong>Not independently proven</strong><small>See Log setup on Permissions</small></div>
          <div><span>Local retention</span><strong>30 days</strong><small>Provider retention is separate</small></div>
        </section>
        <div className="hunting-boundary" role="note"><ShieldCheck aria-hidden="true" /><span>{catalog?.contentNotice ?? "Messages and tool content are not retained or reconstructed."}</span></div>
      </details>

      {retainedScope ? <section className="hunting-qualification" aria-label="Retained hunting scope"><div><strong>Exact saved-data scope approved</strong>
        <p>Saved history remains readable until {formatDateTime(retainedScope.expiresAt)} while this local approval, current role and configuration remain valid.</p></div>
        {canRevokeRetainedScope ? <div className="hunting-qualification-actions"><button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void handleRevokeRetainedScope()}><Trash2 aria-hidden="true" /> Revoke saved-data access</button></div> : null}
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

        <details className="hunting-filters"><summary>Agent scope (automatic)</summary>
          <p>{templateId === "agents_inventory" ? "Enterprise-application object ID" : "Verified application/client ID"}: <code>{scopedIds.join(", ") || "Unavailable"}</code>. Package IDs, blueprint IDs, bot IDs and display names are not substituted for this identity.</p>
          {templateId !== "agents_inventory" ? <p>The saved calling identity is an exact filter, not proof that every runtime emits telemetry under that identity. Missing matches do not prove inactivity.</p> : null}
        </details>

        {rangeError || operationError || qualificationRangeError || qualificationTargetError
          ? <div className="error-banner" role="alert">{rangeError ?? operationError ?? qualificationRangeError ?? qualificationTargetError}</div> : null}

        {!identityAvailable ? <p className="agent-insight-note">This template cannot run for the selected agent until its required identity is available. No broader query will be used.</p> : !available && applicationMode ? <section className="hunting-qualification" aria-label="Hunting qualification required"><div><strong>Shared application hunting is not qualified</strong>
          {(capabilityView?.decision.remediation ?? ["Open Permissions to review the exact Defender hunting contract."]).map(item => <p key={item}>{item}</p>)}</div>
          <div className="hunting-qualification-actions"><button type="button" className="secondary" onClick={capability.openPermissions}>Open Permissions</button>
            {canQualify ? <label><input type="checkbox" checked={approvalAcknowledged} onChange={event => setApprovalAcknowledged(event.target.checked)} /><span>Approve one bounded fixed-template provider query</span></label> : null}
            {canQualify ? <button type="button" disabled={!approvalAcknowledged || !catalog || !filters || Boolean(rangeError || operationError || qualificationTargetError || qualificationRangeError || busy)} onClick={() => void handleApprove()}><ShieldCheck aria-hidden="true" /> Approve qualification</button> : null}
            {canStartQualification ? <button type="button" disabled={Boolean(busy)} onClick={() => void handleStartQualification()}><Play aria-hidden="true" /> Run approved qualification</button> : null}
          </div></section> : !available ? <section className="hunting-qualification" aria-label="Hunting authorization pending"><div><strong>Delegated authorization is not ready</strong>
            <p>Automatic safe permission checks run while this signed-in session is active. They never submit a hunting query.</p></div>
            <button type="button" className="secondary" onClick={capability.openPermissions}>Open Permissions</button>
          </section> : null}

        <div className="hunting-search-actions"><WorkbenchActionGate actionId="defender.search"><button type="submit" disabled={!available || !catalog || !filters || Boolean(rangeError || operationError || busy)}><Search aria-hidden="true" /> Run hunt</button></WorkbenchActionGate>
          <span>{available ? applicationMode ? "Current shared qualification permits an explicit hunt." : "Delegated authorization permits an explicit bounded hunt."
            : applicationMode ? "Provider requests remain disabled until shared application qualification succeeds." : "Provider requests remain disabled until automatic permission checks establish delegated authorization."}</span></div>
      </form>

      <section className="hunting-history" aria-labelledby="hunting-history-title"><header><div><h3 id="hunting-history-title">Hunting history</h3><p>Delegated results remain principal-private. Application results use only the current approved shared scope.</p></div><span>{historyCount === undefined ? "Unknown" : historyCount.toLocaleString()} jobs</span></header>
        {historyLoading ? <div className="compact-empty-state" role="status">Loading hunting history...</div>
          : historyCount === undefined ? <div className="compact-empty-state"><strong>Hunting history unavailable</strong><span>Retry saved reads; unavailable evidence is not an empty history.</span></div>
          : jobs.length === 0 ? <div className="compact-empty-state"><strong>No hunting history</strong><span>Opening this view does not run a provider query.</span></div>
          : <HistoryTable jobs={jobs} selectedId={selected?.id} busy={Boolean(busy)} onView={handleView} onResume={handleResume} onCancel={handleCancel} onDelete={handleDelete} onExport={handleExport} />}
        {historyCount !== undefined && historyCount > historyPageSize ? <div className="hunting-page-actions"><button type="button" className="secondary" disabled={Boolean(busy) || historyOffset === 0}
          onClick={() => void perform("history:previous", (requestGeneration, requestAction, signal) => loadHistory(Math.max(0, historyOffset - historyPageSize), requestGeneration, signal, requestAction))}>Previous</button>
          <span>{historyOffset + 1}-{Math.min(historyOffset + jobs.length, historyCount)} of {historyCount}</span>
          <button type="button" className="secondary" disabled={Boolean(busy) || historyOffset + jobs.length >= historyCount}
            onClick={() => void perform("history:next", (requestGeneration, requestAction, signal) => loadHistory(historyOffset + historyPageSize, requestGeneration, signal, requestAction))}>Next</button></div> : null}
      </section>

      {selected ? <HuntingDetail key={selected.id} job={selected} rows={rows?.job.id === selected.id && readableStatuses.has(selected.status) ? rows : undefined} rowOffset={rowOffset} busy={Boolean(busy) || historyLoading}
        onPageChange={offset => void handleView(selected, offset)} onViewPrior={id => void handleViewPrior(id)} /> : null}
    </section>
  );
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
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const visibleRows = rows?.value.filter(row => (!errorsOnly || row.sourceTable === "CloudAppEvents" && row.outcome === "error")
    && Object.values(row).filter(value => typeof value === "string" || typeof value === "number").join(" ").toLowerCase()
      .includes(search.trim().toLowerCase())) ?? [];
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
    {job.status === "partial" ? <div className="warning-banner">{job.partialReason === "hunting_row_limit" ? "The 200-row local cap was reached."
      : `The saved result is partial${job.partialReason ? ` (${statusLabel(job.partialReason)})` : ""}.`} The requested interval remains incompletely observed; no complete total is claimed.</div> : null}
    {job.priorSuccessfulJobId && !readableStatuses.has(job.status) ? <div className="hunting-prior-result"><span>This attempt did not replace the prior successful minimized result.</span>
      <button type="button" className="secondary" disabled={busy} onClick={() => onViewPrior(job.priorSuccessfulJobId!)}><Eye aria-hidden="true" /> View prior successful result</button></div> : null}
    {rows?.value.length ? <>
      <div className="agent-insight-toolbar">
        <label>Filter loaded metadata<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} placeholder="Tool, actor, conversation, span or error" /></label>
        {job.filters.templateId !== "agents_inventory" ? <label><input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)} /> Reported errors only</label> : null}
        <span>{visibleRows.length} of {rows.value.length} loaded rows. Filters apply to this page only; CSV includes all saved rows.</span>
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
      <td><code>{display(row.actorAccountObjectId)}</code><small>{display(row.actorProviderAccountId)}</small></td><td><code>{display(row.spanId)}</code><small>{row.rootSpanObserved ? "Observed root span metadata" : row.parentSpanId ? `Child of ${row.parentSpanId}` : "Root span not observed"}</small></td>
      <td>{display(row.toolName ?? row.errorType)}<small>{row.outcome} / {statusLabel(row.spanRole)} / {row.durationMilliseconds === null ? "duration not supplied" : `${row.durationMilliseconds} ms`}; content absent</small>
        <details><summary>Event metadata</summary><dl className="inventory-identifiers">
          {([
            ["Error", row.errorType], ["Conversation", row.conversationId], ["Thread", row.conversationThreadId],
            ["Session", row.sessionIdentity], ["Channel", row.channelName], ["Tool type", row.toolType], ["Tool call", row.toolCallId],
            ["Human actor", row.humanActorUserPrincipalName ?? row.humanActorUserObjectId],
            ["Agent user", row.agentUserPrincipalName ?? row.agentUserObjectId], ["Target agent", row.targetAgentId],
            ["Acting agent", row.agentId], ["Invoked from", row.invokeSource], ["Completed", row.completionTime],
          ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}
        </dl><p>Missing error metadata is not proof of success. Conversation and span IDs are references, not reconstructed transcripts.</p></details>
      </td><td>{associationLabel(row.association)}</td></tr>)}</tbody></table></div>;
}

function IconAction({ children, disabled, label, onClick, title }: { children: React.ReactNode; disabled: boolean; label: string; onClick: () => void; title: string }) {
  return <button type="button" className="secondary icon-button control-icon-button" aria-label={label} title={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

function makeFilters(value: { templateId: DefenderHuntingFilters["templateId"]; startDateTime: string; endDateTime: string; entraAgentIds: string[]; entraAgentApplicationIds: string[]; operations: string[] }): DefenderHuntingFilters | undefined {
  const start = toUtc(value.startDateTime); const end = toUtc(value.endDateTime);
  if (!start || !end) return undefined;
  return { templateId: value.templateId, startDateTime: start, endDateTime: end, agentIds: [], blueprintIds: [],
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

function equalQualificationScope(approved: Omit<DefenderHuntingFilters, "startDateTime" | "endDateTime">, filters: DefenderHuntingFilters) {
  return approved.templateId === filters.templateId && equalStrings(approved.agentIds, filters.agentIds) && equalStrings(approved.blueprintIds, filters.blueprintIds)
    && equalStrings(approved.entraAgentIds ?? [], filters.entraAgentIds ?? [])
    && equalStrings(approved.entraAgentApplicationIds ?? [], filters.entraAgentApplicationIds ?? [])
    && equalStrings(approved.actorObjectIds, filters.actorObjectIds) && equalStrings(approved.operations, filters.operations);
}
function equalStrings(left: string[], right: string[]) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function toUtc(value: string) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined; }
function localDateTime(value: Date) { const offset = value.getTimezoneOffset() * 60_000; return new Date(value.getTime() - offset).toISOString().slice(0, 19); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function formatRange(startDateTime: string, endDateTime: string) { return `${formatDateTime(startDateTime)} to ${formatDateTime(endDateTime)}`; }
function filterSummary(filters: DefenderHuntingFilters) { const values = [...(filters.entraAgentIds ?? []).map(value => `Entra object ${value}`), ...(filters.entraAgentApplicationIds ?? []).map(value => `Application/client ${value}`), ...filters.agentIds.map(value => `agent ${value}`), ...filters.blueprintIds.map(value => `blueprint ${value}`),
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