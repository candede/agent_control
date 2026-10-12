import { useState } from "react";
import { isWritablePackageAccessScope } from "../../../backend/src/types/copilotPackage";
import type { CopilotPackage, CopilotPackageDetail, PackageAccessTarget, PackageAccessUpdate } from "../api/client";
import { getInitialAccessScope } from "../accessScope";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { AccessAssignmentEditor } from "./AccessAssignmentModal";

type Props = {
  agent: CopilotPackage;
  detail?: CopilotPackageDetail;
  detailUnavailable?: boolean;
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

export function AgentAccessManagement({ agent, detail, detailUnavailable = false, canManage, canEditAccess, active, busy, loading, revision, showName, onUpdate, onSetBlocked }: Props) {
  const [initialDetail, setInitialDetail] = useState(detail);
  const accessReadError = (detail ?? initialDetail)?.accessReadError;
  const readOnly = !canEditAccess || Boolean(accessReadError);
  const [previousRevision, setPreviousRevision] = useState(revision);
  if (previousRevision !== revision) {
    setPreviousRevision(revision);
    setInitialDetail(detail);
  } else if (detailUnavailable) {
    if (initialDetail) setInitialDetail(undefined);
  } else if (detail && (!initialDetail || (readOnly || initialDetail.accessReadError) && initialDetail !== detail)) setInitialDetail(detail);
  const initial = readOnly ? detail ?? initialDetail : initialDetail ?? detail;
  const readOnlyKey = readOnly ? JSON.stringify([initial?.availableTo, initial?.deployedTo, initial?.allowedUsersAndGroups, initial?.acquireUsersAndGroups]) : "";
  const [target, setTarget] = useState<PackageAccessTarget>("availability");
  const [reset, setReset] = useState({ availability: 0, installation: 0 });
  const isBlocked = detail?.isBlocked ?? agent.isBlocked;

  return <section className="agent-access-management" aria-label={`Manage ${agent.displayName} (${agent.id})`}>
    <div className="agent-access-heading">
      <div>
        {showName ? <h4>{agent.displayName}</h4> : null}
        <p>{agent.version ? `Version ${agent.version}` : "Published version"}{agent.publisher ? ` / ${agent.publisher}` : ""}</p>
        <p>Package ID: <code className="agent-control-target">{agent.id}</code></p>
      </div>
      <div className="agent-block-control" role="group" aria-label={`Blocking for ${agent.id}`}>
        <strong>{isBlocked === true ? "Blocked" : isBlocked === false ? "Not blocked" : "Block status unknown"}</strong>
        {canManage && typeof isBlocked === "boolean" ? <WorkbenchActionGate actionId={isBlocked ? "packages.unblock" : "packages.block"} compact>
          <button type="button" className={isBlocked ? "secondary" : "danger"} disabled={busy || !active || loading}
            aria-label={`${isBlocked ? "Unblock" : "Block"} ${agent.displayName} (${agent.id})`}
            onClick={() => onSetBlocked(agent, !isBlocked)}>{isBlocked ? "Unblock" : "Block"}</button>
        </WorkbenchActionGate> : null}
      </div>
    </div>
    {accessReadError ? <p role="status">{accessReadError} Access assignment editing is unavailable.</p> : null}
    {(["availability", "installation"] as const).map(setting => {
      const observed = detail ?? initial;
      const preservedStatus = setting === "availability" ? observed?.deployedTo : observed?.availableTo;
      const preservedPrincipals = setting === "availability" ? observed?.acquireUsersAndGroups : observed?.allowedUsersAndGroups;
      const preservationUnavailable = preservedPrincipals !== undefined
        && getInitialAccessScope(preservedStatus, preservedPrincipals) !== undefined
        && !isWritablePackageAccessScope(preservedStatus, preservedPrincipals);
      const unavailableReason = preservationUnavailable
        ? `${setting === "availability" ? "Availability" : "Installation"} editing is unavailable because Microsoft Graph's collection-only PATCH cannot preserve the saved ${setting === "availability" ? "installation" : "availability"} scope and assignments. Review both access settings.`
        : undefined;
      return <div key={setting} hidden={target !== setting}>
        {!readOnly && unavailableReason ? <p role="status">{unavailableReason}</p> : null}
        <AccessAssignmentEditor
          key={`${revision}:${initial ? "detail" : "summary"}:${readOnlyKey}:${reset[setting]}`}
          initialTarget={setting}
          initialStatus={setting === "availability" ? initial?.availableTo ?? agent.availableTo : initial?.deployedTo ?? agent.deployedTo}
          initialPrincipals={setting === "availability" ? initial?.allowedUsersAndGroups : initial?.acquireUsersAndGroups}
          active={active && !loading && target === setting}
          readOnly={readOnly}
          unavailableReason={unavailableReason}
          busy={busy}
          onTargetChange={setTarget}
          onCancel={() => {
            if (detail) setInitialDetail(detail);
            setReset(current => ({ ...current, [setting]: current[setting] + 1 }));
          }}
          onSubmit={update => onUpdate(agent, update)}
        />
      </div>;
    })}
  </section>;
}
