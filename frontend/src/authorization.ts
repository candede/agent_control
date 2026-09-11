import type { AppRole, SessionUser } from "./api/client";
import type { WorkbenchViewId } from "./workbenchRouting";

export function hasRole(user: SessionUser | undefined, role: AppRole) {
  return user?.roles.includes(role) ?? false;
}

export function allowedViews(user: SessionUser | undefined) {
  const views: WorkbenchViewId[] = [];
  if (hasRole(user, "AgentControl.Reader") || hasRole(user, "AgentControl.Operator")) views.push("agents");
  if (hasRole(user, "AgentControl.Reader") || hasRole(user, "AgentControl.Operator")) views.push("power-platform");
  if (hasRole(user, "AgentControl.SecurityReader")) views.push("users");
  if (hasRole(user, "AgentControl.Reader") || hasRole(user, "AgentControl.Administrator")) views.push("official-usage");
  if (hasRole(user, "AgentControl.SecurityReader")) views.push("audit");
  if (hasRole(user, "AgentControl.SecurityReader")) views.push("security");
  views.push("permissions", "jobs");
  return views;
}