import { afterEach, expect, it, vi } from "vitest";
import { allowlistedPackage } from "./packageObservation.js";
import { packageInventoryRecord } from "./inventoryRecordProjection.js";

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
