import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateAccountSession, assertAccountSessionValidation, authorizeAccountBearer, beginAccountSessionValidation, clearAccountSessionMutationsForTest, commitAccountSessionValidation, revokeAccountSessionMutations } from "./sessions.js";

beforeEach(() => { clearAccountSessionMutationsForTest(); });

describe("concurrent account role validation", () => {
  it("keeps a failed sign-in revoked and allows a later successful retry", async () => {
    const previous = beginAccountSessionValidation("tenant", "failed-sign-in");
    await revokeAccountSessionMutations("tenant", "failed-sign-in", async () => undefined);
    const failure = new Error("Session persistence failed.");
    await expect(activateAccountSession("tenant", "failed-sign-in", async () => { throw failure; })).rejects.toBe(failure);
    const failed = beginAccountSessionValidation("tenant", "failed-sign-in");
    expect(() => assertAccountSessionValidation(failed)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    const save = vi.fn(async () => undefined);
    await expect(commitAccountSessionValidation(failed, save)).rejects.toMatchObject({ code: "unauthorized" });
    expect(save).not.toHaveBeenCalled();
    await activateAccountSession("tenant", "failed-sign-in", async () => undefined);
    for (const stale of [previous, failed]) {
      expect(() => assertAccountSessionValidation(stale)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    }
    const current = beginAccountSessionValidation("tenant", "failed-sign-in");
    await expect(commitAccountSessionValidation(current, async () => "current")).resolves.toBe("current");
  });

  it("opens sign-in authority only after persistence succeeds", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const activation = activateAccountSession("tenant", "pending-sign-in", async () => {
      started();
      await held;
      return "signed-in";
    });
    await ready;
    const pending = beginAccountSessionValidation("tenant", "pending-sign-in");
    try {
      expect(() => assertAccountSessionValidation(pending)).toThrow(expect.objectContaining({ code: "unauthorized" }));
    } finally { release(); }
    await expect(activation).resolves.toBe("signed-in");
    expect(() => assertAccountSessionValidation(pending)).not.toThrow();
  });

  it("does not report a held sign-in as successful after logout supersedes it", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const activation = activateAccountSession("tenant", "superseded-sign-in", async () => {
      started();
      await held;
    });
    const rejected = expect(activation).rejects.toMatchObject({ code: "unauthorized" });
    await ready;
    const revocation = revokeAccountSessionMutations("tenant", "superseded-sign-in", async () => undefined);
    release();
    await Promise.all([rejected, revocation]);
    const revoked = beginAccountSessionValidation("tenant", "superseded-sign-in");
    expect(() => assertAccountSessionValidation(revoked)).toThrow(expect.objectContaining({ code: "unauthorized" }));
  });

  it("keeps an active account queue serialized across the 10,000-account cache limit", async () => {
    const validation = beginAccountSessionValidation("tenant", "held-save");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const order: string[] = [];
    const save = commitAccountSessionValidation(validation, async () => {
      started();
      await held;
      order.push("save");
    });
    await ready;
    let revocation: Promise<void> | undefined;
    try {
      for (let index = 0; index < 10_000; index++) beginAccountSessionValidation("tenant", `other-${index}`);
      const peer = beginAccountSessionValidation("tenant", "held-save");
      expect(() => assertAccountSessionValidation(validation)).not.toThrow();
      expect(peer.generation).toBe(validation.generation);
      revocation = revokeAccountSessionMutations("tenant", "held-save", async () => { order.push("revoke"); });
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual([]);
    } finally {
      release();
      await Promise.all([save, revocation]);
    }
    expect(order).toEqual(["save", "revoke"]);
    await expect(commitAccountSessionValidation(validation, async () => undefined)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("retains new queues when every cache entry is busy and prunes idle entries after settling", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const validations: ReturnType<typeof beginAccountSessionValidation>[] = [];
    const operations: Promise<void>[] = [];
    let started = 0;
    for (let index = 0; index < 10_001; index++) {
      const validation = beginAccountSessionValidation("tenant", `busy-${index}`);
      validations.push(validation);
      operations.push(commitAccountSessionValidation(validation, async () => {
        started++;
        await held;
      }));
    }
    const completion = Promise.all(operations);
    try {
      await Promise.resolve();
      expect(started).toBe(10_001);
      for (const validation of [validations[0], validations.at(-1)!]) {
        expect(() => assertAccountSessionValidation(validation)).not.toThrow();
      }
    } finally {
      release();
      await completion;
    }
    expect(() => assertAccountSessionValidation(validations[0])).toThrow(expect.objectContaining({ code: "unauthorized" }));
    expect(() => assertAccountSessionValidation(validations.at(-1)!)).not.toThrow();
  });

  it("does not revive a revoked generation or supersede valid independent bearer peers", async () => {
    const before = beginAccountSessionValidation("tenant", "bearer-recovery");
    const cutoff = Date.now();
    await revokeAccountSessionMutations("tenant", "bearer-recovery", async () => undefined);
    await expect(authorizeAccountBearer("tenant", "bearer-recovery", cutoff, async () => undefined)).rejects.toMatchObject({ code: "unauthorized" });
    const validations = await Promise.all([
      authorizeAccountBearer("tenant", "bearer-recovery", cutoff + 2000, async value => value),
      authorizeAccountBearer("tenant", "bearer-recovery", cutoff + 2000, async value => value),
    ]);
    await expect(commitAccountSessionValidation(before, async () => undefined)).rejects.toMatchObject({ code: "unauthorized" });
    for (const value of validations) await expect(commitAccountSessionValidation(value, async () => "current")).resolves.toBe("current");
  });
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