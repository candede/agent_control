import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PackageAccessUpdate } from "../types/copilotPackage.js";
import {
  capturePackageMutationState, expectedPackageMutationState, packageMutationStateHash, packageMutationStatesEqual,
  type PackageAccessMutationState, type PackageMutationState,
} from "./packageMutationState.js";
import { allowlistedPackage } from "./packageObservation.js";
import { GraphPackagesClient, updatePackageAccess, verifyPackageMutationConverged, type FetchLike } from "./graphPackages.js";

describe("package access scope consistency", () => {
  it.each(["deployedToNoOne", "deployedToNone"])("treats %s as no access during capture, update and verification", async status => {
    const details = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false,
      availableTo: status, deployedTo: status, allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    });
    expect(capturePackageMutationState(details, "update-installation")).toEqual({
      kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    });
    const fetcher = vi.fn(async () => { throw new Error("A no-op must not contact the provider."); });
    const client = new GraphPackagesClient(fetcher);
    for (const target of ["availability", "installation"] as const) {
      const update: PackageAccessUpdate = { target, mode: "replace", scope: "none", principals: [] };
      const result = await updatePackageAccess(client, "token", details.id, update, details);
      expect(result).toEqual({ changed: false, previousCount: 0, resultingCount: 0, principals: [] });
      const action = target === "availability" ? "update-availability" : "update-installation";
      await expect(verifyPackageMutationConverged({ getPackageDetails: async () => details }, "token", details.id,
        action, expectedPackageMutationState(capturePackageMutationState(details, action), action, update)))
        .resolves.toMatchObject({ readbackCount: 1 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["all", "none", "deployedToNoOne", "deployedToNone"])("keeps explicit %s scope authoritative during state capture", status => {
    const principal = { resourceType: "user", resourceId: "user-1" };
    const details = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false,
      availableTo: status, deployedTo: status,
      allowedUsersAndGroups: [principal], acquireUsersAndGroups: [principal],
    });
    expect(capturePackageMutationState(details, "update-installation")).toEqual({
      kind: "access", availableTo: status === "all" ? "all" : "none", deployedTo: status === "all" ? "all" : "none",
      allowedUsersAndGroups: [principal], acquireUsersAndGroups: [principal],
    });
  });

  describe.each(["availability", "installation"] as const)("additive %s access", target => {
    it.each(["none", "deployedToNoOne", "deployedToNone"])("does not reactivate inactive principals under %s", async status => {
      const property = target === "availability" ? "allowedUsersAndGroups" : "acquireUsersAndGroups";
      const scopeProperty = target === "availability" ? "availableTo" : "deployedTo";
      const action = target === "availability" ? "update-availability" : "update-installation";
      const preserved = { resourceType: "group", resourceId: "preserved-group" };
      const requested = { resourceType: "user", resourceId: "requested-user" };
      const details = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false,
        availableTo: "some", deployedTo: "some",
        allowedUsersAndGroups: [preserved], acquireUsersAndGroups: [preserved],
        [scopeProperty]: status,
        [property]: [{ resourceType: "user", resourceId: "inactive-user" }],
      });
      const update: PackageAccessUpdate = { target, mode: "add", scope: "specific", principals: [requested] };
      const before = capturePackageMutationState(details, action);
      const expected = { ...before, [scopeProperty]: "some", [property]: [requested] };
      expect.soft(expectedPackageMutationState(before, action, update)).toEqual(expected);

      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
      const result = await updatePackageAccess(new GraphPackagesClient(fetcher), "token", details.id, update, details);
      expect(result).toEqual({ changed: true, previousCount: 1, resultingCount: 1, principals: [requested] });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
        allowedUsersAndGroups: target === "availability" ? [requested] : [preserved],
        acquireUsersAndGroups: target === "installation" ? [requested] : [preserved],
      });
      const applied = { ...details, [scopeProperty]: "some", [property]: [requested] };
      await expect(verifyPackageMutationConverged({ getPackageDetails: async () => applied }, "token", details.id, action, expected))
        .resolves.toMatchObject({ readbackCount: 1 });
      expect(capturePackageMutationState(applied, action)).toEqual(expected);
    });
  });

  it.each([undefined, "unknownFutureValue"])("preserves principal-based inference and ambiguity for %s", status => {
    const details = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false,
      availableTo: status, deployedTo: status, allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    });
    expect(() => capturePackageMutationState(details, "update-availability")).toThrow(
      "Both package access scopes must be unambiguous",
    );
    const principal = { resourceType: "user", resourceId: "user-1" };
    expect(capturePackageMutationState({
      ...details, allowedUsersAndGroups: [principal], acquireUsersAndGroups: [principal],
    }, "update-availability")).toMatchObject({ kind: "access", availableTo: "some", deployedTo: "some" });
  });
});

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

describe("package mutation state persistence", () => {
  const before: PackageAccessMutationState = {
    kind: "access", availableTo: "some", deployedTo: "some",
    allowedUsersAndGroups: [
      { resourceType: "group", resourceId: "group-1" },
      { resourceType: "user", resourceId: "user-1" },
    ],
    acquireUsersAndGroups: [{ resourceType: "group", resourceId: "group-2" }],
  };
  const stored: PackageAccessMutationState = {
    kind: "access", deployedTo: "some", availableTo: "some",
    acquireUsersAndGroups: [{ resourceId: "group-2", resourceType: "group" }],
    allowedUsersAndGroups: [
      { resourceId: "group-1", resourceType: "group" },
      { resourceId: "user-1", resourceType: "user" },
    ],
  };

  it("compares equal access states after JSONB-style key reordering", () => {
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(before));
    expect(packageMutationStatesEqual(before, stored)).toBe(true);
    expect(packageMutationStateHash(stored)).toBe(packageMutationStateHash(before));
  });

  it.each([false, true])("ignores block-state key order when isBlocked is %s", isBlocked => {
    expect(packageMutationStatesEqual(
      { kind: "block", isBlocked },
      { isBlocked, kind: "block" },
    )).toBe(true);
  });

  it("uses canonical principal identity and ordering without changing the input", () => {
    const reordered: PackageAccessMutationState = {
      ...stored,
      allowedUsersAndGroups: [
        { resourceId: " USER-1 ", resourceType: " User " },
        { resourceId: " GROUP-1 ", resourceType: " Group " },
      ],
    };
    const original = structuredClone(reordered);
    expect(packageMutationStatesEqual(before, reordered)).toBe(true);
    expect(reordered).toEqual(original);
  });

  it("preserves hashes already generated for captured states", () => {
    for (const state of [
      { kind: "block", isBlocked: false },
      { kind: "block", isBlocked: true },
      before,
      { ...before, availableTo: "none", allowedUsersAndGroups: [] },
      { ...before, deployedTo: "all", acquireUsersAndGroups: [] },
    ] satisfies PackageMutationState[]) {
      expect(packageMutationStateHash(state)).toBe(createHash("sha256").update(JSON.stringify(state)).digest("hex"));
    }
  });

  it("still distinguishes every control field and principal collection", () => {
    for (const changed of [
      { ...before, availableTo: "all" },
      { ...before, deployedTo: "none" },
      { ...before, allowedUsersAndGroups: [] },
      { ...before, acquireUsersAndGroups: [] },
      { ...before, allowedUsersAndGroups: [{ resourceType: "user", resourceId: "group-1" }] },
      { ...before, acquireUsersAndGroups: [{ resourceType: "group", resourceId: "group-3" }] },
      { kind: "block", isBlocked: false },
    ] satisfies PackageMutationState[]) {
      expect(packageMutationStatesEqual(before, changed)).toBe(false);
    }
    expect(packageMutationStatesEqual({ kind: "block", isBlocked: false }, { kind: "block", isBlocked: true })).toBe(false);
  });

  it("keeps duplicate-principal validation when comparing states", () => {
    expect(() => packageMutationStateHash({
      ...before,
      allowedUsersAndGroups: [
        { resourceType: "user", resourceId: "user-1" },
        { resourceType: "USER", resourceId: "USER-1" },
      ],
    })).toThrow("Duplicate package access principals");
  });

  describe.each(["availability", "installation"] as const)("%s reconciliation state", target => {
    it.each([
      { mode: "add", scope: "specific", principals: [{ resourceType: "user", resourceId: "user-2" }] },
      { mode: "replace", scope: "specific", principals: [{ resourceType: "user", resourceId: "user-2" }] },
      { mode: "replace", scope: "none", principals: [] },
    ] as const)("verifies a stored prestate projected with $mode/$scope", async update => {
      const accessUpdate: PackageAccessUpdate = update.scope === "none"
        ? { target, mode: update.mode, scope: update.scope, principals: [] }
        : { target, mode: update.mode, scope: update.scope, principals: [...update.principals] };
      const action = target === "availability" ? "update-availability" : "update-installation";
      const expected = expectedPackageMutationState(stored, action, accessUpdate);
      const details = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false,
        availableTo: before.availableTo, deployedTo: before.deployedTo,
        allowedUsersAndGroups: before.allowedUsersAndGroups, acquireUsersAndGroups: before.acquireUsersAndGroups,
      });
      expect(packageMutationStatesEqual(capturePackageMutationState(details, action), stored)).toBe(true);
      expect(packageMutationStatesEqual(capturePackageMutationState(details, action), expected)).toBe(false);

      if (expected.kind !== "access") throw new Error("An access update must project access state.");
      const applied = {
        ...details,
        availableTo: expected.availableTo, deployedTo: expected.deployedTo,
        allowedUsersAndGroups: expected.allowedUsersAndGroups, acquireUsersAndGroups: expected.acquireUsersAndGroups,
      };
      const provider = { getPackageDetails: vi.fn(async () => applied) };
      await expect(verifyPackageMutationConverged(provider, "token", details.id, action, expected, {
        maxAttempts: 1, delayMs: 0,
      })).resolves.toMatchObject({ state: expected, readbackCount: 1 });
      expect(provider.getPackageDetails).toHaveBeenCalledOnce();
    });
  });
});
