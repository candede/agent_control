import type pg from "pg";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import {
  DataSyncRepository,
  type CopilotUsageAttemptStatus,
  type CopilotUsageSnapshotSource,
  type DataSyncScope,
  type SavedCopilotUsageSource,
  type UserSourcePublication,
} from "../db/dataSync.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type {
  CopilotUsageAttention,
  CopilotUsageSourceSummary,
  CopilotUsageUser,
  CopilotUsageUsersResponse,
} from "../types/copilotUsage.js";
import { copilotUsagePeriod, isCopilotServiceActive } from "../types/copilotUsage.js";
import type { OfficialUsageUserSummary, OfficialUsageUserView, PublishedOfficialUsage } from "../types/officialUsage.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { DataSyncSourceState } from "../types/dataSync.js";
import { hasAppRole, type CapabilityId } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import {
  CopilotUsageGraphClient,
  type CopilotDirectoryProgress,
  type CopilotDirectoryUser,
  type CopilotReportResult,
  type CopilotReportUser,
} from "./copilotUsageGraph.js";
import { buildOfficialUsageUserView } from "./officialUsageViews.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { operationalLog } from "./telemetry.js";
import { hasReportedAgentActivity, identityIndex, matchImportedUsage } from "./copilotUsageIdentity.js";

const appReportStaleAfterDays = 3;

type CopilotUsageDependencies = {
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  delegatedToken: typeof acquireDelegatedToken;
  revalidateUser: typeof revalidateAuthenticatedUser;
  graph: CopilotUsageGraphClient;
  loadPublished: (tenantId: string) => Promise<PublishedOfficialUsage>;
  usageStore: Pick<DataSyncRepository,
    "getUserSources" | "publishDirectory" | "publishAppActivity" | "recordUserSourceFailure">;
  requireProviderAdmissions: typeof requireProviderAdmissions;
  now: () => Date;
};

type Loaded<T> =
  | { ok: true; value: T; fetchedAt: string }
  | { ok: false; message: string; status: Exclude<CopilotUsageAttemptStatus, "available"> };

export type CopilotUsageRefreshResult = {
  status: Extract<DataSyncSourceState, "succeeded" | "partial" | "waiting_authorization" | "permission_required" | "failed">;
  // Checked directory candidates, not effectively licensed users.
  count: number | null;
  message: string;
};

export class CopilotUsageService {
  private readonly dependencies: CopilotUsageDependencies;

  constructor(database: pg.Pool, dependencies: Partial<CopilotUsageDependencies> = {}) {
    const repository = new OfficialUsageRepository(database);
    const usageStore = new DataSyncRepository(database);
    this.dependencies = {
      requireAvailable: capabilities.requireAvailable.bind(capabilities),
      observeOperation: capabilities.observeOperation.bind(capabilities),
      delegatedToken: acquireDelegatedToken,
      revalidateUser: revalidateAuthenticatedUser,
      graph: new CopilotUsageGraphClient(),
      loadPublished: tenantId => repository.getPublished(tenantId),
      usageStore,
      requireProviderAdmissions,
      now: () => new Date(),
      ...dependencies,
    };
  }

  async users(user: AuthenticatedUser): Promise<CopilotUsageUsersResponse> {
    const scope = dataScope(user);
    const generatedAt = this.dependencies.now().toISOString();
    const [saved, imported] = await Promise.all([
      this.dependencies.usageStore.getUserSources(scope),
      this.loadImported(scope.tenantId),
    ]);
    const directory = saved.directory.value && saved.directory.observedAt
      ? { ok: true as const, value: saved.directory.value, fetchedAt: saved.directory.observedAt }
      : {
        ok: false as const,
        message: saved.directory.attemptStatus === "available"
          ? "Saved directory and license data has expired or is no longer available. Refresh Users sync."
          : saved.directory.message ?? "Directory and license data has not been synced for this account.",
        status: saved.directory.attemptStatus === "permission_required" ? "permission_required" as const : saved.directory.attemptStatus === "waiting_authorization" ? "waiting_authorization" as const : "failed" as const,
      };
    const appActivity = saved.appActivity.value && saved.appActivity.observedAt
      ? { ok: true as const, value: saved.appActivity.value, fetchedAt: saved.appActivity.observedAt }
      : {
        ok: false as const,
        message: saved.appActivity.attemptStatus === "available"
          ? "Saved Microsoft 365 Copilot app activity has expired or is no longer available. Refresh Users sync."
          : saved.appActivity.message ?? "Microsoft 365 Copilot app activity has not been synced for this account.",
        status: saved.appActivity.attemptStatus === "permission_required" ? "permission_required" as const : saved.appActivity.attemptStatus === "waiting_authorization" ? "waiting_authorization" as const : "failed" as const,
      };
    return composeCopilotUsageUsers({
      generatedAt,
      directory,
      appActivity,
      imported,
      saved,
    });
  }

  async refreshUsers(
    user: AuthenticatedUser,
    signal: AbortSignal | undefined,
    options: { incompleteOnly?: boolean; publication: UserSourcePublication; onDirectoryProgress?: CopilotDirectoryProgress },
  ): Promise<CopilotUsageRefreshResult> {
    const scope = dataScope(user);
    signal?.throwIfAborted();
    const before = await this.dependencies.usageStore.getUserSources(scope);
    signal?.throwIfAborted();
    const requested: CopilotUsageSnapshotSource[] = options.incompleteOnly
      ? [
        ...(hasAvailableUserSource(before.directory) ? [] : ["directory" as const]),
        ...(hasAvailableUserSource(before.appActivity) ? [] : ["app_activity" as const]),
      ]
      : ["directory", "app_activity"];
    if (!requested.length) {
      return { status: "succeeded", count: before.directory.rowCount, message: "All saved user sources already completed successfully." };
    }
    this.dependencies.requireProviderAdmissions();
    let observedCount: number | null = null;
    const onDirectoryProgress: CopilotDirectoryProgress = async count => {
      signal?.throwIfAborted();
      observedCount = count;
      await options.onDirectoryProgress?.(count);
      signal?.throwIfAborted();
    };
    await Promise.all(requested.map(sourceId => this.refreshUserSource(scope, user, sourceId, options.publication, onDirectoryProgress, signal)));
    signal?.throwIfAborted();
    const after = await this.dependencies.usageStore.getUserSources(scope);
    signal?.throwIfAborted();
    return userRefreshResult(after, requested.includes("directory") && hasAvailableUserSource(after.directory)
      ? after.directory.rowCount : observedCount);
  }

  private async refreshUserSource(
    scope: DataSyncScope,
    user: AuthenticatedUser,
    sourceId: CopilotUsageSnapshotSource,
    publication: UserSourcePublication,
    onDirectoryProgress: CopilotDirectoryProgress,
    signal?: AbortSignal,
  ) {
    const attemptedAt = this.dependencies.now().toISOString();
    const loaded = sourceId === "directory"
      ? await this.loadDirectory(user, signal, onDirectoryProgress)
      : await this.loadAppActivity(user, signal);
    signal?.throwIfAborted();
    if (!loaded.ok) {
      await this.dependencies.usageStore.recordUserSourceFailure(scope, sourceId, loaded.status, loaded.message, attemptedAt, publication);
      return;
    }
    try {
      await this.publishWithCurrentAuthorization(scope, user, capabilityForUserSource(sourceId), async () => {
        signal?.throwIfAborted();
        if (sourceId === "directory") {
          const value = loaded.value as CopilotDirectoryUser[];
          await this.dependencies.usageStore.publishDirectory(
            scope,
            value,
            loaded.fetchedAt,
            `Saved current M365 Copilot license evidence for ${value.length} directory users, including verified active report identities. This is not the tenant headcount.`,
            publication,
          );
        } else {
          const value = loaded.value as CopilotReportResult;
          await this.dependencies.usageStore.publishAppActivity(
            scope,
            value,
            loaded.fetchedAt,
            `Saved ${value.users.length} normalized Microsoft 365 Copilot app activity records.`,
            publication,
          );
        }
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AppError && error.code === "data_sync_publication_superseded") throw error;
      const failure = sourceFailure(error, sourceId === "directory" ? "Directory license data" : "Microsoft 365 Copilot app activity");
      await this.dependencies.usageStore.recordUserSourceFailure(scope, sourceId, failure.status, failure.message, attemptedAt, publication);
    }
  }

  private async publishWithCurrentAuthorization(
    scope: DataSyncScope,
    user: AuthenticatedUser,
    capabilityId: CapabilityId,
    publish: () => Promise<void>,
  ) {
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const freshUser = await this.dependencies.revalidateUser(scope.principalId);
    await commitAccountSessionValidation(validation, async () => {
      requireSamePrincipal(scope, freshUser);
      requireViewer(freshUser);
      await this.dependencies.requireAvailable(capabilityId, freshUser);
      requireSamePrincipal(scope, user);
      await publish();
    });
  }

  private async loadDirectory(user: AuthenticatedUser, signal: AbortSignal | undefined, onProgress: CopilotDirectoryProgress): Promise<Loaded<CopilotDirectoryUser[]>> {
    let progressFailure: { error: unknown } | undefined;
    try {
      return await this.dependencies.observeOperation("graph.licenses.read", user, async () => {
        const scope = dataScope(user);
        const token = await this.currentDelegatedToken(scope, "graph.licenses.read");
        signal?.throwIfAborted();
        const imported = await this.loadImported(scope.tenantId);
        signal?.throwIfAborted();
        if (!imported.ok) {
          throw new AppError(502, "report_license_verification_unavailable", imported.message);
        }
        const value = await this.dependencies.graph.listCopilotUsers(token, signal, async count => {
          try {
            await onProgress(count);
          } catch (error) {
            progressFailure = { error };
            throw error;
          }
        }, imported.value.users.value.filter(hasReportedAgentActivity).map(value => value.username));
        return { ok: true as const, value, fetchedAt: this.dependencies.now().toISOString() };
      }, { signal, shouldRecordError: () => !progressFailure });
    } catch (error) {
      signal?.throwIfAborted();
      // A durable progress write failure is not a Microsoft provider failure.
      if (progressFailure) throw progressFailure.error;
      return sourceFailure(error, "Directory license data", "User.Read.All and LicenseAssignment.Read.All");
    }
  }

  private async loadAppActivity(user: AuthenticatedUser, signal?: AbortSignal): Promise<Loaded<CopilotReportResult>> {
    try {
      return await this.dependencies.observeOperation("reports.copilotUsage.read", user, async () => {
        const token = await this.currentDelegatedToken(dataScope(user), "reports.copilotUsage.read");
        const value = await this.dependencies.graph.listAppActivity(token, signal);
        return { ok: true as const, value, fetchedAt: this.dependencies.now().toISOString() };
      }, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      return sourceFailure(error, "Microsoft 365 Copilot app activity", "Reports.Read.All");
    }
  }

  private async currentDelegatedToken(scope: DataSyncScope, capabilityId: CapabilityId) {
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const freshUser = await this.dependencies.revalidateUser(scope.principalId);
    let token = "";
    await commitAccountSessionValidation(validation, async () => {
      requireSamePrincipal(scope, freshUser);
      requireViewer(freshUser);
      await this.dependencies.requireAvailable(capabilityId, freshUser);
      token = await this.dependencies.delegatedToken(scope.principalId, capabilityId);
    });
    return token;
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
        return { ok: false, message: "Imported agent usage exceeds the dashboard result limit; no imported rows were joined.", status: "failed" };
      }
      return { ok: true, value, fetchedAt: this.dependencies.now().toISOString() };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return sourceFailure(error, "Imported agent usage");
    }
  }
}

export function composeCopilotUsageUsers(input: {
  generatedAt: string;
  directory: Loaded<CopilotDirectoryUser[]>;
  appActivity: Loaded<CopilotReportResult>;
  imported: Loaded<OfficialUsageUserView>;
  saved?: {
    directory: SavedCopilotUsageSource<CopilotDirectoryUser[]>;
    appActivity: SavedCopilotUsageSource<CopilotReportResult>;
  };
}): CopilotUsageUsersResponse {
    const { generatedAt, directory, appActivity, imported } = input;
    const importedView = imported.ok ? imported.value : null;
    const directoryUsers = directory.ok ? directory.value : [];
    const matching = matchImportedUsage(directoryUsers, importedView?.users.value ?? [], directory.ok);
    const appMatching = matchAppActivity(directoryUsers, appActivity.ok ? appActivity.value.users : []);
    const importedMetricsFresh = Boolean(importedView && importedView.availability === "active");
    const appMetricsFresh = Boolean(appActivity.ok && isFreshAppReport(appActivity, new Date(generatedAt)));
    const users = directoryUsers.map(directoryUser => {
      const importedUsage = matching.byObjectId.get(directoryUser.identity.objectId) ?? null;
      const activity = appMatching.get(directoryUser.identity.objectId) ?? null;
      return buildUser(directoryUser, importedUsage, activity, importedMetricsFresh, appMetricsFresh);
    }).sort(compareUsers);
    const licensedUsers = users.filter(value => isCopilotServiceActive(value.copilotServiceState));
    let directorySource = directory.ok
      ? source("available", `Checked ${directoryUsers.length} directory users from products containing paid M365 Copilot and exact active report identities. Product assignment alone does not establish a Copilot license. All matching directory pages were checked against Graph totals. This is not the total number of tenant accounts or basic Copilot Chat users.`, directory.fetchedAt)
      : unavailableSource(directory.message);
    let appSource = appActivity.ok
      ? appActivitySource(appActivity, appMatching.size, appMetricsFresh)
      : unavailableSource(appActivity.message, copilotUsagePeriod, "v1");
    const importedSource = imported.ok
      ? importedUsageSource(imported.value)
      : unavailableSource(imported.message);
    const metricsAvailable = importedMetricsFresh || appMetricsFresh;

    if (input.saved) {
      directorySource = savedSourceSummary(input.saved.directory, directorySource);
      appSource = savedSourceSummary(input.saved.appActivity, appSource);
    }
    const directoryCurrent = directorySource.state === "available";
    return {
      generatedAt,
      readOnly: true,
      period: copilotUsagePeriod,
      ...(input.saved ? { snapshot: snapshotMetadata(input.saved) } : {}),
      sources: {
        directory: directorySource,
        appActivity: appSource,
        importedAgentUsage: importedSource,
      },
      counts: {
        licensedUsers: directoryCurrent ? licensedUsers.length : null,
        measuredActivityUsers: directoryCurrent && metricsAvailable
          ? licensedUsers.filter(value => hasMeasuredActivity(value, importedMetricsFresh, appMetricsFresh)).length
          : null,
        needsAttentionUsers: directoryCurrent
          ? licensedUsers.filter(value => value.attention.some(reason => !["agent_usage_unknown", "app_activity_unknown"].includes(reason))).length
          : null,
        unknownMetricsUsers: directoryCurrent
          ? licensedUsers.filter(value => value.attention.includes("agent_usage_unknown") || value.attention.includes("app_activity_unknown")).length
          : null,
        unresolvedImportedIdentities: matching.unresolved.length,
      },
      users,
      unresolvedImportedIdentities: matching.unresolved,
      notices: [
        "This dashboard is read-only and never changes license assignments.",
        "Active M365 Copilot licensed users counts only users with at least one verified active paid feature, including usable grace-period features. Active describes paid-feature availability, not recent usage or account sign-in status.",
        "The checked directory roster includes candidates from products containing paid Copilot features and verified active report identities. Licensed-user labels and adoption counts require verified active paid features. Active users without paid Copilot require verified inactive paid features or no assigned paid Copilot service; unknown licensing is excluded.",
        "Paid-feature states do not describe basic Copilot Chat availability. Users without a paid M365 Copilot license, or with paid features not enabled, may still have basic Copilot Chat access subject to tenant policy. Basic access and usage are not measured here.",
        "Zero or low imported agent responses describe Copilot Agents usage only, not total Microsoft 365 Copilot use.",
        "Missing source data remains unknown and is never converted to zero or an unlicensed state.",
        "Microsoft report rows can include users licensed during the prior 180 days; only exact matches within the checked directory roster are joined. Reported activity does not establish current paid Copilot entitlement.",
        "Inactive app attention means no D30 activity date was observed; blank or delayed Office telemetry is not proof that Copilot was never used.",
      ],
    };
}

function hasAvailableUserSource(saved: SavedCopilotUsageSource<unknown>) {
  return saved.attemptStatus === "available" && saved.value !== null && saved.observedAt !== null;
}

function userRefreshResult(saved: {
  directory: SavedCopilotUsageSource<CopilotDirectoryUser[]>;
  appActivity: SavedCopilotUsageSource<CopilotReportResult>;
}, observedCount: number | null): CopilotUsageRefreshResult {
  const values = [saved.directory, saved.appActivity];
  if (values.every(hasAvailableUserSource)) {
    const licensedCount = saved.directory.value?.filter(value => isCopilotServiceActive(value.copilotServiceState)).length;
    return {
      status: "succeeded",
      count: saved.directory.rowCount,
      message: `Saved M365 Copilot feature evidence and app-activity sources.${saved.directory.rowCount === null ? "" : ` Directory users checked: ${saved.directory.rowCount}.`}${licensedCount === undefined ? "" : ` Active M365 Copilot licensed users: ${licensedCount}.`} All matching directory pages were verified. Checked users are not the tenant headcount or a count of basic Copilot Chat users.`,
    };
  }
  if (values.some(value => value.value !== null)) {
    const incomplete = values.filter(value => !hasAvailableUserSource(value)).map(value => value.source);
    return {
      status: "partial",
      count: observedCount,
      message: `Saved user data remains available, but ${incomplete.join(" and ")} did not complete the latest refresh.`,
    };
  }
  if (values.some(value => value.attemptStatus === "waiting_authorization")) {
    return { status: "waiting_authorization", count: observedCount, message: "Explicit resume with renewed Microsoft authorization is required." };
  }
  if (values.some(value => value.attemptStatus === "permission_required")) {
    return { status: "permission_required", count: observedCount, message: "Required delegated Microsoft read permission or provider role is unavailable." };
  }
  return { status: "failed", count: observedCount, message: "User sources failed before any normalized saved data could be published." };
}

function savedSourceSummary<T>(saved: SavedCopilotUsageSource<T>, current: CopilotUsageSourceSummary): CopilotUsageSourceSummary {
  if (saved.value === null) return current;
  if (saved.attemptStatus === "available") return current;
  const reason = saved.message ?? "The latest refresh did not complete.";
  return {
    ...current,
    state: "partial",
    message: `${reason} Retained saved data from ${saved.observedAt ?? "the prior successful sync"} is still shown.`,
    fetchedAt: saved.observedAt,
  };
}

function snapshotMetadata(saved: {
  directory: SavedCopilotUsageSource<CopilotDirectoryUser[]>;
  appActivity: SavedCopilotUsageSource<CopilotReportResult>;
}): NonNullable<CopilotUsageUsersResponse["snapshot"]> {
  const values = [saved.directory, saved.appActivity];
  const observed = values.map(value => value.observedAt).filter((value): value is string => value !== null).sort();
  const attempted = values.map(value => value.attemptedAt).filter((value): value is string => value !== null).sort();
  const success = values.map(value => value.lastSuccessAt).filter((value): value is string => value !== null).sort();
  const state = observed.length === 0
    ? "not_synced"
    : values.every(hasAvailableUserSource)
      ? "available"
      : "partial";
  return {
    state,
    lastAttemptAt: attempted.at(-1) ?? null,
    lastSuccessAt: success.at(-1) ?? null,
    directoryObservedAt: saved.directory.observedAt,
    appActivityObservedAt: saved.appActivity.observedAt,
  };
}

function dataScope(user: AuthenticatedUser): DataSyncScope {
  if (!user.tenantId) throw AppError.unauthorized("Copilot usage requires a tenant-scoped session.");
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function capabilityForUserSource(sourceId: CopilotUsageSnapshotSource): CapabilityId {
  return sourceId === "directory" ? "graph.licenses.read" : "reports.copilotUsage.read";
}

function requireSamePrincipal(scope: DataSyncScope, user: AuthenticatedUser) {
  if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId) {
    throw AppError.unauthorized("The signed-in account changed during the user source refresh.");
  }
}

function requireViewer(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Viewer")) {
    throw new AppError(403, "missing_internal_role", "User source refresh requires Viewer.");
  }
}

function sourceFailure(
  error: unknown,
  label: string,
  permission?: "User.Read.All and LicenseAssignment.Read.All" | "Reports.Read.All",
): Extract<Loaded<never>, { ok: false }> {
  const message = sourceErrorMessage(error, label, permission);
  const status = error instanceof AppError && (
    error.status === 401 || ["interaction_required", "authorization_expired", "unauthorized"].includes(error.code)
  ) ? "waiting_authorization"
    : error instanceof AppError && (
      error.status === 403 || ["capability_unavailable", "missing_permission", "missing_internal_role", "Authorization_RequestDenied"].includes(error.code)
    ) ? "permission_required"
      : "failed";
  return { ok: false, message, status };
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
  if (directory.copilotServiceState === "unknown") attention.push("copilot_service_unknown");
  else if (directory.copilotServiceState === "partially_enabled") attention.push("copilot_service_partial");
  else if (directory.copilotServiceState === "warning") attention.push("copilot_service_warning");
  else if (!isCopilotServiceActive(directory.copilotServiceState)) attention.push("copilot_service_disabled");
  return {
    directory: directory.identity,
    copilotServiceState: directory.copilotServiceState,
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

function appActivitySource(result: Extract<Loaded<CopilotReportResult>, { ok: true }>, matchedCount: number, fresh: boolean) {
  const unmatched = result.value.users.length - matchedCount;
  const stale = result.value.reportRefreshDate !== null && !fresh;
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

function isFreshAppReport(result: Extract<Loaded<CopilotReportResult>, { ok: true }>, now: Date) {
  return result.value.reportRefreshDate !== null
    && civilDateAgeDays(result.value.reportRefreshDate, now) <= appReportStaleAfterDays;
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
        ? `${label} was denied. An administrator must add Microsoft Graph delegated permission ${permission} under API permissions in the existing Entra app registration and select Grant admin consent. ${permission === "Reports.Read.All" ? "The signed-in user also needs Reports Reader or another supported Microsoft report-reader role. " : "The signed-in user also needs Directory Readers, Global Reader, or another supported license-catalog reader role. "}Sign out and sign in after changing access.`
        : `${label} is unavailable because the required permission was denied.`;
    }
    if (error.code === "provider_result_limit") return `${label} exceeded the bounded page or result limit; no truncated data was returned.`;
    if (error.code === "provider_response_size_limit") return `${label} exceeded the response-size safety limit, not the user-count limit. Check the backend's copilot_license_response_size_limit diagnostic; additional permissions will not fix this payload-size issue. No truncated data was returned.`;
    if (error.code === "provider_count_mismatch") return `${label} did not match Microsoft Graph's total count. The directory may have changed during paging; refresh usage. No incomplete license count was returned.`;
    if (error.code === "report_license_verification_unavailable") return `${label} could not verify active report identities. ${error.message}`;
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
