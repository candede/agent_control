export type AgentUsageTarget =
  | { source: "graph_packages"; packageId: string }
  | { source: "power_platform"; nativeId: string; environmentId: string | null };
