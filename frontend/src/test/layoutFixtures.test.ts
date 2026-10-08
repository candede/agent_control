import { describe, expect, it, vi } from "vitest";
import type { Page, Request, Route } from "@playwright/test";
import { mockInventoryFacets, mockLayoutApi, unifiedAgents } from "../../browser/layoutFixtures";
import { mockSelectedInventoryUsage } from "../../browser/selectedInventoryUsageFixture";
import { encodeInventoryFacet } from "../../../backend/src/types/inventoryFacets";
import { mockSelectedPaidUsers } from "../../browser/selectedPaidFixture";
import { selectedPlansPage, selectedUsersPage } from "./selectedUsageFixture";

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
  it("pins paid-user source revisions, filters, exact membership and service plans until a replacement capture", async () => {
    const { page, request } = await fixture(), source = selectedUsersPage();
    const user = source.value[0], other = source.value[1], plans = selectedPlansPage().value;
    await mockSelectedPaidUsers(page, source, new Map([[user.directory.objectId, plans]]));
    const json = (response: Fulfillment) => response.json ?? (typeof response.body === "string" ? JSON.parse(response.body) : undefined);
    const first = json(await request("/api/copilot-usage/users?search=Ada&limit=1")), id = first.selection.id;
    expect(first.value).toMatchObject([{ directory: { displayName: "Ada" } }]);
    source.value[0].directory.displayName = "Replacement";
    source.sources.directory.generationId = "replacement-generation";
    source.reports.historyRevision = "36";
    plans[0].displayName = "Replacement plan";
    const pinned = json(await request(`/api/copilot-usage/users?selectionId=${id}&limit=1`));
    expect(pinned).toEqual(first);
    expect((await request(`/api/copilot-usage/users?selectionId=${id}&search=Ben`)).status).toBe(400);
    expect((await request(`/api/copilot-usage/users/${other.directory.objectId}?selectionId=${id}`)).status).toBe(404);
    expect(json(await request(`/api/copilot-usage/users/${user.directory.objectId}/service-plans?selectionId=${id}`)).value)
      .toEqual(selectedPlansPage().value);
    const replacement = json(await request("/api/copilot-usage/users?search=Ada&limit=1"));
    expect(replacement.value[0].directory.displayName).toBe("Replacement");
    expect(replacement.selection.id).not.toBe(first.selection.id);
    expect(replacement.selection.revision).not.toBe(first.selection.revision);
    expect(replacement.reports.historyRevision).toBe("36");
    expect(replacement.sources.directory.generationId).toBe("replacement-generation");
    expect(json(await request(`/api/copilot-usage/users?selectionId=${id}&limit=1`))).toEqual(first);
  });

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

  it.each([
    ["GET", "/api/capabilities/check"],
    ["GET", "/api/capabilities/check?retry=failed"],
    ["POST", "/api/capabilities/check?retry=all"],
    ["POST", "/api/capabilities/check?retry=failed&retry=failed"],
    ["POST", "/api/capabilities/check?retry=failed&force=true"],
    ["GET", "/api/capabilities/check-progress?retry=all"],
    ["GET", "/api/capabilities/check-progress?retry=failed&retry=failed"],
    ["GET", "/api/capabilities/check-progress?force=true"],
    ["POST", "/api/capabilities/check-progress"],
  ])("does not turn an invalid permission request into success: %s %s", async (method, path) => {
    const { request, unexpected } = await fixture();
    expect((await request(path, method)).status).toBe(501);
    expect(unexpected).toEqual([`${method} ${new URL(path, "http://localhost").pathname}`]);
  });

  it.each(["", "?retry=failed"])("keeps progress reads separate from permission checks (%s)", async query => {
    const { request, unexpected } = await fixture();
    expect(await request(`/api/capabilities/check${query}`, "POST")).toMatchObject({ status: 200, json: { value: expect.any(Array) } });
    expect(await request(`/api/capabilities/check-progress${query}`)).toEqual({ status: 200, json: { progress: null } });
    expect(unexpected).toEqual([]);
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

describe("layout inventory selection metadata", () => {
  it.each(["agent-inventory", "agents"])("bounds %s pages without losing the captured selection or earlier records", async resource => {
    const { request, unexpected } = await fixture();
    const capture = await request(`/api/${resource}/selections`, "POST", { query: {} });
    const id = capture.json.id as string;
    const root = `/api/${resource}?selectionId=${id}&limit=1`;
    const first = (await request(root)).json;
    expect(first.value).toHaveLength(1);
    expect(first).toMatchObject({ selection: capture.json, counts: { total: 3, scoped: 3, filtered: 3 },
      page: { limit: 1, nextCursor: "fixture:1", previousCursor: null } });
    const second = (await request(`${root}&cursor=${first.page.nextCursor}`)).json;
    const third = (await request(`${root}&cursor=${second.page.nextCursor}`)).json;
    expect(second).toMatchObject({ selection: first.selection, page: { nextCursor: "fixture:2", previousCursor: "fixture:0" } });
    expect(third).toMatchObject({ selection: first.selection, page: { nextCursor: null, previousCursor: "fixture:1" } });
    expect([first, second, third].flatMap(page => page.value.map((row: { id: string }) => row.id)))
      .toHaveLength(3);
    expect(new Set([first.value[0].id, second.value[0].id, third.value[0].id]).size).toBe(3);
    expect((await request(`${root}&cursor=${second.page.previousCursor}`)).json).toEqual(first);
    expect((await request(`${root}&cursor=fixture:3`)).json.value).toEqual([]);
    const detail = await request(`/api/${resource}/${encodeURIComponent(first.value[0].id)}/detail?selectionId=${id}`);
    expect(detail.json.id).toBe(first.value[0].id);
    expect(unexpected).toEqual([]);
  });

  it.each(["agent-inventory", "agents"])("rejects invalid %s page requests instead of fabricating a successful page", async resource => {
    const { request } = await fixture();
    const capture = await request(`/api/${resource}/selections`, "POST", { query: {} });
    for (const query of ["limit=0", "limit=101", "limit=1.5", "cursor=invalid"]) {
      await expect(request(`/api/${resource}?selectionId=${capture.json.id}&${query}`))
        .rejects.toThrow("Invalid synthetic cursor page");
    }
  });

  it("does not admit another page owner's selection", async () => {
    const original = await fixture(), replacement = await fixture();
    const id = await original.capture();
    await original.request(`/api/agent-inventory?selectionId=${id}`);
    await expect(replacement.request(`/api/agent-inventory?selectionId=${id}`))
      .rejects.toThrow("Unknown synthetic inventory selection");
    const replacementId = await replacement.capture();
    expect((await replacement.request(`/api/agent-inventory?selectionId=${replacementId}`)).json.selection.id).toBe(replacementId);
  });

  it("rebinds usage to each captured selection without changing a prior receipt or extending expiry", async () => {
    const { request, capture } = await fixture();
    const firstId = await capture();
    const first = (await request(`/api/agent-inventory?selectionId=${firstId}`)).json;
    const nextId = await capture();
    const next = (await request(`/api/agent-inventory?selectionId=${nextId}`)).json;
    expect(nextId).not.toBe(firstId);
    for (const [id, page] of [[firstId, first], [nextId, next]]) {
      expect(page.selection.id).toBe(id);
      expect(page.usageContext.revision).toBe(id);
      expect(page.freshness.capturedRevision).toBe(page.selection.revision);
      expect(page.usageContext.expiresAt).toBe(unifiedAgents.usageContext.expiresAt);
    }
    expect((await request(`/api/agent-inventory?selectionId=${firstId}`)).json).toEqual(first);
    expect(first.usageContext.revision).toBe(firstId);
  });

  it("uses the captured revision for selected usage rather than a later fixture revision", async () => {
    const { page, request, capture } = await fixture();
    const data = structuredClone(unifiedAgents);
    const record = data.value[0];
    record.usage = { recordId: record.id, reportSetId: data.usageContext.reports.setId,
      status: "linked", responses: 1, activeUsers: 1, lastActivityDateUtc: null, associationCount: 1 };
    await mockSelectedInventoryUsage(page, () => data, () => []);
    const id = await capture();
    const inventory = (await request(`/api/agent-inventory?selectionId=${id}`)).json;
    data.selection.revision = "replacement";
    const usage = (await request(`/api/agent-inventory/${encodeURIComponent(record.id)}/usage?inventorySelectionId=${id}`)).json;
    expect(usage.context).toMatchObject({
      selectionId: id, usageRevision: inventory.usageContext.revision, inventoryRevision: inventory.selection.revision,
    });
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
    for (const path of ["history", "history/options"]) {
      expect((await request(`/api/official-usage/${path}?search=missing`)).json)
        .toMatchObject({ value: [], counts: { total: 1, filtered: 0 } });
    }
    expect((await request("/api/official-usage/history?search=missing")).json.analytics)
      .toMatchObject({ rowCount: 0, history: { imports: 0, observationRows: 0, earliestReportingStart: null } });
    for (const path of ["history", "history/options", "overview", "aggregate", "aggregate/facets?field=creatorType"]) {
      await expect(request(`/api/official-usage/${path}${path.includes("?") ? "&" : "?"}limit=0`))
        .rejects.toThrow("Invalid synthetic cursor page");
    }
  });
});
