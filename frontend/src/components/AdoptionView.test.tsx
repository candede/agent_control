import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptionGroup, AdoptionPage } from "../../../backend/src/types/adoption";
import { ApiError } from "../api/client";
import * as api from "../api/reportData";
import { reportPage, reportSelection, reports, source } from "../test/reportDataFixture";
import { PublicationContext } from "../publicationContext";
import { parseUsersRoute, usersRouteSearch } from "../workbenchRouting";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { AdoptionView } from "./AdoptionView";
import { CopilotUsersView } from "./CopilotUsersView";

vi.mock("../api/reportData", async original => ({
  ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn(), readReportFacet: vi.fn(),
}));
const group: AdoptionGroup = {
  id: "group-hr", company: "Contoso", department: "HR",
  people: [
    { id: "person-1", name: "Maya", agents: 10, responses: 200, champion: true },
    { id: "person-2", name: "Alex", agents: 2, responses: 40, champion: true },
    { id: "person-3", name: "Robin", agents: 0, responses: null, champion: false },
  ],
  agents: [{ id: "agent:10000000-0000-4000-8000-000000000001", name: "Policy Assistant",
    description: "Answers employee policy questions.", type: "Microsoft 365 Copilot Agent Builder" }],
};
function page(value: AdoptionGroup[] = [group]): AdoptionPage {
  return { ...reportPage(value), directory: source("directory"), inventoryAvailable: true,
    summary: { people: value.reduce((sum, group) => sum + group.people.length, 0),
      champs: value.reduce((sum, group) => sum + group.people.filter(person => person.champion).length, 0),
      agents: new Set(value.flatMap(group => group.agents.map(agent => agent.id))).size } };
}
const route = { ...parseUsersRoute(""), section: "adoption" as const };
const change = vi.fn(), onOpenAgent = vi.fn(), onOpenPerson = vi.fn();
function mount() {
  return render(<SavedQueryProvider><AdoptionView route={route} change={change} revision={0}
    reportContext={<span>Selected reports</span>} onOpenAgent={onOpenAgent} onOpenPerson={onOpenPerson} /></SavedQueryProvider>);
}
beforeEach(() => {
  vi.mocked(api.readReportPage).mockResolvedValue(page());
  vi.mocked(api.readReportFacet).mockImplementation(async (_path, _selection, field) => ({
    ...reportPage([{ value: field === "company" ? "Contoso" : "HR", count: 1 }]),
  }));
});
afterEach(() => { vi.resetAllMocks(); });

describe("Adoption", () => {
  it("shows both independent lists without collapsed sections or creator details", async () => {
    mount();
    const section = within(await screen.findByRole("region", { name: "Contoso / HR" }));
    expect(section.getByRole("button", { name: "Maya" })).toBeVisible();
    expect(section.getByRole("button", { name: "Robin" })).toBeVisible();
    expect(section.getAllByText("Copilot Champ")).toHaveLength(2);
    expect(section.getByText("10/200")).toBeVisible();
    expect(section.getByText("0/Unknown")).toBeVisible();
    expect(section.getByText("3 users · 1 agent")).toBeVisible();
    expect(section.getByText("Answers employee policy questions.")).toBeVisible();
    expect(section.getByText("Agent Builder")).toBeVisible();
    expect(document.querySelector("details")).toBeNull();
    expect(screen.queryByText(/Built in group|Used by|Created by/)).not.toBeInTheDocument();
    fireEvent.click(section.getByRole("button", { name: "Policy Assistant" }));
    expect(onOpenAgent).toHaveBeenCalledWith(group.agents[0].id);
    fireEvent.click(section.getByRole("button", { name: "Maya" }));
    expect(onOpenPerson).toHaveBeenCalledWith("person-1");
  });
  it("searches group names and clears only search", async () => {
    mount(); await screen.findByText("Maya");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search groups" }), { target: { value: "Contoso HR" } });
    expect(change).toHaveBeenCalledWith({ ...route, search: "Contoso HR" });
    render(<SavedQueryProvider><AdoptionView route={{ ...route, search: "HR", reportSetId: reports.setId! }} change={change}
      revision={0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(change).toHaveBeenLastCalledWith({ ...route, reportSetId: reports.setId, search: "" });
  });
  it.each(["HR", " "])("uses the shared inline X for entered search %j and preserves group filters", async text => {
    const filtered = { ...route, search: text, company: "Contoso", department: "HR",
      adoptionChamps: "with" as const, adoptionAgents: "with" as const, reportSetId: reports.setId! };
    const content = (search: string) => <SavedQueryProvider><AdoptionView route={{ ...filtered, search }} change={change}
      revision={0} reportContext={null} onOpenPerson={onOpenPerson} /></SavedQueryProvider>;
    const view = render(content(text));
    const search = screen.getByRole("searchbox", { name: "Search groups" });
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear).toHaveClass("agent-search-clear");
    expect(search.parentElement).toHaveClass("agent-search-field-clearable");
    expect(clear.parentElement).toBe(search.parentElement);
    expect(clear.querySelector("svg")).toHaveClass("lucide-x");
    expect(clear.textContent).toBe("");
    expect(clear).toHaveAttribute("title", "Clear search");
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(change).toHaveBeenLastCalledWith({ ...filtered, search: "" });
    expect(search).toHaveFocus();
    view.rerender(content(""));
    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove company filter" })).toHaveTextContent("Contoso");
    expect(screen.getByRole("button", { name: "Remove copilot champs filter" })).toBeVisible();
  });
  it("pages groups using the existing selected-read cursor", async () => {
    const first = page();
    first.page.nextCursor = "group-next";
    vi.mocked(api.readReportPage).mockResolvedValue(first);
    mount(); await screen.findByText("Maya");
    fireEvent.click(screen.getByRole("button", { name: "Next groups" }));
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("copilot-usage/adoption",
      expect.objectContaining({ limit: 5, selectionId: first.selection.id, cursor: "group-next" }), expect.any(AbortSignal)));
  });
  it("shows empty groups and missing agent descriptions without inventing data", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page([{ ...group, agents: [] }]));
    mount();
    expect(await screen.findByText("No organization-built agents found.")).toBeVisible();
    expect(screen.getByText("Robin")).toBeVisible();
  });
  it("renders rich About descriptions using the agent modal sanitizer", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(page([{ ...group, agents: [{
      ...group.agents[0], description: '<p>Finds <strong>HR policies</strong> and onboarding guidance.</p><img src="x" onerror="alert(1)"><script>alert(1)</script>',
    }] }]));
    mount();
    const text = await screen.findByText("HR policies");
    expect(text.tagName).toBe("STRONG");
    expect(text.closest(".adoption-agent-description")).toHaveTextContent("Finds HR policies and onboarding guidance.");
    expect(document.querySelector(".adoption-agent-description script")).toBeNull();
    expect(document.querySelector(".adoption-agent-description img")).not.toHaveAttribute("onerror");
  });
  it("surfaces unavailable sources", async () => {
    const missing = page([]);
    missing.directory = { ...missing.directory, state: "unavailable" };
    missing.inventoryAvailable = false;
    missing.reports = { ...missing.reports, setId: null, availability: "never_imported" };
    vi.mocked(api.readReportPage).mockResolvedValue(missing);
    mount();
    expect(await screen.findByText(/Agent inventory is unavailable/)).toBeVisible();
    expect(screen.getByText(/Usage is unavailable/)).toBeVisible();
    expect(screen.getByText(/Group membership uses unavailable/)).toBeVisible();
  });
  it("surfaces read errors without showing successful empty results", async () => {
    vi.mocked(api.readReportPage).mockRejectedValue(new ApiError(403, "forbidden", "Viewer access required."));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Viewer access required.");
    expect(screen.queryByText(/No saved users|No groups match/)).not.toBeInTheDocument();
  });
  it("keeps Users selected by default and mounts Adoption only when selected", async () => {
    vi.mocked(api.readReportPage).mockImplementation(async path => path === "copilot-usage/adoption" ? page() : reportPage([]));
    render(<SavedQueryProvider><CopilotUsersView /></SavedQueryProvider>);
    expect(screen.getByRole("button", { name: "Users view" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("group", { name: "Users view" }).closest(".copilot-users-header")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "User cohort" })).toBeVisible();
    expect(api.readReportPage).not.toHaveBeenCalledWith("copilot-usage/adoption", expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Adoption" }));
    expect(await screen.findByText("Maya")).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "User cohort" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Users view" }));
    expect(screen.getByRole("combobox", { name: "User cohort" })).toBeVisible();
    expect(screen.queryByText("Maya")).not.toBeInTheDocument();
  });
  it("round trips Adoption without changing existing cohort URLs", () => {
    const state = { ...route, search: "Contoso HR", reportSetId: reports.setId!, company: "~null", department: null,
      adoptionChamps: "with" as const, adoptionAgents: "without" as const };
    expect(parseUsersRoute(usersRouteSearch(state).toString())).toEqual(state);
    expect(usersRouteSearch(parseUsersRoute("")).toString()).toBe("");
    expect(parseUsersRoute("section=invalid").section).toBeUndefined();
    expect(parseUsersRoute("section=adoption&champs=invalid&groupAgents=invalid").adoptionChamps).toBeUndefined();
    expect(parseUsersRoute("company=Contoso&champs=with").company).toBeUndefined();
  });
  it("uses the shared filter popover for organization and group evidence", async () => {
    mount(); await screen.findByText("Maya");
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const filters = within(screen.getByRole("dialog", { name: "Filter groups" }));
    expect(filters.getByRole("searchbox", { name: "Search company options" })).toBeVisible();
    expect(filters.getByRole("searchbox", { name: "Search department options" })).toBeVisible();
    await waitFor(() => expect(filters.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(filters.getByRole("combobox", { name: "Company" }), { target: { value: "~string:Contoso" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, company: "Contoso" });
    fireEvent.change(filters.getByRole("combobox", { name: "Department" }), { target: { value: "~string:HR" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, department: "HR" });
    fireEvent.change(filters.getByRole("combobox", { name: "Copilot Champs" }), { target: { value: "with" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, adoptionChamps: "with" });
    fireEvent.change(filters.getByRole("combobox", { name: "Group agents" }), { target: { value: "without" } });
    expect(change).toHaveBeenLastCalledWith({ ...route, adoptionAgents: "without" });
  });
  it("applies filters to server reads and removes chips without clearing unrelated context", async () => {
    const filtered = { ...route, company: "Contoso", adoptionChamps: "with" as const, adoptionAgents: "without" as const,
      reportSetId: reports.setId!, search: "HR" };
    render(<SavedQueryProvider><AdoptionView route={filtered} change={change} revision={0} reportContext={null}
      onOpenPerson={onOpenPerson} /></SavedQueryProvider>);
    await screen.findByText("Maya");
    expect(api.readReportPage).toHaveBeenCalledWith("copilot-usage/adoption",
      expect.objectContaining({ company: "Contoso", adoptionChamps: "with", adoptionAgents: "without", search: "hr", setId: reports.setId }), expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Filters, 3 active" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove company filter" }));
    expect(change).toHaveBeenLastCalledWith({ ...filtered, company: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(change).toHaveBeenLastCalledWith({ ...filtered, company: undefined, department: undefined,
      adoptionChamps: undefined, adoptionAgents: undefined, search: "" });
  });
  it("refreshes on inventory publication, not merely reordered revision properties", async () => {
    const revisions = page().selection.publicationRevisions;
    const admit = vi.fn();
    const renderPage = (powerPlatform: string) => <SavedQueryProvider>
      <PublicationContext value={{ admit, revisions: {
        users: revisions.users, power_platform: powerPlatform, graph_packages: revisions.graph_packages,
      } }}>
        <AdoptionView route={route} change={change} revision={0} reportContext={null} onOpenPerson={onOpenPerson} />
      </PublicationContext>
    </SavedQueryProvider>;
    const view = render(renderPage(revisions.power_platform));
    await screen.findByText("Maya");
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    const next = page();
    next.selection = { ...reportSelection(3), publicationRevisions: { ...revisions, power_platform: "4".repeat(64) } };
    vi.mocked(api.readReportPage).mockResolvedValue(next);
    view.rerender(renderPage("4".repeat(64)));
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readReportPage).mock.calls.at(-1)?.[1]?.selectionId).toBeUndefined();
    await waitFor(() => expect(admit).toHaveBeenLastCalledWith(next.selection.publicationRevisions));
  });
});
