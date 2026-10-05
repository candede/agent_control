import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { observeDataWork } from "./dataMetrics.js";
import { dataConnections,isSelectedRead } from "../db/dataConnections.js";
import { dataAdmissionError, dataLimits, digest, exactCount } from "../db/dataBounds.js";
import { lockDataScope } from "../db/dataGenerations.js";
import { AppError } from "../errors.js";

export type SelectionIdentity = { tenantId: string; principalId: string; authorizationHash: string; sessionEpoch: string };
export type DependencyRoot =
  | { kind: "generation"; scopeId: string; generationId: string; revision: string; expiresAt: Date }
  | { kind: "tenant_history"; scopeId: string; revision: string; expiresAt: Date }
  | { kind: "user_sources"; scopeId: string; revision: string; expiresAt: Date }
  | { kind: "inventory_delta"; scopeId: string; generationId: string; revision: string; expiresAt: Date };
export type DomainRootValidator = (client: pg.PoolClient, root: DependencyRoot, identity: SelectionIdentity) => Promise<void>;
export type Selection = { id: string; revision: string; expiresAt: Date; evaluatedAt: Date; endpoint: string; queryHash: string };
export type CursorBoundary = { key: string | null; id: string; nullRank: 0 | 1 };
type CursorPayload = {
  version: 1; identity: SelectionIdentity; endpoint: string; selectionId: string; revision: string;
  queryHash: string; direction: "next" | "previous"; boundary: CursorBoundary;
};
export class SelectionError extends AppError {
  constructor(code: "invalid_cursor" | "selection_invalidated") { super(code === "invalid_cursor" ? 400 : 409, code, code); }
}

function canonicalFilters(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new SelectionError("invalid_cursor");
  const entries = Object.keys(input).sort().map(key => {
    const value = input[key];
    if (typeof value === "number" && !Number.isFinite(value)) throw new SelectionError("invalid_cursor");
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean"
      && !(Array.isArray(value) && value.every(item => typeof item === "string"))) throw new SelectionError("invalid_cursor");
    return [key, Array.isArray(value) ? [...new Set(value)].sort() : value];
  });
  const json = JSON.stringify(Object.fromEntries(entries));
  if (Buffer.byteLength(json) > 2048) throw new SelectionError("invalid_cursor");
  return JSON.parse(json) as Record<string, unknown>;
}

export function canonicalQuery(input: Record<string, unknown>, allowed: readonly string[]) {
  return digest(JSON.stringify(canonicalFilters(input, allowed)));
}

export class CursorCodec {
  constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error("cursor_secret_required");
  }
  encode(payload: Omit<CursorPayload, "version">) {
    const encoded = Buffer.from(JSON.stringify({ ...payload, version: 1 })).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    const cursor = `${encoded}.${signature}`;
    if (Buffer.byteLength(cursor) > 4096) throw new SelectionError("invalid_cursor");
    return cursor;
  }
  decode(cursor: string, expected: Omit<CursorPayload, "version" | "direction" | "boundary">): CursorPayload {
    try {
      if (Buffer.byteLength(cursor) > 4096 || !/^[\w-]+\.[\w-]+$/.test(cursor)) throw new Error();
      const [encoded, signature] = cursor.split(".");
      const actual = Buffer.from(signature, "base64url");
      const calculated = createHmac("sha256", this.secret).update(encoded).digest();
      if (actual.length !== calculated.length || !timingSafeEqual(actual, calculated)) throw new Error();
      const parsed: CursorPayload = JSON.parse(Buffer.from(encoded, "base64url").toString());
      if (parsed.version !== 1 || !["next", "previous"].includes(parsed.direction)
        || parsed.endpoint !== expected.endpoint || parsed.queryHash !== expected.queryHash
        || parsed.selectionId !== expected.selectionId || parsed.revision !== expected.revision
        || parsed.identity.tenantId !== expected.identity.tenantId || parsed.identity.principalId !== expected.identity.principalId
        || parsed.identity.authorizationHash !== expected.identity.authorizationHash
        || parsed.identity.sessionEpoch !== expected.identity.sessionEpoch
        || typeof parsed.boundary.id !== "string" || !parsed.boundary.id || parsed.boundary.id.length > 512
        || parsed.boundary.key !== null && typeof parsed.boundary.key !== "string"
        || parsed.boundary.nullRank !== (parsed.boundary.key === null ? 1 : 0)) throw new Error();
      return parsed;
    } catch { throw new SelectionError("invalid_cursor"); }
  }
}

export class DataSelections {
  readonly connections;
  constructor(readonly database: pg.Pool, private readonly validateDomainRoot?: DomainRootValidator,
    private readonly authorizeForeignScope?: (scope: Awaited<ReturnType<typeof lockDataScope>>, identity: SelectionIdentity) => boolean) {
    this.connections = dataConnections(database);
  }
  async capture(identity: SelectionIdentity, endpoint: string, query: { values: Record<string, unknown>; allowed: readonly string[] }, roots: readonly DependencyRoot[], nextTransition?: Date): Promise<Selection> {
    return this.captureWith(identity, endpoint, query, async () => ({ roots, nextTransition }));
  }

  async captureWith(identity: SelectionIdentity, endpoint: string, query: { values: Record<string, unknown>; allowed: readonly string[] },
    prepare: (client: pg.PoolClient, evaluatedAt: Date) => Promise<{
      roots: readonly DependencyRoot[]; nextTransition?: Date;
      queryValues?: Record<string, unknown>;
      persist?: (client: pg.PoolClient, selection: Selection) => Promise<void>;
    }>): Promise<Selection> {
    const requestedFilters = canonicalFilters(query.values, query.allowed);
    return this.connections.selectedRead(async client => {
      await this.authorize(client, identity);
      const now = (await client.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
      const { roots, nextTransition, persist, queryValues } = await prepare(client, now);
      observeDataWork("selection", { pins: roots.length });
      const filters = queryValues === undefined ? requestedFilters : canonicalFilters(queryValues, query.allowed);
      const queryHash = digest(JSON.stringify(filters));
      if (!roots.length || roots.length > dataLimits.roots || new Set(roots.map(root => root.scopeId)).size !== roots.length) throw new Error("data_selection_roots");
      const expiresAt = new Date(Math.min(now.getTime() + 600_000, nextTransition?.getTime() ?? Infinity, ...roots.map(root => root.expiresAt.getTime())));
      if (expiresAt <= now) throw new SelectionError("selection_invalidated");
      const counts = (await client.query(`SELECT count(*)::int AS tenant,
        count(*) FILTER(WHERE s.principal_id=$2)::int AS principal FROM data_read_selections s
        JOIN data_principal_epochs actor ON actor.tenant_id=s.tenant_id AND actor.principal_id=s.principal_id AND actor.epoch=s.session_epoch
        WHERE s.tenant_id=$1 AND s.expires_at>clock_timestamp() AND s.invalidated_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM data_generation_pins pin JOIN data_scope_epochs source ON source.id=pin.scope_id
            WHERE pin.selection_id=s.id AND (pin.scope_epoch<>source.epoch OR pin.session_epoch<>source.session_epoch
              OR pin.expires_at<=clock_timestamp()))`,
      [identity.tenantId, identity.principalId])).rows[0];
      if (counts.tenant >= 1000 || counts.principal >= 100) throw dataAdmissionError("data_selection_admission");
      const ordered = [...roots].sort((a, b) => a.scopeId.localeCompare(b.scopeId));
      const epochs = [];
      for (const root of ordered) {
        const scope = await lockDataScope(client, root.scopeId, identity.tenantId, "share");
        if (scope.principal_id !== null && scope.principal_id !== identity.principalId && !this.authorizeForeignScope?.(scope, identity)) {
          throw new SelectionError("selection_invalidated");
        }
        await this.validateRoot(client, root, identity);
        epochs.push(scope);
      }
      const selection: Selection = { id: randomUUID(), revision: randomUUID(), expiresAt, evaluatedAt: now, endpoint, queryHash };
      await client.query(`INSERT INTO data_read_selections(id,tenant_id,principal_id,authorization_hash,endpoint,query_hash,evaluated_at,expires_at,revision,session_epoch,query_json,root_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [selection.id, identity.tenantId, identity.principalId, identity.authorizationHash, endpoint, queryHash, now, expiresAt, selection.revision, identity.sessionEpoch, JSON.stringify(filters), roots.length]);
      for (const [ordinal, root] of ordered.entries()) {
        await client.query(`INSERT INTO data_generation_pins(selection_id,tenant_id,ordinal,scope_id,scope_epoch,session_epoch,root_kind,generation_id,revision,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [selection.id, identity.tenantId, ordinal, root.scopeId, epochs[ordinal].epoch, epochs[ordinal].session_epoch,
          root.kind, "generationId" in root ? root.generationId : null, root.revision,
          new Date(Math.min(root.expiresAt.getTime(), nextTransition?.getTime() ?? Infinity))]);
      }
      await persist?.(client, selection);
      return selection;
    }, { admissionTenantId: identity.tenantId });
  }

  async validateRoot(client: pg.PoolClient, root: DependencyRoot, identity: SelectionIdentity) {
    // A temporal inventory anchor is retained storage, not the observation
    // generation that authorizes this revision. Its domain validator checks that revision.
    if ("generationId" in root) {
      const result = await client.query(`SELECT g.id FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
        WHERE g.id=$1 AND g.scope_id=$2 AND g.tenant_id=$3 AND g.state IN ('published','retired') AND g.validated
        AND ($5::boolean OR (g.expires_at>clock_timestamp() AND g.expires_at>=$4 AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch))
        FOR SHARE OF g`,
      [root.generationId, root.scopeId, identity.tenantId, root.expiresAt, root.kind === "inventory_delta"]);
      if (result.rowCount !== 1) throw new SelectionError("selection_invalidated");
    }
    if (root.kind !== "generation") {
      if (!this.validateDomainRoot) throw new Error("data_domain_root_validator_required");
      await this.validateDomainRoot(client, root, identity);
    }
  }

  private async authorize(client: pg.PoolClient, identity: SelectionIdentity) {
    await client.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [identity.tenantId, identity.principalId]);
    const row = (await client.query(`SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE`, [identity.tenantId, identity.principalId])).rows[0];
    if (row.epoch !== identity.sessionEpoch) throw new SelectionError("selection_invalidated");
  }

  // Selected readers share authorization fences; ordinary writers retain
  // exclusive fences. Nested assertions must not upgrade a reader's locks.
  async assert(client: pg.PoolClient, id: string, identity: SelectionIdentity, exportId?: string) {
    await this.authorize(client, identity);
    const pins = (await client.query(`SELECT * FROM data_generation_pins WHERE selection_id=$1 AND tenant_id=$2 ORDER BY scope_id`, [id, identity.tenantId])).rows;
    if (!pins.length || pins.length > 16) throw new SelectionError("selection_invalidated");
    for (const pin of pins) {
      const scope = await lockDataScope(client, pin.scope_id, identity.tenantId, isSelectedRead(client) ? "share" : "update");
      if (scope.epoch !== pin.scope_epoch || scope.session_epoch !== pin.session_epoch
        || scope.principal_id !== null && scope.principal_id !== identity.principalId && !this.authorizeForeignScope?.(scope, identity)) throw new SelectionError("selection_invalidated");
      const root: DependencyRoot = pin.root_kind === "tenant_history" || pin.root_kind === "user_sources"
        ? { kind: pin.root_kind, scopeId: pin.scope_id, revision: pin.revision, expiresAt: pin.expires_at }
        : { kind: pin.root_kind, scopeId: pin.scope_id, generationId: pin.generation_id, revision: pin.revision, expiresAt: pin.expires_at };
      await this.validateRoot(client, root, identity);
    }
    const selection = (await client.query(`SELECT * FROM data_read_selections WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
      AND authorization_hash=$4 AND session_epoch=$5 AND invalidated_at IS NULL
      AND (expires_at>clock_timestamp() OR EXISTS(SELECT 1 FROM data_exports e WHERE e.id=$6
        AND e.selection_id=data_read_selections.id AND e.tenant_id=$2 AND e.principal_id=$3
        AND e.status IN ('queued','building','ready') AND e.expires_at>clock_timestamp())) FOR SHARE`,
    [id, identity.tenantId, identity.principalId, identity.authorizationHash, identity.sessionEpoch, exportId ?? null])).rows[0];
    if (!selection || selection.root_count !== pins.length) throw new SelectionError("selection_invalidated");
    return { selection, pins };
  }

  read<T>(
    id: string, identity: SelectionIdentity,
    work: (client: pg.PoolClient, selected: Awaited<ReturnType<DataSelections["assert"]>>) => Promise<T>,
    options: { exportId?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.connections.selectedRead(async client => {
      const selected = await this.assert(client, id, identity, options.exportId);
      return work(client, selected);
    }, { signal: options.signal });
  }

  invalidate(id: string, identity: SelectionIdentity) {
    return this.connections.run(async client => {
      // The same scope-first order as publication and reads prevents invalidation races.
      const pins = (await client.query("SELECT scope_id FROM data_generation_pins WHERE selection_id=$1 AND tenant_id=$2 ORDER BY scope_id", [id, identity.tenantId])).rows;
      for (const pin of pins) await lockDataScope(client, pin.scope_id, identity.tenantId);
      await client.query(`UPDATE data_read_selections SET invalidated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND invalidated_at IS NULL`, [id, identity.tenantId, identity.principalId]);
    });
  }

  directoryPage(id: string, identity: SelectionIdentity, generationId: string, query: {
    limit?: number; boundary?: CursorBoundary; direction?: "next" | "previous"; company?: string;
  }) {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SelectionError("invalid_cursor");
    if (query.boundary && query.boundary.nullRank !== (query.boundary.key === null ? 1 : 0)) throw new SelectionError("invalid_cursor");
    return this.read(id, identity, async (client, { selection, pins }) => {
      if (selection.query_hash !== canonicalQuery(query.company === undefined ? {} : { company: query.company }, ["company"])) {
        throw new SelectionError("invalid_cursor");
      }
      if (!pins.some(pin => pin.generation_id === generationId)) throw new SelectionError("selection_invalidated");
      const values: unknown[] = [generationId, query.company ?? null];
      let boundary = "";
      const previous = query.direction === "previous";
      if (query.boundary) {
        values.push(query.boundary.nullRank, query.boundary.key ?? "", query.boundary.id);
        boundary = ` AND ((sort_key IS NULL)::int,coalesce(sort_key,'') COLLATE "C",identity COLLATE "C") ${previous ? "<" : ">"} ($3::int,$4::text COLLATE "C",$5::text COLLATE "C")`;
      }
      values.push(limit + 1);
      const rows = (await client.query(`SELECT identity,upn,display_name,sort_key,company,department,service_state
        FROM directory_user_rows WHERE generation_id=$1 AND ($2::text IS NULL OR company=$2) ${boundary}
        ORDER BY (sort_key IS NULL)::int ${previous ? "DESC" : "ASC"},coalesce(sort_key,'') COLLATE "C" ${previous ? "DESC" : "ASC"},identity COLLATE "C" ${previous ? "DESC" : "ASC"}
        LIMIT $${values.length}`, values)).rows;
      const counts = (await client.query(`SELECT count(*)::text AS total,count(*) FILTER(WHERE $2::text IS NULL OR company=$2)::text AS filtered
        FROM directory_user_rows WHERE generation_id=$1`, [generationId, query.company ?? null])).rows[0];
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      if (previous) page.reverse();
      const response = { value: page, more, counts: { total: exactCount(counts.total), filtered: exactCount(counts.filtered) } };
      if (Buffer.byteLength(JSON.stringify(response)) > 1_048_576) throw new Error("data_response_bytes");
      return response;
    });
  }

  exactDirectory(id: string, identity: SelectionIdentity, generationId: string, ids: readonly string[]) {
    if (ids.length > 100) throw new Error("data_exact_ids_limit");
    return this.read(id, identity, async (client, { pins }) => {
      if (!pins.some(pin => pin.generation_id === generationId)) throw new SelectionError("selection_invalidated");
      const rows = (await client.query(`SELECT identity,upn,display_name,company,department,service_state FROM directory_user_rows
        WHERE generation_id=$1 AND identity=ANY($2::text[]) ORDER BY identity COLLATE "C"`, [generationId, ids])).rows;
      if (Buffer.byteLength(JSON.stringify(rows)) > 1_048_576) throw new Error("data_response_bytes");
      return rows;
    });
  }
}
