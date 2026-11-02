import { useRef, useState, type RefObject } from "react";
import { officeApps } from "../../../backend/src/types/officeAppAdoption";
import { useOfficePerson, type AcceptedOfficePerson, type OfficeReadOwner } from "../useOfficeAdoption";
import { usageDate } from "../usageInsights";
import { WorkbenchDialog } from "./WorkbenchDialog";
import { ReportReadStatus } from "./ReportPageControls";
import { UserDetailModal } from "./UserDetailModal";

export function OfficePersonDialog({ owner, identity, groupId, accepted, onClose, revision, returnFocusTo }: {
  owner: OfficeReadOwner; identity: string; groupId: string; onClose: () => void; revision: number;
  accepted?: AcceptedOfficePerson;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const read = useOfficePerson(owner, groupId, identity, accepted);
  const person = read.data?.value;
  const profileOwner = JSON.stringify([owner.principal, identity]);
  const [currentProfile, setCurrentProfile] = useState<string>();
  if (currentProfile !== undefined && currentProfile !== profileOwner) setCurrentProfile(undefined);
  const profileTrigger = useRef<HTMLButtonElement>(null);
  return <WorkbenchDialog open title={person?.displayName || person?.userPrincipalName || "Office person evidence"}
    description="Frozen Office evidence from the selected observation; current user information is separate." onClose={onClose} fallbackFocusRef={returnFocusTo}>
    <ReportReadStatus read={read} />
    {person ? <section aria-label="Frozen Office person evidence">
      <h3>Office evidence at capture</h3>
      <p>{person.userPrincipalName} · {person.company ?? "Company not provided"} / {person.department ?? "Department not provided"}</p>
      <dl className="office-person-facts">
        <dt>Selected provider refresh</dt><dd>{usageDate(owner.context?.observation?.reportRefreshDate)}</dd>
        <dt>Paid eligibility at capture</dt><dd>{person.entitlement.replaceAll("_", " ")} · {person.serviceState.replaceAll("_", " ")}</dd>
        <dt>Directory observed</dt><dd>{usageDate(person.directoryObservedAt)}</dd>
        <dt>App evidence observed</dt><dd>{person.appObservedAt ? usageDate(person.appObservedAt) : "Unknown"}</dd>
        <dt>App evidence provider refresh</dt><dd>{person.appReportRefreshDate ? usageDate(person.appReportRefreshDate) : "Unknown"}</dd>
        <dt>Apps used recently</dt><dd>{person.recentApps.length} of 7</dd>
        <dt>Latest qualifying Office date</dt><dd>{person.latestRecentDate ? usageDate(person.latestRecentDate) : "No qualifying recent date"}</dd>
        <dt>Evidence gaps</dt><dd>{person.unknownReasons.length ? person.unknownReasons.map(reason => reason.replaceAll("_", " ")).join(", ") : "None reported"}</dd>
      </dl>
      <ul className="office-person-app-dates" aria-label="Frozen seven-app dates">{officeApps.map(app => <li key={app.id}>
        <span>{app.label}</span><span>{person.dates[app.id] ? usageDate(person.dates[app.id]) : "No date reported"}</span>
        <small>{person.recentApps.includes(app.id) ? "Qualifying recent evidence" : person.dates[app.id]
          ? "Not qualifying in this observation (older, future, or unavailable evidence)" : "Unknown; not proof of never using this app"}</small>
      </li>)}</ul>
      <p className="dashboard-panel-note">These saved dates, paid features, groups and suggestions are not recalculated from today's profile, licenses or agent reports.
        Unknown evidence overlaps no recent evidence and does not establish inactivity.</p>
      <button ref={profileTrigger} type="button" className="secondary" onClick={() => setCurrentProfile(profileOwner)}>
        Open separate current profile, licenses and agent evidence</button>
      {currentProfile === profileOwner ? <UserDetailModal identity={identity} kind="directory" returnFocusTo={profileTrigger}
        closeLabel="Close current profile" onClose={() => setCurrentProfile(undefined)} dataRevision={revision} /> : null}
    </section> : null}
  </WorkbenchDialog>;
}
