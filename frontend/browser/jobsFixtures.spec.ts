import { expect, test } from "@playwright/test";
import type { WorkbenchJobsResponse } from "../src/api/client";
import { mockJobs } from "./jobsFixtures";

const initialState: WorkbenchJobsResponse = {
  value: [], unavailableSources: [], polledAt: "2026-09-20T13:05:00.000Z", requestId: "jobs-fixture-initial",
};

test.beforeEach(async ({ context, page }) => {
  await context.route("**/*", route => route.abort());
  await page.route("http://localhost/jobs-fixture", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html lang=\"en\"><title>Jobs fixture contracts</title><body></body></html>",
  }));
  await page.goto("http://localhost/jobs-fixture");
});

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Jobs status reads return the latest fixture state without commands", async ({ page }) => {
  let state = initialState;
  const { unexpected, commands } = await mockJobs(page, () => state);
  const read = () => page.evaluate(async () => {
    const response = await fetch("/api/workbench/jobs");
    return { status: response.status, body: await response.json() };
  });
  expect(await read()).toEqual({ status: 200, body: initialState });
  state = { ...initialState, requestId: "jobs-fixture-refreshed" };
  expect(await read()).toEqual({ status: 200, body: state });
  expect(unexpected).toEqual([]);
  expect(commands).toEqual([]);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
  test(`Jobs status fixtures reject ${method} rather than masking a client contract regression`, async ({ page }) => {
    let reads = 0;
    const { unexpected } = await mockJobs(page, () => {
      reads += 1;
      return initialState;
    });
    const status = await page.evaluate(async method =>
      (await fetch("/api/workbench/jobs", { method })).status, method);
    expect(status).toBe(501);
    expect(reads).toBe(0);
    expect(unexpected).toEqual([`${method} /api/workbench/jobs`]);
  });
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`Jobs request guards record ${method} even when an override fulfills it`, async ({ page }) => {
    const { unexpected, commands } = await mockJobs(page, () => initialState);
    await page.route("**/api/synthetic-command", route => route.fulfill({ status: 204 }));
    const status = await page.evaluate(async method =>
      (await fetch("/api/synthetic-command", { method })).status, method);
    expect(status).toBe(204);
    expect(commands).toEqual([`${method} /api/synthetic-command`]);
    expect(unexpected).toEqual([]);
  });
}

test("Jobs request guards retain command options instead of hiding them behind an allowed path", async ({ page }) => {
  const { unexpected, commands } = await mockJobs(page, () => initialState);
  const status = await page.evaluate(async () =>
    (await fetch("/api/capabilities/check?retry=failed", { method: "POST" })).status);
  expect(status).toBe(200);
  expect(commands).toEqual(["POST /api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});
