import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { buildBoundedCsv, publishBoundedCsv } from "../services/csvExport.js";

class BackpressureResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  ended = false;
  writes = 0;
  chunks: Buffer[] = [];
  readonly headers = new Map<string, string>();

  constructor(private readonly disconnectAfter?: number) {
    super();
  }

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  write(chunk: Buffer) {
    this.writes += 1;
    this.chunks.push(Buffer.from(chunk));
    queueMicrotask(() => {
      if (this.disconnectAfter === this.writes) {
        this.destroyed = true;
        this.emit("close");
      } else {
        this.emit("drain");
      }
    });
    return false;
  }

  end() {
    this.writableEnded = true;
    this.writableFinished = true;
    this.ended = true;
    this.emit("finish");
  }
}

function sendFixture(response: BackpressureResponse, rows: Array<{ value: string | number }>) {
  const deadlineAt = Date.now() + 5_000;
  const csv = buildBoundedCsv(["value"], rows, { maximumRows: 100, maximumBytes: 100_000, deadlineAt });
  const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
  return publishBoundedCsv(request, response as unknown as Response, "fixture.csv", csv.buffer, {
    deadlineAt, chunkBytes: 1_024, validate: async () => undefined,
  });
}

describe("official usage CSV streaming", () => {
  it("cleans drain, close and error listeners through many backpressure cycles", async () => {
    const response = new BackpressureResponse();
    await sendFixture(response, Array.from({ length: 50 }, (_, value) => ({ value: `${value}${"x".repeat(1_024)}` })));

    expect(response.writes).toBeGreaterThan(50);
    expect(response.ended).toBe(true);
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("stops promptly on disconnect without ending or leaving listeners", async () => {
    const response = new BackpressureResponse(3);
    await expect(sendFixture(response, Array.from({ length: 50 }, (_, value) => ({ value: `${value}${"x".repeat(1_024)}` }))))
      .rejects.toMatchObject({ code: "export_disconnected" });

    expect(response.writes).toBe(3);
    expect(response.ended).toBe(false);
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  it("writes explicit Unknown values for nullable exported metrics", async () => {
    const response = new BackpressureResponse();
    await sendFixture(response, [{ value: "Unknown" }]);

    expect(response.writes).toBe(1);
    expect(response.ended).toBe(true);
    expect(Buffer.concat(response.chunks).toString("utf8")).toContain('"Unknown"');
  });
});