import { Readable } from "node:stream";
import pg from "pg";
import { parse } from "csv-parse/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationLease } from "../src/db/dataGenerations.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { InventoryQueries } from "../src/db/inventoryQueries.js";
import * as usageFixtures from "../src/db/agentUsageTestSupport.js";
import { DataExports } from "../src/services/dataExports.js";
import { DataSelections } from "../src/services/dataSelections.js";
import { inventoryExportColumns } from "../src/services/inventoryExports.js";
import { streamOfficialReport } from "../src/services/officialReportStream.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import * as inventoryFixtures from "./inventoryFixtures.js";
import { seedSelectedInventory, selectedInventoryCsv, type SelectedInventoryFixtureInput } from "./selectedInventoryFixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture() {
  vi.stubEnv("AGENT_CONTROL_ISOLATED_TESTS", "1");
  const database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
  const scope = { tenantId: "selected-tenant", principalId: "selected-principal" };
  const lease: GenerationLease = {
    id: "generation", scopeId: "scope", tenantId: scope.tenantId, owner: "owner",
    version: 1, epoch: "0", sessionEpoch: "7", expectedRevision: "0", schemaVersion: 1,
  };
  const root = { scopeId: "canonical-scope", tenantId: scope.tenantId, baselineId: lease.id,
    revision: "1", epoch: lease.epoch, inserted: 0, closed: 0, changed: 0 };
  const epoch = vi.spyOn(DataGenerations.prototype, "sessionEpoch").mockResolvedValue(lease.sessionEpoch);
  let revision = 0, selectionId = 0;
  const execute = vi.spyOn(InventoryGenerations.prototype, "execute").mockImplementation(async (_input, intent, work) => {
    await work(lease, new AbortController().signal);
    return { ...root, scopeId: `${intent.domain}-scope`, revision: String(++revision) };
  });
  const visit = vi.spyOn(InventoryGenerations.prototype, "visit").mockResolvedValue(undefined);
  const append = vi.spyOn(InventoryGenerations.prototype, "appendBounded").mockResolvedValue(undefined);
  const accept = vi.spyOn(InventoryGenerations.prototype, "acceptPage").mockResolvedValue(undefined);
  const reconcile = vi.spyOn(inventoryFixtures, "reconcileInventoryFixture").mockResolvedValue(root);
  const reports = vi.spyOn(usageFixtures, "publishUsageReports").mockResolvedValue({
    setId: "report-set", activeRevision: "1", complete: true,
  });
  const capture = vi.spyOn(InventoryQueries.prototype, "capture").mockImplementation(async () => ({
    id: `selection-${++selectionId}`, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    evaluatedAt: new Date(), validatedAt: new Date(), endpoint: "inventory", queryHash: "query-hash",
  }));
  const pageError = new Error("synthetic page failure");
  const page = vi.spyOn(InventoryQueries.prototype, "page").mockRejectedValue(pageError);
  const invalidate = vi.spyOn(DataSelections.prototype, "invalidate").mockResolvedValue(undefined);
  return { database, scope, lease, root, epoch, execute, visit, append, accept, reconcile, reports,
    capture, page, pageError, invalidate };
}

describe("selected inventory fixture publication contracts", () => {
  it.each([0, 1, 100, 101, 201, 1000])("publishes %i detailed packages within the exact-target limit", async count => {
    const f = fixture();
    const packages = Array.from({ length: count }, (_, index) => ({
      ...allowlistedPackage({ id: `package-${index}`, displayName: `Agent ${index}`, isBlocked: false }),
      detailFreshness: { state: "fresh" as const, observedAt: "2026-10-28T10:00:00Z", expiresAt: "2026-10-29T10:00:00Z" },
    }));
    const observedAt = new Date("2026-10-28T10:00:00Z"), expiresAt = new Date("2026-10-29T10:00:00Z");
    const seeded = await seedSelectedInventory(f.database, { scope: f.scope, packages, observedAt, expiresAt });
    const details = f.execute.mock.calls.filter(([, intent]) => intent.channel === "detail");
    expect(details).toHaveLength(Math.ceil(count / 100));
    expect(details.every(([, intent]) => intent.targets!.length <= 100)).toBe(true);
    expect(details.flatMap(([, intent]) => intent.targets!)).toEqual(packages.map(value => value.id));
    expect(seeded.packages?.revision).toBe(String(1 + details.length));
    expect(f.epoch).toHaveBeenCalledExactlyOnceWith(f.scope.tenantId, f.scope.principalId);
    for (const [input] of f.execute.mock.calls) {
      expect(input).toMatchObject({ sessionEpoch: "7", observedAt, expiresAt, actorPrincipalId: f.scope.principalId,
        scope: { tenantId: f.scope.tenantId, principalId: null, kind: "tenant", tokenMode: "tenant" } });
    }
    expect(f.reconcile).toHaveBeenCalledExactlyOnceWith(f.database, f.scope, { observedAt, expiresAt });
    const pages = Math.max(1, Math.ceil(count / 100));
    expect(f.accept).toHaveBeenCalledTimes(pages + details.length + 1);
    const catalogPages = f.accept.mock.calls.slice(0, pages);
    expect(catalogPages.flatMap(([, page]) => page.records)).toHaveLength(count);
    for (const [index, [lease, page, persisted]] of catalogPages.entries()) {
      expect(lease).toBe(f.lease);
      expect(page).toMatchObject({ token: String(index * 100), page: index + 1, expectedCount: count,
        nextToken: index + 1 < pages ? String((index + 1) * 100) : null, rawCount: page.records.length });
      expect(persisted).toBe(page.records.length);
    }
  });

  it("does not publish package details when packages are omitted", async () => {
    const f = fixture();
    await seedSelectedInventory(f.database, { scope: f.scope, omitPackages: true, packages: [{
      ...allowlistedPackage({ id: "package", displayName: "Agent", isBlocked: false }),
      detailFreshness: { state: "fresh", observedAt: "2026-10-28T10:00:00Z", expiresAt: "2026-10-29T10:00:00Z" },
    }] });
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][1].domain).toBe("power_platform");
  });

  it("rejects non-isolated execution before accessing the database", async () => {
    const f = fixture();
    vi.stubEnv("AGENT_CONTROL_ISOLATED_TESTS", "0");
    await expect(seedSelectedInventory(f.database)).rejects.toThrow("fixture_only");
    expect(f.epoch).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("propagates publication failures without reconciling partial sources", async () => {
    const f = fixture(), error = new Error("synthetic publication failure");
    f.execute.mockRejectedValueOnce(error);
    await expect(seedSelectedInventory(f.database, { scope: f.scope })).rejects.toBe(error);
    expect(f.reconcile).not.toHaveBeenCalled();
  });
});

describe("selected inventory usage fixtures", () => {
  it.each([[10, 2], [8, 3], [2, 3], [0, 2], [0, 0], [10, 10], [11, 10],
    [Number.MAX_SAFE_INTEGER, 3], [Number.MAX_SAFE_INTEGER, 10]])(
    "preserves %i total responses across %i user rows and all three reports", async (responses, users) => {
      const f = fixture();
      await seedSelectedInventory(f.database, { scope: f.scope, usage: [{ id: "agent", responses, users }] });
      const transform = f.reports.mock.calls[0][3]!;
      const csvs = { agents: transform("agents", ""), userAgents: transform("userAgents", ""), users: transform("users", "") };
      for (const [kind, csv] of Object.entries(csvs)) {
        expect(await streamOfficialReport(Readable.from([Buffer.from(csv)]), undefined, new AbortController().signal,
          { batch: async () => {} })).toMatchObject({ kind });
      }
      const agents: Record<string, string>[] = parse(csvs.agents, { columns: true });
      const userAgents: Record<string, string>[] = parse(csvs.userAgents, { columns: true });
      const userRows: Record<string, string>[] = parse(csvs.users, { columns: true });
      expect(Number(agents[0]["Responses sent to users"])).toBe(responses);
      expect(Number(agents[0]["Active users (licensed)"])).toBe(Math.min(responses, users));
      expect(userAgents).toHaveLength(users);
      expect(userRows).toHaveLength(users);
      expect(userAgents.reduce((sum, row) => sum + Number(row["Responses sent to users"]), 0)).toBe(responses);
      expect(userRows.reduce((sum, row) => sum + Number(row["Agent responses received"]), 0)).toBe(responses);
      expect(userRows.map(row => Number(row["Number of agents used"])))
        .toEqual(userAgents.map(row => Number(Number(row["Responses sent to users"]) > 0)));
    },
  );

  it("preserves a safe aggregate at the response limit across multiple agents", async () => {
    const f = fixture();
    await seedSelectedInventory(f.database, { scope: f.scope, usage: [
      { id: "agent-a", responses: Number.MAX_SAFE_INTEGER - 1 },
      { id: "agent-b", responses: 1 },
    ] });
    const transform = f.reports.mock.calls[0][3]!;
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const csv = transform(kind, "");
      expect(await streamOfficialReport(Readable.from([Buffer.from(csv)]), undefined, new AbortController().signal,
        { batch: async () => {} })).toMatchObject({ kind, rowCount: 2 });
      const rows: Record<string, string>[] = parse(csv, { columns: true });
      const field = kind === "users" ? "Agent responses received" : "Responses sent to users";
      expect(rows.reduce((sum, row) => sum + Number(row[field]), 0)).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  const invalidUsage: SelectedInventoryFixtureInput["usage"][] = [
    Array.from({ length: 101 }, (_, index) => ({ id: `agent-${index}`, responses: 1 })),
    ...[-1, 0, 0.5, NaN, Infinity, 11].map(users => [{ id: "agent", responses: 1, users }]),
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(responses => [{ id: "agent", responses }]),
    [{ id: "agent-a", responses: Number.MAX_SAFE_INTEGER }, { id: "agent-b", responses: 1 }],
  ];
  it.each(invalidUsage.map(usage => ({ usage })))("rejects invalid usage before publication: $usage", async ({ usage }) => {
    const f = fixture();
    await expect(seedSelectedInventory(f.database, { scope: f.scope, usage })).rejects.toThrow("selected_usage_fixture_limit");
    expect(f.epoch).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.reports).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });
});

describe("selected inventory selection cleanup", () => {
  it("retains failed and unattempted selections for a cleanup retry", async () => {
    const f = fixture(), seeded = await seedSelectedInventory(f.database, { scope: f.scope });
    for (let index = 0; index < 3; index++) await expect(seeded.select()).rejects.toBe(f.pageError);
    const error = new Error("synthetic invalidation failure");
    f.invalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(seeded.releaseSelections()).rejects.toBe(error);
    expect(f.invalidate.mock.calls.map(([id]) => id)).toEqual(["selection-1", "selection-2"]);
    await seeded.releaseSelections();
    expect(f.invalidate.mock.calls.map(([id]) => id)).toEqual(["selection-1", "selection-2", "selection-2", "selection-3"]);
    await seeded.releaseSelections();
    expect(f.invalidate).toHaveBeenCalledTimes(4);
    for (const [, identity] of f.invalidate.mock.calls) expect(identity).toBe(seeded.identity);
  });
});

describe("selected inventory CSV downloads", () => {
  async function exportFixture() {
    const f = fixture(), seeded = await seedSelectedInventory(f.database, { scope: f.scope });
    const selection = await seeded.queries.capture(seeded.identity, seeded.canonical.scopeId);
    const exportId = "11111111-2222-4333-8444-555555555555";
    const create = vi.spyOn(DataExports.prototype, "create").mockResolvedValue(exportId);
    const build = vi.spyOn(DataExports.prototype, "build").mockResolvedValue(undefined);
    const status = vi.spyOn(DataExports.prototype, "status").mockResolvedValue({
      id: exportId, status: "ready", rows: 1, bytes: 1, expiresAt: new Date(), error: null, limit: null, observed: null,
    });
    return { ...f, seeded, selection, exportId, create, build, status };
  }

  it("preserves UTF-8 characters split across a stored export chunk boundary", async () => {
    const f = await exportFixture(), prefix = "\uFEFFname\r\n\"";
    const csv = `${prefix}${"a".repeat(262_143 - Buffer.byteLength(prefix))}\u754C\u{1F600}"\r\n`;
    const bytes = Buffer.from(csv);
    const download = vi.spyOn(DataExports.prototype, "download").mockImplementation(async function* () {
      yield bytes.subarray(0, 262_144);
      yield bytes.subarray(262_144);
    });
    const result = await selectedInventoryCsv(f.database, f.seeded, f.selection);
    expect(result.csv === csv).toBe(true);
    expect(result.status).toMatchObject({ id: f.exportId, status: "ready" });
    expect(f.status).toHaveBeenCalledExactlyOnceWith(f.exportId, f.seeded.identity);
    expect(f.create).toHaveBeenCalledExactlyOnceWith(f.seeded.identity, {
      selectionId: f.selection.id, queryHash: f.selection.queryHash, kind: "unified_agents", filename: "synthetic.csv",
    });
    expect(f.build).toHaveBeenCalledExactlyOnceWith(f.exportId, f.seeded.identity, inventoryExportColumns.unified_agents, expect.any(Function));
    expect(download).toHaveBeenCalledExactlyOnceWith(f.exportId, f.seeded.identity, expect.any(AbortSignal));
  });

  it.each([2 * 1024 * 1024, 2 * 1024 * 1024 + 1])("enforces the exact 2 MiB byte limit for %i bytes", async length => {
    const f = await exportFixture(), closed = vi.fn();
    vi.spyOn(DataExports.prototype, "download").mockImplementation(async function* () {
      try { yield Buffer.alloc(length, "a"); }
      finally { closed(); }
    });
    const result = selectedInventoryCsv(f.database, f.seeded, f.selection);
    if (length === 2 * 1024 * 1024) {
      expect(Buffer.byteLength((await result).csv)).toBe(length);
    } else {
      await expect(result).rejects.toThrow("selected_csv_fixture_limit");
      expect(f.status).not.toHaveBeenCalled();
    }
    expect(closed).toHaveBeenCalledExactlyOnceWith();
  });

  it("propagates download failures without reporting a completed CSV", async () => {
    const f = await exportFixture(), error = new Error("synthetic download failure");
    vi.spyOn(DataExports.prototype, "download").mockImplementation(async function* () {
      yield Buffer.from("partial");
      throw error;
    });
    await expect(selectedInventoryCsv(f.database, f.seeded, f.selection)).rejects.toBe(error);
    expect(f.status).not.toHaveBeenCalled();
  });
});
