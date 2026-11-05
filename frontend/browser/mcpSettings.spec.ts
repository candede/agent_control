import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { fixtureLoginUrl } from "./permissionFixtures";

async function login(page: Page, scenario: string, username = "fixture@example.invalid") {
  const url = new URL(fixtureLoginUrl(scenario, username));
  url.searchParams.set("returnTo", `/mcp-settings?${new URLSearchParams({ fixture: scenario })}`);
  await page.goto(url.href);
}

test("real browser to session API to Python MCP displays the complete registered catalog exactly", async ({ page }) => {
  // Deliberately no route interception: all settings traffic reaches the real API and Python service.
  await login(page, "role-Viewer");
  await expect(page.getByRole("heading", { name: "MCP settings", exact: true })).toBeVisible();
  await expect(page.getByText("50 shown / 50 advertised tools")).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP settings", exact: true })).toHaveCSS("font-size",
    test.info().project.name === "mobile" ? "25px" : "28px");
  await page.screenshot({ path: test.info().outputPath("mcp-settings-overview.png") });
  expect(new URL(page.url()).pathname).toBe("/mcp-settings");
  const response = await page.request.get("/api/mcp/settings");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  const settings = await response.json();
  expect(settings.state).toBe("available");
  expect(settings.runtime.tools).toHaveLength(50);
  await expect(page.getByTestId("mcp-instructions")).toBeHidden();
  await page.getByText("Server instructions", { exact: true }).click();
  await expect(page.getByTestId("mcp-instructions")).toBeVisible();
  expect(await page.getByTestId("mcp-instructions").textContent()).toBe(settings.runtime.instructions);
  await page.locator(".mcp-instructions").screenshot({ path: test.info().outputPath("mcp-settings-instructions.png") });
  await page.getByRole("region", { name: "Runtime status", exact: true })
    .screenshot({ path: test.info().outputPath("mcp-settings-runtime.png") });
  expect(await page.getByTestId("mcp-description").allTextContents()).toEqual(
    settings.runtime.tools.map((tool: { description?: string }) => tool.description ?? ""));
  await expect(page.getByText("https://browser-mcp.example.invalid/auth/callback")).toBeVisible();
  await page.getByText("Allowed client redirects", { exact: true }).click();
  await expect(page.getByText("http://localhost:53109/client/callback")).toBeVisible();
  await expect(page.getByText(String(settings.configured.localHostPort), { exact: true })).toBeVisible();
  await expect(page.getByText("Unverified", { exact: true })).toHaveCount(2);
  const search = page.getByRole("searchbox", { name: "Search tools, descriptions and schemas" });
  await search.fill("inventory");
  const filtered = settings.runtime.tools.filter((tool: { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown }) =>
    `${tool.name}\n${tool.description ?? ""}`.toLowerCase().includes("inventory")
    || JSON.stringify({ input: tool.inputSchema, output: tool.outputSchema }).toLowerCase().includes("inventory"));
  await expect(page.getByText(`${filtered.length} shown / 50 advertised tools`)).toBeVisible();
  await page.getByLabel(`Inspect ${filtered[0].name}`, { exact: true }).focus();
  await page.keyboard.press("Enter");
  const summary = page.getByText(`Input schema — ${filtered[0].name}`, { exact: true });
  await summary.focus(); await page.keyboard.press("Enter");
  await expect(summary.locator("..").locator("pre")).toBeVisible();
  expect(await summary.locator("..").locator("pre").textContent()).toBe(JSON.stringify(filtered[0].inputSchema, null, 2));
  const schema = page.getByRole("region", { name: `Input schema for ${filtered[0].name}`, exact: true });
  await page.keyboard.press("Tab");
  await expect(schema).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => schema.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("mcp-settings-tool-detail.png") });
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await expect(page.getByText(`${filtered.length} shown / 50 advertised tools`)).toBeVisible();
  await page.reload();
  await expect(page.getByText("50 shown / 50 advertised tools")).toBeVisible();
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page.getByRole("button", { name: "Sign in with Entra ID" })).toBeVisible();
  await expect(page.getByTestId("mcp-instructions")).toHaveCount(0);
});

test("an unconfigured tenant direct link is honest and navigation does not reveal the other tenant", async ({ page }) => {
  await login(page, "role-Viewer", "fixture@csv-desktop.example.invalid");
  await expect(page.getByText("No MCP server is configured for this organization.")).toBeVisible();
  await expect(page.getByRole("button", { name: "MCP settings", exact: true })).toHaveCount(0);
  const response = await page.request.get("/api/mcp/settings");
  expect(await response.json()).toEqual({ state: "not_configured" });
});

test("retry preserves navigation, long text stays inert and logout discards an outstanding refresh", async ({ page }) => {
  await login(page, "role-Admin");
  await expect(page.getByText("50 shown / 50 advertised tools")).toBeVisible();
  const actual = await (await page.request.get("/api/mcp/settings")).json();
  const instructions = `<script>window.metadataExecuted=true</script>\n${"Long exact instructions. ".repeat(200)}`;
  const description = `<img src=x onerror="window.metadataExecuted=true">\n${"Complete exact description. ".repeat(300)}`;
  actual.runtime.instructions = instructions;
  actual.runtime.tools[0].description = description;
  actual.configured.resourceUrl = `https://browser-mcp.example.invalid/${"long-path".repeat(150)}`;
  actual.runtime.binding.resourceUrl = actual.configured.resourceUrl;
  let state: "unavailable" | "available" | "held" = "unavailable";
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/mcp/settings", async route => {
    if (state === "held") await held;
    await route.fulfill({ json: state === "unavailable"
      ? { state, configured: actual.configured, code: "metadata_unavailable" } : actual }).catch(() => undefined);
  });
  await page.reload();
  await expect(page.getByText("The server is configured, but validated runtime metadata is unavailable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "MCP settings", exact: true })).toBeVisible();
  state = "available";
  await page.getByRole("button", { name: "Retry metadata", exact: true }).click();
  await page.getByText("Server instructions", { exact: true }).click();
  await page.getByLabel(`Inspect ${actual.runtime.tools[0].name}`, { exact: true }).click();
  await expect(page.getByTestId("mcp-instructions")).toHaveText(instructions);
  expect(await page.getByTestId("mcp-instructions").textContent()).toBe(instructions);
  expect(await page.getByTestId("mcp-description").first().textContent()).toBe(description);
  expect(await page.evaluate(() => "metadataExecuted" in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  state = "held";
  const requested = page.waitForRequest(request => new URL(request.url()).pathname === "/api/mcp/settings");
  await page.getByRole("button", { name: "Refresh metadata", exact: true }).click();
  await requested;
  await expect(page.getByText("Loading MCP metadata…")).toBeVisible();
  await page.getByRole("button", { name: /Sign out/ }).click();
  await expect(page.getByRole("button", { name: "Sign in with Entra ID" })).toBeVisible();
  release();
  await expect(page.getByTestId("mcp-instructions")).toHaveCount(0);
});
