import { useContext, useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  type AppRole,
  type AgentUsageContext,
  type BulkActionResult,
  type CopilotPackage,
  type CopilotPackageDetail,
  type PackageAccessUpdate,
  type UnifiedAgentRecord,
} from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { quarantineTargetReason } from "../quarantineTarget";
import { CapabilityContext } from "../capabilityContext";
import { providerActionAllowed } from "../capabilityState";
import { useAgentPeople } from "../useAgentPeople";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { AgentOverview } from "./AgentOverview";
import { AgentAccessManagement } from "./AgentAccessManagement";
import { AgentUsagePanel } from "./AgentUsagePanel";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";
import { WorkbenchActionGate, useWorkbenchAction } from "../workbenchActionContext";
import "./agentInsights.css";

const tabs = ["identities", "reports", "controls", "audit-security"] as const;
type DetailTab = typeof tabs[number];
const tabLabels: Record<DetailTab, string> = {
  identities: "Overview",
  reports: "Usage & users",
  "audit-security": "Activity",
  controls: "Manage",
};
type Props = {
  record: UnifiedAgentRecord;
  activeTab?: string;
  roles: AppRole[];
  onTabChange: (tab: string) => void;
  onClose: () => void;
  onInspectPackage: (item: CopilotPackage) => void;
  selectedPackageId?: string;
  packageDetail?: CopilotPackageDetail;
  packageDetailLoading?: boolean;
  packageDetailError?: string;
  packageActionsBusy?: boolean;
  onUpdatePackageAccess: (item: CopilotPackage, update: PackageAccessUpdate) => Promise<void>;
  onSetPackageBlocked: (item: CopilotPackage, blocked: boolean) => void;
  packageAccessRevisions?: ReadonlyMap<string, number>;
  packageConfirmation?: ReactNode;
  onCancelPackageConfirmation?: () => void;
  packageControlError?: { packageId: string; message: string };
  packageResults?: BulkActionResult["results"];
  dataRevision?: number;
  usageContext?: AgentUsageContext;
  inventoryRevision?: string;
  onUsageChanged?: () => void;
  onPeopleChanged?: () => void;
  onOpenPerson?: (id: string) => void;
};

export function UnifiedAgentDetailModal({
  record,
  activeTab,
  roles,
  onTabChange,
  onClose,
  onInspectPackage,
  selectedPackageId,
  packageDetail,
  packageDetailLoading = false,
  packageDetailError,
  packageActionsBusy = false,
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
  onUsageChanged,
  onPeopleChanged,
  onOpenPerson,
}: Props) {
  const peopleState = useAgentPeople(record, roles, onPeopleChanged);
  const dialog = useRef<HTMLDialogElement>(null);
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
  const selectedDetail = packageDetail?.id === selectedPackage?.id ? packageDetail : undefined;
  const hasPackageConfirmation = Boolean(packageConfirmation);
  const packageResult = packageResults?.find(result => result.id === selectedPackage?.id);
  const controlError = packageControlError && packageControlError.packageId === selectedPackage?.id ? packageControlError.message : undefined;
  const packageKey = JSON.stringify([
    record.id, selectedPackage?.id,
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
    if (packageActionsBusy || hasPackageConfirmation || !selectedPackage || selectedDetail) {
      requestedPackage.current = undefined;
      return;
    }
    if (!usesPackageDetails || !canInspectPackage
      || requestedPackage.current === packageKey) return;
    requestedPackage.current = packageKey;
    inspectSelectedPackage();
  }, [usesPackageDetails, canInspectPackage, selectedPackage, selectedDetail, packageKey, packageActionsBusy, hasPackageConfirmation]);

  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [selectedTab, record.id, hasPackageConfirmation]);

  useEffect(() => {
    const element = dialog.current;
    dialogMounted.current = true;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    return () => {
      dialogMounted.current = false;
      if (element?.open && typeof element.close === "function") element.close();
    };
  }, []);

  function selectTab(tab: DetailTab) {
    setInternalTab(tab);
    onTabChange(tab);
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
        <button type="button" className="icon-button" aria-label="Close unified agent details" onClick={close}><X aria-hidden="true" /></button>
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
      <section ref={panel} id={`unified-agent-panel-${selectedTab}`} role="tabpanel" aria-labelledby={`unified-agent-tab-${selectedTab}`} tabIndex={0} className="inventory-detail-section">
        {usesPackageDetails && (selectedPackage || missingPackageSelection) ? <>
          {record.packages.length > 1 || missingPackageSelection ? <div className="agent-version-selector">
            <label htmlFor={packageSelectId}>Published version details</label>
            <select id={packageSelectId} value={selectedPackage?.id ?? ""} disabled={!record.packages.length || !canInspectPackage || packageActionsBusy || hasPackageConfirmation}
              onChange={event => setPackageSelection(current => ({ ...current, recordId: record.id, packageId: event.target.value }))}>
              {missingPackageSelection ? <option value="" disabled>Selected version unavailable</option> : null}
              {record.packages.map((item, index) => <option key={item.id} value={item.id}>
                {packageLabels[index]}{packageLabels.indexOf(packageLabels[index]) !== packageLabels.lastIndexOf(packageLabels[index]) ? ` (${index + 1})` : ""}
              </option>)}
            </select>
          </div> : null}
          {missingPackageSelection ? <p className="error-banner" role="alert">
            The selected published version <code>{preferredPackageId}</code> is no longer in this saved agent inventory.
            Choose an available version explicitly or <a href="/sync">refresh agent inventory</a>.
          </p> : null}
          {selectedPackage && !selectedDetail && !hasPackageConfirmation ? packageDetailError ? <WorkbenchActionGate actionId="packages.inspect" compact>
            <button type="button" className="secondary" disabled={packageActionsBusy || packageDetailLoading} onClick={() => onInspectPackage(selectedPackage)}>Retry saved details</button>
          </WorkbenchActionGate> : canInspectPackage ? <p className="agent-metadata-status" role="status">{packageActionsBusy
            ? "Saved details will be loaded when the current management action finishes."
            : "Loading saved agent details..."}</p> : <p className="agent-insight-note">Additional details require package read access.</p> : null}
        </> : null}
        {selectedTab === "identities" ? <AgentOverview onOpenPerson={onOpenPerson} key={`${record.id}:${selectedPackage?.id ?? "native"}:${selectedDetail?.observation?.observedAt ?? "saved"}`}
          record={record} selectedPackage={selectedPackage} packageDetail={selectedDetail} peopleState={peopleState} /> : null}
        {selectedTab === "reports" ? <AgentUsagePanel key={JSON.stringify([record.id, usageContext?.reportSet?.id, usageContext?.availability, usageContext?.revision, inventoryRevision])}
          record={record} context={usageContext} inventoryRevision={inventoryRevision} canRemoveReviewedAssociations={canManage}
          disabled={packageActionsBusy} onChanged={onUsageChanged} /> : null}
        {selectedTab === "audit-security" ?
          <AgentInvestigationsPanel recordId={record.id} agentName={record.displayName} roles={roles}
            revision={JSON.stringify([inventoryRevision, dataRevision, record.observations.powerPlatform?.snapshotId])} /> : null}
        {selectedTab === "controls" ? <>
          <h3>Manage</h3>
          {!canManage ? <p className="association-status">An AgentControl.Admin role is required to make changes.</p> : null}
          {canManage && !canEditAccess ? <p className="agent-insight-note">Access settings are read-only until access-management permissions are available.</p> : null}
          {controlError ? <p className="error-banner" role="alert">{controlError}</p> : null}
          {packageResult ? <p className={packageResult.status === "succeeded" ? "notice" : "error-banner"} role={packageResult.status === "succeeded" ? "status" : "alert"}>
            {packageResult.message ?? (packageResult.status === "succeeded" ? "The change completed for this published version." : "The change was not applied to this published version.")}
          </p> : null}
          {packageConfirmation}
        </> : null}
        {selectedPackage && capabilities ? <div hidden={selectedTab !== "controls" || hasPackageConfirmation}>
          <AgentAccessManagement key={`${record.id}:${selectedPackage.id}`} revision={packageAccessRevisions?.get(selectedPackage.id) ?? 0}
            agent={selectedPackage} detail={selectedDetail} canManage={canManage} canEditAccess={canEditAccess}
            showName={selectedPackage.displayName !== record.displayName}
            active={selectedTab === "controls" && !hasPackageConfirmation}
            busy={packageActionsBusy || hasPackageConfirmation} loading={packageDetailLoading}
            onUpdate={onUpdatePackageAccess} onSetBlocked={onSetPackageBlocked} />
        </div> : null}
        {selectedTab === "controls" && !hasPackageConfirmation ? <>
          {!record.packages.length ? <p>No published version is available for availability or installation settings.</p> : null}
          {!record.packages.length && quarantineReason ? <p className="agent-insight-note">No supported management target is present in the saved inventory. <a href="/sync">Refresh agent inventory</a> and <a href="/permissions">review permissions</a> before choosing a control.</p> : null}
          <div className="agent-management-sections">
            {resource && !quarantineReason ? <article className="agent-management-card">
              <div className="management-card-heading">
                <h4>Quarantine and restore</h4>
              </div>
              <CopilotStudioQuarantineControls
                key={JSON.stringify([resource.type, resource.environmentId, resource.nativeId])}
                snapshot={record.observations.powerPlatform}
                targets={[resource]}
                variant="detail"
                canManage={canManage}
              />
            </article> : resource ? <details className="agent-insight-provenance"><summary>Additional control availability</summary>
              <p>Quarantine is unavailable: {quarantineReason}</p><a href="/sync">Review inventory coverage</a>
            </details> : null}
          </div>
        </> : null}
      </section>
    </dialog>
  );
}
