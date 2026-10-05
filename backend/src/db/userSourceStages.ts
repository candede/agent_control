import type pg from "pg";
import { AppError } from "../errors.js";
import { dataLimitError, digest, encodeBatch, exactCount } from "./dataBounds.js";
import { DataGenerations, prepareGenerationBatch, type ActivityRecord, type BeginGeneration, type GenerationLease, type RecordKinds } from "./dataGenerations.js";
import { copilotAppActivityPeriod, type CopilotDirectoryUser } from "../types/copilotUsage.js";
import { directoryPlanRecord, directorySourceRecord } from "../services/userSourceRecords.js";
import { parseReportedIdentity } from "../services/userSourceGraphFields.js";
import type { UserSourceKind } from "../types/userSources.js";

type GenerationCompletion = NonNullable<NonNullable<Parameters<DataGenerations["publish"]>[1]>["completeJob"]>;
export type UserSourceCompletion = (client: pg.PoolClient,
  result: Parameters<GenerationCompletion>[1] & { source: UserSourceKind; generationId: string }) => Promise<void>;
export type UserSourceQueryKind = "catalog" | "discovery" | "identity" | "activity";
const queryPageLimits: Record<UserSourceQueryKind, number> = { catalog: 200, discovery: 1000, identity: 6000, activity: 10000 };

export class UserSourceStages {
  readonly generations: DataGenerations;
  maximumParameterBytes = 0;
  constructor(database: pg.Pool) { this.generations = new DataGenerations(database); }

  async execute(input: BeginGeneration, work: (lease: GenerationLease, signal: AbortSignal) => Promise<void>,
    options: { signal?: AbortSignal; completeJob?: UserSourceCompletion; beforePublish: (signal: AbortSignal) => Promise<void> }) {
    if (!["directory", "app_activity"].includes(input.scope.source) || input.scope.kind !== "principal"
      || input.scope.selector !== "complete" || input.schemaVersion !== 1
      || !["data_sync", "fixture"].includes(input.jobKind)) throw new Error("user_source_scope");
    if (input.deadlineAt.getTime() - Date.now() > 30 * 60_000) throw dataLimitError("user_source_deadline", 30 * 60_000, input.deadlineAt.getTime() - Date.now());
    if (input.jobKind !== "fixture" && !options.completeJob) throw new Error("data_job_completion_required");
    const activityPeriod = copilotAppActivityPeriod;
    let owned: GenerationLease | undefined;
    try {
      return await this.generations.execute(input, async (lease, signal) => {
        owned = lease;
        await this.generations.connections.run(async client => {
          await this.generations.fence(client, lease);
          await client.query(`INSERT INTO user_source_attempts(generation_id,scope_id,tenant_id,source,report_period) VALUES($1,$2,$3,$4,$5)`,
            [lease.id, lease.scopeId, lease.tenantId, input.scope.source, activityPeriod]);
        });
        await work(lease, signal);
        signal.throwIfAborted();
        await this.validate(lease);
        await options.beforePublish(signal);
        signal.throwIfAborted();
        const revision = await this.generations.publish(lease, {
          completeJob: async (client, result) => {
            await client.query(`UPDATE user_source_attempts SET status='available',message=$2,
              report_refresh_date=(SELECT min(report_refresh_date) FROM app_activity_rows WHERE generation_id=$1)
              WHERE generation_id=$1`, [lease.id, input.scope.source === "directory"
              ? `Checked ${result.rows} directory users; this is not tenant headcount or basic Copilot Chat usage.`
              : `Saved ${result.rows} Microsoft 365 Copilot ${activityPeriod} app activity rows.`]);
            await options.completeJob?.(client, { ...result, source: input.scope.source as UserSourceKind, generationId: lease.id });
          },
        });
        return { generationId: lease.id, scopeId: lease.scopeId, revision, ...await this.counts(lease) };
      }, options.signal);
    } catch (error) {
      if (owned) {
        const lease = owned;
        const status = options.signal?.aborted ? "cancelled"
          : error instanceof AppError && error.status === 401 ? "waiting_authorization"
            : error instanceof AppError && error.status === 403 ? "permission_required" : "failed";
        const code = error instanceof AppError && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "user_source_failed";
        await this.generations.connections.run(async client => {
          const message = status === "permission_required" ? input.scope.source === "directory"
            ? "Directory requires User.Read.All, LicenseAssignment.Read.All and the corresponding provider role."
            : "App activity requires Reports.Read.All and the corresponding provider role."
            : status === "waiting_authorization" ? "Renew Microsoft authorization and explicitly resume this source."
              : status === "cancelled" ? "The source refresh was cancelled." : userSourceFailureMessage(error);
          await client.query(`UPDATE user_source_attempts SET status=$2,error_code=$3,message=$4
            WHERE generation_id=$1 AND status='running'`, [lease.id, status, code, message]);
        }).catch(failure => { throw new AggregateError([error, failure], "user_source_failure_record"); });
      }
      throw error;
    }
  }

  private encoded(rows: readonly unknown[], values: readonly unknown[]) {
    const batch = encodeBatch(rows, values);
    this.maximumParameterBytes = Math.max(this.maximumParameterBytes, batch.bytes);
    return batch;
  }

  private async guarded<T>(lease: GenerationLease, work: (client: pg.PoolClient) => Promise<T>) {
    try {
      return await this.generations.connections.run(async client => {
        const generation = await this.generations.fence(client, lease);
        if (generation.state !== "staging") throw new Error("data_not_staging");
        return work(client);
      });
    } catch (error) {
      await this.generations.abort(lease);
      throw error;
    }
  }

  private async charge(client: pg.PoolClient, lease: GenerationLease, bytes: number) {
    const row = (await client.query("SELECT byte_count,reserved_bytes FROM data_generations WHERE id=$1", [lease.id])).rows[0];
    const observed = exactCount(row.byte_count) + bytes;
    if (observed > exactCount(row.reserved_bytes)) throw dataLimitError("data_generation_bytes", exactCount(row.reserved_bytes), observed);
    await client.query("UPDATE data_generations SET byte_count=byte_count+$2 WHERE id=$1", [lease.id, bytes]);
  }

  async query(lease: GenerationLease, kind: UserSourceQueryKind, initialUrl: string) {
    const key = digest(`${kind}:${initialUrl}`);
    await this.guarded(lease, client => client.query(`INSERT INTO user_source_queries(generation_id,scope_id,tenant_id,query_key,kind)
      VALUES($1,$2,$3,$4,$5)`, [lease.id, lease.scopeId, lease.tenantId, key, kind]));
    return key;
  }

  async page(lease: GenerationLease, key: string, url: string, wireRows: number, reportedCount?: number) {
    if (reportedCount !== undefined && (!Number.isSafeInteger(reportedCount) || reportedCount < 0 || reportedCount > 100_000)) {
      await this.generations.abort(lease);
      throw new AppError(502, "provider_count_mismatch", "Invalid provider count.");
    }
    const counts = await this.counts(lease);
    if (counts.pages >= 10000) throw dataLimitError("provider_page_limit", 10000, counts.pages + 1);
    if (counts.wireRows + wireRows > 5_000_000) throw dataLimitError("provider_wire_rows", 5_000_000, counts.wireRows + wireRows);
    await this.generations.observePage(lease, url, wireRows);
    await this.guarded(lease, async client => {
      const query = (await client.query<{ kind: UserSourceQueryKind; complete: boolean; expected_count: number | null; page_count: number }>(
        "SELECT kind,complete,expected_count,page_count FROM user_source_queries WHERE generation_id=$1 AND query_key=$2", [lease.id, key])).rows[0];
      if (!query || query.complete || query.expected_count !== null && reportedCount !== undefined && query.expected_count !== reportedCount
        || query.page_count === 0 && ["discovery", "identity"].includes(query.kind) && reportedCount === undefined) {
        throw new AppError(502, "provider_count_mismatch", "Inconsistent or missing provider count.");
      }
      const total = (await client.query(`SELECT coalesce(sum(page_count),0)::int AS count
        FROM user_source_queries WHERE generation_id=$1 AND kind=$2`, [lease.id, query.kind])).rows[0].count;
      const limit = queryPageLimits[query.kind];
      if (total >= limit) throw dataLimitError("provider_page_limit", limit, total + 1);
      await client.query(`UPDATE user_source_queries SET page_count=page_count+1,wire_count=wire_count+$3,
        expected_count=coalesce(expected_count,$4) WHERE generation_id=$1 AND query_key=$2`,
      [lease.id, key, wireRows, reportedCount ?? null]);
    });
  }

  private async members(client: pg.PoolClient, lease: GenerationLease, key: string, identities: readonly string[]) {
    const batch = this.encoded(identities, [lease.id, key]);
    await client.query(`INSERT INTO user_source_query_members(generation_id,query_key,identity)
      SELECT $1,$2,value FROM jsonb_array_elements_text($3::jsonb) ON CONFLICT DO NOTHING`, [lease.id, key, batch.json]);
    await this.charge(client, lease, batch.bytes);
  }

  async finishQuery(lease: GenerationLease, key: string) {
    await this.guarded(lease, async client => {
      const row = (await client.query(`SELECT q.*, (SELECT count(*)::int FROM user_source_query_members m
        WHERE m.generation_id=q.generation_id AND m.query_key=q.query_key) AS members
        FROM user_source_queries q WHERE generation_id=$1 AND query_key=$2`, [lease.id, key])).rows[0];
      if (!row || row.complete || row.expected_count !== null && row.expected_count !== row.members) {
        throw new AppError(502, "provider_count_mismatch", "Provider pages did not reconcile.");
      }
      await client.query("UPDATE user_source_queries SET complete=true WHERE generation_id=$1 AND query_key=$2", [lease.id, key]);
    });
  }

  async skus(lease: GenerationLease, key: string, rows: readonly { skuId: string; servicePlanIds: readonly string[] }[]) {
    const batch = this.encoded(rows, [lease.id, lease.scopeId, lease.tenantId]);
    await this.guarded(lease, async client => {
      const seen = new Map<string, string>();
      for (const row of rows) {
        const hash = JSON.stringify(row.servicePlanIds);
        if (seen.has(row.skuId) && seen.get(row.skuId) !== hash) throw new AppError(502, "provider_schema", "Conflicting SKU evidence.");
        seen.set(row.skuId, hash);
      }
      const conflict = (await client.query(`SELECT 1 FROM jsonb_to_recordset($2::jsonb) r("skuId" uuid,"servicePlanIds" text[])
        JOIN user_source_skus s ON s.generation_id=$1 AND s.sku_id=r."skuId"
        WHERE s.plan_ids<>r."servicePlanIds" LIMIT 1`, [lease.id, batch.json])).rowCount;
      if (conflict) throw new AppError(502, "provider_schema", "Conflicting SKU evidence.");
      await client.query(`INSERT INTO user_source_skus(generation_id,scope_id,tenant_id,sku_id,plan_ids)
        SELECT $1,$2,$3,"skuId","servicePlanIds" FROM jsonb_to_recordset($4::jsonb) r("skuId" uuid,"servicePlanIds" text[])
        ON CONFLICT DO NOTHING`, [lease.id, lease.scopeId, lease.tenantId, batch.json]);
      await this.charge(client, lease, batch.bytes);
      await this.members(client, lease, key, rows.map(row => row.skuId));
      const count = (await client.query("SELECT count(*)::int AS n FROM user_source_skus WHERE generation_id=$1", [lease.id])).rows[0].n;
      if (count > 1000) throw dataLimitError("provider_sku_limit", 1000, count);
    });
  }

  skuBatch(lease: GenerationLease, after = ""): Promise<{ skuId: string; servicePlanIds: string[] }[]> {
    return this.guarded(lease, async client => (await client.query(`SELECT sku_id::text AS "skuId",plan_ids AS "servicePlanIds"
      FROM user_source_skus WHERE generation_id=$1 AND cardinality(plan_ids)>0 AND sku_id::text>$2 ORDER BY sku_id LIMIT 20`,
    [lease.id, after])).rows);
  }

  skuEvidence(lease: GenerationLease, ids: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>> {
    if (ids.length > 1000) throw dataLimitError("provider_sku_limit", 1000, ids.length);
    return this.guarded(lease, async client => new Map((await client.query(`SELECT sku_id::text,plan_ids FROM user_source_skus
      WHERE generation_id=$1 AND sku_id=ANY($2::uuid[])`, [lease.id, ids])).rows.map(row => [row.sku_id, row.plan_ids])));
  }

  async identities(lease: GenerationLease, values: readonly string[]) {
    if (values.length > 250) throw dataLimitError("data_batch_rows", 250, values.length);
    const batch = this.encoded(values.map(value => parseReportedIdentity(value)).filter((value): value is string => value !== null),
      [lease.id, lease.scopeId, lease.tenantId]);
    await this.guarded(lease, async client => {
      await client.query(`INSERT INTO user_source_identity_inputs(generation_id,scope_id,tenant_id,identity)
        SELECT $1,$2,$3,value FROM jsonb_array_elements_text($4::jsonb) ON CONFLICT DO NOTHING`,
      [lease.id, lease.scopeId, lease.tenantId, batch.json]);
      await this.charge(client, lease, batch.bytes);
      const n = (await client.query("SELECT count(*)::int AS n FROM user_source_identity_inputs WHERE generation_id=$1", [lease.id])).rows[0].n;
      if (n > 100_000) throw dataLimitError("provider_identity_limit", 100_000, n);
    });
  }

  async verificationBatch(lease: GenerationLease): Promise<string[]> {
    for (;;) {
      const batch = await this.guarded(lease, async client => {
        const rows = (await client.query(`SELECT i.identity,EXISTS(SELECT 1 FROM directory_user_rows d
          WHERE d.generation_id=i.generation_id AND (d.identity=i.identity OR d.upn_key=i.identity)) AS known
          FROM user_source_identity_inputs i WHERE i.generation_id=$1 AND NOT i.checked ORDER BY i.identity LIMIT 250`, [lease.id])).rows;
        const known = rows.filter(row => row.known).map(row => row.identity);
        if (known.length) await client.query(`UPDATE user_source_identity_inputs SET checked=true
          WHERE generation_id=$1 AND identity=ANY($2::text[]) AND NOT checked`, [lease.id, known]);
        return { size: rows.length, unknown: rows.filter(row => !row.known).slice(0, 20).map(row => row.identity as string) };
      });
      if (batch.unknown.length || batch.size < 250) return batch.unknown;
    }
  }

  verified(lease: GenerationLease, ids: readonly string[]) {
    if (!ids.length || ids.length > 20) throw new Error("user_source_verification_batch");
    return this.guarded(lease, client => client.query(`UPDATE user_source_identity_inputs SET checked=true
      WHERE generation_id=$1 AND identity=ANY($2::text[]) AND NOT checked`, [lease.id, ids]));
  }

  async directory(lease: GenerationLease, key: string, users: readonly CopilotDirectoryUser[]) {
    this.encoded(users, [lease.id, lease.scopeId, lease.tenantId]);
    const normalized = users.map(directorySourceRecord);
    const unique = new Map<string, number>();
    const pending = await this.guarded(lease, async client => {
      const existing = new Map((await client.query(`SELECT identity,residual->>'evidenceHash' AS hash FROM directory_user_rows
        WHERE generation_id=$1 AND identity=ANY($2::text[])`, [lease.id, normalized.map(row => row.identity)])).rows.map(row => [row.identity, row.hash]));
      for (const [index, row] of normalized.entries()) {
        const previous = unique.get(row.identity);
        const hash = previous === undefined ? existing.get(row.identity) : normalized[previous].residual.evidenceHash;
        if (hash !== undefined && hash !== row.residual.evidenceHash) throw new AppError(502, "provider_schema", "Conflicting duplicate directory identity.");
        if (!existing.has(row.identity) && previous === undefined) unique.set(row.identity, index);
      }
      await this.members(client, lease, key, normalized.map(row => row.identity));
      return [...unique.values()];
    });
    await this.append(lease, "directory", pending.map(index => normalized[index]));
    let plans: RecordKinds["plans"][] = [];
    for (const index of pending) {
      for (const plan of users[index].servicePlans) {
        const row = directoryPlanRecord(normalized[index].identity, plan);
        if (plans.length === 250) { await this.append(lease, "plans", plans); plans = []; }
        plans.push(row);
      }
    }
    await this.append(lease, "plans", plans);
  }

  async activity(lease: GenerationLease, key: string, rows: readonly ActivityRecord[]) {
    for (const row of rows) {
      if (!["D28", "D30"].includes(row.period) || !row.upn_key || row.upn_key.length > 320 || row.upn_key !== row.upn_key.trim().toLowerCase()
        || /[\0\r\n]/.test(row.upn_key) || row.report_refresh_date === null) throw new AppError(502, "provider_schema", "Invalid activity identity or period.");
      for (const field of ["report_refresh_date", "last_activity_date", "chat_date", "teams_date", "word_date", "excel_date",
        "powerpoint_date", "outlook_date", "onenote_date", "loop_date"] as const) {
        const value = row[field];
        if (value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))
          || new Date(value).toISOString().slice(0, 10) !== value)) throw new AppError(502, "provider_schema", "Invalid activity date.");
      }
    }
    await this.append(lease, "activity", rows);
    await this.guarded(lease, client => this.members(client, lease, key, rows.map(row => row.identity)));
  }

  async append<K extends keyof RecordKinds>(lease: GenerationLease, kind: K, rows: readonly RecordKinds[K][]) {
    if (rows.length > 250) throw dataLimitError("data_batch_rows", 250, rows.length);
    if (!rows.length) return;
    // Shrink at either limit; a single oversized record still fails.
    let offset = 0;
    while (offset < rows.length) {
      let size = Math.min(250, rows.length - offset);
      while (true) {
        try { prepareGenerationBatch(lease, rows.slice(offset, offset + size)); break; }
        catch (error) {
          if (!(error instanceof AppError) || error.code !== "data_batch_bytes" || size === 1) throw error;
          size = Math.max(1, Math.floor(size / 2));
        }
      }
      const ordinal = (await this.counts(lease)).batches;
      const result = await this.generations.append(lease, kind, ordinal, rows.slice(offset, offset + size));
      this.maximumParameterBytes = Math.max(this.maximumParameterBytes, result.parameterBytes);
      offset += size;
    }
  }

  counts(lease: GenerationLease) {
    return this.generations.connections.selectedRead(async client => {
      const row = (await client.query(`SELECT row_count,child_count,batch_count,page_count,wire_count,byte_count
        FROM data_generations WHERE id=$1 AND scope_id=$2 AND tenant_id=$3`, [lease.id, lease.scopeId, lease.tenantId])).rows[0];
      if (!row) throw new Error("user_source_missing");
      return { rows: row.row_count as number, children: row.child_count as number, batches: row.batch_count as number,
        pages: row.page_count as number, wireRows: row.wire_count as number, bytes: exactCount(row.byte_count) };
    });
  }

  assertNewPage(lease: GenerationLease, key: string, url: string) {
    return this.guarded(lease, async client => {
      const row = (await client.query<{ pages: number; kind: UserSourceQueryKind; complete: boolean; kind_pages: number; repeated: boolean }>(`
        SELECT g.page_count AS pages,q.kind,q.complete,
          (SELECT coalesce(sum(page_count),0)::int FROM user_source_queries WHERE generation_id=g.id AND kind=q.kind) AS kind_pages,
          EXISTS(SELECT 1 FROM data_generation_pages WHERE generation_id=g.id AND token_hash=$3) AS repeated
        FROM data_generations g JOIN user_source_queries q ON q.generation_id=g.id
        WHERE g.id=$1 AND q.query_key=$2`, [lease.id, key, digest(url)])).rows[0];
      if (!row || row.complete || row.repeated) throw new AppError(502, "provider_schema", "Invalid or repeated provider continuation.");
      if (row.pages >= 10000) throw dataLimitError("provider_page_limit", 10000, row.pages + 1);
      const limit = queryPageLimits[row.kind];
      if (row.kind_pages >= limit) throw dataLimitError("provider_page_limit", limit, row.kind_pages + 1);
    });
  }

  progress(lease: GenerationLease) {
    return this.guarded(lease, async client => {
      const row = (await client.query(`UPDATE user_source_attempts a SET observed_count=g.row_count
        FROM data_generations g WHERE a.generation_id=$1 AND g.id=a.generation_id RETURNING a.observed_count`, [lease.id])).rows[0];
      return row.observed_count as number;
    });
  }

  async validate(lease: GenerationLease) {
    await this.guarded(lease, async client => {
      const bad = (await client.query(`SELECT
        NOT EXISTS(SELECT 1 FROM user_source_queries WHERE generation_id=$1) AS no_queries,
        EXISTS(SELECT 1 FROM user_source_queries WHERE generation_id=$1 AND NOT complete) AS incomplete,
        EXISTS(SELECT 1 FROM user_source_identity_inputs i WHERE generation_id=$1 AND NOT checked
          AND NOT EXISTS(SELECT 1 FROM directory_user_rows d WHERE d.generation_id=$1 AND (d.identity=i.identity OR d.upn_key=i.identity))) AS unchecked,
        (SELECT count(DISTINCT report_refresh_date)>1 OR count(*)<>count(report_refresh_date)
          OR bool_or(period<>(SELECT report_period FROM user_source_attempts WHERE generation_id=$1))
          FROM app_activity_rows WHERE generation_id=$1) AS dates,
        EXISTS(SELECT 1 FROM user_source_attempts a WHERE generation_id=$1 AND
          (a.source='directory' AND EXISTS(SELECT 1 FROM app_activity_rows WHERE generation_id=$1)
          OR a.source='app_activity' AND EXISTS(SELECT 1 FROM directory_user_rows WHERE generation_id=$1))) AS mixed`, [lease.id])).rows[0];
      if (bad.no_queries || bad.incomplete || bad.unchecked || bad.dates || bad.mixed) throw new AppError(502, "provider_schema", "Incomplete user-source evidence.");
    });
    await this.generations.validate(lease, await this.counts(lease));
  }

}

function userSourceFailureMessage(error: unknown) {
  let reason = "The latest source refresh failed.";
  if (error instanceof AppError && error.code === "report_download_failed") {
    const status = error.details && typeof error.details === "object" && "httpStatus" in error.details
      ? error.details.httpStatus : undefined;
    reason = `Microsoft 365 Copilot app activity report download failed${typeof status === "number"
      && Number.isInteger(status) && status >= 400 && status <= 599 ? ` (HTTP ${status})` : ""}. Retry Users sync; if this persists, check Microsoft 365 service health.`;
  } else if (error instanceof AppError && error.code === "identity_provider_error") {
    reason = "Microsoft Entra ID could not renew authorization. Retry Users sync; if this persists, review the Entra sign-in logs and application configuration.";
  }
  return `${reason} Any preceding complete source remains retained.`;
}
