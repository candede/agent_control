import type { UnifiedAgentLinkState, UnifiedAgentPresence } from "./unifiedAgents.js";

export type InventoryClassification = {
  presence: UnifiedAgentPresence | null;
  link_state: UnifiedAgentLinkState | null;
  availability: "available" | "unavailable" | "unknown" | null;
  management: "user_managed" | "organization_managed" | "unknown" | null;
};

export const inventoryLimits = {
  sourceRows: 100_000, pages: 10_000, wireRows: 5_000_000,
  powerPlatformDeadlineMs: 30 * 60_000, graphDeadlineMs: 4 * 60 * 60_000,
  componentRows: 250, candidateEdges: 10_000, factsPerRecord: 10_000,
} as const;

export type InventoryPage<T> = {
  token: string; nextToken: string | null; records: T[]; rawCount: number;
  expectedCount: number | null; page: number; omittedFieldCount?: number;
};
export type InventoryDomain = "packages" | "power_platform" | "canonical";
export type InventoryRoot = {
  scopeId: string; tenantId: string; baselineId: string; revision: string; epoch: string;
};
