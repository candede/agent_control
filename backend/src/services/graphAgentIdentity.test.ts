import { describe, expect, it, vi } from "vitest";
import { GraphAgentIdentityClient } from "./graphAgentIdentity.js";
import type { FetchLike } from "./graphPackages.js";
import { verifiedAgentIdentityClientIdProvenance, type VerifiedAgentIdentityIds } from "../types/agentInvestigations.js";

const id = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const valid = { "@odata.type": "#microsoft.graph.agentIdentity", servicePrincipalType: "ServiceIdentity", id, appId };
const signal = () => AbortSignal.timeout(5_000);
const resolved: VerifiedAgentIdentityIds = { objectId: id, applicationId: id, runtimeStatus: "available",
  runtimeProvenance: verifiedAgentIdentityClientIdProvenance };

describe("typed Graph agent identity", () => {
  it("selects only documented typed fields and records the verified child client-ID provenance", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...valid,
      agentIdentityBlueprintId: "33333333-3333-4333-8333-333333333333", createdByAppId: "44444444-4444-4444-8444-444444444444" }));
    const before = vi.fn(async () => undefined);
    expect(await new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), before)).toEqual(resolved);
    expect(before).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `https://graph.microsoft.com/v1.0/servicePrincipals/${id}/microsoft.graph.agentIdentity?$select=id,servicePrincipalType`,
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal), headers: {
        Authorization: "Bearer fixture", Accept: "application/json;odata.metadata=full",
      } }));
  });

  it("unlocks both identity namespaces without an appId property and never uses blueprint or creator IDs", async () => {
    for (const own of [{}, { appId: null }]) {
      const { appId: _app, ...inventory } = valid;
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...inventory, ...own, createdByAppId: appId, agentIdentityBlueprintId: appId }));
      await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {}))
        .resolves.toEqual(resolved);
    }
  });

  it.each([undefined, null, appId])("uses the typed identity ID without @odata.type, ignoring unselected appId %s", async ownAppId => {
    const body = { id, servicePrincipalType: "ServiceIdentity", agentIdentityBlueprintId: "33333333-3333-4333-8333-333333333333",
      createdByAppId: "44444444-4444-4444-8444-444444444444", ...(ownAppId === undefined ? {} : { appId: ownAppId }) };
    const fetcher = vi.fn<FetchLike>(async () => Response.json(body));
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {}))
      .resolves.toEqual(resolved);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://graph.microsoft.com/v1.0/servicePrincipals/${id}/microsoft.graph.agentIdentity?$select=id,servicePrincipalType`);
  });

  it.each([
    { id: appId }, { id: "00000000-0000-0000-0000-000000000000" },
    { "@odata.type": "#microsoft.graph.servicePrincipal" }, { "@odata.type": null },
    { "@odata.type": "#microsoft.graph.agentIdentityBlueprintPrincipal" },
    { servicePrincipalType: "Application" }, { servicePrincipalType: undefined },
  ])("rejects incorrect identity shape %j", async change => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...valid, ...change }));
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {}))
      .rejects.toMatchObject({ code: "agent_identity_mismatch" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["agentIdentityBlueprintId", "createdByAppId"])("never replaces the verified child client ID with the %s or an unselected appId", async property => {
    const own = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ ...valid, appId: own, [property]: own.toUpperCase() }));
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {}))
      .resolves.toEqual(resolved);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed candidates before any request and bounds response bytes and JSON", async () => {
    const fetcher = vi.fn<FetchLike>();
    for (const candidate of ["", "../applications/other", "00000000-0000-0000-0000-000000000000"]) {
      await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", candidate, signal(), async () => {})).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response("x".repeat(32_769))).mockResolvedValueOnce(new Response("{"));
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {})).rejects.toMatchObject({ code: "provider_result_limit" });
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {})).rejects.toMatchObject({ code: "provider_schema" });
  });

  it.each([401, 403, 404])("surfaces %s setup/not-found errors without alternate permissions, namespaces or retry", async status => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ error: { code: "Denied", message: "must not leak" } }, { status }));
    const result = new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {});
    await expect(result).rejects.toMatchObject({ status,
      code: status === 404 ? "agent_identity_not_found" : "agent_identity_permission_required" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rechecks admission on the single bounded retry and respects long Retry-After without retrying early", async () => {
    const wait = vi.fn(async () => undefined);
    const before = vi.fn(async () => undefined);
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json(valid));
    await expect(new GraphAgentIdentityClient(fetcher, wait).resolve("fixture", id, signal(), before)).resolves.toMatchObject({ objectId: id });
    expect(wait).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    expect(before).toHaveBeenCalledTimes(2);
    fetcher.mockClear().mockResolvedValue(Response.json({}, { status: 429, headers: { "Retry-After": "30" } }));
    await expect(new GraphAgentIdentityClient(fetcher, wait).resolve("fixture", id, signal(), before)).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never retries more than once, aborts before dispatch and rejects interrupted bodies", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({}, { status: 503 }));
    await expect(new GraphAgentIdentityClient(fetcher, async () => {}).resolve("fixture", id, signal(), async () => {})).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const abort = new AbortController();
    abort.abort();
    fetcher.mockClear();
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, abort.signal, async () => {})).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
    const pending = new AbortController();
    fetcher.mockImplementation(async () => {
      const response = new Response(new ReadableStream({ start() {} }));
      setTimeout(() => pending.abort(), 10);
      return response;
    });
    await expect(new GraphAgentIdentityClient(fetcher).resolve("fixture", id, pending.signal, async () => {})).rejects.toBeDefined();
  });

  it.each(["headers", "body"] as const)("reports a local %s timeout as a provider timeout, not a resolution deadline", async stage => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn();
    const fetcher = vi.fn<FetchLike>(async (_url, init) => stage === "body"
      ? new Response(new ReadableStream({ cancel }))
      : new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    try {
      const result = new GraphAgentIdentityClient(fetcher).resolve("fixture", id, new AbortController().signal, async () => {});
      const assertion = expect(result).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      await assertion;
      expect(timeout).toHaveBeenCalledWith(8_000);
      expect(fetcher).toHaveBeenCalledOnce();
      if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
    } finally { timeout.mockRestore(); }
  });

  it.each([401, 403, 404, 429])("retains HTTP %s evidence when the error body times out", async status => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const cancel = vi.fn();
    const wait = vi.fn(async () => {});
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({ cancel }), {
      status, headers: { "Retry-After": "30", "request-id": "fixture-request" },
    }));
    try {
      const result = new GraphAgentIdentityClient(fetcher, wait).resolve("fixture", id, new AbortController().signal, async () => {});
      const assertion = expect(result).rejects.toMatchObject({ status,
        code: status === 404 ? "agent_identity_not_found" : status === 429 ? "graph_error" : "agent_identity_permission_required",
        ...(status === 429 ? { details: { httpStatus: status, retryAfterMs: 30_000, correlationId: "fixture-request" } }
          : status !== 404 ? { details: { capabilityId: "graph.agentIdentity.read",
            provider: { httpStatus: status, correlationId: "fixture-request" } } } : {}),
      });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      await assertion;
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });

  it("still performs one admitted retry after a transient error-body timeout", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(deadline.signal).mockReturnValue(new AbortController().signal);
    const cancel = vi.fn();
    const wait = vi.fn(async () => {});
    const before = vi.fn(async () => {});
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json(valid));
    try {
      const result = new GraphAgentIdentityClient(fetcher, wait).resolve("fixture", id, new AbortController().signal, before);
      const assertion = expect(result).resolves.toEqual(resolved);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      await assertion;
      expect(cancel).toHaveBeenCalledOnce();
      expect(wait).toHaveBeenCalledExactlyOnceWith(1_000, expect.any(AbortSignal));
      expect(before).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { timeout.mockRestore(); }
  });

  it.each(["headers", "body"] as const)("sanitizes transport failures at %s without leaking internal messages", async stage => {
    const fetcher = vi.fn<FetchLike>(async () => {
      if (stage === "headers") throw new TypeError("private transport details");
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("private transport details")); } }));
    });
    const result = new GraphAgentIdentityClient(fetcher).resolve("fixture", id, signal(), async () => {}).catch(error => error);
    expect(await result).toMatchObject({ status: 502, code: "provider_network_error" });
    expect(String(await result)).not.toContain("private transport details");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([200, 401, 403, 404, 429, 503])("keeps caller cancellation authoritative during an HTTP %s body read", async status => {
    const caller = new AbortController();
    const reason = new Error("caller cancelled");
    const cancel = vi.fn();
    const wait = vi.fn(async () => {});
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({ cancel }), { status }));
    const result = new GraphAgentIdentityClient(fetcher, wait).resolve("fixture", id, caller.signal, async () => {});
    const assertion = expect(result).rejects.toBe(reason);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    caller.abort(reason);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it.each(["cancellation", "deadline"])("rejects %s between final body consumption and identity return", async mode => {
    const caller = new AbortController();
    const reason = new DOMException(mode, mode === "cancellation" ? "AbortError" : "TimeoutError");
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(valid))); },
      pull(controller) {
        controller.close();
        const abortAfterMicrotasks = (remaining: number) => {
          if (remaining === 0) caller.abort(reason);
          else queueMicrotask(() => abortAfterMicrotasks(remaining - 1));
        };
        // Four microtasks reaches the client continuation; a fifth is after it returns.
        abortAfterMicrotasks(4);
      },
    }, { highWaterMark: 0 });
    const fetcher = vi.fn<FetchLike>(async () => new Response(body));
    const timeout = mode === "deadline" ? vi.spyOn(AbortSignal, "timeout").mockReturnValue(caller.signal) : undefined;
    try {
      const result = new GraphAgentIdentityClient(fetcher).resolve("fixture", id,
        mode === "cancellation" ? caller.signal : new AbortController().signal, async () => {});
      if (mode === "cancellation") await expect(result).rejects.toBe(reason);
      else await expect(result).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
      expect(body.locked).toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { timeout?.mockRestore(); }
  });
});
