import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, statSync: vi.fn(fs.statSync) };
});

let maintenance: typeof import("./maintenance.js");
let directory: string;
let marker: string;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("MAINTENANCE_MODE", undefined);
  vi.stubEnv("MAINTENANCE_FILE", undefined);
  directory = join(process.cwd(), `.maintenance-test-${randomUUID()}`);
  marker = join(directory, "maintenance");
  mkdirSync(directory);
  maintenance = await import("./maintenance.js");
});

afterEach(() => {
  vi.mocked(statSync).mockReset();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("maintenance admissions", () => {
  it("admits work with no configured marker or an absent marker", () => {
    expect(maintenance.maintenanceActive()).toBe(false);
    expect(() => maintenance.requireAdmissions()).not.toThrow();
    expect(statSync).not.toHaveBeenCalled();
    vi.stubEnv("MAINTENANCE_FILE", marker);
    expect(maintenance.maintenanceActive()).toBe(false);
    expect(() => maintenance.requireAdmissions()).not.toThrow();
  });

  it.each(["", "false", "TRUE", "1"])("preserves the exact true environment switch, not %j", value => {
    vi.stubEnv("MAINTENANCE_MODE", value);
    expect(maintenance.maintenanceActive()).toBe(false);
    vi.stubEnv("MAINTENANCE_MODE", "true");
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    expect(statSync).not.toHaveBeenCalled();
    vi.stubEnv("MAINTENANCE_MODE", value);
    expect(maintenance.maintenanceActive()).toBe(false);
  });

  it("follows marker creation and removal without requiring contents or a restart", () => {
    vi.stubEnv("MAINTENANCE_FILE", marker);
    writeFileSync(marker, "");
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    rmSync(marker);
    expect(maintenance.maintenanceActive()).toBe(false);
    mkdirSync(marker);
    expect(maintenance.maintenanceActive()).toBe(true);
  });

  it.each(["EACCES", "EPERM", "EIO", "ELOOP", "ENOTDIR"])("fails closed when marker inspection returns %s", code => {
    vi.stubEnv("MAINTENANCE_FILE", marker);
    vi.mocked(statSync).mockImplementation(() => { throw Object.assign(new Error("Private filesystem detail"), { code }); });
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({
      status: 503, code: "maintenance", message: "Maintenance is active; new work is not accepted.",
    }));
    vi.mocked(statSync).mockReset();
    expect(maintenance.maintenanceActive()).toBe(false);
  });

  it("fails closed for a real marker symlink loop", () => {
    symlinkSync("maintenance", marker);
    vi.stubEnv("MAINTENANCE_FILE", marker);
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
  });

  it("keeps process draining active after external maintenance switches are removed", () => {
    vi.stubEnv("MAINTENANCE_FILE", marker);
    writeFileSync(marker, "");
    vi.stubEnv("MAINTENANCE_MODE", "true");
    maintenance.enterMaintenance();
    maintenance.enterMaintenance();
    rmSync(marker);
    vi.stubEnv("MAINTENANCE_MODE", "false");
    expect(maintenance.maintenanceActive()).toBe(true);
    expect(() => maintenance.requireAdmissions()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    expect(statSync).not.toHaveBeenCalled();
  });
});
