import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OfficialUsageHistoryBundleSummary,
  OfficialUsageHistoryObservationSummary,
  OfficialUsageHistoryView,
  OfficialUsageReportKind,
} from "../api/client";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";

const api = vi.hoisted(() => ({
  getHistory: vi.fn(),
}));

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getOfficialUsageHistory: api.getHistory,
}));

function observation(kind: OfficialUsageReportKind, marker: string, repeatedRowsReused: number): OfficialUsageHistoryObservationSummary {
  return {
    versionId: `version-${marker}-${kind}`,
    kind,
    contentHash: marker.repeat(64).slice(0, 64),
    rowCount: 12,
    uniquePayloadCount: 12 - repeatedRowsReused,
    repeatedRowsReused,
    lineage: {
      kind,
      versionId: `version-${marker}-${kind}`,
      contentHash: marker.repeat(64).slice(0, 64),
      fileHash: marker.repeat(64).slice(0, 64),
      parserVersion: "1",
      schemaVersion: `m365-${kind}-observed-v1`,
      reportingPeriod: {
        startDate: "2026-08-14",
        endDate: "2026-09-12",
        days: 30,
        provenance: "activity_range",
      },
      sourceAsOfProvenance: "absent",
      sourceFreshness: "unknown",
      acceptedAt: "2026-09-13T12:00:00.000Z",
      rowCount: 12,
      warnings: [],
      reconciliation: {},
      supersedesVersionId: null,
    },
  };
}

function bundle(
  id: string,
  options: {
    active?: boolean;
    knownWindow?: boolean;
    startDate?: string;
    endDate?: string;
    repeatedRowsReused?: number;
    supersedesSetId?: string;
    supersedesVersionId?: string;
    deletedAt?: string;
    complete?: boolean;
    expiresAt?: string | null;
  } = {},
): OfficialUsageHistoryBundleSummary {
  const repeatedRowsReused = options.repeatedRowsReused ?? 0;
  const observations = (["agents", "userAgents", "users"] as const)
    .map((kind, index) => observation(kind, `${id.at(-1) ?? "a"}${index}`, index === 0 ? repeatedRowsReused : 0));
  if (options.supersedesVersionId) observations[0].lineage.supersedesVersionId = options.supersedesVersionId;
  return {
    id,
    bundleId: `bundle-${id}`,
    contentHash: "c".repeat(64),
    reportingPeriod: {
      startDate: options.startDate ?? "2026-08-14",
      endDate: options.endDate ?? "2026-09-12",
      provenance: options.knownWindow ? "source_metadata" : "activity_range",
    },
    supersedesSetId: options.supersedesSetId ?? null,
    complete: options.complete ?? true,
    kinds: ["agents", "userAgents", "users"],
    acceptedAt: "2026-09-13T12:00:00.000Z",
    deletedAt: options.deletedAt ?? null,
    createdAt: "2026-09-13T12:00:00.000Z",
    expiresAt: options.expiresAt === undefined ? "2027-03-12T12:00:00.000Z" : options.expiresAt,
    isActive: options.active ?? false,
    observationCount: observations.length,
    rowCount: observations.reduce((sum, item) => sum + item.rowCount, 0),
    uniquePayloadCount: observations.reduce((sum, item) => sum + item.uniquePayloadCount, 0),
    repeatedRowsReused,
    reportingWindowKnown: options.knownWindow ?? false,
    activityRangeIsCoverage: false,
    observations,
  };
}

function history(value = [
  bundle("11111111-1111-4111-8111-111111111111", { repeatedRowsReused: 5 }),
  bundle("22222222-2222-4222-8222-222222222222", {
    active: true,
    knownWindow: true,
    startDate: "2026-08-20",
    endDate: "2026-09-18",
  }),
]): OfficialUsageHistoryView {
  return {
    summary: {
      importCount: value.length,
      uniqueObservationCount: value.reduce((sum, item) => sum + item.observationCount, 0),
      observationRowCount: value.reduce((sum, item) => sum + item.rowCount, 0),
      uniquePayloadCount: value.reduce((sum, item) => sum + item.uniquePayloadCount, 0),
      repeatedRowsReused: value.reduce((sum, item) => sum + item.repeatedRowsReused, 0),
      earliestObservedAt: "2026-08-01T12:00:00.000Z",
      latestObservedAt: "2026-09-13T12:00:00.000Z",
      activityDateRange: {
        earliestDateUtc: "2026-07-01T00:00:00.000Z",
        latestDateUtc: "2026-09-12T00:00:00.000Z",
        provenance: "last_activity_dates",
        provesReportingCoverage: false,
      },
      reportingWindows: {
        knownCount: 1,
        unknownCount: 1,
        overlappingKnownWindowCount: 1,
        additive: false,
      },
      warning: {
        code: "rolling_snapshots_not_additive",
        message: "Rolling 7- and 30-day snapshot totals must not be summed.",
      },
    },
    bundles: {
      value,
      count: value.length,
      limit: 25,
      offset: 0,
    },
  };
}

describe("OfficialUsageHistoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getHistory.mockResolvedValue(history());
  });

  it("labels overlapping and unknown windows as non-additive and exposes duplicate reuse", async () => {
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);

    expect(await screen.findByText("Aggregate snapshots are non-additive.")).toBeVisible();
    expect(screen.getByText("Rolling 7- and 30-day snapshot totals must not be summed.")).toBeVisible();
    expect(screen.getByText(/1 source window\(s\) known; 1 unknown; 1 overlapping/)).toBeVisible();
    expect(screen.getByText(/This does not prove report-window coverage/)).toBeVisible();
    expect(screen.getByText(/Pseudonymous usernames remain scoped to each retained report set/)).toBeVisible();
    expect(screen.getByText(/Semantic duplicate observations reuse their original identity and acceptance time/)).toBeVisible();
    expect(screen.getByText("Observed activity Aug 14, 2026 to Sep 12, 2026")).toBeVisible();
    expect(screen.getByText("Last-activity range only; not proven report coverage")).toBeVisible();
    expect(within(screen.getByLabelText("Official usage history summary")).getByText("Duplicate rows reused").parentElement).toHaveTextContent("5");
    expect(within(screen.getByLabelText("Official usage history summary")).getByText("Unique payloads").parentElement).toHaveTextContent("67");
    expect(screen.getByText("Source-supplied reporting window").parentElement).toHaveTextContent("Aug 20, 2026 to Sep 18, 2026");
    await userEvent.click(screen.getAllByText("3 observation(s)")[0]);
    expect(screen.getByText(/7 unique payloads, 5 duplicate rows reused/)).toBeVisible();
    expect(screen.getAllByText(/Original acceptance/)[0]).toHaveTextContent("Sep 13, 2026");
  });

  it("distinguishes null, invalid, finite legacy, and deleted retention states", async () => {
    const supersededSetId = "33333333-3333-4333-8333-333333333333";
    const supersededVersionId = "version-before-correction";
    api.getHistory.mockResolvedValue(history([
      bundle("11111111-1111-4111-8111-111111111111", {
        supersedesSetId: supersededSetId,
        supersedesVersionId: supersededVersionId,
        expiresAt: null,
      }),
      bundle("22222222-2222-4222-8222-222222222222", {
        expiresAt: "not-a-retention-date",
      }),
      bundle("44444444-4444-4444-8444-444444444444", {
        expiresAt: "2027-03-12T12:00:00.000Z",
      }),
      bundle("55555555-5555-4555-8555-555555555555", {
        deletedAt: "2026-09-14T12:00:00.000Z",
        expiresAt: null,
      }),
    ]));
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);

    expect(await screen.findByText("Intentional correction of 33333333")).toBeVisible();
    expect(screen.getByText("Retained until explicitly deleted")).toBeVisible();
    expect(screen.getByText("Retention date unavailable")).toBeVisible();
    expect(screen.getByText(/Legacy finite retention until Mar 12, 2027/)).toBeVisible();
    expect(screen.getByText(/Deleted Sep 14, 2026/)).toBeVisible();
    await userEvent.click(screen.getAllByText("3 observation(s)")[0]);
    expect(screen.getByText(/corrects observation version-/)).toBeVisible();
    expect(screen.getAllByText("Unavailable")).not.toHaveLength(0);
  });

  it("browses an exact retained snapshot without selecting or mutating it", async () => {
    const onSelect = vi.fn();
    const view = render(<OfficialUsageHistoryPanel revision={0} onSelect={onSelect} />);
    await screen.findByText("Observed activity Aug 14, 2026 to Sep 12, 2026");
    await userEvent.click(screen.getByRole("button", { name: "View snapshot" }));
    const selectedId = "11111111-1111-4111-8111-111111111111";
    expect(onSelect).toHaveBeenCalledWith(selectedId);

    view.rerender(<OfficialUsageHistoryPanel revision={0} selectedSetId={selectedId} onSelect={onSelect} />);
    expect(screen.getByText(/This read-only view does not change the active snapshot/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Return to current snapshot" }));
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
    expect(api.getHistory).toHaveBeenCalledTimes(1);
  });

  it("pages retained history and preserves the last page when refresh fails", async () => {
    const firstPage = history(Array.from({ length: 25 }, (_, index) =>
      bundle(`11111111-1111-4111-8111-${String(index).padStart(12, "0")}`)));
    firstPage.bundles.count = 26;
    const secondPage = history([bundle("22222222-2222-4222-8222-222222222222")]);
    secondPage.bundles.count = 26;
    secondPage.bundles.offset = 25;
    api.getHistory.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    render(<OfficialUsageHistoryPanel revision={0} onSelect={vi.fn()} />);
    await screen.findByText("1-25 of 26");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("26-26 of 26")).toBeVisible();
    expect(api.getHistory).toHaveBeenLastCalledWith(
      { limit: 25, offset: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    api.getHistory.mockRejectedValueOnce(new Error("History refresh failed"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History refresh failed");
    expect(screen.getByText("26-26 of 26")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh history" })).toBeEnabled());
  });
});
