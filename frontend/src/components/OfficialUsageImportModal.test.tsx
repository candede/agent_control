import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import type { SyncReportRouteState } from "../workbenchRouting";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { usageAggregateFixture, usageOverviewFixture } from "../test/usageInsightsFixture";
import { mockNativeDialogs } from "../test/dialog";
import { reportHistoryFixture } from "./reportHistoryFixture";

mockNativeDialogs();
const importMount = vi.hoisted(() => vi.fn());
vi.mock("./OfficialUsageImportPanel", () => ({
  OfficialUsageImportPanel: function TestImportPanel({ view, active, onViewSnapshot }: {
    view: string; active: boolean; onViewSnapshot: (setId: string) => void;
  }) {
    importMount();
    const [draft, setDraft] = useState("");
    return <div>Authoritative import panel<span data-testid="panel-view">{view}</span><span data-testid="panel-active">{String(active)}</span>
      <input aria-label="Selected import draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button type="button" onClick={() => onViewSnapshot("retained-snapshot")}>View fixture snapshot</button>
    </div>;
  },
}));

function Host({ canManage = true }: { canManage?: boolean }) {
  const [route, setRoute] = useState<SyncReportRouteState>();
  return <>
    <button onClick={() => setRoute({ view: canManage ? "import" : "manage", activityWindowDays: 7 })}>Open reports</button>
    <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage={canManage} revision={0} onChanged={vi.fn()} />
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
  vi.spyOn(api, "getOfficialUsageOverview").mockResolvedValue(usageOverviewFixture());
  vi.spyOn(api, "getOfficialUsageAdminState").mockRejectedValue(new Error("Viewer must not request administration."));
});

describe("controlled Sync report dialog", () => {
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
          {canManage ? <button>Add CSV reports</button> : null}
          <button>Manage reports</button>
        </section>
        <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage={canManage} revision={0} onChanged={vi.fn()} />
      </>;
    }
    render(<DirectLinkHost />);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(screen.getByRole("button", { name: expectedAction })).toHaveFocus();
  });

  it("prefers the connected actual opener over the direct-link fallback", async () => {
    render(<>
      <section className="data-sync-reports"><button>Add CSV reports</button><button>Manage reports</button></section>
      <Host />
    </>);
    const opener = screen.getByRole("button", { name: "Open reports" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    expect(opener).toHaveFocus();
  });

  it("uses the last report view as a fallback when the original opener was removed", async () => {
    function RemovableOpenerHost() {
      const [route, setRoute] = useState<SyncReportRouteState>();
      const [opened, setOpened] = useState(false);
      return <>
        <section className="data-sync-reports" aria-label="Sync report actions"><button>Add CSV reports</button><button>Manage reports</button></section>
        {!opened ? <button onClick={() => { setOpened(true); setRoute({ view: "import", activityWindowDays: 30 }); }}>Temporary opener</button> : null}
        <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0} onChanged={vi.fn()} />
      </>;
    }
    render(<RemovableOpenerHost />);
    await userEvent.click(screen.getByRole("button", { name: "Temporary opener" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Manage reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    expect(screen.getByRole("button", { name: "Manage reports" })).toHaveFocus();
  });

  it("falls back to the CSV reports heading when report actions are unavailable", async () => {
    function LoadingSyncHost() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "import", activityWindowDays: 30 });
      return <>
        <h2 id="sync-reports-heading" tabIndex={-1}>CSV usage reports</h2>
        <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0} onChanged={vi.fn()} />
      </>;
    }
    render(<LoadingSyncHost />);
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    expect(screen.getByRole("heading", { name: "CSV usage reports" })).toHaveFocus();
  });

  it("has no internal trigger and reports route closure without owning open state", async () => {
    const onRouteChange = vi.fn();
    const props = { onRouteChange, canManage: true, revision: 0, onChanged: vi.fn() };
    const view = render(<OfficialUsageImportModal {...props} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(importMount).not.toHaveBeenCalled();
    view.rerender(<OfficialUsageImportModal {...props} route={{ view: "manage", activityWindowDays: 30 }} />);
    const dialog = await screen.findByRole("dialog", { name: "Manage reports" });
    await userEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(onRouteChange).toHaveBeenCalledWith(undefined);
    expect(dialog).toHaveAttribute("open");
    view.rerender(<OfficialUsageImportModal {...props} />);
    expect(dialog).not.toHaveAttribute("open");
  });

  it("preserves drafts across close and sibling views, traps focus, and restores the actual opener", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open reports" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    await userEvent.type(screen.getByLabelText("Selected import draft"), "kept draft");
    screen.getByRole("button", { name: "Close reports" }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: /^Close$/ })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close reports" })).toHaveFocus();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(screen.getByTestId("panel-active")).toHaveTextContent("false");
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getByLabelText("Selected import draft")).toHaveValue("kept draft");
  });

  it("keeps source inspection in the same dialog, with back and current routes", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "View fixture snapshot" }));
    expect(await screen.findByRole("heading", { name: "Report agent rows" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Report snapshot" })).toBe(dialog);
    expect(screen.getByRole("button", { name: "Close reports" })).toHaveFocus();
    expect(screen.getByTestId("panel-active")).toHaveTextContent("false");
    expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ setId: "retained-snapshot", activityWindowDays: 365 }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "View current snapshot" }));
    await waitFor(() => expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(expect.objectContaining({ setId: undefined, activityWindowDays: 30 }), expect.anything()));
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(screen.getByRole("dialog", { name: "Manage reports" })).toBe(dialog);
  });

  it("never mounts the admin importer for a Viewer, while history, locator and snapshots remain accessible", async () => {
    render(<Host canManage={false} />);
    expect(api.getOfficialUsageHistory).not.toHaveBeenCalled();
    expect(api.getOfficialUsageOverview).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAggregate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    await screen.findByRole("table");
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(importMount).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAdminState).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add CSV reports" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete|Make current|Resume/ })).not.toBeInTheDocument();
    expect(api.getOfficialUsageOverview).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Find an agent across reports", { selector: "summary" }));
    await screen.findByRole("button", { name: "View source snapshot for Researcher" });
    await userEvent.click(screen.getByRole("button", { name: "View source snapshot for Researcher" }));
    await screen.findByRole("region", { name: "Report agent rows" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    const reads = [vi.mocked(api.getOfficialUsageHistory).mock.calls.length, vi.mocked(api.getOfficialUsageOverview).mock.calls.length, vi.mocked(api.getOfficialUsageAggregate).mock.calls.length];
    await act(async () => {});
    expect([vi.mocked(api.getOfficialUsageHistory).mock.calls.length, vi.mocked(api.getOfficialUsageOverview).mock.calls.length, vi.mocked(api.getOfficialUsageAggregate).mock.calls.length]).toEqual(reads);
  });

  it("guards direct Viewer import routes and discards drafts on principal remount", async () => {
    const props = { route: { view: "import" as const, activityWindowDays: 30 }, onRouteChange: vi.fn(), revision: 0, onChanged: vi.fn() };
    const view = render(<OfficialUsageImportModal key="one" {...props} canManage />);
    await userEvent.type(screen.getByLabelText("Selected import draft"), "private draft");
    view.rerender(<OfficialUsageImportModal key="two" {...props} canManage />);
    expect(screen.getByLabelText("Selected import draft")).toHaveValue("");
    importMount.mockClear();
    view.rerender(<OfficialUsageImportModal key="viewer" {...props} canManage={false} />);
    const viewerDialog = await screen.findByRole("dialog", { name: "Manage reports" });
    expect(viewerDialog).toBeVisible();
    expect(viewerDialog).toHaveAccessibleDescription("An administrator (AgentControl.Admin) is required to import CSV reports. You can still inspect saved reports below.");
    expect(screen.getByText(/An administrator \(AgentControl.Admin\) is required to import CSV reports/)).toBeVisible();
    expect(importMount).not.toHaveBeenCalled();
    expect(api.getOfficialUsageAdminState).not.toHaveBeenCalled();
  });

  it("restores a Viewer's locator query and dates on Back to reports without fetching while the locator is hidden", async () => {
    vi.mocked(api.getOfficialUsageOverview).mockImplementation(async query => usageOverviewFixture(query));
    render(<Host canManage={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Open reports" }));
    await userEvent.click(screen.getByText("Find an agent across reports", { selector: "summary" }));
    await screen.findByRole("button", { name: "View source snapshot for Researcher" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search retained agents" }), { target: { value: "Researcher" } });
    fireEvent.change(screen.getByLabelText("Observed activity on or after (UTC)"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Observed activity on or before (UTC)"), { target: { value: "2026-09-20" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Order retained agents" }), "name");
    await userEvent.click(await screen.findByRole("button", { name: "View source snapshot for Researcher" }));
    await screen.findByText("Showing retained set");
    expect(screen.queryByRole("searchbox", { name: "Search retained agents" })).not.toBeInTheDocument();
    const reads = vi.mocked(api.getOfficialUsageOverview).mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await screen.findByText("Showing retained set");
    expect(api.getOfficialUsageOverview).toHaveBeenCalledTimes(reads);
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(screen.getByText("Find an agent across reports", { selector: "summary" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("searchbox", { name: "Search retained agents" })).toHaveValue("Researcher");
    expect(screen.getByLabelText("Observed activity on or after (UTC)")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("Observed activity on or before (UTC)")).toHaveValue("2026-09-20");
    expect(screen.getByRole("combobox", { name: "Order retained agents" })).toHaveValue("name");
    await waitFor(() => expect(api.getOfficialUsageOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "Researcher", startDate: "2026-09-01", endDate: "2026-09-20", sortBy: "agentName" }), expect.anything()));
    expect(api.getOfficialUsageAdminState).not.toHaveBeenCalled();
  });

  it("preserves an explicit deep-link window for inspection and refresh, but uses destination defaults on navigation", async () => {
    const onRouteChange = vi.fn();
    function DeepLinkHost() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({
        view: "snapshot", reportSetId: "retained-snapshot", activityWindowDays: 7,
      });
      return <OfficialUsageImportModal route={route} onRouteChange={next => { onRouteChange(next); setRoute(next); }}
        canManage revision={0} onChanged={vi.fn()} />;
    }
    render(<DeepLinkHost />);
    await screen.findByText("Showing retained set");
    expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(
      expect.objectContaining({ setId: "retained-snapshot", activityWindowDays: 7 }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await screen.findByText("Showing retained set");
    expect(api.getOfficialUsageAggregate).toHaveBeenCalledTimes(2);
    expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(
      expect.objectContaining({ setId: "retained-snapshot", activityWindowDays: 7 }), expect.anything());
    expect(onRouteChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "View current snapshot" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "snapshot", reportSetId: undefined, activityWindowDays: 30 });
    await waitFor(() => expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(
      expect.objectContaining({ setId: undefined, activityWindowDays: 30 }), expect.anything()));
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "manage", reportSetId: undefined, activityWindowDays: 30 });
    await userEvent.click(screen.getByRole("button", { name: "View fixture snapshot" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "snapshot", reportSetId: "retained-snapshot", activityWindowDays: 365 });
    await screen.findByText("Showing retained set");
    expect(api.getOfficialUsageAggregate).toHaveBeenLastCalledWith(
      expect.objectContaining({ setId: "retained-snapshot", activityWindowDays: 365 }), expect.anything());
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "manage", reportSetId: undefined, activityWindowDays: 30 });
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    expect(onRouteChange).toHaveBeenLastCalledWith({ view: "import", reportSetId: undefined, activityWindowDays: 30 });
  });
});
