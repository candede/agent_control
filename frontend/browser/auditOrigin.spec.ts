import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { layoutTime, mockLayoutApi } from "./layoutFixtures";
import { unknownOrigin } from "../../backend/src/types/actionOrigin";
import { reportPage } from "../src/test/reportDataFixture";

const event = { id: "origin-browser", operationId: "origin-operation", scope: "single", action: "block",
  agentId: "managed-target", agentDisplayName: "Managed target, not caller", status: "succeeded", targetBlockedState: true,
  startedAt: layoutTime, requestPath: "/api/agents/block",
  actor: { homeAccountId: "layout-principal", username: "layout.administrator@example.invalid", displayName: "Synthetic layout administrator" },
  origin: { ...unknownOrigin, channel: "mcp", integrationClientId: "33333333-3333-3333-3333-333333333333",
    client: { id: { value: "caller-a", evidence: "reported" }, name: { value: "=1+1", evidence: "reported" },
      version: { value: "1", evidence: "reported" } },
    callingAgent: { id: { value: "agent-a", evidence: "reported" }, name: { value: "<script>inert</script>", evidence: "reported" } },
    requestId: "11111111-1111-1111-1111-111111111111", mcpCallId: "call-1" } };
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
for (const role of ["AgentControl.Viewer", "AgentControl.UsageReportUploader"] as const) {
  test(`Audit navigation and direct URLs are hidden for ${role}`, async ({ page }) => {
    const unexpected = await mockLayoutApi(page);
    await page.route(url => url.pathname === "/api/official-usage/history/adoption",
      route => route.fulfill({ json: reportPage([]) }));
    await page.route("**/api/me", route => route.fulfill({ json: {
      user: { homeAccountId: "layout-principal", tenantId: "layout-tenant", username: "reader@example.invalid",
        displayName: "Synthetic reader", roles: [role] },
      csrfToken: "layout-csrf", roleAssignmentRequired: false,
    } }));
    const auditRequests: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/audit/events")) auditRequests.push(request.url());
    });
    await page.goto("/audit");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Audit evidence" })).toHaveCount(0);
    await page.getByRole("button", { name: "Permissions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
    await page.evaluate(() => { history.pushState({}, "", "/audit"); dispatchEvent(new PopStateEvent("popstate")); });
    await expect(page.getByRole("button", { name: "Audit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Audit evidence" })).toHaveCount(0);
    expect(auditRequests).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
test("Origin filters preserve URL/page/selection and inert evidence is accessible on the current compiled frontend", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page), queries: URLSearchParams[] = [];
  await page.route("**/api/audit/events?**", async route => {
    queries.push(new URL(route.request().url()).searchParams);
    await route.fulfill({ json: { value: [event], count: 300 } });
  });
  await page.goto("/audit?origin=mcp&client=caller-a&callingAgent=agent-a&page=3");
  const table = page.getByRole("region", { name: "Audit events" });
  await expect(table.getByRole("columnheader", { name: "Origin", exact: true })).toBeVisible();
  await expect(table).toContainText("Managed target, not caller");
  const trigger = table.getByRole("button", { name: "View origin details for origin-browser" });
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Event details" });
  await expect(dialog).toContainText("<script>inert</script> (reported)");
  await expect(dialog).toContainText("Integration application (authenticated when known)");
  await expect(dialog.locator("script")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include(".audit-details-modal").analyze()).violations).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("origin-details.png") });
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  expect(queries[0].get("offset")).toBe("200");
  expect(queries[0].get("originClientId")).toBe("caller-a");
  await page.getByRole("combobox", { name: "Origin", exact: true }).selectOption("unknown");
  await expect(page).toHaveURL(/origin=unknown/);
  await expect.poll(() => queries.at(-1)?.get("offset")).toBe("0");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page).toHaveURL(/\/audit$/);
  expect(unexpected).toEqual([]);
});
test("unrecorded history stays unknown and export retains only the displayed exact event selection", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  await page.route("**/api/audit/events?**", route => route.fulfill({ json: { value: [{ ...event, origin: undefined }], count: 1 } }));
  const selections: unknown[] = [];
  await page.route("**/api/audit/events/export.csv", async route => {
    selections.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/csv", headers: { "Content-Disposition": "attachment; filename=administrative-audit.csv" },
      body: "\uFEFFeventId,originChannel\r\norigin-browser,unknown\r\n" });
  });
  await page.goto("/audit");
  const table = page.getByRole("region", { name: "Audit events" });
  await expect(table).toContainText("Unknown / historical");
  await table.getByRole("button", { name: "View origin details for origin-browser" }).click();
  await expect(page.getByRole("dialog", { name: "Event details" })).toContainText("Unknown (unknown)");
  await page.keyboard.press("Escape");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export current audit page CSV" }).click();
  expect((await download).suggestedFilename()).toBe("administrative-audit.csv");
  expect(selections).toEqual([{ ids: ["origin-browser"] }]);
  expect(unexpected).toEqual([]);
});
