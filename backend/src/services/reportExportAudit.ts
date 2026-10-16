import type { ExportAudit } from "./dataExports.js";
import type { InventoryExportAction, ReportExportAction, ControlLifecycleAction } from "../types/audit.js";
import { AuditLog } from "./auditLog.js";
import { currentActionOrigin, parseStoredOrigin, lifecycleActor } from "./actionOrigin.js";

export const reportExportAudit: ExportAudit = async (client, event) => {
  const job = (await client.query(`SELECT e.tenant_id,e.principal_id,e.actor,e.kind,e.selection_id,e.query_hash,e.selection_mode,e.origin,
    c.set_id,c.history_revision::text FROM data_exports e LEFT JOIN official_usage_read_contexts c
      ON c.selection_id=e.selection_id AND c.tenant_id=e.tenant_id WHERE e.id=$1`, [event.exportId])).rows[0];
  if (!job?.actor || job.actor.tenantId !== job.tenant_id || job.actor.homeAccountId !== job.principal_id
    || typeof job.actor.username !== "string" || !job.actor.username.trim() || job.actor.username.length > 256
    || typeof job.actor.displayName !== "string" || job.actor.displayName.length > 256) throw new Error("export_audit_actor");
  if (job.kind !== event.kind) throw new Error("export_audit_kind");
  const scope = { tenantId: job.tenant_id, principalId: job.principal_id }, log = new AuditLog(scope, client);
  const actions: Record<typeof event.kind, ReportExportAction | InventoryExportAction> = {
    graph_packages: "export-package-inventory", power_platform_agents: "export-power-platform-inventory",
    unified_agents: "export-agent-inventory", official_agents: "export-official-usage-aggregate",
    copilot_users: "export-official-usage-users", official_users: "export-official-usage-users",
  };
  const action: ReportExportAction | InventoryExportAction | ControlLifecycleAction = event.phase === "cancel" ? "cancel-control" : actions[event.kind];
  if (!Object.hasOwn(actions, event.kind)) throw new Error("export_audit_kind");
  const id = `${event.id}:${event.phase}`, metadata = { source: job.kind, jobId: event.exportId, phase: event.phase,
    selection: job.selection_id, queryHash: job.query_hash, mode: job.selection_mode,
    ...(job.set_id ? { reportSetId: job.set_id, revision: job.history_revision } : {}), rowCount: event.rows,
    resultingBytes: event.bytes, ...(event.checksum ? { checksum: event.checksum } : {}) };
  if (event.status === "started") await log.startEvent({ id, operationId: `data-export:${event.exportId}`, scope: "bulk", action,
    origin: event.phase === "build" ? parseStoredOrigin(job.origin) : currentActionOrigin(),
    agentId: event.exportId, actor: event.phase === "build" ? { tenantId: job.tenant_id, homeAccountId: job.principal_id,
      username: job.actor.username, displayName: job.actor.displayName } : lifecycleActor(job.actor),
    requestPath: event.phase === "build" ? "/api/data-exports" : `/api/data-exports/${event.exportId}/${event.phase}`, metadata });
  else await log.completeEvent(id, { status: event.status, metadata, completedAt: event.completedAt,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}) });
};
