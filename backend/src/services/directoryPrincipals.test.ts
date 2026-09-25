import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import {
  buildGroupSearchUrl,
  buildUserSearchUrl,
  DirectoryPrincipalsClient,
  validateDirectoryUrl,
} from "./directoryPrincipals.js";
import type { FetchLike } from "./graphPackages.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const securityGroupId = "22222222-2222-4222-8222-222222222222";
const microsoft365GroupId = "33333333-3333-4333-8333-333333333333";
const distributionGroupId = "44444444-4444-4444-8444-444444444444";

describe("DirectoryPrincipalsClient", () => {
  it("escapes directory search terms and bounds selected fields", () => {
    const userUrl = new URL(buildUserSearchUrl('Sales "East"', 25));
    const groupUrl = new URL(buildGroupSearchUrl('Sales "East"', 25));

    expect(userUrl.searchParams.get("$search")).toContain(
      'displayName:Sales \\"East\\"',
    );
    expect(userUrl.searchParams.get("$select")).toBe(
      "id,displayName,mail,userPrincipalName",
    );
    expect(userUrl.searchParams.get("$count")).toBe("true");
    expect(groupUrl.searchParams.get("$search")).toContain(
      'description:Sales \\"East\\"',
    );
    expect(groupUrl.searchParams.get("$count")).toBe("true");
  });

  it("returns users, security groups, and Microsoft 365 groups only", async () => {
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      expect(new Headers(init?.headers).get("ConsistencyLevel")).toBe(
        "eventual",
      );

      if (input.toString().includes("/users")) {
        return Response.json({
          value: [
            {
              id: userId,
              displayName: "Adele Vance",
              mail: "adele@example.com",
            },
          ],
        });
      }

      return Response.json({
        value: [
          {
            id: securityGroupId,
            displayName: "Security Team",
            groupTypes: [],
            securityEnabled: true,
          },
          {
            id: microsoft365GroupId,
            displayName: "Marketing",
            groupTypes: ["Unified"],
            securityEnabled: false,
          },
          {
            id: distributionGroupId,
            displayName: "Newsletter",
            groupTypes: [],
            securityEnabled: false,
          },
        ],
      });
    });

    const result = await new DirectoryPrincipalsClient(fetcher).search(
      "token",
      "ma",
    );

    expect(result.map((principal) => principal.principalKind).sort()).toEqual([
      "microsoft365Group",
      "securityGroup",
      "user",
    ]);
    expect(
      result.some((principal) => principal.resourceId === distributionGroupId),
    ).toBe(false);
  });

  it("rejects overlong directory searches before calling Graph", async () => {
    const fetcher = vi.fn<FetchLike>();

    await expect(
      new DirectoryPrincipalsClient(fetcher).search("token", "x".repeat(121)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_directory_search" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["users", "groups"])("rejects a null %s search collection", async (collection) => {
    const fetcher = vi.fn<FetchLike>(async (input) =>
      Response.json(new URL(input).pathname.endsWith(`/${collection}`) ? null : { value: [] }),
    );

    await expect(new DirectoryPrincipalsClient(fetcher).search("token", "ma"))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
  });

  it.each(["user", "group"])("rejects malformed resolved %s identities", async (resourceType) => {
    for (const payload of [null, {}, { id: null }, { id: 123 }, { id: "not-an-object-id" }]) {
      const fetcher = vi.fn<FetchLike>(async () => Response.json(payload));

      await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", [
        { resourceType, resourceId: userId },
      ])).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    }
  });

  it.each([
    { securityEnabled: "false" },
    { securityEnabled: 1 },
    { securityEnabled: {} },
    { securityEnabled: [] },
  ])("rejects invalid security-group flags: %j", async ({ securityEnabled }) => {
    const group = { id: securityGroupId, displayName: "Group", groupTypes: [], securityEnabled };
    const searchFetcher = vi.fn<FetchLike>(async (input) =>
      Response.json({ value: new URL(input).pathname.endsWith("/groups") ? [group] : [] }),
    );
    await expect(new DirectoryPrincipalsClient(searchFetcher).search("token", "gr"))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });

    const resolveFetcher = vi.fn<FetchLike>(async () => Response.json(group));
    await expect(new DirectoryPrincipalsClient(resolveFetcher).resolve("token", [
      { resourceType: "group", resourceId: securityGroupId },
    ])).rejects.toMatchObject({ status: 502, code: "provider_schema" });
  });

  it("rejects directory requests outside the documented Graph origin and paths", () => {
    expect(() => validateDirectoryUrl("https://unapproved.invalid/v1.0/users")).toThrowError(expect.objectContaining({ code: "invalid_provider_link" }));
    expect(() => validateDirectoryUrl("https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages")).toThrowError(expect.objectContaining({ code: "invalid_provider_link" }));
    expect(() => validateDirectoryUrl("https://user:password@graph.microsoft.com/v1.0/groups")).toThrowError(expect.objectContaining({ code: "invalid_provider_link" }));
  });

  it("uses raw IDs for missing principals but surfaces permission errors", async () => {
    const missingFetcher = vi.fn<FetchLike>(async () =>
      Response.json(
        { error: { code: "Request_ResourceNotFound", message: "missing" } },
        { status: 404 },
      ),
    );
    const missing = await new DirectoryPrincipalsClient(missingFetcher).resolve(
      "token",
      [{ resourceType: "user", resourceId: userId }],
    );

    expect(missing[0]).toMatchObject({
      displayName: userId,
      principalKind: "unknown",
    });

    const forbiddenFetcher = vi.fn<FetchLike>(async () =>
      Response.json(
        { error: { code: "Authorization_RequestDenied", message: "denied" } },
        { status: 403 },
      ),
    );

    await expect(
      new DirectoryPrincipalsClient(forbiddenFetcher).resolve("token", [
        { resourceType: "group", resourceId: securityGroupId },
      ]),
    ).rejects.toMatchObject({
      status: 403,
      code: "Authorization_RequestDenied",
    });
  });

  it.each([false, null, undefined])("preserves unsupported group labels with securityEnabled=%s", async (securityEnabled) => {
    const group = {
      id: distributionGroupId,
      displayName: "Newsletter",
      groupTypes: [],
      securityEnabled,
    };
    const fetcher = vi.fn<FetchLike>(async (input) => {
      const { pathname } = new URL(input);
      return Response.json(pathname.endsWith("/groups")
        ? { value: [group] }
        : pathname.endsWith("/users") ? { value: [] } : group);
    });
    const client = new DirectoryPrincipalsClient(fetcher);
    const [resolved] = await client.resolve(
      "token",
      [{ resourceType: "group", resourceId: distributionGroupId }],
    );

    expect(resolved).toMatchObject({
      displayName: "Newsletter",
      principalKind: "unknown",
    });
    await expect(client.search("token", "news")).resolves.toEqual([]);
  });

  it("keeps UPN separate from mail and honors caller cancellation", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      id: userId, displayName: "Person", mail: "mail@example.invalid", userPrincipalName: "login@example.invalid",
    }));
    const client = new DirectoryPrincipalsClient(fetcher);
    expect((await client.resolve("token", [{ resourceType: "user", resourceId: userId }]))[0]).toMatchObject({
      secondaryText: "mail@example.invalid", userPrincipalName: "login@example.invalid",
    });
    fetcher.mockClear();
    const controller = new AbortController();
    controller.abort(new Error("Stopped"));
    await expect(client.resolve("token", [{ resourceType: "user", resourceId: userId }], controller.signal)).rejects.toThrow("Stopped");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([200, 403, 404].flatMap(status =>
    [false, true].map(deadline => ({ status, deadline })),
  ))("cancels a stalled directory body with status $status (deadline: $deadline)", async ({ status, deadline }) => {
    const controller = new AbortController();
    const timeout = deadline ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal) : undefined;
    const cancel = vi.fn();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { streamController = stream; },
      cancel,
    });
    const fetcher = vi.fn<FetchLike>(async () => new Response(body, { status }));
    const pending = new DirectoryPrincipalsClient(fetcher).resolve("token", [
      { resourceType: "user", resourceId: userId },
    ], deadline ? undefined : controller.signal);
    const observed = pending.then(
      value => ({ status: "resolved", value }),
      error => ({ status: "rejected", error }),
    );
    await setImmediate();
    const reason = new DOMException("Directory lookup cancelled", deadline ? "TimeoutError" : "AbortError");
    controller.abort(reason);

    try {
      const result = await Promise.race([observed, setImmediate().then(() => "still pending")]);
      expect(result).toEqual({ status: "rejected", error: reason });
      expect(cancel).toHaveBeenCalledOnce();
      if (timeout) expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      streamController.error(reason);
      await observed;
      timeout?.mockRestore();
    }
  });

  it.each(["user", "group"].flatMap(resourceType => [
    { resourceType, reason: new DOMException("Directory request timed out", "TimeoutError") },
    { resourceType, reason: new AppError(404, "cancelled", "Directory request cancelled") },
  ]))("does not convert an aborted $resourceType 404 body into a missing principal ($reason.name)", async ({ resourceType, reason }) => {
    const controller = new AbortController();
    const fetcher = vi.fn<FetchLike>(async () => {
      controller.abort(reason);
      return new Response(new ReadableStream({
        start(stream) { stream.error(reason); },
      }), { status: 404 });
    });

    await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", [
      { resourceType, resourceId: userId },
    ], controller.signal)).rejects.toBe(reason);
  });

  it("does not start a search after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<FetchLike>();
    await expect(new DirectoryPrincipalsClient(fetcher).search("token", "person", 25, controller.signal))
      .rejects.toBe(controller.signal.reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["http", "schema"])("cancels the other search collection after a %s failure", async failure => {
    const cancel = vi.fn();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(stream) { streamController = stream; },
      cancel,
    });
    const fetcher = vi.fn<FetchLike>(async input => new URL(input).pathname.endsWith("/users")
      ? failure === "http"
        ? Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 })
        : Response.json({ value: [{ id: "not-an-object-id" }] })
      : new Response(body));
    const pending = new DirectoryPrincipalsClient(fetcher).search("token", "person").catch(error => error);
    try {
      expect(await Promise.race([pending, setImmediate("still pending")])).toMatchObject({
        code: failure === "http" ? "Authorization_RequestDenied" : "provider_schema",
      });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      streamController.error(new Error("Search fixture cleanup"));
      await pending;
    }
  });

  it.each(["search", "resolve"] as const)("preserves cancellation immediately before %s publication", async operation => {
    for (const depth of [4, 5, 6]) {
      const controller = new AbortController();
      const reason = new DOMException("Directory lookup cancelled", "AbortError");
      const fetcher = vi.fn<FetchLike>(async input => {
        const payload = operation === "search"
          ? { value: new URL(input).pathname.endsWith("/users") ? [{ id: userId }] : [] }
          : { id: userId };
        return new Response(new ReadableStream<Uint8Array>({
          start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(payload))); },
          pull(stream) {
            stream.close();
            const abortLater = (remaining: number) => {
              if (!remaining) controller.abort(reason);
              else queueMicrotask(() => abortLater(remaining - 1));
            };
            abortLater(depth);
          },
        }, { highWaterMark: 0 }));
      });
      const client = new DirectoryPrincipalsClient(fetcher);
      const pending = operation === "search"
        ? client.search("token", "person", 25, controller.signal)
        : client.resolve("token", [{ resourceType: "user", resourceId: userId }], controller.signal);
      const outcome = await pending.then(value => ({ value }), error => ({ error }));
      expect(controller.signal.aborted).toBe(true);
      expect(outcome).toEqual({ error: reason });
    }
  });

  it.each([200, 403, 404])("keeps the request deadline authoritative between body completion and response mapping for %s", async status => {
    const controller = new AbortController();
    const reason = new DOMException("Directory request timed out", "TimeoutError");
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode(JSON.stringify(status === 200
          ? { id: userId } : { error: { code: "Request_ResourceNotFound" } })));
      },
      pull(stream) {
        stream.close();
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort(reason)))));
      },
    }, { highWaterMark: 0 }), { status }));
    try {
      await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", [{ resourceType: "user", resourceId: userId }]))
        .rejects.toBe(reason);
    } finally { timeout.mockRestore(); }
  });

  it.each(["search", "resolve"] as const)("checks the current-request guard before %s dispatch", async operation => {
    const fetcher = vi.fn<FetchLike>();
    const reason = AppError.unauthorized("Session replaced.");
    const assertCurrent = () => { throw reason; };
    const client = new DirectoryPrincipalsClient(fetcher);
    await expect(operation === "search"
      ? client.search("token", "person", 25, undefined, assertCurrent)
      : client.resolve("token", [{ resourceType: "user", resourceId: userId }], undefined, assertCurrent))
      .rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a cancelled empty batch without returning a successful result", async () => {
    const reason = new DOMException("Directory lookup cancelled", "AbortError");
    const fetcher = vi.fn<FetchLike>();
    await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", [], AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsupported principal types before resolving the batch", async () => {
    const fetcher = vi.fn<FetchLike>();
    await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", [
      { resourceType: "user", resourceId: userId },
      { resourceType: "device", resourceId: securityGroupId },
    ])).rejects.toMatchObject({ status: 400, code: "invalid_principal" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops queued lookups and aborts peers after a batch failure", async () => {
    let releasePeers!: () => void;
    const peers = new Promise<void>(resolve => { releasePeers = resolve; });
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected a directory request signal");
      signals.push(signal);
      const id = new URL(input).pathname.split("/").at(-1)!;
      if (id === userId) {
        return Response.json({ error: { code: "Authorization_RequestDenied" } }, { status: 403 });
      }
      await peers;
      signal.throwIfAborted();
      return Response.json({ id, displayName: id });
    });
    const principals = [userId, ...Array.from({ length: 23 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`)]
      .map(resourceId => ({ resourceType: "user", resourceId }));

    try {
      await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", principals))
        .rejects.toMatchObject({ status: 403, code: "Authorization_RequestDenied" });
    } finally {
      releasePeers();
    }
    await setImmediate();
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it("bounds concurrent requests while resolving principals", async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    const fetcher = vi.fn<FetchLike>(async (input) => {
      activeRequests += 1;
      peakRequests = Math.max(peakRequests, activeRequests);
      await Promise.resolve();
      activeRequests -= 1;
      const id = input.toString().split("/users/")[1].split("?")[0];
      return Response.json({ id, displayName: id });
    });
    const principals = Array.from({ length: 24 }, (_, index) => ({
      resourceType: "user",
      resourceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));

    const result = await new DirectoryPrincipalsClient(fetcher).resolve(
      "token",
      principals,
    );

    expect(result).toHaveLength(24);
    expect(peakRequests).toBeLessThanOrEqual(8);
  });

  it.each(["user", "group"])("rejects case-insensitive duplicate %s requests and exact identity redirection", async (resourceType) => {
    const redirected = vi.fn<FetchLike>(async () => Response.json({
      id: "99999999-9999-4999-8999-999999999999",
      displayName: "Different user",
    }));
    const client = new DirectoryPrincipalsClient(redirected);

    await expect(client.resolve("token", [
      { resourceType, resourceId: userId },
      { resourceType, resourceId: userId.toUpperCase() },
    ])).rejects.toMatchObject({ code: "duplicate_principal" });
    expect(redirected).not.toHaveBeenCalled();

    await expect(client.resolve("token", [{ resourceType, resourceId: userId }]))
      .rejects.toMatchObject({ code: "principal_identity_mismatch" });
  });

  it.each(["user", "group"])("accepts case-only differences in the resolved %s identity", async (resourceType) => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({
      id: userId.toUpperCase(),
      displayName: "Same principal",
      securityEnabled: true,
    }));

    await expect(new DirectoryPrincipalsClient(fetcher).resolve("token", [
      { resourceType, resourceId: userId },
    ])).resolves.toEqual([expect.objectContaining({
      resourceType, resourceId: userId.toUpperCase(), displayName: "Same principal",
    })]);
  });
});
