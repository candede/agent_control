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
  it("treats environment GUID casing as one target without collapsing opaque native IDs, even GUID-shaped IDs", () => {
    expect(quarantineTargetKey({ ...target, environmentId: environmentId.toUpperCase() }))
      .toBe(quarantineTargetKey(target));
    expect(quarantineTargetKey({ ...target, nativeId: botId.toUpperCase() }))
      .not.toBe(quarantineTargetKey(target));
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

  it.each([
    { timestamps: { observedAt: "2026-10-07T20:00:00.000000001Z" }, eligible: false },
    { timestamps: { observedAt: "2026-10-07T22:00:00.000000001+02:00" }, eligible: false },
    { timestamps: { expiresAt: "2026-10-07T20:00:00.000000001Z" }, eligible: true },
    { timestamps: { expiresAt: "2026-10-07T22:00:00.000000001+02:00" }, eligible: true },
    { timestamps: { observedAt: "2026-10-08T10:00:00+14:00" }, eligible: true },
    { timestamps: { observedAt: "2026-10-08T10:00:00.000000001+14:00" }, eligible: false },
    { timestamps: { expiresAt: "2026-10-08T10:00:00.000000001+14:00" }, eligible: true },
    { timestamps: { expiresAt: "2026-10-08T10:00:00+14:00" }, eligible: false },
    { timestamps: { observedAt: "2026-10-07T10:00:00+14:00" }, eligible: true },
    { timestamps: { observedAt: "2026-10-07T09:59:59.999999999+14:00" }, eligible: false },
    { timestamps: { observedAt: "2026-10-07T06:00:00-14:00" }, eligible: true },
    { timestamps: { expiresAt: "2026-10-07T06:00:00.000000001-14:00" }, eligible: true },
    { timestamps: { observedAt: "2026-10-08T09:59:00+13:59" }, eligible: true },
    { timestamps: { observedAt: "2026-10-07T06:01:00-13:59" }, eligible: true },
    { timestamps: { observedAt: "2026-10-06T19:59:59.999999999Z" }, eligible: false },
    { timestamps: { observedAt: "2026-10-06T20:00:00.000000001Z" }, eligible: true },
    { timestamps: { observedAt: "2026-10-07" }, eligible: false },
    { timestamps: { expiresAt: "2027-02-30T20:00:00Z" }, eligible: false },
  ])("uses complete validated snapshot instants for selection: $timestamps", ({ timestamps, eligible }) => {
    const reason = quarantineTargetReason(target, { ...snapshot, ...timestamps }, now);
    if (eligible) expect(reason).toBeUndefined();
    else expect(reason).toMatch(/Refresh inventory/);
  });

  it.each([
    "2026-10-08T10:02:00+14:01", "2026-10-07T06:00:00-14:01",
    "2026-10-08T11:01:00+15:00", "2026-10-07T05:01:00-15:00",
    "2026-10-07T20:01:00+00:60", "2026-10-07T20:01:00-00:99",
    "2026-10-07T20:01:00.Z", "2026-10-07T20:01:00.1234567890Z",
    "2026-10-07T20:01:00Z\n", "2026-10-07T20:01:00Z\u2028",
  ])("does not qualify a snapshot with an invalid expiry %j", expiresAt => {
    expect(quarantineTargetReason(target, { ...snapshot, expiresAt }, now)).toMatch(/Refresh inventory/);
  });

  it("rejects year zero even when its observation is within the inclusive age boundary of a valid year-one instant", () => {
    const evaluation = Date.parse("0001-01-01T00:00:00Z");
    const ancientSnapshot = { ...snapshot, observedAt: "0001-01-01T00:00:00Z", expiresAt: "0001-01-01T00:01:00Z" };
    expect(quarantineTargetReason(target, ancientSnapshot, evaluation)).toBeUndefined();
    expect(quarantineTargetReason(target, { ...ancientSnapshot, observedAt: "0000-12-31T23:59:59.999999999Z" }, evaluation))
      .toMatch(/Refresh inventory/);
  });

  it.each(["\n", "\u2028", " ", "\0"])("never qualifies malformed GUID evidence with a trailing %j", suffix => {
    expect(quarantineTargetReason({ ...target, environmentId: environmentId + suffix }, snapshot, now))
      .toMatch(/valid native environment ID/);
    expect(quarantineTargetReason({ ...target, quarantineIdentity: { environmentId, botId: botId + suffix } }, snapshot, now))
      .toMatch(/valid native CDS bot identity/);
    expect(quarantineTargetReason({ ...target, quarantineIdentity: { environmentId: environmentId + suffix, botId } }, snapshot, now))
      .toMatch(/matching native environment identity/);
  });
});
