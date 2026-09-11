import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import {
  buildCopilotStudioQuarantineUrl,
  CopilotStudioQuarantineClient,
  type CopilotStudioQuarantineTarget,
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
  ])("rejects an invalid provider status schema", async (body) => {
    const client = new CopilotStudioQuarantineClient(async () => Response.json(body));
    await expect(client.getStatus("token", target)).rejects.toMatchObject({ code: "provider_schema" });
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