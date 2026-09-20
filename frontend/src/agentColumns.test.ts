import { afterEach, describe, expect, it, vi } from "vitest";
import { agentColumns, agentViewOptions, defaultAgentColumnVisibility, loadAgentColumns, saveAgentColumns } from "./agentColumns";
import { unifiedAgentSortKeys } from "../../backend/src/types/unifiedAgents";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("agent column preferences", () => {
  it("describes automatic and existing reviewed evidence for selected-report usage filters", () => {
    const used = agentViewOptions.find(option => option.value === "used")!;
    expect(used.description).toContain("matched automatically by exact saved package ID");
    expect(used.description).toContain("existing administrator-reviewed association");
    expect(used.description).toContain("not a live or all-channel activity measure");
    expect(agentViewOptions.find(option => option.value === "organization")!.description).toContain("does not establish end-user access");
    expect(agentViewOptions.find(option => option.value === "all")!.label).toBe("All agents in repository");
    expect(agentViewOptions.find(option => option.value === "available")!.label).toBe("Available to end users");
  });

  it("offers every supported data column exactly once and keeps the original defaults", () => {
    expect(agentColumns.filter(column => column.id !== "actions").map(column => column.id).sort()).toEqual([...unifiedAgentSortKeys].sort());
    expect(Object.entries(defaultAgentColumnVisibility).filter(([, visible]) => visible).map(([id]) => id))
      .toEqual(["displayName", "environment", "builtWith", "availability", "status", "actions"]);
  });

  it("persists only column choices and isolates accounts and tenants", () => {
    const choices = { ...defaultAgentColumnVisibility, hosts: true, environment: false };
    expect(saveAgentColumns("tenant-a:user-a", choices)).toBeUndefined();
    expect(loadAgentColumns("tenant-a:user-a")).toEqual({ visibility: choices });
    expect(loadAgentColumns("tenant-a:user-b").visibility).toEqual(defaultAgentColumnVisibility);
    expect(loadAgentColumns("tenant-b:user-a").visibility).toEqual(defaultAgentColumnVisibility);
    expect(saveAgentColumns(undefined, choices)).toBeUndefined();
    expect(window.localStorage.length).toBe(1);
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
