import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfficialUsageAdminState,
  OfficialUsageReportKind,
  OfficialUsageStagingPreview,
} from "../api/client";
import { ApiError } from "../api/client";
import { legacyUsageStorageKey } from "../legacyUsageStorage";
import { OfficialUsageImportPanel } from "./OfficialUsageImportPanel";
import { OfficialUsageImportModal } from "./OfficialUsageImportModal";
import { mockNativeDialogs } from "../test/dialog";

mockNativeDialogs();

const api = vi.hoisted(() => ({
  acceptBundle: vi.fn(),
  acknowledge: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
  getAdminState: vi.fn(),
  previewBundle: vi.fn(),
  previewOperation: vi.fn(),
  stage: vi.fn(),
}));

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  acceptOfficialUsageBundle: api.acceptBundle,
  acknowledgeLegacyUsageCleanup: api.acknowledge,
  confirmOfficialUsageSetOperation: api.confirm,
  discardOfficialUsageStaging: api.discard,
  getOfficialUsageAdminState: api.getAdminState,
  previewOfficialUsageBundle: api.previewBundle,
  previewOfficialUsageSetOperation: api.previewOperation,
  stageOfficialUsageReport: api.stage,
}));

const emptyAdminState: OfficialUsageAdminState = {
  activeSetId: null,
  activeRevision: 1,
  staging: [],
  sets: [],
};

function retainedSet(
  id: string,
  options: {
    bundleId?: string;
    acceptedAt?: string;
    startDate?: string;
    endDate?: string;
  } = {},
): OfficialUsageAdminState["sets"][number] {
  return {
    id,
    bundleId: options.bundleId ?? "44444444-4444-4444-8444-444444444444",
    reportingPeriod: {
      startDate: options.startDate ?? "2026-08-14",
      endDate: options.endDate ?? "2026-09-12",
      provenance: "activity_range",
    },
    supersedesSetId: null,
    complete: true,
    kinds: ["agents", "userAgents", "users"],
    acceptedAt: options.acceptedAt ?? "2026-09-13T12:00:00.000Z",
    deletedAt: null,
    createdAt: options.acceptedAt ?? "2026-09-13T12:00:00.000Z",
    expiresAt: null,
  };
}

function preview(kind: OfficialUsageReportKind, warning?: string): OfficialUsageStagingPreview {
  return {
    id: `11111111-1111-4111-8111-11111111111${kind === "agents" ? "1" : kind === "userAgents" ? "2" : "3"}`,
    revision: 1,
    status: "active",
    kind,
    fileHash: kind.repeat(64).slice(0, 64),
    parserVersion: "1",
    schemaVersion: `m365-${kind}-observed-v1`,
    bundleId: "22222222-2222-4222-8222-222222222222",
    correctionOfSetId: null,
    reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
    sourceAsOf: null,
    sourceAsOfProvenance: "absent",
    sourceFreshness: "unknown",
    downloadedAt: null,
    rowCount: 1,
    warnings: warning ? [warning] : [],
    reconciliation: {},
    activeRevision: 1,
    acceptedVersionId: null,
    acceptedSetId: null,
    createdAt: "2026-07-08T12:00:00.000Z",
    expiresAt: "2026-07-08T12:30:00.000Z",
    acceptedAt: null,
  };
}

async function validationReady() {
  expect(await screen.findByRole("region", { name: "Server validation" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
}

async function continueToReview() {
  await validationReady();
  await userEvent.click(screen.getByRole("button", { name: "Continue to review" }));
  return screen.findByRole("region", { name: "Validated report previews" });
}

describe("OfficialUsageImportPanel", () => {
  let staged: OfficialUsageStagingPreview[];
  let previewRevision: number;

  beforeEach(() => {
    staged = [];
    previewRevision = 1;
    vi.clearAllMocks();
    localStorage.clear();
    api.getAdminState.mockResolvedValue(emptyAdminState);
    api.acknowledge.mockResolvedValue(undefined);
    api.discard.mockResolvedValue(undefined);
    api.stage.mockImplementation((file: File) => {
      const kind = file.name.startsWith("agents")
        ? "agents"
        : file.name.startsWith("user-agents") ? "userAgents" : "users";
      const value = preview(kind, kind === "userAgents" ? "Pseudonymous usernames remain dataset-scoped." : undefined);
      staged = [...staged.filter(existing => existing.kind !== kind), value];
      return Promise.resolve(value);
    });
    api.previewBundle.mockImplementation((bundleId: string) => Promise.resolve({
      bundleId,
      bundleHash: "a".repeat(64),
      expectedActiveRevision: previewRevision,
      staging: staged,
      acceptedVersions: [],
      missingKinds: (["agents", "userAgents", "users"] as OfficialUsageReportKind[]).filter(kind => !staged.some(value => value.kind === kind)),
      reconciliation: { responses: { agents: 1, userAgents: 1, users: 1 } },
    }));
    api.acceptBundle.mockImplementation(() => Promise.resolve({
      setId: "33333333-3333-4333-8333-333333333333",
      versionId: "11111111-1111-4111-8111-111111111111",
      activeRevision: 2,
      complete: true,
    }));
  });

  it("stages all three exports, shows server metadata and warnings, then accepts the bundle", async () => {
    const onChanged = vi.fn();
    const user = userEvent.setup();
    const acceptedSetId = "33333333-3333-4333-8333-333333333333";
    api.getAdminState
      .mockResolvedValueOnce(emptyAdminState)
      .mockResolvedValueOnce(emptyAdminState)
      .mockResolvedValue({
        ...emptyAdminState,
        activeSetId: acceptedSetId,
        activeRevision: 2,
        sets: [retainedSet(acceptedSetId)],
      });
    render(<OfficialUsageImportPanel onChanged={onChanged} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());

    expect(screen.queryByLabelText("Reporting start")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reporting end")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Source as-of/)).not.toBeInTheDocument();
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    await validationReady();
    expect(screen.getByLabelText("Import progress").querySelector('[aria-current="step"]')).toHaveTextContent("Validation");
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Retained report sets" })).not.toBeInTheDocument();
    expect(await continueToReview()).toBeVisible();
    expect(api.stage).toHaveBeenCalledTimes(3);
    for (const [, input] of api.stage.mock.calls) {
      expect(input).toEqual({ bundleId: expect.any(String), correctionOfSetId: undefined });
    }
    expect(screen.getByRole("rowheader", { name: "Users & agents" })).toBeVisible();
    expect(screen.getByText("Pseudonymous usernames remain dataset-scoped.")).toBeVisible();
    expect(screen.getAllByText((_text, element) => element?.tagName === "TD" && element.textContent?.includes("freshness unknown") === true)).toHaveLength(3);
    expect(screen.getByText("Bundle hash")).not.toBeVisible();
    await user.click(screen.getByText("Technical validation details"));
    expect(screen.getByText("Bundle hash")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    await waitFor(() => expect(api.acceptBundle).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/added to cumulative history/i)).toBeVisible();
    expect(screen.getByText(/and is current/i)).toBeVisible();
    expect(screen.getByLabelText("Import progress").querySelector('[aria-current="step"]')).toHaveTextContent("Result");
    expect(screen.queryByRole("region", { name: "Validated report previews" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Official usage CSV files")).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("reports an older retained semantic duplicate without changing the active selection", async () => {
    const duplicateSetId = "33333333-3333-4333-8333-333333333333";
    const currentSetId = "55555555-5555-4555-8555-555555555555";
    const state: OfficialUsageAdminState = {
      activeSetId: currentSetId,
      activeRevision: 7,
      staging: [],
      sets: [
        retainedSet(duplicateSetId, { acceptedAt: "2026-08-01T12:00:00.000Z" }),
        retainedSet(currentSetId, { startDate: "2026-09-01", endDate: "2026-09-30" }),
      ],
    };
    api.getAdminState.mockResolvedValue(state);
    previewRevision = state.activeRevision;
    api.acceptBundle.mockResolvedValue({
      setId: duplicateSetId,
      versionId: "duplicate-version",
      activeRevision: 7,
      complete: true,
    });
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    await continueToReview();
    await user.click(await screen.findByRole("button", { name: "Accept reviewed bundle" }));

    expect(await screen.findByText(/exactly matched retained snapshot 33333333/i)).toBeVisible();
    expect(screen.getByText(/No new history entry was created/i)).toBeVisible();
    expect(screen.getByText(/Original acceptance remains/)).toHaveTextContent("Aug 1, 2026");
    expect(screen.getByText(/Current selection remains 55555555 and its revision is unchanged/i)).toBeVisible();
    expect(screen.queryByText(/added to cumulative history/i)).not.toBeInTheDocument();
  });

  it("reports a current semantic duplicate without refreshing its acceptance or revision", async () => {
    const currentSetId = "33333333-3333-4333-8333-333333333333";
    const state: OfficialUsageAdminState = {
      activeSetId: currentSetId,
      activeRevision: 4,
      staging: [],
      sets: [retainedSet(currentSetId, { acceptedAt: "2026-08-05T12:00:00.000Z" })],
    };
    api.getAdminState.mockResolvedValue(state);
    previewRevision = state.activeRevision;
    api.acceptBundle.mockResolvedValue({
      setId: currentSetId,
      versionId: "duplicate-current-version",
      activeRevision: 4,
      complete: true,
    });
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    await continueToReview();
    await user.click(await screen.findByRole("button", { name: "Accept reviewed bundle" }));

    expect(await screen.findByText(/exactly matched the current retained snapshot/i)).toBeVisible();
    expect(screen.getByText(/Original acceptance remains/)).toHaveTextContent("Aug 5, 2026");
    expect(screen.getByText(/Current selection and revision are unchanged/i)).toBeVisible();
    expect(screen.queryByText(/added to cumulative history/i)).not.toBeInTheDocument();
  });

  it("appends a second accepted-period bundle without requiring correction acknowledgement", async () => {
    const activeSetId = "33333333-3333-4333-8333-333333333333";
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState,
      activeSetId,
      sets: [{
        id: activeSetId,
        bundleId: "44444444-4444-4444-8444-444444444444",
        reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "activity_range" },
        supersedesSetId: null,
        complete: true,
        kinds: ["agents", "userAgents", "users"],
        acceptedAt: "2026-09-13T12:00:00.000Z",
        deletedAt: null,
        createdAt: "2026-09-13T12:00:00.000Z",
        expiresAt: "2027-03-12T12:00:00.000Z",
      }],
    });
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    expect(screen.getByText(/ordinary uploads do not require a replacement acknowledgement/i)).toBeVisible();
    expect(screen.getByText(/known reporting window, changed aggregate metrics require intentional correction/i)).toBeVisible();
    expect(screen.getByText(/Activity-range-only imports have an unknown reporting window/i)).toBeVisible();

    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await continueToReview()).toBeVisible();
    expect(screen.queryByText(/explicit correction.*before staging/i)).not.toBeInTheDocument();
    for (const [, input] of api.stage.mock.calls) {
      expect(input.correctionOfSetId).toBeUndefined();
    }
    expect(screen.getByText(/duplicate observations reuse their original retained identity and acceptance time/i)).toBeVisible();
    expect(screen.getByText(/Aggregate snapshots are non-additive/i)).toBeVisible();
  });

  it("keeps intentional correction metadata behind a separate explicit option", async () => {
    const activeSetId = "33333333-3333-4333-8333-333333333333";
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState,
      activeSetId,
      sets: [{
        id: activeSetId,
        bundleId: "44444444-4444-4444-8444-444444444444",
        reportingPeriod: { startDate: "2026-08-14", endDate: "2026-09-12", provenance: "activity_range" },
        supersedesSetId: null,
        complete: true,
        kinds: ["agents", "userAgents", "users"],
        acceptedAt: "2026-09-13T12:00:00.000Z",
        deletedAt: null,
        createdAt: "2026-09-13T12:00:00.000Z",
        expiresAt: "2027-03-12T12:00:00.000Z",
      }],
    });
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: /intentionally corrects/ }));
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(api.stage).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ correctionOfSetId: activeSetId }),
    );
  });

  it("keeps every file validation error visible without looking up a bundle that was never created", async () => {
    api.stage.mockRejectedValueOnce(new Error("Invalid count in row 2"))
      .mockRejectedValueOnce(new Error("Unsupported CSV headers"));
    api.previewBundle.mockRejectedValue(new Error("The official usage bundle was not found for this administrator."));
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["bad count"], "agents.csv", { type: "text/csv" }),
      new File(["bad headers"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await screen.findByText(/0 report type\(s\) staged; 2 file\(s\) rejected/)).toBeVisible();
    expect(screen.getByText("agents.csv: Invalid count in row 2")).toBeVisible();
    expect(screen.getByText("users.csv: Unsupported CSV headers")).toBeVisible();
    expect(api.previewBundle).not.toHaveBeenCalled();
    expect(screen.queryByText(/bundle was not found/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry rejected files" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Refresh import state" }));
    expect(api.previewBundle).not.toHaveBeenCalled();
    expect(screen.getByText(/Invalid count in row 2/)).toBeVisible();
  });

  it("surfaces a deleted-duplicate conflict without claiming that history was appended", async () => {
    api.stage.mockRejectedValue(new Error("This exact report observation was deleted and cannot be reused. Import a corrected export explicitly."));
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["deleted duplicate"], "agents.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await screen.findByText(/exact report observation was deleted and cannot be reused/)).toBeVisible();
    expect(screen.queryByText(/added to cumulative history/i)).not.toBeInTheDocument();
    expect(api.previewBundle).not.toHaveBeenCalled();
  });

  it("retains successful companions and retries rejected files in the same bundle", async () => {
    api.stage.mockRejectedValueOnce(new Error("Malformed CSV"));
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await screen.findByText(/2 report type\(s\) staged; 1 file\(s\) rejected/)).toBeVisible();
    expect(screen.getByText("Missing Agents")).toBeVisible();
    expect(screen.getByText(/1 file\(s\) selected for retry/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
    const bundleId = api.stage.mock.calls[0][1].bundleId;
    await user.click(screen.getByRole("button", { name: "Retry rejected files" }));
    await waitFor(() => expect(api.stage).toHaveBeenCalledTimes(4));
    expect(api.stage.mock.calls[3][0].name).toBe("agents.csv");
    expect(api.stage.mock.calls[3][1].bundleId).toBe(bundleId);
    await validationReady();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeEnabled();
    await continueToReview();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
  });

  it("does not count preview failures as file rejections or lose the staged bundle intent", async () => {
    api.previewBundle.mockRejectedValueOnce(new Error("Temporary preview failure"));
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    expect(await screen.findByText(/1 report type\(s\) staged; 0 file\(s\) rejected/)).toHaveTextContent("Temporary preview failure");
    const bundleId = api.stage.mock.calls[0][1].bundleId;
    await user.click(screen.getByRole("button", { name: "Back to files" }));
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage.mock.calls[1][1].bundleId).toBe(bundleId);
  });

  it("clears an expired bundle on refresh rather than requesting a nonexistent preview", async () => {
    staged = [preview("agents")];
    api.getAdminState.mockResolvedValueOnce({ ...emptyAdminState, staging: staged })
      .mockResolvedValue(emptyAdminState);
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();
    expect(api.previewBundle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Refresh import state" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Server validation" })).not.toBeInTheDocument());
    expect(api.previewBundle).toHaveBeenCalledOnce();
    expect(screen.getByText(/staged bundle is no longer available/)).toBeVisible();
    expect(screen.queryByText(/bundle was not found/)).not.toBeInTheDocument();
  });

  it("preserves legacy browser data until explicit acknowledged cleanup", async () => {
    localStorage.setItem(legacyUsageStorageKey, "untrusted legacy rows");
    localStorage.setItem("unrelated", "preserve me");
    const onLegacyCleared = vi.fn();
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} onLegacyCleared={onLegacyCleared} />);

    expect(await screen.findByText(/Legacy browser report data is present/i)).toBeVisible();
    expect(localStorage.getItem(legacyUsageStorageKey)).toBe("untrusted legacy rows");
    await user.click(screen.getByRole("button", { name: /Acknowledge discard and remove/i }));

    await waitFor(() => expect(api.acknowledge).toHaveBeenCalledWith("discarded"));
    expect(onLegacyCleared).toHaveBeenCalledOnce();
    expect(localStorage.getItem(legacyUsageStorageKey)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("preserve me");
  });

  it("shows retained supersession lineage", async () => {
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState,
      activeSetId: "33333333-3333-4333-8333-333333333333",
      sets: [{
        id: "33333333-3333-4333-8333-333333333333",
        bundleId: "44444444-4444-4444-8444-444444444444",
        reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06" },
        supersedesSetId: "55555555-5555-4555-8555-555555555555",
        complete: true,
        kinds: ["agents", "userAgents", "users"],
        acceptedAt: "2026-07-08T12:00:00.000Z",
        deletedAt: null,
        createdAt: "2026-07-08T12:00:00.000Z",
        expiresAt: "2027-01-04T12:00:00.000Z",
      }],
    });

    render(<OfficialUsageImportPanel view="manage" onChanged={vi.fn()} />);

    expect(await screen.findByText("Corrects 55555555")).toBeVisible();
    expect(screen.getByText("Current", { exact: true })).toBeVisible();
    expect(screen.getByText("Agents, Users & agents, Users")).toBeVisible();
  });

  it("restores actor-owned staging after reload and keeps acceptance disabled until companions arrive", async () => {
    staged = [preview("agents")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);

    await validationReady();
    expect(screen.getByText("Missing Users & agents, Users")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
  });

  it("allows a complete empty bundle with unknown activity coverage and no date prompts", async () => {
    staged = (["agents", "userAgents", "users"] as const).map(kind => ({
      ...preview(kind),
      rowCount: 0,
      reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range" },
    }));
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);

    await continueToReview();
    expect(screen.getAllByText("No activity dates supplied", { exact: false })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
    expect(screen.queryByText(/null to null/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Reporting start")).not.toBeInTheDocument();
  });

  it("resolves the exact actor-owned staging link instead of the latest bundle", async () => {
    const older = preview("agents");
    const latest = { ...preview("users"), id: "99999999-9999-4999-8999-999999999999", bundleId: "88888888-8888-4888-8888-888888888888" };
    staged = [latest, older];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel initialStagingId={older.id} onChanged={vi.fn()} />);

    await waitFor(() => expect(api.previewBundle).toHaveBeenCalledWith(
      older.bundleId,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(api.previewBundle).not.toHaveBeenCalledWith(latest.bundleId, expect.anything());
  });

  it("does not fall back to the latest bundle for a forbidden or expired staging link", async () => {
    staged = [preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel initialStagingId="deleted-stage" onChanged={vi.fn()} />);

    expect(await screen.findByText(/exact staging record is expired, deleted, or unavailable/i)).toBeVisible();
    expect(api.previewBundle).not.toHaveBeenCalled();
  });

  it("clears the previous approval when a different staging link is opened", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    const props = { onChanged: vi.fn() };
    const view = render(<OfficialUsageImportPanel {...props} initialStagingId={staged[0].id} />);
    await continueToReview();
    view.rerender(<OfficialUsageImportPanel {...props} initialStagingId="unavailable-other-stage" />);
    expect(await screen.findByText(/exact staging record is expired, deleted, or unavailable/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Validated report previews" })).not.toBeInTheDocument();
    expect(api.previewBundle).toHaveBeenCalledOnce();
  });

  it("reports failed discards and retains the server bundle for retry", async () => {
    staged = [preview("agents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.discard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("discard failed"));
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();

    await user.click(screen.getByRole("button", { name: "Discard staging" }));
    expect(await screen.findByText(/1 staged report\(s\) could not be discarded/)).toBeVisible();
    expect(api.previewBundle).toHaveBeenCalled();
  });

  it("does not stage remaining files or refresh private data after its principal-bound panel unmounts", async () => {
    let finish!: (value: OfficialUsageStagingPreview) => void;
    api.stage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { unmount } = render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalledOnce());
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    expect(api.stage).toHaveBeenCalledOnce();
    unmount();
    await act(async () => finish(preview("agents")));
    expect(api.stage).toHaveBeenCalledOnce();
    expect(api.previewBundle).not.toHaveBeenCalled();
    expect(api.getAdminState).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("clears retained import data and approval actions when refresh loses authorization with %s", async status => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValueOnce({
      ...emptyAdminState, staging: staged, sets: [retainedSet("retained-private-set")],
    }).mockRejectedValueOnce(new ApiError(status, "access_revoked", "Import access was revoked."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await continueToReview();
    expect(screen.queryByRole("button", { name: "Make current" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    expect(await screen.findByText("Import access was revoked.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Validated report previews" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make current" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
  });

  it("invalidates report consumers after successful acceptance even when its metadata refresh fails", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValueOnce({ ...emptyAdminState, staging: staged })
      .mockRejectedValueOnce(new Error("Accepted history refresh unavailable."));
    const onChanged = vi.fn();
    render(<OfficialUsageImportPanel onChanged={onChanged} />);
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    expect(await screen.findByText(/Acceptance succeeded, but the metadata refresh failed: Accepted history refresh unavailable/)).toBeVisible();
    expect(screen.getByText("Accepted; status not yet verified")).toBeVisible();
    expect(screen.queryByText(/and is current/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh result" })).toBeEnabled();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState, activeSetId: "33333333-3333-4333-8333-333333333333", activeRevision: 2,
      sets: [retainedSet("33333333-3333-4333-8333-333333333333")],
    });
    await userEvent.click(screen.getByRole("button", { name: "Refresh result" }));
    expect(await screen.findByText(/added to cumulative history and is current/)).toBeVisible();
    expect(api.acceptBundle).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("ignores late acceptance after unmount instead of refreshing or notifying the replacement principal", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    let finish!: (result: { complete: boolean }) => void;
    api.acceptBundle.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const onChanged = vi.fn();
    const { unmount } = render(<OfficialUsageImportPanel onChanged={onChanged} />);
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    unmount();
    await act(async () => finish({ complete: true }));
    expect(api.getAdminState).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("requires a separate confirmation for deletion and refreshes consumers even when metadata refresh fails", async () => {
    const reportSet = retainedSet("retained-private-set");
    api.getAdminState.mockResolvedValueOnce({ ...emptyAdminState, sets: [reportSet] })
      .mockRejectedValueOnce(new Error("Deleted history refresh unavailable."));
    const confirmation = {
      id: "delete-confirmation", operation: "delete", setId: reportSet.id,
      expectedRevision: 1, confirmationHash: "reviewed-hash", activeSetId: null,
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    api.previewOperation.mockResolvedValueOnce(confirmation);
    api.confirm.mockResolvedValueOnce({ activeSetId: null, activeRevision: 2 });
    const onChanged = vi.fn();
    render(<OfficialUsageImportPanel view="manage" onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete retained set for/ }));
    expect(screen.getByRole("dialog", { name: "Confirm delete" })).toBeVisible();
    expect(api.confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(api.confirm).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(await screen.findByText("Deleted history refresh unavailable.")).toBeVisible();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Delete retained set for/ })).toBeDisabled();
    expect(screen.getByText("Not verified", { exact: true })).toBeVisible();
  });

  it("disables stale approval after a failed preview refresh and requires reviewing the refreshed validation", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await continueToReview();
    api.previewBundle.mockRejectedValueOnce(new Error("Preview refresh unavailable."));
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    expect(await screen.findByText("Preview refresh unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
    expect(screen.getByText(/Approval is unavailable until validation is refreshed/)).toBeVisible();
    expect(api.acceptBundle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    await validationReady();
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
    await continueToReview();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
  });

  it("does not approve an old complete preview after files are changed", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Back to validation" }));
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["replacement"], "agents.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Show validation" }));
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Accept reviewed bundle" })).not.toBeInTheDocument();
    expect(screen.queryByText("Bundle hash")).not.toBeInTheDocument();
    expect(api.acceptBundle).not.toHaveBeenCalled();
  });

  it("blocks review when the saved selection revision changed during validation", async () => {
    api.getAdminState.mockResolvedValueOnce(emptyAdminState).mockResolvedValue({ ...emptyAdminState, activeRevision: 2 });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalledOnce());
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    expect(await screen.findByText(/saved report selection changed during validation/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(api.acceptBundle).not.toHaveBeenCalled();
  });

  it("preserves a legacy correction target and asserted companion metadata when resumed from management", async () => {
    const correctionId = "old-corrected-snapshot";
    const bundleId = "legacy-bundle";
    const period = { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" as const };
    const sourceAsOf = "2026-07-07T12:00:00.000Z";
    const incomplete = {
      ...retainedSet("incomplete-correction", { bundleId }), complete: false,
      acceptedAt: null, kinds: ["agents"] as OfficialUsageReportKind[],
      reportingPeriod: period, supersedesSetId: correctionId,
    };
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState, activeSetId: "different-current-snapshot",
      sets: [retainedSet(correctionId), retainedSet("different-current-snapshot"), incomplete],
    });
    api.previewBundle.mockResolvedValue({
      bundleId, bundleHash: "a".repeat(64), expectedActiveRevision: 1, staging: [],
      acceptedVersions: [{
        kind: "agents", versionId: "retained-agent-version", fileHash: "a".repeat(64),
        reportingPeriod: period, sourceAsOf, sourceAsOfProvenance: "operator_asserted",
      }],
      missingKinds: ["userAgents", "users"], reconciliation: {},
    });
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    const manage = screen.getByRole("dialog", { name: "Manage reports" });
    await userEvent.click(await within(manage).findByRole("button", { name: "Resume" }));
    await validationReady();
    expect(screen.getByRole("dialog", { name: "Import CSV reports" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Retained report sets" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    const correction = screen.getByRole("checkbox", { name: /intentionally corrects/ });
    expect(correction).toBeChecked();
    expect(correction).toBeDisabled();
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage).toHaveBeenCalledTimes(2);
    for (const [, input] of api.stage.mock.calls) {
      expect(input).toEqual({
        bundleId, correctionOfSetId: correctionId, reportingStart: period.startDate,
        reportingEnd: period.endDate, periodProvenance: "operator_asserted",
        sourceAsOf, sourceAsOfProvenance: "operator_asserted",
      });
    }
  });

  it("keeps inherited staging metadata when the initial bundle preview is temporarily unavailable", async () => {
    const sourceAsOf = "2026-07-07T12:00:00.000Z";
    staged = [{ ...preview("agents"), correctionOfSetId: "original-correction", sourceAsOf, sourceAsOfProvenance: "operator_asserted" }];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.previewBundle.mockRejectedValueOnce(new Error("Preview temporarily unavailable."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    expect(await screen.findByText("Preview temporarily unavailable.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["users"], "users.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage).toHaveBeenCalledWith(expect.any(File), expect.objectContaining({
      bundleId: staged[0].bundleId, correctionOfSetId: "original-correction",
      reportingStart: "2026-06-07", reportingEnd: "2026-07-06", periodProvenance: "operator_asserted",
      sourceAsOf, sourceAsOfProvenance: "operator_asserted",
    }));
  });

  it("retries an uncertain acceptance using the exact reviewed hash without restaging", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.acceptBundle.mockRejectedValueOnce(new Error("Connection lost after submission."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    expect(await screen.findByText(/Acceptance was not confirmed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back to validation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard staging" })).toBeDisabled();
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState, activeRevision: 2, activeSetId: "33333333-3333-4333-8333-333333333333",
      sets: [retainedSet("33333333-3333-4333-8333-333333333333", { bundleId: staged[0].bundleId })],
    });
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    expect(await screen.findByText(/acceptance response remains unconfirmed/)).toBeVisible();
    expect(api.previewBundle).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Retry same acceptance" }));
    expect(api.acceptBundle).toHaveBeenCalledTimes(2);
    expect(api.acceptBundle.mock.calls[1][0]).toBe(api.acceptBundle.mock.calls[0][0]);
    expect(api.stage).not.toHaveBeenCalled();
    expect(await screen.findByRole("region", { name: "Import result" })).toBeVisible();
  });

  it("requires refreshed review instead of retrying rejected stale acceptance", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.acceptBundle.mockRejectedValueOnce(new ApiError(409, "bundle_fence_mismatch", "The reviewed bundle changed."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    expect(await screen.findByText(/The reviewed bundle changed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry same acceptance" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    await continueToReview();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
  });

  it("keeps draft and server progress when closed during validation without stealing restored focus", async () => {
    let finish!: (value: OfficialUsageStagingPreview) => void;
    api.stage.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Import reports" });
    await userEvent.click(trigger);
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    const modal = screen.getByRole("dialog", { name: "Import CSV reports" });
    expect(within(modal).getByText(/0 of 3 files checked/)).toBeVisible();
    expect(within(modal).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "Continue to review" })).toBeDisabled();
    await userEvent.click(within(modal).getByRole("button", { name: "Close report import" }));
    expect(trigger).toHaveFocus();
    await act(async () => {
      staged = [preview("agents")];
      finish(staged[0]);
    });
    await waitFor(() => expect(api.stage).toHaveBeenCalledTimes(3));
    expect(trigger).toHaveFocus();
    expect(modal).not.toHaveAttribute("open");
    expect(document.body.style.overflow).not.toBe("hidden");
    await userEvent.click(trigger);
    await validationReady();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeEnabled();
    expect(api.acceptBundle).not.toHaveBeenCalled();
  });

  it("leaves legacy browser data untouched when acknowledgement fails", async () => {
    localStorage.setItem(legacyUsageStorageKey, "untrusted legacy rows");
    api.acknowledge.mockRejectedValueOnce(new Error("Acknowledgement unavailable."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Acknowledge discard and remove/ })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /Acknowledge discard and remove/ }));
    expect(await screen.findByText("Acknowledgement unavailable.")).toBeVisible();
    expect(localStorage.getItem(legacyUsageStorageKey)).toBe("untrusted legacy rows");
    expect(screen.getByRole("button", { name: /Acknowledge discard and remove/ })).toBeEnabled();
  });

  it("preserves selected files while keeping management separate from the wizard", async () => {
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, sets: [retainedSet("retained-set")] });
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["agents"], "agents.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    expect(await screen.findByRole("region", { name: "Retained report sets" })).toBeVisible();
    expect(screen.queryByLabelText("Official usage CSV files")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Import progress")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    expect(screen.getByText("1 file(s) selected")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Retained report sets" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage).toHaveBeenCalledOnce();
    expect(api.stage.mock.calls[0][0].name).toBe("agents.csv");
  });
});
