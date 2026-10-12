import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { AppError } from "../errors.js";
import type { CopilotPackageDetail, PackageAccessEntity, PackageAccessUpdate } from "../types/copilotPackage.js";
import {
  GraphPackagesClient,
  buildCopilotAgentsListUrl,
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
class ProviderPromise<T> extends Promise<T> {}

async function catalog(client: GraphPackagesClient) {
  const rows: CopilotPackageDetail[] = [];
  for await (const page of client.catalogPages("token", { visit: async () => undefined })) rows.push(...page.records);
  return rows;
}

function verifyAccessReadback(details: CopilotPackageDetail, update = replacement, before = allowlistedPackage(base)) {
  const action = update.target === "availability" ? "update-availability" : "update-installation";
  const expected = expectedPackageMutationState(capturePackageMutationState(before, action), action, update);
  return verifyPackageMutationConverged({ getPackageDetails: async () => details }, "token", before.id, action, expected, { maxAttempts: 1 });
}

describe("exact package access targets", () => {
  it.each([{ target: "other" }, { mode: "remove" }, { scope: "all" }])(
    "rejects malformed direct access intent %j before reading or dispatching", async invalid => {
      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
      const beforeWrite = vi.fn(async () => undefined);
      const update = JSON.parse(JSON.stringify({ ...replacement, ...invalid }));
      await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, update, allowlistedPackage(base), beforeWrite))
        .rejects.toMatchObject({ code: "invalid_access_update" });
      expect(beforeWrite).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["availability", "installation"] as const)("preserves opaque selected and unselected %s principals through payload and readback", async target => {
    const selected = [
      { resourceType: "user", resourceId: "Opaque_User" },
      { resourceType: "user", resourceId: "opaque_user" },
      { resourceType: "GROUP", resourceId: " exact group " },
    ];
    const preserved = [{ resourceType: "USER", resourceId: " Other_User " }];
    const before = allowlistedPackage({
      ...base, availableTo: "some", deployedTo: "some",
      allowedUsersAndGroups: preserved, acquireUsersAndGroups: preserved,
    });
    const update: PackageAccessUpdate = { target, mode: "replace", scope: "specific", principals: selected };
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const result = await updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, update, before);
    const payload = {
      allowedUsersAndGroups: target === "availability" ? selected : preserved,
      acquireUsersAndGroups: target === "installation" ? selected : preserved,
    };
    expect(result).toMatchObject({ changed: true, resultingCount: 3, principals: selected });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(payload);
    await expect(verifyAccessReadback({ ...before, ...payload }, update, before))
      .resolves.toMatchObject({ readbackCount: 1 });
    const changed = {
      ...payload,
      [target === "availability" ? "acquireUsersAndGroups" : "allowedUsersAndGroups"]:
        [{ ...preserved[0], resourceId: preserved[0].resourceId.trim().toLowerCase() }],
    };
    await expect(verifyAccessReadback({ ...before, ...changed }, update, before))
      .rejects.toMatchObject({ code: "verification_inconclusive" });
  });

  it("does not treat case-distinct opaque principals as an access no-op", async () => {
    const before = allowlistedPackage({
      ...base, availableTo: "some", allowedUsersAndGroups: [{ resourceType: "user", resourceId: "Opaque_User" }],
    });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, principals: [{ resourceType: "user", resourceId: "opaque_user" }] }, before))
      .resolves.toMatchObject({ changed: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

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
  it.each([
    { "@odata.type": "#microsoft.graph.user" },
    { shortDescription: { private: "provider-body" } },
    { availableTo: null, allowedUsersAndGroups: [principal] },
    { deployedTo: null, acquireUsersAndGroups: [principal] },
    { id: "." },
    { id: "P_\nsuffix" },
  ])("rejects malformed declared resource, descriptions or security identity instead of saving success: %j", async invalid => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...base, ...invalid }));
    await expect(new GraphPackagesClient(fetcher).getPackageDetails("token", base.id))
      .rejects.toMatchObject({ code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["availability", "installation"] as const)("does not accept an additive all-users %s no-op without the selected collection", async target => {
    const property = target === "availability" ? "allowedUsersAndGroups" : "acquireUsersAndGroups";
    const before = allowlistedPackage({ ...base, availableTo: "all", deployedTo: "all", [property]: undefined });
    const fetcher = vi.fn<FetchLike>();
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { target, mode: "add", scope: "specific", principals: [principal] }, before))
      .rejects.toMatchObject({ code: "incomplete_package_access_state" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["availability", "installation"] as const)("does not infer an explicit unknown unselected %s scope from principals", async target => {
    const before = allowlistedPackage({
      ...base, allowedUsersAndGroups: [otherPrincipal], acquireUsersAndGroups: [otherPrincipal],
      [target === "availability" ? "deployedTo" : "availableTo"]: "futureScope",
    });
    const fetcher = vi.fn<FetchLike>();
    const beforeWrite = vi.fn(async () => undefined);
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, target }, before, beforeWrite)).rejects.toMatchObject({ code: "ambiguous_access_scope" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => capturePackageMutationState(before, target === "availability" ? "update-availability" : "update-installation"))
      .toThrow(expect.objectContaining({ code: "ambiguous_access_scope" }));
  });

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

  describe("fixed package catalog continuation", () => {
    const next = `${buildCopilotAgentsListUrl()}&$skiptoken=next`;
    it.each([
      `${next}&$select=id`, `${next}&$expand=elementDetails`, `${next}&$orderby=id`,
      `${next}&$top=1`, `${next}&$skip=1`, `${next}&page=2`,
      `${next}&$skiptoken=other`, `${next}&%24skiptoken=other`, `${next}&%24filter=other`,
      buildCopilotAgentsListUrl(), next.replace(/%24filter=[^&]+/, "%24filter=other"),
      "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$skiptoken=next",
      next.replace("/v1.0/", "/beta/"), next.replace("/packages?", "/packages/other?"),
      next.replace("/packages?", "/packagesExtra?"), next.replace("/packages?", "/packages/?"),
      next.replace("/packages?", "/%70ackages?"),
      next.replace("graph.microsoft.com", "graph.microsoft.com.unapproved.invalid"),
      next.replace("https://", "http://"),
      next.replace("https://", "https://user@"), `${next}#fragment`,
      `${buildCopilotAgentsListUrl()}&$skiptoken=`, next.replace("next", "%0Anext"),
      next.replace("next", "%FF"), next.replace("next", "%zz"), next.replace("next", "ne\txt"),
    ])("rejects changed selectors or malformed continuations before releasing rows or fetching them: %s", async nextLink => {
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [base], "@odata.nextLink": nextLink }));
      await expect(catalog(new GraphPackagesClient(fetcher))).rejects.toMatchObject({ code: "invalid_provider_link" });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("detects equivalent continuations even if query order and encoding change", async () => {
      const alternate = new URL(buildCopilotAgentsListUrl());
      alternate.search = "";
      alternate.searchParams.set("$skiptoken", "next");
      alternate.searchParams.set("$filter", "supportedHosts/any(h:h eq 'Copilot')");
      const fetcher = vi.fn<FetchLike>()
        .mockResolvedValueOnce(Response.json({ value: [base], "@odata.nextLink": next }))
        .mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": alternate.toString().replace("next", "%6Eext") }));
      await expect(catalog(new GraphPackagesClient(fetcher))).rejects.toMatchObject({ code: "provider_continuation" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each(["opaque +/%?&=", "opaque:#\\[]😀", " encoded %2F literal "])(
      "fails duplicate exact identities but keeps case-distinct package IDs and opaque token %j", async token => {
        const continuation = new URL(buildCopilotAgentsListUrl());
        continuation.searchParams.set("$skiptoken", token);
        for (const id of [base.id, base.id.toLowerCase()]) {
          const fetcher = vi.fn<FetchLike>()
            .mockResolvedValueOnce(Response.json({ value: [base], "@odata.nextLink": continuation.toString() }))
            .mockResolvedValueOnce(Response.json({ value: [{ ...base, id }] }));
          const result = catalog(new GraphPackagesClient(fetcher));
          if (id === base.id) await expect(result).rejects.toMatchObject({ code: "provider_schema" });
          else await expect(result).resolves.toMatchObject([{ id: base.id }, { id }]);
          expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("$skiptoken")).toBe(token);
          expect(fetcher).toHaveBeenCalledTimes(2);
        }
      },
    );
  });

  describe("bounded exact package transport authority", () => {
    it.each([".", "..", "id\nsuffix", "id\u0000suffix", "id\uD800"])("rejects unsafe path identities before transport: %j", async id => {
      const fetcher = vi.fn<FetchLike>();
      const client = new GraphPackagesClient(fetcher);
      await expect(client.getPackageDetails("token", id)).rejects.toMatchObject({ code: "invalid_package_id" });
      await expect(client.blockPackage("token", id)).rejects.toMatchObject({ code: "invalid_package_id" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("encodes one exact opaque package path segment without changing ID casing", async () => {
      const id = "P_/..?#%😀";
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...base, id }));
      await expect(new GraphPackagesClient(fetcher).getPackageDetails("token", id)).resolves.toMatchObject({ id });
      const url = new URL(String(fetcher.mock.calls[0][0]));
      expect(url.pathname).toBe(`/v1.0/copilot/admin/catalog/packages/${encodeURIComponent(id)}`);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
    });

    it.each(["token", "admission", "response", "rejection"] as const)("keeps initiating authority over late %s work", async stage => {
      const reason = new AppError(409, "capability_changed", "Authority changed.");
      let current = true;
      const assertCurrent = () => { if (!current) throw reason; };
      const fetcher = vi.fn<FetchLike>(async () => {
        current = false;
        if (stage === "rejection") throw new Error("private provider error");
        return Response.json(base);
      });
      const getAccessToken = async () => { if (stage === "token") current = false; return "token"; };
      const beforeRequest = async () => { if (stage === "admission") current = false; };
      await expect(new GraphPackagesClient(fetcher, { delay: async () => undefined }).getPackageDetails("token", base.id,
        { assertCurrent, getAccessToken, beforeRequest })).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledTimes(stage === "token" || stage === "admission" ? 0 : 1);
    });

    it("rechecks authority before a retry rather than relying on the logical read wrapper", async () => {
      let current = true;
      const reason = new AppError(409, "capability_changed", "Authority changed.");
      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 503 }));
      const wait = vi.fn(async () => { current = false; });
      await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", base.id,
        { assertCurrent: () => { if (!current) throw reason; } })).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(wait).toHaveBeenCalledOnce();
    });

    it("bounds non-cooperative physical admission even with a caller signal that never aborts", async () => {
      const deadline = new AbortController(), caller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      let rejectAdmission!: (error: Error) => void;
      const beforeRequest = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectAdmission = reject; }));
      const fetcher = vi.fn<FetchLike>();
      const result = new GraphPackagesClient(fetcher).getPackageDetails("token", base.id, { signal: caller.signal, beforeRequest });
      const assertion = expect(result).rejects.toMatchObject({ code: "provider_timeout" });
      try {
        await vi.waitFor(() => expect(beforeRequest).toHaveBeenCalledOnce());
        deadline.abort(new DOMException("Synthetic admission deadline.", "TimeoutError"));
        await assertion;
        rejectAdmission(new Error("Private late admission failure."));
        await Promise.resolve();
        expect(fetcher).not.toHaveBeenCalled();
        expect(caller.signal.aborted).toBe(false);
        expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
      } finally { vi.restoreAllMocks(); }
    });

    it.each(["detail", "mutation"] as const)("settles cancelled non-cooperative %s fetches, disposes late bodies and removes listeners", async operation => {
      const controller = new AbortController();
      const reason = new AppError(409, "cancelled", "Cancelled.");
      let resolve!: (response: Response) => void;
      const fetcher = vi.fn<FetchLike>(() => new Promise(done => { resolve = done; }));
      const client = new GraphPackagesClient(fetcher);
      const result = operation === "detail" ? client.getPackageDetails("token", base.id, { signal: controller.signal })
        : client.blockPackage("token", base.id, { signal: controller.signal, correlationId: "noncooperative" });
      const assertion = expect(result).rejects.toBe(reason);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      controller.abort(reason);
      await assertion;
      expect(getEventListeners(fetcher.mock.calls[0][1]!.signal!, "abort")).toHaveLength(0);
      const cancel = vi.fn();
      resolve(new Response(new ReadableStream({ cancel })));
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([0, 1, 2].flatMap(depth => (["detail", "mutation"] as const).flatMap(operation =>
      [false, true].map(subclass => ({ depth, operation, subclass })))))(
      "disposes $operation responses cancelled between settlement and delivery ($depth microtasks, subclass=$subclass)", async ({ depth, operation, subclass }) => {
        const controller = new AbortController();
        const reason = new AppError(409, "read_job_cancelled", "Cancelled.");
        const cancel = vi.fn(() => Promise.reject(new Error("Private disposal failure.")));
        const received = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }));
        const fetcher = vi.fn<FetchLike>(() => {
          const abortLater = (remaining: number) => queueMicrotask(() => {
            if (remaining === 0) controller.abort(reason);
            else abortLater(remaining - 1);
          });
          abortLater(depth);
          return subclass ? ProviderPromise.resolve(received) : Promise.resolve(received);
        });
        const client = new GraphPackagesClient(fetcher);
        const result = operation === "detail" ? client.getPackageDetails("token", base.id, { signal: controller.signal })
          : client.blockPackage("token", base.id, { signal: controller.signal, correlationId: "settlement-race" });
        await expect(result).rejects.toBe(reason);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledOnce();
        expect(received.body?.locked).toBe(false);
        expect(getEventListeners(fetcher.mock.calls[0][1]!.signal!, "abort")).toHaveLength(0);
      },
    );

    it.each([403, 429].flatMap(status => [false, true].map(subclass => ({ status, subclass }))))(
      "retains settled HTTP $status headers when the transport deadline wins delivery (subclass=$subclass)", async ({ status, subclass }) => {
        const deadline = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 30_000 ? deadline.signal : new AbortController().signal);
        const cancel = vi.fn(() => new Promise<void>(() => undefined));
        const pull = vi.fn();
        const fetcher = vi.fn<FetchLike>(() => {
          queueMicrotask(() => queueMicrotask(() => deadline.abort(new DOMException("Request expired.", "TimeoutError"))));
          const received = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
            status, headers: { "Retry-After": "120", "request-id": "settled-response" },
          });
          return subclass ? ProviderPromise.resolve(received) : Promise.resolve(received);
        });
        try {
          await expect(new GraphPackagesClient(fetcher, { maxAttempts: 1 }).getPackageDetails("token", base.id))
            .rejects.toMatchObject({
              status, code: "graph_error",
              details: { httpStatus: status, correlationId: "settled-response", retryAfterMs: 120_000 },
            });
          expect(fetcher).toHaveBeenCalledOnce();
          expect(pull).not.toHaveBeenCalled();
          expect(cancel).toHaveBeenCalledOnce();
        } finally { timeout.mockRestore(); }
      },
    );

    it.each(["caller", "authority"] as const)(
      "keeps initiating %s precedence when a settled denial loses transport delivery", async source => {
        const deadline = new AbortController(), caller = new AbortController();
        const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 30_000 ? deadline.signal : new AbortController().signal);
        const reason = new AppError(401, "authorization_expired", "Initiating authorization changed.");
        let current = true;
        const cancel = vi.fn(() => Promise.reject(new Error("Private disposal failure.")));
        const fetcher = vi.fn<FetchLike>(() => {
          queueMicrotask(() => queueMicrotask(() => {
            deadline.abort(new DOMException("Request expired.", "TimeoutError"));
            if (source === "caller") caller.abort(reason);
            else current = false;
          }));
          return ProviderPromise.resolve(new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { status: 403 }));
        });
        try {
          await expect(new GraphPackagesClient(fetcher).getPackageDetails("token", base.id, {
            signal: caller.signal, assertCurrent: () => { if (!current) throw reason; },
          })).rejects.toBe(reason);
          expect(cancel).toHaveBeenCalledOnce();
          expect(fetcher).toHaveBeenCalledOnce();
        } finally { timeout.mockRestore(); }
      },
    );

    it("observes a late fetch rejection without replacing caller cancellation", async () => {
      const controller = new AbortController();
      const reason = new AppError(409, "read_job_cancelled", "Cancelled.");
      let reject!: (error: Error) => void;
      const fetcher = vi.fn<FetchLike>(() => new Promise((_resolve, fail) => {
        reject = fail;
        queueMicrotask(() => controller.abort(reason));
      }));
      await expect(new GraphPackagesClient(fetcher).blockPackage("token", base.id, {
        signal: controller.signal, correlationId: "late-rejection",
      })).rejects.toBe(reason);
      reject(new Error("Private late provider failure."));
      await Promise.resolve();
      expect(getEventListeners(fetcher.mock.calls[0][1]!.signal!, "abort")).toHaveLength(0);
    });

    it("bounds a non-cooperative mutation timeout without retrying or exposing transport messages", async () => {
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
        return controller.signal;
      });
      try {
        const fetcher = vi.fn<FetchLike>(() => new Promise(() => {}));
        const result = new GraphPackagesClient(fetcher).blockPackage("token", base.id);
        const assertion = expect(result).rejects.toMatchObject({ code: "provider_timeout", status: 504 });
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
        expect(fetcher).toHaveBeenCalledOnce();
        const failure = new GraphPackagesClient(async () => { throw new Error("private-token private-url"); });
        await expect(failure.blockPackage("token", base.id)).rejects.toMatchObject({
          code: "provider_network_error", message: "Microsoft Graph could not be reached.",
        });
      } finally {
        timeout.mockRestore();
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });
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
    { resourceType: "device", resourceId: "group-2" },
    { resourceType: "group", resourceId: "group\n2" },
    { resourceType: "group", resourceId: "group\u00852" },
    { resourceType: "group", resourceId: "group\uD8002" },
    { resourceType: "group", resourceId: "g".repeat(513) },
  ])("does not silently drop an invalid requested principal: %j", async invalid => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, principals: [principal, invalid] }, allowlistedPackage(base)))
      .rejects.toMatchObject({ code: "invalid_principal" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an additive collection beyond the saved observation bound before the dispatch hook", async () => {
    const before = allowlistedPackage({
      ...base, availableTo: "some",
      allowedUsersAndGroups: Array.from({ length: 5000 }, (_, index) => ({ resourceType: "user", resourceId: `user-${index}` })),
    });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const beforeWrite = vi.fn(async () => undefined);
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, mode: "add" }, before, beforeWrite)).rejects.toMatchObject({ code: "invalid_principals" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps an additive exact-identity no-op at the collection limit", async () => {
    const before = allowlistedPackage({
      ...base, availableTo: "some",
      allowedUsersAndGroups: Array.from({ length: 5000 }, (_, index) => ({ resourceType: "user", resourceId: `user-${index}` })),
    });
    const fetcher = vi.fn<FetchLike>();
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id,
      { ...replacement, mode: "add", principals: [{ resourceType: "USER", resourceId: "user-0" }] }, before))
      .resolves.toMatchObject({ changed: false, resultingCount: 5000 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each<Record<string, PackageAccessEntity[]>>([
    { allowedUsersAndGroups: [principal] },
    { allowedUsersAndGroups: [], acquireUsersAndGroups: [], unexpected: [] },
    { allowedUsersAndGroups: [{ resourceType: "device", resourceId: "device-1" }], acquireUsersAndGroups: [] },
    { allowedUsersAndGroups: [{ resourceType: "user", resourceId: "user\0suffix" }], acquireUsersAndGroups: [] },
  ])("rejects an invalid direct access PATCH before transport: %j", async payload => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    await expect(new GraphPackagesClient(fetcher).patchPackageAccess("token", base.id, payload))
      .rejects.toBeInstanceOf(AppError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("dispatches only the validated own principal data, never serialization hooks or extra members", async () => {
    const toJSON = vi.fn(() => ({ resourceId: "different-target", resourceType: "group" }));
    const selected = [{ resourceId: " Exact_User ", resourceType: "USER", extra: "not-a-contract-field", toJSON }];
    Object.defineProperty(selected, "toJSON", { value: toJSON });
    const payload = { allowedUsersAndGroups: selected, acquireUsersAndGroups: [] };
    Object.defineProperty(payload, "toJSON", { value: toJSON });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    await new GraphPackagesClient(fetcher).patchPackageAccess("token", base.id, payload);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      allowedUsersAndGroups: [{ resourceId: " Exact_User ", resourceType: "USER" }],
      acquireUsersAndGroups: [],
    });
    expect(toJSON).not.toHaveBeenCalled();
    expect(selected[0]).toHaveProperty("extra", "not-a-contract-field");
  });

  it("rejects access PATCH collection accessors before reading or dispatching them", async () => {
    const getter = vi.fn(() => [principal]);
    const payload = { allowedUsersAndGroups: [], acquireUsersAndGroups: [] };
    Object.defineProperty(payload, "allowedUsersAndGroups", { get: getter });
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    await expect(new GraphPackagesClient(fetcher).patchPackageAccess("token", base.id, payload))
      .rejects.toMatchObject({ code: "invalid_access_update" });
    expect(getter).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates the unselected payload before marking a write ready to dispatch", async () => {
    const beforeWrite = vi.fn(async () => undefined);
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const details = {
      ...allowlistedPackage(base), acquireUsersAndGroups: [{ resourceType: "user", resourceId: " " }, otherPrincipal],
    };
    await expect(updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, replacement, details, beforeWrite))
      .rejects.toMatchObject({ code: "invalid_principal" });
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deduplicates exact principal IDs with case-insensitive user/group types and preserves a known unselected scope", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const before = allowlistedPackage({ ...base, deployedTo: "some", acquireUsersAndGroups: [otherPrincipal] });
    const update: PackageAccessUpdate = {
      ...replacement, principals: [principal, { resourceType: "GROUP", resourceId: "group-1" }],
    };
    const result = await updatePackageAccess(new GraphPackagesClient(fetcher), "token", base.id, update, before);
    expect(result).toMatchObject({ changed: true, previousCount: 0, resultingCount: 1 });
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      allowedUsersAndGroups: [{ resourceType: "GROUP", resourceId: "group-1" }],
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
