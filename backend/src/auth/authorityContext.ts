import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../errors.js";
import { authorizationFreshnessMs } from "./mcpBearer.js";
import type { DelegatedCredentialSource } from "../types/requestPrincipal.js";
import type { AuthenticatedUser } from "../types/session.js";

// Async work inherits the initiating source, never a later request for the same account.
const authority = new AsyncLocalStorage<DelegatedCredentialSource>();

export function currentAuthority() { return authority.getStore(); }

export function pruneAuthorities(sources: Map<string, DelegatedCredentialSource>) {
  for (const [id, source] of sources) {
    try { source.assertCurrent(); }
    catch (error) {
      if (!(error instanceof AppError) || error.status !== 401) throw error;
      sources.delete(id);
    }
  }
}

export function withAuthority<T>(source: DelegatedCredentialSource, operation: () => T): T {
  source.assertCurrent();
  return authority.run(source, operation);
}

export function withoutAuthority<T>(operation: () => T): T {
  return authority.exit(operation);
}

export async function withReadAuthorityRefresh<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
  const source = currentAuthority();
  if (!source || source.principal.transport !== "browser") return operation();
  controller.signal.throwIfAborted();
  source.assertCurrent();
  const authorizationHash = source.principal.authorizationHash;
  const assertUnchangedAuthorization = () => {
    if (source.principal.authorizationHash !== authorizationHash) throw AppError.unauthorized("The initiating authorization changed.");
  };
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    source.assertCurrent();
    assertUnchangedAuthorization();
  };
  const refreshController = new AbortController();
  const signal = AbortSignal.any([controller.signal, refreshController.signal]);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  const schedule = () => {
    if (stopped || signal.aborted) return;
    const remaining = source.principal.rolesValidatedAt + authorizationFreshnessMs / 2 - Date.now();
    timer = setTimeout(() => {
      if (stopped || signal.aborted) return;
      renewal = Promise.resolve().then(async () => {
        assertUnchangedAuthorization();
        if (source.principal.rolesValidatedAt + authorizationFreshnessMs / 2 > Date.now()) {
          assertCurrent();
          return;
        }
        await source.revalidate(signal);
        assertCurrent();
      }).catch(error => {
        if (!stopped && !controller.signal.aborted) controller.abort(error);
      }).finally(() => {
        renewal = undefined;
        schedule();
      });
    }, Math.max(0, remaining));
    timer.unref();
  };
  schedule();
  try {
    const result = await operation();
    assertCurrent();
    return result;
  } catch (error) {
    assertCurrent();
    throw error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    refreshController.abort();
    await renewal;
  }
}

export function requireAuthority(tenantId?: string, principalId?: string) {
  const source = currentAuthority();
  if (!source || tenantId !== undefined && source.principal.tenantId !== tenantId
    || principalId !== undefined && source.principal.principalId !== principalId) {
    throw new AppError(401, "authorization_required", "Fresh authorization from the initiating account is required.");
  }
  source.assertCurrent();
  return source;
}

export function authorityUser(source: DelegatedCredentialSource): AuthenticatedUser {
  source.assertCurrent();
  const principal = source.principal;
  return { tenantId: principal.tenantId, homeAccountId: principal.principalId,
    username: principal.username, displayName: principal.displayName,
    roles: [...principal.roles], providerRoleIds: [...principal.providerRoleIds] };
}
