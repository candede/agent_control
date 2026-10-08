import { useState } from "react";
import { CircleAlert, Download, RefreshCw, ShieldCheck } from "lucide-react";
import type { InventoryRefreshJob, UnifiedAgentInventoryPage, UnifiedAgentInventoryUnavailable } from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { inventoryAttentionReasons, inventoryDetailsPending } from "../inventoryVerification";
import { SavedAgentInventoryVerification } from "./SavedInventoryVerification";
import { SyncDialog } from "./SyncDialog";

type Props = {
  inventory?: UnifiedAgentInventoryPage;
  inventoryUnavailable?: UnifiedAgentInventoryUnavailable;
  verifyingInventory: boolean;
  inventoryError?: string;
  operationError?: string;
  powerPlatformHistoryError?: string;
  onVerifyInventory?: () => void;
  selectedPackageCount: number;
  refreshingPackages: boolean;
  refreshingPowerPlatform: boolean;
  inspectingPowerPlatformJob?: boolean;
  exportingPowerPlatform: boolean;
  powerPlatformJob?: InventoryRefreshJob;
  onInspectPowerPlatformJob: (id: string) => void;
  onRefreshPackages: () => void;
  onRefreshMatchingDetails: () => void;
  onRefreshPowerPlatform: () => void;
  onResumePowerPlatform: () => void;
  onExportPowerPlatform: () => boolean;
  onOpenAgents: () => void;
};

export function AgentSyncTools({
  inventory,
  inventoryUnavailable,
  verifyingInventory,
  inventoryError,
  operationError,
  powerPlatformHistoryError,
  onVerifyInventory,
  selectedPackageCount,
  refreshingPackages,
  refreshingPowerPlatform,
  inspectingPowerPlatformJob = false,
  exportingPowerPlatform,
  powerPlatformJob,
  onInspectPowerPlatformJob,
  onRefreshPackages,
  onRefreshMatchingDetails,
  onRefreshPowerPlatform,
  onResumePowerPlatform,
  onExportPowerPlatform,
  onOpenAgents,
}: Props) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const currentInventory = !verifyingInventory && !inventoryError && !inventoryUnavailable ? inventory : undefined;
  const snapshotId = currentInventory?.sources.powerPlatform.observation?.snapshotId;
  const invalidPackages = currentInventory?.identityCollection?.invalidPackages ?? 0;
  const attentionReasons = verifyingInventory ? [] : inventoryAttentionReasons(currentInventory, inventoryError);
  const needsAttention = attentionReasons.length > 0;
  const detailsPending = inventoryDetailsPending(currentInventory);
  const health = verifyingInventory ? "Checking"
    : needsAttention ? "Needs attention" : inventoryUnavailable ? inventoryUnavailable.state === "preparing" ? "Preparing"
      : inventoryUnavailable.state === "unavailable" ? "Unavailable" : "Not collected"
      : currentInventory ? detailsPending ? "Sources checked" : "Verified" : "Not checked";
  return (
    <section className="sync-inventory-tools" aria-labelledby="sync-inventory-heading">
      <div className="sync-inventory-summary">
        {needsAttention ? <CircleAlert size={22} aria-hidden="true" /> : <ShieldCheck size={22} aria-hidden="true" />}
        <div>
          <div className="sync-health-heading"><h2 id="sync-inventory-heading">Inventory health</h2><span className={`data-sync-state state-${needsAttention ? "attention" : currentInventory ? "success" : "progress"}`}>{health}</span></div>
          <p role={needsAttention ? undefined : "status"}>{verifyingInventory
            ? "Checking saved inventory. Previous results are not the result of this check."
            : needsAttention ? "Catalog sync and inventory health are separate. The issues below explain what still needs attention."
              : inventoryUnavailable ? inventoryUnavailable.message
                : !currentInventory ? "No saved inventory receipt is available. Open diagnostics to read saved inventory."
                  : detailsPending ? "Saved source counts are checked. Package detail freshness is shown in diagnostics; no administrator action is needed for scheduled refreshes."
                    : "Counts and matching identities are checked automatically. No manual approval is needed."}</p>
        </div>
        <button type="button" className="secondary" aria-haspopup="dialog" onClick={() => setDiagnosticsOpen(true)}>View diagnostics</button>
      </div>
      {needsAttention ? <div className="sync-inventory-issues" role={inventoryError ? "alert" : "status"}>
        <h3>What needs attention</h3>
        <ul>{attentionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      </div> : null}
      <SyncDialog open={diagnosticsOpen} title="Inventory diagnostics"
        description="Saved-data checks do not collect new Microsoft data. The explicit source refresh controls below do."
        onClose={() => setDiagnosticsOpen(false)}>
          <div className="section-heading">
            <h2>Agent inventory sources</h2>
            <button type="button" className="secondary" onClick={() => { setDiagnosticsOpen(false); onOpenAgents(); }}>Browse agents</button>
          </div>
          {operationError ? <div className="error-banner" role="alert">{operationError}</div> : null}
          <SavedAgentInventoryVerification inventory={inventory} unavailable={inventoryUnavailable} loading={verifyingInventory} error={inventoryError} onVerify={onVerifyInventory} />
          {currentInventory ? <dl className="sync-inventory-counts" aria-label="Agent source coverage">
            <div><dt>Total</dt><dd>{currentInventory.summary.total.toLocaleString()}</dd></div>
            <div><dt>Source-metadata links</dt><dd>{currentInventory.summary.linked.toLocaleString()}</dd></div>
            <div><dt>Graph only</dt><dd>{currentInventory.summary.graphOnly.toLocaleString()}</dd></div>
            <div><dt>Power Platform only</dt><dd>{currentInventory.summary.powerPlatformOnly.toLocaleString()}</dd></div>
          </dl> : null}
          <section className="sync-source-tools" aria-label="Source matching details">
            <h3>Agent identity matching</h3>
            <p>Refresh agents collects the full list and exact identity details automatically. Records are combined only when the backend verifies exact, typed source identity evidence, never by display name alone.</p>
            {currentInventory?.identityCollection ? <>
              <p>{currentInventory.identityCollection.checkedPackages.toLocaleString()} package detail check{currentInventory.identityCollection.checkedPackages === 1 ? "" : "s"} current; {currentInventory.identityCollection.pendingPackages.toLocaleString()} not current.</p>
              {currentInventory.identityCollection.pendingDetails ? <dl className="sync-inventory-counts" aria-label="Package detail freshness">
                <div><dt>Not yet collected</dt><dd>{currentInventory.identityCollection.pendingDetails.missing.toLocaleString()}</dd></div>
                <div><dt>Previously collected, expired</dt><dd>{currentInventory.identityCollection.pendingDetails.stale.toLocaleString()}</dd></div>
                <div><dt>Compatibility recheck needed</dt><dd>{currentInventory.identityCollection.pendingDetails.invalidated.toLocaleString()}</dd></div>
              </dl> : null}
            </> : null}
            <p>These are detail-freshness counts, not a count of valid metadata or matched agents. Expired details were already collected; they are not missing agents. Scheduled detail refreshes require no administrator action.</p>
            <p>Some packages do not supply native-agent linking metadata. Repeating a successful read does not guarantee a match. Source-only records do not by themselves prove missing agents.</p>
            {invalidPackages > 0 ? <div className="notice" role="status">
              <strong>{invalidPackages.toLocaleString()} package{invalidPackages === 1 ? " has" : "s have"} invalid saved matching metadata.</strong>{" "}
              Select affected agents on Agents and use <strong>Refresh matching details</strong> for 1-5,000 selected packages, or <strong>Refresh agents</strong> for the full inventory. Refreshing metadata does not guarantee a cross-source match.
            </div> : null}
            {currentInventory && (currentInventory.summary.conflicting > 0 || currentInventory.summary.ambiguous > 0) ? <p role="status">
              {currentInventory.summary.conflicting.toLocaleString()} conflicting and {currentInventory.summary.ambiguous.toLocaleString()} ambiguous agent records require review. Inspect their matching details on Agents; names alone cannot resolve them.
            </p> : null}
            <p>{selectedPackageCount.toLocaleString()} published target{selectedPackageCount === 1 ? "" : "s"} selected. You can recheck 1-5,000 targets from the server selection without refreshing the full list.</p>
            <div className="inline-actions">
              <WorkbenchActionGate actionId="packages.refresh">
                <button type="button" className="secondary" disabled={refreshingPackages} onClick={onRefreshPackages}>
                  <RefreshCw size={15} aria-hidden="true" />{refreshingPackages ? "Refreshing agents" : "Refresh agents"}
                </button>
              </WorkbenchActionGate>
              <WorkbenchActionGate actionId="packages.refresh.identities">
                <button type="button" className="secondary" disabled={refreshingPackages || !currentInventory
                  || selectedPackageCount < 1 || selectedPackageCount > 5000} onClick={onRefreshMatchingDetails}>
                  Refresh matching details
                </button>
              </WorkbenchActionGate>
              <button type="button" className="secondary" onClick={() => { setDiagnosticsOpen(false); onOpenAgents(); }}>Select packages on Agents</button>
            </div>
          </section>
          <section className="sync-source-tools" aria-label="Power Platform agent source">
            <h3>Power Platform agent source</h3>
            <p>Refresh Copilot Studio agents and supporting environment metadata, or export agents from the exact saved Power Platform snapshot. These controls do not infer links or change agent state. Exports use the search and environment filters saved on Agents.</p>
            {powerPlatformHistoryError ? <p role="alert">{powerPlatformHistoryError}</p> : null}
            {powerPlatformJob ? <p role="status">
              {powerPlatformHistoryError ? "Last observed agent refresh" : "Latest agent refresh"}: {powerPlatformJob.status.replaceAll("_", " ")}
              {powerPlatformJob.message ? ` - ${powerPlatformJob.message}` : ""}
              {powerPlatformJob.status === "waiting_authorization" ? <> - <a href="/api/auth/login">Sign in again</a></> : null}
            </p> : null}
            <div className="inline-actions">
              {powerPlatformJob ? <button type="button" onClick={() => { setDiagnosticsOpen(false); onInspectPowerPlatformJob(powerPlatformJob.id); }}>Inspect source job</button> : null}
              <WorkbenchActionGate actionId="power-platform.refresh">
                <button type="button" className="secondary" disabled={refreshingPowerPlatform || inspectingPowerPlatformJob || powerPlatformJob?.status === "running"} onClick={onRefreshPowerPlatform}>
                  <RefreshCw size={15} aria-hidden="true" />{refreshingPowerPlatform ? "Refreshing PP agents..." : "Refresh PP agent inventory"}
                </button>
              </WorkbenchActionGate>
              {powerPlatformJob?.status === "waiting_authorization" ? <WorkbenchActionGate actionId="power-platform.resume">
                <button type="button" className="secondary" disabled={refreshingPowerPlatform || inspectingPowerPlatformJob} onClick={onResumePowerPlatform}>Resume PP agent refresh</button>
              </WorkbenchActionGate> : null}
              <WorkbenchActionGate actionId="power-platform.export">
                <button type="button" className="secondary" disabled={exportingPowerPlatform || !snapshotId}
                  onClick={() => { if (onExportPowerPlatform()) setDiagnosticsOpen(false); }}
                  title={verifyingInventory ? "Wait for the current saved inventory check before exporting."
                    : inventoryError ? "Reload saved inventory successfully before exporting."
                      : snapshotId ? "Exports Copilot Studio agents from the exact retained Power Platform snapshot" : "No retained Power Platform agent snapshot is available to export"}>
                  <Download size={15} aria-hidden="true" />{exportingPowerPlatform ? "Exporting PP agents..." : "Export PP agent inventory CSV"}
                </button>
              </WorkbenchActionGate>
            </div>
            {inspectingPowerPlatformJob ? <p role="status">Use the open source job to manage its refresh, or close it to start another refresh.</p> : null}
          </section>
          <p className="data-sync-run-meta">Sync collects inventory, not unlimited logs or transcripts. For agent event evidence, open <a href="/agents">Agents</a>, select an agent, and use its Activity tab.</p>
      </SyncDialog>
    </section>
  );
}
