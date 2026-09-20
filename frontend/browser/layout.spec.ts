import { expect, test, type Page } from "@playwright/test";
import { huntingJob, layoutTime, mockLayoutApi, purviewJob } from "./layoutFixtures";

const viewports = [360, 768, 1280, 1920];
const cases = [
  { name: "agents", path: "/agents", ready: ".agent-table-stack tbody tr",
    fields: [".filter-section-primary", ".filter-section-advanced"] },
  { name: "power-platform", path: "/power-platform", ready: ".inventory-table tbody tr",
    fields: [".inventory-controls"] },
  { name: "users", path: "/users", ready: ".copilot-users-table tbody tr",
    fields: [".copilot-users-toolbar"] },
  { name: "official-usage", path: "/official-usage", ready: ".usage-agent-table tbody tr",
    fields: [".usage-agent-filters"] },
  { name: "audit-local", path: "/audit", ready: ".audit-table-shell tbody tr",
    fields: [".audit-controls"] },
  { name: "audit-purview", path: `/audit?source=purview&job=${purviewJob.id}`, ready: ".purview-history-table tbody tr",
    fields: [".purview-search-primary", ".purview-structured-filters > div"] },
  { name: "security", path: `/security?job=${huntingJob.id}`, ready: ".hunting-history-table tbody tr",
    fields: [".hunting-primary-fields", ".hunting-filters > div"] },
  { name: "permissions", path: "/permissions", ready: ".permission-row",
    fields: [] },
  { name: "jobs", path: "/jobs", ready: ".job-card",
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
      await page.getByText(/Optional shared application modes/).click();
      await expect(page.locator(".permission-optional-modes")).toHaveAttribute("open", "");
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
      await expect(page.locator(".capability-gate > button:disabled").first()).toBeVisible();
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
    ".jobs-view", ".job-card", ".job-card-heading", ".job-progress", ".job-progress > span", ".inline-actions",
    ".official-usage-workbench", ".official-usage-import", ".official-usage-fields", ".official-usage-fields > label",
    ".reporting-view", ".usage-comparison-header", ".usage-agent-table", ".usage-agent-filters",
  ].join(", ");
  const geometry = () => page.locator(surfaces).evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { name: `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`,
      x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  }));
  const normal = await geometry();
  expect(normal.length, "Parity must exercise populated cards, fields, or report panels").toBeGreaterThan(1);
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
  const failures = await page.evaluate(({ fields }) => {
    const failures: string[] = [];
    const tolerance = 1.5; // Fractional tracks and device-pixel rounding.
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const name = (element: Element) => element.getAttribute("aria-label")
      ?? element.closest("label")?.textContent?.trim().replace(/\s+/g, " ").slice(0, 70)
      ?? `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`;
    const contained = (child: Element, parent: Element) => {
      const a = child.getBoundingClientRect(), b = parent.getBoundingClientRect();
      if (a.left < b.left - tolerance || a.right > b.right + tolerance
        || a.top < b.top - tolerance || a.bottom > b.bottom + tolerance) {
        failures.push(`${name(child)} is outside ${name(parent)}`);
      }
    };
    const doNotIntersect = (elements: Element[], group: string) => {
      for (let i = 0; i < elements.length; i++) {
        for (let j = i + 1; j < elements.length; j++) {
          const a = elements[i].getBoundingClientRect(), b = elements[j].getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > tolerance
            && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance) {
            failures.push(`${group}: ${name(elements[i])} intersects ${name(elements[j])}`);
          }
        }
      }
    };
    const equalWidth = (elements: Element[], group: string) => {
      // Wide search fields and full-row timestamps/lineage are deliberate spans.
      const widths = elements.filter(element => {
        const css = getComputedStyle(element);
        return !element.classList.contains("filter-search")
          && !element.matches(".usage-agent-filters > label:first-child")
          && ![css.gridColumnStart, css.gridColumnEnd].some(value => value.includes("span") || value === "-1");
      }).map(element => element.getBoundingClientRect().width);
      if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > tolerance) {
        failures.push(`${group} has unequal field/card widths: ${widths.map(value => value.toFixed(1)).join(", ")}`);
      }
    };
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + tolerance) {
      failures.push(`Document overflows: ${root.scrollWidth}px > ${root.clientWidth}px`);
      const overflowing = Array.from(document.querySelectorAll(".report-section-header, .report-header-actions, .report-window-control"))
        .filter(element => element.getBoundingClientRect().right > root.clientWidth + tolerance);
      failures.push(...overflowing.map(element => `${name(element)} extends to ${element.getBoundingClientRect().right.toFixed(1)}px`));
    }
    const shell = document.querySelector(".app-shell")!;
    const bounds = shell.getBoundingClientRect(), style = getComputedStyle(shell);
    if (Math.abs(bounds.left) > tolerance || Math.abs(bounds.width - root.clientWidth) > tolerance) {
      failures.push(`Authenticated shell does not use the viewport: x=${bounds.left}, width=${bounds.width}, viewport=${root.clientWidth}`);
    }
    const left = parseFloat(style.paddingLeft), right = parseFloat(style.paddingRight);
    if (left <= 0 || right <= 0 || Math.abs(left - right) > tolerance) failures.push("App must retain balanced outer padding");
    const header = shell.querySelector(".top-bar")!.getBoundingClientRect();
    if (Math.abs(header.left - bounds.left - left) > tolerance || Math.abs(header.right - (bounds.right - right)) > tolerance) {
      failures.push("Header does not fill the padded app content width");
    }
    for (const child of Array.from(shell.children).filter(visible)) contained(child, shell);
    const surfaces = [
      ".catalog-controls", ".agent-summary-grid", ".inventory-view", ".copilot-users",
      ".official-usage-workbench", ".audit-source-view", ".defender-hunting", ".permission-center", ".jobs-view",
    ];
    for (const surface of Array.from(shell.querySelectorAll(surfaces.join(", "))).filter(visible)) {
      const rect = surface.getBoundingClientRect();
      if (Math.abs(rect.left - header.left) > tolerance || Math.abs(rect.right - header.right) > tolerance) {
        failures.push(`${name(surface)} does not fill the padded app content width`);
      }
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const footerEmail = document.querySelector(".app-footer-email");
    if (footerEmail && footerEmail.getBoundingClientRect().height > parseFloat(getComputedStyle(footerEmail).lineHeight) + tolerance) {
      failures.push("Footer email breaks mid-address instead of wrapping the surrounding credit text");
    }
    for (const selector of fields) {
      const grid = document.querySelector(selector);
      if (!grid || !visible(grid)) {
        failures.push(`Missing visible field group: ${selector}`);
        continue;
      }
      const labels = Array.from(grid.querySelectorAll(":scope > label")).filter(visible);
      if (!labels.length) failures.push(`No fields checked in ${selector}`);
      labels.forEach(label => contained(label, grid));
      doNotIntersect(labels, selector);
      equalWidth(labels, selector);
      const controls = labels.flatMap(label => Array.from(label.querySelectorAll("input, select, textarea"))).filter(visible);
      doNotIntersect(controls, selector);
      for (const control of controls) {
        const label = control.closest("label")!;
        contained(control, label);
        const css = getComputedStyle(control);
        const rect = control.getBoundingClientRect();
        const input = control as HTMLInputElement;
        context.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        // Native selects may abbreviate a long saved-snapshot description. They
        // still need room for its longest word, rather than a collapsed sliver.
        const text = control instanceof HTMLSelectElement
          ? (control.selectedOptions[0]?.textContent ?? "").split(/\s+/).sort((a, b) => b.length - a.length)[0]
          : input.type === "datetime-local" ? "09/12/2026, 10:00:00 AM"
            : input.type === "date" ? "09/12/2026" : "";
        // Native date/select affordances need space in addition to the displayed value.
        const needed = context.measureText(text).width + parseFloat(css.paddingLeft) + parseFloat(css.paddingRight)
          + (text ? parseFloat(css.fontSize) * 1.5 : 0);
        if (text && rect.width + tolerance < needed) {
          failures.push(`${name(control)} is too narrow for its displayed value (${rect.width.toFixed(1)}px, needs ${needed.toFixed(1)}px)`);
        }
        if (control.parentElement === label && Math.abs(rect.width - label.getBoundingClientRect().width) > tolerance) {
          failures.push(`${name(control)} does not fill its field`);
        }
        if (control.clientWidth && control.scrollWidth > control.clientWidth + tolerance && input.type !== "search") {
          failures.push(`${name(control)} clips its contents`);
        }
      }
    }
    const equalGrids = [
      ".summary-grid", ".official-usage-lineage",
      ".hunting-readiness", ".hunting-result-facts", ".purview-result-facts",
    ];
    for (const selector of equalGrids) {
      for (const grid of Array.from(document.querySelectorAll(selector)).filter(visible)) {
        const children = Array.from(grid.children).filter(visible);
        children.forEach(child => contained(child, grid));
        doNotIntersect(children, selector);
        equalWidth(children, selector);
        if (selector === ".summary-grid" && children.length) {
          const css = getComputedStyle(grid);
          const contentRight = grid.getBoundingClientRect().right - parseFloat(css.paddingRight) - parseFloat(css.borderRightWidth);
          if (contentRight - Math.max(...children.map(child => child.getBoundingClientRect().right)) > tolerance) {
            failures.push(`${name(grid)} leaves an unused metric column`);
          }
        }
      }
    }
    for (const gate of Array.from(document.querySelectorAll(".capability-gate")).filter(visible)) {
      const button = gate.querySelector(":scope > button");
      const explanation = gate.querySelector(":scope > .gate-explanation");
      if (!button || !explanation || !visible(explanation)) continue;
      contained(button, gate);
      contained(explanation, gate);
      if (button.classList.contains("control-icon-button")
        && Math.abs(button.getBoundingClientRect().left - gate.getBoundingClientRect().left) > tolerance) {
        failures.push(`${name(button)} is detached from the start of its capability explanation`);
      }
      if (explanation.getBoundingClientRect().top < button.getBoundingClientRect().bottom - tolerance) {
        failures.push(`${name(button)} overlaps its degraded-capability explanation`);
      }
    }
    for (const cell of Array.from(document.querySelectorAll(".inventory-table td")).filter(visible)) {
      const title = cell.querySelector(":scope > strong");
      const identity = cell.querySelector(":scope > small");
      if (title && identity && identity.getBoundingClientRect().top < title.getBoundingClientRect().bottom - tolerance) {
        failures.push("Inventory resource name and native ID run together instead of occupying separate lines");
      }
    }
    for (const selector of [".filter-action-buttons", ".inventory-actions", ".inline-actions", ".purview-search-actions", ".hunting-search-actions", ".report-section-header", ".report-header-actions", ".report-window-control"]) {
      for (const group of Array.from(document.querySelectorAll(selector)).filter(visible)) {
        const children = Array.from(group.children).filter(visible);
        children.forEach(child => contained(child, group));
        doNotIntersect(children, selector);
        for (const gate of children.filter(child => child.classList.contains("capability-gate"))) {
          const gateButton = gate.querySelector(":scope > button");
          if (!gateButton) continue;
          for (const peer of children.filter(child => child !== gate && child.matches("button, a, .capability-gate"))) {
            const peerButton = peer.matches("button, a") ? peer : peer.querySelector(":scope > button");
            if (!peerButton) continue;
            const a = gate.getBoundingClientRect(), b = peer.getBoundingClientRect();
            if (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > tolerance
              && Math.abs(gateButton.getBoundingClientRect().top - peerButton.getBoundingClientRect().top) > tolerance) {
              failures.push(`${selector}: ${name(gateButton)} is vertically misaligned with ${name(peerButton)}`);
            }
          }
        }
      }
    }
    for (const progress of Array.from(document.querySelectorAll(".job-progress")).filter(visible)) {
      const labels = Array.from(progress.children).filter(visible);
      labels.forEach(label => contained(label, progress));
      doNotIntersect(labels, "Job progress metadata");
    }
    // Wide evidence tables may scroll locally; their containing surface must not escape the grid.
    for (const table of Array.from(document.querySelectorAll(".table-shell")).filter(visible)) {
      contained(table, table.parentElement!);
      if (table.scrollWidth > table.clientWidth + tolerance && !["auto", "scroll"].includes(getComputedStyle(table).overflowX)) {
        failures.push(`${name(table)} has wide data without a local horizontal scroller`);
      }
    }
    return failures;
  }, { fields });
  expect.soft(failures, description).toEqual([]);
}
