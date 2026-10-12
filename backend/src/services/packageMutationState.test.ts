import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createJobConfirmation } from "../db/jobs.js";
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
        sharedWithUsersAndGroups: [{ resourceType: "user", resourceId: "unrelated-sharing-recipient" }],
        [scopeProperty]: status,
        [property]: [{ resourceType: "user", resourceId: "inactive-user" }],
      });
      const update: PackageAccessUpdate = { target, mode: "add", scope: "specific", principals: [requested] };
      const before = capturePackageMutationState(details, action);
      expect(before).not.toHaveProperty("sharedWithUsersAndGroups");
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

  it.each([undefined, "unknownFutureValue"])("does not infer an explicit unknown scope from stored principals: %s", status => {
    const details = allowlistedPackage({
      id: "package", displayName: "Package", isBlocked: false,
      availableTo: status, deployedTo: status, allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    });
    expect(() => capturePackageMutationState(details, "update-availability")).toThrow(
      "Both package access scopes must be unambiguous",
    );
    const principal = { resourceType: "user", resourceId: "user-1" };
    const populated = {
      ...details, allowedUsersAndGroups: [principal], acquireUsersAndGroups: [principal],
    };
    if (status === undefined) expect(capturePackageMutationState(populated, "update-availability"))
      .toMatchObject({ kind: "access", availableTo: "some", deployedTo: "some" });
    else expect(() => capturePackageMutationState(populated, "update-availability"))
      .toThrow(expect.objectContaining({ code: "ambiguous_access_scope" }));
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

  it.each([
    { target: "other" },
    { mode: "remove" },
    { scope: "all" },
    { principals: [] },
    { mode: "add", scope: "none", principals: [] },
    { scope: "none" },
  ])("rejects malformed durable access intent %j rather than projecting a different write", invalid => {
    const update = JSON.parse(JSON.stringify({
      target: "availability", mode: "replace", scope: "specific", principals: [first], ...invalid,
    }));
    expect(() => expectedPackageMutationState(before, "update-availability", update))
      .toThrow(expect.objectContaining({ code: "invalid_access_update" }));
  });

  it("requires the access target to match the action even during read-only projection", () => {
    expect(() => expectedPackageMutationState(before, "update-installation", {
      target: "availability", mode: "replace", scope: "specific", principals: [second],
    })).toThrow(expect.objectContaining({ code: "mutation_state_mismatch" }));
  });
});

describe("durable package mutation state bounds", () => {
  const actor = { tenantId: "tenant", homeAccountId: "admin", displayName: "Admin", username: "admin@example.invalid" };
  const principals = Array.from({ length: 1000 }, (_, index) => ({
    resourceType: "user", resourceId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
  }));
  const before: PackageAccessMutationState = {
    kind: "access", availableTo: "some", deployedTo: "none",
    allowedUsersAndGroups: principals.slice(0, 500), acquireUsersAndGroups: [],
  };
  const input = {
    action: "update-availability" as const, actor, scope: "bulk" as const, requestPath: "/api/agents/access",
    targets: [{ id: "package", displayName: "Package", prestate: before }],
  };

  it("rejects an additive intent whose individually bounded prestate and selection produce an unpersistable poststate", () => {
    const accessUpdate: PackageAccessUpdate = {
      target: "availability", mode: "add", scope: "specific", principals: principals.slice(500),
    };
    expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThan(65_000);
    expect(Buffer.byteLength(JSON.stringify(accessUpdate))).toBeLessThan(60_000);
    expect(Buffer.byteLength(JSON.stringify(expectedPackageMutationState(before, input.action, accessUpdate))))
      .toBeGreaterThan(65_536);
    expect(() => createJobConfirmation({ ...input, accessUpdate }))
      .toThrow(expect.objectContaining({ status: 413, code: "mutation_state_too_large" }));
  });

  it("accounts for JSONB punctuation rather than admitting a compact JSON prestate above the database limit", () => {
    const prestate = { ...before, allowedUsersAndGroups: Array.from({ length: 1400 }, (_, index) => ({
      resourceType: "user", resourceId: `p${index.toString(36)}`,
    })) };
    expect(Buffer.byteLength(JSON.stringify(prestate))).toBeLessThan(65_000);
    expect(() => createJobConfirmation({
      ...input, targets: [{ ...input.targets[0], prestate }],
      accessUpdate: { target: "availability", mode: "add", scope: "specific", principals: [prestate.allowedUsersAndGroups[0]] },
    })).toThrow(expect.objectContaining({ status: 413, code: "mutation_state_too_large" }));
  });

  it("still admits a bounded additive no-op at the selected-directory limit", () => {
    const confirmation = createJobConfirmation({
      ...input, accessUpdate: { target: "availability", mode: "add", scope: "specific", principals: principals.slice(0, 500) },
    });
    expect(confirmation.summary.targets[0].requestedState).toEqual(before);
  });
});

describe("package access preservation admission", () => {
  const requested = { resourceType: "user", resourceId: "11111111-1111-4111-8111-111111111111" };
  const preserved = { resourceType: "group", resourceId: " Exact_Opaque_Group " };
  const actor = { tenantId: "tenant", homeAccountId: "admin", displayName: "Admin", username: "admin@example.invalid" };

  describe.each(["availability", "installation"] as const)("%s changes", target => {
    const action = target === "availability" ? "update-availability" : "update-installation";
    const unselectedScope = target === "availability" ? "deployedTo" : "availableTo";
    const unselectedCollection = target === "availability" ? "acquireUsersAndGroups" : "allowedUsersAndGroups";
    const update: PackageAccessUpdate = { target, mode: "replace", scope: "specific", principals: [requested] };

    it.each([
      { scope: "all", principals: [] },
      { scope: "deployedToAll", principals: [preserved] },
      { scope: "deployedToNone", principals: [preserved] },
      { scope: "some", principals: [] },
    ])("rejects an untouched $scope scope that the full PATCH cannot preserve", async ({ scope, principals }) => {
      const details = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false,
        availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
        [unselectedScope]: scope, [unselectedCollection]: principals,
      });
      const before = capturePackageMutationState(details, action);
      expect.soft(() => createJobConfirmation({
        action, accessUpdate: update, targets: [{ id: details.id, displayName: details.displayName, prestate: before }],
        actor, scope: "single", requestPath: "/api/agents/package/access",
      })).toThrow(expect.objectContaining({ code: "unpreservable_access_scope" }));

      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
      const beforeWrite = vi.fn(async () => undefined);
      await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", details.id, update, details, beforeWrite))
        .rejects.toMatchObject({ code: "unpreservable_access_scope" });
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();

      // Historical sent jobs still need a projected state for GET-only reconciliation.
      const expected = expectedPackageMutationState(before, action, update);
      expect(packageMutationStatesEqual(before, expected)).toBe(false);
      const applied = { ...details, ...expected };
      await expect(verifyPackageMutationConverged({ getPackageDetails: async () => applied }, "token", details.id, action, expected))
        .resolves.toMatchObject({ readbackCount: 1 });
    });

    it.each(["all", "none", "some"])("allows an exact no-op with an untouched %s scope without sending its collections", async scope => {
      const details = allowlistedPackage({
        id: "package", displayName: "Package", isBlocked: false,
        availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
        [unselectedScope]: scope, [unselectedCollection]: scope === "none" ? [preserved] : [],
      });
      const before = capturePackageMutationState(details, action);
      const noop: PackageAccessUpdate = { target, mode: "replace", scope: "none", principals: [] };
      expect(createJobConfirmation({
        action, accessUpdate: noop, targets: [{ id: details.id, displayName: details.displayName, prestate: before }],
        actor, scope: "single", requestPath: "/api/agents/package/access",
      }).summary.targets[0].requestedState).toEqual(before);
      const fetcher = vi.fn<FetchLike>();
      await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", details.id, noop, details))
        .resolves.toMatchObject({ changed: false });
      expect(fetcher).not.toHaveBeenCalled();
    });
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

  it("uses canonical user/group types and ordering without changing exact opaque IDs or the input", () => {
    const reordered: PackageAccessMutationState = {
      ...stored,
      allowedUsersAndGroups: [
        { resourceId: "user-1", resourceType: "USER" },
        { resourceId: "group-1", resourceType: "GROUP" },
      ],
    };
    const original = structuredClone(reordered);
    expect(packageMutationStatesEqual(before, reordered)).toBe(true);
    expect(reordered).toEqual(original);
    for (const resourceId of ["USER-1", " user-1 "]) {
      expect(packageMutationStatesEqual(before, {
        ...reordered, allowedUsersAndGroups: [
          { resourceId, resourceType: "user" },
          { resourceId: "group-1", resourceType: "group" },
        ],
      })).toBe(false);
    }
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
        { resourceType: "USER", resourceId: "user-1" },
      ],
    })).toThrow("Duplicate package access principals");
  });

  it.each([
    { ...before, kind: "unexpected" },
    { ...before, availableTo: "future" },
    { ...before, deployedTo: null },
    { kind: "block", isBlocked: "false" },
    { kind: "block" },
  ])("rejects malformed stored mutation state instead of hashing it as authoritative: %j", value => {
    const state = JSON.parse(JSON.stringify(value));
    expect(() => packageMutationStateHash(state))
      .toThrow(expect.objectContaining({ code: "invalid_mutation_state" }));
    expect(() => packageMutationStatesEqual(before, state))
      .toThrow(expect.objectContaining({ code: "invalid_mutation_state" }));
  });

  it("rejects sparse principal collections rather than hashing a null entry", () => {
    expect(() => packageMutationStateHash({ ...before, allowedUsersAndGroups: new Array(1) }))
      .toThrow(expect.objectContaining({ code: "invalid_principal" }));
  });

  it("does not hash inherited or accessor-backed mutation evidence", () => {
    const getter = vi.fn(() => true);
    for (const state of [
      Object.create({ kind: "block", isBlocked: true }),
      Object.defineProperty({ kind: "block" as const }, "isBlocked", { get: getter }),
      Object.assign(Object.create({ availableTo: "some" }), {
        kind: "access", deployedTo: "some", allowedUsersAndGroups: before.allowedUsersAndGroups,
        acquireUsersAndGroups: before.acquireUsersAndGroups,
      }),
    ]) expect(() => packageMutationStateHash(state))
      .toThrow(expect.objectContaining({ code: "invalid_mutation_state" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not capture inherited block state or execute supplied access-scope accessors", () => {
    expect(() => capturePackageMutationState(Object.create({ isBlocked: true }), "block"))
      .toThrow(expect.objectContaining({ code: "incomplete_package_block_state" }));
    const getter = vi.fn(() => "some");
    const details = {
      isBlocked: false, deployedTo: "some", allowedUsersAndGroups: before.allowedUsersAndGroups,
      acquireUsersAndGroups: before.acquireUsersAndGroups,
    };
    Object.defineProperty(details, "availableTo", { get: getter });
    expect(() => capturePackageMutationState(details, "update-availability"))
      .toThrow(expect.objectContaining({ code: "invalid_mutation_state" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not project an inherited or accessor-backed access intent", () => {
    const update: PackageAccessUpdate = {
      target: "availability", mode: "replace", scope: "specific", principals: before.allowedUsersAndGroups,
    };
    const getter = vi.fn(() => "availability");
    expect(() => expectedPackageMutationState(before, "update-availability", Object.create(update)))
      .toThrow(expect.objectContaining({ code: "invalid_access_update" }));
    Object.defineProperty(update, "target", { get: getter });
    expect(() => expectedPackageMutationState(before, "update-availability", update))
      .toThrow(expect.objectContaining({ code: "invalid_access_update" }));
    expect(getter).not.toHaveBeenCalled();
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
