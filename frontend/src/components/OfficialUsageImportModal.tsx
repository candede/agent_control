import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { OfficialUsageImportPanel } from "./OfficialUsageImportPanel";
import "./officialUsage.css";

type OfficialUsageImportModalProps = Parameters<typeof OfficialUsageImportPanel>[0] & {
  openRequest?: number;
  showTrigger?: boolean;
};

export function OfficialUsageImportModal({
  openRequest = 0,
  showTrigger = true,
  ...panelProps
}: OfficialUsageImportModalProps) {
  const [open, setOpen] = useState(Boolean(panelProps.initialStagingId));
  const [visited, setVisited] = useState(Boolean(panelProps.initialStagingId));
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const lastOpenRequest = useRef(openRequest);

  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);

  useEffect(() => {
    if (openRequest === lastOpenRequest.current) return;
    lastOpenRequest.current = openRequest;
    setVisited(true);
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  return (
    <>
      {showTrigger ? (
        <button ref={trigger} type="button" className="secondary" aria-haspopup="dialog" onClick={() => { setVisited(true); setOpen(true); }}>
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
          trigger.current?.focus();
        }}
      >
        <header className="usage-modal-header">
          <div>
            <h2 id="usage-import-modal-title">Import and manage reports</h2>
            <p id="usage-import-modal-description">Upload a cumulative CSV snapshot, review authoritative validation, and approve it without replacing prior accepted history.</p>
          </div>
          <button ref={closeButton} type="button" className="icon-button" aria-label="Close report import" autoFocus onClick={() => setOpen(false)}><X size={20} /></button>
        </header>
        <div className="usage-modal-content">
          {visited ? <OfficialUsageImportPanel {...panelProps} /> : null}
        </div>
        <footer className="usage-modal-footer">
          <span>Closing does not discard staging. Staged reports remain available until accepted, discarded, or expired.</span>
          <button ref={returnButton} type="button" onClick={() => setOpen(false)}>Back to reports</button>
        </footer>
      </dialog>
    </>
  );
}
