import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { testDatabase } from "./testDatabase.js";
import { createLegacyAuditBackup, importLegacyAudit } from "./import-legacy-audit.js";
import { AuditLog } from "../src/services/auditLog.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const directory = join(process.cwd(), "artifacts", "test-scratch", `legacy-audit-${randomUUID()}`);
beforeAll(async () => { mkdirSync(directory, { recursive: true }); fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); rmSync(directory,{recursive:true,force:true}); });

function backup(name: string, id: string, tenant: string | null, older = false, message: string | null = null) {
  const filename = join(directory,`${name}.sqlite`);
  const sqlite = new DatabaseSync(filename);
  sqlite.exec(`CREATE TABLE audit_events (id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,scope TEXT NOT NULL,action TEXT NOT NULL,target_blocked_state INTEGER ${older ? "NOT NULL" : ""},agent_id TEXT NOT NULL,agent_display_name TEXT,actor_username TEXT NOT NULL,actor_display_name TEXT NOT NULL,actor_home_account_id TEXT NOT NULL,tenant_id TEXT,started_at TEXT NOT NULL,completed_at TEXT,status TEXT NOT NULL,message TEXT,error_code TEXT,request_path TEXT NOT NULL,metadata_json TEXT)`);
  sqlite.prepare("INSERT INTO audit_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,"legacy-operation","single","block",1,"fixture-package","Fixture","fixture@example.invalid","Fixture","fixture-principal",tenant,"2026-09-01T00:00:00.000Z","2026-09-01T00:00:01.000Z","succeeded",message,null,"/api/agents/fixture-package/block",JSON.stringify({source:"fixture"}));
  sqlite.close();
  return { filename, checksum: createHash("sha256").update(readFileSync(filename)).digest("hex") };
}

describe("standalone one-time SQLite audit importer", () => {
  it("preserves current and older rows and keeps unknown tenant history restricted", async () => {
    const sessionsBefore = Number((await fixture.operator.query("SELECT count(*) FROM sessions")).rows[0].count);
    const jobsBefore = Number((await fixture.operator.query("SELECT count(*) FROM jobs")).rows[0].count);
    const current = backup("current","current-1","fixture-tenant");
    const older = backup("older","older-1",null,true);
    expect((await importLegacyAudit(fixture.operator,current.filename,current.checksum)).rowCount).toBe(1);
    expect((await importLegacyAudit(fixture.operator,older.filename,older.checksum)).rowCount).toBe(1);
    const audit = new AuditLog({tenantId:"fixture-tenant",principalId:"fixture-principal"},fixture.runtime);
    expect(await audit.countEvents()).toBe(1);
    const unknown = await fixture.operator.query("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id IS NULL");
    expect(unknown.rows[0].count).toBe(1);
    expect((await importLegacyAudit(fixture.operator,current.filename,current.checksum)).repeated).toBe(true);
    expect(Number((await fixture.operator.query("SELECT count(*) FROM sessions")).rows[0].count)).toBe(sessionsBefore);
    expect(Number((await fixture.operator.query("SELECT count(*) FROM jobs")).rows[0].count)).toBe(jobsBefore);
  });
  it("rejects changed checksums and changed source content without partial import", async () => {
    const changed = backup("changed","current-1","fixture-tenant",false,"changed content");
    await expect(importLegacyAudit(fixture.operator,changed.filename,"a".repeat(64))).rejects.toThrow("checksum");
    await expect(importLegacyAudit(fixture.operator,changed.filename,changed.checksum)).rejects.toThrow("changed");
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM legacy_audit_imports")).rows[0].count).toBe(2);
  });
  it("rolls back interruption and malformed records, then retries cleanly", async () => {
    const interrupted = backup("interrupted","interrupted-1","fixture-tenant");
    await expect(importLegacyAudit(fixture.operator,interrupted.filename,interrupted.checksum,() => { throw new Error("interrupted"); })).rejects.toThrow("interrupted");
    expect((await fixture.operator.query("SELECT 1 FROM audit_events WHERE legacy_source_id='sqlite-audit:interrupted-1'")).rowCount).toBe(0);
    expect((await importLegacyAudit(fixture.operator,interrupted.filename,interrupted.checksum)).rowCount).toBe(1);
    const malformed = backup("malformed","malformed-1","fixture-tenant");
    const sqlite = new DatabaseSync(malformed.filename); sqlite.exec("UPDATE audit_events SET status='unknown'"); sqlite.close();
    const checksum = createHash("sha256").update(readFileSync(malformed.filename)).digest("hex");
    await expect(importLegacyAudit(fixture.operator,malformed.filename,checksum)).rejects.toThrow("Unknown");
  });

  it("preserves allowlisted legacy failure details and exact source ordering", async () => {
    const source = backup("failures","legacy-Z","fixture-tenant");
    const metadata = { errorDetails: { graph: { error: { code: "Forbidden", message: "Fixture denial", innerError: { "request-id": "fixture-request", date: "2026-09-01" } } }, retryAfterMs: 2000 } };
    const sqlite = new DatabaseSync(source.filename);
    sqlite.prepare("UPDATE audit_events SET status='failed',metadata_json=?").run(JSON.stringify(metadata));
    const insert = sqlite.prepare("INSERT INTO audit_events SELECT ?,operation_id,scope,action,target_blocked_state,agent_id,agent_display_name,actor_username,actor_display_name,actor_home_account_id,tenant_id,started_at,completed_at,status,message,error_code,request_path,metadata_json FROM audit_events WHERE id='legacy-Z'");
    insert.run("legacy-a"); insert.run("legacy_A"); sqlite.close();
    const checksum = createHash("sha256").update(readFileSync(source.filename)).digest("hex");
    expect((await importLegacyAudit(fixture.operator,source.filename,checksum)).rowCount).toBe(3);
    expect((await fixture.operator.query("SELECT metadata FROM audit_events WHERE legacy_source_id='sqlite-audit:legacy-Z'")).rows[0].metadata).toEqual(metadata);
    const invalid = backup("raw-errors","legacy-raw","fixture-tenant");
    const changed = new DatabaseSync(invalid.filename);
    changed.prepare("UPDATE audit_events SET metadata_json=?").run(JSON.stringify({errorDetails:{graph:{error:{code:"Forbidden",rawPayload:"must-not-import"}}}}));
    changed.close();
    await expect(importLegacyAudit(fixture.operator,invalid.filename,createHash("sha256").update(readFileSync(invalid.filename)).digest("hex"))).rejects.toThrow("unapproved");
    expect((await fixture.operator.query("SELECT 1 FROM audit_events WHERE legacy_source_id='sqlite-audit:legacy-raw'")).rowCount).toBe(0);
  });

  it("creates a standalone SQLite-safe snapshot that includes committed WAL rows", async () => {
    const source = backup("wal-source", "wal-initial", "fixture-tenant");
    const writer = new DatabaseSync(source.filename);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("INSERT INTO audit_events SELECT ?,operation_id,scope,action,target_blocked_state,agent_id,agent_display_name,actor_username,actor_display_name,actor_home_account_id,tenant_id,started_at,completed_at,status,message,error_code,request_path,metadata_json FROM audit_events WHERE id=?")
      .run("wal-committed", "wal-initial");
    expect(existsSync(`${source.filename}-wal`)).toBe(true);
    const standalone = `${source.filename}.standalone`;
    const snapshot = createLegacyAuditBackup(source.filename, standalone);
    writer.close();
    expect(snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(`${standalone}-wal`)).toBe(false);
    expect(existsSync(`${standalone}-journal`)).toBe(false);
    expect((await importLegacyAudit(fixture.operator, standalone, snapshot.checksum)).rowCount).toBe(2);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM audit_events WHERE legacy_source_id IN ('sqlite-audit:wal-initial','sqlite-audit:wal-committed')")).rows[0].count).toBe(2);
  });
});