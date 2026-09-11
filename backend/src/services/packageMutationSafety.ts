import { AppError } from "../errors.js";
import type { AuditAction } from "../types/audit.js";

export function packageMutationOperationSafe(action: AuditAction) {
  return action === "block" || action === "unblock";
}

export function requirePackageMutationOperationSafe(action: AuditAction) {
  if (packageMutationOperationSafe(action)) return;
  const message = action === "reassign"
    ? "Reassignment remains disabled because Microsoft Graph exposes no documented owner read-back field or conditional write contract."
    : "Package access changes remain disabled because the documented beta endpoint exposes no If-Match or equivalent lost-update bound.";
  throw new AppError(409, "package_operation_safety_unavailable", message);
}