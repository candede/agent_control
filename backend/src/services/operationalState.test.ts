import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query, stat } = vi.hoisted(() => ({ query: vi.fn(), stat: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: { query } }));
vi.mock("../config.js", () => ({ config: { nodeEnv: "test" } }));
vi.mock("node:fs", () => ({ statSync: stat }));

const normalRow = {
  mode: "normal",
  provider_work_enabled: true,
  restored_from_at: null,
  deletion_reviewed_at: null,
  access_reviewed_at: null,
};
let state: typeof import("./operationalState.js");
let maintenance: typeof import("./maintenance.js");

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("MAINTENANCE_MODE", undefined);
  vi.stubEnv("MAINTENANCE_FILE", undefined);
  query.mockReset().mockResolvedValue({ rowCount: 1, rows: [{ ...normalRow }] });
  stat.mockReset().mockImplementation(() => { throw Object.assign(new Error("Absent marker"), { code: "ENOENT" }); });
  state = await import("./operationalState.js");
  maintenance = await import("./maintenance.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("operational state", () => {
  it("reads the singleton and serializes nullable restoration review timestamps", async () => {
    expect(await state.readOperationalState()).toEqual({
      mode: "normal", providerWorkEnabled: true, restoredFromAt: null,
      deletionReviewedAt: null, accessReviewedAt: null,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM operational_state WHERE singleton=true"));
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      ...normalRow, provider_work_enabled: false,
      restored_from_at: new Date("2026-09-20T10:00:00Z"),
      deletion_reviewed_at: new Date("2026-09-20T11:00:00Z"),
      access_reviewed_at: new Date("2026-09-20T12:00:00Z"),
    }] });
    expect(await state.readOperationalState()).toEqual({
      mode: "normal", providerWorkEnabled: false, restoredFromAt: "2026-09-20T10:00:00.000Z",
      deletionReviewedAt: "2026-09-20T11:00:00.000Z", accessReviewedAt: "2026-09-20T12:00:00.000Z",
    });
  });

  it.each([
    { mode: "normal", enabled: true, code: null },
    { mode: "normal", enabled: false, code: "provider_requalification_required" },
    { mode: "maintenance", enabled: true, code: "maintenance" },
    { mode: "maintenance", enabled: false, code: "maintenance" },
  ])("aligns loaded $mode / provider-enabled $enabled status with admissions", async ({ mode, enabled, code }) => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...normalRow, mode, provider_work_enabled: enabled }] });
    expect(await state.loadOperationalState()).toMatchObject({ mode, providerWorkEnabled: enabled });
    expect(state.providerWorkEnabled()).toBe(code === null);
    if (code) {
      expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ status: 503, code }));
    } else {
      expect(() => state.requireProviderAdmissions()).not.toThrow();
    }
  });

  it("does not change the loaded admission gate on a diagnostic read", async () => {
    query.mockResolvedValue({ rowCount: 1, rows: [{ ...normalRow, provider_work_enabled: false }] });
    await state.loadOperationalState();
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...normalRow }] });
    expect(await state.readOperationalState()).toMatchObject({ providerWorkEnabled: true });
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "provider_requalification_required" }));
  });

  it("propagates missing state and query failures without reopening a closed gate", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...normalRow, mode: "maintenance" }] });
    await state.loadOperationalState();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(state.loadOperationalState()).rejects.toThrow("Operational state is missing.");
    query.mockRejectedValueOnce(new Error("Read failed"));
    await expect(state.loadOperationalState()).rejects.toThrow("Read failed");
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
  });

  it("reports provider work disabled while environment maintenance blocks admissions", async () => {
    await state.loadOperationalState();
    vi.stubEnv("MAINTENANCE_MODE", "true");
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
    expect(state.providerWorkEnabled()).toBe(false);
    vi.stubEnv("MAINTENANCE_MODE", "false");
    expect(state.providerWorkEnabled()).toBe(true);
    expect(() => state.requireProviderAdmissions()).not.toThrow();
  });

  it.each(["present", "EACCES", "ENOTDIR"])("reports provider work disabled with a %s maintenance marker", async outcome => {
    await state.loadOperationalState();
    vi.stubEnv("MAINTENANCE_FILE", "fixture-maintenance-marker");
    stat.mockImplementation(() => {
      if (outcome !== "present") throw Object.assign(new Error("Marker unavailable"), { code: outcome });
      return {};
    });
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
    expect(state.providerWorkEnabled()).toBe(false);
  });

  it("allows provider work with an absent marker", async () => {
    await state.loadOperationalState();
    vi.stubEnv("MAINTENANCE_FILE", "fixture-maintenance-marker");
    expect(state.providerWorkEnabled()).toBe(true);
    expect(() => state.requireProviderAdmissions()).not.toThrow();
  });

  it("keeps draining reflected in provider status after a normal state reload", async () => {
    await state.loadOperationalState();
    maintenance.enterMaintenance();
    await state.loadOperationalState();
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
    expect(state.providerWorkEnabled()).toBe(false);
  });
});
