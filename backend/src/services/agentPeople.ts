import type pg from "pg";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { AgentPeopleRepository, type AgentPersonObservation } from "../db/agentPeople.js";
import { DataSyncRepository, type DataSyncScope, type UserSourcePublication } from "../db/dataSync.js";
import { pool } from "../db/pool.js";
import { assertAccountSessionValidation, beginAccountSessionValidation, commitAccountSessionValidation } from "../db/sessions.js";
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

type ResolutionOptions = {
  generation: string; publication?: UserSourcePublication; force?: boolean; skipLicensed?: boolean; incompleteOnly?: boolean;
};
type ResolutionContext = ReturnType<typeof resolutionContext>;

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
    options: { incompleteOnly: boolean; useCache?: boolean }) {
    const context = resolutionContext(user, signal);
    return awaitResolution(context.signal, async () => {
      assertCurrent(context);
      const generation = await this.generation(context.scope);
      assertCurrent(context);
      const ids = await this.dependencies.repository.referencedIds(context.scope);
      assertCurrent(context);
      return this.resolveCurrent(user, ids, { generation, publication, force: !options.useCache, skipLicensed: true, ...options }, context);
    });
  }

  async resolve(user: AuthenticatedUser, ids: readonly string[], options: ResolutionOptions & { signal?: AbortSignal }) {
    const context = resolutionContext(user, options.signal);
    return awaitResolution(context.signal, () => this.resolveCurrent(user, ids, options, context));
  }

  private async resolveCurrent(user: AuthenticatedUser, ids: readonly string[], options: ResolutionOptions, context: ResolutionContext) {
    assertCurrent(context);
    const { scope, signal } = context;
    if (ids.length > 10_000 || ids.some(id => !isDirectoryObjectId(id))) {
      throw new AppError(400, "invalid_agent_people", "Resolve at most 10,000 exact agent user IDs.");
    }
    const directorySource = await this.dependencies.saved.getDirectorySource(scope);
    assertCurrent(context);
    const saved = directoryPeople(directorySource);
    const unique = [...new Set(ids.map(id => id.toLowerCase()))];
    const cachedPeople = await this.dependencies.repository.read(scope, unique);
    assertCurrent(context);
    const cached = new Map(cachedPeople.map(person => [person.objectId, person]));
    const pending = unique.filter(id => {
      if (options.skipLicensed && saved.has(id)) return false;
      if (options.incompleteOnly) return !cached.has(id) || cached.get(id)?.status === "lookup_failed";
      return options.force || !saved.has(id) && !cached.has(id);
    });
    const result = { changed: false, resolved: 0, notFound: 0, failed: 0 };
    if (!pending.length) return result;
    this.dependencies.admissions();
    const resolved = await this.dependencies.observeOperation("graph.directory.read", user,
      reportFailure => this.resolvePending(context, pending, options, result, reportFailure),
      { signal, clearOnSuccess: result => result.failed === 0 });
    assertCurrent(context);
    this.dependencies.admissions();
    return resolved;
  }

  private async resolvePending(context: ResolutionContext, pending: string[],
    options: { generation: string; publication?: UserSourcePublication }, result: { changed: boolean; resolved: number; notFound: number; failed: number },
    reportFailure: (error: unknown) => void) {
    const { scope, signal, validation } = context;
    const fence = () => {
      assertCurrent(context);
      this.dependencies.admissions();
    };
    const wait = <T>(operation: () => Promise<T>) => awaitResolution(signal, operation);
    fence();
    const freshUser = await wait(() => this.dependencies.revalidateUser(scope.tenantId, scope.principalId));
    fence();
    requireSameUser(scope, freshUser);
    const token = await wait(() => commitAccountSessionValidation(validation, async () => {
      fence();
      await wait(() => this.dependencies.requireAvailable("graph.directory.read", freshUser));
      fence();
      return wait(() => this.dependencies.delegatedToken(scope.tenantId, scope.principalId, "graph.directory.read"));
    }));
    for (let offset = 0; offset < pending.length; offset += 8) {
      fence();
      const observations = await Promise.all(pending.slice(offset, offset + 8).map(async (objectId): Promise<AgentPersonObservation> => {
        fence();
        const checkedAt = this.dependencies.now().toISOString();
        try {
          const values = await this.dependencies.directory.resolve(token, [{ resourceId: objectId, resourceType: "user" }], signal);
          fence();
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
          fence();
          reportFailure(error);
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
      fence();
      const current = await wait(() => this.dependencies.revalidateUser(scope.tenantId, scope.principalId));
      fence();
      requireSameUser(scope, current);
      await wait(() => commitAccountSessionValidation(validation, async () => {
        fence();
        await wait(() => this.dependencies.requireAvailable("graph.directory.read", current));
        fence();
        // Hold account serialization until the transaction commits or rolls back, even after the caller times out.
        await this.dependencies.repository.save(scope, observations, { generation: options.generation,
          publication: options.publication, signal, fence });
        fence();
      }));
      fence();
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

function resolutionContext(user: AuthenticatedUser, abortSignal?: AbortSignal) {
  const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(abortSignal ? [abortSignal] : [])]);
  throwIfResolutionAborted(signal);
  const scope = userScope(user);
  return { signal, scope, validation: beginAccountSessionValidation(scope.tenantId, scope.principalId) };
}

function assertCurrent(context: ResolutionContext) {
  throwIfResolutionAborted(context.signal);
  assertAccountSessionValidation(context.validation);
}

async function awaitResolution<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  throwIfResolutionAborted(signal);
  const work = operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      try { throwIfResolutionAborted(signal); } catch (error) { reject(error); }
    };
    work.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
      else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
      else reject(error);
    });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

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
