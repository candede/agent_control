import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

function available(element: HTMLElement) {
  if (!element.isConnected || element.matches(':disabled, input[type="hidden"]')
    || element.closest("[hidden], dialog:not([open])")) return false;
  const view = element.ownerDocument.defaultView;
  const visibility = view?.getComputedStyle(element).visibility;
  if (visibility === "hidden" || visibility === "collapse") return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (view?.getComputedStyle(parent).display === "none") return false;
  }
  return true;
}

// This is a lifecycle shim, not a top-layer/inertness or trusted keyboard/form polyfill.
// Native modality and browser focus navigation are covered by browser/dialogFocus.spec.ts.
export function mockNativeDialogs() {
  let dispose: () => void;

  beforeEach(() => {
    const prototype = HTMLDialogElement.prototype;
    const keys = ["showModal", "close", "focus", "returnValue"] as const;
    const originals = keys.map(key => Object.getOwnPropertyDescriptor(prototype, key));
    const originalFocus = prototype.focus;
    const modals = new Map<HTMLDialogElement, Element | null>();
    const returnValues = new WeakMap<HTMLDialogElement, string>();
    const pending = new Set<() => void>();
    let disposed = false;
    Object.defineProperties(prototype, {
      showModal: { configurable: true, writable: true, value: function (this: HTMLDialogElement) {
        if (!this.isConnected) modals.delete(this);
        if (this.open && modals.has(this)) return;
        if (this.open || !this.isConnected || !this.ownerDocument.defaultView) {
          throw new DOMException("The dialog is disconnected or already open nonmodally.", "InvalidStateError");
        }
        modals.set(this, this.ownerDocument.activeElement);
        this.open = true;
        const candidates = [...this.querySelectorAll<HTMLElement>(
          "[autofocus], button, input, select, textarea, a[href], summary, [tabindex]",
        )].filter(available);
        for (const target of [
          ...candidates.filter(element => element.hasAttribute("autofocus")), ...candidates, this,
        ]) {
          target.focus();
          if (this.ownerDocument.activeElement === target) break;
        }
      } },
      focus: { configurable: true, writable: true, value: function (this: HTMLDialogElement, options?: FocusOptions) {
        if (!available(this)) return;
        const tabIndex = this.getAttribute("tabindex");
        // JSDOM does not give dialogs their native intrinsic focusability.
        if (tabIndex === null) this.setAttribute("tabindex", "-1");
        try { originalFocus.call(this, options); }
        finally { if (tabIndex === null) this.removeAttribute("tabindex"); }
      } },
      returnValue: { configurable: true, get(this: HTMLDialogElement) { return returnValues.get(this) ?? ""; },
        set(this: HTMLDialogElement, value: string) { returnValues.set(this, String(value)); } },
      close: { configurable: true, writable: true, value: function (this: HTMLDialogElement, result?: string) {
        if (!this.open) return;
        const previous = modals.get(this);
        modals.delete(this);
        this.open = false;
        if (result !== undefined) this.returnValue = result;
        const foreground = [...modals.keys()].reverse().find(dialog => dialog.isConnected && dialog.open);
        if (previous instanceof HTMLElement && available(previous) && (!foreground || foreground.contains(previous))) previous.focus();
        const clear = globalThis.clearTimeout;
        const timer = setTimeout(() => {
          pending.delete(cancel);
          if (!disposed) this.dispatchEvent(new Event("close"));
        }, 0);
        const cancel = () => clear(timer);
        pending.add(cancel);
      } },
    });
    dispose = () => {
      disposed = true;
      for (const cancel of pending) cancel();
      // Vitest retains spy restorers even after mockRestore; drain them before restoring descriptors.
      vi.restoreAllMocks();
      for (const [index, key] of keys.entries()) {
        const original = originals[index];
        if (original) Object.defineProperty(prototype, key, original);
        else Reflect.deleteProperty(prototype, key);
      }
    };
  });

  afterEach(() => {
    try { cleanup(); }
    finally { dispose(); }
  });
}
