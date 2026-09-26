import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createJobConfirmation } from "../db/jobs.js";
import { packageCanaryMutation, PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { transaction } from "../db/pool.js";
import type { AuditAction } from "../types/audit.js";
import type { PackageAccessEntity } from "../types/copilotPackage.js";
import { GraphPackagesClient, updatePackageAccess } from "./graphPackages.js";
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

describe("access canary durable mutation contract", () => {
  it.each(invalidTransitions())("rejects $name before approval storage access", async ({ action, prestate, poststate }) => {
    await expect(new PackageMutationQualificationRepository().createApproved(administrator, {
      targetId: "package-1", action, prestate, poststate, contractRevision: "a".repeat(64), configurationRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    expect(transaction).not.toHaveBeenCalled();
  });

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