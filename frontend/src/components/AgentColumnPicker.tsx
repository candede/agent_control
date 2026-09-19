import { useEffect, useId, useRef, useState } from "react";
import { Columns3, X } from "lucide-react";
import { agentColumnGroups, type AgentColumnGroup } from "../agentColumns";

type ColumnChoice = {
  id: string;
  label: string;
  group: AgentColumnGroup;
  description?: string;
  visible: boolean;
  canHide: boolean;
};

export function AgentColumnPicker({ columns, onToggle, onReset }: {
  columns: ColumnChoice[];
  onToggle: (id: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  const filtered = columns.filter(column => column.label.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="agent-column-picker" ref={root} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} type="button" className="secondary" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}>
      <Columns3 size={16} aria-hidden="true" /> Columns
    </button>
    {open ? <div id={id} className="agent-column-popover" role="dialog" aria-label="Choose agent columns">
      <div className="agent-column-popover-heading">
        <strong>Table columns</strong>
        <button type="button" className="secondary icon-button" aria-label="Close column picker" onClick={() => {
          setOpen(false);
          trigger.current?.focus();
        }}><X size={16} aria-hidden="true" /></button>
      </div>
      <label>Find columns<input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <div className="agent-column-options">
        {agentColumnGroups.map(group => {
          const choices = filtered.filter(column => column.group === group);
          return choices.length ? <fieldset key={group}>
            <legend>{group}</legend>
            {choices.map(column => <label key={column.id} title={column.description}>
              <input type="checkbox" checked={column.visible} disabled={!column.canHide} onChange={() => onToggle(column.id)} />
              <span>{column.label}{!column.canHide ? <> <small>Always shown</small></> : null}</span>
            </label>)}
          </fieldset> : null;
        })}
        {!filtered.length ? <p>No columns match your search.</p> : null}
      </div>
      <button type="button" className="secondary" onClick={onReset}>Reset defaults</button>
    </div> : null}
  </div>;
}
