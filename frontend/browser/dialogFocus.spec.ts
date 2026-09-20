import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

const source = readFileSync(new URL("../src/dialogFocus.ts", import.meta.url), "utf8");
const script = ts.transpileModule(`${source}
const dialog = document.querySelector("#focus-dialog");
const eventTarget = dialog instanceof HTMLDialogElement ? dialog : document;
eventTarget.addEventListener("keydown", event => trapDialogFocus(event, dialog));
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

async function renderDialog(page: Page, content: string, container: "section" | "dialog" = "section") {
  await page.route("**/*", route => route.abort());
  await page.setContent(`
    <button>Outside before</button>
    <${container} id="focus-dialog" role="dialog" tabindex="-1">${content}</${container}>
    <button>Outside after</button>
  `);
  await page.addScriptTag({ type: "module", content: script });
  if (container === "dialog") {
    await page.locator("dialog").evaluate((dialog: HTMLDialogElement) => dialog.showModal());
  }
}

test("Tab ignores unavailable controls while retaining the enabled first legend", async ({ page }) => {
  await renderDialog(page, `
    <button tabindex="-1">Programmatic first</button>
    <button style="display:none">Hidden first</button>
    <button>First</button>
    <fieldset disabled>
      <legend><button>Legend action</button></legend>
      <button>Disabled action</button>
      <legend><button>Second legend action</button></legend>
    </fieldset>
    <div style="display:none"><button>Hidden by ancestor</button></div>
    <button style="visibility:hidden">Invisible action</button>
    <input type="hidden" tabindex="0" style="display:block">
    <button tabindex="-2">Programmatic last</button>
  `);
  const first = page.getByRole("button", { name: "First", exact: true });
  const legend = page.getByRole("button", { name: "Legend action", exact: true });
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(legend).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(legend).toBeFocused();
});

test("Tab follows positive tab indices without entering background content", async ({ page }) => {
  await renderDialog(page, `
    <button>Default first</button>
    <button tabindex="2">Priority two</button>
    <button tabindex="1">Priority one</button>
    <button tabindex="2">Priority two peer</button>
    <button>Default last</button>
  `);
  const order = ["Priority one", "Priority two", "Priority two peer", "Default first", "Default last"];
  await page.getByRole("button", { name: order[0], exact: true }).focus();
  for (const name of [...order.slice(1), order[0]]) {
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
  }
  for (const name of [...order.slice(1).reverse(), order[0]]) {
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
  }
});

test("Tab recovers from programmatic focus and an empty tab sequence", async ({ page }) => {
  await renderDialog(page, `
    <button>Action</button>
    <p tabindex="-1">Status</p>
  `);
  await page.getByText("Status").focus();
  await page.keyboard.press("Tab");
  const action = page.getByRole("button", { name: "Action", exact: true });
  await expect(action).toBeFocused();
  await action.evaluate(element => { element.setAttribute("disabled", ""); });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("dialog")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("dialog")).toBeFocused();
});

test("Tab traps a native modal through its own keydown handler", async ({ page }) => {
  await renderDialog(page, `
    <h2 tabindex="-1">Dialog heading</h2>
    <button>First</button>
    <button>Last</button>
  `, "dialog");
  const dialog = page.getByRole("dialog");
  const first = page.getByRole("button", { name: "First", exact: true });
  const last = page.getByRole("button", { name: "Last", exact: true });
  await expect(page.locator("dialog:modal")).toBeVisible();
  await page.getByRole("heading").focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await first.evaluate(element => { element.setAttribute("disabled", ""); });
  await last.evaluate(element => { element.setAttribute("disabled", ""); });
  await page.getByRole("heading").focus();
  await page.keyboard.press("Tab");
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog).toBeFocused();
});

test("Tab retains native disclosure navigation and tracks open state", async ({ page }) => {
  await renderDialog(page, `
    <button>First</button>
    <details>
      <summary>More details</summary>
      <button>Details action</button>
    </details>
  `);
  const first = page.getByRole("button", { name: "First", exact: true });
  const summary = page.locator("summary");
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(summary).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(summary).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await summary.click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Details action" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
});

for (const checked of ["first", "last", "none"]) {
  test(`Tab treats a radio group as one stop when ${checked} is checked`, async ({ page }) => {
    await renderDialog(page, `
      <label><input type="radio" name="choice" ${checked === "first" ? "checked" : ""}>First choice</label>
      <label><input type="radio" name="choice" ${checked === "last" ? "checked" : ""}>Last choice</label>
    `);
    const radio = page.getByRole("radio", { name: checked === "last" ? "Last choice" : "First choice" });
    await radio.focus();
    await page.keyboard.press("Tab");
    await expect(radio).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(radio).toBeFocused();
  });
}

for (const unavailable of ["disabled", "hidden", 'tabindex="-1"']) {
  test(`Tab stays contained when a radio group's checked control is ${unavailable}`, async ({ page }) => {
    await renderDialog(page, `
      <button>First</button>
      <label><input type="radio" name="choice">Available choice</label>
      <label><input type="radio" name="choice" checked ${unavailable}>Unavailable choice</label>
    `);
    const first = page.getByRole("button", { name: "First", exact: true });
    const radio = page.getByRole("radio", { name: "Available choice", exact: true });
    await first.focus();
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      await expect(radio).toBeFocused();
      await page.keyboard.press(key);
      await expect(first).toBeFocused();
    }
  });
}
