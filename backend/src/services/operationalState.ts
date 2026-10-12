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

let loadedState: OperationalState | undefined;
let loadVersion = 0;
let appliedLoadVersion = 0;
let loadFailed = false;

export async function readOperationalState(database: Pick<pg.Pool, "query"> = pool): Promise<OperationalState> {
  const result = await database.query<{
    mode: unknown; provider_work_enabled: unknown;
    restored_from_at: unknown; deletion_reviewed_at: unknown; access_reviewed_at: unknown;
  }>(`SELECT mode,provider_work_enabled,restored_from_at,deletion_reviewed_at,access_reviewed_at
    FROM operational_state WHERE singleton=true`);
  if (result.rowCount === 0 && result.rows.length === 0) throw new Error("Operational state is missing.");
  if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("Operational state singleton is invalid.");
  const row = result.rows[0];
  if (!row || (row.mode !== "normal" && row.mode !== "maintenance") || typeof row.provider_work_enabled !== "boolean") {
    throw new Error("Operational state is invalid.");
  }
  const timestamps = [row.restored_from_at, row.deletion_reviewed_at, row.access_reviewed_at].map(value => {
    if (value === null) return null;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Operational state is invalid.");
    return value.toISOString();
  });
  if (timestamps.some(value => value === null) && timestamps.some(value => value !== null)) {
    throw new Error("Operational state restoration review is incomplete.");
  }
  return {
    mode: row.mode,
    providerWorkEnabled: row.provider_work_enabled,
    restoredFromAt: timestamps[0],
    deletionReviewedAt: timestamps[1],
    accessReviewedAt: timestamps[2],
  };
}

export async function loadOperationalState(database: Pick<pg.Pool, "query"> = pool) {
  const version = ++loadVersion;
  try {
    const state = await readOperationalState(database);
    // A superseded read must not reopen a newer maintenance or requalification fence.
    if (version > appliedLoadVersion) {
      appliedLoadVersion = version;
      loadedState = { ...state };
      loadFailed = false;
    }
    return state;
  } catch (error) {
    if (version > appliedLoadVersion) {
      appliedLoadVersion = version;
      loadFailed = true;
    }
    throw error;
  }
}

export function requireProviderAdmissions() {
  if (maintenanceActive() || loadFailed || !loadedState || loadedState.mode !== "normal") {
    throw new AppError(503, "maintenance", "Maintenance is active; provider work is not accepted.");
  }
  if (!loadedState.providerWorkEnabled) {
    throw new AppError(503, "provider_requalification_required", "Provider work remains disabled until restored access is reviewed and explicitly requalified.");
  }
}

export function providerWorkEnabled() {
  return !maintenanceActive() && !loadFailed && loadedState?.mode === "normal" && loadedState.providerWorkEnabled;
}
