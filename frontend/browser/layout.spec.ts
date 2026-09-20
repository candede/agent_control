import { expect, test, type Page } from "@playwright/test";
import { huntingJob, layoutTime, mockLayoutApi, purviewJob } from "./layoutFixtures";
import { collectLayoutFailures } from "./layoutGeometry";

const viewports = [360, 768, 1280, 1920];
const cases = [
  { name: "agents", path: "/agents", ready: ".agent-table-stack tbody tr",
    fields: [".filter-section-primary", ".filter-section-advanced"] },
  { name: "power-platform", path: "/power-platform", ready: ".inventory-table tbody tr",
    fields: [".inventory-controls"] },
  { name: "users", path: "/users", ready: ".copilot-users-table tbody tr",
    fields: [".copilot-users-toolbar"] },
  { name: "official-usage", path: "/official-usage?view=snapshot", ready: ".usage-agent-table tbody tr",
    fields: [".usage-agent-filters"] },
  { name: "audit-local", path: "/audit", ready: ".audit-table-shell tbody tr",
    fields: [".audit-controls"] },
  { name: "audit-purview", path: `/audit?source=purview&job=${purviewJob.id}`, ready: ".purview-history-table tbody tr",
    fields: [".purview-search-primary", ".purview-structured-filters > div"] },
  { name: "security", path: `/security?job=${huntingJob.id}`, ready: ".hunting-history-table tbody tr",
    fields: [".hunting-primary-fields", ".hunting-filters > div"] },
  { name: "permissions", path: "/permissions", ready: ".permission-table tbody tr",
    fields: [] },
  { name: "jobs", path: "/jobs", ready: ".job-history-table tbody tr",
    fields: [] },
];

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

for (const scenario of cases) {
  test(`${scenario.name}: populated saved data and degraded controls fit all viewport widths`, async ({ page }, info) => {
    // The viewport matrix belongs to this test, not to Playwright's desktop/mobile projects.
    test.skip(info.project.name !== "desktop", "The desktop project runs the complete viewport matrix.");
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(`Page error: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`);
    });
    await page.clock.setFixedTime(new Date(layoutTime));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const unexpectedRequests = await mockLayoutApi(page);
    await page.goto(scenario.path);
    await expect(page.locator(scenario.ready).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /provider-verified.*degraded/ })).toBeVisible();
    if (scenario.name === "agents") {
      await page.getByRole("checkbox", { name: "Advanced filters" }).check();
    }

    if (scenario.name === "audit-purview") {
      await page.getByText("Structured identity filters", { exact: true }).click();
      await expect(page.getByLabel("User principal names", { exact: true })).toBeVisible();
      await expect(page.locator(".purview-results")).toBeVisible();
      await page.locator(".purview-history-table").getByRole("button", { name: /View/ }).click();
      await expect(page.locator(".purview-results tbody tr").first()).toBeVisible();
    }
    if (scenario.name === "security") {
      await page.getByText("Typed identity filters", { exact: true }).click();
      await expect(page.getByLabel("Agent IDs", { exact: true })).toBeVisible();
      await expect(page.locator(".hunting-results")).toBeVisible();
      const loadRows = page.getByRole("button", { name: "Load minimized rows", exact: true });
      if (await loadRows.count()) await loadRows.click();
      await expect(page.getByText("Saved service desk security observation", { exact: true })).toBeVisible();
    }
    if (scenario.name === "permissions") {
      await page.getByRole("button", { name: "Shared application modes (3)" }).click();
      await expect(page.getByRole("table", { name: "Shared application permissions" })).toBeVisible();
    }
    if (scenario.name === "official-usage") {
      await expect(page.locator(".usage-report-context")).toContainText("2026-08-30");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Import reports", exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Agent comparison rows" }).locator("tbody tr")).toHaveCount(2);
      await expect(page.locator(".report-chart-panel")).toHaveCount(0);
    }
    if (scenario.name === "agents") {
      await expect(page.locator(".agent-table-stack .capability-gate > button:disabled").first()).toBeVisible();
    }
    if (scenario.name === "power-platform") {
      await expect(page.locator(".gate-explanation").first()).toBeVisible();
      await expect(page.locator(".capability-gate > button:disabled").first()).toBeVisible();
    }
    if (scenario.name === "jobs") {
      await expect(page.getByText(/authorized source is temporarily unavailable/)).toBeVisible();
      await page.getByRole("button", { name: /View details for Power Platform inventory refresh/ }).click();
      const jobDetails = page.getByRole("dialog", { name: "Job details", exact: true });
      await expect(jobDetails.getByRole("button", { name: "Resume refresh", exact: true })).toBeDisabled();
      await jobDetails.getByRole("button", { name: "Close job details", exact: true }).click();
    }
    // Unknown provider fields are intentional fixture data, not browser failures.
    // They must not be hidden by broad console filters or by empty-state assertions.
    await expect(page.locator(".error-banner[role=alert]")).toHaveCount(0);

    for (const width of viewports) {
      await test.step(`${width}px geometry and evidence`, async () => {
        await page.setViewportSize({ width, height: width === 360 ? 900 : 1000 });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: info.outputPath(`${scenario.name}-${width}.png`), fullPage: true, animations: "disabled" });
        await assertLayout(page, scenario.fields, `${scenario.name} at ${width}px`);
        if (scenario.name === "agents" || scenario.name === "power-platform") {
          const selector = scenario.name === "agents" ? ".filter-section-advanced" : ".inventory-controls";
          const expectedColumns = width === 360 ? 1 : scenario.name === "agents" ? 3 : width === 768 ? 2 : 4;
          const columns = await page.locator(selector).evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length);
          expect.soft(columns, `${selector} column contract at ${width}px`).toBe(expectedColumns);
        }
        if (scenario.name === "security") {
          const columns = await page.locator(".hunting-readiness").evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length);
          expect.soft(columns, `Five readiness facts at ${width}px`).toBe(width === 360 ? 1 : width === 768 ? 2 : 5);
          await page.getByRole("combobox", { name: "Fixed template", exact: true }).selectOption("agent_activity");
          await expect(page.getByLabel("Actor object IDs", { exact: true })).toBeVisible();
          await page.screenshot({ path: info.outputPath(`security-${width}-activity-filters.png`), fullPage: true, animations: "disabled" });
          await assertLayout(page, scenario.fields, `security three-field activity form at ${width}px`);
          await page.getByRole("combobox", { name: "Fixed template", exact: true }).selectOption("agents_inventory");
        }
        if (scenario.name === "official-usage") {
          const columns = await page.locator(".usage-headline-grid")
            .evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length);
          expect.soft(columns, `Three headline metrics form complete rows at ${width}px`).toBe(width === 360 ? 1 : 3);
          if (width >= 1280) {
            const bounds = await page.getByRole("region", { name: "Agent comparison rows" }).boundingBox();
            expect(bounds!.y, `Agent comparison begins in the first viewport at ${width}px`).toBeLessThan(760);
          }
        }
        if (["jobs", "official-usage"].includes(scenario.name) && [360, 1920].includes(width)) {
          await test.step("Reduced-motion layout parity", async () => {
            await assertReducedMotionParity(page, `${scenario.name} at ${width}px`);
            await page.screenshot({ path: info.outputPath(`${scenario.name}-${width}-reduced-motion.png`), fullPage: true, animations: "disabled" });
            await assertLayout(page, scenario.fields, `${scenario.name} at ${width}px with reduced motion`);
            await page.emulateMedia({ reducedMotion: "no-preference" });
          });
        }
      });
    }
    expect(unexpectedRequests, "Every request must be served by an explicit synthetic fixture").toEqual([]);
    expect(errors, "No page errors, console errors, or layout warnings").toEqual([]);
  });
}

async function assertReducedMotionParity(page: Page, description: string) {
  const surfaces = [
    ".jobs-view", ".jobs-current", ".jobs-history", ".job-history-table", ".job-history-table tbody tr", ".inline-actions",
    ".official-usage-workbench", ".official-usage-import", ".official-usage-fields", ".official-usage-fields > label",
    ".reporting-view", ".usage-comparison-header", ".usage-agent-table", ".usage-agent-filters",
  ].join(", ");
  const geometry = () => page.locator(surfaces).evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { name: `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`,
      x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  }));
  const normal = await geometry();
  expect(normal.length, "Parity must exercise populated tables, fields, or report panels").toBeGreaterThan(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const reduced = await geometry();
  expect.soft(reduced.length, `${description}: reduced motion preserves the same content`).toBe(normal.length);
  const failures = normal.flatMap((before, index) => {
    const after = reduced[index];
    if (!after || before.name !== after.name) return [`${before.name} missing or replaced`];
    return (["x", "y", "width", "height"] as const).flatMap(dimension => Math.abs(before[dimension] - after[dimension]) > 1.5
      ? [`${before.name} ${dimension} changed: ${before[dimension].toFixed(1)} → ${after[dimension].toFixed(1)}`] : []);
  });
  expect.soft(failures, `${description}: reduced motion changes animation, not layout`).toEqual([]);
}

async function assertLayout(page: Page, fields: string[], description: string) {
  const failures = await page.evaluate(collectLayoutFailures, { fields });
  expect.soft(failures, description).toEqual([]);
}
