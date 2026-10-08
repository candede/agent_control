import { afterEach, describe, expect, it, vi } from "vitest";
import { mockNativeDialogs } from "./dialog";

const originalDescriptors = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
let retiredCloses = 0;
const retiredClose = () => { retiredCloses += 1; };

function fixture(content = "<button>First</button><button>Last</button>") {
  document.body.innerHTML = `<button id="opener">Open</button><dialog>${content}</dialog>`;
  const dialog = document.querySelector("dialog")!;
  const opener = document.querySelector<HTMLButtonElement>("#opener")!;
  opener.focus();
  return { dialog, opener };
}

describe("native dialog test shim", () => {
  mockNativeDialogs();
  afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

  it("rejects detached and already nonmodal dialogs instead of silently opening them", () => {
    expect(() => document.createElement("dialog").showModal()).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    const { dialog } = fixture();
    dialog.open = true;
    expect(() => dialog.showModal()).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
    dialog.close();
    dialog.showModal();
    dialog.remove();
    expect(() => dialog.showModal()).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
  });

  it("focuses the first available control and does not move retained focus on repeated opens", () => {
    const { dialog } = fixture('<button disabled autofocus>Disabled</button><button hidden>Hidden</button><button>First</button><button>Last</button>');
    dialog.showModal();
    const buttons = dialog.querySelectorAll("button");
    expect(buttons[2]).toHaveFocus();
    buttons[3].focus();
    dialog.showModal();
    expect(buttons[3]).toHaveFocus();
  });

  it("honors autofocus and focuses an empty dialog without changing its tabindex contract", () => {
    const { dialog } = fixture('<button>First</button><input autofocus aria-label="Draft">');
    dialog.showModal();
    expect(dialog.querySelector("input")).toHaveFocus();
    dialog.querySelector("button")!.focus();
    dialog.showModal();
    expect(dialog.querySelector("button")).toHaveFocus();
    dialog.replaceChildren();
    dialog.focus();
    expect(dialog).toHaveFocus();
    expect(dialog).not.toHaveAttribute("tabindex");
    dialog.close();
    dialog.showModal();
    expect(dialog).toHaveFocus();
    expect(dialog).not.toHaveAttribute("tabindex");
  });

  it("closes once, restores focus synchronously and queues a nonbubbling event with the return value", async () => {
    vi.useFakeTimers();
    const { dialog, opener } = fixture();
    const close = vi.fn(), bubbled = vi.fn();
    dialog.addEventListener("close", close);
    document.body.addEventListener("close", bubbled, { once: true });
    try {
      expect(dialog.returnValue).toBe("");
      dialog.showModal();
      dialog.close("accepted");
      dialog.close("ignored");
      expect(dialog.open).toBe(false);
      expect(opener).toHaveFocus();
      expect(dialog.returnValue).toBe("accepted");
      expect(close).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(close).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ bubbles: false, cancelable: false }));
      expect(bubbled).not.toHaveBeenCalled();
      dialog.showModal();
      dialog.close();
      expect(dialog.returnValue).toBe("accepted");
    } finally {
      document.body.removeEventListener("close", bubbled);
    }
  });

  it("delivers the previous close after reopening so Strict Mode races cannot be hidden", async () => {
    vi.useFakeTimers();
    const { dialog } = fixture();
    const states: boolean[] = [];
    dialog.addEventListener("close", () => states.push(dialog.open));
    dialog.showModal();
    dialog.close();
    dialog.showModal();
    expect(states).toEqual([]);
    await vi.runAllTimersAsync();
    expect(states).toEqual([true]);
    expect(dialog.open).toBe(true);
  });

  it("restores the nested opener without moving focus when the background dialog closes", () => {
    const { dialog: parent, opener } = fixture('<button>Open nested</button><dialog><button>Nested action</button></dialog>');
    parent.showModal();
    const nested = parent.querySelector("dialog")!;
    const trigger = parent.querySelector("button")!;
    nested.showModal();
    expect(nested.querySelector("button")).toHaveFocus();
    nested.close();
    expect(trigger).toHaveFocus();
    nested.showModal();
    parent.close();
    expect(nested.querySelector("button")).toHaveFocus();
    expect(opener).not.toHaveFocus();
  });

  it("does not try to restore a detached opener or change application-owned scrolling", () => {
    const { dialog, opener } = fixture();
    const overflow = document.body.style.overflow;
    dialog.showModal();
    opener.remove();
    const focus = vi.spyOn(opener, "focus");
    dialog.close();
    expect(focus).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe(overflow);
  });

  it("does not invent trusted Escape or synthetic cancel default actions", () => {
    const { dialog } = fixture();
    dialog.showModal();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog.open).toBe(true);
  });

  it("allows method spies without leaking restored shims into the next owner", () => {
    const { dialog } = fixture();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    dialog.showModal();
    expect(showModal).toHaveBeenCalledOnce();
    dialog.addEventListener("close", retiredClose);
    dialog.close();
  });
});

describe("native dialog test shim disposal", () => {
  it("restores the exact preexisting prototype and retires pending events, including method spies", async () => {
    vi.restoreAllMocks();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retiredCloses).toBe(0);
    expect(Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype)).toEqual(originalDescriptors);
  });
});
