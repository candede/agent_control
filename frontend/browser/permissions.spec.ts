import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { statusLabels } from "../src/capabilityState";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import type { CapabilityView, OfficialUsageAdminState, OfficialUsageAggregateView, PackageRefreshJob, QuarantineTargetPage } from "../src/api/client";
import { createInventoryVerification } from "../src/test/inventoryVerification";
import { mockLayoutApi } from "./layoutFixtures";
import { fixtureLoginUrl, isExternalFixtureRequest, isPackageMutationRequest, isUnexpectedPermissionCommand } from "./permissionFixtures";

const primaryCapabilityCount = capabilityDefinitions.filter(definition => definition.probe.adapterRegistered && definition.mode !== "application").length;

async function login(page: Page, scenario: string) {
  await page.goto(fixtureLoginUrl(scenario));
  await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Account permissions" }).getByRole("button", { name: /^View details for/ })).toHaveCount(primaryCapabilityCount);
}
async function collectSavedPackages(page: Page) {
  if (process.env.AGENT_CONTROL_FIXTURE_MODE !== "browser") throw new Error("Package fixture collection requires synthetic providers.");
  const job = await page.evaluate(async () => {
    const sessionResponse = await fetch("/api/me");
    if (!sessionResponse.ok) throw new Error(`Fixture session failed: ${sessionResponse.status}`);
    const session = await sessionResponse.json();
    const response = await fetch("/api/agents/refresh-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ mode: "delegated" }),
    });
    if (!response.ok) throw new Error(`Fixture package collection failed: ${response.status}`);
    const result: PackageRefreshJob = await response.json();
    return result;
  });
  expect(job.id).toEqual(expect.any(String));
  await expect.poll(async () => {
    const response = await page.request.get(`/api/agents/refresh-jobs/${encodeURIComponent(job.id)}?mode=delegated`);
    expect(response.ok()).toBe(true);
    const current: PackageRefreshJob = await response.json();
    return current.status;
  }).toBe("succeeded");
  await page.reload();
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
  await context.route(isExternalFixtureRequest, route => route.abort());
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("consented Admin permissions do not ask for consent until a token check reports it missing", async ({ page }) => {
  const unexpectedRequests = await mockLayoutApi(page);
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
    return route.fallback();
  });
  await page.goto("/permissions");
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  await expect(page.getByRole("button", { name: `3 provider-verified / 1 local / ${primaryCapabilityCount - 4} ready to try / 0 degraded / 0 blocked` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request consent", exact: true })).toHaveCount(0);
  const packageRow = page.getByRole("row", { name: "Package block management", exact: true });
  await expect(packageRow.getByText("Microsoft checks access when used", { exact: true })).toBeVisible();
  await expect(packageRow.getByRole("link", { name: "Open Agents" })).toBeVisible();
  missingConsent = true;
  await check.click();
  await expect(packageRow.getByRole("button", { name: "Request consent", exact: true })).toBeVisible();
  await expect(packageRow.getByText("Missing app permission", { exact: true })).toBeVisible();
  missingConsent = false;
  await check.click();
  await expect(packageRow.getByRole("button", { name: "Request consent", exact: true })).toHaveCount(0);
  await expect(packageRow.getByText("Microsoft checks access when used", { exact: true })).toBeVisible();
  expect(posts.length).toBeGreaterThanOrEqual(3);
  expect(posts.every(path => path === "/api/capabilities/check")).toBe(true);
  expect(unexpectedRequests).toEqual([]);
});

test("primary navigation uses the full header width at every screen size", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: {
      user: { displayName: "Synthetic navigation validation account", username: "fixture@example.invalid", homeAccountId: "navigation-fixture", roles: ["AgentControl.Admin"] },
      csrfToken: "synthetic-csrf", roleAssignmentRequired: false,
    } });
    if (path === "/api/workbench/metadata") return route.fulfill({ json: { views: workbenchViews, actions: workbenchActions } });
    if (path === "/api/agents") return route.fulfill({ json: savedPackagePage(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()) });
    return route.fallback();
  });
  await page.goto("/permissions");
  const navigation = page.getByRole("navigation", { name: "Primary views" });
  await expect(navigation.getByRole("button")).toHaveCount(9);
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
  expect(unexpected).toEqual([]);
});

test("first Agents visit is saved-only and explicit collection enables exact saved detail management", async ({ page }, info) => {
  const refreshes: string[] = [];
  const writes: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path.startsWith("/api/agents/") && path.endsWith("/refresh-jobs")) refreshes.push(path);
    if (isPackageMutationRequest(request.method(), path)) writes.push(path);
  });
  await login(page, `first-agent-visit-${info.project.name}`);
  await expect(page.getByRole("row", { name: "Package catalog read", exact: true }).locator(".capability-status")).toHaveText("Available");
  expect(refreshes).toEqual([]);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText(/No saved package observation/)).toBeVisible();
  expect(refreshes).toEqual([]);
  await collectSavedPackages(page);
  await expect(page.getByRole("button", { name: "View details for Synthetic package" })).toBeVisible();
  expect(refreshes.filter(path => path === "/api/agents/refresh-jobs")).toHaveLength(1);
  await page.getByRole("button", { name: "View details for Synthetic package" }).click();
  const editor = page.getByRole("dialog", { name: "Synthetic package", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect(editor.getByRole("button", { name: "Block Synthetic package (synthetic-package)", exact: true })).toBeEnabled();
  await expect(editor.getByRole("region", { name: "Availability settings" })).toBeVisible();
  expect(refreshes.filter(path => path === "/api/agents/synthetic-package/refresh-jobs")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(page.getByRole("button", { name: "View details for Synthetic package" })).toBeFocused();
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
  const unexpected = await mockLayoutApi(page);
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
    return route.fallback();
  });
  await page.goto("/permissions");
  const catalog = page.getByRole("row", { name: "Package catalog read", exact: true });
  await expect(catalog.getByText("Check timed out", { exact: true })).toBeVisible();
  await expect(catalog.getByText(/bounded provider check timed out after 30 seconds/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Audit", exact: true })).toHaveAttribute("href", "/audit");
  await expect(page.getByRole("link", { name: "Open Security", exact: true })).toHaveAttribute("href", "/security");
  await expect(page.getByRole("link", { name: "Open Agents", exact: true }).first()).toHaveAttribute("href", "/agents");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(catalog.locator(".capability-status")).toHaveText("Available");
  expect(requests.filter(path => path === "/api/capabilities/check?retry=failed")).toHaveLength(1);
  const block = page.getByRole("row", { name: "Package block management", exact: true });
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
    const name = roleDenied ? "Package block management" : "Package catalog read";
    const row = page.getByRole("row", {
      name: roleDenied ? "Package block management" : "Package catalog read",
      exact: true,
    });
    await expect(row.locator(".capability-status")).toHaveText(label);
    await row.getByRole("button", { name: `View details for ${name}` }).click();
    const details = page.getByRole("dialog", { name, exact: true });
    await expect(details.getByText(
      roleDenied ? "delegated: CopilotPackages.ReadWrite.All" : "delegated: CopilotPackages.Read.All",
      { exact: true },
    )).toBeVisible();
    await expect(details.getByText("https://graph.microsoft.com", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "View details for Power Platform inventory", exact: true }).click();
    const inventory = page.getByRole("dialog", { name: "Power Platform inventory", exact: true });
    await expect(inventory.getByText("delegated: ResourceQuery.Resources.Read", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`permissions-${status}.png`) });
    await row.screenshot({ path: info.outputPath(`permission-row-${status}.png`) });
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
    if (isUnexpectedPermissionCommand(request.method(), path)) unexpectedProviderWorkloads.push(`${request.method()} ${path}`);
  });
  await login(page, "stale");
  const row = page.getByRole("row", { name: "Package catalog read", exact: true });
  await expect(row.locator(".capability-status")).toHaveText("Available");
  expect(checks).toBe(1);
  expect(legacyProbes).toBe(0);
  expect(unexpectedProviderWorkloads).toEqual([]);
  const setup = row.getByRole("button", { name: "View details for Package catalog read" });
  await setup.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Check evidence" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Setup and documentation" })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape"); await expect(dialog).not.toBeVisible(); await expect(setup).toBeFocused();
  await expect(row.getByRole("button", { name: "Request consent" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in with Entra ID" })).toBeVisible();
  await login(page, "missing_delegated_grant");
  const missingRow = page.getByRole("row", { name: "Package catalog read", exact: true });
  await missingRow.getByRole("button", { name: "Request consent" }).click();
  await expect(page.getByRole("status")).toContainText("Consent was cancelled or denied");
  await expect(page.getByText("never-render-provider-text")).toHaveCount(0);
  expect(legacyProbes).toBe(0);
  expect(unexpectedProviderWorkloads).toEqual([]);
});
test("Viewer retains saved catalog access during stale read evidence", async ({ page }) => {
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
  await collectSavedPackages(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Block selected packages", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(page.getByText("Unknown / stale evidence")).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByText("Synthetic package", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh agents", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export agent inventory CSV", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "View details for Synthetic package" }).click();
  const details = page.getByRole("dialog", { name: "Synthetic package" });
  await details.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect(details.getByText("An AgentControl.Admin role is required to make changes.", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  await expect(details.locator("button:not(:disabled)").filter({ hasText: /^(Block |Unblock |Apply$)/ })).toHaveCount(0);
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
  await page.getByRole("button", { name: /View details for Older refresh/ }).click();
  await page.getByRole("dialog", { name: "Job details", exact: true }).getByRole("link", { name: "Open package refresh", exact: true }).click();
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
  await page.route(url => /^\/api\/agents\//i.test(url.pathname), route => {
    if (!isPackageMutationRequest(route.request().method(), new URL(route.request().url()).pathname)) return route.fallback();
    writes += 1;
    return route.fulfill({ status: 500 });
  });

  await login(page, "available");
  await collectSavedPackages(page);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "View details for Synthetic package" }).click();
  const agentDialog = page.getByRole("dialog", { name: "Synthetic package" });
  await agentDialog.getByRole("tab", { name: "Manage", exact: true }).click();
  await agentDialog.getByRole("button", { name: "Block Synthetic package (synthetic-package)", exact: true }).click();
  const dialog = agentDialog.getByRole("region", { name: /block package/i });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Preview write risk", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Delegated CopilotPackages.ReadWrite.All", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Current:/)).toContainText('"isBlocked":false');
  await expect(dialog.getByText(/Requested:/)).toContainText('"isBlocked":true');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("package-confirmation.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(agentDialog).toBeVisible();
  expect(previews).toBe(1);
  expect(writes).toBe(0);
});
test("saved inventory navigation does not scan and explicit refresh is the only provider command", async ({ page }) => {
  const now = new Date().toISOString();
  const snapshot = { id: "22222222-2222-2222-2222-222222222222", roleScope: "full", environmentScope: "environment-a", requestedTypes: ["microsoft.powerautomate/cloudflows"], coverage: [], observedCount: 1, totalRecords: 1, pageCount: 1, unknownFieldCount: 2, observedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), verification: createInventoryVerification(1, ["microsoft.powerautomate/cloudflows"], now) };
  const resourcePage = {
    value: [{ tenantId: "11111111-1111-1111-1111-111111111111", nativeId: "cloud-flow-a", type: "microsoft.powerautomate/cloudflows", location: null, displayName: "Support intake", environmentId: "environment-a", createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "not_applicable", lifecycle: "not_applicable", identityConfidence: "exact_native", identifiers: [{ kind: "power_platform_resource_id", value: "cloud-flow-a" }, { kind: "environment_id", value: "environment-a" }], provenance: { trigger: { sourceSystem: "power_platform", path: "properties.trigger", maturity: "preview" }, connectors: { sourceSystem: "power_platform", path: "properties.powerPlatformConnectors", maturity: "preview" } }, details: { trigger: "Manual", capabilityDetailsTruncated: true, connectorDetailsStatus: "partial", connectors: [{ connectorId: "shared_office365users", operations: [{ operationId: "SearchUser", usedAs: "action", isEnabled: true, requiresEndUserConsent: false }] }] }, unknownFieldCount: 1 }],
    count: 1,
    typeCounts: [{ type: "microsoft.powerautomate/cloudflows", status: "covered", count: 1 }, { type: "microsoft.powerplatformconnector/connectors", status: "not_authorized_scope", count: null }, { type: "microsoft.powerapps/codeapps", status: "unknown", count: null }],
    snapshot,
  };
  const waitingJob = { id: "11111111-1111-1111-1111-111111111111", status: "waiting_authorization", roleScope: "full", environmentScope: "environment-a", requestedTypes: ["microsoft.powerautomate/cloudflows"], pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null, createdAt: now, attemptedAt: now, updatedAt: now, finishedAt: null };
  const refreshBodies: unknown[] = [];
  await page.route(url => url.pathname.startsWith("/api/inventory/"), async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/related")) return route.fulfill({ json: {
      source: "power_platform", nativeId: "cloud-flow-a", resourceType: "microsoft.powerautomate/cloudflows",
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
  await expect(page.getByLabel("Resource type coverage").getByText("Not queried (role scope)", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Resource type coverage").getByText("Unknown (not verified)", { exact: true })).toBeVisible();
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
  await expect(dialog.getByText("SearchUser", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("listitem").filter({ hasText: "SearchUser" })).toHaveText("SearchUser · action");
  await expect(page).toHaveURL(/detail=cloud-flow-a/);
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
  await page.getByLabel("Refresh resource scope").selectOption("microsoft.powerautomate/cloudflows");
  await page.getByLabel("Refresh environment scope").fill("environment-b");
  await page.getByRole("button", { name: /Refresh selected scope/ }).click();
  await expect.poll(() => refreshBodies).toEqual([{ types: ["microsoft.powerautomate/cloudflows"], environmentId: "environment-b" }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("inventory.png"), fullPage: true });
});
test("quarantine uses real policy, exact saved targets, confirmation and verified fixture write", async ({ page }, testInfo) => {
  const quarantineRequests: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/quarantine/")) quarantineRequests.push(`${request.method()} ${url.pathname}`); });
  await login(page, "role-Admin");
  const targetResponse = await page.request.get("/api/quarantine/targets");
  expect(targetResponse.ok()).toBe(true);
  const targets: QuarantineTargetPage = await targetResponse.json();
  // Each viewport writes a different seeded target so neither depends on the other running first.
  const firstBotId = testInfo.project.name === "mobile" ? "cccccccc-cccc-cccc-cccc-cccccccccccc" : "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const secondBotId = testInfo.project.name === "mobile" ? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" : "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const firstName = targets.value.find(target => target.botId === firstBotId)!.displayName!;
  const secondName = targets.value.find(target => target.botId === secondBotId)!.displayName!;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: `Select ${firstName}`, exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: `Select ${secondName}`, exact: true })).toBeVisible();
  expect(quarantineRequests.filter(value => value.includes("/status"))).toEqual([]);

  await page.getByRole("checkbox", { name: `Select ${secondName}`, exact: true }).check();
  await page.getByRole("button", { name: "Quarantine selected" }).click();
  const confirmation = page.getByRole("dialog", { name: "Quarantine 1 agent" });
  await expect(confirmation.getByText(`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa / ${secondBotId}`, { exact: true })).toBeVisible();
  await expect(confirmation.getByRole("checkbox")).toBeEnabled();
  await expect(confirmation.getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
  await confirmation.getByRole("checkbox").check();
  await expect(confirmation.getByRole("button", { name: "Confirm quarantine" })).toBeEnabled();
  expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".quarantine-confirmation").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("quarantine-confirmation.png"), fullPage: true });
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await confirmation.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await login(page, "role-Viewer");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("region", { name: "Copilot Studio quarantine controls" })).toHaveCount(0);
  expect(quarantineRequests.filter(value => value === "POST /api/quarantine/jobs")).toHaveLength(0);
  await login(page, "role-Admin");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("checkbox", { name: `Select ${firstName}`, exact: true }).check();

  await page.getByRole("button", { name: "Quarantine selected" }).click();
  const targetConfirmation = page.getByRole("dialog", { name: "Quarantine 1 agent" });
  await expect(targetConfirmation.getByText(`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa / ${firstBotId}`, { exact: true })).toBeVisible();
  await targetConfirmation.getByRole("checkbox").check();
  await targetConfirmation.getByRole("button", { name: "Confirm quarantine" }).click();
  await expect(targetConfirmation).toBeHidden();
  await expect(page.getByText("Quarantine job: Succeeded", { exact: true })).toBeVisible({ timeout: 10_000 });
  const completedJob = page.getByRole("status").filter({ hasText: "Quarantine job: Succeeded" });
  await expect(completedJob).toContainText(firstName);
  await expect(completedJob).toContainText("1 of 1 complete · 1 verified");

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
  await directStatusDialog.getByRole("tab", { name: "Manage" }).click();
  await expect(page.getByText("Not checked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check direct status" }).click();
  await expect(page.getByRole("alert")).toContainText("Direct status unavailable: Synthetic direct status outage.");
  await page.getByRole("button", { name: "Check direct status" }).click();
  await expect(page.getByText("Quarantined", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Direct and inventory states disagree.", { exact: true })).toBeVisible();
  expect(quarantineRequests.filter(value => value === "POST /api/quarantine/jobs")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("quarantine-controls.png"), fullPage: true });
});
test("saved inventory remains readable during provider outage without a refresh", async ({ page }) => {
  let writes = 0;
  const now = new Date().toISOString();
  const snapshot = { id: "33333333-3333-3333-3333-333333333333", roleScope: "full", environmentScope: null, requestedTypes: ["microsoft.powerplatform/environments"], coverage: [], observedCount: 1, totalRecords: 1, pageCount: 1, unknownFieldCount: 0, observedAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), verification: createInventoryVerification(1, ["microsoft.powerplatform/environments"], now) };
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
  await expect(page.getByText(/latest capability check failed.*authorized saved data remains readable/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Refresh selected scope/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Export filtered inventory CSV" })).toBeEnabled();
  expect(writes).toBe(0);
});
test("two-role hierarchy, private evidence, and saved audit during outage", async ({ page, browser }) => {
  let providerRefreshes = 0;
  await page.route(url => url.pathname === "/api/agents/synthetic-package", route => route.fulfill({ json: {
    id: "synthetic-package", displayName: "Synthetic package", isBlocked: false, sourceSystem: "graph_packages",
    authoringTool: null, creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown",
    identityConfidence: "exact_native", provenance: {}, allowedUsersAndGroups: [], acquireUsersAndGroups: [],
  } }));
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/refresh-jobs")) providerRefreshes += 1;
  });
  await login(page, "role-Admin");
  for (const view of ["Agents", "Power Platform", "Users", "Official usage", "Audit", "Security", "Jobs"]) {
    await expect(page.getByRole("button", { name: view, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose CSVs", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await login(page, "role-Viewer");
  for (const view of ["Agents", "Power Platform", "Users", "Official usage", "Audit", "Security", "Jobs"]) {
    await expect(page.getByRole("button", { name: view, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import reports", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose CSVs", exact: true })).toHaveCount(0);
  const beforeViewerView = providerRefreshes;
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  expect(providerRefreshes).toBe(beforeViewerView);
  await expect(page.getByRole("button", { name: /^Block / })).toHaveCount(0);
  await login(page, "provider_error");
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await expect(page.getByRole("region", { name: "Audit log", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch("/api/audit/events")).status)).toBe(200);
  const other = await browser.newContext();
  try {
    await other.route(isExternalFixtureRequest, route => route.abort());
    const otherPage = await other.newPage();
    await otherPage.route(url => url.pathname === "/api/capabilities/check", route => route.fulfill({ status: 503, json: { code: "provider_error" } }));
    await otherPage.goto(fixtureLoginUrl("unprobed-principal"));
    await expect(otherPage.getByRole("row", { name: "Package catalog read", exact: true }).locator(".capability-status")).toHaveText("Unknown");
  } finally {
    await other.close();
  }
});
test("all canonical workbench routes are deep-linkable and preserve agent state through history", async ({ page }, testInfo) => {
  await login(page, "available");
  await collectSavedPackages(page);
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

  const scopedReportRequest = () => page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === "/api/official-usage/aggregate" && url.searchParams.get("activityWindowDays") === "90";
  });
  const initialReportRead = scopedReportRequest();
  await page.goto("/official-usage?window=90");
  await initialReportRead;
  await expect(page.getByRole("region", { name: "Agent activity report" })).toBeVisible();
  await expect(page.getByLabel("Active in last")).toHaveCount(0);
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  const restoredReportRead = scopedReportRequest();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page).toHaveURL(/\/official-usage\?window=90$/);
  await restoredReportRead;

  await page.goto("/security?template=agent_activity&operation=InvokeAgent&agentIds=saved-agent");
  await expect(page.getByLabel("Fixed template")).toHaveValue("agent_activity");
  await expect(page.getByLabel("Agent IDs")).toHaveValue("saved-agent");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/security\?.*template=agent_activity/);
  await expect(page.getByLabel("Agent IDs")).toHaveValue("saved-agent");

  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("workbench-routes.png"), fullPage: true });
});
test("Purview audit remains separate, explicit, partial-aware, and content-free", async ({ page }) => {
  const jobId = "77777777-7777-4777-8777-777777777777";
  const now = Date.now();
  const observedAt = new Date(now - 30 * 60_000).toISOString();
  const finishedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 30 * 24 * 60 * 60_000).toISOString();
  const filters = {
    presetId: "copilot_interactions",
    operations: ["CopilotInteraction"],
    startDateTime: new Date(now - 60 * 60_000).toISOString(),
    endDateTime: finishedAt,
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
    observedRange: { startDateTime: filters.startDateTime, endDateTime: observedAt },
    unobservedRange: { startDateTime: observedAt, endDateTime: filters.endDateTime },
    qualificationId: null,
    cancelRequested: false,
    createdAt: finishedAt,
    attemptedAt: finishedAt,
    updatedAt: finishedAt,
    finishedAt,
    expiresAt,
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
  await page.route(url => ["/api/capabilities", "/api/capabilities/check"].includes(url.pathname), async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: {
      ...body,
      value: body.value.map((view: { definition: { id: string }; decision: object }) => view.definition.id === "purview.audit.search.delegated" ? {
        ...view,
        decision: { ...view.decision, status: "available", authorized: true, fresh: true, verification: "token", checkedAt: finishedAt, expiresAt, previewQualification: "qualified", remediation: [] },
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
      projectionVersion: 1, wrapperId: "wrapper-browser", nativeEventId: "native-event-browser", eventDateTime: observedAt,
      auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction", service: "Copilot", resultStatus: "Succeeded",
      actorUserId: "actor-browser", actorUserPrincipalName: "actor@example.invalid", actorUserType: "Member", objectId: "object-browser",
      clientIp: "192.0.2.20", administrativeUnits: [], correlationId: "correlation-browser", agentId: "agent-browser", appIdentity: null,
      appHost: null, botId: "bot-browser", environmentId: "environment-browser", botComponentId: null, aiPluginOperationId: null,
      messages: [{ id: "message-browser", isPrompt: true }], contentAvailable: false, unknownFieldCount: 2,
      association: { status: "unresolved", reason: "no_documented_cross_source_relation" },
    }], count: 1, limit: 100, offset: 0, job } });
    if (path === `/api/audit-search/jobs/${jobId}/export.csv`) return route.fulfill({ body: `eventDateTime,contentState\r\n${observedAt},Content not present in Purview audit\r\n`, contentType: "text/csv" });
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
  await page.screenshot({ path: test.info().outputPath("purview-audit.png"), fullPage: true });
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
  await page.screenshot({ path: test.info().outputPath("defender-hunting.png"), fullPage: true });
});
test("loading and automatic-check transport failure preserve layout and fail closed", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  await page.route(url => url.pathname === "/api/capabilities", async route => {
    const response = await route.fetch(); await held; await route.fulfill({ response });
  });
  await page.route(url => url.pathname === "/api/capabilities/check", route => route.fulfill({ status: 503, json: { error: { code: "provider_error", message: "Synthetic outage" } } }));
  try {
    await page.goto(fixtureLoginUrl("unknown"), { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Loading permission status...", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Permissions", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    release();
  }
  await expect(page.getByRole("table", { name: "Account permissions" }).getByRole("button", { name: /^View details for/ })).toHaveCount(primaryCapabilityCount);
  await expect(page.getByRole("alert")).toContainText("Automatic permission check failed");
  await page.getByRole("button", { name: /^Sync/ }).click();
  const diagnosticsTrigger = page.getByRole("button", { name: "View diagnostics", exact: true });
  await diagnosticsTrigger.click();
  const diagnostics = page.getByRole("dialog", { name: "Inventory diagnostics", exact: true });
  await expect(diagnostics).toBeVisible();
  const packages = diagnostics.getByRole("region", { name: "Source matching details" });
  await expect(packages.getByRole("button", { name: "Refresh agents", exact: true })).toBeDisabled();
  await diagnostics.getByRole("button", { name: "Close inventory diagnostics", exact: true }).click();
  await expect(diagnostics).toBeHidden();
  await expect(diagnosticsTrigger).toBeFocused();
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
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  const modal = page.locator("dialog.official-usage-modal");
  await expect(page.getByRole("dialog", { name: "Import CSV reports" })).toBeVisible();
  await expect(modal.getByText(/Legacy browser report data is present/)).toBeVisible();
  await expect(modal.getByLabel("Reporting start")).toHaveCount(0);
  await expect(modal.getByLabel("Reporting end")).toHaveCount(0);
  await page.getByLabel("Official usage CSV files").setInputFiles({ name: "agents.csv", mimeType: "text/csv", buffer: Buffer.from(agentsCsv) });
  await page.getByRole("button", { name: "Validate and stage" }).click();
  let validation = modal.getByRole("region", { name: "Server validation" });
  await expect(validation).toBeVisible();
  await expect(validation.getByText("Missing Users & agents, Users", { exact: true })).toBeVisible();
  await expect(validation.getByText(/^Agents: 1 rows staged/)).toBeVisible();
  await expect(modal.getByRole("button", { name: "Continue to review" })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "Accept reviewed bundle" })).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  validation = modal.getByRole("region", { name: "Server validation" });
  await expect(validation.getByText("Missing Users & agents, Users", { exact: true })).toBeVisible();
  const stagedState: OfficialUsageAdminState = await (await page.request.get("/api/official-usage/admin")).json();
  expect(stagedState.staging.filter(stage => stage.status === "active")).toHaveLength(1);
  expect(stagedState.staging.find(stage => stage.status === "active")?.reportingPeriod.provenance).toBe("activity_range");
  await modal.getByRole("button", { name: "Back to files" }).click();
  await page.getByLabel("Official usage CSV files").setInputFiles([
    { name: "users-agents.csv", mimeType: "text/csv", buffer: Buffer.from(userAgentsCsv) },
    { name: "users.csv", mimeType: "text/csv", buffer: Buffer.from(usersCsv) },
  ]);
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await expect(validation.getByText("All three report kinds are present", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Continue to review" }).click();
  const previews = modal.getByRole("region", { name: "Validated report previews" });
  await expect(previews.getByRole("row")).toHaveCount(4);
  await expect(previews.getByText("Bundle hash", { exact: true })).toBeHidden();
  await previews.getByText("Technical validation details", { exact: true }).click();
  await expect(previews.locator("pre")).toContainText('"agents": 9');
  await expect(previews.locator("pre")).toContainText('"userAgents": 9');
  await expect(previews.locator("pre")).toContainText('"users": 9');
  await expect(previews.getByText(/Observed last-activity dates; reporting window unknown; freshness unknown/)).toHaveCount(3);
  expect(await previews.locator(".table-shell").evaluate(element => element.scrollWidth >= element.clientWidth)).toBe(true);
  if (test.info().project.name === "mobile") {
    expect(await previews.locator(".table-shell").evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  }
  await modal.getByRole("button", { name: "Accept reviewed bundle" }).click();
  if (stagedState.activeSetId) {
    await expect(modal.getByText(/upload exactly matched the current retained snapshot.*No new history entry was created/)).toBeVisible();
    const reused: OfficialUsageAdminState = await (await page.request.get("/api/official-usage/admin")).json();
    expect(reused.activeSetId).toBe(stagedState.activeSetId);
    expect(reused.activeRevision).toBe(stagedState.activeRevision);
    expect(reused.sets).toHaveLength(stagedState.sets.length);
    expect(reused.sets.find(set => set.id === reused.activeSetId)?.acceptedAt)
      .toBe(stagedState.sets.find(set => set.id === stagedState.activeSetId)?.acceptedAt);
  } else {
    await expect(modal.getByText(/three-file snapshot was added to cumulative history and is current/)).toBeVisible();
  }
  const accepted: OfficialUsageAggregateView = await (await page.request.get("/api/official-usage/aggregate")).json();
  expect(accepted.summary.usage).toMatchObject({ totalResponses: 9, totalActiveUsers: 1 });
  expect(accepted.lineages).toHaveLength(3);
  expect(accepted.activeSet?.id).toEqual(expect.any(String));
  expect(await page.evaluate(() => localStorage.getItem("agent-control:usage-reports:v1"))).toBe("untrusted legacy rows");
  await page.getByRole("button", { name: /Acknowledge re-import and remove/i }).click();
  await expect(page.getByText(/removed after explicit acknowledgement/i)).toBeVisible();
  expect(await page.evaluate(() => ({ legacy: localStorage.getItem("agent-control:usage-reports:v1"), unrelated: localStorage.getItem("unrelated") }))).toEqual({ legacy: null, unrelated: "preserve me" });

  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("region", { name: "Retained activity summary" })).toContainText("Reported used agents");
  await page.getByRole("button", { name: "Snapshot details", exact: true }).click();
  await page.locator(".usage-report-details > summary").click();
  await expect(page.getByText(/Microsoft 365 admin center Copilot Agents usage exports\. Source discrepancies/)).toBeVisible();
  const lineage = page.locator(".usage-source-files");
  await expect(lineage.locator(":scope > details")).toHaveCount(3);
  await expect(page.getByText("Support agent", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Agent comparison rows" }).locator("tbody tr")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Agent activity report" }).getByRole("link")).toHaveCount(0);
  for (const source of await lineage.locator(":scope > details").all()) {
    await source.locator("summary").click();
    await expect(source.getByText(/activity_range/)).toBeVisible();
    await expect(source.getByText("unknown", { exact: true })).toBeVisible();
    await expect(source.getByText("Not supplied", { exact: true })).toBeVisible();
  }
  await expect(page.getByText(/Import time does not establish source freshness/)).toBeVisible();

  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await modal.getByRole("button", { name: "Manage reports", exact: true }).click();
  const activeSetRow = modal.getByRole("region", { name: "Retained report sets" }).getByRole("row").filter({ hasText: "Current" });
  const deleteSet = activeSetRow.getByRole("button", { name: /^Delete retained set for / });
  await deleteSet.click();
  const dialog = page.getByRole("dialog", { name: "Confirm delete" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(deleteSet).toBeFocused();

  await modal.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  await modal.getByRole("button", { name: "Import another bundle", exact: true }).click();
  await modal.getByRole("checkbox", { name: "This upload intentionally corrects the current snapshot." }).check();
  await page.getByLabel("Official usage CSV files").setInputFiles([
    { name: "agents-correction.csv", mimeType: "text/csv", buffer: Buffer.from(agentsCsv.replace("9,2026", "99,2026")) },
    { name: "invalid.csv", mimeType: "text/csv", buffer: Buffer.from(invalidCsv) },
  ]);
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await expect(modal.getByText(/1 report type\(s\) staged; 1 file\(s\) rejected/)).toBeVisible();
  await expect(modal.getByRole("region", { name: "Server validation" }).getByText(/^Agents: 1 rows staged/)).toBeVisible();
  await expect(modal.getByRole("button", { name: "Continue to review" })).toBeDisabled();
  await expect(modal.getByRole("region", { name: "Validated report previews" })).toHaveCount(0);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  const unchanged: OfficialUsageAggregateView = await (await page.request.get("/api/official-usage/aggregate")).json();
  expect(unchanged.activeSet?.id).toBe(accepted.activeSet?.id);
  expect(unchanged.summary.usage).toMatchObject({ totalResponses: 9, totalActiveUsers: 1 });
  await expect(page.getByRole("region", { name: "Usage summary" })).toContainText("9");
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await modal.getByRole("button", { name: "Discard staging" }).click();
  await expect(modal.getByText("All staged rows were discarded.", { exact: true })).toBeVisible();
  const discarded: OfficialUsageAdminState = await (await page.request.get("/api/official-usage/admin")).json();
  expect(discarded.staging.filter(stage => stage.status === "active")).toEqual([]);

  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Reported activity", exact: true }).click();
  await expect(page.getByText("User@example.invalid", { exact: true }).first()).toBeVisible();
  const reportedUsers = page.getByRole("region", { name: "Reported users", exact: true });
  await expect(reportedUsers.getByRole("row", { name: /Example user/ })).toContainText("Unknown");
  await expect(reportedUsers.getByRole("row", { name: /Example user/ })).toContainText("9");
  await reportedUsers.getByRole("button", { name: "View reported details for Example user" }).click();
  const userDetail = page.getByRole("dialog", { name: "Example user", exact: true });
  await expect(userDetail.getByRole("button", { name: "Support agent", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(userDetail).not.toBeVisible();

  await page.evaluate(() => localStorage.setItem("agent-control:usage-reports:v1", "still-untrusted"));
  await login(page, "role-Viewer");
  await expect(page.getByText(/Legacy browser report data is present in this browser/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Official usage", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Official usage", exact: true }).click();
  await expect(page.getByRole("region", { name: "Cumulative agent activity" })).toBeVisible();
  await page.getByRole("button", { name: "Snapshot details", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent activity report" })).toBeVisible();
  await expect(page.getByText("Support agent", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Import reports", exact: true })).toHaveCount(0);
  const session = await (await page.request.get("/api/me")).json();
  const deniedImport = await page.request.post("/api/official-usage/staging", {
    headers: { "X-CSRF-Token": session.csrfToken },
    multipart: { bundleId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", file: { name: "agents.csv", mimeType: "text/csv", buffer: Buffer.from(agentsCsv) } },
  });
  expect(deniedImport.status()).toBe(403);
  await page.getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "Reported activity", exact: true }).click();
  await expect(page.getByText("User@example.invalid", { exact: true }).first()).toBeVisible();
  await expect(reportedUsers.getByRole("row", { name: /Example user/ })).toContainText("9");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("official-usage.png"), fullPage: true });
});