import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryAttentionReasons, inventoryDetailsPending } from "../../../frontend/src/inventoryVerification.js";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "../../../frontend/src/test/inventoryVerification.js";
import { buildRecords } from "./inventoryComponent.js";
import { inventoryPresentation } from "./inventoryPresentation.js";
import { unifiedAgentExportRows } from "./inventoryCsv.js";
import { canonicalRecord } from "./inventoryRecordProjection.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { allowlistedPackage } from "./packageObservation.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";

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
        observed_at: observedAt, expires_at: expiresAt, catalog_complete: true, row_count: packages },
      { source: "inventory_power_platform", generation_id: "native", current: true, role_scope: "unknown",
        observed_at: observedAt, expires_at: expiresAt, catalog_complete: true, row_count: 0, agent_count: 0,
        resource_types: ["microsoft.copilotstudio/agents"], environment_id: null, page_count: 1 },
    ] },
    verificationCounts: { packages, native_agents: 0, represented: packages, unique_sources: packages,
      checked_packages: 1, stale_packages: 0, invalidated_packages: 0, invalid_packages: invalidPackages },
    partial: false,
  };
}

afterEach(() => vi.restoreAllMocks());

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
        const references = { owner: ownerId, createdBy: creatorId, lastModifiedBy: "source-specific-person" };
        const raw = savedPage(0, 0);
        raw.freshness.sources[1].scope_id = "native-scope";
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
          revision: "1", source: "inventory_canonical", tokenMode: "delegated", query: { sortBy: "owner" },
        };
        const result = (rows: pg.QueryResultRow[]): pg.QueryResult => ({
          command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows,
        });
        vi.spyOn(client, "query").mockImplementation(async (text: unknown, values?: unknown) => {
          if (typeof text !== "string") throw new Error("Expected SQL.");
          if (text.startsWith("SELECT set_config")) return result([]);
          if (text.includes("candidates AS MATERIALIZED")) return result([{
            identity: "agent", native_id: "agent", domain: "canonical", display_name: "Agent",
            environment_id: null, presence: "power_platform", link_state: "unmatched",
            responses: null, active_users: null, last_activity: null, association_count: 0, columns: {},
            candidate_count: 1, bytes: 1000, members: [{
              domain: "power_platform", scope_id: "native-scope", total: 1, identifiers: [], identifier_count: 0,
              observed_at: observedAt, expires_at: expiresAt,
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
      } finally {
        await database.end();
      }
    },
  );
});

describe("saved inventory metadata verification", () => {
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
      responses: null, activeUsers: null, lastActivity: null, associationCount: 0, columns: {}, members: [],
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
    Object.assign(raw.freshness.sources[1], { row_count: 1, agent_count: 1 });
    raw.summary = { ...raw.summary, linked: scenario.conflict ? 0 : 1, graphOnly: 1, conflicting: scenario.conflict ? 1 : 0 };
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
