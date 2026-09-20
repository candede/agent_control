import { StrictMode, createRef } from "react";
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
