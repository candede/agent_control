import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphPackagesClient, buildCopilotAgentsListUrl } from "./graphPackages.js";
import { PowerPlatformResourceQueryClient } from "./powerPlatformResourceQuery.js";
import { generationHeartbeat } from "../db/dataGenerations.js";
import { inventoryMatchKey } from "./inventoryRecordProjection.js";

describe("dormant inventory pages", () => {
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
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
  it("enforces the 10000-page ceiling without a growing process seen-token set", async () => {
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
    await pages.next();
    await expect(pages.next()).rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
