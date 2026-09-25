import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { UnifiedAgentRecord } from "../src/api/client";
import { createInventoryVerification } from "../src/test/inventoryVerification";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { isAutomaticRefreshRequest } from "./automaticRefreshFixtures";

const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const creator = "52bff06b-5db5-42cd-9919-28f95e3c07af";
const observation: NonNullable<UnifiedAgentRecord["observations"]["powerPlatform"]> = {
  id: "agent-configuration", snapshotId: "agent-configuration", observedAt: layoutTime,
  expiresAt: "2026-10-12T12:00:00Z", current: true, roleScope: "full", environmentScope: null,
  coverage: "covered", coveredCount: 1, observedCount: 1, totalRecords: 1, pageCount: 1,
  verification: createInventoryVerification(1, ["microsoft.copilotstudio/agents"], layoutTime),
};
const record: UnifiedAgentRecord = {
  ...unifiedAgents.value[0], id: "agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  displayName: "Context review agent", presence: "power_platform", packages: [], environmentId,
  environment: {
    id: environmentId, displayName: "Finance production", region: "europe", environmentType: "Production",
    isManaged: false, groupName: "Finance", groupId: null,
    observation: { ...observation, id: "environment-context", snapshotId: "environment-context", observedAt: "2026-09-11T08:00:00Z" },
    provenance: { isManaged: { sourceSystem: "power_platform", path: "properties.isManaged", maturity: "ga" } },
  },
  powerPlatformResource: {
    tenantId: "layout-tenant", nativeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", environmentId,
    type: "microsoft.copilotstudio/agents", displayName: "Context review agent", location: "europe",
    createdAt: layoutTime, createdBy: creator, lastPublishedAt: layoutTime, sourceSystem: "power_platform",
    authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent", lifecycle: "published",
    identityConfidence: "exact_native", identifiers: [], unknownFieldCount: 0,
    provenance: { connectors: { sourceSystem: "power_platform", path: "properties.powerPlatformConnectors", maturity: "preview" } },
    details: {
      ownerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", lastModifiedBy: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      model: "Configured model", isWebSearchEnabledForKnowledge: false, isManaged: true,
      connectorDetailsStatus: "partial", distinctPowerPlatformConnectors: 4, distinctPowerPlatformConnectorsOperations: 9,
      connectors: [{ connectorId: "shared_excelonlinebusiness", operations: [{
        operationId: "RunScriptProd", createdBy: creator, usedAs: "Topic Tool", isEnabled: false,
        requiresEndUserConsent: false, connectionProvider: "Maker", whenCanBeUsed: "ViaDirectReferenceOnly",
      }] }],
    },
  },
  identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: observation },
};

async function open(page: Page, value: UnifiedAgentRecord) {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request)) writes.push(new URL(request.url()).pathname);
  });
  const summary = { total: 1, linked: 0, graphOnly: value.packages.length ? 1 : 0, powerPlatformOnly: value.packages.length ? 0 : 1, ambiguous: 0, conflicting: 0 };
  const inventoryScope = value.packages.length ? "catalog" : "power_platform_only";
  await page.route("**/api/agent-inventory*", route => route.fulfill({ json: {
    ...unifiedAgents, value: [value], count: 1, summary, filteredSummary: summary,
    inventoryScope, scopeSummary: summary,
    facets: { environments: value.environment ? [{ value: environmentId, label: value.environment.displayName }] : [], platforms: [] },
  } }));
  if (value.powerPlatformResource) await page.route(`**/api/inventory/resources/${value.powerPlatformResource.nativeId}/related*`, route => {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("snapshotId")).toBe(observation.snapshotId);
    expect(query.get("environmentId")).toBe(environmentId);
    return route.fulfill({ json: {
      source: "power_platform", nativeId: value.powerPlatformResource!.nativeId,
      resourceType: "microsoft.copilotstudio/agents", environmentId, snapshotId: observation.snapshotId,
      observedAt: observation.observedAt, expiresAt: observation.expiresAt, identifiers: [],
      audit: { status: "unmatched" }, security: { status: "unmatched" },
    } });
  });
  await page.goto(inventoryScope === "catalog" ? "/agents" : "/agents?inventory=power_platform_only");
  await expect.poll(() => writes).toEqual(["/api/capabilities/check"]);
  writes.length = 0;
  await page.getByRole("button", { name: `View details for ${value.displayName}`, exact: true }).click();
  return { dialog: page.getByRole("dialog"), unexpected, writes };
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("saved environment, distinct responsibilities and configured operations stay meaningful on desktop and mobile", async ({ page }, info) => {
  const { dialog, unexpected, writes } = await open(page, record);
  const field = (name: string) => dialog.locator("dt").filter({ hasText: new RegExp(`^${name}$`) }).locator("..");
  await expect(field("Owner")).toContainText(record.powerPlatformResource!.details.ownerId!);
  await expect(field("Created by")).toContainText(creator);
  await expect(field("Last modified by")).toContainText(record.powerPlatformResource!.details.lastModifiedBy!);
  await expect(field("Environment name")).toContainText("Finance production");
  await expect(field("Region")).toContainText("europe");
  await expect(field("Managed environment")).toContainText("No");
  await expect(field("Managed solution")).toContainText("Yes");
  await expect(field("Environment observed").locator("time")).toHaveAttribute("datetime", "2026-09-11T08:00:00Z");
  await expect(field("Reported connector total")).toContainText("4");
  await expect(field("Reported operation total")).toContainText("9");
  await expect(dialog.getByText(/1 saved connector details; 1 saved operation details \(partial\)/)).toBeVisible();
  await expect(field("Used as")).toContainText("Topic Tool");
  await expect(field("Enabled")).toContainText("No");
  await expect(field("End-user consent required")).toContainText("No");
  await expect(field("When available")).toContainText("Via Direct Reference Only");
  await expect(field("Operation configured by \\(ID\\)")).toContainText(creator);
  await expect(dialog.getByText(/do not establish invoked-flow relationships/)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Copilot Studio (console landing page)" })).toHaveAttribute("href", "https://copilotstudio.microsoft.com/");
  await expect(dialog.getByRole("link", { name: "Power Platform admin center (console landing page)" })).toHaveAttribute("href", "https://admin.powerplatform.microsoft.com/");
  await expect(dialog.getByText("Configuration and environment source evidence").locator("..")).not.toHaveAttribute("open");
  expect(await dialog.locator(".inventory-detail-section").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("agent-context-responsibility-environment.png") });
  await field("Environment observed").scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: info.outputPath("agent-context-environment.png") });
  await dialog.getByRole("region", { name: "Configured connectors and operations" }).scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: info.outputPath("agent-context-configured-operations.png") });
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("sparse Graph-only metadata does not manufacture native dependencies or environment facts", async ({ page }) => {
  const pkg = unifiedAgents.value[0].packages[0];
  const value: UnifiedAgentRecord = {
    ...record, presence: "graph_packages", environmentId: null, environment: null, packages: [pkg], powerPlatformResource: null,
    observations: unifiedAgents.value[0].observations,
  };
  const { dialog, unexpected, writes } = await open(page, value);
  await expect(dialog.getByText(/did not establish an environment identity/)).toBeVisible();
  await expect(dialog.getByText(/Missing details do not mean no configured connectors/)).toBeVisible();
  await expect(dialog.getByText(/No configured connectors were reported/)).toHaveCount(0);
  await expect(dialog.getByText(/do not establish invoked-flow relationships/)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Microsoft 365 admin center (console landing page)" })).toHaveAttribute("href", "https://admin.microsoft.com/");
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("explicit empty connectors and zero totals remain distinct from unavailable invoked flows", async ({ page }) => {
  const value = { ...record, environment: null, powerPlatformResource: { ...record.powerPlatformResource!, details: {
    connectors: [], connectorDetailsStatus: "complete" as const, distinctPowerPlatformConnectors: 0, distinctPowerPlatformConnectorsOperations: 0,
  } } };
  const { dialog, unexpected, writes } = await open(page, value);
  await expect(dialog.getByText("Reported connector total").locator("..")).toContainText("0");
  await expect(dialog.getByText("Reported operation total").locator("..")).toContainText("0");
  await expect(dialog.getByText("No configured connectors were reported.")).toBeVisible();
  await expect(dialog.getByText(/No current authorized saved environment metadata/)).toBeVisible();
  await expect(dialog.getByText(/do not establish invoked-flow relationships/)).toBeVisible();
  await expect(dialog.getByText(/Capability details are partial/)).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});
