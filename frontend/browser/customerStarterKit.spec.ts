import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fixtureLoginUrl } from "./permissionFixtures";

async function choosePrompt(page: Page, id: string) {
  const picker = page.getByRole("combobox", { name: "Scenario", exact: true });
  if (await picker.isVisible()) await picker.selectOption(id);
  else {
    const title = id.charAt(0).toUpperCase() + id.slice(1).replaceAll("-", " ");
    await page.getByRole("button", { name: `View ${title}`, exact: true }).click();
  }
}

test("built staff assets, copied bytes and real downloaded skill match the canonical owner", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const login = new URL(fixtureLoginUrl("role-Viewer"));
  login.searchParams.set("returnTo", "/mcp-settings?fixture=role-Viewer");
  await page.goto(login.href);
  const promptLibrary: { prompts: { id: string; role: string; novice: string; experienced: string }[] } = JSON.parse(
    readFileSync(new URL("../public/customer-kit/adoption-intelligence/prompts.json", import.meta.url), "utf8"),
  );
  const suggested = page.getByRole("region", { name: "Suggested prompts", exact: true });
  await expect(suggested.getByRole("article")).toHaveCount(1);
  await suggested.getByRole("button", { name: "Individual prompts", exact: true }).click();
  await expect(page.locator(".mcp-settings > section").first()).toHaveAccessibleName("Suggested prompts");
  await expect(suggested.getByRole("button", { name: /^Copy / })).toHaveCount(2);
  expect(await suggested.locator(".mcp-prompt-mobile-picker option").allTextContents()).toEqual(
    promptLibrary.prompts.map(prompt => prompt.id.charAt(0).toUpperCase() + prompt.id.slice(1).replaceAll("-", " ")));
  for (const prompt of [promptLibrary.prompts[0], promptLibrary.prompts.find(prompt => prompt.role === "employee")!]) {
    await choosePrompt(page, prompt.id);
    const title = prompt.id.charAt(0).toUpperCase() + prompt.id.slice(1).replaceAll("-", " ");
    expect(await suggested.locator(".mcp-prompt-text").allTextContents()).toEqual([prompt.novice, prompt.experienced]);
    for (const [variant, value] of [["beginner", prompt.novice], ["advanced", prompt.experienced]]) {
      await suggested.getByRole("button", { name: `Copy ${variant} prompt: ${title}`, exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }
  }
  await expect(page.getByRole("heading", { name: "MCP Server Setup", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy MCP server description", exact: true })).toBeVisible();
  await expect(page.getByLabel("Exact server-description.md")).not.toBeVisible();
  await page.getByText("Exact setup text", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Exact server-description.md" })).toBeVisible();
  const manifest = await (await page.request.get("/customer-kit/manifest.json")).json();
  await expect(page.getByTestId("customer-kit-version")).toHaveText(manifest.version);
  for (const file of manifest.files) {
    const response = await page.request.get(`/customer-kit/adoption-intelligence/${file.path}`);
    expect(response.ok()).toBe(true);
    const bytes = await response.body();
    expect(bytes.length).toBe(file.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    if (file.path !== "employee-prompts.json")
      expect(bytes).toEqual(readFileSync(new URL(`../public/customer-kit/adoption-intelligence/${file.path}`, import.meta.url)));
  }
  await page.getByRole("button", { name: "Copy MCP server description", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe(readFileSync(new URL("../public/customer-kit/adoption-intelligence/server-description.md", import.meta.url), "utf8"));
  await page.getByLabel("Setup content").selectOption("general.md");
  await page.getByText("Exact setup text", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Exact general.md" })).toBeVisible();
  await expect(page.getByText(/Overview > Instructions > Edit/)).toBeVisible();
  await page.getByRole("button", { name: "Copy General agent system instructions", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe(readFileSync(new URL("../public/customer-kit/adoption-intelligence/general.md", import.meta.url), "utf8"));
  await expect(page.getByRole("button", { name: "Copy General agent system instructions", exact: true })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const sections = await page.locator(".mcp-settings > section").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
  }));
  expect(sections).toHaveLength(3);
  for (let index = 1; index < sections.length; index++) expect(sections[index].top - sections[index - 1].bottom).toBeGreaterThanOrEqual(24);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download installable skill ZIP", exact: true }).click();
  const download = await downloadPromise;
  expect(await download.failure()).toBeNull();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(readFileSync(new URL("../dist/customer-kit/adoption-intelligence.zip", import.meta.url)));
});

test("employee setup loads only its own finite connection and projected assets without staff catalog", async ({ page }) => {
  const api: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) api.push(path);
  });
  const login = new URL(fixtureLoginUrl("roleless-employee"));
  login.searchParams.set("returnTo", "/agents?fixture=roleless-employee");
  await page.goto(login.href);
  await expect(page.getByRole("button", { name: "Copy employee.md", exact: true })).toBeVisible();
  expect(await page.getByLabel("Customer asset").locator("option").allTextContents()).toEqual(["employee.md", "employee-prompts.json"]);
  await page.getByLabel("Customer asset").selectOption("employee-prompts.json");
  await expect(page.getByRole("button", { name: "Copy employee-prompts.json", exact: true })).toBeVisible();
  expect(api).not.toContain("/api/mcp/settings");
  expect(api).not.toContain("/api/workbench/metadata");
  expect(api).not.toContain("/api/agent-inventory");
  expect(api).toContain("/api/discovery/connection");
  await expect(page.getByRole("link", { name: /ZIP/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sync/ })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("packaged content load errors remain visible and retries independently reload exact bytes", async ({ page }) => {
  await page.route("**/customer-kit/manifest.json", route => route.fulfill({ status: 503, body: "unavailable" }));
  const login = new URL(fixtureLoginUrl("role-Viewer"));
  login.searchParams.set("returnTo", "/mcp-settings?fixture=role-Viewer");
  await page.goto(login.href);
  await expect(page.getByRole("alert").filter({ hasText: "Setup content" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Suggested prompts" })).toBeVisible();
  await page.unroute("**/customer-kit/manifest.json");
  await page.getByRole("button", { name: "Retry setup content", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy MCP server description", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry suggested prompts", exact: true }).click();
  await page.getByRole("button", { name: "Individual prompts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy beginner prompt: Activation backlog", exact: true })).toBeVisible();
});

test("suggested prompts stay available during a runtime metadata outage", async ({ page }) => {
  await page.route("**/api/mcp/settings", route => route.fulfill({ status: 503, body: "unavailable" }));
  const login = new URL(fixtureLoginUrl("role-Viewer"));
  login.searchParams.set("returnTo", "/mcp-settings?fixture=role-Viewer");
  await page.goto(login.href);
  await expect(page.getByRole("button", { name: "Retry metadata", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Individual prompts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy beginner prompt: Activation backlog", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Suggested prompts", exact: true }).getByRole("article")).toHaveCount(1);
  await expect(page.locator(".mcp-prompt-mobile-picker option")).toHaveCount(24);
});

test("clipboard denial selects the exact prompt for manual copying", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError"); },
    } });
  });
  const login = new URL(fixtureLoginUrl("role-Viewer"));
  login.searchParams.set("returnTo", "/mcp-settings?fixture=role-Viewer");
  await page.goto(login.href);
  await page.getByRole("button", { name: "Individual prompts", exact: true }).click();
  const prompt = page.getByRole("article", { name: "Activation backlog", exact: true }).locator(".mcp-prompt-text").first();
  await page.getByRole("button", { name: "Copy beginner prompt: Activation backlog", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "selected for manual copy" })).toBeVisible();
  await expect(prompt).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(await prompt.textContent());
});
