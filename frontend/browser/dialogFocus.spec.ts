import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import ts from "typescript";

const source = readFileSync(new URL("../src/dialogFocus.ts", import.meta.url), "utf8");
const script = ts.transpileModule(`${source}
const dialog = document.querySelector("#focus-dialog");
const eventTarget = dialog instanceof HTMLDialogElement ? dialog : document;
eventTarget.addEventListener("keydown", event => trapDialogFocus(event, dialog));
for (const element of document.querySelectorAll("dialog")) {
  observeDialogFocus(element);
  if (element !== dialog) element.addEventListener("keydown", event => trapDialogFocus(event, element));
}
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
    await page.locator("#focus-dialog").evaluate((dialog: HTMLDialogElement) => dialog.showModal());
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

test("a background document trap does not cancel foreground native dialog navigation", async ({ page }) => {
  await renderDialog(page, "<button>Background action</button>");
  await page.evaluate(() => {
    const foreground = document.createElement("dialog");
    foreground.innerHTML = "<button>Foreground first</button><button>Foreground last</button>";
    document.body.append(foreground);
    foreground.showModal();
  });
  const first = page.getByRole("button", { name: "Foreground first", exact: true });
  const last = page.getByRole("button", { name: "Foreground last", exact: true });
  await first.focus();
  await page.keyboard.press("Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(first).toBeFocused();
  await first.evaluate(element => { element.remove(); });
  await page.keyboard.press("Tab");
  await expect(last).toBeFocused();
  await page.locator("dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
  const background = page.getByRole("button", { name: "Background action", exact: true });
  await background.focus();
  await page.keyboard.press("Tab");
  await expect(background).toBeFocused();
});

test("a retired document trap leaves its replacement owner's controls usable", async ({ page }) => {
  await renderDialog(page, "<button>Previous account action</button>");
  await page.locator("#focus-dialog").evaluate(element => { element.remove(); });
  const before = page.getByRole("button", { name: "Outside before", exact: true });
  const after = page.getByRole("button", { name: "Outside after", exact: true });
  await before.focus();
  await page.keyboard.press("Tab");
  await expect(after).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(before).toBeFocused();
});

for (const state of ["disabled", "removed", "hidden"] as const) {
  test(`a native dialog recovers when its focused control is ${state}`, async ({ page }) => {
    await renderDialog(page, "<button>Save</button>", "dialog");
    const dialog = page.getByRole("dialog");
    await dialog.evaluate(element => { element.removeAttribute("tabindex"); });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.focus();
    await save.evaluate((button: HTMLButtonElement, state) => {
      if (state === "disabled") button.disabled = true;
      else if (state === "removed") button.remove();
      else button.hidden = true;
    }, state);
    await page.keyboard.press("Tab");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog).toBeFocused();
    await dialog.evaluate(element => { element.innerHTML = "<p>Save failed</p><button>Retry save</button>"; });
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeFocused();
  });
}

test("native recovery stays with the nested owner and preserves close restoration", async ({ page }) => {
  await renderDialog(page, `
    <button>Open nested</button>
    <dialog aria-label="Nested"><button>Save nested</button></dialog>
  `, "dialog");
  const opener = page.getByRole("button", { name: "Open nested", exact: true });
  await opener.focus();
  const nested = page.getByRole("dialog", { name: "Nested", includeHidden: true });
  await nested.evaluate((element: HTMLDialogElement) => element.showModal());
  const save = page.getByRole("button", { name: "Save nested", exact: true });
  await expect(save).toBeFocused();
  await save.evaluate((button: HTMLButtonElement) => { button.disabled = true; });
  await page.keyboard.press("Tab");
  await expect(nested).toBeFocused();
  await page.locator("#focus-dialog").evaluate(element => {
    const status = document.createElement("p");
    status.textContent = "Background status updated";
    element.append(status);
  });
  await expect(nested).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(nested).toBeFocused();
  await nested.evaluate((element: HTMLDialogElement) => element.close());
  await expect(opener).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(opener).toBeFocused();
});

test("a nested native modal escapes its parent's inertness without losing retained focus", async ({ page }) => {
  await renderDialog(page, `
    <button>Open nested</button>
    <dialog aria-label="Nested">
      <p role="status">Loading</p>
      <button>Nested first</button>
      <button>Nested last</button>
      <div inert><button>Unavailable nested action</button></div>
    </dialog>
  `, "dialog");
  const parent = page.locator("#focus-dialog");
  const nested = page.getByRole("dialog", { name: "Nested", includeHidden: true });
  await nested.evaluate((element: HTMLDialogElement) => element.showModal());
  await parent.evaluate(element => { element.setAttribute("inert", ""); });
  const first = nested.getByRole("button", { name: "Nested first", exact: true });
  const last = nested.getByRole("button", { name: "Nested last", exact: true });
  await first.focus();
  await nested.getByRole("status").evaluate(element => { element.textContent = "Loaded"; });
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await nested.getByRole("button").evaluateAll(buttons => {
    for (const button of buttons) (button as HTMLButtonElement).disabled = true;
  });
  await expect(nested).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(nested).toBeFocused();
  await nested.evaluate(element => { element.innerHTML = "<p>Load failed</p><button>Retry nested</button>"; });
  await page.keyboard.press("Tab");
  await expect(nested.getByRole("button", { name: "Retry nested" })).toBeFocused();
});

test("CSV import focus stays contained during saving and in the single-action result", async ({ page }) => {
  await renderDialog(page, `
    <h2 tabindex="-1">Add CSV reports</h2>
    <input type="file" hidden multiple aria-label="Official usage CSV files">
    <button>Choose CSV files</button>
    <button>Cancel</button>
  `, "dialog");
  const dialog = page.getByRole("dialog");
  const choose = dialog.getByRole("button", { name: "Choose CSV files", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await choose.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(choose).toBeFocused();
  await dialog.getByRole("button").evaluateAll(buttons => {
    for (const button of buttons) (button as HTMLButtonElement).disabled = true;
  });
  await dialog.getByRole("heading").focus();
  await page.keyboard.press("Tab");
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog).toBeFocused();
  await dialog.evaluate(element => {
    element.innerHTML = '<h2 tabindex="-1">Reports imported</h2><button>OK</button>';
  });
  await dialog.getByRole("heading").focus();
  const ok = dialog.getByRole("button", { name: "OK", exact: true });
  for (const key of ["Tab", "Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    await expect(ok).toBeFocused();
  }
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

test("native showModal rejects invalid owners and repeated opening preserves the focused draft", async ({ page }) => {
  await renderDialog(page, '<button disabled autofocus>Disabled</button><button hidden>Hidden</button><button>First</button><input aria-label="Draft">', "dialog");
  await expect(page.getByRole("button", { name: "First", exact: true })).toBeFocused();
  const draft = page.getByRole("textbox", { name: "Draft" });
  await draft.fill("Retained draft");
  const dialog = page.locator("#focus-dialog");
  await dialog.evaluate((element: HTMLDialogElement) => element.showModal());
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Retained draft");
  expect(await page.evaluate(() => {
    const result: string[] = [];
    const detached = document.createElement("dialog");
    const retired = document.createElement("dialog");
    document.body.append(retired);
    retired.showModal();
    retired.remove();
    const nonmodal = document.createElement("dialog");
    document.body.append(nonmodal);
    nonmodal.open = true;
    for (const element of [detached, retired, nonmodal]) {
      try { element.showModal(); result.push("opened"); }
      catch (cause) { result.push(cause instanceof DOMException ? cause.name : "unexpected error"); }
    }
    return result;
  })).toEqual(["InvalidStateError", "InvalidStateError", "InvalidStateError"]);
});

test("native close is idempotent and restores focus before its queued event can observe a reopened dialog", async ({ page }) => {
  await renderDialog(page, '<button>First</button><button>Last</button>', "dialog");
  const result = await page.evaluate(async () => {
    const dialog = document.querySelector<HTMLDialogElement>("#focus-dialog")!;
    dialog.close();
    await new Promise<void>(resolve => dialog.addEventListener("close", () => resolve(), { once: true }));
    const opener = document.querySelector<HTMLButtonElement>("body > button")!;
    opener.focus();
    dialog.showModal();
    const events: { bubbles: boolean; cancelable: boolean; open: boolean }[] = [];
    const closed = new Promise<void>(resolve => {
      dialog.addEventListener("close", event => {
        events.push({ bubbles: event.bubbles, cancelable: event.cancelable, open: dialog.open });
        resolve();
      });
    });
    dialog.close("accepted");
    dialog.close("ignored");
    const immediate = { open: dialog.open, restored: document.activeElement === opener, returnValue: dialog.returnValue, events: events.length };
    dialog.showModal();
    await closed;
    await new Promise(resolve => setTimeout(resolve, 0));
    return { immediate, events, open: dialog.open, returnValue: dialog.returnValue };
  });
  expect(result).toEqual({
    immediate: { open: false, restored: true, returnValue: "accepted", events: 0 },
    events: [{ bubbles: false, cancelable: false, open: true }], open: true, returnValue: "accepted",
  });
});

test("only trusted Escape requests native cancellation, and a blocked nested dialog retains ownership", async ({ page }) => {
  await renderDialog(page, '<button>Open nested</button><dialog aria-label="Nested"><button>Nested action</button></dialog>', "dialog");
  const parent = page.locator("#focus-dialog");
  const nested = page.getByRole("dialog", { name: "Nested", includeHidden: true });
  await nested.evaluate((element: HTMLDialogElement) => {
    element.showModal();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    element.dispatchEvent(new Event("cancel", { cancelable: true }));
    element.addEventListener("cancel", event => event.preventDefault(), { once: true });
  });
  await expect(nested).toHaveJSProperty("open", true);
  await page.keyboard.press("Escape");
  await expect(nested).toHaveJSProperty("open", true);
  await expect(nested.getByRole("button")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(nested).toHaveJSProperty("open", false);
  await expect(parent).toHaveJSProperty("open", true);
  await expect(parent.getByRole("button", { name: "Open nested" })).toBeFocused();
});
