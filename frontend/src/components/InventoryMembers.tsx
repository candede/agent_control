import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getInventoryChildren, getInventoryMembers, getInventorySections, type InventoryMember } from "../api/client";

export function InventoryMembers({ selectionId, recordId, onInspectPackage }: {
  selectionId: string; recordId: string; onInspectPackage?: (id: string) => void;
}) {
  const selectionOwner = JSON.stringify([selectionId, recordId]);
  const [navigation, setNavigation] = useState<{ owner: string; cursor?: string }>({ owner: selectionOwner });
  const cursor = navigation.owner === selectionOwner ? navigation.cursor : undefined;
  const setCursor = (value?: string) => setNavigation({ owner: selectionOwner, cursor: value });
  const element = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number>();
  const [selected, setSelected] = useState<{ owner: string; member: InventoryMember }>();
  const [state, setState] = useState<{ owner: string; page?: Awaited<ReturnType<typeof getInventoryMembers>>; error?: string }>();
  const owner = JSON.stringify([selectionId, recordId, cursor]);
  useEffect(() => {
    const controller = new AbortController();
    void getInventoryMembers(selectionId, recordId, cursor, { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) setState({ owner, page }); })
      .catch(error => { if (!controller.signal.aborted) setState({ owner, error: error instanceof Error ? error.message : "Source members unavailable." }); });
    return () => controller.abort();
  }, [selectionId, recordId, cursor, owner]);
  const visible = state?.owner === owner ? state : undefined;
  useLayoutEffect(() => {
    if (visible?.page && element.current) setHeight(element.current.getBoundingClientRect().height);
  }, [visible]);
  return <section ref={element} className="agent-overview-section inventory-source-members" aria-label="Inventory source members" aria-busy={!visible}
    style={!visible && height !== undefined ? { minHeight: height } : undefined}>
    <h3>Source members {visible?.page ? `(${visible.page.total.toLocaleString()})` : ""}</h3>
    {visible?.error ? <p role="alert">{visible.error}</p> : null}
    {!visible ? <p role="status">Loading source members…</p> : null}
    {visible?.page ? <>
      <ul>{visible.page.value.map(member => <li key={`${member.source_scope_id}:${member.source_identity}`}>
        <button type="button" onClick={() => setSelected({ owner: selectionOwner, member })}>{member.display_name || member.native_id}</button>
        <span>{member.domain} · {member.native_id}</span>
        {member.domain === "packages" && onInspectPackage ? <button type="button"
          onClick={() => onInspectPackage(member.native_id)}>Inspect published version ({member.native_id})</button> : null}
      </li>)}</ul>
      <p>{visible.page.value.length} shown of {visible.page.total.toLocaleString()} source members.</p>
      <div className="table-actions">{cursor ? <button type="button" onClick={() => { setCursor(undefined); setSelected(undefined); }}>First members</button> : null}
      <button type="button" disabled={!visible.page.nextCursor} onClick={() => { setCursor(visible.page?.nextCursor ?? undefined); setSelected(undefined); }}>Next members</button></div>
    </> : null}
    {selected?.owner === selectionOwner && visible?.page?.value.some(member => member.source_scope_id === selected.member.source_scope_id && member.source_identity === selected.member.source_identity)
      ? <InventoryMemberFacts key={`${selectionId}:${selected.member.source_scope_id}:${selected.member.source_identity}`}
        selectionId={selectionId} recordId={recordId} member={selected.member} /> : null}
  </section>;
}

function InventoryMemberFacts({ selectionId, recordId, member }: { selectionId: string; recordId: string; member: InventoryMember }) {
  const [kind, setKind] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [sectionCursor, setSectionCursor] = useState<string>();
  const [sections, setSections] = useState<Awaited<ReturnType<typeof getInventorySections>>>();
  const [sectionError, setSectionError] = useState<string>();
  const [state, setState] = useState<{ owner: string; page?: Awaited<ReturnType<typeof getInventoryChildren>>; error?: string }>();
  const owner = JSON.stringify([selectionId, recordId, member.source_scope_id, member.source_identity, kind, cursor]);
  useEffect(() => {
    const controller = new AbortController();
    void getInventorySections(selectionId, recordId, member, { cursor: sectionCursor, signal: controller.signal })
      .then(page => {
        if (!controller.signal.aborted) {
          setSections(page); setSectionError(undefined); setCursor(undefined);
          setKind(page.value.find(section => section.kind === "element")?.kind ?? page.value[0]?.kind);
        }
      }).catch(error => { if (!controller.signal.aborted) setSectionError(error instanceof Error ? error.message : "Detail sections unavailable."); });
    return () => controller.abort();
  }, [selectionId, recordId, member, sectionCursor]);
  useEffect(() => {
    if (!kind) return;
    const controller = new AbortController();
    void getInventoryChildren(selectionId, recordId, member, kind, cursor, { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) setState({ owner, page }); })
      .catch(error => { if (!controller.signal.aborted) setState({ owner, error: error instanceof Error ? error.message : "Source details unavailable." }); });
    return () => controller.abort();
  }, [selectionId, recordId, member, kind, cursor, owner]);
  const visible = state?.owner === owner ? state : undefined;
  return <section className="inventory-source-details" aria-label="Source detail rows">
    <h4>{member.display_name || member.native_id}</h4>
    {sectionError ? <p role="alert">{sectionError}</p> : null}
    <label>Detail section<select value={kind ?? ""} disabled={!sections?.value.length} onChange={event => { setKind(event.target.value); setCursor(undefined); }}>
      {sections?.value.map(section => <option key={section.kind} value={section.kind}>{section.kind} ({section.total.toLocaleString()})</option>)}
    </select></label>
    {sections?.nextCursor ? <button type="button" onClick={() => setSectionCursor(sections.nextCursor!)}>More detail sections</button> : null}
    {sectionCursor ? <button type="button" onClick={() => setSectionCursor(undefined)}>First detail sections</button> : null}
    {visible?.error ? <p role="alert">{visible.error}</p> : null}
    {visible?.page ? <>
      <p>{visible.page.value.length} shown of {visible.page.total.toLocaleString()} {kind} rows.</p>
      <ul>{visible.page.value.map(row => <li key={row.ordinal}><strong>{row.value}</strong>
        {Object.keys(row.payload).length ? <pre>{JSON.stringify(row.payload, null, 2)}</pre> : null}</li>)}</ul>
      <div className="table-actions">{cursor ? <button type="button" onClick={() => setCursor(undefined)}>First detail rows</button> : null}
      <button type="button" disabled={!visible.page.nextCursor} onClick={() => setCursor(visible.page?.nextCursor ?? undefined)}>Next detail rows</button></div>
    </> : sections?.value.length === 0 ? <p>No saved child collections.</p> : <p role="status">Loading detail rows…</p>}
  </section>;
}
