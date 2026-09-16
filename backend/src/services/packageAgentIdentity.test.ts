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
      status: "unmatched", reason: "Package details were collected, but Microsoft Graph did not supply agent identity metadata. No cross-source link can be proven from the saved details.",
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
});
