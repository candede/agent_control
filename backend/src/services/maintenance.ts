import { existsSync } from "node:fs";
import { AppError } from "../errors.js";

let draining = false;
export function enterMaintenance() { draining = true; }
export function maintenanceActive() {
  return draining || process.env.MAINTENANCE_MODE === "true" || Boolean(process.env.MAINTENANCE_FILE && existsSync(process.env.MAINTENANCE_FILE));
}
export function requireAdmissions() {
  if (maintenanceActive()) throw new AppError(503, "maintenance", "Maintenance is active; new work is not accepted.");
}