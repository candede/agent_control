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
const callbacks = { onChanged: vi.fn(), onDone: vi.fn(), onAddMore: vi.fn(), onCancel: vi.fn(), onStaged: vi.fn() };
let stages: OfficialReportPreview[];
let activeRevision: string;
function file(name: string, body = "synthetic streamed CSV") { return new File([body], name, { type: "text/csv" }); }
function files() { return [file("agents.csv"), file("user-agents.csv"), file("users.csv")]; }
async function choose(selected = files()) { await userEvent.upload(screen.getByLabelText("CSV report files"), selected); }
async function ready() { return screen.findByRole("button", { name: "Import reports" }); }
async function accept() { fireEvent.click(await ready()); }
async function imported() { await screen.findByRole("heading", { name: "Reports imported" }); }
beforeEach(() => {
  stages = []; activeRevision = "4";
  const receipts = new Map<string, OfficialReportAccepted>(), acceptedBundles = new Map<string, OfficialReportAccepted>();
  vi.mocked(api.stageReport).mockImplementation(async (file, intent, metadata, signal) => {
    signal?.throwIfAborted();
    const kind = file.name.startsWith("agents") ? "agents" : file.name.startsWith("user-agents") ? "userAgents" : "users";
    if (stages.some(stage => stage.bundleId === intent.bundleId && stage.kind === kind)) throw new ApiError(409, "duplicate_report_kind", "Choose a missing report kind");
    const stage = reportStage(kind, intent.bundleId, { activeRevision, correctionOfSetId: intent.correctionOfSetId ?? null,
      ...(metadata.reportingStart && metadata.reportingEnd ? { reportingPeriod: {
        startDate: metadata.reportingStart, endDate: metadata.reportingEnd, provenance: "operator_asserted",
        days: (Date.parse(metadata.reportingEnd) - Date.parse(metadata.reportingStart)) / 86400000 + 1,
      } } : {}),
      ...(metadata.sourceAsOf ? { sourceAsOf: metadata.sourceAsOf, sourceAsOfProvenance: "operator_asserted", sourceFreshness: "known" } : {}),
    });
    stages.push(stage);
    return structuredClone(stage);
  });
  vi.mocked(api.previewReportBundle).mockImplementation(async (id, signal) => {
    signal?.throwIfAborted();
    return reportBundle(stages.filter(stage => stage.bundleId === id), id, activeRevision);
  });
  vi.mocked(api.readReportStage).mockImplementation(async (id, signal) => {
    signal?.throwIfAborted();
    const stage = stages.find(stage => stage.id === id);
    if (!stage) throw new ApiError(409, "staging_unavailable", "Saved staging link unavailable");
    return structuredClone(stage);
  });
  vi.mocked(api.acceptReportBundle).mockImplementation(async (id, input, signal) => {
    signal?.throwIfAborted();
    const key = JSON.stringify([id, input.bundleHash, input.expectedActiveRevision]);
    const receipt = receipts.get(key);
    if (receipt) return structuredClone(receipt);
    const current = stages.filter(stage => stage.bundleId === id), preview = reportBundle(current, id, activeRevision);
    if (!preview.complete || input.bundleHash !== preview.bundleHash || input.expectedActiveRevision !== preview.expectedActiveRevision) {
      throw new ApiError(409, "bundle_fence_mismatch", "Selection changed");
    }
    let result = acceptedBundles.get(id);
    if (!result) {
      if (!input.preserveSelection && current.some(stage => stage.status !== "accepted")) activeRevision = String(BigInt(activeRevision) + 1n);
      result = { setId: reportSetId, activeRevision, complete: true };
      acceptedBundles.set(id, result);
      stages = stages.map(stage => stage.bundleId === id ? { ...stage, status: "accepted" } : stage);
    }
    receipts.set(key, result);
    return structuredClone(result);
  });
  vi.mocked(api.reportPages.agents).mockImplementation(async () => reportPage([reportAgent()], { reports: { ...reports, activeRevision } }));
  vi.mocked(api.discardReportStage).mockImplementation(async (id, signal) => {
    signal?.throwIfAborted();
    if (stages.some(stage => stage.id === id && stage.status === "accepted")) throw new ApiError(409, "staging_unavailable", "Cannot discard an accepted stage");
    stages = stages.filter(stage => stage.id !== id);
  });
  vi.mocked(api.readReportDiagnostics).mockResolvedValue({ value: [{ ordinal: 0, agentId: "agent-1", username: null, code: "agent_bridge_mismatch" }],
    counts: { total: 100000, filtered: 100000 }, preview: { id: "stage", revision: 1, contentHash: "a".repeat(64) },
    page: { limit: 50, nextCursor: "next-diagnostic", previousCursor: null } });
  vi.mocked(api.previewReportOperation).mockResolvedValue({ id: "selection-confirmation", setId: reportSetId, operation: "select",
    activeRevision: reports.activeRevision, historyRevision: reports.historyRevision, historyEpoch: reports.historyEpoch, hash: "c".repeat(64) });
  vi.mocked(api.confirmReportOperation).mockResolvedValue({ activeSetId: reportSetId, activeRevision: "5" });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("streamed complete-set import confirmation", () => {
  it("uses the server-selected first report without a separate selection request", async () => {
    activeRevision = "1";
    vi.mocked(api.acceptReportBundle).mockImplementationOnce(async (_id, input) => {
      expect(input).toMatchObject({ expectedActiveRevision: "1", preserveSelection: true });
      activeRevision = "2";
      return { setId: reportSetId, activeRevision, complete: true };
    });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await accept();
    await imported();
    expect(api.reportPages.agents).toHaveBeenCalledExactlyOnceWith({ setId: reportSetId, limit: 1 }, expect.any(AbortSignal));
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
  });

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
  it("streams three companions, saves without selecting, verifies exact data and finishes only on Close", async () => {
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
    const preview = reportBundle(stages, id, activeRevision);
    fireEvent.click(confirm);
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledExactlyOnceWith(id,
      { bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision, preserveSelection: true }, expect.any(AbortSignal));
    expect(activeRevision).toBe("4");
    expect(api.reportPages.agents).toHaveBeenCalledWith({ setId: reportSetId, limit: 1 }, expect.any(AbortSignal));
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Add more reports", "Close"]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith();
    expect(api.reportPages.agents).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
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
  it("focuses the accepted summary and closes on Escape without another read or selection", async () => {
    const handle = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={handle} />);
    await choose(); await accept(); await imported();
    expect(screen.getByRole("heading", { name: "Reports imported" })).toHaveFocus();
    act(() => { handle.current?.dismiss(); handle.current?.dismiss(); });
    expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(api.reportPages.agents).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
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
  it("admits one upload and retains cancellation ownership before the busy state renders", async () => {
    const pending = deferred<OfficialReportPreview>();
    vi.mocked(api.stageReport).mockReturnValue(pending.promise);
    const ref = createRef<OfficialUsageImportHandle>();
    const view = render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    const drop = screen.getByText("Drop your three CSV exports here").parentElement!;
    act(() => {
      fireEvent.drop(drop, { dataTransfer: { files: [files()[0]] } });
      fireEvent.drop(drop, { dataTransfer: { files: [files()[0]] } });
      ref.current?.dismiss();
    });
    expect(api.stageReport).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Discard staged import" })).toBeVisible();
    const [, intent, , signal] = vi.mocked(api.stageReport).mock.calls[0];
    expect(signal?.aborted).toBe(false);
    view.unmount();
    await act(async () => pending.resolve(reportStage("agents", intent.bundleId)));
    expect(signal?.aborted).toBe(true);
    expect(api.previewReportBundle).not.toHaveBeenCalled();
  });
  it("admits acceptance once and blocks same-batch dismissal before React applies busy state", async () => {
    const pending = deferred<OfficialReportAccepted>();
    vi.mocked(api.acceptReportBundle).mockReturnValue(pending.promise);
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    await choose();
    const button = await ready();
    act(() => { fireEvent.click(button); fireEvent.click(button); ref.current?.dismiss(); });
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(vi.mocked(api.acceptReportBundle).mock.calls[0][2]?.aborted).toBe(false);
    expect(screen.queryByRole("alertdialog", { name: "Discard staged import" })).not.toBeInTheDocument();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ setId: reportSetId, activeRevision: "5", complete: true }));
    await imported();
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
  });
  it("retires acceptance admission as soon as cancellation is requested, before the prompt renders", async () => {
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    await choose();
    const confirm = await ready();
    act(() => { ref.current?.dismiss(); fireEvent.click(confirm); });
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Discard staged import" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Confirm report import" })).not.toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    fireEvent.click(await ready());
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.previewReportBundle).toHaveBeenCalledOnce();
  });
  it("blocks same-batch file drops after cancellation is requested", async () => {
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    await choose([files()[0]]);
    await screen.findByRole("heading", { name: "Add the remaining reports" });
    const drop = screen.getByText("Add the remaining reports", { selector: "strong" }).parentElement!;
    act(() => { ref.current?.dismiss(); fireEvent.drop(drop, { dataTransfer: { files: files().slice(1) } }); });
    expect(api.stageReport).toHaveBeenCalledOnce();
    expect(screen.getByRole("alertdialog", { name: "Discard staged import" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    await choose(files().slice(1));
    expect(await ready()).toBeEnabled();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it.each(["Close", "Add more reports"] as const)("honors the first completion action %s before rerender", async action => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    const button = screen.getByRole("button", { name: action });
    const other = screen.getByRole("button", { name: action === "Close" ? "Add more reports" : "Close" });
    act(() => { fireEvent.click(button); fireEvent.click(button); fireEvent.click(other); });
    expect(callbacks.onDone).toHaveBeenCalledTimes(action === "Close" ? 1 : 0);
    expect(callbacks.onAddMore).toHaveBeenCalledTimes(action === "Add more reports" ? 1 : 0);
    expect(api.reportPages.agents).toHaveBeenCalledOnce();
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
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
  it.each(["discard", "continue"] as const)("honors the first %s decision before cancellation controls rerender", async first => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await ready();
    const pending = deferred<void>(), discard = vi.mocked(api.discardReportStage).getMockImplementation()!;
    vi.mocked(api.discardReportStage).mockImplementationOnce(async (...args) => { await pending.promise; await discard(...args); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    const discardButton = screen.getByRole("button", { name: "Discard staged import" });
    const continueButton = screen.getByRole("button", { name: "Continue import" });
    act(() => {
      fireEvent.click(first === "discard" ? discardButton : continueButton);
      fireEvent.click(first === "discard" ? continueButton : discardButton);
    });
    if (first === "discard") {
      expect(screen.getByRole("alertdialog", { name: "Discard staged import" })).toBeVisible();
      expect(continueButton).toBeDisabled();
      await waitFor(() => expect(api.discardReportStage).toHaveBeenCalledOnce());
      await act(async () => pending.resolve());
      await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
      expect(stages).toEqual([]);
    } else {
      expect(screen.queryByRole("alertdialog", { name: "Discard staged import" })).not.toBeInTheDocument();
      expect(await ready()).toBeEnabled();
      expect(api.previewReportBundle).toHaveBeenCalledOnce();
      expect(api.discardReportStage).not.toHaveBeenCalled();
      expect(callbacks.onCancel).not.toHaveBeenCalled();
    }
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });
  it.each([
    ["duplicate", "Close"], ["duplicate", "Escape"],
    ["correction", "Close"], ["correction", "Escape"],
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
    await imported();
    const acceptedStages = stages.map(stage => ({ ...stage }));
    expect(acceptedStages).toHaveLength(3);
    expect(acceptedStages.every(stage => stage.status === "accepted" && stage.correctionOfSetId === (correctionOfSetId ?? null))).toBe(true);
    if (action === "Escape") fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    else fireEvent.click(screen.getByRole("button", { name: action }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(callbacks.onDone).toHaveBeenCalledOnce();
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
  it("adds another report set in a fresh wizard without discarding saved reports or selecting either import", async () => {
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "import", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0} onChanged={callbacks.onChanged} />;
    }
    render(<Host />);
    await choose(); await accept(); await imported();
    const first = stages.map(stage => ({ ...stage }));
    fireEvent.click(screen.getByRole("button", { name: "Add more reports" }));
    expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "Reports imported" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Selected CSV files" })).not.toBeInTheDocument();
    await choose(); await accept(); await imported();
    expect(stages.slice(0, 3)).toEqual(first);
    expect(stages[3].bundleId).not.toBe(first[0].bundleId);
    expect(stages.every(stage => stage.status === "accepted")).toBe(true);
    expect(callbacks.onChanged).toHaveBeenCalledTimes(2);
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(activeRevision).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    const discard = screen.getByRole("button", { name: "Discard staged import" });
    act(() => { fireEvent.click(discard); fireEvent.click(discard); });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText("Checking...")).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for upload cancellation...")).toBeVisible();
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
  it("retires an aborted file's checking state when cleanup fails and continuation verifies an empty bundle", async () => {
    const pending = deferred<OfficialReportPreview>();
    vi.mocked(api.stageReport).mockReturnValueOnce(pending.promise);
    vi.mocked(api.previewReportBundle).mockRejectedValueOnce(new Error("Cleanup lookup unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await act(async () => pending.reject(new ApiError(0, "request_aborted", "Upload cancelled", { kind: "aborted" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cleanup lookup unavailable");
    expect(screen.queryByText("Checking...")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    expect(await screen.findByText("Still needed: Agents, Users & agents, Users.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Selected CSV files" })).not.toBeInTheDocument();
    expect(api.stageReport).toHaveBeenCalledOnce();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });
  it("recovers a lost first-upload receipt from its owned bundle without uploading that companion twice", async () => {
    const upload = vi.mocked(api.stageReport).getMockImplementation()!;
    vi.mocked(api.stageReport).mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new ApiError(0, "network_error", "Upload response lost", { kind: "network" });
    });
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "import", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0}
        onChanged={callbacks.onChanged} onImported={callbacks.onDone} />;
    }
    render(<Host />);
    await choose([files()[0]]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload response lost");
    expect(screen.getByText("Upload needs attention")).toBeVisible();
    expect(screen.queryByText("Could not import")).not.toBeInTheDocument();
    const id = vi.mocked(api.stageReport).mock.calls[0][1].bundleId;
    expect(api.previewReportBundle).toHaveBeenCalledExactlyOnceWith(id, expect.any(AbortSignal));
    expect(api.readReportStage).toHaveBeenCalledExactlyOnceWith(stages[0].id, expect.any(AbortSignal));
    expect(screen.getByText("Agents", { selector: "strong" })).toBeVisible();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    await choose(files().slice(1));
    expect(await ready()).toBeEnabled();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(api.readReportStage).toHaveBeenCalledOnce();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
  it.each(["discard", "continue"] as const)("retains unknown first-upload cleanup ownership when bundle recovery fails (%s)", async action => {
    const upload = vi.mocked(api.stageReport).getMockImplementation()!;
    vi.mocked(api.stageReport).mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new Error("Upload response lost");
    });
    vi.mocked(api.previewReportBundle).mockRejectedValueOnce(new Error("Bundle lookup unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([files()[0]]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Upload response lost");
    expect(screen.getByRole("button", { name: "Refresh bundle validation" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Discard staged import" })).toBeVisible();
    if (action === "discard") {
      const stagedId = stages[0].id;
      fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
      await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
      expect(api.discardReportStage).toHaveBeenCalledExactlyOnceWith(stagedId, expect.any(AbortSignal));
      expect(stages).toEqual([]);
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
      expect(await screen.findByText("Still needed: Users & agents, Users.")).toBeVisible();
      expect(screen.getByText("Agents", { selector: "strong" })).toBeVisible();
      expect(callbacks.onCancel).not.toHaveBeenCalled();
    }
    expect(api.stageReport).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });
  it("keeps a failed resume lookup owned until cancellation resolves and discards its exact bundle", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId));
    const ownedIds = stages.map(stage => stage.id);
    vi.mocked(api.readReportStage).mockRejectedValueOnce(new Error("Draft lookup unavailable"));
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({
        view: "import", stagingId: ownedIds[0], activityWindowDays: 30,
      });
      return <OfficialUsageImportModal route={route} onRouteChange={next => {
        if (!next) callbacks.onCancel();
        setRoute(next);
      }} canManage revision={0} onChanged={callbacks.onChanged} onImported={callbacks.onDone} />;
    }
    render(<Host />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Draft lookup unavailable");
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(vi.mocked(api.discardReportStage).mock.calls.map(([id]) => id)).toEqual(ownedIds);
    expect(api.previewReportBundle).toHaveBeenCalledExactlyOnceWith(bundleId, expect.any(AbortSignal), { forDiscard: true });
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });
  it("clears a discarded resume link when continuation verifies that cleanup completed despite its lost response", async () => {
    const routes = vi.fn();
    const discard = vi.mocked(api.discardReportStage).getMockImplementation()!;
    vi.mocked(api.discardReportStage).mockImplementationOnce(async (...args) => {
      await discard(...args);
      throw new Error("Cleanup response lost");
    });
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState | undefined>({ view: "import", activityWindowDays: 30 });
      return <OfficialUsageImportModal route={route} onRouteChange={next => { routes(next); setRoute(next); }}
        canManage revision={0} onChanged={callbacks.onChanged} onImported={callbacks.onDone} />;
    }
    render(<Host />);
    await choose([files()[0]]);
    await screen.findByRole("heading", { name: "Add the remaining reports" });
    const intent = vi.mocked(api.stageReport).mock.calls[0][1];
    expect(routes).toHaveBeenLastCalledWith(expect.objectContaining({ stagingId: stages[0].id }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cleanup response lost");
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    expect(await screen.findByText("Still needed: Agents, Users & agents, Users.")).toBeVisible();
    expect(routes).toHaveBeenLastCalledWith({ view: "import", activityWindowDays: 30, stagingId: undefined });
    expect(screen.queryByRole("list", { name: "Selected CSV files" })).not.toBeInTheDocument();
    expect(api.readReportStage).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    await choose();
    expect(await ready()).toBeEnabled();
    expect(vi.mocked(api.stageReport).mock.calls.every(([, next]) => next.bundleId === intent.bundleId)).toBe(true);
    expect(api.readReportStage).toHaveBeenCalledOnce();
  });
  it.each(["resolve", "reject"] as const)("resolves the linked bundle before cancelling a pending resume that later %ss", async outcome => {
    const pending = deferred<OfficialReportPreview>();
    const unrelated = reportStage("agents", "another-bundle", { id: "another-stage" });
    stages = [...kinds.map(kind => reportStage(kind, bundleId)), unrelated];
    const first = stages[0], ownedIds = stages.slice(0, 3).map(stage => stage.id);
    vi.mocked(api.readReportStage).mockReturnValueOnce(pending.promise);
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={first.id} />);
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(api.readReportStage).mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    expect(oldSignal?.aborted).toBe(true);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "resolve") pending.resolve(first);
      else pending.reject(new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" }));
    });
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.previewReportBundle).toHaveBeenCalledExactlyOnceWith(bundleId, expect.any(AbortSignal), { forDiscard: true });
    expect(vi.mocked(api.discardReportStage).mock.calls.map(([id]) => id)).toEqual(ownedIds);
    expect(stages).toEqual([unrelated]);
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(callbacks.onStaged).not.toHaveBeenCalled();
  });
  it("keeps failed cancellation lookup recoverable without admitting uploads into a substitute bundle", async () => {
    const pending = deferred<OfficialReportPreview>();
    stages = kinds.map(kind => reportStage(kind, bundleId));
    vi.mocked(api.readReportStage).mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("Draft lookup unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await act(async () => pending.resolve(stages[0]));
    expect(await screen.findByRole("alert")).toHaveTextContent("Draft lookup unavailable");
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(api.previewReportBundle).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    expect(screen.queryByRole("button", { name: "Choose CSV files" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload saved draft" }));
    expect(await ready()).toBeEnabled();
    expect(api.previewReportBundle).toHaveBeenCalledExactlyOnceWith(bundleId, expect.any(AbortSignal));
    expect(api.stageReport).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("retains every remaining companion when cleanup of a still-loading draft fails partway", async () => {
    const pending = deferred<OfficialReportPreview>();
    stages = kinds.map(kind => reportStage(kind, bundleId, { correctionOfSetId: reportSetId }));
    const first = stages[0];
    vi.mocked(api.readReportStage).mockReturnValueOnce(pending.promise);
    const discard = vi.mocked(api.discardReportStage).getMockImplementation()!;
    vi.mocked(api.discardReportStage).mockImplementationOnce(discard).mockRejectedValueOnce(new Error("Second discard unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={first.id} />);
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await act(async () => pending.resolve(first));
    expect(await screen.findByRole("alert")).toHaveTextContent("Second discard unavailable");
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    expect(await screen.findByText("Still needed: Agents.")).toBeVisible();
    expect(screen.getByText("Users & agents", { selector: "strong" })).toBeVisible();
    expect(screen.getByText("Users", { selector: "strong" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("This import replaces the saved report");
    await choose([files()[0]]);
    expect(await ready()).toBeEnabled();
    expect(api.stageReport).toHaveBeenCalledExactlyOnceWith(expect.any(File),
      { bundleId, correctionOfSetId: reportSetId, rejectDuplicateKind: true }, expect.any(Object), expect.any(AbortSignal));
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
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
  it("restores correction metadata when continuing an interrupted bundle-only resume after partial cleanup", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { correctionOfSetId: reportSetId,
      reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "operator_asserted" },
      sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted" }));
    const first = stages[0], pending = deferred<OfficialReportPreview>();
    vi.mocked(api.readReportStage).mockReturnValueOnce(pending.promise);
    const discard = vi.mocked(api.discardReportStage).getMockImplementation()!;
    vi.mocked(api.discardReportStage).mockImplementationOnce(discard).mockRejectedValueOnce(new Error("Second discard unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} initialBundleId={bundleId} />);
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await act(async () => pending.resolve(first));
    expect(await screen.findByRole("alert")).toHaveTextContent("Second discard unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Continue import" }));
    expect(await screen.findByText("Still needed: Agents.")).toBeVisible();
    await choose([files()[0]]);
    expect(await ready()).toBeEnabled();
    expect(api.stageReport).toHaveBeenCalledExactlyOnceWith(expect.any(File),
      { bundleId, correctionOfSetId: reportSetId, rejectDuplicateKind: true },
      { reportingStart: "2026-01-01", reportingEnd: "2026-01-31", periodProvenance: "operator_asserted",
        sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted" }, expect.any(AbortSignal));
    expect(screen.getByRole("status")).toHaveTextContent("This import replaces the saved report");
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });
  it("cancels an already accepted resume without deleting its staged receipts or republishing", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { status: "accepted", correctionOfSetId: "previous-set" }));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    await screen.findByRole("button", { name: "Verify saved report set" });
    const inspection = deferred<Awaited<ReturnType<typeof api.previewReportBundle>>>();
    vi.mocked(api.previewReportBundle).mockReturnValueOnce(inspection.promise);
    fireEvent.click(screen.getByRole("button", { name: "Close saved import" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    expect(screen.queryByText(/This import replaces the saved report/)).not.toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("The import stays open if cleanup cannot be verified.");
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    await act(async () => inspection.resolve(reportBundle(stages, bundleId)));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(stages).toHaveLength(3);
  });
  it("discards every companion of an incompatible resumed bundle without accepting it or touching other drafts", async () => {
    const unrelated = reportStage("agents", "unrelated-bundle", { id: "unrelated-stage" });
    const owned = kinds.map(kind => reportStage(kind, bundleId, {
      sourceAsOf: `2026-02-0${kinds.indexOf(kind) + 1}T00:00:00.000Z`, sourceAsOfProvenance: "operator_asserted",
    }));
    stages = [...owned, unrelated];
    vi.mocked(api.previewReportBundle).mockImplementation(async (id, _signal, options) => {
      if (!options?.forDiscard) throw new ApiError(409, "incompatible_bundle", "Report observation bases differ.");
      return reportBundle(stages.filter(stage => stage.bundleId === id), id);
    });
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={owned[0].id} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Report observation bases differ.");
    expect(screen.queryByRole("button", { name: "Import reports" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    const discard = screen.getByRole("button", { name: "Discard staged import" });
    act(() => { fireEvent.click(discard); fireEvent.click(discard); });
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.previewReportBundle).toHaveBeenLastCalledWith(bundleId, expect.any(AbortSignal), { forDiscard: true });
    expect(vi.mocked(api.discardReportStage).mock.calls.map(([id]) => id)).toEqual(owned.map(stage => stage.id));
    expect(stages).toEqual([unrelated]);
    expect(api.stageReport).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
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
    const acceptBundle = vi.mocked(api.acceptReportBundle).getMockImplementation()!;
    vi.mocked(api.acceptReportBundle).mockImplementationOnce(async (...args) => {
      await acceptBundle(...args);
      throw new ApiError(503, "response_lost", "Acceptance response interrupted");
    });
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    await choose(); await accept();
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Cancel import" })).toBeDisabled();
    act(() => ref.current?.dismiss());
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(activeRevision).toBe("4");
    expect(stages.every(stage => stage.status === "accepted")).toBe(true);
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Verify acceptance" }));
    await imported();
    const calls = vi.mocked(api.acceptReportBundle).mock.calls;
    expect(calls[1][1]).toBe(calls[0][1]);
    expect(api.previewReportBundle).toHaveBeenCalledOnce();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(activeRevision).toBe("4");
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
  });
  it("requires explicit validation refresh and another acceptance after a definite revision conflict", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await ready();
    activeRevision = "9";
    await accept();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Refresh bundle validation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import reports" })).toBeEnabled());
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    await accept(); await imported();
    expect(vi.mocked(api.acceptReportBundle).mock.calls[1][1].expectedActiveRevision).toBe("9");
    expect(vi.mocked(api.acceptReportBundle).mock.calls[1][1].bundleHash).not.toBe(vi.mocked(api.acceptReportBundle).mock.calls[0][1].bundleHash);
    expect(api.stageReport).toHaveBeenCalledTimes(3);
  });
  it.each(["upload", "resume"] as const)("refreshes cached %s receipt status when another tab has accepted the reviewed correction bundle", async source => {
    if (source === "resume") stages = kinds.map(kind => reportStage(kind, bundleId, { correctionOfSetId: "previous-set" }));
    vi.mocked(api.acceptReportBundle).mockRejectedValueOnce(new ApiError(409, "bundle_fence_mismatch", "Selection changed"));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0]?.id} correctionOfSetId="previous-set" />);
    if (source === "upload") await choose();
    await accept();
    await screen.findByRole("alert");
    const delivered = await Promise.all((source === "upload" ? vi.mocked(api.stageReport) : vi.mocked(api.readReportStage)).mock.results
      .map(result => result.value));
    stages.forEach(stage => { stage.status = "accepted"; });
    activeRevision = "5";
    expect(delivered.every(stage => stage.status === "active")).toBe(true);
    const readback = deferred<OfficialReportPreview>();
    vi.mocked(api.readReportStage).mockReturnValueOnce(readback.promise);
    const refresh = screen.getByRole("button", { name: "Refresh bundle validation" });
    act(() => { fireEvent.click(refresh); fireEvent.click(refresh); });
    const initialReads = source === "resume" ? 3 : 0;
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledTimes(initialReads + 1));
    expect(screen.queryByRole("heading", { name: "Ready to import" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import reports" })).not.toBeInTheDocument();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    await act(async () => readback.resolve(stages[0]));
    expect(await screen.findByRole("heading", { name: "Reports already saved" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Verify saved report set" })).toBeEnabled();
    expect(screen.queryByText(/This import replaces the saved report/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reports imported" })).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Selected CSV files" });
    expect([...list.querySelectorAll("strong")].map(name => name.textContent)).toEqual(source === "upload"
      ? ["agents.csv", "user-agents.csv", "users.csv"] : ["Agents", "Users & agents", "Users"]);
    expect(api.previewReportBundle).toHaveBeenCalledTimes(2);
    expect(api.readReportStage).toHaveBeenCalledTimes(initialReads + 3);
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.stageReport).toHaveBeenCalledTimes(source === "upload" ? 3 : 0);
    expect(api.discardReportStage).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "expired"] as const)("retains exact cleanup ownership when a cached receipt's %s revalidation fails", async failure => {
    vi.mocked(api.acceptReportBundle).mockRejectedValueOnce(new ApiError(409, "bundle_fence_mismatch", "Selection changed"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    await screen.findByRole("alert");
    vi.mocked(api.readReportStage).mockImplementationOnce(async id => {
      if (failure === "expired") stages = stages.filter(stage => stage.id !== id);
      throw new ApiError(failure === "expired" ? 409 : 503,
        failure === "expired" ? "staging_unavailable" : "unavailable", "Receipt revalidation failed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh bundle validation" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Receipt revalidation failed"));
    expect(screen.queryByRole("button", { name: "Import reports" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reports already saved" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reports imported" })).not.toBeInTheDocument();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    const remaining = stages.map(stage => stage.id);
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(vi.mocked(api.discardReportStage).mock.calls.map(([id]) => id)).toEqual(remaining);
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });
  it.each(["discard", "continue"] as const)("retains its resolved bundle and correction metadata after a companion becomes unavailable (%s)", async action => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { correctionOfSetId: reportSetId,
      reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "operator_asserted" },
      sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted" }));
    vi.mocked(api.acceptReportBundle).mockImplementationOnce(async () => {
      stages = stages.filter(stage => stage.kind !== "agents");
      throw new ApiError(409, "staging_unavailable", "A companion expired during acceptance");
    });
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    await accept();
    expect(await screen.findByRole("alert")).toHaveTextContent("A companion expired");
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    if (action === "discard") {
      const remaining = stages.map(stage => stage.id);
      fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
      fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
      await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
      expect(vi.mocked(api.discardReportStage).mock.calls.map(([id]) => id)).toEqual(remaining);
      expect(stages).toEqual([]);
      expect(api.stageReport).not.toHaveBeenCalled();
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Refresh bundle validation" }));
      expect(await screen.findByText("Still needed: Agents.")).toBeVisible();
      await choose([files()[0]]);
      expect(await ready()).toBeEnabled();
      expect(api.stageReport).toHaveBeenCalledExactlyOnceWith(expect.any(File),
        { bundleId, correctionOfSetId: reportSetId, rejectDuplicateKind: true },
        { reportingStart: "2026-01-01", reportingEnd: "2026-01-31", periodProvenance: "operator_asserted",
          sourceAsOf: "2026-02-01T00:00:00.000Z", sourceAsOfProvenance: "operator_asserted" }, expect.any(AbortSignal));
      expect(api.discardReportStage).not.toHaveBeenCalled();
    }
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
  });
  it("retries failed exact readback without accepting or uploading twice", async () => {
    vi.mocked(api.reportPages.agents).mockRejectedValueOnce(new ApiError(503, "data_read_conflict", "Readback unavailable"));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    expect(await screen.findByRole("alert")).toHaveTextContent(/saved/i);
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close saved import" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel import" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Verify saved import" }));
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
  });
  it("invalidates saved views after acceptance without waiting for readback or repeating invalidation on retries", async () => {
    const readback = deferred<Awaited<ReturnType<typeof api.reportPages.agents>>>();
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    vi.mocked(api.reportPages.agents).mockReturnValueOnce(readback.promise);
    await accept();
    await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalledOnce());
    expect(screen.queryByRole("heading", { name: "Reports imported" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Verifying import...");
    expect(screen.queryByText("The imported report is saved, but another report is currently selected.")).not.toBeInTheDocument();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    await act(async () => readback.reject(new ApiError(503, "data_read_conflict", "Readback unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("saved");
    fireEvent.click(screen.getByRole("button", { name: "Verify saved import" }));
    await imported();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(callbacks.onDone).toHaveBeenCalledOnce());
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
  });
  it("does not substitute another report for exact accepted verification", async () => {
    vi.mocked(api.reportPages.agents).mockResolvedValue(reportPage([], { reports: { ...reports, setId: "different" } }));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(callbacks.onDone).not.toHaveBeenCalled();
  });
  it.each([null, "other", reportSetId])("shows the same summary with selected report %s and never offers selection", async activeSetId => {
    vi.mocked(api.reportPages.agents).mockResolvedValue(reportPage([reportAgent()], { reports: { ...reports, activeSetId } }));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    expect(screen.getByRole("heading", { name: "Reports imported" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Your report set has been saved.");
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["Add more reports", "Close"]);
    expect(screen.queryByText(/another report is currently selected|keep the current selection/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(activeRevision).toBe("4");
  });
  it("cannot close a replacement session through a retired saved-import handle", async () => {
    const ref = createRef<OfficialUsageImportHandle>();
    const view = render(<OfficialUsageImportPanel {...callbacks} ref={ref} />);
    await choose(); await accept(); await imported();
    const retired = ref.current;
    view.unmount();
    render(<OfficialUsageImportPanel {...callbacks} />);
    act(() => retired?.dismiss());
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
    expect(api.reportPages.agents).toHaveBeenCalledOnce();
  });
  it("closes without reading or changing a shared selection updated after the summary", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    vi.mocked(api.reportPages.agents).mockResolvedValueOnce(reportPage([], { reports: { ...reports, activeSetId: "another-report" } }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(api.reportPages.agents).toHaveBeenCalledOnce();
    expect(api.previewReportOperation).not.toHaveBeenCalled();
    expect(api.confirmReportOperation).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).toHaveBeenCalledOnce();
  });
  it("closes without navigating to or rechecking a report deleted after the summary", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose(); await accept(); await imported();
    vi.mocked(api.reportPages.agents).mockRejectedValueOnce(new ApiError(404, "report_set_unavailable", "Report deleted"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(callbacks.onDone).toHaveBeenCalledOnce();
    expect(api.reportPages.agents).toHaveBeenCalledOnce();
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
  it.each([
    ["upload", 401], ["upload", 403], ["resume", 401], ["resume", 403],
  ] as const)("dismisses denied %s status %i with Escape without retrying cleanup", async (source, status) => {
    const error = new ApiError(status, "denied", "Import access denied");
    if (source === "upload") vi.mocked(api.stageReport).mockRejectedValueOnce(error);
    else vi.mocked(api.readReportStage).mockRejectedValueOnce(error);
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState>();
      return <>
        <button onClick={() => setRoute({ view: "import", activityWindowDays: 30,
          stagingId: source === "resume" ? "denied-stage" : undefined })}>Open reports</button>
        <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0}
          onChanged={callbacks.onChanged} onImported={callbacks.onDone} />
      </>;
    }
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Open reports" });
    await userEvent.click(opener);
    if (source === "upload") await choose([files()[0]]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Import access denied");
    expect(screen.getByRole("button", { name: "Back to Sync" })).toBeEnabled();
    fireEvent.focus(window);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.stageReport).toHaveBeenCalledTimes(source === "upload" ? 1 : 0);
    expect(api.readReportStage).toHaveBeenCalledTimes(source === "resume" ? 1 : 0);
    expect(api.previewReportBundle).not.toHaveBeenCalled();
    expect(api.discardReportStage).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    expect(callbacks.onDone).not.toHaveBeenCalled();
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
  it.each(["resume", "bundle", "verification", "discard"] as const)(
    "retires pending %s work and its callbacks on an account transition", async phase => {
      const stageRead = deferred<OfficialReportPreview>();
      const bundleRead = deferred<Awaited<ReturnType<typeof api.previewReportBundle>>>();
      const verification = deferred<Awaited<ReturnType<typeof api.reportPages.agents>>>();
      const discard = deferred<void>();
      if (phase === "resume") {
        stages = kinds.map(kind => reportStage(kind, bundleId));
        vi.mocked(api.readReportStage).mockReturnValueOnce(stageRead.promise);
      } else if (phase === "bundle") vi.mocked(api.previewReportBundle).mockReturnValueOnce(bundleRead.promise);
      else if (phase === "verification") vi.mocked(api.reportPages.agents).mockReturnValueOnce(verification.promise);
      else if (phase === "discard") vi.mocked(api.discardReportStage).mockReturnValueOnce(discard.promise);
      const content = (homeAccountId: string) => <CapabilityContext value={{
        user: { tenantId: "tenant", homeAccountId, username: `${homeAccountId}@example.invalid`, displayName: homeAccountId,
          roles: ["AgentControl.Admin"] }, views: [], now: Date.now(), pending: false, loading: false, error: undefined,
        reload: vi.fn(), openPermissions: vi.fn(),
      }}><OfficialUsageImportPanel {...callbacks} initialStagingId={phase === "resume" && homeAccountId === "first" ? stages[0].id : undefined} /></CapabilityContext>;
      const view = render(content("first"));
      if (phase !== "resume") await choose();
      if (phase === "verification") await accept();
      if (phase === "discard") {
        await ready();
        fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
        fireEvent.click(screen.getByRole("button", { name: "Discard staged import" }));
      }
      const signal = () => phase === "resume" ? vi.mocked(api.readReportStage).mock.lastCall?.[1]
        : phase === "bundle" ? vi.mocked(api.previewReportBundle).mock.lastCall?.[1]
          : phase === "verification" ? vi.mocked(api.reportPages.agents).mock.lastCall?.[1]
            : vi.mocked(api.discardReportStage).mock.lastCall?.[1];
      await waitFor(() => expect(signal()).toBeInstanceOf(AbortSignal));
      const retired = signal()!, changed = callbacks.onChanged.mock.calls.length, staged = callbacks.onStaged.mock.calls.length;
      view.rerender(content("replacement"));
      expect(retired.aborted).toBe(true);
      expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
      await act(async () => {
        stageRead.resolve(stages[0]);
        bundleRead.resolve(reportBundle(stages, stages[0].bundleId));
        verification.resolve(reportPage([reportAgent()]));
        discard.resolve();
      });
      expect(callbacks.onChanged).toHaveBeenCalledTimes(changed);
      expect(callbacks.onStaged).toHaveBeenCalledTimes(staged);
      expect(callbacks.onDone).not.toHaveBeenCalled();
      expect(callbacks.onCancel).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Selected CSV files" })).not.toBeInTheDocument();
      expect(api.confirmReportOperation).not.toHaveBeenCalled();
      if (phase === "discard") expect(api.discardReportStage).toHaveBeenCalledOnce();
    });
  it("keeps staged work through unchanged-role capability revalidation without duplicate reads", async () => {
    const content = (loading: boolean) => <CapabilityContext value={{
      user: { tenantId: "tenant", homeAccountId: "operator", username: "operator@example.invalid", displayName: "Operator",
        roles: loading ? ["AgentControl.Viewer", "AgentControl.Admin"] : ["AgentControl.Admin", "AgentControl.Viewer"] },
      views: [], now: Date.now(), pending: loading, loading, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><OfficialUsageImportPanel {...callbacks} /></CapabilityContext>;
    const view = render(content(false));
    await choose(); await ready();
    view.rerender(content(true));
    expect(await ready()).toBeEnabled();
    view.rerender(content(false));
    expect(await ready()).toBeEnabled();
    expect(api.stageReport).toHaveBeenCalledTimes(3);
    expect(api.previewReportBundle).toHaveBeenCalledOnce();
    expect(api.readReportStage).not.toHaveBeenCalled();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("fences an explicit staging A-B-A transition even when its abandoned first read resolves last", async () => {
    const abandoned = deferred<OfficialReportPreview>();
    const first = reportStage("agents", bundleId), second = reportStage("agents", "60000000-0000-4000-8000-000000000002", { rowCount: 2 });
    stages = [first, second];
    vi.mocked(api.readReportStage).mockReturnValueOnce(abandoned.promise);
    const view = render(<OfficialUsageImportPanel {...callbacks} initialStagingId={first.id} />);
    await waitFor(() => expect(api.readReportStage).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.readReportStage).mock.calls[0][1];
    view.rerender(<OfficialUsageImportPanel {...callbacks} initialStagingId={second.id} />);
    await screen.findByText("Agents - 2 rows");
    view.rerender(<OfficialUsageImportPanel {...callbacks} initialStagingId={first.id} />);
    await screen.findByText("Agents - 100,000 rows");
    expect(signal?.aborted).toBe(true);
    const calls = vi.mocked(api.previewReportBundle).mock.calls.length;
    await act(async () => abandoned.resolve({ ...first, correctionOfSetId: "abandoned-correction" }));
    expect(api.previewReportBundle).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText(/abandoned-correction/)).not.toBeInTheDocument();
    expect(screen.queryByText("Agents - 2 rows")).not.toBeInTheDocument();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
  });
  it("verifies an already accepted complete resume through its receipt without uploading or discarding it", async () => {
    stages = kinds.map(kind => reportStage(kind, bundleId, { status: "accepted", correctionOfSetId: "previous-set" }));
    const acceptance = deferred<OfficialReportAccepted>();
    vi.mocked(api.acceptReportBundle).mockReturnValueOnce(acceptance.promise);
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={stages[0].id} />);
    const verify = await screen.findByRole("button", { name: "Verify saved report set" });
    expect(screen.getByRole("heading", { name: "Reports already saved" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Ready to import" })).not.toBeInTheDocument();
    expect(screen.queryByText("All three reports are ready to add.")).not.toBeInTheDocument();
    expect(screen.queryByText(/This import replaces the saved report/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reports imported" })).not.toBeInTheDocument();
    expect(api.acceptReportBundle).not.toHaveBeenCalled();
    const preview = reportBundle(stages, bundleId, activeRevision);
    act(() => { fireEvent.click(verify); fireEvent.click(verify); });
    expect(screen.getByRole("status")).toHaveTextContent("Verifying saved report set...");
    expect(screen.queryByText("Importing reports...")).not.toBeInTheDocument();
    await act(async () => acceptance.resolve({ setId: reportSetId, activeRevision: "5", complete: true }));
    await imported();
    expect(api.acceptReportBundle).toHaveBeenCalledExactlyOnceWith(bundleId,
      { bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision, preserveSelection: true }, expect.any(AbortSignal));
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
    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(api.discardReportStage).not.toHaveBeenCalled();
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
