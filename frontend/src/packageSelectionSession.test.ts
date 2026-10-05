import { beforeEach, describe, expect, it } from "vitest";
import type { SessionUser } from "./api/client";
import { clearPackageSelection, restorePackageSelection, storePackageSelection } from "./packageSelectionSession";

const reader: SessionUser = {
  displayName: "Viewer",
  username: "reader@example.invalid",
  homeAccountId: "reader-1",
  tenantId: "tenant-1",
  roles: ["AgentControl.Viewer"],
};

describe("package selection session state", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("round trips all 5000 package IDs only for the owning principal", () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => `package-${index}`);
    expect(storePackageSelection(reader, ids)).toBe(true);
    expect(restorePackageSelection(reader, ids.length)).toEqual({ status: "restored", ids });
    expect(restorePackageSelection({ ...reader, homeAccountId: "other" }, ids.length)).toEqual({ status: "unavailable" });
  });

  it("does not restore a partial or stale selection as the requested selection", () => {
    expect(storePackageSelection(reader, ["package-1", "package-2"])).toBe(true);
    expect(restorePackageSelection(reader, 3)).toEqual({ status: "unavailable" });
    clearPackageSelection(reader);
    expect(restorePackageSelection(reader, 2)).toEqual({ status: "unavailable" });
  });

  it("preserves a pinned 5000-target group without materializing its member IDs", () => {
    const inventory = { id: "selected-pin", query: '{"inventoryScope":"catalog"}', cursor: "page-two", page: 1,
      groups: ["large-group"], count: 5_000 };
    expect(storePackageSelection(reader, [], inventory)).toBe(true);
    expect(restorePackageSelection(reader, 5_000)).toEqual({ status: "restored", ids: [], inventory });
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)!.length).toBeLessThan(512);
    expect(restorePackageSelection({ ...reader, roles: ["AgentControl.Admin"] }, 5_000)).toEqual({ status: "unavailable" });
    expect(restorePackageSelection({ ...reader, tenantId: "other-tenant" }, 5_000)).toEqual({ status: "unavailable" });
  });

  it("preserves server-filtered selection without storing a source-wide ID set", () => {
    const inventory = { id: "selected-pin", query: '{"blocked":true}', page: 0, allMatching: true, count: 5_000 };
    expect(storePackageSelection(reader, [], inventory)).toBe(true);
    expect(restorePackageSelection(reader, 5_000)).toEqual({ status: "restored", ids: [], inventory });
    clearPackageSelection(reader);
    expect(restorePackageSelection(reader, 5_000)).toEqual({ status: "unavailable" });
  });

  it("rejects oversized, ambiguous and malformed server selections without truncation", () => {
    const inventory = { id: "selected-pin", query: "{}", page: 0, allMatching: true, count: 5_000 };
    for (const invalid of [{ ...inventory, count: 5_001 }, { ...inventory, count: 0 },
      { ...inventory, groups: ["group"] }, { ...inventory, cursor: "x".repeat(4_097) },
      { ...inventory, page: -1 }, { ...inventory, id: "\0" }]) {
      expect(storePackageSelection(reader, [], invalid)).toBe(false);
    }
    expect(storePackageSelection(reader, ["one"], inventory)).toBe(false);
    expect(restorePackageSelection(reader, 5_000)).toEqual({ status: "unavailable" });
  });
});
