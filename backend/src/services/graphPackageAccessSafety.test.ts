import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { CopilotPackageDetail, PackageAccessUpdate } from "../types/copilotPackage.js";
import {
  GraphPackagesClient,
  updatePackageAccess,
  verifyPackageMutationConverged,
  type FetchLike,
} from "./graphPackages.js";
import { allowlistedPackage } from "./packageObservation.js";
import { capturePackageMutationState, expectedPackageMutationState } from "./packageMutationState.js";

const principal = { resourceType: "group", resourceId: "group-1" };
const otherPrincipal = { resourceType: "user", resourceId: "user-1" };
const base = {
  id: "P_1", displayName: "Package", isBlocked: false,
  availableTo: "none", deployedTo: "none",
  allowedUsersAndGroups: [], acquireUsersAndGroups: [],
};
const replacement: PackageAccessUpdate = {
  target: "availability", mode: "replace", scope: "specific", principals: [principal],
};

function verifyAccessReadback(details: CopilotPackageDetail, update = replacement, before = allowlistedPackage(base)) {
  const action = update.target === "availability" ? "update-availability" : "update-installation";
  const expected = expectedPackageMutationState(capturePackageMutationState(before, action), action, update);
  return verifyPackageMutationConverged({ getPackageDetails: async () => details }, "token", before.id, action, expected, { maxAttempts: 1 });
}

describe("exact package access targets", () => {
  it("rejects a different detail identity without retrying", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...base, id: "P_other" }));
    await expect(new GraphPackagesClient(fetcher).getPackageDetails("token", base.id))
      .rejects.toMatchObject({ status: 502, code: "target_mismatch" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects mismatched supplied details before the dispatch hook", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const beforeWrite = vi.fn(async () => undefined);
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, replacement,
      allowlistedPackage({ ...base, id: "P_other" }), beforeWrite))
      .rejects.toMatchObject({ code: "target_mismatch" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not verify matching access on a different package", async () => {
    const after = allowlistedPackage({ ...base, id: "P_other", availableTo: "some", allowedUsersAndGroups: [principal] });
    await expect(verifyAccessReadback(after)).rejects.toMatchObject({ code: "target_mismatch" });
  });
});

describe("complete package access state", () => {
  it.each(["availability", "installation"] as const)("refuses an additive %s write when selected principals are missing", async target => {
    const property = target === "availability" ? "allowedUsersAndGroups" : "acquireUsersAndGroups";
    const details = allowlistedPackage({ ...base, availableTo: "some", deployedTo: "some", [property]: undefined });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const beforeWrite = vi.fn(async () => undefined);
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { target, mode: "add", scope: "specific", principals: [principal] }, details, beforeWrite))
      .rejects.toMatchObject({ code: "incomplete_package_access_state" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not report a no-op when the selected collection is absent", async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { target: "availability", mode: "replace", scope: "none", principals: [] },
      allowlistedPackage({ ...base, allowedUsersAndGroups: undefined })))
      .rejects.toMatchObject({ code: "incomplete_package_access_state" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["allowedUsersAndGroups", "acquireUsersAndGroups"] as const)(
    "does not verify an empty scope when readback omitted %s", async property => {
      const update: PackageAccessUpdate = { target: "availability", mode: "replace", scope: "none", principals: [] };
      const after = allowlistedPackage({ ...base, [property]: undefined });
      await expect(verifyAccessReadback(after, update)).rejects.toMatchObject({ code: "incomplete_package_access_state" });
    },
  );

  it("cannot verify preservation when the previous collection was absent", () => {
    const after = allowlistedPackage({ ...base, availableTo: "some", allowedUsersAndGroups: [principal] });
    const before = allowlistedPackage({ ...base, acquireUsersAndGroups: undefined });
    expect(() => verifyAccessReadback(after, replacement, before))
      .toThrow(expect.objectContaining({ code: "incomplete_package_access_state" }));
  });

  it("cannot verify preservation when both old and new scopes are unknown", () => {
    const before = allowlistedPackage({ ...base, deployedTo: "futureScope" });
    const after = { ...before, availableTo: "some", allowedUsersAndGroups: [principal] };
    expect(() => verifyAccessReadback(after, replacement, before))
      .toThrow(expect.objectContaining({ code: "ambiguous_access_scope" }));
  });

  it.each([
    { name: "unchanged effective scope", scope: "none", after: { availableTo: "all", deployedTo: "all" } },
    { name: "different requested principals", scope: "specific", after: { availableTo: "some", deployedTo: "all", allowedUsersAndGroups: [otherPrincipal] } },
    { name: "changed unselected setting", scope: "none", after: { availableTo: "none", deployedTo: "none" } },
  ] as const)("rejects accepted access writes with $name", async ({ scope, after }) => {
    const before = allowlistedPackage({ ...base, availableTo: "all", deployedTo: "all" });
    const update: PackageAccessUpdate = scope === "none"
      ? { target: "availability", mode: "replace", scope, principals: [] }
      : replacement;
    await expect(verifyAccessReadback(allowlistedPackage({ ...base, ...after }), update, before))
      .rejects.toMatchObject({ code: "verification_inconclusive", details: { readbackCount: 1 } });
  });

  it.each(["availability", "installation"] as const)("refuses a %s write when the unselected scope is unknown", async target => {
    const before = allowlistedPackage({
      ...base, [target === "availability" ? "deployedTo" : "availableTo"]: "futureScope",
    });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const beforeWrite = vi.fn(async () => undefined);
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, target }, before, beforeWrite))
      .rejects.toMatchObject({ code: "ambiguous_access_scope" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { resourceType: "group", resourceId: " " },
    { resourceType: " ", resourceId: "group-2" },
  ])("does not silently drop an invalid requested principal: %j", async invalid => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, principals: [principal, invalid] }, allowlistedPackage(base)))
      .rejects.toMatchObject({ code: "invalid_principal" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates the unselected payload before marking a write ready to dispatch", async () => {
    const beforeWrite = vi.fn(async () => undefined);
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const details = allowlistedPackage({
      ...base, acquireUsersAndGroups: [{ resourceType: "user", resourceId: " " }, otherPrincipal],
    });
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, replacement, details, beforeWrite))
      .rejects.toMatchObject({ code: "invalid_principal" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves case-insensitive deduplication and a known unselected scope", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const before = allowlistedPackage({ ...base, deployedTo: "some", acquireUsersAndGroups: [otherPrincipal] });
    const update: PackageAccessUpdate = {
      ...replacement, principals: [principal, { resourceType: " GROUP ", resourceId: " GROUP-1 " }],
    };
    const result = await updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, update, before);
    expect(result).toMatchObject({ changed: true, previousCount: 0, resultingCount: 1 });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      allowedUsersAndGroups: [{ resourceType: "GROUP", resourceId: "GROUP-1" }],
      acquireUsersAndGroups: [otherPrincipal],
    });
    const after = { ...before, availableTo: "some", allowedUsersAndGroups: [principal] };
    await expect(verifyAccessReadback(after, { ...replacement, principals: result.principals }, before))
      .resolves.toMatchObject({ readbackCount: 1 });
  });
});

describe("package access preflight cancellation", () => {
  it("retains refreshed dispatch authorization and a shared correlation ID", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<FetchLike>(async (_url, init) =>
      init?.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json(base));
    const beforeWrite = vi.fn(async () => "refreshed-token");
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "original-token", base.id,
      replacement, undefined, beforeWrite, { signal: controller.signal, correlationId: "access-update" }))
      .resolves.toMatchObject({ changed: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get("client-request-id")))
      .toEqual(["access-update", "access-update"]);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer original-token");
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer refreshed-token");
  });

  it("forwards correlation and cancellation through the detail read", async () => {
    const controller = new AbortController();
    const reason = new AppError(409, "cancelled", "Cancelled");
    let completeRead = () => {};
    const fetcher = vi.fn<FetchLike>(async () => new Promise(resolve => {
      completeRead = () => resolve(Response.json(base));
    }));
    const client = new GraphPackagesClient(fetcher);
    const beforeWrite = vi.fn(async () => undefined);
    const getDetails = vi.spyOn(client, "getPackageDetails");
    const result = updatePackageAccess(client, "token", base.id, replacement, undefined, beforeWrite,
      { signal: controller.signal, correlationId: "access-preflight" });
    const assertion = expect(result).rejects.toBe(reason);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(reason);
    completeRead();
    await assertion;
    expect(getDetails).toHaveBeenCalledWith("token", base.id, { signal: controller.signal, correlationId: "access-preflight" });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("client-request-id")).toBe("access-preflight");
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(beforeWrite).not.toHaveBeenCalled();
  });

  it("does not return an already-cancelled no-op from supplied details", async () => {
    const controller = new AbortController();
    const reason = new AppError(409, "cancelled", "Cancelled");
    controller.abort(reason);
    const fetcher = vi.fn<FetchLike>();
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { target: "availability", mode: "replace", scope: "none", principals: [] },
      allowlistedPackage(base), undefined, { signal: controller.signal, correlationId: "access-cancelled" }))
      .rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not dispatch if cancellation occurs in the dispatch hook", async () => {
    const controller = new AbortController();
    const reason = new AppError(409, "cancelled", "Cancelled");
    const client = new GraphPackagesClient();
    const patch = vi.spyOn(client, "patchPackageAccess").mockResolvedValue();
    const beforeWrite = vi.fn(async () => { controller.abort(reason); });
    await expect(updatePackageAccess(client, "token", base.id, replacement, allowlistedPackage(base), beforeWrite,
      { signal: controller.signal, correlationId: "access-cancelled" })).rejects.toBe(reason);
    expect(beforeWrite).toHaveBeenCalledOnce();
    expect(patch).not.toHaveBeenCalled();
  });
});
