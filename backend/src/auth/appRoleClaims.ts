import { AppError } from "../errors.js";
import { isAppRole } from "../services/capabilityRegistry.js";
import type { AppRole } from "../types/capability.js";

export function appRoleClaims(value: unknown): AppRole[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some(role => !isAppRole(role))) {
    throw AppError.unauthorized("Microsoft Entra ID returned invalid application roles.");
  }
  return [...new Set(value.filter(isAppRole))].sort();
}
