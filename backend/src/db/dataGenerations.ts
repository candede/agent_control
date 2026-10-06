import { randomUUID } from "node:crypto";
import type pg from "pg";
import { observeDataWork } from "../services/dataMetrics.js";
import { measurePublication } from "../services/peakMemory.js";
import { BatchResidency, assertResidualBytes, assertResidualDatabaseBounds, dataAdmissionError, dataLimitError, dataLimits, digest, encodeBatch, exactCount } from "./dataBounds.js";
import { dataConnections } from "./dataConnections.js";
import { admitGeneration } from "./generationAdmission.js";
import type { CopilotServicePlan, CopilotServiceState, CopilotServiceSummaryState } from "../types/copilotUsage.js";

export type DataScope = {
  tenantId: string; kind: "tenant" | "principal"; principalId: string | null;
  tokenMode: "tenant" | "delegated" | "application"; source: string; selector: string;
};
export type GenerationLease = {
  id: string; scopeId: string; tenantId: string; owner: string; version: number;
  epoch: string; sessionEpoch: string; expectedRevision: string; schemaVersion: number;
};
export type BeginGeneration = {
  scope: DataScope; schemaVersion: number; jobId: string; runId?: string;
  sessionEpoch: string;
  jobKind: "data_sync" | "package_refresh" | "power_platform_refresh" | "derived" | "fixture";
  observedAt: Date; expiresAt: Date; deadlineAt: Date; reserveBytes: number;
};
type RecordBase = { identity: string; residual: Record<string, unknown> };
export type DirectoryRecord = RecordBase & {
  upn: string; upn_key: string; display_name: string | null; sort_key: string | null;
  company: string | null; department: string | null; account_enabled: boolean | null;
  user_type: string | null; employee_type: string | null; service_state: CopilotServiceSummaryState; plan_count: number;
};
export type PlanRecord = RecordBase & {
  user_id: string; plan_id: string; service: string; display_name: string; state: CopilotServiceState;
  capability_status: CopilotServicePlan["capabilityStatus"]; assigned_at: string | null;
};
export type ActivityRecord = RecordBase & {
  upn_key: string; report_refresh_date: string | null; last_activity_date: string | null;
  chat_date: string | null; teams_date: string | null; word_date: string | null; excel_date: string | null;
  powerpoint_date: string | null; outlook_date: string | null; onenote_date: string | null; loop_date: string | null; period: "D28" | "D30";
};
export type RecordKinds = { directory: DirectoryRecord; plans: PlanRecord; activity: ActivityRecord };
const definitions = {
  directory: { table: "directory_user_rows", columns: "upn text,upn_key text,display_name text,sort_key text,company text,department text,account_enabled boolean,user_type text,employee_type text,service_state text,plan_count integer" },
  plans: { table: "directory_service_plan_rows", columns: "user_id text,plan_id text,service text,display_name text,state text,capability_status text,assigned_at timestamptz" },
  activity: { table: "app_activity_rows", columns: "upn_key text,report_refresh_date date,last_activity_date date,chat_date date,teams_date date,word_date date,excel_date date,powerpoint_date date,outlook_date date,onenote_date date,loop_date date,period text" },
} as const;
const managedHeartbeats = new Map<string, { heartbeat: ReturnType<typeof generationHeartbeat>; published: boolean }>();

export function prepareGenerationBatch(lease: GenerationLease, rows: readonly RecordBase[], residency = new BatchResidency()) {
  if (rows.length > 250) throw dataLimitError("data_batch_rows", 250, rows.length);
  const releaseInput = residency.track(rows);
  let releaseNormalized: (() => void) | undefined;
  try {
    const records = rows.map(row => {
      const bytes = Buffer.byteLength(JSON.stringify(row.residual));
      assertResidualBytes(bytes, "generation_batch");
      return { ...row, content_hash: digest(JSON.stringify(row)), schema_version: lease.schemaVersion };
    });
    releaseNormalized = residency.track(records);
    return encodeBatch(records, [lease.id, lease.scopeId, lease.tenantId]);
  } finally { releaseNormalized?.(); releaseInput(); }
}

export async function lockDataScope(client: pg.PoolClient, scopeId: string, tenantId: string, mode: "share" | "update" = "update") {
  const row = (await client.query(`SELECT * FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2 FOR ${mode === "share" ? "SHARE" : "UPDATE"}`, [scopeId, tenantId])).rows[0];
  if (!row) throw new Error("data_scope_missing");
  return row;
}

export class DataGenerations {
  readonly connections;
  readonly batchResidency = new BatchResidency();
  constructor(readonly database: pg.Pool) { this.connections = dataConnections(database); }

  async begin(input: BeginGeneration): Promise<GenerationLease> {
    if (input.jobKind === "fixture" && process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") throw new Error("fixture_only");
    if (input.jobKind === "data_sync" && !input.runId) throw new Error("data_source_run_required");
    return this.connections.run(async client => {
      await client.query("SET LOCAL enable_seqscan=off; SET LOCAL jit=off");
      if (input.runId || ["inventory_packages", "inventory_power_platform", "inventory_canonical"].includes(input.scope.source)) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [`data-sync:${input.scope.tenantId}:${input.scope.principalId}`]);
      }
      await client.query("SELECT pg_advisory_xact_lock(3650147)");
      const s = input.scope;
      if (s.principalId !== null) {
        const epoch = await this.principalEpoch(client, s.tenantId, s.principalId);
        if (epoch !== input.sessionEpoch) throw new Error("data_session_fenced");
      }
      const inserted = (await client.query(`INSERT INTO data_scope_epochs(id,tenant_id,scope_kind,principal_id,token_mode,source,selector,session_epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,scope_kind,principal_id,token_mode,source,selector)
        DO NOTHING RETURNING *`,
      [randomUUID(), s.tenantId, s.kind, s.principalId, s.tokenMode, s.source, s.selector, input.sessionEpoch])).rows[0];
      const scope = inserted ?? (await client.query(`SELECT * FROM data_scope_epochs
        WHERE tenant_id=$1 AND scope_kind=$2 AND principal_id IS NOT DISTINCT FROM $3::text
          AND token_mode=$4 AND source=$5 AND selector=$6 FOR UPDATE`,
      [s.tenantId,s.kind,s.principalId,s.tokenMode,s.source,s.selector])).rows[0];
      if (!scope) throw new Error("data_scope_missing");
      await client.query(`INSERT INTO data_generation_heads(scope_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [scope.id, s.tenantId]);
      const head = (await client.query("SELECT revision FROM data_generation_heads WHERE scope_id=$1 FOR UPDATE", [scope.id])).rows[0];
      await client.query(`UPDATE data_generations SET state='failed',cancellation=cancellation+1,reserved_bytes=byte_count
        WHERE scope_id=$1 AND state IN ('staging','validating') AND (lease_until<=clock_timestamp() OR deadline_at<=clock_timestamp())`, [scope.id]);
      const counts = (await client.query(`SELECT count(*)::int AS active,
        count(*) FILTER(WHERE tenant_id=$1)::int AS tenant_active,
        count(*) FILTER(WHERE scope_id=$2)::int AS scope_active FROM data_generations
        WHERE state IN ('staging','validating') AND lease_until>(SELECT clock_timestamp())
          AND lease_until>clock_timestamp()`,[s.tenantId,scope.id])).rows[0];
      const bytes = (await client.query(`SELECT coalesce(sum(generation_bytes),0)::text AS bytes
        FROM data_generation_charges WHERE tenant_id=$1 AND generation_bytes>0`,[s.tenantId])).rows[0].bytes;
      const uploads = (await client.query(`SELECT count(DISTINCT tenant_id||':'||CASE WHEN state='accepting' THEN 'bundle:'||bundle_id::text ELSE 'file:'||id::text END)::int AS active,
        count(DISTINCT tenant_id||':'||CASE WHEN state='accepting' THEN 'bundle:'||bundle_id::text ELSE 'file:'||id::text END) FILTER(WHERE tenant_id=$1)::int AS tenant_active
        FROM official_usage_ingestions WHERE state IN ('streaming','validating','accepting') AND lease_until>clock_timestamp()`, [s.tenantId])).rows[0];
      if (counts.scope_active || counts.active + uploads.active >= 4 || counts.tenant_active + uploads.tenant_active >= 2) {
        throw dataAdmissionError("data_ingestion_admission");
      }
      if (exactCount(bytes) + input.reserveBytes > dataLimits.tenantBytes) throw dataLimitError("data_tenant_bytes", dataLimits.tenantBytes, exactCount(bytes) + input.reserveBytes);
      const lease: GenerationLease = {
        id: randomUUID(), scopeId: scope.id, tenantId: s.tenantId, owner: randomUUID(), version: 1,
        epoch: scope.epoch, sessionEpoch: scope.session_epoch, expectedRevision: head.revision, schemaVersion: input.schemaVersion,
      };
      await client.query(`INSERT INTO data_generations(id,scope_id,tenant_id,schema_version,scope_epoch,session_epoch,
        expected_revision,job_id,run_id,job_kind,owner,lease_version,lease_until,deadline_at,reserved_bytes,observed_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,clock_timestamp()+interval '60 seconds',$12,$13,$14,$15)`,
      [lease.id, scope.id, s.tenantId, input.schemaVersion, scope.epoch, scope.session_epoch, head.revision,
        input.jobId, input.runId ?? null, input.jobKind, lease.owner, input.deadlineAt, input.reserveBytes, input.observedAt, input.expiresAt]);
      await this.fence(client, lease);
      return lease;
    });
  }

  private async principalEpoch(client: pg.PoolClient, tenant: string, principal: string, lock: "share" | "update" = "update") {
    await client.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [tenant, principal]);
    return (await client.query(`SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR ${lock==="share" ? "SHARE" : "UPDATE"}`,
      [tenant, principal])).rows[0].epoch as string;
  }

  sessionEpoch(tenant: string, principal: string) {
    return this.connections.run(client => this.principalEpoch(client, tenant, principal, "share"));
  }

  revokePrincipal(tenant: string, principal: string) {
    return this.connections.run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(3650147)");
      await this.principalEpoch(client, tenant, principal);
      const epoch = (await client.query(`UPDATE data_principal_epochs SET epoch=epoch+1 WHERE tenant_id=$1 AND principal_id=$2 RETURNING epoch`, [tenant, principal])).rows[0].epoch;
      let after: string | null = null;
      for (;;) {
        const scopes: { id: string }[] = (await client.query<{ id: string }>(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
          AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 250 FOR UPDATE`, [tenant, principal, after])).rows;
        if (!scopes.length) break;
        for (const scope of scopes) {
          await client.query("SELECT scope_id FROM data_generation_heads WHERE scope_id=$1 FOR UPDATE", [scope.id]);
          await client.query("UPDATE data_scope_epochs SET epoch=epoch+1,session_epoch=$2 WHERE id=$1", [scope.id, epoch]);
          await client.query(`UPDATE data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
            WHERE scope_id=$1 AND state IN ('staging','validating')`, [scope.id]);
        }
        after = scopes.at(-1)!.id;
      }
      return epoch as string;
    });
  }

  private async lockSyncRun(client: pg.PoolClient, lease: GenerationLease) {
    await client.query("SET LOCAL enable_seqscan=off; SET LOCAL jit=off");
    await client.query(`WITH selected_generation AS MATERIALIZED (
        SELECT scope_id,tenant_id,run_id FROM data_generations WHERE id=$1
      ) SELECT pg_advisory_xact_lock(hashtextextended('data-sync:'||s.tenant_id||':'||s.principal_id,0))
      FROM selected_generation g JOIN data_scope_epochs s ON s.id=g.scope_id
      WHERE g.scope_id=$2 AND g.tenant_id=$3 AND (g.run_id IS NOT NULL
        OR s.source IN ('inventory_packages','inventory_power_platform','inventory_canonical'))`,
    [lease.id, lease.scopeId, lease.tenantId]);
  }

  // Run-backed writers share the sync mutex before scope/head/lease/job locks.
  async fence(client: pg.PoolClient, lease: GenerationLease) {
    await this.lockSyncRun(client, lease);
    const scope = await lockDataScope(client, lease.scopeId, lease.tenantId);
    await client.query("SELECT scope_id FROM data_generation_heads WHERE scope_id=$1 FOR UPDATE", [lease.scopeId]);
    const row = (await client.query(`WITH selected_generation AS MATERIALIZED (
        SELECT * FROM data_generations WHERE id=$1 FOR UPDATE
      ) SELECT g.* FROM selected_generation g JOIN data_scope_epochs s ON s.id=g.scope_id
      WHERE g.scope_id=$2 AND g.tenant_id=$3 AND g.owner=$4 AND g.lease_version=$5
      AND g.scope_epoch=$6 AND g.session_epoch=$7 AND s.epoch=g.scope_epoch AND s.session_epoch=g.session_epoch
      AND g.cancellation=0 AND g.state IN ('staging','validating')
      AND g.lease_until>clock_timestamp() AND g.deadline_at>clock_timestamp() AND g.expires_at>clock_timestamp()`,
    [lease.id, lease.scopeId, lease.tenantId, lease.owner, lease.version, lease.epoch, lease.sessionEpoch])).rows[0];
    if (!row) throw new Error("data_writer_fenced");
    if (row.run_id) {
      const run = (await client.query(`SELECT r.id FROM data_sync_runs r JOIN data_sync_source_jobs j
        ON j.run_id=r.id AND j.job_id=$2 JOIN data_sync_run_sources source ON source.run_id=r.id
        AND source.source_id=j.source_id AND source.attempt=j.attempt AND source.job_id=j.job_id
        WHERE r.id=$1 AND r.tenant_id=$3 AND r.principal_id=$4
        AND r.status IN ('running','waiting') AND r.expires_at>clock_timestamp()
        AND source.status IN ('queued','running') FOR SHARE OF r,source`,
      [row.run_id, row.job_id, lease.tenantId, scope.principal_id])).rows[0];
      if (!run) throw new Error("data_source_job_fenced");
    }
    if (row.job_kind === "package_refresh" || row.job_kind === "power_platform_refresh") {
      const table = row.job_kind === "package_refresh" ? "package_refresh_jobs" : "power_platform_refresh_jobs";
      if ((await client.query(`SELECT id FROM ${table} WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
        AND status='running' AND expires_at>clock_timestamp() FOR SHARE`, [row.job_id, lease.tenantId, scope.principal_id])).rowCount !== 1) {
        throw new Error("data_source_job_fenced");
      }
    }
    return row;
  }

  renew(lease: GenerationLease, validateInputs?: (client: pg.PoolClient) => Promise<void>) {
    return this.connections.run(async client => {
      await this.lockSyncRun(client, lease);
      await validateInputs?.(client);
      await this.fence(client, lease);
      const result = await client.query(`UPDATE data_generations SET lease_until=LEAST(deadline_at,clock_timestamp()+interval '60 seconds')
        WHERE id=$1 AND lease_until>clock_timestamp()
        RETURNING id,greatest(0,extract(epoch FROM clock_timestamp()-created_at)*1000)::bigint AS age`, [lease.id]);
      if (result.rowCount !== 1) throw new Error("data_writer_fenced");
      observeDataWork("generation", { oldestAgeMs: exactCount(result.rows[0].age) });
    }, true);
  }

  async append<K extends keyof RecordKinds>(lease: GenerationLease, kind: K, ordinal: number, rows: readonly RecordKinds[K][]) {
    const definition = definitions[kind];
    const batch = prepareGenerationBatch(lease, rows, this.batchResidency);
    const hash = digest(`${kind}:${batch.hash}`);
    return this.connections.run(async client => {
      const generation = await this.fence(client, lease);
      if (generation.state !== "staging") throw new Error("data_not_staging");
      const previous = (await client.query("SELECT digest FROM data_generation_batches WHERE generation_id=$1 AND ordinal=$2", [lease.id, ordinal])).rows[0];
      if (previous) {
        if (previous.digest !== hash) throw new Error("data_batch_replay_conflict");
        return { replay: true, parameterBytes: batch.bytes };
      }

      if (ordinal !== generation.batch_count) throw new Error("data_batch_order");
      const bytes = exactCount(generation.byte_count) + batch.bytes;
      if (bytes > exactCount(generation.reserved_bytes)) throw dataLimitError("data_generation_bytes", exactCount(generation.reserved_bytes), bytes);
      const maximumRows = generation.job_kind === "derived" ? dataLimits.derivedRows : dataLimits.sourceRows;
      if (kind !== "plans" && generation.row_count + rows.length > maximumRows) {
        throw dataLimitError("data_generation_rows", maximumRows, generation.row_count + rows.length);
      }
      if (kind==="directory") for (const row of rows as readonly DirectoryRecord[]) {
        if (row.plan_count>dataLimits.plansPerUser) throw dataLimitError("data_directory_plan_count",dataLimits.plansPerUser,row.plan_count);
      }
      await assertResidualDatabaseBounds(client, batch.json, "residual", rows);
      await client.query(`INSERT INTO data_generation_batches(generation_id,scope_id,tenant_id,ordinal,digest,row_count,parameter_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [lease.id, lease.scopeId, lease.tenantId, ordinal, hash, rows.length, batch.bytes]);
      const columns = definition.columns.split(",").map(column => column.split(" ")[0]).join(",");
      // Plan children reference newly loaded users before auto-analyze can run.
      if (kind === "plans") await client.query("SELECT set_config('enable_seqscan','off',true),set_config('plan_cache_mode','force_custom_plan',true),set_config('jit','off',true)");
      await client.query(`INSERT INTO ${definition.table}(generation_id,scope_id,tenant_id,identity,schema_version,content_hash,residual,${columns})
        SELECT $1,$2,$3,identity,schema_version,content_hash,residual,${columns}
        FROM jsonb_to_recordset($4::jsonb) AS r(identity text,schema_version integer,content_hash text,residual jsonb,${definition.columns})`,
      [lease.id, lease.scopeId, lease.tenantId, batch.json]);
      await client.query(`UPDATE data_generations SET batch_count=batch_count+1,byte_count=byte_count+$2,
        row_count=row_count+$3,child_count=child_count+$4,
        content_hash=encode(sha256(convert_to(coalesce(content_hash,'') || $5,'UTF8')),'hex') WHERE id=$1`,
      [lease.id, batch.bytes, kind === "plans" ? 0 : rows.length, kind === "plans" ? rows.length : 0, hash]);
      return { replay: false, parameterBytes: batch.bytes };
    }).catch(async error => {
      if (error?.code === "23505" || error?.message === "data_batch_replay_conflict") {
        try { await this.abort(lease); }
        catch (failure) { throw new AggregateError([error, failure], "data_poison_fence_failed"); }
      }
      throw error;
    });
  }

  observePage(lease: GenerationLease, token: string, wireRows: number) {
    if (!Number.isSafeInteger(wireRows) || wireRows < 0 || wireRows > dataLimits.wireRows) throw new Error("data_wire_rows");
    return this.connections.run(async client => {
      const generation = await this.fence(client, lease);
      if (generation.state !== "staging") throw new Error("data_not_staging");
      await client.query(`INSERT INTO data_generation_pages(generation_id,scope_id,tenant_id,ordinal,token_hash,wire_rows)
        VALUES($1,$2,$3,$4,$5,$6)`, [lease.id, lease.scopeId, lease.tenantId, generation.page_count, digest(token), wireRows]);
      await client.query("UPDATE data_generations SET page_count=page_count+1,wire_count=wire_count+$2 WHERE id=$1", [lease.id, wireRows]);
    }).catch(async error => {
      if (error?.code === "23505") await this.abort(lease);
      throw error;
    });
  }

  async validate(lease: GenerationLease, expected: { rows: number; children: number; batches: number; pages: number; wireRows: number }) {
    await this.connections.run(async client => {
      const row = await this.fence(client, lease);
      if (row.row_count !== expected.rows || row.child_count !== expected.children || row.batch_count !== expected.batches
        || row.page_count !== expected.pages || row.wire_count !== expected.wireRows) throw new Error("data_incomplete");
      await client.query(`UPDATE data_generations SET state='validating' WHERE id=$1`, [lease.id]);
    });
    while (!await this.validationStep(lease)) {
      // Release every lease/scope lock and client between durable slices.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await this.connections.run(async client => {
      const row = await this.fence(client, lease);
      if (row.validated_rows !== expected.rows || row.validated_children !== expected.children) throw new Error("data_incomplete");
      await client.query(`UPDATE data_generations SET validated=true,
        content_hash=coalesce(content_hash,encode(sha256(''::bytea),'hex')) WHERE id=$1`, [lease.id]);
    });
  }

  async validationStep(lease: GenerationLease) {
    return this.connections.run(async client => {
      const row = await this.fence(client, lease);
      if (row.state !== "validating") throw new Error("data_not_validating");
      if (row.validation_phase === "complete") return true;
      const directory = row.validation_phase === "directory";
      const table = directory ? "directory_user_rows" : "app_activity_rows";
      const summary = (await client.query(`WITH batch AS (
        SELECT identity${directory ? ",plan_count" : ""} FROM ${table}
        WHERE generation_id=$1 AND ($2::text IS NULL OR identity>$2) ORDER BY identity LIMIT 250)
        SELECT count(*)::int AS rows,max(identity) AS cursor,
          ${directory ? "coalesce(sum(plan_count),0)::int" : "0"} AS children,
          ${directory ? `coalesce(bool_and(plan_count=(SELECT count(*) FROM (
            SELECT 1 FROM directory_service_plan_rows p WHERE p.generation_id=$1 AND p.user_id=batch.identity LIMIT 1001
          ) facts)),true)` : "true"} AS valid FROM batch`, [lease.id, row.validation_cursor])).rows[0];
      if (!summary.valid) throw new Error("data_child_incomplete");
      const phase = summary.rows === 0 ? (directory ? "activity" : "complete") : row.validation_phase;
      await client.query(`UPDATE data_generations SET validation_phase=$2,validation_cursor=$3,
        validated_rows=validated_rows+$4,validated_children=validated_children+$5 WHERE id=$1`,
      [lease.id, phase, summary.rows === 0 ? null : summary.cursor, summary.rows, summary.children]);
      return phase === "complete";
    });
  }

  async publish(lease: GenerationLease, options: {
    validateInputs?: (client: pg.PoolClient) => Promise<void>;
    completeJob?: (client: pg.PoolClient, result: { jobId: string; runId: string | null; rows: number; bytes: number }) => Promise<void>;
  } = {}) {
    const managed = managedHeartbeats.get(lease.id);
    const heartbeat = managed?.heartbeat;
    // A terminal commit must not race a timer interpreting its published state
    // as a lost lease. Keep cancellation armed until COMMIT nevertheless.
    await heartbeat?.pause();
    heartbeat?.signal.throwIfAborted();
    let publishedRows = 0;
    const revision = await measurePublication(() => publishedRows>=1000 ? "generation-large" : "generation-bounded",() => this.connections.run(async client => {
      await this.lockSyncRun(client, lease);
      // Domain-owned input reachability is checked in this same transaction.
      // It must lock captured roots in scope order; newer safe heads are not a
      // reason to reject a still-readable captured vector.
      await options.validateInputs?.(client);
      const row = await this.fence(client, lease);
      publishedRows = row.row_count;
      if (row.job_kind === "derived" && !options.validateInputs) throw new Error("data_input_fence_required");
      if (row.job_kind !== "fixture" && !options.completeJob) throw new Error("data_job_completion_required");
      if (row.state !== "validating" || !row.validated) throw new Error("data_not_validated");
      const previous = (await client.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [lease.scopeId])).rows[0];
      const result = await client.query(`UPDATE data_generation_heads SET generation_id=$1,revision=revision+1
        WHERE scope_id=$2 AND tenant_id=$3 AND revision=$4 RETURNING revision::text`,
      [lease.id, lease.scopeId, lease.tenantId, lease.expectedRevision]);
      if (result.rowCount !== 1) throw new Error("data_head_conflict");
      if (previous.generation_id) await client.query("UPDATE data_generations SET state='retired' WHERE id=$1 AND state='published'", [previous.generation_id]);
      await client.query("UPDATE data_generations SET state='published',reserved_bytes=byte_count WHERE id=$1", [lease.id]);
      await options.completeJob?.(client, { jobId: row.job_id, runId: row.run_id, rows: row.row_count, bytes: exactCount(row.byte_count) });
      observeDataWork("generation", { rows: row.row_count, bytes: exactCount(row.byte_count) });
      return result.rows[0].revision as string;
    }, false, heartbeat?.signal));
    if (managed) managed.published = true;
    await heartbeat?.stop();
    return revision;
  }

  abort(lease: GenerationLease, cancelled = false) {
    return this.connections.run(async client => {
      await lockDataScope(client, lease.scopeId, lease.tenantId);
      await client.query("SELECT scope_id FROM data_generation_heads WHERE scope_id=$1 FOR UPDATE", [lease.scopeId]);
      await client.query(`UPDATE data_generations SET state=$4,cancellation=cancellation+1,reserved_bytes=byte_count
        WHERE id=$1 AND owner=$2 AND lease_version=$3 AND state IN ('staging','validating')`,
      [lease.id, lease.owner, lease.version, cancelled ? "cancelled" : "failed"]);
    });
  }

  invalidate(scopeId: string, tenantId: string, invalidateDomain?: (client: pg.PoolClient) => Promise<void>) {
    return this.connections.run(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('data-sync:'||tenant_id||':'||principal_id,0))
        FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2 AND source IN ('inventory_packages','inventory_power_platform','inventory_canonical')`, [scopeId, tenantId]);
      await lockDataScope(client, scopeId, tenantId);
      await client.query("SELECT scope_id FROM data_generation_heads WHERE scope_id=$1 FOR UPDATE", [scopeId]);
      await client.query(`UPDATE data_scope_epochs SET epoch=epoch+1 WHERE id=$1`, [scopeId]);
      await client.query(`UPDATE data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count
        WHERE scope_id=$1 AND state IN ('staging','validating')`, [scopeId]);
      await invalidateDomain?.(client);
    });
  }

  async execute<T>(input: BeginGeneration, work: (lease: GenerationLease, signal: AbortSignal) => Promise<T>, parent?: AbortSignal,
    heartbeatFence?: (client: pg.PoolClient) => Promise<void>) {
    parent?.throwIfAborted();
    const lease = await admitGeneration(this.database, () => this.begin(input), lease => this.abort(lease, true), input.deadlineAt, parent);
    const heartbeat = generationHeartbeat(() => this.renew(lease, heartbeatFence), parent);
    const managed = { heartbeat, published: false };
    managedHeartbeats.set(lease.id, managed);
    let fencing: Promise<unknown> | undefined;
    const cancelled = () => { fencing = this.abort(lease, true); void fencing.catch(() => {}); };
    heartbeat.signal.addEventListener("abort", cancelled, { once: true });
    try {
      heartbeat.signal.throwIfAborted();
      const result = await work(lease, heartbeat.signal);
      if (!managed.published) {
        heartbeat.signal.throwIfAborted();
        throw new Error("data_work_unfinished");
      }
      return result;
    } catch (error) {
      try { await (fencing ?? this.abort(lease, parent?.aborted)); }
      catch (failure) { throw new AggregateError([error, failure], "data_work_and_fence_failed"); }
      throw error;
    } finally {
      heartbeat.signal.removeEventListener("abort", cancelled);
      managedHeartbeats.delete(lease.id);
      await heartbeat.stop();
    }
  }
}

export function generationHeartbeat(
  renew: () => Promise<void>, parent?: AbortSignal,
): { signal: AbortSignal; pause: () => Promise<void>; stop: () => Promise<void> } {
  const controller = new AbortController();
  let pending = Promise.resolve();
  let stopped = false;
  const cancel = () => { stopped = true; clearInterval(timer); controller.abort(parent?.reason ?? new Error("data_cancelled")); };
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      try { await renew(); }
      catch (error) { stopped = true; clearInterval(timer); controller.abort(error); }
    });
  }, dataLimits.heartbeatMs);
  timer.unref();
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  return {
    signal: controller.signal,
    pause: async () => { stopped = true; clearInterval(timer); await pending; },
    stop: async () => { stopped = true; clearInterval(timer); parent?.removeEventListener("abort", cancel); await pending; },
  };
}
