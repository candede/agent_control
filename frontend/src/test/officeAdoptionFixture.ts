import type { OfficeContext, OfficeDates, OfficeGroup, OfficeHistoryPoint, OfficeMetrics, OfficeObservation, OfficePage, OfficePerson, OfficeQuery, OfficeSummary } from "../../../backend/src/types/officeAppAdoption";
import { officeApps } from "../../../backend/src/types/officeAppAdoption";
import { reportSelection } from "./reportDataFixture";

function officeObservation(index = 3, date = `2026-10-${String(index * 7).padStart(2, "0")}`): OfficeObservation {
  return {
    id: `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "current", reportRefreshDate: date, period: "D28", reportVersion: "v2",
    windowStart: new Date(Date.parse(date) - 27 * 86_400_000).toISOString().slice(0, 10),
    capturedAt: `${date}T12:00:00.000Z`, expiresAt: `${Number(date.slice(0, 4)) + 1}${date.slice(4)}T00:00:00.000Z`,
    contentHash: String(index).repeat(64), directoryGenerationId: "d0000000-0000-4000-8000-000000000001",
    appGenerationId: "b0000000-0000-4000-8000-000000000001", directoryObservedAt: `${date}T10:00:00.000Z`, appObservedAt: `${date}T11:00:00.000Z`,
    coverage: { directoryPeople: 60, paidInactivePeople: 2, noPaidPeople: 3, unknownLicensePeople: 1, reportedRows: 50, retainedRows: 1, state: "partial",
      unknownReasons: { missing_row: 2, ambiguous_identity: 1, retained_row: 1, retained_directory: 1, wrong_window: 0, no_app_dates: 3, invalid_app_date: 0, future_app_date: 1 } },
  };
}
function officeMetrics(overrides: Partial<OfficeMetrics> = {}): OfficeMetrics {
  return { savedLicensedPeople: 54, reportedActiveUsers: 40, activeUserAppPairs: 70, appsUsed: 7,
    noRecentEvidencePeople: 14, unknownEvidencePeople: 9,
    perApp: { word: 30, excel: 10, powerpoint: 8, outlook: 7, onenote: 5, loop: 4, teams: 6 }, ...overrides };
}
export function officeContext(query: OfficeQuery = {}, index = 3): OfficeContext {
  return { observation: officeObservation(index), baseline: query.officeBaseline ? officeObservation(Number(query.officeBaseline.slice(-1))) : null,
    selection: reportSelection(10 + index, Date.now()), status: { state: "available", errorCode: null, message: null }, query };
}
export function officePerson(index = 1, overrides: Partial<OfficePerson> = {}): OfficePerson {
  const dates = Object.fromEntries(officeApps.map(app => [app.id, app.id === "word" || app.id === "excel" ? "2026-10-20" : null])) as OfficeDates;
  return { identity: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`, userPrincipalName: `office${index}@example.invalid`,
    displayName: `Office Person ${index}`, company: "Contoso", department: "Engineering", groupId: "a".repeat(64),
    entitlement: "paid_active", serviceState: "enabled", directoryObservedAt: "2026-10-21T10:00:00.000Z", appObservedAt: "2026-10-21T11:00:00.000Z",
    appReportRefreshDate: "2026-10-21", dates, recentApps: ["word", "excel"], latestRecentDate: "2026-10-20", unknownReasons: [], ...overrides };
}
export function officeGroup(index = 1, overrides: Partial<OfficeGroup> = {}): OfficeGroup {
  return { id: index === 1 ? "a".repeat(64) : index.toString(16).padStart(64, "b"), company: "Contoso", department: index === 1 ? "Engineering" : `Department ${index}`,
    metrics: officeMetrics(), participation: 40 / 54, filteredPeople: 54,
    champions: [officePerson(1), officePerson(2), officePerson(3)], ...overrides };
}
function officeFixtureQuery(input: OfficeQuery) {
  return Object.fromEntries(Object.entries(input).filter(([key]) =>
    ["officeSnapshot", "officeBaseline", "company", "department", "search", "app"].includes(key))) as OfficeQuery;
}
export function officeFixtureContext(input: OfficeQuery) {
  const query = officeFixtureQuery(input);
  const index = query.officeSnapshot ? Number(query.officeSnapshot.slice(-1)) : 3;
  const context = officeContext(query,index);
  if (query.officeSnapshot && index<3 && context.observation) context.observation.kind="weekly";
  return context;
}
export function officePage<T>(value: T[], context = officeContext(), overrides: Partial<OfficePage<T>> = {}): OfficePage<T> {
  return structuredClone({ value, context, counts: { total: value.length, filtered: value.length },
    page: { limit: 50, number: 1, pages: 1, offset: 0, anchor: null, previousCursor: null, nextCursor: null }, ...overrides });
}
export function officeSummary(context = officeContext(), overrides: Partial<OfficeSummary> = {}): OfficeSummary {
  return { organization: context.observation ? officeMetrics() : null, matching: context.observation ? officeMetrics() : null,
    matchingGroups: context.observation ? 1 : 0, filteredPeople: context.observation ? 54 : 0,
    suggestedChampions: context.observation ? 3 : null, filteredSuggestedChampions: context.observation ? 3 : null,
    baseline: context.baseline ? officeMetrics({ reportedActiveUsers: 20, activeUserAppPairs: 30 }) : null, context, ...overrides };
}
export function officeHistory(context = officeContext()): OfficeHistoryPoint[] {
  return Array.from({ length: Number(context.observation?.id.slice(-1) ?? 0) }, (_, index) => ({
    observation: { ...officeObservation(index + 1), kind: "weekly" },
    metrics: officeMetrics({ reportedActiveUsers: index === 2 ? 40 : index === 1 ? 30 : 20, activeUserAppPairs: index === 2 ? 70 : index === 1 ? 50 : 30 }),
  }));
}
