import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "./packageObservation.js";
import { resolvePackageAgentLinks, withVerifiedControlIdentities } from "./packageAgentIdentity.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";

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
      { type: "microsoft.powerautomate/agentflows" as const },
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
    ]) expect(withVerifiedControlIdentities([saved], links, { [value.id]: stale }, now)[0]).toBe(saved);
    expect(withVerifiedControlIdentities([saved], links, {}, now)[0]).toBe(saved);
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
    expect(resolvePackageAgentLinks("tenant-a", [packaged()], [resource({ type: "microsoft.powerautomate/agentflows" })])[0].status).toBe("unmatched");
  });

  it("surfaces invalid metadata without logging provider definition contents", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = packaged();
    value.elementDetails![0].elements[0].definition = "customer-secret-invalid-json";
    expect(resolvePackageAgentLinks("tenant-a", [value], [resource()])[0]).toMatchObject({ status: "unmatched", reason: expect.stringContaining("invalid") });
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("customer-secret");
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
      { tenantId: "tenant-b" }, { type: "microsoft.powerautomate/agentflows" as const }, { environmentId: null },
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

  it("groups custom-engine package representations without inventing a PP or CDS identity", () => {
    const values = [customEnginePackage("first"), customEnginePackage("second")];
    const links = resolvePackageAgentLinks("tenant-a", values, []);
    expect(links).toMatchObject(values.map(value => ({ packageId: value.id, status: "unmatched", grouping: { environmentId: null } })));
    if (links[0].status !== "matched" && links[1].status !== "matched") expect(links[0].grouping?.key).toBe(links[1].grouping?.key);
    expect(resolvePackageAgentLinks("tenant-a", [values[0]], [resource({
      nativeId: entraAgentId, identifiers: [{ kind: "entra_agent_id", value: entraAgentId }],
    })])[0].status).toBe("unmatched");
  });

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
