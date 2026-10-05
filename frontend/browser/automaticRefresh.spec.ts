import AxeBuilder from "@axe-core/playwright";
import { fulfillInventoryPage, isInventorySelectionRequest } from "./selectedInventoryFixture";
import { expect, test } from "@playwright/test";
import type { AutomaticRefreshResult, CapabilityView, CopilotPackageDetail } from "../src/api/client";
import { selectedFixtureRead, selectedUsersPage } from "../src/test/selectedUsageFixture";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { capabilityViews, layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

test.beforeEach(async ({ page }) => {
  // The network-isolated fixture has only loopback; these mocked scheduler cases model an online browser.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("background Users refresh keeps the page stable and interactive with a subtle corner indicator", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const original = selectedUsersPage(), updated = selectedUsersPage();
  updated.value[2] = { ...updated.value[2], reportedResponses: 2, bridgeResponses: 2, reportedAgentsUsed: 1,
    agentActivityState: "active", attention: ["agent_usage_low"] };
  updated.summary = { ...updated.summary, usingAgentsUsers: 3, noAgentActivityUsers: 0 };
  updated.selection = { ...updated.selection, id: "70000000-0000-4000-8000-000000000001" };
  updated.sources.directory = { ...updated.sources.directory, generationId: "90000000-0000-4000-8000-000000000001", revision: "3" };
  updated.reports = { ...updated.reports, setId: "80000000-0000-4000-8000-000000000001", activeSetId: "80000000-0000-4000-8000-000000000001",
    activeRevision: "5", historyRevision: "36", lineages: updated.reports.lineages.map((lineage, index) => ({
      ...lineage, versionId: `80000000-0000-4000-8000-00000000001${index}`, contentHash: "f".repeat(64),
    })) };
  let refreshing = false;
  let reads = 0;
  let checks = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route("**/api/data-sync/auto-refresh", route => {
    checks += 1;
    return route.fulfill({ json: {
      ...automaticRefreshFixture({ users: refreshing ? "users-2" : "users-1", graph_packages: "packages-1", power_platform: "platform-1" }),
      nextCheckAt: layoutTime,
    } });
  });
  await page.route(url => url.pathname.startsWith("/api/copilot-usage/users"), async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/copilot-usage/users") reads += 1;
    if (refreshing) await pending;
    const data = refreshing ? updated : original;
    if (url.searchParams.has("selectionId") && url.searchParams.get("selectionId") !== data.selection.id) {
      return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "The selected source changed." } });
    }
    return route.fulfill({ json: selectedFixtureRead(url.href, data) });
  });
  try {
    await page.goto("/users");
    const summary = page.getByLabel("M365 Copilot license summary");
    const table = page.getByRole("region", { name: "M365 Copilot license status", exact: true });
    const search = page.getByRole("searchbox", { name: "Search users or agents" });
    await expect(summary.locator("strong")).toHaveText(["4", "2", "2", "1"]);
    await expect.poll(() => checks).toBe(1);
    await page.clock.runFor(500);
    await search.fill("Ben");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    await expect(table.getByRole("button", { name: "Ben", exact: true })).toBeVisible();
    const tableBefore = await table.boundingBox();
    const rowBefore = await table.locator("tbody").innerText();
    const readsBefore = reads;

    refreshing = true;
    await page.clock.fastForward(60_000);
    await expect.poll(() => reads).toBe(readsBefore + 1);
    await page.clock.runFor(501);
    const indicator = page.getByRole("status", { name: "Background refresh" });
    await expect(indicator).toBeVisible();
    await expect(indicator).toHaveCSS("position", "fixed");
    await expect(indicator).toHaveCSS("pointer-events", "none");
    const indicatorBounds = await indicator.boundingBox();
    expect(indicatorBounds!.width).toBe(32);
    expect(indicatorBounds!.height).toBe(32);
    await expect(indicator).toHaveText("");
    await expect(indicator.locator("svg")).toHaveCSS("animation-name", "background-refresh-spin");
    await expect(indicator.locator("svg")).toHaveCSS("animation-timing-function", "linear");
    await expect(indicator.locator("svg")).toHaveCSS("animation-iteration-count", "infinite");
    const firstRotation = await indicator.locator("svg").evaluate(icon => getComputedStyle(icon).transform);
    await expect.poll(() => indicator.locator("svg").evaluate(icon => getComputedStyle(icon).transform)).not.toBe(firstRotation);
    await expect(summary.locator("strong")).toHaveText(["4", "2", "2", "1"]);
    expect(await table.locator("tbody").innerText()).toBe(rowBefore);
    expect(await table.boundingBox()).toEqual(tableBefore);
    await expect(search).toBeFocused();
    await expect(page.getByRole("region", { name: "Users and adoption" })).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText(/Loading saved Copilot|Showing the last saved user snapshot/)).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(indicator.locator("svg")).toHaveCSS("animation-name", "none");
    expect(await new AxeBuilder({ page }).include(".copilot-users").include(".background-refresh-indicator").analyze()).toMatchObject({ violations: [] });
    await page.screenshot({ path: info.outputPath("users-background-refresh.png") });

    await search.fill("Cleo");
    await expect(search).toHaveValue("Cleo");
    await expect(table.getByRole("button", { name: "Ben", exact: true })).toHaveCount(0);
    finish();
    await table.getByRole("button", { name: "Cleo", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cleo", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Agent responses", { exact: true }).locator("..").locator("strong")).toHaveText("2");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close user details" }).click();
    await expect(indicator).toHaveCount(0);
    await expect(search).toHaveValue("Cleo");
    expect(unexpected).toEqual([]);
  } finally {
    finish();
  }
});

test("an open agent Overview keeps background pins and stays stable through explicit saved reloads", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const item = unifiedAgents.value[0].packages[0];
  const descriptions = [
    "Complete saved description of this agent.",
    "Updated saved description of this agent.",
    "Newest saved description of this agent.",
  ] as const;
  const paragraphs = Array.from({ length: 12 }, (_, index) => `<p>Saved agent guidance ${index + 1}.</p>`).join("");
  const detail: CopilotPackageDetail = { ...item, longDescription: `<p>${descriptions[0]}</p>${paragraphs}` };
  const views = capabilityViews.map((view): CapabilityView => view.definition.id === "graph.package.read.delegated"
    ? { ...view, decision: { ...view.decision, status: "available", authorized: true } } : view);
  let version: 0 | 1 | 2 = 0;
  let reads = 0;
  let finish: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  await page.route(url => url.pathname === "/api/capabilities" || url.pathname === "/api/capabilities/check",
    route => route.fulfill({ json: { value: views } }));
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture({ users: "users-1", graph_packages: `packages-${version}`, power_platform: "platform-1" }),
    nextCheckAt: layoutTime,
  } }));
  await page.route(url => url.pathname === "/api/agent-inventory", route => fulfillInventoryPage(route,
    unifiedAgents));
  await page.route(url => url.pathname === `/api/agents/${item.id}/detail`, async route => {
    const description = descriptions[version];
    reads += 1;
    if (pending) await pending;
    await route.fulfill({ json: { ...detail, longDescription: `<p>${description}</p>${paragraphs}` } });
  });
  try {
    await page.goto("/agents");
    await page.getByRole("button", { name: item.displayName, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: item.displayName, exact: true });
    const about = dialog.getByRole("heading", { name: "About", exact: true });
    const panel = dialog.getByRole("tabpanel", { name: "Overview", exact: true });
    const close = dialog.getByRole("button", { name: "Close unified agent details" });
    await expect(dialog.getByText(descriptions[0], { exact: true })).toBeVisible();
    await page.clock.runFor(501);
    const scrollTop = await panel.evaluate(element => {
      element.scrollTop = 64;
      return element.scrollTop;
    });
    expect(scrollTop).toBe(64);
    await expect(close).toBeFocused();
    const bounds = await dialog.boundingBox();
    const aboutBounds = await about.boundingBox();
    const readsBefore = reads;

    for (const nextVersion of [1, 2] as const) {
      version = nextVersion;
      pending = new Promise<void>(resolve => { finish = resolve; });
      await page.clock.fastForward(60_000);
      expect(reads).toBe(readsBefore + version - 1);
      await dialog.getByRole("button", { name: "Reload saved inventory", exact: true }).dispatchEvent("click");
      await expect.poll(() => reads).toBe(readsBefore + version);
      await page.clock.runFor(501);
      expect(await dialog.boundingBox()).toEqual(bounds);
      expect(await about.boundingBox()).toEqual(aboutBounds);
      expect(await panel.evaluate(element => element.scrollTop)).toBe(scrollTop);
      await expect(close).toBeFocused();
      await expect(dialog.getByText(descriptions[version - 1], { exact: true })).toBeVisible();
      await expect(dialog.getByText("Loading saved agent details...", { exact: true })).toHaveCount(0);
      await dialog.screenshot({ path: info.outputPath(`agent-overview-background-refresh-${version}.png`) });

      finish!();
      await expect(dialog.getByText(descriptions[version], { exact: true })).toBeVisible();
      pending = undefined;
      expect(await dialog.boundingBox()).toEqual(bounds);
      expect(await about.boundingBox()).toEqual(aboutBounds);
      expect(await panel.evaluate(element => element.scrollTop)).toBe(scrollTop);
      await expect(close).toBeFocused();
    }
    expect(unexpected).toEqual([]);
  } finally {
    finish?.();
  }
});

test("an open management draft retains its controls and focus during a slow background detail read", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const item = unifiedAgents.value[0].packages[0];
  const detail: CopilotPackageDetail = { ...item, availableTo: "some", allowedUsersAndGroups: [] };
  const views = capabilityViews.map((view): CapabilityView =>
    ["graph.package.read.delegated", "graph.package.access.manage"].includes(view.definition.id)
      ? { ...view, decision: {
        capabilityId: view.definition.id, status: "available", authorized: true, fresh: true,
        previewQualification: "not_required", remediation: [],
        verification: view.definition.probe.kind === "on_demand" ? "on_demand" : "provider",
        ...(view.definition.probe.kind === "on_demand" ? {} : {
          checkedAt: layoutTime, expiresAt: "2099-09-12T00:00:00Z",
        }),
      } } : view);
  let refreshing = false;
  let reads = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request) && !isInventorySelectionRequest(request)
      && new URL(request.url()).pathname !== "/api/capabilities/check") writes.push(new URL(request.url()).pathname);
  });
  await page.route(url => url.pathname === "/api/capabilities" || url.pathname === "/api/capabilities/check",
    route => route.fulfill({ json: { value: views } }));
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture({ users: "users-1", graph_packages: refreshing ? "packages-2" : "packages-1", power_platform: "platform-1" }),
    nextCheckAt: layoutTime,
  } }));
  await page.route(url => url.pathname === "/api/agent-inventory", route => fulfillInventoryPage(route,
    unifiedAgents));
  await page.route(url => url.pathname === `/api/agents/${item.id}/detail`, async route => {
    reads += 1;
    if (refreshing) await pending;
    await route.fulfill({ json: detail });
  });
  try {
    await page.goto("/agents");
    await page.getByRole("button", { name: item.displayName, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: item.displayName, exact: true });
    await expect.poll(() => reads).toBe(1);
    await dialog.getByRole("tab", { name: "Manage", exact: true }).click();
    const none = dialog.getByRole("radio", { name: /No users/ });
    await none.check();
    const apply = dialog.getByRole("button", { name: "Apply", exact: true });
    await apply.focus();
    const panel = dialog.getByRole("tabpanel", { name: "Manage", exact: true });
    const bounds = await apply.boundingBox();
    const scrollTop = await panel.evaluate(element => element.scrollTop);
    refreshing = true;
    await page.clock.fastForward(60_000);
    expect(reads).toBe(1);
    await dialog.getByRole("button", { name: "Reload saved inventory", exact: true }).dispatchEvent("click");
    await expect.poll(() => reads).toBe(2);
    await page.clock.runFor(501);
    await expect(none).toBeChecked();
    await expect(apply).toBeFocused();
    expect(await apply.boundingBox()).toEqual(bounds);
    expect(await panel.evaluate(element => element.scrollTop)).toBe(scrollTop);
    finish();
    await expect(page.getByText("Loading agent details...", { exact: true })).toHaveCount(0);
    await expect(none).toBeChecked();
    await expect(apply).toBeFocused();
    expect(await apply.boundingBox()).toEqual(bounds);
    expect(writes).toEqual([]);
    expect(unexpected).toEqual([]);
  } finally {
    finish();
  }
});

test("an open user Overview stays stable while revalidating and requires explicit restart after source changes", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  let version = 0;
  let reads = 0;
  let finish: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture({ users: `users-${version}`, graph_packages: "packages-1", power_platform: "platform-1" }),
    nextCheckAt: layoutTime,
  } }));
  await page.route(url => url.pathname.startsWith("/api/copilot-usage/users"), async route => {
    const url = new URL(route.request().url()), response = selectedUsersPage();
    if (version) {
      response.value[0].directory.companyName = `Updated organization ${version}`;
      response.selection = { ...response.selection, id: `70000000-0000-4000-8000-${String(version).padStart(12, "0")}` };
      response.sources.directory = { ...response.sources.directory,
        generationId: `90000000-0000-4000-8000-${String(version).padStart(12, "0")}`, revision: String(version + 2) };
    }
    if (url.pathname === "/api/copilot-usage/users") reads += 1;
    if (pending) await pending;
    if (url.searchParams.has("selectionId") && url.searchParams.get("selectionId") !== response.selection.id) {
      return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "The selected source changed." } });
    }
    return route.fulfill({ json: selectedFixtureRead(url.href, response) });
  });
  try {
    await page.goto("/users");
    await page.getByRole("button", { name: "Ada", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Ada", exact: true });
    const panel = dialog.getByRole("tabpanel", { name: "Overview", exact: true });
    const organization = dialog.getByRole("heading", { name: "Organization", exact: true });
    await expect(organization).toBeVisible();
    await page.clock.runFor(501);
    const bounds = await dialog.boundingBox();
    const organizationBounds = await organization.boundingBox();
    for (version = 1; version <= 2; version += 1) {
      const readsBefore = reads;
      const content = await panel.innerText();
      pending = new Promise<void>(resolve => { finish = resolve; });
      await page.clock.fastForward(60_000);
      await expect.poll(() => reads).toBe(readsBefore + 1);
      await page.clock.runFor(501);
      expect(await dialog.boundingBox()).toEqual(bounds);
      expect(await organization.boundingBox()).toEqual(organizationBounds);
      expect(await panel.innerText()).toBe(content);
      await expect(dialog.getByRole("button", { name: "Close user details" })).toBeFocused();
      await dialog.screenshot({ path: info.outputPath(`user-overview-background-refresh-${version}.png`) });

      finish!();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("alert")).toContainText("This selection changed or expired.");
      await expect(page.getByText(`Updated organization ${version}`, { exact: true })).toHaveCount(0);
      pending = undefined;
      await page.clock.runFor(501);
      expect(reads).toBe(readsBefore + 1);
      await page.getByRole("button", { name: "Restart selection", exact: true }).click();
      await expect.poll(() => reads).toBe(readsBefore + 2);
      await page.getByRole("button", { name: "Ada", exact: true }).click();
      await expect(dialog.getByText(`Updated organization ${version}`, { exact: true })).toBeVisible();
      expect(await dialog.boundingBox()).toEqual(bounds);
      expect(await organization.boundingBox()).toEqual(organizationBounds);
      await expect(dialog.getByRole("button", { name: "Close user details" })).toBeFocused();
    }
    expect(unexpected).toEqual([]);
  } finally {
    finish?.();
  }
});

test("minute checks defer unused inventory and do not reload unchanged visible data", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const requests: string[] = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  const count = (path: string) => requests.filter(value => value === path).length;
  let version = 1;
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture({ users: "users-1", graph_packages: `packages-${version}`, power_platform: "platform-1" }),
    nextCheckAt: layoutTime,
  } }));
  await page.goto("/users");
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
  await expect.poll(() => count("/api/data-sync/auto-refresh")).toBe(1);
  await page.clock.runFor(501);
  const usersReads = count("/api/copilot-usage/users");
  for (let check = 2; check <= 3; check += 1) {
    version = check;
    await page.clock.fastForward(60_000);
    await expect.poll(() => count("/api/data-sync/auto-refresh")).toBe(check);
    await page.clock.runFor(501);
    expect(count("/api/agents")).toBe(0);
    expect(count("/api/agent-inventory")).toBe(0);
    expect(count("/api/inventory/refresh-jobs")).toBe(0);
    expect(count("/api/copilot-usage/users")).toBe(usersReads);
  }
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("button", { name: unifiedAgents.value[0].displayName, exact: true })).toBeVisible();
  expect(count("/api/agent-inventory")).toBe(1);
  await page.clock.fastForward(60_000);
  await expect.poll(() => count("/api/data-sync/auto-refresh")).toBe(4);
  await page.clock.runFor(501);
  expect(count("/api/agent-inventory")).toBe(1);
  expect(unexpected).toEqual([]);
});

test("the icon disappears after login requests settle even while automatic sync continues", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  let checks = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const state: AutomaticRefreshResult = {
    ...automaticRefreshFixture(),
    nextCheckAt: layoutTime,
    run: {
      id: "login-sync", automatic: true, mode: "incremental", status: "running",
      startedAt: layoutTime, updatedAt: layoutTime, completedAt: null,
      sources: [{ source: "users", status: "running", jobId: null, count: null,
        lastSuccessAt: null, updatedAt: layoutTime, message: "", canRetry: false }],
    },
    detailJob: { id: "login-details", status: "waiting_authorization", updatedAt: layoutTime },
  };
  await page.route("**/api/data-sync/auto-refresh", async route => {
    checks += 1;
    if (checks === 1) await pending;
    await route.fulfill({ json: state });
  });
  try {
    await page.goto("/users");
    await expect.poll(() => checks).toBe(1);
    await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeVisible();
    await page.clock.runFor(501);
    const icon = page.getByRole("status", { name: "Background refresh" });
    await expect(icon).toBeVisible();
    await expect(icon).toHaveText("");
    finish();
    await expect(icon).toHaveCount(0);
    await page.clock.fastForward(60_000);
    await expect.poll(() => checks).toBe(2);
    await expect(icon).toHaveCount(0);
    await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Sync", exact: true }).click();
    await expect(page.getByRole("region", { name: "Automatic refresh", exact: true })).toContainText("Refreshing in the background");
    await expect(icon).toHaveCount(0);
    expect(unexpected).toEqual([]);
  } finally {
    finish();
  }
});

test("recovered automatic sync stays free of the stale sign-in warning across subsequent minute checks", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  let result: AutomaticRefreshResult = {
    ...automaticRefreshFixture(),
    nextCheckAt: new Date(Date.parse(layoutTime) + 60_000).toISOString(),
    run: {
      id: "automatic-run", automatic: true, mode: "incremental", status: "partial",
      startedAt: layoutTime, updatedAt: layoutTime, completedAt: layoutTime,
      sources: [{ source: "graph_packages", status: "waiting_authorization", jobId: null, count: null,
        lastSuccessAt: null, updatedAt: layoutTime, message: "Sign in required.", canRetry: true }],
    },
  };
  let checks = 0;
  await page.route("**/api/data-sync/auto-refresh", route => {
    expect(isAutomaticRefreshRequest(route.request())).toBe(true);
    checks += 1;
    return route.fulfill({ json: result });
  });
  await page.goto("/sync");
  const status = page.getByRole("region", { name: "Automatic refresh", exact: true });
  await expect(status.getByRole("link", { name: "Sign in again" })).toBeVisible();
  result = {
    ...result, run: { ...result.run!, id: "recovered-run", status: "running", completedAt: null,
      sources: [{ ...result.run!.sources[0], status: "running", canRetry: false }] },
  };
  await page.clock.fastForward(60_000);
  await expect(status).toContainText("Refreshing in the background");
  await expect(status.getByRole("link", { name: "Sign in again" })).toHaveCount(0);
  result = {
    ...result, run: { ...result.run!, status: "completed", completedAt: layoutTime,
      sources: [{ ...result.run!.sources[0], status: "succeeded", count: 1, lastSuccessAt: layoutTime }] },
  };
  for (let minute = 0; minute < 3; minute += 1) {
    const previousChecks = checks;
    await page.clock.fastForward(60_000);
    await expect.poll(() => checks).toBeGreaterThan(previousChecks);
    await expect(status).toContainText("Automatic refresh · On");
    await expect(status.getByRole("link", { name: "Sign in again" })).toHaveCount(0);
  }
  expect(unexpected).toEqual([]);
});

test("detail permission failures offer permission review instead of another sign-in", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture(),
    detailJob: { id: "denied-detail", status: "failed", errorCode: "missing_permission", updatedAt: layoutTime },
  } satisfies AutomaticRefreshResult }));
  await page.goto("/sync");
  const status = page.getByRole("region", { name: "Automatic refresh", exact: true });
  await expect(status).toContainText("Permission required");
  await expect(status.getByRole("button", { name: "Review permissions" })).toBeVisible();
  await expect(status.getByRole("link", { name: "Sign in again" })).toHaveCount(0);
  expect(unexpected).toEqual([]);
});

test("keeps automatic checks running on other pages without rendering the banner", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install();
  let checks = 0;
  await page.route("**/api/data-sync/auto-refresh", route => {
    checks += 1;
    return route.fulfill({ json: automaticRefreshFixture() });
  });
  await page.goto("/agents");
  await expect.poll(() => checks).toBeGreaterThan(0);
  const banner = page.getByRole("region", { name: "Automatic refresh", exact: true });
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await expect(banner).toHaveCount(0);
  for (const view of ["Users", "Audit", "Permissions", "Agents"]) {
    await navigation.getByRole("button", { name: view, exact: true }).click();
    await expect(banner).toHaveCount(0);
  }
  const before = checks;
  await page.clock.fastForward(60_000);
  await expect.poll(() => checks).toBeGreaterThan(before);
  await navigation.getByRole("button", { name: /^Sync/ }).click();
  await expect(banner).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("opening Sync from inventory attention immediately shows its cause without a diagnostics dialog", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/agents");
  await page.getByRole("button", { name: "Inventory needs attention · Open Sync" }).click();
  const health = page.getByRole("region", { name: "Inventory health", exact: true });
  await expect(health.getByText("Power Platform saved inventory is unavailable.")).toBeVisible();
  await expect(health).toBeInViewport();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const healthBox = await health.boundingBox();
  const csvBox = await page.getByRole("region", { name: "CSV usage reports", exact: true }).boundingBox();
  expect(healthBox!.y + healthBox!.height).toBeLessThanOrEqual(csvBox!.y);
  expect(await new AxeBuilder({ page }).include(".sync-inventory-tools").analyze()).toMatchObject({ violations: [] });
  expect(unexpected).toEqual([]);
});
