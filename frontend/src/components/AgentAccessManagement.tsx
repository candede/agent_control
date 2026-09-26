import { useState } from "react";
import type { CopilotPackage, CopilotPackageDetail, PackageAccessTarget, PackageAccessUpdate } from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { AccessAssignmentEditor } from "./AccessAssignmentModal";

type Props = {
  agent: CopilotPackage;
  detail?: CopilotPackageDetail;
  canManage: boolean;
  canEditAccess: boolean;
  active: boolean;
  busy: boolean;
  loading: boolean;
  revision: number;
  showName: boolean;
  onUpdate: (agent: CopilotPackage, update: PackageAccessUpdate) => Promise<void>;
  onSetBlocked: (agent: CopilotPackage, blocked: boolean) => void;
};

export function AgentAccessManagement({ agent, detail, canManage, canEditAccess, active, busy, loading, revision, showName, onUpdate, onSetBlocked }: Props) {
  const [initialDetail, setInitialDetail] = useState(detail);
  const [previousRevision, setPreviousRevision] = useState(revision);
  if (previousRevision !== revision) {
    setPreviousRevision(revision);
    setInitialDetail(detail);
  } else if (!initialDetail && detail) setInitialDetail(detail);
  const initial = canEditAccess ? initialDetail ?? detail : detail ?? initialDetail;
  const readOnlyKey = !canEditAccess ? JSON.stringify([initial?.availableTo, initial?.deployedTo, initial?.allowedUsersAndGroups, initial?.acquireUsersAndGroups]) : "";
  const [target, setTarget] = useState<PackageAccessTarget>("availability");
  const [reset, setReset] = useState({ availability: 0, installation: 0 });
  const isBlocked = detail?.isBlocked ?? agent.isBlocked;

  return <section className="agent-access-management" aria-label={`Manage ${agent.displayName} (${agent.id})`}>
    <div className="agent-access-heading">
      <div>
        {showName ? <h4>{agent.displayName}</h4> : null}
        <p>{agent.version ? `Version ${agent.version}` : "Published version"}{agent.publisher ? ` / ${agent.publisher}` : ""}</p>
        <details><summary>Version details</summary><code className="agent-control-target">{agent.id}</code></details>
      </div>
      <div className="agent-block-control" role="group" aria-label={`Blocking for ${agent.id}`}>
        <strong>{isBlocked === true ? "Blocked" : isBlocked === false ? "Not blocked" : "Block status unknown"}</strong>
        {canManage && typeof isBlocked === "boolean" ? <WorkbenchActionGate actionId={isBlocked ? "packages.unblock" : "packages.block"} compact>
          <button type="button" className={isBlocked ? "secondary" : "danger"} disabled={busy}
            aria-label={`${isBlocked ? "Unblock" : "Block"} ${agent.displayName} (${agent.id})`}
            onClick={() => onSetBlocked(agent, !isBlocked)}>{isBlocked ? "Unblock" : "Block"}</button>
        </WorkbenchActionGate> : null}
      </div>
    </div>
    {(["availability", "installation"] as const).map(setting => <div key={setting} hidden={target !== setting}>
      <AccessAssignmentEditor
        key={`${revision}:${initial ? "detail" : "summary"}:${readOnlyKey}:${reset[setting]}`}
        initialTarget={setting}
        initialStatus={setting === "availability" ? initial?.availableTo ?? agent.availableTo : initial?.deployedTo ?? agent.deployedTo}
        initialPrincipals={setting === "availability" ? initial?.allowedUsersAndGroups : initial?.acquireUsersAndGroups}
        active={active && target === setting}
        readOnly={!canEditAccess || loading}
        busy={busy}
        onTargetChange={setTarget}
        onCancel={() => setReset(current => ({ ...current, [setting]: current[setting] + 1 }))}
        onSubmit={update => onUpdate(agent, update)}
      />
    </div>)}
  </section>;
}
