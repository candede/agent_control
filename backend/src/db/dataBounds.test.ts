import { afterEach, describe, expect, it, vi } from "vitest";
import pgUtils from "pg/lib/utils.js";
import { assertAgentDefinitionBytes, assertResidualBytes, dataLimits, encodeBatch, encodeInventoryFactBatch } from "./dataBounds.js";
import { withTelemetryContext } from "../services/telemetry.js";

vi.mock("../config.js", () => ({ config: { nodeEnv: "test" } }));

afterEach(() => vi.restoreAllMocks());

describe("PostgreSQL parameter byte accounting", () => {
  it.each([
    ["dates", [new Date("2026-11-01T12:34:56.789Z")]],
    ["SQL arrays", [[1, true, null, ["界", { text: 'quoted " text\\' }]]]],
    ["binary views", [Buffer.from([0, 1, 255]), new Uint8Array([2, 3, 4])]],
    ["custom encoders", [{ toPostgres: () => "encoded parameter" }]],
  ])("uses the driver's encoding for %s", (_name, parameters) => {
    const rows = [{ id: "界" }];
    const batch = encodeBatch(rows, parameters);
    const expectedBytes = [...parameters, JSON.stringify(rows)].reduce((total, parameter) => {
      const encoded = pgUtils.prepareValue(parameter);
      return total + 4 + (encoded == null ? 0 : Buffer.byteLength(encoded));
    }, 0);
    expect(batch.bytes).toBe(expectedBytes);
    expect(batch.json).toBe(JSON.stringify(rows));
  });

  it("keeps the inclusive 1 MiB boundary with a timestamp parameter", () => {
    const timestamp = new Date("2026-11-01T12:34:56.789Z");
    const overhead = 12 + Buffer.byteLength(pgUtils.prepareValue(timestamp)!);
    const text = "x".repeat(dataLimits.batchBytes - overhead);
    expect(encodeBatch([text], [timestamp]).bytes).toBe(dataLimits.batchBytes);
    expect(() => encodeBatch([`${text}x`], [timestamp])).toThrow(expect.objectContaining({
      code: "data_batch_bytes",
      details: { limit: dataLimits.batchBytes, observed: dataLimits.batchBytes + 1 },
    }));
  });

  it("does not reject a binary parameter that fits the actual byte budget", () => {
    const binary = Buffer.alloc(dataLimits.batchBytes - 10);
    expect(encodeBatch([], [binary]).bytes).toBe(dataLimits.batchBytes);
  });

  it("counts null length prefixes without charging nonexistent content", () => {
    expect(encodeBatch([], [null, undefined]).bytes).toBe(14);
  });
});

describe("residual size diagnostics", () => {
  it("keeps the 256 KiB boundary inclusive and does not log successful checks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(dataLimits.residualBytes).toBe(262_144);
    for (const bytes of [0, 512, 262_143, 262_144]) {
      expect(() => assertResidualBytes(bytes, "database", "payload")).not.toThrow();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  describe("agent definition budgets", () => {
    it("accepts the observed failure size and the inclusive 4 MiB boundary", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(dataLimits.agentDefinitionBytes).toBe(4_194_304);
      for (const bytes of [335_303, 600_000, 4_194_303, 4_194_304]) {
        expect(() => assertAgentDefinitionBytes(bytes)).not.toThrow();
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it("logs and rejects definitions exceeding 4 MiB without logging their contents", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => assertAgentDefinitionBytes(4_194_305)).toThrow(expect.objectContaining({
        status: 413, code: "data_detail_bytes", details: { limit: 4_194_304, observed: 4_194_305 },
      }));
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
        event: "data_detail_limit_exceeded", errorCode: "data_detail_bytes", stage: "database",
        field: "payload", bytes: 4_194_305, maximumLength: 4_194_304,
      });
    });

    it("allows a larger transfer only for one element and retains normal batch limits", () => {
      const large = { kind: "element", payload: { definition: "x".repeat(2 * 1024 ** 2) } };
      expect(encodeInventoryFactBatch([large]).bytes).toBeGreaterThan(dataLimits.batchBytes);
      expect(() => encodeBatch([large])).toThrow(expect.objectContaining({ code: "data_batch_bytes" }));
      expect(() => encodeInventoryFactBatch([large, { kind: "element" }])).toThrow(expect.objectContaining({ code: "data_batch_bytes" }));
      expect(() => encodeInventoryFactBatch([{ ...large, kind: "identifier" }])).toThrow(expect.objectContaining({ code: "data_batch_bytes" }));
      const oversized = { ...large, payload: { definition: "x".repeat(5 * 1024 ** 2) } };
      expect(() => encodeInventoryFactBatch([oversized]))
        .toThrow(expect.objectContaining({ code: "data_batch_bytes", details: expect.objectContaining({ limit: 5_242_880 }) }));
    });
  });

  it.each([
    ["inventory_projection", "residual"],
    ["generation_batch", "residual"],
    ["database", "residual"],
    ["database", "payload"],
  ] as const)("logs only size, fixed location and correlation for %s/%s", (stage, field) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withTelemetryContext({ requestId: "request-size", jobId: "job-size", route: "/data-sync/auto-refresh" }, () => {
      expect(() => assertResidualBytes(262_145, stage, field)).toThrow(expect.objectContaining({
        status: 413, code: "data_residual_bytes", details: { limit: 262_144, observed: 262_145 },
      }));
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: "warn", event: "data_residual_limit_exceeded",
      requestId: "request-size", jobId: "job-size", route: "/data-sync/auto-refresh",
      errorCode: "data_residual_bytes", stage, field, bytes: 262_145, maximumLength: 262_144,
    });
  });
});
