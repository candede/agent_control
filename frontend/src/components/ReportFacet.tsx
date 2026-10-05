import { useState } from "react";
import { encodeReportFacetValue, readReportFacet } from "../api/reportData";
import { ApiError } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";

export function ReportFacet({ path, selectionId, field, value, onChange, onRestartSelection, compact = false }: {
  path: string; selectionId?: string; field: "company" | "department" | "creatorType"; value?: string | null;
  onChange: (value: string | null | undefined) => void;
  onRestartSelection: () => void;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [searchOpened, setSearchOpened] = useState(false);
  const [page, setPage] = useState<{ key: string; cursor?: string }>({ key: "" });
  const principal = useReportPrincipalScope();
  const key = JSON.stringify([principal, path, selectionId, field, search]), cursor = page.key === key ? page.cursor : undefined;
  if (page.key !== key) setPage({ key });
  const read = useSavedQuery({
    queryKey: ["saved", "report-facet", path, field, key, cursor], enabled: Boolean(selectionId), gcTime: 0,
    queryFn: ({ signal }) => readReportFacet(path, selectionId!, field, { search, cursor, signal }),
  });
  const label = field === "creatorType" ? "Creator type" : field === "company" ? "Company" : "Department";
  const data = read.isError ? undefined : read.data;
  const invalidated = read.error instanceof ApiError && read.error.code === "selection_invalidated";
  const control = <select aria-label={label} disabled={!selectionId || read.isFetching || read.isError} value={value === undefined ? "" : encodeReportFacetValue(value)}
    className={value !== undefined ? "active-filter-select" : undefined}
    onChange={event => {
      const next = event.target.value;
      if (next === "next-options" && data?.page.nextCursor) setPage({ key, cursor: data.page.nextCursor });
      else if (next === "previous-options" && data?.page.previousCursor) setPage({ key, cursor: data.page.previousCursor });
      else onChange(next === "" ? undefined : next === "~null" ? null : next.slice(8));
    }}>
    <option value="">{field === "company" ? "All companies" : field === "department" ? "All departments" : "All creator types"}</option>
    {value !== undefined && !data?.value.some(option => option.value === value) ? <option value={encodeReportFacetValue(value)}>{value ?? "Not reported"}</option> : null}
    {data?.value.map(option => <option key={encodeReportFacetValue(option.value)} value={encodeReportFacetValue(option.value)}>
      {option.value ?? "Not reported"}{compact ? "" : ` (${option.count.toLocaleString()})`}</option>)}
    {compact && data?.page.previousCursor ? <option value="previous-options">Previous options...</option> : null}
    {compact && data?.page.nextCursor ? <option value="next-options">More options...</option> : null}
  </select>;
  if (compact) return <div className="inventory-facet" role="group" aria-label={`${label} options`}>
    <label><span>{label}</span>{control}</label>
    {searchOpened || search || cursor || data?.page.nextCursor ? <label><span className="sr-only">Search {label.toLowerCase()} options</span>
      <input type="search" placeholder="Search options" value={search} maxLength={256}
        onFocus={() => setSearchOpened(true)} onChange={event => setSearch(event.target.value)} /></label> : null}
    {read.error ? <p role="alert">{invalidated ? "This selection changed or expired." : read.error.message}{" "}
      <button type="button" onClick={invalidated ? onRestartSelection : () => { void read.refetch(); }}>
        {invalidated ? "Restart selection" : "Retry options"}</button></p> : null}
  </div>;
  return <fieldset className="report-facet"><legend>{label}</legend>
    <label><span>Search {label.toLowerCase()} options</span><input type="search" value={search} maxLength={256} onChange={event => setSearch(event.target.value)} /></label>
    {control}
    <div className="report-facet-pages"><span>{data?.counts.filtered.toLocaleString() ?? "Unknown"} options</span>
      <button type="button" aria-label={`Previous ${label.toLowerCase()} options`} disabled={!data?.page.previousCursor || read.isFetching}
        onClick={() => setPage({ key, cursor: data!.page.previousCursor! })}>Previous</button>
      <button type="button" aria-label={`Next ${label.toLowerCase()} options`} disabled={!data?.page.nextCursor || read.isFetching}
        onClick={() => setPage({ key, cursor: data!.page.nextCursor! })}>Next</button>
    </div>
    {read.error ? <p role="alert">{invalidated ? "This selection changed or expired." : read.error.message}{" "}
      <button type="button" onClick={invalidated ? onRestartSelection : () => { void read.refetch(); }}>
        {invalidated ? "Restart selection" : "Retry options"}</button></p> : null}
  </fieldset>;
}
