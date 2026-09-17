import { Download, RefreshCw } from "lucide-react";
import type { InventoryRefreshJob, UnifiedAgentInventoryPage } from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { SavedAgentInventoryVerification } from "./SavedInventoryVerification";

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
  onRefreshPackages,
  onRefreshMatchingDetails,
  onRefreshPowerPlatform,
  onResumePowerPlatform,
  onExportPowerPlatform,
  onOpenAgents,
}: Props) {
  const observation = inventory?.sources.powerPlatform.observation;
  const snapshotId = observation?.snapshotId;
  const currentInventory = !verifyingInventory && !inventoryError ? inventory : undefined;
  const invalidPackages = currentInventory?.identityCollection?.invalidPackages ?? 0;
  return (
    <section className="sync-inventory-tools" aria-labelledby="sync-inventory-heading">
      {!verifyingInventory && (inventoryError || currentInventory?.verification.status === "needs_attention" || currentInventory?.partial) ? (
        <div className="notice" role={inventoryError ? "alert" : "status"}>
          Inventory needs attention. Open Advanced results for details.
        </div>
      ) : null}
      <details className="data-sync-source-details">
        <summary id="sync-inventory-heading">Advanced results</summary>
        <div className="data-sync-source-details-content">
          <div className="section-heading">
            <h2>Agent inventory sources</h2>
            <button type="button" className="secondary" onClick={onOpenAgents}>Browse agents</button>
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
              <button type="button" className="secondary" onClick={onOpenAgents}>Select packages on Agents</button>
            </div>
          </section>
          <section className="sync-source-tools" aria-label="Power Platform agent source">
            <h3>Power Platform agent source</h3>
            <p>Refresh retained Copilot Studio agent observations or export the exact saved Power Platform snapshot. These controls do not infer links or change agent state. Exports use the search and environment filters saved on Agents.</p>
            {powerPlatformJob ? <p role="status">
              Latest agent refresh: {powerPlatformJob.status.replaceAll("_", " ")}
              {powerPlatformJob.message ? ` - ${powerPlatformJob.message}` : ""}
              {powerPlatformJob.status === "waiting_authorization" ? <> - <a href="/api/auth/login">Sign in again</a></> : null}
            </p> : null}
            <div className="inline-actions">
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
        </div>
      </details>
    </section>
  );
}
