import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactElement } from "react";
import { ShieldCheck } from "lucide-react";
import { supportsAutomaticCapabilityCheck } from "../../../backend/src/types/capability";
import type { AppRole, CapabilityId } from "../api/client";
import { hasRole } from "../authorization";
import { capabilityExplanation, providerActionAllowed } from "../capabilityState";
import { useCapabilityContext } from "../capabilityContext";

export function CapabilityGate({ capability, roles, write = false, compact = false, children }: {
  capability?: CapabilityId; roles?: AppRole[]; write?: boolean; compact?: boolean;
  children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  const context = useCapabilityContext();
  const descriptionId = useId();
  const action = {};
  const activeAction = useRef<object | undefined>(undefined);
  const [localNow, setLocalNow] = useState(Date.now);
  const now = Math.max(context.now, localNow);
  const view = context.views.find(item => item.definition.id === capability);
  const roleAllowed = !roles || roles.some(role => hasRole(context.user, role));
  const allowed = roleAllowed && (!capability || providerActionAllowed(view, write, now));
  const unchecked = !view || view.decision.status === "unknown" && !view.decision.checkedAt && !view.decision.evidence?.category;
  const checking = unchecked && (context.loading || context.pending && capability && supportsAutomaticCapabilityCheck(capability));
  const status = unchecked && context.error && (!view || supportsAutomaticCapabilityCheck(view.definition.id)) ? context.error : [
    view ? capabilityExplanation(view, now) : "Capability status is unavailable. Open Permissions to retry.",
    context.error,
  ].filter(Boolean).join(" ");
  const explanation = !roleAllowed ? `Requires ${roles!.join(" or ")}.` : checking
    ? context.loading ? "Loading capability status." : "Checking capability status."
    : status;
  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (activeAction.current !== action || children.props.disabled
      || children.props["aria-disabled"] === true || children.props["aria-disabled"] === "true" || !roleAllowed
      || capability && !providerActionAllowed(view, write, Math.max(now, Date.now()))) {
      event.preventDefault();
      event.stopPropagation();
      if (activeAction.current === action) setLocalNow(Date.now());
      return;
    }
    children.props.onClick?.(event);
  }
  // A retained event must not invoke a child from a retired render or session.
  useLayoutEffect(() => {
    activeAction.current = action;
    return () => { activeAction.current = undefined; };
  });
  const Button = children.type;
  return <span className={`capability-gate${compact ? " capability-gate-compact" : ""}`}>
    <Button {...children.props} key={children.key}
      disabled={children.props.disabled || !allowed}
      aria-disabled={children.props.disabled || !allowed ? true : children.props["aria-disabled"]}
      title={compact && !allowed ? explanation : children.props.title}
      aria-describedby={!allowed ? [children.props["aria-describedby"], descriptionId].filter(Boolean).join(" ") : children.props["aria-describedby"]}
      onClick={handleClick}
    />
    {!allowed && (compact ? <span className="sr-only" id={descriptionId}>{explanation}</span> : <span className="gate-explanation" id={descriptionId}>
      <span>{explanation}</span>
      <button type="button" className="permission-link" onClick={() => { if (activeAction.current === action) context.openPermissions(); }} aria-label={`Permissions: ${view?.definition.displayName ?? "required access"}`}><ShieldCheck size={16} aria-hidden="true" /> Permissions</button>
    </span>)}
  </span>;
}