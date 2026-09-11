/* eslint-disable react-refresh/only-export-components */
import { cloneElement, createContext, useContext, useId, type ButtonHTMLAttributes, type ReactElement } from "react";
import type { WorkbenchActionDefinition } from "../../backend/src/types/workbench";
import { CapabilityGate } from "./components/CapabilityGate";

const WorkbenchActionContext = createContext<readonly WorkbenchActionDefinition[] | undefined>(undefined);

export const WorkbenchActionProvider = WorkbenchActionContext.Provider;

export function WorkbenchActionGate({ actionId, children, compact = false }: { actionId: string; children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>; compact?: boolean }) {
  const actions = useContext(WorkbenchActionContext);
  const explanationId = useId();
  if (!actions) {
    return <DisabledAction explanationId={explanationId} compact={compact} explanation="Action metadata is unavailable. Actions remain disabled until the signed-in workbench finishes loading." children={children} />;
  }
  const action = actions.find(candidate => candidate.id === actionId);
  if (!action) {
    return <DisabledAction explanationId={explanationId} compact={compact} explanation="This action is not defined by the current signed-in workbench metadata. Reload before retrying." children={children} />;
  }
  return <CapabilityGate
    capability={action.capabilityId ?? undefined}
    roles={action.roles}
    write={action.preview === "required"}
    compact={compact}
  >{children}</CapabilityGate>;
}

function DisabledAction({
  children,
  compact,
  explanation,
  explanationId,
}: {
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
  compact: boolean;
  explanation: string;
  explanationId: string;
}) {
  return <span className={`capability-gate blocked${compact ? " capability-gate-compact" : ""}`}>
    {cloneElement(children, {
      "aria-describedby": explanationId,
      "aria-disabled": true,
      disabled: true,
      onClick: undefined,
      title: compact ? explanation : children.props.title,
    })}
    <small className={compact ? "sr-only" : undefined} id={explanationId}>{explanation}</small>
  </span>;
}

export function useWorkbenchAction(actionId: string) {
  return useContext(WorkbenchActionContext)?.find(action => action.id === actionId);
}
