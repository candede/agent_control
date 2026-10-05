import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mockLayoutApi } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

for (const role of ["Admin", "Viewer"] as const) {
  test(`${role} management is saved history only, without a cross-import agent locator`, async ({ page }, info) => {
    const unexpected = await mockLayoutApi(page);
    if (role === "Viewer") {
      await page.route("**/api/me", route => route.fulfill({ json: {
        user: {
          homeAccountId: "fixture-viewer", tenantId: "fixture-tenant", username: "viewer@example.test",
          displayName: "Viewer", roles: ["AgentControl.Viewer"],
        },
        roleAssignmentRequired: false, csrfToken: "fixture-csrf",
      } }));
    }
    const requests: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/official-usage/")) requests.push(path);
    });
    await page.goto("/sync?reports=manage");
    const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
    const history = modal.getByRole("region", { name: "Saved report sets", exact: true });
    await expect(modal.getByRole("region", { name: "Saved report sets", exact: true })).toContainText("1 saved report set");
    await expect(history.locator("tbody tr")).toHaveCount(1);
    await expect(modal.getByRole("table")).toHaveCount(1);
    await expect(modal.getByText("Find an agent across reports", { exact: true })).toHaveCount(0);
    await expect(modal.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
    await expect(modal.getByRole("region", { name: "Retained activity summary" })).toHaveCount(0);
    await expect(modal.getByLabel("Search retained agents", { exact: true })).toHaveCount(0);
    await expect(modal.getByRole("combobox", { name: "Order retained agents", exact: true })).toHaveCount(0);
    await expect(modal.getByRole("navigation", { name: "Retained agent pages" })).toHaveCount(0);
    await expect(modal.getByRole("button", { name: /Make current|Refresh|View current snapshot|Cumulative activity/ })).toHaveCount(0);
    await expect(modal.locator(".cumulative-agent-activity")).toHaveCount(0);
    expect(requests).not.toContain("/api/official-usage/overview");
    expect(requests).not.toContain("/api/official-usage/aggregate");
    expect(requests).not.toContain("/api/official-usage/admin");
    expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${role.toLowerCase()}-saved-report-history.png`), fullPage: true });
    await modal.getByRole("button", { name: "Close reports", exact: true }).click();
    await expect(page).toHaveURL(/\/sync$/);
    await expect(page.getByRole("button", { name: "Manage reports", exact: true })).toBeFocused();
    expect(unexpected).toEqual([]);
  });
}

test("Agents shows independent inventory and activity cards without navigation shortcuts", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  const scopes: Array<string | null> = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/official-usage/overview") scopes.push(url.searchParams.get("scope"));
  });
  await page.goto("/agents");
  const overview = page.getByRole("region", { name: "Agent inventory overview" });
  await expect(overview.getByText("Agents in catalog", { exact: true }).locator("..")).toContainText("3");
  await expect(overview.getByText("Reported used agents").locator("..")).toContainText("2");
  await expect(overview.getByText("Reported active · 30 days").locator("..")).toContainText("2");
  await expect(overview.getByRole("link")).toHaveCount(0);
  await expect(overview.getByRole("button", { name: "Show agents in catalog", exact: true })).toBeVisible();
  await expect(overview.getByRole("button", { name: "Show reported used agents", exact: true })).toBeVisible();
  await expect(page.locator(".agent-catalog-heading").getByRole("group", { name: "Inventory scope" }).getByRole("button")).toHaveCount(2);
  await expect(overview.getByRole("group", { name: "Inventory scope" })).toHaveCount(0);
  await expect(overview.locator(".agent-report-context").getByRole("combobox", { name: "Report set" })).toBeVisible();
  await expect(overview.getByText("Reported used agents").locator("..")).toContainText("In selected report set");
  expect(scopes.length).toBeGreaterThan(0);
  expect(scopes.every(scope => scope === "selected")).toBe(true);
  await expect(overview).not.toContainText("not additive");
  await expect(overview).not.toContainText("Old imports");
  await expect(overview).toContainText("Partial data");
  expect((await new AxeBuilder({ page }).include(".agent-inventory-overview").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("inventory-overview.png"), fullPage: true });
  expect(unexpected).toEqual([]);
});
