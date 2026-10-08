import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useImperativeHandle, useState, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/reportData";
import type { SyncReportRouteState } from "../workbenchRouting";
import { dataSyncRouteSearch, parseSyncReportRoute } from "../workbenchRouting";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import type { OfficialUsageImportHandle } from "./OfficialUsageImportPanel";
import { historySet, reportAgent, reportPage, reports, reportSetId } from "../test/reportDataFixture";
import { mockNativeDialogs } from "../test/dialog";
import { deferred } from "../test/deferred";
import { WorkbenchDialog } from "./WorkbenchDialog";

mockNativeDialogs();
const importMount = vi.hoisted(() => vi.fn());
const importStage = vi.hoisted(() => vi.fn<(onStaged?: (id?: string) => void) => void>());
const importCorrection = vi.hoisted(() => vi.fn());
vi.mock("./OfficialUsageImportPanel", () => ({
  OfficialUsageImportPanel: function TestImportPanel({ ref, initialStagingId, correctionOfSetId, onCancel, onDone, onStaged }: {
    ref: Ref<OfficialUsageImportHandle>; initialStagingId?: string; onCancel: () => void; onDone: (id: string) => void;
    onStaged?: (id?: string) => void; correctionOfSetId?: string;
  }) {
    importMount(initialStagingId);
    importStage(onStaged);
    importCorrection(correctionOfSetId);
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
  importStage.mockClear();
  importCorrection.mockClear();
  vi.spyOn(api, "readReportPage").mockImplementation(async (path, query) => {
    const data = reportPage<unknown>(path === "official-usage/history" ? [historySet()] : [reportAgent()], { counts: { total: 1, filtered: 1 } });
    if (query?.setId) data.reports = { ...data.reports, setId: query.setId };
    return data;
  });
  vi.spyOn(api, "readReportFacet").mockResolvedValue({ value: [], selection: reportPage([]).selection,
    counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null } });
  vi.spyOn(api, "previewReportOperation");
  vi.spyOn(api, "confirmReportOperation");
});

describe("focused report dialogs", () => {
  it.each(["reports", "workbench"] as const)("keeps shared scrolling locked when %s closes before the other dialog", first => {
    const overflow = document.body.style.overflow;
    const content = (reportsOpen: boolean, workbenchOpen: boolean) => <>
      <OfficialUsageImportModal route={reportsOpen ? { view: "import", activityWindowDays: 30 } : undefined}
        onRouteChange={vi.fn()} canManage revision={0} onChanged={vi.fn()} onImported={vi.fn()} />
      <WorkbenchDialog open={workbenchOpen} title="Sync status">Status</WorkbenchDialog>
    </>;
    const { rerender, unmount } = render(content(first === "reports", first === "workbench"));
    try {
      rerender(content(true, true));
      expect(document.body.style.overflow).toBe("hidden");
      rerender(content(first !== "reports", first !== "workbench"));
      expect(document.body.style.overflow).toBe("hidden");
      rerender(content(false, false));
      expect(document.body.style.overflow).toBe(overflow);
    } finally {
      unmount();
      document.body.style.overflow = overflow;
    }
  });

  it("releases all report and workbench locks when their account owner unmounts", () => {
    const overflow = document.body.style.overflow;
    const { unmount } = render(<StrictMode>
      <WorkbenchDialog open title="Sync status">Status</WorkbenchDialog>
      <OfficialUsageImportModal route={{ view: "import", activityWindowDays: 30 }}
        onRouteChange={vi.fn()} canManage revision={0} onChanged={vi.fn()} onImported={vi.fn()} />
    </StrictMode>);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    try {
      expect(document.body.style.overflow).toBe(overflow);
    } finally {
      document.body.style.overflow = overflow;
    }
  });

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
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Sync report actions" }))
      .getByRole("button", { name: expectedAction })).toHaveFocus());
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
    await screen.findByRole("region", { name: "Agent activity report" });
    expect(screen.queryByRole("button", { name: /Refresh snapshot|View current snapshot|Close reports/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(screen.getByRole("dialog", { name: "Manage reports" })).toBeVisible();
    await screen.findByRole("table");
  });

  it("preserves the correction target through serialized navigation without deleting or reloading history", async () => {
    vi.mocked(api.previewReportOperation).mockResolvedValue({
      id: "confirmation", setId: reportSetId, operation: "delete", hash: "a".repeat(64),
      activeRevision: reports.activeRevision, historyRevision: reports.historyRevision, historyEpoch: reports.historyEpoch,
    });
    function RoutedHost() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "manage", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={next => setRoute(parseSyncReportRoute(
        dataSyncRouteSearch({ refreshMode: "delegated", reports: next }).toString(),
      ))} canManage revision={0} onChanged={vi.fn()} onImported={vi.fn()} />;
    }
    render(<RoutedHost />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete report set" }));
    const confirmation = screen.getByRole("dialog", { name: "Delete report set?" });
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Import correction instead" })).toBeEnabled());
    await userEvent.click(within(confirmation).getByRole("button", { name: "Import correction instead" }));
    expect(screen.getByRole("dialog", { name: "Add CSV reports" })).toBeVisible();
    expect(importCorrection).toHaveBeenLastCalledWith(reportSetId);
    expect(importMount).toHaveBeenLastCalledWith(undefined);
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("keeps Viewer imports denied without mounting the importer or an agent locator", async () => {
    render(<OfficialUsageImportModal route={{ view: "import", activityWindowDays: 30 }}
      onRouteChange={vi.fn()} canManage={false} revision={0} onChanged={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Manage reports" })).toHaveTextContent("An administrator is required");
    await screen.findByRole("table");
    expect(importMount).not.toHaveBeenCalled();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(vi.mocked(api.readReportPage).mock.calls.every(([path]) => path === "official-usage/history")).toBe(true);
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
    expect(vi.mocked(api.readReportPage).mock.calls.filter(([path]) => path === "official-usage/history")).toHaveLength(2);
  });

  it("does not let a queued close dismiss a reopened draft or its replacement account owner", async () => {
    vi.useFakeTimers();
    const props = { onRouteChange: vi.fn(), canManage: true, revision: 0, onChanged: vi.fn(), onImported: vi.fn() };
    const route: SyncReportRouteState = { view: "import", activityWindowDays: 30 };
    const content = (open: boolean, owner = "first") => <OfficialUsageImportModal key={owner} {...props} route={open ? route : undefined} />;
    const { rerender, unmount } = render(content(true));
    try {
      fireEvent.change(screen.getByLabelText("Selected import draft"), { target: { value: "Private draft" } });
      rerender(content(false));
      rerender(content(true));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("dialog")).toHaveAttribute("open");
      expect(screen.getByLabelText("Selected import draft")).toHaveValue("");
      rerender(content(false));
      rerender(content(true, "replacement"));
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("dialog")).toHaveAttribute("open");
      expect(screen.getByLabelText("Selected import draft")).toHaveValue("");
      expect(props.onRouteChange).not.toHaveBeenCalled();
      expect(api.readReportPage).not.toHaveBeenCalled();
      expect(document.body.style.overflow).toBe("hidden");
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("passes explicit staging and report-window links without silently substituting defaults", async () => {
    const props = { onRouteChange: vi.fn(), canManage: true, revision: 0, onChanged: vi.fn(), onImported: vi.fn() };
    const view = render(<OfficialUsageImportModal {...props} route={{ view: "import", stagingId: "exact-stage", activityWindowDays: 7 }} />);
    expect(importMount).toHaveBeenLastCalledWith("exact-stage");
    await act(async () => view.rerender(<OfficialUsageImportModal {...props}
      route={{ view: "snapshot", reportSetId, activityWindowDays: 7 }} />));
    await screen.findByRole("region", { name: "Agent activity report" });
    expect(api.readReportPage).toHaveBeenCalledWith("official-usage/aggregate", expect.objectContaining({ setId: reportSetId, activityWindowDays: 7 }), expect.any(AbortSignal));
    expect(screen.queryByLabelText("Selected import draft")).not.toBeInTheDocument();
  });

  it("preserves owned input when saving or clearing its resume link and rejects retired draft callbacks", async () => {
    const props = { onRouteChange: vi.fn(), canManage: true, revision: 0, onChanged: vi.fn(), onImported: vi.fn() };
    const route: SyncReportRouteState = { view: "import", activityWindowDays: 30 };
    const view = render(<OfficialUsageImportModal {...props} route={route} />);
    const input = screen.getByLabelText("Selected import draft");
    fireEvent.change(input, { target: { value: "owned draft" } });
    act(() => importStage.mock.lastCall?.[0]?.("owned-stage"));
    expect(props.onRouteChange).toHaveBeenLastCalledWith({ ...route, stagingId: "owned-stage" });
    view.rerender(<OfficialUsageImportModal {...props} revision={1} route={{ ...route, stagingId: "owned-stage" }} />);
    expect(screen.getByLabelText("Selected import draft")).toBe(input);
    expect(input).toHaveValue("owned draft");
    expect(importMount).toHaveBeenLastCalledWith(undefined);
    act(() => importStage.mock.lastCall?.[0]?.(undefined));
    expect(props.onRouteChange).toHaveBeenLastCalledWith({ ...route, stagingId: undefined });
    view.rerender(<OfficialUsageImportModal {...props} revision={1} route={route} />);
    expect(input).toHaveValue("owned draft");
    const retired = importStage.mock.lastCall?.[0];
    view.rerender(<OfficialUsageImportModal {...props} route={{ ...route, stagingId: "external-stage" }} />);
    expect(screen.getByLabelText("Selected import draft")).toHaveValue("");
    expect(importMount).toHaveBeenLastCalledWith("external-stage");
    const calls = props.onRouteChange.mock.calls.length;
    act(() => retired?.("late-stage"));
    expect(props.onRouteChange).toHaveBeenCalledTimes(calls);
    expect(api.readReportPage).not.toHaveBeenCalled();
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(props.onImported).not.toHaveBeenCalled();
  });

  it.each(["close", "revision"] as const)("retires pending report history on %s without admitting its late response", async transition => {
    const pending = deferred<ReturnType<typeof reportPage<unknown>>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const props = { onRouteChange: vi.fn(), canManage: false, revision: 0, onChanged: vi.fn(), onImported: vi.fn() };
    const route: SyncReportRouteState = { view: "manage", activityWindowDays: 30 };
    const view = render(<OfficialUsageImportModal {...props} route={route} />);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.calls[0][2];
    view.rerender(<OfficialUsageImportModal {...props} route={{ ...route }} />);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    if (transition === "close") {
      view.rerender(<OfficialUsageImportModal {...props} />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      view.rerender(<OfficialUsageImportModal {...props} route={route} />);
    } else view.rerender(<OfficialUsageImportModal {...props} route={route} revision={1} />);
    expect(signal?.aborted).toBe(true);
    await screen.findByRole("table");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    const abandoned = historySet(2);
    await act(async () => pending.resolve(reportPage([abandoned])));
    expect(screen.queryByText(abandoned.id)).not.toBeInTheDocument();
    expect(screen.getByText(reportSetId)).toBeVisible();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(props.onChanged).not.toHaveBeenCalled();
  });
});
