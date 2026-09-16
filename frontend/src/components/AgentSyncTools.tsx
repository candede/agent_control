import { Download, RefreshCw } from "lucide-react";
import type { InventoryRefreshJob, UnifiedAgentInventoryPage } from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";

type Props = {
  inventory?: UnifiedAgentInventoryPage;
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
  const powerPlatformObservation = observation && "roleScope" in observation ? observation : undefined;
  const snapshotId = observation?.snapshotId;
  return (
    <section className="sync-inventory-tools" aria-labelledby="sync-inventory-heading">
      <div className="section-heading">
        <h2 id="sync-inventory-heading">Agent inventory sources</h2>
        <button type="button" className="secondary" onClick={onOpenAgents}>Browse agents</button>
      </div>
      {inventory?.partial ? <div className="notice" role="status">
        <strong>Partial unified inventory.</strong>{" "}
        {inventory.errors.map(item => item.message).join(" ")}
      </div> : null}
      {inventory ? <dl className="sync-inventory-counts" aria-label="Agent source coverage">
        <div><dt>Total</dt><dd>{inventory.summary.total.toLocaleString()}</dd></div>
        <div><dt>Source-metadata links</dt><dd>{inventory.summary.linked.toLocaleString()}</dd></div>
        <div><dt>Graph only</dt><dd>{inventory.summary.graphOnly.toLocaleString()}</dd></div>
        <div><dt>Power Platform only</dt><dd>{inventory.summary.powerPlatformOnly.toLocaleString()}</dd></div>
      </dl> : null}
      <section className="sync-source-tools" aria-label="Source matching details">
        <h3>Agent identity matching</h3>
        <p>Refresh agents collects the full list and exact identity details automatically. Records are combined only when their environment and native identities are corroborated, never by display name alone.</p>
        {inventory?.identityCollection ? <p>{inventory.identityCollection.checkedPackages.toLocaleString()} package identities checked; {inventory.identityCollection.pendingPackages.toLocaleString()} still need collection.</p> : null}
        <p>Checked means package details were collected, not that Microsoft supplied matching identity metadata. Source-only records do not by themselves prove missing agents.</p>
        {inventory && (inventory.summary.conflicting > 0 || inventory.summary.ambiguous > 0) ? <p role="status">
          {inventory.summary.conflicting.toLocaleString()} conflicting and {inventory.summary.ambiguous.toLocaleString()} ambiguous package identities remain unlinked. Inspect their matching details on Agents; names alone cannot resolve them.
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
        {powerPlatformObservation ? <dl className="sync-inventory-counts" aria-label="Saved Power Platform coverage">
          <div><dt>Resources collected in saved scope</dt><dd>{powerPlatformObservation.observedCount.toLocaleString()} / {powerPlatformObservation.totalRecords.toLocaleString()}</dd></div>
          <div><dt>Copilot Studio agents observed</dt><dd>{powerPlatformObservation.coveredCount?.toLocaleString() ?? "Not established"}</dd></div>
          <div><dt>Provider role scope</dt><dd>{powerPlatformObservation.roleScope === "unknown" ? "Unknown" : powerPlatformObservation.roleScope === "ai" ? "AI-scoped" : "Full"}</dd></div>
          <div><dt>Copilot Studio type coverage</dt><dd>{powerPlatformObservation.coverage === "covered" ? "Covered in saved scope" : powerPlatformObservation.coverage === "not_authorized_scope" ? "Not authorized in saved scope" : "Unknown"}</dd></div>
        </dl> : null}
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
    </section>
  );
}
