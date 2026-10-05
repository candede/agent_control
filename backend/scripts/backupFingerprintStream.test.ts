import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FingerprintDecoder } from "./backupFingerprintStream.js";

function stream(rows: Array<{ first: boolean; chunk: Buffer }>) {
  const header = Buffer.alloc(19);
  Buffer.from("PGCOPY\n\xff\r\n\0", "latin1").copy(header);
  const records = rows.map(({ first, chunk }) => {
    const prefix = Buffer.alloc(11);
    prefix.writeInt16BE(2); prefix.writeInt32BE(1, 2); prefix[6] = Number(first); prefix.writeInt32BE(chunk.length, 7);
    return Buffer.concat([prefix, chunk]);
  });
  return Buffer.concat([header, ...records, Buffer.from([255, 255])]);
}
describe("bounded fingerprint COPY framing", () => {
  it("preserves the v4 raw-UTF8/no-final-newline algorithm across every fragmented header and multibyte chunk", () => {
    const bytes = stream([{ first: true, chunk: Buffer.from("alpha") }, { first: false, chunk: Buffer.from("β") },
      { first: true, chunk: Buffer.from('{"second":"line\\\\n"}') }]);
    const hash = createHash("sha256"), decoder = new FingerprintDecoder(hash);
    for (const byte of bytes) decoder.consume(Buffer.from([byte]));
    expect(decoder.finish()).toBe(2);
    expect(hash.digest("hex")).toBe(createHash("sha256").update('alphaβ\n{"second":"line\\\\n"}').digest("hex"));
  });
  it("does not add a final newline for an empty page after an exact 250-row boundary", () => {
    const hash = createHash("sha256").update("prior");
    const decoder = new FingerprintDecoder(hash, true); decoder.consume(stream([]));
    expect(decoder.finish()).toBe(0);
    expect(hash.digest("hex")).toBe(createHash("sha256").update("prior").digest("hex"));
  });
  it("accepts exactly 32-KiB chunks and rejects one byte over before consuming its payload", () => {
    const valid = new FingerprintDecoder(createHash("sha256")); valid.consume(stream([{ first: true, chunk: Buffer.alloc(32768) }]));
    expect(valid.finish()).toBe(1);
    const invalid = new FingerprintDecoder(createHash("sha256"));
    expect(() => invalid.consume(stream([{ first: true, chunk: Buffer.alloc(32769) }]))).toThrow("exceeded");
  });
});
