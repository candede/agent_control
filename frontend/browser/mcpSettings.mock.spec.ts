import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { parseMcpSettingsJson, type McpSettings } from "../../backend/src/types/mcpSettings";

const origin = "http://127.0.0.1:4175";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const promptLibrary = JSON.parse(readFileSync(join(dist, "customer-kit/adoption-intelligence/prompts.json"), "utf8")) as {
  prompts: Array<{ id: string; role: string; novice: string; experienced: string }>;
  conversations: Array<{ id: string; role: string; title: string; goal: string; context: string; steps: { title: string; prompt: string }[] }>;
};
const tenantId = "11111111-1111-4111-8111-111111111111";
const settings: McpSettings = {
  state: "available", configured: { resourceUrl: "https://mcp.example.invalid/mcp", localHostPort: 3003 },
  privacy: { hide_employee_details: true, hide_champion_employee: false }, privacyScope: "end_user_and_preview",
  observedAt: "2026-11-09T12:00:00.000Z",
  runtime: {
    binding: { tenantId, apiClientId: "22222222-2222-4222-8222-222222222222",
      mcpClientId: "33333333-3333-4333-8333-333333333333", resourceUrl: "https://mcp.example.invalid/mcp" },
    serverInfo: { name: "Agent Control", version: "0.1.0" },
    instructions: "  Use saved organizational evidence.\nKeep the exact runtime instructions.  ",
    transport: "streamable-http", storageReady: true, redirectUris: ["http://localhost:53109/client"],
    tools: [
      { name: "saved_read", description: "Read saved organizational evidence.",
        inputSchema: { type: "object", description: "hidden_schema_evidence" },
        outputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "explicit_control", description: "Request an explicitly confirmed action.",
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    ],
  },
};
parseMcpSettingsJson(JSON.stringify(settings));

async function openWorkspace(page: Page, context: BrowserContext, options: {
  metadataFailure?: boolean; promptFailure?: boolean; emptyTenant?: boolean;
} = {}) {
  const problems: string[] = [];
  const flags = { ...options };
  page.on("pageerror", error => problems.push(error.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      problems.push(`Unexpected external request: ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    const json = (body: object, status = 200) => route.fulfill({ json: body, status });
    switch (url.pathname) {
      case "/api/auth/status":
        return json({ authConfigured: true, callback: `${origin}/api/auth/callback` });
      case "/api/me":
        return json({ user: { tenantId, homeAccountId: "mock-reader", roles: ["AgentControl.Viewer"],
          displayName: "Workspace reader", username: "reader@example.invalid" }, csrfToken: "mock-csrf" });
      case "/api/capabilities":
      case "/api/capabilities/check":
        return json({ value: [] });
      case "/api/capabilities/check-progress":
        return json({ progress: null });
      case "/api/workbench/metadata":
        return json({ views: [{ id: "mcp-settings", label: "MCP settings", path: "/mcp-settings",
          roles: ["AgentControl.Viewer"], source: "Mocked browser contract" }], actions: [] });
      case "/api/data-sync/state":
        return json({ onboardingRequired: Boolean(flags.emptyTenant), usageImportRequired: Boolean(flags.emptyTenant),
          run: null, sources: [] });
      case "/api/mcp/authenticated-entry":
        return json({ admission: "current", nextCheckAt: new Date(Date.now() + 3600000).toISOString() });
      case "/api/mcp/settings":
        return flags.metadataFailure ? json({ error: "Mock metadata unavailable" }, 503) : json(settings);
    }
    if (url.pathname.startsWith("/api/")) {
      problems.push(`Unexpected API request: ${route.request().method()} ${url.pathname}`);
      return json({ error: "No mock exists for this API" }, 501);
    }
    if (flags.promptFailure && url.pathname === "/customer-kit/adoption-intelligence/prompts.json") {
      return json({ error: "Mock prompt library unavailable" }, 503);
    }
    const file = url.pathname === "/mcp-settings" || url.pathname === "/"
      ? join(dist, "index.html") : join(dist, url.pathname.slice(1));
    if (!existsSync(file)) {
      problems.push(`Missing built asset: ${url.pathname}`);
      return route.fulfill({ status: 404, body: "Built asset not found" });
    }
    return route.fulfill({ path: file });
  });
  await page.goto(`${origin}/mcp-settings`);
  if (flags.emptyTenant) await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(page.getByRole("region", { name: "Suggested prompts", exact: true })
    .getByRole("article")).toHaveCount(flags.promptFailure ? 0 : 1);
  return { flags, problems };
}

function title(id: string) { return id.charAt(0).toUpperCase() + id.slice(1).replaceAll("-", " "); }

async function choosePrompt(page: Page, id: string) {
  const picker = page.getByRole("combobox", { name: "Scenario", exact: true });
  if (await picker.isVisible()) await picker.selectOption(id);
  else await page.getByRole("button", { name: `View ${title(id)}`, exact: true }).click();
}

test("keeps all 48 canonical copies accessible in a spacious responsive prompt browser", async ({ page, context }, info) => {
  const { problems } = await openWorkspace(page, context);
  const prompts = page.getByRole("region", { name: "Suggested prompts", exact: true });
  await prompts.getByRole("button", { name: "Individual prompts", exact: true }).click();
  await expect(prompts.getByRole("button", { name: /^Copy / })).toHaveCount(2);
  expect(await prompts.locator(".mcp-prompt-mobile-picker option").allTextContents()).toEqual(
    promptLibrary.prompts.map(prompt => title(prompt.id)));
  for (const prompt of promptLibrary.prompts) {
    await choosePrompt(page, prompt.id);
    expect(await prompts.locator(".mcp-prompt-text").allTextContents()).toEqual([prompt.novice, prompt.experienced]);
    for (const [variant, value] of [["beginner", prompt.novice], ["advanced", prompt.experienced]]) {
      await prompts.getByRole("button", { name: `Copy ${variant} prompt: ${title(prompt.id)}`, exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }
  }
  await choosePrompt(page, promptLibrary.prompts[0].id);
  const navigation = page.getByRole("navigation", { name: "On this page" });
  for (const [link, heading] of [["MCP server setup", "MCP Server Setup"],
    ["Server details", "Server details"], ["Suggested prompts", "Suggested prompts"]]) {
    await navigation.getByRole("link", { name: link, exact: true }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeInViewport();
  }
  await page.screenshot({ path: info.outputPath("prompt-browser.png"), fullPage: true });
  const geometry = await page.locator(".mcp-settings > section").evaluateAll(sections => sections.map(section => {
    const rect = section.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  expect(geometry).toHaveLength(3);
  for (let index = 1; index < geometry.length; index++) {
    expect(geometry[index].top - geometry[index - 1].bottom).toBeGreaterThanOrEqual(24);
  }
  const diagnosticGaps = await page.locator("#mcp-server-details > .mcp-overview, #mcp-server-details > .mcp-card").evaluateAll(cards => cards.map(card => {
    const rect = card.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  expect(diagnosticGaps.length).toBeGreaterThanOrEqual(4);
  for (let index = 1; index < diagnosticGaps.length; index++) {
    expect(diagnosticGaps[index].top - diagnosticGaps[index - 1].bottom).toBeGreaterThanOrEqual(16);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(problems).toEqual([]);
});

test("defaults to complete conversations with exact unlocked steps in the same compact layout", async ({ page, context }, info) => {
  const { problems } = await openWorkspace(page, context);
  const library = page.getByRole("region", { name: "Suggested prompts", exact: true });
  await expect(library.getByRole("button", { name: "Conversations", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await library.locator(".mcp-prompt-mobile-picker option").allTextContents()).toEqual(
    promptLibrary.conversations.map(conversation => conversation.title));
  const controls = await library.getByRole("group", { name: "Library view" }).getByRole("button").evaluateAll(buttons =>
    buttons.map(button => button.getBoundingClientRect().top));
  expect(controls).toHaveLength(2);
  expect(controls[0]).toBe(controls[1]);
  for (const conversation of promptLibrary.conversations) {
    const picker = library.getByRole("combobox", { name: "Conversation", exact: true });
    if (await picker.isVisible()) await picker.selectOption(conversation.id);
    else await library.getByRole("button", { name: `View ${conversation.title}`, exact: true }).click();
    await library.getByRole("button", { name: "Conversations", exact: true }).click();
    const article = library.getByRole("article", { name: conversation.title, exact: true });
    await expect(article.getByText(conversation.goal, { exact: true })).toBeVisible();
    await expect(article.getByText(conversation.context, { exact: true })).toBeVisible();
    expect(await article.locator(".mcp-prompt-text").allTextContents()).toEqual(conversation.steps.map(step => step.prompt));
    const copyAlignment = await article.locator(".mcp-prompt-variant > header").evaluateAll(headers =>
      headers.map(header => Math.abs(header.querySelector("h5")!.getBoundingClientRect().top
        - header.querySelector("button")!.getBoundingClientRect().top)));
    expect(copyAlignment).toHaveLength(conversation.steps.length);
    expect(copyAlignment.every(offset => offset <= 4)).toBe(true);
    for (let index = conversation.steps.length - 1; index >= 0; index--) {
      const copy = article.getByRole("button", { name: `Copy step ${index + 1}: ${conversation.title}`, exact: true });
      await expect(copy).toBeEnabled();
      await copy.click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(conversation.steps[index].prompt);
    }
  }
  await library.getByRole("combobox", { name: "Audience", exact: true }).selectOption("employee");
  await expect(library.getByRole("heading", { name: "Find your first useful agent", exact: true })).toBeVisible();
  await library.getByRole("button", { name: "Individual prompts", exact: true }).click();
  await expect(library.locator(".mcp-prompt-mobile-picker option")).toHaveCount(4);
  await library.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect(library.locator(".mcp-prompt-mobile-picker option")).toHaveCount(1);
  await library.getByRole("combobox", { name: "Audience", exact: true }).selectOption("all");
  const first = promptLibrary.conversations[0];
  const picker = library.getByRole("combobox", { name: "Conversation", exact: true });
  if (await picker.isVisible()) await picker.selectOption(first.id);
  else await library.getByRole("button", { name: `View ${first.title}`, exact: true }).click();
  await library.getByRole("heading", { name: "Suggested prompts", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("conversation-browser.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(problems).toEqual([]);
});

test("keeps guided setup and canonical package assets separate from expandable server diagnostics", async ({ page, context }, info) => {
  const { problems } = await openWorkspace(page, context);
  await page.getByRole("button", { name: "Copy resource URL" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(settings.configured.resourceUrl);
  for (const [file, button, copy] of [
    ["server-description.md", "Show server description", "Copy MCP server description"],
    ["general.md", "Show agent instructions", "Copy General agent system instructions"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByRole("button", { name: copy, exact: true })).toBeVisible();
    await expect(page.getByLabel(`Exact ${file}`)).not.toBeVisible();
    await page.getByText("Exact setup text", { exact: true }).click();
    const exact = readFileSync(join(dist, "customer-kit/adoption-intelligence", file), "utf8");
    await expect(page.getByRole("textbox", { name: `Exact ${file}` })).toHaveValue(exact);
    await page.getByRole("button", { name: copy, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(exact);
  }
  const zipPath = "/customer-kit/adoption-intelligence.zip";
  const download = page.getByRole("link", { name: "Download installable skill ZIP" });
  await expect(download).toHaveAttribute("download", "");
  await expect(download).toHaveAttribute("href", zipPath);
  const bytes = await page.evaluate(async path => {
    const response = await fetch(path, { credentials: "omit" });
    if (!response.ok) throw new Error(`Package asset failed: ${response.status}`);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, zipPath);
  expect(Buffer.from(bytes)).toEqual(readFileSync(join(dist, zipPath.slice(1))));
  const employee = await page.evaluate(async () => {
    const response = await fetch("/customer-kit/adoption-intelligence/employee-prompts.json", { credentials: "omit" });
    if (!response.ok) throw new Error(`Employee asset failed: ${response.status}`);
    return response.json();
  });
  expect(employee.prompts).toEqual(promptLibrary.prompts.filter(prompt => prompt.role === "employee"));
  expect(employee.conversations).toEqual(promptLibrary.conversations.filter(conversation => conversation.role === "employee"));
  expect(employee.contract).not.toHaveProperty("staffRole");
  const catalog = page.locator(".mcp-catalog");
  await expect(catalog).not.toHaveAttribute("open");
  expect(await page.locator(".mcp-schemas").count()).toBe(0);
  await page.getByText("Tool catalog", { exact: true }).click();
  await expect(page.getByText("2 shown / 2 advertised tools")).toBeVisible();
  await page.getByRole("checkbox", { name: "Read-only tools" }).check();
  await expect(page.getByText("1 shown / 2 advertised tools")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search tools, descriptions and schemas" }).fill("hidden_schema_evidence");
  await page.getByLabel("Inspect saved_read").click();
  await page.getByText("Input schema — saved_read", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Input schema for saved_read" }))
    .toHaveText(JSON.stringify(settings.runtime.tools[0].inputSchema, null, 2));
  const privacy = page.locator(".mcp-privacy");
  await expect(privacy).not.toHaveAttribute("open");
  await page.getByText("Employee discovery privacy", { exact: true }).click();
  await expect(privacy.getByText("hide_employee_details").locator("..")).toContainText("true");
  await expect(privacy.getByText("hide_champion_employee").locator("..")).toContainText("false");
  await page.getByRole("heading", { name: "Server details", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("server-details.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(problems).toEqual([]);
});

test("renders a wide enterprise department brief with findings and grounded example workflows", async ({ page }, info) => {
  const staff = readFileSync(join(dist, "customer-kit/adoption-intelligence/staff.md"), "utf8");
  const reference = staff.match(/```html\n([\s\S]+?)\n```/)?.[1];
  if (!reference) throw new Error("Missing canonical department email HTML layout");
  const example: Record<string, string> = {
    Company: "Example company",
    Department: "Claims Operations",
    "Reporting period": "1 to 28 October 2026",
    "Reported-user finding": "8 colleagues had reported agent use during this period.",
    "Department-agent finding": "4 distinct agents were reported used, including claims review and SQL query support.",
    "Adoption-opportunity finding": "The claims review agent was reported used by 2 colleagues.",
    "Evidence-backed strengths": "Colleagues already use Claims Review Assistant and Claims Query Assistant. Both fit practical departmental tasks, giving the team concrete tools to build on rather than starting from scratch.",
    "Evidence-backed improvement and recommended action": "Use a short peer demonstration to broaden familiarity with Claims Review Assistant, which currently has two reported users, then share a focused follow-up exercise.",
    "Departmental task": "Prepare a claim-denial follow-up",
    "Agent name": "Claims Review Assistant",
    "Department fit and supported capability": "Helps explain a denial reason and outline follow-up actions. For a claim being reviewed, use it to identify missing information and prepare the next payer clarification.",
    "Task-specific proposed prompt": "Using this anonymized denial code, reason and payer response, summarize the issue, identify missing information and suggest the next follow-up action.",
    "Next departmental task": "Prepare a weekly denial-trend query",
    "Next agent name": "Claims Query Assistant",
    "Next department fit and supported capability": "Helps turn claims-trend questions into SQL query drafts for the team's existing reporting schema.",
    "Next task-specific proposed prompt": "Write a read-only SQL query for this supplied claims schema that groups last month's denials by payer and reason and returns counts and amounts. Explain the filters.",
    "Task-relevant additional Microsoft recommendations": "Consider Prompt Coach to refine a claims follow-up request, Researcher to compare payer-policy sources for a claims question, and Analyst to explore an aggregate claims export.",
    "Permitted learning contacts": "For peer learning, Jordan is a contact for Claims Review Assistant and Alex for Claims Query Assistant.",
    "One concrete next action": "Choose one workflow above for an existing task this week, review the output and share one useful example with the team.",
    "Approved sign-off": "Copilot Adoption Team",
  };
  const html = reference.replace(/\[([A-Z][^\]]*)\]/g, (_, key: string) => {
    const text = example[key];
    if (text === undefined) throw new Error(`Unknown email layout placeholder: ${key}`);
    return text;
  });
  const requests: string[] = [];
  await page.route("**/*", async route => {
    requests.push(route.request().url());
    await route.abort("blockedbyclient");
  });
  await page.setContent(html);
  await expect(page.getByRole("heading", { name: "Copilot agent adoption review" })).toBeVisible();
  await expect(page.getByText("We are the Copilot Adoption Team.", { exact: false })).toBeVisible();
  for (const heading of ["Findings at a glance", "What is working", "Where we can improve",
    "Practical workflows for your team", "Recommended next step"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
  await expect(page.getByText("8 colleagues had reported agent use during this period.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prepare a claim-denial follow-up" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Prepare a weekly denial-trend query" })).toBeVisible();
  await expect(page.getByText("Suggested example:", { exact: true })).toHaveCount(2);
  const metrics = await page.evaluate(() => {
    const content = document.getElementById("email-content");
    if (!content) throw new Error("Missing email content container");
    const bounds = content.getBoundingClientRect();
    return {
      width: bounds.width, left: bounds.left, right: bounds.right,
      viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
      paragraphs: [...content.querySelectorAll("p, li")].map(paragraph => {
        const style = getComputedStyle(paragraph);
        return { font: Number.parseFloat(style.fontSize), line: Number.parseFloat(style.lineHeight) };
      }),
      sections: [...content.querySelectorAll("h2")].map(heading => {
        const cell = heading.closest("td");
        if (!cell) throw new Error("Missing padded email section");
        return Number.parseFloat(getComputedStyle(cell).paddingTop);
      }),
      workflows: [...content.querySelectorAll("h3")].map(heading => {
        const cell = heading.closest("td");
        if (!cell) throw new Error("Missing departmental workflow section");
        const bounds = cell.getBoundingClientRect();
        const style = getComputedStyle(cell);
        return { padding: Number.parseFloat(style.paddingTop), background: style.backgroundColor, top: bounds.top, bottom: bounds.bottom };
      }),
    };
  });
  expect(metrics.width).toBeLessThanOrEqual(960);
  expect(metrics.width).toBeGreaterThanOrEqual(Math.min(960, metrics.viewport - 32));
  expect(metrics.left).toBe(16);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.paragraphs.every(style => style.font >= 16 && style.line >= 24)).toBe(true);
  expect(metrics.sections).toHaveLength(7);
  expect(metrics.sections.every(padding => padding >= 24)).toBe(true);
  expect(metrics.workflows.map(workflow => workflow.padding)).toEqual([20, 20]);
  expect(metrics.workflows.every(workflow => ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"].includes(workflow.background))).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(requests).toEqual([]);
  await page.screenshot({ path: info.outputPath("enterprise-department-email.png"), fullPage: true });
});

test("preserves first-run access, independent metadata errors, prompt retry and manual copy", async ({ page, context }) => {
  const { flags, problems } = await openWorkspace(page, context, { metadataFailure: true, emptyTenant: true });
  await expect(page.getByRole("button", { name: "Retry metadata" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy MCP server description", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Audience", exact: true }).selectOption("employee");
  await expect(page.locator(".mcp-prompt-mobile-picker option")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Search prompts and conversations" }).fill("no-such-task");
  await expect(page.getByRole("heading", { name: "No matching conversations" })).toBeVisible();
  await page.getByRole("button", { name: "Clear library filters" }).click();
  await expect(page.locator(".mcp-prompt-mobile-picker option")).toHaveCount(promptLibrary.conversations.length);
  flags.promptFailure = true;
  await page.reload();
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(page.getByRole("button", { name: "Retry suggested prompts" })).toBeVisible();
  flags.promptFailure = false;
  await page.getByRole("button", { name: "Retry suggested prompts" }).click();
  await expect(page.locator(".mcp-prompt-mobile-picker option")).toHaveCount(promptLibrary.conversations.length);
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true, value: () => Promise.reject(new Error("Clipboard unavailable in test")),
  }));
  const conversation = promptLibrary.conversations[0];
  await page.getByRole("button", { name: `Copy step 1: ${conversation.title}`, exact: true }).click();
  await expect(page.getByText("Copy unavailable. The prompt is selected for manual copy.")).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(conversation.steps[0].prompt);
  flags.metadataFailure = false;
  await page.getByRole("button", { name: "Retry metadata", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy resource URL", exact: true })).toBeVisible();
  expect(problems).toEqual([]);
});
