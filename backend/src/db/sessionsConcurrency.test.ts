import { describe, expect, it, vi } from "vitest";
import { activateAccountSession, beginAccountSessionValidation, commitAccountSessionValidation, revokeAccountSessionMutations } from "./sessions.js";

describe("concurrent account role validation", () => {
  it("allows concurrent valid refreshes without treating another refresh as logout", async () => {
    const first = beginAccountSessionValidation("tenant", "concurrent-refresh");
    const second = beginAccountSessionValidation("tenant", "concurrent-refresh");
    const firstSave = vi.fn(async () => "first");
    const secondSave = vi.fn(async () => "second");
    await expect(Promise.all([
      commitAccountSessionValidation(first, firstSave),
      commitAccountSessionValidation(second, secondSave),
    ])).resolves.toEqual(["first", "second"]);
    expect(firstSave).toHaveBeenCalledOnce();
    expect(secondSave).toHaveBeenCalledOnce();
  });

  it("rejects both pending refreshes after logout and does not revive them on login", async () => {
    const first = beginAccountSessionValidation("tenant", "concurrent-revoke");
    const second = beginAccountSessionValidation("tenant", "concurrent-revoke");
    const save = vi.fn(async () => undefined);
    await revokeAccountSessionMutations("tenant", "concurrent-revoke", async () => undefined);
    await expect(commitAccountSessionValidation(first, save)).rejects.toMatchObject({ code: "unauthorized" });
    await activateAccountSession("tenant", "concurrent-revoke", async () => undefined);
    await expect(commitAccountSessionValidation(second, save)).rejects.toMatchObject({ code: "unauthorized" });
    expect(save).not.toHaveBeenCalled();
    const current = beginAccountSessionValidation("tenant", "concurrent-revoke");
    await expect(commitAccountSessionValidation(current, save)).resolves.toBeUndefined();
  });

  it("isolates logout and sign-in generations for the same principal in different tenants", async () => {
    const first = beginAccountSessionValidation("tenant-a", "shared-principal");
    const second = beginAccountSessionValidation("tenant-b", "shared-principal");
    await revokeAccountSessionMutations("tenant-a", "shared-principal", async () => undefined);
    await expect(commitAccountSessionValidation(first, async () => undefined)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(commitAccountSessionValidation(second, async () => "tenant-b")).resolves.toBe("tenant-b");
    await activateAccountSession("tenant-a", "shared-principal", async () => undefined);
    await expect(commitAccountSessionValidation(second, async () => "still-tenant-b")).resolves.toBe("still-tenant-b");
  });
});