import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { projectAgentResponsibility } from "../../backend/scripts/agentResponsibilityOracle";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { selectedUsersPage } from "../src/test/selectedUsageFixture";
import { createInventoryVerification, createUnifiedVerification } from "../src/test/inventoryVerification";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { fulfillInventoryPage, inventoryFixtureQuery, isInventorySelectionRequest } from "./selectedInventoryFixture";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const agentId = "agent:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observation: NonNullable<UnifiedAgentRecord["observations"]["powerPlatform"]> = {
  id: "responsibility-snapshot", snapshotId: "responsibility-snapshot", current: true, observedAt: layoutTime,
  expiresAt: "2099-09-12T00:00:00Z", roleScope: "full", environmentScope: null, coverage: "covered",
  coveredCount: 1, observedCount: 1, totalRecords: 1, pageCount: 1,
  verification: createInventoryVerification(1, ["microsoft.copilotstudio/agents"], layoutTime),
};
const record: UnifiedAgentRecord = {
  id: agentId, displayName: "Responsibility review agent", presence: "power_platform", environmentId: "environment",
  packages: [], identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: observation },
  powerPlatformResource: {
    tenantId: "layout-tenant", nativeId: "native-responsibility", type: "microsoft.copilotstudio/agents", environmentId: "environment",
    displayName: "Responsibility review agent", location: null, createdAt: null, createdBy: other, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {}, unknownFieldCount: 0,
    details: { ownerId: owner, lastModifiedBy: owner },
  },
  people: {
    owner: { objectId: owner, displayName: "Same name", userPrincipalName: "responsible.only@example.invalid", observedAt: layoutTime, status: "resolved" },
    createdBy: { objectId: other, displayName: "Same name", userPrincipalName: "different.person@example.invalid", observedAt: layoutTime, status: "resolved" },
    lastModifiedBy: { objectId: owner, displayName: "Same name", userPrincipalName: "responsible.only@example.invalid", observedAt: layoutTime, status: "resolved" },
  },
};

function inventory(records = [record]): UnifiedAgentInventoryPage {
  const summary = { total: records.length, linked: 0, graphOnly: 0, powerPlatformOnly: records.length, ambiguous: 0, conflicting: 0 };
  return { ...unifiedAgents, value: records, counts: { total: records.length, scoped: records.length, filtered: records.length, packageTargets: 0 },
    summary, filteredSummary: summary,
    inventoryScope: "all", scopeSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: records.length, logicalAgentCount: records.length }),
    sources: { graphPackages: unifiedAgents.sources.graphPackages, powerPlatform: { state: "available", observation, error: null } },
    partial: false, errors: [], identityCollection: { checkedPackages: 0, pendingPackages: 0 } };
}

async function fixture(page: Page, records = [record]) {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const requests: string[] = [];
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    requests.push(path);
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request) && !isInventorySelectionRequest(request)) writes.push(path);
  });
  await page.route(url => url.pathname === "/api/agent-inventory", route => {
    const query = inventoryFixtureQuery(route);
    const exact = query.get("recordId");
    const data = inventory(records);
    const inventoryScope = exact ? "all" : query.get("inventoryScope") === "catalog" ? "catalog" : "power_platform_only";
    const scoped = inventoryScope === "catalog" ? inventory([]) : data;
    const value = exact ? records.filter(record => record.id === exact) : scoped.value;
    return fulfillInventoryPage(route, { ...data, inventoryScope, scopeSummary: scoped.summary,
      value, counts: { ...data.counts, scoped: scoped.summary.total, filtered: value.length },
      filteredSummary: { ...scoped.summary, total: value.length } });
  });
  await page.route("**/api/agent-responsibility*", route => {
    const query = new URL(route.request().url()).searchParams;
    const objectId = query.get("objectId") ?? undefined;
    const paid = selectedUsersPage().value.find(user => user.directory.objectId === objectId);
    const known = !objectId || records.some(record => Object.values(record.people ?? {}).some(person => person.objectId === objectId)) || paid;
    if (!known) return route.fulfill({ status: 404, json: { detail: "Exact saved person unavailable", code: "responsibility_person_unavailable" } });
    return route.fulfill({ json: projectAgentResponsibility(inventory(records), {
      objectId, search: query.get("search") ?? undefined, limit: Number(query.get("limit") ?? 50), cursor: query.get("cursor") ?? undefined,
    }, paid ? { ...paid.directory, observedAt: layoutTime } : undefined) });
  });
  await page.route(url => [owner, other].some(id => url.pathname === `/api/copilot-usage/users/${id}`),
    route => route.fulfill({ status: 404, json: { code: "data_record_not_found", detail: "Record is not in the selected cohort." } }));
  await page.route("**/api/inventory/resources/native-responsibility/related*", route => route.fulfill({ json: {
    source: "power_platform", nativeId: "native-responsibility", resourceType: "microsoft.copilotstudio/agents",
    environmentId: "environment", snapshotId: observation.snapshotId, observedAt: layoutTime, expiresAt: observation.expiresAt,
    identifiers: [], audit: { status: "unmatched" }, security: { status: "unmatched" },
  } }));
  return { unexpected, requests, writes };
}

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

test("agent to exact responsible user outside paid/report cohorts and back to current canonical Overview", async ({ page }, info) => {
  const evidence = await fixture(page);
  await page.goto("/agents?inventory=power_platform_only");
  await page.getByRole("button", { name: "View details for Responsibility review agent", exact: true }).click();
  const ownerField = page.getByRole("dialog").locator("dt").filter({ hasText: /^Owner$/ }).locator("..");
  await ownerField.getByRole("button", { name: "View responsibility for Same name", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/users\\?detail=${owner}&tab=responsibility`));
  const user = page.getByRole("dialog", { name: "Same name", exact: true });
  await expect(user.getByRole("tab", { name: "Responsibility", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(user.getByText("responsible.only@example.invalid", { exact: true })).toBeVisible();
  await expect(user.getByText("Owner", { exact: true })).toBeVisible();
  await expect(user.getByText("Last modified by", { exact: true })).toBeVisible();
  await expect(user.getByText(/profile, license and usage details are unavailable/)).toBeVisible();
  await expect(user.getByText("Created by", { exact: true })).toHaveCount(0);
  expect(evidence.requests).toContain(`/api/copilot-usage/users/${owner}`);
  expect(evidence.requests).not.toContain("/api/official-usage/users");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await user.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await user.getByRole("tabpanel").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await user.screenshot({ path: info.outputPath("exact-user-responsibility.png") });
  await page.getByRole("button", { name: "Open agent Responsibility review agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Responsibility review agent" })).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?.*detail=agent%3Abbbbbbbb/);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(user.getByText("responsible.only@example.invalid", { exact: true })).toBeVisible();
  expect(evidence.writes).toEqual(["/api/capabilities/check"]);
  expect(evidence.unexpected).toEqual([]);
});

test("Users keeps two cohorts and creator links open the exact user's Responsibility tab", async ({ page }, info) => {
  const evidence = await fixture(page);
  await page.goto("/users");
  const metrics = page.getByLabel("M365 Copilot license summary");
  await expect(metrics.getByText("4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("200", { exact: true }).first()).toBeVisible();
  await dialog.getByRole("tab", { name: "Responsibility", exact: true }).click();
  await expect(dialog.getByText(/No responsibilities reported for this user in the available inventory/)).toBeVisible();
  await dialog.getByRole("button", { name: "Close user details" }).click();
  await expect(page.getByRole("combobox", { name: "User cohort" }).locator("option")).toHaveText([
    "Paid M365 Copilot users", "Active users without paid Copilot",
  ]);
  await page.goto("/agents?inventory=power_platform_only");
  await page.getByRole("button", { name: "View details for Responsibility review agent", exact: true }).click();
  const creator = page.getByRole("dialog").locator("dt").filter({ hasText: /^Created by$/ }).locator("..");
  await creator.getByRole("button", { name: "View responsibility for Same name", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/users\\?detail=${other}&tab=responsibility`));
  const user = page.getByRole("dialog", { name: "Same name", exact: true });
  await expect(user.getByText("different.person@example.invalid", { exact: true })).toBeVisible();
  await expect(user.getByText("Created by", { exact: true })).toBeVisible();
  await expect(user.getByText("Owner", { exact: true })).toHaveCount(0);
  await expect(user.getByText("Last modified by", { exact: true })).toHaveCount(0);
  await user.screenshot({ path: info.outputPath("creator-responsibility.png") });
  await user.getByRole("button", { name: "Close user details" }).click();
  await expect(page.getByRole("combobox", { name: "User cohort" })).toBeFocused();
  await expect(page.getByRole("button", { name: "All responsible people" })).toHaveCount(0);
  await expect(metrics.getByText("4", { exact: true })).toBeVisible();
  expect(evidence.writes.every(path => path === "/api/capabilities/check")).toBe(true);
  expect(evidence.unexpected).toEqual([]);
});

test("responsibility rows wrap long agent names and distinguish all saved roles without coverage banners or disclosures", async ({ page }, info) => {
  const longName = `Long agent ${"identifier".repeat(20)}`;
  const longRecord = { ...record, displayName: longName,
    powerPlatformResource: { ...record.powerPlatformResource!, createdBy: owner },
    people: { ...record.people, createdBy: record.people!.owner },
  };
  const evidence = await fixture(page, [longRecord]);
  const data = projectAgentResponsibility(inventory([longRecord]), { objectId: owner });
  data.sources.powerPlatform = { state: "partial", observation: { ...observation, coverage: "not_requested", coveredCount: null },
    error: { source: "power_platform", code: "coverage_unknown", message: "The saved agent query is incomplete." } };
  await page.route("**/api/agent-responsibility*", route => route.fulfill({ json: data }));
  await page.goto(`/users?detail=${owner}&tab=responsibility`);
  const dialog = page.getByRole("dialog", { name: "Same name", exact: true });
  const agents = dialog.getByRole("list", { name: "Agents with saved responsibility", exact: true });
  await expect(agents.getByRole("button", { name: `Open agent ${longName}`, exact: true })).toBeVisible();
  await expect(dialog.getByText("1 agent", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Partial agent inventory|Some relationships may be missing|Refresh agent inventory/)).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Agent responsibility", exact: true }).locator(".copilot-users-notice")).toHaveCount(0);
  for (const role of ["Owner", "Created by", "Last modified by"]) await expect(agents.getByText(role, { exact: true })).toBeVisible();
  for (const region of [dialog, dialog.getByRole("tabpanel"), agents]) {
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await expect(dialog.locator("details")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include("dialog[open]").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("responsibility-long-name.png") });
  expect(evidence.unexpected).toEqual([]);
});

test("creator links use the full saved user modal independently of cohort membership", async ({ page }, info) => {
  const evidence = await fixture(page);
  const directory = selectedUsersPage();
  const profile = { ...directory.value[0], entitlement: "no_paid", copilotServiceState: "disabled",
    directory: { ...directory.value[0].directory, objectId: other, displayName: "Exact creator", userPrincipalName: "different.person@example.invalid" } };
  await page.route(url => url.pathname === `/api/copilot-usage/users/${other}`, route => {
    expect(new URL(route.request().url()).searchParams.has("selectionId")).toBe(false);
    return route.fulfill({ json: { value: profile, selection: directory.selection, reports: directory.reports, sources: directory.sources } });
  });
  await page.goto("/agents?inventory=power_platform_only");
  await page.getByRole("button", { name: "View details for Responsibility review agent", exact: true }).click();
  const creator = page.getByRole("dialog").locator("dt").filter({ hasText: /^Created by$/ }).locator("..");
  await creator.getByRole("button", { name: "View responsibility for Same name", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Exact creator", exact: true });
  await expect(dialog.getByRole("tab", { name: "Responsibility", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "Open agent Responsibility review agent", exact: true })).toBeVisible();
  await expect(dialog.getByText(/profile, license and usage details are unavailable/)).toHaveCount(0);
  await expect(dialog.getByText("Created by", { exact: true })).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("synced-creator-responsibility.png") });
  await dialog.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Saved directory organization", exact: true })).toContainText("Contoso Health");
  await expect(dialog.getByRole("group", { name: "User summary", exact: true })).toContainText("200");
  await page.goBack();
  await expect(dialog.getByRole("tab", { name: "Responsibility", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("button", { name: "Close user details" }).click();
  await expect(page.getByRole("region", { name: "M365 Copilot license status", exact: true }).getByText("Exact creator", { exact: true })).toHaveCount(0);
  expect(evidence.unexpected).toEqual([]);
  expect(evidence.writes.every(path => path === "/api/capabilities/check")).toBe(true);
});

test("unresolved people retain negative evidence, invalid deep links do not request guessed profiles, and denied reads retry explicitly", async ({ page }) => {
  const unresolved: UnifiedAgentRecord = { ...record, people: {
    owner: { ...record.people!.owner!, status: "not_found", displayName: null, userPrincipalName: null },
    createdBy: { ...record.people!.createdBy!, status: "lookup_failed", errorCode: "provider_error", displayName: null, userPrincipalName: null },
  } };
  const evidence = await fixture(page, [unresolved]);
  await page.goto("/agents?inventory=power_platform_only");
  await page.getByRole("button", { name: "View details for Responsibility review agent", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: /View responsibility/ })).toHaveCount(0);
  await expect(page.getByText("User not found at the last directory lookup.")).toBeVisible();
  await page.goto("/users?view=responsibility&person=Alice");
  await expect(page.getByRole("alert")).toContainText("an exact directory object ID is required");
  expect(evidence.requests).not.toContain("/api/agent-responsibility");
  await page.goto(`/users?detail=${owner}&tab=responsibility`);
  await expect(page.getByText("User not found at the last directory lookup.")).toBeVisible();
  await page.route("**/api/agent-responsibility*", route => route.fulfill({ status: 403, json: { detail: "Saved responsibility access denied", code: "forbidden" } }));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Saved responsibility access denied" })).toBeVisible();
  await expect(page.getByText("Responsibility review agent", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry saved responsibility" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Saved responsibility access denied" })).toBeVisible();
  expect(evidence.writes.every(path => path === "/api/capabilities/check")).toBe(true);
  expect(evidence.unexpected).toEqual([]);
});

test("unavailable sources and removed canonical agents fail explicitly rather than guessing by name", async ({ page }) => {
  const evidence = await fixture(page);
  const data = projectAgentResponsibility(inventory(), { objectId: owner });
  data.sources.powerPlatform = { state: "unavailable", observation: null, error: { source: "power_platform", code: "snapshot_unavailable", message: "No current source." } };
  data.selected = { ...data.selected!, agents: [], count: 0, state: "unavailable" };
  await page.route("**/api/agent-responsibility*", route => route.fulfill({ json: data }));
  await page.goto(`/users?detail=${owner}&tab=responsibility`);
  await expect(page.getByText(/relationships are unknown, not zero/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Open agent/ })).toHaveCount(0);
  await page.route("**/api/agent-responsibility*", route => route.fulfill({ json: projectAgentResponsibility(inventory(), { objectId: owner }) }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Open agent Responsibility review agent" })).toBeVisible();
  await page.route(url => url.pathname === "/api/agent-inventory", route => fulfillInventoryPage(route, inventory([])));
  await page.route(url => url.pathname === `/api/agent-inventory/${encodeURIComponent(inventory().value[0].id)}/detail`,
    route => route.fulfill({ status: 404, json: { code: "record_not_found", detail: "The exact agent is not available in the current saved inventory." } }));
  await page.getByRole("button", { name: "Open agent Responsibility review agent" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The exact agent is not available in the current saved inventory." })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(evidence.writes.every(path => path === "/api/capabilities/check")).toBe(true);
  expect(evidence.unexpected).toEqual([]);
});
