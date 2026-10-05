import type { ExportAudit } from "./dataExports.js";
import type { InventoryExportAction, ReportExportAction } from "../types/audit.js";
import { AuditLog } from "./auditLog.js";

export const reportExportAudit: ExportAudit = async (client, event) => {
  const job = (await client.query("SELECT tenant_id,principal_id,actor FROM data_exports WHERE id=$1", [event.exportId])).rows[0];
  if (!job?.actor || job.actor.tenantId !== job.tenant_id || job.actor.homeAccountId !== job.principal_id) throw new Error("export_audit_actor");
  const scope = { tenantId: job.tenant_id, principalId: job.principal_id }, log = new AuditLog(scope, client);
  const action: ReportExportAction | InventoryExportAction = event.kind === "graph_packages" ? "export-package-inventory"
    : event.kind === "power_platform_agents" ? "export-power-platform-inventory"
      : event.kind === "unified_agents" ? "export-agent-inventory"
        : event.kind === "official_agents" ? "export-official-usage-aggregate" : "export-official-usage-users";
  const id = `${event.id}:${event.phase}`, metadata = { source: event.kind, jobId: event.exportId, rowCount: event.rows,
    resultingBytes: event.bytes, ...(event.checksum ? { checksum: event.checksum } : {}) };
  if (event.status === "started") await log.startEvent({ id, operationId: `data-export:${event.exportId}`, scope: "bulk", action,
    agentId: event.exportId, actor: job.actor, requestPath: `/api/data-exports/${event.exportId}`, metadata });
  else await log.completeEvent(id, { status: event.status, metadata, ...(event.errorCode ? { errorCode: event.errorCode } : {}) });
};
