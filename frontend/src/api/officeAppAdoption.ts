import { request } from "./client";
import { encodeReportFacetValue } from "./reportData";
import type { OfficeContext, OfficeFacet, OfficeFacetKind, OfficeGroup, OfficeHistoryPoint, OfficePage, OfficePerson,
  OfficeQuery, OfficeSummary } from "../../../backend/src/types/officeAppAdoption";

export type OfficePageRequest = OfficeQuery & { selectionId?: string; cursor?: string; limit?: number; pageNumber?: number; anchor?: string };
export function officeQueryString(query: OfficePageRequest & { kind?: OfficeFacetKind }) {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(query)) {
    if (value===undefined) continue;
    params.set(key,key==="company" || key==="department" ? encodeReportFacetValue(value as string | null) : String(value));
  }
  return params.size ? `?${params}` : "";
}
function read<T>(path: string, query: OfficePageRequest & { kind?: OfficeFacetKind }, signal?: AbortSignal) {
  return request<T>(`/api/office-app-adoption/${path}${officeQueryString(query)}`, { signal });
}
export const officeAdoption = {
  context: (query: OfficeQuery & { selectionId?: string } = {}, signal?: AbortSignal) => read<OfficeContext>("context",query,signal),
  summary: (query: OfficeQuery & { selectionId?: string } = {}, signal?: AbortSignal) => read<OfficeSummary>("summary",query,signal),
  comparison: (query: OfficeQuery & { selectionId?: string } = {}, signal?: AbortSignal) => read<OfficeSummary>("comparison",query,signal),
  history: (query: OfficePageRequest = {}, signal?: AbortSignal) => read<OfficePage<OfficeHistoryPoint>>("history",query,signal),
  groups: (query: OfficePageRequest = {}, signal?: AbortSignal) => read<OfficePage<OfficeGroup>>("groups",{ ...query,limit: query.limit ?? 5 },signal),
  departments: (query: OfficePageRequest = {}, signal?: AbortSignal) => read<OfficePage<OfficeGroup>>("departments",query,signal),
  facets: (kind: OfficeFacetKind,query: OfficePageRequest = {},signal?: AbortSignal) => read<OfficePage<OfficeFacet>>("facets",{ ...query,kind },signal),
  people: (groupId: string,query: OfficePageRequest = {},signal?: AbortSignal) =>
    read<OfficePage<OfficePerson>>(`groups/${encodeURIComponent(groupId)}/people`,query,signal),
};
