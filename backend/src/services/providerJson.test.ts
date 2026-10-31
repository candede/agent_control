import { setImmediate } from "node:timers/promises";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { boundedProviderJson, boundedProviderText, parseProviderContractJson, ProviderResponseLimitError } from "./providerJson.js";
import { tinyGraphCatalog } from "./inventoryProviderTestSupport.js";
import { GraphPackagesClient, graphError, type FetchLike } from "./graphPackages.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { allowlistedPackage } from "./packageObservation.js";
import { UserSourceProvider } from "./userSourceProvider.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { reportHeaders } from "./userSourceGraphFields.js";
import { observePeakMemory } from "./peakMemory.js";
import { AppError } from "../errors.js";
import { GraphAgentIdentityClient } from "./graphAgentIdentity.js";

const directoryTokens = { user: "token", group: "token" };

async function readActivity(fetcher: FetchLike, signal = new AbortController().signal) {
  const database = new pg.Pool({ max: 4 });
  const stages = new UserSourceStages(database);
  vi.spyOn(stages, "query").mockResolvedValue("synthetic-activity-query");
  for (const method of ["page", "activity", "finishQuery", "progress"] as const) {
    vi.spyOn(stages, method).mockRejectedValue(new Error("Failed transport must not finalize or publish activity."));
  }
  try {
    return await new UserSourceProvider(fetcher).activity(stages, {
      id: "00000000-0000-4000-8000-000000000001", scopeId: "00000000-0000-4000-8000-000000000002",
      tenantId: "transport-fixture", owner: "00000000-0000-4000-8000-000000000003", version: 1,
      epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
    }, "token", signal);
  } finally { await database.end(); }
}

describe("bounded provider observations", () => {
  it.each([undefined, 16 * 1024 * 1024])("aborts and cancels a stalled JSON response body with budget %s", async maximumBytes => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = boundedProviderJson(new Response(new ReadableStream({ cancel })), controller.signal, maximumBytes);
    const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    controller.abort(new DOMException("deadline", "TimeoutError"));
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  describe("bounded report download cleanup", () => {
    it("rejects malformed UTF-8 reports before activity publication", async () => {
      const fetcher = vi.fn<FetchLike>(async () => new Response(Uint8Array.of(0xff)));
      await expect(readActivity(fetcher))
        .rejects.toMatchObject({ status: 502, code: "provider_schema", message: "Invalid activity CSV or UTF-8." });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each(["stalled", "rejected"])("does not let %s redirect cleanup block an allowed report request", async mode => {
      const cleanup = Promise.withResolvers<void>();
      const cancel = vi.fn(() => mode === "stalled" ? cleanup.promise : Promise.reject(new Error("cleanup failed")));
      const fetcher = vi.fn<FetchLike>()
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
          status: 302, headers: { location: "https://reports.office.com/data/download/report" },
        }))
        .mockResolvedValueOnce(new Response(null, { status: 400 }));
      const pending = readActivity(fetcher).catch(error => error);
      try {
        expect(await Promise.race([pending, setImmediate("still pending")])).toMatchObject({ code: "report_download_failed" });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce();
      } finally { cleanup.resolve(); await pending; }
    });

    it.each([302, 400].flatMap(status => ["stalled", "rejected"].map(mode => ({ status, mode }))))(
      "preserves the sanitized download error for status $status with $mode cleanup", async ({ status, mode }) => {
        const cleanup = Promise.withResolvers<void>();
        const cancel = vi.fn(() => mode === "stalled" ? cleanup.promise : Promise.reject(new Error("private cleanup details")));
        const fetcher = vi.fn<FetchLike>()
          .mockResolvedValueOnce(new Response(null, {
            status: 302, headers: { location: "https://reports.office.com/data/download/report" },
          }))
          .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
        const pending = readActivity(fetcher).catch(error => error);
        try {
          const result = await Promise.race([pending, setImmediate("still pending")]);
          expect(result).toMatchObject({ code: status === 302 ? "invalid_provider_link" : "report_download_failed" });
          expect(String(result)).not.toContain("private cleanup details");
          expect(fetcher).toHaveBeenCalledTimes(2);
          expect(cancel).toHaveBeenCalledOnce();
        } finally { cleanup.resolve(); await pending; }
      },
    );

    it("does not start a report download after cancellation during redirect cleanup", async () => {
      const controller = new AbortController();
      const reason = new DOMException("deadline", "TimeoutError");
      const fetcher = vi.fn<FetchLike>()
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { controller.abort(reason); } }), {
          status: 302, headers: { location: "https://reports.office.com/data/download/report" },
        }))
        .mockResolvedValueOnce(new Response(null, { status: 403 }));
      await expect(readActivity(fetcher, controller.signal)).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("does not request a report after cancellation", async () => {
      const reason = new DOMException("cancelled", "AbortError");
      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 403 }));
      await expect(readActivity(fetcher, AbortSignal.abort(reason))).rejects.toBe(reason);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([3, 4].flatMap(depth => ["cancellation", "deadline"].map(mode => ({ depth, mode }))))(
      "preserves report $mode between stream completion and stage finalization ($depth microtasks)", async ({ depth, mode }) => {
        const controller = new AbortController();
        const reason = new DOMException(mode, mode === "cancellation" ? "AbortError" : "TimeoutError");
        const body = new ReadableStream<Uint8Array>({
          start(stream) { stream.enqueue(new TextEncoder().encode(`${reportHeaders.join(",")}\n`)); },
          pull(stream) {
            stream.close();
            const abortAfterMicrotasks = (remaining: number) => {
              if (remaining === 0) controller.abort(reason);
              else queueMicrotask(() => abortAfterMicrotasks(remaining - 1));
            };
            abortAfterMicrotasks(depth);
          },
        }, { highWaterMark: 0 });
        const fetcher = vi.fn<FetchLike>(async () => new Response(body));
        await expect(readActivity(fetcher, controller.signal)).rejects.toBe(reason);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
      },
    );
  });

  it("cancels a response body even when its deadline elapsed before consumption", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    const cancel = vi.fn();
    await expect(boundedProviderJson(new Response(new ReadableStream({ cancel })), controller.signal)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves cancellation even when the response has no body", async () => {
    const reason = new DOMException("deadline", "TimeoutError");
    await expect(boundedProviderJson(new Response(null), AbortSignal.abort(reason))).rejects.toBe(reason);
    await expect(boundedProviderJson(new Response(null))).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("preserves cancellation without acquiring or releasing another consumer's reader", async () => {
    const reason = new DOMException("cancelled", "AbortError");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body);
    const reader = body.getReader();
    try {
      await expect(boundedProviderText(response, undefined, AbortSignal.abort(reason))).rejects.toBe(reason);
      expect(body.locked).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
    } finally { reader.releaseLock(); }
  });

  it("preserves cancellation during reader release before returning text or HTTP diagnostics", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const response = new Response('{"error":{"code":"Forbidden"}}', { status: 403 });
    const reader = response.body!.getReader();
    const release = reader.releaseLock.bind(reader);
    vi.spyOn(reader, "releaseLock").mockImplementation(() => { release(); controller.abort(reason); });
    vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
    await expect(graphError(response, controller.signal)).rejects.toBe(reason);
    expect(response.body!.locked).toBe(false);
  });

  it("preserves cancellation during reader release after a transport read failure", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.error(new TypeError("private transport details")); },
    }));
    const reader = response.body!.getReader();
    const release = reader.releaseLock.bind(reader);
    vi.spyOn(reader, "releaseLock").mockImplementation(() => { release(); controller.abort(reason); });
    vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
    await expect(boundedProviderText(response, undefined, controller.signal)).rejects.toBe(reason);
    expect(response.body!.locked).toBe(false);
  });

  it.each([1, 2])("preserves cancellation during parse checkpoint %i", async checkpoint => {
    const controller = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    const parse = vi.fn(JSON.parse);
    let observed = 0;
    const dispose = observePeakMemory(() => { if (++observed === checkpoint) controller.abort(reason); });
    try {
      await expect(boundedProviderJson(new Response("{}"), controller.signal, undefined, parse)).rejects.toBe(reason);
      expect(parse).toHaveBeenCalledTimes(checkpoint === 1 ? 0 : 1);
    } finally { dispose(); }
  });

  it.each([1, 2])("does not report local checkpoint %i failures as malformed provider JSON", async checkpoint => {
    const failure = new Error("synthetic observation failure");
    let observed = 0;
    const dispose = observePeakMemory(() => { if (++observed === checkpoint) throw failure; });
    try {
      await expect(boundedProviderJson(new Response("{}"))).rejects.toBe(failure);
    } finally { dispose(); }
  });

  it("keeps cancellation authoritative when a contract parser fails", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const parse = () => { controller.abort(reason); throw new SyntaxError("private provider fragment"); };
    await expect(boundedProviderJson(new Response("{}"), controller.signal, undefined, parse)).rejects.toBe(reason);
  });

  it.each([new Error("local parser failure"), new AppError(502, "provider_result_limit", "Contract limit exceeded.")])(
    "preserves non-syntax contract parser failure identity: %s", async failure => {
      await expect(boundedProviderJson(new Response("{}"), undefined, undefined, () => { throw failure; })).rejects.toBe(failure);
    },
  );

  it.each([false, true])("copies consumed bytes before a producer reuses its chunk buffer (signal: %s)", async withSignal => {
    const buffer = new Uint8Array(5);
    const parts = ['{"v":', "true}"];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === parts.length) { controller.close(); return; }
        buffer.set(new TextEncoder().encode(parts[index++]));
        controller.enqueue(buffer);
      },
    }, { highWaterMark: 0 });
    await expect(boundedProviderJson(new Response(body), withSignal ? new AbortController().signal : undefined))
      .resolves.toEqual({ v: true });
    expect(body.locked).toBe(false);
  });

  it("reads highly fragmented bodies with empty chunks without changing their byte budget", async () => {
    const bytes = Buffer.from(JSON.stringify({ value: "é😀".repeat(1000) }));
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === bytes.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(0));
        controller.enqueue(bytes.subarray(index, ++index));
      },
    }, { highWaterMark: 0 });
    await expect(boundedProviderJson(new Response(body), new AbortController().signal, bytes.length))
      .resolves.toEqual({ value: "é😀".repeat(1000) });
  });

  it("rejects oversized and malformed payloads", async () => {
    await expect(boundedProviderJson(new Response("x".repeat(2_000_001)))).rejects.toMatchObject({ code: "provider_result_limit" });
    await expect(boundedProviderJson(new Response("{"))).rejects.toMatchObject({ code: "provider_schema" });
    const error = await graphError(Response.json({ error: { code: "Forbidden", message: "denied", token: "never-return" }, raw: "never-return" }, { status: 403 }));
    expect(JSON.stringify(error.details)).not.toContain("never-return");
  });

  it.each([
    { label: "invalid leading byte", bytes: [0xff] },
    { label: "overlong encoding", bytes: [0xc0, 0xaf] },
    { label: "incomplete sequence", bytes: [0xe2, 0x82] },
    { label: "encoded surrogate", bytes: [0xed, 0xa0, 0x80] },
    { label: "out-of-range code point", bytes: [0xf4, 0x90, 0x80, 0x80] },
  ])("rejects an $label without replacement-decoding native identifiers", async ({ bytes }) => {
    const body = Buffer.concat([Buffer.from('{"id":"private-'), Buffer.from(bytes), Buffer.from('"}')]);
    const expected = { status: 502, code: "provider_schema", message: "Provider response was not valid UTF-8." };
    await expect(boundedProviderText(new Response(body))).rejects.toMatchObject(expected);
    await expect(boundedProviderJson(new Response(body))).rejects.toMatchObject(expected);
  });

  it.each([403, 429])("retains HTTP %s diagnostics when its error body has malformed UTF-8", async status => {
    const error = await graphError(new Response(Uint8Array.of(0xff), { status }));
    expect(error).toMatchObject({ status, code: "graph_error", details: { httpStatus: status } });
    expect(error.details).not.toHaveProperty("providerErrorCode");
    if (status === 429) expect(error.details).toMatchObject({ throttled: true });
  });

  it("allows an explicit larger JSON budget without changing the shared 2 MB default", async () => {
    const value = { value: "x".repeat(2_000_000) };
    const body = JSON.stringify(value);
    await expect(boundedProviderJson(new Response(body))).rejects.toMatchObject({
      code: "provider_result_limit", maximumBytes: 2_000_000, observedBytes: Buffer.byteLength(body),
    });
    await expect(boundedProviderJson(new Response(body), undefined, 4_000_000)).resolves.toEqual(value);
    await expect(boundedProviderJson(new Response("{"), undefined, 4_000_000)).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("enforces the exact configured byte boundary and cancels over-budget streams", async () => {
    const body = JSON.stringify({ value: "within budget" });
    const maximumBytes = Buffer.byteLength(body);
    await expect(boundedProviderJson(new Response(body), undefined, maximumBytes)).resolves.toEqual({ value: "within budget" });
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
      cancel,
    });
    await expect(boundedProviderJson(new Response(stream), undefined, maximumBytes - 1))
      .rejects.toEqual(new ProviderResponseLimitError(maximumBytes - 1, maximumBytes));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["stalled", "rejected"])("preserves the byte-limit error without waiting for %s cleanup", async mode => {
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => mode === "stalled" ? cleanup.promise : Promise.reject(new Error("cleanup failed")));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
      cancel,
    });
    const pending = boundedProviderJson(new Response(stream), undefined, 1).catch(error => error);
    try {
      expect(await Promise.race([pending, setImmediate("still pending")])).toEqual(new ProviderResponseLimitError(1, 2));
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    } finally { cleanup.resolve(); await pending; }
  });

  it.each(["stalled", "rejected"])("releases an aborted reader without waiting for %s cleanup", async mode => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => mode === "stalled" ? cleanup.promise : Promise.reject(new Error("private cleanup details")));
    const body = new ReadableStream<Uint8Array>({ cancel });
    const pending = boundedProviderText(new Response(body), undefined, controller.signal).catch(error => error);
    controller.abort(reason);
    try {
      expect(await Promise.race([pending, setImmediate("still pending")])).toBe(reason);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
      expect(body.locked).toBe(false);
    } finally { cleanup.resolve(); await pending; }
  });

  it("keeps cancellation during over-budget cleanup authoritative", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(Uint8Array.of(0xff, 0xff)); },
      cancel() { controller.abort(reason); },
    });
    await expect(boundedProviderText(new Response(body), 1, controller.signal)).rejects.toBe(reason);
    expect(body.locked).toBe(false);
  });

  it.each(["closed", "errored"])("keeps cancellation authoritative when the final read is %s at the same time", async state => {
    const abort = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
      pull(controller) {
        if (state === "closed") controller.close();
        else controller.error(new TypeError("interrupted body"));
        abort.abort(reason);
      },
    }, { highWaterMark: 0 });
    await expect(boundedProviderJson(new Response(stream), abort.signal)).rejects.toBe(reason);
    expect(stream.locked).toBe(false);
  });

  it.each(["{}", "{"])("preserves cancellation between text completion and JSON parsing for %s", async body => {
    const abort = new AbortController();
    const reason = new DOMException("deadline", "TimeoutError");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
      pull(controller) {
        controller.close();
        // Let the final read finish, then cancel before the JSON wrapper resumes.
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => abort.abort(reason))));
      },
    }, { highWaterMark: 0 });
    await expect(boundedProviderJson(new Response(stream), abort.signal)).rejects.toBe(reason);
    expect(stream.locked).toBe(false);
  });

  it("counts UTF-8 bytes across chunk boundaries without corrupting split characters", async () => {
    const value = { value: "é😀\uFFFD" };
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const response = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }));
    await expect(boundedProviderJson(response(), undefined, bytes.length)).resolves.toEqual(value);
    await expect(boundedProviderJson(response(), undefined, bytes.length - 1))
      .rejects.toEqual(new ProviderResponseLimitError(bytes.length - 1, bytes.length));
  });

  it("preserves the UTF-8 byte-order mark in text responses", async () => {
    await expect(boundedProviderText(new Response("\uFEFFheader,value"))).resolves.toBe("\uFEFFheader,value");
  });

  describe("contract scanner contexts", () => {
    const contexts = {
      root: { fields: ["record", "records"], objects: { record: "record" }, arrays: { records: "record" } },
      record: { fields: ["id", 'quote"\\key'] },
    };

    it.each([
      '{"record":{"id":"first","\\u0069d":"last"}}',
      '{"records":[0,{"quote\\"\\\\key":"first","quote\\u0022\\u005ckey":"last"}]}',
    ])("rejects escaped duplicates inside mapped containers: %s", text => {
      expect(() => parseProviderContractJson(text, contexts, 3)).toThrow(SyntaxError);
    });

    it("does not reinterpret escaped strings or unknown nested containers as contract members", () => {
      const text = '{"ignored":{"id":"first","id":"last"},"constructor":{"id":"first","id":"last"},'
        + '"__proto__":{"id":"first","id":"last"},"toString":"ignored","records":[["unknown",{"id":"first","id":"last"}],'
        + '{"id":"value with \\"quotes\\", braces } [ and slash \\\\","ignored":{"id":"first","id":"last"}}]}';
      expect(parseProviderContractJson(text, contexts, 3)).toEqual(JSON.parse(text));
    });

    it("restores sibling context after skipping deeply nested unknown JSON", () => {
      const text = `{"ignored":${'{"nested":['.repeat(32)}0${"]}".repeat(32)},`
        + '"records":[{"id":"first","id":"last"}]}';
      expect(() => parseProviderContractJson(text, contexts, 3)).toThrow(SyntaxError);
    });

    it("includes the configured depth without imposing a limit on unknown JSON", () => {
      const text = '{"records":[{"id":"first","id":"last"}]}';
      expect(parseProviderContractJson(text, contexts, 2)).toEqual({ records: [{ id: "last" }] });
      expect(() => parseProviderContractJson(text, contexts, 3)).toThrow(SyntaxError);
    });
  });

  it("omits unknown package fields with value-free diagnostics", () => {
    const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(allowlistedPackage({ id: "exact", displayName: "Fixture", isBlocked: false, platform: "copilotStudio", unknown: "private" })).toMatchObject({
        id: "exact", displayName: "Fixture", isBlocked: false, sourceSystem: "graph_packages", authoringTool: "copilotStudio",
        creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native",
        provenance: { authoringTool: { sourceSystem: "graph_packages", path: "platform", maturity: "ga" } },
      });
      expect(JSON.parse(diagnostics.mock.calls[0][0])).toEqual({
        timestamp: expect.any(String), level: "warn", event: "provider_schema_omission", provider: "graph_packages", count: 1,
      });
      expect(() => allowlistedPackage({ id: 12, displayName: "Fixture", isBlocked: false })).toThrow();
    } finally { diagnostics.mockRestore(); }
  });

  it("never follows foreign pagination and bounds directory input", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: [{ id: "P_1", displayName: "Package", isBlocked: false }], "@odata.nextLink": "https://other.invalid/collect" }));
    await expect(tinyGraphCatalog(new GraphPackagesClient(fetcher), "private-token")).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(new DirectoryPrincipalsClient(async () => Response.json({ value: Array.from({ length: 51 }, () => ({ id: "fixture" })) })).search(directoryTokens, "fi")).rejects.toMatchObject({ code: "provider_schema" });
    const bounded = vi.fn(async () => new Response("x".repeat(2_000_001)));
    await expect(new DirectoryPrincipalsClient(bounded).resolve(directoryTokens, [{ resourceId: "11111111-1111-4111-8111-111111111111", resourceType: "user" }])).rejects.toMatchObject({ code: "provider_result_limit" });
    expect(bounded.mock.calls[0]).toBeDefined();
  });

  it.each([
    '{"id":"foreign","\\u0069d":"11111111-1111-4111-8111-111111111111","servicePrincipalType":"ServiceIdentity"}',
    '{"id":"11111111-1111-4111-8111-111111111111","servicePrincipalType":"Application","servicePrincipalType":"ServiceIdentity"}',
  ])("rejects overwritten typed identity evidence", async text => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(text));
    await expect(new GraphAgentIdentityClient(fetcher).resolve("token", "11111111-1111-4111-8111-111111111111",
      new AbortController().signal, async () => {})).rejects.toMatchObject({ code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    '{"value":[{"id":"foreign","id":"11111111-1111-4111-8111-111111111111"}]}',
    '{"value":[{"id":"11111111-1111-4111-8111-111111111111"}],"value":[]}',
  ])("rejects overwritten principal search evidence", async text => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(text));
    await expect(new DirectoryPrincipalsClient(fetcher).search(directoryTokens, "fi")).rejects.toMatchObject({ code: "provider_schema" });
  });

  it.each([
    '{"value":[{"skuId":"foreign"}],"value":[]}',
    '{"value":[],"@odata.nextLink":"https://other.invalid/collect","@odata.nextLink":null}',
    '{"value":[{"skuId":"foreign","skuId":"11111111-1111-4111-8111-111111111111","appliesTo":"User","servicePlans":[]}]}',
    '{"value":[{"skuId":"11111111-1111-4111-8111-111111111111","appliesTo":"User","servicePlans":[{"servicePlanId":"foreign","servicePlanId":"22222222-2222-4222-8222-222222222222"}]}]}',
  ])("rejects overwritten license catalog evidence before staging", async text => {
    const database = new pg.Pool({ max: 4 });
    const stages = new UserSourceStages(database);
    vi.spyOn(stages, "query").mockResolvedValue("synthetic-directory-query");
    vi.spyOn(stages, "assertNewPage").mockResolvedValue();
    const page = vi.spyOn(stages, "page").mockRejectedValue(new Error("Malformed evidence must not be staged."));
    try {
      await expect(new UserSourceProvider(async () => new Response(text)).directory(stages, {
        id: "00000000-0000-4000-8000-000000000001", scopeId: "00000000-0000-4000-8000-000000000002",
        tenantId: "transport-fixture", owner: "00000000-0000-4000-8000-000000000003", version: 1,
        epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
      }, "token", new AbortController().signal)).rejects.toMatchObject({ code: "provider_schema" });
      expect(page).not.toHaveBeenCalled();
    } finally { await database.end(); }
  });

  it.each([
    (text: string) => text.replace('"id":', '"id":"foreign","id":'),
    (text: string) => text.replace('"disabledPlans":[]', '"disabledPlans":["foreign"],"disabledPlans":[]'),
    (text: string) => text.replace('"capabilityStatus":"Enabled"', '"capabilityStatus":"Deleted","capabilityStatus":"Enabled"'),
  ])("rejects overwritten directory identity and license-plan state before staging", async body => {
    const skuId = "11111111-1111-4111-8111-111111111111";
    const planId = "22222222-2222-4222-8222-222222222222";
    const text = JSON.stringify({ value: [{
      id: "33333333-3333-4333-8333-333333333333", userPrincipalName: "fixture@example.invalid",
      assignedLicenses: [{ skuId, disabledPlans: [] }],
      assignedPlans: [{ servicePlanId: planId, service: "fixture", capabilityStatus: "Enabled" }],
    }] });
    const database = new pg.Pool({ max: 4 });
    const stages = new UserSourceStages(database);
    vi.spyOn(stages, "query").mockResolvedValue("synthetic-directory-query");
    vi.spyOn(stages, "assertNewPage").mockResolvedValue();
    const page = vi.spyOn(stages, "page").mockResolvedValueOnce()
      .mockRejectedValue(new Error("Malformed directory evidence must not be staged."));
    vi.spyOn(stages, "finishQuery").mockResolvedValue();
    vi.spyOn(stages, "skuBatch").mockResolvedValue([{ skuId, servicePlanIds: [planId] }]);
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(Response.json({ value: [] }))
      .mockResolvedValueOnce(new Response(body(text)));
    try {
      await expect(new UserSourceProvider(fetcher).directory(stages, {
        id: "00000000-0000-4000-8000-000000000001", scopeId: "00000000-0000-4000-8000-000000000002",
        tenantId: "transport-fixture", owner: "00000000-0000-4000-8000-000000000003", version: 1,
        epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
      }, "token", new AbortController().signal)).rejects.toMatchObject({ code: "provider_schema" });
      expect(page).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally { await database.end(); }
  });

  it.each([
    { status: 403, text: '{"error":{"code":"private","code":"Forbidden"}}' },
    { status: 424, text: '{"error":{"message":"ordinary failure","message":"too many requests"}}' },
    { status: 429, text: '{"error":{"code":"private","code":"TooManyRequests"}}' },
  ])("retains HTTP $status but discards ambiguous error-body diagnostics", async ({ status, text }) => {
    const error = await graphError(new Response(text, { status }));
    expect(error).toMatchObject({ status, code: "graph_error", details: { httpStatus: status } });
    expect(error.details).not.toHaveProperty("providerErrorCode");
    if (status === 429) expect(error.details).toHaveProperty("throttled", true);
    else expect(error.details).not.toHaveProperty("throttled");
  });
});