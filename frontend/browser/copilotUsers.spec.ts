import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mockLayoutApi } from "./layoutFixtures";
import { copilotUsageFixture, licensedUser } from "../src/test/copilotUsageFixture";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("all licensed accounts remain searchable beyond two thousand while the table is paged", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.users = Array.from({ length: 2_053 }, (_, index) =>
    licensedUser(index + 1, `Person${String(index).padStart(4, "0")}`, index < 10 ? 100 - index : null));
  fixture.counts.licensedUsers = fixture.users.length;
  let snapshots = 0;
  await page.route("**/api/copilot-usage/users", route => {
    snapshots += 1;
    return route.fulfill({ json: fixture });
  });
  await page.goto("/users");
  const table = page.getByRole("region", { name: "Licensed users", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(50);
  await expect(page.getByLabel("Licensed user summary")).toContainText("2,053");
  await expect(page.getByText(/base licenses and free Copilot Chat alone are not counted/)).toBeVisible();
  const initialSnapshots = snapshots;
  expect(initialSnapshots).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Licensed user pages")).toContainText("51-100 of 2,053");
  await page.getByRole("searchbox", { name: "Search users or agents" }).fill("person2052");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("Person2052");
  await expect(table.locator("tbody tr")).toContainText("Unknown");
  await expect(page.getByLabel("Licensed user summary")).toContainText("2,053");
  expect(snapshots).toBe(initialSnapshots);
  expect(unexpected).toEqual([]);
});

test("licensed users lead with useful data and support ranked employee drilldown", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/users");
  await expect(page.getByRole("button", { name: "Drew", exact: true })).toBeVisible();
  const table = page.getByRole("region", { name: "Licensed users", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await expect(page.getByText("Microsoft 365 admin center Copilot Agents usage exports")).not.toBeVisible();
  await expect(page.locator(".capability-health")).toContainText("Permissions:");
  await expect(page.locator(".capability-health")).not.toContainText("provider-verified");
  if (info.project.name === "desktop") {
    const bounds = await table.boundingBox();
    expect(bounds!.y, "Useful employee rows should start within the first desktop viewport").toBeLessThan(700);
  }
  await page.getByRole("button", { name: "Least active", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").first()).toContainText("Cleo");
  await page.getByRole("button", { name: "Most active", exact: true }).click();
  await expect(table.locator("tbody tr").first()).toContainText("Ada");
  const results = await new AxeBuilder({ page }).include(".copilot-users").analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("licensed-users.png"), fullPage: true });

  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "Ada", exact: true });
  await expect(detail.getByRole("cell", { name: "Researcher synthetic-researcher", exact: true })).toBeVisible();
  await expect(detail.getByText("Microsoft", { exact: true })).toBeVisible();
  await expect(detail.getByText("Outlook", { exact: true })).toBeVisible();
  await expect(detail.getByRole("link", { name: "Search interaction log" })).toHaveAttribute("href", "/audit?source=purview&user=ada%40example.invalid");
  expect((await new AxeBuilder({ page }).include(".copilot-user-dialog").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("employee-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Ada", exact: true })).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("per-user interaction log opens with an exact identity and no automatic search", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/users");
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  await page.getByRole("link", { name: "Search interaction log" }).click();
  await expect(page).toHaveURL(/\/audit\?source=purview&user=ada%40example.invalid/);
  await expect(page.getByRole("textbox", { name: "User principal names", exact: true })).toHaveValue("ada@example.invalid");
  await expect(page.getByRole("button", { name: "Run Audit Search", exact: true })).toBeDisabled();
  expect(unexpected).toEqual([]);
});

test("report permission recovery is visible without hiding licensed employees", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const fixture = structuredClone(copilotUsageFixture);
  fixture.sources.appActivity = {
    ...fixture.sources.appActivity, state: "unavailable",
    message: "Check Reports.Read.All admin consent on the existing Entra app and the signed-in user's Reports Reader role.",
  };
  await page.route("**/api/copilot-usage/users", route => route.fulfill({ json: fixture }));
  await page.goto("/users");
  const table = page.getByRole("region", { name: "Licensed users", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const notice = page.getByText(/Office app activity unavailable/);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Reports.Read.All");
  await expect(notice).toContainText("Reports Reader");
  await expect(page.getByRole("link", { name: "Check connection" })).toHaveAttribute("href", "/permissions");
  expect((await new AxeBuilder({ page }).include(".copilot-users").analyze()).violations).toEqual([]);
  expect(unexpected).toEqual([]);
});
