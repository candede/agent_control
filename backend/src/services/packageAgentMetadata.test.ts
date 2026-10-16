import { afterEach, describe, expect, it, vi } from "vitest";
import { allowlistedPackage } from "./packageObservation.js";
import { parsePackageIdentityDefinition, readPackageAgentMetadata, readPackageCustomEngineBotIdentity, validatePackageAgentMetadata } from "./packageAgentMetadata.js";
import { dataLimits } from "../db/dataBounds.js";

const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const botId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceIds = { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr_agent" };

function input(definition: string, elementType = "AgentMetadatas") {
  return {
    ...allowlistedPackage({ id: "opaque-package", displayName: "Agent", isBlocked: false }),
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

  it("retains partial environment and schema constraints without treating them as a native agent identity", () => {
    const value = allowlistedPackage(input(JSON.stringify({
      SourceIds: { EnvironmentId: environmentId.toUpperCase(), SchemaName: "CR_AGENT" },
    })));
    expect(readPackageAgentMetadata(value)).toEqual({
      status: "unmatched",
      identity: { environmentId, schemaName: "cr_agent", graphAgentIds: [] },
      reason: "Package metadata does not supply a source-native agent identity.",
    });
  });

  it.each([
    `{"SourceIds":{"EnvironmentId":"${environmentId}","EnvironmentId":"${botId}","CdsBotId":"${botId}"}}`,
    `{"SourceIds":{"EnvironmentId":"${environmentId}","CdsBotId":"${environmentId}","CdsBot\\u0049d":"${botId}"}}`,
    `{"SourceIds":{"EnvironmentId":"${environmentId}","CdsBotId":"${botId}","SchemaName":"cr_other","SchemaName":"cr_agent"}}`,
    `{"SourceIds":{"ManifestId":"${environmentId}","ManifestId":"${botId}"}}`,
    `{"SourceIds":{"EntraApplicationId":"${environmentId}","EntraApplicationId":"${botId}"}}`,
    `{"SourceIds":{"EnvironmentId":"${botId}"},"\\u0053ourceIds":${JSON.stringify(sourceIds)}}`,
    `{"SourceIds":${JSON.stringify(sourceIds)},"AgentIdentityId":"${environmentId}","AgentIdentityId":"${botId}"}`,
  ])("rejects duplicate identity properties before storage and when reading saved evidence (%s)", definition => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => allowlistedPackage(input(definition))).toThrow(expect.objectContaining({ code: "provider_schema" }));
    const saved = allowlistedPackage(input("{}"));
    saved.elementDetails![0].elements[0].definition = definition;
    expect(readPackageAgentMetadata(saved)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(definition);
    expect(JSON.stringify(warning.mock.calls)).not.toContain(botId);
  });

  it("does not mistake unrestricted authoring content, arrays or quoted text for identity properties", () => {
    const definition = `{
      "AuthoringDefinition": [{"SourceIds":{"CdsBotId":"ignored","CdsBotId":"also-ignored"}}],
      "description": "quoted \\"SourceIds\\": { braces [ and escaped \\\\ characters",
      "description": "retained authoring text",
      "SourceIds": ${JSON.stringify(sourceIds)}
    }`;
    const saved = allowlistedPackage(input(definition));
    expect(saved.elementDetails![0].elements[0].definition).toBe(definition);
    expect(readPackageAgentMetadata(saved)).toMatchObject({
      status: "available", identity: { environmentId, cdsBotId: botId, schemaName: "cr_agent" },
    });
  });

  it.each([
    { kind: "Bots", definition: `{"botId":"${environmentId}","botId":"${botId}"}` },
    { kind: "CustomEngineCopilots", definition: `{"type":"bot","id":"${environmentId}","id":"${botId}"}` },
    { kind: "CustomEngineCopilots", definition: `{"type":"unknown","type":"bot","id":"${botId}"}` },
    { kind: "CustomEngineCopilots", definition: `{"type":"bot","id":"${botId}","botId":"${environmentId}","botId":"${botId}"}` },
  ])("does not corroborate ambiguous $kind bot application properties", ({ kind, definition }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const saved = allowlistedPackage({
      ...input("{}"), elementDetails: [
        { elementType: "Bots", elements: [{ id: "bot", definition: JSON.stringify({ botId }) }] },
        { elementType: "CustomEngineCopilots", elements: [{ id: "engine", definition: JSON.stringify({ type: "bot", id: botId }) }] },
      ],
    });
    saved.elementDetails!.find(group => group.elementType === kind)!.elements[0].definition = definition;
    expect(readPackageCustomEngineBotIdentity(saved)).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(botId);
  });

  it("does not coerce an untrusted definition into JSON", () => {
    const toString = vi.fn(() => "{}");
    const value = input("{}");
    Object.defineProperty(value.elementDetails[0].elements[0], "definition", { value: { toString } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readPackageAgentMetadata(value)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(toString).not.toHaveBeenCalled();
    const accessor = input("{}"), getter = vi.fn(() => accessor.elementDetails);
    Object.defineProperty(accessor, "elementDetails", { get: getter });
    expect(readPackageAgentMetadata(accessor)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(getter).not.toHaveBeenCalled();
    const arrayAccessor = input("{}"), entry = arrayAccessor.elementDetails[0];
    const entryGetter = vi.fn(() => entry);
    Object.defineProperty(arrayAccessor.elementDetails, 0, { get: entryGetter });
    expect(readPackageAgentMetadata(arrayAccessor)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(entryGetter).not.toHaveBeenCalled();
  });

  it("does not acquire identity fields from object prototypes", () => {
    const plain = input("{}"), emptySource = input('{"SourceIds":{}}');
    const fields = { SourceIds: sourceIds, ...sourceIds, AgentIdentityId: botId };
    const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    let results: ReturnType<typeof readPackageAgentMetadata>[] = [];
    try {
      for (const [key, value] of Object.entries(fields)) {
        Object.defineProperty(Object.prototype, key, { value, configurable: true });
      }
      results = [readPackageAgentMetadata(plain), readPackageAgentMetadata(emptySource)];
    } finally {
      for (const key of Object.keys(fields)) {
        if (Object.hasOwn(descriptors, key)) Object.defineProperty(Object.prototype, key, descriptors[key]);
        else Reflect.deleteProperty(Object.prototype, key);
      }
    }
    expect(results).toMatchObject([{ status: "unmatched" }, { status: "unmatched" }]);
    expect(results.every(result => !result.identity?.cdsBotId && !result.identity?.graphAgentIds.length)).toBe(true);
  });

  it.each([
    { elementType: "AgentMetadatas", elements: null },
    Object.create({ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({ SourceIds: sourceIds }) }] }),
    { elementType: "AgentMetadatas", elements: [Object.create({ id: "metadata", definition: JSON.stringify({ SourceIds: sourceIds }) })] },
    { elementType: "AgentMetadatas", elements: Array(1) },
    { elementType: "AgentMetadatas", elements: [{ id: "invalid\0label", definition: "{}" }] },
  ])("fails closed on invalid or inherited saved element structure (%#)", group => {
    const value = input("{}");
    Object.defineProperty(value, "elementDetails", { value: [group] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readPackageAgentMetadata(value)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    expect(readPackageCustomEngineBotIdentity(value)).toBeUndefined();
  });

  it("bounds saved identity groups before extracting native or custom-engine evidence", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const metadata = input(JSON.stringify({ SourceIds: sourceIds }));
    metadata.elementDetails = Array.from({ length: 51 }, () => metadata.elementDetails[0]);
    expect(readPackageAgentMetadata(metadata)).toMatchObject({ status: "unmatched", invalidMetadata: true });
    const value = input("{}");
    value.elementDetails = [
      { elementType: "Bots", elements: Array.from({ length: 101 }, () => ({ id: "bot", definition: JSON.stringify({ botId }) })) },
      { elementType: "CustomEngineCopilots", elements: [{ id: "engine", definition: JSON.stringify({ type: "bot", id: botId }) }] },
    ];
    expect(readPackageCustomEngineBotIdentity(value)).toBeUndefined();
    value.elementDetails[0].elements.pop();
    expect(readPackageCustomEngineBotIdentity(value)).toEqual({ botApplicationId: botId, elementIds: ["bot", "engine"] });
    const wide = input("{}");
    wide.elementDetails = [
      { elementType: "DeclarativeCopilots", elements: Array.from({ length: 5 }, () => ({ id: "wide", definition: "x".repeat(3_500_000) })) },
      metadata.elementDetails[0],
    ];
    expect(() => allowlistedPackage(wide)).toThrow(expect.objectContaining({ code: "provider_result_limit" }));
    expect(readPackageAgentMetadata(wide)).toMatchObject({ status: "unmatched", invalidMetadata: true });
  });

  it("retains compatible fragments at the metadata limit but never grants identity to the seventeenth fragment", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = input(JSON.stringify({ SourceIds: sourceIds }));
    value.elementDetails[0].elements = Array.from({ length: 16 }, (_, index) => ({
      id: index % 2 ? "Opaque/É😀" : "opaque/E\u0301😀", definition: JSON.stringify({ SourceIds: sourceIds }),
    }));
    const saved = allowlistedPackage(value);
    expect(readPackageAgentMetadata(saved)).toMatchObject({
      status: "available", elementIds: ["Opaque/É😀", "opaque/E\u0301😀"],
    });
    value.elementDetails.push({ elementType: "agentmetadatas", elements: [{ id: "seventeenth", definition: "{}" }] });
    expect(readPackageAgentMetadata(value)).toMatchObject({ status: "unmatched", invalidMetadata: true });
  });

  it("includes only corroborating bot element labels in custom-engine evidence", () => {
    const value = input("{}");
    value.elementDetails = [
      { elementType: "Bots", elements: [
        { id: "supporting-bot", definition: JSON.stringify({ botId }) },
        { id: "unrelated-bot", definition: JSON.stringify({ botId: environmentId }) },
      ] },
      { elementType: "CustomEngineCopilots", elements: [{ id: "engine", definition: JSON.stringify({ type: "bot", id: botId }) }] },
    ];
    expect(readPackageCustomEngineBotIdentity(value)).toEqual({ botApplicationId: botId, elementIds: ["engine", "supporting-bot"] });
  });

  it("does not corroborate inherited custom-engine type or identity fields", () => {
    const value = input("{}");
    value.elementDetails = [
      { elementType: "Bots", elements: [{ id: "bot", definition: JSON.stringify({ botId }) }] },
      { elementType: "CustomEngineCopilots", elements: [{ id: "engine", definition: "{}" }] },
    ];
    const fields = { type: "bot", id: botId };
    const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    let result: ReturnType<typeof readPackageCustomEngineBotIdentity>;
    try {
      for (const [key, value] of Object.entries(fields)) Object.defineProperty(Object.prototype, key, { value, configurable: true });
      result = readPackageCustomEngineBotIdentity(value);
    } finally {
      for (const key of Object.keys(fields)) {
        if (Object.hasOwn(descriptors, key)) Object.defineProperty(Object.prototype, key, descriptors[key]);
        else Reflect.deleteProperty(Object.prototype, key);
      }
    }
    expect(result).toBeUndefined();
  });

  it("bounds definition bytes and deeply nested projected identity values without leaking native exceptions", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const definition = JSON.stringify({ AuthoringDefinition: "😀".repeat(dataLimits.agentDefinitionBytes / 4 + 1), SourceIds: sourceIds });
    expect(() => parsePackageIdentityDefinition(definition, "AgentMetadatas")).toThrow(SyntaxError);
    expect(readPackageAgentMetadata(input(definition))).toMatchObject({ status: "unmatched", invalidMetadata: true });
    const deep = `{"SourceIds":{"EnvironmentId":${"[".repeat(10_000)}null${"]".repeat(10_000)}}}`;
    expect(() => allowlistedPackage(input(deep))).toThrow(expect.objectContaining({ code: "provider_schema" }));
  });

  it("applies the identity projection limit in UTF-8 bytes without charging unrelated authoring content", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ SourceIds: { EnvironmentId: "" } }), "utf8");
    const remaining = 16_384 - overhead;
    const environment = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
    const definition = JSON.stringify({ SourceIds: { EnvironmentId: environment }, authoring: "x".repeat(50_000) });
    expect(validatePackageAgentMetadata(definition)).toBe(definition);
    expect(() => validatePackageAgentMetadata(JSON.stringify({ SourceIds: { EnvironmentId: environment + "x" } })))
      .toThrow(expect.objectContaining({ code: "provider_schema" }));
  });
});
