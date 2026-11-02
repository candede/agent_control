import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { dataLimits } from "../db/dataBounds.js";
import { streamProviderCollection, type ProviderCollectionEvent } from "./providerCollection.js";

const options = {
  signal: new AbortController().signal, idleTimeoutMs: 1000, recordContext: "record",
  contexts: { record: { fields: ["id", "nested"], objects: { nested: "nested" } }, nested: { fields: ["name"] } },
};

async function events(response: Response) {
  const result: ProviderCollectionEvent[] = [];
  for await (const event of streamProviderCollection(response, options)) result.push(event);
  return result;
}

function chunks(parts: Iterable<Uint8Array>, cancel = vi.fn()) {
  const iterator = parts[Symbol.iterator]();
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel,
  }));
}

describe("streamed provider collections", () => {
  it.each([1, 7, 16384])("handles UTF-8 and contract metadata across %i-byte transport splits", async width => {
    const bytes = new TextEncoder().encode('{"@odata.count":2,"annotation":{"value":false},"value":[{"id":"caf\u00e9"},{"id":"two","nested":{"name":"ok"}}],"@odata.nextLink":"opaque"}');
    function* parts() { for (let i = 0; i < bytes.length; i += width) yield bytes.subarray(i, i + width); }
    expect(await events(chunks(parts()))).toEqual([
      { kind: "record", value: { id: "caf\u00e9" } },
      { kind: "record", value: { id: "two", nested: { name: "ok" } } },
      { kind: "complete", metadata: { rows: 2, count: 2, nextLink: "opaque" } },
    ]);
  });

  it("bounds admission checks by records and input chunks, not nested JSON tokens", async () => {
    const count = 100;
    const body = JSON.stringify({ value: Array.from({ length: count }, (_, index) => ({
      id: String(index),
      assignedPlans: Array.from({ length: 120 }, (_, plan) => ({
        servicePlanId: String(plan), service: "MicrosoftOffice", capabilityStatus: "Enabled",
        assignedDateTime: "2026-10-01T00:00:00Z",
      })),
    })) });
    const assertCurrent = vi.fn();
    let records = 0, completed = false;
    for await (const event of streamProviderCollection(new Response(body), { ...options, assertCurrent })) {
      if (event.kind === "record") records++;
      else completed = true;
    }
    expect(records).toBe(count);
    expect(completed).toBe(true);
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(count);
    expect(assertCurrent.mock.calls.length).toBeLessThanOrEqual(count + 4 * Math.ceil(Buffer.byteLength(body) / 16384) + 16);
  });

  it("rejects buffered records when authority changes while the consumer is paused", async () => {
    const reason = new Error("Source authority changed.");
    let revoked = false;
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"value":[{"id":"one"},{"id":"two"}]}')); }, cancel,
    });
    const iterator = streamProviderCollection(new Response(source), {
      ...options, assertCurrent: () => { if (revoked) throw reason; },
    });
    expect((await iterator.next()).value).toEqual({ kind: "record", value: { id: "one" } });
    revoked = true;
    await expect(iterator.next()).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves cancellation before yielding another buffered record", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const reason = new Error("Collection cancelled.");
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"value":[{"id":"one"},{"id":"two"}]}')); }, cancel,
    });
    const iterator = streamProviderCollection(new Response(source), {
      ...options, signal: controller.signal,
    });
    expect((await iterator.next()).value).toEqual({ kind: "record", value: { id: "one" } });
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("streams over 100000 records and 16 MB without holding the collection", async () => {
    const count = 100001, encoder = new TextEncoder();
    let wireBytes = 0;
    function* parts() {
      yield encoder.encode('{"value":[');
      for (let offset = 0; offset < count; offset += 100) {
        const body = Array.from({ length: Math.min(100, count - offset) }, (_, index) =>
          `${offset + index ? "," : ""}${JSON.stringify({ id: String(offset + index), description: "x".repeat(160) })}`).join("");
        wireBytes += Buffer.byteLength(body);
        yield encoder.encode(body);
      }
      yield encoder.encode(`],"@odata.count":${count}}`);
    }
    let records = 0, completed = false;
    for await (const event of streamProviderCollection(chunks(parts()), options)) {
      if (event.kind === "record") {
        expect(event.value).toHaveProperty("id", String(records++));
      } else {
        completed = true;
        expect(event.metadata).toEqual({ rows: count, count });
      }
    }
    expect(records).toBe(count);
    expect(completed).toBe(true);
    expect(wireBytes).toBeGreaterThan(16_000_000);
  }, 120_000);

  it.each([
    'null', '{}', '{"value":{}}', '{"value":[1]}', '{"value":[{}],"value":[]}',
    '{"value":[],"@odata.count":1,"@odata.count":2}', '{"value":[],"@odata.nextLink":{}}',
    '{"value":[{"id":"one","id":"two"}]}',
    '{"value":[{"nested":{"name":"one","name":"two"}}]}',
    '{"value":[{}]} trailing', '{"value":[{}]',
  ])("never reports completion for an invalid contract: %s", async body => {
    await expect(events(new Response(body))).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("retains JSON own-property semantics without prototype mutation", async () => {
    const result = await events(new Response('{"value":[{"id":"one","__proto__":{"polluted":true},"future":1,"future":2}]}'));
    expect(result[0]).toEqual({ kind: "record", value: JSON.parse('{"id":"one","__proto__":{"polluted":true},"future":2}') });
    expect({}).not.toHaveProperty("polluted");
  });

  it("distinguishes malformed UTF-8 from a failed transport", async () => {
    await expect(events(chunks([new Uint8Array([255])]))).rejects.toMatchObject({
      code: "provider_schema", message: expect.stringContaining("UTF-8"),
    });
    await expect(events(new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("socket failed")); } }))))
      .rejects.toMatchObject({ code: "provider_network_error" });
  });

  it("times out and cancels a stalled body even when cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({ cancel }));
    const read = async () => {
      for await (const _event of streamProviderCollection(response, { ...options, idleTimeoutMs: 10 })) {}
    };
    await expect(read()).rejects.toMatchObject({ code: "provider_timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("interrupts a pending body read with the original cancellation reason", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const iterator = streamProviderCollection(new Response(new ReadableStream({ cancel })), { ...options, signal: controller.signal });
    const reason = new Error("caller cancelled");
    const result = expect(iterator.next()).rejects.toBe(reason);
    await delay(5);
    controller.abort(reason);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds prefetch and cancels promptly when a consumer stops", async () => {
    let pulls = 0;
    const cancel = vi.fn(), encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode(`${pulls++ ? "," : '{"value":['}{"id":"one"}`));
      },
      cancel,
    }));
    const iterator = streamProviderCollection(response, options);
    expect((await iterator.next()).value).toEqual({ kind: "record", value: { id: "one" } });
    await delay(20);
    expect(pulls).toBeLessThan(10);
    await iterator.return();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not charge deliberate consumer backpressure against the body idle deadline", async () => {
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    const iterator = streamProviderCollection(new Response(transform.readable), { ...options, idleTimeoutMs: 10 });
    const first = iterator.next();
    await writer.write(Buffer.from('{"value":[{"id":"one"}'));
    expect((await first).value).toMatchObject({ kind: "record" });
    await delay(40);
    await writer.write(Buffer.from("]}"));
    await writer.close();
    expect((await iterator.next()).value).toEqual({ kind: "complete", metadata: { rows: 1 } });
    await iterator.return();
  });

  it("retains individual record working-memory and nesting bounds", async () => {
    await expect(events(new Response(JSON.stringify({ value: [{ id: "x".repeat(dataLimits.agentDefinitionWorkBytes + 1) }] }))))
      .rejects.toMatchObject({ code: "provider_result_limit" });
    await expect(events(new Response(`{"value":[${'{"nested":'.repeat(65)}{}${"}".repeat(65)}]}`)))
      .rejects.toMatchObject({ code: "provider_schema" });
  }, 30_000);
});
