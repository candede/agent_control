import { describe, expect, it, vi } from "vitest";
import type { Page, Request, Route } from "@playwright/test";
import { mockInventoryFacets, mockLayoutApi, unifiedAgents } from "../../browser/layoutFixtures";
import { encodeInventoryFacet } from "../../../backend/src/types/inventoryFacets";

type Fulfillment = NonNullable<Parameters<Route["fulfill"]>[0]>;

async function fixture() {
  const route = vi.fn<Page["route"]>(), contextRoute = vi.fn<Page["route"]>();
  const context: Pick<ReturnType<Page["context"]>, "route"> = { route: contextRoute };
  const page: Pick<Page, "route" | "context"> = { route, context: () => context as ReturnType<Page["context"]> };
  const unexpected = await mockLayoutApi(page as Page);
  async function request(path: string, method = "GET", body?: unknown) {
    const url = new URL(path, "http://localhost");
    const fulfill = vi.fn<Route["fulfill"]>(), abort = vi.fn<Route["abort"]>(), fallback = vi.fn<Route["fallback"]>();
    const input: Pick<Request, "url" | "method" | "postDataJSON" | "postData" | "headers" | "frame"> = {
      url: () => url.href, method: () => method, postDataJSON: () => body,
      postData: () => body === undefined ? null : JSON.stringify(body),
      headers: () => ({ "x-csrf-token": "layout-csrf" }),
      frame: () => ({ page: () => page as Page }) as ReturnType<Request["frame"]>,
    };
    const intercepted = { request: () => input as Request, fulfill, abort, fallback,
      continue: vi.fn<Route["continue"]>(), fetch: vi.fn<Route["fetch"]>() } satisfies Route;
    for (const [matcher, handler] of [...route.mock.calls].reverse().concat([...contextRoute.mock.calls].reverse())) {
      const matches = typeof matcher === "function" ? matcher(url)
        : matcher instanceof RegExp ? matcher.test(url.href)
          : matcher === "**/api/**" ? url.href.includes("/api/") : false;
      if (!matches) continue;
      fallback.mockClear();
      await handler(intercepted, intercepted.request());
      if (fallback.mock.calls.length) continue;
      if (abort.mock.calls.length) return { status: 0 } satisfies Fulfillment;
      expect(fulfill).toHaveBeenCalledTimes(1);
      return { status: 200, ...fulfill.mock.calls[0][0] };
    }
    throw new Error(`Unmocked fixture request: ${method} ${url.href}`);
  }
  async function capture(query: Record<string, string> = {}) {
    const response = await request("/api/agent-inventory/selections", "POST", { query });
    expect(response.status).toBe(201);
    return response.json.id as string;
  }
  return { page: page as Page, unexpected, request, capture };
}

describe("layout fixture request boundaries", () => {
  it.each(["https://example.invalid/api/me", "https://example.invalid/api/unknown", "https://example.invalid/image.png"])(
    "blocks and records external requests: %s", async url => {
      const { request, unexpected } = await fixture();
      expect((await request(url)).status).toBe(0);
      expect(unexpected).toEqual([`External request: ${url}`]);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])("rejects %s on read-only routes, including facet overrides", async method => {
    const { page, request, capture, unexpected } = await fixture();
    const id = await capture();
    await request(`/api/agent-inventory?selectionId=${id}`);
    await mockInventoryFacets(page, { type: [{ value: "shared", label: "Shared" }] });
    const record = encodeURIComponent(unifiedAgents.value[0].id);
    for (const path of [
      `/api/agent-inventory/${record}/detail`, `/api/agent-inventory/${record}/members`,
      "/api/agent-inventory/facets", "/api/official-usage/overview", "/api/me",
    ]) {
      expect(await request(`${path}?selectionId=${id}&field=type`, method)).toMatchObject({ status: 501 });
      expect(unexpected).toContain(`${method} ${path}`);
    }
  });

  it("keeps documented local reads and commands available and rejects unknown requests", async () => {
    const { request, capture, unexpected } = await fixture();
    expect((await request("/api/me")).status).toBe(200);
    expect((await request("/api/capabilities/check", "POST")).status).toBe(200);
    expect((await request("/api/data-sync/auto-refresh", "POST", {})).status).toBe(200);
    const id = await capture();
    expect((await request(`/api/agent-inventory?selectionId=${id}`)).json.value).toHaveLength(3);
    expect(unexpected).toEqual([]);
    expect((await request("/api/data-sync/auto-refresh", "POST", { invalid: true })).status).toBe(501);
    expect((await request("/api/unknown")).status).toBe(501);
    expect(unexpected).toEqual(["POST /api/data-sync/auto-refresh", "GET /api/unknown"]);
  });
});

describe("layout inventory facets", () => {
  it("searches default options and resolves only the captured selected option", async () => {
    const { request, capture, unexpected } = await fixture();
    const id = await capture({ type: encodeInventoryFacet("thirdParty") });
    const root = `/api/agent-inventory/facets?selectionId=${id}`;
    expect((await request(`${root}&field=publisher&search=FINANCE`)).json).toMatchObject({
      value: [{ value: "Synthetic Finance", label: "Synthetic Finance" }], total: 1, nextCursor: null,
    });
    expect((await request(`${root}&field=type&selected=true`)).json).toMatchObject({
      value: [{ value: "thirdParty", label: "3rd party agents" }], total: 1,
    });
    expect((await request(`${root}&field=publisher&selected=true`)).json).toMatchObject({ value: [], total: 0 });
    expect(unexpected).toEqual([]);
  });

  it("pages every custom option and retains search and selected-option behavior", async () => {
    const { page, request, capture } = await fixture();
    const options = Array.from({ length: 55 }, (_, index) => ({ value: `env-${index}`, label: `Environment ${index}` }));
    await mockInventoryFacets(page, { environmentId: options });
    const id = await capture({ environmentId: encodeInventoryFacet("env-54") });
    const root = `/api/agent-inventory/facets?selectionId=${id}&field=environmentId`;
    const first = (await request(root)).json;
    expect(first.value).toEqual(options.slice(0, 50));
    expect(first).toMatchObject({ total: 55, nextCursor: "fixture:50" });
    expect((await request(`${root}&cursor=${first.nextCursor}`)).json).toEqual({ value: options.slice(50), total: 55, nextCursor: null });
    expect((await request(`${root}&search=ENVIRONMENT%2054`)).json).toEqual({ value: [options[54]], total: 1, nextCursor: null });
    expect((await request(`${root}&selected=true`)).json).toEqual({ value: [options[54]], total: 1, nextCursor: null });
  });

  it("does not silently accept unknown facet fields or invalid pagination", async () => {
    const { page, request, capture, unexpected } = await fixture();
    await mockInventoryFacets(page, { environmentId: [{ value: "env", label: "Environment" }] });
    const id = await capture();
    expect((await request(`/api/agent-inventory/facets?selectionId=${id}&field=typo`)).status).toBe(501);
    expect(unexpected).toEqual(["GET /api/agent-inventory/facets"]);
    for (const field of ["type", "environmentId"]) {
      for (const query of ["limit=0", "limit=101", "cursor=invalid"]) {
        await expect(request(`/api/agent-inventory/facets?selectionId=${id}&field=${field}&${query}`))
          .rejects.toThrow("Invalid synthetic cursor page");
      }
    }
  });
});

describe("layout report pages", () => {
  it("derives filtered analytics from layout rows, not unrelated fixture defaults", async () => {
    const { request } = await fixture();
    const agent = (await request("/api/official-usage/aggregate?search=desk&limit=1")).json;
    expect(agent.analytics).toMatchObject({ rowCount: 1, responses: 120, zeroResponses: 0, unknownResponses: 0,
      agents: { windowAgents: 1, windowResponses: 120, windowDistinctActiveUsers: 2,
        mostResponses: [{ agentId: "layout-report-agent-1", responses: 120 }],
        leastResponses: [{ agentId: "layout-report-agent-1", responses: 120 }] } });
    const person = (await request("/api/official-usage/users?licenseCohort=active_without_paid&search=Alex")).json;
    expect(person.analytics).toMatchObject({ rowCount: 1, responses: 120, zeroResponses: 0, unknownResponses: 0 });
    for (const child of ["agents/layout-report-agent-1/users", "users/reader1%40example.invalid/agents"]) {
      expect((await request(`/api/official-usage/${child}?limit=1`)).json.analytics)
        .toMatchObject({ rowCount: 2, responses: 120, zeroResponses: 0, unknownResponses: 0 });
    }
    const overview = (await request("/api/official-usage/overview?search=desk")).json;
    expect(overview.analytics).toMatchObject({ rowCount: 1, overview: { reportedAgents: 1, usedAgents: 1, active30Days: 1 } });
    expect(overview.analytics.overview.asOf).toBe(overview.selection.evaluatedAt);
    for (const path of ["aggregate", "users?licenseCohort=active_without_paid"]) {
      expect((await request(`/api/official-usage/${path}${path.includes("?") ? "&" : "?"}search=missing`)).json.analytics)
        .toMatchObject({ rowCount: 0, responses: null, zeroResponses: 0, unknownResponses: 0 });
    }
    expect((await request("/api/official-usage/overview?search=missing")).json.analytics.overview)
      .toMatchObject({ reportedAgents: 0, usedAgents: 0, active30Days: 0, earliestActivityDateUtc: null, latestActivityDateUtc: null });
  });

  it("searches report facets without fabricating an option for an unknown field", async () => {
    const { request } = await fixture();
    expect((await request("/api/official-usage/aggregate/facets?field=creatorType&search=missing")).json)
      .toMatchObject({ value: [], counts: { total: 0, filtered: 0 } });
    expect((await request("/api/official-usage/aggregate/facets?field=creatorType&search=ORG")).json)
      .toMatchObject({ value: [{ value: "Your org", count: 2 }], counts: { total: 1, filtered: 1 } });
    expect((await request("/api/official-usage/users/facets?field=company&search=missing")).json.value).toEqual([]);
    await expect(request("/api/official-usage/users/facets?field=typo")).rejects.toThrow("Unexpected selected fixture facet");
  });

  it.each([
    "/api/official-usage/aggregate",
    "/api/official-usage/users?licenseCohort=active_without_paid",
    "/api/official-usage/overview",
    "/api/official-usage/agents/layout-report-agent-1/users",
    "/api/official-usage/users/reader1%40example.invalid/agents",
  ])("honors page bounds and selection identity: %s", async path => {
    const { request, unexpected } = await fixture();
    const root = `${path}${path.includes("?") ? "&" : "?"}selectionId=layout-selection&limit=1`;
    const first = (await request(root)).json;
    expect(first.value).toHaveLength(1);
    expect(first).toMatchObject({
      selection: { id: "layout-selection" }, counts: { filtered: 2 },
      page: { limit: 1, nextCursor: "fixture:1", previousCursor: null },
    });
    const second = (await request(`${root}&cursor=${first.page.nextCursor}`)).json;
    expect(second.value).toHaveLength(1);
    expect(second.value).not.toEqual(first.value);
    expect(second).toMatchObject({ selection: first.selection, reports: first.reports, counts: first.counts,
      page: { limit: 1, nextCursor: null, previousCursor: "fixture:0" } });
    expect((await request(`${root}&cursor=${second.page.previousCursor}`)).json).toEqual(first);
    expect(unexpected).toEqual([]);
  });

  it("preserves the lightweight history-options contract while applying page bounds", async () => {
    const { request } = await fixture();
    const first = (await request("/api/official-usage/history/options?limit=1&selectionId=history-selection")).json;
    expect(Object.keys(first).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
    expect(first).toMatchObject({ selection: { id: "history-selection" }, page: { limit: 1, nextCursor: null } });
    expect((await request("/api/official-usage/history/options?limit=1&cursor=fixture:1")).json.value).toEqual([]);
    for (const path of ["history", "history/options", "overview", "aggregate", "aggregate/facets?field=creatorType"]) {
      await expect(request(`/api/official-usage/${path}${path.includes("?") ? "&" : "?"}limit=0`))
        .rejects.toThrow("Invalid synthetic cursor page");
    }
  });
});
