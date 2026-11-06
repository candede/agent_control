import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { account, browserSession, epochAuthority, native, tenant } from "../auth/authFoundationTestSupport.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { EmployeeProfileService } from "./employeeProfile.js";

const original = config.tenants;
beforeEach(async () => {
  config.tenants = [tenant];
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => {});
});
afterEach(() => { config.tenants = original; vi.useRealTimers(); });
async function employee(oid = native) {
  const session = browserSession(account(oid));
  session.user!.roles = [];
  const epochs = epochAuthority();
  return createBrowserCredentials(await browserRequestPrincipal(session, account(oid), epochs), epochs);
}
const member = (id = native) => Response.json({ id, userType: "Member", accountEnabled: true, companyName: "Live ignored", department: "Live ignored" });

describe("bounded employee eligibility, not workplace publication", () => {
  it("resolves an unlicensed employee by exact local oid without saved-directory reads or workplace writes", async () => {
    const source = await employee();
    const token = vi.fn(async () => "synthetic-application-token");
    const fetcher = vi.fn<typeof fetch>(async () => member());
    await new EmployeeProfileService(fetcher, token).verify(source);
    expect(token).toHaveBeenCalledWith(tenant.tenantId, "graph.users.read");
    expect(fetcher.mock.calls[0][0]).toBe(`https://graph.microsoft.com/v1.0/users/${native}?$select=id,accountEnabled,userType`);
    expect(source.principal).not.toHaveProperty("department");
    expect(source.principal.roles).toEqual([]);
  });
  it.each([
    { oid: native.toUpperCase(), responseId: native },
    { oid: native, responseId: native.toUpperCase() },
  ])("matches the exact account independently of UUID casing %j", async ({ oid, responseId }) => {
    await expect(new EmployeeProfileService(async () => member(responseId), async () => "synthetic").verify(await employee(oid)))
      .resolves.toBeUndefined();
  });
  it.each([
    { id: native, userType: "Guest", accountEnabled: true },
    { id: native, userType: "Member", accountEnabled: false },
  ])("denies guest/disabled membership %j", async value => {
    await expect(new EmployeeProfileService(async () => Response.json(value), async () => "synthetic").verify(await employee()))
      .rejects.toMatchObject({ status: 403, code: "employee_required" });
  });
  it.each([
    { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", userType: "Member", accountEnabled: true },
    { id: native, userType: "Member" }, { id: native, userType: "Guest", accountEnabled: "true" },
    { id: native, userType: "unknown", accountEnabled: true },
    { id: native, userType: ["Member"], accountEnabled: true },
    { id: native, userType: ["Guest"], accountEnabled: true },
  ])("rejects wrong oid and malformed exact evidence %j", async value => {
    await expect(new EmployeeProfileService(async () => Response.json(value), async () => "synthetic").verify(await employee()))
      .rejects.toMatchObject({ status: 502, code: "provider_schema" });
  });
  it("does not retain provider failures as success or prevent a bounded recovery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(member());
    const service = new EmployeeProfileService(fetcher, async () => "synthetic"), source = await employee();
    await expect(service.verify(source)).rejects.toMatchObject({ code: "employee_verification_unavailable" });
    await expect(service.verify(source)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not cache malformed membership as a denial", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: native, userType: ["Member"], accountEnabled: true }))
      .mockResolvedValueOnce(member());
    const service = new EmployeeProfileService(fetcher, async () => "synthetic"), source = await employee();
    await expect(service.verify(source)).rejects.toMatchObject({ status: 502, code: "provider_schema" });
    await expect(service.verify(source)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("shares concurrent same-user evidence while keeping independent cancellation and cache expiry", async () => {
    vi.useFakeTimers();
    const source = await employee(), completed = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => completed.promise).mockResolvedValue(member());
    const service = new EmployeeProfileService(fetcher, async () => "synthetic");
    const controller = new AbortController();
    const cancelled = service.verify(source, controller.signal);
    const remaining = service.verify(source);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "authentication_cancelled" });
    completed.resolve(member());
    await remaining;
    await service.verify(source);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(service.verify(source)).rejects.toMatchObject({ code: "authorization_stale" });
    await service.verify(await employee());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds a provider that ignores cancellation to ten seconds", async () => {
    vi.useFakeTimers();
    const source = await employee();
    const service = new EmployeeProfileService(() => new Promise(() => {}), async () => "synthetic");
    const pending = expect(service.verify(source)).rejects.toMatchObject({ code: "authentication_timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });
  it("isolates concurrent identities and checks revocation even with cached membership", async () => {
    const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await activateAccountSession(tenant.tenantId, account(other).homeAccountId, async () => {});
    const fetcher = vi.fn<typeof fetch>(async url => member(String(url).includes(other) ? other : native));
    const service = new EmployeeProfileService(fetcher, async () => "synthetic"), source = await employee();
    await Promise.all([service.verify(source), service.verify(await employee(other))]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await revokeAccountSessionMutations(tenant.tenantId, source.principal.principalId);
    await expect(service.verify(source)).rejects.toMatchObject({ status: 401 });
  });
  it("fails an in-flight role/account change rather than lending cached authority", async () => {
    const source = await employee(), completed = Promise.withResolvers<Response>();
    const service = new EmployeeProfileService(() => completed.promise, async () => "synthetic");
    const pending = service.verify(source);
    await Promise.resolve();
    source.revoke();
    completed.resolve(member());
    await expect(pending).rejects.toBeInstanceOf(AppError);
  });
});
