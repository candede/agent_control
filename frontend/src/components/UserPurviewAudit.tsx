import { useContext } from "react";
import { hasRole } from "../authorization";
import { CapabilityContext } from "../capabilityContext";
import { PurviewAuditView } from "./PurviewAuditView";

export function UserPurviewAudit({ userPrincipalName, active = true }: { userPrincipalName?: string; active?: boolean }) {
  const capability = useContext(CapabilityContext);
  const available = Boolean(userPrincipalName && hasRole(capability?.user, "AgentControl.Viewer"));
  return <section aria-label="User Purview audit">
    {!userPrincipalName ? <><h3>Purview audit</h3><p>A verified directory user principal name is required for audit search.</p></>
      : !available ? <p>Viewer access is required to search Purview audit records.</p>
        : <PurviewAuditView userPrincipalName={userPrincipalName} active={active} />}
  </section>;
}
