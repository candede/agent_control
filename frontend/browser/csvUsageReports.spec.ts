import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtureLoginUrl, isExternalFixtureRequest } from "./permissionFixtures";
import { mockAutomaticRefresh } from "./automaticRefreshFixtures";
import { csvFilePayloads } from "./usageCsvFixture";

async function uploadBundle(page: Page, dates: [string, string, string], identity: string, expectedDuplicate = false) {
  const section = page.getByRole("region", { name: "CSV usage reports", exact: true });
  await section.getByRole("button", { name: "Add CSV reports" }).click();
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeEnabled();
  await expect(modal.getByRole("heading", { name: /Reports (?:already )?imported/ })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: /Close|Next|Review|Accept|Import another/ })).toHaveCount(0);
  await expect(modal.getByRole("checkbox", { name: /intentionally corrects/ })).toHaveCount(0);
  const csvs = [
    `Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrange-${identity},Range agent,Your org,1,0,7,${dates[0]}`,
    `Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nrange-${identity},Range agent,Your org,range-${identity}@example.invalid,7,${dates[1]}`,
    `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nrange-${identity}@example.invalid,Range user,1,7,${dates[2]}`,
  ];
  const accepted = page.waitForResponse(response => response.request().method() === "POST"
    && /\/api\/official-usage\/bundles\/[^/]+\/accept$/.test(new URL(response.url()).pathname));
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvFilePayloads(
    csvs.map((content, index) => ({ name: `range-${index}.csv`, content })),
  ));
  const response = await accepted;
  expect(response.ok()).toBe(true);
  const result: { setId: string; reusedExistingSet: boolean } = await response.json();
  expect(result.reusedExistingSet).toBe(expectedDuplicate);
  await expect(modal.getByRole("heading", { name: expectedDuplicate ? "Reports already imported" : "Reports imported", exact: true })).toBeVisible();
  await expect(modal.getByRole("status")).toContainText("Your report set is ready in Agents.");
  await expect(modal.getByLabel("Imported CSV summary").locator("dd")).toHaveText(["1", "1", "7"]);
  await expect(modal.getByRole("button")).toHaveText(["OK"]);
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(modal).toBeHidden();
  await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(result.setId);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  return result.setId;
}

async function deleteBundle(page: Page, setId: string, activityStart: string) {
  await page.getByRole("region", { name: "CSV usage reports", exact: true }).getByRole("button", { name: "Manage reports" }).click();
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const startLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${activityStart}T00:00:00Z`));
  const row = modal.getByRole("row").filter({ hasText: startLabel });
  const previewRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/official-usage/sets/${setId}/preview`);
  await row.getByRole("button", { name: /^Delete report set/ }).click();
  expect((await previewRequest).postDataJSON()).toEqual({ operation: "delete" });
  const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
  await confirmation.getByRole("button", { name: "Delete report set", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await modal.getByRole("button", { name: "Close reports" }).click();
}

test("CSV section reflects retained observed activity dates across history after uploads, reload and deletions", async ({ page, context }, info) => {
  test.setTimeout(45_000);
  await context.route(isExternalFixtureRequest, route => route.abort());
  await mockAutomaticRefresh(page);
  await page.goto(fixtureLoginUrl("available"));
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  const reports = page.getByRole("region", { name: "CSV usage reports", exact: true });
  await expect(reports.getByRole("heading", { name: "No reports yet", exact: true })).toBeVisible();
  await expect(reports.getByRole("button", { name: /Refresh|Retry/ })).toHaveCount(0);
  const first = await uploadBundle(page, ["2026-01-02", "2026-01-15", "2026-01-30"], info.project.name);
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-01-30']")).toBeVisible();
  const second = await uploadBundle(page, ["2026-08-01", "2026-08-10", "2026-08-29"], info.project.name);
  await expect(reports.getByRole("heading", { name: "2 saved report sets", exact: true })).toBeVisible();
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  await expect(reports.getByText("Observed activity dates (UTC)")).toBeVisible();
  await expect(reports.getByText("Reporting dates (UTC)")).toHaveCount(0);
  await expect(reports.getByText("Reporting dates not supplied")).toHaveCount(0);
  await expect(reports).toContainText("Last imported");
  await expect(reports).not.toContainText("proof of continuous reporting coverage");
  await expect(reports).not.toContainText("No manual dates are needed");
  await expect(reports).not.toContainText("Overlapping snapshots are not added together");
  await expect(reports.getByRole("button", { name: /Refresh|Retry/ })).toHaveCount(0);
  await page.reload();
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  const repeated = await uploadBundle(page, ["2026-01-02", "2026-01-15", "2026-01-30"], info.project.name, true);
  expect(repeated).toBe(first);
  await expect(reports.getByRole("heading", { name: "2 saved report sets", exact: true })).toBeVisible();
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await navigation.getByRole("button", { name: "Agents", exact: true }).click();
  const selector = page.getByRole("region", { name: "Report set selection" });
  await expect(selector.getByRole("combobox")).toHaveValue(first);
  await selector.getByRole("combobox").selectOption(second);
  await expect(selector.getByRole("combobox")).toHaveValue(second);
  await selector.getByRole("combobox").selectOption(first);
  await expect(selector.getByRole("combobox")).toBeEnabled();
  await expect(selector.getByRole("combobox")).toHaveValue(first);
  await expect(selector.getByRole("button")).toHaveCount(0);
  await expect(page).toHaveURL(/\/agents$/);
  await navigation.getByRole("button", { name: "Users", exact: true }).click();
  await expect(selector.getByRole("combobox")).toHaveValue(first);
  await navigation.getByRole("button", { name: /^Sync/ }).click();
  await expect(reports.getByRole("heading", { name: "2 saved report sets", exact: true })).toBeVisible();
  expect(await new AxeBuilder({ page }).include(".data-sync-reports").analyze()).toMatchObject({ violations: [] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("csv-retained-activity-range.png"), fullPage: true });
  await deleteBundle(page, first, "2026-01-02");
  await expect(reports.locator("time[datetime='2026-01-02']")).toHaveCount(0);
  await expect(reports.locator("time[datetime='2026-08-01']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  await deleteBundle(page, second, "2026-08-01");
  await expect(reports.getByRole("heading", { name: "No reports yet", exact: true })).toBeVisible();
  await expect(reports.locator("time")).toHaveCount(0);
  const reimported = await uploadBundle(page, ["2026-01-02", "2026-01-15", "2026-01-30"], info.project.name);
  expect(reimported).not.toBe(first);
  await expect(reports.getByRole("heading", { name: "1 saved report set", exact: true })).toBeVisible();
  const duplicate = await uploadBundle(page, ["2026-01-02", "2026-01-15", "2026-01-30"], info.project.name, true);
  expect(duplicate).toBe(reimported);
  await expect(reports.getByRole("heading", { name: "1 saved report set", exact: true })).toBeVisible();
  await deleteBundle(page, reimported, "2026-01-02");
  await expect(reports.getByRole("heading", { name: "No reports yet", exact: true })).toBeVisible();
});
