const focusableSelector = [
  "a[href]",
  "button",
  'input:not([type="hidden"])',
  "select",
  "textarea",
  "details > summary:first-of-type",
  "[tabindex]",
].join(",");

function isHiddenByClosedDetails(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.matches("details:not([open])") && !parent.querySelector(":scope > summary")?.contains(element)) {
      return true;
    }
  }
  return false;
}

function isHiddenByStyles(element: HTMLElement) {
  const view = element.ownerDocument.defaultView;
  const visibility = view?.getComputedStyle(element).visibility;
  if (visibility === "hidden" || visibility === "collapse") return true;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (view?.getComputedStyle(parent).display === "none") return true;
  }
  return false;
}

function isRadioInput(element: HTMLElement): element is HTMLInputElement {
  return element.matches('input[type="radio"]');
}

function isUnavailableForFocus(element: HTMLElement) {
  const inert = element.closest("[inert]");
  const modal = inert && element.closest("dialog:modal");
  // Native modals escape inherited inertness, but not inertness applied inside the modal.
  return !element.isConnected || element.matches(':disabled, input[type="hidden"]')
    || element.closest("[hidden]") || inert && (!modal || modal.contains(inert))
    || isHiddenByClosedDetails(element) || isHiddenByStyles(element);
}

export function observeDialogFocus(dialog: HTMLDialogElement) {
  const document = dialog.ownerDocument;
  const observer = new MutationObserver(() => {
    // Removing or disabling focused content sends keydown to the body, bypassing the dialog's trap.
    const active = document.activeElement;
    if (dialog.isConnected && dialog.open && (active === document.body
      || active instanceof HTMLElement && dialog.contains(active) && isUnavailableForFocus(active))) {
      dialog.focus({ preventScroll: true });
    }
  });
  observer.observe(dialog, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "hidden", "inert", "open", "style", "class"],
  });
  return () => observer.disconnect();
}

export function trapDialogFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault"> & { defaultPrevented?: boolean },
  dialog: HTMLElement | null,
) {
  if (event.key !== "Tab" || event.defaultPrevented || !dialog
    || dialog.matches("dialog:not([open])") || isUnavailableForFocus(dialog)) return;
  const document = dialog.ownerDocument;
  const active = document.activeElement;
  const activeModal = active?.closest("dialog:modal");
  // Native modal inertness is not reflected in background elements' attributes.
  if (activeModal && !activeModal.contains(dialog)
    || !dialog.closest("dialog:modal") && document.querySelector("dialog:modal")) return;
  const candidates = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter(element => element.tabIndex >= 0 && !isUnavailableForFocus(element))
    .sort((a, b) => (a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER));
  const radios = candidates.filter(isRadioInput);
  const focusable = candidates.filter(element => {
    if (!isRadioInput(element) || !element.name) return true;
    const group = radios.filter(radio => radio.name === element.name && radio.form === element.form);
    const tabStop = group.find(radio => radio.checked)
      ?? group.find(radio => radio === active)
      ?? group[event.shiftKey ? group.length - 1 : 0];
    return element === tabStop;
  });
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const activeIndex = focusable.findIndex(element => element === active);
  const nextIndex = event.shiftKey ? activeIndex - 1 : activeIndex + 1;
  // Positive tab indices otherwise navigate in document order, including outside this dialog.
  if (activeIndex === -1 || nextIndex < 0 || nextIndex === focusable.length || focusable[0].tabIndex > 0) {
    event.preventDefault();
    const targetIndex = event.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : nextIndex
      : nextIndex === focusable.length ? 0 : nextIndex;
    focusable[targetIndex].focus();
  }
}
