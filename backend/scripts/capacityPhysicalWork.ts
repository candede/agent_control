import pg from "pg";
import { databaseSettings } from "../src/db/pool.js";
import { observeTransactionStart, observeTransactionResult } from "../src/services/peakMemory.js";
import type { CapacityTelemetry } from "./capacityTelemetry.js";
import { currentCapacityOperation } from "./capacityOperation.js";

export { capacityOperation } from "./capacityOperation.js";

type ReadCounter = { relid: string;relname: string;relkind: string;scans: string;returned: string;fetched: string };
const counterSql = `SELECT c.oid::text AS relid,c.relname,c.relkind,
    pg_stat_get_xact_numscans(c.oid)::text AS scans,
    pg_stat_get_xact_tuples_returned(c.oid)::text AS returned,
    pg_stat_get_xact_tuples_fetched(c.oid)::text AS fetched
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','i')
      AND (pg_stat_get_xact_numscans(c.oid)>0 OR pg_stat_get_xact_tuples_returned(c.oid)>0
        OR pg_stat_get_xact_tuples_fetched(c.oid)>0) ORDER BY c.relname LIMIT 1025`;

function checkedCounters(rows: ReadCounter[]) {
  if (!Array.isArray(rows)) throw new Error("capacity_read_counter_unavailable");
  if (rows.length>1024) throw new Error("capacity_read_counter_truncated");
  for (const row of rows) {
    if (![row.returned,row.fetched,row.scans].every(value => typeof value==="string" && /^\d+$/.test(value)
      && Number.isSafeInteger(Number(value)))) throw new Error("capacity_read_counter_unavailable");
  }
  return rows;
}

export async function physicalReadSnapshot(client: pg.PoolClient): Promise<ReadCounter[]> {
  return checkedCounters((await client.query<ReadCounter>(counterSql)).rows);
}

export async function physicalReadMeasurement(client: pg.PoolClient, operation: string, startLsn?: string) {
  const row = (await client.query<{ reads: ReadCounter[];lsn: string;wal: string | null }>(`
    WITH counters AS MATERIALIZED (${counterSql})
    SELECT COALESCE(jsonb_agg(to_jsonb(counters) ORDER BY relname),'[]'::jsonb) AS reads,
      set_config('capacity.operation',$1,true),pg_current_wal_insert_lsn()::text AS lsn,
      CASE WHEN $2::pg_lsn IS NOT NULL THEN pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$2::pg_lsn)::text END AS wal
    FROM counters`, [operation, startLsn ?? null])).rows[0];
  if (!row || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(row.lsn)
    || startLsn !== undefined && (typeof row.wal !== "string" || !/^\d+$/.test(row.wal) || !Number.isSafeInteger(Number(row.wal)))) {
    throw new Error("capacity_wal_counter_unavailable");
  }
  return { reads: checkedCounters(row.reads), lsn: row.lsn, wal: row.wal };
}

export function physicalReadDeltas(before: ReadCounter[], after: ReadCounter[]): ReadCounter[] {
  const previous = new Map(before.map(row => [row.relid,row]));
  const result: ReadCounter[] = [];
  for (const row of after) {
    const old = previous.get(row.relid),delta = { ...row };
    for (const field of ["scans","returned","fetched"] as const) {
      const value = Number(row[field])-Number(old?.[field] ?? 0);
      if (!Number.isSafeInteger(value) || value<0) throw new Error("capacity_read_counter_reset");
      delta[field] = String(value);
    }
    previous.delete(row.relid);
    if ([delta.scans,delta.returned,delta.fetched].some(value => value!=="0")) result.push(delta);
  }
  if (previous.size) throw new Error("capacity_read_counter_disappeared");
  return result;
}

export async function physicalWork(database: pg.Pool, telemetry: CapacityTelemetry) {
  const name = String(database.options.database);
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1" || !["test-postgres", "127.0.0.1"].includes(String(database.options.host))
    || !/^agentcontrol_test_[a-f0-9]{32}$/.test(name)) throw new Error("capacity_observer_requires_owned_fixture");
  const administrative = async <T>(work: (operator: pg.Pool) => Promise<T>) => {
    if (database.totalCount >= 4 && database.idleCount) { const client = await database.connect(); client.release(true); }
    const operator = new pg.Pool({ ...databaseSettings(), database: name, max: 1,application_name: "agent-control-capacity-operator" });
    try { return await work(operator); } finally { await operator.end(); }
  };
  await administrative(operator => operator.query(`CREATE SCHEMA capacity_evidence;
    CREATE UNLOGGED TABLE capacity_evidence.work(operation text,tx bigint,relation text,action text,rows bigint,bytes bigint,
      PRIMARY KEY(operation,tx,relation,action));
    CREATE FUNCTION capacity_evidence.observe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE op text:=nullif(current_setting('capacity.operation',true),'');
    BEGIN
      IF op IS NOT NULL THEN
        INSERT INTO capacity_evidence.work VALUES(op,txid_current(),TG_TABLE_NAME,TG_OP,1,
          greatest(coalesce(octet_length(row_to_json(OLD)::text),0),coalesce(octet_length(row_to_json(NEW)::text),0)))
        ON CONFLICT(operation,tx,relation,action) DO UPDATE SET rows=capacity_evidence.work.rows+1,
          bytes=capacity_evidence.work.bytes+EXCLUDED.bytes;
      END IF;
      RETURN NULL;
    END $$;
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('CREATE TRIGGER capacity_physical_work AFTER INSERT OR UPDATE OR DELETE ON public.%I
          FOR EACH ROW EXECUTE FUNCTION capacity_evidence.observe()',r.tablename);
      END LOOP;
    END $$;
    GRANT USAGE ON SCHEMA capacity_evidence TO agentcontrol_app;
    GRANT SELECT,DELETE ON capacity_evidence.work TO agentcontrol_app;`));
  const starts = new WeakMap<pg.PoolClient,{ wal: string;reads: ReadCounter[];measurementMs: number }>();
  observeTransactionStart(async client => {
    const current = currentCapacityOperation();
    if (current) {
      const started = performance.now();
      const start = await physicalReadMeasurement(client, current);
      starts.set(client,{ wal: start.lsn,reads: start.reads,measurementMs: performance.now()-started });
    }
  });
  let reads = { sequentialTuples: 0,indexTuples: 0,heapFetches: 0,scans: 0,measurementMs: 0,transactions: 0 };
  const readHighWater = new Map<string,number>();
  telemetry.write({ event: "physical-counter-coverage",readMethod: "transaction-difference-v2",
    scope: "Same-backend public heap/index counter differences measured after BEGIN and before COMMIT, excluding rolled-back work. Each endpoint combines the bounded counter snapshot and operation/WAL metadata in one query. PostgreSQL pending scan counters can include prior unflushed transactions; their starting values are subtracted. WAL is a precommit cluster interval, includes concurrent/maintenance WAL and can overlap other operations; not attributable transaction WAL.",
    relationDetail: "All fixed-probe relations; otherwise the eight largest relations at each operation-class high water. Read totals are recorded for every tagged committed transaction. Write counters aggregate operation/relation/action within each bounded 250-counter flush." });
  observeTransactionResult(async client => {
    const current = currentCapacityOperation();
    if (!current) return;
    const started = performance.now();
    const start = starts.get(client);
    if (!start) throw new Error("capacity_read_start_unavailable");
    const end = await physicalReadMeasurement(client, current, start.wal);
    const relations = physicalReadDeltas(start.reads, end.reads);
    const measured = { sequentialTuples: 0,indexTuples: 0,heapFetches: 0,scans: 0,
      measurementMs: start.measurementMs+performance.now()-started,transactions: 1 };
    for (const row of relations) {
      measured[row.relkind==="i" ? "indexTuples" : "sequentialTuples"] += Number(row.returned);
      measured.heapFetches += Number(row.fetched); measured.scans += Number(row.scans);
    }
    const wal = end.wal!;
    measured.measurementMs = start.measurementMs+performance.now()-started;
    return () => {
      for (const key of Object.keys(reads) as Array<keyof typeof reads>) reads[key] += measured[key];
      const operationClass = current.split(":")[0];
      const key = readHighWater.has(operationClass) || readHighWater.size<32 ? operationClass : "other";
      const visited = measured.sequentialTuples+measured.indexTuples+measured.heapFetches;
      const high = visited>(readHighWater.get(key) ?? -1);
      if (high) readHighWater.set(key,visited);
      const detail = current.startsWith("probe-") ? relations : high
        ? relations.sort((a,b) => Number(b.returned)+Number(b.fetched)-Number(a.returned)-Number(a.fetched)).slice(0,8) : undefined;
      telemetry.write({ event: "physical-reads",operation: current,committed: true,...measured,relations: detail,
        precommitClusterWalBytes: Number(wal) });
    };
  });
  const flush = async () => {
    const totals = { rows: 0, bytes: 0, insert: 0, update: 0, delete: 0,...reads,readMethod: "transaction-difference-v2" };
    reads = { sequentialTuples: 0,indexTuples: 0,heapFetches: 0,scans: 0,measurementMs: 0,transactions: 0 };
    for (;;) {
      const result = await database.query(`WITH picked AS (
        SELECT operation,tx,relation,action FROM capacity_evidence.work ORDER BY operation,tx,relation,action LIMIT 250), gone AS (
        DELETE FROM capacity_evidence.work w USING picked p WHERE (w.operation,w.tx,w.relation,w.action)=(p.operation,p.tx,p.relation,p.action)
        RETURNING w.operation,w.relation,w.action,w.rows,w.bytes)
        SELECT operation,relation,action,sum(rows)::text AS rows,sum(bytes)::text AS bytes,count(*)::text AS transactions,
          (SELECT count(*)::int FROM gone) AS counter_records FROM gone GROUP BY operation,relation,action ORDER BY operation,relation,action`);
      for (const row of result.rows) {
        const { counter_records: _counterRecords,...value } = row;
        telemetry.write({ event: "physical-work", ...value });
        totals.rows += Number(row.rows); totals.bytes += Number(row.bytes);
        const action = String(row.action).toLowerCase() as "insert" | "update" | "delete";
        totals[action] += Number(row.rows);
      }
      if ((result.rows[0]?.counter_records ?? 0)<250) return totals;
    }
  };
  return { flush, async checkpoint() {
    const started = performance.now();
    await administrative(operator => operator.query("CHECKPOINT"));
    telemetry.write({ event: "fixed-probe-checkpoint",milliseconds: performance.now()-started,
      scope: "Before the isolated identical-component WAL interval only; SQL/resource budgets are unchanged." });
  }, async close() {
    observeTransactionStart();
    observeTransactionResult();
    await flush();
    await administrative(operator => operator.query(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS capacity_physical_work ON public.%I',r.tablename);
      END LOOP;
    END $$; DROP SCHEMA capacity_evidence CASCADE;`));
  } };
}
