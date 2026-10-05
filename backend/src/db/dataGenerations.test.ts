import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeBatch } from "./dataBounds.js";
import { DataGenerations, generationHeartbeat, prepareGenerationBatch } from "./dataGenerations.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { directoryRecord, generationInput } from "../../scripts/largeTenantFixtures.js";
import { initializeSchema, grantRuntime } from "../../scripts/database.js";
import { schemaFingerprint, verifySchema } from "./schema.js";
import { BoundedPool } from "./boundedPool.js";
import { DataSyncRepository } from "./dataSync.js";
import { verifyDataGenerationAccountingSchema,verifyDataGenerationCharges } from "./dataGenerationAccountingSchema.js";

describe("bounded generation batches", () => {
  describe("independent fenced heartbeats", () => {
    it("renews thirty times across an append-idle 600-second provider wait and validation", async () => {
      vi.useFakeTimers();
      try {
        const renew = vi.fn(async () => {});
        const parent = new AbortController();
        const heartbeat = generationHeartbeat(renew, parent.signal);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(renew).toHaveBeenCalledTimes(30);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(renew).toHaveBeenCalledTimes(33);
        parent.abort(new Error("cancelled-network-work"));
        expect(heartbeat.signal.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(renew).toHaveBeenCalledTimes(33);
        await heartbeat.stop();
      } finally { vi.useRealTimers(); }
    });
    it("aborts on failed/zero-row renewal without scheduling retries", async () => {
      vi.useFakeTimers();
      try {
        const renew = vi.fn(async () => { throw new Error("data_writer_fenced"); });
        const heartbeat = generationHeartbeat(renew);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(heartbeat.signal.aborted).toBe(true);
        expect(renew).toHaveBeenCalledOnce();
        await heartbeat.stop();
      } finally { vi.useRealTimers(); }
    });
  });

  describe("runtime-role generation publication", () => {
    let fixture: Awaited<ReturnType<typeof testDatabase>>;
    let store: DataGenerations;
    beforeAll(async () => { fixture = await testDatabase(); store = new DataGenerations(fixture.runtime); }, 30_000);
    it("contains a real PostgreSQL transaction-timeout disconnect and restores all foreground permits",async () => {
      await expect(store.connections.run(async client => {
        await client.query("SET LOCAL transaction_timeout='100ms'");
        await client.query("SELECT pg_sleep(0.2)");
      })).rejects.toThrow();
      await new Promise(resolve => setTimeout(resolve,25));
      const values = await Promise.all(Array.from({ length: 3 },() =>
        store.connections.run(async client => (await client.query("SELECT 1 AS alive")).rows[0].alive)));
      expect(values).toEqual([1,1,1]);
    });
    afterAll(async () => { await fixture?.close(); });
    it("seeks the exact generation before evaluating sync and writer fences",async () => {
      const lease = await store.begin(generationInput({ scope: { ...generationInput().scope,selector: "point-fence" } }));
      try {
        await store.connections.run(async client => {
          const queries = vi.spyOn(client,"query");
          let statements: { sql: string;values: unknown[] }[];
          try {
            expect((await store.fence(client,lease)).id).toBe(lease.id);
            statements = queries.mock.calls.flatMap(([sql,values]) =>
              typeof sql==="string" && sql.startsWith("WITH selected_generation AS MATERIALIZED")
                ? [{ sql,values: values as unknown[] }] : []);
          } finally { queries.mockRestore(); }
          expect(statements).toHaveLength(2);
          for (const statement of statements) {
            const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON) ${statement.sql}`,statement.values)).rows[0]["QUERY PLAN"];
            const serialized = JSON.stringify(plan);
            expect(serialized).not.toContain('"Index Name":"data_generation_admission"');
            expect(serialized).toMatch(/"Index Name":"data_generations_(pkey|id_scope_id_tenant_id_key)"/);
            process.stdout.write(JSON.stringify({ contract: "generation_exact_key_fence",sql: statement.sql,plan })+"\n");
          }
        });
        await expect(store.connections.run(client => store.fence(client,{ ...lease,owner: lease.id }))).rejects.toThrow("data_writer_fenced");
        await expect(store.connections.run(client => store.fence(client,{ ...lease,version: lease.version+1 }))).rejects.toThrow("data_writer_fenced");
      } finally { await store.abort(lease); }
    });
    it("accounts scoped reservations and stored bytes exactly through abort, collection and metadata deletion",async () => {
      const input = generationInput();
      input.scope.selector = "quota-charge";
      const lease = await store.begin(input);
      const charge = async () => Number((await fixture.runtime.query(
        "SELECT generation_bytes::text AS bytes FROM data_generation_charges WHERE scope_id=$1",[lease.scopeId])).rows[0].bytes);
      expect(await charge()).toBe(input.reserveBytes);
      await store.append(lease,"directory",0,[directoryRecord("quota-one")]);
      const bytes = Number((await fixture.runtime.query("SELECT byte_count::text AS bytes FROM data_generations WHERE id=$1",[lease.id])).rows[0].bytes);
      expect(bytes).toBeGreaterThan(0);
      expect(await charge()).toBe(input.reserveBytes);
      for (const sql of ["UPDATE data_generation_charges SET generation_bytes=0 WHERE scope_id=$1",
        "DELETE FROM data_generation_charges WHERE scope_id=$1",
        "INSERT INTO data_generation_charges(scope_id,tenant_id,generation_bytes) SELECT id,tenant_id,0 FROM data_scope_epochs WHERE id=$1"]) {
        await expect(fixture.runtime.query(sql,[lease.scopeId])).rejects.toMatchObject({ code: "42501" });
      }
      for (const privilege of ["UPDATE","TRUNCATE","UPDATE(generation_bytes)"]) {
        const operator = await fixture.operator.connect();
        try {
          await operator.query("BEGIN");
          await operator.query(`GRANT ${privilege} ON data_generation_charges TO agentcontrol_app`);
          await expect(verifyDataGenerationAccountingSchema(operator)).rejects.toThrow("data_generation_accounting_schema");
        } finally { await operator.query("ROLLBACK");operator.release(); }
      }
      await store.abort(lease);
      expect(await charge()).toBe(bytes);
      await fixture.runtime.query("UPDATE data_generations SET state='deleting' WHERE id=$1",[lease.id]);
      expect(await charge()).toBe(bytes);
      await fixture.runtime.query("DELETE FROM directory_user_rows WHERE generation_id=$1",[lease.id]);
      await fixture.runtime.query("DELETE FROM data_generation_batches WHERE generation_id=$1",[lease.id]);
      await fixture.runtime.query("UPDATE data_generations SET collected_at=clock_timestamp() WHERE id=$1",[lease.id]);
      expect(await charge()).toBe(0);
      await fixture.runtime.query("DELETE FROM data_generations WHERE id=$1",[lease.id]);
      expect(await charge()).toBe(0);
      await verifyDataGenerationAccountingSchema(fixture.runtime);
      await verifyDataGenerationCharges(fixture.runtime);
    });
    it("rolls back reservation deltas with their generation transaction",async () => {
      const input = generationInput();
      input.scope.selector = "quota-rollback";
      const lease = await store.begin(input),client = await fixture.runtime.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE data_generations SET state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count WHERE id=$1",[lease.id]);
        expect((await client.query("SELECT generation_bytes::text AS bytes FROM data_generation_charges WHERE scope_id=$1",[lease.scopeId])).rows[0].bytes).toBe("0");
        await client.query("ROLLBACK");
        expect(Number((await client.query("SELECT generation_bytes::text AS bytes FROM data_generation_charges WHERE scope_id=$1",[lease.scopeId])).rows[0].bytes))
          .toBe(input.reserveBytes);
      } finally { await client.query("ROLLBACK");client.release();await store.abort(lease); }
    });
    it("admits the exact persisted JSONB residual size and diagnoses normalization overflow before a check-constraint error", async () => {
      const lease = await store.begin(generationInput());
      const residual = { value: "x".repeat(262144 - Buffer.byteLength('{"value": ""}')) };
      try {
        await expect(store.append(lease, "directory", 0, [directoryRecord("residual-exact", { residual })])).resolves.toMatchObject({ replay: false });
        await expect(store.append(lease, "directory", 1, [directoryRecord("residual-over",
          { residual: { value: residual.value + "x" } })])).rejects.toMatchObject({
          code: "data_residual_bytes", details: { limit: 262144, observed: 262145 },
        });
        expect((await fixture.runtime.query("SELECT row_count FROM data_generations WHERE id=$1", [lease.id])).rows[0].row_count).toBe(1);
      } finally { await store.abort(lease, true); }
    });

    it("takes the sync mutex before generation locks while a source status transaction owns its child row", async () => {
      const input = generationInput({ scope: { ...generationInput().scope, principalId: "sync-lock-order" } });
      const scope = { tenantId: input.scope.tenantId, principalId: "sync-lock-order" };
      const sync = new DataSyncRepository(fixture.runtime);
      const { run } = await sync.submit(scope, { mode: "initial", sources: ["users"] });
      await sync.attachJob(scope, run.id, "users", input.jobId);
      const lease = await store.begin({ ...input, runId: run.id, jobKind: "data_sync" });
      const statusWriter = await fixture.operator.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await statusWriter.query("BEGIN");
        await statusWriter.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
        await statusWriter.query("SELECT run_id FROM data_sync_run_sources WHERE run_id=$1 AND source_id='users' FOR UPDATE", [run.id]);
        let entered!: (pid: number) => void;
        const started = new Promise<number>(resolve => { entered = resolve; });
        pending = store.connections.run(async client => {
          entered((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          await store.fence(client, lease);
        }).then(() => null, error => error);
        const pid = await started;
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          waiting = (await statusWriter.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting === true;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(waiting).toBe(true);
        await statusWriter.query("SELECT id FROM data_scope_epochs WHERE id=$1 FOR UPDATE NOWAIT", [lease.scopeId]);
        await statusWriter.query("UPDATE data_sync_runs SET updated_at=clock_timestamp() WHERE id=$1", [run.id]);
      } finally {
        await statusWriter.query("ROLLBACK");
        statusWriter.release();
      }
      expect(await pending).toBeNull();
      await sync.cancel(scope, run.id);
    });

    it("keeps two batches invisible, rejects a revoked writer and retains a previous good head", async () => {
      const input = generationInput();
      const first = await store.begin(input);
      await store.append(first, "directory", 0, [directoryRecord("a")]);
      await store.append(first, "directory", 1, [directoryRecord("b")]);
      await store.observePage(first, "page-one", 1);
      await store.observePage(first, "page-two", 1);
      expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [first.scopeId])).rows[0].generation_id).toBeNull();
      await store.validate(first, { rows: 2, children: 0, batches: 2, pages: 2, wireRows: 2 });
      await store.publish(first);
      const second = await store.begin(input);
      await store.append(second, "directory", 0, [directoryRecord("c")]);
      await store.invalidate(second.scopeId, second.tenantId);
      await expect(store.publish(second)).rejects.toThrow("data_writer_fenced");
      await expect(store.renew(second)).rejects.toThrow("data_writer_fenced");
      expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [first.scopeId])).rows[0].generation_id).toBe(first.id);
    });
    it("enforces replay, duplicate identities, scope FKs, expired takeover and output CAS", async () => {
      const input = generationInput({ scope: { ...generationInput().scope, selector: "races" } });
      const first = await store.begin(input);
      const batch = [directoryRecord("a")];
      expect((await store.append(first, "directory", 0, batch)).replay).toBe(false);
      expect((await store.append(first, "directory", 0, batch)).replay).toBe(true);
      await expect(store.append(first, "directory", 0, [directoryRecord("different")])).rejects.toThrow("replay_conflict");
      await expect(store.append(first, "directory", 1, batch)).rejects.toThrow("data_writer_fenced");
      await expect(fixture.runtime.query("UPDATE directory_user_rows SET upn='poison' WHERE generation_id=$1", [first.id])).rejects.toThrow("permission denied");
      await expect(fixture.runtime.query("UPDATE data_generation_heads SET tenant_id='other' WHERE scope_id=$1", [first.scopeId])).rejects.toThrow("data_head_fenced");
      const duplicate = await store.begin(input);
      await store.append(duplicate, "directory", 0, batch);
      await expect(store.append(duplicate, "directory", 1, batch)).rejects.toThrow("duplicate key");
      const expired = await store.begin(input);
      await fixture.operator.query("UPDATE data_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
      const replacement = await store.begin(input);
      await expect(store.renew(expired)).rejects.toThrow("data_writer_fenced");
      await expect(store.renew(first)).rejects.toThrow("data_writer_fenced");
      await expect(store.append(first, "directory", 1, [])).rejects.toThrow("data_writer_fenced");
      await store.validate(replacement, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
      await expect(store.publish({ ...replacement, expectedRevision: "999" })).rejects.toThrow("data_head_conflict");
      await store.abort(replacement);
    });
    it("measures exact 1-MiB parameter and 256-KiB residual boundaries, plus one byte", async () => {
      const lease = await store.begin(generationInput({ scope: { ...generationInput().scope, selector: "boundaries" } }));
      const exactResidual = directoryRecord("residual", { residual: { x: "x".repeat(262_135) } });
      await store.append(lease, "directory", 0, [exactResidual]);
      const stored = (await fixture.runtime.query("SELECT octet_length(residual::text) AS bytes FROM directory_user_rows WHERE generation_id=$1", [lease.id])).rows[0];
      expect(stored.bytes).toBe(262_144);
      await expect(store.append(lease, "directory", 1, [directoryRecord("too-big", { residual: { x: "x".repeat(262_136) } })])).rejects.toMatchObject({
        code: "data_residual_bytes", details: { limit: 262144, observed: 262145 },
      });
      const rows = Array.from({ length: 5 }, (_, i) => directoryRecord(`wide-${i}`, { residual: { x: "x".repeat(i < 4 ? 250_000 : 0) } }));
      const initial = prepareGenerationBatch(lease, rows);
      rows[4].residual.x = "x".repeat(1_048_576 - initial.bytes);
      expect(prepareGenerationBatch(lease, rows).bytes).toBe(1_048_576);
      expect((await store.append(lease, "directory", 1, rows)).parameterBytes).toBe(1_048_576);
      rows[4].residual.x += "x";
      expect(() => prepareGenerationBatch(lease, rows)).toThrow("data_batch_bytes");
      const measured = (await fixture.runtime.query("SELECT max(parameter_bytes)::int AS maximum FROM data_generation_batches")).rows[0].maximum;
      expect(store.batchResidency.maximum).toBe(2);
      process.stdout.write(JSON.stringify({ contract: "generation_batch_bounds", maximumParameterBytes: measured, maximumBatchResidents: store.batchResidency.maximum, residualBytes: stored.bytes }) + "\n");
      await store.abort(lease);
    });
    it("accepts 0/1/250 rows, rejects 251, and enforces cross-scope record keys", async () => {
      const lease = await store.begin(generationInput({ scope: { ...generationInput().scope, selector: "cardinality" } }));
      await store.append(lease, "directory", 0, []);
      await store.append(lease, "directory", 1, [directoryRecord("single")]);
      await store.append(lease, "directory", 2, Array.from({ length: 250 }, (_, i) => directoryRecord(`user-${i}`)));
      await expect(store.append(lease, "directory", 3, Array.from({ length: 251 }, (_, i) => directoryRecord(`extra-${i}`)))).rejects.toThrow("data_batch_rows");
      await expect(fixture.runtime.query(`INSERT INTO directory_user_rows
        (generation_id,scope_id,tenant_id,identity,schema_version,content_hash,upn,upn_key,service_state,plan_count)
        VALUES($1,$2,'different-tenant','poison',1,repeat('a',64),'a','a','unknown',0)`, [lease.id, lease.scopeId])).rejects.toThrow("foreign key");
      await store.observePage(lease, "one", 251);
      const slices = vi.spyOn(store, "validationStep");
      await store.validate(lease, { rows: 251, children: 0, batches: 3, pages: 1, wireRows: 251 });
      expect(slices).toHaveBeenCalledTimes(4);
      slices.mockRestore();
      expect((await fixture.runtime.query("SELECT validated_rows,validation_phase FROM data_generations WHERE id=$1", [lease.id])).rows[0])
        .toEqual({ validated_rows: 251, validation_phase: "complete" });
      await store.publish(lease);
      const cyclic = await store.begin(generationInput({ scope: { ...generationInput().scope, selector: "cardinality" } }));
      await store.observePage(cyclic, "repeated", 1);
      await expect(store.observePage(cyclic, "repeated", 1)).rejects.toThrow("duplicate key");
      await expect(store.publish(cyclic)).rejects.toThrow("data_writer_fenced");
    });
    it("retains the head on COMMIT failure and renews through three occupied foreground slots", async () => {
      const lease = await store.begin(generationInput({ scope: { ...generationInput().scope, selector: "commit" } }));
      await store.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
      await fixture.operator.query(`CREATE FUNCTION fixture_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'fixture_commit_failure'; END $$;
        CREATE CONSTRAINT TRIGGER fixture_commit_failure AFTER UPDATE ON data_generation_heads
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fixture_reject_commit()`);
      await expect(store.publish(lease)).rejects.toThrow("fixture_commit_failure");
      expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [lease.scopeId])).rows[0].generation_id).toBeNull();
      await fixture.operator.query("DROP TRIGGER fixture_commit_failure ON data_generation_heads; DROP FUNCTION fixture_reject_commit()");
      const busy = Array.from({ length: 3 }, () => store.connections.run(client => client.query("SELECT pg_sleep(0.15)")));
      await new Promise(resolve => setTimeout(resolve, 25));
      await store.renew(lease);
      expect(fixture.runtime.totalCount).toBeLessThanOrEqual(4);
      await Promise.all(busy);
      await store.publish(lease);
    });
    it("rejects new and existing stale session work after durable principal revocation", async () => {
      const input = generationInput({ scope: { ...generationInput().scope, principalId: "revoked" } });
      const lease = await store.begin(input);
      expect(await store.revokePrincipal(input.scope.tenantId, "revoked")).toBe("1");
      await expect(store.begin(input)).rejects.toThrow("data_session_fenced");
      await expect(store.publish(lease)).rejects.toThrow("data_writer_fenced");
      const newLease = await store.begin({ ...input, sessionEpoch: "1" });
      await store.abort(newLease);
    });
    it("reserves the frozen 200k derived cardinality without widening 100k source ceilings", async () => {
      const source = await store.begin(generationInput({ scope: { ...generationInput().scope, selector: "source-ceiling" } }));
      await expect(fixture.runtime.query("UPDATE data_generations SET row_count=100001 WHERE id=$1", [source.id])).rejects.toThrow("check constraint");
      await store.abort(source);
      const derived = await store.begin(generationInput({ jobKind: "derived", scope: { ...generationInput().scope, selector: "derived-ceiling" } }));
      await fixture.runtime.query("UPDATE data_generations SET row_count=200000 WHERE id=$1", [derived.id]);
      await expect(fixture.runtime.query("UPDATE data_generations SET row_count=200001 WHERE id=$1", [derived.id])).rejects.toThrow("check constraint");
      await expect(store.publish(derived)).rejects.toThrow("data_input_fence_required");
      await store.abort(derived);
    });
    it("serializes revocation racing a commit at the durable scope lock", async () => {
      const input = generationInput({ scope: { ...generationInput().scope, principalId: "commit-race" } });
      const lease = await store.begin(input);
      await store.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
      const blocker = await fixture.operator.connect();
      try {
        await blocker.query("BEGIN");
        const blockerPid = (await blocker.query("SELECT id,pg_backend_pid() AS pid FROM data_scope_epochs WHERE id=$1 FOR UPDATE", [lease.scopeId])).rows[0].pid;
        const revoked = store.revokePrincipal(input.scope.tenantId, "commit-race");
        await vi.waitFor(async () => {
          const waiting = (await fixture.operator.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname=current_database() AND usename='agentcontrol_app' AND $1=ANY(pg_blocking_pids(pid))) AS waiting`, [blockerPid])).rows[0].waiting;
          expect(waiting).toBe(true);
        }, { timeout: 2000, interval: 10 });
        const rejected = expect(store.publish(lease)).rejects.toThrow("data_writer_fenced");
        await blocker.query("COMMIT");
        await revoked;
        await rejected;
        expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [lease.scopeId])).rows[0].generation_id).toBeNull();
      } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    });
    it.each([4,2])("reserves renewal capacity with a %i-connection ceiling even for legacy callers", async maximum => {
      const bounded = new BoundedPool({ ...fixture.runtime.options, password: fixturePassword, max: 4 });
      bounded.options.max = maximum;
      const held = await Promise.all(Array.from({ length: maximum-1 },() => bounded.connect()));
      let acquired = false;
      const fourth = bounded.connect().then(client => { acquired = true; return client; });
      try {
        const renewal = await bounded.connectRenewal();
        await renewal.query("SELECT 1");
        expect(acquired).toBe(false);
        expect(bounded.totalCount).toBe(maximum);
        renewal.release();
      } finally {
        for (const client of held) client.release();
        (await fourth).release();
        await bounded.end();
      }
    });
    it("keeps cancellation armed through the terminal commit after pausing renewal", async () => {
      const parent = new AbortController();
      let scopeId = "";
      await expect(store.execute(generationInput({ scope: { ...generationInput().scope, selector: "terminal-cancel" } }), async lease => {
        scopeId = lease.scopeId;
        await store.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
        await store.publish(lease, { completeJob: async () => { parent.abort(new Error("cancel-during-commit")); } });
      }, parent.signal)).rejects.toThrow("cancel-during-commit");
      expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [scopeId])).rows[0].generation_id).toBeNull();
      const late = new AbortController();
      await expect(store.execute(generationInput({ scope: { ...generationInput().scope, selector: "terminal-success" } }), async lease => {
        await store.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
        await store.publish(lease);
        late.abort(new Error("after-commit"));
        return "published";
      }, late.signal)).resolves.toBe("published");
    });
    it("repeats current initialization, checks least privileges and rejects a mismatched fingerprint", async () => {
      await initializeSchema(fixture.operator);
      await grantRuntime(fixture.operator);
      await verifySchema(fixture.runtime);
      await expect(fixture.runtime.query("TRUNCATE directory_user_rows")).rejects.toThrow("permission denied");
      await expect(fixture.runtime.query("CREATE TABLE forbidden(id int)")).rejects.toThrow("permission denied");
      await fixture.operator.query("UPDATE app_schema SET fingerprint=$1 WHERE singleton", ["0".repeat(64)]);
      try {
        await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      } finally {
        await fixture.operator.query("UPDATE app_schema SET fingerprint=$1 WHERE singleton", [schemaFingerprint]);
      }
      await verifySchema(fixture.runtime);
    });
  });

  it("bounds both cardinality and UTF-8 parameters", () => {
    for (const count of [0, 1, 250]) expect(encodeBatch(Array(count).fill({ id: "a" })).bytes).toBeGreaterThan(0);
    expect(() => encodeBatch(Array(251).fill({}))).toThrow("data_batch_rows");
    expect(() => encodeBatch(["界".repeat(350_000)])).toThrow("data_batch_bytes");
  });
});
