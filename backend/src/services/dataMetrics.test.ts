import { afterEach, expect, it, vi } from "vitest";
import { flushDataWorkMetrics, observeDataWork } from "./dataMetrics.js";
import { withTelemetryContext } from "./telemetry.js";

afterEach(() => { flushDataWorkMetrics(); vi.restoreAllMocks(); });
it("aggregates bounded numeric observations without inherited identity or arbitrary labels", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  flushDataWorkMetrics(); log.mockClear();
  withTelemetryContext({ jobId: "private-job", requestId: "private-request", route: "/private" }, () => {
    observeDataWork("record_gc", { rows: 250, bytes: 1_048_000, backlogRoots: 17, oldestAgeMs: 60_000 });
    observeDataWork("record_gc", { rows: 10, bytes: -1 });
    observeDataWork("private-label" as never, { bytes: 1 });
    expect(flushDataWorkMetrics()).toEqual([{ stage: "record_gc", count: 2, rows: 250, bytes: 1_048_000, backlogRoots: 17, oldestAgeMs: 60_000 }]);
  });
  expect(log).toHaveBeenCalledTimes(1);
  const payload = String(log.mock.calls[0][0]);
  expect(payload).not.toMatch(/private|jobId|requestId|route/);
  expect(JSON.parse(payload)).toMatchObject({ event: "data_lifecycle_metrics", stage: "record_gc", rows: 250, bytes: 1_048_000,
    backlogRoots: 17, oldestAgeMs: 60_000 });
  expect(flushDataWorkMetrics()).toEqual([]);
});
