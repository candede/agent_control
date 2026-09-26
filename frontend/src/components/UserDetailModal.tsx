import { useContext, useEffect, useId, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { CopilotAppActivity, CopilotUsageSourceSummary, CopilotUsageUser, OfficialUsageUserSummary } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { usageDate } from "../usageInsights";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { ReportedUserAgents, type UserRelationshipFilters } from "./ReportedUserAgents";
import { UserAgentResponsibility } from "./UserAgentResponsibility";
import { UserPurviewAudit } from "./UserPurviewAudit";

const tabs = [
  ["overview", "Overview"], ["usage", "Usage & agents"], ["licenses", "Licenses"],
  ["responsibility", "Responsibility"], ["purview", "Purview audit"],
] as const;
type Tab = typeof tabs[number][0];
const appFields = [
  ["Copilot Chat", "copilotChatLastActivityDate"], ["Teams", "microsoftTeamsCopilotLastActivityDate"],
  ["Word", "wordCopilotLastActivityDate"], ["Excel", "excelCopilotLastActivityDate"],
  ["PowerPoint", "powerpointCopilotLastActivityDate"], ["Outlook", "outlookCopilotLastActivityDate"],
  ["OneNote", "onenoteCopilotLastActivityDate"], ["Loop", "loopCopilotLastActivityDate"],
] as const satisfies ReadonlyArray<readonly [string, keyof CopilotAppActivity]>;

type Props = {
  identity: string;
  displayName: string;
  username: string;
  directoryUser?: CopilotUsageUser | null;
  directoryCurrent: boolean;
  reportUser?: OfficialUsageUserSummary | null;
  reportPeriod?: { startDate: string | null; endDate: string | null };
  reportCurrent?: boolean;
  appActivityState?: CopilotUsageSourceSummary["state"];
  followUp?: { label: string; tone: string };
  filters?: UserRelationshipFilters;
  returnFocusTo: RefObject<HTMLElement | null>;
  closeLabel: string;
  onClose: () => void;
  onFocusAgent?: (agentId: string, reportSetId: string) => void;
  onOpenAgent?: (id: string) => void;
  dataRevision?: number;
  agentInventoryRevision?: number;
};

export function UserDetailModal(props: Props) {
  const capability = useContext(CapabilityContext);
  const identity = JSON.stringify([capability?.user?.tenantId, capability?.user?.homeAccountId,
    [...(capability?.user?.roles ?? [])].sort(), props.identity]);
  return <UserDetailSession key={identity} {...props} />;
}

function UserDetailSession({ displayName, username, directoryUser, directoryCurrent, reportUser, reportPeriod,
  reportCurrent = true, appActivityState, followUp, filters, returnFocusTo, closeLabel, onClose, onFocusAgent,
  onOpenAgent, dataRevision, agentInventoryRevision }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [selectedTab, setSelectedTab] = useState<Tab>("overview");
  const [visited, setVisited] = useState<Tab[]>(["overview"]);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallbackFocus = returnFocusTo.current;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    close.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      (previousFocus?.isConnected ? previousFocus : fallbackFocus)?.focus();
    };
  }, [returnFocusTo]);
  useEffect(() => {
    const panel = dialog.current?.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
    if (panel) panel.scrollTop = 0;
  }, [selectedTab]);

  function selectTab(tab: Tab) {
    setSelectedTab(tab);
    setVisited(current => current.includes(tab) ? current : [...current, tab]);
  }
  const reportRange = reportPeriod?.startDate && reportPeriod.endDate
    ? `${usageDate(reportPeriod.startDate)} - ${usageDate(reportPeriod.endDate)}` : "Dates not supplied";
  const totals = reportUser?.missingUserReport ? undefined : reportUser;
  function content(tab: Tab) {
    switch (tab) {
      case "overview": return <>
        <div className="copilot-user-metrics" aria-label="User summary">
          <div className="copilot-user-metric"><span>M365 Copilot license</span>
            <CopilotLicenseStatus user={directoryUser} current={directoryCurrent} licenseAssignmentStatus={reportUser?.licenseAssignmentStatus} />
          </div>
          <div className="copilot-user-metric"><span>Agent responses</span><strong>{totals ? totals.reportedResponsesReceived.toLocaleString() : "Unknown"}</strong><small>Users report</small></div>
          <div className="copilot-user-metric"><span>Agents used</span><strong>{totals ? totals.reportedAgentsUsed.toLocaleString() : "Unknown"}</strong><small>Users report</small></div>
        </div>
        {reportUser ? <p className="user-report-period"><strong>Agent report dates</strong><span>{reportRange}</span></p> : null}
        {reportUser?.missingUserReport ? <p className="copilot-users-notice">User totals are not included in this report.</p> : null}
        {directoryUser && !directoryCurrent ? <p className="copilot-users-notice">Showing saved user details. Refresh Users in Sync to verify current licensing.</p> : null}
        <section className="user-detail-card" aria-label="Saved directory organization">
          <h3>Organization</h3>
          {directoryUser ? <dl className="user-profile-grid">
            {([
              ["Company", directoryUser.directory.companyName || "Not reported"], ["Department", directoryUser.directory.department || "Not reported"],
              ["User type", directoryUser.directory.userType], ["Employee type", directoryUser.directory.employeeType],
              ["Directory account", directoryUser.directory.accountEnabled === false ? "Account disabled" : directoryUser.directory.accountEnabled === true ? "Enabled" : "Unknown"],
            ] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl> : <p>Organization details are unavailable for this report identity.</p>}
        </section>
        {reportUser ? <section className="user-detail-card" aria-label="User reported activity"><h3>Last reported agent activity</h3><p>{usageDate(reportUser.userLastActivityDateUtc)}</p></section> : null}
      </>;
      case "usage": return <>
        <section className="user-detail-card" aria-label="User agent activity">
          <h3>Agent usage</h3>
          <p className="user-report-period"><strong>Agent report dates</strong><span>{reportRange}</span></p>
          {reportUser && !reportCurrent ? <p className="copilot-users-notice">Showing a saved agent report. Refresh reports in Sync.</p> : null}
          {reportUser?.hasReportMismatch ? <p className="copilot-users-notice">Report totals differ. Users total: {totals ? totals.reportedResponsesReceived.toLocaleString() : "Unknown"}; agent breakdown: {reportUser.bridgeResponsesSentToUsers.toLocaleString()}.</p> : null}
          {reportUser ? <>
            <p>Responses across reported agents: <strong>{reportUser.rows.length ? reportUser.bridgeResponsesSentToUsers.toLocaleString() : "Not reported"}</strong></p>
            <ReportedUserAgents user={reportUser} filters={filters} onFocusAgent={onFocusAgent} />
          </> : <p>No agent usage report is linked to this user.</p>}
        </section>
        <section className="user-detail-card" aria-label="User Office app activity">
          <h3>Copilot in Office apps</h3>
          {directoryUser?.appActivity ? <>
            <p>Last reported activity by app. Report refreshed {usageDate(directoryUser.appActivity.reportRefreshDate)}.</p>
            {appActivityState === "stale" ? <p className="copilot-users-notice">This Office app report is out of date.</p> : null}
            <ul className="copilot-app-activity">{appFields.map(([label, field]) => <li key={field}><strong>{label}</strong>
              <small>{directoryUser.appActivity?.[field] ? usageDate(directoryUser.appActivity[field]) : "No date reported"}</small></li>)}</ul>
          </> : <p>Office app activity is unavailable for this user. Check Users sync and reporting permissions.</p>}
        </section>
      </>;
      case "licenses": return directoryUser ? <CopilotServiceDetails servicePlans={directoryUser.servicePlans}
        copilotServiceState={directoryUser.copilotServiceState} current={directoryCurrent} />
        : <p>Detailed license assignments are unavailable for this report identity.</p>;
      case "responsibility": return <UserAgentResponsibility compact objectId={directoryCurrent ? directoryUser?.directory.objectId : undefined}
        dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} />;
      case "purview": return <UserPurviewAudit active={selectedTab === "purview"} userPrincipalName={directoryCurrent ? directoryUser?.directory.userPrincipalName : undefined} />;
    }
  }
  return <dialog ref={dialog} className="inventory-detail-modal copilot-user-dialog user-detail-modal" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <header>
      <div><p className="eyebrow">User details</p><h2 id={`${id}-title`}>{displayName}</h2><p>{username}</p>
        {followUp ? <span className={`copilot-user-badge ${followUp.tone}`}>{followUp.label}</span> : null}</div>
      <button ref={close} type="button" className="secondary icon-button" aria-label={closeLabel} onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="detail-tabs" role="tablist" aria-label="User details">
      {tabs.map(([tab, label], index) => <button key={tab} type="button" role="tab" id={`${id}-tab-${tab}`} aria-selected={selectedTab === tab}
        aria-controls={`${id}-panel-${tab}`} tabIndex={selectedTab === tab ? 0 : -1} onClick={() => selectTab(tab)}
        onKeyDown={event => {
          const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length]
            : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
              : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
          if (!next) return;
          event.preventDefault();
          selectTab(next[0]);
          document.getElementById(`${id}-tab-${next[0]}`)?.focus();
        }}>{label}</button>)}
    </div>
    {tabs.map(([tab]) => <section key={tab} id={`${id}-panel-${tab}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}
      tabIndex={0} hidden={selectedTab !== tab} className="user-detail-panel">
      {visited.includes(tab) ? content(tab) : null}
    </section>)}
  </dialog>;
}
