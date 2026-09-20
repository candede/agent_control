import { useEffect, useRef, useState, type RefObject } from "react";
import { Upload, X } from "lucide-react";
import { OfficialUsageImportPanel, type OfficialUsageImportPanelProps } from "./OfficialUsageImportPanel";
import type { ImportView } from "./officialUsageImportPresentation";
import "./officialUsage.css";

type OfficialUsageImportModalProps = Pick<OfficialUsageImportPanelProps, "initialStagingId" | "onChanged" | "onLegacyCleared"> & {
  openRequest?: number;
  openView?: ImportView;
  showTrigger?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onViewSnapshot?: (setId: string) => void;
};

export function OfficialUsageImportModal({
  openRequest = 0,
  openView = "import",
  showTrigger = true,
  returnFocusRef,
  onViewSnapshot,
  ...panelProps
}: OfficialUsageImportModalProps) {
  const [open, setOpen] = useState(Boolean(panelProps.initialStagingId));
  const [visited, setVisited] = useState(Boolean(panelProps.initialStagingId));
  const [view, setView] = useState<ImportView>("import");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const lastOpenRequest = useRef(openRequest);
  const returnTarget = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      const focused = document.activeElement;
      returnTarget.current = focused instanceof HTMLElement && focused !== document.body && !element.contains(focused) ? focused : null;
      element.showModal();
      closeButton.current?.focus({ preventScroll: true });
    } else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (openRequest === lastOpenRequest.current) return;
    lastOpenRequest.current = openRequest;
    setVisited(true);
    setView(openView);
    setOpen(true);
  }, [openRequest, openView]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  return (
    <>
      {showTrigger ? (
        <button ref={trigger} type="button" className="secondary" aria-haspopup="dialog" onClick={() => { setVisited(true); setView("import"); setOpen(true); }}>
          <Upload size={16} />Import reports
        </button>
      ) : null}
      <dialog
        ref={dialog}
        className="official-usage-modal"
        aria-labelledby="usage-import-modal-title"
        aria-describedby="usage-import-modal-description"
        onKeyDown={event => {
          if (event.key !== "Tab") return;
          if (event.shiftKey && event.target === closeButton.current) {
            event.preventDefault();
            returnButton.current?.focus();
          } else if (!event.shiftKey && event.target === returnButton.current) {
            event.preventDefault();
            closeButton.current?.focus();
          }
        }}
        onCancel={event => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          setOpen(false);
        }}
        onClose={event => {
          if (event.target !== event.currentTarget) return;
          setOpen(false);
          const target = returnTarget.current;
          if (target?.isConnected) target.focus();
          else (returnFocusRef?.current ?? trigger.current)?.focus();
        }}
      >
        <header className="usage-modal-header">
          <div>
            <h2 id="usage-import-modal-title">{view === "import" ? "Import CSV reports" : "Manage reports"}</h2>
            <p id="usage-import-modal-description">{view === "import"
              ? "Validate and review three CSV exports before accepting."
              : "Resume drafts, view snapshots, or manage the saved report selection."}</p>
          </div>
          <button ref={closeButton} type="button" className="icon-button" aria-label="Close report import" autoFocus onClick={() => setOpen(false)}><X size={20} /></button>
          <div className="usage-modal-views" role="group" aria-label="Report workflow">
            <button type="button" className="secondary" aria-pressed={view === "import"} onClick={() => setView("import")}>Add CSV reports</button>
            <button type="button" className="secondary" aria-pressed={view === "manage"} onClick={() => setView("manage")}>Manage reports</button>
          </div>
        </header>
        <div className="usage-modal-content">
          {visited ? <OfficialUsageImportPanel {...panelProps} active={open} view={view} onViewChange={setView}
            onViewSnapshot={onViewSnapshot ? setId => {
              setOpen(false);
              dialog.current?.close();
              onViewSnapshot(setId);
            } : undefined} /> : null}
        </div>
        <footer className="usage-modal-footer">
          <span>Closing keeps your draft. Server staging can expire.</span>
          <button ref={returnButton} type="button" className="secondary" onClick={() => setOpen(false)}>Close</button>
        </footer>
      </dialog>
    </>
  );
}
