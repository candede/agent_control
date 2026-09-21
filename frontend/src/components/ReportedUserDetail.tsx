import { useEffect, useId, useRef, type RefObject } from "react";
import { X } from "lucide-react";
import type { CopilotUsageUser, OfficialUsageUserSummary } from "../api/client";
import { usageCount, usageDate } from "../usageInsights";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";
import { ReportedUserAgents, type UserRelationshipFilters } from "./ReportedUserAgents";

export function ReportedUserDetail({ user, directoryUser, hasRelationships, filters, returnFocusTo, onClose, onFocusAgent }: {
  user: OfficialUsageUserSummary;
  directoryUser?: CopilotUsageUser | null;
  hasRelationships: boolean;
  filters: UserRelationshipFilters;
  returnFocusTo: RefObject<HTMLInputElement | null>;
  onClose: () => void;
  onFocusAgent: (agentId: string, reportSetId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallbackFocus = returnFocusTo.current;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    closeButton.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      (previousFocus?.isConnected ? previousFocus : fallbackFocus)?.focus();
    };
  }, [returnFocusTo]);

  return <dialog ref={dialog} className="copilot-user-dialog reported-user-dialog" aria-labelledby={titleId}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div><h2 id={titleId}>{user.displayName || user.username}</h2><p>{user.username}</p></div>
      <button ref={closeButton} type="button" className="secondary icon-button" aria-label="Close reported user details" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <dl className="reported-user-facts" aria-label="Reported user totals">
      <div><dt>Responses (Users report)</dt><dd>{usageCount(user.missingUserReport ? null : user.reportedResponsesReceived)}</dd></div>
      <div><dt>Agents used (Users report)</dt><dd>{usageCount(user.missingUserReport ? null : user.reportedAgentsUsed)}</dd></div>
      <div><dt>User last activity (Users report)</dt><dd>{usageDate(user.userLastActivityDateUtc)}</dd></div>
      <div><dt>M365 Copilot license</dt><dd><CopilotLicenseStatus user={directoryUser} /></dd></div>
      <div><dt>Directory account</dt><dd>{directoryUser?.directory.accountEnabled === false ? "Account disabled" : directoryUser?.directory.accountEnabled === true ? "Enabled" : "Unknown"}</dd></div>
      <div><dt>Responses (all Users &amp; agents rows)</dt><dd>{hasRelationships && user.rows.length ? usageCount(user.bridgeResponsesSentToUsers) : "Not reported"}</dd></div>
    </dl>
    {directoryUser ? <CopilotServiceDetails servicePlans={directoryUser.servicePlans} current /> : null}
    <p className="reported-users-note">Users-report totals cover all agents, regardless of the selected relationship filters. The Users &amp; agents sum is independent evidence, not a replacement for a missing Users total.</p>
    {user.missingUserReport ? <p className="copilot-users-notice">This identity has no Users-report row. Its response total, agents used and user recency are unknown.</p>
      : user.hasReportMismatch ? <p className="copilot-users-notice">Report totals differ. The Users total and Users &amp; agents breakdown are shown separately, never added or reconciled by guessing.</p> : null}
    <ReportedUserAgents user={user} filters={filters} onFocusAgent={onFocusAgent} />
    <details className="copilot-users-provenance">
      <summary>Identity and report coverage</summary>
      <p>Dataset {user.datasetScope.reportSetId ?? "unavailable"}; Users version {user.datasetScope.usersVersionId ?? "absent"}; Users &amp; agents version {user.datasetScope.userAgentsVersionId ?? "absent"}.</p>
      <p>Concealed and case-distinct identities are scoped to this report, not matched by display name. Current license status requires a unique, exact saved directory link to these report versions and effective paid-feature state. Current entitlement does not establish activity or coverage during the reporting period. License not verified does not mean basic or unlicensed.</p>
      <p>{hasRelationships ? `${user.rows.length.toLocaleString()} reported agent relationships.` : "Users & agents companion missing: relationships are unknown, not zero."}</p>
    </details>
  </dialog>;
}
