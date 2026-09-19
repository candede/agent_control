import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { matchesAgentView } from "../../backend/src/types/agentPresentation";
import { unifiedAgentViews } from "../../backend/src/types/unifiedAgents";
import type { AgentUsageContext, UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { usageInsightsPublished } from "../src/test/usageInsightsFixture";
import { agentColumns } from "../src/agentColumns";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

const usageContext: AgentUsageContext = {
  reportSet: usageInsightsPublished.activeSet, availability: "active", lineages: [], revision: "b".repeat(64),
};
const reportSetId = usageInsightsPublished.activeSet!.id;

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
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

test("usage association is explicit, exact-target confirmed and reflected in the agent table", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const record = unifiedAgents.value[0];
  const reportAgent = usageInsightsPublished.reports.agents!.rows[0];
  let associated = false;
  let revision = 0;
  let candidateReads = 0;
  const mutations: { method: string; body: Record<string, unknown> }[] = [];
  const context = (): AgentUsageContext => ({ ...usageContext, revision: String(revision + 1).repeat(64) });
  const inventory = (): UnifiedAgentInventoryPage => ({
    ...unifiedAgents, revision: String(revision + 4).repeat(64), count: 1, usageContext: context(),
    value: [{
      ...record,
      usage: {
        status: associated ? "linked" : "unlinked", reportSetId,
        responses: associated ? reportAgent.responsesSentToUsers : null, activeUsers: associated ? 2 : null,
        lastActivityDateUtc: associated ? reportAgent.lastActivityDateUtc ?? null : null,
        associations: associated ? [{
          reportAgentId: reportAgent.agentId, reportAgentName: reportAgent.agentName,
          target: { source: "graph_packages", packageId: record.packages[0].id }, basis: "admin_reviewed", reviewedAt: layoutTime,
        }] : [],
      },
    }],
  });
  await page.route("**/api/agent-inventory**", route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/usage-candidates")) {
      candidateReads += 1;
      return route.fulfill({ json: { context: context(), value: [{ ...reportAgent, associated }], count: 1, offset: 0, limit: 20 } });
    }
    if (url.pathname.endsWith("/usage-associations")) {
      mutations.push({ method: route.request().method(), body: route.request().postDataJSON() });
      associated = route.request().method() === "POST";
      revision += 1;
      return route.fulfill({ json: { context: context() } });
    }
    return route.fulfill({ json: inventory() });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: record.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: record.displayName, exact: true });
  await dialog.getByRole("tab", { name: "Usage & users" }).click();
  await expect(dialog.getByRole("heading", { name: "No verified usage data for this agent" })).toBeVisible();
  expect(candidateReads).toBe(0);
  await dialog.getByRole("button", { name: "Associate a usage report" }).click();
  await dialog.getByRole("button", { name: `Review association for ${reportAgent.agentName} (${reportAgent.agentId})` }).click();
  await expect(dialog.getByRole("button", { name: "Confirm association" })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "Exact inventory target" })).toHaveValue(JSON.stringify({ source: "graph_packages", packageId: record.packages[0].id }));
  expect(mutations).toHaveLength(0);
  await dialog.getByRole("checkbox", { name: /I reviewed the report identity/ }).check();
  await dialog.getByRole("button", { name: "Confirm association" }).click();
  await expect(dialog.getByLabel("Selected agent report metrics").getByText("215", { exact: true })).toBeVisible();
  expect(mutations).toEqual([{
    method: "POST", body: {
      reportSetId, reportAgentId: reportAgent.agentId, expectedInventoryRevision: "4".repeat(64), expectedUsageRevision: "1".repeat(64),
      confirmed: true, target: { source: "graph_packages", packageId: record.packages[0].id },
    },
  }]);
  expect(candidateReads).toBe(1);
  expect((await new AxeBuilder({ page }).include(".unified-agent-detail-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("agent-reviewed-usage.png"), fullPage: true });
  await dialog.getByRole("button", { name: /Remove association for Researcher/ }).click();
  await dialog.getByRole("checkbox", { name: /I confirm this reporting association/ }).check();
  await dialog.getByRole("button", { name: "Confirm removal" }).click();
  await expect(dialog.getByRole("heading", { name: "No verified usage data for this agent" })).toBeVisible();
  expect(mutations[1]).toMatchObject({
    method: "DELETE", body: {
      reportSetId, reportAgentId: reportAgent.agentId, expectedInventoryRevision: "5".repeat(64), expectedUsageRevision: "2".repeat(64), confirmed: true,
    },
  });
  expect(unexpected).toEqual([]);
});
