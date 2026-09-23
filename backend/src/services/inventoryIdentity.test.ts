import { describe, expect, it } from "vitest";
import { normalizeNativeIdentity, packageInventoryIdentity, powerPlatformAgentKey, resolveExactInventoryIdentity, type InventoryIdentityRecord } from "./inventoryIdentity.js";

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

  it("recognizes any source blueprint as parentage without implying equivalence", () => {
    const source = identity({
      sourceSystem: "defender_hunting",
      identifiers: [
        { kind: "entra_blueprint_id", value: "blueprint-a" },
        { kind: "entra_blueprint_id", value: "blueprint-z" },
      ],
    });
    const candidate = identity({ identifiers: [{ kind: "entra_blueprint_id", value: "blueprint-z" }] });
    expect(resolveExactInventoryIdentity(source, [candidate])).toEqual({
      status: "unresolved", reason: "no_documented_cross_source_relation",
    });
    expect(resolveExactInventoryIdentity(source, [candidate], {
      blueprintParentAcrossSources: true,
      documentedCrossSourceKinds: ["entra_blueprint_id"],
    })).toEqual({ status: "unresolved", reason: "blueprint_is_parent_not_equivalence" });
    expect(resolveExactInventoryIdentity({ ...source, sourceSystem: "power_platform" }, [candidate])).toEqual({
      status: "unresolved", reason: "blueprint_is_parent_not_equivalence",
    });
  });

  it.each([
    { tenantCaseDiffers: true, blueprintCaseDiffers: false },
    { tenantCaseDiffers: false, blueprintCaseDiffers: true },
    { tenantCaseDiffers: true, blueprintCaseDiffers: true },
  ])("normalizes UUIDs consistently for blueprint parentage: %j", ({ tenantCaseDiffers, blueprintCaseDiffers }) => {
    const tenantId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const blueprintId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const source = identity({ tenantId, identifiers: [{ kind: "entra_blueprint_id", value: blueprintId }] });
    const candidate = identity({
      tenantId: tenantCaseDiffers ? tenantId.toLowerCase() : tenantId,
      identifiers: [{ kind: "entra_blueprint_id", value: blueprintCaseDiffers ? blueprintId.toLowerCase() : blueprintId }],
    });
    expect(resolveExactInventoryIdentity(source, [candidate])).toEqual({
      status: "unresolved", reason: "blueprint_is_parent_not_equivalence",
    });
    expect(resolveExactInventoryIdentity(source, [{ ...candidate, tenantId: "another-tenant" }])).toEqual({
      status: "unresolved", reason: "no_documented_exact_identifier",
    });
  });

  it("does not fold opaque blueprint or tenant IDs when reporting parentage", () => {
    const source = identity({ identifiers: [{ kind: "entra_blueprint_id", value: "Blueprint-A" }] });
    expect(resolveExactInventoryIdentity(source, [identity({
      identifiers: [{ kind: "entra_blueprint_id", value: "blueprint-a" }],
    })])).toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
    expect(resolveExactInventoryIdentity(source, [{ ...source, tenantId: "Tenant-A" }])).toEqual({
      status: "unresolved", reason: "no_documented_exact_identifier",
    });
  });

  it("requires documented cross-source kinds even when tenant UUID casing differs", () => {
    const tenantId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const source = identity({
      tenantId, sourceSystem: "defender_hunting",
      identifiers: [{ kind: "entra_agent_id", value: "agent-a" }],
    });
    const candidate = identity({
      tenantId: tenantId.toLowerCase(), identifiers: [{ kind: "entra_agent_id", value: "agent-a" }],
    });
    expect(resolveExactInventoryIdentity(source, [candidate])).toEqual({
      status: "unresolved", reason: "no_documented_cross_source_relation",
    });
    expect(resolveExactInventoryIdentity(source, [candidate], { documentedCrossSourceKinds: ["entra_app_id"] })).toEqual({
      status: "unresolved", reason: "no_documented_cross_source_relation",
    });
    expect(resolveExactInventoryIdentity(source, [candidate], { documentedCrossSourceKinds: ["entra_agent_id"] })).toEqual({
      status: "resolved",
      candidate: {
        nativeId: candidate.nativeId, tenantId: candidate.tenantId, environmentId: candidate.environmentId,
        sourceSystem: candidate.sourceSystem, resourceType: candidate.resourceType,
      },
      matchedKind: "entra_agent_id",
    });
  });

  it("bounds ambiguous candidates while retaining the complete unique count", () => {
    const candidates = Array.from({ length: 21 }, (_, index) => identity({ nativeId: `agent-${String(index).padStart(2, "0")}` }));
    const full = resolveExactInventoryIdentity(identity(), candidates.slice(0, 20));
    expect(full).toMatchObject({ status: "ambiguous", candidates: expect.any(Array) });
    if (full.status !== "ambiguous") throw new Error("Expected ambiguous exact candidates.");
    expect(full.candidates).toHaveLength(20);
    expect(full).not.toHaveProperty("candidateCount");
    expect(full).not.toHaveProperty("candidatesTruncated");
    const truncated = resolveExactInventoryIdentity(identity(), [...candidates, structuredClone(candidates[0])].reverse());
    expect(truncated).toEqual({
      ...full, candidateCount: 21, candidatesTruncated: true,
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
      sourceSystem: "graph_packages",
      authoringTool: null,
      creatorType: "unknown",
      agentKind: "copilot_package",
      lifecycle: "unknown",
      identityConfidence: "exact_native",
      provenance: {},
    });
    expect(packaged.identifiers.map(identifier => identifier.kind)).toEqual(["asset_id", "manifest_id", "package_app_id", "package_id"]);
    expect(resolveExactInventoryIdentity(packaged, [identity({ identifiers: [{ kind: "entra_app_id", value: "same-guid" }] })])).toEqual({
      status: "unresolved",
      reason: "no_documented_cross_source_relation",
    });
  });

  it("scopes resource IDs by type and preserves same-native ambiguous candidates", () => {
    const source = identity({ nativeId: "source", identifiers: [{ kind: "power_platform_resource_id", value: "shared" }] });
    expect(resolveExactInventoryIdentity(source, [identity({ nativeId: "other-type", resourceType: "microsoft.powerplatform/environments", identifiers: [{ kind: "power_platform_resource_id", value: "shared" }] })])).toEqual({
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

  it("normalizes UUID and environment casing without folding opaque source IDs or identifier kinds", () => {
    const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(normalizeNativeIdentity(id)).toBe(id.toLowerCase());
    expect(normalizeNativeIdentity("Opaque-A")).toBe("Opaque-A");
    expect(normalizeNativeIdentity(`${id}\n`)).toBe(`${id}\n`);
    expect(normalizeNativeIdentity(`${id}\u2028`)).toBe(`${id}\u2028`);
    expect(powerPlatformAgentKey("Default-ENV", id)).toBe(powerPlatformAgentKey("default-env", id.toLowerCase()));
    expect(powerPlatformAgentKey("env", "Opaque-A")).not.toBe(powerPlatformAgentKey("env", "opaque-a"));
    const source = identity({ tenantId: id, environmentId: `Default-${id}`, identifiers: [{ kind: "cds_bot_id", value: id }] });
    const candidate = identity({
      tenantId: id.toLowerCase(), environmentId: `default-${id.toLowerCase()}`,
      identifiers: [{ kind: "cds_bot_id", value: id.toLowerCase() }],
    });
    expect(resolveExactInventoryIdentity(source, [candidate])).toMatchObject({ status: "resolved", matchedKind: "cds_bot_id" });
    expect(resolveExactInventoryIdentity(source, [{ ...candidate, identifiers: [{ kind: "manifest_id", value: id.toLowerCase() }] }]).status)
      .toBe("unresolved");
  });
});