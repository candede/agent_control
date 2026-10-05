import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
function Filters({ selection }: { selection?: string }) {
  const [values, setValues] = useState<Values>(defaults);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("responses:desc");
  const searchRef = useRef<HTMLInputElement>(null);
  return <UserActivityFilters values={values} path="official-usage/users" selectionId={selection}
    cohorts={[{ value: "all", label: "All responses" }, { value: "low", label: "Low responses" }]} defaultCohort="all"
    search={search} searchRef={searchRef} sort={sort}
    sorts={[{ value: "responses:desc", label: "Most responses" }, { value: "name:asc", label: "Name ascending" }]}
    loading={false} validThreshold matchingCount={10} onChange={setValues} onSearch={setSearch} onSort={setSort}
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
  it("keeps exact null facets, chip removal, sort and reset behavior", async () => {
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toBeEnabled());
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
    expect(controls.getByRole("combobox", { name: "Company" })).toBeDisabled();
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
    await waitFor(() => expect(controls.getByRole("combobox", { name: "Company" })).toBeEnabled());
    expect(cohort).toHaveFocus();
  });

  it.each(["company", "department"] as const)("restarts %s options on page one after searching and clearing", async field => {
    vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, _field, options) =>
      options?.cursor ? facetPage(null, "facet-previous") : facetPage());
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const select = controls.getByRole("combobox", { name: field === "company" ? "Company" : "Department" });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, "next-options");
    await waitFor(() => expect(select).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, field,
      expect.objectContaining({ search: "", cursor: "facet-next" }));
    const search = controls.getByRole("searchbox", { name: `Search ${field} options` });
    fireEvent.change(search, { target: { value: "Contoso" } });
    await waitFor(() => expect(select).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, field,
      expect.objectContaining({ search: "Contoso", cursor: undefined }));
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(select).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, field,
      expect.objectContaining({ search: "", cursor: undefined }));
  });

  it("keeps the facet search mounted and focused when it is cleared during an options read", async () => {
    render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const search = await controls.findByRole("searchbox", { name: "Search company options" });
    await user.type(search, "C");
    await waitFor(() => expect(controls.getByRole("combobox", { name: "Company" })).toBeEnabled());
    const pending = deferred<Awaited<ReturnType<typeof api.readReportFacet>>>();
    vi.mocked(api.readReportFacet).mockReturnValue(pending.promise);
    await user.clear(search);
    expect(search).toBeInTheDocument();
    expect(search).toHaveFocus();
    await act(async () => pending.resolve(facetPage(null)));
    await waitFor(() => expect(controls.getByRole("combobox", { name: "Company" })).toBeEnabled());
    expect(search).toBeInTheDocument();
    expect(search).toHaveFocus();
    await user.type(search, "D");
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, "company",
      expect.objectContaining({ search: "D", cursor: undefined }));
  });

  it("discards a paged facet cursor when the parent selection is withdrawn and restored", async () => {
    const view = render(<Filters selection={selectionId} />);
    const { user, controls } = await openFilters();
    const company = controls.getByRole("combobox", { name: "Company" });
    await waitFor(() => expect(company).toBeEnabled());
    await user.selectOptions(company, "next-options");
    await waitFor(() => expect(company).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/users", selectionId, "company",
      expect.objectContaining({ cursor: "facet-next" }));
    const calls = vi.mocked(api.readReportFacet).mock.calls.length;
    view.rerender(<Filters />);
    expect(company).toBeDisabled();
    expect(api.readReportFacet).toHaveBeenCalledTimes(calls);
    view.rerender(<Filters selection={selectionId} />);
    await waitFor(() => expect(company).toBeEnabled());
    const requests = vi.mocked(api.readReportFacet).mock.calls.slice(calls);
    expect(requests).toHaveLength(2);
    expect(requests.every(([, , , options]) => options?.cursor === undefined)).toBe(true);
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
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next creator type options" }));
    await waitFor(() => expect(select).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/aggregate", selectionId, "creatorType",
      expect.objectContaining({ cursor: "facet-next" }));
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "Contoso" } });
    await waitFor(() => expect(select).toBeEnabled());
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(select).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("official-usage/aggregate", selectionId, "creatorType",
      expect.objectContaining({ search: "", cursor: undefined }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ["official-usage/users", "company"], ["copilot-usage/users", "department"],
  ] as const)("does not send a previous facet cursor to %s/%s", async (path, field) => {
    const view = render(facet());
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Next company options" }));
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith("copilot-usage/users", selectionId, "company",
      expect.objectContaining({ cursor: "facet-next" }));
    view.rerender(facet(path, field));
    await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
    expect(api.readReportFacet).toHaveBeenLastCalledWith(path, selectionId, field,
      expect.objectContaining({ cursor: undefined }));
  });
});
