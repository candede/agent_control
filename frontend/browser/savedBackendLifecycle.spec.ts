import { expect, test } from "@playwright/test";
import type { UnifiedAgentInventoryPage } from "../../backend/src/types/unifiedAgents";
import { fixtureLoginUrl, isExternalFixtureRequest } from "./permissionFixtures";

test.afterEach(async ({ request }, info) => {
  const origin = process.env.AGENT_CONTROL_LIFECYCLE_CONTROL;
  if (!origin || isExternalFixtureRequest(new URL(origin))) return;
  const outcome = info.title.includes("with running delta") ? "running" : "failed";
  expect((await request.post(`${origin}/finish?key=${info.project.name}-${outcome}`)).ok()).toBe(true);
});

for (const outcome of ["running", "failed"] as const) {
  test(`fresh backend reads retain complete publication beyond freshness with ${outcome} delta`, async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const origin = process.env.AGENT_CONTROL_LIFECYCLE_CONTROL;
    if (!origin || isExternalFixtureRequest(new URL(origin))) throw new Error("Isolated real-backend lifecycle fixture required");
    const key = `${info.project.name}-${outcome}`;
    const receipts: unknown[] = [];
    async function control(command: string) {
      const response = await request.post(`${origin}/${command}?key=${key}`);
      expect(response.ok(), await response.text()).toBe(true);
      const body = await response.json();
      receipts.push({ command, ...body });
      return body;
    }
    const setup = await control("setup");
    expect(setup.failed).toBe(outcome === "failed");
    expect(setup.generations.some((row: { state: string }) => row.state === "staging")).toBe(outcome === "running");
    expect(Date.parse(setup.deadline)).toBeLessThan(Date.now() - 23 * 3_600_000);
    const unexpected: string[] = [], admissions: string[] = [], pages: UnifiedAgentInventoryPage[] = [];
    let captures = 0, pageRequests = 0, maximumBytes = 0;
    await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => true, configurable: true }));
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (isExternalFixtureRequest(url)) { unexpected.push(url.href); return route.abort(); }
      if (url.pathname === "/api/agent-inventory/selections") captures++;
      if (url.pathname === "/api/agent-inventory") pageRequests++;
      if (route.request().method() === "POST") admissions.push(url.pathname);
      return route.continue();
    });
    page.on("response", async response => {
      if (new URL(response.url()).pathname !== "/api/agent-inventory" || !response.ok()) return;
      const bytes = await response.body();
      maximumBytes = Math.max(maximumBytes, bytes.length);
      pages.push(JSON.parse(bytes.toString()));
    });
    await page.goto(fixtureLoginUrl(setup.scenario));
    await page.goto("/agents");
    await expect(page.getByText("Before 0000", { exact: true })).toBeVisible();
    await expect.poll(() => pages.length).toBe(1);
    const first = pages[0];
    expect(first.inventoryScope).toBe("catalog");
    expect(first.counts).toMatchObject({ total: 1002, scoped: 1001, filtered: 1001 });
    expect(first.value).toHaveLength(50);
    expect(captures).toBe(1);
    expect(pageRequests).toBe(1);
    expect(first.selection.publicationRevisions).toBeDefined();
    expect((await control("proof")).selections).toContainEqual({ id: first.selection.id, endpoint: "inventory" });
    for (const visit of ["reload", "navigation"] as const) {
      await control("expire");
      if (visit === "reload") await page.reload();
      else { await page.goto("/users"); await page.goto("/agents"); }
      await expect(page.getByText("Before 0000", { exact: true })).toBeVisible();
      const expected = visit === "reload" ? 2 : 3;
      await expect.poll(() => pages.length).toBe(expected);
      expect(captures).toBe(expected);
      expect(pageRequests).toBe(expected);
      const fresh = pages.at(-1)!;
      expect(fresh.selection.id).not.toBe(first.selection.id);
      expect(fresh.counts).toEqual(first.counts);
      expect(fresh.summary).toEqual(first.summary);
      expect(fresh.value).toEqual(first.value);
      expect((await control("proof")).selections).toContainEqual({ id: fresh.selection.id, endpoint: "inventory" });
    }
    const beforePublication = pages.at(-1)!;
    if (outcome === "running") {
      await control("source");
      await page.reload();
      await expect(page.getByText("Before 0000", { exact: true })).toBeVisible();
      await expect.poll(() => pages.length).toBe(4);
      expect(pages.at(-1)!.counts).toEqual(first.counts);
      expect(pages.at(-1)!.summary).toEqual(first.summary);
      expect(pages.at(-1)!.value).toEqual(first.value.map(row => ({ ...row, observations: { ...row.observations,
        graphPackages: row.observations.graphPackages ? { ...row.observations.graphPackages, current: false } : null } })));
      await control("canonical");
      await page.reload();
      await expect(page.getByText("After 0000", { exact: true })).toBeVisible();
      await expect.poll(() => pages.length).toBe(5);
      expect(pages.at(-1)!.counts).toEqual(first.counts);
      expect(pages.at(-1)!.selection.revision).not.toBe(beforePublication.selection.revision);
      expect(captures).toBe(5);
      expect(pageRequests).toBe(5);
    }
    await page.goto("/agents?inventory=power_platform_only");
    await expect(page.getByText("Retained native", { exact: true })).toBeVisible();
    await expect.poll(() => pages.length).toBe(outcome === "running" ? 6 : 4);
    const native = pages.at(-1)!;
    expect(native.counts).toMatchObject({ total: 1002, scoped: 1, filtered: 1 });
    expect(native.value).toHaveLength(1);
    expect(native.value[0]).toMatchObject({ environment: { displayName: "Retained environment" },
      people: { owner: { displayName: "Retained person" } } });
    expect(captures).toBe(outcome === "running" ? 6 : 4);
    expect(pageRequests).toBe(captures);
    await control("retire");
    await page.reload();
    await expect(page.getByText("Before 0000", { exact: true })).toHaveCount(0);
    await expect(page.getByText("After 0000", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Retained native", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Saved agent inventory unavailable", exact: true })).toBeVisible();
    expect(captures).toBe(outcome === "running" ? 7 : 5);
    expect(pageRequests).toBe(outcome === "running" ? 6 : 4);
    expect(pages).toHaveLength(pageRequests);
    expect(maximumBytes).toBeLessThanOrEqual(1_048_576);
    expect(admissions.filter(path => /data-exports|mutation|\/block|\/unblock|\/data-sync\/runs/.test(path))).toEqual([]);
    expect(unexpected).toEqual([]);
    await info.attach("real-backend-lifecycle", { body: JSON.stringify({ outcome, captures, pageRequests,
      pageResponses: pages.length, maximumBytes, counts: first.counts, summary: first.summary, receipts }), contentType: "application/json" });
  });
}
