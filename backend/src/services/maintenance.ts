import { statSync } from "node:fs";
import { AppError } from "../errors.js";

let draining = false;
export function enterMaintenance() { draining = true; }
export function maintenanceActive() {
  if (draining || process.env.MAINTENANCE_MODE === "true") return true;
  const marker = process.env.MAINTENANCE_FILE;
  if (!marker) return false;
  try {
    statSync(marker);
    return true;
  } catch (error) {
    // An unreadable marker must not reopen admissions.
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}
export function requireAdmissions() {
  if (maintenanceActive()) throw new AppError(503, "maintenance", "Maintenance is active; new work is not accepted.");
}