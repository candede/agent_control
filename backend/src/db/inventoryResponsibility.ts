import type pg from "pg";
import { AppError } from "../errors.js";
import { CursorCodec, SelectionError, type SelectionIdentity } from "../services/dataSelections.js";
import type { ReportCurrentData } from "../services/largeTenantUsersReports.js";
import type { AgentResponsibilityQuery, ResponsibilityAgent, ResponsibilityPerson } from "../types/agentResponsibility.js";
import { dataLimitError, digest, encodeBatch, exactCount } from "./dataBounds.js";
import { userSourcePeopleInRead } from "./userSources.js";

const validObjectId = "^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$";
const roles = `array_remove(ARRAY[
  CASE WHEN bool_or(p.kind='person:owner') THEN 'owner' END,
  CASE WHEN bool_or(p.kind='person:createdBy') THEN 'createdBy' END,
  CASE WHEN bool_or(p.kind='person:lastModifiedBy') THEN 'lastModifiedBy' END],NULL)`;

export async function readInventoryResponsibility(client: pg.PoolClient, relation: { sql: string; values: unknown[] },
  data: ReportCurrentData, selection: Record<string, unknown>, id: string, identity: SelectionIdentity, cursors: CursorCodec,
  options: AgentResponsibilityQuery) {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || options.objectId !== undefined && !new RegExp(validObjectId, "i").test(options.objectId)
    || options.search !== undefined && (options.search.length > 256 || /[\0\r\n]/.test(options.search))) {
    throw new SelectionError("invalid_cursor");
  }
  const objectId = options.objectId?.toLowerCase();
  const search = options.search?.trim().normalize("NFKC").toLowerCase() ?? "";
  const searchParameter = `$${relation.values.length+1}`,objectParameter = `$${relation.values.length+2}`;
  const sql = `${relation.sql}, responsible AS (
    SELECT p.object_id,max(p.name) AS name,max(p.upn) AS upn,count(DISTINCT p.identity)::text AS agent_count,
      ${roles} AS roles,lower(normalize(coalesce(max(p.name),p.object_id),NFKC)) AS sort_key
    FROM people p WHERE p.object_id ~ '${validObjectId}' GROUP BY p.object_id
  ), filtered_people AS (
    SELECT * FROM responsible WHERE ${searchParameter}::text='' OR strpos(lower(normalize(object_id,NFKC)),${searchParameter})>0
      OR strpos(lower(normalize(name,NFKC)),${searchParameter})>0 OR strpos(lower(normalize(upn,NFKC)),${searchParameter})>0
  )`;
  const values = [...relation.values, search];
  const counts = (await client.query(`${sql} SELECT
    (SELECT count(*)::text FROM responsible) AS total,(SELECT count(*)::text FROM filtered_people) AS filtered,
    (SELECT count(*)::text FROM people WHERE object_id !~ '${validObjectId}') AS invalid`, values)).rows[0];
  const matching = objectId ? `SELECT f.identity AS id,f.display_name,f.presence,f.environment_id,
      ${roles} AS roles,f.sort_key,min(s.observed_at) AS observed_at
    FROM facts f JOIN people p ON p.generation_id=f.generation_id AND p.identity=f.identity AND p.object_id=${objectParameter}
    JOIN sources s ON s.canonical_id=f.identity AND s.domain='power_platform'
    GROUP BY f.identity,f.display_name,f.presence,f.environment_id,f.sort_key`
    : "SELECT object_id AS id,sort_key,name,upn,agent_count,roles FROM filtered_people";
  if (objectId) values.push(objectId);
  const expected = { identity, endpoint: "inventory:responsibility", selectionId: id, revision: String(selection.revision),
    queryHash: digest(JSON.stringify([selection.query_hash, objectId ?? null, search, limit])) };
  const cursor = options.cursor ? cursors.decode(options.cursor, expected) : undefined;
  if (cursor && (cursor.boundary.key !== null || cursor.boundary.nullRank !== 1)) throw new SelectionError("invalid_cursor");
  const reverse = cursor?.direction === "previous";
  const order = reverse ? "DESC" : "ASC";
  let boundary = "";
  if (cursor) {
    values.push(cursor.boundary.id);
    boundary = `WHERE EXISTS(SELECT 1 FROM matching anchor WHERE encode(sha256(convert_to(anchor.id,'UTF8')),'hex')=$${values.length}
      AND (m.sort_key COLLATE "C",m.id COLLATE "C") ${reverse ? "<" : ">"}
        (anchor.sort_key COLLATE "C",anchor.id COLLATE "C"))`;
  }
  const rows = (await client.query(`${sql}, matching AS (${matching}), candidates AS (
    SELECT m.* FROM matching m ${boundary} ORDER BY m.sort_key COLLATE "C" ${order},m.id COLLATE "C" ${order} LIMIT ${limit + 1}
  ), sized AS (SELECT *,sum(octet_length((to_jsonb(c)-'sort_key')::text)+2048)
    OVER(ORDER BY sort_key COLLATE "C" ${order},id COLLATE "C" ${order}) AS bytes,count(*) OVER()::int AS candidate_count,
    row_number() OVER(ORDER BY sort_key COLLATE "C" ${order},id COLLATE "C" ${order}) AS ordinal
    FROM candidates c)
  SELECT id,roles,bytes,candidate_count,${objectId
    ? "CASE WHEN bytes<=524288 THEN display_name END AS display_name,presence,environment_id,observed_at"
    : "agent_count"} FROM sized WHERE bytes<=524288 OR ordinal=1
    ORDER BY sort_key COLLATE "C" ${order},id COLLATE "C" ${order}`, values)).rows;
  if (rows[0] && exactCount(rows[0].bytes) > 524288) throw dataLimitError("inventory_responsibility_record_bytes", 524288, exactCount(rows[0].bytes));
  const pageRows = rows.slice(0, limit);
  if (reverse) pageRows.reverse();
  const evidenceIds = objectId ? [objectId] : pageRows.map(row => row.id as string);
  const evidence = new Map((await userSourcePeopleInRead(client, { ...identity, tokenMode: "delegated" },
    data.metadata.directory.generationId ? { generationId: data.metadata.directory.generationId,
      observedAt: new Date(data.metadata.directory.observedAt!) } : null, evidenceIds, data.evaluatedAt))
    .map(person => [person.objectId, person]));
  const person = (row: Record<string, unknown>): ResponsibilityPerson => ({
    objectId: String(row.id ?? row.object_id), agentCount: exactCount(row.agent_count as string),
    roles: row.roles as ResponsibilityPerson["roles"], evidence: evidence.get(String(row.id ?? row.object_id)) ?? null,
  });
  let selected: { person: ResponsibilityPerson; agents: ResponsibilityAgent[]; count: number } | null = null;
  if (objectId) {
    const row = (await client.query(`${sql} SELECT * FROM responsible WHERE object_id=${objectParameter}`, [...relation.values, search, objectId])).rows[0];
    if (!row && !evidence.has(objectId)) throw new AppError(404, "responsibility_person_unavailable",
      "No authorized saved responsibility or directory evidence exists for this exact user. Reload Users or Sync.");
    const selectedPerson = row ? person(row) : { objectId, agentCount: 0, roles: [], evidence: evidence.get(objectId)! };
    selected = { person: selectedPerson, count: selectedPerson.agentCount,
      agents: pageRows.map(row => ({ id: `agent:${row.id}`, displayName: row.display_name, presence: row.presence,
        environmentId: row.environment_id, roles: row.roles, observedAt: new Date(row.observed_at).toISOString() })) };
  }
  const encode = (row: Record<string, unknown> | undefined, direction: "next" | "previous", enabled: boolean) =>
    row && enabled ? cursors.encode({ ...expected, direction, boundary: { nullRank: 1, key: null, id: digest(String(row.id)) } }) : null;
  const more = rows.length > limit || Boolean(rows[0] && Number(rows[0].candidate_count) > pageRows.length);
  const result = {
    selection: { id, revision: String(selection.revision), evaluatedAt: new Date(selection.evaluated_at as Date).toISOString(),
      expiresAt: new Date(selection.expires_at as Date).toISOString() },
    counts: { total: exactCount(counts.total), filtered: exactCount(counts.filtered) },
    page: { limit, nextCursor: encode(pageRows.at(-1), "next", reverse ? Boolean(cursor) : more),
      previousCursor: encode(pageRows[0], "previous", reverse ? more : Boolean(cursor)) },
    invalidReferenceCount: exactCount(counts.invalid),
    people: objectId ? [] : pageRows.map(person), selected,
  };
  encodeBatch([result]);
  return result;
}
