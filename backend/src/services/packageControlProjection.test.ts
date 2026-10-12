import { describe, expect, it } from "vitest";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { allowlistedPackage } from "./packageObservation.js";
import { projectPackageControl, type SavedPackageControl } from "./packageControlProjection.js";
import { resolvePackageAgentLinks, withVerifiedControlIdentities } from "./packageAgentIdentity.js";
import { capturePackageMutationState } from "./packageMutationState.js";
import { packageInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";

const original: CopilotPackageDetail = {
  ...allowlistedPackage({
    id: "package", displayName: "Rain watch", isBlocked: false,
    manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appId: "app", assetId: "asset", version: "1",
    elementTypes: ["DeclarativeCopilots"], lastModifiedDateTime: "2026-09-22T00:00:00Z",
    elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition: "{}" }] }],
    availableTo: "allowedForAll", deployedTo: "none",
  }),
  identityDetailsCollected: true,
};
const observation = {
  snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  observedAt: "2026-09-24T08:00:00Z", expiresAt: "2026-10-24T08:00:00Z",
};
function block(isBlocked: boolean, extra: Partial<CopilotPackageDetail> = {}): SavedPackageControl {
  return { detail: allowlistedPackage({ id: original.id, displayName: "Rain watch", isBlocked, ...extra }),
    state: { kind: "block", isBlocked }, observation };
}

describe("typed package control projection", () => {
  it("rejects an unrecognized saved discriminator even when its access fields match provider details", () => {
    const detail = allowlistedPackage({
      id: original.id, displayName: original.displayName, isBlocked: false,
      availableTo: "some", deployedTo: "none",
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "Opaque_User" }], acquireUsersAndGroups: [],
    });
    const state = JSON.parse(JSON.stringify({ ...capturePackageMutationState(detail, "update-availability"), kind: "unexpected" }));
    expect(() => projectPackageControl(original, { detail, state, observation }))
      .toThrow(expect.objectContaining({ code: "invalid_mutation_state" }));
    expect(original).not.toHaveProperty("controlObservations");
  });

  it("preserves identity, access, provenance and metadata through sparse block/unblock readbacks", () => {
    const blocked = projectPackageControl(original, block(true, { lastModifiedDateTime: "2026-09-24T08:00:00Z" }));
    expect(blocked).toEqual({ ...original, isBlocked: true, controlObservations: { block: observation } });
    const unblocked = projectPackageControl(blocked, block(false));
    expect(unblocked).toEqual({ ...original, controlObservations: { block: observation } });
    expect(original).not.toHaveProperty("controlObservations");
  });

  it.each(["manifestId", "appId", "assetId", "version", "manifestVersion"] as const)(
    "requires identity revalidation when supplied %s changes", key => {
      const value = projectPackageControl({ ...original, [key]: "before" }, block(true, { [key]: "after" }));
      expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
      expect(value).not.toHaveProperty("identityDetailsCollected");
      expect(resolvePackageAgentLinks("tenant", [value], [])[0]).toMatchObject({
        status: "unmatched", reason: expect.stringContaining("changed identity evidence"),
      });
    },
  );

  it.each(["manifestId", "appId", "assetId", "version", "manifestVersion"] as const)(
    "requires identity revalidation when %s is newly supplied", key => {
      for (const before of [undefined, ""]) {
        const current = { ...original, [key]: before };
        const value = projectPackageControl(current, block(true, { [key]: "new-evidence" }));
        expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
        expect(value).not.toHaveProperty("identityDetailsCollected");
        expect(value[key]).toBe(before);
      }
    },
  );

  it("requires revalidation for newly supplied element types", () => {
    for (const elementTypes of [undefined, []]) {
      expect(projectPackageControl({ ...original, elementTypes }, block(true, {
        elementTypes: ["DeclarativeCopilots"],
      }))).toMatchObject({ identityRevalidationRequired: true });
    }
  });

  it("requires revalidation when positive declarative details add identity constraints", () => {
    const single = [{ id: "declarative", definition: "{}" }];
    for (const extra of [
      { current: original, elements: [...single, { id: "second-agent", definition: "{}" }] },
      { current: { ...original, elementTypes: undefined, elementDetails: [] }, elements: single },
    ]) {
      const value = projectPackageControl(extra.current, block(true, {
        elementDetails: [{ elementType: "declarativecopilots", elements: extra.elements }],
      }));
      expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
      expect(value).not.toHaveProperty("identityDetailsCollected");
      expect(value.elementDetails).toEqual(extra.current.elementDetails);
    }
    expect(projectPackageControl(original, block(true, {
      elementDetails: [{ elementType: "declarativecopilots", elements: single }],
    }))).not.toHaveProperty("identityRevalidationRequired");
  });

  it("does not treat empty optional control metadata as an authoritative inventory deletion", () => {
    expect(projectPackageControl(original, block(true))).not.toHaveProperty("identityRevalidationRequired");
    expect(projectPackageControl(original, block(true, { elementDetails: [], elementTypes: [] }))).toEqual({
      ...original, isBlocked: true, controlObservations: { block: observation },
    });
  });

  it("does not treat empty native metadata groups as malformed positive identity evidence", () => {
    const current = { ...original, elementDetails: [
      ...original.elementDetails!,
      { elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
        SourceIds: { EnvironmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      }) }] },
    ] };
    for (const elementDetails of [
      [{ elementType: "AgentMetadatas", elements: [] }],
      [{ elementType: "AgentMetadatas", elements: [] }, ...original.elementDetails!],
      [{ elementType: "agentmetadatas", elements: [] }, ...current.elementDetails!],
    ]) {
      expect(projectPackageControl(current, block(true, { elementDetails }))).toEqual({
        ...current, isBlocked: true, controlObservations: { block: observation },
      });
    }
  });

  it("does not confuse identifier casing or element type casing with identity changes", () => {
    expect(projectPackageControl(original, block(true, {
      manifestId: original.manifestId!.toUpperCase(), elementTypes: ["declarativecopilots"],
    }))).not.toHaveProperty("identityRevalidationRequired");
  });

  it.each(["version", "manifestVersion"] as const)("compares opaque %s markers exactly even when they resemble GUIDs", key => {
    const marker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const value = projectPackageControl({ ...original, [key]: marker }, block(true, { [key]: marker.toUpperCase() }));
    expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
    expect(value).not.toHaveProperty("identityDetailsCollected");
    expect(value[key]).toBe(marker);
  });

  it.each(["appId", "assetId"] as const)("withdraws saved identity and control qualification for a case-only change to opaque %s", key => {
    const marker = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const environmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const botId = original.manifestId!;
    const current = { ...original, [key]: marker, elementDetails: [{
      elementType: "AgentMetadatas", elements: [{
        id: "metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr_rain" },
        }),
      }],
    }] };
    const resource: PowerPlatformResource = {
      tenantId: "tenant", nativeId: botId, environmentId, type: "microsoft.copilotstudio/agents",
      displayName: "Rain watch", location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
      sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
      agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
      identifiers: [{ kind: "environment_id", value: environmentId }], provenance: {}, details: { schemaName: "cr_rain" }, unknownFieldCount: 0,
    };
    const observations = { [current.id]: observation }, now = Date.parse(observation.observedAt);
    const links = resolvePackageAgentLinks("tenant", [current], [resource]);
    expect(links[0]).toMatchObject({ status: "matched", controlBotId: botId });
    expect(withVerifiedControlIdentities([resource], links, observations, now)[0].identifiers)
      .toContainEqual({ kind: "cds_bot_id", value: botId });
    expect(projectPackageControl(current, block(true, { [key]: marker }))).not.toHaveProperty("identityRevalidationRequired");
    const projected = projectPackageControl(current, block(true, { [key]: marker.toUpperCase() }));
    expect(projected).toMatchObject({ isBlocked: true, [key]: marker, identityRevalidationRequired: true });
    expect(projected).not.toHaveProperty("identityDetailsCollected");
    const record = packageInventoryRecord(projected);
    const restored = restoreInventoryRecord(record.residual, record.facts, "packages") as CopilotPackageDetail;
    expect(record.facts.some(fact => fact.kind.startsWith("match:"))).toBe(false);
    const after = resolvePackageAgentLinks("tenant", [restored], [resource]);
    expect(after[0]).toMatchObject({ status: "unmatched" });
    expect(withVerifiedControlIdentities([resource], after, observations, now)).toEqual([resource]);
    expect(projectPackageControl(restored, block(false))).toMatchObject({ isBlocked: false, identityRevalidationRequired: true });
  });

  it.each([
    { SourceIds: { EnvironmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { SourceIds: { CdsBotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { SourceIds: { SchemaName: "cr_agent" } },
    { SourceIds: { ManifestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { SourceIds: { EntraApplicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { AgentIdentityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  ])("requires revalidation for newly supplied native metadata (%j)", metadata => {
    for (const current of [
      original,
      { ...original, elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: "{}" }] }] },
    ]) {
      const value = projectPackageControl(current, block(true, {
        elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify(metadata) }] }],
      }));
      expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
      expect(value).not.toHaveProperty("identityDetailsCollected");
      expect(value.elementDetails).toEqual(current.elementDetails);
      expect(resolvePackageAgentLinks("tenant", [value], [])[0].status).toBe("unmatched");
    }
  });

  it("preserves omitted and case-equivalent native metadata during sparse readbacks", () => {
    const environmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const cdsBotId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const metadata = { SourceIds: { EnvironmentId: environmentId, CdsBotId: cdsBotId, SchemaName: "cr_agent" } };
    const current = { ...original, elementDetails: [{
      elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify(metadata) }],
    }] };
    for (const incoming of [{}, { SourceIds: { EnvironmentId: environmentId.toUpperCase() } }, {
      SourceIds: { EnvironmentId: environmentId.toUpperCase(), CdsBotId: cdsBotId.toUpperCase(), SchemaName: "CR_AGENT" },
    }]) {
      expect(projectPackageControl(current, block(true, {
        elementDetails: [{ elementType: "agentmetadatas", elements: [{ id: "metadata", definition: JSON.stringify(incoming) }] }],
      }))).toEqual({ ...current, isBlocked: true, controlObservations: { block: observation } });
    }
  });

  it("does not treat omitted source-agent aliases as new identity evidence", () => {
    const ids = ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];
    const metadata = (id: string) => ({ id, definition: JSON.stringify({ AgentIdentityId: id }) });
    const current = { ...original, elementDetails: [{ elementType: "AgentMetadatas", elements: ids.map(metadata) }] };
    for (const id of ids) {
      expect(projectPackageControl(current, block(true, {
        elementDetails: [{ elementType: "AgentMetadatas", elements: [metadata(id.toUpperCase())] }],
      }))).toEqual({ ...current, isBlocked: true, controlObservations: { block: observation } });
    }
    expect(projectPackageControl(current, block(true, {
      elementDetails: [{ elementType: "AgentMetadatas", elements: [metadata("dddddddd-dddd-4ddd-8ddd-dddddddddddd")] }],
    }))).toMatchObject({ identityRevalidationRequired: true });
  });

  it.each(["Bots", "CustomEngineCopilots"])("requires revalidation for new or malformed %s evidence without a prior complete bot identity", elementType => {
    const botId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const definition = (id: string) => JSON.stringify(elementType === "Bots" ? { botId: id } : { type: "bot", id });
    const group = (value: string) => ({ elementType, elements: [{ id: "element", definition: value }] });
    for (const current of [
      original,
      { ...original, elementDetails: [group(definition(botId))] },
    ]) {
      for (const incoming of [definition("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), "{invalid"]) {
        const value = projectPackageControl(current, block(true, { elementDetails: [group(incoming)] }));
        expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
        expect(value).not.toHaveProperty("identityDetailsCollected");
        expect(value.elementDetails).toEqual(current.elementDetails);
        expect(resolvePackageAgentLinks("tenant", [value], [])[0]).not.toHaveProperty("grouping");
      }
    }
    const current = { ...original, elementDetails: [group(definition(botId))] };
    expect(projectPackageControl(current, block(true, { elementDetails: [group(definition(botId.toUpperCase()))] })))
      .not.toHaveProperty("identityRevalidationRequired");
    if (elementType === "CustomEngineCopilots") {
      expect(projectPackageControl(original, block(true, { elementDetails: [group(JSON.stringify({ type: "apiPlugin", id: botId }))] })))
        .not.toHaveProperty("identityRevalidationRequired");
    }
  });

  it("withdraws matching facts and native control proof when a readback adds bot identity constraints", () => {
    const environmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", botId = original.manifestId!;
    const current = { ...original, elementDetails: [{ elementType: "AgentMetadatas", elements: [{
      id: "metadata", definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr_rain" } }),
    }] }] };
    const resource: PowerPlatformResource = {
      tenantId: "tenant", nativeId: botId, environmentId, type: "microsoft.copilotstudio/agents",
      displayName: "Rain watch", location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
      sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
      agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
      identifiers: [{ kind: "environment_id", value: environmentId }], provenance: {}, details: { schemaName: "cr_rain" }, unknownFieldCount: 0,
    };
    const observations = { [current.id]: observation }, now = Date.parse(observation.observedAt);
    const before = resolvePackageAgentLinks("tenant", [current], [resource]);
    expect(before[0]).toMatchObject({ status: "matched", controlBotId: botId });
    expect(withVerifiedControlIdentities([resource], before, observations, now)[0].identifiers)
      .toContainEqual({ kind: "cds_bot_id", value: botId });
    const projected = projectPackageControl(current, block(true, {
      elementDetails: [{ elementType: "Bots", elements: [{ id: "bot", definition: JSON.stringify({ botId }) }] }],
    }));
    const record = packageInventoryRecord(projected);
    const saved = restoreInventoryRecord(record.residual, record.facts, "packages") as CopilotPackageDetail;
    const after = resolvePackageAgentLinks("tenant", [saved], [resource]);
    expect(record.facts.some(fact => fact.kind.startsWith("match:"))).toBe(false);
    expect(after[0]).toMatchObject({ status: "unmatched" });
    expect(after[0]).not.toHaveProperty("controlBotId");
    expect(withVerifiedControlIdentities([resource], after, observations, now)).toEqual([resource]);
    expect(saved).toMatchObject({ isBlocked: true, controlObservations: { block: observation } });
  });

  it("revalidates a previously corroborated bot when positive groups no longer corroborate it", () => {
    const first = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", second = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const bot = (id: string) => ({ id, definition: JSON.stringify({ botId: id }) });
    const current = { ...original, elementDetails: [
      { elementType: "Bots", elements: [bot(first), bot(second)] },
      { elementType: "CustomEngineCopilots", elements: [{ id: second, definition: JSON.stringify({ type: "bot", id: second }) }] },
    ] };
    for (const group of [
      { elementType: "Bots", elements: [bot(first)] },
      { elementType: "CustomEngineCopilots", elements: [{ id: second, definition: JSON.stringify({ type: "apiPlugin", id: second }) }] },
    ]) {
      expect(projectPackageControl(current, block(true, { elementDetails: [group] })))
        .toMatchObject({ identityRevalidationRequired: true });
    }
  });

  it.each(["Bots", "CustomEngineCopilots"])("checks changed %s even if the other bot element type is omitted", elementType => {
    const botId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const definition = (id: string) => JSON.stringify(elementType === "Bots" ? { botId: id } : { type: "bot", id });
    const current = { ...original, elementDetails: [
      { elementType: "Bots", elements: [{ id: "bot", definition: JSON.stringify({ botId }) }] },
      { elementType: "CustomEngineCopilots", elements: [{ id: "engine", definition: JSON.stringify({ type: "bot", id: botId }) }] },
    ] };
    for (const incoming of [definition("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), "{invalid"]) {
      const value = projectPackageControl(current, block(true, {
        elementDetails: [{ elementType: elementType.toLowerCase(), elements: [{ id: "changed", definition: incoming }] }],
      }));
      expect(value).toMatchObject({ isBlocked: true, identityRevalidationRequired: true });
      expect(value).not.toHaveProperty("identityDetailsCollected");
      expect(value.elementDetails).toEqual(current.elementDetails);
    }
    for (const elements of [[], [{ id: "unchanged", definition: definition(botId.toUpperCase()) }]]) {
      expect(projectPackageControl(current, block(true, {
        elementDetails: [{ elementType: elementType.toLowerCase(), elements }],
      }))).toEqual({ ...current, isBlocked: true, controlObservations: { block: observation } });
    }
  });

  it("does not let an unrelated control update erase a previous identity conflict", () => {
    const conflicted = projectPackageControl(original, block(true, { manifestId: "changed" }));
    expect(projectPackageControl(conflicted, block(false))).toMatchObject({ isBlocked: false, identityRevalidationRequired: true });
  });

  it("updates only the verified access contract and preserves an independently verified block", () => {
    const blocked = projectPackageControl(original, block(true));
    const detail = allowlistedPackage({
      id: original.id, displayName: original.displayName, isBlocked: false,
      availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    });
    const value = projectPackageControl(blocked, { detail, state: capturePackageMutationState(detail, "update-availability"), observation });
    expect(value).toMatchObject({
      isBlocked: true, manifestId: original.manifestId, availableTo: "none", deployedTo: "none",
      allowedUsersAndGroups: [], acquireUsersAndGroups: [], controlObservations: { block: observation, access: observation },
    });
  });

  it("rejects target and state mismatches rather than publishing success-shaped data", () => {
    expect(() => projectPackageControl(original, { ...block(true), detail: { ...block(true).detail, id: "another" } }))
      .toThrow("does not match");
    expect(() => projectPackageControl(original, { ...block(true), state: { kind: "block", isBlocked: false } }))
      .toThrow("does not match");
  });
});
