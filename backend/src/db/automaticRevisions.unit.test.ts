import { createHash } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSyncRepository } from "./dataSync.js";
import { readAutomaticInventoryRevisions } from "./inventoryAutomaticRevisions.js";

const scope = { tenantId: "tenant-revisions", principalId: "reader-revisions" };
const observedAt = new Date("2026-09-24T10:00:00.000Z");
const expiresAt = new Date("2026-10-24T10:00:00.000Z");
vi.hoisted(() => { process.env.SESSION_SECRET ??= "synthetic-automatic-revisions-secret-32"; });
const pools = new Set<pg.Pool>();
type Marker = { source: string; id: string; observed_at: Date; expires_at: Date };
type UserSource = {
  source: "directory" | "app_activity";
  attempt_status: string | null;
  message: string | null;
  attempted_at: Date | null;
  row_count: number | null;
  generation_id: string | null;
  scope_id: string | null;
  revision: string | null;
  expires_at: Date | null;
  error_code: string | null;
  attempt_observed_count: number | null;
  observed_at: Date | null;
  report_refresh_date: string | null;
};

afterEach(async () => {
  for (const database of pools) await database.end();
  pools.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const database = new pg.Pool({ max: 4 });
  pools.add(database);
  const state: { markers: Marker[]; users: UserSource[] } = {
    markers: ["agent_people", "canonical", "directory", "graph_packages", "power_platform"].map(source => ({
      source, id: `${source}-snapshot`, observed_at: observedAt, expires_at: expiresAt,
    })),
    users: (["app_activity", "directory"] as const).map(source => ({
      source, attempt_status: "available", message: "Saved source.",
      attempted_at: observedAt, row_count: 1, scope_id: `${source}-scope`, revision: "1",
      generation_id: `${source}-generation`, observed_at: observedAt, expires_at: expiresAt,
      error_code: null, attempt_observed_count: 1,
      report_refresh_date: source === "app_activity" ? "2026-09-24" : null,
    })),
  };
  const response = (rows: object[]) => ({ rows: structuredClone(rows), rowCount: rows.length, command: "", oid: 0, fields: [] });
  const query = vi.fn(async (text: unknown, values?: readonly unknown[]) => {
    if (typeof text !== "string") throw new Error("Expected SQL.");
    if (["BEGIN ISOLATION LEVEL REPEATABLE READ", "COMMIT", "ROLLBACK"].includes(text)) return response([]);
    if (text === "SELECT clock_timestamp() AS now") return response([{ now: vi.isFakeTimers() ? new Date() : observedAt }]);
    if (text.includes("WITH markers AS")) {
      const afterSource = String(values![3]), afterId = String(values![4]);
      return response(state.markers.filter(row => row.source > afterSource || row.source === afterSource && row.id > afterId)
        .toSorted((left, right) => left.source.localeCompare(right.source) || left.id.localeCompare(right.id)).slice(0, 250));
    }
    if (text.includes("SELECT requested.source")) return response((["directory", "app_activity"] as const).map(source =>
      state.users.find(row => row.source === source) ?? { source, generation_id: null, scope_id: null, revision: null,
        expires_at: null, observed_at: null, attempted_at: null, attempt_status: null, error_code: null,
        message: null, row_count: null, attempt_observed_count: null, report_refresh_date: null }));
    if (text.startsWith("SELECT count(*)::text AS n FROM (")) return response([{ n: "1" }]);
    throw new Error("Unexpected automatic revision query.");
  });
  const client = Object.assign(new pg.Client(),{ query,release: vi.fn() }) as unknown as pg.PoolClient;
  vi.spyOn(database, "connect").mockResolvedValue(client);
  vi.spyOn(database, "query").mockImplementation(() => { throw new Error("Read escaped the selected transaction."); });
  return { database, client, query, repository: new DataSyncRepository(database), state };
}

describe("automatic saved-data revision boundaries", () => {
  it("uses native source metadata and one captured clock on the same repeatable-read client", async () => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    expect(await f.repository.automaticRevisions(scope)).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(["graph_packages", "power_platform", "users"]);
    for (const revision of Object.values(before)) expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(f.database.query).not.toHaveBeenCalled();
    expect(f.query.mock.calls.filter(([text]) => text === "BEGIN ISOLATION LEVEL REPEATABLE READ")).toHaveLength(2);
    expect(f.query.mock.calls.filter(([text]) => text === "SELECT clock_timestamp() AS now")).toHaveLength(2);
    const [usersQuery, parameters] = f.query.mock.calls.find(([text]) => String(text).includes("SELECT requested.source"))!;
    expect(parameters).toEqual([scope.tenantId, scope.principalId, "delegated", observedAt]);
    const inventoryParameters = f.query.mock.calls.filter(([text]) => String(text).includes("WITH markers AS"));
    for (const [, values] of inventoryParameters) expect(values!.slice(0, 3)).toEqual([scope.tenantId, scope.principalId, observedAt]);
    expect(usersQuery).toContain("g.id=h.generation_id");
    expect(usersQuery).toContain("g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch AND g.expires_at>$4");
    expect(usersQuery).toContain("proof.status='available'");
    expect(usersQuery).toContain("latest.status AS attempt_status");
    expect(usersQuery).not.toContain("snapshot_data");
    expect(usersQuery).not.toMatch(/package_inventory|package_detail|power_platform|agent_people/);
  });

  it.each(["graph_packages", "graph_package_details", "power_platform", "agent_people"])(
    "%s publications do not invalidate the combined Users license/activity data",
    async source => {
      const f = fixture();
      const before = await f.repository.automaticRevisions(scope);
      const observed = await readAutomaticInventoryRevisions(scope, f.database);
      f.state.markers.find(row => row.source === (source === "graph_package_details" ? "graph_packages" : source))!.id += "-updated";
      const after = await f.repository.automaticRevisions(scope);
      const changed = source.startsWith("graph_") ? "graph_packages" : "power_platform";
      const unchanged = changed === "graph_packages" ? "power_platform" : "graph_packages";
      expect(after[changed]).not.toBe(before[changed]);
      expect(after[unchanged]).toBe(before[unchanged]);
      expect(after.users).toBe(before.users);
      expect(await readAutomaticInventoryRevisions(scope, f.database)).not.toEqual(observed);
    },
  );

  it.each(["directory", "app_activity"] as const)("invalidates only projections depending on a new %s snapshot", async source => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    f.state.users.find(row => row.source === source)!.generation_id += "-updated";
    if (source === "directory") f.state.markers.find(row => row.source === source)!.id += "-updated";
    const after = await f.repository.automaticRevisions(scope);
    expect(after.users).not.toBe(before.users);
    expect(after.graph_packages).toBe(before.graph_packages);
    if (source === "directory") expect(after.power_platform).not.toBe(before.power_platform);
    else expect(after.power_platform).toBe(before.power_platform);
  });

  it.each(["directory", "app_activity"] as const)("detects %s failures with retained data, without invalidating saved people", async source => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    const row = f.state.users.find(value => value.source === source)!;
    row.attempt_status = "permission_required";
    row.message = "Refresh permission is unavailable; saved data remains.";
    const failed = await f.repository.automaticRevisions(scope);
    expect(failed.users).not.toBe(before.users);
    expect(failed.graph_packages).toBe(before.graph_packages);
    expect(failed.power_platform).toBe(before.power_platform);
    expect(await f.repository.automaticRevisions(scope)).toEqual(failed);
    row.message = "A different source failure is now shown.";
    expect((await f.repository.automaticRevisions(scope)).users).not.toBe(failed.users);
  });

  it("detects initial source failures and authorization changes without a successful snapshot", async () => {
    const f = fixture();
    const row = f.state.users[0];
    f.state.users = [];
    const before = await f.repository.automaticRevisions(scope);
    f.state.users = [{ ...row, generation_id: null, observed_at: null, report_refresh_date: null,
      attempt_status: "permission_required", message: "No saved source or delegated permission." }];
    const failed = await f.repository.automaticRevisions(scope);
    expect(failed.users).not.toBe(before.users);
    f.state.users[0].attempt_status = "waiting_authorization";
    expect((await f.repository.automaticRevisions(scope)).users).not.toBe(failed.users);
  });

  it.each(["directory", "app_activity"] as const)("detects %s expiry and remains stable after the boundary", async source => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    const row = f.state.users.find(value => value.source === source)!;
    row.generation_id = null;
    row.observed_at = null;
    row.report_refresh_date = null;
    f.state.markers = f.state.markers.filter(value => value.source !== source);
    const expired = await f.repository.automaticRevisions(scope);
    expect(expired.users).not.toBe(before.users);
    expect(expired.graph_packages).toBe(before.graph_packages);
    if (source === "directory") expect(expired.power_platform).not.toBe(before.power_platform);
    else expect(expired.power_platform).toBe(before.power_platform);
    expect(await f.repository.automaticRevisions(scope)).toEqual(expired);
  });

  it.each(["graph_packages", "graph_package_details", "power_platform", "agent_people"])(
    "keeps Users stable when %s expires or is withdrawn",
    async source => {
      const f = fixture();
      const before = await f.repository.automaticRevisions(scope);
      f.state.markers = f.state.markers.filter(row => row.source !== (source === "graph_package_details" ? "graph_packages" : source));
      const expired = await f.repository.automaticRevisions(scope);
      const changed = source.startsWith("graph_") ? "graph_packages" : "power_platform";
      expect(expired[changed]).not.toBe(before[changed]);
      expect(expired.users).toBe(before.users);
      expect(await f.repository.automaticRevisions(scope)).toEqual(expired);
    },
  );

  it("invalidates Users once when retained app metrics become stale, not on every minute check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const boundary = Date.parse("2026-09-28T23:59:59.999Z");
    vi.setSystemTime(boundary - 60_001);
    const f = fixture();
    const fresh = await f.repository.automaticRevisions(scope);
    vi.setSystemTime(boundary - 1);
    expect(await f.repository.automaticRevisions(scope)).toEqual(fresh);
    vi.setSystemTime(boundary);
    const stale = await f.repository.automaticRevisions(scope);
    expect(stale.users).not.toBe(fresh.users);
    expect(stale.graph_packages).toBe(fresh.graph_packages);
    expect(stale.power_platform).toBe(fresh.power_platform);
    vi.setSystemTime(boundary + 60_000);
    expect(await f.repository.automaticRevisions(scope)).toEqual(stale);
  });

  it("hashes only current typed heads and scoped people metadata, never predecessor payloads", async () => {
    const f = fixture();
    const observed = await readAutomaticInventoryRevisions(scope, f.database);
    for (const source of ["graph_packages", "power_platform"] as const) {
      const hash = createHash("sha256").update(JSON.stringify(["inventory-observer-v3", source, scope.tenantId, scope.principalId]));
      for (const row of f.state.markers.filter(row => row.source === "canonical"
        || (row.source === "graph_packages") === (source === "graph_packages"))) hash.update(JSON.stringify(row));
      expect(observed[source]).toBe(hash.digest("hex"));
    }
    const sql = f.query.mock.calls.map(([text]) => String(text)).join("\n");
    expect(sql).toContain("data_generation_heads");
    expect(sql).toContain("inventory_people_revisions");
    expect(sql).not.toMatch(/package_inventory_snapshots|power_platform_inventory_snapshots|package_detail_cache|object_id/);
  });

  it("scopes empty dataset revisions and rejects missing account scope", async () => {
    const f = fixture();
    f.state.markers = [];
    f.state.users = [];
    const before = await f.repository.automaticRevisions(scope);
    const other = await f.repository.automaticRevisions({ ...scope, principalId: "other-reader" });
    for (const key of ["graph_packages", "power_platform", "users"] as const) expect(other[key]).not.toBe(before[key]);
    await expect(f.repository.automaticRevisions({ ...scope, tenantId: "" })).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  it("propagates serialization conflicts without replay or weaker pool reads", async () => {
    const f = fixture(), implementation = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (text, values) => {
      if (String(text).includes("SELECT requested.source")) throw Object.assign(new Error("changed source"), { code: "40001" });
      return implementation(text, values);
    });
    await expect(f.repository.automaticRevisions(scope)).rejects.toMatchObject({ status: 503, code: "data_read_conflict" });
    expect(f.query.mock.calls.filter(([text]) => text === "BEGIN ISOLATION LEVEL REPEATABLE READ")).toHaveLength(1);
    expect(f.query.mock.calls.filter(([text]) => text === "ROLLBACK")).toHaveLength(1);
    expect(f.database.query).not.toHaveBeenCalled();
  });
});
