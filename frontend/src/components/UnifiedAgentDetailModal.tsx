import { useContext, useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  getInventorySourceAwareDetail,
  type AppRole,
  type AgentUsageContext,
  type BulkActionResult,
  type CopilotPackage,
  type CopilotPackageDetail,
  type InventorySourceAwareDetail,
  type PackageAccessUpdate,
  type UnifiedAgentRecord,
} from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { quarantineTargetReason } from "../quarantineTarget";
import { CapabilityContext } from "../capabilityContext";
import { providerActionAllowed } from "../capabilityState";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { AgentOverview } from "./AgentOverview";
import { AgentAccessManagement } from "./AgentAccessManagement";
import { AgentUsagePanel } from "./AgentUsagePanel";
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
type RelatedState =
  | { key: string; status: "available"; value: InventorySourceAwareDetail }
  | { key: string; status: "error"; message: string };

type Props = {
  record: UnifiedAgentRecord;
  activeTab?: string;
  roles: AppRole[];
  environmentNames?: Record<string, string>;
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
};

export function UnifiedAgentDetailModal({
  record,
  activeTab,
  roles,
  environmentNames = {},
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
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogMounted = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const [internalTab, setInternalTab] = useState<DetailTab>("identities");
  const [relatedState, setRelatedState] = useState<RelatedState>();
  const [relatedRetry, setRelatedRetry] = useState(0);
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
  const requestedTab = activeTab === "package" || activeTab === "power-platform" ? "identities" : activeTab;
  const selectedTab = tabs.find(tab => tab === (requestedTab ?? internalTab)) ?? "identities";
  const usesPackageDetails = selectedTab === "identities" || selectedTab === "controls";
  const resource = record.powerPlatformResource;
  const snapshot = record.observations.powerPlatform;
  const relatedKey = resource && snapshot
    ? JSON.stringify([snapshot.snapshotId, resource.type, resource.environmentId, resource.nativeId, relatedRetry, dataRevision])
    : undefined;
  const scopedRelated = relatedState?.key === relatedKey ? relatedState : undefined;
  const related = scopedRelated?.status === "available" ? scopedRelated.value : undefined;
  const relatedError = scopedRelated?.status === "error" ? scopedRelated.message : "";
  const relatedUnavailable = !resource
    ? "No saved activity is linked to this agent's inventory record."
    : !snapshot
      ? "Saved activity cannot be loaded for this agent until its inventory observation is refreshed."
      : undefined;
  const quarantineReason = quarantineTargetReason(resource ?? undefined, record.observations.powerPlatform);
  const canManage = hasAppRole(roles, "AgentControl.Admin");
  const inspectSelectedPackage = useEffectEvent(() => {
    if (selectedPackage) onInspectPackage(selectedPackage);
  });

  useEffect(() => {
    if (packageActionsBusy || hasPackageConfirmation) {
      requestedPackage.current = undefined;
      return;
    }
    if (!usesPackageDetails || !canInspectPackage || !selectedPackage || selectedDetail
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

  useEffect(() => {
    if (!resource || !snapshot || !relatedKey) return;
    const controller = new AbortController();
    getInventorySourceAwareDetail({
      snapshotId: snapshot.snapshotId,
      nativeId: resource.nativeId,
      type: resource.type,
      environmentId: resource.environmentId,
    }, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setRelatedState({ key: relatedKey, status: "available", value: result });
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          setRelatedState({
            key: relatedKey,
            status: "error",
            message: error instanceof Error ? error.message : "Source-aware details are unavailable.",
          });
        }
      });
    return () => controller.abort();
  }, [relatedKey, resource, snapshot]);

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
        Select this agent on Agents, then open <strong>Sync &gt; Advanced results</strong> and use <strong>Refresh matching details</strong> for 1-100 selected packages, or <strong>Refresh agents</strong> for the full inventory. A completed metadata check does not establish a match.
      </div> : null}
      {packageDetailError ? <p className="error-banner unified-agent-detail-error" role="alert">{packageDetailError}</p> : null}
      <section ref={panel} id={`unified-agent-panel-${selectedTab}`} role="tabpanel" aria-labelledby={`unified-agent-tab-${selectedTab}`} tabIndex={0} className="inventory-detail-section">
        {usesPackageDetails && (selectedPackage || missingPackageSelection) ? <>
          {record.packages.length > 1 || missingPackageSelection ? <div className="agent-version-selector">
            <label htmlFor={packageSelectId}>Published version details</label>
            <select id={packageSelectId} value={selectedPackage?.id ?? ""} disabled={!record.packages.length || !canInspectPackage || packageActionsBusy || hasPackageConfirmation}
              onChange={event => setPackageSelection(current => ({ ...current, recordId: record.id, packageId: event.target.value }))}>
              {missingPackageSelection ? <option value="" disabled>Selected version unavailable</option> : null}
              {record.packages.map(item => <option key={item.id} value={item.id}>{item.displayName}{item.version ? ` - Version ${item.version}` : ""} ({item.id})</option>)}
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
            : "Loading saved agent details..."}</p> : <p className="agent-insight-note">Additional saved details require the package read action to be available. The saved inventory information remains visible.</p> : null}
        </> : null}
        {selectedTab === "identities" ? <AgentOverview key={`${record.id}:${selectedPackage?.id ?? "native"}:${selectedDetail?.observation?.observedAt ?? "saved"}`}
          record={record} selectedPackage={selectedPackage} packageDetail={selectedDetail} environmentNames={environmentNames} /> : null}
        {selectedTab === "reports" ? <AgentUsagePanel key={JSON.stringify([record.id, usageContext?.revision, inventoryRevision])}
          record={record} context={usageContext} inventoryRevision={inventoryRevision} canManage={canManage}
          disabled={packageActionsBusy} onChanged={onUsageChanged} /> : null}
        {selectedTab === "identities" ? <details className="agent-technical-details" open={activeTab === "power-platform" || undefined}>
          <summary>Technical details</summary>
          {resource ? <PowerPlatformPanel record={record} /> : null}
          <IdentityPanel record={record} />
        </details> : null}
        {selectedTab === "audit-security" ? <AuditSecurityPanel agentName={record.displayName} related={related} error={relatedError} unavailable={relatedUnavailable} onRetry={() => setRelatedRetry(value => value + 1)} /> : null}
        {selectedTab === "controls" ? <>
          <h3>Manage</h3>
          <p className="tab-description">Apply checks current settings before exact-target confirmation.</p>
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
          {!record.packages.length ? <p>Availability and installation have not been observed. No published version is available for these controls.</p> : null}
          {!record.packages.length && quarantineReason ? <p className="agent-insight-note">No supported management target is present in the saved inventory. <a href="/sync">Refresh agent inventory</a> and <a href="/permissions">review permissions</a> before choosing a control.</p> : null}
          <div className="agent-management-sections">
            {resource && !quarantineReason ? <article className="agent-management-card">
              <div className="management-card-heading">
                <div><h4>Quarantine and restore</h4><p>Restrict connected channels independently from availability and blocking of published versions.</p></div>
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

function IdentityPanel({ record }: { record: UnifiedAgentRecord }) {
  return <>
    <h3>{record.identity.state === "matched" ? "Linked by source metadata" : record.identity.state === "unmatched" ? "No verified link" : `${label(record.identity.state)} link evidence`}</h3>
    <p className="association-status">{record.identity.reason ?? (record.identity.state === "matched"
      ? "The sources share explicit source-declared provider metadata."
      : "A source counterpart has not been proven.")}{record.identity.state === "matched" ? " This is correlation within the current authorized saved inventory, not a Microsoft-guaranteed native foreign key. This is not presented as a publicly documented Microsoft canonical identifier equivalence. Association does not grant or renew native controls." : ""}</p>
    {record.identity.warnings?.length ? <>
      <h4>Source identity warnings</h4>
      <ul>{record.identity.warnings.map((warning, index) => <li key={`${warning.code}:${index}`}>{warning.message}</li>)}</ul>
    </> : null}
    <div className="inventory-detail-grid">
      <Detail label="Unified record ID" value={record.id} />
      <Detail label="Source presence" value={record.presence} />
      <Detail label="Environment" value={record.environmentId} />
      <Detail label="Graph packages" value={record.packages.length} />
      <Detail label="Package IDs" value={record.packages.map(item => item.id).join(", ")} />
      <Detail label="Power Platform resource" value={record.powerPlatformResource?.nativeId} />
      <Detail label="Link state" value={record.identity.state} />
    </div>
    {record.identity.evidence.length ? <dl className="inventory-identifiers">{record.identity.evidence.map((evidence, index) => <div key={`${evidence.kind}:${evidence.packagePath}:${evidence.resourcePath}:${index}`}><dt>{label(evidence.kind)}</dt><dd><strong>{label(evidence.basis)}</strong> · element labels {formatElementLabels(evidence.elementIds)}<br /><code>{evidence.packagePath}</code> ↔ <code>{evidence.resourcePath}</code><RelatedPackageEvidence packageIds={evidence.relatedPackageIds} /></dd></div>)}</dl> : null}
    {record.identity.packageEvidence.length ? <><h4>Evidence by exact package</h4><dl className="inventory-identifiers">{record.identity.packageEvidence.map(item => <div key={item.packageId}><dt>{item.packageId}</dt><dd>{item.evidence.length ? <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.kind}:${index}`}><strong>{label(evidence.kind)}</strong> · {label(evidence.basis)} · element labels {formatElementLabels(evidence.elementIds)}<br /><code>{evidence.packagePath}</code> ↔ <code>{evidence.resourcePath}</code><RelatedPackageEvidence packageIds={evidence.relatedPackageIds} /></li>)}</ul> : "No source-declared identity evidence retained for this exact package."}</dd></div>)}</dl></> : null}
    <h4>Saved observations</h4>
    <div className="inventory-detail-grid">
      <Detail label="Graph snapshot" value={record.observations.graphPackages?.snapshotId} />
      <Detail label="Graph observed" value={formatDate(record.observations.graphPackages?.observedAt)} />
      <Detail label="Power Platform snapshot" value={record.observations.powerPlatform?.snapshotId} />
      <Detail label="Power Platform observed" value={formatDate(record.observations.powerPlatform?.observedAt)} />
    </div>
  </>;
}

function formatElementLabels(labels: string[]) {
  return labels.filter(value => value.trim().length > 0).join(", ") || "Not supplied";
}

function RelatedPackageEvidence({ packageIds }: { packageIds?: string[] }) {
  if (!packageIds?.length) return null;
  return <>
    <br /><span>Related exact packages</span>
    <ul aria-label="Related exact packages">{packageIds.map((id, index) => <li key={`${id}:${index}`}><code>{id}</code></li>)}</ul>
  </>;
}

function PowerPlatformPanel({ record }: { record: UnifiedAgentRecord }) {
  const resource = record.powerPlatformResource;
  if (!resource) return <><h3>Configuration</h3><p>No configuration has been observed for this agent.</p></>;
  return <>
    <h3>Configuration</h3>
    <div className="inventory-detail-grid">
      <Detail label="Native resource ID" value={resource.nativeId} />
      <Detail label="Environment" value={resource.environmentId} />
      <Detail label="CDS bot ID" value={resource.identifiers.find(item => item.kind === "cds_bot_id")?.value} />
      <Detail label="Entra agent ID" value={resource.identifiers.find(item => item.kind === "entra_agent_id")?.value} />
      <Detail label="Schema name" value={resource.details.schemaName} />
      <Detail label="Authoring tool (raw)" value={resource.details.createdIn} />
      <Detail label="Authoring tool" value={resource.authoringTool} />
    </div>
    <p>{resource.unknownFieldCount} unknown or malformed fields were omitted from the saved observation.</p>
  </>;
}

function AuditSecurityPanel({ agentName, related, error, unavailable, onRetry }: { agentName: string; related?: InventorySourceAwareDetail; error: string; unavailable?: string; onRetry: () => void }) {
  return <>
    <h3>Activity for {agentName}</h3>
    <p className="tab-description">Only saved audit events and security observations associated with this agent are shown. Missing evidence is not proof of inactivity or safety.</p>
    {unavailable ? <p className="agent-insight-note">{unavailable}</p> : error ? <div className="error-banner" role="alert">{error} <button type="button" className="secondary" onClick={onRetry}>Retry activity</button></div> : <>
      <article className="agent-management-card">
        <RelatedState heading="Audit activity" source={related?.audit} />
        {related?.audit.status === "available" && related.audit.value.length ? <div className="agent-insight-table-shell" role="region" aria-label="Agent audit events" tabIndex={0}>
          <table className="agent-insight-table"><thead><tr><th scope="col">Operation</th><th scope="col">Observed</th><th scope="col">Result</th><th scope="col">Investigation</th></tr></thead><tbody>
            {related.audit.value.map(item => <tr key={`${item.jobId}:${item.wrapperId}`}><th scope="row">{item.operation}</th><td>{formatDate(item.observedAt)}</td><td>{item.resultStatus ?? "Not reported"}</td><td><a href={`/audit?${new URLSearchParams({ source: "purview", job: item.jobId })}`}>View audit search</a></td></tr>)}
          </tbody></table>
        </div> : null}
      </article>
      <article className="agent-management-card">
        <RelatedState heading="Security observations" source={related?.security} />
        {related?.security.status === "available" && related.security.value.length ? <dl className="inventory-identifiers">{related.security.value.map(item => <div key={`${item.snapshotId}:${item.nativeRecordId}`}><dt>{item.nativeRecordId}</dt><dd>{formatDate(item.observedAt)} · {item.lifecycleStatus ?? "Lifecycle not supplied"} · <a href={`/security?${new URLSearchParams({ job: item.jobId })}`}>View security investigation</a></dd></div>)}</dl> : null}
      </article>
    </>}
  </>;
}

function RelatedState({ heading, source }: {
  heading: string;
  source: InventorySourceAwareDetail["audit"] | InventorySourceAwareDetail["security"] | undefined;
}) {
  if (!source) return <><h4>{heading}</h4><p role="status">Loading saved activity associations...</p></>;
  if (source.status !== "available") return <><h4>{heading}</h4><p>{label(source.status)}: {source.reason}</p></>;
  return <><h4>{heading}</h4><p>{source.count === 0 ? "Authorized and queried; no exact associated records." : `${source.count} exact associated record${source.count === 1 ? "" : "s"}; showing ${source.value.length}.`}</p></>;
}

function Detail({ label: heading, value }: { label: string; value: ReactNode }) {
  return <div><span>{heading}</span><strong>{value === null || value === undefined || value === "" ? "Not supplied" : value}</strong></div>;
}

function label(value: string) {
  const result = value.replaceAll("_", " ").replaceAll("-", " ");
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not supplied";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not supplied" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
