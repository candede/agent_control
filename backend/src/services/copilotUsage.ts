import type pg from "pg";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { config } from "../config.js";
import { requireUserPublication, type UserSourcePublication } from "../db/dataSync.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { UserSourcesRepository } from "../db/userSources.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { UserSourceKind, UserSourceMetadata } from "../types/userSources.js";
import { hasAppRole } from "../types/capability.js";
import { capabilities } from "./capabilities.js";
import { UserSourceProvider } from "./userSourceProvider.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { reportIdentity } from "./reportIdentity.js";
import { requireProviderAdmissions } from "./operationalState.js";
import type { CapabilityId } from "../types/capability.js";
import { graphErrorTelemetry } from "./graphPackages.js";
import { operationalLog } from "./telemetry.js";

export type CopilotUsageRefreshResult = {
  status: "succeeded" | "partial" | "waiting_authorization" | "permission_required" | "failed";
  count: number | null; message: string;
};
type Dependencies = {
  provider: UserSourceProvider; revalidateUser: typeof revalidateAuthenticatedUser;
  delegatedToken: typeof acquireDelegatedToken;
  requireAvailable: (capability: CapabilityId, user: AuthenticatedUser) => Promise<unknown>; observeOperation: typeof capabilities.observeOperation;
  admissions: typeof requireProviderAdmissions;
};
export class CopilotUsageService {
  private readonly stages: UserSourceStages;
  private readonly sources: UserSourcesRepository;
  private readonly reports: LargeTenantUsersReports;
  private readonly dependencies: Dependencies;
  constructor(readonly database: pg.Pool, dependencies: Partial<Dependencies> = {}) {
    this.stages = new UserSourceStages(database);
    this.reports = new LargeTenantUsersReports(database, config.sessionSecret, config.officialUsageStaleDays);
    this.sources = this.reports.sources;
    this.dependencies = { provider: new UserSourceProvider(), revalidateUser: revalidateAuthenticatedUser,
      delegatedToken: acquireDelegatedToken, requireAvailable: capabilities.requireAvailable.bind(capabilities),
      observeOperation: capabilities.observeOperation.bind(capabilities), admissions: requireProviderAdmissions, ...dependencies };
  }
  async refreshUsers(user: AuthenticatedUser, signal: AbortSignal | undefined, options: {
    incompleteOnly?: boolean; automatic?: boolean; signedInAt?: number; publication: UserSourcePublication;
    onDirectoryProgress?: (count: number) => void | Promise<void>;
  }): Promise<CopilotUsageRefreshResult> {
    const identity = await reportIdentity(this.database, user), scope = { tenantId: identity.tenantId, principalId: identity.principalId };
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const fence = () => { signal?.throwIfAborted(); assertAccountSessionValidation(validation); this.dependencies.admissions(); };
    fence();
    const before = await this.sources.refreshStatus(identity, "delegated");
    const due = (source: UserSourceMetadata) => {
      if (!options.automatic) return !options.incompleteOnly || source.generationId === null || source.attemptStatus !== "available";
      if (source.attemptStatus === "waiting_authorization" && source.attemptedAt && options.signedInAt !== undefined
        && Date.parse(source.attemptedAt) < options.signedInAt) return true;
      if (source.attemptedAt && source.attemptStatus !== "available" && Date.now() - Date.parse(source.attemptedAt) < 900000) return false;
      return !source.generationId || !source.observedAt || Date.now() - Date.parse(source.observedAt) >= (source.source === "directory" ? 900000 : 21600000);
    };
    const requested = (["directory", "app_activity"] as const).filter(source => due(before.sources[source]));
    if (!requested.length) return { status: before.status, count: before.count, message: "Current saved user sources do not require collection." };
    fence();
    const outcomes = await Promise.allSettled(requested.map(async source => {
      const capability = source === "directory" ? "graph.licenses.read" : "reports.copilotUsage.read";
      const authorize = async (_source: UserSourceKind, providerSignal: AbortSignal) => {
        fence(); providerSignal.throwIfAborted();
        const fresh = await this.dependencies.revalidateUser(scope.tenantId, scope.principalId);
        return commitAccountSessionValidation(validation, async () => {
          fence(); providerSignal.throwIfAborted();
          if (fresh.tenantId !== scope.tenantId || fresh.homeAccountId !== scope.principalId
            || !hasAppRole(fresh.roles, "AgentControl.Viewer")) throw AppError.unauthorized();
          await this.dependencies.requireAvailable(capability, fresh);
          fence(); providerSignal.throwIfAborted();
          const token = await this.dependencies.delegatedToken(scope.tenantId, scope.principalId, capability);
          fence(); providerSignal.throwIfAborted();
          return token;
        });
      };
      const now = new Date();
      await this.dependencies.observeOperation(capability, user, () => this.dependencies.provider.refresh(this.stages, {
        scope: { kind: "principal", ...scope, tokenMode: "delegated", source, selector: "complete" },
        sessionEpoch: identity.sessionEpoch, schemaVersion: 1, jobKind: "data_sync",
        jobId: options.publication.jobId, runId: options.publication.runId,
        observedAt: now, expiresAt: new Date(now.getTime() + 7 * 86400000),
        deadlineAt: new Date(now.getTime() + 30 * 60000), reserveBytes: 8 * 1024 ** 3,
      }, {
        authorize, signal,
        identities: source === "directory" ? async (lease, providerSignal) => {
          providerSignal.throwIfAborted();
          const selected = await this.reports.captureReportIdentities(identity);
          providerSignal.throwIfAborted();
          return this.reports.feedPositiveIdentities(selected.id, identity, this.stages, lease);
        } : undefined,
        progress: async count => { fence(); await options.onDirectoryProgress?.(count); fence(); },
        completeJob: async (client, result) => {
          fence();
          await requireUserPublication(client, scope, options.publication);
          // Each source's published attempt is terminal in this transaction. The
          // shared Users job remains running until both sources and people settle.
          await client.query(`UPDATE data_sync_run_sources SET updated_at=clock_timestamp(),
            count=CASE WHEN $5='directory' THEN $6 ELSE count END
            WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND job_id=$4 AND source_id='users' AND status='running'`,
          [options.publication.runId, scope.tenantId, scope.principalId, options.publication.jobId, result.source, result.rows]);
        },
      }), { signal });
    }));
    fence();
    for (const [index, outcome] of outcomes.entries()) if (outcome.status === "rejected") {
      operationalLog("warn", "user_source_refresh_failed", {
        source: requested[index], ...graphErrorTelemetry(outcome.reason),
      });
    }
    const after = await this.sources.refreshStatus(identity, "delegated");
    const failed = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [requested[index]] : []);
    return { status: after.status === "succeeded" && failed.length ? "partial" : after.status,
      count: requested.includes("directory") ? after.sources.directory.attemptObservedCount : null,
      message: [Object.values(after.sources).map(source => source.message ?? `${userSourceLabel(source.source)}: not available`).join(" "),
        ...(failed.length ? [`Latest ${failed.map(userSourceLabel).join(" and ")} collection did not complete.`] : [])].join(" ") };
  }
}

function userSourceLabel(source: UserSourceKind) {
  return source === "directory" ? "directory users" : "Office app activity";
}
