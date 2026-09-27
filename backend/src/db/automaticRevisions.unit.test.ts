import { createHash } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSyncRepository } from "./dataSync.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";

const scope = { tenantId: "tenant-revisions", principalId: "reader-revisions" };
const observedAt = new Date("2026-09-24T10:00:00.000Z");
const expiresAt = new Date("2026-10-24T10:00:00.000Z");
type Marker = { source: string; id: string; observed_at: Date; expires_at: Date };
type UserSource = {
  source_id: "directory" | "app_activity";
  attempt_status: string;
  message: string;
  attempted_at: Date;
  last_success_at: Date;
  row_count: number;
  id: string | null;
  observed_at: Date | null;
  report_refresh_date: string | null;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const database = new pg.Pool();
  const state: { markers: Marker[]; users: UserSource[] } = {
    markers: ["agent_people", "directory", "graph_package_details", "graph_packages", "power_platform"].map(source => ({
      source, id: `${source}-snapshot`, observed_at: observedAt, expires_at: expiresAt,
    })),
    users: (["app_activity", "directory"] as const).map(source => ({
      source_id: source, attempt_status: "available", message: "Saved source.",
      attempted_at: observedAt, last_success_at: observedAt, row_count: 1,
      id: `${source}-snapshot`, observed_at: observedAt,
      report_refresh_date: source === "app_activity" ? "2026-09-24" : null,
    })),
  };
  const response = (rows: object[]) => ({ rows: structuredClone(rows), rowCount: rows.length, command: "", oid: 0, fields: [] });
  const query = vi.fn(async (text: unknown) => {
    if (typeof text !== "string") throw new Error("Expected SQL.");
    if (text.includes("'graph_packages' AS source")) return response(state.markers);
    if (text.includes("state.attempt_status")) return response(state.users);
    throw new Error("Unexpected automatic revision query.");
  });
  vi.spyOn(database, "query").mockImplementation(query);
  return { database, repository: new DataSyncRepository(database), state };
}

describe("automatic saved-data revision boundaries", () => {
  it("uses scoped snapshot metadata and the same linked-source availability rules as saved Users reads", async () => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    expect(await f.repository.automaticRevisions(scope)).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(["graph_packages", "power_platform", "users"]);
    for (const revision of Object.values(before)) expect(revision).toMatch(/^[a-f0-9]{64}$/);
    for (const [, values] of vi.mocked(f.database.query).mock.calls) expect(values).toEqual([scope.tenantId, scope.principalId]);
    const usersQuery = vi.mocked(f.database.query).mock.calls.map(([text]) => String(text))
      .find(text => text.includes("state.attempt_status"))!;
    expect(usersQuery).toContain("snapshot.id=state.current_snapshot_id");
    expect(usersQuery).toContain("snapshot.tenant_id=state.tenant_id");
    expect(usersQuery).toContain("snapshot.principal_id=state.principal_id");
    expect(usersQuery).toContain("snapshot.source_id=state.source_id");
    expect(usersQuery).toContain("snapshot.is_current AND snapshot.expires_at>clock_timestamp()");
    expect(usersQuery).toContain("ORDER BY state.source_id");
    expect(usersQuery.match(/snapshot_data/g)).toHaveLength(1);
    expect(usersQuery).toContain("snapshot.snapshot_data->>'reportRefreshDate'");
    expect(usersQuery).not.toMatch(/package_inventory|package_detail|power_platform|agent_people/);
  });

  it.each(["graph_packages", "graph_package_details", "power_platform", "agent_people"])(
    "%s publications do not invalidate the combined Users license/activity data",
    async source => {
      const f = fixture();
      const before = await f.repository.automaticRevisions(scope);
      const unified = await readUnifiedInventoryRevision(scope, f.database);
      f.state.markers.find(row => row.source === source)!.id += "-updated";
      const after = await f.repository.automaticRevisions(scope);
      const changed = source.startsWith("graph_") ? "graph_packages" : "power_platform";
      const unchanged = changed === "graph_packages" ? "power_platform" : "graph_packages";
      expect(after[changed]).not.toBe(before[changed]);
      expect(after[unchanged]).toBe(before[unchanged]);
      expect(after.users).toBe(before.users);
      expect(await readUnifiedInventoryRevision(scope, f.database)).not.toBe(unified);
    },
  );

  it.each(["directory", "app_activity"] as const)("invalidates only projections depending on a new %s snapshot", async source => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    f.state.users.find(row => row.source_id === source)!.id += "-updated";
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
    const row = f.state.users.find(value => value.source_id === source)!;
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
    f.state.users = [{ ...row, id: null, observed_at: null, report_refresh_date: null,
      attempt_status: "permission_required", message: "No saved source or delegated permission." }];
    const failed = await f.repository.automaticRevisions(scope);
    expect(failed.users).not.toBe(before.users);
    f.state.users[0].attempt_status = "waiting_authorization";
    expect((await f.repository.automaticRevisions(scope)).users).not.toBe(failed.users);
  });

  it.each(["directory", "app_activity"] as const)("detects %s expiry and remains stable after the boundary", async source => {
    const f = fixture();
    const before = await f.repository.automaticRevisions(scope);
    const row = f.state.users.find(value => value.source_id === source)!;
    row.id = null;
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
      f.state.markers = f.state.markers.filter(row => row.source !== source);
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

  it("does not change the full unified export/consistency revision format or dependencies", async () => {
    const f = fixture();
    const expected = createHash("sha256").update(JSON.stringify([
      "unified-agent-inventory-v5", scope.tenantId, scope.principalId, f.state.markers,
    ])).digest("hex");
    expect(await readUnifiedInventoryRevision(scope, f.database)).toBe(expected);
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
});
