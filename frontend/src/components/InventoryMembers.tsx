import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { ApiError, getInventoryChildren, getInventoryMembers, getInventorySections, type InventoryMember } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPrincipalScope } from "../useReportPage";

type Props = {
  selectionId: string; recordId: string; onInspectPackage?: (id: string) => void;
  onInvalidated?: () => void;
};
type Navigation = { cursor?: string; paged?: boolean };

export function InventoryMembers(props: Props) {
  const principal = useReportPrincipalScope();
  return <InventoryMembersPage key={JSON.stringify([principal, props.selectionId, props.recordId])} {...props} principal={principal} />;
}

function selectionInvalidated(error: Error | null) {
  return error instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(error.code);
}

function useMemberInvalidation(error: Error | null, onInvalidated: () => void) {
  const invalidated = selectionInvalidated(error);
  const notify = useEffectEvent(onInvalidated);
  useEffect(() => { if (invalidated) notify(); }, [invalidated]);
  return invalidated;
}

function memberKey(member: InventoryMember) {
  return JSON.stringify([member.source_scope_id, member.source_identity, member.source_generation_id]);
}

function InventoryMembersPage({ selectionId, recordId, principal, onInspectPackage, onInvalidated }: Props & { principal: string }) {
  const [navigation, setNavigation] = useState<Navigation>({});
  const [selected, setSelected] = useState<string>();
  const [retired, setRetired] = useState(false);
  const { cursor } = navigation;
  const read = useSavedQuery<Awaited<ReturnType<typeof getInventoryMembers>>>({
    // Published-version choices and source members use the same membership page.
    queryKey: ["saved", "agent-versions", principal, selectionId, recordId, cursor], gcTime: 0, staleTime: Infinity,
    enabled: query => !retired && !selectionInvalidated(query.state.error),
    queryFn: ({ signal }) => getInventoryMembers(selectionId, recordId, cursor, { signal }),
  });
  const invalidated = retired || selectionInvalidated(read.error);
  if (invalidated && !retired) setRetired(true);
  const notifyInvalidated = useEffectEvent(() => onInvalidated?.());
  useEffect(() => { if (invalidated) notifyInvalidated(); }, [invalidated]);
  const page = !invalidated && !read.isError && !read.isFetching ? read.data : undefined;
  const selectedMember = page?.value.find(member => memberKey(member) === selected);
  const element = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (page && element.current) setHeight(element.current.getBoundingClientRect().height);
  }, [page]);
  const firstDisabled = read.isFetching || !cursor;
  const nextDisabled = read.isFetching || !page?.nextCursor;
  function move(cursor?: string) {
    setNavigation({ cursor, paged: true });
    setSelected(undefined);
  }
  return <section ref={element} className="agent-overview-section inventory-source-members" aria-label="Inventory source members" aria-busy={!invalidated && read.isFetching}
    style={!invalidated && read.isFetching && height !== undefined ? { minHeight: height } : undefined}>
    <h3>Source members {page ? `(${page.total.toLocaleString()})` : ""}</h3>
    {invalidated ? <p role="alert">This saved inventory selection changed or expired. Reload saved inventory.</p> : <>
    {read.error && !read.isFetching ? <p role="alert">{read.error.message || "Source members unavailable."}{" "}
      <button type="button" onClick={() => { void read.refetch({ cancelRefetch: false }); }}>Retry source members</button></p> : null}
    {read.isFetching ? <p role="status">Loading source members…</p> : null}
    {page ? <>
      {page.value.length === 0 ? <p>No source members on this page.</p> : null}
      <ul>{page.value.map(member => <li key={memberKey(member)}>
        <button type="button" onClick={() => setSelected(memberKey(member))}>{member.display_name || member.native_id}</button>
        <span>{member.domain} · {member.native_id}</span>
        {member.domain === "packages" && onInspectPackage ? <button type="button"
          onClick={() => onInspectPackage(member.native_id)}>Inspect published version ({member.native_id})</button> : null}
      </li>)}</ul>
      <p>{page.value.length} shown of {page.total.toLocaleString()} source members.</p>
    </> : null}
    {navigation.paged || page?.nextCursor ? <div className="table-actions">
      <button type="button" aria-disabled={firstDisabled} onClick={() => { if (!firstDisabled) move(); }}>First members</button>
      <button type="button" aria-disabled={nextDisabled} onClick={() => { if (!nextDisabled && page?.nextCursor) move(page.nextCursor); }}>Next members</button>
    </div> : null}
    {selectedMember ? <InventoryMemberFacts key={memberKey(selectedMember)} principal={principal}
      selectionId={selectionId} recordId={recordId} member={selectedMember} onInvalidated={() => setRetired(true)} /> : null}
    </>}
  </section>;
}

type MemberProps = {
  selectionId: string; recordId: string; principal: string; member: InventoryMember; onInvalidated: () => void;
};
function InventoryMemberFacts(props: MemberProps) {
  const { selectionId, recordId, principal, member, onInvalidated } = props;
  const [selectedKind, setKind] = useState<string>();
  const [navigation, setNavigation] = useState<Navigation>({});
  const { cursor } = navigation;
  const read = useSavedQuery({
    queryKey: ["saved", "inventory-sections", principal, selectionId, recordId, member.source_scope_id, member.source_identity, cursor], gcTime: 0,
    queryFn: ({ signal }) => getInventorySections(selectionId, recordId, member, { cursor, signal }),
  });
  const invalidated = useMemberInvalidation(read.error, onInvalidated);
  const sections = !read.isError && !read.isFetching ? read.data : undefined;
  const kind = sections?.value.find(section => section.kind === selectedKind)?.kind
    ?? sections?.value.find(section => section.kind === "element")?.kind ?? sections?.value[0]?.kind;
  const firstDisabled = read.isFetching || !cursor;
  const nextDisabled = read.isFetching || !sections?.nextCursor;
  function move(cursor?: string) {
    setNavigation({ cursor, paged: true });
    setKind(undefined);
  }
  if (invalidated) return null;
  return <section className="inventory-source-details" aria-label="Source detail rows" aria-busy={read.isFetching}>
    <h4>{member.display_name || member.native_id}</h4>
    {read.error && !read.isFetching ? <p role="alert">{read.error.message || "Detail sections unavailable."}{" "}
      <button type="button" onClick={() => { void read.refetch({ cancelRefetch: false }); }}>Retry detail sections</button></p> : null}
    <label>Detail section<select value={kind ?? ""} disabled={!sections?.value.length} onChange={event => setKind(event.target.value)}>
      {sections?.value.map(section => <option key={section.kind} value={section.kind}>{section.kind} ({section.total.toLocaleString()})</option>)}
    </select></label>
    {navigation.paged || sections?.nextCursor ? <div className="table-actions">
      <button type="button" aria-disabled={firstDisabled} onClick={() => { if (!firstDisabled) move(); }}>First detail sections</button>
      <button type="button" aria-disabled={nextDisabled}
        onClick={() => { if (!nextDisabled && sections?.nextCursor) move(sections.nextCursor); }}>More detail sections</button>
    </div> : null}
    {read.isFetching ? <p role="status">Loading detail sections…</p>
      : sections?.value.length === 0 ? <p>No saved child collections on this page.</p> : null}
    {kind ? <InventoryMemberRows key={JSON.stringify([cursor, kind])} {...props} kind={kind} /> : null}
  </section>;
}

function InventoryMemberRows({ selectionId, recordId, principal, member, kind, onInvalidated }: MemberProps & { kind: string }) {
  const [navigation, setNavigation] = useState<Navigation>({});
  const { cursor } = navigation;
  const read = useSavedQuery({
    queryKey: ["saved", "inventory-children", principal, selectionId, recordId, member.source_scope_id, member.source_identity, kind, cursor], gcTime: 0,
    queryFn: ({ signal }) => getInventoryChildren(selectionId, recordId, member, kind, cursor, { signal }),
  });
  const invalidated = useMemberInvalidation(read.error, onInvalidated);
  const page = !read.isError && !read.isFetching ? read.data : undefined;
  const firstDisabled = read.isFetching || !cursor;
  const nextDisabled = read.isFetching || !page?.nextCursor;
  if (invalidated) return null;
  return <div aria-busy={read.isFetching}>
    {read.error && !read.isFetching ? <p role="alert">{read.error.message || "Source details unavailable."}{" "}
      <button type="button" onClick={() => { void read.refetch({ cancelRefetch: false }); }}>Retry detail rows</button></p> : null}
    {read.isFetching ? <p role="status">Loading detail rows…</p> : null}
    {page ? <>
      <p>{page.value.length} shown of {page.total.toLocaleString()} {kind} rows.</p>
      {page.value.length === 0 ? <p>No saved {kind} rows on this page.</p> : null}
      <ul>{page.value.map(row => <li key={row.ordinal}><strong>{row.value}</strong>
        {Object.keys(row.payload).length ? <pre>{JSON.stringify(row.payload, null, 2)}</pre> : null}</li>)}</ul>
    </> : null}
    {navigation.paged || page?.nextCursor ? <div className="table-actions">
      <button type="button" aria-disabled={firstDisabled}
        onClick={() => { if (!firstDisabled) setNavigation({ paged: true }); }}>First detail rows</button>
      <button type="button" aria-disabled={nextDisabled}
        onClick={() => { if (!nextDisabled && page?.nextCursor) setNavigation({ cursor: page.nextCursor, paged: true }); }}>Next detail rows</button>
    </div> : null}
  </div>;
}
