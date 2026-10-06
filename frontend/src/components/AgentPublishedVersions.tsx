import { useId, useState } from "react";
import { getInventoryMembers, type UnifiedAgentRecord } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";

export function AgentPublishedVersions({ selectionId, record, selectedId, disabled, onSelect }: {
  selectionId: string; record: UnifiedAgentRecord; selectedId?: string; disabled: boolean; onSelect: (id: string) => void;
}) {
  const id = useId(), principal = useReportPrincipalScope();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const read = useSavedQuery({
    queryKey: ["saved", "agent-versions", principal, selectionId, record.id, cursors.at(-1)], gcTime: 0,
    queryFn: ({ signal }) => getInventoryMembers(selectionId, record.id, cursors.at(-1), { signal }),
  });
  const options = new Map(record.packages.map(item => [item.id, `${item.displayName}${item.version ? ` - Version ${item.version}` : ""}`]));
  if (!read.isError) for (const member of read.data?.value ?? []) if (member.domain === "packages" && !options.has(member.native_id)) {
    options.set(member.native_id, member.display_name || member.native_id);
  }
  return <div className="agent-version-selector">
    <label htmlFor={id}>Published version details</label>
    <select id={id} value={options.has(selectedId ?? "") ? selectedId : ""} disabled={disabled || read.isFetching || read.isError}
      onChange={event => onSelect(event.target.value)}>
      {!options.has(selectedId ?? "") ? <option value="" disabled>Choose a published version</option> : null}
      {[...options].map(([value, label]) => <option key={value} value={value}>{label}{[...options.values()].filter(name => name === label).length > 1 ? ` (${value})` : ""}</option>)}
    </select>
    {read.error ? <p className="error-banner" role="alert">{read.error.message} <button type="button" className="secondary" onClick={() => { void read.refetch(); }}>Retry published versions</button></p> : null}
    {read.isPending ? <p role="status">Loading published versions...</p> : null}
    {read.data && !read.isError && (read.data.nextCursor || cursors.length > 1) ? <div className="agent-insight-pagination">
      <button type="button" className="secondary" disabled={disabled || read.isFetching || cursors.length === 1} onClick={() => setCursors(values => values.slice(0, -1))}>Previous versions</button>
      <button type="button" className="secondary" disabled={disabled || read.isFetching || !read.data.nextCursor} onClick={() => {
        if (read.data?.nextCursor) setCursors(values => [...values, read.data!.nextCursor!]);
      }}>Next versions</button>
    </div> : null}
  </div>;
}
