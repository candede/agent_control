import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { stat, lstat } = vi.hoisted(() => ({ stat: vi.fn(), lstat: vi.fn() }));
vi.mock("node:fs", () => ({ statSync: stat, lstatSync: lstat }));
vi.mock("../config.js", () => ({ config: { nodeEnv: "test" } }));

let maintenance: typeof import("./maintenance.js");

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("MAINTENANCE_MODE", undefined);
  vi.stubEnv("MAINTENANCE_FILE", "fixture-maintenance-marker");
  stat.mockReset().mockImplementation(() => { throw Object.assign(new Error("Missing target"), { code: "ENOENT" }); });
  lstat.mockReset().mockReturnValue({ isSymbolicLink: () => true });
  maintenance = await import("./maintenance.js");
});

afterEach(() => vi.unstubAllEnvs());

describe("maintenance marker identity", () => {
  it.each(["", "false", "TRUE", "1"])("preserves the exact true environment switch rather than %j", value => {
    vi.stubEnv("MAINTENANCE_FILE", undefined);
    vi.stubEnv("MAINTENANCE_MODE", value);
    expect(maintenance.maintenanceActive()).toBe(false);
    expect(() => maintenance.requireAdmissions()).not.toThrow();
    vi.stubEnv("MAINTENANCE_MODE", "true");
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    vi.stubEnv("MAINTENANCE_MODE", value);
    expect(maintenance.maintenanceActive()).toBe(false);
    expect(lstat).not.toHaveBeenCalled();
  });

  it("keeps admissions closed for a dangling symlink rather than inspecting its missing target", () => {
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    expect(lstat).toHaveBeenCalledWith("fixture-maintenance-marker");
    expect(stat).not.toHaveBeenCalled();
  });

  it("reopens only when the marker itself is absent", () => {
    expect(maintenance.maintenanceActive()).toBe(true);
    lstat.mockImplementation(() => { throw Object.assign(new Error("Missing marker"), { code: "ENOENT" }); });
    expect(maintenance.maintenanceActive()).toBe(false);
    expect(() => maintenance.requireAdmissions()).not.toThrow();
    lstat.mockReturnValue({});
    expect(maintenance.maintenanceActive()).toBe(true);
  });

  it.each(["EACCES", "EPERM", "EIO", "ELOOP", "ENOTDIR"])("fails closed when marker inspection fails with %s", code => {
    lstat.mockImplementation(() => { throw Object.assign(new Error("Private filesystem detail"), { code }); });
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({
      status: 503, code: "maintenance", message: "Maintenance is active; new work is not accepted.",
    }));
  });

  it("never reopens a draining process after the marker disappears", () => {
    maintenance.enterMaintenance();
    maintenance.enterMaintenance();
    lstat.mockImplementation(() => { throw Object.assign(new Error("Missing marker"), { code: "ENOENT" }); });
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ code: "maintenance" }));
    expect(lstat).not.toHaveBeenCalled();
  });
});
