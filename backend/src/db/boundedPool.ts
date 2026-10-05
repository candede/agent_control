import pg from "pg";
import { checkpointQueries } from "../services/peakMemory.js";
import { clientErrorState } from "./clientErrors.js";

async function admissionFailure(code: string) {
  // Load after configuration initialization; config itself reads pool secrets.
  const { AppError } = await import("../errors.js");
  const error = new AppError(503, code, code);
  error.retryAfterSeconds = 5;
  return error;
}

/** Three foreground clients and one renewal client, including direct pool callers. */
export class BoundedPool extends pg.Pool {
  private foreground = 0;
  private readonly waiting: Array<() => void> = [];
  get admissionState() { return { foreground: this.foreground, queue: this.waiting.length }; }

  private async acquireForeground() {
    if (this.foreground < Math.min(3,(this.options.max ?? 4)-1)) { this.foreground++; return; }
    if (this.waiting.length >= 32) throw await admissionFailure("data_queue_full");
    await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(ready);
        if (index !== -1) this.waiting.splice(index, 1);
        void admissionFailure("data_acquisition_timeout").then(reject);
      }, 5_000);
      this.waiting.push(ready);
    });
  }

  private releaseForeground() {
    const next = this.waiting.shift();
    if (next) next(); else this.foreground--;
  }

  private async foregroundClient() {
    await this.acquireForeground();
    let client: pg.PoolClient;
    try { client = await super.connect(); }
    catch (error) { this.releaseForeground(); throw error; }
    checkpointQueries(client);
    const state = clientErrorState(client);
    const release = client.release.bind(client);
    let released = false;
    client.release = (error?: Error | boolean) => {
      if (released) throw new Error("Client has already been released.");
      released = true;
      try { release(error ?? state.error); } finally { this.releaseForeground(); }
    };
    return client;
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(callback: (err: Error, client: pg.PoolClient, done: (release?: Error | boolean) => void) => void): void;
  override connect(callback?: (err: Error, client: pg.PoolClient, done: (release?: Error | boolean) => void) => void) {
    const acquired = this.foregroundClient();
    if (!callback) return acquired;
    void acquired.then(client => callback(null as unknown as Error, client, client.release),
      error => callback(error, undefined as unknown as pg.PoolClient, () => {}));
  }

  async connectRenewal() {
    const client = await super.connect();
    checkpointQueries(client);
    const state = clientErrorState(client),release = client.release.bind(client);
    client.release = error => release(error ?? state.error);
    return client;
  }
}
