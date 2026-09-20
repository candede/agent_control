import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { parseOfficialUsageReport } from "../../backend/src/services/officialUsageParser";
import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "../../backend/src/services/officialUsageViews";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import type { AcceptedOfficialUsageReports, ParsedOfficialUsageReport, PublishedOfficialUsage } from "../../backend/src/types/officialUsage";
import type { OfficialUsageAdminState, OfficialUsageHistoryView, OfficialUsageStagingPreview } from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { downloadedCsvRows, usageCsvFixture } from "./usageCsvFixture";

const instant = "2026-09-12T14:45:00.000Z";
const setId = "11111111-1111-4111-8111-111111111111";
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

async function mockUsage(page: Page, options: { role?: "Admin" | "Viewer"; active?: boolean } = {}) {
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
  function storeReport(report: ParsedOfficialUsageReport, index: number) {
    if (report.kind === "agents") reports.agents = accepted(report, index);
    else if (report.kind === "userAgents") reports.userAgents = accepted(report, index);
    else reports.users = accepted(report, index);
  }
  if (isAccepted) csvFiles.forEach((file, index) => storeReport(parseOfficialUsageReport(Buffer.from(file.content)), index + 1));
  const activeSet = {
    id: setId, bundleId, reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "activity_range" as const },
    supersedesSetId: null, complete: true, kinds: ["agents", "userAgents", "users"] as const,
    acceptedAt: instant, deletedAt: null, createdAt: instant, expiresAt: "2027-03-11T14:45:00.000Z",
  };
  function published(): PublishedOfficialUsage {
    return {
      activeRevision,
      activeSet: isAccepted ? { ...activeSet, bundleId, kinds: [...activeSet.kinds] } : null,
      reports: isAccepted ? reports : {}, retainedCompleteSets: isAccepted ? 1 : 0,
      retainedIncompleteSets: 0, hasImportHistory, activeSelectionIncomplete: false,
    };
  }
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    apiRequests.push(path);
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (["/api/official-usage/aggregate", "/api/official-usage/users", "/api/official-usage/aggregate.csv"].includes(path)) {
      expect(request.method()).toBe("GET");
      const requestedSet = url.searchParams.get("setId");
      if (requestedSet && (!isAccepted || requestedSet !== setId)) {
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
        staging: isAccepted ? [] : stages, sets: isAccepted ? [{ ...activeSet, bundleId, kinds: [...activeSet.kinds] }] : [],
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
      return respond(buildOfficialUsageAggregateView(published(), [], {
        staleAfterDays: 35, now: new Date(instant),
        ...Object.fromEntries(url.searchParams),
        agentSortBy: (["agentName", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"] as const).find(value => value === url.searchParams.get("sortBy")),
        sortDirection: url.searchParams.get("sortDirection") === "asc" ? "asc" : "desc",
        limit: Number(url.searchParams.get("limit") ?? 100), offset: Number(url.searchParams.get("offset") ?? 0),
      }));
    }
    if (path === "/api/official-usage/aggregate.csv") {
      exportRequests.push(url.searchParams);
      const view = buildOfficialUsageAggregateView(published(), [], {
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
      return respond(buildOfficialUsageUserView(published(), {
        staleAfterDays: 35, now: new Date(instant),
        ...Object.fromEntries(url.searchParams),
        userSortBy: (["displayName", "responses", "agentsUsed", "lastActivity"] as const).find(value => value === url.searchParams.get("sortBy")),
        lowResponseThreshold: Number(url.searchParams.get("lowResponseThreshold") ?? 5),
        responsesOnly: url.searchParams.get("responsesOnly") === "true",
        limit: Number(url.searchParams.get("limit") ?? 100), offset: Number(url.searchParams.get("offset") ?? 0),
      }));
    }
    if (path === "/api/official-usage/history") {
      const observations = Object.values(published().reports).map(report => ({
        versionId: report.lineage.versionId, kind: report.kind, contentHash: report.lineage.fileHash,
        rowCount: report.rows.length, uniquePayloadCount: report.rows.length, repeatedRowsReused: 0, lineage: report.lineage,
      }));
      const rowCount = observations.reduce((sum, report) => sum + report.rowCount, 0);
      const history: OfficialUsageHistoryView = {
        summary: {
          importCount: isAccepted ? 1 : 0, uniqueObservationCount: observations.length,
          observationRowCount: rowCount, uniquePayloadCount: rowCount, repeatedRowsReused: 0,
          earliestObservedAt: isAccepted ? instant : null, latestObservedAt: isAccepted ? instant : null,
          activityDateRange: {
            earliestDateUtc: isAccepted ? "2026-08-14" : null, latestDateUtc: isAccepted ? "2026-09-12" : null,
            provenance: "last_activity_dates", provesReportingCoverage: false,
          },
          reportingWindows: { knownCount: 0, unknownCount: isAccepted ? 1 : 0, overlappingKnownWindowCount: 0, additive: false },
          warning: { code: "rolling_snapshots_not_additive", message: "Report snapshots are not additive." },
        },
        bundles: {
          value: isAccepted ? [{
            ...activeSet, bundleId, kinds: [...activeSet.kinds], isActive: true,
            observationCount: observations.length, rowCount, uniquePayloadCount: rowCount, repeatedRowsReused: 0,
            reportingWindowKnown: false, activityRangeIsCoverage: false, observations,
          }] : [],
          count: isAccepted ? 1 : 0, limit: 10, offset: 0,
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
  return { uploadBodies, userRequests, agentRequests, exportRequests, apiRequests };
}

test.beforeEach(async ({ context }) => {
  await context.route(url => !["localhost", "127.0.0.1"].includes(url.hostname), route => route.abort());
});

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
  const unexpected = unexpectedApiRequests.get(page);
  if (unexpected) expect(unexpected).toEqual([]);
});

test("keeps import management off the report page and opens an accessible dialog on demand", async ({ page }, info) => {
  const { apiRequests } = await mockUsage(page);
  await page.goto("/official-usage");
  await expect(page.getByRole("heading", { name: "Agent comparison" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose CSVs" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retained sets" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  const trigger = page.getByRole("button", { name: "Import reports", exact: true });
  await trigger.click();
  const modal = page.getByRole("dialog", { name: "Import and manage reports", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Close report import" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "Back to reports" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.getByRole("button", { name: "Close report import" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Microsoft 365 usage reports" })).toBeVisible();
  await expect(page.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reporting end", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source as-of, if shown", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Validate and stage" })).toBeDisabled();
  await expect(page.getByText("Export all three files", { exact: true })).toBeHidden();
  await page.getByText("How to export the CSV files", { exact: true }).click();
  await expect(page.getByText("Export all three files", { exact: true })).toBeVisible();
  await page.getByText("How to export the CSV files", { exact: true }).click();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("automatic-import.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await trigger.click();
  await page.getByRole("button", { name: "Back to reports" }).click();
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("imports all CSV rows without date prompts and preserves source discrepancies", async ({ page }, info) => {
  const { uploadBodies, userRequests } = await mockUsage(page);
  await page.goto("/official-usage");
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Import and manage reports", exact: true });
  await expect(page.getByRole("heading", { name: "Microsoft 365 usage reports" })).toBeVisible();
  await expect(page.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reporting end", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source as-of, if shown", { exact: true })).toHaveCount(0);
  await page.getByLabel("Official usage CSV files").setInputFiles(csvFiles.map(file => ({
    name: file.name, mimeType: "text/csv", buffer: Buffer.from(file.content),
  })));
  await page.getByRole("button", { name: "Close report import" }).click();
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await expect(modal.getByText("3 file(s) selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await expect(page.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("review-import.png") });
  expect(uploadBodies).toHaveLength(3);
  for (const body of uploadBodies) {
    expect(body).not.toMatch(/name="(?:reportingStart|reportingEnd|sourceAsOf|downloadedAt)"/);
  }
  await page.getByRole("button", { name: "Back to reports" }).click();
  await expect(page.getByRole("heading", { name: "Reports not imported", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await expect(modal.getByRole("region", { name: "Validated report previews" })).toBeVisible();
  await page.getByRole("button", { name: "Accept reviewed bundle" }).click();
  await expect(page.getByText(/three-file snapshot was added to cumulative history and is current/)).toBeVisible();
  await page.getByRole("button", { name: "Back to reports" }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByRole("region", { name: "Usage summary" })).toContainText("2,061");
  const report = page.getByRole("region", { name: "Agent activity report" });
  await expect(report.getByText("Source totals differ", { exact: true }).first()).toBeVisible();
  await expect(report.locator(".usage-report-details")).not.toHaveAttribute("open", "");
  await expect(report.getByText("Response totals", { exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath("reporting-first.png") });
  await expect(page.getByText("Power User", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/bundle was not found/)).toHaveCount(0);
  await expect(page.locator(".user-access-view")).toHaveCount(0);
  const agents = page.getByRole("region", { name: "Agent comparison rows" });
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
  await page.goto("/official-usage");
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await page.getByLabel("Official usage CSV files").setInputFiles({
    name: csvFiles[0].name, mimeType: "text/csv", buffer: Buffer.from(csvFiles[0].content),
  });
  const uploading = page.waitForRequest("**/api/official-usage/staging");
  await page.getByRole("button", { name: "Validate and stage" }).click();
  await uploading;
  await page.getByRole("button", { name: "Close report import" }).click();
  releaseUpload();
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  await expect(page.getByRole("region", { name: "Validated report previews" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
  await expect(page.getByText("Missing Users & agents, Users", { exact: true })).toBeVisible();
});

test("keeps headline reporting prominent and preserves read-only access", async ({ page }, info) => {
  const { apiRequests } = await mockUsage(page, { role: "Viewer", active: true });
  await page.goto("/official-usage");
  const summary = page.getByRole("region", { name: "Usage summary" });
  await expect(summary).toBeVisible();
  if (info.project.name === "desktop") await expect(summary).toBeInViewport();
  await expect(page.getByRole("button", { name: "Import reports", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retained sets" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  const table = page.getByRole("region", { name: "Agent comparison rows" });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(page.locator(".report-chart-panel")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Official usage" }).getByRole("link")).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/users");
  expect(apiRequests).not.toContain("/api/official-usage/history");
  if (info.project.name === "desktop") {
    const bounds = await table.boundingBox();
    expect(bounds!.y, "Agent comparisons should begin in the first desktop viewport").toBeLessThan(760);
  }
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await expect(page.getByText("Response totals", { exact: true })).toBeHidden();
  expect((await new AxeBuilder({ page }).include(".official-usage-workbench").analyze()).violations).toEqual([]);
  if (info.project.name === "mobile") await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("read-only-reporting.png") });
  await page.getByText("Report quality & sources", { exact: false }).first().click();
  await expect(page.getByText("Response totals", { exact: true })).toBeVisible();
  await expect(page.getByText(/Import time does not establish source freshness/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("opens exact staging links in the dialog and reports unavailable staging without fallback", async ({ page }) => {
  await mockUsage(page);
  await page.goto("/official-usage?staging=33333333-3333-4333-8333-333333333333");
  const modal = page.getByRole("dialog", { name: "Import and manage reports", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/exact staging record is expired, deleted, or unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Close report import" }).click();
  await expect(modal).toBeHidden();
  await expect(page.getByRole("button", { name: "Import reports", exact: true })).toBeFocused();
});

test("uses one agent table for response rankings, reach, date filters and a snapshot-pinned CSV", async ({ page }) => {
  const { agentRequests, exportRequests, userRequests } = await mockUsage(page, { active: true });
  await page.goto("/official-usage");
  const table = page.getByRole("region", { name: "Agent comparison rows" });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await page.getByLabel("Order agents by").selectOption("responses-asc");
  await expect(table.locator("tbody tr").first()).toContainText("Prompt Coach");
  await page.getByLabel("Order agents by").selectOption("activeUsers-desc");
  await expect.poll(() => agentRequests.at(-1)?.get("sortBy")).toBe("activeUsers");
  await expect(table.locator("tbody tr").first()).toContainText("Synthetic agent 0");
  await page.getByText("Last-activity filters", { exact: true }).click();
  await page.getByLabel("Agent last activity on or after (UTC)").fill("2026-09-11");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("button", { name: "Clinical assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Usage summary" })).toContainText("2,061");
  await table.getByRole("button", { name: "Clinical assistant", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Source details for Clinical assistant" });
  await expect(evidence.getByText(/Licensed and unlicensed source categories can overlap and are never added/)).toBeVisible();
  await expect(evidence.getByText("agent-power", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset agent filters" }).click();
  await page.getByRole("combobox", { name: "Creator type", exact: true }).selectOption("Agent built by Microsoft");
  await page.getByLabel("Search agents").fill("Prompt");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.getByRole("button", { name: "Prompt Coach", exact: true })).toBeVisible();
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
  expect(exportRequests.at(-1)?.has("limit")).toBe(false);
  expect(exportRequests.at(-1)?.has("offset")).toBe(false);
  expect(userRequests).toEqual([]);
});

test("separates report history from agent analysis and keeps storage accounting collapsed", async ({ page }, info) => {
  const { apiRequests } = await mockUsage(page, { active: true });
  await page.goto("/official-usage");
  await expect(page.getByRole("region", { name: "Agent comparison rows" })).toBeVisible();
  expect(apiRequests).not.toContain("/api/official-usage/history");
  await page.getByRole("button", { name: "Report history", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Report history", exact: true })).toBeVisible();
  const history = page.getByRole("region", { name: "Retained official usage snapshots" });
  await expect(history).toBeVisible();
  await expect(history.getByRole("columnheader")).toHaveCount(5);
  await expect(page.getByLabel("Official usage history summary")).toBeHidden();
  await expect(page.getByRole("region", { name: "Agent comparison rows" })).toHaveCount(0);
  await expect(page.getByText("Aggregate snapshots are non-additive.")).toBeVisible();
  await page.getByText("Retention and source accounting", { exact: true }).click();
  await expect(page.getByLabel("Official usage history summary")).toBeVisible();
  await page.getByText("Retention and source accounting", { exact: true }).click();
  expect((await new AxeBuilder({ page }).include(".official-usage-workbench").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("report-history.png"), fullPage: true });
  await page.getByRole("button", { name: "Agent activity", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent comparison rows" })).toBeVisible();
  expect(apiRequests).not.toContain("/api/official-usage/users");
});

test("keeps retained-set confirmation inside import management and refreshes reports on deletion", async ({ page }) => {
  await mockUsage(page, { active: true });
  await page.goto("/official-usage");
  await page.getByRole("button", { name: "Import reports", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Import and manage reports", exact: true });
  const deleteSet = modal.getByRole("button", { name: /Delete retained set for/ });
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
  await modal.getByRole("button", { name: "Back to reports" }).click();
  await expect(page.getByRole("heading", { name: "Selected report deleted", exact: true })).toBeVisible();
});
