import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { query, stat } = vi.hoisted(() => ({ query: vi.fn(), stat: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: { query } }));
vi.mock("../config.js", () => ({ config: { nodeEnv: "test" } }));
vi.mock("node:fs", () => ({ lstatSync: stat }));

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
  it("does not admit provider work before a validated initial load completes", async () => {
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    await state.readOperationalState();
    expect(state.providerWorkEnabled()).toBe(false);
    const initial = Promise.withResolvers<{ rowCount: number; rows: typeof normalRow[] }>();
    query.mockReturnValueOnce(initial.promise);
    const loading = state.loadOperationalState();
    expect(state.providerWorkEnabled()).toBe(false);
    initial.resolve({ rowCount: 1, rows: [{ ...normalRow }] });
    await loading;
    expect(state.providerWorkEnabled()).toBe(true);
  });

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

  it.each([
    { label: "duplicate singleton", rowCount: 2, rows: [normalRow, normalRow] },
    { label: "unreported duplicate", rowCount: 1, rows: [normalRow, normalRow] },
    { label: "absent row", rowCount: 1, rows: [] },
    { label: "unknown count", rowCount: null, rows: [normalRow] },
    { label: "mode", rowCount: 1, rows: [{ ...normalRow, mode: "NORMAL" }] },
    { label: "null mode", rowCount: 1, rows: [{ ...normalRow, mode: null }] },
    { label: "truthy boolean string", rowCount: 1, rows: [{ ...normalRow, provider_work_enabled: "false" }] },
    { label: "numeric boolean", rowCount: 1, rows: [{ ...normalRow, provider_work_enabled: 1 }] },
    { label: "null boolean", rowCount: 1, rows: [{ ...normalRow, provider_work_enabled: null }] },
    { label: "missing boolean", rowCount: 1, rows: [{ ...normalRow, provider_work_enabled: undefined }] },
    { label: "null row", rowCount: 1, rows: [null] },
    ...["restored_from_at", "deletion_reviewed_at", "access_reviewed_at"].flatMap(field =>
      [undefined, "2026-09-20T10:00:00Z", new Date(NaN), Infinity].map(value => ({
        label: `invalid ${field} ${String(value)}`, rowCount: 1,
        rows: [{ ...normalRow, [field]: value }],
      })),
    ),
  ])("rejects $label and closes an open gate until valid recovery", async result => {
    await state.loadOperationalState();
    query.mockResolvedValueOnce(result);
    await expect(state.loadOperationalState()).rejects.toThrow("Operational state");
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    await state.readOperationalState();
    expect(state.providerWorkEnabled()).toBe(false);
    await state.loadOperationalState();
    expect(state.providerWorkEnabled()).toBe(true);
  });

  it.each([1, 2, 3, 4, 5, 6])("rejects incomplete restoration review evidence (presence mask %s)", async mask => {
    const date = new Date("2026-09-20T10:00:00Z");
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      ...normalRow, restored_from_at: mask & 1 ? date : null,
      deletion_reviewed_at: mask & 2 ? date : null, access_reviewed_at: mask & 4 ? date : null,
    }] });
    await expect(state.loadOperationalState()).rejects.toThrow("Operational state restoration review is incomplete.");
    expect(state.providerWorkEnabled()).toBe(false);
  });

  it("detaches the cached state from database rows, timestamps, and every returned snapshot", async () => {
    const date = new Date("2026-09-20T10:00:00Z");
    const row = { ...normalRow, restored_from_at: date, deletion_reviewed_at: date, access_reviewed_at: date };
    query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    const loaded = await state.loadOperationalState();
    row.mode = "maintenance";
    row.provider_work_enabled = false;
    date.setTime(NaN);
    loaded.mode = "maintenance";
    loaded.providerWorkEnabled = false;
    loaded.restoredFromAt = null;
    expect(state.providerWorkEnabled()).toBe(true);
    expect(() => state.requireProviderAdmissions()).not.toThrow();
    const diagnostic = await state.readOperationalState();
    diagnostic.mode = "maintenance";
    diagnostic.providerWorkEnabled = false;
    expect(state.providerWorkEnabled()).toBe(true);
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

  it.each(["missing singleton", "read failure"])("closes a previously open gate after a %s until a successful load", async outcome => {
    await state.loadOperationalState();
    if (outcome === "missing singleton") query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    else query.mockRejectedValueOnce(new Error("Read failed"));
    await expect(state.loadOperationalState()).rejects.toThrow();
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    await state.readOperationalState();
    expect(state.providerWorkEnabled()).toBe(false);
    await state.loadOperationalState();
    expect(state.providerWorkEnabled()).toBe(true);
  });

  it("does not expose the admission gate through the returned state object", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...normalRow, provider_work_enabled: false }] });
    const loaded = await state.loadOperationalState();
    loaded.providerWorkEnabled = true;
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({ code: "provider_requalification_required" }));
  });

  it.each(["maintenance", "requalification", "read failure"])("does not let an older load reopen a newer %s fence", async closure => {
    const older = Promise.withResolvers<{ rowCount: number; rows: typeof normalRow[] }>();
    query.mockReturnValueOnce(older.promise);
    const pending = state.loadOperationalState();
    if (closure === "read failure") {
      query.mockRejectedValueOnce(new Error("Read failed"));
      await expect(state.loadOperationalState()).rejects.toThrow("Read failed");
    } else {
      query.mockResolvedValueOnce({ rowCount: 1, rows: [{
        ...normalRow, mode: closure === "maintenance" ? "maintenance" : "normal",
        provider_work_enabled: closure !== "requalification",
      }] });
      await state.loadOperationalState();
    }
    older.resolve({ rowCount: 1, rows: [{ ...normalRow }] });
    await pending;
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({
      code: closure === "requalification" ? "provider_requalification_required" : "maintenance",
    }));
  });

  it("does not let an older failed load replace a newer successful load", async () => {
    const older = Promise.withResolvers<never>();
    query.mockReturnValueOnce(older.promise);
    const pending = state.loadOperationalState();
    const rejected = expect(pending).rejects.toThrow("Read failed");
    await state.loadOperationalState();
    older.reject(new Error("Read failed"));
    await rejected;
    expect(state.providerWorkEnabled()).toBe(true);
  });

  it.each(["maintenance", "requalification", "read failure"])("honors a completed %s fence while a newer load remains pending", async closure => {
    await state.loadOperationalState();
    const first = Promise.withResolvers<{ rowCount: number; rows: typeof normalRow[] }>();
    const next = Promise.withResolvers<{ rowCount: number; rows: typeof normalRow[] }>();
    query.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const loadingFirst = state.loadOperationalState(), loadingNext = state.loadOperationalState();
    if (closure === "read failure") {
      const rejected = expect(loadingFirst).rejects.toThrow("Read failed");
      first.reject(new Error("Read failed"));
      await rejected;
    } else {
      first.resolve({ rowCount: 1, rows: [{
        ...normalRow, mode: closure === "maintenance" ? "maintenance" : "normal",
        provider_work_enabled: closure !== "requalification",
      }] });
      await loadingFirst;
    }
    expect(state.providerWorkEnabled()).toBe(false);
    expect(() => state.requireProviderAdmissions()).toThrow(expect.objectContaining({
      code: closure === "requalification" ? "provider_requalification_required" : "maintenance",
    }));
    next.resolve({ rowCount: 1, rows: [{ ...normalRow }] });
    await loadingNext;
    expect(state.providerWorkEnabled()).toBe(true);
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

  it.each(["present", "dangling symlink", "EACCES", "ENOTDIR"])("reports provider work disabled with a %s maintenance marker", async outcome => {
    await state.loadOperationalState();
    vi.stubEnv("MAINTENANCE_FILE", "fixture-maintenance-marker");
    stat.mockImplementation(() => {
      if (outcome !== "present" && outcome !== "dangling symlink") throw Object.assign(new Error("Marker unavailable"), { code: outcome });
      return { isSymbolicLink: () => outcome === "dangling symlink" };
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
