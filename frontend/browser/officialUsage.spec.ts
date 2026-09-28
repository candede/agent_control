import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { OfficialUsageValidationError, parseOfficialUsageReport } from "../../backend/src/services/officialUsageParser";
import { buildOfficialUsageAggregateView } from "../../backend/src/services/officialUsageViews";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import type { AcceptedOfficialUsageReports, ParsedOfficialUsageReport, PublishedOfficialUsage } from "../../backend/src/types/officialUsage";
import type {
  OfficialUsageAdminState, OfficialUsageBundlePreview, OfficialUsageConfirmation,
  OfficialUsageHistoryView, OfficialUsageStagingPreview,
} from "../src/api/client";
import { mockLayoutApi } from "./layoutFixtures";
import { captureCsvReportScreenshot, csvFilePayloads, downloadedCsvRows, usageCsvFixture } from "./usageCsvFixture";
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

async function mockUsage(page: Page, options: {
  role?: "Admin" | "Viewer";
  active?: boolean;
  historical?: boolean;
  staged?: boolean;
  additionalSavedSets?: number;
  selectedSetId?: string;
  reusedExistingSet?: boolean;
  loseAcceptanceResponse?: boolean;
  stageResponseGate?: Promise<void>;
} = {}) {
  await page.clock.setFixedTime(new Date(instant));
  unexpectedApiRequests.set(page, await mockLayoutApi(page));
  let bundleId = "22222222-2222-4222-8222-222222222222";
  let isAccepted = options.active ?? false;
  let hasImportHistory = isAccepted;
  let activeRevision = isAccepted ? 2 : 1;
  let selectedSetId: string | null = options.selectedSetId ?? (isAccepted ? setId : null);
  const stages: OfficialUsageStagingPreview[] = [];
  const stagedReports = new Map<string, ParsedOfficialUsageReport>();
  const reports: AcceptedOfficialUsageReports = {};
  const uploadBodies: string[] = [];
  const discardedStages: string[] = [];
  const bundlePreviews: OfficialUsageBundlePreview[] = [];
  const acceptRequests: Array<{ bundleId: string; bundleHash: string; expectedActiveRevision: number }> = [];
  const acceptanceReceipts = new Map<string, {
    setId: string; versionId: string; activeRevision: number; complete: boolean; reusedExistingSet: boolean;
  }>();
  const setPreviews: OfficialUsageConfirmation[] = [];
  const confirmations: OfficialUsageConfirmation[] = [];
  const adminReads: OfficialUsageAdminState[] = [];
  const userRequests: URLSearchParams[] = [];
  const agentRequests: URLSearchParams[] = [];
  const exportRequests: URLSearchParams[] = [];
  const apiRequests: string[] = [];
  const historyRequests: string[] = [];
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
  const additionalSets = Array.from({ length: options.additionalSavedSets ?? 0 }, (_, index) => ({
    ...historicalSet, id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
  }));
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
  function createStage(report: ParsedOfficialUsageReport, stagedBundleId: string) {
    const index = stages.length + 1;
    const stage: OfficialUsageStagingPreview = {
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, revision: 1, status: "active",
      kind: report.kind, fileHash: `${index}`.repeat(64).slice(0, 64), parserVersion: report.parserVersion,
      schemaVersion: report.schemaVersion, bundleId: stagedBundleId, correctionOfSetId: null,
      reportingPeriod: report.reportingPeriod, sourceAsOf: null, sourceAsOfProvenance: "absent",
      sourceFreshness: "unknown", downloadedAt: null, rowCount: report.rows.length,
      warnings: report.warnings, reconciliation: {}, activeRevision, acceptedVersionId: null,
      acceptedSetId: null, createdAt: instant, expiresAt: "2026-09-12T15:15:00.000Z", acceptedAt: null,
    };
    stages.push(stage);
    stagedReports.set(stage.id, report);
    return stage;
  }
  if (options.staged) createStage(parseOfficialUsageReport(Buffer.from(csvFiles[0].content)), bundleId);
  function published(requestedSetId?: string | null): PublishedOfficialUsage {
    const historical = options.historical && (requestedSetId ?? selectedSetId) === historicalSetId;
    return {
      activeRevision,
      activeSet: historical ? { ...historicalSet, kinds: [...historicalSet.kinds] } : isAccepted ? { ...activeSet, bundleId, kinds: [...activeSet.kinds] } : null,
      reports: historical ? historicalReports : isAccepted ? reports : {},
      retainedCompleteSets: (isAccepted ? 1 : 0) + (options.historical ? 1 : 0) + additionalSets.length,
      retainedIncompleteSets: 0, hasImportHistory, activeSelectionIncomplete: false,
    };
  }
  function adminState(): OfficialUsageAdminState {
    return {
      activeSetId: selectedSetId, activeRevision,
      staging: stages.filter(stage => stage.status === "active").map(stage => ({ ...stage })), sets: [
        ...isAccepted ? [{ ...activeSet, bundleId, kinds: [...activeSet.kinds] }] : [],
        ...options.historical ? [{ ...historicalSet, kinds: [...historicalSet.kinds] }] : [],
        ...additionalSets.map(set => ({ ...set, kinds: [...set.kinds] })),
      ],
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
    if (path === "/api/official-usage/aggregate") agentRequests.push(url.searchParams);
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
      const state = adminState();
      adminReads.push(state);
      return respond(state);
    }
    if (path === "/api/official-usage/staging") {
      expect(request.method()).toBe("POST");
      const body = request.postDataBuffer()!.toString("utf8");
      uploadBodies.push(body);
      const boundary = request.headers()["content-type"].split("boundary=")[1];
      const part = body.split(`--${boundary}`).find(value => value.includes('name="file";'));
      if (!part) throw new Error("Missing CSV multipart part");
      const csv = part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
      let report: ParsedOfficialUsageReport;
      try {
        report = parseOfficialUsageReport(Buffer.from(csv));
      } catch (error) {
        if (error instanceof OfficialUsageValidationError) return respond({ code: error.code, detail: error.message }, 400);
        throw error;
      }
      const stagedBundleId = body.match(/name="bundleId"\r\n\r\n([^\r]+)/)![1];
      if (stages.some(stage => stage.status === "active" && stage.bundleId === stagedBundleId && stage.kind === report.kind)) {
        return respond({ code: "duplicate_report_kind", detail: "This import already contains that report type. Keep the staged report or cancel and choose three different exports." }, 409);
      }
      const stage = createStage(report, stagedBundleId);
      const response = { ...stage };
      await options.stageResponseGate;
      return respond(response, 201);
    }
    if (path.startsWith("/api/official-usage/staging/") && request.method() === "DELETE") {
      const id = path.split("/").at(-1)!;
      const stage = stages.find(value => value.id === id);
      expect(stage?.status).toBe("active");
      stage!.status = "cancelled";
      discardedStages.push(id);
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith("/preview") && path.includes("/sets/")) {
      const preview: OfficialUsageConfirmation = {
        id: `confirmation-${setPreviews.length + 1}`, operation: request.postDataJSON().operation,
        setId: path.split("/")[4], expectedRevision: activeRevision, confirmationHash: "c".repeat(64),
        activeSetId: selectedSetId, expiresAt: "2026-09-12T15:00:00.000Z",
      };
      setPreviews.push(preview);
      return respond(preview);
    }
    if (path.includes("/confirmations/")) {
      const confirmation = request.postDataJSON() as OfficialUsageConfirmation;
      expect(confirmation).toEqual(setPreviews.find(preview => preview.id === path.split("/").at(-1)));
      expect(confirmation.expectedRevision).toBe(activeRevision);
      confirmations.push(confirmation);
      if (confirmation.operation === "select") selectedSetId = confirmation.setId;
      else {
        isAccepted = false;
        selectedSetId = null;
      }
      activeRevision += 1;
      return respond({ activeSetId: selectedSetId, activeRevision });
    }
    if (path.endsWith("/preview") && path.includes("/bundles/")) {
      const previewBundleId = path.split("/")[4];
      const selectedStages = stages.filter(stage => stage.bundleId === previewBundleId && stage.status === "active");
      const preview: OfficialUsageBundlePreview = {
        bundleId: previewBundleId,
        bundleHash: createHash("sha256").update(JSON.stringify([previewBundleId, activeRevision, selectedStages])).digest("hex"),
        expectedActiveRevision: activeRevision,
        staging: selectedStages.map(stage => ({ ...stage })), acceptedVersions: [],
        missingKinds: activeSet.kinds.filter(kind => !selectedStages.some(stage => stage.kind === kind)),
        reconciliation: {},
      };
      bundlePreviews.push(preview);
      return respond(preview);
    }
    if (path.endsWith("/accept") && path.includes("/bundles/")) {
      const requestBundleId = path.split("/")[4];
      const body = request.postDataJSON() as { bundleHash: string; expectedActiveRevision: number };
      acceptRequests.push({ bundleId: requestBundleId, ...body });
      const reviewed = bundlePreviews.filter(preview => preview.bundleId === requestBundleId).at(-1);
      expect(reviewed?.missingKinds).toEqual([]);
      expect(body).toEqual({ bundleHash: reviewed!.bundleHash, expectedActiveRevision: reviewed!.expectedActiveRevision });
      const receipt = acceptanceReceipts.get(requestBundleId);
      if (receipt) return respond(receipt);
      expect(body.expectedActiveRevision).toBe(activeRevision);
      for (const stage of stages.filter(stage => stage.bundleId === requestBundleId && stage.status === "active")) {
        storeReport(stagedReports.get(stage.id)!, activeSet.kinds.indexOf(stage.kind) + 1);
        stage.status = "accepted";
        stage.acceptedSetId = setId;
        stage.acceptedAt = instant;
      }
      isAccepted = true;
      hasImportHistory = true;
      if (!options.reusedExistingSet) {
        bundleId = requestBundleId;
        selectedSetId = setId;
        activeRevision += 1;
      }
      const result = { setId, versionId: "version-1", activeRevision, complete: true, reusedExistingSet: options.reusedExistingSet ?? false };
      acceptanceReceipts.set(requestBundleId, result);
      if (options.loseAcceptanceResponse) return route.abort("failed");
      return respond(result);
    }
    if (path === "/api/official-usage/aggregate") {
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
      historyRequests.push(url.searchParams.toString());
      const retained = [
        ...isAccepted ? [{ set: { ...activeSet, bundleId }, reports }] : [],
        ...options.historical ? [{ set: historicalSet, reports: historicalReports }] : [],
        ...additionalSets.map(set => ({ set, reports })),
      ];
      const bundles = retained.map(({ set, reports: sourceReports }): OfficialUsageHistoryView["bundles"]["value"][number] => {
        const observations = Object.values(sourceReports).map(report => ({
          versionId: report.lineage.versionId, kind: report.kind, contentHash: report.lineage.fileHash,
          rowCount: report.rows.length, uniquePayloadCount: report.rows.length, repeatedRowsReused: 0, lineage: report.lineage,
        }));
        const rowCount = observations.reduce((sum, report) => sum + report.rowCount, 0);
        return {
          ...set, kinds: [...set.kinds], isActive: set.id === selectedSetId,
          observationCount: observations.length, rowCount, uniquePayloadCount: rowCount, repeatedRowsReused: 0,
          reportingWindowKnown: false, activityRangeIsCoverage: false, observations,
        };
      });
      const observations = bundles.flatMap(bundle => bundle.observations);
      const rowCount = observations.reduce((sum, report) => sum + report.rowCount, 0);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
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
          reportingWindows: { earliestStartDateUtc: null, latestEndDateUtc: null, knownCount: 0, unknownCount: bundles.length, overlappingKnownWindowCount: 0, additive: false },
          warning: { code: "rolling_snapshots_not_additive", message: "Report snapshots are not additive." },
        },
        bundles: {
          value: bundles.slice(offset, offset + limit), count: bundles.length, limit, offset,
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
  return {
    uploadBodies, userRequests, agentRequests, exportRequests, apiRequests, historyRequests, commands,
    discardedStages, stages, bundlePreviews, acceptRequests, setPreviews, confirmations, adminReads,
    selectedSetId: () => selectedSetId,
    selectReport: (id: string) => { selectedSetId = id; activeRevision += 1; },
    deleteImportedReport: () => {
      isAccepted = false;
      if (selectedSetId === setId) selectedSetId = null;
      activeRevision += 1;
    },
  };
}

async function expectReportPaneScrolling(page: Page, pane: Locator, name: string, dismissal: string) {
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
    const dismiss = modal.getByRole("button", { name: dismissal, exact: true });
    await dismiss.scrollIntoViewIfNeeded();
    await expect(dismiss).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY), "The document must not scroll behind the dialog").toBe(documentScroll);
    await test.info().attach(`${name}-scroll-measurements`, {
      body: JSON.stringify({ ...metrics, bounds, wheelScrollTop, keyboardScrollTop }, null, 2),
      contentType: "application/json",
    });
  });
}

function csvUploads(files = csvFiles) {
  return csvFilePayloads(files);
}

function expectExactImportReads(queries: URLSearchParams[]) {
  const verification = queries.filter(query => query.get("limit") === "1");
  expect(verification.length).toBeGreaterThan(0);
  for (const query of verification) expect(Object.fromEntries(query)).toEqual({ setId, limit: "1", offset: "0" });
}

async function expectSimpleImporter(modal: Locator) {
  await expect(modal).toHaveAccessibleName("Add CSV reports");
  await expect(modal.getByRole("button", { name: "Close reports", exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: /^(?:Close|Add CSV reports|Manage reports|Next|Validate and stage|Continue to review|Accept reviewed bundle)$/ })).toHaveCount(0);
  await expect(modal.getByRole("tab")).toHaveCount(0);
  await expect(modal.getByRole("group", { name: "Report workflow" })).toHaveCount(0);
  await expect(modal.getByLabel("Import progress")).toHaveCount(0);
  await expect(modal.getByText(/Bundle hash|Technical validation details|expected active revision/i)).toHaveCount(0);
  await expect(modal).not.toContainText(/[a-f0-9]{64}/i);
}

async function expectImported(modal: Locator, duplicate = false) {
  await expect(modal.getByRole("heading", { name: duplicate ? "Reports already imported" : "Reports imported", exact: true })).toBeVisible();
  await expect(modal.getByRole("status")).toContainText("Your report set is ready in Agents.");
  await expect(modal.getByRole("button")).toHaveText(["OK"]);
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "OK", exact: true })).not.toHaveClass(/secondary/);
  await expectSimpleImporter(modal);
}

async function expectSnapshotShell(modal: Locator) {
  await expect(modal).toHaveAccessibleName("Report details");
  await expect(modal.getByRole("button", { name: "Back to reports", exact: true })).toHaveCount(1);
  await expect(modal.getByRole("button", { name: /Close|Refresh|Make current|Current snapshot/i })).toHaveCount(0);
  await expect(modal.getByText("Viewing this report does not change the selected report set.", { exact: true })).toBeVisible();
  await expect(modal.locator(".usage-modal-footer")).toHaveCount(0);
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
  { legacy: "/official-usage?view=snapshot", canonical: "/sync?reports=snapshot", title: "Report details" },
  { legacy: `/official-usage?snapshot=${setId}`, canonical: `/sync?reports=snapshot&snapshot=${setId}`, title: "Report details" },
  { legacy: `/official-usage?view=history&snapshot=${setId}`, canonical: "/sync?reports=manage", title: "Manage reports" },
  { legacy: "/official-usage?view=snapshot&window=90", canonical: "/sync?reports=snapshot&window=90", title: "Report details" },
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
    if (scenario.title === "Report details") {
      await expect(modal.getByRole("region", { name: "Report agent rows" })).toBeVisible();
      const canonical = new URL(scenario.canonical, "http://localhost");
      expect(agentRequests.at(-1)?.get("setId")).toBe(canonical.searchParams.get("snapshot"));
      expect(agentRequests.at(-1)?.get("activityWindowDays")).toBe(canonical.searchParams.get("window") ?? (canonical.searchParams.has("snapshot") ? "365" : "30"));
      await expectSnapshotShell(modal);
      await modal.getByRole("button", { name: "Back to reports", exact: true }).click();
      await expect(page).toHaveURL("/sync?reports=manage");
    } else {
      await expect(modal.getByRole("region", { name: "Saved reports", exact: true })).toBeVisible();
      expect(agentRequests).toEqual([]);
    }
    await page.getByRole("dialog", { name: "Manage reports", exact: true }).getByRole("button", { name: "Close reports", exact: true }).click();
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
  const history = modal.getByRole("region", { name: "Saved reports", exact: true });
  await expect(modal.getByRole("region", { name: "Saved report sets", exact: true })).toContainText("2 saved report sets");
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(modal.getByRole("table")).toHaveCount(1);
  await expect(history.getByRole("columnheader", { name: "Imported", exact: true })).toBeVisible();
  await expect(history.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
  await expect(modal.getByRole("button", { name: /Add CSV reports|Make current|Delete report set|Resume import|Validate and stage|Refresh/ })).toHaveCount(0);
  await expect(modal.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  expect(apiRequests).not.toContain("/api/official-usage/overview");
  const oldRow = history.getByRole("row").filter({ has: page.getByRole("cell", { name: "Saved", exact: true }) });
  await expect(oldRow).toContainText("Jun 1, 2026");
  await expect(oldRow).toContainText(/3 (?:files|reports|CSVs|exports)/);
  await expect(oldRow).toContainText("5 rows");
  await expect(oldRow).toContainText("Jun 2, 2026");
  await expect(history.locator("details")).toHaveCount(0);
  await expect(history).not.toContainText(historicalSetId);
  await expect(history).not.toContainText("444444444444");
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route(url => url.pathname === "/api/official-usage/aggregate" && url.searchParams.get("setId") === historicalSetId, async route => {
    await snapshotGate;
    await route.fallback();
  });
  try {
    await oldRow.getByRole("button", { name: "View report", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${historicalSetId}$`));
    await expect(modal).toHaveAccessibleName("Report details");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(modal.getByRole("status").filter({ hasText: /loading/i })).toBeVisible();
    await expect(modal.getByRole("region", { name: "Report agent rows" })).toHaveCount(0);
  } finally {
    releaseSnapshot();
  }
  const rows = modal.getByRole("region", { name: "Report agent rows" });
  await expect(rows.locator("tbody tr")).toHaveCount(2);
  await expect(rows).toContainText("Historical report-only assistant");
  const bridgeRow = rows.getByRole("row", { name: /Bridge-only retained assistant/ });
  await expect(bridgeRow).toContainText("Users & agents only");
  await expect(bridgeRow.getByRole("cell").nth(1)).toContainText("5");
  await expect(rows).not.toContainText("Clinical assistant");
  await expect(modal.getByRole("region", { name: "Snapshot tenant totals" })).toContainText("17");
  await expectSnapshotShell(modal);
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
  await modal.getByRole("button", { name: "Close reports", exact: true }).click();
  await expect(manage).toBeFocused();
});

test("an unavailable saved report retries the exact snapshot without substituting the current report", async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true, role: "Viewer" });
  let available = false;
  const attemptedSets: Array<string | null> = [];
  await page.route(url => url.pathname === "/api/official-usage/aggregate", route => {
    const id = new URL(route.request().url()).searchParams.get("setId");
    attemptedSets.push(id);
    return available
      ? route.fallback()
      : route.fulfill({ status: 503, json: { code: "snapshot_unavailable", detail: "This saved report is temporarily unavailable." } });
  });
  await page.goto("/sync?reports=manage");
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const saved = manager.getByRole("row").filter({ has: page.getByRole("cell", { name: "Saved", exact: true }) });
  await saved.getByRole("button", { name: "View report", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Report details", exact: true });
  await expect(details.getByRole("alert")).toContainText("This saved report is temporarily unavailable.");
  await expect(details.getByRole("region", { name: "Report agent rows" })).toHaveCount(0);
  await expect(details).not.toContainText("Clinical assistant");
  await expect(details.getByRole("button", { name: "Export agents CSV", exact: true })).toBeDisabled();
  available = true;
  await details.getByRole("button", { name: "Retry report", exact: true }).click();
  await expect(details.getByRole("region", { name: "Report agent rows" }).locator("tbody tr")).toHaveCount(2);
  expect(attemptedSets).toEqual([historicalSetId, historicalSetId]);
  await expect(details.getByRole("button", { name: "Retry report", exact: true })).toHaveCount(0);
  expect(state.commands).toEqual([]);
  await details.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(manager.getByRole("row").filter({ has: page.getByRole("cell", { name: "Current", exact: true }) })).toBeVisible();
});

test("Sync opens a fresh accessible importer with one upload action and Cancel", async ({ page }, info) => {
  const { apiRequests } = await mockUsage(page);
  await page.goto("/sync");
  await expect(page.getByRole("heading", { name: "CSV usage reports", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Official usage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage reports", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "View report history", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Choose CSV files" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Retained sets" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  const trigger = page.getByRole("button", { name: "Add CSV reports", exact: true });
  await trigger.click();
  await expect(page).toHaveURL(/\/sync\?reports=import$/);
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await expect(modal).toBeVisible();
  await expectSimpleImporter(modal);
  const choose = modal.getByRole("button", { name: "Choose CSV files", exact: true });
  const cancel = modal.getByRole("button", { name: "Cancel", exact: true });
  await expect(modal.getByRole("button", { name: "Start over", exact: true })).toHaveCount(0);
  await expect(choose).toBeInViewport({ ratio: 1 });
  await expect(cancel).toBeInViewport({ ratio: 1 });
  await expect(cancel).toHaveClass(/secondary/);
  await expect.poll(() => modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await choose.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(choose).toBeFocused();
  await expect(modal.getByRole("region", { name: "Retained report sets" })).toHaveCount(0);
  await expect(page.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reporting end", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source as-of, if shown", { exact: true })).toHaveCount(0);
  await expect(modal.getByRole("link", { name: /download.*reports/i })).toBeVisible();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  await page.screenshot({ path: info.outputPath("automatic-import.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(/\/sync$/);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await trigger.click();
  await cancel.click();
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("automatically imports all CSV rows, verifies the exact report and preserves source discrepancies", async ({ page }, info) => {
  const { uploadBodies, userRequests, acceptRequests, bundlePreviews, adminReads, agentRequests } = await mockUsage(page);
  await page.goto("/agents");
  await expect.poll(() => adminReads.length).toBeGreaterThan(0);
  expect(adminReads.at(-1)?.activeSetId).toBeNull();
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await expectSimpleImporter(modal);
  await expect(page.getByLabel("Reporting start", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reporting end", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Source as-of, if shown", { exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeInViewport({ ratio: 1 });
  await captureCsvReportScreenshot(page, info, "upload");
  const fileChooser = page.waitForEvent("filechooser");
  await modal.getByRole("button", { name: "Choose CSV files", exact: true }).click();
  await (await fileChooser).setFiles(csvUploads());
  await expectImported(modal);
  expect(acceptRequests).toHaveLength(1);
  const reviewed = bundlePreviews.at(-1)!;
  expect(reviewed.staging.map(stage => stage.rowCount)).toEqual([103, 103, 104]);
  expect(acceptRequests[0]).toEqual({
    bundleId: reviewed.bundleId, bundleHash: reviewed.bundleHash, expectedActiveRevision: reviewed.expectedActiveRevision,
  });
  expect(adminReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: 2, staging: [] });
  expectExactImportReads(agentRequests);
  const summary = modal.getByLabel("Imported CSV summary");
  await expect(summary.locator("dt")).toHaveText(["Agents", "Users", "Responses"]);
  await expect(summary.locator("dd")).toHaveText(["103", "104", "2,061"]);
  await expect(summary).toBeInViewport({ ratio: 1 });
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toBeInViewport({ ratio: 1 });
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await captureCsvReportScreenshot(page, info, "success");
  expect(uploadBodies).toHaveLength(3);
  for (const body of uploadBodies) {
    expect(body).not.toMatch(/name="(?:reportingStart|reportingEnd|sourceAsOf|downloadedAt)"/);
    expect(body).not.toContain('name="correctionOfSetId"');
    expect(body).toMatch(/name="rejectDuplicateKind"\r?\n\r?\ntrue/);
  }
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(modal).toBeHidden();
  await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(setId);
  await page.getByRole("navigation", { name: "Primary views" }).getByRole("button", { name: /^Sync/ }).click();
  await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeEnabled();
  await expect(modal.getByRole("heading", { name: /Reports (?:already )?imported/ })).toHaveCount(0);
  expect(await modal.getByLabel("Official usage CSV files").evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(acceptRequests).toHaveLength(1);
  await page.getByRole("button", { name: "Manage reports", exact: true }).click();
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(manager.getByRole("region", { name: "Saved reports", exact: true }).locator("tbody tr")).toHaveCount(1);
  await expect(manager.getByRole("button", { name: "View report", exact: true })).toBeEnabled();
  const list = manager.getByRole("region", { name: "Saved reports", exact: true });
  expect(await list.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const listBounds = await list.boundingBox();
  const actionBounds = await manager.getByRole("button", { name: "View report", exact: true }).boundingBox();
  expect(listBounds).not.toBeNull();
  expect(actionBounds).not.toBeNull();
  expect(actionBounds!.x).toBeGreaterThanOrEqual(listBounds!.x);
  expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(listBounds!.x + listBounds!.width);
  const deleteBounds = await manager.getByRole("button", { name: /^Delete report set:/ }).boundingBox();
  expect(deleteBounds).not.toBeNull();
  expect(Math.abs(deleteBounds!.y + deleteBounds!.height / 2 - actionBounds!.y - actionBounds!.height / 2)).toBeLessThanOrEqual(1);
  expect(deleteBounds!.x + deleteBounds!.width).toBeLessThanOrEqual(listBounds!.x + listBounds!.width);
  await captureCsvReportScreenshot(page, info, "management");
  await manager.getByRole("button", { name: "View report", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${setId}$`));
  await expect(page.getByRole("dialog", { name: "Report details", exact: true })).toBeVisible();
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

test("success keeps maximum response totals readable without hiding OK", async ({ page }, info) => {
  await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  const files = csvFiles.map((file, index) => index === 0 ? {
    ...file,
    content: `${file.content.split("\r\n")[0]}\r\nagent-power,Clinical assistant,User-created agent,2,1,${Number.MAX_SAFE_INTEGER},"Sep 12, 2026"\r\n`,
  } : file);
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvFilePayloads(files));
  await expectImported(modal);
  const summary = modal.getByLabel("Imported CSV summary");
  await expect(summary.locator("dd")).toHaveText(["1", "104", Number.MAX_SAFE_INTEGER.toLocaleString("en-US")]);
  await expect(summary).toBeInViewport({ ratio: 1 });
  expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await summary.locator("dd").last().evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toBeInViewport({ ratio: 1 });
  await captureCsvReportScreenshot(page, info, "success");
});

test("Cancel during validation disposes late staging and does not restore it into a fresh import", async ({ page }) => {
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
  const state = await mockUsage(page, { stageResponseGate: uploadGate });
  try {
    await page.goto("/sync");
    await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
    const uploading = page.waitForRequest("**/api/official-usage/staging");
    await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([csvFiles[0]]));
    await uploading;
    await expect.poll(() => state.stages.length).toBe(1);
    await modal.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page).toHaveURL(/\/sync$/);
    await expect(page.getByRole("button", { name: "Add CSV reports", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Add CSV reports", exact: true }).click();
    await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeEnabled();
    releaseUpload();
    await expect.poll(() => state.discardedStages.length).toBe(1);
    expect(state.stages.every(stage => stage.status === "cancelled")).toBe(true);
    expect(state.acceptRequests).toEqual([]);
    await expect(modal).not.toContainText(csvFiles[0].name);
    expect(await modal.getByLabel("Official usage CSV files").evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
    await expectSimpleImporter(modal);
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  } finally {
    releaseUpload();
  }
});

test("Add CSV reports ignores old staging instead of resuming it from management", async ({ page }) => {
  const state = await mockUsage(page, { staged: true });
  await page.goto("/sync?reports=manage");
  const manager = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(manager.getByRole("region", { name: "Staged imports", exact: true })).toHaveCount(0);
  await expect(manager.getByRole("button", { name: /Resume import/ })).toHaveCount(0);
  await manager.getByRole("button", { name: "Add CSV reports", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeEnabled();
  await expectSimpleImporter(modal);
  expect(await modal.getByLabel("Official usage CSV files").evaluate((input: HTMLInputElement) => input.files?.length)).toBe(0);
  expect(state.bundlePreviews).toEqual([]);
  expect(state.uploadBodies).toEqual([]);
  expect(state.adminReads).toEqual([]);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal).toBeHidden();
  expect(state.acceptRequests).toEqual([]);
  expect(state.discardedStages).toEqual([]);
  expect(state.stages[0].status).toBe("active");
});

test("missing report types remain actionable and adding companions completes one atomic import", async ({ page }) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([csvFiles[0]]));
  await expect.poll(() => state.stages.length).toBe(1);
  await expect(modal).toContainText(/missing|still need|add.*remaining/i);
  await expect(modal).toContainText("Users & agents");
  await expect(modal).toContainText("Users");
  await expect(modal.getByRole("button", { name: "Add CSV files", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "Start over", exact: true })).toBeEnabled();
  expect(state.acceptRequests).toEqual([]);
  await expectSimpleImporter(modal);
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads(csvFiles.slice(1)));
  await expectImported(modal);
  expect(state.uploadBodies).toHaveLength(3);
  expect(new Set(state.stages.map(stage => stage.bundleId)).size).toBe(1);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.stages.every(stage => stage.status === "accepted")).toBe(true);
});

test("Start over disposes the partial import before choosing a new bundle", async ({ page }) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([csvFiles[0]]));
  await expect(modal.getByRole("button", { name: "Add CSV files", exact: true })).toBeEnabled();
  const first = state.stages[0];
  await modal.getByRole("button", { name: "Start over", exact: true }).click();
  await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "Start over", exact: true })).toHaveCount(0);
  await expect(modal).not.toContainText(csvFiles[0].name);
  expect(state.discardedStages).toEqual([first.id]);
  expect(state.adminReads.some(read => read.staging.some(stage => stage.id === first.id && stage.status === "active"))).toBe(true);
  expect(state.acceptRequests).toEqual([]);
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expectImported(modal);
  expect(state.uploadBodies).toHaveLength(4);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.acceptRequests[0].bundleId).not.toBe(first.bundleId);
  expect(state.stages.slice(1).every(stage => stage.bundleId === state.acceptRequests[0].bundleId && stage.status === "accepted")).toBe(true);
});

test("a rejected CSV preserves successful companions and a corrected missing file completes the import", async ({ page }) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([
    ...csvFiles.slice(0, 2), { name: "users-invalid.csv", content: "Unsupported,CSV\ninvalid,report" },
  ]));
  await expect(modal.getByRole("alert")).toContainText(/users-invalid.csv|CSV headers/);
  await expect(modal).toContainText(/choose|replace|add/i);
  await expect(modal.getByRole("button", { name: "Choose replacement CSVs", exact: true })).toBeEnabled();
  await expect(modal.getByRole("button", { name: "Start over", exact: true })).toBeEnabled();
  expect(state.stages.map(stage => stage.kind)).toEqual(["agents", "userAgents"]);
  expect(state.acceptRequests).toEqual([]);
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([csvFiles[2]]));
  await expectImported(modal);
  expect(state.uploadBodies).toHaveLength(4);
  expect(new Set(state.stages.map(stage => stage.bundleId)).size).toBe(1);
  expect(state.acceptRequests).toHaveLength(1);
});

test("three valid companions never publish when another selected file is rejected", async ({ page }) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([
    ...csvFiles, { name: "unexpected.csv", content: "Unsupported,CSV\ninvalid,report" },
  ]));
  await expect(modal.getByRole("alert")).toContainText(/one per report type|three CSV exports|CSV headers/);
  await expect(modal.getByRole("button", { name: "Choose CSV files", exact: true })).toBeEnabled();
  expect(state.acceptRequests).toEqual([]);
  await expect(modal.getByRole("heading", { name: "Reports imported", exact: true })).toHaveCount(0);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal).toBeHidden();
  expect(state.stages.every(stage => stage.status === "cancelled")).toBe(true);
  expect(state.acceptRequests).toEqual([]);
});

test("Escape cannot cancel a save in progress and acknowledges success like OK", async ({ page }) => {
  const state = await mockUsage(page);
  let releaseAcceptance!: () => void;
  const acceptanceGate = new Promise<void>(resolve => { releaseAcceptance = resolve; });
  await page.route("**/api/official-usage/bundles/*/accept", async route => {
    await acceptanceGate;
    await route.fallback();
  });
  try {
    await page.goto("/sync?reports=import");
    const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
    const saving = page.waitForRequest("**/api/official-usage/bundles/*/accept");
    await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
    await saving;
    await expect(modal.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    await expect(page).toHaveURL(/\/sync\?reports=import$/);
    expect(state.discardedStages).toEqual([]);
    releaseAcceptance();
    await expectImported(modal);
    const ok = modal.getByRole("button", { name: "OK", exact: true });
    await expect(modal.getByRole("heading", { name: "Reports imported", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(ok).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(ok).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/agents$/);
    await expect(modal).toBeHidden();
    await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(setId);
    expect(state.acceptRequests).toHaveLength(1);
    expect(state.discardedStages).toEqual([]);
  } finally {
    releaseAcceptance();
  }
});

test("OK waits for fresh admin and exact-report reads before navigating without publishing again", async ({ page }) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expectImported(modal);
  const adminReads = state.adminReads.length;
  const reportReads = state.agentRequests.length;
  const previews = state.bundlePreviews.length;
  let releaseAdmin!: () => void;
  let releaseReport!: () => void;
  const adminGate = new Promise<void>(resolve => { releaseAdmin = resolve; });
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  await page.route("**/api/official-usage/admin", async route => {
    await adminGate;
    await route.fallback();
  });
  await page.route("**/api/official-usage/aggregate?*", async route => {
    expect(Object.fromEntries(new URL(route.request().url()).searchParams)).toEqual({ setId, limit: "1", offset: "0" });
    await reportGate;
    await route.fallback();
  });
  try {
    const rechecking = Promise.all([
      page.waitForRequest("**/api/official-usage/admin"),
      page.waitForRequest(request => new URL(request.url()).pathname === "/api/official-usage/aggregate"),
    ]);
    await modal.getByRole("button", { name: "OK", exact: true }).click();
    await rechecking;
    await expect(page).toHaveURL(/\/sync\?reports=import$/);
    await expect(modal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    const adminCompleted = page.waitForResponse("**/api/official-usage/admin");
    releaseAdmin();
    await adminCompleted;
    await expect(page).toHaveURL(/\/sync\?reports=import$/);
    releaseReport();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(modal).toBeHidden();
    await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(setId);
    expect(state.adminReads.length).toBeGreaterThan(adminReads);
    expect(state.agentRequests.length).toBeGreaterThan(reportReads);
    expectExactImportReads(state.agentRequests);
    expect(state.uploadBodies).toHaveLength(3);
    expect(state.acceptRequests).toHaveLength(1);
    expect(state.bundlePreviews).toHaveLength(previews);
    expect(state.discardedStages).toEqual([]);
  } finally {
    releaseAdmin();
    releaseReport();
  }
});

test("OK detects a selection change made after success and requires explicit reselection", async ({ page }) => {
  const state = await mockUsage(page, { historical: true });
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expectImported(modal);
  const reads = state.agentRequests.length;
  state.selectReport(historicalSetId);
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("The report selection changed.");
  await expect(page).toHaveURL(/\/sync\?reports=import$/);
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
  expect(state.selectedSetId()).toBe(historicalSetId);
  expect(state.setPreviews).toEqual([]);
  expect(state.confirmations).toEqual([]);
  expect(state.agentRequests.length).toBeGreaterThan(reads);
  await modal.getByRole("button", { name: "Use imported reports", exact: true }).click();
  await expectImported(modal);
  expect(state.confirmations).toHaveLength(1);
  expect(state.confirmations[0]).toMatchObject({ setId, operation: "select", expectedRevision: 3 });
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(setId);
  expectExactImportReads(state.agentRequests);
  expect(state.uploadBodies).toHaveLength(3);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.bundlePreviews).toHaveLength(1);
});

test("OK blocks a report deleted after success without reuploading or accepting on Retry", async ({ page }) => {
  const state = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expectImported(modal);
  const reads = state.agentRequests.length;
  state.deleteImportedReport();
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("The exact synthetic report set is unavailable.");
  await expect(page).toHaveURL(/\/sync\?reports=import$/);
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
  expect(state.agentRequests.length).toBeGreaterThan(reads);
  const retried = page.waitForResponse(response => new URL(response.url()).pathname === "/api/official-usage/aggregate" && response.status() === 404);
  await modal.getByRole("button", { name: "Retry", exact: true }).click();
  await retried;
  await expect(modal.getByRole("alert")).toContainText("The exact synthetic report set is unavailable.");
  expectExactImportReads(state.agentRequests);
  expect(state.uploadBodies).toHaveLength(3);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.bundlePreviews).toHaveLength(1);
  expect(state.setPreviews).toEqual([]);
  expect(state.confirmations).toEqual([]);
  expect(state.discardedStages).toEqual([]);
  await modal.getByRole("button", { name: "Back to Sync", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(page).toHaveURL(/\/sync$/);
});

test("a lost acceptance response retries the same reviewed request without uploading or publishing twice", async ({ page }) => {
  const state = await mockUsage(page, { loseAcceptanceResponse: true });
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expect(modal.getByRole("alert")).toBeVisible();
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
  expect(state.acceptRequests).toHaveLength(1);
  const previewCount = state.bundlePreviews.length;
  await modal.getByRole("button", { name: /^Retry/ }).click();
  await expectImported(modal);
  expect(state.acceptRequests).toHaveLength(2);
  expect(state.acceptRequests[1]).toEqual(state.acceptRequests[0]);
  expect(state.bundlePreviews).toHaveLength(previewCount);
  expect(state.uploadBodies).toHaveLength(3);
  expect(state.adminReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: 2 });
  expect(state.discardedStages).toEqual([]);
});

for (const failedRead of ["admin", "aggregate"] as const) {
  test(`post-accept ${failedRead} verification retries reads without accepting or uploading again`, async ({ page }) => {
    const state = await mockUsage(page);
    let failed = false;
    await page.route(url => url.pathname === `/api/official-usage/${failedRead}`, async route => {
      if (state.acceptRequests.length && !failed) {
        failed = true;
        return route.fulfill({ status: 503, json: { code: "verification_unavailable", detail: "Saved report verification is temporarily unavailable." } });
      }
      return route.fallback();
    });
    await page.goto("/sync?reports=import");
    const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
    await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
    await expect(modal.getByRole("alert")).toContainText("Saved report verification is temporarily unavailable.");
    await expect(modal.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
    expect(state.acceptRequests).toHaveLength(1);
    const previewCount = state.bundlePreviews.length;
    await modal.getByRole("button", { name: /^Retry/ }).click();
    await expectImported(modal);
    expect(state.acceptRequests).toHaveLength(1);
    expect(state.uploadBodies).toHaveLength(3);
    expect(state.bundlePreviews).toHaveLength(previewCount);
    expect(state.adminReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: 2 });
    expectExactImportReads(state.agentRequests);
  });
}

test("a duplicate saved report is selected through the revision-fenced confirmation before OK", async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true, selectedSetId: historicalSetId, reusedExistingSet: true });
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expectImported(modal, true);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.setPreviews).toHaveLength(1);
  expect(state.setPreviews[0]).toMatchObject({ operation: "select", setId, activeSetId: historicalSetId, expectedRevision: 2 });
  expect(state.confirmations).toEqual(state.setPreviews);
  expect(state.selectedSetId()).toBe(setId);
  expect(state.adminReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: 3 });
  expectExactImportReads(state.agentRequests);
  await modal.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("region", { name: "Report set selection" }).getByRole("combobox")).toHaveValue(setId);
});

test("a newer report selection requires Use imported reports before a duplicate can replace it", async ({ page }) => {
  const state = await mockUsage(page, { active: true, historical: true, reusedExistingSet: true });
  let selectionChanged = false;
  await page.route("**/api/official-usage/admin", route => {
    if (state.acceptRequests.length && !selectionChanged) {
      state.selectReport(historicalSetId);
      selectionChanged = true;
    }
    return route.fallback();
  });
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads());
  await expect(modal.getByRole("alert")).toContainText(/changed|newer|selection/i);
  await expect(modal.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.setPreviews).toEqual([]);
  expect(state.confirmations).toEqual([]);
  expect(state.selectedSetId()).toBe(historicalSetId);
  const useImported = modal.getByRole("button", { name: "Use imported reports", exact: true });
  await expect(useImported).toBeEnabled();
  await useImported.click();
  await expectImported(modal, true);
  expect(state.acceptRequests).toHaveLength(1);
  expect(state.uploadBodies).toHaveLength(3);
  expect(state.setPreviews).toHaveLength(1);
  expect(state.setPreviews[0]).toMatchObject({ operation: "select", setId, activeSetId: historicalSetId, expectedRevision: 3 });
  expect(state.confirmations).toEqual(state.setPreviews);
  expect(state.adminReads.at(-1)).toMatchObject({ activeSetId: setId, activeRevision: 4 });
  expectExactImportReads(state.agentRequests);
});

test("snapshot inspection preserves raw source totals and read-only access", async ({ page }, info) => {
  const { apiRequests, historyRequests } = await mockUsage(page, { role: "Viewer", active: true });
  await page.goto("/sync?reports=snapshot");
  const modal = page.locator("dialog.official-usage-modal");
  await expect(modal).toBeVisible();
  await expectSnapshotShell(modal);
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
  expect(historyRequests.length).toBeGreaterThan(0);
  expect(historyRequests.every(query => query === "limit=1&offset=0")).toBe(true);
  await expect(modal.getByRole("heading", { name: "Report history" })).toHaveCount(0);
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
      const { apiRequests, commands } = await mockUsage(page, { role, active: true, historical: true, additionalSavedSets: 28 });
      await page.goto(`/sync?reports=${view}`);
      const modal = page.locator("dialog.official-usage-modal");
      if (view === "manage") {
        const history = modal.getByRole("region", { name: "Saved reports", exact: true });
        await expect(history.locator("tbody tr")).toHaveCount(25);
        await expect(history.locator("details")).toHaveCount(0);
        const pane = modal.getByRole("region", { name: "Manage saved reports", exact: true });
        await expectReportPaneScrolling(page, pane, `${role} manage reports`, "Close reports");
      } else {
        await expect(modal).toHaveAccessibleName("Report details");
        await expect(modal.getByRole("region", { name: "Report agent rows" }).locator("tbody tr")).toHaveCount(25);
        const pane = modal.getByRole("region", { name: "Snapshot inspection", exact: true });
        await expect(pane).toHaveAttribute("tabindex", "0");
        await expectReportPaneScrolling(page, pane, `${role} snapshot inspection`, "Back to reports");
      }
      expect(commands).toEqual([]);
      expect(apiRequests).not.toContain("/api/official-usage/admin");
    });
  }
}

test("import validation errors leave upload and Cancel reachable on desktop and mobile", async ({ page }, info) => {
  const { acceptRequests, discardedStages } = await mockUsage(page);
  await page.goto("/sync?reports=import");
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await modal.getByLabel("Official usage CSV files").setInputFiles(csvUploads([
    csvFiles[0], { name: "users-and-agents-with-unsupported-columns.csv", content: "Unsupported,CSV\ninvalid,report" },
  ]));
  await expect(modal.getByRole("alert")).toBeVisible();
  const choose = modal.getByRole("button", { name: "Choose replacement CSVs", exact: true });
  await expect(choose).toBeEnabled();
  await choose.scrollIntoViewIfNeeded();
  await expect(choose).toBeInViewport({ ratio: 1 });
  await expect(modal.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 });
  await expectSimpleImporter(modal);
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("csv-validation-error.png"), fullPage: true });
  expect(acceptRequests).toEqual([]);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => discardedStages.length).toBe(1);
});

test("legacy staging links open the new importer without automatically publishing saved staging", async ({ page }) => {
  const state = await mockUsage(page, { staged: true });
  const stagingId = state.stages[0].id;
  await page.goto(`/official-usage?staging=${stagingId}`);
  await expect(page).toHaveURL(`/sync?reports=import&staging=${stagingId}`);
  const modal = page.getByRole("dialog", { name: "Add CSV reports", exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("button", { name: "Add CSV files", exact: true })).toBeEnabled();
  await expectSimpleImporter(modal);
  expect(state.adminReads.length).toBeGreaterThan(0);
  expect(state.bundlePreviews.at(-1)?.bundleId).toBe(state.stages[0].bundleId);
  expect(state.acceptRequests).toEqual([]);
  expect(state.uploadBodies).toEqual([]);
  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
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

for (const source of ["summary", "history"] as const) {
  test(`CSV ${source} offers Retry only after a failed read`, async ({ page }) => {
    const state = await mockUsage(page, { active: true, historical: true });
    let reads = 0;
    let available = false;
    await page.route(url => url.pathname === "/api/official-usage/history"
      && url.searchParams.get("limit") === (source === "summary" ? "1" : "25"), route => {
      reads += 1;
      return available
        ? route.fallback()
        : route.fulfill({ status: 503, json: { code: "history_unavailable", detail: "Saved reports are temporarily unavailable." } });
    });
    await page.goto(source === "summary" ? "/sync" : "/sync?reports=manage");
    const section = source === "summary"
      ? page.getByRole("region", { name: "CSV usage reports", exact: true })
      : page.getByRole("dialog", { name: "Manage reports", exact: true });
    await expect(section.getByRole("alert")).toContainText("Saved reports are temporarily unavailable.");
    const retry = section.getByRole("button", { name: /^Retry/ });
    await expect(retry).toBeEnabled();
    await expect(section.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
    const beforeRetry = reads;
    available = true;
    await retry.click();
    await expect.poll(() => reads).toBeGreaterThan(beforeRetry);
    await expect(section.getByRole("alert")).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    await expect(section.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
    if (source === "summary") {
      await expect(section.locator("time[datetime='2026-06-01']")).toBeVisible();
      await expect(section.locator("time[datetime='2026-09-12']")).toBeVisible();
      await expect(section).toContainText("Last imported");
      await expect(section).not.toContainText("proof of continuous reporting coverage");
    } else {
      await expect(section.getByRole("region", { name: "Saved reports", exact: true }).locator("tbody tr")).toHaveCount(2);
      await expect(section.getByRole("button", { name: "View report", exact: true }).first()).toBeEnabled();
    }
    expect(state.commands).toEqual([]);
  });
}

test("Manage reports contains saved history and opens read-only details without selection controls", async ({ page }, info) => {
  const { apiRequests, agentRequests, commands } = await mockUsage(page, { active: true });
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  await expect(modal).toBeVisible();
  const history = modal.getByRole("region", { name: "Saved reports", exact: true });
  await expect(modal.getByRole("region", { name: "Saved report sets", exact: true })).toContainText("1 saved report set");
  await expect(history).toBeVisible();
  await expect(modal.getByRole("table")).toHaveCount(1);
  await expect(history.getByRole("columnheader", { name: "Imported", exact: true })).toBeVisible();
  await expect(history.getByRole("columnheader", { name: "Status", exact: true })).toBeVisible();
  const remove = history.getByRole("button", { name: /^Delete report set/ });
  await expect(remove).toBeEnabled();
  await expect(remove).toHaveClass(/icon-button/);
  const header = modal.locator(".usage-modal-header");
  await expect(header.getByRole("button")).toHaveCount(2);
  await expect(header.getByRole("button", { name: "Add CSV reports", exact: true })).toBeVisible();
  const close = header.getByRole("button", { name: "Close reports", exact: true });
  await expect(close).toHaveCount(1);
  await expect(close).toHaveCSS("width", "44px");
  await expect(close).toHaveCSS("height", "44px");
  await expect(modal.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: /Make current|Refresh|View current snapshot|Resume import/ })).toHaveCount(0);
  await expect(modal.getByRole("tab")).toHaveCount(0);
  await expect(modal.getByRole("group", { name: "Report workflow" })).toHaveCount(0);
  await expect(modal.getByText("Retention and source accounting", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("Find an agent across reports", { exact: true })).toHaveCount(0);
  await expect(history.locator("details")).toHaveCount(0);
  const currentRow = history.getByRole("row").filter({ has: page.getByRole("cell", { name: "Current", exact: true }) });
  await expect(currentRow.getByRole("button", { name: "View report", exact: true })).toBeEnabled();
  await expect(currentRow).toContainText("310 rows");
  await expect(currentRow).toContainText(/3 (?:files|reports|CSVs|exports)/);
  await expect(currentRow).toContainText("Sep 12, 2026");
  await expect(currentRow).not.toContainText(setId);
  await expect(currentRow).not.toContainText("111111111111");
  await expect(page.getByLabel("Official usage history summary")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Report agent rows" })).toHaveCount(0);
  await expect(modal.getByRole("region", { name: "Retained agent activity rows" })).toHaveCount(0);
  expect(apiRequests).not.toContain("/api/official-usage/overview");
  expect(apiRequests).not.toContain("/api/official-usage/aggregate");
  expect(apiRequests).not.toContain("/api/official-usage/admin");
  await expect(modal.getByText("Aggregate snapshots are non-additive.")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("manage-reports.png") });
  if (info.project.name === "mobile") {
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("manage-reports-history.png") });
  }
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("report-history.png"), fullPage: true });
  await currentRow.getByRole("button", { name: "View report", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sync\\?reports=snapshot&snapshot=${setId}$`));
  await expect(page.getByRole("region", { name: "Report agent rows" })).toBeVisible();
  expect(agentRequests.at(-1)?.get("setId")).toBe(setId);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const details = page.getByRole("dialog", { name: "Report details", exact: true });
  await expectSnapshotShell(details);
  await page.screenshot({ path: info.outputPath("snapshot-inspection.png") });
  await page.getByRole("button", { name: "Back to reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync\?reports=manage$/);
  await expect(history).toBeVisible();
  await expect(modal.getByRole("table")).toHaveCount(1);
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
  const deleteSet = modal.getByRole("button", { name: /^Delete report set/ });
  await expect(deleteSet).toBeEnabled();
  expect((await new AxeBuilder({ page }).include(".official-usage-modal").analyze()).violations).toEqual([]);
  await deleteSet.click();
  const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Delete report set", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(modal).toBeVisible();
  await expect(deleteSet).toBeFocused();
  await deleteSet.click();
  await confirmation.getByRole("button", { name: "Delete report set", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(modal).toBeVisible();
  await expect(modal.getByText(/(?:report|retained).*deleted/i)).toBeVisible();
  await expect(modal.getByRole("region", { name: "Manage saved reports", exact: true })).toBeFocused();
  await modal.getByRole("button", { name: "Close reports", exact: true }).click();
  await expect(page).toHaveURL(/\/sync$/);
  await page.goto("/sync?reports=snapshot");
  await expect(page.getByRole("heading", { name: "Selected report deleted", exact: true })).toBeVisible();
});

test("an in-flight report deletion cannot be dismissed or submitted twice", async ({ page }) => {
  const state = await mockUsage(page, { active: true });
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
    await modal.getByRole("button", { name: /^Delete report set/ }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
    const submitted = page.waitForRequest("**/api/official-usage/confirmations/*");
    const remove = confirmation.getByRole("button", { name: "Delete report set", exact: true });
    await remove.click();
    await submitted;
    await expect(remove).toBeDisabled();
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeVisible();
    await expect(modal).toBeVisible();
    releaseConfirmation();
    await expect(confirmation).toHaveCount(0);
    await expect(modal.getByText("Report set deleted.", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: /^Delete report set/ })).toHaveCount(0);
    expect(state.confirmations).toHaveLength(1);
    expect(state.confirmations[0]).toMatchObject({ setId, operation: "delete", expectedRevision: 2 });
    expect(state.acceptRequests).toEqual([]);
  } finally {
    releaseConfirmation();
  }
});

test("keeps a failed confirmation's error and dismissal accessible inside the native dialog", async ({ page }) => {
  await mockUsage(page, { active: true });
  await page.route("**/api/official-usage/confirmations/*", route => route.fulfill({
    status: 409, json: { code: "confirmation_expired", detail: "The reviewed deletion expired. Review the set again." },
  }));
  await page.goto("/sync?reports=manage");
  const modal = page.getByRole("dialog", { name: "Manage reports", exact: true });
  const opener = modal.getByRole("button", { name: /^Delete report set/ });
  await opener.click();
  const confirmation = page.getByRole("dialog", { name: "Delete report set?", exact: true });
  await confirmation.getByRole("button", { name: "Delete report set", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("The reviewed deletion expired.");
  await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
  await expect(confirmation.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(modal.getByRole("row").filter({ has: page.getByRole("cell", { name: "Current", exact: true }) })).toBeVisible();
  await expect(opener).toBeEnabled();
});
