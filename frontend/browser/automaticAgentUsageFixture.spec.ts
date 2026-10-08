import { expect, test } from "@playwright/test";
import type { CandidateAgentUsageCandidates, CandidateAgentUsageHistory, CandidateAgentUsageUsers } from "../../backend/src/types/officialReportApi";
import type { UnifiedAgentInventoryPage } from "../../backend/src/types/unifiedAgents";
import { automaticAgentUsageFixture } from "../src/test/automaticAgentUsageFixture";
import { unifiedAgents } from "./layoutFixtures";
import { captureInventorySelection } from "./selectedInventoryFixture";
import { mockSelectedInventoryUsage } from "./selectedInventoryUsageFixture";

test.beforeEach(async ({ context, page }) => {
  await context.route("**/*", route => route.abort());
  await page.route("http://localhost/agent-usage-fixture", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><html lang=\"en\"><title>Agent usage fixture contracts</title><body></body></html>",
  }));
  await page.goto("http://localhost/agent-usage-fixture");
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("selected agent usage retains inventory revision/expiry and history request limits", async ({ page }) => {
  const inventory = structuredClone(unifiedAgents);
  inventory.selection = { ...inventory.selection, revision: "captured-revision",
    evaluatedAt: "2026-09-18T10:00:00.000Z", expiresAt: "2026-09-18T10:10:00.000Z" };
  const record = inventory.value[0];
  record.usage = automaticAgentUsageFixture({ recordId: record.id, reportSetId: inventory.usageContext.reports.setId,
    responses: 0, activeUsers: 0, lastActivityDateUtc: null });
  await page.route("**/api/agent-inventory/selections", route => captureInventorySelection(route, inventory.selection));
  await mockSelectedInventoryUsage(page, () => inventory, () => []);
  const selection: UnifiedAgentInventoryPage["selection"] = await page.evaluate(async () => {
    const response = await fetch("/api/agent-inventory/selections", {
      method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "synthetic" }, body: JSON.stringify({ query: {} }),
    });
    if (response.status !== 201) throw new Error(`Selection capture failed: ${response.status}`);
    return response.json();
  });
  for (const endpoint of ["usage-users", "usage-candidates"]) {
    const result: CandidateAgentUsageUsers | CandidateAgentUsageCandidates = await page.evaluate(async ({ recordId, selectionId, endpoint }) => {
      const query = new URLSearchParams({ selectionId, inventorySelectionId: selectionId, limit: "25" });
      const response = await fetch(`/api/agent-inventory/${encodeURIComponent(recordId)}/${endpoint}?${query}`);
      if (!response.ok) throw new Error(`Usage read failed: ${response.status}`);
      return response.json();
    }, { recordId: record.id, selectionId: selection.id, endpoint });
    expect(result.selection).toEqual(selection);
    expect(result.context.selectionId).toBe(selection.id);
    expect(result.context.reports).toEqual(inventory.usageContext.reports);
    expect(result.page).toEqual({ limit: 25, nextCursor: null, previousCursor: null });
    expect(result.value).toEqual([]);
  }
  const history: CandidateAgentUsageHistory = await page.evaluate(async ({ recordId, selectionId }) => {
    const query = new URLSearchParams({ selectionId, inventorySelectionId: selectionId, limit: "1" });
    const response = await fetch(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage-history?${query}`);
    if (!response.ok) throw new Error(`History read failed: ${response.status}`);
    return response.json();
  }, { recordId: record.id, selectionId: selection.id });
  expect(history.page).toEqual({ limit: 1, nextCursor: null, previousCursor: null });
  expect(history.latestReportSetId).toBe(inventory.usageContext.reports.setId);
  expect(history.latestReported).toMatchObject({ responses: 0, acceptedAt: inventory.usageContext.reports.acceptedAt });
  expect(history.context.reports).toEqual(inventory.usageContext.reports);
});
