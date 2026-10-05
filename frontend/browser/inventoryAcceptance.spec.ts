import { expect, test, type Route } from "@playwright/test";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { fulfillInventoryPage } from "./selectedInventoryFixture";
import { createUnifiedVerification } from "../src/test/inventoryVerification";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("Viewer exports selected multi-version and single groups without expanding members or gaining mutation controls", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  await page.route("**/api/me", route => route.fulfill({ json: {
    user: { displayName: "Viewer", username: "viewer@example.invalid", homeAccountId: "layout-principal",
      tenantId: "layout-tenant", roles: ["AgentControl.Viewer"] }, csrfToken: "layout-csrf",
  } }));
  const group = { ...unifiedAgents.value[0], id: "agent:11111111-1111-4111-8111-111111111111",
    displayName: "Multi-version agent", packageCount: 40, memberCount: 40, packagesComplete: false };
  const single = { ...unifiedAgents.value[1], id: "agent:22222222-2222-4222-8222-222222222222",
    displayName: "Single-version agent", packageCount: 1, memberCount: 1, packagesComplete: true };
  await page.route(url => url.pathname === "/api/agent-inventory", route =>
    fulfillInventoryPage(route, { ...unifiedAgents, value: [group, single],
      counts: { total: 2, scoped: 2, filtered: 2, packageTargets: 41 } }));
  const forbidden: string[] = [];
  page.on("request", request => {
    if (/\/members|\/children|\/mutation-selection|\/mutation-preview|\/agents\/block/.test(request.url())) forbidden.push(request.url());
  });
  const exportId = "60000000-0000-4000-8000-000000000006";
  let exported: unknown;
  const download = (route: Route) => route.fulfill({ contentType: "text/csv",
    headers: { "Content-Disposition": 'attachment; filename="inventory.csv"' }, body: "Agent\nMulti-version agent\nSingle-version agent\n" });
  await page.context().route(url => url.pathname === `/api/data-exports/${exportId}/download`, download);
  await page.route(url => url.pathname === `/api/data-exports/${exportId}/download`, download);
  await page.route(url => url.pathname.startsWith("/api/data-exports") && !url.pathname.endsWith("/download"), route => {
    if (route.request().method() === "POST") {
      exported = route.request().postDataJSON();
      return route.fulfill({ status: 202, json: { id: exportId } });
    }
    return route.fulfill({ json: { id: exportId, status: "ready", rows: 2, bytes: 51,
      expiresAt: "2026-09-12T10:30:00Z", error: null, limit: null, observed: null } });
  });
  await page.goto("/agents");
  const checkbox = page.getByRole("checkbox", { name: "Select Multi-version agent" });
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.getByRole("checkbox", { name: "Select Single-version agent" }).check();
  await expect(page.getByRole("button", { name: "Block selected packages" })).toHaveCount(0);
  await page.getByRole("button", { name: "Export agent inventory CSV" }).click();
  await page.getByRole("button", { name: /Download selected agents/ }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe("inventory.csv");
  expect(exported).toEqual({ kind: "unified_agents", selectionId: expect.any(String), ids: [single.id, group.id], idempotencyKey: expect.any(String) });
  expect(forbidden).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("already-stale optional identity stays readable with stale diagnostics and no control authority", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const record = structuredClone(unifiedAgents.value[0]), detailExpiry = "2026-09-12T09:00:00Z";
  record.packages[0].detailFreshness = { state: "stale", observedAt: "2026-09-12T08:00:00Z", expiresAt: detailExpiry };
  record.observations.packageSnapshots = { [record.packages[0].id]: {
    id: "catalog", snapshotId: "catalog", current: true, scopeKind: "broad",
    observedAt: layoutTime, expiresAt: unifiedAgents.selection.expiresAt,
    identityDetails: { id: "detail", snapshotId: "detail", current: false,
      observedAt: "2026-09-12T08:00:00Z", expiresAt: detailExpiry },
  } };
  await page.route(url => url.pathname === "/api/agent-inventory", route => fulfillInventoryPage(route, {
    ...unifiedAgents, value: [record],
    identityCollection: { checkedPackages: 0, pendingPackages: 1, pendingDetails: { missing: 0, stale: 1, invalidated: 0 } },
    verification: { ...createUnifiedVerification({ graphPackageCount: 1, powerPlatformAgentCount: 0, logicalAgentCount: 1 },
      { packageMetadata: false }, layoutTime), status: "details_pending" },
  }));
  await page.goto("/agents");
  await expect(page.getByRole("checkbox", { name: `Select ${record.displayName}` })).toBeVisible();
  await expect(page.getByText(/current saved agent inventory could not be loaded/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Block selected packages" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  await page.getByRole("button", { name: "View diagnostics", exact: true }).click();
  await expect(page.getByText("0 package detail checks current; 1 not current.")).toBeVisible();
  expect(unexpected).toEqual([]);
});
