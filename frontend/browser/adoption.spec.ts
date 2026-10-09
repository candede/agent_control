import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AdoptionGroup, AdoptionPage } from "../../backend/src/types/adoption";
import { reportPage, source } from "../src/test/reportDataFixture";
import { mockLayoutApi, unifiedAgents } from "./layoutFixtures";

test("Adoption keeps all group content visible, searches groups, and opens existing agent details", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const agent = unifiedAgents.value[2];
  const groups: AdoptionGroup[] = [
    { id: "hr", company: "Contoso", department: "Human Resources",
      people: [
        { id: "person-1", name: "Maya Chen", agents: 10, responses: 200, champion: true },
        { id: "person-2", name: "Alex Smith", agents: 8, responses: 150, champion: true },
        { id: "person-3", name: "Robin Taylor", agents: 3, responses: 40, champion: true },
        { id: "person-4", name: "Sam Patel", agents: 0, responses: 0, champion: false },
      ],
      agents: [
        { id: agent.id, name: agent.displayName, description: "Finds policies, onboarding guidance and employee resources.", type: "Copilot Studio" },
        { id: "another-agent", name: "HR Policy Assistant", description: "Answers everyday questions about leave, benefits and company policies.", type: "Microsoft 365 Copilot Agent Builder" },
      ] },
    { id: "finance", company: "Contoso", department: "Finance",
      people: [{ id: "person-5", name: "Jamie Lee", agents: 0, responses: null, champion: false }],
      agents: [] },
  ];
  await page.route(url => url.pathname === "/api/copilot-usage/adoption", route => {
    const params = new URL(route.request().url()).searchParams;
    const search = params.get("search") ?? "";
    const value = groups.filter(group => search.split(/\s+/).every(term =>
      `${group.company} ${group.department}`.toLowerCase().includes(term))
      && (!params.has("company") || params.get("company") === `~string:${group.company}`)
      && (!params.has("department") || params.get("department") === `~string:${group.department}`)
      && (!params.has("adoptionChamps") || group.people.some(person => person.champion) === (params.get("adoptionChamps") === "with"))
      && (!params.has("adoptionAgents") || Boolean(group.agents.length) === (params.get("adoptionAgents") === "with")));
    const result: AdoptionPage = { ...reportPage(value, { counts: { total: groups.length, filtered: value.length } }),
      directory: source("directory"), inventoryAvailable: true,
      summary: { people: value.reduce((sum, group) => sum + group.people.length, 0),
        champs: value.reduce((sum, group) => sum + group.people.filter(person => person.champion).length, 0),
        agents: new Set(value.flatMap(group => group.agents.map(agent => agent.id))).size } };
    return route.fulfill({ json: result });
  });
  await page.route(url => url.pathname === "/api/copilot-usage/adoption/facets", route => {
    const field = new URL(route.request().url()).searchParams.get("field") === "company" ? "company" : "department";
    return route.fulfill({ json: reportPage([...new Set(groups.map(group => group[field]))].map(value => ({ value, count: 1 }))) });
  });
  await page.goto("/agents");
  await expect(page.locator(".agent-workspace .agent-overview-metrics")).toBeVisible();
  const agentsSummaryY = (await page.locator(".agent-workspace .agent-overview-metrics").boundingBox())!.y;
  await page.goto("/users");
  await expect(page.getByRole("button", { name: "Users view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "M365 Copilot license summary" })).toBeVisible();
  expect(Math.abs((await page.getByRole("group", { name: "M365 Copilot license summary" }).boundingBox())!.y - agentsSummaryY)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Adoption", exact: true }).click();
  const hr = page.getByRole("region", { name: "Contoso / Human Resources" });
  await expect(hr).toBeVisible();
  expect(Math.abs((await page.getByRole("group", { name: "Adoption summary" }).boundingBox())!.y - agentsSummaryY)).toBeLessThanOrEqual(1);
  await expect(hr.getByText("10/200")).toBeVisible();
  await expect(hr.getByText("Copilot Champ", { exact: true })).toHaveCount(3);
  await expect(hr.getByRole("button", { name: "Sam Patel" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toBeVisible();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const filters = page.getByRole("dialog", { name: "Filter groups" });
  await expect(filters.getByRole("combobox", { name: "Company", exact: true })).toHaveAttribute("aria-disabled", "false");
  await expect(filters.getByRole("combobox", { name: "Department", exact: true })).toHaveAttribute("aria-disabled", "false");
  const panelHeight = (await filters.boundingBox())!.height;
  const companyHeight = (await filters.getByRole("combobox", { name: "Company", exact: true }).boundingBox())!.height;
  const departmentHeight = (await filters.getByRole("combobox", { name: "Department", exact: true }).boundingBox())!.height;
  expect(Math.abs(companyHeight - departmentHeight)).toBeLessThanOrEqual(1);
  await expect(filters.getByRole("searchbox", { name: "Search company options", exact: true })).toBeVisible();
  await expect(filters.getByRole("searchbox", { name: "Search department options", exact: true })).toBeVisible();
  await filters.getByRole("combobox", { name: "Company", exact: true }).selectOption("~string:Contoso");
  await expect(filters.getByRole("combobox", { name: "Company", exact: true })).toHaveAttribute("aria-disabled", "false");
  expect(Math.abs((await filters.boundingBox())!.height - panelHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs((await filters.getByRole("combobox", { name: "Company", exact: true }).boundingBox())!.height - companyHeight)).toBeLessThanOrEqual(1);
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await filters.getByRole("combobox", { name: "Copilot Champs", exact: true }).selectOption("with");
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toHaveCount(0);
  expect(Math.abs((await filters.boundingBox())!.height - panelHeight)).toBeLessThanOrEqual(1);
  await filters.getByRole("button", { name: "Close filters" }).click();
  await expect(page).toHaveURL(/champs=with/);
  await page.reload();
  await expect(hr).toBeVisible();
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toBeVisible();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await filters.getByRole("combobox", { name: "Group agents", exact: true }).selectOption("without");
  await expect(hr).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toBeVisible();
  await filters.getByRole("button", { name: "Reset filters" }).click();
  await filters.getByRole("button", { name: "Close filters" }).click();
  await expect(hr).toBeVisible();
  await expect(page.locator(".adoption-view details")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath(`adoption-${info.project.name}.png`), fullPage: true });
  await hr.getByRole("button", { name: agent.displayName }).click();
  await expect(page.getByRole("dialog", { name: agent.displayName })).toBeVisible();
  await expect(page).toHaveURL(/\/users\?section=adoption/);
  await page.getByRole("button", { name: "Close unified agent details", exact: true }).click();
  const search = page.getByRole("searchbox", { name: "Search groups" });
  await search.fill("contoso human");
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toHaveCount(0);
  await expect(hr).toBeVisible();
  const clearSearch = page.getByRole("button", { name: "Clear search", exact: true });
  await expect(clearSearch).toHaveClass("agent-search-clear");
  await expect(clearSearch.locator("svg")).toHaveClass(/lucide-x/);
  await expect(clearSearch).toHaveText("");
  const fieldBounds = (await page.locator(".adoption-view .agent-search-field").boundingBox())!;
  const clearBounds = (await clearSearch.boundingBox())!;
  expect(clearBounds.x).toBeGreaterThanOrEqual(fieldBounds.x);
  expect(clearBounds.x + clearBounds.width).toBeLessThanOrEqual(fieldBounds.x + fieldBounds.width + 1);
  expect(clearBounds.y).toBeGreaterThanOrEqual(fieldBounds.y);
  expect(clearBounds.y + clearBounds.height).toBeLessThanOrEqual(fieldBounds.y + fieldBounds.height + 1);
  await clearSearch.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(clearSearch).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Contoso / Finance" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Adoption", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(hr).toBeVisible();
  await page.getByRole("button", { name: "Users view", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "User cohort" })).toBeVisible();
  expect(unexpected).toEqual([]);
});
