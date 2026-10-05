import { useEffect, useRef, useState, type RefObject } from "react";
import { ApiError, getInventoryFacets, type InventoryFacetField } from "../api/client";
import { decodeInventoryFacet, encodeInventoryFacet, inventoryFacetLabel, type InventoryFacetValue } from "../../../backend/src/types/inventoryFacets";
import { formatPackageFacetLabel, formatPackageType } from "../../../backend/src/types/copilotPackage";

export function InventoryFacetSelect({ selectionId, scopeKey = selectionId, field, value, label, allLabel, loading, onChange, onInvalidated, onError, selectRef, compact, onOptionLabel }: {
  selectionId: string; field: InventoryFacetField; value?: InventoryFacetValue; label: string; allLabel: string;
  scopeKey?: string; compact?: boolean; onOptionLabel?: (value: InventoryFacetValue, label: string) => void;
  loading?: boolean; onChange: (value: InventoryFacetValue | undefined) => void; onInvalidated?: () => void;
  onError?: (message: string) => void;
  selectRef?: RefObject<HTMLSelectElement | null>;
}) {
  const [query, setQuery] = useState<{ selectionId: string; scopeKey: string; field: InventoryFacetField; search: string; cursor?: string }>({ selectionId, scopeKey, field, search: "" });
  const search = query.scopeKey === scopeKey && query.field === field ? query.search : "";
  const cursor = query.scopeKey === scopeKey && query.selectionId === selectionId && query.field === field ? query.cursor : undefined;
  const [retry, setRetry] = useState(0);
  const invalidation = useRef(onInvalidated);
  useEffect(() => { invalidation.current = onInvalidated; }, [onInvalidated]);
  const [state, setState] = useState<{ owner: string; page?: Awaited<ReturnType<typeof getInventoryFacets>>; error?: string }>();
  const owner = JSON.stringify([selectionId, field, search, cursor, retry]);
  useEffect(() => {
    const controller = new AbortController();
    void getInventoryFacets(selectionId, field, { search: search || undefined, cursor }, { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) setState({ owner, page }); })
      .catch(error => { if (!controller.signal.aborted) {
        setState({ owner, error: error instanceof Error ? error.message : "Facet options unavailable." });
        if (error instanceof ApiError && ["selection_invalidated", "inventory_changed", "unauthorized", "forbidden"].includes(error.code)) {
          invalidation.current?.();
        }
      } });
    return () => controller.abort();
  }, [selectionId, field, search, cursor, owner, retry]);
  const visible = state?.owner === owner ? state : undefined;
  const selectedValue = field === "environmentId" && typeof value === "string"
    ? visible?.page?.value.find(option => typeof option.value === "string" && option.value.toLowerCase() === value.toLowerCase())?.value ?? value : value;
  const selectedKey = selectedValue === undefined ? "" : encodeInventoryFacet(selectedValue);
  const selectedOption = visible?.page?.value.find(option => encodeInventoryFacet(option.value) === selectedKey);
  useEffect(() => {
    if (selectedOption) onOptionLabel?.(selectedOption.value, selectedOption.label);
  }, [selectedOption, onOptionLabel]);
  const optionLabel = (option: { value: InventoryFacetValue; label: string }) => field === "environmentId" && typeof option.value === "string"
    ? option.label && option.label !== option.value ? `${option.label} (${option.value})` : `Unnamed environment (${option.value})`
    : field === "type" && typeof option.value === "string" ? formatPackageType(option.value)
      : typeof option.value === "string" ? formatPackageFacetLabel(option.label || option.value) : option.label || "Unknown";
  function select(key: string) {
    if (key === "next-options" && visible?.page?.nextCursor) {
      setQuery({ selectionId, scopeKey, field, search, cursor: visible.page.nextCursor }); return;
    }
    if (key === "first-options" && cursor) {
      setQuery({ selectionId, scopeKey, field, search }); return;
    }
    if (key && key !== selectedKey && !visible?.page?.value.some(option => encodeInventoryFacet(option.value) === key)) {
      const error = "Choose a saved inventory facet option.";
      setState({ ...visible, owner, error });
      onError?.(error);
      return;
    }
    const option = visible?.page?.value.find(option => encodeInventoryFacet(option.value) === key);
    if (option) onOptionLabel?.(option.value, option.label);
    setQuery({ selectionId, scopeKey, field, search: "" });
    onChange(key ? decodeInventoryFacet(key) : undefined);
  }
  const control = <select ref={selectRef} aria-label={label} aria-busy={Boolean(loading || !visible)} value={selectedKey}
      onChange={event => select(event.target.value)}>
      <option value="">{allLabel}</option>
      {selectedValue !== undefined && !visible?.page?.value.some(option => encodeInventoryFacet(option.value) === selectedKey)
        ? <option value={selectedKey}>{field === "type" && typeof selectedValue === "string" ? formatPackageType(selectedValue) : inventoryFacetLabel(selectedValue)}</option> : null}
      {visible?.page?.value.map(option => <option key={encodeInventoryFacet(option.value)} value={encodeInventoryFacet(option.value)}>{optionLabel(option)}</option>)}
      {cursor ? <option value="first-options">First options...</option> : null}
      {visible?.page?.nextCursor ? <option value="next-options">More options...</option> : null}
    </select>;
  const options = visible?.error ? <p role="alert">{visible.error}{" "}
    <button type="button" onClick={() => setRetry(value => value+1)}>Retry options</button></p> : !compact && (field === "environmentId" || search || cursor || visible?.page?.nextCursor) ? <>
    <label className="inventory-facet-search"><span className="sr-only">Search {label.toLowerCase()} options</span>
      <input type="search" placeholder="Search options" aria-label={field === "environmentId" ? "Search environments" : `Search ${label.toLowerCase()} options`} value={search}
        onChange={event => setQuery({ selectionId, scopeKey, field, search: event.target.value })} /></label>
  </> : null;
  return <div className={`inventory-facet${compact ? " inventory-facet-compact agent-view-control" : ""}`}>
    {compact ? control : <label><span>{label}</span>{control}</label>}
    {options}
  </div>;
}
