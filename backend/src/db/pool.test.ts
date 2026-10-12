import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseSettings, transaction } from "./pool.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { AppError } from "../errors.js";
import * as operationalState from "../services/operationalState.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("transaction publication fence", () => {
  it.each(["submit", "cancel"] as const)("rolls back native job %s after authority changes during its final write", async action => {
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => undefined);
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const failure = new AppError(401, "authorization_expired", "Synthetic authorization invalidation.");
    let current = true;
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      const sql = String(statement);
      if (sql.startsWith("INSERT INTO power_platform_refresh_jobs") || sql.startsWith("UPDATE power_platform_refresh_jobs")) current = false;
      const rows = sql.startsWith("SELECT count(*)") ? [{ count: 0 }] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    const jobs = new PowerPlatformRefreshJobs(database);
    const get = vi.spyOn(jobs, "getJob").mockRejectedValue(new Error("Uncommitted jobs must not be returned."));
    const scope = { tenantId: "tenant", principalId: "principal" };
    const assertCurrent = () => { if (!current) throw failure; };
    const result = action === "submit"
      ? jobs.submit(scope, { roleScope: "unknown", requestedTypes: ["microsoft.copilotstudio/agents"], idempotencyKey: "native-authority" }, assertCurrent)
      : jobs.cancel(scope, "11111111-1111-1111-1111-111111111111", "requested", assertCurrent);
    await expect(result).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(get).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rechecks provider admissions before committing native job submission without an optional caller fence", async () => {
    let closed = false;
    const failure = new AppError(503, "maintenance", "Synthetic closed admissions.");
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => { if (closed) throw failure; });
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      const sql = String(statement);
      if (sql.startsWith("INSERT INTO power_platform_refresh_jobs")) closed = true;
      const rows = sql.startsWith("SELECT count(*)") ? [{ count: 0 }] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    });
    const jobs = new PowerPlatformRefreshJobs(database);
    await expect(jobs.submit({ tenantId: "tenant", principalId: "principal" }, {
      roleScope: "unknown", requestedTypes: ["microsoft.copilotstudio/agents"], idempotencyKey: "native-admissions",
    })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back when authority changes between completing work and dispatching COMMIT", async () => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const result = { command: "", oid: 0, fields: [], rowCount: 0, rows: [] };
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const query = vi.spyOn(client, "query").mockImplementation(async () => result);
    const failure = new Error("Synthetic authorization invalidation.");
    let current = true;
    const beforeCommit = vi.fn(() => { if (!current) throw failure; });

    await expect(transaction(database, async () => {
      beforeCommit();
      queueMicrotask(() => { current = false; });
      return "staged configuration";
    }, undefined, beforeCommit)).rejects.toBe(failure);

    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(query.mock.calls).toEqual([["BEGIN"], ["ROLLBACK"]]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe("PostgreSQL calendar dates", () => {
  it.each(["UTC", "Asia/Dubai", "America/Los_Angeles", "Pacific/Apia"])(
    "decodes dates at UTC midnight independently of the host time zone %s", timezone => {
      vi.stubEnv("TZ", timezone);
      const parse = databaseSettings().types!.getTypeParser(pg.types.builtins.DATE, "text");
      for (const date of ["2026-07-06", "2024-02-29", "2026-03-08", "2011-12-30", "0099-01-01"]) {
        expect(parse(date).toISOString()).toBe(`${date}T00:00:00.000Z`);
      }
      expect(parse("0002-01-01 BC").toISOString()).toBe("-000001-01-01T00:00:00.000Z");
    },
  );

  it("preserves infinite dates and the standard parsers for other types", () => {
    const original = pg.types.getTypeParser(pg.types.builtins.DATE, "text");
    const types = databaseSettings().types!;
    expect(types.getTypeParser(pg.types.builtins.DATE, "text")("infinity")).toBe(Infinity);
    expect(types.getTypeParser(pg.types.builtins.DATE, "text")("-infinity")).toBe(-Infinity);
    expect(types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, "text"))
      .toBe(pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ, "text"));
    expect(types.getTypeParser(pg.types.builtins.DATE, "binary"))
      .toBe(pg.types.getTypeParser(pg.types.builtins.DATE, "binary"));
    expect(pg.types.getTypeParser(pg.types.builtins.DATE, "text")).toBe(original);
  });
});
