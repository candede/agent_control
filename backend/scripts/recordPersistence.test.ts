import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { fingerprints, prepareRestoredDatabase } from "./backup.js";
import { backupTableKeys } from "./backupInventory.js";
import { FingerprintDecoder } from "./backupFingerprintStream.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { testDatabase } from "./testDatabase.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

describe("record-backed operator persistence", () => {
  it("preserves receipt-v4 primary-key ordered hashes while streaming Unicode, duplicate and oversized rows", async () => {
    await fixture.operator.query("CREATE TABLE fingerprint_fixture(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,value text)");
    await fixture.operator.query(`INSERT INTO fingerprint_fixture(value) VALUES
      ('line'||chr(10)||'comma,quote\"'),(repeat('é',600000)),(repeat('é',600000)),('😀')`);
    const expected = (await fixture.operator.query(`SELECT count(*)::int AS count,
      encode(sha256(convert_to(string_agg(row_to_json(record)::text,E'\\n' ORDER BY id),'UTF8')),'hex') AS hash
      FROM fingerprint_fixture record`)).rows[0];
    const connect = fixture.operator.connect.bind(fixture.operator);
    let maximumRows = 0, maximumBytes = 0, fetches = 0;
    const statements: string[] = [];
    await expect(fingerprints(fixture.operator, ["fingerprint_fixture"])).rejects.toThrow("inventory is invalid");
    const inventory = backupTableKeys as Record<string, readonly string[]>;
    inventory.fingerprint_fixture = ["id"];
    const consume = FingerprintDecoder.prototype.consume;
    const chunks = vi.spyOn(FingerprintDecoder.prototype, "consume").mockImplementation(function (input) {
      fetches++;
      maximumBytes = Math.max(maximumBytes, input.length);
      return consume.call(this, input);
    });
    const completedCopies = vi.spyOn(FingerprintDecoder.prototype, "finish");
    const observer = vi.spyOn(fixture.operator, "connect").mockImplementation((async () => {
      const client = await connect(), previousQuery = client.query, execute = client.query.bind(client);
      client.query = ((text: string | pg.Query, values?: unknown[]) => {
        if (typeof text !== "string") { statements.push("COPY"); return execute(text); }
        return execute(text, values).then(result => {
        statements.push(text.split(/\s/, 1)[0]);
        maximumRows = Math.max(maximumRows, result.rows.length);
        maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(result.rows)));
        return result;
        });
      }) as typeof client.query;
      const release = client.release;
      client.release = (...args: Parameters<typeof release>) => {
        client.query = previousQuery; client.release = release; release.apply(client, args);
      };
      return client;
    }) as typeof fixture.operator.connect);
    try {
      expect(await fingerprints(fixture.operator, ["fingerprint_fixture"])).toEqual({ fingerprint_fixture: expected });
      expect(fetches).toBeGreaterThan(4);
      expect(maximumRows).toBeLessThanOrEqual(4);
      expect(maximumBytes).toBeLessThanOrEqual(1024 ** 2);
      expect(statements[0]).toBe("BEGIN");
      expect(statements.at(-1)).toBe("COMMIT");
      expect(completedCopies).toHaveBeenCalledOnce();
      expect(statements.filter(statement => statement === "COPY")).toHaveLength(1);
    } finally {
      observer.mockRestore();
      chunks.mockRestore(); completedCopies.mockRestore();
      delete inventory.fingerprint_fixture;
      await fixture.operator.query("DROP TABLE fingerprint_fixture");
    }
  });

  it("requires an explicit repeatable-read client and preserves empty-table hashes", async () => {
    const client = await fixture.operator.connect();
    try {
      await expect(fingerprints(client, ["official_usage_artifacts"])).rejects.toThrow("repeatable-read");
    } finally { client.release(); }
    expect(await fingerprints(fixture.operator, ["official_usage_artifacts"])).toEqual({
      official_usage_artifacts: { count: 0, hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    });
  });

  it("cancels restored native ingestion ownership and keeps the target in maintenance", async () => {
    const restored = await testDatabase();
    const identity = { ...selectionIdentity, tenantId: `restore-ingestion-${randomUUID()}` };
    const imports = new OfficialReportImports(restored.runtime);
    const upload = await imports.open(identity, { bundleId: randomUUID() });
    try {
      await prepareRestoredDatabase(fixture.operator, restored.operator, new Date());
      expect((await restored.runtime.query("SELECT state,stored_bytes::text FROM official_usage_ingestions WHERE id=$1", [upload.id])).rows[0])
        .toEqual({ state: "cancelled", stored_bytes: "0" });
      expect((await restored.runtime.query("SELECT epoch::text FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2",
        [identity.tenantId, identity.principalId])).rows[0].epoch).toBe("1");
      expect((await restored.runtime.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0])
        .toEqual({ mode: "maintenance", provider_work_enabled: false });
    } finally {
      await upload.cancel();
      await restored.close();
    }
  });

  it("reviews more than one SQL page without retaining tenant arrays or resurrecting changed ownership", async () => {
    const restored = await testDatabase(), prefix = `restore-bounded-${randomUUID()}-`;
    const changed: string[] = [];
    try {
      for (let offset = 0; offset < 551; offset += 250) {
        const rows = Array.from({ length: Math.min(250, 551 - offset) }, (_, index) => ({
          id: randomUUID(), tenant: `${prefix}${offset + index}`, principal: `principal-${offset + index}`,
        }));
        if (!offset) changed.push(rows[0].id, rows[1].id);
        for (const database of [fixture.operator, restored.operator]) {
          const encoded = JSON.stringify(rows);
          await database.query(`INSERT INTO data_principal_epochs(tenant_id,principal_id)
            SELECT tenant,principal FROM jsonb_to_recordset($1::jsonb) AS seed(tenant text,principal text)`, [encoded]);
          await database.query(`INSERT INTO official_usage_state(tenant_id)
            SELECT tenant FROM jsonb_to_recordset($1::jsonb) AS seed(tenant text)`, [encoded]);
          await database.query(`INSERT INTO copilot_quarantine_status_observations(
            id,tenant_id,principal_id,resource_native_id,environment_id,bot_id,is_bot_quarantined,provider_updated_at,correlation_id)
            SELECT id,tenant,principal,'synthetic-resource','synthetic-environment','synthetic-bot',false,
              '2026-09-09T00:00:00Z',id FROM jsonb_to_recordset($1::jsonb) AS seed(id uuid,tenant text,principal text)`, [encoded]);
        }
      }
      await fixture.operator.query("DELETE FROM copilot_quarantine_status_observations WHERE id=$1", [changed[0]]);
      await fixture.operator.query("UPDATE copilot_quarantine_status_observations SET principal_id='new-owner' WHERE id=$1", [changed[1]]);
      let maximumRows = 0, maximumBytes = 0, maximumMutation = 0, reviewPages = 0;
      const observers = [fixture.operator, restored.operator].map(database => {
        const originals = new Map<pg.PoolClient, pg.PoolClient["query"]>();
        const acquire = (client: pg.PoolClient) => {
          if (originals.has(client)) return;
          originals.set(client, client.query);
          const execute = client.query.bind(client);
          const observe = <T extends pg.QueryResult | pg.QueryResult[]>(text: string, values: unknown[] | undefined, result: T): T => {
            for (const statement of Array.isArray(result) ? result : [result]) {
              maximumRows = Math.max(maximumRows, statement.rows.length);
              maximumBytes = Math.max(maximumBytes, Buffer.byteLength(JSON.stringify(statement.rows)), Buffer.byteLength(JSON.stringify(values ?? [])));
              if (["UPDATE", "DELETE"].includes(statement.command)) maximumMutation = Math.max(maximumMutation, statement.rowCount ?? 0);
            }
            if (text.includes("FROM official_usage_state WHERE")) reviewPages++;
            return result;
          };
          client.query = ((text: string, values?: unknown[], callback?: (error: Error | null, result: pg.QueryResult) => void) => {
            if (callback) return execute(text, values, (error, result) => callback(error, result && observe(text, values, result)));
            return execute(text, values).then(result => observe(text, values, result));
          }) as typeof client.query;
        };
        database.on("acquire", acquire);
        return () => {
          database.off("acquire", acquire);
          for (const [client, query] of originals) client.query = query;
        };
      });
      try {
        await prepareRestoredDatabase(fixture.operator, restored.operator, new Date());
        expect(maximumRows).toBe(250);
        expect(maximumBytes).toBeLessThanOrEqual(1024 ** 2);
        expect(maximumMutation).toBe(250);
        expect(reviewPages).toBeGreaterThanOrEqual(4);
      } finally { observers.forEach(restore => restore()); }
      expect((await restored.operator.query("SELECT count(*)::int AS count FROM data_principal_epochs WHERE epoch=1")).rows[0].count).toBe(551);
      expect((await restored.operator.query("SELECT count(*)::int AS count FROM copilot_quarantine_status_observations")).rows[0].count).toBe(549);
      expect((await restored.operator.query("SELECT id FROM copilot_quarantine_status_observations WHERE id=ANY($1::uuid[])", [changed])).rows).toEqual([]);
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM data_principal_epochs WHERE tenant_id LIKE $1 AND epoch=0", [`${prefix}%`])).rows[0].count).toBe(551);
      expect((await restored.operator.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0])
        .toEqual({ mode: "maintenance", provider_work_enabled: false });
    } finally { await restored.close(); }
  });
});
