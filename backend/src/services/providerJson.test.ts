import { describe, expect, it, vi } from "vitest";
import { boundedProviderJson, ProviderResponseLimitError } from "./providerJson.js";
import { GraphPackagesClient, graphError } from "./graphPackages.js";
import { DirectoryPrincipalsClient } from "./directoryPrincipals.js";
import { allowlistedPackage } from "./packageObservation.js";

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

  it("cancels a response body even when its deadline elapsed before consumption", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("deadline", "TimeoutError"));
    const cancel = vi.fn();
    await expect(boundedProviderJson(new Response(new ReadableStream({ cancel })), controller.signal)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(cancel).toHaveBeenCalledOnce();
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