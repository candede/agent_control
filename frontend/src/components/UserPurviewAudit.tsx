import { useContext, useState } from "react";
import { hasRole } from "../authorization";
import { CapabilityContext } from "../capabilityContext";
import { PurviewAuditView } from "./PurviewAuditView";

export function UserPurviewAudit({ userPrincipalName }: { userPrincipalName?: string }) {
  const capability = useContext(CapabilityContext);
  const [openedFor, setOpenedFor] = useState<string>();
  const available = Boolean(userPrincipalName && hasRole(capability?.user, "AgentControl.Viewer"));
  const open = available && openedFor === userPrincipalName;
  return <section aria-label="User Purview audit">
    <h3>Purview audit</h3>
    <p>Search timestamped audit metadata for this user. This is separate from usage totals and contains no prompt or response text.</p>
    {!userPrincipalName ? <p>A verified directory user principal name is required. Report-only or concealed identities cannot be used for audit searches.</p>
      : !available ? <p>Viewer access is required to search Purview audit records.</p>
        : <button type="button" className="secondary" aria-expanded={open} onClick={() => setOpenedFor(open ? undefined : userPrincipalName)}>
          {open ? "Close Purview audit search" : "Open Purview audit search"}
        </button>}
    {open ? <PurviewAuditView initialUserPrincipalName={userPrincipalName} /> : null}
  </section>;
}
