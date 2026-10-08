import { useContext, useRef, useState } from "react";
import type { ReportQuery, ReportUser } from "../../../backend/src/types/officialReportData";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { normalizeReportSearch } from "../api/reportData";
import type { UsersRouteState } from "../workbenchRouting";
import { isValidLowResponseThreshold, usageAvailabilityLabel, usageCount, usageDate } from "../usageInsights";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { isExpiredSelection, withdrawsSelectedRead } from "../selectedRead";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
import { UserActivityFilters } from "./UserActivityFilters";
import { ReportSortHeading } from "./ReportSortHeading";
import { ReportExportButton } from "./ReportExportButton";
import { UsageReportContext } from "./UsageReportContext";
import { UserDetailModal } from "./UserDetailModal";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
import "./reportedUsers.css";

type Props = { route: UsersRouteState; onRouteChange: (route: UsersRouteState, replace?: boolean) => void;
  dataRevision?: number; agentInventoryRevision?: number; onOpenAgent?: (id: string) => void };
export function ReportedUserActivity(props: Props) {
  const capability = useContext(CapabilityContext), user = capability?.user;
  const scope = useReportPrincipalScope();
  if (capability && !hasRole(user, "AgentControl.Viewer")) return <p role="alert">Current Viewer access is required to read reported users.</p>;
  return <ReportedUsers key={scope} {...props} />;
}
function ReportedUsers({ route, onRouteChange, dataRevision = 0, agentInventoryRevision, onOpenAgent }: Props) {
  const [filters, setFilters] = useState<ReportQuery>({ cohort: "all", sort: "responses", order: "desc" });
  const [threshold, setThreshold] = useState("5");
  const [lastThreshold, setLastThreshold] = useState(5);
  const [selected, setSelected] = useState<{ username: string; selectionId: string; queryKey: string; replacing?: boolean }>();
  const focus = useRef<HTMLInputElement>(null), valid = isValidLowResponseThreshold(threshold);
  const trigger = useRef<HTMLButtonElement>(null);
  if (valid && lastThreshold !== Number(threshold)) setLastThreshold(Number(threshold));
  const query: ReportQuery = { ...filters, licenseCohort: "active_without_paid",
    search: normalizeReportSearch(route.search) || undefined, agentId: route.agentId, setId: route.reportSetId?.toLowerCase(), lowResponseThreshold: valid ? Number(threshold) : lastThreshold };
  const read = useReportPage<ReportUser>("official-usage/users", query, dataRevision);
  const queryKey = JSON.stringify([query, dataRevision, read.selectionRevision]);
  const data = read.data;
  const hasCohortEvidence = Boolean(data && ["available", "stale"].includes(data.sources.directory.state) && data.reports.setId);
  const [initialReadComplete, setInitialReadComplete] = useState(false);
  if (!initialReadComplete && (data || read.error || read.invalidated)) setInitialReadComplete(true);
  const [hasShownPageControls, setHasShownPageControls] = useState(false);
  const showPageControls = Boolean(read.loading || read.error || read.invalidated || data && data.counts.filtered > 0);
  if (!hasShownPageControls && initialReadComplete && showPageControls) setHasShownPageControls(true);
  if (selected && withdrawsSelectedRead(read.error)) setSelected(undefined);
  else if (selected?.replacing && data && !read.loading && data.selection.id !== selected.selectionId) {
    setSelected({ username: selected.username, selectionId: data.selection.id, queryKey });
  } else if (selected && !selected.replacing && (selected.queryKey !== queryKey || read.error && !isExpiredSelection(read.error)
    || read.invalidated || !data && !read.loading || data && data.selection.id !== selected.selectionId)) setSelected(undefined);
  function restartSelection() {
    setSelected(current => current ? { ...current, replacing: true } : undefined);
    read.restart();
  }
  function resetFilters() { setFilters({ cohort: "all", sort: filters.sort, order: filters.order }); setThreshold("5"); }
  if (!initialReadComplete && read.loading && !data && !read.error && !read.invalidated) {
    return <WorkspaceSkeleton view="users" contentOnly showSummary={false} />;
  }
  return <section className="reported-users" aria-label="Non-paid user activity">
    <ReportReadStatus read={{ ...read, restart: restartSelection }} quietLoading />
    {data && !read.loading && data.sources.directory.state !== "available" ? <p className="copilot-users-notice" role="status">{data.sources.directory.state === "stale"
      ? "Saved directory data is out of date; current licensing is unverified." : "License data unavailable."}{" "}
      {data.sources.directory.message ?? "Current directory verification is required."} Run Users sync to verify licensing.</p> : null}
    {data && !read.loading && data.sources.directory.attemptStatus !== "running" && data.summary.unknownLicenseActiveReportUsers > 0 ? <p className="copilot-users-notice">{data.summary.unknownLicenseActiveReportUsers.toLocaleString()} active report{" "}
      {data.summary.unknownLicenseActiveReportUsers === 1 ? "user needs" : "users need"} a license check. Run Users sync.</p> : null}
    {data && !read.loading && data.reports.availability === "stale" ? <p className="copilot-users-notice">Reports are out of date. Refresh reports in Sync.</p> : null}
    <div className="agent-table-stack user-directory-table" aria-busy={read.loading}>
      <UserActivityFilters path="official-usage/users" selectionId={read.frozenData?.selection.id} onRestartSelection={restartSelection}
      onSelectionInvalidated={read.invalidateSelection}
      values={{ company: filters.company, department: filters.department, cohort: filters.cohort ?? "all", lowResponseThreshold: threshold }}
      cohorts={[{ value: "all", label: "All response counts" }, { value: "low", label: "Low responses" }, { value: "zero", label: "Zero responses" }, { value: "review", label: "Zero or low responses" }]}
      defaultCohort="all" search={route.search} searchRef={focus} sort={`${filters.sort}:${filters.order}`}
      sorts={(["responses", "agentsUsed", "lastActivity", "name"] as const).flatMap(sort => (["desc", "asc"] as const).map(order => ({
        value: `${sort}:${order}`, label: `${sort === "responses" ? "Agent responses" : sort === "agentsUsed" ? "Agents used" : sort === "lastActivity" ? "User activity" : "Name"} ${order === "asc" ? "ascending" : "descending"}`,
      })))} matchingCount={hasCohortEvidence ? data?.counts.filtered : undefined} loading={read.loading} validThreshold={valid} agent={route.agentId}
      onClearAgent={() => onRouteChange({ ...route, agentId: undefined, page: 0 })}
      onSearch={search => onRouteChange({ ...route, search, page: 0 })} onChange={value => {
        setFilters({ ...filters, company: value.company, department: value.department, cohort: value.cohort }); setThreshold(value.lowResponseThreshold);
      }} onSort={value => { const [sort, order] = value.split(":"); setFilters({ ...filters, sort: sort as ReportQuery["sort"], order: order as ReportQuery["order"] }); }}
      onClear={() => { resetFilters(); onRouteChange({ ...route, search: "", agentId: undefined, page: 0 }); }}
      exportButton={<ReportExportButton key={read.frozenData?.selection.id} kind="official_users" selectionId={read.frozenData?.selection.id} label="Export users CSV"
        onOwnSelection={read.ownPublication}
        admissionAllowed={() => read.isCurrentData(true)}
        onSelectionInvalidated={read.invalidateSelection}
        disabled={!valid || !read.frozenData?.reports.setId || !["available", "stale"].includes(read.frozenData.sources.directory.state)} />} />
      <div className="table-shell copilot-users-table-shell" role="region" aria-label="Reported user activity" tabIndex={0}><table className="agent-table copilot-users-table reported-users-table">
        <thead><tr><ReportSortHeading label="User" sort="name" query={filters} onChange={setFilters} />
          <ReportSortHeading label="Agent responses" sort="responses" query={filters} onChange={setFilters} />
          <ReportSortHeading label="Agents used" sort="agentsUsed" query={filters} onChange={setFilters} />
          <th scope="col">Company</th><th scope="col">Department</th><ReportSortHeading label="Last activity" sort="lastActivity" query={filters} onChange={setFilters} /></tr></thead>
        <tbody>{data?.value.map(user => <tr key={user.username}><th scope="row"><button type="button" className="agent-name-button user-name-button" aria-haspopup="dialog" onClick={event => {
          read.ownPublication(); trigger.current = event.currentTarget; setSelected({ username: user.username, selectionId: data.selection.id, queryKey });
        }}>
          {user.displayName || user.username}</button><small>{user.username}</small></th><td data-numeric>{usageCount(user.reportedResponses)}</td>
          <td data-numeric>{usageCount(user.reportedAgentsUsed)}</td><td>{user.company?.trim() || "Not set"}</td><td>{user.department?.trim() || "Not set"}</td><td>{usageDate(user.userLastActivityDateUtc)}
            {user.hasReportMismatch ? <small>Report totals differ</small> : null}{user.missingUserReport ? <small>Users report metric unknown</small> : null}</td></tr>)}</tbody>
      </table></div>
      {data && !data.value.length ? <div className="reported-users-empty">
        <h3>{!data.reports.setId ? usageAvailabilityLabel(data.reports.availability) : !hasCohortEvidence ? "Non-paid user activity unavailable"
          : data.counts.filtered ? "No reported users on this page" : "No matching reported users"}</h3>
        <p>{!data.reports.setId ? <>Select or import reports in <a href="/sync?reports=manage">Sync</a>.</>
          : !hasCohortEvidence ? "Current license verification is required to identify users without paid Copilot. Run Users sync in Sync."
            : data.counts.filtered ? "Continue to the next page." : "Try another search or clear filters."}</p>
      </div> : null}
      {showPageControls || hasShownPageControls ? <ReportPageControls {...read} label="users" /> : null}
    </div>
    {data ? <details className="copilot-users-provenance"><summary>Report sources</summary><UsageReportContext reports={data.reports} inlineSources /></details> : null}
    {selected ? <UserDetailModal key={selected.username} identity={selected.username} kind="report" selectionId={selected.selectionId}
      filters={route.agentId ? { agentId: route.agentId } : undefined}
      returnFocusTo={trigger} closeLabel="Close reported user details" onClose={() => setSelected(undefined)} onOpenAgent={onOpenAgent}
      onFocusAgent={(agentId, reportSetId) => {
        if (!read.isCurrentData(true)) return;
        setSelected(undefined); read.restart(); resetFilters(); onRouteChange({ ...route, search: "", agentId, reportSetId, page: 0 });
      }}
      dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onRestartSelection={restartSelection}
      onSelectionInvalidated={read.invalidateSelection} /> : null}
  </section>;
}
