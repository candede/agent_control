import type { AuthenticatedUser } from "../types/session.js";
import { powerPlatformResourceTypes, type InventoryRoleScope, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";

export const inventoryProviderRoleIds = {
  globalAdministrator: "62e90394-69f5-4237-9190-012177145e10",
  powerPlatformAdministrator: "11648597-926c-4cf3-9c36-bcebb0ba8dcc",
  dynamics365Administrator: "44367163-eba1-44c3-98af-f5787879f96a",
  globalReader: "f2ef992c-3afb-46b9-b7cf-a126ee74c451",
  aiAdministrator: "d2562ede-74db-457e-a7b6-544e236ebb61",
  aiReader: "1fe13547-53f6-408d-ac04-7f8eed167b38",
} as const;

const fullRoleIds = new Set<string>([
  inventoryProviderRoleIds.globalAdministrator,
  inventoryProviderRoleIds.powerPlatformAdministrator,
  inventoryProviderRoleIds.dynamics365Administrator,
  inventoryProviderRoleIds.globalReader,
]);
const aiRoleIds = new Set<string>([inventoryProviderRoleIds.aiAdministrator, inventoryProviderRoleIds.aiReader]);
const relevantRoleIds = new Set<string>([...fullRoleIds, ...aiRoleIds]);
const aiResourceTypes = new Set<PowerPlatformResourceType>([
  "microsoft.powerapps/codeapps",
  "microsoft.powerapps/apps",
  "microsoft.powerautomate/agentflows",
  "microsoft.powerautomate/m365agentflows",
  "microsoft.copilotstudio/agents",
  "microsoft.powerplatform/environments",
  "microsoft.powerplatform/environmentgroups",
]);

export function normalizeInventoryProviderRoleIds(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) return [];
  return [...new Set(value.filter((roleId): roleId is string => typeof roleId === "string" && relevantRoleIds.has(roleId.toLowerCase())).map(roleId => roleId.toLowerCase()))].sort(ordinal);
}

export function inventoryRoleScope(user: Pick<AuthenticatedUser, "providerRoleIds">): InventoryRoleScope {
  const roleIds = new Set(normalizeInventoryProviderRoleIds(user.providerRoleIds));
  if ([...roleIds].some(roleId => fullRoleIds.has(roleId))) return "full";
  if ([...roleIds].some(roleId => aiRoleIds.has(roleId))) return "ai";
  return "unknown";
}

export function resourceTypesForInventoryScope(scope: InventoryRoleScope) {
  return scope === "ai" ? powerPlatformResourceTypes.filter(type => aiResourceTypes.has(type)) : [...powerPlatformResourceTypes];
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}