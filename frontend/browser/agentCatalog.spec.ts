import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { matchesAgentFilters, summarizeAgentAvailability } from "../../backend/src/types/agentPresentation";
import { formatPackageType } from "../../backend/src/types/copilotPackage";
import {
  unifiedAgentAccessFilters, unifiedAgentManagementFilters, unifiedAgentRelevanceFilters, unifiedAgentUsageFilters, unifiedAgentViews,
} from "../../backend/src/types/unifiedAgents";
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

function filterQuery(query: URLSearchParams) {
  return {
    type: query.get("type") ?? undefined,
    view: unifiedAgentViews.find(value => value === query.get("view")),
    endUserAccess: unifiedAgentAccessFilters.find(value => value === query.get("endUserAccess")),
    reportedUsage: unifiedAgentUsageFilters.find(value => value === query.get("reportedUsage")),
    management: unifiedAgentManagementFilters.find(value => value === query.get("management")),
    relevance: unifiedAgentRelevanceFilters.find(value => value === query.get("relevance")),
  };
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
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
  await page.route("**/api/agent-inventory?*", route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const value = records.filter(record => matchesAgentFilters(record, filterQuery(query)));
    return route.fulfill({ json: {
      ...unifiedAgents, value, count: value.length, summary, scopeSummary: summary,
      facets: { ...unifiedAgents.facets, types },
      inventoryOverview: summarizeAgentAvailability(records), usageContext: automaticUsageContext,
    } });
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  const view = page.getByRole("combobox", { name: "Show agents", exact: true });
  await expect(table.getByRole("row")).toHaveCount(7);
  expect(await view.locator("option").allTextContents()).toEqual([
    "All agents", "1st party agents", "3rd party agents", "Built by your org", "Shared in your organization", "unknownFutureValue",
  ]);
  for (const [value, names] of [
    ["firstParty", ["Researcher"]], ["thirdParty", ["Vendor agent", "Managed vendor"]],
    ["shared", ["Personal agent"]], ["lob", ["Studio agent"]], ["unknownFutureValue", ["Unknown origin"]],
  ] as const) {
    await view.selectOption(value);
    await expect.poll(() => queries.at(-1)?.get("type")).toBe(value);
    expect(queries.at(-1)?.has("view")).toBe(false);
    await expect(table.getByRole("row")).toHaveCount(names.length + 1);
    for (const name of names) await expect(table.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await view.selectOption("thirdParty");
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Management", exact: true }).selectOption("organization_managed");
  await page.getByRole("combobox", { name: "Reported usage", exact: true }).selectOption("used");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/type=thirdParty&usage=used&management=organization_managed/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: "Managed vendor", exact: true })).toBeVisible();
  await page.reload();
  await expect(view).toHaveValue("thirdParty");
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
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const value = records.filter(record => matchesAgentFilters(record, filterQuery(query))
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
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const value = records.filter(record => matchesAgentFilters(record, filterQuery(query))
      && (!query.get("search") || record.displayName.includes(query.get("search")!)));
    return route.fulfill({ json: {
      ...unifiedAgents, value, count: value.length, inventoryOverview: summarizeAgentAvailability(records),
      usageContext: automaticUsageContext,
    } });
  });
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  const used = overview.getByRole("button", { name: "Show reported used agents", exact: true });
  const table = page.getByRole("region", { name: "Unified agents" });
  const showAgents = page.getByRole("combobox", { name: "Show agents" });
  const search = page.getByRole("searchbox", { name: "Search", exact: true });
  await expect(used).toBeEnabled();
  await expect(used).toHaveAttribute("aria-pressed", "false");
  await showAgents.selectOption("thirdParty");
  await search.fill(records[0].displayName);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await used.focus();
  await page.keyboard.press("Enter");
  await expect(showAgents).toHaveValue("thirdParty");
  await expect(used).toHaveAttribute("aria-pressed", "true");
  await expect(search).toHaveValue(records[0].displayName);
  await expect(page).toHaveURL(/type=thirdParty&usage=used/);
  await expect.poll(() => queries.at(-1)?.get("reportedUsage")).toBe("used");
  expect(queries.at(-1)?.get("type")).toBe("thirdParty");
  expect(queries.at(-1)?.get("inventoryScope")).toBe("catalog");
  expect(queries.at(-1)?.get("search")).toBe(records[0].displayName);
  await search.fill("");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toHaveCount(0);
  await expect(table.getByRole("button", { name: records[2].displayName, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(showAgents).toHaveValue("thirdParty");
  await expect(used).toHaveAttribute("aria-pressed", "true");
  await expect(table.getByRole("button", { name: records[0].displayName, exact: true })).toBeVisible();
  await used.click();
  await expect(used).toHaveAttribute("aria-pressed", "false");
  await expect(showAgents).toHaveValue("thirdParty");
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
  await expect(name).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("party filters, server sorting and remembered columns stay usable and accessible", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const records = unifiedAgents.value.map((record, index): UnifiedAgentRecord => ({
    ...record,
    packages: record.packages.map(item => ({ ...item, type: index === 1 ? "thirdParty" : "firstParty" })),
    usage: {
      status: index === 1 ? "unlinked" : "linked", reportSetId, responses: index === 1 ? null : index === 0 ? 215 : 0,
      activeUsers: index === 1 ? null : 0, lastActivityDateUtc: null, associations: [],
    },
  }));
  const queries: URLSearchParams[] = [];
  const cacheReads: Array<{ phase: string; parameters: Record<string, string> }> = [];
  let phase = "initial";
  await page.route("**/api/agent-inventory?*", route => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    cacheReads.push({ phase, parameters: Object.fromEntries(query) });
    const value = records.filter(record => matchesAgentFilters(record, filterQuery(query)));
    if (query.get("sortBy") === "responses") {
      value.sort((left, right) => (right.usage?.responses ?? -1) - (left.usage?.responses ?? -1));
    }
    return route.fulfill({ json: { ...unifiedAgents, usageContext, value, count: value.length } });
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
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("firstParty");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("button", { name: records[1].displayName, exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/type=firstParty/);
  phase = "return-all";
  await page.getByRole("combobox", { name: "Show agents" }).selectOption("");
  await expect(table.getByRole("row")).toHaveCount(4);
  await info.attach("agent-view-cache-requests", {
    body: JSON.stringify({ initialCatalogReads, cacheReads }, null, 2), contentType: "application/json",
  });
  expect(queries.filter(query => !query.has("type"))).toHaveLength(initialCatalogReads);

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
    const query = new URL(route.request().url()).searchParams;
    if (query.get("sortDirection") === "desc") {
      finishSort = () => route.fulfill({ json: { ...unifiedAgents, value: [...unifiedAgents.value].reverse() } });
      return;
    }
    return route.fulfill({ json: unifiedAgents });
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
  const userReads: URLSearchParams[] = [];
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
  await page.route("**/api/official-usage/agent-users?*", route => {
    const query = new URL(route.request().url()).searchParams;
    userReads.push(query);
    const users = Array.from({ length: 7 }, (_, index) => ({
      username: `person${index}@example.invalid`, displayName: `Person ${index}`,
      responsesSentToUsers: index === 0 ? snapshot === "older" ? 173 : 175 : 1,
    })).filter(user => !query.get("search") || user.username.includes(query.get("search")!));
    return route.fulfill({ json: {
      activeSet: context().reportSet, agentIds: [automaticUsagePackageId],
      users: { count: users.length, value: users, limit: 25, offset: 0 },
    } });
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
  await expect(table.locator(".agent-grid-toolbar")).not.toContainText(usageCoverageLabel(automaticUsageContext.reportSet));
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
  await dialog.getByRole("tab", { name: "Usage & users" }).click();
  await expect(dialog.getByLabel("Selected agent report metrics").getByText("181", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("CSV report dates")).toContainText("Aug 14, 2026 - Sep 12, 2026");
  await expect(dialog.getByText("person0@example.invalid", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Person 0", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("cell", { name: "175", exact: true })).toBeVisible();
  await expect(dialog.getByText("1-7 of 7 users", { exact: true })).toBeVisible();
  expect(JSON.parse(userReads.at(-1)!.get("agentIds")!)).toEqual([automaticUsagePackageId]);
  expect(userReads.at(-1)!.get("setId")).toBe(reportSetId);
  expect(userReads.every(query => !query.has("licenseCohort"))).toBe(true);
  await expect(dialog.getByText(/not a proven|source refresh time|matched automatically|not lifetime|Report provenance|Selected report snapshot:/i)).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "View active users without paid Copilot" })).toHaveCount(0);
  await dialog.getByRole("searchbox", { name: "Search agent users" }).fill("person3@");
  await expect(dialog.getByText("1-1 of 1 users", { exact: true })).toBeVisible();
  await expect(dialog.getByText("person0@example.invalid", { exact: true })).toHaveCount(0);
  await dialog.getByRole("searchbox", { name: "Search agent users" }).fill("");
  await expect(dialog.getByText("1-7 of 7 users", { exact: true })).toBeVisible();
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
  await expect(unmatchedDialog.getByRole("heading", { name: "Usage unavailable" })).toBeVisible();
  await expect(unmatchedDialog.getByText("This agent is not included in the selected CSV report.")).toBeVisible();
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
  await expect(dialog.getByRole("cell", { name: "173", exact: true })).toBeVisible();
  expect(userReads.at(-1)!.get("setId")).toBe(olderReportId);
  await closeDetails();

  for (const unavailableSnapshot of ["mismatched", "unavailable"] as const) {
    snapshot = unavailableSnapshot;
    await page.reload();
    await expect(excelRow.getByRole("cell", { name: "Unavailable", exact: true })).toHaveCount(2);
    await table.getByRole("button", { name: record.displayName, exact: true }).click();
    await dialog.getByRole("tab", { name: "Usage & users" }).click();
    await expect(dialog.getByLabel("Selected agent report metrics")).toHaveCount(0);
    await expect(dialog.getByText(snapshot === "mismatched" ? "The selected report changed. Reload usage to update this agent." : "Select a complete CSV report in Sync to see usage.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Associate a usage report" })).toHaveCount(0);
    await closeDetails();
  }
  expect(candidateReads).toBe(0);
  expect(mutations).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("agent users paginate all 53 names and emails without leaving the modal", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const record = { ...unifiedAgents.value[0], usage: automaticAgentUsageFixture({ responses: 482, activeUsers: 53 }) };
  await page.route("**/api/agent-inventory?*", route => route.fulfill({
    json: { ...unifiedAgents, value: [record], count: 1, usageContext: automaticUsageContext },
  }));
  const users = Array.from({ length: 53 }, (_, index) => ({
    displayName: `Report user ${String(index + 1).padStart(2, "0")}`,
    username: `report.user${index + 1}@example.invalid`,
    responsesSentToUsers: index === 0 ? 430 : 1,
  }));
  await page.route("**/api/official-usage/agent-users?*", route => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = users.filter(user => !query.get("search")
      || `${user.displayName} ${user.username}`.toLowerCase().includes(query.get("search")!.toLowerCase()));
    const offset = Number(query.get("offset"));
    const limit = Number(query.get("limit"));
    return route.fulfill({ json: { activeSet: automaticUsageContext.reportSet, agentIds: [automaticUsagePackageId],
      users: { value: filtered.slice(offset, offset + limit), count: filtered.length, offset, limit } } });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: record.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: record.displayName, exact: true });
  await dialog.getByRole("tab", { name: "Usage & users" }).click();
  const list = dialog.getByRole("region", { name: "Agent users", exact: true });
  await expect(list.getByRole("rowheader")).toHaveCount(25);
  await expect(list.getByText("report.user1@example.invalid", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Next users" }).click();
  await expect(list.getByText("26-50 of 53 users")).toBeVisible();
  await list.getByRole("button", { name: "Next users" }).click();
  await expect(list.getByRole("rowheader")).toHaveCount(3);
  await expect(list.getByText("report.user53@example.invalid", { exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "Next users" })).toBeDisabled();
  await list.getByRole("searchbox", { name: "Search agent users" }).fill("Report user 01");
  await expect(list.getByText("1-1 of 1 users")).toBeVisible();
  await expect(list.getByText("report.user1@example.invalid", { exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "Previous users" })).toBeDisabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".unified-agent-detail-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agent-53-users.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});
