import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import {
  ApiError,
  downloadOfficialUsageCsv,
  getOfficialUsageUsers,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
  type OfficialUsageUserQuery,
  type OfficialUsageUserSummary,
  type OfficialUsageUserView,
} from "../api/client";
import { downloadBlob } from "../agentExport";
import { hasRole } from "../authorization";
import { CapabilityContext } from "../capabilityContext";
import { restoreTableSortFocus, useListTable, type ListColumn } from "../listTable";
import { useSavedRead } from "../savedQueries";
import type { UsersRouteState } from "../workbenchRouting";
import { isValidLowResponseThreshold, usageCount, usageCoverageLabel, usageDate, usagePageLabel } from "../usageInsights";
import { ListTableHead } from "./ListTableHead";
import { ReportedUserDetail } from "./ReportedUserDetail";
import { UserActivityFilters, type UserActivityFilterValues } from "./UserActivityFilters";
import "./reportedUsers.css";

const pageSize = 50;
type ReadKey = { query: OfficialUsageUserQuery; dataRevision: number; retry: number };
type ReadState = { key: ReadKey; value: OfficialUsageUserView } | { key: ReadKey; error: string };
type ExportState = { key: object; status: "pending" | "done" } | { key: object; status: "failed"; message: string };
const defaultFilters: UserActivityFilterValues = {
  company: "", department: "", cohort: "all", lowResponseThreshold: "5",
};
const cohorts = [
  { value: "all", label: "All response counts" },
  { value: "low", label: "Low responses" },
  { value: "zero", label: "Zero responses" },
  { value: "review", label: "Zero or low responses" },
] as const;
const defaultReportedSorting: SortingState = [{ id: "responses", desc: true }];
const sorts: { value: string; label: string; sortBy: OfficialUsageUserView["filters"]["sortBy"]; sortDirection: "asc" | "desc" }[] = [
  { value: "responses-desc", label: "Most agent responses", sortBy: "responses", sortDirection: "desc" },
  { value: "responses-asc", label: "Fewest agent responses", sortBy: "responses", sortDirection: "asc" },
  { value: "agents-desc", label: "Most reported agents used", sortBy: "agentsUsed", sortDirection: "desc" },
  { value: "agents-asc", label: "Fewest reported agents used", sortBy: "agentsUsed", sortDirection: "asc" },
  { value: "activity-desc", label: "Latest user activity", sortBy: "lastActivity", sortDirection: "desc" },
  { value: "activity-asc", label: "Oldest user activity", sortBy: "lastActivity", sortDirection: "asc" },
  { value: "name", label: "Name A–Z", sortBy: "displayName", sortDirection: "asc" },
  { value: "name-desc", label: "Name Z–A", sortBy: "displayName", sortDirection: "desc" },
];

type Props = {
  route: UsersRouteState;
  onRouteChange: (route: UsersRouteState, replace?: boolean) => void;
  dataRevision?: number;
  agentInventoryRevision?: number;
  directoryData?: CopilotUsageUsersResponse;
  directoryDataRevision?: number;
  directoryPending?: boolean;
  onAccessDenied?: (message: string) => void;
  onOpenAgent?: (id: string) => void;
};

export function ReportedUserActivity(props: Props) {
  const capability = useContext(CapabilityContext);
  const principal = capability?.user;
  const scope = JSON.stringify([principal?.tenantId, principal?.homeAccountId, [...(principal?.roles ?? [])].sort()]);
  if (capability && !hasRole(principal, "AgentControl.Viewer")) {
    return <section aria-label="Non-paid user activity"><p role="alert">Current Viewer access is required to read reported users.</p></section>;
  }
  return <ReportedUserActivitySession key={scope} {...props} scope={scope} />;
}

function ReportedUserActivitySession({ route, onRouteChange, dataRevision = 0, agentInventoryRevision = 0, directoryData,
  directoryDataRevision = dataRevision, directoryPending = false, onAccessDenied, onOpenAgent, scope }: Props & { scope: string }) {
  const [result, setResult] = useState<ReadState>();
  const [retry, setRetry] = useState(0);
  const [applied, setApplied] = useState(defaultFilters);
  const [draft, setDraft] = useState(defaultFilters);
  const [sorting, setSorting] = useState<SortingState>(defaultReportedSorting);
  const [selectedUser, setSelectedUser] = useState<{ key: object; identity: string; removed?: boolean }>();
  const [exportState, setExportState] = useState<ExportState>();
  const exportController = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const reportedTable = useRef<HTMLDivElement>(null);
  const pendingSortFocus = useRef<string | undefined>(undefined);
  const reportAccessDenied = useEffectEvent((message: string) => onAccessDenied?.(message));
  const readSaved = useSavedRead();
  const { agentId, reportSetId, search, page } = route;
  const activeSort = sorts.find(item => item.sortBy === sorting[0]?.id && item.sortDirection === (sorting[0]?.desc ? "desc" : "asc")) ?? sorts[0];
  const query: OfficialUsageUserQuery = useMemo(() => ({
    licenseCohort: "active_without_paid",
    agentId, setId: reportSetId, search: search.trim() || undefined,
    company: applied.company || undefined, department: applied.department || undefined,
    lowResponseThreshold: Number(applied.lowResponseThreshold), cohort: applied.cohort,
    sortBy: activeSort.sortBy, sortDirection: activeSort.sortDirection, limit: pageSize, offset: page * pageSize,
  }), [activeSort, agentId, applied, page, reportSetId, search]);
  // Revisiting the same filters must not revive an aborted read or export.
  const key = useMemo(() => ({ query, dataRevision, retry }), [query, dataRevision, retry]);
  const exportKey = useMemo(() => ({ key, draft }), [key, draft]);
  const scoped = result?.key === key ? result : undefined;
  const data = result?.key.query === query && "value" in result ? result.value : undefined;
  const error = scoped && "error" in scoped ? scoped.error : undefined;
  const loading = !scoped && !data;
  const scopedExport = exportState?.key === exportKey ? exportState : undefined;
  const validThreshold = isValidLowResponseThreshold(draft.lowResponseThreshold);
  const hasRelationships = Boolean(data?.lineages.some(lineage => lineage.kind === "userAgents"));
  // Exact report lineage still fences joins while the two saved reads finish independently.
  const reportDirectory = directoryDataRevision === result?.key.dataRevision || directoryPending || !scoped && data
    ? directoryData : undefined;
  const directoryMatches = useMemo(() => {
    const matches = new Map<string, CopilotUsageUser | null>();
    if (reportDirectory?.sources.directory.state !== "available") return matches;
    for (const user of reportDirectory.users) {
      if (!user.importedUsage?.datasetScope.reportSetId) continue;
      const identity = reportUserKey(user.importedUsage);
      matches.set(identity, matches.has(identity) ? null : user);
    }
    return matches;
  }, [reportDirectory]);
  const selected = selectedUser?.key === query && !selectedUser.removed
    ? data?.users.value.find(user => reportUserKey(user) === selectedUser.identity) : undefined;
  const coverageUnavailable = data?.licenseCoverage?.state === "unavailable";
  const exportDisabled = !data?.activeSet || coverageUnavailable || !validThreshold || scopedExport?.status === "pending";
  const focusedName = agentId ? data?.users.value.flatMap(user => user.rows).find(row => row.agentId === agentId)?.displayAgentName : undefined;
  const options = result && "value" in result && result.key.dataRevision === dataRevision ? result.value.filters : undefined;
  const columns = useMemo<ListColumn<OfficialUsageUserSummary>[]>(() => [
    { id: "displayName", header: "Reported user", accessorFn: user => user.displayName || user.username },
    {
      id: "responses", header: "Agent responses",
      accessorFn: user => user.missingUserReport ? undefined : user.reportedResponsesReceived,
      sortDescFirst: true,
    },
    {
      id: "agentsUsed", header: "Agents used",
      accessorFn: user => user.missingUserReport ? undefined : user.reportedAgentsUsed,
      sortDescFirst: true,
    },
    { id: "company", header: "Company", enableSorting: false },
    { id: "department", header: "Department", enableSorting: false },
    { id: "lastActivity", header: "Last activity", accessorFn: user => user.userLastActivityDateUtc, sortDescFirst: true },
  ], []);
  const table = useListTable({
    data: data?.users.value ?? [],
    columns,
    sorting,
    manualSorting: true,
    getRowId: reportUserKey,
    onSortingChange: update => {
      const next = typeof update === "function" ? update(sorting) : update;
      if (!sorts.some(item => item.sortBy === next[0]?.id)) return;
      pendingSortFocus.current = next[0]?.id;
      setSorting(next);
      onRouteChange({ ...route, page: 0 });
    },
  });

  useEffect(() => {
    const controller = new AbortController();
    void readSaved(["official-usage-users", scope, query, dataRevision, retry], async signal => {
      const value = await getOfficialUsageUsers(query, { signal });
      if (query.setId && value.activeSet && value.activeSet.id !== query.setId) {
        throw new Error("The saved user report did not match the selected report.");
      }
      return value;
    }, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        setResult({ key, value });
        setSelectedUser(selection => {
          if (!selection) return selection;
          return value.users.value.some(user => reportUserKey(user) === selection.identity)
            ? selection.removed ? undefined : selection
            : { ...selection, removed: true };
        });
      }
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : "Reported user activity could not be loaded.";
      setResult({ key, error: message });
      setSelectedUser(undefined);
      if (isAccessDenied(failure)) reportAccessDenied(message);
    });
    return () => controller.abort();
  }, [scope, dataRevision, key, query, readSaved, retry]);

  useEffect(() => () => exportController.current?.abort(), [exportKey]);

  useEffect(() => {
    if (!data || !pendingSortFocus.current) return;
    const column = columns.find(item => item.id === pendingSortFocus.current);
    const label = typeof column?.header === "string" ? column.header : undefined;
    restoreTableSortFocus(reportedTable.current, label);
    pendingSortFocus.current = undefined;
  }, [columns, data]);

  function resetFilters() {
    setDraft(defaultFilters);
    setApplied(defaultFilters);
    onRouteChange({ ...route, search: "", agentId: undefined, page: 0 });
  }

  function updateFilters(next: UserActivityFilterValues) {
    setDraft(next);
    if (!isValidLowResponseThreshold(next.lowResponseThreshold)) return;
    setApplied(next);
    onRouteChange({ ...route, page: 0 });
  }

  async function exportUsers() {
    if (!data?.activeSet || exportDisabled) return;
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExportState({ key: exportKey, status: "pending" });
    const filters = data.filters;
    try {
      const blob = await downloadOfficialUsageCsv("users", {
        licenseCohort: "active_without_paid",
        setId: data.activeSet.id, agentId: filters.agentId, search: filters.search,
        company: filters.company, department: filters.department,
        lowResponseThreshold: filters.lowResponseThreshold, cohort: filters.cohort,
        sortBy: filters.sortBy, sortDirection: filters.sortDirection,
      }, controller.signal);
      if (controller.signal.aborted) return;
      downloadBlob("reported-user-activity.csv", blob);
      setExportState({ key: exportKey, status: "done" });
    } catch (failure: unknown) {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : "Reported user activity could not be exported.";
      setExportState({ key: exportKey, status: "failed", message });
      if (isAccessDenied(failure)) {
        setResult({ key, error: message });
        setSelectedUser(undefined);
        onAccessDenied?.(message);
      }
    }
  }

  return <section className="reported-users" aria-label="Non-paid user activity" aria-busy={loading}>
    <UserActivityFilters values={draft} companies={options?.companies ?? []} departments={options?.departments ?? []}
      cohorts={cohorts} defaultCohort="all"
      search={search} searchRef={searchInput} sort={activeSort.value} sorts={sorts} matchingCount={data?.users.count}
      loading={!scoped} validThreshold={validThreshold} agent={agentId ? focusedName || agentId : undefined}
      onChange={updateFilters} onSearch={search => onRouteChange({ ...route, search, page: 0 }, true)}
      onSort={value => {
        const next = sorts.find(item => item.value === value);
        if (next) { setSorting([{ id: next.sortBy, desc: next.sortDirection === "desc" }]); onRouteChange({ ...route, page: 0 }); }
      }}
      onClear={resetFilters} onClearAgent={() => onRouteChange({ ...route, agentId: undefined, page: 0 })}
      exportButton={<button type="button" className="secondary" disabled={exportDisabled} onClick={() => void exportUsers()}>
        {scopedExport?.status === "pending" ? "Exporting users…" : "Export users CSV"}
      </button>} />
    {reportSetId ? <p className="reported-users-snapshot">Saved report <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, reportSetId: undefined, page: 0 })}>Use current reports</button></p> : null}
    {error ? <div className="error-banner" role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry reported activity</button></div> : null}
    {scopedExport?.status === "failed" && !error ? <div className="error-banner" role="alert">{scopedExport.message} <button type="button" className="secondary" disabled={exportDisabled} onClick={() => void exportUsers()}>Retry user export</button></div> : null}
    {scopedExport?.status === "done" ? <p role="status">User CSV downloaded.</p> : null}
    {loading ? <p role="status">Loading reported user activity…</p> : null}
    {!scoped && data ? <p className="sr-only" role="status">Refreshing reported user activity. Showing the last loaded snapshot.</p> : null}
    {selectedUser?.key === query && selectedUser.removed ? <p className="reported-users-note" role="status">The selected user is no longer present in this report selection.</p> : null}
    {data ? <>
      {coverageUnavailable ? <p className="copilot-users-notice" role="status">
        License data unavailable. {data.licenseCoverage?.message ?? "Run Users sync in Sync."}
      </p> : data.licenseCoverage && data.licenseCoverage.unknownUsers > 0 ? <p className="copilot-users-notice" role="status">
        {data.licenseCoverage.unknownUsers.toLocaleString()} {data.licenseCoverage.unknownUsers === 1 ? "user needs" : "users need"} a license check. Run Users sync in Sync.
      </p> : null}
      {data.availability === "stale" ? <p className="copilot-users-notice">Reports are out of date. Refresh reports in Sync.</p> : null}
      {!data.activeSet ? <div className="reported-users-empty">
        <h3>No selected user reports</h3>
        <p>{data.availability === "incomplete" ? "Report set is incomplete. " : ""}Select or import reports in <a href="/sync?reports=manage">Sync</a>.</p>
      </div> : coverageUnavailable ? null : <>
        {!hasRelationships ? <p className="reported-users-note">Users &amp; agents report missing. Import it in Sync to see agent details.</p> : null}
        {data.users.value.length ? <div ref={reportedTable} className="copilot-users-table-shell" role="region" aria-label="Active users without paid Copilot" tabIndex={0}>
          <table className="copilot-users-table reported-users-table">
            <ListTableHead table={table} />
            <tbody>{table.getRowModel().rows.map(row => {
              const user = row.original;
              const directoryUser = directoryMatches.get(reportUserKey(user));
              return <tr key={row.id}>
              <th scope="row"><button type="button" className="user-name-button" aria-haspopup="dialog"
                aria-label={`View reported details for ${user.displayName || user.username}`}
                onClick={() => setSelectedUser({ key: query, identity: reportUserKey(user) })}>{user.displayName || user.username}</button>
                <small>{user.username}</small>{directoryUser?.directory.accountEnabled === false ? <small>Account disabled</small> : null}</th>
              <td data-numeric>{usageCount(user.missingUserReport ? null : user.reportedResponsesReceived)}{user.hasReportMismatch ? <small>Report totals differ</small> : null}</td>
              <td data-numeric>{usageCount(user.missingUserReport ? null : user.reportedAgentsUsed)}</td>
              <td>{user.companyName || "Not set"}</td>
              <td>{user.department || "Not set"}</td>
              <td>{usageDate(user.userLastActivityDateUtc)}</td>
            </tr>;
            })}</tbody>
          </table>
        </div> : <div className="reported-users-empty">
          <h3>{data.users.count ? "No reported users on this page" : data.counts.users ? "No reported users match" : "No active users without paid Copilot"}</h3>
          <p>{data.counts.users ? "Try another search or clear filters." : "No matching activity in the selected reports."}</p>
          {page > 0 ? <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, page: 0 })}>First user page</button> : null}
        </div>}
        <div className="copilot-users-pagination" aria-label="Reported user pages">
          <span>{usagePageLabel(data.users, "reported users")}</span>
          <button type="button" className="secondary" disabled={page === 0} onClick={() => onRouteChange({ ...route, reportSetId: data.activeSet?.id, page: page - 1 })}>Previous users</button>
          <button type="button" className="secondary" disabled={data.users.offset + pageSize >= data.users.count} onClick={() => onRouteChange({ ...route, reportSetId: data.activeSet?.id, page: page + 1 })}>Next users</button>
        </div>
      </>}
      <details className="copilot-users-provenance">
        <summary>Report sources</summary>
        <p>{data.authority}. Imported {usageDate(data.activeSet?.acceptedAt)}.</p>
        <p>{usageCoverageLabel(data.activeSet)}</p>
        {data.lineages.map(lineage => <p key={lineage.kind}>{lineage.kind === "userAgents" ? "Users & agents" : lineage.kind === "users" ? "Users" : "Agents"}: {lineage.rowCount.toLocaleString()} rows</p>)}
        {data.licenseCoverage?.observedAt ? <p>Licenses checked: {usageDate(data.licenseCoverage.observedAt)}</p> : null}
      </details>
      {selected ? <ReportedUserDetail key={reportUserKey(selected)} user={selected} directoryUser={directoryMatches.get(reportUserKey(selected))}
        reportPeriod={data.activeSet?.reportingPeriod} appActivityState={reportDirectory?.sources.appActivity.state}
        onOpenAgent={onOpenAgent} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision}
        refreshing={!scoped || directoryPending}
        hasRelationships={hasRelationships} filters={data.filters} returnFocusTo={searchInput} onClose={() => setSelectedUser(undefined)}
        onFocusAgent={(id, setId) => {
          setSelectedUser(undefined);
          setApplied(defaultFilters);
          setDraft(defaultFilters);
          onRouteChange({ ...route, agentId: id, reportSetId: setId, search: "", page: 0 });
        }} /> : null}
    </> : null}
  </section>;
}

function reportUserKey(user: OfficialUsageUserSummary) {
  return JSON.stringify([user.username, user.datasetScope.reportSetId, user.datasetScope.usersVersionId, user.datasetScope.userAgentsVersionId]);
}

function isAccessDenied(failure: unknown) {
  return failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
}
