import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { databaseSettings, transaction } from "../src/db/pool.js";
import { verifySchema } from "../src/db/schema.js";

type LegacyRow = Record<string, string | number | null>;
const fields = ["id","operation_id","scope","action","target_blocked_state","agent_id","agent_display_name","actor_username","actor_display_name","actor_home_account_id","tenant_id","started_at","completed_at","status","message","error_code","request_path","metadata_json"];
const statuses = new Set(["started","succeeded","failed","skipped"]);

function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }

export function createLegacyAuditBackup(source: string, target: string) {
  if (!existsSync(source) || existsSync(target) || existsSync(`${target}-wal`) || existsSync(`${target}-journal`)) {
    throw new Error("Legacy backup requires one existing source and one new standalone target.");
  }
  if (statSync(source).size > 64 * 1024 * 1024) throw new Error("Legacy source exceeds the 64 MiB backup bound.");
  const sqlite = new DatabaseSync(source, { readOnly: true });
  try {
    sqlite.prepare("VACUUM INTO ?").run(target);
  } finally {
    sqlite.close();
  }
  if (!existsSync(target) || existsSync(`${target}-wal`) || existsSync(`${target}-journal`) || statSync(target).size > 64 * 1024 * 1024) {
    throw new Error("SQLite-safe legacy backup was not created as one bounded standalone file.");
  }
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    if (Object.values(check.prepare("PRAGMA integrity_check").get() ?? {})[0] !== "ok") throw new Error("SQLite-safe backup integrity check failed.");
  } finally {
    check.close();
  }
  return { filename: target, checksum: hash(readFileSync(target)), bytes: statSync(target).size };
}

function validateLegacyError(value: unknown, level: "details" | "graph" | "error" | "innerError" = "details") {
  if (level === "graph" && typeof value === "string" && value.length <= 4096) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed legacy error metadata.");
  const allowed = {
    details: ["graph", "retryAfterMs"], graph: ["error", "Message", "message", "StatusCode"],
    error: ["code", "message", "innerError"], innerError: ["date", "request-id", "client-request-id"],
  };
  for (const [key, field] of Object.entries(value)) {
    if (!allowed[level].includes(key)) throw new Error("Legacy error metadata contains unapproved fields.");
    if (key === "graph" || key === "error" || key === "innerError") validateLegacyError(field, key);
    else if (key === "retryAfterMs" || key === "StatusCode") {
      if ((typeof field !== "number" || !Number.isFinite(field)) && (key !== "StatusCode" || typeof field !== "string" || !/^\d{3}$/.test(field))) throw new Error("Malformed legacy error number.");
    } else if (typeof field !== "string" || field.length > 4096) throw new Error("Malformed legacy error text.");
  }
}

function validateRow(row: LegacyRow) {
  for (const field of ["id","operation_id","scope","action","agent_id","actor_username","actor_display_name","actor_home_account_id","started_at","status","request_path"]) {
    if (typeof row[field] !== "string" || !row[field] || String(row[field]).length > 4096) throw new Error("Malformed legacy audit field.");
  }
  if (!["single","bulk"].includes(String(row.scope)) || !statuses.has(String(row.status))) throw new Error("Unknown legacy audit status/scope.");
  if (!["block","unblock","update-availability","update-installation"].includes(String(row.action))) throw new Error("Unknown legacy audit action.");
  if (["block","unblock"].includes(String(row.action)) ? ![0,1].includes(Number(row.target_blocked_state)) || row.target_blocked_state === null : row.target_blocked_state !== null) throw new Error("Malformed legacy target state.");
  for (const field of ["started_at","completed_at"]) {
    if (row[field] !== null && (!Number.isFinite(Date.parse(String(row[field]))) || !/^\d{4}-\d{2}-\d{2}T/.test(String(row[field])))) throw new Error("Malformed legacy timestamp.");
  }
  const metadata = row.metadata_json ? JSON.parse(String(row.metadata_json)) : null;
  if (metadata !== null) {
    if (typeof metadata !== "object" || Array.isArray(metadata) || Buffer.byteLength(JSON.stringify(metadata)) > 16384) throw new Error("Malformed legacy metadata.");
    const allowed = new Set(["source","target","mode","scope","previousCount","resultingCount","principals","errorDetails"]);
    for (const [key, value] of Object.entries(metadata)) {
      if (!allowed.has(key)) throw new Error("Legacy metadata contains unapproved fields; review the backup before import.");
      if (key === "errorDetails") validateLegacyError(value);
      else if (key === "principals") {
        if (!Array.isArray(value) || value.length > 500 || value.some(principal => typeof principal?.resourceId !== "string" || !["user","group"].includes(principal.resourceType) || Object.keys(principal).some(name => !["resourceId","resourceType"].includes(name)))) throw new Error("Malformed legacy principals.");
      } else if (!["string","number","boolean"].includes(typeof value)) throw new Error("Malformed legacy metadata value.");
    }
  }
  return metadata;
}

export async function importLegacyAudit(database: pg.Pool, filename: string, expectedChecksum: string, beforeCommit?: () => void) {
  await verifySchema(database);
  if (!/^[a-f0-9]{64}$/.test(expectedChecksum) || statSync(filename).size > 64*1024*1024 || existsSync(`${filename}-wal`) || existsSync(`${filename}-journal`)) throw new Error("Use a bounded standalone SQLite-safe backup with its expected SHA-256 checksum.");
  const actualChecksum = hash(readFileSync(filename));
  if (actualChecksum !== expectedChecksum) throw new Error("Backup checksum changed; import refused.");
  const sqlite = new DatabaseSync(filename, { readOnly: true });
  let rows: LegacyRow[];
  try {
    if (Object.values(sqlite.prepare("PRAGMA integrity_check").get() ?? {})[0] !== "ok") throw new Error("SQLite backup integrity check failed.");
    const columns = sqlite.prepare("PRAGMA table_info(audit_events)").all().map(column => column.name);
    if (fields.some(field => !columns.includes(field))) throw new Error("Unsupported legacy audit schema.");
    rows = sqlite.prepare("SELECT * FROM audit_events ORDER BY id LIMIT 100001").all() as LegacyRow[];
    if (rows.length > 100000) throw new Error("Legacy backup exceeds 100000 rows.");
  } finally { sqlite.close(); }
  if (hash(readFileSync(filename)) !== expectedChecksum) throw new Error("Backup changed while being read.");
  const validated = rows.map(row => ({ row, metadata: validateRow(row), contentHash: hash(JSON.stringify(fields.map(field => row[field] ?? null))) }));
  const contentHash = hash(JSON.stringify(validated.map(item => item.contentHash)));
  return transaction(database, async client => {
    await client.query("SELECT pg_advisory_xact_lock(3650102)");
    const receipt = await client.query("SELECT * FROM legacy_audit_imports WHERE backup_checksum=$1", [expectedChecksum]);
    if (receipt.rows[0] && (receipt.rows[0].row_count !== rows.length || receipt.rows[0].content_hash !== contentHash)) throw new Error("Legacy receipt mismatch.");
    for (const item of validated) {
      const { row } = item;
      const sourceId = `sqlite-audit:${row.id}`;
      const existing = await client.query("SELECT legacy_content_hash FROM audit_events WHERE legacy_source_id=$1", [sourceId]);
      if (existing.rows[0]) {
        if (existing.rows[0].legacy_content_hash !== item.contentHash) throw new Error("Legacy source row changed; no partial import committed.");
        continue;
      }
      if (receipt.rows[0]) throw new Error("Previously imported history is missing; operator recovery required.");
      await client.query(`INSERT INTO audit_events (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,
        agent_id,agent_display_name,started_at,completed_at,status,message,error_code,request_path,metadata,legacy_source_id,legacy_content_hash)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [randomUUID(),sourceId,row.operation_id,row.tenant_id || null,row.actor_home_account_id,row.actor_username,row.actor_display_name,row.scope,row.action,
        row.target_blocked_state === null ? null : row.target_blocked_state === 1,row.agent_id,row.agent_display_name,row.started_at,row.completed_at,row.status,row.message,row.error_code,row.request_path,item.metadata,sourceId,item.contentHash]);
    }
    beforeCommit?.();
    const imported = await client.query('SELECT legacy_source_id,legacy_content_hash FROM audit_events WHERE legacy_source_id=ANY($1::text[]) ORDER BY legacy_source_id COLLATE "C"', [rows.map(row => `sqlite-audit:${row.id}`)]);
    if (imported.rowCount !== rows.length || hash(JSON.stringify(imported.rows.map(row => row.legacy_content_hash))) !== contentHash) throw new Error("Imported count/content verification failed.");
    await client.query("INSERT INTO legacy_audit_imports(backup_checksum,row_count,content_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [expectedChecksum,rows.length,contentHash]);
    return { rowCount: rows.length, contentHash, repeated: Boolean(receipt.rows[0]) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "backup") {
    try { console.log(JSON.stringify(createLegacyAuditBackup(process.argv[3], process.argv[4]))); }
    catch { console.error("Legacy backup refused; verify the bounded source and new isolated target."); process.exitCode = 1; }
  } else {
    const database = new pg.Pool(databaseSettings());
    importLegacyAudit(database, process.argv[2], process.argv[3]).then(receipt => console.log(JSON.stringify(receipt)))
      .catch(() => { console.error("Legacy import refused; verify the isolated backup checksum, schema, fields and existing receipt."); process.exitCode=1; })
      .finally(() => database.end());
  }
}