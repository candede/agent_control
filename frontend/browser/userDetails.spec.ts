import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { layoutTime, mockLayoutApi } from "./layoutFixtures";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { selectedFixtureRead } from "../src/test/selectedUsageFixture";
import { responsibilityFixture } from "../src/test/agentResponsibilityFixture";

async function openUser(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const reads = { users: 0, responsibility: 0, refresh: 0 };
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request)
      && new URL(request.url()).pathname !== "/api/capabilities/check") writes.push(new URL(request.url()).pathname);
  });
  await page.route(url => url.pathname.startsWith("/api/copilot-usage/users"), route => {
    if (new URL(route.request().url()).pathname === "/api/copilot-usage/users") reads.users += 1;
    const body = selectedFixtureRead(route.request().url());
    expect(body, "Every user detail and child read uses an exact selected contract").toBeDefined();
    return route.fulfill({ json: body });
  });
  await page.route("**/api/agent-responsibility?**", route => {
    reads.responsibility += 1;
    return route.fulfill({ json: responsibilityFixture(new URL(route.request().url()).searchParams.get("objectId") ?? undefined,
      { now: Date.parse(layoutTime) }) });
  });
  await page.route("**/api/data-sync/auto-refresh", route => {
    expect(isAutomaticRefreshRequest(route.request())).toBe(true);
    reads.refresh += 1;
    return route.fulfill({ json: {
      ...automaticRefreshFixture({ users: `user-refresh-${reads.refresh}`, graph_packages: "fixture-packages", power_platform: "fixture-platform" }),
      nextCheckAt: new Date(Date.parse(layoutTime) + reads.refresh * 60_000).toISOString(),
    } });
  });
  await page.goto("/users");
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  return { dialog: page.getByRole("dialog", { name: "Ada", exact: true }), reads, writes, unexpected };
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("user Logs offers human-attributed Defender invocations without starting a query on open", async ({ page }, info) => {
  const { dialog, writes, unexpected } = await openUser(page);
  const scopes: string[] = [];
  await page.route("**/api/hunting/jobs?**", route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("agentRecordId")).toBeNull();
    const human = url.searchParams.get("userObjectId");
    expect(human).toMatch(/^[0-9a-f-]{36}$/i);
    scopes.push(human!);
    return route.fulfill({ json: { value: [], count: 0, limit: 20, offset: 0 } });
  });
  await dialog.getByRole("tab", { name: "Logs", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Source" }).selectOption("defender");
  await expect(dialog.getByText("No hunting history", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Log type" }).locator("option")).toHaveText(["Agent invocations"]);
  await expect(dialog.getByText(/Tool and inference events identify the agent account/)).toBeVisible();
  await expect(dialog.locator("details")).toHaveCount(0);
  expect(scopes).toHaveLength(1);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.screenshot({ path: info.outputPath("user-defender-logs.png") });
});

test("user details organize useful data into consistent accessible tabs without disclosures", async ({ page }, info) => {
  const { dialog, reads, writes, unexpected } = await openUser(page);
  await expect(dialog.getByRole("tab")).toHaveText(["Overview", "Usage & agents", "Licenses", "Responsibility", "Logs"]);
  await expect(dialog.getByRole("region", { name: "Saved directory organization" })).toContainText("Contoso Health");
  await expect(dialog.getByLabel("User summary")).toContainText("200");
  await expect(dialog.getByText("Agent report dates", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Aug 14, 2026 - Sep 12, 2026", { exact: true })).toBeVisible();
  expect(reads.responsibility).toBe(0);
  const bounds = await dialog.boundingBox();
  await dialog.screenshot({ path: info.outputPath("user-overview.png") });

  for (const [tab, screenshot] of [
    ["Usage & agents", "user-usage"], ["Licenses", "user-licenses"], ["Responsibility", "user-responsibility"], ["Logs", "user-purview"],
  ]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    await expect(dialog.getByRole("tabpanel")).toHaveAccessibleName(tab);
    if (tab === "Usage & agents") {
      await expect(dialog.getByRole("region", { name: "User agent breakdown" })).toContainText("Researcher");
      await expect(dialog.getByRole("region", { name: "User Office app activity" })).toContainText("Word");
      await expect(dialog.getByRole("columnheader", { name: "Agent-wide last activity", exact: true })).toBeVisible();
    } else if (tab === "Licenses") {
      await expect(dialog.getByRole("list", { name: "Paid feature states" })).toContainText("Microsoft 365 Copilot in Productivity Apps");
      await expect(dialog.getByText("Assigned Aug 1, 2026", { exact: true })).toBeVisible();
    } else if (tab === "Responsibility") {
      await expect(dialog.getByRole("button", { name: "Open agent Responsible agent", exact: true })).toBeVisible();
      await expect(dialog.getByText("Responsible only", { exact: true })).toHaveCount(0);
    } else {
      await expect(dialog.getByRole("heading", { name: "Search Purview logs", exact: true })).toBeVisible();
      await expect(dialog.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
      await expect(dialog.getByRole("textbox", { name: "User principal names", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("region", { name: "Available audit logs", exact: true })).toHaveCount(0);
    }
    await expect(dialog.locator("details")).toHaveCount(0);
    await expect(dialog.getByText(/containing bundle alone|Raw capability status|Owner, Created by and Last modified|not a daily event log/)).toHaveCount(0);
    expect(await dialog.boundingBox()).toEqual(bounds);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await dialog.getByRole("tabpanel").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include("dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await dialog.screenshot({ path: info.outputPath(`${screenshot}.png`) });
  }
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("user tabs and agent filters persist through real refreshes with keyboard navigation", async ({ page }) => {
  const { dialog, reads, writes, unexpected } = await openUser(page);
  await dialog.getByRole("tab", { name: "Overview", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: "Usage & agents", exact: true })).toBeFocused();
  const search = dialog.getByRole("searchbox", { name: "Search this user's agents", exact: true });
  await search.fill("research");
  await dialog.getByRole("tab", { name: "Licenses", exact: true }).click();
  await dialog.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await expect(search).toHaveValue("research");
  const userReads = reads.users;
  await page.clock.runFor(65_000);
  await expect.poll(() => reads.users).toBeGreaterThan(userReads);
  await expect(dialog.getByRole("tab", { name: "Usage & agents", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveValue("research");
  await dialog.getByRole("tab", { name: "Usage & agents", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: "Logs", exact: true })).toBeFocused();
  const preset = dialog.getByRole("combobox", { name: "Search preset", exact: true });
  await preset.selectOption("copilot_studio_admin");
  const purviewUserReads = reads.users;
  await page.clock.runFor(65_000);
  await expect.poll(() => reads.users).toBeGreaterThan(purviewUserReads);
  await expect(dialog.getByRole("tab", { name: "Logs", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(preset).toHaveValue("copilot_studio_admin");
  await dialog.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await expect(search).toHaveValue("research");
  await dialog.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect(preset).toHaveValue("copilot_studio_admin");
  await dialog.getByRole("tab", { name: "Logs", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeFocused();
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});
