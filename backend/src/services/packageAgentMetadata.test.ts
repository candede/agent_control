import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "./packageObservation.js";
import { readPackageAgentMetadata } from "./packageAgentMetadata.js";

const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const botId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceIds = { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr_agent" };

function input(definition: string, elementType = "AgentMetadatas") {
  return {
    id: "opaque-package", displayName: "Agent", isBlocked: false,
    elementDetails: [{ elementType, elements: [{ id: "metadata", definition }] }],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("bounded package identity projection", () => {
  it("extracts complete typed identity fields and preserves connected services after the old 32 KB boundary", () => {
    const definition = JSON.stringify({
      AuthoringDefinition: "private-authoring-content ".repeat(4_000),
      ConnectedService: { endpoint: "https://fixture.example.invalid/service" },
      SourceIds: sourceIds, AgentIdentityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });
    expect(definition.length).toBeGreaterThan(32_768);
    const saved = allowlistedPackage(input(definition));
    const retained = saved.elementDetails![0].elements[0].definition;
    expect(retained).toBe(definition);
    expect(JSON.parse(retained)).toMatchObject({
      SourceIds: sourceIds, AgentIdentityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ConnectedService: { endpoint: "https://fixture.example.invalid/service" },
    });
    expect(readPackageAgentMetadata(saved)).toMatchObject({
      status: "available", identity: { environmentId, cdsBotId: botId, schemaName: "cr_agent" },
    });
  });

  it("never truncates other package definitions into syntactically invalid JSON", () => {
    const definition = JSON.stringify({ description: "x".repeat(40_000) });
    const saved = allowlistedPackage(input(definition, "DeclarativeCopilots"));
    expect(saved.elementDetails![0].elements[0].definition).toBe(definition);
    expect(JSON.parse(saved.elementDetails![0].elements[0].definition)).toEqual(JSON.parse(definition));
  });

  it("accepts provider-supplied empty element labels without inventing native identities", () => {
    const value = input(JSON.stringify({ SourceIds: sourceIds }));
    value.elementDetails[0].elements[0].id = "";
    const saved = allowlistedPackage(value);
    expect(readPackageAgentMetadata(saved)).toMatchObject({
      status: "available", elementIds: [], identity: { cdsBotId: botId },
    });
  });

  it("rejects invalid or oversized observations rather than marking truncated data as collected", () => {
    expect(() => allowlistedPackage(input("{invalid"))).toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => allowlistedPackage(input(JSON.stringify({ SourceIds: { EnvironmentId: "x".repeat(20_000) } }))))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => allowlistedPackage(input("x".repeat(2_048_001), "DeclarativeCopilots")))
      .toThrow(expect.objectContaining({ code: "provider_result_limit" }));
    expect(() => allowlistedPackage({ ...input("{}"), manifestId: 123 }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => allowlistedPackage({ ...input("{}"), manifestId: "x".repeat(513) }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
    expect(() => allowlistedPackage({ ...input("{}"), elementDetails: [{ elementType: "AgentMetadatas", elements: [{}] }] }))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it("retains complete valid definitions within the provider response budget, including above the old 1 MiB row budget", () => {
    const definition = JSON.stringify({ description: "x".repeat(1_100_000) });
    expect(allowlistedPackage(input(definition, "DeclarativeCopilots")).elementDetails![0].elements[0].definition).toBe(definition);
  });

  it("distinguishes a legitimate empty metadata object from a corrupted saved definition", () => {
    const empty = readPackageAgentMetadata(allowlistedPackage(input("{}")));
    expect(empty).toMatchObject({ status: "unmatched" });
    expect(empty).not.toHaveProperty("invalidMetadata");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const corrupt = allowlistedPackage(input("{}"));
    corrupt.elementDetails![0].elements[0].definition = '{"SourceIds":';
    expect(readPackageAgentMetadata(corrupt)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain('{"SourceIds":');
  });
});
