import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useImperativeHandle, useState, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import type { SyncReportRouteState } from "../workbenchRouting";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import type { OfficialUsageImportHandle } from "./OfficialUsageImportPanel";
import { usageAggregateFixture } from "../test/usageInsightsFixture";
import { mockNativeDialogs } from "../test/dialog";
import { reportHistoryFixture } from "./reportHistoryFixture";

mockNativeDialogs();
const importMount = vi.hoisted(() => vi.fn());
vi.mock("./OfficialUsageImportPanel", () => ({
  OfficialUsageImportPanel: function TestImportPanel({ ref, initialStagingId, onCancel, onDone }: {
    ref: Ref<OfficialUsageImportHandle>; initialStagingId?: string; onCancel: () => void; onDone: (id: string) => void;
  }) {
    importMount(initialStagingId);
    const [draft, setDraft] = useState("");
    useImperativeHandle(ref, () => ({ dismiss: onCancel }));
    return <div>
      <input aria-label="Selected import draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={onCancel}>Cancel</button>
      <button onClick={() => onDone("imported-set")}>OK</button>
    </div>;
  },
}));

function Host({ canManage = true }: { canManage?: boolean }) {
  const [route, setRoute] = useState<SyncReportRouteState>();
  return <>
    <button onClick={() => setRoute({ view: canManage ? "import" : "manage", activityWindowDays: 30 })}>Open reports</button>
    <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage={canManage}
      revision={0} onChanged={vi.fn()} onImported={vi.fn()} />
  </>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  importMount.mockClear();
  vi.spyOn(api, "getOfficialUsageAggregate").mockImplementation(async query => {
    const data = usageAggregateFixture();
    if (query?.setId) data.activeSet!.id = query.setId;
    return data;
  });
  vi.spyOn(api, "getOfficialUsageHistory").mockResolvedValue(reportHistoryFixture());
  vi.spyOn(api, "getOfficialUsageOverview");
  vi.spyOn(api, "getOfficialUsageAdminState");
});

describe("focused report dialogs", () => {
  it.each([
    ["import", true, "Add CSV reports"],
    ["manage", true, "Manage reports"],
    ["snapshot", true, "Manage reports"],
    ["import", false, "Manage reports"],
  ] as const)("restores direct-linked %s (admin=%s) focus to %s", async (initialView, canManage, expectedAction) => {
    function DirectLinkHost() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: initialView, activityWindowDays: 30 });
      return <>
        <section className="data-sync-reports" aria-label="Sync report actions">
          {canManage ? <button>Add CSV reports</button> : null}<button>Manage reports</button>
        </section>
        <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage={canManage}
          revision={0} onChanged={vi.fn()} onImported={vi.fn()} />
      </>;
    }
    render(<DirectLinkHost />);
    const dialog = screen.getByRole("dialog");
    if (initialView === "snapshot") await userEvent.click(within(dialog).getByRole("button", { name: "Back to reports" }));
    await userEvent.click(within(dialog).getByRole("button", { name: initialView === "import" && canManage ? "Cancel" : "Close reports" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(within(screen.getByRole("region", { name: "Sync report actions" })).getByRole("button", { name: expectedAction })).toHaveFocus();
  });

  it("restores the actual opener, unlocks scrolling, and unmounts a cancelled import", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open reports" });
    await userEvent.click(opener);
    await userEvent.type(screen.getByLabelText("Selected import draft"), "old draft");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(screen.queryByLabelText("Selected import draft")).not.toBeInTheDocument();
    await userEvent.click(opener);
    expect(screen.getByLabelText("Selected import draft")).toHaveValue("");
  });

  it("has no duplicate close button or internal wizard tabs in Add CSV reports", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    const dialog = screen.getByRole("dialog", { name: "Add CSV reports" });
    expect(within(dialog).queryByRole("button", { name: /Close|Manage reports|Add CSV reports/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "Report workflow" })).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("Closing keeps your draft");
  });

  it("traps keyboard focus within the current dialog", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    const input = screen.getByLabelText("Selected import draft");
    input.focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "OK" })).toHaveFocus();
    await userEvent.tab();
    expect(input).toHaveFocus();
  });

  it("closes the import and notifies the application only when OK is clicked", async () => {
    const onRouteChange = vi.fn();
    const onImported = vi.fn();
    render(<OfficialUsageImportModal route={{ view: "import", activityWindowDays: 30 }}
      onRouteChange={onRouteChange} canManage revision={0} onChanged={vi.fn()} onImported={onImported} />);
    expect(onImported).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onRouteChange).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(onImported).toHaveBeenCalledOnce();
  });

  it("offers Add CSV reports from management, starting a new import rather than reusing a staging link", async () => {
    function RoutedHost() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "manage", stagingId: "old-stage", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage
        revision={0} onChanged={vi.fn()} onImported={vi.fn()} />;
    }
    render(<RoutedHost />);
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    expect(screen.getByRole("dialog", { name: "Add CSV reports" })).toBeVisible();
    expect(importMount).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps report inspection read-only in the same dialog and returns to the report list", async () => {
    function RoutedHost() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "manage", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage
        revision={0} onChanged={vi.fn()} onImported={vi.fn()} />;
    }
    render(<RoutedHost />);
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    expect(screen.getByRole("dialog", { name: "Report details" })).toBeVisible();
    await screen.findByRole("region", { name: "Snapshot tenant totals" });
    expect(screen.queryByRole("button", { name: /Refresh snapshot|View current snapshot|Close reports/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(screen.getByRole("dialog", { name: "Manage reports" })).toBeVisible();
    await screen.findByRole("table");
  });

  it("keeps Viewer imports denied without mounting the importer or an agent locator", async () => {
    render(<OfficialUsageImportModal route={{ view: "import", activityWindowDays: 30 }}
      onRouteChange={vi.fn()} canManage={false} revision={0} onChanged={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Manage reports" })).toHaveTextContent("An administrator is required");
    await screen.findByRole("table");
    expect(importMount).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAdminState).not.toHaveBeenCalled();
    expect(api.getOfficialUsageOverview).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Add CSV|Delete/ })).not.toBeInTheDocument();
  });

  it("unmounts report data on close and reloads it on reopening", async () => {
    render(<Host canManage={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    expect(screen.queryByRole("table", { hidden: true })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    await screen.findByRole("table");
    expect(api.getOfficialUsageHistory).toHaveBeenCalledTimes(2);
  });

  it("passes explicit staging and report-window links without silently substituting defaults", async () => {
    const props = { onRouteChange: vi.fn(), canManage: true, revision: 0, onChanged: vi.fn(), onImported: vi.fn() };
    const view = render(<OfficialUsageImportModal {...props} route={{ view: "import", stagingId: "exact-stage", activityWindowDays: 7 }} />);
    expect(importMount).toHaveBeenLastCalledWith("exact-stage");
    await act(async () => view.rerender(<OfficialUsageImportModal {...props}
      route={{ view: "snapshot", reportSetId: "exact-report", activityWindowDays: 7 }} />));
    await screen.findByRole("region", { name: "Snapshot tenant totals" });
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledWith(expect.objectContaining({ setId: "exact-report", activityWindowDays: 7 }), expect.anything());
    expect(screen.queryByLabelText("Selected import draft")).not.toBeInTheDocument();
  });
});
