import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { adoptionSnapshot, reportPage } from "../src/test/reportDataFixture";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Dashboard shows historical adoption, preserves baseline navigation, and fits desktop and mobile", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const first = adoptionSnapshot(1, { reportingStart: "2025-08-14", reportingEnd: "2025-09-12" });
  const second = adoptionSnapshot(2, { reportingStart: "2026-09-09", reportingEnd: "2026-10-08", activeUsers: 344, activeAgents: 325 });
  const latest = adoptionSnapshot(3, { reportingStart: "2026-09-27", reportingEnd: "2026-10-26", activeUsers: 306, activeAgents: 317 });
  const reads: URLSearchParams[] = [];
  await page.route(url => url.pathname === "/api/official-usage/history/adoption", route => {
    expect(route.request().method()).toBe("GET");
    const query = new URL(route.request().url()).searchParams;
    reads.push(query);
    return route.fulfill({ json: reportPage([latest, second, first]) });
  });
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "Dashboard", exact: true })).toHaveAttribute("aria-current", "page");
  const users = page.getByRole("region", { name: "Active users", exact: true });
  await expect(users.getByText("306", { exact: true })).toBeVisible();
  await expect(users.getByText("+6 (+2%)", { exact: true })).toBeVisible();
  await expect(users.getByText("-38 (-11%)", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Active users over saved reports" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Active agents over saved reports" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Report snapshots and comparisons", exact: true }).getByRole("row")).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".adoption-dashboard").analyze()).violations).toEqual([]);
  const readsBeforeBaseline = reads.length;
  await page.getByRole("combobox", { name: "Compare latest with baseline" }).selectOption(second.id);
  await expect(page).toHaveURL(new RegExp(`/dashboard\\?baseline=${second.id}$`));
  await expect(users.getByText("-38 (-11%)", { exact: true })).toHaveCount(2);
  expect(reads).toHaveLength(readsBeforeBaseline);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Users", exact: true }).click();
  await expect(page).toHaveURL(/\/users$/);
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Compare latest with baseline" })).toHaveValue(second.id);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Compare latest with baseline" })).toHaveValue(second.id);
  await page.getByRole("region", { name: "Report snapshots and comparisons", exact: true })
    .getByRole("link", { name: "Inspect report" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${latest.id}`));
  expect(reads.every(query => !query.has("setId"))).toBe(true);
  expect(unexpected).toEqual([]);
});
