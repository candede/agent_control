import { generateKeyPairSync, sign } from "node:crypto";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { errorTelemetry } from "../errors.js";
import { authExchangeTimeoutMs } from "./boundedAuth.js";
import { McpBearerVerifier, authorizationFreshnessMs, bearerAssertion, jwksCacheLifetimeMs, jwksRefreshCooldownMs } from "./mcpBearer.js";
import { apiClaims, apiToken, jwk, keys, signingFetcher, tenant } from "./authFoundationTestSupport.js";

const originalTenants = config.tenants;
beforeEach(() => { config.tenants = [tenant]; });
afterEach(() => { config.tenants = originalTenants; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Entra delegated API verification", () => {
  it("recognizes a single Usage Report Uploader API role without manufacturing additional assignments", async () => {
    const verified = await new McpBearerVerifier(signingFetcher()).verify(apiToken({ roles: ["AgentControl.UsageReportUploader"] }));
    expect(verified.roles).toEqual(["AgentControl.UsageReportUploader"]);
  });

  it("verifies real RSA signatures and exact issuer, tenant, API audience and calling application", async () => {
    const fetcher = signingFetcher();
    const verifier = new McpBearerVerifier(fetcher);
    const token = apiToken();
    const verified = await verifier.verify(token);
    expect(verified).toMatchObject({ tenantId: tenant.tenantId, apiClientId: tenant.clientId,
      integrationClientId: tenant.integration!.clientId, roles: ["AgentControl.Viewer"] });
    expect(bearerAssertion(verified)).toBe(token);
    expect(JSON.stringify(verified)).not.toContain(token);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`https://login.microsoftonline.com/${tenant.tenantId}/discovery/v2.0/keys`);
    await verifier.verify(token);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { tid: "99999999-9999-9999-9999-999999999999" }, { tid: "common" }, { tid: undefined },
    { iss: "https://login.microsoftonline.com/common/v2.0" }, { iss: "https://attacker.invalid" },
    { aud: tenant.integration!.clientId }, { aud: [tenant.clientId, "other"] }, { aud: undefined },
    { azp: tenant.clientId }, { azp: undefined }, { appid: tenant.integration!.clientId },
    { ver: "1.0" }, { idtyp: "app" }, { scp: undefined }, { scp: "User.Read" }, { scp: ["AgentControl.Access"] },
    { roles: null }, { roles: "AgentControl.Viewer" }, { roles: ["Graph.Admin"] }, { roles: ["AgentControl.Viewer", 1] },
    { oid: undefined }, { oid: "not-an-object-guid" }, { sub: undefined }, { sub: ["subject"] },
    { wids: "global-admin" }, { wids: ["not-a-guid"] }, { nonce: "id-token-nonce" },
    { exp: 1 }, { iat: undefined }, { nbf: undefined }, { exp: undefined },
    { iat: Math.floor(Date.now() / 1000) + 60 }, { nbf: Math.floor(Date.now() / 1000) + 60 },
    { exp: Math.floor(Date.now() / 1000) + 25 * 3600 },
  ])("fails closed on invalid required claims %j", async changes => {
    await expect(new McpBearerVerifier(signingFetcher()).verify(apiToken(changes))).rejects.toMatchObject({ status: 401, code: "invalid_bearer" });
  });

  it.each([{ roles: undefined }, { roles: [] }])("admits signed delegated roleless identity without inventing roles %j", async changes => {
    const verified = await new McpBearerVerifier(signingFetcher()).verify(apiToken(changes));
    expect(verified.roles).toEqual([]);
    expect(verified.localAccountId).toBe(apiClaims().oid);
  });

  it("rejects malformed numeric claims even if they bypass the signing library's checks", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const change of [{ iat: "123" }, { nbf: 0.1 }, { exp: null }]) {
      const content = `${encode({ alg: "RS256", kid: "fixture-key" })}.${encode(apiClaims(change))}`;
      const token = `${content}.${sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64url")}`;
      await expect(new McpBearerVerifier(signingFetcher()).verify(token)).rejects.toMatchObject({ code: "invalid_bearer" });
    }
  });

  it.each(["{", "null", "true", "42", "[]", '"scalar"'])(
    "rejects malformed or non-object JWT payloads %j before fetching signing keys",
    async payload => {
      const encode = (value: string) => Buffer.from(value).toString("base64url");
      const content = `${encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fixture-key" }))}.${encode(payload)}`;
      const token = `${content}.${sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64url")}`;
      const fetcher = signingFetcher();
      await expect(new McpBearerVerifier(fetcher).verify(token)).rejects.toMatchObject({ status: 401, code: "invalid_bearer" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([299, 300, 301, 900, 3600])("accepts valid tokens issued %i seconds ago without changing their signed timestamps", async age => {
    const now = Date.now(), iat = Math.floor(now / 1000) - age;
    const token = apiToken({ iat, nbf: iat });
    const verified = await new McpBearerVerifier(signingFetcher()).verify(token);
    expect(verified.issuedAt).toBe(iat * 1000);
    expect(verified.verifiedAt).toBeGreaterThanOrEqual(now);
    expect(bearerAssertion(verified)).toBe(token);
  });

  it("bounds each verified authority by verification time and expiry without extending it during reuse", async () => {
    vi.useFakeTimers();
    const verifier = new McpBearerVerifier(signingFetcher());
    const iat = Math.floor(Date.now() / 1000) - 300;
    const exp = Math.floor(Date.now() / 1000) + 360;
    const token = apiToken({ iat, nbf: iat, exp });
    const verified = await verifier.verify(token);
    await vi.advanceTimersByTimeAsync(authorizationFreshnessMs - 1);
    expect(bearerAssertion(verified)).toBe(token);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => bearerAssertion(verified)).toThrow(expect.objectContaining({ code: "authorization_stale" }));
    const reverified = await verifier.verify(token);
    expect(reverified.verifiedAt).toBe(Date.now());
    expect(bearerAssertion(reverified)).toBe(token);
    vi.setSystemTime(exp * 1000);
    expect(() => bearerAssertion(reverified)).toThrow(expect.objectContaining({ code: "authorization_expired" }));
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "invalid_bearer" });
  });

  it("requires configured admission, while absent integration leaves browser tenant configuration intact", async () => {
    config.tenants = [{ ...tenant, integration: undefined }];
    const fetcher = signingFetcher();
    await expect(new McpBearerVerifier(fetcher).verify(apiToken())).rejects.toMatchObject({ code: "bearer_admission_disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsigned, symmetric-key, forged, header-supplied-key and malformed tokens without disclosing assertions", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const tokens = [
      "", "not.a.jwt", `${apiToken()}.extra`, `${apiToken()}=`, "a".repeat(64_001),
      jwt.sign(apiClaims(), "", { algorithm: "none" }),
      jwt.sign(apiClaims(), keys.publicKey.export({ type: "spki", format: "pem" }), { algorithm: "HS256", keyid: "fixture-key" }),
      jwt.sign(apiClaims(), other.privateKey, { algorithm: "RS256", keyid: "fixture-key" }),
      jwt.sign(apiClaims(), keys.privateKey, { algorithm: "RS256", header: { alg: "RS256", kid: "fixture-key", jku: "https://attacker.invalid" } }),
    ];
    const verifier = new McpBearerVerifier(signingFetcher());
    for (const token of tokens) {
      const error = await verifier.verify(token).catch(error => error);
      expect(error).toMatchObject({ code: "invalid_bearer" });
      if (token.length > 20) expect(JSON.stringify(error)).not.toContain(token);
      expect(errorTelemetry(error)).toMatchObject({ errorCode: "invalid_bearer" });
    }
  });

  it.each([
    { keys: [] }, { keys: [jwk, jwk] }, { keys: [{ ...jwk, use: "enc" }] },
    { keys: [{ ...jwk, kty: "oct" }] }, { keys: [{ ...jwk, alg: "HS256" }] },
    { keys: [{ ...jwk, issuer: "https://attacker.invalid" }] }, { keys: [{ ...jwk, d: "private" }] },
  ])("rejects invalid or ambiguous key sets %j", async body => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)));
    await expect(new McpBearerVerifier(fetcher).verify(apiToken())).rejects.toMatchObject({ status: 401 });
  });

  it("bounds key rotation, refresh flooding and stale-key availability without infinite stale fallback", async () => {
    vi.useFakeTimers();
    const fetcher = signingFetcher();
    const verifier = new McpBearerVerifier(fetcher);
    await verifier.verify(apiToken());
    await expect(verifier.verify(apiToken({}, "rotated"))).rejects.toMatchObject({ code: "signing_keys_unavailable" });
    await vi.advanceTimersByTimeAsync(jwksRefreshCooldownMs);
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "rotated" }] })));
    await verifier.verify(apiToken({}, "rotated"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(jwksCacheLifetimeMs);
    fetcher.mockImplementationOnce(async () => new Response("unavailable", { status: 503 }));
    await expect(verifier.verify(apiToken({}, "rotated"))).rejects.toMatchObject({ code: "signing_keys_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("coalesces refresh while one cancelled caller cannot cancel another's verification", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn<typeof fetch>(async () => { await gate; return new Response(JSON.stringify({ keys: [jwk] })); });
    const verifier = new McpBearerVerifier(fetcher);
    const controller = new AbortController();
    const first = verifier.verify(apiToken(), controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: "authentication_cancelled" });
    const second = verifier.verify(apiToken());
    controller.abort();
    release();
    await rejected;
    await expect(second).resolves.toMatchObject({ tenantId: tenant.tenantId });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("has a total refresh deadline even when an injected network ignores abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = new McpBearerVerifier(fetcher).verify(apiToken());
    const rejection = expect(pending).rejects.toMatchObject({ code: "authentication_timeout" });
    await vi.advanceTimersByTimeAsync(authExchangeTimeoutMs);
    await rejection;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("bounds stalled key body consumption and honors HTTP-date Retry-After metadata", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(stream));
    const pending = new McpBearerVerifier(fetcher).verify(apiToken());
    const rejection = expect(pending).rejects.toMatchObject({ code: "authentication_timeout" });
    await vi.advanceTimersByTimeAsync(authExchangeTimeoutMs);
    await rejection;
    const retry = new Date(Date.now() + 60_000).toUTCString();
    const throttled = vi.fn<typeof fetch>(async () => new Response(null, { status: 429, headers: { "retry-after": retry } }));
    await expect(new McpBearerVerifier(throttled).verify(apiToken())).rejects.toMatchObject({ code: "provider_throttled" });
    expect(throttled).toHaveBeenCalledOnce();
  });

  it("bounds streamed key bodies and honors throttling without retries or token logging", async () => {
    const oversized = vi.fn<typeof fetch>(async () => new Response("x".repeat(256 * 1024 + 1)));
    await expect(new McpBearerVerifier(oversized).verify(apiToken())).rejects.toMatchObject({ code: "invalid_identity_response" });
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private provider body", { status: 429, headers: { "retry-after": "120" } }));
    const verifier = new McpBearerVerifier(fetcher);
    const error = await verifier.verify(apiToken()).catch(error => error);
    expect(error).toMatchObject({ code: "provider_throttled", retryAfterSeconds: 120 });
    expect(JSON.stringify(error)).not.toContain("private provider body");
    await expect(verifier.verify(apiToken())).rejects.toMatchObject({ code: "signing_keys_unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("invalidates previously verified secret contexts after integration configuration changes", async () => {
    const verified = await new McpBearerVerifier(signingFetcher()).verify(apiToken());
    config.tenants = [{ ...tenant, integration: undefined }];
    expect(() => bearerAssertion(verified)).toThrow(expect.objectContaining({ code: "invalid_auth_state" }));
    expect(() => bearerAssertion({ ...verified })).toThrow(expect.objectContaining({ code: "invalid_bearer" }));
  });
});
