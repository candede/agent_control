import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Info, Lock, LockOpen, ShieldCheck } from "lucide-react";
import { columnVisibilityFeature, rowSortingFeature, tableFeatures, useTable, type CellContext, type ColumnDef, type ColumnVisibilityState } from "@tanstack/react-table";
import { agentColumnValue, agentStatusLabels } from "../../../backend/src/types/agentPresentation";
import type { UnifiedAgentSort, UnifiedAgentSortDirection } from "../../../backend/src/types/unifiedAgents";
import type { InventoryReportContext } from "../../../backend/src/types/unifiedAgents";
import type { UnifiedAgentRecord } from "../api/client";
import { agentColumns, defaultAgentColumnVisibility, isAgentSort, loadAgentColumns, saveAgentColumns, type AgentColumnFormat } from "../agentColumns";
import { quarantineTargetKey, quarantineTargetReason } from "../quarantineTarget";
import { usageAvailabilityLabel, usageCoverageLabel } from "../usageInsights";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { AgentColumnPicker } from "./AgentColumnPicker";
import "./unifiedAgent.css";

const features = tableFeatures({ columnVisibilityFeature, rowSortingFeature });
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const emptyEnvironmentNames: Record<string, string> = {};

type Props = {
  records: UnifiedAgentRecord[];
  controls?: ReactNode;
  selectionAction?: ReactNode;
  loading?: boolean;
  loadingMessage?: string;
  emptyState?: ReactNode;
  busyPackageId?: string;
  selectedPackageIds: Set<string>;
  selectedPackageCount: number;
  allPackagesSelected: boolean;
  selectedRecordIds?: ReadonlySet<string>;
  selectedPowerPlatformKeys: Set<string>;
  packageSelectionAllowed: boolean;
  packageOperationsAllowed: boolean;
  quarantineSelectionAllowed: boolean;
  quarantineSelectionRestoring?: boolean;
  selectionDisabled: boolean;
  packageActionsDisabled?: boolean;
  environmentNames?: Record<string, string>;
  columnPreferenceOwner?: string;
  sortBy?: UnifiedAgentSort;
  sortDirection?: UnifiedAgentSortDirection;
  onSortChange?: (sortBy: UnifiedAgentSort, direction: UnifiedAgentSortDirection) => void;
  usageContext?: InventoryReportContext;
  onToggleSelection: (record: UnifiedAgentRecord) => void;
  onViewDetails: (record: UnifiedAgentRecord) => void;
  onManageAccess: (record: UnifiedAgentRecord) => void;
  onSetBlocked: (record: UnifiedAgentRecord, blocked: boolean) => void;
};

type AgentRow = {
  record: UnifiedAgentRecord;
  usageMatchesReport: boolean;
  environmentName: string | null;
  selectableCount: number;
  selectedCount: number;
  quarantineReason: string | undefined;
};

type AgentTableActions = Pick<Props, "busyPackageId" | "packageOperationsAllowed" | "quarantineSelectionAllowed" | "quarantineSelectionRestoring" | "selectionDisabled" | "allPackagesSelected" | "packageActionsDisabled" | "onToggleSelection" | "onViewDetails" | "onManageAccess" | "onSetBlocked">;
const AgentTableActionsContext = createContext<AgentTableActions | undefined>(undefined);

// Stable cell components preserve focus and in-flight clicks when action state changes.
const columns: ColumnDef<typeof features, AgentRow>[] = [
  { id: "selection", header: "Select agents", enableHiding: false, enableSorting: false, cell: AgentSelectionCell },
  ...agentColumns.map((definition): ColumnDef<typeof features, AgentRow> => {
    const id = definition.id;
    if (id === "actions") return { id, header: definition.label, enableSorting: false, cell: AgentActionsCell };
    return {
      id, header: definition.label,
      accessorFn: row => {
        try {
          if (definition.group === "Usage" && !row.usageMatchesReport) return null;
          if (row.record.columns && id in row.record.columns) return row.record.columns[id];
          return id === "environment" ? row.environmentName : agentColumnValue(row.record, id);
        } catch (error) {
          if (error instanceof RangeError) return error;
          throw error;
        }
      },
      enableHiding: id !== "displayName",
      sortDescFirst: definition.format === "number" || definition.format === "date",
      cell: id === "displayName" ? AgentNameCell
        : ({ row, getValue }) => id === "status" ? <AgentStatus record={row.original.record} />
          : <AgentCell value={getValue()} format={definition.format} usage={definition.group === "Usage"} />,
    };
  }),
];

export function UnifiedAgentTable({
  records,
  controls,
  selectionAction,
  loading = false,
  loadingMessage = "Loading Copilot agents...",
  emptyState,
  busyPackageId,
  selectedPackageIds,
  selectedPackageCount,
  allPackagesSelected,
  selectedRecordIds,
  selectedPowerPlatformKeys,
  packageSelectionAllowed,
  packageOperationsAllowed,
  quarantineSelectionAllowed,
  quarantineSelectionRestoring = false,
  selectionDisabled,
  packageActionsDisabled = selectionDisabled,
  environmentNames = emptyEnvironmentNames,
  columnPreferenceOwner,
  sortBy = "displayName",
  sortDirection = "asc",
  onSortChange,
  usageContext,
  onToggleSelection,
  onViewDetails,
  onManageAccess,
  onSetBlocked,
}: Props) {
  const [preferences, setPreferences] = useState(() => ({ owner: columnPreferenceOwner, ...loadAgentColumns(columnPreferenceOwner) }));
  if (preferences.owner !== columnPreferenceOwner) {
    setPreferences({ owner: columnPreferenceOwner, ...loadAgentColumns(columnPreferenceOwner) });
  }
  const rows = useMemo(() => records.map(record => {
    const grouped = packageSelectionAllowed && record.packagesComplete === false;
    const packageIds = packageSelectionAllowed && !grouped ? [...new Set(record.packages.map(item => item.id))] : [];
    const packageCount = grouped ? record.packageCount! : packageIds.length;
    const quarantineReason = quarantineTargetReason(record.powerPlatformResource ?? undefined, record.observations.powerPlatform);
    const quarantineSelectable = quarantineSelectionAllowed && !quarantineReason;
    const selectableCount = packageCount + Number(quarantineSelectable);
    const selectedCount = (allPackagesSelected ? packageCount
      : grouped ? selectedRecordIds?.has(record.id) ? packageCount : 0 : packageIds.filter(id => selectedPackageIds.has(id)).length)
      + Number(quarantineSelectable && record.powerPlatformResource !== null
        && selectedPowerPlatformKeys.has(quarantineTargetKey(record.powerPlatformResource)));
    const environmentName = record.environmentId ? environmentNames[record.environmentId.toLowerCase()] || record.environmentId : null;
    const usageMatchesReport = Boolean(usageContext?.reports.setId
      && (usageContext.reports.availability === "active" || usageContext.reports.availability === "stale")
      && record.usage?.reportSetId === usageContext.reports.setId);
    return { record, usageMatchesReport, environmentName, selectableCount, selectedCount, quarantineReason };
  }), [records, usageContext, environmentNames, packageSelectionAllowed, quarantineSelectionAllowed, selectedPackageIds, selectedRecordIds, selectedPowerPlatformKeys, allPackagesSelected]);
  const selectedAgents = rows.filter(row => row.selectedCount > 0).length;
  function changeVisibility(updater: ColumnVisibilityState | ((current: ColumnVisibilityState) => ColumnVisibilityState)) {
    const next = typeof updater === "function" ? updater(preferences.visibility) : updater;
    const visibility = { ...next, displayName: true };
    setPreferences({ owner: columnPreferenceOwner, visibility, error: saveAgentColumns(columnPreferenceOwner, visibility) });
  }

  const sorting = useMemo(() => [{ id: sortBy, desc: sortDirection === "desc" }], [sortBy, sortDirection]);
  const table = useTable({
    features, columns, data: rows,
    getRowId: row => row.record.id,
    manualSorting: true,
    enableSorting: Boolean(onSortChange),
    enableMultiSort: false,
    enableSortingRemoval: false,
    state: { columnVisibility: preferences.visibility, sorting },
    onColumnVisibilityChange: changeVisibility,
    onSortingChange: updater => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const first = next[0];
      if (first && isAgentSort(first.id)) onSortChange?.(first.id, first.desc ? "desc" : "asc");
    },
  });
  function requiredColumn(id: string) {
    const column = table.getColumn(id);
    if (!column) throw new Error(`Agent table column "${id}" is not registered.`);
    return column;
  }
  const showUsageContext = agentColumns.some(column => column.group === "Usage" && requiredColumn(column.id).getIsVisible());

  return (
    <AgentTableActionsContext.Provider value={{ busyPackageId, packageOperationsAllowed, quarantineSelectionAllowed, quarantineSelectionRestoring, selectionDisabled, allPackagesSelected, packageActionsDisabled, onToggleSelection, onViewDetails, onManageAccess, onSetBlocked }}>
    <div className="agent-grid" role="region" aria-label="Unified agents">
      <div className="agent-grid-toolbar">
        <div className="agent-grid-tools">
        {controls}
        {selectionAction}
        <AgentColumnPicker key={columnPreferenceOwner} columns={agentColumns.map(definition => {
          const column = requiredColumn(definition.id);
          return { ...definition, visible: column.getIsVisible(), canHide: column.getCanHide() };
        })} onToggle={id => requiredColumn(id).toggleVisibility()} onReset={() => changeVisibility({ ...defaultAgentColumnVisibility })} />
        </div>
        {!controls ? <span className="muted-cell agent-report-note" title={showUsageContext
          ? "Usage columns show one imported report, not lifetime totals. Missing values are unavailable, not zero."
          : undefined}>
          {showUsageContext && usageContext
            ? <>{usageCoverageLabel(usageContext.reports)}{usageContext.reports.availability !== "active" ? ` · ${usageAvailabilityLabel(usageContext.reports.availability)}` : ""}</>
            : "Choose columns; sort using column headings."}
        </span> : null}
      </div>
      {preferences.error ? <p className="notice" role="status">{preferences.error}</p> : null}
      {selectedAgents > 0 || packageSelectionAllowed && selectedPackageCount > 0 || quarantineSelectionAllowed && selectedPowerPlatformKeys.size > 0 ? <div className="selection-summary">
        {selectedAgents > 0 ? <span>{selectedAgents} agent{selectedAgents === 1 ? "" : "s"} selected on this page</span> : null}
        {packageSelectionAllowed && selectedPackageCount > 0 ? <span>{selectedPackageCount} published version{selectedPackageCount === 1 ? "" : "s"} selected</span> : null}
        {packageSelectionAllowed && (selectedRecordIds?.size ?? 0) > 0 ? <span>{selectedRecordIds!.size} complete published-version groups selected</span> : null}
        {quarantineSelectionAllowed && selectedPowerPlatformKeys.size > 0 ? <span>{selectedPowerPlatformKeys.size} exact quarantine target{selectedPowerPlatformKeys.size === 1 ? "" : "s"} selected</span> : null}
      </div> : null}
      {loading ? <div className="screen-state" role="status">{loadingMessage}</div>
        : records.length === 0 ? <div className="empty-state">{emptyState ?? <><h2>No matching agents</h2><p>Try clearing the search or filters.</p></>}</div> : <div className="table-shell">
        <table className="agent-table unified-agent-table" style={{ minWidth: Math.max(520, table.getVisibleLeafColumns().length * 145) }}>
          <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => {
            const sorted = header.column.getIsSorted();
            return <th key={header.id} scope="col" className={header.column.id === "selection" ? "select-cell" : undefined}
              aria-label={typeof header.column.columnDef.header === "string" ? header.column.columnDef.header : undefined}
              aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}>
              {header.column.id === "selection" ? <span className="sr-only">Select agents</span>
                : header.column.getCanSort() ? <button type="button" className="agent-sort-heading"
                  aria-label={`Sort by ${header.column.columnDef.header}`}
                  title={`Sort ${header.column.getNextSortingOrder() === "desc" ? "descending" : "ascending"}`}
                  onClick={header.column.getToggleSortingHandler()}>
                  <table.FlexRender header={header} />
                  {sorted === "asc" ? <ArrowUp size={14} aria-hidden="true" /> : sorted === "desc" ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" />}
                </button> : <table.FlexRender header={header} />}
            </th>;
          })}</tr>)}</thead>
          <tbody>{table.getRowModel().rows.map(row => <tr key={row.id}>
            {row.getVisibleCells().map(cell => <td key={cell.id} className={cell.column.id === "selection" ? "select-cell" : undefined}>
              <table.FlexRender cell={cell} />
            </td>)}
          </tr>)}</tbody>
        </table>
      </div>}
    </div>
    </AgentTableActionsContext.Provider>
  );
}

function useAgentTableActions() {
  const actions = useContext(AgentTableActionsContext);
  if (!actions) throw new Error("Agent table cells require current action context.");
  return actions;
}

function AgentSelectionCell({ row }: CellContext<typeof features, AgentRow>) {
  const { quarantineSelectionRestoring, quarantineSelectionAllowed, selectionDisabled, allPackagesSelected, onToggleSelection } = useAgentTableActions();
  const { record, selectableCount, selectedCount, quarantineReason } = row.original;
  const restoringSelection = quarantineSelectionRestoring && quarantineSelectionAllowed && !quarantineReason;
  return <SelectionCheckbox
    label={`Select ${record.displayName}`}
    title={allPackagesSelected ? "Clear the all-matching package selection before selecting individual agent targets." : restoringSelection
      ? "Restoring saved quarantine selections. Clear the saved selection to cancel."
      : selectableCount === 0
        ? (quarantineSelectionAllowed && record.powerPlatformResource ? quarantineReason : undefined) ?? "No selectable controls are available for this agent."
        : "Select this agent's available targets"}
    checked={selectableCount > 0 && selectedCount === selectableCount}
    indeterminate={selectedCount > 0 && selectedCount < selectableCount}
    disabled={selectionDisabled || allPackagesSelected || restoringSelection || selectableCount === 0}
    onChange={() => onToggleSelection(record)}
  />;
}

function AgentNameCell({ row }: CellContext<typeof features, AgentRow>) {
  const { onViewDetails } = useAgentTableActions();
  return <button type="button" className="agent-name-button" aria-haspopup="dialog" onClick={() => onViewDetails(row.original.record)}>{row.original.record.displayName}</button>;
}

function AgentActionsCell({ row }: CellContext<typeof features, AgentRow>) {
  const { busyPackageId, packageOperationsAllowed, packageActionsDisabled, onViewDetails, onManageAccess, onSetBlocked } = useAgentTableActions();
  const record = row.original.record;
  const singlePackage = record.packagesComplete !== false && record.packages.length === 1;
  const packageBusy = record.packages.some(item => item.id === busyPackageId);
  return <div className="row-actions">
    <button className="icon-button" type="button" aria-label={`View details for ${record.displayName}`} title="View agent details" onClick={() => onViewDetails(record)}><Info aria-hidden="true" /></button>
    {packageOperationsAllowed && singlePackage ? <WorkbenchActionGate actionId="packages.access" compact><button className="icon-button" type="button" aria-label={`Manage access for ${record.displayName}`} title="Manage access" disabled={packageActionsDisabled} onClick={() => onManageAccess(record)}><ShieldCheck aria-hidden="true" /></button></WorkbenchActionGate> : null}
    {packageOperationsAllowed && singlePackage && typeof record.packages[0].isBlocked === "boolean" ? <WorkbenchActionGate actionId={record.packages[0].isBlocked ? "packages.unblock" : "packages.block"} compact><button className={`icon-button${record.packages[0].isBlocked ? "" : " danger"}`} type="button" aria-label={`${record.packages[0].isBlocked ? "Unblock" : "Block"} ${record.displayName}`} title={`${record.packages[0].isBlocked ? "Unblock" : "Block"} agent`} disabled={packageActionsDisabled || packageBusy} onClick={() => onSetBlocked(record, !record.packages[0].isBlocked)}>{record.packages[0].isBlocked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}</button></WorkbenchActionGate> : null}
  </div>;
}

function AgentCell({ value, format, usage }: { value: unknown; format?: AgentColumnFormat; usage: boolean }) {
  if (value instanceof RangeError) return <span className="muted-cell" role="status" title={value.message}>Invalid saved value</span>;
  if (value === null || value === undefined) return <span className="muted-cell">{usage ? "Unavailable" : "Unknown"}</span>;
  if (format === "date" && typeof value === "number") return <time dateTime={new Date(value).toISOString()}>{dateFormatter.format(value)}</time>;
  return <>{typeof value === "number" ? value.toLocaleString() : String(value)}</>;
}

function SelectionCheckbox({ label, title, checked, indeterminate, disabled, onChange }: {
  label: string; title: string; checked: boolean; indeterminate: boolean; disabled: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label={label} title={title} checked={checked} disabled={disabled} onChange={disabled ? undefined : event => {
    // A click clears the DOM's mixed state even when the parent rejects the selection.
    event.currentTarget.indeterminate = indeterminate;
    onChange();
  }} />;
}

export function AgentAvailability({ record }: { record: UnifiedAgentRecord }) {
  return <>{agentColumnValue(record, "availability") ?? "Unknown"}</>;
}

export function AgentStatus({ record }: { record: UnifiedAgentRecord }) {
  const statuses = agentStatusLabels(record);
  return <span className="agent-summary-status">
    {statuses.length ? statuses.map(status => <span key={status}>{status}</span>) : "Unknown"}
  </span>;
}
