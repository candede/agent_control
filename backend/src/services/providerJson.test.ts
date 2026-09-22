import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { boundedProviderJson, ProviderResponseLimitError } from "./providerJson.js";
import { GraphPackagesClient, graphError, type FetchLike } from "./graphPackages.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { allowlistedPackage } from "./packageObservation.js";
import { CopilotUsageGraphClient } from "./copilotUsageGraph.js";

vi.mock("csv-parse/sync", () => ({
  parse: () => { throw new Error("CSV parsing must not run in failed-download transport tests."); },
}));

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
    it.each(["stalled", "rejected"])("does not let %s redirect cleanup block an allowed report request", async mode => {
      const cleanup = Promise.withResolvers<void>();
      const cancel = vi.fn(() => mode === "stalled" ? cleanup.promise : Promise.reject(new Error("cleanup failed")));
      const fetcher = vi.fn<FetchLike>()
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
          status: 302, headers: { location: "https://reports.office.com/data/download/report" },
        }))
        .mockResolvedValueOnce(new Response(null, { status: 403 }));
      const pending = new CopilotUsageGraphClient(fetcher).listAppActivity("token").catch(error => error);
      try {
        expect(await Promise.race([pending, setImmediate("still pending")])).toMatchObject({ code: "report_download_failed" });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce();
      } finally { cleanup.resolve(); await pending; }
    });

    it.each([302, 403].flatMap(status => ["stalled", "rejected"].map(mode => ({ status, mode }))))(
      "preserves the sanitized download error for status $status with $mode cleanup", async ({ status, mode }) => {
        const cleanup = Promise.withResolvers<void>();
        const cancel = vi.fn(() => mode === "stalled" ? cleanup.promise : Promise.reject(new Error("private cleanup details")));
        const fetcher = vi.fn<FetchLike>()
          .mockResolvedValueOnce(new Response(null, {
            status: 302, headers: { location: "https://reports.office.com/data/download/report" },
          }))
          .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status }));
        const pending = new CopilotUsageGraphClient(fetcher).listAppActivity("token").catch(error => error);
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
      await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token", controller.signal)).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("does not request a report after cancellation", async () => {
      const reason = new DOMException("cancelled", "AbortError");
      const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 403 }));
      await expect(new CopilotUsageGraphClient(fetcher).listAppActivity("token", AbortSignal.abort(reason))).rejects.toBe(reason);
      expect(fetcher).not.toHaveBeenCalled();
    });
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

  it("rejects oversized and malformed payloads", async () => {
    await expect(boundedProviderJson(new Response("x".repeat(2_000_001)))).rejects.toMatchObject({ code: "provider_result_limit" });
    await expect(boundedProviderJson(new Response("{"))).rejects.toMatchObject({ code: "provider_schema" });
    const error = await graphError(Response.json({ error: { code: "Forbidden", message: "denied", token: "never-return" }, raw: "never-return" }, { status: 403 }));
    expect(JSON.stringify(error.details)).not.toContain("never-return");
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
    const value = { value: "é😀" };
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
    const fetcher = vi.fn(async () => Response.json({ value: [], "@odata.nextLink": "https://other.invalid/collect" }));
    await expect(new GraphPackagesClient(fetcher).listCopilotAgents("private-token")).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(new DirectoryPrincipalsClient(async () => Response.json({ value: Array.from({ length: 51 }, () => ({ id: "fixture" })) })).search("token", "fi")).rejects.toMatchObject({ code: "provider_schema" });
    const bounded = vi.fn(async () => new Response("x".repeat(2_000_001)));
    await expect(new DirectoryPrincipalsClient(bounded).resolve("token", [{ resourceId: "11111111-1111-4111-8111-111111111111", resourceType: "user" }])).rejects.toMatchObject({ code: "provider_result_limit" });
    expect(bounded.mock.calls[0]).toBeDefined();
  });
});