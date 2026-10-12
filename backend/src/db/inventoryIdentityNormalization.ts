import { inventoryEnvironmentPattern, inventoryGuidPattern } from "../services/inventoryIdentity.js";

// Validation, canonicalization and identity equality must not inherit the database locale.
export function normalizeNativeIdentitySql(value: string) {
  return `(CASE WHEN length(${value})=36 AND ${value} COLLATE "C" ~* '${inventoryGuidPattern}' THEN lower(${value} COLLATE "C") ELSE ${value} END) COLLATE "C"`;
}

export function normalizeEnvironmentIdentitySql(value: string) {
  return `(CASE WHEN length(${value}) IN (36,44) AND ${value} COLLATE "C" ~* '${inventoryEnvironmentPattern}' THEN lower(${value} COLLATE "C") ELSE ${value} END) COLLATE "C"`;
}

export function normalizeInventoryIdentifierSql(kind: string, value: string) {
  return `CASE WHEN ${kind} COLLATE "C" IN ('package_id','package_app_id','manifest_id','asset_id') THEN ${value}
    WHEN ${kind} COLLATE "C"='environment_id' THEN ${normalizeEnvironmentIdentitySql(value)}
    ELSE ${normalizeNativeIdentitySql(value)} END`;
}
