import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { observeDataWork } from "./dataMetrics.js";
import { dataConnections } from "../db/dataConnections.js";
import { dataAdmissionError, dataLimitError, digest, encodeBatch, exactCount } from "../db/dataBounds.js";
import { generationHeartbeat } from "../db/dataGenerations.js";
import { DataSelections, type SelectionIdentity } from "./dataSelections.js";
import { csvValue } from "./csvEncoding.js";
import { AppError, errorTelemetry } from "../errors.js";
import { invalidExportSelectionSql } from "../db/dataRetention.js";
import type { AuditActor } from "../types/audit.js";
import { peakCheckpoint } from "./peakMemory.js";
import { operationalLog } from "./telemetry.js";
import { requireAdmissions } from "./maintenance.js";

export type ExportKind = "copilot_users" | "official_agents" | "official_users" | "graph_packages" | "power_platform_agents" | "unified_agents";
export type ExportAudit = (client: pg.PoolClient, event: {
  id: string; exportId: string; kind: ExportKind; phase: "build" | "download";
  status: "started" | "succeeded" | "failed" | "cancelled" | "inconclusive"; rows: number; bytes: number;
  errorCode?: string; checksum?: string; completedAt?: string;
}) => Promise<void>;
export type ExportSource = (signal: AbortSignal, context: {
  id: string; selectionId: string; kind: ExportKind; query: Record<string, unknown>; mode: "all" | "explicit";
  selectedIds: () => AsyncIterable<readonly string[]>;
  read: <T>(work: (client: pg.PoolClient) => Promise<T>) => Promise<T>;
}) => AsyncIterable<readonly Record<string, unknown>[]>;
export type ExportBuildControl = {
  assertCurrent?: () => void;
  settlementFailed?: (error: AggregateError) => void;
};
type ExportLease = { id: string; owner: string; version: number; identity: SelectionIdentity };
type ExportBuildLease = ExportLease & {
  deadline: number; leaseUntil: number;
  context: Pick<Parameters<ExportSource>[1], "id" | "selectionId" | "kind" | "query" | "mode">;
};
type ExportPublication = { validate: () => Promise<() => void>; finish: () => Promise<void | string>; failed: () => void };
const chunkBytes = 262_144;
const builders = new WeakMap<pg.Pool, Map<string, AbortController>>();

export class DataExports {
  readonly connections;
  private readonly building: Map<string, AbortController>;
  constructor(readonly database: pg.Pool, readonly selections: DataSelections, private readonly audit: ExportAudit) {
    this.connections = dataConnections(database);
    let building = builders.get(database);
    if (!building) { building = new Map(); builders.set(database, building); }
    this.building = building;
  }
  create(identity: SelectionIdentity, input: {
    selectionId: string; queryHash: string; kind: ExportKind; filename: string; ids?: readonly string[]; actor?: AuditActor; idempotencyKey?: string;
  }, assertCurrent?: () => void) {
    input = { ...input, ids: input.ids?.slice(), actor: input.actor && { tenantId: input.actor.tenantId,
      homeAccountId: input.actor.homeAccountId, username: input.actor.username, displayName: input.actor.displayName } };
    if (input.ids && (input.ids.length > 5000 || new Set(input.ids).size !== input.ids.length
      || input.ids.some(id => typeof id !== "string" || !id || id.length > 512 || /[\0\p{Cs}]/u.test(id)))) throw new Error("export_explicit_ids");
    let id = randomUUID();
    let committed = false;
    return this.connections.run(async client => {
      assertCurrent?.();
      await client.query("SELECT pg_advisory_xact_lock(3650148)");
      // Enable domain export fences; a prospective ID cannot extend the selection's page TTL.
      const { selection, pins } = await this.selections.assert(client, input.selectionId, identity, id);
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
          id = existing.id;
          return id;
        }
      }
      const count = (await client.query(`SELECT count(*)::int AS n FROM data_exports WHERE tenant_id=$1
        AND status='queued' AND expires_at>clock_timestamp()`, [identity.tenantId])).rows[0].n;
      if (count >= 10) throw dataAdmissionError("export_queue_full");
      await client.query(`INSERT INTO data_exports(id,tenant_id,principal_id,selection_id,query_hash,kind,status,filename,deadline_at,expires_at,selection_mode,created_at,actor,idempotency_key,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,'queued',$7,statement_timestamp()+interval '15 minutes',
          LEAST(statement_timestamp()+interval '30 minutes',$8),$9,statement_timestamp(),$10::jsonb,$11,$12)`,
      [id, identity.tenantId, identity.principalId, input.selectionId, input.queryHash, input.kind, input.filename,
        new Date(Math.min(...pins.map(pin => (pin.expires_at as Date).getTime()))), input.ids === undefined ? "all" : "explicit",
        input.actor ? JSON.stringify({ tenantId: input.actor.tenantId, homeAccountId: input.actor.homeAccountId,
          username: input.actor.username, displayName: input.actor.displayName }) : null,
        input.idempotencyKey ?? null, input.idempotencyKey ? requestHash : null]);
      for (let offset = 0; offset < (input.ids?.length ?? 0); offset += 250) {
        const rows = input.ids!.slice(offset, offset + 250).map((identity, index) => ({ identity, ordinal: offset + index }));
        const batch = encodeBatch(rows, [id, identity.tenantId]);
        await client.query(`INSERT INTO data_export_items(export_id,tenant_id,ordinal,identity)
          SELECT $1,$2,ordinal,identity FROM jsonb_to_recordset($3::jsonb) r(ordinal integer,identity text)`,
        [id, identity.tenantId, batch.json]);
      }
      await this.audit(client, { id, exportId: id, kind: input.kind, phase: "build", status: "started", rows: 0, bytes: 0 });
      return id;
    }, false, undefined, undefined, assertCurrent, () => { committed = true; }).catch(error => {
      if (!committed) throw error;
      operationalLog("error", "export_post_commit_cleanup_failed", { ...errorTelemetry(error), jobId: id });
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
    if (row.query_hash !== selection.query_hash) {
      throw new AppError(409, "export_selection_changed", "The export no longer matches its pinned selection query.");
    }
    return { ...row, query: selection.query_json };
  }
  private async fence(client: pg.PoolClient, lease: ExportLease) {
    const row = await this.current(client, lease.id, lease.identity);
    const valid = (await client.query(`SELECT id FROM data_exports WHERE id=$1 AND owner=$2 AND lease_version=$3 AND status='building'
      AND lease_until>clock_timestamp() AND deadline_at>clock_timestamp()`, [lease.id, lease.owner, lease.version])).rowCount;
    if (valid !== 1) throw new Error("export_fenced");
    return row;
  }
  async build(id: string, identity: SelectionIdentity, columns: readonly string[], source: ExportSource, parent?: AbortSignal, control?: ExportBuildControl) {
    if (!columns.length || columns.length > 128 || new Set(columns).size !== columns.length
      || columns.some(column => !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(column))) throw new Error("invalid_export_schema");
    let lease: ExportBuildLease | undefined;
    let claimed = false;
    const assertAdmission = () => {
      parent?.throwIfAborted();
      requireAdmissions();
      control?.assertCurrent?.();
      if (lease && Date.now() >= lease.deadline) throw new Error("export_deadline");
      if (lease && Date.now() >= lease.leaseUntil) throw new Error("export_fenced");
    };
    try {
      await this.connections.run(async client => {
        assertAdmission();
        await client.query("SELECT pg_advisory_xact_lock(3650148)");
        const state = (await client.query("SELECT mode FROM operational_state WHERE singleton=true")).rows[0];
        if (!state || state.mode !== "normal") throw new AppError(503, "maintenance", "Export admissions are paused.");
        const row = await this.current(client, id, identity);
        if (row.status !== "queued") throw new Error("export_not_queued");
        const counts = (await client.query(`SELECT count(*)::int AS global,
          count(*) FILTER(WHERE tenant_id=$1)::int AS tenant FROM data_exports
          WHERE status='building' AND lease_until>clock_timestamp()`, [identity.tenantId])).rows[0];
        if (counts.global >= 4 || counts.tenant >= 2) throw dataAdmissionError("export_admission");
        const owner = randomUUID();
        const updated = (await client.query(`UPDATE data_exports SET status='building',owner=$2,lease_version=lease_version+1,
          lease_until=LEAST(deadline_at,expires_at,clock_timestamp()+interval '60 seconds') WHERE id=$1 RETURNING lease_until`, [id, owner])).rows[0];
        lease = { id, owner, version: row.lease_version + 1, identity,
          deadline: Math.min(row.deadline_at.getTime(), row.expires_at.getTime()), leaseUntil: updated.lease_until.getTime(),
          context: { id, selectionId: row.selection_id as string, kind: row.kind as ExportKind,
            query: row.query as Record<string, unknown>, mode: row.selection_mode as "all" | "explicit" } };
        const currentState = (await client.query("SELECT mode FROM operational_state WHERE singleton=true")).rows[0];
        if (!currentState || currentState.mode !== "normal") throw new AppError(503, "maintenance", "Export admissions are paused.");
      }, false, parent, id, assertAdmission, () => { claimed = true; });
    } catch (error) {
      if (!claimed) throw error;
      operationalLog("error", "export_post_commit_cleanup_failed", { ...errorTelemetry(error), jobId: id });
    }
    if (!lease) throw new Error("export_lease_missing");
    const owned = lease;
    const cancellation = new AbortController();
    this.building.set(id, cancellation);
    const deadline = setTimeout(() => cancellation.abort(new Error("export_deadline")), Math.max(0, owned.deadline - Date.now()));
    deadline.unref();
    const heartbeat = generationHeartbeat(async () => {
      let leaseUntil = 0;
      await this.connections.run(async client => {
        leaseUntil = (await this.fence(client, owned)).lease_until.getTime();
        await client.query("UPDATE data_exports SET lease_until=LEAST(deadline_at,clock_timestamp()+interval '60 seconds') WHERE id=$1", [id]);
      }, true, cancellation.signal, id, () => assertLease(leaseUntil));
    }, parent ? AbortSignal.any([parent, cancellation.signal]) : cancellation.signal);
    const assertBuilding = () => {
      if (Date.now() >= owned.deadline) cancellation.abort(new Error("export_deadline"));
      heartbeat.signal.throwIfAborted();
    };
    const assertLease = (leaseUntil: number) => {
      assertBuilding();
      if (!Number.isFinite(leaseUntil) || Date.now() >= leaseUntil) throw new Error("export_fenced");
    };
    let rows = 0;
    let bytes = 0;
    let ordinal = 0;
    let published = false;
    let settlement: Promise<void> | undefined;
    const settle = (error: unknown) => {
      if (!settlement) {
        const codes = ["export_byte_limit", "export_row_limit", "export_deadline", "export_cancelled", "export_shutdown", "export_fenced", "export_checksum", "data_batch_rows", "data_batch_bytes", "data_read_conflict", "selection_invalidated", "export_selection_kind", "export_selection_changed", "invalid_export_selection"];
        const reason = error instanceof AppError ? error.code : error instanceof Error ? error.message : undefined;
        const cancelled = reason === "export_cancelled" || reason === "export_shutdown" || parent?.aborted && error === parent.reason;
        const code = reason !== undefined && codes.includes(reason) ? reason : cancelled ? "export_cancelled" : "export_build_failed";
        const details = error instanceof AppError ? error.details as { limit?: number; observed?: number } | undefined : undefined;
        settlement = this.fail(owned, code, details, Boolean(cancelled)).catch(failure => {
          operationalLog("error", "export_audit_completion_failed", errorTelemetry(failure, "audit_completion_failed"));
          control?.settlementFailed?.(new AggregateError([error, failure], "export_work_and_settlement_failed"));
          throw failure;
        });
      }
      return settlement;
    };
    const aborted = () => {
      if (!published) void settle(heartbeat.signal.reason).catch(() => {});
    };
    heartbeat.signal.addEventListener("abort", aborted, { once: true });
    if (heartbeat.signal.aborted) aborted();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let buffered = 0;
    const write = async (chunk: Buffer) => {
      assertBuilding();
      bytes += chunk.length;
      if (bytes > 1024 ** 3) throw dataLimitError("export_byte_limit", 1024 ** 3, bytes);
      let leaseUntil = 0;
      await this.connections.run(async client => {
        leaseUntil = (await this.fence(client, owned)).lease_until.getTime();
        await client.query(`INSERT INTO data_export_chunks(export_id,tenant_id,ordinal,bytes,byte_count,checksum)
          VALUES($1,$2,$3,$4,$5,$6)`, [id, identity.tenantId, ordinal, chunk, chunk.length, digest(chunk)]);
        await client.query("UPDATE data_exports SET row_count=$2,byte_count=$3,chunk_count=$4 WHERE id=$1", [id, rows, bytes, ordinal + 1]);
        observeDataWork("export", { rows, bytes });
      }, false, heartbeat.signal, id, () => assertLease(leaseUntil));
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
      assertBuilding();
      // Cancellation may commit after lease admission but before the local signal is registered.
      await this.connections.run(client => this.fence(client, owned), false, heartbeat.signal, id, assertBuilding);
      await append(Buffer.from(`\uFEFF${columns.join(",")}\r\n`));
      const read = async <T>(work: (client: pg.PoolClient) => Promise<T>) => {
        assertBuilding();
        let leaseUntil = 0;
        const assertCurrent = () => assertLease(leaseUntil);
        const value = await this.connections.selectedRead(async client => {
          leaseUntil = (await this.fence(client, owned)).lease_until.getTime();
          assertCurrent();
          const value = await work(client);
          assertCurrent();
          return value;
        }, { signal: heartbeat.signal, serializationKey: id, beforeCommit: assertCurrent });
        assertCurrent();
        // Retain this read's lease guard through the caller's final await/yield boundary.
        return { value, assertCurrent };
      };
      const context: Parameters<ExportSource>[1] = {
        ...owned.context,
        selectedIds: async function* () {
          let ordinal = -1;
          while (true) {
            const page = await read(async client => (await client.query<{ ordinal: number; identity: string }>(
              `SELECT ordinal,identity FROM data_export_items
                WHERE export_id=$1 AND tenant_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT 250`,
              [id, identity.tenantId, ordinal])).rows);
            page.assertCurrent();
            if (!page.value.length) return;
            const ids = page.value.map(row => row.identity);
            ordinal = page.value.at(-1)!.ordinal;
            page.assertCurrent();
            yield ids;
          }
        },
        read: async work => {
          const result = await read(work);
          result.assertCurrent();
          return result.value;
        },
      };
      for await (const batch of source(heartbeat.signal, context)) {
        assertBuilding();
        encodeBatch(batch);
        for (const row of batch) {
          assertBuilding();
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
        const chunk = await context.read(async client => {
          return (await client.query("SELECT bytes,byte_count,checksum FROM data_export_chunks WHERE export_id=$1 AND ordinal=$2", [id, index])).rows[0];
        });
        if (!chunk || chunk.byte_count !== chunk.bytes.length || digest(chunk.bytes) !== chunk.checksum) throw new Error("export_checksum");
        verified.update(chunk.bytes);
        verifiedBytes += chunk.byte_count;
      }
      if (verified.digest("hex") !== checksum || verifiedBytes !== bytes) throw new Error("export_checksum");
      let leaseUntil = 0;
      await this.connections.run(async client => {
        const row = await this.fence(client, owned);
        if (row.row_count !== rows || exactCount(row.byte_count) !== bytes || row.chunk_count !== ordinal) throw new Error("export_counts");
        await this.assertChunks(client, id, ordinal, bytes);
        await this.audit(client, { id, exportId: id, kind: row.kind, phase: "build", status: "succeeded", rows, bytes, checksum });
        leaseUntil = (await this.fence(client, owned)).lease_until.getTime();
        await client.query("UPDATE data_exports SET status='ready',checksum=$2 WHERE id=$1", [id, checksum]);
      }, false, heartbeat.signal, id, () => assertLease(leaseUntil), () => { published = true; });
    } catch (error) {
      if (published) {
        operationalLog("error", "export_post_commit_cleanup_failed", { ...errorTelemetry(error), jobId: id });
        return;
      }
      try { await settle(error); }
      catch { /* Settlement diagnostics retain the primary producer/abort reason. */ }
      throw error;
    } finally {
      heartbeat.signal.removeEventListener("abort", aborted);
      clearTimeout(deadline); this.building.delete(id); await heartbeat.stop();
    }
  }

  private fail(lease: ExportLease, code: string, details?: { limit?: number; observed?: number }, cancelled = false) {
    let committed = false;
    return this.connections.run(async client => {
      const row = (await client.query(`UPDATE data_exports SET status=$7,error_code=$4,error_limit=$5,error_observed=$6
        WHERE id=$1 AND owner=$2 AND lease_version=$3 AND status='building' RETURNING kind,row_count,byte_count`,
      [lease.id, lease.owner, lease.version, code, Number.isSafeInteger(details?.limit) ? details!.limit : null,
        Number.isSafeInteger(details?.observed) ? details!.observed : null, cancelled ? "cancelled" : "failed"])).rows[0];
      if (row) await this.audit(client, { id: lease.id, exportId: lease.id, kind: row.kind, phase: "build", status: cancelled ? "cancelled" : "failed", rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: code });
    }, true, undefined, lease.id, undefined, () => { committed = true; }).catch(error => {
      if (!committed) throw error;
      operationalLog("error", "export_post_commit_cleanup_failed", { ...errorTelemetry(error), jobId: lease.id });
    });
  }
  failPending(id: string, code: string) {
    return this.connections.run(async client => {
      const row = (await client.query(`UPDATE data_exports SET status='failed',error_code=$2
        WHERE id=$1 AND status='queued' RETURNING kind,row_count,byte_count`, [id, code])).rows[0];
      if (row) await this.audit(client, { id, exportId: id, kind: row.kind, phase: "build", status: "failed",
        rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: code });
    }, false, undefined, id);
  }
  async *selectedIds(id: string, identity: SelectionIdentity, signal?: AbortSignal): AsyncGenerator<readonly string[]> {
    let ordinal = -1;
    while (true) {
      const rows = await this.connections.selectedRead(async client => {
        await this.current(client, id, identity);
        return (await client.query(`SELECT ordinal,identity FROM data_export_items
          WHERE export_id=$1 AND tenant_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT 250`, [id, identity.tenantId, ordinal])).rows;
      }, { signal, serializationKey: id });
      if (!rows.length) return;
      signal?.throwIfAborted();
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
          OR (status IN ('queued','building') AND deadline_at<=clock_timestamp())
          OR (status='building' AND lease_until<=clock_timestamp())
          OR ${invalidExportSelectionSql})
        ORDER BY expires_at,id LIMIT 4 FOR UPDATE SKIP LOCKED`, [id ?? null])).rows;
      for (const row of rows) {
        await client.query("UPDATE data_exports SET status='expired',error_code='export_expired' WHERE id=$1", [row.id]);
        if (row.status !== "ready") await this.audit(client, { id: row.id, exportId: row.id, kind: row.kind, phase: "build", status: "failed", rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: "export_expired" });
      }
      return rows.length;
    });
  }
  async cancel(id: string, identity: SelectionIdentity, assertCurrent?: () => void) {
    let committed = false;
    try {
      await this.connections.run(async client => {
        assertCurrent?.();
        const row = await this.current(client, id, identity);
        if (["queued", "building", "ready"].includes(row.status)) {
          await client.query("UPDATE data_exports SET status='cancelled' WHERE id=$1", [id]);
          if (row.status !== "ready") await this.audit(client, { id, exportId: id, kind: row.kind, phase: "build", status: "cancelled", rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: "export_cancelled" });
        }
      }, false, undefined, id, assertCurrent, () => { committed = true; });
    } catch (error) {
      if (!committed) throw error;
      operationalLog("error", "export_post_commit_cleanup_failed", { ...errorTelemetry(error), jobId: id });
    }
    this.building.get(id)?.abort(new Error("export_cancelled"));
  }
  private async assertChunks(client: pg.PoolClient, id: string, count: number, bytes: number) {
    const stored = (await client.query(`SELECT count(*)::int AS chunks,coalesce(sum(byte_count),0)::text AS bytes,
      coalesce(max(ordinal),-1)::int AS last FROM data_export_chunks WHERE export_id=$1`, [id])).rows[0];
    if (stored.chunks !== count || exactCount(stored.bytes) !== bytes || stored.last !== count - 1) throw new Error("export_checksum");
  }
  async *download(id: string, identity: SelectionIdentity, signal: AbortSignal, publication?: ExportPublication): AsyncGenerator<Buffer> {
    const auditId = randomUUID();
    let completed = false;
    let started = false;
    let failed = false;
    let failure: unknown;
    let bytes = 0;
    let admitted: { kind: ExportKind; row_count: number } | undefined;
    const hash = createHash("sha256");
    try {
      let assertCurrent = await publication?.validate();
      const metadata = await this.connections.run(async client => {
        const row = await this.current(client, id, identity);
        if (row.status !== "ready") throw new Error("export_not_ready");
        admitted = { kind: row.kind, row_count: row.row_count };
        await this.audit(client, { id: auditId, exportId: id, kind: row.kind, phase: "download", status: "started", rows: row.row_count, bytes: 0 });
        return row;
      }, false, signal, id, assertCurrent, () => { started = true; });
      started = true;
      const assertDownloading = () => {
        signal.throwIfAborted();
        if (Date.now() >= metadata.expires_at.getTime()) throw new Error("export_expired");
      };
      assertDownloading();
      const expectedBytes = exactCount(metadata.byte_count);
      if (!expectedBytes || expectedBytes > 1024 ** 3 || metadata.chunk_count !== Math.ceil(expectedBytes / chunkBytes)
        || typeof metadata.checksum !== "string" || !/^[a-f0-9]{64}$/.test(metadata.checksum)) throw new Error("export_checksum");
      for (let ordinal = 0; ordinal < metadata.chunk_count; ordinal++) {
        assertDownloading();
        const chunk = await this.connections.selectedRead(async client => {
          const row = await this.current(client, id, identity);
          if (row.status !== "ready") throw new Error("export_invalidated");
          if (row.row_count !== metadata.row_count || exactCount(row.byte_count) !== expectedBytes
            || row.chunk_count !== metadata.chunk_count || row.checksum !== metadata.checksum) throw new Error("export_checksum");
          if (ordinal === 0) await this.assertChunks(client, id, metadata.chunk_count, expectedBytes);
          return (await client.query("SELECT bytes,byte_count,checksum FROM data_export_chunks WHERE export_id=$1 AND ordinal=$2", [id, ordinal])).rows[0];
        }, { signal, serializationKey: id });
        assertDownloading();
        if (!chunk || !Buffer.isBuffer(chunk.bytes) || chunk.byte_count !== chunk.bytes.length
          || chunk.bytes.length !== Math.min(chunkBytes, expectedBytes - bytes) || digest(chunk.bytes) !== chunk.checksum) throw new Error("export_checksum");
        assertCurrent = await publication?.validate();
        assertDownloading();
        assertCurrent?.();
        bytes += chunk.bytes.length;
        hash.update(chunk.bytes);
        assertDownloading();
        yield chunk.bytes;
      }
      assertDownloading();
      const checksum = hash.copy().digest("hex");
      if (bytes !== expectedBytes || checksum !== metadata.checksum) throw new Error("export_checksum");
      assertCurrent = await publication?.validate();
      assertDownloading();
      try {
        await this.connections.run(async client => {
          const row = await this.current(client, id, identity);
          if (row.status !== "ready") throw new Error("export_invalidated");
          if (row.row_count !== metadata.row_count || exactCount(row.byte_count) !== expectedBytes
            || row.chunk_count !== metadata.chunk_count || row.checksum !== metadata.checksum) throw new Error("export_checksum");
          await this.assertChunks(client, id, metadata.chunk_count, expectedBytes);
          // HTTP completion is still unknown while the route withholds its final chunk.
          await this.audit(client, { id: auditId, exportId: id, kind: row.kind, phase: "download",
            status: publication ? "inconclusive" : "succeeded", rows: row.row_count, bytes, checksum });
          const current = await this.current(client, id, identity);
          if (current.status !== "ready") throw new Error("export_invalidated");
        }, false, signal, id, () => { assertDownloading(); assertCurrent?.(); }, () => { completed = !publication; });
      } catch (error) {
        if (!completed) throw error;
        operationalLog("error", "export_post_commit_cleanup_failed", { ...errorTelemetry(error), jobId: id });
      }
      if (publication) {
        assertCurrent = await publication.validate();
        assertDownloading();
        assertCurrent();
        const finishedAt = await publication.finish();
        completed = true;
        const completedAt = finishedAt ?? new Date().toISOString();
        let auditCommitted = false;
        try {
          await this.connections.run(client => this.audit(client, {
            id: auditId, exportId: id, kind: metadata.kind, phase: "download", status: "succeeded",
            rows: metadata.row_count, bytes, checksum, completedAt,
          }), false, undefined, id, undefined, () => { auditCommitted = true; });
        } catch (error) {
          // An acknowledged transport finish cannot be undone by terminal audit/connection cleanup.
          operationalLog("error", auditCommitted ? "export_post_commit_cleanup_failed" : "export_audit_completion_failed",
            { ...errorTelemetry(error, auditCommitted ? "internal_error" : "audit_completion_failed"), jobId: id });
        }
      }
      completed = true;
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      if (!completed && started && admitted) {
        const metadata = admitted;
        try { publication?.failed(); }
        catch (error) { operationalLog("error", "export_transport_cleanup_failed", { ...errorTelemetry(error), jobId: id }); }
        const reason = failure instanceof AppError ? failure.code : failure instanceof Error ? failure.message : undefined;
        const codes = ["export_disconnected", "export_expired", "export_deadline", "export_invalidated", "export_not_ready", "export_checksum",
          "export_selection_changed", "selection_invalidated", "data_read_conflict", "unauthorized"];
        const cancelled = !failed || reason === "export_disconnected"
          || signal.aborted && failure === signal.reason && (reason === undefined || !codes.includes(reason));
        const errorCode = reason !== undefined && codes.includes(reason) ? reason
          : cancelled ? "export_download_cancelled" : "export_download_failed";
        try {
          await this.connections.run(client => this.audit(client, {
            id: auditId, exportId: id, kind: metadata.kind, phase: "download", status: cancelled ? "cancelled" : "failed",
            rows: metadata.row_count, bytes, checksum: hash.copy().digest("hex"), errorCode,
          }), false, undefined, id);
        } catch (auditError) {
          operationalLog("error", "export_audit_completion_failed", errorTelemetry(auditError, "audit_completion_failed"));
          if (!failed && !publication) throw auditError;
        }
      }
    }
  }
  downloadHeaders(filename: string, bytes: number) {
    if (!/^[a-z0-9][a-z0-9.-]{0,126}\.csv$/i.test(filename) || filename.includes("..")) throw new Error("invalid_export_filename");
    return { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=${filename}`, "Content-Length": String(exactCount(bytes)), "Cache-Control": "private, no-store" };
  }
}
