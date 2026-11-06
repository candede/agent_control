import { acquireApplicationToken } from "../auth/msal.js";
import { assertAuthSignal, boundedAuthBody, SharedAuthOperation } from "../auth/boundedAuth.js";
import { authorizationFreshnessMs } from "../auth/mcpBearer.js";
import { withAuthority } from "../auth/authorityContext.js";
import { tenantConfigurationFingerprint } from "../auth/flows.js";
import { getTenantConfiguration } from "../config.js";
import { AppError } from "../errors.js";
import type { DelegatedCredentialSource } from "../types/requestPrincipal.js";
import { isGraphGuid } from "../types/copilotUsage.js";
import { parseActiveMember } from "./userSourceGraphFields.js";

type Evidence = { expiresAt: number; active: boolean };
type Entry = { operation: SharedAuthOperation<Evidence>; settled: boolean };
const maximumEvidenceEntries = 1024;

export class EmployeeProfileService {
  private readonly evidence = new Map<string, Entry>();
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly token = acquireApplicationToken) {}

  async verify(source: DelegatedCredentialSource, signal?: AbortSignal): Promise<void> {
    source.assertCurrent();
    assertAuthSignal(signal);
    const principal = source.principal;
    if (principal.roles.length) return;
    if (!isGraphGuid(principal.localAccountId)) throw AppError.unauthorized("Employee eligibility requires the tenant-local account ID.");
    const fingerprint = tenantConfigurationFingerprint(getTenantConfiguration(principal.tenantId));
    const key = JSON.stringify([principal.tenantId, principal.principalId, principal.localAccountId,
      principal.authorizationHash, principal.sessionEpoch, principal.authenticatedAt, principal.expiresAt, fingerprint]);
    let entry = this.evidence.get(key);
    if (!entry || entry.operation.aborted) {
      if (this.evidence.size >= maximumEvidenceEntries) {
        const oldest = [...this.evidence].find(([, value]) => value.settled)?.[0];
        if (oldest === undefined) throw new AppError(429, "employee_verification_capacity", "Employee verification is at capacity. Retry shortly.");
        this.evidence.delete(oldest);
      }
      const operation = new SharedAuthOperation(async providerSignal => {
        const accessToken = await withAuthority(source, () => this.token(principal.tenantId, "graph.users.read"));
        source.assertCurrent();
        assertAuthSignal(providerSignal);
        const response = await this.fetcher(`https://graph.microsoft.com/v1.0/users/${principal.localAccountId}?$select=id,accountEnabled,userType`, {
          headers: { Authorization: `Bearer ${accessToken}` }, redirect: "manual", signal: providerSignal,
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return { active: false, expiresAt: Math.min(source.expiresAt, Date.now() + authorizationFreshnessMs) };
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new AppError(503, "employee_verification_unavailable", "Microsoft Graph could not verify active employee membership.");
        }
        let body: unknown;
        try { body = JSON.parse(await boundedAuthBody(response, 16 * 1024, providerSignal)); }
        catch (error) {
          assertAuthSignal(providerSignal);
          if (error instanceof AppError) throw error;
          throw new AppError(502, "provider_schema", "Employee membership returned invalid JSON.");
        }
        const active = parseActiveMember(body, principal.localAccountId);
        source.assertCurrent();
        return { active, expiresAt: Math.min(source.expiresAt, Date.now() + authorizationFreshnessMs) };
      });
      entry = { operation, settled: false };
      this.evidence.set(key, entry);
    }
    let result: Evidence;
    try { result = await entry.operation.wait(signal); }
    catch (error) {
      if (this.evidence.get(key) === entry && (entry.operation.aborted || !(error instanceof AppError) || error.code !== "authentication_cancelled")) this.evidence.delete(key);
      if (error instanceof AppError) throw error;
      this.evidence.delete(key);
      throw new AppError(503, "employee_verification_unavailable", "Microsoft Graph could not verify active employee membership.");
    }
    entry.settled = true;
    source.assertCurrent();
    if (source.principal !== principal || tenantConfigurationFingerprint(getTenantConfiguration(principal.tenantId)) !== fingerprint) {
      throw AppError.unauthorized("Employee authorization changed during verification.");
    }
    if (result.expiresAt <= Date.now()) {
      this.evidence.delete(key);
      return this.verify(source, signal);
    }
    if (!result.active) throw new AppError(403, "employee_required", "Default discovery requires an active member account in the configured tenant.");
  }
}
