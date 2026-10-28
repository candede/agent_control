import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Check, ChevronDown } from "lucide-react";
import "./facetDropdown.css";

export function FacetDropdown({ label, value, options, disabled, onChange, controlRef }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; disabled: boolean;
  onChange: (value: string) => void; controlRef: RefObject<HTMLButtonElement | null>;
}) {
  const id = useId(), root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const typeahead = useRef({ text: "", at: 0 });
  const index = Math.max(0, options.findIndex(option => option.value === active));
  const selected = options.find(option => option.value === value);
  const unavailable = disabled || options.length === 0;
  if (open && unavailable) setOpen(false);

  useEffect(() => {
    if (!open) { typeahead.current = { text: "", at: 0 }; return; }
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector(`[id="${id}-${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, id, index]);

  function choose(next: string) {
    if (unavailable) return;
    setOpen(false);
    onChange(next);
    controlRef.current?.focus();
  }
  return <div ref={root} className="facet-dropdown" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={controlRef} type="button" className={`facet-dropdown-trigger${value ? " active-filter-select" : ""}`}
      role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-disabled={unavailable}
      aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${index}` : undefined}
      title={selected?.label}
      onClick={() => { if (!unavailable) { setActive(value); setOpen(!open); } }}
      onKeyDown={event => {
        if (unavailable) return;
        if (event.key === "Escape" || event.key === "Tab") { setOpen(false); return; }
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (open) choose(options[index].value);
          else { setActive(value); setOpen(true); }
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
            : !open ? Math.max(0, options.findIndex(option => option.value === value))
              : Math.min(options.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
          setActive(options[next].value);
          setOpen(true);
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          const now = performance.now(), key = event.key.toLocaleLowerCase();
          const previous = now - typeahead.current.at < 700 ? typeahead.current.text : "";
          const text = previous === key ? key : previous + key;
          typeahead.current = { text, at: now };
          const start = open ? index + (text === key ? 1 : 0) : 0;
          const match = Array.from({ length: options.length }, (_, offset) => options[(start + offset) % options.length])
            .find(option => option.label.toLocaleLowerCase().startsWith(text));
          if (match) { setActive(match.value); setOpen(true); }
        }
      }}>
      <span>{selected?.label}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
    {open ? <div id={id} role="listbox" aria-label={`${label} options`} className="facet-dropdown-menu">
      {options.map((option, optionIndex) => <div key={option.value} id={`${id}-${optionIndex}`}
        role="option" aria-selected={value === option.value}
        className={`facet-dropdown-option${optionIndex === index ? " is-active" : ""}`}
        onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(option.value)}
        onClick={() => choose(option.value)}>
        <span>{option.label}</span>{value === option.value ? <Check size={15} aria-hidden="true" /> : null}
      </div>)}
    </div> : null}
  </div>;
}
