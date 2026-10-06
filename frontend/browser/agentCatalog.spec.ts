import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { agentManagement, agentUserAvailability, matchesAgentView } from "../../backend/src/types/agentPresentation";
import { formatPackageType } from "../../backend/src/types/copilotPackage";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import type { InventoryReportContext } from "../../backend/src/types/unifiedAgents";
import type { ReportRelationship } from "../../backend/src/types/officialReportData";
import { selectedFixtureReports } from "../src/test/selectedUsageFixture";
import { automaticAgentUsageFixture, automaticUsageContext, automaticUsagePackageId, automaticUsageReportName } from "../src/test/automaticAgentUsageFixture";
import { agentColumns } from "../src/agentColumns";
import { usageCoverageLabel } from "../src/usageInsights";
import { layoutTime, mockLayoutApi, unifiedAgents, mockInventoryFacets } from "./layoutFixtures";
import { mockSelectedInventoryUsage } from "./selectedInventoryUsageFixture";
import { encodeInventoryFacet } from "../../backend/src/types/inventoryFacets";
import { fulfillInventoryPage, inventoryFixtureFacet, inventoryFixtureQuery, isInventorySelectionRequest } from "./selectedInventoryFixture";

const usageContext: InventoryReportContext = {
  reports: selectedFixtureReports, expiresAt: selectedFixtureReports.expiresAt, revision: "b".repeat(64),
};
const reportSetId = selectedFixtureReports.setId!;

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("inventory pagination has spaced secondary controls and responsive first/last page states", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const reads: URLSearchParams[] = [];
  let releaseNextPage!: () => void;
  const nextPageReady = new Promise<void>(resolve => { releaseNextPage = resolve; });
  await page.route("**/api/agent-inventory?*", async route => {
    const query = inventoryFixtureQuery(route);
    reads.push(query);
    const last = query.get("cursor") === "last-inventory-page";
    if (last) await nextPageReady;
    return fulfillInventoryPage(route, {
      ...unifiedAgents,
      value: unifiedAgents.value.slice(last ? 2 : 0, last ? 3 : 2),
      counts: { ...unifiedAgents.counts, total: 12_345, scoped: 12_345, filtered: 12_345 },
      page: { limit: 50, previousCursor: last ? "first-inventory-page" : null, nextCursor: last ? null : "last-inventory-page" },
    });
  });
  await page.goto("/agents");
  const navigation = page.getByRole("navigation", { name: "Agent inventory pages" });
  const previous = navigation.getByRole("button", { name: "Previous", exact: true });
  const next = navigation.getByRole("button", { name: "Next", exact: true });
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await navigation.scrollIntoViewIfNeeded();
  const geometry = await navigation.evaluate(element => {
    const previous = element.querySelector("button:first-of-type")!;
    const next = element.querySelector("button:last-of-type")!;
    const count = element.querySelector("span")!.getBoundingClientRect();
    const box = element.getBoundingClientRect(), left = previous.getBoundingClientRect(), right = next.getBoundingClientRect();
    return {
      display: getComputedStyle(element).display,
      gap: right.left - left.right,
      topPadding: Math.min(count.top, left.top) - box.top,
      bottomPadding: box.bottom - Math.max(count.bottom, left.bottom),
      leftPadding: count.left - box.left,
      rightPadding: box.right - right.right,
      countSeparated: count.right + 8 <= left.left || count.bottom + 8 <= left.top,
      buttonHeight: Math.min(left.height, right.height),
      secondary: previous.classList.contains("secondary") && next.classList.contains("secondary"),
      disabledOpacity: Number(getComputedStyle(previous).opacity),
      enabledOpacity: Number(getComputedStyle(next).opacity),
      background: getComputedStyle(next).backgroundColor,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(geometry.display).toBe("flex");
  expect(geometry.gap).toBeGreaterThanOrEqual(8);
  expect(geometry.topPadding).toBeGreaterThanOrEqual(10);
  expect(geometry.bottomPadding).toBeGreaterThanOrEqual(10);
  expect(geometry.leftPadding).toBeGreaterThanOrEqual(12);
  expect(geometry.rightPadding).toBeGreaterThanOrEqual(12);
  expect(geometry.countSeparated).toBe(true);
  expect(geometry.buttonHeight).toBeGreaterThanOrEqual(36);
  expect(geometry.secondary).toBe(true);
  expect(geometry.disabledOpacity).toBeLessThan(geometry.enabledOpacity);
  expect(geometry.background).toBe("rgb(255, 255, 255)");
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  await expect(navigation).toContainText("2 shown · 12,345 matching agents");
  await page.screenshot({ path: info.outputPath("inventory-pagination.png"), fullPage: true });
  const selectionId = reads.at(-1)!.get("selectionId");
  try {
    await next.click();
    await expect(navigation).toHaveAttribute("aria-busy", "true");
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
  } finally { releaseNextPage(); }
  await expect(navigation).toHaveAttribute("aria-busy", "false");
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await expect(navigation).toContainText("1 shown · 12,345 matching agents");
  await previous.click();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  expect(reads.filter(query => query.has("cursor")).map(query => query.get("selectionId"))).toEqual([selectionId, selectionId]);
  expect(unexpected).toEqual([]);
});

test("default columns group identity, usage and access and preserve saved selections until reset", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const defaults = ["Select agents", "Agent", "Publisher", "Built with", "Responses", "End-user access", "Status", "Actions"];
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  await expect(table.getByRole("columnheader")).toHaveText(defaults);
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose agent columns" });
  await picker.getByRole("checkbox", { name: "Publisher", exact: true }).uncheck();
  await picker.getByRole("checkbox", { name: "Environment", exact: true }).check();
  await picker.getByRole("checkbox", { name: "Created by", exact: true }).check();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(table.getByRole("columnheader", { name: "Publisher", exact: true })).toHaveCount(0);
  await expect(table.getByRole("columnheader", { name: "Environment", exact: true })).toHaveCount(1);
  await expect(table.getByRole("columnheader", { name: "Created by", exact: true })).toHaveCount(1);
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  await picker.getByRole("button", { name: "Reset defaults", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(table.getByRole("columnheader")).toHaveText(defaults);
  await page.reload();
  await expect(table.getByRole("columnheader")).toHaveText(defaults);
  expect((await new AxeBuilder({ page }).include(".agent-grid").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("agent-default-columns.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("Graph package categories use provider values and combine with independent filters", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const makeRecord = (id: string, displayName: string, fields: Partial<UnifiedAgentRecord["packages"][number]>): UnifiedAgentRecord => ({
    ...unifiedAgents.value[0], id: `graph_packages:${id}`, displayName,
    packages: [{
      ...unifiedAgents.value[0].packages[0], id, displayName, authoringTool: null, platform: undefined, shortDescription: undefined,
      availableTo: "none", deployedTo: "none", ...fields,
    }],
  });
  const records = [
    makeRecord("first", "Researcher", { type: "firstParty" }),
    makeRecord("vendor", "Vendor agent", { type: "thirdParty" }),
    makeRecord("personal", "Personal agent", { type: "shared", authoringTool: "Copilot Studio Lite" }),
    makeRecord("studio", "Studio agent", { type: "lob", authoringTool: "Copilot Studio" }),
    { ...makeRecord("managed", "Managed vendor", {
      type: "thirdParty", availableTo: "some",
      controlObservations: { access: { snapshotId: "verified-control", observedAt: layoutTime, expiresAt: "2027-01-01T00:00:00.000Z" } },
    }), usage: automaticAgentUsageFixture() },
    makeRecord("unknown", "Unknown origin", { type: "unknownFutureValue", publisher: "Microsoft", authoringTool: "Microsoft 365 Copilot Agent Builder" }),
  ];
  const summary = { ...unifiedAgents.summary, total: records.length, graphOnly: records.length };
  const types = [...new Set(records.flatMap(record => record.packages.flatMap(item => item.type ? [item.type] : [])))]
    .map(value => ({ value, label: formatPackageType(value) })).sort((a, b) => a.label.localeCompare(b.label));
  const queries: URLSearchParams[] = [];
  await mockInventoryFacets(page, { type: types });
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    queries.push(query);
    const type = inventoryFixtureFacet(query, "type"), management = query.get("management");
    const value = records.filter(record => (type === undefined || record.packages.some(item => item.type === type))
      && (!management || management === "all" || agentManagement(record) === management)
      && (query.get("reportedUsage") !== "used" || matchesAgentView(record, "used")));
    return fulfillInventoryPage(route, {
      ...unifiedAgents, value, counts: { total: records.length, scoped: records.length, filtered: value.length, packageTargets: records.length },
      summary, scopeSummary: summary,
      inventoryOverview: { availableToUsers: 1, organizationCreated: 1, teamsAvailable: 1, createdOrAvailable: 2 },
      usageContext: automaticUsageContext,
    });
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  const view = page.getByRole("combobox", { name: "Show agents", exact: true });
  await expect(table.getByRole("row")).toHaveCount(7);
  await expect(view.locator("option")).toHaveText([
    "All agents", "1st party agents", "3rd party agents", "Built by your org", "Shared in your organization", "unknownFutureValue",
  ]);
  for (const [value, names] of [
    ["firstParty", ["Researcher"]], ["thirdParty", ["Vendor agent", "Managed vendor"]],
    ["shared", ["Personal agent"]], ["lob", ["Studio agent"]], ["unknownFutureValue", ["Unknown origin"]],
  ] as const) {
    await view.selectOption(encodeInventoryFacet(value));
    await expect.poll(() => queries.at(-1)?.get("type")).toBe(encodeInventoryFacet(value));
    expect(queries.at(-1)?.has("view")).toBe(false);
    await expect(table.getByRole("row")).toHaveCount(names.length + 1);
    for (const name of names) await expect(table.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await view.selectOption(encodeInventoryFacet("thirdParty"));
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Management", exact: true }).selectOption("organization_managed");
  await page.getByRole("combobox", { name: "Reported usage", exact: true }).selectOption("used");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/type=%7Estring%3AthirdParty&usage=used&management=organization_managed/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: "Managed vendor", exact: true })).toBeVisible();
  await page.reload();
  await expect(view).toHaveValue(encodeInventoryFacet("thirdParty"));
  await expect(page.getByRole("button", { name: "Filters, 2 active", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Managed vendor", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Filters, 2 active", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Management", exact: true })).toHaveValue("organization_managed");
  expect((await new AxeBuilder({ page }).include(".agent-grid-toolbar").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agent-quick-views-and-filters.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Management", exact: true }).selectOption("unknown");
  await page.keyboard.press("Escape");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("button", { name: "Unknown origin", exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: "Personal agent", exact: true })).toHaveCount(0);
  await expect(table.getByRole("button", { name: "Managed vendor", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(unexpected).toEqual([]);
});

test("repository cards filter actual end-user access and keep report dates in the overview", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const records = unifiedAgents.value.map((record, index): UnifiedAgentRecord => ({
    ...record,
    packages: record.packages.map(item => ({
      ...item, type: index === 0 ? "thirdParty" : "lob", isBlocked: false,
      availableTo: index === 0 ? "some" : index === 1 ? "none" : "unknown",
      supportedHosts: ["Copilot"],
    })),
  }));
  const queries: URLSearchParams[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    queries.push(query);
    const access = query.get("endUserAccess");
    const value = records.filter(record => (!access || access === "all" || agentUserAvailability(record) === access)
      && (!query.get("search") || record.displayName.includes(query.get("search")!)));
    return fulfillInventoryPage(route, {
      ...unifiedAgents, value, counts: { total: records.length, scoped: records.length, filtered: value.length, packageTargets: records.length },
      inventoryOverview: { availableToUsers: 1, organizationCreated: 2, teamsAvailable: 0, createdOrAvailable: 2 },
      usageContext: { ...usageContext, reports: {
        ...usageContext.reports, reportingPeriod: { ...usageContext.reports.reportingPeriod!, provenance: "activity_range" },
      } },
    });
  });
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  const table = page.getByRole("region", { name: "Unified agents" });
  await expect(overview.getByText("Agents in catalog").locator("..")).toContainText("3");
  await expect(overview.getByText("Available to end users").locator("..")).toContainText("1");
  await expect(page.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill(records[1].displayName);
  await expect(table.getByRole("row")).toHaveCount(2);
  await overview.getByRole("button", { name: "Show available to end users", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search", exact: true })).toHaveValue(records[1].displayName);
  await expect(page).toHaveURL(/access=available/);
  await expect.poll(() => queries.at(-1)?.get("endUserAccess")).toBe("available");
  expect(queries.at(-1)?.get("search")).toBe(records[1].displayName);
  await page.getByRole("searchbox", { name: "Search", exact: true }).fill("");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Specific users or groups", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("button", { name: "Filters, 1 active", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "End-user access", exact: true })).toHaveValue("available");
  await page.getByRole("combobox", { name: "End-user access", exact: true }).selectOption("unavailable");
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toBeVisible();
  await expect(table.getByRole("cell", { name: "Not available", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "End-user access", exact: true }).selectOption("unknown");
  await expect(table.getByRole("button", { name: records[2].displayName, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await overview.getByRole("button", { name: "Show agents in catalog", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(page.getByRole("combobox", { name: "Show agents" })).toHaveValue("");
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("checkbox", { name: "Responses", exact: true }).check();
  await page.keyboard.press("Escape");
  const toolbar = table.locator(".agent-grid-toolbar");
  await expect(toolbar).not.toContainText("Observed activity range:");
  await expect(overview.getByRole("combobox", { name: "Report set", exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Columns", exact: true })).toBeVisible();
  await expect(table.locator(".agent-usage-column-context")).toHaveCount(0);
  await expect(overview).not.toContainText("not additive");
  await expect(overview).not.toContainText("Old imports");
  expect((await new AxeBuilder({ page }).include(".agent-inventory-overview").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("repository-end-user-access.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("reported used agents card filters the catalog and stays synchronized with the saved view", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const records = unifiedAgents.value.map((record, index): UnifiedAgentRecord => ({
    ...record,
    packages: record.packages.map(item => ({ ...item, type: index === 2 ? "firstParty" : "thirdParty" })),
    usage: index === 2 ? undefined : automaticAgentUsageFixture({ responses: index === 0 ? 181 : 0 }),
  }));
  const queries: URLSearchParams[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    queries.push(query);
    const type = inventoryFixtureFacet(query, "type");
    const value = records.filter(record => (type === undefined || record.packages.some(item => item.type === type))
      && (query.get("reportedUsage") !== "used" || matchesAgentView(record, "used"))
      && (!query.get("search") || record.displayName.includes(query.get("search")!)));
    return fulfillInventoryPage(route, {
      ...unifiedAgents, value, counts: { total: records.length, scoped: records.length, filtered: value.length, packageTargets: records.length },
      usageContext: automaticUsageContext,
    });
  });
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  const used = overview.getByRole("button", { name: "Show reported used agents", exact: true });
  const table = page.getByRole("region", { name: "Unified agents" });
  const showAgents = page.getByRole("combobox", { name: "Show agents" });
  const search = page.getByRole("searchbox", { name: "Search", exact: true });
  await expect(used).toBeEnabled();
  await expect(used).toHaveAttribute("aria-pressed", "false");
  await showAgents.selectOption(encodeInventoryFacet("thirdParty"));
  await search.fill(records[0].displayName);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await used.focus();
  await page.keyboard.press("Enter");
  await expect(showAgents).toHaveValue(encodeInventoryFacet("thirdParty"));
  await expect(used).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue(records[0].displayName);
  await expect(page).toHaveURL(/type=%7Estring%3AthirdParty&usage=used/);
  await expect.poll(() => queries.at(-1)?.get("reportedUsage")).toBe("used");
  expect(queries.at(-1)?.get("type")).toBe(encodeInventoryFacet("thirdParty"));
  expect(queries.at(-1)?.get("inventoryScope")).toBe("catalog");
  expect(queries.at(-1)?.get("search")).toBe(records[0].displayName);
  await search.fill("");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toHaveCount(0);
  await expect(table.getByRole("button", { name: records[2].displayName, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(showAgents).toHaveValue(encodeInventoryFacet("thirdParty"));
  await expect(used).toHaveAttribute("aria-pressed", "true");
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await used.click();
  await expect(used).toHaveAttribute("aria-pressed", "false");
  await expect(showAgents).toHaveValue(encodeInventoryFacet("thirdParty"));
  await expect(table.getByRole("row")).toHaveCount(3);
  await used.click();
  await expect(table.getByRole("row")).toHaveCount(2);
  expect((await new AxeBuilder({ page }).include(".agent-inventory-overview").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("reported-used-agents-filter.png"), fullPage: true });
  await overview.getByRole("button", { name: "Show agents in catalog", exact: true }).click();
  await expect(showAgents).toHaveValue("");
  await expect(used).toHaveAttribute("aria-pressed", "false");
  await expect(table.getByRole("row")).toHaveCount(4);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Reported usage", exact: true }).selectOption("used");
  await page.keyboard.press("Escape");
  await expect(used).toHaveAttribute("aria-pressed", "true");
  await expect(table.getByRole("row")).toHaveCount(2);
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
  await expect(page.getByRole("dialog", { name: "Service desk assistant" })).toHaveCount(0);
  await expect(name).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("party filters, server sorting and remembered columns stay usable and accessible", async ({ page }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const records = unifiedAgents.value.map((record, index): UnifiedAgentRecord => ({
    ...record,
    packages: record.packages.map(item => ({ ...item, type: index === 1 ? "thirdParty" : "firstParty" })),
    usage: {
      status: index === 1 ? "unlinked" : "linked", reportSetId, responses: index === 1 ? null : index === 0 ? 215 : 0,
      recordId: record.id, activeUsers: index === 1 ? null : 0, lastActivityDateUtc: null, associationCount: index === 1 ? 0 : 1,
    },
  }));
  const queries: URLSearchParams[] = [];
  const cacheReads: Array<{ phase: string; parameters: Record<string, string> }> = [];
  let phase = "initial";
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    queries.push(query);
    cacheReads.push({ phase, parameters: Object.fromEntries(query) });
    const type = inventoryFixtureFacet(query, "type");
    const value = records.filter(record => (type === undefined || record.packages.some(item => item.type === type))
      && (query.get("reportedUsage") !== "used" || matchesAgentView(record, "used"))
      && (query.get("relevance") !== "unknown" || matchesAgentView(record, "unknown")));
    if (query.get("sortBy") === "responses") {
      value.sort((left, right) => (right.usage?.responses ?? -1) - (left.usage?.responses ?? -1));
    }
    return fulfillInventoryPage(route, { ...unifiedAgents, usageContext, value, counts: { ...unifiedAgents.counts, filtered: value.length } });
  });
  // Initial source revision discovery invalidates inventory caches; settle it before measuring reuse.
  await page.goto("/sync");
  await expect(page.getByRole("button", { name: "Permissions", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("region", { name: "Automatic refresh", exact: true })).toContainText("Automatic refresh · On");
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Agents", exact: true }).click();
  const table = page.getByRole("region", { name: "Unified agents" });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(page.locator(".agent-table-stack")).toHaveAttribute("aria-busy", "false");
  const initialCatalogReads = queries.filter(query => !query.has("type")).length;
  phase = "first-party";
  await page.getByRole("combobox", { name: "Show agents" }).selectOption(encodeInventoryFacet("firstParty"));
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/type=%7Estring%3AfirstParty/);
  phase = "return-all";
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("");
  await expect(table.getByRole("row")).toHaveCount(4);
  await info.attach("agent-view-cache-requests", {
    body: JSON.stringify({ initialCatalogReads, cacheReads }, null, 2), contentType: "application/json",
  });
  const returned = queries.filter(query => !query.has("type"));
  expect(returned).toHaveLength(initialCatalogReads + 1);
  expect(returned.at(-1)!.get("selectionId")).not.toBe(returned[0].get("selectionId"));

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
  const filters = table.getByRole("button", { name: "Filters", exact: true });
  await expect(filters).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("combobox", { name: "Sort", exact: true })).toHaveCount(0);
  await filters.click();
  await expect(page.getByRole("dialog", { name: "Filter agents" }).getByRole("combobox", { name: "Sort", exact: true })).toHaveValue("responses:desc");
  await page.keyboard.press("Escape");
  await expect(filters).toBeFocused();
  await expect(table.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(1);
  await expect(table.getByRole("cell", { name: "0", exact: true })).toHaveCount(1);
  await expect(table.getByRole("cell", { name: "215", exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("configurable-agent-catalog.png"), fullPage: true });
  await page.reload();
  await expect(table.getByRole("columnheader", { name: "Hosts", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Responses", exact: true })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Environment", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Reported usage", exact: true }).selectOption("used");
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Reported usage", exact: true }).selectOption("all");
  await page.getByRole("combobox", { name: "Organization/usage evidence", exact: true }).selectOption("unknown");
  await page.keyboard.press("Escape");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("server sorting uses a fixed refresh indicator without shifting the page or losing keyboard focus", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  let finishSort: (() => Promise<void>) | undefined;
  await page.route("**/api/agent-inventory?*", route => {
    const query = inventoryFixtureQuery(route);
    if (query.get("sortDirection") === "desc") {
      finishSort = () => fulfillInventoryPage(route, { ...unifiedAgents, value: [...unifiedAgents.value].reverse() });
      return;
    }
    return fulfillInventoryPage(route, unifiedAgents);
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  await expect(overview.getByText("Reported used agents").locator("..")).toContainText("2");
  const heading = table.getByRole("button", { name: "Sort by Agent", exact: true });
  await heading.scrollIntoViewIfNeeded();
  const exportButton = page.getByRole("button", { name: "Export agent inventory CSV" });
  const attention = page.getByRole("button", { name: /Inventory needs attention.*Open Sync/ });
  await expect(attention).toBeVisible();
  const surfaces = [table, overview, exportButton,
    page.locator(".agent-catalog-heading").getByRole("group", { name: "Inventory scope" }),
    table.locator(".agent-grid-toolbar"), heading];
  const surfaceNames = ["table", "overview", "export", "inventory scope", "toolbar", "sort heading"];
  const bounds = () => Promise.all(surfaces.map(surface => surface.boundingBox()));
  const initialBounds = await bounds();
  await heading.click();
  await expect.poll(() => Boolean(finishSort)).toBe(true);
  await expect(heading).toBeFocused();
  await expect(table.getByRole("checkbox").first()).toBeDisabled();
  await expect(exportButton).toBeDisabled();
  const refresh = page.getByRole("status", { name: "Updating agent results", exact: true });
  await expect(refresh).toBeVisible();
  await expect(exportButton.locator("..").getByRole("status")).toHaveAccessibleName("Updating agent results");
  await expect(table.locator(".notice")).toHaveCount(0);
  await expect(attention).toBeVisible();
  const pendingBounds = await bounds();
  await info.attach("agent-sort-pending-geometry", {
    body: JSON.stringify({ surfaceNames, before: initialBounds, pending: pendingBounds }, null, 2), contentType: "application/json",
  });
  expect(pendingBounds).toEqual(initialBounds);
  expect(await refresh.locator("svg").evaluate(element => getComputedStyle(element).animationName)).toBe("agent-refresh-spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await refresh.locator("svg").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
  expect((await new AxeBuilder({ page }).include(".agent-catalog-heading").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agent-results-refresh.png"), fullPage: true });
  await finishSort!();
  await expect(table.getByRole("checkbox").first()).toBeEnabled();
  await expect(refresh).toHaveCount(0);
  const settledBounds = await bounds();
  await info.attach("agent-sort-settled-geometry", {
    body: JSON.stringify({ surfaceNames, before: initialBounds, settled: settledBounds }, null, 2), contentType: "application/json",
  });
  expect(settledBounds).toEqual(initialBounds);
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
  await page.route("**/api/agent-inventory?*", route => fulfillInventoryPage(route, { ...unifiedAgents, value: records }));
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
      recordId: `graph_packages:${zeroPackageId}`, responses: 0, activeUsers: 0, lastActivityDateUtc: null,
    }),
  };
  const unmatchedRecord: UnifiedAgentRecord = {
    ...unifiedAgents.value[2], displayName: automaticUsageReportName,
    usage: { recordId: unifiedAgents.value[2].id, status: "unlinked", reportSetId, responses: null, activeUsers: null, lastActivityDateUtc: null, associationCount: 0 },
  };
  const olderReportId = "33333333-3333-4333-8333-333333333333";
  let snapshot: "current" | "older" | "mismatched" | "unavailable" = "current";
  let candidateReads = 0;
  const mutations: string[] = [];
  const userReads: URLSearchParams[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && !isInventorySelectionRequest(request) && /\/api\/(?:agent-inventory|official-usage)/.test(new URL(request.url()).pathname)) {
      mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  const context = (): InventoryReportContext => ({
    ...automaticUsageContext,
    reports: { ...selectedFixtureReports,
      availability: snapshot === "unavailable" ? "deleted" : snapshot === "older" ? "stale" : "active",
      setId: snapshot === "unavailable" ? null : snapshot === "current" ? reportSetId : olderReportId,
    },
  });
  const inventory = (): UnifiedAgentInventoryPage => ({
    ...unifiedAgents, usageContext: context(),
    value: [{
      ...record,
      usage: automaticAgentUsageFixture({ recordId: record.id, ...(snapshot === "older" ? { reportSetId: olderReportId, responses: 179 } : {}) }),
    }, zeroRecord, unmatchedRecord],
  });
  await page.route(url => url.pathname === "/api/agent-inventory", route => {
    const query = inventoryFixtureQuery(route);
    const data = inventory();
    if (query.has("recordId")) {
      data.value = data.value.filter(item => item.id === query.get("recordId"));
      data.counts.filtered = data.value.length;
    }
    return fulfillInventoryPage(route, data);
  });
  await page.route(url => /^\/api\/agents\/[^/]+\/detail$/.test(url.pathname), route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("selectionId")).toBeTruthy();
    const id = decodeURIComponent(url.pathname.split("/")[3]);
    const item = inventory().value.flatMap(agent => agent.packages).find(item => item.id === id);
    return item ? route.fulfill({ json: item }) : route.fallback();
  });
  await mockSelectedInventoryUsage(page, inventory, () => Array.from({ length: 7 }, (_, index): ReportRelationship => ({
    id: `relationship-${index}`, agentId: automaticUsagePackageId, agentName: automaticUsageReportName, creatorType: "Microsoft",
    username: `person${index}@example.invalid`, responses: index === 0 ? snapshot === "older" ? 173 : 175 : 1,
    lastActivityDateUtc: "2026-09-12", identityStatus: "unresolved",
  })), { users: query => userReads.push(query), candidates: () => { candidateReads++; } });
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
  await expect(table.locator(".agent-grid-toolbar")).not.toContainText(usageCoverageLabel(automaticUsageContext.reports));
  await expect(page.getByRole("region", { name: "Agent inventory overview" }).getByRole("combobox", { name: "Report set", exact: true })).toBeVisible();
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
  await dialog.getByRole("tab", { name: "Users" }).click();
  await expect(dialog.getByLabel("Selected agent report metrics").getByText("181", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("CSV report dates")).toContainText("Aug 14, 2026 - Sep 12, 2026");
  await expect(dialog.getByText("person0@example.invalid", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Person 0", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("cell", { name: "175", exact: true })).toBeVisible();
  await expect(dialog.getByText("7 matching users; 7 on this page", { exact: true })).toBeVisible();
  expect(await dialog.getByRole("columnheader", { name: "Responses", exact: true }).evaluate(header => {
    const text = document.createRange();
    text.selectNodeContents(header);
    return text.getClientRects().length;
  })).toBe(1);
  expect(userReads.at(-1)!.get("selectionId")).toBe(userReads.at(-1)!.get("inventorySelectionId"));
  expect(userReads.at(-1)!.has("agentIds")).toBe(false);
  expect(userReads.every(query => !query.has("licenseCohort"))).toBe(true);
  await expect(dialog.getByText(/matched automatically|not lifetime|Selected report snapshot:/i)).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "View active users without paid Copilot" })).toHaveCount(0);
  await dialog.getByRole("searchbox", { name: "Search agent users" }).fill("person3@");
  await expect(dialog.getByText("1 matching users; 1 on this page", { exact: true })).toBeVisible();
  await expect(dialog.getByText("person0@example.invalid", { exact: true })).toHaveCount(0);
  await dialog.getByRole("searchbox", { name: "Search agent users" }).fill("");
  await expect(dialog.getByText("7 matching users; 7 on this page", { exact: true })).toBeVisible();
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
  await unmatchedDialog.getByRole("tab", { name: "Users" }).click();
  await expect(unmatchedDialog.getByText("This agent is not included in the latest CSV report.")).toBeVisible();
  await expect(unmatchedDialog.getByRole("heading", { name: "Usage not reported", exact: true })).toBeVisible();
  await expect(unmatchedDialog.getByRole("button", { name: "Reload usage" })).toHaveCount(0);
  await expect(unmatchedDialog.getByRole("alert")).toHaveCount(0);
  await expect(unmatchedDialog.getByRole("region", { name: "Exact reported agent details" })).toHaveCount(0);
  await expect(unmatchedDialog.getByRole("button", { name: "Associate a usage report" })).toHaveCount(0);
  await unmatchedDialog.screenshot({ path: info.outputPath("agent-usage-not-reported.png") });
  await closeDetails();

  snapshot = "older";
  await page.reload();
  await expect(excelRow.getByRole("cell", { name: "179", exact: true })).toBeVisible();
  await expect(excelRow.getByRole("cell", { name: "360", exact: true })).toHaveCount(0);
  await table.getByRole("button", { name: record.displayName, exact: true }).click();
  await dialog.getByRole("tab", { name: "Users" }).click();
  await expect(dialog.getByLabel("Selected agent report metrics").getByText("179", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Saved report is out of date. Refresh reports in Sync.")).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "173", exact: true })).toBeVisible();
  expect(userReads.at(-1)!.get("selectionId")).toBe(userReads.at(-1)!.get("inventorySelectionId"));
  await closeDetails();

  for (const unavailableSnapshot of ["mismatched", "unavailable"] as const) {
    snapshot = unavailableSnapshot;
    await page.reload();
    await expect(excelRow.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(2);
    await table.getByRole("button", { name: record.displayName, exact: true }).click();
    await dialog.getByRole("tab", { name: "Users" }).click();
    await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
    if (snapshot === "mismatched") {
      await expect(dialog.getByRole("alert")).toContainText("The selected report changed. Restart usage selection.");
      await expect(dialog.getByRole("button", { name: "Reload usage" })).toBeEnabled();
    } else {
      await expect(dialog.getByRole("heading", { name: "No CSV reports available", exact: true })).toBeVisible();
      await expect(dialog.getByText("Import a complete CSV report in Sync to see usage.")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Reload usage" })).toHaveCount(0);
    }
    await expect(dialog.getByRole("button", { name: "Associate a usage report" })).toHaveCount(0);
    await closeDetails();
  }
  expect(candidateReads).toBe(0);
  expect(mutations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("agent users paginate all 53 exact report identities without leaving the modal", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const record = { ...unifiedAgents.value[0], usage: automaticAgentUsageFixture({ recordId: unifiedAgents.value[0].id, responses: 482, activeUsers: 53 }) };
  const inventory = (): UnifiedAgentInventoryPage => ({ ...unifiedAgents, value: [record],
    counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 1 }, usageContext: automaticUsageContext });
  await page.route("**/api/agent-inventory?*", route => fulfillInventoryPage(route, inventory()));
  const users = Array.from({ length: 53 }, (_, index): ReportRelationship => ({
    id: `relation-${index}`, agentId: record.packages[0].id, agentName: record.displayName, creatorType: "Microsoft",
    username: `report.user${index + 1}@example.invalid`, responses: index === 0 ? 430 : 1,
    lastActivityDateUtc: null, identityStatus: "unresolved",
  }));
  await mockSelectedInventoryUsage(page, inventory, () => users);
  await page.goto("/agents");
  await page.getByRole("button", { name: record.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: record.displayName, exact: true });
  await dialog.getByRole("tab", { name: "Users" }).click();
  const list = dialog.getByRole("region", { name: "Agent users", exact: true });
  await expect(list.getByRole("rowheader")).toHaveCount(25);
  await expect(list.getByText("report.user1@example.invalid", { exact: true })).toBeVisible();
  await expect(list.getByText("53 matching users; 25 on this page")).toBeVisible();
  await list.getByRole("button", { name: "Next users" }).click();
  await expect(list.getByText("report.user26@example.invalid", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Next users" }).click();
  await expect(list.getByRole("rowheader")).toHaveCount(3);
  await expect(list.getByText("report.user53@example.invalid", { exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "Next users" })).toBeDisabled();
  await list.getByRole("searchbox", { name: "Search agent users" }).fill("report.user1@");
  await expect(list.getByText("1 matching users; 1 on this page")).toBeVisible();
  await expect(list.getByText("report.user1@example.invalid", { exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "Previous users" })).toBeDisabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".unified-agent-detail-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agent-53-users.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});

test("usage recovers expired inventory and report changes in place, and Reload usage obtains a new table selection", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  let responses = 181, reportId = reportSetId, failSummary = true, failUsers = false;
  const record = () => ({ ...unifiedAgents.value[0],
    usage: automaticAgentUsageFixture({ recordId: unifiedAgents.value[0].id, responses, reportSetId: reportId }) });
  const inventory = (): UnifiedAgentInventoryPage => ({ ...unifiedAgents, value: [record()],
    counts: { total: 1, scoped: 1, filtered: 1, packageTargets: 1 },
    usageContext: { ...automaticUsageContext, reports: { ...automaticUsageContext.reports, setId: reportId } } });
  const tableSelections: string[] = [], usageSelections: string[] = [];
  await page.route("**/api/agent-inventory?*", route => {
    tableSelections.push(inventoryFixtureQuery(route).get("selectionId")!);
    return fulfillInventoryPage(route, inventory());
  });
  await mockSelectedInventoryUsage(page, inventory, () => [{
    id: "usage-recovery-user", agentId: record().packages[0].id, agentName: record().displayName, creatorType: "Microsoft",
    username: "usage.user@example.invalid", responses, lastActivityDateUtc: null, identityStatus: "unresolved",
  }]);
  await page.route(url => /^\/api\/agent-inventory\/[^/]+\/usage$/.test(url.pathname), route => {
    const query = new URL(route.request().url()).searchParams;
    usageSelections.push(query.get("inventorySelectionId")!);
    if (!failSummary) return route.fallback();
    failSummary = false;
    return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "The saved inventory selection expired." } });
  });
  await page.route(url => url.pathname.endsWith("/usage-users"), route => {
    if (!failUsers) return route.fallback();
    failUsers = false; responses = 202; reportId = "44444444-4444-4444-8444-444444444444";
    return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "The selected report was deleted." } });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: record().displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: record().displayName, exact: true });
  await dialog.getByRole("tab", { name: "Users" }).click();
  await expect(dialog.getByText("usage.user@example.invalid", { exact: true })).toBeVisible();
  expect(new Set(usageSelections).size).toBe(2);
  expect(usageSelections[0]).not.toBe(usageSelections.at(-1));
  expect(usageSelections.at(-1)).toBe(tableSelections.at(-1));
  await expect(dialog.getByLabel("Selected agent report metrics")).toContainText("181");

  const beforeReportChange = new Set(tableSelections).size;
  failUsers = true;
  await dialog.getByRole("searchbox", { name: "Search agent users" }).fill("usage");
  await expect(dialog.getByLabel("Selected agent report metrics")).toContainText("202");
  await expect(dialog.getByText("usage.user@example.invalid", { exact: true })).toBeVisible();
  expect(new Set(tableSelections).size).toBe(beforeReportChange + 1);
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await page.route(url => /^\/api\/agent-inventory\/[^/]+\/usage$/.test(url.pathname), route =>
    route.fulfill({ status: 503, json: { code: "temporary_usage_failure", detail: "Temporary saved-data failure." } }), { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dialog.getByRole("alert")).toContainText("Temporary saved-data failure.");
  const beforeManualReload = new Set(tableSelections).size;
  await dialog.getByRole("button", { name: "Reload usage", exact: true }).click();
  await expect(dialog.getByText("usage.user@example.invalid", { exact: true })).toBeVisible();
  expect(new Set(tableSelections).size).toBe(beforeManualReload + 1);
  await expect(dialog.getByRole("tab", { name: "Users" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
