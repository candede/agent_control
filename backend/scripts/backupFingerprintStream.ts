import type { Hash } from "node:crypto";
import pg from "pg";
import { peakCheckpoint } from "../src/services/peakMemory.js";

/** COPY binary framing for exactly (boolean first, bytea chunk<=32768). */
export class FingerprintDecoder {
  private readonly fixed = Buffer.alloc(19);
  private filled = 0;
  private state: "header" | "fields" | "firstLength" | "first" | "chunkLength" | "chunk" | "done" = "header";
  private remaining = 0;
  count = 0;
  constructor(readonly hash: Hash, readonly previousRecords = false) {}
  consume(input: Buffer) {
    let offset = 0;
    while (offset < input.length) {
      if (this.state === "done") throw new Error("Backup fingerprint COPY trailing bytes.");
      if (this.state === "chunk") {
        const size = Math.min(this.remaining, input.length-offset);
        this.hash.update(input.subarray(offset, offset+size)); offset += size; this.remaining -= size;
        if (!this.remaining) this.state = "fields";
        continue;
      }
      const size = this.state === "header" ? 19 : this.state === "fields" ? 2 : this.state === "first" ? 1 : 4;
      const available = Math.min(size-this.filled, input.length-offset);
      input.copy(this.fixed, this.filled, offset, offset+available);
      this.filled += available; offset += available;
      if (this.filled !== size) continue;
      this.filled = 0;
      if (this.state === "header") {
        if (!this.fixed.subarray(0, 11).equals(Buffer.from("PGCOPY\n\xff\r\n\0", "latin1"))
          || this.fixed.readInt32BE(11) !== 0 || this.fixed.readInt32BE(15) !== 0) throw new Error("Backup fingerprint COPY header.");
        this.state = "fields";
      } else if (this.state === "fields") {
        const fields = this.fixed.readInt16BE();
        if (fields === -1) this.state = "done";
        else if (fields === 2) this.state = "firstLength";
        else throw new Error("Backup fingerprint COPY field count.");
      } else if (this.state === "firstLength") {
        if (this.fixed.readInt32BE() !== 1) throw new Error("Backup fingerprint COPY first flag.");
        this.state = "first";
      } else if (this.state === "first") {
        if (this.fixed[0] > 1) throw new Error("Backup fingerprint COPY boolean.");
        if (this.fixed[0]) {
          if (this.count || this.previousRecords) this.hash.update("\n");
          this.count++;
          if (!Number.isSafeInteger(this.count)) throw new Error("Backup fingerprint count overflow.");
        } else if (!this.count) throw new Error("Backup fingerprint missing first chunk.");
        this.state = "chunkLength";
      } else {
        this.remaining = this.fixed.readInt32BE();
        if (this.remaining < 1 || this.remaining > 32768) throw new Error("Backup fingerprint chunk exceeded its bound.");
        this.state = "chunk";
      }
    }
  }
  finish() {
    if (this.state !== "done" || this.filled) throw new Error("Backup fingerprint COPY incomplete.");
    return this.count;
  }
}

export async function copyFingerprint(client: Pick<pg.PoolClient, "query">, sql: string, hash: Hash, previousRecords = false) {
  const decoder = new FingerprintDecoder(hash, previousRecords);
  await new Promise<void>((resolve, reject) => {
    let failure: unknown, first = true;
    const query = new pg.Query(sql) as pg.Query & { handleCopyData(message: { chunk: Buffer }): void };
    query.handleCopyData = ({ chunk }) => {
      if (failure) return;
      try {
        decoder.consume(chunk);
        if (first) { peakCheckpoint("sql.result"); first = false; }
      } catch (error) { failure = error; }
    };
    query.once("error", reject);
    query.once("end", () => {
      try { if (failure) throw failure; decoder.finish(); peakCheckpoint("sql.result"); resolve(); }
      catch (error) { reject(error); }
    });
    client.query(query);
  });
  return decoder.count;
}
