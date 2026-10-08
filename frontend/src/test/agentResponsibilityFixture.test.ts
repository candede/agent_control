// @vitest-environment node
import { describe, expect, it } from "vitest";
import { responsibilityFixture, responsibilityOwnerId } from "./agentResponsibilityFixture";

describe("responsibility fixture contracts", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");

  it("captures independent, bounded selections and detached owner evidence", () => {
    const first = responsibilityFixture(responsibilityOwnerId.toUpperCase(), { now });
    const second = responsibilityFixture(responsibilityOwnerId, { now });
    expect(first.selection.id).not.toBe(second.selection.id);
    expect(first.selection.revision).not.toBe(second.selection.revision);
    expect(Date.parse(first.selection.evaluatedAt)).toBe(now);
    expect(Date.parse(first.selection.expiresAt) - now).toBe(600_000);
    expect(first.selected!.person.objectId).toBe(responsibilityOwnerId);
    expect(first.selected!.person.evidence!.objectId).toBe(responsibilityOwnerId);
    first.selected!.person.roles.push("createdBy");
    first.selected!.person.evidence!.displayName = "Changed";
    expect(first.selected!.agents[0].roles).toEqual(["owner"]);
    expect(second.selected!.person.roles).toEqual(["owner"]);
    expect(second.selected!.person.evidence!.displayName).toBe("Responsible only");
  });

  it("keeps cursor pages disjoint and totals, evidence and immutable selection consistent", () => {
    const first = responsibilityFixture(responsibilityOwnerId, { now, agentCount: 51 });
    const next = responsibilityFixture(responsibilityOwnerId, { selection: first.selection, agentCount: 51, pageIndex: 1 });
    expect(first.selected!.agents).toHaveLength(50);
    expect(next.selected!.agents).toHaveLength(1);
    expect(new Set([...first.selected!.agents, ...next.selected!.agents].map(agent => agent.id)).size).toBe(51);
    expect(first.selected!.count).toBe(51);
    expect(first.selected!.person.agentCount).toBe(51);
    expect(next.selected!.person).toEqual(first.selected!.person);
    expect(first.counts).toEqual({ total: 1, filtered: 1 });
    expect(next.selection).toEqual(first.selection);
    expect(next.selection).not.toBe(first.selection);
    expect(next.sources).toEqual(first.sources);
    expect(first.page.previousCursor).toBeNull();
    expect(first.page.nextCursor).not.toBeNull();
    expect(next.page.previousCursor).not.toBeNull();
    expect(next.page.nextCursor).toBeNull();
  });

  it.each(["no_reported_relationships", "unavailable"] as const)("represents %s without positive relationship evidence", state => {
    const page = responsibilityFixture(responsibilityOwnerId, { now, state });
    expect(page.selected).toMatchObject({ state, count: 0, agents: [], person: { agentCount: 0, roles: [] } });
    expect(page.people).toEqual([]);
    expect(page.counts).toEqual({ total: 0, filtered: 0 });
    expect(page.page).toEqual({ limit: 50, previousCursor: null, nextCursor: null });
    expect(page.sources.powerPlatform.state).toBe(state === "unavailable" ? "unavailable" : "partial");
    if (state === "unavailable") expect(page.sources.powerPlatform.observation).toBeNull();
  });

  it("distinguishes the people list from an exact selected user", () => {
    const list = responsibilityFixture(undefined, { now });
    const exact = responsibilityFixture(responsibilityOwnerId, { now });
    expect(list.selected).toBeNull();
    expect(list.people).toEqual([exact.selected!.person]);
    expect(exact.people).toEqual([]);
  });
});
