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
  const [reportingStart, setReportingStart] = useState("");
  const [reportingEnd, setReportingEnd] = useState("");
  const [sourceAsOf, setSourceAsOf] = useState("");
  const [replaceActive, setReplaceActive] = useState(false);
  const [bundlePreview, setBundlePreview] = useState<OfficialUsageBundlePreview>();
  const [confirmation, setConfirmation] = useState<OfficialUsageConfirmation>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [legacyPresent, setLegacyPresent] = useState(hasLegacyUsageStorage);
  const [completedImport, setCompletedImport] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirmationReturnFocus = useRef<HTMLElement | null>(null);
  const loadGeneration = useRef(0);
  const previews = bundlePreview?.staging ?? [];

  function applyBundlePreview(preview: OfficialUsageBundlePreview) {
    setBundlePreview(preview);
    setReplaceActive(preview.staging.some(stage => Boolean(stage.correctionOfSetId)));
    const basis = preview.staging[0] ?? preview.acceptedVersions[0];
    if (!basis) return;
    setReportingStart(basis.reportingPeriod.startDate);
    setReportingEnd(basis.reportingPeriod.endDate);
    setSourceAsOf(basis.sourceAsOf ? toLocalDateTime(basis.sourceAsOf) : "");
  }

  async function refresh(preferredBundleId: string | null | undefined = bundlePreview?.bundleId) {
    const generation = ++loadGeneration.current;
    try {
      const state = await getOfficialUsageAdminState();
      if (generation !== loadGeneration.current) return;
      setAdminState(state);
      const bundleId = preferredBundleId === null ? undefined : preferredBundleId ?? state.staging.find(stage => stage.status === "active")?.bundleId;
      if (bundleId) {
        const preview = await previewOfficialUsageBundle(bundleId);
        if (generation === loadGeneration.current) applyBundlePreview(preview);
      }
      else setBundlePreview(undefined);
    } catch (error) {
      if (generation === loadGeneration.current) setMessage({ tone: "error", text: errorMessage(error) });
    }
  }

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      setAdminState(undefined);
      setBundlePreview(undefined);
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
    if (!files.length || !reportingStart || !reportingEnd) return;
    const existingSet = adminState?.sets.find(reportSet => reportSet.bundleId === bundlePreview?.bundleId);
    if (adminState?.activeSetId && !replaceActive && !existingSet) {
      setMessage({ tone: "error", text: "Confirm that this bundle is an explicit correction of the active set before staging it." });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    const bundleId = bundlePreview?.bundleId ?? crypto.randomUUID();
    const staged = new Map<string, OfficialUsageStagingPreview>();
    const failures: string[] = [];
    for (const file of files) {
      try {
        const preview = await stageOfficialUsageReport(file, {
          bundleId,
          correctionOfSetId: existingSet?.supersedesSetId ?? (replaceActive ? adminState?.activeSetId ?? undefined : undefined),
          reportingStart,
          reportingEnd,
          periodProvenance: "operator_asserted",
          ...(sourceAsOf ? { sourceAsOf: new Date(sourceAsOf).toISOString(), sourceAsOfProvenance: "operator_asserted" as const } : {}),
        });
        staged.set(preview.kind, preview);
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
    if (staged.size || bundlePreview) {
      try {
        applyBundlePreview(await previewOfficialUsageBundle(bundleId));
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    setMessage(failures.length
      ? { tone: "error", text: `${staged.size} report type(s) staged; ${failures.length} file(s) rejected. ${failures[0]}` }
      : { tone: "success", text: `${staged.size} report type(s) validated into expiring server-side staging.` });
    setBusy(false);
    await refresh(bundleId);
  }

  async function acceptPreviews() {
    if (!bundlePreview || bundlePreview.missingKinds.length) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const accepted = await acceptOfficialUsageBundle(bundlePreview);
      setCompletedImport(accepted.complete);
      setBundlePreview(undefined);
      setReplaceActive(false);
      setMessage({ tone: "success", text: accepted.complete
        ? "The compatible three-file set is active. Original upload bytes were discarded."
        : "Accepted reports remain an incomplete retained set and did not replace active official usage." });
      await refresh(null);
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
      setReplaceActive(Boolean(reportSet?.supersedesSetId));
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

  const ready = files.length > 0 && Boolean(reportingStart) && Boolean(reportingEnd);
  const activeSet = adminState?.sets.find(reportSet => reportSet.id === adminState.activeSetId);

  return (
    <section className="official-usage-import" aria-labelledby="official-usage-import-title">
      <header className="report-section-header">
        <div>
          <p className="eyebrow">Official authority</p>
          <h2 id="official-usage-import-title">Microsoft 365 usage reports</h2>
        </div>
        <span>{activeSet ? `Active through ${activeSet.reportingPeriod.endDate}` : "No active set"}</span>
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

      <div className="official-usage-workflow">
        <div>
          <strong>Export all three files</strong>
          <ol>
            <li>In the Microsoft 365 admin center, open Reports (Show all if hidden), then Usage. Under Reports, select Microsoft Copilot and Agents.</li>
            <li>For one 7- or 30-day period, select each Agents, Users &amp; agents, and Users table/tab and use Export CSV.</li>
            <li>Enter the source period below and import the original CSV files. This app cannot fetch them through an API.</li>
          </ol>
          <a href={reportGuideUrl} target="_blank" rel="noreferrer">Microsoft report guidance</a>
        </div>
        <div className="official-usage-fields">
          <label><span>Reporting start</span><input type="date" value={reportingStart} onChange={event => setReportingStart(event.target.value)} /></label>
          <label><span>Reporting end</span><input type="date" value={reportingEnd} onChange={event => setReportingEnd(event.target.value)} /></label>
          <label><span>Source as-of, if shown</span><input type="datetime-local" value={sourceAsOf} onChange={event => setSourceAsOf(event.target.value)} /></label>
        </div>
      </div>

      {adminState?.activeSetId ? (
        <label className="official-usage-correction"><input type="checkbox" checked={replaceActive} onChange={event => setReplaceActive(event.target.checked)} />This bundle is an explicit correction replacing the active set.</label>
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
          <div className="table-shell"><table><thead><tr><th>Report</th><th>Rows</th><th>Hash / schema</th><th>Period / source basis</th><th>Warnings</th></tr></thead><tbody>
            {previews.map(preview => <tr key={preview.id}><td>{kindLabel(preview.kind)}</td><td>{preview.rowCount.toLocaleString()}</td><td><code>{preview.fileHash.slice(0, 16)}</code><br />{preview.schemaVersion}</td><td>{preview.reportingPeriod.startDate} to {preview.reportingPeriod.endDate}<br />{preview.reportingPeriod.provenance}; source as-of {preview.sourceAsOf ?? "absent"} ({preview.sourceAsOfProvenance}); freshness {preview.sourceFreshness}</td><td>{preview.warnings.length ? <ul className="official-usage-warnings">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul> : "None"}</td></tr>)}
            {bundlePreview.acceptedVersions.map(version => <tr key={version.versionId}><td>{kindLabel(version.kind)} (accepted)</td><td>-</td><td><code>{version.fileHash.slice(0, 16)}</code></td><td>{version.reportingPeriod.startDate} to {version.reportingPeriod.endDate}<br />{version.reportingPeriod.provenance}; source as-of {version.sourceAsOf ?? "absent"} ({version.sourceAsOfProvenance})</td><td>Immutable retained companion</td></tr>)}
          </tbody></table></div>
          <div className="report-actions">{previews.length ? <button type="button" className="secondary" disabled={busy} onClick={() => void discardPreviews()}><Trash2 size={16} />Discard staging</button> : null}<button type="button" disabled={busy || bundlePreview.missingKinds.length > 0} onClick={() => void acceptPreviews()}><Check size={16} />Accept reviewed bundle</button></div>
        </section>
      ) : null}

      <section className="official-usage-history" aria-label="Retained report sets">
        <h3>Retained sets</h3>
        {adminState?.sets.length ? <div className="table-shell"><table><thead><tr><th>Period</th><th>Reports</th><th>Status</th><th>Lineage</th><th>Accepted</th><th>Actions</th></tr></thead><tbody>
          {adminState.sets.map(reportSet => <tr key={reportSet.id}><td>{reportSet.reportingPeriod.startDate} to {reportSet.reportingPeriod.endDate}</td><td>{reportSet.kinds.map(kindLabel).join(", ")}</td><td>{reportSet.deletedAt ? "Deleted" : reportSet.id === adminState.activeSetId ? "Active" : reportSet.complete ? "Retained" : "Incomplete"}</td><td>{reportSet.supersedesSetId ? `Corrects ${reportSet.supersedesSetId.slice(0, 8)}` : "Original set"}</td><td>{reportSet.acceptedAt ? formatInstant(reportSet.acceptedAt) : "Pending companions"}</td><td><div className="table-actions">{!reportSet.complete && !reportSet.deletedAt ? <button type="button" className="secondary" disabled={busy} onClick={() => void resumeSet(reportSet.bundleId)}>Resume</button> : null}{reportSet.complete && !reportSet.deletedAt && reportSet.id !== adminState.activeSetId ? <button type="button" className="secondary" disabled={busy} onClick={() => void beginSetOperation(reportSet.id, "select")}>Select</button> : null}{!reportSet.deletedAt ? <button type="button" className="icon-button danger" title="Delete retained set" aria-label={`Delete retained set for ${reportSet.reportingPeriod.startDate} to ${reportSet.reportingPeriod.endDate}`} disabled={busy} onClick={() => void beginSetOperation(reportSet.id, "delete")}><Trash2 size={16} /></button> : null}</div></td></tr>)}
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

function toLocalDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="confirm-modal" aria-labelledby="usage-set-confirm-title" onCancel={event => { event.preventDefault(); onCancel(); }} onClose={onCancel}>
    <h2 id="usage-set-confirm-title">Confirm {confirmation.operation}</h2>
    <p>Set {confirmation.setId}</p>
    <p>{reportSet ? `Reporting period ${reportSet.reportingPeriod.startDate} to ${reportSet.reportingPeriod.endDate}.` : "Reporting period unavailable."}</p>
    <p>{confirmation.operation === "delete" ? "Deletion removes retained content. Deleting the active set clears selection and never falls back automatically." : "Selection replaces the active pointer with this retained complete set."}</p>
    <div className="confirm-actions"><button type="button" className="secondary" autoFocus onClick={onCancel}>Cancel</button><button type="button" disabled={busy} onClick={onConfirm}>Confirm</button></div>
  </dialog>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The official usage request failed.";
}
