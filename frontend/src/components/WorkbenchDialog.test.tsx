import { StrictMode, createRef, useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNativeDialogs } from "../test/dialog";
import { WorkbenchDialog } from "./WorkbenchDialog";

mockNativeDialogs();

let originalOverflow: string;
beforeEach(() => { originalOverflow = document.body.style.overflow; });
afterEach(() => {
  cleanup();
  document.body.style.overflow = originalOverflow;
  vi.restoreAllMocks();
});

describe("WorkbenchDialog", () => {
  it("retains content through pending, error and success updates but retires it on close or owner replacement", () => {
    const mount = vi.fn(), dispose = vi.fn();
    function Content({ owner, status }: { owner: string; status: string }) {
      useEffect(() => { mount(owner); return () => { dispose(owner); }; }, [owner]);
      return <><input aria-label="Dialog draft" defaultValue="" /><p role="status">{status}</p></>;
    }
    const content = (open: boolean, owner: string, status: string) => <WorkbenchDialog key={owner} open={open}
      title="Details" onClose={vi.fn()}><Content owner={owner} status={status} /></WorkbenchDialog>;
    const { rerender } = render(content(false, "first", "Loading"));
    expect(mount).not.toHaveBeenCalled();
    rerender(content(true, "first", "Loading"));
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Private draft" } });
    for (const status of ["Read failed", "Loading", "Saved"]) {
      rerender(content(true, "first", status));
      expect(screen.getByRole("textbox")).toHaveValue("Private draft");
      expect(screen.getByRole("status")).toHaveTextContent(status);
    }
    expect(mount).toHaveBeenCalledExactlyOnceWith("first");
    expect(dispose).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    rerender(content(false, "first", "Saved"));
    expect(dispose).toHaveBeenCalledExactlyOnceWith("first");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    rerender(content(true, "first", "Loading"));
    expect(screen.getByRole("textbox")).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Another private draft" } });
    rerender(content(true, "second", "Loading"));
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(mount).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("uses current dismissal handlers and can become blocking without reopening", () => {
    const previous = vi.fn(), current = vi.fn();
    const content = (onClose?: () => void) => <WorkbenchDialog open title="Details" onClose={onClose}>Content</WorkbenchDialog>;
    const { rerender } = render(content(previous));
    const dialog = screen.getByRole("dialog");
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    rerender(content());
    expect(screen.queryByRole("button", { name: "Close details" })).not.toBeInTheDocument();
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(false);
    expect(previous).not.toHaveBeenCalled();
    rerender(content(current));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(current).toHaveBeenCalledTimes(2);
    expect(previous).not.toHaveBeenCalled();
    expect(showModal).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute("open");
  });

  it("recovers focus after a child-only loading update without reopening or restarting that child", async () => {
    const mount = vi.fn();
    function Content() {
      const [loading, setLoading] = useState(false);
      useEffect(() => { mount(); }, []);
      return loading ? <p role="status">Loading current details...</p>
        : <button type="button" onClick={() => setLoading(true)}>Load details</button>;
    }
    render(<WorkbenchDialog open title="Details"><Content /></WorkbenchDialog>);
    const dialog = screen.getByRole("dialog");
    const focus = vi.spyOn(dialog, "focus");
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    await userEvent.click(screen.getByRole("button", { name: "Load details" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading current details...");
    expect(dialog).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledOnce();
    expect(showModal).not.toHaveBeenCalled();
  });

  it("mounts content only while open, labels the dialog, and restores focus and scrolling", async () => {
    document.body.style.overflow = "auto";
    const props = { title: "Details", description: "Saved details", onClose: vi.fn() };
    const content = (open: boolean) => <>
      <button type="button">Open details</button>
      <WorkbenchDialog {...props} open={open}><button type="button">Dialog action</button></WorkbenchDialog>
    </>;
    const { rerender } = render(content(false));
    const opener = screen.getByRole("button", { name: "Open details" });
    opener.focus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Dialog action")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");

    rerender(content(true));
    const dialog = screen.getByRole("dialog", { name: "Details" });
    expect(dialog).toHaveAccessibleDescription("Saved details");
    expect(screen.getByRole("heading", { name: "Details" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Dialog action" })).toHaveFocus();
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Close details" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute("open");

    rerender(content(false));
    expect(opener).toHaveFocus();
    expect(screen.queryByText("Dialog action")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("requests a controlled close on native cancellation without closing itself", () => {
    const onClose = vi.fn();
    render(<WorkbenchDialog open title="Details" onClose={onClose}>Content</WorkbenchDialog>);
    const dialog = screen.getByRole("dialog");
    const cancelled = fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(cancelled).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(dialog).toHaveAttribute("open");
  });

  it("does not request a parent close when a nested dialog is cancelled", () => {
    const onClose = vi.fn();
    const onNestedClose = vi.fn();
    render(<WorkbenchDialog open title="Parent" onClose={onClose}>
      <WorkbenchDialog open title="Nested" onClose={onNestedClose}>Nested content</WorkbenchDialog>
    </WorkbenchDialog>);
    const nested = screen.getByRole("dialog", { name: "Nested" });
    expect(fireEvent(nested, new Event("cancel", { cancelable: true }))).toBe(false);
    expect(onNestedClose).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Parent" })).toHaveAttribute("open");
  });

  it("handles each nested dialog Tab only once", async () => {
    render(<WorkbenchDialog open title="Parent" onClose={vi.fn()}>
      <WorkbenchDialog open title="Nested" onClose={vi.fn()}>
        <button type="button" tabIndex={1}>First nested action</button>
        <button type="button" tabIndex={2}>Second nested action</button>
        <button type="button" tabIndex={3}>Third nested action</button>
      </WorkbenchDialog>
    </WorkbenchDialog>);
    const first = screen.getByRole("button", { name: "First nested action" });
    first.focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Second nested action" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(first).toHaveFocus();
  });

  it("keeps a blocking dialog open without close controls and traps keyboard focus", async () => {
    render(<WorkbenchDialog open title="Preparing workspace">
      <button type="button">Recovery action</button>
    </WorkbenchDialog>);
    const dialog = screen.getByRole("dialog", { name: "Preparing workspace" });
    expect(screen.queryByRole("button", { name: /^Close/ })).not.toBeInTheDocument();
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(false);
    expect(dialog).toHaveAttribute("open");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Recovery action" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Recovery action" })).toHaveFocus();
  });

  it("stays open through Strict Mode replay and does not reopen on content updates", () => {
    const onClose = vi.fn();
    const content = (text: string) => <StrictMode>
      <WorkbenchDialog open title="Details" onClose={onClose}><button type="button">{text}</button></WorkbenchDialog>
    </StrictMode>;
    const { rerender, unmount } = render(content("First action"));
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    screen.getByRole("button", { name: "First action" }).focus();
    rerender(content("Updated action"));
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "Updated action" })).toHaveFocus();
    expect(showModal).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe(originalOverflow);
  });

  it.each(["removed", "disabled"] as const)("uses the fallback when the opener is %s", state => {
    const fallback = createRef<HTMLHeadingElement>();
    const content = (open: boolean, unavailable: boolean) => <>
      <h2 ref={fallback} tabIndex={-1}>Page heading</h2>
      {state !== "removed" || !unavailable ? <button type="button" disabled={unavailable}>Open details</button> : null}
      <WorkbenchDialog open={open} title="Details" fallbackFocusRef={fallback} onClose={vi.fn()}>Content</WorkbenchDialog>
    </>;
    const { rerender } = render(content(false, false));
    screen.getByRole("button", { name: "Open details" }).focus();
    rerender(content(true, false));
    rerender(content(true, true));
    rerender(content(false, true));
    expect(screen.getByRole("heading", { name: "Page heading" })).toHaveFocus();
  });

  it("uses the fallback when opened without a focused control", () => {
    const fallback = createRef<HTMLHeadingElement>();
    const content = (open: boolean) => <>
      <h2 ref={fallback} tabIndex={-1}>Page heading</h2>
      <WorkbenchDialog open={open} title="Details" fallbackFocusRef={fallback} onClose={vi.fn()}>Content</WorkbenchDialog>
    </>;
    const { rerender } = render(content(false));
    expect(document.activeElement).toBe(document.body);
    rerender(content(true));
    rerender(content(false));
    expect(screen.getByRole("heading", { name: "Page heading" })).toHaveFocus();
  });

  it.each(["replaced", "mounted"] as const)("uses the current fallback target when it is %s while open", state => {
    const fallback = createRef<HTMLHeadingElement>();
    const content = (open: boolean, updated: boolean) => <>
      {updated ? <h2 key="current" ref={fallback} tabIndex={-1}>Current page heading</h2>
        : state === "replaced" ? <h2 key="previous" ref={fallback} tabIndex={-1}>Previous page heading</h2> : null}
      <WorkbenchDialog open={open} title="Details" fallbackFocusRef={fallback}>Content</WorkbenchDialog>
    </>;
    const { rerender } = render(content(true, false));
    rerender(content(true, true));
    rerender(content(false, true));
    expect(screen.getByRole("heading", { name: "Current page heading" })).toHaveFocus();
  });

  it("updates the fallback ref without reopening or moving focus", () => {
    const previousFallback = createRef<HTMLHeadingElement>();
    const currentFallback = createRef<HTMLHeadingElement>();
    const content = (open: boolean, updated: boolean) => <>
      <h2 ref={previousFallback} tabIndex={-1}>Previous page heading</h2>
      <h2 ref={currentFallback} tabIndex={-1}>Current page heading</h2>
      <WorkbenchDialog open={open} title="Details" fallbackFocusRef={updated ? currentFallback : previousFallback}>
        <button type="button">Dialog action</button>
      </WorkbenchDialog>
    </>;
    const { rerender } = render(content(true, false));
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const action = screen.getByRole("button", { name: "Dialog action" });
    action.focus();
    rerender(content(true, true));
    expect(action).toHaveFocus();
    expect(showModal).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe("hidden");
    rerender(content(false, true));
    expect(screen.getByRole("heading", { name: "Current page heading" })).toHaveFocus();
  });

  it.each(["oldest", "newest"] as const)("keeps scrolling locked when the %s dialog closes first", first => {
    document.body.style.overflow = "scroll";
    const content = (older: boolean, newer: boolean) => <>
      <WorkbenchDialog open={older} title="Older" onClose={vi.fn()}>Older content</WorkbenchDialog>
      <WorkbenchDialog open={newer} title="Newer" onClose={vi.fn()}>Newer content</WorkbenchDialog>
    </>;
    const { rerender } = render(content(true, false));
    rerender(content(true, true));
    expect(document.body.style.overflow).toBe("hidden");
    rerender(content(first === "newest", first === "oldest"));
    expect(screen.getByRole("dialog", { name: first === "oldest" ? "Newer" : "Older" })).toHaveAttribute("open");
    expect(document.body.style.overflow).toBe("hidden");
    rerender(content(false, false));
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("restores scrolling when multiple open dialogs unmount together", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(<StrictMode>
      <WorkbenchDialog open title="Older" onClose={vi.fn()}>Older content</WorkbenchDialog>
      <WorkbenchDialog open title="Newer" onClose={vi.fn()}>Newer content</WorkbenchDialog>
    </StrictMode>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });
});
