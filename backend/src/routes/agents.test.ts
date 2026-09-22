import { afterEach, describe, expect, it, vi } from "vitest";
import { bulkJobs } from "../services/bulkJobs.js";
import type { PackageAccessMutationState } from "../services/packageMutationState.js";
import {
  parseBulkActionIds,
  parseDirectorySearchLimit,
  parseActionGroupId,
  parsePackageAccessUpdate,
  parseMutationScope,
  inventoryPackageDetail,
  parsePackageRefreshIds,
  submitCanaryJob,
  canaryFailureCompletion,
} from "./agents.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));

afterEach(() => vi.restoreAllMocks());

const groupId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

describe("package canary failure completion", () => {
  const scope = { tenantId: "tenant", principalId: "operator" };
  const job: NonNullable<Awaited<ReturnType<typeof bulkJobs.get>>> = {
    id: "original-job", capabilityId: "graph.package.block.manage", tokenMode: "delegated",
    status: "running", action: "block", targetBlockedState: true,
    confirmationHash: null, confirmation: null, confirmedAt: null,
    total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
    results: [], result: undefined, currentAgentName: "Canary",
    createdAt: "2026-09-22T12:00:00.000Z", updatedAt: "2026-09-22T12:00:00.000Z", canResume: false,
  };

  it.each(["original", "restoration"] as const)("keeps an unavailable %s job result inconclusive", async stage => {
    const get = vi.spyOn(bulkJobs, "get").mockResolvedValueOnce({ ...job, status: "succeeded" });
    if (stage === "original") get.mockReset();
    get.mockRejectedValueOnce(new Error("Fixture result could not be loaded."));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(canaryFailureCompletion(scope, "original-job", stage === "restoration" ? "restoration-job" : undefined))
      .resolves.toMatchObject({ status: "inconclusive", errorCode: "canary_result_unavailable" });
    expect(get).toHaveBeenLastCalledWith(`${stage}-job`, scope);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"event":"package_canary_result_unavailable"'));
    expect(log.mock.calls[0][0]).not.toContain("Fixture result");
  });

  it.each(["original", "restoration"] as const)("does not treat a missing or still-running %s job as a definite failure", async stage => {
    const get = vi.spyOn(bulkJobs, "get");
    for (const unresolved of [undefined, job]) {
      get.mockReset();
      if (stage === "restoration") get.mockResolvedValueOnce({ ...job, status: "succeeded" });
      get.mockResolvedValueOnce(unresolved);
      await expect(canaryFailureCompletion(scope, "original-job", stage === "restoration" ? "restoration-job" : undefined))
        .resolves.toMatchObject({ status: "inconclusive", errorCode: "canary_result_unavailable" });
    }
  });

  it("retains known pre-dispatch failures and exact restoration conflicts", async () => {
    const get = vi.spyOn(bulkJobs, "get").mockResolvedValue({ ...job, status: "failed", completed: 1, failed: 1 });
    await expect(canaryFailureCompletion(scope)).resolves.toMatchObject({ status: "failed" });
    expect(get).not.toHaveBeenCalled();
    await expect(canaryFailureCompletion(scope, "original-job")).resolves.toMatchObject({ status: "failed" });
    get.mockResolvedValueOnce({ ...job, status: "succeeded", completed: 1, succeeded: 1 });
    await expect(canaryFailureCompletion(scope, "original-job", "restoration-job")).resolves.toMatchObject({ status: "restoration_conflict" });
  });
});

describe("access canary job submission", () => {
  it.each(["update-availability", "update-installation"] as const)("submits both %s directions with their approved access payload", async action => {
    const before: PackageAccessMutationState = {
      kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
    };
    const after: PackageAccessMutationState = action === "update-availability"
      ? { ...before, availableTo: "some", allowedUsersAndGroups: [{ resourceType: "user", resourceId: userId }] }
      : { ...before, deployedTo: "some", acquireUsersAndGroups: [{ resourceType: "group", resourceId: groupId }] };
    const actor = { tenantId: "tenant", homeAccountId: "operator", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Admin" as const] };
    const stoppedAtStorage = new Error("Captured submission without database access.");
    const submit = vi.spyOn(bulkJobs, "submit").mockRejectedValue(stoppedAtStorage);
    try {
      for (const stage of ["original", "restoration"] as const) {
        const approval = {
          id: `${stage}-approval`, targetId: "package", action,
          prestate: stage === "original" ? before : after,
          poststate: stage === "original" ? after : before,
        };
        await expect(submitCanaryJob(actor, approval, "cycle", stage)).rejects.toBe(stoppedAtStorage);
        expect(submit).toHaveBeenLastCalledWith({ tenantId: actor.tenantId, principalId: actor.homeAccountId }, expect.objectContaining({
          action,
          accessUpdate: {
            target: action === "update-availability" ? "availability" : "installation",
            mode: "replace", scope: stage === "original" ? "specific" : "none",
            principals: stage === "restoration" ? [] : action === "update-availability" ? after.allowedUsersAndGroups : after.acquireUsersAndGroups,
          },
          targets: [{ id: approval.targetId, displayName: "Approved package canary", prestate: approval.prestate }],
          confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          idempotencyKey: `canary-${approval.id}-${stage}`,
        }));
      }
      expect(submit).toHaveBeenCalledTimes(2);
    } finally {
      submit.mockRestore();
    }
  });
});

describe("package identity refresh targets", () => {
  it("retains the broad scan only when exact IDs are omitted", () => {
    expect(parsePackageRefreshIds(undefined)).toBeUndefined();
    expect(parsePackageRefreshIds(["package-a", "package-b"])).toEqual(["package-a", "package-b"]);
  });

  it("rejects empty, duplicate, malformed and oversized selections", () => {
    for (const input of [[], null, ["same", "same"], [1], Array.from({ length: 101 }, (_, index) => `package-${index}`)]) {
      expect(() => parsePackageRefreshIds(input)).toThrow();
    }
  });
});

describe("parsePackageAccessUpdate", () => {
  it("parses a specific principal update", () => {
    expect(
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [
          { resourceType: "group", resourceId: groupId },
          { resourceType: "user", resourceId: userId },
        ],
      }),
    ).toEqual({
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: groupId },
        { resourceType: "user", resourceId: userId },
      ],
    });
  });

  it("rejects duplicate principals instead of silently deduplicating", () => {
    expect(() => parsePackageAccessUpdate({
      target: "availability", mode: "replace", scope: "specific",
      principals: [
        { resourceType: "group", resourceId: groupId },
        { resourceType: "group", resourceId: groupId.toUpperCase() },
      ],
    })).toThrow("Duplicate package access principals");
  });

  it("accepts replacing a target with no users", () => {
    expect(
      parsePackageAccessUpdate({
        target: "installation",
        mode: "replace",
        scope: "none",
        principals: [],
      }),
    ).toMatchObject({
      target: "installation",
      mode: "replace",
      scope: "none",
      principals: [],
    });
  });

  it("rejects all users while Graph has no documented write payload", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "replace",
        scope: "all",
        principals: [],
      }),
    ).toThrow("does not document a supported write payload");
  });

  it("rejects add mode with no users", () => {
    expect(() =>
      parsePackageAccessUpdate({
        target: "availability",
        mode: "add",
        scope: "none",
        principals: [],
      }),
    ).toThrow("No users requires replace mode");
  });
});

describe("parseBulkActionIds", () => {
  it("trims unique string IDs", () => {
    expect(parseBulkActionIds({ ids: [" P_1 ", "P_2"] })).toEqual(["P_1", "P_2"]);
  });

  it("rejects duplicate IDs after normalization", () => {
    expect(() => parseBulkActionIds({ ids: [" P_1 ", "P_1"] })).toThrow(
      "Duplicate package IDs",
    );
  });

  it("rejects non-string IDs", () => {
    expect(() => parseBulkActionIds({ ids: ["P_1", { id: "P_2" }] })).toThrow(
      "Each id must be a non-empty string",
    );
  });
});

describe("parseMutationScope", () => {
  it("keeps mutation cardinality separate from package access scope", () => {
    expect(parseMutationScope("single")).toBe("single");
    expect(parseMutationScope("bulk")).toBe("bulk");
    expect(() => parseMutationScope("specific")).toThrowError(
      expect.objectContaining({ code: "invalid_mutation_scope" }),
    );
  });
});

describe("parseDirectorySearchLimit", () => {
  it("accepts positive integer limits", () => {
    expect(parseDirectorySearchLimit("40")).toBe(40);
    expect(parseDirectorySearchLimit(undefined)).toBeUndefined();
  });

  it("rejects partial, zero, and unsafe limits", () => {
    expect(() => parseDirectorySearchLimit("10abc")).toThrow(
      "positive integer",
    );
    expect(() => parseDirectorySearchLimit("0")).toThrow("positive integer");
    expect(() => parseDirectorySearchLimit("999999999999999999999")).toThrow(
      "positive integer",
    );
  });
});

describe("parseActionGroupId", () => {
  it("accepts a trimmed alphanumeric identifier", () => {
    expect(parseActionGroupId(" a5331a93-1111 ")).toBe("a5331a93-1111");
    expect(parseActionGroupId(undefined)).toBeUndefined();
  });

  it("rejects unqueryable or oversized identifiers", () => {
    expect(() => parseActionGroupId("{a5331a93}")).toThrow(
      "Action group ID is invalid",
    );
    expect(() => parseActionGroupId("a".repeat(65))).toThrow(
      "Action group ID is invalid",
    );
  });
});

describe("inventoryPackageDetail", () => {
  it("removes exact assignment principals from Reader inventory", () => {
    expect(inventoryPackageDetail({
      id: "package-1", displayName: "Fixture", isBlocked: false,
      allowedUsersAndGroups: [{ resourceType: "user", resourceId: "sensitive-user" }],
      acquireUsersAndGroups: [{ resourceType: "group", resourceId: "sensitive-group" }],
    })).toEqual({ id: "package-1", displayName: "Fixture", isBlocked: false });
  });
});
