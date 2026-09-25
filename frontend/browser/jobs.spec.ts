import { expect, test } from "@playwright/test";
import { mockJobs } from "./jobsFixtures";

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

for (const path of ["/jobs", "/jobs/?source=package-controls"]) {
  test(`retired ${path} opens Sync history without a duplicate dashboard or recovery actions`, async ({ page }) => {
    const { unexpected, commands } = await mockJobs(page, () => ({
      value: [{
        id: "retained-sync", source: "data-sync", label: "Previous sync", target: "3 sources",
        status: "partial", total: 3, completed: 2, partial: true, canResume: true, canCancel: true, canReconcile: false,
        updatedAt: "2026-09-20T13:05:00.000Z", href: "/sync?syncRun=retained-sync",
      }],
      unavailableSources: [], polledAt: "2026-09-20T13:05:00.000Z", requestId: "synthetic-history",
    }));
    await page.goto(path);
    await expect(page).toHaveURL("/sync");
    await expect(page.getByRole("table", { name: "Sync history" })).toContainText("Previous sync");
    await expect(page.getByRole("button", { name: "Jobs", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /retry incomplete/i })).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Current jobs" })).toHaveCount(0);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.goBack();
    await expect(page).toHaveURL("/sync");
    await expect(page.getByRole("heading", { name: "Sync history" })).toBeVisible();
    expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
