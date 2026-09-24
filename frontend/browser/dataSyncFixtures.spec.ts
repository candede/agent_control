import { expect, test, type Page } from "@playwright/test";
import type { DataSyncRun, DataSyncSourceState, DataSyncState, StartDataSyncInput } from "../src/api/client";
import { completedState, initial, mockSync } from "./dataSyncFixtures";

test.beforeEach(async ({ context, page }) => {
  await context.route("**/*", route => route.abort());
  await page.route("http://localhost/sync-fixture", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html lang=\"en\"><title>Sync fixture contracts</title><body></body></html>",
  }));
  await page.goto("http://localhost/sync-fixture");
});

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

function readState(page: Page): Promise<DataSyncState> {
  return page.evaluate(async () => {
    const response = await fetch("/api/data-sync/state");
    if (!response.ok) throw new Error(`Sync state read failed: ${response.status}`);
    return response.json();
  });
}

function startRun(page: Page, input: StartDataSyncInput): Promise<DataSyncRun> {
  return page.evaluate(async input => {
    const response = await fetch("/api/data-sync/runs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    if (response.status !== 202) throw new Error(`Sync start failed: ${response.status}`);
    return response.json();
  }, input);
}

test("automatic completion leaves manual reports outstanding", async ({ page }) => {
  const fixture = await mockSync(page, initial);
  const run = await startRun(page, { mode: "initial" });
  expect(run.sources.map(source => source.source)).toEqual(["users", "graph_packages", "power_platform"]);
  fixture.finish();
  const state = await readState(page);
  expect(state.onboardingRequired).toBe(false);
  expect(state.usageImportRequired).toBe(true);
  expect(state.sources.find(source => source.source === "usage_reports")).toEqual(initial.sources[3]);
  expect(fixture.unexpected).toEqual([]);
});

test("automatic due checks publish revision observations without masquerading as manual starts", async ({ page }) => {
  const fixture = await mockSync(page, completedState());
  const check = () => page.evaluate(async () => {
    const response = await fetch("/api/data-sync/auto-refresh", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return response.json();
  });
  const first = await check();
  expect(Object.keys(first.revisions)).toEqual(["users", "graph_packages", "power_platform"]);
  expect(first.run.id).toBe(completedState().run!.id);
  fixture.finish();
  const next = await check();
  expect(next.revisions.users).not.toBe(first.revisions.users);
  expect(fixture.starts).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("users-only completion cannot finish onboarding for unsynced sources", async ({ page }) => {
  const fixture = await mockSync(page, initial);
  await startRun(page, { mode: "initial", sources: ["users"] });
  fixture.finish();
  const state = await readState(page);
  expect(state.run?.status).toBe("completed");
  expect(state.onboardingRequired).toBe(true);
  expect(state.usageImportRequired).toBe(true);
  expect(state.sources.filter(source => source.source !== "users")).toEqual(initial.sources.slice(1));
  expect(fixture.starts).toEqual([{ mode: "initial", sources: ["users"] }]);
  expect(fixture.unexpected).toEqual([]);
});

test("report completion clears only the manual import requirement", async ({ page }) => {
  const saved = completedState();
  const fixture = await mockSync(page, {
    ...saved, usageImportRequired: true,
    sources: saved.sources.map(source => source.source === "usage_reports" ? initial.sources[3] : source),
    run: {
      ...saved.run!, status: "waiting", completedAt: null,
      sources: [{ ...initial.sources[3], status: "awaiting_upload" }],
    },
  });
  fixture.finish();
  const state = await readState(page);
  expect(state.usageImportRequired).toBe(false);
  expect(state.onboardingRequired).toBe(false);
  expect(state.sources.slice(0, 3)).toEqual(saved.sources.slice(0, 3));
  expect(fixture.unexpected).toEqual([]);
});

for (const terminal of ["finish", "cancel"] as const) {
  test(`${terminal} advances timestamps beyond the current run and source observations`, async ({ page }) => {
    const saved = completedState();
    const running: DataSyncRun = {
      ...saved.run!, status: "running", startedAt: "2026-09-23T10:00:00.000Z",
      updatedAt: "2026-09-23T10:30:00.000Z", completedAt: null,
      sources: [{ ...initial.sources[0], status: "running", canRetry: true }],
    };
    const fixture = await mockSync(page, { ...saved, run: running });
    fixture[terminal]();
    const { run } = await readState(page);
    expect(run).not.toBeNull();
    expect(Date.parse(run!.completedAt!)).toBeGreaterThan(Date.parse(running.updatedAt));
    expect(run!.updatedAt).toBe(run!.completedAt);
    expect(run!.sources[0].updatedAt).toBe(run!.completedAt);
    expect(run!.sources[0].canRetry).toBe(terminal === "cancel");
    if (terminal === "finish") expect(run!.sources[0].lastSuccessAt).toBe(run!.completedAt);
    expect(fixture.unexpected).toEqual([]);
  });
}

test("cancellation marks every unfinished source retryable without replacing saved data", async ({ page }) => {
  const saved = completedState();
  const statuses: DataSyncSourceState[] = ["running", "queued", "waiting_authorization", "awaiting_upload"];
  const fixture = await mockSync(page, {
    ...saved,
    run: { ...saved.run!, status: "waiting", completedAt: null,
      sources: saved.sources.map((source, index) => ({ ...source, status: statuses[index], canRetry: false })) },
  });
  const cancelled = fixture.cancel();
  const state = await readState(page);
  expect(state.run).toEqual(cancelled);
  expect(cancelled.sources.map(source => [source.status, source.canRetry])).toEqual(
    statuses.map(() => ["cancelled", true]),
  );
  expect(state.sources).toEqual(saved.sources);
  expect(state.onboardingRequired).toBe(false);
  expect(state.usageImportRequired).toBe(false);
  expect(fixture.unexpected).toEqual([]);
});

test("cancellation preserves succeeded attempts", async ({ page }) => {
  const fixture = await mockSync(page, initial);
  const run = await startRun(page, { mode: "initial" });
  const cancelled = fixture.cancel();
  expect(cancelled.sources[0]).toEqual(run.sources[0]);
  expect(cancelled.sources.slice(1).every(source => source.status === "cancelled" && source.canRetry)).toBe(true);
  expect(fixture.unexpected).toEqual([]);
});

test("run reads preserve exact retained identities and explicit not-found responses", async ({ page }) => {
  const saved = completedState();
  const retained: DataSyncRun = { ...saved.run!, id: "22222222-2222-4222-8222-222222222222" };
  const missingId = "33333333-3333-4333-8333-333333333333";
  const fixture = await mockSync(page, saved, [retained]);
  for (const run of [saved.run!, retained]) {
    const response = await page.evaluate(async id => {
      const response = await fetch(`/api/data-sync/runs/${id}`);
      return { status: response.status, body: await response.json() };
    }, run.id);
    expect(response).toEqual({ status: 200, body: run });
  }
  const missing = await page.evaluate(async id => (await fetch(`/api/data-sync/runs/${id}`)).status, missingId);
  expect(missing).toBe(404);
  expect(fixture.reads).toEqual([saved.run!.id, retained.id, missingId].map(id => `/api/data-sync/runs/${id}`));
  expect(fixture.unexpected).toEqual([]);
});

for (const [method, path] of [
  ["GET", "/api/data-sync/unknown"],
  ["GET", "/api/data-sync/state?force=true"],
  ["DELETE", "/api/data-sync/state"],
  ["POST", "/api/agent-inventory?limit=50"],
] as const) {
  test(`unexpected ${method} ${path} cannot pass the fixture request sentinel`, async ({ page }) => {
    const fixture = await mockSync(page, initial);
    const status = await page.evaluate(async ({ method, path }) => (await fetch(path, { method })).status, { method, path });
    expect(status).toBe(501);
    expect(fixture.unexpected).toEqual([`${method} ${path}`]);
    expect(fixture.starts).toEqual([]);
  });
}
