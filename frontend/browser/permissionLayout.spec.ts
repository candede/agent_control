import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityView } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { permissionLayoutRequestKind, type PermissionLayoutRequestKind } from "./permissionFixtures";
import { collectLayoutFailures } from "./layoutGeometry";
import { isAutomaticRefreshRequest } from "./automaticRefreshFixtures";

function permissions(): CapabilityView[] {
  return capabilityDefinitions.map(definition => {
    const application = definition.mode === "application";
    const local = definition.mode === "local";
    const onDemand = definition.probe.kind === "on_demand";
    const provider = ["graph.package.read.delegated", "graph.directory.read", "powerPlatform.inventory.read"].includes(definition.id);
    return {
      definition, enabled: !application,
      ...(application ? { configuration: { enabled: false, sharedDataScope: false } } : {}),
      decision: {
        capabilityId: definition.id, status: application ? "not_configured" : "available",
        authorized: !application, fresh: true,
        verification: application ? undefined : local ? "local" : onDemand ? "on_demand" : provider ? "provider" : "token",
        ...(local || onDemand ? {} : {
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
    if (isAutomaticRefreshRequest(request)) return;
    if (request.method() === "POST") posts.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/auth/consent" || url.pathname.startsWith("/api/")
      && request.method() !== "GET" && !permissionLayoutRequestKind(request.method(), url)) {
      unexpected.push(`${request.method()} ${url.pathname}${url.search}`);
    }
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

async function expectQuietPermissions(page: Page) {
  const center = page.locator(".permission-center");
  await expect(center).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("region", { name: "Issues", exact: true }).getByRole("status")).toHaveText("No issues reported.");
  await expect(center.getByRole("button", { name: /^Details:/, includeHidden: true })).toHaveCount(0);
  await expect(center.getByRole("table", { includeHidden: true })).toHaveCount(0);
  await expect(center.getByRole("columnheader", { name: "Access", includeHidden: true })).toHaveCount(0);
  await expect(center.getByRole("button", { name: /Account access|Shared application modes/, includeHidden: true })).toHaveCount(0);
  await expect(center.getByRole("combobox", { name: "Show", includeHidden: true })).toHaveCount(0);
  await expect(center.locator(".permission-counts, .capability-status")).toHaveCount(0);
  expect(await center.textContent()).not.toMatch(/Ready to try|Microsoft checks(?: access)? when used|Microsoft validates permission|provider[- ]verified|provider authorization not verified|no current verification|not checked|last recorded success|all permissions verified/i);
  await expect(page.locator(".capability-health")).toHaveAccessibleName("Permissions");
  await expect(page.locator(".capability-health")).toHaveAccessibleDescription("Permissions and setup");
  await expect(page.locator(".capability-health")).toHaveText("Permissions");
}

async function watchPermissionWarnings(page: Page) {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (document.querySelector(".permission-issues [role=alert], .permission-issue-list > li, .capability-health[aria-description='Permissions: check failed']")) {
        document.documentElement.setAttribute("data-permission-warning-observed", "true");
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}

test.beforeEach(async ({ context }) => {
  await context.route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => route.abort());
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("healthy Permissions is concise, quiet and read-only with collapsed setup", async ({ page }, info) => {
  const { unexpected, posts } = await mockPermissions(page, permissions);
  await page.goto("/permissions");
  await expect.poll(() => posts).toEqual(["/api/capabilities/check"]);
  await expectQuietPermissions(page);
  const center = page.locator(".permission-center");
  await expect(center.getByText("App administrator", { exact: true })).toBeVisible();
  await expect(center.getByRole("region", { name: "App prerequisites" })).toBeVisible();
  await expect(center.getByText("Required API permissions", { exact: true })).toBeVisible();
  await expect(center.getByText("Log collection setup", { exact: true })).toBeVisible();
  await expect(center.locator("details[open]")).toHaveCount(0);
  expect((await center.innerText()).trim().split(/\s+/).length).toBeLessThanOrEqual(110);
  await expect(center.getByRole("button", { name: /Request consent|Authorize|Grant admin consent/, includeHidden: true })).toHaveCount(0);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-overview.png"), fullPage: true });
  await center.getByRole("button", { name: "Check status", exact: true }).click();
  await expectQuietPermissions(page);
  expect(posts).toEqual(["/api/capabilities/check", "/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});

test("disabled application modes remain optional permission references, not problems", async ({ page }, info) => {
  const { unexpected, posts } = await mockPermissions(page, permissions);
  await page.goto("/permissions");
  await expectQuietPermissions(page);
  const setup = page.getByRole("region", { name: "App prerequisites" });
  const required = setup.getByText("Required API permissions", { exact: true });
  await required.focus();
  await page.keyboard.press("Enter");
  await expect(setup.getByText("Microsoft Graph / Delegated", { exact: true })).toBeVisible();
  await expect(setup.getByText("Optional application permissions", { exact: true })).toBeVisible();
  const optional = setup.locator("details.permission-optional");
  await expect(optional).not.toHaveAttribute("open", "");
  await expect(optional.getByRole("region", { name: "Microsoft Graph / Application", includeHidden: true })).not.toBeVisible();
  await optional.getByText("Optional application permissions", { exact: true }).click();
  const application = optional.getByRole("region", { name: "Microsoft Graph / Application", exact: true });
  for (const permission of ["CopilotPackages.Read.All", "AuditLogsQuery.Read.All", "ThreatHunting.Read.All"]) {
    await expect(application.getByText(permission, { exact: true })).toBeVisible();
  }
  await expect(optional.getByText(/Only for administrator-configured app-only access/)).toBeVisible();
  await expect(setup.getByRole("link", { name: "Open Entra admin center" })).toHaveAttribute("href", "https://entra.microsoft.com/");
  await expect(setup.getByRole("button", { name: /Enable|Consent|Authorize/i, includeHidden: true })).toHaveCount(0);
  await expectQuietPermissions(page);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  expect((await new AxeBuilder({ page }).include(".permission-prerequisites").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-optional-setup.png"), fullPage: true });
  expect(posts).toEqual(["/api/capabilities/check"]);
  expect(unexpected).toEqual([]);
});

test("unchecked, stale, disabled, unregistered and app-role decisions are not issues", async ({ page }) => {
  const now = Date.now();
  const { unexpected } = await mockPermissions(page, () => permissions().map((view): CapabilityView => {
    const decision = { ...view.decision, status: "missing_permission" as const, authorized: false };
    switch (view.definition.id) {
      case "graph.package.read.delegated": return { ...view, decision: { ...decision, fresh: false } };
      case "graph.directory.read": return { ...view, decision: { ...decision, expiresAt: new Date(now - 1000).toISOString() } };
      case "powerPlatform.inventory.read": return { ...view, decision: { ...decision, checkedAt: undefined, expiresAt: undefined } };
      case "graph.package.block.manage": return { ...view, decision: { ...decision, status: "missing_internal_role" } };
      case "graph.package.access.manage": return { ...view, decision: { ...decision, checkedAt: new Date(now + 60_000).toISOString() } };
      case "powerPlatform.quarantine.read": return { ...view, decision: { ...decision, checkedAt: "invalid" } };
      case "powerPlatform.quarantine.manage": return { ...view, decision: { ...decision, expiresAt: "invalid" } };
      case "graph.package.reassign.manage": return { ...view, decision };
      default: return view.definition.mode === "application" ? { ...view, decision } : view;
    }
  }));
  await page.route("**/api/me", route => route.fulfill({ json: {
    user: { displayName: "Synthetic viewer", username: "viewer@example.invalid", homeAccountId: "viewer-fixture", roles: ["AgentControl.Viewer"] },
    csrfToken: "synthetic-csrf", roleAssignmentRequired: false,
  } }));
  await page.goto("/permissions");
  await expectQuietPermissions(page);
  await expect(page.getByText("App viewer", { exact: true })).toBeVisible();
  expect(unexpected).toEqual([]);
});

test("fresh failures have friendly details, setup links, keyboard focus and explicit recovery", async ({ page }, info) => {
  let recovered = false;
  const { unexpected, posts } = await mockPermissions(page, kind => {
    if (kind === "retry-failed") recovered = true;
    return permissions().map(view => {
      if (kind === "catalog" || recovered || view.definition.id !== "graph.package.read.delegated") return view;
      return { ...view, decision: {
        ...view.decision, status: "provider_error", authorized: false, verification: undefined,
        evidence: { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000, correlationId: "synthetic-timeout-request" },
        remediation: ["Retry the safe status check after checking connectivity."],
      } };
    });
  });
  await page.goto("/permissions");
  const issues = page.getByRole("region", { name: "Issues", exact: true });
  await expect(issues.getByRole("listitem")).toHaveCount(1);
  await expect(issues.getByText("Agent inventory", { exact: true })).toBeVisible();
  await expect(issues.getByText("Microsoft did not respond after retrying.", { exact: true })).toBeVisible();
  await expect(page.locator(".capability-health")).toHaveAccessibleName("Permissions");
  await expect(page.locator(".capability-health")).toHaveAccessibleDescription("Permissions: 1 issue");
  await expect(issues.getByText("Package catalog read", { exact: true })).toHaveCount(0);
  const trigger = issues.getByRole("button", { name: "Details: Agent inventory", exact: true });
  expect(await issues.locator("strong").evaluate(element => getComputedStyle(element).textTransform)).toBe("none");
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-needs-attention.png"), fullPage: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Agent inventory", exact: true });
  await expect(dialog.getByRole("heading", { name: "Agent inventory", exact: true })).toBeFocused();
  await expect(dialog.getByRole("region", { name: "Required setup" })).toContainText("Microsoft Graph / delegated: CopilotPackages.Read.All");
  await expect(dialog.getByRole("region", { name: "Setup and documentation" })).toBeVisible();
  await expect(dialog.locator("details[open]")).toHaveCount(0);
  await expect(dialog.getByText("synthetic-timeout-request", { exact: true })).not.toBeVisible();
  expect(await dialog.textContent()).not.toMatch(/Verification|Evidence freshness|Operation access|Last success|last recorded success|Ready to try|provider authorization not verified/i);
  await expect(dialog.getByRole("button", { name: "Request consent", includeHidden: true })).toHaveCount(0);
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press(key);
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
  }
  const technical = dialog.getByText("Technical details", { exact: true });
  await technical.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("synthetic-timeout-request", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Retry the safe status check after checking connectivity.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("https://graph.microsoft.com", { exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".workbench-dialog[open]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-details.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expectQuietPermissions(page);
  expect(posts).toEqual(["/api/capabilities/check", "/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});

test("an actual on-demand operation denial is actionable without a readiness warning", async ({ page }) => {
  const { unexpected } = await mockPermissions(page, () => permissions().map(view => view.definition.id !== "graph.licenses.read" ? view : {
    ...view,
    operationFailure: {
      status: "missing_permission", checkedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      evidence: { category: "missing_permission", phase: "provider_read", httpStatus: 403, correlationId: "synthetic-license-denial" },
      remediation: ["Ask an administrator to configure license sync permissions."],
    },
  }));
  await page.goto("/permissions");
  const issue = page.getByRole("region", { name: "Issues", exact: true }).getByRole("listitem");
  await expect(issue).toHaveCount(1);
  await expect(issue.getByText("Copilot license sync", { exact: true })).toBeVisible();
  await expect(issue.getByText("Microsoft denied the required API permission.", { exact: true })).toBeVisible();
  await expect(issue.getByRole("link", { name: "Admin setup", exact: true })).toHaveAttribute("href", "https://entra.microsoft.com/");
  await issue.getByRole("button", { name: "Details: Copilot license sync", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Copilot license sync", exact: true });
  await dialog.getByText("Technical details", { exact: true }).click();
  await expect(dialog.getByText("synthetic-license-denial", { exact: true })).toBeVisible();
  await expect(dialog.getByText("403", { exact: true })).toBeVisible();
  expect(await dialog.textContent()).not.toMatch(/Ready to try|provider authorization not verified/i);
  expect(unexpected).toEqual([]);
});

test("a cached timeout stays quiet while the initial automatic retry is pending", async ({ page }) => {
  await watchPermissionWarnings(page);
  const { unexpected, posts } = await mockPermissions(page, () => permissions().map(view =>
    view.definition.id !== "graph.package.read.delegated" ? view : {
      ...view, decision: {
        ...view.decision, status: "provider_error", authorized: false, verification: undefined,
        evidence: { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000 },
      },
    }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === "/api/capabilities/check", async route => {
    await held;
    return route.fulfill({ json: { value: permissions() } });
  });
  try {
    await page.goto("/permissions");
    await expect.poll(() => posts).toEqual(["/api/capabilities/check?retry=failed"]);
    const issues = page.getByRole("region", { name: "Issues", exact: true });
    await expect(page.getByRole("region", { name: "Permission check progress" })).toContainText("Checking permissions");
    await expect(issues.getByRole("listitem")).toHaveCount(0);
    await expect(issues.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".capability-health")).toHaveAccessibleName("Permissions");
    await expect(page.locator(".capability-health")).toHaveAccessibleDescription("Permissions and setup");
    await expect(page.locator(".capability-health")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator(".capability-health")).toHaveAttribute("title", "Checking permissions");
    expect(await issues.textContent()).not.toMatch(/did not respond|timeout|failed/i);
  } finally {
    release();
  }
  await expectQuietPermissions(page);
  await expect(page.locator("html")).not.toHaveAttribute("data-permission-warning-observed", "true");
  expect(posts).toEqual(["/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});

for (const endpoint of ["/api/capabilities", "/api/capabilities/check"]) {
  test(`${endpoint}: transient transport failure retries once after one second without an early warning`, async ({ page }) => {
    await watchPermissionWarnings(page);
    const { unexpected } = await mockPermissions(page, permissions);
    const attempts: number[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(url => url.pathname === endpoint, async route => {
      attempts.push(performance.now());
      if (attempts.length === 1) return route.fulfill({ status: 503, json: { error: { code: "provider_error", message: "Synthetic transport outage" } } });
      await held;
      return route.fulfill({ json: { value: permissions() } });
    });
    try {
      await page.goto("/permissions");
      await expect(page.locator(".permission-center")).toHaveAttribute("aria-busy", "true");
      await expect(page.getByRole("region", { name: "Issues", exact: true }).getByRole("alert")).toHaveCount(0);
      await expect.poll(() => attempts.length).toBe(2);
      expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(1000);
      await expect(page.getByRole("region", { name: "Permission check progress" })).toContainText(endpoint === "/api/capabilities"
        ? "Loading permission results" : "Checking permissions");
      await expect(page.getByRole("region", { name: "Issues", exact: true }).getByRole("alert")).toHaveCount(0);
      await expect(page.locator(".capability-health")).toHaveAccessibleName("Permissions");
      await expect(page.locator(".capability-health")).toHaveAccessibleDescription("Permissions and setup");
      await expect(page.locator(".capability-health")).toHaveAttribute("aria-busy", "true");
      await expect(page.locator(".capability-health")).toHaveAttribute("title", "Checking permissions");
      await expect(page.getByRole("button", { name: "Checking...", exact: true })).toBeDisabled();
    } finally {
      release();
    }
    await expectQuietPermissions(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-permission-warning-observed", "true");
    expect(attempts).toHaveLength(2);
    expect(unexpected).toEqual([]);
  });
}

test("Check status shows real progress, animated work and reduced-motion feedback", async ({ page }, info) => {
  const { unexpected, posts } = await mockPermissions(page, permissions);
  await page.goto("/permissions");
  await expectQuietPermissions(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let completeInventory = false;
  const progressRequests: string[] = [];
  await page.route(url => url.pathname === "/api/capabilities/check", async route => {
    await held;
    return route.fulfill({ json: { value: permissions() } });
  });
  await page.route(url => url.pathname === "/api/capabilities/check-progress", route => {
    progressRequests.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { progress: { checks: [
      { capabilityId: "graph.package.read.delegated", state: completeInventory ? "complete" : "checking" },
      { capabilityId: "graph.directory.read", state: "complete" },
      { capabilityId: "powerPlatform.inventory.read", state: "checking" },
      { capabilityId: "defender.hunting.delegated", state: "complete" },
    ] } } });
  });
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    const progress = page.getByRole("region", { name: "Permission check progress" });
    await expect(progress.getByRole("status")).toContainText("2 of 4 reviewed");
    await expect(progress.getByRole("progressbar")).toHaveAttribute("value", "2");
    await expect(progress.getByText("Agent inventory", { exact: true })).toBeVisible();
    await expect(progress.getByText("Power Platform inventory", { exact: true })).toBeVisible();
    await expect(progress.getByText("Defender / Agent 365 logs", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Checking...", exact: true })).toBeDisabled();
    const spinner = progress.locator(".permission-spinner");
    expect(await spinner.evaluate(element => getComputedStyle(element).animationName)).toBe("permission-spin");
    const before = await spinner.evaluate(element => getComputedStyle(element).transform);
    await expect.poll(() => spinner.evaluate(element => getComputedStyle(element).transform)).not.toBe(before);
    expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
    expect((await new AxeBuilder({ page }).include(".permission-progress").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath("permissions-checking.png"), fullPage: true });
    completeInventory = true;
    await expect(progress.getByRole("status")).toContainText("3 of 4 reviewed");
    await expect(progress.getByText("Agent inventory", { exact: true })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await spinner.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await expect(progress.getByText("Power Platform inventory", { exact: true })).toBeVisible();
  } finally { release(); }
  await expectQuietPermissions(page);
  await expect(page.getByRole("region", { name: "Permission check progress" })).toHaveCount(0);
  expect(progressRequests.length).toBeGreaterThanOrEqual(2);
  expect(progressRequests.every(query => query === "?retry=failed")).toBe(true);
  expect(posts).toEqual(["/api/capabilities/check", "/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});
