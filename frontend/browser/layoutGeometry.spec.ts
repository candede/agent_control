import { expect, test, type Page } from "@playwright/test";
import { collectLayoutFailures } from "./layoutGeometry";

async function renderLayout(page: Page, content: string) {
  await page.route("**/*", route => route.abort());
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; font: 16px Arial; }
      .app-shell { width: 100%; padding: 16px; }
      .top-bar { height: 24px; }
      .fields { display: grid; gap: 8px; }
      label { display: grid; min-width: 0; }
      input, select { width: 100%; min-width: 0; font: inherit; padding: 0; border: 0; }
    </style>
    <main class="app-shell"><header class="top-bar">Layout fixture</header>${content}</main>
  `);
}

test("field checks inspect every visible match without including hidden copies", async ({ page }) => {
  await renderLayout(page, `
    <div class="fields"><label>First<input></label></div>
    <div class="fields"><label>Second<input style="width:50%"></label></div>
    <div class="fields" style="display:none"><label>Hidden<input style="width:50%"></label></div>
  `);
  expect(await page.evaluate(collectLayoutFailures, { fields: [".fields"] }))
    .toEqual(["Second does not fill its field"]);
  await page.getByLabel("Second", { exact: true }).evaluate(element => { element.style.width = "100%"; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [".fields"] })).toEqual([]);
});

test("a hidden first field group does not mask a visible later match", async ({ page }) => {
  await renderLayout(page, `
    <div class="fields" style="display:none"><label>Hidden<input></label></div>
    <div class="fields"><label>Visible<input></label></div>
  `);
  expect(await page.evaluate(collectLayoutFailures, { fields: [".fields"] })).toEqual([]);
});

test("missing or entirely hidden required field groups still fail", async ({ page }) => {
  await renderLayout(page, `<div class="fields" style="display:none"><label>Hidden<input></label></div>`);
  expect(await page.evaluate(collectLayoutFailures, { fields: [".fields", ".absent"] })).toEqual([
    "Missing visible field group: .fields", "Missing visible field group: .absent",
  ]);
});

test("collapsed disclosure contents are checked only after opening", async ({ page }) => {
  await renderLayout(page, `
    <details><summary>Evidence</summary>
      <div class="summary-grid" style="display:grid;grid-template-columns:80px 120px">
        <div>First</div><div>Second</div>
      </div>
    </details>
  `);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.locator("summary").click();
  expect(await page.evaluate(collectLayoutFailures, { fields: [] }))
    .toContain(".summary-grid has unequal field/card widths: 80.0, 120.0");
});

test("modal surfaces may scroll vertically but cannot escape horizontally or rely on unclipped overflow", async ({ page }) => {
  await renderLayout(page, `
    <dialog open style="position:relative;width:100%;height:100px;margin:0;overflow:hidden">
      <div class="modal-scroll" style="height:50px;overflow-y:auto">
        <section class="defender-hunting" aria-label="Hunting" style="height:200px">Saved investigation</section>
      </div>
    </dialog>
  `);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.locator(".modal-scroll").evaluate(element => { element.scrollTop = 100; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.locator(".modal-scroll").evaluate(element => { element.style.overflowY = "visible"; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toContain("Hunting is outside dialog.");
  await page.locator(".modal-scroll").evaluate(element => { element.style.overflowY = "auto"; });
  await page.locator(".defender-hunting").evaluate(element => { element.style.width = "calc(100% + 200px)"; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toContain("Hunting is outside dialog.");
});

test("select minimum width uses rendered word widths instead of character count", async ({ page }) => {
  await renderLayout(page, `
    <div class="fields" style="width:70px">
      <label><select aria-label="Saved snapshot"><option>iiiiiiii WWWW</option></select></label>
    </div>
  `);
  const select = page.getByRole("combobox", { name: "Saved snapshot" });
  const metrics = await select.evaluate(element => {
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = "16px Arial";
    return { narrow: context.measureText("iiiiiiii").width, wide: context.measureText("WWWW").width,
      client: element.clientWidth, scroll: element.scrollWidth };
  });
  expect(metrics.wide).toBeGreaterThan(metrics.narrow);
  expect(metrics.scroll).toBe(metrics.client);
  expect(await page.evaluate(collectLayoutFailures, { fields: [".fields"] }))
    .toEqual([expect.stringMatching(/^Saved snapshot is too narrow for its displayed value/)]);
  await page.locator(".fields").evaluate(element => { element.style.width = "100px"; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [".fields"] })).toEqual([]);
});

test("permission issue actions cannot overlap or escape their issue", async ({ page }) => {
  await renderLayout(page, `
    <ul class="permission-issue-list" style="padding:0;list-style:none">
      <li style="display:grid;gap:8px"><strong>Agent inventory</strong>
        <div class="permission-actions" style="display:flex;gap:12px;position:relative">
          <a aria-label="Admin setup" style="display:block;width:120px">Admin setup</a>
          <button aria-label="Details: Agent inventory" style="position:absolute;left:50px">Details</button>
        </div>
      </li>
    </ul>
  `);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] }))
    .toContain(".permission-actions: Admin setup intersects Details: Agent inventory");
  await page.getByRole("button", { name: "Details: Agent inventory" }).evaluate(element => { element.style.position = "static"; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.locator(".permission-actions").evaluate(element => { element.style.width = "calc(100% + 20px)"; });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] }))
    .toContain("div.permission-actions is outside li.");
});

test("permission references allow unequal columns but detect clipped guidance only when expanded", async ({ page }) => {
  await renderLayout(page, `
    <details><summary>Required API permissions</summary>
      <dl class="permission-feature-list" style="margin:0">
        <div style="display:grid;grid-template-columns:80px 120px;gap:8px">
          <dt style="margin:0">API scope</dt>
          <dd style="margin:0">Read agent inventory</dd>
        </div>
      </dl>
      <details class="permission-log-setup">
        <summary>Log collection setup</summary>
        <pre aria-label="Audit setup command" style="width:100px;overflow:hidden">Get-AdminAuditLogConfig</pre>
      </details>
    </details>
  `);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.getByText("Required API permissions", { exact: true }).click();
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.getByText("Log collection setup", { exact: true }).click();
  expect(await page.evaluate(collectLayoutFailures, { fields: [] }))
    .toEqual(["Audit setup command clips its permission guidance"]);
  await page.getByLabel("Audit setup command").evaluate(element => {
    element.style.whiteSpace = "pre-wrap";
    element.style.overflowWrap = "anywhere";
  });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
});

for (const wrapper of ["table-shell", "copilot-users-table-shell", "jobs-table-scroll"]) {
  test(`${wrapper} requires local scrolling for wide evidence`, async ({ page }) => {
    await renderLayout(page, `
      <div class="${wrapper}" style="overflow:hidden">
        <table style="width:2000px"><tbody><tr><td>Saved evidence</td></tr></tbody></table>
      </div>
    `);
    expect(await page.evaluate(collectLayoutFailures, { fields: [] }))
      .toEqual([`div.${wrapper} has wide data without a local horizontal scroller`]);
    await page.locator(`.${wrapper}`).evaluate(element => { element.style.overflowX = "auto"; });
    expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
    await page.locator(`.${wrapper}`).evaluate(element => { element.style.width = "calc(100% + 20px)"; });
    expect(await page.evaluate(collectLayoutFailures, { fields: [] }))
      .toContain(`div.${wrapper} is outside main.app-shell`);
  });
}
