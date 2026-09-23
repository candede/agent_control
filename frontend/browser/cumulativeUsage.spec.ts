import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { usageOverviewFixture } from "../src/test/usageInsightsFixture";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

async function mockRetainedOverview(page: Page, data: ReturnType<typeof usageOverviewFixture>) {
  const requests: URLSearchParams[] = [];
  await page.route("**/api/official-usage/overview?*", route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const matching = data.agents.value.filter(agent => (!params.get("search") || `${agent.agentId} ${agent.agentName}`.toLowerCase().includes(params.get("search")!.toLowerCase()))
      && (!params.get("startDate") || Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc.slice(0, 10) >= params.get("startDate")!))
      && (!params.get("endDate") || Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc.slice(0, 10) <= params.get("endDate")!)));
    const sortBy = params.get("sortBy") === "agentName" ? "agentName" : "lastActivityDateUtc";
    const direction = params.get("sortDirection") === "asc" ? 1 : -1;
    matching.sort((a, b) => {
      const left = a[sortBy], right = b[sortBy];
      if (left === null || right === null) return left === right ? a.agentId.localeCompare(b.agentId) : left === null ? 1 : -1;
      return direction * left.localeCompare(right) || a.agentId.localeCompare(b.agentId);
    });
    const limit = Number(params.get("limit") ?? 25), offset = Number(params.get("offset") ?? 0);
    return route.fulfill({ json: { ...data, agents: {
      value: matching.slice(offset, offset + limit), count: matching.length, limit, offset,
    } } });
  });
  return requests;
}

test("Manage reports lazily opens the retained-agent locator without cumulative headline metrics", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const data = usageOverviewFixture();
  const older = {
    ...data.agents.value[0], agentId: "june-only-agent", agentName: "June-only retained agent",
    lastActivityDateUtc: "2026-06-01", latestSetId: "99999999-9999-4999-8999-999999999999",
  };
  data.agents.value.push(older);
  data.agents.count += 1;
  data.summary = { ...data.summary, retainedSets: 2, reportedAgents: 3, usedAgents: 3, earliestActivityDateUtc: "2026-06-01" };
  const overviewReads = await mockRetainedOverview(page, data);
  await page.route(url => url.pathname === "/api/official-usage/aggregate" && url.searchParams.get("setId") === older.latestSetId,
    route => route.fulfill({ status: 503, json: { detail: "This source snapshot is temporarily unavailable.", code: "synthetic_snapshot_unavailable" } }));
  const reads: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/official-usage/aggregate") reads.push(request.url()); });
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(modal.getByRole("region", { name: "Retained official usage snapshots" })).toBeVisible();
  const locatorToggle = modal.getByText("Find an agent across reports", { exact: true });
  await expect(locatorToggle).toBeVisible();
  const rows = page.getByRole("region", { name: "Retained agent activity rows" });
  await expect(rows).toHaveCount(0);
  expect(overviewReads).toEqual([]);
  await locatorToggle.focus();
  await page.keyboard.press("Enter");
  await expect(rows.locator("tbody tr")).toHaveCount(3);
  await expect(modal.getByRole("region", { name: "Retained activity summary" })).toHaveCount(0);
  await expect(modal.locator(".cumulative-agent-activity .metric")).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Cumulative activity", exact: true })).toHaveCount(0);
  await expect(rows.getByRole("row", { name: /June-only retained agent/ })).toBeVisible();
  await expect(rows.getByRole("rowheader").first()).toHaveCSS("text-transform", "none");
  await expect(rows.getByRole("rowheader").first().locator("small")).toHaveCSS("text-transform", "none");
  await expect(page.getByText(/Overlapping response totals are not added/)).toBeVisible();
  await expect(rows.getByRole("columnheader", { name: "Responses", exact: true })).toHaveCount(0);
  expect(reads).toEqual([]);
  await rows.getByRole("button", { name: "View source snapshot for June-only retained agent" }).scrollIntoViewIfNeeded();
  await expect(rows.getByRole("button", { name: "View source snapshot for June-only retained agent" })).toBeInViewport({ ratio: 1 });
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("cumulative-activity.png"), fullPage: true });

  await page.getByLabel("Observed activity on or after (UTC)").fill("2026-06-01");
  await page.getByLabel("Observed activity on or before (UTC)").fill("2026-07-15");
  await expect(rows.locator("tbody tr")).toHaveCount(1);
  await expect(rows).toContainText("June-only retained agent");
  await page.getByLabel("Search retained agents", { exact: true }).fill("june-only-agent");
  await page.getByRole("combobox", { name: "Order retained agents", exact: true }).selectOption("name");
  const snapshotRead = page.waitForRequest(request => new URL(request.url()).pathname === "/api/official-usage/aggregate");
  await rows.getByRole("button", { name: "View source snapshot for June-only retained agent" }).click();
  const sourceParams = new URL((await snapshotRead).url()).searchParams;
  expect(sourceParams.get("setId")).toBe(older.latestSetId);
  expect(sourceParams.get("activityWindowDays")).toBe("365");
  await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${older.latestSetId}$`));
  await expect(page.getByRole("alert")).toContainText("This source snapshot is temporarily unavailable.");
  await expect(page.getByRole("status").filter({ hasText: "Retained set unavailable" })).toContainText(older.latestSetId);
  await expect(page.getByRole("region", { name: "Report agent rows" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  await expect(modal).toBeVisible();
  await expect(rows.locator("tbody tr")).toHaveCount(1);
  await expect(page.getByLabel("Search retained agents", { exact: true })).toHaveValue("june-only-agent");
  await expect(page.getByRole("combobox", { name: "Order retained agents", exact: true })).toHaveValue("name");
  await expect(page.getByLabel("Observed activity on or after (UTC)")).toHaveValue("2026-06-01");
  await expect(page.getByLabel("Observed activity on or before (UTC)")).toHaveValue("2026-07-15");
  await page.getByRole("button", { name: "Clear activity filters", exact: true }).click();
  await expect(rows.locator("tbody tr")).toHaveCount(3);
  await locatorToggle.click();
  await expect(rows).toHaveCount(0);
  const readsWhenCollapsed = overviewReads.length;
  await modal.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(modal.getByRole("button", { name: "Refresh history", exact: true })).toBeEnabled();
  expect(overviewReads).toHaveLength(readsWhenCollapsed);
  expect(unexpected).toEqual([]);
});

test("the retained-agent locator preserves search, server sort and paging", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const data = usageOverviewFixture();
  data.agents.value = Array.from({ length: 31 }, (_, index) => ({
    ...data.agents.value[0], agentId: `report-only-${index}`,
    agentName: `Retained agent ${String(index).padStart(2, "0")}`,
    lastActivityDateUtc: `2026-08-${String(index + 1).padStart(2, "0")}`,
  }));
  data.agents.count = 31;
  data.summary.reportedAgents = 31;
  const reads = await mockRetainedOverview(page, data);
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await modal.getByText("Find an agent across reports", { exact: true }).click();
  const rows = modal.getByRole("region", { name: "Retained agent activity rows" });
  await expect(rows.locator("tbody tr")).toHaveCount(25);
  await expect(rows.locator("tbody tr").first()).toContainText("Retained agent 30");
  const pagination = modal.getByRole("navigation", { name: "Retained agent pages" });
  await pagination.getByRole("button", { name: "Next retained agents", exact: true }).click();
  await expect(rows.locator("tbody tr")).toHaveCount(6);
  await expect(pagination).toContainText("26-31 of 31 agents");
  expect(reads.at(-1)?.get("offset")).toBe("25");
  const sort = rows.getByRole("button", { name: "Sort by Agent", exact: true });
  await sort.focus();
  await sort.press("Enter");
  await expect(rows.locator("tbody tr").first()).toContainText("Retained agent 00");
  await expect(sort).toBeFocused();
  await expect(rows.getByRole("columnheader", { name: "Agent", exact: true })).toHaveAttribute("aria-sort", "ascending");
  expect(reads.at(-1)?.get("offset")).toBe("0");
  expect(reads.at(-1)?.get("sortBy")).toBe("agentName");
  expect(reads.at(-1)?.get("sortDirection")).toBe("asc");
  await modal.getByLabel("Search retained agents", { exact: true }).fill("report-only-30");
  await expect(rows.locator("tbody tr")).toHaveCount(1);
  await expect(rows).toContainText("Retained agent 30");
  await expect(pagination).toContainText("1-1 of 1 agents");
  expect(reads.at(-1)?.get("search")).toBe("report-only-30");
  await modal.getByRole("button", { name: "Clear activity filters", exact: true }).click();
  await expect(rows.locator("tbody tr")).toHaveCount(25);
  await expect(modal.getByRole("region", { name: "Retained activity summary" })).toHaveCount(0);
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
