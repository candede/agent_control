import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { deferred } from "../test/deferred";
import { reportPage, selectionId } from "../test/reportDataFixture";
import { ReportFacet } from "./ReportFacet";
import { UserActivityFilters, type UserActivityFilterValues } from "./UserActivityFilters";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportFacet: vi.fn(),
}));

type Values = UserActivityFilterValues<"all" | "low">;
const defaults: Values = { cohort: "all", lowResponseThreshold: "5" };
function facetPage(nextCursor: string | null = "facet-next", previousCursor: string | null = null): Awaited<ReturnType<typeof api.readReportFacet>> {
  return {
    value: [{ value: "Contoso", count: 10 }, { value: null, count: 2 }],
    selection: reportPage([]).selection, counts: { total: 100, filtered: 100 },
    page: { limit: 50, nextCursor, previousCursor },
  };
}
function Filters({ selection, loading = false, initialSearch = "", initialValues = defaults }: {
  selection?: string; loading?: boolean; initialSearch?: string; initialValues?: Values;
}) {
  const [values, setValues] = useState<Values>(initialValues);
  const [search, setSearch] = useState(initialSearch);
  const [sort, setSort] = useState("responses:desc");
  const searchRef = useRef<HTMLInputElement>(null);
  return <UserActivityFilters values={values} path="official-usage/users" selectionId={selection}
    cohorts={[{ value: "all", label: "All responses" }, { value: "low", label: "Low responses" }]} defaultCohort="all"
    search={search} searchRef={searchRef} sort={sort}
    sorts={[{ value: "responses:desc", label: "Most responses" }, { value: "name:asc", label: "Name ascending" }]}
    loading={loading} validThreshold matchingCount={10} onChange={setValues} onSearch={setSearch} onSort={setSort}
    onClear={() => { setValues(defaults); setSearch(""); }} onRestartSelection={vi.fn()} />;
}
async function openFilters() {
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: /^Filters/ });
  trigger.focus();
  await user.keyboard("{Enter}");
  return { user, trigger, controls: within(screen.getByRole("dialog", { name: "Filter users" })) };
}

beforeEach(() => { vi.mocked(api.readReportFacet).mockResolvedValue(facetPage()); });
afterEach(() => { vi.resetAllMocks(); });

describe("user activity filter controls", () => {
  it.each([false, true])("clears an unfocused search without changing filters while loading=%s", async loading => {
    const user = userEvent.setup();
    render(<><Filters selection={selectionId} loading={loading} initialSearch="Ada"
      initialValues={{ company: "Contoso", cohort: "low", lowResponseThreshold: "10" }} /><button type="button">Outside</button></>);
    const search = screen.getByRole("searchbox", { name: "Search reported users or agents" });
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(search).not.toHaveFocus();
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toBeVisible();
    expect(clear).toBeEnabled();
    expect(clear).toHaveAttribute("title", "Clear search");
    expect(clear).toHaveClass("agent-search-clear");
    expect(search.parentElement).toHaveClass("agent-search-field-clearable");
    await user.click(clear);
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove company filter" })).toHaveTextContent("Contoso");
    expect(screen.getByRole("button", { name: "Remove agent responses filter" })).toHaveTextContent("Low responses");
    expect(screen.getByRole("button", { name: "Remove low-response threshold filter" })).toHaveTextContent("10");
  });

  it.each(["{Enter}", " "])("clears search from the keyboard (%s) and restores input focus", async key => {
    const user = userEvent.setup();
    render(<Filters initialSearch="Ada" />);
    const search = screen.getByRole("searchbox", { name: "Search reported users or agents" });
    search.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear search" })).toHaveFocus();
    await user.keyboard(key);
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("shows Clear search for any entered text, including whitespace, but not when empty", async () => {
    const user = userEvent.setup();
    render(<Filters />);
    const search = screen.getByRole("searchbox", { name: "Search reported users or agents" });
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    await user.type(search, " ");
    expect(screen.getByRole("button", { name: "Clear search" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(search).toHaveValue("");
    await user.type(search, "Ada");
    expect(screen.getByRole("button", { name: "Clear search" })).toBeVisible();
    await user.clear(search);
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
  });

  it("keeps exact null facets, chip removal, sort and reset behavior", async () => {
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    await user.selectOptions(company, "~null");
    await user.selectOptions(controls.getByRole("combobox", { name: "Sort" }), "name:asc");
    await user.selectOptions(controls.getByRole("combobox", { name: "Agent responses" }), "low");
    expect(screen.getByRole("button", { name: "Filters, 2 active" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove company filter" }));
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Filters" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("name:asc");
    expect(screen.getByRole("combobox", { name: "Company" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Agent responses" })).toHaveValue("all");
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeDisabled();
  });

  it("focuses an available filter when organization facets have no selection", async () => {
    render(<Filters />);
    const { user, trigger, controls } = await openFilters();
    expect(controls.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "true");
    expect(controls.getByRole("combobox", { name: "Agent responses" })).toHaveFocus();
    expect(api.readReportFacet).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses an available filter during facet loading without stealing focus when options arrive", async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    render(<Filters selection={selectionId} />);
    const { controls } = await openFilters();
    const cohort = controls.getByRole("combobox", { name: "Agent responses" });
    expect(cohort).toHaveFocus();
    await act(async () => pending.resolve(facetPage()));
    await waitFor(() => expect(controls.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
    expect(cohort).toHaveFocus();
  });

  it.each(["next", "previous"] as const)("keeps keyboard focus while reading the %s option page and rejects unavailable choices", async direction => {
    vi.mocked(api.readReportFacet).mockResolvedValue(facetPage("facet-next", "facet-previous"));
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    await user.selectOptions(company, "~string:Contoso");
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise);
    await user.selectOptions(company, `${direction}-options`);
    expect(company).not.toBeDisabled();
    expect(company).toHaveAttribute("aria-disabled", "true");
    expect(company).toHaveFocus();
    fireEvent.change(company, { target: { value: "" } });
    expect(api.readReportFacet).toHaveBeenCalledTimes(3);
    expect(company).toHaveValue("~string:Contoso");
    expect(screen.getByRole("button", { name: "Remove company filter" })).toBeInTheDocument();
    await act(async () => pending.resolve(facetPage(null)));
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    expect(company).toHaveFocus();
  });

  it("keeps the focused facet available through filter application without admitting retired choices", async () => {
    const view = render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    await user.selectOptions(company, "~string:Contoso");
    view.rerender(<Filters />);
    expect(company).not.toBeDisabled();
    expect(company).toHaveAttribute("aria-disabled", "true");
    expect(company).toHaveFocus();
    fireEvent.change(company, { target: { value: "" } });
    expect(company).toHaveValue("~string:Contoso");
    expect(api.readReportFacet).toHaveBeenCalledTimes(2);
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    view.rerender(<Filters selection="replacement" />);
    expect(company).toHaveFocus();
    await act(async () => pending.resolve({
      ...facetPage(null), selection: { ...reportPage([]).selection, id: "replacement" },
    }));
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    expect(company).toHaveFocus();
    expect(api.readReportFacet).toHaveBeenCalledTimes(4);
  });

  it.each(["company", "department"] as const)("restarts %s options on page one after searching and clearing", async field => {
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, _field, options) =>
      options?.cursor ? facetPage(null, "facet-previous") : facetPage());
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const select = controls.getByRole("combobox", { name: field === "company" ? "Company" : "Department" });
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    await user.selectOptions(select, "next-options");
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, field,
      expect.objectContaining({ search: "", cursor: "facet-next" }));
    const search = controls.getByRole("searchbox", { name: `Search ${field} options` });
    fireEvent.change(search, { target: { value: "Contoso" } });
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, field,
      expect.objectContaining({ search: "contoso", cursor: undefined }));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, field,
      expect.objectContaining({ search: "", cursor: undefined }));
  });

  it("keeps the facet search mounted and focused when it is cleared during an options read", async () => {
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const search = await controls.findByRole("searchbox", { name: "Search company options" });
    await user.type(search, "C");
    await waitFor(() => expect(controls.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    await user.clear(search);
    expect(search).toBeInTheDocument();
    expect(search).toHaveFocus();
    await act(async () => pending.resolve(facetPage(null)));
    await waitFor(() => expect(controls.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
    expect(search).toBeInTheDocument();
    expect(search).toHaveFocus();
    await user.type(search, "D");
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, "company",
      expect.objectContaining({ search: "d", cursor: undefined }));
  });

  it("discards a paged facet cursor when the parent selection is withdrawn and restored", async () => {
    const view = render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    await user.selectOptions(company, "next-options");
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, "company",
      expect.objectContaining({ cursor: "facet-next" }));
    const calls = vi.mocked(api.readReportFacet).mock.calls.length;
    view.rerender(<Filters />);
    expect(company).toHaveAttribute("aria-disabled", "true");
    expect(api.readReportFacet).toHaveBeenCalledTimes(calls);
    view.rerender(<Filters selection={selectionId} />);
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    const requests = vi.mocked(api.readReportFacet).mock.calls.slice(calls);
    expect(requests).toHaveLength(2);
    expect(requests.every(([, , , options]) => options?.cursor === undefined)).toBe(true);
  });

  it.each(["read_failed", "invalid_cursor"] as const)("returns keyboard focus to the company filter after a %s retry", async code => {
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    vi.mocked(api.readReportFacet).mockRejectedValueOnce(new ApiError(400, code, "Options unavailable."));
    await user.selectOptions(company, "next-options");
    const retry = await controls.findByRole("button", { name: "Retry options" });
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise);
    retry.focus();
    await user.keyboard("{Enter}");
    expect(await controls.findByRole("status")).toHaveTextContent("Loading company options");
    expect(controls.queryByRole("alert")).not.toBeInTheDocument();
    const request = vi.mocked(api.readReportFacet).mock.lastCall?.[3];
    expect(request?.cursor).toBe(code === "invalid_cursor" ? undefined : "facet-next");
    expect(api.readReportFacet).toHaveBeenCalledTimes(4);
    await act(async () => pending.resolve(facetPage(null)));
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    expect(company).toHaveFocus();
    expect(api.readReportFacet).toHaveBeenCalledTimes(4);
  });
});

describe("shared report facet pagination", () => {
  const onChange = vi.fn(), onRestartSelection = vi.fn();
  function facet(path = "copilot-usage/users", field: "company" | "department" | "creatorType" = "company") {
    return <ReportFacet path={path} field={field} selectionId={selectionId} onChange={onChange} onRestartSelection={onRestartSelection} />;
  }

  it("restarts noncompact creator options after clearing a search without changing the selected filter", async () => {
    render(facet("official-usage/aggregate", "creatorType"));
    const select = screen.getByRole("combobox");
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Next creator type options" }));
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/aggregate", selectionId, "creatorType",
      expect.objectContaining({ cursor: "facet-next" }));
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Contoso" } });
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(select).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/aggregate", selectionId, "creatorType",
      expect.objectContaining({ search: "", cursor: undefined }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["official-usage/users", "company"], ["copilot-usage/users", "department"],
  ] as const)("does not send a previous facet cursor to %s/%s", async (path, field) => {
    const view = render(facet());
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(screen.getByRole("button", { name: "Next company options" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ cursor: "facet-next" }));
    view.rerender(facet(path, field));
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
    expect(api.readReportFacet).toHaveBeenLastCalledWith(path, selectionId, field,
      expect.objectContaining({ cursor: undefined }));
  });

  it.each(["success", "failure", "focus moved", "owner changed"] as const)(
    "restores only the current keyboard retry's focus after %s", async outcome => {
      vi.mocked(api.readReportFacet).mockRejectedValueOnce(new Error("Options unavailable."));
      const view = render(facet());
      const user = userEvent.setup();
      const retry = await screen.findByRole("button", { name: "Retry options" });
      const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
      vi.mocked(api.readReportFacet).mockReturnValueOnce(pending.promise);
      retry.focus();
      await user.keyboard("{Enter}");
      expect(await screen.findByRole("status")).toHaveTextContent("Loading company options");
      const signal = vi.mocked(api.readReportFacet).mock.lastCall?.[3]?.signal;
      if (outcome === "focus moved") screen.getByRole("searchbox").focus();
      if (outcome === "owner changed") view.rerender(facet("official-usage/users"));
      await act(async () => outcome === "failure"
        ? pending.reject(new Error("Retry unavailable.")) : pending.resolve(facetPage(null)));
      if (outcome === "failure") {
        expect(await screen.findByRole("alert")).toHaveTextContent("Retry unavailable.");
        expect(screen.getByRole("button", { name: "Retry options" })).toHaveFocus();
      } else {
        await waitFor(() => expect(screen.getByRole("combobox")).toHaveAttribute("aria-disabled", "false"));
        if (outcome === "success") expect(screen.getByRole("combobox")).toHaveFocus();
        else if (outcome === "focus moved") expect(screen.getByRole("searchbox")).toHaveFocus();
        else {
          expect(signal?.aborted).toBe(true);
          expect(screen.getByRole("combobox")).not.toHaveFocus();
        }
      }
      expect(api.readReportFacet).toHaveBeenCalledTimes(outcome === "owner changed" ? 3 : 2);
    },
  );
});
