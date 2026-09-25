import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import {
  buildCopilotStudioQuarantineUrl,
  CopilotStudioQuarantineClient,
  type CopilotStudioQuarantineTarget,
  verifyCopilotStudioQuarantineConverged,
} from "./copilotStudioQuarantine.js";

const target: CopilotStudioQuarantineTarget = {
  environmentId: "Default-11111111-1111-4111-8111-111111111111",
  botId: "22222222-2222-4222-8222-222222222222",
};

const providerStatus = {
  isBotQuarantined: false,
  lastUpdateTimeUtc: "2026-09-09T19:00:00.1234567Z",
};

describe("CopilotStudioQuarantineClient", () => {
  it("builds only the documented api-version=1 native-ID endpoints", () => {
    expect(buildCopilotStudioQuarantineUrl(target)).toBe(
      "https://api.powerplatform.com/copilotstudio/environments/Default-11111111-1111-4111-8111-111111111111/bots/22222222-2222-4222-8222-222222222222/api/botQuarantine?api-version=1",
    );
    expect(buildCopilotStudioQuarantineUrl(target, "SetAsQuarantined")).toContain(
      "/api/botQuarantine/SetAsQuarantined?api-version=1",
    );
    expect(buildCopilotStudioQuarantineUrl(target, "SetAsUnquarantined")).toContain(
      "/api/botQuarantine/SetAsUnquarantined?api-version=1",
    );
  });

  it.each([
    [{ ...target, environmentId: "Sales environment" }],
    [{ ...target, environmentId: "P_11111111-1111-4111-8111-111111111111" }],
    [{ ...target, botId: "Package_Agent" }],
    [{ ...target, botId: "22222222-2222-4222-8222-222222222222 " }],
  ])("rejects names, package IDs, and non-native target strings before egress", async (invalidTarget) => {
    const fetcher = vi.fn();
    await expect(new CopilotStudioQuarantineClient(fetcher).getStatus("token", invalidTarget)).rejects.toMatchObject({
      status: 400,
      code: "invalid_quarantine_target",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts opaque native GUIDs without UUID version or variant restrictions", async () => {
    const opaqueTarget = { environmentId: "00000000-0000-0000-0000-000000000000", botId: "ffffffff-ffff-ffff-ffff-ffffffffffff" };
    const fetcher = vi.fn(async () => Response.json(providerStatus));
    await expect(new CopilotStudioQuarantineClient(fetcher).getStatus("token", opaqueTarget)).resolves.toMatchObject(opaqueTarget);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads and source-stamps the exact documented status shape", async () => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(buildCopilotStudioQuarantineUrl(target));
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer opaque-token");
      expect(new Headers(init?.headers).get("x-ms-client-request-id")).toBe("correlation-read");
      return Response.json(providerStatus);
    });
    const result = await new CopilotStudioQuarantineClient(fetcher, {}, 10_000, () => new Date("2026-09-09T19:01:00Z"))
      .getStatus("opaque-token", target, { correlationId: "correlation-read" });

    expect(result).toEqual({
      ...target,
      ...providerStatus,
      observedAt: "2026-09-09T19:01:00.000Z",
      correlationId: "correlation-read",
    });
  });

  it.each([
    [{}],
    [{ isBotQuarantined: 0, lastUpdateTimeUtc: providerStatus.lastUpdateTimeUtc }],
    [{ isBotQuarantined: false, lastUpdateTimeUtc: "yesterday" }],
    [{ isBotQuarantined: false, lastUpdateTimeUtc: "2026-02-29T19:00:00Z" }],
    [{ isBotQuarantined: false, lastUpdateTimeUtc: "2026-02-30T19:00:00.1234567Z" }],
    [{ isBotQuarantined: false, lastUpdateTimeUtc: "2026-04-31T19:00:00Z" }],
    [{ isBotQuarantined: false, lastUpdateTimeUtc: "1900-02-29T19:00:00Z" }],
    [{ isBotQuarantined: false, lastUpdateTimeUtc: "2026-09-09T24:00:00Z" }],
  ])("rejects an invalid provider status schema", async (body) => {
    const fetcher = vi.fn(async () => Response.json(body));
    const client = new CopilotStudioQuarantineClient(fetcher);
    await expect(client.getStatus("token", target)).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    "2024-02-29T19:00:00Z",
    "2000-02-29T19:00:00.1Z",
    "2400-02-29T19:00:00.1234567Z",
    "2026-09-09T19:00:00.123Z",
    "0001-01-01T00:00:00Z",
  ])("preserves the exact valid provider timestamp %s", async lastUpdateTimeUtc => {
    const client = new CopilotStudioQuarantineClient(async () => Response.json({ ...providerStatus, lastUpdateTimeUtc }));
    await expect(client.getStatus("token", target)).resolves.toMatchObject({ lastUpdateTimeUtc });
  });

  it("rejects impossible mutation timestamps without retrying the write", async () => {
    const fetcher = vi.fn(async () => Response.json({ isBotQuarantined: true, lastUpdateTimeUtc: "2026-02-30T19:00:00Z" }));
    await expect(new CopilotStudioQuarantineClient(fetcher).setQuarantine("token", target, true, { correlationId: "correlation-write" }))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retries throttled GET reads using the bounded Retry-After delay", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: "TooManyRequests" } }, { status: 429, headers: { "Retry-After": "4" } }))
      .mockResolvedValueOnce(Response.json(providerStatus));
    const retryDelay = vi.fn(async () => undefined);
    const result = await new CopilotStudioQuarantineClient(fetcher, { maxAttempts: 2, maximumDelayMs: 2_000, delay: retryDelay })
      .getStatus("token", target);

    expect(result.isBotQuarantined).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledWith(2_000);
  });

  it.each([
    [true, "SetAsQuarantined"],
    [false, "SetAsUnquarantined"],
  ] as const)("dispatches the %s mutation once and parses its response", async (requestedState, action) => {
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(buildCopilotStudioQuarantineUrl(target, action));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return Response.json({ ...providerStatus, isBotQuarantined: requestedState });
    });
    const result = await new CopilotStudioQuarantineClient(fetcher).setQuarantine("token", target, requestedState, { correlationId: "correlation-write" });

    expect(result.isBotQuarantined).toBe(requestedState);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never retries a write whose provider outcome is uncertain", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 }));
    await expect(new CopilotStudioQuarantineClient(fetcher, { maxAttempts: 3, delay: async () => undefined })
      .setQuarantine("token", target, true, { correlationId: "correlation-write" }))
      .rejects.toMatchObject({ status: 503, code: "provider_error" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requires the documented exact 200 response contract", async () => {
    const fetcher = vi.fn(async () => Response.json(providerStatus, { status: 201 }));
    await expect(new CopilotStudioQuarantineClient(fetcher).setQuarantine("token", target, true, { correlationId: "correlation-write" }))
      .rejects.toMatchObject({ status: 502, code: "provider_unexpected_status" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["unexpected-status", "redirected", "foreign"].flatMap(kind =>
    ["stalled", "rejected"].map(cleanup => ({ kind, cleanup })),
  ))("rejects $kind responses without waiting for $cleanup cleanup", async ({ kind, cleanup }) => {
    const disposal = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup === "stalled" ? disposal.promise : Promise.reject(new Error("private cleanup details")));
    const response = new Response(new ReadableStream({ cancel }), { status: kind === "unexpected-status" ? 201 : 200 });
    if (kind === "redirected") Object.defineProperty(response, "redirected", { value: true });
    if (kind === "foreign") Object.defineProperty(response, "url", { value: "https://other.invalid/status" });
    const fetcher = vi.fn(async () => response);
    const pending = new CopilotStudioQuarantineClient(fetcher).getStatus("token", target).catch(error => error);
    try {
      const result = await Promise.race([pending, setImmediate("still pending")]);
      expect(result).toMatchObject({ status: 502, code: kind === "unexpected-status" ? "provider_unexpected_status" : "invalid_provider_link" });
      expect(String(result)).not.toContain("private cleanup details");
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      disposal.resolve();
      await pending;
    }
  });

  it.each(["read", "write"])("does not publish a %s cancelled after the final body read", async operation => {
    const controller = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify(providerStatus))); },
      pull(stream) {
        stream.close();
        // Cancel after the body helper completes but before the adapter resumes.
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort(reason))));
      },
    }, { highWaterMark: 0 });
    const fetcher = vi.fn(async () => new Response(body));
    const client = new CopilotStudioQuarantineClient(fetcher);
    const options = { signal: controller.signal, correlationId: "cancelled-body" };
    const pending = operation === "read"
      ? client.getStatus("token", target, options)
      : client.setQuarantine("token", target, true, options);
    await expect(pending).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["read", "write"])("normalizes an expired %s deadline before dispatch", async operation => {
    const fetcher = vi.fn();
    const client = new CopilotStudioQuarantineClient(fetcher);
    const options = { signal: AbortSignal.abort(new DOMException("deadline", "TimeoutError")), correlationId: "expired-operation" };
    const pending = operation === "read"
      ? client.getStatus("token", target, options)
      : client.setQuarantine("token", target, true, options);
    await expect(pending).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds the complete GET retry operation including retry waits", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: { code: "ServiceUnavailable" } }, { status: 503 }));
    const never = () => new Promise<never>(() => undefined);
    await expect(new CopilotStudioQuarantineClient(fetcher, { maxAttempts: 3, delay: never }, 10_000, () => new Date(), 10)
      .getStatus("token", target)).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("aborts a stalled provider error body on the request deadline", async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const client = new CopilotStudioQuarantineClient(async () => new Response(body, { status: 403 }), { maxAttempts: 1 }, 10);
    await expect(client.getStatus("token", target)).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
  });

  it.each([
    [405, "classic_bot_unsupported"],
    [404, "quarantine_target_removed"],
    [403, "provider_authorization_error"],
  ])("maps status %s without inventing a provider cause", async (status, code) => {
    const client = new CopilotStudioQuarantineClient(async () => Response.json({ error: { code: "ProviderCode", message: "sensitive detail" } }, { status }), { maxAttempts: 1 });
    const error = await client.getStatus("token", target).catch(value => value);
    expect(error).toMatchObject({ status, code });
    expect((error as AppError).message).not.toContain("sensitive detail");
    expect((error as AppError).details).not.toHaveProperty("providerCode");
    expect((error as AppError).details).not.toHaveProperty("category");
  });

  it.each([
    ["ConditionalAccessBlocked", "conditional_access_required"],
    ["MissingRequiredDelegatedPermission", "missing_provider_scope"],
    ["MissingProviderRole", "missing_provider_role"],
    ["FeatureNotAvailable", "quarantine_rollout_unavailable"],
  ])("maps explicit provider code %s to fixed safe error %s", async (providerCode, expectedCode) => {
    const client = new CopilotStudioQuarantineClient(async () => Response.json({ error: { code: providerCode, message: "not retained" } }, { status: 403 }), { maxAttempts: 1 });
    await expect(client.getStatus("token", target)).rejects.toMatchObject({ code: expectedCode, details: { retryAfterMs: undefined } });
  });
});

describe("Copilot Studio quarantine convergence", () => {
  const status = { ...target, ...providerStatus, observedAt: "2026-09-09T19:01:00.000Z", correlationId: "readback" };

  it("returns only a converged GET and counts bounded readbacks", async () => {
    const converged = { ...status, isBotQuarantined: true };
    const client = { getStatus: vi.fn().mockResolvedValueOnce(status).mockResolvedValueOnce(converged) };
    const wait = vi.fn(async () => undefined);
    await expect(verifyCopilotStudioQuarantineConverged(client, "token", target, true, { delay: wait }))
      .resolves.toEqual({ status: converged, readbackCount: 2 });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(500);
  });

  it("retains the last direct observation without claiming success when the window is exhausted", async () => {
    const client = { getStatus: vi.fn(async () => status) };
    await expect(verifyCopilotStudioQuarantineConverged(client, "token", target, true, { maxAttempts: 2, delayMs: 0 }))
      .rejects.toMatchObject({ status: 409, code: "verification_inconclusive", details: { lastStatus: status, readbackCount: 2 } });
    expect(client.getStatus).toHaveBeenCalledTimes(2);
  });

  it("does not start readback after cancellation", async () => {
    const reason = new AppError(409, "cancelled", "The job was cancelled.");
    const client = { getStatus: vi.fn(async () => status) };
    await expect(verifyCopilotStudioQuarantineConverged(client, "token", target, false, { signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason);
    expect(client.getStatus).not.toHaveBeenCalled();
  });

  it("does not confirm convergence after cancellation at the GET completion boundary", async () => {
    const controller = new AbortController();
    const reason = new AppError(409, "cancelled", "The job was cancelled.");
    const provider = new CopilotStudioQuarantineClient(async () => Response.json(providerStatus));
    const client = { getStatus: vi.fn(async (...args: Parameters<typeof provider.getStatus>) => {
      const observed = await provider.getStatus(...args);
      controller.abort(reason);
      return observed;
    }) };
    await expect(verifyCopilotStudioQuarantineConverged(client, "token", target, false, { signal: controller.signal }))
      .rejects.toBe(reason);
    expect(client.getStatus).toHaveBeenCalledOnce();
  });

  it("normalizes a readback deadline that expires during the retry wait", async () => {
    const controller = new AbortController();
    const client = { getStatus: vi.fn(async () => status) };
    const wait = vi.fn(async () => { controller.abort(new DOMException("deadline", "TimeoutError")); });
    await expect(verifyCopilotStudioQuarantineConverged(client, "token", target, true, { signal: controller.signal, delay: wait }))
      .rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    expect(client.getStatus).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });
});