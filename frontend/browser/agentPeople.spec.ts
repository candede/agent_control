import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityView, InventorySourceAwareDetail, UnifiedAgentRecord } from "../src/api/client";
import { createInventoryVerification, createUnifiedVerification } from "../src/test/inventoryVerification";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const creatorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const nativeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const savedPerson = {
  objectId: ownerId, displayName: "Saved agent owner", userPrincipalName: "saved.owner@example.invalid",
  observedAt: layoutTime,
};

function nativeRecord(): UnifiedAgentRecord {
  return {
    id: "agent:dddddddd-dddd-4ddd-8ddd-dddddddddddd", displayName: nativeId,
    presence: "power_platform", environmentId: "default-synthetic", packages: [],
    powerPlatformResource: {
      tenantId: "layout-tenant", nativeId, type: "microsoft.copilotstudio/agents", location: "europe",
      displayName: null, environmentId: "default-synthetic", createdAt: layoutTime, createdBy: ownerId,
      lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
      agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native",
      identifiers: [{ kind: "power_platform_resource_id", value: nativeId }],
      provenance: {}, details: { ownerId, createdIn: "Copilot Studio Lite", schemaName: nativeId, isQuarantined: false },
      unknownFieldCount: 0,
    },
    people: { owner: savedPerson, createdBy: savedPerson },
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "No source-declared counterpart was saved." },
    observations: {
      graphPackages: null, packageSnapshots: {},
      powerPlatform: {
        id: "native-snapshot", snapshotId: "native-snapshot", current: true, roleScope: "full",
        environmentScope: null, coverage: "covered", coveredCount: 1, observedCount: 1, totalRecords: 1, pageCount: 1,
        observedAt: layoutTime, expiresAt: "2026-10-12T10:00:00Z", verification: createInventoryVerification(1),
      },
    },
  };
}

async function mockPeopleInventory(page: Page, record: UnifiedAgentRecord) {
  const unexpected = await mockLayoutApi(page);
  const summary = { total: 1, linked: 0, graphOnly: 0, powerPlatformOnly: 1, ambiguous: 0, conflicting: 0 };
  await page.route("**/api/agent-inventory?*", route => route.fulfill({ json: {
    ...unifiedAgents, value: [record], count: 1, summary, filteredSummary: summary,
    inventoryOverview: { availableToUsers: 0, organizationCreated: 1, teamsAvailable: 0, createdOrAvailable: 1 },
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 1, logicalAgentCount: 1 }, { sourceScopes: false }),
    sources: {
      graphPackages: { state: "unavailable", observation: null, error: { source: "graph_packages", code: "snapshot_unavailable", message: "No saved Graph inventory." } },
      powerPlatform: { state: "available", observation: record.observations.powerPlatform, error: null },
    },
    errors: [{ source: "graph_packages", code: "snapshot_unavailable", message: "No saved Graph inventory." }],
  } }));
  const related: InventorySourceAwareDetail = {
    source: "power_platform", nativeId, resourceType: record.powerPlatformResource!.type,
    environmentId: record.environmentId, snapshotId: record.observations.powerPlatform!.snapshotId,
    observedAt: layoutTime, expiresAt: "2026-10-12T10:00:00Z", identifiers: [],
    package: { status: "unmatched", reason: "No source-declared counterpart was saved." },
    reports: { status: "unavailable", reason: "No report association was saved." },
    audit: { status: "available", count: 0, value: [] },
    security: { status: "available", count: 0, value: [] },
    controls: { quarantineTarget: null, packageTarget: null },
  };
  await page.route(url => url.pathname === `/api/inventory/resources/${nativeId}/related`, route => {
    expect(route.request().method()).toBe("GET");
    return route.fulfill({ json: related });
  });
  return unexpected;
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("legacy Agent Builder details use saved people without directory permission or a live lookup", async ({ page }, info) => {
  const unexpected = await mockPeopleInventory(page, nativeRecord());
  const lookups: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.includes("/directory/") || path.endsWith("/people/resolve")) lookups.push(request.url());
  });
  await page.goto("/agents");
  await expect(page.getByRole("region", { name: "Unified agents" })).toContainText("Microsoft 365 Copilot Agent Builder");
  await page.getByRole("button", { name: nativeId, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: nativeId, exact: true });
  const information = dialog.getByRole("region", { name: "Agent information" });
  await expect(information.getByText("Built with").locator("..")).toContainText("Microsoft 365 Copilot Agent Builder");
  for (const label of ["Owner", "Created by"]) {
    const person = information.getByText(label, { exact: true }).locator("..");
    await expect(person).toContainText("Saved agent owner");
    await expect(person).toContainText("saved.owner@example.invalid");
    await expect(person).toContainText(ownerId);
  }
  await expect(dialog.getByText(/does not establish whether the agent was deleted/)).toBeVisible();
  await dialog.getByText("Technical details", { exact: true }).click();
  await expect(dialog.getByText("Authoring tool (raw)").locator("..")).toContainText("Copilot Studio Lite");
  await expect(dialog.getByText("Authoring tool", { exact: true }).locator("..")).toContainText("Microsoft 365 Copilot Agent Builder");
  expect(lookups).toEqual([]);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await information.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("unified-agent-people.png") });
  expect(unexpected).toEqual([]);
});

test("missing creator lookup is bounded, shows errors, and retries without hiding the saved owner", async ({ page }) => {
  const record = nativeRecord();
  record.powerPlatformResource!.createdBy = creatorId;
  record.people = { owner: savedPerson };
  const unexpected = await mockPeopleInventory(page, record);
  await page.clock.setFixedTime(new Date(layoutTime));
  const capability: CapabilityView = {
    definition: capabilityDefinitions.find(value => value.id === "graph.directory.read")!,
    decision: {
      capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
      verification: "provider", previewQualification: "not_required", remediation: [],
      checkedAt: "2026-09-12T09:59:00Z", expiresAt: "2026-10-12T10:00:00Z",
    },
  };
  await page.route(url => url.pathname === "/api/capabilities" || url.pathname === "/api/capabilities/check",
    route => route.fulfill({ json: { value: [capability] } }));
  const requests: unknown[] = [];
  await page.route("**/api/agent-inventory/people/resolve", route => {
    requests.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    if (requests.length === 1) return route.fulfill({
      status: 503, json: { code: "provider_error", detail: "Synthetic directory lookup unavailable." },
    });
    record.people = { owner: savedPerson, createdBy: {
      objectId: creatorId, displayName: "Resolved creator", userPrincipalName: "creator@example.invalid",
      observedAt: layoutTime, status: "resolved", expiresAt: "2026-10-12T10:00:00Z",
    } };
    return route.fulfill({ json: { people: record.people, changed: true } });
  });
  const inventoryReads: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/agent-inventory") inventoryReads.push(request.url());
  });
  await page.goto("/agents");
  const table = page.getByRole("region", { name: "Unified agents" });
  await table.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("dialog", { name: "Choose agent columns" }).getByRole("checkbox", { name: "Created by", exact: true }).check();
  await page.keyboard.press("Escape");
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: nativeId, exact: true }).click();
  const information = page.getByRole("region", { name: "Agent information" });
  await expect(information.getByRole("alert")).toContainText("Synthetic directory lookup unavailable.");
  await expect(information.getByText("Owner", { exact: true }).locator("..")).toContainText("Saved agent owner");
  const readsBeforeRetry = inventoryReads.length;
  await information.getByRole("button", { name: "Retry person lookup" }).click();
  await expect(information.getByText("Created by", { exact: true }).locator("..")).toContainText("Resolved creator");
  await expect(information.getByText("Created by", { exact: true }).locator("..")).toContainText("creator@example.invalid");
  expect(requests).toEqual([
    { recordId: record.id },
    { recordId: record.id, force: true },
  ]);
  await expect.poll(() => inventoryReads.length).toBeGreaterThan(readsBeforeRetry);
  await page.getByRole("button", { name: "Close unified agent details" }).click();
  await expect(table.getByRole("row").filter({ has: page.getByRole("button", { name: nativeId, exact: true }) })).toContainText("Resolved creator");
  await page.getByRole("button", { name: nativeId, exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent information" }).getByText("Created by", { exact: true }).locator("..")).toContainText("Resolved creator");
  expect(requests).toHaveLength(2);
  expect(unexpected).toEqual([]);
});

test("fresh negative and failure evidence is not automatically retried and preserves a last known name", async ({ page }) => {
  const record = nativeRecord();
  record.powerPlatformResource!.createdBy = creatorId;
  record.people = {
    owner: { ...savedPerson, status: "lookup_failed", expiresAt: "2026-10-12T10:00:00Z", errorCode: "provider_error" },
    createdBy: { objectId: creatorId, displayName: null, userPrincipalName: null,
      observedAt: layoutTime, status: "not_found", expiresAt: "2026-10-12T10:00:00Z" },
  };
  const unexpected = await mockPeopleInventory(page, record);
  await page.clock.setFixedTime(new Date(layoutTime));
  const capability: CapabilityView = {
    definition: capabilityDefinitions.find(value => value.id === "graph.directory.read")!,
    decision: {
      capabilityId: "graph.directory.read", status: "available", authorized: true, fresh: true,
      verification: "provider", previewQualification: "not_required", remediation: [],
      checkedAt: "2026-09-12T09:59:00Z", expiresAt: "2026-10-12T10:00:00Z",
    },
  };
  await page.route(url => url.pathname === "/api/capabilities" || url.pathname === "/api/capabilities/check",
    route => route.fulfill({ json: { value: [capability] } }));
  const requests: unknown[] = [];
  await page.route("**/api/agent-inventory/people/resolve", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { people: record.people, changed: false } });
  });
  await page.goto("/agents");
  await page.getByRole("button", { name: nativeId, exact: true }).click();
  const information = page.getByRole("region", { name: "Agent information" });
  await expect(information.getByText("Owner", { exact: true }).locator("..")).toContainText("Directory lookup failed. Last known identity shown.");
  await expect(information.getByText("Owner", { exact: true }).locator("..")).toContainText("Saved agent owner");
  await expect(information.getByText("Created by", { exact: true }).locator("..")).toContainText("User not found at the last directory lookup.");
  expect(requests).toEqual([]);
  await information.getByRole("button", { name: "Retry person lookup" }).click();
  await expect(information.getByRole("button", { name: "Retry person lookup" })).toBeVisible();
  expect(requests).toEqual([{ recordId: record.id, force: true }]);
  expect(unexpected).toEqual([]);
});
