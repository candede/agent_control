import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryEnvironmentPattern, inventoryGuidPattern, normalizeEnvironmentIdentity, normalizeInventoryIdentifier, normalizeNativeIdentity, powerPlatformAgentKey, resolveExactInventoryIdentity, type InventoryIdentityRecord } from "./inventoryIdentity.js";
import { InventoryIdentityQueries } from "../db/inventoryIdentityQueries.js";
import { LiveInventory } from "../db/liveInventory.js";
import { normalizeEnvironmentIdentitySql, normalizeInventoryIdentifierSql, normalizeNativeIdentitySql } from "../db/inventoryIdentityNormalization.js";
import { inventoryNativeRootChoicesSql } from "../db/inventoryInputScopes.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn((name: string) => name === "SESSION_SECRET" ? "synthetic-identity-unit-session-secret" : undefined),
}));

afterEach(() => vi.restoreAllMocks());

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

  describe("saved identity query contracts without a database", () => {
    const scope = { tenantId: "tenant-a", principalId: "principal-a" };
    const types = ["microsoft.copilotstudio/agents"] as const;
    const guid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const rows = (values: object[]): pg.QueryResult => ({
      command: "SELECT", rowCount: values.length, oid: 0, fields: [], rows: values,
    });
    function fixture() {
      const database = new pg.Pool({ max: 4 });
      vi.spyOn(database, "query").mockRejectedValue(new Error("Identity unit tests must not access a database."));
      vi.spyOn(database, "connect").mockRejectedValue(new Error("Identity unit tests must not connect to a database."));
      const query = vi.fn<(statement: string, parameters?: unknown[]) => Promise<pg.QueryResult>>()
        .mockRejectedValue(new Error("Unexpected identity unit-test query."));
      const client = Object.assign(new pg.Client(), { query, release: vi.fn() });
      return { database, client, query };
    }

    it("keeps typed matching separate from raw native/environment projections and exact source fact ownership", async () => {
      const { database, client, query } = fixture();
      query.mockResolvedValueOnce(rows([{ native_id: guid, environment_id: `Default-${guid}`,
        resource_type: types[0], kind: "cds_bot_id", total: "1" }]));
      const source = identity({ environmentId: `Default-${guid}`, identifiers: [
        { kind: "package_id", value: guid }, { kind: "cds_bot_id", value: guid }, { kind: "entra_app_id", value: "" },
      ] });
      await expect(new InventoryIdentityQueries(database).resolve(client, scope, types, source)).resolves.toEqual({
        status: "resolved", candidate: { nativeId: guid, environmentId: `Default-${guid}`, tenantId: scope.tenantId,
          resourceType: types[0], sourceSystem: "power_platform" }, matchedKind: "cds_bot_id",
      });
      const [sql, values] = query.mock.calls[0];
      expect(values).toEqual([scope.tenantId, scope.principalId, types, JSON.stringify([
        { kind: "package_id", value: guid }, { kind: "cds_bot_id", value: guid.toLowerCase() },
      ]), `default-${guid.toLowerCase()}`, types[0], true]);
      expect(sql).toContain("SELECT n.native_id COLLATE \"C\" AS native_id,n.environment_id COLLATE \"C\" AS environment_id");
      expect(sql).toContain("fact.generation_id=n.generation_id AND fact.identity=n.identity");
      expect(sql).toContain(normalizeInventoryIdentifierSql("requested.kind", "fact.value"));
      expect(sql).toContain("ORDER BY resource_type,normalized_environment_id,normalized_native_id,kind,native_id,environment_id");
      expect(database.connect).not.toHaveBeenCalled();
    });

    it("includes retained resource types in both exact matches and unresolved evidence after a narrowed refresh", async () => {
      const { database, client, query } = fixture();
      query.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ present: true, blueprint: false }]));
      await expect(new InventoryIdentityQueries(database).resolve(client, scope, types, identity()))
        .resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
      for (const [sql] of query.mock.calls) {
        expect(sql).toContain(inventoryNativeRootChoicesSql("roots"));
        expect(sql).toContain("kind=ANY($3::text[])");
        expect(sql).toContain("member.valid_from_revision<=captured.revision");
        expect(sql).toContain("member.valid_to_revision>captured.revision");
        expect(sql).toContain("record.resource_type=kind");
        expect(sql).toContain("root.current AND root.domain='power_platform' AND root.tenant_id=$1");
        expect(sql).toContain("scope.scope_kind='tenant' AND scope.token_mode='tenant'");
        expect(sql).toContain("generation.state='published' AND generation.validated");
        expect(sql).not.toContain("CROSS JOIN LATERAL unnest(attempt.resource_types)");
      }
      expect(database.connect).not.toHaveBeenCalled();
    });

    it("keeps malformed or opaque environment casing exact and excludes confirmed-empty evidence", async () => {
      const { database, client, query } = fixture();
      query.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ present: false, blueprint: false }]));
      await expect(new InventoryIdentityQueries(database).resolve(client, scope, types,
        identity({ environmentId: "Environment-A", identifiers: [{ kind: "cds_bot_id", value: "" }] })))
        .resolves.toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
      expect(query.mock.calls[0][1]).toEqual([scope.tenantId, scope.principalId, types, "[]", "Environment-A", types[0], true]);
      expect(query.mock.calls[0][0]).toContain(`${normalizeEnvironmentIdentitySql("n.environment_id")}=$5`);
      expect(query.mock.calls[1][1]).toEqual([scope.tenantId, scope.principalId, types, []]);
    });

    it("accepts only validated tenant GUID case variants while retaining the authorized query scope", async () => {
      const { database, client, query } = fixture();
      const authorized = { ...scope, tenantId: guid.toLowerCase() };
      query.mockResolvedValueOnce(rows([{ native_id: "native", environment_id: "environment-a",
        resource_type: types[0], kind: "cds_bot_id", total: "1" }]));
      await expect(new InventoryIdentityQueries(database).resolve(client, authorized, types, identity({ tenantId: guid })))
        .resolves.toMatchObject({ status: "resolved", candidate: { tenantId: authorized.tenantId } });
      expect(query.mock.calls[0][1]?.[0]).toBe(authorized.tenantId);
      for (const tenantId of ["Tenant-A", `${guid}\n`, `${guid}\uD800`]) {
        await expect(new InventoryIdentityQueries(database).resolve(client, scope, types, identity({ tenantId })))
          .rejects.toMatchObject({ code: "scope_mismatch" });
      }
      expect(query).toHaveBeenCalledOnce();
    });

    it("reads bounded raw source identifiers and candidates instead of case-folding opaque evidence", async () => {
      const { database, client, query } = fixture();
      const at = new Date();
      const read = { client, evaluatedAt: at };
      query.mockResolvedValueOnce(rows([{ identity: "canonical", generation_id: "canonical-generation", display_name: "Agent",
        environment_id: "Environment-A", link_state: "unmatched", residual: { identity: { reason: null } },
        inventory_baseline_id: "baseline", inventory_revision: "1" }]))
        .mockResolvedValueOnce(rows([{ generation_id: "source-generation", identity: "source-identity",
          observed_at: at, expires_at: new Date(at.getTime() + 60_000),
          residual: { tenantId: scope.tenantId, nativeId: guid, environmentId: "Environment-A", type: types[0] } }]))
        .mockResolvedValueOnce(rows([{ kind: "cds_bot_id", value: guid }, { kind: "entra_app_id", value: "Opaque-App" }]))
        .mockResolvedValueOnce(rows([]));
      const inventory = new LiveInventory(database);
      const record = await inventory.record(scope, `power_platform:Environment-A:${guid}`, read);
      expect(record.native?.identifiers).toEqual([{ kind: "cds_bot_id", value: guid }, { kind: "entra_app_id", value: "Opaque-App" }]);
      expect(query.mock.calls[0][1]).toEqual([scope.tenantId, scope.principalId, null, at, guid.toLowerCase(), "Environment-A"]);
      const identifierSql = query.mock.calls[2][0];
      expect(identifierSql).toContain('f.value COLLATE "C" AS value');
      expect(identifierSql).toContain(normalizeNativeIdentitySql("f.value"));
      expect(query.mock.calls[2][1]).toEqual(["source-generation", "source-identity"]);
      query.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ native_id: guid, environment_id: "Environment-A",
        tenant_id: scope.tenantId, identifier_value: guid }]));
      await expect(inventory.identityCandidates(scope, record, read)).resolves.toEqual([{
        nativeId: guid, environmentId: "Environment-A", tenantId: scope.tenantId, sourceSystem: "power_platform",
        resourceType: types[0], identifiers: [{ kind: "cds_bot_id", value: guid }],
      }]);
      expect(query.mock.calls[4][0]).toContain('c.native_id,c.environment_id,c.tenant_id,f.value AS identifier_value');
      expect(query.mock.calls[4][0]).toContain(`AND ${normalizeNativeIdentitySql("f.value")}=$6`);
      expect(query.mock.calls[4][1]).toEqual([scope.tenantId, scope.principalId, null, at, "entra_app_id", "Opaque-App", "Environment-A"]);
      expect(query.mock.calls[5][1]).toEqual([scope.tenantId, scope.principalId, null, at, "cds_bot_id", guid.toLowerCase(), "Environment-A"]);
      expect(database.connect).not.toHaveBeenCalled();
    });
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

  it("does not treat package app IDs as Entra app IDs", () => {
    const packaged = identity({
      nativeId: "package-a",
      environmentId: null,
      sourceSystem: "graph_packages",
      resourceType: "microsoft.graph/copilotpackages",
      identifiers: [{ kind: "package_id", value: "package-a" }, { kind: "package_app_id", value: "same-guid" }],
    });
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
    expect(powerPlatformAgentKey(`Default-${id}`, id)).toBe(powerPlatformAgentKey(`default-${id.toLowerCase()}`, id.toLowerCase()));
    expect(powerPlatformAgentKey("Default-ENV", id)).not.toBe(powerPlatformAgentKey("default-env", id));
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

  it("keeps SQL validation, canonicalization and opaque equality independent of database collation", () => {
    const nativeSql = normalizeNativeIdentitySql("value");
    const environmentSql = normalizeEnvironmentIdentitySql("value");
    expect(nativeSql).toContain(`length(value)=36 AND value COLLATE "C" ~* '${inventoryGuidPattern}'`);
    expect(environmentSql).toContain(`length(value) IN (36,44) AND value COLLATE "C" ~* '${inventoryEnvironmentPattern}'`);
    for (const sql of [nativeSql, environmentSql]) {
      expect(sql).toContain('THEN lower(value COLLATE "C") ELSE value END) COLLATE "C"');
    }
    expect(normalizeInventoryIdentifierSql("kind", "value")).toContain(
      "WHEN kind COLLATE \"C\" IN ('package_id','package_app_id','manifest_id','asset_id') THEN value",
    );
    expect(normalizeInventoryIdentifierSql("kind", "value")).toContain("WHEN kind COLLATE \"C\"='environment_id'");
  });

  it("normalizes syntactic GUIDs without version restrictions and preserves malformed Unicode identities", () => {
    const guid = "ABCDEFAB-CDEF-FFFF-FFFF-ABCDEFABCDEF";
    expect(normalizeNativeIdentity(guid)).toBe(guid.toLowerCase());
    expect(normalizeEnvironmentIdentity(`DEFAULT-${guid}`)).toBe(`default-${guid.toLowerCase()}`);
    for (const value of ["", guid.slice(1), `${guid}F`, `{${guid}}`, `${guid}\n`, `${guid}\u2028`,
      `${guid.slice(0, -1)}\uD800`, `${guid.slice(0, -1)}\0`, guid.replace("A", "Ａ"), "会社/É:Opaque ",
      "e\u0301", "\uD800", "\uDC00", `Default-${guid}\n`, "default-ENV"]) {
      expect(normalizeNativeIdentity(value)).toBe(value);
      expect(normalizeEnvironmentIdentity(value)).toBe(value);
    }
    for (const kind of ["package_id", "package_app_id", "manifest_id", "asset_id"] as const) {
      expect(normalizeInventoryIdentifier({ kind, value: guid })).toBe(guid);
    }
  });

  it.each(["package_id", "package_app_id", "manifest_id", "asset_id"] as const)(
    "preserves opaque GUID-shaped %s values and package source memberships",
    kind => {
      const value = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
      const source = identity({ sourceSystem: "graph_packages", nativeId: "package", environmentId: null,
        identifiers: [{ kind, value }] });
      expect(resolveExactInventoryIdentity(source, [{ ...source, identifiers: [{ kind, value: value.toLowerCase() }] }]))
        .toEqual({ status: "unresolved", reason: "no_documented_exact_identifier" });
      const candidates = [value, value.toLowerCase()].map(nativeId => ({ ...source, nativeId }));
      const result = resolveExactInventoryIdentity(source, candidates);
      expect(result.status).toBe("ambiguous");
      if (result.status !== "ambiguous") throw new Error("Expected distinct opaque package memberships.");
      expect(result.candidates.map(candidate => candidate.nativeId)).toEqual([value, value.toLowerCase()]);
    },
  );

  it("selects a stable raw representative and matched kind from repeated equivalent native evidence", () => {
    const nativeId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const tenantId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    const source = identity({ tenantId, identifiers: [{ kind: "entra_app_id", value: "app" }, { kind: "cds_bot_id", value: "bot" }] });
    const first = identity({ tenantId, nativeId, identifiers: [{ kind: "entra_app_id", value: "app" }] });
    const second = identity({ tenantId: tenantId.toLowerCase(), nativeId: nativeId.toLowerCase(),
      identifiers: [{ kind: "cds_bot_id", value: "bot" }] });
    const forward = resolveExactInventoryIdentity(source, [first, second]);
    expect(resolveExactInventoryIdentity(source, [second, first, structuredClone(first)])).toEqual(forward);
    expect(forward).toEqual({ status: "resolved", candidate: {
      tenantId: second.tenantId, nativeId: second.nativeId, environmentId: second.environmentId,
      sourceSystem: second.sourceSystem, resourceType: second.resourceType,
    }, matchedKind: "cds_bot_id" });
  });

  it("never manufactures environment equivalence or identity evidence from empty identifiers", () => {
    const source = identity({ environmentId: "Environment-A" });
    expect(resolveExactInventoryIdentity(source, [identity()])).toEqual({
      status: "unresolved", reason: "no_documented_exact_identifier",
    });
    for (const kind of ["cds_bot_id", "entra_blueprint_id"] as const) {
      const empty = identity({ identifiers: [{ kind, value: "" }] });
      expect(resolveExactInventoryIdentity(empty, [empty])).toEqual({
        status: "unresolved", reason: "no_documented_exact_identifier",
      });
    }
    const value = "会社/É:opaque ";
    const opaque = identity({ identifiers: [{ kind: "package_id", value }] });
    expect(resolveExactInventoryIdentity(opaque, [{ ...opaque, identifiers: [{ kind: "package_id", value: value.trim() }] }]).status)
      .toBe("unresolved");
  });
});