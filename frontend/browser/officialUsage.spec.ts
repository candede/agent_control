import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { parseOfficialUsageReport } from "../../backend/src/services/officialUsageParser";
import { buildOfficialUsageAggregateView } from "../../backend/src/services/officialUsageViews";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import type { AcceptedOfficialUsageReports, ParsedOfficialUsageReport, PublishedOfficialUsage } from "../../backend/src/types/officialUsage";
import type { OfficialUsageAdminState, OfficialUsageHistoryView, OfficialUsageStagingPreview } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { downloadedCsvRows, usageCsvFixture } from "./usageCsvFixture";
import { activeWithoutPaidUsersFixture } from "./userCohortFixtures";

const instant = "2026-09-12T14:45:00.000Z";
const setId = "11111111-1111-4111-8111-111111111111";
const historicalSetId = "99999999-9999-4999-8999-999999999999";
const unexpectedApiRequests = new WeakMap<Page, string[]>();
const csvFiles = [
  {
    name: "DeclarativeAgents_Agents_30_2026-09-12T14-41-53.csv",
    content: "\uFEFFAgent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\r\n"
      + 'agent-power,Clinical assistant,User-created agent,2,1,"1,048","Sep 12, 2026"\r\n'
      + 'agent-low,Prompt Coach,Agent built by Microsoft,1,1,3,"Aug 14, 2026"\r\n'
      + Array.from({ length: 101 }, (_, index) => `agent-${index},Synthetic agent ${index},Agent built by your org,1,0,10,"Sep 10, 2026"\r\n`).join(""),
  },
  {
    name: "DeclarativeAgents_Users___agents_30_2026-09-12T14-42-01.csv",
    content: "\uFEFFAgent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\r\n"
      + 'agent-power,Clinical assistant,User-created agent,power@example.invalid,"1,048","Sep 12, 2026"\r\n'
      + 'agent-low,Prompt Coach,Agent built by Microsoft,low@example.invalid,3,"Sep 12, 2026"\r\n'
      + Array.from({ length: 101 }, (_, index) => `agent-${index},Synthetic agent ${index},Agent built by your org,person-${index}@example.invalid,10,"Sep 10, 2026"\r\n`).join(""),
  },
  {
    name: "DeclarativeAgents_Users_30_2026-09-12T14-41-45.csv",
    content: "\uFEFFUsername,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\r\n"
      + 'power@example.invalid,Power User,1,"1,052","Sep 12, 2026"\r\n'
      + 'low@example.invalid,Low User,1,3,"Aug 14, 2026"\r\n'
      + "zero@example.invalid,Zero User,0,0,\r\n"
      + Array.from({ length: 101 }, (_, index) => `person-${index}@example.invalid,Synthetic Person ${index},1,10,"Sep 10, 2026"\r\n`).join(""),
  },
];

function accepted<T extends ParsedOfficialUsageReport>(report: T, index: number) {
  return {
    ...report,
    lineage: {
      kind: report.kind, versionId: `version-${index}`, fileHash: `${index}`.repeat(64),
      parserVersion: report.parserVersion, schemaVersion: report.schemaVersion,
      reportingPeriod: report.reportingPeriod, sourceAsOfProvenance: report.sourceAsOfProvenance,
      sourceFreshness: report.sourceFreshness, acceptedAt: instant, rowCount: report.rows.length,
      warnings: report.warnings, reconciliation: {}, supersedesVersionId: null,
    },
  };
}

async function mockUsage(page: Page, options: { role?: "Admin" | "Viewer"; active?: boolean; historical?: boolean } = {}) {
  await page.clock.setFixedTime(new Date(instant));
  unexpectedApiRequests.set(page, await mockLayoutApi(page));
  let bundleId = "22222222-2222-4222-8222-222222222222";
  let isAccepted = options.active ?? false;
  let hasImportHistory = isAccepted;
  let activeRevision = isAccepted ? 2 : 1;
  const stages: OfficialUsageStagingPreview[] = [];
  const reports: AcceptedOfficialUsageReports = {};
  const uploadBodies: string[] = [];
  const userRequests: URLSearchParams[] = [];
  const agentRequests: URLSearchParams[] = [];
  const exportRequests: URLSearchParams[] = [];
  const apiRequests: string[] = [];
  const commands: string[] = [];
  function storeReport(report: ParsedOfficialUsageReport, index: number, target = reports) {
    if (report.kind === "agents") target.agents = accepted(report, index);
    else if (report.kind === "userAgents") target.userAgents = accepted(report, index);
    else target.users = accepted(report, index);
  }
  if (isAccepted) csvFiles.forEach((file, index) => storeReport(parseOfficialUsageReport(Buffer.from(file.content)), index + 1));
  const activeSet = {
    id: setId, bundleId, reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "activity_range" as const },
    supersedesSetId: null, complete: true, kinds: ["agents", "userAgents", "users"] as const,
    acceptedAt: instant, deletedAt: null, createdAt: instant, expiresAt: "2027-03-11T14:45:00.000Z",
  };
  const historicalSet = {
    ...activeSet, id: historicalSetId, bundleId: "88888888-8888-4888-8888-888888888888",
    reportingPeriod: { startDate: "2026-06-01", endDate: "2026-06-01", provenance: "activity_range" as const },
    acceptedAt: "2026-06-02T10:00:00.000Z", createdAt: "2026-06-02T10:00:00.000Z",
  };
  const historicalReports: AcceptedOfficialUsageReports = {};
  if (options.historical) {
    const rows = [
      "historical-report-only,Historical report-only assistant,User-created agent,1,0,17,2026-06-01\r\n",
      "historical-report-only,Historical report-only assistant,User-created agent,historical@example.invalid,17,2026-06-01\r\n"
        + "historical-bridge-only,Bridge-only retained assistant,User-created agent,bridge@example.invalid,5,2026-06-01\r\n",
      "historical@example.invalid,Historical User,1,17,2026-06-01\r\nbridge@example.invalid,Bridge User,1,5,2026-06-01\r\n",
    ];
    csvFiles.forEach((file, index) => {
      storeReport(parseOfficialUsageReport(Buffer.from(`${file.content.split("\r\n")[0]}\r\n${rows[index]}`)), index + 4, historicalReports);
    });
    for (const report of Object.values(historicalReports)) report.lineage.acceptedAt = historicalSet.acceptedAt;
  }
  function published(selectedSetId?: string | null): PublishedOfficialUsage {
    const historical = options.historical && selectedSetId === historicalSetId;
    return {
      activeRevision,
      activeSet: historical ? { ...historicalSet, kinds: [...historicalSet.kinds] } : isAccepted ? { ...activeSet, bundleId, kinds: [...activeSet.kinds] } : null,
      reports: historical ? historicalReports : isAccepted ? reports : {}, retainedCompleteSets: (isAccepted ? 1 : 0) + (options.historical ? 1 : 0),
      retainedIncompleteSets: 0, hasImportHistory, activeSelectionIncomplete: false,
    };
  }
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    apiRequests.push(path);
    if (path.startsWith("/api/official-usage/") && request.method() !== "GET") commands.push(`${request.method()} ${path}`);
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (options.role === "Viewer" && path.startsWith("/api/official-usage/")
      && (request.method() !== "GET" || /\/(?:admin|staging|bundles|sets|confirmations)(?:\/|$)/.test(path))) {
      unexpectedApiRequests.get(page)!.push(`Forbidden Viewer request: ${request.method()} ${path}`);
      return respond({ code: "forbidden", detail: "Viewer report inspection must not request administration." }, 403);
    }
    if (["/api/official-usage/aggregate", "/api/official-usage/users", "/api/official-usage/aggregate.csv"].includes(path)) {
      expect(request.method()).toBe("GET");
      const requestedSet = url.searchParams.get("setId");
      if (requestedSet && !(isAccepted && requestedSet === setId) && !(options.historical && requestedSet === historicalSetId)) {
        return respond({ code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." }, 404);
      }
    }
    if (path === "/api/me") return respond({
      user: { displayName: "Usage administrator", username: "admin@example.invalid", homeAccountId: "usage-admin", roles: [`AgentControl.${options.role ?? "Admin"}`] },
      csrfToken: "fixture-csrf", roleAssignmentRequired: false,
    });
    if (path === "/api/workbench/metadata") return respond({ views: workbenchViews, actions: workbenchActions });
    if (path === "/api/capabilities" || path === "/api/capabilities/check") return respond({
      value: capabilityDefinitions.map(definition => ({
        definition, decision: {
          capabilityId: definition.id, status: definition.mode === "local" ? "available" : "unavailable",
          authorized: definition.mode === "local", fresh: true,
          verification: "local", previewQualification: "not_required", remediation: [],
        },
      })),
    });
    if (path === "/api/official-usage/admin") {
      const state: OfficialUsageAdminState = {
        activeSetId: isAccepted ? setId : null, activeRevision,
        staging: isAccepted ? [] : stages, sets: [
          ...isAccepted ? [{ ...activeSet, bundleId, kinds: [...activeSet.kinds] }] : [],
          ...options.historical ? [{ ...historicalSet, kinds: [...historicalSet.kinds] }] : [],
        ],
      };
      return respond(state);
    }
    if (path === "/api/official-usage/staging") {
      const body = request.postDataBuffer()!.toString("utf8");
      uploadBodies.push(body);
      const file = csvFiles.find(value => body.includes(`filename="${value.name}"`));
      if (!file) throw new Error("Unexpected upload fixture");
      const boundary = request.headers()["content-type"].split("boundary=")[1];
      const part = body.split(`--${boundary}`).find(value => value.includes('name="file";'));
      if (!part) throw new Error("Missing CSV multipart part");
      const csv = part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
      const report = parseOfficialUsageReport(Buffer.from(csv));
      bundleId = body.match(/name="bundleId"\r\n\r\n([^\r]+)/)![1];
      const index = csvFiles.indexOf(file) + 1;
      const stage: OfficialUsageStagingPreview = {
        id: `33333333-3333-4333-8333-33333333333${index}`, revision: 1, status: "active",
        kind: report.kind, fileHash: `${index}`.repeat(64), parserVersion: report.parserVersion,
        schemaVersion: report.schemaVersion, bundleId, correctionOfSetId: null,
        reportingPeriod: report.reportingPeriod, sourceAsOf: null, sourceAsOfProvenance: "absent",
        sourceFreshness: "unknown", downloadedAt: null, rowCount: report.rows.length,
        warnings: report.warnings, reconciliation: {}, activeRevision: 1, acceptedVersionId: null,
        acceptedSetId: null, createdAt: instant, expiresAt: "2026-09-12T15:15:00.000Z", acceptedAt: null,
      };
      stages.push(stage);
      storeReport(report, index);
      return respond(stage, 201);
    }
    if (path.endsWith("/preview") && path.includes("/sets/")) return respond({
      id: "confirmation-1", operation: request.postDataJSON().operation, setId,
      expectedRevision: 2, confirmationHash: "c".repeat(64), activeSetId: setId,
      expiresAt: "2026-09-12T15:00:00.000Z",
    });
    if (path.includes("/confirmations/")) {
      isAccepted = false;
      activeRevision += 1;
      return respond({ activeSetId: null, activeRevision });
    }
    if (path.endsWith("/preview") && path.includes("/bundles/")) return respond({
      bundleId, bundleHash: "a".repeat(64), expectedActiveRevision: 1, staging: stages,
      acceptedVersions: [], missingKinds: activeSet.kinds.filter(kind => !stages.some(stage => stage.kind === kind)),
      reconciliation: {},
    });
    if (path.endsWith("/accept") && path.includes("/bundles/")) {
      isAccepted = true;
      hasImportHistory = true;
      activeRevision += 1;
      return respond({ setId, versionId: "version-1", activeRevision, complete: true });
    }
    if (path === "/api/official-usage/aggregate") {
      agentRequests.push(url.searchParams);
      return respond(buildOfficialUsageAggregateView(published(url.searchParams.get("setId")), [], {
        staleAfterDays: 35, now: new Date(instant),
        ...Object.fromEntries(url.searchParams),
        agentSortBy: (["agentName", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"] as const).find(value => value === url.searchParams.get("sortBy")),
        sortDirection: url.searchParams.get("sortDirection") === "asc" ? "asc" : "desc",
        limit: Number(url.searchParams.get("limit") ?? 100), offset: Number(url.searchParams.get("offset") ?? 0),
      }));
    }
    if (path === "/api/official-usage/aggregate.csv") {
      exportRequests.push(url.searchParams);
      const view = buildOfficialUsageAggregateView(published(url.searchParams.get("setId")), [], {
        staleAfterDays: 35, now: new Date(instant), ...Object.fromEntries(url.searchParams),
        agentSortBy: (["agentName", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"] as const).find(value => value === url.searchParams.get("sortBy")),
        sortDirection: url.searchParams.get("sortDirection") === "asc" ? "asc" : "desc",
        limit: 100_000, offset: 0,
      });
      return route.fulfill({
        contentType: "text/csv",
        headers: { "Content-Disposition": 'attachment; filename="official-agent-usage.csv"' },
        body: usageCsvFixture(["agentId", "agentName", "responsesSentToUsers", "reportSetId"],
          view.agents.value.map(agent => ({ ...agent, reportSetId: view.activeSet?.id }))),
      });
    }
    if (path === "/api/official-usage/users") {
      userRequests.push(url.searchParams);
      expect(url.searchParams.get("licenseCohort")).toBe("active_without_paid");
      return respond(activeWithoutPaidUsersFixture({
        staleAfterDays: 35, now: new Date(instant),
        ...Object.fromEntries(url.searchParams),
        userSortBy: (["displayName", "responses", "agentsUsed", "lastActivity"] as const).find(value => value === url.searchParams.get("sortBy")),
        lowResponseThreshold: Number(url.searchParams.get("lowResponseThreshold") ?? 5),
        responsesOnly: url.searchParams.get("responsesOnly") === "true",
        limit: Number(url.searchParams.get("limit") ?? 100), offset: Number(url.searchParams.get("offset") ?? 0),
      }, published()));
    }
    if (path === "/api/official-usage/history") {
      const retained = [
        ...isAccepted ? [{ set: { ...activeSet, bundleId }, reports }] : [],
        ...options.historical ? [{ set: historicalSet, reports: historicalReports }] : [],
      ];
      const bundles = retained.map(({ set, reports: sourceReports }): OfficialUsageHistoryView["bundles"]["value"][number] => {
        const observations = Object.values(sourceReports).map(report => ({
          versionId: report.lineage.versionId, kind: report.kind, contentHash: report.lineage.fileHash,
          rowCount: report.rows.length, uniquePayloadCount: report.rows.length, repeatedRowsReused: 0, lineage: report.lineage,
        }));
        const rowCount = observations.reduce((sum, report) => sum + report.rowCount, 0);
        return {
          ...set, kinds: [...set.kinds], isActive: isAccepted && set.id === setId,
          observationCount: observations.length, rowCount, uniquePayloadCount: rowCount, repeatedRowsReused: 0,
          reportingWindowKnown: false, activityRangeIsCoverage: false, observations,
        };
      });
      const observations = bundles.flatMap(bundle => bundle.observations);
      const rowCount = observations.reduce((sum, report) => sum + report.rowCount, 0);
      const history: OfficialUsageHistoryView = {
        summary: {
          importCount: bundles.length, uniqueObservationCount: observations.length,
          observationRowCount: rowCount, uniquePayloadCount: rowCount, repeatedRowsReused: 0,
          earliestObservedAt: options.historical ? historicalSet.acceptedAt : isAccepted ? instant : null,
          latestObservedAt: isAccepted ? instant : options.historical ? historicalSet.acceptedAt : null,
          activityDateRange: {
            earliestDateUtc: options.historical ? "2026-06-01" : isAccepted ? "2026-08-14" : null,
            latestDateUtc: isAccepted ? "2026-09-12" : options.historical ? "2026-06-01" : null,
            provenance: "last_activity_dates", provesReportingCoverage: false,
          },
          reportingWindows: { knownCount: 0, unknownCount: bundles.length, overlappingKnownWindowCount: 0, additive: false },
          warning: { code: "rolling_snapshots_not_additive", message: "Report snapshots are not additive." },
        },
        bundles: {
          value: bundles, count: bundles.length, limit: 25, offset: 0,
        },
      };
      return respond(history);
    }
    if (path === "/api/agents") return respond({
      value: [], count: 0, summary: { total: 0, allowed: 0, blocked: 0 }, filteredSummary: { total: 0, allowed: 0, blocked: 0 },
      facets: { publishers: [], availability: [], hosts: [], platforms: [] }, snapshot: null,
    });
    return route.fallback();
  });
  return { uploadBodies, userRequests, agentRequests, exportRequests, apiRequests, commands };
}

async function expectReportPaneScrolling(page: Page, pane: Locator, name: string) {
  await test.step(`${name}: bounded wheel and keyboard scrolling`, async () => {
    const modal = page.locator("dialog.official-usage-modal");
    await expect(modal.locator(".usage-modal-content")).toHaveCSS("overflow-y", "hidden");
    await expect(pane).toHaveCSS("overflow-y", "auto");
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const metrics = await pane.evaluate(element => ({
      clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
    }));
    expect(metrics.clientHeight, "The report pane must have usable vertical space").toBeGreaterThan(150);
    expect(metrics.scrollHeight, "Expanded source evidence must overflow the actual pane").toBeGreaterThan(metrics.clientHeight);
    const bounds = await pane.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    const documentScroll = await page.evaluate(() => window.scrollY);
    const scrollTop = () => pane.evaluate(element => element.scrollTop);

    const pointer = { x: bounds!.x + 8, y: bounds!.y + bounds!.height / 2 };
    expect(await pane.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), pointer),
      "The wheel must target the actual report pane").toBe(true);
    await page.mouse.move(pointer.x, pointer.y);
    // Wheeling up from zero can latch the background rather than the report pane.
    if (await scrollTop() > 0) await page.mouse.wheel(0, -metrics.scrollHeight);
    await expect.poll(scrollTop).toBe(0);
    await page.mouse.wheel(0, metrics.clientHeight / 2);
    await expect.poll(scrollTop, { message: "A real wheel event must scroll the report pane" }).toBeGreaterThan(0);
    const wheelScrollTop = await scrollTop();

    await page.mouse.wheel(0, -metrics.scrollHeight);
    await expect.poll(scrollTop).toBe(0);
    await pane.focus();
    await expect(pane).toBeFocused();
    expect(await scrollTop(), "Focusing the pane must not satisfy the keyboard scroll assertion").toBe(0);
    await page.keyboard.press("PageDown");
    await expect.poll(scrollTop, { message: "PageDown must scroll the directly focused report pane" }).toBeGreaterThan(0);
    const keyboardScrollTop = await scrollTop();
    await expect(modal.locator(".usage-modal-header")).toBeInViewport({ ratio: 1 });
    await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY), "The document must not scroll behind the dialog").toBe(documentScroll);
    await test.info().attach(`${name}-scroll-measurements`, {
      body: JSON.stringify({ ...metrics, bounds, wheelScrollTop, keyboardScrollTop }, null, 2),
      contentType: "application/json",
    });
  });
}

test.beforeEach(async ({ context }) => {
  await context.route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => route.abort());
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  const unexpected = unexpectedApiRequests.get(page);
  if (unexpected) expect(unexpected).toEqual([]);
});

for (const scenario of [
  { legacy: "/official-usage", canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=history", canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=snapshot", canonical: "/sync?reports=snapshot", title: "Report snapshot" },
  { legacy: `/official-usage?snapshot=${setId}`, canonical: `/sync?reports=snapshot&snapshot=${setId}`, title: "Report snapshot" },
  { legacy: `/official-usage?view=history&snapshot=${setId}`, canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=snapshot&window=90", canonical: "/sync?reports=snapshot&window=90", title: "Report snapshot" },
]) {
  test(`legacy link ${scenario.legacy} redirects to its exact Sync report workflow`, async ({ page }) => {
    const { agentRequests } = await mockUsage(page, { active: true, role: "Viewer" });
    await page.goto(scenario.legacy);
    await expect(page).toHaveURL(scenario.canonical);
    const modal = page.getByRole("dialog", { name: scenario.title, exact: true });
    await expect(modal).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Official usage", exact: true, includeHidden: true })).toHaveCount(0);
    await expect(page.locator(".official-usage-workbench")).toHaveCount(0);
    if (scenario.title === "Report snapshot") {
      await expect(modal.getByRole("region", { name: "Report agent rows" })).toBeVisible();
      const canonical = new URL(scenario.canonical, "http://localhost");
      expect(agentRequests.at(-1)?.get("setId")).toBe(canonical.searchParams.get("snapshot"));
      expect(agentRequests.at(-1)?.get("activityWindowDays")).toBe(canonical.searchParams.get("window") ?? (canonical.searchParams.has("snapshot") ? "365" : "30"));
    } else {
      await expect(modal.getByRole("region", { name: "Retained official usage snapshots" })).toBeVisible();
      expect(agentRequests).toEqual([]);
    }
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).toHaveURL(/\/sync$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("Viewer manages one read-only history and inspects historical report-only source evidence", async ({ page }, info) => {
  const { apiRequests, agentRequests, exportRequests, commands } = await mockUsage(page, { active: true, historical: true, role: "Viewer" });
  await page.goto("/sync");
  const csvReports = page.getByRole("region", { name: "CSV usage reports", exact: true });
  const manage = csvReports.getByRole("button", { name: "Manage reports", exact: true });
  await expect(manage).toHaveCount(1);
  await expect(csvReports.getByRole("button", { name: "Add CSV reports", exact: true })).toHaveCount(0);
  await expect(csvReports.getByRole("button", { name: "View report history", exact: true })).toHaveCount(0);
  await manage.click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  const modal = page.locator("dialog.official-usage-modal");
  const history = modal.getByRole("region", { name: "Retained official usage snapshots" });
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(modal.getByRole("table")).toHaveCount(1);
  await expect(history.getByRole("columnheader")).toHaveText(["Imported", "Reporting coverage", "Source files", "Status", "View"]);
  await expect(modal.getByRole("button", { name: /Add CSV reports|Make current|Delete retained set|Resume import|Validate and stage/ })).toHaveCount(0);
  await expect(modal.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  expect(apiRequests).not.toContain("/api/official-usage/overview");
  const oldRow = history.getByRole("row").filter({ has: page.getByRole("cell", { name: "Retained", exact: true }) });
  await expect(oldRow).toContainText("Jun 1, 2026");
  await oldRow.getByText("3 exports", { exact: true }).click();
  await expect(oldRow).toContainText("5 rows; 0 duplicate rows reused.");
  await expect(oldRow).toContainText("Original acceptance");
  await expect(oldRow).toContainText("Jun 2, 2026");
  await expect(oldRow).toContainText("content 444444444444");
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route(url => url.pathname === "/api/official-usage/aggregate" && url.searchParams.get("setId") === historicalSetId, async route => {
    await snapshotGate;
    await route.fallback();
  });
  try {
    await oldRow.getByRole("button", { name: "View snapshot", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${historicalSetId}$`));
    await expect(modal).toHaveAccessibleName("Report snapshot");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(modal.getByRole("status").filter({ hasText: "Loading retained set" })).toContainText(historicalSetId);
    await expect(modal.getByRole("region", { name: "Report agent rows" })).toHaveCount(0);
  } finally {
    releaseSnapshot();
  }
  const rows = modal.getByRole("region", { name: "Report agent rows" });
  await expect(rows.locator("tbody tr")).toHaveCount(2);
  await expect(modal.getByRole("status").filter({ hasText: "Showing retained set" })).toContainText(historicalSetId);
  await expect(rows).toContainText("Historical report-only assistant");
  const bridgeRow = rows.getByRole("row", { name: /Bridge-only retained assistant/ });
  await expect(bridgeRow).toContainText("Users & agents only");
  await expect(bridgeRow.getByRole("cell").nth(1)).toContainText("5");
  await expect(rows).not.toContainText("Clinical assistant");
  await expect(modal.getByRole("region", { name: "Snapshot tenant totals" })).toContainText("17");
  expect(agentRequests.at(-1)?.get("setId")).toBe(historicalSetId);
  expect(agentRequests.at(-1)?.get("activityWindowDays")).toBe("365");
  await rows.getByRole("button", { name: "Historical report-only assistant", exact: true }).click();
  const evidence = modal.getByRole("region", { name: "Source details for Historical report-only assistant" });
  await expect(evidence).toContainText("historical-report-only");
  await expect(evidence).toContainText("Source reports: Agents, Users & agents");
  await modal.getByText("Report quality & sources", { exact: false }).first().click();
  const files = modal.locator(".usage-source-files > details");
  await expect(files).toHaveCount(3);
  await files.first().locator("summary").click();
  await expect(files.first()).toContainText("version-4");
  await expect(files.first()).toContainText("2026-06-01 to 2026-06-01 (activity_range)");
  await expect(files.first()).toContainText("Not supplied");
  await expect(modal.getByText(/Import time does not establish source freshness/)).toBeVisible();
  await modal.getByLabel("Search agents", { exact: true }).fill("historical-report-only");
  await expect(rows.getByRole("button", { name: "Historical report-only assistant", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await modal.getByRole("button", { name: "Export agents CSV", exact: true }).click();
  expect(await downloadedCsvRows(await download)).toEqual([{
    agentId: "historical-report-only", agentName: "Historical report-only assistant", responsesSentToUsers: "17", reportSetId: historicalSetId,
  }]);
  expect(exportRequests.at(-1)?.get("setId")).toBe(historicalSetId);
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("historical-source-inspection.png") });
  await modal.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(modal.getByRole("table")).toHaveCount(1);
  await expect(history.getByRole("row").filter({ hasText: "Current" })).toContainText("Sep 12, 2026");
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  expect(apiRequests).not.toContain("/api/official-usage/users");
  expect(commands).toEqual([]);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(manage).toBeFocused();
});

test("Sync is the single report entry point and opens an accessible import dialog on demand", async ({ page }, info) => {
  const { apiRequests } = await mockUsage(page);
  await page.goto("/sync");
  await expect(page.getByRole("heading", { name: "CSV usage reports", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage reports", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "View report history", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose CSVs" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retained sets" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  const trigger = page.getByRole("button", { name: "Add CSV reports", exact: true });
  await trigger.click();
  await expect(page).toHaveURL(/\/sync\?reports=import$/);
  const modal = page.getByRole("dialog", { name: "Import CSV reports", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Choose CSVs", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(modal.getByRole("button", { name: "Close", exact: true })).toHaveClass(/secondary/);
  await expect(modal.getByRole("button", { name: "Close reports" })).toBeFocused();
  await expect(modal.getByRole("button", { name: "Close reports" })).toHaveCSS("width", "44px");
  await expect(modal.getByRole("button", { name: "Close reports" })).toHaveCSS("height", "44px");
  await expect(modal.getByRole("button", { name: "Close reports" })).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.getByRole("button", { name: "Close reports" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.getByRole("button", { name: "Manage reports", exact: true })).toBeFocused();
  await expect(modal.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(modal.getByLabel("Import progress").locator("li")).toHaveCount(4);
  await expect(modal.getByLabel("Import progress").locator('[aria-current="step"]')).toHaveText("1Files");
  await expect(modal.getByRole("region", { name: "Retained report sets" })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Accept reviewed bundle" })).toHaveCount(0);
  await expect(page.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reporting end", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source as-of, if shown", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Validate and stage" })).toBeDisabled();
  await expect(modal.getByRole("link", { name: "Microsoft report export guidance" })).toBeVisible();
  await expect(modal.getByText("Technical validation details", { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("automatic-import.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await trigger.click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("imports all CSV rows without date prompts and preserves source discrepancies", async ({ page }, info) => {
  const { uploadBodies, userRequests } = await mockUsage(page);
  await page.goto("/sync");
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Import CSV reports", exact: true });
  await expect(modal.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await expect(page.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reporting end", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source as-of, if shown", { exact: true })).toHaveCount(0);
  await page.getByLabel("Official usage CSV files").setInputFiles(csvFiles.map(file => ({
    name: file.name, mimeType: "text/csv", buffer: Buffer.from(file.content),
  })));
  await page.getByRole("button", { name: "Close reports" }).click();
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  await expect(modal.getByText("3 file(s) selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await expect(modal.getByRole("region", { name: "Server validation" })).toBeVisible();
  await expect(modal.getByRole("button", { name: "Accept reviewed bundle" })).toHaveCount(0);
  await modal.getByRole("button", { name: "Continue to review" }).click();
  await expect(page.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
  const firstReport = modal.getByRole("region", { name: "Validated report rows" }).locator("tbody tr").first();
  await expect(firstReport.getByRole("rowheader").locator("span")).toBeInViewport({ ratio: 1 });
  await expect(firstReport.getByRole("cell").first().locator("span")).toHaveText("103");
  await expect(firstReport.getByRole("cell").first().locator("span")).toBeInViewport({ ratio: 1 });
  await expect(modal.getByText("Bundle hash", { exact: true })).toBeHidden();
  await expect(modal.getByRole("region", { name: "Retained report sets" })).toHaveCount(0);
  await expect(modal.locator(".usage-wizard-body")).toHaveCSS("overflow-y", "auto");
  expect(await modal.locator(".usage-wizard-body").evaluate(element => element.clientHeight)).toBeGreaterThan(150);
  await expect(modal.getByRole("button", { name: "Close reports" })).toBeInViewport({ ratio: 1 });
  await expect(modal.getByRole("button", { name: "Accept reviewed bundle" })).toBeInViewport();
  const headerBounds = await modal.locator(".usage-modal-header").boundingBox();
  const closeBounds = await modal.getByRole("button", { name: "Close reports" }).boundingBox();
  expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(headerBounds!.x + headerBounds!.width);
  expect(closeBounds!.y).toBeGreaterThanOrEqual(0);
  expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await expect(modal.getByRole("button", { name: "Close reports" })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("review-import.png") });
  expect(uploadBodies).toHaveLength(3);
  for (const body of uploadBodies) {
    expect(body).not.toMatch(/name="(?:reportingStart|reportingEnd|sourceAsOf|downloadedAt)"/);
  }
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(modal).toBeHidden();
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  await expect(modal.getByRole("region", { name: "Validated report previews" })).toBeVisible();
  await page.getByRole("button", { name: "Accept reviewed bundle" }).click();
  await expect(page.getByText(/three-file snapshot was added to cumulative history and is current/)).toBeVisible();
  await expect(modal.getByLabel("Import progress").locator('[aria-current="step"]')).toContainText("Result");
  await expect(modal.getByRole("button", { name: "Accept reviewed bundle" })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modal).toBeHidden();
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await manager.getByRole("button", { name: "View current snapshot", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=snapshot$/);
  await expect(page.getByRole("region", { name: "Snapshot tenant totals" })).toContainText("2,061");
  const report = page.getByRole("region", { name: "Agent activity report" });
  await expect(report.getByText("Source totals differ", { exact: true }).first()).toBeVisible();
  await expect(report.locator(".usage-report-details")).not.toHaveAttribute("open", "");
  await expect(report.getByText("Response totals", { exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath("reporting-first.png") });
  await expect(page.getByText("Power User", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/bundle was not found/)).toHaveCount(0);
  await expect(page.locator(".user-access-view")).toHaveCount(0);
  const agents = page.getByRole("region", { name: "Report agent rows" });
  await expect(agents.locator("tbody tr")).toHaveCount(25);
  await page.getByRole("button", { name: "Next agents", exact: true }).click();
  await expect(page.getByLabel("Agent usage pages")).toContainText("26-50 of 103 agents");
  await page.getByLabel("Search agents").fill("agent-100");
  await expect(agents.locator("tbody tr")).toHaveCount(1);
  await expect(agents.getByRole("button", { name: "Synthetic agent 100", exact: true })).toBeVisible();
  await page.getByLabel("Search agents").fill("no-matching-agent");
  await expect(page.getByRole("heading", { name: "No agents match" })).toBeVisible();
  await page.getByRole("button", { name: "Reset agent filters" }).click();
  await expect(agents.locator("tbody tr")).toHaveCount(25);
  expect(userRequests).toEqual([]);
});

test("allows closing during validation without dropping the staged result", async ({ page }) => {
  await mockUsage(page);
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route("**/api/official-usage/staging", async route => {
    await uploadGate;
    await route.fallback();
  });
  try {
    await page.goto("/sync");
    await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
    await page.getByLabel("Official usage CSV files").setInputFiles({
      name: csvFiles[0].name, mimeType: "text/csv", buffer: Buffer.from(csvFiles[0].content),
    });
    const uploading = page.waitForRequest("**/api/official-usage/staging");
    await page.getByRole("button", { name: "Validate and stage" }).click();
    await uploading;
    await page.getByRole("button", { name: "Close reports" }).click();
    await expect(page.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
    const completed = page.waitForResponse("**/api/official-usage/staging");
    releaseUpload();
    await completed;
    await expect(page.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
    await expect(page.getByRole("region", { name: "Server validation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Accept reviewed bundle" })).toHaveCount(0);
    await expect(page.getByText("Missing Users & agents, Users", { exact: true })).toBeVisible();
  } finally {
    releaseUpload();
  }
});

test("snapshot inspection preserves raw source totals and read-only access", async ({ page }, info) => {
  const { apiRequests } = await mockUsage(page, { role: "Viewer", active: true });
  await page.goto("/sync?reports=snapshot");
  const modal = page.locator("dialog.official-usage-modal");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Report agent rows", exact: true })).toBeVisible();
  const summary = page.getByRole("region", { name: "Snapshot tenant totals" });
  await expect(summary).toBeVisible();
  await expect(summary.locator(":scope > div")).toHaveCount(2);
  if (info.project.name === "desktop") await expect(summary).toBeInViewport();
  await expect(page.getByRole("button", { name: "Add CSV reports", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retained sets" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  const table = page.getByRole("region", { name: "Report agent rows" });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(page.locator(".report-chart-panel")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Agent activity report" }).getByRole("link")).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/users");
  expect(apiRequests).not.toContain("/api/official-usage/history");
  if (info.project.name === "desktop") {
    const bounds = await table.boundingBox();
    expect(bounds!.y, "Source report rows should begin in the first desktop viewport").toBeLessThan(760);
  }
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(page.getByText("Response totals", { exact: true })).toBeHidden();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  if (info.project.name === "mobile") await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("read-only-reporting.png") });
  await page.getByText("Report quality & sources", { exact: false }).first().click();
  await expect(page.getByText("Response totals", { exact: true })).toBeVisible();
  await expect(page.getByText(/Import time does not establish source freshness/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

for (const role of ["Admin", "Viewer"] as const) {
  for (const view of ["manage", "snapshot"] as const) {
    test(`${role} ${view} pane supports wheel and keyboard scrolling`, async ({ page }) => {
      const { apiRequests, commands } = await mockUsage(page, { role, active: true, historical: true });
      await page.goto(`/sync?reports=${view}`);
      const modal = page.locator("dialog.official-usage-modal");
      if (view === "manage") {
        const history = modal.getByRole("region", { name: "Retained official usage snapshots" });
        await expect(history.locator("tbody tr")).toHaveCount(2);
        const sourceDetails = history.locator("summary").filter({ hasText: /^3 exports$/ });
        await expect(sourceDetails).toHaveCount(2);
        await sourceDetails.nth(0).click();
        await sourceDetails.nth(1).click();
        await modal.getByText("Retention and source accounting", { exact: true }).click();
        const pane = role === "Admin"
          ? modal.locator(".usage-modal-import-pane:not([hidden]) .usage-wizard-body")
          : modal.getByRole("region", { name: "Saved reports", exact: true });
        if (role === "Viewer") await expect(pane).toHaveAttribute("tabindex", "0");
        await expectReportPaneScrolling(page, pane, `${role} manage reports`);
      } else {
        await expect(modal).toHaveAccessibleName("Report snapshot");
        await expect(modal.getByRole("region", { name: "Report agent rows" }).locator("tbody tr")).toHaveCount(25);
        const pane = modal.getByRole("region", { name: "Snapshot inspection", exact: true });
        await expect(pane).toHaveAttribute("tabindex", "0");
        await expectReportPaneScrolling(page, pane, `${role} snapshot inspection`);
      }
      expect(commands).toEqual([]);
      if (role === "Viewer") expect(apiRequests).not.toContain("/api/official-usage/admin");
    });
  }
}

test("CSV review pane supports wheel and keyboard scrolling", async ({ page }) => {
  const { commands } = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Import CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvFiles.map(file => ({
    name: file.name, mimeType: "text/csv", buffer: Buffer.from(file.content),
  })));
  await modal.getByRole("button", { name: "Validate and stage" }).click();
  await modal.getByRole("button", { name: "Continue to review" }).click();
  await expect(modal.getByRole("region", { name: "Validated report rows" }).locator("tbody tr")).toHaveCount(3);
  await modal.getByText("Technical validation details", { exact: true }).click();
  await expectReportPaneScrolling(page, modal.locator(".usage-modal-import-pane:not([hidden]) .usage-wizard-body"), "CSV import review");
  await expect(modal.getByRole("button", { name: "Accept reviewed bundle", exact: true })).toBeInViewport({ ratio: 1 });
  expect(commands.some(command => command.endsWith("/accept"))).toBe(false);
});

test("opens exact staging links in the dialog and reports unavailable staging without fallback", async ({ page }) => {
  await mockUsage(page);
  await page.goto("/official-usage?staging=33333333-3333-4333-8333-333333333333");
  await expect(page).toHaveURL(/\/sync\?reports=import&staging=33333333-3333-4333-8333-333333333333$/);
  const modal = page.getByRole("dialog", { name: "Import CSV reports", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/exact staging record is expired, deleted, or unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Close reports" }).click();
  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(page.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
});

test("uses one agent table for response rankings, reach, date filters and a snapshot-pinned CSV", async ({ page }) => {
  const { agentRequests, exportRequests, userRequests } = await mockUsage(page, { active: true });
  await page.goto("/sync?reports=snapshot");
  const table = page.getByRole("region", { name: "Report agent rows" });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await page.getByLabel("Order agents by").selectOption("responses-asc");
  await expect(table.locator("tbody tr").first()).toContainText("Prompt Coach");
  await page.getByLabel("Order agents by").selectOption("activeUsers-desc");
  await expect.poll(() => agentRequests.at(-1)?.get("sortBy")).toBe("activeUsers");
  await expect(table.locator("tbody tr").first()).toContainText("Synthetic agent 0");
  await page.getByRole("button", { name: "Next agents", exact: true }).click();
  await expect(page.getByLabel("Agent usage pages")).toContainText("26-50 of 103 agents");
  const activeUsersSort = table.getByRole("button", { name: "Sort by Active users" });
  await expect(activeUsersSort.locator("xpath=..")).toHaveAttribute("aria-sort", "descending");
  await activeUsersSort.focus();
  await activeUsersSort.press("Enter");
  await expect.poll(() => agentRequests.at(-1)?.get("sortDirection")).toBe("asc");
  expect(agentRequests.at(-1)?.get("offset")).toBe("0");
  await expect(page.getByLabel("Order agents by")).toHaveValue("activeUsers-asc");
  await expect(table.getByRole("button", { name: "Sort by Active users" })).toBeFocused();
  await expect(table.getByRole("columnheader", { name: "Active users" })).toHaveAttribute("aria-sort", "ascending");
  await page.getByText("Last-activity filters", { exact: true }).click();
  await page.getByLabel("Agent last activity on or after (UTC)").fill("2026-09-11");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("button", { name: "Clinical assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Snapshot tenant totals" })).toContainText("2,061");
  await table.getByRole("button", { name: "Clinical assistant", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Source details for Clinical assistant" });
  await expect(evidence.getByText(/Licensed and unlicensed source categories can overlap and are never added/)).toBeVisible();
  await expect(evidence.getByText("agent-power", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset agent filters" }).click();
  await page.getByRole("combobox", { name: "Creator type", exact: true }).selectOption("Agent built by Microsoft");
  await page.getByLabel("Search agents").fill("Prompt");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("button", { name: "Prompt Coach", exact: true })).toBeVisible();
  await table.getByRole("button", { name: "Sort by Agent", exact: true }).click();
  await expect(page.getByLabel("Order agents by")).toHaveValue("agentName-asc");
  await expect(table.getByRole("columnheader", { name: "Agent", exact: true })).toHaveAttribute("aria-sort", "ascending");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export agents CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("official-agent-usage.csv");
  expect(await downloadedCsvRows(file)).toEqual([
    { agentId: "agent-low", agentName: "Prompt Coach", responsesSentToUsers: "3", reportSetId: setId },
  ]);
  expect(exportRequests.at(-1)?.get("setId")).toBe(setId);
  expect(exportRequests.at(-1)?.get("search")).toBe("Prompt");
  expect(exportRequests.at(-1)?.get("creatorType")).toBe("Agent built by Microsoft");
  expect(exportRequests.at(-1)?.get("sortBy")).toBe("agentName");
  expect(exportRequests.at(-1)?.get("sortDirection")).toBe("asc");
  expect(exportRequests.at(-1)?.has("limit")).toBe(false);
  expect(exportRequests.at(-1)?.has("offset")).toBe(false);
  expect(userRequests).toEqual([]);
});

test("one manage table combines retained reports and collapsed source accounting", async ({ page }, info) => {
  const { apiRequests, agentRequests, commands } = await mockUsage(page, { active: true });
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(modal).toBeVisible();
  const history = modal.getByRole("region", { name: "Retained official usage snapshots" });
  await expect(history).toBeVisible();
  await expect(modal.getByRole("table")).toHaveCount(1);
  await expect(history.getByRole("columnheader")).toHaveText(["Imported", "Reporting coverage", "Source files", "Status", "Actions"]);
  await expect(history.getByRole("button", { name: /^Delete retained set for/ })).toBeEnabled();
  const currentRow = history.getByRole("row").filter({ has: page.getByRole("cell", { name: "Current", exact: true }) });
  await expect(currentRow.getByRole("button", { name: "View snapshot", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "View current snapshot", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Official usage history summary")).toBeHidden();
  await expect(page.getByRole("region", { name: "Report agent rows" })).toHaveCount(0);
  await expect(modal.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/overview");
  expect(apiRequests).not.toContain("/api/official-usage/aggregate");
  await expect(page.getByText("Aggregate snapshots are non-additive.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("manage-reports.png") });
  if (info.project.name === "mobile") {
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("manage-reports-history.png") });
  }
  await history.getByText("3 exports", { exact: true }).click();
  await expect(history).toContainText("310 rows; 0 duplicate rows reused.");
  await expect(history).toContainText("Original acceptance");
  await expect(history).toContainText("content 111111111111");
  await expect(history).toContainText("Independent cumulative snapshot");
  await page.getByText("Retention and source accounting", { exact: true }).click();
  await expect(page.getByLabel("Official usage history summary")).toBeVisible();
  await page.getByText("Retention and source accounting", { exact: true }).click();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("report-history.png"), fullPage: true });
  await currentRow.getByRole("button", { name: "View snapshot", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${setId}$`));
  await expect(page.getByRole("region", { name: "Report agent rows" })).toBeVisible();
  expect(agentRequests.at(-1)?.get("setId")).toBe(setId);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("snapshot-inspection.png") });
  await page.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  await expect(history).toBeVisible();
  await expect(modal.getByRole("table")).toHaveCount(1);
  await expect(currentRow).toBeVisible();
  await modal.getByRole("button", { name: "View current snapshot", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=snapshot$/);
  await expect(page.getByRole("region", { name: "Report agent rows" })).toBeVisible();
  expect(agentRequests.at(-1)?.has("setId")).toBe(false);
  await page.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(currentRow).toBeVisible();
  expect(commands).toEqual([]);
  expect(apiRequests).not.toContain("/api/official-usage/users");
});

test("keeps retained-set confirmation inside manage reports and refreshes sources on deletion", async ({ page }) => {
  await mockUsage(page, { active: true });
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(modal.getByLabel("Import progress")).toHaveCount(0);
  await expect(modal.getByLabel("Official usage CSV files")).toHaveCount(0);
  const deleteSet = modal.getByRole("button", { name: /Delete retained set for/ });
  await expect(deleteSet).toBeEnabled();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await deleteSet.click();
  const confirmation = page.getByRole("dialog", { name: "Confirm delete", exact: true });
  await expect(confirmation).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(modal).toBeVisible();
  await expect(deleteSet).toBeFocused();
  await deleteSet.click();
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/retained set was deleted/)).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Manage retained reports", exact: true })).toBeFocused();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/sync$/);
  await page.goto("/sync?reports=snapshot");
  await expect(page.getByRole("heading", { name: "Selected report deleted", exact: true })).toBeVisible();
});

for (const leaveManagement of [false, true]) {
  test(`preserves the user's new focus when a closed deletion finishes ${leaveManagement ? "outside" : "inside"} management`, async ({ page }) => {
    await mockUsage(page, { active: true });
    let releaseConfirmation!: () => void;
    const confirmationGate = new Promise<void>(resolve => { releaseConfirmation = resolve; });
    await page.route("**/api/official-usage/confirmations/*", async route => {
      expect(route.request().method()).toBe("POST");
      await confirmationGate;
      await route.fallback();
    });
    try {
      await page.goto("/sync?reports=manage");
      const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
      await modal.getByRole("button", { name: /Delete retained set for/ }).click();
      const confirmation = page.getByRole("dialog", { name: "Confirm delete", exact: true });
      const submitted = page.waitForRequest("**/api/official-usage/confirmations/*");
      await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
      await submitted;
      await expect(confirmation.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
      await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      await expect(modal.getByRole("heading", { name: "Manage retained reports", exact: true })).toBeFocused();
      if (leaveManagement) await modal.getByRole("button", { name: "Close", exact: true }).click();
      const newControl = leaveManagement
        ? page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ })
        : modal.getByRole("button", { name: "Manage reports", exact: true });
      await newControl.click();
      await expect(newControl).toBeFocused();
      const completed = page.waitForResponse("**/api/official-usage/confirmations/*");
      releaseConfirmation();
      await completed;
      if (leaveManagement) {
        await expect(page).toHaveURL(/\/sync$/);
        await expect(modal).toBeHidden();
      } else {
        await expect(modal.getByText(/retained set was deleted/)).toBeVisible();
        await expect(modal.getByRole("button", { name: /Delete retained set for/ })).toHaveCount(0);
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(newControl).toBeFocused();
    } finally {
      releaseConfirmation();
    }
  });
}

test("keeps a failed confirmation's error and dismissal accessible inside the native dialog", async ({ page }) => {
  await mockUsage(page, { active: true });
  await page.route("**/api/official-usage/confirmations/*", route => route.fulfill({
    status: 409, json: { code: "confirmation_expired", detail: "The reviewed deletion expired. Review the set again." },
  }));
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const opener = modal.getByRole("button", { name: /Delete retained set for/ });
  await opener.click();
  const confirmation = page.getByRole("dialog", { name: "Confirm delete", exact: true });
  await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("The reviewed deletion expired.");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(modal.getByRole("alert")).toContainText("The reviewed deletion expired.");
});
