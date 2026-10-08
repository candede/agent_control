import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { reportExportColumns } from "../../backend/src/types/officialReportData";
import { reportPage, reports } from "../src/test/reportDataFixture";
import { captureCsvReportScreenshot, csvFilePayloads, downloadedCsvRows } from "./usageCsvFixture";
import { importedSetId as setId, retainedSetId as historicalSetId, mockSelectedImport, type SelectedImportOptions } from "./selectedImportFixture";

const csvFiles = [
  { name: "DeclarativeAgents_Agents_30_2026-09-12T14-41-53.csv",
    content: "\uFEFFAgent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\r\n"
      + 'agent-power,Clinical assistant,User-created agent,2,1,"1,048","Sep 12, 2026"\r\n'
      + 'agent-low,Prompt Coach,Agent built by Microsoft,1,1,3,"Aug 14, 2026"\r\n'
      + Array.from({ length: 101 }, (_, index) => `agent-${index},Synthetic agent ${index},Agent built by your org,1,0,10,"Sep 10, 2026"\r\n`).join("") },
  { name: "DeclarativeAgents_Users___agents_30_2026-09-12T14-42-01.csv",
    content: "\uFEFFAgent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\r\n"
      + 'agent-power,Clinical assistant,User-created agent,power@example.invalid,"1,048","Sep 12, 2026"\r\n'
      + 'agent-low,Prompt Coach,Agent built by Microsoft,low@example.invalid,3,"Sep 12, 2026"\r\n'
      + Array.from({ length: 101 }, (_, index) => `agent-${index},Synthetic agent ${index},Agent built by your org,person-${index}@example.invalid,10,"Sep 10, 2026"\r\n`).join("") },
  { name: "DeclarativeAgents_Users_30_2026-09-12T14-41-45.csv",
    content: "\uFEFFUsername,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\r\n"
      + 'power@example.invalid,Power User,1,"1,052","Sep 12, 2026"\r\n'
      + 'low@example.invalid,Low User,1,3,"Aug 14, 2026"\r\n' + "zero@example.invalid,Zero User,0,0,\r\n"
      + Array.from({ length: 101 }, (_, index) => `person-${index}@example.invalid,Synthetic Person ${index},1,10,"Sep 10, 2026"\r\n`).join("") },
];
type State = Awaited<ReturnType<typeof mockSelectedImport>>;
const states = new WeakMap<Page, State>();
async function mockUsage(page: Page, options: SelectedImportOptions = {}) {
  const state = await mockSelectedImport(page, csvFiles, options); states.set(page, state); return state;
}
const modal = (page: Page) => page.locator("dialog.official-usage-modal");
const history = (page: Page) => modal(page).getByRole("region", { name: "Saved report sets", exact: true });
const agentRows = (page: Page) => modal(page).getByRole("region", { name: "Reported agent activity", exact: true });
async function upload(page: Page, files = csvFiles) {
  await modal(page).getByLabel("CSV report files", { exact: true }).setInputFiles(csvFilePayloads(files));
}
async function accept(page: Page) {
  const confirm = modal(page).getByRole("button", { name: "Import reports", exact: true });
  await expect(confirm).toBeEnabled(); await confirm.click();
}
async function imported(page: Page) {
  const dialog = modal(page);
  await expect(dialog.getByRole("heading", { name: "Reports imported", exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toHaveText("Your report set is ready in Agents.");
  await expect(dialog.getByRole("button")).toHaveText(["OK"]);
  await expect(dialog.getByRole("button", { name: "OK", exact: true })).toBeEnabled();
}
async function completedImport(page: Page) { await upload(page); await accept(page); await imported(page); }
function exactVerification(state: State) {
  const queries = state.agentRequests.filter(query => query.get("limit") === "1");
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) expect(Object.fromEntries(query)).toEqual({ setId, limit: "1" });
  expect(state.apiRequests).not.toContain("/api/official-usage/admin");
}
async function confirmImportedSelection(page: Page) {
  await modal(page).getByRole("button", { name: "Use imported reports", exact: true }).click();
  const reviewed = modal(page).getByRole("region", { name: "Confirm imported report selection", exact: true });
  await expect(reviewed).toContainText(setId);
  await reviewed.getByRole("button", { name: "Confirm use of imported reports", exact: true }).click();
  await imported(page);
}
async function cancelDraft(page: Page) {
  await modal(page).getByRole("button", { name: "Cancel import", exact: true }).click();
  await modal(page).getByRole("button", { name: "Discard staged import", exact: true }).click();
  await expect(modal(page)).toBeHidden();
}
async function snapshotShell(page: Page) {
  const dialog = modal(page);
  await expect(dialog).toHaveAccessibleName("Report details");
  await expect(dialog.getByRole("button", { name: "Back to reports", exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: /Make current|Current snapshot/i })).toHaveCount(0);
  await expect(dialog.getByText("Viewing this report does not change the selected report set.", { exact: true })).toBeVisible();
}
async function accessible(page: Page) {
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
test.beforeEach(async ({ context }) => {
  await context.route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => route.abort());
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  const state = states.get(page);
  if (!state) return;
  expect(state.unexpected).toEqual([]);
  expect(state.apiRequests).not.toContain("/api/official-usage/admin");
  expect(state.apiRequests.filter(path => path.endsWith(".csv"))).toEqual([]);
  for (const query of [...state.agentRequests, ...state.userRequests, ...state.historyRequests]) {
    expect(query.has("offset")).toBe(false);
    expect(Number(query.get("limit"))).toBeLessThanOrEqual(100);
  }
});

for (const scenario of [
  { legacy: "/official-usage", canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=history", canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=snapshot", canonical: "/sync?reports=snapshot", title: "Report details" },
  { legacy: `/official-usage?snapshot=${setId}`, canonical: `/sync?reports=snapshot&snapshot=${setId}`, title: "Report details" },
  { legacy: `/official-usage?view=history&snapshot=${setId}`, canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=snapshot&window=90", canonical: "/sync?reports=snapshot&window=90", title: "Report details" },
]) test(`legacy workbench link ${scenario.legacy} opens its exact Sync workflow without a data alias`, async ({ page }) => {
  const state = await mockUsage(page, { active: true, role: "Viewer" });
  await page.goto(scenario.legacy); await expect(page).toHaveURL(scenario.canonical);
  await expect(modal(page)).toHaveAccessibleName(scenario.title); await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".official-usage-workbench")).toHaveCount(0);
  if (scenario.title === "Report details") {
    await expect(agentRows(page).locator("tbody tr")).toHaveCount(50);
    const url = new URL(scenario.canonical, "http://localhost");
    expect(state.agentRequests.at(-1)?.get("setId")).toBe(url.searchParams.get("snapshot"));
    expect(state.agentRequests.at(-1)?.get("activityWindowDays")).toBe(url.searchParams.get("window") ?? (url.searchParams.has("snapshot") ? "365" : "30"));
    await snapshotShell(page);
    await modal(page).getByRole("button", { name: "Back to reports", exact: true }).click();
  } else { await expect(history(page).locator("tbody tr")).toHaveCount(1); expect(state.agentRequests).toEqual([]); }
  await modal(page).getByRole("button", { name: "Close reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync$/); expect(state.commands).toEqual([]);
});

test("Viewer inspects retained report-only and bridge-only evidence with exact children and a native pinned export", async ({ page }, info) => {
  const state = await mockUsage(page, { active: true, historical: true, role: "Viewer" });
  await page.goto("/sync");
  const section = page.getByRole("region", { name: "CSV usage reports", exact: true });
  await expect(section.getByRole("button", { name: "Add CSV reports", exact: true })).toHaveCount(0);
  await section.getByRole("button", { name: "Manage reports", exact: true }).click();
  await expect(history(page).locator("tbody tr")).toHaveCount(2);
  await expect(modal(page).getByRole("table")).toHaveCount(1);
  await expect(modal(page).getByRole("button", { name: /Add CSV reports|Delete report set|Make current|Resume import/ })).toHaveCount(0);
  expect(state.apiRequests).not.toContain("/api/official-usage/overview");
  const saved = history(page).getByRole("row").filter({ has: page.getByRole("cell", { name: /^Saved/ }) });
  await expect(saved).toContainText("Jun 1, 2026");
  await saved.getByRole("button", { name: "Report observations", exact: true }).click();
  const observations = history(page).getByRole("region", { name: "Report observations", exact: true });
  await expect(observations.getByRole("listitem")).toHaveCount(3);
  await expect(observations).toContainText("1 rows"); await expect(observations).toContainText("2 rows");
  const held = gate();
  await page.route(url => url.pathname === "/api/official-usage/aggregate" && url.searchParams.get("setId") === historicalSetId,
    async route => { await held.promise; await route.fallback(); });
  try {
    await saved.getByRole("button", { name: "View report", exact: true }).click();
    await expect(modal(page).getByRole("status").filter({ hasText: /Loading saved/ })).toBeVisible();
    await expect(agentRows(page).locator("tbody tr")).toHaveCount(0);
  } finally { held.resolve(); }
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(2);
  await expect(agentRows(page).getByRole("row", { name: /Bridge-only retained assistant/ })).toContainText("Users & agents only");
  await expect(agentRows(page)).not.toContainText("Clinical assistant");
  await expect(modal(page).getByRole("region", { name: "Snapshot tenant totals" })).toContainText("17");
  await snapshotShell(page);
  await agentRows(page).getByRole("button", { name: "Historical report-only assistant", exact: true }).click();
  const detail = modal(page).getByRole("region", { name: "Exact reported agent details", exact: true });
  await expect(detail).toContainText("historical-report-only");
  await expect(detail.getByRole("region", { name: "Reported agent users", exact: true }).locator("tbody tr")).toHaveCount(1);
  expect(state.apiRequests).toContain("/api/official-usage/agents/historical-report-only/users");
  await detail.getByRole("button", { name: "Close agent details" }).click();
  const download = page.waitForEvent("download");
  await modal(page).getByRole("button", { name: "Export agent CSV" }).click();
  await modal(page).getByRole("link", { name: "Download CSV" }).click();
  const file = await download, rows = await downloadedCsvRows(file);
  expect(file.suggestedFilename()).toBe("official-agents.csv");
  expect(rows.map(row => row.agentId).sort()).toEqual(["historical-bridge-only", "historical-report-only"]);
  expect(rows.every(row => row.reportSetId === historicalSetId)).toBe(true);
  expect(state.exportDownloads).toEqual([true]); expect(state.exportRequests[0].get("setId")).toBe(historicalSetId);
  expect(state.commands).toEqual([]);
  await accessible(page); await page.screenshot({ path: info.outputPath("historical-source-details.png") });
});

test("an unavailable exact snapshot retries without substituting current report evidence", async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true, role: "Viewer" });
  let available = false;
  const requested: Array<string | null> = [];
  await page.route(url => url.pathname === "/api/official-usage/aggregate", route => {
    requested.push(new URL(route.request().url()).searchParams.get("setId"));
    return available ? route.fallback() : route.fulfill({ status: 503, json: { code: "snapshot_unavailable", detail: "This saved report is temporarily unavailable." } });
  });
  await page.goto(`/sync?reports=snapshot&snapshot=${historicalSetId}`);
  await expect(modal(page).getByRole("alert")).toContainText("This saved report is temporarily unavailable.");
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(0);
  await expect(modal(page).getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
  await expect(modal(page)).not.toContainText("Clinical assistant");
  available = true; await modal(page).getByRole("button", { name: "Retry saved data" }).click();
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(2);
  expect(requested).toEqual([historicalSetId, historicalSetId]); expect(state.commands).toEqual([]);
});

test("Sync opens a fresh accessible importer with one upload action, no metadata form and Cancel", async ({ page }, info) => {
  const state = await mockUsage(page);
  await page.goto("/sync");
  const trigger = page.getByRole("button", { name: "Add CSV reports", exact: true });
  await trigger.click();
  const dialog = modal(page), choose = dialog.getByRole("button", { name: "Choose CSV files", exact: true });
  const cancel = dialog.getByRole("button", { name: "Cancel import", exact: true });
  await expect(dialog).toHaveAccessibleName("Add CSV reports");
  await expect(choose).toBeInViewport({ ratio: 1 }); await expect(cancel).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Start over" })).toHaveCount(0);
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: /download.*CSV/i })).toBeVisible();
  await choose.focus(); await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await cancel.focus(); await page.keyboard.press("Tab");
  await expect(choose).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("link", { name: /download.*CSV/i })).toBeFocused();
  await accessible(page); await captureCsvReportScreenshot(page, info, "upload");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  expect(state.bundlePreviews).toEqual([]); expect(state.stageReads).toEqual([]);
  await trigger.click(); await cancel.click(); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
});

test("explicit acceptance imports all 103/103/104 rows, verifies exact data, preserves source discrepancies and bounded paging", async ({ page }, info) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const chooser = page.waitForEvent("filechooser");
  await modal(page).getByRole("button", { name: "Choose CSV files", exact: true }).click();
  await (await chooser).setFiles(csvFilePayloads(csvFiles));
  await expect(modal(page).getByRole("heading", { name: "Ready to import" })).toBeFocused();
  await expect(modal(page).getByRole("list", { name: "Selected CSV files" }).getByRole("listitem")).toHaveCount(3);
  await expect(modal(page).locator("details, pre")).toHaveCount(0);
  await expect(modal(page).getByRole("button")).toHaveText(["Cancel import", "Import reports"]);
  await accessible(page); await modal(page).screenshot({ path: info.outputPath("import-review.png") });
  expect(state.acceptRequests).toEqual([]); expect(state.stages.map(stage => stage.rowCount)).toEqual([103, 103, 104]);
  expect(state.stages.map(stage => stage.examples.length)).toEqual([20, 20, 20]);
  await accept(page); await imported(page); exactVerification(state);
  expect(state.acceptRequests).toHaveLength(1);
  const preview = state.bundlePreviews.at(-1)!;
  expect(state.acceptRequests[0]).toEqual({ bundleId: preview.bundleId, bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision });
  const summary = modal(page).getByRole("region", { name: "Imported CSV summary" });
  await expect(summary.locator("dt")).toHaveText(["Agents", "Users", "Responses"]);
  await expect(summary.locator("dd")).toHaveText(["103", "104", "2,061"]);
  await expect(summary).toBeInViewport({ ratio: 1 }); await expect(modal(page).getByRole("button", { name: "OK" })).toBeInViewport({ ratio: 1 });
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await accessible(page); await captureCsvReportScreenshot(page, info, "success");
  for (const body of state.uploadBodies) expect(body).not.toMatch(/name="(?:bundleId|reportingStart|reportingEnd|sourceAsOf|downloadedAt)"/);
  expect(state.uploadIntents.every(query => query.get("rejectDuplicateKind") === "true")).toBe(true);
  await modal(page).getByRole("button", { name: "OK", exact: true }).click(); await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(setId);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  expect(await modal(page).getByLabel("CSV report files").evaluate((element: HTMLInputElement) => element.files?.length)).toBe(0);
  await expect(modal(page).getByRole("heading", { name: "Reports imported" })).toHaveCount(0);
  await modal(page).getByRole("button", { name: "Cancel import", exact: true }).click();
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  await expect(history(page).locator("tbody tr")).toHaveCount(1);
  await captureCsvReportScreenshot(page, info, "management");
  await history(page).getByRole("button", { name: "View report", exact: true }).click();
  await expect(modal(page).getByRole("region", { name: "Snapshot tenant totals" })).toContainText("2,061");
  await expect(modal(page)).toContainText("reconciliation: mismatch");
  await expect(modal(page).getByRole("region", { name: "Report provenance" }).getByText(/Import time does not establish/)).toBeHidden();
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(50);
  await modal(page).getByRole("button", { name: "Next agents", exact: true }).click();
  await expect(modal(page).getByRole("navigation", { name: "agents pages" })).toContainText("103 matching agents; 50 on this page");
  expect(state.agentRequests.at(-1)?.get("cursor")).toBe("fixture:50");
  await modal(page).getByLabel("Search agents").fill("agent-100");
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(1);
  await expect(agentRows(page)).toContainText("Synthetic agent 100");
  await modal(page).getByLabel("Search agents").fill("no-matching-agent");
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(0);
  await modal(page).getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(50);
  expect(state.userRequests).toEqual([]); expect(state.acceptRequests).toHaveLength(1);
});

test("maximum safe response totals remain readable without hiding OK", async ({ page }, info) => {
  await mockUsage(page); await page.goto("/sync?reports=import");
  const files = csvFiles.map((file, index) => index ? file : { ...file,
    content: `${file.content.split("\r\n")[0]}\r\nagent-power,Clinical assistant,User-created agent,2,1,${Number.MAX_SAFE_INTEGER},"Sep 12, 2026"\r\n` });
  await upload(page, files); await accept(page); await imported(page);
  const summary = modal(page).getByRole("region", { name: "Imported CSV summary" });
  await expect(summary.locator("dd")).toHaveText(["1", "104", Number.MAX_SAFE_INTEGER.toLocaleString("en-US")]);
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await summary.locator("dd").last().evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(summary).toBeInViewport({ ratio: 1 }); await expect(modal(page).getByRole("button", { name: "OK" })).toBeInViewport({ ratio: 1 });
  await captureCsvReportScreenshot(page, info, "success");
});

test("confirmed cancellation disposes late streamed staging and never restores it into a fresh import", async ({ page }) => {
  const held = gate(), state = await mockUsage(page, { stageResponseGate: held.promise });
  try {
    await page.goto("/sync?reports=import"); await upload(page, [csvFiles[0]]);
    await expect.poll(() => state.stages.length).toBe(1);
    await modal(page).getByRole("button", { name: "Cancel import", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Discard staged import", exact: true })).toBeEnabled();
    await modal(page).getByRole("button", { name: "Discard staged import", exact: true }).click();
    held.resolve();
    await expect(modal(page)).toBeHidden(); await expect.poll(() => state.discardedStages.length).toBe(1);
    await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
    await expect(modal(page)).not.toContainText(csvFiles[0].name);
    expect(state.acceptRequests).toEqual([]);
    expect(await modal(page).getByLabel("CSV report files").evaluate((element: HTMLInputElement) => element.files?.length)).toBe(0);
  } finally { held.resolve(); }
});

test("fresh Add CSV reports ignores unrelated saved staging", async ({ page }) => {
  const state = await mockUsage(page, { staged: true });
  await page.goto("/sync?reports=manage");
  await expect(modal(page).getByRole("button", { name: /Resume import/ })).toHaveCount(0);
  await modal(page).getByRole("button", { name: "Add CSV reports" }).click();
  await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
  expect(state.stageReads).toEqual([]); expect(state.bundlePreviews).toEqual([]); expect(state.uploadBodies).toEqual([]);
  await modal(page).getByRole("button", { name: "Cancel import" }).click();
  expect(state.discardedStages).toEqual([]); expect(state.stages[0].status).toBe("active");
});

test("missing companion kinds remain actionable until an explicit complete-set acceptance", async ({ page }) => {
  const state = await mockUsage(page); await page.goto("/sync?reports=import"); await upload(page, [csvFiles[0]]);
  await expect(modal(page)).toContainText("Still needed: Users & agents, Users.");
  await expect(modal(page).getByRole("button", { name: "Import reports", exact: true })).toHaveCount(0);
  await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
  expect(state.acceptRequests).toEqual([]); await upload(page, csvFiles.slice(1)); await accept(page); await imported(page);
  expect(state.uploadBodies).toHaveLength(3); expect(new Set(state.stages.map(stage => stage.bundleId)).size).toBe(1);
  expect(state.acceptRequests).toHaveLength(1); expect(state.stages.every(stage => stage.status === "accepted")).toBe(true);
});

test("cancelling and reopening disposes only the partial draft without a Start over action", async ({ page }) => {
  const state = await mockUsage(page); await page.goto("/sync?reports=import"); await upload(page, [csvFiles[0]]);
  await expect(modal(page)).toContainText("Still needed: Users & agents, Users.");
  const first = state.stages[0];
  await expect(modal(page).getByRole("button", { name: "Start over" })).toHaveCount(0);
  await cancelDraft(page);
  expect(state.discardedStages).toEqual([first.id]); expect(state.stageReads).toContain(first.id);
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  await expect(modal(page)).not.toContainText(csvFiles[0].name); expect(state.acceptRequests).toEqual([]);
  await completedImport(page);
  expect(state.uploadBodies).toHaveLength(4); expect(state.acceptRequests).toHaveLength(1);
  expect(state.acceptRequests[0].bundleId).not.toBe(first.bundleId);
});

test("a rejected companion preserves validated files and a replacement completes the same bounded bundle", async ({ page }) => {
  const state = await mockUsage(page); await page.goto("/sync?reports=import");
  await upload(page, [...csvFiles.slice(0, 2), { name: "users-invalid.csv", content: "Unsupported,CSV\ninvalid,report" }]);
  await expect(modal(page).getByRole("alert")).toContainText("users-invalid.csv");
  await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
  expect(state.stages.map(stage => stage.kind)).toEqual(["agents", "userAgents"]); expect(state.acceptRequests).toEqual([]);
  await upload(page, [csvFiles[2]]); await accept(page); await imported(page);
  expect(state.uploadBodies).toHaveLength(4); expect(new Set(state.stages.map(stage => stage.bundleId)).size).toBe(1);
  expect(state.acceptRequests).toHaveLength(1);
});

test("more than three chosen files cannot publish even when three companions are valid", async ({ page }) => {
  const state = await mockUsage(page); await page.goto("/sync?reports=import");
  await upload(page, [...csvFiles, { name: "unexpected.csv", content: "Unsupported,CSV\ninvalid,report" }]);
  await expect(modal(page).getByRole("alert")).toContainText(/three|3/);
  expect(state.uploadBodies).toEqual([]); expect(state.acceptRequests).toEqual([]);
  await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
  await modal(page).getByRole("button", { name: "Cancel import" }).click(); await expect(modal(page)).toBeHidden();
});

test("Escape cannot dismiss acceptance and acknowledges a verified success through fresh exact reads", async ({ page }) => {
  const state = await mockUsage(page), held = gate();
  await page.route("**/api/official-usage/bundles/*/accept", async route => { await held.promise; await route.fallback(); });
  try {
    await page.goto("/sync?reports=import"); await upload(page);
    const saving = page.waitForRequest("**/api/official-usage/bundles/*/accept"); await accept(page); await saving;
    await expect(modal(page).getByRole("button", { name: "Cancel import" })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(modal(page)).toBeVisible(); expect(state.discardedStages).toEqual([]);
    held.resolve(); await imported(page);
    await expect(modal(page).getByRole("heading", { name: "Reports imported" })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(modal(page).getByRole("button", { name: "OK" })).toBeFocused();
    await page.keyboard.press("Shift+Tab"); await expect(modal(page).getByRole("button", { name: "OK" })).toBeFocused();
    const before = state.agentRequests.length;
    await page.keyboard.press("Escape"); await expect(page).toHaveURL(/\/agents$/);
    expect(state.agentRequests.length).toBeGreaterThan(before); exactVerification(state);
    expect(state.acceptRequests).toHaveLength(1); expect(state.discardedStages).toEqual([]);
  } finally { held.resolve(); }
});

test("OK waits for fresh exact report metadata rather than a removed full-admin read", async ({ page }) => {
  const state = await mockUsage(page); await page.goto("/sync?reports=import"); await completedImport(page);
  const before = state.agentRequests.length, previews = state.bundlePreviews.length, held = gate();
  await page.route(url => url.pathname === "/api/official-usage/aggregate", async route => {
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({ setId, limit: "1" });
    await held.promise; await route.fallback();
  });
  try {
    const requested = page.waitForRequest(url => new URL(url.url()).pathname === "/api/official-usage/aggregate");
    await modal(page).getByRole("button", { name: "OK" }).click(); await requested;
    await expect(modal(page)).toBeVisible(); await page.keyboard.press("Escape"); await expect(modal(page)).toBeVisible();
    held.resolve(); await expect(page).toHaveURL(/\/agents$/);
    expect(state.agentRequests.length).toBeGreaterThan(before); exactVerification(state);
    expect(state.uploadBodies).toHaveLength(3); expect(state.acceptRequests).toHaveLength(1); expect(state.bundlePreviews).toHaveLength(previews);
  } finally { held.resolve(); }
});

test("OK detects a changed active head and requires separate reviewed selection confirmation", async ({ page }) => {
  const state = await mockUsage(page, { historical: true });
  await page.goto("/sync?reports=import"); await completedImport(page);
  state.selectReport(historicalSetId); await modal(page).getByRole("button", { name: "OK" }).click();
  await expect(modal(page).getByRole("alert")).toContainText("shared report selection changed");
  expect(state.selectedSetId()).toBe(historicalSetId); expect(state.confirmations).toEqual([]);
  await confirmImportedSelection(page);
  expect(state.confirmations).toHaveLength(1);
  expect(state.confirmations[0]).toMatchObject({ setId, operation: "select", activeRevision: "3", historyRevision: "2", historyEpoch: "1" });
  await modal(page).getByRole("button", { name: "OK" }).click(); await expect(page).toHaveURL(/\/agents$/);
  exactVerification(state); expect(state.uploadBodies).toHaveLength(3); expect(state.acceptRequests).toHaveLength(1);
});

test("a deleted accepted report remains unavailable on read retry without another upload or acceptance", async ({ page }) => {
  const state = await mockUsage(page); await page.goto("/sync?reports=import"); await completedImport(page);
  state.deleteImportedReport(); await modal(page).getByRole("button", { name: "OK" }).click();
  await expect(modal(page).getByRole("alert")).toContainText("The exact synthetic report set is unavailable.");
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === "/api/official-usage/aggregate" && response.status() === 404);
  await modal(page).getByRole("button", { name: "Verify saved import" }).click(); await retried;
  await expect(modal(page).getByRole("button", { name: "OK" })).toHaveCount(0);
  exactVerification(state); expect(state.uploadBodies).toHaveLength(3); expect(state.acceptRequests).toHaveLength(1);
  expect(state.confirmations).toEqual([]); expect(state.discardedStages).toEqual([]);
  await modal(page).getByRole("button", { name: "Close saved import" }).click(); await expect(page).toHaveURL(/\/sync$/);
});

test("a lost acceptance response retries the identical reviewed operation without uploading or publishing twice", async ({ page }) => {
  const state = await mockUsage(page, { loseAcceptanceResponse: true });
  await page.goto("/sync?reports=import"); await upload(page); await accept(page);
  await expect(modal(page).getByRole("alert")).toContainText("Acceptance may already have completed");
  const before = state.bundlePreviews.length;
  await modal(page).getByRole("button", { name: "Verify acceptance" }).click(); await imported(page);
  expect(state.acceptRequests).toHaveLength(2); expect(state.acceptRequests[1]).toEqual(state.acceptRequests[0]);
  expect(state.bundlePreviews).toHaveLength(before); expect(state.uploadBodies).toHaveLength(3);
  expect(state.metadataReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: "2" });
});

for (const failure of ["transport", "incomplete lineage"] as const) test(`post-accept ${failure} verification retries only exact bounded reads`, async ({ page }) => {
  const state = await mockUsage(page); let failed = false;
  await page.route(url => url.pathname === "/api/official-usage/aggregate", route => {
    if (!state.acceptRequests.length || failed) return route.fallback();
    failed = true;
    return failure === "transport" ? route.fulfill({ status: 503, json: { code: "verification_unavailable", detail: "Saved report verification is temporarily unavailable." } })
      : route.fulfill({ json: reportPage([], { reports: { ...reports, setId, activeSetId: setId, lineages: [] } }) });
  });
  await page.goto("/sync?reports=import"); await upload(page); await accept(page);
  await expect(modal(page).getByRole("alert")).toContainText(failure === "transport" ? "temporarily unavailable" : "complete accepted report set");
  await expect(modal(page).getByRole("button", { name: "OK" })).toHaveCount(0);
  const previews = state.bundlePreviews.length;
  await modal(page).getByRole("button", { name: "Verify saved import" }).click(); await imported(page);
  expect(state.acceptRequests).toHaveLength(1); expect(state.uploadBodies).toHaveLength(3); expect(state.bundlePreviews).toHaveLength(previews);
  exactVerification(state);
});

test("duplicate acceptance preserves the existing active head until the user confirms selection", async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true, selectedSetId: historicalSetId, reusedExistingSet: true });
  await page.goto("/sync?reports=import"); await upload(page); await accept(page);
  await expect(modal(page)).toContainText("another report is currently selected");
  expect(state.confirmations).toEqual([]); expect(state.selectedSetId()).toBe(historicalSetId);
  await confirmImportedSelection(page);
  expect(state.setPreviews[0]).toMatchObject({ operation: "select", setId, activeRevision: "2", historyRevision: "1", historyEpoch: "1" });
  expect(state.confirmations).toEqual(state.setPreviews); expect(state.selectedSetId()).toBe(setId);
  expect(state.metadataReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: "3" });
  exactVerification(state); expect(state.acceptRequests).toHaveLength(1);
});

test("a newer active head after duplicate acceptance still requires a fresh reviewed selection", async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true, reusedExistingSet: true }); let changed = false;
  await page.route(url => url.pathname === "/api/official-usage/aggregate", route => {
    if (state.acceptRequests.length && !changed) { state.selectReport(historicalSetId); changed = true; }
    return route.fallback();
  });
  await page.goto("/sync?reports=import"); await upload(page); await accept(page);
  await expect(modal(page)).toContainText("another report is currently selected");
  expect(state.confirmations).toEqual([]); expect(state.selectedSetId()).toBe(historicalSetId);
  await confirmImportedSelection(page);
  expect(state.setPreviews[0]).toMatchObject({ operation: "select", setId, activeRevision: "3" });
  expect(state.metadataReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: "4" });
  expect(state.acceptRequests).toHaveLength(1); expect(state.uploadBodies).toHaveLength(3); exactVerification(state);
});

test("read-only snapshot preserves raw metrics, unknown source freshness and bounded provenance", async ({ page }, info) => {
  const state = await mockUsage(page, { active: true, role: "Viewer" });
  await page.goto("/sync?reports=snapshot"); await snapshotShell(page);
  const totals = modal(page).getByRole("region", { name: "Snapshot tenant totals" });
  await expect(totals.locator(":scope > div")).toHaveCount(2);
  await expect(totals).toContainText("2,061"); await expect(totals).toContainText("103");
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(50);
  await expect(modal(page).getByRole("button", { name: /Add CSV reports|Delete report set/ })).toHaveCount(0);
  expect(state.userRequests).toEqual([]); expect(state.commands).toEqual([]);
  if (info.project.name === "desktop") expect((await agentRows(page).boundingBox())!.y).toBeLessThan(760);
  await expect(modal(page).getByText(/Import time does not establish/)).toBeHidden();
  await modal(page).getByText("Report sources", { exact: true }).click();
  await expect(modal(page).getByText(/Import time does not establish/)).toBeVisible();
  await expect(modal(page).getByRole("region", { name: "Report provenance" })).toContainText("source freshness unknown");
  await agentRows(page).getByRole("button", { name: "Clinical assistant", exact: true }).click();
  const detail = modal(page).getByRole("region", { name: "Exact reported agent details" });
  await expect(detail).toContainText("Licensed occurrences: 2. Unlicensed occurrences: 1.");
  await expect(detail).toContainText("Distinct active users: 1.");
  await expect(detail).toContainText("Agents export: 1,048; Users & agents: 1,048");
  await accessible(page); await page.screenshot({ path: info.outputPath("raw-report-evidence.png") });
});

async function scrolling(page: Page, pane: Locator, dismissal: string) {
  await expect(modal(page).locator(".usage-modal-content")).toHaveCSS("overflow-y", "hidden");
  await expect(pane).toHaveCSS("overflow-y", "auto");
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  const metrics = await pane.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(metrics.height).toBeGreaterThan(150); expect(metrics.scrollHeight).toBeGreaterThan(metrics.height);
  const bounds = (await pane.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0); expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const background = await page.evaluate(() => window.scrollY), top = () => pane.evaluate(element => element.scrollTop);
  await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2);
  if (await top() > 0) await page.mouse.wheel(0, -metrics.scrollHeight);
  await expect.poll(top).toBe(0); await page.mouse.wheel(0, metrics.height / 2); await expect.poll(top).toBeGreaterThan(0);
  const wheel = await top();
  await page.mouse.wheel(0, -metrics.scrollHeight); await expect.poll(top).toBe(0);
  await pane.focus(); await expect(pane).toBeFocused(); expect(await top()).toBe(0);
  await page.keyboard.press("PageDown"); await expect.poll(top).toBeGreaterThan(0);
  await expect(modal(page).locator(".usage-modal-header")).toBeInViewport({ ratio: 1 });
  await modal(page).getByRole("button", { name: dismissal, exact: true }).scrollIntoViewIfNeeded();
  await expect(modal(page).getByRole("button", { name: dismissal, exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(background);
  await test.info().attach("report-pane-scroll", { body: JSON.stringify({ ...metrics, bounds, wheel, keyboard: await top() }), contentType: "application/json" });
}
for (const role of ["Admin", "Viewer"] as const) for (const view of ["manage", "snapshot"] as const) {
  test(`${role} ${view} supports actual wheel and keyboard scrolling without moving the document`, async ({ page }) => {
    const state = await mockUsage(page, { active: true, historical: true, role, additionalSavedSets: 51 });
    await page.goto(`/sync?reports=${view}`);
    await expect((view === "manage" ? history(page) : agentRows(page)).locator("tbody tr")).toHaveCount(50);
    const pane = modal(page).getByRole("region", { name: view === "manage" ? "Manage saved reports" : "Snapshot inspection", exact: true });
    await expect(pane).toHaveAttribute("tabindex", "0");
    await scrolling(page, pane, view === "manage" ? "Close reports" : "Back to reports");
    expect(state.commands).toEqual([]);
  });
}

test("validation errors retain accessible upload, provenance and cancellation at every viewport", async ({ page }, info) => {
  await mockUsage(page); await page.goto("/sync?reports=import");
  await upload(page, [{ name: "invalid.csv", content: "Unsupported,CSV\ninvalid,report" }]);
  await expect(modal(page).getByRole("alert")).toContainText("invalid.csv");
  await modal(page).getByRole("button", { name: "Choose CSV files" }).scrollIntoViewIfNeeded();
  await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeInViewport({ ratio: 1 });
  await modal(page).getByRole("button", { name: "Cancel import" }).scrollIntoViewIfNeeded();
  await expect(modal(page).getByRole("button", { name: "Cancel import" })).toBeInViewport({ ratio: 1 });
  await accessible(page); await page.screenshot({ path: info.outputPath("invalid-report.png") });
  await modal(page).getByRole("button", { name: "Cancel import" }).click(); await expect(modal(page)).toBeHidden();
});

test("saved staging links read exact receipts and companion previews without publication", async ({ page }) => {
  const state = await mockUsage(page, { staged: true }), stagingId = state.stages[0].id;
  await page.goto(`/official-usage?staging=${stagingId}`);
  await expect(page).toHaveURL(`/sync?reports=import&staging=${stagingId}`);
  await expect(modal(page).getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
  await expect(modal(page)).toContainText("Agents - 103 rows");
  expect(state.stageReads).toEqual([stagingId]); expect(state.bundlePreviews.at(-1)?.bundleId).toBe(state.stages[0].bundleId);
  expect(state.acceptRequests).toEqual([]); expect(state.uploadBodies).toEqual([]);
  await cancelDraft(page); expect(state.discardedStages).toEqual([stagingId]);
  await expect(page.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
});

test("agent sorts, reach, dates and self-excluding creator facets feed one native selection-pinned CSV", async ({ page }) => {
  const state = await mockUsage(page, { active: true });
  await page.addInitScript(() => { URL.createObjectURL = () => { throw new Error("Native CSV exports must not use browser blobs"); }; });
  await page.goto("/sync?reports=snapshot"); await expect(agentRows(page).locator("tbody tr")).toHaveCount(50);
  const sort = modal(page).getByLabel("Sort agents", { exact: true });
  await expect(sort.locator("option")).toHaveCount(12);
  await sort.selectOption("responses:asc"); await expect(agentRows(page).locator("tbody tr").first()).toContainText("Prompt Coach");
  await sort.selectOption("licensedUsers:desc"); await expect(agentRows(page).locator("tbody tr").first()).toContainText("Clinical assistant");
  await sort.selectOption("unlicensedUsers:asc"); await expect(agentRows(page).locator("tbody tr").first()).toContainText("Synthetic agent");
  await sort.selectOption("activeUsers:desc"); await expect.poll(() => state.agentRequests.at(-1)?.get("sort")).toBe("activeUsers");
  await modal(page).getByRole("button", { name: "Next agents", exact: true }).click();
  await expect.poll(() => state.agentRequests.at(-1)?.get("cursor")).toBe("fixture:50");
  const reach = agentRows(page).getByRole("button", { name: "Active users", exact: true });
  await reach.focus(); await reach.press("Enter");
  await expect.poll(() => state.agentRequests.at(-1)?.get("order")).toBe("asc");
  expect(state.agentRequests.at(-1)?.has("cursor")).toBe(false); await expect(reach).toBeFocused();
  await expect(reach.locator("..")).toHaveAttribute("aria-sort", "ascending");
  await modal(page).getByLabel("Activity start date", { exact: true }).fill("2026-09-11");
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(1); await expect(agentRows(page)).toContainText("Clinical assistant");
  await expect(modal(page).getByRole("region", { name: "Snapshot tenant totals" })).toContainText("2,061");
  await modal(page).getByRole("button", { name: "Clear filters", exact: true }).click();
  await modal(page).getByRole("combobox", { name: "Creator type", exact: true }).selectOption("~string:Agent built by Microsoft");
  await modal(page).getByLabel("Search agents").fill("Prompt"); await expect(agentRows(page).locator("tbody tr")).toHaveCount(1);
  await sort.selectOption("name:asc"); await expect(agentRows(page).getByRole("columnheader", { name: "Agent", exact: true })).toHaveAttribute("aria-sort", "ascending");
  const download = page.waitForEvent("download"); await modal(page).getByRole("button", { name: "Export agent CSV" }).click();
  await modal(page).getByRole("link", { name: "Download CSV" }).click(); const file = await download;
  const csv = await downloadedCsvRows(file);
  expect(file.suggestedFilename()).toBe("official-agents.csv"); expect(csv).toHaveLength(1);
  expect(Object.keys(csv[0])).toEqual([...reportExportColumns.official_agents]);
  expect(csv[0]).toMatchObject({ agentId: "agent-low", agentName: "Prompt Coach", responsesSentToUsers: "3", reportSetId: setId });
  expect(Object.fromEntries(state.exportRequests[0])).toMatchObject({ setId, search: "Prompt", creatorType: "Agent built by Microsoft", sort: "name", order: "asc" });
  expect(state.exportSubmissions).toEqual([{ kind: "official_agents", selectionId: expect.any(String), idempotencyKey: expect.any(String) }]);
  expect(state.exportStatusBytes).toHaveLength(2); expect(state.exportStatusBytes.every(bytes => bytes < 1024)).toBe(true);
  expect(state.exportDownloads).toEqual([true]); expect(state.userRequests).toEqual([]);
});

for (const source of ["summary", "history"] as const) test(`CSV ${source} retries a failed native read without automatic refresh or mutation`, async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true }); let available = false, reads = 0;
  await page.route(url => url.pathname === "/api/official-usage/history" && url.searchParams.get("limit") === (source === "summary" ? "1" : "50"), route => {
    reads++; return available ? route.fallback() : route.fulfill({ status: 503, json: { code: "history_unavailable", detail: "Saved reports are temporarily unavailable." } });
  });
  await page.goto(source === "summary" ? "/sync" : "/sync?reports=manage");
  const section = source === "summary" ? page.getByRole("region", { name: "CSV usage reports", exact: true }) : modal(page);
  await expect(section.getByRole("alert")).toContainText("Saved reports are temporarily unavailable.");
  const before = reads; available = true; await section.getByRole("button", { name: /^Retry/ }).click();
  await expect.poll(() => reads).toBeGreaterThan(before); await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(section.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  if (source === "history") await expect(history(page).locator("tbody tr")).toHaveCount(2);
  else { await expect(section).toContainText("Jun 1, 2026"); await expect(section).toContainText("Sep 12, 2026"); }
  expect(state.commands).toEqual([]);
});

test("Manage reports retains a 53-set root across pages and exposes observations separately from report selection", async ({ page }, info) => {
  const state = await mockUsage(page, { active: true, historical: true, additionalSavedSets: 51 });
  await page.goto("/sync?reports=manage"); await expect(history(page).locator("tbody tr")).toHaveCount(50);
  await expect(history(page)).toContainText("53 saved report sets"); await expect(modal(page).getByRole("table")).toHaveCount(1);
  const first = state.historyRequests.filter(query => query.get("limit") === "50").at(-1)!;
  await history(page).getByRole("button", { name: "Next report sets" }).click(); await expect(history(page).locator("tbody tr")).toHaveCount(3);
  const next = state.historyRequests.at(-1)!;
  expect(first.has("cursor")).toBe(false); expect(next.get("cursor")).toBe("fixture:50"); expect(next.get("selectionId")).toMatch(/^[a-f0-9-]{36}$/);
  await history(page).getByRole("button", { name: "Previous report sets" }).click(); await expect(history(page).locator("tbody tr")).toHaveCount(50);
  const current = history(page).getByRole("row").filter({ has: page.getByRole("cell", { name: /^Current/ }) });
  await current.getByRole("button", { name: "Report observations" }).click();
  await expect(history(page).getByRole("region", { name: "Report observations", exact: true }).getByRole("listitem")).toHaveCount(3);
  await current.getByRole("button", { name: "View report" }).click(); await snapshotShell(page);
  await expect(agentRows(page).locator("tbody tr")).toHaveCount(50);
  await expect(modal(page).getByRole("button", { name: /Delete report set|Make current/ })).toHaveCount(0);
  expect(state.commands).toEqual([]); expect(state.selectedSetId()).toBe(setId);
  await accessible(page); await page.screenshot({ path: info.outputPath("saved-report-inspection.png") });
});

test("retained-set deletion stays inside an accessible native confirmation and invalidates saved reports", async ({ page }) => {
  const state = await mockUsage(page, { active: true }); await page.goto("/sync?reports=manage");
  const trigger = history(page).getByRole("button", { name: "Delete report set", exact: true });
  await expect(trigger).toBeEnabled(); await accessible(page); await trigger.click();
  const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
  await expect(confirmation.getByRole("button", { name: "Delete report set", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape"); await expect(confirmation).toHaveCount(0); await expect(trigger).toBeFocused();
  await trigger.click(); await confirmation.getByRole("button", { name: "Delete report set", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(modal(page).getByRole("status").filter({ hasText: "Report set deleted." })).toBeFocused();
  await expect(history(page)).toContainText("0 saved report sets");
  expect(state.confirmations).toHaveLength(1); expect(state.selectedSetId()).toBeNull();
  await modal(page).getByRole("button", { name: "Close reports" }).click();
  await page.goto(`/sync?reports=snapshot&snapshot=${setId}`);
  await expect(modal(page).getByRole("alert")).toContainText("The exact synthetic report set is unavailable.");
  await expect(modal(page).getByRole("button", { name: "Export agent CSV" })).toBeDisabled();
});

test("in-flight deletion cannot be dismissed or submitted twice", async ({ page }) => {
  const state = await mockUsage(page, { active: true }), held = gate();
  await page.route("**/api/official-usage/confirmations/*", async route => { await held.promise; await route.fallback(); });
  try {
    await page.goto("/sync?reports=manage"); await history(page).getByRole("button", { name: "Delete report set" }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
    const remove = confirmation.getByRole("button", { name: "Delete report set", exact: true });
    const requested = page.waitForRequest("**/api/official-usage/confirmations/*"); await remove.click(); await requested;
    await expect(remove).toBeDisabled(); await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await expect(confirmation).toBeVisible();
    held.resolve(); await expect(confirmation).toHaveCount(0);
    await expect(history(page)).toContainText("0 saved report sets");
    expect(state.confirmations).toHaveLength(1); expect(state.confirmations[0]).toMatchObject({ setId, operation: "delete", activeRevision: "2", historyRevision: "1", historyEpoch: "1" });
    expect(state.acceptRequests).toEqual([]);
  } finally { held.resolve(); }
});

test("an expired confirmation keeps its error accessible and reloads history instead of replaying a destructive command", async ({ page }) => {
  const state = await mockUsage(page, { active: true });
  await page.route("**/api/official-usage/confirmations/*", route => route.fulfill({ status: 409,
    json: { code: "confirmation_expired", detail: "The reviewed deletion expired. Review the set again." } }));
  await page.goto("/sync?reports=manage"); const trigger = history(page).getByRole("button", { name: "Delete report set" });
  await trigger.click(); const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
  await confirmation.getByRole("button", { name: "Delete report set", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("The reviewed deletion expired.");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await expect(confirmation.getByRole("button", { name: "Reload report history" })).toBeEnabled();
  await expect(confirmation.getByRole("button", { name: "Delete report set", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(confirmation).toHaveCount(0); await expect(trigger).toBeFocused();
  await expect(history(page).getByRole("cell", { name: /^Current/ })).toBeVisible();
  expect(state.confirmations).toEqual([]);
});
