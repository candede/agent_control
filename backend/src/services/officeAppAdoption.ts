import { AppError } from "../errors.js";
import { civilDate } from "./userSourceGraphFields.js";
import { officeApps, type OfficeCoverage, type OfficeDates, type OfficeMetrics, type OfficeQuery, type OfficeUnknownReason } from "../types/officeAppAdoption.js";

export const officeQueryFields = ["officeSnapshot", "officeBaseline", "company", "department", "search", "app"] as const;
export const officeReasons: readonly OfficeUnknownReason[] = ["missing_row", "ambiguous_identity", "retained_row", "retained_directory",
  "wrong_window", "no_app_dates", "invalid_app_date", "future_app_date"];
export function officeDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return civilDate(value, "Office date", false) === value; } catch { return false; }
}
export function officeWindowStart(refresh: string) {
  if (!officeDate(refresh)) throw new AppError(400, "invalid_office_date", "Expected a UTC calendar date.");
  return new Date(Date.parse(`${refresh}T00:00:00Z`) - 27 * 86400000).toISOString().slice(0, 10);
}
export function officeRetentionCutoff(now: Date) {
  const year = now.getUTCFullYear() - 1, month = now.getUTCMonth();
  const day = Math.min(now.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}
export function officeExpiry(refresh: string) {
  const date = new Date(`${refresh}T00:00:00Z`);
  const year = date.getUTCFullYear() + 1, month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate();
  const day = date.getUTCDate() === lastDay ? new Date(Date.UTC(year, month + 1, 0)).getUTCDate() : date.getUTCDate();
  // Cutoff equality is retained for the whole UTC day.
  return new Date(Date.UTC(year, month, day + 1));
}
export function classifyOfficeApps(dates: OfficeDates, refresh: string, reasons: readonly OfficeUnknownReason[] = []) {
  const unknownReasons = new Set(reasons);
  const start = officeWindowStart(refresh);
  for (const app of officeApps) {
    const date = dates[app.id];
    if (date !== null && !officeDate(date)) unknownReasons.add("invalid_app_date");
    else if (date !== null && date > refresh) unknownReasons.add("future_app_date");
  }
  if (officeApps.every(app => dates[app.id] === null)) unknownReasons.add("no_app_dates");
  const blocked = reasons.length > 0;
  const recentApps = blocked ? [] : officeApps.filter(app => {
    const date = dates[app.id];
    return date !== null && officeDate(date) && date >= start && date <= refresh;
  }).map(app => app.id);
  const latestRecentDate = recentApps.map(app => dates[app]!).sort().at(-1) ?? null;
  return { recentApps, latestRecentDate, unknownReasons: officeReasons.filter(reason => unknownReasons.has(reason)) };
}
export function emptyOfficeMetrics(): OfficeMetrics {
  return { savedLicensedPeople: 0, reportedActiveUsers: 0, activeUserAppPairs: 0, appsUsed: 0,
    noRecentEvidencePeople: 0, unknownEvidencePeople: 0, perApp: { word: 0, excel: 0, powerpoint: 0, outlook: 0, onenote: 0, loop: 0, teams: 0 } };
}
export function officeWeekStart(refresh: string) {
  if (!officeDate(refresh)) throw new AppError(400, "invalid_office_date", "Expected a valid Office report date.");
  const date = new Date(`${refresh}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function emptyOfficeCoverage(): OfficeCoverage {
  return { directoryPeople: 0, paidInactivePeople: 0, noPaidPeople: 0, unknownLicensePeople: 0,
    reportedRows: 0, retainedRows: 0, state: "complete",
    unknownReasons: { missing_row: 0, ambiguous_identity: 0, retained_row: 0, retained_directory: 0,
      wrong_window: 0, no_app_dates: 0, invalid_app_date: 0, future_app_date: 0 } };
}
export function officeQuery(input: OfficeQuery): OfficeQuery {
  if (!input || Object.keys(input).some(key => !officeQueryFields.includes(key as typeof officeQueryFields[number]))) {
    throw new AppError(400, "invalid_office_query", "Unsupported Office query.");
  }
  for (const key of ["officeSnapshot", "officeBaseline"] as const) {
    if (input[key] !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input[key]!)) {
      throw new AppError(400, "invalid_office_query", "Expected an Office observation UUID.");
    }
  }
  for (const key of ["company", "department", "search"] as const) {
    const value = input[key];
    const invalidText = key === "search" ? /[\p{Cc}\p{Cs}]/u : /[\0\r\n\p{Cs}]/u;
    if (value !== undefined && !(key !== "search" && value === null)
      && (typeof value !== "string" || value.length > 256 || invalidText.test(value))) {
      throw new AppError(400, "invalid_office_query", "Expected bounded Office filters.");
    }
  }
  if (input.app !== undefined && !officeApps.some(app => app.id === input.app)) throw new AppError(400, "invalid_office_query", "Unsupported Office app.");
  return { ...input };
}
