import { describe, expect, it } from "vitest";
import { projectPackageDetails } from "./packageDetailProjection.js";
import { allowlistedPackage } from "./packageObservation.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";

const now = Date.parse("2026-09-24T10:00:00Z");
const summary = allowlistedPackage({
  id: "package", displayName: "Current catalog name", isBlocked: true,
  lastModifiedDateTime: "2026-09-24T08:00:00Z", version: "1", manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  availableTo: "some", deployedTo: "none",
});
const detailed = {
  ...summary, displayName: "Old detail name", isBlocked: false, longDescription: "Description",
  identityDetailsCollected: true as const,
  categories: ["productivity"], sensitivity: "general",
  allowedUsersAndGroups: [{ resourceId: "user", resourceType: "user" }],
  elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "element", definition: "{}" }] }],
};
const observation = {
  package: detailed,
  observedAt: "2026-09-24T09:30:00Z",
  expiresAt: "2026-09-24T10:30:00Z",
};

describe("separate package detail projection", () => {
  it("enriches descriptions, access and identity without replacing catalog summary/control fields", () => {
    expect(projectPackageDetails(summary, observation, false, now)).toMatchObject({
      displayName: summary.displayName, isBlocked: true, availableTo: "some",
      longDescription: detailed.longDescription, categories: detailed.categories,
      allowedUsersAndGroups: detailed.allowedUsersAndGroups, elementDetails: detailed.elementDetails,
      identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: observation.observedAt, expiresAt: observation.expiresAt },
    });
  });

  it("retains stale descriptive details without renewing identity evidence from catalog freshness", () => {
    const result = projectPackageDetails(summary, { ...observation, expiresAt: "2026-09-24T09:59:59Z" }, false, now);
    expect(result).toMatchObject({ longDescription: detailed.longDescription, detailFreshness: { state: "stale" }, identityRevalidationRequired: true });
    expect(result).not.toHaveProperty("identityDetailsCollected");
    expect(resolvePackageAgentLinks("tenant", [result], [])[0].status).toBe("unmatched");
  });

  it.each([
    { version: "2" }, { version: undefined }, { manifestId: undefined },
    { lastModifiedDateTime: undefined }, { lastModifiedDateTime: "invalid" },
  ])("withdraws cached identity when revision markers change or disappear: %j", markers => {
    const value = projectPackageDetails({ ...summary, ...markers }, observation, false, now);
    expect(value).toMatchObject({ identityRevalidationRequired: true, detailFreshness: { state: "invalidated" } });
    expect(value).not.toHaveProperty("elementDetails");
  });

  it("does not retain prior metadata after an authoritative read omits it or reports absence", () => {
    const omitted = projectPackageDetails(detailed, { ...observation, package: { ...summary, identityDetailsCollected: true } }, true, now);
    expect(omitted).not.toHaveProperty("elementDetails");
    const absent = projectPackageDetails(detailed, { ...observation, package: null }, false, now);
    expect(absent).not.toHaveProperty("elementDetails");
    expect(absent.detailFreshness?.state).toBe("invalidated");
  });

  it("never upgrades uncollected broad summaries to collected empty detail", () => {
    const result = projectPackageDetails(summary, { ...observation, package: summary }, true, now);
    expect(result.detailFreshness).toEqual({ state: "missing", observedAt: null, expiresAt: null });
    expect(result).not.toHaveProperty("identityDetailsCollected");
    const empty = projectPackageDetails(summary, {
      ...observation, package: { ...summary, identityDetailsCollected: true },
    }, true, now);
    expect(empty).toMatchObject({ identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(empty).not.toHaveProperty("elementDetails");
  });

  it("preserves structured legacy detail evidence without treating empty groups as a completed read", () => {
    const { identityDetailsCollected: _collected, ...legacy } = detailed;
    expect(projectPackageDetails(summary, { ...observation, package: legacy }, true, now)).toMatchObject({
      identityDetailsCollected: true, elementDetails: detailed.elementDetails, detailFreshness: { state: "fresh" },
    });
    const unknown = projectPackageDetails(summary, {
      ...observation, package: { ...summary, elementDetails: [{ elementType: "AgentMetadatas", elements: [] }] },
    }, true, now);
    expect(unknown).not.toHaveProperty("identityDetailsCollected");
    expect(unknown.detailFreshness?.state).toBe("missing");
  });

  it("never supplies cached access membership for a different catalog access scope", () => {
    const result = projectPackageDetails({ ...summary, availableTo: "none" }, observation, false, now);
    expect(result.availableTo).toBe("none");
    expect(result.allowedUsersAndGroups).toBeUndefined();
  });

  it.each([
    { elementTypes: ["Bots"] },
    { elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
      SourceIds: { EnvironmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    }) }] }] },
    { elementDetails: [{ elementType: "DeclarativeCopilots", elements: [
      { id: "first", definition: "{}" }, { id: "second", definition: "{}" },
    ] }] },
  ])("does not hide positive catalog identity changes behind unchanged revision markers: %j", evidence => {
    const result = projectPackageDetails({ ...summary, ...evidence }, observation, false, now);
    expect(result).toMatchObject({ detailFreshness: { state: "invalidated" }, identityRevalidationRequired: true });
    expect(result).not.toHaveProperty("elementDetails");
    expect(result).not.toHaveProperty("identityDetailsCollected");
    expect(resolvePackageAgentLinks("tenant", [result], [])[0]).not.toHaveProperty("grouping");
  });

  it("retains compatible details when catalog identity fields are sparse, empty or case-equivalent", () => {
    const saved = { ...observation, package: { ...detailed, elementTypes: ["DeclarativeCopilots"] } };
    for (const evidence of [
      {},
      { elementTypes: [], elementDetails: [{ elementType: "AgentMetadatas", elements: [] }] },
      { elementTypes: ["declarativecopilots"], elementDetails: detailed.elementDetails },
    ]) {
      expect(projectPackageDetails({ ...summary, ...evidence }, saved, false, now)).toMatchObject({
        detailFreshness: { state: "fresh" }, identityDetailsCollected: true, elementDetails: detailed.elementDetails,
      });
    }
  });

  it.each(["allowedUsersAndGroups", "acquireUsersAndGroups"] as const)(
    "retains explicitly newer catalog %s but still uses newer details and enriches omissions", key => {
      const cached = [{ resourceId: "cached", resourceType: "user" }];
      const saved = { ...observation, package: { ...detailed, [key]: cached } };
      for (const principals of [[], [{ resourceId: "current", resourceType: "user" }]]) {
        const current = { ...summary, [key]: principals };
        expect(projectPackageDetails(current, saved, false, now, now - 15 * 60_000)[key]).toEqual(principals);
        expect(projectPackageDetails(current, saved, false, now, now - 45 * 60_000)[key]).toEqual(cached);
      }
      expect(projectPackageDetails(summary, saved, false, now, now - 15 * 60_000)[key]).toEqual(cached);
      expect(projectPackageDetails({ ...summary, [key]: cached }, {
        ...observation, package: { ...summary, identityDetailsCollected: true },
      }, false, now, now - 45 * 60_000)).not.toHaveProperty(key);
    },
  );

  it("preserves absence rather than inventing undefined access membership properties", () => {
    const result = projectPackageDetails(summary, { ...observation, package: {
      ...summary, identityDetailsCollected: true,
    } }, true, now);
    expect(result).not.toHaveProperty("allowedUsersAndGroups");
    expect(result).not.toHaveProperty("acquireUsersAndGroups");
  });

  it("permits direct authoritative details without inventing a reusable revision", () => {
    const direct = { ...detailed, lastModifiedDateTime: undefined };
    expect(projectPackageDetails(direct, { ...observation, package: direct }, true, now)).toMatchObject({
      elementDetails: detailed.elementDetails, detailFreshness: { state: "fresh" },
    });
    expect(projectPackageDetails(direct, { ...observation, package: direct }, false, now)).not.toHaveProperty("elementDetails");
  });
});
