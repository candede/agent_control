import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { CombinedUser, ReportUser } from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail } from "../../../backend/src/types/officialReportApi";
import { readReportDetail } from "../api/reportData";
import { ApiError } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { trapDialogFocus } from "../dialogFocus";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { ReportedUserAgents, type UserRelationshipFilters } from "./ReportedUserAgents";
import { UserAgentResponsibility } from "./UserAgentResponsibility";
import { UserPurviewAudit } from "./UserPurviewAudit";
import { UsageReportContext } from "./UsageReportContext";

const tabs = [["overview", "Overview"], ["usage", "Usage & agents"], ["licenses", "Licenses"], ["responsibility", "Responsibility"], ["purview", "Purview audit"]] as const;
const appLabels = {
  lastActivityDate: "Last activity", copilotChatLastActivityDate: "Copilot Chat", microsoftTeamsCopilotLastActivityDate: "Teams",
  wordCopilotLastActivityDate: "Word", excelCopilotLastActivityDate: "Excel", powerpointCopilotLastActivityDate: "PowerPoint",
  outlookCopilotLastActivityDate: "Outlook", onenoteCopilotLastActivityDate: "OneNote", loopCopilotLastActivityDate: "Loop",
} as const;
type Tab = typeof tabs[number][0];
type Props = { identity: string; selectionId: string; kind: "directory" | "report"; filters?: UserRelationshipFilters;
  returnFocusTo: RefObject<HTMLElement | null>; closeLabel: string; onClose: () => void;
  onRestartSelection?: () => void;
  onFocusAgent?: (agentId: string, reportSetId: string) => void; onOpenAgent?: (id: string) => void; dataRevision?: number; agentInventoryRevision?: number };
export function UserDetailModal({ identity, selectionId, kind, filters, returnFocusTo, closeLabel, onClose, onFocusAgent, onOpenAgent, dataRevision, agentInventoryRevision, onRestartSelection }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), id = useId();
  const [tab, setTab] = useState<Tab>("overview");
  const [visited, setVisited] = useState<readonly Tab[]>(["overview"]);
  const principal = useReportPrincipalScope();
  function changeTab(next: Tab) { setTab(next); setVisited(values => values.includes(next) ? values : [...values, next]); }
  const path = `${kind === "directory" ? "copilot-usage" : "official-usage"}/users/${encodeURIComponent(identity)}`;
  const read = useSavedQuery<OfficialReportDetail<CombinedUser | ReportUser>>({
    queryKey: ["saved", "report-detail", principal, kind, identity, selectionId, dataRevision], gcTime: 0, staleTime: Infinity,
    placeholderData: (previous, query) => query?.queryKey[2] === principal && query.queryKey[3] === kind
      && query.queryKey[4] === identity && query.queryKey[5] === selectionId ? previous : undefined,
    queryFn: async ({ signal }) => {
      const result = await readReportDetail<CombinedUser | ReportUser>(path, selectionId, signal);
      const exactIdentity = "directory" in result.value ? result.value.directory.objectId : result.value.username;
      if (result.selection.id !== selectionId || exactIdentity !== identity || (kind === "directory") !== ("directory" in result.value)) {
        throw new ApiError(409, "selection_invalidated", "Exact user evidence does not match this selection.");
      }
      return result;
    },
  });
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
  const name = directory?.directory.displayName || reported?.displayName || identity;
  const username = directory?.directory.userPrincipalName || reported?.username || identity;
  useEffect(() => {
    const element = dialog.current, fallback = returnFocusTo.current, previous = fallback ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const overflow = document.body.style.overflow;
    element?.showModal(); close.current?.focus(); document.body.style.overflow = "hidden";
    return () => { element?.close(); document.body.style.overflow = overflow; (previous?.isConnected ? previous : fallback)?.focus(); };
  }, [returnFocusTo]);
  const counts = reported ?? directory;
  const adoption = directory ? [
    !current ? "Verify paid license inventory" : null,
    !current ? "Usage unknown" : directory.agentActivityState === "active" && reportCurrent ? "Using agents"
      : directory.agentActivityState === "none" && reportCurrent ? "No reported agent activity" : "Usage unknown",
    current && reportCurrent && directory.attention.some(value => value === "agent_usage_low" || value === "agent_usage_zero") ? "Offer adoption help" : null,
    current && detail?.sources.app_activity.state === "available" && directory.attention.includes("app_activity_inactive") ? "Review app activity" : null,
    current && directory.copilotServiceState !== "enabled" && directory.copilotServiceState !== "unknown" ? "Review paid features" : null,
  ].filter((value): value is string => value !== null) : [];
  return <dialog ref={dialog} className="inventory-detail-modal copilot-user-dialog user-detail-modal" aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      else trapDialogFocus(event, dialog.current);
    }}>
    <header><div><p className="eyebrow">User details</p><h2 id={`${id}-title`}>{name}</h2><p>{username}</p></div>
      <button ref={close} type="button" className="secondary icon-button" aria-label={closeLabel} onClick={onClose}><X size={20} /></button></header>
    <div role="tablist" aria-label="User details" className="detail-tabs">{tabs.map(([value, label], index) => <button key={value} type="button" role="tab"
      id={`${id}-${value}`} aria-controls={`${id}-panel-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1}
      onClick={() => changeTab(value)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : undefined;
        if (next) { event.preventDefault(); changeTab(next[0]); document.getElementById(`${id}-${next[0]}`)?.focus(); }
      }}>{label}</button>)}</div>
    {tabs.map(([panel]) => <section key={panel} hidden={tab !== panel} role="tabpanel" id={`${id}-panel-${panel}`} aria-labelledby={`${id}-${panel}`} className="user-detail-panel" tabIndex={0}>
      {tab === panel ? <>
        {read.isPending ? <p role="status">Loading exact user details...</p> : read.error ? <div className="user-detail-card" role="alert"><p>{read.error.message}.</p>
          {read.error instanceof ApiError && read.error.code === "selection_invalidated" && onRestartSelection
            ? <button type="button" onClick={onRestartSelection}>Restart selection</button>
            : <button type="button" onClick={() => { void read.refetch(); }}>Retry user details</button>}</div> : null}
        {directoryRead.error ? <div className="user-detail-card" role="alert"><p>{directoryRead.error.message}</p>
          {directoryRead.error instanceof ApiError && directoryRead.error.code === "selection_invalidated" && onRestartSelection
            ? <button type="button" onClick={onRestartSelection}>Restart selection</button>
            : <button type="button" onClick={() => { void directoryRead.refetch(); }}>Retry directory details</button>}</div> : null}
      </> : null}
      {visited.includes(panel) && detail ? <>
        {panel === "overview" ? <><div className="copilot-user-metrics" role="group" aria-label="User summary"><div className="copilot-user-metric"><span>M365 Copilot license</span><CopilotLicenseStatus user={directory} current={current} entitlement={reported?.entitlement} /></div>
          <div className="copilot-user-metric"><span>Agent responses</span><strong>{usageCount(counts?.reportedResponses)}</strong><small>Users report</small></div>
          <div className="copilot-user-metric"><span>Agents used</span><strong>{usageCount(counts?.reportedAgentsUsed)}</strong><small>Users report</small></div></div>
          <p>Responses across reported agents: <strong>{usageCount(counts?.bridgeResponses)}</strong>. Users &amp; agents totals are separate from Users metrics.</p>
          {adoption.length ? <section className="user-detail-card" aria-label="Adoption signals"><h3>Adoption signals</h3><ul>{adoption.map(signal => <li key={signal}>{signal}</li>)}</ul></section> : null}
          <section className="user-detail-card" aria-label="Saved directory organization"><h3>Organization</h3><dl className="user-profile-grid"><div><dt>Company</dt><dd>{directory?.directory.companyName ?? reported?.company ?? "Not reported"}</dd></div>
            <div><dt>Department</dt><dd>{directory?.directory.department ?? reported?.department ?? "Not reported"}</dd></div><div><dt>Directory account</dt>
            <dd>{directory?.directory.accountEnabled === true ? "Enabled" : directory?.directory.accountEnabled === false ? "Account disabled" : "Unknown"}</dd></div>
            <div><dt>User type</dt><dd>{directory?.directory.userType ?? "Unknown"}</dd></div><div><dt>Employee type</dt><dd>{directory?.directory.employeeType ?? "Unknown"}</dd></div></dl></section>
          <p>Last reported agent activity {usageDate(counts?.userLastActivityDateUtc)}</p><UsageReportContext reports={detail.reports} inlineSources /></> : null}
        {panel === "usage" ? <>{!reportCurrent ? <p>Showing saved report evidence, not verified current activity.</p> : null}
          <ReportedUserAgents path={`${path}/agents`} selectionId={selectionId} filters={filters} onFocusAgent={onFocusAgent} onRestartSelection={onRestartSelection} />
          <section className="user-detail-card" aria-label="User Office app activity"><h3>Copilot in Office apps</h3>{directory?.appActivity ? <><p>{detail.sources.app_activity.period} report refreshed {usageDate(directory.appActivity.reportRefreshDate)}; {detail.sources.app_activity.state}</p>
            <dl className="user-profile-grid">{(Object.keys(appLabels) as Array<keyof typeof appLabels>).map(key => <div key={key}><dt>{appLabels[key]}</dt><dd>{usageDate(directory.appActivity?.[key])}</dd></div>)}</dl></> : <p>Office app activity is unavailable for this user.</p>}</section></> : null}
        {panel === "licenses" ? directory ? <CopilotServiceDetails path={`${path}/service-plans`} selectionId={selectionId}
          copilotServiceState={directory.copilotServiceState} current={current} onRestartSelection={onRestartSelection} /> : <p>Detailed license assignments are unavailable for this report identity.</p> : null}
        {panel === "responsibility" ? <UserAgentResponsibility compact objectId={current ? directory?.directory.objectId : undefined}
          dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} /> : null}
        {panel === "purview" ? <UserPurviewAudit active={tab === "purview"} userPrincipalName={current ? directory?.directory.userPrincipalName : undefined} /> : null}
      </> : null}
    </section>)}
  </dialog>;
}
