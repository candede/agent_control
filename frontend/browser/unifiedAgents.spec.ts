import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { InventorySourceAwareDetail, PowerPlatformResource, UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

const environmentId = "22222222-2222-4222-8222-222222222222";
const botId = "33333333-3333-4333-8333-333333333333";
const observation: NonNullable<UnifiedAgentRecord["observations"]["powerPlatform"]> = {
  id: "44444444-4444-4444-8444-444444444444",
  snapshotId: "44444444-4444-4444-8444-444444444444",
  observedAt: layoutTime, expiresAt: "2026-10-12T09:58:00.000Z", current: true,
  roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 2, observedCount: 2, totalRecords: 2,
};
const resource: PowerPlatformResource = {
  tenantId: "layout-tenant", nativeId: botId, environmentId,
  type: "microsoft.copilotstudio/agents", location: null, displayName: "Service desk assistant",
  createdAt: layoutTime, createdBy: null, lastPublishedAt: layoutTime,
  sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
  agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
  identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }],
  provenance: {}, details: { schemaName: "cr123_serviceDesk", isQuarantined: false }, unknownFieldCount: 0,
};
const primary = unifiedAgents.value[0];
const merged: UnifiedAgentRecord = {
  ...primary, id: `power_platform:${environmentId}:${botId}`, presence: "both", environmentId,
  packages: [
    { ...primary.packages[0], version: "1" },
    { ...unifiedAgents.value[1].packages[0], displayName: "Service desk assistant (Teams)", version: "2" },
  ],
  powerPlatformResource: resource,
  identity: {
    state: "matched", reason: null, packageEvidence: [],
    evidence: [{
      kind: "environment_schema_native_id", basis: "source_declared_metadata", elementIds: ["metadata"],
      packagePath: "AgentMetadatas.SourceIds.EnvironmentId + SchemaName + CdsBotId",
      resourcePath: "environmentId + details.schemaName + nativeId",
    }],
  },
  observations: { ...primary.observations, powerPlatform: observation },
};
const draftId = "55555555-5555-4555-8555-555555555555";
const draft: UnifiedAgentRecord = {
  ...merged, id: `power_platform:${environmentId}:${draftId}`, displayName: "Unpublished helpdesk assistant",
  presence: "power_platform", packages: [], identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "Not published." },
  powerPlatformResource: {
    ...resource, nativeId: draftId, displayName: "Unpublished helpdesk assistant", lifecycle: "draft", lastPublishedAt: null,
    identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: draftId }],
  },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: observation },
};
const summary = { total: 3, linked: 1, graphOnly: 1, powerPlatformOnly: 1, ambiguous: 0, conflicting: 0 };
const catalog: UnifiedAgentInventoryPage = {
  ...unifiedAgents, value: [merged, unifiedAgents.value[2], draft], count: 3,
  summary, filteredSummary: summary, identityCollection: { checkedPackages: 3, pendingPackages: 0 },
  facets: { ...unifiedAgents.facets, environments: [{ value: environmentId, label: "Finance production" }] },
  sources: { ...unifiedAgents.sources, powerPlatform: { state: "available", observation, error: null } },
  partial: false, errors: [],
};

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("one agent row selects all published versions and configuration controls without source columns", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  await page.route("**/api/agent-inventory*", route => route.fulfill({ json: catalog }));
  const related: InventorySourceAwareDetail = {
    source: "power_platform", nativeId: botId, resourceType: resource.type, environmentId, snapshotId: observation.snapshotId,
    observedAt: observation.observedAt, expiresAt: observation.expiresAt, identifiers: resource.identifiers,
    package: { status: "unmatched", reason: "Package controls use the unified record's exact targets." },
    reports: { status: "unavailable", reason: "No saved usage observations." },
    audit: { status: "available", count: 0, value: [] }, security: { status: "available", count: 0, value: [] },
    controls: { quarantineTarget: { environmentId, botId }, packageTarget: null },
  };
  await page.route(`**/api/inventory/resources/${botId}/related*`, route => route.fulfill({ json: related }));
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("checkbox")).toHaveCount(3);
  await expect(table.getByText("Service desk assistant", { exact: true })).toHaveCount(1);
  for (const label of ["Sources", "Link", "Packages", "Power Platform"]) {
    await expect(table.getByRole("columnheader", { name: label, exact: true })).toHaveCount(0);
  }
  await expect(table.getByText("Finance production", { exact: true })).toHaveCount(2);
  await expect(table.getByText("No verified link", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("unified-agent-catalog.png"), fullPage: true });
  const checkbox = table.getByRole("checkbox", { name: "Select Service desk assistant", exact: true });
  await checkbox.check();
  await expect(page.getByRole("region", { name: "Exact package bulk actions" })).toContainText("2 selected");
  await expect(page.getByRole("region", { name: "Copilot Studio quarantine controls" })).toBeVisible();
  await checkbox.uncheck();
  await expect(page.getByRole("region", { name: "Exact package bulk actions" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Copilot Studio quarantine controls" })).toHaveCount(0);

  await table.getByRole("button", { name: "Manage Service desk assistant", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("tab", { name: "Manage", exact: true })).toHaveAttribute("aria-selected", "true");
  if (info.project.name === "mobile") {
    const geometry = await dialog.getByRole("tablist").evaluate(element => ({
      height: element.getBoundingClientRect().height,
      rows: new Set(Array.from(element.querySelectorAll("button")).map(button => Math.round(button.getBoundingClientRect().top))).size,
    }));
    expect(geometry.rows).toBe(2);
    expect(geometry.height).toBeLessThanOrEqual(112);
  }
  await expect(dialog.getByRole("button", { name: "Quarantine", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Manage access for/i }).first()).toBeVisible();
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("unified-agent-manage.png"), fullPage: true });
  await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
  const status = dialog.locator(".agent-summary-status");
  expect(await status.evaluate(element => getComputedStyle(element).display)).toBe("grid");
  expect(await status.locator(":scope > span").evaluateAll(elements => elements.every(element => getComputedStyle(element).display === "block"))).toBe(true);
  const technical = dialog.locator("details").filter({ has: page.locator("summary", { hasText: "Technical details" }) });
  await expect(technical).not.toHaveAttribute("open", "");
  await expect(dialog.getByRole("tablist", { name: "Agent details" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("unified-agent-overview.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});
