import { useContext, useEffect, useId, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { CombinedUser, ReportUser } from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail } from "../../../backend/src/types/officialReportApi";
import type { ResponsibilityPerson } from "../../../backend/src/types/agentResponsibility";
import { isDirectoryObjectId } from "../../../backend/src/types/copilotPackage";
import { readReportDetail } from "../api/reportData";
import { ApiError } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { CapabilityContext } from "../capabilityContext";
import { useReportPrincipalScope } from "../useReportPage";
import type { UserDetailTab } from "../workbenchRouting";
import { usageCount, usageDate } from "../usageInsights";
import { trapDialogFocus } from "../dialogFocus";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { ReportedUserAgents, type UserRelationshipFilters } from "./ReportedUserAgents";
import { UserAgentResponsibility } from "./UserAgentResponsibility";
import { UserPurviewAudit } from "./UserPurviewAudit";

const tabs = [["overview", "Overview"], ["usage", "Usage & agents"], ["licenses", "Licenses"], ["responsibility", "Responsibility"], ["purview", "Purview audit"]] as const;
const appLabels = {
  copilotChatLastActivityDate: "Copilot Chat", microsoftTeamsCopilotLastActivityDate: "Teams",
  wordCopilotLastActivityDate: "Word", excelCopilotLastActivityDate: "Excel", powerpointCopilotLastActivityDate: "PowerPoint",
  outlookCopilotLastActivityDate: "Outlook", onenoteCopilotLastActivityDate: "OneNote", loopCopilotLastActivityDate: "Loop",
} as const;
type Props = { identity: string; selectionId?: string; kind: "directory" | "report"; filters?: UserRelationshipFilters;
  activeTab?: UserDetailTab; onTabChange?: (tab: UserDetailTab) => void;
  returnFocusTo: RefObject<HTMLElement | null>; closeLabel: string; onClose: () => void;
  onRestartSelection?: () => void;
  onFocusAgent?: (agentId: string, reportSetId: string) => void; onOpenAgent?: (id: string) => void; dataRevision?: number; agentInventoryRevision?: number };
export function UserDetailModal({ identity, selectionId, kind, filters, activeTab, onTabChange, returnFocusTo, closeLabel, onClose, onFocusAgent, onOpenAgent, dataRevision, agentInventoryRevision, onRestartSelection }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), id = useId();
  const [internalTab, setTab] = useState<UserDetailTab>("overview");
  const tab = activeTab ?? internalTab;
  const [visited, setVisited] = useState<readonly UserDetailTab[]>([tab]);
  const [responsibilityPerson, setResponsibilityPerson] = useState<ResponsibilityPerson>();
  const [initialNow] = useState(Date.now);
  const now = useContext(CapabilityContext)?.now ?? initialNow;
  const principal = useReportPrincipalScope();
  const validIdentity = kind !== "directory" || isDirectoryObjectId(identity);
  const directUser = kind === "directory" && !selectionId;
  function changeTab(next: UserDetailTab) {
    setTab(next);
    setVisited(values => [...new Set([...values, tab, next])]);
    onTabChange?.(next);
  }
  const path = `${kind === "directory" ? "copilot-usage" : "official-usage"}/users/${encodeURIComponent(identity)}`;
  const read = useSavedQuery<OfficialReportDetail<CombinedUser | ReportUser>>({
    queryKey: ["saved", "report-detail", principal, kind, identity, selectionId, dataRevision], enabled: validIdentity, gcTime: 0, staleTime: Infinity,
    placeholderData: (previous, query) => query?.queryKey[2] === principal && query.queryKey[3] === kind
      && query.queryKey[4] === identity && query.queryKey[5] === selectionId ? previous : undefined,
    queryFn: async ({ signal }) => {
      const result = await readReportDetail<CombinedUser | ReportUser>(path, selectionId, signal);
      const exactIdentity = "directory" in result.value ? result.value.directory.objectId : result.value.username;
      if (selectionId && result.selection.id !== selectionId || exactIdentity !== identity || (kind === "directory") !== ("directory" in result.value)) {
        throw new ApiError(409, "selection_invalidated", "Exact user evidence does not match this selection.");
      }
      return result;
    },
  });
  const restartSelection = onRestartSelection ?? (directUser ? () => { void read.refetch(); } : undefined);
  const detail = read.isError ? undefined : read.data;
  const reported = detail && "username" in detail.value ? detail.value : undefined;
  const directoryRead = useSavedQuery<OfficialReportDetail<CombinedUser>>({
    queryKey: ["saved", "report-directory-detail", principal, identity, selectionId, dataRevision, reported?.objectId],
    enabled: kind === "report" && Boolean(reported?.objectId), gcTime: 0,
    placeholderData: (previous, query) => query?.queryKey[2] === principal && query.queryKey[3] === identity
      && query.queryKey[4] === selectionId && query.queryKey[6] === reported?.objectId ? previous : undefined,
    queryFn: async ({ signal }) => {
      const result = await readReportDetail<CombinedUser>(`${path}/directory`, selectionId, signal);
      const sourcesMatch = (["directory", "app_activity"] as const).every(kind => {
        const source = detail?.sources[kind], returned = result.sources[kind];
        return source?.generationId === returned.generationId && source?.revision === returned.revision && source?.scopeId === returned.scopeId;
      });
      const lineagesMatch = detail?.reports.lineages.length === result.reports.lineages.length
        && detail.reports.lineages.every(lineage => result.reports.lineages.some(value => value.kind === lineage.kind
          && value.versionId === lineage.versionId && value.contentHash === lineage.contentHash));
      if (result.selection.id !== selectionId || result.value.directory.objectId !== reported?.objectId
        || result.reports.setId !== detail?.reports.setId || !lineagesMatch || !sourcesMatch) {
        throw new ApiError(409, "selection_invalidated", "Selected directory evidence does not match this exact report identity.");
      }
      return result;
    },
  });
  const directory = kind === "directory" ? detail && "directory" in detail.value ? detail.value : undefined
    : directoryRead.isError ? undefined : directoryRead.data?.value;
  const current = detail?.sources.directory.state === "available";
  const reportCurrent = detail?.reports.availability === "active";
  const responsibilityIdentity = responsibilityPerson?.objectId === identity ? responsibilityPerson : undefined;
  const evidence = responsibilityIdentity?.evidence;
  const expiredIdentity = evidence?.expiresAt !== undefined && !(Date.parse(evidence.expiresAt) > now);
  const identityNotice = !directory && responsibilityIdentity
    ? !evidence ? "Unverified directory identity."
      : evidence.status === "not_found" ? "User not found at the last directory lookup."
        : evidence.status === "lookup_failed" ? "Directory lookup failed. Any identity label is last-known evidence."
          : expiredIdentity ? "Saved directory identity is out of date. Refresh user data to verify it." : undefined
    : undefined;
  const name = directory?.directory.displayName || reported?.displayName || evidence?.displayName || evidence?.userPrincipalName || identity;
  const username = directory?.directory.userPrincipalName || reported?.username || evidence?.userPrincipalName || identity;
  const missingProfile = directUser && read.error instanceof ApiError && read.error.code === "data_record_not_found";
  useEffect(() => {
    const element = dialog.current, fallback = returnFocusTo.current, previous = fallback ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const overflow = document.body.style.overflow;
    element?.showModal(); close.current?.focus(); document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; (previous?.isConnected ? previous : fallback)?.focus(); };
  }, [returnFocusTo]);
  const counts = reported ?? directory;
  const period = detail?.reports.reportingPeriod;
  const reportRange = period?.startDate && period.endDate
    ? `${usageDate(period.startDate)} - ${usageDate(period.endDate)}` : "Dates not supplied";
  const hasReport = Boolean(reported || directory?.reportMatch === "matched");
  const noReportedActivity = current && reportCurrent && directory?.agentActivityState === "none";
  const missingUserReport = reported?.missingUserReport || hasReport && counts?.reportedResponses === null;
  const reportMismatch = reported?.hasReportMismatch || counts?.reportedResponses != null && counts.bridgeResponses != null
    && counts.reportedResponses !== counts.bridgeResponses;
  const adoption = directory ? [
    !current ? "Verify paid license inventory" : null,
    !current ? "Usage unknown" : directory.agentActivityState === "active" && reportCurrent ? "Using agents"
      : directory.agentActivityState === "none" && reportCurrent ? "No reported agent activity" : "Usage unknown",
    current && reportCurrent && directory.attention.some(value => value === "agent_usage_low" || value === "agent_usage_zero") ? "Offer adoption help" : null,
    current && detail?.sources.app_activity.state === "available" && directory.attention.includes("app_activity_inactive") ? "Review app activity" : null,
    current && directory.copilotServiceState !== "enabled" && directory.copilotServiceState !== "unknown" ? "Review paid features" : null,
  ].filter((value): value is string => value !== null) : [];
  useEffect(() => {
    const panel = dialog.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    if (panel) panel.scrollTop = 0;
  }, [tab]);
  return <dialog ref={dialog} className="inventory-detail-modal copilot-user-dialog user-detail-modal" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      else trapDialogFocus(event, dialog.current);
    }}>
    <header><div><p className="eyebrow">User details</p><h2 id={`${id}-title`}>{name}</h2><p>{username}</p>
      {adoption.map(signal => <span key={signal} className={`copilot-user-badge ${!current || signal === "Usage unknown" ? "unknown"
        : signal.startsWith("Review") || signal === "Offer adoption help" ? "attention" : ""}`}>{signal}</span>)}</div>
      <button ref={close} type="button" className="secondary icon-button" aria-label={closeLabel} onClick={onClose}><X size={20} aria-hidden="true" /></button></header>
    {detail && read.isFetching ? <p className="sr-only" role="status">Refreshing saved user details. Showing the last loaded snapshot.</p> : null}
    <div role="tablist" aria-label="User details" className="detail-tabs">{tabs.map(([value, label], index) => <button key={value} type="button" role="tab"
      id={`${id}-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
      onClick={() => changeTab(value)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
        if (next) { event.preventDefault(); changeTab(next[0]); document.getElementById(`${id}-${next[0]}`)?.focus(); }
      }}>{label}</button>)}</div>
    {tabs.map(([panel]) => <section key={panel} hidden={tab !== panel} role="tabpanel" id={`${id}-panel-${panel}`} aria-labelledby={`${id}-${panel}`} className="user-detail-panel" tabIndex={0}>
      {tab === panel ? <>
        {!validIdentity ? <p role="alert">User details unavailable: an exact directory object ID is required.</p>
          : missingProfile ? <p className="copilot-users-notice" role="status">This user is not in the saved Users directory. Responsibility is shown from agent inventory; profile, license and usage details are unavailable. Run Users sync to refresh user data.</p>
          : read.isPending ? <p role="status">Loading exact user details...</p> : read.error ? <div className="user-detail-card" role="alert"><p>{read.error.message}.</p>
          {read.error instanceof ApiError && read.error.code === "selection_invalidated" && restartSelection
            ? <button type="button" onClick={restartSelection}>Restart selection</button>
            : <button type="button" onClick={() => { void read.refetch(); }}>Retry user details</button>}</div> : null}
        {directoryRead.error ? <div className="user-detail-card" role="alert"><p>{directoryRead.error.message}</p>
          {directoryRead.error instanceof ApiError && directoryRead.error.code === "selection_invalidated" && restartSelection
            ? <button type="button" onClick={restartSelection}>Restart selection</button>
            : <button type="button" onClick={() => { void directoryRead.refetch(); }}>Retry directory details</button>}</div> : null}
      </> : null}
      {(visited.includes(panel) || tab === panel) && detail ? <>
        {panel === "overview" ? <><div className="copilot-user-metrics" role="group" aria-label="User summary"><div className="copilot-user-metric"><span>M365 Copilot license</span><CopilotLicenseStatus user={directory} current={current} entitlement={reported?.entitlement} /></div>
          <div className="copilot-user-metric"><span>Agent responses</span><strong>{counts?.reportedResponses == null && noReportedActivity ? "Not reported" : usageCount(counts?.reportedResponses)}</strong><small>Users report</small></div>
          <div className="copilot-user-metric"><span>Agents used</span><strong>{counts?.reportedAgentsUsed == null && noReportedActivity ? "Not reported" : usageCount(counts?.reportedAgentsUsed)}</strong><small>Users report</small></div></div>
          {hasReport || noReportedActivity ? <p className="user-report-period"><strong>Agent report dates</strong><span>{reportRange}</span></p> : null}
          {missingUserReport && !noReportedActivity ? <p className="copilot-users-notice">User totals are not included in this report.</p> : null}
          {directory && !current ? <p className="copilot-users-notice">Showing saved user details. Refresh Users in Sync to verify current licensing.</p> : null}
          <section className="user-detail-card" aria-label="Saved directory organization"><h3>Organization</h3>
            {directory ? <dl className="user-profile-grid">{([
              ["Company", directory.directory.companyName || "Not reported"], ["Department", directory.directory.department || "Not reported"],
              ["User type", directory.directory.userType], ["Employee type", directory.directory.employeeType],
              ["Directory account", directory.directory.accountEnabled === false ? "Account disabled" : directory.directory.accountEnabled === true ? "Enabled" : "Unknown"],
            ] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
              : <p>Organization details are unavailable for this report identity.</p>}</section>
          {hasReport ? <section className="user-detail-card" aria-label="User reported activity"><h3>Last reported agent activity</h3><p>{usageDate(counts?.userLastActivityDateUtc)}</p></section> : null}</> : null}
        {panel === "usage" ? <>
          <section className="user-detail-card" aria-label="User agent activity"><h3>Agent usage</h3>
            <p className="user-report-period"><strong>Agent report dates</strong><span>{reportRange}</span></p>
            {hasReport && !reportCurrent ? <p className="copilot-users-notice">Showing a saved agent report. Refresh reports in Sync.</p> : null}
            {reportMismatch ? <p className="copilot-users-notice">Report totals differ. Users total: {usageCount(counts?.reportedResponses)}; agent breakdown: {usageCount(counts?.bridgeResponses)}.</p> : null}
            {hasReport ? <><p>Responses across reported agents: <strong>{counts?.relationshipCount ? usageCount(counts.bridgeResponses) : "Not reported"}</strong></p>
              <ReportedUserAgents path={`${path}/agents`} selectionId={detail.selection.id} filters={filters} onFocusAgent={onFocusAgent} onRestartSelection={restartSelection} />
            </> : <p>{noReportedActivity ? "No agent activity in the selected reports." : "No agent usage report is linked to this user."}</p>}
          </section>
          <section className="user-detail-card" aria-label="User Office app activity"><h3>Copilot in Office apps</h3>{directory?.appActivity ? <>
            <p>Last reported activity by app. {detail.sources.app_activity.period ? `${detail.sources.app_activity.period} report` : "Report"} refreshed {usageDate(directory.appActivity.reportRefreshDate)}.</p>
            {detail.sources.app_activity.state === "stale" ? <p className="copilot-users-notice">This Office app report is out of date.</p> : null}
            <ul className="copilot-app-activity">{(Object.keys(appLabels) as Array<keyof typeof appLabels>).map(key => <li key={key}><strong>{appLabels[key]}</strong>
              <small>{directory.appActivity?.[key] ? usageDate(directory.appActivity[key]) : "No date reported"}</small></li>)}</ul>
          </> : <p>Office app activity is unavailable for this user. Check Users sync and reporting permissions.</p>}</section></> : null}
        {panel === "licenses" ? directory ? <CopilotServiceDetails path={`${path}/service-plans`} selectionId={detail.selection.id}
          copilotServiceState={directory.copilotServiceState} current={current} onRestartSelection={restartSelection} /> : <p>Detailed license assignments are unavailable for this report identity.</p> : null}
        {panel === "purview" ? <UserPurviewAudit active={tab === "purview"} userPrincipalName={current ? directory?.directory.userPrincipalName : undefined} /> : null}
      </> : null}
      {(visited.includes(panel) || tab === panel) && panel === "responsibility" && (detail || directUser) ? <>
        {identityNotice ? <p className="reported-users-note">{identityNotice}</p> : null}
        <UserAgentResponsibility objectId={directUser && validIdentity ? identity : current ? directory?.directory.objectId : undefined}
          dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent}
          onPersonLoaded={setResponsibilityPerson} />
      </> : null}
    </section>)}
  </dialog>;
}
