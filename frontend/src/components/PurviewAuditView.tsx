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
import { providerActionAllowed } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";
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
      view.decision.fresh,
      view.decision.checkedAt ?? "",
      view.decision.expiresAt ?? "",
      view.decision.previewQualification,
      view.decision.verification ?? "",
      view.enabled ?? "",
      view.configuration?.enabled ?? "",
      view.configuration?.sharedDataScope ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

export function PurviewAuditView({
  initialJobId,
  initialUserPrincipalName,
  onSelectedJobChange,
}: {
  initialJobId?: string;
  initialUserPrincipalName?: string;
  onSelectedJobChange?: (jobId: string | undefined) => void;
} = {}) {
  const capability = useCapabilityContext();
  const accountKey = JSON.stringify([capability.user?.tenantId, capability.user?.homeAccountId, [...(capability.user?.roles ?? [])].sort()]);
  return <PurviewAuditSession key={`${accountKey}:${purviewCapabilityKey(capability.views)}:${initialUserPrincipalName ?? ""}`} initialJobId={initialJobId} initialUserPrincipalName={initialUserPrincipalName} onSelectedJobChange={onSelectedJobChange} />;
}

function PurviewAuditSession({
  initialJobId,
  initialUserPrincipalName,
  onSelectedJobChange,
}: {
  initialJobId?: string;
  initialUserPrincipalName?: string;
  onSelectedJobChange?: (jobId: string | undefined) => void;
}) {
  const capability = useCapabilityContext();
  const readSaved = useSavedRead();
  const searchAction = useWorkbenchAction("purview.search");
  const requestGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const savedReadRevision = useRef<string | undefined>(undefined);
  const actionController = useRef<AbortController | undefined>(undefined);
  const savedController = useRef(new AbortController());
  const detailController = useRef<AbortController | undefined>(undefined);
  const resolvedRouteJobId = useRef<string | undefined>(undefined);
  const selectionOrigin = useRef<"history" | "route">("route");
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
  const [userPrincipalNames, setUserPrincipalNames] = useState(initialUserPrincipalName ?? "");
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

  function selectJob(job: PurviewAuditJob | undefined, origin: "history" | "route" = "history", notify = true) {
    if (job) assertUserJobs([job], initialUserPrincipalName);
    selectedRef.current = job;
    selectionOrigin.current = origin;
    resolvedRouteJobId.current = job?.id;
    setSelected(job);
    setRecords(undefined);
    setRecordOffset(0);
    if (notify) onSelectedJobChange?.(job?.id);
  }

  function invalidateQualification() {
    actionGeneration.current += 1;
    actionController.current?.abort();
    detailController.current?.abort();
    setQualification(undefined);
    setApprovalAcknowledged(false);
    setBusy(undefined);
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
    detailController.current?.abort();
    actionController.current?.abort();
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
    const currentKey = revision ? [...key, { revision }] : key;
    try {
      return await readSaved(currentKey, read, currentSignal);
    } catch (requestError) {
      if (!currentSignal.aborted && requestGeneration.current === generation) failSavedRead(requestError, context);
      throw requestError;
    }
  }, [failSavedRead, readSaved]);

  function clearPrivateSavedState(requestError: unknown) {
    if (requestError instanceof ApiError && (requestError.status === 401 || requestError.status === 403)
      && !providerAuthorizationErrors.has(requestError.code)) failSavedRead(requestError);
  }

  function commitHistory(history: Awaited<ReturnType<typeof getPurviewAuditJobs>>) {
    assertUserJobs(history.value, initialUserPrincipalName);
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
      if (!readableStatuses.has(updated.status) || updated.updatedAt !== current.updatedAt) setRecords(undefined);
    } else if (selectionOrigin.current !== "route") {
      selectJob(undefined);
    }
  }

  async function loadHistory(
    offset: number,
    generation: number,
    signal: AbortSignal,
    action?: number,
  ) {
    const historyRequest = ++historyGeneration.current;
    const history = await readSavedData(
      ["purview-audit-jobs", { limit: historyPageSize, offset, userPrincipalName: initialUserPrincipalName }, action],
      requestSignal => getPurviewAuditJobs(historyPageSize, offset, { signal: requestSignal, userPrincipalName: initialUserPrincipalName }),
      signal,
    );
    if (signal.aborted || !currentRequest(generation, action) || historyRequest !== historyGeneration.current) {
      return;
    }

    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (offset > lastOffset) return loadHistory(lastOffset, generation, signal, action);
    commitHistory(history);
  }

  const pollHistory = useEffectEvent(async (signal: AbortSignal) => {
    if (busy || actionController.current && !actionController.current.signal.aborted) return;
    const generation = requestGeneration.current;
    try {
      await loadHistory(historyOffset, generation, signal);
      if (signal.aborted || !currentRequest(generation)) return;
      const current = selectedRef.current;
      if (current && selectionOrigin.current === "route" && activeStatuses.has(current.status)) {
        const job = await readSavedData(["purview-audit-job", current.id], requestSignal => getPurviewAuditJob(current.id, { signal: requestSignal }), signal);
        if (!signal.aborted && currentRequest(generation) && selectedRef.current?.id === job.id) {
          assertUserJobs([job], initialUserPrincipalName);
          selectedRef.current = job;
          setSelected(job);
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

  useEffect(() => {
    const generation = ++requestGeneration.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    const controller = new AbortController();

    Promise.all([
      readSavedData(["purview-audit-catalog"], signal => getPurviewAuditCatalog({ signal }), controller.signal),
      readSavedData(
        ["purview-audit-jobs", { limit: historyPageSize, offset: 0, userPrincipalName: initialUserPrincipalName }],
        signal => getPurviewAuditJobs(historyPageSize, 0, { signal, userPrincipalName: initialUserPrincipalName }),
        controller.signal,
      ),
    ])
      .then(([catalogResult, history]) => {
        if (controller.signal.aborted || !currentRequest(generation)) {
          return;
        }

        assertUserJobs(history.value, initialUserPrincipalName);
        setCatalog(catalogResult);
        setJobs(history.value);
        setHistoryCount(history.count);
        setHistoryOffset(history.offset);
        setHistoryLoading(false);
      })
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted && currentRequest(generation)) {
          failSavedRead(requestError);
        }
      });

    return () => {
      controller.abort();
      savedController.current.abort();
      requestGeneration.current += 1;
    };
  }, [failSavedRead, readSavedData, initialUserPrincipalName]);

  useEffect(() => () => actionController.current?.abort(), []);

  useEffect(() => {
    if (resolvedRouteJobId.current === initialJobId && (initialJobId !== undefined || !selectedRef.current)) return;
    resolvedRouteJobId.current = initialJobId;
    selectionOrigin.current = "route";
    actionGeneration.current += 1;
    actionController.current?.abort();
    detailController.current?.abort();
    const generation = requestGeneration.current;
    const action = actionGeneration.current;
    const controller = new AbortController();
    detailController.current = controller;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      selectedRef.current = undefined;
      setSelected(undefined);
      setRecords(undefined);
      setRecordOffset(0);
      setBusy(undefined);
      setQualification(undefined);
      setApprovalAcknowledged(false);
      if (!initialJobId || savedController.current.signal.aborted) return undefined;
      return readSavedData(
        ["purview-audit-job", initialJobId],
        signal => getPurviewAuditJob(initialJobId, { signal }),
        controller.signal,
        "The exact Audit Search job is expired, deleted, or unavailable to this account. ",
      );
    })
      .then(job => {
        if (job && !controller.signal.aborted && currentRequest(generation, action)) {
          assertUserJobs([job], initialUserPrincipalName);
          selectedRef.current = job;
          setSelected(job);
        }
      })
      .catch(requestError => {
        if (!controller.signal.aborted && requestGeneration.current === generation) {
          failSavedRead(requestError, "The exact Audit Search job is expired, deleted, or unavailable to this account. ");
        }
      });
    return () => {
      controller.abort();
      if (detailController.current === controller && resolvedRouteJobId.current === initialJobId) resolvedRouteJobId.current = undefined;
    };
  }, [failSavedRead, initialJobId, initialUserPrincipalName, readSavedData]);

  useEffect(() => {
    if (!qualification) {
      return;
    }

    const remaining = Date.parse(qualification.expiresAt) - capability.now;
    const timer = window.setTimeout(() => {
      setQualification((current) =>
        current?.id === qualification.id ? undefined : current,
      );
    }, Math.max(remaining, 0));
    return () => window.clearTimeout(timer);
  }, [capability.now, qualification]);

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
  }, [hasProgressingJobs, pollCycle, pollPaused]);

  useEffect(() => {
    const qualificationJob = qualification?.jobId
      ? jobs.find((job) => job.id === qualification.jobId)
      : undefined;

    if (qualificationJob?.status === "succeeded" && refreshedQualification.current !== qualificationJob.id) {
      refreshedQualification.current = qualificationJob.id;
      void reloadCapability().catch(requestError => setError(errorMessage(requestError)));
    }
  }, [jobs, qualification]);

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
  const canQualify = applicationMode && hasRole(capability.user, "AgentControl.Admin");
  const filters = makeFilters({
    administrativeUnitIds,
    endDateTime,
    ipAddresses,
    objectIds,
    operations,
    presetId,
    startDateTime,
    userPrincipalNames: initialUserPrincipalName ?? userPrincipalNames,
  });
  const rangeError = getRangeError(filters, catalog);
  const operationError = operations.length ? undefined : "Select at least one supported operation.";
  const qualificationRangeError = applicationMode && !available && filters
    && Date.parse(filters.endDateTime) - Date.parse(filters.startDateTime) > (catalog?.limits.qualificationWindowHours ?? 1) * 3_600_000
    ? `Qualification must not exceed ${catalog?.limits.qualificationWindowHours ?? 1} hours.` : undefined;

  async function refreshSaved(generation: number, action: number, signal: AbortSignal) {
    const exactId = selectionOrigin.current === "route" ? selectedRef.current?.id ?? initialJobId : undefined;
    setHistoryLoading(true);
    const [nextCatalog, history, exactJob] = await Promise.all([
      readSavedData(["purview-audit-catalog", action], requestSignal => getPurviewAuditCatalog({ signal: requestSignal }), signal),
      readSavedData(["purview-audit-jobs", { limit: historyPageSize, offset: historyOffset, userPrincipalName: initialUserPrincipalName }, action],
        requestSignal => getPurviewAuditJobs(historyPageSize, historyOffset, { signal: requestSignal, userPrincipalName: initialUserPrincipalName }), signal),
      exactId ? readSavedData(["purview-audit-job", exactId, action],
        requestSignal => getPurviewAuditJob(exactId, { signal: requestSignal }), signal,
        "The exact Audit Search job is expired, deleted, or unavailable to this account. ") : undefined,
    ]);
    if (signal.aborted || !currentRequest(generation, action)) return;
    setCatalog(nextCatalog);
    const lastOffset = Math.max(Math.ceil(history.count / historyPageSize) - 1, 0) * historyPageSize;
    if (historyOffset > lastOffset) await loadHistory(lastOffset, generation, signal, action);
    else commitHistory(history);
    if (exactJob && currentRequest(generation, action)) selectJob(exactJob, "route", false);
    if (currentRequest(generation, action) && qualification?.jobId
      && [...history.value, ...(exactJob ? [exactJob] : [])].some(job => job.id === qualification.jobId && job.status === "succeeded")) {
      refreshedQualification.current = qualification.jobId;
      await capability.reload();
    }
  }

  async function handleSearch(event: FormEvent) {
    event.preventDefault();

    if (!searchAction || !available || !catalog || !searchAction.roles.some(role => hasRole(capability.user, role))
      || busy || !filters || rangeError || operationError) {
      return;
    }

    await perform("search", async (generation, action, signal) => {
      const job = await submitPurviewAuditSearch(tokenMode, filters, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      selectJob(job, "route");
      await loadHistory(0, generation, signal, action);
    });
  }

  async function handleApproveQualification() {
    if (!canQualify || !approvalAcknowledged || !catalog || busy || !filters || rangeError || operationError
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
      !canQualify || busy || !qualification ||
      qualification.status !== "approved" ||
      !(Date.parse(qualification.expiresAt) > capability.now)
    ) {
      return;
    }

    await perform("qualification", async (generation, action, signal) => {
      const job = await startPurviewAuditQualification(qualification.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      setQualification({ ...qualification, jobId: job.id, status: "running" });
      selectJob(job, "route");
      await loadHistory(0, generation, signal, action);
    });
  }

  async function handleView(job: PurviewAuditJob, offset = 0) {
    if (busy || historyLoading) return;
    selectJob(job, selectedRef.current?.id === job.id ? selectionOrigin.current : "history", selectedRef.current?.id !== job.id);
    await perform(`view:${job.id}`, async (generation, action, signal) => {
      const page = await readSavedData(
        ["purview-audit-records", job.id, { limit: recordPageSize, offset }, action],
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

      assertUserJobs([page.job], initialUserPrincipalName);
      selectedRef.current = page.job;
      setSelected(page.job);
      setRecords(page);
      setRecordOffset(page.offset);
    });
  }

  async function handleResume(job: PurviewAuditJob) {
    await perform(`resume:${job.id}`, async (generation, action, signal) => {
      const resumed = await resumePurviewAuditSearch(job.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      selectJob(resumed, "route");
      await loadHistory(historyOffset, generation, signal, action);
    });
  }

  async function handleCancel(job: PurviewAuditJob) {
    await perform(`cancel:${job.id}`, async (generation, action, signal) => {
      const cancelled = await cancelPurviewAuditSearch(job.id, { signal });
      if (!currentRequest(generation, action)) {
        return;
      }

      selectJob(cancelled, "route");
      await loadHistory(historyOffset, generation, signal, action);
    });
  }

  async function handleDelete(job: PurviewAuditJob) {
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

      if (selectedRef.current?.id === job.id || initialJobId === job.id) {
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

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = `purview-audit-${job.id}.csv`;
      document.body.append(anchor);
      anchor.click();
      window.setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 0);
    });
  }

  async function perform(
    key: string,
    operation: (generation: number, action: number, signal: AbortSignal) => Promise<void>,
  ) {
    if (actionController.current && !actionController.current.signal.aborted) return;
    savedReadRevision.current = crypto.randomUUID();
    const generation = ++requestGeneration.current;
    const action = ++actionGeneration.current;
    savedController.current.abort();
    savedController.current = new AbortController();
    detailController.current?.abort();
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
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
        clearPrivateSavedState(requestError);
        setError(errorMessage(requestError));
        controller.abort();
      }
    } finally {
      if (actionController.current === controller) {
        actionController.current = undefined;
      }
      if (currentRequest(generation, action)) {
        setBusy(undefined);
        setHistoryLoading(false);
      }
    }
  }

  return (
    <section className="purview-audit" aria-label="Microsoft Purview Audit Search">
      <header className="purview-audit-heading">
        <div>
          <p className="eyebrow">Microsoft Graph v1.0</p>
          <h2>Purview Audit Search</h2>
          {initialUserPrincipalName ? <p>Selected user: <strong>{initialUserPrincipalName}</strong>. Search history and new searches are limited to this user.</p> : null}
          <p>
            {catalog?.evidenceNotice ??
              "Compliance and security evidence, separate from official usage."}
          </p>
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

      {error ? (
        <div className="error-banner" role="alert">
          {error}
          {initialJobId ? <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => {
            selectJob(undefined);
            void perform("refresh", refreshSaved);
          }}>Return to Audit Search history</button> : null}
        </div>
      ) : null}
      {pollPaused ? <p role="status">Automatic history refresh paused. Refresh Audit Search history to retry saved reads.</p> : null}

      <div className="purview-evidence-strip" role="note">
        <span>
          <ShieldCheck aria-hidden="true" />
          {catalog?.contentNotice ?? "Content not present in Purview audit."}
        </span>
        <span>
          {catalog?.retentionNotice ??
            "Local retention is separate from provider retention."}
        </span>
      </div>

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

        <details className="purview-structured-filters" open={initialUserPrincipalName ? true : undefined}>
          <summary>Structured identity filters</summary>
          <div>
            <StructuredFilter
              label="User principal names"
              value={userPrincipalNames}
              readOnly={Boolean(initialUserPrincipalName)}
              placeholder="reader@contoso.com"
              onChange={(value) => {
                setUserPrincipalNames(value);
                invalidateQualification();
              }}
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
        </details>

        {!available && applicationMode ? (
          <section
            className="purview-qualification"
            aria-label="Audit Search qualification required"
          >
            <div>
              <strong>Live lifecycle not qualified</strong>
              {(decision?.remediation ?? [
                "Open Permissions to review the exact Audit Search contract.",
              ]).map((item) => (
                <p key={item}>{item}</p>
              ))}
            </div>
            <div className="purview-qualification-actions">
              <button
                type="button"
                className="secondary"
                onClick={capability.openPermissions}
              >
                Open Permissions
              </button>
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
                  disabled={Boolean(busy)}
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
              <p>Automatic safe permission checks run while this signed-in session is active. No audit search is submitted by those checks.</p>
            </div>
            <button type="button" className="secondary" onClick={capability.openPermissions}>Open Permissions</button>
          </section>
        ) : null}

        <div className="purview-search-actions">
          <WorkbenchActionGate actionId="purview.search">
          <button
            type="submit"
            disabled={
              !available || !catalog || !filters || Boolean(rangeError) || Boolean(busy)
              || Boolean(operationError)
            }
          >
            <Search aria-hidden="true" /> Run Audit Search
          </button>
          </WorkbenchActionGate>
          <span>
            {available
              ? applicationMode ? "Shared application qualification is current." : "Delegated authorization is ready for an explicit bounded search."
              : applicationMode ? "Search remains disabled until shared application setup and qualification succeed." : "Search remains disabled until automatic permission checks establish delegated authorization."}
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
              Delegated results stay private to the principal. Application
              results are shared only within the current configured scope.
              Cancellation and deletion do not stop or remove remote Purview work.
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
              Completed minimized results remain available until local expiry.
            </span>
          </div>
        ) : (
          <HistoryTable
            busy={Boolean(busy) || historyLoading}
            jobs={jobs}
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
                title="Previous history page" disabled={Boolean(busy) || historyOffset === 0}
                onClick={() => void perform("history:previous", (generation, action, signal) =>
                  loadHistory(Math.max(0, historyOffset - historyPageSize), generation, signal, action))}>
                <ChevronLeft aria-hidden="true" />
              </button>
              <button type="button" className="secondary icon-button control-icon-button" aria-label="Next Audit Search history page"
                title="Next history page" disabled={Boolean(busy) || historyOffset + jobs.length >= historyCount}
                onClick={() => void perform("history:next", (generation, action, signal) =>
                  loadHistory(historyOffset + historyPageSize, generation, signal, action))}>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {selected ? (
        <SearchDetail
          job={selected}
          records={records?.job.id === selected.id && readableStatuses.has(selected.status) ? records : undefined}
          recordOffset={recordOffset}
          busy={Boolean(busy) || historyLoading}
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
  onChange: (value: string) => void;
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
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function assertUserJobs(jobs: PurviewAuditJob[], userPrincipalName?: string) {
  if (userPrincipalName && jobs.some(job => job.filters.userPrincipalNames.length !== 1
    || job.filters.userPrincipalNames[0].toLowerCase() !== userPrincipalName.toLowerCase())) {
    throw new Error("Audit Search history did not match the selected user. Close and reopen this user's audit search.");
  }
}

function HistoryTable({
  busy,
  jobs,
  onCancel,
  onDelete,
  onExport,
  onResume,
  onView,
  selectedId,
}: {
  busy: boolean;
  jobs: PurviewAuditJob[];
  onCancel: (job: PurviewAuditJob) => Promise<void>;
  onDelete: (job: PurviewAuditJob) => Promise<void>;
  onExport: (job: PurviewAuditJob) => Promise<void>;
  onResume: (job: PurviewAuditJob) => Promise<void>;
  onView: (job: PurviewAuditJob) => Promise<void>;
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
                  {job.canResume ? (
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
  job,
  onPageChange,
  recordOffset,
  records,
}: {
  busy: boolean;
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

      {!records ? (
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
        <small>{record.clientIp ?? "IP not supplied"}</small>
      </td>
      <td>
        {record.botId ??
          record.agentId ??
          record.objectId ??
          "Object not supplied"}
        <small>{record.environmentId ?? "Environment not supplied"}</small>
      </td>
      <td>
        {record.service}
        <small>{record.auditLogRecordType}</small>
      </td>
      <td>
        {record.messages.length === 0
          ? "No message identifiers"
          : record.messages.map((message) => (
              <code key={`${message.id}:${message.isPrompt}`}>
                {message.isPrompt ? "Prompt ID" : "Response ID"}: {message.id}
              </code>
            ))}
        <small>Content not present in Purview audit</small>
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