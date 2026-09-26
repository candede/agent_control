import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { AgentInvestigationContext, PurviewAuditRecord } from "../src/api/client";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";

const agent = unifiedAgents.value[0];
const savedContext: AgentInvestigationContext = {
  recordId: agent.id, displayName: agent.displayName,
  defender: { status: "unavailable", entraAgentIds: [], reasonCode: "unsupported_identity_crosswalk" },
  purview: { status: "available", mode: "saved_only" },
};
const auditRecord: PurviewAuditRecord = {
  projectionVersion: 1, wrapperId: "saved-event", nativeEventId: "audit-event-1",
  eventDateTime: layoutTime, operation: "BotCreate", service: "PowerPlatform",
  auditLogRecordType: "powerPlatformAdministratorActivity", resultStatus: "Succeeded",
  actorUserId: null, actorUserPrincipalName: "admin@example.invalid", actorUserType: null,
  objectId: null, clientIp: null, administrativeUnits: [], correlationId: "correlation-1",
  agentId: null, appIdentity: null, appHost: null, botId: "bot-1", environmentId: "environment-1",
  botComponentId: null, aiPluginOperationId: null, messages: [], contentAvailable: false, unknownFieldCount: 0,
};

async function open(page: Page, context = savedContext) {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const reads: URL[] = [];
  const writes: string[] = [];
  const checks = { inventory: 0, context: 0 };
  page.on("request", request => {
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request)
      && new URL(request.url()).pathname !== "/api/capabilities/check") writes.push(new URL(request.url()).pathname);
  });
  await page.route("**/api/agent-inventory/investigations/context?**", route => {
    expect(new URL(route.request().url()).searchParams.get("recordId")).toBe(agent.id);
    checks.context += 1;
    return route.fulfill({ json: context });
  });
  await page.route("**/api/data-sync/auto-refresh", route => {
    expect(isAutomaticRefreshRequest(route.request())).toBe(true);
    checks.inventory += 1;
    return route.fulfill({ json: {
      ...automaticRefreshFixture({
        users: "fixture-users", graph_packages: `activity-refresh-${checks.inventory}`, power_platform: "fixture-platform",
      }),
      nextCheckAt: new Date(Date.parse(layoutTime) + checks.inventory * 60_000).toISOString(),
    } });
  });
  await page.route(url => url.pathname === "/api/agent-inventory", route => route.fulfill({ json: {
    ...unifiedAgents, revision: String(checks.inventory).padStart(64, "0"),
  } }));
  await page.route("**/api/agent-inventory/investigations/purview?**", route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("recordId")).toBe(agent.id);
    reads.push(url);
    return route.fulfill({ json: {
      recordId: agent.id, mode: "saved_only", count: 51, limit: 50,
      offset: Number(url.searchParams.get("offset")), value: [auditRecord],
    } });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: agent.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: agent.displayName });
  await dialog.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Defender linking not supported for this agent" })).toBeVisible();
  return { dialog, unexpected, writes, reads, checks };
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("both Activity source buttons keep white, readable text on hover", async ({ page }, info) => {
  const { dialog, unexpected, writes } = await open(page);
  const heading = dialog.getByRole("heading", { name: "Agent logs", exact: true });
  for (const name of ["Purview audit", "Defender & Agent 365"]) {
    const source = dialog.getByRole("button", { name, exact: true });
    await heading.hover();
    await expect(source).toHaveAttribute("aria-pressed", "false");
    const restingColor = await source.evaluate(element => getComputedStyle(element).color);
    await source.hover();
    for (const tag of ["strong", "span", "small"]) {
      await expect(source.locator(tag)).toHaveCSS("color", "rgb(255, 255, 255)");
    }
    await expect(source).toHaveAttribute("aria-pressed", "false");
    expect((await new AxeBuilder({ page }).include(".agent-log-sources").withRules(["color-contrast"]).analyze()).violations).toEqual([]);
    await dialog.screenshot({ path: info.outputPath(`${name.startsWith("Purview") ? "purview" : "defender"}-source-hover.png`) });
    await heading.hover();
    await expect(source).toHaveCSS("color", restingColor);
    await source.click();
    await heading.hover();
    await expect(source).toHaveAttribute("aria-pressed", "true");
    const selectedBackground = await source.evaluate(element => getComputedStyle(element).backgroundColor);
    await source.hover();
    for (const tag of ["strong", "span", "small"]) {
      await expect(source.locator(tag)).toHaveCSS("color", "rgb(255, 255, 255)");
    }
    await expect(source).toHaveCSS("background-color", selectedBackground);
  }
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("unmapped agents explain each log source and setup without portal handoffs or technical accordions", async ({ page }, info) => {
  const { dialog, unexpected, writes, reads } = await open(page, {
    ...savedContext, purview: { status: "unavailable", mode: "saved_only", reasonCode: "unsupported_identity_crosswalk" },
  });
  await expect(dialog.getByText("ThreatHunting.Read.All")).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Defender log coverage and setup" })).toContainText("SDK, gateway and MCP");
  await expect(dialog.getByText(/Changing permissions will not create a missing identity mapping/)).toBeVisible();
  await expect(dialog.locator("details:visible")).toHaveCount(0);
  await expect(dialog.getByRole("link")).toHaveCount(0);
  await expect(dialog.getByText("No saved activity is linked to this agent.")).toHaveCount(0);
  await dialog.screenshot({ path: info.outputPath("agent-defender-setup.png") });
  await dialog.getByRole("button", { name: "Purview audit", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Purview log coverage and setup" })).toContainText("Saved records only");
  await expect(dialog.getByText("AuditLogsQuery.Read.All")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Setup & permissions", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Purview linking not supported for this agent" })).toBeVisible();
  await expect(dialog.getByRole("link")).toHaveCount(0);
  expect(reads).toEqual([]);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.screenshot({ path: info.outputPath("agent-purview-setup.png") });
});

test("Purview selection, paging and search survive refresh, one minute of time and source switching", async ({ page }, info) => {
  const { dialog, unexpected, writes, reads, checks } = await open(page);
  await dialog.getByRole("button", { name: "Purview audit", exact: true }).click();
  await expect(dialog.getByText("admin@example.invalid")).toBeVisible();
  await dialog.getByRole("button", { name: "Next audit records" }).click();
  await expect.poll(() => reads.at(-1)?.searchParams.get("offset")).toBe("50");
  await dialog.getByRole("searchbox", { name: "Search saved audit metadata" }).fill("correlation");
  await dialog.getByRole("combobox", { name: "Exact audit operation" }).selectOption("BotCreate");
  await dialog.getByRole("button", { name: "Search saved audit", exact: true }).click();
  await expect.poll(() => reads.at(-1)?.searchParams.get("search")).toBe("correlation");
  expect(reads.at(-1)?.searchParams.get("offset")).toBe("0");
  const count = reads.length;
  await dialog.getByRole("button", { name: "Refresh investigation access" }).click();
  await expect.poll(() => reads.length).toBe(count + 1);
  const contextChecks = checks.context;
  await page.clock.runFor(65_000);
  await expect.poll(() => checks.inventory).toBeGreaterThan(1);
  await expect.poll(() => checks.context).toBeGreaterThan(contextChecks);
  await expect(dialog.getByRole("button", { name: "Purview audit", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("searchbox", { name: "Search saved audit metadata" })).toHaveValue("correlation");
  await expect(dialog.getByRole("combobox", { name: "Exact audit operation" })).toHaveValue("BotCreate");
  await dialog.getByRole("button", { name: "Defender & Agent 365", exact: true }).click();
  await dialog.getByRole("button", { name: "Purview audit", exact: true }).click();
  await expect(dialog.getByRole("searchbox", { name: "Search saved audit metadata" })).toHaveValue("correlation");
  await expect(dialog.getByText("audit-event-1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("correlation-1", { exact: true })).toBeVisible();
  await expect(dialog.locator("details:visible")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("region", { name: "Agent Purview records" }).scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: info.outputPath("agent-purview-records.png") });
});
