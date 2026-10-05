import { createHash } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { DataGenerations } from "../db/dataGenerations.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { hasAppRole } from "../types/capability.js";

export async function reportIdentity(database: pg.Pool, user: AuthenticatedUser): Promise<SelectionIdentity> {
  if (!user.tenantId || !user.homeAccountId || !hasAppRole(user.roles, "AgentControl.Viewer")) throw AppError.unauthorized();
  return {
    tenantId: user.tenantId, principalId: user.homeAccountId,
    sessionEpoch: await new DataGenerations(database).sessionEpoch(user.tenantId, user.homeAccountId),
    authorizationHash: createHash("sha256").update(JSON.stringify({
      tenantId: user.tenantId, principalId: user.homeAccountId,
      roles: [...user.roles].sort(), providerRoles: [...(user.providerRoleIds ?? [])].sort(), tokenMode: "delegated",
    })).digest("hex"),
  };
}
