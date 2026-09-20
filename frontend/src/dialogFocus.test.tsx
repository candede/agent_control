import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("preserves backward navigation from a disclosure between other controls", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button>First</button>
      <details><summary>More details</summary><p>Details</p></details>
      <button>Last</button>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const summary = screen.getByText("More details");
    const preventDefault = vi.fn();
    summary.focus();
    expect(summary).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(summary).toHaveFocus();
  });

  it("wraps at a closed disclosure, excluding its hidden and nested controls", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button>First</button>
      <details>
        <summary>More details</summary>
        <button>Hidden action</button>
        <details><summary>Nested details</summary><button>Nested action</button></details>
      </details>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const first = screen.getByRole("button", { name: "First" });
    const summary = screen.getByText("More details");
    const preventDefault = vi.fn();
    first.focus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(summary).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(first).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("includes controls in an open disclosure and its summary when wrapping", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <details open>
        <summary>More details</summary>
        <button>Details action</button>
      </details>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const summary = screen.getByText("More details");
    const action = screen.getByRole("button", { name: "Details action" });
    const preventDefault = vi.fn();
    action.focus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(summary).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(action).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it.each([-1, -2])("excludes native controls and generic elements with tabIndex %s", tabIndex => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button tabIndex={tabIndex}>Programmatic button</button>
      <a href="#target" tabIndex={tabIndex}>Programmatic link</a>
      <input aria-label="Programmatic input" tabIndex={tabIndex} />
      <select aria-label="Programmatic select" tabIndex={tabIndex}><option>Value</option></select>
      <textarea aria-label="Programmatic textarea" tabIndex={tabIndex} />
      <button>Only tab stop</button>
      <div tabIndex={tabIndex}>Programmatic container</div>
      <details><summary tabIndex={tabIndex}>Programmatic summary</summary></details>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const button = screen.getByRole("button", { name: "Only tab stop" });
    const preventDefault = vi.fn();
    button.focus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(button).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(button).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("excludes controls disabled by a fieldset but retains its first legend's controls", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button>First</button>
      <fieldset disabled>
        <legend><button>Legend action</button></legend>
        <button>Inherited disabled action</button>
        <input aria-label="Inherited disabled input" />
        <legend><button>Second legend action</button></legend>
      </fieldset>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const first = screen.getByRole("button", { name: "First" });
    const legendAction = screen.getByRole("button", { name: "Legend action" });
    const preventDefault = vi.fn();
    first.focus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(legendAction).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(first).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("excludes CSS-hidden controls and hidden inputs even with an explicit tabIndex", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button style={{ display: "none" }}>Hidden first</button>
      <button>Only tab stop</button>
      <div style={{ display: "none" }}><button>Hidden by ancestor</button></div>
      <button style={{ visibility: "hidden" }}>Invisible</button>
      <div style={{ visibility: "hidden" }}><button>Invisible by ancestor</button></div>
      <button style={{ visibility: "collapse" }}>Collapsed</button>
      <input type="hidden" tabIndex={0} style={{ display: "block" }} />
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const button = screen.getByRole("button", { name: "Only tab stop" });
    const preventDefault = vi.fn();
    button.focus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(button).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(button).toHaveFocus();
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("retains visible descendants of visibility-hidden and display-contents wrappers", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button>First</button>
      <div style={{ visibility: "hidden" }}>
        <div style={{ display: "contents" }}><button style={{ visibility: "visible" }}>Visible action</button></div>
      </div>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const first = screen.getByRole("button", { name: "First" });
    const visible = screen.getByRole("button", { name: "Visible action" });
    const preventDefault = vi.fn();
    first.focus();
    trapDialogFocus({ key: "Tab", shiftKey: true, preventDefault }, dialog);
    expect(visible).toHaveFocus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(first).toHaveFocus();
  });

  it("wraps in tabIndex order while preserving native navigation between boundaries", async () => {
    const user = userEvent.setup();
    render(<>
      <button>Outside before</button>
      <section aria-label="Test dialog" tabIndex={-1} onKeyDown={event => trapDialogFocus(event, event.currentTarget)}>
        <button>Default first</button>
        <button tabIndex={2}>Priority two</button>
        <button tabIndex={1}>Priority one</button>
        <button tabIndex={2}>Priority two peer</button>
        <button>Default last</button>
      </section>
      <button>Outside after</button>
    </>);
    const order = ["Priority one", "Priority two", "Priority two peer", "Default first", "Default last"];
    screen.getByRole("button", { name: order[0] }).focus();
    for (const name of [...order.slice(1), order[0]]) {
      await user.tab();
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
    for (const name of [...order.slice(1).reverse(), order[0]]) {
      await user.tab({ shift: true });
      expect(screen.getByRole("button", { name })).toHaveFocus();
    }
  });

  it.each([false, true])("recovers from a programmatic focus target at the boundary (shift: %s)", async shiftKey => {
    const user = userEvent.setup();
    render(<>
      <section aria-label="Test dialog" tabIndex={-1} onKeyDown={event => trapDialogFocus(event, event.currentTarget)}>
        <h2 tabIndex={-1}>Heading</h2>
        <button>First</button>
        <button>Last</button>
        <p tabIndex={-1}>Status</p>
      </section>
      <button>Outside</button>
    </>);
    screen.getByText(shiftKey ? "Heading" : "Status").focus();
    await user.tab({ shift: shiftKey });
    expect(screen.getByRole("button", { name: shiftKey ? "Last" : "First" })).toHaveFocus();
  });

  it("falls back to the container when no sequentially focusable controls remain", () => {
    render(<section aria-label="Test dialog" tabIndex={-1}>
      <button tabIndex={-1}>Programmatic action</button>
      <fieldset disabled><button>Disabled action</button></fieldset>
      <button style={{ display: "none" }}>Hidden action</button>
    </section>);
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const preventDefault = vi.fn();
    for (const shiftKey of [false, true]) {
      trapDialogFocus({ key: "Tab", shiftKey, preventDefault }, dialog);
      expect(dialog).toHaveFocus();
    }
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it.each(["first", "last", "none"])("wraps a radio group as one tab stop when %s is checked", async checked => {
    const user = userEvent.setup();
    render(<>
      <section aria-label="Test dialog" tabIndex={-1} onKeyDown={event => trapDialogFocus(event, event.currentTarget)}>
        <input type="radio" name="choice" aria-label="First choice" defaultChecked={checked === "first"} />
        <input type="radio" name="choice" aria-label="Last choice" defaultChecked={checked === "last"} />
      </section>
      <button>Outside</button>
    </>);
    const radio = screen.getByRole("radio", { name: checked === "last" ? "Last choice" : "First choice" });
    radio.focus();
    await user.tab();
    expect(radio).toHaveFocus();
    await user.tab({ shift: true });
    expect(radio).toHaveFocus();
  });

  it("keeps radio groups in different forms and unnamed radios independent", async () => {
    const user = userEvent.setup();
    render(<section aria-label="Test dialog" tabIndex={-1} onKeyDown={event => trapDialogFocus(event, event.currentTarget)}>
      <form>
        <input type="radio" name="choice" aria-label="Form one selected" defaultChecked />
        <input type="radio" name="choice" aria-label="Form one unselected" />
      </form>
      <form>
        <input type="radio" name="choice" aria-label="Form two unselected" />
        <input type="radio" name="choice" aria-label="Form two selected" defaultChecked />
      </form>
      <input type="radio" aria-label="Unnamed first" />
      <input type="radio" aria-label="Unnamed last" />
    </section>);
    const first = screen.getByRole("radio", { name: "Form one selected" });
    const last = screen.getByRole("radio", { name: "Unnamed last" });
    const dialog = screen.getByRole("region", { name: "Test dialog" });
    const preventDefault = vi.fn();
    last.focus();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, dialog);
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("radio", { name: "Unnamed first" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("radio", { name: "Form two selected" })).toHaveFocus();
  });

  it("ignores a missing dialog without cancelling Tab", () => {
    const preventDefault = vi.fn();
    trapDialogFocus({ key: "Tab", shiftKey: false, preventDefault }, null);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
