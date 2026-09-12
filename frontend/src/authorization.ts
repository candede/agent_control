import type { AppRole, SessionUser } from "./api/client";
import { hasAppRole } from "../../backend/src/types/capability";
import type { WorkbenchViewId } from "./workbenchRouting";

export function hasRole(user: SessionUser | undefined, role: AppRole) {
  return user ? hasAppRole(user.roles, role) : false;
}

export function allowedViews(user: SessionUser | undefined): WorkbenchViewId[] {
  if (!hasRole(user, "AgentControl.Viewer")) return ["permissions"];
  return [
    "agents",
    "power-platform",
    "users",
    "official-usage",
    "audit",
    "security",
    "permissions",
    "jobs",
  ];
}