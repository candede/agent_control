import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { reportPage, selectionId } from "../test/reportDataFixture";
import { ReportFacet } from "./ReportFacet";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportFacet: vi.fn(),
}));

type FacetPage = Awaited<ReturnType<typeof api.readReportFacet>>;
function facetPage(values: Array<string | null>, page: Partial<FacetPage["page"]> = {}): FacetPage {
  return {
    value: values.map(value => ({ value, count: 10 })), selection: reportPage([]).selection,
    counts: { total: 100, filtered: 100 },
    page: { limit: 50, nextCursor: null, previousCursor: null, ...page },
  };
}

beforeEach(() => {
  vi.mocked(api.readReportFacet).mockResolvedValue(facetPage(["Contoso"], { nextCursor: "next" }));
});
afterEach(() => { vi.resetAllMocks(); });

describe.each([false, true])("report facet boundaries (compact=%s)", compact => {
  function facet(onChange = vi.fn(), onRestartSelection = vi.fn(), value?: string | null) {
    return <ReportFacet compact={compact} path="copilot-usage/users" selectionId={selectionId}
      field="company" value={value} onChange={onChange} onRestartSelection={onRestartSelection} />;
  }
  function move(direction: "next" | "previous") {
    if (compact) fireEvent.change(screen.getByRole("combobox"), { target: { value: `${direction}-options` } });
    else fireEvent.click(screen.getByRole("button", { name: `${direction === "next" ? "Next" : "Previous"} company options` }));
  }

  it.each([null, "next-options"])("preserves off-page selection %s during forward and backward navigation", async value => {
    const onChange = vi.fn();
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, _field, options) =>
      options?.cursor === "next" ? facetPage(["Tail"], { previousCursor: "previous" }) : facetPage(["Contoso"], { nextCursor: "next" }));
    render(facet(onChange, vi.fn(), value));
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toBeEnabled());
    for (const direction of ["next", "previous"] as const) {
      move(direction);
      await waitFor(() => expect(select).toBeEnabled());
      expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
        expect.objectContaining({ search: "", cursor: direction }));
      expect(select).toHaveValue(api.encodeReportFacetValue(value));
      expect(within(select).getByRole("option", { name: value ?? "Not reported" })).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("retries an initial read failure without restarting the parent selection", async () => {
    const pending = deferred<FacetPage>(), onRestartSelection = vi.fn();
    vi.mocked(api.readReportFacet).mockRejectedValueOnce(new ApiError(503, "read_failed", "Options unavailable"))
      .mockReturnValueOnce(pending.promise);
    render(facet(vi.fn(), onRestartSelection));
    expect(await screen.findByRole("alert")).toHaveTextContent("Options unavailable");
    const select = screen.getByRole("combobox");
    expect(select).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    expect(select).toBeDisabled();
    await act(async () => pending.resolve(facetPage(["Recovered"])));
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getByRole("option", { name: /^Recovered/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    expect(onRestartSelection).not.toHaveBeenCalled();
  });

  it("withdraws cached options and pagination when a background read fails", async () => {
    const client = createSavedQueryClient();
    const view = render(<QueryClientProvider client={client}>{facet()}</QueryClientProvider>);
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getByRole("option", { name: /^Contoso/ })).toBeInTheDocument();
    vi.mocked(api.readReportFacet).mockRejectedValueOnce(new ApiError(503, "read_failed", "Options unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-facet"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Options unavailable");
    expect(select).toBeDisabled();
    expect(within(select).queryByRole("option", { name: /^Contoso/ })).not.toBeInTheDocument();
    if (compact) expect(within(select).queryByRole("option", { name: "More options..." })).not.toBeInTheDocument();
    else {
      expect(screen.getByText("Unknown options")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next company options" })).toBeDisabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(within(select).getByRole("option", { name: /^Contoso/ })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it("delegates invalidation recovery instead of retrying the invalid selection", async () => {
    const onRestartSelection = vi.fn();
    vi.mocked(api.readReportFacet).mockRejectedValue(new ApiError(409, "selection_invalidated", "Source changed"));
    render(facet(vi.fn(), onRestartSelection));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Retry options" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    expect(onRestartSelection).toHaveBeenCalledOnce();
    expect(api.readReportFacet).toHaveBeenCalledOnce();
  });

  it("aborts obsolete pages and ignores late results after a search or selection change", async () => {
    const obsolete = deferred<FacetPage>(), withdrawn = deferred<FacetPage>();
    vi.mocked(api.readReportFacet).mockResolvedValueOnce(facetPage(["Contoso"], { nextCursor: "next" }))
      .mockReturnValueOnce(obsolete.promise).mockResolvedValueOnce(facetPage(["Current"]))
      .mockReturnValueOnce(withdrawn.promise);
    const view = render(facet());
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toBeEnabled());
    move("next");
    const obsoleteSignal = vi.mocked(api.readReportFacet).mock.calls.at(-1)![3]!.signal!;
    expect(obsoleteSignal.aborted).toBe(false);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Current" } });
    expect(obsoleteSignal.aborted).toBe(true);
    await waitFor(() => expect(select).toBeEnabled());
    await act(async () => obsolete.resolve(facetPage(["Obsolete"], { previousCursor: "previous" })));
    expect(within(select).queryByRole("option", { name: /^Obsolete/ })).not.toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /^Current/ })).toBeInTheDocument();
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ search: "Current", cursor: undefined }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Withdrawn" } });
    const withdrawnSignal = vi.mocked(api.readReportFacet).mock.calls.at(-1)![3]!.signal!;
    view.rerender(<ReportFacet compact={compact} path="copilot-usage/users" field="company"
      onChange={vi.fn()} onRestartSelection={vi.fn()} />);
    expect(withdrawnSignal.aborted).toBe(true);
    await act(async () => withdrawn.resolve(facetPage(["Withdrawn"])));
    expect(select).toBeDisabled();
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(api.readReportFacet).toHaveBeenCalledTimes(4);
  });
});
