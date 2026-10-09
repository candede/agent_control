import type pg from "pg";
import { InventoryGenerations, inventoryAsOf, type InventoryIntent } from "../db/inventoryGenerations.js";
import type { BeginGeneration, GenerationLease } from "../db/dataGenerations.js";
import { dataLimitError, dataLimits, encodeBatch } from "../db/dataBounds.js";
import { GraphPackagesClient, packageInventoryReadPolicy, type PackageReadOptions } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient, type ResourceQueryOptions } from "./powerPlatformResourceQuery.js";
import { packageInventoryRecord, powerPlatformInventoryRecord, restoreInventoryRecord, type InventoryFact, type InventoryRecord } from "./inventoryRecordProjection.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource, PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { normalizeNativeIdentity } from "./inventoryIdentity.js";
import { projectPackageDetails, packageDetailRevision } from "./packageDetailProjection.js";
import { projectPackageControl, type SavedPackageControl } from "./packageControlProjection.js";
import { readPackageControls } from "../db/packageControls.js";
import { AppError } from "../errors.js";

export async function storedInventoryRecord(client: pg.PoolClient, generationId: string, identity: string, purpose: "complete" | "canonical" = "complete") {
  return (await storedInventoryRecords(client, [{ generationId, identity }], purpose))[0];
}

export async function storedInventoryRecords(client: pg.PoolClient, requested: readonly { generationId: string; identity: string }[],
  purpose: "complete" | "canonical" = "complete") {
  if (!requested.length || requested.length > 100) throw dataLimitError("inventory_work_records", 100, requested.length);
  const keys = requested.map((row, ordinal) => ({ generation: row.generationId, identity: row.identity, position: ordinal }));
  const parameters = encodeBatch(keys).json;
  const rows = (await client.query(`WITH candidates AS (
      SELECT r.*,input.position,catalog.observed_at AS catalog_observed_at,catalog.expires_at AS catalog_expires_at,
        detail.observed_at AS detail_observed_at,detail.expires_at AS detail_expires_at
      FROM jsonb_to_recordset($1::jsonb) input(generation uuid,identity text,position integer)
      JOIN inventory_records r ON r.generation_id=input.generation AND r.identity=input.identity
      LEFT JOIN LATERAL (SELECT observed_at,expires_at FROM data_generations
        WHERE id=r.catalog_generation OFFSET 0) catalog ON true
      LEFT JOIN LATERAL (SELECT observed_at,expires_at FROM data_generations
        WHERE id=r.detail_generation OFFSET 0) detail ON true
    ), sized AS (SELECT *,sum(octet_length(row_to_json(candidates)::text)) OVER(ORDER BY position) AS page_bytes FROM candidates)
    SELECT * FROM sized WHERE page_bytes<=524288 OR position=0 ORDER BY position`, [parameters])).rows;
  if (!rows.length) return [];
  const result = rows.map(row => ({ ...row, facts: [] as InventoryFact[], bytes: Buffer.byteLength(JSON.stringify(row)) }));
  const workBudget = result.length === 1 ? dataLimits.agentDefinitionWorkBytes : dataLimits.batchBytes;
  let bytes = result.reduce((sum, row) => sum + row.bytes, 0);
  if (bytes > 1_048_576) throw dataLimitError("inventory_record_work_bytes", 1_048_576, bytes);
  const byIdentity = new Map(result.map(row => [`${row.generation_id}:${row.identity}`, row]));
  const selected = encodeBatch(result.map(row => ({ generation: row.generation_id, identity: row.identity }))).json;
  let boundary: { generation_id: string; identity: string; ordinal: number } | undefined;
  for (;;) {
    const part = (await client.query(`WITH candidates AS (
       SELECT f.generation_id,f.identity,f.ordinal,f.kind,f.value,f.payload FROM inventory_facts f
       JOIN jsonb_to_recordset($1::jsonb) input(generation uuid,identity text) ON f.generation_id=input.generation AND f.identity=input.identity
       WHERE (${purpose === "canonical" ? `f.kind IN ('supportedHosts','elementTypes','elementGroup','detail:channels')
         OR f.kind='collection' AND f.value IN ('supportedHosts','elementTypes','elementDetails','detail:channels')
         OR f.kind='identifier' AND f.payload->>'kind' IN ('environment_id','cds_bot_id','entra_app_id','entra_agent_id')
         OR f.kind='element' AND lower(f.payload->>'elementType') IN ('agentmetadatas','declarativecopilots','bots','customenginecopilots')`
         : `f.kind IN ('collection','supportedHosts','elementTypes','categories','allowedUsersAndGroups',
         'acquireUsersAndGroups','elementGroup','element','identifier','connectorOperation') OR f.kind LIKE 'detail:%'`})
         AND ($2::uuid IS NULL OR (f.generation_id,f.identity COLLATE "C",f.ordinal)>($2::uuid,$3::text COLLATE "C",$4::integer))
       ORDER BY f.generation_id,f.identity COLLATE "C",f.ordinal LIMIT 250
      ), sized AS (SELECT *,row_number() OVER(ORDER BY generation_id,identity COLLATE "C",ordinal) AS position,
       sum(octet_length(row_to_json(c)::text))
       OVER(ORDER BY generation_id,identity COLLATE "C",ordinal) AS bytes FROM candidates c)
      SELECT generation_id,identity,ordinal,kind,value,payload FROM sized WHERE bytes<=524288 OR position=1
       ORDER BY generation_id,identity COLLATE "C",ordinal`,
    [selected, boundary?.generation_id ?? null, boundary?.identity ?? null, boundary?.ordinal ?? null])).rows;
    if (!part.length) break;
    bytes += Buffer.byteLength(JSON.stringify(part));
    if (bytes > workBudget) throw dataLimitError("inventory_record_work_bytes", workBudget, bytes);
    for (const fact of part) {
      const row = byIdentity.get(`${fact.generation_id}:${fact.identity}`)!;
      row.facts.push(fact);
      row.bytes += Buffer.byteLength(JSON.stringify(fact));
    }
    boundary = part.at(-1);
  }
  return result.map(row => ({ ...row, value: restoreInventoryRecord(row.residual, row.facts, row.domain) }));
}

function carryControlChildren(record: InventoryRecord, previous: { generation_id: string; identity: string }, ownedCollections: string[] = []) {
  const kinds = ["collection", "supportedHosts", "elementTypes", "categories", "allowedUsersAndGroups",
    "acquireUsersAndGroups", "elementGroup", "element", "identifier", "connectorOperation", "detail:*", "search"]
    .filter(kind => !ownedCollections.includes(kind));
  record.factSource = { generationId: previous.generation_id, identity: previous.identity, kinds, excludeCollections: ownedCollections };
  record.facts = record.facts.filter(fact => fact.kind === "collection" ? ownedCollections.includes(fact.value)
    : !kinds.includes(fact.kind) && !fact.kind.startsWith("detail:"));
  return record;
}

function carryPackageCollections(record: InventoryRecord, previous: { generation_id: string; identity: string }, collections: string[]) {
  if (!collections.length) return;
  const kinds = collections.flatMap(kind => kind === "elementDetails" ? ["element", "elementGroup"] : [kind]);
  record.factSource = { generationId: previous.generation_id, identity: previous.identity,
    kinds: ["collection", ...kinds], includeCollections: collections };
  record.facts = record.facts.filter(fact => fact.kind === "collection" ? !collections.includes(fact.value) : !kinds.includes(fact.kind));
}

export class StreamedInventory {
  readonly stages: InventoryGenerations;
  constructor(database: pg.Pool, readonly graph = new GraphPackagesClient(fetch, packageInventoryReadPolicy),
    readonly powerPlatform = new PowerPlatformResourceQueryClient()) { this.stages = new InventoryGenerations(database); }

  graphCatalog(input: BeginGeneration, token: string, options: Parameters<InventoryGenerations["execute"]>[3] & PackageReadOptions) {
    return this.stages.execute(input, { domain: "packages", mode: "baseline", channel: "catalog" }, async (lease, signal) => {
      for await (const page of this.graph.catalogPages(token, { ...options, signal, visit: value => this.stages.visit(lease, value) })) {
        for (let offset = 0; offset < page.records.length; offset += 100) {
          await this.packageObservations(lease, page.records.slice(offset, offset + 100), "catalog");
        }
        await this.stages.acceptPage(lease, page, page.records.length);
      }
    }, options);
  }

  powerPlatformCatalog(input: BeginGeneration, token: string, types: readonly PowerPlatformResourceType[],
    options: Parameters<InventoryGenerations["execute"]>[3] & ResourceQueryOptions & { roleScope?: "full" | "ai" | "unknown" }) {
    const intent: InventoryIntent = { domain: "power_platform", mode: "baseline", channel: "catalog",
      environmentId: options.environmentId, resourceTypes: types, roleScope: options.roleScope };
    return this.stages.execute(input, intent, async (lease, signal) => {
      for await (const page of this.powerPlatform.pages(token, types, { ...options, signal, expectedTenantId: input.scope.tenantId,
        visit: value => this.stages.visit(lease, value) })) {
        await this.stages.appendBounded(lease, page.records.map(powerPlatformInventoryRecord));
        await this.stages.acceptPage(lease, page, page.records.length);
      }
    }, options);
  }

  details(input: BeginGeneration, token: string, ids: readonly string[],
    options: Parameters<InventoryGenerations["execute"]>[3] & PackageReadOptions) {
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("inventory_detail_targets");
    return this.stages.execute(input, { domain: "packages", mode: "delta", channel: "detail", targets: ids }, async (lease, signal) => {
      // Independent paced job, deliberately not catalog fan-out. Each await backpressures the next exact read.
      for (const id of ids) {
        const value = await this.graph.getPackageDetails(token, id, { ...options, signal });
        await this.packageObservation(lease, value, "detail");
      }

    }, options);
  }

  exact(input: BeginGeneration, token: string, ids: readonly string[],
    options: Parameters<InventoryGenerations["execute"]>[3] & PackageReadOptions) {
    if (!ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error("inventory_exact_targets");
    return this.stages.execute(input, { domain: "packages", mode: "delta", channel: "exact", targets: ids }, async (lease, signal) => {
      for (const id of ids) {
        try {
          const value = await this.graph.getPackageDetails(token, id, { ...options, signal });
          await this.packageObservation(lease, value, "exact");
        } catch (error) {
          if (!(error instanceof AppError) || error.status !== 404) throw error;
          await this.exactMissing(lease, id);
        }

      }
    }, options);
  }

  exactJob(input: BeginGeneration, token: string, detailOnly: boolean,
    options: Parameters<InventoryGenerations["execute"]>[3] & PackageReadOptions & { onProgress?: (value: { pages: number; observedCount: number }) => Promise<void> }) {
    if (!input.jobId) throw new Error("inventory_exact_targets");
    return this.stages.execute(input, { domain: "packages", mode: "delta", channel: detailOnly ? "detail" : "exact", targetJobId: input.jobId }, async (lease, signal) => {
      if (detailOnly) {
        const count = (await this.stages.database.query("SELECT count(*)::int AS count FROM inventory_refresh_targets WHERE job_id=$1", [input.jobId])).rows[0].count;
        if (!count || count > 20) throw new Error("inventory_detail_targets");
      }
      let ordinal = -1;
      let observedCount = 0;
      for (;;) {
        signal.throwIfAborted();
        const targets = await this.stages.generations.connections.run(async client => {
          await this.stages.fence(client, lease);
          return (await client.query<{ ordinal: number; target_id: string }>(`SELECT ordinal,target_id
            FROM inventory_refresh_targets WHERE job_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 20`, [input.jobId, ordinal])).rows;
        });
        if (!targets.length) break;
        encodeBatch(targets);
        for (const target of targets) {
          signal.throwIfAborted();
          try {
            const value = await this.graph.getPackageDetails(token, target.target_id, { ...options, signal });
            await this.packageObservation(lease, value, detailOnly ? "detail" : "exact");
            options.diagnostics?.completeDetail(true);
          } catch (error) {
            if (detailOnly || !(error instanceof AppError) || error.status !== 404) throw error;
            await this.exactMissing(lease, target.target_id);
            options.diagnostics?.completeDetail(false);
          }
          observedCount++;
          await options.onProgress?.({ pages: 0, observedCount });
        }
        ordinal = targets.at(-1)!.ordinal;
      }
    }, options);
  }

  async controlReadback(input: BeginGeneration, targetId: string, options: Parameters<InventoryGenerations["execute"]>[3]) {
    if (input.scope.tokenMode !== "delegated") throw new Error("inventory_control_scope");
    await options.authorize(options.signal ?? new AbortController().signal);
    return this.stages.execute(input, { domain: "packages", mode: "delta", channel: "control", targets: [targetId] }, async lease => {
      const controls = await this.stages.generations.connections.run(async client => {
        await this.stages.fence(client, lease);
        const attempt = (await client.query("SELECT baseline_id,base_revision FROM inventory_attempts WHERE generation_id=$1", [lease.id])).rows[0];
        const exists = (await client.query(`SELECT 1 FROM inventory_memberships m WHERE ${inventoryAsOf()} AND identity=$3`,
          [attempt.baseline_id, attempt.base_revision, targetId])).rowCount;
        return exists ? readPackageControls(client, { tenantId: lease.tenantId, principalId: input.scope.principalId! }, [targetId]) : null;
      });
      if (!controls) { await this.exactMissing(lease, targetId); return; }
      if (!controls.length) throw new Error("inventory_control_readback_missing");
      await this.packageObservation(lease, controls.at(-1)!.detail, "control");
    }, options);
  }

  async nativeControlReadback(input: BeginGeneration, target: {
    identity: string; nativeId: string; environmentId: string; botId: string; state: boolean; updatedAt: string;
    resourceTypes: string[]; environmentScope: string | null; roleScope: "full" | "ai" | "unknown";
  }, options: Parameters<InventoryGenerations["execute"]>[3]) {
    if (input.scope.tokenMode !== "delegated") throw new Error("inventory_control_scope");
    return this.stages.execute(input, { domain: "power_platform", mode: "delta", channel: "control", targets: [target.nativeId],
      resourceTypes: target.resourceTypes, environmentId: target.environmentScope ?? undefined, roleScope: target.roleScope }, async lease => {
      const record = await this.stages.generations.connections.run(async client => {
        await this.stages.fence(client, lease);
        const attempt = (await client.query("SELECT baseline_id,base_revision FROM inventory_attempts WHERE generation_id=$1", [lease.id])).rows[0];
        const member = (await client.query(`SELECT generation_id FROM inventory_memberships m WHERE ${inventoryAsOf()} AND identity=$3`,
          [attempt.baseline_id, attempt.base_revision, target.identity])).rows[0];
        if (!member) return { identity: target.identity, native_id: target.nativeId, environment_id: target.environmentId,
          presence: null, link_state: null, availability: null, management: null,
          display_name: "", sort_key: "", resource_type: "microsoft.copilotstudio/agents", publisher: null, modified_at: null,
          residual: { tenantId: lease.tenantId }, facts: [], deleted: true };
        const previous = (await storedInventoryRecord(client, member.generation_id, target.identity, "canonical"))!;
        const resource = previous.value as PowerPlatformResource;
        const botIds = resource.identifiers.filter(value => value.kind === "cds_bot_id").map(value => value.value);
        const sameTarget = resource.environmentId?.toLowerCase() === target.environmentId.toLowerCase()
          && (botIds.length === 1 ? botIds[0].toLowerCase() === target.botId.toLowerCase()
            : botIds.length === 0 && normalizeNativeIdentity(resource.nativeId) === target.botId.toLowerCase());
        if (sameTarget && previous.read_started_at <= input.observedAt) resource.details = { ...resource.details, isQuarantined: target.state,
          quarantinedAt: target.state ? target.updatedAt : undefined };
        return { ...carryControlChildren(powerPlatformInventoryRecord(resource), previous), catalog_generation: previous.catalog_generation,
          control_generation: lease.id, read_started_at: previous.read_started_at.toISOString(),
          observed_at: previous.observed_at.toISOString(), expires_at: previous.expires_at.toISOString() };
      });
      await this.stages.appendBounded(lease, [record]);
    }, options);
  }

  async packageObservation(lease: GenerationLease, value: CopilotPackageDetail, channel: "catalog" | "exact" | "detail" | "control",
    control?: SavedPackageControl) {
    await this.packageObservations(lease, [value], channel, control);
  }

  private async packageObservations(lease: GenerationLease, values: readonly CopilotPackageDetail[],
    channel: "catalog" | "exact" | "detail" | "control", control?: SavedPackageControl): Promise<void> {
    if (!values.length) return;
    if (values.length > 100) throw dataLimitError("inventory_work_records", 100, values.length);
    let projected: InventoryRecord[];
    try {
      projected = await this.stages.generations.connections.run(async client => {
      const generation = await this.stages.fence(client, lease);
      const attempt = (await client.query("SELECT * FROM inventory_attempts WHERE generation_id=$1", [lease.id])).rows[0];
      const oldRows = (await client.query(`SELECT m.identity,m.generation_id FROM inventory_memberships m WHERE ${inventoryAsOf()}
        AND m.identity=ANY($3::text[]) ORDER BY m.identity COLLATE "C" LIMIT 100`,
      [attempt.baseline_id, attempt.base_revision, values.map(value => value.id)])).rows;
      encodeBatch(oldRows);
      const previousById = new Map(oldRows.map(row => [row.identity, row]));
      const scope = (await client.query("SELECT principal_id,token_mode FROM data_scope_epochs WHERE id=$1", [lease.scopeId])).rows[0];
      // Deduplicate only control lookups; duplicate source observations must still fail publication.
      const controls = scope.token_mode === "delegated" ? control ? [control]
        : await readPackageControls(client, { tenantId: lease.tenantId, principalId: scope.principal_id }, [...new Set(values.map(value => value.id))]) : [];
      encodeBatch(controls);
      const project = async (value: CopilotPackageDetail): Promise<InventoryRecord> => {
      const old = previousById.get(value.id);
      const previous = old ? await storedInventoryRecord(client, old.generation_id, value.id, "canonical") : undefined;
      if (previous && channel !== "control" && previous.read_started_at > generation.observed_at) {
        return { ...packageInventoryRecord(previous.value as CopilotPackageDetail), residual: previous.residual, facts: [],
          factSource: { generationId: previous.generation_id, identity: previous.identity, kinds: ["*"] },
          catalog_generation: previous.catalog_generation,
          detail_generation: previous.detail_generation, control_generation: previous.control_generation,
          read_started_at: previous.read_started_at.toISOString(), observed_at: previous.observed_at.toISOString(), expires_at: previous.expires_at.toISOString() };
      }
      let result = value;
      let carriedCollections: string[] = [];
      if (channel === "detail") {
        if (!previous) throw new Error("inventory_detail_target_missing");
        const catalog = previous.value as CopilotPackageDetail;
        result = projectPackageDetails(catalog, { package: { ...value, identityDetailsCollected: true },
          observedAt: generation.observed_at.toISOString(), expiresAt: new Date(generation.observed_at.getTime() + 3600_000).toISOString(),
          catalogRevision: packageDetailRevision(catalog) }, false);
        if (result.detailFreshness?.state === "invalidated") carriedCollections = ["categories", "allowedUsersAndGroups", "acquireUsersAndGroups"];
        else {
          if (catalog.availableTo !== value.availableTo) carriedCollections.push("allowedUsersAndGroups");
          if (catalog.deployedTo !== value.deployedTo) carriedCollections.push("acquireUsersAndGroups");
        }
      } else if (channel === "catalog") {
        const detail = previous?.value as CopilotPackageDetail | undefined;
        result = projectPackageDetails(value, detail?.detailFreshness?.observedAt && detail.detailFreshness.expiresAt
          ? { package: detail, observedAt: detail.detailFreshness.observedAt, expiresAt: detail.detailFreshness.expiresAt,
            catalogRevision: packageDetailRevision(detail) } : undefined, false, Date.now(), generation.observed_at.getTime());
        if (detail && ["fresh", "stale"].includes(result.detailFreshness?.state ?? "")) {
          carriedCollections = ["categories", "elementDetails"];
          const newerCatalog = generation.observed_at.getTime() > Date.parse(detail.detailFreshness!.observedAt!);
          if (value.availableTo === detail.availableTo && !(newerCatalog && value.allowedUsersAndGroups !== undefined)) carriedCollections.push("allowedUsersAndGroups");
          if (value.deployedTo === detail.deployedTo && !(newerCatalog && value.acquireUsersAndGroups !== undefined)) carriedCollections.push("acquireUsersAndGroups");
        }
      } else if (channel === "exact") {
        result = projectPackageDetails(value, { package: { ...value, identityDetailsCollected: true },
          observedAt: generation.observed_at.toISOString(), expiresAt: new Date(generation.observed_at.getTime() + 3600_000).toISOString() }, true);
      } else {
        if (!previous) throw new Error("inventory_control_source_missing");
        result = previous.value as CopilotPackageDetail;
      }
      const readAt = channel === "detail" || channel === "control" ? previous?.read_started_at ?? new Date(0) : generation.observed_at;
      for (const saved of controls) if (saved.detail.id === value.id && Date.parse(saved.observation.observedAt) >= readAt.getTime()) {
        result = projectPackageControl(result, saved);
        if (saved.state.kind !== "block") carriedCollections = carriedCollections.filter(kind => !["allowedUsersAndGroups", "acquireUsersAndGroups"].includes(kind));
      }
      const record = packageInventoryRecord(result);
      if (channel === "control" && previous) {
        carryControlChildren(record, previous, ["allowedUsersAndGroups", "acquireUsersAndGroups"]
          .filter(kind => result[kind as "allowedUsersAndGroups" | "acquireUsersAndGroups"] !== undefined));
      } else if (previous) carryPackageCollections(record, previous, carriedCollections);
      return { ...record, catalog_generation: channel === "detail" || channel === "control" ? previous?.catalog_generation ?? null : lease.id,
        detail_generation: channel === "catalog" || channel === "control" ? previous?.detail_generation ?? null : lease.id,
        control_generation: channel === "control" ? lease.id : previous?.control_generation ?? null,
        ...(channel === "detail" || channel === "control" ? { read_started_at: readAt.toISOString() } : {}),
        ...(channel === "control" && previous ? { observed_at: previous.observed_at.toISOString(), expires_at: previous.expires_at.toISOString() } : {}) };
      };
      const records: InventoryRecord[] = [];
      let bytes = 0;
      for (const value of values) {
        const record = await project(value);
        bytes += Buffer.byteLength(JSON.stringify(record));
        if (bytes > 1_048_576 && values.length > 1) throw dataLimitError("inventory_projection_work_bytes", 1_048_576, bytes);
        records.push(record);
      }
      return records;
      });
    } catch (error) {
      if (!(error instanceof AppError) || !["inventory_projection_work_bytes", "package_control_bytes", "data_batch_bytes"].includes(error.code)
        || values.length < 2) throw error;
      const middle = Math.floor(values.length / 2);
      await this.packageObservations(lease, values.slice(0, middle), channel, control);
      await this.packageObservations(lease, values.slice(middle), channel, control);
      return;
    }
    await this.stages.appendBounded(lease, projected);
  }

  async exactMissing(lease: GenerationLease, id: string) {
    const record: InventoryRecord = { identity: id, native_id: id, environment_id: null, display_name: id, sort_key: id,
      presence: null, link_state: null, availability: null, management: null,
      resource_type: null, publisher: null, modified_at: null, residual: {}, facts: [], deleted: true };
    encodeBatch([record]);
    await this.stages.append(lease, [record]);
  }
}
