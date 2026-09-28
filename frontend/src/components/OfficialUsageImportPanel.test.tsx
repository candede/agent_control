import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfficialUsageAdminState, OfficialUsageBundlePreview, OfficialUsageConfirmation,
  OfficialUsageReportKind, OfficialUsageStagingPreview,
} from "../api/client";
import { ApiError } from "../api/client";
import { OfficialUsageImportPanel, type OfficialUsageImportHandle } from "./OfficialUsageImportPanel";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { usageAggregateFixture, usageInsightsPublished } from "../test/usageInsightsFixture";
import { mockNativeDialogs } from "../test/dialog";
import type { SyncReportRouteState } from "../workbenchRouting";

mockNativeDialogs();
const api = vi.hoisted(() => ({
  accept: vi.fn(), confirm: vi.fn(), discard: vi.fn(), admin: vi.fn(), aggregate: vi.fn(),
  preview: vi.fn(), selection: vi.fn(), stage: vi.fn(),
}));
vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  acceptOfficialUsageBundle: api.accept,
  confirmOfficialUsageSetOperation: api.confirm,
  discardOfficialUsageStaging: api.discard,
  getOfficialUsageAdminState: api.admin,
  getOfficialUsageAggregate: api.aggregate,
  previewOfficialUsageBundle: api.preview,
  previewOfficialUsageSetOperation: api.selection,
  stageOfficialUsageReport: api.stage,
}));

const kinds: OfficialUsageReportKind[] = ["agents", "userAgents", "users"];
const setId = "33333333-3333-4333-8333-333333333333";
const bundleId = "22222222-2222-4222-8222-222222222222";
const reportSet = { ...usageInsightsPublished.activeSet!, id: setId, bundleId };
const callbacks = { onChanged: vi.fn(), onDone: vi.fn(), onCancel: vi.fn() };
let state: OfficialUsageAdminState;

function stage(kind: OfficialUsageReportKind, bundle = bundleId): OfficialUsageStagingPreview {
  return {
    id: crypto.randomUUID(), revision: 1, status: "active", kind, fileHash: "a".repeat(64),
    parserVersion: "1", schemaVersion: `m365-${kind}-observed-v1`, bundleId: bundle, correctionOfSetId: null,
    reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", provenance: "activity_range" },
    sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", downloadedAt: null,
    rowCount: 12, warnings: ["Source refresh time is unknown."], reconciliation: {}, activeRevision: 1,
    acceptedVersionId: null, acceptedSetId: null, createdAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-30T12:30:00.000Z", acceptedAt: null,
  };
}

function file(name: string) { return new File(["CSV content"], name, { type: "text/csv" }); }
const csvs = () => [file("agents.csv"), file("user-agents.csv"), file("users.csv")];
async function choose(files = csvs()) {
  await userEvent.upload(screen.getByLabelText("Official usage CSV files"), files);
}
async function imported() {
  await screen.findByRole("heading", { name: /^Reports (?:already )?imported$/ });
  expect(screen.getByRole("button", { name: "OK" })).toBeEnabled();
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  state = { activeSetId: null, activeRevision: 1, staging: [], sets: [] };
  api.admin.mockImplementation(async () => structuredClone(state));
  api.aggregate.mockImplementation(async ({ setId: requestedId }) => {
    const data = usageAggregateFixture();
    data.activeSet = { ...reportSet, id: requestedId };
    return data;
  });
  api.stage.mockImplementation(async (file: File, input: { bundleId: string; correctionOfSetId?: string }) => {
    const kind = file.name.startsWith("agents") ? "agents" : file.name.startsWith("user-agents") ? "userAgents" : "users";
    if (state.staging.some(item => item.bundleId === input.bundleId && item.kind === kind && item.status === "active")) {
      throw new ApiError(409, "duplicate_report_kind", "An Agents report is already included. Choose the missing report type.");
    }
    const next = { ...stage(kind, input.bundleId), correctionOfSetId: input.correctionOfSetId ?? null };
    state.staging.push(next);
    return next;
  });
  api.preview.mockImplementation(async (id: string): Promise<OfficialUsageBundlePreview> => {
    const staging = state.staging.filter(item => item.bundleId === id && item.status === "active");
    return {
      bundleId: id, bundleHash: "b".repeat(64), expectedActiveRevision: state.activeRevision, staging,
      acceptedVersions: [], missingKinds: kinds.filter(kind => !staging.some(item => item.kind === kind)),
      reconciliation: { responses: { agents: 10, userAgents: 9, users: 11 } },
    };
  });
  let receipt: { setId: string; versionId: string; complete: boolean; activeRevision: number; reusedExistingSet: boolean } | undefined;
  api.accept.mockImplementation(async (preview: OfficialUsageBundlePreview) => {
    if (receipt) return receipt;
    state.activeSetId = setId;
    state.activeRevision += 1;
    state.sets = [{ ...reportSet, bundleId: preview.bundleId }];
    state.staging = state.staging.map(item => item.bundleId === preview.bundleId ? { ...item, status: "accepted" } : item);
    receipt = { setId, versionId: "version", complete: true, activeRevision: state.activeRevision, reusedExistingSet: false };
    return receipt;
  });
  api.discard.mockImplementation(async (id: string) => {
    state.staging = state.staging.map(item => item.id === id ? { ...item, status: "cancelled" } : item);
  });
  api.selection.mockImplementation(async (id: string): Promise<OfficialUsageConfirmation> => ({
    id: "selection", operation: "select", setId: id, expectedRevision: state.activeRevision,
    activeSetId: state.activeSetId, confirmationHash: "c".repeat(64), expiresAt: "2026-09-30T12:30:00Z",
  }));
  api.confirm.mockImplementation(async (confirmation: OfficialUsageConfirmation) => {
    state.activeSetId = confirmation.setId;
    state.activeRevision += 1;
    return { activeSetId: state.activeSetId, activeRevision: state.activeRevision };
  });
});

describe("automatic CSV report import", () => {
  it("starts empty even with saved reports and staged imports, including StrictMode replay", () => {
    state.staging = kinds.map(kind => stage(kind));
    state.sets = [reportSet];
    render(<OfficialUsageImportPanel {...callbacks} />, { reactStrictMode: true });
    expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(api.admin).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
    expect(screen.queryByText(/Review|Technical validation|hash|Refresh import/)).not.toBeInTheDocument();
  });

  it("automatically validates and imports all three exports, verifies them, then offers only OK", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    expect(api.stage).toHaveBeenCalledTimes(3);
    const id = api.stage.mock.calls[0][1].bundleId;
    for (const call of api.stage.mock.calls) {
      expect(call[1]).toEqual({ bundleId: id, rejectDuplicateKind: true });
      expect(call[2]).toEqual({ signal: expect.any(AbortSignal) });
    }
    const preview = await api.preview.mock.results[0].value;
    expect(api.accept).toHaveBeenCalledExactlyOnceWith(preview);
    expect(api.aggregate).toHaveBeenCalledWith({ setId, limit: 1, offset: 0 }, { signal: expect.any(AbortSignal) });
    expect(callbacks.onChanged).toHaveBeenCalledOnce();
    expect(callbacks.onDone).not.toHaveBeenCalled();
    const summary = within(screen.getByLabelText("Imported CSV summary"));
    expect(summary.getAllByRole("term").map(term => term.textContent)).toEqual(["Agents", "Users", "Responses"]);
    expect(summary.getAllByRole("definition").map(value => value.textContent)).toEqual(["2", "4", "270"]);
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["OK"]);
    expect(screen.queryByText(/hash|Review|Source totals differ/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reports imported" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(callbacks.onDone).toHaveBeenCalledWith(setId);
  });

  it("uses full CSV counts, not the inventory, paged agents, or active-user count", async () => {
    const snapshot = usageAggregateFixture();
    snapshot.activeSet = reportSet;
    snapshot.agents.value = snapshot.agents.value.slice(0, 1);
    snapshot.agents.limit = 1;
    snapshot.summary.catalog.totalAgents = 999;
    expect(snapshot.summary.usage.totalActiveUsers).toBe(3);
    api.aggregate.mockResolvedValueOnce(snapshot);
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    expect(within(screen.getByLabelText("Imported CSV summary")).getAllByRole("definition").map(value => value.textContent))
      .toEqual(["2", "4", "270"]);
  });

  it("formats large CSV totals without abbreviating or adding overlapping response sources", async () => {
    const snapshot = usageAggregateFixture();
    snapshot.activeSet = reportSet;
    snapshot.lineages = snapshot.lineages.map(lineage => ({
      ...lineage, rowCount: lineage.kind === "agents" ? 1234 : 56789,
    }));
    snapshot.summary.usage.totalResponses = Number.MAX_SAFE_INTEGER;
    api.aggregate.mockResolvedValueOnce(snapshot);
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    expect(within(screen.getByLabelText("Imported CSV summary")).getAllByRole("definition").map(value => value.textContent))
      .toEqual([1234, 56789, Number.MAX_SAFE_INTEGER].map(value => value.toLocaleString()));
  });

  it.each([false, true])("distinguishes empty CSVs from unavailable statistics (unavailable=%s)", async unavailable => {
    const snapshot = usageAggregateFixture();
    snapshot.activeSet = reportSet;
    snapshot.lineages = unavailable ? [] : snapshot.lineages.map(lineage => ({ ...lineage, rowCount: 0 }));
    snapshot.summary.usage.totalResponses = unavailable ? null : 0;
    api.aggregate.mockResolvedValueOnce(snapshot);
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    expect(within(screen.getByLabelText("Imported CSV summary")).getAllByRole("definition").map(value => value.textContent))
      .toEqual(Array(3).fill(unavailable ? "Unknown" : "0"));
    expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual(["OK"]);
  });

  it("accepts drag-and-drop without an extra upload or acceptance action", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    fireEvent.drop(screen.getByText("Drop your three CSV exports here"), { dataTransfer: { files: csvs() } });
    await imported();
    expect(api.accept).toHaveBeenCalledOnce();
  });

  it("keeps validated companions while asking only for missing exports", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([file("agents.csv")]);
    expect(await screen.findByText("Still needed: Users & agents, Users.")).toBeVisible();
    expect(api.accept).not.toHaveBeenCalled();
    await choose([file("user-agents.csv"), file("users.csv")]);
    await imported();
    expect(api.stage).toHaveBeenCalledTimes(3);
    expect(new Set(api.stage.mock.calls.map(call => call[1].bundleId)).size).toBe(1);
  });

  it("shows a filename-specific validation error and imports only after replacement", async () => {
    const stageFile = api.stage.getMockImplementation()!;
    api.stage.mockImplementation((value: File, input, options) => value.name === "bad.csv"
      ? Promise.reject(new ApiError(400, "invalid_headers", "Missing Username column."))
      : stageFile(value, input, options));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([file("agents.csv"), file("user-agents.csv"), file("bad.csv")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing Username column.");
    expect(screen.getByText("bad.csv")).toBeVisible();
    expect(screen.getByRole("button", { name: "Choose replacement CSVs" })).toBeEnabled();
    expect(api.accept).not.toHaveBeenCalled();
    await choose([file("users.csv")]);
    await imported();
    expect(api.stage).toHaveBeenCalledTimes(4);
    expect(api.accept).toHaveBeenCalledOnce();
  });

  it("never silently replaces a duplicate kind or imports a rejected selection", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([file("agents.csv"), file("agents-copy.csv"), file("users.csv")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("An Agents report is already included");
    expect(api.accept).not.toHaveBeenCalled();
    await choose([file("user-agents.csv")]);
    await imported();
    expect(api.discard).not.toHaveBeenCalled();
    expect(api.stage.mock.calls[3][1].bundleId).toBe(api.stage.mock.calls[0][1].bundleId);
  });

  it("rejects excess files before uploading and permits a corrected selection", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([...csvs(), file("extra.csv")]);
    expect(screen.getByRole("alert")).toHaveTextContent("Choose the three CSV exports");
    expect(api.stage).not.toHaveBeenCalled();
    await choose();
    await imported();
  });

  it.each([
    ["empty.csv", "", undefined, "This file is empty"],
    ["large.csv", "csv", 8 * 1024 * 1024 + 1, "exceeds the 8 MB limit"],
    ["report.txt", "csv", undefined, "Choose a CSV file"],
  ])("validates %s before sending its content", async (name, content, size, message) => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    const value = new File([content], name);
    if (size) Object.defineProperty(value, "size", { value: size });
    fireEvent.change(screen.getByLabelText("Official usage CSV files"), { target: { files: [value] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(api.stage).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
  });

  it("starts a genuinely independent bundle after Start over", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([file("agents.csv")]);
    await screen.findByText("Still needed: Users & agents, Users.");
    const firstBundle = api.stage.mock.calls[0][1].bundleId;
    await userEvent.click(screen.getByRole("button", { name: "Start over" }));
    await screen.findByRole("button", { name: "Choose CSV files" });
    await choose();
    await imported();
    expect(api.discard).toHaveBeenCalledOnce();
    expect(api.stage.mock.calls[1][1].bundleId).not.toBe(firstBundle);
  });

  it("cancels an empty form without any server mutations", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(api.admin).not.toHaveBeenCalled();
    expect(api.discard).not.toHaveBeenCalled();
  });

  it("cancels an in-flight validation without allowing later acceptance", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const stageFile = api.stage.getMockImplementation()!;
    api.stage.mockImplementationOnce(async (...args) => { await gate; return stageFile(...args); });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(screen.getByRole("status")).toHaveTextContent("Checking CSV files");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.stage.mock.calls[0][2].signal.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Cancelling import");
    await act(async () => finish());
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.stage).toHaveBeenCalledOnce();
    expect(api.discard).toHaveBeenCalledOnce();
    expect(api.accept).not.toHaveBeenCalled();
  });

  it("discards only this draft, never unrelated staging or retained reports", async () => {
    const unrelated = stage("agents", "unrelated-bundle");
    state.staging.push(unrelated);
    state.sets = [reportSet];
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([file("agents.csv")]);
    await screen.findByText("Still needed: Users & agents, Users.");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.discard).toHaveBeenCalledOnce();
    expect(api.discard).not.toHaveBeenCalledWith(unrelated.id);
    expect(state.sets).toEqual([reportSet]);
  });

  it("reports cancellation failures and retries cleanup before closing", async () => {
    api.discard.mockRejectedValueOnce(new ApiError(503, "offline", "Storage unavailable."));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose([file("agents.csv")]);
    await screen.findByText("Still needed: Users & agents, Users.");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The import couldn't be cancelled");
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(callbacks.onCancel).toHaveBeenCalledOnce());
    expect(api.accept).not.toHaveBeenCalled();
  });

  it("does not offer cancellation once atomic publication starts", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const accept = api.accept.getMockImplementation()!;
    api.accept.mockImplementationOnce(async (...args) => { await gate; return accept(...args); });
    const ref = createRef<OfficialUsageImportHandle>();
    render(<OfficialUsageImportPanel ref={ref} {...callbacks} />);
    await choose();
    await screen.findByText("Importing reports...");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    act(() => ref.current?.dismiss());
    expect(callbacks.onCancel).not.toHaveBeenCalled();
    expect(api.discard).not.toHaveBeenCalled();
    await act(async () => finish());
    await imported();
  });

  it("replays the identical acceptance after a lost response without uploading or previewing again", async () => {
    const accept = api.accept.getMockImplementation()!;
    api.accept.mockImplementationOnce(async (...args) => {
      await accept(...args);
      throw new ApiError(503, "response_lost", "Connection interrupted.");
    });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't confirm whether the import finished");
    expect(screen.queryByRole("button", { name: "Choose CSV files" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await imported();
    expect(api.accept.mock.calls[1][0]).toBe(api.accept.mock.calls[0][0]);
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.stage).toHaveBeenCalledTimes(3);
  });

  it("refreshes the validation fence only after a definite rejection and explicit retry", async () => {
    api.accept.mockImplementationOnce(async () => {
      state.activeRevision = 4;
      throw new ApiError(409, "bundle_fence_mismatch", "The report selection changed.");
    });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("The report selection changed.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await imported();
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(api.accept.mock.calls[1][0].expectedActiveRevision).toBe(4);
    expect(api.stage).toHaveBeenCalledTimes(3);
  });

  it("requires a fresh upload when an earlier import's report set was deleted", async () => {
    api.accept.mockRejectedValue(new ApiError(409, "deleted_report_duplicate", "The report set from this import was deleted. Start a new upload to import these CSV files again."));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Start a new upload");
    expect(screen.getByRole("button", { name: "Start over" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it.each(["admin", "aggregate"] as const)("retries %s readback without importing twice", async source => {
    api[source].mockRejectedValueOnce(new ApiError(503, "unavailable", "Readback unavailable."));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your reports were saved");
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Imported CSV summary")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await imported();
    expect(within(screen.getByLabelText("Imported CSV summary")).getAllByRole("definition").map(value => value.textContent))
      .toEqual(["2", "4", "270"]);
    expect(api.accept).toHaveBeenCalledOnce();
    expect(api.stage).toHaveBeenCalledTimes(3);
  });

  it("does not substitute a different report when verifying the imported report", async () => {
    api.aggregate.mockResolvedValue(usageAggregateFixture());
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("This report set is no longer available");
    expect(screen.queryByRole("button", { name: "OK" })).not.toBeInTheDocument();
  });

  it("verifies a reused report outside the bounded admin list through its exact report read", async () => {
    state.activeSetId = setId;
    api.accept.mockResolvedValue({ setId, versionId: "version", activeRevision: 1, complete: true, reusedExistingSet: true });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    expect(screen.getByRole("heading", { name: "Reports already imported" })).toBeVisible();
    expect(screen.getByText(/No duplicate was created/)).toBeVisible();
    expect(within(screen.getByLabelText("Imported CSV summary")).getAllByRole("definition").map(value => value.textContent))
      .toEqual(["2", "4", "270"]);
    expect(api.selection).not.toHaveBeenCalled();
    expect(state.sets).toEqual([]);
  });

  it("selects an older duplicate for viewing without creating a new report", async () => {
    state.activeSetId = "other-set";
    state.sets = [reportSet];
    api.accept.mockResolvedValue({ setId, versionId: "version", activeRevision: 1, complete: true, reusedExistingSet: true });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    expect(api.selection).toHaveBeenCalledWith(setId, "select");
    expect(api.confirm).toHaveBeenCalledOnce();
    expect(state.activeSetId).toBe(setId);
    expect(state.sets).toEqual([reportSet]);
  });

  it("requires explicit recovery before overriding a concurrently changed selection", async () => {
    api.admin.mockImplementationOnce(async () => {
      state.activeSetId = "someone-elses-report";
      state.activeRevision += 1;
      return structuredClone(state);
    });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("The report selection changed");
    expect(api.selection).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use imported reports" }));
    await imported();
    expect(api.confirm).toHaveBeenCalledOnce();
    expect(api.accept).toHaveBeenCalledOnce();
  });

  it("checks an uncertain selection result instead of confirming the consumed token again", async () => {
    state.activeSetId = "other-set";
    api.accept.mockResolvedValue({ setId, versionId: "version", activeRevision: 1, complete: true, reusedExistingSet: true });
    const confirm = api.confirm.getMockImplementation()!;
    api.confirm.mockImplementationOnce(async (...args) => {
      await confirm(...args);
      throw new ApiError(503, "lost", "Selection response interrupted.");
    });
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Use imported reports" }));
    await imported();
    expect(api.confirm).toHaveBeenCalledOnce();
    expect(api.accept).toHaveBeenCalledOnce();
  });

  it("rechecks the destination on OK rather than opening a report selected by someone else meanwhile", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    state.activeSetId = "later-selection";
    state.activeRevision += 1;
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The report selection changed");
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Use imported reports" }));
    await imported();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(callbacks.onDone).toHaveBeenCalledExactlyOnceWith(setId));
    expect(state.activeSetId).toBe(setId);
    expect(api.accept).toHaveBeenCalledOnce();
  });

  it("does not open a report deleted after success was first shown", async () => {
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    await imported();
    const unavailable = usageAggregateFixture();
    unavailable.activeSet = null;
    api.aggregate.mockResolvedValueOnce(unavailable);
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This report set is no longer available");
    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(api.accept).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("clears file evidence and stops the pipeline after a %s denial", async status => {
    api.stage.mockRejectedValueOnce(new ApiError(status, "denied", "Import access denied."));
    render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    expect(await screen.findByRole("alert")).toHaveTextContent("Import access denied");
    expect(screen.queryByRole("list", { name: "Selected CSV files" })).not.toBeInTheDocument();
    expect(api.stage).toHaveBeenCalledOnce();
    expect(api.accept).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back to Sync" }));
    expect(callbacks.onCancel).toHaveBeenCalledOnce();
    expect(api.admin).not.toHaveBeenCalled();
  });

  it("stops after leaving the uploader and aborts the upload rather than publishing in the background", async () => {
    let finish!: (value: OfficialUsageStagingPreview) => void;
    api.stage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<OfficialUsageImportPanel {...callbacks} />);
    await choose();
    view.unmount();
    expect(api.stage.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => finish(stage("agents")));
    expect(api.stage).toHaveBeenCalledOnce();
    expect(api.accept).not.toHaveBeenCalled();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
  });

  it("resumes only an explicit saved import, retaining its correction and supplied metadata", async () => {
    const savedStage = {
      ...stage("agents"), correctionOfSetId: "original-set",
      reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", provenance: "operator_asserted" as const },
      sourceAsOf: "2026-09-01T00:00:00Z", sourceAsOfProvenance: "operator_asserted" as const,
    };
    state.staging = [stage("users", "unrelated-bundle"), savedStage];
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={savedStage.id} />);
    await screen.findByText("Still needed: Users & agents, Users.");
    expect(screen.getByText(/This saved import replaces an earlier report set/)).toBeVisible();
    expect(api.accept).not.toHaveBeenCalled();
    await choose([file("user-agents.csv"), file("users.csv")]);
    await imported();
    expect(api.stage.mock.calls[0][1]).toEqual({
      bundleId, correctionOfSetId: "original-set", rejectDuplicateKind: true,
      reportingStart: "2026-08-01", reportingEnd: "2026-08-30", periodProvenance: "operator_asserted",
      sourceAsOf: "2026-09-01T00:00:00Z", sourceAsOfProvenance: "operator_asserted",
    });
  });

  it("does not publish a restored complete draft merely by opening its link", async () => {
    state.staging = kinds.map(kind => stage(kind));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={state.staging[0].id} />);
    await screen.findByRole("button", { name: "Continue import" });
    expect(api.accept).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Continue import" }));
    await imported();
  });

  it("preserves metadata and a correction warning when an accepted-only legacy import is resumed", async () => {
    state.sets = [{ ...reportSet, complete: false, kinds: ["agents"], supersedesSetId: "original-set",
      reportingPeriod: { startDate: "2026-08-01", endDate: "2026-08-30", provenance: "operator_asserted" } }];
    const acceptedCompanion = {
      kind: "agents" as const, versionId: "retained-version", fileHash: "c".repeat(64),
      reportingPeriod: state.sets[0].reportingPeriod,
      sourceAsOf: "2026-09-01T00:00:00Z", sourceAsOfProvenance: "operator_asserted" as const,
    };
    const preview = api.preview.getMockImplementation()!;
    api.preview.mockImplementation(async id => {
      const next: OfficialUsageBundlePreview = await preview(id);
      return { ...next, acceptedVersions: [acceptedCompanion], missingKinds: next.missingKinds.filter(kind => kind !== "agents") };
    });
    render(<OfficialUsageImportPanel {...callbacks} initialBundleId={bundleId} />);
    await screen.findByText("Still needed: Users & agents, Users.");
    expect(screen.getByText(/This saved import replaces an earlier report set/)).toBeVisible();
    await choose([file("user-agents.csv"), file("users.csv")]);
    await imported();
    expect(api.stage.mock.calls[0][1]).toMatchObject({
      bundleId, correctionOfSetId: "original-set",
      reportingStart: "2026-08-01", reportingEnd: "2026-08-30", periodProvenance: "operator_asserted",
      sourceAsOf: "2026-09-01T00:00:00Z", sourceAsOfProvenance: "operator_asserted",
    });
  });

  it("retains verified companions and correction intent when restoring the bundle preview fails", async () => {
    const savedStage = { ...stage("agents"), correctionOfSetId: "original-set" };
    state.staging = [savedStage];
    api.preview.mockRejectedValueOnce(new Error("Preview unavailable."));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId={savedStage.id} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Preview unavailable");
    expect(screen.getByText(/This saved import replaces an earlier report set/)).toBeVisible();
    await choose([file("user-agents.csv"), file("users.csv")]);
    await imported();
    expect(api.stage.mock.calls[0][1]).toMatchObject({ bundleId, correctionOfSetId: "original-set" });
  });

  it("does not fall back to another draft when an explicit staging link is unavailable", async () => {
    state.staging = kinds.map(kind => stage(kind));
    render(<OfficialUsageImportPanel {...callbacks} initialStagingId="expired" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This saved import is no longer available");
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.accept).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose CSV files" })).toBeEnabled();
  });

  it("reopens Add CSV reports empty after completing an import", async () => {
    function Host() {
      const [route, setRoute] = useState<SyncReportRouteState>();
      return <>
        <button onClick={() => setRoute({ view: "import", activityWindowDays: 30 })}>Add CSV reports</button>
        <OfficialUsageImportModal route={route} onRouteChange={setRoute} canManage revision={0}
          onChanged={callbacks.onChanged} onImported={callbacks.onDone} />
      </>;
    }
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    await choose();
    await imported();
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    const dialog = screen.getByRole("dialog", { name: "Add CSV reports" });
    expect(within(dialog).getByRole("button", { name: "Choose CSV files" })).toBeVisible();
    expect(within(dialog).queryByRole("heading", { name: "Reports imported" })).not.toBeInTheDocument();
    expect(api.accept).toHaveBeenCalledOnce();
  });
});
