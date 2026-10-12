import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type pg from "pg";
import { AppError } from "../errors.js";
import { DataGenerations } from "../db/dataGenerations.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { appRoles, hasAppRole } from "../types/capability.js";
import { normalizeInventoryProviderRoleIds } from "./inventoryRoleScope.js";

function ownValue(value: object, key: string) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) return undefined;
  if (!Object.hasOwn(property, "value")) throw AppError.unauthorized();
  return property.value as unknown;
}
function identityText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\p{Cc}\p{Cs}]/u.test(value)) throw AppError.unauthorized();
  return value;
}
function roleValues(value: unknown): string[] {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw AppError.unauthorized();
  const length = ownValue(value, "length");
  if (typeof length !== "number" || length > 64 || Reflect.ownKeys(value).length !== length + 1) throw AppError.unauthorized();
  const roles: string[] = [];
  for (let index = 0; index < length; index++) roles.push(identityText(ownValue(value, String(index)), 512));
  return roles;
}

export async function reportIdentity(database: pg.Pool, user: AuthenticatedUser): Promise<SelectionIdentity> {
  if (isProxy(user) || !user || typeof user !== "object"
    || Object.getPrototypeOf(user) !== Object.prototype && Object.getPrototypeOf(user) !== null) throw AppError.unauthorized();
  const tenantId = identityText(ownValue(user, "tenantId"), 512), principalId = identityText(ownValue(user, "homeAccountId"), 1024);
  const suppliedRoles = roleValues(ownValue(user, "roles"));
  if (suppliedRoles.some(role => !appRoles.some(allowed => allowed === role))) throw AppError.unauthorized();
  const roles = appRoles.filter(role => suppliedRoles.includes(role)).sort();
  if (!hasAppRole(roles, "AgentControl.Viewer")) throw AppError.unauthorized();
  const suppliedProviderRoles = ownValue(user, "providerRoleIds");
  const providerRoles = normalizeInventoryProviderRoleIds(suppliedProviderRoles === undefined ? [] : roleValues(suppliedProviderRoles));
  const authorizationHash = createHash("sha256").update(JSON.stringify({
    tenantId, principalId, roles, providerRoles, tokenMode: "delegated",
  })).digest("hex");
  const sessionEpoch = await new DataGenerations(database).sessionEpoch(tenantId, principalId);
  return Object.freeze({ tenantId, principalId, sessionEpoch, authorizationHash });
}
