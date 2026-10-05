import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { observeDataWork } from "./dataMetrics.js";
import { dataConnections } from "../db/dataConnections.js";
import { dataAdmissionError, dataLimitError, digest, encodeBatch, exactCount } from "../db/dataBounds.js";
import { generationHeartbeat } from "../db/dataGenerations.js";
import { DataSelections, type SelectionIdentity } from "./dataSelections.js";
import { csvValue } from "./csvEncoding.js";
import { AppError } from "../errors.js";
import { invalidExportSelectionSql } from "../db/dataRetention.js";
import type { AuditActor } from "../types/audit.js";
import { peakCheckpoint } from "./peakMemory.js";

export type ExportKind = "copilot_users" | "official_agents" | "official_users" | "graph_packages" | "power_platform_agents" | "unified_agents";
export type ExportAudit = (client: pg.PoolClient, event: {
  id: string; exportId: string; kind: ExportKind; phase: "build" | "download";
  status: "started" | "succeeded" | "failed"; rows: number; bytes: number;
  errorCode?: string; checksum?: string;
}) => Promise<void>;
export type ExportSource = (signal: AbortSignal, context: {
  id: string; selectionId: string; kind: ExportKind; query: Record<string, unknown>; mode: "all" | "explicit";
  selectedIds: () => AsyncIterable<readonly string[]>;
  read: <T>(work: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
}) => AsyncIterable<readonly Record<string, unknown>[]>;
type ExportLease = { id: string; owner: string; version: number; identity: SelectionIdentity };

export class DataExports {
  readonly connections;
  private readonly building = new Map<string, AbortController>();
  constructor(readonly database: pg.Pool, readonly selections: DataSelections, private readonly audit: ExportAudit) {
    this.connections = dataConnections(database);
  }
  create(identity: SelectionIdentity, input: {
    selectionId: string; queryHash: string; kind: ExportKind; filename: string; ids?: readonly string[]; actor?: AuditActor; idempotencyKey?: string;
  }) {
    if (input.ids && (input.ids.length > 5000 || new Set(input.ids).size !== input.ids.length
      || input.ids.some(id => typeof id !== "string" || !id || id.length > 512))) throw new Error("export_explicit_ids");
    return this.connections.run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(3650148)");
      const { selection, pins } = await this.selections.assert(client, input.selectionId, identity);
      if (selection.query_hash !== input.queryHash) throw new Error("export_query_mismatch");
      const hash = createHash("sha256").update(JSON.stringify([input.selectionId, input.kind, input.queryHash, input.filename, input.ids === undefined]));
      for (const id of input.ids ?? []) hash.update(JSON.stringify(id));
      const requestHash = hash.digest("hex");
      if (input.idempotencyKey) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.idempotencyKey)) throw new AppError(400, "invalid_export_selection", "Invalid export request identity.");
        const existing = (await client.query(`SELECT id,request_hash FROM data_exports
          WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
        [identity.tenantId, identity.principalId, input.idempotencyKey])).rows[0];
        if (existing) {
          if (existing.request_hash !== requestHash) throw new AppError(409, "export_idempotency_conflict", "Export intent changed; create a new request.");
          return existing.id as string;
        }
      }
      const count = (await client.query(`SELECT count(*)::int AS n FROM data_exports WHERE tenant_id=$1
        AND status='queued' AND expires_at>clock_timestamp()`, [identity.tenantId])).rows[0].n;
      if (count >= 10) throw dataAdmissionError("export_queue_full");
      const id = randomUUID();
      await client.query(`INSERT INTO data_exports(id,tenant_id,principal_id,selection_id,query_hash,kind,status,filename,deadline_at,expires_at,selection_mode,created_at,actor,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,'queued',$7,statement_timestamp()+interval '15 minutes',
          LEAST(statement_timestamp()+interval '30 minutes',$8),$9,statement_timestamp(),$10::jsonb,$11,$12)`,
      [id, identity.tenantId, identity.principalId, input.selectionId, input.queryHash, input.kind, input.filename,
        new Date(Math.min(...pins.map(pin => (pin.expires_at as Date).getTime()))), input.ids === undefined ? "all" : "explicit",
        input.actor ? JSON.stringify(input.actor) : null, input.idempotencyKey ?? null, input.idempotencyKey ? requestHash : null]);
      for (let offset = 0; offset < (input.ids?.length ?? 0); offset += 250) {
        const rows = input.ids!.slice(offset, offset + 250).map((identity, index) => ({ identity, ordinal: offset + index }));
        const batch = encodeBatch(rows, [id, identity.tenantId]);
        await client.query(`INSERT INTO data_export_items(export_id,tenant_id,ordinal,identity)
          SELECT $1,$2,ordinal,identity FROM jsonb_to_recordset($3::jsonb) r(ordinal integer,identity text)`,
        [id, identity.tenantId, batch.json]);
      }
      await this.audit(client, { id, exportId: id, kind: input.kind, phase: "build", status: "started", rows: 0, bytes: 0 });
      return id;
    });
  }

  private async current(client: pg.PoolClient, id: string, identity: SelectionIdentity) {
    const metadata = (await client.query(`SELECT selection_id FROM data_exports WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`,
      [id, identity.tenantId, identity.principalId])).rows[0];
    if (!metadata) throw new Error("export_not_found");
    const { selection } = await this.selections.assert(client, metadata.selection_id, identity, id);
    const row = (await client.query(`SELECT * FROM data_exports WHERE id=$1 AND expires_at>clock_timestamp() FOR UPDATE`, [id])).rows[0];
    if (!row) throw new Error("export_expired");
    return { ...row, query: selection.query_json };
  }
  private async fence(client: pg.PoolClient, lease: ExportLease) {
    const row = await this.current(client, lease.id, lease.identity);
    const valid = (await client.query(`SELECT id FROM data_exports WHERE id=$1 AND owner=$2 AND lease_version=$3 AND status='building'
      AND lease_until>clock_timestamp() AND deadline_at>clock_timestamp()`, [lease.id, lease.owner, lease.version])).rowCount;
    if (valid !== 1) throw new Error("export_fenced");
    return row;
  }
  async build(id: string, identity: SelectionIdentity, columns: readonly string[], source: ExportSource, parent?: AbortSignal) {
    if (!columns.length || columns.length > 100 || columns.some(column => !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(column))) throw new Error("invalid_export_schema");
    const lease = await this.connections.run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(3650148)");
      const row = await this.current(client, id, identity);
      if (row.status !== "queued") throw new Error("export_not_queued");
      const counts = (await client.query(`SELECT count(*)::int AS global,
        count(*) FILTER(WHERE tenant_id=$1)::int AS tenant FROM data_exports
        WHERE status='building' AND lease_until>clock_timestamp()`, [identity.tenantId])).rows[0];
      if (counts.global >= 4 || counts.tenant >= 2) throw dataAdmissionError("export_admission");
      const owner = randomUUID();
      await client.query(`UPDATE data_exports SET status='building',owner=$2,lease_version=lease_version+1,
        lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1`, [id, owner]);
      return { id, owner, version: row.lease_version + 1, identity, deadline: Math.min(row.deadline_at.getTime(), row.expires_at.getTime()),
        context: { id, selectionId: row.selection_id as string, kind: row.kind as ExportKind, query: row.query as Record<string, unknown>, mode: row.selection_mode as "all" | "explicit", selectedIds: () => this.selectedIds(id, identity) } };
    }, false, parent, id);
    const cancellation = new AbortController();
    this.building.set(id, cancellation);
    const deadline = setTimeout(() => cancellation.abort(new Error("export_deadline")), Math.max(0, lease.deadline - Date.now()));
    deadline.unref();
    const heartbeat = generationHeartbeat(() => this.connections.run(async client => {
      await this.fence(client, lease);
      await client.query("UPDATE data_exports SET lease_until=LEAST(deadline_at,clock_timestamp()+interval '60 seconds') WHERE id=$1", [id]);
    }, true, cancellation.signal, id), parent ? AbortSignal.any([parent, cancellation.signal]) : cancellation.signal);
    let rows = 0;
    let bytes = 0;
    let ordinal = 0;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(262_144);
    let buffered = 0;
    const write = async (chunk: Buffer) => {
      heartbeat.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > 1024 ** 3) throw dataLimitError("export_byte_limit", 1024 ** 3, bytes);
      await this.connections.run(async client => {
        await this.fence(client, lease);
        await client.query(`INSERT INTO data_export_chunks(export_id,tenant_id,ordinal,bytes,byte_count,checksum)
          VALUES($1,$2,$3,$4,$5,$6)`, [id, identity.tenantId, ordinal, chunk, chunk.length, digest(chunk)]);
        await client.query("UPDATE data_exports SET row_count=$2,byte_count=$3,chunk_count=$4 WHERE id=$1", [id, rows, bytes, ordinal + 1]);
        observeDataWork("export", { rows, bytes });
      }, false, heartbeat.signal, id);
      hash.update(chunk);
      ordinal++;
    };
    const append = async (record: Buffer) => {
      let offset = 0;
      while (offset < record.length) {
        const length = Math.min(buffer.length - buffered, record.length - offset);
        record.copy(buffer, buffered, offset, offset + length);
        buffered += length; offset += length;
        if (buffered === buffer.length) { await write(buffer); buffered = 0; }
      }
    };
    try {
      await append(Buffer.from(`\uFEFF${columns.join(",")}\r\n`));
      const context: Parameters<ExportSource>[1] = {
        ...lease.context,
        read: work => this.connections.selectedRead(async client => {
          await this.fence(client, lease);
          return work(client);
        }, { signal: heartbeat.signal, serializationKey: id }),
      };
      for await (const batch of source(heartbeat.signal, context)) {
        heartbeat.signal.throwIfAborted();
        encodeBatch(batch);
        for (const row of batch) {
          if (++rows > 2_000_000) throw dataLimitError("export_row_limit", 2_000_000, rows);
          const record = Buffer.from(`${columns.map(column => csvValue(row[column])).join(",")}\r\n`);
          peakCheckpoint("export.encode");
          await append(record);
        }
      }
      if (buffered) await write(buffer.subarray(0, buffered));
      const checksum = hash.digest("hex");
      // Read back one persisted chunk at a time: no publication based on an
      // in-memory digest alone, and never aggregate bytea/string content in SQL.
      const verified = createHash("sha256");
      let verifiedBytes = 0;
      for (let index = 0; index < ordinal; index++) {
        const chunk = await this.connections.selectedRead(async client => {
          await this.fence(client, lease);
          return (await client.query("SELECT bytes,byte_count,checksum FROM data_export_chunks WHERE export_id=$1 AND ordinal=$2", [id, index])).rows[0];
        }, { signal: heartbeat.signal, serializationKey: id });
        if (!chunk || chunk.byte_count !== chunk.bytes.length || digest(chunk.bytes) !== chunk.checksum) throw new Error("export_checksum");
        verified.update(chunk.bytes);
        verifiedBytes += chunk.byte_count;
      }
      if (verified.digest("hex") !== checksum || verifiedBytes !== bytes) throw new Error("export_checksum");
      await this.connections.run(async client => {
        const row = await this.fence(client, lease);
        if (row.row_count !== rows || exactCount(row.byte_count) !== bytes || row.chunk_count !== ordinal) throw new Error("export_counts");
        await this.audit(client, { id, exportId: id, kind: row.kind, phase: "build", status: "succeeded", rows, bytes, checksum });
        await client.query("UPDATE data_exports SET status='ready',checksum=$2 WHERE id=$1", [id, checksum]);
      }, false, heartbeat.signal, id);
    } catch (error) {
      const codes = ["export_byte_limit", "export_row_limit", "export_deadline", "export_cancelled", "export_fenced", "export_checksum", "data_batch_rows", "data_batch_bytes", "data_read_conflict"];
      const code = error instanceof Error && codes.includes(error.message) ? error.message : "export_build_failed";
      const details = error instanceof AppError ? error.details as { limit?: number; observed?: number } | undefined : undefined;
      try { await this.fail(lease, code, details); }
      catch (failure) { throw new AggregateError([error, failure], "export_build_and_audit_failed"); }
      throw error;
    } finally { clearTimeout(deadline); this.building.delete(id); await heartbeat.stop(); }
  }

  private fail(lease: ExportLease, code: string, details?: { limit?: number; observed?: number }) {
    return this.connections.run(async client => {
      const row = (await client.query(`UPDATE data_exports SET status='failed',error_code=$4,error_limit=$5,error_observed=$6
        WHERE id=$1 AND owner=$2 AND lease_version=$3 AND status='building' RETURNING kind,row_count,byte_count`,
      [lease.id, lease.owner, lease.version, code, Number.isSafeInteger(details?.limit) ? details!.limit : null,
        Number.isSafeInteger(details?.observed) ? details!.observed : null])).rows[0];
      if (row) await this.audit(client, { id: lease.id, exportId: lease.id, kind: row.kind, phase: "build", status: "failed", rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: code });
    }, true, undefined, lease.id);
  }
  failPending(id: string, code: string) {
    return this.connections.run(async client => {
      const row = (await client.query(`UPDATE data_exports SET status='failed',error_code=$2
        WHERE id=$1 AND status='queued' RETURNING kind,row_count,byte_count`, [id, code])).rows[0];
      if (row) await this.audit(client, { id, exportId: id, kind: row.kind, phase: "build", status: "failed",
        rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: code });
    }, false, undefined, id);
  }
  async *selectedIds(id: string, identity: SelectionIdentity): AsyncGenerator<readonly string[]> {
    let ordinal = -1;
    while (true) {
      const rows = await this.connections.selectedRead(async client => {
        await this.current(client, id, identity);
        return (await client.query(`SELECT ordinal,identity FROM data_export_items
          WHERE export_id=$1 AND tenant_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT 250`, [id, identity.tenantId, ordinal])).rows;
      }, { serializationKey: id });
      if (!rows.length) return;
      yield rows.map(row => row.identity as string);
      ordinal = rows.at(-1)!.ordinal;
    }
  }
  status(id: string, identity: SelectionIdentity) {
    return this.connections.selectedRead(async client => {
      const expired = (await client.query(`SELECT e.id,e.status,e.row_count,e.byte_count,e.expires_at,e.error_code
        FROM data_exports e JOIN data_read_selections s ON s.id=e.selection_id
        JOIN data_principal_epochs p ON p.tenant_id=e.tenant_id AND p.principal_id=e.principal_id
        WHERE e.id=$1 AND e.tenant_id=$2 AND e.principal_id=$3 AND e.expires_at<=clock_timestamp()
        AND s.authorization_hash=$4 AND s.session_epoch=$5 AND p.epoch=$5`,
      [id, identity.tenantId, identity.principalId, identity.authorizationHash, identity.sessionEpoch])).rows[0];
      if (expired) return { id, status: "expired", rows: expired.row_count, bytes: exactCount(expired.byte_count), expiresAt: expired.expires_at, error: expired.error_code };
      const row = await this.current(client, id, identity);
      return { id, status: row.status, rows: row.row_count, bytes: exactCount(row.byte_count), expiresAt: row.expires_at, error: row.error_code,
        limit: row.error_limit === null ? null : exactCount(row.error_limit), observed: row.error_observed === null ? null : exactCount(row.error_observed) };
    }, { serializationKey: id });
  }
  expire(id?: string) {
    return this.connections.run(async client => {
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      const rows = (await client.query(`SELECT id,kind,status,row_count,byte_count FROM data_exports e
        WHERE ($1::uuid IS NULL OR id=$1) AND status IN ('queued','building','ready') AND (expires_at<=clock_timestamp()
          OR (status='building' AND (deadline_at<=clock_timestamp() OR lease_until<=clock_timestamp()))
          OR ${invalidExportSelectionSql})
        ORDER BY expires_at,id LIMIT 4 FOR UPDATE SKIP LOCKED`, [id ?? null])).rows;
      for (const row of rows) {
        await client.query("UPDATE data_exports SET status='expired',error_code='export_expired' WHERE id=$1", [row.id]);
        if (row.status !== "ready") await this.audit(client, { id: row.id, exportId: row.id, kind: row.kind, phase: "build", status: "failed", rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: "export_expired" });
      }
      return rows.length;
    });
  }
  async cancel(id: string, identity: SelectionIdentity) {
    await this.connections.run(async client => {
      const row = await this.current(client, id, identity);
      if (["queued", "building", "ready"].includes(row.status)) {
        await client.query("UPDATE data_exports SET status='cancelled' WHERE id=$1", [id]);
        await this.audit(client, { id, exportId: id, kind: row.kind, phase: "build", status: "failed", rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: "export_cancelled" });
      }
    }, false, undefined, id);
    this.building.get(id)?.abort(new Error("export_cancelled"));
  }
  async *download(id: string, identity: SelectionIdentity, signal: AbortSignal): AsyncGenerator<Buffer> {
    const auditId = randomUUID();
    let completed = false;
    let bytes = 0;
    const metadata = await this.connections.run(async client => {
      const row = await this.current(client, id, identity);
      if (row.status !== "ready") throw new Error("export_not_ready");
      await this.audit(client, { id: auditId, exportId: id, kind: row.kind, phase: "download", status: "started", rows: row.row_count, bytes: 0 });
      return row;
    }, false, signal, id);
    const hash = createHash("sha256");
    try {
      for (let ordinal = 0; ordinal < metadata.chunk_count; ordinal++) {
        signal.throwIfAborted();
        const chunk = await this.connections.selectedRead(async client => {
          const row = await this.current(client, id, identity);
          if (row.status !== "ready") throw new Error("export_invalidated");
          return (await client.query("SELECT bytes,checksum FROM data_export_chunks WHERE export_id=$1 AND ordinal=$2", [id, ordinal])).rows[0];
        }, { signal, serializationKey: id });
        if (!chunk || digest(chunk.bytes) !== chunk.checksum) throw new Error("export_checksum");
        bytes += chunk.bytes.length;
        hash.update(chunk.bytes);
        signal.throwIfAborted();
        yield chunk.bytes;
      }
      signal.throwIfAborted();
      const checksum = hash.copy().digest("hex");
      if (bytes !== exactCount(metadata.byte_count) || checksum !== metadata.checksum) throw new Error("export_checksum");
      await this.connections.run(async client => {
        const row = await this.current(client, id, identity);
        if (row.status !== "ready") throw new Error("export_invalidated");
        await this.audit(client, { id: auditId, exportId: id, kind: row.kind, phase: "download", status: "succeeded", rows: row.row_count, bytes, checksum });
      }, false, signal);
      completed = true;
    } finally {
      if (!completed) await this.connections.run(client => this.audit(client, {
        id: auditId, exportId: id, kind: metadata.kind, phase: "download", status: "failed", rows: metadata.row_count, bytes,
        checksum: hash.copy().digest("hex"), errorCode: "export_download_failed",
      }));
    }
  }
  downloadHeaders(filename: string, bytes: number) {
    if (!/^[a-z0-9][a-z0-9.-]{0,126}\.csv$/i.test(filename) || filename.includes("..")) throw new Error("invalid_export_filename");
    return { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${filename}`, "Content-Length": String(exactCount(bytes)), "Cache-Control": "private, no-store" };
  }
}
