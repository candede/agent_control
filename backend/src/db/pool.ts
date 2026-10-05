import { readFileSync } from "node:fs";
import pg, { type PoolClient, type PoolConfig } from "pg";
import { operationalLog } from "../services/telemetry.js";
import { BoundedPool } from "./boundedPool.js";
import { clientErrorState } from "./clientErrors.js";

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
    types: {
      getTypeParser: (oid, format) => {
        const parser = pg.types.getTypeParser(oid, format);
        // PostgreSQL DATE has no time zone; pg otherwise decodes it at local midnight.
        return oid === pg.types.builtins.DATE && format !== "binary"
          ? (value: string) => parser(value.replace(/^(\d+-\d{2}-\d{2})( BC)?$/, "$1 00:00:00Z$2"))
          : parser;
      },
    },
    ssl: sslMode === "verify-full" ? {
      rejectUnauthorized: true,
      ca: process.env.PGSSLROOTCERT ? readFileSync(process.env.PGSSLROOTCERT, "utf8") : undefined,
    } : false,
  };
}

export const pool = new BoundedPool(databaseSettings());
pool.on("error", () => operationalLog("error", "database_pool_error"));

export async function transaction<T>(database: pg.Pool, work: (client: PoolClient) => Promise<T>, signal?: AbortSignal) {
  const client = await database.connect();
  const state = clientErrorState(client);
  let discard: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Database transaction was cancelled.");
    if (state.error) throw state.error;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollback) {
      discard = rollback instanceof Error ? rollback : new Error("database_connection_unusable",{ cause: rollback });
      throw new AggregateError([error,rollback],"database_transaction_failed");
    }
    throw error;
  } finally {
    client.release(discard ?? state.error);
  }
}