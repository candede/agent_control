import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { GraphPackagesClient } from "./graphPackages.js";
import { streamProviderCollection } from "./providerCollection.js";
import { providerTextStream } from "./providerTextStream.js";

vi.mock("../db/pool.js", () => ({
  secretValue: vi.fn(() => undefined),
}));

const options = () => ({ signal: new AbortController().signal, idleTimeoutMs: 1000 });

describe("provider text stream cleanup", () => {
  it("releases its reader when closed before the first read, without awaiting cancellation", () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>({ cancel });
    const body = providerTextStream(new Response(source), options());
    expect(source.locked).toBe(true);
    body.close();
    expect(source.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.input.destroyed).toBe(true);
    body.close();
    expect(cancel).toHaveBeenCalledOnce();
  });

  describe("provider text stream package consumers", () => {
    it.each(["probe", "inventory"] as const)("does not inspect a borrowed error proxy after a %s body fails", async operation => {
      const trap = vi.fn(() => { throw new Error("Borrowed error diagnostics must not execute."); });
      const failure = new Proxy(new Error("Synthetic provider failure."), {
        get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap,
      });
      const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(failure); },
      })));
      const client = new GraphPackagesClient(fetcher, { maxAttempts: 1 });
      const result = operation === "probe" ? client.checkCatalogAccess("synthetic-token")
        : client.collectCatalog("synthetic-token", {
          visit: async () => undefined, onRecords: async () => undefined, onPage: async () => undefined,
        });
      const error = await result.then(() => undefined, error => error);
      expect(trap).not.toHaveBeenCalled();
      expect(error).toMatchObject({ code: "provider_network_error" });
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });

  it("releases the reader when collection authority expires before the input begins reading", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>({ cancel });
    const reason = new AppError(401, "authorization_expired", "Source authority changed.");
    let checks = 0;
    const collection = streamProviderCollection(new Response(source), {
      ...options(), contexts: { record: { fields: ["id"] } }, recordContext: "record",
      assertCurrent: () => { if (++checks === 2) throw reason; },
    });
    await expect(collection.next()).rejects.toBe(reason);
    expect(source.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("releases a pending reader promptly on close and does not classify cleanup as a transport failure", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const source = new ReadableStream<Uint8Array>({ cancel });
    const body = providerTextStream(new Response(source), options());
    body.input.resume();
    await nextTurn();
    body.close();
    expect(source.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    await nextTurn();
    expect(body.state.failure).toBeUndefined();
  });

  it("preserves an already-aborted reason without acquiring or releasing another consumer's reader", () => {
    const source = new ReadableStream<Uint8Array>();
    const response = new Response(source);
    const reader = source.getReader();
    const controller = new AbortController();
    const reason = new Error("Synthetic cancellation.");
    controller.abort(reason);
    expect(() => providerTextStream(response, { ...options(), signal: controller.signal })).toThrow(reason);
    expect(source.locked).toBe(true);
    reader.releaseLock();
  });
});
