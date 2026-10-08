import { expect, test, type Locator } from "@playwright/test";
import { capabilityViews, layoutTime, mockLayoutApi } from "./layoutFixtures";
import { mockSelectedImport } from "./selectedImportFixture";
import { csvFilePayloads } from "./usageCsvFixture";
import AxeBuilder from "@axe-core/playwright";

async function expectInsets(container: Locator, minimum = 16) {
  const padding = await container.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
  });
  for (const value of padding) expect(value, "Dialog content must have deliberate inner spacing").toBeGreaterThanOrEqual(minimum);
}

async function expectContained(container: Locator) {
  expect(await container.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
    "Dialog content must not overflow horizontally").toBe(true);
  await expect(container).toBeInViewport({ ratio: 1 });
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("empty report management stays compact without diagnostics or inactive controls", async ({ page }, info) => {
  const state = await mockSelectedImport(page, []);
  await page.goto("/sync?reports=manage");
  const dialog = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(dialog.getByRole("heading", { name: "No reports yet" })).toBeVisible();
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByRole("navigation")).toHaveCount(0);
  await expect(dialog.getByRole("button")).toHaveCount(2);
  await expect(dialog).not.toContainText(/pinned history|History coverage|matching report|0 saved/);
  await expect(dialog.getByRole("button", { name: "Add CSV reports", exact: true })).toBeVisible();
  await expectContained(dialog);
  await dialog.screenshot({ path: info.outputPath("report-management-empty.png") });
  await dialog.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add CSV reports", exact: true }).locator(".usage-upload-zone")).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("user details restore all five task-focused tabs without exposing storage diagnostics", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.goto("/users");
  const trigger = page.getByRole("button", { name: "Ada", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Ada", exact: true });
  await expect(dialog.getByRole("tab")).toHaveText(["Overview", "Usage & agents", "Licenses", "Responsibility", "Logs"]);
  await expect(dialog.getByRole("region", { name: "Saved directory organization" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "User reported activity" })).toBeVisible();
  await expect(dialog.getByText("Agent report dates", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Report provenance" })).toHaveCount(0);
  for (const tab of ["Overview", "Usage & agents", "Licenses", "Responsibility", "Logs"]) {
    await dialog.getByRole("tab", { name: tab, exact: true }).click();
    const panel = dialog.getByRole("tabpanel", { name: tab, exact: true });
    await expect(panel).toBeVisible();
    await expectContained(dialog);
    await expectContained(panel);
    if (tab === "Usage & agents") {
      await expect(panel.getByRole("region", { name: "User agent activity" })).toBeVisible();
      await expect(panel.getByRole("region", { name: "User Office app activity" })).toBeVisible();
      await expect(panel.locator(".copilot-app-activity > li")).toHaveCount(8);
      await expect(panel.getByRole("combobox", { name: "Sort relationships" })).toHaveCount(0);
    }
    if (tab === "Licenses") await expect(panel.getByRole("list", { name: "Paid feature states" })).toBeVisible();
    if (tab === "Responsibility") await expect(panel.getByRole("heading", { name: "Agent responsibility" })).toBeVisible();
    if (tab === "Logs") await expect(panel.getByText(/Purview/).first()).toBeVisible();
    expect((await new AxeBuilder({ page }).include(".user-detail-modal").analyze()).violations).toEqual([]);
    await dialog.screenshot({ path: info.outputPath(`user-${tab.replaceAll(" ", "-")}.png`) });
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(unexpected).toEqual([]);
});

test("CSV import keeps compact file summaries padded and actions reachable without expandable sections", async ({ page }, info) => {
  const state = await mockSelectedImport(page, []);
  await page.goto("/sync?reports=import");
  const dialog = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  const uploadZone = dialog.locator(".usage-upload-zone");
  const bounds = (await dialog.boundingBox())!;
  const zone = (await uploadZone.boundingBox())!;
  expect(zone.x - bounds.x, "The drop zone must not touch the modal edge").toBeGreaterThanOrEqual(16);
  expect(bounds.x + bounds.width - zone.x - zone.width).toBeGreaterThanOrEqual(16);
  const body = dialog.locator(".usage-import-body");
  const footer = dialog.locator(".usage-import-footer");
  await expectInsets(body);
  await expectInsets(footer);
  await expectContained(dialog);
  await expect(dialog.getByRole("button", { name: "Cancel import", exact: true })).toBeInViewport({ ratio: 1 });
  await dialog.screenshot({ path: info.outputPath("import-initial.png") });

  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Start over" })).toHaveCount(0);
  await expectContained(body);
  await expect(dialog.getByRole("button", { name: "Cancel import", exact: true })).toBeInViewport({ ratio: 1 });
  await dialog.getByLabel("CSV report files", { exact: true }).setInputFiles(csvFilePayloads([{
    name: `${"long-report-name-".repeat(8)}.csv`,
    content: "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\r\n"
      + `${"agent-".repeat(30)},Long report example,User-created agent,1,0,42,2026-09-12\r\n`,
  }]));
  await expect(dialog.getByRole("heading", { name: "Add the remaining reports", exact: true })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Selected CSV files" }).getByRole("listitem")).toHaveCount(1);
  await expect(dialog.locator("details, pre")).toHaveCount(0);
  await expectContained(body);
  await expect(dialog.locator(".usage-modal-header")).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Cancel import", exact: true })).toBeInViewport({ ratio: 1 });
  await dialog.screenshot({ path: info.outputPath("import-partial.png") });
  await dialog.getByRole("button", { name: "Cancel import", exact: true }).click();
  const confirmation = dialog.getByRole("alertdialog", { name: "Discard staged import", exact: true });
  await expect(confirmation).toBeInViewport({ ratio: 1 });
  await expect(confirmation).toBeFocused();
  await expectInsets(confirmation);
  await confirmation.getByRole("button", { name: "Continue import", exact: true }).click();
  await expectContained(body);
  await page.setViewportSize({ width: 360, height: 500 });
  await expectContained(dialog);
  await expectContained(body);
  await expect(dialog.getByRole("button", { name: "Cancel import", exact: true })).toBeInViewport({ ratio: 1 });
  const metrics = await body.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
  const bodyBounds = (await body.boundingBox())!;
  await page.mouse.move(bodyBounds.x + bodyBounds.width / 2, bodyBounds.y + bodyBounds.height / 2);
  if (await body.evaluate(element => element.scrollTop) > 0) {
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0);
  }
  await page.mouse.wheel(0, 200);
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(state.unexpected).toEqual([]);
});

for (const scenario of [
  { name: "agent details", path: "/agents?detail=graph_packages%3Alayout-package-1", dialog: "Service desk assistant", body: ".inventory-detail-section" },
  { name: "user details", path: "/users", trigger: "Ada", dialog: "Ada", body: ".user-detail-panel:not([hidden])" },
  { name: "inventory diagnostics", path: "/sync", trigger: "View diagnostics", dialog: "Inventory diagnostics", body: ".workbench-dialog-body" },
  { name: "permission details", path: "/permissions", trigger: "Details: Agent inventory", dialog: "Agent inventory", body: ".workbench-dialog-body" },
  { name: "report management", path: "/sync?reports=manage", dialog: "Manage reports", body: ".usage-manage-reports", bodyInset: 12 },
  { name: "report snapshot", path: "/sync?reports=snapshot", dialog: "Report details", body: ".usage-snapshot", bodyInset: 12 },
] as const) {
  test(`${scenario.name} retains header and body gutters`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date(layoutTime));
    const unexpected = await mockLayoutApi(page);
    await page.goto(scenario.path);
    if ("trigger" in scenario) await page.getByRole("button", { name: scenario.trigger, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: scenario.dialog, exact: true });
    await expect(dialog).toBeVisible();
    await expectInsets(dialog.locator(":scope > header"));
    await expectInsets(dialog.locator(scenario.body), "bodyInset" in scenario ? scenario.bodyInset : 16);
    await expectContained(dialog);
    await expectContained(dialog.locator(scenario.body));
    if (scenario.name === "user details") {
      const metric = dialog.getByRole("group", { name: "User summary" }).locator(":scope > div").nth(1);
      await expectInsets(metric, 12);
      const label = (await metric.locator(":scope > span").boundingBox())!;
      const value = (await metric.locator(":scope > strong").boundingBox())!;
      expect(value.y - label.y - label.height).toBeGreaterThanOrEqual(4);
    }
    if (scenario.name === "agent details") {
      await expect(dialog.getByRole("tabpanel")).not.toContainText("Reload saved inventory");
      await expect(dialog.getByRole("region", { name: "Inventory source members" })).toHaveCount(0);
      await expect(dialog.getByRole("region", { name: "About", exact: true })).toBeVisible();
    }
    if (scenario.name === "report management") {
      await expect(dialog.locator("details")).toHaveCount(0);
      await expect(dialog.getByRole("navigation")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /Report observations|Load current report history/ })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "View report", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Delete report set", exact: true })).toBeVisible();
    }
    await dialog.screenshot({ path: info.outputPath(`${scenario.name.replaceAll(" ", "-")}.png`) });
    expect(unexpected).toEqual([]);
  });
}

for (const scenario of [
  { name: "audit event", path: "/audit", trigger: /^View event details:/, dialog: "Event details" },
  { name: "inventory export", path: "/agents", trigger: "Export agent inventory CSV", dialog: "Export agent inventory" },
  { name: "access assignment", path: "/agents", trigger: "Manage access", dialog: "Manage agent access" },
] as const) {
  test(`${scenario.name} preserves its existing padded dialog layout`, async ({ page }, info) => {
    await page.clock.setFixedTime(new Date(layoutTime));
    const unexpected = await mockLayoutApi(page);
    if (scenario.name === "access assignment") {
      await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), route => route.fulfill({ json: {
        value: capabilityViews.map(view => view.definition.id === "graph.package.access.manage" ? {
          ...view,
          decision: { capabilityId: view.definition.id, status: "available", authorized: true, fresh: true,
            verification: "on_demand", previewQualification: "not_required", remediation: [] },
        } : view),
      } }));
    }
    await page.goto(scenario.path);
    if (scenario.path === "/agents") {
      await expect(page.getByRole("button", { name: "Service desk assistant", exact: true })).toBeVisible();
    }
    if (scenario.name === "access assignment") {
      await page.getByRole("checkbox", { name: "Select Service desk assistant", exact: true }).check();
    }
    await page.getByRole("button", { name: scenario.trigger, exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: scenario.dialog, exact: true });
    await expect(dialog).toBeVisible();
    await expectContained(dialog);
    if (scenario.name === "access assignment") {
      await expectInsets(dialog.locator(".access-modal-header"), 14);
      await expectInsets(dialog.locator(".access-form"));
      await expectInsets(dialog.locator(".access-modal-actions"), 12);
    } else await expectInsets(dialog);
    if (scenario.name === "audit event") {
      const close = (await dialog.getByRole("button", { name: "Close", exact: true }).boundingBox())!;
      expect(close.width).toBeLessThan(120);
    }
    await dialog.screenshot({ path: info.outputPath(`${scenario.name.replaceAll(" ", "-")}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(unexpected).toEqual([]);
  });
}

test("user detail errors remain inside the padded scrollable panel", async ({ page }, info) => {
  await page.clock.setFixedTime(new Date(layoutTime));
  await mockLayoutApi(page);
  await page.route(url => /^\/api\/copilot-usage\/users\/[^/]+$/.test(url.pathname), route => route.fulfill({
    status: 503, json: { code: "detail_unavailable", detail: `User detail is unavailable: ${"saved-observation-".repeat(12)}` },
  }));
  await page.goto("/users");
  await page.getByRole("button", { name: "Ada", exact: true }).click();
  const dialog = page.locator("dialog.user-detail-modal");
  const alert = dialog.getByRole("alert").filter({ hasText: "User detail is unavailable:" }).first();
  await expect(alert).toBeVisible();
  const bounds = (await dialog.boundingBox())!;
  const message = (await alert.boundingBox())!;
  expect(message.x - bounds.x).toBeGreaterThanOrEqual(16);
  expect(bounds.x + bounds.width - message.x - message.width).toBeGreaterThanOrEqual(16);
  await expect(dialog.getByRole("tabpanel")).toContainText("User detail is unavailable:");
  await expectContained(dialog);
  await dialog.screenshot({ path: info.outputPath("user-detail-error.png") });
});
