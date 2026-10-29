import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "./packageObservation.js";
import { resolvePackageAgentLinks, withVerifiedControlIdentities } from "./packageAgentIdentity.js";
import { packageInventoryRecord, powerPlatformInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";
import { buildRecords } from "./inventoryComponent.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { findUnifiedAgentRecord } from "../../../frontend/src/unifiedAgentIdentity.js";

const environmentId = "11111111-1111-4111-8111-111111111111";
const cdsBotId = "22222222-2222-4222-8222-222222222222";
const entraAgentId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";

function packaged(metadata: unknown = { SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId }, AgentIdentityId: entraAgentId }) {
  return allowlistedPackage({
    id: "package-a", displayName: "Same name", isBlocked: false, manifestId: cdsBotId, appId: entraAgentId,
    elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify(metadata) }] }],
  });
}

function resource(overrides: Partial<PowerPlatformResource> = {}): PowerPlatformResource {
  return {
    tenantId: "tenant-a", nativeId: cdsBotId, type: "microsoft.copilotstudio/agents", location: null,
    displayName: "Same name", environmentId, createdAt: null, createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
    agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
    identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "entra_agent_id", value: entraAgentId }],
    provenance: {}, details: {}, unknownFieldCount: 0, ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("explicit package-to-agent identity", () => {
  it("links explicit Entra agent metadata only in the same tenant and environment", () => {
    const result = resolvePackageAgentLinks("tenant-a", [packaged()], [resource()]);
    expect(result).toEqual([{
      packageId: "package-a", status: "matched", resource: { nativeId: cdsBotId, environmentId },
      evidence: [{ kind: "entra_agent_id", basis: "source_declared_metadata", elementIds: ["metadata"], packagePath: expect.any(String), resourcePath: expect.any(String) }],
    }]);
    expect(resolvePackageAgentLinks("tenant-b", [packaged()], [resource()])[0].status).toBe("unmatched");
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({ environmentId: otherId })])[0].status).toBe("unmatched");
  });

  it("links explicit environment/CDS identities without equating native resource IDs", () => {
    const packageValue = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId } });
    expect(resolvePackageAgentLinks("tenant-a", [packageValue], [resource()])[0].status).toBe("unmatched");
    expect(resolvePackageAgentLinks("tenant-a", [packageValue], [resource({
      nativeId: "resource-native-id",
      identifiers: [{ kind: "cds_bot_id", value: cdsBotId }],
    })])[0]).toMatchObject({ status: "matched", evidence: [{ kind: "environment_cds_bot_id" }] });
  });

  it("does not match names, package app IDs, manifest IDs or blueprint parent identities", () => {
    const value = packaged();
    delete value.elementDetails;
    expect(resolvePackageAgentLinks("tenant-a", [value], [resource()])[0].status).toBe("unmatched");
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({
      identifiers: [{ kind: "entra_blueprint_id", value: entraAgentId }],
    })])[0].status).toBe("unmatched");
  });

  it("distinguishes uncollected details from collected details without provider identity metadata", () => {
    const value = packaged();
    delete value.elementDetails;
    expect(resolvePackageAgentLinks("tenant-a", [value], [resource()])[0]).toMatchObject({
      status: "unmatched", reason: expect.stringContaining("Refresh package details"),
    });
    expect(resolvePackageAgentLinks("tenant-a", [{ ...value, identityDetailsCollected: true }], [resource()])[0]).toMatchObject({
      status: "unmatched", reason: "Package details were collected, but Microsoft Graph did not supply native agent metadata or a corroborated declarative manifest identity.",
    });
  });

  it("does not use inherited declarative identity evidence or malformed stale elements for linking", () => {
    const catalog = allowlistedPackage({ id: "own-package", displayName: "Fixture", isBlocked: false });
    const inherited = Object.assign(Object.create({
      manifestId: cdsBotId, elementTypes: ["DeclarativeCopilots"],
    }), catalog);
    const native = resource({ details: { schemaName: cdsBotId } });
    expect(resolvePackageAgentLinks("tenant-a", [inherited], [native])[0].status).toBe("unmatched");
    const malformed = { ...catalog, manifestId: cdsBotId, elementTypes: ["DeclarativeCopilots"],
      detailFreshness: { state: "stale" as const, observedAt: null, expiresAt: null } };
    Object.defineProperty(malformed, "elementDetails", { value: [{ elementType: "DeclarativeCopilots", elements: null }] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolvePackageAgentLinks("tenant-a", [malformed], [native])[0]).toMatchObject({ status: "unmatched", invalidMetadata: true });
    const accessor = { ...catalog };
    const getter = vi.fn(() => cdsBotId);
    Object.defineProperty(accessor, "manifestId", { get: getter });
    expect(resolvePackageAgentLinks("tenant-a", [accessor], [native])[0]).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(getter).not.toHaveBeenCalled();
  });

  it("requires environment, schema name and source-declared CDS identity together for inventory native IDs", () => {
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, SchemaName: "cr123_clinicalAgent", CdsBotId: cdsBotId } });
    const saved = resource({
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: cdsBotId }],
      details: { schemaName: "cr123_clinicalAgent" },
    });
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0]).toMatchObject({
      status: "matched", controlBotId: cdsBotId, evidence: [{ kind: "environment_schema_native_id" }],
    });
    for (const changed of [
      { details: {} }, { details: { schemaName: "cr123_unrelated" } }, { nativeId: otherId },
      { environmentId: otherId }, { environmentId: `Default-${environmentId}` }, { tenantId: "tenant-b" },
      { type: "microsoft.powerplatform/environments" as const },
    ]) expect(resolvePackageAgentLinks("tenant-a", [value], [{ ...saved, ...changed }])[0].status).toBe("unmatched");
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved, { ...saved }])[0].status).toBe("ambiguous");
    expect(resolvePackageAgentLinks("tenant-a", [value], [{
      ...saved, identifiers: [...saved.identifiers, { kind: "cds_bot_id", value: otherId }],
    }])[0].status).toBe("conflicting");
  });

  it("rejects package representations that disagree even when one identifier matches", () => {
    const different = { ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: otherId }, AgentIdentityId: entraAgentId }), id: "other-package" };
    expect(resolvePackageAgentLinks("tenant-a", [packaged(), different], [resource()]).map(result => result.status))
      .toEqual(["conflicting", "conflicting"]);
  });

  it("rejects cross-package schema disagreements", () => {
    const packages = ["cr123_agent", "cr123_other"].map((SchemaName, index) => ({
      ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName }, AgentIdentityId: entraAgentId }),
      id: `package-${index}`,
    }));
    for (const ordered of [packages, [...packages].reverse()]) {
      expect(resolvePackageAgentLinks("tenant-a", ordered, [resource()]).map(result => result.status))
        .toEqual(["conflicting", "conflicting"]);
    }
  });

  it("rejects source-native schema disagreements even when only one package matches inventory", () => {
    const packages = ["cr123_agent", "cr123_other"].map((SchemaName, index) => ({
      ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName } }),
      id: `package-${index}`,
    }));
    const saved = resource({ identifiers: [], details: { schemaName: "cr123_agent" } });
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    const observation = { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
    for (const ordered of [packages, [...packages].reverse()]) {
      const links = resolvePackageAgentLinks("tenant-a", ordered, [saved]);
      expect(links.map(link => link.status)).toEqual(["conflicting", "conflicting"]);
      expect(withVerifiedControlIdentities([saved], links, Object.fromEntries(
        packages.map(value => [value.id, observation]),
      ), now)[0]).toBe(saved);
    }
  });

  it("allows absent and case-equivalent schema names across package representations", () => {
    const packages = [undefined, "", null, "cr123_agent", "CR123_AGENT", "cr123_agent"].map((SchemaName, index) => ({
      ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName }, AgentIdentityId: entraAgentId }),
      id: `package-${index}`,
    }));
    expect(resolvePackageAgentLinks("tenant-a", packages, [resource()]).map(result => result.status))
      .toEqual(packages.map(() => "matched"));
    const otherEnvironment = {
      ...packaged({ SourceIds: { EnvironmentId: otherId, CdsBotId: cdsBotId, SchemaName: "cr123_other" }, AgentIdentityId: entraAgentId }),
      id: "other-environment",
    };
    expect(resolvePackageAgentLinks("tenant-a", [...packages, otherEnvironment], [
      resource(), resource({ environmentId: otherId, identifiers: [{ kind: "entra_agent_id", value: entraAgentId }] }),
    ]).map(result => result.status)).toEqual([...packages, otherEnvironment].map(() => "matched"));
  });

  it.each([
    { name: "invalid characters", SchemaName: "invalid-schema" },
    { name: "trailing newline", SchemaName: "cr123_agent\n" },
    { name: "trailing Unicode line separator", SchemaName: "cr123_agent\u2028" },
    { name: "overlong string", SchemaName: "a".repeat(513) },
    { name: "number", SchemaName: 123 },
    { name: "boolean", SchemaName: false },
    { name: "array", SchemaName: [] },
    { name: "object", SchemaName: {} },
  ])(
    "rejects malformed supplied package schema names ($name)",
    ({ SchemaName }) => {
      const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const value = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName }, AgentIdentityId: entraAgentId });
      expect(resolvePackageAgentLinks("tenant-a", [value], [resource()])[0]).toMatchObject({
        status: "unmatched", reason: expect.stringContaining("invalid"),
      });
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).toContain("invalid_typed_identity");
    },
  );

  it.each([1, 512])("accepts corroborated schema names at the %i-character boundary", length => {
    const schemaName = "a".repeat(length);
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: schemaName } });
    const saved = resource({
      identifiers: [{ kind: "environment_id", value: environmentId }],
      details: { schemaName: schemaName.toUpperCase() },
    });
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0]).toMatchObject({
      status: "matched", controlBotId: cdsBotId, evidence: [{ kind: "environment_schema_native_id" }],
    });
  });

  it.each([
    { name: "invalid characters", schemaName: "invalid-schema" },
    { name: "trailing newline", schemaName: "cr123_agent\n" },
    { name: "overlong string", schemaName: "a".repeat(513) },
  ])(
    "rejects malformed supplied inventory schema names ($name)",
    ({ schemaName }) => {
      expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({ details: { schemaName } })])[0])
        .toMatchObject({ status: "conflicting", reason: expect.stringContaining("conflicting") });
    },
  );

  it("never qualifies a control identity using schema names with a trailing newline", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const SchemaName = "cr123_agent\n";
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName } });
    const saved = resource({ identifiers: [{ kind: "environment_id", value: environmentId }], details: { schemaName: SchemaName } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    expect(withVerifiedControlIdentities([saved], links, {
      [value.id]: { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() },
    }, now)[0]).toBe(saved);
    expect(links[0].status).toBe("unmatched");
  });

  it("qualifies control identities only from fresh corroborated observations without mutating saved resources", () => {
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, SchemaName: "cr123_agent", CdsBotId: cdsBotId } });
    const saved = resource({ identifiers: [{ kind: "environment_id", value: environmentId }], details: { schemaName: "cr123_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    const observation = { observedAt: "2026-09-16T11:00:00.000Z", expiresAt: "2026-09-17T12:00:00.000Z" };
    const qualified = withVerifiedControlIdentities([saved], links, { [value.id]: observation }, now)[0];
    expect(qualified.identifiers).toContainEqual({ kind: "cds_bot_id", value: cdsBotId });
    expect(qualified.provenance["identifiers.cds_bot_id"]).toMatchObject({ sourceSystem: "graph_packages", maturity: "preview" });
    expect(saved.identifiers).not.toContainEqual({ kind: "cds_bot_id", value: cdsBotId });
    for (const stale of [
      { ...observation, observedAt: "2026-09-14T12:00:00.000Z" },
      { ...observation, observedAt: "invalid" },
      { ...observation, observedAt: "2026-09-17T11:00:00.000Z" },
      { ...observation, expiresAt: "2026-09-16T11:59:59.000Z" },
      { ...observation, identityDetails: { ...observation, observedAt: "2026-09-14T12:00:00.000Z" } },
      { ...observation, observedAt: "2026-09-14T12:00:00.000Z", identityDetails: observation },
    ]) expect(withVerifiedControlIdentities([saved], links, { [value.id]: stale }, now)[0]).toBe(saved);
    expect(withVerifiedControlIdentities([saved], links, {}, now)[0]).toBe(saved);
  });

  it.each([null, undefined])("does not replace explicitly missing identity-detail proof with catalog freshness (%s)", identityDetails => {
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } });
    const saved = resource({ identifiers: [], details: { schemaName: "cr_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    expect(links[0]).toMatchObject({ status: "matched", controlBotId: cdsBotId });
    const now = Date.parse("2026-09-16T12:00:00Z");
    const fresh = { observedAt: "2026-09-16T11:00:00Z", expiresAt: "2026-09-16T13:00:00Z" };
    const unqualified = withVerifiedControlIdentities([saved], links, { [value.id]: { ...fresh, identityDetails } }, now)[0];
    expect(unqualified).toBe(saved);
    expect(powerPlatformInventoryRecord(unqualified).facts.some(fact => fact.kind === "control:quarantine")).toBe(false);
    expect(withVerifiedControlIdentities([saved], links, { [value.id]: { ...fresh, identityDetails: fresh } }, now)[0].identifiers)
      .toContainEqual({ kind: "cds_bot_id", value: cdsBotId });
  });

  it.each([
    { packageId: "__proto__", otherPackageId: "constructor" },
    { packageId: "constructor", otherPackageId: "toString" },
    { packageId: "Package:Opaque", otherPackageId: "package:opaque" },
    { packageId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", otherPackageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { packageId: "Agent/É🌏", otherPackageId: "Agent/E\u0301🌏" },
  ])("requires an own fresh control observation for the exact opaque package ID ($packageId)", ({ packageId, otherPackageId }) => {
    const value = { ...packaged({
      SourceIds: { EnvironmentId: environmentId, SchemaName: "cr123_agent", CdsBotId: cdsBotId },
    }), id: packageId };
    const saved = resource({ identifiers: [{ kind: "environment_id", value: environmentId }], details: { schemaName: "cr123_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    expect(links[0]).toMatchObject({ packageId, status: "matched", controlBotId: cdsBotId });
    const now = Date.parse("2026-09-16T12:00:00.000Z");
    const observation = { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
    const inherited = Object.create(Object.fromEntries([[packageId, observation]]));
    const unqualified = withVerifiedControlIdentities([saved], links, inherited, now)[0];
    expect(unqualified).toBe(saved);
    expect(powerPlatformInventoryRecord(unqualified).facts.filter(fact => fact.kind === "control:quarantine")).toEqual([]);
    expect(withVerifiedControlIdentities([saved], links, Object.fromEntries([[otherPackageId, observation]]), now)[0]).toBe(saved);
    const qualified = withVerifiedControlIdentities([saved], links, Object.fromEntries([[packageId, observation]]), now)[0];
    expect(qualified.identifiers).toContainEqual({ kind: "cds_bot_id", value: cdsBotId });
    expect(powerPlatformInventoryRecord(qualified).facts.filter(fact => fact.kind === "control:quarantine"))
      .toMatchObject([{ payload: { environmentId, botId: cdsBotId } }]);
    expect(saved.identifiers).toEqual([{ kind: "environment_id", value: environmentId }]);
  });

  it.each(["catalog", "identity"] as const)(
    "compares exact control %s observation instants without truncating fractional evidence",
    source => {
      const value = packaged({ SourceIds: { EnvironmentId: environmentId, SchemaName: "cr_agent", CdsBotId: cdsBotId } });
      const saved = resource({ details: { schemaName: "cr_agent" } });
      const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
      const now = Date.parse("2026-09-16T12:00:00Z");
      const fresh = { observedAt: "2026-09-16T11:00:00Z", expiresAt: "2026-09-16T13:00:00Z" };
      for (const [changed, expected] of [
        [{ ...fresh, observedAt: "2026-09-16T12:00:00.000000001Z" }, false],
        [{ ...fresh, observedAt: "2026-09-16T14:00:00.000000001+02:00" }, false],
        [{ ...fresh, expiresAt: "2026-09-16T12:00:00.000000001Z" }, true],
        [{ ...fresh, expiresAt: "2026-09-16T14:00:00.000000001+02:00" }, true],
        [{ ...fresh, expiresAt: "2026-09-16T12:00:00Z" }, false],
        [{ ...fresh, observedAt: "2026-09-15T11:59:59.999999999Z" }, false],
        [{ ...fresh, observedAt: "2026-09-15T12:00:00.000000001Z" }, true],
        [{ ...fresh, observedAt: "2026-09-16" }, false],
        [{ ...fresh, observedAt: "2026-02-30T12:00:00Z" }, false],
      ] as const) {
        const observation = source === "catalog" ? { ...changed, identityDetails: fresh }
          : { ...fresh, identityDetails: changed };
        const qualified = withVerifiedControlIdentities([saved], links, { [value.id]: observation }, now)[0];
        expect(qualified.identifiers.some(identifier => identifier.kind === "cds_bot_id"), JSON.stringify(changed)).toBe(expected);
        expect(powerPlatformInventoryRecord(qualified).facts.some(fact => fact.kind === "control:quarantine")).toBe(expected);
      }
    },
  );

  it("requires own timestamp data in each qualifying control observation", () => {
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } });
    const saved = resource({ details: { schemaName: "cr_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    const now = Date.parse("2026-09-16T12:00:00Z");
    const fresh = { observedAt: "2026-09-16T11:00:00Z", expiresAt: "2026-09-16T13:00:00Z" };
    for (const observation of [
      Object.create(fresh), { ...fresh, identityDetails: Object.create(fresh) },
    ]) expect(withVerifiedControlIdentities([saved], links, { [value.id]: observation }, now)[0]).toBe(saved);
    const getter = vi.fn(() => fresh.observedAt);
    const accessor = { ...fresh };
    Object.defineProperty(accessor, "observedAt", { get: getter });
    expect(withVerifiedControlIdentities([saved], links, { [value.id]: accessor }, now)[0]).toBe(saved);
    const identityAccessor = { ...fresh };
    Object.defineProperty(identityAccessor, "identityDetails", { get: () => fresh });
    expect(withVerifiedControlIdentities([saved], links, { [value.id]: identityAccessor }, now)[0]).toBe(saved);
    expect(getter).not.toHaveBeenCalled();
  });

  it("retains many package representations of one exact agent", () => {
    const result = resolvePackageAgentLinks("tenant-a", [packaged(), { ...packaged(), id: "package-b" }], [resource()]);
    expect(result.map(value => value.status)).toEqual(["matched", "matched"]);
    expect(result.map(value => value.packageId)).toEqual(["package-a", "package-b"]);
  });

  it("refuses ambiguous candidates and conflicting typed identifiers", () => {
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource(), resource({ nativeId: otherId })])[0].status).toBe("ambiguous");
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({
      identifiers: [{ kind: "entra_agent_id", value: entraAgentId }, { kind: "cds_bot_id", value: otherId }],
    })])[0].status).toBe("conflicting");
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({
      identifiers: [{ kind: "entra_agent_id", value: entraAgentId }, { kind: "cds_bot_id", value: "invalid" }],
    })])[0].status).toBe("conflicting");
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({
      identifiers: [{ kind: "entra_agent_id", value: entraAgentId }, { kind: "environment_id", value: otherId }],
    })])[0].status).toBe("conflicting");
  });

  it("rejects conflicting metadata groups rather than selecting the first", () => {
    const value = packaged();
    value.elementDetails!.push(packaged({ SourceIds: { EnvironmentId: otherId, CdsBotId: cdsBotId } }).elementDetails![0]);
    expect(resolvePackageAgentLinks("tenant-a", [value], [resource()])[0].status).toBe("conflicting");
  });

  it("normalizes GUID casing but not ID kinds or resource types", () => {
    const value = packaged({ SourceIds: { EnvironmentId: `Default-${environmentId}`.toUpperCase(), CdsBotId: cdsBotId }, AgentIdentityId: entraAgentId });
    expect(resolvePackageAgentLinks("tenant-a", [value], [resource({
      environmentId: `Default-${environmentId}`,
      identifiers: [{ kind: "environment_id", value: `Default-${environmentId}` }, { kind: "entra_agent_id", value: entraAgentId }],
    })])[0].status).toBe("matched");
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({ type: "microsoft.powerplatform/environments" })])[0].status).toBe("unmatched");
  });

  it("surfaces invalid metadata without logging provider definition contents", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = packaged();
    value.elementDetails![0].elements[0].definition = "customer-secret-invalid-json";
    expect(resolvePackageAgentLinks("tenant-a", [value], [resource()])[0]).toMatchObject({ status: "unmatched", reason: expect.stringContaining("invalid") });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("customer-secret");
  });

  it("does not link or qualify controls after duplicate saved identity properties erase conflicting evidence", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = packaged();
    value.elementDetails![0].elements[0].definition = `{"SourceIds":{
      "EnvironmentId":"${environmentId}","CdsBotId":"${otherId}","CdsBotId":"${cdsBotId}","SchemaName":"cr_agent"
    }}`;
    const saved = resource({ identifiers: [{ kind: "environment_id", value: environmentId }], details: { schemaName: "cr_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    expect(links[0]).toMatchObject({ status: "unmatched", invalidMetadata: true });
    const now = Date.parse("2026-09-16T12:00:00Z");
    const observation = { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
    expect(withVerifiedControlIdentities([saved], links, { [value.id]: observation }, now)[0]).toBe(saved);
    const records = buildRecords([value], [saved], links, null, null);
    expect(records).toHaveLength(2);
    const selected = findUnifiedAgentRecord(records, unifiedAgentRecordId({ source: "graph_packages", packageId: value.id }));
    expect(selected).toMatchObject({ presence: "graph_packages", powerPlatformResource: null, identity: { state: "unmatched" } });
  });

  it("resolves the complete 5,000-record inventory without depending on source order", () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    const packages = ids.map(id => ({
      ...packaged({ SourceIds: { EnvironmentId: environmentId }, AgentIdentityId: id }),
      id: `package-${id}`,
    }));
    const resources = ids.map(id => resource({ nativeId: id, identifiers: [{ kind: "entra_agent_id", value: id }] }));
    const results = resolvePackageAgentLinks("tenant-a", packages, resources.reverse());
    expect(results).toHaveLength(5_000);
    expect(results.every(result => result.status === "matched")).toBe(true);
    expect(results.map(result => result.packageId)).toEqual(packages.map(value => value.id));
  });

  function declarativePackage(id = "builder-package") {
    return {
      ...allowlistedPackage({
        id, displayName: "Builder agent", isBlocked: false, manifestId: cdsBotId,
        platform: "Microsoft 365 Copilot Agent Builder", elementTypes: ["DeclarativeCopilots"],
        elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "declarative", definition: "{}" }] }],
      }),
      identityDetailsCollected: true as const,
    };
  }

  function declarativeResource() {
    return resource({
      authoringTool: null, agentKind: "agent", displayName: "Different saved display name",
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: cdsBotId }],
      details: { schemaName: cdsBotId, model: "Microsoft 365 Copilot", isQuarantined: false },
    });
  }

  it("links builder packages by the complete manifest/native/schema identity without AgentMetadatas", () => {
    const result = resolvePackageAgentLinks("tenant-a", [declarativePackage()], [declarativeResource()])[0];
    expect(result).toMatchObject({
      packageId: "builder-package", status: "matched", resource: { nativeId: cdsBotId, environmentId },
      evidence: [{ kind: "manifest_schema_native_id", basis: "source_declared_metadata" }],
    });
    expect(result).not.toHaveProperty("controlBotId");
    const saved = declarativeResource();
    const now = Date.now();
    expect(withVerifiedControlIdentities([saved], [result], {
      "builder-package": { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() },
    }, now)[0]).toBe(saved);
  });

  it.each(["missing", "stale"] as const)("matches catalog manifest proof independently of %s details", state => {
    const value = { ...declarativePackage(), detailFreshness: { state, observedAt: null, expiresAt: null } };
    const result = resolvePackageAgentLinks("tenant-a", [value], [declarativeResource()])[0];
    expect(result).toMatchObject({
      status: "matched", evidence: [{ kind: "manifest_schema_native_id", elementIds: [] }],
    });
    expect(result).not.toHaveProperty("controlBotId");
    expect(resolvePackageAgentLinks("tenant-a", [value], [])[0]).toHaveProperty("grouping");
    for (const changed of [
      { identityRevalidationRequired: true as const },
      { detailFreshness: { state: "invalidated" as const, observedAt: null, expiresAt: null } },
      { elementTypes: [] },
      { elementDetails: [...value.elementDetails!, ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: otherId } }).elementDetails!] },
      { elementDetails: [{ elementType: "DeclarativeCopilots", elements: [
        { id: "first", definition: "{}" }, { id: "second", definition: "{}" },
      ] }] },
    ]) {
      const rejected = resolvePackageAgentLinks("tenant-a", [{ ...value, ...changed }], [declarativeResource()])[0];
      expect(rejected.status).not.toBe("matched");
      expect(rejected).not.toHaveProperty("grouping");
    }
  });

  it("requires declarative kind, manifest identity, and matching native and schema IDs together", () => {
    const value = declarativePackage();
    const saved = declarativeResource();
    for (const changed of [
      { manifestId: undefined, appId: cdsBotId, assetId: cdsBotId },
      { elementTypes: [], elementDetails: [] },
      { manifestId: otherId },
      { manifestId: `${cdsBotId}\n` },
    ]) expect(resolvePackageAgentLinks("tenant-a", [{ ...value, ...changed }], [saved])[0].status).toBe("unmatched");
    for (const changed of [
      { nativeId: otherId }, { details: { schemaName: otherId } }, { details: {} },
      { tenantId: "tenant-b" }, { type: "microsoft.powerplatform/environments" as const }, { environmentId: null },
    ]) expect(resolvePackageAgentLinks("tenant-a", [value], [{ ...saved, ...changed }])[0].status).toBe("unmatched");
  });

  it("refuses ambiguous manifest resources across environments instead of picking a matching name", () => {
    const value = declarativePackage();
    const saved = declarativeResource();
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved, {
      ...saved, environmentId: otherId, displayName: value.displayName,
      identifiers: [{ kind: "environment_id", value: otherId }, { kind: "power_platform_resource_id", value: cdsBotId }],
    }])[0].status).toBe("ambiguous");
    value.elementDetails![0].elements.push({ id: "second-agent", definition: "{}" });
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0].status).toBe("ambiguous");
  });

  it("retains environment-only metadata as a constraint on declarative manifest matching", () => {
    const value = declarativePackage();
    value.elementDetails!.push(packaged({ SourceIds: { EnvironmentId: otherId } }).elementDetails![0]);
    const saved = declarativeResource();
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0].status).toBe("unmatched");
    const sameEnvironment = {
      ...saved, environmentId: otherId,
      identifiers: [{ kind: "environment_id" as const, value: otherId }],
    };
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved, sameEnvironment])[0]).toMatchObject({
      status: "matched", resource: { nativeId: cdsBotId, environmentId: otherId },
    });
  });

  it("does not group declarative manifests across distinct declared environments without inventory", () => {
    const packages = [environmentId, otherId].map((EnvironmentId, index) => {
      const value = declarativePackage(`package-${index}`);
      value.elementDetails!.push(packaged({
        SourceIds: { EnvironmentId }, AgentIdentityId: entraAgentId,
      }).elementDetails![0]);
      return value;
    });
    for (const ordered of [packages, [...packages].reverse()]) {
      const links = resolvePackageAgentLinks("tenant-a", ordered, []);
      expect(links).toMatchObject(ordered.map(value => ({
        packageId: value.id, status: "unmatched",
        grouping: { environmentId: value.id === "package-0" ? environmentId : otherId },
      })));
      expect(new Set(links.map(link => link.status !== "matched" ? link.grouping?.key : undefined)).size).toBe(2);
    }
  });

  it("retains all package representations of one builder agent and groups them even without a PP observation", () => {
    const packages = [declarativePackage("package-b"), declarativePackage("package-a")];
    expect(resolvePackageAgentLinks("tenant-a", packages, [declarativeResource()]).map(link => link.status)).toEqual(["matched", "matched"]);
    const links = resolvePackageAgentLinks("tenant-a", packages, []);
    expect(links).toMatchObject([
      { status: "unmatched", grouping: { key: expect.any(String), environmentId: null } },
      { status: "unmatched", grouping: { key: expect.any(String), environmentId: null } },
    ]);
    if (links[0].status !== "matched" && links[1].status !== "matched") {
      expect(links[0].grouping?.key).toBe(links[1].grouping?.key);
    }
  });

  it("does not replace an explicit Studio native identity with a coincidentally equal manifest", () => {
    const value = declarativePackage();
    value.elementDetails!.push(packaged({
      SourceIds: { EnvironmentId: environmentId, CdsBotId: otherId, SchemaName: "cr_other" },
    }).elementDetails![0]);
    expect(resolvePackageAgentLinks("tenant-a", [value], [declarativeResource()])[0].status).toBe("unmatched");
  });

  it("keeps source-specific agent IDs separate when exact environment, CDS bot and schema agree", () => {
    const value = packaged({
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
      AgentIdentityId: entraAgentId,
    });
    const saved = resource({
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "entra_agent_id", value: otherId }],
      details: { schemaName: "cr_agent" },
    });
    const second = { ...packaged({
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "CR_AGENT" },
      AgentIdentityId: "55555555-5555-4555-8555-555555555555",
    }), id: "second-package" };
    for (const ordered of [[value, second], [second, value]]) {
      expect(resolvePackageAgentLinks("tenant-a", ordered, [saved])).toMatchObject(ordered.map(item => ({
        packageId: item.id, status: "matched", controlBotId: cdsBotId,
        evidence: [{ kind: "environment_schema_native_id" }],
        warnings: [{ code: "source_specific_agent_identity" }],
      })));
    }
    expect(saved.identifiers).toEqual([{ kind: "environment_id", value: environmentId }, { kind: "entra_agent_id", value: otherId }]);
  });

  it("prioritizes source-native identity over an ancillary source-agent alias collision", () => {
    const value = packaged({
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" }, AgentIdentityId: entraAgentId,
    });
    const exact = resource({
      identifiers: [{ kind: "cds_bot_id", value: cdsBotId }], details: { schemaName: "cr_agent" },
    });
    const unrelated = resource({
      nativeId: otherId, identifiers: [{ kind: "cds_bot_id", value: otherId }, { kind: "entra_agent_id", value: entraAgentId }],
      details: { schemaName: "cr_unrelated" },
    });
    expect(resolvePackageAgentLinks("tenant-a", [value], [unrelated, exact])[0])
      .toMatchObject({ status: "matched", resource: { nativeId: cdsBotId, environmentId } });
  });

  it("unifies complementary metadata fragments but never conflicting source-native fragments", () => {
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId } });
    value.elementDetails!.push({
      elementType: "agentmetadatas", elements: [{
        id: "more-metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" }, AgentIdentityId: entraAgentId,
        }),
      }],
    });
    const saved = resource({ details: { schemaName: "cr_agent" } });
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0])
      .toMatchObject({ status: "matched", evidence: [expect.objectContaining({ elementIds: ["metadata", "more-metadata"] }), expect.anything()] });
    value.elementDetails![1].elements[0].definition = JSON.stringify({ SourceIds: { EnvironmentId: environmentId, CdsBotId: otherId } });
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0].status).toBe("conflicting");
  });

  it("does not group source-only packages with conflicting native schema identities", () => {
    const values = ["cr_one", "cr_two"].map((SchemaName, index) => ({
      ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName } }), id: `package-${index}`,
    }));
    expect(resolvePackageAgentLinks("tenant-a", values, []).map(link => link.status)).toEqual(["conflicting", "conflicting"]);
  });

  it("uses an explicit source Entra application ID, never the package-management app ID", () => {
    const saved = resource({ nativeId: "opaque-resource", identifiers: [{ kind: "entra_app_id", value: otherId }] });
    const value = packaged({ SourceIds: { EnvironmentId: environmentId, EntraApplicationId: otherId } });
    expect(resolvePackageAgentLinks("tenant-a", [value], [saved])[0]).toMatchObject({
      status: "matched", evidence: [{ kind: "environment_entra_app_id" }],
    });
    const opaque = { ...value, appId: otherId, elementDetails: undefined };
    expect(resolvePackageAgentLinks("tenant-a", [opaque], [saved])[0].status).toBe("unmatched");
  });

  function customEnginePackage(id: string, metadata: unknown = {}, botApplicationId = entraAgentId) {
    const value = { ...packaged(metadata), id };
    value.elementDetails!.push(
      { elementType: "Bots", elements: [{ id: botApplicationId, definition: JSON.stringify({ botId: botApplicationId }) }] },
      { elementType: "CustomEngineCopilots", elements: [{ id: botApplicationId, definition: JSON.stringify({
        type: "bot", id: botApplicationId, botId: botApplicationId,
      }) }] },
    );
    return value;
  }

  function declarativeCustomEnginePackage(id: string, manifestId = cdsBotId, metadata: unknown = {}) {
    const value = customEnginePackage(id, metadata);
    value.manifestId = manifestId;
    value.elementTypes = ["DeclarativeCopilots", "Bots", "CustomEngineCopilots"];
    value.elementDetails!.push({ elementType: "DeclarativeCopilots", elements: [{ id: "declarative", definition: "{}" }] });
    return value;
  }

  it.each([cdsBotId, otherId])(
    "does not let a custom-engine bot application override incompatible declarative native/schema proof (%s)",
    manifestId => {
      const native = customEnginePackage("native", {
        SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
      });
      const declared = declarativeCustomEnginePackage("declared", manifestId);
      const legacy = customEnginePackage("legacy");
      const packages = [native, declared, legacy].map(value => {
        const stored = packageInventoryRecord(value);
        return restoreInventoryRecord(stored.residual, stored.facts, "packages") as typeof value;
      });
      for (const values of [packages, [...packages].reverse()]) {
        for (const resources of [[], [resource({ details: { schemaName: "cr_agent" } })]]) {
          const links = resolvePackageAgentLinks("tenant-a", values, resources);
          expect(links.find(link => link.packageId === native.id)?.status).toBe(resources.length ? "matched" : "unmatched");
          for (const packageId of [declared.id, legacy.id]) {
            expect(links.find(link => link.packageId === packageId)).toMatchObject({ status: "ambiguous" });
            expect(links.find(link => link.packageId === packageId)).not.toHaveProperty("grouping");
          }
          const records = buildRecords(values, resources, links, null, null);
          expect(records).toHaveLength(3);
          for (const packageId of [declared.id, legacy.id]) {
            const selected = findUnifiedAgentRecord(records, unifiedAgentRecordId({ source: "graph_packages", packageId }));
            expect(selected).toMatchObject({ presence: "graph_packages", powerPlatformResource: null, identity: { state: "ambiguous" } });
            expect(selected?.packages.map(value => value.id)).toEqual([packageId]);
          }
        }
      }
    },
  );

  it("retains agreeing declarative and native claims within custom-engine groups without granting alias control", () => {
    const native = customEnginePackage("native", {
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: cdsBotId },
    });
    const declared = declarativeCustomEnginePackage("declared", cdsBotId.toUpperCase());
    const legacy = customEnginePackage("legacy");
    const packages = [native, declared, legacy];
    for (const values of [packages, [...packages].reverse()]) {
      const resources = [declarativeResource()];
      const links = resolvePackageAgentLinks("tenant-a", values, resources);
      expect(links.map(link => link.status)).toEqual(values.map(() => "matched"));
      expect(links.every(link => !("controlBotId" in link))).toBe(true);
      expect(buildRecords(values, resources, links, null, null)).toHaveLength(1);
      const unmatched = resolvePackageAgentLinks("tenant-a", values, []);
      expect(new Set(unmatched.map(link => link.status === "unmatched" ? link.grouping?.key : undefined)).size).toBe(1);
    }
  });

  it("keeps distinct source-only declarative manifests separate despite a shared bot application", () => {
    const packages = [
      declarativeCustomEnginePackage("first", cdsBotId),
      declarativeCustomEnginePackage("second", otherId),
      customEnginePackage("legacy"),
    ];
    for (const values of [packages, [...packages].reverse()]) {
      const links = resolvePackageAgentLinks("tenant-a", values, []);
      expect(links.map(link => link.status)).toEqual(values.map(() => "ambiguous"));
      expect(links.every(link => !("grouping" in link))).toBe(true);
      expect(buildRecords(values, [], links, null, null)).toHaveLength(3);
    }
  });

  it("preserves a unique declarative source-only group when correlating custom-engine aliases", () => {
    const declared = declarativeCustomEnginePackage("declared", cdsBotId, { SourceIds: { EnvironmentId: environmentId } });
    const legacy = customEnginePackage("legacy");
    const external = declarativePackage("external");
    external.elementDetails!.push(packaged({ SourceIds: { EnvironmentId: environmentId } }).elementDetails![0]);
    const original = resolvePackageAgentLinks("tenant-a", [declared], [])[0];
    expect(original).toMatchObject({ status: "unmatched", grouping: { environmentId } });
    for (const values of [[declared, legacy, external], [external, legacy, declared]]) {
      const links = resolvePackageAgentLinks("tenant-a", values, []);
      expect(links).toMatchObject(values.map(value => ({
        packageId: value.id, status: "unmatched", grouping: original.status === "unmatched" ? original.grouping : undefined,
      })));
      const records = buildRecords(values, [], links, null, null);
      expect(records).toHaveLength(1);
      for (const value of values) {
        expect(findUnifiedAgentRecord(records, unifiedAgentRecordId({ source: "graph_packages", packageId: value.id }))).toBe(records[0]);
      }
    }
  });

  it("joins legacy and current custom-engine packages through a uniquely proven native agent", () => {
    const native = customEnginePackage("native-package", {
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
    });
    const legacy = customEnginePackage("legacy-package");
    const saved = resource({ details: { schemaName: "cr_agent" } });
    for (const values of [[native, legacy], [legacy, native]]) {
      const links = resolvePackageAgentLinks("tenant-a", values, [saved]);
      expect(links.map(link => link.status)).toEqual(["matched", "matched"]);
      expect(links.find(link => link.packageId === legacy.id)).toMatchObject({
        status: "matched", resource: { nativeId: cdsBotId, environmentId },
        evidence: [{ kind: "shared_custom_engine_bot_id", relatedPackageIds: [native.id] }],
      });
      expect(links.find(link => link.packageId === legacy.id)).not.toHaveProperty("controlBotId");
    }
  });

  it.each(["Bots", "CustomEngineCopilots"])("does not associate a saved alias with duplicate %s identity properties", kind => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const native = customEnginePackage("native", {
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
    });
    const alias = customEnginePackage("alias");
    alias.elementDetails!.find(group => group.elementType === kind)!.elements[0].definition = kind === "Bots"
      ? `{"botId":"${otherId}","botId":"${entraAgentId}"}`
      : `{"type":"other","type":"bot","id":"${entraAgentId}"}`;
    const packages = [native, alias].map(value => {
      const stored = packageInventoryRecord(value);
      return restoreInventoryRecord(stored.residual, stored.facts, "packages") as typeof value;
    });
    const saved = resource({ details: { schemaName: "cr_agent" } });
    for (const ordered of [packages, [...packages].reverse()]) {
      const links = resolvePackageAgentLinks("tenant-a", ordered, [saved]);
      expect(links.find(link => link.packageId === native.id)?.status).toBe("matched");
      expect(links.find(link => link.packageId === alias.id)).toMatchObject({ status: "unmatched" });
      const records = buildRecords(ordered, [saved], links, null, null);
      expect(records).toHaveLength(2);
      const selected = findUnifiedAgentRecord(records, unifiedAgentRecordId({ source: "graph_packages", packageId: alias.id }));
      expect(selected).toMatchObject({ presence: "graph_packages", powerPlatformResource: null });
      expect(selected?.packages.map(value => value.id)).toEqual([alias.id]);
    }
  });

  it("groups custom-engine package representations without inventing a PP or CDS identity", () => {
    const values = [customEnginePackage("first"), customEnginePackage("second")];
    const links = resolvePackageAgentLinks("tenant-a", values, []);
    expect(links).toMatchObject(values.map(value => ({ packageId: value.id, status: "unmatched", grouping: { environmentId: null } })));
    if (links[0].status !== "matched" && links[1].status !== "matched") expect(links[0].grouping?.key).toBe(links[1].grouping?.key);
    expect(resolvePackageAgentLinks("tenant-a", [values[0]], [resource({
      nativeId: entraAgentId, identifiers: [{ kind: "entra_agent_id", value: entraAgentId }],
    })])[0].status).toBe("unmatched");
  });

  it("retains successfully observed expired identity links without renewing live control proof", () => {
    const now = Date.now(), observedAt = new Date(now - 120_000).toISOString(), expiresAt = new Date(now - 60_000).toISOString();
    const value = { ...packaged({ SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } }),
      detailFreshness: { state: "stale" as const, observedAt, expiresAt } };
    const saved = resource({ identifiers: [], details: { schemaName: "cr_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [value], [saved]);
    expect(links[0]).toMatchObject({ status: "matched", controlBotId: cdsBotId });
    expect(withVerifiedControlIdentities([saved], links, {
      [value.id]: { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
        identityDetails: { observedAt, expiresAt } },
    }, now)[0]).toBe(saved);
    const current = { observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
    expect(withVerifiedControlIdentities([saved], links, {
      [value.id]: { ...current, identityDetails: current },
    }, now)[0].identifiers).toContainEqual({ kind: "cds_bot_id", value: cdsBotId });
  });

  it.each([
    { observedAt: null, expiresAt: "9999-12-31T23:59:59Z" },
    { observedAt: "2026-01-01T00:00:00Z", expiresAt: null },
    { observedAt: "invalid", expiresAt: "9999-12-31T23:59:59Z" },
    { observedAt: "2026-01-01T00:00:00Z", expiresAt: "invalid" },
    { observedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:00:00Z" },
    { observedAt: "9999-12-31T23:00:00Z", expiresAt: "9999-12-31T23:59:59Z" },
  ])("does not trust a fresh label with invalid timestamps for links or match facts (%#)", freshness => {
    const native = {
      ...customEnginePackage("native", {
        SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
      }),
      detailFreshness: { state: "fresh" as const, ...freshness },
    };
    const alias = customEnginePackage("alias");
    const links = resolvePackageAgentLinks("tenant-a", [native, alias], [resource({ details: { schemaName: "cr_agent" } })]);
    expect(links.map(link => link.status)).toEqual(["unmatched", "unmatched"]);
    expect(links.every(link => !("grouping" in link))).toBe(true);
    if (freshness.expiresAt === null || freshness.expiresAt === "invalid") {
      expect(() => packageInventoryRecord(native)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    } else {
      expect(packageInventoryRecord(native).facts.filter(fact => fact.kind.startsWith("match:"))).toEqual([]);
    }
  });

  it.each(["stale", "missing", "invalidated", "revalidation_required"] as const)(
    "does not reuse %s custom-engine details for links or source-only groups",
    state => {
      const native = customEnginePackage("native", {
        SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
      });
      const alias = customEnginePackage("alias");
      const rejected = {
        ...customEnginePackage("rejected"),
        detailFreshness: {
          state: state === "revalidation_required" ? "fresh" as const : state,
          observedAt: null, expiresAt: null,
        },
        ...(state === "revalidation_required" ? { identityRevalidationRequired: true as const } : {}),
      };
      const expectedRejection = resolvePackageAgentLinks("tenant-a", [rejected], [])[0];
      const packages = [native, alias, rejected];
      for (const resources of [[], [resource({ details: { schemaName: "cr_agent" } })]]) {
        for (const ordered of [packages, [...packages].reverse()]) {
          const links = resolvePackageAgentLinks("tenant-a", ordered, resources);
          expect(links.find(link => link.packageId === rejected.id)).toEqual(expectedRejection);
          const accepted = links.filter(link => link.packageId !== rejected.id);
          if (resources.length) expect(accepted.map(link => link.status)).toEqual(["matched", "matched"]);
          else {
            expect(accepted).toMatchObject(accepted.map(() => ({
              status: "unmatched", grouping: { environmentId },
            })));
            const groups = accepted.map(link => link.status === "unmatched" ? link.grouping?.key : undefined);
            expect(new Set(groups).size).toBe(1);
          }
        }
      }
    },
  );

  it("does not let a shared bot application collapse distinct native agents or environments", () => {
    const values = [
      customEnginePackage("first", { SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_one" } }),
      customEnginePackage("second", { SourceIds: { EnvironmentId: otherId, CdsBotId: otherId, SchemaName: "cr_two" } }),
      customEnginePackage("legacy"),
    ];
    const links = resolvePackageAgentLinks("tenant-a", values, [
      resource({ details: { schemaName: "cr_one" } }),
      resource({ environmentId: otherId, nativeId: otherId, identifiers: [], details: { schemaName: "cr_two" } }),
    ]);
    expect(links.map(link => link.status)).toEqual(["matched", "matched", "ambiguous"]);
    expect(links[2]).not.toHaveProperty("grouping");
  });

  it.each(["entra_agent_id", "entra_app_id"] as const)(
    "checks every resolved target before associating a custom-engine alias (%s)",
    kind => {
      const native = customEnginePackage("native", {
        SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
      });
      const secondary = customEnginePackage("secondary", kind === "entra_agent_id"
        ? { SourceIds: { EnvironmentId: environmentId }, AgentIdentityId: otherId }
        : { SourceIds: { EnvironmentId: environmentId, EntraApplicationId: otherId } });
      const legacy = customEnginePackage("legacy");
      for (const sameTarget of [false, true]) {
        const saved = resource({
          identifiers: [
            { kind: "cds_bot_id", value: cdsBotId },
            ...(sameTarget ? [{ kind, value: otherId }] : []),
          ],
          details: { schemaName: "cr_agent" },
        });
        const resources = sameTarget ? [saved] : [saved, resource({
          nativeId: otherId, identifiers: [{ kind, value: otherId }],
        })];
        const packages = [native, secondary, legacy];
        for (const values of [packages, [...packages].reverse()]) {
          const links = resolvePackageAgentLinks("tenant-a", values, resources);
          expect(links.find(link => link.packageId === native.id)).toMatchObject({
            status: "matched", resource: { nativeId: cdsBotId, environmentId },
          });
          expect(links.find(link => link.packageId === secondary.id)).toMatchObject({
            status: "matched", resource: { nativeId: sameTarget ? cdsBotId : otherId, environmentId },
          });
          const alias = links.find(link => link.packageId === legacy.id);
          expect(alias?.status).toBe(sameTarget ? "matched" : "ambiguous");
          expect(alias).not.toHaveProperty("grouping");
          expect(alias).not.toHaveProperty("controlBotId");
          if (sameTarget) expect(alias).toMatchObject({
            evidence: [{ kind: "shared_custom_engine_bot_id", relatedPackageIds: [native.id] }],
          });
        }
      }
    },
  );

  it("does not promote a secondary identity match into a custom-engine native anchor", () => {
    const secondary = customEnginePackage("secondary", {
      SourceIds: { EnvironmentId: environmentId, EntraApplicationId: otherId },
    });
    const legacy = customEnginePackage("legacy");
    const saved = resource({ identifiers: [{ kind: "entra_app_id", value: otherId }] });
    expect(resolvePackageAgentLinks("tenant-a", [secondary, legacy], [saved])).toMatchObject([
      { packageId: secondary.id, status: "matched" },
      { packageId: legacy.id, status: "unmatched" },
    ]);
  });

  it("keeps custom-engine aliases ambiguous when secondary matches alone identify different agents", () => {
    const first = customEnginePackage("first", {
      SourceIds: { EnvironmentId: environmentId, EntraApplicationId: cdsBotId },
    });
    const second = customEnginePackage("second", {
      SourceIds: { EnvironmentId: environmentId, EntraApplicationId: otherId },
    });
    const legacy = customEnginePackage("legacy");
    const packages = [first, second, legacy];
    for (const values of [packages, [...packages].reverse()]) {
      const links = resolvePackageAgentLinks("tenant-a", values, [
        resource({ nativeId: cdsBotId, identifiers: [{ kind: "entra_app_id", value: cdsBotId }] }),
        resource({ nativeId: otherId, identifiers: [{ kind: "entra_app_id", value: otherId }] }),
      ]);
      expect(links.find(link => link.packageId === first.id)?.status).toBe("matched");
      expect(links.find(link => link.packageId === second.id)?.status).toBe("matched");
      expect(links.find(link => link.packageId === legacy.id)?.status).toBe("ambiguous");
    }
  });

  it.each([
    { SourceIds: { EnvironmentId: otherId } },
    { SourceIds: { SchemaName: "cr_other" } },
  ])("does not discard partial native constraints when linking custom-engine representations (%j)", metadata => {
    const native = customEnginePackage("native", {
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" },
    });
    const partial = customEnginePackage("partial", metadata);
    for (const values of [[native, partial], [partial, native]]) {
      const links = resolvePackageAgentLinks("tenant-a", values, [resource({ details: { schemaName: "cr_agent" } })]);
      expect(links.find(link => link.packageId === native.id)?.status).toBe("matched");
      expect(links.find(link => link.packageId === partial.id)).toMatchObject({ status: "ambiguous" });
      expect(links.find(link => link.packageId === partial.id)).not.toHaveProperty("grouping");
    }
  });

  it("checks a partial schema against the saved custom-engine anchor even if the anchor package omits it", () => {
    const native = customEnginePackage("native", {
      SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId },
    });
    const saved = resource({
      identifiers: [{ kind: "cds_bot_id", value: cdsBotId }], details: { schemaName: "cr_agent" },
    });
    for (const SchemaName of ["CR_AGENT", "cr_other"]) {
      const partial = customEnginePackage("partial", { SourceIds: { SchemaName } });
      for (const values of [[native, partial], [partial, native]]) {
        const links = resolvePackageAgentLinks("tenant-a", values, [saved]);
        expect(links.find(link => link.packageId === native.id)?.status).toBe("matched");
        expect(links.find(link => link.packageId === partial.id)?.status)
          .toBe(SchemaName === "CR_AGENT" ? "matched" : "ambiguous");
      }
    }
  });

  it("requires agreement of the declared bot application in both package element types", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const native = customEnginePackage("native", { SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } });
    const different = customEnginePackage("different", {}, otherId);
    const inconsistent = customEnginePackage("inconsistent");
    inconsistent.elementDetails![1].elements[0].definition = JSON.stringify({ botId: otherId });
    const links = resolvePackageAgentLinks("tenant-a", [native, different, inconsistent], [resource({ details: { schemaName: "cr_agent" } })]);
    expect(links.map(link => link.status)).toEqual(["matched", "unmatched", "unmatched"]);
  });

  it("accepts the documented custom-engine manifest shape without an extra botId property", () => {
    const native = customEnginePackage("native", { SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } });
    const legacy = customEnginePackage("legacy");
    legacy.elementDetails![2].elements[0].definition = JSON.stringify({ type: "bot", id: entraAgentId });
    expect(resolvePackageAgentLinks("tenant-a", [native, legacy], [resource({ details: { schemaName: "cr_agent" } })]))
      .toMatchObject([{ status: "matched" }, { status: "matched", evidence: [{ kind: "shared_custom_engine_bot_id" }] }]);
  });

  it("does not use a fresh alias package to extend expired native control proof", () => {
    const native = customEnginePackage("native", { SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } });
    const legacy = customEnginePackage("legacy");
    const saved = resource({ details: { schemaName: "cr_agent" } });
    const links = resolvePackageAgentLinks("tenant-a", [native, legacy], [saved]);
    const now = Date.now();
    const expiry = new Date(now + 60_000).toISOString();
    expect(withVerifiedControlIdentities([saved], links, {
      native: { observedAt: new Date(now - 25 * 60 * 60_000).toISOString(), expiresAt: expiry },
      legacy: { observedAt: new Date(now).toISOString(), expiresAt: expiry },
    }, now)[0]).toBe(saved);
  });
});
