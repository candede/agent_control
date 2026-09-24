import { setTimeout as delay } from "node:timers/promises";
import { AppError, isTimeoutError } from "../errors.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import { graphError, type FetchLike } from "./graphPackages.js";
import { boundedProviderJson } from "./providerJson.js";
import { verifiedAgentIdentityClientIdProvenance, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";

export type AgentIdentityResult = VerifiedAgentIdentityIds;

export class GraphAgentIdentityClient {
  constructor(private readonly fetcher: FetchLike = fetch,
    private readonly wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })) {}

  async resolve(token: string, candidate: string, signal: AbortSignal, beforeRequest: () => Promise<void>): Promise<AgentIdentityResult> {
    if (!isDirectoryObjectId(candidate)) throw new AppError(400, "invalid_agent_identity_source", "An exact nonzero source candidate is required.");
    const url = `https://graph.microsoft.com/v1.0/servicePrincipals/${encodeURIComponent(candidate)}/microsoft.graph.agentIdentity?$select=id,servicePrincipalType`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      await beforeRequest();
      signal.throwIfAborted();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      let response: Response;
      try {
        response = await this.fetcher(url, { signal: requestSignal, redirect: "error",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json;odata.metadata=full" } });
      } catch (error) {
        signal.throwIfAborted();
        if (isTimeoutError(error) || requestSignal.aborted) throw new AppError(504, "provider_timeout", "The typed agent identity lookup timed out.");
        throw new AppError(502, "provider_network_error", "The typed agent identity lookup could not reach Microsoft Graph.");
      }
      if (!response.ok) {
        const error = await graphError(response, requestSignal);
        if (response.status === 401 || response.status === 403) {
          throw new AppError(response.status, "agent_identity_permission_required",
            "An administrator must add delegated AgentIdentity.Read.All under API permissions in the existing Entra app registration and select Grant admin consent. Microsoft Entra target authorization is also required (Agent ID Administrator for nonowners).",
            { capabilityId: "graph.agentIdentity.read", provider: error.details });
        }
        if (response.status === 404) throw new AppError(404, "agent_identity_not_found",
          "The typed lookup found no accessible agentIdentity for the saved candidate in the current tenant. Refresh Agents; no other identity namespace was tried.");
        const retryAfter = typeof error.details === "object" && error.details !== null && "retryAfterMs" in error.details
          && typeof error.details.retryAfterMs === "number" ? error.details.retryAfterMs : 250;
        if (attempt === 0 && [429, 500, 502, 503, 504].includes(response.status) && retryAfter <= 2_000) {
          await this.wait(retryAfter, signal);
          continue;
        }
        throw error;
      }
      const body = await boundedProviderJson<unknown>(response, requestSignal, 32_768);
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
