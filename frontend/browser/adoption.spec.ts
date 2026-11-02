import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AdoptionGroup, AdoptionPage } from "../../backend/src/types/adoption";
import { reportPage, reportSelection, source } from "../src/test/reportDataFixture";
import { mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { deferred } from "../src/test/deferred";
import { automaticRefreshFixture } from "./automaticRefreshFixtures";
import { officeContext, officeFixtureContext, officeGroup, officeHistory, officePage, officePerson, officeSummary } from "../src/test/officeAdoptionFixture";

test("Office groups keep complete denominators and suggestions across paged people, app filters, bookmarks and keyboard navigation", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  let peopleReads = 0;
  const peopleRequests: Record<string, string>[] = [];
  await page.route(url => url.pathname.startsWith("/api/office-app-adoption/"), route => {
    const url = new URL(route.request().url()), input = Object.fromEntries(url.searchParams);
    for (const field of ["company", "department"]) if (input[field]?.startsWith("~string:")) input[field] = input[field].slice(8);
    const context = officeFixtureContext(input);
    if (url.pathname.endsWith("/context")) return route.fulfill({ json: context });
    expect(input.selectionId).toBe(context.selection.id);
    if (url.pathname.endsWith("/summary")) return route.fulfill({ json: officeSummary(context, { filteredPeople: input.app ? 40 : 54 }) });
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: officePage(officeHistory(context), context) });
    if (url.pathname.endsWith("/facets")) return route.fulfill({ json: officePage([
      { value: input.kind === "company" ? "Contoso" : "Engineering", groups: 1, people: 54 },
    ], context) });
    if (url.pathname.endsWith("/groups")) return route.fulfill({ json: officePage([officeGroup(1, { filteredPeople: input.app ? 40 : 54 })], context, {
      page: { limit: 5, number: Number(input.pageNumber ?? 1), pages: 2, offset: input.pageNumber === "2" ? 5 : 0,
        anchor: officeGroup().id, previousCursor: input.pageNumber === "2" ? "first" : null, nextCursor: input.pageNumber === "2" ? null : "next" },
      counts: { total: 6, filtered: 6 },
    }) });
    if (url.pathname.endsWith("/people")) {
      peopleReads++;
      peopleRequests.push(input);
      const second = input.cursor === "next-person" || input.pageNumber === "2";
      return route.fulfill({ json: officePage(second ? [officePerson(54)] : [officePerson(1)], context, {
        counts: { total: 54, filtered: input.app ? 40 : 54 },
        page: { limit: Number(input.limit), number: second ? 2 : 1, pages: input.app ? 1 : 2, offset: second ? 50 : 0, anchor: null,
          nextCursor: second || input.app ? null : "next-person", previousCursor: second ? "first-person" : null },
      }) });
    }
    return route.fulfill({ status: 400, json: { code: "invalid_office_query", detail: "Unexpected Office route." } });
  });
  await page.goto("/users?section=adoption&adoption=office");
  const group = page.getByRole("region", { name: "Contoso / Engineering" });
  await expect(group.getByRole("button", { name: "Office Person 1", exact: true })).toBeVisible();
  await group.getByRole("button", { name: "Next people" }).focus(); await page.keyboard.press("Enter");
  await expect(group.getByRole("button", { name: "Office Person 54", exact: true })).toBeVisible();
  await expect(group.getByText("40 reported active / 54 saved licensed", { exact: true })).toBeVisible();
  await expect(group.getByRole("button", { name: "3. Office Person 3", exact: true })).toBeVisible();
  expect(peopleRequests[1]).toEqual({ selectionId:officeContext().selection.id,limit:"50",cursor:"next-person" });
  const readsBeforeOpen = peopleReads, started = performance.now();
  await group.getByRole("button", { name: "Office Person 54", exact: true }).click();
  const frozen = page.getByRole("region", { name: "Frozen Office person evidence" });
  await expect(frozen.getByText("2 of 7", { exact: true })).toBeVisible();
  await expect.poll(() => peopleReads).toBe(readsBeforeOpen + 1);
  const openedMs = performance.now() - started;
  expect(peopleRequests.slice(readsBeforeOpen)).toEqual([{
    officeSnapshot: officeContext().observation!.id, selectionId: officeContext().selection.id, limit: "50", pageNumber: "2",
  }]);
  expect(openedMs).toBeLessThan(5000);
  await info.attach("office-late-page-person-open", { contentType: "application/json",
    body: Buffer.from(JSON.stringify({ person: 54, peopleReadsBefore: readsBeforeOpen, peopleReadsAfter: peopleReads,
      repinnedListingRequests: peopleRequests.slice(readsBeforeOpen), openedMs })) });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Office Person 54", exact: true })).toHaveCount(0);
  await expect(group.getByRole("button", { name: "Office Person 54", exact: true })).toBeFocused();
  await group.getByRole("link", { name: "Word", exact: true }).click();
  await expect(page).toHaveURL(/app=word/);
  await expect(page.getByText(/People and suggestions are filtered/)).toBeVisible();
  await expect(group.getByText("40 reported active / 54 saved licensed", { exact: true })).toBeVisible();
  await expect(group.getByRole("list", { name: "Seven Office app active-user counts" }).getByRole("listitem")).toHaveCount(7);
  await expect(group.getByRole("button", { name: "3. Office Person 3", exact: true })).toBeVisible();
  for (const width of [360, 760, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`office-groups-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Remove office app filter" }).click();
  await page.getByRole("navigation", { name: "groups pages", exact: true }).getByRole("button", { name: "Page 2", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Page 2", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).not.toHaveURL(/page=2/);
  expect(unexpected).toEqual([]);
});

test("invalid and removed Office pins show explicit Latest recovery without overwriting agent pins", async ({ page }) => {
  await mockLayoutApi(page);
  const removed = "b0000000-0000-4000-8000-000000000099";
  const agentPin = "10000000-0000-4000-8000-000000000001";
  await page.route(url => url.pathname.startsWith("/api/office-app-adoption/"), route => {
    const url = new URL(route.request().url()), input = Object.fromEntries(url.searchParams);
    if (input.officeSnapshot === removed) return route.fulfill({ status: 409, json: { code: "selection_invalidated", detail: "Removed Office observation", details: { reason: "unavailable" } } });
    const context = officeFixtureContext(input);
    if (url.pathname.endsWith("/context")) return route.fulfill({ json: context });
    if (url.pathname.endsWith("/summary")) return route.fulfill({ json: officeSummary(context) });
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: officePage(officeHistory(context), context) });
    return route.fulfill({ json: officePage([], context) });
  });
  await page.goto(`/users?section=adoption&adoption=office&officeSnapshot=${removed}&snapshot=${agentPin}`);
  await expect(page.getByText(/corrected, removed, or is no longer retained/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Office observation" })).toHaveValue("");
  await expect(page).toHaveURL(new RegExp(`snapshot=${agentPin}`));
  await expect(page).not.toHaveURL(/officeSnapshot=/);
  await page.goto(`/users?section=adoption&adoption=office&officeSnapshot=invalid&snapshot=${agentPin}`);
  await expect(page.getByText(/invalid observation or baseline/)).toBeVisible();
  await expect(page.getByRole("group", { name: "Office adoption summary" }).getByText("54", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`snapshot=${agentPin}`));
  await page.goto(`/dashboard?adoption=office&snapshot=${agentPin}&baseline=${agentPin}`);
  await expect(page.getByRole("region", { name: "Active users", exact: true }).getByText("40", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Agent adoption", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Copilot in Office apps", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`snapshot=${agentPin}`));
  await expect(page).toHaveURL(new RegExp(`baseline=${agentPin}`));
  await expect(page.getByRole("combobox", { name: "Office observation", exact: true })).toHaveValue("");
  expect(officeContext().observation).not.toBeNull();
});

test("Office idle selection renewal retains groups and totals without stale facet requests, focus movement or manual restart", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install();
  let renewed = false, contextReads = 0, obsoleteReads = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const original = officeContext();
  original.selection.expiresAt = new Date(Date.now() + 60_000).toISOString();
  await page.route(url => url.pathname.startsWith("/api/office-app-adoption/"), async route => {
    const url = new URL(route.request().url()), input = Object.fromEntries(url.searchParams);
    const context = renewed ? officeFixtureContext(input) : original;
    if (renewed) context.selection.id = "20000000-0000-4000-8000-000000000099";
    if (url.pathname.endsWith("/context")) {
      contextReads++;
      if (renewed) await pending;
      return route.fulfill({ json: context });
    }
    if (renewed && input.selectionId === original.selection.id) obsoleteReads++;
    if (url.pathname.endsWith("/summary")) return route.fulfill({ json: officeSummary(context) });
    if (url.pathname.endsWith("/history")) return route.fulfill({ json: officePage(officeHistory(context), context) });
    if (url.pathname.endsWith("/groups")) return route.fulfill({ json: officePage([officeGroup()], context, {
      page: { limit: 5, number: 1, pages: 1, offset: 0, anchor: officeGroup().id, previousCursor: null, nextCursor: null },
    }) });
    if (url.pathname.endsWith("/people")) return route.fulfill({ json: officePage([officePerson()], context) });
    if (url.pathname.endsWith("/facets")) return route.fulfill({ json: officePage([{ value: "Contoso", groups: 1, people: 54 }], context) });
    return route.fulfill({ status: 400, json: { code: "invalid_office_query", detail: "Unexpected Office route" } });
  });
  try {
    await page.goto("/users?section=adoption&adoption=office");
    const group = page.getByRole("region", { name: "Contoso / Engineering" });
    await expect(group.getByRole("button", { name: "Office Person 1", exact: true })).toBeVisible();
    await group.evaluate(element => element.setAttribute("data-continuity", "original"));
    const domain = page.getByRole("group", { name: "Adoption domain" }).getByRole("button", { name: "Office apps", exact: true });
    await domain.focus();
    renewed = true;
    await page.clock.fastForward(40 * 60_000);
    await expect.poll(() => contextReads).toBe(2);
    await expect(group).toHaveAttribute("data-continuity", "original");
    await expect(group.getByText("40 reported active / 54 saved licensed", { exact: true })).toBeVisible();
    await expect(domain).toBeFocused();
    release();
    await expect(group.getByRole("button", { name: "Office Person 1", exact: true })).toHaveAttribute("aria-disabled", "false");
    await expect(group).toHaveAttribute("data-continuity", "original");
    await expect(page.getByRole("button", { name: "Restart selection", exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(domain).toBeFocused();
    expect(obsoleteReads).toBe(0);
    expect(unexpected).toEqual([]);
  } finally { release(); }
});

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
        { id: "report:policy", inventoryId: agent.id, name: agent.displayName,
          description: "Finds policies, onboarding guidance and employee resources.", creatorType: "User-created agent" },
        { id: "report:another-agent", inventoryId: null, name: "HR Policy Assistant",
          description: "Answers everyday questions about leave, benefits and company policies.", creatorType: "Agent built by Microsoft" },
        { id: "report:external", inventoryId: null, name: "External assistant", description: null, creatorType: "Agent built by Third party" },
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
      page: { limit: 5, number: 1, offset: 0, anchor: value[0]?.id, nextCursor: null, previousCursor: null },
      directory: source("directory"),
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
  await expect(hr.getByText("Agent Champ", { exact: true })).toHaveCount(3);
  await expect(hr.getByRole("button", { name: "Sam Patel" })).toBeVisible();
  await expect(hr.getByText("Microsoft", { exact: true })).toBeVisible();
  await expect(hr.getByText("Third-party", { exact: true })).toBeVisible();
  await expect(hr.getByText("External assistant", { exact: true })).toBeVisible();
  await expect(hr.getByRole("button", { name: "External assistant", exact: true })).toHaveCount(0);
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
  await filters.getByRole("combobox", { name: "Agent Champs", exact: true }).selectOption("with");
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

for (const boundary of ["publication", "expiry"] as const) {
  test(`Adoption keeps later groups mounted and resumes their position after ${boundary}`, async ({ page }) => {
    const unexpected = await mockLayoutApi(page);
    await page.clock.install({ time: new Date() });
    const groups: AdoptionGroup[] = Array.from({ length: 15 }, (_, index) => ({
      id: (index + 1).toString(16).padStart(64, "0"), company: "Contoso", department: `Department ${index + 1}`,
      people: Array.from({ length: 12 }, (_, person) => ({
        id: `person-${index}-${person}`, name: `Colleague ${index + 1}-${person + 1}`, agents: 0, responses: 0, champion: false,
      })), agents: [],
    }));
    const initial = reportSelection(2, Date.now()), fresh = reportSelection(3, Date.now() + 600_001);
    let published = initial.publicationRevisions;
    const nextPage = deferred<void>(), refresh = deferred<void>();
    const requests: URLSearchParams[] = [];
    await page.route(url => url.pathname === "/api/data-sync/auto-refresh", route =>
      route.fulfill({ json: automaticRefreshFixture(published) }));
    await page.route(url => url.pathname === "/api/copilot-usage/adoption", async route => {
      const params = new URL(route.request().url()).searchParams;
      requests.push(params);
      const pageNumber = Number(params.get("pageNumber") ?? 1), anchor = params.get("anchor");
      const refreshing = Boolean(anchor);
      if (pageNumber === 2 && params.get("selectionId") === initial.id) await nextPage.promise;
      if (refreshing) await refresh.promise;
      const selection = refreshing || params.get("selectionId") === fresh.id ? fresh : initial;
      const start = anchor ? Math.floor(groups.findIndex(group => group.id === anchor) / 5) * 5 : (pageNumber - 1) * 5;
      const result: AdoptionPage = { ...reportPage(groups.slice(start, start + 5)),
        counts: { total: 15, filtered: 15 }, selection,
        page: { limit: 5, number: start / 5 + 1, offset: start, anchor: groups[start].id,
          previousCursor: start ? "fresh-previous" : null,
          nextCursor: start < 10 ? selection.id === initial.id ? "old-next" : "fresh-next" : null },
        directory: source("directory"), summary: { people: 180, champs: 0, agents: 0 } };
      await route.fulfill({ json: result });
    });
    await page.goto("/users?section=adoption");
    const first = page.getByRole("region", { name: "Contoso / Department 1", exact: true });
    await expect(first).toBeVisible();
    await expect(page.getByRole("navigation", { name: "groups pages", exact: true })).toHaveAttribute("aria-busy", "false");
    const initialRequests = requests.length;
    const pages = page.getByRole("navigation", { name: "groups pages", exact: true });
    await pages.getByRole("button", { name: "Next groups", exact: true }).click();
    await expect.poll(() => requests.length).toBe(initialRequests + 1);
    expect(requests.at(-1)?.get("pageNumber")).toBe("2");
    expect(requests.at(-1)?.has("cursor")).toBe(false);
    await expect(first).toBeVisible();
    await expect(page.getByRole("status", { name: "Matching groups" })).toHaveText("15 matching groups");
    nextPage.resolve(undefined);
    const later = page.getByRole("region", { name: "Contoso / Department 6", exact: true });
    await expect(later).toBeVisible();
    await later.evaluate(element => { element.setAttribute("data-retained-group", "true"); });
    const scrollBefore = await page.evaluate(() => window.scrollY);
    if (boundary === "publication") published = { ...published, users: "4".repeat(64) };
    fresh.publicationRevisions = published;
    await page.clock.fastForward(boundary === "publication" ? 60_001 : 600_001);
    await expect.poll(() => requests.length).toBe(initialRequests + 2);
    expect(requests.at(-1)?.get("anchor")).toBe(groups[5].id);
    expect(requests.at(-1)?.has("selectionId")).toBe(false);
    expect(requests.at(-1)?.has("cursor")).toBe(false);
    await expect(later).toHaveAttribute("data-retained-group", "true");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    refresh.resolve(undefined);
    await expect(pages.getByRole("button", { name: "Previous groups", exact: true })).toHaveAttribute("aria-disabled", "false");
    await expect(later).toHaveAttribute("data-retained-group", "true");
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(requests).toHaveLength(initialRequests + 2);
    await pages.getByRole("button", { name: "Next groups", exact: true }).click();
    await expect(page.getByRole("region", { name: "Contoso / Department 11", exact: true })).toBeVisible();
    expect(requests.at(-1)?.get("selectionId")).toBe(fresh.id);
    expect(requests.at(-1)?.get("pageNumber")).toBe("3");
    expect(requests.at(-1)?.has("anchor")).toBe(false);
    expect(unexpected).toEqual([]);
  });
}

test("numbered adoption pages jump directly, stay accessible, and fit enterprise desktop and mobile layouts", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const groups: AdoptionGroup[] = Array.from({ length: 80 }, (_, index) => ({
    id: (index + 1).toString(16).padStart(64, "0"), company: index % 2 ? "Contoso" : "Fabrikam",
    department: `Department ${String(index + 1).padStart(2, "0")}`,
    people: [
      { id: `person-${index}-1`, name: "Maya Chen", agents: 8, responses: 214, champion: true },
      { id: `person-${index}-2`, name: "Alex Morgan", agents: 5, responses: 128, champion: true },
      { id: `person-${index}-3`, name: "Jordan Taylor", agents: 2, responses: 46, champion: false },
    ],
    agents: [{ id: "report:knowledge", inventoryId: unifiedAgents.value[2].id, name: "Knowledge Assistant",
      description: "Find policies, discover resources, and get answers to everyday questions.", creatorType: "User-created agent" }],
  }));
  const selection = reportSelection(2, Date.now()), requests: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/copilot-usage/adoption", route => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params);
    const filtered = groups.filter(group => `${group.company} ${group.department}`.toLowerCase().includes(params.get("search") ?? ""));
    const number = Math.min(Number(params.get("pageNumber") ?? 1), Math.max(1, Math.ceil(filtered.length / 5)));
    const offset = (number - 1) * 5, value = filtered.slice(offset, offset + 5);
    const result: AdoptionPage = {
      ...reportPage(value), selection, counts: { total: groups.length, filtered: filtered.length },
      page: { limit: 5, number, offset, anchor: value[0]?.id,
        previousCursor: number > 1 ? "previous" : null, nextCursor: offset + value.length < filtered.length ? "next" : null },
      directory: source("directory"),
      summary: { people: filtered.length * 3, champs: filtered.length * 2, agents: 1 },
    };
    return route.fulfill({ json: result });
  });
  await page.goto("/users?section=adoption");
  const pages = page.getByRole("navigation", { name: "groups pages", exact: true });
  const shortcuts = page.getByRole("navigation", { name: "groups page shortcuts", exact: true });
  const heading = page.locator(".adoption-results-heading");
  await expect(page.locator(".adoption-view").getByRole("navigation")).toHaveCount(2);
  await expect(heading.getByRole("navigation", { name: "groups page shortcuts" })).toBeVisible();
  expect(await pages.evaluate(element => element.previousElementSibling?.matches(".adoption-groups"))).toBe(true);
  await expect(pages.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(shortcuts.getByRole("status", { name: "Page 1 of 16", exact: true })).toHaveText("1 / 16");
  await expect(shortcuts.getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", "true");
  const initialRequests = requests.length;
  await shortcuts.getByRole("button", { name: "Next groups" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Contoso / Department 06", exact: true })).toBeVisible();
  expect(requests).toHaveLength(initialRequests + 1);
  expect(requests.at(-1)?.get("pageNumber")).toBe("2");
  expect(requests.at(-1)?.get("selectionId")).toBe(selection.id);
  expect(requests.at(-1)?.has("cursor")).toBe(false);
  await expect(pages.getByRole("button", { name: "Page 2", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(shortcuts.getByRole("status", { name: "Page 2 of 16", exact: true })).toHaveText("2 / 16");
  await pages.getByRole("button", { name: "Page 4", exact: true }).click();
  await expect(page.getByRole("region", { name: "Contoso / Department 16", exact: true })).toBeVisible();
  expect(requests).toHaveLength(initialRequests + 2);
  expect(requests.at(-1)?.get("pageNumber")).toBe("4");
  expect(requests.at(-1)?.get("selectionId")).toBe(selection.id);
  expect(requests.at(-1)?.has("cursor")).toBe(false);
  await expect(pages.getByRole("button", { name: "Page 4", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(shortcuts.getByRole("status", { name: "Page 4 of 16", exact: true })).toHaveText("4 / 16");
  await expect(pages).toContainText("Showing 16–20 of 80 groups");
  await expect(page.getByRole("heading", { name: "Company & department adoption" })).toBeFocused();
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  async function checkHeaderLayout() {
    const bounds = (await heading.boundingBox())!, controls = (await shortcuts.boundingBox())!;
    const title = (await heading.getByRole("heading").boundingBox())!, subtitle = (await heading.locator("p").boundingBox())!;
    expect(controls.width).toBeLessThanOrEqual(170);
    expect(Math.abs(bounds.x + bounds.width - controls.x - controls.width)).toBeLessThanOrEqual(1);
    expect(title.x + title.width).toBeLessThanOrEqual(controls.x);
    expect(controls.y).toBeGreaterThanOrEqual(bounds.y);
    expect(controls.y + controls.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
    for (const button of await shortcuts.getByRole("button").all()) {
      const target = (await button.boundingBox())!, size = page.viewportSize()!.width <= 600 ? 44 : 32;
      expect(target.width).toBe(size);
      expect(target.height).toBe(size);
    }
    if (page.viewportSize()!.width <= 760) {
      expect(subtitle.y).toBeGreaterThanOrEqual(Math.max(title.y + title.height, controls.y + controls.height));
      expect(Math.abs(subtitle.width - bounds.width)).toBeLessThanOrEqual(1);
    } else {
      expect(subtitle.x + subtitle.width).toBeLessThanOrEqual(controls.x);
    }
  }
  await checkHeaderLayout();
  if (info.project.name === "desktop") {
    const viewport = page.viewportSize()!;
    for (const width of [320, 768, 1024, 2000]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const navigation = (await pages.boundingBox())!, numbers = (await pages.getByRole("list", { name: "Page numbers" }).boundingBox())!;
      expect(numbers.x).toBeGreaterThanOrEqual(navigation.x);
      expect(numbers.x + numbers.width).toBeLessThanOrEqual(navigation.x + navigation.width);
      await checkHeaderLayout();
      await heading.screenshot({ path: info.outputPath(`compact-adoption-header-${width}.png`) });
    }
    await page.setViewportSize(viewport);
  }
  await page.screenshot({ path: info.outputPath(`numbered-adoption-${info.project.name}.png`), fullPage: true });
  await pages.getByRole("spinbutton", { name: "Go to page" }).fill("16");
  await pages.getByRole("spinbutton", { name: "Go to page" }).press("Enter");
  await expect(page.getByRole("region", { name: "Contoso / Department 76", exact: true })).toBeVisible();
  expect(requests).toHaveLength(initialRequests + 3);
  await expect(pages.getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", "true");
  await expect(shortcuts.getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", "true");
  await expect(shortcuts.getByRole("status", { name: "Page 16 of 16", exact: true })).toHaveText("16 / 16");
  await expect(pages).toContainText("Showing 76–80 of 80 groups");
  await pages.getByRole("button", { name: "Page 1", exact: true }).click();
  await expect(page.getByRole("region", { name: "Fabrikam / Department 01", exact: true })).toBeVisible();
  expect(requests).toHaveLength(initialRequests + 4);
  await expect(pages.getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", "true");
  await expect(shortcuts.getByRole("button", { name: "Previous groups" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("searchbox", { name: "Search groups" }).fill("department 01");
  await expect(pages).toContainText("Showing 1–1 of 1 groups");
  await expect(pages.getByRole("button", { name: "Page 1", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(shortcuts.getByRole("status", { name: "Page 1 of 1", exact: true })).toHaveText("1 / 1");
  await expect(shortcuts.getByRole("button", { name: "Next groups" })).toHaveAttribute("aria-disabled", "true");
  expect(requests.at(-1)?.has("pageNumber")).toBe(false);
  expect(requests.at(-1)?.has("selectionId")).toBe(false);
  expect(unexpected).toEqual([]);
});
