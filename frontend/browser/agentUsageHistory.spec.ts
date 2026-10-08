import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { AgentUsageHistoryPoint, CandidateAgentUsageContext } from "../../backend/src/types/officialReportApi";
import type { UnifiedAgentInventoryPage } from "../../backend/src/types/unifiedAgents";
import { agentUsageHistoryFixture } from "../src/test/automaticAgentUsageFixture";
import { reportPage } from "../src/test/reportDataFixture";
import { selectedFixtureReports } from "../src/test/selectedUsageFixture";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { fulfillInventoryPage, inventoryFixtureSelection, isInventorySelectionRequest } from "./selectedInventoryFixture";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const missing of [false, true]) test(`read-only agent snapshot comparisons and Users discovery with latest usage ${missing ? "missing" : "reported"}`, async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const points: AgentUsageHistoryPoint[] = [200, 210, 195, missing ? null : 230].map((responses, index) => ({
    setId: `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}`,
    reportingStart: `2026-09-${String(index * 4 + 1).padStart(2, "0")}`,
    reportingEnd: `2026-10-${String(index * 4 + 1).padStart(2, "0")}`,
    periodProvenance: "activity_range", acceptedAt: `2026-10-${String(index * 4 + 1).padStart(2, "0")}T12:00:00Z`,
    responses, lastActivityDateUtc: responses === null ? null : `2026-10-${String(index * 4 + 1).padStart(2, "0")}T00:00:00.000Z`,
    status: responses === null ? "unlinked" : "linked", associationCount: responses === null ? 0 : 1,
  }));
  const latest = points.at(-1)!, shared = points[0];
  shared.acceptedAt = "2026-10-20T12:00:00Z";
  const metadata = (point: AgentUsageHistoryPoint) => ({ ...selectedFixtureReports, setId: point.setId, activeSetId: shared.setId,
    acceptedAt: point.acceptedAt,
    reportingPeriod: { startDate: point.reportingStart, endDate: point.reportingEnd, provenance: "activity_range" as const, days: 31 } });
  const record = { ...unifiedAgents.value[0], displayName: "Snapshot trend agent", usage: {
    recordId: unifiedAgents.value[0].id, status: shared.status, reportSetId: shared.setId, responses: shared.responses,
    activeUsers: 1, lastActivityDateUtc: shared.lastActivityDateUtc, associationCount: shared.associationCount,
  } };
  const inventory: UnifiedAgentInventoryPage = { ...unifiedAgents, value: [record],
    usageContext: { revision: "b".repeat(64), reports: metadata(shared), expiresAt: selectedFixtureReports.expiresAt } };
  const mutations: string[] = [], userReads: URLSearchParams[] = [];
  let historyReads = 0, summaryReads = 0;
  page.on("request", request => {
    if (request.method() !== "GET" && !isInventorySelectionRequest(request)
      && /\/api\/(?:agent-inventory|official-usage)/.test(new URL(request.url()).pathname)) mutations.push(request.url());
  });
  await page.route("**/api/agent-inventory?*", route => fulfillInventoryPage(route, inventory));
  await page.route(url => /^\/api\/agent-inventory\/[^/]+\/usage(?:-history|-associations|-users)?$/.test(url.pathname), route => {
    expect(route.request().method()).toBe("GET");
    const url = new URL(route.request().url()), pin = inventoryFixtureSelection(route);
    expect(url.searchParams.get("inventorySelectionId")).toBe(pin.id);
    const point = points.find(point => point.setId === url.searchParams.get("setId")) ?? shared;
    const context = (point: AgentUsageHistoryPoint): CandidateAgentUsageContext => ({
      selectionId: pin.id, reportSetId: point.setId, reports: metadata(point),
      inventoryRevision: inventory.selection.revision!, usageRevision: point.setId,
    });
    if (url.pathname.endsWith("/usage-history")) {
      historyReads++;
      return route.fulfill({ json: agentUsageHistoryFixture(context(shared), record.id, points,
        { limit: Number(url.searchParams.get("limit") ?? 50), cursor: url.searchParams.get("cursor") ?? undefined }) });
    }
    if (url.pathname.endsWith("/usage")) {
      expect(missing ? [latest.setId, points[2].setId] : [latest.setId]).toContain(url.searchParams.get("setId"));
      summaryReads++;
      return route.fulfill({ json: { recordId: record.id, status: point.status, responses: point.responses,
        activeUsers: point.responses === null ? null : 1, lastActivityDateUtc: point.lastActivityDateUtc, associationCount: point.associationCount, context: context(point) } });
    }
    if (url.pathname.endsWith("/usage-users")) {
      userReads.push(url.searchParams);
      return route.fulfill({ json: { ...reportPage([{ username: "history.user@example.invalid", displayName: "Historical report user", responses: point.responses ?? 0 }],
        { reports: metadata(point), selection: pin }), context: context(point) } });
    }
    return route.fulfill({ json: { value: [], context: context(point), counts: { total: 0, filtered: 0 },
      page: { limit: 50, nextCursor: null, previousCursor: null } } });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: record.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: record.displayName, exact: true });
  await dialog.getByRole("tab", { name: "Usage" }).click();
  await expect(page).toHaveURL(/detailTab=reports/);
  const trend = dialog.getByRole("region", { name: "Reported usage trend", exact: true });
  await expect(trend).toBeVisible();
  const snapshots = trend.getByRole("table", { name: "Report snapshots and changes in responses" });
  await expect(snapshots).toBeVisible();
  await expect(snapshots.getByRole("row")).toHaveCount(5);
  await expect(trend.locator("details")).toHaveCount(0);
  await expect(trend.getByRole("button")).toHaveCount(0);
  await expect(trend.getByRole("link")).toHaveCount(0);
  await expect(trend.locator("[tabindex], [aria-pressed], [data-selected]")).toHaveCount(0);
  await expect(trend.getByText("Viewing", { exact: true })).toHaveCount(0);
  await expect(trend.getByText(/Select a report date/)).toHaveCount(0);
  await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
  await expect(dialog.getByRole("searchbox", { name: "Search agent users" })).toHaveCount(0);
  await expect(dialog.getByLabel("CSV report dates")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "View this period" })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Usage not reported" })).toHaveCount(0);
  expect(userReads).toHaveLength(0);
  await expect(trend.locator(".trend-line")).toHaveCount(missing ? 2 : 3);
  if (!missing) await expect(trend).toContainText("Increasing: +35 responses (+17.9%)");
  const chart = trend.getByRole("img", { name: "Reported responses by report end date" });
  await snapshots.getByRole("rowheader").first().click();
  await chart.locator(".trend-dot").first().click();
  await expect(chart.locator(".trend-dot").first()).toHaveAttribute("r", "5");
  await expect(dialog.getByLabel("CSV report dates")).toHaveCount(0);
  expect(summaryReads).toBe(1);
  expect(userReads).toHaveLength(0);
  await expect(trend.getByText("Each point represents an uploaded report.", { exact: false })).toBeVisible();
  for (const width of info.project.name === "mobile" ? [320, 360] : [1086, 1440]) {
    await page.setViewportSize({ width, height: info.project.name === "mobile" ? 780 : 900 });
    for (const surface of [dialog, dialog.getByRole("tabpanel"), trend, snapshots.locator(".."), snapshots]) {
      expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await expect(width <= 640 ? snapshots.locator(".agent-trend-cell-label").nth(1)
      : snapshots.getByRole("columnheader", { name: "Change" })).toBeVisible();
    const responseLabel = width <= 640 ? snapshots.locator(".agent-trend-cell-label").first()
      : snapshots.getByRole("columnheader", { name: "Responses" });
    await expect(responseLabel).toBeVisible();
    for (const label of [...await dialog.getByRole("tab").all(), responseLabel]) {
      const geometry = await label.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const style = getComputedStyle(element);
        return { text: element.textContent, lines: range.getClientRects().length,
          contentWidth: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          fits: element.scrollWidth <= element.clientWidth + 1 };
      });
      expect(geometry.lines, `${geometry.text} wraps at ${width}px with ${geometry.contentWidth}px available`).toBe(1);
      expect(geometry.fits).toBe(true);
    }
    const tableBounds = await snapshots.boundingBox(), panelBounds = await dialog.getByRole("tabpanel").boundingBox();
    expect(tableBounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
    expect(tableBounds!.x + tableBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await snapshots.scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: info.outputPath("usage-snapshot-table.png") });
  await dialog.getByRole("tabpanel").evaluate(element => { element.scrollTop = 0; });
  await dialog.screenshot({ path: info.outputPath("usage-trend.png") });
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.getByRole("tab", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/detailTab=users/);
  await expect(trend).toHaveCount(0);
  if (missing) {
    await expect(dialog.getByRole("heading", { name: "Usage not reported" })).toBeVisible();
    await expect(dialog.getByText("This agent is not included in the latest CSV report.")).toBeVisible();
    await expect(dialog.getByLabel("CSV report dates")).toContainText("Latest report datesSep 13, 2026");
    await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Reload usage", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "View this period" }).click();
  }
  await expect(dialog.getByLabel("Selected agent report metrics")).toContainText(missing ? "195" : "230");
  await expect(dialog.getByLabel("Selected agent report metrics")).toContainText(`Last reported activityOct ${missing ? 9 : 13}, 2026`);
  await expect(dialog.getByLabel("CSV report dates")).toContainText(missing ? "Sep 9, 2026" : "Sep 13, 2026");
  await expect(dialog.getByText("Historical report user", { exact: true })).toBeVisible();
  expect(userReads.at(-1)?.get("setId")).toBe(missing ? points[2].setId : latest.setId);
  await dialog.screenshot({ path: info.outputPath("users-selected-period.png") });
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.getByRole("tab", { name: "Usage", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(snapshots).toBeVisible();
  await expect(dialog.getByLabel("CSV report dates")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Return to latest report" })).toHaveCount(0);
  await expect(dialog.getByText(/Viewing a historical period/)).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Usage", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Users", exact: true })).toBeFocused();
  await expect(dialog.getByLabel("Selected agent report metrics")).toContainText(missing ? "195" : "230");
  expect(userReads.at(-1)?.get("setId")).toBe(missing ? points[2].setId : latest.setId);
  expect(historyReads).toBe(1);
  if (missing) {
    await dialog.getByRole("button", { name: "Return to latest report" }).click();
    await expect(dialog.getByRole("heading", { name: "Usage not reported" })).toBeVisible();
    await expect(dialog.getByLabel("CSV report dates")).toContainText("Latest report datesSep 13, 2026");
  } else await expect(dialog.getByRole("button", { name: "Return to latest report" })).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(unexpected).toEqual([]);
});
