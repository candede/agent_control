import { afterEach, describe, expect, it, vi } from "vitest";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { buildRecords } from "./inventoryComponent.js";
import { canonicalRecord, packageInventoryRecord, powerPlatformInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";
import { allowlistedPackage } from "./packageObservation.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";

const native: PowerPlatformResource = {
  tenantId: "11111111-1111-4111-8111-111111111111", nativeId: "native-agent",
  type: "microsoft.copilotstudio/agents", location: null, displayName: null, environmentId: null,
  createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
  authoringTool: null, creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "unknown",
  identityConfidence: "partial", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
};
const retiredKinds = ["presence", "linkState", "availability", "management"];

afterEach(() => vi.restoreAllMocks());

describe("inventory record projections", () => {
  it("diagnoses an oversized projected residual without logging its contents", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const displayName = "private-display-name-" + "x".repeat(262_144);
    expect(() => powerPlatformInventoryRecord({ ...native, displayName })).toThrow(expect.objectContaining({
      code: "data_residual_bytes",
    }));
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: "warn", event: "data_residual_limit_exceeded",
      errorCode: "data_residual_bytes", stage: "inventory_projection", field: "residual",
      bytes: expect.any(Number), maximumLength: 262_144,
    });
    expect(JSON.parse(warn.mock.calls[0][0]).bytes).toBeGreaterThan(262_144);
    expect(warn.mock.calls[0][0]).not.toContain("private-display-name");
  });

  it("stores classifications once and preserves unknown provider status values", () => {
    const record = packageInventoryRecord(allowlistedPackage({
      id: "opaque-package", displayName: "Package", isBlocked: false, availableTo: "future-scope",
    }));
    expect(record).toMatchObject({ presence: "graph_packages", link_state: "unmatched", availability: "unknown" });
    expect(record.residual.availableTo).toBe("future-scope");
    expect(record.facts.filter(fact => retiredKinds.includes(fact.kind))).toEqual([]);
  });

  it("does not repeat canonical columns in residual JSON or scalar facts", () => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, availableTo: "Everyone" });
    const record = canonicalRecord("canonical-id", buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0]);
    expect(record).toMatchObject({ display_name: "Package", presence: "graph_packages", availability: "available" });
    expect(Object.keys(record.residual)).toEqual(["identity"]);
    expect(record.residual.identity).not.toHaveProperty("state");
    expect(record.facts.filter(fact => retiredKinds.includes(fact.kind))).toEqual([]);
  });

  it.each([undefined, "2026-10-01T12:34:56.789Z"])("projects the native modification timestamp %s", lastModifiedAt => {
    const record = powerPlatformInventoryRecord({ ...native, details: { lastModifiedAt } });
    expect(record.modified_at).toBe(lastModifiedAt ?? null);
    expect(record.display_name).toBe(native.nativeId);
    expect(record.presence).toBe("power_platform");
  });

  it("preserves environment source classification without inventing access or management evidence", () => {
    const record = powerPlatformInventoryRecord({ ...native, type: "microsoft.powerplatform/environments", agentKind: "environment" });
    expect(record).toMatchObject({ presence: "power_platform", link_state: "unmatched", availability: "unknown", management: "unknown" });
  });

  it.each([false, true])("round trips absent versus empty package collections: %s", empty => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false,
      ...(empty ? { categories: [], supportedHosts: [], allowedUsersAndGroups: [], elementDetails: [] } : {}) });
    const record = packageInventoryRecord(value);
    expect(restoreInventoryRecord(record.residual, record.facts, "packages")).toEqual(value);
  });

  it("round trips duplicate connectors and distinguishes absent operations from empty operations", () => {
    const value: PowerPlatformResource = { ...native, details: {
      channels: ["future-channel"], connectors: [
        { connectorId: "shared", operations: [{ operationId: "first", isEnabled: false }] },
        { connectorId: "shared", operations: [] },
        { connectorId: "without-operations" },
      ],
    } };
    const record = powerPlatformInventoryRecord(value);
    expect(restoreInventoryRecord(record.residual, record.facts, "power_platform")).toEqual(value);
    expect(value.details.connectors?.[0].operations).toHaveLength(1);
  });
});
