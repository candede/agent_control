import type pg from "pg";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { maintenanceActive } from "./maintenance.js";

export type OperationalState = {
  mode: "normal" | "maintenance";
  providerWorkEnabled: boolean;
  restoredFromAt: string | null;
  deletionReviewedAt: string | null;
  accessReviewedAt: string | null;
};

let loadedState: OperationalState = {
  mode: "normal",
  providerWorkEnabled: true,
  restoredFromAt: null,
  deletionReviewedAt: null,
  accessReviewedAt: null,
};

export async function readOperationalState(database: Pick<pg.Pool, "query"> = pool): Promise<OperationalState> {
  const result = await database.query(`SELECT mode,provider_work_enabled,restored_from_at,deletion_reviewed_at,access_reviewed_at
    FROM operational_state WHERE singleton=true`);
  if (result.rowCount !== 1) throw new Error("Operational state is missing.");
  const row = result.rows[0];
  return {
    mode: row.mode,
    providerWorkEnabled: row.provider_work_enabled,
    restoredFromAt: row.restored_from_at?.toISOString() ?? null,
    deletionReviewedAt: row.deletion_reviewed_at?.toISOString() ?? null,
    accessReviewedAt: row.access_reviewed_at?.toISOString() ?? null,
  };
}

export async function loadOperationalState(database: Pick<pg.Pool, "query"> = pool) {
  loadedState = await readOperationalState(database);
  return loadedState;
}

export function requireProviderAdmissions() {
  if (maintenanceActive() || loadedState.mode !== "normal") {
    throw new AppError(503, "maintenance", "Maintenance is active; provider work is not accepted.");
  }
  if (!loadedState.providerWorkEnabled) {
    throw new AppError(503, "provider_requalification_required", "Provider work remains disabled until restored access is reviewed and explicitly requalified.");
  }
}

export function providerWorkEnabled() {
  return loadedState.mode === "normal" && loadedState.providerWorkEnabled;
}
