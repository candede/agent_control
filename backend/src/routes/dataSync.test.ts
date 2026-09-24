import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { createDataSyncRouter, parseRetryDataSyncInput, parseStartDataSyncInput } from "./dataSync.js";
import { declaredRoutePolicies } from "./policy.js";

describe("Data sync route contract", () => {
  it("declares Viewer-private reads and CSRF-protected Viewer refresh controls", () => {
    createDataSyncRouter({
      state: vi.fn(),
      getRun: vi.fn(),
      start: vi.fn(),
      retry: vi.fn(),
      cancel: vi.fn(),
    } as never);
    expect(declaredRoutePolicies.get("GET /data-sync/state")).toEqual({
      access: "authenticated",
      dataClass: "private_data_sync",
      roles: ["AgentControl.Viewer"],
    });
    expect(declaredRoutePolicies.get("GET /data-sync/runs/:id")).toEqual({
      access: "authenticated",
      dataClass: "private_data_sync_job",
      roles: ["AgentControl.Viewer"],
    });
    for (const path of [
      "POST /data-sync/auto-refresh",
      "POST /data-sync/runs",
      "POST /data-sync/runs/:id/retry",
      "POST /data-sync/runs/:id/cancel",
    ]) {
      expect(declaredRoutePolicies.get(path)).toMatchObject({
        access: "authenticated",
        dataClass: "private_data_sync_job",
        roles: ["AgentControl.Viewer"],
        csrf: true,
      });
    }
  });

  it("strictly parses start and retry bodies while forcing the shared source allowlist", () => {
    expect(parseStartDataSyncInput({ mode: "initial", sources: ["users"] })).toEqual({
      mode: "initial",
      sources: ["users"],
    });
    expect(parseRetryDataSyncInput(undefined)).toEqual({});
    expect(parseRetryDataSyncInput({ sources: ["graph_packages", "power_platform"] })).toEqual({
      sources: ["graph_packages", "power_platform"],
    });
    for (const value of [
      {},
      { mode: "automatic" },
      { mode: "full", sources: [] },
      { mode: "full", sources: ["users", "users"] },
      { mode: "full", sources: ["unknown"] },
      { mode: "full", extra: true },
      { mode: "incremental", automatic: true },
    ]) {
      expect(() => parseStartDataSyncInput(value)).toThrowError(AppError);
    }
    for (const mode of [["initial"], { toString: () => "initial" }]) {
      try {
        parseStartDataSyncInput({ mode });
        throw new Error("Expected strict mode parsing to fail.");
      } catch (error) {
        expect(error).toMatchObject({ status: 400, code: "invalid_data_sync_mode" });
      }
    }
    expect(() => parseRetryDataSyncInput({ sources: ["users"], extra: randomUUID() })).toThrowError(AppError);
  });

  it("requires an explicit boolean opt-in and a full run without source selectors for cleanup", () => {
    expect(parseStartDataSyncInput({ mode: "full", clearSavedData: true })).toEqual({
      mode: "full", clearSavedData: true,
    });
    expect(parseStartDataSyncInput({ mode: "full" })).toEqual({ mode: "full" });
    expect(parseStartDataSyncInput({ mode: "incremental", sources: ["users"], clearSavedData: false })).toEqual({
      mode: "incremental", sources: ["users"], clearSavedData: false,
    });
    for (const input of [
      ...[null, 0, 1, "true", [], {}].map(clearSavedData => ({ mode: "full", clearSavedData })),
      { mode: "initial", clearSavedData: true },
      { mode: "incremental", clearSavedData: true },
      { mode: "full", clearSavedData: true, sources: ["users"] },
      { mode: "full", clearSavedData: true, sources: ["users", "graph_packages", "power_platform", "usage_reports"] },
    ]) {
      expect(() => parseStartDataSyncInput(input)).toThrow(expect.objectContaining({
        status: 400, code: "invalid_data_sync_cleanup",
      }));
    }
    expect(() => parseRetryDataSyncInput({ clearSavedData: true })).toThrowError(AppError);
  });
});
