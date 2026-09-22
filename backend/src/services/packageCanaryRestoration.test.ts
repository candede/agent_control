import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createJobConfirmation } from "../db/jobs.js";
import { packageCanaryMutation, PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { transaction } from "../db/pool.js";
import { AppError } from "../errors.js";
import type { AuditAction } from "../types/audit.js";
import type { PackageAccessEntity } from "../types/copilotPackage.js";
import { GraphPackagesClient, updatePackageAccess } from "./graphPackages.js";
import { restorePackageMutationCanary } from "./packageCanaryRestoration.js";
import type { PackageAccessMutationState, PackageMutationState } from "./packageMutationState.js";
import { allowlistedPackage } from "./packageObservation.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));

const blockPrestate = { kind: "block" as const, isBlocked: false };
const blockPoststate = { kind: "block" as const, isBlocked: true };
const user = { resourceType: "user", resourceId: "11111111-1111-4111-8111-111111111111" };
const group = { resourceType: "group", resourceId: "22222222-2222-4222-8222-222222222222" };
const administrator = {
  tenantId: "fixture-tenant", homeAccountId: "fixture-admin", displayName: "Fixture",
  username: "fixture@example.invalid", roles: ["AgentControl.Admin" as const],
};

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

  it.each(["block", "unblock", "update-availability", "update-installation"] as const)(
    "reports an uncertain %s restoration dispatch as inconclusive without replay or readback",
    async action => {
      const prestate = action === "block" ? blockPrestate : action === "unblock" ? blockPoststate : accessState([], []);
      const poststate = action === "block" ? blockPoststate : action === "unblock" ? blockPrestate
        : action === "update-availability" ? accessState([user], []) : accessState([], [group]);
      const provider = fixtureProvider([packageDetail(poststate)]);
      const mutation = action === "block" ? provider.unblockPackage : action === "unblock" ? provider.blockPackage : provider.patchPackageAccess;
      mutation.mockRejectedValueOnce(new AppError(502, "provider_network_error", "The response was lost after dispatch."));

      await expect(restorePackageMutationCanary(provider, {
        targetId: "package-1", action, prestate, poststate, accessToken: "delegated-token",
      })).rejects.toMatchObject({ status: 409, code: "canary_restoration_inconclusive" });
      expect(mutation).toHaveBeenCalledOnce();
      expect(provider.getPackageDetails).toHaveBeenCalledOnce();
    },
  );

  it("preserves pre-dispatch cancellation without attempting a restoration write", async () => {
    const controller = new AbortController();
    const reason = new AppError(409, "cancelled", "Cancelled before dispatch.");
    const provider = fixtureProvider([packageDetail({ isBlocked: true })]);
    provider.getPackageDetails.mockImplementationOnce(async () => {
      controller.abort(reason);
      return packageDetail({ isBlocked: true });
    });
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token", signal: controller.signal,
    })).rejects.toBe(reason);
    expect(provider.unblockPackage).not.toHaveBeenCalled();
  });

  it("reports cancellation during restoration dispatch as inconclusive", async () => {
    const controller = new AbortController();
    const reason = new AppError(409, "cancelled", "Cancelled after dispatch.");
    const provider = fixtureProvider([packageDetail({ isBlocked: true })]);
    provider.unblockPackage.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token", signal: controller.signal,
    })).rejects.toMatchObject({ code: "canary_restoration_inconclusive" });
    expect(provider.unblockPackage).toHaveBeenCalledOnce();
    expect(provider.getPackageDetails).toHaveBeenCalledOnce();
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

  it("restores an unblock canary with one block write", async () => {
    const provider = fixtureProvider([packageDetail({ isBlocked: false }), packageDetail({ isBlocked: true })]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "unblock", prestate: blockPoststate, poststate: blockPrestate,
      accessToken: "delegated-token",
    })).resolves.toMatchObject({ status: "restored", readbackCount: 1 });
    expect(provider.blockPackage).toHaveBeenCalledOnce();
    expect(provider.unblockPackage).not.toHaveBeenCalled();
  });

  it("does not write when the qualified prestate is already restored", async () => {
    const provider = fixtureProvider([packageDetail({ isBlocked: false })]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "block", prestate: blockPrestate, poststate: blockPoststate,
      accessToken: "delegated-token",
    })).resolves.toMatchObject({ status: "already_restored", readbackCount: 1 });
    expect(provider.getPackageDetails).toHaveBeenCalledOnce();
    expect(provider.blockPackage).not.toHaveBeenCalled();
    expect(provider.unblockPackage).not.toHaveBeenCalled();
    expect(provider.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("compares preserved principals semantically after persistence reorders keys and collections", async () => {
    const prestate = accessState([], [group, user]);
    const poststate = accessState([user], [
      { resourceId: user.resourceId.toUpperCase(), resourceType: "USER" },
      { resourceId: group.resourceId, resourceType: "group" },
    ]);
    const provider = fixtureProvider([packageDetail(poststate), packageDetail(prestate)]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action: "update-availability", prestate, poststate,
      accessToken: "delegated-token",
    })).resolves.toMatchObject({ status: "restored" });
    expect(provider.patchPackageAccess).toHaveBeenCalledWith("delegated-token", "package-1", {
      allowedUsersAndGroups: [], acquireUsersAndGroups: [group, user],
    }, expect.any(Object));
  });

  it.each(["update-availability", "update-installation"] as const)("restores %s and preserves an unselected all-users scope", async action => {
    const prestate: PackageAccessMutationState = {
      ...accessState([], []),
      ...(action === "update-availability" ? { deployedTo: "all" } : { availableTo: "all" }),
    };
    const poststate: PackageAccessMutationState = {
      ...prestate,
      ...(action === "update-availability"
        ? { availableTo: "some", allowedUsersAndGroups: [user] }
        : { deployedTo: "some", acquireUsersAndGroups: [group] }),
    };
    const provider = fixtureProvider([packageDetail(poststate), packageDetail(prestate)]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action, prestate, poststate, accessToken: "delegated-token",
    })).resolves.toMatchObject({ status: "restored" });
    expect(provider.patchPackageAccess).toHaveBeenCalledExactlyOnceWith("delegated-token", "package-1", {
      allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    }, expect.any(Object));
  });

  it.each(invalidTransitions())("rejects $name before provider or approval storage access", async ({ action, prestate, poststate }) => {
    const provider = fixtureProvider([]);
    await expect(restorePackageMutationCanary(provider, {
      targetId: "package-1", action, prestate, poststate, accessToken: "delegated-token",
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    expect(provider.getPackageDetails).not.toHaveBeenCalled();
    expect(provider.patchPackageAccess).not.toHaveBeenCalled();
    expect(provider.blockPackage).not.toHaveBeenCalled();
    expect(provider.unblockPackage).not.toHaveBeenCalled();
    await expect(new PackageMutationQualificationRepository().createApproved(administrator, {
      targetId: "package-1", action, prestate, poststate, contractRevision: "a".repeat(64), configurationRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("access canary durable mutation contract", () => {
  it("rejects an old inverse approval pair with an unwritable restoration scope before claiming it", async () => {
    const before = { ...accessState([], []), availableTo: "all" as const };
    const after = accessState([user], []);
    const originalId = "33333333-3333-4333-8333-333333333333";
    const restorationId = "44444444-4444-4444-8444-444444444444";
    const identity = { contractRevision: "a".repeat(64), configurationRevision: 1, authMode: "delegated" as const };
    const row = {
      tenant_id: administrator.tenantId, target_id: "package-1", action: "update-availability",
      status: "approved", workflow_version: 3, expires_at: new Date(Date.now() + 60_000),
      approved_by_principal_id: "separate-approver", contract_revision: identity.contractRevision,
      configuration_revision: identity.configurationRevision, auth_mode: identity.authMode,
    };
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockImplementation(async () => ({
      command: "SELECT", rowCount: 2, oid: 0, fields: [],
      rows: [
        { ...row, id: originalId, prestate: before, poststate: after },
        { ...row, id: restorationId, prestate: after, poststate: before },
      ],
    }));
    vi.mocked(transaction).mockImplementationOnce(async (_database, work) => work(client));
    await expect(new PackageMutationQualificationRepository().claimCycle(
      administrator, originalId, restorationId, identity, identity,
    )).rejects.toMatchObject({ code: "invalid_qualification_state" });
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/^SELECT/), [[originalId, restorationId], administrator.tenantId]);
  });

  it.each(["update-availability", "update-installation"] as const)("projects %s approvals into exact forward and inverse writes", async action => {
    const prestate = accessState([user], [group]);
    const poststate: PackageAccessMutationState = action === "update-availability"
      ? { ...prestate, availableTo: "none", allowedUsersAndGroups: [] }
      : { ...prestate, deployedTo: "none", acquireUsersAndGroups: [] };
    const provider = new GraphPackagesClient(async () => { throw new Error("Unit tests must not contact Graph."); });
    const patch = vi.spyOn(provider, "patchPackageAccess").mockResolvedValue(undefined);
    for (const [before, after] of [[prestate, poststate], [poststate, prestate]]) {
      const { accessUpdate } = packageCanaryMutation({ action, prestate: before, poststate: after });
      if (!accessUpdate) throw new Error("Access canaries require a concrete mutation payload.");
      const confirmation = createJobConfirmation({
        action, accessUpdate, targets: [{ id: "package-1", displayName: "Canary", prestate: before }],
        actor: administrator, scope: "single", requestPath: "/api/agents/mutation-canaries/fixture/execute",
      });
      expect(confirmation.summary.targets[0].requestedState).toEqual(after);
      await updatePackageAccess(provider, "delegated-token", "package-1", accessUpdate, packageDetail(before));
      expect(patch).toHaveBeenLastCalledWith("delegated-token", "package-1", {
        allowedUsersAndGroups: after.allowedUsersAndGroups, acquireUsersAndGroups: after.acquireUsersAndGroups,
      });
    }
    expect(patch).toHaveBeenCalledTimes(2);
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
  } satisfies Pick<GraphPackagesClient, "getPackageDetails" | "blockPackage" | "unblockPackage" | "patchPackageAccess">;
}

function packageDetail(overrides: Record<string, unknown>) {
  return allowlistedPackage({
    id: "package-1", displayName: "Canary package", publisher: "Fixture publisher", isBlocked: false,
    availableTo: Array.isArray(overrides.allowedUsersAndGroups) && overrides.allowedUsersAndGroups.length ? "some" : "none",
    deployedTo: Array.isArray(overrides.acquireUsersAndGroups) && overrides.acquireUsersAndGroups.length ? "some" : "none",
    allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    ...overrides,
  });
}

function accessState(allowedUsersAndGroups: PackageAccessEntity[], acquireUsersAndGroups: PackageAccessEntity[]): PackageAccessMutationState {
  return { kind: "access", availableTo: allowedUsersAndGroups.length ? "some" : "none", deployedTo: acquireUsersAndGroups.length ? "some" : "none", allowedUsersAndGroups, acquireUsersAndGroups };
}

function invalidTransitions(): Array<{ name: string; action: AuditAction; prestate: PackageMutationState; poststate: PackageMutationState }> {
  const before = accessState([], []);
  const after = accessState([user], []);
  return [
    { name: "a no-op", action: "block", prestate: blockPrestate, poststate: blockPrestate },
    { name: "a reversed block action", action: "unblock", prestate: blockPrestate, poststate: blockPoststate },
    { name: "an access action targeting the wrong collection", action: "update-installation", prestate: before, poststate: after },
    { name: "changes to both access targets", action: "update-availability", prestate: before, poststate: accessState([user], [group]) },
    ...(["update-availability", "update-installation"] as const).flatMap(action => {
      const scope = action === "update-availability" ? "availableTo" : "deployedTo";
      const valid = action === "update-availability" ? after : accessState([], [group]);
      return [
        { name: `${action} from all users`, action, prestate: { ...before, [scope]: "all" }, poststate: valid },
        { name: `${action} to all users`, action, prestate: valid, poststate: { ...before, [scope]: "all" } },
        { name: `${action} from some users without principals`, action, prestate: { ...before, [scope]: "some" }, poststate: valid },
        { name: `${action} to no users with principals`, action, prestate: before, poststate: { ...valid, [scope]: "none" } },
      ];
    }),
  ];
}