import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    render(<OfficialUsageImportPanel onChanged={onChanged} />);
    await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Reporting start"), { target: { value: "2026-06-07" } });
    fireEvent.change(screen.getByLabelText("Reporting end"), { target: { value: "2026-07-06" } });
    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await screen.findByRole("region", { name: "Validated report previews" })).toBeVisible();
    expect(api.stage).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Users & agents", { exact: true })).toBeVisible();
    expect(screen.getByText("Pseudonymous usernames remain dataset-scoped.")).toBeVisible();
    expect(screen.getAllByText((_text, element) => element?.tagName === "TD" && element.textContent?.includes("freshness unknown") === true)).toHaveLength(3);

    await user.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    await waitFor(() => expect(api.acceptBundle).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/three-file set is active/i)).toBeVisible();
    expect(onChanged).toHaveBeenCalledOnce();
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
    expect(screen.getByText("Active", { exact: true })).toBeVisible();
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
