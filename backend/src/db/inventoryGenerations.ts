import type pg from "pg";
import { LifecycleSlice } from "./lifecycleSlice.js";
import { assertResidualDatabaseBounds, dataLimitError, dataLimits, digest, encodeBatch, exactCount } from "./dataBounds.js";
import { DataGenerations, type BeginGeneration, type GenerationLease } from "./dataGenerations.js";
import { inventoryLimits, type InventoryDomain, type InventoryPage, type InventoryRoot } from "../types/inventoryRecords.js";
import type { InventoryRecord } from "../services/inventoryRecordProjection.js";
import { normalizeNativeIdentity } from "../services/inventoryIdentity.js";

export const inventoryTables = { packages: "package_record_rows", power_platform: "power_platform_record_rows", canonical: "unified_agent_rows" } as const;
export type InventoryIntent = {
  domain: InventoryDomain; mode: "baseline" | "delta" | "compact";
  channel: "catalog" | "exact" | "detail" | "control" | "canonical";
  environmentId?: string; resourceTypes?: readonly string[];
  targets?: readonly string[];
  targetJobId?: string;
  roleScope?: "full" | "ai" | "unknown";
};
export function inventorySelector(intent: Pick<InventoryIntent, "domain" | "environmentId" | "resourceTypes">) {
  return intent.domain === "power_platform" ? JSON.stringify([intent.environmentId?.toLowerCase() ?? "", [...new Set(intent.resourceTypes ?? [])].sort()]) : "complete";
}
type Completion = NonNullable<NonNullable<Parameters<DataGenerations["publish"]>[1]>["completeJob"]>;
export const inventoryAsOf = (alias = "m", root = "$1", revision = "$2") =>
  `${alias}.baseline_id=${root} AND ${alias}.valid_from_revision<=${revision} AND (${alias}.valid_to_revision IS NULL OR ${alias}.valid_to_revision>${revision})`;
const retainedInputs = (baseline = "$1", scope = "$2") => `SELECT input.revision FROM inventory_revisions v JOIN inventory_roots canonical ON canonical.baseline_id=v.baseline_id
  CROSS JOIN LATERAL jsonb_to_recordset(v.inputs) input("baselineId" uuid,revision bigint,epoch bigint,"expiresAt" timestamptz)
  JOIN data_scope_epochs source ON source.id=${scope}
  WHERE v.inputs @> jsonb_build_array(jsonb_build_object('baselineId',${baseline}::text)) AND input."baselineId"=${baseline}::uuid
    AND input.epoch=source.epoch AND input."expiresAt">clock_timestamp()
    AND (canonical.current AND canonical.revision=v.revision OR EXISTS(SELECT 1 FROM data_generation_pins p
      WHERE p.generation_id=canonical.baseline_id AND p.revision=v.revision AND p.expires_at>clock_timestamp()))`;
// Child identities retain the database collation; do not force their indexed joins to use the key's C collation.
const acceptedInventoryKeys = `SELECT k.generation_id,k.scope_id,k.tenant_id,k.identity COLLATE "default" AS identity,
    k.schema_version,k.content_hash,k.deleted FROM inventory_keys k JOIN inventory_attempts a ON a.generation_id=k.generation_id
  WHERE k.generation_id=$1 AND (a.channel<>'exact' OR
    NOT EXISTS(SELECT 1 FROM inventory_exact_heads h JOIN inventory_roots r ON r.scope_id=h.scope_id
      AND r.observation_epoch=h.observation_epoch WHERE r.baseline_id=$2 AND h.identity=k.identity COLLATE "default" AND h.read_started_at>a.read_started_at)
    AND NOT EXISTS(SELECT 1 FROM inventory_roots r WHERE r.baseline_id=$2 AND r.catalog_observed_at>a.read_started_at))`;
const newerInventoryKeys = (baseline: string, revision: string, observed: string) =>
  `SELECT h.identity,coalesce(m.generation_id,k.generation_id) AS generation_id,k.deleted
  FROM inventory_exact_heads h JOIN inventory_keys k ON k.generation_id=h.generation_id AND k.identity=h.identity
  JOIN inventory_roots r ON r.baseline_id=${baseline} AND r.scope_id=h.scope_id AND r.observation_epoch=h.observation_epoch
  LEFT JOIN inventory_memberships m ON m.baseline_id=r.baseline_id AND m.identity=h.identity
    AND m.valid_from_revision<=${revision} AND (m.valid_to_revision IS NULL OR m.valid_to_revision>${revision})
  WHERE h.read_started_at>${observed}`;

export class InventoryGenerations {
  readonly generations: DataGenerations;
  maximumParameterBytes = 0;
  constructor(readonly database: pg.Pool) { this.generations = new DataGenerations(database); }

  private async collectionScope(client: pg.PoolClient, scopeId: string, tenantId: string) {
    const scope = (await client.query("SELECT principal_id FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2", [scopeId, tenantId])).rows[0];
    if (!scope) throw new Error("inventory_scope_unavailable");
    const acquired = (await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
      [`data-sync:${tenantId}:${scope.principal_id}`])).rows[0].acquired;
    if (!acquired) return false;
    return (await client.query("SELECT id FROM data_scope_epochs WHERE id=$1 AND tenant_id=$2 FOR UPDATE SKIP LOCKED",
      [scopeId,tenantId])).rowCount === 1;
  }
  private collectionTransaction<T>(work: (client: pg.PoolClient) => Promise<T>, client?: pg.PoolClient) {
    return client ? work(client) : this.generations.connections.run(work);
  }

  async fence(client: pg.PoolClient, lease: GenerationLease) {
    const generation = await this.generations.fence(client, lease);
    const abandoned = await client.query(`SELECT 1 FROM inventory_attempts a WHERE a.generation_id=$1 AND a.domain='canonical'
      AND a.mode<>'compact' AND NOT EXISTS(SELECT 1 FROM inventory_reconciliation c WHERE c.scope_id=a.scope_id
        AND c.active_id=$2 AND c.active_until>clock_timestamp())`, [lease.id, generation.job_id]);
    if (abandoned.rowCount) throw new Error("inventory_reconciliation_fenced");
    return generation;
  }

  async execute(input: BeginGeneration, intent: InventoryIntent,
    work: (lease: GenerationLease, signal: AbortSignal) => Promise<void>,
    options: { signal?: AbortSignal; authorize: (signal: AbortSignal) => Promise<void>; completeJob?: Completion;
      validateInputs?: (client: pg.PoolClient) => Promise<void>; afterPublish?: (client: pg.PoolClient, root: InventoryRoot) => Promise<void>;
      commitPublication?: (operation: () => Promise<void>) => Promise<void> }) {
    if (input.scope.kind !== "principal" || input.scope.source !== `inventory_${intent.domain}` || input.schemaVersion !== 1) throw new Error("inventory_scope");
    if (input.scope.selector !== inventorySelector(intent)) throw new Error("inventory_selector");
    if (intent.domain !== "canonical" && intent.mode === "delta" && !intent.targetJobId && (!intent.targets?.length || intent.targets.length > 100
      || new Set(intent.targets).size !== intent.targets.length)) throw new Error("inventory_exact_targets");
    if (intent.targetJobId && (intent.domain !== "packages" || !["exact", "detail"].includes(intent.channel) || intent.targetJobId !== input.jobId || intent.targets)) {
      throw new Error("inventory_exact_targets");
    }
    const deadline = intent.domain === "packages" ? inventoryLimits.graphDeadlineMs : inventoryLimits.powerPlatformDeadlineMs;
    if (input.deadlineAt.getTime() - Date.now() > deadline) throw dataLimitError("inventory_deadline", deadline, input.deadlineAt.getTime() - Date.now());
    if (input.jobKind !== "fixture" && !options.completeJob) throw new Error("data_job_completion_required");
    await options.authorize(options.signal ?? new AbortController().signal);
    if (options.validateInputs) await this.generations.connections.run(options.validateInputs);
    return this.generations.execute(input, async (lease, signal) => {
      const prepareMembership = await this.generations.connections.run(async client => {
        await this.fence(client, lease);
        const root = (await client.query(`SELECT r.* FROM inventory_roots r JOIN inventory_revisions v
          ON v.scope_id=r.scope_id AND v.revision=r.revision JOIN data_generations g ON g.id=v.generation_id
          WHERE r.scope_id=$1 AND r.current AND g.session_epoch=$3 AND g.expires_at>clock_timestamp()
            AND (g.scope_epoch=$2 OR $4='control')
          FOR UPDATE OF r`, [lease.scopeId, lease.epoch, lease.sessionEpoch, intent.channel])).rows[0];
        if (intent.mode === "delta" && !root && ["detail", "control"].includes(intent.channel)) throw new Error("inventory_baseline_required");
        await client.query(`INSERT INTO inventory_attempts(generation_id,scope_id,tenant_id,domain,mode,channel,baseline_id,base_revision,
          read_started_at,environment_id,resource_types,exact_targets,target_job_id,role_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [lease.id, lease.scopeId, lease.tenantId, intent.domain, intent.mode, intent.channel, root?.baseline_id ?? null,
          root?.revision ?? "0", input.observedAt, intent.environmentId ?? null, intent.resourceTypes ?? [], intent.targets ?? [], intent.targetJobId ?? null,
          intent.roleScope ?? "unknown"]);
        return intent.mode!=="delta" || !root;
      });
      if (options.validateInputs) await this.generations.connections.run(options.validateInputs);
      await work(lease, signal);
      signal.throwIfAborted();
      await this.validate(lease);
      if (prepareMembership) await this.prepareBaseline(lease);
      await options.authorize(signal);
      let result!: InventoryRoot & { inserted: number; closed: number; changed: number };
      const publish = async () => { await this.generations.publish(lease, {
        validateInputs: options.validateInputs,
        completeJob: async (client, completion) => {
          result = await this.publishMembership(client, lease);
          await options.afterPublish?.(client, result);
          await options.completeJob?.(client, completion);
        },
      }); };
      // Account serialization precedes database locks; completion must not
      // acquire that account queue from inside a locked publication transaction.
      if (options.commitPublication) await options.commitPublication(publish);
      else await publish();
      return result;
    }, options.signal, options.validateInputs);
  }

  async visit(lease: GenerationLease, token: string) {
    return this.generations.connections.run(async client => {
      const generation = await this.fence(client, lease);
      if (generation.state !== "staging") throw new Error("data_not_staging");
      const previous = (await client.query("SELECT * FROM inventory_pages WHERE generation_id=$1 ORDER BY ordinal DESC LIMIT 1", [lease.id])).rows[0];
      const ordinal = (previous?.ordinal ?? 0) + 1;
      if (ordinal > inventoryLimits.pages) throw dataLimitError("provider_page_limit", inventoryLimits.pages, ordinal);
      if (previous && (!previous.accepted || previous.next_hash !== digest(token))) throw new Error("inventory_continuation");
      await client.query(`INSERT INTO inventory_pages(generation_id,scope_id,tenant_id,ordinal,token_hash)
        VALUES($1,$2,$3,$4,$5)`, [lease.id, lease.scopeId, lease.tenantId, ordinal, digest(token)]);
    });
  }

  clear(scopeId: string, tenantId: string) {
    return this.generations.invalidate(scopeId, tenantId, async client => {
      await client.query("UPDATE inventory_roots SET current=false WHERE scope_id=$1 AND tenant_id=$2 AND current", [scopeId, tenantId]);
    });
  }

  async acceptPage<T>(lease: GenerationLease, page: InventoryPage<T>, inserted: number) {
    const omitted = page.omittedFieldCount ?? 0;
    if (!Number.isSafeInteger(page.rawCount) || page.rawCount < 0 || !Number.isSafeInteger(inserted)
      || inserted < 0 || inserted > page.rawCount || inserted !== page.records.length
      || !Number.isSafeInteger(omitted) || omitted < 0) throw new Error("inventory_page_count");
    return this.generations.connections.run(async client => {
      const generation = await this.fence(client, lease);
      if (page.expectedCount !== null && (!Number.isSafeInteger(page.expectedCount) || page.expectedCount < 0 || page.expectedCount > inventoryLimits.sourceRows)) {
        throw dataLimitError("inventory_source_rows", inventoryLimits.sourceRows, page.expectedCount);
      }
      const previous = (await client.query("SELECT expected_count,omitted_fields FROM inventory_attempts WHERE generation_id=$1 FOR UPDATE", [lease.id])).rows[0];
      if (previous.expected_count !== null && page.expectedCount !== null && previous.expected_count !== page.expectedCount) throw new Error("inventory_count_mismatch");
      if (previous.omitted_fields + omitted > 2_147_483_647) {
        throw dataLimitError("inventory_omitted_fields", 2_147_483_647, previous.omitted_fields + omitted);
      }
      if (generation.wire_count + page.rawCount > inventoryLimits.wireRows) throw dataLimitError("inventory_wire_rows", inventoryLimits.wireRows, generation.wire_count + page.rawCount);
      const result = await client.query(`UPDATE inventory_pages SET accepted=true,raw_count=$4,unique_count=$5,next_hash=$6,expected_count=$7
        WHERE generation_id=$1 AND ordinal=$2 AND token_hash=$3 AND NOT accepted`,
      [lease.id, page.page, digest(page.token), page.rawCount, inserted, page.nextToken === null ? null : digest(page.nextToken), page.expectedCount]);
      if (result.rowCount !== 1) throw new Error("inventory_page_order");
      await client.query("UPDATE inventory_attempts SET expected_count=coalesce(expected_count,$2),omitted_fields=omitted_fields+$3 WHERE generation_id=$1",
        [lease.id, page.expectedCount, omitted]);
      await client.query("UPDATE data_generations SET page_count=page_count+1,wire_count=wire_count+$2 WHERE id=$1", [lease.id, page.rawCount]);
    });
  }

  async append(lease: GenerationLease, rows: readonly InventoryRecord[], ordinal?: number) {
    if (rows.some(row => row.facts.some(fact => ["presence", "linkState", "availability", "management"].includes(fact.kind)))) {
      throw new Error("inventory_scalar_fact_retired");
    }
    const normalized = rows.map(row => ({ ...row, facts: undefined, content_hash: digest(JSON.stringify([lease.id, row])), schema_version: 1 }));
    const batch = encodeBatch(normalized, [lease.id, lease.scopeId, lease.tenantId]);
    this.maximumParameterBytes = Math.max(this.maximumParameterBytes, batch.bytes);
    return this.generations.connections.run(async client => {
      const generation = await this.fence(client, lease);
      if (generation.state !== "staging") throw new Error("data_not_staging");
      const attempt = (await client.query("SELECT * FROM inventory_attempts WHERE generation_id=$1", [lease.id])).rows[0];
      for (const row of rows) {
        if (attempt.domain !== "canonical" && attempt.mode === "delta"
          && !(attempt.target_job_id ? (await client.query("SELECT 1 FROM inventory_refresh_targets WHERE job_id=$1 AND target_id=$2",
            [attempt.target_job_id, row.native_id])).rowCount : attempt.exact_targets.includes(row.native_id))) throw new Error("inventory_exact_target_mismatch");
        if (attempt.domain === "power_platform" && (normalizeNativeIdentity(String(row.residual.tenantId ?? "")) !== normalizeNativeIdentity(lease.tenantId)
          || attempt.environment_id && normalizeNativeIdentity(row.environment_id ?? "").toLowerCase() !== attempt.environment_id.toLowerCase()
          || !attempt.resource_types.includes(row.resource_type))) throw new Error("inventory_resource_scope");
      }
      const index = ordinal ?? generation.batch_count;
      const hash = digest(JSON.stringify(rows));
      const previous = (await client.query("SELECT digest FROM data_generation_batches WHERE generation_id=$1 AND ordinal=$2", [lease.id, index])).rows[0];
      if (previous) {
        if (previous.digest !== hash) throw new Error("data_batch_replay_conflict");
        return { rows: 0, bytes: 0, replay: true };
      }
      if (index !== generation.batch_count) throw new Error("data_batch_order");
      const limit = attempt.domain === "canonical" ? dataLimits.derivedRows : inventoryLimits.sourceRows;
      if (generation.row_count + rows.length > limit) throw dataLimitError("inventory_source_rows", limit, generation.row_count + rows.length);
      await assertResidualDatabaseBounds(client, batch.json, "residual", rows);
      await client.query(`INSERT INTO inventory_keys(generation_id,scope_id,tenant_id,identity,schema_version,content_hash,deleted)
        SELECT $1,$2,$3,identity,1,content_hash,coalesce(deleted,false) FROM jsonb_to_recordset($4::jsonb) r(identity text,content_hash text,deleted boolean)`,
      [lease.id, lease.scopeId, lease.tenantId, batch.json]);
      const table = inventoryTables[attempt.domain as InventoryDomain];
      await client.query(`INSERT INTO ${table}(generation_id,scope_id,tenant_id,identity,schema_version,content_hash,display_name,sort_key,
        native_id,environment_id,resource_type,publisher,modified_at,observed_at,expires_at,read_started_at,residual,
        catalog_generation,detail_generation,control_generation,identity_expires_at,presence,link_state,availability,management)
        SELECT $1,$2,$3,r.identity,1,r.content_hash,r.display_name,r.sort_key,r.native_id,r.environment_id,r.resource_type,r.publisher,
          r.modified_at,coalesce(r.observed_at,g.observed_at),coalesce(r.expires_at,g.expires_at),coalesce(r.read_started_at,a.read_started_at),r.residual,
          coalesce(r.catalog_generation,CASE WHEN a.channel IN ('catalog','exact') THEN $1 END),
          coalesce(r.detail_generation,CASE WHEN a.channel IN ('exact','detail') THEN $1 END),
          coalesce(r.control_generation,CASE WHEN a.channel='control' THEN $1 END),r.identity_expires_at,
          r.presence,r.link_state,r.availability,r.management
        FROM jsonb_to_recordset($4::jsonb) r(identity text,content_hash text,deleted boolean,display_name text,sort_key text,native_id text,
          environment_id text,resource_type text,publisher text,modified_at timestamptz,residual jsonb,
          catalog_generation uuid,detail_generation uuid,control_generation uuid,read_started_at timestamptz,observed_at timestamptz,expires_at timestamptz,
          identity_expires_at timestamptz,presence text,link_state text,availability text,management text)
        JOIN data_generations g ON g.id=$1 JOIN inventory_attempts a ON a.generation_id=g.id WHERE NOT coalesce(r.deleted,false)`,
      [lease.id, lease.scopeId, lease.tenantId, batch.json]);
      let bytes = batch.bytes;
      let children = 0;
      type Fact = InventoryRecord["facts"][number] & { identity: string; ordinal: number };
      let pendingFacts: Fact[] = [];
      const factParameters = [lease.id, lease.scopeId, lease.tenantId];
      const emptyFactBytes = encodeBatch([], factParameters).bytes;
      let pendingFactBytes = emptyFactBytes;
      const flushFacts = async () => {
        if (!pendingFacts.length) return;
        const facts = encodeBatch(pendingFacts, factParameters);
        this.maximumParameterBytes = Math.max(this.maximumParameterBytes, facts.bytes);
        await assertResidualDatabaseBounds(client, facts.json, "payload", pendingFacts);
        await client.query(`INSERT INTO inventory_facts(generation_id,scope_id,tenant_id,identity,schema_version,ordinal,kind,value,payload,text_value,number_value,boolean_value)
          SELECT $1,$2,$3,identity,1,ordinal,kind,value,payload,text_value,number_value,boolean_value FROM jsonb_to_recordset($4::jsonb)
          r(identity text,ordinal integer,kind text,value text,payload jsonb,text_value text,number_value numeric,boolean_value boolean)`,
        [...factParameters, facts.json]);
        bytes += facts.bytes;
        children += pendingFacts.length;
        pendingFacts = [];
        pendingFactBytes = emptyFactBytes;
      };
      for (const row of rows) {
        if (row.facts.length > inventoryLimits.factsPerRecord) throw dataLimitError("inventory_facts", inventoryLimits.factsPerRecord, row.facts.length);
        for (let ordinal = 0; ordinal < row.facts.length; ordinal++) {
          const fact = { ...row.facts[ordinal], identity: row.identity, ordinal };
          const factBytes = Buffer.byteLength(JSON.stringify(fact));
          if (pendingFacts.length === dataLimits.batchRows
            || pendingFactBytes + factBytes + Number(pendingFacts.length > 0) > dataLimits.batchBytes) {
            await flushFacts();
          }
          if (emptyFactBytes + factBytes > dataLimits.batchBytes) encodeBatch([fact], factParameters);
          pendingFactBytes += factBytes + Number(pendingFacts.length > 0);
          pendingFacts.push(fact);
        }
        if (row.factSource) {
          const source = row.factSource;
          if (source.identity !== row.identity || source.kinds.length > 20
            || !(await client.query(`SELECT 1 FROM inventory_memberships m WHERE ${inventoryAsOf()}
              AND identity=$3 AND generation_id=$4 AND scope_id=$5`,
            [attempt.baseline_id, attempt.base_revision, source.identity, source.generationId, lease.scopeId])).rowCount) {
            throw new Error("inventory_fact_source_invalid");
          }
          let after = -1, copied = 0;
          for (;;) {
            const result = (await client.query(`WITH candidates AS (
              SELECT f.ordinal AS source_ordinal,f.kind,f.value,f.payload,f.text_value,f.number_value,f.boolean_value
              FROM inventory_facts f WHERE f.generation_id=$5 AND f.identity=$6 AND f.ordinal>$7
                AND f.kind NOT IN ('presence','linkState','availability','management')
                AND ('*'=ANY($8::text[]) OR f.kind=ANY($8::text[]) OR 'detail:*'=ANY($8::text[]) AND f.kind LIKE 'detail:%')
                AND (f.kind<>'collection' OR NOT f.value=ANY($9::text[]))
                AND (f.kind<>'collection' OR $11::text[] IS NULL OR f.value=ANY($11::text[]))
              ORDER BY f.ordinal LIMIT 250
            ), sized AS (SELECT *,row_number() OVER(ORDER BY source_ordinal) AS position,
              octet_length(row_to_json(candidates)::text) AS row_bytes,
              sum(octet_length(row_to_json(candidates)::text)) OVER(ORDER BY source_ordinal) AS page_bytes FROM candidates),
            chosen AS (SELECT * FROM sized WHERE page_bytes<=1048576 OR position=1),
            inserted AS (INSERT INTO inventory_facts(generation_id,scope_id,tenant_id,identity,schema_version,ordinal,kind,value,payload,text_value,number_value,boolean_value)
              SELECT $1,$2,$3,$4,1,$10::int+position-1,kind,value,payload,text_value,number_value,boolean_value FROM chosen RETURNING ordinal)
            SELECT (SELECT count(*)::int FROM inserted) AS count,max(source_ordinal)::int AS last,
              coalesce(sum(row_bytes),0)::text AS bytes FROM chosen`,
            [lease.id, lease.scopeId, lease.tenantId, row.identity, source.generationId, source.identity, after, source.kinds,
              source.excludeCollections ?? [], row.facts.length + copied, source.includeCollections ?? null])).rows[0];
            const copiedBytes = exactCount(result.bytes);
            if (copiedBytes > 1_048_576) throw dataLimitError("inventory_fact_batch_bytes", 1_048_576, copiedBytes);
            if (!result.count) break;
            after = result.last; copied += result.count; bytes += copiedBytes; children += result.count;
            if (row.facts.length + copied > inventoryLimits.factsPerRecord) {
              throw dataLimitError("inventory_facts", inventoryLimits.factsPerRecord, row.facts.length + copied);
            }
          }
        }
      }
      await flushFacts();
      if (exactCount(generation.byte_count) + bytes > exactCount(generation.reserved_bytes)) throw dataLimitError("data_generation_bytes", exactCount(generation.reserved_bytes), exactCount(generation.byte_count) + bytes);
      await client.query(`INSERT INTO data_generation_batches(generation_id,scope_id,tenant_id,ordinal,digest,row_count,parameter_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [lease.id, lease.scopeId, lease.tenantId, index, hash, rows.length, batch.bytes]);
      await client.query(`UPDATE data_generations SET row_count=row_count+$2,child_count=child_count+$3,byte_count=byte_count+$4,
        batch_count=batch_count+1,content_hash=encode(sha256(convert_to(coalesce(content_hash,'')||$5,'UTF8')),'hex') WHERE id=$1`,
      [lease.id, rows.length, children, bytes, hash]);
      return { rows: rows.length, bytes, replay: false };
    }).catch(async error => { await this.generations.abort(lease); throw error; });
  }

  async appendBounded(lease: GenerationLease, rows: readonly InventoryRecord[]) {
    let offset = 0;
    while (offset < rows.length) {
      let end = Math.min(offset + 250, rows.length);
      while (end > offset + 1 && Buffer.byteLength(JSON.stringify(rows.slice(offset, end))) > 900_000) end = offset + Math.floor((end - offset) / 2);
      await this.append(lease, rows.slice(offset, end)); offset = end;
    }
  }

  async validate(lease: GenerationLease) {
    await this.generations.connections.run(async client => {
      const g = await this.fence(client, lease);
      const a = (await client.query("SELECT * FROM inventory_attempts WHERE generation_id=$1", [lease.id])).rows[0];
      const pages = (await client.query(`SELECT count(*)::int AS count,coalesce(bool_and(accepted),true) AS accepted,
        coalesce(sum(unique_count),0)::int AS unique_count,coalesce(sum(raw_count),0)::int AS raw_count
        FROM inventory_pages WHERE generation_id=$1`, [lease.id])).rows[0];
      const last = (await client.query("SELECT next_hash FROM inventory_pages WHERE generation_id=$1 ORDER BY ordinal DESC LIMIT 1", [lease.id])).rows[0];
      if (last?.next_hash || !pages.accepted || pages.count && (pages.unique_count !== g.row_count || pages.raw_count !== g.wire_count)
        || a.expected_count !== null && a.expected_count !== g.row_count
        || a.mode === "baseline" && a.channel !== "canonical" && !pages.count) throw new Error("inventory_incomplete");
      const targetCount = a.target_job_id
        ? (await client.query("SELECT count(*)::int AS count FROM inventory_refresh_targets WHERE job_id=$1", [a.target_job_id])).rows[0].count
        : a.exact_targets.length;
      if (a.domain !== "canonical" && a.mode === "delta" && (!targetCount || targetCount !== g.row_count)) throw new Error("inventory_exact_incomplete");
      await client.query(`UPDATE inventory_attempts SET complete=true WHERE generation_id=$1`, [lease.id]);
      await client.query(`UPDATE data_generations SET state='validating',validated=true,validation_phase='complete',
        validated_rows=row_count,validated_children=child_count,content_hash=coalesce(content_hash,encode(sha256(''::bytea),'hex')) WHERE id=$1`, [lease.id]);
    });
  }

  private async createPreparedRoot(client: pg.PoolClient,lease: GenerationLease,a: pg.QueryResultRow,
    olderCatalog: boolean,observationEpoch: string) {
    await client.query(`INSERT INTO inventory_roots(baseline_id,scope_id,tenant_id,domain,first_revision,revision,row_count,current,
      catalog_observed_at,catalog_expires_at,catalog_complete,observation_epoch,catalog_page_count,catalog_omitted_fields)
      VALUES($1,$2,$3,$4,$5,$5,0,false,
        CASE WHEN $6 THEN $7::timestamptz ELSE (SELECT catalog_observed_at FROM inventory_roots WHERE baseline_id=$8) END,
        CASE WHEN $6 THEN (SELECT expires_at FROM data_generations WHERE id=$1) ELSE (SELECT catalog_expires_at FROM inventory_roots WHERE baseline_id=$8) END,
        $6 OR coalesce((SELECT catalog_complete FROM inventory_roots WHERE baseline_id=$8),false),$9,
        CASE WHEN $6 THEN (SELECT page_count FROM data_generations WHERE id=$1)
          ELSE coalesce((SELECT catalog_page_count FROM inventory_roots WHERE baseline_id=$8),0) END,
        CASE WHEN $6 THEN (SELECT omitted_fields FROM inventory_attempts WHERE generation_id=$1)
          ELSE coalesce((SELECT catalog_omitted_fields FROM inventory_roots WHERE baseline_id=$8),0) END)
      ON CONFLICT(baseline_id) DO NOTHING`,
    [lease.id,lease.scopeId,lease.tenantId,a.domain,(BigInt(lease.expectedRevision)+1n).toString(),
      a.mode==="baseline" && a.channel==="catalog" && !olderCatalog,a.read_started_at,a.baseline_id,observationEpoch]);
  }

  private async prepareBaseline(lease: GenerationLease) {
    const prepared = await this.generations.connections.run(async client => {
      await this.fence(client,lease);
      const a = (await client.query("SELECT * FROM inventory_attempts WHERE generation_id=$1",[lease.id])).rows[0];
      if (a.mode==="delta" && a.baseline_id!==null || a.membership_prepared) return undefined;
      const prior = a.baseline_id
        ? (await client.query("SELECT * FROM inventory_roots WHERE baseline_id=$1",[a.baseline_id])).rows[0] : undefined;
      const olderCatalog = a.domain!=="canonical" && a.mode==="baseline" && prior?.catalog_observed_at
        && a.read_started_at<prior.catalog_observed_at;
      await this.createPreparedRoot(client,lease,a,Boolean(olderCatalog),prior?.observation_epoch ?? lease.epoch);
      return { a,olderCatalog: Boolean(olderCatalog) };
    });
    if (!prepared) return;
    const { a,olderCatalog } = prepared,revision = (BigInt(lease.expectedRevision)+1n).toString();
    let changedCount = 0;
    const phases = olderCatalog ? ["prior"] : a.mode==="compact" ? ["compact"]
      : a.domain==="canonical" ? ["own"] : ["own","newer"];
    for (const phase of phases) {
      let after = "";
      for (;;) {
        const page = await this.generations.connections.run(async client => {
          await this.fence(client,lease);
          await client.query("SET LOCAL jit=off");
          let rows: pg.QueryResultRow[],last: string | undefined;
          if (phase==="own") {
            const keys = (await client.query(`SELECT identity FROM inventory_keys
              WHERE generation_id=$1 AND identity>$2 ORDER BY identity LIMIT 250`,[lease.id,after])).rows;
            last = keys.at(-1)?.identity;
            if (!keys.length) return { count: 0,last,changed: 0 };
            const newer = a.domain!=="canonical";
            rows = (await client.query(`SELECT k.identity,k.generation_id FROM (${acceptedInventoryKeys}) k
              WHERE NOT k.deleted AND k.identity COLLATE "C"=ANY($3::text[])
              ${newer ? `AND NOT EXISTS(SELECT 1 FROM (${newerInventoryKeys("$4","$5","$6")}) newer WHERE newer.identity=k.identity)` : ""}`,
            newer ? [lease.id,lease.id,keys.map(row => row.identity),a.baseline_id,a.base_revision,a.read_started_at]
              : [lease.id,lease.id,keys.map(row => row.identity)])).rows;
          } else if (phase==="newer") {
            const candidates = (await client.query(`SELECT * FROM (${newerInventoryKeys("$1","$2","$3")}) newer
              WHERE identity>$4 ORDER BY identity LIMIT 250`,[a.baseline_id,a.base_revision,a.read_started_at,after])).rows;
            last = candidates.at(-1)?.identity;
            rows = candidates.filter(row => !row.deleted).map(row => ({ identity: row.identity,generation_id: row.generation_id }));
          } else {
            rows = phase==="prior"
              ? (await client.query(`SELECT identity,generation_id FROM inventory_memberships m
                WHERE ${inventoryAsOf()} AND identity>$3 ORDER BY identity LIMIT 250`,[a.baseline_id,a.base_revision,after])).rows
              : (await client.query(`SELECT identity,source_generation_id AS generation_id FROM inventory_compaction_refs
                WHERE generation_id=$1 AND identity>$2 ORDER BY identity LIMIT 250`,[lease.id,after])).rows;
            last = rows.at(-1)?.identity;
          }
          let changed = 0;
          if (rows.length) {
            changed = phase==="own" ? rows.length : phase==="compact" ? 0
              : exactCount((await client.query(`SELECT count(*)::int AS count FROM inventory_keys
                WHERE generation_id=$1 AND identity=ANY($2::text[])`,[lease.id,rows.map(row => row.identity)])).rows[0].count);
            const batch = encodeBatch(rows,[lease.id,lease.scopeId,lease.tenantId,revision]);
            this.maximumParameterBytes = Math.max(this.maximumParameterBytes,batch.bytes);
            const inserted = (await client.query(`INSERT INTO inventory_memberships(
                baseline_id,scope_id,tenant_id,identity,valid_from_revision,generation_id)
              SELECT $1,$2,$3,identity,$4,generation_id
              FROM jsonb_to_recordset($5::jsonb) member(identity text,generation_id uuid)
              ON CONFLICT DO NOTHING`,[lease.id,lease.scopeId,lease.tenantId,revision,batch.json])).rowCount ?? 0;
            const count = exactCount((await client.query("SELECT row_count FROM inventory_roots WHERE baseline_id=$1",[lease.id])).rows[0].row_count)+inserted;
            const limit = a.domain==="canonical" ? dataLimits.derivedRows : inventoryLimits.sourceRows;
            if (count>limit) throw dataLimitError("inventory_effective_rows",limit,count);
            await client.query("UPDATE inventory_roots SET row_count=$2 WHERE baseline_id=$1",[lease.id,count]);
          }
          return { count: last ? 1 : 0,last,changed };
        });
        changedCount += page.changed;
        if (!page.count) break;
        after = page.last!;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    await this.generations.connections.run(async client => {
      await this.fence(client,lease);
      await client.query("SET LOCAL jit=off");
      await client.query(`UPDATE inventory_attempts SET membership_prepared=true,prepared_changed_count=$2
        WHERE generation_id=$1`,[lease.id,changedCount]);
    });
  }

  private async publishMembership(client: pg.PoolClient, lease: GenerationLease) {
    await client.query("SET LOCAL jit=off");
    const a = (await client.query("SELECT * FROM inventory_attempts WHERE generation_id=$1", [lease.id])).rows[0];
    const revision = (BigInt(lease.expectedRevision) + 1n).toString();
    const broad = a.mode !== "delta" || a.baseline_id === null;
    const baseline = broad ? lease.id : a.baseline_id;
    const priorRoot = a.baseline_id
      ? (await client.query("SELECT * FROM inventory_roots WHERE baseline_id=$1", [a.baseline_id])).rows[0] : undefined;
    const observationEpoch = priorRoot?.observation_epoch ?? lease.epoch;
    if (broad) {
      if (!a.membership_prepared) throw new Error("inventory_membership_not_prepared");
      await client.query("UPDATE inventory_roots SET current=false WHERE scope_id=$1 AND current", [lease.scopeId]);
      const root = (await client.query(`UPDATE inventory_roots SET current=true
        WHERE baseline_id=$1 AND scope_id=$2 AND NOT current AND revision=$3 RETURNING row_count,observation_epoch`,
      [baseline,lease.scopeId,revision])).rows[0];
      if (!root) throw new Error("inventory_prepared_root_fenced");
      await this.publishExactHeads(client,lease,a,baseline,root.observation_epoch);
      return this.finishPublication(client,lease,baseline,revision,root.row_count,0,a.prepared_changed_count,root.row_count);
    }
    if ((await client.query("SELECT baseline_id FROM inventory_roots WHERE baseline_id=$1 AND current AND revision=$2 FOR UPDATE",
      [baseline, a.base_revision])).rowCount !== 1) throw new Error("inventory_head_conflict");
    const accepted = acceptedInventoryKeys;
    // Keep every delta lookup parameterized, including the final update. The
    // scope publication lock keeps these current-interval tuple IDs stable.
    const changed = `WITH staged AS MATERIALIZED (${accepted})
      SELECT k.identity,k.deleted,m.membership_tid FROM staged k
      LEFT JOIN LATERAL (SELECT generation_id,identity,ctid AS membership_tid FROM inventory_memberships m
        WHERE m.baseline_id=$2 AND m.identity=k.identity AND m.valid_to_revision IS NULL OFFSET 0) m ON true
      LEFT JOIN LATERAL (SELECT content_hash FROM inventory_keys old
        WHERE old.generation_id=m.generation_id AND old.identity=m.identity OFFSET 0) old ON true
      LEFT JOIN LATERAL (SELECT read_started_at FROM inventory_records prior
        WHERE prior.generation_id=m.generation_id AND prior.identity=m.identity OFFSET 0) prior ON true
      JOIN inventory_attempts attempt ON attempt.generation_id=k.generation_id
      WHERE k.generation_id=$1 AND (old.content_hash IS DISTINCT FROM k.content_hash OR k.deleted)
      AND (attempt.channel='detail' OR prior.read_started_at IS NULL OR prior.read_started_at<=attempt.read_started_at)`;
    const closed = (await client.query(`WITH changed AS MATERIALIZED (${changed})
      UPDATE inventory_memberships m SET valid_to_revision=$3 FROM changed k WHERE m.ctid=k.membership_tid`,
    [lease.id, baseline, revision])).rowCount ?? 0;
    const inserted = (await client.query(`INSERT INTO inventory_memberships(baseline_id,scope_id,tenant_id,identity,valid_from_revision,generation_id)
      SELECT $2,$4,$5,k.identity,$3,$1 FROM (${accepted}) k WHERE NOT k.deleted
      AND NOT EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.baseline_id=$2 AND m.identity=k.identity
        AND m.valid_to_revision IS NULL LIMIT 1 OFFSET 0)`,
    [lease.id, baseline, revision, lease.scopeId, lease.tenantId])).rowCount ?? 0;
    await this.publishExactHeads(client,lease,a,baseline,observationEpoch);
    const changedIdentities = `SELECT $2::uuid,$3::text,$4::bigint,k.identity FROM inventory_keys k WHERE k.generation_id=$1 AND (
        EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.baseline_id=$5 AND m.identity=k.identity COLLATE "default"
          AND (m.valid_from_revision=$4 OR m.valid_to_revision=$4) LIMIT 1 OFFSET 0))`;
    const changes = (await client.query(`INSERT INTO inventory_changes(scope_id,tenant_id,revision,identity)
        ${changedIdentities} ON CONFLICT DO NOTHING`,
      [lease.id, lease.scopeId, lease.tenantId, revision, baseline])).rowCount ?? 0;
    const priorCount = exactCount((await client.query("SELECT row_count FROM inventory_roots WHERE baseline_id=$1", [baseline])).rows[0].row_count);
    const effectiveCount = priorCount + inserted - closed;
    const effectiveLimit = a.domain === "canonical" ? dataLimits.derivedRows : inventoryLimits.sourceRows;
    if (effectiveCount > effectiveLimit) throw dataLimitError("inventory_effective_rows", effectiveLimit, effectiveCount);
    return this.finishPublication(client,lease,baseline,revision,inserted,closed,changes,effectiveCount);
  }

  private async publishExactHeads(client: pg.PoolClient,lease: GenerationLease,a: pg.QueryResultRow,baseline: string,epoch: string) {
    if (a.channel==="exact") await client.query(`INSERT INTO inventory_exact_heads(scope_id,tenant_id,observation_epoch,identity,generation_id,read_started_at)
      SELECT $3,$4,$5,k.identity,$1,$6 FROM (${acceptedInventoryKeys}) k
      ON CONFLICT(scope_id,observation_epoch,identity) DO UPDATE SET generation_id=excluded.generation_id,read_started_at=excluded.read_started_at`,
    [lease.id,baseline,lease.scopeId,lease.tenantId,epoch,a.read_started_at]);
  }

  private async finishPublication(client: pg.PoolClient,lease: GenerationLease,baseline: string,revision: string,
    inserted: number,closed: number,changes: number,effectiveCount: number) {
    await client.query(`UPDATE inventory_roots SET revision=$2,row_count=$3 WHERE baseline_id=$1`, [baseline, revision, effectiveCount]);
    await client.query(`INSERT INTO inventory_revisions(scope_id,tenant_id,revision,baseline_id,generation_id,inputs,row_count)
      VALUES($1,$2,$3,$4,$5,coalesce((SELECT active_inputs FROM inventory_reconciliation WHERE scope_id=$1),'[]'::jsonb),
        (SELECT row_count FROM inventory_roots WHERE baseline_id=$4))`,
    [lease.scopeId, lease.tenantId, revision, baseline, lease.id]);
    return { scopeId: lease.scopeId, tenantId: lease.tenantId, baselineId: baseline as string, revision, epoch: lease.epoch,
      inserted, closed, changed: changes };
  }

  async gc(root: InventoryRoot) {
    return (await this.gcSlice(root)).removed;
  }
  async gcSlice(root: InventoryRoot, databaseClient?: pg.PoolClient) {
    return this.collectionTransaction(async client => {
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      if (!await this.collectionScope(client, root.scopeId, root.tenantId)) return { rows: 0,removed: 0,bytes: 0 };
      const inherited = (await client.query(`SELECT min(revision)::text AS revision FROM (${retainedInputs()}) inputs`,
        [root.baselineId, root.scopeId])).rows[0].revision;
      const floor = (await client.query(`SELECT least(r.revision,coalesce($2::bigint,r.revision),
        coalesce((SELECT min(p.revision) FROM data_generation_pins p WHERE p.generation_id=r.baseline_id AND p.expires_at>clock_timestamp()),r.revision),
        coalesce((SELECT min(p.revision) FROM inventory_worker_pins p WHERE p.baseline_id=r.baseline_id AND p.expires_at>clock_timestamp()),r.revision))::text AS revision,
        r.current OR $2::bigint IS NOT NULL
          OR EXISTS(SELECT 1 FROM data_generations g WHERE g.id=r.baseline_id AND g.state IN ('staging','validating'))
          OR EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=r.baseline_id AND p.expires_at>clock_timestamp())
          OR EXISTS(SELECT 1 FROM inventory_worker_pins p WHERE p.baseline_id=r.baseline_id AND p.expires_at>clock_timestamp()) AS protected
        FROM inventory_roots r WHERE baseline_id=$1`, [root.baselineId, inherited])).rows[0];
      if (!floor) return { rows: 0, removed: 0, bytes: 0 };
      // Separate the two eligible ranges so current roots use the closed-interval
      // index and retired roots use their primary key, without sorting N members.
      const eligible = floor.protected ? "AND valid_to_revision<=$4" : "";
      const order = floor.protected ? "valid_to_revision,identity" : "identity,valid_from_revision";
      await client.query(`SELECT set_config('agent_control.inventory_gc_cursor_rows','0',true),
        set_config('agent_control.inventory_gc_cursor_bytes','0',true)`);
      const removed = (await client.query(`WITH candidates AS MATERIALIZED (SELECT baseline_id,identity,valid_from_revision,
          m.ctid AS member_tid,octet_length(row_to_json(m)::text) AS bytes,
          octet_length(jsonb_build_object('scope_id',$2::uuid,'tenant_id',$3::text,
            'after_generation',m.generation_id,'after_identity',m.identity,'after_inclusive',true)::text) AS cursor_bytes
        FROM inventory_memberships m
        WHERE baseline_id=$1 ${eligible}
        ORDER BY ${order} LIMIT 997), doomed AS (
          SELECT *,sum(bytes) OVER(ORDER BY identity,valid_from_revision) AS total,max(cursor_bytes) OVER() AS cursor_limit FROM candidates), gone AS (
        DELETE FROM inventory_memberships m
        WHERE m.ctid=ANY(ARRAY(SELECT member_tid FROM doomed WHERE total+cursor_limit<=1047040))
        RETURNING octet_length(row_to_json(m)::text) AS bytes)
        SELECT count(*)::int AS rows,coalesce(sum(bytes),0)::int AS bytes FROM gone`,
      floor.protected ? [root.baselineId,root.scopeId,root.tenantId,floor.revision] : [root.baselineId,root.scopeId,root.tenantId])).rows[0];
      const cursor = (await client.query(`SELECT current_setting('agent_control.inventory_gc_cursor_rows') AS rows,
        current_setting('agent_control.inventory_gc_cursor_bytes') AS bytes`)).rows[0];
      const cursorRows = Number(cursor.rows),cursorBytes = Number(cursor.bytes);
      if (!Number.isSafeInteger(cursorRows) || cursorRows<0 || cursorRows>1 || !Number.isSafeInteger(cursorBytes) || cursorBytes<0
        || removed.rows+cursorRows+2>1000 || removed.bytes+cursorBytes+1536>1_048_576) throw new Error("inventory_gc_cursor_budget");
      await client.query("UPDATE inventory_roots SET collected_before=greatest(collected_before,$2) WHERE baseline_id=$1", [root.baselineId, floor.revision]);
      return { rows: removed.rows+cursorRows as number,removed: removed.rows as number,bytes: removed.bytes+cursorBytes+1536 as number };
    }, databaseClient);
  }

  async compact(input: BeginGeneration, root: InventoryRoot, options: Parameters<InventoryGenerations["execute"]>[3]) {
    const prior = (await this.database.query(`SELECT r.domain,a.environment_id,a.resource_types,a.role_scope FROM inventory_roots r
      JOIN inventory_attempts a ON a.generation_id=r.baseline_id WHERE r.baseline_id=$1 AND r.scope_id=$2`, [root.baselineId, root.scopeId])).rows[0];
    if (!prior) throw new Error("inventory_baseline_required");
    const domain = prior.domain as InventoryDomain;
    return this.execute(input, { domain, mode: "compact", channel: domain === "canonical" ? "canonical" : "catalog",
      environmentId: prior.environment_id ?? undefined, resourceTypes: prior.resource_types, roleScope: prior.role_scope }, async lease => {
      let after = "";
      for (;;) {
        const page = await this.generations.connections.run(async client => {
          const generation = await this.fence(client, lease);
          if (lease.scopeId !== root.scopeId || lease.epoch !== root.epoch || lease.expectedRevision !== root.revision) throw new Error("inventory_compaction_fenced");
          const rows = (await client.query(`SELECT identity,generation_id FROM inventory_memberships m
            WHERE ${inventoryAsOf()} AND identity>$3 ORDER BY identity LIMIT 250`, [root.baselineId, root.revision, after])).rows;
          if (!rows.length) return rows;
          const batch = encodeBatch(rows, [lease.id, lease.scopeId, lease.tenantId]);
          if (exactCount(generation.byte_count) + batch.bytes > exactCount(generation.reserved_bytes)) throw dataLimitError("data_generation_bytes", exactCount(generation.reserved_bytes), exactCount(generation.byte_count) + batch.bytes);
          await client.query(`INSERT INTO inventory_compaction_refs(generation_id,scope_id,tenant_id,identity,source_generation_id,schema_version)
            SELECT $1,$2,$3,identity,generation_id,1 FROM jsonb_to_recordset($4::jsonb) r(identity text,generation_id uuid)`, [lease.id, lease.scopeId, lease.tenantId, batch.json]);
          await client.query("UPDATE data_generations SET row_count=row_count+$2,byte_count=byte_count+$3 WHERE id=$1", [lease.id, rows.length, batch.bytes]);
          return rows;
        });
        if (!page.length) break;
        after = page.at(-1)!.identity;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }, { ...options, validateInputs: async client => {
      if (domain === "canonical" && (await client.query("SELECT 1 FROM inventory_reconciliation WHERE scope_id=$1 AND active_id IS NOT NULL",
        [root.scopeId])).rowCount) throw new Error("inventory_compaction_busy");
      await options.validateInputs?.(client);
    } });
  }

  async gcContent(scopeId: string, tenantId: string, databaseClient?: pg.PoolClient) {
    return this.collectionTransaction(async client => {
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      if (!await this.collectionScope(client, scopeId, tenantId)) return { rows: databaseClient ? 1 : 0,bytes: databaseClient ? 512 : 0 };
      const inserted = await client.query(`INSERT INTO inventory_collection_progress(scope_id,tenant_id)
        VALUES($1,$2) ON CONFLICT(scope_id) DO NOTHING RETURNING scope_id`,[scopeId,tenantId]);
      const prior = (await client.query(`SELECT after_generation,after_identity,after_inclusive FROM inventory_collection_progress
        WHERE scope_id=$1 AND tenant_id=$2 FOR UPDATE`,[scopeId,tenantId])).rows[0];
      const page = (await client.query(`WITH candidates AS MATERIALIZED (
        SELECT generation_id,identity COLLATE "default" AS identity FROM inventory_keys WHERE scope_id=$1
          AND ($2::uuid IS NULL OR (generation_id,identity COLLATE "C")${prior.after_inclusive ? ">=" : ">"}($2::uuid,$3::text COLLATE "C"))
        ORDER BY generation_id,identity COLLATE "C" LIMIT 250)
        SELECT k.generation_id,k.identity,a.domain,
          g.state IN ('published','retired','failed','cancelled')
          AND NOT EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.generation_id=k.generation_id AND m.identity=k.identity LIMIT 1 OFFSET 0)
          AND NOT EXISTS(SELECT 1 FROM unified_agent_memberships m WHERE m.source_generation_id=k.generation_id AND m.source_identity=k.identity LIMIT 1 OFFSET 0)
          AND NOT EXISTS(SELECT 1 FROM inventory_compaction_refs r WHERE r.source_generation_id=k.generation_id AND r.identity=k.identity LIMIT 1 OFFSET 0)
          AND NOT EXISTS(SELECT 1 FROM inventory_exact_heads h WHERE h.generation_id=k.generation_id AND h.identity=k.identity LIMIT 1 OFFSET 0) AS collectable
        FROM candidates k JOIN LATERAL (SELECT domain FROM inventory_attempts WHERE generation_id=k.generation_id LIMIT 1 OFFSET 0) a ON true
          JOIN LATERAL (SELECT state FROM data_generations WHERE id=k.generation_id LIMIT 1 OFFSET 0) g ON true
        ORDER BY k.generation_id,k.identity COLLATE "C"`,[scopeId,prior.after_generation,prior.after_identity])).rows;
      const selected = page.filter(row => row.collectable).slice(0,50);
      const slice = new LifecycleSlice(client,250);
      // Reserve both cursor writes and the caller's lifecycle-progress update.
      slice.rows = 3; slice.bytes = 8192;
      const token = (row: pg.QueryResultRow) => JSON.stringify([row.generation_id,row.identity]);
      const picked = new Set(selected.map(token)), remaining = new Set<string>();
      if (selected.length) {
        const values = [encodeBatch(selected.map(row => ({ generation: row.generation_id,identity: row.identity }))).json];
        const where = `(target.generation_id,target.identity) IN (
          SELECT generation,identity FROM jsonb_to_recordset($3::jsonb) k(generation uuid,identity text))`;
        const noFacts = `NOT EXISTS(SELECT 1 FROM inventory_facts f WHERE f.generation_id=target.generation_id AND f.identity=target.identity COLLATE "default")`;
        const noMembers = `NOT EXISTS(SELECT 1 FROM unified_agent_memberships m WHERE m.generation_id=target.generation_id AND m.identity=target.identity COLLATE "default")`;
        while (slice.rows<900 && await slice.change("facts","inventory_facts",where,undefined,values)) { /* Shared row/byte/time budget. */ }
        await slice.change("members","unified_agent_memberships",`${where} AND ${noFacts}`,undefined,values);
        for (const domain of new Set(selected.map(row => row.domain as InventoryDomain))) {
          await slice.change("content",inventoryTables[domain],`${where} AND ${noFacts} AND ${noMembers}`,undefined,values);
        }
        await slice.change("keys","inventory_keys",`${where} AND ${noFacts} AND ${noMembers}
          AND NOT EXISTS(SELECT 1 FROM inventory_records r WHERE r.generation_id=target.generation_id AND r.identity=target.identity COLLATE "default")`,undefined,values);
        const left = (await client.query(`SELECT k.generation_id,k.identity FROM jsonb_to_recordset($1::jsonb) p(generation uuid,identity text)
          JOIN inventory_keys k ON k.generation_id=p.generation AND k.identity=p.identity`,values)).rows;
        for (const row of left) remaining.add(token(row));
      }
      const blocked = page.findIndex(row => row.collectable && (!picked.has(token(row)) || remaining.has(token(row))));
      const next = blocked>=0 ? (blocked ? page[blocked-1] : { generation_id: prior.after_generation,identity: prior.after_identity,inclusive: prior.after_inclusive })
        : page.length===250 ? page.at(-1)! : { generation_id: null,identity: null };
      const inclusive = next.inclusive === true;
      const advanced = next.generation_id!==prior.after_generation || next.identity!==prior.after_identity || inclusive!==prior.after_inclusive;
      if (advanced) await client.query(`UPDATE inventory_collection_progress SET after_generation=$2,after_identity=$3,after_inclusive=$4
        WHERE scope_id=$1`,[scopeId,next.generation_id,next.identity,inclusive]);
      return !selected.length && !advanced && !inserted.rowCount ? { rows: databaseClient ? 1 : 0,bytes: databaseClient ? 512 : 0 }
        : { rows: slice.rows,bytes: slice.bytes };
    }, databaseClient);
  }

  async gcMetadata(scopeId: string, tenantId: string, databaseClient?: pg.PoolClient) {
    return (await this.gcMetadataSlice(scopeId, tenantId, databaseClient)).removed;
  }
  async gcMetadataSlice(scopeId: string, tenantId: string, databaseClient?: pg.PoolClient) {
    return this.collectionTransaction(async client => {
      const slice = new LifecycleSlice(client, 50, "inventory_metadata");
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      if (!await this.collectionScope(client, scopeId, tenantId)) {
        return { removed: {} as Record<string,number>,rows: databaseClient ? 1 : 0,bytes: databaseClient ? 512 : 0 };
      }
      const removed: Record<string, number> = {};
      await slice.open();
      slice.rows += 1; slice.bytes += 512;
      const remove = async (name: string, table: string, where: string, parameters: unknown[] = [scopeId],
        orderBy: "ctid" | "worker_id" | "revision" | "sequence" = "ctid") => {
        removed[name] = (removed[name] ?? 0) + await slice.change(name, table, where, undefined, parameters, orderBy);
      };
      // Control epochs fence readers immediately, but recovery still needs the captured membership.
      const retired = await client.query(`UPDATE inventory_roots r SET current=false FROM data_generations g,data_scope_epochs s,inventory_revisions v
        WHERE r.scope_id=$1 AND r.current AND v.scope_id=r.scope_id AND v.revision=r.revision AND g.id=v.generation_id AND s.id=r.scope_id
          AND (g.expires_at<=clock_timestamp() OR g.session_epoch<>s.session_epoch
            OR g.scope_epoch<>s.epoch AND NOT(s.token_mode='delegated' AND (
              s.source='inventory_packages' AND EXISTS(SELECT 1 FROM inventory_control_pending p
                WHERE p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id)
              OR s.source='inventory_power_platform' AND EXISTS(SELECT 1 FROM inventory_native_control_pending p WHERE p.scope_id=s.id)))
            OR EXISTS(SELECT 1 FROM jsonb_to_recordset(v.inputs) input("scopeId" uuid,"baselineId" uuid,epoch bigint,"expiresAt" timestamptz)
              LEFT JOIN data_scope_epochs dependency ON dependency.id=input."scopeId"
              LEFT JOIN data_generations captured ON captured.id=input."baselineId"
              WHERE input."expiresAt"<=clock_timestamp() OR dependency.epoch IS DISTINCT FROM input.epoch AND NOT coalesce(
                captured.session_epoch=dependency.session_epoch AND captured.expires_at>clock_timestamp()
                AND (EXISTS(SELECT 1 FROM inventory_native_control_pending p WHERE p.scope_id=dependency.id)
                  OR dependency.source='inventory_packages' AND EXISTS(SELECT 1 FROM inventory_control_pending p
                    WHERE p.tenant_id=dependency.tenant_id AND p.principal_id=dependency.principal_id)
                  OR EXISTS(SELECT 1 FROM inventory_roots live JOIN inventory_revisions revision
                    ON revision.scope_id=live.scope_id AND revision.revision=live.revision
                    JOIN data_generations published ON published.id=revision.generation_id
                    WHERE live.scope_id=dependency.id AND live.current AND published.scope_epoch=dependency.epoch
                      AND published.session_epoch=dependency.session_epoch AND published.expires_at>clock_timestamp())),false)))`, [scopeId]);
      slice.rows += retired.rowCount ?? 0;
      slice.bytes += (retired.rowCount ?? 0) * 1024;
      await remove("workerPins", "inventory_worker_pins", `target.scope_id=$3 AND target.expires_at<=clock_timestamp()`);
      await remove("exactHeads", "inventory_exact_heads", `target.scope_id=$3 AND NOT EXISTS(
        SELECT 1 FROM inventory_roots r WHERE r.scope_id=target.scope_id AND r.current AND r.observation_epoch=target.observation_epoch
          AND (r.catalog_observed_at IS NULL OR r.catalog_observed_at<target.read_started_at))`);
      await remove("revisions", "inventory_revisions", `target.scope_id=$3 AND EXISTS(
        SELECT 1 FROM inventory_roots r WHERE r.baseline_id=target.baseline_id AND target.revision<r.collected_before)`);
      const root = (await client.query(`SELECT baseline_id FROM inventory_roots r WHERE scope_id=$1 AND NOT current
        AND NOT EXISTS(SELECT 1 FROM data_generations g WHERE g.id=r.baseline_id AND g.state IN ('staging','validating'))
        AND NOT EXISTS(SELECT 1 FROM inventory_memberships m WHERE m.baseline_id=r.baseline_id)
        AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=r.baseline_id AND p.expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM inventory_worker_pins p WHERE p.baseline_id=r.baseline_id AND p.expires_at>clock_timestamp())
        AND NOT EXISTS(${retainedInputs("r.baseline_id", "$1")})
        ORDER BY first_revision LIMIT 1`, [scopeId])).rows[0];
      await remove("revisions", "inventory_revisions", "target.baseline_id=$3", [root?.baseline_id ?? null]);
      await remove("roots", "inventory_roots", `target.baseline_id=$3 AND NOT EXISTS(
          SELECT 1 FROM inventory_revisions r WHERE r.baseline_id=target.baseline_id)`, [root?.baseline_id ?? null]);
      const completedWorker = (await client.query(`SELECT g.job_id FROM data_generations g WHERE g.scope_id=$1
        AND g.state NOT IN ('staging','validating')
        AND (EXISTS(SELECT 1 FROM inventory_frontier f WHERE f.worker_id=g.job_id LIMIT 1 OFFSET 0)
          OR EXISTS(SELECT 1 FROM inventory_candidate_edges e WHERE e.worker_id=g.job_id LIMIT 1 OFFSET 0))
        AND NOT EXISTS(SELECT 1 FROM inventory_reconciliation c WHERE c.active_id=g.job_id)
        ORDER BY g.created_at,g.id LIMIT 1`, [scopeId])).rows[0]?.job_id ?? null;
      for (const table of ["inventory_candidate_edges", "inventory_frontier"] as const) {
        await remove(table, table, "target.worker_id=$3", [completedWorker], "worker_id");
      }
      await remove("changes", "inventory_changes", `target.scope_id=$3
          AND target.revision<coalesce((SELECT min((input->>'revision')::bigint) FROM inventory_reconciliation r
            CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.published_inputs,'[]'::jsonb)
              || CASE WHEN r.active_id IS NULL THEN '[]'::jsonb ELSE coalesce(r.active_inputs,'[]'::jsonb) END
              || coalesce(r.pending_inputs,'[]'::jsonb)) input WHERE input->>'scopeId'=$3::text),
            (SELECT max(revision)+1 FROM inventory_changes WHERE scope_id=$3),0)`, [scopeId], "revision");
      await remove("compaction", "inventory_compaction_refs", `target.scope_id=$3 AND EXISTS(
        SELECT 1 FROM data_generations g JOIN inventory_attempts a ON a.generation_id=g.id
        WHERE g.id=target.generation_id AND (g.state IN ('failed','cancelled')
          OR g.state IN ('published','retired') AND a.membership_prepared))`);
      await remove("requests", "inventory_reconciliation_keys", `target.scope_id=$3 AND EXISTS(
        SELECT 1 FROM inventory_reconciliation r WHERE r.scope_id=target.scope_id AND target.sequence<=r.published_sequence)`,
      [scopeId], "sequence");
      const generation = (await client.query(`SELECT g.id FROM data_generations g JOIN inventory_attempts a ON a.generation_id=g.id
        WHERE g.scope_id=$1 AND g.state IN ('retired','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM inventory_keys k WHERE k.generation_id=g.id)
          AND NOT EXISTS(SELECT 1 FROM inventory_roots r WHERE r.baseline_id=g.id)
          AND NOT EXISTS(SELECT 1 FROM inventory_revisions v WHERE v.generation_id=g.id)
          AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=g.id)
          AND NOT EXISTS(SELECT 1 FROM inventory_compaction_refs r WHERE r.generation_id=g.id)
          AND NOT EXISTS(SELECT 1 FROM inventory_mutation_targets t WHERE t.source_generation_id=g.id)
          LIMIT 1`, [scopeId])).rows[0];
      await remove("pages", "inventory_pages", "target.generation_id=$3", [generation?.id ?? null]);
      await remove("attempts", "inventory_attempts", `target.generation_id=$3
        AND NOT EXISTS(SELECT 1 FROM inventory_pages p WHERE p.generation_id=target.generation_id)`, [generation?.id ?? null]);
      await slice.change("deleting", "data_generations", `target.id=$3
        AND NOT EXISTS(SELECT 1 FROM inventory_attempts a WHERE a.generation_id=target.id)
        AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=target.id)`, "state='deleting'", [generation?.id ?? null]);
      await slice.finish();
      return { removed, rows: slice.rows, bytes: slice.bytes };
    }, databaseClient);
  }
}
