import { AppError } from "../errors.js";
import { exactCount } from "./dataBounds.js";

export function officialReportCount(value: string | number) {
  try { return exactCount(value); }
  catch { throw new AppError(409, "official_usage_total_limit", "The reported total exceeds the exact safe-integer range."); }
}
