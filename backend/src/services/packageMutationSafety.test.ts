import { describe, expect, it } from "vitest";
import { packageMutationOperationSafe, requirePackageMutationOperationSafe } from "./packageMutationSafety.js";

describe("package mutation operation safety", () => {
  it("allows only block transitions with immediate prestate comparison", () => {
    expect(packageMutationOperationSafe("block")).toBe(true);
    expect(packageMutationOperationSafe("unblock")).toBe(true);
    expect(() => requirePackageMutationOperationSafe("block")).not.toThrow();
  });

  it("keeps access replacement and reassignment disabled independently of generic qualification", () => {
    for (const action of ["update-availability", "update-installation", "reassign"] as const) {
      expect(packageMutationOperationSafe(action)).toBe(false);
      expect(() => requirePackageMutationOperationSafe(action)).toThrowError(expect.objectContaining({ code: "package_operation_safety_unavailable" }));
    }
  });
});