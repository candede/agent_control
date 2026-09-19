import type {
  AgentUsageRow,
  OfficialUsageAvailability,
  OfficialUsageLineage,
  OfficialUsageSetSummary,
} from "./officialUsage.js";

export type AgentUsageTarget =
  | { source: "graph_packages"; packageId: string }
  | { source: "power_platform"; nativeId: string; environmentId: string | null };

export type AgentUsageAssociation = {
  reportAgentId: string;
  reportAgentName: string;
  target: AgentUsageTarget;
  basis: "admin_reviewed";
  reviewedAt: string;
};

export type AgentUsageContext = {
  reportSet: OfficialUsageSetSummary | null;
  availability: OfficialUsageAvailability;
  lineages: OfficialUsageLineage[];
  revision: string;
  expiresAt?: string | null;
};

export type AgentUsageSummary = {
  status: "unavailable" | "unlinked" | "linked";
  reportSetId: string | null;
  responses: number | null;
  activeUsers: number | null;
  lastActivityDateUtc: string | null;
  associations: AgentUsageAssociation[];
};

export type AgentUsageCandidatePage = {
  context: AgentUsageContext;
  value: Array<AgentUsageRow & { associated: boolean }>;
  count: number;
  offset: number;
  limit: number;
};

export type AgentUsageAssociationInput = {
  reportSetId: string;
  reportAgentId: string;
  target: AgentUsageTarget;
  expectedInventoryRevision: string;
  expectedUsageRevision: string;
  confirmed: true;
};

export type AgentUsageAssociationRemoval = {
  reportSetId: string;
  reportAgentId: string;
  expectedInventoryRevision: string;
  expectedUsageRevision: string;
  confirmed: true;
};
