import type { SavedAgentPerson, UnifiedAgentInventoryPage, UnifiedAgentRecord } from "./unifiedAgents.js";

export const responsibilityRoles = ["owner", "createdBy", "lastModifiedBy"] as const;
export type ResponsibilityRole = typeof responsibilityRoles[number];
export const responsibilityLabels: Record<ResponsibilityRole, string> = {
  owner: "Owner", createdBy: "Created by", lastModifiedBy: "Last modified by",
};

export type ResponsibilityPerson = {
  objectId: string;
  evidence: SavedAgentPerson | null;
  agentCount: number;
  roles: ResponsibilityRole[];
};

export type ResponsibilityAgent = Pick<UnifiedAgentRecord, "id" | "displayName" | "presence" | "environmentId"> & {
  roles: ResponsibilityRole[];
  observedAt: string;
};

export type AgentResponsibilityQuery = { objectId?: string; search?: string; offset?: number; limit?: number };
export type AgentResponsibilityPage = {
  revision: string;
  sources: UnifiedAgentInventoryPage["sources"];
  coverage: "available" | "partial" | "unavailable";
  unknownAgentCount: number;
  invalidReferenceCount: number;
  people: ResponsibilityPerson[];
  count: number;
  offset: number;
  limit: number;
  selected: null | {
    person: ResponsibilityPerson;
    state: "reported" | "no_reported_relationships" | "unavailable";
    agents: ResponsibilityAgent[];
    count: number;
  };
};
