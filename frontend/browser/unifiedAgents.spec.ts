import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { InventorySourceAwareDetail, PowerPlatformResource, UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { createInventoryVerification, createUnifiedVerification } from "../src/test/inventoryVerification";

const environmentId = "22222222-2222-4222-8222-222222222222";
const botId = "33333333-3333-4333-8333-333333333333";
const observation: NonNullable<UnifiedAgentRecord["observations"]["powerPlatform"]> = {
  id: "44444444-4444-4444-8444-444444444444",
  snapshotId: "44444444-4444-4444-8444-444444444444",
  observedAt: layoutTime, expiresAt: "2026-10-12T09:58:00.000Z", current: true,
  roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 2, observedCount: 2, totalRecords: 2,
  pageCount: 1, verification: createInventoryVerification(2, ["microsoft.copilotstudio/agents"], layoutTime),
};
const resource: PowerPlatformResource = {
  tenantId: "layout-tenant", nativeId: botId, environmentId,
  type: "microsoft.copilotstudio/agents", location: null, displayName: "Service desk assistant",
  createdAt: layoutTime, createdBy: null, lastPublishedAt: layoutTime,
  sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown",
  agentKind: "copilot_studio_agent", lifecycle: "published", identityConfidence: "exact_native",
  identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }],
  provenance: {}, details: {
    schemaName: "cr123_serviceDesk", isQuarantined: false, ownerId: "Support operations",
    model: "Support language model",
    connectors: [{ connectorId: "Support knowledge connector", operations: [{ operationId: "readKnowledge", usedAs: "Knowledge" }] }],
    connectorDetailsStatus: "complete",
  }, unknownFieldCount: 0,
};
const primary = unifiedAgents.value[0];
const merged: UnifiedAgentRecord = {
  ...primary, id: `power_platform:${environmentId}:${botId}`, presence: "both", environmentId,
  environment: {
    id: environmentId, displayName: "Finance production", region: "europe", environmentType: "Production",
    isManaged: false, groupName: "Finance", groupId: null, provenance: {},
    observation: { ...observation, id: "environment-observation", snapshotId: "environment-observation" },
  },
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
    details: { schemaName: "cr123_helpdesk_draft", isQuarantined: false, ownerId: "Tenant maker" },
    identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: draftId }],
  },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: observation },
};
const summary = { total: 3, linked: 1, graphOnly: 1, powerPlatformOnly: 1, ambiguous: 0, conflicting: 0 };
const catalog: UnifiedAgentInventoryPage = {
  ...unifiedAgents, value: [merged, unifiedAgents.value[2], draft], count: 3,
  summary, filteredSummary: summary, identityCollection: { checkedPackages: 3, pendingPackages: 0 },
  verification: createUnifiedVerification({ graphPackageCount: 3, powerPlatformAgentCount: 2, logicalAgentCount: 3 }, {}, layoutTime),
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
    audit: { status: "available", count: 0, value: [] }, security: { status: "available", count: 0, value: [] },
  };
  await page.route(`**/api/inventory/resources/${botId}/related*`, route => route.fulfill({ json: related }));
  await page.route(`**/api/inventory/resources/${draftId}/related*`, route => route.fulfill({ json: {
    ...related, nativeId: draftId, identifiers: draft.powerPlatformResource!.identifiers,
  } }));
  const detailReads: string[] = [];
  await page.route(`**/api/agents/${encodeURIComponent(merged.packages[0].id)}`, route => {
    detailReads.push(`${route.request().method()} ${merged.packages[0].id}`);
    return route.fulfill({ json: {
    ...merged.packages[0],
    longDescription: "<p><strong>Service desk assistant</strong> helps your employees find support and resolve common requests.</p><h3>How this agent helps</h3><p>Resolve common requests without leaving your conversation.</p><ul><li>Find trusted support knowledge.</li><li>Get guidance for common IT issues.</li></ul>",
    allowedUsersAndGroups: [{ resourceType: "group", resourceId: "service-desk-users" }],
    acquireUsersAndGroups: [],
    elementDetails: [{
      elementType: "AgentMetadatas",
      elements: [{ id: "metadata", definition: JSON.stringify({ connectorId: "Service desk connector" }) }],
    }],
    } });
  });
  await page.route(`**/api/agents/${encodeURIComponent(merged.packages[1].id)}`, route => {
    detailReads.push(`${route.request().method()} ${merged.packages[1].id}`);
    return route.fulfill({ json: {
      ...merged.packages[1], longDescription: "Microsoft Teams edition with its own saved configuration.",
      allowedUsersAndGroups: [], acquireUsersAndGroups: [],
      elementDetails: [{
        elementType: "AgentMetadatas",
        elements: [{ id: "teams-metadata", definition: JSON.stringify({ connectorId: "Teams knowledge connector" }) }],
      }],
    } });
  });
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

  await table.getByRole("button", { name: "View details for Service desk assistant", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const initialBounds = await dialog.boundingBox();
  await expect(dialog.getByText("Resolve common requests without leaving your conversation.")).toBeVisible();
  await expect(dialog.getByText("Support operations", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Support language model", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Support knowledge connector", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Service desk connector", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Details & services|Viewing details|Review usage|Review access/ })).toHaveCount(0);
  expect(detailReads).toEqual([`GET ${merged.packages[0].id}`]);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("unified-agent-overview.png") });
  await dialog.getByRole("region", { name: "Configured connectors and operations", exact: true }).scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: info.outputPath("unified-agent-services.png") });
  await dialog.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect(dialog.getByRole("tab", { name: "Manage", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await dialog.boundingBox()).toEqual(initialBounds);
  if (info.project.name === "mobile") {
    const geometry = await dialog.getByRole("tablist").evaluate(element => ({
      height: element.getBoundingClientRect().height,
      rows: new Set(Array.from(element.querySelectorAll("button")).map(button => Math.round(button.getBoundingClientRect().top))).size,
    }));
    expect(geometry.rows).toBe(2);
    expect(geometry.height).toBeLessThanOrEqual(112);
  }
  await expect(dialog.getByRole("button", { name: "Quarantine", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Manage access for|Manage installation for/ })).toHaveCount(0);
  await expect(dialog.getByRole("heading", { name: "Select who can use this agent" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Specific users or groups/ })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: /Specific users or groups/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /^Block Service desk assistant/ })).toBeVisible();
  await expect(dialog.getByText("service-desk-users", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("unified-agent-manage.png") });
  await dialog.getByRole("button", { name: /^Installed for/ }).click();
  await expect(dialog.getByRole("heading", { name: "Select who this agent is installed for" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /No users/ })).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
  expect(await dialog.boundingBox()).toEqual(initialBounds);
  const status = dialog.locator(".agent-summary-status");
  expect(await status.evaluate(element => getComputedStyle(element).display)).toBe("grid");
  expect(await status.locator(":scope > span").evaluateAll(elements => elements.every(element => getComputedStyle(element).display === "block"))).toBe(true);
  const technical = dialog.locator("details").filter({ has: page.locator("summary", { hasText: "Technical details" }) });
  await expect(technical).not.toHaveAttribute("open", "");
  await expect(dialog.getByRole("tablist", { name: "Agent details" })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Published version details" }).selectOption(merged.packages[1].id);
  await expect(dialog.getByText("Microsoft Teams edition with its own saved configuration.")).toBeVisible();
  await expect(dialog.getByText("Teams knowledge connector", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Resolve common requests without leaving your conversation.")).toHaveCount(0);
  await expect(dialog.getByText("Service desk connector", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Support knowledge connector", { exact: true })).toBeVisible();
  expect(await dialog.boundingBox()).toEqual(initialBounds);
  await expect(dialog.getByRole("heading", { name: "Configured connectors and operations", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await dialog.screenshot({ path: info.outputPath("unified-agent-selected-version.png") });
  await page.keyboard.press("Escape");
  await table.getByRole("button", { name: "View details for Unpublished helpdesk assistant", exact: true }).click();
  const nativeDialog = page.getByRole("dialog", { name: "Unpublished helpdesk assistant" });
  await expect(nativeDialog.getByText("No description provided.")).toBeVisible();
  await expect(nativeDialog.getByText("Tenant maker", { exact: true })).toBeVisible();
  await expect(nativeDialog.getByText("0 references")).toHaveCount(0);
  await expect(nativeDialog.getByText("Microsoft Teams edition with its own saved configuration.")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await nativeDialog.screenshot({ path: info.outputPath("unified-native-agent.png") });
  expect(detailReads).toEqual([`GET ${merged.packages[0].id}`, `GET ${merged.packages[1].id}`]);
  expect(unexpected).toEqual([]);
});
