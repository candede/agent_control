export type OfficialUsageReportKind = "agents" | "userAgents" | "users";
export type OfficialUsagePeriodProvenance = "source_metadata" | "operator_asserted" | "activity_range";
export type OfficialUsageMetadata = {
  reportingPeriod?: { startDate: string; endDate: string; provenance: Exclude<OfficialUsagePeriodProvenance, "activity_range"> };
  sourceAsOf?: { value: string; provenance: "source_metadata" | "operator_asserted" };
  downloadedAt?: string;
};
export type OfficialUsageReportBase = {
  kind: OfficialUsageReportKind; parserVersion: string; schemaVersion: string;
  reportingPeriod: { startDate: string | null; endDate: string | null; days: number | null; provenance: OfficialUsagePeriodProvenance };
  sourceAsOf?: string; sourceAsOfProvenance: "source_metadata" | "operator_asserted" | "absent";
  sourceFreshness: "known" | "unknown"; downloadedAt?: string; warnings: string[];
};
export type AgentUsageRow = {
  agentId: string; agentName: string; creatorType: string; activeUsersLicensed: number; activeUsersUnlicensed: number;
  responsesSentToUsers: number; lastActivityDateUtc?: string;
};
export type UserAgentUsageRow = {
  agentId: string; agentName: string; creatorType: string; username: string; responsesSentToUsers: number; lastActivityDateUtc?: string;
};
export type UserUsageRow = {
  username: string; displayName: string; numberOfAgentsUsed: number; agentResponsesReceived: number; lastActivityDateUtc?: string;
};
export type OfficialUsageAvailability = "never_imported" | "incomplete" | "not_selected" | "deleted" | "active" | "stale";
