import { expect, test, type Locator, type Page } from "@playwright/test";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { createInventoryVerification } from "../src/test/inventoryVerification";
import { selectedFixtureRead, selectedUsersPage } from "../src/test/selectedUsageFixture";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { fulfillInventoryPage, inventoryFixtureQuery } from "./selectedInventoryFixture";

const cachedPaths = new Set(["/api/agent-inventory/selections", "/api/agent-inventory", "/api/copilot-usage/users",
  "/api/official-usage/overview", "/api/official-usage/history/options"]);

function primary(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name, exact: true });
}

async function cachedClick(button: Locator, text: string, metricSelector: string, metricValue: string) {
  const result = await button.evaluate(async (element, expected) => {
    const started = performance.now();
    (element as HTMLButtonElement).click();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return {
      elapsedMs: performance.now() - started,
      hasRow: document.body.textContent?.includes(expected.text),
      metric: document.querySelector(expected.metricSelector)?.textContent,
      skeleton: Boolean(document.querySelector(".workspace-skeleton")),
    };
  }, { text, metricSelector });
  expect(result.hasRow).toBe(true);
  expect(result.metric).toBe(metricValue);
  expect(result.skeleton).toBe(false);
  expect(result.elapsedMs).toBeLessThan(250);
}

async function holdRepeatedReads(page: Page) {
  const reads: string[] = [];
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => cachedPaths.has(url.pathname), async route => {
    reads.push(route.request().url());
    await ready;
    await route.fallback();
  });
  return { reads, release };
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(layoutTime));
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("recent Users and Agents revisits render within two frames without data requests", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/agents");
  await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show reported used agents" }).locator("strong")).toHaveText("2");
  await expect(page.getByRole("combobox", { name: "Report set" })).toBeEnabled();
  await primary(page, "Users").click();
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Report set" })).toBeEnabled();
  const held = await holdRepeatedReads(page);
  try {
    for (let index = 0; index < 3; index++) {
      await cachedClick(primary(page, "Agents"), "Service desk assistant",
        'button[aria-label="Show available to end users"] strong', "2");
      await expect(page.getByRole("combobox", { name: "Report set" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Show reported used agents" }).locator("strong")).toHaveText("2");
      await cachedClick(primary(page, "Users"), "Ada",
        'button[aria-label="Active M365 Copilot licensed users"] strong', "4");
      await expect(page.getByRole("combobox", { name: "Report set" })).toBeEnabled();
    }
    expect(held.reads).toEqual([]);
    expect(unexpected).toEqual([]);
    await page.screenshot({ path: info.outputPath("cached-users.png") });
  } finally { held.release(); }
});

test("catalog and additional Power Platform reuse independent pages without unknown count flashes", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const observation: NonNullable<UnifiedAgentRecord["observations"]["powerPlatform"]> = {
    id: "native-snapshot", snapshotId: "native-snapshot", observedAt: layoutTime,
    expiresAt: unifiedAgents.selection.expiresAt, current: true, roleScope: "full", environmentScope: null,
    coverage: "covered", coveredCount: 1, observedCount: 1, totalRecords: 1, pageCount: 1,
    verification: createInventoryVerification(1),
  };
  const native: UnifiedAgentRecord = {
    id: "power_platform:environment:native-agent", displayName: "Additional native agent", presence: "power_platform",
    environmentId: "environment", packages: [],
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "No package link." },
    observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: observation },
    powerPlatformResource: {
      tenantId: "layout-tenant", nativeId: "native-agent", environmentId: "environment",
      displayName: "Additional native agent", type: "microsoft.copilotstudio/agents", location: null,
      createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
      authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
      lifecycle: "published", identityConfidence: "exact_native", identifiers: [], provenance: {},
      details: { isQuarantined: false }, unknownFieldCount: 0,
    },
  };
  const inventory: UnifiedAgentInventoryPage = {
    ...unifiedAgents, partial: false, errors: [],
    summary: { ...unifiedAgents.summary, total: 4, powerPlatformOnly: 1 },
    sources: { ...unifiedAgents.sources, powerPlatform: { state: "available", observation, error: null } },
  };
  let releaseNative!: () => void;
  const nativeReady = new Promise<void>(resolve => { releaseNative = resolve; });
  await page.route("**/api/agent-inventory?*", async route => {
    if (inventoryFixtureQuery(route).get("inventoryScope") !== "power_platform_only") return fulfillInventoryPage(route, inventory);
    await nativeReady;
    return fulfillInventoryPage(route, { ...inventory, value: [native], inventoryScope: "power_platform_only",
      counts: { total: 4, scoped: 1, filtered: 1, packageTargets: 0 },
      inventoryOverview: { availableToUsers: 1, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 1 } });
  });
  await page.goto("/agents");
  await expect(page.getByText("Service desk assistant", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show reported used agents" }).locator("strong")).toHaveText("2");
  const catalog = page.getByRole("button", { name: "Microsoft 365 catalog", exact: true });
  const additional = page.getByRole("button", { name: "Additional Power Platform agents", exact: true });
  try {
    await additional.click();
    await expect(additional.locator("strong").getByLabel("Loading count")).toBeVisible();
    await expect(page.getByRole("button", { name: "Show available to end users" }).locator("strong").getByLabel("Loading count")).toBeVisible();
  } finally { releaseNative(); }
  await expect(page.getByText(native.displayName, { exact: true })).toBeVisible();
  const held = await holdRepeatedReads(page);
  try {
    for (let index = 0; index < 3; index++) {
      await cachedClick(catalog, "Service desk assistant", 'button[aria-label="Show available to end users"] strong', "2");
      await expect(page.getByText(native.displayName, { exact: true })).toHaveCount(0);
      await cachedClick(additional, native.displayName, 'button[aria-label="Show available to end users"] strong', "1");
      await expect(page.getByText("Service desk assistant", { exact: true })).toHaveCount(0);
      await expect(catalog.locator("strong")).toHaveText("3");
      await expect(additional.locator("strong")).toHaveText("1");
    }
    expect(held.reads).toEqual([]);
    expect(unexpected).toEqual([]);
    await page.screenshot({ path: info.outputPath("cached-power-platform.png") });
  } finally { held.release(); }
});

test("running source refreshes preserve saved user metrics without routine warning banners", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const saved = selectedUsersPage();
  saved.sources.directory.attemptStatus = "running";
  saved.sources.app_activity.attemptStatus = "running";
  await page.route("**/api/copilot-usage/users?*", route => route.fulfill({ json: selectedFixtureRead(route.request().url(), saved) }));
  await page.goto("/users");
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Active M365 Copilot licensed users" }).locator("strong")).toHaveText("4");
  await expect(page.getByRole("button", { name: "Using agents", exact: true }).locator("strong")).toHaveText("2");
  await expect(page.getByText(/Refreshing license data|Refreshing Office app activity|Showing the last saved data/)).toHaveCount(0);
  expect(unexpected).toEqual([]);
  await page.screenshot({ path: info.outputPath("quiet-user-refresh.png") });
});
