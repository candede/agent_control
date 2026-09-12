import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { statusLabels } from "../src/capabilityState";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import type { CapabilityView, QuarantineTargetPage } from "../src/api/client";

const primaryCapabilityCount = capabilityDefinitions.filter(definition => definition.probe.adapterRegistered && definition.mode !== "application").length;

async function login(page: Page, scenario: string) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(`/permissions?fixture=${scenario}`)}`);
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(primaryCapabilityCount);
}
function savedPackagePage(observedAt: string, expiresAt: string) {
  return {
    value: [{ id: "synthetic-package", displayName: "Synthetic package", isBlocked: false, availableTo: "some", deployedTo: "none", sourceSystem: "graph_packages", authoringTool: null, creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {}, observation: { observedAt, expiresAt, scopeKind: "broad", source: "Microsoft Graph package catalog", apiMaturity: "v1.0 read; preview controls" } }],
    count: 1,
    summary: { total: 1, allowed: 1, blocked: 0 },
    filteredSummary: { total: 1, allowed: 1, blocked: 0 },
    facets: { publishers: [], availability: [{ value: "available:some", label: "Some" }], hosts: [], platforms: [] },
    snapshot: { id: "44444444-4444-4444-4444-444444444444", tokenMode: "delegated", requestedIds: [], observedCount: 1, totalRecords: 1, pageCount: 1, observedAt, expiresAt, scopeKind: "broad" },
  };
}
test.beforeEach(async ({ context }) => {
  await context.route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => route.abort());
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("consented Admin permissions do not ask for consent until a token check reports it missing", async ({ page }) => {
  let missingConsent = false;
  const posts: string[] = [];
  function views(): CapabilityView[] {
    return capabilityDefinitions.filter(definition => definition.probe.adapterRegistered && definition.mode !== "application").map(definition => {
      const missing = missingConsent && definition.id === "graph.package.block.manage";
      const providerRead = ["graph.package.read.delegated", "graph.directory.read", "powerPlatform.inventory.read"].includes(definition.id);
      return { definition, decision: {
        capabilityId: definition.id, status: missing ? "missing_permission" : "available", authorized: !missing, fresh: true,
        verification: missing ? undefined : definition.mode === "local" ? "local" : providerRead ? "provider" : "token",
        ...(definition.mode === "local" ? {} : {
          checkedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        ...(missing ? { evidence: { category: "missing_permission", phase: "token_acquisition" } } : {}),
        previewQualification: "not_required", remediation: [],
      } };
    });
  }
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") posts.push(path);
    if (path === "/api/me") return route.fulfill({ json: {
      user: { displayName: "Synthetic administrator", username: "fixture@example.invalid", homeAccountId: "consent-fixture", roles: ["AgentControl.Admin"] },
      csrfToken: "synthetic-csrf", roleAssignmentRequired: false,
    } });
    if (path === "/api/workbench/metadata") return route.fulfill({ json: { views: workbenchViews, actions: workbenchActions } });
    if (path === "/api/capabilities" || path === "/api/capabilities/check") return route.fulfill({ json: { value: views() } });
    if (path === "/api/agents") return route.fulfill({ json: savedPackagePage(new Date().toISOString(), new Date(Date.now() + 300_000).toISOString()) });
    return route.fulfill({ json: { value: [] } });
  });
  await page.goto("/permissions");
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  await expect(page.getByRole("button", { name: "3 provider-verified / 1 local / 6 ready to try / 0 degraded / 0 blocked" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request consent", exact: true })).toHaveCount(0);
  const packageRow = page.getByRole("article", { name: "Package block management" });
  await expect(packageRow.getByText("Token acquired; provider authorization not verified", { exact: true })).toBeVisible();
  await expect(packageRow.getByRole("link", { name: "Open Agents" })).toBeVisible();
  missingConsent = true;
  await check.click();
  await expect(packageRow.getByRole("button", { name: "Request consent", exact: true })).toBeVisible();
  await expect(packageRow.getByText("Missing app permission", { exact: true })).toBeVisible();
  missingConsent = false;
  await check.click();
  await expect(packageRow.getByRole("button", { name: "Request consent", exact: true })).toHaveCount(0);
  await expect(packageRow.getByText("Token acquired; provider authorization not verified", { exact: true })).toBeVisible();
  expect(posts.length).toBeGreaterThanOrEqual(3);
  expect(posts.every(path => path === "/api/capabilities/check")).toBe(true);
});

test("primary navigation uses the full header width at every screen size", async ({ page }, info) => {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: {
      user: { displayName: "Synthetic navigation validation account", username: "fixture@example.invalid", homeAccountId: "navigation-fixture", roles: ["AgentControl.Admin"] },
      csrfToken: "synthetic-csrf", roleAssignmentRequired: false,
    } });
    if (path === "/api/workbench/metadata") return route.fulfill({ json: { views: workbenchViews, actions: workbenchActions } });
    if (path === "/api/agents") return route.fulfill({ json: savedPackagePage(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()) });
    return route.fulfill({ json: { value: [] } });
  });
  await page.goto("/permissions");
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await expect(navigation.getByRole("button")).toHaveCount(8);
  const originalViewport = page.viewportSize()!;
  for (const width of [originalViewport.width, 768, 1024, 1920]) {
    await page.setViewportSize({ ...originalViewport, width });
    const header = await page.locator(".top-bar").boundingBox();
    const bounds = await navigation.boundingBox();
    expect(bounds!.x).toBeCloseTo(header!.x, 1);
    expect(bounds!.width).toBeCloseTo(header!.width, 1);
    for (const button of await navigation.getByRole("button").all()) {
      const buttonBounds = await button.boundingBox();
      expect(buttonBounds!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.setViewportSize(originalViewport);
  expect((await new AxeBuilder({ page }).include(".top-bar").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("full-width-navigation.png") });
});

test("first Agents visit loads the catalog and access editing loads current details without a write", async ({ page }, info) => {
  const refreshes: string[] = [];
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/api/agents/") && path.endsWith("/refresh-jobs")) refreshes.push(path);
    if (["POST", "PATCH"].includes(request.method()) && /\/api\/agents\/[^/]+\/(access|block|unblock)$/.test(path)) writes.push(path);
  });
  await login(page, `first-agent-visit-${info.project.name}`);
  expect(refreshes).toEqual([]);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  expect(refreshes.filter(path => path === "/api/agents/refresh-jobs")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Block Synthetic package", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Manage access for Synthetic package", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor).toBeVisible();
  expect(refreshes.filter(path => path === "/api/agents/synthetic-package/refresh-jobs")).toHaveLength(1);
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  expect(refreshes.filter(path => path === "/api/agents/refresh-jobs")).toHaveLength(1);
  expect(writes).toEqual([]);
});

test("timeout recovery retries failed checks while keeping changes ready to try", async ({ page }, info) => {
  const now = Date.now();
  let recovered = false;
  const requests: string[] = [];
  const unexpected: string[] = [];
  const views = (): CapabilityView[] => capabilityDefinitions.map(definition => {
    const onDemand = definition.probe.kind === "on_demand";
    const disabled = definition.mode === "application";
    const timedOut = definition.id === "graph.package.read.delegated" && !recovered;
    const status = disabled ? "not_configured" : timedOut ? "provider_error" : "available";
    return {
      definition, enabled: !disabled,
      ...(disabled ? { configuration: { enabled: false, sharedDataScope: false } } : {}),
      decision: {
        capabilityId: definition.id, status, authorized: status === "available", fresh: true,
        verification: status !== "available" ? undefined : onDemand ? "on_demand" : definition.mode === "local" ? "local"
          : definition.probe.kind === "live_qualification" || definition.id.startsWith("powerPlatform.quarantine.") ? "token" : "provider",
        ...(!onDemand ? { checkedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 300_000).toISOString() } : {}),
        previewQualification: "not_required",
        ...(timedOut ? { evidence: { category: "provider_timeout", phase: "provider_read", timeoutMs: 30_000 } } : {}),
        remediation: [],
      },
    };
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname === "/api/me") return route.fulfill({ json: {
      user: { displayName: "Synthetic validation account", username: "fixture@example.invalid", homeAccountId: "fixture", roles: ["AgentControl.Admin"] },
      csrfToken: "synthetic-csrf", roleAssignmentRequired: false,
    } });
    if (url.pathname === "/api/auth/status") return route.fulfill({ json: { authConfigured: true, callback: `${url.origin}/api/auth/callback` } });
    if (url.pathname === "/api/workbench/metadata") return route.fulfill({ json: { views: workbenchViews, actions: workbenchActions } });
    if (route.request().method() === "GET" && url.pathname === "/api/agents") {
      return route.fulfill({ json: savedPackagePage(new Date(now).toISOString(), new Date(now + 300_000).toISOString()) });
    }
    if (route.request().method() === "GET" && ["/api/official-usage/aggregate", "/api/official-usage/users"].includes(url.pathname)) {
      return route.fulfill({ json: {} });
    }
    if (url.pathname === "/api/capabilities" || url.pathname === "/api/capabilities/check") {
      if (url.searchParams.get("retry") === "failed") recovered = true;
      return route.fulfill({ json: { value: views() } });
    }
    unexpected.push(url.pathname);
    return route.fulfill({ status: 404, json: { code: "unexpected_fixture_request" } });
  });
  await page.goto("/permissions");
  const catalog = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Package catalog read", exact: true }) });
  await expect(catalog.getByText("Check timed out", { exact: true })).toBeVisible();
  await expect(catalog.getByText(/bounded provider check timed out after 30 seconds/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Audit", exact: true })).toHaveAttribute("href", "/audit");
  await expect(page.getByRole("link", { name: "Open Security", exact: true })).toHaveAttribute("href", "/security");
  await expect(page.getByRole("link", { name: "Open Agents", exact: true }).first()).toHaveAttribute("href", "/agents");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(catalog.locator(".capability-status")).toHaveText("Available");
  expect(requests.filter(path => path === "/api/capabilities/check?retry=failed")).toHaveLength(1);
  const block = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Package block management", exact: true }) });
  await expect(block.locator(".capability-status")).toHaveText("Ready to try");
  expect(unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("permission-timeout-recovery.png") });
});

for (const [status, label] of Object.entries(statusLabels)) {
  test(`${status}: readable, responsive, accessible`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const roleDenied = status === "missing_internal_role";
    await login(page, roleDenied ? "role-Viewer" : status);
    const row = page.getByRole("article").filter({ has: page.getByRole("heading", {
      name: roleDenied ? "Package block management" : "Package catalog read",
      exact: true,
    }) });
    await expect(row.locator(".capability-status")).toHaveText(label);
    await expect(row.getByText(
      roleDenied ? "delegated: CopilotPackages.ReadWrite.All" : "delegated: CopilotPackages.Read.All",
      { exact: true },
    )).toBeVisible();
    await expect(row.getByText("https://graph.microsoft.com", { exact: true })).toBeVisible();
    const inventory = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Power Platform inventory", exact: true }) });
    await expect(inventory.getByText("delegated: ResourceQuery.Resources.Read", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/evidence/permissions-${status}-${info.project.name}.png` });
    await row.screenshot({ path: `/evidence/permission-row-${status}-${info.project.name}.png` });
  });
}
test("automatic checks, safe consent cancellation, panels and focus return", async ({ page }) => {
  let checks = 0;
  let legacyProbes = 0;
  const unexpectedProviderWorkloads: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/capabilities/check") checks += 1;
    if (path.endsWith("/probe")) legacyProbes += 1;
    if (request.method() === "POST" && [
      "/api/purview/audit/jobs",
      "/api/hunting/jobs",
      "/api/agents/refresh-jobs",
      "/api/reports/imports",
    ].includes(path)) unexpectedProviderWorkloads.push(path);
  });
  await login(page, "stale");
  const row = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Package catalog read", exact: true }) });
  await expect(row.locator(".capability-status")).toHaveText("Available");
  expect(checks).toBe(1);
  expect(legacyProbes).toBe(0);
  expect(unexpectedProviderWorkloads).toEqual([]);
  const summary = row.locator("summary"); await summary.focus(); await page.keyboard.press("Enter");
  await expect(row.locator("details")).toHaveAttribute("open", "");
  const setup = row.getByRole("button", { name: "Setup instructions" }); await setup.click();
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); await expect(setup).toBeFocused();
  await expect(row.getByRole("button", { name: "Request consent" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, "missing_delegated_grant");
  const missingRow = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Package catalog read", exact: true }) });
  await missingRow.getByRole("button", { name: "Request consent" }).click();
  await expect(page.getByRole("status")).toContainText("Consent was cancelled or denied");
  await expect(page.getByText("never-render-provider-text")).toHaveCount(0);
  expect(legacyProbes).toBe(0);
  expect(unexpectedProviderWorkloads).toEqual([]);
});
test("Viewer retains saved catalog access during stale read evidence", async ({ page }) => {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await page.route(url => url.pathname === "/api/agents", route => route.fulfill({ json: savedPackagePage(now, expiresAt) }));
  await page.route(url => url.pathname === "/api/capabilities/check", async route => {
    const response = await route.fetch();
    const body = await response.json() as { value: Array<{ definition: { id: string }; decision: Record<string, unknown> }> };
    await route.fulfill({ json: { ...body, value: body.value.map(view => view.definition.id === "graph.package.read.delegated" ? {
      ...view,
      decision: {
        ...view.decision,
        status: "unknown",
        authorized: false,
        fresh: false,
        checkedAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        verification: "provider",
      },
    } : view) } });
  });
  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Block Synthetic package", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.getByText("Unknown / stale evidence")).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh agents", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export filtered agents CSV", exact: true })).toBeEnabled();
  const result = await page.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    const response = await fetch("/api/agents/synthetic-package/block", { method: "POST", headers: { "X-CSRF-Token": me.csrfToken } });
    return { status: response.status, body: await response.json() };
  });
  expect(result).toMatchObject({ status: 403, body: { code: "missing_internal_role" } });
});
test("job deep links keep exact source identity and browser history without provider sends", async ({ page }) => {
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const olderId = "11111111-1111-4111-8111-111111111111";
  const latestId = "22222222-2222-4222-8222-222222222222";
  const providerSends: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/agents/refresh-jobs") providerSends.push(url.pathname);
  });
  await page.route(url => url.pathname === "/api/workbench/jobs", route => route.fulfill({ json: {
    value: [
      { id: latestId, source: "package-refresh", label: "Latest refresh", target: "Current principal Graph package catalog",
        status: "succeeded", total: 9, completed: 9, partial: false, canResume: false, canCancel: false, canReconcile: false,
        updatedAt: "2026-09-10T08:00:00.000Z", href: `/agents?refreshJob=${latestId}` },
      { id: olderId, source: "package-refresh", label: "Older refresh", target: "Current principal Graph package catalog",
        status: "succeeded", total: 3, completed: 3, partial: false, canResume: false, canCancel: false, canReconcile: false,
        updatedAt: "2026-09-10T07:00:00.000Z", href: `/agents?refreshJob=${olderId}` },
    ],
    unavailableSources: [], polledAt: "2026-09-10T08:00:00.000Z", requestId: "browser-job-request",
  } }));
  await page.route(url => url.pathname === "/api/agents", route => route.fulfill({ json: savedPackagePage(observedAt, expiresAt) }));
  await page.route(url => url.pathname.startsWith("/api/agents/refresh-jobs/"), route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    if (id === "forbidden") {
      return route.fulfill({ status: 404, contentType: "application/problem+json", json: {
        type: "about:blank", status: 404, code: "job_not_found", detail: "Refresh job not found.", requestId: "forbidden-request",
      } });
    }
    return route.fulfill({ json: {
      id, authorizationPrincipalId: "fixture-principal", tokenMode: "delegated", scopeKind: "broad", requestedIds: [],
      status: "succeeded", pageCount: 1, observedCount: id === olderId ? 3 : 9, totalRecords: id === olderId ? 3 : 9,
      snapshotId: "44444444-4444-4444-4444-444444444444", createdAt: "2026-09-10T07:00:00.000Z",
      attemptedAt: "2026-09-10T07:00:00.000Z", updatedAt: "2026-09-10T07:00:01.000Z", finishedAt: "2026-09-10T07:00:01.000Z",
    } });
  });

  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("article").filter({ hasText: "Older refresh" }).getByRole("link", { name: "Open source view" }).click();
  await expect(page).toHaveURL(new RegExp(`refreshJob=${olderId}`));
  await expect(page.getByRole("region", { name: "Selected package refresh job" })).toContainText("3 of 3 packages observed");
  expect(providerSends).toEqual([]);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Jobs", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("region", { name: "Selected package refresh job" })).toContainText("3 of 3 packages observed");

  await page.goto("/agents?refreshJob=forbidden");
  await expect(page.getByRole("alert")).toContainText("exact package refresh job is expired, deleted, or unavailable to this account");
  await expect(page.getByRole("region", { name: "Selected package refresh job" })).toHaveCount(0);
  expect(providerSends).toEqual([]);
});
test("package preview is responsive and cancellation dispatches no write", async ({ page }) => {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let previews = 0;
  let writes = 0;
  await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: {
      ...body,
      value: body.value.map((view: { definition: { id: string }; decision: object }) => view.definition.id === "graph.package.block.manage" ? {
        ...view,
        decision: { capabilityId: view.definition.id, status: "available", authorized: true, fresh: true, verification: "on_demand", previewQualification: "not_required", remediation: [] },
      } : view),
    } });
  });
  await page.route(url => url.pathname === "/api/agents", route => route.fulfill({ json: savedPackagePage(now, expiresAt) }));
  await page.route(url => url.pathname === "/api/agents/mutation-preview", route => {
    previews += 1;
    return route.fulfill({ json: {
      confirmationHash: "a".repeat(64),
      summary: {
        risk: true,
        operation: "block", provider: "Microsoft Graph", endpoint: "POST /beta/copilot/admin/catalog/packages/{id}/block", apiMaturity: "preview", permission: "Delegated CopilotPackages.ReadWrite.All",
        actor: { id: "fixture-available", displayName: "Synthetic account", username: "fixture@example.invalid" }, scope: "single", targetCount: 1, affectedPrincipalCount: 1,
        rollback: "Possible through a separately confirmed inverse operation after provider readback.", targetSelectionHash: "b".repeat(64),
        targets: [{ id: "synthetic-package", displayName: "Synthetic package", currentState: { kind: "block", isBlocked: false }, requestedState: { kind: "block", isBlocked: true } }], additionalTargetCount: 0,
      },
    } });
  });
  await page.route(url => url.pathname === "/api/agents/synthetic-package/block", route => { writes += 1; return route.fulfill({ status: 500 }); });

  await login(page, "available");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Block Synthetic package", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Block package?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Preview write risk", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Delegated CopilotPackages.ReadWrite.All", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Current:/)).toContainText('"isBlocked":false');
  await expect(dialog.getByText(/Requested:/)).toContainText('"isBlocked":true');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/evidence/package-confirmation-${test.info().project.name}.png`, fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(previews).toBe(1);
  expect(writes).toBe(0);
});
test("saved inventory navigation does not scan and explicit refresh is the only provider command", async ({ page }) => {
  const now = new Date().toISOString();
  const snapshot = { id: "22222222-2222-2222-2222-222222222222", roleScope: "ai", environmentScope: "environment-a", requestedTypes: ["microsoft.copilotstudio/agents"], coverage: [], observedCount: 1, totalRecords: 1, pageCount: 1, unknownFieldCount: 2, observedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const resourcePage = {
    value: [{ tenantId: "11111111-1111-1111-1111-111111111111", nativeId: "agent-builder-a", type: "microsoft.copilotstudio/agents", location: null, displayName: "Support intake", environmentId: "environment-a", createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: "Microsoft 365 Copilot Agent Builder", creatorType: "unknown", agentKind: "agent_builder_agent", lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [{ kind: "entra_agent_id", value: "agent-builder-a" }], provenance: { authoringTool: { sourceSystem: "power_platform", path: "properties.createdIn", maturity: "preview" }, connectors: { sourceSystem: "power_platform", path: "properties.capabilities.connectors", maturity: "preview" } }, details: { capabilityDetailsTruncated: true, connectorDetailsStatus: "partial", distinctPowerPlatformConnectors: 3, connectors: [{ connectorId: "shared_office365users", operations: [{ operationId: "SearchUser", displayName: "Search user", method: "GET", usedAs: "action", isEnabled: true, requiresEndUserConsent: false }] }] }, unknownFieldCount: 1 }],
    count: 1,
    typeCounts: [{ type: "microsoft.copilotstudio/agents", status: "covered", count: 1 }, { type: "microsoft.powerapps/canvasapps", status: "not_authorized_scope", count: null }, { type: "microsoft.powerapps/codeapps", status: "unknown", count: null }],
    snapshot,
  };
  const waitingJob = { id: "11111111-1111-1111-1111-111111111111", status: "waiting_authorization", roleScope: "ai", environmentScope: "environment-a", requestedTypes: ["microsoft.copilotstudio/agents"], pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null, createdAt: now, attemptedAt: now, updatedAt: now, finishedAt: null };
  const refreshBodies: unknown[] = [];
  await page.route(url => url.pathname.startsWith("/api/inventory/"), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/related")) return route.fulfill({ json: {
      source: "power_platform", nativeId: "agent-builder-a", resourceType: "microsoft.copilotstudio/agents",
      environmentId: "environment-a", snapshotId: snapshot.id, observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt,
      identifiers: resourcePage.value[0].identifiers,
      package: { status: "unmatched", reason: "current provider schemas document no cross-source package identifier relation" },
      reports: { status: "unmatched", reason: "official report identifiers are report-only and cannot be joined" },
      audit: { status: "available", count: 0, value: [] },
      security: { status: "available", count: 0, value: [] },
      controls: { quarantineTarget: null, packageTarget: null },
    } });
    if (path === "/api/inventory/resources") return route.fulfill({ json: resourcePage });
    if (path === "/api/inventory/snapshots") return route.fulfill({ json: { value: [snapshot] } });
    if (path === "/api/inventory/refresh-jobs" && route.request().method() === "GET") return route.fulfill({ json: { value: [waitingJob], lastAttemptAt: now, lastSuccessAt: snapshot.observedAt } });
    if (path === "/api/inventory/refresh-jobs" && route.request().method() === "POST") { refreshBodies.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: waitingJob }); }
    if (path.endsWith("/resume")) return route.fulfill({ status: 202, json: { ...waitingJob, status: "running" } });
    return route.fulfill({ status: 404, json: { error: { code: "fixture_route", message: path } } });
  });
  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Power Platform", exact: true }).click();
  await expect(page.getByRole("region", { name: "Power Platform inventory explorer" })).toBeVisible();
  await expect(page.getByText("Support intake", { exact: true })).toBeVisible();
  await expect(page.getByText("Not authorized", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Resource type coverage").getByText("Unknown", { exact: true })).toBeVisible();
  await expect(page.getByText(/Unknown fields omitted: 2/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume with current authorization/ })).toBeVisible();
  expect(refreshBodies).toEqual([]);
  const detailsTrigger = page.getByRole("button", { name: "View details for Support intake" });
  await detailsTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Support intake" });
  await expect(dialog).toBeVisible();
  const identityTab = dialog.getByRole("tab", { name: "Identity" });
  const powerPlatformTab = dialog.getByRole("tab", { name: "Power Platform" });
  await expect(identityTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(powerPlatformTab).toBeFocused();
  await expect(powerPlatformTab).toHaveAttribute("aria-selected", "true");
  expect(await dialog.getByText("Preview", { exact: true }).count()).toBeGreaterThanOrEqual(1);
  await expect(dialog.getByText(/Capability details are partial/)).toBeVisible();
  await dialog.getByRole("tab", { name: "Package" }).click();
  await expect(dialog.getByText(/current provider schemas document no cross-source/)).toBeVisible();
  await dialog.getByRole("tab", { name: "Audit" }).click();
  await expect(dialog.getByText(/Authorized and queried; no exact associated records/)).toBeVisible();
  await dialog.getByRole("tab", { name: "Power Platform" }).click();
  await expect(dialog.getByText("Search user", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/GET · action/)).toBeVisible();
  await expect(page).toHaveURL(/detail=agent-builder-a/);
  const detailUrl = page.url();
  for (let index = 0; index < 4; index += 1) { await page.keyboard.press("Tab"); expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(detailsTrigger).toBeFocused();
  await page.goto("/jobs");
  await page.goto(detailUrl);
  await expect(page.getByRole("dialog", { name: "Support intake" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Power Platform" })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page).toHaveURL(/\/jobs$/);
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "Support intake" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Refresh resource scope").selectOption("microsoft.copilotstudio/agents");
  await page.getByLabel("Refresh environment scope").fill("environment-b");
  await page.getByRole("button", { name: /Refresh selected scope/ }).click();
  await expect.poll(() => refreshBodies).toEqual([{ types: ["microsoft.copilotstudio/agents"], environmentId: "environment-b" }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/evidence/inventory-${test.info().project.name}.png`, fullPage: true });
});
test("quarantine uses real policy, exact saved targets, confirmation and verified fixture write", async ({ page }, testInfo) => {
  const quarantineRequests: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/quarantine/")) quarantineRequests.push(`${request.method()} ${url.pathname}`); });
  await login(page, "role-Admin");
  const targets = await (await page.request.get("/api/quarantine/targets")).json() as QuarantineTargetPage;
  const firstName = targets.value.find(target => target.botId === "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")!.displayName!;
  const secondName = targets.value.find(target => target.botId === "cccccccc-cccc-cccc-cccc-cccccccccccc")!.displayName!;
  await page.getByRole("button", { name: "Power Platform", exact: true }).click();
  await expect(page.getByRole("region", { name: "Power Platform inventory explorer" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Select ${firstName} for quarantine control` })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Select ${secondName} for quarantine control` })).toBeVisible();
  expect(quarantineRequests.filter(value => value.includes("/status"))).toEqual([]);

  await page.getByRole("checkbox", { name: `Select ${secondName} for quarantine control` }).check();
  await page.getByRole("button", { name: "Quarantine selected" }).click();
  const confirmation = page.getByRole("dialog", { name: "Quarantine 1 agent" });
  await expect(confirmation.getByText("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa / cccccccc-cccc-cccc-cccc-cccccccccccc", { exact: true })).toBeVisible();
  await expect(confirmation.getByRole("checkbox")).toBeEnabled();
  await expect(confirmation.getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
  await confirmation.getByRole("checkbox").check();
  await expect(confirmation.getByRole("button", { name: "Confirm quarantine" })).toBeEnabled();
  expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".quarantine-confirmation").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: `/evidence/quarantine-confirmation-${testInfo.project.name}.png`, fullPage: true });
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Power Platform", exact: true }).click();
  await expect(page.getByRole("region", { name: "Power Platform inventory explorer" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Copilot Studio quarantine target picker" })).toHaveCount(0);
  expect(quarantineRequests.filter(value => value === "POST /api/quarantine/jobs")).toHaveLength(0);
  await login(page, "role-Admin");
  await page.getByRole("button", { name: "Power Platform", exact: true }).click();
  await expect(page.getByRole("region", { name: "Power Platform inventory explorer" })).toBeVisible();

  if (testInfo.project.name === "desktop") {
    await page.getByRole("checkbox", { name: `Select ${firstName} for quarantine control` }).check();
    await page.getByRole("button", { name: "Quarantine selected" }).click();
    const targetConfirmation = page.getByRole("dialog", { name: "Quarantine 1 agent" });
    await expect(targetConfirmation.getByText("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa / bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { exact: true })).toBeVisible();
    await targetConfirmation.getByRole("checkbox").check();
    await targetConfirmation.getByRole("button", { name: "Confirm quarantine" }).click();
    await expect(page.getByText("Quarantine job: Succeeded", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/1 of 1 complete · 1 verified/)).toBeVisible();
  } else {
    await expect(page.getByText("Quarantine job: Succeeded", { exact: true })).toBeVisible();
  }

  let failDirectStatus = true;
  await page.route(url => url.pathname === "/api/quarantine/status", route => {
    if (failDirectStatus) {
      failDirectStatus = false;
      return route.fulfill({ status: 503, contentType: "application/problem+json", json: { type: "https://agent-control.invalid/problems/provider_error", title: "Service unavailable", status: 503, code: "provider_error", detail: "Synthetic direct status outage.", requestId: "browser-fixture" } });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: `View details for ${firstName}` }).click();
  const directStatusDialog = page.getByRole("dialog", { name: firstName });
  await directStatusDialog.getByRole("tab", { name: "Controls" }).click();
  await expect(page.getByText("Not checked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check direct status" }).click();
  await expect(page.getByRole("alert")).toContainText("Direct status unavailable: Synthetic direct status outage.");
  await page.getByRole("button", { name: "Check direct status" }).click();
  await expect(page.getByText("Quarantined", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Direct and inventory states disagree.", { exact: true })).toBeVisible();
  expect(quarantineRequests.filter(value => value === "POST /api/quarantine/jobs")).toHaveLength(testInfo.project.name === "desktop" ? 1 : 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/evidence/quarantine-controls-${test.info().project.name}.png`, fullPage: true });
});
test("saved inventory remains readable during provider outage without a refresh", async ({ page }) => {
  let writes = 0;
  const now = new Date().toISOString();
  const snapshot = { id: "33333333-3333-3333-3333-333333333333", roleScope: "full", environmentScope: null, requestedTypes: ["microsoft.powerplatform/environments"], coverage: [], observedCount: 1, totalRecords: 1, pageCount: 1, unknownFieldCount: 0, observedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  await page.route(url => url.pathname.startsWith("/api/inventory/"), route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") { writes += 1; return route.fulfill({ status: 503, json: { error: { code: "provider_error", message: "Synthetic outage" } } }); }
    if (path === "/api/inventory/resources") return route.fulfill({ json: { value: [{ tenantId: "11111111-1111-1111-1111-111111111111", nativeId: "environment-saved", type: "microsoft.powerplatform/environments", location: "unitedstates", displayName: "Saved environment", environmentId: "environment-saved", createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "not_applicable", lifecycle: "not_applicable", identityConfidence: "exact_native", identifiers: [{ kind: "environment_id", value: "environment-saved" }], provenance: {}, details: { environmentType: "Production" }, unknownFieldCount: 0 }], count: 1, typeCounts: [{ type: "microsoft.powerplatform/environments", status: "covered", count: 1 }], snapshot } });
    if (path === "/api/inventory/snapshots") return route.fulfill({ json: { value: [snapshot] } });
    return route.fulfill({ json: { value: [], lastAttemptAt: now, lastSuccessAt: now } });
  });
  await login(page, "provider_error");
  await page.getByRole("button", { name: "Power Platform", exact: true }).click();
  await expect(page.getByText("Saved environment", { exact: true })).toBeVisible();
  await expect(page.getByText(/Authorized saved data remains available during provider outages/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Refresh selected scope/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export filtered inventory CSV" })).toBeEnabled();
  expect(writes).toBe(0);
});
test("two-role hierarchy, private evidence, and saved audit during outage", async ({ page, browser }) => {
  let broadAgentReads = 0;
  await page.route(url => url.pathname === "/api/agents/synthetic-package", route => route.fulfill({ json: {
    id: "synthetic-package", displayName: "Synthetic package", isBlocked: false, sourceSystem: "graph_packages",
    authoringTool: null, creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown",
    identityConfidence: "exact_native", provenance: {}, allowedUsersAndGroups: [], acquireUsersAndGroups: [],
  } }));
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/agents") broadAgentReads += 1;
  });
  await login(page, "role-Admin");
  for (const view of ["Agents", "Power Platform", "Users", "Official usage", "Audit", "Security", "Jobs"]) {
    await expect(page.getByRole("button", { name: view, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose CSVs", exact: true })).toBeEnabled();
  await login(page, "role-Viewer");
  for (const view of ["Agents", "Power Platform", "Users", "Official usage", "Audit", "Security", "Jobs"]) {
    await expect(page.getByRole("button", { name: view, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose CSVs", exact: true })).toHaveCount(0);
  const beforeViewerView = broadAgentReads;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  expect(broadAgentReads).toBe(beforeViewerView);
  await expect(page.getByRole("button", { name: /^Block / })).toHaveCount(0);
  await login(page, "provider_error");
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Audit log", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch("/api/audit/events")).status)).toBe(200);
  const other = await browser.newContext(); const otherPage = await other.newPage();
  await otherPage.route(url => url.pathname === "/api/capabilities/check", route => route.fulfill({ status: 503, json: { code: "provider_error" } }));
  await otherPage.goto("http://localhost:3001/api/auth/login?returnTo=" + encodeURIComponent("/permissions?fixture=unprobed-principal"));
  await expect(otherPage.getByRole("article").first().locator(".capability-status")).toHaveText("Unknown");
  await other.close();
});
test("all canonical workbench routes are deep-linkable and preserve agent state through history", async ({ page }, testInfo) => {
  const now = new Date().toISOString();
  await page.route(url => url.pathname === "/api/agents", route => route.fulfill({ json: savedPackagePage(now, new Date(Date.now() + 60_000).toISOString()) }));
  await login(page, "available");
  const routes = [
    ["/agents", "Agents"],
    ["/power-platform", "Power Platform"],
    ["/users", "Users"],
    ["/official-usage", "Official usage"],
    ["/audit", "Audit"],
    ["/security", "Security"],
    ["/permissions", "Permissions"],
    ["/jobs", "Jobs"],
  ] as const;
  for (const [path, label] of routes) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }

  await page.goto("/agents?q=synthetic&status=allowed&selected=synthetic-package");
  await expect(page.getByPlaceholder("Name, publisher, ID, ref")).toHaveValue("synthetic");
  await expect(page.getByRole("checkbox", { name: /Select Synthetic package/ })).toBeChecked();
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page).toHaveURL(/\/jobs$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/agents\?q=synthetic&status=allowed&selected=synthetic-package$/);
  await expect(page.getByPlaceholder("Name, publisher, ID, ref")).toHaveValue("synthetic");

  await page.goto("/audit?q=saved-actor&action=block&status=failed");
  await expect(page.getByLabel("Search")).toHaveValue("saved-actor");
  await expect(page.getByRole("combobox", { name: "Action", exact: true })).toHaveValue("block");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/\/audit\?.*q=saved-actor/);
  await expect(page.getByLabel("Result")).toHaveValue("failed");

  await page.goto("/official-usage?window=90");
  await expect(page.getByLabel("Active in last")).toHaveValue("90");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page).toHaveURL(/\/official-usage\?window=90$/);
  await expect(page.getByLabel("Active in last")).toHaveValue("90");

  await page.goto("/security?template=agent_activity&operation=InvokeAgent&agentIds=saved-agent");
  await expect(page.getByLabel("Fixed template")).toHaveValue("agent_activity");
  await expect(page.getByLabel("Agent IDs")).toHaveValue("saved-agent");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/security\?.*template=agent_activity/);
  await expect(page.getByLabel("Agent IDs")).toHaveValue("saved-agent");

  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `/evidence/workbench-routes-${testInfo.project.name}.png`, fullPage: true });
});
test("Purview audit remains separate, explicit, partial-aware, and content-free", async ({ page }) => {
  const jobId = "77777777-7777-4777-8777-777777777777";
  const filters = {
    presetId: "copilot_interactions",
    operations: ["CopilotInteraction"],
    startDateTime: "2026-09-08T12:00:00.000Z",
    endDateTime: "2026-09-08T13:00:00.000Z",
    userPrincipalNames: [],
    ipAddresses: [],
    objectIds: [],
    administrativeUnitIds: [],
  };
  const job = {
    id: jobId,
    authorizationPrincipalId: "fixture-role-Viewer",
    resultScope: { kind: "principal", scopeId: "fixture-role-Viewer", configurationRevision: null },
    tokenMode: "delegated",
    status: "partial",
    filters,
    displayName: "agent-control:fixture-role-Viewer:browser",
    providerQueryId: "provider-query-browser",
    providerStatus: "succeeded",
    localRequestId: "provider-correlation-browser",
    providerRequestId: "provider-request-browser",
    projectionVersion: 1,
    providerRequestCount: 12,
    activationCount: 2,
    pageCount: 20,
    providerRowCount: 5_001,
    storedRowCount: 1,
    byteCount: 2_048,
    unknownFieldCount: 4,
    pageComplete: false,
    observedRange: { startDateTime: filters.startDateTime, endDateTime: "2026-09-08T12:45:00.000Z" },
    unobservedRange: { startDateTime: "2026-09-08T12:45:00.000Z", endDateTime: filters.endDateTime },
    qualificationId: null,
    cancelRequested: false,
    createdAt: "2026-09-08T13:01:00.000Z",
    attemptedAt: "2026-09-08T13:01:01.000Z",
    updatedAt: "2026-09-08T13:02:00.000Z",
    finishedAt: "2026-09-08T13:02:00.000Z",
    expiresAt: "2026-10-08T13:02:00.000Z",
    canResume: false,
    remoteWorkMayContinue: false,
  };
  const catalog = {
    presets: [
      { id: "copilot_interactions", label: "Copilot interactions", service: "Copilot", recordTypes: ["copilotInteraction"], operations: ["CopilotInteraction"] },
      { id: "copilot_studio_admin", label: "Copilot Studio administration", service: "PowerPlatform", recordTypes: ["powerPlatformAdministratorActivity"], operations: ["BotCreate"] },
    ],
    limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumPages: 20, maximumRows: 5_000, maximumBytes: 8_000_000, pollsPerActivation: 6, providerRequests: 64, activations: 12 },
    evidenceNotice: "Microsoft Purview Audit Search is compliance and security evidence. It is not official Microsoft 365 Copilot Agents usage.",
    contentNotice: "Content not present in Purview audit. Copilot audit records expose message identifiers and metadata, not prompt or response text.",
    retentionNotice: "Local minimized results expire after 30 days. Microsoft Purview source retention and remote query lifetime are separate provider policies.",
  };
  const providerCommands: string[] = [];
  const providerBodies: unknown[] = [];
  await page.route(url => url.pathname === "/api/capabilities", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: {
      ...body,
      value: body.value.map((view: { definition: { id: string }; decision: object }) => view.definition.id === "purview.audit.search.delegated" ? {
        ...view,
        decision: { ...view.decision, status: "available", authorized: true, fresh: true, expiresAt: "2026-10-08T13:02:00.000Z", previewQualification: "qualified", remediation: [] },
      } : view),
    } });
  });
  await page.route(url => url.pathname.startsWith("/api/audit-search/"), route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      providerCommands.push(`${request.method()} ${path}`);
      providerBodies.push(request.postDataJSON());
    }
    if (path === "/api/audit-search/catalog") return route.fulfill({ json: catalog });
    if (path === "/api/audit-search/jobs" && request.method() === "GET") return route.fulfill({ json: { value: [job], count: 1 } });
    if (path === "/api/audit-search/jobs" && request.method() === "POST") return route.fulfill({ status: 202, json: job });
    if (path === `/api/audit-search/jobs/${jobId}/records`) return route.fulfill({ json: { value: [{
      projectionVersion: 1, wrapperId: "wrapper-browser", nativeEventId: "native-event-browser", eventDateTime: "2026-09-08T12:30:00.000Z",
      auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction", service: "Copilot", resultStatus: "Succeeded",
      actorUserId: "actor-browser", actorUserPrincipalName: "actor@example.invalid", actorUserType: "Member", objectId: "object-browser",
      clientIp: "192.0.2.20", administrativeUnits: [], correlationId: "correlation-browser", agentId: "agent-browser", appIdentity: null,
      appHost: null, botId: "bot-browser", environmentId: "environment-browser", botComponentId: null, aiPluginOperationId: null,
      messages: [{ id: "message-browser", isPrompt: true }], contentAvailable: false, unknownFieldCount: 2,
      association: { status: "unresolved", reason: "no_documented_cross_source_relation" },
    }], count: 1, limit: 100, offset: 0, job } });
    if (path === `/api/audit-search/jobs/${jobId}/export.csv`) return route.fulfill({ body: "eventDateTime,contentState\r\n2026-09-08T12:30:00.000Z,Content not present in Purview audit\r\n", contentType: "text/csv" });
    return route.fulfill({ status: 404, json: { error: { code: "fixture_route", message: path } } });
  });

  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Audit log", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Purview Audit Search" }).click();
  await expect(page.getByRole("heading", { name: "Purview Audit Search" })).toBeVisible();
  await expect(page.getByText(/not official Microsoft 365 Copilot Agents usage/)).toBeVisible();
  await expect(page.getByText(/Local minimized results expire after 30 days/)).toBeVisible();
  expect(providerCommands).toEqual([]);

  await page.getByRole("button", { name: "Run Audit Search" }).click();
  await expect.poll(() => providerCommands).toEqual(["POST /api/audit-search/jobs"]);
  expect(providerBodies).toEqual([expect.objectContaining({ filters: expect.objectContaining({ operations: ["CopilotInteraction"] }) })]);
  await page.getByRole("button", { name: /View results 77777777/ }).click();
  await expect(page.getByText("Partial coverage", { exact: true })).toBeVisible();
  await expect(page.getByText("native-event-browser", { exact: true })).toBeVisible();
  await expect(page.getByText(/Prompt ID: message-browser/)).toBeVisible();
  await expect(page.getByText("Content not present in Purview audit", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/no documented cross source relation/)).toBeVisible();
  await expect(page.getByTitle("Stop local polling; remote work may continue")).toHaveCount(0);
  await expect(page.getByTitle("Delete local cache only")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByTitle("Export minimized results CSV").click();
  expect((await download).suggestedFilename()).toBe(`purview-audit-${jobId}.csv`);
  expect(providerCommands).toEqual(["POST /api/audit-search/jobs"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/evidence/purview-audit-${test.info().project.name}.png`, fullPage: true });
});
test("Defender hunting is explicit, fixed-template, scoped, partial-aware and content-free", async ({ page }) => {
  const jobId = "88888888-8888-4888-8888-888888888888";
  const now = new Date();
  const endDateTime = now.toISOString();
  const startDateTime = new Date(now.getTime() - 60 * 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
  const filters = {
    templateId: "agent_activity",
    startDateTime,
    endDateTime,
    agentIds: ["agent-browser"],
    blueprintIds: [],
    actorObjectIds: [],
    operations: ["InferenceCall", "InvokeAgent"],
  };
  const job = {
    id: jobId,
    authorizationPrincipalId: "fixture-role-Viewer",
    resultScope: { kind: "principal", scopeId: "fixture-role-Viewer", configurationRevision: null },
    tokenMode: "delegated",
    status: "partial",
    filters,
    queryVersion: 3,
    retainedScopeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    localRequestId: "99999999-9999-4999-8999-999999999999",
    providerRequestId: "provider-hunting-browser",
    providerRequestCount: 1,
    activationCount: 1,
    providerRowCount: 201,
    storedRowCount: 1,
    byteCount: 2_048,
    complete: false,
    noData: false,
    partialReason: "hunting_row_limit",
    observedRange: { startDateTime: new Date(now.getTime() - 30 * 60_000).toISOString(), endDateTime: new Date(now.getTime() - 30 * 60_000).toISOString() },
    unobservedRange: { startDateTime, endDateTime },
    snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    priorSuccessfulJobId: null,
    qualification: null,
    cancelRequested: false,
    createdAt: endDateTime,
    attemptedAt: endDateTime,
    updatedAt: endDateTime,
    finishedAt: endDateTime,
    expiresAt,
    canResume: false,
  };
  const catalog = {
    templates: [
      { id: "agents_inventory", label: "Defender agent inventory", sourceTable: "AgentsInfo", operations: [] },
      { id: "agent_activity", label: "Agent activity", sourceTable: "CloudAppEvents", operations: ["InvokeAgent", "InferenceCall"] },
      { id: "agent_tools", label: "Agent tool activity", sourceTable: "CloudAppEvents", operations: ["ExecuteToolBySDK", "ExecuteToolByGateway", "ExecuteToolByMCPServer"] },
    ],
    qualifications: [
      { capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", targetScopeHash: "a".repeat(64),
        approvedScope: { templateId: "agents_inventory", agentIds: ["agent-browser"], blueprintIds: [], actorObjectIds: [], operations: [] },
        queryVersion: 3, contractRevision: "b".repeat(64), permissionRevision: "c".repeat(64), configurationRevision: 1,
        approvedBy: "fixture-role-Admin", qualifiedAt: endDateTime, expiresAt },
      { capabilityId: "defender.hunting.delegated", templateId: "agent_activity", targetScopeHash: "d".repeat(64),
        approvedScope: { templateId: "agent_activity", agentIds: ["agent-browser"], blueprintIds: [], actorObjectIds: [], operations: ["InferenceCall", "InvokeAgent"] },
        queryVersion: 3, contractRevision: "b".repeat(64), permissionRevision: "c".repeat(64), configurationRevision: 1,
        approvedBy: "fixture-role-Admin", qualifiedAt: endDateTime, expiresAt },
    ],
    retainedScopes: [
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", resultScope: { kind: "principal", scopeId: "fixture-role-Viewer", configurationRevision: null },
        tokenMode: "delegated", capabilityId: "defender.hunting.delegated", templateId: "agents_inventory", targetScopeHash: "a".repeat(64),
        approvedScope: { templateId: "agents_inventory", agentIds: ["agent-browser"], blueprintIds: [], actorObjectIds: [], operations: [] },
        queryVersion: 3, contractRevision: "b".repeat(64), permissionRevision: "c".repeat(64), configurationRevision: 1,
        approvedBy: "fixture-role-Admin", sourceQualificationJobId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        approvedAt: endDateTime, qualifiedAt: endDateTime, expiresAt, revokedAt: null },
      { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", resultScope: { kind: "principal", scopeId: "fixture-role-Viewer", configurationRevision: null },
        tokenMode: "delegated", capabilityId: "defender.hunting.delegated", templateId: "agent_activity", targetScopeHash: "d".repeat(64),
        approvedScope: { templateId: "agent_activity", agentIds: ["agent-browser"], blueprintIds: [], actorObjectIds: [], operations: ["InferenceCall", "InvokeAgent"] },
        queryVersion: 3, contractRevision: "b".repeat(64), permissionRevision: "c".repeat(64), configurationRevision: 1,
        approvedBy: "fixture-role-Admin", sourceQualificationJobId: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
        approvedAt: endDateTime, qualifiedAt: endDateTime, expiresAt, revokedAt: null },
    ],
    limits: { maximumWindowHours: 168, qualificationWindowHours: 1, maximumRows: 200, maximumBytes: 2_000_000, providerRequests: 12, activations: 4 },
    scopeNotice: "Graph-selected Defender scope; no requested-workspace isolation is claimed.",
    contentNotice: "Messages, instructions, memory and tool arguments or results are not retained or reconstructed.",
    readinessNotice: "License, rollout, connector, RBAC and table availability require separate evidence.",
    retentionNotice: "Local minimized results expire after 30 days.",
    defenderPortalUrl: "https://security.microsoft.com/v2/advanced-hunting",
  };
  const providerCommands: string[] = [];
  const providerBodies: Record<string, unknown>[] = [];
  await page.route(url => url.pathname === "/api/capabilities", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: {
      ...body,
      value: body.value.map((view: { definition: { id: string }; decision: object }) => view.definition.id === "defender.hunting.delegated" ? {
        ...view,
        decision: { ...view.decision, status: "available", authorized: true, fresh: true, checkedAt: endDateTime, expiresAt, remediation: [] },
      } : view),
    } });
  });
  await page.route(url => url.pathname.startsWith("/api/hunting/"), route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      providerCommands.push(`${request.method()} ${path}`);
      providerBodies.push(request.postDataJSON());
    }
    if (path === "/api/hunting/catalog") return route.fulfill({ json: catalog });
    if (path === "/api/hunting/jobs" && request.method() === "GET") return route.fulfill({ json: { value: [job], count: 1, limit: 20, offset: 0 } });
    if (path === "/api/hunting/jobs" && request.method() === "POST") return route.fulfill({ status: 202, json: job });
    if (path === `/api/hunting/jobs/${jobId}/rows`) return route.fulfill({ json: { value: [{
      projectionVersion: 3,
      sourceTable: "CloudAppEvents",
      timestamp: new Date(now.getTime() - 30 * 60_000).toISOString(),
      actionType: "InvokeAgent",
      cloudApplication: "Microsoft 365 Copilot",
      cloudApplicationId: 123,
      cloudAppInstanceId: 456,
      actorAccountObjectId: "actor-browser",
      actorProviderAccountId: "provider-actor-browser",
      objectId: "object-browser",
      reportId: "report-browser",
      oauthAppId: "oauth-browser",
      operation: "invoke_agent",
      organizationId: "organization-browser",
      targetAgentId: "agent-browser",
      targetAgentName: "Support agent",
      targetAgentBlueprintId: "blueprint-browser",
      agentId: "agent-browser",
      agentName: "Support agent",
      agentBlueprintId: "blueprint-browser",
      alternatePlatformAgentId: null,
      platformAgentType: "copilot-studio",
      conversationId: "conversation-browser",
      conversationThreadId: null,
      sessionIdentity: null,
      channelName: "Microsoft Teams",
      humanActorUserObjectId: null,
      humanActorUserPrincipalName: null,
      agentUserObjectId: null,
      agentUserPrincipalName: null,
      targetAgentUserObjectId: null,
      spanId: "child-span-browser",
      parentSpanId: "unobserved-root-span",
      creationTime: null,
      completionTime: null,
      errorType: null,
      toolName: null,
      toolType: null,
      toolCallId: null,
      invokeSource: null,
      durationMilliseconds: null,
      outcome: "unknown",
      spanRole: "child",
      rootSpanObserved: false,
      fieldStates: { conversationId: "value", conversationThreadId: "unavailable", channelName: "value", humanActorUserObjectId: "null",
        agentUserObjectId: "unavailable", targetAgentUserObjectId: "null", completionTime: "null", errorType: "null",
        platformAgentId: "null", platformAgentType: "value" },
      contentAvailable: false,
      association: { status: "unresolved", reason: "blueprint_is_parent_not_equivalence" },
    }], count: 1, limit: 100, offset: 0, job, snapshot: {
      id: job.snapshotId,
      jobId,
      resultScope: job.resultScope,
      filters,
      sourceTable: "CloudAppEvents",
      queryVersion: 3,
      requestedRange: { startDateTime, endDateTime },
      observedRange: job.observedRange,
      unobservedRange: job.unobservedRange,
      observationTime: endDateTime,
      complete: false,
      noData: false,
      partialReason: "hunting_row_limit",
      providerRowCount: 201,
      storedRowCount: 1,
      byteCount: 2_048,
      expiresAt,
    } } });
    if (path === `/api/hunting/jobs/${jobId}/export.csv`) return route.fulfill({ body: "timestamp,sourceTable,contentState\r\nsynthetic,CloudAppEvents,Content absent\r\n", contentType: "text/csv" });
    return route.fulfill({ status: 404, json: { error: { code: "fixture_route", message: path } } });
  });

  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Defender and Agent 365 hunting" })).toBeVisible();
  await expect(page.getByText(/Messages, instructions, memory and tool arguments or results are not retained/)).toBeVisible();
  await expect(page.getByText(/Opening this view does not run a provider query/)).toHaveCount(0);
  expect(providerCommands).toEqual([]);

  await page.getByLabel("Fixed template").selectOption("agent_activity");
  await page.getByText("Typed identity filters").click();
  await page.getByLabel("Agent IDs").fill("agent-browser");
  await page.getByRole("button", { name: "Run hunt" }).click();
  await expect.poll(() => providerCommands).toEqual(["POST /api/hunting/jobs"]);
  expect(providerBodies).toEqual([{
    tokenMode: "delegated",
    filters: expect.objectContaining({ templateId: "agent_activity", operations: ["InferenceCall", "InvokeAgent"], agentIds: ["agent-browser"], blueprintIds: [], actorObjectIds: [] }),
  }]);
  expect(providerBodies[0]).not.toHaveProperty("Query");
  expect(providerBodies[0]).not.toHaveProperty("workspaceId");
  await page.getByRole("button", { name: /View hunt 88888888/ }).click();
  await expect(page.getByText(/200-row local cap was reached/)).toBeVisible();
  await expect(page.getByText("CloudAppEvents", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/content absent/i)).toBeVisible();
  await expect(page.getByText("Child of unobserved-root-span", { exact: true })).toBeVisible();
  await expect(page.getByText("Blueprint parent only", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /KQL/i })).toHaveCount(0);
  await expect(page.getByLabel(/workspace/i)).toHaveCount(0);

  const download = page.waitForEvent("download");
  await page.getByTitle("Export minimized CSV").click();
  expect((await download).suggestedFilename()).toBe(`defender-hunting-${jobId}.csv`);
  expect(providerCommands).toEqual(["POST /api/hunting/jobs"]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/evidence/defender-hunting-${test.info().project.name}.png`, fullPage: true });
});
test("loading and automatic-check transport failure preserve layout and fail closed", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route(url => url.pathname === "/api/capabilities", async route => {
    const response = await route.fetch(); await held; await route.fulfill({ response });
  });
  await page.route(url => url.pathname === "/api/capabilities/check", route => route.fulfill({ status: 503, json: { error: { code: "provider_error", message: "Synthetic outage" } } }));
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent("/permissions?fixture=unknown")}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading capability decisions...", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Permissions", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  release();
  await expect(page.getByRole("article")).toHaveCount(primaryCapabilityCount);
  await expect(page.getByRole("status")).toContainText("Automatic permission check failed");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh agents", exact: true })).toBeDisabled();
});

test("official usage imports through real HTTP and remains role-separated", async ({ page }) => {
  const agentsCsv = "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nreport-agent-1,Support agent,Your org,1,1,9,2026-07-06";
  const userAgentsCsv = "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nreport-agent-1,Support agent,Your org,User@example.invalid,9,2026-07-06";
  const usersCsv = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nUser@example.invalid,Example user,1,9,2026-07-06";
  const invalidCsv = "Username,Unexpected column\nUser@example.invalid,not-an-official-schema";

  await login(page, "available");
  await page.evaluate(() => {
    localStorage.setItem("agent-control:usage-reports:v1", "untrusted legacy rows");
    localStorage.setItem("unrelated", "preserve me");
  });
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByText(/Legacy browser report data is present/)).toBeVisible();
  await page.getByLabel("Reporting start").fill("2026-06-07");
  await page.getByLabel("Reporting end").fill("2026-07-06");
  const correction = page.getByText(/explicit correction replacing the active set/i);
  if (await correction.count()) await correction.locator("input").check();
  await page.getByLabel("Official usage CSV files").setInputFiles({ name: "agents.csv", mimeType: "text/csv", buffer: Buffer.from(agentsCsv) });
  await page.getByRole("button", { name: "Validate and stage" }).click();
  let previews = page.getByRole("region", { name: "Validated report previews" });
  await expect(previews).toBeVisible();
  await expect(previews.getByText("Missing Users & agents, Users", { exact: true })).toBeVisible();
  await expect(previews.getByRole("row")).toHaveCount(2);
  await expect(previews.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();

  await page.reload();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  previews = page.getByRole("region", { name: "Validated report previews" });
  await expect(previews.getByRole("row")).toHaveCount(2);
  await expect(page.getByLabel("Reporting start")).toHaveValue("2026-06-07");
  await expect(page.getByLabel("Reporting end")).toHaveValue("2026-07-06");
  await page.getByLabel("Official usage CSV files").setInputFiles([
    { name: "users-agents.csv", mimeType: "text/csv", buffer: Buffer.from(userAgentsCsv) },
    { name: "users.csv", mimeType: "text/csv", buffer: Buffer.from(usersCsv) },
  ]);
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await expect(previews.getByRole("row")).toHaveCount(4);
  await expect(previews.getByText("All three kinds reviewed", { exact: true })).toBeVisible();
  await expect(previews.getByText(/"responses":\{"agents":9,"userAgents":9,"users":9\}/)).toBeVisible();
  await expect(previews.getByText(/operator_asserted; source as-of absent \(absent\); freshness unknown/)).toHaveCount(3);
  expect(await previews.locator(".table-shell").evaluate(element => element.scrollWidth >= element.clientWidth)).toBe(true);
  if (test.info().project.name === "mobile") {
    expect(await previews.locator(".table-shell").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  }
  await previews.getByRole("button", { name: "Accept reviewed bundle" }).click();
  await expect(page.getByText(/three-file set is active/i)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("agent-control:usage-reports:v1"))).toBe("untrusted legacy rows");
  await page.getByRole("button", { name: /Acknowledge re-import and remove/i }).click();
  await expect(page.getByText(/removed after explicit acknowledgement/i)).toBeVisible();
  expect(await page.evaluate(() => ({ legacy: localStorage.getItem("agent-control:usage-reports:v1"), unrelated: localStorage.getItem("unrelated") }))).toEqual({ legacy: null, unrelated: "preserve me" });

  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByText("Microsoft 365 admin center Copilot Agents usage exports", { exact: true })).toBeVisible();
  await expect(page.getByText("All three exports", { exact: true })).toBeVisible();
  await expect(page.getByText("Support agent", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Report only", { exact: true }).first()).toBeVisible();
  const lineage = page.getByRole("region", { name: "Official usage lineage" });
  await expect(lineage.getByText(/stale after either exceeds/)).toBeVisible();
  await expect(lineage.getByText("Agents: unknown; Users & agents: unknown; Users: unknown", { exact: true })).toBeVisible();
  await expect(lineage.getByText(/operator_asserted/)).toBeVisible();

  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  const activeSetRow = page.getByRole("region", { name: "Retained report sets" }).getByRole("row").filter({ hasText: "Active" });
  const deleteSet = activeSetRow.getByRole("button", { name: "Delete retained set for 2026-06-07 to 2026-07-06" });
  await deleteSet.click();
  const dialog = page.getByRole("dialog", { name: "Confirm delete" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(deleteSet).toBeFocused();

  await page.getByText(/explicit correction replacing the active set/i).locator("input").check();
  await page.getByLabel("Reporting start").fill("2026-06-07");
  await page.getByLabel("Reporting end").fill("2026-07-06");
  await page.getByLabel("Official usage CSV files").setInputFiles([
    { name: "agents-correction.csv", mimeType: "text/csv", buffer: Buffer.from(agentsCsv.replace("9,2026", "99,2026")) },
    { name: "invalid.csv", mimeType: "text/csv", buffer: Buffer.from(invalidCsv) },
  ]);
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await expect(page.getByRole("status")).toContainText("1 report type(s) staged; 1 file(s) rejected");
  await expect(page.getByRole("region", { name: "Validated report previews" }).getByText(/Missing Users & agents, Users/)).toBeVisible();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByLabel("Report summary").getByText("Responses (Agents report)", { exact: true }).locator("..").getByText("9", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await page.getByRole("region", { name: "Validated report previews" }).getByRole("button", { name: "Discard staging" }).click();
  await expect(page.getByRole("status")).toContainText("All staged rows were discarded.");

  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.getByText("User@example.invalid", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Report only / unresolved ID", { exact: true })).toBeVisible();
  await expect(page.getByText(/Dataset .*Users version .*Users & agents version/)).toBeVisible();

  await page.evaluate(() => localStorage.setItem("agent-control:usage-reports:v1", "still-untrusted"));
  await login(page, "role-Viewer");
  await expect(page.getByText(/Legacy browser report data is present in this browser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Official usage", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent insights dashboard" })).toBeVisible();
  await expect(page.getByText("Support agent", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose CSVs", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await expect(page.getByText("User@example.invalid", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Dataset .*Users version .*Users & agents version/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/evidence/official-usage-${test.info().project.name}.png`, fullPage: true });
});