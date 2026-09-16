import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  getInventorySourceAwareDetail,
  type AppRole,
  type CopilotPackage,
  type InventorySourceAwareDetail,
  type PackageAccessTarget,
  type UnifiedAgentRecord,
} from "../api/client";
import { hasAppRole } from "../../../backend/src/types/capability";
import { formatAccessScope } from "../accessScope";
import { quarantineTargetReason } from "../quarantineTarget";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { PowerPlatformResourceData } from "./InventoryExplorer";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { AgentAuthoringTools, AgentAvailability, AgentStatus } from "./UnifiedAgentTable";

const tabs = ["identities", "package", "power-platform", "reports", "audit-security", "controls"] as const;
type DetailTab = typeof tabs[number];
const tabLabels: Record<DetailTab, string> = {
  identities: "Overview",
  package: "Availability",
  "power-platform": "Configuration",
  reports: "Usage",
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
  onManagePackageAccess: (item: CopilotPackage, target?: PackageAccessTarget) => void;
  onSetPackageBlocked: (item: CopilotPackage, blocked: boolean) => void;
  externalAccessEditorOpen?: boolean;
};

export function UnifiedAgentDetailModal({
  record,
  activeTab,
  roles,
  environmentNames = {},
  onTabChange,
  onClose,
  onInspectPackage,
  onManagePackageAccess,
  onSetPackageBlocked,
  externalAccessEditorOpen = false,
}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [internalTab, setInternalTab] = useState<DetailTab>("identities");
  const [relatedState, setRelatedState] = useState<RelatedState>();
  const selectedTab = tabs.find(tab => tab === (activeTab ?? internalTab)) ?? "identities";
  const resource = record.powerPlatformResource;
  const snapshot = record.observations.powerPlatform;
  const relatedKey = resource && snapshot
    ? JSON.stringify([snapshot.snapshotId, resource.type, resource.environmentId, resource.nativeId])
    : undefined;
  const scopedRelated = relatedState?.key === relatedKey ? relatedState : undefined;
  const related = scopedRelated?.status === "available" ? scopedRelated.value : undefined;
  const relatedError = scopedRelated?.status === "error" ? scopedRelated.message : "";
  const relatedUnavailable = !resource
    ? "No Power Platform resource is linked; these exact source associations were not queried."
    : !snapshot
      ? "No saved Power Platform snapshot is available; these exact source associations were not queried."
      : undefined;
  const quarantineReason = quarantineTargetReason(resource ?? undefined, record.observations.powerPlatform);
  const canManage = hasAppRole(roles, "AgentControl.Admin");

  useEffect(() => {
    const element = dialog.current;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    return () => {
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
      onClose={onClose}
      onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
      onCancel={event => {
        if (externalAccessEditorOpen) event.preventDefault();
      }}
    >
      <header>
        <div><p className="eyebrow">Agent details</p><h2 id="unified-agent-detail-title">{record.displayName}</h2></div>
        <button type="button" className="icon-button" aria-label="Close unified agent details" onClick={close}><X aria-hidden="true" /></button>
      </header>
      <div className="detail-tabs" role="tablist" aria-label="Agent details">
        {tabs.map(tab => <button key={tab} id={`unified-agent-tab-${tab}`} type="button" role="tab" aria-selected={selectedTab === tab} aria-controls={`unified-agent-panel-${tab}`} tabIndex={selectedTab === tab ? 0 : -1} onClick={() => selectTab(tab)} onKeyDown={event => {
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
      <section id={`unified-agent-panel-${selectedTab}`} role="tabpanel" aria-labelledby={`unified-agent-tab-${selectedTab}`} tabIndex={0} className="inventory-detail-section">
        {selectedTab === "identities" ? <>
          <h3>Overview</h3>
          <div className="inventory-detail-grid">
            <Detail label="Environment" value={record.environmentId ? environmentNames[record.environmentId.toLowerCase()] || record.environmentId : "Unknown"} />
            <Detail label="Built with" value={<AgentAuthoringTools record={record} />} />
            <Detail label="Availability" value={<AgentAvailability record={record} />} />
            <Detail label="Status" value={<AgentStatus record={record} />} />
          </div>
          <details className="agent-technical-details">
            <summary>Technical details</summary>
            <IdentityPanel record={record} />
          </details>
        </> : null}
        {selectedTab === "package" ? <PackagesPanel record={record} canManage={canManage} onInspect={onInspectPackage} onManageAccess={onManagePackageAccess} onSetBlocked={onSetPackageBlocked} /> : null}
        {selectedTab === "power-platform" ? <PowerPlatformPanel record={record} /> : null}
        {selectedTab === "reports" ? <RelatedState heading="Official reports" source={related?.reports} error={relatedError} unavailable={relatedUnavailable} /> : null}
        {selectedTab === "audit-security" ? <AuditSecurityPanel related={related} error={relatedError} unavailable={relatedUnavailable} /> : null}
        {selectedTab === "controls" ? <>
          <h3>Manage agent</h3>
          <p>Manage who can access and install this agent, block its packages, or quarantine its connected channels. Each control applies only to its displayed target; package blocking and quarantine are independent.</p>
          {!canManage ? <p className="association-status">An AgentControl.Admin role is required to make changes.</p> : null}
          <PackagesPanel record={record} canManage={canManage} onInspect={onInspectPackage} onManageAccess={onManagePackageAccess} onSetBlocked={onSetPackageBlocked} compact />
          <h4>Quarantine and restore</h4>
          {resource && !quarantineReason ? <CopilotStudioQuarantineControls
            snapshot={record.observations.powerPlatform}
            targets={[resource]}
            variant="detail"
            canManage={canManage}
          /> : <p className="association-status">Quarantine is unavailable: {quarantineReason ?? "No exact Power Platform quarantine target is associated with this record."}</p>}
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
      : "A source counterpart has not been proven.")}{record.identity.state === "matched" ? " This is not presented as a publicly documented Microsoft canonical identifier equivalence." : ""}</p>
    {record.identity.state === "unmatched" && record.packages.length ? <p>Package detail identity metadata is not present in every broad catalog observation. Select exact packages and use <strong>Refresh matching details</strong> before concluding that no Power Platform counterpart exists.</p> : null}
    <div className="inventory-detail-grid">
      <Detail label="Unified record ID" value={record.id} />
      <Detail label="Source presence" value={record.presence} />
      <Detail label="Environment" value={record.environmentId} />
      <Detail label="Graph packages" value={record.packages.length} />
      <Detail label="Package IDs" value={record.packages.map(item => item.id).join(", ")} />
      <Detail label="Power Platform resource" value={record.powerPlatformResource?.nativeId} />
      <Detail label="Link state" value={record.identity.state} />
    </div>
    {record.identity.evidence.length ? <dl className="inventory-identifiers">{record.identity.evidence.map((evidence, index) => <div key={`${evidence.kind}:${evidence.packagePath}:${evidence.resourcePath}:${index}`}><dt>{label(evidence.kind)}</dt><dd><strong>{label(evidence.basis)}</strong> · elements {evidence.elementIds.join(", ") || "Not supplied"}<br /><code>{evidence.packagePath}</code> ↔ <code>{evidence.resourcePath}</code></dd></div>)}</dl> : null}
    {record.identity.packageEvidence.length ? <><h4>Evidence by exact package</h4><dl className="inventory-identifiers">{record.identity.packageEvidence.map(item => <div key={item.packageId}><dt>{item.packageId}</dt><dd>{item.evidence.length ? <ul>{item.evidence.map((evidence, index) => <li key={`${evidence.kind}:${index}`}><strong>{label(evidence.kind)}</strong> · {label(evidence.basis)} · elements {evidence.elementIds.join(", ") || "Not supplied"}<br /><code>{evidence.packagePath}</code> ↔ <code>{evidence.resourcePath}</code></li>)}</ul> : "No source-declared identity evidence retained for this exact package."}</dd></div>)}</dl></> : null}
    <h4>Saved observations</h4>
    <div className="inventory-detail-grid">
      <Detail label="Graph snapshot" value={record.observations.graphPackages?.snapshotId} />
      <Detail label="Graph observed" value={formatDate(record.observations.graphPackages?.observedAt)} />
      <Detail label="Power Platform snapshot" value={record.observations.powerPlatform?.snapshotId} />
      <Detail label="Power Platform observed" value={formatDate(record.observations.powerPlatform?.observedAt)} />
    </div>
  </>;
}

function PackagesPanel({ record, canManage, onInspect, onManageAccess, onSetBlocked, compact = false }: {
  record: UnifiedAgentRecord;
  canManage: boolean;
  onInspect: (item: CopilotPackage) => void;
  onManageAccess: (item: CopilotPackage, target?: PackageAccessTarget) => void;
  onSetBlocked: (item: CopilotPackage, blocked: boolean) => void;
  compact?: boolean;
}) {
  return <>
    {!compact ? <h3>Availability and installation</h3> : <h4>Access, installation and blocking</h4>}
    <p>{record.packages.length
      ? "Review access and installation for each package. Changes require confirmation of the exact package target and do not change quarantine."
      : "Availability and installation have not been observed. No package target is available for these controls."}</p>
    {record.packages.length ? <ul className="detail-list expanded-detail-list">{record.packages.map(item => <li key={item.id}>
      <span>
        <strong>{item.displayName}</strong>
        <code>{item.id}</code>
        <small>
          {item.publisher ?? "Publisher not supplied"} · {item.isBlocked === true ? "Blocked" : item.isBlocked === false ? "Not blocked" : "Block status unknown"}
          {" · "}Available to: {formatAccessScope(item.availableTo, [])}
          {" · "}Installed for: {formatAccessScope(item.deployedTo, [])}
        </small>
      </span>
      <span className="row-actions">
        <WorkbenchActionGate actionId="packages.inspect" compact><button type="button" className="secondary" aria-label={`Package details for ${item.displayName} (${item.id})`} onClick={() => onInspect(item)}>Package details</button></WorkbenchActionGate>
        {canManage ? <WorkbenchActionGate actionId="packages.access" compact><button type="button" className="secondary" aria-label={`Manage access for ${item.displayName} (${item.id})`} onClick={() => onManageAccess(item, "availability")}>Manage access</button></WorkbenchActionGate> : null}
        {canManage ? <WorkbenchActionGate actionId="packages.access" compact><button type="button" className="secondary" aria-label={`Manage installation for ${item.displayName} (${item.id})`} onClick={() => onManageAccess(item, "installation")}>Manage installation</button></WorkbenchActionGate> : null}
        {canManage && typeof item.isBlocked === "boolean" ? <WorkbenchActionGate actionId={item.isBlocked ? "packages.unblock" : "packages.block"} compact><button type="button" className={item.isBlocked ? "secondary" : "danger"} aria-label={`${item.isBlocked ? "Unblock" : "Block"} ${item.displayName} (${item.id})`} onClick={() => onSetBlocked(item, !item.isBlocked)}>{item.isBlocked ? "Unblock" : "Block"}</button></WorkbenchActionGate> : null}
      </span>
    </li>)}</ul> : null}
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
    </div>
    <PowerPlatformResourceData resource={resource} />
  </>;
}

function AuditSecurityPanel({ related, error, unavailable }: { related?: InventorySourceAwareDetail; error: string; unavailable?: string }) {
  return <>
    <RelatedState heading="Purview audit" source={related?.audit} error={error} unavailable={unavailable} />
    {related?.audit.status === "available" && related.audit.value.length ? <dl className="inventory-identifiers">{related.audit.value.map(item => <div key={`${item.jobId}:${item.wrapperId}`}><dt>{item.operation}</dt><dd>Exact {label(item.matchedKind)} · {formatDate(item.observedAt)} · event {item.nativeEventId ?? item.wrapperId}</dd></div>)}</dl> : null}
    <RelatedState heading="Defender security" source={related?.security} error={error} unavailable={unavailable} />
    {related?.security.status === "available" && related.security.value.length ? <dl className="inventory-identifiers">{related.security.value.map(item => <div key={`${item.snapshotId}:${item.nativeRecordId}`}><dt>{item.nativeRecordId}</dt><dd>Exact {label(item.matchedKind)} · {formatDate(item.observedAt)} · {item.lifecycleStatus ?? "Lifecycle not supplied"}</dd></div>)}</dl> : null}
  </>;
}

function RelatedState({ heading, source, error, unavailable }: {
  heading: string;
  source: InventorySourceAwareDetail["reports"] | InventorySourceAwareDetail["audit"] | InventorySourceAwareDetail["security"] | undefined;
  error: string;
  unavailable?: string;
}) {
  if (unavailable) return <><h3>{heading}</h3><p className="association-status">{unavailable}</p></>;
  if (error) return <><h3>{heading}</h3><p className="error-banner">{error}</p></>;
  if (!source) return <><h3>{heading}</h3><p>Loading authorized exact source associations…</p></>;
  if (source.status !== "available") return <><h3>{heading}</h3><p className="association-status">{label(source.status)}: {source.reason}</p></>;
  return <><h3>{heading}</h3><p className="association-status">{source.count === 0 ? "Authorized and queried; no exact associated records." : `${source.count} exact associated record${source.count === 1 ? "" : "s"}.`}</p></>;
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
