import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAgentDefinitionBytes, assertResidualBytes, dataLimits, encodeBatch, encodeInventoryFactBatch } from "./dataBounds.js";
import { withTelemetryContext } from "../services/telemetry.js";

afterEach(() => vi.restoreAllMocks());

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
      expect(() => encodeInventoryFactBatch([{ kind: "element", payload: { definition: "x".repeat(5 * 1024 ** 2) } }]))
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
