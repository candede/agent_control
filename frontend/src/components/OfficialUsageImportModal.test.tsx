import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { mockNativeDialogs } from "../test/dialog";

mockNativeDialogs();

vi.mock("./OfficialUsageImportPanel", () => ({
  OfficialUsageImportPanel: function TestImportPanel({ view, active, onViewSnapshot }: {
    view: string; active: boolean; onViewSnapshot?: (setId: string) => void;
  }) {
    const [draft, setDraft] = useState("");
    return <div>Authoritative import panel<span data-testid="panel-view">{view}</span><span data-testid="panel-active">{String(active)}</span>
      <input aria-label="Selected import draft" value={draft} onChange={event => setDraft(event.target.value)} />
      {onViewSnapshot ? <button type="button" onClick={() => onViewSnapshot("retained-snapshot")}>View fixture snapshot</button> : null}
    </div>;
  },
}));

describe("OfficialUsageImportModal", () => {
  it("returns a deep-linked import dialog to its live external report trigger", async () => {
    const trigger = createRef<HTMLButtonElement>();
    render(<>
      <button ref={trigger}>Report import trigger</button>
      <OfficialUsageImportModal showTrigger={false} initialStagingId="retained-staging" returnFocusRef={trigger} onChanged={vi.fn()} />
    </>);
    const dialog = await screen.findByRole("dialog", { name: "Import CSV reports" });
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
    const dialog = await screen.findByRole("dialog", { name: "Import CSV reports" });
    await userEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(opener).toHaveFocus();
  });

  it("opens from the native trigger, closes, and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Import reports" });
    expect(screen.queryByText("Authoritative import panel")).not.toBeInTheDocument();

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Import CSV reports" });
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
    await userEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));

    view.rerender(<OfficialUsageImportModal key="principal-one" {...props} openRequest={1} />);
    expect(dialog).not.toHaveAttribute("open");

    view.rerender(<OfficialUsageImportModal key="principal-two" {...props} openRequest={1} />);
    const remountedDialog = screen.getByRole("dialog", { hidden: true });
    expect(remountedDialog).not.toHaveAttribute("open");
    expect(screen.queryByText("Authoritative import panel")).not.toBeInTheDocument();
  });

  it("preserves importer state across close/reopen, traps keyboard boundaries, and restores scrolling on Escape", async () => {
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Import reports" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Import CSV reports" });
    await userEvent.type(screen.getByLabelText("Selected import draft"), "retained draft");
    const close = screen.getByRole("button", { name: "Close report import" });
    const back = screen.getByRole("button", { name: /^Close$/ });
    close.focus();
    await userEvent.tab({ shift: true });
    expect(back).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    expect(screen.getByLabelText("Selected import draft")).toHaveValue("retained draft");
  });

  it("applies openView only to new open requests and preserves the draft between sibling views", async () => {
    const props = { showTrigger: false, onChanged: vi.fn() };
    const view = render(<OfficialUsageImportModal {...props} openRequest={0} />);
    view.rerender(<OfficialUsageImportModal {...props} openRequest={1} openView="manage" />);
    expect(await screen.findByRole("dialog", { name: "Manage reports" })).toBeVisible();
    expect(screen.getByTestId("panel-view")).toHaveTextContent("manage");
    await userEvent.type(screen.getByLabelText("Selected import draft"), "kept");
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    view.rerender(<OfficialUsageImportModal {...props} openRequest={1} openView="manage" />);
    expect(screen.getByRole("dialog", { name: "Import CSV reports" })).toBeVisible();
    expect(screen.getByTestId("panel-view")).toHaveTextContent("import");
    view.rerender(<OfficialUsageImportModal {...props} openRequest={2} openView="manage" />);
    expect(await screen.findByRole("dialog", { name: "Manage reports" })).toBeVisible();
    expect(screen.getByLabelText("Selected import draft")).toHaveValue("kept");
    await userEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(screen.getByTestId("panel-active")).toHaveTextContent("false");
    view.rerender(<OfficialUsageImportModal {...props} openRequest={2} openView="import" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the native dialog before navigating to a retained snapshot", async () => {
    const onViewSnapshot = vi.fn(() => {
      expect(screen.getByRole("dialog", { hidden: true })).not.toHaveAttribute("open");
    });
    render(<OfficialUsageImportModal onChanged={vi.fn()} onViewSnapshot={onViewSnapshot} />);
    const trigger = screen.getByRole("button", { name: "Import reports" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "View fixture snapshot" }));
    expect(onViewSnapshot).toHaveBeenCalledExactlyOnceWith("retained-snapshot");
    expect(trigger).toHaveFocus();
  });
});
