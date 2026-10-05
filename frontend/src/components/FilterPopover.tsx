import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { SlidersHorizontal, X } from "lucide-react";

export function FilterPopover({ label, activeCount, description, triggerRef, children }: {
  label: string;
  activeCount: number;
  description?: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const positionPopover = () => {
      const panel = popover.current;
      const anchor = root.current;
      if (!panel || !anchor) return;
      if (window.innerWidth <= 760 || window.innerHeight <= 640) {
        panel.dataset.side = "below";
        panel.style.removeProperty("--agent-filter-max-height");
        panel.style.removeProperty("--agent-filter-right");
        return;
      }
      const bounds = anchor.getBoundingClientRect();
      const width = panel.getBoundingClientRect().width;
      const left = Math.min(Math.max(bounds.right - width, 16), window.innerWidth - width - 16);
      panel.style.setProperty("--agent-filter-right", `${bounds.right - left - width}px`);
      // Reserve the 10px anchor gap and a 16px viewport inset.
      const below = Math.max(0, window.innerHeight - bounds.bottom - 26);
      const above = Math.max(0, bounds.top - 26);
      const needed = Math.min(560, panel.scrollHeight || 560);
      const opensAbove = below < needed && above > below;
      const previousHeight = panel.clientHeight;
      const previousScroll = panel.scrollTop;
      const remainedAbove = opensAbove && panel.dataset.side === "above";
      panel.dataset.side = opensAbove ? "above" : "below";
      panel.style.setProperty("--agent-filter-max-height", `${Math.min(560, opensAbove ? above : below)}px`);
      if (remainedAbove && previousScroll > 0) {
        panel.scrollTop = previousScroll + previousHeight - panel.clientHeight;
      }
    };
    const positionAfterScroll = (event: Event) => {
      if (event.target instanceof Node && popover.current?.contains(event.target)) return;
      positionPopover();
    };
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionAfterScroll, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionAfterScroll, true);
    };
  }, [open, activeCount]);

  useEffect(() => {
    if (!open) return;
    let observer: MutationObserver | undefined;
    const focusFirst = () => {
      const first = popover.current?.querySelector<HTMLElement>("select, input");
      if (!first || first.matches(":disabled")) return false;
      if (document.activeElement === triggerRef.current || document.activeElement === document.body) first.focus();
      observer?.disconnect();
      return true;
    };
    if (!focusFirst() && popover.current) {
      observer = new MutationObserver(focusFirst);
      observer.observe(popover.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    }
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      observer?.disconnect();
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open, triggerRef]);

  return <div className="agent-filter-picker" ref={root} onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={triggerRef} type="button" className="secondary agent-filter-trigger"
      aria-label={activeCount ? `Filters, ${activeCount} active` : "Filters"} title={`${label} and choose sort order`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(value => !value)}>
      <SlidersHorizontal size={16} aria-hidden="true" /> Filters
      {activeCount ? <span className="filter-count" aria-hidden="true">{activeCount}</span> : null}
    </button>
    {open ? <div ref={popover} id={id} className="agent-filter-popover" role="dialog" aria-label={label}>
      <header>
        <div><strong>{label}</strong>{description ? <p>{description}</p> : null}</div>
        <button type="button" className="secondary icon-button" aria-label="Close filters" onClick={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}><X size={18} aria-hidden="true" /></button>
      </header>
      {children}
    </div> : null}
  </div>;
}
