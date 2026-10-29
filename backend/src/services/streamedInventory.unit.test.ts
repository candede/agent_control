import pg from "pg";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { BeginGeneration, GenerationLease } from "../db/dataGenerations.js";
import { buildCopilotAgentsListUrl, GraphPackagesClient } from "./graphPackages.js";
import { StreamedInventory } from "./streamedInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { packageInventoryRecord, restoreInventoryRecord } from "./inventoryRecordProjection.js";
import { projectPackageControl } from "./packageControlProjection.js";
import { publishPackageReadback } from "../db/packageControls.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { inventorySelector } from "../db/inventoryGenerations.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture() {
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const fetcher = vi.fn(async () => Response.json({ value: [] }));
  const stream = new StreamedInventory(database, new GraphPackagesClient(fetcher, { baseDelayMs: 0, delay: async () => undefined }));
  const input: BeginGeneration = {
    scope: { kind: "principal", tenantId: "tenant", principalId: "principal", tokenMode: "delegated",
      source: "inventory_packages", selector: "complete" },
    schemaVersion: 1, sessionEpoch: "0", jobId: "job", jobKind: "fixture",
    observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    deadlineAt: new Date(Date.now() + 60_000), reserveBytes: 1024,
  };
  const lease: GenerationLease = { id: "generation", scopeId: "scope", tenantId: "tenant", owner: "owner",
    version: 1, epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1 };
  const controller = new AbortController(), signal = controller.signal;
  vi.spyOn(stream.stages.generations, "execute").mockImplementation(async (_input, work) => work(lease, signal));
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query").mockImplementation(async statement => ({
    command: "", oid: 0, fields: [], rowCount: 0,
    rows: String(statement).startsWith("SELECT * FROM inventory_attempts") ? [{ membership_prepared: true, mode: "baseline" }] : [],
  }));
  vi.spyOn(stream.stages.generations.connections, "run").mockImplementation(async work => work(client));
  const fence = vi.spyOn(stream.stages, "fence").mockResolvedValue({ state: "staging" });
  vi.spyOn(stream.stages, "visit").mockResolvedValue(undefined);
  vi.spyOn(stream.stages, "acceptPage").mockResolvedValue(undefined);
  vi.spyOn(stream.stages, "validate").mockResolvedValue(undefined);
  return { stream, fetcher, input, controller, signal, fence, client, lease, query };
}

function collectionFixture() {
  const f = fixture();
  vi.spyOn(f.stream.stages, "execute").mockImplementation(async (_input, _intent, work) => {
    await work(f.lease, f.signal);
    return { scopeId: f.lease.scopeId, tenantId: f.lease.tenantId, baselineId: f.lease.id,
      revision: "1", epoch: "0", inserted: 1, closed: 0, changed: 1 };
  });
  return f;
}

function savedPackageFixture(value: Parameters<typeof packageInventoryRecord>[0], options: {
  readStartedAt?: Date; detailGeneration?: string | null; observedAt?: Date; expiresAt?: Date;
} = {}) {
  const f = fixture(), observedAt = new Date("2026-09-24T10:00:00Z");
  vi.useFakeTimers();
  vi.setSystemTime(observedAt);
  const previous = packageInventoryRecord(value);
  f.fence.mockResolvedValue({ state: "staging", observed_at: observedAt });
  f.query.mockImplementation(async (statement, parameters) => {
    const sql = String(statement);
    const rows = sql.startsWith("SELECT * FROM inventory_attempts") ? [{ baseline_id: "baseline", base_revision: "1" }]
      : sql.startsWith("SELECT m.identity,m.generation_id") ? [{ identity: value.id, generation_id: "previous" }]
        : sql.startsWith("SELECT principal_id,token_mode") ? [{ principal_id: "principal", token_mode: "application" }]
          : sql.includes("JOIN inventory_records r") ? [{
            identity: value.id, generation_id: "previous", domain: "packages", residual: previous.residual,
            read_started_at: options.readStartedAt ?? new Date("2026-09-24T09:00:00Z"),
            observed_at: options.observedAt, expires_at: options.expiresAt, catalog_generation: "catalog",
            detail_generation: options.detailGeneration === undefined ? "detail" : options.detailGeneration,
          }]
            : sql.includes("SELECT f.generation_id") && parameters?.[1] === null
              ? previous.facts.filter(fact => ["supportedHosts", "elementTypes", "elementGroup", "element"].includes(fact.kind)
                || fact.kind === "collection" && ["supportedHosts", "elementTypes", "elementDetails"].includes(fact.value))
                .map((fact, ordinal) => ({ ...fact, ordinal, identity: value.id, generation_id: "previous" })) : [];
    return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
  });
  const append = vi.spyOn(f.stream.stages, "appendBounded").mockResolvedValue(undefined);
  return { ...f, previous, append };
}

describe("package stream request and publication fencing without a database", () => {
  it("keeps missing-detail identity conflicts through catalog refreshes until an authoritative exact reread", async () => {
    const catalog = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, version: "1", lastModifiedDateTime: "2026-09-24T08:00:00Z",
      manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", elementTypes: ["DeclarativeCopilots"],
    });
    const f = savedPackageFixture({ ...catalog, identityRevalidationRequired: true,
      detailFreshness: { state: "missing", observedAt: null, expiresAt: null } });
    await f.stream.packageObservation(f.lease, catalog, "catalog");
    const record = f.append.mock.calls[0][1][0];
    expect(record.detail_generation).toBeNull();
    expect(record.residual).toMatchObject({
      identityRevalidationRequired: true, detailFreshness: { state: "missing" },
    });
    expect(record.facts.some(fact => fact.kind.startsWith("match:"))).toBe(false);
    await f.stream.packageObservation(f.lease, catalog, "exact");
    const reread = f.append.mock.calls[1][1][0];
    expect(reread.detail_generation).toBe(f.lease.id);
    expect(reread.residual).toMatchObject({ identityDetailsCollected: true, detailFreshness: { state: "fresh" } });
    expect(reread.residual).not.toHaveProperty("identityRevalidationRequired");
  });

  it("persists an explicitly absent detail generation when an older detail read retains newer missing catalog evidence", async () => {
    const catalog = allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false });
    const f = savedPackageFixture({ ...catalog, detailFreshness: { state: "missing", observedAt: null, expiresAt: null } }, {
      readStartedAt: new Date("2026-09-24T11:00:00Z"), detailGeneration: null,
      observedAt: new Date("2026-09-24T11:00:00Z"), expiresAt: new Date("2026-09-25T11:00:00Z"),
    });
    await f.stream.packageObservation(f.lease, catalog, "detail");
    const record = f.append.mock.calls[0][1][0];
    expect(record.detail_generation).toBeNull();
    f.append.mockRestore();
    const appendQuery = f.query;
    appendQuery.mockImplementation(async statement => {
      const rows = String(statement).startsWith("SELECT * FROM inventory_attempts")
        ? [{ mode: "delta", channel: "detail", domain: "packages", exact_targets: [catalog.id] }]
        : String(statement).startsWith("SELECT max(octet_length") ? [{ observed: "1024" }]
          : String(statement).startsWith("SELECT 1 FROM inventory_memberships") ? [{}]
            : String(statement).startsWith("WITH candidates") ? [{ count: 0, bytes: "0", last: null }] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    f.fence.mockResolvedValue({ state: "staging", batch_count: 0, row_count: 0, byte_count: "0", reserved_bytes: "1048576" });
    const abort = vi.spyOn(f.stream.stages.generations, "abort").mockResolvedValue(undefined);
    await f.stream.stages.append(f.lease, [record]);
    const insert = appendQuery.mock.calls.find(([statement]) => String(statement).startsWith("INSERT INTO package_record_rows"));
    expect(insert).toBeDefined();
    const sql = String(insert![0]);
    // A null projection must not be coalesced back into this discarded detail read's generation.
    expect(sql).toContain("CASE WHEN r.residual->'detailFreshness'->>'state'='missing' THEN NULL");
    expect(JSON.parse(String(insert![1]![3]))[0].detail_generation).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.connect).not.toHaveBeenCalled();
  });

  it.each(["catalog", "detail"] as const)("publishes %s access collections for equivalent raw scope aliases", async channel => {
    const catalog = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, version: "1",
      lastModifiedDateTime: "2026-09-24T08:00:00Z", availableTo: "AllowedForSome", deployedTo: "InstalledForSome",
    });
    const previousPrincipals = [{ resourceId: "previous", resourceType: "user" }];
    const latestPrincipals = [{ resourceId: "latest", resourceType: "group" }];
    const f = savedPackageFixture({
      ...catalog, availableTo: "some", deployedTo: "some", allowedUsersAndGroups: previousPrincipals,
      acquireUsersAndGroups: previousPrincipals, identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: "2026-09-24T09:30:00Z", expiresAt: "2026-09-24T10:30:00Z" },
    });
    const incoming = channel === "catalog" ? catalog : {
      ...catalog, availableTo: "AvailableToSome", deployedTo: "DeployedToSome",
      allowedUsersAndGroups: latestPrincipals, acquireUsersAndGroups: latestPrincipals,
    };
    await f.stream.packageObservation(f.lease, incoming, channel);
    const record = f.append.mock.calls[0][1][0];
    const copied = f.previous.facts.filter(fact => fact.kind === "collection"
      ? record.factSource?.includeCollections?.includes(fact.value) : record.factSource?.kinds.includes(fact.kind));
    expect(restoreInventoryRecord(record.residual, [...record.facts, ...copied], "packages")).toMatchObject({
      availableTo: channel === "catalog" ? catalog.availableTo : "some",
      deployedTo: channel === "catalog" ? catalog.deployedTo : "some",
      allowedUsersAndGroups: channel === "catalog" ? previousPrincipals : latestPrincipals,
      acquireUsersAndGroups: channel === "catalog" ? previousPrincipals : latestPrincipals,
    });
    expect(f.stream.stages.generations.connections.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["fresh", 16_384], ["fresh", 16_385], ["fresh", 24_576],
    ["stale", 16_384], ["stale", 16_385], ["stale", 24_576],
  ] as const)("retains %s detail descriptions at %i bytes across compatible catalog publication", async (state, bytes) => {
    const catalog = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, version: "1",
      lastModifiedDateTime: "2026-09-24T08:00:00Z", shortDescription: "Current catalog summary",
      longDescription: "Catalog text must not replace the completed detail observation",
    });
    const longDescription = "Saved detail description. ".repeat(1000).slice(0, bytes);
    const f = savedPackageFixture({
      ...catalog, longDescription, categories: ["productivity"], identityDetailsCollected: true,
      detailFreshness: { state, observedAt: "2026-09-24T09:30:00Z",
        expiresAt: state === "fresh" ? "2026-09-24T10:30:00Z" : "2026-09-24T09:59:59Z" },
    });
    expect(f.previous.facts.filter(fact => fact.kind === "about:long"))
      .toHaveLength(bytes > 16_384 ? Math.ceil(bytes / 8192) : 0);
    await f.stream.packageObservation(f.lease, catalog, "catalog");
    const record = f.append.mock.calls[0][1][0];
    const copied = f.previous.facts.filter(fact => fact.kind === "collection"
      ? record.factSource?.includeCollections?.includes(fact.value) : record.factSource?.kinds.includes(fact.kind));
    const restored = restoreInventoryRecord(record.residual, [...record.facts, ...copied], "packages");
    expect(restored.longDescription).toHaveLength(longDescription.length);
    expect(restored).toMatchObject({
      longDescription, shortDescription: catalog.shortDescription, categories: ["productivity"],
      detailFreshness: { state },
    });
    expect(f.stream.stages.generations.connections.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.connect).not.toHaveBeenCalled();
  });

  it.each(["detail", "exact"] as const)("lets a new %s read replace or omit a saved detail description", async channel => {
    const catalog = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, version: "1",
      lastModifiedDateTime: "2026-09-24T08:00:00Z",
    });
    const f = savedPackageFixture({
      ...catalog, longDescription: "Previous detail description. ".repeat(800), identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: "2026-09-24T09:30:00Z", expiresAt: "2026-09-24T10:30:00Z" },
    });
    for (const longDescription of [undefined, "", "Replacement detail description"]) {
      await f.stream.packageObservation(f.lease, { ...catalog, longDescription }, channel);
      const record = f.append.mock.calls.at(-1)![1][0];
      expect(record.factSource?.kinds ?? []).not.toContain("about:long");
      expect(restoreInventoryRecord(record.residual, record.facts, "packages").longDescription).toBe(longDescription);
    }
  });

  it.each([
    ["compatible", 16_384], ["compatible", 16_385], ["compatible", 24_576],
    ["invalidated", 16_384], ["invalidated", 16_385], ["invalidated", 24_576],
  ] as const)("retains catalog-owned descriptions and collections after a %s detail read at %i bytes", async (state, bytes) => {
    const principals = [{ resourceId: "catalog-user", resourceType: "user" }];
    const latestPrincipals = [{ resourceId: "detail-group", resourceType: "group" }];
    const catalog = allowlistedPackage({
      id: "package", displayName: "Catalog name", isBlocked: false, version: "1",
      lastModifiedDateTime: "2026-09-24T08:00:00Z",
      shortDescription: "s".repeat(bytes), longDescription: "l".repeat(bytes),
      availableTo: "some", deployedTo: "some", categories: ["catalog-category"],
      allowedUsersAndGroups: principals, acquireUsersAndGroups: principals, sharedWithUsersAndGroups: principals,
    });
    const f = savedPackageFixture(catalog);
    await f.stream.packageObservation(f.lease, {
      ...catalog, version: state === "compatible" ? "1" : "2",
      displayName: "Detail name", isBlocked: true, shortDescription: "Detail summary",
      longDescription: "Detail description", categories: ["detail-category"],
      allowedUsersAndGroups: latestPrincipals, acquireUsersAndGroups: latestPrincipals,
      sharedWithUsersAndGroups: latestPrincipals,
    }, "detail");
    const record = f.append.mock.calls[0][1][0];
    const copied = f.previous.facts.filter(fact => record.factSource?.kinds.includes(fact.kind)
      && (fact.kind !== "collection" || record.factSource.includeCollections?.includes(fact.value)));
    const restored = restoreInventoryRecord(record.residual, [...record.facts, ...copied], "packages");
    const expectedLongDescription = state === "compatible" ? "Detail description" : catalog.longDescription;
    expect(restored.shortDescription).toHaveLength(bytes);
    expect(restored.shortDescription).toBe(catalog.shortDescription);
    expect(restored.longDescription).toHaveLength(expectedLongDescription!.length);
    expect(restored.longDescription).toBe(expectedLongDescription);
    expect(restored).toMatchObject({
      displayName: catalog.displayName, isBlocked: catalog.isBlocked,
      categories: state === "compatible" ? ["detail-category"] : catalog.categories,
      allowedUsersAndGroups: state === "compatible" ? latestPrincipals : principals,
      acquireUsersAndGroups: state === "compatible" ? latestPrincipals : principals,
      sharedWithUsersAndGroups: state === "compatible" ? latestPrincipals : principals,
      detailFreshness: { state: state === "compatible" ? "fresh" : "invalidated" },
    });
    expect(f.stream.stages.generations.connections.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.connect).not.toHaveBeenCalled();
  });

  it.each([
    { sharedWithUsersAndGroups: undefined },
    { sharedWithUsersAndGroups: [] },
    { sharedWithUsersAndGroups: [{ resourceId: "catalog-user", resourceType: "user" }] },
  ])(
    "preserves absent versus empty catalog sharing after incompatible detail enrichment (%j)", async ({ sharedWithUsersAndGroups }) => {
      const catalog = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false, version: "1",
        lastModifiedDateTime: "2026-09-24T08:00:00Z", sharedWithUsersAndGroups,
      });
      const f = savedPackageFixture(catalog);
      await f.stream.packageObservation(f.lease, { ...catalog, version: "2", sharedWithUsersAndGroups: [] }, "detail");
      const record = f.append.mock.calls[0][1][0];
      const copied = f.previous.facts.filter(fact => record.factSource?.kinds.includes(fact.kind)
        && (fact.kind !== "collection" || record.factSource.includeCollections?.includes(fact.value)));
      const restored = restoreInventoryRecord(record.residual, [...record.facts, ...copied], "packages");
      expect(restored.sharedWithUsersAndGroups).toEqual(sharedWithUsersAndGroups);
      expect(record.residual.detailFreshness).toMatchObject({ state: "invalidated" });
    },
  );

  it("does not retain an incompatible revision's detail description during catalog publication", async () => {
    const catalog = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, version: "1",
      lastModifiedDateTime: "2026-09-24T08:00:00Z",
    });
    const f = savedPackageFixture({
      ...catalog, longDescription: "Previous revision description. ".repeat(800), identityDetailsCollected: true,
      detailFreshness: { state: "fresh", observedAt: "2026-09-24T09:30:00Z", expiresAt: "2026-09-24T10:30:00Z" },
    });
    await f.stream.packageObservation(f.lease, { ...catalog, version: "2" }, "catalog");
    const record = f.append.mock.calls[0][1][0];
    expect(record.factSource?.kinds ?? []).not.toContain("about:long");
    expect(restoreInventoryRecord(record.residual, record.facts, "packages")).not.toHaveProperty("longDescription");
    expect(record.residual.detailFreshness).toMatchObject({ state: "invalidated" });
  });

  it.each(["stale", "invalidated", "fresh", "missing"] as const)(
    "preserves valid completed-empty %s detail provenance during catalog publication", async state => {
      const catalog = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false, version: "1", lastModifiedDateTime: "2026-09-24T08:00:00Z",
      });
      const f = savedPackageFixture({
        ...catalog, ...(state === "invalidated" || state === "fresh" ? { identityRevalidationRequired: true } : {}),
        detailFreshness: state === "missing" ? { state, observedAt: null, expiresAt: null }
          : { state, observedAt: "2026-09-24T09:30:00Z",
            expiresAt: state === "stale" ? "2026-09-24T09:59:59Z" : "2026-09-24T10:30:00Z" },
      });
      await f.stream.packageObservation(f.lease, catalog, "catalog");
      const record = f.append.mock.calls[0][1][0];
      expect(record.residual.detailFreshness).toEqual(f.previous.residual.detailFreshness);
      expect(record.detail_generation).toBe(state === "missing" ? null : "detail");
      if (state === "stale") expect(record.residual.identityDetailsCollected).toBe(true);
      else expect(record.residual).not.toHaveProperty("identityDetailsCollected");
      expect(record.facts.some(fact => fact.kind.startsWith("match:"))).toBe(false);
    },
  );

  it.each(["appId", "assetId"] as const)("persists case-only changes to opaque %s as identity conflicts", async key => {
    const f = fixture(), marker = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const current = packageInventoryRecord(allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false, [key]: marker,
    }));
    f.query.mockImplementation(async (statement, parameters) => {
      const sql = String(statement);
      const rows = sql.startsWith("SELECT r.generation_id,r.identity,r.residual")
        ? [{ generation_id: "previous", identity: "package", residual: current.residual }]
        : sql.startsWith("SELECT ordinal,kind,value,payload FROM inventory_facts")
          ? current.facts.map((fact, ordinal) => ({ ...fact, ordinal }))
            .filter(fact => fact.ordinal > Number(parameters?.[2])).slice(0, 2) : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    const detail = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: true, [key]: marker.toUpperCase(),
    });
    await publishPackageReadback({ tenantId: "tenant", principalId: "principal" }, detail, f.client, null, { kind: "block", isBlocked: true });
    const insert = f.query.mock.calls.find(([statement]) => String(statement).startsWith("INSERT INTO package_inventory_snapshots"));
    expect(insert?.[1]?.[7]).toBe(true);
    expect(f.stream.stages.generations.connections.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.connect).not.toHaveBeenCalled();
  });

  it("persists new bot identity constraints even without a prior complete custom-engine identity", async () => {
    const f = fixture();
    const current = packageInventoryRecord(allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false }));
    f.query.mockImplementation(async (statement, parameters) => {
      const sql = String(statement);
      const rows = sql.startsWith("SELECT r.generation_id,r.identity,r.residual")
        ? [{ generation_id: "previous", identity: "package", residual: current.residual }]
        : sql.startsWith("SELECT ordinal,kind,value,payload FROM inventory_facts")
          ? current.facts.map((fact, ordinal) => ({ ...fact, ordinal }))
            .filter(fact => fact.ordinal > Number(parameters?.[2])).slice(0, 2) : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    const detail = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: true,
      elementDetails: [{ elementType: "Bots", elements: [{
        id: "bot", definition: JSON.stringify({ botId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      }] }],
    });
    await publishPackageReadback({ tenantId: "tenant", principalId: "principal" }, detail, f.client, null, { kind: "block", isBlocked: true });
    const insert = f.query.mock.calls.find(([statement]) => String(statement).startsWith("INSERT INTO package_inventory_snapshots"));
    expect(insert?.[1]?.[7]).toBe(true);
    expect(f.stream.stages.generations.connections.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.generations.connections.database.connect).not.toHaveBeenCalled();
  });

  it("does not let a later catalog stream requalify identity details retained after a control conflict", async () => {
    const f = fixture(), observedAt = new Date("2026-09-24T09:30:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(observedAt);
    try {
      const catalog = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false, version: "1", manifestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        lastModifiedDateTime: "2026-09-24T08:00:00Z", elementTypes: ["DeclarativeCopilots"],
      });
      const control = {
        detail: allowlistedPackage({ id: catalog.id, displayName: catalog.displayName, isBlocked: true, version: "2" }),
        state: { kind: "block" as const, isBlocked: true },
        observation: { snapshotId: "control", observedAt: "2026-09-24T09:15:00Z", expiresAt: "2026-10-24T09:15:00Z" },
      };
      const previous = packageInventoryRecord(projectPackageControl({
        ...catalog, identityDetailsCollected: true,
        elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "element", definition: "{}" }] }],
        detailFreshness: { state: "fresh", observedAt: "2026-09-24T09:00:00Z", expiresAt: "2026-09-24T10:00:00Z" },
      }, control));
      f.fence.mockResolvedValue({ state: "staging", observed_at: observedAt });
      f.query.mockImplementation(async (statement, parameters) => {
        const sql = String(statement);
        const rows = sql.startsWith("SELECT * FROM inventory_attempts") ? [{ baseline_id: "baseline", base_revision: "1" }]
          : sql.startsWith("SELECT m.identity,m.generation_id") ? [{ identity: catalog.id, generation_id: "previous" }]
            : sql.startsWith("SELECT principal_id,token_mode") ? [{ principal_id: "principal", token_mode: "delegated" }]
              : sql.includes("JOIN inventory_records r") ? [{ identity: catalog.id, generation_id: "previous", domain: "packages",
                residual: previous.residual, read_started_at: new Date("2026-09-24T08:30:00Z") }]
                : sql.includes("SELECT f.generation_id") && parameters?.[1] === null
                  ? previous.facts.map((fact, ordinal) => ({ ...fact, ordinal, identity: catalog.id, generation_id: "previous" })) : [];
        return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
      });
      const append = vi.spyOn(f.stream.stages, "appendBounded").mockResolvedValue(undefined);
      await f.stream.packageObservation(f.lease, catalog, "catalog", control);
      const record = append.mock.calls[0][1][0];
      expect(record.residual).toMatchObject({ identityRevalidationRequired: true, detailFreshness: { state: "fresh" } });
      expect(record.residual).not.toHaveProperty("identityDetailsCollected");
      expect(record.facts.some(fact => fact.kind.startsWith("match:"))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("shares provider cooldowns across independently created inventory streams", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "UnknownError", message: "Too many requests" } }, {
        status: 424, headers: { "Retry-After": "15000" },
      }))
      .mockResolvedValue(Response.json({ id: "package", displayName: "Package", isBlocked: false }));
    vi.stubGlobal("fetch", fetcher);
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    try {
      const first = new StreamedInventory(database);
      const second = new StreamedInventory(database);
      await expect(first.graph.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
      await expect(second.graph.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(database.query).not.toHaveBeenCalled();
      expect(database.connect).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("rechecks the durable generation before a physical retry, not just before the page", async () => {
    const f = fixture(), reason = new AppError(409, "generation_lost", "The generation was cancelled.");
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    // Preparing membership and the first physical read are still current.
    f.fence.mockResolvedValueOnce({ state: "staging" }).mockResolvedValueOnce({ state: "staging" }).mockRejectedValueOnce(reason);
    await expect(f.stream.graphCatalog(f.input, "token", { signal: f.signal, authorize: async () => undefined }))
      .rejects.toBe(reason);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("fences native retries before dispatch even when cancellation has not reached the in-memory signal", async () => {
    const f = fixture(), reason = new AppError(409, "generation_lost", "Synthetic generation cancellation.");
    const types = ["microsoft.copilotstudio/agents"] as const;
    f.input.scope.source = "inventory_power_platform";
    f.input.scope.selector = inventorySelector({ domain: "power_platform", resourceTypes: types });
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
    const provider = new PowerPlatformResourceQueryClient(fetcher, { delay: async () => {} });
    vi.spyOn(f.stream.powerPlatform, "pages").mockImplementation((...args) => provider.pages(...args));
    f.fence.mockResolvedValueOnce({ state: "staging" }).mockResolvedValueOnce({ state: "staging" }).mockRejectedValueOnce(reason);
    const publish = vi.spyOn(f.stream.stages.generations, "publish").mockResolvedValue("1");
    await expect(f.stream.powerPlatformCatalog(f.input, "token", types, {
      signal: f.signal, authorize: async () => {},
    })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.signal.aborted).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["exact", "exactJob"] as const)(
    "does not convert a successful %s read's staging 404 into a tombstone", async mode => {
      const f = collectionFixture();
      const failure = new AppError(404, "not_found", "Synthetic staging failure.");
      f.fetcher.mockResolvedValue(Response.json({ id: "package", displayName: "Package", isBlocked: false }));
      f.query.mockImplementation(async (statement, parameters) => {
        const rows = String(statement).includes("SELECT ordinal,target_id") && parameters?.[1] === -1
          ? [{ ordinal: 0, target_id: "package" }]
          : String(statement).startsWith("SELECT * FROM inventory_attempts") ? [{ membership_prepared: true, mode: "delta" }] : [];
        return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
      });
      const observed = vi.spyOn(f.stream, "packageObservation").mockRejectedValue(failure);
      const missing = vi.spyOn(f.stream, "exactMissing").mockResolvedValue(undefined);
      const run = mode === "exact" ? f.stream.exact(f.input, "token", ["package"], { authorize: async () => {} })
        : f.stream.exactJob(f.input, "token", false, { authorize: async () => {} });
      await expect(run).rejects.toBe(failure);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledOnce();
      expect(missing).not.toHaveBeenCalled();
      expect(f.stream.stages.validate).not.toHaveBeenCalled();
    },
  );

  it.each(["exact", "exactJob"] as const)(
    "requires provider response evidence before a %s 404 becomes a tombstone", async mode => {
      const f = collectionFixture();
      const failure = new AppError(404, "not_found", "Synthetic token callback failure.");
      f.query.mockImplementation(async (statement, parameters) => {
        const rows = String(statement).includes("SELECT ordinal,target_id") && parameters?.[1] === -1 ? [{ ordinal: 0, target_id: "package" }] : [];
        return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
      });
      const missing = vi.spyOn(f.stream, "exactMissing").mockResolvedValue(undefined);
      const options = { authorize: async () => {}, getAccessToken: async () => { throw failure; } };
      const run = mode === "exact" ? f.stream.exact(f.input, "token", ["package"], options)
        : f.stream.exactJob(f.input, "token", false, options);
      await expect(run).rejects.toBe(failure);
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(missing).not.toHaveBeenCalled();
      expect(f.stream.stages.validate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])("settles cancelled exact-job progress even when its callback ignores cancellation (detail=%s)", async detailOnly => {
    const f = collectionFixture();
    const blocked = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const reason = new AppError(409, "read_job_cancelled", "Synthetic exact-job cancellation.");
    vi.spyOn(f.stream.stages.database, "query").mockResolvedValue({
      command: "SELECT", oid: 0, fields: [], rowCount: 1, rows: [{ count: 2 }],
    });
    f.query.mockImplementation(async statement => {
      const rows = String(statement).includes("SELECT ordinal,target_id")
        ? [{ ordinal: 0, target_id: "first" }, { ordinal: 1, target_id: "second" }] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    const read = vi.spyOn(f.stream.graph, "getPackageDetails").mockResolvedValue({
      id: "first", displayName: "First", isBlocked: false,
    });
    vi.spyOn(f.stream, "packageObservation").mockResolvedValue(undefined);
    const progress = vi.fn(() => { started.resolve(); return blocked.promise; });
    let settled = false;
    const run = f.stream.exactJob(f.input, "token", detailOnly, {
      authorize: async () => {}, onProgress: progress,
    }).finally(() => { settled = true; });
    const rejected = expect(run).rejects.toBe(reason);
    await started.promise;
    f.controller.abort(reason);
    // Flush the abort race without resolving the deliberately non-cooperative callback.
    for (let index = 0; index < 30; index++) await Promise.resolve();
    const settledOnAbort = settled;
    blocked.resolve();
    await rejected;
    expect(settledOnAbort).toBe(true);
    expect(read).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledOnce();
    expect(f.stream.stages.validate).not.toHaveBeenCalled();
    expect(getEventListeners(f.signal, "abort")).toHaveLength(0);
  });

  it.each(["exact", "exactJob", "details", "detailJob"] as const)(
    "only manual exact reads tombstone provider-confirmed absence (%s)", async mode => {
      const f = collectionFixture();
      f.fetcher.mockResolvedValue(Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 }));
      f.query.mockImplementation(async (statement, parameters) => {
        const rows = String(statement).includes("SELECT ordinal,target_id") && parameters?.[1] === -1
          ? [{ ordinal: 0, target_id: "package" }] : [];
        return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
      });
      vi.spyOn(f.stream.stages.database, "query").mockResolvedValue({
        command: "SELECT", oid: 0, fields: [], rowCount: 1, rows: [{ count: 1 }],
      });
      const missing = vi.spyOn(f.stream, "exactMissing").mockResolvedValue(undefined);
      const options = { authorize: async () => {} };
      const run = mode === "exact" ? f.stream.exact(f.input, "token", ["package"], options)
        : mode === "details" ? f.stream.details(f.input, "token", ["package"], options)
          : f.stream.exactJob(f.input, "token", mode === "detailJob", options);
      if (mode === "exact" || mode === "exactJob") {
        await expect(run).resolves.toMatchObject({ baselineId: f.lease.id });
        expect(missing).toHaveBeenCalledExactlyOnceWith(f.lease, "package");
      } else {
        await expect(run).rejects.toMatchObject({ status: 404, details: { httpStatus: 404 } });
        expect(missing).not.toHaveBeenCalled();
      }
      expect(f.fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(["persisted", "callback", "delayed_timer"] as const)(
    "bounds exact-job progress by its %s deadline without waiting for another provider read", async deadline => {
      vi.useFakeTimers();
      const f = collectionFixture();
      const blocked = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
      let elapsed = 0;
      if (deadline === "delayed_timer") vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      if (deadline === "persisted") f.input.deadlineAt = new Date(Date.now() + 100);
      f.query.mockImplementation(async statement => {
        const rows = String(statement).includes("SELECT ordinal,target_id")
          ? [{ ordinal: 0, target_id: "first" }, { ordinal: 1, target_id: "second" }] : [];
        return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
      });
      const read = vi.spyOn(f.stream.graph, "getPackageDetails").mockResolvedValue({
        id: "first", displayName: "First", isBlocked: false,
      });
      vi.spyOn(f.stream, "packageObservation").mockResolvedValue(undefined);
      const run = f.stream.exactJob(f.input, "token", false, {
        authorize: async () => {}, executionDeadlineAt: Date.now() + 60_000,
        onProgress: async () => {
          started.resolve();
          if (deadline === "delayed_timer") elapsed = 30_001;
          else await blocked.promise;
        },
      });
      const rejected = deadline === "persisted" ? expect(run).rejects.toMatchObject({ name: "TimeoutError" })
        : expect(run).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
      await started.promise;
      if (deadline !== "delayed_timer") await vi.advanceTimersByTimeAsync(deadline === "persisted" ? 100 : 30_000);
      await rejected;
      expect(f.signal.aborted).toBe(false);
      expect(read).toHaveBeenCalledOnce();
      expect(getEventListeners(f.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.stream.stages.validate).not.toHaveBeenCalled();
      if (deadline !== "delayed_timer") blocked.reject(new Error("Synthetic late progress rejection."));
      await Promise.resolve();
    },
  );

  it.each(["preparation", "dispatch fence"] as const)("rechecks the durable fence after %s ages and renews a Graph token", async stage => {
    const f = collectionFixture();
    let elapsed = 0, current = true;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const provider = new GraphPackagesClient(f.fetcher, {
      now: () => elapsed, minimumReadIntervalMs: 100, delay: async ms => { elapsed += ms; },
    });
    vi.spyOn(f.stream.graph, "getPackageDetails").mockImplementation((...args) => provider.getPackageDetails(...args));
    f.fetcher.mockImplementation(async input => Response.json({
      id: new URL(input).pathname.split("/").at(-1), displayName: "Package", isBlocked: false,
    }));
    await provider.getPackageDetails("token", "seed");
    f.fetcher.mockClear();
    vi.spyOn(f.stream, "packageObservation").mockResolvedValue(undefined);
    const failure = new AppError(409, "generation_lost", "Synthetic generation loss during token renewal.");
    f.fence.mockImplementation(async () => {
      if (!current) throw failure;
      if (stage === "dispatch fence") elapsed += 29_900;
      return { state: "staging" };
    });
    const token = vi.fn(async () => {
      if (token.mock.calls.length > 1) current = false;
      return "synthetic";
    });
    await expect(f.stream.exact(f.input, "token", ["package"], {
      authorize: async () => {}, getAccessToken: token,
      beforeRequest: async () => { if (stage === "preparation") elapsed += 29_900; },
    })).rejects.toBe(failure);
    expect(token).toHaveBeenCalledTimes(2);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.signal.aborted).toBe(false);
  });

  it.each(["graph", "native"] as const)("does not advance %s progress or fetch another page before durable acceptance", async provider => {
    const f = fixture();
    const accepted = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const failure = new Error("Synthetic second-page acceptance failure.");
    vi.mocked(f.stream.stages.acceptPage)
      .mockImplementationOnce(async () => { started.resolve(); await accepted.promise; })
      .mockRejectedValueOnce(failure);
    const progress = vi.fn();
    const types = ["microsoft.copilotstudio/agents"] as const;
    let run: Promise<unknown>;
    let fetcher: ReturnType<typeof vi.fn>;
    if (provider === "graph") {
      f.fetcher.mockResolvedValueOnce(Response.json({
        value: [], "@odata.nextLink": `${buildCopilotAgentsListUrl()}&$skiptoken=next`,
      })).mockResolvedValueOnce(Response.json({ value: [] }));
      fetcher = f.fetcher;
      run = f.stream.graphCatalog(f.input, "token", { signal: f.signal, authorize: async () => {}, onProgress: progress });
    } else {
      f.input.scope.source = "inventory_power_platform";
      f.input.scope.selector = inventorySelector({ domain: "power_platform", resourceTypes: types });
      fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({
          totalRecords: 2, count: 1, resultTruncated: true, skipToken: "next",
          data: [{ tenantId: "tenant", name: "first", type: types[0] }],
        }))
        .mockResolvedValueOnce(Response.json({
          totalRecords: 2, count: 1, resultTruncated: false,
          data: [{ tenantId: "tenant", name: "second", type: types[0] }],
        }));
      const native = new PowerPlatformResourceQueryClient(fetcher);
      vi.spyOn(f.stream.powerPlatform, "pages").mockImplementation((...args) => native.pages(...args));
      vi.spyOn(f.stream.stages, "appendBounded").mockResolvedValue(undefined);
      run = f.stream.powerPlatformCatalog(f.input, "token", types, {
        signal: f.signal, authorize: async () => {}, onProgress: progress,
      });
    }
    const rejected = expect(run).rejects.toBe(failure);
    await started.promise;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(progress).not.toHaveBeenCalled();
    expect(f.stream.stages.acceptPage).toHaveBeenCalledOnce();
    accepted.resolve();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      pages: 1, observedCount: provider === "graph" ? 0 : 1, totalRecords: provider === "graph" ? null : 2,
    });
    expect(f.stream.stages.validate).not.toHaveBeenCalled();
  });

  it("preserves duplicate staging evidence when poisoning the generation also fails", async () => {
    const f = fixture();
    const primary = Object.assign(new Error("Synthetic duplicate identity."), { code: "23505" });
    const cleanup = new Error("Synthetic poison fence failure.");
    const record = packageInventoryRecord(allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false }));
    f.fence.mockResolvedValue({ state: "staging", batch_count: 0, row_count: 0 });
    f.query.mockImplementation(async statement => {
      const sql = String(statement);
      if (sql.startsWith("INSERT INTO inventory_keys")) throw primary;
      const rows = sql.startsWith("SELECT * FROM inventory_attempts") ? [{ domain: "packages", mode: "baseline" }]
        : sql.startsWith("SELECT max(octet_length") ? [{ observed: "1024" }] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    vi.spyOn(f.stream.stages.generations, "abort").mockRejectedValue(cleanup);
    await expect(f.stream.stages.append(f.lease, [record])).rejects.toMatchObject({
      message: "data_poison_fence_failed", errors: [primary, cleanup],
    });
    expect(f.stream.stages.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.database.connect).not.toHaveBeenCalled();
  });

  it("does not publish an empty replacement catalog after duplicate response members erase observed packages", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(new Response(
      '{"value":[{"id":"package","displayName":"Package","isBlocked":false}],"value":[]}',
    ));
    const publish = vi.spyOn(f.stream.stages.generations, "publish").mockResolvedValue("1");
    await expect(f.stream.graphCatalog(f.input, "token", { signal: f.signal, authorize: async () => undefined }))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.stream.stages.acceptPage).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(f.stream.stages.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.database.connect).not.toHaveBeenCalled();
  });

  it.each([
    '{"totalRecords":100001,"totalRecords":0,"count":0,"resultTruncated":false,"data":[]}',
    '{"totalRecords":1,"count":1,"resultTruncated":false,"data":[{"tenantId":"tenant","name":"private-first","name":"agent","type":"microsoft.copilotstudio/agents"}]}',
    '{"totalRecords":2,"count":1,"resultTruncated":false,"data":[{"tenantId":"tenant","name":"agent","type":"microsoft.copilotstudio/agents"}]}',
  ])("does not stage or publish native inventory from invalid completion or identity evidence: %s", async body => {
    const f = fixture();
    const types = ["microsoft.copilotstudio/agents"] as const;
    f.input.scope.source = "inventory_power_platform";
    f.input.scope.selector = inventorySelector({ domain: "power_platform", resourceTypes: types });
    const fetcher = vi.fn(async () => new Response(body));
    const provider = new PowerPlatformResourceQueryClient(fetcher);
    vi.spyOn(f.stream.powerPlatform, "pages").mockImplementation((...args) => provider.pages(...args));
    const append = vi.spyOn(f.stream.stages, "appendBounded").mockResolvedValue(undefined);
    const publish = vi.spyOn(f.stream.stages.generations, "publish").mockResolvedValue("1");
    const onProgress = vi.fn();
    await expect(f.stream.powerPlatformCatalog(f.input, "token", types, {
      signal: f.signal, authorize: async () => undefined, onProgress,
    })).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expect(f.stream.stages.acceptPage).not.toHaveBeenCalled();
    expect(f.stream.stages.validate).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(f.stream.stages.database.query).not.toHaveBeenCalled();
    expect(f.stream.stages.database.connect).not.toHaveBeenCalled();
  });

  it("passes the persisted execution deadline even when the collection signal never aborts", async () => {
    const f = fixture();
    f.input.deadlineAt = new Date(Date.now() - 1);
    await expect(f.stream.graphCatalog(f.input, "token", {
      signal: f.signal, authorize: async () => undefined, retryThrottlingUntilAborted: true,
      executionDeadlineAt: Date.now() + 60_000,
    })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("does not renew an expired native execution budget at the provider boundary", async () => {
    const f = fixture();
    const types = ["microsoft.copilotstudio/agents"] as const;
    f.input.scope.source = "inventory_power_platform";
    f.input.scope.selector = inventorySelector({ domain: "power_platform", resourceTypes: types });
    f.input.deadlineAt = new Date(Date.now() - 1);
    const fetcher = vi.fn(async () => Response.json({ totalRecords: 0, count: 0, data: [], resultTruncated: false }));
    const provider = new PowerPlatformResourceQueryClient(fetcher);
    vi.spyOn(f.stream.powerPlatform, "pages").mockImplementation((...args) => provider.pages(...args));
    await expect(f.stream.powerPlatformCatalog(f.input, "token", types, {
      signal: f.signal, authorize: async () => {}, executionDeadlineAt: Date.now() + 60_000,
    })).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes the initiating synchronous authority check to the terminal publication transaction", async () => {
    const f = fixture(), reason = new AppError(401, "authorization_expired", "The initiating authority was invalidated.");
    let current = true;
    const publish = vi.spyOn(f.stream.stages.generations, "publish").mockImplementation(async (_lease, options) => {
      current = false;
      options?.beforeCommit?.();
      return "1";
    });
    await expect(f.stream.graphCatalog(f.input, "token", {
      signal: f.signal, authorize: async () => undefined,
      assertCurrent: () => { if (!current) throw reason; },
    })).rejects.toBe(reason);
    expect(publish).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["cancellation", "authority"] as const)("keeps committed publication successful after late %s", async change => {
    const f = fixture(), reason = new AppError(401, "authorization_expired", "The initiating authority changed after commit.");
    const onCommitted = vi.fn();
    let current = true;
    f.query.mockImplementation(async statement => {
      const sql = String(statement);
      const rows = sql.startsWith("SELECT * FROM inventory_attempts")
        ? [{ membership_prepared: true, mode: "baseline", prepared_changed_count: 0 }]
        : sql.startsWith("UPDATE inventory_roots SET current=true") ? [{ row_count: 0, observation_epoch: "0" }] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    const publish = vi.spyOn(f.stream.stages.generations, "publish").mockImplementation(async (_lease, options) => {
      await options?.completeJob?.(f.client, { jobId: "job", runId: null, rows: 0, bytes: 0 });
      options?.beforeCommit?.();
      options?.onCommitted?.();
      if (change === "cancellation") f.controller.abort(reason);
      else current = false;
      return "1";
    });
    await expect(f.stream.graphCatalog(f.input, "token", {
      signal: f.signal, authorize: async () => undefined,
      onCommitted,
      assertCurrent: () => { if (!current) throw reason; },
    })).resolves.toMatchObject({ scopeId: f.lease.scopeId, baselineId: f.lease.id, revision: "1" });
    expect(publish).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
});
