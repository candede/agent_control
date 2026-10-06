import { ApiError, captureRequestSession, request } from "./client";
import type { ReportQuery, CombinedUser, ReportUser, ReportAgent, ReportHistorySet, ReportOverviewAgent, ReportListPage, ReportPage } from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail, OfficialReportExportRequest, OfficialReportExportStatus, OfficialReportFacetPage,
  OfficialReportImportIntent, OfficialReportPreview, OfficialReportBundlePreview, OfficialReportBundleAcceptance, OfficialReportAccepted,
  OfficialReportConfirmation, OfficialReportConfirmed, OfficialReportDiagnostics,
  CandidateAgentUsageSummary, CandidateAgentUsageHistory, CandidateAgentUsageAssociations, CandidateAgentUsageCandidates, CandidateAgentUsageMutation, CandidateAgentUsageContext } from "../../../backend/src/types/officialReportApi";

export type ReportPageRequest = ReportQuery & { selectionId?: string; inventorySelectionId?: string; cursor?: string; limit?: number };
export function encodeReportFacetValue(value: string | null): string {
  return value === null ? "~null" : `~string:${value}`;
}
export function reportQueryString(query: ReportPageRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, (key === "company" || key === "department")
      ? encodeReportFacetValue(value as string | null) : String(value));
  }
  return params.size ? `?${params}` : "";
}

export function readReportPage<T, Page extends ReportListPage<T> = ReportPage<T>>(path: string, query: ReportPageRequest = {}, signal?: AbortSignal) {
  return request<Page>(`/api/${path}${reportQueryString(query)}`, { signal });
}
export const reportPages = {
  users: (query: ReportPageRequest, signal?: AbortSignal) => readReportPage<CombinedUser>("copilot-usage/users", query, signal),
  reportedUsers: (query: ReportPageRequest, signal?: AbortSignal) => readReportPage<ReportUser>("official-usage/users", query, signal),
  agents: (query: ReportPageRequest, signal?: AbortSignal) => readReportPage<ReportAgent>("official-usage/aggregate", query, signal),
  history: (query: ReportPageRequest, signal?: AbortSignal) => readReportPage<ReportHistorySet>("official-usage/history", query, signal),
  overview: (query: ReportPageRequest, signal?: AbortSignal) => readReportPage<ReportOverviewAgent>("official-usage/overview", query, signal),
};
export function readReportDetail<T>(path: string, selectionId: string | undefined, signal?: AbortSignal) {
  return request<OfficialReportDetail<T>>(`/api/${path}${reportQueryString({ selectionId })}`, { signal });
}
export function readReportFacet(path: string, selectionId: string, field: "company" | "department" | "creatorType",
  options: { cursor?: string; search?: string; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ selectionId, field, limit: "50" });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.search) params.set("search", options.search);
  return request<OfficialReportFacetPage>(`/api/${path}/facets?${params}`, { signal: options.signal });
}
export function createReportExport(input: OfficialReportExportRequest, signal?: AbortSignal) {
  const intent = { ...input, ids: input.ids?.slice(), idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() };
  return retryExportSetup(() => post<{ id: string }>("/api/data-exports", intent, signal), signal);
}
export function reportExportStatus(id: string, signal?: AbortSignal) {
  return retryExportSetup(() => request<OfficialReportExportStatus>(`/api/data-exports/${encodeURIComponent(id)}`, { signal }), signal);
}
export function cancelReportExport(id: string, signal?: AbortSignal) {
  return retryExportSetup(() => request<void>(`/api/data-exports/${encodeURIComponent(id)}`, { method: "DELETE", signal }), signal);
}
async function retryExportSetup<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const assertCurrentSession = captureRequestSession();
  const aborted = () => new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
  for (let attempt = 0; ; attempt++) {
    assertCurrentSession();
    if (signal?.aborted) throw aborted();
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof ApiError) || signal?.aborted || attempt >= 2
        || !(error.kind === "network" || [429, 503].includes(error.status))
        || (error.retryAfterSeconds ?? 0) > 10) throw error;
      const milliseconds = Math.max(2000 * (attempt + 1), (error.retryAfterSeconds ?? 0) * 1000);
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(aborted()); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
export function reportExportDownload(id: string) {
  return `/api/data-exports/${encodeURIComponent(id)}/download`;
}
export function readAgentReportSummary(recordId: string, query: { selectionId?: string; inventorySelectionId?: string; setId?: string }, signal?: AbortSignal) {
  return request<CandidateAgentUsageSummary>(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage${reportQueryString(query)}`, { signal });
}
export function readAgentReportHistory(recordId: string, query: { selectionId: string; inventorySelectionId?: string; limit?: number; cursor?: string }, signal?: AbortSignal) {
  return request<CandidateAgentUsageHistory>(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage-history${reportQueryString(query)}`, { signal });
}
export function readAgentReportAssociations(recordId: string, query: { selectionId: string; inventorySelectionId?: string; setId?: string; limit?: number; cursor?: string }, signal?: AbortSignal) {
  return request<CandidateAgentUsageAssociations>(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations${reportQueryString(query)}`, { signal });
}
export function readAgentReportCandidates(recordId: string,
  query: { selectionId?: string; inventoryRevision?: string; cursor?: string; limit?: number; search?: string }, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return request<CandidateAgentUsageCandidates>(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage-candidates${params.size ? `?${params}` : ""}`, { signal });
}
export function mutateAgentReportAssociation(recordId: string, input: CandidateAgentUsageMutation, operation: "associate" | "remove", signal?: AbortSignal, inventorySelectionId?: string) {
  return request<CandidateAgentUsageContext>(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations${reportQueryString({ inventorySelectionId })}`, {
    method: operation === "associate" ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  });
}
function post<T>(path: string, input: unknown, signal?: AbortSignal) {
  return request<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
}
export type ReportUploadMetadata = { reportingStart?: string; reportingEnd?: string; periodProvenance?: "operator_asserted";
  sourceAsOf?: string; sourceAsOfProvenance?: "operator_asserted"; downloadedAt?: string };
export function stageReport(file: File, intent: OfficialReportImportIntent, metadata: ReportUploadMetadata, signal?: AbortSignal) {
  const query = new URLSearchParams({ bundleId: intent.bundleId });
  if (intent.correctionOfSetId) query.set("correctionOfSetId", intent.correctionOfSetId);
  if (intent.rejectDuplicateKind) query.set("rejectDuplicateKind", "true");
  const body = new FormData();
  for (const [key, value] of Object.entries(metadata)) if (value) body.append(key, value);
  body.append("file", file);
  return request<OfficialReportPreview>(`/api/official-usage/staging?${query}`, { method: "POST", body, signal });
}
export const readReportStage = (id: string, signal?: AbortSignal) => request<OfficialReportPreview>(`/api/official-usage/staging/${encodeURIComponent(id)}`, { signal });
export const discardReportStage = (id: string, signal?: AbortSignal) => request<void>(`/api/official-usage/staging/${encodeURIComponent(id)}`, { method: "DELETE", signal });
export const previewReportBundle = (id: string, signal?: AbortSignal) => post<OfficialReportBundlePreview>(`/api/official-usage/bundles/${encodeURIComponent(id)}/preview`, {}, signal);
export const acceptReportBundle = (id: string, input: OfficialReportBundleAcceptance, signal?: AbortSignal) => post<OfficialReportAccepted>(`/api/official-usage/bundles/${encodeURIComponent(id)}/accept`, input, signal);
export const previewReportOperation = (id: string, operation: "select" | "delete", signal?: AbortSignal) => post<OfficialReportConfirmation>(`/api/official-usage/sets/${encodeURIComponent(id)}/preview`, { operation }, signal);
export const confirmReportOperation = (input: OfficialReportConfirmation, signal?: AbortSignal) => post<OfficialReportConfirmed>(`/api/official-usage/confirmations/${encodeURIComponent(input.id)}`, input, signal);
export function readReportDiagnostics(id: string, cursor?: string, signal?: AbortSignal) {
  return request<OfficialReportDiagnostics>(`/api/official-usage/staging/${encodeURIComponent(id)}/diagnostics${reportQueryString({ cursor, limit: 50 })}`, { signal });
}
