import { describe, expect, it, vi } from "vitest";
import type { GraphPackagesClient } from "./graphPackages.js";
import { restorePackageMutationCanary } from "./packageCanaryRestoration.js";

const blockPrestate = { kind: "block" as const, isBlocked: false };
const blockPoststate = { kind: "block" as const, isBlocked: true };

describe("package canary restoration", () => {
  it("dispatches one block restoration and requires one converged read-back", async () => {
    const provider = fixtureProvider([
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: false }),
    ]);

    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token", correlationId: "correlation-1",
    })).resolves.toEqual({ status: "restored", correlationId: "correlation-1", readbackCount: 1 });

    expect(provider.unblockPackage).toHaveBeenCalledOnce();
    expect(provider.blockPackage).not.toHaveBeenCalled();
    expect(provider.getPackageDetails).toHaveBeenCalledTimes(2);
  });

  it("stops before writing when external state differs from the qualified poststate", async () => {
    const provider = fixtureProvider([packageDetail({
      isBlocked: true,
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "external-change" }],
    })]);

    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "update-availability",
      prestate: accessState([], []), poststate: accessState([{ resourceType: "user", resourceId: "canary-user" }], []),
      accessToken: "delegated-token",
    })).rejects.toMatchObject({ code: "canary_restoration_conflict" });

    expect(provider.patchPackageAccess).not.toHaveBeenCalled();
    expect(provider.blockPackage).not.toHaveBeenCalled();
    expect(provider.unblockPackage).not.toHaveBeenCalled();
  });

  it("restores only the touched access collection and preserves the unselected collection", async () => {
    const preserved = [{ resourceType: "group", resourceId: "installation-group" }];
    const prestate = accessState([], preserved);
    const poststate = accessState([{ resourceType: "user", resourceId: "canary-user" }], preserved);
    const provider = fixtureProvider([
      packageDetail({ allowedUsersAndGroups: poststate.allowedUsersAndGroups, acquireUsersAndGroups: preserved }),
      packageDetail({ availableTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: preserved }),
    ]);

    await restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "update-availability", prestate, poststate,
      accessToken: "delegated-token", correlationId: "correlation-2",
    });

    expect(provider.patchPackageAccess).toHaveBeenCalledWith("delegated-token", "package-1", {
      allowedUsersAndGroups: [],
      acquireUsersAndGroups: preserved,
    }, expect.objectContaining({ correlationId: "correlation-2" }));
    expect(provider.patchPackageAccess).toHaveBeenCalledOnce();
  });

  it("reports accepted but non-converged restoration as inconclusive without another write", async () => {
    const provider = fixtureProvider([
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: true }),
    ]);

    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token", readback: { delayMs: 0 },
    })).rejects.toMatchObject({ code: "canary_restoration_inconclusive" });
    expect(provider.unblockPackage).toHaveBeenCalledOnce();
  });

  it("waits for delayed restoration convergence without repeating the write", async () => {
    const provider = fixtureProvider([
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: true }),
      packageDetail({ isBlocked: false }),
    ]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token", readback: { delayMs: 0 },
    })).resolves.toMatchObject({ status: "restored", readbackCount: 2 });
    expect(provider.unblockPackage).toHaveBeenCalledOnce();
  });

  it("rejects a mismatched native target before restoration dispatch", async () => {
    const provider = fixtureProvider([packageDetail({ id: "another-package", isBlocked: true })]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token",
    })).rejects.toMatchObject({ code: "target_mismatch" });
    expect(provider.unblockPackage).not.toHaveBeenCalled();
  });

  it("never qualifies a different package's successful readback", async () => {
    const provider = fixtureProvider([
      packageDetail({ isBlocked: true }),
      packageDetail({ id: "another-package", isBlocked: false }),
    ]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token",
    })).rejects.toMatchObject({ code: "canary_restoration_inconclusive" });
    expect(provider.unblockPackage).toHaveBeenCalledOnce();
  });

  it("rejects reassignment restoration before provider access", async () => {
    const provider = fixtureProvider([]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "reassign", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token",
    })).rejects.toMatchObject({ code: "canary_restoration_unsupported" });
    expect(provider.getPackageDetails).not.toHaveBeenCalled();
  });
});

function fixtureProvider(details: ReturnType<typeof packageDetail>[]) {
  return {
    getPackageDetails: vi.fn(async () => {
      const detail = details.shift();
      if (!detail) throw new Error("Unexpected package detail read");
      return detail;
    }),
    blockPackage: vi.fn(async () => undefined),
    unblockPackage: vi.fn(async () => undefined),
    patchPackageAccess: vi.fn(async () => undefined),
  } as unknown as Pick<GraphPackagesClient, "getPackageDetails" | "blockPackage" | "unblockPackage" | "patchPackageAccess">;
}

function packageDetail(overrides: Record<string, unknown>) {
  return {
    id: "package-1", displayName: "Canary package", publisher: "Fixture publisher", isBlocked: false,
    availableTo: "some", deployedTo: "some", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    ...overrides,
  };
}

function accessState(allowedUsersAndGroups: Array<{ resourceType: string; resourceId: string }>, acquireUsersAndGroups: Array<{ resourceType: string; resourceId: string }>) {
  return { kind: "access" as const, availableTo: allowedUsersAndGroups.length ? "some" as const : "none" as const, deployedTo: acquireUsersAndGroups.length ? "some" as const : "none" as const, allowedUsersAndGroups, acquireUsersAndGroups };
}