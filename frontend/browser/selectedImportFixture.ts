import { expect, type Page, type Route } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { OfficialUsageValidationError } from "../../backend/src/services/officialReportFields";
import { AppError } from "../../backend/src/errors";
import { workbenchActions, workbenchViews } from "../../backend/src/services/workbenchMetadata";
import type { OfficialUsageMetadata } from "../../backend/src/types/officialReportRecords";
import type { OfficialReportAccepted, OfficialReportBundleAcceptance, OfficialReportBundlePreview, OfficialReportConfirmation,
  OfficialReportExportRequest, OfficialReportExportStatus, OfficialReportPreview } from "../../backend/src/types/officialReportApi";
import { reportExportColumns, type ReportAgent, type ReportAnalytics, type ReportHistorySet, type ReportMetadata, type ReportOverviewAgent, type ReportPage, type ReportQuery } from "../../backend/src/types/officialReportData";
import { historySet, reportPage } from "../src/test/reportDataFixture";
import { selectedFixtureQuery, selectedFixtureWindow } from "../src/test/selectedUsageFixture";
import { mockLayoutApi } from "./layoutFixtures";
import { selectedCohortRead } from "./selectedCohortFixture";
import { parseSelectedCsv, selectedImportData, selectedImportMetadata, type SelectedCsvFixture } from "./selectedImportData";
import { usageCsvFixture } from "./usageCsvFixture";

export const importInstant = "2026-09-12T14:45:00.000Z";
export const importedSetId = "11111111-1111-4111-8111-111111111111";
export const retainedSetId = "99999999-9999-4999-8999-999999999999";
const initialBundle = "22222222-2222-4222-8222-222222222222";
const kinds = ["agents", "userAgents", "users"] as const;
type SavedSet = { row: ReportHistorySet; files: SelectedCsvFixture[] };
type Captured = { metadata: ReportMetadata; query: ReportQuery; files: SelectedCsvFixture[]; historyIds: string[] };
export type SelectedImportOptions = {
  role?: "Admin" | "Viewer"; active?: boolean; historical?: boolean; staged?: boolean; additionalSavedSets?: number;
  selectedSetId?: string; reusedExistingSet?: boolean; loseAcceptanceResponse?: boolean; stageResponseGate?: Promise<void>;
};

export async function mockSelectedImport(page: Page, csvFiles: Array<{ name: string; content: string }>, options: SelectedImportOptions = {}) {
  await page.clock.setFixedTime(new Date(importInstant));
  const unexpected = await mockLayoutApi(page);
  const seeded = await Promise.all(csvFiles.map(file => parseSelectedCsv(Buffer.from(file.content))));
  const sets = new Map<string, SavedSet>(), selections = new Map<string, Captured>();
  const stages: OfficialReportPreview[] = [], stagedFiles = new Map<string, SelectedCsvFixture>(), discardedStages: string[] = [];
  const uploadBodies: string[] = [], uploadIntents: URLSearchParams[] = [], stageReads: string[] = [];
  const bundlePreviews: OfficialReportBundlePreview[] = [], acceptRequests: Array<OfficialReportBundleAcceptance & { bundleId: string }> = [];
  const receipts = new Map<string, OfficialReportAccepted>(), setPreviews: OfficialReportConfirmation[] = [], confirmations: OfficialReportConfirmation[] = [];
  const agentRequests: URLSearchParams[] = [], userRequests: URLSearchParams[] = [], historyRequests: URLSearchParams[] = [];
  const metadataReads: ReportMetadata[] = [], apiRequests: string[] = [], commands: string[] = [], exportRequests: URLSearchParams[] = [];
  const exports = new Map<string, { selected: Captured; rows: ReportAgent[]; bytes: Buffer; status: OfficialReportExportStatus }>();
  const exportSubmissions: OfficialReportExportRequest[] = [], exportStatusBytes: number[] = [], exportDownloads: boolean[] = [];
  let activeRevision = options.active ? 2 : 1, historyRevision = 1, historyEpoch = 1;
  let selectedSetId = options.selectedSetId ?? (options.active ? importedSetId : null);
  let hasHistory = Boolean(options.active || options.historical);
  function save(id: string, bundleId: string, files: SelectedCsvFixture[], acceptedAt = importInstant) {
    const period = files[0].reportingPeriod;
    sets.set(id, { row: historySet(1, { id, bundleId, acceptedAt, reportingStart: period.startDate, reportingEnd: period.endDate,
      periodProvenance: period.provenance, contentHash: createHash("sha256").update(files.map(file => file.fileHash).join("")).digest("hex"),
      active: id === selectedSetId }), files });
  }
  if (options.active) save(importedSetId, initialBundle, seeded);
  if (options.historical) {
    const rows = [
      "historical-report-only,Historical report-only assistant,User-created agent,1,0,17,2026-06-01\r\n",
      "historical-report-only,Historical report-only assistant,User-created agent,historical@example.invalid,17,2026-06-01\r\n"
        + "historical-bridge-only,Bridge-only retained assistant,User-created agent,bridge@example.invalid,5,2026-06-01\r\n",
      "historical@example.invalid,Historical User,1,17,2026-06-01\r\nbridge@example.invalid,Bridge User,1,5,2026-06-01\r\n",
    ];
    const files = await Promise.all(csvFiles.map((file, index) => parseSelectedCsv(Buffer.from(`${file.content.split("\r\n")[0]}\r\n${rows[index]}`))));
    save(retainedSetId, "88888888-8888-4888-8888-888888888888", files, "2026-06-02T10:00:00.000Z");
  }
  if ((options.additionalSavedSets ?? 0) > 64) throw new Error("Synthetic retained-set fixture exceeds its 64-set bound");
  for (let index = 0; index < (options.additionalSavedSets ?? 0); index++) {
    save(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`, randomUUID(), seeded, "2026-06-02T10:00:00.000Z");
  }
  function metadata(id: string | null = selectedSetId): ReportMetadata {
    const saved = id ? sets.get(id) : undefined;
    const result = selectedImportMetadata(saved?.files ?? [], {
      setId: saved?.row.id ?? null, activeSetId: selectedSetId, activeRevision: String(activeRevision),
      historyRevision: String(historyRevision), historyEpoch: String(historyEpoch),
      acceptedAt: saved?.row.acceptedAt ?? null, expiresAt: saved ? "2027-03-11T14:45:00.000Z" : null,
    });
    if (!saved && hasHistory) result.availability = "deleted";
    return result;
  }
  function createStage(file: SelectedCsvFixture, bundleId: string, correctionOfSetId: string | null = null) {
    const stage: OfficialReportPreview = {
      id: randomUUID(), revision: 1, kind: file.kind, bundleId, contentHash: file.fileHash, fileHash: file.fileHash,
      rowCount: file.rowCount, storedBytes: Buffer.byteLength(JSON.stringify(file.rows)), wireBytes: file.wireBytes, activeRevision: String(activeRevision),
      expiresAt: "2026-09-12T15:15:00.000Z", reportingPeriod: file.reportingPeriod, sourceAsOf: file.sourceAsOf ?? null,
      sourceAsOfProvenance: file.sourceAsOfProvenance, sourceFreshness: file.sourceFreshness, correctionOfSetId,
      status: "active", examples: file.examples, warnings: file.warnings,
      reconciliation: { rows: file.rowCount,
        responses: file.rows.reduce((sum, row) => sum + ("agentResponsesReceived" in row ? row.agentResponsesReceived : row.responsesSentToUsers), 0),
        agentsUsed: file.kind === "users" ? file.rows.reduce((sum, row) => sum + ("numberOfAgentsUsed" in row ? row.numberOfAgentsUsed : 0), 0) : null },
    };
    stages.push(stage); stagedFiles.set(stage.id, file); return stage;
  }
  if (options.staged) createStage(seeded[0], initialBundle);
  function activeStages(bundleId: string) { return stages.filter(stage => stage.bundleId === bundleId && !discardedStages.includes(stage.id)); }
  function captured(url: URL) {
    const selectionId = url.searchParams.get("selectionId"), prior = selectionId ? selections.get(selectionId) : undefined;
    if (selectionId && !prior) throw new Error("Unknown selected fixture context");
    if (prior) return { selected: prior, selectionId };
    if (selections.size >= 250) throw new Error("Synthetic selection fixture exceeded its bound");
    const query = selectedFixtureQuery(url.href), reports = metadata(query.setId ?? selectedSetId);
    const selected: Captured = { metadata: reports, query, files: reports.setId ? sets.get(reports.setId)!.files : [], historyIds: [...sets.keys()] };
    const id = randomUUID(); selections.set(id, selected); return { selected, selectionId: id };
  }
  function agentRows(selected: Captured, query = selected.query) {
    const data = selectedImportData(selected.files, selected.metadata);
    const rows = data.agents.filter(row => (!query.search || `${row.agentName} ${row.agentId}`.toLowerCase().includes(query.search.toLowerCase()))
      && (!query.creatorType || row.creatorType === query.creatorType) && (!query.startDate || Boolean(row.lastActivityDateUtc && row.lastActivityDateUtc >= query.startDate))
      && (!query.endDate || Boolean(row.lastActivityDateUtc && row.lastActivityDateUtc <= query.endDate)));
    const key = (row: ReportAgent) => query.sort === "name" ? row.agentName : query.sort === "activeUsers" ? row.activeUsers
      : query.sort === "licensedUsers" ? row.licensedUserOccurrences : query.sort === "unlicensedUsers" ? row.unlicensedUserOccurrences
        : query.sort === "lastActivity" ? row.lastActivityDateUtc : row.responses;
    rows.sort((a, b) => {
      const left = key(a), right = key(b);
      if (left === null || right === null) return left === right ? a.agentId.localeCompare(b.agentId) : left === null ? 1 : -1;
      return (query.order === "asc" ? 1 : -1) * (typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right)))
        || a.agentId.localeCompare(b.agentId);
    });
    return { data, rows };
  }
  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    apiRequests.push(path);
    const respond = (json: unknown, status = 200) => {
      expect(Buffer.byteLength(JSON.stringify(json))).toBeLessThanOrEqual(1024 * 1024);
      return route.fulfill({ status, json });
    };
    if (path.startsWith("/api/official-usage/") && request.method() !== "GET") commands.push(`${request.method()} ${path}`);
    if (path === "/api/official-usage/admin" || path.endsWith(".csv")) return respond({ code: "not_found", detail: "Removed data endpoint" }, 404);
    if (options.role === "Viewer" && path.startsWith("/api/official-usage/")
      && (request.method() !== "GET" || /\/(?:staging|bundles|sets|confirmations)(?:\/|$)/.test(path))) {
      unexpected.push(`Forbidden Viewer request: ${request.method()} ${path}`);
      return respond({ code: "forbidden", detail: "Current Admin access is required." }, 403);
    }
    if (path === "/api/me") return respond({ user: { displayName: "Usage administrator", username: "admin@example.invalid",
      homeAccountId: "usage-admin", roles: [`AgentControl.${options.role ?? "Admin"}`] }, csrfToken: "fixture-csrf", roleAssignmentRequired: false });
    if (path === "/api/workbench/metadata") return respond({ views: workbenchViews, actions: workbenchActions });
    if (path === "/api/capabilities" || path === "/api/capabilities/check") return respond({
      value: capabilityDefinitions.map(definition => ({ definition, decision: { capabilityId: definition.id, status: definition.mode === "local" ? "available" : "unavailable",
        authorized: definition.mode === "local", fresh: true, verification: "local", previewQualification: "not_required", remediation: [] } })),
    });
    if (path === "/api/official-usage/staging") {
      expect(request.method()).toBe("POST");
      const body = request.postDataBuffer()!.toString("utf8"); uploadBodies.push(body); uploadIntents.push(url.searchParams);
      expect(url.searchParams.get("bundleId")).toMatch(/^[a-f0-9-]{36}$/); expect(body).not.toContain('name="bundleId"');
      const boundary = request.headers()["content-type"].split("boundary=")[1], parts = body.split(`--${boundary}`);
      const part = parts.find(value => value.includes('name="file";')); if (!part) throw new Error("Missing CSV multipart part");
      const fields = Object.fromEntries(parts.filter(value => !value.includes('name="file";') && /name="([^"]+)"/.test(value))
        .map(value => [/name="([^"]+)"/.exec(value)![1], value.slice(value.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "")]));
      const source: OfficialUsageMetadata = {
        ...(fields.reportingStart ? { reportingPeriod: { startDate: fields.reportingStart, endDate: fields.reportingEnd, provenance: "operator_asserted" } } : {}),
        ...(fields.sourceAsOf ? { sourceAsOf: { value: fields.sourceAsOf, provenance: "operator_asserted" } } : {}),
      };
      let file: SelectedCsvFixture;
      try { file = await parseSelectedCsv(Buffer.from(part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "")), source); }
      catch (error) {
        if (error instanceof AppError) return respond({ code: error.code, detail: error.message }, error.status);
        if (error instanceof OfficialUsageValidationError) return respond({ code: error.code, detail: error.message }, 400);
        throw error;
      }
      const bundleId = url.searchParams.get("bundleId")!;
      if (activeStages(bundleId).some(stage => stage.kind === file.kind)) return respond({ code: "duplicate_report_kind", detail: "Choose a missing companion kind." }, 409);
      const stage = createStage(file, bundleId, url.searchParams.get("correctionOfSetId"));
      await options.stageResponseGate; return respond(stage, 201);
    }
    const staging = /^\/api\/official-usage\/staging\/([^/]+)(?:\/(diagnostics))?$/.exec(path);
    if (staging) {
      const stage = stages.find(value => value.id === staging[1] && !discardedStages.includes(value.id));
      if (!stage) return respond({ code: "staging_unavailable", detail: "The exact staging receipt is unavailable." }, 404);
      if (request.method() === "DELETE") { expect(stage.status).toBe("active"); discardedStages.push(stage.id); return route.fulfill({ status: 204 }); }
      stageReads.push(stage.id);
      if (staging[2]) return respond({ value: [], counts: { total: 0, filtered: 0 }, preview: { id: stage.id, revision: stage.revision, contentHash: stage.contentHash },
        page: { limit: 50, nextCursor: null, previousCursor: null } });
      return respond(stage);
    }
    const bundle = /^\/api\/official-usage\/bundles\/([^/]+)\/(preview|accept)$/.exec(path);
    if (bundle) {
      const current = activeStages(bundle[1]);
      if (bundle[2] === "preview") {
        const preview: OfficialReportBundlePreview = { bundleId: bundle[1], expectedActiveRevision: String(activeRevision),
          complete: kinds.every(kind => current.some(stage => stage.kind === kind)),
          bundleHash: createHash("sha256").update(JSON.stringify([bundle[1], activeRevision, current])).digest("hex"),
          stages: current.map(stage => ({ stagingId: stage.id, kind: stage.kind, revision: stage.revision, contentHash: stage.contentHash,
            rowCount: stage.rowCount, reconciliation: stage.reconciliation })) };
        bundlePreviews.push(preview); return respond(preview);
      }
      const body: OfficialReportBundleAcceptance = request.postDataJSON(); acceptRequests.push({ bundleId: bundle[1], ...body });
      const receipt = receipts.get(bundle[1]); if (receipt) return respond(receipt);
      const reviewed = bundlePreviews.filter(value => value.bundleId === bundle[1]).at(-1)!;
      expect(reviewed.complete).toBe(true); expect(body).toEqual({ bundleHash: reviewed.bundleHash, expectedActiveRevision: reviewed.expectedActiveRevision });
      expect(body.expectedActiveRevision).toBe(String(activeRevision));
      for (const stage of current) stage.status = "accepted";
      if (!options.reusedExistingSet) {
        selectedSetId = importedSetId; activeRevision++; historyRevision++;
        save(importedSetId, bundle[1], current.map(stage => stagedFiles.get(stage.id)!));
      }
      hasHistory = true;
      const result: OfficialReportAccepted = { setId: importedSetId, activeRevision: String(activeRevision), complete: true };
      receipts.set(bundle[1], result);
      if (options.loseAcceptanceResponse) return route.abort("failed");
      return respond(result);
    }
    const preview = /^\/api\/official-usage\/sets\/([^/]+)\/preview$/.exec(path);
    if (preview) {
      const operation: OfficialReportConfirmation["operation"] = request.postDataJSON().operation;
      const result: OfficialReportConfirmation = { id: randomUUID(), setId: preview[1], operation, activeRevision: String(activeRevision),
        historyRevision: String(historyRevision), historyEpoch: String(historyEpoch), hash: "c".repeat(64) };
      setPreviews.push(result); return respond(result);
    }
    if (path.startsWith("/api/official-usage/confirmations/")) {
      const confirmation: OfficialReportConfirmation = request.postDataJSON();
      expect(confirmation).toEqual(setPreviews.find(value => value.id === path.split("/").at(-1)));
      expect(confirmation).toMatchObject({ activeRevision: String(activeRevision), historyRevision: String(historyRevision), historyEpoch: String(historyEpoch) });
      confirmations.push(confirmation);
      if (confirmation.operation === "select") { selectedSetId = confirmation.setId; activeRevision++; }
      else { sets.delete(confirmation.setId); historyRevision++; historyEpoch++; if (selectedSetId === confirmation.setId) { selectedSetId = null; activeRevision++; } }
      return respond({ activeSetId: selectedSetId, activeRevision: String(activeRevision) });
    }
    if (path === "/api/data-exports") {
      const body: OfficialReportExportRequest = request.postDataJSON(); exportSubmissions.push(body);
      expect(Object.keys(body).sort()).toEqual(["idempotencyKey", "kind", "selectionId"]);
      expect(body.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/); expect(body.kind).toBe("official_agents");
      const selected = selections.get(body.selectionId)!; expect(selected).toBeDefined();
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...selected.query, setId: selected.metadata.setId })) if (value !== undefined && value !== null) query.set(key, String(value));
      exportRequests.push(query);
      const rows = agentRows(selected).rows;
      const unknown = (value: unknown) => value ?? "Unknown";
      const bytes = usageCsvFixture([...reportExportColumns.official_agents], rows.map(row => ({
        agentId: row.agentId, agentName: row.agentName, creatorType: row.creatorType,
        creatorTypeSource: row.responseSource === "agents" ? "agents_report" : "users_and_agents_report",
        activeUsersLicensed: unknown(row.licensedUserOccurrences), activeUsersUnlicensed: unknown(row.unlicensedUserOccurrences),
        activeUsersTotal: unknown(row.activeUsers), activeUsersTotalBasis: row.activeUsersBasis, activeUsersIdentityCount: unknown(row.activeUsers),
        responsesSentToUsers: row.responses, responseComparisonStatus: row.responseComparison,
        responseDifference: row.reportResponses !== null && row.bridgeResponses !== null ? Math.abs(row.reportResponses - row.bridgeResponses) : "Unknown",
        responsesAgentsReport: unknown(row.reportResponses), responsesUsersAndAgentsReport: unknown(row.bridgeResponses),
        lastActivityDateUtc: unknown(row.lastActivityDateUtc), sourceReports: row.reportResponses === null ? "userAgents" : row.bridgeResponses === null ? "agents" : "agents | userAgents",
        identityStatus: row.identityStatus, reportSetId: selected.metadata.setId, historyRevision: selected.metadata.historyRevision,
        reportingStart: selected.metadata.reportingPeriod?.startDate, reportingEnd: selected.metadata.reportingPeriod?.endDate,
        ...Object.fromEntries(selected.metadata.lineages.flatMap(lineage => [
          [`${lineage.kind}VersionId`, lineage.versionId], [`${lineage.kind}PeriodProvenance`, lineage.periodProvenance], [`${lineage.kind}SourceFreshness`, lineage.sourceFreshness],
        ])),
      })));
      const id = randomUUID(), status: OfficialReportExportStatus = { id, status: "ready", rows: rows.length, bytes: bytes.length,
        expiresAt: "2026-09-12T15:15:00.000Z", error: null, limit: null, observed: null };
      exports.set(id, { selected, rows, bytes, status }); return respond({ id }, 202);
    }
    if (path.startsWith("/api/data-exports/")) {
      const stored = exports.get(path.split("/")[3]); if (!stored) throw new Error("Unknown persisted export");
      if (request.method() === "DELETE") { stored.status.status = "cancelled"; return route.fulfill({ status: 204 }); }
      if (stored.selected.metadata.historyEpoch !== String(historyEpoch)) { stored.status.status = "failed"; stored.status.error = "selection_invalidated"; }
      if (path.endsWith("/download")) {
        expect(stored.status.status).toBe("ready"); exportDownloads.push(request.isNavigationRequest());
        return route.fulfill({ contentType: "text/csv", headers: { "Content-Disposition": 'attachment; filename="official-agents.csv"' }, body: stored.bytes });
      }
      exportStatusBytes.push(Buffer.byteLength(JSON.stringify(stored.status))); return respond(stored.status);
    }
    if (!path.startsWith("/api/official-usage/") || request.method() !== "GET") return route.fallback();
    if (path === "/api/official-usage/aggregate") agentRequests.push(url.searchParams);
    if (path === "/api/official-usage/users") userRequests.push(url.searchParams);
    const explicitSet = url.searchParams.get("setId");
    if (explicitSet && !sets.has(explicitSet)) return respond({ code: "official_usage_set_not_found", detail: "The exact synthetic report set is unavailable." }, 404);
    const { selected, selectionId } = captured(url);
    if (selected.metadata.historyEpoch !== String(historyEpoch)) return respond({ code: "selection_invalidated", detail: "Report history changed. Restart selection." }, 409);
    const query: ReportQuery = { ...selected.query };
    for (const [key, value] of Object.entries(selectedFixtureQuery(url.href))) if (url.searchParams.has(key)) Object.assign(query, { [key]: value });
    const { data, rows } = agentRows(selected, query);
    const base = <T>(value: T[], total = value.length): ReportPage<T> => reportPage(value, {
      reports: selected.metadata, sources: data.directory.sources, summary: data.summary, filters: query,
      selection: { ...data.directory.selection, id: selectionId! }, counts: { total, filtered: value.length },
      analytics: { basis: "filtered_rows", rowCount: value.length, responses: null, zeroResponses: null, unknownResponses: null,
        review: null, agents: null, history: null, overview: null },
    });
    const window = <T>(value: T[], page = base(value)) => selectedFixtureWindow(url.href, value, page);
    if (path === "/api/official-usage/aggregate") {
      metadataReads.push(selected.metadata);
      const anchor = data.agents.flatMap(row => row.lastActivityDateUtc ? [row.lastActivityDateUtc] : []).sort().at(-1) ?? null;
      const cutoff = anchor ? new Date(Date.parse(anchor) - ((query.activityWindowDays ?? 30) - 1) * 86400000).toISOString().slice(0, 10) : null;
      const recent = rows.filter(row => row.lastActivityDateUtc && cutoff && row.lastActivityDateUtc >= cutoff);
      const analytics: ReportAnalytics = { ...base(rows).analytics, responses: rows.reduce((sum, row) => sum + row.responses, 0),
        zeroResponses: rows.filter(row => !row.responses).length, unknownResponses: 0, agents: {
          inactive: rows.filter(row => row.lastActivityDateUtc && cutoff && row.lastActivityDateUtc < cutoff).length,
          neverUsed: rows.filter(row => !row.lastActivityDateUtc).length, anchorDateUtc: anchor, windowDays: query.activityWindowDays ?? 30,
          windowAgents: recent.length, windowResponses: recent.reduce((sum, row) => sum + row.responses, 0),
          windowDistinctActiveUsers: new Set(data.relationships.filter(link => link.responses > 0 && recent.some(row => row.agentId === link.agentId)).map(link => link.username)).size,
          mostResponses: [...rows].sort((a, b) => b.responses - a.responses).slice(0, 5).map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses })),
          leastResponses: [...rows].sort((a, b) => a.responses - b.responses).slice(0, 5).map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses })),
        } };
      return respond(window(rows, { ...base(rows, data.agents.length), analytics }));
    }
    if (path === "/api/official-usage/aggregate/facets") {
      const candidates = agentRows(selected, { ...selected.query, creatorType: undefined }).rows;
      const values = [...new Set(candidates.map(row => row.creatorType))].filter(value => !url.searchParams.get("search") || value.toLowerCase().includes(url.searchParams.get("search")!.toLowerCase()))
        .sort().map(value => ({ value, count: candidates.filter(row => row.creatorType === value).length }));
      const result = window(values); return respond({ value: result.value, selection: result.selection, counts: result.counts, page: result.page });
    }
    if (path === "/api/official-usage/history") {
      historyRequests.push(url.searchParams);
      const retained = selected.historyIds.map(id => sets.get(id)!).sort((a, b) => b.row.acceptedAt.localeCompare(a.row.acceptedAt));
      const dates = retained.flatMap(set => [set.row.reportingStart, set.row.reportingEnd]).filter((value): value is string => value !== null).sort();
      const count = retained.reduce((sum, set) => sum + set.files.reduce((total, file) => total + file.rowCount, 0), 0);
      const result = base(retained.map(set => ({ ...set.row, active: set.row.id === selected.metadata.activeSetId })));
      result.analytics.history = { imports: retained.length, uniqueObservations: retained.length * 3, observationRows: count, uniquePayloads: count, repeatedRowsReused: 0,
        earliestAcceptedAt: retained.at(-1)?.row.acceptedAt ?? null, latestAcceptedAt: retained[0]?.row.acceptedAt ?? null,
        earliestActivityDateUtc: dates[0] ?? null, latestActivityDateUtc: dates.at(-1) ?? null, earliestReportingStart: null, latestReportingEnd: null,
        knownWindows: 0, unknownWindows: retained.length, overlappingKnownWindows: 0, additive: false, activityRangeProvesCoverage: false };
      return respond(window(result.value, result));
    }
    const observations = /^\/api\/official-usage\/history\/([^/]+)\/observations$/.exec(path);
    if (observations) {
      const set = sets.get(observations[1]); if (!set) return respond({ code: "not_found", detail: "Exact report observations unavailable" }, 404);
      return respond(window(selectedImportData(set.files, metadata(set.row.id)).observations));
    }
    if (path === "/api/official-usage/overview") {
      const all = selected.historyIds.map(id => sets.get(id)!).filter(set => query.scope !== "selected" || set.row.id === selected.metadata.setId);
      const values: ReportOverviewAgent[] = [];
      for (const set of all) for (const agent of selectedImportData(set.files, metadata(set.row.id)).agents) {
        if (values.some(value => value.agentId === agent.agentId)) continue;
        values.push({ agentId: agent.agentId, agentName: agent.agentName, observationCount: 1, hasResponses: agent.responses > 0,
          earliestActivityDateUtc: agent.lastActivityDateUtc, lastActivityDateUtc: agent.lastActivityDateUtc,
          active30Days: Boolean(agent.lastActivityDateUtc && agent.lastActivityDateUtc >= "2026-08-14"), creatorTypeCount: 1,
          latestSetId: set.row.id, latestAcceptedAt: set.row.acceptedAt });
      }
      const filtered = values.filter(row => !query.search || `${row.agentName} ${row.agentId}`.toLowerCase().includes(query.search.toLowerCase()));
      const result = base(filtered, values.length), dates = filtered.flatMap(row => row.lastActivityDateUtc ? [row.lastActivityDateUtc] : []).sort();
      result.analytics.overview = { retainedSets: all.length, reportedAgents: filtered.length, usedAgents: filtered.filter(row => row.hasResponses).length,
        active30Days: filtered.filter(row => row.active30Days).length, undatedAgents: filtered.filter(row => !row.lastActivityDateUtc).length,
        earliestActivityDateUtc: dates[0] ?? null, latestActivityDateUtc: dates.at(-1) ?? null, asOf: "2026-09-12", activeSinceDateUtc: "2026-08-14" };
      return respond(window(filtered, result));
    }
    const agent = /^\/api\/official-usage\/agents\/([^/]+)(?:\/(users))?$/.exec(path);
    if (agent) {
      const id = decodeURIComponent(agent[1]), value = data.agents.find(row => row.agentId === id);
      if (!value) return respond({ code: "not_found", detail: "Exact reported agent unavailable" }, 404);
      if (agent[2]) return respond(window(data.relationships.filter(row => row.agentId === id && (!query.search || row.username.includes(query.search)))));
      const envelope = base([]); return respond({ value, selection: envelope.selection, reports: envelope.reports, sources: envelope.sources });
    }
    const userData = selectedCohortRead(url.href, data);
    if (userData) return respond(userData);
    unexpected.push(`Unimplemented selected import fixture: ${request.method()} ${path}`);
    return respond({ code: "not_found", detail: "Unimplemented selected import fixture" }, 404);
  };
  await page.route(url => url.pathname.startsWith("/api/"), handle);
  await page.context().route(url => /^\/api\/data-exports\/[^/]+\/download$/.test(url.pathname), handle);
  return { unexpected, uploadBodies, uploadIntents, stages, stageReads, discardedStages, bundlePreviews, acceptRequests,
    setPreviews, confirmations, metadataReads, agentRequests, userRequests, historyRequests, apiRequests, commands,
    exportRequests, exportSubmissions, exportStatusBytes, exportDownloads, selectedSetId: () => selectedSetId,
    selectReport(id: string) { expect(sets.has(id)).toBe(true); selectedSetId = id; activeRevision++; },
    deleteImportedReport() { sets.delete(importedSetId); historyRevision++; historyEpoch++; if (selectedSetId === importedSetId) { selectedSetId = null; activeRevision++; } },
  };
}
