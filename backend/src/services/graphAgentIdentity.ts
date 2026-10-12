import { setTimeout as delay } from "node:timers/promises";
import { AppError, isTimeoutError } from "../errors.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import { graphError, graphResponseError, type FetchLike } from "./graphPackages.js";
import { boundedProviderJson, parseProviderContractJson } from "./providerJson.js";
import { verifiedAgentIdentityClientIdProvenance, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";

export type AgentIdentityResult = VerifiedAgentIdentityIds;

export class GraphAgentIdentityClient {
  constructor(private readonly fetcher: FetchLike = fetch,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>
      = (ms, signal) => delay(ms, undefined, { signal })) {}

  async resolve(token: string, candidate: string, signal: AbortSignal, beforeRequest: () => Promise<void>,
    assertCurrent?: () => void): Promise<AgentIdentityResult> {
    if (!isDirectoryObjectId(candidate) || candidate === "00000000-0000-0000-0000-000000000000") throw new AppError(400, "invalid_agent_identity_source", "An exact nonzero source candidate is required.");
    candidate = candidate.toLowerCase();
    const url = `https://graph.microsoft.com/v1.0/servicePrincipals/${encodeURIComponent(candidate)}/microsoft.graph.agentIdentity?$select=id,servicePrincipalType`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await awaitCurrent(signal, beforeRequest, assertCurrent);
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      let response: Response | undefined;
      let body: unknown;
      let providerError: AppError | undefined;
      let onAbort: (() => void) | undefined;
      try {
        requestSignal.throwIfAborted();
        assertCurrent?.();
        const fetching = this.fetcher(url, { signal: requestSignal, redirect: "error",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json;odata.metadata=full" } });
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(requestSignal.reason);
          if (requestSignal.aborted) onAbort();
          else requestSignal.addEventListener("abort", onAbort, { once: true });
        });
        // A non-cooperative transport must not retain the operation or its late body.
        void fetching.then(value => {
          if (requestSignal.aborted) void value.body?.cancel().catch(() => undefined);
        }, () => undefined);
        response = await Promise.race([fetching, aborted]);
        try {
          signal.throwIfAborted();
          assertCurrent?.();
        } catch (error) {
          void response.body?.cancel().catch(() => undefined);
          throw error;
        }
        if (!response.ok) providerError = await graphError(response, requestSignal);
        else body = await boundedProviderJson<unknown>(response, requestSignal, 32_768,
          text => parseProviderContractJson(text, { root: { fields: ["@odata.type", "id", "servicePrincipalType"] } }, 1));
        requestSignal.throwIfAborted();
        assertCurrent?.();
      } catch (error) {
        signal.throwIfAborted();
        assertCurrent?.();
        if (response && !response.ok && (isTimeoutError(error) || requestSignal.aborted)) {
          // A body deadline cannot erase the status and retry headers already received.
          providerError ??= graphResponseError(response);
        } else if (isTimeoutError(error) || requestSignal.aborted) {
          throw new AppError(504, "provider_timeout", "The typed agent identity lookup timed out.");
        } else if (error instanceof AppError) throw error;
        else throw new AppError(502, "provider_network_error", "The typed agent identity lookup could not reach Microsoft Graph.");
      } finally {
        if (onAbort) requestSignal.removeEventListener("abort", onAbort);
      }
      if (providerError) {
        if (providerError.status === 401 || providerError.status === 403) {
          throw new AppError(providerError.status, "agent_identity_permission_required",
            "An administrator must add delegated AgentIdentity.Read.All under API permissions in the existing Entra app registration and select Grant admin consent. Microsoft Entra target authorization is also required (Agent ID Administrator for nonowners).",
            { capabilityId: "graph.agentIdentity.read", provider: providerError.details });
        }
        if (providerError.status === 404) throw new AppError(404, "agent_identity_not_found",
          "The typed lookup found no accessible agentIdentity for the saved candidate in the current tenant. Refresh Agents; no other identity namespace was tried.",
          providerError.details);
        const retryAfter = typeof providerError.details === "object" && providerError.details !== null && "retryAfterMs" in providerError.details
          && typeof providerError.details.retryAfterMs === "number" ? providerError.details.retryAfterMs : 250;
        if (attempt === 0 && [429, 500, 502, 503, 504].includes(providerError.status) && retryAfter <= 2_000) {
          await awaitCurrent(signal, () => this.wait(retryAfter, signal), assertCurrent);
          continue;
        }
        throw providerError;
      }
      // The typed endpoint establishes the resource type; Graph can omit @odata.type.
      if (!body || typeof body !== "object" || Array.isArray(body)
        || ("@odata.type" in body && body["@odata.type"] !== "#microsoft.graph.agentIdentity")
        || !("servicePrincipalType" in body) || body.servicePrincipalType !== "ServiceIdentity"
        || !("id" in body) || typeof body.id !== "string" || !isDirectoryObjectId(body.id)
        || body.id.toLowerCase() !== candidate.toLowerCase()) {
        throw new AppError(502, "agent_identity_mismatch", "Microsoft Graph did not return the exact typed agentIdentity requested.");
      }
      // Only agentIdentity defines object ID == client ID, not ordinary service principals or blueprints.
      // https://learn.microsoft.com/en-us/entra/agent-id/agent-identities#authorizing-agent-identities
      const identityId = body.id.toLowerCase();
      return { objectId: identityId, applicationId: identityId, runtimeStatus: "available",
        runtimeProvenance: verifiedAgentIdentityClientIdProvenance };
    }
    throw new AppError(502, "provider_error", "The bounded typed identity lookup did not complete.");
  }
}

async function awaitCurrent<T>(signal: AbortSignal, operation: () => Promise<T>, assertCurrent?: () => void): Promise<T> {
  signal.throwIfAborted();
  assertCurrent?.();
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const work = operation();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const result = await Promise.race([work, aborted]);
    signal.throwIfAborted();
    assertCurrent?.();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    assertCurrent?.();
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
