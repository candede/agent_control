import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentColumnPicker } from "./AgentColumnPicker";

const columns: ComponentProps<typeof AgentColumnPicker>["columns"] = [
  { id: "displayName", label: "Agent", group: "Overview", visible: true, canHide: false },
  { id: "hosts", label: "Hosts", group: "Overview", visible: false, canHide: true, description: "Supported hosts" },
  { id: "responses", label: "Responses", group: "Usage", visible: true, canHide: true },
];

describe("AgentColumnPicker", () => {
  it("focuses search, filters without mutations, and uses the latest controlled choices and callbacks", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn(), onReset = vi.fn();
    const { rerender } = render(<AgentColumnPicker columns={columns} onToggle={onToggle} onReset={onReset} />);
    const trigger = screen.getByRole("button", { name: "Columns" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Choose agent columns" });
    expect(trigger).toHaveAttribute("aria-controls", dialog.id);
    const search = within(dialog).getByRole("searchbox", { name: "Find columns" });
    expect(search).toHaveFocus();
    const identity = within(dialog).getByRole("checkbox", { name: "Agent Always shown" });
    expect(identity).toBeChecked();
    expect(identity).toBeDisabled();
    await user.click(identity);
    await user.type(search, "  hOsT  ");
    expect(within(dialog).getAllByRole("group")).toHaveLength(1);
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    const hosts = within(dialog).getByRole("checkbox", { name: "Hosts" });
    expect(hosts).not.toBeChecked();
    expect(hosts.closest("label")).toHaveAttribute("title", "Supported hosts");
    expect(onToggle).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
    await user.click(hosts);
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("hosts");
    expect(hosts).not.toBeChecked();

    const nextToggle = vi.fn(), nextReset = vi.fn();
    rerender(<AgentColumnPicker columns={columns.map(column => column.id === "hosts" ? { ...column, visible: true } : column)}
      onToggle={nextToggle} onReset={nextReset} />);
    expect(screen.getByRole("searchbox", { name: "Find columns" })).toBe(search);
    expect(hosts).toBeChecked();
    await user.click(hosts);
    expect(nextToggle).toHaveBeenCalledExactlyOnceWith("hosts");
    expect(onToggle).toHaveBeenCalledTimes(1);
    await user.clear(search);
    await user.type(search, "No matching column");
    expect(screen.getByText("No columns match your search.")).toBeVisible();
    expect(within(dialog).queryByRole("group")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Reset defaults" }));
    expect(nextReset).toHaveBeenCalledTimes(1);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("dismisses by keyboard, close button, trigger, or outside pointer without changing columns", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn(), onReset = vi.fn();
    render(<><AgentColumnPicker columns={columns} onToggle={onToggle} onReset={onReset} />
      <button type="button">Outside</button></>);
    const trigger = screen.getByRole("button", { name: "Columns" });
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Close column picker" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it("keeps internal keyboard focus and closes when tabbing outside", async () => {
    const user = userEvent.setup();
    render(<><AgentColumnPicker columns={columns} onToggle={vi.fn()} onReset={vi.fn()} />
      <button type="button">Outside</button></>);
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Hosts" })).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.tab();
    expect(screen.getByRole("checkbox", { name: "Responses" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Reset defaults" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("cleans up document dismissal listeners after closing and unmounting in Strict Mode", () => {
    const { unmount } = render(<StrictMode><AgentColumnPicker columns={columns} onToggle={vi.fn()} onReset={vi.fn()} /></StrictMode>);
    const trigger = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(trigger);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(document, escape);
    expect(escape.defaultPrevented).toBe(true);
    const closedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(document, closedEscape);
    expect(closedEscape.defaultPrevented).toBe(false);
    fireEvent.click(trigger);
    unmount();
    const unmountedEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    fireEvent(document, unmountedEscape);
    expect(unmountedEscape.defaultPrevented).toBe(false);
  });
});
