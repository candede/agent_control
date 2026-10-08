import { describe, expect, it, vi } from "vitest";
import type { Page, Route } from "@playwright/test";
import { importedSetId, mockSelectedImport, retainedSetId, type SelectedImportOptions } from "../../browser/selectedImportFixture";
import { reportBundle } from "./reportImportFixture";
import { deferred } from "./deferred";

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
  async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<Fulfillment & { status: number }> {
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
    const response = { status: 200, ...fulfill.mock.calls[0][0] };
    return { ...response, json: response.json === undefined ? undefined : structuredClone(response.json) };
  }
  function upload(bundleId: string, file: typeof files[number], correctionOfSetId?: string, metadata: Record<string, string> = {}) {
    const fields = Object.entries(metadata).map(([key, value]) =>
      `--fixture\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join("");
    const body = `${fields}--fixture\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n--fixture--\r\n`;
    return request(`${root}/staging?bundleId=${bundleId}&rejectDuplicateKind=true${correctionOfSetId ? `&correctionOfSetId=${correctionOfSetId}` : ""}`,
      "POST", body, { "content-type": "multipart/form-data; boundary=fixture" });
  }
  async function stage(bundleId: string, input = csvFiles, correctionOfSetId?: string, metadata: Record<string, string> = {}) {
    for (const file of input) expect((await upload(bundleId, file, correctionOfSetId, metadata)).status).toBe(201);
    const { json: preview } = await request(`${root}/bundles/${bundleId}/preview`, "POST");
    return { bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision };
  }
  return { state, request, stage, upload };
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
    expect(await request(`${root}/staging?bundleId=22222222-2222-4222-8222-222222222222&rejectDuplicateKind=true`, "POST", body,
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

  it("orders history by reporting window rather than a backfill's later acceptance", async () => {
    const { request, stage } = await fixture({ active: true, historical: true });
    const older = files.map(file => ({ ...file, content: file.content.replaceAll("2026-09", "2026-04").replaceAll("2026-08", "2026-03") }));
    const bundleId = crypto.randomUUID(), preview = await stage(bundleId, older);
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", preview);
    for (const suffix of ["", "/options"]) {
      expect((await request(`${root}/history${suffix}?sort=reportingPeriod&order=desc`)).json.value[0].id).toBe(importedSetId);
      expect((await request(`${root}/history${suffix}?sort=reportingPeriod&order=asc`)).json.value[0].id).toBe(accepted.setId);
    }
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

  it("keeps server-shaped bundle snapshots and stage reads independent of subsequent acceptance", async () => {
    const { request, stage, state } = await fixture({});
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    const previous = state.stages[0], delivered = (await request(`${root}/staging/${previous.id}`)).json;
    expect(state.bundlePreviews[0]).toEqual(reportBundle(state.stages, bundleId, "1"));
    expect((await request(`${root}/bundles/${bundleId}/accept`, "POST", body)).status).toBe(200);
    expect(previous.status).toBe("active");
    expect(delivered.status).toBe("active");
    expect((await request(`${root}/staging/${previous.id}`)).json).toMatchObject({
      id: previous.id, status: "accepted", revision: previous.revision, activeRevision: previous.activeRevision, expiresAt: previous.expiresAt,
    });
    const captured = structuredClone(state.bundlePreviews);
    state.stages[0].reconciliation.responses = 100;
    expect(state.bundlePreviews).toEqual(captured);
  });

  it("recovers a freshly reviewed accepted bundle without republishing or replacing a newer head", async () => {
    const { request, stage, state } = await fixture({ historical: true });
    const bundleId = "33333333-3333-4333-8333-333333333333", original = await stage(bundleId);
    const result = await request(`${root}/bundles/${bundleId}/accept`, "POST", original);
    expect(result.status).toBe(200);
    state.selectReport(retainedSetId);
    const { json: refreshed } = await request(`${root}/bundles/${bundleId}/preview`, "POST");
    expect(refreshed.expectedActiveRevision).toBe("3");
    const recovered = await request(`${root}/bundles/${bundleId}/accept`, "POST",
      { bundleHash: refreshed.bundleHash, expectedActiveRevision: refreshed.expectedActiveRevision });
    expect(recovered).toEqual(result);
    expect(state.selectedSetId()).toBe(retainedSetId);
    expect((await request(`${root}/bundles/${bundleId}/preview`, "POST")).json.expectedActiveRevision).toBe("3");
    expect(await request(`${root}/bundles/${bundleId}/accept`, "POST", original)).toEqual(result);
    expect(state.stages).toHaveLength(3);
  });

  it("keeps a committed upload discoverable while its response is pending and never resurrects discarded ownership", async () => {
    const gate = deferred<void>();
    const { request, stage, state } = await fixture({ stageResponseGate: gate.promise });
    const bundleId = "33333333-3333-4333-8333-333333333333", pending = stage(bundleId, files.slice(0, 1));
    await vi.waitFor(() => expect(state.stages).toHaveLength(1));
    const original = state.stages[0];
    expect((await request(`${root}/bundles/${bundleId}/preview`, "POST")).json.stages).toHaveLength(1);
    await request(`${root}/staging/${original.id}`, "DELETE");
    gate.resolve();
    await pending;
    expect(await request(`${root}/staging/${original.id}`)).toMatchObject({ status: 409, json: { code: "staging_unavailable" } });
    expect((await request(`${root}/bundles/${bundleId}/preview`, "POST")).json.stages).toEqual([]);
    await stage(bundleId, files.slice(0, 1));
    expect(state.stages[1].id).not.toBe(original.id);
    expect(state.discardedStages).toEqual([original.id]);
    expect(state.acceptRequests).toEqual([]);
    expect(state.selectedSetId()).toBeNull();
  });

  it.each([importedSetId, retainedSetId])("invalidates correction history while preserving the unrelated selected head %s", async selectedSetId => {
    const { request, stage } = await fixture({ active: true, historical: true, selectedSetId });
    const { json: before } = await request(`${root}/history`);
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const changed = files.map(file => ({ ...file, content: file.content.replaceAll("Alpha", "Corrected Alpha") }));
    const body = await stage(bundleId, changed, importedSetId);
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", body);
    expect(accepted.setId).not.toBe(importedSetId);
    expect(await request(`${root}/history?selectionId=${before.selection.id}`))
      .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
    const { json: history } = await request(`${root}/history`);
    expect(history.reports).toMatchObject({ historyRevision: "2", historyEpoch: "2",
      activeSetId: selectedSetId === importedSetId ? accepted.setId : retainedSetId,
      activeRevision: selectedSetId === importedSetId ? "3" : "2" });
    expect(history.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: importedSetId, visibility: "superseded" }),
      expect.objectContaining({ id: accepted.setId, supersedesSetId: importedSetId, visibility: "retained" }),
    ]));
    expect((await request(`${root}/aggregate?setId=${importedSetId}`)).json.value[0].agentName).toBe("Alpha");
    expect(await request(`${root}/sets/${importedSetId}/preview`, "POST", { operation: "select" }))
      .toMatchObject({ status: 409, json: { code: "staging_unavailable" } });
    expect((await request(`${root}/sets/${importedSetId}/preview`, "POST", { operation: "delete" })).status).toBe(200);
  });

  it("saves a backfill without selecting it or invalidating already pinned history", async () => {
    const { request, stage } = await fixture();
    const { json: before } = await request(`${root}/history`);
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const older = files.map(file => ({ ...file,
      content: file.content.replaceAll("2026-09", "2026-06").replaceAll("2026-08", "2026-05") }));
    const body = await stage(bundleId, older);
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", body);
    expect(accepted).toMatchObject({ activeRevision: "2", complete: true });
    expect((await request(`${root}/aggregate?setId=${accepted.setId}`)).json.reports)
      .toMatchObject({ setId: accepted.setId, activeSetId: importedSetId, historyRevision: "2", historyEpoch: "1" });
    expect((await request(`${root}/history?selectionId=${before.selection.id}`)).json).toEqual(before);
  });

  it("does not accept a bundle whose stages changed after preview", async () => {
    const { request, stage, state } = await fixture({});
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    await request(`${root}/staging/${state.stages[0].id}`, "DELETE");
    expect(await request(`${root}/bundles/${bundleId}/accept`, "POST", body))
      .toMatchObject({ status: 409, json: { code: "bundle_fence_mismatch" } });
    expect(state.selectedSetId()).toBeNull();
  });

  it("admits concurrent uploads and acceptance only once and rejects cleanup after another tab commits", async () => {
    const { request, upload, state } = await fixture({});
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const uploads = await Promise.all([upload(bundleId, files[0]), upload(bundleId, files[0])]);
    expect(uploads.map(response => response.status).sort()).toEqual([201, 409]);
    expect(uploads.find(response => response.status === 409)?.json.code).toBe("duplicate_report_kind");
    for (const file of files.slice(1)) expect((await upload(bundleId, file)).status).toBe(201);
    const { json: preview } = await request(`${root}/bundles/${bundleId}/preview`, "POST");
    const body = { bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision };
    const before = (await request(`${root}/staging/${state.stages[0].id}`)).json;
    const accepted = await Promise.all([
      request(`${root}/bundles/${bundleId}/accept`, "POST", body),
      request(`${root}/bundles/${bundleId}/accept`, "POST", body),
    ]);
    expect(accepted[0]).toEqual(accepted[1]);
    expect(accepted[0].json).toMatchObject({ setId: importedSetId, activeRevision: "2" });
    expect(await request(`${root}/staging/${before.id}`, "DELETE"))
      .toMatchObject({ status: 409, json: { code: "staging_unavailable" } });
    expect(before.status).toBe("active");
    expect((await request(`${root}/staging/${before.id}`)).json).toEqual({ ...before, status: "accepted" });
    expect(state.discardedStages).toEqual([]);
    expect((await request(`${root}/history`)).json)
      .toMatchObject({ counts: { total: 1 }, reports: { activeRevision: "2", historyRevision: "2", historyEpoch: "1" } });
  });

  it("does not admit import mutations through read or mismatched operation routes", async () => {
    const { request, stage, state } = await fixture({});
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    for (const path of [`${root}/bundles/${bundleId}/preview`, `${root}/bundles/${bundleId}/accept`]) {
      expect((await request(path, "GET", body)).status).toBe(404);
    }
    const stagedId = state.stages[0].id;
    expect((await request(`${root}/staging/${stagedId}/diagnostics`, "DELETE")).status).toBe(404);
    expect(await request(`${root}/bundles/${bundleId}/preview`, "POST", { forDiscard: "true" }))
      .toMatchObject({ status: 400, json: { code: "invalid_import_intent" } });
    expect(state.stages.every(stage => stage.status === "active")).toBe(true);
    expect(state.acceptRequests).toEqual([]);
    expect(state.discardedStages).toEqual([]);
    expect(state.selectedSetId()).toBeNull();
  });

  it("owns immutable confirmation hashes and consumes a deletion once without invalidating unrelated heads twice", async () => {
    const { request, state } = await fixture({ active: true, historical: true, selectedSetId: retainedSetId });
    expect(await request(`${root}/sets/${importedSetId}/preview`, "POST", { operation: "unsupported" }))
      .toMatchObject({ status: 400, json: { code: "invalid_operation" } });
    const { json: first } = await request(`${root}/sets/${importedSetId}/preview`, "POST", { operation: "delete" });
    const { json: second } = await request(`${root}/sets/${importedSetId}/preview`, "POST", { operation: "delete" });
    expect(first.hash).not.toBe(second.hash);
    expect((await request(`${root}/confirmations/${first.id}`, "POST", second)).status).toBe(400);
    expect(await request(`${root}/confirmations/${second.id}`, "POST", { ...first, id: second.id }))
      .toMatchObject({ status: 409, json: { code: "confirmation_mismatch" } });
    expect((await request(`${root}/confirmations/${first.id}`, "GET", first)).status).toBe(404);
    state.setPreviews[0].setId = retainedSetId;
    const attempts = await Promise.all([
      request(`${root}/confirmations/${first.id}`, "POST", first),
      request(`${root}/confirmations/${first.id}`, "POST", first),
    ]);
    expect(attempts.map(response => response.status)).toEqual([200, 409]);
    expect(attempts[1].json.code).toBe("confirmation_mismatch");
    expect(state.confirmations).toEqual([first]);
    expect((await request(`${root}/history`)).json)
      .toMatchObject({ value: [{ id: retainedSetId }], reports: { activeRevision: "2", historyRevision: "2", historyEpoch: "2" } });
    expect((await request(`${root}/sets/${importedSetId}/preview`, "POST", { operation: "delete" })).status).toBe(409);
  });

  it("requires fresh confirmation after an account replacement or shared-head change", async () => {
    const first = await fixture({ active: true, historical: true }), replacement = await fixture({ active: true, historical: true });
    const prepare = (request: typeof first.request) => request(`${root}/sets/${retainedSetId}/preview`, "POST", { operation: "select" });
    const { json: prior } = await prepare(first.request), { json: current } = await prepare(replacement.request);
    expect(await replacement.request(`${root}/confirmations/${prior.id}`, "POST", prior))
      .toMatchObject({ status: 409, json: { code: "confirmation_mismatch" } });
    expect(await replacement.request(`${root}/confirmations/${current.id}`, "POST", { ...prior, id: current.id }))
      .toMatchObject({ status: 409, json: { code: "confirmation_mismatch" } });
    first.state.selectReport(retainedSetId);
    expect(await first.request(`${root}/confirmations/${prior.id}`, "POST", prior))
      .toMatchObject({ status: 409, json: { code: "confirmation_mismatch" } });
    expect(first.state.confirmations).toEqual([]);
    expect((await replacement.request(`${root}/confirmations/${current.id}`, "POST", current)).json)
      .toEqual({ activeSetId: retainedSetId, activeRevision: "3" });
  });

  it("keeps duplicate acceptance from changing the active head or retained history", async () => {
    const { request, stage } = await fixture({ active: true, historical: true, selectedSetId: retainedSetId, reusedExistingSet: true });
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    expect((await request(`${root}/bundles/${bundleId}/accept`, "POST", body)).json)
      .toEqual({ setId: importedSetId, activeRevision: "2", complete: true });
    expect((await request(`${root}/history`)).json)
      .toMatchObject({ counts: { filtered: 2 }, reports: { activeSetId: retainedSetId, activeRevision: "2", historyRevision: "1" } });
  });

  it("reuses canonical observations after reordered uploads without changing pinned evidence or revisions", async () => {
    const { request, stage, state } = await fixture({ active: true, historical: true, selectedSetId: retainedSetId });
    const { json: before } = await request(`${root}/aggregate?setId=${importedSetId}`);
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const reordered = files.map(file => {
      const [header, ...rows] = file.content.trimEnd().split("\r\n");
      return { ...file, content: "\uFEFF" + [header, ...rows.reverse()].join("\n") + "\n" };
    });
    const body = await stage(bundleId, reordered);
    expect((await request(`${root}/bundles/${bundleId}/accept`, "POST", body)).json)
      .toEqual({ setId: importedSetId, activeRevision: "2", complete: true });
    expect((await request(`${root}/aggregate?setId=${importedSetId}`)).json.reports).toEqual(before.reports);
    expect((await request(`${root}/aggregate?selectionId=${before.selection.id}`)).json).toEqual(before);
    expect((await request(`${root}/history`)).json).toMatchObject({ counts: { total: 2 }, reports: { historyRevision: "1", historyEpoch: "1" } });
    expect(state.stages.every(stage => stage.status === "accepted" && stage.contentHash !== stage.fileHash)).toBe(true);
  });

  it("retains distinct observation versions for the same bytes with different provenance", async () => {
    const { request, stage, state } = await fixture();
    const { json: before } = await request(`${root}/aggregate`);
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const body = await stage(bundleId, files, undefined, { reportingStart: "2026-08-14", reportingEnd: "2026-09-12" });
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", body);
    expect(accepted.setId).not.toBe(importedSetId);
    const { json: after } = await request(`${root}/aggregate`);
    for (const lineage of after.reports.lineages) {
      expect(before.reports.lineages.map((row: { versionId: string }) => row.versionId)).not.toContain(lineage.versionId);
      expect(state.stages.find(stage => stage.kind === lineage.kind)?.contentHash).toBe(lineage.contentHash);
    }
    expect((await request(`${root}/history`)).json.analytics.history)
      .toMatchObject({ imports: 2, uniqueObservations: 6, observationRows: 18, uniquePayloads: 9, repeatedRowsReused: 9 });
    expect((await request(`${root}/overview?search=Alpha`)).json.value[0]).toMatchObject({ observationCount: 4 });
    expect((await request(`${root}/aggregate?selectionId=${before.selection.id}`)).json).toEqual(before);
  });

  it("keeps original observation receipts on reuse and records the exact corrected version", async () => {
    const { request, stage } = await fixture({ active: true, additionalSavedSets: 1 });
    const { json: before } = await request(`${root}/history/${importedSetId}/observations`);
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const changed = files.map((file, index) => index ? file : { ...file, content: file.content.replaceAll("Alpha", "Corrected Alpha") });
    const body = await stage(bundleId, changed, importedSetId);
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", body);
    const { json: after } = await request(`${root}/history/${accepted.setId}/observations`);
    for (const row of before.value) {
      const current = after.value.find((value: { kind: string }) => value.kind === row.kind);
      if (row.kind === "agents") expect(current).toMatchObject({ acceptedAt: "2026-09-12T14:45:00.000Z", supersedesVersionId: row.versionId });
      else expect(current).toEqual(row);
    }
    expect(before.value.every((row: { acceptedAt: string }) => row.acceptedAt === "2026-06-02T10:00:00.000Z")).toBe(true);
  });

  it.each<Record<string, string>>([
    { reportingStart: "2026-08-14", reportingEnd: "2026-09-12" },
    { sourceAsOf: "2026-09-12T00:00:00Z" },
  ])("rejects incompatible companion metadata but still exposes owned stages for discard: %j", async metadata => {
    const { request, upload, state } = await fixture({});
    const bundleId = "33333333-3333-4333-8333-333333333333";
    for (const [index, file] of files.entries()) expect((await upload(bundleId, file, undefined, index ? {} : metadata)).status).toBe(201);
    expect(await request(`${root}/bundles/${bundleId}/preview`, "POST"))
      .toMatchObject({ status: 409, json: { code: "incompatible_bundle" } });
    const { json: cleanup } = await request(`${root}/bundles/${bundleId}/preview`, "POST", { forDiscard: true });
    expect(cleanup.stages).toHaveLength(3);
    expect(await request(`${root}/bundles/${bundleId}/accept`, "POST",
      { bundleHash: cleanup.bundleHash, expectedActiveRevision: cleanup.expectedActiveRevision }))
      .toMatchObject({ status: 409, json: { code: "incompatible_bundle" } });
    for (const stage of cleanup.stages) expect((await request(`${root}/staging/${stage.stagingId}`, "DELETE")).status).toBe(204);
    expect(state.selectedSetId()).toBeNull();
    expect((await request(`${root}/bundles/${bundleId}/preview`, "POST")).json.stages).toEqual([]);
  });

  it("does not share stage, selection or observation identities between independent fixture owners", async () => {
    const first = await fixture(), replacement = await fixture();
    const { json: captured } = await first.request(`${root}/aggregate`);
    const { json: next } = await replacement.request(`${root}/aggregate`);
    expect(next.selection.id).not.toBe(captured.selection.id);
    expect(next.reports.lineages.map((row: { versionId: string }) => row.versionId))
      .not.toEqual(captured.reports.lineages.map((row: { versionId: string }) => row.versionId));
    expect(await replacement.request(`${root}/aggregate?selectionId=${captured.selection.id}`))
      .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
    const bundleId = "33333333-3333-4333-8333-333333333333";
    const original = await first.stage(bundleId), refreshed = await replacement.stage(bundleId);
    expect(original.bundleHash).not.toBe(refreshed.bundleHash);
    for (const body of [original, { ...refreshed, expectedActiveRevision: "1" }]) {
      expect(await replacement.request(`${root}/bundles/${bundleId}/accept`, "POST", body))
        .toMatchObject({ status: 409, json: { code: "bundle_fence_mismatch" } });
    }
    expect(replacement.state.stages.every(stage => stage.status === "active")).toBe(true);
    expect(await replacement.request(`${root}/staging/${first.state.stages[0].id}`))
      .toMatchObject({ status: 409, json: { code: "staging_unavailable" } });
  });

  it.each([0, 1])("retires deleted observation IDs unless %s other retained set still owns them", async additionalSavedSets => {
    const { request, stage, state } = await fixture({ active: true, additionalSavedSets });
    const { json: before } = await request(`${root}/aggregate`);
    state.deleteImportedReport();
    const bundleId = "33333333-3333-4333-8333-333333333333", body = await stage(bundleId);
    const { json: accepted } = await request(`${root}/bundles/${bundleId}/accept`, "POST", body);
    expect(accepted.setId).not.toBe(importedSetId);
    const { json: after } = await request(`${root}/aggregate?setId=${accepted.setId}`);
    const ids = (value: typeof before) => value.reports.lineages.map((row: { versionId: string }) => row.versionId);
    if (additionalSavedSets) expect(ids(after)).toEqual(ids(before));
    else for (const id of ids(after)) expect(ids(before)).not.toContain(id);
    expect(await request(`${root}/aggregate?selectionId=${before.selection.id}`))
      .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
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
    expect(downloaded.body?.toString()).toContain("2026-09-12T00:00:00.000Z");
    state.deleteImportedReport();
    expect(await request(`${root}/aggregate?selectionId=${first.selection.id}`))
      .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
    for (const [method, suffix] of [["GET", ""], ["DELETE", ""], ["GET", "/download"]]) {
      expect(await request(`/api/data-exports/${submitted.id}${suffix}`, method))
        .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
    }
    expect(await request("/api/data-exports", "POST", {
      selectionId: first.selection.id, kind: "official_agents", idempotencyKey: "44444444-4444-4444-8444-444444444444",
    })).toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
  });

  it("reuses one export admission per immutable intent and cannot resurrect cancelled work on a retry", async () => {
    const { request, state } = await fixture();
    const { json: first } = await request(`${root}/aggregate?search=Alpha`);
    const body = { selectionId: first.selection.id, kind: "official_agents", idempotencyKey: "44444444-4444-4444-8444-444444444444" };
    const submitted = await Promise.all([request("/api/data-exports", "POST", body), request("/api/data-exports", "POST", body)]);
    expect(submitted[0]).toEqual(submitted[1]);
    const id = submitted[0].json.id;
    const { json: ready } = await request(`/api/data-exports/${id}`);
    expect((await request(`/api/data-exports/${id}`, "DELETE")).status).toBe(204);
    expect((await request(`/api/data-exports/${id}`, "DELETE")).status).toBe(204);
    expect((await request("/api/data-exports", "POST", body)).json).toEqual({ id });
    expect(ready.status).toBe("ready");
    expect((await request(`/api/data-exports/${id}`)).json).toEqual({ ...ready, status: "cancelled" });
    expect(await request(`/api/data-exports/${id}/download`))
      .toMatchObject({ status: 409, json: { code: "export_not_ready" } });
    const { json: next } = await request(`${root}/aggregate?search=Beta`);
    expect(await request("/api/data-exports", "POST", { ...body, selectionId: next.selection.id }))
      .toMatchObject({ status: 409, json: { code: "export_idempotency_conflict" } });
    expect(state.exportRequests).toHaveLength(1);
    expect(state.exportDownloads).toEqual([]);
  });

  it("rejects export selections and receipt identities from another endpoint or fixture owner", async () => {
    const first = await fixture(), replacement = await fixture();
    const { json: selected } = await first.request(`${root}/aggregate`);
    const body = { selectionId: selected.selection.id, kind: "official_agents", idempotencyKey: "44444444-4444-4444-8444-444444444444" };
    expect(await replacement.request("/api/data-exports", "POST", body))
      .toMatchObject({ status: 409, json: { code: "selection_invalidated" } });
    const { json: users } = await first.request(`${root}/users`);
    expect(await first.request("/api/data-exports", "POST", { ...body, selectionId: users.selection.id }))
      .toMatchObject({ status: 400, json: { code: "export_selection_kind" } });
    const { json: submitted } = await first.request("/api/data-exports", "POST", body);
    for (const [method, suffix] of [["GET", ""], ["DELETE", ""], ["GET", "/download"]]) {
      expect(await replacement.request(`/api/data-exports/${submitted.id}${suffix}`, method))
        .toMatchObject({ status: 404, json: { code: "export_not_found" } });
    }
  });

  it.each([-1, 1.5, 65, Number.NaN])("rejects an invalid retained-set count %s", async additionalSavedSets => {
    await expect(fixture({ additionalSavedSets })).rejects.toThrow("integer count from 0 to 64");
  });
});
