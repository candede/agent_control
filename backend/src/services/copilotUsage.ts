import type pg from "pg";
import { acquireDelegatedToken } from "../auth/msal.js";
import { config } from "../config.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { AppError } from "../errors.js";
import type {
  CopilotUsageAttention,
  CopilotUsageSourceSummary,
  CopilotUsageUnresolvedImportedIdentity,
  CopilotUsageUser,
  CopilotUsageUsersResponse,
} from "../types/copilotUsage.js";
import { copilotUsagePeriod } from "../types/copilotUsage.js";
import type { OfficialUsageUserSummary, OfficialUsageUserView, PublishedOfficialUsage } from "../types/officialUsage.js";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilities } from "./capabilities.js";
import {
  CopilotUsageGraphClient,
  normalizeCopilotIdentity,
  type CopilotDirectoryUser,
  type CopilotReportResult,
  type CopilotReportUser,
} from "./copilotUsageGraph.js";
import { buildOfficialUsageUserView } from "./officialUsageViews.js";
import { operationalLog } from "./telemetry.js";

const appReportStaleAfterDays = 3;

type CopilotUsageDependencies = {
  requireAvailable: typeof capabilities.requireAvailable;
  delegatedToken: typeof acquireDelegatedToken;
  graph: CopilotUsageGraphClient;
  loadPublished: (tenantId: string) => Promise<PublishedOfficialUsage>;
  now: () => Date;
};

type Loaded<T> =
  | { ok: true; value: T; fetchedAt: string }
  | { ok: false; message: string };

export class CopilotUsageService {
  private readonly dependencies: CopilotUsageDependencies;

  constructor(database: pg.Pool, dependencies: Partial<CopilotUsageDependencies> = {}) {
    const repository = new OfficialUsageRepository(database);
    this.dependencies = {
      requireAvailable: capabilities.requireAvailable.bind(capabilities),
      delegatedToken: acquireDelegatedToken,
      graph: new CopilotUsageGraphClient(),
      loadPublished: tenantId => repository.getPublished(tenantId),
      now: () => new Date(),
      ...dependencies,
    };
  }

  async users(user: AuthenticatedUser, signal?: AbortSignal): Promise<CopilotUsageUsersResponse> {
    signal?.throwIfAborted();
    if (!user.tenantId) throw AppError.unauthorized("Copilot usage requires a tenant-scoped session.");
    const generatedAt = this.dependencies.now().toISOString();
    const [directory, appActivity, imported] = await Promise.all([
      this.loadDirectory(user, signal),
      this.loadAppActivity(user, signal),
      this.loadImported(user.tenantId),
    ]);
    signal?.throwIfAborted();
    const importedView = imported.ok ? imported.value : null;
    const directoryUsers = directory.ok ? directory.value : [];
    const matching = matchImportedUsage(directoryUsers, importedView?.users.value ?? [], directory.ok);
    const appMatching = matchAppActivity(directoryUsers, appActivity.ok ? appActivity.value.users : []);
    const importedMetricsFresh = Boolean(importedView && importedView.availability === "active");
    const appMetricsFresh = Boolean(appActivity.ok && isFreshAppReport(appActivity));
    const users = directoryUsers.map(directoryUser => {
      const importedUsage = matching.byObjectId.get(directoryUser.identity.objectId) ?? null;
      const activity = appMatching.get(directoryUser.identity.objectId) ?? null;
      return buildUser(directoryUser, importedUsage, activity, importedMetricsFresh, appMetricsFresh);
    }).sort(compareUsers);
    const directorySource = directory.ok
      ? source("available", `Loaded ${directoryUsers.length} Microsoft 365 Copilot users from the tenant license catalog, including qualifying bundles. All directory pages were checked against Microsoft Graph totals.`, directory.fetchedAt)
      : unavailableSource(directory.message);
    const appSource = appActivity.ok
      ? appActivitySource(appActivity, appMatching.size)
      : unavailableSource(appActivity.message, copilotUsagePeriod, "v1");
    const importedSource = imported.ok
      ? importedUsageSource(imported.value)
      : unavailableSource(imported.message);
    const metricsAvailable = importedMetricsFresh || appMetricsFresh;

    return {
      generatedAt,
      readOnly: true,
      period: copilotUsagePeriod,
      sources: {
        directory: directorySource,
        appActivity: appSource,
        importedAgentUsage: importedSource,
      },
      counts: {
        licensedUsers: directory.ok ? users.length : null,
        measuredActivityUsers: directory.ok && metricsAvailable
          ? users.filter(value => hasMeasuredActivity(value, importedMetricsFresh, appMetricsFresh)).length
          : null,
        needsAttentionUsers: directory.ok
          ? users.filter(value => value.attention.some(reason => !["agent_usage_unknown", "app_activity_unknown"].includes(reason))).length
          : null,
        unknownMetricsUsers: directory.ok
          ? users.filter(value => value.attention.includes("agent_usage_unknown") || value.attention.includes("app_activity_unknown")).length
          : null,
        unresolvedImportedIdentities: matching.unresolved.length,
      },
      users,
      unresolvedImportedIdentities: matching.unresolved,
      notices: [
        "This dashboard is read-only and never changes license assignments.",
        "Licensed users means current Microsoft 365 Copilot assignments, including bundles with the Copilot productivity-app entitlement; it is not the total of Microsoft 365 or Office 365 base licenses.",
        "Zero or low imported agent responses describe Copilot Agents usage only, not total Microsoft 365 Copilot use.",
        "Missing source data remains unknown and is never converted to zero or an unlicensed state.",
        "Microsoft report rows can include users licensed during the prior 180 days; only exact matches in the current directory license cohort are shown.",
        "Inactive app attention means no D30 activity date was observed; blank or delayed Office telemetry is not proof that Copilot was never used.",
      ],
    };
  }

  private async loadDirectory(user: AuthenticatedUser, signal?: AbortSignal): Promise<Loaded<CopilotDirectoryUser[]>> {
    try {
      await this.dependencies.requireAvailable("graph.licenses.read", user);
      const token = await this.dependencies.delegatedToken(user.homeAccountId, "graph.licenses.read");
      const value = await this.dependencies.graph.listLicensedUsers(token, signal);
      return { ok: true, value, fetchedAt: this.dependencies.now().toISOString() };
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, message: sourceErrorMessage(error, "Directory license data", "User.Read.All and LicenseAssignment.Read.All") };
    }
  }

  private async loadAppActivity(user: AuthenticatedUser, signal?: AbortSignal): Promise<Loaded<CopilotReportResult>> {
    try {
      await this.dependencies.requireAvailable("reports.copilotUsage.read", user);
      const token = await this.dependencies.delegatedToken(user.homeAccountId, "reports.copilotUsage.read");
      const value = await this.dependencies.graph.listAppActivity(token, signal);
      return { ok: true, value, fetchedAt: this.dependencies.now().toISOString() };
    } catch (error) {
      signal?.throwIfAborted();
      return { ok: false, message: sourceErrorMessage(error, "Microsoft 365 Copilot app activity", "Reports.Read.All") };
    }
  }

  private async loadImported(tenantId: string): Promise<Loaded<OfficialUsageUserView>> {
    try {
      const published = await this.dependencies.loadPublished(tenantId);
      const value = buildOfficialUsageUserView(published, {
        staleAfterDays: config.officialUsageStaleDays,
        lowResponseThreshold: 5,
        limit: 100_000,
        offset: 0,
        now: this.dependencies.now(),
      });
      if (value.users.value.length !== value.users.count) {
        return { ok: false, message: "Imported agent usage exceeds the dashboard result limit; no imported rows were joined." };
      }
      return { ok: true, value, fetchedAt: this.dependencies.now().toISOString() };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { ok: false, message: sourceErrorMessage(error, "Imported agent usage") };
    }
  }
}

function matchImportedUsage(
  directoryUsers: readonly CopilotDirectoryUser[],
  imported: readonly OfficialUsageUserSummary[],
  directoryAvailable: boolean,
) {
  const directoryKeys = identityIndex(directoryUsers);
  const importedKeys = new Map<string, OfficialUsageUserSummary[]>();
  for (const summary of imported) {
    const key = normalizeCopilotIdentity(summary.username);
    const rows = importedKeys.get(key) ?? [];
    rows.push(summary);
    importedKeys.set(key, rows);
  }
  const byObjectId = new Map<string, OfficialUsageUserSummary>();
  const unresolved: CopilotUsageUnresolvedImportedIdentity[] = [];
  const candidates = new Map<string, Array<{ key: string; summary: OfficialUsageUserSummary }>>();
  for (const [key, summaries] of importedKeys) {
    const directoryMatches = directoryKeys.get(key) ?? [];
    if (directoryAvailable && summaries.length === 1 && directoryMatches.length === 1) {
      const objectId = directoryMatches[0].identity.objectId;
      const values = candidates.get(objectId) ?? [];
      values.push({ key, summary: summaries[0] });
      candidates.set(objectId, values);
      continue;
    }
    const reason = !directoryAvailable
      ? "directory_unavailable" as const
      : summaries.length > 1 || directoryMatches.length > 1
        ? "ambiguous_directory_match" as const
        : "no_exact_directory_match" as const;
    for (const summary of summaries) {
      unresolved.push({ normalizedUserPrincipalName: key, importedUsage: summary, reason });
    }
  }
  for (const [objectId, values] of candidates) {
    if (values.length === 1) {
      byObjectId.set(objectId, values[0].summary);
    } else {
      unresolved.push(...values.map(value => ({
        normalizedUserPrincipalName: value.key,
        importedUsage: value.summary,
        reason: "ambiguous_directory_match" as const,
      })));
    }
  }
  unresolved.sort((left, right) => left.normalizedUserPrincipalName.localeCompare(right.normalizedUserPrincipalName));
  return { byObjectId, unresolved };
}

function matchAppActivity(
  directoryUsers: readonly CopilotDirectoryUser[],
  reportUsers: readonly CopilotReportUser[],
) {
  const directoryKeys = identityIndex(directoryUsers);
  const reportKeys = new Map<string, CopilotReportUser[]>();
  for (const report of reportUsers) {
    const rows = reportKeys.get(report.normalizedUserPrincipalName) ?? [];
    rows.push(report);
    reportKeys.set(report.normalizedUserPrincipalName, rows);
  }
  const matched = new Map<string, CopilotReportUser["activity"]>();
  const candidates = new Map<string, CopilotReportUser[]>();
  for (const [key, reports] of reportKeys) {
    const directoryMatches = directoryKeys.get(key) ?? [];
    if (reports.length === 1 && directoryMatches.length === 1) {
      const objectId = directoryMatches[0].identity.objectId;
      const values = candidates.get(objectId) ?? [];
      values.push(reports[0]);
      candidates.set(objectId, values);
    }
  }
  for (const [objectId, values] of candidates) {
    if (values.length === 1) matched.set(objectId, values[0].activity);
  }
  return matched;
}

function identityIndex(users: readonly CopilotDirectoryUser[]) {
  const result = new Map<string, CopilotDirectoryUser[]>();
  for (const user of users) {
    for (const key of new Set([
      normalizeCopilotIdentity(user.identity.userPrincipalName),
      normalizeCopilotIdentity(user.identity.objectId),
    ])) {
      const values = result.get(key) ?? [];
      values.push(user);
      result.set(key, values);
    }
  }
  return result;
}

function buildUser(
  directory: CopilotDirectoryUser,
  importedUsage: OfficialUsageUserSummary | null,
  appActivity: CopilotReportUser["activity"] | null,
  importedMetricsFresh: boolean,
  appMetricsFresh: boolean,
): CopilotUsageUser {
  const attention: CopilotUsageAttention[] = [];
  if (!importedMetricsFresh || !importedUsage || importedUsage.reviewCohort === "unknown") attention.push("agent_usage_unknown");
  else if (importedUsage.reviewCohort === "zero_responses") attention.push("agent_usage_zero");
  else if (importedUsage.reviewCohort === "low_responses") attention.push("agent_usage_low");
  if (!appMetricsFresh || !appActivity) attention.push("app_activity_unknown");
  else if (!appActivity.lastActivityDate) attention.push("app_activity_unknown");
  else if (!hasRecentAppActivity(appActivity)) attention.push("app_activity_inactive");
  if (directory.licenses.some(license => license.state === "error")) attention.push("license_error");
  if (directory.licenses.some(license => license.state === "disabled")) attention.push("license_disabled");
  return {
    directory: directory.identity,
    licenses: directory.licenses,
    servicePlans: directory.servicePlans,
    importedUsage,
    appActivity,
    attention,
  };
}

function hasMeasuredActivity(user: CopilotUsageUser, importedMetricsFresh: boolean, appMetricsFresh: boolean) {
  return Boolean((importedMetricsFresh && user.importedUsage && user.importedUsage.reportedResponsesReceived > 0)
    || (appMetricsFresh && user.appActivity && hasRecentAppActivity(user.appActivity)));
}

function hasRecentAppActivity(activity: CopilotReportUser["activity"]) {
  if (!activity.lastActivityDate) return false;
  const start = new Date(`${activity.reportRefreshDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  return activity.lastActivityDate >= start.toISOString().slice(0, 10)
    && activity.lastActivityDate <= activity.reportRefreshDate;
}

function compareUsers(left: CopilotUsageUser, right: CopilotUsageUser) {
  const leftName = left.directory.displayName || left.directory.userPrincipalName;
  const rightName = right.directory.displayName || right.directory.userPrincipalName;
  return leftName.localeCompare(rightName, undefined, { sensitivity: "base" })
    || left.directory.objectId.localeCompare(right.directory.objectId);
}

function source(
  state: CopilotUsageSourceSummary["state"],
  message: string,
  fetchedAt: string | null,
  periodValue: string | null = null,
  startDate: string | null = null,
  endDate: string | null = null,
  reportRefreshDate: string | null = null,
  reportVersion: "v1" | null = null,
): CopilotUsageSourceSummary {
  return { state, message, fetchedAt, reportRefreshDate, reportVersion, period: { value: periodValue, startDate, endDate } };
}

function unavailableSource(message: string, periodValue: string | null = null, reportVersion: "v1" | null = null) {
  return source("unavailable", message, null, periodValue, null, null, null, reportVersion);
}

function appActivitySource(result: Extract<Loaded<CopilotReportResult>, { ok: true }>, matchedCount: number) {
  const unmatched = result.value.users.length - matchedCount;
  const stale = result.value.reportRefreshDate !== null && !isFreshAppReport(result);
  const incomplete = result.value.reportRefreshDate === null;
  const state = stale ? "stale" as const : unmatched > 0 || incomplete ? "partial" as const : "available" as const;
  const message = stale
    ? `The app activity report refresh is older than ${appReportStaleAfterDays} days; retained dates remain source-labelled.${unmatched > 0 ? ` ${unmatched} hidden, unmatched, or duplicate identities were not joined.` : ""}`
    : incomplete
      ? "The app activity report contained no rows or report refresh date; user activity remains unknown."
    : unmatched > 0
    ? `Loaded ${result.value.users.length} app activity rows; ${unmatched} hidden, unmatched, or duplicate identities were not joined.`
    : `Loaded ${result.value.users.length} app activity rows.`;
  return source(state, message, result.fetchedAt, copilotUsagePeriod, null, null, result.value.reportRefreshDate, "v1");
}

function isFreshAppReport(result: Extract<Loaded<CopilotReportResult>, { ok: true }>) {
  return result.value.reportRefreshDate !== null
    && civilDateAgeDays(result.value.reportRefreshDate, new Date(result.fetchedAt)) <= appReportStaleAfterDays;
}

function importedUsageSource(view: OfficialUsageUserView) {
  const period = view.activeSet?.reportingPeriod;
  const reportRefreshDate = latest(view.lineages.map(lineage => lineage.sourceAsOf));
  const fetchedAt = latest(view.lineages.map(lineage => lineage.acceptedAt));
  const state = view.availability === "active"
    ? "available"
    : view.availability === "stale"
      ? "stale"
      : view.availability === "never_imported" || view.availability === "deleted" || view.availability === "not_selected"
        ? "not_imported"
        : "partial";
  const message = state === "available"
    ? `Loaded ${view.users.count} imported agent usage identities.`
    : state === "stale"
      ? "Imported agent usage is stale; values are retained with their source period."
      : state === "not_imported"
        ? "No active imported agent usage set is available."
        : "The active imported agent usage set is incomplete.";
  const days = view.activeSet && view.lineages.length
    ? view.lineages.map(lineage => lineage.reportingPeriod.days).find(value => value !== null) ?? null
    : null;
  return source(state, message, fetchedAt, days ? `D${days}` : null, period?.startDate ?? null, period?.endDate ?? null, reportRefreshDate);
}

function latest(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function civilDateAgeDays(value: string, now: Date) {
  const endOfDay = Date.parse(`${value}T23:59:59.999Z`);
  return Math.max(0, Math.floor((now.getTime() - endOfDay) / 86_400_000));
}

function sourceErrorMessage(error: unknown, label: string, permission?: "User.Read.All and LicenseAssignment.Read.All" | "Reports.Read.All") {
  if (!(error instanceof AppError)
    && !(error instanceof TypeError && error.message === "fetch failed")
    && !(error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))) throw error;
  operationalLog("warn", "copilot_usage_source_unavailable", {
    source: label,
    ...(error instanceof AppError ? { errorCode: error.code.toLowerCase().replace(/[.-]/g, "_"), status: error.status } : { errorKind: error.name }),
  });
  if (error instanceof AppError) {
    if (["interaction_required", "authorization_expired"].includes(error.code) || error.status === 401) {
      return `${label} requires renewed Microsoft authorization. Sign out and sign in, then refresh usage.`;
    }
    if (["capability_unavailable", "missing_permission", "Authorization_RequestDenied"].includes(error.code) || error.status === 403) {
      return permission
        ? `${label} was denied. Check admin consent for Microsoft Graph delegated permission ${permission} on the existing Entra app. ${permission === "Reports.Read.All" ? "The signed-in user also needs Reports Reader or another supported Microsoft report-reader role. " : "The signed-in user also needs Directory Readers, Global Reader, or another supported license-catalog reader role. "}Sign out and sign in after changing access.`
        : `${label} is unavailable because the required permission was denied.`;
    }
    if (error.code === "provider_result_limit") return `${label} exceeded the bounded page or result limit; no truncated data was returned.`;
    if (error.code === "provider_response_size_limit") return `${label} exceeded the response-size safety limit, not the user-count limit. Check the backend's copilot_license_response_size_limit diagnostic; additional permissions will not fix this payload-size issue. No truncated data was returned.`;
    if (error.code === "provider_count_mismatch") return `${label} did not match Microsoft Graph's total count. The directory may have changed during paging; refresh usage. No incomplete license count was returned.`;
    if (error.code === "report_download_failed") return `${label} download failed. Refresh usage to request a new download; no additional delegated permission is needed for the download URL.`;
    if (error.code === "invalid_provider_link") return `${label} returned an unsupported continuation or report download link; no unvalidated link was followed.`;
    if (error.code === "provider_schema") return `${label} returned an invalid response; no unvalidated data was used.`;
    if (permission && error.status === 400) return `${label} request was rejected by Microsoft Graph (HTTP 400). This is a provider request error, not evidence that another delegated permission is needed.`;
    if (error.status === 429) return `${label} is temporarily throttled by Microsoft. Wait before refreshing usage.`;
  } else if (error instanceof DOMException) {
    return `${label} timed out or was interrupted. Retry by refreshing usage.`;
  } else {
    return `${label} could not be reached. Check the server's outbound HTTPS access to Microsoft Graph${permission === "Reports.Read.All" ? ", reports.office.com, and reportsweu.office.com" : ""}, then refresh usage.`;
  }
  return `${label} is unavailable; other source results are still shown when available.`;
}
