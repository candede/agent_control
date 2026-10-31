import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { isApplicationCollectionCapability } from "../../backend/src/types/capability";
import type { CapabilityView } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { permissionLayoutRequestKind, type PermissionLayoutRequestKind } from "./permissionFixtures";
import { collectLayoutFailures } from "./layoutGeometry";
import { isAutomaticRefreshRequest } from "./automaticRefreshFixtures";

function permissions(): CapabilityView[] {
  return capabilityDefinitions.map(definition => {
    const application = definition.mode === "application";
    const optional = application && !isApplicationCollectionCapability(definition.id);
    const local = definition.mode === "local";
    const onDemand = definition.probe.kind === "on_demand";
    const provider = ["graph.package.read.application", "powerPlatform.inventory.read"].includes(definition.id);
    return {
      definition, enabled: !optional,
      ...(application ? { configuration: { enabled: !optional, sharedDataScope: !optional, revision: 1 } } : {}),
      decision: {
        capabilityId: definition.id, status: optional ? "not_configured" : "available",
        authorized: !optional, fresh: true,
        verification: optional ? undefined : local ? "local" : onDemand ? "on_demand" : provider ? "provider" : "token",
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

test("healthy Permissions has three open sections, concise app roles and a permission-first reference", async ({ page }, info) => {
  const { unexpected, posts } = await mockPermissions(page, permissions);
  await page.goto("/permissions");
  await expect.poll(() => posts).toEqual(["/api/capabilities/check"]);
  await expectQuietPermissions(page);
  const center = page.locator(".permission-center");
  await expect(center.getByText("App administrator", { exact: true })).toHaveCount(0);
  const apiPermissions = center.getByRole("region", { name: "App registration permissions" });
  await expect(apiPermissions).toBeVisible();
  await expect(apiPermissions).not.toContainText(/AgentControl\.|\b(?:Viewer|Uploader|UsageReportUploader|Admin)\b/);
  await expect(apiPermissions).not.toContainText(/\bapp[- ]roles?\b/i);
  await expect(center.getByText("Log collection setup", { exact: true })).toHaveCount(0);
  await expect(center.getByRole("link", { name: "Log setup", exact: true })).toHaveCount(0);
  await expect(center.locator("details, summary, [aria-expanded], dialog")).toHaveCount(0);
  await expect(center.locator(".permission-body > section")).toHaveCount(3);
  await expect(center.getByRole("navigation", { name: "Permissions sections" })).toHaveCount(0);
  await expect(center.getByRole("heading", { level: 3 })).toHaveText(["Issues", "App-defined roles", "App registration permissions"]);
  await expect(center.getByRole("region", { name: "App-defined roles", exact: true })).toBeVisible();
  const viewer = center.getByRole("article", { name: "Viewer", exact: true });
  await expect(viewer).toContainText("AgentControl.Viewer");
  await expect(viewer).toContainText("No signed-in Microsoft directory or reporting reader role is required");
  const admin = center.getByRole("article", { name: "Admin", exact: true });
  await expect(admin).toContainText("signed-in user's delegated permission");
  await expect(admin).toHaveClass(/\bis-assigned\b/);
  await expect(admin.getByText("Assigned to you", { exact: true })).toBeVisible();
  await expect(viewer).not.toHaveClass(/\bis-assigned\b/);
  await expect(admin).not.toHaveCSS("background-color", await viewer.evaluate(element => getComputedStyle(element).backgroundColor));
  await expect(admin).not.toHaveCSS("border-color", await viewer.evaluate(element => getComputedStyle(element).borderColor));
  await expect(center.getByRole("region", { name: "App-defined roles", exact: true })).toContainText("Application read permissions never authorize provider changes");
  const packagePermission = center.locator(".permission-map-row").filter({ has: page.getByText("CopilotPackages.ReadWrite.All", { exact: true }) });
  await expect(packagePermission).toContainText("Recommended signed-in administrator role: AI Administrator");
  await expect(packagePermission).toContainText("Global Administrator is a broader alternative");
  const packageRoles = packagePermission.locator(".permission-map-requirement strong");
  await expect(packageRoles).toHaveText(["AI Administrator", "Global Administrator"]);
  for (const role of await packageRoles.all()) await expect(role).toHaveCSS("font-weight", /[6-9]00|bold/);
  await expect(packagePermission).toContainText("not a confirmed exclusive API role requirement");
  await expect(packagePermission.getByRole("link", { name: "Agent-management roles" }))
    .toHaveAttribute("href", "https://learn.microsoft.com/en-us/microsoft-agent-365/admin/agent-roles-perms");
  await expect(packagePermission).toContainText("both application and delegated forms");
  await expect(packagePermission).toContainText("delegated work or school accounts only");
  await expect(packagePermission).toContainText("application form does not authorize these writes");
  await expect(packagePermission.getByRole("link", { name: "Permission definition" }))
    .toHaveAttribute("href", "https://learn.microsoft.com/en-us/graph/permissions-reference#copilotpackagesreadwriteall");
  const platform = center.locator(".permission-map-row").filter({ has: page.getByText("ResourceQuery.Resources.Read", { exact: true }) });
  await expect(platform).toContainText("ResourceQuery.Resources.Read");
  await expect(platform.locator(".permission-map-requirement")).toContainText("Recommended for read-only sync: AI Reader");
  await expect(platform.locator(".permission-map-requirement")).not.toContainText("Global Reader");
  await expect(platform.locator(".permission-map-alternatives")).toContainText("Global Reader");
  const readerSetup = platform.getByRole("region", { name: "Assign AI Reader to a viewer" });
  await expect(readerSetup).toContainText("Identity > Roles & admins > AI Reader");
  await expect(readerSetup).toContainText("AI Reader provides read-only inventory access");
  await expect(readerSetup.getByRole("listitem")).toHaveCount(3);
  await expect(readerSetup.getByRole("link", { name: "Role assignment instructions" })).toBeVisible();
  await expect(platform).toContainText("no application permission equivalent");
  const uploader = center.getByRole("article", { name: "Usage Report Uploader", exact: true });
  await expect(uploader).not.toHaveClass(/\bis-assigned\b/);
  await expect(uploader).toContainText("AgentControl.UsageReportUploader");
  await expect(uploader).toContainText("Published-report corrections, selection and deletion require Admin");
  await expect(center.getByRole("button", { name: /Request consent|Authorize|Grant admin consent/, includeHidden: true })).toHaveCount(0);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await packagePermission.screenshot({ path: info.outputPath("package-permission.png") });
  await center.getByRole("region", { name: "App-defined roles", exact: true }).screenshot({ path: info.outputPath("assigned-app-role.png") });
  await page.screenshot({ path: info.outputPath("permissions-overview.png"), fullPage: true });
  await center.getByRole("button", { name: "Check status", exact: true }).click();
  await expectQuietPermissions(page);
  expect(posts).toEqual(["/api/capabilities/check", "/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});

test("standard application reads are required references while deferred security stays hidden", async ({ page }, info) => {
  const { unexpected, posts } = await mockPermissions(page, permissions);
  await page.goto("/permissions");
  await expectQuietPermissions(page);
  const setup = page.getByRole("region", { name: "App registration permissions" });
  await expect(setup.getByRole("region", { name: "Microsoft Graph / Delegated", exact: true })).toBeVisible();
  await expect(setup.getByText("Optional application permissions", { exact: true })).toHaveCount(0);
  const application = setup.getByRole("region", { name: "Microsoft Graph / Application", exact: true });
  for (const permission of ["CopilotPackages.Read.All", "User.Read.All", "LicenseAssignment.Read.All", "Reports.Read.All"]) {
    await expect(application.getByText(permission, { exact: true })).toBeVisible();
  }
  await expect(setup.getByText(/AuditLogsQuery.Read.All|ThreatHunting.Read.All|AgentIdentity.Read.All/)).toHaveCount(0);
  await expect(setup.getByRole("link", { name: "Open app registration" })).toHaveAttribute("href", "https://entra.microsoft.com/");
  await expect(setup.locator("dt")).toHaveCount(11);
  await expect(setup.getByRole("button", { name: /Enable|Consent|Authorize/i, includeHidden: true })).toHaveCount(0);
  await expectQuietPermissions(page);
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  expect((await new AxeBuilder({ page }).include(".permission-registration").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-application-setup.png"), fullPage: true });
  expect(posts).toEqual(["/api/capabilities/check"]);
  expect(unexpected).toEqual([]);
});

for (const failing of [false, true]) {
  test(`all permission guidance remains readable at responsive boundaries (${failing ? "issue" : "healthy"})`, async ({ page }, info) => {
    const { unexpected } = await mockPermissions(page, () => permissions().map(view => !failing || view.definition.id !== "graph.package.read.application" ? view : {
      ...view, decision: { ...view.decision, status: "missing_permission", authorized: false,
        evidence: { category: "missing_permission", httpStatus: 403, correlationId: "responsive-request" } },
    }));
    await page.goto("/permissions");
    const center = page.locator(".permission-center");
    await expect(center).toHaveAttribute("aria-busy", "false");
    for (const width of [360, 600, 601, 738, 760, 761, 1024, 1440]) {
      await page.setViewportSize({ width, height: 876 });
      await expect(center.locator("details, summary, dialog, [aria-expanded]")).toHaveCount(0);
      await expect(center.locator(".permission-map-row")).toHaveCount(11);
      const measurements = await center.evaluate(element => ({
        overflow: element.scrollWidth > element.clientWidth + 1,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        headings: [...element.querySelectorAll("h3")].map(heading => {
          const style = getComputedStyle(heading);
          return { width: heading.getBoundingClientRect().width, lines: heading.getBoundingClientRect().height / parseFloat(style.lineHeight) };
        }),
        descriptions: [...element.querySelectorAll(".permission-map-row dd")].map(description => description.getBoundingClientRect().width),
        clipped: [...element.querySelectorAll(".permission-map-row, .permission-role-card, .permission-issue")].some(row => row.scrollWidth > row.clientWidth + 1),
      }));
      expect(measurements.overflow, `${width}px panel`).toBe(false);
      expect(measurements.pageOverflow, `${width}px page`).toBe(false);
      expect(measurements.clipped, `${width}px guidance`).toBe(false);
      for (const heading of measurements.headings) {
        expect(heading.width, `${width}px section heading`).toBeGreaterThanOrEqual(180);
        expect(heading.lines, `${width}px section heading lines`).toBeLessThanOrEqual(2.1);
      }
      for (const description of measurements.descriptions) expect(description, `${width}px permission usage`).toBeGreaterThanOrEqual(180);
      if (failing) await expect(center.getByText("responsive-request", { exact: true })).toBeVisible();
      if (width === 738 || width === 1440) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: info.outputPath(`permissions-${width}px.png`) });
        await center.getByRole("region", { name: "App-defined roles", exact: true }).screenshot({ path: info.outputPath(`permissions-roles-${width}px.png`) });
        await center.getByRole("region", { name: "Microsoft Graph / Application", exact: true }).screenshot({ path: info.outputPath(`permissions-graph-${width}px.png`) });
      }
    }
    expect(unexpected).toEqual([]);
  });
}

test("unchecked, stale, disabled, unregistered and app-role decisions are not issues", async ({ page }) => {
  const now = Date.now();
  const { unexpected } = await mockPermissions(page, () => permissions().map((view): CapabilityView => {
    const decision = { ...view.decision, status: "missing_permission" as const, authorized: false };
    switch (view.definition.id) {
      case "graph.package.read.application": return { ...view, decision: { ...decision, fresh: false } };
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
  await expect(page.getByText("App viewer", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
  expect(unexpected).toEqual([]);
});

test("fresh failures show all evidence inline with setup links and explicit recovery", async ({ page }, info) => {
  let recovered = false;
  const { unexpected, posts } = await mockPermissions(page, kind => {
    if (kind === "retry-failed") recovered = true;
    return permissions().map(view => {
      if (kind === "catalog" || recovered || view.definition.id !== "graph.package.read.application") return view;
      return { ...view, decision: {
        ...view.decision, status: "provider_error", authorized: false, verification: undefined,
        evidence: { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000, correlationId: "synthetic-timeout-request" },
        remediation: ["Retry the safe status check after checking connectivity."],
      } };
    });
  });
  await page.goto("/permissions");
  const issues = page.getByRole("region", { name: "Issues", exact: true });
  await expect(issues.getByRole("article")).toHaveCount(1);
  await expect(issues.getByText("Agent inventory", { exact: true })).toBeVisible();
  await expect(issues.getByText("Microsoft did not respond after retrying.", { exact: true })).toBeVisible();
  await expect(page.locator(".capability-health")).toHaveAccessibleName("Permissions");
  await expect(page.locator(".capability-health")).toHaveAccessibleDescription("Permissions: 1 issue");
  await expect(issues.getByText("Package catalog read", { exact: true })).toHaveCount(0);
  const issue = issues.getByRole("article", { name: "Agent inventory", exact: true });
  expect(await page.evaluate(collectLayoutFailures, { fields: [] })).toEqual([]);
  await page.screenshot({ path: info.outputPath("permissions-needs-attention.png"), fullPage: true });
  await expect(issue.getByRole("region", { name: "Required setup" })).toContainText("Microsoft Graph / application: CopilotPackages.Read.All");
  await expect(issue.getByRole("region", { name: "Setup and documentation" })).toBeVisible();
  await expect(issue.getByText("synthetic-timeout-request", { exact: true })).toBeVisible();
  await expect(issue.getByText("Retry the safe status check after checking connectivity.", { exact: true })).toBeVisible();
  await expect(issue.getByText("https://graph.microsoft.com", { exact: true })).toBeVisible();
  await expect(issue.getByText(/Grant admin consent/)).toHaveCount(0);
  await expect(page.locator(".permission-center").locator("details, summary, dialog, [aria-expanded]")).toHaveCount(0);
  const documentation = issue.getByRole("link", { name: "Entra admin center", exact: true });
  await documentation.focus();
  await page.keyboard.press("Tab");
  await expect(issue.getByRole("link", { name: "Microsoft admin center", exact: true })).toBeFocused();
  expect(await issue.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".permission-center").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
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
  const issue = page.getByRole("region", { name: "Issues", exact: true }).getByRole("article");
  await expect(issue).toHaveCount(1);
  await expect(issue.getByText("Copilot license sync", { exact: true })).toBeVisible();
  await expect(issue.getByText("Microsoft denied the required API permission.", { exact: true })).toBeVisible();
  await expect(issue.getByRole("link", { name: "Admin setup", exact: true })).toHaveAttribute("href", "https://entra.microsoft.com/");
  await expect(issue.getByText("synthetic-license-denial", { exact: true })).toBeVisible();
  await expect(issue.getByText("403", { exact: true })).toBeVisible();
  expect(await issue.textContent()).not.toMatch(/Ready to try|provider authorization not verified/i);
  expect(unexpected).toEqual([]);
});

test("a cached timeout stays quiet while the initial automatic retry is pending", async ({ page }) => {
  await watchPermissionWarnings(page);
  const { unexpected, posts } = await mockPermissions(page, () => permissions().map(view =>
    view.definition.id !== "graph.package.read.application" ? view : {
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
  const progressRequests: Array<{ query: string; startedAt: number }> = [];
  await page.route(url => url.pathname === "/api/capabilities/check", async route => {
    await held;
    return route.fulfill({ json: { value: permissions() } });
  });
  await page.route(url => url.pathname === "/api/capabilities/check-progress", route => {
    expect(route.request().method()).toBe("GET");
    progressRequests.push({ query: new URL(route.request().url()).search, startedAt: performance.now() });
    return route.fulfill({ json: { progress: { checks: [
      { capabilityId: "graph.package.read.application", state: completeInventory ? "complete" : "checking" },
      { capabilityId: "powerPlatform.quarantine.read", state: "complete" },
      { capabilityId: "powerPlatform.inventory.read", state: "checking" },
      { capabilityId: "defender.hunting.delegated", state: "complete" },
    ] } } });
  });
  try {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    const progress = page.getByRole("region", { name: "Permission check progress" });
    await expect(progress.getByRole("status")).toContainText("1 of 3 reviewed");
    await expect(progress.getByRole("progressbar")).toHaveAttribute("value", "1");
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
    await expect(progress.getByRole("status")).toContainText("2 of 3 reviewed");
    await expect(progress.getByText("Agent inventory", { exact: true })).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await spinner.evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    await expect(progress.getByText("Power Platform inventory", { exact: true })).toBeVisible();
  } finally { release(); }
  await expectQuietPermissions(page);
  await expect(page.getByRole("region", { name: "Permission check progress" })).toHaveCount(0);
  expect(progressRequests.length).toBeGreaterThanOrEqual(2);
  expect(progressRequests.every(request => request.query === "?retry=failed")).toBe(true);
  for (let index = 1; index < progressRequests.length; index++) {
    // Allow browser/runner clock precision, not extra polling within the one-second cadence.
    expect(progressRequests[index].startedAt - progressRequests[index - 1].startedAt).toBeGreaterThanOrEqual(950);
  }
  expect(posts).toEqual(["/api/capabilities/check", "/api/capabilities/check?retry=failed"]);
  expect(unexpected).toEqual([]);
});
