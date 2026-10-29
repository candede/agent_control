import type pg from "pg";
import { InventoryQueries, inventoryPackageResidualSql } from "../db/inventoryQueries.js";
import { inventoryAsOf } from "../db/inventoryGenerations.js";
import { dataLimitError, dataLimits, encodeBatch } from "../db/dataBounds.js";
import type { SelectionIdentity } from "./dataSelections.js";
import type { ExportSource } from "./dataExports.js";
import { inventoryObservation, inventoryPresentation, inventorySourceStatuses } from "./inventoryPresentation.js";
import { inventoryTimestamp } from "./inventoryTimestamp.js";
import { unifiedAgentExportColumns, unifiedAgentExportRows } from "./inventoryCsv.js";
import { agentCapabilityExport, agentCapabilityExportColumns, exportConnectorOperation, exportPackageElement } from "./agentContextExport.js";
import type { InventoryConnectorOperation, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { unifiedAgentSortKeys } from "../types/unifiedAgents.js";
import { projectPackageDetailAge } from "./packageDetailProjection.js";
import type { PackageAgentLinkEvidence } from "./packageAgentIdentity.js";
import { AppError } from "../errors.js";
import { exportJson } from "./csvEncoding.js";
import { normalizeEnvironmentIdentity } from "./inventoryIdentity.js";

const childColumns = ["recordType", "parentAgentId", "sourceIdentity", "sourceDomain", "sourceScopeId", "sourceGenerationId",
  "sourceObservedAt", "sourceExpiresAt", "sourceCatalogGenerationId", "sourceDetailGenerationId", "sourceEvidence", "sourceProvenance",
  "childKind", "childOrdinal", "childData"] as const;
export const inventoryExportColumns = {
  graph_packages: ["id", "displayName", "publisher", "isBlocked", "availableTo", "deployedTo", "lastModifiedDateTime",
    "sourceSystem", "snapshotId", "snapshotObservedAt", "snapshotExpiresAt", "detailFreshness", ...childColumns],
  power_platform_agents: ["sourceSystem", "nativeId", "displayName", "type", "environmentId", "location", "authoringTool", "agentKind",
    "lifecycle", "createdAt", "createdBy", "ownerId", "lastModifiedBy", "lastModifiedAt", "lastPublishedAt",
    "snapshotId", "snapshotObservedAt", "snapshotExpiresAt", ...agentCapabilityExportColumns, ...childColumns],
  unified_agents: [...unifiedAgentExportColumns, ...childColumns],
} as const;
export type InventoryExportKind = keyof typeof inventoryExportColumns;

export function inventoryExportSource(inventory: InventoryQueries, identity: SelectionIdentity): ExportSource {
  return async function* (signal, job) {
    if (!Object.hasOwn(inventoryExportColumns, job.kind)) {
      throw new AppError(400, "export_selection_kind", "The export kind does not match its selected inventory source.");
    }
    const read: typeof job.read = async work => {
      signal.throwIfAborted();
      const result = await job.read(async client => {
        await client.query("SELECT set_config('jit','off',true),set_config('enable_nestloop','on',true)");
        signal.throwIfAborted();
        return work(client);
      });
      signal.throwIfAborted();
      return result;
    };
    let cursor: string | undefined;
    let summary: Parameters<InventoryQueries["pageInRead"]>[6];
    signal.throwIfAborted();
    const selected = await read(async client => {
      const selected = await inventory.contextInRead(client, job.selectionId, identity, job.id);
      signal.throwIfAborted();
      const root = (await client.query<{ domain: string }>(`SELECT domain FROM inventory_roots
        WHERE baseline_id=$1 AND scope_id=$2`, [selected.context.baselineId, selected.context.scopeId])).rows[0];
      const canonical = root?.domain === "canonical";
      const expectedDomain = job.kind === "graph_packages" ? "packages"
        : job.kind === "power_platform_agents" ? "power_platform" : "canonical";
      if (!root || !canonical && root.domain !== expectedDomain) {
        throw new AppError(400, "export_selection_kind", "The export kind does not match its selected inventory source.");
      }
      return { ...selected, canonical };
    });
    const { canonical } = selected;
    if (job.mode === "explicit") {
      let ordinal = -1;
      for (;;) {
        signal.throwIfAborted();
        const items = await read(async client => {
          const items = (await client.query<{ ordinal: number; identity: string }>(`SELECT ordinal,identity FROM data_export_items
            WHERE export_id=$1 AND tenant_id=$2 AND ordinal>$3 ORDER BY ordinal LIMIT 100`,
          [job.id, identity.tenantId, ordinal])).rows;
          signal.throwIfAborted();
          if (items.length) await inventory.resolveExportReferencesInRead(client, selected.context,
            items.map(item => item.identity), job.kind as InventoryExportKind);
          return items;
        });
        if (!items.length) {
          if (ordinal === -1) throw new AppError(400, "invalid_export_selection", "Select at least one exact inventory reference.");
          break;
        }
        ordinal = items.at(-1)!.ordinal;
      }
    }
    for (;;) {
      signal.throwIfAborted();
      const initial = await read(async client => {
        const { context, selection } = selected;
        const raw = await inventory.pageInRead(client, context, selection, job.selectionId, identity,
          { limit: 100, cursor, exportKind: job.kind as InventoryExportKind, ...job.mode === "explicit" ? { explicitExportId: job.id } : {} }, summary);
        signal.throwIfAborted();
        await client.query("SELECT set_config('enable_nestloop','on',true)");
        signal.throwIfAborted();
        const members = await memberBatch(client, context, raw.value.map(row => row.id), "", job.kind as InventoryExportKind,
          job.mode === "explicit" ? job.id : undefined, canonical);
        signal.throwIfAborted();
        const children = await childBatch(client, members.value, "");
        return { raw, members, children };
      });
      const { raw } = initial;
      if (!summary) {
        const { value: _value, page: _page, selection: _selection, inventoryScope: _scope, ...metadata } = raw;
        summary = metadata;
      }
      const page = canonical ? inventoryPresentation(raw) : undefined;
      const evaluatedAt = raw.selection.evaluatedAt as string | Date;
      const agents = new Map(page?.value.map(agent => [agent.id, agent]));
      function* agentRows() {
        if (page) for (const row of unifiedAgentExportRows(page)) yield { ...row, recordType: "agent" };
      }
      if (job.kind === "unified_agents") yield* boundedRows(agentRows(), signal);
      function* sourceRows(members: readonly Member[]): Generator<Record<string, unknown>> {
        for (const member of members) {
          const packageValue = member.domain === "packages"
            ? projectPackageDetailAge(member.residual as CopilotPackageDetail, evaluatedAt) : null;
          const common = memberContext(member), sourceDates = { snapshotId: member.generation_id,
            snapshotObservedAt: inventoryTimestamp(member.observed_at), snapshotExpiresAt: inventoryTimestamp(member.expires_at) };
          const snapshotId = member.catalog_generation ?? member.generation_id;
          const catalogObservedAt = member.catalog_observed_at ?? (member.catalog_generation ? null : member.observed_at);
          const catalogExpiresAt = member.catalog_expires_at ?? (member.catalog_generation ? null : member.expires_at);
          if (member.domain === "packages" && (!catalogObservedAt || !catalogExpiresAt)) {
            throw new AppError(500, "saved_source_invalid", "Saved package catalog observation provenance is unavailable.");
          }
          if (job.kind === "graph_packages") {
            yield { ...packageValue, ...common, recordType: "source", sourceSystem: "graph_packages",
              snapshotId, snapshotObservedAt: inventoryTimestamp(catalogObservedAt!),
              snapshotExpiresAt: inventoryTimestamp(catalogExpiresAt!),
              detailFreshness: packageValue?.detailFreshness ? exportJson(packageValue.detailFreshness) : null };
          } else if (job.kind === "power_platform_agents") {
            const resource = { ...member.residual, connectorCounts: member.connector_counts } as unknown as PowerPlatformResource;
            yield { ...resource, ...common, recordType: "source", ownerId: resource.details.ownerId,
              lastModifiedBy: resource.details.lastModifiedBy, lastModifiedAt: resource.details.lastModifiedAt,
              lastPublishedAt: resource.lastPublishedAt, ...sourceDates, ...agentCapabilityExport(resource) };
          } else {
            const agent = agents.get(member.parent_id);
            if (!agent || !page) throw new Error("inventory_export_membership");
            const current = raw.freshness.sources.some(source => source.scope_id === member.scope_id
              && inventoryObservation(source.generation_id, source.observed_at, source.expires_at, source.current, raw.selection.evaluatedAt as string | Date).current);
            const detail = packageValue?.detailFreshness;
            const catalogObservation = member.domain === "packages"
              ? inventoryObservation(snapshotId, catalogObservedAt!, catalogExpiresAt!, current, evaluatedAt) : null;
            const sourceStatuses = inventorySourceStatuses(raw.freshness.sources.filter(source => source.scope_id === member.scope_id), raw.selection.evaluatedAt as string | Date);
            const packageObservation = sourceStatuses.graphPackages.observation;
            const nativeObservation = sourceStatuses.powerPlatform.observation && "roleScope" in sourceStatuses.powerPlatform.observation
              ? sourceStatuses.powerPlatform.observation : null;
            const source = { ...agent,
              displayName: typeof member.residual.displayName === "string" ? member.residual.displayName : member.native_id,
              presence: member.domain === "packages" ? "graph_packages" as const : "power_platform" as const,
              environmentId: member.environment_id,
              environment: agent.environment && member.environment_id !== null
                && normalizeEnvironmentIdentity(agent.environment.id) === normalizeEnvironmentIdentity(member.environment_id) ? agent.environment : null,
              people: member.domain === "power_platform" ? agent.people : undefined,
              usage: undefined,
              memberCount: 1, packageCount: packageValue ? 1 : 0, packagesComplete: true,
              columns: { ...Object.fromEntries(unifiedAgentSortKeys.map(key => [key, null])), ...member.columns },
              packages: packageValue ? [packageValue] : [],
              powerPlatformResource: member.domain === "power_platform" ? { ...member.residual, identifiers: [],
                identifierCount: member.identifier_count, identifiersComplete: member.identifier_count === 0,
                savedSource: { scopeId: member.scope_id, identity: member.identity },
                connectorCounts: member.connector_counts } as unknown as PowerPlatformResource : null,
              identity: { ...agent.identity, evidence: member.evidence,
                packageEvidence: member.domain === "packages" ? [{ packageId: member.identity, evidence: member.evidence }] : [] },
              observations: { ...agent.observations,
                graphPackages: packageObservation && catalogObservation ? { ...packageObservation,
                  ...catalogObservation,
                } as typeof agent.observations.graphPackages : null,
                packageSnapshots: catalogObservation ? { [member.identity]: {
                  ...catalogObservation,
                  scopeKind: member.source_channel === "catalog" ? "broad" as const : "exact" as const,
                  identityDetails: member.detail_generation && detail?.observedAt && detail.expiresAt
                    && ["fresh", "stale"].includes(detail.state) ? {
                      ...inventoryObservation(member.detail_generation, detail.observedAt, detail.expiresAt, catalogObservation.current, evaluatedAt),
                    } : null,
                } } : {},
                powerPlatform: member.domain === "power_platform" && nativeObservation
                  ? { ...nativeObservation,
                    ...inventoryObservation(member.generation_id, member.observed_at, member.expires_at, current, raw.selection.evaluatedAt as string | Date),
                    verification: member.generation_id === nativeObservation.id ? nativeObservation.verification : null } as typeof agent.observations.powerPlatform : null,
              } };
            for (const row of unifiedAgentExportRows({ ...page, value: [source] })) yield {
              ...row, ...common, recordType: "source", usageStatus: "not_applicable_to_source",
            };
          }
        }
      }
      let { members, children } = initial;
      for (;;) {
        signal.throwIfAborted();
        yield* boundedRows(sourceRows(members.value), signal);
        while (members.value.length) {
          signal.throwIfAborted();
          yield* boundedRows(children.value.map(child => ({ ...memberContext(members.value[child.member_index]),
            recordType: "child", childKind: child.kind, childOrdinal: child.ordinal,
            childData: exportJson({ value: child.value, payload: child.kind === "connectorOperation"
              ? exportConnectorOperation(child.payload as InventoryConnectorOperation)
              : child.kind === "element" ? exportPackageElement(child.payload as Record<string, unknown>) : child.payload }) })), signal);
          if (!children.next) break;
          children = await read(client => childBatch(client, members.value, children.next!));
        }
        if (!members.next) break;
        ({ members, children } = await read(async client => {
          const next = await memberBatch(client, selected.context, raw.value.map(row => row.id), members.next!,
            job.kind as InventoryExportKind, job.mode === "explicit" ? job.id : undefined, canonical);
          signal.throwIfAborted();
          return { members: next, children: await childBatch(client, next.value, "") };
        }));
      }
      if (!raw.page.nextCursor) break;
      cursor = raw.page.nextCursor;
    }
  };
}

type Member = { key: string; parent_id: string; identity: string; domain: string; generation_id: string;
  native_id: string; environment_id: string | null; detail_generation: string | null; columns: Record<string, string | number | null>;
  scope_id: string; catalog_generation: string | null; source_channel: string | null; evidence: PackageAgentLinkEvidence[];
  catalog_observed_at: string | null; catalog_expires_at: string | null;
  residual: Record<string, unknown>; observed_at: string; expires_at: string; connector_counts: PowerPlatformResource["connectorCounts"];
  identifier_count: number | null };
function memberContext(member: Member) {
  if (!Array.isArray(member.evidence)) throw new AppError(500, "saved_source_invalid", "Saved inventory membership evidence is invalid.");
  return { parentAgentId: member.parent_id || null, sourceIdentity: member.identity, sourceDomain: member.domain,
    sourceScopeId: member.scope_id, sourceGenerationId: member.generation_id,
    sourceObservedAt: inventoryTimestamp(member.observed_at), sourceExpiresAt: inventoryTimestamp(member.expires_at),
    sourceCatalogGenerationId: member.domain === "packages" ? member.catalog_generation ?? member.generation_id : null,
    sourceDetailGenerationId: member.detail_generation, sourceEvidence: exportJson(member.evidence),
    sourceProvenance: exportJson(member.residual.provenance ?? null) };
}

const boundedResult = `, sized AS (
  SELECT *,row_number() OVER(ORDER BY key COLLATE "C") AS position,
    sum(octet_length(row_to_json(c)::text)) OVER(ORDER BY key COLLATE "C") AS bytes FROM candidates c)
  SELECT coalesce(jsonb_agg(to_jsonb(s)-'bytes'-'position' ORDER BY key COLLATE "C")
    FILTER(WHERE bytes<=${dataLimits.batchBytes} AND position<=250),'[]'::jsonb) AS value,
    coalesce(bool_or(bytes>${dataLimits.batchBytes} OR position>250),false) AS more,
    max(bytes) FILTER(WHERE position=1) AS first_bytes FROM sized s`;

function boundedPage<T extends { key: string }>(row: { value: T[]; more: boolean; first_bytes: string | null }) {
  if (Number(row.first_bytes) > 524288) throw dataLimitError("inventory_export_record_bytes", 524288, Number(row.first_bytes));
  encodeBatch(row.value);
  return { value: row.value, next: row.more ? row.value.at(-1)!.key : null };
}

async function memberBatch(client: pg.PoolClient, context: { baselineId: string; revision: string }, ids: string[], after: string,
  kind: InventoryExportKind, explicitId: string | undefined, canonical: boolean) {
  const domain = kind === "graph_packages" ? "packages" : kind === "power_platform_agents" ? "power_platform" : null;
  const key = `lpad(requested.ordinal::text,3,'0')||r.scope_id::text||r.identity`;
  const result = await client.query(`WITH candidates AS (
    SELECT ${key} AS key,${canonical ? "'agent:'||m.identity" : "''::text"} AS parent_id,
      r.identity,r.domain,r.scope_id,r.generation_id,r.catalog_generation,${inventoryPackageResidualSql("r")} AS residual,r.observed_at,r.expires_at,
      r.native_id,r.environment_id,r.detail_generation,
      coalesce((SELECT jsonb_object_agg(substr(f.kind,8),coalesce(to_jsonb(f.text_value),to_jsonb(f.number_value)))
        FROM inventory_facts f WHERE f.generation_id=r.generation_id AND f.identity=r.identity AND f.kind LIKE 'column:%'),
        '{}'::jsonb)||jsonb_build_object('observedAt',extract(epoch FROM r.observed_at)*1000) AS columns,
      (SELECT observed_at FROM data_generations WHERE id=coalesce(r.catalog_generation,r.generation_id)) AS catalog_observed_at,
      (SELECT expires_at FROM data_generations WHERE id=coalesce(r.catalog_generation,r.generation_id)) AS catalog_expires_at,
      ${canonical ? "s.evidence" : "'[]'::jsonb AS evidence"},
      CASE WHEN r.domain='power_platform' THEN (SELECT count(*)::int FROM inventory_facts f
        WHERE f.generation_id=r.generation_id AND f.identity=r.identity AND f.kind='identifier') END AS identifier_count,
      (SELECT channel FROM inventory_attempts attempt WHERE attempt.generation_id=coalesce(r.catalog_generation,r.generation_id)) AS source_channel,
      CASE WHEN r.domain='power_platform' THEN (SELECT CASE WHEN bool_or(f.kind='collection') THEN jsonb_build_object(
        'connectors',count(*) FILTER(WHERE f.kind='detail:connectors'),
        'operations',count(*) FILTER(WHERE f.kind='connectorOperation')) END
        FROM inventory_facts f WHERE f.generation_id=r.generation_id AND f.identity=r.identity
          AND (f.kind IN ('detail:connectors','connectorOperation') OR f.kind='collection' AND f.value='detail:connectors')) END AS connector_counts
    FROM unnest($3::text[]) WITH ORDINALITY requested(identity,ordinal)
    CROSS JOIN LATERAL (SELECT member.identity,member.generation_id FROM inventory_memberships member
      WHERE member.identity=requested.identity AND ${inventoryAsOf("member")} OFFSET 0) m
    ${canonical ? `CROSS JOIN LATERAL (SELECT source_generation_id,source_identity,evidence FROM unified_agent_memberships
        WHERE generation_id=m.generation_id AND identity=m.identity OFFSET 0) s
      CROSS JOIN LATERAL (SELECT * FROM inventory_records
        WHERE generation_id=s.source_generation_id AND identity=s.source_identity OFFSET 0) r`
    : `CROSS JOIN LATERAL (SELECT * FROM inventory_records
        WHERE generation_id=m.generation_id AND identity=m.identity OFFSET 0) r`}
    WHERE (${key}) COLLATE "C">$4 AND ($5::text IS NULL OR r.domain=$5)
      AND ($5::text IS DISTINCT FROM 'power_platform' OR r.resource_type='microsoft.copilotstudio/agents')
      AND ($6::uuid IS NULL OR $5::text IS NULL OR EXISTS(SELECT 1 FROM data_export_items e WHERE e.export_id=$6 AND e.identity=r.native_id))
    ORDER BY (${key}) COLLATE "C" LIMIT 251)${boundedResult}`,
  [context.baselineId, context.revision, ids, after, domain, explicitId ?? null]);
  return boundedPage<Member>(result.rows[0]);
}

async function childBatch(client: pg.PoolClient, members: Member[], after: string) {
  if (after && (!/^\d{13}$/.test(after) || Number(after.slice(0,3))>=members.length || Number(after.slice(3))>9999)) {
    throw new Error("inventory_export_child_cursor");
  }
  const memberIndex = after ? Number(after.slice(0,3)) : 0,ordinal = after ? Number(after.slice(3)) : -1;
  const batch = encodeBatch(members.map((member, index) => ({ index, generation: member.generation_id, identity: member.identity })));
  const key = `lpad(requested.index::text,3,'0')||lpad(f.ordinal::text,10,'0')`;
  const result = await client.query(`WITH candidates AS (
    SELECT ${key} AS key,requested.index AS member_index,f.ordinal,f.kind,f.value,f.payload
    FROM jsonb_to_recordset($1::jsonb) requested(index integer,generation uuid,identity text)
    CROSS JOIN LATERAL (SELECT * FROM inventory_facts fact
      WHERE requested.index>=$2 AND fact.generation_id=requested.generation AND fact.identity=requested.identity
        AND fact.ordinal>CASE WHEN requested.index=$2 THEN $3::integer ELSE -1 END
        AND (fact.kind LIKE 'detail:%' OR fact.kind IN
          ('collection','element','elementGroup','identifier','connectorOperation','supportedHosts','elementTypes','categories',
           'about:long','about:native','about:short'))
        AND NOT (fact.kind='collection' AND fact.value IN ('allowedUsersAndGroups','acquireUsersAndGroups','sharedWithUsersAndGroups'))
      ORDER BY fact.ordinal LIMIT 251 OFFSET 0) f
    ORDER BY (${key}) COLLATE "C" LIMIT 251)${boundedResult}`, [batch.json,memberIndex,ordinal]);
  return boundedPage<{ key: string; member_index: number; ordinal: number; kind: string; value: string; payload: unknown }>(result.rows[0]);
}

function* boundedRows(rows: Iterable<Record<string, unknown>>, signal: AbortSignal): Generator<readonly Record<string, unknown>[]> {
  const emptyBytes = encodeBatch([]).bytes;
  let pending: Record<string, unknown>[] = [], bytes = emptyBytes;
  for (const row of rows) {
    signal.throwIfAborted();
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (pending.length && (pending.length === 100 || bytes + rowBytes + 1 > dataLimits.batchBytes)) {
      yield pending;
      pending = []; bytes = emptyBytes;
    }
    if (bytes + rowBytes > dataLimits.batchBytes) encodeBatch([row]);
    bytes += rowBytes + Number(pending.length > 0);
    pending.push(row);
  }
  signal.throwIfAborted();
  if (pending.length) yield pending;
}
