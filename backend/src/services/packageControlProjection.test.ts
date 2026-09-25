import { describe, expect, it } from "vitest";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { allowlistedPackage } from "./packageObservation.js";
import { projectPackageControl, type SavedPackageControl } from "./packageControlProjection.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { capturePackageMutationState } from "./packageMutationState.js";

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
