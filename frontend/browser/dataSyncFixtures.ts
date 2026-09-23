import type { Page, Route } from "@playwright/test";
import { automaticDataSyncSourceIds, type DataSyncRun, type DataSyncSourceId, type DataSyncState, type StartDataSyncInput } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { createUnifiedVerification } from "../src/test/inventoryVerification";

const sourceIds: DataSyncSourceId[] = ["users", "graph_packages", "power_platform", "usage_reports"];
export const initial: DataSyncState = {
  onboardingRequired: true,
  usageImportRequired: true,
  run: null,
  sources: sourceIds.map(source => ({
    source, status: "not_started", count: null, lastSuccessAt: null, updatedAt: null,
    jobId: null, message: "", canRetry: false,
  })),
};

export async function mockSync(page: Page, firstState: DataSyncState, retainedRuns: DataSyncRun[] = []) {
  const unexpected = await mockLayoutApi(page);
  let state = firstState;
  const starts: StartDataSyncInput[] = [];
  const reads: string[] = [];
  const rejectRequest = (route: Route) => {
    const url = new URL(route.request().url());
    unexpected.push(`${route.request().method()} ${url.pathname}${url.search}`);
    return route.fulfill({ status: 501, json: { error: "Unexpected sync fixture request" } });
  };
  await page.route("**/api/agent-inventory?*", route => route.request().method() !== "GET" ? rejectRequest(route) : route.fulfill({ json: {
    revision: "a".repeat(64),
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }, { sourceScopes: false }),
    value: [], count: 0, offset: 0, limit: 50,
    summary: { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
    filteredSummary: { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
    sources: {
      graphPackages: { state: "unavailable", observation: null, error: null },
      powerPlatform: { state: "unavailable", observation: null, error: null },
    },
    partial: false, errors: [],
  } }));
  await page.route("**/api/data-sync/**", route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (url.search) return rejectRequest(route);
    if (route.request().method() === "GET") {
      if (path !== "/api/data-sync/state" && !/^\/api\/data-sync\/runs\/[^/]+$/.test(path)) return rejectRequest(route);
      reads.push(path);
      if (path === "/api/data-sync/state") return route.fulfill({ json: state });
      const run = [state.run, ...retainedRuns].find(run => run && path === `/api/data-sync/runs/${run.id}`);
      if (run) return route.fulfill({ json: run });
      return route.fulfill({ status: 404, json: { error: "Requested sync run not found." } });
    }
    if (route.request().method() !== "POST" || path !== "/api/data-sync/runs") {
      return rejectRequest(route);
    }
    const input = route.request().postDataJSON() as StartDataSyncInput;
    starts.push(input);
    const run: DataSyncRun = {
      id: "11111111-1111-4111-8111-111111111111", mode: input.mode, status: "running",
      startedAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z", completedAt: null,
      sources: initial.sources.filter(source => input.sources ? input.sources.includes(source.source) : source.source !== "usage_reports").map(source => ({
        ...source,
        status: source.source === "users" && !input.sources ? "succeeded" : "running",
        count: source.source === "users" ? input.sources ? 17 : 42 : source.source === "graph_packages" ? 650 : 2451,
        lastSuccessAt: source.source === "users" && !input.sources ? "2026-09-15T10:00:00.000Z" : null,
        message: source.source === "graph_packages" ? "Reading the next page of Graph packages." : "",
      })),
    };
    const sources = state.sources.map(source => {
      const finished = run.sources.find(attempt => attempt.source === source.source && attempt.status === "succeeded");
      if (finished) return finished;
      return input.clearSavedData && source.source !== "usage_reports"
        ? { ...source, status: "not_started" as const, count: null, lastSuccessAt: null } : source;
    });
    state = { ...state, run, sources, onboardingRequired: needsOnboarding(sources) };
    return route.fulfill({ status: 202, json: run });
  });
  return { starts, reads, unexpected, finish(completedAt?: string) {
    if (!state.run) throw new Error("Expected a sync run before completion.");
    completedAt ??= new Date(Date.parse(state.run.updatedAt) + 60_000).toISOString();
    const completed = state.run.sources.map(source => ({
      ...source, status: "succeeded" as const, count: 42, lastSuccessAt: completedAt,
      updatedAt: completedAt, canRetry: false, message: "",
    }));
    const sources = state.sources.map(source => completed.find(attempt => attempt.source === source.source) ?? source);
    const run: DataSyncRun = { ...state.run, status: "completed", updatedAt: completedAt, completedAt, sources: completed };
    state = {
      ...state, onboardingRequired: needsOnboarding(sources),
      usageImportRequired: sources.find(source => source.source === "usage_reports")?.status !== "succeeded",
      sources, run,
    };
    return run;
  }, cancel() {
    if (!state.run) throw new Error("Expected a sync run before cancellation.");
    const completedAt = new Date(Date.parse(state.run.updatedAt) + 60_000).toISOString();
    const run: DataSyncRun = {
      ...state.run, status: "cancelled", updatedAt: completedAt, completedAt,
      sources: state.run.sources.map(source => source.status === "succeeded" ? source : {
        ...source, status: "cancelled", updatedAt: completedAt, canRetry: true, message: "Cancelled by the requesting principal.",
      }),
    };
    state = { ...state, run };
    return run;
  } };
}

function needsOnboarding(sources: DataSyncState["sources"]) {
  return automaticDataSyncSourceIds.some(id => sources.find(source => source.source === id)?.status !== "succeeded");
}

export function completedState(): DataSyncState {
  const sources = initial.sources.map(source => ({
    ...source, status: "succeeded" as const, count: 42, lastSuccessAt: "2026-09-15T10:01:00.000Z",
  }));
  return {
    onboardingRequired: false, usageImportRequired: false, sources,
    run: {
      id: "be5ba369-4cc9-4a32-ba3b-f08d781acba0", mode: "initial", status: "completed",
      startedAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:01:00.000Z",
      completedAt: "2026-09-15T10:01:00.000Z", sources,
    },
  };
}
