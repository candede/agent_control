import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../errors.js";
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
