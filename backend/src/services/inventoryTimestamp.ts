import { AppError } from "../errors.js";
import { compareInventoryInstants, isInventoryTimestamp } from "../types/inventoryTimestamp.js";

export function inventoryTimestamp(value: string | Date) {
  const invalid = (): never => {
    throw new AppError(500, "saved_source_invalid", "Saved inventory observation contains an invalid timestamp.");
  };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return invalid();
    return value.toISOString();
  }
  if (!isInventoryTimestamp(value)) return invalid();
  return value;
}

export function compareInventoryTimestamps(left: string | Date, right: string | Date) {
  return compareInventoryInstants(inventoryTimestamp(left), inventoryTimestamp(right));
}
