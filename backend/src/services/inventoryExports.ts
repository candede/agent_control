import type pg from "pg";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { inventoryAsOf } from "../db/inventoryGenerations.js";
import { dataLimitError, dataLimits, encodeBatch } from "../db/dataBounds.js";
import type { SelectionIdentity } from "./dataSelections.js";
import type { ExportSource } from "./dataExports.js";
import { inventoryPresentation } from "./inventoryPresentation.js";
import { unifiedAgentExportColumns, unifiedAgentExportRows } from "./inventoryCsv.js";
import { agentCapabilityExport, agentCapabilityExportColumns, exportConnectorOperation } from "./agentContextExport.js";
import type { InventoryConnectorOperation, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { AppError } from "../errors.js";

const childColumns = ["recordType", "parentAgentId", "sourceIdentity", "sourceDomain", "childKind", "childOrdinal", "childData"] as const;
export const inventoryExportColumns = {
  graph_packages: ["id", "displayName", "publisher", "isBlocked", "availableTo", "deployedTo", "lastModifiedDateTime",
    "sourceSystem", "snapshotId", "snapshotObservedAt", "snapshotExpiresAt", ...childColumns],
  power_platform_agents: ["sourceSystem", "nativeId", "displayName", "type", "environmentId", "location", "authoringTool", "agentKind",
    "lifecycle", "createdAt", "createdBy", "ownerId", "lastModifiedBy", "lastModifiedAt", "lastPublishedAt",
    "snapshotId", "snapshotObservedAt", "snapshotExpiresAt", ...agentCapabilityExportColumns, ...childColumns],
  unified_agents: [...unifiedAgentExportColumns, ...childColumns],
} as const;
export type InventoryExportKind = keyof typeof inventoryExportColumns;

export function inventoryExportSource(inventory: InventoryQueries, identity: SelectionIdentity): ExportSource {
  return async function* (signal, job) {
    const read: typeof job.read = work => job.read(async client => {
      await client.query("SELECT set_config('jit','off',true),set_config('enable_nestloop','on',true)");
      return work(client);
    });
    let cursor: string | undefined;
    let summary: Parameters<InventoryQueries["pageInRead"]>[6];
    let selected: Awaited<ReturnType<InventoryQueries["contextInRead"]>> | undefined;
    let canonical: boolean | undefined;
    for (;;) {
      signal.throwIfAborted();
      const initial = await read(async client => {
        selected ??= await inventory.contextInRead(client, job.selectionId, identity, job.id);
        const { context, selection } = selected;
        if (canonical === undefined) {
          const root = (await client.query<{ domain: string }>(`SELECT domain FROM inventory_roots
            WHERE baseline_id=$1 AND scope_id=$2`, [context.baselineId, context.scopeId])).rows[0];
          canonical = root?.domain === "canonical";
          const expectedDomain = job.kind === "graph_packages" ? "packages"
            : job.kind === "power_platform_agents" ? "power_platform" : "canonical";
          if (!root || !canonical && root.domain !== expectedDomain) {
            throw new AppError(400, "export_selection_kind", "The export kind does not match its selected inventory source.");
          }
        }
        const raw = await inventory.pageInRead(client, context, selection, job.selectionId, identity,
          { limit: 100, cursor, exportKind: job.kind as InventoryExportKind, ...job.mode === "explicit" ? { explicitExportId: job.id } : {} }, summary);
        await client.query("SELECT set_config('enable_nestloop','on',true)");
        const members = await memberBatch(client, context, raw.value.map(row => row.id), "", job.kind as InventoryExportKind,
          job.mode === "explicit" ? job.id : undefined, canonical);
        const children = await childBatch(client, members.value, "");
        return { raw, members, children };
      });
      const { raw } = initial;
      if (!summary) {
        const { value: _value, page: _page, selection: _selection, inventoryScope: _scope, ...metadata } = raw;
        summary = metadata;
      }
      const page = canonical ? inventoryPresentation(raw) : undefined;
      const agents = new Map(page?.value.map(agent => [agent.id, agent]));
      if (job.kind === "unified_agents" && page) yield* boundedRows([...unifiedAgentExportRows(page)].map(row => ({ ...row, recordType: "agent" })));
      function* sourceRows(members: readonly Member[]): Generator<Record<string, unknown>> {
        for (const member of members) {
          const common = memberContext(member), sourceDates = { snapshotId: member.generation_id,
            snapshotObservedAt: new Date(member.observed_at).toISOString(), snapshotExpiresAt: new Date(member.expires_at).toISOString() };
          if (job.kind === "graph_packages") {
            yield { ...member.residual, ...common, recordType: "source", sourceSystem: "graph_packages", ...sourceDates };
          } else if (job.kind === "power_platform_agents") {
            const resource = { ...member.residual, connectorCounts: member.connector_counts } as unknown as PowerPlatformResource;
            yield { ...resource, ...common, recordType: "source", ownerId: resource.details.ownerId,
              lastModifiedBy: resource.details.lastModifiedBy, lastModifiedAt: resource.details.lastModifiedAt,
              lastPublishedAt: resource.lastPublishedAt, ...sourceDates, ...agentCapabilityExport(resource) };
          } else {
            const agent = agents.get(member.parent_id);
            if (!agent || !page) throw new Error("inventory_export_membership");
            const source = { ...agent, packages: member.domain === "packages" ? [member.residual as never] : [],
              powerPlatformResource: member.domain === "power_platform" ? { ...member.residual, identifiers: [],
                connectorCounts: member.connector_counts } as unknown as PowerPlatformResource : null };
            for (const row of unifiedAgentExportRows({ ...page, value: [source] })) yield { ...row, ...common, recordType: "source" };
          }
        }
      }
      let { members, children } = initial;
      for (;;) {
        signal.throwIfAborted();
        yield* boundedRows(sourceRows(members.value));
        while (members.value.length) {
          signal.throwIfAborted();
          yield* boundedRows(children.value.map(child => ({ ...memberContext(members.value[child.member_index]),
            recordType: "child", childKind: child.kind, childOrdinal: child.ordinal,
            childData: JSON.stringify({ value: child.value, payload: child.kind === "connectorOperation"
              ? exportConnectorOperation(child.payload as InventoryConnectorOperation) : child.payload }) })));
          if (!children.next) break;
          children = await read(client => childBatch(client, members.value, children.next!));
        }
        if (!members.next) break;
        ({ members, children } = await read(async client => {
          const next = await memberBatch(client, selected!.context, raw.value.map(row => row.id), members.next!,
            job.kind as InventoryExportKind, job.mode === "explicit" ? job.id : undefined, canonical!);
          return { members: next, children: await childBatch(client, next.value, "") };
        }));
      }
      if (!raw.page.nextCursor) break;
      cursor = raw.page.nextCursor;
    }
  };
}

type Member = { key: string; parent_id: string; identity: string; domain: string; generation_id: string;
  residual: Record<string, unknown>; observed_at: string; expires_at: string; connector_counts: PowerPlatformResource["connectorCounts"] };
function memberContext(member: Member) {
  return { parentAgentId: member.parent_id || null, sourceIdentity: member.identity, sourceDomain: member.domain };
}

const boundedResult = `, sized AS (
  SELECT *,row_number() OVER(ORDER BY key COLLATE "C") AS position,
    sum(octet_length(row_to_json(c)::text)) OVER(ORDER BY key COLLATE "C") AS bytes FROM candidates c)
  SELECT coalesce(jsonb_agg(to_jsonb(s)-'bytes'-'position' ORDER BY key COLLATE "C")
    FILTER(WHERE bytes<=524288 AND position<=250),'[]'::jsonb) AS value,
    coalesce(bool_or(bytes>524288 OR position>250),false) AS more,
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
      r.identity,r.domain,r.generation_id,r.residual,r.observed_at,r.expires_at,
      CASE WHEN r.domain='power_platform' THEN (SELECT CASE WHEN bool_or(f.kind='collection') THEN jsonb_build_object(
        'connectors',count(*) FILTER(WHERE f.kind='detail:connectors'),
        'operations',count(*) FILTER(WHERE f.kind='connectorOperation')) END
        FROM inventory_facts f WHERE f.generation_id=r.generation_id AND f.identity=r.identity
          AND (f.kind IN ('detail:connectors','connectorOperation') OR f.kind='collection' AND f.value='detail:connectors')) END AS connector_counts
    FROM unnest($3::text[]) WITH ORDINALITY requested(identity,ordinal)
    CROSS JOIN LATERAL (SELECT member.identity,member.generation_id FROM inventory_memberships member
      WHERE member.identity=requested.identity AND ${inventoryAsOf("member")} OFFSET 0) m
    ${canonical ? `CROSS JOIN LATERAL (SELECT source_generation_id,source_identity FROM unified_agent_memberships
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
          ('collection','element','elementGroup','identifier','connectorOperation','supportedHosts','elementTypes','categories'))
        AND NOT (fact.kind='collection' AND fact.value IN ('allowedUsersAndGroups','acquireUsersAndGroups'))
      ORDER BY fact.ordinal LIMIT 251 OFFSET 0) f
    ORDER BY (${key}) COLLATE "C" LIMIT 251)${boundedResult}`, [batch.json,memberIndex,ordinal]);
  return boundedPage<{ key: string; member_index: number; ordinal: number; kind: string; value: string; payload: unknown }>(result.rows[0]);
}

function* boundedRows(rows: Iterable<Record<string, unknown>>): Generator<readonly Record<string, unknown>[]> {
  const emptyBytes = encodeBatch([]).bytes;
  let pending: Record<string, unknown>[] = [], bytes = emptyBytes;
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row));
    if (pending.length && (pending.length === 100 || bytes + rowBytes + 1 > dataLimits.batchBytes)) {
      yield pending;
      pending = []; bytes = emptyBytes;
    }
    if (bytes + rowBytes > dataLimits.batchBytes) encodeBatch([row]);
    bytes += rowBytes + Number(pending.length > 0);
    pending.push(row);
  }
  if (pending.length) yield pending;
}
