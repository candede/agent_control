import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { trapDialogFocus } from "../dialogFocus";
import "./workbenchDialog.css";

const bodyScrollLocks = new WeakMap<HTMLElement, { count: number; previousOverflow: string }>();

function lockBodyScroll(body: HTMLElement) {
  const lock = bodyScrollLocks.get(body) ?? { count: 0, previousOverflow: body.style.overflow };
  bodyScrollLocks.set(body, lock);
  lock.count += 1;
  body.style.overflow = "hidden";
  return () => {
    lock.count -= 1;
    if (lock.count === 0) {
      body.style.overflow = lock.previousOverflow;
      bodyScrollLocks.delete(body);
    }
  };
}

export function WorkbenchDialog({ open, title, description, className = "", fallbackFocusRef, onClose, children }: {
  open: boolean;
  title: string;
  description?: string;
  className?: string;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const document = element.ownerDocument;
    const opener = document.activeElement;
    const fallback = fallbackFocusRef?.current;
    element.showModal();
    const unlockBodyScroll = lockBodyScroll(document.body);
    heading.current?.focus();
    return () => {
      element.close();
      unlockBodyScroll();
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
        if (document.activeElement === opener) return;
      }
      if (fallback?.isConnected) fallback.focus();
    };
  }, [open, fallbackFocusRef]);

  return (
    <dialog
      ref={dialog}
      className={`workbench-dialog ${className}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => trapDialogFocus(event, event.currentTarget)}
    >
      <header className="workbench-dialog-header">
        <div>
          <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2>
          {description ? <p id={`${id}-description`}>{description}</p> : null}
        </div>
        <button type="button" className="secondary workbench-dialog-close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="workbench-dialog-body">{open ? children : null}</div>
    </dialog>
  );
}
