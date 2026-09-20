import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { trapDialogFocus } from "./dialogFocus";

describe("dialog focus boundaries", () => {
  it("wraps both ends and excludes disabled, hidden, and inert controls", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <h2 tabIndex={-1}>Dialog heading</h2>
      <button>First</button>
      <button>Last</button>
      <button disabled>Disabled</button>
      <div hidden><button>Hidden</button></div>
      <div inert><button>Inert</button></div>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const preventDefault = vi.fn();
    screen.getByRole("button", { name: "Last" }).focus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    screen.getByRole("heading").focus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it("focuses an empty container without intercepting ordinary keys", () => {
    render(<section aria-label="Test dialog" tabIndex={-1} />);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const preventDefault = vi.fn();
    trapDialogFocus({ key: "Enter", shiftKey: false, preventDefault }, dialog);
    expect(preventDefault).not.toHaveBeenCalled();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(dialog).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
