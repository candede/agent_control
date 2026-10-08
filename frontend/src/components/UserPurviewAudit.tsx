import { useContext, useState } from "react";
import { hasRole } from "../authorization";
import { CapabilityContext } from "../capabilityContext";
import { PurviewAuditView } from "./PurviewAuditView";
import { DefenderHuntingView } from "./DefenderHuntingView";
import { AgentInvestigationsPanel } from "./AgentInvestigationsPanel";

export function UserPurviewAudit({ userPrincipalName, userObjectId, agent, active = true }: {
  userPrincipalName?: string; userObjectId?: string; agent?: { recordId: string; name: string }; active?: boolean;
}) {
  const capability = useContext(CapabilityContext);
  const [source, setSource] = useState<"purview" | "defender">("purview");
  const available = Boolean(userPrincipalName && hasRole(capability?.user, "AgentControl.Viewer"));
  if (!userPrincipalName) return <p>A verified directory user is required to search logs.</p>;
  if (!available) return <p>Viewer access is required to search logs.</p>;
  if (agent) return userObjectId
    ? <AgentInvestigationsPanel recordId={agent.recordId} agentName={agent.name} roles={capability?.user?.roles ?? []}
      user={{ objectId: userObjectId, userPrincipalName }} active={active} />
    : <p>A verified directory user is required to search this user's agent logs.</p>;
  return <section aria-label="User logs">
    <label className="agent-log-source-picker"><span>Source</span><select value={source} onChange={event => setSource(event.target.value as typeof source)}>
      <option value="purview">Purview audit</option><option value="defender">Defender</option>
    </select></label>
    <PurviewAuditView userPrincipalName={userPrincipalName} active={active && source === "purview"} />
    {userObjectId ? <DefenderHuntingView userObjectId={userObjectId} active={active && source === "defender"} />
      : source === "defender" ? <p>A verified directory object ID is required for Defender user logs.</p> : null}
  </section>;
}
