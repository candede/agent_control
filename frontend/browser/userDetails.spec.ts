import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { AdoptionGroup, AdoptionPage } from "../../backend/src/types/adoption";
import type { CandidateAgentUsageAssociations, CandidateAgentUsageSummary, CandidateAgentUsageUsers } from "../../backend/src/types/officialReportApi";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { automaticRefreshFixture, isAutomaticRefreshRequest } from "./automaticRefreshFixtures";
import { selectedFixtureRead, selectedUsersPage } from "../src/test/selectedUsageFixture";
import { reportPage, reportSelection } from "../src/test/reportDataFixture";
import { responsibilityFixture } from "../src/test/agentResponsibilityFixture";
import { agentUsageHistoryFixture } from "../src/test/automaticAgentUsageFixture";
import { selectedCohortData, selectedCohortRead } from "./selectedCohortFixture";
import { inventoryFixtureSelection } from "./selectedInventoryFixture";
import { usersRouteSearch, workbenchUrl } from "../src/workbenchRouting";

async function openUser(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
  const unexpected = await mockLayoutApi(page, { metadataAfterPermissionCatalog: true });
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
  const firstRefresh = page.waitForResponse(response => isAutomaticRefreshRequest(response.request()) && response.ok());
  await page.goto("/users");
  await (await firstRefresh).finished();
  await page.clock.runFor(1_000);
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  expect(reads.refresh).toBe(1);
  return { dialog: page.getByRole("dialog", { name: "Ada", exact: true }), reads, writes, unexpected };
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const origin of ["licensed users", "Adoption", "reported users", "agent users"] as const) {
  for (const field of ["Company", "Department"] as const) {
    test(`${field} organization link opens filtered Adoption from ${origin}`, async ({ page }) => {
      const opened = await openUser(page);
      const cohort = selectedCohortData();
      if (origin === "agent users") cohort.directory.reports = unifiedAgents.usageContext!.reports;
      const directory = origin === "reported users" || origin === "agent users" ? cohort.directory : selectedUsersPage();
      const person = directory.value.find(user => user.directory.displayName === (origin === "reported users" ? "Emery" : "Ada"))!;
      const company = person.directory.companyName!, department = person.directory.department!;
      const group: AdoptionGroup = { id: "operations", company, department,
        people: [{ id: person.directory.objectId, name: person.directory.displayName!, agents: 1, responses: 200, champion: true }],
        agents: [{ id: "report:synthetic-researcher", name: "Researcher", creatorType: "Microsoft", inventoryId: null, description: null }] };
      const requests: URLSearchParams[] = [];
      await page.route(url => url.pathname === "/api/copilot-usage/adoption", route => {
        const params = new URL(route.request().url()).searchParams;
        requests.push(params);
        const value = [group].filter(row => (!params.has("company") || params.get("company") === `~string:${row.company}`)
          && (!params.has("department") || params.get("department") === `~string:${row.department}`)
          && (!params.has("search") || `${row.company} ${row.department}`.toLowerCase().includes(params.get("search")!.toLowerCase()))
          && params.get("adoptionChamps") !== "without" && params.get("adoptionAgents") !== "without");
        const response: AdoptionPage = {
          ...reportPage(value, { reports: directory.reports, sources: directory.sources,
            selection: reportSelection(5, Date.parse(layoutTime)), counts: { total: 1, filtered: value.length } }),
          directory: directory.sources.directory,
          page: { limit: 5, number: 1, offset: 0, nextCursor: null, previousCursor: null },
          summary: { people: value.length, champs: value.length, agents: value.length },
        };
        return route.fulfill({ json: response });
      });
      if (origin === "reported users" || origin === "agent users") {
        await page.route(url => url.pathname.startsWith("/api/official-usage/users"), route => {
          const body = selectedCohortRead(route.request().url(), cohort);
          expect(body, "Reported-user navigation keeps exact selected directory evidence").toBeDefined();
          return route.fulfill({ json: body });
        });
      }
      if (origin === "Adoption") {
        await page.goto(workbenchUrl("users", usersRouteSearch({ view: "licenses", section: "adoption",
          company: "Old company", department: "Old department", adoptionChamps: "without", adoptionAgents: "without",
          search: "Old search", detailId: person.directory.objectId, page: 0 })));
      } else if (origin === "reported users") {
        await page.goto("/users?view=activity&q=Emery&agent=synthetic-researcher");
        await page.getByRole("button", { name: "Emery", exact: true }).click();
      } else if (origin === "agent users") {
        const agent = unifiedAgents.value[0];
        await page.route(url => url.pathname.startsWith(`/api/agent-inventory/${encodeURIComponent(agent.id)}/usage`), route => {
          const context = { selectionId: inventoryFixtureSelection(route).id, reportSetId: directory.reports.setId,
            usageRevision: "b".repeat(64), inventoryRevision: "c".repeat(64), reports: directory.reports };
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/usage-history")) {
            const history = agentUsageHistoryFixture(context, agent.id);
            history.value = history.value.map(point => ({ ...point, status: "linked", responses: 200, associationCount: 1 }));
            history.latestReported = history.value[0];
            return route.fulfill({ json: history });
          }
          if (path.endsWith("/usage-associations")) {
            const response: CandidateAgentUsageAssociations = { context,
              value: [{ reportAgentId: agent.packages[0].id, agentName: agent.displayName, responses: 200, basis: "exact_package_id",
                target: { source: "graph_packages", packageId: agent.packages[0].id, snapshotId: "60000000-0000-4000-8000-000000000001" } }],
              page: { limit: 50, nextCursor: null, previousCursor: null }, counts: { total: 1, filtered: 1 } };
            return route.fulfill({ json: response });
          }
          if (path.endsWith("/usage-users")) {
            const response: CandidateAgentUsageUsers = { ...reportPage([{ username: person.directory.userPrincipalName!,
              displayName: person.directory.displayName!, responses: 200 }], { reports: directory.reports, sources: directory.sources,
              selection: { ...reportSelection(6, Date.parse(layoutTime)), id: context.selectionId } }), context };
            return route.fulfill({ json: response });
          }
          expect(path.endsWith("/usage")).toBe(true);
          const response: CandidateAgentUsageSummary = { recordId: agent.id, status: "linked", responses: 200, activeUsers: 1,
            lastActivityDateUtc: directory.reports.reportingPeriod!.endDate, associationCount: 1, context };
          return route.fulfill({ json: response });
        });
        await page.goto("/agents");
        await page.getByRole("button", { name: `View details for ${agent.displayName}`, exact: true }).click();
        const agentDialog = page.getByRole("dialog", { name: agent.displayName, exact: true });
        await agentDialog.getByRole("tab", { name: "Users", exact: true }).click();
        await agentDialog.getByRole("button", { name: `View details for Ada on ${agent.displayName}`, exact: true }).click();
        await expect(page.locator("dialog[open]")).toHaveCount(2);
      }
      const dialog = page.getByRole("dialog", { name: person.directory.displayName!, exact: true });
      const value = field === "Company" ? company : department;
      const link = dialog.getByRole("link", { name: `View adoption for ${field.toLowerCase()} ${value}` });
      await expect(link).toBeVisible();
      const destination = workbenchUrl("users", usersRouteSearch({ view: "licenses", section: "adoption", company,
        ...(field === "Department" ? { department } : {}), reportSetId: directory.reports.setId!, search: "", page: 0 }));
      await expect(link).toHaveAttribute("href", destination);
      requests.length = 0;
      await page.evaluate(() => { document.documentElement.dataset.organizationNavigation = "in-app"; });
      await link.click();
      await expect(page).toHaveURL(new URL(destination, page.url()).href);
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Adoption", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("region", { name: `${company} / ${department}`, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove company filter", exact: true })).toContainText(company);
      await expect(page.getByRole("button", { name: "Remove department filter", exact: true })).toHaveCount(field === "Department" ? 1 : 0);
      expect(requests.length).toBeGreaterThan(0);
      const query = requests.at(-1)!;
      expect(query.get("company")).toBe(`~string:${company}`);
      expect(query.get("department")).toBe(field === "Department" ? `~string:${department}` : null);
      expect(query.get("setId")).toBe(directory.reports.setId);
      for (const unrelated of ["search", "agentId", "adoptionChamps", "adoptionAgents", "cursor"]) {
        expect(query.has(unrelated), unrelated).toBe(false);
      }
      expect(await page.evaluate(() => document.documentElement.dataset.organizationNavigation)).toBe("in-app");
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
      expect(opened.writes.filter(path => path !== "/api/agent-inventory/selections")).toEqual([]);
      expect(opened.unexpected).toEqual([]);
    });
  }
}

test("user security deep links fall back safely without hiding adoption data or starting log reads", async ({ page }) => {
  const { dialog, writes, unexpected } = await openUser(page);
  const securityRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:hunting|audit-search|agent-inventory\/investigations)(?:\/|$)/.test(path)) securityRequests.push(path);
  });
  const url = new URL(page.url());
  url.searchParams.set("detail", selectedUsersPage().value[0].directory.objectId);
  url.searchParams.set("tab", "purview");
  await page.goto(`${url.pathname}${url.search}`);
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("region", { name: "Saved directory organization" })).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Logs", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Source" })).toHaveCount(0);
  await expect(dialog.getByText(/Purview|Defender|log identity/)).toHaveCount(0);
  await expect(dialog.locator("details")).toHaveCount(0);
  expect(securityRequests).toEqual([]);
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("user details organize useful data into consistent accessible tabs without disclosures", async ({ page }, info) => {
  const { dialog, reads, writes, unexpected } = await openUser(page);
  await expect(dialog.getByRole("tab")).toHaveText(["Overview", "Usage & agents", "Licenses", "Responsibility"]);
  await expect(dialog.getByRole("region", { name: "Saved directory organization" })).toContainText("Contoso Health");
  await expect(dialog.getByLabel("User summary")).toContainText("200");
  await expect(dialog.getByText("Agent report dates", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Aug 14, 2026 - Sep 12, 2026", { exact: true })).toBeVisible();
  expect(reads.responsibility).toBe(0);
  const bounds = await dialog.boundingBox();
  await dialog.screenshot({ path: info.outputPath("user-overview.png") });

  for (const [tab, screenshot] of [
    ["Usage & agents", "user-usage"], ["Licenses", "user-licenses"], ["Responsibility", "user-responsibility"],
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
  const usageRefresh = page.waitForResponse(response => isAutomaticRefreshRequest(response.request()) && response.ok());
  await page.clock.runFor(65_000);
  await (await usageRefresh).finished();
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return reads.users;
  }).toBeGreaterThan(userReads);
  await expect(dialog.getByRole("tab", { name: "Usage & agents", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveValue("research");
  await dialog.getByRole("tab", { name: "Usage & agents", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(dialog.getByRole("tab", { name: "Responsibility", exact: true })).toBeFocused();
  const responsibilityUserReads = reads.users;
  const responsibilityRefresh = page.waitForResponse(response => isAutomaticRefreshRequest(response.request()) && response.ok());
  await page.clock.runFor(65_000);
  await (await responsibilityRefresh).finished();
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return reads.users;
  }).toBeGreaterThan(responsibilityUserReads);
  await expect(dialog.getByRole("tab", { name: "Responsibility", exact: true })).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "Usage & agents", exact: true }).click();
  await expect(search).toHaveValue("research");
  await dialog.getByRole("tab", { name: "Responsibility", exact: true }).focus();
  await page.keyboard.press("Home");
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeFocused();
  expect(writes).toEqual([]);
  expect(unexpected).toEqual([]);
});
