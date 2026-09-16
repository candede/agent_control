import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfficialUsageAdminState,
  OfficialUsageReportKind,
  OfficialUsageStagingPreview,
} from "../api/client";
import { legacyUsageStorageKey } from "../legacyUsageStorage";
import { OfficialUsageImportPanel } from "./OfficialUsageImportPanel";

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

vi.mock("../api/client", () => ({
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

describe("OfficialUsageImportPanel", () => {
  let staged: OfficialUsageStagingPreview[];

  beforeEach(() => {
    staged = [];
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
      expectedActiveRevision: 1,
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

    expect(await screen.findByRole("region", { name: "Validated report previews" })).toBeVisible();
    expect(api.stage).toHaveBeenCalledTimes(3);
    for (const [, input] of api.stage.mock.calls) {
      expect(input).toEqual({ bundleId: expect.any(String), correctionOfSetId: undefined });
    }
    expect(screen.getByText("Users & agents", { exact: true })).toBeVisible();
    expect(screen.getByText("Pseudonymous usernames remain dataset-scoped.")).toBeVisible();
    expect(screen.getAllByText((_text, element) => element?.tagName === "TD" && element.textContent?.includes("freshness unknown") === true)).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    await waitFor(() => expect(api.acceptBundle).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/added to cumulative history/i)).toBeVisible();
    expect(screen.getByText(/and is current/i)).toBeVisible();
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
    await user.click(await screen.findByRole("button", { name: "Accept reviewed bundle" }));

    expect(await screen.findByText(/exactly matched retained snapshot 33333333/i)).toBeVisible();
    expect(screen.getByText(/No new history entry was created/i)).toBeVisible();
    expect(screen.getByText(/Original acceptance remains/)).toHaveTextContent("Aug 1, 2026");
    expect(screen.getByText(/Current selection remains 55555555 and its revision is unchanged/i)).toBeVisible();
    expect(screen.getByText("Current snapshot: 2026-09-01 to 2026-09-30")).toBeVisible();
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
    await screen.findByText(/Accumulated snapshot history/);

    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await screen.findByRole("region", { name: "Validated report previews" })).toBeVisible();
    expect(screen.queryByText(/explicit correction.*before staging/i)).not.toBeInTheDocument();
    for (const [, input] of api.stage.mock.calls) {
      expect(input.correctionOfSetId).toBeUndefined();
    }
    expect(screen.getByText(/ordinary uploads do not require a replacement acknowledgement/i)).toBeVisible();
    expect(screen.getByText(/duplicate observations reuse their original retained identity and acceptance time/i)).toBeVisible();
    expect(screen.getByText(/known reporting window, changed aggregate metrics require the intentional correction option/i)).toBeVisible();
    expect(screen.getByText(/Activity-range-only imports have an unknown reporting window/i)).toBeVisible();
    expect(screen.getByText(/overlapping aggregate exports are non-additive/i)).toBeVisible();
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
    await user.click(await screen.findByText("Intentional correction options"));
    await user.click(screen.getByRole("checkbox", { name: /intentionally corrects/ }));
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

    expect(await screen.findByText(/0 report type\(s\) staged; 2 file\(s\) rejected/)).toHaveTextContent(
      "agents.csv: Invalid count in row 2 users.csv: Unsupported CSV headers",
    );
    expect(api.previewBundle).not.toHaveBeenCalled();
    expect(screen.queryByText(/bundle was not found/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate and stage" })).toBeEnabled();
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
    expect(screen.getByText("1 file(s) selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
    const bundleId = api.stage.mock.calls[0][1].bundleId;
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    await waitFor(() => expect(api.stage).toHaveBeenCalledTimes(4));
    expect(api.stage.mock.calls[3][0].name).toBe("agents.csv");
    expect(api.stage.mock.calls[3][1].bundleId).toBe(bundleId);
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
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    await screen.findByRole("region", { name: "Validated report previews" });
    expect(api.stage.mock.calls[1][1].bundleId).toBe(bundleId);
  });

  it("clears an expired bundle on refresh rather than requesting a nonexistent preview", async () => {
    staged = [preview("agents")];
    api.getAdminState.mockResolvedValueOnce({ ...emptyAdminState, staging: staged })
      .mockResolvedValue(emptyAdminState);
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await screen.findByRole("region", { name: "Validated report previews" });
    expect(api.previewBundle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Refresh import state" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Validated report previews" })).not.toBeInTheDocument());
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

    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);

    expect(await screen.findByText("Corrects 55555555")).toBeVisible();
    expect(screen.getByText("Current", { exact: true })).toBeVisible();
    expect(screen.getByText("Agents, Users & agents, Users")).toBeVisible();
  });

  it("restores actor-owned staging after reload and keeps acceptance disabled until companions arrive", async () => {
    staged = [preview("agents")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);

    expect(await screen.findByRole("region", { name: "Validated report previews" })).toBeVisible();
    expect(screen.getByText("Missing Users & agents, Users")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
  });

  it("allows a complete empty bundle with unknown activity coverage and no date prompts", async () => {
    staged = (["agents", "userAgents", "users"] as const).map(kind => ({
      ...preview(kind),
      rowCount: 0,
      reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range" },
    }));
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);

    await screen.findByRole("region", { name: "Validated report previews" });
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

  it("reports failed discards and retains the server bundle for retry", async () => {
    staged = [preview("agents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.discard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("discard failed"));
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await screen.findByRole("region", { name: "Validated report previews" });

    await user.click(screen.getByRole("button", { name: "Discard staging" }));
    expect(await screen.findByText(/1 staged report\(s\) could not be discarded/)).toBeVisible();
    expect(api.previewBundle).toHaveBeenCalled();
  });
});
