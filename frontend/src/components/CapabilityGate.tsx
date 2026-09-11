import { cloneElement, useId, type ButtonHTMLAttributes, type ReactElement } from "react";
import { ShieldCheck } from "lucide-react";
import type { AppRole, CapabilityId } from "../api/client";
import { capabilityExplanation, providerActionAllowed } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";

export function CapabilityGate({ capability, roles, write = false, compact = false, children }: {
  capability?: CapabilityId; roles?: AppRole[]; write?: boolean; compact?: boolean;
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const context = useCapabilityContext();
  const descriptionId = useId();
  const view = context.views.find(item => item.definition.id === capability);
  const roleAllowed = !roles || roles.some(role => context.user?.roles.includes(role));
  const allowed = roleAllowed && (!capability || providerActionAllowed(view, write, context.now));
  const explanation = !roleAllowed ? `Requires ${roles!.join(" or ")}.` : view ? capabilityExplanation(view, context.now)
    : context.loading ? "Checking capability status." : "Capability status is unavailable. Open Permissions to retry.";
  return <span className={`capability-gate${compact ? " capability-gate-compact" : ""}`}>
    {cloneElement(children, { disabled: children.props.disabled || !allowed, title: compact && !allowed ? explanation : children.props.title, "aria-describedby": !allowed ? descriptionId : children.props["aria-describedby"] })}
    {!allowed && (compact ? <span className="sr-only" id={descriptionId}>{explanation}</span> : <span className="gate-explanation" id={descriptionId}>
      <span>{explanation}</span>
      <button type="button" className="permission-link" onClick={context.openPermissions} aria-label={`Permissions: ${view?.definition.displayName ?? "required access"}`}><ShieldCheck size={16} aria-hidden="true" /> Permissions</button>
    </span>)}
  </span>;
}