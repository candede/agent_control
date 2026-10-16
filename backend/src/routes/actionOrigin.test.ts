import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { activateAccountSession, clearAccountSessionMutationsForTest } from "../db/sessions.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { createBearerCredentials } from "../auth/delegatedCredentials.js";
import { account, browserSession, epochAuthority, oboFetcher, tenant, verifiedBearer } from "../auth/authFoundationTestSupport.js";
import { deriveActionOrigin, parseStoredOrigin, unknownOrigin, withActionOrigin, currentActionOrigin, parseOriginFilters } from "../services/actionOrigin.js";

const originalTenants = config.tenants;
let web: Awaited<ReturnType<typeof browserRequestPrincipal>>, bearer: Awaited<ReturnType<typeof createBearerCredentials>>;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
beforeEach(async () => {
  clearAccountSessionMutationsForTest(); config.tenants = [tenant];
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => undefined);
  web = await browserRequestPrincipal(browserSession(account()), null, epochAuthority());
  bearer = await createBearerCredentials(await verifiedBearer(), epochAuthority(), { fetcher: oboFetcher() });
});
afterEach(() => { config.tenants = originalTenants; vi.restoreAllMocks(); });
describe("frozen origin v1", () => {
  it("derives channel and app only from verified principal, never authenticates reported labels", () => {
    const origin = deriveActionOrigin(bearer.principal, randomUUID(), encode({ version: 1, client: { id: "downstream", name: "=Reported", version: "1.0" },
      callingAgent: { id: "caller", name: "<script>alert(1)</script>" }, mcpCallId: 123 }));
    expect(origin).toMatchObject({ channel: "mcp", integrationClientId: tenant.integration!.clientId, mcpCallId: "123",
      client: { id: { value: "downstream", evidence: "reported" }, name: { evidence: "reported" }, version: { evidence: "reported" } },
      callingAgent: { id: { evidence: "reported" }, name: { evidence: "reported" } } });
    expect(Object.isFrozen(origin.client.name)).toBe(true);
    expect(deriveActionOrigin(web, randomUUID())).toMatchObject({ channel: "webapp", integrationClientId: tenant.clientId, client: unknownOrigin.client });
    expect(deriveActionOrigin(bearer.principal, randomUUID()).callingAgent).toEqual(unknownOrigin.callingAgent);
    expect(() => deriveActionOrigin({ ...web }, randomUUID())).toThrow();
  });
  it.each([
    { version: 2 }, { version: 1, channel: "webapp" }, { version: 1, actor: "other" },
    { version: 1, integrationClientId: tenant.clientId }, { version: 1, evidence: "authenticated" },
    { version: 1, requestId: "override" }, { version: 1, client: { name: { value: "verified", evidence: "authenticated" } } },
    { version: 1, callingAgent: { name: "bad\n" } }, { version: 1, client: { id: "\u202e" } },
    { version: 1, client: { name: "\ud800" } }, { version: 1, client: { version: "x".repeat(65) } },
    { version: 1, callingAgent: { name: "x".repeat(257) } }, { version: 1, mcpCallId: "session secret/" },
    { version: 1, mcpCallId: 1.5 }, { version: 1, _meta: { confidential: "discard" } },
  ])("rejects reserved/spoofed/malformed metadata %j", descriptor => {
    expect(() => deriveActionOrigin(bearer.principal, randomUUID(), encode(descriptor))).toThrow(expect.objectContaining({ code: "invalid_action_origin" }));
  });
  it("rejects browser context, noncanonical encoding, invalid UTF8 and descriptor overflow; accepts scalar boundary", () => {
    for (const header of [encode({ version: 1 }), "e30=", "!!!!", Buffer.from([0xff]).toString("base64url"), encode({ version: 1, client: { name: "x".repeat(4097) } })]) {
      expect(() => deriveActionOrigin(web, randomUUID(), header)).toThrow();
    }
    for (const header of ["e30=", "!!!!", Buffer.from([0xff]).toString("base64url")]) {
      expect(() => deriveActionOrigin(bearer.principal, randomUUID(), header)).toThrow();
    }
    const text = "😀".repeat(256), origin = deriveActionOrigin(bearer.principal, randomUUID(), encode({ version: 1, client: { name: text } }));
    expect(origin.client.name.value).toBe(text);
    expect(parseStoredOrigin(origin)).toEqual(origin);
    expect(parseStoredOrigin(undefined)).toEqual(unknownOrigin);
    expect(() => parseStoredOrigin({ ...origin, client: { ...origin.client, name: { value: text, evidence: "unknown" } } })).toThrow();
  });
  it("isolates concurrent asynchronous request provenance and restores unknown outside a request", async () => {
    const origins = [deriveActionOrigin(web, randomUUID()), deriveActionOrigin(bearer.principal, randomUUID())];
    const found = await Promise.all(origins.map(origin => withActionOrigin(origin, async () => {
      await new Promise(resolve => setTimeout(resolve, 1)); return currentActionOrigin();
    })));
    expect(found).toEqual(origins); expect(currentActionOrigin()).toEqual(unknownOrigin);
    expect(parseOriginFilters({ originChannel: "unknown", originClientId: "literal_%", originCallingAgentId: "agent" }))
      .toEqual({ originChannel: "unknown", originClientId: "literal_%", originCallingAgentId: "agent" });
    expect(() => parseOriginFilters({ originChannel: ["mcp"] })).toThrow();
  });
});
