import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { combinedUser, reportPage, reportUser, selectionId } from "../test/reportDataFixture";
import { CopilotUsersView } from "./CopilotUsersView";
import { ReportFacet } from "./ReportFacet";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportFacet: vi.fn(), readReportPage: vi.fn(),
}));

const viewer: ReturnType<typeof useCapabilityContext> = {
  user: { tenantId: "tenant", homeAccountId: "account", displayName: "Viewer", username: "viewer@example.invalid",
    roles: ["AgentControl.Viewer", "AgentControl.Admin"] },
  loading: false, pending: false, error: undefined, now: Date.now(), views: [], reload: vi.fn(async () => {}), openPermissions: vi.fn(),
};
type FacetPage = Awaited<ReturnType<typeof api.readReportFacet>>;
function facetPage(values: Array<string | null>, page: Partial<FacetPage["page"]> = {}): FacetPage {
  return {
    value: values.map(value => ({ value, count: 10 })), selection: { ...reportPage([]).selection, validatedAt: new Date().toISOString() },
    counts: { total: 100, filtered: 100 },
    page: { limit: 50, nextCursor: null, previousCursor: null, ...page },
  };
}

beforeEach(() => {
  vi.mocked(api.readReportFacet).mockResolvedValue(facetPage(["Contoso"], { nextCursor: "next" }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it("keeps compact option search visible across loading, short pages and empty results", async () => {
  const pending = deferred<FacetPage>();
  vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise).mockResolvedValue({
    ...facetPage([]), counts: { total: 1, filtered: 0 },
  });
  render(<ReportFacet compact alwaysShowSearch path="copilot-usage/adoption" selectionId={selectionId}
    field="company" onChange={vi.fn()} onRestartSelection={vi.fn()} />);
  const search = screen.getByRole("searchbox", { name: "Search company options" });
  expect(search).toBeVisible();
  expect(screen.getByText("Loading company options...")).toHaveClass("sr-only");
  await act(async () => pending.resolve(facetPage(["Contoso"])));
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
  expect(screen.getByRole("searchbox")).toBe(search);
  fireEvent.change(search, { target: { value: "missing" } });
  await screen.findByText("No company options match this search.");
  expect(screen.getByText("No company options match this search.")).toHaveClass("sr-only");
  expect(screen.getByRole("searchbox")).toBe(search);
  expect(search).toBeVisible();
});

describe.each([false, true])("report facet boundaries (compact=%s)", compact => {
  function facet(onChange = vi.fn(), onRestartSelection = vi.fn(), value?: string | null) {
    return <ReportFacet compact={compact} path="copilot-usage/users" selectionId={selectionId}
      field="company" value={value} onChange={onChange} onRestartSelection={onRestartSelection} />;
  }
  function move(direction: "next" | "previous") {
    if (compact) fireEvent.change(screen.getByRole("combobox"), { target: { value: `${direction}-options` } });
    else fireEvent.click(screen.getByRole("button", { name: `${direction === "next" ? "Next" : "Previous"} company options` }));
  }

  it("preserves options across surrounding whitespace and case- or Unicode-equivalent search edits", async () => {
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, _field, options) =>
      options?.cursor ? facetPage(["Tail"], { previousCursor: "previous" }) : facetPage(["Contoso"], { nextCursor: "next" }));
    render(facet());
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    move("next");
    await screen.findByRole("option", { name: /^Tail/ });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "   " } });
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: /^Tail/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Contoso" } });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ search: "contoso", cursor: undefined }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " Contoso " } });
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("searchbox")).toHaveValue(" Contoso ");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ＣＯＮＴＯＳＯ" } });
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("searchbox")).toHaveValue("ＣＯＮＴＯＳＯ");
  });

  it("reuses a case-equivalent selection UUID without cancelling pending options", async () => {
    const id = "abcdefab-1234-4567-8901-abcdefabcdef", pending = deferred<FacetPage>();
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    const panel = (selectionId: string) => <ReportFacet compact={compact} path="copilot-usage/users" selectionId={selectionId}
      field="company" onChange={vi.fn()} onRestartSelection={vi.fn()} />;
    const view = render(panel(id.toUpperCase()));
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    view.rerender(panel(id));
    expect(signal?.aborted).toBe(false);
    expect(api.readReportFacet).toHaveBeenCalledOnce();
    await act(async () => pending.resolve({ ...facetPage(["Current"]), selection: { ...reportPage([]).selection, id } }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
  });

  it.each(["account", "tenant", "roles", "path", "field"] as const)(
    "clears private option search and paging before reading a replacement %s", async boundary => {
      const pending = deferred<FacetPage>();
      const replacement = { ...viewer, user: { ...viewer.user!,
        ...(boundary === "account" ? { homeAccountId: "other" } : boundary === "tenant" ? { tenantId: "other" }
          : boundary === "roles" ? { roles: ["AgentControl.Viewer" as const] } : {}),
      } };
      const panel = (changed = false) => <CapabilityContext value={changed ? replacement : viewer}>
        <ReportFacet compact={compact} path={changed && boundary === "path" ? "official-usage/users" : "copilot-usage/users"}
          field={changed && boundary === "field" ? "department" : "company"} selectionId={selectionId}
          onChange={vi.fn()} onRestartSelection={vi.fn()} />
      </CapabilityContext>;
      const view = render(panel());
      await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
      fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Private draft" } });
      await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
      vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise);
      move("next");
      const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
      view.rerender(panel(true));
      expect(signal?.aborted).toBe(true);
      expect(api.readReportFacet).toHaveBeenLastCalledWith(
        boundary === "path" ? "official-usage/users" : "copilot-usage/users", selectionId,
        boundary === "field" ? "department" : "company", expect.objectContaining({ search: "", cursor: undefined }));
      await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
      expect(screen.getByRole("searchbox")).toHaveValue("");
      await act(async () => pending.resolve(facetPage(["Obsolete"])));
      expect(screen.queryByRole("option", { name: /^Obsolete/ })).not.toBeInTheDocument();
      expect(api.readReportFacet).toHaveBeenCalledTimes(4);
    },
  );

  it("preserves a draft through same-owner selection replacement and equivalent role ordering", async () => {
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, id) => ({
      ...facetPage(["Contoso"], { nextCursor: "next" }), selection: { ...reportPage([]).selection, id },
    }));
    const panel = (id: string, reversed = false) => <CapabilityContext value={{ ...viewer,
      user: { ...viewer.user!, roles: reversed ? [...viewer.user!.roles].reverse() : viewer.user!.roles } }}>
      <ReportFacet compact={compact} path="copilot-usage/users" field="company" selectionId={id}
        onChange={vi.fn()} onRestartSelection={vi.fn()} />
    </CapabilityContext>;
    const view = render(panel(selectionId));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: " Contoso " } });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    move("next");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    view.rerender(panel(selectionId, true));
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    view.rerender(panel("replacement", true));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", "replacement", "company",
      expect.objectContaining({ search: "contoso", cursor: undefined }));
    expect(screen.getByRole("searchbox")).toHaveValue(" Contoso ");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
  });

  it.each([null, "next-options"])("preserves off-page selection %s during forward and backward navigation", async value => {
    const onChange = vi.fn();
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, _field, options) =>
      options?.cursor === "next" ? facetPage(["Tail"], { previousCursor: "previous" }) : facetPage(["Contoso"], { nextCursor: "next" }));
    render(facet(onChange, vi.fn(), value));
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    for (const direction of ["next", "previous"] as const) {
      move(direction);
      await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
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
    expect(select).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    expect(select).toHaveAttribute("aria-disabled", "true");
    await act(async () => pending.resolve(facetPage(["Recovered"])));
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(within(select).getByRole("option", { name: /^Recovered/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    expect(onRestartSelection).not.toHaveBeenCalled();
  });

  it("announces empty matches without losing the focused search or selected off-page value", async () => {
    const client = createSavedQueryClient(), pending = deferred<FacetPage>();
    const view = render(<QueryClientProvider client={client}>{facet(vi.fn(), vi.fn(), "Contoso")}</QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    const search = screen.getByRole("searchbox");
    act(() => search.focus());
    vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise);
    fireEvent.change(search, { target: { value: "Missing" } });
    expect(search).toHaveFocus();
    expect(await screen.findByRole("status")).toHaveTextContent("Loading company options");
    const empty = { ...facetPage([]), counts: { total: 100, filtered: 0 } };
    await act(async () => pending.resolve(empty));
    expect(await screen.findByText("No company options match this search.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("combobox")).toHaveValue("~string:Contoso");
    expect(search).toHaveFocus();
    vi.mocked(api.readReportFacet).mockRejectedValueOnce(new Error("Options unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-facet"] }); });
    await screen.findByRole("alert");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(search).toHaveFocus();
    view.unmount();
    client.clear();
  });

  it.each([0, 100])("distinguishes no available options from an empty page (%s matches)", async filtered => {
    vi.mocked(api.readReportFacet).mockResolvedValue({ ...facetPage([]), counts: { total: 100, filtered } });
    render(facet());
    expect(await screen.findByText(filtered
      ? "No company options on this page." : "No company options available.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false");
  });

  it("recovers a rejected cursor from the first option page without recapturing the selection or losing search", async () => {
    const onRestartSelection = vi.fn();
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _id, _field, options) => {
      if (options?.cursor) throw new ApiError(400, "invalid_cursor", "Option cursor expired.");
      return facetPage(["Contoso"], { nextCursor: "next" });
    });
    render(facet(vi.fn(), onRestartSelection));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Contoso" } });
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    move("next");
    expect(await screen.findByRole("alert")).toHaveTextContent("Option cursor expired.");
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ search: "contoso", cursor: undefined }));
    expect(api.readReportFacet).toHaveBeenCalledTimes(4);
    expect(onRestartSelection).not.toHaveBeenCalled();
  });

  it("withdraws cached options and pagination when a background read fails", async () => {
    const client = createSavedQueryClient();
    const view = render(<QueryClientProvider client={client}>{facet()}</QueryClientProvider>);
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(within(select).getByRole("option", { name: /^Contoso/ })).toBeInTheDocument();
    vi.mocked(api.readReportFacet).mockRejectedValueOnce(new ApiError(503, "read_failed", "Options unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-facet"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Options unavailable");
    expect(select).toHaveAttribute("aria-disabled", "true");
    expect(within(select).queryByRole("option", { name: /^Contoso/ })).not.toBeInTheDocument();
    if (compact) expect(within(select).queryByRole("option", { name: "More options..." })).not.toBeInTheDocument();
    else {
      expect(screen.getByText("Unknown options")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Next company options" })).toHaveAttribute("aria-disabled", "true");
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(within(select).getByRole("option", { name: /^Contoso/ })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });
  it("shares simultaneous retries of a failed revalidation without cancelling the active read", async () => {
    const client = createSavedQueryClient(), pending = deferred<FacetPage>();
    const view = render(<QueryClientProvider client={client}>{facet()}</QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    vi.mocked(api.readReportFacet).mockRejectedValueOnce(new Error("Options unavailable"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-facet"] }); });
    const retry = await screen.findByRole("button", { name: "Retry options" });
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading company options...");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry options" })).not.toBeInTheDocument();
    await act(async () => pending.resolve(facetPage(["Recovered"])));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    expect(screen.getByRole("option", { name: /^Recovered/ })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it.each(["mismatched", "expired", "invalid expiry"] as const)("rejects %s facet evidence before exposing options", async evidence => {
    const saved = facetPage(["Wrong evidence"]), invalidated = vi.fn();
    if (evidence === "mismatched") saved.selection = { ...saved.selection, id: "another-selection" };
    else saved.selection = { ...saved.selection, expiresAt: evidence === "expired" ? "2000-01-01T00:00:00Z" : "not-a-date" };
    vi.mocked(api.readReportFacet).mockResolvedValue(saved);
    render(<ReportFacet compact={compact} path="copilot-usage/users" selectionId={selectionId}
      field="company" onChange={vi.fn()} onRestartSelection={vi.fn()} onSelectionInvalidated={invalidated} />);
    if (evidence === "mismatched") await waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
    else expect(await screen.findByRole("alert")).toHaveTextContent("saved-read metadata");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("option", { name: /^Wrong evidence/ })).not.toBeInTheDocument();
    if (evidence === "mismatched") expect(screen.queryByRole("button", { name: "Retry options" })).not.toBeInTheDocument();
  });

  it("ignores retired facet failures instead of invalidating a replacement selection", async () => {
    const obsolete = deferred<FacetPage>(), invalidated = vi.fn();
    vi.mocked(api.readReportFacet).mockReturnValueOnce(obsolete.promise).mockImplementation(async (_path, id) => ({
      ...facetPage(["Current"]), selection: { ...facetPage([]).selection, id },
    }));
    const panel = (id: string) => <ReportFacet compact={compact} path="copilot-usage/users" selectionId={id}
      field="company" onChange={vi.fn()} onRestartSelection={vi.fn()} onSelectionInvalidated={invalidated} />;
    const view = render(panel(selectionId));
    const signal = vi.mocked(api.readReportFacet).mock.calls[0][3]?.signal;
    view.rerender(panel("replacement"));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    await act(async () => obsolete.reject(new ApiError(409, "selection_invalidated", "Old selection retired")));
    expect(invalidated).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: /^Current/ })).toBeInTheDocument();
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
  });

  it("delegates invalidation recovery instead of retrying the invalid selection", async () => {
    const onRestartSelection = vi.fn();
    vi.mocked(api.readReportFacet).mockRejectedValue(new ApiError(409, "selection_invalidated", "Source changed"));
    render(facet(vi.fn(), onRestartSelection));
    expect(await screen.findByRole("alert")).toHaveTextContent("This selection changed or expired.");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Retry options" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    expect(onRestartSelection).toHaveBeenCalledOnce();
    expect(api.readReportFacet).toHaveBeenCalledOnce();
  });

  it.each([
    ["timer", false], ["timer", true], ["focus", false], ["focus", true],
  ] as const)("keeps saved options on %s lease end (pending page=%s) without reloading or invalidating the parent", async (boundary, paging) => {
    const initial = facetPage(["Contoso"], { nextCursor: "next" }), pending = deferred<FacetPage>();
    const invalidated = vi.fn();
    vi.useFakeTimers();
    initial.selection = { ...initial.selection, expiresAt: new Date(Date.now() + 1000).toISOString() };
    vi.mocked(api.readReportFacet).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
    render(<ReportFacet compact={compact} path="copilot-usage/users" selectionId={selectionId}
      field="company" onChange={vi.fn()} onRestartSelection={vi.fn()} onSelectionInvalidated={invalidated} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false");
    if (paging) move("next");
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    if (boundary === "timer") await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    else {
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1001);
      fireEvent.focus(window);
    }
    expect(invalidated).not.toHaveBeenCalled();
    if (paging) expect(signal?.aborted).toBe(false);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("option", { name: /^Contoso/ }) !== null).toBe(!paging);
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing saved options");
    await act(async () => { pending.resolve({ ...initial, value: [{ value: "Late", count: 10 }] }); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.queryByRole("option", { name: /^Late/ }) !== null).toBe(paging);
    expect(invalidated).not.toHaveBeenCalled();
    expect(api.readReportFacet).toHaveBeenCalledTimes(paging ? 2 : 1);
  });

  it.each(["choice", "page", "search"] as const)("checks expiry at a %s action when timers were suspended", async action => {
    const initial = facetPage(["Contoso"], { nextCursor: "next" }), changed = vi.fn();
    vi.useFakeTimers();
    initial.selection = { ...initial.selection, expiresAt: new Date(Date.now() + 1000).toISOString() };
    vi.mocked(api.readReportFacet).mockResolvedValue(initial);
    render(facet(changed));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false");
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1001);
    if (action === "choice") fireEvent.change(screen.getByRole("combobox"), { target: { value: "~string:Contoso" } });
    else if (action === "page") move("next");
    else fireEvent.change(screen.getByRole("searchbox"), { target: { value: "New search" } });
    expect(changed).not.toHaveBeenCalled();
    expect(api.readReportFacet).toHaveBeenCalledOnce();
    fireEvent.focus(window);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("button", { name: "Restart selection" })).not.toBeInTheDocument();
  });

  it("keeps selection rejection terminal across option search edits and cache invalidation", async () => {
    const client = createSavedQueryClient();
    const view = render(<QueryClientProvider client={client}>{facet()}</QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    const search = screen.getByRole("searchbox");
    fireEvent.focus(search);
    vi.mocked(api.readReportFacet).mockRejectedValue(new ApiError(409, "selection_invalidated", "Source changed"));
    fireEvent.change(search, { target: { value: "Contoso" } });
    await screen.findByRole("button", { name: "Restart selection" });
    fireEvent.change(search, { target: { value: "Other" } });
    await act(async () => { await client.invalidateQueries({ queryKey: ["saved", "report-facet"] }); });
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Restart selection" })).toBeInTheDocument();
    view.unmount();
    client.clear();
  });

  it("aborts obsolete pages and ignores late results after a search or selection change", async () => {
    const obsolete = deferred<FacetPage>(), withdrawn = deferred<FacetPage>();
    vi.mocked(api.readReportFacet).mockResolvedValueOnce(facetPage(["Contoso"], { nextCursor: "next" }))
      .mockReturnValueOnce(obsolete.promise).mockResolvedValueOnce(facetPage(["Current"]))
      .mockReturnValueOnce(withdrawn.promise);
    const view = render(facet());
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    move("next");
    const obsoleteSignal = vi.mocked(api.readReportFacet).mock.calls.at(-1)![3]!.signal!;
    expect(obsoleteSignal.aborted).toBe(false);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Current" } });
    expect(obsoleteSignal.aborted).toBe(true);
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    await act(async () => obsolete.resolve(facetPage(["Obsolete"], { previousCursor: "previous" })));
    expect(within(select).queryByRole("option", { name: /^Obsolete/ })).not.toBeInTheDocument();
    expect(within(select).getByRole("option", { name: /^Current/ })).toBeInTheDocument();
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ search: "current", cursor: undefined }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Withdrawn" } });
    const withdrawnSignal = vi.mocked(api.readReportFacet).mock.calls.at(-1)![3]!.signal!;
    view.rerender(<ReportFacet compact={compact} path="copilot-usage/users" field="company"
      onChange={vi.fn()} onRestartSelection={vi.fn()} />);
    expect(withdrawnSignal.aborted).toBe(true);
    await act(async () => withdrawn.resolve(facetPage(["Withdrawn"])));
    expect(select).toHaveAttribute("aria-disabled", "true");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    expect(api.readReportFacet).toHaveBeenCalledTimes(4);
  });

  it("shares pending options until the final observer leaves, without reviving a cancelled result", async () => {
    const client = createSavedQueryClient(), pending = deferred<FacetPage>();
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    const panels = (first: boolean) => <QueryClientProvider client={client}>
      {first ? <section key="first" aria-label="First reader">{facet()}</section> : null}
      <section key="second" aria-label="Second reader">{facet()}</section>
    </QueryClientProvider>;
    const view = render(panels(true));
    expect(api.readReportFacet).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    view.rerender(panels(false));
    expect(signal?.aborted).toBe(false);
    expect(within(screen.getByRole("region", { name: "Second reader" })).getByRole("status")).toHaveTextContent("Loading company options");
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(facetPage(["Cancelled"])));
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
    expect(api.readReportFacet).toHaveBeenCalledOnce();
    client.clear();
  });

  it("reuses ready options for another observer while still sharing explicit revalidation", async () => {
    const client = createSavedQueryClient(), pending = deferred<FacetPage>();
    const panels = (second: boolean) => <QueryClientProvider client={client}>
      <section key="first" aria-label="First reader">{facet()}</section>
      {second ? <section key="second" aria-label="Second reader">{facet()}</section> : null}
    </QueryClientProvider>;
    const view = render(panels(false));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    view.rerender(panels(true));
    expect(api.readReportFacet).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("combobox").every(select => select.getAttribute("aria-disabled") === "false")).toBe(true);
    act(() => { void client.invalidateQueries({ queryKey: ["saved", "report-facet"] }); });
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(facetPage(["Revalidated"])));
    await waitFor(() => expect(screen.getAllByRole("option", { name: /^Revalidated/ })).toHaveLength(2));
    view.unmount();
    client.clear();
  });

  it.each(["choice", "page"] as const)("does not admit a %s before a background read reaches React", async action => {
    const client = createSavedQueryClient(), pending = deferred<FacetPage>(), changed = vi.fn();
    const view = render(<QueryClientProvider client={client}>{facet(changed)}</QueryClientProvider>);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    act(() => {
      void client.invalidateQueries({ queryKey: ["saved", "report-facet"] });
      if (action === "choice") fireEvent.change(screen.getByRole("combobox"), { target: { value: "~string:Contoso" } });
      else move("next");
    });
    expect(changed).not.toHaveBeenCalled();
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal?.aborted).toBe(false);
    await act(async () => pending.resolve(facetPage(["Current"])));
    await screen.findByRole("option", { name: /^Current/ });
    view.unmount();
    client.clear();
  });

  it.each(["choice", "page", "search", "retry"] as const)(
    "keeps cache rejection terminal before a %s reaches React", async action => {
      const client = createSavedQueryClient(), changed = vi.fn();
      if (action === "retry") vi.mocked(api.readReportFacet).mockRejectedValueOnce(new Error("Unavailable"));
      const view = render(<QueryClientProvider client={client}>{facet(changed)}</QueryClientProvider>);
      if (action === "retry") await screen.findByRole("button", { name: "Retry options" });
      else await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
      act(() => {
        const query = client.getQueryCache().find({ queryKey: ["saved", "report-facet"], exact: false })!;
        // A completed request updates the cache before React's batched notifications.
        query.setState({ error: new ApiError(409, "selection_invalidated", "Selection retired"), status: "error" });
        if (action === "choice") fireEvent.change(screen.getByRole("combobox"), { target: { value: "~string:Contoso" } });
        else if (action === "page") move("next");
        else if (action === "search") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Other" } });
        else fireEvent.click(screen.getByRole("button", { name: "Retry options" }));
      });
      expect(changed).not.toHaveBeenCalled();
      expect(api.readReportFacet).toHaveBeenCalledOnce();
      await screen.findByRole("button", { name: "Restart selection" });
      expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "true");
      view.unmount();
      client.clear();
    },
  );
});

it("keeps report facet keyboard paging focusable while loading or at the last page", async () => {
  const pending = deferred<FacetPage>();
  vi.mocked(api.readReportFacet).mockResolvedValueOnce(facetPage(["Contoso"], { nextCursor: "next" }))
    .mockReturnValueOnce(pending.promise);
  render(<ReportFacet path="copilot-usage/users" field="company" selectionId={selectionId}
    onChange={vi.fn()} onRestartSelection={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
  const next = screen.getByRole("button", { name: "Next company options" });
  next.focus();
  fireEvent.click(next);
  expect(next).toHaveAttribute("aria-disabled", "true");
  expect(next).not.toBeDisabled();
  expect(next).toHaveFocus();
  fireEvent.click(next);
  expect(api.readReportFacet).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve(facetPage(["Last"], { previousCursor: "previous" })));
  await screen.findByRole("option", { name: /^Last/ });
  expect(next).toHaveAttribute("aria-disabled", "true");
  expect(next).toHaveFocus();
  fireEvent.click(next);
  expect(api.readReportFacet).toHaveBeenCalledTimes(2);
});

describe.each(["licenses", "activity"] as const)("%s cohort facet ownership", cohort => {
  it.each([false, true])("preserves facet paging across equivalent row searches (pending=%s)", async pendingPage => {
    const saved = reportPage([cohort === "licenses" ? combinedUser(1) : reportUser(1)], {
      page: { limit: 50, nextCursor: "users-next", previousCursor: null },
    }), pending = deferred<FacetPage>();
    vi.mocked(api.readReportPage).mockResolvedValue(saved);
    const route = { view: cohort, search: "Contoso", page: 0 };
    const view = render(<CopilotUsersView route={route} />);
    await screen.findByRole("button", { name: "User 1" });
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const company = screen.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    vi.mocked(api.readReportFacet).mockReturnValueOnce(pendingPage ? pending.promise
      : Promise.resolve(facetPage(["Tail"], { previousCursor: "previous" })));
    fireEvent.change(company, { target: { value: "next-options" } });
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    if (!pendingPage) await within(company).findByRole("option", { name: "Tail" });
    for (const search of [" Contoso ", "CONTOSO", "ＣＯＮＴＯＳＯ", "Contoso"]) {
      view.rerender(<CopilotUsersView route={{ ...route, search }} />);
      expect(signal?.aborted).toBe(false);
      expect(api.readReportPage).toHaveBeenCalledTimes(2);
      expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    }
    if (pendingPage) await act(async () => pending.resolve(facetPage(["Tail"], { previousCursor: "previous" })));
    await within(company).findByRole("option", { name: "Tail" });
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]).toMatchObject({ search: "contoso", cursor: "users-next" });
  });

  it("preserves pending facet paging through row navigation, but cancels it when the row read fails", async () => {
    const saved = reportPage([cohort === "licenses" ? combinedUser(1) : reportUser(1)], {
      page: { limit: 50, nextCursor: "users-next", previousCursor: null },
    });
    const rows = deferred<typeof saved>(), options = deferred<FacetPage>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(saved).mockReturnValueOnce(rows.promise);
    render(<CopilotUsersView route={{ view: cohort, search: "", page: 0 }} />);
    await screen.findByRole("button", { name: "User 1" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const company = screen.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    vi.mocked(api.readReportFacet).mockReturnValueOnce(options.promise);
    fireEvent.change(company, { target: { value: "next-options" } });
    const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    expect(signal?.aborted).toBe(false);
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    await act(async () => rows.reject(new ApiError(503, "read_failed", "Users unavailable")));
    await screen.findByRole("button", { name: "Retry saved data" });
    expect(signal?.aborted).toBe(true);
    expect(company).toHaveAttribute("aria-disabled", "true");
    await act(async () => options.resolve(facetPage(["Obsolete"])));
    expect(screen.queryByRole("option", { name: /^Obsolete/ })).not.toBeInTheDocument();
  });

  it("retains the ready option cursor without duplicate reads after row paging and focus revalidation", async () => {
    const saved = reportPage([cohort === "licenses" ? combinedUser(1) : reportUser(1)], {
      page: { limit: 50, nextCursor: "users-next", previousCursor: null },
    });
    const rows = deferred<typeof saved>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(saved).mockReturnValueOnce(rows.promise).mockResolvedValue(saved);
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _id, _field, options) =>
      options?.cursor ? facetPage(["Tail"], { previousCursor: "previous" }) : facetPage(["Contoso"], { nextCursor: "next" }));
    render(<CopilotUsersView route={{ view: cohort, search: "", page: 0 }} />);
    await screen.findByRole("button", { name: "User 1" });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const company = screen.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(company, { target: { value: "next-options" } });
    await within(company).findByRole("option", { name: "Tail" });
    fireEvent.click(screen.getByRole("button", { name: "Next users" }));
    expect(within(company).getByRole("option", { name: "Tail" })).toBeInTheDocument();
    await act(async () => rows.resolve(saved));
    await screen.findByRole("button", { name: "User 1" });
    fireEvent.focus(window);
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(within(company).getByRole("option", { name: "Tail" })).toBeInTheDocument();
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
  });
});
