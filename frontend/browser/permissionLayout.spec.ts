import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityView } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { permissionLayoutRequestKind, type PermissionLayoutRequestKind } from "./permissionFixtures";

function permissions(): CapabilityView[] {
  return capabilityDefinitions.map(definition => {
    const application = definition.mode === "application";
    const local = definition.mode === "local";
    const provider = ["graph.package.read.delegated", "graph.directory.read", "powerPlatform.inventory.read"].includes(definition.id);
    return {
      definition, enabled: !application,
      ...(application ? { configuration: { enabled: false, sharedDataScope: false } } : {}),
      decision: {
        capabilityId: definition.id, status: application ? "not_configured" : "available",
        authorized: !application, fresh: true,
        verification: application ? undefined : local ? "local" : provider ? "provider" : "token",
        ...(local ? {} : {
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          lastSuccessAt: new Date(Date.now() - 1000).toISOString(),
        }),
        previewQualification: "not_required", remediation: [],
      },
    };
  });
}

async function mockPermissions(page: Page, views: (kind: PermissionLayoutRequestKind) => CapabilityView[]) {
  const unexpected = await mockLayoutApi(page);
  const posts: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST") posts.push(`${url.pathname}${url.search}`);
  });
  await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname),
    route => {
      const request = route.request();
      const url = new URL(request.url());
      const kind = permissionLayoutRequestKind(request.method(), url);
      if (!kind) {
        unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
        return route.fulfill({ status: 501, json: { error: "Unexpected permission layout fixture request" } });
      }
      return route.fulfill({ json: { value: views(kind) } });
    });
  return { unexpected, posts };
}

test.beforeEach(async ({ context }) => {
  await context.route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => route.abort());
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Permissions is a task-grouped access table with one accessible details view", async ({ page }, info) => {
  const { unexpected, posts } = await mockPermissions(page, permissions);
  await page.goto("/permissions");
  await expect.poll(() => posts).toContain("/api/capabilities/check");
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
  const table = page.getByRole("table", { name: "Account permissions" });
  await expect(table.getByRole("button", { name: /^View details for/ })).toHaveCount(12);
  await expect(page.getByRole("article")).toHaveCount(0);
  await expect(page.getByText("Resource audience", { exact: true })).toHaveCount(0);
  for (const group of ["Inventory & people", "Agent controls", "Reports & investigations"]) {
    await expect(table.getByText(group, { exact: true })).toBeVisible();
  }
  const summary = page.getByLabel("Account access summary");
  await expect(summary).toContainText("Provider verified3");
  await expect(summary).toContainText("Ready to try8");
  await expect(summary).toContainText("Local access1");
  await expect(summary).toContainText("Needs attention0");
  const catalog = table.getByRole("row", { name: "Package catalog read", exact: true });
  expect(await catalog.getByRole("rowheader").evaluate(element => getComputedStyle(element).textTransform)).toBe("none");
  for (const element of [catalog.locator(".capability-status"), catalog.getByRole("button", { name: "View details for Package catalog read" })]) {
    const box = await element.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-overview.png"), fullPage: true });

  const trigger = page.getByRole("button", { name: "View details for Package block management", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Package block management", exact: true });
  await expect(dialog.getByRole("heading", { name: "Package block management", exact: true })).toBeFocused();
  await expect(dialog.getByText("Token acquired; provider authorization not verified", { exact: true })).toBeVisible();
  await expect(dialog.getByText("delegated: CopilotPackages.ReadWrite.All", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open Agents", exact: true })).toBeVisible();
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Request consent" })).toHaveCount(0);
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  expect((await new AxeBuilder({ page }).include(".workbench-dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-details.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await page.getByRole("button", { name: "Shared application modes (3)" }).click();
  await expect(page.getByRole("table", { name: "Shared application permissions" }).getByText("Disabled", { exact: true })).toHaveCount(3);
  await expect(page.getByText(/0 active, 3 inactive/)).toBeVisible();
  await page.getByRole("combobox", { name: "Show" }).selectOption("attention");
  await expect(page.getByText("No capabilities in this view need attention.")).toBeVisible();
  await page.getByRole("button", { name: "Account access (12)" }).click();
  await expect(table.getByRole("button", { name: /^View details for/ })).toHaveCount(12);
  expect(posts.every(path => path === "/api/capabilities/check")).toBe(true);
  expect(unexpected).toEqual([]);
});

test("Permissions keeps failures actionable and retains evidence without cluttering healthy rows", async ({ page }, info) => {
  let recovered = false;
  const { unexpected, posts } = await mockPermissions(page, kind => {
    if (kind === "retry-failed") recovered = true;
    return permissions().map(view => {
      if (recovered || view.definition.id !== "graph.package.read.delegated") return view;
      return { ...view, decision: {
        ...view.decision, status: "provider_error", authorized: false, verification: undefined,
        evidence: { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000, correlationId: "synthetic-timeout-request" },
        remediation: ["Retry the safe status check after checking connectivity."],
      } };
    });
  });
  await page.goto("/permissions");
  await expect.poll(() => posts).toContain("/api/capabilities/check");
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
  const row = page.getByRole("row", { name: "Package catalog read", exact: true });
  await expect(row.getByText("Check timed out", { exact: true })).toBeVisible();
  await expect(row.getByText(/bounded provider check timed out after 30 seconds/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Request consent" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Show" }).selectOption("attention");
  await expect(page.getByRole("table").getByRole("button", { name: /^View details for/ })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("permissions-needs-attention.png"), fullPage: true });
  await row.getByRole("button", { name: "View details for Package catalog read" }).click();
  const dialog = page.getByRole("dialog", { name: "Package catalog read", exact: true });
  await expect(dialog.getByText("synthetic-timeout-request", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Retry the safe status check after checking connectivity.")).toBeVisible();
  await expect(dialog.getByText(/last recorded success is historical/)).toBeVisible();
  await page.keyboard.press("Escape");
  const postsBeforeRetry = posts.length;
  const retryResponse = page.waitForResponse(response =>
    permissionLayoutRequestKind(response.request().method(), new URL(response.url())) === "retry-failed");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  expect((await retryResponse).ok()).toBe(true);
  await expect(page.getByText("No capabilities in this view need attention.")).toBeVisible();
  await page.getByRole("button", { name: "Show all capabilities" }).click();
  await expect(row.getByText("Available", { exact: true })).toBeVisible();
  expect(posts.slice(0, postsBeforeRetry).every(path => path === "/api/capabilities/check")).toBe(true);
  expect(posts.slice(postsBeforeRetry)).toEqual(["/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});
