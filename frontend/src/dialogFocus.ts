const focusableSelector = [
  "a[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function trapDialogFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  dialog: HTMLElement | null,
) {
  if (event.key !== "Tab" || !dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(element => !element.hasAttribute("disabled") && !element.closest("[hidden], [inert]"));
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = dialog.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !focusable.some(element => element === active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
