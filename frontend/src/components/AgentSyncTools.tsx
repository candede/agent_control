import { useState } from "react";
import { CircleAlert, Download, RefreshCw, ShieldCheck } from "lucide-react";
import type { InventoryRefreshJob, UnifiedAgentInventoryPage } from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { inventoryAttentionReasons } from "../inventoryVerification";
import { SavedAgentInventoryVerification } from "./SavedInventoryVerification";
import { SyncDialog } from "./SyncDialog";

type Props = {
  inventory?: UnifiedAgentInventoryPage;
  verifyingInventory: boolean;
  inventoryError?: string;
  onVerifyInventory?: () => void;
  selectedPackageCount: number;
  refreshingPackages: boolean;
  refreshingPowerPlatform: boolean;
  exportingPowerPlatform: boolean;
  powerPlatformJob?: InventoryRefreshJob;
  onInspectPowerPlatformJob: (id: string) => void;
  onRefreshPackages: () => void;
  onRefreshMatchingDetails: () => void;
  onRefreshPowerPlatform: () => void;
  onResumePowerPlatform: () => void;
  onExportPowerPlatform: () => void;
  onOpenAgents: () => void;
};

export function AgentSyncTools({
  inventory,
  verifyingInventory,
  inventoryError,
  onVerifyInventory,
  selectedPackageCount,
  refreshingPackages,
  refreshingPowerPlatform,
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
  const observation = inventory?.sources.powerPlatform.observation;
  const snapshotId = observation?.snapshotId;
  const currentInventory = !verifyingInventory && !inventoryError ? inventory : undefined;
  const invalidPackages = currentInventory?.identityCollection?.invalidPackages ?? 0;
  const attentionReasons = verifyingInventory ? [] : inventoryAttentionReasons(currentInventory, inventoryError);
  const needsAttention = attentionReasons.length > 0;
  const health = verifyingInventory ? "Checking"
    : needsAttention ? "Needs attention" : currentInventory ? "Verified" : "Not checked";
  return (
    <section className="sync-inventory-tools" aria-labelledby="sync-inventory-heading">
      <div className="sync-inventory-summary">
        {needsAttention ? <CircleAlert size={22} aria-hidden="true" /> : <ShieldCheck size={22} aria-hidden="true" />}
        <div>
          <div className="sync-health-heading"><h2 id="sync-inventory-heading">Inventory health</h2><span className={`data-sync-state state-${needsAttention ? "attention" : currentInventory ? "success" : "progress"}`}>{health}</span></div>
          <p role={needsAttention ? undefined : "status"}>{verifyingInventory
            ? "Checking saved inventory. Previous results are not the result of this check."
            : needsAttention ? "Catalog sync and inventory health are separate. The issues below explain what still needs attention."
              : "Counts and matching identities are checked automatically. No manual approval is needed."}</p>
        </div>
        <button type="button" className="secondary" aria-haspopup="dialog" onClick={() => setDiagnosticsOpen(true)}>View diagnostics</button>
      </div>
      {needsAttention ? <div className="sync-inventory-issues" role={inventoryError ? "alert" : "status"}>
        <h3>What needs attention</h3>
        <ul>{attentionReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      </div> : null}
      <SyncDialog open={diagnosticsOpen} title="Inventory diagnostics"
        description="Technical checks and recovery tools for saved inventory. These checks do not collect new Microsoft data."
        onClose={() => setDiagnosticsOpen(false)}>
          <div className="section-heading">
            <h2>Agent inventory sources</h2>
            <button type="button" className="secondary" onClick={() => { setDiagnosticsOpen(false); onOpenAgents(); }}>Browse agents</button>
          </div>
          <SavedAgentInventoryVerification inventory={inventory} loading={verifyingInventory} error={inventoryError} onVerify={onVerifyInventory} />
          {currentInventory ? <dl className="sync-inventory-counts" aria-label="Agent source coverage">
            <div><dt>Total</dt><dd>{currentInventory.summary.total.toLocaleString()}</dd></div>
            <div><dt>Source-metadata links</dt><dd>{currentInventory.summary.linked.toLocaleString()}</dd></div>
            <div><dt>Graph only</dt><dd>{currentInventory.summary.graphOnly.toLocaleString()}</dd></div>
            <div><dt>Power Platform only</dt><dd>{currentInventory.summary.powerPlatformOnly.toLocaleString()}</dd></div>
          </dl> : null}
          <section className="sync-source-tools" aria-label="Source matching details">
            <h3>Agent identity matching</h3>
            <p>Refresh agents collects the full list and exact identity details automatically. Records are combined only when the backend verifies exact, typed source identity evidence, never by display name alone.</p>
            {currentInventory?.identityCollection ? <p>{currentInventory.identityCollection.checkedPackages.toLocaleString()} package identities checked; {currentInventory.identityCollection.pendingPackages.toLocaleString()} still need collection.</p> : null}
            <p>Checked is a package-detail collection count, not a count of valid metadata or matched agents. Source-only records do not by themselves prove missing agents.</p>
            {invalidPackages > 0 ? <div className="notice" role="status">
              <strong>{invalidPackages.toLocaleString()} package{invalidPackages === 1 ? " has" : "s have"} invalid saved matching metadata.</strong>{" "}
              Select affected agents on Agents and use <strong>Refresh matching details</strong> for 1-100 selected packages, or <strong>Refresh agents</strong> for the full inventory. Refreshing metadata does not guarantee a cross-source match.
            </div> : null}
            {currentInventory && (currentInventory.summary.conflicting > 0 || currentInventory.summary.ambiguous > 0) ? <p role="status">
              {currentInventory.summary.conflicting.toLocaleString()} conflicting and {currentInventory.summary.ambiguous.toLocaleString()} ambiguous agent records require review. Inspect their matching details on Agents; names alone cannot resolve them.
            </p> : null}
            <p>{selectedPackageCount.toLocaleString()} published target{selectedPackageCount === 1 ? "" : "s"} selected. You can also recheck 1-100 selected targets without refreshing the full list.</p>
            <div className="inline-actions">
              <WorkbenchActionGate actionId="packages.refresh">
                <button type="button" className="secondary" disabled={refreshingPackages} onClick={onRefreshPackages}>
                  <RefreshCw size={15} aria-hidden="true" />{refreshingPackages ? "Refreshing agents" : "Refresh agents"}
                </button>
              </WorkbenchActionGate>
              <WorkbenchActionGate actionId="packages.refresh.identities">
                <button type="button" className="secondary" disabled={refreshingPackages || selectedPackageCount < 1 || selectedPackageCount > 100} onClick={onRefreshMatchingDetails}>
                  Refresh matching details
                </button>
              </WorkbenchActionGate>
              <button type="button" className="secondary" onClick={() => { setDiagnosticsOpen(false); onOpenAgents(); }}>Select packages on Agents</button>
            </div>
          </section>
          <section className="sync-source-tools" aria-label="Power Platform agent source">
            <h3>Power Platform agent source</h3>
            <p>Refresh Copilot Studio agents and supporting environment metadata, or export agents from the exact saved Power Platform snapshot. These controls do not infer links or change agent state. Exports use the search and environment filters saved on Agents.</p>
            {powerPlatformJob ? <p role="status">
              Latest agent refresh: {powerPlatformJob.status.replaceAll("_", " ")}
              {powerPlatformJob.message ? ` - ${powerPlatformJob.message}` : ""}
              {powerPlatformJob.status === "waiting_authorization" ? <> - <a href="/api/auth/login">Sign in again</a></> : null}
            </p> : null}
            <div className="inline-actions">
              {powerPlatformJob ? <button type="button" onClick={() => { setDiagnosticsOpen(false); onInspectPowerPlatformJob(powerPlatformJob.id); }}>Inspect source job</button> : null}
              <WorkbenchActionGate actionId="power-platform.refresh">
                <button type="button" className="secondary" disabled={refreshingPowerPlatform || powerPlatformJob?.status === "running"} onClick={onRefreshPowerPlatform}>
                  <RefreshCw size={15} aria-hidden="true" />{refreshingPowerPlatform ? "Refreshing PP agents..." : "Refresh PP agent inventory"}
                </button>
              </WorkbenchActionGate>
              {powerPlatformJob?.status === "waiting_authorization" ? <WorkbenchActionGate actionId="power-platform.resume">
                <button type="button" className="secondary" disabled={refreshingPowerPlatform} onClick={onResumePowerPlatform}>Resume PP agent refresh</button>
              </WorkbenchActionGate> : null}
              <WorkbenchActionGate actionId="power-platform.export">
                <button type="button" className="secondary" disabled={exportingPowerPlatform || !snapshotId} onClick={onExportPowerPlatform}
                  title={snapshotId ? "Exports Copilot Studio agents from the exact retained Power Platform snapshot" : "No retained Power Platform agent snapshot is available to export"}>
                  <Download size={15} aria-hidden="true" />{exportingPowerPlatform ? "Exporting PP agents..." : "Export PP agent inventory CSV"}
                </button>
              </WorkbenchActionGate>
            </div>
          </section>
          <p className="data-sync-run-meta">Sync collects inventory, not unlimited logs or transcripts. For agent event evidence, open <a href="/agents">Agents</a>, select an agent, and use its Activity tab.</p>
      </SyncDialog>
    </section>
  );
}
