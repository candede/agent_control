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
});
