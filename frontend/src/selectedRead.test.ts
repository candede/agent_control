import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api/client";
import { acceptSelectedRead, canReuseSelectedRead, isExpiredSelection, selectedReadRemaining, withdrawsSelectedRead } from "./selectedRead";
import { reportPage, reportSelection } from "./test/reportDataFixture";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("server-validated saved reads", () => {
  it.each([-1, 0, 1])("keeps historical rows but admits no operation at lease deadline %+i ms", offset => {
    vi.useFakeTimers();
    const server = Date.now();
    const selection = { ...reportSelection(1, server - 590_000), validatedAt: new Date(server).toISOString() };
    const data = acceptSelectedRead(reportPage(["retained"], { selection }), performance.now());
    vi.advanceTimersByTime(10_000 + offset);
    expect(selectedReadRemaining(data.selection)).toBe(Math.max(0, -offset));
    expect(canReuseSelectedRead(data.selection)).toBe(offset < 0);
    expect(data.value).toEqual(["retained"]);
  });

  it.each([-1, 0, 1])("charges an in-flight crossing at lease deadline %+i ms exactly once", offset => {
    vi.useFakeTimers();
    const server = Date.now(), started = performance.now();
    const selection = { ...reportSelection(1, server - 590_000), validatedAt: new Date(server).toISOString() };
    vi.advanceTimersByTime(10_000 + offset);
    const data = acceptSelectedRead(reportPage(["retained"], { selection }), started);
    expect(selectedReadRemaining(data.selection)).toBe(Math.max(0, -offset));
    expect(canReuseSelectedRead(data.selection)).toBe(offset < 0);
    expect(data.value).toEqual(["retained"]);
  });

  it.each([-365, 365])("ignores %i days of browser calendar skew and later clock jumps", days => {
    vi.useFakeTimers();
    const server = Date.parse("2026-10-08T08:00:00Z");
    vi.setSystemTime(server + days * 86_400_000);
    const selection = { ...reportSelection(1, server - 590_000), validatedAt: new Date(server).toISOString() };
    const data = acceptSelectedRead(reportPage(["retained"], { selection }), performance.now());
    expect(selectedReadRemaining(data.selection)).toBe(10_000);
    vi.setSystemTime(server - days * 86_400_000);
    expect(canReuseSelectedRead(data.selection)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(selectedReadRemaining(data.selection)).toBe(0);
    expect(canReuseSelectedRead(data.selection)).toBe(false);
    expect(data.value).toEqual(["retained"]);
  });

  it.each([2_000, 12_000])("charges %i milliseconds of in-flight time without rejecting authorized historical rows", elapsed => {
    vi.useFakeTimers();
    const server = Date.now(), started = performance.now();
    const selection = { ...reportSelection(1, server - 590_000), validatedAt: new Date(server).toISOString() };
    vi.advanceTimersByTime(elapsed);
    const result = acceptSelectedRead(reportPage(["old root"], { selection }), started);
    expect(selectedReadRemaining(result.selection)).toBe(Math.max(0, 10_000 - elapsed));
    expect(result.value).toEqual(["old root"]);
  });

  it("limits reuse to thirty monotonic seconds even with a long server lease", () => {
    vi.useFakeTimers();
    const data = acceptSelectedRead(reportPage(["saved"]), performance.now());
    vi.advanceTimersByTime(29_999);
    expect(canReuseSelectedRead(data.selection)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(canReuseSelectedRead(data.selection)).toBe(false);
    expect(selectedReadRemaining(data.selection)).toBeGreaterThan(0);
  });

  it.each(["validatedAt", "evaluatedAt", "expiresAt", "id", "revision"] as const)("rejects missing %s metadata", field => {
    const data = reportPage(["private"]);
    Object.assign(data.selection, { [field]: undefined });
    expect(() => acceptSelectedRead(data, performance.now())).toThrow("saved-read metadata");
  });

  it.each([{}, { graph_packages: "1".repeat(64) }, { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64), extra: "4".repeat(64) }])(
    "requires the exact three publication hashes: %j", publicationRevisions => {
      const data = reportPage(["private"]);
      Object.assign(data.selection, { publicationRevisions });
      expect(() => acceptSelectedRead(data, performance.now())).toThrow("saved-read metadata");
    });

  it.each([401, 403, 409])("does not let expiry details disguise status %i", status => {
    const error = new ApiError(status, "selection_invalidated", "Rejected", { details: { reason: "expired" } });
    expect(isExpiredSelection(error)).toBe(status === 409);
    expect(withdrawsSelectedRead(error)).toBe(status !== 409);
  });
});
