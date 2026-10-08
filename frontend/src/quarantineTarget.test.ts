// @vitest-environment node
import { describe, expect, it } from "vitest";
import { quarantineTargetKey, quarantineTargetReason, type QuarantineSelectableTarget } from "./quarantineTarget";

const now = Date.parse("2026-10-07T20:00:00Z");
const environmentId = "abcdefab-1111-4111-8111-111111111111";
const botId = "abcdefab-2222-4222-8222-222222222222";
const snapshot = { id: "snapshot-a", observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
const target: QuarantineSelectableTarget = {
  nativeId: botId, environmentId, type: "microsoft.copilotstudio/agents", displayName: "Agent",
  identifiers: [], details: {}, quarantineIdentity: { environmentId, botId },
};

describe("exact quarantine target identity", () => {
  it("treats environment and native GUID casing as one target without collapsing opaque native IDs", () => {
    expect(quarantineTargetKey({ ...target, nativeId: botId.toUpperCase(), environmentId: environmentId.toUpperCase() }))
      .toBe(quarantineTargetKey(target));
    expect(quarantineTargetKey({ ...target, nativeId: "Agent-A" }))
      .not.toBe(quarantineTargetKey({ ...target, nativeId: "agent-a" }));
    expect(quarantineTargetKey({ ...target, environmentId: botId })).not.toBe(quarantineTargetKey(target));
  });

  it("uses server qualification rather than requiring its bounded identifier preview", () => {
    expect(quarantineTargetReason(target, snapshot, now)).toBeUndefined();
    expect(quarantineTargetReason({ ...target, quarantineIdentity: null }, snapshot, now)).toMatch(/does not prove/);
    expect(quarantineTargetReason({ ...target, quarantineEligibility: { eligible: false, reason: "Identity withdrawn." } }, snapshot, now))
      .toBe("Identity withdrawn.");
  });

  it.each([
    { observedAt: "invalid" },
    { expiresAt: "invalid" },
    { observedAt: new Date(now + 1).toISOString() },
    { observedAt: new Date(now - 86_400_001).toISOString() },
    { expiresAt: new Date(now).toISOString() },
  ])("rejects unproven freshness: %j", timestamps => {
    expect(quarantineTargetReason(target, { ...snapshot, ...timestamps }, now)).toMatch(/Refresh inventory/);
  });

  it("accepts the inclusive maximum age but not a historical read", () => {
    expect(quarantineTargetReason(target, { ...snapshot, observedAt: new Date(now - 86_400_000).toISOString() }, now)).toBeUndefined();
    expect(quarantineTargetReason(target, { ...snapshot, current: false }, now)).toMatch(/historical/);
  });
});
