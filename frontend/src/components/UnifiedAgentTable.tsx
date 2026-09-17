import { useEffect, useRef } from "react";
import { Info, Lock, LockOpen, ShieldCheck } from "lucide-react";
import { formatAgentAuthoringTool } from "../../../backend/src/types/copilotPackage";
import type { UnifiedAgentRecord } from "../api/client";
import { formatAccessScope } from "../accessScope";
import { quarantineTargetKey, quarantineTargetReason } from "../quarantineTarget";
import { WorkbenchActionGate } from "../workbenchActionContext";
import "./unifiedAgent.css";

type Props = {
  records: UnifiedAgentRecord[];
  busyPackageId?: string;
  selectedPackageIds: Set<string>;
  selectedPowerPlatformKeys: Set<string>;
  packageSelectionAllowed: boolean;
  packageOperationsAllowed: boolean;
  quarantineSelectionAllowed: boolean;
  quarantineSelectionRestoring?: boolean;
  selectionDisabled: boolean;
  environmentNames?: Record<string, string>;
  onToggleSelection: (record: UnifiedAgentRecord) => void;
  onViewDetails: (record: UnifiedAgentRecord) => void;
  onManage: (record: UnifiedAgentRecord) => void;
  onManageAccess: (record: UnifiedAgentRecord) => void;
  onSetBlocked: (record: UnifiedAgentRecord, blocked: boolean) => void;
};

export function UnifiedAgentTable({
  records,
  busyPackageId,
  selectedPackageIds,
  selectedPowerPlatformKeys,
  packageSelectionAllowed,
  packageOperationsAllowed,
  quarantineSelectionAllowed,
  quarantineSelectionRestoring = false,
  selectionDisabled,
  environmentNames = {},
  onToggleSelection,
  onViewDetails,
  onManage,
  onManageAccess,
  onSetBlocked,
}: Props) {
  if (records.length === 0) {
    return <div className="empty-state"><h2>No matching agents</h2><p>Try clearing the search or filters.</p></div>;
  }

  const rows = records.map(record => {
    const packageIds = packageSelectionAllowed ? [...new Set(record.packages.map(item => item.id))] : [];
    const quarantineReason = quarantineTargetReason(record.powerPlatformResource ?? undefined, record.observations.powerPlatform);
    const quarantineSelectable = quarantineSelectionAllowed && !quarantineReason;
    const selectableCount = packageIds.length + Number(quarantineSelectable);
    const selectedCount = packageIds.filter(id => selectedPackageIds.has(id)).length
      + Number(quarantineSelectable && record.powerPlatformResource !== null
        && selectedPowerPlatformKeys.has(quarantineTargetKey(record.powerPlatformResource)));
    return { record, selectableCount, selectedCount, quarantineReason };
  });
  const selectedAgents = rows.filter(row => row.selectedCount > 0).length;

  return (
    <div className="table-shell" role="region" aria-label="Unified agents">
      {selectedAgents > 0 || packageSelectionAllowed && selectedPackageIds.size > 0 || quarantineSelectionAllowed && selectedPowerPlatformKeys.size > 0 ? <div className="selection-summary">
        {selectedAgents > 0 ? <span>{selectedAgents} agent{selectedAgents === 1 ? "" : "s"} selected on this page</span> : null}
        {packageSelectionAllowed && selectedPackageIds.size > 0 ? <span>{selectedPackageIds.size} published version{selectedPackageIds.size === 1 ? "" : "s"} selected</span> : null}
        {quarantineSelectionAllowed && selectedPowerPlatformKeys.size > 0 ? <span>{selectedPowerPlatformKeys.size} exact quarantine target{selectedPowerPlatformKeys.size === 1 ? "" : "s"} selected</span> : null}
      </div> : null}
      <table className="agent-table unified-agent-table">
        <thead><tr>
          <th scope="col" className="select-cell"><span className="sr-only">Select agents</span></th>
          <th scope="col">Agent</th>
          <th scope="col">Environment</th>
          <th scope="col">Built with</th>
          <th scope="col">Availability</th>
          <th scope="col">Status</th>
          <th scope="col">Actions</th>
        </tr></thead>
        <tbody>{rows.map(({ record, selectableCount, selectedCount, quarantineReason }) => {
          const packageBusy = record.packages.some(item => item.id === busyPackageId);
          const resource = record.powerPlatformResource;
          const restoringSelection = quarantineSelectionRestoring && quarantineSelectionAllowed && !quarantineReason;
          const canManage = (packageOperationsAllowed && record.packages.length > 0)
            || (quarantineSelectionAllowed && resource?.type === "microsoft.copilotstudio/agents");
          return <tr key={record.id}>
            <td className="select-cell">
              <SelectionCheckbox
                label={`Select ${record.displayName}`}
                title={restoringSelection
                  ? "Restoring saved quarantine selections. Clear the saved selection to cancel."
                  : selectableCount === 0
                  ? (quarantineSelectionAllowed && resource ? quarantineReason : undefined) ?? "No selectable controls are available for this agent."
                  : "Select this agent's available targets"}
                checked={selectableCount > 0 && selectedCount === selectableCount}
                indeterminate={selectedCount > 0 && selectedCount < selectableCount}
                disabled={selectionDisabled || restoringSelection || selectableCount === 0}
                onChange={() => onToggleSelection(record)}
              />
            </td>
            <td><div className="agent-name">{record.displayName}</div></td>
            <td>{record.environmentId ? environmentNames[record.environmentId.toLowerCase()] || record.environmentId : "Unknown"}</td>
            <td><AgentAuthoringTools record={record} /></td>
            <td><AgentAvailability record={record} /></td>
            <td><AgentStatus record={record} /></td>
            <td><div className="row-actions">
              <button className="icon-button" type="button" aria-label={`View details for ${record.displayName}`} title="View agent details" onClick={() => onViewDetails(record)}><Info aria-hidden="true" /></button>
              {canManage ? <button className="secondary" type="button" aria-label={`Manage ${record.displayName}`} disabled={selectionDisabled} onClick={() => onManage(record)}>Manage</button> : null}
              {packageOperationsAllowed && record.packages.length === 1 ? <WorkbenchActionGate actionId="packages.access" compact><button className="icon-button" type="button" aria-label={`Manage access for ${record.displayName}`} title="Manage access" disabled={selectionDisabled} onClick={() => onManageAccess(record)}><ShieldCheck aria-hidden="true" /></button></WorkbenchActionGate> : null}
              {packageOperationsAllowed && record.packages.length === 1 && typeof record.packages[0].isBlocked === "boolean" ? <WorkbenchActionGate actionId={record.packages[0].isBlocked ? "packages.unblock" : "packages.block"} compact><button className={`icon-button${record.packages[0].isBlocked ? "" : " danger"}`} type="button" aria-label={`${record.packages[0].isBlocked ? "Unblock" : "Block"} ${record.displayName}`} title={`${record.packages[0].isBlocked ? "Unblock" : "Block"} agent`} disabled={selectionDisabled || packageBusy} onClick={() => onSetBlocked(record, !record.packages[0].isBlocked)}>{record.packages[0].isBlocked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}</button></WorkbenchActionGate> : null}
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}

function SelectionCheckbox({ label, title, checked, indeterminate, disabled, onChange }: {
  label: string; title: string; checked: boolean; indeterminate: boolean; disabled: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label={label} title={title} checked={checked} disabled={disabled} onChange={disabled ? undefined : onChange} />;
}

export function AgentAuthoringTools({ record }: { record: UnifiedAgentRecord }) {
  const tools = [record.powerPlatformResource?.authoringTool, ...record.packages.map(item => item.authoringTool)];
  return <>{[...new Set(tools.filter((tool): tool is string => Boolean(tool?.trim())).map(formatAgentAuthoringTool))].join(" / ") || "Unknown"}</>;
}

export function AgentAvailability({ record }: { record: UnifiedAgentRecord }) {
  const scopes = [...new Set(record.packages.map(item => formatAccessScope(item.availableTo, [])))];
  return <>{scopes.length === 0 ? "Unknown" : scopes.length === 1 ? scopes[0] : scopes.includes("Unknown") ? "Partially known" : "Varies by package"}</>;
}

export function AgentStatus({ record }: { record: UnifiedAgentRecord }) {
  const resource = record.powerPlatformResource;
  const states = record.packages.map(item => item.isBlocked === true ? "Blocked" : item.isBlocked === false ? "Not blocked" : "Block status unknown");
  const blockStates = [...new Set(states)];
  const blockStatus = blockStates.length === 1 ? blockStates[0] : blockStates.length > 1
    ? blockStates.map(state => `${states.filter(value => value === state).length} ${state.toLowerCase()}`).join(" · ")
    : undefined;
  const lifecycle = resource?.lifecycle === "published" ? "Published" : resource?.lifecycle === "draft" ? "Draft" : undefined;
  const quarantine = resource?.details.isQuarantined;
  return <span className="agent-summary-status">
    {blockStatus ? <span>{blockStatus}</span> : null}
    {resource ? <>
      <span>{lifecycle ?? "Publication status unknown"}</span>
      <span>{quarantine === true ? "Quarantined" : quarantine === false ? "Not quarantined" : "Quarantine status unknown"}</span>
    </> : null}
    {!blockStatus && !resource ? "Unknown" : null}
  </span>;
}
