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

for (const wrapper of ["table-shell", "copilot-users-table-shell", "permission-table-scroll", "jobs-table-scroll"]) {
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
