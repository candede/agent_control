import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type {
  CopilotPackageDetail,
  PackageAccessEntity,
} from "../types/copilotPackage.js";
import {
  buildCopilotAgentsListUrl,
  bulkGetPackageDetails,
  bulkSetBlockedState,
  bulkUpdatePackageAccess,
  GraphPackagesClient,
  graphError,
  updatePackageAccess,
  verifyPackageMutationConverged,
  verifyPackageAccessApplied,
  type FetchLike,
} from "./graphPackages.js";

describe("GraphPackagesClient", () => {
  it("builds the Copilot agents list URL with the required filter", () => {
    const url = new URL(buildCopilotAgentsListUrl());

    expect(url.origin).toBe("https://graph.microsoft.com");
    expect(url.pathname).toBe("/v1.0/copilot/admin/catalog/packages");
    expect(url.searchParams.get("$filter")).toBe(
      "supportedHosts/any(h:h eq 'Copilot')",
    );
  });

  it.each([0, 1, 3])("accepts a valid first catalog page with %i rows and never follows pagination", async count => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      value: Array.from({ length: count }, (_, index) => ({ id: `P_${index}`, displayName: "Package", isBlocked: false })),
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2",
    }));
    await expect(new GraphPackagesClient(fetcher).checkCatalogAccess("token")).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...new URL(String(fetcher.mock.calls[0][0])).searchParams.keys()]).toEqual(["$filter"]);
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("$filter")).toBe("supportedHosts/any(h:h eq 'Copilot')");
    expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  });

  it.each([null, {}, { value: null }, { value: {} }, { value: [{ id: 12 }] }])("still rejects invalid catalog first-page schemas: %j", async body => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json(body));
    await expect(new GraphPackagesClient(fetcher).checkCatalogAccess("token")).rejects.toMatchObject({ code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains the response byte limit for catalog checks without requesting an undocumented row limit", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response("x".repeat(2_000_001)));
    await expect(new GraphPackagesClient(fetcher).checkCatalogAccess("token")).rejects.toMatchObject({ code: "provider_result_limit" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["probe", "inventory", "detail"])("allows a slow package %s read within a finite 30-second deadline", async operation => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const fetcher = vi.fn<FetchLike>(async (_url, init) => new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        setTimeout(() => resolve(Response.json(operation === "detail"
          ? { id: "P_1", displayName: "Package", isBlocked: false } : { value: [] })), 12_000);
      }));
      const client = new GraphPackagesClient(fetcher);
      const result = operation === "probe" ? client.checkCatalogAccess("token")
        : operation === "inventory" ? client.listCopilotAgents("token") : client.getPackageDetails("token", "P_1");
      const assertion = expect(result).resolves.toEqual(operation === "probe" ? undefined
        : operation === "inventory" ? [] : expect.objectContaining({ id: "P_1", isBlocked: false }));
      await vi.advanceTimersByTimeAsync(12_000);
      await assertion;
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("keeps mutation requests bounded to ten seconds without read retries", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    try {
      await new GraphPackagesClient(fetcher).blockPackage("token", "P_1");
      expect(timeout).toHaveBeenCalledOnce();
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); }
  });

  it("cancels a stalled successful catalog response body at the caller deadline", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({ cancel })));
    const result = new GraphPackagesClient(fetcher).checkCatalogAccess("token", controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains only bounded Graph status, code, and response request ID diagnostics", async () => {
    const error = await graphError(Response.json({
      error: { code: "Authorization_RequestDenied", message: "person@example.invalid private-token", innerError: { secret: "private-body" } },
    }, { status: 403, headers: { "request-id": "graph-request-123", "client-request-id": "client-request-123" } }));
    expect(error).toMatchObject({ status: 403, code: "Authorization_RequestDenied", details: {
      httpStatus: 403, providerErrorCode: "Authorization_RequestDenied", correlationId: "graph-request-123",
    } });
    expect(error.message).toBe("Microsoft Graph request failed with status 403.");
    expect(JSON.stringify(error)).not.toMatch(/person@|private-token|private-body/);
  });

  it.each(["<html>person@example.invalid private-token</html>", "{", JSON.stringify({ error: { code: "x".repeat(129), message: "private-token" } })])(
    "does not surface malformed or unbounded provider diagnostics", async body => {
      const error = await graphError(new Response(body, { status: 502, headers: { "request-id": "person@example.invalid", "client-request-id": "x".repeat(129) } }));
      expect(error.details).toEqual({ httpStatus: 502, retryAfterMs: undefined });
      expect(error.code).toBe("graph_error");
      expect(JSON.stringify(error)).not.toMatch(/person@|private-token/);
    },
  );

  it("uses a safe echoed client request ID when no valid provider request ID exists", async () => {
    const error = await graphError(new Response("invalid body", { status: 500, headers: { "request-id": "bad/id", "client-request-id": "client-123" } }));
    expect(error.details).toMatchObject({ httpStatus: 500, correlationId: "client-123" });
  });

  it("categorizes network failures without exposing their messages or retrying a mutation", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("private-url private-token"); });
    const client = new GraphPackagesClient(fetcher);
    await expect(client.checkCatalogAccess("token")).rejects.toMatchObject({ code: "provider_network_error" });
    await expect(client.blockPackage("token", "P_1")).rejects.toMatchObject({ code: "provider_network_error" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains the existing 424 throttling retry without publishing the provider message", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ error: { code: "FailedDependency", message: "too many requests private-token" } }, { status: 424 }))
      .mockResolvedValueOnce(Response.json({ value: [] }));
    const wait = vi.fn(async () => undefined);
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).checkCatalogAccess("token")).resolves.toBeUndefined();
    expect(wait).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("follows Microsoft Graph pagination while listing agents", async () => {
    const fetcher = vi.fn<FetchLike>(async (input) => {
      const url = input.toString();

      if (url.includes("page=2")) {
        return Response.json({
          value: [
            {
              id: "P_2",
              displayName: "Second",
              isBlocked: true,
              supportedHosts: ["Copilot"],
            },
          ],
        });
      }

      return Response.json({
        value: [
          {
            id: "P_1",
            displayName: "First",
            isBlocked: false,
            supportedHosts: ["Copilot"],
          },
        ],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2",
      });
    });

    const client = new GraphPackagesClient(fetcher);
    const agents = await client.listCopilotAgents("token");

    expect(agents.map((agent) => agent.id)).toEqual(["P_1", "P_2"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a hostile pagination link before sending the token", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      value: [],
      "@odata.nextLink": "https://unapproved.invalid/v1.0/copilot/admin/catalog/packages",
    }));

    await expect(new GraphPackagesClient(fetcher).listCopilotAgents("token")).rejects.toMatchObject({
      status: 502,
      code: "invalid_provider_link",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures while reading package details", async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "ServiceUnavailable", message: "Try again" } },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "P_1", displayName: "First", isBlocked: false }),
      );
    const retryDelay = vi.fn(async () => undefined);
    const client = new GraphPackagesClient(fetcher, {
      maxAttempts: 2,
      delay: retryDelay,
    });

    await expect(
      client.getPackageDetails("token", "P_1"),
    ).resolves.toMatchObject({ id: "P_1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["block", "/beta/copilot/admin/catalog/packages/P_1/block"],
    ["unblock", "/beta/copilot/admin/catalog/packages/P_1/unblock"],
  ] as const)("dispatches the documented beta %s operation once", async (action, pathname) => {
    const fetcher = vi.fn<FetchLike>(async (input, request) => {
      expect(new URL(input).pathname).toBe(pathname);
      expect(request?.method).toBe("POST");
      expect(request?.body).toBeUndefined();
      expect(new Headers(request?.headers).get("client-request-id")).toBe("correlation-1");
      return new Response(null, { status: 204 });
    });
    const client = new GraphPackagesClient(fetcher);
    await client[action === "block" ? "blockPackage" : "unblockPackage"]("token", "P_1", { correlationId: "correlation-1" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("uses the documented beta reassignment contract but does not infer owner verification", async () => {
    const fetcher = vi.fn<FetchLike>(async (input, request) => {
      expect(new URL(input).pathname).toBe("/beta/copilot/admin/catalog/packages/P_1/reassign");
      expect(request?.method).toBe("POST");
      expect(JSON.parse(String(request?.body))).toEqual({ userId: "11111111-1111-4111-8111-111111111111" });
      return new Response(null, { status: 204 });
    });
    await new GraphPackagesClient(fetcher).reassignPackage("token", "P_1", "11111111-1111-4111-8111-111111111111", { correlationId: "correlation-2" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never retries a mutation dispatch after a provider failure", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ error: { code: "ServiceUnavailable", message: "uncertain" } }, { status: 503 }));
    await expect(new GraphPackagesClient(fetcher, { maxAttempts: 3, delay: async () => undefined }).blockPackage("token", "P_1", { correlationId: "correlation-3" }))
      .rejects.toMatchObject({ status: 503, code: "ServiceUnavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("repeats bounded detail reads until a block mutation converges", async () => {
    let reads = 0;
    const client = new GraphPackagesClient(async () => {
      reads += 1;
      return Response.json({ id: "P_1", displayName: "First", isBlocked: reads >= 3 });
    });
    await expect(verifyPackageMutationConverged(client, "token", "P_1", "block", { kind: "block", isBlocked: true }, { maxAttempts: 4, delayMs: 0 })).resolves.toMatchObject({ readbackCount: 3 });
    expect(reads).toBe(3);
  });

  it("keeps accepted-but-not-applied state inconclusive after the readback bound", async () => {
    const client = new GraphPackagesClient(async () => Response.json({ id: "P_1", displayName: "First", isBlocked: false }));
    await expect(verifyPackageMutationConverged(client, "token", "P_1", "block", { kind: "block", isBlocked: true }, { maxAttempts: 3, delayMs: 0 })).rejects.toMatchObject({
      code: "verification_inconclusive",
      details: { lastState: { kind: "block", isBlocked: false }, readbackCount: 3 },
    });
  });

  it("propagates an overall readback abort without starting another retry", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<FetchLike>(async (_input, request) => new Promise((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    }));
    const verification = verifyPackageMutationConverged(new GraphPackagesClient(fetcher), "token", "P_1", "block", { kind: "block", isBlocked: true }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort(new AppError(409, "cancelled", "cancelled"));
    await expect(verification).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("replaces the selected collection and preserves the other collection", async () => {
    const fetcher = vi.fn<FetchLike>(async (_url, init) =>
      init?.method === "PATCH"
        ? new Response(null, { status: 204 })
        : Response.json({
            id: "P_1",
            displayName: "First",
            isBlocked: false,
            allowedUsersAndGroups: [
              { resourceType: "group", resourceId: "old-group" },
            ],
            acquireUsersAndGroups: [
              { resourceType: "user", resourceId: "installed-user" },
            ],
          }),
    );
    const client = new GraphPackagesClient(fetcher);

    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "replace",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: "group-1" },
        { resourceType: "user", resourceId: "user-1" },
      ],
    });

    expect(result).toMatchObject({
      changed: true,
      previousCount: 1,
      resultingCount: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1];
    expect(url.toString()).toBe(
      "https://graph.microsoft.com/beta/copilot/admin/catalog/packages/P_1",
    );
    expect(init).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String(init?.body))).toEqual({
      allowedUsersAndGroups: [
        { resourceType: "group", resourceId: "group-1" },
        { resourceType: "user", resourceId: "user-1" },
      ],
      acquireUsersAndGroups: [
        { resourceType: "user", resourceId: "installed-user" },
      ],
    });
  });

  it("refuses to update when the unselected collection is missing", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "some",
          allowedUsersAndGroups: [
            { resourceType: "group", resourceId: "old-group" },
          ],
        };
      }
    }

    const client = new FakeClient();

    await expect(
      updatePackageAccess(client, "token", "P_1", {
        target: "availability",
        mode: "replace",
        scope: "specific",
        principals: [{ resourceType: "group", resourceId: "new-group" }],
      }),
    ).rejects.toMatchObject({ code: "incomplete_package_access_state" });
    expect(client.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("skips a replace when the selected collection already matches", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          allowedUsersAndGroups: [
            { resourceType: "user", resourceId: "user-1" },
            { resourceType: "group", resourceId: "group-1" },
          ],
        };
      }
    }

    const client = new FakeClient();
    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "replace",
      scope: "specific",
      principals: [
        { resourceType: "group", resourceId: "GROUP-1" },
        { resourceType: "user", resourceId: "USER-1" },
      ],
    });

    expect(result).toMatchObject({
      changed: false,
      previousCount: 2,
      resultingCount: 2,
    });
    expect(client.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("merges package access for add mode and skips a no-op", async () => {
    class FakeClient extends GraphPackagesClient {
      patches: Array<Record<string, PackageAccessEntity[]>> = [];

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          allowedUsersAndGroups: [
            { resourceType: "user", resourceId: "allowed-user" },
          ],
          acquireUsersAndGroups: [
            { resourceType: "group", resourceId: "group-1" },
          ],
        };
      }

      override async patchPackageAccess(
        _accessToken: string,
        _id: string,
        payload: Record<string, PackageAccessEntity[]>,
      ) {
        this.patches.push(payload);
      }
    }

    const client = new FakeClient();
    const noOp = await updatePackageAccess(client, "token", "P_1", {
      target: "installation",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "group", resourceId: "group-1" }],
    });
    const changed = await updatePackageAccess(client, "token", "P_1", {
      target: "installation",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "user", resourceId: "user-2" }],
    });

    expect(noOp.changed).toBe(false);
    expect(changed).toMatchObject({
      changed: true,
      previousCount: 1,
      resultingCount: 2,
    });
    expect(client.patches).toEqual([
      {
        allowedUsersAndGroups: [
          { resourceType: "user", resourceId: "allowed-user" },
        ],
        acquireUsersAndGroups: [
          { resourceType: "group", resourceId: "group-1" },
          { resourceType: "user", resourceId: "user-2" },
        ],
      },
    ]);
  });

  it("does not narrow all-user access in add mode", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          allowedUsersAndGroups: [
            { resourceType: "group", resourceId: "group-existing" },
          ],
        };
      }
    }

    const client = new FakeClient();
    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "group", resourceId: "group-1" }],
    });

    expect(result.changed).toBe(false);
    expect(client.patchPackageAccess).not.toHaveBeenCalled();
  });

  it("recognizes legacy some-user status in add mode", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "allowedForSome",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        };
      }
    }

    const client = new FakeClient();
    await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "add",
      scope: "specific",
      principals: [{ resourceType: "group", resourceId: "group-1" }],
    });

    expect(client.patchPackageAccess).toHaveBeenCalledWith("token", "P_1", {
      allowedUsersAndGroups: [{ resourceType: "group", resourceId: "group-1" }],
      acquireUsersAndGroups: [],
    });
  });

  it("does not skip a replacement when the status scope differs", async () => {
    class FakeClient extends GraphPackagesClient {
      patchPackageAccess = vi.fn();

      override async getPackageDetails(): Promise<CopilotPackageDetail> {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        };
      }
    }

    const client = new FakeClient();
    const result = await updatePackageAccess(client, "token", "P_1", {
      target: "availability",
      mode: "replace",
      scope: "none",
      principals: [],
    });

    expect(result.changed).toBe(true);
    expect(client.patchPackageAccess).toHaveBeenCalledWith("token", "P_1", {
      allowedUsersAndGroups: [],
      acquireUsersAndGroups: [],
    });
  });

  it("rejects a PATCH that Graph accepts without changing effective access", () => {
    expect(() =>
      verifyPackageAccessApplied(
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          allowedUsersAndGroups: [],
        },
        {
          target: "availability",
          mode: "replace",
          scope: "none",
          principals: [],
        },
        [],
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          deployedTo: "none",
          acquireUsersAndGroups: [],
        },
      ),
    ).toThrow("Effective access is still All users");
  });

  it("rejects a PATCH when Graph reports the scope but not the principals", () => {
    expect(() =>
      verifyPackageAccessApplied(
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "some",
          allowedUsersAndGroups: [
            { resourceType: "group", resourceId: "different-group" },
          ],
        },
        {
          target: "availability",
          mode: "replace",
          scope: "specific",
          principals: [{ resourceType: "group", resourceId: "group-1" }],
        },
        [{ resourceType: "group", resourceId: "group-1" }],
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          deployedTo: "none",
          acquireUsersAndGroups: [],
        },
      ),
    ).toThrow("did not apply the requested Specific users or groups");
  });

  it("rejects a PATCH that changes the unselected access setting", () => {
    expect(() =>
      verifyPackageAccessApplied(
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "none",
          deployedTo: "none",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        },
        {
          target: "availability",
          mode: "replace",
          scope: "none",
          principals: [],
        },
        [],
        {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
          availableTo: "all",
          deployedTo: "all",
          allowedUsersAndGroups: [],
          acquireUsersAndGroups: [],
        },
      ),
    ).toThrow("changed the unselected Installed for access setting");
  });

  it("rejects add mode when the current access scope is ambiguous", async () => {
    class FakeClient extends GraphPackagesClient {
      override async getPackageDetails() {
        return {
          id: "P_1",
          displayName: "First",
          isBlocked: false,
        };
      }
    }

    await expect(
      updatePackageAccess(new FakeClient(), "token", "P_1", {
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [{ resourceType: "group", resourceId: "group-1" }],
      }),
    ).rejects.toMatchObject({ status: 409, code: "ambiguous_access_scope" });
  });

  it("summarizes best-effort bulk access updates", async () => {
    class FakeClient extends GraphPackagesClient {
      private updatedIds = new Set<string>();

      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Already assigned", isBlocked: false },
          { id: "P_2", displayName: "Updates", isBlocked: false },
          { id: "P_3", displayName: "Fails", isBlocked: false },
        ];
      }

      override async getPackageDetails(
        _accessToken: string,
        id: string,
      ): Promise<CopilotPackageDetail> {
        if (id === "P_3") {
          throw new AppError(403, "Authorization_RequestDenied", "denied");
        }

        return {
          id,
          displayName: id,
          isBlocked: false,
          availableTo:
            id === "P_1" || this.updatedIds.has(id) ? "some" : "none",
          acquireUsersAndGroups: [],
          allowedUsersAndGroups:
            id === "P_1" || this.updatedIds.has(id)
              ? [{ resourceType: "group", resourceId: "group-1" }]
              : [],
        };
      }

      override async patchPackageAccess(_accessToken: string, id: string) {
        this.updatedIds.add(id);
      }
    }

    const events: string[] = [];
    const result = await bulkUpdatePackageAccess(
      new FakeClient(),
      "token",
      {
        target: "availability",
        mode: "add",
        scope: "specific",
        principals: [{ resourceType: "group", resourceId: "group-1" }],
      },
      {
        packageIds: ["P_1", "P_2", "P_3", "P_missing"],
        writePauseMs: 0,
        onPackageStart: (agent) => {
          events.push(`start:${agent.id}`);
        },
        onPackageResult: (item) => {
          events.push(`result:${item.id}:${item.status}`);
        },
      },
    );

    expect(result).toMatchObject({
      total: 4,
      succeeded: 1,
      skipped: 1,
      failed: 2,
      accessUpdate: { target: "availability", mode: "add" },
    });
    expect(result.results.find((item) => item.id === "P_1")).toMatchObject({
      status: "skipped",
      accessResult: { changed: false, previousCount: 1, resultingCount: 1 },
    });
    expect(result.results.find((item) => item.id === "P_3")).toMatchObject({
      status: "failed",
      errorCode: "Authorization_RequestDenied",
    });
    expect(events).toContain("result:P_missing:failed");
  });

  it("summarizes best-effort bulk block results", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Ready", isBlocked: false },
          { id: "P_2", displayName: "Already blocked", isBlocked: true },
          { id: "P_3", displayName: "Fails", isBlocked: false },
        ];
      }

      override async blockPackage(_accessToken: string, id: string) {
        if (id === "P_3") {
          throw new AppError(403, "Forbidden", "blocked by policy", {
            graph: {
              error: { code: "Forbidden", message: "blocked by policy" },
            },
          });
        }
      }
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      writePauseMs: 0,
    });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.map((item) => item.status).sort()).toEqual([
      "failed",
      "skipped",
      "succeeded",
    ]);
    expect(result.results.find((item) => item.id === "P_3")).toMatchObject({
      status: "failed",
      message: "blocked by policy",
      errorCode: "Forbidden",
      errorDetails: {
        graph: { error: { code: "Forbidden", message: "blocked by policy" } },
      },
    });
  });

  it("reports bulk package starts before package results", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [{ id: "P_1", displayName: "Ready", isBlocked: false }];
      }

      override async blockPackage() {}
    }

    const events: string[] = [];

    await bulkSetBlockedState(new FakeClient(), "token", true, {
      writePauseMs: 0,
      onPackageStart: (agent) => {
        events.push(`start:${agent.id}`);
      },
      onPackageResult: (result) => {
        events.push(`result:${result.id}:${result.status}`);
      },
    });

    expect(events).toEqual(["start:P_1", "result:P_1:succeeded"]);
  });

  it("keeps package results stable when progress hooks fail", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Ready", isBlocked: false },
          { id: "P_2", displayName: "Already blocked", isBlocked: true },
        ];
      }

      override async blockPackage() {}
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      writePauseMs: 0,
      onPackageStart: () => {
        throw new Error("progress unavailable");
      },
      onPackageResult: () => {
        throw new Error("audit unavailable");
      },
    });

    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results.map((item) => item.status).sort()).toEqual([
      "skipped",
      "succeeded",
    ]);
    expect(result.sideEffectErrors).toEqual([
      { phase: "start", agentId: "P_2", message: "progress unavailable" },
      { phase: "result", agentId: "P_2", message: "audit unavailable" },
      { phase: "start", agentId: "P_1", message: "progress unavailable" },
      { phase: "result", agentId: "P_1", message: "audit unavailable" },
    ]);
  });

  it("falls back to the default concurrency for invalid values", async () => {
    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [{ id: "P_1", displayName: "Ready", isBlocked: false }];
      }

      override async blockPackage() {}
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      writeConcurrency: 0,
      writePauseMs: 0,
    });

    expect(result.succeeded).toBe(1);
  });

  it("replaces plain-text Graph error bodies with safe status diagnostics", async () => {
    const client = new GraphPackagesClient(
      async () =>
        new Response("Service temporarily unavailable", { status: 503 }),
      { maxAttempts: 1 },
    );

    await expect(client.listCopilotAgents("token")).rejects.toMatchObject({
      status: 503,
      code: "graph_error",
      message: "Microsoft Graph request failed with status 503.",
      details: {
        httpStatus: 503,
      },
    });
  });

  it("limits bulk writes to selected packages", async () => {
    const blockedIds: string[] = [];

    class FakeClient extends GraphPackagesClient {
      override async listCopilotAgents() {
        return [
          { id: "P_1", displayName: "Ready", isBlocked: false },
          { id: "P_2", displayName: "Already blocked", isBlocked: true },
          { id: "P_3", displayName: "Not selected", isBlocked: false },
        ];
      }

      override async blockPackage(_accessToken: string, id: string) {
        blockedIds.push(id);
      }
    }

    const result = await bulkSetBlockedState(new FakeClient(), "token", true, {
      packageIds: ["P_1", "P_2", "P_missing"],
      writePauseMs: 0,
    });

    expect(blockedIds).toEqual(["P_1"]);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.map((item) => item.id).sort()).toEqual([
      "P_1",
      "P_2",
      "P_missing",
    ]);
  });

  it("summarizes best-effort bulk detail results", async () => {
    class FakeClient extends GraphPackagesClient {
      override async getPackageDetails(_accessToken: string, id: string) {
        if (id === "P_2") {
          throw new Error("detail unavailable");
        }

        return {
          id,
          displayName: id === "P_1" ? "First" : "Third",
          isBlocked: false,
          sensitivity: "Unspecified",
        };
      }
    }

    const result = await bulkGetPackageDetails(
      new FakeClient(),
      "token",
      ["P_1", "P_2", "P_3"],
      { detailConcurrency: 2 },
    );

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
  });
});
