import { expect, test } from "@playwright/test";
import { layoutTime, mockLayoutApi, unifiedAgents } from "./layoutFixtures";

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });

test("deferred agent investigation deep links fall back to Overview without hiding usage or management", async ({ page }) => {
  const unexpected = await mockLayoutApi(page);
  const securityRequests: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:hunting|audit-search|agent-inventory\/investigations)(?:\/|$)/.test(path)) securityRequests.push(path);
  });
  await page.clock.setFixedTime(new Date(layoutTime));
  const agent = unifiedAgents.value[0];
  await page.goto(`/agents?detail=${encodeURIComponent(agent.id)}&detailTab=audit-security`);
  const dialog = page.getByRole("dialog", { name: agent.displayName });
  await expect(dialog.getByRole("tab")).toHaveText(["Overview", "Usage", "Users", "Manage"]);
  await expect(dialog.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("region", { name: "Technical details" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Source" })).toHaveCount(0);
  await expect(dialog.getByText(/Purview|Defender|log identity|Log setup/)).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Usage", exact: true }).click();
  await expect(dialog.getByRole("tabpanel", { name: "Usage" })).toBeVisible();
  await dialog.getByRole("tab", { name: "Users", exact: true }).click();
  await expect(dialog.getByRole("tabpanel", { name: "Users" })).toBeVisible();
  await dialog.getByRole("tab", { name: "Manage", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Manage", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Select who can use this agent" })).toBeVisible();
  await dialog.getByRole("button", { name: /^Installed for/ }).click();
  await expect(dialog.getByRole("heading", { name: "Select who this agent is installed for" })).toBeVisible();
  expect(securityRequests).toEqual([]);
  expect(unexpected).toEqual([]);
});
