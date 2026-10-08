import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { AgentInvestigationContext, PurviewAuditJob, PurviewAuditRecord } from "../src/api/client";
import { capabilityViews, layoutTime, mockLayoutApi, purviewJob, unifiedAgents } from "./layoutFixtures";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { fulfillInventoryPage, isInventorySelectionRequest } from "./selectedInventoryFixture";

const agent = unifiedAgents.value[0];
const target = { recordId: agent.id, botId: "33333333-3333-4333-8333-333333333333", environmentId: "environment-1" };
const savedContext: AgentInvestigationContext = {
  recordId: agent.id, displayName: agent.displayName,
  defender: { status: "unavailable", entraAgentIds: [], reasonCode: "unsupported_identity_crosswalk" },
  purview: { status: "available", mode: "search", presets: ["copilot_studio_admin"] },
};
const auditRecord: PurviewAuditRecord = {
  projectionVersion: 1, wrapperId: "saved-event", nativeEventId: "audit-event-1",
  eventDateTime: layoutTime, operation: "BotCreate", service: "PowerPlatform",
  auditLogRecordType: "powerPlatformAdministratorActivity", resultStatus: "Succeeded",
  actorUserId: null, actorUserPrincipalName: "admin@example.invalid", actorUserType: null,
  objectId: null, clientIp: null, administrativeUnits: [], correlationId: "correlation-1",
  agentId: null, appIdentity: null, appHost: null, botId: target.botId, environmentId: target.environmentId,
  botComponentId: null, aiPluginOperationId: null, messages: [], contentAvailable: false, unknownFieldCount: 0,
};

async function open(page: Page, context = savedContext, denied = false) {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const reads: URL[] = [];
  const writes: string[] = [];
  const checks = { inventory: 0, context: 0 };
  let job: PurviewAuditJob = { ...purviewJob, filters: { ...purviewJob.filters,
    presetId: "copilot_studio_admin", operations: ["BotCreate"], userPrincipalNames: [], agent: target } };
  page.on("request", request => {
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request) && !isInventorySelectionRequest(request)
      && new URL(request.url()).pathname !== "/api/capabilities/check") writes.push(new URL(request.url()).pathname);
  });
  await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), route => route.fulfill({ json: {
    value: capabilityViews.map(view => view.definition.id === "purview.audit.search.delegated"
      ? { ...view, decision: { ...view.decision, authorized: true, status: "available", remediation: [] } } : view),
  } }));
  await page.route("**/api/agent-inventory/investigations/context?**", route => {
    expect(new URL(route.request().url()).searchParams.get("recordId")).toBe(agent.id);
    checks.context++;
    return route.fulfill({ json: context });
  });
  await page.route("**/api/data-sync/auto-refresh", route => {
    checks.inventory++;
    return route.fulfill({ json: {
      ...automaticRefreshFixture({ users: "fixture-users", graph_packages: `activity-${checks.inventory}`, power_platform: "fixture-platform" }),
      nextCheckAt: new Date(Date.parse(layoutTime) + checks.inventory * 60_000).toISOString(),
    } });
  });
  await page.route(url => url.pathname === "/api/agent-inventory", route => fulfillInventoryPage(route, { ...unifiedAgents }));
  await page.route(url => url.pathname === "/api/audit-search/jobs", route => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      expect(body.agentRecordId).toBe(agent.id);
      expect(body.filters).toMatchObject({ presetId: "copilot_studio_admin", userPrincipalNames: [] });
      expect(body.filters.agent).toBeUndefined();
      if (denied) return route.fulfill({ status: 403, json: {
        status: 403, code: "missing_license", detail: "Purview Audit is not available for this tenant.",
      } });
      job = { ...job, status: "partial", pageComplete: false, errorCode: "audit_identity_unresolved",
        unobservedRange: { startDateTime: job.filters.startDateTime, endDateTime: job.filters.endDateTime } };
      return route.fulfill({ status: 202, json: job });
    }
    expect(url.searchParams.get("agentRecordId")).toBe(agent.id);
    reads.push(url);
    return route.fulfill({ json: { value: [job], count: 1, limit: 20, offset: 0 } });
  });
  await page.route(`**/api/audit-search/jobs/${job.id}/records?**`, route =>
    route.fulfill({ json: { value: [auditRecord], count: 1, limit: 100, offset: 0, job } }));
  await page.route(url => url.pathname === `/api/audit-search/jobs/${job.id}`, route => route.fulfill({ json: job }));
  await page.goto("/agents");
  await page.getByRole("button", { name: agent.displayName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: agent.displayName });
  await dialog.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect.poll(() => checks.context).toBe(1);
  return { dialog, unexpected, writes, reads, checks };
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("agent logs use a compact source selector and explicit exact-agent searches with partial results", async ({ page }, info) => {
  const { dialog, unexpected, writes } = await open(page);
  await expect(dialog.getByRole("combobox", { name: "Source" })).toHaveValue("purview");
  await expect(dialog.getByRole("button", { name: "Run Audit Search" })).toBeEnabled();
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "Run Audit Search" }).click();
  await expect.poll(() => writes).toEqual(["/api/audit-search/jobs"]);
  await dialog.getByRole("button", { name: /View results/ }).click();
  await expect(dialog.getByText("admin@example.invalid", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Partial coverage", { exact: true })).toBeVisible();
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Purview log coverage and setup" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("region", { name: "Purview audit records", exact: true }).scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: info.outputPath("agent-purview-results.png") });
  expect(unexpected).toEqual([]);
});

test("unmapped identities and real provider prerequisites remain distinct from empty results", async ({ page }, info) => {
  const { dialog, unexpected, writes } = await open(page, savedContext, true);
  await dialog.getByRole("combobox", { name: "Source" }).selectOption("defender");
  await expect(dialog.getByRole("heading", { name: "Defender linking not supported for this agent" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Run hunt" })).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Source" }).selectOption("purview");
  await dialog.getByRole("button", { name: "Run Audit Search" }).click();
  await expect(dialog.getByText("Purview Audit is not available for this tenant.")).toBeVisible();
  await expect(dialog.getByText("No data", { exact: true })).toHaveCount(0);
  await expect(dialog.locator("details")).toHaveCount(0);
  expect(writes).toEqual(["/api/audit-search/jobs"]);
  expect(unexpected).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("provider-prerequisite.png") });
});

test("agent search and saved results survive refresh, elapsed time and source switching", async ({ page }, info) => {
  const { dialog, unexpected, writes, checks } = await open(page);
  const start = dialog.getByLabel("Start", { exact: true });
  await start.fill("2026-09-12T09:03");
  await dialog.getByRole("button", { name: /View results/ }).click();
  await expect(dialog.getByText("admin@example.invalid", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Refresh investigation access" }).click();
  await expect.poll(() => checks.context).toBe(2);
  await expect(start).toHaveValue("2026-09-12T09:03");
  await page.clock.runFor(60_000);
  await expect(dialog.getByText("admin@example.invalid", { exact: true })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Source" }).selectOption("defender");
  await dialog.getByRole("combobox", { name: "Source" }).selectOption("purview");
  await expect(start).toHaveValue("2026-09-12T09:03");
  await expect(dialog.getByText("admin@example.invalid", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("agent-refresh-preserved.png") });
});
