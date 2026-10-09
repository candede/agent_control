import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { BulkActionJob, BulkJobStatus } from "../src/api/client";
import { capabilityViews, layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { automaticRefreshFixture } from "./automaticRefreshFixtures";
import { fulfillInventoryPage } from "./selectedInventoryFixture";

const job: BulkActionJob = {
  id: "11111111-2222-4333-8444-555555555555", action: "block", targetBlockedState: true,
  status: "running", canResume: false, total: 4, completed: 1, succeeded: 1, failed: 0, skipped: 0,
  currentAgentName: "Service desk assistant with a long published version name",
  inconclusive: 0, cancelled: 0, queued: 2, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1",
  createdAt: layoutTime, updatedAt: layoutTime,
};

function resultPage(current: BulkActionJob) {
  return { revision: current.resultRevision, counts: { total: current.total, filtered: current.total },
    page: { limit: 50, nextCursor: null, previousCursor: null },
    value: Array.from({ length: current.total }, (_, index) => ({
      id: `target-${index}`, displayName: `Target ${index}`,
      status: index < current.succeeded ? "succeeded" : current.inconclusive ? "inconclusive" : current.cancelled ? "cancelled" : "queued",
      reconciliationStatus: current.reconciliationRequired ? "required" : "not_required",
    })) };
}

test.afterEach(async ({ page }) => page.unrouteAll({ behavior: "wait" }));

test("package controls stay enabled through diagnostic expiry and background inventory reads without recurring permission checks", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, value: true }));
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
    finishSavedRead = () => fulfillInventoryPage(route, unifiedAgents);
  });
  const initialAutomaticRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/data-sync/auto-refresh");
  await page.goto("/agents");
  await initialAutomaticRead;
  await page.clock.runFor(1);
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
  test(`${action} progress stays compact and mounted through polling and inventory refresh, then dismisses`, async ({ page }, info) => {
    const unexpected = await mockLayoutApi(page);
    await page.clock.install({ time: new Date(layoutTime) });
    let current: BulkActionJob = { ...job, action, targetBlockedState: action === "block",
      currentAgentName: "Service desk assistant with a very long published version name ".repeat(8) };
    let resultReads = 0;
    let finishInventory: (() => Promise<void>) | undefined;
    await page.addInitScript(jobId => {
      localStorage.setItem("agent-control:active-bulk-job:v2:layout-tenant:layout-principal", jobId);
    }, job.id);
    await page.route(`**/api/agents/bulk-jobs/${job.id}**`, route => {
      if (new URL(route.request().url()).pathname.endsWith("/items")) {
        resultReads += 1;
        return route.fulfill({ json: resultPage(current) });
      }
      return route.fulfill({ json: current });
    });
    await page.route(url => url.pathname === "/api/agent-inventory" && !url.searchParams.has("recordId"), route => {
      if (current.status !== "succeeded") return route.fallback();
      finishInventory = () => fulfillInventoryPage(route, unifiedAgents);
    });
    await page.goto("/agents");
    const panel = page.getByRole("region", { name: "Exact package bulk actions" });
    await expect(page.getByRole("checkbox", { name: "Select Service desk assistant", exact: true })).toBeDisabled();
    await expect(panel.getByRole("status")).toHaveText("Running");
    await expect(panel.getByRole("button", { name: "Close job summary" })).toHaveCount(0);
    await expect(panel.getByText(/Current agent:/)).toHaveAttribute("title", current.currentAgentName!);
    await panel.evaluate(element => {
      element.setAttribute("data-removals", "0");
      const observer = new MutationObserver(records => {
        for (const record of records) {
          for (const removed of record.removedNodes) {
            if (removed.contains(element)) element.setAttribute("data-removals", String(Number(element.getAttribute("data-removals")) + 1));
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    const runningHeight = (await panel.boundingBox())!.height;
    expect(runningHeight).toBeLessThanOrEqual(info.project.name === "mobile" ? 310 : 200);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await panel.locator(".bulk-job-current").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(panel.getByRole("button", { name: "Cancel unprocessed tasks" })).toBeInViewport();
    for (const completed of [2, 3]) {
      current = { ...current, completed, succeeded: completed, resultRevision: String(completed) };
      await page.clock.runFor(1_100);
      await expect(panel.getByRole("progressbar")).toHaveAttribute("value", String(completed));
      await expect(panel).toHaveAttribute("data-removals", "0");
      expect((await panel.boundingBox())!.height).toBe(runningHeight);
    }
    expect(resultReads).toBe(0);
    await panel.screenshot({ path: info.outputPath(`${action}-compact-running.png`) });
    current = { ...current, status: "succeeded", completed: 4, succeeded: 4, queued: 0,
      currentAgentName: undefined, resultRevision: "4" };
    await page.clock.runFor(1_100);
    await expect(panel.getByRole("status")).toHaveText("Completed");
    await expect.poll(() => Boolean(finishInventory)).toBe(true);
    await expect(panel.getByRole("button", { name: "Close job summary" })).toBeEnabled();
    await expect(panel.getByRole("progressbar")).toHaveCount(0);
    await expect(panel.getByRole("group", { name: "Package job results" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /Previous results|Next results/ })).toHaveCount(0);
    await expect(panel.locator(".bulk-job > :last-child")).toHaveClass("bulk-progress-meta");
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(info.project.name === "mobile" ? 200 : 140);
    await expect(panel).toHaveAttribute("data-removals", "0");
    await finishInventory!();
    await expect(page.getByRole("status", { name: "Updating agent results" })).toHaveCount(0);
    await expect(panel).toHaveAttribute("data-removals", "0");
    expect(resultReads).toBe(1);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).include(".bulk-panel").analyze()).violations).toEqual([]);
    await panel.screenshot({ path: info.outputPath(`${action}-compact-completed.png`) });
    await panel.getByRole("button", { name: "Close job summary" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Permissions", exact: true }).click();
    await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: "Agents", exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });

  test(`interrupted ${action} is rediscovered after sign-in and resumes inline after reload`, async ({ page }, info) => {
    const unexpected = await mockLayoutApi(page);
    let current: BulkActionJob = {
      ...job, action, targetBlockedState: action === "block", status: "waiting_authorization",
      canResume: true, total: 10, completed: 6, succeeded: 6, currentAgentName: undefined,
    };
    const commands: string[] = [];
    await page.route("**/api/agents/bulk-jobs?*", route => route.fulfill({ json: { value: [current] } }));
    await page.route(`**/api/agents/bulk-jobs/${job.id}**`, route => {
      if (new URL(route.request().url()).pathname.endsWith("/items")) return route.fulfill({ json: resultPage(current) });
      if (route.request().method() === "POST") {
        commands.push(new URL(route.request().url()).pathname);
        current = { ...current, status: "succeeded", canResume: false, completed: 10, succeeded: 10, queued: 0, resultRevision: "2" };
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
    await expect(panel.getByText("10 succeeded", { exact: true })).toBeVisible();
    await expect(panel.getByRole("progressbar")).toHaveCount(0);
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
    if (new URL(route.request().url()).pathname.endsWith("/items")) return route.fulfill({ json: resultPage(current) });
    if (route.request().method() === "POST") {
      expect(new URL(route.request().url()).pathname).toBe(`/api/agents/bulk-jobs/${job.id}/cancel`);
      cancellations += 1;
      completeCancel = async () => {
        current = { ...job, status: "cancelled", completed: 4, cancelled: 3, queued: 0, resultRevision: "2" };
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
      inconclusive: Number(waiting), reconciliationRequired: Number(waiting),
    };
    await page.route(`**/api/agents/bulk-jobs/${job.id}/items?*`, route => route.fulfill({ json: resultPage(current) }));
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

for (const status of ["partial", "succeeded"] as const) {
  test(`${status} feedback and five selected packages keep action labels and selection counts separated`, async ({ page }, info) => {
    const unexpected = await mockLayoutApi(page);
    await page.clock.setFixedTime(new Date(layoutTime));
    await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), route => route.fulfill({ json: {
      value: capabilityViews.map(view => ["graph.package.block.manage", "graph.package.access.manage"].includes(view.definition.id) ? {
        ...view,
        decision: { capabilityId: view.definition.id, status: "available", authorized: true, fresh: true,
          verification: "on_demand", previewQualification: "not_required", remediation: [] },
      } : view),
    } }));
    const inventory = {
      ...unifiedAgents,
      counts: { ...unifiedAgents.counts, total: 5, scoped: 5, filtered: 5, packageTargets: 5 },
      value: Array.from({ length: 5 }, (_, index) => ({
        ...unifiedAgents.value[0], id: `graph_packages:panel-package-${index}`, displayName: `Panel agent ${index + 1}`,
        packages: [{ ...unifiedAgents.value[0].packages[0], id: `panel-package-${index}`, displayName: `Panel agent ${index + 1}` }],
      })),
    };
    const current: BulkActionJob = { ...job, status, canResume: false, total: 5, completed: 5,
      succeeded: status === "partial" ? 4 : 5, queued: 0, inconclusive: status === "partial" ? 1 : 0,
      reconciliationRequired: status === "partial" ? 1 : 0 };
    await page.route(url => url.pathname === "/api/agent-inventory" && !url.searchParams.has("recordId"),
      route => fulfillInventoryPage(route, inventory));
    await page.route(`**/api/agents/bulk-jobs/${job.id}/items?*`, route => route.fulfill({ json: resultPage(current) }));
    await page.route(`**/api/agents/bulk-jobs/${job.id}`, route => route.fulfill({ json: current }));
    await page.goto(`/agents?controlJob=${job.id}`);
    const panel = page.getByRole("region", { name: "Exact package bulk actions" });
    await expect(panel.getByRole("status")).toHaveText(status === "partial" ? "Needs review" : "Completed");
    await page.getByRole("button", { name: "Select all 5 matching published versions", exact: true }).click();
    await expect(panel.getByText("5 selected", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Check uncertain results" })).toHaveCount(status === "partial" ? 1 : 0);
    const actions = panel.locator(".bulk-buttons");
    const labels = ["Block selected packages", "Unblock selected packages", "Manage access"];
    for (const width of info.project.name === "desktop" ? [1920, 1440, 1024, 800] : [360, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const bounds = [];
      for (const label of labels) {
        const button = actions.getByRole("button", { name: label, exact: true });
        await expect(button).toBeEnabled();
        bounds.push((await button.boundingBox())!);
        expect(await button.evaluate(element => {
          const text = document.createRange();
          text.selectNodeContents(element);
          return text.getClientRects().length;
        }), `${label} should fit on one line at ${width}px`).toBe(1);
      }
      expect(new Set(bounds.map(bounds => bounds.height)).size).toBe(1);
      const counts = page.locator(".selection-summary").filter({ hasText: "5 agents selected on this page" });
      const countBounds = await counts.locator("span").evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
      }));
      expect(countBounds).toHaveLength(2);
      expect(countBounds[1].top >= countBounds[0].bottom + 4
        || countBounds[1].left >= countBounds[0].right + 8).toBe(true);
      expect(await counts.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await page.setViewportSize({ width: info.project.name === "desktop" ? 1920 : 360, height: 1000 });
    expect((await new AxeBuilder({ page }).include(".bulk-panel").analyze()).violations).toEqual([]);
    await panel.screenshot({ path: info.outputPath(`${status}-with-selection.png`) });
    if (status === "succeeded") {
      await panel.getByRole("button", { name: "Close job summary" }).click();
      await expect(panel.getByRole("group", { name: "Package job progress" })).toHaveCount(0);
      await expect(panel.getByText("5 selected", { exact: true })).toBeVisible();
    }
    expect(unexpected).toEqual([]);
  });
}
