import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { inventoryAttentionReasons, inventoryDetailsPending } from "../../../frontend/src/inventoryVerification.js";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "../../../frontend/src/test/inventoryVerification.js";
import { buildRecords } from "./inventoryComponent.js";
import { inventoryObservation, inventoryPresentation, inventorySourceStatuses } from "./inventoryPresentation.js";
import { inventoryTimestamp } from "./inventoryTimestamp.js";
import { packageDetailRevision, projectPackageDetailAge, projectPackageDetails } from "./packageDetailProjection.js";
import { unifiedAgentExportRows } from "./inventoryCsv.js";
import { canonicalRecord, packageInventoryRecord, powerPlatformInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";
import { InventoryReconciliation } from "./inventoryReconciliation.js";
import { inventoryExportSource } from "./inventoryExports.js";
import type { ExportSource } from "./dataExports.js";
import type { GenerationLease } from "../db/dataGenerations.js";
import type { PackageAgentLinkEvidence } from "./packageAgentIdentity.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { allowlistedPackage } from "./packageObservation.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { normalizeEnvironmentIdentitySql, normalizeNativeIdentitySql } from "../db/inventoryIdentityNormalization.js";
import { OfficialReportExports } from "./officialReportExports.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { SavedAgentEnvironment, SavedAgentPerson } from "../types/unifiedAgents.js";

const observedAt = "2026-09-20T12:00:00.000Z", expiresAt = "2030-01-01T00:00:00.000Z";

function savedPage(pendingPackages: number, invalidPackages: number): Parameters<typeof inventoryPresentation>[0] {
  const packages = 1 + pendingPackages;
  const summary = { total: packages, linked: 0, graphOnly: packages, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
  return {
    inventoryScope: "all", value: [], summary, scopeSummary: summary, filteredSummary: summary,
    inventoryOverview: { availableToUsers: 0, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 0 },
    counts: { total: packages, scoped: packages, filtered: packages, packageTargets: packages },
    page: { limit: 50, nextCursor: null, previousCursor: null },
    selection: { id: "selection", revision: "1", evaluatedAt: observedAt, expiresAt, validatedAt: observedAt,
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    reports: {
      setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 30, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [],
    },
    freshness: { state: "idle", capturedRevision: "1", sources: [
      { source: "inventory_packages", generation_id: "packages", current: true, token_mode: "delegated",
        scope_id: "package-scope", observed_at: observedAt, expires_at: expiresAt, catalog_complete: true,
        catalog_scope_complete: true,
        catalog_observed_at: observedAt, catalog_expires_at: expiresAt,
        complete: true, channel: "catalog", expected_count: packages, row_count: packages },
      { source: "inventory_power_platform", generation_id: "native", current: true, role_scope: "unknown",
        scope_id: "native-scope", complete: true, channel: "catalog", expected_count: 0,
        catalog_scope_complete: true, catalog_observed_at: observedAt, catalog_expires_at: expiresAt,
        observed_at: observedAt, expires_at: expiresAt, catalog_complete: true, row_count: 0, agent_count: 0,
        resource_types: ["microsoft.copilotstudio/agents"], environment_id: null, page_count: 1 },
    ] },
    verificationCounts: { packages, native_agents: 0, represented: packages, unique_sources: packages,
      checked_packages: 1, stale_packages: 0, invalidated_packages: 0, invalid_packages: invalidPackages },
    partial: false,
  };
}

afterEach(() => vi.restoreAllMocks());

function memberPage(native = false): Parameters<typeof inventoryPresentation>[0] {
  const raw = savedPage(0, 0);
  const value = { ...allowlistedPackage({ id: "Package-Exact", displayName: "Package", isBlocked: false }),
    identityDetailsCollected: true as const, detailFreshness: { state: "fresh" as const, observedAt, expiresAt } };
  raw.value.push({
    id: "canonical", nativeId: "canonical", domain: "canonical", resourceType: null, residual: null,
    displayName: "Agent", environmentId: null, presence: "graph_packages", linkState: "unmatched",
    identity: { reason: "No native source link." }, availability: "unknown", management: "unknown",
    columns: {}, people: {}, environment: null, responses: null, activeUsers: null, lastActivity: null, associationCount: 0,
    members: [{ ...packageInventoryRecord(value), domain: "packages", scope_id: "package-scope",
      source_identity: value.id, generation_id: "package-member", detail_generation: "package-detail",
      catalog_generation: "package-catalog", catalog_observed_at: observedAt, catalog_expires_at: expiresAt,
      observed_at: observedAt, expires_at: expiresAt, source_channel: "catalog", total: "1", evidence: [] }],
  });
  if (native) {
    const resource: PowerPlatformResource = {
      tenantId: "tenant", nativeId: "Native-Exact", environmentId: null, type: "microsoft.copilotstudio/agents",
      displayName: "Native", location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
      sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent",
      lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
    };
    raw.value[0].presence = "both";
    raw.value[0].linkState = "matched";
    raw.summary = { ...raw.summary, graphOnly: 0, linked: 1 };
    raw.scopeSummary = { ...raw.summary };
    raw.filteredSummary = { ...raw.summary };
    Object.assign(raw.verificationCounts, { native_agents: 1, represented: 2, unique_sources: 2 });
    Object.assign(raw.freshness.sources[1], { row_count: 1, agent_count: 1, expected_count: 1 });
    raw.value[0].members.push({ ...powerPlatformInventoryRecord(resource), domain: "power_platform", scope_id: "native-scope",
      source_identity: "native-exact-key", generation_id: "native-member", observed_at: observedAt, expires_at: expiresAt,
      total: "1", evidence: [], identifiers: [], identifier_count: 0 });
  }
  return raw;
}

function savedPerson(): SavedAgentPerson {
  return { objectId: "AAAAAAAA-AAAA-FFFF-FFFF-AAAAAAAAAAAA", displayName: "Owner",
    userPrincipalName: null, observedAt };
}

describe("saved maker-sharing and observed metadata", () => {
  it("presents explicit false and zero native sharing without replacing admin availability or report usage", () => {
    const raw = memberPage(true);
    const native = raw.value[0].members[1];
    native.residual.details = { makerSharing: { viewers: { entireTenant: false, userCount: 0, groupCount: 0 },
      editors: { userCount: 1, groupCount: 0 } }, componentsCounts: { knowledgeByType: {}, topics: 1 },
      flowReferenceCount: 0, triggerCount: 0, instructionsCharactersCount: 5508 };
    native.residual.provenance = { makerSharing: { sourceSystem: "power_platform", path: "properties.sharedWithViewers", maturity: "preview" },
      componentsCounts: { sourceSystem: "power_platform", path: "properties.componentsCounts", maturity: "observed" } };
    raw.value[0].members[0].residual.providerUsage = { activeUsers: 3, totalSessions: 5, exceptionRate: 0 };
    const result = inventoryPresentation(raw).value[0];
    expect(result.powerPlatformResource?.details).toEqual(native.residual.details);
    expect(result.packages[0].providerUsage).toEqual({ activeUsers: 3, totalSessions: 5, exceptionRate: 0 });
    expect(result.usage?.activeUsers).toBeNull();
  });

  it.each([
    { makerSharing: { viewers: { entireTenant: "false" } } },
    { makerSharing: { editors: { userCount: -1 } } },
    { makerSharing: { editors: { entireTenant: true } } },
    { makerSharing: null }, { componentsCounts: [] }, { instructionsCharactersCount: 1.5 },
    { flowReferenceCount: "0" }, { triggerCount: -1 }, { distinctFlows: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed saved native evidence: %j", details => {
    const raw = memberPage(true);
    raw.value[0].members[1].residual.details = details;
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });
});

function environmentPage(): ReturnType<typeof memberPage> {
  const raw = memberPage(true);
  const environment: SavedAgentEnvironment = {
    id: "Default-AAAAAAAA-AAAA-FFFF-FFFF-AAAAAAAAAAAA", displayName: "Environment",
    region: null, environmentType: null, isManaged: false, groupName: null, groupId: null,
    observation: { id: "environment-generation", snapshotId: "environment-generation",
      observedAt, expiresAt, current: true },
    provenance: { nativeId: { sourceSystem: "power_platform", path: "name", maturity: "ga" } },
  };
  raw.value[0].environmentId = environment.id.toLowerCase();
  raw.value[0].members[1].residual.environmentId = environment.id;
  raw.value[0].environment = environment;
  return raw;
}

describe("saved inventory row structure", () => {
  it.each(["stale", "invalidated"] as const)(
    "keeps completed empty %s detail checks readable and correctly classified for API, frontend and CSV consumers", state => {
      const raw = memberPage(), member = raw.value[0].members[0];
      const catalog = allowlistedPackage({
        id: member.native_id, displayName: "Package", isBlocked: false, version: state === "invalidated" ? "2" : "1",
        lastModifiedDateTime: "2026-09-20T10:00:00Z",
      });
      const saved = {
        package: { ...catalog, version: "1", identityDetailsCollected: true as const },
        observedAt: "2026-09-20T11:00:00Z", expiresAt: state === "stale" ? "2026-09-20T11:30:00Z" : "2026-09-20T13:00:00Z",
      };
      const first = packageInventoryRecord(projectPackageDetails(catalog, saved, false, Date.parse(observedAt)));
      const restored = restoreInventoryRecord(first.residual, first.facts, "packages") as typeof catalog;
      const projected = projectPackageDetails(catalog, { ...saved, package: restored,
        catalogRevision: packageDetailRevision(catalog) }, false, Date.parse(observedAt));
      member.residual = packageInventoryRecord(projected).residual;
      Object.assign(raw.verificationCounts, {
        checked_packages: 0, stale_packages: Number(state === "stale"), invalidated_packages: Number(state === "invalidated"),
      });
      const page = inventoryPresentation(raw);
      expect(page.identityCollection).toMatchObject({
        checkedPackages: 0, pendingPackages: 1,
        pendingDetails: { missing: 0, stale: Number(state === "stale"), invalidated: Number(state === "invalidated") },
      });
      expect(inventoryDetailsPending(page)).toBe(true);
      expect(page.value[0].packages[0].detailFreshness).toEqual(projected.detailFreshness);
      const exported = [...unifiedAgentExportRows(page)][0];
      expect(JSON.parse(exported.packageStates).map((value: { detailFreshness: unknown }) => value.detailFreshness))
        .toEqual([projected.detailFreshness]);
    },
  );

  it.each([
    { isBlocked: "false" }, { authoringTool: {} }, { publisher: 1 }, { availableTo: [] },
    { supportedHosts: ["Teams", {}] }, { elementTypes: "Bots" },
    { detailFreshness: null }, { detailFreshness: { state: "invented", observedAt: null, expiresAt: null } },
    { controlObservations: { block: { snapshotId: "control", observedAt, expiresAt: observedAt } } },
  ])("rejects malformed typed package fields before API, frontend or CSV consumption: %j", fields => {
    const raw = memberPage();
    delete raw.value[0].members[0].detail_generation;
    delete raw.value[0].members[0].residual.detailFreshness;
    Object.assign(raw.value[0].members[0].residual, fields);
    raw.verificationCounts.checked_packages = 0;
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it.each([
    { displayName: {} }, { authoringTool: false }, { location: [] }, { lifecycle: "invented" },
    { details: { isQuarantined: "false" } }, { details: { model: {} } },
    { details: { channels: ["Teams", false] } }, { details: { connectors: [{ connectorId: "connector", operations: [{ operationId: "operation", isEnabled: "false" }] }] } },
    { details: { distinctPowerPlatformConnectors: "2" } }, { unknownFieldCount: -1 },
  ])("rejects malformed typed native fields before rendering or control decisions: %j", fields => {
    const raw = memberPage(true);
    Object.assign(raw.value[0].members[1].residual, fields);
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("rejects native member environments and canonical link classifications that disagree", () => {
    const raw = environmentPage();
    raw.value[0].members[1].residual.environmentId = "Different-Environment";
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    for (const [native, state] of [[false, "matched"], [true, "unmatched"]] as const) {
      const page = memberPage(native);
      page.value[0].linkState = state;
      expect(() => inventoryPresentation(page)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("rejects malformed or environment-mismatched saved quarantine identities without relying on identifier previews", () => {
    const raw = environmentPage(), member = raw.value[0].members[1];
    const identity = { environmentId: raw.value[0].environmentId, botId: "aaaaaaaa-aaaa-ffff-ffff-aaaaaaaaaaaa" };
    member.quarantine_identity = identity;
    expect(inventoryPresentation(raw).value[0].powerPlatformResource?.quarantineIdentity).toEqual(identity);
    for (const invalid of [false, "identity", [], {}, { ...identity, environmentId: "Different-Environment" },
      { ...identity, botId: undefined }, { ...identity, botId: 1 }, { ...identity, botId: "not-a-guid" }]) {
      member.quarantine_identity = invalid;
      expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("rejects absent or non-object people and null or non-object person entries", () => {
    for (const people of [undefined, null, false, "", [], new Map(),
      { owner: null }, { owner: undefined }, { owner: false }, { owner: [] }]) {
      const raw = memberPage();
      Object.assign(raw.value[0], { people });
      expect(() => inventoryPresentation(raw), `people: ${String(people)}`)
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it.each([
    ["objectId", [undefined, null, 1, "", "not-a-guid"]],
    ["displayName", [undefined, 1, {}]],
    ["userPrincipalName", [undefined, false, []]],
    ["status", [null, 1, "unknown"]],
    ["errorCode", [null, 1, {}]],
    ["observedAt", [undefined, null, observedAt.slice(0, 10), new Date(observedAt)]],
    ["checkedAt", [null, "", new Date(observedAt)]],
    ["expiresAt", [null, "", new Date(expiresAt)]],
  ] as const)("rejects malformed saved person %s", (field, values) => {
    for (const value of values) {
      const raw = memberPage(), person = savedPerson();
      Object.assign(person, { [field]: value });
      raw.value[0].people = { owner: person };
      expect(() => inventoryPresentation(raw), `${field}: ${String(value)}`)
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("preserves legacy, nullable, empty and failed-lookup person evidence", () => {
    const raw = memberPage();
    raw.value[0].people = {
      owner: savedPerson(),
      createdBy: { ...savedPerson(), displayName: null, userPrincipalName: "", status: "not_found", checkedAt: observedAt, expiresAt },
      lastModifiedBy: { ...savedPerson(), status: "lookup_failed", checkedAt: observedAt, expiresAt, errorCode: "directory_lookup_failed" },
    };
    expect(inventoryPresentation(raw).value[0].people).toEqual(raw.value[0].people);
  });

  it("rejects absent or malformed environment structures", () => {
    for (const environment of [undefined, false, "", [], new Map(),
      { id: "Environment-A" }, { ...environmentPage().value[0].environment, observation: null }]) {
      const raw = environmentPage();
      Object.assign(raw.value[0], { environment });
      expect(() => inventoryPresentation(raw))
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it.each([
    ["id", [undefined, null, false, "", "Different-Environment"]],
    ["displayName", [undefined, false, {}]],
    ["region", [undefined, 1, []]],
    ["environmentType", [undefined, false, {}]],
    ["isManaged", [undefined, 0, "false"]],
    ["groupName", [undefined, false, {}]],
    ["groupId", [undefined, false, {}]],
  ] as const)("rejects malformed saved environment %s", (field, values) => {
    for (const value of values) {
      const raw = environmentPage();
      Object.assign(raw.value[0].environment!, { [field]: value });
      expect(() => inventoryPresentation(raw), `${field}: ${String(value)}`)
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("rejects malformed environment observation and field provenance", () => {
    for (const observation of [undefined, null, false, [], {}, new Map()]) {
      const raw = environmentPage();
      Object.assign(raw.value[0].environment!, { observation });
      expect(() => inventoryPresentation(raw))
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
    for (const observation of [
      { id: "" }, { id: null }, { snapshotId: undefined }, { snapshotId: "different-generation" },
      { current: undefined }, { current: null }, { current: "true" },
      { observedAt: null }, { observedAt: new Date(observedAt) }, { expiresAt: new Date(expiresAt) },
      { expiresAt: observedAt },
    ]) {
      const raw = environmentPage();
      Object.assign(raw.value[0].environment!.observation, observation);
      expect(() => inventoryPresentation(raw))
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
    for (const provenance of [undefined, null, [], new Map(), { id: null }, { id: {} },
      { id: { sourceSystem: "graph_packages", path: "name", maturity: "ga" } },
      { id: { sourceSystem: "power_platform", path: 1, maturity: "ga" } },
      { id: { sourceSystem: "power_platform", path: "name", maturity: ["ga"] } }]) {
      const raw = environmentPage();
      Object.assign(raw.value[0].environment!, { provenance });
      expect(() => inventoryPresentation(raw))
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("preserves exact environment observations and ages them at the selected instant", () => {
    for (const [evaluation, current] of [
      ["2026-09-20T12:00:00.000000Z", false],
      ["2026-09-20T12:00:00.000001Z", true],
      ["2026-09-20T12:00:00.000002Z", true],
      ["2026-09-20T12:00:00.000003Z", false],
    ] as const) {
      const raw = environmentPage(), environment = raw.value[0].environment!;
      Object.assign(environment.observation, {
        observedAt: "2026-09-20T12:00:00.000001Z", expiresAt: "2026-09-20T12:00:00.000003Z",
      });
      raw.selection.evaluatedAt = evaluation;
      expect(inventoryPresentation(raw).value[0].environment).toEqual({
        ...environment, observation: { ...environment.observation, current },
      });
      environment.observation.current = false;
      expect(inventoryPresentation(raw).value[0].environment!.observation.current).toBe(false);
    }
    const raw = environmentPage();
    Object.assign(raw.value[0].environment!, {
      displayName: "", region: "", environmentType: "", isManaged: null, groupName: "", groupId: "",
      provenance: { nativeId: { sourceSystem: "power_platform", path: "name", maturity: "preview" } },
    });
    expect(inventoryPresentation(raw).value[0].environment).toEqual(raw.value[0].environment);
    raw.value[0].environment!.provenance = {};
    expect(inventoryPresentation(raw).value[0].environment!.provenance).toEqual({});
  });

  it("uses typed environment identity agreement without folding opaque IDs or stripping Default prefixes", () => {
    for (const [canonical, saved, valid] of [
      ["Environment-A", "Environment-A", true],
      ["Environment-A", "environment-a", false],
      ["Default-AAAAAAAA-AAAA-FFFF-FFFF-AAAAAAAAAAAA", "aaaaaaaa-aaaa-ffff-ffff-aaaaaaaaaaaa", false],
    ] as const) {
      const raw = environmentPage();
      raw.value[0].environmentId = canonical;
      raw.value[0].environment!.id = saved;
      raw.value[0].members[1].residual.environmentId = canonical;
      if (valid) expect(inventoryPresentation(raw).value[0].environment!.id).toBe(saved);
      else expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
    for (const environmentId of [undefined, null, false, [], ""]) {
      const raw = environmentPage();
      Object.assign(raw.value[0], { environmentId });
      expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("rejects null rows or memberships and malformed display-column structures explicitly", () => {
    for (const member of [null, undefined, false, []]) {
      const raw = memberPage();
      Object.assign(raw.value[0], { members: [member] });
      expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
    const raw = memberPage();
    Object.assign(raw, { value: [null] });
    expect(() => inventoryPresentation(raw)).toThrow(AppError);
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    for (const columns of ["not-columns", [], new Map()]) {
      const page = memberPage();
      Object.assign(page.value[0], { columns });
      expect(() => inventoryPresentation(page)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("rejects invalid native identifier kinds, values and conflicting identity evidence", () => {
    for (const identifier of [null, [], {}, { kind: "invented", value: "value" },
      { kind: "CDS_BOT_ID", value: "value" }, { kind: "cds_bot_id", value: "" },
      { kind: "cds_bot_id", value: 1 }, { kind: "cds_bot_id", value: "a".repeat(513) },
      { kind: "entra_app_id", value: "app\0id" }, { kind: "entra_agent_id", value: "\uD800" },
      { kind: "power_platform_resource_id", value: "Different-Native" },
      { kind: "power_platform_resource_id", value: "native-exact" },
      { kind: "environment_id", value: "Environment-A" }]) {
      const raw = memberPage(true);
      Object.assign(raw.value[0].members[1], { identifiers: [identifier], identifier_count: 1 });
      expect(() => inventoryPresentation(raw), JSON.stringify(identifier))
        .toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
    const raw = environmentPage();
    Object.assign(raw.value[0].members[1], {
      identifiers: [{ kind: "environment_id", value: "Different-Environment" }], identifier_count: 1,
    });
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    for (const environmentId of [undefined, false, {}, ""]) {
      const page = memberPage(true);
      Object.assign(page.value[0].members[1].residual, { environmentId });
      expect(() => inventoryPresentation(page)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("preserves valid opaque identifiers, case-equivalent GUID environments and bounded native previews", () => {
    const raw = environmentPage(), environment = raw.value[0].environment!;
    const identifiers: PowerPlatformResource["identifiers"] = [
      { kind: "environment_id", value: environment.id.toLowerCase() },
      { kind: "power_platform_resource_id", value: "Native-Exact" },
      { kind: "cds_bot_id", value: "会社/É:Opaque 😀 " },
      { kind: "entra_app_id", value: "opaque-app" }, { kind: "entra_agent_id", value: "opaque-agent" },
      { kind: "entra_blueprint_id", value: "opaque-parent" },
      ...(["package_id", "package_app_id", "manifest_id", "asset_id"] as const)
        .map(kind => ({ kind, value: "AAAAAAAA-AAAA-FFFF-FFFF-AAAAAAAAAAAA" })),
    ];
    Object.assign(raw.value[0].members[1], { identifiers, identifier_count: identifiers.length + 2 });
    expect(inventoryPresentation(raw).value[0].powerPlatformResource).toMatchObject({
      identifiers, identifierCount: identifiers.length + 2, identifiersComplete: false,
    });
    const noEnvironment = memberPage(true);
    Object.assign(noEnvironment.value[0].members[1], {
      identifiers: identifiers.slice(1, 3), identifier_count: 2,
    });
    expect(inventoryPresentation(noEnvironment).value[0].powerPlatformResource?.identifiers)
      .toEqual(identifiers.slice(1, 3));
  });
});

describe("saved inventory projection invariants", () => {
  it("does not verify source counts when a native target has no logical row, including empty filtered pages", () => {
    const raw = savedPage(0, 0);
    Object.assign(raw.verificationCounts, { native_agents: 1, represented: 2, unique_sources: 2 });
    Object.assign(raw.freshness.sources[1], { row_count: 1, agent_count: 1, expected_count: 1 });
    const page = inventoryPresentation(raw);
    expect(page.verification).toMatchObject({ status: "needs_attention", checks: { sourceMemberships: false } });
    expect(inventoryAttentionReasons(page).join(" ")).toContain("membership accounting");
  });

  it("does not certify a native member whose saved scope has no selected observation", () => {
    const raw = memberPage(true);
    raw.value[0].members[1].scope_id = "absent-native-scope";
    const page = inventoryPresentation(raw);
    expect(page.value[0].observations.powerPlatform).toBeNull();
    expect(page).toMatchObject({ partial: true, verification: { status: "needs_attention", checks: { sourceScopes: false } } });
  });

  it("rejects duplicate visible logical rows and preview counts exceeding full source accounting", () => {
    for (const duplicate of [false, true]) {
      const raw = memberPage();
      if (duplicate) raw.value.push(structuredClone(raw.value[0]));
      else raw.value[0].members[0].total = "2";
      expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("uses exact detail instants before presentation rather than truncating fresh or future evidence", () => {
    const raw = memberPage(), member = raw.value[0].members[0];
    member.residual.detailFreshness = {
      state: "fresh", observedAt: "2026-09-20T11:59:59.999999Z", expiresAt: "2026-09-20T12:00:00.000001Z",
    };
    member.residual = projectPackageDetailAge(member.residual, Date.parse(observedAt));
    const page = inventoryPresentation(raw);
    expect(page.verification.status).toBe("verified");
    expect(page.value[0].packages[0].detailFreshness?.state).toBe("fresh");
    expect(page.value[0].observations.packageSnapshots["Package-Exact"].identityDetails?.current).toBe(true);
    expect(JSON.parse([...unifiedAgentExportRows(page)][0].packageStates)[0].detailFreshness.state).toBe("fresh");

    const future = memberPage();
    future.value[0].members[0].residual.detailFreshness.observedAt = "2026-09-20T12:00:00.000001Z";
    future.value[0].members[0].residual = projectPackageDetailAge(future.value[0].members[0].residual, Date.parse(observedAt));
    Object.assign(future.verificationCounts, { checked_packages: 0, stale_packages: 1 });
    expect(inventoryPresentation(future)).toMatchObject({
      identityCollection: { pendingDetails: { stale: 1 } }, verification: { status: "details_pending" },
    });
    expect(future.value[0].members[0].residual).not.toHaveProperty("identityDetailsCollected");
  });

  it.each(["inventory_packages", "inventory_power_platform"])("does not certify an expired, future, incomplete, or superseded %s root", sourceName => {
    for (const changes of [
      { observed_at: "2026-09-19T00:00:00Z", expires_at: observedAt },
      { observed_at: "2026-09-20T12:00:00.000001Z" },
      { catalog_complete: false }, { complete: false }, { current: false },
    ]) {
      const raw = savedPage(0, 0);
      Object.assign(raw.freshness.sources.find(source => source.source === sourceName)!, changes);
      const page = inventoryPresentation(raw), source = sourceName === "inventory_packages" ? page.sources.graphPackages : page.sources.powerPlatform;
      expect(source.state).toBe("partial");
      if (sourceName === "inventory_packages") expect(source.observation).toMatchObject({ scopeKind: "broad" });
      expect(page.partial).toBe(true);
      expect(page.verification.status).toBe("needs_attention");
      if (source.observation && "verification" in source.observation) expect(source.observation.verification).toBeNull();
      expect(inventoryAttentionReasons(page).length).toBeGreaterThan(0);
    }
  });

  it.each(["stale", "catching_up", "reconciling", "failed"])("does not certify a %s selected canonical root", state => {
    const raw = savedPage(0, 0);
    raw.freshness.state = state;
    expect(inventoryPresentation(raw)).toMatchObject({ partial: true,
      verification: { status: "needs_attention", checks: { sourceScopes: false } } });
  });

  it("retains exact selection precision and millisecond Date expiries at evaluation", () => {
    const raw = memberPage(true);
    raw.selection.evaluatedAt = "2026-09-20T12:00:00.050123Z";
    raw.selection.expiresAt = "2026-09-20T12:00:00.100456Z";
    for (const member of raw.value[0].members) member.expires_at = new Date("2026-09-20T12:00:00.100Z");
    const page = inventoryPresentation(raw);
    expect(page.selection).toMatchObject(raw.selection);
    expect(page.usageContext.expiresAt).toBe(raw.selection.expiresAt);
    expect(page.verification.checkedAt).toBe(raw.selection.evaluatedAt);
    expect(page.value[0].observations.powerPlatform).toMatchObject({
      snapshotId: "native-member", expiresAt: "2026-09-20T12:00:00.100Z", current: true, verification: null,
    });
  });

  it("keeps catalog and detail generations separate without promoting future detail or native observations", () => {
    const raw = memberPage(true), future = "2026-09-20T12:00:00.000001Z";
    Object.assign(raw.verificationCounts, { checked_packages: 0, stale_packages: 1 });
    raw.value[0].members[0].residual.detailFreshness.observedAt = future;
    raw.value[0].members[1].observed_at = future;
    const record = inventoryPresentation(raw).value[0];
    expect(record.observations.packageSnapshots["Package-Exact"]).toMatchObject({
      snapshotId: "package-catalog", observedAt, current: true,
      identityDetails: { snapshotId: "package-detail", observedAt: future, current: false },
    });
    expect(record.packages[0].detailFreshness?.state).toBe("stale");
    expect(record.observations.powerPlatform?.current).toBe(false);
    const exported = [...unifiedAgentExportRows(inventoryPresentation(raw))][0];
    expect(JSON.parse(exported.packageStates)[0].identityDetails.current).toBe(false);
    expect(JSON.parse(exported.powerPlatformState!).observation.current).toBe(false);
  });

  it("selects the same native agent root independent of source order, without substituting environment coverage", () => {
    const raw = savedPage(0, 0);
    const base = raw.freshness.sources[1];
    const sources = [
      { ...base, scope_id: "environment", generation_id: "environment", resource_types: ["microsoft.powerplatform/environments"],
        row_count: 4, expected_count: 4, catalog_observed_at: "2026-09-20T11:59:59Z", catalog_expires_at: expiresAt },
      { ...base, scope_id: "limited", generation_id: "limited", environment_id: "Environment-A",
        catalog_observed_at: "2026-09-20T11:59:59Z", catalog_expires_at: expiresAt },
      { ...base, scope_id: "broad-old", generation_id: "old", catalog_observed_at: "2026-09-18T00:00:00Z", catalog_expires_at: expiresAt },
      { ...base, scope_id: "broad-new", generation_id: "selected", catalog_observed_at: new Date("2026-09-19T00:00:00Z"), catalog_expires_at: expiresAt },
    ];
    for (const ordered of [sources, [...sources].reverse()]) {
      expect(inventorySourceStatuses(ordered, observedAt).powerPlatform.observation?.id).toBe("selected");
    }
    const page = inventorySourceStatuses(sources.slice(0, 1), observedAt).powerPlatform;
    expect(page.state).toBe("partial");
    expect(page.observation).toMatchObject({ coverage: "not_requested", coveredCount: null });
  });

  it("does not invent a provider-total verification for an exact native overlay", () => {
    const raw = savedPage(0, 0);
    Object.assign(raw.freshness.sources[1], { channel: "control", expected_count: null });
    expect(inventoryPresentation(raw).sources.powerPlatform).toMatchObject({
      state: "partial", observation: { verification: null, coverage: "unknown" },
    });
  });

  it("surfaces source membership shortfalls and duplication independently of pending details and filters", () => {
    for (const duplicate of [false, true]) {
      const raw = savedPage(1, 0);
      raw.counts.filtered = 0;
      raw.filteredSummary = { ...raw.filteredSummary, total: 0, graphOnly: 0 };
      if (duplicate) raw.verificationCounts.represented++;
      else raw.freshness.sources[0].row_count++;
      const page = inventoryPresentation(raw);
      expect(page.verification).toMatchObject({ status: "needs_attention", checks: { sourceScopes: true, sourceMemberships: false } });
      expect(inventoryDetailsPending(page)).toBe(true);
      expect(inventoryAttentionReasons(page)).toContain(
        "Saved source membership accounting is incomplete. Recheck the selected source counts and refresh inventory in Data sync.");
      expect([...unifiedAgentExportRows({ ...page, value: inventoryPresentation(memberPage()).value })][0])
        .toMatchObject({ inventoryVerificationStatus: "needs_attention" });
    }
  });

  it.each(["inventory_packages", "inventory_power_platform"])("retains rows but reports an absent %s source", name => {
    const raw = memberPage(true);
    raw.freshness.sources = raw.freshness.sources.filter(source => source.source !== name);
    const page = inventoryPresentation(raw);
    expect(page.value).toHaveLength(1);
    expect(page.verification.status).toBe("needs_attention");
    expect(page.verification.checks.sourceMemberships).toBe(false);
    expect(page.value[0].observations[name === "inventory_packages" ? "graphPackages" : "powerPlatform"]).toBeNull();
  });

  it.each([
    { name: "negative count", change: (raw: ReturnType<typeof memberPage>) => { raw.verificationCounts.packages = -1; } },
    { name: "unsafe count", change: (raw: ReturnType<typeof memberPage>) => { raw.verificationCounts.packages = Number.MAX_SAFE_INTEGER + 1; } },
    { name: "null source count", change: (raw: ReturnType<typeof memberPage>) => { raw.freshness.sources[0].row_count = null; } },
    { name: "missing catalog source provenance", change: (raw: ReturnType<typeof memberPage>) => { raw.freshness.sources[0].catalog_observed_at = null; } },
    { name: "overchecked packages", change: (raw: ReturnType<typeof memberPage>) => { raw.verificationCounts.checked_packages = 2; } },
    { name: "overlapping pending counts", change: (raw: ReturnType<typeof memberPage>) => { raw.verificationCounts.stale_packages = 1; } },
    { name: "provider count mismatch", change: (raw: ReturnType<typeof memberPage>) => { raw.freshness.sources[1].expected_count = 1; } },
    { name: "inconsistent summary", change: (raw: ReturnType<typeof memberPage>) => { raw.summary.linked = 1; } },
    { name: "missing memberships", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members = []; } },
    { name: "zero member count", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].total = 0; } },
    { name: "invalid member evidence", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].evidence = [{}]; } },
    { name: "invalid residual identity", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].identity = { invalidMetadata: "true" }; } },
    { name: "invalid field provenance", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].residual.provenance = { id: {} }; } },
    { name: "non-JSON residual", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].residual.provenance = new Map(); } },
    { name: "unpaired details", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].detail_generation = null; } },
    { name: "falsely certified details", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].residual.detailFreshness.state = "stale"; } },
    { name: "invalid Date", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].expires_at = new Date(NaN); } },
    { name: "invalid calendar date", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].members[0].catalog_observed_at = "2026-02-30T00:00:00Z"; } },
    { name: "invalid usage date", change: (raw: ReturnType<typeof memberPage>) => { raw.value[0].lastActivity = ""; } },
    { name: "duplicate source scope", change: (raw: ReturnType<typeof memberPage>) => { raw.freshness.sources.push({ ...raw.freshness.sources[0] }); } },
  ])("rejects $name rather than producing success-shaped data", ({ change }) => {
    const raw = memberPage();
    change(raw);
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("clones nested saved rows and metadata, preserving absent versus empty collections and raw identity case", () => {
    const raw = memberPage(true);
    raw.value[0].members[0].residual.supportedHosts = [];
    raw.value[0].columns = { status: "Not blocked" };
    raw.value[0].people = { owner: { objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Owner",
      userPrincipalName: null, observedAt } };
    const original = structuredClone(raw), first = inventoryPresentation(raw);
    first.value[0].powerPlatformResource!.details.model = "Changed";
    first.value[0].people!.owner!.displayName = "Changed";
    first.value[0].columns!.status = "Changed";
    first.value[0].packages[0].supportedHosts!.push("Changed");
    first.usageContext.reports.staleAfterDays = 123;
    first.freshness.sources.length = 0;
    expect(raw).toEqual(original);
    const next = inventoryPresentation(raw).value[0];
    expect(next.packages[0]).toMatchObject({ id: "Package-Exact", supportedHosts: [] });
    expect(next.packages[0]).not.toHaveProperty("elementTypes");
    expect(next.powerPlatformResource?.nativeId).toBe("Native-Exact");
    expect(next.powerPlatformResource?.identifiersComplete).toBe(true);
  });

  it("retains bounded representative package counts rather than claiming the preview is a complete list", () => {
    const raw = memberPage();
    raw.value[0].members[0].total = "2";
    Object.assign(raw.verificationCounts, { packages: 2, represented: 2, unique_sources: 2, checked_packages: 2 });
    raw.freshness.sources[0].row_count = 2;
    const page = inventoryPresentation(raw), record = page.value[0];
    expect(record).toMatchObject({ packageCount: 2, memberCount: 2, packagesComplete: false });
    expect(record.packages).toHaveLength(1);
    expect([...unifiedAgentExportRows(page)][0]).toMatchObject({ packageCount: 2, memberCount: 2, packagesComplete: false });
    raw.value[0].members[0].total = "0";
    expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
  });

  it("rejects representative native groups and impossible saved identifier or connector counts", () => {
    for (const changes of [{ total: "2" }, { identifiers: [{ kind: "cds_bot_id", value: "raw-id" }] },
      { connector_counts: { connectors: -1, operations: 0 } }]) {
      const raw = memberPage(true);
      Object.assign(raw.value[0].members[1], changes);
      expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
  });

  it("rejects malformed calendar timestamps and distinguishes sub-millisecond expiry boundaries", () => {
    for (const timestamp of ["2026-02-30T12:00:00Z", "2026-09-20", "2026-09-20T24:00:00Z"]) {
      expect(() => inventoryTimestamp(timestamp)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
    }
    expect(inventoryObservation("id", "2026-09-20T12:00:00.000000Z", "2026-09-20T12:00:00.000002Z", true,
      "2026-09-20T12:00:00.000001Z").current).toBe(true);
    expect(inventoryObservation("id", "2026-09-20T12:00:00.000000Z", "2026-09-20T12:00:00.000002Z", true,
      "2026-09-20T12:00:00.000002Z").current).toBe(false);
  });
});

describe("saved inventory person evidence", () => {
  it.each(["legacy", "resolved", "not_found", "lookup_failed"] as const)(
    "omits unresolved references without discarding %s directory evidence", async status => {
      const database = new pg.Pool({ max: 4 });
      vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
      vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped query"));
      try {
        const queries = new InventoryQueries(database, "synthetic-person-evidence-test-secret");
        const client = Object.assign(new pg.Client(), { release: vi.fn() });
        const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", creatorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const references = { owner: ownerId, createdBy: creatorId.toUpperCase(), lastModifiedBy: "source-specific-person" };
        const raw = savedPage(0, 0);
        raw.freshness.sources[1].scope_id = "native-scope";
        raw.summary = { ...raw.summary, graphOnly: 0, powerPlatformOnly: 1 };
        raw.scopeSummary = { ...raw.summary };
        raw.filteredSummary = { ...raw.summary };
        raw.counts.packageTargets = 0;
        Object.assign(raw.verificationCounts, { packages: 0, checked_packages: 0, native_agents: 1 });
        Object.assign(raw.freshness.sources[0], { row_count: 0, expected_count: 0 });
        Object.assign(raw.freshness.sources[1], { row_count: 1, agent_count: 1, expected_count: 1 });
        const identity = { tenantId: "tenant", principalId: "reader", sessionEpoch: "1", authorizationHash: "viewer" };
        const source = (source: UserSourceMetadata["source"]): UserSourceMetadata => ({
          source, generationId: source === "directory" ? "directory-generation" : null,
          scopeId: null, revision: null, expiresAt, observedAt, attemptedAt: null, attemptStatus: null,
          attemptObservedCount: null, errorCode: null, message: null, rowCount: null, state: "available",
          reportRefreshDate: null, period: null, reportVersion: null,
        });
        const context: Parameters<InventoryQueries["pageInRead"]>[1] = {
          data: { identity, evaluatedAt: new Date(observedAt), query: {}, report: raw.reports, publicationRevisions: raw.selection.publicationRevisions,
            metadata: { directory: source("directory"), app_activity: source("app_activity") } },
          selectionId: "selection", expiresAt: Date.parse(expiresAt), scopeId: "scope", baselineId: "baseline",
          revision: "1", source: "inventory_canonical", tokenMode: "delegated", query: { sortBy: "owner", search: "J\u030c" },
        };
        const result = (rows: pg.QueryResultRow[]): pg.QueryResult => ({
          command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows,
        });
        vi.spyOn(client, "query").mockImplementation(async (text: unknown, values?: unknown) => {
          if (typeof text !== "string") throw new Error("Expected SQL.");
          if (text.startsWith("SELECT set_config")) return result([]);
          if (text.includes("candidates AS MATERIALIZED")) {
            expect(text).toContain("'warnings',f.residual->'identity'->'warnings'");
            expect(text).toContain('normalize(lower(normalize(p.label,NFKC) COLLATE "default"),NFKC) LIKE');
            expect(values).toContain("%\u01f0%");
            return result([{
            identity: "agent", native_id: "agent", domain: "canonical", display_name: "Agent",
            environment_id: null, presence: "power_platform", link_state: "unmatched",
            responses: null, active_users: null, last_activity: null, association_count: 0, columns: {},
            candidate_count: 1, bytes: 1000, members: [{
              domain: "power_platform", scope_id: "native-scope", native_id: "native", source_identity: "native", evidence: [],
              total: 1, identifiers: [], identifier_count: 0,
              generation_id: "native-record-generation", observed_at: "2026-09-20T12:00:00.000123Z", expires_at: expiresAt,
              residual: {
                tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
                displayName: "Agent", environmentId: null, location: null, createdAt: null,
                createdBy: creatorId, lastPublishedAt: null, sourceSystem: "power_platform",
                authoringTool: null, creatorType: "unknown", agentKind: "agent", lifecycle: "unknown",
                identityConfidence: "exact_native", identifiers: [], provenance: {}, unknownFieldCount: 0,
                details: { ownerId, lastModifiedBy: references.lastModifiedBy },
              } satisfies PowerPlatformResource,
            }],
          }]);
          }
          if (text.startsWith("SELECT m.identity,r.observed_at")) {
            return result([{ identity: "agent", observed_at: new Date(observedAt), people: references }]);
          }
          if (text.startsWith("SELECT requested.id")) {
            expect(values).toEqual(["tenant", "reader", "directory-generation", [ownerId, creatorId], new Date(observedAt), "delegated", true]);
            return result([{
              id: creatorId, directory_id: status === "legacy" ? creatorId : null,
              display_name: "Known creator", upn: "creator@example.invalid",
              status: status === "legacy" ? null : status, cached_name: status === "not_found" ? null : "Known creator",
              cached_upn: status === "not_found" ? null : "creator@example.invalid",
              checked_at: new Date(observedAt), resolved_at: null, expires_at: new Date(expiresAt),
            }]);
          }
          if (text.startsWith("WITH inputs AS")) return result([]);
          throw new Error("Unexpected inventory person query.");
        });
        const page = await queries.pageInRead(client, context, { revision: "1", expires_at: expiresAt, evaluated_at: observedAt, validated_at: observedAt },
          "selection", identity, { exportKind: "unified_agents" }, {
            counts: raw.counts, summary: raw.summary, scopeSummary: raw.scopeSummary, filteredSummary: raw.filteredSummary,
            inventoryOverview: raw.inventoryOverview, verificationCounts: raw.verificationCounts,
            freshness: raw.freshness, partial: raw.partial, reports: raw.reports,
          });
        const inventory = inventoryPresentation(page), presented = inventory.value[0];
        expect(presented.observations).toMatchObject({
          graphPackages: null, powerPlatform: { id: "native-record-generation", snapshotId: "native-record-generation",
            observedAt: "2026-09-20T12:00:00.000123Z" },
        });
        expect(presented.people?.owner).toBeUndefined();
        expect(presented.people?.lastModifiedBy).toBeUndefined();
        expect(presented.people?.createdBy).toMatchObject({
          objectId: creatorId, observedAt, displayName: status === "not_found" ? null : "Known creator",
          ...(status === "legacy" ? {} : { status, expiresAt }),
        });
        expect(presented.powerPlatformResource).toMatchObject({
          createdBy: creatorId, details: { ownerId, lastModifiedBy: references.lastModifiedBy },
        });
        expect([...unifiedAgentExportRows(inventory)][0]).toMatchObject({
          owner: ownerId, ownerObservedAt: undefined, ownerResolutionStatus: null,
          createdBy: creatorId, createdByResolutionStatus: status === "legacy" ? "resolved" : status,
          lastModifiedBy: references.lastModifiedBy, lastModifiedByResolutionStatus: null,
        });
        expect(JSON.parse([...unifiedAgentExportRows(inventory)][0].peopleEvidence).createdBy)
          .toMatchObject({ objectId: creatorId, observedAt, status: status === "legacy" ? "resolved" : status,
            ...(status === "legacy" ? {} : { expiresAt }) });
      } finally {
        await database.end();
      }
    },
  );
});

describe("saved inventory metadata verification", () => {
  it("pairs source observations with their selected generation rather than unrelated catalog timestamps", () => {
    const raw = savedPage(0, 0);
    Object.assign(raw.freshness.sources[0], {
      generation_id: "package-overlay", observed_at: "2026-09-20T12:00:00.000123Z",
      catalog_observed_at: "2026-09-19T12:00:00.000456Z", catalog_expires_at: "2026-09-21T12:00:00Z",
    });
    const presented = inventoryPresentation(raw);
    expect(presented.sources.graphPackages.observation).toMatchObject({
      id: "package-overlay", snapshotId: "package-overlay",
      observedAt: "2026-09-20T12:00:00.000123Z", expiresAt,
    });
    expect(presented.freshness.sources[0]).toMatchObject({
      catalog_observed_at: "2026-09-19T12:00:00.000456Z", catalog_expires_at: "2026-09-21T12:00:00Z",
    });
  });

  it("persists exact per-package evidence and exports every member with its own observation and child provenance", async () => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition."));
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped query."));
    try {
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const environmentId = "11111111-1111-1111-1111-111111111111", botId = "22222222-2222-2222-2222-222222222222";
      const appId = "33333333-3333-3333-3333-333333333333", graphAgentId = "44444444-4444-4444-4444-444444444444";
      const native: PowerPlatformResource = {
        tenantId: "tenant", nativeId: "native", environmentId, type: "microsoft.copilotstudio/agents",
        displayName: "Agent", location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
        sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent", lifecycle: "unknown",
        identityConfidence: "exact_native", provenance: {}, details: {}, unknownFieldCount: 0,
        identifiers: [{ kind: "cds_bot_id", value: botId }, { kind: "entra_app_id", value: appId },
          { kind: "entra_agent_id", value: "55555555-5555-5555-5555-555555555555" }],
      };
      const packageValues = ["a", "z"].map(id => ({ ...allowlistedPackage({
        id, displayName: id, publisher: `${id}-publisher`, isBlocked: false, supportedHosts: [], longDescription: "detail-only-description",
        elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: `${id}-metadata`,
          definition: JSON.stringify(id === "a"
            ? { SourceIds: { EnvironmentId: environmentId, CdsBotId: botId }, AgentIdentityId: graphAgentId }
            : { SourceIds: { EnvironmentId: environmentId, EntraApplicationId: appId } }) }] }],
      }), detailFreshness: { state: "fresh" as const, observedAt, expiresAt } }));
      const packageScope = randomUUID(), nativeScope = randomUUID();
      const catalogObservedAt = "2026-09-19T12:00:00.000Z", expiredCatalogAt = "2026-09-20T11:00:00.000Z";
      const rows = [...packageValues.map(packageInventoryRecord), powerPlatformInventoryRecord(native)].map((record, index) => ({
        ...record, domain: index < 2 ? "packages" : "power_platform", generation_id: randomUUID(),
        catalog_generation: randomUUID(), detail_generation: randomUUID(), scope_id: index < 2 ? packageScope : nativeScope,
        catalog_observed_at: new Date(catalogObservedAt), catalog_expires_at: new Date(index === 0 ? expiredCatalogAt : expiresAt),
        read_started_at: new Date(observedAt), observed_at: new Date(observedAt), expires_at: new Date(expiresAt),
        value: index < 2 ? packageValues[index] : native, bytes: 1024,
      }));
      const lease: GenerationLease = { id: randomUUID(), scopeId: randomUUID(), tenantId: "tenant", owner: "worker",
        version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
      let memberships: { canonical: string; scope: string; identity: string; generation: string; evidence: PackageAgentLinkEvidence[] }[] = [];
      const result = (rows: object[] = []): pg.QueryResult => ({ command: "", rows, rowCount: rows.length, fields: [], oid: 0 });
      vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
        if (String(statement).startsWith("INSERT INTO unified_agent_memberships")) {
          if (typeof values?.[3] !== "string") throw new Error("Missing serialized memberships.");
          memberships = JSON.parse(values[3]);
        }
        return result();
      });
      const reconciliation = new InventoryReconciliation(database);
      vi.spyOn(reconciliation.stages.generations.connections, "run").mockImplementation(async work => work(client));
      vi.spyOn(reconciliation.stages, "fence").mockResolvedValue({});
      const append = vi.spyOn(reconciliation.stages, "appendBounded").mockResolvedValue(undefined);
      await reconciliation["publishComponents"](lease, [{ rows, previous: [] }], new Date(observedAt));
      const projected = append.mock.calls[0][1][0];
      const evidenceFor = (identity: string) => memberships.find(member => member.identity === identity)!.evidence;
      expect(evidenceFor("a").map(value => value.kind)).toEqual(["environment_cds_bot_id"]);
      expect(evidenceFor("z").map(value => value.kind)).toEqual(["environment_entra_app_id"]);
      expect(evidenceFor(rows[2].identity)).toHaveLength(2);
      expect(projected.residual.identity).toMatchObject({ warnings: [{ code: "source_specific_agent_identity" }] });

      const raw = savedPage(1, 0);
      raw.summary = { total: 1, linked: 1, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
      raw.scopeSummary = { ...raw.summary };
      raw.filteredSummary = { ...raw.summary };
      Object.assign(raw.counts, { total: 1, scoped: 1, filtered: 1 });
      Object.assign(raw.verificationCounts, { native_agents: 1, represented: 3, unique_sources: 3 });
      raw.reports.setId = "usage-report";
      Object.assign(raw.freshness.sources[0], { scope_id: packageScope });
      Object.assign(raw.freshness.sources[1], { scope_id: nativeScope, row_count: 1, agent_count: 1, expected_count: 1 });
      raw.value.push({
        id: projected.identity, nativeId: projected.native_id, domain: "canonical", resourceType: null, residual: null,
        displayName: projected.display_name, environmentId: projected.environment_id,
        presence: projected.presence, linkState: projected.link_state, identity: projected.residual.identity,
        availability: projected.availability, management: projected.management, columns: {
          publisher: "aggregate publisher", source: "Graph and Power Platform", observedAt: Date.parse(observedAt),
          builtWith: "Aggregate authoring tools",
        }, people: {}, environment: null,
        responses: Number.MAX_SAFE_INTEGER, activeUsers: 0, lastActivity: null, associationCount: 1,
        members: [rows[0], rows[2]].map(row => ({
          ...row, residual: row.domain === "packages" ? { ...row.residual, supportedHosts: [] } : row.residual,
          total: row.domain === "packages" ? "2" : "1", source_identity: row.identity,
          source_channel: "catalog", evidence: evidenceFor(row.identity), identifiers: row.domain === "power_platform" ? native.identifiers : [],
          identifier_count: row.domain === "power_platform" ? native.identifiers.length : 0, connector_counts: null, quarantine_identity: null,
        })),
      });
      const presented = inventoryPresentation(raw).value[0];
      expect(presented.identity.evidence).toEqual(evidenceFor(rows[2].identity));
      expect(presented.identity.packageEvidence).toEqual([{ packageId: "a", evidence: evidenceFor("a") }]);
      expect(presented.identity).toMatchObject({ warnings: [{ code: "source_specific_agent_identity" }] });
      expect(presented.packages[0]).not.toHaveProperty("longDescription");
      expect(presented.packagesComplete).toBe(false);
      expect(presented.observations.powerPlatform?.snapshotId).toBe(rows[2].generation_id);
      expect(presented.observations.packageSnapshots.a).toMatchObject({
        snapshotId: rows[0].catalog_generation, observedAt: catalogObservedAt, expiresAt: expiredCatalogAt, current: false,
        identityDetails: { snapshotId: rows[0].detail_generation, observedAt, expiresAt, current: false },
      });
      const catalogTime = raw.value[0].members[0].catalog_observed_at;
      raw.value[0].members[0].catalog_observed_at = null;
      expect(() => inventoryPresentation(raw)).toThrow(expect.objectContaining({ code: "saved_source_invalid" }));
      raw.value[0].members[0].catalog_observed_at = catalogTime;

      const inventory = new InventoryQueries(database, "synthetic-component-provenance-cursor-secret");
      const identity = { tenantId: "tenant", principalId: "reader", sessionEpoch: "0", authorizationHash: "viewer" };
      const metadata = (source: UserSourceMetadata["source"]): UserSourceMetadata => ({
        source, generationId: null, scopeId: null, revision: null, expiresAt, observedAt, attemptedAt: null,
        attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
        state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null,
      });
      vi.spyOn(inventory, "contextInRead").mockResolvedValue({ context: {
        data: { identity, evaluatedAt: new Date(observedAt), query: {}, report: raw.reports,
          metadata: { directory: metadata("directory"), app_activity: metadata("app_activity") } },
        selectionId: "selection", expiresAt: Date.parse(expiresAt), scopeId: lease.scopeId, baselineId: lease.id,
        revision: "1", source: "inventory_canonical", tokenMode: "delegated", query: {},
      }, selection: {} });
      vi.spyOn(inventory, "pageInRead").mockResolvedValue(raw);
      const children = [
        { key: "0010000000004", member_index: 1, ordinal: 4, kind: "collection", value: "supportedHosts", payload: {} },
        { key: "0010000000005", member_index: 1, ordinal: 5, kind: "element", value: "AgentMetadatas:z-metadata",
          payload: { elementType: "AgentMetadatas", id: "z-metadata",
            definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentId, EntraApplicationId: appId },
              clientSecret: "synthetic-private-credential", callbackUrl: "https://private.invalid", nested: { accessToken: "private-token" } }) } },
        ...Array.from({ length: 300 }, (_, index) => ({ key: `001${String(index + 6).padStart(10, "0")}`,
          member_index: 1, ordinal: index + 6, kind: "element", value: "Bots:duplicate:id",
          payload: { elementType: "Bots", id: "duplicate:id", definition: JSON.stringify({ botId }) } })),
      ];
      const nativeChildren = [{ key: "0000000000004", member_index: 0, ordinal: 4, kind: "identifier",
        value: botId, payload: { kind: "cds_bot_id", value: botId } }];
      vi.spyOn(client, "query").mockImplementation(async (statement, values?: unknown[]) => {
        const sql = String(statement);
        if (sql.startsWith("SELECT domain FROM inventory_roots")) return result([{ domain: "canonical" }]);
        if (sql.includes("WITH candidates AS") && sql.includes("r.residual")) {
          expect(sql).toContain("SELECT source_generation_id,source_identity,evidence FROM unified_agent_memberships");
          expect(sql).toContain("r.scope_id,r.generation_id,r.catalog_generation");
          expect(sql).toContain("item.kind=collection.value");
          expect(sql).toContain("'supportedHosts','elementTypes'");
          expect(sql).toContain("f.kind LIKE 'column:%'");
          expect(sql).toContain("AS catalog_observed_at");
          expect(sql).toContain("AS catalog_expires_at");
          const selected = values?.[3] ? rows.slice(2) : rows.slice(0, 2);
          return result([{ value: selected.map(row => ({
            ...row, key: String(rows.indexOf(row)), parent_id: presented.id, source_channel: "catalog", evidence: evidenceFor(row.identity),
            residual: row.domain === "packages" ? { ...row.residual, supportedHosts: [] } : row.residual,
            identifier_count: row.domain === "power_platform" ? native.identifiers.length : null,
            columns: { publisher: row.domain === "packages" ? `${row.identity}-publisher` : null,
              builtWith: null, observedAt: Date.parse(observedAt), source: row.domain === "packages" ? "Graph packages" : "Power Platform" },
          })), more: !values?.[3], first_bytes: "1024" }]);
        }
        if (sql.includes("WITH candidates AS") && sql.includes("f.ordinal")) {
          const members = JSON.parse(String(values?.[0])) as unknown[];
          const remaining = (members.length === 1 ? nativeChildren : children).filter(child => child.ordinal > Number(values?.[2]));
          return result([{ value: remaining.slice(0, 250), more: remaining.length > 250, first_bytes: "100" }]);
        }
        if (sql.startsWith("SELECT set_config")) return result();
        throw new Error("Unexpected source-export query.");
      });
      const job: Parameters<ExportSource>[1] = { id: "export", selectionId: "selection", kind: "unified_agents", query: {}, mode: "all",
        selectedIds: async function* () {}, read: async work => work(client) };
      const exported: Record<string, unknown>[] = [];
      for await (const batch of inventoryExportSource(inventory, identity)(new AbortController().signal, job)) exported.push(...batch);
      const source = exported.find(row => row.recordType === "source" && row.sourceIdentity === "z")!;
      expect(source).toMatchObject({ parentAgentId: presented.id, sourceScopeId: packageScope,
        sourceGenerationId: rows[1].generation_id, displayName: "z", publisher: "z-publisher",
        builtWith: null, source: "Graph packages", memberCount: 1, packageCount: 1, packagesComplete: true,
        usageStatus: "not_applicable_to_source", responses: undefined, activeUsers: undefined, usageEvidence: null });
      expect(exported.find(row => row.recordType === "agent")).toMatchObject({
        memberCount: 3, packageCount: 2, packagesComplete: false, responses: Number.MAX_SAFE_INTEGER,
      });
      expect(JSON.parse(String(source.sourceEvidence))).toEqual(evidenceFor("z"));
      expect(JSON.parse(String(source.identityEvidence))).toEqual([{ packageId: "z", evidence: evidenceFor("z") }]);
      expect(JSON.parse(String(source.packageStates))[0]).toMatchObject({
        packageId: "z", snapshotId: rows[1].catalog_generation, observedAt: catalogObservedAt, supportedHosts: [],
        detailFreshness: { state: "fresh", observedAt, expiresAt },
        identityDetails: { snapshotId: rows[1].detail_generation, observedAt, expiresAt, current: true },
        provenance: packageValues[1].provenance,
      });
      const nativeSourceRow = exported.find(row => row.recordType === "source" && row.sourceDomain === "power_platform")!;
      expect(JSON.parse(String(nativeSourceRow.sourceEvidence))).toEqual(evidenceFor(rows[2].identity));
      expect(nativeSourceRow).toMatchObject({ displayName: "Agent", publisher: null, source: "Power Platform" });
      expect(JSON.parse(String(nativeSourceRow.powerPlatformState))).toMatchObject({
        savedSource: { scopeId: nativeScope, identity: rows[2].identity },
        observation: { id: rows[2].generation_id, snapshotId: rows[2].generation_id },
        identifiers: [], identifierCount: 3, identifiersComplete: false,
      });
      expect(exported.filter(row => row.recordType === "source").map(row => row.sourceIdentity))
        .toEqual(rows.map(row => row.identity));
      expect(exported.filter(row => row.recordType === "child").map(row => row.childOrdinal))
        .toEqual([...Array.from({ length: 302 }, (_, index) => index + 4), 4]);
      const element = exported.find(row => row.childKind === "element")!;
      expect(JSON.parse(String(element.childData))).toEqual({
        value: "AgentMetadatas:z-metadata", payload: {
          elementType: "AgentMetadatas", id: "z-metadata", definitionStatus: "identity_only",
          definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentId, EntraApplicationId: appId } }),
        },
      });
      expect(JSON.stringify(exported)).not.toMatch(/synthetic-private-credential|private.invalid|private-token|clientSecret|callbackUrl|accessToken/);
      expect(exported.find(row => row.recordType === "child")).toMatchObject({
        parentAgentId: presented.id, sourceIdentity: "z", sourceScopeId: packageScope,
        sourceGenerationId: rows[1].generation_id, childKind: "collection", childOrdinal: 4,
      });
      expect(exported.find(row => row.childKind === "identifier")).toMatchObject({
        parentAgentId: presented.id, sourceIdentity: rows[2].identity, sourceScopeId: nativeScope,
        sourceGenerationId: rows[2].generation_id, childOrdinal: 4,
      });
      expect(database.query).not.toHaveBeenCalled();
      expect(database.connect).not.toHaveBeenCalled();
    } finally { await database.end(); }
  });

  it("retains invalid matching metadata from identity resolution through saved projection and presentation", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const value = { ...allowlistedPackage({
      id: "invalid-package", displayName: "Invalid package", isBlocked: false,
      elementDetails: [{ elementType: "AgentMetadatas", elements: [
        { id: "metadata", definition: JSON.stringify({ SourceIds: { CdsBotId: "not-a-guid" } }) },
      ] }],
    }), identityDetailsCollected: true as const };
    const record = buildRecords([value], [], resolvePackageAgentLinks("", [value], []), null, null)[0];
    expect(record.identity.invalidMetadata).toBe(true);
    const projected = canonicalRecord("invalid-agent", record);
    expect(projected.residual.identity).toMatchObject({ invalidMetadata: true });

    const raw = savedPage(0, 1);
    raw.value.push({
      id: projected.identity, nativeId: projected.native_id, domain: "canonical", resourceType: null, residual: null,
      displayName: projected.display_name, environmentId: projected.environment_id,
      presence: projected.presence, linkState: projected.link_state, identity: projected.residual.identity,
      availability: projected.availability, management: projected.management,
      responses: null, activeUsers: null, lastActivity: null, associationCount: 0, columns: {}, members: [{
        ...packageInventoryRecord(value), domain: "packages", scope_id: "package-scope", source_identity: value.id,
        generation_id: "packages", observed_at: observedAt, expires_at: expiresAt, total: 1, evidence: [],
      }],
      environment: null, people: {},
    });
    const inventory = inventoryPresentation(raw);
    expect(inventory.value[0].identity).toMatchObject({ invalidMetadata: true, state: "unmatched" });
    expect(inventory.verification).toMatchObject({ status: "needs_attention", checks: { packageMetadata: false } });
    expect(inventoryAttentionReasons(inventory)).toEqual([
      "1 package with invalid matching metadata. Use diagnostics to refresh matching details for the affected packages.",
    ]);
  });

  it.each([0, 1])("never certifies invalid metadata when %s other details are pending or filtered out", pending => {
    const raw = savedPage(pending, 1);
    raw.counts.filtered = 0;
    raw.filteredSummary = { ...raw.filteredSummary, total: 0, graphOnly: 0 };
    const inventory = inventoryPresentation(raw);
    expect(inventory.identityCollection).toMatchObject({ checkedPackages: 1, pendingPackages: pending, invalidPackages: 1 });
    expect(inventory.verification).toMatchObject({ status: "needs_attention", checks: { packageMetadata: false } });
    expect(inventoryDetailsPending(inventory)).toBe(pending > 0);
    expect(inventoryAttentionReasons(inventory)).toHaveLength(1);
    expect(inventoryAttentionReasons(inventory)[0]).toContain("1 package with invalid matching metadata");
  });

  it("replaces invalid evidence with pending or verified metadata without retaining previous reasons", () => {
    const invalid = inventoryPresentation(savedPage(0, 1));
    const pending = inventoryPresentation(savedPage(1, 0));
    const verified = inventoryPresentation(savedPage(0, 0));
    expect(inventoryAttentionReasons(invalid)).toHaveLength(1);
    expect(pending.verification.status).toBe("details_pending");
    expect(inventoryDetailsPending(pending)).toBe(true);
    expect(inventoryAttentionReasons(pending)).toEqual([]);
    expect(verified.verification.status).toBe("verified");
    expect(inventoryDetailsPending(verified)).toBe(false);
    expect(inventoryAttentionReasons(verified)).toEqual([]);
  });
});

describe("saved inventory exact export selection", () => {
  function fixture() {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition."));
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
    const inventory = new InventoryQueries(database, "synthetic-explicit-export-selection-secret");
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const identity = { tenantId: "tenant", principalId: "reader", sessionEpoch: "1", authorizationHash: "viewer" };
    const raw = savedPage(0, 0);
    const metadata = (source: UserSourceMetadata["source"]): UserSourceMetadata => ({
      source, generationId: null, scopeId: null, revision: null, expiresAt, observedAt, attemptedAt: null,
      attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
      state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null,
    });
    const context: Parameters<InventoryQueries["pageInRead"]>[1] = {
      data: { identity, evaluatedAt: new Date(observedAt), query: {}, report: raw.reports,
        metadata: { directory: metadata("directory"), app_activity: metadata("app_activity") } },
      selectionId: "selection", expiresAt: Date.parse(expiresAt), scopeId: "scope", baselineId: "baseline",
      revision: "7", source: "inventory_canonical", tokenMode: "delegated", query: { search: "off-filter" },
    };
    const result = (rows: object[] = []): pg.QueryResult => ({ command: "", rows, rowCount: rows.length, fields: [], oid: 0 });
    return { database, inventory, client, identity, context, raw, result };
  }

  it("counts captured memberships independently of freshness while exposing source-accounting gaps", async () => {
    const { database, inventory, client, context, raw, result } = fixture();
    try {
      Object.assign(raw.freshness.sources[0], { row_count: 2, expected_count: 2 });
      const query = vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
        const sql = String(statement);
        if (sql.startsWith("SELECT set_config")) return result();
        if (sql.includes("summary_facts AS MATERIALIZED")) return result([{
          summary: raw.summary, scopeSummary: raw.scopeSummary, filteredSummary: raw.filteredSummary,
          inventoryOverview: raw.inventoryOverview, mutationTargets: { packages: 1 },
        }]);
        if (sql.startsWith("SELECT r.baseline_id")) return result([{ baseline_id: context.baselineId, revision: context.revision, status: "idle" }]);
        if (sql.startsWith("WITH roots AS")) return result(raw.freshness.sources);
        if (sql.startsWith("SELECT EXISTS")) return result([{ expired: false }]);
        if (sql.startsWith("SELECT count(*) FILTER(WHERE r.domain='packages')")) {
          expect(sql).not.toContain("c.expires_at");
          expect(sql).toContain("m.baseline_id=$1");
          expect(sql).toContain("m.valid_from_revision<=$2");
          expect(sql).toContain("(r.residual->'detailFreshness'->>'expiresAt')::timestamptz>$3");
          expect(values).toEqual([context.baselineId, context.revision, new Date(observedAt)]);
          return result([raw.verificationCounts]);
        }
        throw new Error("Unexpected saved accounting query.");
      });
      const summary = await inventory["summaries"](client, context);
      expect(inventoryPresentation({ ...raw, ...summary }).verification).toMatchObject({
        status: "needs_attention", graphPackageCount: 1, checks: { sourceMemberships: false },
      });
      expect(query).toHaveBeenCalled();
      expect(database.connect).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
    } finally { await database.end(); }
  });

  it("preserves raw source-qualified export inputs while matching only validated keys and exact memberships", async () => {
    const { inventory, client, context, result } = fixture();
    const guid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const references = [`graph_packages:${guid}`, `power_platform:Environment-A:${guid}`, `power_platform:Default-${guid}:${guid}`];
    const query = vi.spyOn(client, "query").mockImplementation(async () =>
      result(references.map((_reference, ordinal) => ({ ordinal, id: `canonical-${ordinal}`, count: 1, source_count: 1 }))));
    await expect(inventory.resolveExportReferencesInRead(client, context, references, "unified_agents"))
      .resolves.toEqual(references.map((_reference, ordinal) => `agent:canonical-${ordinal}`));
    const [statement, values] = query.mock.calls[0];
    expect(JSON.parse(String((values as unknown[]).at(-1)))).toEqual([
      { ordinal: 0, source: "graph_packages", native: guid, environment: "" },
      { ordinal: 1, source: "power_platform", native: guid, environment: "Environment-A" },
      { ordinal: 2, source: "power_platform", native: guid, environment: `Default-${guid}` },
    ]);
    expect(statement).toContain("r.source='graph_packages' AND s.native_id=r.native");
    expect(statement).toContain(`coalesce(${normalizeEnvironmentIdentitySql("s.environment_id")},'')=${normalizeEnvironmentIdentitySql("r.environment")}`);
    expect(statement).toContain(`(${normalizeNativeIdentitySql("s.native_id")})=(${normalizeNativeIdentitySql("r.native")})`);
    expect(statement).toContain("r.generation_id=s.source_generation_id AND r.identity=s.source_identity");
    expect(statement).toContain("count(DISTINCT (s.generation_id,s.identity))");
  });

  it.each([
    { environmentId: "Environment-A", key: "Environment-A" },
    { environmentId: "Default-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", key: "default-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { environmentId: "Default-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA ", key: "Default-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA " },
  ])("uses the same exact environment keys for saved page filters, source references, usage, and labels: $environmentId", async ({ environmentId, key }) => {
    const { inventory, client, context, identity, raw, result } = fixture();
    const nativeId = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    context.query = { environmentId, recordId: `power_platform:${encodeURIComponent(environmentId)}:${nativeId}` };
    const query = vi.spyOn(client, "query").mockImplementation(async () => result());
    const page = await inventory.pageInRead(client, context,
      { revision: context.revision, expires_at: expiresAt, evaluated_at: observedAt }, "selection", identity,
      { exportKind: "unified_agents" }, {
        counts: raw.counts, summary: raw.summary, scopeSummary: raw.scopeSummary, filteredSummary: raw.filteredSummary,
        inventoryOverview: raw.inventoryOverview, verificationCounts: raw.verificationCounts,
        freshness: raw.freshness, partial: raw.partial, reports: raw.reports,
      });
    expect(page.value).toEqual([]);
    const [statement, parameters] = query.mock.calls.find(([statement]) => String(statement).includes("candidates AS MATERIALIZED"))!;
    const values = parameters as unknown[];
    expect(values.filter(value => value === key)).toHaveLength(2);
    expect(statement).toContain(`${normalizeEnvironmentIdentitySql("f.environment_id")}=$${values.indexOf(key) + 1}`);
    expect(statement).toContain(`${normalizeNativeIdentitySql("s.native_id")}=${normalizeNativeIdentitySql(`$${values.indexOf(nativeId) + 1}`)}`);
    expect(statement).toContain(`reviewed.normalized_environment_id=CASE WHEN s.source='graph_packages' THEN '' ELSE coalesce(${normalizeEnvironmentIdentitySql("s.environment_id")},'') END`);
    expect(statement).toContain(`environments.environment_id=${normalizeEnvironmentIdentitySql("i.environment_id")}`);
  });

  it.each(["graph_packages", "power_platform_agents", "unified_agents"] as const)(
    "rejects missing and ambiguous explicit sources for %s rather than publishing a partial selection", async kind => {
      const { inventory, client, context, result } = fixture();
      const query = vi.spyOn(client, "query");
      const reference = kind === "unified_agents" ? "graph_packages:exact" : "exact";
      for (const sourceCount of [0, 2]) {
        query.mockImplementationOnce(async () => result([{ ordinal: 0, id: sourceCount ? "canonical" : null,
          count: sourceCount ? 1 : 0, source_count: sourceCount }]));
        await expect(inventory.resolveExportReferencesInRead(client, context, [reference], kind))
          .rejects.toMatchObject({ code: "export_selection_changed" });
      }
    },
  );

  it.each(["graph_packages", "power_platform_agents"] as const)("preserves exact %s IDs in bounded batches, independently of matching filters", async kind => {
    const { inventory, client, context, result } = fixture();
    const ids = Array.from({ length: 101 }, (_, index) => `Exact/Source:${index}`);
    const batches: string[][] = [];
    vi.spyOn(client, "query").mockImplementation(async (_statement, values?: unknown[]) => {
      const requested = JSON.parse(String(values?.at(-1))) as Array<{ ordinal: number; native: string; environment: unknown }>;
      expect(requested.every(row => row.environment === null)).toBe(true);
      expect(values).toContain(context.baselineId);
      expect(values).toContain(context.revision);
      batches.push(requested.map(row => row.native));
      return result(requested.map(row => ({ ordinal: row.ordinal, id: `parent-${row.ordinal}`, count: 1, source_count: 1 })));
    });
    expect(await inventory.resolveExportReferencesInRead(client, context, ids, kind)).toEqual(ids);
    expect(batches.map(batch => batch.length)).toEqual([100, 1]);
    expect(batches.flat()).toEqual(ids);
  });

  it("allows an explicit canonical agent's distinct members while rejecting a source reference that names multiple members", async () => {
    const { inventory, client, context, result } = fixture();
    const canonical = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(client, "query").mockImplementation(async () => result([{ ordinal: 0, id: canonical, count: 1, source_count: 2 }]));
    expect(await inventory.resolveExportReferencesInRead(client, context, [`agent:${canonical}`], "unified_agents")).toEqual([`agent:${canonical}`]);
    await expect(inventory.resolveExportReferencesInRead(client, context, ["graph_packages:exact"], "unified_agents"))
      .rejects.toMatchObject({ code: "export_selection_changed" });
  });

  it.each(["graph_packages", "power_platform_agents"] as const)("validates %s explicit IDs before durable admission", async kind => {
    const { database, client, identity, context, result } = fixture();
    const producer = new OfficialReportExports(new LargeTenantUsersReports(database, "synthetic-explicit-export-selection-secret", 7),
      { tenantId: identity.tenantId, homeAccountId: identity.principalId, username: "reader@example.invalid", displayName: "Reader" });
    vi.spyOn(producer.engine.connections, "selectedRead").mockImplementation(async work => work(client));
    vi.spyOn(producer.inventory, "contextInRead").mockResolvedValue({ context,
      selection: { endpoint: "inventory", query_hash: "a".repeat(64) } });
    vi.spyOn(client, "query").mockImplementation(async (statement: unknown) => {
      if (String(statement).startsWith("SELECT source FROM data_scope_epochs")) return result([{ source: context.source }]);
      if (String(statement).startsWith("SELECT 1 FROM data_generation_pins")) return result([{}]);
      throw new Error("Unexpected admission query.");
    });
    const resolve = vi.spyOn(producer.inventory, "resolveExportReferences").mockRejectedValue(
      new AppError(409, "export_selection_changed", "The exact source is ambiguous."));
    const create = vi.spyOn(producer.engine, "create").mockRejectedValue(new Error("Must not admit."));
    const selectionId = "11111111-1111-4111-8111-111111111111";
    await expect(producer.create(identity, { selectionId, kind, ids: ["exact"] })).rejects.toMatchObject({ code: "export_selection_changed" });
    expect(resolve).toHaveBeenCalledWith(selectionId, identity, ["exact"], kind);
    expect(create).not.toHaveBeenCalled();
  });

  it("retains the original source selection while admission validation awaits", async () => {
    const { database, client, identity, context, result } = fixture();
    const producer = new OfficialReportExports(new LargeTenantUsersReports(database, "synthetic-explicit-export-selection-secret", 7),
      { tenantId: identity.tenantId, homeAccountId: identity.principalId, username: "reader@example.invalid", displayName: "Reader" });
    const selectionId = "11111111-1111-4111-8111-111111111111", ids = ["original-source"];
    const input: Parameters<OfficialReportExports["create"]>[1] = { selectionId, kind: "graph_packages", ids };
    vi.spyOn(producer.engine.connections, "selectedRead").mockImplementation(async work => work(client));
    vi.spyOn(producer.inventory, "contextInRead").mockImplementation(async () => {
      ids[0] = "changed-source";
      input.selectionId = "22222222-2222-4222-8222-222222222222";
      input.kind = "power_platform_agents";
      return { context, selection: { endpoint: "inventory", query_hash: "a".repeat(64) } };
    });
    vi.spyOn(client, "query").mockImplementation(async (statement: unknown) => {
      if (String(statement).startsWith("SELECT source FROM data_scope_epochs")) return result([{ source: context.source }]);
      if (String(statement).startsWith("SELECT 1 FROM data_generation_pins")) return result([{}]);
      throw new Error("Unexpected admission query.");
    });
    const resolve = vi.spyOn(producer.inventory, "resolveExportReferences").mockResolvedValue(["original-source"]);
    const create = vi.spyOn(producer.engine, "create").mockResolvedValue("artifact");
    await expect(producer.create(identity, input)).resolves.toBe("artifact");
    expect(resolve).toHaveBeenCalledWith(selectionId, identity, ["original-source"], "graph_packages");
    expect(create).toHaveBeenCalledWith(identity, expect.objectContaining({
      selectionId, kind: "graph_packages", ids: ["original-source"], filename: "graph-packages.csv",
    }), undefined);
  });

  it.each(["graph_packages", "power_platform_agents", "unified_agents"] as const)("revalidates %s items inside the build read before producing any rows", async kind => {
    const { inventory, client, identity, context, result } = fixture();
    vi.spyOn(inventory, "contextInRead").mockResolvedValue({ context, selection: {} });
    const page = vi.spyOn(inventory, "pageInRead").mockRejectedValue(new Error("Must reject before paging."));
    let itemsRead = false;
    vi.spyOn(client, "query").mockImplementation(async (statement: unknown) => {
      const sql = String(statement);
      if (sql.startsWith("SELECT set_config")) return result();
      if (sql.startsWith("SELECT domain FROM inventory_roots")) return result([{ domain: "canonical" }]);
      if (sql.startsWith("SELECT ordinal,identity FROM data_export_items")) {
        itemsRead = true;
        return result([{ ordinal: 0, identity: kind === "unified_agents" ? "agent:11111111-1111-4111-8111-111111111111" : "missing" }]);
      }
      if (sql.includes("AS source_count")) return result([{ ordinal: 0, id: null, count: 0, source_count: 0 }]);
      throw new Error("Unexpected export source query.");
    });
    const job: Parameters<ExportSource>[1] = { id: "export", selectionId: "selection", kind, query: {}, mode: "explicit",
      selectedIds: async function* () {}, read: async work => work(client) };
    await expect(inventoryExportSource(inventory, identity)(new AbortController().signal, job)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "export_selection_changed" });
    expect(itemsRead).toBe(true);
    expect(page).not.toHaveBeenCalled();
  });

  it("rejects a report kind at the inventory producer boundary without reading the selection", async () => {
    const { inventory, identity } = fixture();
    const read = vi.fn(async () => { throw new Error("Must reject before reading."); });
    const job: Parameters<ExportSource>[1] = { id: "export", selectionId: "selection", kind: "official_users", query: {}, mode: "all",
      selectedIds: async function* () {}, read };
    await expect(inventoryExportSource(inventory, identity)(new AbortController().signal, job)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "export_selection_kind" });
    expect(read).not.toHaveBeenCalled();
  });

  it("does not start exact-reference resolution after its item read is cancelled", async () => {
    const { inventory, client, identity, context, result } = fixture();
    const controller = new AbortController(), cancelled = new Error("cancelled explicit preflight");
    vi.spyOn(inventory, "contextInRead").mockResolvedValue({ context, selection: {} });
    const resolve = vi.spyOn(inventory, "resolveExportReferencesInRead").mockResolvedValue(["package"]);
    vi.spyOn(client, "query").mockImplementation(async (statement: unknown) => {
      const sql = String(statement);
      if (sql.startsWith("SELECT set_config")) return result();
      if (sql.startsWith("SELECT domain FROM inventory_roots")) return result([{ domain: "canonical" }]);
      if (sql.startsWith("SELECT ordinal,identity FROM data_export_items")) {
        controller.abort(cancelled);
        return result([{ ordinal: 0, identity: "package" }]);
      }
      throw new Error("Unexpected cancelled preflight query.");
    });
    const job: Parameters<ExportSource>[1] = { id: "export", selectionId: "selection", kind: "graph_packages", query: {}, mode: "explicit",
      selectedIds: async function* () {}, read: async work => work(client) };
    await expect(inventoryExportSource(inventory, identity)(controller.signal, job)[Symbol.asyncIterator]().next()).rejects.toBe(cancelled);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["page", "members", "yield"] as const)(
    "stops source production when cancellation occurs during %s", async phase => {
      const { inventory, client, identity, context, result } = fixture();
      const raw = savedPage(0, 0);
      const controller = new AbortController(), cancelled = new Error("cancelled inventory export");
      const record = packageInventoryRecord(allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false }));
      const parentId = randomUUID(), scopeId = randomUUID();
      raw.value.push({
        id: parentId, nativeId: parentId, domain: "canonical", resourceType: null, residual: null,
        displayName: "Canonical agent", environmentId: null, presence: "graph_packages", linkState: "unmatched",
        availability: "unknown", management: "unknown", identity: { state: "unmatched", reason: null },
        responses: null, activeUsers: null, lastActivity: null, associationCount: 0, columns: {},
        members: [], environment: null, people: {},
      });
      const members = Array.from({ length: 101 }, (_, index) => ({
        ...record, identity: `package-${index}`, native_id: `package-${index}`,
        residual: { ...record.residual, id: `package-${index}` }, key: String(index).padStart(3, "0"),
        parent_id: `agent:${parentId}`, domain: "packages", generation_id: randomUUID(), scope_id: scopeId,
        observed_at: observedAt, expires_at: expiresAt, catalog_generation: null, detail_generation: null,
        catalog_observed_at: observedAt, catalog_expires_at: expiresAt, source_channel: "catalog",
        evidence: [], columns: {}, identifier_count: null, connector_counts: null,
      }));
      raw.value[0].members = [{ ...members[0], source_identity: members[0].identity, total: "101" }];
      Object.assign(raw.freshness.sources[0], { scope_id: scopeId, row_count: 101, expected_count: 101 });
      Object.assign(raw.verificationCounts, { packages: 101, represented: 101, unique_sources: 101 });
      raw.counts.packageTargets = 101;
      vi.spyOn(inventory, "contextInRead").mockResolvedValue({ context, selection: {} });
      vi.spyOn(inventory, "pageInRead").mockImplementation(async () => {
        if (phase === "page") controller.abort(cancelled);
        return raw;
      });
      const childRead = vi.fn();
      vi.spyOn(client, "query").mockImplementation(async (statement: unknown) => {
        const sql = String(statement);
        if (sql.startsWith("SELECT set_config")) return result();
        if (sql.startsWith("SELECT domain FROM inventory_roots")) return result([{ domain: "canonical" }]);
        if (sql.includes("WITH candidates AS") && sql.includes("r.residual")) {
          if (phase === "members") controller.abort(cancelled);
          return result([{ value: members, more: false, first_bytes: "1024" }]);
        }
        if (sql.includes("WITH candidates AS") && sql.includes("f.ordinal")) {
          childRead();
          return result([{ value: [], more: false, first_bytes: null }]);
        }
        throw new Error("Unexpected cancellation query.");
      });
      const job: Parameters<ExportSource>[1] = { id: "export", selectionId: "selection", kind: "graph_packages", query: {}, mode: "all",
        selectedIds: async function* () {}, read: async work => work(client) };
      const iterator = inventoryExportSource(inventory, identity)(controller.signal, job)[Symbol.asyncIterator]();
      if (phase === "yield") {
        expect((await iterator.next()).value).toHaveLength(100);
        controller.abort(cancelled);
      }
      await expect(iterator.next()).rejects.toBe(cancelled);
      if (phase === "page" || phase === "members") expect(childRead).not.toHaveBeenCalled();
    },
  );
});

describe("frontend inventory verification fixture contract", () => {
  it("binds selection metadata and source verification to the same evidence as backend presentation", () => {
    const raw = savedPage(0, 0);
    raw.selection = { ...raw.selection, id: "30000000-0000-4000-8000-000000000003", revision: "7" };
    raw.reports.staleAfterDays = 7;
    const presented = inventoryPresentation(raw);
    const fixture = inventoryPageMetadata(raw.counts, presented.selection.expiresAt, presented.selection);
    expect(fixture.selection).toEqual(presented.selection);
    expect(fixture.usageContext).toEqual(presented.usageContext);
    expect(fixture.freshness.capturedRevision).toBe(presented.selection.revision);
    expect(presented.sources.powerPlatform.observation).toMatchObject({
      verification: createInventoryVerification(0, ["microsoft.copilotstudio/agents"], observedAt),
    });
  });

  it.each([
    { state: "verified", checked: 2, stale: 0, invalidated: 0, invalid: 0, partial: false, conflict: false, expected: "verified" },
    { state: "missing", checked: 1, stale: 0, invalidated: 0, invalid: 0, partial: false, conflict: false, expected: "details_pending" },
    { state: "stale", checked: 1, stale: 1, invalidated: 0, invalid: 0, partial: false, conflict: false, expected: "details_pending" },
    { state: "invalidated", checked: 1, stale: 0, invalidated: 1, invalid: 0, partial: false, conflict: false, expected: "details_pending" },
    { state: "invalid metadata", checked: 2, stale: 0, invalidated: 0, invalid: 1, partial: false, conflict: false, expected: "needs_attention" },
    { state: "invalid and pending", checked: 1, stale: 1, invalidated: 0, invalid: 1, partial: false, conflict: false, expected: "needs_attention" },
    { state: "partial and pending", checked: 1, stale: 0, invalidated: 0, invalid: 0, partial: true, conflict: false, expected: "needs_attention" },
    { state: "conflicting and pending", checked: 1, stale: 0, invalidated: 0, invalid: 0, partial: false, conflict: true, expected: "needs_attention" },
  ])("matches backend and attention presentation for $state even with an empty filtered page", scenario => {
    const raw = savedPage(1, scenario.invalid);
    Object.assign(raw.verificationCounts, {
      native_agents: 1, represented: 3, unique_sources: 3, checked_packages: scenario.checked,
      stale_packages: scenario.stale, invalidated_packages: scenario.invalidated,
    });
    Object.assign(raw.freshness.sources[1], { row_count: 1, agent_count: 1, expected_count: 1 });
    raw.summary = { ...raw.summary, linked: scenario.conflict ? 0 : 1, graphOnly: 1,
      powerPlatformOnly: scenario.conflict ? 1 : 0, conflicting: scenario.conflict ? 1 : 0 };
    raw.scopeSummary = { ...raw.summary };
    raw.counts.filtered = 0;
    raw.counts.packageTargets = 0;
    raw.filteredSummary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
    if (scenario.partial) raw.partial = true;
    const presented = inventoryPresentation(raw);
    const fixture = createUnifiedVerification(
      { graphPackageCount: 2, powerPlatformAgentCount: 1, logicalAgentCount: 2 },
      { sourceScopes: !scenario.partial, identityLinks: !scenario.conflict },
      presented.selection.evaluatedAt, presented.identityCollection,
    );
    expect(fixture).toEqual(presented.verification);
    expect(fixture.status).toBe(scenario.expected);
    const page = { ...presented, verification: fixture };
    expect(inventoryDetailsPending(page)).toBe(scenario.checked < 2);
    expect(inventoryAttentionReasons(page).length > 0).toBe(scenario.expected === "needs_attention");
    expect(fixture.representedSourceCount).toBe(3);
    expect(fixture.logicalAgentCount).toBe(2);
  });
});
