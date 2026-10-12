import { describe, expect, it, vi } from "vitest";
import { packageDetailRevision, projectPackageDetailAge, projectPackageDetails } from "./packageDetailProjection.js";
import { allowlistedPackage } from "./packageObservation.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { projectPackageControl } from "./packageControlProjection.js";
import { packageInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";

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
  it("uses the newer observed telemetry and does not carry omitted observations across refreshes", () => {
    const saved = { ...observation, package: { ...detailed, ownerId: null,
      providerUsage: { activeUsers: 3, totalSessions: 5 }, provenance: { ...detailed.provenance,
        "providerUsage.activeUsers": { sourceSystem: "graph_packages" as const, path: "activeUsers", maturity: "observed" as const } } } };
    expect(projectPackageDetails(summary, saved, true, now)).toMatchObject({ ownerId: null, providerUsage: { activeUsers: 3 } });
    expect(projectPackageDetails({ ...summary, providerUsage: { activeUsers: 1 } }, saved, true, now, now))
      .toMatchObject({ providerUsage: { activeUsers: 1 } });
    expect(projectPackageDetails(summary, saved, true, now, now)).not.toHaveProperty("providerUsage");
    const cleared = projectPackageDetails({ ...summary, providerUsage: { activeUsers: 3 } }, observation, true, now);
    expect(cleared).not.toHaveProperty("providerUsage");
    expect(cleared.provenance).not.toHaveProperty("providerUsage.activeUsers");
  });

  it("projects sharing independently of availability and installation without replacing a newer catalog observation", () => {
    const sharedWithUsersAndGroups = [{ resourceId: "shared-recipient", resourceType: "user" }];
    const saved = { ...observation, package: { ...detailed, sharedWithUsersAndGroups } };
    const result = projectPackageDetails({ ...summary, availableTo: "allowedForAll" }, saved, false, now);
    expect(result.sharedWithUsersAndGroups).toEqual(sharedWithUsersAndGroups);
    expect(result.allowedUsersAndGroups).toBeUndefined();
    expect(result.availableTo).toBe("allowedForAll");
    expect(result.deployedTo).toBe(summary.deployedTo);
    expect(projectPackageDetails({ ...summary, sharedWithUsersAndGroups: [] }, saved, false, now, now)
      .sharedWithUsersAndGroups).toEqual([]);
    expect(projectPackageDetails(summary, { ...saved, package: { ...detailed, sharedWithUsersAndGroups: [] } }, false, now)
      .sharedWithUsersAndGroups).toEqual([]);
    expect(projectPackageDetails({ ...summary, sharedWithUsersAndGroups }, observation, true, now))
      .not.toHaveProperty("sharedWithUsersAndGroups");
    expect(projectPackageDetails({ ...summary, version: "2" }, saved, false, now))
      .not.toHaveProperty("sharedWithUsersAndGroups");
    expect(projectPackageDetails(summary, { ...saved, expiresAt: "2026-09-24T09:59:59Z" }, false, now))
      .toMatchObject({ sharedWithUsersAndGroups, detailFreshness: { state: "stale" } });
  });

  it("ages identity evidence at exact sub-millisecond instants for number, Date and string evaluations", () => {
    const value = { ...detailed, detailFreshness: {
      state: "fresh" as const, observedAt: "2026-09-24T09:59:59.999999999Z", expiresAt: "2026-09-24T10:00:00.000000002Z",
    } };
    for (const evaluation of [now, new Date(now), "2026-09-24T10:00:00.000000001Z", "2026-09-24T12:00:00.000000001+02:00"]) {
      expect(projectPackageDetailAge(value, evaluation)).toBe(value);
    }
    expect(projectPackageDetailAge(value, value.detailFreshness.expiresAt))
      .toMatchObject({ detailFreshness: { state: "stale" } });
    expect(projectPackageDetailAge(value, value.detailFreshness.expiresAt)).not.toHaveProperty("identityDetailsCollected");
    expect(projectPackageDetailAge(value, "2026-09-24T09:59:59.999999998Z")).not.toHaveProperty("identityDetailsCollected");
    expect(value.identityDetailsCollected).toBe(true);
  });

  it("does not persist early stale or fresh classifications when saved detail timestamps exceed millisecond precision", () => {
    const saved = { ...observation, observedAt: "2026-09-24T09:59:59.999999Z", expiresAt: "2026-09-24T10:00:00.000001Z" };
    expect(projectPackageDetails(summary, saved, false, now)).toMatchObject({
      identityDetailsCollected: true, detailFreshness: { state: "fresh" },
    });
    const future = projectPackageDetails(summary, { ...saved, observedAt: "2026-09-24T10:00:00.000001Z", expiresAt: observation.expiresAt }, false, now);
    expect(future.detailFreshness?.state).toBe("stale");
    expect(future).not.toHaveProperty("identityDetailsCollected");
  });

  it("enriches descriptions, access and identity without replacing catalog summary/control fields", () => {
    expect(projectPackageDetails(summary, observation, false, now)).toMatchObject({
      displayName: summary.displayName, isBlocked: true, availableTo: "some",
      longDescription: detailed.longDescription, categories: detailed.categories,
      allowedUsersAndGroups: detailed.allowedUsersAndGroups, elementDetails: detailed.elementDetails,
      identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: observation.observedAt, expiresAt: observation.expiresAt },
    });
  });

  it("reuses typed manifest GUID casing while keeping opaque revision markers exact", () => {
    const current = { ...summary, manifestId: summary.manifestId!.toUpperCase() };
    for (const catalogRevision of [undefined, packageDetailRevision(summary)]) {
      expect(projectPackageDetails(current, { ...observation, catalogRevision }, false, now)).toMatchObject({
        manifestId: current.manifestId, identityDetailsCollected: true, detailFreshness: { state: "fresh" },
      });
    }
    for (const key of ["appId", "assetId", "version", "manifestVersion"] as const) {
      const marker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const saved = { ...observation, package: { ...detailed, [key]: marker },
        catalogRevision: packageDetailRevision({ ...summary, [key]: marker }) };
      expect(projectPackageDetails({ ...summary, [key]: marker.toUpperCase() }, saved, false, now)
        .detailFreshness?.state).toBe("invalidated");
    }
  });

  it("rejects malformed modification instants rather than binding reusable detail to Date.parse normalization", () => {
    const current = { ...summary, lastModifiedDateTime: "2026-02-30T08:00:00Z" };
    expect(projectPackageDetails(current, { ...observation, package: { ...detailed,
      lastModifiedDateTime: current.lastModifiedDateTime } }, false, now).detailFreshness?.state).toBe("invalidated");
  });

  it("binds valid fractional modification instants even when the browser only parses millisecond ISO strings", () => {
    const parse = Date.parse;
    const browser = vi.spyOn(Date, "parse").mockImplementation(text =>
      /\.\d{4,}(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? NaN : parse(text));
    try {
      const current = { ...summary, lastModifiedDateTime: "2026-09-24T08:00:00.123456789Z" };
      const saved = { ...observation, package: { ...detailed, lastModifiedDateTime: current.lastModifiedDateTime },
        observedAt: "2026-09-24T09:59:59.999999999Z", expiresAt: "2026-09-24T10:00:00.000000002Z" };
      expect(projectPackageDetails(current, saved, false, now)).toMatchObject({
        identityDetailsCollected: true, detailFreshness: { state: "fresh" },
      });
      expect(projectPackageDetailAge({ ...current, identityDetailsCollected: true,
        detailFreshness: { state: "fresh", observedAt: saved.observedAt, expiresAt: saved.expiresAt } },
      "2026-09-24T10:00:00.000000001Z").detailFreshness?.state).toBe("fresh");
    } finally { browser.mockRestore(); }
  });

  it("accepts sparse automatic details bound to the unchanged catalog revision", () => {
    const { manifestId: _manifest, ...sparse } = detailed;
    const saved = { ...observation, package: sparse, catalogRevision: packageDetailRevision(summary) };
    expect(projectPackageDetails(summary, saved, false, now)).toMatchObject({
      manifestId: summary.manifestId, elementDetails: detailed.elementDetails,
      identityDetailsCollected: true, detailFreshness: { state: "fresh" },
    });
    expect(projectPackageDetails(summary, { ...saved, catalogRevision: undefined }, false, now).detailFreshness?.state).toBe("invalidated");
    for (const current of [{ ...summary, version: "2" }, { ...summary, manifestId: undefined }]) {
      expect(projectPackageDetails(current, saved, false, now).detailFreshness?.state).toBe("invalidated");
    }
    for (const changed of [
      { manifestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { version: "2" },
    ]) {
      expect(projectPackageDetails(summary, { ...saved, package: { ...sparse, ...changed } }, false, now)
        .detailFreshness?.state).toBe("invalidated");
    }
  });

  it("accepts endpoint-specific modification timestamps only with an unchanged reserved catalog revision", () => {
    const { manifestId: _manifest, ...sparse } = detailed;
    const saved = {
      ...observation,
      package: { ...sparse, lastModifiedDateTime: "2026-09-24T08:00:00.8088068Z" },
      catalogRevision: packageDetailRevision(summary),
    };
    const result = projectPackageDetails(summary, saved, false, now);
    expect(result).toMatchObject({
      lastModifiedDateTime: summary.lastModifiedDateTime, manifestId: summary.manifestId,
      identityDetailsCollected: true, elementDetails: detailed.elementDetails, detailFreshness: { state: "fresh" },
    });
    expect(projectPackageDetails(summary, { ...saved, catalogRevision: undefined }, false, now)
      .detailFreshness?.state).toBe("invalidated");
    expect(projectPackageDetails({ ...summary, lastModifiedDateTime: "2026-09-24T08:01:00Z" }, saved, false, now)
      .detailFreshness?.state).toBe("invalidated");
    expect(projectPackageDetails(summary, { ...saved, expiresAt: "2026-09-24T09:59:59Z" }, false, now))
      .toMatchObject({ detailFreshness: { state: "stale" } });
    for (const changed of [
      { id: "other-package" }, { version: "2" }, { manifestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { elementTypes: ["Bots"] },
    ]) {
      expect(projectPackageDetails({ ...summary, elementTypes: ["DeclarativeCopilots"] },
        { ...saved, package: { ...saved.package, ...changed } }, false, now)
        .detailFreshness?.state).toBe("invalidated");
    }
  });

  it("retains stale descriptive details without renewing identity evidence from catalog freshness", () => {
    const result = projectPackageDetails(summary, { ...observation, expiresAt: "2026-09-24T09:59:59Z" }, false, now);
    expect(result).toMatchObject({ longDescription: detailed.longDescription, detailFreshness: { state: "stale" } });
    expect(result).not.toHaveProperty("identityDetailsCollected");
    expect(result).not.toHaveProperty("identityRevalidationRequired");
    expect(projectPackageDetails({ ...summary, identityRevalidationRequired: true },
      { ...observation, expiresAt: "2026-09-24T09:59:59Z" }, false, now).identityRevalidationRequired).toBe(true);
    expect(resolvePackageAgentLinks("tenant", [result], [])[0].status).toBe("unmatched");
  });

  it("retains a control identity conflict through catalog enrichment until an exact identity read", () => {
    const readback = allowlistedPackage({
      id: summary.id, displayName: summary.displayName, isBlocked: true,
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition: JSON.stringify({
        SourceIds: { EnvironmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      }) }] }],
    });
    const conflicted = projectPackageControl(detailed, {
      detail: readback, state: { kind: "block", isBlocked: true },
      observation: { snapshotId: "control", observedAt: observation.observedAt, expiresAt: observation.expiresAt },
    });
    const record = packageInventoryRecord(conflicted);
    const saved = restoreInventoryRecord(record.residual, record.facts, "packages") as typeof conflicted;
    for (const catalogRevision of [undefined, packageDetailRevision(summary)]) {
      const result = projectPackageDetails(summary, { ...observation, package: saved, catalogRevision }, false, now, now);
      expect(result).toMatchObject({ identityRevalidationRequired: true, detailFreshness: { state: "fresh" } });
      expect(result).not.toHaveProperty("identityDetailsCollected");
      expect(packageInventoryRecord(result).facts.some(fact => fact.kind.startsWith("match:"))).toBe(false);
      expect(resolvePackageAgentLinks("tenant", [result], [])[0]).not.toHaveProperty("grouping");
    }
    const exact = projectPackageDetails(detailed, observation, true, now);
    expect(exact).not.toHaveProperty("identityRevalidationRequired");
    expect(exact.identityDetailsCollected).toBe(true);
  });

  it.each([undefined, []])("retains the conflict even when prior details have no elements (%j)", elementDetails => {
    const conflicted = projectPackageControl({ ...detailed, elementDetails }, {
      detail: allowlistedPackage({ id: summary.id, displayName: summary.displayName, isBlocked: true, version: "2" }),
      state: { kind: "block", isBlocked: true },
      observation: { snapshotId: "control", observedAt: observation.observedAt, expiresAt: observation.expiresAt },
    });
    const result = projectPackageDetails({ ...summary, elementTypes: ["DeclarativeCopilots"] }, {
      ...observation, package: conflicted, catalogRevision: packageDetailRevision(summary),
    }, false, now, now);
    expect(result).toMatchObject({ identityRevalidationRequired: true, detailFreshness: { state: "missing" } });
    expect(result).not.toHaveProperty("identityDetailsCollected");
    expect(resolvePackageAgentLinks("tenant", [result], [])[0]).not.toHaveProperty("grouping");
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
    ["availableTo", "allowedUsersAndGroups", "AllowedForSome"],
    ["deployedTo", "acquireUsersAndGroups", "InstalledForSome"],
  ] as const)("enriches %s aliases without replacing raw catalog scope or newer catalog membership", (scope, collection, alias) => {
    const cached = [{ resourceId: "cached", resourceType: "user" }];
    const current = { ...summary, [scope]: alias };
    const saved = { ...observation, package: { ...detailed, [scope]: "some", [collection]: cached } };
    const result = projectPackageDetails(current, saved, false, now);
    expect(result[scope]).toBe(alias);
    expect(result[collection]).toEqual(cached);
    const record = packageInventoryRecord(result);
    expect(restoreInventoryRecord(record.residual, record.facts, "packages")).toMatchObject({
      [scope]: alias, [collection]: cached,
    });
    expect(projectPackageDetails({ ...current, [collection]: [] }, saved, false, now, now)[collection]).toEqual([]);
    expect(projectPackageDetails({ ...current, [scope]: "future-scope" }, {
      ...saved, package: { ...saved.package, [scope]: "other-future-scope" },
    }, false, now)[collection]).toBeUndefined();
  });

  it("retains completed empty detail provenance across stale and conflicted inventory round trips", () => {
    const empty = projectPackageDetails(summary, {
      ...observation, package: { ...summary, identityDetailsCollected: true },
    }, true, now);
    const stale = projectPackageDetailAge(empty, observation.expiresAt);
    const conflicted = projectPackageControl(empty, {
      detail: { ...summary, version: "2" }, state: { kind: "block", isBlocked: true },
      observation: { snapshotId: "control", observedAt: observation.observedAt, expiresAt: observation.expiresAt },
    });
    for (const value of [stale, conflicted]) {
      const record = packageInventoryRecord(value);
      const restored = restoreInventoryRecord(record.residual, record.facts, "packages") as typeof value;
      const result = projectPackageDetails(summary, { ...observation, package: restored,
        catalogRevision: packageDetailRevision(summary) }, false, Date.parse(observation.expiresAt));
      expect(result.detailFreshness).toEqual({ ...empty.detailFreshness, state: "stale" });
      expect(result).not.toHaveProperty("identityDetailsCollected");
      expect(result.identityRevalidationRequired).toBe(value.identityRevalidationRequired);
    }
  });

  it("does not reclassify an invalidated saved detail observation on a later unchanged catalog", () => {
    const current = { ...summary, version: "2" };
    const invalidated = projectPackageDetails(current, observation, false, now);
    const record = packageInventoryRecord(invalidated);
    const restored = restoreInventoryRecord(record.residual, record.facts, "packages") as typeof invalidated;
    const result = projectPackageDetails(current, { ...observation, package: restored,
      catalogRevision: packageDetailRevision(current) }, false, now);
    expect(result.detailFreshness).toEqual(invalidated.detailFreshness);
    expect(result.identityRevalidationRequired).toBe(true);
    expect(result).not.toHaveProperty("identityDetailsCollected");
    const reread = projectPackageDetails(current, { ...observation,
      package: { ...current, identityDetailsCollected: true } }, true, now);
    expect(reread.detailFreshness?.state).toBe("fresh");
    expect(reread).not.toHaveProperty("identityRevalidationRequired");
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
