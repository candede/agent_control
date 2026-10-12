import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createJobConfirmation } from "../db/jobs.js";
import { packageCanaryMutation, PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { transaction } from "../db/pool.js";
import type { AuditAction } from "../types/audit.js";
import type { PackageAccessEntity } from "../types/copilotPackage.js";
import { GraphPackagesClient, updatePackageAccess, type FetchLike } from "./graphPackages.js";
import type { PackageAccessMutationState, PackageMutationState } from "./packageMutationState.js";
import { allowlistedPackage } from "./packageObservation.js";
import { loadOperationalState } from "./operationalState.js";

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

beforeEach(async () => {
  vi.mocked(transaction).mockReset().mockRejectedValue(new Error("Unit tests must not access a database."));
  await loadOperationalState({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
    mode: "normal", provider_work_enabled: true, restored_from_at: null, deletion_reviewed_at: null, access_reviewed_at: null,
  }] }) });
});
afterEach(() => vi.restoreAllMocks());

describe("access canary durable mutation contract", () => {
  it("rejects access approvals whose preserved evidence cannot fit durable verification storage", async () => {
    const preserved = Array.from({ length: 1400 }, (_, index) => ({
      resourceType: "group", resourceId: `p${index.toString(36)}`,
    }));
    await expect(new PackageMutationQualificationRepository().createApproved(administrator, {
      targetId: "package-1", action: "update-availability",
      prestate: accessState([], preserved), poststate: accessState([user], preserved),
      contractRevision: "a".repeat(64), configurationRevision: 1,
    })).rejects.toMatchObject({ status: 413, code: "mutation_state_too_large" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("retains an exact whitespace-bearing package identity through approval storage", async () => {
    const f = qualificationFixture();
    const targetId = " Canary/Package% ";
    f.query.mockImplementation(async (statement, values) => !String(statement).startsWith("INSERT") ? f.result() : f.result([{
      ...f.row, id: values?.[0], target_id: values?.[2],
    }]));
    const approval = await f.repository.createApproved(administrator, {
      targetId, action: "block", prestate: blockPrestate, poststate: blockPoststate,
      contractRevision: f.row.contract_revision, configurationRevision: 1,
    });
    expect(approval.targetId).toBe(targetId);
    expect(f.query.mock.calls.find(([statement]) => String(statement).startsWith("INSERT"))?.[1]?.[2]).toBe(targetId);
  });

  it.each([".", "..", "canary\u0000", "canary\u007f", "\ud800", 12, null])("rejects malformed target %j before storage", async targetId => {
    await expect(new PackageMutationQualificationRepository().createApproved(administrator, {
      ...JSON.parse(JSON.stringify({ targetId })), action: "block", prestate: blockPrestate, poststate: blockPoststate,
      contractRevision: "a".repeat(64), configurationRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_qualification" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("claims UUID approvals case-insensitively without altering the package target", async () => {
    const f = qualificationFixture();
    const original = { ...f.row, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const restoration = {
      ...f.row, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", action: "unblock" as const,
      prestate: blockPoststate, poststate: blockPrestate,
    };
    f.query.mockImplementation(async () => f.result([original, restoration]));
    const identity = { contractRevision: f.row.contract_revision, configurationRevision: 1, authMode: "delegated" as const };
    await expect(f.repository.claimCycle(
      { ...administrator, homeAccountId: "different-admin" },
      original.id.toUpperCase(), restoration.id.toUpperCase(), identity, identity,
    )).resolves.toMatchObject({ original: { id: original.id }, restoration: { id: restoration.id } });
    expect(f.query.mock.calls[0]?.[1]?.[0]).toEqual([original.id, restoration.id]);
  });

  it.each(["update-availability", "update-installation"] as const)("preserves exact unselected provider evidence in a %s approval", async action => {
    const f = qualificationFixture();
    const preserved = Array.from({ length: 501 }, (_, index) => ({ resourceType: "group", resourceId: ` Opaque_Group_${String(index).padStart(3, "0")} ` }));
    const before = action === "update-availability" ? accessState([], preserved) : accessState(preserved, []);
    const after = action === "update-availability" ? { ...before, availableTo: "some" as const, allowedUsersAndGroups: [user] }
      : { ...before, deployedTo: "some" as const, acquireUsersAndGroups: [user] };
    f.query.mockImplementation(async (statement, values) => !String(statement).startsWith("INSERT") ? f.result() : f.result([{
      ...f.row, action, prestate: values?.[8], poststate: values?.[9],
    }]));
    const approved = await f.repository.createApproved(administrator, {
      targetId: f.row.target_id, action, prestate: before, poststate: after,
      contractRevision: f.row.contract_revision, configurationRevision: 1,
    });
    expect(approved).toMatchObject({ prestate: before, poststate: after });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const provider = new GraphPackagesClient(fetcher);
    for (const [prestate, poststate] of [[approved.prestate, approved.poststate], [approved.poststate, approved.prestate]]) {
      const { accessUpdate } = packageCanaryMutation({ action, prestate, poststate });
      if (!accessUpdate || poststate.kind !== "access") throw new Error("Expected an approved access transition.");
      expect(createJobConfirmation({
        action, accessUpdate, targets: [{ id: f.row.target_id, displayName: "Canary", prestate }],
        actor: administrator, scope: "single", requestPath: "/fixture/canary",
      }).summary.targets[0].requestedState).toEqual(poststate);
      await updatePackageAccess(provider, "synthetic-token", f.row.target_id, accessUpdate, packageDetail(prestate));
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({
        allowedUsersAndGroups: poststate.allowedUsersAndGroups, acquireUsersAndGroups: poststate.acquireUsersAndGroups,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an unwritable opaque selected principal before storing its inverse approval", async () => {
    await expect(new PackageMutationQualificationRepository().createApproved(administrator, {
      targetId: "package-1", action: "update-availability",
      prestate: accessState([{ resourceType: "user", resourceId: "Opaque_User" }], []), poststate: accessState([], []),
      contractRevision: "a".repeat(64), configurationRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("fences approval persistence after the final awaited write", async () => {
    const f = qualificationFixture();
    let current = true;
    const failure = new Error("Synthetic capability replacement.");
    f.query.mockImplementation(async statement => {
      if (String(statement).startsWith("INSERT")) current = false;
      return f.result(String(statement).startsWith("INSERT") ? [f.row] : []);
    });
    await expect(f.repository.createApproved(administrator, {
      targetId: f.row.target_id, action: "block", prestate: blockPrestate, poststate: blockPoststate,
      contractRevision: f.row.contract_revision, configurationRevision: 1,
    }, () => { if (!current) throw failure; })).rejects.toBe(failure);
  });

  it.each(["swapped stages", "unpaired approvals", "additional job target", "capability before commit"] as const)(
    "does not qualify a cycle with %s", async defect => {
      const f = qualificationFixture();
      const originalId = f.row.id, restorationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const original = { ...f.row, status: "restoring", cycle_stage: "original", paired_qualification_id: restorationId,
        actor_principal_id: administrator.homeAccountId, job_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
      const restoration = { ...original, id: restorationId, action: "unblock", cycle_stage: "restoration",
        paired_qualification_id: originalId, job_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        prestate: blockPoststate, poststate: blockPrestate };
      if (defect === "swapped stages") {
        original.cycle_stage = "restoration"; restoration.cycle_stage = "original";
      }
      if (defect === "unpaired approvals") restoration.paired_qualification_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const jobs = [original, restoration].map(row => ({
        id: row.job_id, action: row.action, status: "succeeded", item_status: "succeeded", target_id: row.target_id,
        prestate: row.prestate, poststate: row.poststate,
      }));
      if (defect === "additional job target") jobs.push({ ...jobs[0], target_id: "other-package" });
      let current = true;
      f.query.mockImplementation(async statement => {
        const sql = String(statement);
        if (sql.startsWith("SELECT *")) return f.result([original, restoration]);
        if (sql.startsWith("SELECT job.id")) return f.result(jobs);
        if (sql.startsWith("UPDATE package_mutation_qualifications SET status=$4")) {
          current = false;
          return f.result([original, restoration]);
        }
        return f.result();
      });
      const identity = { contractRevision: f.row.contract_revision, configurationRevision: 1, authMode: "delegated" as const };
      await expect(f.repository.completeCycle(administrator, originalId, restorationId, { status: "qualified" }, identity, identity,
        () => { if (!current) throw new Error("Synthetic capability replacement."); })).rejects.toMatchObject(
        defect === "capability before commit" ? { message: "Synthetic capability replacement." }
          : { code: defect === "additional job target" ? "canary_cycle_unverified" : "canary_cycle_state" },
      );
      expect(f.query.mock.calls.some(([statement]) => String(statement).startsWith("UPDATE package_mutation_qualifications SET status=$4")))
        .toBe(defect === "capability before commit");
    },
  );

  it.each(invalidTransitions())("rejects $name before approval storage access", async ({ action, prestate, poststate }) => {
    await expect(new PackageMutationQualificationRepository().createApproved(administrator, {
      targetId: "package-1", action, prestate, poststate, contractRevision: "a".repeat(64), configurationRevision: 1,
    })).rejects.toMatchObject({ code: "invalid_qualification_state" });
    expect(transaction).not.toHaveBeenCalled();
  });

  function qualificationFixture() {
    const row = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenant_id: administrator.tenantId, target_id: "package-1",
      action: "block" as const, status: "approved", workflow_version: 3,
      approved_by: administrator.displayName, approved_by_principal_id: administrator.homeAccountId,
      actor_principal_id: null, actor_name: null, contract_revision: "a".repeat(64), configuration_revision: 1,
      auth_mode: "delegated", prestate: blockPrestate, poststate: blockPoststate,
      restoration_criteria: { requireCurrentEqualsPoststate: true, touchedFields: ["isBlocked"] },
      paired_qualification_id: null, job_id: null, cycle_stage: null, correlation_id: null, attempted_at: null,
      error_code: null, message: null, qualified_at: new Date(), expires_at: new Date(Date.now() + 60_000), restored_at: null,
    };
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const result = (rows: object[] = []) => ({ command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows });
    const query = vi.fn(async (_statement: unknown, _values?: unknown[]) => result());
    vi.spyOn(client, "query").mockImplementation(query);
    vi.mocked(transaction).mockImplementationOnce(async (_database, work, _signal, beforeCommit) => {
      const value = await work(client);
      beforeCommit?.();
      return value;
    });
    return { row, query, result, repository: new PackageMutationQualificationRepository() };
  }

  it.each(["selected", "untouched"] as const)("rejects an old inverse approval pair with an unwritable %s scope before claiming it", async setting => {
    const before = { ...accessState([], []), [setting === "selected" ? "availableTo" : "deployedTo"]: "all" as const };
    const after = setting === "selected" ? accessState([user], []) : { ...before, availableTo: "some" as const, allowedUsersAndGroups: [user] };
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
      const unselectedScope = action === "update-availability" ? "deployedTo" : "availableTo";
      const unselectedCollection = action === "update-availability" ? "acquireUsersAndGroups" : "allowedUsersAndGroups";
      const valid = action === "update-availability" ? after : accessState([], [group]);
      return [
        { name: `${action} from all users`, action, prestate: { ...before, [scope]: "all" }, poststate: valid },
        { name: `${action} to all users`, action, prestate: valid, poststate: { ...before, [scope]: "all" } },
        { name: `${action} from some users without principals`, action, prestate: { ...before, [scope]: "some" }, poststate: valid },
        { name: `${action} to no users with principals`, action, prestate: before, poststate: { ...valid, [scope]: "none" } },
        ...([
          { scope: "all", principals: [] },
          { scope: "none", principals: [group] },
          { scope: "some", principals: [] },
        ] as const).map(untouched => ({
          name: `${action} with untouched ${untouched.scope} and ${untouched.principals.length} principals`, action,
          prestate: { ...before, [unselectedScope]: untouched.scope, [unselectedCollection]: [...untouched.principals] },
          poststate: { ...valid, [unselectedScope]: untouched.scope, [unselectedCollection]: [...untouched.principals] },
        })),
      ];
    }),
  ];
}