import { describe, expect, it } from "vitest";
import { expectedPackageMutationState, type PackageMutationState } from "./packageMutationState.js";

describe("package access projected state", () => {
  const first = { resourceType: "user", resourceId: "a" };
  const second = { resourceType: "group", resourceId: "b" };
  const before: PackageMutationState = {
    kind: "access", availableTo: "some", deployedTo: "some",
    allowedUsersAndGroups: [first], acquireUsersAndGroups: [second],
  };
  it("projects additive updates using the same union as the provider payload", () => {
    expect(expectedPackageMutationState(before, "update-availability", {
      target: "availability", mode: "add", scope: "specific", principals: [first, second],
    })).toEqual({ ...before, allowedUsersAndGroups: [second, first] });
    expect(expectedPackageMutationState(before, "update-installation", {
      target: "installation", mode: "add", scope: "specific", principals: [first, second],
    })).toEqual({ ...before, acquireUsersAndGroups: [second, first] });
  });
  it("preserves an all-users scope for an additive no-op and still projects replacement exactly", () => {
    const all = { ...before, availableTo: "all" as const };
    expect(expectedPackageMutationState(all, "update-availability", {
      target: "availability", mode: "add", scope: "specific", principals: [second],
    })).toEqual(all);
    expect(expectedPackageMutationState(before, "update-availability", {
      target: "availability", mode: "replace", scope: "specific", principals: [second],
    })).toEqual({ ...before, allowedUsersAndGroups: [second] });
  });
});
