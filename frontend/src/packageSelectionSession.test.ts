import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => vi.restoreAllMocks());

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

  it.each([
    { raw: "{", count: 1 },
    { raw: JSON.stringify({ ids: [] }), count: 0 },
    { raw: JSON.stringify({ ids: "package-1" }), count: 1 },
    { raw: JSON.stringify({ ids: [null] }), count: 1 },
    { raw: JSON.stringify({ roles: ["AgentControl.Admin"] }), count: 1 },
    { raw: JSON.stringify({ inventory: { count: 1 } }), count: 1 },
    { raw: JSON.stringify({ inventory: null }), count: 1 },
    { raw: JSON.stringify({ version: 1 }), count: 1 },
    { raw: JSON.stringify({ owner: "other-owner" }), count: 1 },
  ])("rejects malformed or stale stored data $raw", ({ raw, count }) => {
    expect(storePackageSelection(reader, ["package-1"])).toBe(true);
    const key = window.sessionStorage.key(0)!;
    const stored = JSON.parse(window.sessionStorage.getItem(key)!);
    window.sessionStorage.setItem(key, raw === "{" ? raw : JSON.stringify({ ...stored, ...JSON.parse(raw) }));
    expect(restorePackageSelection(reader, count)).toEqual({ status: "unavailable" });
  });

  it("ignores role ordering but rejects changed authority", () => {
    const owner = { ...reader, roles: ["AgentControl.Viewer", "AgentControl.Admin"] as SessionUser["roles"] };
    expect(storePackageSelection(owner, ["package-1"])).toBe(true);
    expect(restorePackageSelection({ ...owner, roles: [...owner.roles].reverse() }, 1)).toEqual({ status: "restored", ids: ["package-1"] });
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
  });

  it("handles denied storage access and clears current and legacy records only for its owner", () => {
    const other = { ...reader, tenantId: "tenant-2" };
    expect(storePackageSelection(reader, ["package-1"])).toBe(true);
    expect(storePackageSelection(other, ["other-package"])).toBe(true);
    const legacyKey = `agent-control:package-selection:v1:${encodeURIComponent(`${reader.tenantId}:${reader.homeAccountId}`)}`;
    window.sessionStorage.setItem(legacyKey, "old-selection");
    vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => { throw new DOMException("Storage denied.", "SecurityError"); });
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
    clearPackageSelection(undefined);
    clearPackageSelection(reader);
    clearPackageSelection(reader);
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
    expect(window.sessionStorage.getItem(legacyKey)).toBeNull();
    expect(restorePackageSelection(other, 1)).toEqual({ status: "restored", ids: ["other-package"] });
  });

  it.each(["exact", "inventory"] as const)("retires the previous %s selection when its replacement cannot be stored", kind => {
    const otherTenant = { ...reader, tenantId: "other-tenant" };
    const inventory = { id: "old-pin", query: "{}", page: 0, allMatching: true, count: 1 };
    expect(storePackageSelection(reader, kind === "exact" ? ["old-package"] : [], kind === "inventory" ? inventory : undefined)).toBe(true);
    expect(storePackageSelection(otherTenant, ["other-package"])).toBe(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Session storage is full.", "QuotaExceededError");
    });

    expect(storePackageSelection(reader, ["replacement-package"])).toBe(false);
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
    expect(restorePackageSelection(otherTenant, 1)).toEqual({ status: "restored", ids: ["other-package"] });
    expect(storePackageSelection(reader, ["replacement-package"])).toBe(true);
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "restored", ids: ["replacement-package"] });
  });

  it.each(["clear", "replacement"] as const)("does not revive old targets if storage denies %s cleanup", operation => {
    const other = { ...reader, tenantId: "tenant-2" };
    expect(storePackageSelection(reader, ["old-package"])).toBe(true);
    expect(storePackageSelection(other, ["other-package"])).toBe(true);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => { throw new DOMException("Storage denied.", "SecurityError"); });
    if (operation === "replacement") {
      vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new DOMException("Storage denied.", "SecurityError"); });
      expect(storePackageSelection(reader, ["replacement-package"])).toBe(false);
    } else clearPackageSelection(reader);
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
    expect(restorePackageSelection(other, 1)).toEqual({ status: "restored", ids: ["other-package"] });
    expect(storePackageSelection(reader, ["replacement-package"])).toBe(true);
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "restored", ids: ["replacement-package"] });
  });

  it.each([{ ids: [] }, { ids: ["\0"] }])("does not retain old targets after rejecting replacement IDs $ids", ({ ids }) => {
    expect(storePackageSelection(reader, ["old-package"])).toBe(true);
    expect(storePackageSelection(reader, ids)).toBe(false);
    expect(restorePackageSelection(reader, 1)).toEqual({ status: "unavailable" });
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
      expect(storePackageSelection(reader, [], inventory)).toBe(true);
      expect(storePackageSelection(reader, [], invalid)).toBe(false);
      expect(restorePackageSelection(reader, 5_000)).toEqual({ status: "unavailable" });
    }
    expect(storePackageSelection(reader, [], inventory)).toBe(true);
    expect(storePackageSelection(reader, ["one"], inventory)).toBe(false);
    expect(restorePackageSelection(reader, 5_000)).toEqual({ status: "unavailable" });
  });
});
