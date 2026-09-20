import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { usageOverviewFixture } from "../src/test/usageInsightsFixture";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("cumulative activity defaults to retained history and keeps source response totals separate", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const data = usageOverviewFixture();
  const older = {
    ...data.agents.value[0], agentId: "june-only-agent", agentName: "June-only retained agent",
    lastActivityDateUtc: "2026-06-01", latestSetId: "99999999-9999-4999-8999-999999999999",
  };
  data.agents.value.push(older);
  data.agents.count += 1;
  data.summary = { ...data.summary, retainedSets: 2, reportedAgents: 3, usedAgents: 3, earliestActivityDateUtc: "2026-06-01" };
  await page.route("**/api/official-usage/overview?*", route => {
    const params = new URL(route.request().url()).searchParams;
    const value = data.agents.value.filter(agent => (!params.get("search") || agent.agentName.toLowerCase().includes(params.get("search")!.toLowerCase()))
      && (!params.get("startDate") || Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc >= params.get("startDate")!))
      && (!params.get("endDate") || Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc.slice(0, 10) <= params.get("endDate")!)));
    return route.fulfill({ json: { ...data, agents: { ...data.agents, value, count: value.length } } });
  });
  await page.route(url => url.pathname === "/api/official-usage/aggregate" && url.searchParams.get("setId") === older.latestSetId,
    route => route.fulfill({ status: 503, json: { detail: "This source snapshot is temporarily unavailable.", code: "synthetic_snapshot_unavailable" } }));
  const reads: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/official-usage/aggregate") reads.push(request.url()); });
  await page.goto("/official-usage");
  await expect(page.getByRole("button", { name: "Cumulative activity", exact: true })).toHaveAttribute("aria-pressed", "true");
  const rows = page.getByRole("region", { name: "Retained agent activity rows" });
  await expect(rows.locator("tbody tr")).toHaveCount(3);
  await expect(rows.getByRole("row", { name: /June-only retained agent/ })).toBeVisible();
  await expect(rows.getByRole("rowheader").first()).toHaveCSS("text-transform", "none");
  await expect(rows.getByRole("rowheader").first().locator("small")).toHaveCSS("text-transform", "none");
  await expect(page.getByText(/Overlapping response totals are not added/)).toBeVisible();
  await expect(rows.getByRole("columnheader", { name: "Responses", exact: true })).toHaveCount(0);
  expect(reads).toEqual([]);
  if (info.project.name === "desktop") expect((await rows.boundingBox())!.y).toBeLessThan(760);
  expect((await new AxeBuilder({ page }).include(".official-usage-workbench").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("cumulative-activity.png"), fullPage: true });

  await page.getByLabel("Observed activity on or after (UTC)").fill("2026-06-01");
  await page.getByLabel("Observed activity on or before (UTC)").fill("2026-07-15");
  await expect(rows.locator("tbody tr")).toHaveCount(1);
  await expect(rows).toContainText("June-only retained agent");
  await page.getByRole("button", { name: "Clear activity filters", exact: true }).click();
  await expect(rows.locator("tbody tr")).toHaveCount(3);
  const snapshotRead = page.waitForRequest(request => new URL(request.url()).pathname === "/api/official-usage/aggregate");
  await rows.getByRole("button", { name: "View source snapshot for June-only retained agent" }).click();
  expect(new URL((await snapshotRead).url()).searchParams.get("setId")).toBe(older.latestSetId);
  await expect(page).toHaveURL(new RegExp(`snapshot=${older.latestSetId}`));
  await expect(page.getByRole("alert")).toContainText("This source snapshot is temporarily unavailable.");
  await expect(page.getByRole("region", { name: "Agent comparison rows" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cumulative activity", exact: true }).click();
  await expect(page).toHaveURL(/\/official-usage$/);
  await expect(rows.locator("tbody tr")).toHaveCount(3);
  expect(unexpected).toEqual([]);
});

test("Agents shows independent inventory and activity cards without navigation shortcuts", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  await expect(overview.getByText("Agents in repository").locator("..")).toContainText("3");
  await expect(overview.getByText("Reported used agents").locator("..")).toContainText("2");
  await expect(overview.getByText("Reported active · 30 days").locator("..")).toContainText("2");
  await expect(overview.getByRole("link")).toHaveCount(0);
  await expect(overview.getByRole("button")).toHaveCount(2);
  await expect(overview).not.toContainText("not additive");
  await expect(overview).not.toContainText("Old imports");
  await expect(overview).toContainText("Partial data");
  expect((await new AxeBuilder({ page }).include(".agent-inventory-overview").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("inventory-overview.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});
