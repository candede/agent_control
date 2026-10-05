import { useContext, useRef, useState } from "react";
import type { ReportQuery, ReportUser } from "../../../backend/src/types/officialReportData";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import type { UsersRouteState } from "../workbenchRouting";
import { isValidLowResponseThreshold, usageCount, usageDate } from "../usageInsights";
import { useReportPage } from "../useReportPage";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
import { UserActivityFilters } from "./UserActivityFilters";
import { ReportSortHeading } from "./ReportSortHeading";
import { ReportExportButton } from "./ReportExportButton";
import { UsageReportContext } from "./UsageReportContext";
import { UserDetailModal } from "./UserDetailModal";
import "./reportedUsers.css";

type Props = { route: UsersRouteState; onRouteChange: (route: UsersRouteState, replace?: boolean) => void;
  dataRevision?: number; agentInventoryRevision?: number; onOpenAgent?: (id: string) => void };
export function ReportedUserActivity(props: Props) {
  const capability = useContext(CapabilityContext), user = capability?.user;
  if (capability && !hasRole(user, "AgentControl.Viewer")) return <p role="alert">Current Viewer access is required to read reported users.</p>;
  return <ReportedUsers key={JSON.stringify([user?.tenantId, user?.homeAccountId, user?.roles])} {...props} />;
}
function ReportedUsers({ route, onRouteChange, dataRevision = 0, agentInventoryRevision, onOpenAgent }: Props) {
  const [filters, setFilters] = useState<ReportQuery>({ cohort: "all", sort: "responses", order: "desc" });
  const [threshold, setThreshold] = useState("5");
  const [lastThreshold, setLastThreshold] = useState(5);
  const [selected, setSelected] = useState<{ username: string; selectionId: string; reportSetId?: string }>();
  const focus = useRef<HTMLInputElement>(null), valid = isValidLowResponseThreshold(threshold);
  const trigger = useRef<HTMLButtonElement>(null);
  if (valid && lastThreshold !== Number(threshold)) setLastThreshold(Number(threshold));
  const read = useReportPage<ReportUser>("official-usage/users", { ...filters, licenseCohort: "active_without_paid",
    search: route.search || undefined, agentId: route.agentId, setId: route.reportSetId, lowResponseThreshold: valid ? Number(threshold) : lastThreshold }, dataRevision);
  const data = read.data;
  if (selected && (read.error || selected.reportSetId !== route.reportSetId || data && data.selection.id !== selected.selectionId)) setSelected(undefined);
  function restartSelection() { setSelected(undefined); read.restart(); }
  return <section className="reported-users" aria-label="Non-paid user activity">
    <ReportReadStatus read={read} quietLoading />
    {data && data.sources.directory.state !== "available" ? <p className="copilot-users-notice" role="status">License data unavailable.{" "}
      {data.sources.directory.message ?? "Current directory verification is required."} Run Users sync to verify licensing.</p> : null}
    {data && data.summary.unknownLicenseActiveReportUsers > 0 ? <p className="copilot-users-notice">{data.summary.unknownLicenseActiveReportUsers.toLocaleString()} active report{" "}
      {data.summary.unknownLicenseActiveReportUsers === 1 ? "user needs" : "users need"} a license check. Run Users sync.</p> : null}
    {data?.reports.availability === "stale" ? <p className="copilot-users-notice">Reports are out of date. Refresh reports in Sync.</p> : null}
    <UserActivityFilters path="official-usage/users" selectionId={data?.selection.id} onRestartSelection={restartSelection}
      values={{ company: filters.company, department: filters.department, cohort: filters.cohort ?? "all", lowResponseThreshold: threshold }}
      cohorts={[{ value: "all", label: "All response counts" }, { value: "low", label: "Low responses" }, { value: "zero", label: "Zero responses" }, { value: "review", label: "Zero or low responses" }]}
      defaultCohort="all" search={route.search} searchRef={focus} sort={`${filters.sort}:${filters.order}`}
      sorts={(["responses", "agentsUsed", "lastActivity", "name"] as const).flatMap(sort => (["desc", "asc"] as const).map(order => ({
        value: `${sort}:${order}`, label: `${sort === "responses" ? "Agent responses" : sort === "agentsUsed" ? "Agents used" : sort === "lastActivity" ? "User activity" : "Name"} ${order === "asc" ? "ascending" : "descending"}`,
      })))} matchingCount={data?.counts.filtered} loading={read.loading} validThreshold={valid} agent={route.agentId}
      onClearAgent={() => onRouteChange({ ...route, agentId: undefined, page: 0 })}
      onSearch={search => onRouteChange({ ...route, search, page: 0 })} onChange={value => {
        setFilters({ ...filters, company: value.company, department: value.department, cohort: value.cohort }); setThreshold(value.lowResponseThreshold);
      }} onSort={value => { const [sort, order] = value.split(":"); setFilters({ ...filters, sort: sort as ReportQuery["sort"], order: order as ReportQuery["order"] }); }}
      onClear={() => { setFilters({ cohort: "all", sort: filters.sort, order: filters.order }); setThreshold("5"); onRouteChange({ ...route, search: "", agentId: undefined, page: 0 }); }}
      exportButton={<ReportExportButton key={data?.selection.id} kind="official_users" selectionId={data?.selection.id} label="Export users CSV"
        disabled={read.loading || !valid || data?.sources.directory.state !== "available" || !data?.reports.setId} />} />
      {read.loading || data?.value.length ? <div className="copilot-users-table-shell" role="region" aria-label="Reported user activity" tabIndex={0}><table className="copilot-users-table reported-users-table">
        <thead><tr><ReportSortHeading label="User" sort="name" query={filters} onChange={setFilters} />
          <ReportSortHeading label="Agent responses" sort="responses" query={filters} onChange={setFilters} />
          <ReportSortHeading label="Agents used" sort="agentsUsed" query={filters} onChange={setFilters} />
          <th scope="col">Company</th><th scope="col">Department</th><ReportSortHeading label="Last activity" sort="lastActivity" query={filters} onChange={setFilters} /></tr></thead>
        <tbody>{data?.value.map(user => <tr key={user.username}><th scope="row"><button type="button" className="user-name-button" aria-haspopup="dialog" onClick={event => {
          trigger.current = event.currentTarget; setSelected({ username: user.username, selectionId: data.selection.id, reportSetId: route.reportSetId });
        }}>
          {user.displayName || user.username}</button><small>{user.username}</small></th><td data-numeric>{usageCount(user.reportedResponses)}</td>
          <td data-numeric>{usageCount(user.reportedAgentsUsed)}</td><td>{user.company?.trim() || "Not set"}</td><td>{user.department?.trim() || "Not set"}</td><td>{usageDate(user.userLastActivityDateUtc)}
            {user.hasReportMismatch ? <small>Report totals differ</small> : null}{user.missingUserReport ? <small>Users report metric unknown</small> : null}</td></tr>)}</tbody>
      </table></div> : data ? <div className="reported-users-empty">
        <h3>{!data.reports.setId ? "No selected user reports" : data.counts.filtered ? "No reported users on this page" : "No matching reported users"}</h3>
        <p>{!data.reports.setId ? <>Select or import reports in <a href="/sync?reports=manage">Sync</a>.</>
          : data.counts.filtered ? "Continue to the next page." : "Try another search or clear filters."}</p>
      </div> : null}
    {data && data.counts.filtered > 0 ? <ReportPageControls {...read} label="users" /> : null}
    {data ? <details className="copilot-users-provenance"><summary>Report sources</summary><UsageReportContext reports={data.reports} inlineSources /></details> : null}
    {selected ? <UserDetailModal key={selected.selectionId + selected.username} identity={selected.username} kind="report" selectionId={selected.selectionId}
      filters={route.agentId ? { agentId: route.agentId } : undefined}
      returnFocusTo={trigger} closeLabel="Close reported user details" onClose={() => setSelected(undefined)} onOpenAgent={onOpenAgent}
      onFocusAgent={(agentId, reportSetId) => { setSelected(undefined); onRouteChange({ ...route, agentId, reportSetId, page: 0 }); }}
      dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onRestartSelection={restartSelection} /> : null}
  </section>;
}
