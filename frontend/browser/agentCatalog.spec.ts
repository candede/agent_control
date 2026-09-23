import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { matchesAgentView, summarizeAgentAvailability } from "../../backend/src/types/agentPresentation";
import { unifiedAgentViews } from "../../backend/src/types/unifiedAgents";
import type { AgentUsageContext, UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { usageInsightsPublished } from "../src/test/usageInsightsFixture";
import { automaticAgentUsageFixture, automaticUsageContext, automaticUsagePackageId, automaticUsageReportName } from "../src/test/automaticAgentUsageFixture";
import { agentColumns } from "../src/agentColumns";
import { usageCoverageLabel } from "../src/usageInsights";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

const usageContext: AgentUsageContext = {
  reportSet: usageInsightsPublished.activeSet, availability: "active", lineages: [], revision: "b".repeat(64),
};
const reportSetId = usageInsightsPublished.activeSet!.id;

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("repository cards filter actual end-user access and keep report dates in the existing toolbar", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const records = unifiedAgents.value.map((record, index): UnifiedAgentRecord => ({
    ...record,
    packages: record.packages.map(item => ({
      ...item, type: index === 0 ? "external" : "custom", isBlocked: false,
      availableTo: index === 0 ? "some" : index === 1 ? "none" : "unknown",
      supportedHosts: ["Copilot"],
    })),
  }));
  const queries: URLSearchParams[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const view = unifiedAgentViews.find(value => value === query.get("view")) ?? "all";
    const value = records.filter(record => matchesAgentView(record, view)
      && (!query.get("search") || record.displayName.includes(query.get("search")!)));
    return route.fulfill({ json: {
      ...unifiedAgents, value, count: value.length, inventoryOverview: summarizeAgentAvailability(records),
      usageContext: { ...usageContext, reportSet: {
        ...usageContext.reportSet!, reportingPeriod: { ...usageContext.reportSet!.reportingPeriod, provenance: "activity_range" },
      } },
    } });
  });
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  const table = page.getByRole("region", { name: "Unified agents" });
  await expect(overview.getByText("Agents in repository").locator("..")).toContainText("3");
  await expect(overview.getByText("Available to end users").locator("..")).toContainText("1");
  await expect(page.getByRole("combobox", { name: "Show agents" })).toHaveValue("all");
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill(records[1].displayName);
  await expect(table.getByRole("row")).toHaveCount(2);
  await overview.getByRole("button", { name: "Show available to end users", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/show=available/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Specific users or groups", exact: true })).toBeVisible();
  await expect.poll(() => queries.at(-1)?.get("view")).toBe("available");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Show agents" })).toHaveValue("available");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("unavailable");
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Not available", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("availability_unknown");
  await expect(table.getByRole("button", { name: records[2].displayName, exact: true })).toBeVisible();
  await overview.getByRole("button", { name: "Show agents in repository", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(page.getByRole("combobox", { name: "Show agents" })).toHaveValue("all");
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("checkbox", { name: "Responses", exact: true }).check();
  await page.keyboard.press("Escape");
  const toolbar = table.locator(".agent-grid-toolbar");
  await expect(toolbar).toContainText("Observed activity range:");
  await expect(toolbar.getByRole("button", { name: "Columns", exact: true })).toBeVisible();
  await expect(table.locator(".agent-usage-column-context")).toHaveCount(0);
  await expect(overview).not.toContainText("not additive");
  await expect(overview).not.toContainText("Old imports");
  expect((await new AxeBuilder({ page }).include(".agent-inventory-overview").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("repository-end-user-access.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("agent names keep link styling on hover and open details with the keyboard", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/agents");
  const name = page.getByRole("button", { name: "Service desk assistant", exact: true });
  await expect(name).toBeVisible();
  await name.scrollIntoViewIfNeeded();
  const color = await name.evaluate(element => getComputedStyle(element).color);
  const bounds = await name.boundingBox();
  await name.hover();
  await expect(name).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(name).toHaveCSS("color", color);
  await expect(name).toHaveCSS("text-decoration-line", "underline");
  expect(await name.boundingBox()).toEqual(bounds);
  await page.screenshot({ path: info.outputPath("agent-name-hover.png") });
  await name.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Service desk assistant" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(name).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("organization filters, server sorting and remembered columns stay usable and accessible", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const records = unifiedAgents.value.map((record, index): UnifiedAgentRecord => ({
    ...record,
    packages: record.packages.map(item => ({ ...item, type: index === 0 ? "custom" : index === 1 ? "external" : "microsoft" })),
    usage: {
      status: index === 1 ? "unlinked" : "linked", reportSetId, responses: index === 1 ? null : index === 0 ? 215 : 0,
      activeUsers: index === 1 ? null : 0, lastActivityDateUtc: null, associations: [],
    },
  }));
  const queries: URLSearchParams[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const view = unifiedAgentViews.find(value => value === query.get("view")) ?? "all";
    const value = records.filter(record => matchesAgentView(record, view));
    if (query.get("sortBy") === "responses") {
      value.sort((left, right) => (right.usage?.responses ?? -1) - (left.usage?.responses ?? -1));
    }
    return route.fulfill({ json: { ...unifiedAgents, usageContext, value, count: value.length } });
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  await expect(table.getByRole("row")).toHaveCount(4);
  const initialCatalogReads = queries.filter(query => !query.has("view")).length;
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("organization");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/show=organization/);
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("all");
  await expect(table.getByRole("row")).toHaveCount(4);
  expect(queries.filter(query => !query.has("view"))).toHaveLength(initialCatalogReads);

  await table.getByRole("button", { name: "Columns", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose agent columns" });
  await expect(picker.getByRole("searchbox", { name: "Find columns" })).toBeFocused();
  await expect(picker.getByRole("checkbox", { name: "Agent Always shown" })).toBeDisabled();
  await picker.getByRole("checkbox", { name: "Hosts", exact: true }).check();
  await picker.getByRole("checkbox", { name: "Responses", exact: true }).check();
  await picker.getByRole("checkbox", { name: "Environment", exact: true }).uncheck();
  expect((await new AxeBuilder({ page }).include(".agent-column-picker").analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(table.getByRole("button", { name: "Columns", exact: true })).toBeFocused();
  await table.getByRole("button", { name: "Sort by Responses" }).click();
  await expect.poll(() => queries.at(-1)?.get("sortBy")).toBe("responses");
  expect(queries.at(-1)?.get("sortDirection")).toBe("desc");
  await expect(table.getByRole("columnheader", { name: "Responses", exact: true })).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("responses:desc");
  await expect(table.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(1);
  await expect(table.getByRole("cell", { name: "0", exact: true })).toHaveCount(1);
  await expect(table.getByRole("cell", { name: "215", exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("configurable-agent-catalog.png"), fullPage: true });
  await page.reload();
  await expect(table.getByRole("columnheader", { name: "Hosts", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Responses", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Environment", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("used");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("unknown");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("server sorting preserves keyboard focus and blocks stale selection until the response arrives", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  let finishSort: (() => Promise<void>) | undefined;
  await page.route("**/api/agent-inventory?*", route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("sortDirection") === "desc") {
      finishSort = () => route.fulfill({ json: { ...unifiedAgents, value: [...unifiedAgents.value].reverse() } });
      return;
    }
    return route.fulfill({ json: unifiedAgents });
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  const heading = table.getByRole("button", { name: "Sort by Agent", exact: true });
  await heading.click();
  await expect.poll(() => Boolean(finishSort)).toBe(true);
  await expect(heading).toBeFocused();
  await expect(table.getByRole("checkbox").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export agent inventory CSV" })).toBeDisabled();
  await finishSort!();
  await expect(table.getByRole("checkbox").first()).toBeEnabled();
  await expect(heading).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(table.getByRole("columnheader", { name: "Agent", exact: true })).toHaveAttribute("aria-sort", "ascending");
  await expect(heading).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("all selectable columns and long saved values remain usable without page overflow", async ({ page }, info) => {
  test.setTimeout(60_000);
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const records = unifiedAgents.value.map(record => ({
    ...record, displayName: `${record.displayName} ${"long-saved-name-".repeat(16)}`,
    packages: record.packages.map(item => ({
      ...item, publisher: "Long saved publisher ".repeat(15), version: "2026.10.12345-preview.2",
      supportedHosts: ["Teams", "Microsoft 365", "Long saved host ".repeat(12)],
    })),
  }));
  await page.route("**/api/agent-inventory?*", route => route.fulfill({ json: { ...unifiedAgents, value: records } }));
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose agent columns" });
  for (const checkbox of await picker.getByRole("checkbox").all()) {
    if (await checkbox.isEnabled()) await checkbox.check();
  }
  await page.keyboard.press("Escape");
  await expect(table.getByRole("columnheader")).toHaveCount(agentColumns.length + 1);
  for (const width of info.project.name === "desktop" ? [768, 1440, 1920] : [360]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const scroll = await table.locator(".table-shell").evaluate(element => {
      element.scrollLeft = element.scrollWidth;
      return { left: element.scrollLeft, width: element.scrollWidth, viewport: element.clientWidth };
    });
    expect(scroll.width).toBeGreaterThan(scroll.viewport);
    expect(scroll.left).toBeGreaterThan(0);
    await expect(table.getByRole("button", { name: `View details for ${records[0].displayName}` })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`all-agent-columns-${width}.png`), fullPage: true });
  }
  expect((await new AxeBuilder({ page }).include(".agent-grid").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("exact saved-package matches show selected-report usage in the table and modal without manual association", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const record: UnifiedAgentRecord = {
    ...unifiedAgents.value[0], id: `graph_packages:${automaticUsagePackageId}`, displayName: "Excel",
    packages: [{ ...unifiedAgents.value[0].packages[0], id: automaticUsagePackageId, displayName: "Excel" }],
  };
  const zeroPackageId = "T_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const zeroRecord: UnifiedAgentRecord = {
    ...unifiedAgents.value[1], id: `graph_packages:${zeroPackageId}`, displayName: "No response agent",
    packages: [{ ...unifiedAgents.value[1].packages[0], id: zeroPackageId, displayName: "No response agent" }],
    usage: automaticAgentUsageFixture({
      responses: 0, activeUsers: 0, lastActivityDateUtc: null, associations: [{
        basis: "exact_package_id", reportAgentId: zeroPackageId, reportAgentName: "Zero response report identity",
        target: { source: "graph_packages", packageId: zeroPackageId },
      }],
    }),
  };
  const unmatchedRecord: UnifiedAgentRecord = {
    ...unifiedAgents.value[2], displayName: automaticUsageReportName,
    usage: { status: "unlinked", reportSetId, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [] },
  };
  const olderReportId = "33333333-3333-4333-8333-333333333333";
  let snapshot: "current" | "older" | "mismatched" | "unavailable" = "current";
  let candidateReads = 0;
  const mutations: string[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && /\/api\/(?:agent-inventory|official-usage)/.test(new URL(request.url()).pathname)) {
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  const context = (): AgentUsageContext => ({
    ...automaticUsageContext,
    availability: snapshot === "unavailable" ? "deleted" : snapshot === "older" ? "stale" : "active",
    reportSet: snapshot === "unavailable" ? null : {
      ...automaticUsageContext.reportSet!, id: snapshot === "current" ? reportSetId : olderReportId,
    },
  });
  const inventory = (): UnifiedAgentInventoryPage => ({
    ...unifiedAgents, revision: "a".repeat(64), count: 3, usageContext: context(),
    value: [{
      ...record,
      usage: automaticAgentUsageFixture(snapshot === "older" ? {
        reportSetId: olderReportId, responses: 179, associations: [{
          reportAgentId: automaticUsagePackageId, reportAgentName: "Excel", basis: "exact_package_id",
          target: { source: "graph_packages", packageId: automaticUsagePackageId },
        }],
      } : {}),
    }, zeroRecord, unmatchedRecord],
  });
  await page.route("**/api/agent-inventory**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/usage-candidates")) {
      candidateReads += 1;
      return route.fulfill({ json: { context: context(), value: [], count: 0, offset: 0, limit: 20 } });
    }
    if (url.pathname.endsWith("/usage-associations")) {
      return route.fulfill({ status: 405, json: { detail: "Automatic matching is read-only." } });
    }
    const data = inventory();
    if (url.searchParams.has("recordId")) {
      data.value = data.value.filter(item => item.id === url.searchParams.get("recordId"));
      data.count = data.value.length;
    }
    return route.fulfill({ json: data });
  });
  await page.route("**/api/agents/*", route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1)!);
    const item = inventory().value.flatMap(agent => agent.packages).find(item => item.id === id);
    return item ? route.fulfill({ json: item }) : route.fallback();
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose agent columns" });
  await picker.getByRole("checkbox", { name: "Responses", exact: true }).check();
  await picker.getByRole("checkbox", { name: "Active users", exact: true }).check();
  await page.keyboard.press("Escape");
  const excelRow = table.getByRole("row").filter({ has: page.getByRole("button", { name: "Excel", exact: true }) });
  const zeroRow = table.getByRole("row").filter({ has: page.getByRole("button", { name: zeroRecord.displayName, exact: true }) });
  const unmatchedRow = table.getByRole("row").filter({ has: page.getByRole("button", { name: unmatchedRecord.displayName, exact: true }) });
  await expect(excelRow.getByRole("cell", { name: "181", exact: true })).toBeVisible();
  await expect(excelRow.getByRole("cell", { name: "7", exact: true })).toBeVisible();
  await expect(zeroRow.getByRole("cell", { name: "0", exact: true })).toHaveCount(2);
  await expect(unmatchedRow.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(2);
  await expect(table.locator(".agent-grid-toolbar")).toContainText(usageCoverageLabel(automaticUsageContext.reportSet));
  await expect(table.getByText(/Report Agent IDs are matched automatically to exact saved package IDs/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("automatically-matched-agent-table.png"), fullPage: true });

  const listingUrl = page.url();
  async function closeDetails() {
    await page.getByRole("dialog").getByRole("button", { name: "Close unified agent details" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(listingUrl);
  }
  await table.getByRole("button", { name: record.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: record.displayName, exact: true });
  await dialog.getByRole("tab", { name: "Usage & users" }).click();
  await expect(dialog.getByLabel("Selected agent report metrics").getByText("181", { exact: true })).toBeVisible();
  await expect(dialog.getByText(automaticUsageReportName, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Automatically matched: exact report Agent ID = saved Graph package ID.")).toBeVisible();
  await expect(dialog.getByText(/Selected report snapshot:/)).toContainText(reportSetId);
  const usersUrl = new URL((await dialog.getByRole("link", { name: "View active users without paid Copilot", exact: true }).getAttribute("href"))!, "http://localhost");
  expect(usersUrl.searchParams.get("agent")).toBe(automaticUsagePackageId);
  expect(usersUrl.searchParams.get("snapshot")).toBe(reportSetId);
  await expect(dialog.getByRole("button", { name: "Associate a usage report" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Remove association/ })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Usage report candidates" })).toHaveCount(0);
  await expect(dialog.getByText(/administrator-reviewed/i)).toHaveCount(0);
  expect(candidateReads).toBe(0);
  expect(mutations).toHaveLength(0);
  expect((await new AxeBuilder({ page }).include(".unified-agent-detail-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("automatically-matched-agent-usage.png"), fullPage: true });
  await closeDetails();

  await table.getByRole("button", { name: unmatchedRecord.displayName, exact: true }).click();
  const unmatchedDialog = page.getByRole("dialog", { name: unmatchedRecord.displayName, exact: true });
  await unmatchedDialog.getByRole("tab", { name: "Usage & users" }).click();
  await expect(unmatchedDialog.getByRole("heading", { name: "No matched usage data for this agent" })).toBeVisible();
  await expect(unmatchedDialog.getByText(/Names alone are not used to match agents/)).toBeVisible();
  await expect(unmatchedDialog.getByRole("button", { name: "Associate a usage report" })).toHaveCount(0);
  await closeDetails();

  snapshot = "older";
  await page.reload();
  await expect(excelRow.getByRole("cell", { name: "179", exact: true })).toBeVisible();
  await expect(excelRow.getByRole("cell", { name: "360", exact: true })).toHaveCount(0);
  await table.getByRole("button", { name: record.displayName, exact: true }).click();
  await dialog.getByRole("tab", { name: "Usage & users" }).click();
  await expect(dialog.getByLabel("Selected agent report metrics").getByText("179", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Out-of-date report")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "View active users without paid Copilot", exact: true })).toHaveAttribute("href", new RegExp(`snapshot=${olderReportId}`));
  await closeDetails();

  for (const unavailableSnapshot of ["mismatched", "unavailable"] as const) {
    snapshot = unavailableSnapshot;
    await page.reload();
    await expect(excelRow.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(2);
    await table.getByRole("button", { name: record.displayName, exact: true }).click();
    await dialog.getByRole("tab", { name: "Usage & users" }).click();
    await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
    await expect(dialog.getByText(snapshot === "mismatched" ? /saved usage belongs to a different report snapshot/ : /No complete usable usage report is selected/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Associate a usage report" })).toHaveCount(0);
    await closeDetails();
  }
  expect(candidateReads).toBe(0);
  expect(mutations).toEqual([]);
  expect(unexpected).toEqual([]);
});
