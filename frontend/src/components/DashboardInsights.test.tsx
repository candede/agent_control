import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptionDepartmentPage, adoptionSnapshot, adoptionSummaryPage, reportSelection } from "../test/reportDataFixture";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { DashboardInsights } from "./DashboardInsights";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(data = adoptionDepartmentPage(), summary = adoptionSummaryPage()) {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/copilot-usage/adoption/facets") return Response.json({
      value: [{ value: "Contoso", count: 2 }, { value: "Fabrikam", count: 1 }, { value: null, count: 1 }],
      counts: { total: 3, filtered: 3 }, page: data.page, selection: data.selection,
    });
    if (url.pathname === "/api/copilot-usage/adoption/summary") return Response.json(summary);
    if (url.pathname !== "/api/copilot-usage/adoption/departments") throw new Error(`Unexpected request: ${input}`);
    const company = url.searchParams.get("company");
    const matching = company === "~null" ? [{ id: "missing", company: null, department: null, people: 2, activePeople: 0 }]
      : company ? data.value.filter(row => row.company === company.slice(8)) : data.value;
    const ordered = url.searchParams.get("order") === "asc" ? [...matching].reverse() : matching;
    const limit = Number(url.searchParams.get("limit") ?? data.page.limit);
    const number = Math.min(Number(url.searchParams.get("pageNumber") ?? 1), Math.max(1, Math.ceil(ordered.length / limit)));
    const offset = (number - 1) * limit;
    return Response.json({ ...data, value: ordered.slice(offset, offset + limit),
      counts: { total: data.value.length, filtered: ordered.length },
      page: { limit, number, offset, previousCursor: offset > 0 ? "previous" : null,
        nextCursor: offset + limit < ordered.length ? "next" : null } });
  });
  vi.stubGlobal("fetch", fetcher);
  return { data, fetcher };
}

describe("dashboard insights", () => {
  it("does not reuse a cleaned-up selection for facets while a remounted summary refreshes", async () => {
    const summary = adoptionSummaryPage(), fresh = { ...summary, selection: reportSelection(3) };
    const { fetcher } = fixture(adoptionDepartmentPage(), summary), base = fetcher.getMockImplementation()!;
    const pending = deferred<Response>(), client = createSavedQueryClient();
    let resumed = false;
    fetcher.mockImplementation(async input => {
      const url = new URL(input, "http://localhost");
      if (resumed && url.pathname.endsWith("/summary")) return pending.promise;
      if (resumed && url.pathname.endsWith("/facets")) {
        if (url.searchParams.get("selectionId") === summary.selection.id) {
          return Response.json({ code: "selection_invalidated", detail: "Selection no longer exists." }, { status: 409 });
        }
        return Response.json({ value: [{ value: "Contoso", count: 2 }],
          counts: { total: 1, filtered: 1 }, page: fresh.page, selection: fresh.selection });
      }
      return base(input);
    });
    const panel = () => <QueryClientProvider client={client}>
      <DashboardInsights snapshot={adoptionSnapshot()} revision={0} onCompanyChange={vi.fn()} />
    </QueryClientProvider>;
    const initial = render(panel());
    try {
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
      initial.unmount();
      resumed = true;
      vi.spyOn(performance, "now").mockReturnValue(performance.now() + 40 * 60_000);
      render(panel());
      await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/summary"))).toHaveLength(2));
      expect(within(screen.getByRole("region", { name: "People and engagement" })).getByText("40,000")).toBeVisible();
      expect(within(screen.getByRole("region", { name: "Agents and champions" })).getByText("6")).toBeVisible();
      expect(fetcher.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/facets"))).toHaveLength(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => pending.resolve(Response.json(fresh)));
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
      const facets = fetcher.mock.calls.map(([input]) => new URL(input, "http://localhost")).filter(url => url.pathname.endsWith("/facets"));
      expect(facets.map(url => url.searchParams.get("selectionId"))).toEqual([summary.selection.id, fresh.selection.id]);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      cleanup();
      client.clear();
    }
  });

  it("shows measured department percentages and six evidence-based organization metrics", async () => {
    const { fetcher } = fixture();
    render(<DashboardInsights snapshot={adoptionSnapshot()} baseline={adoptionSnapshot(2, {
      reportingStart: "2026-08-01", reportingEnd: "2026-08-31", responses: 9000,
    })}
      revision={0} onCompanyChange={vi.fn()} />);
    const departments = await screen.findByRole("list", { name: "Department adoption" });
    expect(within(departments).getByText("75%")).toBeVisible();
    expect(within(departments).getByText("30 / 40")).toBeVisible();
    const people = screen.getByRole("region", { name: "People and engagement" });
    expect(within(people).getByText("40,000")).toBeVisible();
    expect(within(people).getByText("20,000")).toBeVisible();
    expect(within(people).getByText("1,000")).toBeVisible();
    const agents = screen.getByRole("region", { name: "Agents and champions" });
    expect(within(agents).getByText("244")).toBeVisible();
    expect(within(agents).getByText("9,693")).toBeVisible();
    expect(within(agents).getByText("6")).toBeVisible();
    expect(within(agents).getByText(/Responses: \+693 \(\+7.7%\) vs baseline/)).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Explore adoption insights" })).not.toBeInTheDocument();
    const finance = new URL(screen.getByRole("link", { name: /Finance/ }).getAttribute("href")!, "http://localhost");
    expect(finance.searchParams.get("company")).toBe("~string:Contoso");
    expect(finance.searchParams.get("department")).toBe("~string:Finance");
    expect(fetcher.mock.calls.every(([input]) => new URL(input, "http://localhost").pathname.startsWith("/api/copilot-usage/adoption"))).toBe(true);
  });

  it("filters departments by company without changing the report or organization-wide cards", async () => {
    const { fetcher } = fixture();
    const onCompanyChange = vi.fn();
    const props = { snapshot: adoptionSnapshot(), revision: 0, onCompanyChange };
    const view = render(<DashboardInsights {...props} />);
    await screen.findByRole("list", { name: "Department adoption" });
    const company = screen.getByRole("combobox", { name: "Company" });
    expect(screen.getByText("Company", { exact: true })).toHaveClass("sr-only");
    await waitFor(() => expect(company).toHaveAttribute("aria-disabled", "false"));
    fireEvent.click(company);
    fireEvent.click(screen.getByRole("option", { name: "Fabrikam" }));
    expect(onCompanyChange).toHaveBeenCalledWith("Fabrikam");
    view.rerender(<DashboardInsights {...props} company="Fabrikam" />);
    const departments = screen.getByRole("region", { name: "Adoption by department" });
    await waitFor(() => expect(within(departments).queryByRole("link", { name: /Finance/ })).not.toBeInTheDocument());
    expect(await within(departments).findByText("25%")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "People and engagement" })).getByText("40,000")).toBeVisible();
    const queries = fetcher.mock.calls.map(([input]) => new URL(input, "http://localhost"))
      .filter(url => url.pathname.endsWith("/departments"));
    expect(queries).toHaveLength(2);
    expect(queries[1].searchParams.get("company")).toBe("~string:Fabrikam");
    expect(queries.every(url => url.searchParams.get("setId") === props.snapshot.id)).toBe(true);
    expect(fetcher.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/summary"))).toHaveLength(1);
    view.rerender(<DashboardInsights {...props} company={null} />);
    expect(await within(departments).findByText("0%")).toBeVisible();
    const missing = new URL(within(departments).getByRole("link", { name: "Department not provided" }).getAttribute("href")!, "http://localhost");
    expect(missing.searchParams.get("company")).toBe("~null");
  });

  it("shows ten departments and jumps directly between numbered pages, resetting for company and sort changes", async () => {
    const value = Array.from({ length: 571 }, (_, index) => ({
      id: `department-${index + 1}`, company: index >= 560 ? "Fabrikam" : "Contoso",
      department: `Department ${index + 1}`, people: 10, activePeople: 5,
    }));
    const { fetcher } = fixture(adoptionDepartmentPage({ value }));
    const props = { snapshot: adoptionSnapshot(), revision: 0, onCompanyChange: vi.fn() };
    const view = render(<DashboardInsights {...props} />);
    const departments = await screen.findByRole("list", { name: "Department adoption" });
    expect(within(departments).getAllByRole("listitem")).toHaveLength(10);
    const navigation = within(screen.getByRole("navigation", { name: "departments pages" }));
    expect(navigation.getByRole("status")).toHaveTextContent("571 matching departments; 10 on this page");
    expect(navigation.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(navigation.getByRole("button", { name: "Page 58" }));
    expect(await within(departments).findByRole("link", { name: /Department 571/ })).toBeVisible();
    expect(within(departments).getAllByRole("listitem")).toHaveLength(1);
    expect(navigation.getByRole("status")).toHaveTextContent("571 matching departments; 1 on this page");
    expect(navigation.getByRole("button", { name: "Page 58" })).toHaveAttribute("aria-current", "page");
    expect(navigation.getByRole("button", { name: "Next departments" })).toHaveAttribute("aria-disabled", "true");
    const requests = () => fetcher.mock.calls.map(([input]) => new URL(input, "http://localhost"))
      .filter(url => url.pathname.endsWith("/departments"));
    expect(requests().map(url => [url.searchParams.get("limit"), url.searchParams.get("pageNumber")]))
      .toEqual([["10", null], ["10", "58"]]);
    expect(requests()[1].searchParams.get("selectionId")).toBe(adoptionDepartmentPage().selection.id);
    fireEvent.click(navigation.getByRole("button", { name: "Previous departments" }));
    expect(await within(departments).findByRole("link", { name: /Department 561/ })).toBeVisible();
    expect(navigation.getByRole("button", { name: "Page 57" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Sort departments by adoption percentage, highest first" }));
    await waitFor(() => expect(navigation.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page"));
    expect(requests().at(-1)!.searchParams.has("pageNumber")).toBe(false);
    fireEvent.click(navigation.getByRole("button", { name: "Page 58" }));
    await waitFor(() => expect(navigation.getByRole("button", { name: "Page 58" })).toHaveAttribute("aria-current", "page"));
    view.rerender(<DashboardInsights {...props} company="Fabrikam" />);
    await waitFor(() => expect(navigation.getByRole("status")).toHaveTextContent("11 matching departments; 10 on this page"));
    expect(navigation.getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
    expect(navigation.queryByRole("button", { name: "Page 58" })).not.toBeInTheDocument();
    expect(requests().at(-1)!.searchParams.has("pageNumber")).toBe(false);
    expect(fetcher.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/summary"))).toHaveLength(1);
  });

  it("preserves unknown metrics instead of presenting missing evidence as zero", async () => {
    const summary = adoptionSummaryPage();
    fixture(adoptionDepartmentPage({
      value: [{ id: "unknown", company: "Contoso", department: "Finance", people: 40, activePeople: null }],
    }), { ...summary, value: [{ champions: null, organization: {
      ...summary.value[0].organization, paidActiveReportUsers: null, needsAttentionUsers: null, activeWithoutPaidUsers: null,
    } }] });
    render(<DashboardInsights snapshot={adoptionSnapshot()} revision={0} onCompanyChange={vi.fn()} />);
    const departments = await screen.findByRole("list", { name: "Department adoption" });
    expect(within(departments).getByText("Unknown")).toBeVisible();
    expect(within(departments).queryByText("0%")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "People and engagement" })).getAllByText("Unknown")).toHaveLength(3);
  });

  it("surfaces saved-data errors with retry and keeps report-only agent counts available", async () => {
    let failed = true;
    const { fetcher } = fixture(), base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async input => failed && new URL(input, "http://localhost").pathname.endsWith("/departments")
      ? Response.json({ code: "temporarily_unavailable", detail: "Saved departments could not be read." }, { status: 503 }) : base(input));
    render(<DashboardInsights snapshot={adoptionSnapshot()} revision={0} onCompanyChange={vi.fn()} />);
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("Saved departments could not be read.");
    expect(within(screen.getByRole("region", { name: "Agents and champions" })).getByText("244")).toBeVisible();
    expect(await within(screen.getByRole("region", { name: "People and engagement" })).findByText("40,000")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Department adoption" })).not.toBeInTheDocument();
    failed = false;
    fireEvent.click(screen.getAllByRole("button", { name: "Retry saved data" })[0]);
    expect(await screen.findByRole("list", { name: "Department adoption" })).toBeVisible();
  });

  it("shows an empty department state without claiming zero organization adoption", async () => {
    fixture(adoptionDepartmentPage({
      value: [], counts: { total: 0, filtered: 0 },
    }));
    render(<DashboardInsights snapshot={adoptionSnapshot()} revision={0} onCompanyChange={vi.fn()} />);
    expect(await screen.findByText(/No saved department members/)).toBeVisible();
    expect(screen.queryByRole("list", { name: "Department adoption" })).not.toBeInTheDocument();
  });

  it("keeps department UI and independent metrics mounted throughout a delayed page transition", async () => {
    const { data, fetcher } = fixture(), base = fetcher.getMockImplementation()!;
    const pending = deferred<Response>();
    fetcher.mockImplementation(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (!url.pathname.endsWith("/departments")) return base(input);
      if (url.searchParams.get("pageNumber") === "2") return pending.promise;
      return Response.json({ ...data, value: [data.value[0]], counts: { total: 2, filtered: 2 },
        page: { limit: 1, number: 1, offset: 0, nextCursor: "next", previousCursor: null } });
    });
    render(<DashboardInsights snapshot={adoptionSnapshot()} revision={0} onCompanyChange={vi.fn()} />);
    const department = screen.getByRole("region", { name: "Adoption by department" });
    const row = await within(department).findByRole("link", { name: /Finance/ });
    const list = within(department).getByRole("list", { name: "Department adoption" });
    const people = within(screen.getByRole("region", { name: "People and engagement" })).getByText("40,000");
    const champion = within(screen.getByRole("region", { name: "Agents and champions" })).getByText("6");
    const nextButton = within(department).getByRole("button", { name: "Next departments" });
    fireEvent.click(within(department).getByRole("button", { name: "Next departments" }));
    await waitFor(() => expect(list).toHaveAttribute("aria-busy", "true"));
    expect(within(department).getByRole("link", { name: /Finance/ })).toBe(row);
    expect(within(department).getByRole("button", { name: "Next departments" })).toBe(nextButton);
    expect(nextButton).toHaveAttribute("aria-disabled", "true");
    expect(people).toBeVisible();
    expect(champion).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Agents and champions" })).queryByText("Unknown")).not.toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ ...data, value: [data.value[1]], counts: { total: 2, filtered: 2 },
      page: { limit: 1, number: 2, offset: 1, nextCursor: null, previousCursor: "previous" } })));
    expect(await within(department).findByRole("link", { name: /Engineering/ })).toBeVisible();
    const next = fetcher.mock.calls.map(([input]) => new URL(input, "http://localhost")).find(url => url.searchParams.get("pageNumber") === "2")!;
    expect(next.searchParams.get("selectionId")).toBe(data.selection.id);
    expect(fetcher.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/summary"))).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "People and engagement" })).getByText("40,000")).toBeVisible();
    fireEvent.click(within(department).getByRole("button", { name: "Previous departments" }));
    expect(await within(department).findByRole("link", { name: /Finance/ })).toBeVisible();
  });

  it("defaults to highest adoption first and changes only the department query when sorting", async () => {
    const { fetcher } = fixture();
    render(<DashboardInsights snapshot={adoptionSnapshot()} revision={0} onCompanyChange={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Department adoption" });
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("75%");
    fireEvent.click(screen.getByRole("button", { name: "Sort departments by adoption percentage, highest first" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Department adoption" })).getAllByRole("listitem")[0]).toHaveTextContent("25%"));
    expect(screen.getByRole("button", { name: "Sort departments by adoption percentage, lowest first" })).toBeVisible();
    const queries = fetcher.mock.calls.map(([input]) => new URL(input, "http://localhost"))
      .filter(url => url.pathname.endsWith("/departments"));
    expect(queries.map(url => [url.searchParams.get("sort"), url.searchParams.get("order")]))
      .toEqual([["adoptionRate", "desc"], ["adoptionRate", "asc"]]);
    expect(fetcher.mock.calls.filter(([input]) => new URL(input, "http://localhost").pathname.endsWith("/summary"))).toHaveLength(1);
  });
});
