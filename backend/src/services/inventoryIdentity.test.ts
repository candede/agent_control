import { describe, expect, it } from "vitest";
import { packageInventoryIdentity, resolveExactInventoryIdentity, type InventoryIdentityRecord } from "./inventoryIdentity.js";

function identity(overrides: Partial<InventoryIdentityRecord> = {}): InventoryIdentityRecord {
  return {
    nativeId: "native-a",
    tenantId: "tenant-a",
    environmentId: "environment-a",
    sourceSystem: "power_platform",
    resourceType: "microsoft.copilotstudio/agents",
    identifiers: [{ kind: "cds_bot_id", value: "same-guid" }],
    ...overrides,
  };
}

describe("exact inventory identity resolution", () => {
  it("resolves only the same documented kind in the same tenant and environment", () => {
    expect(resolveExactInventoryIdentity(identity(), [
      identity({ nativeId: "different-kind", identifiers: [{ kind: "entra_agent_id", value: "same-guid" }] }),
      identity({ nativeId: "different-tenant", tenantId: "tenant-b" }),
      identity({ nativeId: "different-environment", environmentId: "environment-b" }),
      identity({ nativeId: "resolved" }),
    ])).toEqual({ status: "resolved", candidate: { nativeId: "resolved", tenantId: "tenant-a", environmentId: "environment-a", sourceSystem: "power_platform", resourceType: "microsoft.copilotstudio/agents" }, matchedKind: "cds_bot_id" });
    expect(resolveExactInventoryIdentity(identity({ environmentId: null }), [identity({ environmentId: null })])).toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
  });

  it("keeps ambiguous collisions and blueprint children separate", () => {
    expect(resolveExactInventoryIdentity(identity(), [identity({ nativeId: "b" }), identity({ nativeId: "a" })])).toEqual({
      status: "ambiguous",
      reason: "multiple_exact_candidates",
      candidates: [
        { nativeId: "a", tenantId: "tenant-a", environmentId: "environment-a", sourceSystem: "power_platform", resourceType: "microsoft.copilotstudio/agents" },
        { nativeId: "b", tenantId: "tenant-a", environmentId: "environment-a", sourceSystem: "power_platform", resourceType: "microsoft.copilotstudio/agents" },
      ],
    });
    const blueprint = identity({ identifiers: [{ kind: "entra_blueprint_id", value: "blueprint-a" }] });
    expect(resolveExactInventoryIdentity(blueprint, [identity({ nativeId: "child", identifiers: [{ kind: "entra_blueprint_id", value: "blueprint-a" }] })])).toEqual({
      status: "unresolved",
      reason: "blueprint_is_parent_not_equivalence",
    });
  });

  it("retains typed package identifiers without treating package app IDs as Entra app IDs", () => {
    const packaged = packageInventoryIdentity("tenant-a", {
      id: "package-a",
      displayName: "Package",
      isBlocked: false,
      appId: "same-guid",
      manifestId: "manifest-a",
      assetId: "asset-a",
    });
    expect(packaged.identifiers.map(identifier => identifier.kind)).toEqual(["asset_id", "manifest_id", "package_app_id", "package_id"]);
    expect(resolveExactInventoryIdentity(packaged, [identity({ identifiers: [{ kind: "entra_app_id", value: "same-guid" }] })])).toEqual({
      status: "unresolved",
      reason: "no_documented_cross_source_relation",
    });
  });

  it("scopes resource IDs by type and preserves same-native ambiguous candidates", () => {
    const source = identity({ nativeId: "source", identifiers: [{ kind: "power_platform_resource_id", value: "shared" }] });
    expect(resolveExactInventoryIdentity(source, [identity({ nativeId: "other-type", resourceType: "microsoft.powerautomate/agentflows", identifiers: [{ kind: "power_platform_resource_id", value: "shared" }] })])).toEqual({
      status: "unresolved", reason: "no_documented_exact_identifier",
    });

    const multiIdentifierSource = identity({ identifiers: [{ kind: "cds_bot_id", value: "bot-a" }, { kind: "entra_agent_id", value: "agent-a" }] });
    const result = resolveExactInventoryIdentity(multiIdentifierSource, [
      identity({ nativeId: "same-native", environmentId: "environment-a", identifiers: [{ kind: "cds_bot_id", value: "bot-a" }] }),
      identity({ nativeId: "same-native", environmentId: "environment-b", identifiers: [{ kind: "entra_agent_id", value: "agent-a" }] }),
    ]);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates.map(candidate => candidate.environmentId)).toEqual(["environment-a", "environment-b"]);
  });

  it("projects the same allowlisted fixture fields identically on repeated computation", () => {
    const source = identity();
    const candidates = [identity({ nativeId: "z-last", identifiers: [{ kind: "cds_bot_id", value: "same-guid" }, { kind: "entra_agent_id", value: "other" }] }), identity({ nativeId: "a-first" })];
    const first = resolveExactInventoryIdentity(structuredClone(source), structuredClone(candidates));
    const second = resolveExactInventoryIdentity({ ...structuredClone(source), identifiers: [...source.identifiers].reverse() }, structuredClone(candidates).reverse());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({ status: "ambiguous", reason: "multiple_exact_candidates", candidates: [{ nativeId: "a-first" }, { nativeId: "z-last" }] });
  });
});