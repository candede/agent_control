import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtureLoginUrl, isExternalFixtureRequest } from "./permissionFixtures";

async function uploadBundle(page: Page, dates: [string, string, string], identity: string) {
  const section = page.getByRole("region", { name: "CSV usage reports", exact: true });
  await section.getByRole("button", { name: "Add CSV reports" }).click();
  const modal = page.getByRole("dialog", { name: "Import CSV reports" });
  const another = modal.getByRole("button", { name: "Import another bundle" });
  if (await another.isVisible()) await another.click();
  const csvs = [
    `Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrange-${identity},Range agent,Your org,1,0,7,${dates[0]}`,
    `Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nrange-${identity},Range agent,Your org,range-${identity}@example.invalid,7,${dates[1]}`,
    `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nrange-${identity}@example.invalid,Range user,1,7,${dates[2]}`,
  ];
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvs.map((content, index) => ({
    name: `range-${index}.csv`, mimeType: "text/csv", buffer: Buffer.from(content),
  })));
  await modal.getByRole("button", { name: "Validate and stage" }).click();
  await modal.getByRole("button", { name: "Continue to review" }).click();
  const accepted = page.waitForResponse(response => response.request().method() === "POST"
    && /\/api\/official-usage\/bundles\/[^/]+\/accept$/.test(new URL(response.url()).pathname));
  await modal.getByRole("button", { name: "Accept reviewed bundle" }).click();
  const response = await accepted;
  expect(response.ok()).toBe(true);
  const result: { setId: string } = await response.json();
  await expect(modal.getByRole("heading", { name: "Accepted bundle", exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  return result.setId;
}

async function deleteBundle(page: Page, setId: string) {
  await page.getByRole("region", { name: "CSV usage reports", exact: true }).getByRole("button", { name: "Manage reports" }).click();
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const row = modal.getByRole("row").filter({ hasText: setId });
  await row.getByRole("button", { name: /^Delete retained set/ }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm delete" });
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await modal.getByRole("button", { name: "Close reports" }).click();
}

test("CSV section reflects cumulative persisted dates after uploads, reload and deletions", async ({ page, context }, info) => {
  test.setTimeout(45_000);
  await context.route(isExternalFixtureRequest, route => route.abort());
  await page.goto(fixtureLoginUrl("available"));
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  const reports = page.getByRole("region", { name: "CSV usage reports", exact: true });
  await expect(reports.getByText("Import needed", { exact: true })).toBeVisible();
  const first = await uploadBundle(page, ["2026-01-02", "2026-01-15", "2026-01-30"], info.project.name);
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-01-30']")).toBeVisible();
  const second = await uploadBundle(page, ["2026-08-01", "2026-08-10", "2026-08-29"], info.project.name);
  await expect(reports).toContainText("2 retained report sets");
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  await expect(reports.getByText("Reporting dates not supplied")).toBeVisible();
  await page.reload();
  await expect(reports.locator("time[datetime='2026-01-02']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  expect(await new AxeBuilder({ page }).include(".data-sync-reports").analyze()).toMatchObject({ violations: [] });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("csv-cumulative-range.png"), fullPage: true });
  await deleteBundle(page, first);
  await expect(reports.locator("time[datetime='2026-01-02']")).toHaveCount(0);
  await expect(reports.locator("time[datetime='2026-08-01']")).toBeVisible();
  await expect(reports.locator("time[datetime='2026-08-29']")).toBeVisible();
  await deleteBundle(page, second);
  await expect(reports.getByText("Import needed", { exact: true })).toBeVisible();
  await expect(reports.locator("time")).toHaveCount(0);
});
