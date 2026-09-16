import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { mockNativeDialogs } from "../test/dialog";

mockNativeDialogs();

vi.mock("./OfficialUsageImportPanel", () => ({
  OfficialUsageImportPanel: () => <div>Authoritative import panel</div>,
}));

describe("OfficialUsageImportModal", () => {
  it("opens from the native trigger, closes, and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Import reports" });
    expect(screen.queryByText("Authoritative import panel")).not.toBeInTheDocument();

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Import and manage reports" });
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("Authoritative import panel")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Close report import" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(trigger).toHaveFocus();
  });

  it("opens once per external request and resets closed state on a principal-key remount", async () => {
    const props = { showTrigger: false, onChanged: vi.fn() };
    const view = render(<OfficialUsageImportModal key="principal-one" {...props} openRequest={0} />);
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).not.toHaveAttribute("open");

    view.rerender(<OfficialUsageImportModal key="principal-one" {...props} openRequest={1} />);
    await waitFor(() => expect(dialog).toHaveAttribute("open"));
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));

    view.rerender(<OfficialUsageImportModal key="principal-one" {...props} openRequest={1} />);
    expect(dialog).not.toHaveAttribute("open");

    view.rerender(<OfficialUsageImportModal key="principal-two" {...props} openRequest={1} />);
    const remountedDialog = screen.getByRole("dialog", { hidden: true });
    expect(remountedDialog).not.toHaveAttribute("open");
    expect(screen.queryByText("Authoritative import panel")).not.toBeInTheDocument();
  });
});
