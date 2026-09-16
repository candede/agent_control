import { useEffect, useRef, useState } from "react";
import { Check, FileText, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  acceptOfficialUsageBundle,
  acknowledgeLegacyUsageCleanup,
  confirmOfficialUsageSetOperation,
  discardOfficialUsageStaging,
  getOfficialUsageAdminState,
  previewOfficialUsageBundle,
  previewOfficialUsageSetOperation,
  stageOfficialUsageReport,
  type OfficialUsageAdminState,
  type OfficialUsageBundlePreview,
  type OfficialUsageConfirmation,
  type OfficialUsageStagingPreview,
} from "../api/client";
import { clearLegacyUsageStorage, hasLegacyUsageStorage } from "../legacyUsageStorage";

const reportGuideUrl = "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide";

export function OfficialUsageImportPanel({
  initialStagingId,
  onChanged,
  onLegacyCleared,
}: {
  initialStagingId?: string;
  onChanged: () => void;
  onLegacyCleared?: () => void;
}) {
  const [adminState, setAdminState] = useState<OfficialUsageAdminState>();
  const [files, setFiles] = useState<File[]>([]);
  const [correctionMode, setCorrectionMode] = useState(false);
  const [bundlePreview, setBundlePreview] = useState<OfficialUsageBundlePreview>();
  const [confirmation, setConfirmation] = useState<OfficialUsageConfirmation>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [legacyPresent, setLegacyPresent] = useState(hasLegacyUsageStorage);
  const [completedImport, setCompletedImport] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingBundleId = useRef<string | undefined>(undefined);
  const confirmationReturnFocus = useRef<HTMLElement | null>(null);
  const loadGeneration = useRef(0);
  const previews = bundlePreview?.staging ?? [];

  function applyBundlePreview(preview: OfficialUsageBundlePreview) {
    pendingBundleId.current = preview.bundleId;
    setBundlePreview(preview);
    setCorrectionMode(preview.staging.some(stage => Boolean(stage.correctionOfSetId)));
  }

  async function refresh(preferredBundleId: string | null | undefined = pendingBundleId.current) {
    const generation = ++loadGeneration.current;
    try {
      const state = await getOfficialUsageAdminState();
      if (generation !== loadGeneration.current) return;
      setAdminState(state);
      const retainedBundle = state.staging.some(stage => stage.status === "active" && stage.bundleId === preferredBundleId)
        || state.sets.some(reportSet => !reportSet.deletedAt && reportSet.bundleId === preferredBundleId);
      const bundleId = preferredBundleId === null ? undefined : retainedBundle ? preferredBundleId : state.staging.find(stage => stage.status === "active")?.bundleId;
      if (bundleId) {
        const preview = await previewOfficialUsageBundle(bundleId);
        if (generation === loadGeneration.current) applyBundlePreview(preview);
      }
      else {
        pendingBundleId.current = undefined;
        setBundlePreview(undefined);
        if (preferredBundleId) {
          setMessage({ tone: "error", text: "The staged bundle is no longer available. It may have expired or been discarded. Choose the CSV files to import again." });
        }
      }
      return state;
    } catch (error) {
      if (generation === loadGeneration.current) setMessage({ tone: "error", text: errorMessage(error) });
      return undefined;
    }
  }

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      setAdminState(undefined);
      setBundlePreview(undefined);
      pendingBundleId.current = undefined;
      setMessage(undefined);
      return getOfficialUsageAdminState({ signal: controller.signal });
    })
      .then(async state => {
        if (!state || controller.signal.aborted || generation !== loadGeneration.current) return;
        setAdminState(state);
        const exactStage = initialStagingId
          ? state.staging.find(stage => stage.id === initialStagingId && stage.status === "active")
          : undefined;
        if (initialStagingId && !exactStage) {
          setMessage({ tone: "error", text: "The exact staging record is expired, deleted, or unavailable to this account." });
          return;
        }
        const bundleId = exactStage?.bundleId ?? state.staging.find(stage => stage.status === "active")?.bundleId;
        if (bundleId) {
          const preview = await previewOfficialUsageBundle(bundleId, { signal: controller.signal });
          if (!controller.signal.aborted && generation === loadGeneration.current) applyBundlePreview(preview);
        }
      })
      .catch(error => {
        if (!controller.signal.aborted && generation === loadGeneration.current) {
          setMessage({ tone: "error", text: errorMessage(error) });
        }
      });
    return () => {
      controller.abort();
      if (generation === loadGeneration.current) loadGeneration.current += 1;
    };
  }, [initialStagingId]);

  async function stageFiles() {
    if (!files.length || !adminState) {
      setMessage({ tone: "error", text: !files.length ? "Choose the original CSV files to import." : "Wait for import state to load, or refresh it before importing." });
      return;
    }
    const existingSet = adminState.sets.find(reportSet => reportSet.bundleId === pendingBundleId.current);
    setBusy(true);
    setCompletedImport(false);
    setMessage(undefined);
    const bundleId = pendingBundleId.current ?? crypto.randomUUID();
    const staged = new Map<string, OfficialUsageStagingPreview>();
    const failures: string[] = [];
    const rejectedFiles: File[] = [];
    for (const file of files) {
      try {
        const preview = await stageOfficialUsageReport(file, {
          bundleId,
          correctionOfSetId: existingSet?.supersedesSetId ?? (correctionMode ? adminState.activeSetId ?? undefined : undefined),
        });
        staged.set(preview.kind, preview);
      } catch (error) {
        rejectedFiles.push(file);
        failures.push(`${file.name}: ${errorMessage(error)}`);
      }
    }
    setFiles(rejectedFiles);
    if (fileInput.current) fileInput.current.value = "";
    if (staged.size) pendingBundleId.current = bundleId;
    if (staged.size || pendingBundleId.current) {
      try {
        applyBundlePreview(await previewOfficialUsageBundle(bundleId));
      } catch (error) {
        failures.push(`Could not load the staged bundle preview: ${errorMessage(error)} Use Refresh import state to retry.`);
      }
    }
    try {
      setAdminState(await getOfficialUsageAdminState());
    } catch (error) {
      failures.push(`Could not refresh import history: ${errorMessage(error)}`);
    }
    setMessage(failures.length
      ? { tone: "error", text: `${staged.size} report type(s) staged; ${rejectedFiles.length} file(s) rejected. ${failures.join(" ")}` }
      : { tone: "success", text: `${staged.size} report type(s) validated. All report rows are included; activity dates were read from the files.` });
    setBusy(false);
  }

  async function acceptPreviews() {
    if (!bundlePreview || bundlePreview.missingKinds.length) return;
    const priorState = adminState;
    setBusy(true);
    setMessage(undefined);
    try {
      const accepted = await acceptOfficialUsageBundle(bundlePreview);
      setCompletedImport(accepted.complete);
      pendingBundleId.current = undefined;
      setBundlePreview(undefined);
      setCorrectionMode(false);
      const refreshedState = await refresh(null);
      if (refreshedState) {
        setMessage({
          tone: "success",
          text: acceptedBundleMessage(accepted, priorState, refreshedState),
        });
      }
      onChanged();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function discardPreviews() {
    if (!previews.length) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(previews.map(preview => discardOfficialUsageStaging(preview.id)));
      const failed = results.filter(result => result.status === "rejected");
      if (failed.length) {
        setMessage({ tone: "error", text: `${failed.length} staged report(s) could not be discarded and remain available for retry. ${errorMessage(failed[0].reason)}` });
        await refresh(bundlePreview?.bundleId);
      } else {
        pendingBundleId.current = undefined;
        setBundlePreview(undefined);
        setMessage({ tone: "success", text: "All staged rows were discarded." });
        await refresh(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function beginSetOperation(setId: string, operation: "select" | "delete") {
    setBusy(true);
    confirmationReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      setConfirmation(await previewOfficialUsageSetOperation(setId, operation));
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function resumeSet(bundleId: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      const preview = await previewOfficialUsageBundle(bundleId);
      applyBundlePreview(preview);
      const reportSet = adminState?.sets.find(value => value.bundleId === bundleId);
      setCorrectionMode(Boolean(reportSet?.supersedesSetId));
      setMessage({ tone: "success", text: `Resuming bundle ${bundleId.slice(0, 8)}. Add ${preview.missingKinds.map(kindLabel).join(", ") || "no missing reports"}.` });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetOperation() {
    if (!confirmation) return;
    setBusy(true);
    try {
      await confirmOfficialUsageSetOperation(confirmation);
      setMessage({ tone: "success", text: confirmation.operation === "select"
        ? "The retained complete set is now active."
        : "The retained set was deleted; active selection was cleared when applicable." });
      setConfirmation(undefined);
      await refresh();
      onChanged();
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function cancelSetOperation() {
    setConfirmation(undefined);
    requestAnimationFrame(() => {
      confirmationReturnFocus.current?.focus();
      confirmationReturnFocus.current = null;
    });
  }

  async function acknowledgeLegacy(disposition: "reimported" | "discarded") {
    setBusy(true);
    try {
      await acknowledgeLegacyUsageCleanup(disposition);
      clearLegacyUsageStorage();
      setLegacyPresent(false);
      onLegacyCleared?.();
      setMessage({ tone: "success", text: "Legacy browser report storage was removed after explicit acknowledgement." });
    } catch (error) {
      setMessage({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  const ready = files.length > 0 && Boolean(adminState);
  const activeSet = adminState?.sets.find(reportSet => reportSet.id === adminState.activeSetId);

  return (
    <section className="official-usage-import" aria-labelledby="official-usage-import-title">
      <header className="report-section-header">
        <div>
          <h2 id="official-usage-import-title">Microsoft 365 usage reports</h2>
        </div>
        <span>{activeSet ? `Current snapshot: ${formatCoverage(activeSet.reportingPeriod)}` : "No current snapshot"}</span>
      </header>

      {legacyPresent ? (
        <div className="report-status error" role="status">
          <strong>Legacy browser report data is present in this browser.</strong>
          <p>It was not read or migrated. Re-import the original Microsoft exports, or explicitly discard the legacy copy.</p>
          <div className="report-actions">
            {completedImport ? <button type="button" disabled={busy} onClick={() => void acknowledgeLegacy("reimported")}><Check size={16} />Acknowledge re-import and remove</button> : null}
            <button type="button" className="secondary" disabled={busy} onClick={() => void acknowledgeLegacy("discarded")}><Trash2 size={16} />Acknowledge discard and remove</button>
          </div>
        </div>
      ) : null}

      <p>Use the Agents, Users &amp; agents, and Users exports from the same reporting period. Each accepted bundle is added to retained history; ordinary uploads do not require a replacement acknowledgement.</p>
      <p>Exact duplicate observations reuse their original retained identity and acceptance time. Ordinary independent snapshots append without replacing prior history.</p>
      <p>For a known reporting window, changed aggregate metrics require the intentional correction option below. Activity-range-only imports have an unknown reporting window and remain independent observations.</p>
      <details className="usage-import-guidance">
        <summary>How to export the CSV files</summary>
        <div className="official-usage-workflow">
          <div>
            <strong>Export all three files</strong>
            <ol>
              <li>In the Microsoft 365 admin center, open Reports (Show all if hidden), then Usage. Under Reports, select Microsoft Copilot and Agents.</li>
              <li>For one 7- or 30-day period, select each Agents, Users &amp; agents, and Users table/tab and use Export CSV.</li>
              <li>Choose the original CSV files below. All available rows are imported automatically; no dates need to be entered.</li>
            </ol>
            <a href={reportGuideUrl} target="_blank" rel="noreferrer">Microsoft report guidance</a>
          </div>
          <div>
            <strong>Use all available data</strong>
            <p>Activity coverage is read from the reports. After import, optional last-activity date filters help explore the data without changing the full-export response counts.</p>
            <p>These exports do not state their reporting window or source refresh time. Observed activity dates are not a claim of complete period coverage.</p>
            <p>Rolling 7- and 30-day exports are aggregate snapshots, not event logs. Overlapping snapshot totals are never added together, and pseudonymous usernames are not assumed stable across report sets.</p>
          </div>
        </div>
      </details>

      <ol className="usage-import-steps" aria-label="Import progress">
        <li aria-current={!bundlePreview && !completedImport ? "step" : undefined}>1. Choose CSVs</li>
        <li aria-current={bundlePreview ? "step" : undefined}>2. Review and approve</li>
        <li aria-current={completedImport && !bundlePreview ? "step" : undefined}>3. Report active</li>
      </ol>

      {adminState?.activeSetId ? (
        <details className="official-usage-correction">
          <summary>Intentional correction options</summary>
          <label><input type="checkbox" disabled={busy} checked={correctionMode} onChange={event => setCorrectionMode(event.target.checked)} />This upload intentionally corrects the current snapshot.</label>
          <p>Leave this off for ordinary cumulative uploads. Corrections preserve earlier observations in history; retained-set deletion remains a separate confirmed action below.</p>
        </details>
      ) : null}

      <div className="report-actions official-usage-actions">
        <input ref={fileInput} hidden aria-label="Official usage CSV files" type="file" accept=".csv,text/csv" multiple onChange={event => setFiles([...(event.currentTarget.files ?? [])])} />
        <button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}><FileText size={16} />Choose CSVs</button>
        <span>{files.length ? `${files.length} file(s) selected` : "No files selected"}</span>
        <button type="button" disabled={!ready || busy} onClick={() => void stageFiles()}><Upload size={16} />Validate and stage</button>
        <button type="button" className="icon-button" title="Refresh import state" aria-label="Refresh import state" disabled={busy} onClick={() => void refresh()}><RefreshCw size={17} /></button>
      </div>

      {message ? <div className={`report-status ${message.tone}`} role="status">{message.text}</div> : null}

      {bundlePreview ? (
        <section className="official-usage-preview" aria-label="Validated report previews">
          <h3>Review server-validated previews</h3>
          <dl className="official-usage-bundle-summary">
            <div><dt>Bundle hash</dt><dd>{bundlePreview.bundleHash}</dd></div>
            <div><dt>Coverage</dt><dd>{bundlePreview.missingKinds.length ? `Missing ${bundlePreview.missingKinds.map(kindLabel).join(", ")}` : "All three kinds reviewed"}</dd></div>
            <div><dt>Reconciliation</dt><dd>{JSON.stringify(bundlePreview.reconciliation)}</dd></div>
          </dl>
          <div className="table-shell" role="region" aria-label="Validated report rows" tabIndex={0}><table><thead><tr><th>Report</th><th>Rows</th><th>Hash / schema</th><th>Activity coverage / source basis</th><th>Warnings</th></tr></thead><tbody>
            {previews.map(preview => <tr key={preview.id}><td>{kindLabel(preview.kind)}</td><td>{preview.rowCount.toLocaleString()}</td><td><code>{preview.fileHash.slice(0, 16)}</code><br />{preview.schemaVersion}</td><td>{formatCoverage(preview.reportingPeriod)}<br />{formatProvenance(preview.reportingPeriod.provenance)}; freshness {preview.sourceFreshness}{preview.sourceAsOf ? `; source as-of ${preview.sourceAsOf} (${preview.sourceAsOfProvenance})` : ""}</td><td>{preview.warnings.length ? <ul className="official-usage-warnings">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : "None"}</td></tr>)}
            {bundlePreview.acceptedVersions.map(version => <tr key={version.versionId}><td>{kindLabel(version.kind)} (accepted)</td><td>-</td><td><code>{version.fileHash.slice(0, 16)}</code></td><td>{formatCoverage(version.reportingPeriod)}<br />{formatProvenance(version.reportingPeriod.provenance)}{version.sourceAsOf ? `; source as-of ${version.sourceAsOf} (${version.sourceAsOfProvenance})` : ""}</td><td>Immutable retained companion</td></tr>)}
          </tbody></table></div>
          <div className="report-actions">{previews.length ? <button type="button" className="secondary" disabled={busy} onClick={() => void discardPreviews()}><Trash2 size={16} />Discard staging</button> : null}<button type="button" disabled={busy || bundlePreview.missingKinds.length > 0} onClick={() => void acceptPreviews()}><Check size={16} />Accept reviewed bundle</button></div>
        </section>
      ) : null}

      <section className="official-usage-history" aria-label="Retained report sets">
        <h3>Accumulated snapshot history</h3>
        <p>Accepted snapshots remain available beyond the current 30-day view. Coverage labels describe source-supplied windows or observed activity ranges; unknown windows stay explicit. Metrics from overlapping aggregate exports are non-additive.</p>
        {adminState?.sets.length ? <div className="table-shell"><table><thead><tr><th>Activity coverage / supplied period</th><th>Reports</th><th>Status</th><th>Lineage</th><th>Accepted</th><th>Actions</th></tr></thead><tbody>
          {adminState.sets.map(reportSet => <tr key={reportSet.id}><td>{formatCoverage(reportSet.reportingPeriod)}<br /><small>{formatProvenance(reportSet.reportingPeriod.provenance)}</small></td><td>{reportSet.kinds.map(kindLabel).join(", ")}</td><td>{reportSet.deletedAt ? "Deleted" : reportSet.id === adminState.activeSetId ? "Current" : reportSet.complete ? "Retained" : "Incomplete"}</td><td>{reportSet.supersedesSetId ? `Corrects ${reportSet.supersedesSetId.slice(0, 8)}` : "Cumulative snapshot"}</td><td>{reportSet.acceptedAt ? formatInstant(reportSet.acceptedAt) : "Pending companions"}</td><td><div className="table-actions">{!reportSet.complete && !reportSet.deletedAt ? <button type="button" className="secondary" disabled={busy} onClick={() => void resumeSet(reportSet.bundleId)}>Resume</button> : null}{reportSet.complete && !reportSet.deletedAt && reportSet.id !== adminState.activeSetId ? <button type="button" className="secondary" disabled={busy} onClick={() => void beginSetOperation(reportSet.id, "select")}>Make current</button> : null}{!reportSet.deletedAt ? <button type="button" className="icon-button danger" title="Delete retained set" aria-label={`Delete retained set for ${formatCoverage(reportSet.reportingPeriod)}`} disabled={busy} onClick={() => void beginSetOperation(reportSet.id, "delete")}><Trash2 size={16} /></button> : null}</div></td></tr>)}
        </tbody></table></div> : <p>No retained official usage sets.</p>}
      </section>

      {confirmation ? <SetConfirmationDialog confirmation={confirmation} reportSet={adminState?.sets.find(reportSet => reportSet.id === confirmation.setId)} busy={busy} onCancel={cancelSetOperation} onConfirm={() => void confirmSetOperation()} /> : null}
    </section>
  );
}

function kindLabel(kind: OfficialUsageStagingPreview["kind"]) {
  return kind === "agents" ? "Agents" : kind === "userAgents" ? "Users & agents" : "Users";
}

function formatInstant(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCoverage(period: { startDate: string | null; endDate: string | null }) {
  return period.startDate && period.endDate ? `${period.startDate} to ${period.endDate}` : "No activity dates supplied";
}

function formatProvenance(provenance: string) {
  return provenance === "activity_range" ? "Observed last-activity dates; reporting window unknown"
    : provenance === "unknown" ? "Reporting window unknown"
      : provenance === "operator_asserted" ? "Previously supplied by administrator"
        : "Source metadata";
}

function acceptedBundleMessage(
  accepted: Awaited<ReturnType<typeof acceptOfficialUsageBundle>>,
  priorState: OfficialUsageAdminState | undefined,
  refreshedState: OfficialUsageAdminState,
) {
  if (!accepted.complete) {
    return "Accepted reports remain an incomplete retained snapshot and did not replace the current official usage view.";
  }

  const priorSet = priorState?.sets.find(reportSet => reportSet.id === accepted.setId);
  const refreshedSet = refreshedState.sets.find(reportSet => reportSet.id === accepted.setId);
  const isCurrent = refreshedState.activeSetId === accepted.setId;
  const selectionUnchanged = Boolean(
    priorState
    && priorState.activeSetId === refreshedState.activeSetId
    && priorState.activeRevision === refreshedState.activeRevision
    && accepted.activeRevision === refreshedState.activeRevision,
  );
  const acceptance = priorSet?.acceptedAt ? ` Original acceptance remains ${formatInstant(priorSet.acceptedAt)}.` : "";

  if (priorSet) {
    if (isCurrent) {
      return `The upload exactly matched the current retained snapshot. No new history entry was created.${acceptance}${selectionUnchanged ? " Current selection and revision are unchanged." : " Current selection remains on the matched snapshot."} Original upload bytes were discarded.`;
    }
    const current = refreshedState.activeSetId ? refreshedState.activeSetId.slice(0, 8) : "none";
    return `The upload exactly matched retained snapshot ${accepted.setId.slice(0, 8)}. No new history entry was created.${acceptance} Current selection remains ${current}${selectionUnchanged ? " and its revision is unchanged" : ""}. Original upload bytes were discarded.`;
  }

  if (!refreshedSet) {
    return "The reports were accepted, but refreshed history could not confirm the retained snapshot or active selection. Refresh import state before relying on its status.";
  }
  if (isCurrent) {
    return "The compatible three-file snapshot was added to cumulative history and is current. Prior snapshots remain retained, and original upload bytes were discarded.";
  }
  const current = refreshedState.activeSetId ? refreshedState.activeSetId.slice(0, 8) : "none";
  return `The compatible three-file snapshot was added to retained cumulative history. Current selection remains ${current}; the new snapshot was not made current. Original upload bytes were discarded.`;
}

function SetConfirmationDialog({ confirmation, reportSet, busy, onCancel, onConfirm }: {
  confirmation: OfficialUsageConfirmation;
  reportSet?: OfficialUsageAdminState["sets"][number];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className="confirm-modal" aria-labelledby="usage-set-confirm-title" onCancel={event => { event.preventDefault(); onCancel(); }} onClose={onCancel}>
    <h2 id="usage-set-confirm-title">Confirm {confirmation.operation}</h2>
    <p>Set {confirmation.setId}</p>
    <p>{reportSet ? `Activity coverage / supplied period: ${formatCoverage(reportSet.reportingPeriod)}.` : "Activity coverage unavailable."}</p>
    <p>{confirmation.operation === "delete" ? "Deletion removes retained content. Deleting the active set clears selection and never falls back automatically." : "Selection replaces the active pointer with this retained complete set."}</p>
    <div className="confirm-actions"><button type="button" className="secondary" autoFocus onClick={onCancel}>Cancel</button><button type="button" disabled={busy} onClick={onConfirm}>Confirm</button></div>
  </dialog>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The official usage request failed.";
}
