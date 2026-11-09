import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError, errorTelemetry } from "../errors.js";
import { DataGenerations, type GenerationLease } from "./dataGenerations.js";
import { dataLimits, digest, encodeBatch, dataLimitError, exactCount } from "./dataBounds.js";
import { userSourceFactsSql } from "./userSources.js";
import { isCopilotAppActivityFresh } from "../types/copilotUsage.js";
import { officeApps, type OfficeMetrics, type OfficeObservation, type OfficePerson, type OfficeStatus, type OfficeUnknownReason } from "../types/officeAppAdoption.js";
import { classifyOfficeApps, emptyOfficeCoverage, emptyOfficeMetrics, officeDate, officeExpiry, officeRetentionCutoff, officeWindowStart, officeWeekStart } from "../services/officeAppAdoption.js";
import { reportSearchSql } from "../services/largeTenantUsersReports.js";
import { operationalLog } from "../services/telemetry.js";
import { observeDataWork } from "../services/dataMetrics.js";

type SourceHead = {
  id: string; scope_id: string; source: "directory" | "app_activity"; epoch: string; revision: string;
  observed_at: Date; expires_at: Date; report_refresh_date: string | null; report_period: string;
  office_vector: string | null; office_status: OfficeStatus["state"] | null; office_error_code: string | null;
};
type SourceVector = { directory: SourceHead; app: SourceHead; hash: string };
const sourceSql = `SELECT g.id,s.id AS scope_id,s.source,s.epoch::text,h.revision::text,g.observed_at,g.expires_at,
  a.report_refresh_date::text,a.report_period,a.office_vector,a.office_status,a.office_error_code
  FROM data_scope_epochs s JOIN data_generation_heads h ON h.scope_id=s.id AND h.tenant_id=s.tenant_id
  JOIN data_generations g ON g.id=h.generation_id AND g.scope_id=s.id AND g.tenant_id=s.tenant_id
  JOIN user_source_attempts a ON a.generation_id=g.id AND a.status='available'
  WHERE s.tenant_id=$1 AND s.source IN ('directory','app_activity') AND s.scope_kind='tenant'
    AND s.selector='complete' AND g.state='published' AND g.validated AND g.scope_epoch=s.epoch`;

export const readableOfficeSql = `FROM office_observations o JOIN data_generations g ON g.id=o.generation_id
  JOIN data_scope_epochs s ON s.id=o.scope_id AND s.tenant_id=o.tenant_id AND s.epoch=g.scope_epoch
  JOIN data_generation_heads h ON h.scope_id=o.scope_id AND h.generation_id=o.generation_id
  WHERE o.tenant_id=$1 AND g.state='published' AND g.validated AND g.expires_at>clock_timestamp()`;

const officeMetricProjection = `count(*)::text AS licensed,
  count(*) FILTER(WHERE jsonb_array_length(payload->'recentApps')>0)::text AS active,
  coalesce(sum(jsonb_array_length(payload->'recentApps')),0)::text AS pairs,
  count(*) FILTER(WHERE jsonb_array_length(payload->'recentApps')=0)::text AS no_recent,
  count(*) FILTER(WHERE jsonb_array_length(payload->'recentApps')=0 AND jsonb_array_length(payload->'unknownReasons')>0)::text AS unknown,
  ${officeApps.map(app => `count(*) FILTER(WHERE payload->'recentApps' ? '${app.id}')::text AS ${app.id}`).join(",")}`;

export function officeMetrics(row: pg.QueryResultRow): OfficeMetrics {
  const result = emptyOfficeMetrics();
  result.savedLicensedPeople = exactCount(row.licensed);
  result.reportedActiveUsers = exactCount(row.active);
  result.activeUserAppPairs = exactCount(row.pairs);
  result.noRecentEvidencePeople = exactCount(row.no_recent);
  result.unknownEvidencePeople = exactCount(row.unknown);
  for (const app of officeApps) result.perApp[app.id] = exactCount(row[app.id]);
  result.appsUsed = officeApps.filter(app => result.perApp[app.id] > 0).length;
  return result;
}
export const officeGroupMetricProjection = [
  ["licensed","savedLicensedPeople"],["active","reportedActiveUsers"],["pairs","activeUserAppPairs"],
  ["no_recent","noRecentEvidencePeople"],["unknown","unknownEvidencePeople"],
].map(([column,key])=>`coalesce(sum((metrics->>'${key}')::bigint),0)::text AS ${column}`)
  .concat(officeApps.map(app=>`coalesce(sum((metrics->'perApp'->>'${app.id}')::bigint),0)::text AS ${app.id}`)).join(",");

export function officeSavedMetrics(value: unknown): OfficeMetrics {
  if (!value || typeof value!=="object" || Array.isArray(value)) throw new Error("office_metrics_invalid");
  const record = value as Record<string,unknown>;
  const result = emptyOfficeMetrics();
  for (const key of ["savedLicensedPeople","reportedActiveUsers","activeUserAppPairs","appsUsed","noRecentEvidencePeople","unknownEvidencePeople"] as const) {
    const count = record[key];
    if (typeof count!=="number" || !Number.isSafeInteger(count) || count<0) throw new Error("office_metrics_invalid");
    result[key] = count;
  }
  if (!record.perApp || typeof record.perApp!=="object" || Array.isArray(record.perApp)) throw new Error("office_metrics_invalid");
  const apps = record.perApp as Record<string,unknown>;
  for (const app of officeApps) {
    const count = apps[app.id];
    if (typeof count!=="number" || !Number.isSafeInteger(count) || count<0) throw new Error("office_metrics_invalid");
    result.perApp[app.id] = count;
  }
  return result;
}

function officeSourcesUnavailable(directory:SourceHead | undefined, app:SourceHead | undefined, now:Date) {
  if (!directory || !app) return true;
  const refresh=app.report_refresh_date;
  return !officeDate(refresh) || refresh>now.toISOString().slice(0,10) || app.report_period!=="D28"
    || app.expires_at<=now || directory.expires_at<=now || now.getTime()-directory.observed_at.getTime()>=6*3600000
    || !isCopilotAppActivityFresh(refresh,now) || refresh<officeRetentionCutoff(now);
}

function* officeFactBatches(rows: readonly unknown[], parameters: readonly unknown[]) {
  let offset = 0;
  while (offset < rows.length) {
    let rowCount = Math.min(dataLimits.batchRows, rows.length - offset);
    let batch: ReturnType<typeof encodeBatch>;
    for (;;) {
      try { batch = encodeBatch(rows.slice(offset, offset + rowCount), parameters); break; }
      catch (error) {
        if (!(error instanceof AppError) || error.code !== "data_batch_bytes" || rowCount === 1) throw error;
        rowCount = Math.floor(rowCount / 2);
      }
    }
    yield { ...batch, rowCount };
    offset += rowCount;
  }
}

export class OfficeAppAdoptionRepository {
  readonly generations: DataGenerations;
  readonly connections;
  constructor(readonly database: pg.Pool) {
    this.generations = new DataGenerations(database);
    this.connections = this.generations.connections;
  }
  private async vector(client: pg.PoolClient, tenantId: string): Promise<SourceVector | null> {
    const rows = (await client.query<SourceHead>(sourceSql, [tenantId])).rows;
    const directory = rows.find(row => row.source === "directory"), app = rows.find(row => row.source === "app_activity");
    if (!directory || !app) return null;
    return { directory, app, hash: digest(JSON.stringify([directory, app].map(row => [row.scope_id, row.epoch, row.id, row.revision]))) };
  }
  private async fenceSources(client: pg.PoolClient, tenantId: string, vector: SourceVector) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${tenantId}`]);
    for (const source of [vector.directory, vector.app].sort((a, b) => a.scope_id.localeCompare(b.scope_id))) {
      const row = (await client.query(`SELECT s.id FROM data_scope_epochs s JOIN data_generation_heads h ON h.scope_id=s.id
        JOIN data_generations g ON g.id=h.generation_id WHERE s.id=$1 AND s.tenant_id=$2 AND s.epoch=$3
          AND h.generation_id=$4 AND h.revision=$5 AND g.state='published' AND g.validated
          FOR SHARE OF s,h,g`, [source.scope_id, tenantId, source.epoch, source.id, source.revision])).rows[0];
      if (!row) throw new AppError(409, "office_source_changed", "Office source evidence changed; automatic recovery will retry.");
    }
  }
  private async status(client: pg.PoolClient, appId: string, state: NonNullable<SourceHead["office_status"]>, vector: string | null, code: string | null = null) {
    await client.query(`UPDATE user_source_attempts SET office_status=$2,office_vector=$3,office_error_code=$4,
      office_updated_at=clock_timestamp(),office_revision=office_revision+1
      WHERE generation_id=$1 AND (office_status,office_vector,office_error_code) IS DISTINCT FROM ($2::text,$3::text,$4::text)`,
    [appId, state, vector, code]);
  }
  async reconcile(tenantId: string, options: { signal?: AbortSignal; beforePublish?: () => Promise<void>; afterBatch?: () => Promise<void> } = {}) {
    options.signal?.throwIfAborted();
    const vector = await this.connections.run(client => this.vector(client, tenantId), false, options.signal);
    if (!vector) {
      await this.connections.run(async client => {
        const app = (await client.query<SourceHead>(sourceSql, [tenantId])).rows.find(row => row.source === "app_activity");
        if (app) await this.status(client, app.id, "waiting_sources", null);
      }, false, options.signal);
      return { state: "waiting_sources" as const, copied: 0 };
    }
    const now = new Date(), refresh = vector.app.report_refresh_date;
    const invalid=officeSourcesUnavailable(vector.directory,vector.app,now);
    if (invalid) {
      if (vector.app.office_vector===vector.hash && vector.app.office_status==="unavailable") return {state:"idle" as const,copied:0};
      await this.connections.run(async client => {
        await this.fenceSources(client, tenantId, vector);
        await this.status(client, vector.app.id, "unavailable", vector.hash, "office_source_unavailable");
      }, false, options.signal);
      return { state: "unavailable" as const, copied: 0 };
    }
    if (vector.app.office_vector === vector.hash
      && (vector.app.office_status === "available"
        || vector.app.office_status === "unavailable" && vector.app.office_error_code === "office_report_regressed")) {
      return { state: "idle" as const, copied: 0 };
    }
    const refreshDate = refresh!;
    let lease: GenerationLease | undefined;
    let weeklyLease: GenerationLease | undefined;
    let copied = 0;
    let committed = false;
    let semanticHash:string | undefined;
    const jobId = randomUUID();
    try {
      const latest = await this.connections.selectedRead(async client => (await client.query(
        `SELECT o.report_refresh_date::text AS refresh ${readableOfficeSql} AND o.kind='current'`,[tenantId])).rows[0], { signal: options.signal });
      if (latest && latest.refresh>refreshDate) {
        await this.connections.run(async client => {
          await this.fenceSources(client,tenantId,vector);
          await this.status(client,vector.app.id,"unavailable",vector.hash,"office_report_regressed");
        }, false, options.signal);
        return { state:"unavailable" as const,copied:0 };
      }
      lease = await this.generations.begin({
        scope: { kind: "tenant", tenantId, principalId: null, tokenMode: "tenant", source: "office_app_adoption", selector: "current" },
        jobKind: "derived", jobId, schemaVersion: 1, sessionEpoch: "0",
        observedAt: now, expiresAt: officeExpiry(refreshDate), deadlineAt: new Date(now.getTime() + 30 * 60000),
        reserveBytes: dataLimits.generationBytes,
      });
      const active = lease;
      const semantic = createHash("sha256").update(JSON.stringify([refreshDate, "D28", "v2"]));
      const frozenCoverage = emptyOfficeCoverage();
      await this.connections.run(async client => {
        await this.fenceSources(client, tenantId, vector);
        await this.generations.fence(client, active);
        const coverage = (await client.query(`SELECT
          count(*) FILTER(WHERE NOT residual ? 'retainedObservedAt')::int AS reported,
          count(*) FILTER(WHERE residual ? 'retainedObservedAt')::int AS retained,
          count(*) FILTER(WHERE NOT residual ? 'retainedObservedAt' AND
            (report_refresh_date IS DISTINCT FROM $2::date OR period<>'D28'))::int AS mixed
          FROM app_activity_rows WHERE generation_id=$1`, [vector.app.id, refreshDate])).rows[0];
        if (coverage.mixed) throw new AppError(422, "office_mixed_window", "Saved Office rows contain inconsistent report windows.");
        frozenCoverage.reportedRows = coverage.reported;
        frozenCoverage.retainedRows = coverage.retained;
        semantic.update(JSON.stringify([coverage.reported, coverage.retained]));
        await client.query(`INSERT INTO office_observations(generation_id,scope_id,tenant_id,report_refresh_date,period,report_version,kind,metrics,
          directory_generation_id,app_generation_id,directory_observed_at,app_observed_at,coverage)
          VALUES($1,$2,$3,$4,'D28','v2','current',$10::jsonb,$5,$6,$7,$8,$9::jsonb)`,
        [active.id, active.scopeId, tenantId, refreshDate, vector.directory.id, vector.app.id,
          vector.directory.observed_at, vector.app.observed_at, JSON.stringify({ reportedRows: coverage.reported, retainedRows: coverage.retained }),
          JSON.stringify(emptyOfficeMetrics())]);
        await this.status(client, vector.app.id, "preparing", null);
      });
      let after = "", bytes = 2048;
      for (;;) {
        options.signal?.throwIfAborted();
        const rows = await this.connections.selectedRead(async client => (await client.query(`${userSourceFactsSql(true, true)}
          AND d.identity COLLATE "C">$4 ORDER BY d.identity COLLATE "C" LIMIT 250`,
        [vector.directory.id, vector.app.id, now, after])).rows);
        if (!rows.length) break;
        const people: OfficePerson[] = [];
        for (const row of rows) {
          const reasons: OfficeUnknownReason[] = [];
          if (!row.activity_identity) reasons.push(row.activity_candidate_exists ? "ambiguous_identity" : "missing_row");
          if (row.directory_residual?.retainedObservedAt) reasons.push("retained_directory");
          if (row.activity_residual?.retainedObservedAt) reasons.push("retained_row");
          const date = (value: Date | string | null) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
          const appRefresh = date(row.report_refresh_date);
          if (row.activity_identity && (appRefresh !== refreshDate || row.activity_period !== "D28")) reasons.push("wrong_window");
          const dates = { word: date(row.word_date), excel: date(row.excel_date), powerpoint: date(row.powerpoint_date),
            outlook: date(row.outlook_date), onenote: date(row.onenote_date), loop: date(row.loop_date), teams: date(row.teams_date) };
          const person: OfficePerson = {
            identity: row.identity, userPrincipalName: row.upn, displayName: row.display_name,
            company: row.company?.trim() || null, department: row.department?.trim() || null, groupId: "",
            entitlement: row.entitlement, serviceState: row.service_state,
            directoryObservedAt: row.directory_residual?.retainedObservedAt ?? vector.directory.observed_at.toISOString(),
            appObservedAt: row.activity_identity ? row.activity_residual?.retainedObservedAt ?? vector.app.observed_at.toISOString() : null,
            appReportRefreshDate: appRefresh, dates, ...classifyOfficeApps(dates, refreshDate, reasons),
          };
          people.push(person);
          frozenCoverage.directoryPeople++;
          if (person.entitlement === "paid_inactive") frozenCoverage.paidInactivePeople++;
          if (person.entitlement === "no_paid") frozenCoverage.noPaidPeople++;
          if (person.entitlement === "unknown") frozenCoverage.unknownLicensePeople++;
          if (person.entitlement === "paid_active") for (const reason of person.unknownReasons) frozenCoverage.unknownReasons[reason]++;
          const { directoryObservedAt: _directory, appObservedAt: _app, groupId: _group, ...facts } = person;
          semantic.update(JSON.stringify(facts));
        }
        for (const batch of officeFactBatches(people, [active.id, active.scopeId, tenantId])) {
          bytes += batch.bytes + 64 * batch.rowCount;
          copied += batch.rowCount;
          if (bytes > dataLimits.generationBytes) throw dataLimitError("office_capture_limit", dataLimits.generationBytes, bytes);
          await this.connections.run(async client => {
            await this.generations.fence(client, active);
            options.signal?.throwIfAborted();
            await client.query(`INSERT INTO office_person_facts(generation_id,scope_id,tenant_id,identity,payload)
              SELECT $1,$2,$3,payload->>'identity',jsonb_set(payload,'{groupId}',to_jsonb(
                encode(sha256(convert_to(jsonb_build_array(
                  ${reportSearchSql("nullif(btrim(payload->>'company'),'')")},
                  ${reportSearchSql("nullif(btrim(payload->>'department'),'')")})::text,'UTF8')),'hex')))
              FROM jsonb_array_elements($4::jsonb) payload`, [active.id, active.scopeId, tenantId, batch.json]);
            await client.query("UPDATE data_generations SET byte_count=$2,row_count=$3 WHERE id=$1", [active.id, bytes, copied]);
            observeDataWork("office_capture", { rows: batch.rowCount, bytes: batch.bytes });
          });
          await options.afterBatch?.();
          await this.generations.renew(active, client => this.fenceSources(client, tenantId, vector));
        }
        after = rows.at(-1)!.identity;
      }
      frozenCoverage.state = Object.values(frozenCoverage.unknownReasons).some(Boolean)
        || frozenCoverage.retainedRows || frozenCoverage.unknownLicensePeople ? "partial" : "complete";
      const contentHash = semantic.digest("hex");
      semanticHash=contentHash;
      const replay = await this.connections.run(async client => {
        await this.fenceSources(client, tenantId, vector);
        await this.generations.fence(client, active);
        const current = (await client.query(`SELECT g.id,g.content_hash FROM data_generation_heads h JOIN data_generations g ON g.id=h.generation_id
          WHERE h.scope_id=$1 AND g.state='published'`, [active.scopeId])).rows[0];
        if (current?.content_hash === contentHash) {
          await this.status(client, vector.app.id, "available", vector.hash);
          await client.query("UPDATE data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count WHERE id=$1", [active.id]);
          return true;
        }
        return false;
      }, false, options.signal);
      if (replay) return { state: "noop" as const, copied };
      const organization = await this.connections.selectedRead(async client => officeMetrics((await client.query(
        `SELECT ${officeMetricProjection} FROM office_person_facts WHERE generation_id=$1 AND payload->>'entitlement'='paid_active'`,
        [active.id])).rows[0]));
      weeklyLease = await this.generations.begin({
        scope: { kind: "tenant", tenantId, principalId: null, tokenMode: "tenant", source: "office_history",
          selector: `${officeWeekStart(refreshDate)}:D28:v2` },
        jobKind: "derived", jobId, schemaVersion: 1, sessionEpoch: "0",
        observedAt: now, expiresAt: officeExpiry(refreshDate), deadlineAt: new Date(now.getTime() + 30 * 60000),
        reserveBytes: dataLimits.generationBytes,
      });
      const weekly = weeklyLease;
      const header = JSON.stringify([refreshDate, "D28", "v2", organization, frozenCoverage]);
      const weeklySemantic = createHash("sha256").update(header);
      let weeklyBytes = 2048 + Buffer.byteLength(header), groupCount = 0, afterGroup = "";
      bytes += Buffer.byteLength(header);
      if (Math.max(bytes,weeklyBytes)>dataLimits.generationBytes) {
        throw dataLimitError("office_capture_limit",dataLimits.generationBytes,Math.max(bytes,weeklyBytes));
      }
      await this.connections.run(async client => {
        await this.fenceSources(client, tenantId, vector);
        await this.generations.fence(client, active);
        await this.generations.fence(client, weekly);
        await client.query("UPDATE office_observations SET coverage=$2::jsonb,metrics=$3::jsonb WHERE generation_id=$1",
          [active.id, JSON.stringify(frozenCoverage), JSON.stringify(organization)]);
        await client.query(`INSERT INTO office_observations(generation_id,scope_id,tenant_id,report_refresh_date,period,report_version,kind,metrics,
          directory_generation_id,app_generation_id,directory_observed_at,app_observed_at,coverage)
          VALUES($1,$2,$3,$4,'D28','v2','weekly',$5::jsonb,$6,$7,$8,$9,$10::jsonb)`,
        [weekly.id, weekly.scopeId, tenantId, refreshDate, JSON.stringify(organization), vector.directory.id, vector.app.id,
          vector.directory.observed_at, vector.app.observed_at, JSON.stringify(frozenCoverage)]);
      });
      for (;;) {
        options.signal?.throwIfAborted();
        const rows = await this.connections.selectedRead(async client => (await client.query(
          `SELECT payload->>'groupId' AS id,min(payload->>'company' COLLATE "C") AS company,
            min(payload->>'department' COLLATE "C") AS department,${officeMetricProjection}
          FROM office_person_facts WHERE generation_id=$1 AND payload->>'entitlement'='paid_active'
            AND (payload->>'groupId') COLLATE "C">$2
          GROUP BY payload->>'groupId' ORDER BY (payload->>'groupId') COLLATE "C" LIMIT 250`,
          [active.id, afterGroup])).rows);
        if (!rows.length) break;
        const groups = rows.map(row => ({ id: row.id as string, company: row.company as string | null,
          department: row.department as string | null, metrics: officeMetrics(row) }));
        for (const group of groups) weeklySemantic.update(JSON.stringify(group));
        for (const batch of officeFactBatches(groups, [active.id, active.scopeId, tenantId])) {
          groupCount += batch.rowCount;
          bytes += batch.bytes + 64 * batch.rowCount;
          weeklyBytes += batch.bytes + 64 * batch.rowCount;
          if (Math.max(bytes, weeklyBytes)>dataLimits.generationBytes) {
            throw dataLimitError("office_capture_limit", dataLimits.generationBytes, Math.max(bytes, weeklyBytes));
          }
          await this.connections.run(async client => {
            await this.fenceSources(client, tenantId, vector);
            options.signal?.throwIfAborted();
            for (const target of [active, weekly].sort((a,b)=>a.scopeId.localeCompare(b.scopeId))) {
              await this.generations.fence(client, target);
              await client.query(`INSERT INTO office_group_facts(generation_id,scope_id,tenant_id,group_id,company,department,metrics)
                SELECT $1,$2,$3,payload->>'id',payload->>'company',payload->>'department',payload->'metrics'
                FROM jsonb_array_elements($4::jsonb) payload`, [target.id,target.scopeId,tenantId,batch.json]);
              await client.query("UPDATE data_generations SET byte_count=$2,row_count=$3 WHERE id=$1",
                [target.id, target.id===active.id ? bytes : weeklyBytes, groupCount+(target.id===active.id ? copied : 0)]);
            }
          });
          await this.generations.renew(active, client=>this.fenceSources(client,tenantId,vector));
          await this.generations.renew(weekly, client=>this.fenceSources(client,tenantId,vector));
        }
        afterGroup = groups.at(-1)!.id;
      }
      const weeklyHash = weeklySemantic.digest("hex");
      const weeklyReplay = await this.connections.run(async client => {
        await this.fenceSources(client, tenantId, vector);
        await this.generations.fence(client, active);
        await this.generations.fence(client, weekly);
        const current = (await client.query(`SELECT g.content_hash FROM data_generation_heads h JOIN data_generations g ON g.id=h.generation_id
          WHERE h.scope_id=$1 AND g.state='published'`,[weekly.scopeId])).rows[0];
        const same = current?.content_hash===weeklyHash;
        await client.query(`UPDATE data_generations SET state='validating',validated=true,validation_phase='complete',
          content_hash=$2,byte_count=$3,row_count=$4 WHERE id=$1`,[active.id,contentHash,bytes,copied+groupCount]);
        if (same) await client.query("UPDATE data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count WHERE id=$1",[weekly.id]);
        else await client.query(`UPDATE data_generations SET state='validating',validated=true,validation_phase='complete',
          content_hash=$2,byte_count=$3,row_count=$4 WHERE id=$1`,[weekly.id,weeklyHash,weeklyBytes,groupCount]);
        return same;
      });
      await options.beforePublish?.();
      options.signal?.throwIfAborted();
      await this.generations.publish(active, {
        relatedLeases: weeklyReplay ? [] : [weekly],
        onCommitted: () => { committed = true; },
        validateInputs: client => this.fenceSources(client, tenantId, vector),
        beforeCommit: () => options.signal?.throwIfAborted(),
        completeJob: async client => {
          await this.status(client, vector.app.id, "available", vector.hash);
          await client.query(`UPDATE data_read_selections selection SET invalidated_at=clock_timestamp()
            WHERE selection.tenant_id=$1 AND selection.endpoint='office-app-adoption' AND selection.invalidated_at IS NULL
            AND EXISTS(SELECT 1 FROM data_generation_pins pin JOIN office_observations old ON old.generation_id=pin.generation_id
              WHERE pin.selection_id=selection.id AND old.scope_id=$2 AND old.generation_id<>$3)`, [tenantId, active.scopeId, active.id]);
          // Timeline pages include earlier immutable captures; correction invalidates their actual range.
          if (!weeklyReplay) await client.query(`UPDATE data_read_selections selection SET invalidated_at=clock_timestamp()
            WHERE selection.tenant_id=$1 AND selection.endpoint='office-app-adoption' AND selection.invalidated_at IS NULL
              AND selection.evaluated_at<$2 AND EXISTS(SELECT 1 FROM data_generation_pins pin
                JOIN office_observations chosen ON chosen.generation_id=pin.generation_id
                WHERE pin.selection_id=selection.id AND EXISTS(
                  SELECT 1 FROM office_observations old JOIN data_generations retired ON retired.id=old.generation_id
                  WHERE old.scope_id=$3 AND retired.state='retired'
                    AND old.report_refresh_date<=chosen.report_refresh_date))`,
          [tenantId, now, weekly.scopeId]);
        },
      });
      return { state: "published" as const, copied };
    } catch (error) {
      const failures: unknown[] = [error];
      if (!committed && lease && semanticHash) {
        try {
          const acknowledged=await this.connections.run(async client=>{
            const current=await this.vector(client,tenantId);
            if(current?.hash!==vector.hash || current.app.office_vector!==vector.hash || current.app.office_status!=="available") return null;
            return (await client.query(`SELECT g.id FROM data_generation_heads h JOIN data_generations g ON g.id=h.generation_id
              WHERE h.scope_id=$1 AND g.state='published' AND g.content_hash=$2`,[lease!.scopeId,semanticHash])).rows[0] ?? null;
          });
          if(acknowledged) {
            operationalLog("warn","office_publication_cleanup_failed",errorTelemetry(error));
            return {state:acknowledged.id===lease.id ? "published" as const : "noop" as const,copied};
          }
        } catch (failure) { failures.push(failure); }
      }
      if (committed) {
        operationalLog("warn", "office_publication_cleanup_failed", errorTelemetry(error));
        return { state: "published" as const, copied };
      }
      if (!lease && error instanceof AppError && error.code === "data_source_active") return { state: "busy" as const, copied: 0 };
      for (const target of [lease,weeklyLease]) if (target) {
        try { await this.generations.abort(target, options.signal?.aborted); }
        catch (failure) { failures.push(failure); }
      }
      try {
        await this.connections.run(async client => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${tenantId}`]);
          const current = await this.vector(client, tenantId);
          if (current?.hash === vector.hash
            && !(current.app.office_vector === vector.hash && current.app.office_status === "available")) {
            await this.status(client, vector.app.id, "failed", null, "office_derivation_failed");
          }
        });
      } catch (failure) { failures.push(failure); }
      throw failures.length === 1 ? error : new AggregateError(failures, "office_derivation_cleanup_failed");
    }
  }
  async recover(tenantId?: string, signal?: AbortSignal) {
    let after = "";
    for (;;) {
      const tenants = tenantId ? [tenantId] : await this.connections.run(async client => (await client.query(
        `SELECT DISTINCT tenant_id COLLATE "C" AS tenant_id FROM data_scope_epochs WHERE source IN ('directory','app_activity') AND tenant_id COLLATE "C">$1
          ORDER BY tenant_id COLLATE "C" LIMIT 100`, [after])).rows.map(row => row.tenant_id as string));
      for (const tenant of tenants) {
        try { await this.reconcile(tenant, { signal }); }
        catch (error) {
          operationalLog("error", "office_derivation_failed", errorTelemetry(error));
          if (signal?.aborted) return;
        }
      }
      if (tenantId || tenants.length<100) return;
      after = tenants.at(-1)!;
    }
  }
}

export async function officeStatus(client: pg.PoolClient, tenantId: string): Promise<OfficeStatus> {
  const heads=(await client.query<SourceHead>(sourceSql,[tenantId])).rows;
  const row=heads.find(head=>head.source==="app_activity"), directory=heads.find(head=>head.source==="directory");
  const aged=row?.office_status==="available" && officeSourcesUnavailable(directory,row,new Date());
  const state=aged ? "unavailable" : row?.office_status ?? "waiting_sources";
  const messages: Record<OfficeStatus["state"], string | null> = {
    available: null, preparing: "Preparing a retained Office observation from saved sources.",
    waiting_sources: "Waiting for valid saved directory and Office report evidence.",
    unavailable: "Current saved sources cannot establish a fresh D28/v2 Office observation. Earlier observations remain historical evidence.",
    failed: "Local Office preparation failed. Automatic recovery will retry; saved source collection remains available.",
  };
  if (!Object.hasOwn(messages, state)) throw new Error("office_status_invalid");
  return { state, errorCode: aged ? "office_source_unavailable" : row?.office_error_code ?? null,
    message: row?.office_error_code==="office_report_regressed"
      ? "Microsoft's current report is older than the latest saved Office report. Saved participation is unchanged."
      : messages[state as OfficeStatus["state"]] };
}

export async function officeObservation(client: pg.PoolClient, tenantId: string, id: string): Promise<OfficeObservation> {
  const row = (await client.query(`SELECT o.*,g.observed_at AS captured_at,g.expires_at,g.content_hash ${readableOfficeSql}
    AND o.generation_id=$2`, [tenantId, id])).rows[0];
  if (!row) throw new AppError(409, "selection_invalidated", "Office observation is no longer available.", { reason: "unavailable" });
  const coverage = row.coverage as OfficeObservation["coverage"];
  for (const key of Object.keys(emptyOfficeCoverage()) as (keyof typeof coverage)[]) {
    if (!Object.hasOwn(coverage, key)) throw new Error("office_coverage_invalid");
  }
  const refresh = row.report_refresh_date instanceof Date ? row.report_refresh_date.toISOString().slice(0, 10) : row.report_refresh_date;
  if (row.kind!=="current" && row.kind!=="weekly") throw new Error("office_observation_kind");
  return { id, kind: row.kind, reportRefreshDate: refresh, period: "D28", reportVersion: "v2", windowStart: officeWindowStart(refresh),
    capturedAt: row.captured_at.toISOString(), expiresAt: row.expires_at.toISOString(), contentHash: row.content_hash,
    directoryGenerationId: row.directory_generation_id, appGenerationId: row.app_generation_id,
    directoryObservedAt: row.directory_observed_at.toISOString(), appObservedAt: row.app_observed_at.toISOString(), coverage };
}
