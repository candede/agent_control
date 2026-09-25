import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { BulkActionJob, BulkJobStatus } from "../src/api/client";
import { capabilityViews, layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { automaticRefreshFixture } from "./automaticRefreshFixtures";

const job: BulkActionJob = {
  id: "11111111-2222-4333-8444-555555555555", action: "block", targetBlockedState: true,
  status: "running", canResume: false, total: 4, completed: 1, succeeded: 1, failed: 0, skipped: 0,
  currentAgentName: "Service desk assistant with a long published version name",
  results: [{ id: "done", displayName: "Completed agent", status: "succeeded" }],
  createdAt: layoutTime, updatedAt: layoutTime,
};

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

test("package controls stay enabled through diagnostic expiry and background inventory reads without recurring permission checks", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.install({ time: new Date(layoutTime) });
  const views = capabilityViews.map(view => ["graph.package.block.manage", "graph.package.access.manage"].includes(view.definition.id) ? {
    ...view,
    decision: {
      capabilityId: view.definition.id, status: "available", authorized: true, fresh: true, verification: "token",
      checkedAt: new Date(Date.parse(layoutTime) - 1_000).toISOString(),
      expiresAt: new Date(Date.parse(layoutTime) + 1_000).toISOString(),
      previewQualification: "not_required", remediation: [],
    },
  } : view);
  let permissionChecks = 0;
  let permissionReads = 0;
  let backgroundChange = false;
  let finishSavedRead: (() => Promise<void>) | undefined;
  await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), route => {
    if (route.request().method() === "POST") permissionChecks += 1;
    else permissionReads += 1;
    return route.fulfill({ json: { value: views } });
  });
  await page.route("**/api/data-sync/auto-refresh", route => route.fulfill({ json: {
    ...automaticRefreshFixture({ users: "users-1", graph_packages: backgroundChange ? "packages-2" : "packages-1", power_platform: "platform-1" }),
    nextCheckAt: new Date(Date.parse(layoutTime) + 60_000).toISOString(),
  } }));
  await page.route(url => url.pathname === "/api/agent-inventory" && !url.searchParams.has("recordId"), route => {
    if (!backgroundChange) return route.fallback();
    finishSavedRead = () => route.fulfill({ json: unifiedAgents });
  });
  await page.goto("/agents");
  const selected = page.getByRole("checkbox", { name: "Select Service desk assistant", exact: true });
  await expect(selected).toBeEnabled();
  await expect.poll(() => permissionChecks).toBe(1);
  await selected.check();
  const initialReads = permissionReads;
  const panel = page.getByRole("region", { name: "Exact package bulk actions" });
  backgroundChange = true;
  await page.clock.fastForward(60_001);
  await expect.poll(() => Boolean(finishSavedRead)).toBe(true);
  await expect(page.getByRole("status", { name: "Updating agent results" })).toBeVisible();
  await expect(selected).toBeDisabled();
  for (const name of ["Block selected packages", "Unblock selected packages", "Manage access"]) {
    await expect(panel.getByRole("button", { name, exact: true })).toBeEnabled();
  }
  await expect(page.getByRole("button", { name: "Block Service desk assistant", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Manage access for Service desk assistant", exact: true })).toBeEnabled();
  await panel.screenshot({ path: info.outputPath("actions-during-background-refresh.png") });
  await panel.getByRole("button", { name: "Manage access", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.fastForward(10 * 60_000);
  await expect(panel.getByRole("button", { name: "Block selected packages", exact: true })).toBeEnabled();
  expect(permissionChecks).toBe(1);
  expect(permissionReads).toBe(initialReads);
  await finishSavedRead!();
  await expect(page.getByRole("status", { name: "Updating agent results" })).not.toBeVisible();
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  expect(permissionChecks).toBe(1);
  expect(permissionReads).toBe(initialReads);
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect.poll(() => permissionChecks).toBe(2);
  expect(permissionReads).toBe(initialReads + 1);
  expect(unexpected).toEqual([]);
});

for (const action of ["block", "unblock"] as const) {
  test(`interrupted ${action} is rediscovered after sign-in and resumes inline after reload`, async ({ page }, info) => {
    const unexpected = await mockLayoutApi(page);
    let current: BulkActionJob = {
      ...job, action, targetBlockedState: action === "block", status: "waiting_authorization",
      canResume: true, total: 10, completed: 6, succeeded: 6, currentAgentName: undefined,
    };
    const commands: string[] = [];
    await page.route("**/api/agents/bulk-jobs?*", route => route.fulfill({ json: { value: [current] } }));
    await page.route(`**/api/agents/bulk-jobs/${job.id}**`, route => {
      if (route.request().method() === "POST") {
        commands.push(new URL(route.request().url()).pathname);
        current = { ...current, status: "succeeded", canResume: false, completed: 10, succeeded: 10 };
      }
      return route.fulfill({ json: current });
    });
    await page.goto("/agents");
    const panel = page.getByRole("region", { name: "Exact package bulk actions" });
    await expect(panel.getByRole("status")).toHaveText("Sign-in required");
    await expect(panel.getByText("6 of 10 processed", { exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Sign in again" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    await page.reload();
    await expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toBeEnabled();
    expect(commands).toEqual([]);
    await panel.screenshot({ path: info.outputPath(`${action}-interrupted.png`) });
    page.once("dialog", dialog => dialog.accept());
    await panel.getByRole("button", { name: "Resume unprocessed tasks" }).click();
    await expect(panel.getByRole("status")).toHaveText("Completed");
    await expect(panel.getByText("10 of 10 processed", { exact: true })).toBeVisible();
    expect(commands).toEqual([`/api/agents/bulk-jobs/${job.id}/resume`]);
    await expect(page).toHaveURL("/agents");
    await expect(page.getByRole("button", { name: "Jobs", exact: true })).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}

test("a reopened running job has one panel with inline cancellation and a retained outcome", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  let current = job;
  let completeCancel: (() => Promise<void>) | undefined;
  let cancellations = 0;
  await page.route(`**/api/agents/bulk-jobs/${job.id}**`, route => {
    if (route.request().method() === "POST") {
      expect(new URL(route.request().url()).pathname).toBe(`/api/agents/bulk-jobs/${job.id}/cancel`);
      cancellations += 1;
      completeCancel = async () => {
        const results: BulkActionJob["results"] = [...job.results,
          ...["pending-1", "pending-2", "pending-3"].map(id => ({ id, displayName: id, status: "cancelled" as const }))];
        const result = { targetBlockedState: true, total: 4, succeeded: 1, failed: 0, skipped: 0, results };
        current = { ...job, status: "cancelled", completed: 4, results, result };
        await route.fulfill({ json: current });
      };
      return;
    }
    return route.fulfill({ json: current });
  });
  await page.goto(`/agents?controlJob=${job.id}`);
  const panel = page.getByRole("region", { name: "Exact package bulk actions" });
  await expect(panel.getByRole("heading", { name: "Access and availability" })).toBeVisible();
  await expect(panel.getByRole("status")).toHaveText("Running");
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "1");
  await expect(panel.getByText("1 of 4 processed", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Current agent:/)).toContainText(job.currentAgentName!);
  await expect(page.getByRole("region", { name: "Job controls" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Selected package control job" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Block selected packages" })).toHaveCount(0);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.locator("body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".bulk-panel").analyze()).violations).toEqual([]);
  await panel.screenshot({ path: info.outputPath("running-job.png") });

  const cancel = panel.getByRole("button", { name: "Cancel unprocessed tasks" });
  await expect(cancel).toHaveClass(/secondary bulk-job-cancel/);
  await cancel.click();
  await expect(panel.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
  await expect(panel.getByRole("status")).toHaveText("Cancelling");
  await expect.poll(() => cancellations).toBe(1);
  await expect.poll(() => Boolean(completeCancel)).toBe(true);
  await panel.screenshot({ path: info.outputPath("cancelling-job.png") });
  await completeCancel!();
  await expect(panel.getByRole("status")).toHaveText("Cancelled");
  await expect(panel.getByText("1 succeeded", { exact: true })).toHaveCount(1);
  await expect(panel.getByText("3 cancelled", { exact: true })).toBeVisible();
  await expect(panel.getByText(/Changes already in progress may still finish/)).toBeVisible();
  await expect(panel.getByRole("button", { name: /Cancel unprocessed|Resume unprocessed/ })).toHaveCount(0);
  await panel.screenshot({ path: info.outputPath("cancelled-job.png") });
  expect(unexpected).toEqual([]);
});

for (const [status, label] of [
  ["queued", "Queued"], ["waiting_authorization", "Sign-in required"], ["partial", "Needs review"],
  ["succeeded", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"],
] as const satisfies readonly [BulkJobStatus, string][]) {
  test(`${status} stays inside Access and availability with appropriate recovery controls`, async ({ page }, info) => {
    const unexpected = await mockLayoutApi(page);
    await page.clock.setFixedTime(new Date(layoutTime));
    const waiting = status === "waiting_authorization" || status === "partial";
    const current: BulkActionJob = {
      ...job, status, canResume: waiting,
      results: waiting ? [{ id: "uncertain", displayName: "Uncertain agent", status: "inconclusive",
        reconciliationStatus: "required", message: "Provider response lost." }] : job.results,
    };
    await page.route(`**/api/agents/bulk-jobs/${job.id}`, route => route.fulfill({ json: current }));
    await page.goto(`/agents?controlJob=${job.id}`);
    const panel = page.getByRole("region", { name: "Exact package bulk actions" });
    await expect(panel.getByRole("status")).toHaveText(label);
    await expect(page.getByRole("region", { name: "Selected package control job" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Job controls" })).toHaveCount(0);
    await expect(panel.getByText(/Current agent:/)).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Resume unprocessed tasks" })).toHaveCount(waiting ? 1 : 0);
    await expect(panel.getByRole("button", { name: "Check uncertain results" })).toHaveCount(waiting ? 1 : 0);
    await expect(panel.getByRole("link", { name: "Sign in again" })).toHaveCount(status === "waiting_authorization" ? 1 : 0);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include(".bulk-panel").analyze()).violations).toEqual([]);
    await panel.screenshot({ path: info.outputPath(`${status}-job.png`) });
    expect(unexpected).toEqual([]);
  });
}
