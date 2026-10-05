import type pg from "pg";
import { expect, vi } from "vitest";

/** Records every physical row change, including cascades and revision triggers, without retaining payloads. */
export async function lifecycleEvidence(database: pg.Pool) {
  await database.query(`CREATE SCHEMA lifecycle_evidence;
    CREATE TABLE lifecycle_evidence.changes(tx bigint,relation text,bytes bigint,at timestamptz);
    CREATE FUNCTION lifecycle_evidence.observe() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      INSERT INTO lifecycle_evidence.changes VALUES(txid_current(),TG_TABLE_NAME,
        greatest(coalesce(octet_length(row_to_json(OLD)::text),0),coalesce(octet_length(row_to_json(NEW)::text),0)),clock_timestamp());
      RETURN NULL;
    END $$;
    DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
        EXECUTE format('CREATE TRIGGER lifecycle_evidence AFTER INSERT OR UPDATE OR DELETE ON public.%I
          FOR EACH ROW EXECUTE FUNCTION lifecycle_evidence.observe()',r.tablename);
      END LOOP;
    END $$;`);
  return {
    async reset() { await database.query("TRUNCATE lifecycle_evidence.changes"); },
    async check() {
      const result = await database.query(`SELECT tx::text,count(*)::int AS rows,sum(bytes)::int AS bytes,
        extract(epoch FROM max(at)-min(at))*1000 AS milliseconds
        FROM lifecycle_evidence.changes GROUP BY tx ORDER BY tx`);
      for (const row of result.rows) {
        expect(row.rows, JSON.stringify(row)).toBeLessThanOrEqual(1000);
        expect(row.bytes, JSON.stringify(row)).toBeLessThanOrEqual(1_048_576);
        expect(Number(row.milliseconds), JSON.stringify(row)).toBeLessThan(5000);
      }
      return result.rows;
    },
    async report(label: string) {
      const slices = await this.check();
      const relations = (await database.query(`SELECT relation,count(*)::int AS rows,sum(bytes)::text AS bytes
        FROM lifecycle_evidence.changes GROUP BY relation ORDER BY relation`)).rows;
      process.stdout.write(`LIFECYCLE_PHYSICAL_RECEIPT ${JSON.stringify({ label, transactions: slices.length,
        maximumRows: Math.max(0, ...slices.map(row => row.rows)), maximumBytes: Math.max(0, ...slices.map(row => row.bytes)),
        maximumMilliseconds: Math.max(0, ...slices.map(row => Number(row.milliseconds))), relations })}\n`);
    },
  };
}

/** Advance only the collector's SQL clock; immutable uploaded timestamps and all database guards stay intact. */
export async function withCollectorClock<T>(database: pg.Pool, days: number, work: () => Promise<T>) {
  return withQueries(database, text => text.replaceAll("clock_timestamp()", `(clock_timestamp()+interval '${days} days')`), work);
}

export async function withQueries<T>(database: pg.Pool, transform: (text: string, values: unknown[]) => string | Promise<string>, work: () => Promise<T>) {
  const clients = new Set<pg.PoolClient>(), spies: Array<{ mockRestore(): void }> = [];
  const acquire = (client: pg.PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    const query = client.query.bind(client);
    spies.push(vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "string") {
        const text = transform(args[0], (args[1] as unknown[]) ?? []);
        if (typeof text !== "string") return text.then(value => { args[0] = value; return Reflect.apply(query, client, args); });
        args[0] = text;
      }
      return Reflect.apply(query, client, args);
    }) as typeof client.query));
  };
  database.on("acquire", acquire);
  try { return await work(); }
  finally { database.off("acquire", acquire); for (const spy of spies) spy.mockRestore(); }
}
