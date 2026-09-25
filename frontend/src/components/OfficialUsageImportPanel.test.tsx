import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfficialUsageAdminState,
  OfficialUsageOverviewQuery,
  OfficialUsageReportKind,
  OfficialUsageStagingPreview,
} from "../api/client";
import { ApiError } from "../api/client";
import { legacyUsageStorageKey } from "../legacyUsageStorage";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";
import { OfficialUsageImportPanel } from "./OfficialUsageImportPanel";
import { OfficialUsageImportModal as ControlledImportModal } from "./OfficialUsageImportModal";
import type { SyncReportRouteState } from "../workbenchRouting";
import { reportHistoryFixture } from "./reportHistoryFixture";
import { mockNativeDialogs } from "../test/dialog";
import { usageAggregateFixture, usageOverviewFixture } from "../test/usageInsightsFixture";

mockNativeDialogs();

const api = vi.hoisted(() => ({
  acceptBundle: vi.fn(),
  acknowledge: vi.fn(),
  confirm: vi.fn(),
  discard: vi.fn(),
  getAdminState: vi.fn(),
  getHistory: vi.fn(),
  getOverview: vi.fn(),
  getAggregate: vi.fn(),
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
  getOfficialUsageHistory: api.getHistory,
  getOfficialUsageOverview: api.getOverview,
  getOfficialUsageAggregate: api.getAggregate,
  previewOfficialUsageBundle: api.previewBundle,
  previewOfficialUsageSetOperation: api.previewOperation,
  stageOfficialUsageReport: api.stage,
}));

function OfficialUsageImportModal({ onChanged }: { onChanged: () => void }) {
  const [route, setRoute] = useState<SyncReportRouteState>();
  return <>
    <button onClick={() => setRoute({ view: "import", activityWindowDays: 30 })}>Import reports</button>
    <ControlledImportModal route={route} onRouteChange={setRoute} canManage revision={0} onChanged={onChanged} />
  </>;
}

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
    api.getAggregate.mockResolvedValue(usageAggregateFixture());
    api.getOverview.mockImplementation(async query => usageOverviewFixture(query));
    let historyState = emptyAdminState;
    api.getHistory.mockImplementation(async () => {
      await waitFor(() => expect(api.getAdminState).toHaveBeenCalled());
      await Promise.resolve(api.getAdminState.mock.results.at(-1)?.value).then(
        state => { historyState = state ?? emptyAdminState; },
        () => { /* Independent history remains readable when administration fails. */ },
      );
      return reportHistoryFixture(historyState.sets, historyState.activeSetId);
    });
    api.acknowledge.mockResolvedValue(undefined);
    api.discard.mockResolvedValue(undefined);
    api.stage.mockImplementation((file: File, input: { bundleId: string; correctionOfSetId?: string }) => {
      const kind = file.name.startsWith("agents")
        ? "agents"
        : file.name.startsWith("user-agents") ? "userAgents" : "users";
      const value = {
        ...preview(kind, kind === "userAgents" ? "Pseudonymous usernames remain dataset-scoped." : undefined),
        bundleId: input.bundleId,
        correctionOfSetId: input.correctionOfSetId ?? null,
      };
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

  it("deduplicates concurrent initial metadata reads during actual StrictMode replay", async () => {
    const client = createSavedQueryClient();
    render(<QueryClientProvider client={client}>
      <OfficialUsageImportPanel onChanged={vi.fn()} />
      <OfficialUsageImportPanel onChanged={vi.fn()} />
    </QueryClientProvider>, { reactStrictMode: true });
    await waitFor(() => {
      for (const button of screen.getAllByRole("button", { name: "Refresh import state" })) expect(button).toBeEnabled();
    });
    expect(api.getAdminState).toHaveBeenCalledOnce();
    expect(api.previewBundle).not.toHaveBeenCalled();
    expect(api.previewOperation).not.toHaveBeenCalled();
    expect(api.stage).not.toHaveBeenCalled();
    expect(api.acceptBundle).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it.each(["stage", "discard", "refresh", "accept", "select", "delete"] as const)(
    "verifies %s with a fresh read rather than joining pre-mutation metadata", async operation => {
      const reportSet = retainedSet("33333333-3333-4333-8333-333333333333");
      staged = operation === "accept" || operation === "discard" ? [preview("agents"), preview("userAgents"), preview("users")] : [];
      const initial = { ...emptyAdminState, staging: staged, sets: operation === "accept" ? [] : [reportSet] };
      const published = operation === "accept" || operation === "select";
      const updated = {
        ...emptyAdminState, activeRevision: 2,
        activeSetId: published ? reportSet.id : null,
        sets: published ? [reportSet] : [],
      };
      let finishOld!: (state: OfficialUsageAdminState) => void;
      api.getAdminState.mockResolvedValueOnce(initial)
        .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }))
        .mockResolvedValue(updated);
      api.previewOperation.mockResolvedValue({
        id: "set-confirmation", operation, setId: reportSet.id,
        expectedRevision: 1, confirmationHash: "reviewed-hash", activeSetId: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
      api.confirm.mockResolvedValue({ activeSetId: updated.activeSetId, activeRevision: 2 });
      const client = createSavedQueryClient();
      const managing = operation === "select" || operation === "delete" || operation === "refresh";
      render(<QueryClientProvider client={client}>
        <OfficialUsageImportPanel view={managing ? "manage" : "import"} onChanged={vi.fn()} />
      </QueryClientProvider>);
      if (managing) await screen.findByText("Retained", { exact: true });
      else if (operation === "stage") {
        await userEvent.upload(screen.getByLabelText("Official usage CSV files"),
          new File(["agents"], "agents.csv", { type: "text/csv" }));
        await waitFor(() => expect(screen.getByRole("button", { name: "Validate and stage" })).toBeEnabled());
      } else await validationReady();
      const cancelledLease = new AbortController();
      const cancelledRead = readSavedQuery(client, ["official-usage-admin"],
        signal => api.getAdminState({ signal }), cancelledLease.signal);
      const lease = new AbortController();
      const oldRead = readSavedQuery(client, ["official-usage-admin"],
        signal => api.getAdminState({ signal }), lease.signal);
      expect(api.getAdminState).toHaveBeenCalledTimes(2);
      cancelledLease.abort();
      await expect(cancelledRead).rejects.toMatchObject({ kind: "aborted" });
      expect(api.getAdminState.mock.calls[1][0].signal.aborted).toBe(false);
      const assertCurrentMetadata = () => {
        if (operation === "accept") expect(screen.getByText(/added to retained history and is current/)).toBeVisible();
        else if (operation === "select") expect(screen.getByText("Current", { exact: true })).toBeVisible();
        else if (operation === "stage") expect(screen.getByText(/saved report selection changed during validation/)).toBeVisible();
        else if (operation === "discard") expect(screen.getByText(/All staged rows were discarded/)).toBeVisible();
        else expect(screen.getByText("No accepted official usage snapshots are retained.")).toBeVisible();
      };
      try {
        if (operation === "accept") {
          await continueToReview();
          await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
        } else if (operation === "stage") {
          await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
        } else if (operation === "discard") {
          await userEvent.click(screen.getByRole("button", { name: "Discard staging" }));
        } else if (operation === "refresh") {
          await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
        } else {
          await userEvent.click(screen.getByRole("button", {
            name: operation === "select" ? "Make current" : /Delete retained set for/,
          }));
          await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
        }
        await waitFor(() => expect(api.getAdminState).toHaveBeenCalledTimes(3));
        expect(api.getAdminState.mock.calls[1][0].signal.aborted).toBe(false);
        await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
        assertCurrentMetadata();
      } finally {
        await act(async () => {
          finishOld(initial);
          await oldRead;
        });
      }
      assertCurrentMetadata();
    },
  );

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
      expect(input).toEqual({ bundleId: expect.any(String), rejectDuplicateKind: true });
    }
    expect(screen.getByRole("rowheader", { name: "Users & agents" })).toBeVisible();
    expect(screen.getByText("Pseudonymous usernames remain dataset-scoped.")).toBeVisible();
    expect(screen.getAllByText((_text, element) => element?.tagName === "TD" && element.textContent?.includes("freshness unknown") === true)).toHaveLength(3);
    expect(screen.getByText("Bundle hash")).not.toBeVisible();
    await user.click(screen.getByText("Technical validation details"));
    expect(screen.getByText("Bundle hash")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    await waitFor(() => expect(api.acceptBundle).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/added to retained history/i)).toBeVisible();
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
    expect(screen.queryByText(/added to retained history/i)).not.toBeInTheDocument();
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
    expect(screen.queryByText(/added to retained history/i)).not.toBeInTheDocument();
  });

  it("reports an explicitly reused older snapshot outside the bounded admin list and lets it be inspected", async () => {
    const duplicateSetId = "33333333-3333-4333-8333-333333333333";
    const currentSetId = "55555555-5555-4555-8555-555555555555";
    const state = {
      ...emptyAdminState, activeSetId: currentSetId,
      sets: Array.from({ length: 100 }, (_, index) => retainedSet(index ? `recent-set-${index}` : currentSetId)),
    };
    api.getAdminState.mockResolvedValue(state);
    api.acceptBundle.mockResolvedValue({
      setId: duplicateSetId, versionId: "older-version", activeRevision: 1, complete: true, reusedExistingSet: true,
    });
    const onViewSnapshot = vi.fn();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} onViewSnapshot={onViewSnapshot} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    const result = await screen.findByRole("region", { name: "Import result" });
    await waitFor(() => expect(result).toHaveTextContent("The upload exactly matched retained snapshot 33333333"));
    expect(result).toHaveTextContent("No new history entry was created");
    expect(result).toHaveTextContent("Current selection remains 55555555 and its revision is unchanged");
    expect(result).not.toHaveTextContent("added to");
    expect(result).not.toHaveTextContent("could not confirm");
    expect(result).not.toHaveTextContent("Original acceptance remains");
    await userEvent.click(screen.getByRole("button", { name: "View snapshot" }));
    expect(onViewSnapshot).toHaveBeenCalledWith(duplicateSetId);
  });

  it("stages changed reports in the same known window independently without correction acknowledgement", async () => {
    const activeSetId = "33333333-3333-4333-8333-333333333333";
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState,
      activeSetId,
      sets: [{
        id: activeSetId,
        bundleId: "44444444-4444-4444-8444-444444444444",
        reportingPeriod: preview("agents").reportingPeriod,
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
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/Exact duplicate uploads are automatically reused/)).toBeVisible();
    expect(screen.getByText(/Changed reports are saved as independent report sets, even for the same known reporting window/)).toBeVisible();

    await user.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["agents"], "agents.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));

    expect(await continueToReview()).toBeVisible();
    expect(screen.queryByText(/explicit correction.*before staging/i)).not.toBeInTheDocument();
    for (const [, input] of api.stage.mock.calls) {
      expect(input).not.toHaveProperty("correctionOfSetId");
      expect(input.rejectDuplicateKind).toBe(true);
    }
    expect(screen.getByText(/duplicate observations reuse their original retained identity and acceptance time/i)).toBeVisible();
    expect(screen.getByText(/Aggregate snapshots are non-additive/i)).toBeVisible();
  });

  it("keeps a restored legacy correction read-only and restarts independently after discarding staging", async () => {
    const activeSetId = "33333333-3333-4333-8333-333333333333";
    const correctionOfSetId = "55555555-5555-4555-8555-555555555555";
    staged = [{ ...preview("agents"), correctionOfSetId }];
    api.getAdminState.mockResolvedValue({
      ...emptyAdminState,
      activeSetId,
      staging: staged,
      sets: [retainedSet(activeSetId), retainedSet(correctionOfSetId)],
    });
    const user = userEvent.setup();
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();
    const notice = screen.getByRole("note", { name: "Legacy correction draft" });
    expect(notice).toHaveTextContent(correctionOfSetId);
    expect(notice).toHaveTextContent("read-only");
    expect(notice).toHaveTextContent("discard staging");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to files" }));
    expect(notice).toBeVisible();
    const discardedBundleId = staged[0].bundleId;
    const discardedStageId = staged[0].id;
    api.discard.mockImplementation(async () => {
      staged = [];
      api.getAdminState.mockResolvedValue({ ...emptyAdminState, activeSetId, sets: [retainedSet(activeSetId)] });
    });
    await user.click(screen.getByRole("button", { name: "Discard staging" }));
    expect(await screen.findByText(/All staged rows were discarded/)).toBeVisible();
    expect(api.discard).toHaveBeenCalledWith(discardedStageId);
    expect(screen.queryByRole("note", { name: "Legacy correction draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate and stage" })).toBeDisabled();
    await user.upload(screen.getByLabelText("Official usage CSV files"), new File(["agents"], "agents.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage).toHaveBeenCalledWith(expect.any(File), { bundleId: expect.any(String), rejectDuplicateKind: true });
    expect(api.stage.mock.calls[0][1].bundleId).not.toBe(discardedBundleId);
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
    expect(screen.queryByText(/added to retained history/i)).not.toBeInTheDocument();
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

  it.each([false, true])("requires explicit resolution of a duplicate-type draft without replacing earlier previews (restored=%s)", async restored => {
    staged = restored ? [preview("agents"), preview("userAgents"), preview("users")].map(value => ({ ...value, rowCount: 17 })) : [];
    api.getAdminState.mockImplementation(async () => ({ ...emptyAdminState, staging: staged }));
    api.stage.mockImplementation((file: File, input: { bundleId: string; rejectDuplicateKind?: boolean }) => {
      expect(input.rejectDuplicateKind).toBe(true);
      const kind = file.name.startsWith("agents") ? "agents" : file.name.startsWith("user-agents") ? "userAgents" : "users";
      if (staged.some(value => value.bundleId === input.bundleId && value.kind === kind)) {
        return Promise.reject(new ApiError(409, "duplicate_report_kind", "This draft already contains an Agents report."));
      }
      const value = { ...preview(kind), bundleId: input.bundleId, rowCount: 17 };
      staged = [...staged, value];
      return Promise.resolve(value);
    });
    const props = { onChanged: vi.fn() };
    const view = render(<OfficialUsageImportPanel {...props} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
    if (restored) {
      await validationReady();
      await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    }
    const originalFiles = [
      new File(["original"], "agents-original.csv", { type: "text/csv" }),
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ];
    const duplicate = new File(["replacement"], "agents-replacement.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), restored ? [duplicate] : [...originalFiles, duplicate]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    const draftBundleId = staged[0].bundleId;
    const firstPreview = staged[0];
    expect(screen.getByText(/agents-replacement.csv: This draft already contains an Agents report/)).toBeVisible();
    expect(screen.getByText("Agents: 17 rows staged")).toBeVisible();
    expect(screen.getByText("All three report kinds are present")).toBeVisible();
    expect(screen.getByText(/Earlier staged reports were kept/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry rejected files" })).toBeDisabled();

    view.rerender(<OfficialUsageImportPanel {...props} active={false} />);
    view.rerender(<OfficialUsageImportPanel {...props} active />);
    await validationReady();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    fireEvent.change(screen.getByLabelText("Official usage CSV files"), { target: { files: [] } });
    await userEvent.click(screen.getByRole("button", { name: "Show validation" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    await validationReady();
    expect(staged[0]).toBe(firstPreview);
    expect(screen.getByText("Agents: 17 rows staged")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(api.acceptBundle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), originalFiles);
    expect(screen.getByRole("button", { name: "Validate and stage" })).toBeDisabled();

    const failedStageId = staged[0].id;
    let failDiscard = true;
    api.discard.mockImplementation(async (id: string) => {
      if (failDiscard && id === failedStageId) throw new Error("Discard temporarily unavailable.");
      staged = staged.filter(value => value.id !== id);
    });
    await userEvent.click(screen.getByRole("button", { name: "Discard staging" }));
    expect(await screen.findByText(/1 staged report\(s\) could not be discarded/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    failDiscard = false;
    api.discard.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Discard staging" }));
    expect(await screen.findByText(/All staged rows were discarded/)).toBeVisible();
    expect(api.discard).toHaveBeenCalledExactlyOnceWith(failedStageId);
    expect(screen.queryByText(/This draft cannot be accepted/)).not.toBeInTheDocument();
    expect(screen.getByText("No files selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Validate and stage" })).toBeDisabled();
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), originalFiles);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await continueToReview();
    expect(staged).toHaveLength(3);
    expect(staged[0].bundleId).not.toBe(draftBundleId);
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
    for (const [, input] of api.stage.mock.calls) expect(input).not.toHaveProperty("correctionOfSetId");
  });

  it.each([false, true])("can explicitly remove pending files and keep verified staged reports (complete=%s)", async complete => {
    staged = complete ? [preview("agents"), preview("userAgents"), preview("users")] : [preview("agents")];
    const originalPreviews = [...staged];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.stage.mockRejectedValueOnce(new ApiError(409, "duplicate_report_kind", "This draft already contains an Agents report."))
      .mockRejectedValueOnce(new Error("Unsupported CSV headers"));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["replacement"], "agents-replacement.csv", { type: "text/csv" }),
      new File(["unsupported"], "unsupported.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(screen.getByText(/agents-replacement.csv: This draft already contains an Agents report/)).toBeVisible();
    expect(screen.getByText(/unsupported.csv: Unsupported CSV headers/)).toBeVisible();
    expect(screen.getByText(/This removes rejected files and any unvalidated selections, not staged reports/)).toBeVisible();
    expect(api.acceptBundle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Keep staged reports and remove pending files" }));
    expect(screen.getByText(/Rejected and unvalidated file selections were removed from this import/)).toBeVisible();
    expect(screen.getByText(/Earlier staged reports remain unchanged; no files were replaced/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry rejected files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep staged reports and remove pending files" })).not.toBeInTheDocument();
    expect(staged).toEqual(originalPreviews);
    expect(api.discard).not.toHaveBeenCalled();
    expect(api.stage).toHaveBeenCalledTimes(2);
    expect(api.acceptBundle).not.toHaveBeenCalled();
    if (complete) {
      await continueToReview();
      expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
    } else {
      expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
      expect(screen.getByText("Missing Users & agents, Users")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
      expect(screen.getByText("No files selected")).toBeVisible();
    }
  });

  it("requires verified previews before explicitly dropping a changed pending file selection", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.stage.mockRejectedValueOnce(new ApiError(409, "duplicate_report_kind", "This draft already contains an Agents report."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["replacement"], "agents.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["not staged"], "users-new.csv", { type: "text/csv" }));
    expect(screen.getByRole("button", { name: "Keep staged reports and remove pending files" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
    await validationReady();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Keep staged reports and remove pending files" }));
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeEnabled();
    expect(api.stage).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(screen.getByText("No files selected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Validate and stage" })).toBeDisabled();
  });

  it("can discard preserved staging after duplicate rejection even if the bundle preview is unavailable", async () => {
    staged = [preview("agents")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    api.previewBundle.mockRejectedValue(new Error("Preview unavailable."));
    api.stage.mockRejectedValue(new ApiError(409, "duplicate_report_kind", "This draft already contains an Agents report."));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();
    await userEvent.click(screen.getByRole("button", { name: "Back to files" }));
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["replacement"], "agents.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep staged reports and remove pending files" })).toBeDisabled();
    expect(screen.getByText(/Earlier staged reports were kept/)).toBeVisible();
    api.getAdminState.mockResolvedValue(emptyAdminState);
    await userEvent.click(screen.getByRole("button", { name: "Discard staging" }));
    expect(await screen.findByText(/All staged rows were discarded/)).toBeVisible();
    expect(api.discard).toHaveBeenCalledExactlyOnceWith(staged[0].id);
    expect(screen.getByText("No files selected")).toBeVisible();
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

    await userEvent.click(await screen.findByText("3 exports"));
    expect(screen.getByText(/Intentional correction of 55555555/)).toBeVisible();
    expect(screen.getByText("Current", { exact: true })).toBeVisible();
    expect(screen.getByText(/Agents, Users & agents, Users/)).toBeVisible();
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

  it.each([401, 403])("clears denied parallel discard data before its sibling settles for %s", async status => {
    staged = [preview("agents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    let finishSibling!: () => void;
    api.discard.mockRejectedValueOnce(new ApiError(status, "access_revoked", "Import access was revoked."))
      .mockReturnValueOnce(new Promise<void>(resolve => { finishSibling = resolve; }));
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await validationReady();
    await userEvent.click(screen.getByRole("button", { name: "Discard staging" }));
    try {
      expect(await screen.findByRole("alert")).toHaveTextContent("Import access was revoked.");
      expect(screen.queryByRole("region", { name: "Server validation" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Discard staging" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled();
      api.getAdminState.mockResolvedValue(emptyAdminState);
      await userEvent.click(screen.getByRole("button", { name: "Refresh import state" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
    } finally {
      await act(async () => finishSibling());
    }
    expect(api.discard).toHaveBeenCalledTimes(2);
    expect(api.getAdminState).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/All staged rows were discarded/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Server validation" })).not.toBeInTheDocument();
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
    expect(await screen.findByText(/added to retained history and is current/)).toBeVisible();
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
    expect(screen.getByText(/Report administration is not verified/)).toBeVisible();
  });

  it.each(["success", "failure"] as const)(
    "does not steal focus after closing a pending deletion that ends in %s", async outcome => {
      const reportSet = retainedSet("retained-private-set");
      api.getAdminState.mockResolvedValueOnce({ ...emptyAdminState, sets: [reportSet] })
        .mockResolvedValue(emptyAdminState);
      api.previewOperation.mockResolvedValue({
        id: "delete-confirmation", operation: "delete", setId: reportSet.id,
        expectedRevision: 1, confirmationHash: "reviewed-hash", activeSetId: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
      let complete!: () => void;
      api.confirm.mockReturnValueOnce(new Promise((resolve, reject) => {
        complete = () => outcome === "success"
          ? resolve({ activeSetId: null, activeRevision: 2 })
          : reject(new Error("Deletion was not confirmed."));
      }));
      render(<OfficialUsageImportModal onChanged={vi.fn()} />);
      await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
      await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
      await userEvent.click(await screen.findByRole("button", { name: /Delete retained set for/ }));
      const confirmation = screen.getByRole("dialog", { name: "Confirm delete" });
      await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm" }));
      expect(within(confirmation).getByRole("button", { name: "Confirm" })).toBeDisabled();
      await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
      const newControl = screen.getByRole("button", { name: "Manage reports" });
      await userEvent.click(newControl);
      expect(newControl).toHaveFocus();
      await act(async () => complete());
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
      await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
      expect(newControl).toHaveFocus();
      expect(screen.queryByRole("dialog", { name: "Confirm delete" })).not.toBeInTheDocument();
      expect(screen.getByText(outcome === "success" ? /retained set was deleted/ : "Deletion was not confirmed.")).toBeVisible();
    },
  );

  it("announces confirmation errors inside the open native modal and keeps cancellation usable", async () => {
    const reportSet = retainedSet("retained-private-set");
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, sets: [reportSet] });
    api.previewOperation.mockResolvedValue({
      id: "delete-confirmation", operation: "delete", setId: reportSet.id,
      expectedRevision: 1, confirmationHash: "reviewed-hash", activeSetId: null,
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    api.confirm.mockRejectedValueOnce(new Error("Deletion was not confirmed."));
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    const opener = await screen.findByRole("button", { name: /Delete retained set for/ });
    await userEvent.click(opener);
    const confirmation = screen.getByRole("dialog", { name: "Confirm delete" });
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm" }));
    expect(await within(confirmation).findByRole("alert")).toHaveTextContent("Deletion was not confirmed.");
    expect(within(confirmation).getByRole("button", { name: "Confirm" })).toBeEnabled();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.getByRole("alert")).toHaveTextContent("Deletion was not confirmed.");
  });

  it.each([401, 403])("clears denied confirmation data and returns focus to surviving management for %s", async status => {
    const reportSet = retainedSet("retained-private-set");
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, sets: [reportSet] });
    api.previewOperation.mockResolvedValue({
      id: "delete-confirmation", operation: "delete", setId: reportSet.id,
      expectedRevision: 1, confirmationHash: "reviewed-hash", activeSetId: null,
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    api.confirm.mockRejectedValueOnce(new ApiError(status, "access_revoked", "Import access was revoked."));
    render(<OfficialUsageImportPanel view="manage" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete retained set for/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Import access was revoked.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Managed report history" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make current" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Manage retained reports" })).toHaveFocus());
  });

  it("drops an old confirmation when a different staging context starts", async () => {
    const reportSet = retainedSet("retained-private-set");
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, sets: [reportSet] });
    api.previewOperation.mockResolvedValue({
      id: "delete-confirmation", operation: "delete", setId: reportSet.id,
      expectedRevision: 1, confirmationHash: "reviewed-hash", activeSetId: null,
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    const { rerender } = render(<OfficialUsageImportPanel view="manage" onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /Delete retained set for/ }));
    expect(screen.getByRole("dialog", { name: "Confirm delete" })).toBeVisible();
    rerender(<OfficialUsageImportPanel view="manage" initialStagingId="different-stage" onChanged={vi.fn()} />);
    expect(await screen.findByText(/exact staging record is expired, deleted, or unavailable/)).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.confirm).not.toHaveBeenCalled();
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
    const correction = screen.getByRole("note", { name: "Legacy correction draft" });
    expect(correction).toHaveTextContent(correctionId);
    expect(correction).toHaveTextContent("read-only");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), [
      new File(["user agents"], "user-agents.csv", { type: "text/csv" }),
      new File(["users"], "users.csv", { type: "text/csv" }),
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage).toHaveBeenCalledTimes(2);
    for (const [, input] of api.stage.mock.calls) {
      expect(input).toEqual({
        bundleId, correctionOfSetId: correctionId, rejectDuplicateKind: true, reportingStart: period.startDate,
        reportingEnd: period.endDate, periodProvenance: "operator_asserted",
        sourceAsOf, sourceAsOfProvenance: "operator_asserted",
      });
    }
  });

  it("can leave an accepted-only legacy correction draft without deleting retained companions", async () => {
    const correctionId = "original-corrected-snapshot";
    const bundleId = "accepted-only-legacy-bundle";
    const incomplete = {
      ...retainedSet("incomplete-correction", { bundleId }),
      complete: false, acceptedAt: null, kinds: ["agents"] as OfficialUsageReportKind[], supersedesSetId: correctionId,
    };
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, sets: [retainedSet(correctionId), incomplete] });
    api.previewBundle.mockResolvedValueOnce({
      bundleId, bundleHash: "a".repeat(64), expectedActiveRevision: 1, staging: [],
      acceptedVersions: [{
        kind: "agents", versionId: "retained-companion", fileHash: "a".repeat(64),
        reportingPeriod: incomplete.reportingPeriod, sourceAsOf: null, sourceAsOfProvenance: "absent",
      }],
      missingKinds: ["userAgents", "users"], reconciliation: {},
    });
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    await userEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await validationReady();
    expect(screen.getByRole("note", { name: "Legacy correction draft" })).toHaveTextContent(correctionId);
    await userEvent.click(screen.getByRole("button", { name: "Start independent report set" }));
    expect(await screen.findByText(/Previously accepted companions remain retained/)).toBeVisible();
    expect(api.discard).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("note", { name: "Legacy correction draft" })).not.toBeInTheDocument();
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["agents"], "agents.csv", { type: "text/csv" }));
    await userEvent.click(screen.getByRole("button", { name: "Validate and stage" }));
    await validationReady();
    expect(api.stage).toHaveBeenCalledWith(expect.any(File), { bundleId: expect.any(String), rejectDuplicateKind: true });
    expect(api.stage.mock.calls[0][1].bundleId).not.toBe(bundleId);
  });

  it("shows legacy correction intent explicitly during review without offering an editable mode", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")]
      .map(value => ({ ...value, correctionOfSetId: "original-legacy-target" }));
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    render(<OfficialUsageImportPanel onChanged={vi.fn()} />);
    await continueToReview();
    const notice = screen.getByRole("note", { name: "Legacy correction draft" });
    expect(notice).toHaveTextContent("original-legacy-target");
    expect(notice).toHaveTextContent("read-only and will be preserved if accepted");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Discard staging" })).toBeEnabled();
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
    await userEvent.click(within(modal).getByRole("button", { name: "Close reports" }));
    expect(trigger).toHaveFocus();
    await act(async () => {
      staged = [preview("agents")];
      finish(staged[0]);
    });
    expect(api.stage).toHaveBeenCalledTimes(1);
    expect(api.previewBundle).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    expect(modal).not.toHaveAttribute("open");
    expect(document.body.style.overflow).not.toBe("hidden");
    await userEvent.click(trigger);
    await validationReady();
    expect(screen.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    expect(screen.getByText("Missing Users & agents, Users")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry rejected files" })).toBeEnabled();
    expect(api.acceptBundle).not.toHaveBeenCalled();
  });

  it("keeps an interrupted acceptance retryable without fetching report evidence while closed", async () => {
    staged = [preview("agents"), preview("userAgents"), preview("users")];
    api.getAdminState.mockResolvedValue({ ...emptyAdminState, staging: staged });
    let finish!: (value: { setId: string; versionId: string; activeRevision: number; complete: boolean }) => void;
    api.acceptBundle.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await continueToReview();
    await userEvent.click(screen.getByRole("button", { name: "Accept reviewed bundle" }));
    const reviewed = api.acceptBundle.mock.calls[0][0];
    await userEvent.click(screen.getByRole("button", { name: "Close reports" }));
    const reads = api.getAdminState.mock.calls.length;
    await act(async () => finish({ setId: "accepted-set", versionId: "version", activeRevision: 2, complete: true }));
    expect(api.getAdminState).toHaveBeenCalledTimes(reads);
    expect(api.getHistory).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Import reports" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry same acceptance" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Accept reviewed bundle" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Retry same acceptance" }));
    expect(api.acceptBundle.mock.calls[1][0]).toBe(reviewed);
    expect(api.stage).not.toHaveBeenCalled();
  });

  it("defers revision refreshes until reactivation and preserves selected files", async () => {
    const props = { onChanged: vi.fn() };
    const view = render(<OfficialUsageImportPanel {...props} active={false} revision={0} />);
    await act(async () => {});
    expect(api.getAdminState).not.toHaveBeenCalled();
    view.rerender(<OfficialUsageImportPanel {...props} active revision={0} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh import state" })).toBeEnabled());
    await userEvent.upload(screen.getByLabelText("Official usage CSV files"), new File(["agents"], "agents.csv", { type: "text/csv" }));
    view.rerender(<OfficialUsageImportPanel {...props} active={false} revision={1} />);
    await act(async () => {});
    expect(api.getAdminState).toHaveBeenCalledOnce();
    view.rerender(<OfficialUsageImportPanel {...props} active revision={1} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Validate and stage" })).toBeEnabled());
    expect(screen.getByText("1 file(s) selected")).toBeVisible();
    expect(api.getAdminState.mock.calls.length).toBeGreaterThan(1);
    expect(api.stage).not.toHaveBeenCalled();
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
    expect(await screen.findByRole("region", { name: "Retained official usage snapshots" })).toBeVisible();
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

  it("restores admin locator search, dates, order and paging after inspecting a source snapshot", async () => {
    api.getOverview.mockImplementation(async (query: OfficialUsageOverviewQuery) => {
      const data = usageOverviewFixture({ ...query, offset: 0 });
      data.agents = { ...data.agents, offset: query.offset ?? 0, count: 50 };
      return data;
    });
    render(<OfficialUsageImportModal onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Import reports" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage reports" }));
    expect(api.getOverview).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("Find an agent across reports", { selector: "summary" }));
    await screen.findByRole("button", { name: "View source snapshot for Researcher" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search retained agents" }), { target: { value: "Researcher" } });
    fireEvent.change(screen.getByLabelText("Observed activity on or after (UTC)"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Observed activity on or before (UTC)"), { target: { value: "2026-09-20" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Order retained agents" }), "name-desc");
    await userEvent.click(await screen.findByRole("button", { name: "Next retained agents" }));
    await userEvent.click(await screen.findByRole("button", { name: "View source snapshot for Researcher" }));
    await screen.findByText("Showing retained set");
    expect(screen.queryByRole("searchbox", { name: "Search retained agents" })).not.toBeInTheDocument();
    const reads = api.getOverview.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await screen.findByText("Showing retained set");
    expect(api.getOverview).toHaveBeenCalledTimes(reads);
    await userEvent.click(screen.getByRole("button", { name: "Back to reports" }));
    expect(screen.getByRole("searchbox", { name: "Search retained agents" })).toHaveValue("Researcher");
    expect(screen.getByLabelText("Observed activity on or after (UTC)")).toHaveValue("2026-09-01");
    expect(screen.getByLabelText("Observed activity on or before (UTC)")).toHaveValue("2026-09-20");
    expect(screen.getByRole("combobox", { name: "Order retained agents" })).toHaveValue("name-desc");
    await waitFor(() => expect(api.getOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "Researcher", startDate: "2026-09-01", endDate: "2026-09-20", sortBy: "agentName", sortDirection: "desc", offset: 25 }), expect.anything()));
  });
});
