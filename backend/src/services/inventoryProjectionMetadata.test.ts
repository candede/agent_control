import { afterEach, expect, it, vi } from "vitest";
import { allowlistedPackage } from "./packageObservation.js";
import { packageInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";

afterEach(() => vi.restoreAllMocks());

it("preserves local identity/control annotations without reporting them as provider omissions", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = {
    ...allowlistedPackage({ id: "local-annotations", displayName: "Fixture", isBlocked: false }),
    identityDetailsCollected: true as const, identityRevalidationRequired: true as const, controlObservations: {},
  };
  const result = packageInventoryRecord(input);
  expect(result.residual).toMatchObject({
    identityDetailsCollected: true, identityRevalidationRequired: true, controlObservations: {},
  });
  expect(input).toHaveProperty("identityDetailsCollected", true);
  expect(warning).not.toHaveBeenCalled();
});

it("does not persist inherited identity or control observation annotations", () => {
  const input = Object.assign(Object.create({
    identityDetailsCollected: true, identityRevalidationRequired: true,
    controlObservations: { block: { snapshotId: "inherited-control" } },
  }), allowlistedPackage({ id: "own-observations", displayName: "Fixture", isBlocked: false }));
  const projected = packageInventoryRecord(input);
  for (const key of ["identityDetailsCollected", "identityRevalidationRequired", "controlObservations"]) {
    expect(projected.residual).not.toHaveProperty(key);
  }
});

it("does not read inherited provenance when projecting own package observations", () => {
  const { provenance: expected, ...observation } = allowlistedPackage({
    id: "own-provenance", displayName: "Fixture", isBlocked: false,
  });
  const getter = vi.fn(() => ({ id: { sourceSystem: "graph_packages", path: "inherited", maturity: "observed" } }));
  const input = Object.assign(Object.create(Object.defineProperty({}, "provenance", { get: getter })), observation);
  const projected = packageInventoryRecord(input);
  expect(getter).not.toHaveBeenCalled();
  expect(projected.residual.provenance).toEqual(expected);
});

it("isolates nested package provenance from caller mutations in both directions", () => {
  const input = allowlistedPackage({ id: "isolated-provenance", displayName: "Fixture", isBlocked: false });
  input.provenance.id.path = "value[0].id";
  input.provenance.id.maturity = "observed";
  const expected = structuredClone(input.provenance);
  const record = packageInventoryRecord(input);
  expect(record.residual.provenance).toEqual(expected);
  input.provenance.id.path = "caller-mutated";
  expect(record.residual.provenance).toEqual(expected);
  const projected = record.residual.provenance as typeof input.provenance;
  projected.displayName.path = "projection-mutated";
  expect(input.provenance.displayName).toEqual(expected.displayName);
});

it("rejects source and local annotation accessors without invoking them during inventory projection", () => {
  const input = allowlistedPackage({ id: "own-observations", displayName: "Fixture", isBlocked: false });
  for (const field of ["manifestId", "identityDetailsCollected", "provenance"]) {
    const getter = vi.fn(() => "untrusted-identity");
    const accessor = { ...input };
    Object.defineProperty(accessor, field, { get: getter, enumerable: true });
    expect(() => packageInventoryRecord(accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  }
});

it("keeps freshness and control annotations isolated across projected and restored records", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = {
    ...allowlistedPackage({ id: "local-observations", displayName: "Fixture", isBlocked: false }),
    identityDetailsCollected: true as const,
    detailFreshness: { state: "fresh" as const, observedAt: "2026-10-01T11:00:00Z", expiresAt: "2026-10-01T12:00:00Z" },
    controlObservations: { block: {
      snapshotId: "control", observedAt: "2026-10-01T11:00:00Z", expiresAt: "2026-10-02T11:00:00Z",
    } },
  };
  const record = packageInventoryRecord(input);
  expect(record.residual).toMatchObject({
    identityDetailsCollected: true, detailFreshness: input.detailFreshness, controlObservations: input.controlObservations,
  });
  const original = structuredClone(record);
  input.detailFreshness.expiresAt = "2026-10-01T13:00:00Z";
  input.controlObservations.block.snapshotId = "different-control";
  expect(record).toEqual(original);

  const restored = restoreInventoryRecord(record.residual, record.facts, "packages");
  expect(restored).toMatchObject(original.residual);
  expect(restored.detailFreshness).not.toBe(record.residual.detailFreshness);
  expect(restored.controlObservations).not.toBe(record.residual.controlObservations);
  expect(warning).not.toHaveBeenCalled();
});

it("does not report supported fields normalized to absence as provider omissions", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const nullable = {
    shortDescription: null, longDescription: null, type: null, publisher: null, platform: null,
    version: null, manifestVersion: null, sensitivity: null, supportedHosts: null, elementTypes: null,
    categories: null, elementDetails: null,
  };
  const absent = { createdDateTime: "", lastModifiedDateTime: "", manifestId: "", appId: "", assetId: "" };
  const input = { id: "nullable", displayName: "Fixture", isBlocked: false, ...nullable, ...absent };
  const value = allowlistedPackage(input);
  expect(packageInventoryRecord(value).residual.id).toBe(input.id);
  for (const field of [...Object.keys(nullable), ...Object.keys(absent)]) expect(value).not.toHaveProperty(field);
  expect(warning).not.toHaveBeenCalled();
});

it("counts prototype-named unknown fields even alongside supported absent fields", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = {
    ...allowlistedPackage({ id: "prototype-fields", displayName: "Fixture", isBlocked: false }),
    publisher: undefined,
    ...JSON.parse('{"constructor":"private-constructor","toString":"private-string","__proto__":"private-prototype"}'),
  };
  const result = packageInventoryRecord(input);
  for (const field of ["constructor", "toString", "__proto__"]) expect(Object.hasOwn(result.residual, field)).toBe(false);
  expect(warning).toHaveBeenCalledOnce();
  expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
    event: "provider_schema_omission", provider: "graph_packages", count: 3,
  });
  expect(warning.mock.calls[0][0]).not.toContain("private-");
});

it("still reports genuinely unknown fields without exposing their values", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = { ...allowlistedPackage({ id: "unknown", displayName: "Fixture", isBlocked: false }), extra: "private-value" };
  const result = packageInventoryRecord(input);
  expect(result.residual).not.toHaveProperty("extra");
  expect(warning).toHaveBeenCalledOnce();
  expect(JSON.parse(warning.mock.calls[0][0])).toMatchObject({
    event: "provider_schema_omission", provider: "graph_packages", count: 1,
  });
  expect(warning.mock.calls[0][0]).not.toContain("private-value");
});
