import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { projectAgentResponsibility } from "../../backend/src/services/agentResponsibility";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../src/api/client";
import { copilotUsageFixture } from "../src/test/copilotUsageFixture";
import { createInventoryVerification, createUnifiedVerification } from "../src/test/inventoryVerification";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { isAutomaticRefreshRequest } from "./automaticRefreshFixtures";

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
  return { ...unifiedAgents, revision: "a".repeat(64), value: records, count: records.length, summary, filteredSummary: summary,
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
    if (request.method() !== "GET" && !isAutomaticRefreshRequest(request)) writes.push(path);
  });
  await page.route("**/api/agent-inventory*", route => {
    const query = new URL(route.request().url()).searchParams;
    const exact = query.get("recordId");
    const data = inventory(records);
    const inventoryScope = exact ? "all" : query.get("inventoryScope") === "catalog" ? "catalog" : "power_platform_only";
    const scoped = inventoryScope === "catalog" ? inventory([]) : data;
    const value = exact ? records.filter(record => record.id === exact) : scoped.value;
    return route.fulfill({ json: { ...data, inventoryScope, scopeSummary: scoped.summary,
      value, count: value.length, filteredSummary: { ...scoped.summary, total: value.length } } });
  });
  await page.route("**/api/agent-responsibility*", route => {
    const query = new URL(route.request().url()).searchParams;
    const objectId = query.get("objectId") ?? undefined;
    const paid = copilotUsageFixture.users.find(user => user.directory.objectId === objectId);
    const known = !objectId || records.some(record => Object.values(record.people ?? {}).some(person => person.objectId === objectId)) || paid;
    if (!known) return route.fulfill({ status: 404, json: { detail: "Exact saved person unavailable", code: "responsibility_person_unavailable" } });
    return route.fulfill({ json: projectAgentResponsibility(inventory(records), {
      objectId, search: query.get("search") ?? undefined, limit: Number(query.get("limit") ?? 50), offset: Number(query.get("offset") ?? 0),
    }, paid ? { ...paid.directory, observedAt: layoutTime } : undefined) });
  });
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
  await expect(page).toHaveURL(new RegExp(`/users\\?view=responsibility&person=${owner}`));
  await expect(page.getByText(`ID: ${owner}`, { exact: true })).toBeVisible();
  await expect(page.getByText("Owner · Last modified by", { exact: true })).toBeVisible();
  await expect(page.getByText(/License and observed usage are not established by responsibility/)).toBeVisible();
  await expect(page.getByText("Created by", { exact: true })).toHaveCount(0);
  expect(evidence.requests).not.toContain("/api/copilot-usage/users");
  expect(evidence.requests).not.toContain("/api/official-usage/users");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("exact-user-responsibility.png"), fullPage: true });
  await page.getByRole("button", { name: "Open agent Responsibility review agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Responsibility review agent" })).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?.*detail=agent%3Abbbbbbbb/);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.getByText(`ID: ${owner}`, { exact: true })).toBeVisible();
  expect(evidence.writes).toEqual(["/api/capabilities/check"]);
  expect(evidence.unexpected).toEqual([]);
});

test("Users responsibility cohort preserves same-name different IDs and creator role without changing paid usage", async ({ page }, info) => {
  const evidence = await fixture(page);
  await page.goto("/users");
  const metrics = page.getByLabel("M365 Copilot license summary");
  await expect(metrics.getByText("4", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("No reported responsibility relationships", { exact: false })).toBeVisible();
  await expect(dialog.getByText("200", { exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Close user details" }).click();
  await page.getByRole("combobox", { name: "User cohort" }).selectOption("responsibility");
  await expect(page.getByRole("button", { name: "View responsibility for Same name", exact: true })).toHaveCount(2);
  const creator = page.getByRole("listitem").filter({ hasText: other });
  await creator.getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`person=${other}`));
  await expect(page.getByText("Created by", { exact: true })).toBeVisible();
  await expect(page.getByText("Owner · Last modified by", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("creator-responsibility.png"), fullPage: true });
  await page.getByRole("combobox", { name: "User cohort" }).selectOption("licenses");
  await expect(metrics.getByText("4", { exact: true })).toBeVisible();
  expect(evidence.writes).toEqual(["/api/capabilities/check"]);
  expect(evidence.unexpected).toEqual([]);
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
  await expect(page.getByText(/Responsibility unavailable: no exact verified/)).toBeVisible();
  expect(evidence.requests).not.toContain("/api/agent-responsibility");
  await page.goto(`/users?view=responsibility&person=${owner}`);
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
  data.coverage = "unavailable";
  data.sources.powerPlatform = { state: "unavailable", observation: null, error: { source: "power_platform", code: "snapshot_unavailable", message: "No current source." } };
  data.selected = { ...data.selected!, agents: [], count: 0, state: "unavailable" };
  await page.route("**/api/agent-responsibility*", route => route.fulfill({ json: data }));
  await page.goto(`/users?view=responsibility&person=${owner}`);
  await expect(page.getByText(/relationships are unknown, not zero/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Open agent/ })).toHaveCount(0);
  await page.route("**/api/agent-responsibility*", route => route.fulfill({ json: projectAgentResponsibility(inventory(), { objectId: owner }) }));
  await page.reload();
  await expect(page.getByRole("button", { name: "Open agent Responsibility review agent" })).toBeVisible();
  await page.route("**/api/agent-inventory*", route => route.fulfill({ json: inventory([]) }));
  await page.getByRole("button", { name: "Open agent Responsibility review agent" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The exact agent is not available in the current saved inventory." })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(evidence.writes.every(path => path === "/api/capabilities/check")).toBe(true);
  expect(evidence.unexpected).toEqual([]);
});
