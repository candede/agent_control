import { readFileSync } from "node:fs";
import pg, { type PoolClient, type PoolConfig } from "pg";

export function secretValue(name: string) {
  const filename = process.env[`${name}_FILE`];
  return filename ? readFileSync(filename, "utf8").trim() : process.env[name];
}

export function databaseSettings(): PoolConfig {
  const sslMode = process.env.PGSSLMODE ?? "disable";
  if (!["disable", "verify-full"].includes(sslMode)) {
    throw new Error("PGSSLMODE must be disable (local) or verify-full.");
  }
  return {
    host: process.env.PGHOST ?? "postgres",
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? "agentcontrol",
    user: process.env.PGUSER ?? "agentcontrol_app",
    password: secretValue("PGPASSWORD"),
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
    options: "-c timezone=UTC -c search_path=public",
    ssl: sslMode === "verify-full" ? {
      rejectUnauthorized: true,
      ca: process.env.PGSSLROOTCERT ? readFileSync(process.env.PGSSLROOTCERT, "utf8") : undefined,
    } : false,
  };
}

export const pool = new pg.Pool(databaseSettings());
pool.on("error", () => console.error(JSON.stringify({ event: "database_pool_error" })));

export async function transaction<T>(database: pg.Pool, work: (client: PoolClient) => Promise<T>, signal?: AbortSignal) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Database transaction was cancelled.");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}