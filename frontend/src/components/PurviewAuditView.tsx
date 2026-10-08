import { useCallback, useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  ApiError,
  approvePurviewAuditQualification,
  cancelPurviewAuditSearch,
  deletePurviewAuditSearch,
  downloadPurviewAuditCsv,
  getPurviewAuditCatalog,
  getPurviewAuditJob,
  getPurviewAuditJobs,
  getPurviewAuditRecords,
  resumePurviewAuditSearch,
  startPurviewAuditQualification,
  submitPurviewAuditSearch,
  type PurviewAuditCatalog,
  type PurviewAuditFilters,
  type PurviewAuditJob,
  type PurviewAuditQualification,
  type PurviewAuditRecord,
  type PurviewAuditRecordPage,
  type PurviewAuditTokenMode,
} from "../api/client";
import { hasRole } from "../authorization";
import { capabilityExplanation, currentOperationFailure, currentVerification, providerActionAllowed, statusLabels } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
import { downloadFile } from "../downloadFile";
import { useSavedRead } from "../savedQueries";
import { useWorkbenchAction, WorkbenchActionGate } from "../workbenchActionContext";

const activeStatuses = new Set<PurviewAuditJob["status"]>([
  "running",
  "reconciling_create",
]);
const readableStatuses = new Set<PurviewAuditJob["status"]>([
  "succeeded",
  "partial",
]);
const recordPageSize = 100;
const historyPageSize = 20;
const providerAuthorizationErrors = new Set([
  "capability_unavailable", "missing_permission", "provider_denied", "interaction_required", "authorization_expired", "not_configured",
]);

function purviewCapabilityKey(views: ReturnType<typeof useCapabilityContext>["views"]) {
  return views
    .filter((view) => view.definition.id.startsWith("purview.audit.search."))
    .map((view) => [
      view.definition.id,
      view.decision.status,
      view.decision.authorized,
      view.definition.probe.adapterRegistered,
      view.definition.permissions.join(","),
      view.enabled ?? "",
      view.configuration?.enabled ?? "",
      view.configuration?.sharedDataScope ?? "",
      view.configuration?.revision ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

export function PurviewAuditView({ userPrincipalName, active = true }: { userPrincipalName: string; active?: boolean }) {
  const capability = useCapabilityContext();
  const accountKey = JSON.stringify([capability.user?.tenantId, capability.user?.homeAccountId, [...(capability.user?.roles ?? [])].sort()]);
  const scopeKey = `${accountKey}:${purviewCapabilityKey(capability.views)}:${userPrincipalName}`;
  return <PurviewAuditSession key={scopeKey} scopeKey={scopeKey} userPrincipalName={userPrincipalName} active={active} />;
}

function PurviewAuditSession({ userPrincipalName, active, scopeKey }: { userPrincipalName: string; active: boolean; scopeKey: string }) {
  const capability = useCapabilityContext();
  const readSaved = useSavedRead();
  const searchAction = useWorkbenchAction("purview.search");
  const requestGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const draftGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const savedReadRevision = useRef<string | undefined>(undefined);
  const actionRequest = useRef<{ key: string; controller: AbortController } | undefined>(undefined);
  const selectionController = useRef(new AbortController());
  const savedController = useRef(new AbortController());
  const selectionOrigin = useRef<"history" | "action">("history");
  const selectedRef = useRef<PurviewAuditJob | undefined>(undefined);
  const [catalog, setCatalog] = useState<PurviewAuditCatalog>();
  const [jobs, setJobs] = useState<PurviewAuditJob[]>([]);
  const [historyCount, setHistoryCount] = useState<number>();
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [selected, setSelected] = useState<PurviewAuditJob>();
  const [records, setRecords] = useState<PurviewAuditRecordPage>();
  const [recordOffset, setRecordOffset] = useState(0);
  const [tokenMode, setTokenMode] =
    useState<PurviewAuditTokenMode>("delegated");
  const [presetId, setPresetId] =
    useState<PurviewAuditFilters["presetId"]>("copilot_interactions");
  const [operations, setOperations] = useState(["CopilotInteraction"]);
  const [startDateTime, setStartDateTime] = useState(() =>
    localDateTime(new Date(Date.now() - 60 * 60_000)),
  );
  const [endDateTime, setEndDateTime] = useState(() =>
    localDateTime(new Date()),
  );
  const [ipAddresses, setIpAddresses] = useState("");
  const [objectIds, setObjectIds] = useState("");
  const [administrativeUnitIds, setAdministrativeUnitIds] = useState("");
  const [qualification, setQualification] =
    useState<PurviewAuditQualification>();
  const [approvalAcknowledged, setApprovalAcknowledged] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [pollCycle, setPollCycle] = useState(0);
  const [pollPaused, setPollPaused] = useState(false);
  const pollBudget = useRef<{ deadline: number; attempts: number } | undefined>(undefined);
  const refreshedQualification = useRef<string | undefined>(undefined);

  function selectJob(job: PurviewAuditJob | undefined, origin: "history" | "action" = "history") {
    if (job) {
      assertUserJobs([job], userPrincipalName);
      updateSelectedJob(job);
    } else {
      selectedRef.current = undefined;
      setSelected(undefined);
    }
    selectionOrigin.current = origin;
    setRecords(undefined);
    setRecordOffset(0);
  }

  function updateSelectedJob(job: PurviewAuditJob) {
    selectedRef.current = job;
    setSelected(job);
    setJobs(current => current.map(row => row.id === job.id ? job : row));
    setRecords(current => current?.job.id === job.id && current.job.updatedAt === job.updatedAt
      && readableStatuses.has(job.status) ? current : undefined);
  }

  function invalidateQualification() {
    // Draft filters do not own saved history or commands on an existing job.
    selectionController.current.abort();
    selectionController.current = new AbortController();
    const action = actionRequest.current;
    if (!action || /^(search|approve|qualification|view:)/.test(action.key)) {
      actionGeneration.current += 1;
      action?.controller.abort();
      setBusy(undefined);
    }
    draftGeneration.current += 1;
    setQualification(undefined);
    setApprovalAcknowledged(false);
    selectJob(undefined);
  }

  function currentRequest(generation: number, action?: number) {
    return requestGeneration.current === generation
      && (action === undefined || actionGeneration.current === action);
  }

  const failSavedRead = useCallback((requestError: unknown, context = "") => {
    requestGeneration.current += 1;
    actionGeneration.current += 1;
    savedController.current.abort();
    actionRequest.current?.controller.abort();
    selectedRef.current = undefined;
    setBusy(undefined);
    setCatalog(undefined);
    setJobs([]);
    setHistoryCount(undefined);
    setHistoryLoading(false);
    setSelected(undefined);
    setRecords(undefined);
    setRecordOffset(0);
    setQualification(undefined);
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
    const generation = requestGeneration.current;
    const currentSignal = AbortSignal.any([signal, savedController.current.signal]);
    // Another observer can keep a pre-action request alive after this view aborts.
    const revision = savedReadRevision.current;
    const scopedKey = [...key, { scope: scopeKey }];
    const currentKey = revision ? [...scopedKey, { revision }] : scopedKey;
    try {
      return await readSaved(currentKey, read, currentSignal);
    } catch (requestError) {
      if (!currentSignal.aborted && requestGeneration.current === generation) failSavedRead(requestError, context);
      throw requestError;
    }
  }, [failSavedRead, readSaved, scopeKey]);

  async function readSavedSelection<T>(
    key: readonly unknown[],
    read: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    context = "",
  ): Promise<T | undefined> {
    const selectionSignal = selectionController.current.signal;
    try {
      return await readSavedData(key, read, AbortSignal.any([signal, selectionSignal]), context);
    } catch (requestError) {
      if (!selectionSignal.aborted) throw requestError;
    }
  }

  function clearPrivateSavedState(requestError: unknown, actionKey: string) {
    if (!(requestError instanceof ApiError)) return;
    const savedJobInvalidated = /^(resume|cancel|delete|export):/.test(actionKey)
      && (requestError.status === 404 && requestError.code === "not_found"
        || requestError.status === 409 && ["application_scope_changed", "audit_job_state"].includes(requestError.code));
    if (savedJobInvalidated || (requestError.status === 401 || requestError.status === 403)
      && !providerAuthorizationErrors.has(requestError.code)) failSavedRead(requestError);
  }

  function commitHistory(history: Awaited<ReturnType<typeof getPurviewAuditJobs>>) {
    assertUserJobs(history.value, userPrincipalName);
    setJobs(history.value);
    setHistoryCount(history.count);
    setHistoryOffset(history.offset);
    setHistoryLoading(false);
    const current = selectedRef.current;
    if (!current) return;
    const updated = history.value.find(job => job.id === current.id);
    if (updated) {
      updateSelectedJob(updated);
    } else if (selectionOrigin.current !== "action") {
      selectJob(undefined);
    }
  }

  async function loadHistory(
    offset: number,
    generation: number,
    signal: AbortSignal,
    action?: number,
  ): Promise<Awaited<ReturnType<typeof getPurviewAuditJobs>> | undefined> {
    const historyRequest = ++historyGeneration.current;
    const history = await readSavedData(
      ["purview-audit-jobs", { limit: historyPageSize, offset, userPrincipalName }],
      requestSignal => getPurviewAuditJobs(historyPageSize, offset, { signal: requestSignal, userPrincipalName }),
      signal,
    );
    if (signal.aborted || !currentRequest(generation, action) || historyRequest !== historyGeneration.current) {
      return;
    }

    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (offset > lastOffset) return loadHistory(lastOffset, generation, signal, action);
    commitHistory(history);
    return history;
  }

  const pollHistory = useEffectEvent(async (signal: AbortSignal) => {
    if (!active || historyLoading || busy || actionRequest.current && !actionRequest.current.controller.signal.aborted) return;
    const generation = requestGeneration.current;
    try {
      const history = await loadHistory(historyOffset, generation, signal);
      if (!history || signal.aborted || !currentRequest(generation)) return;
      const current = selectedRef.current;
      if (current && selectionOrigin.current === "action" && activeStatuses.has(current.status)
        && !history.value.some(job => job.id === current.id)) {
        const job = await readSavedSelection(["purview-audit-job", current.id], requestSignal => getPurviewAuditJob(current.id, { signal: requestSignal }), signal);
        if (job && !signal.aborted && currentRequest(generation) && selectedRef.current?.id === current.id) {
          assertExactJob(job, current.id, userPrincipalName);
          updateSelectedJob(job);
        }
      }
    } catch (requestError) {
      if (!signal.aborted && currentRequest(generation)) {
        failSavedRead(requestError);
      }
    }
  });
  const hasProgressingJobs = jobs.some(job => activeStatuses.has(job.status)) || Boolean(selected && activeStatuses.has(selected.status));

  const reloadCapability = useEffectEvent(async () => {
    await capability.reload();
  });

  const restoreSaved = useEffectEvent(async (generation: number, signal: AbortSignal) => {
    const action = actionGeneration.current;
    const draft = draftGeneration.current;
    const previous = selectedRef.current;
    const origin = selectionOrigin.current;
    const previousOffset = records?.job.id === previous?.id ? recordOffset : undefined;
    setError(undefined);
    const [catalogResult, history, exactJob] = await Promise.all([
      readSavedData(["purview-audit-catalog"], requestSignal => getPurviewAuditCatalog({ signal: requestSignal }), signal),
      readSavedData(
        ["purview-audit-jobs", { limit: historyPageSize, offset: historyOffset, userPrincipalName }],
        requestSignal => getPurviewAuditJobs(historyPageSize, historyOffset, { signal: requestSignal, userPrincipalName }),
        signal,
      ),
      previous ? readSavedSelection(["purview-audit-job", previous.id],
        requestSignal => getPurviewAuditJob(previous.id, { signal: requestSignal }), signal,
        "The selected search is expired, deleted, or unavailable to this account. ") : undefined,
    ]);
    if (signal.aborted || !currentRequest(generation)) return;
    assertUserJobs(history.value, userPrincipalName);
    if (exactJob && previous) assertExactJob(exactJob, previous.id, userPrincipalName);
    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (historyOffset > lastOffset) await loadHistory(lastOffset, generation, signal);
    else commitHistory(history);
    if (signal.aborted || !currentRequest(generation)) return;
    setCatalog(catalogResult);
    if (exactJob && currentRequest(generation, action) && draftGeneration.current === draft) {
      selectJob(exactJob, origin);
      if (previousOffset !== undefined && readableStatuses.has(exactJob.status)) {
        setHistoryLoading(true);
        const page = await readSavedSelection(["purview-audit-records", exactJob.id, { limit: recordPageSize, offset: previousOffset, updatedAt: exactJob.updatedAt }],
          requestSignal => getPurviewAuditRecords(exactJob.id, recordPageSize, previousOffset, { signal: requestSignal }), signal);
        if (page && currentRequest(generation, action) && draftGeneration.current === draft) {
          assertExactJob(page.job, exactJob.id, userPrincipalName);
          updateSelectedJob(page.job);
          setRecords(page);
          setRecordOffset(page.offset);
        }
      }
    }
    if (!signal.aborted && currentRequest(generation)) setHistoryLoading(false);
  });

  useEffect(() => {
    if (!active) return;
    const generation = ++requestGeneration.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    const controller = new AbortController();

    void restoreSaved(generation, controller.signal)
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted && currentRequest(generation)) {
          failSavedRead(requestError);
        }
      });

    return () => {
      controller.abort();
      savedController.current.abort();
      actionRequest.current?.controller.abort();
      requestGeneration.current += 1;
      actionGeneration.current += 1;
      savedReadRevision.current = crypto.randomUUID();
      setHistoryLoading(true);
      setBusy(undefined);
    };
  }, [active, failSavedRead, readSavedData, userPrincipalName]);

  useEffect(() => () => actionRequest.current?.controller.abort(), []);

  useEffect(() => {
    if (!qualification) {
      return;
    }

    const remaining = Date.parse(qualification.expiresAt) - Math.max(Date.now(), capability.now);
    const timer = window.setTimeout(() => {
      setQualification((current) =>
        current?.id === qualification.id ? undefined : current,
      );
    }, Math.max(remaining, 0));
    return () => window.clearTimeout(timer);
  }, [capability.now, qualification]);

  useEffect(() => {
    if (!active || historyLoading || !hasProgressingJobs && pollCycle === 0) return;
    // Only explicit restarts clear the budget; passive visibility changes reuse it.
    const budget = pollBudget.current ?? { deadline: Date.now() + 5 * 60_000, attempts: 0 };
    pollBudget.current = budget;
    if (!hasProgressingJobs || pollPaused) return;
    let cancelled = false;
    let timer: number | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (cancelled || pollBudget.current !== budget) return;
      if (Date.now() >= budget.deadline || budget.attempts >= 150) {
        setPollPaused(true);
        return;
      }
      budget.attempts += 1;
      await pollHistory(controller.signal);
      if (!cancelled && pollBudget.current === budget) timer = window.setTimeout(() => void poll(), 2_000);
    };
    timer = window.setTimeout(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, hasProgressingJobs, historyLoading, pollCycle, pollPaused]);

  useEffect(() => {
    const qualificationJob = qualification?.jobId
      ? selected?.id === qualification.jobId ? selected : jobs.find((job) => job.id === qualification.jobId)
      : undefined;

    if (active && !historyLoading && !busy && qualificationJob?.status === "succeeded" && refreshedQualification.current !== qualificationJob.id) {
      refreshedQualification.current = qualificationJob.id;
      const generation = requestGeneration.current;
      void reloadCapability().catch(requestError => {
        if (currentRequest(generation)) setError(errorMessage(requestError));
      });
    }
  }, [active, busy, historyLoading, jobs, qualification, selected]);

  const capabilityId =
    tokenMode === "delegated"
      ? "purview.audit.search.delegated"
      : "purview.audit.search.application";
  const capabilityView = capability.views.find(
    (view) => view.definition.id === capabilityId,
  );
  const decision = capabilityView?.decision;
  const available = providerActionAllowed(
    capabilityView,
    false,
    capability.now,
  );
  const applicationMode = tokenMode === "application";
  const verification = capabilityView ? currentVerification(capabilityView, capability.now) : undefined;
  const operationFailure = capabilityView ? currentOperationFailure(capabilityView, capability.now) : undefined;
  const setupIssue = capabilityView && !available
    ? !applicationMode && decision?.status === "unknown" && !decision.evidence?.category
      ? decision.checkedAt ? "Check incomplete. Retry permissions." : "Permissions have not been checked."
      : capabilityExplanation(capabilityView, capability.now)
    : undefined;
  const canQualify = applicationMode && hasRole(capability.user, "AgentControl.Admin");
  const filters = makeFilters({
    administrativeUnitIds,
    endDateTime,
    ipAddresses,
    objectIds,
    operations,
    presetId,
    startDateTime,
    userPrincipalNames: userPrincipalName,
  });
  const rangeError = getRangeError(filters, catalog);
  const operationError = operations.length ? undefined : "Select at least one supported operation.";
  const qualificationRangeError = applicationMode && !available && filters
    && Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime) > (catalog?.limits.qualificationWindowHours ?? 1) * 3_600_000
    ? `Qualification must not exceed ${catalog?.limits.qualificationWindowHours ?? 1} hours.` : undefined;

  async function refreshSaved(generation: number, action: number, signal: AbortSignal) {
    const draft = draftGeneration.current;
    const exactId = selectionOrigin.current === "action" ? selectedRef.current?.id : undefined;
    setHistoryLoading(true);
    const [nextCatalog, history, exactJob] = await Promise.all([
      readSavedData(["purview-audit-catalog"], requestSignal => getPurviewAuditCatalog({ signal: requestSignal }), signal),
      readSavedData(["purview-audit-jobs", { limit: historyPageSize, offset: historyOffset, userPrincipalName }],
        requestSignal => getPurviewAuditJobs(historyPageSize, historyOffset, { signal: requestSignal, userPrincipalName }), signal),
      exactId ? readSavedSelection(["purview-audit-job", exactId],
        requestSignal => getPurviewAuditJob(exactId, { signal: requestSignal }), signal,
        "The exact Audit Search job is expired, deleted, or unavailable to this account. ") : undefined,
    ]);
    if (signal.aborted || !currentRequest(generation, action)) return;
    setCatalog(nextCatalog);
    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (historyOffset > lastOffset) await loadHistory(lastOffset, generation, signal, action);
    else commitHistory(history);
    if (exactJob && exactId && currentRequest(generation, action) && draftGeneration.current === draft) {
      assertExactJob(exactJob, exactId, userPrincipalName);
      updateSelectedJob(exactJob);
    }
    if (currentRequest(generation, action) && draftGeneration.current === draft && qualification?.jobId
      && [...history.value, ...(exactJob ? [exactJob] : [])].some(job => job.id === qualification.jobId && job.status === "succeeded")) {
      refreshedQualification.current = qualification.jobId;
      await capability.reload();
    }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();

    if (!active || !searchAction || !providerActionAllowed(capabilityView, false, Math.max(Date.now(), capability.now))
      || !catalog || historyLoading || !searchAction.roles.some(role => hasRole(capability.user, role))
      || busy || !filters || rangeError || operationError) {
      return;
    }

    await perform("search", async (generation, action, signal) => {
      const job = await submitPurviewAuditSearch(tokenMode, filters, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      selectJob(job, "action");
      await loadHistory(0, generation, signal, action);
    });
  }

  async function handleApproveQualification() {
    if (!active || historyLoading || !canQualify || !approvalAcknowledged || !catalog || busy || !filters || rangeError || operationError
      || Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime) > catalog.limits.qualificationWindowHours * 3_600_000) {
      return;
    }

    await perform("approve", async (generation, action, signal) => {
      const approved = await approvePurviewAuditQualification(
        tokenMode,
        filters,
        { signal },
      );
      if (!currentRequest(generation, action)) {
        return;
      }

      setQualification(approved);
      setApprovalAcknowledged(false);
    });
  }

  async function handleRunQualification() {
    if (
      !active || historyLoading || !canQualify || busy || !qualification ||
      qualification.status !== "approved" ||
      !(Date.parse(qualification.expiresAt) > Math.max(Date.now(), capability.now))
    ) {
      return;
    }

    await perform("qualification", async (generation, action, signal) => {
      const job = await startPurviewAuditQualification(qualification.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      setQualification({ ...qualification, jobId: job.id, status: "running" });
      selectJob(job, "action");
      await loadHistory(0, generation, signal, action);
    });
  }

  async function handleView(job: PurviewAuditJob, offset = 0) {
    if (!active || busy || historyLoading) return;
    await perform(`view:${job.id}`, async (generation, action, signal) => {
      selectJob(job, selectedRef.current?.id === job.id ? selectionOrigin.current : "history");
      const page = await readSavedData(
        ["purview-audit-records", job.id, { limit: recordPageSize, offset, updatedAt: job.updatedAt }],
        requestSignal => getPurviewAuditRecords(
          job.id,
          recordPageSize,
          offset,
          { signal: requestSignal },
        ),
        signal,
      );
      if (!currentRequest(generation, action)) {
        return;
      }

      assertExactJob(page.job, job.id, userPrincipalName);
      updateSelectedJob(page.job);
      setRecords(page);
      setRecordOffset(page.offset);
    });
  }

  async function handleResume(job: PurviewAuditJob) {
    if (job.authorizationPrincipalId !== capability.user?.homeAccountId) return;
    await perform(`resume:${job.id}`, async (generation, action, signal) => {
      const draft = draftGeneration.current;
      const resumed = await resumePurviewAuditSearch(job.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      assertExactJob(resumed, job.id, userPrincipalName);
      if (draftGeneration.current === draft) selectJob(resumed, "action");
      await loadHistory(historyOffset, generation, signal, action);
    });
  }

  async function handleCancel(job: PurviewAuditJob) {
    await perform(`cancel:${job.id}`, async (generation, action, signal) => {
      const draft = draftGeneration.current;
      const cancelled = await cancelPurviewAuditSearch(job.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      assertExactJob(cancelled, job.id, userPrincipalName);
      if (draftGeneration.current === draft) selectJob(cancelled, "action");
      await loadHistory(historyOffset, generation, signal, action);
    });
  }

  async function handleDelete(job: PurviewAuditJob) {
    if (!active || historyLoading || actionRequest.current && !actionRequest.current.controller.signal.aborted) return;
    if (
      !window.confirm(
        "Delete this local Audit Search cache? The remote query and source audit events are not deleted.",
      )
    ) {
      return;
    }

    await perform(`delete:${job.id}`, async (generation, action, signal) => {
      await deletePurviewAuditSearch(job.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      if (selectedRef.current?.id === job.id) {
        selectJob(undefined);
      }

      await loadHistory(historyOffset, generation, signal, action);
    });
  }

  async function handleExport(job: PurviewAuditJob) {
    await perform(`export:${job.id}`, async (generation, action, signal) => {
      const blob = await downloadPurviewAuditCsv(job.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      downloadFile(`purview-audit-${job.id}.csv`, blob);
    });
  }

  async function perform(
    key: string,
    operation: (generation: number, action: number, signal: AbortSignal) => Promise<unknown>,
  ) {
    if (!active || key !== "refresh" && historyLoading
      || actionRequest.current && !actionRequest.current.controller.signal.aborted) return;
    if (/^(refresh|search|approve|qualification|resume:|cancel:|delete:)/.test(key)) {
      savedReadRevision.current = crypto.randomUUID();
    }
    const generation = ++requestGeneration.current;
    const action = ++actionGeneration.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    actionRequest.current?.controller.abort();
    const controller = new AbortController();
    actionRequest.current = { key, controller };
    if (key.startsWith("history:")) {
      selectJob(undefined);
      setHistoryLoading(true);
    }
    setBusy(key);
    setError(undefined);

    try {
      await operation(generation, action, controller.signal);
      if (currentRequest(generation, action) && /^(refresh|search|qualification|resume:)/.test(key)) {
        pollBudget.current = undefined;
        setPollPaused(false);
        setPollCycle(current => current + 1);
      }
    } catch (requestError) {
      if (!controller.signal.aborted && currentRequest(generation, action)) {
        clearPrivateSavedState(requestError, key);
        setError(errorMessage(requestError));
        controller.abort();
      }
    } finally {
      if (actionRequest.current?.controller === controller) {
        actionRequest.current = undefined;
      }
      if (currentRequest(generation, action)) {
        setBusy(undefined);
        setHistoryLoading(false);
      }
    }
  }

  if (!active) return null;

  return (
    <section className="purview-audit" aria-label="Microsoft Purview Audit Search">
      <header className="purview-audit-heading">
        <div>
          <h2>Purview Audit Search</h2>
          <p>Search Copilot and Copilot Studio audit metadata for <strong>{userPrincipalName}</strong>.</p>
        </div>
        <button
          type="button"
          className="secondary icon-button control-icon-button"
          aria-label="Refresh Audit Search history"
          title="Refresh Audit Search history"
          disabled={Boolean(busy)}
          onClick={() =>
            void perform("refresh", async (generation, action, signal) => {
              await refreshSaved(generation, action, signal);
            })
          }
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </header>

      {error || capability.error ? <div className="error-banner" role="alert">{error ?? capability.error}</div> : null}
      {pollPaused ? <p role="status">Automatic history refresh paused. Refresh Audit Search history to retry saved reads.</p> : null}
      {busy?.startsWith("export:") ? <p role="status">Exporting saved Audit Search results...</p> : null}

      <form className="purview-search-form" onSubmit={handleSearch}>
        <div className="purview-search-primary">
          <label>
            <span>Authorization</span>
            <select
              value={tokenMode}
              onChange={(event) => {
                setTokenMode(event.target.value as PurviewAuditTokenMode);
                invalidateQualification();
              }}
            >
              <option value="delegated">Delegated</option>
              <option value="application">Application</option>
            </select>
          </label>
          <label>
            <span>Search preset</span>
            <select
              value={presetId}
              onChange={(event) => {
                setPresetId(
                  event.target.value as PurviewAuditFilters["presetId"],
                );
                setOperations(catalog?.presets.find((preset) => preset.id === event.target.value)?.operations ?? []);
                invalidateQualification();
              }}
            >
              {(catalog?.presets ?? [
                {
                  id: "copilot_interactions" as const,
                  label: "Copilot interactions",
                },
                {
                  id: "copilot_studio_admin" as const,
                  label: "Copilot Studio administration",
                },
              ]).map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Start</span>
            <input
              type="datetime-local"
              step="1"
              value={startDateTime}
              onChange={(event) => {
                setStartDateTime(event.target.value);
                invalidateQualification();
              }}
              required
            />
          </label>
          <label>
            <span>End</span>
            <input
              type="datetime-local"
              step="1"
              value={endDateTime}
              onChange={(event) => {
                setEndDateTime(event.target.value);
                invalidateQualification();
              }}
              required
            />
          </label>
        </div>

        <div className="purview-guidance">
          <section className="purview-coverage" aria-label="Available audit logs">
            <h3>Available audit logs</h3>
            <div className="purview-coverage-grid">
              <p><strong>Copilot interactions:</strong> interaction events and actor, app and message IDs.</p>
              <p><strong>Copilot Studio administration:</strong> bot publishing, sharing and changes to bots, components, plugin operations and environment variables. Not bot conversations.</p>
            </div>
            <p>Metadata only: prompt and response text are not included. These logs are separate from usage reports.</p>
            {catalog ? <p>Up to {catalog.limits.maximumWindowHours} hours · {catalog.limits.maximumRows.toLocaleString()} rows · {catalog.limits.maximumPages} pages.</p> : null}
          </section>

          <section className="purview-access" aria-label="Purview access and setup">
            <header>
              <h3>Access and setup</h3>
              <strong>{available ? `${applicationMode ? "Application" : "Delegated"} search ready`
                : decision?.status === "available" ? "Search not ready" : statusLabels[decision?.status ?? "unknown"]}</strong>
            </header>
            {verification ? <p>{verification === "provider" ? "Search access verified." : "Token ready; run a search to verify access."}
              {decision?.checkedAt ? <> Checked {formatDateTime(decision.checkedAt)}.</> : null}</p> : null}
            <p><strong>{applicationMode ? "Application" : "Delegated"} AuditLogsQuery.Read.All</strong> with admin consent.</p>
            <p>Requires Purview Audit entitlement and auditing enabled. {applicationMode
              ? "An Admin must enable application mode, approve shared data scope and run qualification."
              : "The user needs the Audit Logs or View-Only Audit Logs role."}</p>
            {setupIssue ? <p>{setupIssue}</p> : null}
            {operationFailure ? <p role="status">Last search issue: {operationFailure.remediation.join(" ") || statusLabels[operationFailure.status]}</p> : null}
            <div className="purview-row-actions">
              <button type="button" className="secondary"
                disabled={Boolean(busy) || historyLoading || capability.loading || capability.pending || !hasRole(capability.user, "AgentControl.Viewer")}
                onClick={() => void perform("permissions", async () => { await capability.reload(); })}>
                <ShieldCheck aria-hidden="true" /> {capability.loading || capability.pending ? "Checking permissions…" : "Check permissions"}
              </button>
              {!available ? <button type="button" className="secondary" onClick={capability.openPermissions}>Open Permissions</button> : null}
            </div>
            <small>Permission checks never create audit queries.</small>
          </section>
        </div>

        <fieldset className="purview-operation-filters">
          <legend>Operations</legend>
          <div>
            {(catalog?.presets.find((preset) => preset.id === presetId)?.operations ?? operations).map((operation) => (
              <label key={operation}>
                <input
                  type="checkbox"
                  checked={operations.includes(operation)}
                  onChange={(event) => {
                    setOperations((current) => event.target.checked
                      ? [...current, operation].sort()
                      : current.filter((value) => value !== operation));
                    invalidateQualification();
                  }}
                />
                <span>{operation}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {operationError ? (
          <div className="error-banner" role="alert">{operationError}</div>
        ) : null}

        {rangeError || qualificationRangeError ? (
          <div className="error-banner" role="alert">
            {rangeError ?? qualificationRangeError}
          </div>
        ) : null}

        <section className="purview-structured-filters" aria-label="Structured identity filters">
          <h3>Structured identity filters</h3>
          <div>
            <StructuredFilter
              label="User principal names"
              value={userPrincipalName}
              readOnly
              placeholder="reader@contoso.com"
            />
            <StructuredFilter
              label="IP addresses"
              value={ipAddresses}
              placeholder="192.0.2.10"
              onChange={(value) => {
                setIpAddresses(value);
                invalidateQualification();
              }}
            />
            <StructuredFilter
              label="Object IDs"
              value={objectIds}
              placeholder="One ID per line"
              onChange={(value) => {
                setObjectIds(value);
                invalidateQualification();
              }}
            />
            <StructuredFilter
              label="Administrative unit IDs"
              value={administrativeUnitIds}
              placeholder="One GUID per line"
              onChange={(value) => {
                setAdministrativeUnitIds(value);
                invalidateQualification();
              }}
            />
          </div>
        </section>

        {!available && applicationMode ? (
          <section
            className="purview-qualification"
            aria-label="Audit Search qualification required"
          >
            <div>
              <strong>Application qualification required</strong>
              <p>Choose a window of up to {catalog?.limits.qualificationWindowHours ?? 1} hour and the operations to verify.</p>
              {!canQualify ? <p>An Agent Control Admin must approve the application search.</p> : null}
            </div>
            <div className="purview-qualification-actions">
              {canQualify ? (
                <label className="purview-approval-check">
                  <input
                    type="checkbox"
                    checked={approvalAcknowledged}
                    onChange={(event) =>
                      setApprovalAcknowledged(event.target.checked)
                    }
                  />
                  <span>
                    Approve one narrow remote query for contract qualification
                  </span>
                </label>
              ) : null}
              {canQualify ? (
                <button
                  type="button"
                  disabled={
                    !approvalAcknowledged ||
                    !catalog ||
                    !filters ||
                    Boolean(rangeError || qualificationRangeError) ||
                    Boolean(operationError) ||
                    historyLoading ||
                    Boolean(busy)
                  }
                  onClick={() => void handleApproveQualification()}
                >
                  <ShieldCheck aria-hidden="true" /> Approve qualification
                </button>
              ) : null}
              {canQualify && qualification &&
              qualification.status === "approved" &&
              Date.parse(qualification.expiresAt) > capability.now ? (
                <button
                  type="button"
                  disabled={Boolean(busy) || historyLoading}
                  onClick={() => void handleRunQualification()}
                >
                  <Play aria-hidden="true" /> Run approved qualification
                </button>
              ) : null}
            </div>
          </section>
        ) : !available ? (
          <section className="purview-qualification" aria-label="Audit Search authorization pending">
            <div>
              <strong>Delegated authorization is not ready</strong>
              <p>Check permissions above to retry. Missing consent or a Purview role must be set up by your administrator.</p>
            </div>
          </section>
        ) : null}

        <div className="purview-search-actions">
          <WorkbenchActionGate actionId="purview.search">
          <button
            type="submit"
            disabled={
              !available || !catalog || historyLoading || !filters || Boolean(rangeError) || Boolean(busy)
              || Boolean(operationError)
            }
          >
            <Search aria-hidden="true" /> Run Audit Search
          </button>
          </WorkbenchActionGate>
          <span>
            {available
              ? applicationMode ? "Shared application qualification is current." : "Delegated authorization is ready for an explicit bounded search."
              : applicationMode ? "Search remains disabled until shared application setup and qualification succeed." : "Search remains disabled until a permission check establishes delegated authorization."}
          </span>
        </div>
      </form>

      <section
        className="purview-history"
        aria-labelledby="purview-history-title"
      >
        <header>
          <div>
            <h3 id="purview-history-title">Search history</h3>
            <p>
              Saved searches for this user. Delegated results are private; application results use the configured shared scope.
            </p>
          </div>
          <span>{historyCount === undefined ? "Unknown" : historyCount.toLocaleString()} jobs</span>
        </header>
        {historyLoading ? <div className="compact-empty-state" role="status">Loading Audit Search history...</div>
          : historyCount === undefined ? <div className="compact-empty-state"><strong>Audit Search history unavailable</strong><span>Retry saved reads; unavailable evidence is not an empty history.</span></div>
          : jobs.length === 0 ? (
          <div className="compact-empty-state">
            <strong>No Audit Search history</strong>
            <span>
              Run an explicit search to collect records. Saved results are kept for 30 days.
            </span>
          </div>
        ) : (
          <HistoryTable
            busy={Boolean(busy) || historyLoading}
            jobs={jobs}
            principalId={capability.user?.homeAccountId}
            selectedId={selected?.id}
            onCancel={handleCancel}
            onDelete={handleDelete}
            onExport={handleExport}
            onResume={handleResume}
            onView={handleView}
          />
        )}
        {historyCount !== undefined && historyCount > historyPageSize ? (
          <div className="audit-pagination" aria-label="Audit Search history pagination">
            <span>
              Showing {historyOffset + 1}-{Math.min(historyOffset + jobs.length, historyCount)} of {historyCount.toLocaleString()}
            </span>
            <div className="purview-row-actions">
              <button type="button" className="secondary icon-button control-icon-button" aria-label="Previous Audit Search history page"
                title="Previous history page" disabled={Boolean(busy) || historyLoading || historyOffset === 0}
                onClick={() => void perform("history:previous", (generation, action, signal) =>
                  loadHistory(Math.max(0, historyOffset - historyPageSize), generation, signal, action))}>
                <ChevronLeft aria-hidden="true" />
              </button>
              <button type="button" className="secondary icon-button control-icon-button" aria-label="Next Audit Search history page"
                title="Next history page" disabled={Boolean(busy) || historyLoading || historyOffset + jobs.length >= historyCount}
                onClick={() => void perform("history:next", (generation, action, signal) =>
                  loadHistory(historyOffset + historyPageSize, generation, signal, action))}>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {selected && !historyLoading ? (
        <SearchDetail
          job={selected}
          records={records?.job.id === selected.id && readableStatuses.has(selected.status) ? records : undefined}
          recordOffset={recordOffset}
          busy={Boolean(busy) || historyLoading}
          loading={busy === `view:${selected.id}`}
          onPageChange={(offset) => void handleView(selected, offset)}
        />
      ) : null}
    </section>
  );
}

function StructuredFilter({
  label,
  onChange,
  placeholder,
  value,
  readOnly = false,
}: {
  label: string;
  onChange?: (value: string) => void;
  placeholder: string;
  value: string;
  readOnly?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea
        rows={2}
        value={value}
        readOnly={readOnly}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        placeholder={placeholder}
      />
    </label>
  );
}

function assertUserJobs(jobs: PurviewAuditJob[], userPrincipalName: string) {
  if (jobs.some(job => job.filters.userPrincipalNames.length !== 1
    || job.filters.userPrincipalNames[0].toLowerCase() !== userPrincipalName.toLowerCase())) {
    throw new Error("Audit Search history did not match the selected user. Close and reopen this user's audit search.");
  }
}

function assertExactJob(job: PurviewAuditJob, id: string, userPrincipalName: string) {
  assertUserJobs([job], userPrincipalName);
  if (job.id !== id) throw new Error("Audit Search returned a different job. Refresh the search history.");
}

function HistoryTable({
  busy,
  jobs,
  onCancel,
  onDelete,
  onExport,
  onResume,
  onView,
  principalId,
  selectedId,
}: {
  busy: boolean;
  jobs: PurviewAuditJob[];
  onCancel: (job: PurviewAuditJob) => Promise<void>;
  onDelete: (job: PurviewAuditJob) => Promise<void>;
  onExport: (job: PurviewAuditJob) => Promise<void>;
  onResume: (job: PurviewAuditJob) => Promise<void>;
  onView: (job: PurviewAuditJob) => Promise<void>;
  principalId: string | undefined;
  selectedId: string | undefined;
}) {
  return (
    <div
      className="table-shell purview-history-table"
      role="region"
      aria-label="Purview Audit Search history"
    >
      <table>
        <thead>
          <tr>
            <th scope="col">Requested range</th>
            <th scope="col">Filters</th>
            <th scope="col">Actor / scope</th>
            <th scope="col">Provider status</th>
            <th scope="col">Coverage</th>
            <th scope="col">Rows</th>
            <th scope="col">Local expiry</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              className={selectedId === job.id ? "selected-row" : undefined}
            >
              <td>
                <strong>{formatDateTime(job.filters.startDateTime)}</strong>
                <small>to {formatDateTime(job.filters.endDateTime)}</small>
              </td>
              <td>
                <strong>{presetLabel(job.filters.presetId)}</strong>
                <small>
                  {job.filters.operations.length.toLocaleString()} selected operation{job.filters.operations.length === 1 ? "" : "s"}
                </small>
                <small>{identityFilterCount(job.filters)}</small>
              </td>
              <td>
                {job.authorizationPrincipalId}
                <small>
                  {job.tokenMode} / {job.resultScope.kind} / {shortId(job.resultScope.scopeId)}
                </small>
              </td>
              <td>
                <span className={`status ${statusClass(job.status)}`}>
                  {statusLabel(job.status)}
                </span>
                <small>
                  {job.providerStatus ?? "Provider status not supplied"}
                </small>
                {job.message ? <small>{job.errorCode ? `${job.errorCode}: ` : ""}{job.message}</small> : null}
                {job.canResume && job.authorizationPrincipalId !== principalId
                  ? <small>Resume requires the original authorizing account.</small> : null}
                {job.remoteWorkMayContinue ? (
                  <small>Remote work may continue</small>
                ) : null}
              </td>
              <td>
                {job.pageComplete
                  ? "Complete requested range"
                  : job.unobservedRange
                    ? "Requested range not fully observed"
                    : "Pending"}
              </td>
              <td>
                {job.storedRowCount.toLocaleString()}
                <small>{job.pageCount} / 20 pages</small>
              </td>
              <td>{formatDateTime(job.expiresAt)}</td>
              <td>
                <div className="purview-row-actions">
                  {readableStatuses.has(job.status) ? (
                    <IconAction
                      label={`View results ${shortId(job.id)}`}
                      title="View minimized results"
                      disabled={busy}
                      onClick={() => void onView(job)}
                    >
                      <Eye aria-hidden="true" />
                    </IconAction>
                  ) : null}
                  {job.canResume && job.authorizationPrincipalId === principalId ? (
                    <IconAction
                      label={`Resume search ${shortId(job.id)}`}
                      title="Resume with current authorization"
                      disabled={busy}
                      onClick={() => void onResume(job)}
                    >
                      <Play aria-hidden="true" />
                    </IconAction>
                  ) : null}
                  {activeStatuses.has(job.status) ? (
                    <IconAction
                      label={`Cancel local polling ${shortId(job.id)}`}
                      title="Stop local polling; remote work may continue"
                      disabled={busy}
                      onClick={() => void onCancel(job)}
                    >
                      <Pause aria-hidden="true" />
                    </IconAction>
                  ) : null}
                  {readableStatuses.has(job.status) ? (
                    <IconAction
                      label={`Export results ${shortId(job.id)}`}
                      title="Export minimized results CSV"
                      disabled={busy}
                      onClick={() => void onExport(job)}
                    >
                      <Download aria-hidden="true" />
                    </IconAction>
                  ) : null}
                  {!activeStatuses.has(job.status) ? (
                    <IconAction
                      label={`Delete local cache ${shortId(job.id)}`}
                      title="Delete local cache only"
                      disabled={busy}
                      onClick={() => void onDelete(job)}
                    >
                      <Trash2 aria-hidden="true" />
                    </IconAction>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IconAction({
  children,
  disabled,
  label,
  onClick,
  title,
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      className="secondary icon-button control-icon-button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SearchDetail({
  busy,
  loading,
  job,
  onPageChange,
  recordOffset,
  records,
}: {
  busy: boolean;
  loading: boolean;
  job: PurviewAuditJob;
  onPageChange: (offset: number) => void;
  recordOffset: number;
  records: PurviewAuditRecordPage | undefined;
}) {
  const pageStart = records?.count ? recordOffset + 1 : 0;
  const pageEnd = records
    ? Math.min(recordOffset + records.value.length, records.count)
    : 0;

  return (
    <section
      className="purview-results"
      aria-labelledby="purview-results-title"
    >
      <header>
        <div>
          <h3 id="purview-results-title">Minimized results</h3>
          <p>
            Provider query <code>{job.providerQueryId ?? "not assigned"}</code>
            {" / "}local job <code>{job.id}</code>
          </p>
        </div>
        <span>
          {records
            ? `${records.count.toLocaleString()} records`
            : statusLabel(job.status)}
        </span>
      </header>

      <div className="purview-result-facts">
        <ResultFact
          label="Authorizing actor"
          value={job.authorizationPrincipalId}
        />
        <ResultFact
          label="Result scope"
          value={`${job.resultScope.kind}: ${job.resultScope.scopeId}${job.resultScope.configurationRevision === null ? "" : ` (configuration ${job.resultScope.configurationRevision})`}`}
        />
        <ResultFact
          label="Selected operations"
          value={job.filters.operations.join(", ")}
        />
        <ResultFact
          label="Structured filters"
          value={identityFilterSummary(job.filters)}
        />
        <ResultFact
          label="Provider status"
          value={job.providerStatus ?? "Not supplied"}
        />
        <ResultFact
          label="Observed range"
          value={
            job.observedRange
              ? `${formatDateTime(job.observedRange.startDateTime)} to ${formatDateTime(job.observedRange.endDateTime)}`
              : "Not supplied"
          }
        />
        <ResultFact
          label="Page completeness"
          value={job.pageComplete ? "Complete" : "Incomplete"}
        />
        <ResultFact
          label="Unknown fields omitted"
          value={job.unknownFieldCount.toLocaleString()}
        />
        <ResultFact label="Provider / local request" value={`${job.providerRequestId ?? "Not supplied"} / ${job.localRequestId}`} />
        <ResultFact label="Request / activation budget" value={`${job.providerRequestCount} / 64 requests; ${job.activationCount} / 12 activations`} />
        <ResultFact label="Projection" value={`Version ${job.projectionVersion}`} />
        <ResultFact
          label="Saved / local expiry"
          value={`${formatDateTime(job.updatedAt)} / ${formatDateTime(job.expiresAt)}`}
        />
      </div>

      {job.unobservedRange ? (
        <div className="report-status error">
          <strong>Partial coverage</strong>
          <p>
            The requested range is not completely observed. Unobserved: {" "}
            {formatDateTime(job.unobservedRange.startDateTime)} to {" "}
            {formatDateTime(job.unobservedRange.endDateTime)}.
          </p>
        </div>
      ) : null}

      {job.message ? (
        <div className="report-status">
          <strong>{job.errorCode ?? statusLabel(job.status)}</strong>
          <p>{job.message}</p>
        </div>
      ) : null}

      {loading ? <div className="compact-empty-state" role="status">Loading minimized results...</div> : !records ? (
        <div className="compact-empty-state">
          {readableStatuses.has(job.status) ? <button type="button" className="secondary" disabled={busy} onClick={() => onPageChange(0)}>
            <Eye aria-hidden="true" /> Load minimized results
          </button> : <span>
            Select View results after a search reaches a saved terminal state.
          </span>}
        </div>
      ) : records.value.length === 0 ? (
        <div className="compact-empty-state">
          <strong>No matching metadata records</strong>
          <span>{job.pageComplete ? "The provider lifecycle completed for the requested range."
            : "Empty saved results do not establish complete coverage of the requested range."}</span>
        </div>
      ) : (
        <>
          <div
            className="table-shell purview-results-table"
            role="region"
            aria-label="Purview audit records"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Object / agent</th>
                  <th scope="col">Source</th>
                  <th scope="col">Messages</th>
                  <th scope="col">Association</th>
                </tr>
              </thead>
              <tbody>
                {records.value.map((record) => (
                  <RecordRow key={record.wrapperId} record={record} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="audit-pagination" aria-label="Audit result pagination">
            <span>
              Showing {pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of {" "}
              {records.count.toLocaleString()}
            </span>
            <div className="purview-row-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy || recordOffset === 0}
                onClick={() =>
                  onPageChange(Math.max(0, recordOffset - recordPageSize))
                }
              >
                Previous
              </button>
              <button
                type="button"
                className="secondary"
                disabled={
                  busy || recordOffset + records.value.length >= records.count
                }
                onClick={() => onPageChange(recordOffset + recordPageSize)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function RecordRow({ record }: { record: PurviewAuditRecord }) {
  return (
    <tr>
      <td>
        {formatDateTime(record.eventDateTime)}
        <small>
          {record.nativeEventId ?? `Wrapper ${shortId(record.wrapperId)}`}
        </small>
      </td>
      <td>
        <strong>{record.operation}</strong>
        <small>{record.resultStatus ?? "Result not supplied"}</small>
      </td>
      <td>
        {record.actorUserPrincipalName ??
          record.actorUserId ??
          "Actor not supplied"}
        {record.clientIp ? <small>IP: {record.clientIp}</small> : null}
      </td>
      <td>
        {record.botId ??
          record.agentId ??
          record.objectId ??
          "Object not supplied"}
        {record.environmentId ? <small>Environment: {record.environmentId}</small> : null}
        {record.botComponentId ? <small>Component: {record.botComponentId}</small> : null}
        {record.aiPluginOperationId ? <small>Plugin operation: {record.aiPluginOperationId}</small> : null}
      </td>
      <td>
        {record.service}
        <small>{record.auditLogRecordType}</small>
        {record.appHost ? <small>Host: {record.appHost}</small> : null}
        {record.appIdentity ? <small>App: {record.appIdentity}</small> : null}
        {record.correlationId ? <small>Correlation: {record.correlationId}</small> : null}
      </td>
      <td>
        {record.messages.length === 0
          ? "No message identifiers"
          : record.messages.map((message) => (
              <code key={`${message.id}:${message.isPrompt}`}>
                {message.isPrompt ? "Prompt ID" : "Response ID"}: {message.id}
              </code>
            ))}
      </td>
      <td>
        {associationLabel(record.association)}
        {record.unknownFieldCount ? (
          <small>{record.unknownFieldCount} unknown fields omitted</small>
        ) : null}
      </td>
    </tr>
  );
}

function ResultFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function identityFilterCount(filters: PurviewAuditFilters) {
  const count = filters.userPrincipalNames.length + filters.ipAddresses.length
    + filters.objectIds.length + filters.administrativeUnitIds.length;
  return `${count.toLocaleString()} structured identity filter${count === 1 ? "" : "s"}`;
}

function identityFilterSummary(filters: PurviewAuditFilters) {
  const values = [
    ["Users", filters.userPrincipalNames],
    ["IPs", filters.ipAddresses],
    ["Objects", filters.objectIds],
    ["Administrative units", filters.administrativeUnitIds],
  ] as const;
  const selected = values
    .filter(([, entries]) => entries.length)
    .map(([label, entries]) => `${label}: ${entries.join(", ")}`);
  return selected.length ? selected.join("; ") : "No structured identity filters";
}

function makeFilters(input: {
  administrativeUnitIds: string;
  endDateTime: string;
  ipAddresses: string;
  objectIds: string;
  operations: string[];
  presetId: PurviewAuditFilters["presetId"];
  startDateTime: string;
  userPrincipalNames: string;
}): PurviewAuditFilters | undefined {
  const start = exactUtc(input.startDateTime);
  const end = exactUtc(input.endDateTime);

  if (!start || !end) {
    return undefined;
  }

  return {
    presetId: input.presetId,
    operations: [...input.operations].sort(),
    startDateTime: start,
    endDateTime: end,
    userPrincipalNames: list(input.userPrincipalNames),
    ipAddresses: list(input.ipAddresses),
    objectIds: list(input.objectIds),
    administrativeUnitIds: list(input.administrativeUnitIds),
  };
}

function getRangeError(
  filters: PurviewAuditFilters | undefined,
  catalog: PurviewAuditCatalog | undefined,
) {
  if (!filters) {
    return "Enter a valid start and end time.";
  }

  const duration =
    Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime);
  const maximumHours = catalog?.limits.maximumWindowHours ?? 168;

  if (duration <= 0) {
    return "End must be later than start.";
  }

  if (duration > maximumHours * 60 * 60_000) {
    return `The requested range must not exceed ${maximumHours} hours.`;
  }

  return undefined;
}

function list(value: string) {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function exactUtc(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function localDateTime(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function presetLabel(value: PurviewAuditFilters["presetId"]) {
  return value === "copilot_interactions"
    ? "Copilot interactions"
    : "Copilot Studio administration";
}

function formatDateTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed);
}

function statusLabel(value: PurviewAuditJob["status"]) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function statusClass(value: PurviewAuditJob["status"]) {
  if (value === "succeeded") {
    return "allowed";
  }

  if (["failed", "inconclusive", "partial"].includes(value)) {
    return "blocked";
  }

  return "pending";
}

function associationLabel(value: PurviewAuditRecord["association"]) {
  if (!value) {
    return "Unresolved";
  }

  if (value.status === "resolved") {
    return `Exact ${value.resourceType}: ${value.nativeId}`;
  }

  if (value.status === "ambiguous") {
    return `${value.candidateCount} exact candidates`;
  }

  return value.reason.replaceAll("_", " ");
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Audit Search request failed.";
}