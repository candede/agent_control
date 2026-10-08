import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAccessOptions, agentColumns, agentUsageOptions, defaultAgentColumnVisibility, loadAgentColumns, saveAgentColumns } from "./agentColumns";
import { unifiedAgentSortKeys } from "../../backend/src/types/unifiedAgents";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("agent column preferences", () => {
  it("describes automatic and existing reviewed evidence for selected-report usage filters", () => {
    const used = agentUsageOptions.find(option => option.value === "used")!;
    expect(used.description).toContain("matched automatically by exact saved package ID");
    expect(used.description).toContain("existing administrator-reviewed association");
    expect(used.description).toContain("not a live or all-channel activity measure");
    expect(agentColumns.find(column => column.id === "origin")!.label).toBe("Package type");
    expect(agentAccessOptions.find(option => option.value === "available")!.label).toBe("Available to end users");
  });

  it("orders the requested defaults by identity, usage and access while retaining every optional column", () => {
    expect(agentColumns.filter(column => column.id !== "actions").map(column => column.id).sort()).toEqual([...unifiedAgentSortKeys].sort());
    expect(Object.entries(defaultAgentColumnVisibility).filter(([, visible]) => visible).map(([id]) => id))
      .toEqual(["displayName", "publisher", "builtWith", "responses", "availability", "status", "actions"]);
    expect(agentColumns.filter(column => defaultAgentColumnVisibility[column.id]).map(column => column.label))
      .toEqual(["Agent", "Publisher", "Built with", "Responses", "End-user access", "Status", "Actions"]);
    expect(loadAgentColumns("new-account").visibility).toEqual(defaultAgentColumnVisibility);
  });

  it("persists only column choices and isolates accounts and tenants", () => {
    const choices = { ...defaultAgentColumnVisibility, hosts: true, environment: false };
    expect(saveAgentColumns("tenant-a:user-a", choices)).toBeUndefined();
    expect(loadAgentColumns("tenant-a:user-a")).toEqual({ visibility: choices });
    expect(loadAgentColumns("tenant-a:user-b").visibility).toEqual(defaultAgentColumnVisibility);
    expect(loadAgentColumns("tenant-b:user-a").visibility).toEqual(defaultAgentColumnVisibility);
    expect(saveAgentColumns(undefined, choices)).toBeUndefined();
    expect(window.localStorage.length).toBe(1);
    expect(JSON.parse(window.localStorage.getItem(window.localStorage.key(0)!)!)).toEqual({ version: 1, visibility: choices });
  });

  it("does not read or write browser storage without an account owner", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(loadAgentColumns()).toEqual({ visibility: defaultAgentColumnVisibility });
    expect(saveAgentColumns(undefined, { ...defaultAgentColumnVisibility, hosts: true })).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("returns independent defaults and fills missing columns without rewriting stored preferences", () => {
    const first = loadAgentColumns("new-account");
    first.visibility.publisher = false;
    expect(loadAgentColumns("new-account").visibility.publisher).toBe(true);
    expect(defaultAgentColumnVisibility.publisher).toBe(true);
    saveAgentColumns("existing-admin", { publisher: false, hosts: true });
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(loadAgentColumns("existing-admin").visibility).toEqual({
      ...defaultAgentColumnVisibility, publisher: false, hosts: true,
    });
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ version: 2, visibility: {} }),
    JSON.stringify({ version: 1, visibility: [] }),
    JSON.stringify({ version: 1, visibility: { publisher: "false" } }),
  ])("reports malformed stored preferences without overwriting them: %s", raw => {
    saveAgentColumns("owner", defaultAgentColumnVisibility);
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, raw);
    expect(loadAgentColumns("owner")).toEqual({
      visibility: defaultAgentColumnVisibility, error: expect.stringContaining("Column preferences could not be loaded."),
    });
    expect(window.localStorage.getItem(key)).toBe(raw);
  });

  it("preserves existing admins' saved visibility rather than forcing the new defaults", () => {
    const previousSelection = { ...defaultAgentColumnVisibility, publisher: false, responses: false, environment: true, createdBy: true };
    saveAgentColumns("existing-admin", previousSelection);
    expect(loadAgentColumns("existing-admin").visibility).toEqual(previousSelection);
  });

  it("never restores a hidden agent identity column", () => {
    saveAgentColumns("owner", { ...defaultAgentColumnVisibility, displayName: false });
    expect(loadAgentColumns("owner").visibility.displayName).toBe(true);
  });

  it("reports invalid or inaccessible storage instead of silently losing preferences", () => {
    saveAgentColumns("owner", { injected: true });
    expect(loadAgentColumns("owner")).toMatchObject({ visibility: defaultAgentColumnVisibility, error: expect.stringContaining("unsupported column") });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    expect(loadAgentColumns("owner").error).toContain("could not be loaded");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    expect(saveAgentColumns("owner", defaultAgentColumnVisibility)).toContain("could not be saved");
  });
});
