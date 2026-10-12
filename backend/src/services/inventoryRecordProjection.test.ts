import { afterEach, describe, expect, it, vi } from "vitest";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { buildRecords } from "./inventoryComponent.js";
import { canonicalRecord, nativeInventoryKey, packageInventoryRecord, powerPlatformInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";
import { powerPlatformAgentKey } from "./inventoryIdentity.js";
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

  it.each([
    ["2026-10-01T14:00:00.000001+02:00", "2026-10-01T12:00:00.000002Z"],
    ["2026-10-02T02:00:00.000000001+14:00", "2026-10-01T12:00:00.000000002Z"],
    ["2026-09-30T22:00:00.000000001-14:00", "2026-10-01T12:00:00.000000002Z"],
    ["2026-10-02T01:59:00.000001+13:59", "2026-10-01T12:00:00.000002Z"],
    ["2026-09-30T22:01:00.000001-13:59", "2026-10-01T12:00:00.000002Z"],
  ])("retains the earliest exact identity expiry %s without firing the scheduler early or sorting by timezone text", (firstExpiry, laterExpiry) => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false });
    const record = buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0];
    record.packages = [
      { ...value, detailFreshness: { state: "fresh", observedAt: "2026-10-01T11:00:00Z", expiresAt: laterExpiry } },
      { ...value, id: "other", detailFreshness: { state: "fresh", observedAt: "2026-10-01T11:00:00Z", expiresAt: firstExpiry } },
    ];
    expect(canonicalRecord("canonical", record).identity_expires_at).toBe(firstExpiry);
  });

  it("preserves valid calendar boundaries and all supported fractional precisions in saved identity expiries", () => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false });
    const record = buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0];
    for (const expiresAt of [
      "0001-01-01T00:00:00Z", "9999-12-31T23:59:59Z", "2024-02-29T23:59:59Z",
      ...Array.from({ length: 9 }, (_, index) => `2026-10-02T02:00:00.${"123456789".slice(0, index + 1)}+14:00`),
    ]) {
      record.packages = [{ ...value, detailFreshness: { state: "fresh", observedAt: expiresAt, expiresAt } }];
      expect(canonicalRecord("canonical", record).identity_expires_at).toBe(expiresAt);
    }
  });

  it.each([
    "0000-01-01T00:00:00Z",
    "2026-10-01T12:00:00+14:01", "2026-10-01T12:00:00-14:01",
    "2026-10-01T12:00:00+15:00", "2026-10-01T12:00:00-15:00",
    "2026-10-01T12:00:00+00:60", "2026-10-01T12:00:00-00:99",
    "2026-10-01T12:00:00.Z", "2026-10-01T12:00:00.1234567890Z",
    "2026-10-01T12:00:00Z\n", "2026-10-01T12:00:00Z\u2028",
    "2026-02-29T12:00:00Z", "1900-02-29T12:00:00Z", "2026-10-01T24:00:00Z",
  ])("rejects an invalid saved identity expiry %j before projection", expiresAt => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false });
    const record = buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0];
    record.packages = [{ ...value, detailFreshness: { state: "fresh", observedAt: "2026-10-01T11:00:00Z", expiresAt } }];
    expect(() => canonicalRecord("canonical", record)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
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

  it("uses the same validated environment identity in persisted and component native keys without losing raw IDs", () => {
    const guid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const upper = { ...native, nativeId: guid, environmentId: `Default-${guid}` };
    const lower = { ...native, nativeId: guid.toLowerCase(), environmentId: `default-${guid.toLowerCase()}` };
    expect(powerPlatformAgentKey(upper.environmentId, upper.nativeId)).toBe(powerPlatformAgentKey(lower.environmentId, lower.nativeId));
    expect(nativeInventoryKey(upper)).toBe(nativeInventoryKey(lower));
    const record = powerPlatformInventoryRecord(upper);
    expect(record).toMatchObject({ native_id: guid, environment_id: `Default-${guid}`,
      residual: { nativeId: guid, environmentId: `Default-${guid}` } });
    const opaque = { ...native, environmentId: "Opaque-ENV" };
    const other = { ...native, environmentId: "opaque-env" };
    expect(powerPlatformAgentKey(opaque.environmentId, opaque.nativeId)).not.toBe(powerPlatformAgentKey(other.environmentId, other.nativeId));
    expect(nativeInventoryKey(opaque)).not.toBe(nativeInventoryKey(other));
  });

  it("retains repeated raw evidence while qualifying one deterministic validated native control identity", () => {
    const botId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const environmentId = `Default-${botId}`;
    const value = { ...native, environmentId, identifiers: [
      { kind: "cds_bot_id" as const, value: botId.toLowerCase() }, { kind: "cds_bot_id" as const, value: botId },
      { kind: "environment_id" as const, value: environmentId.toLowerCase() },
      { kind: "environment_id" as const, value: environmentId },
    ] };
    const record = powerPlatformInventoryRecord(value);
    const controls = record.facts.filter(fact => fact.kind === "control:quarantine");
    expect(controls).toEqual([{ kind: "control:quarantine", value: native.nativeId,
      payload: { botId, environmentId, provenance: null } }]);
    expect(powerPlatformInventoryRecord({ ...value, identifiers: [...value.identifiers].reverse() }).facts
      .filter(fact => fact.kind === "control:quarantine")).toEqual(controls);
    expect(restoreInventoryRecord(record.residual, record.facts, "power_platform")).toEqual(value);
    for (const invalid of [
      { kind: "cds_bot_id" as const, value: `${botId}\n` },
      { kind: "environment_id" as const, value: `${environmentId}\u2028` },
      { kind: "cds_bot_id" as const, value: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" },
    ]) expect(powerPlatformInventoryRecord({ ...value, identifiers: [...value.identifiers, invalid] }).facts
      .filter(fact => fact.kind === "control:quarantine")).toEqual([]);
  });

  it.each([false, true])("round trips absent versus empty package collections: %s", empty => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false,
      ...(empty ? { categories: [], supportedHosts: [], allowedUsersAndGroups: [], elementDetails: [] } : {}) });
    const record = packageInventoryRecord(value);
    expect(restoreInventoryRecord(record.residual, record.facts, "packages")).toEqual(value);
  });

  it("preserves opaque principal identity case through saved facts and restored observations", () => {
    const principals = [
      { resourceId: "Opaque_ABC:/?😀", resourceType: "USER" },
      { resourceId: "Opaque_abc:/?😀", resourceType: "group" },
    ];
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false,
      allowedUsersAndGroups: principals, acquireUsersAndGroups: principals });
    const record = packageInventoryRecord(value);
    for (const kind of ["allowedUsersAndGroups", "acquireUsersAndGroups"]) {
      expect(record.facts.filter(fact => fact.kind === kind).map(fact => fact.payload)).toEqual(principals);
    }
    expect(restoreInventoryRecord(record.residual, record.facts, "packages")).toEqual(value);
    expect(() => packageInventoryRecord({ ...value,
      allowedUsersAndGroups: [{ resourceId: "unsafe\u0085id", resourceType: "user" }] }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it("canonicalizes only exact GUID responsibility facts and preserves opaque spelling and whitespace", () => {
    const guid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    for (const ownerId of [guid, ` ${guid} `, "Opaque_ABC:/?😀", "Opaque_abc:/?😀", "J\u030c", " "]) {
      const value = { ...native, createdBy: guid, details: { ownerId, lastModifiedBy: "CaseSensitive" } };
      const projected = powerPlatformInventoryRecord(value);
      expect(projected.facts.filter(fact => fact.kind.startsWith("person:"))).toEqual([
        { kind: "person:owner", value: ownerId === guid ? guid.toLowerCase() : ownerId, payload: {} },
        { kind: "person:createdBy", value: guid.toLowerCase(), payload: {} },
        { kind: "person:lastModifiedBy", value: "CaseSensitive", payload: {} },
      ]);
      expect(restoreInventoryRecord(projected.residual, projected.facts, "power_platform")).toEqual(value);
    }
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

  it.each(["", "-0", "01", "1e0", "2"])("rejects noncanonical or missing connector parent ordinals: %j", parent => {
    expect(() => restoreInventoryRecord({ ...native, details: {} }, [
      { kind: "collection", value: "detail:connectors", payload: {} },
      { kind: "detail:connectors", value: "0", payload: { connectorId: "first", operations: [] } },
      { kind: "detail:connectors", value: "1", payload: { connectorId: "second", operations: [] } },
      { kind: "connectorOperation", value: parent, payload: { operationId: "operation" } },
    ], "power_platform")).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("rejects connector facts whose parent ordinals or operation-presence markers disagree with their source structure", () => {
    for (const facts of [
      [{ kind: "detail:connectors", value: "1", payload: { connectorId: "wrong-index", operations: [] } }],
      [
        { kind: "detail:connectors", value: "0", payload: { connectorId: "without-operations" } },
        { kind: "connectorOperation", value: "0", payload: { operationId: "orphan" } },
      ],
      [
        { kind: "detail:connectors", value: "0", payload: { connectorId: "inline-operations", operations: [{ operationId: "inline" }] } },
      ],
      [
        { kind: "connectorOperation", value: "0", payload: { operationId: "before-parent" } },
        { kind: "detail:connectors", value: "0", payload: { connectorId: "late-parent", operations: [] } },
      ],
      [
        { kind: "detail:connectors", value: "0", payload: { connectorId: "before-marker", operations: [] } },
        { kind: "collection", value: "detail:connectors", payload: {} },
      ],
    ]) expect(() => restoreInventoryRecord({ ...native, details: {} }, facts, "power_platform"))
      .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("rejects operations moved behind a later connector or detail collection", () => {
    const connector = { kind: "detail:connectors", value: "0", payload: { connectorId: "first", operations: [] } };
    const operation = { kind: "connectorOperation", value: "0", payload: { operationId: "first-operation" } };
    for (const following of [
      [{ kind: "detail:connectors", value: "1", payload: { connectorId: "second", operations: [] } }],
      [{ kind: "collection", value: "detail:channels", payload: {} }],
      [{ kind: "detail:channels", value: "channel", payload: { value: "channel" } }],
    ]) expect(() => restoreInventoryRecord({ ...native, details: {} }, [
      { kind: "collection", value: "detail:connectors", payload: {} },
      connector, ...following, operation,
    ], "power_platform")).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("rejects malformed saved child payloads with the same named source-integrity error", () => {
    const facts = JSON.parse('[{"kind":"detail:connectors","value":"0","payload":null}]');
    expect(() => restoreInventoryRecord({ ...native, details: {} }, facts, "power_platform"))
      .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    expect(() => restoreInventoryRecord({}, [{ kind: "element", value: "Bots:id", payload: JSON.parse("null") }], "packages"))
      .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("retains repeated element groups, duplicate and delimiter-containing element IDs in source ordinal order", () => {
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, elementDetails: [
      { elementType: "Bots", elements: [{ id: "a:b", definition: "{}" }, { id: "a:b", definition: '{"second":true}' }] },
      { elementType: "Bots", elements: [] },
      { elementType: "Bots:a", elements: [{ id: "b", definition: "{}" }] },
      { elementType: "Bots", elements: [{ id: "", definition: "{}" }] },
    ] });
    const record = packageInventoryRecord(value);
    expect(restoreInventoryRecord(record.residual, record.facts, "packages")).toEqual(value);
  });

  it("never manufactures element parentage or aliases saved child payloads", () => {
    expect(() => restoreInventoryRecord({}, [
      { kind: "element", value: "Bots:id", payload: { elementType: "Bots", id: "id", definition: "{}" } },
    ], "packages")).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    const value = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false,
      allowedUsersAndGroups: [{ resourceId: "principal", resourceType: "user" }] });
    const record = packageInventoryRecord(value);
    const restored = restoreInventoryRecord(record.residual, record.facts, "packages");
    (restored.allowedUsersAndGroups as { resourceId: string }[])[0].resourceId = "mutated";
    expect(record.facts.find(fact => fact.kind === "allowedUsersAndGroups")?.payload.resourceId).toBe("principal");
  });
});
