import { AppError } from "../errors.js";
import { createHash } from "node:crypto";
import type { AgentIdentityCacheStatus, AgentInvestigationContext, AgentInvestigationReasonCode, AgentInvestigationScope, AgentPurviewTarget } from "../types/agentInvestigations.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";
import { AgentIdentityRepository, type AgentIdentityCacheState, type AgentIdentitySource } from "../db/agentIdentity.js";
import { isDirectoryObjectId } from "../types/copilotPackage.js";
import type { DefenderHuntingFilters } from "../types/defenderHunting.js";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { unifiedAgents } from "./unifiedAgents.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { normalizeNativeIdentity, resolveExactInventoryIdentity } from "./inventoryIdentity.js";

type InventoryScope = Parameters<typeof unifiedAgents.list>[0];

const cacheReasons: Partial<Record<AgentIdentityCacheStatus, { reason: string; reasonCode: AgentInvestigationReasonCode }>> = {
  missing: { reason: "No typed directory mapping is saved for this current source. Explicitly resolve its log identity.",
    reasonCode: "identity_resolution_required" },
  expired: { reason: "The saved identity-resolution result expired. Explicitly resolve the current source again.",
    reasonCode: "identity_resolution_expired" },
  authorization_required: { reason: "The last explicit identity lookup required authorization. An administrator must add AgentIdentity.Read.All under API permissions in the existing Entra app registration and select Grant admin consent. MFA or Conditional Access requires normal sign-in; target access also requires Microsoft Entra authorization (Agent ID Administrator for nonowners).",
    reasonCode: "identity_authorization_required" },
  not_found: { reason: "The last explicit lookup found no accessible typed agentIdentity for this source candidate. Refresh Agents before retrying; no alternate namespace was used.",
    reasonCode: "identity_not_found" },
  provider_error: { reason: "The last bounded identity lookup failed. Review its diagnostic code and retry; this does not establish missing consent or licensing.",
    reasonCode: "identity_provider_error" },
  setup_required: { reason: "Identity resolution requires authentication connector setup. Complete the configured Microsoft Entra connection before retrying.",
    reasonCode: "identity_setup_required" },
};

export class AgentInvestigationsService {
  constructor(private readonly inventory: Pick<typeof unifiedAgents, "list" | "assertRevision"> = unifiedAgents,
    private readonly identities: Pick<PowerPlatformInventoryRepository, "readIdentityCandidates"> = new PowerPlatformInventoryRepository(),
    private readonly mappings: Pick<AgentIdentityRepository, "readState"> = new AgentIdentityRepository()) {}

  async resolve(scope: InventoryScope, value: unknown): Promise<{
    context: AgentInvestigationContext; purviewTarget?: AgentPurviewTarget; identitySource?: AgentIdentitySource; inventoryRevision?: string;
  }> {
    const recordId = investigationRecordId(value);
    const page = await this.inventory.list(scope, { recordId, limit: 1 });
    const record = page.value[0];
    if (page.count !== 1 || !record) throw new AppError(404, "agent_not_found", "The current saved agent is unavailable. Refresh Agents.");
    const resource = record.powerPlatformResource;
    const observation = record.observations.powerPlatform;
    const uncertain = record.identity.invalidMetadata || ["ambiguous", "conflicting"].includes(record.identity.state);
    const current = Boolean(page.revision) && resource?.type === "microsoft.copilotstudio/agents"
      && resource.tenantId.toLowerCase() === scope.tenantId.toLowerCase()
      && observation?.current === true && Date.parse(observation.expiresAt) > Date.now()
      && page.sources.powerPlatform.state !== "unavailable";
    const unsupported = !resource || resource.type !== "microsoft.copilotstudio/agents" || resource.agentKind === "agent_builder_agent";
    const commonReasonCode: AgentInvestigationReasonCode | undefined = unsupported ? "unsupported_identity_crosswalk"
      : uncertain ? "ambiguous_identity" : !current ? "stale_source" : undefined;
    const commonReason = unsupported ? "Provider-native logs may exist, including for Agent Builder, but a verified crosswalk from this saved agent's ResourceQuery or package identities is unavailable."
      : uncertain ? "Saved identity metadata is ambiguous or conflicting. Refresh and resolve the agent identity first."
      : !current ? "A current authorized Power Platform agent identity is required. Refresh Agents first." : undefined;
    const exactIds = (kind: "entra_app_id" | "cds_bot_id" | "entra_agent_id") => {
      const values = resource?.identifiers.filter(identifier => identifier.kind === kind).map(identifier => identifier.value) ?? [];
      if (values.some(id => !isDirectoryObjectId(id))) return [];
      return [...new Set(values.map(id => id.toLowerCase()))];
    };
    const applicationIds = exactIds("entra_app_id");
    const bots = exactIds("cds_bot_id");
    const agentIds = exactIds("entra_agent_id");
    const candidates = !commonReason && (applicationIds.length === 1 || bots.length === 1 || agentIds.length === 1)
      ? await this.identities.readIdentityCandidates(scope, ["microsoft.copilotstudio/agents"]).catch(error => {
        if (error instanceof AppError && error.code === "snapshot_invalidated") throw sourceChanged();
        throw error;
      }) : [];
    const unambiguous = (kind: "entra_app_id" | "cds_bot_id" | "entra_agent_id", ids: string[]) => {
      if (!resource || ids.length !== 1) return false;
      const match = resolveExactInventoryIdentity({ tenantId: resource.tenantId, nativeId: resource.nativeId,
        environmentId: resource.environmentId, sourceSystem: "power_platform", resourceType: resource.type,
        identifiers: [{ kind, value: ids[0] }] }, candidates);
      return match.status === "resolved" && normalizeNativeIdentity(match.candidate.nativeId) === normalizeNativeIdentity(resource.nativeId)
        && match.candidate.environmentId?.toLowerCase() === resource.environmentId?.toLowerCase();
    };
    const agentProvenance = resource?.provenance?.entraAgentId;
    const candidateMissing = !resource?.identifiers.some(identifier => identifier.kind === "entra_agent_id");
    const resolutionCode: AgentInvestigationReasonCode | undefined = commonReasonCode
      ?? (resource?.agentKind !== "copilot_studio_agent" ? "unsupported_identity_crosswalk"
        : candidateMissing ? "missing_identity_candidate"
          : agentIds.length !== 1 || agentProvenance?.sourceSystem !== "power_platform" || agentProvenance.path !== "properties.entraAgentId"
            ? "invalid_identity_candidate"
            : !unambiguous("entra_agent_id", agentIds) ? "ambiguous_identity"
              : !observation?.snapshotId || !isDirectoryObjectId(observation.snapshotId)
                || !resource.environmentId || record.environmentId?.toLowerCase() !== resource.environmentId.toLowerCase() ? "stale_source" : undefined);
    const resolutionReason = commonReason ?? (resolutionCode === "unsupported_identity_crosswalk" ? "The typed directory crosswalk requires a source-declared Copilot Studio agent. Other provider-native log identities need a separately verified crosswalk."
      : resolutionCode === "missing_identity_candidate" ? "The saved source does not supply properties.entraAgentId. Refresh the source; bot, package and blueprint IDs cannot substitute."
        : resolutionCode === "invalid_identity_candidate" ? "The saved Entra identity candidate or its properties.entraAgentId provenance is invalid."
          : resolutionCode === "ambiguous_identity" ? "The saved Entra identity candidate belongs to multiple agents or no longer identifies this source."
            : resolutionCode === "stale_source" ? "The source snapshot or environment is stale. Refresh Agents before resolving identity." : undefined);
    const identitySource: AgentIdentitySource | undefined = !resolutionCode && resource && observation?.snapshotId ? {
      recordId: record.id, snapshotId: observation.snapshotId, nativeId: resource.nativeId, environmentId: resource.environmentId!,
      candidateId: agentIds[0], sourceRevision: createHash("sha256").update(JSON.stringify([
        observation.snapshotId, resource.nativeId, resource.environmentId, agentIds[0], agentProvenance,
      ])).digest("hex"),
    } : undefined;
    const savedCache: AgentIdentityCacheState = identitySource ? await this.mappings.readState(scope, identitySource) : { status: "source_unavailable" };
    if (current && page.revision) {
      try { await this.inventory.assertRevision(scope, page.revision); }
      catch (error) {
        if (error instanceof AppError && error.code === "inventory_changed") throw sourceChanged();
        throw error;
      }
      if (!observation || Date.parse(observation.expiresAt) <= Date.now()) throw sourceChanged();
    }
    const cacheExpiresAt = savedCache.expiresAt ?? savedCache.value?.expiresAt;
    const cache: AgentIdentityCacheState = cacheExpiresAt && Date.parse(cacheExpiresAt) <= Date.now()
      ? { ...savedCache, status: "expired", value: undefined } : savedCache;
    const mapping = cache.status === "resolved" ? cache.value : undefined;
    const savedReason = resolutionReason ?? cacheReasons[cache.status]?.reason;
    const savedReasonCode = resolutionCode ?? cacheReasons[cache.status]?.reasonCode;
    const inventoryReason = mapping ? undefined : commonReason ?? savedReason
      ?? "Defender inventory requires a verified enterprise-application object ID. Explicitly resolve the saved Entra identity first.";
    const applicationProvenance = resource?.provenance?.entraAppId;
    const legacyAvailable = applicationIds.length === 1 && unambiguous("entra_app_id", applicationIds)
      && applicationProvenance?.sourceSystem === "power_platform" && applicationProvenance.path === "properties.entraAppId";
    const verifiedClientId = mapping?.runtimeProvenance === verifiedAgentIdentityClientIdProvenance
      && mapping.applicationId === mapping.objectId;
    const runtimeIds = mapping ? verifiedClientId ? [mapping.objectId] : [] : legacyAvailable ? applicationIds : [];
    const runtimeReason = commonReason ?? (mapping && !verifiedClientId
      ? "This cached mapping lacks verified agentIdentity client-ID provenance. Explicitly resolve again; equality is never assumed for ordinary service principals, blueprints or platform IDs."
      : runtimeIds.length !== 1
      ? savedReason ?? "Agent activity requires a verified own application/client ID from explicit typed directory resolution or the saved legacy properties.entraAppId. Enterprise object, package, bot and blueprint IDs cannot substitute." : undefined);
    const runtimeAvailability = { status: runtimeReason ? "unavailable" as const : "available" as const,
      ...(runtimeReason ? { reasonCode: commonReasonCode ?? (identitySource && !mapping
        ? savedReasonCode ?? "identity_resolution_required" as const : "application_identity_unavailable" as const) } : {}),
      reason: runtimeReason ?? (mapping ? "Verified Entra agentIdentity client ID: its object and client IDs have the same value by the documented contract. This identifies the child agent, not its blueprint, but does not establish comprehensive telemetry coverage."
        : "Can query by the saved, documented legacy application identity; this does not verify runtime correlation or comprehensive telemetry coverage.") };
    const environment = resource?.environmentId;
    const purviewReason = commonReason ?? (bots.length !== 1 || !environment || record.environmentId?.toLowerCase() !== environment.toLowerCase()
      || !unambiguous("cds_bot_id", bots)
      ? "Saved Purview association requires an exact bot ID and its current environment." : undefined);
    return {
      inventoryRevision: page.revision,
      ...(identitySource ? { identitySource } : {}),
      context: {
        recordId: record.id, displayName: record.displayName,
        defender: { status: mapping || !runtimeReason ? "available" : "unavailable",
          ...(!mapping && runtimeReason ? { reason: savedReason ?? runtimeReason, reasonCode: savedReasonCode ?? "identity_resolution_required" as const } : {}),
          entraAgentIds: mapping ? [mapping.objectId] : [], entraAgentApplicationIds: runtimeReason ? [] : runtimeIds,
          resolution: { canResolve: Boolean(identitySource), capabilityId: "graph.agentIdentity.read", cacheStatus: cache.status,
            ...(cache.checkedAt ? { lastCheckedAt: cache.checkedAt } : {}),
            ...(cache.expiresAt ? { expiresAt: cache.expiresAt } : {}),
            ...(cache.lastErrorCode ? { lastErrorCode: cache.lastErrorCode } : {}),
            ...(mapping ? { resolvedAt: mapping.checkedAt, runtimeStatus: verifiedClientId ? "available" : "unverified",
              ...(verifiedClientId ? { runtimeProvenance: verifiedAgentIdentityClientIdProvenance } : {}) }
              : { reason: savedReason ?? "Explicit delegated directory resolution is required; opening this context does not contact Graph.",
                reasonCode: savedReasonCode ?? "identity_resolution_required" }) },
          templates: { agents_inventory: { status: mapping ? "available" : "unavailable",
            ...(inventoryReason ? { reason: inventoryReason, reasonCode: savedReasonCode ?? "identity_resolution_required" } : {}) },
          agent_activity: runtimeAvailability, agent_tools: runtimeAvailability } },
        purview: { status: purviewReason ? "unavailable" : "available",
          ...(purviewReason ? { reason: purviewReason, reasonCode: commonReasonCode ?? "purview_identity_unavailable" as const } : {}), mode: "saved_only" },
      },
      ...(!purviewReason ? { purviewTarget: { environmentId: environment!.toLowerCase(), botId: bots[0] } } : {}),
    };
  }

  async defenderScope(scope: InventoryScope, recordId: unknown): Promise<AgentInvestigationScope> {
    const { context } = await this.resolve(scope, recordId);
    if (context.defender.status !== "available") throw new AppError(409, "agent_investigation_unavailable", context.defender.reason!);
    return { recordId: context.recordId, entraAgentIds: context.defender.entraAgentIds, entraAgentApplicationIds: context.defender.entraAgentApplicationIds };
  }
}

export const agentInvestigations = new AgentInvestigationsService();

function sourceChanged() {
  return new AppError(409, "agent_identity_source_changed", "The saved agent source changed or expired during this read. Refresh Agents.");
}

export function investigationRecordId(value: unknown): string {
  if (typeof value === "string" && value.length <= 2_048) {
    try {
      const target = parseUnifiedAgentRecordId(value);
      if (target) return unifiedAgentRecordId(target);
    } catch { /* Reject malformed source-qualified references below. */ }
  }
  throw new AppError(400, "invalid_agent_investigation", "Select an exact saved agent record.");
}

export function bindAgentHuntingFilters(value: unknown, scope: AgentInvestigationScope): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "invalid_hunting_filters", "Hunting filters must be a structured object.");
  const input = value as Record<string, unknown>;
  const applications = scope.entraAgentApplicationIds ?? [];
  const invalidLegacyIdentity = ["agentIds", "blueprintIds", "actorObjectIds"].some(key =>
    input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length !== 0));
  const mismatchedEntraIdentity = [["entraAgentIds", scope.entraAgentIds], ["entraAgentApplicationIds", applications]].some(([key, ids]) => {
    const supplied = input[key as string];
    const expected = ids as string[];
    return supplied !== undefined && (!Array.isArray(supplied) || supplied.length !== 0
      && (supplied.length !== expected.length || supplied.some((id, index) => typeof id !== "string" || id.toLowerCase() !== expected[index])));
  });
  if (invalidLegacyIdentity || mismatchedEntraIdentity) {
    throw new AppError(400, "agent_identity_override", "Agent investigation identities are derived from current saved inventory, not caller-supplied filters.");
  }
  if (input.templateId === "agents_inventory" ? scope.entraAgentIds.length !== 1 : applications.length !== 1) {
    throw new AppError(409, "agent_investigation_unavailable", "This template requires a verified identity in its own namespace: enterprise object ID for inventory, application/client ID for runtime activity.");
  }
  const { entraAgentIds: _objects, entraAgentApplicationIds: _applications, ...filters } = input;
  return { ...filters, agentIds: [], blueprintIds: [], actorObjectIds: [],
    ...(input.templateId === "agents_inventory" ? { entraAgentIds: scope.entraAgentIds } : { entraAgentApplicationIds: applications }) };
}

export function assertAgentHuntingScope(filters: Pick<DefenderHuntingFilters, "templateId" | "agentIds" | "blueprintIds" | "entraAgentIds" | "entraAgentApplicationIds">, scope: AgentInvestigationScope) {
  const inventory = filters.templateId === "agents_inventory";
  const expected = inventory ? scope.entraAgentIds : scope.entraAgentApplicationIds ?? [];
  const selected = inventory ? filters.entraAgentIds : filters.entraAgentApplicationIds;
  const wrongNamespace = inventory ? filters.entraAgentApplicationIds : filters.entraAgentIds;
  if (expected.length !== 1 || filters.agentIds.length || filters.blueprintIds.length || wrongNamespace?.length
    || selected?.length !== 1 || selected[0] !== expected[0]) {
    throw new AppError(404, "not_found", "An exact hunting scope for this current saved agent was not found.");
  }
}
