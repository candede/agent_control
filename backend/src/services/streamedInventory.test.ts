import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphPackagesClient, buildCopilotAgentsListUrl } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { generationHeartbeat } from "../db/dataGenerations.js";
import { inventoryMatchKey } from "./inventoryRecordProjection.js";
import { AppError } from "../errors.js";

describe("streamed inventory pages", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("bounds indexed compound identities without truncating long schema-name evidence", () => {
    const common = "schema".repeat(500);
    expect(inventoryMatchKey("environment", common)).toHaveLength(64);
    expect(inventoryMatchKey("environment", `${common}a`)).not.toBe(inventoryMatchKey("environment", `${common}b`));
    expect(inventoryMatchKey("environment-a", common)).not.toBe(inventoryMatchKey("environment-b", common));
  });
  it("pulls three catalog pages only as its durable consumer accepts each page", async () => {
    let page = 0;
    const fetcher = vi.fn(async () => {
      const current = ++page;
      return Response.json({ value: [{ id: `${current}`, displayName: "Agent", isBlocked: false }],
        "@odata.count": 3, ...current < 3 ? { "@odata.nextLink": `${buildCopilotAgentsListUrl()}&$skiptoken=${current}` } : {} });
    });
    const visit = vi.fn(async () => {});
    const producer = new GraphPackagesClient(fetcher).catalogPages("synthetic", { visit });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await producer.next()).value?.page).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await producer.next()).value?.page).toBe(2);
    expect((await producer.next()).value?.page).toBe(3);
    expect((await producer.next()).done).toBe(true);
    expect(visit).toHaveBeenCalledTimes(3);
  });
  it("rejects 100001 resources explicitly before publication", async () => {
    const client = new PowerPlatformResourceQueryClient(async () => Response.json({
      totalRecords: 100001, count: 0, data: [], resultTruncated: false,
    }));
    await expect(client.pages("synthetic", ["microsoft.copilotstudio/agents"], { visit: async () => {} }).next())
      .rejects.toMatchObject({ code: "provider_result_limit" });
  });
  it("streams more than 5000 scoped resources without a whole-source array", async () => {
    const tenant = "11111111-1111-1111-1111-111111111111";
    const environment = "22222222-2222-2222-2222-222222222222";
    let observed = 0;
    const client = new PowerPlatformResourceQueryClient(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      const offset = Number(body.Options.SkipToken ?? 0), count = Math.min(100, 5001 - offset);
      return Response.json({ totalRecords: 5001, count, resultTruncated: offset + count < 5001,
        skipToken: offset + count < 5001 ? String(offset + count) : undefined,
        data: Array.from({ length: count }, (_, index) => ({ tenantId: tenant, name: `native-${offset + index}`,
          type: "microsoft.copilotstudio/agents", properties: { environmentId: environment } })) });
    });
    for await (const page of client.pages("synthetic", ["microsoft.copilotstudio/agents"],
      { expectedTenantId: tenant, environmentId: environment, visit: async () => {} })) {
      expect(page.records.length).toBeLessThanOrEqual(100); observed += page.records.length;
    }
    expect(observed).toBe(5001);
  });
  it("enforces the 10000-page ceiling before issuing another request", async () => {
    let page = 0;
    const client = new GraphPackagesClient(async () => Response.json({ value: [{ id: String(++page), displayName: "X", isBlocked: false }],
      "@odata.nextLink": `${buildCopilotAgentsListUrl()}&$skiptoken=${page}` }));
    const read = async () => { for await (const result of client.catalogPages("synthetic", { visit: async () => {} })) expect(result.records).toHaveLength(1); };
    await expect(read()).rejects.toMatchObject({ code: "provider_page_limit" });
    expect(page).toBe(10000);
  });
  it("renews independently through an accepted 600-second Retry-After", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => {});
    const heartbeat = generationHeartbeat(renew);
    let attempts = 0;
    const client = new PowerPlatformResourceQueryClient(async () => ++attempts === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "600" } })
      : Response.json({ totalRecords: 0, count: 0, data: [], resultTruncated: false }),
    { delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) });
    const pending = client.pages("synthetic", ["microsoft.copilotstudio/agents"], { visit: async () => {}, signal: heartbeat.signal }).next();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(attempts).toBe(1);
    expect(renew).toHaveBeenCalledTimes(29);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).done).toBe(false);
    expect(renew).toHaveBeenCalledTimes(30);
    await heartbeat.stop();
  });
  it("applies the thirty-minute enumeration deadline independently of page request timeouts", async () => {
    const deadline = new AbortController(), original = AbortSignal.timeout;
    const timeouts = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds =>
      milliseconds === 1_800_000 ? deadline.signal : original(milliseconds));
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const client = new PowerPlatformResourceQueryClient(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      start();
    }));
    const pending = client.pages("synthetic", ["microsoft.copilotstudio/agents"], { visit: async () => {} }).next();
    const reason = new DOMException("Inventory enumeration deadline", "TimeoutError");
    const rejected = expect(pending).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    await started;
    expect(timeouts).toHaveBeenCalledWith(1_800_000);
    expect(timeouts).toHaveBeenCalledWith(10_000);
    deadline.abort(reason);
    await rejected;
  });
  it("rejects a foreign/selector-changing continuation before another provider request", async () => {
    const fetcher = vi.fn(async () => Response.json({ value: [{ id: "one", displayName: "X", isBlocked: false }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$filter=other" }));
    const pages = new GraphPackagesClient(fetcher).catalogPages("synthetic", { visit: async () => {} });
    await expect(pages.next()).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["visit", "beforeRequest", "progress"] as const)("interrupts a non-cooperative native %s callback without advancing the source", async stage => {
    const controller = new AbortController();
    const reason = new AppError(409, "read_job_cancelled", "Synthetic cancellation.");
    const blocked = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const callback = vi.fn(() => { started.resolve(); return blocked.promise; });
    const fetcher = vi.fn(async () => Response.json({ totalRecords: 0, count: 0, data: [], resultTruncated: false }));
    const pages = new PowerPlatformResourceQueryClient(fetcher).pages("synthetic", ["microsoft.copilotstudio/agents"], {
      signal: controller.signal, visit: stage === "visit" ? callback : async () => {},
      beforeRequest: stage === "beforeRequest" ? callback : undefined,
      onProgress: stage === "progress" ? callback : undefined,
    });
    if (stage === "progress") expect((await pages.next()).value?.page).toBe(1);
    const pending = pages.next();
    const rejected = expect(pending).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(stage === "progress" ? 1 : 0);
    blocked.resolve();
    expect((await pages.next()).done).toBe(true);
    const events = vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(entry));
    expect(events.filter(entry => entry.event === "inventory_query_failed")).toHaveLength(1);
  });

  it("bounds a non-cooperative native fetch and disposes its late response without waiting for cleanup", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Synthetic deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const fetching = Promise.withResolvers<Response>();
    const cleanup = Promise.withResolvers<void>();
    const cancel = vi.fn(() => cleanup.promise);
    const fetcher = vi.fn(() => fetching.promise);
    const pending = new PowerPlatformResourceQueryClient(fetcher, { maxAttempts: 1 })
      .pages("synthetic", ["microsoft.copilotstudio/agents"], { visit: async () => {} }).next();
    const rejected = expect(pending).rejects.toMatchObject({ status: 504, code: "provider_timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    fetching.resolve(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    cleanup.resolve();
  });

  it("terminates diagnostics when for-await closes a rejected durable page consumer", async () => {
    const fetcher = vi.fn(async () => Response.json({ totalRecords: 0, count: 0, data: [], resultTruncated: false }));
    const failure = new Error("Synthetic durable page failure.");
    const consume = async () => {
      for await (const _page of new PowerPlatformResourceQueryClient(fetcher)
        .pages("synthetic", ["microsoft.copilotstudio/agents"], { visit: async () => {} })) throw failure;
    };
    await expect(consume()).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
    const events = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
      .map(([entry]) => JSON.parse(entry));
    expect(events.filter(entry => /inventory_query_(completed|failed|interrupted)/.test(entry.event))).toEqual([
      expect.objectContaining({ event: "inventory_query_interrupted", stage: "save_page", pages: 0, observedCount: 0, outcome: "incomplete" }),
    ]);
  });
});
