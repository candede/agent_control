import type { PurviewAuditRecord } from "./purviewAudit.js";
import type { DefenderHuntingTemplateId } from "./defenderHunting.js";

export type AgentInvestigationReasonCode = "unsupported_agent_type" | "unsupported_identity_crosswalk" | "ambiguous_identity" | "stale_source"
  | "missing_identity_candidate" | "invalid_identity_candidate" | "identity_resolution_required"
  | "application_identity_unavailable" | "shared_application_identity" | "purview_identity_unavailable"
  | "identity_resolution_expired" | "identity_authorization_required" | "identity_not_found"
  | "identity_provider_error" | "identity_setup_required";

export type AgentIdentityResolutionOutcome = "resolved" | "authorization_required" | "not_found" | "provider_error" | "setup_required";
export type AgentIdentityCacheStatus = AgentIdentityResolutionOutcome | "missing" | "expired" | "source_unavailable";
export type AgentIdentityRuntimeStatus = "available" | "missing" | "shared" | "unverified";
export const verifiedAgentIdentityClientIdProvenance = "verified-entra-agent-identity-client-id" as const;
export type AgentIdentityRuntimeProvenance = typeof verifiedAgentIdentityClientIdProvenance;
export type VerifiedAgentIdentityIds = {
  objectId: string;
  applicationId: string;
  runtimeStatus: "available";
  runtimeProvenance: AgentIdentityRuntimeProvenance;
};

export type AgentInvestigationContext = {
  recordId: string;
  displayName: string;
  defender: {
    status: "available" | "unavailable";
    reason?: string;
    reasonCode?: AgentInvestigationReasonCode;
    /** Inventory object-ID namespace; only verified agentIdentity objects also have this client-ID value. */
    entraAgentIds: string[];
    entraAgentApplicationIds?: string[];
    templates?: Record<DefenderHuntingTemplateId, { status: "available" | "unavailable"; reason?: string; reasonCode?: AgentInvestigationReasonCode }>;
    resolution?: {
      /** Source eligibility only; the explicit POST checks externally pregranted access and authorization. */
      canResolve: boolean;
      capabilityId: "graph.agentIdentity.read";
      reason?: string;
      reasonCode?: AgentInvestigationReasonCode;
      resolvedAt?: string;
      expiresAt?: string;
      cacheStatus?: AgentIdentityCacheStatus;
      lastCheckedAt?: string;
      lastErrorCode?: string;
      runtimeStatus?: AgentIdentityRuntimeStatus;
      runtimeProvenance?: AgentIdentityRuntimeProvenance;
    };
  };
  purview: { status: "available" | "unavailable"; reason?: string; reasonCode?: AgentInvestigationReasonCode; mode: "saved_only" };
};

export type AgentInvestigationScope = { recordId: string; entraAgentIds: string[]; entraAgentApplicationIds?: string[] };
export type AgentPurviewTarget = { environmentId: string; botId: string };
export type AgentPurviewQuery = { limit: number; offset: number; search?: string; operation?: string };
export type AgentPurviewRecordPage = {
  recordId: string;
  mode: "saved_only";
  count: number;
  limit: number;
  offset: number;
  value: Array<PurviewAuditRecord & { jobId?: string }>;
};
