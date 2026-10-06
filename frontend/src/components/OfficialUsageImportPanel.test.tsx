import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficialReportAccepted, OfficialReportPreview } from "../../../backend/src/types/officialReportApi";
import { ApiError, type SessionUser } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext } from "../capabilityContext";
import { deferred } from "../test/deferred";
import { reportBundle, reportStage } from "../test/reportImportFixture";
import { reportAgent, reportPage, reports, reportSetId } from "../test/reportDataFixture";
import { mockNativeDialogs } from "../test/dialog";
import type { SyncReportRouteState } from "../workbenchRouting";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { OfficialUsageImportPanel, type OfficialUsageImportHandle } from "./OfficialUsageImportPanel";

vi.mock("../api/reportData", async original => {
  const actual = await original<typeof import("../api/reportData")>();
  return { ...actual, stageReport: vi.fn(), readReportStage: vi.fn(), discardReportStage: vi.fn(), previewReportBundle: vi.fn(), acceptReportBundle: vi.fn(),
    readReportDiagnostics: vi.fn(), previewReportOperation: vi.fn(), confirmReportOperation: vi.fn(),
    reportPages: { ...actual.reportPages, agents: vi.fn() } };
});
mockNativeDialogs();
const kinds = ["agents", "userAgents", "users"] as const;
const bundleId = "60000000-0000-4000-8000-000000000001";
const callbacks = { onChanged: vi.fn(), onDone: vi.fn(), onCancel: vi.fn(), onStaged: vi.fn() };
let stages: OfficialReportPreview[];
function file(name: string, body = "synthetic streamed CSV") { return new File([body], name, { type: "text/csv" }); }
function files() { return [file("agents.csv"), file("user-agents.csv"), file("users.csv")]; }
async function choose(selected = files()) { await userEvent.upload(screen.getByLabelText("CSV report files"), selected); }
async function ready() { return screen.findByRole("button", { name: "Import reports" }); }
async function accept() { fireEvent.click(await ready()); }
async function imported() { await screen.findByRole("heading", { name: "Reports imported" }); }
beforeEach(() => {
  stages = [];
  vi.mocked(api.stageReport).mockImplementation(async (file, intent) => {
    const kind = file.name.startsWith("agents") ? "agents" : file.name.startsWith("user-agents") ? "userAgents" : "users";
    if (stages.some(stage => stage.bundleId === intent.bundleId && stage.kind === kind)) throw new ApiError(409, "duplicate_report_kind", "Choose a missing report kind");
    const stage = reportStage(kind, intent.bundleId, { id: crypto.randomUUID(), correctionOfSetId: intent.correctionOfSetId ?? null });
    stages.push(stage);
    return stage;
  });
  vi.mocked(api.previewReportBundle).mockImplementation(async id => reportBundle(stages.filter(stage => stage.bundleId === id), id));
  vi.mocked(api.readReportStage).mockImplementation(async id => {
    const stage = stages.find(stage => stage.id === id);
    if (!stage) throw new ApiError(404, "report_stage_unavailable", "Saved staging link unavailable");
    return stage;
  });
  vi.mocked(api.acceptReportBundle).mockImplementation(async id => {
    stages = stages.map(stage => stage.bundleId === id ? { ...stage, status: "accepted" } : stage);
    return { setId: reportSetId, activeRevision: "5", complete: true };
  });
  vi.mocked(api.reportPages.agents).mockResolvedValue(reportPage([reportAgent()]));
  vi.mocked(api.discardReportStage).mockImplementation(async id => { stages = stages.filter(stage => stage.id !== id); });
  vi.mocked(api.readReportDiagnostics).mockResolvedValue({ value: [{ ordinal: 0, agentId: "agent-1", username: null, code: "agent_bridge_mismatch" }],
    counts: { total: 100000, filtered: 100000 }, preview: { id: "stage", revision: 1, contentHash: "a".repeat(64) },
    page: { limit: 50, nextCursor: "next-diagnostic", previousCursor: null } });
  vi.mocked(api.previewReportOperation).mockResolvedValue({ id: "selection-confirmation", setId: reportSetId, operation: "select",
    activeRevision: reports.activeRevision, historyRevision: reports.historyRevision, historyEpoch: reports.historyEpoch, hash: "c".repeat(64) });
  vi.mocked(api.confirmReportOperation).mockResolvedValue({ activeSetId: reportSetId, activeRevision: "5" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("streamed complete-set import confirmation", () => {
  it("starts empty without enumerating unrelated drafts, including Strict Mode replay", () => {
    stages = kinds.map(kind => reportStage(kind, bundleId));
    render(<OfficialUsageImportPanel {...callbacks} />, { reactStrictMode: true });
    expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
    expect(api.readReportStage).not.toHaveBeenCalled();
    expect(api.previewReportBundle).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(screen.queryByText("Optional source metadata")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });
  it("shows only three compact file summaries and the next step once the files are ready", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await ready()).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Ready to import" })).toHaveFocus();
    const list = screen.getByRole("list", { name: "Selected CSV files" });
    expect(within(list).getAllByRole("listitem").map(row => row.textContent)).toEqual([
      "agents.csvAgents - 100,000 rows", "user-agents.csvUsers & agents - 100,000 rows", "users.csvUsers - 100,000 rows",
    ]);
    expect(list.querySelectorAll("details, pre, button")).toHaveLength(0);
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Cancel import", "Import reports"]);
    expect(screen.queryByLabelText("Reporting start")).not.toBeInTheDocument();
    expect(screen.queryByText(/activity_range|Resume staging ID|bounded staging|tenant-visible/)).not.toBeInTheDocument();
    expect(api.readReportDiagnostics).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("streams three companions with immutable intent, waits for explicit acceptance, verifies exact bounded data and finishes only on OK", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    const confirm = await ready();
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    const id = vi.mocked(api.stageReport).mock.calls[0][1].bundleId;
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(api.stageReport).mock.calls) {
      expect(call[0]).toBeInstanceOf(File);
      expect(call[1]).toEqual({ bundleId: id, correctionOfSetId: undefined, rejectDuplicateKind: true });
      expect(call[3]).toBeInstanceOf(AbortSignal);
    }
    fireEvent.click(confirm);
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledExactlyOnceWith(id, { bundleHash: "b".repeat(64), expectedActiveRevision: "4" }, expect.any(AbortSignal));
    expect(api.reportPages.agents).toHaveBeenCalledWith({ setId: reportSetId, limit: 1 }, expect.any(AbortSignal));
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["OK"]);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith(reportSetId));
    expect(api.reportPages.agents).toHaveBeenCalledTimes(2);
  });
  it.each([0, 1000000, null])("uses exact full-CSV lineage counts and responses %s instead of the one-row preview or overlapping license categories", async responses => {
    const data = reportPage([reportAgent()]);
    data.reports = { ...reports, lineages: reports.lineages.map(lineage => ({ ...lineage, rowCount: responses === 0 ? 0 : lineage.kind === "users" ? 70000 : 100000 })) };
    data.summary = { ...data.summary, reportedResponses: responses, distinctActiveReportUsers: 2, licensedOccurrences: 8, unlicensedOccurrences: 9 };
    vi.mocked(api.reportPages.agents).mockResolvedValue(data);
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    const summary = within(screen.getByRole("region", { name: "Imported CSV summary" }));
    expect(summary.getAllByRole("definition").map(value => value.textContent)).toEqual([
      responses === 0 ? "0" : "100,000", responses === 0 ? "0" : "70,000", responses === null ? "Unknown" : responses.toLocaleString(),
    ]);
  });
  it("focuses the accepted summary and revalidates exact saved evidence before Escape acknowledges success", async () => {
    const handle = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={handle} />);
    await choose(); await accept(); await imported();
    expect(screen.getByRole("heading", { name: "Reports imported" })).toHaveFocus();
    const evidence = reportPage([reportAgent()]);
    const held = deferred<typeof evidence>();
    vi.mocked(api.reportPages.agents).mockReturnValueOnce(held.promise);
    act(() => { handle.current?.dismiss(); });
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(api.reportPages.agents).toHaveBeenLastCalledWith({ setId: reportSetId, limit: 1 }, expect.any(AbortSignal));
    const calls = vi.mocked(api.reportPages.agents).mock.calls.length;
    expect(screen.getByRole("button", { name: "Cancel import" })).toBeDisabled();
    act(() => { handle.current?.dismiss(); });
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(api.reportPages.agents).toHaveBeenCalledTimes(calls);
    await act(async () => { held.resolve(evidence); });
    await waitFor(() => expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith(reportSetId));
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
  });
  it("keeps validated companions and shows only missing report kinds without automatic publication", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    expect(await screen.findByText("Still needed: Users & agents, Users.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Import reports" })).not.toBeInTheDocument();
    await choose(files().slice(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import reports" })).toBeEnabled());
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("accepts dropped File objects without buffering CSV contents or bypassing confirmation", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    fireEvent.drop(screen.getByText("Drop your three CSV exports here").parentElement!, { dataTransfer: { files: files() } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Import reports" })).toBeEnabled());
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it.each([
    { cause: new ApiError(400, "invalid_report_schema", "Missing Users columns"), message: "Missing Users columns" },
    { cause: new Error("CSV header missing."), message: "CSV header missing." },
    { cause: null, message: "CSV validation failed." },
  ])("retains valid companions and the filename-specific error '$message' until the failed companion is replaced", async ({ cause, message }) => {
    const original = vi.mocked(api.stageReport).getMockImplementation()!;
    vi.mocked(api.stageReport).mockImplementation(async (...args) => {
      if (args[0].name === "bad-users.csv") throw cause;
      return original(...args);
    });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0], file("bad-users.csv")]);
    expect(await screen.findByRole("alert")).toHaveTextContent(`bad-users.csv: ${message}`);
    expect(screen.getByText("agents.csv", { selector: "strong" })).toBeVisible();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    await choose(files().slice(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import reports" })).toBeEnabled());
    expect(screen.queryByText("bad-users.csv", { selector: "strong" })).not.toBeInTheDocument();
  });
  it("rejects duplicate kinds without replacing a previously validated file", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    await screen.findByRole("heading", { name: "Add the remaining reports" });
    const previous = stages[0].id;
    await choose([file("agents-duplicate.csv")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("missing report kind");
    expect(stages.map(stage => stage.id)).toEqual([previous]);
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it.each([["empty.csv", 0], ["large.csv", 268435457], ["report.txt", 5]] as const)("rejects invalid %s before initiating an upload", async (name, size) => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    const selected = file(name); Object.defineProperty(selected, "size", { value: size });
    fireEvent.change(screen.getByLabelText("CSV report files"), { target: { files: [selected] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(name);
    expect(api.stageReport).not.toHaveBeenCalled();
  });
  it("rejects more than three companions without sending any file", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([...files(), file("extra.csv")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("at most three");
    expect(api.stageReport).not.toHaveBeenCalled();
  });
  it("cancels only this draft and starts an independent bundle when reopened, without a reset button", async () => {
    const unrelated = reportStage("agents", "unrelated");
    stages = [unrelated];
    const view = render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    await screen.findByRole("heading", { name: "Add the remaining reports" });
    const initialId = vi.mocked(api.stageReport).mock.calls[0][1].bundleId;
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    view.unmount();
    render(<OfficialUsageImportPanel {...callbacks} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled());
    await choose([files()[0]]);
    await waitFor(() => expect(api.stageReport).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.stageReport).mock.calls[1][1].bundleId).not.toBe(initialId);
    expect(api.discardReportStage).toHaveBeenCalledOnce();
    expect(api.discardReportStage).not.toHaveBeenCalledWith(unrelated.id, expect.anything());
  });
  it("cancels an empty form without any server mutation", () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(api.discardReportStage).not.toHaveBeenCalled();
  });
  it.each([
    ["duplicate", "Keep current report"], ["duplicate", "Escape"],
    ["correction", "Keep current report"], ["correction", "Escape"],
  ] as const)("dismisses a conclusively saved non-active %s via %s without selecting or discarding it", async (mode, action) => {
    const correctionOfSetId = mode === "correction" ? "60000000-0000-4000-8000-000000000002" : undefined;
    const saved = reportPage([reportAgent()], { reports: { ...reports, activeSetId: "another-active-set" } });
    vi.mocked(api.reportPages.agents).mockResolvedValue(saved);
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({
        view: "import", reportSetId: correctionOfSetId, activityWindowDays: 30,
      });
      return <OfficialUsageImportModal route={route} onRouteChange={next => {
        if (!next) callbacks.onCancel();
        setRoute(next);
      }} canManage revision={0} onChanged={callbacks.onChanged} onImported={callbacks.onDone} />;
    }
    render(<Host />);
    await choose(); await accept();
    await waitFor(() => expect(screen.getByRole("button", { name: "Use imported reports" })).toBeEnabled());
    const acceptedStages = stages.map(stage => ({ ...stage }));
    expect(acceptedStages).toHaveLength(3);
    expect(acceptedStages.every(stage => stage.status === "accepted" && stage.correctionOfSetId === (correctionOfSetId ?? null))).toBe(true);
    if (action === "Escape") fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    else fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.reportPages.agents).toHaveBeenCalledExactlyOnceWith({ setId: reportSetId, limit: 1 }, expect.any(AbortSignal));
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(stages).toEqual(acceptedStages);
    expect(saved.reports.activeSetId).toBe("another-active-set");
    expect(saved.reports.activeRevision).toBe(reports.activeRevision);
  });
  it("uploads only the file without asking for or inventing source metadata", async () => {
      const actual = await vi.importActual<typeof api>("../api/reportData");
      vi.mocked(api.stageReport).mockImplementation(actual.stageReport);
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
        const url = new URL(String(path), "http://fixture.invalid");
        expect(url.pathname).toBe("/api/official-usage/staging");
        const body = init?.body as FormData;
        const stage = reportStage("agents", url.searchParams.get("bundleId")!);
        stages.push(stage);
        expect(body.get("file")).toBeInstanceOf(File);
        return new Response(JSON.stringify(stage), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      try {
        render(<OfficialUsageImportPanel {...callbacks} />);
        expect(screen.queryByText("Optional source metadata")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Reporting start")).not.toBeInTheDocument();
        expect(screen.queryByLabelText("Source as of (UTC)")).not.toBeInTheDocument();
        await choose([files()[0]]);
        await screen.findByRole("heading", { name: "Add the remaining reports" });
        expect(fetch).toHaveBeenCalledOnce();
        const body = fetch.mock.calls[0][1]?.body as FormData;
        expect([...body.keys()]).toEqual(["file"]);
        expect(api.acceptReportBundle).not.toHaveBeenCalled();
      } finally { fetch.mockRestore(); }
  });
  it("waits for an aborted upload's known receipt and discards it before closing, without publishing or losing cleanup ownership", async () => {
    const pending = deferred<OfficialReportPreview>(); vi.mocked(api.stageReport).mockReturnValue(pending.promise);
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    const intent = vi.mocked(api.stageReport).mock.calls[0][1], signal = vi.mocked(api.stageReport).mock.calls[0][3];
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    expect(signal?.aborted).toBe(true);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    const saved = reportStage("agents", intent.bundleId); stages.push(saved);
    await act(async () => pending.resolve(saved));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.discardReportStage).toHaveBeenCalledWith(saved.id, expect.any(AbortSignal));
    expect(api.stageReport).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("keeps failed cancellation recoverable without closing or discarding another report", async () => {
    vi.mocked(api.discardReportStage).mockRejectedValueOnce(new ApiError(503, "unavailable", "Cleanup unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    await screen.findByRole("heading", { name: "Add the remaining reports" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await screen.findByRole("alert");
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.discardReportStage).toHaveBeenCalledTimes(2);
  });
  it("continues after partial cancellation using only remaining receipts and the original correction metadata", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { correctionOfSetId: reportSetId,
      reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "operator_asserted" },
      sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted" }));
    const discardedId = stages[0].id;
    const discard = vi.mocked(api.discardReportStage).getMockImplementation()!;
    vi.mocked(api.discardReportStage).mockImplementationOnce(discard).mockRejectedValueOnce(new Error("Second discard unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={discardedId} />);
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Second discard unavailable");
    expect(screen.queryByText("Agents", { selector: "strong" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeDisabled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled());
    await choose([files()[0]]);
    await ready();
    expect(api.stageReport).toHaveBeenCalledExactlyOnceWith(expect.any(File),
      { bundleId, correctionOfSetId: reportSetId, rejectDuplicateKind: true },
      expect.objectContaining({ reportingStart: "2026-01-01", reportingEnd: "2026-01-31", periodProvenance: "operator_asserted",
        sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted" }), expect.any(AbortSignal));
    expect(api.discardReportStage).toHaveBeenCalledTimes(2);
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("cancels an already accepted resume without deleting its staged receipts or republishing", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { status: "accepted" }));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    await screen.findByRole("button", { name: "Verify saved report set" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(stages).toHaveLength(3);
  });
  it("cannot cancel or discard after atomic acceptance begins", async () => {
    const pending = deferred<OfficialReportAccepted>(); vi.mocked(api.acceptReportBundle).mockReturnValue(pending.promise);
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel ref={ref} {...callbacks} />);
    await choose(); await accept();
    expect(screen.getByRole("button", { name: "Cancel import" })).toBeDisabled();
    act(() => ref.current?.dismiss());
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ setId: reportSetId, activeRevision: "5", complete: true }));
    await imported();
  });
  it("replays only the identical idempotent acceptance after an unknown outcome, without a new preview or upload", async () => {
    vi.mocked(api.acceptReportBundle).mockRejectedValueOnce(new ApiError(503, "response_lost", "Acceptance response interrupted"));
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    await choose(); await accept();
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Cancel import" })).toBeDisabled();
    act(() => ref.current?.dismiss());
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify acceptance" }));
    await imported();
    const calls = vi.mocked(api.acceptReportBundle).mock.calls;
    expect(calls[1][1]).toBe(calls[0][1]);
    expect(api.previewReportBundle).toHaveBeenCalledOnce();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
  });
  it("requires explicit validation refresh and another acceptance after a definite revision conflict", async () => {
    vi.mocked(api.acceptReportBundle).mockRejectedValueOnce(new ApiError(409, "bundle_fence_mismatch", "Selection changed"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    await screen.findByRole("alert");
    vi.mocked(api.previewReportBundle).mockImplementation(async id => reportBundle(stages.filter(stage => stage.bundleId === id), id, "9"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh bundle validation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import reports" })).toBeEnabled());
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    await accept(); await imported();
    expect(vi.mocked(api.acceptReportBundle).mock.calls[1][1].expectedActiveRevision).toBe("9");
    expect(api.stageReport).toHaveBeenCalledTimes(3);
  });
  it("retries failed exact readback without accepting or uploading twice", async () => {
    vi.mocked(api.reportPages.agents).mockRejectedValueOnce(new ApiError(503, "data_read_conflict", "Readback unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    expect(await screen.findByRole("alert")).toHaveTextContent(/saved/i);
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify saved import" }));
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
  });
  it("does not substitute another report for exact accepted verification", async () => {
    vi.mocked(api.reportPages.agents).mockResolvedValue(reportPage([], { reports: { ...reports, setId: "different" } }));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
  it("does not silently select an older accepted report; adoption has its own one-use confirmation", async () => {
    const other = reportPage([reportAgent()], { reports: { ...reports, activeSetId: "other" } });
    vi.mocked(api.reportPages.agents).mockResolvedValueOnce(other);
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    fireEvent.click(await screen.findByRole("button", { name: "Use imported reports" }));
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm use of imported reports" }));
    await imported();
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
  it("recovers a lost shared-selection confirmation by reading, never replaying its one-use token", async () => {
    vi.mocked(api.reportPages.agents).mockResolvedValueOnce(reportPage([], { reports: { ...reports, activeSetId: "other" } }));
    vi.mocked(api.confirmReportOperation).mockRejectedValueOnce(new Error("Selection response lost"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    fireEvent.click(await screen.findByRole("button", { name: "Use imported reports" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm use of imported reports" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not replay");
    expect(screen.queryByRole("button", { name: "Confirm use of imported reports" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify saved import" }));
    await imported();
    expect(api.confirmReportOperation).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).toHaveBeenCalledOnce();
  });
  it("requires a new explicit adoption if the shared selection changes between saved verification and OK", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    vi.mocked(api.reportPages.agents).mockResolvedValueOnce(reportPage([], { reports: { ...reports, activeSetId: "another-report" } }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("button", { name: "Use imported reports" })).toBeEnabled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
  });
  it("rechecks the exact destination on OK and refuses to navigate to a deleted report", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    vi.mocked(api.reportPages.agents).mockRejectedValueOnce(new ApiError(404, "report_set_unavailable", "Report deleted"));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await screen.findByRole("alert");
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("clears private staging evidence after status %i and stops all publication", async status => {
    vi.mocked(api.stageReport).mockRejectedValueOnce(new ApiError(status, "denied", "Import access denied"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await screen.findByRole("alert");
    expect(screen.queryByText("agents.csv", { selector: "strong" })).not.toBeInTheDocument();
    expect(api.stageReport).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to Sync" }));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
  });
  it("aborts on unmount and never previews or accepts a late upload completion", async () => {
    const pending = deferred<OfficialReportPreview>(); vi.mocked(api.stageReport).mockReturnValue(pending.promise);
    const view = render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    const call = vi.mocked(api.stageReport).mock.calls[0];
    view.unmount();
    expect(call[3]?.aborted).toBe(true);
    await act(async () => pending.resolve(reportStage("agents", call[1].bundleId)));
    expect(api.previewReportBundle).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
  it.each(["upload", "accept"] as const)("retires pending %s work when actual Admin access is revoked", async operation => {
    const upload = deferred<OfficialReportPreview>(), acceptance = deferred<OfficialReportAccepted>();
    const principal: SessionUser = { tenantId: "tenant", homeAccountId: "operator", username: "operator@example.invalid",
      displayName: "Operator", roles: ["AgentControl.Admin"] };
    const content = (roles: SessionUser["roles"]) => <CapabilityContext value={{
      user: { ...principal, roles }, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><OfficialUsageImportPanel {...callbacks} /></CapabilityContext>;
    if (operation === "upload") vi.mocked(api.stageReport).mockReturnValueOnce(upload.promise);
    else vi.mocked(api.acceptReportBundle).mockReturnValueOnce(acceptance.promise);
    const view = render(content(principal.roles));
    await choose(operation === "upload" ? [files()[0]] : files());
    if (operation === "accept") await accept();
    const signal = operation === "upload" ? vi.mocked(api.stageReport).mock.calls[0][3]
      : vi.mocked(api.acceptReportBundle).mock.calls[0][2];
    view.rerender(content(["AgentControl.Viewer"]));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Current Admin access");
    await act(async () => {
      if (operation === "upload") upload.resolve(reportStage("agents", vi.mocked(api.stageReport).mock.calls[0][1].bundleId));
      else acceptance.resolve({ setId: reportSetId, complete: true, activeRevision: "5" });
    });
    expect(api.reportPages.agents).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("agents.csv", { selector: "strong" })).not.toBeInTheDocument();
  });
  it("fences an explicit staging A-B-A transition even when its abandoned first read resolves last", async () => {
    const abandoned = deferred<OfficialReportPreview>();
    const first = reportStage("agents", bundleId), second = reportStage("users", "60000000-0000-4000-8000-000000000002");
    stages = [first, second];
    vi.mocked(api.readReportStage).mockReturnValueOnce(abandoned.promise);
    const view = render(<OfficialUsageImportPanel {...callbacks} initialStagingId={first.id} />);
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readReportStage).mock.calls[0][1];
    view.rerender(<OfficialUsageImportPanel {...callbacks} initialStagingId={second.id} />);
    await screen.findByText("Users", { selector: "strong" });
    view.rerender(<OfficialUsageImportPanel {...callbacks} initialStagingId={first.id} />);
    await screen.findByText("Agents", { selector: "strong" });
    expect(signal?.aborted).toBe(true);
    const calls = vi.mocked(api.previewReportBundle).mock.calls.length;
    await act(async () => abandoned.resolve({ ...first, correctionOfSetId: "abandoned-correction" }));
    expect(api.previewReportBundle).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText(/abandoned-correction/)).not.toBeInTheDocument();
    expect(screen.queryByText("Users", { selector: "strong" })).not.toBeInTheDocument();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("verifies an already accepted complete resume through its receipt without uploading or discarding it", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { status: "accepted" }));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    const verify = await screen.findByRole("button", { name: "Verify saved report set" });
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    fireEvent.click(verify);
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledExactlyOnceWith(bundleId,
      { bundleHash: "b".repeat(64), expectedActiveRevision: "4" }, expect.any(AbortSignal));
    expect(api.stageReport).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
  });
  it("resumes only an explicit staging link, preserving source metadata and correction intent without accepting it", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { correctionOfSetId: reportSetId,
      reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "operator_asserted" },
      sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted", sourceFreshness: "known" }));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    await ready();
    expect(screen.getByRole("status")).toHaveTextContent("This import replaces the saved report");
    expect(screen.queryByLabelText("Reporting start")).not.toBeInTheDocument();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(api.readReportStage).toHaveBeenCalledTimes(3);
  });
  it("preserves the known resumed companion and correction when bundle preview fails", async () => {
    stages = [reportStage("agents", bundleId, { correctionOfSetId: reportSetId })];
    vi.mocked(api.previewReportBundle).mockRejectedValueOnce(new Error("Bundle preview unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    await screen.findByRole("alert");
    expect(screen.getByText("Agents", { selector: "strong" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("This import replaces the saved report");
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("does not fall back to another draft when an explicit staging link is unavailable", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId="missing" />);
    await screen.findByRole("alert");
    expect(api.readReportStage).toHaveBeenCalledOnce();
    expect(api.previewReportBundle).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("does not remount an owned upload or erase its validation failure when persisting its resume link in the real modal", async () => {
    const original = vi.mocked(api.stageReport).getMockImplementation()!;
    vi.mocked(api.stageReport).mockImplementation(async (...args) => {
      if (args[0].name === "bad.csv") throw new ApiError(400, "invalid_schema", "Invalid user CSV");
      return original(...args);
    });
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "import", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0} onChanged={vi.fn()} onImported={vi.fn()} />;
    }
    render(<Host />);
    await choose([files()[0], file("bad.csv")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("bad.csv");
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("bad.csv");
    expect(screen.getByText("agents.csv", { selector: "strong" })).toBeVisible();
    expect(api.readReportStage).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
});
