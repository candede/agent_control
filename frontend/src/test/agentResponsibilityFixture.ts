import type { AgentResponsibilityPage } from "../api/client";

export const responsibilityOwnerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const responsibilityAgentId = "agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export function responsibilityFixture(objectId?: string): AgentResponsibilityPage {
  const person = {
    objectId: objectId ?? responsibilityOwnerId, agentCount: 1, roles: ["owner" as const],
    evidence: { objectId: objectId ?? responsibilityOwnerId, displayName: "Responsible only", userPrincipalName: "owner@example.invalid",
      observedAt: "2026-09-12T10:00:00Z", status: "resolved" as const },
  };
  return {
    revision: "a".repeat(64), coverage: "partial", unknownAgentCount: 1, invalidReferenceCount: 0,
    sources: {
      graphPackages: { state: "unavailable", observation: null, error: { source: "graph_packages", code: "snapshot_unavailable", message: "No saved packages." } },
      powerPlatform: { state: "partial", observation: {
        id: "snapshot", snapshotId: "snapshot", current: true, observedAt: "2026-09-12T10:00:00Z", expiresAt: "2099-09-12T10:00:00Z",
        roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 1, observedCount: 1, totalRecords: 1, pageCount: 1,
        verification: { status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows", checkedAt: "2026-09-12T10:00:00Z",
          storedCount: 1, uniqueIdentityCount: 1, queriedTypes: ["microsoft.copilotstudio/agents"] },
      }, error: { source: "power_platform", code: "environment_scope_limited", message: "Only the authorized environment is saved." } },
    },
    people: objectId ? [] : [person], count: 1, offset: 0, limit: 50,
    selected: objectId ? { person, state: "reported", count: 1,
      agents: [{ id: responsibilityAgentId, displayName: "Responsible agent", presence: "power_platform", environmentId: "environment",
        roles: ["owner"], observedAt: "2026-09-12T10:00:00Z" }] } : null,
  };
}
