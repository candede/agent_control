import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { observeDataWork } from "./dataMetrics.js";
import { revalidateAuthenticatedUser } from "../auth/msal.js";
import { DataGenerations, type BeginGeneration } from "../db/dataGenerations.js";
import { InventoryGenerations, inventorySelector, type InventoryIntent } from "../db/inventoryGenerations.js";
import { pool } from "../db/pool.js";
import { AppError, errorTelemetry } from "../errors.js";
import { hasAppRole } from "../types/capability.js";
import { InventoryReconciliation } from "./inventoryReconciliation.js";
import { maintenanceActive } from "./maintenance.js";
import { readOperationalState } from "./operationalState.js";
import { operationalLog } from "./telemetry.js";
import { StreamedInventory } from "./streamedInventory.js";

type Scope = { tenantId: string; principalId: string };
type Domain = "packages" | "power_platform";

export async function inventoryJobInput(database: pg.Pool, scope: Scope, domain: Domain, id: string,
  intent: Pick<InventoryIntent, "environmentId" | "resourceTypes"> = {}): Promise<BeginGeneration> {
  const table = domain === "packages" ? "package_refresh_jobs" : "power_platform_refresh_jobs";
  const row = (await database.query(`SELECT j.attempted_at,j.deadline_at,
      ${domain === "packages" ? "j.token_mode" : "'delegated'::text AS token_mode"},s.run_id FROM ${table} j
    LEFT JOIN data_sync_run_sources s ON s.job_id=j.id AND s.tenant_id=j.tenant_id
    WHERE j.id=$1 AND j.tenant_id=$2 AND j.principal_id=$3 AND j.status='running'
      AND j.expires_at>clock_timestamp() AND j.deadline_at>clock_timestamp()`,
  [id, scope.tenantId, scope.principalId])).rows[0];
  if (!row) throw new AppError(409, "inventory_job_fenced", "The inventory refresh is no longer current.");
  return {
    scope: { ...scope, kind: "principal", tokenMode: row.token_mode ?? "delegated",
      source: `inventory_${domain}`, selector: inventorySelector({ domain, ...intent }) },
    schemaVersion: 1, sessionEpoch: await new DataGenerations(database).sessionEpoch(scope.tenantId, scope.principalId),
    jobId: id, jobKind: domain === "packages" ? "package_refresh" : "power_platform_refresh", runId: row.run_id ?? undefined,
    observedAt: row.attempted_at, expiresAt: new Date(Date.now() + 86_400_000),
    deadlineAt: row.deadline_at, reserveBytes: 1024 ** 3,
  };
}

export function completeInventoryJob(input: BeginGeneration, domain: Domain) {
  return async (client: pg.PoolClient, result: { jobId: string; rows: number }) => {
    const table = domain === "packages" ? "package_refresh_jobs" : "power_platform_refresh_jobs";
    const changed = await client.query(`UPDATE ${table} SET status='succeeded',observed_count=$4,total_records=$4,
      page_count=(SELECT page_count FROM data_generations WHERE job_id=$1 AND state='published' ORDER BY observed_at DESC LIMIT 1),
      ${domain === "power_platform" ? `unknown_field_count=(SELECT a.omitted_fields FROM inventory_attempts a
        JOIN data_generations g ON g.id=a.generation_id WHERE g.job_id=$1 AND g.state='published' ORDER BY g.observed_at DESC LIMIT 1),` : ""}
      error_code=NULL,message=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running'
        AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`,
    [result.jobId, input.scope.tenantId, input.scope.principalId, result.rows]);
    if (changed.rowCount !== 1) throw new AppError(409, "inventory_job_fenced", "The inventory refresh stopped before publication.");
    if (!input.runId) return;
    const source = domain === "packages" ? "graph_packages" : "power_platform";
    const published = await client.query(`UPDATE data_sync_run_sources s SET status='succeeded',count=$5,
      last_success_at=clock_timestamp(),updated_at=clock_timestamp(),message='Complete source published.',can_retry=false
      FROM data_sync_runs r WHERE s.run_id=r.id AND s.run_id=$1 AND s.tenant_id=$2 AND s.principal_id=$3
        AND s.job_id=$4 AND s.source_id=$6 AND s.status='running' AND r.status IN ('running','waiting')
      RETURNING s.run_id`, [input.runId, input.scope.tenantId, input.scope.principalId, result.jobId, result.rows, source]);
    if (published.rowCount !== 1) throw new AppError(409, "inventory_run_fenced", "The source run stopped before publication.");
    await client.query(`INSERT INTO data_sync_success_markers(tenant_id,principal_id,source_id,count,last_success_at,updated_at)
      VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()) ON CONFLICT(tenant_id,principal_id,source_id)
      DO UPDATE SET count=EXCLUDED.count,last_success_at=EXCLUDED.last_success_at,updated_at=EXCLUDED.updated_at`,
    [input.scope.tenantId, input.scope.principalId, source, result.rows]);
    await client.query(`UPDATE data_sync_runs r SET status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM data_sync_run_sources s WHERE s.run_id=r.id AND s.status<>'succeeded')`, [input.runId]);
  };
}

export class InventoryRuntime {
  readonly reconciliation: InventoryReconciliation;
  readonly stages: InventoryGenerations;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private controller?: AbortController;
  private stopped = false;
  private requested = false;
  private after = "";
  constructor(readonly database: pg.Pool, private readonly authorize = async (scope: Scope, signal: AbortSignal) => {
    signal.throwIfAborted();
    const user = await revalidateAuthenticatedUser(scope.tenantId, scope.principalId);
    if (user.tenantId !== scope.tenantId || user.homeAccountId !== scope.principalId || !hasAppRole(user.roles, "AgentControl.Viewer")) {
      throw AppError.unauthorized();
    }
    signal.throwIfAborted();
  }) {
    this.reconciliation = new InventoryReconciliation(database);
    this.stages = new InventoryGenerations(database);
  }
  private async input(scope: Scope): Promise<BeginGeneration> {
    return { scope: { ...scope, kind: "principal", tokenMode: "delegated", source: "inventory_canonical", selector: "complete" },
      schemaVersion: 1, sessionEpoch: await new DataGenerations(this.database).sessionEpoch(scope.tenantId, scope.principalId),
      observedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), deadlineAt: new Date(Date.now() + 1_799_000),
      reserveBytes: 1024 ** 3, jobKind: "derived", jobId: randomUUID() };
  }
  async enqueue(scope: Scope, schedule = true) {
    if ((await this.database.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM inventory_control_pending
      WHERE tenant_id=$1 AND principal_id=$2) OR EXISTS(SELECT 1 FROM inventory_native_control_pending
      WHERE tenant_id=$1 AND principal_id=$2)`, [scope.tenantId, scope.principalId])).rowCount) return false;
    const roots = (await this.database.query(`SELECT r.scope_id AS "scopeId",r.tenant_id AS "tenantId",
      r.baseline_id AS "baselineId",r.revision,s.epoch FROM inventory_roots r
      JOIN data_scope_epochs s ON s.id=r.scope_id JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision
      JOIN data_generations g ON g.id=v.generation_id WHERE r.current AND r.tenant_id=$1 AND s.principal_id=$2
        AND s.token_mode='delegated' AND r.domain IN ('packages','power_platform')
        AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch AND g.state IN ('published','retired') AND g.validated
      ORDER BY r.scope_id LIMIT 17`, [scope.tenantId, scope.principalId])).rows;
    if (roots.length > 16) throw new AppError(413, "inventory_source_limit", "At most 16 source roots may form a canonical inventory.");
    if (roots.length) await this.reconciliation.request(await this.input(scope), roots);
    if (this.timer && schedule) this.wake();
    return roots.length > 0;
  }
  async publishControls(scope: Scope, signal = new AbortController().signal) {
    await this.stages.generations.connections.run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
      await client.query(`DELETE FROM inventory_control_pending WHERE (tenant_id,principal_id,target_id) IN (
        SELECT p.tenant_id,p.principal_id,p.target_id FROM inventory_control_pending p WHERE tenant_id=$1 AND principal_id=$2
          AND NOT EXISTS(SELECT 1 FROM inventory_roots root JOIN data_scope_epochs s ON s.id=root.scope_id
            JOIN inventory_revisions v ON v.scope_id=root.scope_id AND v.revision=root.revision JOIN data_generations g ON g.id=v.generation_id
            WHERE root.current AND s.tenant_id=p.tenant_id AND s.principal_id=p.principal_id
              AND s.source='inventory_packages' AND s.selector='complete' AND s.token_mode='delegated'
              AND g.session_epoch=s.session_epoch AND g.state IN ('published','retired') AND g.validated)
        ORDER BY p.target_id COLLATE "C" LIMIT 250)`, [scope.tenantId, scope.principalId]);
    });
    const pending = (await this.database.query(`SELECT p.target_id,p.observation_id,p.updated_at
      FROM inventory_control_pending p WHERE p.tenant_id=$1 AND p.principal_id=$2
        AND EXISTS(SELECT 1 FROM inventory_roots root JOIN data_scope_epochs s ON s.id=root.scope_id
          JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
          JOIN data_generations g ON g.id=revision.generation_id
          WHERE root.current AND s.tenant_id=p.tenant_id AND s.principal_id=p.principal_id
            AND s.source='inventory_packages' AND s.selector='complete' AND s.token_mode='delegated'
            AND g.session_epoch=s.session_epoch AND g.state IN ('published','retired') AND g.validated)
      ORDER BY p.updated_at,p.target_id COLLATE "C" LIMIT 20`, [scope.tenantId, scope.principalId])).rows;
    for (const target of pending) {
      signal.throwIfAborted();
      const authorize = (authorizationSignal: AbortSignal) =>
        interruptibleAuthorization(() => this.authorize(scope, authorizationSignal), authorizationSignal);
      const input: BeginGeneration = {
        scope: { ...scope, kind: "principal", tokenMode: "delegated", source: "inventory_packages", selector: "complete" },
        schemaVersion: 1, sessionEpoch: await this.stages.generations.sessionEpoch(scope.tenantId, scope.principalId),
        jobId: target.observation_id, jobKind: "derived", observedAt: target.updated_at,
        expiresAt: new Date(Date.now() + 86_400_000), deadlineAt: new Date(Date.now() + 899_000), reserveBytes: 16 * 1_048_576,
      };
      await new StreamedInventory(this.database).controlReadback(input, target.target_id, { signal, authorize,
        validateInputs: async client => {
          if (!(await client.query(`SELECT 1 FROM inventory_control_pending
            WHERE tenant_id=$1 AND principal_id=$2 AND target_id=$3 AND observation_id=$4`,
          [scope.tenantId, scope.principalId, target.target_id, target.observation_id])).rowCount) {
            throw new AppError(409, "inventory_control_changed", "The saved control observation changed before publication.");
          }
        },
        completeJob: async client => {
          if ((await client.query(`DELETE FROM inventory_control_pending
            WHERE tenant_id=$1 AND principal_id=$2 AND target_id=$3 AND observation_id=$4`,
          [scope.tenantId, scope.principalId, target.target_id, target.observation_id])).rowCount !== 1) {
            throw new AppError(409, "inventory_control_changed", "The saved control observation changed before publication.");
          }
        } });
    }
    return pending.length;
  }
  async publishNativeControls(scope: Scope, signal = new AbortController().signal) {
    await this.stages.generations.connections.run(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
      await client.query(`DELETE FROM inventory_native_control_pending WHERE (scope_id,identity) IN (
        SELECT p.scope_id,p.identity FROM inventory_native_control_pending p WHERE tenant_id=$1 AND principal_id=$2
          AND NOT EXISTS(SELECT 1 FROM inventory_roots root JOIN data_scope_epochs s ON s.id=root.scope_id
            JOIN inventory_revisions v ON v.scope_id=root.scope_id AND v.revision=root.revision JOIN data_generations g ON g.id=v.generation_id
            WHERE root.scope_id=p.scope_id AND root.current AND g.session_epoch=s.session_epoch
              AND g.state IN ('published','retired') AND g.validated)
        ORDER BY p.scope_id,p.identity LIMIT 250)`, [scope.tenantId, scope.principalId]);
    });
    const pending = (await this.database.query(`SELECT p.scope_id,p.identity,p.observation_id,p.updated_at,s.selector,observation.observed_at AS receipt_observed_at,
      coalesce(record.native_id,observation.resource_native_id) AS resource_native_id,observation.environment_id,observation.bot_id,
      observation.is_bot_quarantined,observation.provider_updated_at,
      attempt.environment_id AS environment_scope,attempt.resource_types,attempt.role_scope
      FROM inventory_native_control_pending p JOIN copilot_quarantine_status_observations observation ON observation.id=p.observation_id
      JOIN data_scope_epochs s ON s.id=p.scope_id JOIN inventory_roots root ON root.scope_id=p.scope_id AND root.current
      JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
      JOIN data_generations generation ON generation.id=revision.generation_id
      JOIN inventory_attempts attempt ON attempt.generation_id=revision.generation_id
      LEFT JOIN inventory_memberships member ON member.baseline_id=root.baseline_id AND member.identity=p.identity
        AND member.valid_from_revision<=root.revision AND (member.valid_to_revision IS NULL OR member.valid_to_revision>root.revision)
      LEFT JOIN power_platform_record_rows record ON record.generation_id=member.generation_id AND record.identity=member.identity
      WHERE p.tenant_id=$1 AND p.principal_id=$2 AND generation.session_epoch=s.session_epoch
        AND generation.state IN ('published','retired') AND generation.validated ORDER BY p.updated_at,p.scope_id,p.identity LIMIT 20`,
    [scope.tenantId, scope.principalId])).rows;
    for (const target of pending) {
      signal.throwIfAborted();
      const input: BeginGeneration = {
        scope: { ...scope, kind: "principal", tokenMode: "delegated", source: "inventory_power_platform", selector: target.selector },
        schemaVersion: 1, sessionEpoch: await this.stages.generations.sessionEpoch(scope.tenantId, scope.principalId),
        jobId: target.observation_id, jobKind: "derived", observedAt: target.receipt_observed_at,
        expiresAt: new Date(Date.now() + 86_400_000), deadlineAt: new Date(Date.now() + 899_000), reserveBytes: 16 * 1_048_576,
      };
      await new StreamedInventory(this.database).nativeControlReadback(input, {
        identity: target.identity, nativeId: target.resource_native_id, environmentId: target.environment_id, botId: target.bot_id,
        state: target.is_bot_quarantined, updatedAt: target.provider_updated_at, resourceTypes: target.resource_types,
        environmentScope: target.environment_scope, roleScope: target.role_scope,
      }, { signal, authorize: authorizationSignal => interruptibleAuthorization(() => this.authorize(scope, authorizationSignal), authorizationSignal),
        validateInputs: async client => {
          if (!(await client.query(`SELECT 1 FROM inventory_native_control_pending
            WHERE scope_id=$1 AND identity=$2 AND observation_id=$3`, [target.scope_id, target.identity, target.observation_id])).rowCount) {
            throw new AppError(409, "inventory_control_changed", "The verified native readback changed before publication.");
          }
        },
        completeJob: async client => {
          if ((await client.query(`DELETE FROM inventory_native_control_pending WHERE scope_id=$1 AND identity=$2 AND observation_id=$3`,
            [target.scope_id, target.identity, target.observation_id])).rowCount !== 1) {
            throw new AppError(409, "inventory_control_changed", "The verified native readback changed before publication.");
          }
        } });
    }
    return pending.length;
  }
  private async reconcile(scope: Scope, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.publishControls(scope, signal);
    await this.publishNativeControls(scope, signal);
    if (await this.enqueue(scope, false)) {
      await this.reconciliation.runNext(await this.input(scope), authorizationSignal =>
        interruptibleAuthorization(() => this.authorize(scope, authorizationSignal), authorizationSignal), signal);
    }
  }
  async settleControls(scope: Scope, signal: AbortSignal) {
    do {
      signal.throwIfAborted();
      if (maintenanceActive() || (await readOperationalState(this.database)).mode !== "normal") {
        throw new AppError(503, "maintenance", "Inventory control publication is paused for maintenance.");
      }
      await this.reconcile(scope, signal);
      const pending = await this.database.query(`SELECT 1 WHERE
        EXISTS(SELECT 1 FROM inventory_control_pending WHERE tenant_id=$1 AND principal_id=$2)
        OR EXISTS(SELECT 1 FROM inventory_native_control_pending WHERE tenant_id=$1 AND principal_id=$2)
        OR EXISTS(SELECT 1 FROM inventory_reconciliation work JOIN data_scope_epochs scope ON scope.id=work.scope_id
          WHERE scope.tenant_id=$1 AND scope.principal_id=$2 AND (work.status<>'idle' OR work.pending_inputs IS NOT NULL))`,
      [scope.tenantId, scope.principalId]);
      if (!pending.rowCount) return;
      await delay(100, undefined, { signal });
    } while (!signal.aborted);
    signal.throwIfAborted();
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 30_000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    if (this.stopped || maintenanceActive()) return;
    this.requested = true;
    if (this.running) return;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = (async () => {
      do {
        this.requested = false;
        this.after = "";
        while (!this.stopped && !signal.aborted && !maintenanceActive() && await this.pass(signal)) {
          await delay(0, undefined, { signal });
        }
      } while (this.requested && !this.stopped && !signal.aborted && !maintenanceActive());
    })().catch(error => operationalLog("error", "inventory_reconciliation_failed",
      errorTelemetry(error, "inventory_reconciliation_failed"))).finally(() => {
      this.running = undefined; this.controller = undefined;
      if (this.requested) this.wake();
    });
  }
  async pass(signal = new AbortController().signal) {
    signal.throwIfAborted();
    if ((await readOperationalState(this.database)).mode !== "normal") return false;
    const scopes = (await this.database.query(`SELECT tenant_id,principal_id,min(id::text) AS id
      FROM data_scope_epochs WHERE source IN ('inventory_packages','inventory_power_platform') AND token_mode='delegated'
      GROUP BY tenant_id,principal_id HAVING min(id::text)>$1 ORDER BY min(id::text) LIMIT 20`, [this.after])).rows;
    if (!scopes.length) { this.after = ""; await this.collect(signal); return false; }
    for (const row of scopes) {
      if (this.stopped || signal.aborted || maintenanceActive()) return false;
      const scope = { tenantId: row.tenant_id, principalId: row.principal_id };
      try {
        await this.reconcile(scope, signal);
      } catch (error) {
        operationalLog("error", "inventory_scope_reconciliation_failed", errorTelemetry(error, "inventory_scope_reconciliation_failed"));
      }
      this.after = row.id;
    }
    await this.collect(signal);
    return true;
  }
  async collect(signal = new AbortController().signal) {
    const started = performance.now();
    signal.throwIfAborted();
    if (maintenanceActive() || (await readOperationalState(this.database)).mode !== "normal") return false;
    // Persist the scan boundary, not a list of reachable roots. Even pinned early roots and expired selectors advance.
    return this.stages.generations.connections.run(async client => {
    await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
    if (!(await client.query("SELECT pg_try_advisory_xact_lock(3650112) AS acquired")).rows[0].acquired) return false;
    const progress = (await client.query("SELECT cursor FROM data_lifecycle_progress WHERE worker='inventory' FOR UPDATE")).rows[0].cursor;
    const scope = (await client.query(`SELECT s.id,s.tenant_id,s.principal_id FROM data_scope_epochs s
      WHERE s.source IN ('inventory_packages','inventory_power_platform','inventory_canonical') AND s.id::text>=$1
        AND NOT EXISTS(SELECT 1 FROM inventory_control_pending p WHERE p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id)
        AND NOT EXISTS(SELECT 1 FROM inventory_native_control_pending p WHERE p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id)
      ORDER BY s.id LIMIT 1`, [progress.scope ?? ""])).rows[0];
    if (!scope) {
      await client.query("UPDATE data_lifecycle_progress SET cursor='{}',slices=slices+1,updated_at=clock_timestamp() WHERE worker='inventory'");
      return false;
    }
    const root = progress.stage ? undefined : (await client.query(`SELECT r.scope_id AS "scopeId",r.tenant_id AS "tenantId",
      r.baseline_id AS "baselineId",r.revision,s.epoch,r.first_revision FROM inventory_roots r
      JOIN data_scope_epochs s ON s.id=r.scope_id WHERE r.scope_id=$1 AND r.first_revision>$2
      ORDER BY r.first_revision LIMIT 1`, [scope.id, progress.scope === scope.id ? progress.revision ?? "0" : "0"])).rows[0];
    let rows = 0, bytes = 0;
    if (root) {
      const result = await this.stages.gcSlice(root, client);
      rows = result.rows + 2; bytes = result.bytes;
    } else if (progress.stage !== "metadata" || progress.scope !== scope.id) {
      const content = await this.stages.gcContent(scope.id, scope.tenant_id, client);
      rows += content.rows; bytes += content.bytes;
    } else {
      const metadata = await this.stages.gcMetadataSlice(scope.id, scope.tenant_id, client);
      rows = metadata.rows; bytes = metadata.bytes;
    }
    const next = root ? { scope: scope.id, revision: root.first_revision }
      : progress.stage === "metadata" && progress.scope === scope.id ? { scope: `${scope.id}~`, revision: "0" }
        : { scope: scope.id, stage: "metadata" };
    await client.query(`UPDATE data_lifecycle_progress SET cursor=$1::jsonb,slices=slices+1,
      rows_collected=rows_collected+$2,bytes_collected=bytes_collected+$3,updated_at=clock_timestamp() WHERE worker='inventory'`,
    [JSON.stringify(next), rows, bytes]);
    observeDataWork("inventory_gc", { rows, bytes, durationMs: Math.ceil(performance.now() - started) });
    return true;
    });
  }
  async drain() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort(new Error("inventory_shutdown"));
    await this.running;
  }
}

async function interruptibleAuthorization(authorize: () => Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { await Promise.race([authorize(), interrupted]); signal.throwIfAborted(); }
  finally { signal.removeEventListener("abort", abort); }
}

const runtimes = new WeakMap<pg.Pool, InventoryRuntime>();
export function inventoryRuntime(database: pg.Pool = pool) {
  let runtime = runtimes.get(database);
  if (!runtime) { runtime = new InventoryRuntime(database); runtimes.set(database, runtime); }
  return runtime;
}
