import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const styles = [
  "../src/index.css", "../src/App.css",
  "../src/components/unifiedAgent.css", "../src/components/copilotUsers.css",
  "../src/components/agentInsights.css",
  "../src/components/officialUsage.css",
  "../src/components/reportedUsers.css", "../src/components/permissions.css",
  "../src/components/agentWorkspace.css",
  "../src/components/listTable.css",
  "../src/components/automaticRefresh.css",
  "../src/components/workbenchDialog.css", "../src/components/dataSync.css",
  "../src/components/savedInventoryVerification.css",
  "../src/components/workspaceSkeleton.css",
].map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

async function renderStyles(page: Page, content: string) {
  await page.route("**/*", route => route.abort());
  await page.setContent(`<style>${styles}</style>${content}`);
}

test("global recovery errors reflow without pushing diagnostics or retry outside the page", async ({ page }) => {
  const reference = "saved_inventory_request_reference_".repeat(24);
  await renderStyles(page, `<main class="app-shell"><div class="error-banner" role="alert">
    <span>Saved inventory unavailable: ${reference}</span>
    <button type="button" class="secondary">Reload saved agent inventory</button>
  </div></main>`);
  const alert = page.getByRole("alert");
  const retry = page.getByRole("button", { name: "Reload saved agent inventory" });
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 360, 760, 1440]) {
      await page.setViewportSize({ width, height: 640 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await alert.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(alert).toContainText(reference);
      await retry.scrollIntoViewIfNeeded();
      await expect(retry).toBeInViewport({ ratio: 1 });
      await retry.click({ trial: true });
      await retry.focus();
      expect(await retry.evaluate(element => element.matches(":focus-visible")
        && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
    }
  }
});

test("shared unavailable controls differ from usable busy filters without losing retained focus", async ({ page }) => {
  await renderStyles(page, `<main class="app-shell">
    <section class="usage-report-selector" aria-busy="true">
      <select aria-label="Report set" disabled><option>Loading report sets...</option></select>
    </section>
    <div class="inventory-facet"><label>Environment<select aria-busy="true"><option>All environments</option></select></label></div>
    <div class="report-export"><p role="status">ready: 10 rows, 100 bytes.
      <a href="#export" aria-disabled="true">Download CSV</a> Verifying download...</p></div>
  </main>`);
  const unavailable = page.getByRole("combobox", { name: "Report set", exact: true });
  const busy = page.getByRole("combobox", { name: "Environment" });
  const download = page.getByRole("link", { name: "Download CSV" });
  await expect(unavailable).toBeDisabled();
  for (const control of [unavailable, download]) {
    await expect(control).toHaveCSS("cursor", "not-allowed");
    await expect(control).toHaveCSS("opacity", "0.58");
  }
  await expect(busy).toBeEnabled();
  await expect(busy).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(busy).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(download).toBeFocused();
  expect(await download.evaluate(element => element.matches(":focus-visible")
    && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
  await download.evaluate(element => element.setAttribute("aria-disabled", "false"));
  await expect(download).toBeFocused();
  await expect(download).toHaveCSS("opacity", "1");
  await expect(download).toHaveCSS("cursor", "pointer");
  await unavailable.evaluate((element: HTMLSelectElement) => { element.disabled = false; });
  await expect(unavailable).toHaveCSS("opacity", "1");
  await expect(unavailable).toHaveCSS("cursor", "pointer");
});

test("global select affordances use native colors in light and dark forced-color modes", async ({ page }) => {
  await renderStyles(page, `<main class="app-shell">
    <label>Report set<select><option>Current saved reports</option></select></label>
    <div class="report-facet"><label>Company<select aria-disabled="true"><option>All companies</option></select></label></div>
  </main>`);
  const report = page.getByRole("combobox", { name: "Report set" });
  const company = page.getByRole("combobox", { name: "Company" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, forcedColors: "active" });
    for (const control of [report, company]) {
      await expect(control).toHaveCSS("appearance", "auto");
      await expect(control).toHaveCSS("background-image", "none");
      expect(await control.evaluate(element => {
        const style = getComputedStyle(element);
        return style.color !== style.backgroundColor;
      })).toBe(true);
      await control.focus();
      expect(await control.evaluate(element => element.matches(":focus-visible")
        && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
    }
    await expect(company).toHaveCSS("cursor", "not-allowed");
    await expect(company).toHaveCSS("opacity", "0.58");
    await page.emulateMedia({ colorScheme, forcedColors: "none" });
    await expect(report).toHaveCSS("appearance", "none");
    expect(await report.evaluate(element => getComputedStyle(element).backgroundImage)).toContain("data:image/svg+xml");
  }
});

test("facet loading, empty and retained-error layouts keep dynamic recovery and the focused search reachable", async ({ page }) => {
  const reference = "saved_environment_diagnostic_".repeat(20);
  await renderStyles(page, `<main class="app-shell"><section class="agent-workspace">
    <div class="agent-filter-fields"><div class="inventory-facet">
      <label><span>Environment</span><select aria-label="Environment" aria-busy="true">
        <option value="">All environments</option></select></label>
      <label class="inventory-facet-search"><span class="sr-only">Search environments</span>
        <input type="search" value="retained environment search"></label>
    </div></div></section></main>`);
  const facet = page.locator(".inventory-facet");
  const select = page.getByRole("combobox", { name: "Environment" });
  const search = page.getByRole("searchbox", { name: "Search environments" });
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 360, 760, 1440]) {
      await page.setViewportSize({ width, height: 640 });
      for (const state of ["loading", "error", "loading", "empty", "retained"] as const) {
        await search.focus();
        await facet.evaluate((element, { state, reference }) => {
          element.querySelector('[role="alert"]')?.remove();
          const select = element.querySelector("select")!;
          select.setAttribute("aria-busy", String(state === "loading"));
          select.querySelector('option[value="saved"]')?.remove();
          if (state === "retained") select.add(new Option("Saved environment (retained-environment)", "saved"));
          if (state === "error") {
            const alert = document.createElement("p"), retry = document.createElement("button");
            alert.setAttribute("role", "alert");
            alert.append(`Facet options unavailable. ${reference} `);
            retry.type = "button";
            retry.textContent = "Retry options";
            alert.append(retry);
            element.querySelector("label")!.after(alert);
          }
        }, { state, reference });
        await expect(search).toBeFocused();
        await expect(search).toHaveValue("retained environment search");
        await expect(select).toBeEnabled();
        await expect(select).toHaveCSS("opacity", "1");
        await expect(select).toHaveAttribute("aria-busy", String(state === "loading"));
        await expect(select.locator("option")).toHaveCount(state === "retained" ? 2 : 1);
        expect(await facet.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        if (state === "error") {
          const alert = facet.getByRole("alert");
          await expect(alert).toContainText(reference);
          expect(await alert.evaluate(element => element.scrollWidth <= element.clientWidth + 1
            && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
          const retry = alert.getByRole("button", { name: "Retry options" });
          await retry.scrollIntoViewIfNeeded();
          await expect(retry).toBeInViewport({ ratio: 1 });
          await retry.click({ trial: true });
          await retry.focus();
          expect(await retry.evaluate(element => element.matches(":focus-visible")
            && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
        } else await expect(facet.getByRole("alert")).toHaveCount(0);
        await search.scrollIntoViewIfNeeded();
        await expect(search).toBeInViewport({ ratio: 1 });
      }
    }
  }
});

function workspaceSkeleton(view: "agents" | "users" | "audit", contentOnly = false, showSummary = true) {
  const block = (kind: string) => `<span class="skeleton-block skeleton-${kind}"></span>`;
  const context = `<div class="workspace-skeleton-context" aria-hidden="true">${block("label")}${block("control")}</div>`;
  return `<p class="sr-only" role="status">Loading ${view === "audit" ? "audit events" : view}...</p>
    <section class="workspace-skeleton workspace-skeleton-${view}" aria-label="Loading ${view}" aria-busy="true">
      ${contentOnly ? "" : `<header class="workspace-skeleton-heading" aria-hidden="true">
        <h2>${{ agents: "Agents", users: "Users &amp; adoption", audit: "Local control audit" }[view]}</h2>
        <div class="workspace-skeleton-heading-actions">${block("control").repeat(2)}</div>
        ${view === "audit" ? block("description") : ""}</header>`}
      ${showSummary ? `<div class="workspace-skeleton-summary" aria-hidden="true">
        ${`<div class="workspace-skeleton-metric">${block("label")}${block("value")}${block("label")}</div>`.repeat(4)}
        ${view === "audit" ? "" : context}</div>` : view === "users" && !contentOnly ? context : ""}
      <div class="workspace-skeleton-table" aria-hidden="true">
        <div class="workspace-skeleton-toolbar">${block("search")}${block("control").repeat(2)}</div>
        <div class="workspace-skeleton-row workspace-skeleton-columns">${block("label").repeat(6)}</div>
        ${`<div class="workspace-skeleton-row"><div class="workspace-skeleton-name">
          ${view === "agents" ? block("avatar") : ""}<div>${block("label").repeat(2)}</div>
        </div>${block("label").repeat(5)}</div>`.repeat(8)}
        <div class="workspace-skeleton-pagination">${block("label")}${block("control")}</div>
      </div>
    </section>`;
}

for (const view of ["agents", "users", "audit"] as const) {
  for (const contentOnly of [false, true]) {
    test(`workspace skeleton ${view} ${contentOnly ? "content" : "full page"} fits without exposing decorative table overflow`, async ({ page }) => {
      for (const showSummary of [true, false]) {
        await renderStyles(page, `<main class="app-shell">${workspaceSkeleton(view, contentOnly, showSummary)}</main>`);
        for (const fontSize of [16, 32]) {
          await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
          for (const width of [320, 360, 760, 761, 1100, 1101, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
            expect(await page.locator(".workspace-skeleton, .workspace-skeleton-summary, .workspace-skeleton-toolbar, .workspace-skeleton-pagination")
              .evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
            await expect(page.locator(".workspace-skeleton-table")).toHaveCSS("overflow-x", "hidden");
          }
        }
        await expect(page.getByRole("status")).toHaveText(`Loading ${view === "audit" ? "audit events" : view}...`);
        expect(await page.getByRole("status").evaluate(element => element.closest('[aria-busy="true"], [aria-hidden="true"]'))).toBeNull();
        await expect(page.getByRole("button")).toHaveCount(0);
      }
    });
  }
}

test("workspace skeleton and pending counts stay visible in forced colors and respect reduced motion", async ({ page }) => {
  await renderStyles(page, `<main class="app-shell">${workspaceSkeleton("agents")}
    <div class="agent-overview-metrics"><div class="metric"><span>Pending count</span>
      <strong><span class="skeleton-block skeleton-count" aria-label="Loading count"></span></strong></div></div></main>`);
  for (const colorScheme of ["light", "dark"] as const) {
    for (const forcedColors of ["none", "active"] as const) {
      await page.emulateMedia({ colorScheme, forcedColors, reducedMotion: "reduce" });
      const appearances = await page.locator(".skeleton-block").evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element);
        let ancestor = element.parentElement;
        while (ancestor?.parentElement && getComputedStyle(ancestor).backgroundColor === "rgba(0, 0, 0, 0)") ancestor = ancestor.parentElement;
        const surface = getComputedStyle(ancestor ?? document.documentElement).backgroundColor;
        return {
          visible: style.backgroundColor !== surface || style.borderStyle !== "none" && parseFloat(style.borderWidth) > 0 && style.borderColor !== surface,
          animation: style.animationName,
        };
      }));
      expect(appearances.every(appearance => appearance.visible), `Placeholders must remain visible in ${colorScheme}, forced colors ${forcedColors}`).toBe(true);
      expect(appearances.every(appearance => appearance.animation === "none")).toBe(true);
    }
  }
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
  await expect(page.locator(".workspace-skeleton .skeleton-block").first()).toHaveCSS("animation-name", "workspace-skeleton-pulse");
  await expect(page.locator(".skeleton-count")).toHaveCSS("animation-name", "none");
});

test("workbench first-sync recovery remains reachable when the header fills a short viewport", async ({ page }) => {
  await renderStyles(page, `<dialog class="workbench-dialog first-sync-dialog" aria-labelledby="first-sync-title">
    <header class="workbench-dialog-header"><div><h2 id="first-sync-title" tabindex="-1">Sync status is unavailable</h2>
      <p>We're preparing your users and agent inventory. This can take several minutes, especially for large tenants. Your workspace will open automatically when all three sources are saved.</p></div></header>
    <div class="workbench-dialog-body"><div class="first-sync-notice">
      <div class="error-banner" role="alert">The status check failed. Progress below is the last reported status.</div>
      <div class="first-sync-completion"><span role="status">1 of 3 sources saved</span>
        <progress value="1" max="3" aria-label="First sync sources saved"></progress></div>
      <p>Resolve the waiting step, or cancel the run in Sync before trying again.</p>
      <div class="first-sync-actions"><button class="secondary" disabled>Checking status...</button>
        <button class="secondary">View sync details</button><button class="secondary">Review permissions</button></div>
    </div></div></dialog>`);
  const dialog = page.getByRole("dialog", { includeHidden: true });
  await expect(dialog).toBeHidden();
  await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
  const body = dialog.locator(".workbench-dialog-body");
  const retry = dialog.getByRole("button", { name: "Checking status..." });
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveCSS("opacity", "0.58");
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const [width, height] of [[320, 200], [600, 200], [760, 240], [320, 640], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      for (const name of ["View sync details", "Review permissions"]) {
        const button = dialog.getByRole("button", { name });
        await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(button, `Recovery must be reachable at ${width}x${height} with ${fontSize}px text`).toBeInViewport({ ratio: 1 });
        await button.click({ trial: true });
        await button.focus();
        expect(await button.evaluate(element => element.matches(":focus-visible")
          && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      }
      const heading = dialog.getByRole("heading");
      await heading.evaluate(element => element.scrollIntoView({ block: "center" }));
      await expect(heading).toBeInViewport({ ratio: 1 });
    }
  }
  await retry.evaluate((element: HTMLButtonElement) => {
    element.disabled = false;
    element.textContent = "Retry status check";
  });
  const recovered = dialog.getByRole("button", { name: "Retry status check" });
  await expect(recovered).toHaveCSS("opacity", "1");
  await recovered.click({ trial: true });
  await dialog.evaluate((element: HTMLDialogElement) => element.close());
  await expect(dialog).toBeHidden();
});

test("workbench nested recovery scrolls without clipping controls or disturbing the parent", async ({ page }) => {
  const reference = "unavailable_sync_run_reference_".repeat(12);
  await renderStyles(page, `<dialog class="workbench-dialog sync-dialog" aria-labelledby="parent-title">
    <header class="workbench-dialog-header"><div><h2 id="parent-title" tabindex="-1">Inventory diagnostics</h2></div>
      <button class="secondary workbench-dialog-close" aria-label="Close inventory diagnostics">X</button></header>
    <div class="workbench-dialog-body"><p>${reference}</p><input aria-label="Diagnostic draft">
      <button class="secondary">Inspect source job</button>
      <dialog class="workbench-dialog sync-dialog" aria-labelledby="nested-title">
        <header class="workbench-dialog-header"><div><h2 id="nested-title" tabindex="-1">Sync run details</h2>
          <p>Results for this run, not your overall workspace state.</p></div>
          <button class="secondary workbench-dialog-close" aria-label="Close sync run details">X</button></header>
        <div class="workbench-dialog-body"><div class="error-banner" role="alert">Status check failed. ${reference} Showing the last reported run status.</div>
          <button class="secondary">Retry status check</button>
          <dl class="data-sync-run-facts"><div><dt>Run</dt><dd><code>${reference}</code></dd></div>
            <div><dt>Collection</dt><dd>Automatic refresh</dd></div></dl>
          <div class="data-sync-run-actions"><button class="secondary data-sync-cancel" disabled>Cancelling...</button></div>
          <button class="secondary">Back to workspace</button></div>
      </dialog></div></dialog>`);
  const parent = page.locator("dialog").first();
  const nested = parent.locator("dialog");
  await parent.evaluate((element: HTMLDialogElement) => element.showModal());
  const draft = parent.getByRole("textbox", { name: "Diagnostic draft" });
  await draft.fill("Retained diagnostics");
  const opener = parent.getByRole("button", { name: "Inspect source job" });
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const [width, height] of [[320, 200], [600, 240], [760, 360], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await opener.focus();
      const scrollTop = await parent.locator(":scope > .workbench-dialog-body").evaluate(element => element.scrollTop);
      await nested.evaluate((element: HTMLDialogElement) => element.showModal());
      await expect(nested.getByRole("alert")).toContainText("Showing the last reported run status.");
      await expect(nested.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
      expect(await nested.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await nested.locator(".workbench-dialog-body").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      for (const name of ["Retry status check", "Back to workspace", "Close sync run details"]) {
        const button = nested.getByRole("button", { name });
        await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(button).toBeInViewport({ ratio: 1 });
        await button.click({ trial: true });
        await button.focus();
        expect(await button.evaluate(element => element.matches(":focus-visible")
          && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      }
      expect(await parent.locator(":scope > .workbench-dialog-body").evaluate(element => element.scrollTop)).toBe(scrollTop);
      await nested.evaluate((element: HTMLDialogElement) => element.close());
      await expect(nested).toBeHidden();
      await expect(parent).toHaveAttribute("open", "");
      await expect(opener).toBeFocused();
      await expect(draft).toHaveValue("Retained diagnostics");
    }
  }
  await parent.evaluate((element: HTMLDialogElement) => element.close());
  await expect(parent).toBeHidden();
});

for (const state of ["verified", "loading", "failed", "unavailable"] as const) {
  test(`saved inventory verification keeps ${state} evidence and recovery readable in diagnostics`, async ({ page }) => {
    const reference = "saved_inventory_request_reference_".repeat(12);
    const message = state === "loading"
      ? "Checking saved inventory. Any previous receipt is not the result of this check."
      : state === "failed"
        ? `Saved inventory verification failed. The previous receipt has not been reverified. ${reference}`
        : "Saved inventory verification is not available. Read the saved inventory to obtain a receipt.";
    const buttonName = state === "loading" ? "Verifying saved inventory..."
      : state === "failed" ? "Reload saved inventory" : "Verify saved inventory";
    await renderStyles(page, `<dialog class="workbench-dialog sync-dialog" aria-label="Inventory diagnostics">
      <header class="workbench-dialog-header"><div><h2>Inventory diagnostics</h2>
        <p>Saved-data checks do not collect new Microsoft data. The explicit source refresh controls below do.</p></div>
        <button class="secondary workbench-dialog-close" aria-label="Close Inventory diagnostics"><svg width="20" height="20" aria-hidden="true"></svg></button></header>
      <div class="workbench-dialog-body">
        <section class="saved-inventory-verification" aria-label="Saved agent inventory verification" aria-busy="${state === "loading"}">
          <div class="verification-heading"><h3>Saved inventory verification</h3>
            <button class="secondary"${state === "loading" ? " disabled" : ""}><svg width="15" height="15" aria-hidden="true"></svg>${buttonName}</button></div>
          <p>Saved inventory is checked automatically. No manual verification or administrator approval is required after sync.</p>
          ${state === "verified" ? `<p class="verification-success" role="status"><strong>Saved inventory verified</strong> - authorized saved-source collection, accounting and identity consistency.</p>
            <dl class="verification-counts" aria-label="Full saved agent accounting">
              <div><dt>Graph package targets</dt><dd>1,234,567,890</dd></div>
              <div><dt>Power Platform agent targets</dt><dd>1,234,567,890</dd></div>
              <div><dt>Targets represented / unique source targets</dt><dd>2,469,135,780 / 2,469,135,780</dd></div>
              <div><dt>Logical agents</dt><dd>1,234,567,890</dd></div></dl>
            <ul class="verification-checks"><li>Saved source query scopes verified.</li><li>Package identity metadata checked and valid.</li>
              <li>No ambiguous or conflicting identity links.</li><li>Each available source target is represented exactly once.</li></ul>
            <p>These counts cover all unfiltered saved records, not the current page or display filters.</p>
            <dl class="verification-dates"><div><dt>Saved data verified at</dt><dd><time datetime="2026-10-07T16:00:00Z">10/7/2026, 4:00:00 PM</time></dd></div>
              <div><dt>Graph source collected at</dt><dd><time datetime="2026-10-07T15:00:00Z">10/7/2026, 3:00:00 PM</time></dd></div></dl>
            <section class="saved-power-platform-verification" aria-label="Saved Power Platform query verification" aria-busy="false">
              <h4>Power Platform saved request</h4><p class="verification-success"><strong>Authorized Power Platform query verified</strong> - provider total agrees with stored, unique resource identities.</p>
              <dl class="verification-counts" aria-label="Verified Power Platform request counts">
                <div><dt>Resources stored / provider total</dt><dd>1,234,567,890 / 1,234,567,890</dd></div>
                <div><dt>Environment request scope</dt><dd>Environment requested: ${reference}</dd></div>
                <div><dt>Optional directory-role hint</dt><dd>Not supplied</dd></div></dl>
              <details><summary>Actual queried resource types</summary><ul><li><code>microsoft.copilotstudio/${reference}</code></li></ul></details>
              <p class="verification-caveat">Microsoft Power Platform inventory excludes classic/V1 bots. Recent changes may take about 20 minutes to appear.</p>
            </section>` : `<p${state === "failed" ? ' class="verification-attention" role="alert"' : ' role="status"'}>${message}</p>`}
          <p class="verification-caveat">Verification reads saved data, not live Microsoft data. It does not grant permissions or attest universal tenant visibility.</p>
        </section>
      </div></dialog>`);
    const dialog = page.getByRole("dialog", { includeHidden: true });
    await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
    const receipt = page.getByRole("region", { name: "Saved agent inventory verification" });
    const verify = receipt.getByRole("button", { name: buttonName });
    await expect(receipt).toHaveAttribute("aria-busy", String(state === "loading"));
    await expect(verify).toHaveCSS("opacity", state === "loading" ? "0.58" : "1");
    if (state === "loading") await expect(verify).toBeDisabled();
    else await expect(verify).toBeEnabled();
    if (state !== "verified") {
      await expect(receipt.getByRole(state === "failed" ? "alert" : "status")).toHaveText(message);
      await expect(receipt.locator("dl, time, .verification-success")).toHaveCount(0);
    }
    const disclosure = receipt.locator("summary");
    if (state === "verified") {
      await disclosure.focus();
      await page.keyboard.press("Enter");
      await expect(receipt.locator("details")).toHaveAttribute("open", "");
    }
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const [width, height] of [[320, 640], [600, 320], [760, 360], [1024, 640], [1440, 900]]) {
        await page.setViewportSize({ width, height });
        for (const element of await dialog.locator(".workbench-dialog-body, .saved-inventory-verification, .verification-heading, dl, .saved-power-platform-verification, details").all()) {
          expect(await element.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
            `Verification evidence must fit at ${width}x${height} with ${fontSize}px text`).toBe(true);
        }
        for (const control of [dialog.getByRole("button", { name: "Close Inventory diagnostics" }),
          ...(state === "loading" ? [] : [verify]), ...(state === "verified" ? [disclosure] : [])]) {
          await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await expect(control).toBeInViewport({ ratio: 1 });
          await control.click({ trial: true });
          await control.focus();
          expect(await control.evaluate(element => element.matches(":focus-visible")
            && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
        }
      }
    }
  });
}

test("permission setup and recovery fit long evidence, narrow screens and enlarged text", async ({ page }) => {
  const reference = "permission_check_reference_".repeat(12);
  await renderStyles(page, `<main class="app-shell"><section class="permission-center" aria-labelledby="permissions-title" aria-busy="true">
    <header class="permission-heading"><div class="permission-page-icon"><svg width="24" height="24"></svg></div>
      <div class="permission-heading-copy"><h2 id="permissions-title" tabindex="-1">Permissions</h2><p>Setup and troubleshooting for ${reference}.</p></div>
      <div class="permission-actions"><button class="secondary" disabled><svg class="permission-spinner" width="16" height="16"></svg>Checking...</button></div></header>
    <div class="permission-body">
      <nav class="permission-role-topics" aria-label="Permissions sections"><a href="#roles">Signed-in user roles</a><a href="#prerequisites">App API permissions</a><a href="#logs">Log setup</a></nav>
      <div class="permission-notice" role="status">Sign-in failed. ${reference}</div>
      <section class="permission-progress" aria-label="Permission check progress">
        <div class="permission-progress-heading"><svg class="permission-spinner" width="22" height="22"></svg>
          <div role="status"><strong>Checking permissions</strong><p>Live check details are unavailable. Checks are still running.</p></div></div>
        <progress aria-label="Permission checks reviewed"></progress>
        <ul class="permission-progress-checks"><li><span class="permission-progress-dot"></span><span><strong>Power Platform inventory</strong><span>Checking Microsoft access</span></span></li></ul>
      </section>
      <section class="permission-issues" aria-labelledby="issues-title"><h3 id="issues-title">Issues</h3>
        <div class="error-banner" role="alert">Permission checks could not be loaded. ${reference}</div>
        <ul class="permission-issue-list"><li><div><strong>Agent inventory</strong><p>Microsoft is limiting requests. Try again after the cooldown.</p></div>
          <div class="permission-actions"><a href="#setup">Admin setup</a><button class="permission-text-button" aria-label="Details: Agent inventory">Details</button></div></li></ul></section>
      <section id="prerequisites" class="permission-log-setup permission-prerequisites"><header><h3>App prerequisites</h3><a href="#admin">Open Entra admin center</a></header>
        <details open><summary>Required API permissions</summary><p class="permission-setup-note">The feature permission list is unavailable. Consult the deployment setup guide; this is not an empty requirements list.</p>
          <div class="permission-requirements"><section><h4>Microsoft Graph / Delegated</h4><dl class="permission-feature-list"><div><dt><code>${reference}</code></dt><dd><ul><li>${reference}</li></ul></dd></div></dl></section></div></details></section>
      <section id="logs" class="permission-log-setup permission-collection-setup"><details open><summary>Log collection setup</summary>
        <ul class="permission-setup-list"><li><div class="permission-setup-heading"><strong>Purview auditing</strong><span class="permission-setup-tag">For audit records</span><a href="#audit">Open Audit Search</a></div>
          <p>Check the recording banner, or verify status with Exchange Online PowerShell below.</p><details open><summary>Steps &amp; permissions</summary>
            <pre><code>Get-AdminAuditLogConfig | Format-List UnifiedAuditLogIngestionEnabled</code></pre><dl><div><dt>Read access</dt><dd>${reference}</dd></div></dl></details></li></ul></details></section>
      <section id="roles" class="permission-user-roles"><h3>Signed-in user roles</h3><article class="permission-role-row"><div><h4>Run Defender and Agent 365 hunts</h4><p>Agents &gt; Activity</p></div>
        <div class="permission-role-requirement"><p>Security Reader</p><p>${reference}</p><ul class="permission-role-sources"><li><a href="#documentation">Microsoft references</a></li></ul></div></article></section>
    </div></section></main>`);
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 600, 760, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const selector of [".permission-center", ".permission-progress", ".permission-issues", ".permission-prerequisites", ".permission-collection-setup", ".permission-user-roles"]) {
        expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `${selector} must fit at ${width}px with ${fontSize}px text`).toBe(true);
      }
      for (const control of [page.getByRole("button", { name: "Details: Agent inventory" }),
        page.getByRole("link", { name: "Open Entra admin center" }), page.getByText("Steps & permissions", { exact: true })]) {
        await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
        await control.focus();
        expect(await control.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      }
    }
  }
  await expect(page.getByRole("button", { name: "Checking..." })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Checking..." })).toHaveCSS("opacity", "0.58");
  await expect(page.getByRole("button", { name: "Details: Agent inventory" })).toHaveCSS("opacity", "1");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const element of await page.locator(".permission-spinner, .permission-progress-dot, .permission-progress progress").all()) {
    await expect(element).toHaveCSS("animation-name", "none");
  }
});

test("permission details retain readable diagnostics and reachable recovery in short viewports", async ({ page }) => {
  const reference = "provider_error_correlation_".repeat(12);
  await renderStyles(page, `<dialog class="workbench-dialog permission-details">
    <header class="workbench-dialog-header"><div><h2 tabindex="-1">Agent inventory</h2></div><button class="secondary workbench-dialog-close" aria-label="Close agent inventory">X</button></header>
    <div class="workbench-dialog-body"><div class="error-banner" role="alert">${reference}</div><p class="permission-detail-explanation">Microsoft did not respond after retrying.</p>
      <section class="permission-detail-section"><h3>Required setup</h3><dl class="permission-metadata"><div><dt>API permissions</dt><dd>${reference}</dd></div><div><dt>Microsoft roles</dt><dd>${reference}</dd></div></dl></section>
      <details class="permission-technical" open><summary>Technical details</summary><dl class="permission-metadata"><div><dt>Provider request / correlation ID</dt><dd>${reference}</dd></div></dl><ul><li>${reference}</li></ul></details>
      <section class="permission-detail-section"><h3>Setup links</h3><p>${reference}</p><div class="permission-actions"><a href="#admin">Entra admin center</a><a href="#documentation">Microsoft documentation</a></div></section>
      <div class="permission-actions"><a href="#signin">Sign in again</a></div></div></dialog>`);
  const dialog = page.getByRole("dialog", { includeHidden: true });
  await expect(dialog).toBeHidden();
  await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const [width, height] of [[320, 640], [600, 320], [760, 360], [1024, 640]]) {
      await page.setViewportSize({ width, height });
      for (const selector of [".permission-details", ".workbench-dialog-body", ".permission-metadata"]) {
        for (const element of await page.locator(selector).all()) {
          expect(await element.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
            `${selector} must fit at ${width}x${height} with ${fontSize}px text`).toBe(true);
        }
      }
      for (const control of [page.getByRole("button", { name: "Close agent inventory" }),
        page.getByText("Technical details", { exact: true }), page.getByRole("link", { name: "Sign in again" })]) {
        await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
        await control.focus();
        expect(await control.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      }
    }
  }
  await dialog.evaluate((element: HTMLDialogElement) => element.close());
  await expect(dialog).toBeHidden();
});

test("permission gate recovery and the package Preview warning remain visible with keyboard focus", async ({ page }) => {
  const warning = "Preview APIs can change. Review the exact targets before confirming changes.";
  await renderStyles(page, `<main class="app-shell"><section class="bulk-panel" aria-label="Exact package bulk actions">
    <div><h2>Access and availability</h2><span class="preview-badge" tabindex="0" aria-label="${warning}">Preview<span role="tooltip">${warning}</span></span>
      <span class="selected-count">1 selected · published versions</span></div>
    <div class="bulk-buttons"><span class="capability-gate"><button disabled aria-describedby="blocked-reason">Block selected packages</button>
      <span class="gate-explanation" id="blocked-reason"><span>The provider throttled the check. Wait until the current evidence cooldown expires before retrying; changing permissions will not resolve throttling.</span>
        <button class="permission-link" aria-label="Permissions: Package blocking">Permissions</button></span></span></div>
    </section></main>`);
  const badge = page.getByLabel(warning, { exact: true });
  const tooltip = page.getByRole("tooltip");
  const recovery = page.getByRole("button", { name: "Permissions: Package blocking" });
  await expect(tooltip).toBeHidden();
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 600, 760, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await badge.focus();
      await expect(tooltip).toBeInViewport({ ratio: 1 });
      expect(await badge.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      expect(await page.locator(".bulk-panel").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await recovery.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
      await expect(recovery).toBeInViewport({ ratio: 1 });
      await recovery.click({ trial: true });
      await recovery.focus();
      expect(await recovery.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      await expect(recovery).toHaveCSS("opacity", "1");
    }
  }
  await expect(page.getByRole("button", { name: "Block selected packages" })).toBeDisabled();
  await badge.hover();
  await expect(tooltip).toBeInViewport({ ratio: 1 });
});

test("official usage report evidence, filters and export recovery fit narrow screens and enlarged text", async ({ page }) => {
  const reference = "saved_report_evidence_".repeat(12);
  await renderStyles(page, `<main class="app-shell">
    <section class="usage-report-selector" aria-label="Report set selection" aria-busy="true">
      <select aria-label="Report set" disabled><option>Loading report sets...</option></select>
      <div class="report-status error" role="alert">${reference}<button class="secondary">Retry report sets</button></div>
    </section>
    <section class="reporting-view" aria-label="Agent activity report">
      <h3>Agent activity</h3><section class="usage-report-context" aria-label="Report provenance">
        <span>Stale</span><p role="status">Reports are out of date. Historical totals remain visible, not current activity.</p>
        <details open><summary>Report sources</summary><dl><div><dt>agents</dt><dd>Version ${reference}; source freshness unknown</dd></div></dl>
          <p>History revision 3; selected set ${reference}. Activity dates do not prove continuous coverage.</p></details></section>
      <div class="report-metric-groups"><section class="agent-overview-metrics" aria-label="Snapshot tenant totals">
        <div class="metric"><span>Responses</span><strong>1,234,567,890</strong></div>
        <div class="metric"><span>Distinct active report users</span><strong>Unknown</strong><small>Not additive across agents</small></div></section>
        <div class="agent-overview-metrics"><div class="metric"><span>Reported agents</span><strong>1,234,567,890</strong></div></div></div>
      <div class="report-filters">
        <label>Search agents<input type="search" /></label>
        <fieldset class="report-facet"><legend>Creator type</legend>
          <label>Search creator type options<input type="search" /></label>
          <select aria-label="Creator type" aria-disabled="true"><option>All creator types</option></select>
          <div class="report-facet-pages"><span>Unknown options</span>
            <button aria-disabled="true">Previous</button><button aria-disabled="true">Next</button></div>
          <p role="alert">${reference}<button>Retry options</button></p></fieldset>
        <label>Activity start date<input type="date" /></label><label>Activity end date<input type="date" /></label>
        <p>Last-activity filters select agents by their reported dates. Responses remain full-snapshot totals.</p>
        <label>Activity window (days)<input type="number" value="30" /></label>
        <label>Sort agents<select><option>Responses descending</option></select></label><button class="secondary">Clear filters</button>
        <div class="report-export"><button class="secondary" disabled>Preparing export...</button>
          <button class="secondary">Cancel export</button><p role="alert">${reference}</p></div>
      </div>
      <div class="error-banner" role="alert">${reference}<button>Retry saved data</button></div>
      <nav class="copilot-users-pagination" aria-label="agents pages" aria-busy="true"><span role="status">Unknown matching agents</span>
        <button class="secondary" aria-disabled="true">Previous agents</button><button class="secondary" aria-disabled="true">Next agents</button></nav>
      <section class="usage-agent-detail" aria-label="Exact reported agent details"><h4>${reference}</h4>
        <button>Close agent details</button><p>Exact report identity: ${reference}</p></section>
    </section></main>`);
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 600, 721, 1000, 1101, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const selector of [".usage-report-selector", ".reporting-view", ".usage-report-context", ".report-filters", ".report-facet", ".report-export", ".usage-agent-detail"]) {
        expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `${selector} must fit at ${width}px with ${fontSize}px text`).toBe(true);
      }
      for (const name of ["Retry report sets", "Retry options", "Cancel export", "Retry saved data", "Close agent details"]) {
        const control = page.getByRole("button", { name, exact: true });
        await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
      }
    }
  }
  await expect(page.getByRole("button", { name: "Preparing export..." })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel export" })).toHaveCSS("opacity", "1");
  for (const control of [page.getByRole("combobox", { name: "Creator type", exact: true }),
    page.getByRole("button", { name: "Previous agents" }), page.getByRole("button", { name: "Next", exact: true })]) {
    await control.focus();
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("cursor", "not-allowed");
    await expect(control).toHaveCSS("opacity", "0.58");
    expect(await control.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
  }
});

test("official usage dialogs keep import and management recovery reachable in short viewports", async ({ page }) => {
  const reference = "saved_report_reference_".repeat(10);
  for (const importing of [true, false]) {
    await renderStyles(page, `<dialog class="official-usage-modal${importing ? " usage-import-modal" : ""}">
      <header class="usage-modal-header"><div><h2>${importing ? "Add CSV reports" : "Manage reports"}</h2></div>
        ${importing ? "" : '<div class="usage-modal-header-actions"><button>Add CSV reports</button><button class="icon-button" aria-label="Close reports">X</button></div>'}</header>
      <div class="usage-modal-content">${importing ? `<section class="official-usage-import" aria-label="Import CSV reports" aria-busy="true">
        <div class="usage-import-body">
          <div class="report-status error" role="alert"><h3>Import needs attention</h3><p>${reference}</p></div>
          <p class="usage-import-progress" role="status">Checking CSV files...</p>
          <ul class="usage-upload-files"><li data-status="rejected"><svg width="20" height="20"></svg><div><strong>${reference}.csv</strong><span>Upload needs attention</span></div></li></ul>
          <div class="usage-upload-zone"><strong>Drop your three CSV exports here</strong><span>Agents, Users &amp; agents, and Users</span>
            <button disabled>Choose CSV files</button><small>CSV files, up to 256 MiB each</small></div>
          <section class="usage-import-section" role="alertdialog" aria-label="Discard staged import" tabindex="-1">
            <p>Check this import and discard any unaccepted staged files before closing? Accepted report sets will not be deleted. The import stays open if cleanup cannot be verified.</p>
            <button>Discard staged import</button><button>Continue import</button></section>
        </div><footer class="usage-import-footer"><button class="secondary" disabled>Cancel import</button><button>Refresh bundle validation</button></footer>
      </section>` : `<section class="usage-manage-reports" aria-label="Manage saved reports" tabindex="0">
        <section class="official-usage-history-panel"><div class="error-banner" role="alert">${reference}<button>Retry saved data</button></div>
          <div class="table-shell usage-history-table" role="region" aria-label="Saved report history" aria-busy="true" tabindex="0"><table><thead><tr><th>Imported</th><th>Activity dates</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody><tr><td><span class="usage-mobile-label" aria-hidden="true">Imported</span>10/7/2026</td><td><span class="usage-mobile-label" aria-hidden="true">Activity dates</span>No activity dates</td>
            <td><span class="usage-mobile-label" aria-hidden="true">Status</span><span class="usage-report-badge">Saved</span></td>
            <td><div class="table-actions"><button class="secondary" disabled>View report</button><button class="icon-button danger" aria-label="Delete report set" disabled>X</button></div></td></tr></tbody></table></div>
        </section></section>`}</div></dialog>`);
    const dialog = page.locator("dialog.official-usage-modal");
    await expect(dialog).toBeHidden();
    await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const [width, height] of [[320, 640], [600, 320], [721, 360], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        for (const selector of importing ? [".official-usage-modal", ".usage-import-body", ".usage-import-footer"] : [".official-usage-modal", ".usage-manage-reports", ".official-usage-history-panel"]) {
          expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
            `${selector} must not scroll horizontally at ${width}x${height} with ${fontSize}px text`).toBe(true);
        }
        for (const name of importing ? ["Discard staged import", "Continue import", "Refresh bundle validation"] : ["Close reports", "Retry saved data"]) {
          const control = page.getByRole("button", { name, exact: true });
          await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await expect(control, `${name} at ${width}x${height} with ${fontSize}px text`).toBeInViewport({ ratio: 1 });
          await control.click({ trial: true });
        }
      }
    }
    if (!importing) {
      const table = page.getByRole("region", { name: "Saved report history" });
      await table.evaluate(element => { element.scrollLeft = 0; });
      await table.focus();
      await expect(table).toBeFocused();
      await expect(table).toHaveCSS("overflow-x", "auto");
      expect(await table.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      if (await table.evaluate(element => element.scrollWidth > element.clientWidth)) {
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      }
    }
    await dialog.evaluate((element: HTMLDialogElement) => element.close());
    await expect(dialog).toBeHidden();
  }
});

test("official usage snapshot, import success and nested deletion preserve readable evidence and recovery", async ({ page }) => {
  const reference = "saved_report_evidence_".repeat(10);
  const snapshot = `<section class="usage-snapshot" aria-label="Snapshot inspection" tabindex="0">
    <header class="report-section-header"><button class="secondary">Back to reports</button><p>Viewing this report does not change the selected report set.</p></header>
    <section class="reporting-view"><h3>Agent activity</h3>
      <p role="status">Showing previously read snapshot totals; filtered rows are unavailable.</p>
      <div class="error-banner" role="alert">${reference}<button>Retry saved data</button></div>
      <div class="table-shell report-agent-table" role="region" aria-label="Reported agent activity" tabindex="0" aria-busy="true"><table><thead><tr>
        ${["Agent", "Responses", "Active users", "Last reported activity"].map(label =>
          `<th aria-sort="${label === "Responses" ? "descending" : "none"}"><button class="table-sort-heading">${label}</button></th>`).join("")}
        <th>Creator</th><th>Licensed / unlicensed occurrences</th><th>Comparison</th></tr></thead><tbody></tbody></table></div>
      <nav class="copilot-users-pagination" aria-label="agents pages" aria-busy="true"><span>Unknown matching agents</span><button aria-disabled="true">Previous agents</button><button aria-disabled="true">Next agents</button></nav>
    </section></section>`;
  const success = `<section class="official-usage-import" aria-label="Import CSV reports"><div class="usage-import-body">
    <div class="usage-import-success"><h3 tabindex="-1">Reports imported</h3><p role="status">Your report set has been saved.</p>
      <section aria-label="Imported CSV summary"><dl class="usage-import-statistics">${["Agents", "Users", "Responses"].map(label =>
        `<div><dt>${label}</dt><dd>1,234,567,890,123</dd></div>`).join("")}</dl></section></div>
    </div><footer class="usage-import-footer"><button class="secondary">Add more reports</button><button>Close</button></footer></section>`;
  const deletion = `<section class="usage-manage-reports" tabindex="0"><dialog class="confirm-modal" aria-label="Delete report set?">
    <h2>Delete report set?</h2><p>This removes report ${reference}. History pages, overview and exports will be invalidated.</p>
    <p role="alert">Deletion may already have completed. Reload report history to verify; do not repeat this confirmation. ${reference}</p>
    <button class="secondary">Cancel</button><button class="danger" disabled>Delete report set</button><button>Reload report history</button>
    <button>Import correction instead</button></dialog></section>`;
  for (const state of ["snapshot", "success", "deletion"] as const) {
    await renderStyles(page, `<dialog class="official-usage-modal${state === "success" ? " usage-import-modal" : ""}">
      <header class="usage-modal-header"><h2>${state === "snapshot" ? "Report details" : state === "success" ? "Add CSV reports" : "Manage reports"}</h2></header>
      <div class="usage-modal-content">${state === "snapshot" ? snapshot : state === "success" ? success : deletion}</div></dialog>`);
    await page.locator(".official-usage-modal").evaluate((element: HTMLDialogElement) => element.showModal());
    if (state === "deletion") await page.locator(".confirm-modal").evaluate((element: HTMLDialogElement) => element.showModal());
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const [width, height] of [[320, 640], [600, 320], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        const container = page.locator(state === "deletion" ? ".confirm-modal" : state === "snapshot" ? ".usage-snapshot" : ".usage-import-body");
        expect(await container.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `${state} evidence must fit at ${width}x${height} with ${fontSize}px text`).toBe(true);
        for (const name of state === "snapshot" ? ["Back to reports", "Retry saved data", "Responses", "Last reported activity"] : state === "success" ? ["Add more reports", "Close"] : ["Cancel", "Reload report history", "Import correction instead"]) {
          const control = page.getByRole("button", { name, exact: true });
          await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "center" }));
          await expect(control, `${name} at ${width}x${height} with ${fontSize}px text`).toBeInViewport({ ratio: 1 });
          await control.click({ trial: true });
        }
      }
    }
  }
});

test("official usage agent detail links retain readable hover and keyboard focus", async ({ page }) => {
  await renderStyles(page, `<section class="reporting-view"><div class="table-shell report-agent-table" role="region" aria-label="Reported agent activity" tabindex="0">
    <table><tbody><tr><td><button class="usage-agent-name" aria-expanded="false">Saved agent</button></td></tr></tbody></table></div></section>`);
  const button = page.getByRole("button", { name: "Saved agent" });
  await button.hover();
  await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await button.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(button).toBeFocused();
  expect(await button.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
});

for (const fixture of [
  { name: "reported users", container: "copilot-users", stack: "agent-table-stack user-directory-table",
    shell: "table-shell copilot-users-table-shell", table: "agent-table copilot-users-table reported-users-table",
    labels: ["User", "Agent responses", "Agents used", "Company", "Department", "Last activity"], plainLabels: [], icons: true },
  { name: "user-agent relationships", container: "copilot-user-dialog", stack: "reported-user-agents",
    shell: "copilot-users-table-shell", table: "copilot-users-table reported-agent-table",
    labels: ["Agent", "Creator", "Responses to this user", "Agent-wide last activity"], plainLabels: [], icons: true },
  { name: "reported agents", container: "reporting-view", stack: "", shell: "table-shell report-agent-table", table: "",
    labels: ["Agent", "Responses", "Active users", "Last reported activity"],
    plainLabels: ["Creator", "Licensed / unlicensed occurrences", "Comparison"], icons: false },
  { name: "sync history", container: "jobs-view sync-history", stack: "", shell: "sync-table-scroll", table: "sync-history-table",
    labels: ["Started", "Scope", "Outcome", "Result", "Duration"], plainLabels: ["Details"], icons: true },
]) {
  test(`shared sort headings and retained paging stay readable and focusable in ${fixture.name}`, async ({ page }) => {
    const reference = "saved_record_reference_".repeat(12);
    const arrow = '<svg width="14" height="14" aria-hidden="true"><path d="M2 7h10"></path></svg>';
    await renderStyles(page, `<main class="app-shell"><section class="${fixture.container}" aria-busy="true">
      <div class="${fixture.stack}"><div class="${fixture.shell}" role="region" aria-label="Scrollable saved records" tabindex="0">
        <table class="${fixture.table}"><thead><tr>${fixture.labels.map((label, index) =>
          `<th scope="col" aria-sort="${index ? "none" : "ascending"}"><button class="table-sort-heading">${label}${fixture.icons ? arrow : ""}</button></th>`).join("")}
          ${fixture.plainLabels.map(label => `<th scope="col">${label}</th>`).join("")}
        </tr></thead><tbody><tr>${[...fixture.labels, ...fixture.plainLabels].map((_, index) => `<td>${index === 1 ? reference : "Saved value"}</td>`).join("")}</tr></tbody></table>
      </div>
      <nav class="${fixture.name === "sync history" ? "sync-history-pagination" : "copilot-users-pagination"}" aria-label="Saved record pages" aria-busy="true">
        <button class="secondary" aria-disabled="true">Previous records</button>
        <button class="secondary" aria-disabled="true">Next records</button>
      </nav></div>
      <p role="status">Updating saved records...</p><div class="error-banner" role="alert">Some saved records are unavailable.</div>
    </section></main>`);
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const width of [320, 760, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        const shell = page.getByRole("region", { name: "Scrollable saved records" });
        await expect(shell).toHaveCSS("overflow-x", "auto");
        expect(await page.locator(`.${fixture.container.split(" ").at(-1)}`).evaluate(element =>
          element.scrollWidth <= element.clientWidth + 1), `Only the table should scroll in ${fixture.name} at ${width}px`).toBe(true);
        for (const label of fixture.labels) {
          const heading = page.getByRole("button", { name: label, exact: true });
          await expect(heading).toBeEnabled();
          await expect(heading).toHaveCSS("opacity", "1");
          await heading.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await heading.focus();
          await expect(heading).toHaveCSS("outline-style", "solid");
          await expect(heading).toHaveCSS("outline-width", "2px");
          expect(await heading.evaluate(element => {
            const button = element.getBoundingClientRect(), cell = element.closest("th")!.getBoundingClientRect();
            return element.scrollWidth <= element.clientWidth + 1 && button.left >= cell.left && button.right <= cell.right;
          }), `${label} must fit its own column at ${width}px with ${fontSize}px text`).toBe(true);
          if (fixture.icons) await expect(heading.locator("svg")).toHaveCSS("width", "14px");
          await heading.click({ trial: true });
        }
      }
    }
    for (const name of ["Previous records", "Next records"]) {
      const button = page.getByRole("button", { name });
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toHaveCSS("cursor", "not-allowed");
      await expect(button).toHaveCSS("opacity", "0.58");
      expect(await button.evaluate(element => {
        const style = getComputedStyle(element);
        return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      })).toBe(true);
    }
    await expect(page.getByRole("status")).toBeVisible();
    await expect(page.getByRole("alert")).toBeVisible();
  });
}

test("data sync history distinguishes unavailable refresh from usable busy controls and preserves focus", async ({ page }) => {
  await renderStyles(page, `<section class="jobs-view sync-history" aria-busy="true">
    <div class="section-heading"><h2>Sync history</h2>
      <button class="secondary" aria-disabled="true">Refresh history</button></div>
    <div class="sync-history-controls"><label class="sync-history-filter">Outcome
      <select><option>All outcomes</option><option>Incomplete or stopped</option></select></label></div>
    <p role="status">Updating sync history...</p>
    <div class="sync-table-scroll" role="region" aria-label="Scrollable sync history" tabindex="0">
      <table class="sync-history-table"><thead><tr><th>Started</th><th>Scope</th></tr></thead>
        <tbody><tr><td>10/7/2026</td><td>Users, Graph packages, Power Platform</td></tr></tbody></table></div>
    <div class="data-sync-run-actions"><button class="secondary data-sync-cancel" disabled aria-busy="true">Cancelling...</button></div>
  </section>`);
  await page.keyboard.press("Tab");
  const refresh = page.getByRole("button", { name: "Refresh history" });
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS("cursor", "not-allowed");
  await expect(refresh).toHaveCSS("opacity", "0.58");
  const filter = page.getByRole("combobox", { name: "Outcome" });
  const table = page.getByRole("region", { name: "Scrollable sync history" });
  for (const control of [refresh, filter, table]) {
    await expect(control).toBeFocused();
    expect(await control.evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    })).toBe(true);
    await page.keyboard.press("Tab");
  }
  await expect(filter).toBeEnabled();
  await expect(filter).toHaveCSS("opacity", "1");
  await expect(page.getByRole("button", { name: "Cancelling..." })).toBeDisabled();
});

test("data sync workspace and saved-status recovery fit narrow screens and enlarged text", async ({ page }) => {
  const reference = "unavailable_saved_sync_request_".repeat(8);
  await renderStyles(page, `<main class="app-shell">
    <section class="data-sync-panel" aria-busy="true">
      <header class="data-sync-page-header"><div class="data-sync-page-icon">S</div>
        <div><h2>Data sync</h2><p>Keep workspace data up to date.</p></div>
        <div class="data-sync-toolbar"><button disabled>Sync all sources</button><button class="secondary">Retry status check</button></div></header>
      <div class="data-sync-details"><div class="error-banner" role="alert">${reference} Showing the last reported workspace status.</div>
        <section class="data-sync-activity"><section class="data-sync-progress">
          <div class="data-sync-progress-heading"><div><strong>Last reported: Syncing power platform</strong><p>1 of 3 automatic sources complete</p></div></div>
          <progress value="1" max="3" aria-label="Completed sync sources"></progress>
          <ol class="data-sync-live-sources"><li class="data-sync-live-source source-permission-required">
            <span class="status-badge status-permission-required">Permission required</span>
            <div><strong>Power Platform</strong><p>${reference}</p><button class="secondary">Review permissions</button></div>
            <div class="data-sync-live-count"><strong>1,234,567,890</strong><span>reported, not a saved total</span></div>
          </li></ol></section>
          <div class="data-sync-activity-footer"><p class="data-sync-run-meta">Sync continues when you switch tabs.
            <button class="sync-text-button">View run details</button></p>
            <div class="data-sync-run-actions"><button class="secondary data-sync-cancel">Cancel run</button></div></div></section>
        <section class="data-sync-workspace"><div class="section-heading"><h3>Workspace data</h3><span class="data-sync-state state-attention">1 of 3 sources synced</span></div>
          <div class="data-sync-sources"><article class="data-sync-source">
            <div class="data-sync-source-name"><strong>Power Platform</strong><p>Agents and environment metadata</p></div>
            <dl><div><dt>Last saved count</dt><dd>1,234,567,890</dd></div><div><dt>Last successful sync</dt><dd>10/7/2026, 12:30 PM</dd></div></dl>
            <div class="data-sync-source-actions"><div class="data-sync-source-attempt"><span>Last reported attempt</span>
              <span class="status-badge status-permission-required">Permission required</span></div><button class="secondary" disabled>Sync power platform</button></div>
          </article></div></section></div>
    </section>
    <section class="data-sync-reports"><header class="data-sync-page-header"><div class="data-sync-page-icon">C</div>
      <div><h2>CSV usage reports</h2><p>Import Microsoft 365 usage exports to see agent activity.</p></div>
      <div class="data-sync-toolbar"><button>Add CSV reports</button><button class="secondary">Manage reports</button></div></header>
      <div class="data-sync-details"><div class="error-banner" role="alert">${reference}<button class="secondary">Retry reports</button></div></div>
    </section>
    <section class="sync-inventory-tools"><div class="sync-inventory-summary"><div>
      <div class="sync-health-heading"><h2>Inventory health</h2><span class="data-sync-state state-attention">Needs attention</span></div>
      <p>${reference}</p></div><button class="secondary">View diagnostics</button></div></section>
    <section class="jobs-view sync-history"><h2>Sync history</h2><div class="sync-history-controls">
      <label class="sync-history-filter">Outcome<select><option>Incomplete or stopped</option></select></label></div>
      <div class="error-banner" role="alert">${reference}</div>
      <div class="sync-table-scroll" role="region" aria-label="Scrollable sync history" tabindex="0">
        <table class="sync-history-table"><tbody><tr><td>10/7/2026</td><td>${reference}</td><td>Partial results</td></tr></tbody></table></div>
    </section>
  </main>`);
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 360, 600, 601, 760, 1000, 1001, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const selector of [".data-sync-panel", ".data-sync-live-source", ".data-sync-reports", ".sync-inventory-tools", ".sync-history", ".sync-history-filter"]) {
        expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `${selector} must fit at ${width}px with ${fontSize}px text`).toBe(true);
      }
      for (const name of ["Retry status check", "Review permissions", "View run details", "Cancel run", "Manage reports", "Retry reports", "View diagnostics"]) {
        const button = page.getByRole("button", { name, exact: true });
        await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(button).toBeInViewport({ ratio: 1 });
        await button.click({ trial: true });
      }
      const history = page.getByRole("region", { name: "Scrollable sync history" });
      await expect(history).toHaveCSS("overflow-x", "auto");
      if (width < 760) expect(await history.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    }
  }
});

test("data sync first-sync and exact-run dialogs retain recovery controls without horizontal scrolling", async ({ page }) => {
  const reference = "unavailable_sync_receipt_".repeat(8);
  for (const firstSync of [true, false]) {
    const content = firstSync ? `<div class="first-sync-notice">
      <div class="error-banner" role="alert">${reference} Showing the last reported status.</div>
      <div class="first-sync-completion"><span role="status">1 of 3 sources saved</span><progress value="1" max="3" aria-label="First sync sources saved"></progress></div>
      <ul class="first-sync-sources"><li><div><strong>Power Platform</strong><span>Permission required</span></div>
        <p>${reference}</p><button class="secondary">Review permissions</button></li>
        <li><div><strong>Users</strong><span>Complete</span></div><p>100 users saved</p></li>
        <li><div><strong>Graph packages</strong><span>Sign-in required</span></div><a href="/api/auth/login">Sign in again</a></li></ul>
      <div class="first-sync-actions"><button disabled>Retry incomplete sources</button>
        <button class="secondary">Retry status check</button><button class="secondary">View sync details</button></div>
    </div>` : `<div class="error-banner" role="alert">${reference} Showing the last reported run status.</div>
      <button class="secondary">Retry status check</button>
      <dl class="data-sync-run-facts"><div><dt>Run</dt><dd><code>${reference}</code></dd></div>
        <div><dt>Collection</dt><dd>Automatic refresh</dd></div></dl>
      <section class="data-sync-progress"><div class="data-sync-progress-heading"><div><strong>Last reported: Sync needs attention</strong></div></div>
        <progress value="1" max="3" aria-label="Completed sync sources"></progress>
        <ol class="data-sync-live-sources"><li class="data-sync-live-source source-permission-required">
          <span class="status-badge status-permission-required">Permission required</span><div><strong>Power Platform</strong>
            <p>${reference}</p><button class="secondary">Review permissions</button></div>
          <div class="data-sync-live-count"><strong>1,234,567,890</strong><span>reported, not a saved total</span></div></li></ol></section>
      <div class="data-sync-run-actions"><button class="secondary data-sync-cancel">Cancel run</button></div>
      <button class="secondary">Back to workspace</button>`;
    await renderStyles(page, `<dialog class="workbench-dialog ${firstSync ? "first-sync-dialog" : "sync-dialog"}">
      <header class="workbench-dialog-header"><div><h2>${firstSync ? "Sync status is unavailable" : "Sync run details"}</h2>
        <p>${firstSync ? "Your workspace will open automatically when all three sources are saved." : "Results for this run, not your overall workspace state."}</p></div></header>
      <div class="workbench-dialog-body">${content}</div></dialog>`);
    const dialog = page.locator("dialog");
    await expect(dialog).toBeHidden();
    await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const [width, height] of [[320, 640], [601, 360], [701, 640], [1024, 640]]) {
        await page.setViewportSize({ width, height });
        const body = page.locator(".workbench-dialog-body");
        expect(await body.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `Recovery dialog must not scroll horizontally at ${width}px with ${fontSize}px text`).toBe(true);
        for (const name of ["Review permissions", "Retry status check", firstSync ? "View sync details" : "Back to workspace"]) {
          const button = page.getByRole("button", { name, exact: true });
          await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await expect(button).toBeInViewport({ ratio: 1 });
          await button.click({ trial: true });
        }
      }
    }
    await dialog.evaluate((element: HTMLDialogElement) => element.close());
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Retry status check" })).toHaveCount(0);
  }
});

test("data sync reduced-motion styles keep progress and cancellation available", async ({ page }) => {
  await renderStyles(page, `<section class="data-sync-panel">
    <section class="data-sync-progress is-running"><div class="data-sync-progress-heading" role="status">
      <svg class="data-sync-spinning" width="24" height="24" aria-hidden="true"></svg><strong>Syncing users</strong></div>
      <progress value="1" max="3" aria-label="Completed sync sources"></progress></section>
    <div class="data-sync-run-actions"><button class="secondary data-sync-cancel">Cancel run</button></div>
  </section>`);
  const spinner = page.locator(".data-sync-spinning");
  await expect(spinner).toHaveCSS("animation-name", "data-sync-spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(spinner).toHaveCSS("animation-name", "none");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "1");
  const cancel = page.getByRole("button", { name: "Cancel run" });
  await cancel.focus();
  await expect(cancel).toBeFocused();
  await expect(cancel).toBeEnabled();
  await cancel.click({ trial: true });
});

test("automatic refresh guidance and navigation fit enlarged text without hiding keyboard focus", async ({ page }) => {
  await renderStyles(page, `<main class="app-shell">
    <section class="automatic-refresh-status" aria-label="Automatic refresh">
      <div>
        <div role="status" aria-live="polite" aria-atomic="true">
          <strong>Automatic refresh · Offline — checks paused</strong>
          <p>Some sources require Microsoft authorization. Sign in again to refresh those sources; this does not block other eligible sources.</p>
          <p>New automatic work is paused. Existing work may finish; use Sync to cancel it. Reconnect before starting a manual sync.</p>
        </div>
        <p>Users and inventory every 15 minutes; package details hourly. Checks run about every minute while this page is visible and online.</p>
      </div>
      <div class="automatic-refresh-actions">
        <a href="/api/auth/login">Sign in again</a>
        <button type="button" class="secondary">Resume automatic refresh</button>
        <button type="button" class="secondary">View sync status</button>
        <button type="button" class="secondary">Review permissions</button>
      </div>
    </section>
    <div class="background-refresh-indicator" role="status" aria-label="Background refresh" aria-live="polite">
      <svg width="16" height="16" aria-hidden="true"><path d="M2 8h12"></path></svg>
    </div>
  </main>`);
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 360, 640, 760, 761, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      const status = page.getByRole("region", { name: "Automatic refresh" });
      expect(await status.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        `Automatic refresh must fit at ${width}px with ${fontSize}px text`).toBe(true);
      for (const name of ["Resume automatic refresh", "View sync status", "Review permissions"]) {
        const control = page.getByRole("button", { name, exact: true });
        await expect(control).toBeEnabled();
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
      }
    }
  }
  const signIn = page.getByRole("link", { name: "Sign in again" });
  await signIn.focus();
  for (const control of [signIn,
    page.getByRole("button", { name: "Resume automatic refresh" }),
    page.getByRole("button", { name: "View sync status" }),
    page.getByRole("button", { name: "Review permissions" }),
  ]) {
    await expect(control).toBeFocused();
    expect(await control.evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    })).toBe(true);
    await page.keyboard.press("Tab");
  }
  const indicator = page.getByRole("status", { name: "Background refresh" });
  await expect(indicator).toHaveCSS("pointer-events", "none");
  await expect(indicator).toHaveCSS("width", "32px");
  await expect(indicator).toHaveCSS("height", "32px");
  await expect(indicator.locator("svg")).toHaveCSS("animation-name", "background-refresh-spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(indicator.locator("svg")).toHaveCSS("animation-name", "none");
});

test("inventory controls and recovery messages fit with bulk selection on narrow screens", async ({ page }) => {
  const reference = "saved_inventory_reference_".repeat(10);
  await renderStyles(page, `<main class="app-shell"><section class="agent-workspace">
    <div class="agent-table-stack" aria-busy="true"><div class="agent-grid">
      <div class="agent-grid-toolbar"><div class="agent-grid-tools">
        <section class="catalog-controls" aria-label="Filters"><div class="agent-query-bar">
          <label class="agent-search-field"><span class="sr-only">Search</span>
            <input type="search" placeholder="Search agents by name, publisher or ID"></label>
          <div class="inventory-facet inventory-facet-compact agent-view-control">
            <select aria-label="Show agents" aria-busy="true"><option>All agents</option></select>
            <p role="alert">${reference} <button type="button">Retry options</button></p>
          </div>
          <div class="agent-query-summary"><span class="agent-match-count" role="status">
            <strong>Updating...</strong><span>matching agents</span></span>
            <button class="clear-filters-button">Clear filters</button></div>
          <div class="agent-filter-picker"><button class="secondary agent-filter-trigger">
            <svg width="16" height="16" aria-hidden="true"></svg>Filters
            <span class="filter-count" aria-hidden="true">3</span></button></div>
        </div></section>
        <button class="secondary agent-match-select" disabled>Select all 50,000</button>
        <div class="agent-column-picker"><button class="secondary"><svg width="16" height="16" aria-hidden="true"></svg>Columns</button></div>
      </div></div>
      <div class="screen-state" role="status">Loading Copilot agents...</div>
    </div></div>
    <p class="error-banner" role="alert">${reference}<button class="secondary">Reload saved agent inventory</button></p>
  </section></main>`);
  for (const width of [360, 640, 760, 761, 840, 1024, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const selector of [".agent-grid-toolbar", ".agent-workspace"]) {
      expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        `${selector} must fit at ${width}px`).toBe(true);
    }
    for (const name of ["Clear filters", "Filters", "Columns", "Retry options", "Reload saved agent inventory"]) {
      const control = page.getByRole("button", { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport({ ratio: 1 });
      await control.click({ trial: true });
    }
    const search = page.getByRole("searchbox", { name: "Search", exact: true });
    const bounds = await search.boundingBox();
    expect(bounds?.width, `Search must retain usable space at ${width}px`).toBeGreaterThan(80);
    await search.focus();
    await expect(page.locator(".agent-search-field")).toHaveCSS("outline-style", "solid");
    await expect(page.locator(".agent-search-field")).toHaveCSS("outline-width", "2px");
  }
});

test("unavailable inventory selects look unavailable without disabling busy usable controls", async ({ page }) => {
  await renderStyles(page, `<section class="agent-workspace">
    <label class="agent-view-control">Show agents<select disabled><option>All agents</option></select></label>
    <div class="agent-filter-fields"><label>Built with<select disabled><option>All platforms</option></select></label></div>
    <div class="inventory-facet"><label>Environment<select aria-busy="true"><option>All environments</option></select></label></div>
  </section>`);
  for (const name of ["Show agents", "Built with"]) {
    const control = page.getByRole("combobox", { name });
    await expect(control).toBeDisabled();
    await expect(control).toHaveCSS("cursor", "not-allowed");
  }
  const busy = page.getByRole("combobox", { name: "Environment" });
  await expect(busy).toBeEnabled();
  await expect(busy).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab");
  await expect(busy).toBeFocused();
});

test("agent investigation controls show their busy state without losing keyboard focus", async ({ page }) => {
  await renderStyles(page, `<section class="agent-investigations">
    <form class="agent-insight-toolbar">
      <button type="button" class="secondary" aria-disabled="true">Search saved audit</button>
    </form>
    <div class="agent-insight-pagination">
      <button type="button" class="secondary" aria-disabled="true">Previous audit records</button>
      <button type="button" class="secondary" aria-disabled="true">Next audit records</button>
    </div>
  </section>`);
  for (const name of ["Search saved audit", "Previous audit records", "Next audit records"]) {
    await page.keyboard.press("Tab");
    const button = page.getByRole("button", { name });
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("opacity", "0.58");
    await expect(button).toHaveCSS("cursor", "not-allowed");
    expect(await button.evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    })).toBe(true);
  }
});

test("agent investigations keep source selection, recovery and record details usable on narrow screens", async ({ page }) => {
  const reference = "long-saved-audit-reference-".repeat(8);
  await renderStyles(page, `<dialog open class="inventory-detail-modal unified-agent-detail-modal">
    <section class="inventory-detail-section">
      <section class="agent-investigations">
        <header class="agent-insight-toolbar agent-log-toolbar">
          <h3>Agent logs</h3><button class="secondary">Setup &amp; permissions</button>
          <button class="secondary icon-button control-icon-button" aria-label="Refresh investigation access">R</button>
        </header>
        <div class="agent-log-sources" role="group" aria-label="Investigation source">
          <button class="agent-log-source" aria-pressed="true"><strong>Defender &amp; Agent 365</strong><span>Agent runs, tool calls and inventory</span></button>
          <button class="agent-log-source" aria-pressed="false"><strong>Purview audit</strong><span>Copilot Studio administrative changes</span></button>
        </div>
        <section class="agent-investigation-records">
          <form class="agent-insight-toolbar">
            <label>Search saved audit metadata<input type="search"></label>
            <label>Exact audit operation<select><option>All supported operations</option></select></label>
            <button class="secondary" aria-disabled="true">Search saved audit</button>
          </form>
          <p class="error-banner" role="alert">${reference}</p>
          <div class="agent-insight-table-shell" role="region" aria-label="Agent Purview records" tabindex="0">
            <table class="agent-insight-table agent-audit-table">
              <thead><tr><th>Time</th><th>Operation</th><th>Actor</th><th>Result</th><th>Details</th></tr></thead>
              <tbody><tr><td data-label="Time">10/7/2026, 2:30 PM</td>
                <th scope="row" data-label="Operation">BotCreate</th><td data-label="Actor">actor@example.invalid</td>
                <td data-label="Result">Not supplied</td><td data-label="Details">
                  <dl class="agent-audit-event-details"><div><dt>Correlation</dt><dd>${reference}</dd></div></dl>
                </td></tr></tbody>
            </table>
          </div>
          <div class="agent-insight-pagination"><button class="secondary">Previous audit records</button>
            <button class="secondary" aria-disabled="true">Next audit records</button></div>
        </section>
      </section>
      <div hidden><section class="agent-management-sections"><button>Hidden management action</button></section></div>
    </section>
  </dialog>`);
  for (const width of [360, 640, 800, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    const investigations = page.locator(".agent-investigations");
    expect(await investigations.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
      `Investigation controls and messages must fit at ${width}px`).toBe(true);
    const previous = page.getByRole("button", { name: "Previous audit records" });
    await previous.scrollIntoViewIfNeeded();
    await expect(previous).toBeInViewport({ ratio: 1 });
    await previous.click({ trial: true });
    await expect(page.getByRole("button", { name: "Hidden management action" })).toHaveCount(0);
  }
  const selected = page.getByRole("button", { name: "Defender & Agent 365 Agent runs, tool calls and inventory" });
  await selected.hover();
  await expect(selected).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(selected).toHaveCSS("background-color", "rgb(37, 79, 72)");
});

test("user relationship and paging controls show unavailability without hiding retained focus", async ({ page }) => {
  await renderStyles(page, `<dialog open class="inventory-detail-modal copilot-user-dialog user-detail-modal">
    <section class="user-detail-panel" role="tabpanel" aria-label="Usage &amp; agents">
      <section class="reported-user-agents" aria-busy="true">
        <div class="copilot-users-toolbar"><label>Search this user's agents<input type="search"></label></div>
        <div class="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabindex="0">
          <table class="copilot-users-table reported-agent-table"><thead><tr><th scope="col">
            <button class="table-sort-heading">Agent</button></th></tr></thead>
            <tbody><tr><td><button class="reported-agent-button" aria-disabled="true">Saved agent</button></td></tr></tbody>
          </table>
        </div>
        <nav class="copilot-users-pagination" aria-label="agents pages" aria-busy="true">
          <span role="status">Unknown matching agents</span>
          <button class="secondary" aria-disabled="true">Previous agents</button>
          <button class="secondary" aria-disabled="true">Next agents</button>
        </nav>
      </section>
    </section>
    <section hidden class="user-detail-panel" role="tabpanel" aria-label="Licenses"><button>Next plans</button></section>
  </dialog>`);
  await expect(page.getByRole("button", { name: "Next plans" })).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Agent", exact: true })).toHaveCSS("opacity", "1");
  for (const name of ["Saved agent", "Previous agents", "Next agents"]) {
    const button = page.getByRole("button", { name, exact: true });
    await button.focus();
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("opacity", "0.58");
    await expect(button).toHaveCSS("cursor", "not-allowed");
    expect(await button.evaluate(element => {
      const style = getComputedStyle(element);
      return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
    })).toBe(true);
  }
});

test("Users recovery messages and retained filters fit narrow screens", async ({ page }) => {
  await renderStyles(page, `<main class="app-shell"><section class="copilot-users">
    <header class="copilot-users-header"><div><h2>Users &amp; adoption</h2></div>
      <div class="copilot-users-header-actions">
        <label class="copilot-users-cohort">User cohort<select><option>Active users without paid Copilot</option></select></label>
      </div>
    </header>
    <div class="error-banner" role="alert">${"saved_selection_reference_".repeat(10)}
      <button>Restart selection</button></div>
    <div class="agent-table-stack user-directory-table" aria-busy="true">
      <section class="catalog-controls user-activity-controls agent-grid-toolbar" aria-label="User filters">
        <div class="agent-query-bar">
          <label class="agent-search-field">Search<input type="search" value="retained filter"></label>
          <div class="agent-query-summary"><span role="status">Updating...</span><button>Clear filters</button></div>
          <div class="agent-filter-picker"><button class="secondary">Filter users</button></div>
        </div>
      </section>
      <div class="copilot-users-table-shell" role="region" aria-label="M365 Copilot license status" tabindex="0">
        <table class="copilot-users-table reported-users-table"><thead><tr><th><button class="table-sort-heading">User</button></th></tr></thead><tbody></tbody></table>
      </div>
    </div>
  </section></main>`);
  for (const width of [320, 360, 640, 761, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.locator(".copilot-users").evaluate(element => element.scrollWidth <= element.clientWidth + 1),
      `Users recovery and controls must fit at ${width}px`).toBe(true);
    for (const name of ["Restart selection", "Filter users"]) {
      const button = page.getByRole("button", { name });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
      await button.click({ trial: true });
    }
    await expect(page.getByRole("searchbox")).toHaveValue("retained filter");
    await expect(page.getByRole("button", { name: "User", exact: true })).toBeVisible();
  }
});

for (const state of ["idle", "preparing", "ready", "error"] as const) {
  test(`reported-user filters and ${state} export controls fit without hiding recovery`, async ({ page }) => {
    const reference = "saved_user_export_reference_".repeat(12);
    const exportContent = state === "idle" ? '<button class="secondary">Export users CSV</button>'
      : state === "preparing" ? '<button class="secondary" disabled>Preparing export...</button><button class="secondary">Cancel export</button>'
        : state === "ready" ? `<button class="secondary">Export users CSV</button><button class="secondary">Cancel export</button>
          <p role="status">ready: 100,000 rows, 20,000,000 bytes. <a href="#download">Download CSV</a> Expires 11:59:59 PM.</p>`
          : `<button class="secondary">Retry export status</button><button class="secondary">Cancel export</button><p role="alert">${reference}</p>`;
    await renderStyles(page, `<main class="app-shell"><section class="copilot-users">
      <section class="reported-users" aria-label="Non-paid user activity">
        <p class="copilot-users-notice">Reports are out of date. Refresh reports in Sync.</p>
        <div class="agent-table-stack user-directory-table" aria-busy="true">
          <section class="catalog-controls user-activity-controls agent-grid-toolbar" aria-label="User filters">
            <div class="agent-query-bar">
              <label class="agent-search-field"><svg width="17" height="17" aria-hidden="true"></svg>
                <span class="sr-only">Search reported users or agents</span><input type="search" value="retained user search"></label>
              <div class="agent-query-summary"><span class="agent-match-count" role="status"><strong>Updating...</strong><span>matching users</span></span>
                <button class="clear-filters-button">Clear filters</button></div>
              <div class="agent-filter-picker"><button class="secondary agent-filter-trigger" aria-label="Filters, 2 active">
                <svg width="16" height="16" aria-hidden="true"></svg>Filters<span class="filter-count" aria-hidden="true">2</span></button></div>
              <div class="report-export">${exportContent}</div>
            </div>
            <p role="alert">Enter a whole-number threshold between 1 and 100,000,000.</p>
            <div class="agent-filter-chips"><button class="agent-filter-chip" aria-label="Remove company filter">
              <span>Company: <strong>${reference}</strong></span><svg width="13" height="13" aria-hidden="true"></svg></button></div>
          </section>
          <div class="table-shell copilot-users-table-shell" role="region" aria-label="Reported user activity" tabindex="0">
            <table class="agent-table copilot-users-table reported-users-table"><thead><tr>
              ${["User", "Agent responses", "Agents used", "Company", "Department", "Last activity"].map(label =>
                `<th scope="col"><button class="table-sort-heading">${label}<svg width="14" height="14" aria-hidden="true"></svg></button></th>`).join("")}
            </tr></thead><tbody><tr><th scope="row"><button class="agent-name-button user-name-button">${reference}</button><small>${reference}@example.invalid</small></th>
              <td>Unknown</td><td>2</td><td>${reference}</td><td>Not set</td><td>Not reported</td></tr></tbody></table>
          </div>
          <nav class="copilot-users-pagination" aria-label="users pages" aria-busy="true"><span role="status">Unknown matching users</span>
            <button class="secondary" aria-disabled="true">Previous users</button><button class="secondary" aria-disabled="true">Next users</button></nav>
        </div>
      </section>
    </section></main>`);
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      for (const width of [320, 360, 640, 760, 761, 900, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const selector of [".copilot-users", ".reported-users", ".user-activity-controls", ".agent-query-bar", ".report-export"]) {
          expect(await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1),
            `${selector} must fit ${state} export at ${width}px with ${fontSize}px text`).toBe(true);
        }
        const filter = page.getByRole("button", { name: "Filters, 2 active", exact: true });
        const exportBox = await page.locator(".report-export").boundingBox();
        const filterBox = await filter.boundingBox();
        expect(exportBox && filterBox && (filterBox.x + filterBox.width <= exportBox.x
          || exportBox.x + exportBox.width <= filterBox.x || filterBox.y + filterBox.height <= exportBox.y
          || exportBox.y + exportBox.height <= filterBox.y), `Filter and ${state} export controls must not overlap at ${width}px`).toBe(true);
        for (const button of [filter, page.getByRole("button", { name: "Clear filters" }),
          page.getByRole("button", { name: state === "idle" ? "Export users CSV" : "Cancel export" })]) {
          await button.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
          await expect(button).toBeInViewport({ ratio: 1 });
          await button.click({ trial: true });
          await button.focus();
          expect(await button.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
        }
      }
    }
    await expect(page.getByRole("searchbox")).toHaveValue("retained user search");
    await expect(page.getByRole("button", { name: "Filters, 2 active", exact: true })).toHaveCSS("opacity", "1");
    if (state === "preparing") {
      await expect(page.getByRole("button", { name: "Preparing export..." })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Preparing export..." })).toHaveCSS("opacity", "0.58");
    }
    if (state === "ready") await expect(page.getByRole("link", { name: "Download CSV" })).toBeVisible();
  });
}

test("user details keep tabs and recovery actions reachable in short viewports and enlarged text", async ({ page }) => {
  await renderStyles(page, `<dialog class="inventory-detail-modal copilot-user-dialog user-detail-modal">
    <header><div><p class="eyebrow">User details</p><h2>Enterprise adoption administrator</h2>
      <p>enterprise-adoption-administrator@example.invalid</p>
      <span class="copilot-user-badge unknown">Verify paid license inventory</span>
      <span class="copilot-user-badge unknown">Usage unknown</span>
    </div><button class="secondary icon-button" aria-label="Close user details">X</button></header>
    <div class="detail-tabs" role="tablist" aria-label="User details">
      <button role="tab" aria-selected="true">Overview</button><button role="tab">Usage &amp; agents</button>
      <button role="tab">Licenses</button><button role="tab">Responsibility</button><button role="tab">Purview audit</button>
    </div>
    <section class="user-detail-panel" role="tabpanel" aria-label="Overview">
      <div class="user-detail-card" role="alert"><p>The saved-data read was cancelled.</p><button>Retry user details</button></div>
      <section class="user-detail-card"><h3>Organization</h3><p>Organization details are unavailable for this report identity.</p></section>
    </section>
    <section hidden class="user-detail-panel"><button>Hidden license action</button></section>
  </dialog>`);
  await page.locator("dialog").evaluate((element: HTMLDialogElement) => element.showModal());
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const [width, height] of [[360, 640], [640, 360], [1024, 360]]) {
      await page.setViewportSize({ width, height });
      const panel = page.getByRole("tabpanel", { name: "Overview" });
      expect(await panel.evaluate(element => element.clientHeight),
        `The details panel needs usable height at ${width}x${height} with ${fontSize}px text`).toBeGreaterThan(0);
      for (const name of ["Close user details", "Retry user details"]) {
        const button = page.getByRole("button", { name });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport({ ratio: 1 });
        await button.click({ trial: true });
      }
      for (const tab of await page.getByRole("tab").all()) {
        await tab.scrollIntoViewIfNeeded();
        expect(await tab.evaluate(element => element.scrollHeight <= element.clientHeight + 1),
          "Tab labels must not overflow their fixed height").toBe(true);
        await tab.click({ trial: true });
      }
      await expect(page.getByRole("button", { name: "Hidden license action" })).toHaveCount(0);
    }
  }
});

for (const classes of [
  "inventory-detail-modal unified-agent-detail-modal",
  "inventory-detail-modal copilot-user-dialog user-detail-modal",
]) {
  test(`${classes} obeys the native dialog open state`, async ({ page }) => {
    await renderStyles(page, `<dialog class="${classes}"><button>Close details</button></dialog>`);
    const dialog = page.locator("dialog");
    await expect(dialog).toBeHidden();
    await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("display", "flex");
    await dialog.evaluate((element: HTMLDialogElement) => element.close());
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Close details" })).toHaveCount(0);
  });
}

test("unified agent details keep long evidence, tabs and recovery reachable in short viewports", async ({ page }) => {
  const reference = "saved_agent_reference_".repeat(12);
  await renderStyles(page, `<dialog class="inventory-detail-modal unified-agent-detail-modal" aria-label="Agent management">
    <header><div><p class="eyebrow">Agent management</p><h2>${reference}</h2></div>
      <button class="icon-button" aria-label="Close unified agent details">X</button></header>
    <div class="detail-tabs" role="tablist" aria-label="Agent details">
      ${["Overview", "Usage", "Users", "Manage", "Activity"].map((label, index) =>
        `<button role="tab" aria-selected="${index === 0}">${label}</button>`).join("")}
    </div>
    <div class="notice" role="status">Invalid saved matching metadata. Refresh matching details in Sync.</div>
    <p class="error-banner unified-agent-detail-error" role="alert">Saved details failed: ${reference}</p>
    <div class="error-banner unified-agent-detail-error" role="alert"><p>Saved inventory failed: ${reference}</p>
      <button class="secondary">Retry saved inventory</button></div>
    <section class="inventory-detail-section" role="tabpanel" aria-label="Overview" tabindex="0">
      <div class="agent-version-selector"><label>Published version details<select disabled><option>${reference}</option></select></label>
        <p role="status">Loading published versions...</p>
        <div class="agent-insight-pagination"><button class="secondary" aria-disabled="true">Previous versions</button>
          <button class="secondary" aria-disabled="true">Next versions</button></div></div>
      <section class="agent-overview-section inventory-source-members"><h3>Source members</h3>
        <p role="alert">Source members unavailable: ${reference} <button>Retry source members</button></p>
        <ul><li><button>${reference}</button><span>packages · ${reference}</span></li></ul>
        <div class="table-actions"><button aria-disabled="true">First members</button><button aria-disabled="true">Next members</button></div>
        <section class="inventory-source-details"><h4>${reference}</h4><label>Detail section<select disabled><option>Loading</option></select></label>
          <pre>{"reference":"${reference}"}</pre></section></section>
      <section class="agent-access-management"><div class="agent-access-heading">
        <div><h4>${reference}</h4><p>Package ID: <code class="agent-control-target">${reference}</code></p></div>
        <div class="agent-block-control"><strong>Block status unknown</strong><button disabled>Block</button></div>
      </div></section>
      <article class="agent-management-card"><div class="management-card-heading"><h4>Quarantine and restore</h4></div>
        <section class="inventory-detail-section quarantine-control"><div class="quarantine-control-heading">
          <div><h3>Copilot Studio quarantine</h3></div><span class="capability-gate capability-gate-compact">
            <button class="secondary"><svg width="18" height="18" aria-hidden="true"></svg>Check direct status</button></span></div>
          <p class="error-banner" role="alert">${reference}</p><div class="quarantine-actions">
            <span class="capability-gate capability-gate-compact"><button class="danger" disabled>Quarantine</button></span>
            <span class="capability-gate capability-gate-compact"><button class="secondary" disabled>Restore from quarantine</button></span>
          </div></section></article>
      <section class="agent-overview-section"><h3>Configured connectors and operations</h3>
        <p class="notice">Configuration details have expired. Refresh them in Sync.</p>
        <ul class="agent-service-list"><li><strong>${reference}</strong><ul><li><strong>${reference}</strong>
          <dl class="agent-property-grid"><div><dt>Used as</dt><dd>${reference}</dd></div>
            <div><dt>Enabled</dt><dd>No</dd></div><div class="agent-property-wide"><dt>Operation configured by (ID)</dt><dd>${reference}</dd></div></dl>
        </li></ul></li></ul><div class="agent-insight-pagination">
          <button class="secondary" aria-disabled="true">Previous connectors</button><button class="secondary">Next connectors</button></div>
      </section>
      <div hidden><button>Hidden management action</button></div>
    </section></dialog>`);
  const dialog = page.getByRole("dialog", { includeHidden: true });
  await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const [width, height] of [[320, 640], [600, 320], [760, 360], [1024, 640], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const element of await dialog.locator("header, .detail-tabs, .unified-agent-detail-error, .inventory-detail-section, .inventory-source-members, .agent-access-heading, .agent-management-card, .agent-service-list").all()) {
        expect(await element.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          `Agent detail content must fit at ${width}x${height} with ${fontSize}px text`).toBe(true);
      }
      expect(await page.getByRole("tabpanel").evaluate(element => element.clientHeight),
        "A long header or error must not collapse the detail panel").toBeGreaterThanOrEqual(100);
      for (const control of [page.getByRole("button", { name: "Close unified agent details" }),
        page.getByRole("button", { name: "Retry saved inventory" }), page.getByRole("button", { name: "Retry source members" }),
        page.getByRole("button", { name: "Check direct status" }), page.getByRole("button", { name: "Next connectors" }),
        ...await page.getByRole("tab").all()]) {
        await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
        await control.focus();
        expect(await control.evaluate(element => element.matches(":focus-visible")
          && getComputedStyle(element).outlineStyle !== "none")).toBe(true);
        expect(await control.evaluate(element => element.scrollHeight <= element.clientHeight + 1),
          "Control labels must fit their height").toBe(true);
      }
      await expect(page.getByRole("button", { name: "Hidden management action" })).toHaveCount(0);
    }
  }
});

test("unified detail selectors and retained member paging truthfully show unavailability", async ({ page }) => {
  await renderStyles(page, `<div class="agent-version-selector"><label>Published version details<select disabled><option>Choose a published version</option></select></label></div>
    <section class="inventory-source-members" aria-busy="true"><p role="status">Loading source members...</p>
      <div class="table-actions"><button aria-disabled="true">First members</button><button aria-disabled="true">Next members</button></div>
      <section class="inventory-source-details"><label>Detail section<select disabled><option>Loading</option></select></label>
        <div class="table-actions"><button aria-disabled="true">First detail rows</button><button aria-disabled="true">Next detail rows</button></div>
      </section></section>
    <section aria-busy="true"><button class="agent-sort-heading">Sort by Agent</button><button class="secondary">Retry saved inventory</button></section>`);
  for (const name of ["Published version details", "Detail section"]) {
    const select = page.getByRole("combobox", { name });
    await expect(select).toBeDisabled();
    await expect(select).toHaveCSS("cursor", "not-allowed");
    await expect(select).toHaveCSS("opacity", "0.58");
  }
  for (const name of ["First members", "Next members", "First detail rows", "Next detail rows"]) {
    const button = page.getByRole("button", { name });
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    await expect(button).toHaveCSS("opacity", "0.58");
    await expect(button).toHaveCSS("cursor", "not-allowed");
    expect(await button.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
  }
  for (const name of ["Sort by Agent", "Retry saved inventory"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeEnabled();
    await expect(button).toHaveCSS("opacity", "1");
    await button.click({ trial: true });
    await button.focus();
    expect(await button.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
  }
});

test("unified agent table wraps long identifiers without expanding its horizontal scroll surface", async ({ page }) => {
  const reference = "unbroken_agent_name_".repeat(30);
  await renderStyles(page, `<main class="app-shell"><section class="agent-workspace"><div class="agent-table-stack" aria-busy="true">
    <div class="agent-grid"><div class="table-shell"><table class="agent-table unified-agent-table" style="min-width: 720px">
      <thead><tr><th scope="col" class="select-cell">Select</th><th scope="col" aria-sort="ascending"><button class="agent-sort-heading">Agent</button></th>
        <th scope="col"><button class="agent-sort-heading">Publisher</button></th><th scope="col">Actions</th></tr></thead>
      <tbody><tr><td class="select-cell"><input type="checkbox" aria-label="Select agent" disabled></td>
        <td><button class="agent-name-button">${reference}</button></td><td>${reference}</td>
        <td><div class="row-actions"><button class="icon-button" aria-label="View details">i</button>
          <button class="icon-button" aria-label="Block agent" disabled>B</button></div></td></tr></tbody>
    </table></div></div>
    <nav class="agent-inventory-pagination"><span role="status">1 shown · 1 matching agent</span>
      <div class="agent-inventory-page-actions"><button class="secondary" disabled>Previous</button><button class="secondary" disabled>Next</button></div></nav>
  </div></section></main>`);
  for (const fontSize of [16, 32]) {
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
    for (const width of [320, 600, 760, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.locator(".table-shell").evaluate(element => element.scrollWidth <= Math.max(720, element.clientWidth) + 1),
        `Long table values must wrap within the configured table width at ${width}px with ${fontSize}px text`).toBe(true);
      expect(await page.locator(".agent-workspace").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      for (const control of [page.getByRole("button", { name: "Agent", exact: true }), page.getByRole("button", { name: "View details" })]) {
        await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest" }));
        await expect(control).toBeInViewport({ ratio: 1 });
        await control.click({ trial: true });
        await control.focus();
        expect(await control.evaluate(element => getComputedStyle(element).outlineStyle !== "none")).toBe(true);
      }
    }
  }
  await expect(page.getByRole("button", { name: "Block agent" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Block agent" })).toHaveCSS("opacity", "0.58");
});

for (const inline of [false, true]) {
  test(`selected principals remain readable and removable in ${inline ? "inline" : "standalone"} access management`, async ({ page }) => {
    const picker = `<div class="principal-picker">
      <div class="selected-principals" aria-label="Selected principals">
        <div class="selected-principals-header" aria-hidden="true">
          <span>User or group</span><span>Identity</span><span>Type</span><span>Action</span>
        </div>
        <div class="principal-row">
          <span class="principal-avatar" aria-hidden="true">SD</span>
          <strong>Service desk administrators</strong>
          <small>service-desk-administrators@example.invalid</small>
          <span class="principal-type">Microsoft 365 group</span>
          <button class="icon-button" aria-label="Remove Service desk administrators">X</button>
        </div>
      </div>
    </div>`;
    const editor = `<section class="${inline ? "access-assignment-editor" : "access-assignment-modal"}">
      ${inline ? "" : '<header class="access-modal-header"><h2>Manage agent access</h2></header>'}
      <div class="access-modal-body">
        <nav class="access-setting-nav"><button>Available to</button><button>Installed for</button></nav>
        <div class="access-form"><section class="access-assignment-workspace">${picker}</section></div>
      </div>
      <footer class="access-modal-actions"><button>Cancel</button><button>Apply</button></footer>
    </section>`;
    await renderStyles(page, inline
      ? `<dialog open class="inventory-detail-modal unified-agent-detail-modal">
          <section class="inventory-detail-section"><div class="agent-access-management">${editor}</div></section>
        </dialog>`
      : `<div class="modal-backdrop access-modal-backdrop">${editor}</div>`);
    for (const width of [360, 760, 761, 840, 900, 1024, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      const selected = page.getByLabel("Selected principals");
      const size = await selected.evaluate(element => ({
        client: element.clientWidth, scroll: element.scrollWidth,
      }));
      expect(size.scroll, `Selected principals must not clip content at ${width}px`)
        .toBeLessThanOrEqual(size.client + 1);
      const remove = page.getByRole("button", { name: "Remove Service desk administrators" });
      await remove.scrollIntoViewIfNeeded();
      await expect(remove).toBeInViewport({ ratio: 1 });
      await remove.click({ trial: true });
      expect(await selected.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll(".principal-row > *")].every(child => {
          const childBounds = child.getBoundingClientRect();
          return childBounds.left >= bounds.left && childBounds.right <= bounds.right;
        });
      }), `Principal identity and removal action must fit at ${width}px`).toBe(true);
    }
  });
}
