import type pg from "pg";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { OfficialReportExports, type OfficialExportKind } from "./officialReportExports.js";
import type { SelectionIdentity } from "./dataSelections.js";
import type { AuditActor } from "../types/audit.js";
import { operationalLog } from "./telemetry.js";
import { AppError, errorTelemetry } from "../errors.js";
import { maintenanceActive } from "./maintenance.js";
import { readOperationalState } from "./operationalState.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { retainRecordData } from "../db/dataRetention.js";
import { currentAuthority, pruneAuthorities, withAuthority } from "../auth/authorityContext.js";
import type { DelegatedCredentialSource } from "../types/requestPrincipal.js";

type Work = { id: string; kind: OfficialExportKind; actor: AuditActor; identity: SelectionIdentity };
export class ReportExportDispatcher {
  private readonly active = new Map<string, { tenantId: string; controller: AbortController; work: Promise<void>; settlementFailure?: AggregateError }>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private draining?: Promise<void>;
  private drainFailure?: unknown;
  private stopping = false;
  private readonly authorities = new Map<string, DelegatedCredentialSource>();
  constructor(readonly reports: LargeTenantUsersReports) {}

  enqueue(id: string, identity: SelectionIdentity, schedule = true) {
    const source = currentAuthority();
    if (!source || source.principal.tenantId !== identity.tenantId || source.principal.principalId !== identity.principalId
      || source.principal.sessionEpoch !== identity.sessionEpoch || source.principal.authorizationHash !== identity.authorizationHash) {
      throw new AppError(401, "authorization_required", "The export requires the initiating account's current authorization.");
    }
    source.assertCurrent();
    pruneAuthorities(this.authorities);
    if (this.authorities.size >= 10_000 && !this.authorities.has(id)) throw new AppError(503, "credential_capacity", "Export authorization capacity is full.");
    this.authorities.set(id, source);
    if (schedule) this.wake();
  }

  start() {
    if (this.timer || this.draining) return;
    this.stopping = false;
    this.drainFailure = undefined;
    this.timer = setInterval(() => this.wake(), 2000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.stopping || this.polling || maintenanceActive()) return;
    this.polling = this.poll().catch(error => {
      operationalLog("error", "report_export_dispatch_failed", errorTelemetry(error));
    }).finally(() => { this.polling = undefined; });
  }
  private async admissionsOpen() {
    if (this.stopping || maintenanceActive()) return false;
    try {
      const state = await readOperationalState(this.reports.database);
      return !this.stopping && !maintenanceActive() && state.mode === "normal";
    } catch (error) {
      operationalLog("error", "report_export_dispatch_failed", errorTelemetry(error));
      return false;
    }
  }
  private async poll() {
    if (!await this.admissionsOpen()) return;
    await this.reports.sources.connections.run(client => retainRecordData(client, 25));
    if (!await this.admissionsOpen()) return;
    await new OfficialReportImports(this.reports.database).sweep();
    for (const tenant of config.tenants) {
      if (!await this.admissionsOpen()) return;
      await this.reports.history.ensure(tenant.tenantId);
      if (!await this.admissionsOpen()) return;
      await this.reports.history.expire(tenant.tenantId);
      if (!await this.admissionsOpen()) return;
      await this.reports.history.collect(tenant.tenantId);
    }
    if (!await this.admissionsOpen()) return;
    const rows = await this.reports.database.query(`WITH candidates AS (
      SELECT e.id,e.kind,e.actor,e.tenant_id,e.principal_id,e.status,e.created_at,
        s.authorization_hash,s.session_epoch,
        row_number() OVER(PARTITION BY e.tenant_id,e.status ORDER BY e.created_at,e.id) AS position,
        (SELECT count(*) FROM data_exports b WHERE b.tenant_id=e.tenant_id AND b.status='building'
          AND b.lease_until>clock_timestamp()) AS building,
        (SELECT count(*) FROM unnest($3::text[]) AS local(tenant_id) WHERE local.tenant_id=e.tenant_id) AS dispatching
      FROM data_exports e JOIN data_read_selections s ON s.id=e.selection_id
      WHERE NOT (e.id=ANY($1::uuid[])) AND e.actor IS NOT NULL
        AND e.kind IN ('copilot_users','official_agents','official_users','graph_packages','power_platform_agents','unified_agents')
        AND e.status IN ('queued','building','ready')
        AND (e.status='queued' OR e.expires_at<=clock_timestamp()
          OR (e.status='building' AND (e.lease_until<=clock_timestamp() OR e.deadline_at<=clock_timestamp())))
      ) SELECT * FROM candidates WHERE status<>'queued' OR position<=greatest(0,2-greatest(building,dispatching))
      ORDER BY created_at,id LIMIT $2`, [[...this.active.keys()], Math.max(0, 4 - this.active.size),
        [...this.active.values()].map(item => item.tenantId)]);
    if (!await this.admissionsOpen()) return;
    for (const row of rows.rows) {
      if (this.stopping || maintenanceActive()) return;
      if (this.active.has(row.id) || this.active.size >= 4) continue;
      const job: Work = { id: row.id, kind: row.kind, actor: row.actor, identity: { tenantId: row.tenant_id,
        principalId: row.principal_id, authorizationHash: row.authorization_hash, sessionEpoch: row.session_epoch } };
      const controller = new AbortController(), producer = new OfficialReportExports(this.reports, job.actor);
      const source = this.authorities.get(job.id);
      if (!source) {
        await producer.engine.expire(job.id);
        await this.reports.database.query(`UPDATE data_exports SET error_code='authorization_required'
          WHERE id=$1 AND status='queued' AND error_code IS DISTINCT FROM 'authorization_required'`, [job.id]);
        continue;
      }
      let retainAuthorization = true;
      const work = (async () => {
        await producer.engine.expire(job.id);
        if (this.stopping || maintenanceActive()) return;
        const status = await producer.status(job.id, job.identity);
        if (status.status !== "queued") { retainAuthorization = false; return; }
        if (this.stopping || maintenanceActive()) return;
        if (!await this.admissionsOpen() || controller.signal.aborted) return;
        await withAuthority(source, () => producer.build(job.id, job.identity, job.kind, controller.signal, {
          assertCurrent: () => {
            source.assertCurrent();
            controller.signal.throwIfAborted();
            if (this.stopping || maintenanceActive()) throw new AppError(503, "maintenance", "Export admissions are paused.");
          },
          settlementFailed: error => {
            const item = this.active.get(job.id);
            if (item) item.settlementFailure = error;
            if (this.stopping) this.drainFailure ??= error;
          },
        }));
        retainAuthorization = false;
      })().catch(async error => {
        if (error instanceof AppError && error.status === 401) {
          retainAuthorization = false;
          await this.reports.database.query(`UPDATE data_exports SET error_code='authorization_required'
            WHERE id=$1 AND status='queued'`, [job.id]);
        }
        // Unowned work remains retryable on contention, database outages and maintenance.
        const code = error instanceof AppError ? error.code : error instanceof Error ? error.message : undefined;
        if (!this.stopping && !(controller.signal.aborted && error === controller.signal.reason) && code !== undefined
          && ["selection_invalidated", "export_selection_changed", "export_selection_kind", "invalid_export_kind",
            "invalid_export_schema", "invalid_export_selection", "export_deadline"].includes(code)) {
          try { await producer.engine.failPending(job.id, code); }
          catch (failure) {
            operationalLog("error", "report_export_settlement_failed", { ...errorTelemetry(failure), jobId: job.id });
          }
        }
        operationalLog("warn", "report_export_work_failed", { ...errorTelemetry(error), jobId: job.id });
      }).finally(() => {
        this.active.delete(job.id);
        if (!retainAuthorization && this.authorities.get(job.id) === source) this.authorities.delete(job.id);
      });
      this.active.set(job.id, { tenantId: job.identity.tenantId, controller, work });
    }
  }
  drain() {
    if (this.draining) return this.draining;
    this.stopping = true;
    clearInterval(this.timer); this.timer = undefined;
    this.draining = (async () => {
      await this.polling;
      await Promise.all([...this.active.values()].map(item => item.work));
      if (this.drainFailure !== undefined) throw this.drainFailure;
    })().finally(() => { this.draining = undefined; });
    for (const item of this.active.values()) {
      this.drainFailure ??= item.settlementFailure;
      item.controller.abort(new Error("export_shutdown"));
    }
    return this.draining;
  }
}

const dispatchers = new WeakMap<pg.Pool, ReportExportDispatcher>();
export function reportRuntime(database: pg.Pool = pool) {
  let dispatcher = dispatchers.get(database);
  if (!dispatcher) {
    dispatcher = new ReportExportDispatcher(new LargeTenantUsersReports(database, config.sessionSecret, config.officialUsageStaleDays));
    dispatchers.set(database, dispatcher);
  }
  return dispatcher;
}
