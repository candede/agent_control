import { DataExports, type ExportSource } from "./dataExports.js";
import { LargeTenantUsersReports, type ReportReadContext } from "./largeTenantUsersReports.js";
import { reportExportColumns, type CombinedUser, type ReportAgent, type ReportUser, type ReportRelationship } from "../types/officialReportData.js";
import type { SelectionIdentity } from "./dataSelections.js";
import type { AuditActor } from "../types/audit.js";
import { reportExportAudit } from "./reportExportAudit.js";
import { AppError } from "../errors.js";
import { reportUuid } from "../db/officialReportImports.js";
import type { OfficialReportExportStatus } from "../types/officialReportApi.js";
import type pg from "pg";
import { encodeBatch } from "../db/dataBounds.js";
import { officialReportCount } from "../db/officialReportBounds.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { config } from "../config.js";
import { inventoryExportColumns, inventoryExportSource, type InventoryExportKind } from "./inventoryExports.js";

export type OfficialExportKind = keyof typeof reportExportColumns | InventoryExportKind;
export class OfficialReportExports {
  readonly engine;
  readonly inventory;
  constructor(readonly reports: LargeTenantUsersReports, readonly actor: AuditActor, secret = config.sessionSecret) {
    if (!actor.tenantId) throw AppError.unauthorized();
    const clientId = config.tenants.find(tenant => tenant.tenantId === actor.tenantId)?.clientId;
    this.inventory = new InventoryQueries(reports.database, secret, reports.staleAfterDays,
      clientId ? { tenantId: actor.tenantId, principalId: clientId } : undefined);
    this.engine = new DataExports(reports.database, this.inventory.selections, reportExportAudit);
  }
  async create(identity: SelectionIdentity, input: { selectionId: string; kind: OfficialExportKind; ids?: readonly string[]; idempotencyKey?: string }) {
    if (!input || typeof input !== "object" || !Object.hasOwn(reportExportColumns, input.kind) && !Object.hasOwn(inventoryExportColumns, input.kind)) {
      throw new AppError(400, "invalid_export_kind", "Unsupported dataset export.");
    }
    reportUuid(input.selectionId);
    if (input.idempotencyKey !== undefined) reportUuid(input.idempotencyKey);
    if (Object.keys(input).some(key => !["selectionId", "kind", "ids", "idempotencyKey"].includes(key)) || input.ids !== undefined && (!Array.isArray(input.ids)
      || !input.ids.length && Object.hasOwn(inventoryExportColumns, input.kind) || input.ids.length > 5000 || new Set(input.ids).size !== input.ids.length
      || input.ids.some(id => typeof id !== "string" || !id || id.length > (input.kind === "unified_agents" ? 8192 : 512)))) {
      throw new AppError(400, "invalid_export_selection", "Use a pinned selection and at most 5000 unique IDs.");
    }
    if (identity.tenantId !== this.actor.tenantId || identity.principalId !== this.actor.homeAccountId) throw AppError.unauthorized();
    const queryHash = Object.hasOwn(inventoryExportColumns, input.kind) ? await this.engine.connections.selectedRead(async client => {
      const { context, selection } = await this.inventory.contextInRead(client, input.selectionId, identity);
      if (selection.endpoint !== "inventory") throw new AppError(400, "export_selection_kind", "Inventory exports require an inventory selection.");
      const source = (await client.query("SELECT source FROM data_scope_epochs WHERE id=$1", [context.scopeId])).rows[0]?.source;
      if (source !== "inventory_canonical" && source !== (input.kind === "graph_packages" ? "inventory_packages"
        : input.kind === "power_platform_agents" ? "inventory_power_platform" : null)) {
        throw new AppError(400, "export_selection_kind", "Export kind does not match the selected inventory source.");
      }
      if (input.kind !== "unified_agents") {
        const source = input.kind === "graph_packages" ? "inventory_packages" : "inventory_power_platform";
        const available = await client.query(`SELECT 1 FROM data_generation_pins p JOIN data_scope_epochs s ON s.id=p.scope_id
          WHERE p.selection_id=$1 AND p.tenant_id=$2 AND p.root_kind='inventory_delta' AND s.source=$3 LIMIT 1`,
        [input.selectionId, identity.tenantId, source]);
        if (!available.rowCount) throw new AppError(409, "inventory_unavailable", "The selected source is unavailable; refresh it before exporting.");
      }
      return selection.query_hash as string;
    }) : await this.reports.read(input.selectionId, identity, async (_client, context) => {
      if (context.endpoint !== input.kind) throw new AppError(400, "export_selection_kind", "Export kind must match the pinned endpoint.");
      return context.queryHash;
    });
    const ids = input.kind === "unified_agents" && input.ids !== undefined
      ? await this.inventory.resolveExportReferences(input.selectionId, identity, input.ids) : input.ids;
    return this.engine.create(identity, { ...input, ids, queryHash, actor: this.actor, filename: `${input.kind.replaceAll("_", "-")}.csv` });
  }
  async build(id: string, identity: SelectionIdentity, kind: OfficialExportKind, signal?: AbortSignal) {
    await this.engine.connections.selectedRead(async client => {
      const row = (await client.query("SELECT selection_id,kind FROM data_exports WHERE id=$1 AND tenant_id=$2 AND principal_id=$3",
        [reportUuid(id), identity.tenantId, identity.principalId])).rows[0];
      if (!row) throw new AppError(404, "export_not_found", "Export is unavailable.");
      await this.engine.selections.assert(client, row.selection_id, identity, id);
      if (row.kind !== kind || !Object.hasOwn(reportExportColumns, kind) && !Object.hasOwn(inventoryExportColumns, kind)) throw new AppError(400, "invalid_export_kind", "Export schema does not match persisted kind.");
    });
    return Object.hasOwn(inventoryExportColumns, kind)
      ? this.engine.build(id, identity, inventoryExportColumns[kind as InventoryExportKind], inventoryExportSource(this.inventory, identity), signal)
      : this.engine.build(id, identity, reportExportColumns[kind as keyof typeof reportExportColumns], this.source(identity), signal);
  }
  async status(id: string, identity: SelectionIdentity): Promise<OfficialReportExportStatus> {
    const status = await this.engine.status(reportUuid(id), identity);
    return { id: status.id, status: status.status, rows: status.rows, bytes: status.bytes, expiresAt: status.expiresAt.toISOString(),
      error: status.error ?? null, limit: status.limit ?? null, observed: status.observed ?? null };
  }
  source(identity: SelectionIdentity): ExportSource {
    const reports = this.reports;
    return async function* (signal, exportContext) {
      let cursor: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        const batch = await exportContext.read(async client => {
          const context = await reports.contextInRead(client, identity, exportContext.selectionId);
          if (context.endpoint !== exportContext.kind || !Object.hasOwn(reportExportColumns, exportContext.kind)) throw new AppError(400, "export_selection_kind", "Export producer scope mismatch.");
          const page = await reports.rowsInRead(client, context, { limit: 100, cursor,
            ...(exportContext.mode === "explicit" ? { explicitExportId: exportContext.id } : {}) });
          const common = { ReportSetId: context.report.setId, HistoryRevision: context.report.historyRevision, ReportAvailability: context.report.availability };
          return { cursor: page.page.nextCursor, context, users: exportContext.kind === "official_users" ? page.value as ReportUser[] : null,
            rows: exportContext.kind === "official_users" ? [] : page.value.map(row => {
            if (exportContext.kind === "copilot_users") {
              const user = row as CombinedUser;
              return { ObjectId: user.directory.objectId, UserPrincipalName: user.directory.userPrincipalName, DisplayName: user.directory.displayName,
                Company: user.directory.companyName, Department: user.directory.department, PaidFeatureState: user.copilotServiceState,
                Entitlement: user.entitlement, AgentActivityState: user.agentActivityState, ReportedResponses: user.reportedResponses,
                ReportedAgentsUsed: user.reportedAgentsUsed, AppLastActivityDate: user.appActivity?.lastActivityDate ?? null,
                DirectoryObservedAt: context.metadata.directory.observedAt, ...common };
            }
            if (exportContext.kind === "official_agents") {
              const agent = row as ReportAgent;
              return { agentId: agent.agentId, agentName: agent.agentName, creatorType: agent.creatorType,
                creatorTypeSource: agent.responseSource === "agents" ? "agents_report" : "users_and_agents_report",
                activeUsersLicensed: unknown(agent.licensedUserOccurrences), activeUsersUnlicensed: unknown(agent.unlicensedUserOccurrences),
                activeUsersTotal: unknown(agent.activeUsers), activeUsersTotalBasis: agent.activeUsersBasis,
                activeUsersIdentityCount: unknown(agent.activeUsers), responsesSentToUsers: agent.responses,
                responseComparisonStatus: agent.responseComparison, responseDifference: agent.reportResponses !== null && agent.bridgeResponses !== null
                  ? Math.abs(agent.reportResponses - agent.bridgeResponses) : "Unknown",
                responsesAgentsReport: unknown(agent.reportResponses), responsesUsersAndAgentsReport: unknown(agent.bridgeResponses),
                lastActivityDateUtc: utcDate(agent.lastActivityDateUtc), sourceReports: agent.reportResponses === null ? "userAgents"
                  : agent.bridgeResponses === null ? "agents" : "agents | userAgents", identityStatus: agent.identityStatus,
                ...lineage(context, "agents"), ...lineage(context, "userAgents") };
            }
            throw new AppError(400, "invalid_export_kind", "Unsupported report producer.");
          }) };
        });
        if (batch.rows.length) yield batch.rows;
        const users = batch.users;
        if (users?.length) {
          let childCursor: UserRelationshipCursor | undefined;
          do {
            signal.throwIfAborted();
            const children = await exportContext.read(client => userRelationshipBatch(client, batch.context, users, childCursor));
            yield children.rows;
            childCursor = children.next;
          } while (childCursor);
        }
        if (!batch.cursor) break;
        cursor = batch.cursor;
      }
    };
  }
}

type UserRelationshipCursor = { parent: number; nullRank: number; key: string; id: string };
async function userRelationshipBatch(client: pg.PoolClient, context: ReportReadContext, users: readonly ReportUser[], after?: UserRelationshipCursor) {
  if (!users.length || users.length > 100) throw new Error("export_user_batch");
  const batch = encodeBatch(users.map((user, ordinal) => ({ ordinal, username: user.username })),
    [context.identity.tenantId, context.report.setId, after?.parent ?? null, after?.nullRank ?? 0, after?.key ?? "", after?.id ?? ""]);
  const order = `parent_ordinal,(page_key IS NULL)::int,COALESCE(page_key,'') COLLATE "C",COALESCE(relationship_id,'') COLLATE "C"`;
  const raw = (await client.query(`WITH parents AS (
      SELECT ordinal,username FROM jsonb_to_recordset($3::jsonb) p(ordinal integer,username text)
    ), relationships AS (
      SELECT p.ordinal AS parent_ordinal,p.username AS parent_username,f.payload_hash AS relationship_id,
        f.agent_id,f.agent_name,f.creator_type,f.username,f.responses::text,f.last_activity::text,
        lower(normalize(f.agent_name,NFKC) COLLATE "default") AS page_key
      FROM parents p LEFT JOIN LATERAL (
        SELECT f.payload_hash,f.agent_id,f.agent_name,f.creator_type,f.username,f.responses,f.last_activity
        FROM official_usage_set_versions m JOIN official_usage_version_rows r ON r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind
        JOIN official_usage_row_facts f ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
        WHERE m.tenant_id=$1 AND m.set_id=$2 AND m.kind='userAgents' AND f.username=p.username
      ) f ON true WHERE $4::int IS NULL OR p.ordinal>=$4
    ), candidate AS MATERIALIZED (
      SELECT * FROM relationships WHERE $4::int IS NULL OR
        (parent_ordinal,(page_key IS NULL)::int,COALESCE(page_key,'') COLLATE "C",COALESCE(relationship_id,'') COLLATE "C")
          >($4::int,$5::int,$6::text COLLATE "C",$7::text COLLATE "C")
      ORDER BY ${order} LIMIT 101
    ), sized AS (
      SELECT candidate.*,row_number() OVER(ORDER BY ${order}) AS position,count(*) OVER() AS candidate_count,
        sum(octet_length(to_jsonb(candidate)::text)+128) OVER(ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS batch_bytes FROM candidate
    ) SELECT * FROM sized WHERE batch_bytes<=524288 ORDER BY position`,
  [context.identity.tenantId, context.report.setId, batch.json, after?.parent ?? null, after?.nullRank ?? 0, after?.key ?? "", after?.id ?? ""])).rows;
  encodeBatch(raw);
  if (!raw.length) throw new AppError(413, "data_row_limit", "A selected relationship exceeds the response budget.");
  const page = raw.slice(0, 100), more = officialReportCount(raw[0].candidate_count) > page.length, last = page.at(-1)!;
  const rows = page.map(row => {
    const user = users[row.parent_ordinal];
    if (!user || user.username !== row.parent_username) throw new Error("export_user_batch");
    const relationship: ReportRelationship | null = row.relationship_id === null ? null : {
      id: row.relationship_id, agentId: row.agent_id, agentName: row.agent_name ?? row.agent_id, creatorType: row.creator_type ?? "",
      username: row.username, responses: officialReportCount(row.responses), lastActivityDateUtc: row.last_activity, identityStatus: "unresolved",
    };
    return userRow(user, relationship, context);
  });
  return { rows, next: more ? { parent: last.parent_ordinal as number, nullRank: last.page_key === null ? 1 : 0,
    key: last.page_key ?? "", id: last.relationship_id ?? "" } satisfies UserRelationshipCursor : undefined };
}

function unknown(value: unknown) { return value === null || value === undefined ? "Unknown" : value; }
function utcDate(value: string | null | undefined) { return value == null ? "Unknown" : new Date(value).toISOString(); }
function lineage(context: ReportReadContext, kind: "agents" | "users" | "userAgents") {
  const source = context.report.lineages.find(lineage => lineage.kind === kind);
  return { reportSetId: context.report.setId, reportingStart: context.report.reportingPeriod?.startDate ?? null,
    reportingEnd: context.report.reportingPeriod?.endDate ?? null, historyRevision: context.report.historyRevision,
    [`${kind}VersionId`]: source?.versionId ?? null, [`${kind}PeriodProvenance`]: source?.periodProvenance ?? null,
    [`${kind}SourceFreshness`]: source?.sourceFreshness ?? "unknown" };
}
function userRow(user: ReportUser, row: ReportRelationship | null, context: ReportReadContext) {
  const entitlement = context.metadata.directory.state === "available" ? user.entitlement : null;
  return { username: user.username, displayName: user.displayName,
    licenseAssignmentStatus: entitlement === "no_paid" || entitlement === "paid_inactive" ? "no_active_paid_license" : "unavailable",
    entitlement: entitlement ?? "unknown",
    reviewCohort: ({ zero: "zero_responses", low: "low_responses", outside: "outside_threshold", unknown: "unknown" })[user.reviewCohort],
    reviewCandidate: user.reviewCohort === "zero" || user.reviewCohort === "low", userMetricSource: user.missingUserReport ? "unknown" : "users_report",
    reportedAgentsUsed: unknown(user.reportedAgentsUsed), reportedResponsesReceived: unknown(user.reportedResponses),
    agentsAccessedTotal: user.relationshipCount, responseProducingAgentCount: user.relationshipCount ? user.responseProducingAgentCount : "Unknown",
    bridgeResponsesSentToUsers: user.relationshipCount ? user.bridgeResponses : "Unknown", missingUserReport: user.missingUserReport,
    missingBridgeRows: !user.relationshipCount, hasReportMismatch: user.hasReportMismatch, userLastActivityDateUtc: utcDate(user.userLastActivityDateUtc),
    agentId: row?.agentId ?? "", agentName: row?.agentName ?? "", creatorType: row?.creatorType ?? "",
    creatorTypeSource: row ? "users_and_agents_report" : "Unknown", responsesSentToUsers: unknown(row?.responses),
    agentLastUsedByAnyoneDateUtc: utcDate(row?.lastActivityDateUtc), identityStatus: "unresolved",
    ...lineage(context, "users"), ...lineage(context, "userAgents") };
}
