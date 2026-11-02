import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupTableKeys } from "../../scripts/backupInventory.js";
import { schemaSql } from "./schema.js";
import { paidEntitlementSql, userSourceFactsSql } from "./userSources.js";
import { OfficeAppAdoptionRepository } from "./officeAppAdoption.js";
import { dataLimits, digest, encodeBatch } from "./dataBounds.js";
import type { GenerationLease } from "./dataGenerations.js";
import type { OfficeStatus } from "../types/officeAppAdoption.js";
import { dataWorkMetricScope, flushDataWorkMetrics } from "../services/dataMetrics.js";

afterEach(() => { flushDataWorkMetrics(); vi.restoreAllMocks(); });
describe("Office storage and matching contract", () => {
  it("wires immutable tenant-owned retained evidence into current schema, roots, clear, grants and backup", () => {
    for (const table of ["office_observations","office_person_facts","office_group_facts"]) expect(schemaSql).toContain(`CREATE TABLE ${table}`);
    expect(backupTableKeys.office_observations).toEqual(["generation_id"]);
    expect(backupTableKeys.office_person_facts).toEqual(["generation_id","identity"]);
    expect(backupTableKeys.office_group_facts).toEqual(["generation_id","group_id"]);
    expect(schemaSql).toContain("Historical Office snapshots contain aggregates only");
    expect(schemaSql).toContain("Office evidence is immutable");
    expect(schemaSql).toContain("office_observation");
    expect(schemaSql).toContain("office_source_clear");
    expect(schemaSql).not.toContain("REFERENCES data_generations(directory_generation_id");
  });
  it("reuses the exact paid classifier and alias-counted source relation", () => {
    expect(userSourceFactsSql(false,true)).toContain(paidEntitlementSql("d"));
    expect(userSourceFactsSql(false,true)).toContain("HAVING sum(activity.matches)=1 AND bool_and(directory.matches=1)");
    expect(userSourceFactsSql(false,true)).toContain("activity_candidate_exists");
    expect(userSourceFactsSql()).not.toContain("activity_candidate_exists");
  });
});

describe("Office capture Bind-byte boundaries without a database", () => {
  function capture(largePage: "people" | "groups") {
    const database = new pg.Pool({ max: 4 });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query"));
    const repository = new OfficeAppAdoptionRepository(database);
    const now = new Date(), refresh = now.toISOString().slice(0, 10), tenantId = "office-byte-tenant";
    const active: GenerationLease = {
      id: "10000000-0000-4000-8000-000000000001", scopeId: "10000000-0000-4000-8000-000000000002",
      tenantId, owner: "10000000-0000-4000-8000-000000000003", version: 1,
      epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
    };
    const weekly = { ...active, id: "20000000-0000-4000-8000-000000000001", scopeId: "20000000-0000-4000-8000-000000000002" };
    vi.spyOn(repository.generations, "begin").mockResolvedValueOnce(active).mockResolvedValueOnce(weekly);
    vi.spyOn(repository.generations, "fence").mockResolvedValue({ state: "staging" });
    vi.spyOn(repository.generations, "renew").mockResolvedValue(undefined);
    vi.spyOn(repository.generations, "abort").mockResolvedValue(undefined);
    vi.spyOn(repository.generations, "publish").mockResolvedValue("1");
    const sourceRows: {
      id: string; scope_id: string; source: string; epoch: string; revision: string;
      observed_at: Date; expires_at: Date; report_refresh_date: string; report_period: string;
      office_vector: string | null; office_status: OfficeStatus["state"] | null; office_error_code: string | null;
    }[] = ["directory", "app_activity"].map((source, index) => ({
      id: `source-${index}`, scope_id: `scope-${index}`, source, epoch: "0", revision: "1",
      observed_at: now, expires_at: new Date(now.getTime() + 3600_000),
      report_refresh_date: refresh, report_period: "D28", office_vector: null, office_status: null, office_error_code: null,
    }));
    const label = (index: number) => largePage === "people" ? "界".repeat(1024)
      : `${"界".repeat(1021)}${String(index).padStart(3, "0")}`;
    const facts = Array.from({ length: 250 }, (_, index) => ({
      identity: String(index).padStart(3, "0"), upn: `person-${index}@example.invalid`,
      display_name: "界".repeat(largePage === "people" ? 1024 : 1),
      company: label(index), department: label(index),
      entitlement: "paid_active", service_state: "enabled", directory_residual: {}, activity_residual: {},
      activity_identity: `activity-${index}`, report_refresh_date: refresh, activity_period: "D28",
      word_date: refresh, excel_date: null, powerpoint_date: null, outlook_date: null, onenote_date: null,
      loop_date: null, teams_date: null,
    }));
    const metrics = { licensed: "250", active: "250", pairs: "250", no_recent: "0", unknown: "0",
      word: "250", excel: "0", powerpoint: "0", outlook: "0", onenote: "0", loop: "0", teams: "0" };
    const groups = Array.from({ length: largePage === "groups" ? 250 : 1 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      company: label(index), department: label(index), ...metrics,
      ...(largePage === "groups" ? { licensed: "1", active: "1", pairs: "1", word: "1" } : {}),
    }));
    const result = (rows: pg.QueryResultRow[] = [], command = "SELECT"): pg.QueryResult =>
      ({ command, rows, rowCount: rows.length, fields: [], oid: 0 });
    const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement === "COMMIT") return result([], "COMMIT");
      if (["BEGIN", "BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"].includes(statement)) return result();
      if (statement.startsWith("SELECT pg_advisory_xact_lock")) return result();
      if (statement.startsWith("SELECT g.id,s.id AS scope_id")) return result(sourceRows);
      if (statement.startsWith("SELECT s.id FROM data_scope_epochs")) return result([{ id: values?.[0] }]);
      if (statement.includes('d.identity COLLATE "C">$4')) {
        const offset = values?.[3] === "" ? 0 : Number(values?.[3]) + 1;
        return result(facts.slice(offset, offset + (largePage === "people" ? 250 : 100)));
      }
      if (statement.includes(" AS mixed")) return result([{ reported: facts.length, retained: 0, mixed: 0 }]);
      if (statement.startsWith("SELECT payload->>'groupId' AS id")) return result(values?.[1] === "" ? groups : []);
      if (statement.startsWith("SELECT count(*)::text AS licensed")) return result([metrics]);
      if (statement.startsWith("SELECT g.id,g.content_hash") || statement.startsWith("SELECT g.content_hash")
        || statement.includes("FROM office_observations o JOIN data_generations")) return result();
      if (statement.startsWith("INSERT INTO office_") || statement.startsWith("UPDATE office_")
        || statement.startsWith("UPDATE user_source_attempts") || statement.startsWith("UPDATE data_generations")) return result();
      throw new Error(`Unexpected Office query: ${statement}`);
    });
    vi.spyOn(client, "query").mockImplementation(query);
    return { repository, database, client, query, tenantId, facts, groups, active, weekly, sourceRows, result };
  }

  it.each(["committed", "rolled-back", "cleanup-failed"] as const)(
    "owns Office batch metrics at the write transaction even when an enclosing scope is discarded: %s", async outcome => {
      const { repository, database, client, query, tenantId, result } = capture("people");
      const scope = dataWorkMetricScope();
      const failure = new Error("Synthetic Office batch release failure.");
      let personWrite = false;
      const base = query.getMockImplementation()!;
      query.mockImplementation(async (statement, values) => {
        const response = await base(statement, values);
        if (String(statement).startsWith("INSERT INTO office_person_facts")) personWrite = true;
        if (statement === "COMMIT" && personWrite) {
          personWrite = false;
          if (outcome === "rolled-back") return result([], "ROLLBACK");
          if (outcome === "cleanup-failed") client.release.mockImplementationOnce(() => { throw failure; });
        }
        return response;
      });
      try {
        const pending = scope.run(() => repository.reconcile(tenantId));
        if (outcome === "rolled-back") await expect(pending).rejects.toThrow("data_transaction_not_committed");
        else if (outcome === "cleanup-failed") await expect(pending).rejects.toBe(failure);
        else await expect(pending).resolves.toMatchObject({ state: "published", copied: 250 });
        scope.discard();
        const snapshot = flushDataWorkMetrics().filter(value => value.stage === "office_capture");
        if (outcome === "rolled-back") expect(snapshot).toEqual([]);
        else {
          const batches = query.mock.calls.filter(([statement]) =>
            String(statement).startsWith("INSERT INTO office_person_facts")).map(([, values]) => {
            const rows: unknown[] = JSON.parse(String(values?.[3]));
            return { ...encodeBatch(rows, values?.slice(0, 3)), rowCount: rows.length };
          });
          expect(batches.length).toBeGreaterThan(0);
          expect(snapshot).toEqual([{ stage: "office_capture", count: batches.length,
            rows: Math.max(...batches.map(batch => batch.rowCount)), bytes: Math.max(...batches.map(batch => batch.bytes)) }]);
        }
      } finally { scope.discard(); await database.end(); }
    },
  );

  it("admits supported multibyte directory labels within the persisted person payload bound", async () => {
    const { repository, database, query, tenantId } = capture("people");
    try {
      await repository.reconcile(tenantId);
      const bound = Number(schemaSql.match(/CREATE TABLE office_person_facts[\s\S]*?octet_length\(payload::text\)<=(\d+)/)?.[1]);
      expect(bound).toBeGreaterThan(0);
      for (const [, values] of query.mock.calls.filter(([statement]) =>
        String(statement).startsWith("INSERT INTO office_person_facts"))) {
        const people: Record<string, unknown>[] = JSON.parse(String(values?.[3]));
        for (const person of people) {
          const payload = { ...person, groupId: "a".repeat(64) };
          expect(Buffer.byteLength(JSON.stringify(payload, null, 1))).toBeLessThanOrEqual(bound);
          const maximum = { ...payload, identity: "\u0001".repeat(512), userPrincipalName: "\u0001".repeat(512),
            displayName: "\u0001".repeat(1024), company: "\u0001".repeat(1024), department: "\u0001".repeat(1024) };
          expect(Buffer.byteLength(JSON.stringify(maximum, null, 1))).toBeLessThanOrEqual(bound);
        }
      }
    } finally { await database.end(); }
  });

  it.each(["waiting_sources", "unavailable", "idle"] as const)(
    "honors cancellation during the initial source read before returning %s", async state => {
      const { repository, database, query, tenantId, sourceRows } = capture("people");
      if (state === "waiting_sources") sourceRows.splice(0, 1);
      else if (state === "unavailable") sourceRows[0].expires_at = new Date(0);
      else {
        sourceRows[1].office_status = "available";
        sourceRows[1].office_vector = digest(JSON.stringify(sourceRows.map(row =>
          [row.scope_id, row.epoch, row.id, row.revision])));
      }
      const controller = new AbortController(), failure = new Error("cancelled initial source read");
      const base = query.getMockImplementation()!;
      query.mockImplementation(async (statement, values) => {
        const response = await base(statement, values);
        if (String(statement).startsWith("SELECT g.id,s.id AS scope_id")) controller.abort(failure);
        return response;
      });
      try {
        await expect(repository.reconcile(tenantId, { signal: controller.signal })).rejects.toBe(failure);
        expect(query).toHaveBeenCalledWith("ROLLBACK");
        expect(repository.generations.begin).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([statement]) =>
          String(statement).startsWith("UPDATE user_source_attempts"))).toBe(false);
      } finally { await database.end(); }
    },
  );

  it.each(["waiting_sources", "unavailable", "idle", "office_report_regressed"] as const)(
    "preserves the uncancelled terminal source path: %s", async state => {
      const { repository, database, query, tenantId, sourceRows, result } = capture("people");
      if (state === "waiting_sources") sourceRows.splice(0, 1);
      else if (state === "unavailable") sourceRows[0].expires_at = new Date(0);
      else if (state === "idle") {
        sourceRows[1].office_status = "available";
        sourceRows[1].office_vector = digest(JSON.stringify(sourceRows.map(row =>
          [row.scope_id, row.epoch, row.id, row.revision])));
      } else {
        const base = query.getMockImplementation()!;
        query.mockImplementation((statement, values) => {
          if (String(statement).startsWith("SELECT o.report_refresh_date")) {
            const nextDay = new Date(`${sourceRows[1].report_refresh_date}T00:00:00Z`);
            nextDay.setUTCDate(nextDay.getUTCDate() + 1);
            return Promise.resolve(result([{ refresh: nextDay.toISOString().slice(0, 10) }]));
          }
          return base(statement, values);
        });
      }
      try {
        await expect(repository.reconcile(tenantId, { signal: new AbortController().signal })).resolves.toEqual({
          state: state === "office_report_regressed" ? "unavailable" : state, copied: 0,
        });
        expect(repository.generations.begin).not.toHaveBeenCalled();
        expect(query.mock.calls.some(([statement]) => statement === "ROLLBACK")).toBe(false);
      } finally { await database.end(); }
    },
  );

  it("does not acknowledge a regressed report cancelled during the latest-observation read", async () => {
    const { repository, database, query, tenantId, sourceRows, result } = capture("people");
    const controller = new AbortController(), failure = new Error("cancelled latest-observation read");
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (String(statement).startsWith("SELECT o.report_refresh_date")) {
        const nextDay = new Date(`${sourceRows[1].report_refresh_date}T00:00:00Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        controller.abort(failure);
        return result([{ refresh: nextDay.toISOString().slice(0, 10) }]);
      }
      return base(statement, values);
    });
    try {
      await expect(repository.reconcile(tenantId, { signal: controller.signal })).rejects.toBe(failure);
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(repository.generations.begin).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([statement, values]) =>
        String(statement).startsWith("UPDATE user_source_attempts") && values?.[1] === "unavailable")).toBe(false);
    } finally { await database.end(); }
  });

  it.each(["waiting_sources", "unavailable", "office_report_regressed"] as const)(
    "rolls back a cancelled terminal source-status checkpoint: %s", async state => {
      const { repository, database, query, tenantId, sourceRows, result } = capture("people");
      if (state === "waiting_sources") sourceRows.splice(0, 1);
      else if (state === "unavailable") sourceRows[0].expires_at = new Date(0);
      const controller = new AbortController(), failure = new Error("cancelled source-status checkpoint");
      const base = query.getMockImplementation()!;
      query.mockImplementation(async (statement, values) => {
        if (state === "office_report_regressed" && String(statement).startsWith("SELECT o.report_refresh_date")) {
          const nextDay = new Date(`${sourceRows[1].report_refresh_date}T00:00:00Z`);
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          return result([{ refresh: nextDay.toISOString().slice(0, 10) }]);
        }
        const response = await base(statement, values);
        if (String(statement).startsWith("UPDATE user_source_attempts")
          && values?.[1] === (state === "waiting_sources" ? "waiting_sources" : "unavailable")) controller.abort(failure);
        return response;
      });
      try {
        await expect(repository.reconcile(tenantId, { signal: controller.signal })).rejects.toBe(failure);
        expect(query).toHaveBeenCalledWith("ROLLBACK");
        expect(repository.generations.begin).not.toHaveBeenCalled();
        const checkpoint = query.mock.calls.findIndex(([statement, values]) =>
          String(statement).startsWith("UPDATE user_source_attempts")
          && values?.[1] === (state === "waiting_sources" ? "waiting_sources" : "unavailable"));
        expect(query.mock.calls[checkpoint + 1]).toEqual(["ROLLBACK"]);
      } finally { await database.end(); }
    },
  );

  it.each(["source", "replay"] as const)("does not acknowledge a semantic replay cancelled during the final %s read", async stage => {
    const { repository, database, query, tenantId, active, result } = capture("people");
    try {
      await repository.reconcile(tenantId);
      const hash = query.mock.calls.find(([statement]) =>
        String(statement).startsWith("UPDATE data_generations SET state='validating'"))?.[1]?.[1];
      expect(hash).toEqual(expect.any(String));
      vi.mocked(repository.generations.begin).mockResolvedValueOnce(active);
      const controller = new AbortController(), failure = new Error("cancelled final source read");
      const base = query.getMockImplementation()!;
      query.mockImplementation(async (statement, values) => {
        const response = await base(statement, values);
        if (stage === "source" && String(statement).includes('d.identity COLLATE "C">$4') && !response.rows.length) controller.abort(failure);
        if (String(statement).startsWith("SELECT g.id,g.content_hash")) {
          if (stage === "replay") controller.abort(failure);
          return result([{ id: "previous", content_hash: hash }]);
        }
        return response;
      });
      await expect(repository.reconcile(tenantId, { signal: controller.signal })).rejects.toBe(failure);
      expect(repository.generations.abort).toHaveBeenCalledOnce();
      if (stage === "source") expect(query.mock.calls.some(([statement, values]) =>
        String(statement).startsWith("UPDATE user_source_attempts") && values?.[1] === "available")).toBe(false);
      else expect(query).toHaveBeenCalledWith("ROLLBACK");
    } finally { await database.end(); }
  });

  it("attempts cleanup of both paired leases and status even when one abort fails", async () => {
    const { repository, database, query, tenantId, active, weekly } = capture("people");
    const failure = new Error("publication failed"), cleanup = new Error("current cleanup failed");
    vi.mocked(repository.generations.publish).mockRejectedValue(failure);
    vi.mocked(repository.generations.abort).mockRejectedValueOnce(cleanup).mockResolvedValueOnce(undefined);
    try {
      await expect(repository.reconcile(tenantId)).rejects.toMatchObject({
        message: "office_derivation_cleanup_failed", errors: [failure, cleanup],
      });
      expect(repository.generations.abort).toHaveBeenNthCalledWith(1, active, undefined);
      expect(repository.generations.abort).toHaveBeenNthCalledWith(2, weekly, undefined);
      expect(query.mock.calls.some(([statement, values]) =>
        String(statement).startsWith("UPDATE user_source_attempts") && values?.[1] === "failed")).toBe(true);
      const statusRead = query.mock.calls.map(([statement]) => String(statement).startsWith("SELECT g.id,s.id AS scope_id")).lastIndexOf(true);
      expect(query.mock.calls[statusRead - 1]).toEqual([
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${tenantId}`],
      ]);
    } finally { await database.end(); }
  });

  it("still cleans both leases when the publication acknowledgment probe fails", async () => {
    const { repository, database, query, tenantId, active, weekly, sourceRows } = capture("people");
    const failure = new Error("publication failed"), probe = new Error("acknowledgment unavailable");
    vi.mocked(repository.generations.publish).mockImplementation(async () => {
      sourceRows[1].office_status = "available";
      sourceRows[1].office_vector = digest(JSON.stringify(sourceRows.map(row =>
        [row.scope_id, row.epoch, row.id, row.revision])));
      throw failure;
    });
    const base = query.getMockImplementation()!;
    query.mockImplementation((statement, values) => String(statement).startsWith("SELECT g.id FROM data_generation_heads")
      ? Promise.reject(probe) : base(statement, values));
    try {
      await expect(repository.reconcile(tenantId)).rejects.toMatchObject({
        message: "office_derivation_cleanup_failed", errors: [failure, probe],
      });
      expect(repository.generations.abort).toHaveBeenNthCalledWith(1, active, undefined);
      expect(repository.generations.abort).toHaveBeenNthCalledWith(2, weekly, undefined);
    } finally { await database.end(); }
  });

  it("does not downgrade a concurrently acknowledged vector after aborting failed work", async () => {
    const { repository, database, query, tenantId, sourceRows } = capture("people");
    const failure = new Error("publication failed");
    vi.mocked(repository.generations.publish).mockRejectedValue(failure);
    vi.mocked(repository.generations.abort).mockImplementation(async () => {
      sourceRows[1].office_status = "available";
      sourceRows[1].office_vector = digest(JSON.stringify(sourceRows.map(row =>
        [row.scope_id, row.epoch, row.id, row.revision])));
    });
    try {
      await expect(repository.reconcile(tenantId)).rejects.toBe(failure);
      expect(query.mock.calls.some(([statement, values]) =>
        String(statement).startsWith("UPDATE user_source_attempts") && values?.[1] === "failed")).toBe(false);
    } finally { await database.end(); }
  });

  it.each(["published", "noop"] as const)("preserves an acknowledged %s after its response is lost", async state => {
    const { repository, database, query, tenantId, active, sourceRows, result } = capture("people");
    vi.mocked(repository.generations.publish).mockImplementation(async () => {
      sourceRows[1].office_status = "available";
      sourceRows[1].office_vector = digest(JSON.stringify(sourceRows.map(row =>
        [row.scope_id, row.epoch, row.id, row.revision])));
      throw new Error("committed response lost");
    });
    const base = query.getMockImplementation()!;
    query.mockImplementation((statement, values) => String(statement).startsWith("SELECT g.id FROM data_generation_heads")
      ? Promise.resolve(result([{ id: state === "published" ? active.id : "previous" }])) : base(statement, values));
    try {
      await expect(repository.reconcile(tenantId)).resolves.toEqual({ state, copied: 250 });
      expect(repository.generations.abort).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([statement, values]) =>
        String(statement).startsWith("UPDATE user_source_attempts") && values?.[1] === "failed")).toBe(false);
    } finally { await database.end(); }
  });

  it("automatically retries failed preparation from the same saved sources", async () => {
    const { repository, database, tenantId, active, weekly } = capture("people");
    const failure = new Error("interrupted preparation");
    vi.mocked(repository.generations.publish).mockRejectedValueOnce(failure).mockResolvedValueOnce("1");
    try {
      await expect(repository.reconcile(tenantId)).rejects.toBe(failure);
      vi.mocked(repository.generations.begin).mockResolvedValueOnce(active).mockResolvedValueOnce(weekly);
      await expect(repository.recover(tenantId)).resolves.toBeUndefined();
      expect(repository.generations.publish).toHaveBeenCalledTimes(2);
      expect(repository.generations.abort).toHaveBeenCalledTimes(2);
    } finally { await database.end(); }
  });

  it.each(["people", "groups"] as const)("splits a supported 250-%s page into fully charged bounded inserts", async largePage => {
    const { repository, database, query, tenantId, facts, groups, active, weekly } = capture(largePage);
    try {
      await expect(repository.reconcile(tenantId)).resolves.toEqual({ state: "published", copied: facts.length });
      const table = largePage === "people" ? "office_person_facts" : "office_group_facts";
      const targets = largePage === "people" ? [active] : [active, weekly];
      const personInserts = query.mock.calls.filter(([statement]) =>
        String(statement).startsWith("INSERT INTO office_person_facts"));
      const personBytes = personInserts.reduce((total, [, values]) => {
        const records: unknown[] = JSON.parse(String(values?.[3]));
        return total + encodeBatch(records, values?.slice(0, 3)).bytes + 64 * records.length;
      }, 0);
      const header = query.mock.calls.find(([statement, values]) =>
        String(statement).startsWith("INSERT INTO office_observations") && values?.[0] === weekly.id)?.[1];
      const headerBytes = Buffer.byteLength(JSON.stringify([
        header?.[3], "D28", "v2", JSON.parse(String(header?.[4])), JSON.parse(String(header?.[9])),
      ]));
      for (const target of targets) {
        const inserts = query.mock.calls.filter(([statement, values]) =>
          String(statement).startsWith(`INSERT INTO ${table}`) && values?.[0] === target.id);
        expect(inserts.length).toBeGreaterThan(1);
        let expectedBytes = largePage === "people" ? 2048
          : 2048 + headerBytes + (target.id === active.id ? personBytes : 0);
        let expectedRows = largePage === "people" || target.id === weekly.id ? 0 : facts.length;
        const rows = inserts.flatMap(([, values]) => {
          const records: unknown[] = JSON.parse(String(values?.[3]));
          expect(records.length).toBeLessThanOrEqual(dataLimits.batchRows);
          const batch = encodeBatch(records, values?.slice(0, 3));
          expect(batch.bytes).toBeLessThanOrEqual(dataLimits.batchBytes);
          expectedBytes += batch.bytes + 64 * records.length;
          expectedRows += records.length;
          expect(query.mock.calls).toContainEqual([
            "UPDATE data_generations SET byte_count=$2,row_count=$3 WHERE id=$1",
            [target.id, expectedBytes, expectedRows],
          ]);
          return records;
        });
        expect(rows).toHaveLength(largePage === "people" ? facts.length : groups.length);
        expect(rows.map(row => {
          if (!row || typeof row !== "object") throw new Error("Invalid captured row");
          return "identity" in row ? row.identity : "id" in row ? row.id : undefined;
        })).toEqual(largePage === "people" ? facts.map(row => row.identity) : groups.map(row => row.id));
      }
      expect(repository.generations.publish).toHaveBeenCalledOnce();
      const paired = vi.mocked(repository.generations.begin).mock.calls.map(([input]) => input);
      expect(paired.map(input => input.scope.source)).toEqual(["office_app_adoption", "office_history"]);
      expect(paired[1].jobId).toBe(paired[0].jobId);
      expect(repository.generations.publish).toHaveBeenCalledWith(active, expect.objectContaining({ relatedLeases: [weekly] }));
    } finally { await database.end(); }
  });
});
