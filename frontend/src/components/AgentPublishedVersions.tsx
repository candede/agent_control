import { useEffect, useEffectEvent, useId, useState } from "react";
import { ApiError, getInventoryMembers, type UnifiedAgentRecord } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";

export function AgentPublishedVersions({ selectionId, record, selectedId, disabled, onSelect, onInvalidated }: {
  selectionId: string; record: UnifiedAgentRecord; selectedId?: string; disabled: boolean; onSelect: (id: string) => void;
  onInvalidated?: () => void;
}) {
  const id = useId(), principal = useReportPrincipalScope();
  const owner = JSON.stringify([principal, selectionId, record.id]);
  const [navigation, setNavigation] = useState<{ owner: string; cursors: (string | undefined)[]; paged?: boolean }>({ owner, cursors: [undefined] });
  const cursors = navigation.owner === owner ? navigation.cursors : [undefined];
  if (navigation.owner !== owner) setNavigation({ owner, cursors });
  const cursor = cursors.at(-1);
  const read = useSavedQuery<Awaited<ReturnType<typeof getInventoryMembers>>>({
    queryKey: ["saved", "agent-versions", principal, selectionId, record.id, cursor], gcTime: 0, staleTime: Infinity,
    enabled: query => !(query.state.error instanceof ApiError && query.state.error.code === "selection_invalidated"),
    queryFn: ({ signal }) => getInventoryMembers(selectionId, record.id, cursor, { signal }),
  });
  const invalidated = read.error instanceof ApiError && read.error.code === "selection_invalidated";
  const notifyInvalidated = useEffectEvent(() => onInvalidated?.());
  useEffect(() => {
    if (invalidated) notifyInvalidated();
  }, [invalidated]);
  const options = new Map((invalidated ? [] : record.packages).map(item => [item.id, `${item.displayName}${item.version ? ` - Version ${item.version}` : ""}`]));
  if (!read.isError) for (const member of read.data?.value ?? []) if (member.domain === "packages" && !options.has(member.native_id)) {
    options.set(member.native_id, member.display_name || member.native_id);
  }
  const previousDisabled = disabled || read.isFetching || invalidated || cursors.length === 1;
  const nextDisabled = disabled || read.isFetching || read.isError || !read.data?.nextCursor;
  return <div className="agent-version-selector">
    <label htmlFor={id}>Published version details</label>
    <select id={id} value={options.has(selectedId ?? "") ? selectedId : ""} disabled={disabled || read.isFetching || read.isError || options.size === 0}
      onChange={event => onSelect(event.target.value)}>
      {!options.has(selectedId ?? "") ? <option value="" disabled>Choose a published version</option> : null}
      {[...options].map(([value, label]) => <option key={value} value={value}>{label}{[...options.values()].filter(name => name === label).length > 1 ? ` (${value})` : ""}</option>)}
    </select>
    {read.error && !read.isFetching ? <p className="error-banner" role="alert">{invalidated
      ? "This saved inventory selection changed or expired. Reload saved inventory." : <>{read.error.message}{" "}
        <button type="button" className="secondary" disabled={disabled || read.isFetching}
          onClick={() => { void read.refetch({ cancelRefetch: false }); }}>Retry published versions</button></>}</p> : null}
    {read.isFetching ? <p role="status">Loading published versions...</p> : null}
    {read.isSuccess && !read.isFetching && options.size === 0 ? <p>No published versions on this page.</p> : null}
    {!invalidated && (navigation.owner === owner && navigation.paged || read.data?.nextCursor) ? <div className="agent-insight-pagination">
      <button type="button" className="secondary" aria-disabled={previousDisabled}
        onClick={() => {
          if (!previousDisabled) setNavigation({ owner, cursors: cursors.slice(0, -1), paged: true });
        }}>Previous versions</button>
      <button type="button" className="secondary" aria-disabled={nextDisabled} onClick={() => {
        if (!nextDisabled && read.data?.nextCursor) setNavigation({ owner, cursors: [...cursors, read.data.nextCursor], paged: true });
      }}>Next versions</button>
    </div> : null}
  </div>;
}
