import { describe, expect, it, vi } from "vitest";
import type { Page, Route } from "@playwright/test";
import { importedSetId, mockSelectedImport, retainedSetId, type SelectedImportOptions } from "../../browser/selectedImportFixture";

vi.mock("@playwright/test", () => ({ expect }));
vi.mock("../../browser/layoutFixtures", () => ({ mockLayoutApi: async () => [] }));

const files = [
  { name: "agents.csv", content: "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\r\n"
    + "a,Alpha,Your org,1,0,12,2026-09-12\r\nb,Beta,Microsoft,1,0,3,2026-08-14\r\nc,Unused,Your org,0,0,0,\r\n" },
  { name: "bridge.csv", content: "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\r\n"
    + "a,Alpha,Your org,ada@example.invalid,10,2026-09-12\r\na,Alpha,Your org,bea@example.invalid,2,2026-09-11\r\n"
    + "b,Beta,Microsoft,bea@example.invalid,3,2026-08-14\r\n" },
  { name: "users.csv", content: "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\r\n"
    + "ada@example.invalid,Ada,1,10,2026-09-12\r\nbea@example.invalid,Bea,2,5,2026-09-11\r\ncy@example.invalid,Cy,0,0,\r\n" },
];
const root = "/api/official-usage";
type Fulfillment = NonNullable<Parameters<Route["fulfill"]>[0]>;

async function fixture(options: SelectedImportOptions = { active: true }, csvFiles = files) {
  const route = vi.fn<Page["route"]>(), contextRoute = vi.fn<Page["route"]>();
  const clock: Pick<Page["clock"], "setFixedTime"> = { setFixedTime: vi.fn() };
  const context: Pick<ReturnType<Page["context"]>, "route"> = { route: contextRoute };
  const page: Pick<Page, "clock" | "route" | "context"> = { clock: clock as Page["clock"], route, context: () => context as ReturnType<Page["context"]> };
  const state = await mockSelectedImport(page as Page, csvFiles, options);
  const handler = route.mock.calls[0][1];
  async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const fulfill = vi.fn<Route["fulfill"]>(), abort = vi.fn<Route["abort"]>(), fallback = vi.fn<Route["fallback"]>();
    const intercepted = {
      request: () => ({
        url: () => `http://localhost${path}`, method: () => method, postDataJSON: () => body,
        postDataBuffer: () => typeof body === "string" ? Buffer.from(body) : null,
        headers: () => headers, isNavigationRequest: () => path.endsWith("/download"),
      }) as ReturnType<Route["request"]>,
      fulfill, abort, fallback, continue: vi.fn<Route["continue"]>(), fetch: vi.fn<Route["fetch"]>(),
    } satisfies Route;
    await handler(intercepted, intercepted.request());
    if (abort.mock.calls.length) return { status: 0 } satisfies Fulfillment;
    expect(fallback).not.toHaveBeenCalled();
    expect(fulfill).toHaveBeenCalledTimes(1);
    return { status: 200, ...fulfill.mock.calls[0][0] };
  }
  async function stage(bundleId: string, input = csvFiles) {
    for (const file of input) {
      const body = `--fixture\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n--fixture--\r\n`;
      expect((await request(`${root}/staging?bundleId=${bundleId}`, "POST", body, { "content-type": "multipart/form-data; boundary=fixture" })).status).toBe(201);
    }
    const { json: preview } = await request(`${root}/bundles/${bundleId}/preview`, "POST");
    return { bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision };
  }
  return { state, request, stage };
}

describe("selected import route contracts", () => {
  it("returns a registered user selection and retains filters, metadata and summaries across pages", async () => {
    const { request, state } = await fixture();
    const first = await request(`${root}/users?search=be&limit=1`);
    expect(first.json).toMatchObject({
      value: [{ username: "bea@example.invalid" }], counts: { total: 3, filtered: 1 },
      summary: { checkedUsers: null, licensedUsers: null, userReportedResponses: 15 },
      analytics: { rowCount: 1, responses: 5, zeroResponses: 0, unknownResponses: 0 },
    });
    state.selectReport(importedSetId);
    const next = await request(`${root}/users?selectionId=${first.json.selection.id}&limit=1`);
    expect(next.json).toEqual(first.json);
    expect((await request(`${root}/users/ada%40example.invalid?selectionId=${first.json.selection.id}`)).status).toBe(404);
    expect((await request(`${root}/users/bea%40example.invalid/agents?selectionId=${first.json.selection.id}&search=Beta`)).json)
      .toMatchObject({ value: [{ agentId: "b" }], selection: first.json.selection, reports: first.json.reports });
    expect(state.unexpected).toEqual([]);
  });

  it("retains user filters across actual cursor pages without inventing empty analytics", async () => {
    const { request } = await fixture();
    const { json: first } = await request(`${root}/users?responsesOnly=true&sort=responses&order=asc&limit=1`);
    expect(first).toMatchObject({ value: [{ username: "bea@example.invalid" }], counts: { filtered: 2 }, page: { nextCursor: "fixture:1" } });
    expect((await request(`${root}/users?selectionId=${first.selection.id}&cursor=${first.page.nextCursor}&limit=1`)).json)
      .toMatchObject({ value: [{ username: "ada@example.invalid" }], counts: first.counts, analytics: first.analytics, filters: first.filters });
    expect((await request(`${root}/users?search=missing`)).json.analytics)
      .toMatchObject({ rowCount: 0, responses: null, zeroResponses: 0, unknownResponses: 0 });
  });

  it("rejects selection endpoint and filter changes but permits independent facet searches", async () => {
    const { request } = await fixture();
    const { json: first } = await request(`${root}/aggregate?search=Alpha&creatorType=Your%20org`);
    for (const path of [
      `${root}/aggregate?selectionId=${first.selection.id}&search=Beta`,
      `${root}/users?selectionId=${first.selection.id}`,
      `${root}/history/options?selectionId=${first.selection.id}`,
    ]) expect(await request(path)).toMatchObject({ status: 400, json: { code: "invalid_cursor" } });
    expect((await request(`${root}/aggregate?selectionId=${first.selection.id}&search=%20ALPHA%20&creatorType=Your%20org&inactiveDays=30`)).json)
      .toMatchObject({ value: first.value, filters: first.filters });
    expect((await request(`${root}/aggregate/facets?selectionId=${first.selection.id}&field=creatorType&search=org`)).json)
      .toMatchObject({ value: [{ value: "Your org", count: 1 }], selection: first.selection });
  });

  it("enforces exact agent membership and keeps relationship filters separate from the parent", async () => {
    const { request } = await fixture();
    const { json: first } = await request(`${root}/aggregate?search=Alpha`);
    for (const suffix of ["", "/users"]) {
      expect(await request(`${root}/agents/b${suffix}?selectionId=${first.selection.id}`))
        .toMatchObject({ status: 404, json: { code: "data_record_not_found" } });
    }
    expect((await request(`${root}/agents/a/users?selectionId=${first.selection.id}&search=BEA&sort=responses&order=asc`)).json)
      .toMatchObject({ value: [{ username: "bea@example.invalid", responses: 2 }], counts: { filtered: 1 } });
  });

  it("applies agent identity, response, creator search and observed-date activity filters", async () => {
    const { request } = await fixture();
    for (const [query, ids] of [
      ["agentId=a", ["a"]], ["responsesOnly=true", ["a", "b"]], ["search=YOUR%20ORG", ["a", "c"]],
      ["reportActivity=recent&inactiveDays=29", ["a"]], ["reportActivity=inactive&inactiveDays=29", ["b"]],
      ["reportActivity=no-activity", ["c"]], ["startDate=2026-09-12&endDate=2026-09-12", ["a"]],
    ] as const) {
      const { json } = await request(`${root}/aggregate?${query}`);
      expect(json.value.map((row: { agentId: string }) => row.agentId)).toEqual(ids);
      expect(json.analytics.rowCount).toBe(ids.length);
    }
  });

  it("uses independent inactivity and activity-window thresholds, including null empty sums", async () => {
    const { request } = await fixture();
    expect((await request(`${root}/aggregate?inactiveDays=10&activityWindowDays=60`)).json.analytics.agents)
      .toMatchObject({ inactive: 1, windowAgents: 2, windowResponses: 15 });
    expect((await request(`${root}/aggregate?search=missing`)).json.analytics)
      .toMatchObject({ responses: null, agents: { windowResponses: null } });
  });

  it("ranks ten agents from the complete filtered result rather than the current page", async () => {
    const csvFiles = files.map((file, index) => index ? file : { ...file, content: file.content.split("\r\n")[0] + "\r\n"
      + Array.from({ length: 12 }, (_, i) => `a${i},Agent ${i},Your org,1,0,${i},2026-09-12\r\n`).join("") });
    const { request } = await fixture({ active: true }, csvFiles);
    const { json } = await request(`${root}/aggregate?search=Agent&sort=name&order=desc&limit=1`);
    expect(json.value).toHaveLength(1);
    expect(json.counts.filtered).toBe(12);
    expect(json.analytics.agents.mostResponses.map((row: { responses: number }) => row.responses)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(json.analytics.agents.leastResponses.map((row: { responses: number }) => row.responses)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("distinguishes retained-but-unselected reports from deleted reports", async () => {
    const { request } = await fixture({ historical: true });
    expect((await request(`${root}/aggregate`)).json.reports)
      .toMatchObject({ availability: "not_selected", setId: null, activeSetId: null });
  });

  it("keeps selected and history reporting ranges aligned across all CSV companions", async () => {
    const csvFiles = files.map((file, index) => index === 0
      ? { ...file, content: file.content.replaceAll("2026-08-14", "2026-09-12") } : file);
    const { request } = await fixture({ active: true }, csvFiles);
    expect((await request(`${root}/aggregate`)).json.reports.reportingPeriod)
      .toEqual({ startDate: "2026-08-14", endDate: "2026-09-12", days: 30, provenance: "activity_range" });
    for (const suffix of ["", "/options"]) {
      expect((await request(`${root}/history${suffix}`)).json.value)
        .toMatchObject([{ id: importedSetId, reportingStart: "2026-08-14", reportingEnd: "2026-09-12", periodProvenance: "activity_range" }]);
    }
  });

  it("returns the backend duplicate-identity error without retaining an invalid stage", async () => {
    const { request, state } = await fixture({});
    const csv = `${files[2].content}ada@example.invalid,Duplicate,1,1,\r\n`;
    const body = `--fixture\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--fixture--\r\n`;
    expect(await request(`${root}/staging?bundleId=22222222-2222-4222-8222-222222222222`, "POST", body,
      { "content-type": "multipart/form-data; boundary=fixture" }))
      .toMatchObject({ status: 400, json: { code: "duplicate_identity" } });
    expect(state.stages).toEqual([]);
  });

  it("filters and orders both history envelopes and checks observation membership", async () => {
    const { request } = await fixture({ active: true, historical: true });
    for (const suffix of ["", "/options"]) {
      const { json } = await request(`${root}/history${suffix}?search=2026-06&order=asc`);
      expect(json.value).toMatchObject([{ id: retainedSetId }]);
      expect(json.counts).toEqual({ total: 2, filtered: 1 });
      expect(await request(`${root}/history/${importedSetId}/observations?selectionId=${json.selection.id}`))
        .toMatchObject({ status: 404, json: { code: "data_record_not_found" } });
      expect((await request(`${root}/history/${retainedSetId}/observations?selectionId=${json.selection.id}`)).json.value).toHaveLength(3);
    }
    const { json } = await request(`${root}/history?order=asc&limit=1`);
    expect(json.value[0].id).toBe(retainedSetId);
    expect((await request(`${root}/history?selectionId=${json.selection.id}&cursor=${json.page.nextCursor}&limit=1`)).json.value[0].id).toBe(importedSetId);
  });

  it("counts unique retained observations and payloads instead of multiplying retained sets", async () => {
    const { request } = await fixture({ active: true, additionalSavedSets: 2 });
    expect((await request(`${root}/history`)).json.analytics.history)
      .toMatchObject({ imports: 3, uniqueObservations: 3, observationRows: 9, uniquePayloads: 9, repeatedRowsReused: 0 });
    expect((await request(`${root}/overview?scope=history&search=Alpha`)).json)
      .toMatchObject({ value: [{ agentId: "a", observationCount: 2, latestSetId: importedSetId, hasResponses: true }] });
  });

  it("derives overview evidence from all matching observations and sorts before paging", async () => {
    const { request } = await fixture();
    const { json } = await request(`${root}/overview?sort=name&order=desc&limit=1`);
    expect(json.value[0]).toMatchObject({ agentId: "c", observationCount: 1, active30Days: false });
    expect((await request(`${root}/overview?startDate=2026-09-11&endDate=2026-09-11`)).json.value)
      .toMatchObject([{ agentId: "a", earliestActivityDateUtc: "2026-09-11", lastActivityDateUtc: "2026-09-11", observationCount: 1 }]);
  });

  it("preserves retained sets and old history snapshots after another distinct acceptance", async () => {
    const { request, stage } = await fixture();
    const { json: before } = await request(`${root}/history`);
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const changed = files.map(file => ({ ...file, content: file.content.replaceAll("Alpha", "Changed Alpha") }));
    const body = await stage(bundleId, changed);
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", body);
    expect(accepted.setId).not.toBe(importedSetId);
    expect((await request(`${root}/history`)).json.value).toHaveLength(2);
    expect((await request(`${root}/history?selectionId=${before.selection.id}`)).json).toEqual(before);
    expect((await request(`${root}/aggregate?setId=${importedSetId}`)).json.value[0].agentName).toBe("Alpha");
  });

  it("fences receipt replays and invalidates accepted receipts after deletion", async () => {
    const { request, stage, state } = await fixture({ loseAcceptanceResponse: true });
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    expect((await request(`${root}/bundles/${bundleId}/accept`, "POST", body)).status).toBe(0);
    expect((await request(`${root}/bundles/${bundleId}/accept`, "POST", body)).json).toMatchObject({ setId: importedSetId, activeRevision: "2" });
    expect(await request(`${root}/bundles/${bundleId}/accept`, "POST", { ...body, bundleHash: "0".repeat(64) }))
      .toMatchObject({ status: 409, json: { code: "bundle_fence_mismatch" } });
    state.deleteImportedReport();
    expect(await request(`${root}/bundles/${bundleId}/accept`, "POST", body))
      .toMatchObject({ status: 409, json: { code: "deleted_report_duplicate" } });
  });

  it("does not accept a bundle whose stages changed after preview", async () => {
    const { request, stage, state } = await fixture({});
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    await request(`${root}/staging/${state.stages[0].id}`, "DELETE");
    expect(await request(`${root}/bundles/${bundleId}/accept`, "POST", body))
      .toMatchObject({ status: 409, json: { code: "bundle_fence_mismatch" } });
    expect(state.selectedSetId()).toBeNull();
  });

  it("keeps duplicate acceptance from changing the active head or retained history", async () => {
    const { request, stage } = await fixture({ active: true, historical: true, selectedSetId: retainedSetId, reusedExistingSet: true });
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    expect((await request(`${root}/bundles/${bundleId}/accept`, "POST", body)).json)
      .toEqual({ setId: importedSetId, activeRevision: "2", complete: true });
    expect((await request(`${root}/history`)).json)
      .toMatchObject({ counts: { filtered: 2 }, reports: { activeSetId: retainedSetId, activeRevision: "2", historyRevision: "1" } });
  });

  it("pins exported rows to the original selection and invalidates reads and export status after deletion", async () => {
    const { request, state } = await fixture({ active: true, historical: true, role: "Viewer" });
    const { json: first } = await request(`${root}/aggregate?search=Alpha`);
    state.selectReport(retainedSetId);
    const { json: submitted } = await request("/api/data-exports", "POST", {
      selectionId: first.selection.id, kind: "official_agents", idempotencyKey: "44444444-4444-4444-8444-444444444444",
    });
    expect((await request(`/api/data-exports/${submitted.id}`)).json).toMatchObject({ status: "ready", rows: 1 });
    const downloaded = await request(`/api/data-exports/${submitted.id}/download`);
    expect(downloaded.body?.toString()).toContain("Alpha");
    expect(downloaded.body?.toString()).not.toContain("Historical");
    state.deleteImportedReport();
    expect(await request(`${root}/aggregate?selectionId=${first.selection.id}`))
      .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
    expect((await request(`/api/data-exports/${submitted.id}`)).json).toMatchObject({ status: "failed", error: "selection_invalidated" });
  });

  it.each([-1, 1.5, 65, Number.NaN])("rejects an invalid retained-set count %s", async additionalSavedSets => {
    await expect(fixture({ additionalSavedSets })).rejects.toThrow("integer count from 0 to 64");
  });
});
