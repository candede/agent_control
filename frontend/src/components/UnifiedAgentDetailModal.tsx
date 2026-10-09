import { useContext, useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { RefreshCw, X } from "lucide-react";
import {
  type AppRole,
  type BulkActionResult,
  type CopilotPackage,
  type CopilotPackageDetail,
  type PackageAccessUpdate,
  type QuarantineJob,
  type UnifiedAgentRecord,
} from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { quarantineTargetKey, quarantineTargetReason } from "../quarantineTarget";
import { CapabilityContext } from "../capabilityContext";
import { providerActionAllowed } from "../capabilityState";
import { useAgentPeople } from "../useAgentPeople";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { AgentOverview } from "./AgentOverview";
import { AgentAccessManagement } from "./AgentAccessManagement";
import { AgentUsagePanel } from "./AgentUsagePanel";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";
import { WorkbenchActionGate, useWorkbenchAction } from "../workbenchActionContext";
import { AgentPublishedVersions } from "./AgentPublishedVersions";
import "./agentInsights.css";

const tabs = ["identities", "reports", "users", "controls", "audit-security"] as const;
type DetailTab = typeof tabs[number];
const tabLabels: Record<DetailTab, string> = {
  identities: "Overview",
  reports: "Usage",
  users: "Users",
  "audit-security": "Activity",
  controls: "Manage",
};
type Props = {
  selectionId?: string;
  record: UnifiedAgentRecord;
  activeTab?: string;
  roles: AppRole[];
  onTabChange: (tab: string) => void;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  onInspectPackage: (item: Pick<CopilotPackage, "id">) => void;
  selectedPackageId?: string;
  packageDetail?: CopilotPackageDetail;
  packageDetailStale?: boolean;
  packageInventoryPending?: boolean;
  packageDetailLoading?: boolean;
  packageDetailError?: string;
  packageActionsBusy?: boolean;
  packageActionsBlockedReason?: string;
  onUpdatePackageAccess: (item: CopilotPackage, update: PackageAccessUpdate) => Promise<void>;
  onSetPackageBlocked: (item: CopilotPackage, blocked: boolean) => void;
  packageAccessRevisions?: ReadonlyMap<string, number>;
  packageConfirmation?: ReactNode;
  onCancelPackageConfirmation?: () => void;
  packageControlError?: { packageId: string; message: string };
  packageResults?: BulkActionResult["results"];
  dataRevision?: number;
  usageContext?: import("../../../backend/src/types/unifiedAgents").InventoryReportContext;
  inventoryRevision?: string;
  inventoryError?: string;
  onInventoryInvalidated?: (selectionId: string) => void;
  onRetryInventory?: () => void;
  onUsageChanged?: () => void;
  onPeopleChanged?: () => void;
  onQuarantineJobChange?: (job: QuarantineJob) => void;
  onOpenPerson?: (id: string) => void;
};

export function UnifiedAgentDetailModal({
  selectionId,
  record,
  activeTab,
  roles,
  onTabChange,
  onClose,
  returnFocusTo,
  onInspectPackage,
  selectedPackageId,
  packageDetail,
  packageDetailStale = false,
  packageInventoryPending = false,
  packageDetailLoading = false,
  packageDetailError,
  packageActionsBusy = false,
  packageActionsBlockedReason,
  onUpdatePackageAccess,
  onSetPackageBlocked,
  packageAccessRevisions,
  packageConfirmation,
  onCancelPackageConfirmation,
  packageControlError,
  packageResults,
  dataRevision = 0,
  usageContext,
  inventoryRevision,
  inventoryError,
  onInventoryInvalidated,
  onRetryInventory,
  onUsageChanged,
  onPeopleChanged,
  onQuarantineJobChange,
  onOpenPerson,
}: Props) {
  const peopleState = useAgentPeople(record, roles, onPeopleChanged);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogMounted = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const [internalTab, setInternalTab] = useState<DetailTab>("identities");
  const [packageSelection, setPackageSelection] = useState(() => ({
    recordId: record.id,
    packageId: selectedPackageId ?? record.packages.find(item => item.id === packageDetail?.id)?.id ?? record.packages[0]?.id,
    parentPackageId: selectedPackageId,
  }));
  if (packageSelection.recordId !== record.id) {
    setPackageSelection({
      recordId: record.id,
      packageId: (selectedPackageId !== packageSelection.parentPackageId
        ? selectedPackageId : record.packages.find(item => item.id === selectedPackageId)?.id)
        ?? record.packages.find(item => item.id === packageDetail?.id)?.id ?? record.packages[0]?.id,
      parentPackageId: selectedPackageId,
    });
  } else if (packageSelection.parentPackageId !== selectedPackageId) {
    setPackageSelection({ ...packageSelection, packageId: selectedPackageId ?? packageSelection.packageId, parentPackageId: selectedPackageId });
  } else if (packageSelection.packageId === undefined && record.packages.length) {
    setPackageSelection({ ...packageSelection, packageId: record.packages[0].id });
  }
  const requestedPackage = useRef<string | undefined>(undefined);
  const packageSelectId = useId();
  const inspectAction = useWorkbenchAction("packages.inspect");
  const accessAction = useWorkbenchAction("packages.access");
  const capabilities = useContext(CapabilityContext);
  const canInspectPackage = Boolean(inspectAction && inspectAction.roles.some(role => hasAppRole(roles, role))
    && (!inspectAction.capabilityId || capabilities && providerActionAllowed(
      capabilities.views.find(view => view.definition.id === inspectAction.capabilityId),
      inspectAction.preview === "required",
      capabilities.now,
    )));
  const canEditAccess = Boolean(accessAction && accessAction.roles.some(role => hasAppRole(roles, role))
    && (!accessAction.capabilityId || capabilities && providerActionAllowed(
      capabilities.views.find(view => view.definition.id === accessAction.capabilityId),
      true, capabilities.now,
    )));
  const preferredPackageId = packageSelection.recordId === record.id ? packageSelection.packageId : undefined;
  const selectedPackage = record.packages.find(item => item.id === preferredPackageId);
  const packageLabels = record.packages.map(item => `${item.displayName}${item.version ? ` - Version ${item.version}` : ""}`);
  const missingPackageSelection = preferredPackageId !== undefined && !selectedPackage;
  const packageTarget = selectedPackage ?? (record.packagesComplete === false && preferredPackageId !== undefined
    ? { id: preferredPackageId } : undefined);
  const selectedDetail = packageDetail?.id === selectedPackage?.id ? packageDetail : undefined;
  const overviewKey = JSON.stringify([
    capabilities?.user?.tenantId, capabilities?.user?.homeAccountId, [...roles].sort(), record.id,
  ]);
  const currentDetail = packageDetailStale ? undefined : selectedDetail;
  const hasPackageConfirmation = Boolean(packageConfirmation);
  const packageResult = packageResults?.find(result => result.id === selectedPackage?.id);
  const controlError = packageControlError && packageControlError.packageId === selectedPackage?.id ? packageControlError.message : undefined;
  const packageKey = JSON.stringify([
    record.id, selectedPackage?.id, selectionId, inventoryRevision,
    selectedPackage ? record.observations.packageSnapshots[selectedPackage.id]?.snapshotId : undefined,
    record.observations.graphPackages?.snapshotId,
  ]);
  const selectedTab = tabs.find(tab => tab === (activeTab ?? internalTab)) ?? "identities";
  const usesPackageDetails = selectedTab === "identities" || selectedTab === "controls";
  const resource = record.powerPlatformResource;
  const quarantineReason = quarantineTargetReason(resource ?? undefined, record.observations.powerPlatform);
  const canManage = hasAppRole(roles, "AgentControl.Admin");
  const inspectSelectedPackage = useEffectEvent(() => {
    if (selectedPackage) onInspectPackage(selectedPackage);
  });

  useEffect(() => {
    if (!selectedPackage) {
      requestedPackage.current = undefined;
      return;
    }
    if (packageActionsBusy || hasPackageConfirmation) {
      if (!packageDetailError) requestedPackage.current = undefined;
      return;
    }
    // A pending inventory read has not invalidated the selected detail request.
    if (packageInventoryPending || inventoryError) return;
    if (currentDetail) {
      requestedPackage.current = packageDetailLoading ? packageKey : undefined;
      return;
    }
    if (!usesPackageDetails || !canInspectPackage
      || requestedPackage.current === packageKey) return;
    requestedPackage.current = packageKey;
    inspectSelectedPackage();
  }, [usesPackageDetails, canInspectPackage, selectedPackage, currentDetail, packageKey, packageDetailLoading, packageDetailError, packageActionsBusy, packageInventoryPending, inventoryError, hasPackageConfirmation]);

  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [selectedTab, record.id, hasPackageConfirmation]);

  const restoreFocus = useEffectEvent(() => {
    if (returnFocusTo?.current?.isConnected) returnFocusTo.current.focus();
  });

  useEffect(() => {
    const element = dialog.current;
    dialogMounted.current = true;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    closeButton.current?.focus();
    return () => {
      dialogMounted.current = false;
      if (element?.open && typeof element.close === "function") element.close();
      restoreFocus();
    };
  }, []);

  function selectTab(tab: DetailTab) {
    setInternalTab(tab);
    onTabChange(tab);
  }

  function selectPackage(id: string) {
    setPackageSelection(current => ({ ...current, recordId: record.id, packageId: id }));
    if (!record.packages.some(item => item.id === id)) onInspectPackage({ id });
  }

  function close() {
    if (typeof dialog.current?.close === "function") dialog.current.close();
    else onClose();
  }

  return (
    <dialog
      ref={dialog}
      className="inventory-detail-modal unified-agent-detail-modal"
      aria-labelledby="unified-agent-detail-title"
      onClose={event => {
        // Native close events can arrive after Strict Mode has reopened the dialog.
        if (event.target === event.currentTarget && dialogMounted.current && !event.currentTarget.open) onClose();
      }}
      onMouseDown={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
      onCancel={event => {
        if (event.target === event.currentTarget && hasPackageConfirmation) {
          event.preventDefault();
          onCancelPackageConfirmation?.();
        }
      }}
    >
      <header>
        <div><p className="eyebrow">Agent management</p><h2 id="unified-agent-detail-title">{record.displayName}</h2></div>
        {!inventoryError && onRetryInventory ? <button type="button" className="secondary icon-button" aria-label="Reload saved inventory"
          title="Reload saved inventory" disabled={packageInventoryPending || packageActionsBusy || hasPackageConfirmation}
          onClick={onRetryInventory}><RefreshCw size={18} aria-hidden="true" /></button> : null}
        <button ref={closeButton} type="button" className="icon-button" aria-label="Close unified agent details" onClick={close}><X aria-hidden="true" /></button>
      </header>
      <div className="detail-tabs" role="tablist" aria-label="Agent details">
        {tabs.map(tab => <button key={tab} id={`unified-agent-tab-${tab}`} type="button" role="tab" disabled={hasPackageConfirmation} aria-selected={selectedTab === tab} aria-controls={`unified-agent-panel-${tab}`} tabIndex={selectedTab === tab ? 0 : -1} onClick={() => selectTab(tab)} onKeyDown={event => {
          const index = tabs.indexOf(tab);
          const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
            : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
              : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
          if (!next) return;
          event.preventDefault();
          selectTab(next);
          dialog.current?.querySelector<HTMLButtonElement>(`#unified-agent-tab-${next}`)?.focus();
        }}>{tabLabels[tab]}</button>)}
      </div>
      {record.identity.invalidMetadata ? <div className="notice" role="status">
        <strong>Invalid saved matching metadata.</strong>{" "}
        Select this agent on Agents, then choose <strong>Sync &gt; View diagnostics &gt; Refresh matching details</strong>.
      </div> : null}
      {packageDetailError ? <p className="error-banner unified-agent-detail-error" role="alert">{packageDetailError}</p> : null}
      {inventoryError ? <div className="error-banner unified-agent-detail-error" role="alert">
        <p>{inventoryError}</p>
        {onRetryInventory ? <button type="button" className="secondary" disabled={packageInventoryPending}
          onClick={onRetryInventory}>Retry saved inventory</button> : null}
      </div> : null}
      <section ref={panel} id={`unified-agent-panel-${selectedTab}`} role="tabpanel" aria-labelledby={`unified-agent-tab-${selectedTab}`} tabIndex={0} className="inventory-detail-section">
        {usesPackageDetails && (selectedPackage || missingPackageSelection) ? <>
          {record.packagesComplete === false && selectionId ? <AgentPublishedVersions key={`${selectionId}:${record.id}`}
            selectionId={selectionId} record={record} selectedId={preferredPackageId}
            disabled={!canInspectPackage || packageActionsBusy || packageInventoryPending || Boolean(inventoryError) || hasPackageConfirmation}
            onSelect={selectPackage} onInvalidated={() => onInventoryInvalidated?.(selectionId)} />
            : record.packages.length > 1 || missingPackageSelection ? <div className="agent-version-selector">
            <label htmlFor={packageSelectId}>Published version details</label>
            <select id={packageSelectId} value={selectedPackage?.id ?? ""} disabled={!record.packages.length || !canInspectPackage || packageActionsBusy || packageInventoryPending || Boolean(inventoryError) || hasPackageConfirmation}
              onChange={event => selectPackage(event.target.value)}>
              {missingPackageSelection ? <option value="" disabled>{packageDetailLoading ? "Loading selected version..." : "Selected version unavailable"}</option> : null}
              {record.packages.map((item, index) => <option key={item.id} value={item.id}>
                {packageLabels[index]}{packageLabels.indexOf(packageLabels[index]) !== packageLabels.lastIndexOf(packageLabels[index]) ? ` (${index + 1})` : ""}
              </option>)}
            </select>
          </div> : null}
          {missingPackageSelection && packageDetailLoading ? <p role="status">Loading selected published version...</p> : null}
          {missingPackageSelection && !packageDetailLoading ? <p className="error-banner" role="alert">
            The selected published version <code>{preferredPackageId}</code> {record.packagesComplete === false
              ? "is not in the loaded version list. Choose it from Published version details." : "is no longer in this saved agent inventory."}
            {packageDetailError ? ` ${packageDetailError}` : ""}
            Choose an available version explicitly or <a href="/sync">refresh agent inventory</a>.
          </p> : null}
          {packageTarget && !selectedDetail && !hasPackageConfirmation && packageDetailError ? <WorkbenchActionGate actionId="packages.inspect" compact>
            <button type="button" className="secondary" disabled={packageActionsBusy || packageDetailLoading || packageInventoryPending || Boolean(inventoryError)}
              onClick={() => onInspectPackage(packageTarget)}>Retry saved details</button>
          </WorkbenchActionGate> : null}
          {selectedPackage && !selectedDetail && !hasPackageConfirmation && !packageDetailError ? canInspectPackage ? <p className="agent-metadata-status" role="status">{packageActionsBusy
            ? "Saved details will be loaded when the current management action finishes."
            : packageInventoryPending && !packageDetailLoading ? "Saved details will be loaded when the saved inventory is ready."
            : inventoryError && !packageDetailLoading ? "Reload saved inventory before loading saved package details."
            : "Loading saved agent details..."}</p> : <p className="agent-insight-note">Additional details require package read access.</p> : null}
        </> : null}
        {selectedTab === "identities" ? <AgentOverview onOpenPerson={onOpenPerson} key={overviewKey}
          record={record} selectionId={selectionId} selectedPackage={selectedPackage} packageDetail={selectedDetail} peopleState={peopleState}
          onInvalidated={() => { if (selectionId) onInventoryInvalidated?.(selectionId); }} /> : null}
        {selectedTab === "reports" || selectedTab === "users" ? <AgentUsagePanel key={record.id}
          view={selectedTab === "reports" ? "usage" : "users"}
          record={record} context={usageContext} inventoryRevision={JSON.stringify([selectionId?.toLowerCase(), inventoryRevision])} dataRevision={dataRevision}
          inventorySelectionId={selectionId} onReloadInventory={onRetryInventory}
          canRemoveReviewedAssociations={canManage}
          disabled={packageActionsBusy || packageInventoryPending || Boolean(inventoryError)} onChanged={onUsageChanged} /> : null}
        {selectedTab === "audit-security" ?
          <AgentInvestigationsPanel recordId={record.id} agentName={record.displayName} roles={roles}
            revision={JSON.stringify([selectionId, inventoryRevision, dataRevision, record.observations.powerPlatform?.snapshotId])} /> : null}
        {selectedTab === "controls" ? <>
          <h3>Manage</h3>
          {!canManage ? <p className="association-status">An AgentControl.Admin role is required to make changes.</p> : null}
          {canManage && !canEditAccess ? <p className="agent-insight-note">Access settings are read-only until access-management permissions are available.</p> : null}
          {packageActionsBlockedReason || controlError ? <p className="error-banner" role="alert">{packageActionsBlockedReason ?? controlError}</p> : null}
          {packageResult ? <p className={packageResult.status === "succeeded" ? "notice" : "error-banner"} role={packageResult.status === "succeeded" ? "status" : "alert"}>
            {packageResult.message ?? (packageResult.status === "succeeded" ? "The change completed for this published version." : "The change was not applied to this published version.")}
          </p> : null}
          {packageConfirmation}
        </> : null}
        {selectedPackage && capabilities ? <div hidden={selectedTab !== "controls" || hasPackageConfirmation}>
          <AgentAccessManagement key={`${record.id}:${selectedPackage.id}`} revision={packageAccessRevisions?.get(selectedPackage.id) ?? 0}
            agent={selectedPackage} detail={selectedDetail} canManage={canManage} canEditAccess={canEditAccess}
            detailUnavailable={!selectedDetail && Boolean(packageDetailError)}
            showName={selectedPackage.displayName !== record.displayName}
            active={selectedTab === "controls" && !hasPackageConfirmation && !packageDetailLoading
              && !packageDetailStale && !packageInventoryPending && !inventoryError && !packageActionsBlockedReason}
            busy={packageActionsBusy || hasPackageConfirmation} loading={packageDetailLoading && !selectedDetail}
            onUpdate={onUpdatePackageAccess} onSetBlocked={onSetPackageBlocked} />
        </div> : null}
        {selectedTab === "controls" && !hasPackageConfirmation ? <>
          {!record.packages.length ? <p>No published version is available for availability or installation settings.</p> : null}
          {!record.packages.length && quarantineReason ? <p className="agent-insight-note">No supported management target is present in the saved inventory. <a href="/sync">Refresh agent inventory</a> and <a href="/permissions">review permissions</a> before choosing a control.</p> : null}
        </> : null}
        <div hidden={selectedTab !== "controls" || hasPackageConfirmation}>
          <div className="agent-management-sections">
            {resource ? <CopilotStudioQuarantineControls
                key={JSON.stringify([overviewKey, resource.type, quarantineTargetKey(resource)])}
                snapshot={record.observations.powerPlatform}
                targets={[resource]}
                variant="detail"
                canManage={canManage}
                active={selectedTab === "controls" && !hasPackageConfirmation}
                onJobChange={onQuarantineJobChange}
              /> : null}
          </div>
        </div>
      </section>
    </dialog>
  );
}
