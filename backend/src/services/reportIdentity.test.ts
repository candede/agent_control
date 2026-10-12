import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { AuthenticatedUser } from "../types/session.js";
import { inventoryProviderRoleIds } from "./inventoryRoleScope.js";
import { reportIdentity } from "./reportIdentity.js";

const { epoch } = vi.hoisted(() => ({ epoch: vi.fn(async () => "7") }));
vi.mock("../db/dataGenerations.js", () => ({
  DataGenerations: class { sessionEpoch = epoch; },
}));
afterEach(() => { epoch.mockReset().mockResolvedValue("7"); });
const database = {} as pg.Pool;
function actor(): AuthenticatedUser {
  return { tenantId: "Tenant/Exact", homeAccountId: "Account/Exact", username: "operator",
    displayName: "Operator", roles: ["AgentControl.Viewer"], providerRoleIds: [inventoryProviderRoleIds.aiReader] };
}

describe("report selection authorization identity", () => {
  it("captures one immutable authorization snapshot before the epoch read yields", async () => {
    const original = actor(), expected = await reportIdentity(database, original);
    let release!: (epoch: string) => void;
    epoch.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = reportIdentity(database, original);
    original.tenantId = "Other/Tenant";
    original.homeAccountId = "Other/Account";
    original.roles.push("AgentControl.Admin");
    original.providerRoleIds!.push(inventoryProviderRoleIds.globalAdministrator);
    release("7");
    const actual = await pending;
    expect(actual).toEqual(expected);
    expect(epoch).toHaveBeenLastCalledWith(expected.tenantId, expected.principalId);
    expect(Object.isFrozen(actual)).toBe(true);
  });

  it("treats roles as sets and canonicalizes only contracted provider role GUIDs", async () => {
    const first = actor();
    first.roles.push("AgentControl.Admin");
    first.providerRoleIds!.push(inventoryProviderRoleIds.globalAdministrator);
    const second = actor();
    second.roles = ["AgentControl.Admin", "AgentControl.Viewer", "AgentControl.Admin"];
    second.providerRoleIds = [inventoryProviderRoleIds.globalAdministrator.toUpperCase(),
      inventoryProviderRoleIds.aiReader, inventoryProviderRoleIds.aiReader];
    expect(await reportIdentity(database, second)).toEqual(await reportIdentity(database, first));
    expect((await reportIdentity(database, actor())).authorizationHash)
      .not.toBe((await reportIdentity(database, first)).authorizationHash);
    for (const changes of [{ tenantId: "tenant/Exact" }, { homeAccountId: "account/Exact" },
      { homeAccountId: "Account/\uff25xact" }]) {
      expect((await reportIdentity(database, { ...actor(), ...changes })).authorizationHash)
        .not.toBe((await reportIdentity(database, actor())).authorizationHash);
    }
  });

  it.each([
    null, { ...actor(), roles: "AgentControl.Viewer" }, { ...actor(), roles: null },
    { ...actor(), tenantId: " " }, { ...actor(), homeAccountId: "Account-\ud800" },
    { ...actor(), tenantId: "t".repeat(513) }, { ...actor(), homeAccountId: "p".repeat(1025) },
    { ...actor(), providerRoleIds: [inventoryProviderRoleIds.aiReader, "\udfff"] },
    { ...actor(), providerRoleIds: Array(65).fill(inventoryProviderRoleIds.aiReader) },
    Object.create(actor()),
    { ...actor(), roles: Object.assign(["AgentControl.Viewer"], { extra: true }) },
    { ...actor(), providerRoleIds: new Array(1) },
  ])("rejects malformed or inherited authorization data before persistence: %j", async value => {
    await expect(reportIdentity(database, value as AuthenticatedUser)).rejects.toMatchObject({ status: 401 });
    expect(epoch).not.toHaveBeenCalled();
  });

  it("never invokes authorization getters or proxy traps", async () => {
    const getter = vi.fn(() => ["AgentControl.Viewer"]);
    const user = actor();
    Object.defineProperty(user, "roles", { enumerable: true, get: getter });
    await expect(reportIdentity(database, user)).rejects.toMatchObject({ status: 401 });
    const trap = vi.fn(() => { throw new Error("Proxy trap invoked"); });
    await expect(reportIdentity(database, new Proxy(actor(), { getPrototypeOf: trap }))).rejects.toMatchObject({ status: 401 });
    const array = ["AgentControl.Viewer"];
    Object.defineProperty(array, "0", { get: getter });
    await expect(reportIdentity(database, { ...actor(), roles: array } as AuthenticatedUser)).rejects.toMatchObject({ status: 401 });
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(epoch).not.toHaveBeenCalled();
  });
});
