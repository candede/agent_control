import type pg from "pg";
import { pool } from "../db/pool.js";
import { AppError } from "../errors.js";
import { maintenanceActive } from "./maintenance.js";

export type OperationalState = {
  mode: "normal" | "maintenance";
  providerWorkEnabled: boolean;
};

let loadedState: OperationalState | undefined;
let loadVersion = 0;
let appliedLoadVersion = 0;
let loadFailed = false;

export async function readOperationalState(database: Pick<pg.Pool, "query"> = pool): Promise<OperationalState> {
  const result = await database.query<{ mode: unknown }>("SELECT mode FROM operational_state WHERE singleton=true");
  if (result.rowCount === 0 && result.rows.length === 0) throw new Error("Operational state is missing.");
  if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error("Operational state singleton is invalid.");
  const row = result.rows[0];
  if (!row || (row.mode !== "normal" && row.mode !== "maintenance")) {
    throw new Error("Operational state is invalid.");
  }
  return {
    mode: row.mode,
    providerWorkEnabled: row.mode === "normal",
  };
}

export async function loadOperationalState(database: Pick<pg.Pool, "query"> = pool) {
  const version = ++loadVersion;
  try {
    const state = await readOperationalState(database);
    // A superseded read must not reopen a newer maintenance or admission fence.
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
}

export function providerWorkEnabled() {
  return !maintenanceActive() && !loadFailed && loadedState?.mode === "normal";
}
