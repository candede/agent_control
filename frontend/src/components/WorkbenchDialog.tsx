import { useEffect, useEffectEvent, useId, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";
import { lockBodyScroll } from "../bodyScrollLock";
import { observeDialogFocus, trapDialogFocus } from "../dialogFocus";
import "./workbenchDialog.css";

export function WorkbenchDialog({ open, title, description, className = "", fallbackFocusRef, onClose, children }: {
  open: boolean;
  title: string;
  description?: string;
  className?: string;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onClose?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusFallback = useEffectEvent(() => {
    const fallback = fallbackFocusRef?.current;
    if (fallback?.isConnected) fallback.focus();
  });

  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    const document = element.ownerDocument;
    const opener = document.activeElement;
    element.showModal();
    const stopObservingFocus = observeDialogFocus(element);
    const unlockBodyScroll = lockBodyScroll(document.body);
    heading.current?.focus();
    return () => {
      stopObservingFocus();
      element.close();
      unlockBodyScroll();
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
        if (document.activeElement === opener) return;
      }
      focusFallback();
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={`workbench-dialog ${className}`}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose?.();
      }}
      onKeyDown={event => {
        if (event.target instanceof Element && event.target.closest("dialog") === event.currentTarget) {
          trapDialogFocus(event, event.currentTarget);
        }
      }}
    >
      <header className="workbench-dialog-header">
        <div>
          <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{title}</h2>
          {description ? <p id={`${id}-description`}>{description}</p> : null}
        </div>
        {onClose ? <button type="button" className="secondary workbench-dialog-close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button> : null}
      </header>
      <div className="workbench-dialog-body">{open ? children : null}</div>
    </dialog>
  );
}
