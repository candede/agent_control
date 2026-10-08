/* eslint-disable react-refresh/only-export-components */
import { cloneElement, createContext, useContext, useId, type ButtonHTMLAttributes, type ReactElement } from "react";
import type { WorkbenchActionDefinition } from "../../backend/src/types/workbench";
import { CapabilityGate } from "./components/CapabilityGate";

const WorkbenchActionContext = createContext<readonly WorkbenchActionDefinition[] | undefined>(undefined);

export const WorkbenchActionProvider = WorkbenchActionContext.Provider;

export function findWorkbenchAction(actions: readonly WorkbenchActionDefinition[] | undefined, actionId: string) {
  const matches = actions?.filter(action => action.id === actionId);
  return matches?.length === 1 ? matches[0] : undefined;
}

export function WorkbenchActionGate({ actionId, children, compact = false }: { actionId: string; children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>; compact?: boolean }) {
  const actions = useContext(WorkbenchActionContext);
  const explanationId = useId();
  if (!actions) {
    return <DisabledAction explanationId={explanationId} compact={compact} explanation="Action metadata is unavailable. Actions remain disabled without current signed-in workbench metadata." children={children} />;
  }
  const action = findWorkbenchAction(actions, actionId);
  if (!action) {
    const explanation = actions.some(candidate => candidate.id === actionId)
      ? "This action is defined more than once by the current signed-in workbench metadata. Actions remain disabled until the metadata is corrected."
      : "This action is not defined by the current signed-in workbench metadata. Reload before retrying.";
    return <DisabledAction explanationId={explanationId} compact={compact} explanation={explanation} children={children} />;
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
      "aria-describedby": [children.props["aria-describedby"], explanationId].filter(Boolean).join(" "),
      "aria-disabled": true,
      disabled: true,
      onClick: event => { event.preventDefault(); event.stopPropagation(); },
      title: compact ? explanation : children.props.title,
    })}
    <small className={compact ? "sr-only" : undefined} id={explanationId}>{explanation}</small>
  </span>;
}

export function useWorkbenchAction(actionId: string) {
  return findWorkbenchAction(useContext(WorkbenchActionContext), actionId);
}
