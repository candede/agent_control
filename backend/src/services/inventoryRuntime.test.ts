import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { InventoryRuntime } from "./inventoryRuntime.js";

describe("inventory publication wakeups", () => {
  it("coalesces arrivals during an active sweep without losing the next sweep", async () => {
    const runtime = new InventoryRuntime({ options: { max: 4 } } as pg.Pool);
    let release!: (more: boolean) => void;
    const pass = vi.spyOn(runtime, "pass").mockResolvedValue(false);
    pass.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    try {
      runtime.start();
      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(1));
      runtime.wake();
      runtime.wake();
      expect(pass).toHaveBeenCalledTimes(1);
      release(false);
      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(2));
    } finally {
      release(false);
      await runtime.drain();
    }
  });

  it("drains bounded scope pages without waiting for the thirty-second recovery timer", async () => {
    const runtime = new InventoryRuntime({ options: { max: 4 } } as pg.Pool);
    const pass = vi.spyOn(runtime, "pass").mockResolvedValue(false)
      .mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    try {
      runtime.start();
      await vi.waitFor(() => expect(pass).toHaveBeenCalledTimes(3));
    } finally {
      await runtime.drain();
    }
  });
});
