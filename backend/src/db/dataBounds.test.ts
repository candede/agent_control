import { afterEach, describe, expect, it, vi } from "vitest";
import { assertResidualBytes, dataLimits } from "./dataBounds.js";
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
