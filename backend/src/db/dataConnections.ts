import type pg from "pg";
import { dataAdmissionError, dataLimits } from "./dataBounds.js";
import { BoundedPool } from "./boundedPool.js";
import { peakCheckpoint, transactionCheckpoint, transactionResultCheckpoint } from "../services/peakMemory.js";
import { clientErrorState } from "./clientErrors.js";

// All dormant record consumers share this per-pool admission gate. Three
// foreground clients leave the fourth connection available for short renewals.
const gates = new WeakMap<pg.Pool, DataConnections>();
const selectedReaders = new WeakSet<pg.PoolClient>();
export function isSelectedRead(client: pg.PoolClient) { return selectedReaders.has(client); }
export class DataConnections {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(readonly database: pg.Pool) {
    if ((database.options.max ?? 4) !== 4) throw new Error("data_pool_budget");
  }
  async run<T>(work: (client: pg.PoolClient) => Promise<T>, renewal = false, signal?: AbortSignal, serializationKey?: string): Promise<T> {
    return this.transaction(work, "BEGIN", renewal, signal, undefined, serializationKey);
  }
  async selectedRead<T>(work: (client: pg.PoolClient) => Promise<T>, options: {
    signal?: AbortSignal; admissionTenantId?: string; serializationKey?: string;
  } = {}): Promise<T> {
    try {
      return await this.transaction(work, "BEGIN ISOLATION LEVEL REPEATABLE READ", false, options.signal, options.admissionTenantId, options.serializationKey);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "40001") {
        const conflict = dataAdmissionError("data_read_conflict", 503);
        conflict.cause = error;
        throw conflict;
      }
      throw error;
    }
  }
  private async transaction<T>(
    work: (client: pg.PoolClient) => Promise<T>, begin: string, renewal: boolean, signal?: AbortSignal, admissionTenantId?: string,
    serializationKey?: string,
  ): Promise<T> {
    signal?.throwIfAborted();
    const localAdmission = !renewal && !(this.database instanceof BoundedPool);
    if (localAdmission && this.active >= Math.min(3,(this.database.options.max ?? 4)-1)) {
      if (this.queue.length >= dataLimits.queue) throw dataAdmissionError("data_queue_full", 503);
      await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); resolve(); };
        const cancel = () => {
          const index = this.queue.indexOf(ready);
          if (index !== -1) this.queue.splice(index, 1);
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          reject(signal?.aborted ? signal.reason : dataAdmissionError("data_acquisition_timeout", 503));
        };
        const timer = setTimeout(cancel, dataLimits.acquireMs);
        this.queue.push(ready);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    } else if (localAdmission) this.active++;
    let client: pg.PoolClient | undefined;
    let clientState: ReturnType<typeof clientErrorState> | undefined,discard: Error | undefined;
    let admissionLocked = false;
    let serializationLocked = false;
    let failure: unknown;
    try {
      signal?.throwIfAborted();
      client = renewal && this.database instanceof BoundedPool ? await this.database.connectRenewal() : await this.database.connect();
      clientState = clientErrorState(client);
      if (serializationKey !== undefined) {
        // Lease renewal and export chunk writes must finish before a selected
        // snapshot is taken, rather than conflict with that snapshot's row fence.
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,149))", [serializationKey]);
        serializationLocked = true;
        signal?.throwIfAborted();
      }
      if (admissionTenantId !== undefined) {
        // Acquire before BEGIN: a snapshot taken while waiting on an xact lock
        // would miss the preceding capturer's committed quota reservation.
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,147))", [admissionTenantId]);
        admissionLocked = true;
        signal?.throwIfAborted();
      }
      await client.query(begin);
      if (begin === "BEGIN ISOLATION LEVEL REPEATABLE READ") selectedReaders.add(client);
      await transactionCheckpoint(client);
      const value = await work(client);
      peakCheckpoint("sql.result");
      signal?.throwIfAborted();
      const measured = await transactionResultCheckpoint(client);
      signal?.throwIfAborted();
      if (clientState.error) throw clientState.error;
      await client.query("COMMIT");
      measured?.();
      return value;
    } catch (error) {
      failure = error;
      if (client) {
        try { await client.query("ROLLBACK"); }
        catch (rollback) {
          discard = rollback instanceof Error ? rollback : new Error("data_connection_unusable",{ cause: rollback });
          failure = new AggregateError([error, rollback], "data_transaction_failed");
          throw failure;
        }
      }
      throw error;
    } finally {
      try {
        if (admissionLocked) {
          const unlocked = await client!.query("SELECT pg_advisory_unlock(hashtextextended($1,147)) AS unlocked", [admissionTenantId]);
          if (unlocked.rows[0].unlocked !== true) throw new Error("data_selection_admission_unlock_failed");
        }
        if (serializationLocked) {
          const unlocked = await client!.query("SELECT pg_advisory_unlock(hashtextextended($1,149)) AS unlocked", [serializationKey]);
          if (unlocked.rows[0].unlocked !== true) throw new Error("data_serialization_unlock_failed");
        }
      } catch (error) {
        discard = error instanceof Error ? error : new Error("data_selection_admission_unlock_failed", { cause: error });
        throw failure === undefined ? error : new AggregateError([failure, error], "data_transaction_cleanup_failed");
      } finally {
        if (client) selectedReaders.delete(client);
        client?.release(discard ?? clientState?.error);
        if (localAdmission) {
          const next = this.queue.shift();
          if (next) next(); else this.active--;
        }
      }
    }
  }
}

export function dataConnections(database: pg.Pool) {
  let gate = gates.get(database);
  if (!gate) { gate = new DataConnections(database); gates.set(database, gate); }
  return gate;
}
