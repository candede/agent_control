import type { AgentResponsibilityPage } from "../api/client";

export const responsibilityOwnerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const responsibilityAgentId = "agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type FixtureOptions = {
  now?: number;
  selection?: AgentResponsibilityPage["selection"];
  state?: NonNullable<AgentResponsibilityPage["selected"]>["state"];
  agentCount?: number;
  pageIndex?: number;
};

export function responsibilityFixture(objectId?: string, options: FixtureOptions = {}): AgentResponsibilityPage {
  const now = options.now ?? (options.selection ? Date.parse(options.selection.evaluatedAt) : Date.now());
  const observedAt = new Date(now - 60_000).toISOString();
  const sourceExpiresAt = new Date(now + 3_600_000).toISOString();
  // Unpinned GETs capture independently; continuations must reuse the original selection.
  const selection = options.selection ? { ...options.selection } : {
    id: crypto.randomUUID(), revision: crypto.randomUUID(),
    evaluatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
    validatedAt: new Date(now).toISOString(),
    publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) },
  };
  const state = options.state ?? (options.agentCount === 0 ? "no_reported_relationships" : "reported");
  const agentCount = state === "reported" ? options.agentCount ?? 1 : 0;
  const personId = (objectId ?? responsibilityOwnerId).toLowerCase();
  const limit = 50, pageIndex = options.pageIndex ?? 0, start = pageIndex * limit;
  if (!Number.isSafeInteger(agentCount) || agentCount < 0 || state === "reported" && agentCount === 0
    || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || start >= Math.max(1, agentCount)
    || objectId === undefined && pageIndex !== 0) throw new Error("Use a valid responsibility fixture page and count.");
  const roles: NonNullable<AgentResponsibilityPage["selected"]>["person"]["roles"] = agentCount ? ["owner"] : [];
  const person = {
    objectId: personId, agentCount, roles,
    evidence: { objectId: personId, displayName: "Responsible only", userPrincipalName: "owner@example.invalid",
      observedAt, expiresAt: sourceExpiresAt, status: "resolved" as const },
  };
  const agents: NonNullable<AgentResponsibilityPage["selected"]>["agents"] = Array.from({ length: Math.min(limit, agentCount - start) }, (_, offset) => {
    const index = start + offset;
    return { id: index === 0 ? responsibilityAgentId : `agent:bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
      displayName: index === 0 ? "Responsible agent" : `Responsible agent ${index + 1}`,
      presence: "power_platform", environmentId: "environment", roles: [...roles], observedAt };
  });
  const cursor = (index: number) => `responsibility:${selection.id}:${personId}:${index}`;
  const sourceCount = Math.max(1, agentCount);
  return {
    selection, counts: { total: agentCount ? 1 : 0, filtered: agentCount ? 1 : 0 },
    page: { limit, nextCursor: objectId !== undefined && start + agents.length < agentCount ? cursor(pageIndex + 1) : null,
      previousCursor: pageIndex ? cursor(pageIndex - 1) : null },
    invalidReferenceCount: 0,
    sources: {
      graphPackages: { state: "unavailable", observation: null, error: { source: "graph_packages", code: "snapshot_unavailable", message: "No saved packages." } },
      powerPlatform: state === "unavailable" ? { state: "unavailable", observation: null,
        error: { source: "power_platform", code: "snapshot_unavailable", message: "No saved agent inventory." } } : { state: "partial", observation: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", snapshotId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        current: true, observedAt, expiresAt: sourceExpiresAt,
        roleScope: "full", environmentScope: null, coverage: "not_requested", coveredCount: null,
        observedCount: sourceCount, totalRecords: sourceCount, pageCount: 1,
        verification: { status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows", checkedAt: observedAt,
          storedCount: sourceCount, uniqueIdentityCount: sourceCount, queriedTypes: ["microsoft.copilotstudio/agents"] },
      }, error: { source: "power_platform", code: "coverage_unknown", message: "The captured source does not contain a complete authorized agent query." } },
    },
    people: objectId === undefined && agentCount ? [person] : [],
    selected: objectId === undefined ? null : { person, state, count: agentCount, agents },
  };
}
