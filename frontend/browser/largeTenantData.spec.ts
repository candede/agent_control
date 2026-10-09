import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";
import { fulfillInventoryPage } from "./selectedInventoryFixture";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("bounded export setup is idempotent under backpressure and polling stops when its view unmounts", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const creates: unknown[] = [], requests: string[] = [];
  let polls = 0, pages = 0, bytes = 0;
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(new URL(request.url()).pathname); });
  await page.route(url => url.pathname === "/api/agent-inventory", route => {
    pages++;
    const data = { ...unifiedAgents, value: [unifiedAgents.value[0]] };
    bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(data)));
    return fulfillInventoryPage(route, data);
  });
  const id = "60000000-0000-4000-8000-000000000065";
  await page.route(url => url.pathname.startsWith("/api/data-exports"), route => {
    if (route.request().method() === "POST") {
      creates.push(route.request().postDataJSON());
      return creates.length === 1
        ? route.fulfill({ status: 503, headers: { "Retry-After": "2" }, json: { code: "data_snapshot_conflict", detail: "Retry this unchanged intent." } })
        : route.fulfill({ status: 202, json: { id } });
    }
    polls++;
    return route.fulfill({ json: { id, status: "building", rows: 100, bytes: 4096,
      expiresAt: "2026-09-12T10:30:00Z", error: null, limit: null, observed: null } });
  });
  await page.goto("/agents");
  const checkbox = page.getByRole("checkbox", { name: `Select ${unifiedAgents.value[0].displayName}` });
  await page.waitForLoadState("networkidle");
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  const trigger = page.getByRole("button", { name: "Export agent inventory CSV", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Download selected agents/ }).click();
  await expect(page.getByText(/building: 100 rows/)).toBeVisible();
  expect(creates).toHaveLength(2);
  expect(creates[1]).toEqual(creates[0]);
  expect(creates[0]).toEqual({ kind: "unified_agents", selectionId: expect.any(String),
    ids: [unifiedAgents.value[0].id], idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveCount(0);
  const prior = polls;
  await page.goto("/users");
  await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
  await page.waitForTimeout(3300);
  expect(polls).toBe(prior);
  expect(pages).toBeLessThanOrEqual(3);
  expect(bytes).toBeLessThanOrEqual(1_048_576);
  expect(requests.some(path => /\/members|\/children|\/mutation-preview/.test(path))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(unexpected).toEqual([]);
  await info.attach("bounded-lifecycle-metrics", { body: JSON.stringify({ requests: requests.length, pages, maximumPageBytes: bytes,
    creates: creates.length, polls, pollingAfterUnmount: polls - prior }), contentType: "application/json" });
});

test("invalidated artifact terminates audibly without downloading a partial file", async ({ page }, info) => {
  const unexpected = await mockLayoutApi(page);
  await page.clock.setFixedTime(new Date(layoutTime));
  const id = "60000000-0000-4000-8000-000000000066";
  let polls = 0, downloads = 0;
  page.on("download", () => { downloads++; });
  await page.route(url => url.pathname.startsWith("/api/data-exports"), route => {
    if (route.request().method() === "POST") return route.fulfill({ status: 202, json: { id } });
    polls++;
    return route.fulfill({ json: { id, status: "failed", rows: 75, bytes: 1024,
      expiresAt: "2026-09-12T10:30:00Z", error: "selection_invalidated", limit: null, observed: null } });
  });
  await page.goto("/agents");
  await page.getByRole("checkbox", { name: `Select ${unifiedAgents.value[0].displayName}` }).check();
  await page.getByRole("button", { name: "Export agent inventory CSV" }).click();
  await page.getByRole("button", { name: /Download selected agents/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: /selection changed or expired/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveCount(0);
  await page.waitForTimeout(3100);
  expect(polls).toBe(1);
  expect(downloads).toBe(0);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(unexpected).toEqual([]);
  await info.attach("terminal-export-metrics", { body: JSON.stringify({ polls, downloads }), contentType: "application/json" });
});
