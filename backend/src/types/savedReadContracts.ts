import type { PublishedSelectedRead } from "./dataSelection.js";
import type { ReportMetadata } from "./officialReportData.js";
import type { UserSourceMetadata } from "./userSources.js";

export type AgentRelationship = "used" | "created" | "owned" | "modified";
export type UserResolution = {
  username: string;
  state: "resolved" | "ambiguous" | "concealed_or_unresolved" | "unresolved" | "directory_missing";
  objectId: string | null;
  directoryMatches: number;
  reportedUsername: string | null;
  reportIdentityState: "matched" | "ambiguous" | "unresolved" | "missing";
  concealment: "unknown";
  selection: PublishedSelectedRead;
  directory: UserSourceMetadata;
  reports: ReportMetadata;
};
export type SavedAgentRelationship = {
  id: string;
  canonicalId: string | null;
  reportAgentId: string | null;
  name: string;
  relationship: AgentRelationship;
  personId: string;
  reportedUsername: string | null;
  responses: number | null;
  lastActivityDateUtc: string | null;
  source: "inventory" | "userAgents";
  identityState: "canonical" | "report_only" | "ambiguous";
  sourceReferences: { selectionId: string; path: string } | null;
};
export type SavedRelationshipPage = {
  value: SavedAgentRelationship[];
  counts: { total: number | null; distinctAgents: number | null; returned: number };
  page: { limit: number; nextCursor: string | null };
  selection: PublishedSelectedRead;
  inventorySelection: PublishedSelectedRead;
  directory: UserSourceMetadata;
  reports: ReportMetadata;
  relationshipState: "available" | "unavailable";
  missingReasons: string[];
};
export type ChampionAgentPage = SavedRelationshipPage & {
  company: string | null;
  department: string | null;
  champions: { objectId: string; name: string | null; rank: number; created: number; responses: number | null; agents: number }[];
};
export type AgentAboutPage = {
  recordId: string;
  sourceScopeId: string;
  sourceIdentity: string;
  generationId: string;
  field: "long" | "native" | "short";
  state: "available" | "missing";
  source: "graph_packages" | "power_platform";
  provenance: { path: string | null; maturity: "ga" | "preview" | "observed" | "unknown" };
  observedAt: string;
  text: string | null;
  totalBytes: number;
  returnedBytes: number;
  nextCursor: string | null;
  selection: PublishedSelectedRead;
};
