import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, downloadAdministrativeAuditCsv, getAuditEvents, type AuditEvent } from "../api/client";
import { downloadBlob } from "../agentExport";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { createSavedQueryClient } from "../savedQueries";
import { AuditLogView } from "./AuditLogView";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("./CapabilityGate", () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../agentExport", () => ({ downloadBlob: vi.fn() }));

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getAuditEvents: vi.fn(),
  downloadAdministrativeAuditCsv: vi.fn(),
}));

vi.mock("./PurviewAuditView", () => ({
  PurviewAuditView: ({
    initialJobId,
    onSelectedJobChange,
  }: {
    initialJobId?: string;
    onSelectedJobChange?: (jobId: string) => void;
  }) => (
    <section aria-label="Mock Purview">
      <span>{initialJobId ?? "No selected Purview job"}</span>
      <button type="button" onClick={() => onSelectedJobChange?.("older-job")}>Select older job</button>
    </section>
  ),
}));

const associationEvent: AuditEvent = {
  id: "association-event", operationId: "associate-agent-usage:operation-1",
  action: "associate-agent-usage", scope: "single", agentId: "agent:11111111-1111-4111-8111-111111111111",
  actor: { homeAccountId: "fixture", username: "fixture@example.invalid", displayName: "Fixture", roles: ["AgentControl.Admin"] },
  startedAt: "2026-09-17T00:00:00.000Z", status: "succeeded", requestPath: "/api/agent-inventory/agent/usage-associations",
  metadata: {
    source: "official_usage", reportSetId: "11111111-1111-4111-8111-111111111111",
    revision: "a".repeat(64), inventoryRevision: "b".repeat(64), selection: "admin_reviewed",
    reportAgentHash: "c".repeat(64), targetSelectionHash: "d".repeat(64), changed: false,
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState({}, "", "/audit?q=saved+actor&action=block&status=failed");
  vi.mocked(getAuditEvents).mockResolvedValue({ value: [], count: 0 });
});

describe("AuditLogView routing", () => {
  it.each([
    ["reassign", "Reassign owner"],
    ["approve-hunting", "Approve Defender hunting qualification"],
    ["qualify-hunting", "Run Defender hunting qualification"],
    ["submit-hunting", "Submit Defender hunt"],
    ["query-hunting", "Query Defender hunting"],
    ["cancel-hunting", "Cancel Defender hunt"],
    ["delete-hunting", "Delete Defender hunt"],
    ["revoke-hunting-scope", "Revoke saved Defender scope"],
    ["export-official-usage-aggregate", "Export agent usage report"],
    ["export-official-usage-users", "Export user usage report"],
    ["export-administrative-audit", "Export administrative audit"],
  ] as const)("preserves the backend-supported %s action in URLs, filters and evidence labels", async (action, label) => {
    window.history.replaceState({}, "", `/audit?action=${action}`);
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{ ...associationEvent, action }] });
    render(<AuditLogView agents={[]} />);
    expect(await screen.findByRole("region", { name: "Audit events" })).toHaveTextContent(label);
    expect(screen.getByRole("combobox", { name: "Action" })).toHaveValue(action);
    expect(getAuditEvents).toHaveBeenCalledWith(expect.objectContaining({ action }), expect.anything());
    expect(new URLSearchParams(window.location.search).get("action")).toBe(action);
  });

  it.each([
    ["associate-agent-usage", "Associate agent usage"],
    ["remove-agent-usage-association", "Remove usage association"],
  ] as const)("retains the %s filter and its readable reporting-only audit label", async (action, label) => {
    window.history.replaceState({}, "", `/audit?action=${action}&status=succeeded`);
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{
      id: "usage-event", operationId: "usage-operation", action, scope: "single",
      agentId: "agent:11111111-1111-4111-8111-111111111111",
      actor: { homeAccountId: "fixture", username: "fixture@example.invalid", displayName: "Fixture", roles: ["AgentControl.Admin"] },
      startedAt: "2026-09-17T00:00:00.000Z", status: "succeeded", requestPath: "/api/agent-inventory/agent/usage-associations",
    }] });
    render(<AuditLogView agents={[{ id: associationEvent.agentId, displayName: "Unrelated native package" }]} />);
    await waitFor(() => expect(getAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ action, status: "succeeded" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(screen.getByRole("combobox", { name: "Action" })).toHaveValue(action);
    const events = await screen.findByRole("region", { name: "Audit events" });
    expect(screen.getAllByText(label).length).toBeGreaterThan(1);
    expect(within(events).queryByText("Unrelated native package")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("action")).toBe(action);
  });

  it("retains the unified inventory export filter and labels its audit event", async () => {
    window.history.replaceState({}, "", "/audit?action=export-agent-inventory&status=succeeded");
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{
      id: "export-event", operationId: "export-operation", action: "export-agent-inventory", scope: "bulk",
      agentId: "agent-inventory", actor: { homeAccountId: "fixture", username: "fixture@example.invalid", displayName: "Fixture", roles: ["AgentControl.Viewer"] },
      startedAt: "2026-09-17T00:00:00.000Z", status: "succeeded", requestPath: "/api/agent-inventory/export.csv",
    }] });
    render(<AuditLogView agents={[]} />);
    await waitFor(() => expect(getAuditEvents).toHaveBeenCalledWith(expect.objectContaining({
      action: "export-agent-inventory", status: "succeeded",
    }), expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(screen.getByRole("combobox", { name: "Action" })).toHaveValue("export-agent-inventory");
    await screen.findByRole("region", { name: "Audit events" });
    expect(screen.getAllByText("Export agent inventory").length).toBeGreaterThan(1);
    expect(new URLSearchParams(window.location.search).get("action")).toBe("export-agent-inventory");
  });

  it.each([
    ["export-official-usage-aggregate", "Export agent usage report"],
    ["export-official-usage-users", "Export user usage report"],
  ] as const)("labels the %s reporting export rather than rendering a blank action", async (action, label) => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{ ...associationEvent, action }] });
    render(<AuditLogView agents={[]} />);
    expect(within(await screen.findByRole("region", { name: "Audit events" })).getByText(label)).toBeVisible();
  });

  it("shows bounded association evidence and restores trapped audit-detail focus", async () => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{
      ...associationEvent,
      metadata: { ...associationEvent.metadata, reportAgentId: "unrecorded-report-id", rows: ["unrecorded-user-row"] },
    }] });
    render(<AuditLogView agents={[]} />);
    const trigger = await screen.findByRole("button", { name: "View event details: Usage association evidence" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Event details" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const details = within(dialog).getByLabelText("Recorded audit details");
    expect(details).toHaveTextContent('"reportSetId": "11111111-1111-4111-8111-111111111111"');
    expect(details).toHaveTextContent('"selection": "admin_reviewed"');
    expect(details).toHaveTextContent(`"reportAgentHash": "${"c".repeat(64)}"`);
    expect(details).toHaveTextContent(`"targetSelectionHash": "${"d".repeat(64)}"`);
    expect(details).toHaveTextContent('"changed": false');
    expect(details).toHaveTextContent('"status": "succeeded"');
    expect(details).not.toHaveTextContent("unrecorded-report-id");
    expect(details).not.toHaveTextContent("unrecorded-user-row");
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(details).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(details).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps a failed association's conflict code alongside its report and revision evidence", async () => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{
      ...associationEvent, action: "remove-agent-usage-association", status: "failed", errorCode: "inventory_changed",
    }] });
    render(<AuditLogView agents={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: "View event details: inventory_changed" }));
    const details = screen.getByLabelText("Recorded audit details");
    expect(details).toHaveTextContent('"status": "failed"');
    expect(details).toHaveTextContent('"errorCode": "inventory_changed"');
    expect(details).toHaveTextContent(`"inventoryRevision": "${"b".repeat(64)}"`);
    expect(details).toHaveTextContent('"reportSetId": "11111111-1111-4111-8111-111111111111"');
  });

  it("keeps a failed audit read unavailable instead of showing a zero-event success and supports retry", async () => {
    vi.mocked(getAuditEvents).mockRejectedValueOnce(new Error("Audit read unavailable"))
      .mockResolvedValueOnce({ count: 1, value: [associationEvent] });
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit read unavailable");
    expect(screen.getByRole("heading", { name: "Audit events unavailable" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "No audit events" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Audit summary")).getByText("Events").parentElement).toHaveTextContent("Unknown");
    expect(screen.getByRole("button", { name: "Export current audit page CSV" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry audit log" }));
    expect(await screen.findByRole("region", { name: "Audit events" })).toBeVisible();
    expect(getAuditEvents).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fails closed instead of retaining audit rows after a denied refresh", async () => {
    vi.mocked(getAuditEvents)
      .mockResolvedValueOnce({ count: 1, value: [associationEvent] })
      .mockRejectedValueOnce(new Error("Audit access denied"));
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    await screen.findByRole("region", { name: "Audit events" });

    await userEvent.click(screen.getByRole("button", { name: "Refresh audit log" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Audit access denied");
    expect(screen.queryByRole("region", { name: "Audit events" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export current audit page CSV" })).toBeDisabled();
  });

  it("closes private event details when the exact audit page is refreshed or filtered", async () => {
    vi.mocked(getAuditEvents).mockResolvedValueOnce({ count: 1, value: [associationEvent] })
      .mockRejectedValue(new ApiError(403, "forbidden", "Audit access denied"));
    render(<AuditLogView agents={[]} />);
    await userEvent.click(await screen.findByRole("button", { name: "View event details: Usage association evidence" }));
    expect(screen.getByRole("dialog")).toBeVisible();

    act(() => {
      window.history.replaceState({}, "", "/audit?action=remove-agent-usage-association");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Audit access denied");
    expect(screen.queryByText(/"reportAgentHash"/)).not.toBeInTheDocument();
  });

  it("cancels an export when its exact displayed page changes", async () => {
    let finish!: (blob: Blob) => void;
    let signal!: AbortSignal;
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [associationEvent] });
    vi.mocked(downloadAdministrativeAuditCsv).mockImplementation((_ids, requestSignal) => {
      signal = requestSignal!;
      return new Promise(resolve => { finish = resolve; });
    });
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    await screen.findByRole("region", { name: "Audit events" });
    await userEvent.click(screen.getByRole("button", { name: "Export current audit page CSV" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action" }), "remove-agent-usage-association");
    expect(signal.aborted).toBe(true);
    await act(async () => finish(new Blob(["obsolete"])));
    expect(downloadBlob).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Export current audit page CSV" })).toBeEnabled());
  });

  it("withholds audit evidence and details after the server denies its export until a fresh retry", async () => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [associationEvent] });
    vi.mocked(downloadAdministrativeAuditCsv).mockRejectedValue(new ApiError(401, "unauthorized", "Session expired"));
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    await screen.findByRole("region", { name: "Audit events" });
    await userEvent.click(screen.getByRole("button", { name: "Export current audit page CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Session expired");
    expect(screen.queryByRole("region", { name: "Audit events" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export current audit page CSV" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry audit log" }));
    expect(await screen.findByRole("region", { name: "Audit events" })).toBeVisible();
  });

  it("withholds prior audit rows and CSV actions while a different exact filter is loading", async () => {
    let finish!: (value: { count: number; value: AuditEvent[] }) => void;
    vi.mocked(getAuditEvents).mockResolvedValueOnce({ count: 1, value: [associationEvent] })
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    await screen.findByRole("region", { name: "Audit events" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action" }), "remove-agent-usage-association");
    expect(screen.queryByRole("region", { name: "Audit events" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading audit events");
    expect(screen.getByRole("button", { name: "Export current audit page CSV" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Export current audit page CSV" }));
    expect(downloadAdministrativeAuditCsv).not.toHaveBeenCalled();
    await act(async () => finish({ count: 1, value: [{ ...associationEvent, action: "remove-agent-usage-association" }] }));
    expect(await screen.findByRole("region", { name: "Audit events" })).toHaveTextContent("Remove usage association");
  });

  it("ignores obsolete audit responses after the selected action changes", async () => {
    let finish!: (value: { count: number; value: AuditEvent[] }) => void;
    let obsoleteSignal!: AbortSignal;
    vi.mocked(getAuditEvents).mockImplementationOnce((_query, options) => {
      obsoleteSignal = options!.signal!;
      return new Promise(resolve => { finish = resolve; });
    })
      .mockResolvedValueOnce({ count: 1, value: [{ ...associationEvent, action: "remove-agent-usage-association" }] });
    render(<AuditLogView agents={[]} />);
    await waitFor(() => expect(getAuditEvents).toHaveBeenCalledOnce());
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action" }), "remove-agent-usage-association");
    const events = await screen.findByRole("region", { name: "Audit events" });
    expect(obsoleteSignal.aborted).toBe(true);
    expect(events).toHaveTextContent("Remove usage association");
    await act(async () => finish({ count: 1, value: [associationEvent] }));
    expect(events).not.toHaveTextContent("Associate agent usage");
    expect(events).toHaveTextContent("Remove usage association");
  });

  it("exports exact displayed event IDs through the authorized server rather than serializing cached rows", async () => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [{
      id: "event-1", operationId: "operation-1", action: "block", targetBlockedState: true, scope: "single",
      agentId: "package-1", actor: { homeAccountId: "fixture", username: "fixture@example.invalid", displayName: "Fixture", roles: ["AgentControl.Viewer"] },
      startedAt: "2026-09-10T10:00:00.000Z", status: "failed", requestPath: "/fixture",
    }] });
    vi.mocked(downloadAdministrativeAuditCsv).mockRejectedValue(new Error("Download not authorized"));
    render(<WorkbenchActionProvider value={workbenchActions}><AuditLogView agents={[]} /></WorkbenchActionProvider>);
    const button = await screen.findByRole("button", { name: "Export current audit page CSV" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(downloadAdministrativeAuditCsv).toHaveBeenCalledWith(["event-1"], expect.any(AbortSignal));
    expect(await screen.findByText("Download not authorized")).toBeVisible();
  });

  it("renders current evidence under real StrictMode without exporting or other mutations", async () => {
    vi.mocked(getAuditEvents).mockResolvedValue({ count: 1, value: [associationEvent] });
    render(<AuditLogView agents={[]} />, { reactStrictMode: true });
    expect(await screen.findByRole("region", { name: "Audit events" })).toBeVisible();
    expect(downloadAdministrativeAuditCsv).not.toHaveBeenCalled();
  });

  it("does not reattach a manual refresh to another consumer's shared refresh", async () => {
    const client = createSavedQueryClient();
    const oldEvent = { ...associationEvent, actor: { ...associationEvent.actor, displayName: "Old shared audit actor" } };
    const freshEvent = { ...associationEvent, actor: { ...associationEvent.actor, displayName: "Fresh audit actor" } };
    let phase: "initial" | "old" | "fresh" = "initial";
    let finish!: (value: Awaited<ReturnType<typeof getAuditEvents>>) => void;
    let oldSignal!: AbortSignal;
    const oldRead = new Promise<Awaited<ReturnType<typeof getAuditEvents>>>(resolve => { finish = resolve; });
    vi.mocked(getAuditEvents).mockImplementation((_query, options) => {
      if (phase === "old") {
        oldSignal = options!.signal!;
        return oldRead;
      }
      return Promise.resolve({ count: 1, value: [phase === "fresh" ? freshEvent : associationEvent] });
    });
    const view = render(<SavedQueryProvider client={client}>
      <section aria-label="First audit consumer"><AuditLogView agents={[]} /></section>
      <section aria-label="Second audit consumer"><AuditLogView agents={[]} /></section>
    </SavedQueryProvider>);
    try {
      const first = within(screen.getByRole("region", { name: "First audit consumer" }));
      const second = within(screen.getByRole("region", { name: "Second audit consumer" }));
      await first.findByRole("region", { name: "Audit events" });
      await second.findByRole("region", { name: "Audit events" });
      const initialCalls = vi.mocked(getAuditEvents).mock.calls.length;
      phase = "old";
      await userEvent.click(first.getByRole("button", { name: "Refresh audit log" }));
      expect(getAuditEvents).toHaveBeenCalledTimes(initialCalls + 1);
      phase = "fresh";
      await userEvent.click(second.getByRole("button", { name: "Refresh audit log" }));
      await waitFor(() => expect(getAuditEvents).toHaveBeenCalledTimes(initialCalls + 2));
      expect(await second.findByText("Fresh audit actor")).toBeVisible();
      expect(oldSignal.aborted).toBe(false);
      await act(async () => finish({ count: 1, value: [oldEvent] }));
      expect(await first.findByText("Old shared audit actor")).toBeVisible();
      expect(second.queryByText("Old shared audit actor")).not.toBeInTheDocument();
      expect(second.getByText("Fresh audit actor")).toBeVisible();
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it.each(["", "&source=purview&job=older-job&user=employee%40example.invalid", "&job=older-job"])(
    "shows only local actions and normalizes obsolete provider links %s", async legacy => {
    window.history.replaceState({}, "", `/audit?q=saved+actor&action=block&status=failed${legacy}`);
    render(<AuditLogView agents={[]} />);
    expect(screen.getByRole("heading", { name: "Local control audit" })).toBeVisible();
    expect(await screen.findByLabelText("Search")).toHaveValue("saved actor");
    expect(screen.getByLabelText("Action")).toHaveValue("block");
    expect(screen.getByLabelText("Result")).toHaveValue("failed");
    expect(screen.queryByRole("tablist", { name: "Audit source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Mock Purview" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("?q=saved+actor&action=block&status=failed");
    await waitFor(() => expect(getAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ search: "saved actor", action: "block", status: "failed" }), expect.anything(),
    ));
    expect(downloadAdministrativeAuditCsv).not.toHaveBeenCalled();
  });

  it("restores local filters through browser back and forward without reviving provider search", async () => {
    render(<AuditLogView agents={[]} />);
    act(() => {
      window.history.pushState({}, "", "/audit?source=purview&job=old&action=unblock&status=succeeded");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByLabelText("Action")).toHaveValue("unblock");
    expect(window.location.search).toBe("?action=unblock&status=succeeded");
    window.history.back();
    await waitFor(() => expect(screen.getByLabelText("Action")).toHaveValue("block"));
    expect(screen.getByLabelText("Search")).toHaveValue("saved actor");
    window.history.forward();
    await waitFor(() => expect(screen.getByLabelText("Action")).toHaveValue("unblock"));
    expect(screen.queryByRole("region", { name: "Mock Purview" })).not.toBeInTheDocument();
  });

  it("does not rewrite a destination outside Audit before the view unmounts on browser navigation", () => {
    render(<AuditLogView agents={[]} />);
    act(() => {
      window.history.pushState({}, "", "/users?view=activity&q=employee");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/users?view=activity&q=employee");
  });
});
