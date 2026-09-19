import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { mockNativeDialogs } from "../test/dialog";

mockNativeDialogs();

vi.mock("./OfficialUsageImportPanel", () => ({
  OfficialUsageImportPanel: () => <div>Authoritative import panel</div>,
}));

describe("OfficialUsageImportModal", () => {
  it("returns a deep-linked import dialog to its live external report trigger", async () => {
    const trigger = createRef<HTMLButtonElement>();
    render(<>
      <button ref={trigger}>Report import trigger</button>
      <OfficialUsageImportModal showTrigger={false} initialStagingId="retained-staging" returnFocusRef={trigger} onChanged={vi.fn()} />
    </>);
    const dialog = await screen.findByRole("dialog", { name: "Import and manage reports" });
    await userEvent.click(screen.getByRole("button", { name: "Close report import" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(screen.getByRole("button", { name: "Report import trigger" })).toHaveFocus();
  });

  it("prefers the actual connected opener to the fallback report trigger", async () => {
    function Host() {
      const [request, setRequest] = useState(0);
      const trigger = createRef<HTMLButtonElement>();
      return <>
        <button ref={trigger}>Report import trigger</button>
        <button onClick={() => setRequest(value => value + 1)}>Sync import trigger</button>
        <OfficialUsageImportModal showTrigger={false} openRequest={request} returnFocusRef={trigger} onChanged={vi.fn()} />
      </>;
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Sync import trigger" });
    await userEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Import and manage reports" });
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(opener).toHaveFocus();
  });

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
