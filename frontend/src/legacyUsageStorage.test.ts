import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLegacyUsageStorage, hasLegacyUsageStorage, legacyUsageStorageKey } from "./legacyUsageStorage";

beforeEach(() => localStorage.clear());

describe("legacy usage storage cutover", () => {
  it("detects key presence without reading its untrusted value", () => {
    localStorage.setItem("unrelated", "preserve");
    localStorage.setItem(legacyUsageStorageKey, "private legacy rows");
    const getItem = vi.spyOn(Storage.prototype, "getItem");

    expect(hasLegacyUsageStorage()).toBe(true);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("removes only the legacy usage key after explicit acknowledgement", () => {
    localStorage.setItem("unrelated", "preserve");
    localStorage.setItem(legacyUsageStorageKey, "private legacy rows");

    clearLegacyUsageStorage();

    expect(hasLegacyUsageStorage()).toBe(false);
    expect(localStorage.getItem("unrelated")).toBe("preserve");
  });
});
