import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OfficeContext } from "../../../backend/src/types/officeAppAdoption";
import { officeContext, officeHistory } from "../test/officeAdoptionFixture";
import type { OfficeReadOwner } from "../useOfficeAdoption";
import { usageDate } from "../usageInsights";
import type { OfficeRouteState } from "../workbenchRouting";
import { OfficeObservationContext, OfficeObservationNotices } from "./OfficeObservationContext";

function readOwner(context?: OfficeContext, overrides: Partial<OfficeReadOwner> = {}): OfficeReadOwner {
  return {
    context, data: context, query: context?.query ?? {}, scope: "office-fixture", principal: "fixture-principal",
    loading: false, renewing: false, error: null, invalidated: false, leaseEnded: false, restartable: true,
    restart: vi.fn(), retry: vi.fn(), invalidateSelection: vi.fn(), isCurrent: () => Boolean(context),
    ...overrides,
  };
}

const snapshot = officeContext().observation!.id;
const baseline = officeContext({}, 1).observation!.id;
const pinned: OfficeRouteState = { adoption: "office", officeSnapshot: snapshot, officeBaseline: baseline, app: "word" };

describe.each([false, true])("Office observation controls (summary card: %s)", summaryCard => {
  it.each([true, false])("preserves bookmark values without saved context (loading: %s)", loading => {
    render(<OfficeObservationContext owner={readOwner(undefined, {
      query: { officeSnapshot: snapshot, officeBaseline: baseline }, loading,
      error: loading ? null : new Error("Saved context could not be loaded."),
    })} route={pinned} change={vi.fn()} summaryCard={summaryCard} />);
    const observation = screen.getByRole("combobox", { name: "Office observation" });
    expect(observation).toHaveValue(snapshot);
    expect(within(observation).getByRole("option", { selected: true })).toHaveTextContent("Selected observation");
    const comparison = screen.getByRole("combobox", { name: "Office baseline" });
    expect(comparison).toHaveValue(baseline);
    expect(within(comparison).getByRole("option", { selected: true })).toHaveTextContent("Selected baseline");
    expect(observation).toBeDisabled();
    expect(comparison).toBeDisabled();
  });

  it("keeps the validated baseline visible before history loads or after its read fails", () => {
    const context = officeContext({ officeSnapshot: snapshot, officeBaseline: baseline });
    const { rerender } = render(<OfficeObservationContext owner={readOwner(context)} route={pinned}
      change={vi.fn()} summaryCard={summaryCard} />);
    const expectBaseline = () => {
      const comparison = screen.getByRole("combobox", { name: "Office baseline" });
      expect(comparison).toHaveValue(baseline);
      expect(comparison).toBeEnabled();
      expect(within(comparison).getByRole("option", { selected: true }))
        .toHaveTextContent(`${usageDate(context.baseline!.reportRefreshDate)} (selected baseline)`);
    };
    expectBaseline();
    rerender(<OfficeObservationContext owner={readOwner(context)} history={[]} route={pinned}
      change={vi.fn()} summaryCard={summaryCard} />);
    expectBaseline();
  });

  it("offers one eligible earlier observation instead of counting all history rows", () => {
    const change = vi.fn();
    const context = officeContext(), history = officeHistory(context).slice(0, 1);
    render(<OfficeObservationContext owner={readOwner(context)} history={history} route={{ adoption: "office", app: "word" }}
      change={change} summaryCard={summaryCard} />);
    const comparison = screen.getByRole("combobox", { name: "Office baseline" });
    expect(comparison).toHaveValue("");
    fireEvent.change(comparison, { target: { value: baseline } });
    expect(change).toHaveBeenLastCalledWith({ adoption: "office", app: "word", officeBaseline: baseline, officeNotice: undefined });
  });

  it("does not offer the selected date as a baseline or duplicate validated pins", () => {
    const context = officeContext({ officeSnapshot: snapshot, officeBaseline: baseline });
    render(<OfficeObservationContext owner={readOwner(context)} history={officeHistory(context)}
      route={pinned} change={vi.fn()} summaryCard={summaryCard} />);
    const observation = screen.getByRole("combobox", { name: "Office observation" });
    const comparison = screen.getByRole("combobox", { name: "Office baseline" });
    expect(within(observation).getAllByRole("option").filter(option => option.getAttribute("value") === snapshot)).toHaveLength(1);
    expect(within(comparison).getAllByRole("option").filter(option => option.getAttribute("value") === baseline)).toHaveLength(1);
    expect(within(comparison).getAllByRole("option").some(option => option.getAttribute("value") === snapshot)).toBe(false);
    expect(comparison).toHaveValue(baseline);
  });

  it("clears comparison and recovery notice on observation changes without discarding app context", () => {
    const change = vi.fn(), route = { ...pinned, officeNotice: "Recovered observation." };
    render(<OfficeObservationContext owner={readOwner(officeContext())} history={officeHistory()}
      route={route} change={change} summaryCard={summaryCard} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Office observation" }), { target: { value: baseline } });
    expect(change).toHaveBeenLastCalledWith({ ...route, officeSnapshot: baseline, officeBaseline: undefined, officeNotice: undefined });
    fireEvent.change(screen.getByRole("combobox", { name: "Office observation" }), { target: { value: "" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, officeSnapshot: undefined, officeBaseline: undefined, officeNotice: undefined });
  });
});

describe("Office observation notices and first use", () => {
  it("keeps Latest usable while automatic first-run evidence prepares, without inventing a comparison", () => {
    const context = officeContext();
    context.observation = null;
    context.status = { state: "waiting_sources", errorCode: null, message: null };
    const owner = readOwner(context);
    render(<><OfficeObservationContext owner={owner} route={{}} change={vi.fn()} />
      <OfficeObservationNotices owner={owner} route={{}} change={vi.fn()} /></>);
    expect(screen.getByRole("combobox", { name: "Office observation" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Office observation" })).toHaveValue("");
    expect(screen.queryByRole("combobox", { name: "Office baseline" })).not.toBeInTheDocument();
    expect(screen.getByText(/Saved Office evidence synchronizes automatically after ordinary sign-in/)).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Current Office source status: waiting sources.");
  });

  it("hides unsupported comparisons when the only weekly point is the selected report date", () => {
    render(<OfficeObservationContext owner={readOwner(officeContext())} history={officeHistory().slice(-1)}
      route={{}} change={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "Office baseline" })).not.toBeInTheDocument();
  });

  it("reports source failure without changing weekly evidence and returns to current people with filters intact", () => {
    const weeklySnapshot = officeContext({}, 2).observation!.id;
    const context = officeContext({ officeSnapshot: weeklySnapshot, officeBaseline: baseline }, 2);
    context.observation!.kind = "weekly";
    context.status = { state: "failed", errorCode: "reports_access_denied", message: "Office report access was denied." };
    const change = vi.fn(), route = { ...pinned, officeSnapshot: weeklySnapshot, officeNotice: "Saved bookmark restored." };
    render(<OfficeObservationNotices owner={readOwner(context)} route={route} change={change} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Office report access was denied.");
    expect(screen.getByRole("alert")).toHaveTextContent("The measured saved observation above is unchanged");
    expect(screen.getByRole("status")).toHaveTextContent("Saved bookmark restored.");
    expect(screen.getByText("Weekly history contains app and group totals, not individual-person records.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Explore current people" }));
    expect(change).toHaveBeenCalledWith({ ...route, officeSnapshot: undefined, officeBaseline: undefined, officeNotice: undefined });
  });

  it("forwards a retryable read failure to the saved-data retry control", () => {
    const owner = readOwner(undefined, { error: new Error("Saved context could not be loaded.") });
    render(<OfficeObservationNotices owner={owner} route={{}} change={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Saved context could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    expect(owner.retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Explore current people" })).not.toBeInTheDocument();
  });
});
