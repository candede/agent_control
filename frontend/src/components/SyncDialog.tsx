import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { trapDialogFocus } from "../dialogFocus";

export function SyncDialog({ open, title, description, onClose, children }: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    heading.current?.focus();
    return () => {
      element.close();
      document.body.style.overflow = previousOverflow;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="sync-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => trapDialogFocus(event, event.currentTarget)}
    >
      <header className="sync-dialog-header">
        <div>
          <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2>
          {description ? <p id={`${id}-description`}>{description}</p> : null}
        </div>
        <button type="button" className="secondary sync-dialog-close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="sync-dialog-body">{open ? children : null}</div>
    </dialog>
  );
}
