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
import { reportBundle } from "../src/test/reportImportFixture";
import { selectedFixtureQuery, selectedFixtureWindow } from "../src/test/selectedUsageFixture";
import { mockLayoutApi } from "./layoutFixtures";
import { selectedCohortRead } from "./selectedCohortFixture";
import { parseSelectedCsv, selectedImportData, selectedImportMetadata, selectedImportPeriod, selectedImportRowHash, type SelectedCsvFixture } from "./selectedImportData";
import { usageCsvFixture } from "./usageCsvFixture";

export const importInstant = "2026-09-12T14:45:00.000Z";
export const importedSetId = "11111111-1111-4111-8111-111111111111";
export const retainedSetId = "99999999-9999-4999-8999-999999999999";
const initialBundle = "22222222-2222-4222-8222-222222222222";
type SavedSet = { row: ReportHistorySet; files: SelectedCsvFixture[] };
type Captured = { path: string; metadata: ReportMetadata; query: ReportQuery; files: SelectedCsvFixture[]; historyIds: string[] };
export type SelectedImportOptions = {
  role?: "Admin" | "Viewer"; active?: boolean; historical?: boolean; staged?: boolean; additionalSavedSets?: number;
  selectedSetId?: string; reusedExistingSet?: boolean; loseAcceptanceResponse?: boolean; stageResponseGate?: Promise<void>;
};

const normalized = (value: string) => value.trim().normalize("NFKC").toLowerCase();
const includes = (value: string, search?: string) => !search || normalized(value).includes(normalized(search));
const dateBefore = (date: string, days: number) => new Date(Date.parse(date) - days * 86400000).toISOString().slice(0, 10);
const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
function sortRows<T>(rows: T[], query: ReportQuery, key: (row: T) => string | number | null, identity: (row: T) => string) {
  return rows.sort((a, b) => {
    const left = key(a), right = key(b);
    if (left === null || right === null) return left === right ? compare(identity(a), identity(b)) : left === null ? 1 : -1;
    return (query.order === "asc" ? 1 : -1) * compare(left, right) || compare(identity(a), identity(b));
  });
}
function matchesActivity(date: string | null, query: ReportQuery, anchor: string | null) {
  const cutoff = anchor ? dateBefore(anchor, (query.inactiveDays ?? 30) - 1) : null;
  return (!query.startDate || Boolean(date && date >= query.startDate)) && (!query.endDate || Boolean(date && date <= query.endDate))
    && (!query.reportActivity || query.reportActivity === "all" || query.reportActivity === "no-activity" && !date
      || query.reportActivity === "recent" && Boolean(date && cutoff && date >= cutoff)
      || query.reportActivity === "inactive" && Boolean(date && cutoff && date < cutoff));
}
function setHash(files: SelectedCsvFixture[]) {
  return createHash("sha256").update(JSON.stringify([...files].sort((a, b) => compare(a.kind, b.kind))
    .map(file => [file.kind, file.contentHash]))).digest("hex");
}

export async function mockSelectedImport(page: Page, csvFiles: Array<{ name: string; content: string }>, options: SelectedImportOptions = {}) {
  await page.clock.setFixedTime(new Date(importInstant));
  const unexpected = await mockLayoutApi(page);
  const seeded = await Promise.all(csvFiles.map(file => parseSelectedCsv(Buffer.from(file.content))));
  const sets = new Map<string, SavedSet>(), selections = new Map<string, Captured>();
  const versions = new Map<string, SelectedCsvFixture>();
  const stages: OfficialReportPreview[] = [], stagedFiles = new Map<string, SelectedCsvFixture>(), discardedStages: string[] = [];
  const uploadBodies: string[] = [], uploadIntents: URLSearchParams[] = [], stageReads: string[] = [];
  const bundlePreviews: OfficialReportBundlePreview[] = [], acceptRequests: Array<OfficialReportBundleAcceptance & { bundleId: string }> = [];
  const receipts = new Map<string, OfficialReportAccepted>(), acceptedBundles = new Map<string, OfficialReportAccepted>();
  const setPreviews: OfficialReportConfirmation[] = [], confirmations: OfficialReportConfirmation[] = [];
  const confirmationReceipts = new Map<string, OfficialReportConfirmation>();
  const agentRequests: URLSearchParams[] = [], userRequests: URLSearchParams[] = [], historyRequests: URLSearchParams[] = [];
  const metadataReads: ReportMetadata[] = [], apiRequests: string[] = [], commands: string[] = [], exportRequests: URLSearchParams[] = [];
  const exports = new Map<string, { selected: Captured; rows: ReportAgent[]; bytes: Buffer; status: OfficialReportExportStatus }>();
  const exportIntents = new Map<string, { id: string; selectionId: string }>();
  const exportSubmissions: OfficialReportExportRequest[] = [], exportStatusBytes: number[] = [], exportDownloads: boolean[] = [];
  let activeRevision = options.active ? 2 : 1, historyRevision = 1, historyEpoch = 1;
  let selectedSetId = options.selectedSetId ?? (options.active ? importedSetId : null);
  let hasHistory = Boolean(options.active || options.historical);
  let usedImportedSetId = Boolean(options.active);
  function save(id: string, bundleId: string, files: SelectedCsvFixture[], acceptedAt = importInstant, supersedesSetId: string | null = null) {
    const period = selectedImportPeriod(files);
    if (!period) throw new Error("A synthetic report set requires at least one CSV.");
    const previous = supersedesSetId ? sets.get(supersedesSetId) : undefined;
    files = files.map(file => {
      let version = versions.get(file.contentHash);
      if (!version) {
        version = structuredClone({ ...file, observation: { acceptedAt,
          supersedesVersionId: previous?.files.find(row => row.kind === file.kind)?.versionId ?? null } });
        versions.set(file.contentHash, version);
      }
      return version;
    });
    sets.set(id, { row: historySet(1, { id, bundleId, acceptedAt, reportingStart: period.startDate, reportingEnd: period.endDate,
      periodProvenance: period.provenance, contentHash: setHash(files), supersedesSetId,
      active: id === selectedSetId }), files });
  }
  function deleteSet(id: string) {
    const removed = sets.get(id);
    sets.delete(id); historyRevision++; historyEpoch++;
    for (const file of removed?.files ?? []) {
      if (![...sets.values()].some(set => set.files.some(row => row.versionId === file.versionId))) versions.delete(file.contentHash);
    }
    if (selectedSetId === id) { selectedSetId = null; activeRevision++; }
  }
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
  if (!Number.isInteger(options.additionalSavedSets ?? 0) || (options.additionalSavedSets ?? 0) < 0 || (options.additionalSavedSets ?? 0) > 64) {
    throw new Error("Synthetic retained-set fixture requires an integer count from 0 to 64");
  }
  for (let index = 0; index < (options.additionalSavedSets ?? 0); index++) {
    save(`aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`, randomUUID(), seeded, "2026-06-02T10:00:00.000Z");
  }
  if (options.active) save(importedSetId, initialBundle, seeded);
  function metadata(id: string | null = selectedSetId): ReportMetadata {
    const saved = id ? sets.get(id) : undefined;
    const result = selectedImportMetadata(saved?.files ?? [], {
      setId: saved?.row.id ?? null, activeSetId: selectedSetId, activeRevision: String(activeRevision),
      historyRevision: String(historyRevision), historyEpoch: String(historyEpoch),
      acceptedAt: saved?.row.acceptedAt ?? null, expiresAt: saved ? "2027-03-11T14:45:00.000Z" : null, evaluatedAt: importInstant,
    });
    if (!saved) result.availability = sets.size ? "not_selected" : hasHistory ? "deleted" : "never_imported";
    return result;
  }
  function createStage(file: SelectedCsvFixture, bundleId: string, correctionOfSetId: string | null = null) {
    const stage: OfficialReportPreview = {
      id: randomUUID(), revision: 1, kind: file.kind, bundleId, contentHash: file.contentHash, fileHash: file.fileHash,
      rowCount: file.rowCount, storedBytes: Buffer.byteLength(JSON.stringify(file.rows)), wireBytes: file.wireBytes, activeRevision: String(activeRevision),
      expiresAt: "2026-09-12T15:15:00.000Z", reportingPeriod: file.reportingPeriod, sourceAsOf: file.sourceAsOf ?? null,
      sourceAsOfProvenance: file.sourceAsOfProvenance, sourceFreshness: file.sourceFreshness, correctionOfSetId,
      status: "active", examples: file.examples, warnings: file.warnings,
      reconciliation: { rows: file.rowCount,
        responses: file.rows.reduce((sum, row) => sum + ("agentResponsesReceived" in row ? row.agentResponsesReceived : row.responsesSentToUsers), 0),
        agentsUsed: file.kind === "users" ? file.rows.reduce((sum, row) => sum + ("numberOfAgentsUsed" in row ? row.numberOfAgentsUsed : 0), 0) : null },
    };
    stages.push(structuredClone(stage)); stagedFiles.set(stage.id, file); return stage;
  }
  if (options.staged) createStage(seeded[0], initialBundle);
  function activeStages(bundleId: string) { return stages.filter(stage => stage.bundleId === bundleId && !discardedStages.includes(stage.id)); }
  function bundlePreview(bundleId: string, forDiscard = false): OfficialReportBundlePreview {
    const current = activeStages(bundleId);
    if (!forDiscard) selectedImportPeriod(current.map(stage => stagedFiles.get(stage.id)!));
    return reportBundle(current, bundleId, String(activeRevision));
  }
  function captured(url: URL) {
    const root = /^\/api\/official-usage\/(?:aggregate|agents)(?:\/|$)/.test(url.pathname) ? "/api/official-usage/aggregate"
      : url.pathname.startsWith("/api/official-usage/history") ? "/api/official-usage/history"
        : url.pathname.startsWith("/api/official-usage/users") ? "/api/official-usage/users" : url.pathname;
    const input = new URL(url);
    input.pathname = root;
    if (url.pathname.endsWith("/facets")) { input.searchParams.delete("search"); input.searchParams.delete("field"); }
    if (/\/(?:agents\/[^/]+\/users|users\/[^/]+\/agents)$/.test(url.pathname)) {
      for (const key of Object.keys(selectedFixtureQuery(input.href))) input.searchParams.delete(key);
    }
    const query = selectedFixtureQuery(input.href);
    if (query.search !== undefined) query.search = normalized(query.search);
    query.lowResponseThreshold ??= 5; query.inactiveDays ??= 30; query.activityWindowDays ??= 30;
    const selectionId = url.searchParams.get("selectionId"), prior = selectionId ? selections.get(selectionId) : undefined;
    if (selectionId && !prior) throw new AppError(409, "selection_invalidated", "Unknown selected fixture context.");
    if (prior) {
      if (prior.path !== root || Object.keys(query).some(key => input.searchParams.has(key)) && JSON.stringify(query) !== JSON.stringify(prior.query)) {
        throw new AppError(400, "invalid_cursor", "Selection endpoint and filters are immutable.");
      }
      return { selected: prior, selectionId: selectionId! };
    }
    if (selections.size >= 250) throw new Error("Synthetic selection fixture exceeded its bound");
    if (query.setId && !sets.has(query.setId)) throw new AppError(404, "official_usage_set_not_found", "The exact synthetic report set is unavailable.");
    const reports = metadata(query.setId ?? selectedSetId);
    const selected: Captured = { path: root, metadata: reports, query, files: reports.setId ? sets.get(reports.setId)!.files : [], historyIds: [...sets.keys()] };
    const id = randomUUID(); selections.set(id, selected); return { selected, selectionId: id };
  }
  function agentRows(selected: Captured, query = selected.query) {
    const data = selectedImportData(selected.files, selected.metadata);
    const anchor = data.agents.flatMap(row => row.lastActivityDateUtc ? [row.lastActivityDateUtc] : []).sort().at(-1) ?? null;
    const rows = data.agents.filter(row => includes(`${row.agentName} ${row.agentId} ${row.creatorType}`, query.search)
      && (!query.creatorType || row.creatorType === query.creatorType) && (!query.agentId || row.agentId === query.agentId)
      && (!query.responsesOnly || row.responses > 0) && matchesActivity(row.lastActivityDateUtc, query, anchor));
    const key = (row: ReportAgent) => query.sort === "name" ? row.agentName : query.sort === "activeUsers" ? row.activeUsers
      : query.sort === "licensedUsers" ? row.licensedUserOccurrences : query.sort === "unlicensedUsers" ? row.unlicensedUserOccurrences
        : query.sort === "lastActivity" ? row.lastActivityDateUtc : row.responses;
    sortRows(rows, query, key, row => row.agentId);
    return { data, rows };
  }
  function historyRows(selected: Captured) {
    const query = selected.query;
    return sortRows(selected.historyIds.map(id => sets.get(id)!).filter(set => includes(`${set.row.id} ${set.row.acceptedAt}`, query.search)), query,
      ({ row }) => query.sort === "acceptedAt" ? row.acceptedAt
        : row.reportingEnd === null ? null : `${row.reportingEnd}/${row.reportingStart ?? ""}/${row.acceptedAt}`,
      set => set.row.id);
  }
  const handle = async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    apiRequests.push(path);
    const respond = (json: unknown, status = 200) => {
      expect(Buffer.byteLength(JSON.stringify(json))).toBeLessThanOrEqual(1024 * 1024);
      return route.fulfill({ status, json: structuredClone(json) });
    };
    const notFound = () => respond({ code: "not_found", detail: "No matching synthetic route." }, 404);
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
      if (method !== "POST") return notFound();
      const body = request.postDataBuffer()!.toString("utf8"); uploadBodies.push(body); uploadIntents.push(url.searchParams);
      expect(url.searchParams.get("bundleId")).toMatch(/^[a-f0-9-]{36}$/); expect(body).not.toContain('name="bundleId"');
      expect(url.searchParams.get("rejectDuplicateKind")).toBe("true");
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
      const correctionOfSetId = url.searchParams.get("correctionOfSetId");
      if (correctionOfSetId && !sets.has(correctionOfSetId)) return respond({ code: "invalid_correction", detail: "Correction target is unavailable." }, 409);
      if (activeStages(bundleId).some(stage => stage.kind === file.kind)) return respond({ code: "duplicate_report_kind", detail: "Choose a missing companion kind." }, 409);
      const stage = createStage(file, bundleId, correctionOfSetId);
      await options.stageResponseGate; return respond(stage, 201);
    }
    const staging = /^\/api\/official-usage\/staging\/([^/]+)(?:\/(diagnostics))?$/.exec(path);
    if (staging) {
      if (method !== "GET" && (method !== "DELETE" || staging[2])) return notFound();
      const stage = stages.find(value => value.id === staging[1] && !discardedStages.includes(value.id));
      if (!stage || method === "DELETE" && stage.status !== "active") {
        return respond({ code: "staging_unavailable", detail: "The exact staging receipt is unavailable for this operation." }, 409);
      }
      if (method === "DELETE") { discardedStages.push(stage.id); return route.fulfill({ status: 204 }); }
      stageReads.push(stage.id);
      if (staging[2]) return respond({ value: [], counts: { total: 0, filtered: 0 }, preview: { id: stage.id, revision: stage.revision, contentHash: stage.contentHash },
        page: { limit: 50, nextCursor: null, previousCursor: null } });
      return respond(stage);
    }
    const bundle = /^\/api\/official-usage\/bundles\/([^/]+)\/(preview|accept)$/.exec(path);
    if (bundle) {
      if (method !== "POST") return notFound();
      const current = activeStages(bundle[1]);
      if (bundle[2] === "preview") {
        const forDiscard = request.postDataJSON()?.forDiscard;
        if (forDiscard !== undefined && typeof forDiscard !== "boolean") {
          return respond({ code: "invalid_import_intent", detail: "Bundle cleanup inspection must be a boolean." }, 400);
        }
        try {
          const preview = bundlePreview(bundle[1], forDiscard === true);
          bundlePreviews.push(preview); return respond(preview);
        } catch (error) {
          if (error instanceof AppError) return respond({ code: error.code, detail: error.message }, error.status);
          throw error;
        }
      }
      const body: OfficialReportBundleAcceptance = request.postDataJSON(); acceptRequests.push({ bundleId: bundle[1], ...body });
      if (body.preserveSelection !== undefined && typeof body.preserveSelection !== "boolean") {
        return respond({ code: "invalid_import_intent", detail: "Preserving the report selection must be a boolean." }, 400);
      }
      const receiptKey = JSON.stringify([bundle[1], body.bundleHash, body.expectedActiveRevision]);
      const receipt = receipts.get(receiptKey);
      if (receipt) {
        if (!sets.has(receipt.setId)) return respond({ code: "deleted_report_duplicate", detail: "This accepted report was deleted." }, 409);
        return respond(receipt);
      }
      let reviewed: OfficialReportBundlePreview;
      try { reviewed = bundlePreview(bundle[1]); }
      catch (error) {
        if (error instanceof AppError) return respond({ code: error.code, detail: error.message }, error.status);
        throw error;
      }
      if (!reviewed.complete || body.bundleHash !== reviewed.bundleHash || body.expectedActiveRevision !== reviewed.expectedActiveRevision) {
        return respond({ code: "bundle_fence_mismatch", detail: "Review the current complete bundle before accepting." }, 409);
      }
      const accepted = acceptedBundles.get(bundle[1]);
      if (accepted) {
        if (!sets.has(accepted.setId)) return respond({ code: "deleted_report_duplicate", detail: "This accepted report was deleted." }, 409);
        receipts.set(receiptKey, accepted);
        return respond(accepted);
      }
      const files = current.map(stage => stagedFiles.get(stage.id)!);
      const correctionOfSetId = current[0].correctionOfSetId, target = correctionOfSetId ? sets.get(correctionOfSetId) : undefined;
      const period = selectedImportPeriod(files)!;
      if (current.some(stage => stage.correctionOfSetId !== correctionOfSetId)) return respond({ code: "staging_unavailable", detail: "Companion correction targets differ." }, 409);
      if (correctionOfSetId && (!target || target.row.periodProvenance !== period.provenance
        || period.provenance !== "activity_range" && (target.row.reportingStart !== period.startDate || target.row.reportingEnd !== period.endDate))) {
        return respond({ code: "invalid_correction", detail: "Correction reporting window differs or its target is unavailable." }, 409);
      }
      const existing = [...sets.values()].find(set => set.row.contentHash === setHash(files)
        && (!correctionOfSetId || set.row.id === correctionOfSetId || set.row.supersedesSetId === correctionOfSetId));
      if (options.reusedExistingSet) expect(existing?.row.id).toBe(importedSetId);
      const setId = existing?.row.id ?? (usedImportedSetId ? randomUUID() : importedSetId);
      for (const stage of current) stages[stages.indexOf(stage)] = { ...stage, status: "accepted" };
      if (!existing) {
        const active = selectedSetId ? sets.get(selectedSetId)?.row : undefined;
        const backfill = active?.reportingEnd && (!period.endDate
          || `${period.endDate}/${period.startDate ?? ""}` < `${active.reportingEnd}/${active.reportingStart ?? ""}`);
        if (!body.preserveSelection && (!selectedSetId || correctionOfSetId === selectedSetId || !correctionOfSetId && !backfill)) {
          selectedSetId = setId; activeRevision++;
        }
        usedImportedSetId = true; historyRevision++;
        if (correctionOfSetId && target) {
          historyEpoch++;
          sets.set(correctionOfSetId, { ...target, row: { ...target.row, visibility: "superseded" } });
        }
        save(setId, bundle[1], files, importInstant, correctionOfSetId);
      }
      hasHistory = true;
      const result: OfficialReportAccepted = { setId, activeRevision: String(activeRevision), complete: true };
      receipts.set(receiptKey, result); acceptedBundles.set(bundle[1], result);
      if (options.loseAcceptanceResponse) return route.abort("failed");
      return respond(result);
    }
    const preview = /^\/api\/official-usage\/sets\/([^/]+)\/preview$/.exec(path);
    if (preview) {
      if (method !== "POST") return notFound();
      const operation: OfficialReportConfirmation["operation"] = request.postDataJSON()?.operation;
      if (operation !== "select" && operation !== "delete") return respond({ code: "invalid_operation", detail: "Unsupported operation." }, 400);
      const target = sets.get(preview[1]);
      if (!target || operation === "select" && target.row.visibility !== "retained") {
        return respond({ code: "staging_unavailable", detail: "The exact report is unavailable for this operation." }, 409);
      }
      const intent = { id: randomUUID(), setId: preview[1], operation, activeRevision: String(activeRevision),
        historyRevision: String(historyRevision), historyEpoch: String(historyEpoch) };
      const result = { ...intent, hash: createHash("sha256").update(JSON.stringify(intent)).digest("hex") };
      confirmationReceipts.set(result.id, result);
      setPreviews.push(structuredClone(result)); return respond(result);
    }
    const confirmationPath = /^\/api\/official-usage\/confirmations\/([^/]+)$/.exec(path);
    if (confirmationPath) {
      if (method !== "POST") return notFound();
      const confirmation: OfficialReportConfirmation = request.postDataJSON();
      if (confirmation?.id !== confirmationPath[1]) return respond({ code: "invalid_identifier", detail: "Confirmation ID mismatch." }, 400);
      const reviewed = confirmationReceipts.get(confirmation.id);
      if (!reviewed || Object.keys(reviewed).some(key => reviewed[key as keyof OfficialReportConfirmation] !== confirmation[key as keyof OfficialReportConfirmation])
        || confirmation.activeRevision !== String(activeRevision) || confirmation.historyRevision !== String(historyRevision)
        || confirmation.historyEpoch !== String(historyEpoch) || !sets.has(confirmation.setId)) {
        return respond({ code: "confirmation_mismatch", detail: "Review a new immutable confirmation." }, 409);
      }
      confirmationReceipts.delete(confirmation.id);
      confirmations.push(structuredClone(confirmation));
      if (confirmation.operation === "select") { selectedSetId = confirmation.setId; activeRevision++; }
      else deleteSet(confirmation.setId);
      return respond({ activeSetId: selectedSetId, activeRevision: String(activeRevision) });
    }
    if (path === "/api/data-exports") {
      if (method !== "POST") return notFound();
      const body: OfficialReportExportRequest = request.postDataJSON(); exportSubmissions.push(body);
      expect(Object.keys(body).sort()).toEqual(["idempotencyKey", "kind", "selectionId"]);
      expect(body.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/); expect(body.kind).toBe("official_agents");
      const selected = selections.get(body.selectionId);
      if (!selected || selected.metadata.historyEpoch !== String(historyEpoch)) {
        return respond({ code: "selection_invalidated", detail: "Report history changed. Restart selection." }, 409);
      }
      if (selected.path !== "/api/official-usage/aggregate") {
        return respond({ code: "export_selection_kind", detail: "Export kind must match the pinned endpoint." }, 400);
      }
      const previous = exportIntents.get(body.idempotencyKey!);
      if (previous) return previous.selectionId === body.selectionId ? respond({ id: previous.id }, 202)
        : respond({ code: "export_idempotency_conflict", detail: "Export intent changed; create a new request." }, 409);
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
        lastActivityDateUtc: row.lastActivityDateUtc === null ? "Unknown" : new Date(row.lastActivityDateUtc).toISOString(),
        sourceReports: row.reportResponses === null ? "userAgents" : row.bridgeResponses === null ? "agents" : "agents | userAgents",
        identityStatus: row.identityStatus, reportSetId: selected.metadata.setId, historyRevision: selected.metadata.historyRevision,
        reportingStart: selected.metadata.reportingPeriod?.startDate, reportingEnd: selected.metadata.reportingPeriod?.endDate,
        ...Object.fromEntries(selected.metadata.lineages.flatMap(lineage => [
          [`${lineage.kind}VersionId`, lineage.versionId], [`${lineage.kind}PeriodProvenance`, lineage.periodProvenance], [`${lineage.kind}SourceFreshness`, lineage.sourceFreshness],
        ])),
      })));
      const id = randomUUID(), status: OfficialReportExportStatus = { id, status: "ready", rows: rows.length, bytes: bytes.length,
        expiresAt: "2026-09-12T15:15:00.000Z", error: null, limit: null, observed: null };
      exports.set(id, { selected, rows, bytes, status });
      exportIntents.set(body.idempotencyKey!, { id, selectionId: body.selectionId });
      return respond({ id }, 202);
    }
    const exportPath = /^\/api\/data-exports\/([^/]+)(?:\/(download))?$/.exec(path);
    if (exportPath) {
      if (method !== "GET" && (method !== "DELETE" || exportPath[2])) return notFound();
      const stored = exports.get(exportPath[1]);
      if (!stored) return respond({ code: "export_not_found", detail: "Export is unavailable." }, 404);
      if (stored.selected.metadata.historyEpoch !== String(historyEpoch)) {
        return respond({ code: "selection_invalidated", detail: "Report history changed. Restart selection." }, 409);
      }
      if (method === "DELETE") { stored.status = { ...stored.status, status: "cancelled" }; return route.fulfill({ status: 204 }); }
      if (exportPath[2]) {
        if (stored.status.status !== "ready") return respond({ code: "export_not_ready", detail: "Export is not ready." }, 409);
        exportDownloads.push(request.isNavigationRequest());
        return route.fulfill({ contentType: "text/csv", headers: { "Content-Disposition": 'attachment; filename="official-agents.csv"' }, body: stored.bytes });
      }
      exportStatusBytes.push(Buffer.byteLength(JSON.stringify(stored.status))); return respond(stored.status);
    }
    if (!path.startsWith("/api/official-usage/") || request.method() !== "GET") return route.fallback();
    if (path === "/api/official-usage/aggregate") agentRequests.push(url.searchParams);
    if (path === "/api/official-usage/users") userRequests.push(url.searchParams);
    let capture: ReturnType<typeof captured>;
    try { capture = captured(url); }
    catch (error) {
      if (error instanceof AppError) return respond({ code: error.code, detail: error.message }, error.status);
      throw error;
    }
    const { selected, selectionId } = capture;
    if (selected.metadata.historyEpoch !== String(historyEpoch)) return respond({ code: "selection_invalidated", detail: "Report history changed. Restart selection." }, 409);
    const query = selected.query;
    const { data, rows } = agentRows(selected, query);
    data.directory.selection = { ...data.directory.selection, id: selectionId,
      evaluatedAt: importInstant, validatedAt: importInstant, expiresAt: "2026-09-12T14:55:00.000Z" };
    const base = <T>(value: T[], total = value.length): ReportPage<T> => reportPage(value, {
      reports: selected.metadata, sources: data.directory.sources, summary: data.summary, filters: query,
      selection: data.directory.selection, counts: { total, filtered: value.length },
      analytics: { basis: "filtered_rows", rowCount: value.length, responses: null, zeroResponses: null, unknownResponses: null,
        review: null, agents: null, history: null, overview: null },
    });
    const window = <T>(value: T[], page = base(value)) => selectedFixtureWindow(url.href, value, page);
    if (path === "/api/official-usage/aggregate") {
      metadataReads.push(selected.metadata);
      const anchor = data.agents.flatMap(row => row.lastActivityDateUtc ? [row.lastActivityDateUtc] : []).sort().at(-1) ?? null;
      const cutoff = anchor ? new Date(Date.parse(anchor) - ((query.activityWindowDays ?? 30) - 1) * 86400000).toISOString().slice(0, 10) : null;
      const recent = rows.filter(row => row.lastActivityDateUtc && cutoff && row.lastActivityDateUtc >= cutoff);
      const inactiveBefore = dateBefore(importInstant, query.inactiveDays ?? 30);
      const analytics: ReportAnalytics = { ...base(rows).analytics, responses: rows.length ? rows.reduce((sum, row) => sum + row.responses, 0) : null,
        zeroResponses: rows.filter(row => !row.responses).length, unknownResponses: 0, agents: {
          inactive: rows.filter(row => row.lastActivityDateUtc && row.lastActivityDateUtc < inactiveBefore).length,
          neverUsed: rows.filter(row => !row.lastActivityDateUtc).length, anchorDateUtc: anchor, windowDays: query.activityWindowDays ?? 30,
          windowAgents: recent.length, windowResponses: recent.length ? recent.reduce((sum, row) => sum + row.responses, 0) : null,
          windowDistinctActiveUsers: new Set(data.relationships.filter(link => link.responses > 0 && recent.some(row => row.agentId === link.agentId)).map(link => link.username)).size,
          mostResponses: sortRows([...rows], { order: "desc" }, row => row.responses, row => row.agentId).slice(0, 10).map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses })),
          leastResponses: sortRows([...rows], { order: "asc" }, row => row.responses, row => row.agentId).slice(0, 10).map(row => ({ agentId: row.agentId, name: row.agentName, responses: row.responses })),
        } };
      return respond(window(rows, { ...base(rows, data.agents.length), analytics }));
    }
    if (path === "/api/official-usage/aggregate/facets") {
      const candidates = agentRows(selected, { ...selected.query, creatorType: undefined }).rows;
      const values = [...new Set(candidates.map(row => row.creatorType))].filter(value => includes(value, url.searchParams.get("search") ?? undefined))
        .sort().map(value => ({ value, count: candidates.filter(row => row.creatorType === value).length }));
      const result = window(values); return respond({ value: result.value, selection: result.selection, counts: result.counts, page: result.page });
    }
    if (path === "/api/official-usage/history" || path === "/api/official-usage/history/options") {
      historyRequests.push(url.searchParams);
      const retained = historyRows(selected);
      const result = base(retained.map(set => ({ ...set.row, active: set.row.id === selected.metadata.activeSetId })), selected.historyIds.length);
      if (path.endsWith("/options")) {
        const { value, page, counts, selection, reports } = window(result.value, result);
        return respond({ value, page, counts, selection, reports });
      }
      const files = [...new Map(retained.flatMap(set => set.files.map(file => [file.versionId, file] as const))).values()];
      const observations = files.flatMap(file => file.rows.map(row => ({ kind: file.kind, row })));
      const dates = observations.flatMap(({ row }) => row.lastActivityDateUtc ? [row.lastActivityDateUtc.slice(0, 10)] : []).sort();
      const payloads = new Set(observations.map(({ kind, row }) => JSON.stringify([kind, selectedImportRowHash(row)])));
      const accepted = retained.map(set => set.row.acceptedAt).sort();
      const known = retained.filter(({ row }) => row.periodProvenance !== "activity_range" && row.reportingStart !== null && row.reportingEnd !== null);
      result.analytics.history = { imports: retained.length, uniqueObservations: files.length, observationRows: observations.length,
        uniquePayloads: payloads.size, repeatedRowsReused: observations.length - payloads.size,
        earliestAcceptedAt: accepted[0] ?? null, latestAcceptedAt: accepted.at(-1) ?? null,
        earliestActivityDateUtc: dates[0] ?? null, latestActivityDateUtc: dates.at(-1) ?? null,
        earliestReportingStart: known.map(set => set.row.reportingStart!).sort()[0] ?? null,
        latestReportingEnd: known.map(set => set.row.reportingEnd!).sort().at(-1) ?? null,
        knownWindows: known.length, unknownWindows: retained.length - known.length,
        overlappingKnownWindows: known.filter(set => known.some(other => other !== set && other.row.reportingStart! <= set.row.reportingEnd!
          && other.row.reportingEnd! >= set.row.reportingStart!)).length, additive: false, activityRangeProvesCoverage: false };
      return respond(window(result.value, result));
    }
    const observations = /^\/api\/official-usage\/history\/([^/]+)\/observations$/.exec(path);
    if (observations) {
      const set = historyRows(selected).find(set => set.row.id === observations[1]);
      if (!set) return respond({ code: "data_record_not_found", detail: "Record is not in the selected cohort." }, 404);
      return respond(window(selectedImportData(set.files, metadata(set.row.id)).observations));
    }
    if (path === "/api/official-usage/overview") {
      const all = selected.historyIds.map(id => sets.get(id)!).filter(set => query.scope !== "selected" || set.row.id === selected.metadata.setId)
        .sort((a, b) => compare(b.row.acceptedAt, a.row.acceptedAt) || compare(b.row.id, a.row.id));
      const values = new Map<string, { row: ReportOverviewAgent; versions: Set<string>; creators: Set<string> }>();
      const seenVersions = new Set<string>(), agentIds = new Set<string>();
      for (const set of all) for (const file of set.files) {
        if (file.kind === "users" || seenVersions.has(file.versionId)) continue;
        seenVersions.add(file.versionId);
        for (const row of file.rows) {
          if (!("agentId" in row)) continue;
          const date = row.lastActivityDateUtc?.slice(0, 10) ?? null;
          agentIds.add(row.agentId);
          if (!includes(`${row.agentName} ${row.agentId}`, query.search) || !matchesActivity(date, query, null)) continue;
          let value = values.get(row.agentId);
          if (!value) {
            value = { versions: new Set(), creators: new Set(), row: { agentId: row.agentId, agentName: row.agentName,
              observationCount: 0, creatorTypeCount: 0, hasResponses: false, earliestActivityDateUtc: null, lastActivityDateUtc: null,
              active30Days: false, latestSetId: set.row.id, latestAcceptedAt: set.row.acceptedAt } };
            values.set(row.agentId, value);
          }
          value.versions.add(file.versionId); value.creators.add(row.creatorType);
          value.row.observationCount = value.versions.size; value.row.creatorTypeCount = value.creators.size;
          value.row.hasResponses ||= row.responsesSentToUsers > 0;
          if (date) {
            const dates = [value.row.earliestActivityDateUtc, value.row.lastActivityDateUtc, date]
              .filter((date): date is string => date !== null).sort();
            value.row.earliestActivityDateUtc = dates[0]; value.row.lastActivityDateUtc = dates.at(-1)!;
            value.row.active30Days ||= row.responsesSentToUsers > 0 && date >= dateBefore(importInstant, 29) && date <= importInstant.slice(0, 10);
          }
        }
      }
      const filtered = sortRows([...values.values()].map(value => value.row), query,
        row => query.sort === "lastActivity" ? row.lastActivityDateUtc : row.agentName, row => row.agentId);
      const result = base(filtered, agentIds.size), dates = filtered.flatMap(row => [row.earliestActivityDateUtc, row.lastActivityDateUtc])
        .filter((date): date is string => date !== null).sort();
      result.analytics.overview = { retainedSets: all.length, reportedAgents: filtered.length, usedAgents: filtered.filter(row => row.hasResponses).length,
        active30Days: filtered.filter(row => row.active30Days).length, undatedAgents: filtered.filter(row => !row.lastActivityDateUtc).length,
        earliestActivityDateUtc: dates[0] ?? null, latestActivityDateUtc: dates.at(-1) ?? null, asOf: "2026-09-12", activeSinceDateUtc: "2026-08-14" };
      return respond(window(filtered, result));
    }
    const agent = /^\/api\/official-usage\/agents\/([^/]+)(?:\/(users))?$/.exec(path);
    if (agent) {
      const id = decodeURIComponent(agent[1]), value = rows.find(row => row.agentId === id);
      if (!value) return respond({ code: "data_record_not_found", detail: "Record is not in the selected cohort." }, 404);
      if (agent[2]) {
        const childQuery = selectedFixtureQuery(url.href), links = data.relationships.filter(row => row.agentId === id);
        const anchor = links.flatMap(row => row.lastActivityDateUtc ? [row.lastActivityDateUtc] : []).sort().at(-1) ?? null;
        const filtered = links.filter(row => includes(`${row.agentName} ${row.agentId} ${row.creatorType} ${row.username}`, childQuery.search)
          && (!childQuery.agentId || row.agentId === childQuery.agentId) && (!childQuery.username || row.username === childQuery.username)
          && (!childQuery.creatorType || row.creatorType === childQuery.creatorType) && (!childQuery.responsesOnly || row.responses > 0)
          && matchesActivity(row.lastActivityDateUtc, childQuery, anchor));
        sortRows(filtered, childQuery, row => childQuery.sort === "responses" ? row.responses : childQuery.sort === "lastActivity" ? row.lastActivityDateUtc
          : childQuery.sort === "creatorType" ? row.creatorType : row.agentName, row => row.id);
        return respond(window(filtered, { ...base(filtered, links.length), filters: childQuery }));
      }
      const envelope = base([]); return respond({ value, selection: envelope.selection, reports: envelope.reports, sources: envelope.sources });
    }
    const userData = selectedCohortRead(url.href, data, query);
    if (userData) {
      if (!("summary" in userData)) return respond(userData);
      if (path === "/api/official-usage/users") {
        const review = userData.analytics.review;
        if (!review) throw new Error("Reported-user fixture is missing its cohort analytics");
        userData.analytics = { ...userData.analytics, zeroResponses: review.zero, unknownResponses: review.unknown,
          responses: userData.analytics.rowCount === review.unknown ? null : userData.analytics.responses };
      }
      return respond({ ...userData, summary: data.summary });
    }
    if (path.startsWith("/api/official-usage/users/")) return respond({ code: "data_record_not_found", detail: "Record is not in the selected cohort." }, 404);
    unexpected.push(`Unimplemented selected import fixture: ${request.method()} ${path}`);
    return respond({ code: "not_found", detail: "Unimplemented selected import fixture" }, 404);
  };
  await page.route(url => url.pathname.startsWith("/api/"), handle);
  await page.context().route(url => /^\/api\/data-exports\/[^/]+\/download$/.test(url.pathname), handle);
  return { unexpected, uploadBodies, uploadIntents, stages, stageReads, discardedStages, bundlePreviews, acceptRequests,
    setPreviews, confirmations, metadataReads, agentRequests, userRequests, historyRequests, apiRequests, commands,
    exportRequests, exportSubmissions, exportStatusBytes, exportDownloads, selectedSetId: () => selectedSetId,
    selectReport(id: string) { expect(sets.has(id)).toBe(true); selectedSetId = id; activeRevision++; },
    deleteImportedReport() { deleteSet(importedSetId); },
  };
}
