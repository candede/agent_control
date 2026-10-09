import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OfficialReportFacetPage } from "../../../backend/src/types/officialReportApi";
import { encodeReportFacetValue, normalizeReportSearch, readReportFacet } from "../api/reportData";
import { ApiError } from "../api/client";
import { useSavedQueryClient } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";
import { acceptSelectedRead, isExpiredSelection, selectedReadRemaining, useSelectedReadLease } from "../selectedRead";
import type { PublishedSelectedRead } from "../../../backend/src/types/dataSelection";

export function ReportFacet({ path, selectionId: requestedSelectionId, field, value, onChange, onRestartSelection, onSelectionInvalidated, compact = false, alwaysShowSearch = false }: {
  path: string; selectionId?: string; field: "company" | "department" | "creatorType"; value?: string | null;
  onChange: (value: string | null | undefined) => void;
  onRestartSelection: () => void;
  onSelectionInvalidated?: () => void;
  compact?: boolean;
  alwaysShowSearch?: boolean;
}) {
  const principal = useReportPrincipalScope();
  const scope = JSON.stringify([principal, path, field]);
  const [draft, setDraft] = useState({ scope, search: "", opened: false });
  const { search, opened: searchOpened } = draft.scope === scope ? draft : { search: "", opened: false };
  if (draft.scope !== scope) setDraft({ scope, search: "", opened: false });
  const [page, setPage] = useState<{ key: string; cursor?: string }>({ key: "" });
  const controlRef = useRef<HTMLSelectElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const retryFocus = useRef<{ key: string; cursor?: string } | undefined>(undefined);
  const selectionId = requestedSelectionId?.toLowerCase(), searchQuery = normalizeReportSearch(search);
  const owner = JSON.stringify([principal, path, selectionId]);
  // Selection validity survives option search and page changes.
  const [evidence, setEvidence] = useState<{ owner: string; selection?: PublishedSelectedRead; rejected?: boolean }>({ owner });
  const current = evidence.owner === owner ? evidence : { owner };
  if (evidence.owner !== owner) setEvidence(current);
  const leaseActive = useSelectedReadLease(current.selection);
  const leaseEnded = Boolean(current.selection && !leaseActive);
  const rejected = current.rejected;
  const key = JSON.stringify([principal, path, selectionId, field, searchQuery]), cursor = page.key === key ? page.cursor : undefined;
  if (page.key !== key) setPage({ key });
  const client = useSavedQueryClient();
  const queryKey = ["saved", "report-facet", path, field, key, cursor];
  // Reuse only actively owned options, not retired pages awaiting zero-time collection.
  const observed = client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount();
  const read = useQuery<OfficialReportFacetPage>({
    queryKey, enabled: cached => Boolean(selectionId) && !rejected && !leaseEnded
      && !(cached.state.error instanceof ApiError && cached.state.error.code === "selection_invalidated"),
    staleTime: observed ? Infinity : 0, gcTime: 0, structuralSharing: false,
    queryFn: async ({ signal }) => {
      const startedAt = performance.now();
      const result = await readReportFacet(path, selectionId!, field, { search: searchQuery, cursor, signal });
      signal.throwIfAborted();
      if (result.selection.id.toLowerCase() !== selectionId?.toLowerCase()) {
        throw new ApiError(409, "selection_invalidated", "Facet evidence does not match a current selection.");
      }
      return acceptSelectedRead(result, startedAt);
    },
  }, client);
  const label = field === "creatorType" ? "Creator type" : field === "company" ? "Company" : "Department";
  const invalidated = rejected || read.error instanceof ApiError && read.error.code === "selection_invalidated" && !isExpiredSelection(read.error);
  if (invalidated && !current.rejected) setEvidence({ ...current, rejected: true });
  else if (!invalidated && read.data && !read.isError && current.selection !== read.data.selection) {
    setEvidence({ ...current, selection: read.data.selection });
  }
  const data = read.isError || invalidated ? undefined : read.data;
  useLayoutEffect(() => {
    const target = retryFocus.current;
    if (!target) return;
    if (target.key === key && target.cursor === cursor) {
      if (read.isFetching) return;
      // The loading message removes the focused retry action; do not displace a new focus choice.
      if (document.activeElement === document.body) {
        if (data) controlRef.current?.focus();
        else retryRef.current?.focus();
      }
    }
    retryFocus.current = undefined;
  }, [key, cursor, data, read.error, read.isFetching]);
  useEffect(() => {
    if (invalidated) void client.cancelQueries({ queryKey: ["saved", "report-facet", path, field, key, cursor], exact: true });
  }, [client, invalidated, path, field, key, cursor]);
  useEffect(() => {
    if (invalidated) onSelectionInvalidated?.();
  }, [invalidated, onSelectionInvalidated]);
  const expiredSelection = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectionId || invalidated || !leaseEnded && !isExpiredSelection(read.error)
      || expiredSelection.current === selectionId || document.visibilityState !== "visible" || !navigator.onLine) return;
    expiredSelection.current = selectionId;
    onRestartSelection();
  });
  function invalidatedAtAction() {
    if (current.selection && !selectedReadRemaining(current.selection) || isExpiredSelection(read.error)) return true;
    const failure = client.getQueryState(queryKey)?.error;
    if (!invalidated && !(failure instanceof ApiError && failure.code === "selection_invalidated")) return false;
    if (!current.rejected) setEvidence({ ...current, rejected: true });
    return true;
  }
  function currentOptions() {
    if (invalidatedAtAction()) return false;
    // Cache updates precede React's observer notifications and event handlers.
    const cached = client.getQueryState(queryKey);
    return Boolean(data && cached?.status === "success" && cached.data === data
      && cached.fetchStatus === "idle" && !cached.isInvalidated);
  }
  function changeSearch(search: string) {
    invalidatedAtAction();
    setDraft({ scope, search, opened: true });
  }
  function move(cursor: string | null | undefined) {
    if (cursor && currentOptions()) setPage({ key, cursor });
  }
  function retry(event: MouseEvent<HTMLButtonElement>) {
    if (!selectionId || invalidatedAtAction()) return;
    const failure = client.getQueryState(queryKey)?.error;
    const retryCursor = cursor && failure instanceof ApiError && failure.code === "invalid_cursor" ? undefined : cursor;
    retryFocus.current = document.activeElement === event.currentTarget ? { key, cursor: retryCursor } : undefined;
    if (retryCursor !== cursor) setPage({ key });
    else void read.refetch({ cancelRefetch: false });
  }
  const status = leaseEnded || isExpiredSelection(read.error) ? <p className="sr-only" role="status">Refreshing saved options...</p>
    : selectionId && !invalidated && read.isFetching ? <p className={alwaysShowSearch ? "sr-only" : undefined} role="status">Loading {label.toLowerCase()} options...</p>
    : (read.error || invalidated) && !(invalidated && onSelectionInvalidated) ? <p role="alert">{invalidated ? "This selection changed or expired." : read.error?.message}{" "}
      <button ref={retryRef} type="button" onClick={invalidated ? onRestartSelection : retry}>
        {invalidated ? "Restart selection" : "Retry options"}</button></p>
      : data && !data.value.length ? <p className={alwaysShowSearch ? "sr-only" : undefined} role="status">{data.counts.filtered > 0
        ? `No ${label.toLowerCase()} options on this page.` : searchQuery
          ? `No ${label.toLowerCase()} options match this search.` : `No ${label.toLowerCase()} options available.`}</p> : null;
  const control = <select ref={controlRef} aria-label={label} aria-disabled={leaseEnded || !selectionId || !data || read.isFetching} value={value === undefined ? "" : encodeReportFacetValue(value)}
    className={value !== undefined ? "active-filter-select" : undefined}
    onChange={event => {
      if (!data || !currentOptions()) return;
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
    {alwaysShowSearch || searchOpened || search || cursor || data?.page.nextCursor ? <label><span className="sr-only">Search {label.toLowerCase()} options</span>
      <input type="search" placeholder="Search options" value={search} maxLength={256}
        onFocus={() => changeSearch(search)} onChange={event => changeSearch(event.target.value)} /></label> : null}
    {status}
  </div>;
  return <fieldset className="report-facet"><legend>{label}</legend>
    <label><span>Search {label.toLowerCase()} options</span><input type="search" value={search} maxLength={256}
      onChange={event => changeSearch(event.target.value)} /></label>
    {control}
    <div className="report-facet-pages"><span>{data?.counts.filtered.toLocaleString() ?? "Unknown"} options</span>
      <button type="button" aria-label={`Previous ${label.toLowerCase()} options`} aria-disabled={leaseEnded || !data?.page.previousCursor || read.isFetching}
        onClick={() => move(data?.page.previousCursor)}>Previous</button>
      <button type="button" aria-label={`Next ${label.toLowerCase()} options`} aria-disabled={leaseEnded || !data?.page.nextCursor || read.isFetching}
        onClick={() => move(data?.page.nextCursor)}>Next</button>
    </div>
    {status}
  </fieldset>;
}
