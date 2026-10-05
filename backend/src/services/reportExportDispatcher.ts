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
import { OfficialReportImports } from "../db/officialReportImports.js";
import { retainRecordData } from "../db/dataRetention.js";

type Work = { id: string; kind: OfficialExportKind; actor: AuditActor; identity: SelectionIdentity };
export class ReportExportDispatcher {
  private readonly active = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private stopping = false;
  constructor(readonly reports: LargeTenantUsersReports) {}

  start() {
    if (this.timer) return;
    this.stopping = false;
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
  private async poll() {
    await this.reports.sources.connections.run(client => retainRecordData(client, 25));
    await new OfficialReportImports(this.reports.database).sweep();
    for (const tenant of config.tenants) {
      await this.reports.history.ensure(tenant.tenantId);
      await this.reports.history.expire(tenant.tenantId);
      await this.reports.history.collect(tenant.tenantId);
    }
    const rows = await this.reports.database.query(`SELECT e.id,e.kind,e.actor,e.tenant_id,e.principal_id,
      s.authorization_hash,s.session_epoch FROM data_exports e JOIN data_read_selections s ON s.id=e.selection_id
      WHERE e.actor IS NOT NULL AND e.kind IN ('copilot_users','official_agents','official_users','graph_packages','power_platform_agents','unified_agents')
        AND e.status IN ('queued','building','ready')
        AND (e.status='queued' OR e.expires_at<=clock_timestamp()
          OR (e.status='building' AND (e.lease_until<=clock_timestamp() OR e.deadline_at<=clock_timestamp())))
      ORDER BY e.created_at,e.id LIMIT 4`);
    for (const row of rows.rows) {
      if (this.stopping || this.active.has(row.id) || this.active.size >= 4) continue;
      const job: Work = { id: row.id, kind: row.kind, actor: row.actor, identity: { tenantId: row.tenant_id,
        principalId: row.principal_id, authorizationHash: row.authorization_hash, sessionEpoch: row.session_epoch } };
      const controller = new AbortController(), producer = new OfficialReportExports(this.reports, job.actor);
      const work = (async () => {
        await producer.engine.expire(job.id);
        const status = await producer.status(job.id, job.identity);
        if (status.status === "queued") await producer.build(job.id, job.identity, job.kind, controller.signal);
      })().catch(async error => {
        if (!(error instanceof AppError && error.code === "export_admission") && !(error instanceof Error && error.message === "export_not_queued")) {
          await producer.engine.failPending(job.id, error instanceof AppError ? error.code : "export_build_failed");
        }
        operationalLog("warn", "report_export_work_failed", { ...errorTelemetry(error), jobId: job.id });
      }).finally(() => { this.active.delete(job.id); });
      this.active.set(job.id, { controller, work });
    }
  }
  async drain() {
    this.stopping = true;
    clearInterval(this.timer); this.timer = undefined;
    await this.polling;
    for (const item of this.active.values()) item.controller.abort(new Error("export_shutdown"));
    await Promise.all([...this.active.values()].map(item => item.work));
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
