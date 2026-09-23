import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { WorkbenchJobSummary, WorkbenchJobsResponse } from "../src/api/client";
import { mockJobs } from "./jobsFixtures";

function job(id: string, createdAt: string, overrides: Partial<WorkbenchJobSummary> = {}): WorkbenchJobSummary {
  const completedAt = new Date(Date.parse(createdAt) + 65_000).toISOString();
  return {
    id, source: "package-refresh", label: "Package inventory refresh", target: "Current principal Graph package catalog",
    status: "succeeded", total: 1039, completed: 1039, partial: false, canResume: false, canCancel: false, canReconcile: false,
    createdAt, startedAt: createdAt, completedAt, updatedAt: completedAt, href: `/sync?refreshJob=${id}`, ...overrides,
  };
}

function jobs(): WorkbenchJobsResponse {
  return {
    value: [
      job("old-incomplete-sync", "2026-09-15T10:00:00.000Z", {
        source: "data-sync", label: "Initial data sync", target: "Users, Graph packages, Power Platform, CSV usage reports",
        status: "partial", total: 4, completed: 3, partial: true, canResume: true,
        updatedAt: "2026-09-20T13:05:00.000Z", href: "/sync?syncRun=old-incomplete-sync",
      }),
      job("running-package", "2026-09-20T13:00:00.000Z", {
        status: "running", completed: 144, completedAt: undefined, canCancel: true,
      }),
      job("waiting-platform", "2026-09-20T13:01:00.000Z", {
        source: "power-platform", label: "Power Platform inventory refresh", target: "11 allowlisted resource types",
        status: "waiting_authorization", completed: 0, total: null, startedAt: undefined, completedAt: undefined,
        canResume: true, canCancel: true, href: "/power-platform?refreshJob=waiting-platform",
      }),
      job("draft-users", "2026-09-20T13:02:00.000Z", {
        source: "official-usage", label: "Users CSV import", target: "Users export · 34 validated rows",
        status: "active", total: 34, completed: 34, startedAt: undefined, completedAt: undefined,
        canCancel: true, href: "/sync?reports=import&staging=draft-users",
      }),
      job("sync-latest", "2026-09-20T12:00:00.000Z", {
        source: "data-sync", label: "Data sync", target: "Users, Graph packages, Power Platform",
        status: "completed", total: 3, completed: 3, href: "/sync?syncRun=sync-latest",
      }),
      job("package-latest", "2026-09-20T11:58:00.000Z"),
      job("platform-latest", "2026-09-20T11:50:00.000Z", {
        source: "power-platform", label: "Power Platform inventory refresh", target: "11 allowlisted resource types",
        total: 4219, completed: 4219, href: "/power-platform?refreshJob=platform-latest",
      }),
      ...["Agents", "Users & agents", "Users"].map((kind, index) => job(`accepted-${index}`, `2026-09-19T18:0${index}:00.000Z`, {
        source: "official-usage", label: `${kind} CSV import`, target: `${kind} export`,
        status: "accepted", total: index === 1 ? 536 : 306, completed: index === 1 ? 536 : 306, startedAt: undefined,
        href: "/sync?reports=snapshot&snapshot=accepted-snapshot",
      })),
      job("old-failed-platform", "2026-09-15T09:00:00.000Z", {
        source: "power-platform", label: "Power Platform inventory refresh", target: "11 allowlisted resource types",
        status: "failed", total: 4173, completed: 4173, href: "/power-platform?refreshJob=old-failed-platform",
      }),
      job("old-inconclusive-hunt", "2026-09-12T10:00:00.000Z", {
        source: "defender", label: "Defender fixed-template investigation",
        target: "agents_inventory · 2026-09-12T08:47:39Z to 2026-09-12T09:47:39Z",
        status: "inconclusive", total: null, completed: 0, createdAt: undefined, startedAt: undefined, completedAt: undefined,
        href: "/security?job=old-inconclusive-hunt",
      }),
      ...Array.from({ length: 17 }, (_, index) => job(`exact-${index}`, new Date(Date.UTC(2026, 8, 16, 12, index)).toISOString(), {
        label: `Exact package refresh ${index + 1}`, target: "1 exact Graph package target", total: 1, completed: 1,
      })),
    ],
    unavailableSources: [], polledAt: "2026-09-20T13:05:00.000Z", requestId: "synthetic-jobs-lookup",
  };
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Jobs separates current work from chronological table history and accessible read-only details", async ({ page }, info) => {
  const { unexpected, commands } = await mockJobs(page, jobs);
  await page.goto("/jobs");
  const current = page.getByRole("table", { name: "Current jobs", exact: true });
  const history = page.getByRole("table", { name: "Job history", exact: true });
  await expect(current.getByRole("row")).toHaveCount(4);
  await expect(current).toContainText("Ready for review");
  await expect(current).not.toContainText("Initial data sync");
  await expect(history.getByRole("row")).toHaveCount(16);
  await expect(history.getByRole("row").nth(1)).toContainText("Data sync");
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry incomplete", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Cancel refresh", exact: true })).toHaveCount(0);
  await expect(page.getByText("old-incomplete-sync", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/1-15 of 26 recent history records/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage reports", exact: true })).toHaveAttribute("href", "/sync?reports=manage");
  await expect(page.getByRole("link", { name: "View report history", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const clippedIdentity = await page.locator(".jobs-table-scroll").evaluateAll(regions => regions.flatMap(region => {
    const bounds = region.getBoundingClientRect();
    return Array.from(region.querySelectorAll(".job-title-button, .job-outcome")).flatMap(element => {
      const rect = element.getBoundingClientRect();
      return rect.left < bounds.left || rect.right > bounds.right ? [element.textContent] : [];
    });
  }));
  expect(clippedIdentity, "Job names and outcomes must be visible without sideways scrolling").toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("jobs-overview.png"), fullPage: true });

  const trigger = history.getByRole("button", { name: "View details for Data sync, job sync-latest", exact: true });
  const bounds = await trigger.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Job details", exact: true });
  await expect(dialog.getByRole("heading", { name: "Job details", exact: true })).toBeFocused();
  await expect(dialog.getByText("sync-latest", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open sync details", exact: true })).toHaveAttribute("href", "/sync?syncRun=sync-latest");
  await expect(dialog.getByRole("heading", { name: "Recovery actions" })).toHaveCount(0);
  await expect(dialog.locator("details")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".workbench-dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("jobs-completed-details.png") });
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual([]);
  expect(unexpected).toEqual([]);
});

const stagingId = "33333333-3333-4333-8333-333333333333";
const retainedSetId = "55555555-5555-4555-8555-555555555555";
for (const scenario of [
  { status: "active", label: "Review CSV import", legacy: `/official-usage?staging=${stagingId}`,
    canonical: `/sync?reports=import&staging=${stagingId}`, dialog: "Import CSV reports" },
  { status: "accepted", label: "View snapshot", legacy: `/official-usage?view=history&snapshot=${retainedSetId}`,
    canonical: `/sync?reports=snapshot&snapshot=${retainedSetId}`, dialog: "Report snapshot" },
  { status: "accepted", label: "Manage reports", legacy: "/official-usage?view=history",
    canonical: "/sync?reports=manage", dialog: "Manage reports" },
] as const) {
  for (const legacy of [false, true]) {
    test(`CSV job ${scenario.label} opens the canonical Sync dialog from ${legacy ? "legacy" : "canonical"} metadata`, async ({ page }) => {
      const csvJob = job("csv-route", "2026-09-20T13:02:00.000Z", {
        source: "official-usage", label: "Users CSV import", target: "Users export",
        status: scenario.status, total: 34, completed: 34,
        canCancel: scenario.status === "active", href: legacy ? scenario.legacy : scenario.canonical,
      });
      const { unexpected, commands } = await mockJobs(page, () => ({ ...jobs(), value: [csvJob] }));
      await page.goto("/jobs");
      await page.getByRole("button", { name: "View details for Users CSV import, job csv-route", exact: true }).click();
      const details = page.getByRole("dialog", { name: "Job details", exact: true });
      const source = details.getByRole("link", { name: scenario.label, exact: true });
      await expect(source).toHaveAttribute("href", scenario.canonical);
      await expect(details.getByRole("link", { name: "View report history", exact: true })).toHaveCount(0);
      await source.click();
      await expect(page).toHaveURL(scenario.canonical);
      await expect(details).toHaveCount(0);
      const report = page.getByRole("dialog", { name: scenario.dialog, exact: true });
      await expect(report).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(1);
      if (scenario.status === "active") {
        await expect(report.getByText(/exact staging record is expired, deleted, or unavailable/)).toBeVisible();
      } else if (scenario.label === "View snapshot") {
        await expect(report.getByRole("region", { name: "Report agent rows" }).locator("tbody tr")).toHaveCount(2);
      } else {
        await expect(report.getByRole("region", { name: "Retained official usage snapshots" }).locator("tbody tr")).toHaveCount(1);
      }
      await expect(page.getByRole("button", { name: "Official usage", exact: true, includeHidden: true })).toHaveCount(0);
      expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}

test("Jobs filters old outcomes without promoting failed runs or accepted reports into actionable cards", async ({ page }, info) => {
  const { unexpected, commands } = await mockJobs(page, jobs);
  await page.goto("/jobs");
  await page.getByRole("button", { name: "Next history page", exact: true }).click();
  await expect(page.getByText("16-26 of 26 recent history records", { exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Filter history by outcome" }).selectOption("failed");
  const history = page.getByRole("table", { name: "Job history", exact: true });
  await expect(history.getByRole("row")).toHaveCount(2);
  await expect(history).toContainText("4,173 of 4,173 resources observed");
  await expect(history).toContainText("Failed");
  await expect(history.getByText("Complete", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "Current jobs" }).getByRole("row")).toHaveCount(4);
  await page.screenshot({ path: info.outputPath("jobs-failed-history.png"), fullPage: true });

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search jobs" }).fill("old-incomplete-sync");
  await expect(history.getByRole("row")).toHaveCount(2);
  await expect(page.getByRole("table", { name: "Current jobs" })).toHaveCount(0);
  await history.getByRole("button", { name: /View details for Initial data sync/ }).click();
  const dialog = page.getByRole("dialog", { name: "Job details", exact: true });
  await expect(dialog.getByRole("heading", { name: "Recovery actions", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry incomplete", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("jobs-recovery-details.png") });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("combobox", { name: "Filter jobs by source" }).selectOption("official-usage");
  await expect(history.getByRole("row")).toHaveCount(4);
  await expect(page.getByRole("table", { name: "Current jobs" }).getByRole("row")).toHaveCount(2);
  await history.getByRole("button", { name: /job accepted-0$/ }).click();
  await expect(dialog.getByRole("link", { name: "View snapshot", exact: true })).toHaveAttribute("href", "/sync?reports=snapshot&snapshot=accepted-snapshot");
  await expect(dialog.getByRole("link", { name: "Review CSV import" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Discard draft" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await history.getByRole("button", { name: "Sort by Created", exact: true }).click();
  await expect(history.getByRole("row").nth(1)).toContainText("Defender fixed-template investigation");
  await expect(history.getByRole("row").nth(1)).toContainText("0 rows retained");
  await expect(history.getByRole("row").nth(1)).toContainText("Last update; original date not recorded");
  expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("Jobs performs only explicit authorized recovery and refreshes details when a job changes phase", async ({ page }, info) => {
  let state = jobs();
  const { unexpected, commands } = await mockJobs(page, () => state);
  await page.route(url => url.pathname === "/api/inventory/refresh-jobs/waiting-platform/cancel", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe("layout-csrf");
    state = { ...state, value: state.value.map(item => item.id === "waiting-platform"
      ? { ...item, status: "cancelled", canResume: false, canCancel: false, completedAt: "2026-09-20T13:06:00.000Z" } : item) };
    return route.fulfill({ json: { id: "waiting-platform", status: "cancelled" } });
  });
  await page.goto("/jobs");
  await page.getByRole("button", { name: /job waiting-platform$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Job details", exact: true });
  await expect(dialog.getByRole("button", { name: "Resume refresh", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel refresh", exact: true })).toBeEnabled();
  expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel refresh", exact: true }).click();
  await expect(dialog.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel refresh", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("jobs-cancelled-details.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeFocused();
  await expect(page.getByRole("table", { name: "Job history" })).toContainText("Cancelled");
  expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual(["POST /api/inventory/refresh-jobs/waiting-platform/cancel"]);
  expect(unexpected).toEqual([]);
});

test("Jobs names unavailable sources and preserves loaded history after a failed status check", async ({ page }) => {
  let state = jobs();
  state.value = state.value.filter(item => item.source !== "defender");
  state.unavailableSources = [{ source: "defender", code: "source_unavailable" }];
  const { unexpected, commands } = await mockJobs(page, () => state);
  let fail = false;
  await page.route(url => url.pathname === "/api/workbench/jobs", route => fail && route.request().method() === "GET" ? route.fulfill({
    status: 503, contentType: "application/problem+json",
    json: { type: "about:blank", status: 503, code: "unavailable", detail: "Synthetic jobs outage.", requestId: "outage-lookup" },
  }) : route.fallback());
  await page.goto("/jobs");
  await expect(page.getByRole("status")).toContainText("temporarily unavailable: Defender");
  const history = page.getByRole("table", { name: "Job history", exact: true });
  await expect(history).toBeVisible();
  const loadedHistory = await history.getByRole("row").allTextContents();
  fail = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Synthetic jobs outage");
  await expect(page.getByRole("alert")).toContainText("Showing the last loaded status");
  await expect(history.getByRole("row")).toHaveText(loadedHistory);
  await expect(page.getByText("synthetic-jobs-lookup", { exact: true })).toBeVisible();
  await expect(page.getByText(/Loading authorized job metadata/)).toHaveCount(0);
  await expect(page.getByText(/No retained jobs are visible/)).toHaveCount(0);
  state = {
    ...state, unavailableSources: [], requestId: "recovered-jobs-lookup", polledAt: "2026-09-20T13:06:00.000Z",
    value: state.value.map(item => item.id === "sync-latest" ? { ...item, label: "Refreshed data sync" } : item),
  };
  fail = false;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await expect(page.getByText("recovered-jobs-lookup", { exact: true })).toBeVisible();
  await expect(history).toContainText("Refreshed data sync");
  await expect(page.getByText(/temporarily unavailable: Defender/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(commands.filter(command => command !== "POST /api/capabilities/check")).toEqual([]);
  expect(unexpected).toEqual([]);
});
