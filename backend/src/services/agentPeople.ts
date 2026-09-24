import type pg from "pg";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { AgentPeopleRepository, type AgentPersonObservation } from "../db/agentPeople.js";
import { DataSyncRepository, type DataSyncScope, type UserSourcePublication } from "../db/dataSync.js";
import { pool } from "../db/pool.js";
import { beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
import { AppError, errorTelemetry, isTimeoutError } from "../errors.js";
import { hasAppRole } from "../types/capability.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import type { AuthenticatedUser } from "../types/session.js";
import { capabilities } from "./capabilities.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { directoryPeople } from "./savedAgentPeople.js";
import { operationalLog } from "./telemetry.js";

type Dependencies = {
  repository: Pick<AgentPeopleRepository, "generation" | "referencedIds" | "read" | "save">;
  directory: Pick<DirectoryPrincipalsClient, "resolve">;
  saved: Pick<DataSyncRepository, "getDirectorySource">;
  revalidateUser: typeof revalidateAuthenticatedUser;
  delegatedToken: typeof acquireDelegatedToken;
  requireAvailable: typeof capabilities.requireAvailable;
  observeOperation: typeof capabilities.observeOperation;
  admissions: typeof requireProviderAdmissions;
  now: () => Date;
};

export class AgentPeopleService {
  private readonly dependencies: Dependencies;

  constructor(database: pg.Pool = pool, dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      repository: new AgentPeopleRepository(database), directory: new DirectoryPrincipalsClient(),
      saved: new DataSyncRepository(database), revalidateUser: revalidateAuthenticatedUser,
      delegatedToken: acquireDelegatedToken, requireAvailable: capabilities.requireAvailable.bind(capabilities),
      observeOperation: capabilities.observeOperation.bind(capabilities),
      admissions: requireProviderAdmissions, now: () => new Date(), ...dependencies,
    };
  }

  generation(scope: DataSyncScope) {
    return this.dependencies.repository.generation(scope);
  }

  async refreshReferences(user: AuthenticatedUser, signal: AbortSignal, publication: UserSourcePublication,
    options: { incompleteOnly: boolean }) {
    throwIfResolutionAborted(signal);
    const scope = userScope(user);
    const generation = await this.generation(scope);
    throwIfResolutionAborted(signal);
    const ids = await this.dependencies.repository.referencedIds(scope);
    throwIfResolutionAborted(signal);
    return this.resolve(user, ids, { generation, publication, signal, force: true, skipLicensed: true, ...options });
  }

  async resolve(user: AuthenticatedUser, ids: readonly string[], options: {
    generation: string; signal?: AbortSignal; publication?: UserSourcePublication; force?: boolean; skipLicensed?: boolean; incompleteOnly?: boolean;
  }) {
    if (options.signal) throwIfResolutionAborted(options.signal);
    const scope = userScope(user);
    if (ids.length > 10_000 || ids.some(id => !isDirectoryObjectId(id))) {
      throw new AppError(400, "invalid_agent_people", "Resolve at most 10,000 exact agent user IDs.");
    }
    const directorySource = await this.dependencies.saved.getDirectorySource(scope);
    if (options.signal) throwIfResolutionAborted(options.signal);
    const saved = directoryPeople(directorySource);
    const unique = [...new Set(ids.map(id => id.toLowerCase()))];
    const cachedPeople = await this.dependencies.repository.read(scope, unique);
    if (options.signal) throwIfResolutionAborted(options.signal);
    const cached = new Map(cachedPeople.map(person => [person.objectId, person]));
    const pending = unique.filter(id => {
      if (options.skipLicensed && saved.has(id)) return false;
      if (options.incompleteOnly) return !cached.has(id) || cached.get(id)?.status === "lookup_failed";
      return options.force || !saved.has(id) && !cached.has(id);
    });
    const result = { changed: false, resolved: 0, notFound: 0, failed: 0 };
    if (!pending.length) return result;
    this.dependencies.admissions();
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    return this.dependencies.observeOperation("graph.directory.read", user,
      reportFailure => this.resolvePending(scope, pending, signal, options, result, reportFailure),
      { signal, clearOnSuccess: result => result.failed === 0 });
  }

  private async resolvePending(scope: DataSyncScope, pending: string[], signal: AbortSignal,
    options: { generation: string; publication?: UserSourcePublication }, result: { changed: boolean; resolved: number; notFound: number; failed: number },
    reportFailure: (error: unknown) => void) {
    throwIfResolutionAborted(signal);
    const validation = beginAccountSessionValidation(scope.tenantId, scope.principalId);
    const freshUser = await this.dependencies.revalidateUser(scope.principalId);
    throwIfResolutionAborted(signal);
    requireSameUser(scope, freshUser);
    const token = await commitAccountSessionValidation(validation, async () => {
      throwIfResolutionAborted(signal);
      await this.dependencies.requireAvailable("graph.directory.read", freshUser);
      throwIfResolutionAborted(signal);
      return this.dependencies.delegatedToken(scope.principalId, "graph.directory.read");
    });
    for (let offset = 0; offset < pending.length; offset += 8) {
      throwIfResolutionAborted(signal);
      const observations = await Promise.all(pending.slice(offset, offset + 8).map(async (objectId): Promise<AgentPersonObservation> => {
        const checkedAt = this.dependencies.now().toISOString();
        try {
          const values = await this.dependencies.directory.resolve(token, [{ resourceId: objectId, resourceType: "user" }], signal);
          const person = values[0];
          if (values.length !== 1 || person.resourceId.toLowerCase() !== objectId || person.resourceType !== "user"
            || !["user", "unknown"].includes(person.principalKind)) {
            throw new AppError(502, "principal_identity_mismatch", "Directory lookup did not return the exact requested user.");
          }
          return person.principalKind === "unknown"
            ? { objectId, checkedAt, status: "not_found", displayName: null, userPrincipalName: null }
            : { objectId, checkedAt, status: "resolved",
              displayName: boundedName(person.displayName.toLowerCase() === objectId ? null : person.displayName, 512),
              userPrincipalName: boundedName(person.userPrincipalName ?? null, 320) };
        } catch (error) {
          reportFailure(error);
          throwIfResolutionAborted(signal);
          const telemetry = errorTelemetry(error, "directory_lookup_failed");
          const errorCode = telemetry.errorKind === "timeout" ? "provider_timeout"
            : telemetry.status === 403 ? "missing_permission" : telemetry.status === 401 ? "unauthorized"
            : telemetry.status === 429 ? "provider_throttled"
              : /^[a-z][a-z0-9_]{0,127}$/.test(telemetry.errorCode) ? telemetry.errorCode : "directory_lookup_failed";
          operationalLog("warn", "agent_person_lookup_failed", { ...telemetry, errorCode });
          return { objectId, checkedAt, status: "lookup_failed", displayName: null, userPrincipalName: null,
            errorCode };
        }
      }));
      throwIfResolutionAborted(signal);
      const current = await this.dependencies.revalidateUser(scope.principalId);
      throwIfResolutionAborted(signal);
      requireSameUser(scope, current);
      await commitAccountSessionValidation(validation, async () => {
        throwIfResolutionAborted(signal);
        this.dependencies.admissions();
        await this.dependencies.requireAvailable("graph.directory.read", current);
        throwIfResolutionAborted(signal);
        await this.dependencies.repository.save(scope, observations, { ...options, signal });
      });
      result.changed = true;
      for (const observation of observations) {
        if (observation.status === "resolved") result.resolved += 1;
        else if (observation.status === "not_found") result.notFound += 1;
        else result.failed += 1;
      }
      if (offset + 8 < pending.length
        && observations.some(value => ["provider_throttled", "missing_permission", "unauthorized"].includes(value.errorCode ?? ""))) {
        throw new AppError(503, "agent_people_incomplete", "Agent people sync stopped after a directory authorization or throttling failure. Retry after resolving it.");
      }
    }
    return result;
  }
}

export const agentPeople = new AgentPeopleService();

function userScope(user: AuthenticatedUser): DataSyncScope {
  if (!user.tenantId || !user.homeAccountId || !hasAppRole(user.roles, "AgentControl.Viewer")) {
    throw new AppError(403, "missing_internal_role", "Agent people require a tenant-scoped Viewer session.");
  }
  return { tenantId: user.tenantId, principalId: user.homeAccountId };
}

function requireSameUser(scope: DataSyncScope, user: AuthenticatedUser) {
  const current = userScope(user);
  if (current.tenantId !== scope.tenantId || current.principalId !== scope.principalId) {
    throw new AppError(403, "scope_mismatch", "Agent people authorization changed during the lookup.");
  }
}

function boundedName(value: string | null, maximum: number) {
  if (value === null || !value.trim()) return null;
  if (value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new AppError(502, "provider_schema", "Directory user metadata is invalid.");
  }
  return value;
}

function throwIfResolutionAborted(signal: AbortSignal) {
  if (signal.aborted && isTimeoutError(signal.reason)) {
    throw new AppError(504, "provider_timeout", "Agent people resolution exceeded its bounded deadline.");
  }
  signal.throwIfAborted();
}
