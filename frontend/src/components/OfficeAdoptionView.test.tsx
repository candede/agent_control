import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { officeAdoption } from "../api/officeAppAdoption";
import { officeContext, officeFixtureContext, officeGroup, officeHistory, officePage, officePerson, officeSummary } from "../test/officeAdoptionFixture";
import { mockNativeDialogs } from "../test/dialog";
import { deferred } from "../test/deferred";
import { parseUsersRoute, usersRouteSearch, type UsersRouteState } from "../workbenchRouting";
import { OfficeAdoptionView } from "./OfficeAdoptionView";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { CopilotUsersView } from "./CopilotUsersView";

vi.mock("../api/officeAppAdoption", async original => ({ ...await original<typeof import("../api/officeAppAdoption")>(),
  officeAdoption: { context: vi.fn(), summary: vi.fn(), history: vi.fn(), groups: vi.fn(), facets: vi.fn(), people: vi.fn() } }));
mockNativeDialogs();
afterEach(() => { cleanup(); vi.resetAllMocks(); });
beforeEach(() => {
  vi.mocked(officeAdoption.context).mockImplementation(async input => officeFixtureContext(input!));
  vi.mocked(officeAdoption.summary).mockImplementation(async input => officeSummary(officeFixtureContext(input!)));
  vi.mocked(officeAdoption.history).mockImplementation(async input => {
    const context = officeFixtureContext(input!);
    return officePage(officeHistory(context), context);
  });
  vi.mocked(officeAdoption.groups).mockImplementation(async input => officePage([officeGroup()], officeFixtureContext(input!), {
    page: { limit: 5, number: input?.pageNumber ?? 1, pages: 2, offset: 0, anchor: officeGroup().id, nextCursor: "next-group", previousCursor: null },
    counts: { total: 6, filtered: 6 },
  }));
  vi.mocked(officeAdoption.facets).mockImplementation(async (kind, input) =>
    officePage([{ value: kind === "company" ? "Contoso" : "Engineering", groups: 1, people: 54 }], officeFixtureContext(input!)));
  vi.mocked(officeAdoption.people).mockImplementation(async (_group, input) => {
    const second = input?.pageNumber === 2 || input?.cursor === "next-person";
    return officePage(second ? [officePerson(54)] : [officePerson(1)], officeFixtureContext(input!), {
      counts: { total: 54, filtered: 54 },
      page: { limit: input?.limit ?? 50, number: second ? 2 : 1, pages: 2, offset: second ? 50 : 0, anchor: null,
        nextCursor: second ? null : "next-person", previousCursor: second ? "first-person" : null },
    });
  });
});
function Harness({ initial = { view: "licenses", section: "adoption", adoption: "office", search: "", page: 0 }, wholeUsers = false }: {
  initial?: UsersRouteState; wholeUsers?: boolean;
}) {
  const [route, change] = useState(initial);
  return <SavedQueryProvider>{wholeUsers ? <CopilotUsersView route={route} onRouteChange={change} />
    : <OfficeAdoptionView route={route} change={change} revision={0} />}</SavedQueryProvider>;
}
describe("Office Users adoption", () => {
  it("keeps a first-use Office view available without displaying missing population evidence as zero", async () => {
    const context = officeContext();
    context.observation = null;
    context.status.state = "waiting_sources";
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    vi.mocked(officeAdoption.history).mockResolvedValue(officePage([], context));
    vi.mocked(officeAdoption.groups).mockResolvedValue(officePage([], context));
    render(<Harness wholeUsers />);
    const summary = screen.getByRole("group", { name: "Office adoption summary" });
    await waitFor(() => expect(summary).toHaveAttribute("aria-busy", "false"));
    expect(within(summary).getAllByText("Unknown", { selector: "strong" })).toHaveLength(4);
    expect(within(screen.getByRole("group", { name: "Adoption domain" })).getByRole("button", { name: "Office apps" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText(/No measured Office observation yet/)).toBeVisible();
    expect(screen.queryByText(/No saved licensed groups match/)).not.toBeInTheDocument();
  });
  it("keeps group metrics and champion membership correct without repeating off-page names", async () => {
    render(<Harness />);
    const group = within(await screen.findByRole("region", { name: "Contoso / Engineering" }));
    await group.findByRole("button", { name: "Office Person 1" });
    expect(group.getByText("Office Champ")).toHaveClass("copilot-user-badge");
    expect(group.getByText("Office Champ")).toHaveAttribute("title", expect.stringContaining("ranked by recent app breadth"));
    expect(screen.getByText(/Office Champs are suggestions/)).toBeVisible();
    expect(group.getAllByRole("button",{name:"Office Person 1"})).toHaveLength(1);
    expect(group.queryByRole("heading",{name:/Potential Office champions/})).not.toBeInTheDocument();
    expect(group.queryByText(/People can appear in several apps|people have no recent activity reported/)).not.toBeInTheDocument();
    fireEvent.click(group.getByRole("button", { name: "Next people" }));
    await group.findByRole("button", { name: "Office Person 54" });
    expect(group.getByText("40 reported active / 54 saved licensed")).toBeVisible();
    expect(group.queryByText("Office Champ")).not.toBeInTheDocument();
    expect(group.queryByRole("button", { name: /Office Person [123]$/ })).not.toBeInTheDocument();
    expect(group.getByRole("list", { name: "Seven Office app active-user counts" })).toBeVisible();
    expect(officeAdoption.people).toHaveBeenLastCalledWith(officeGroup().id,
      {selectionId:officeContext().selection.id,limit:50,cursor:"next-person"},expect.any(AbortSignal));
    const before=vi.mocked(officeAdoption.people).mock.calls.length;
    fireEvent.click(group.getByRole("button",{name:"Office Person 54"}));
    await screen.findByRole("region",{name:"Frozen Office person evidence"});
    await waitFor(()=>expect(vi.mocked(officeAdoption.people).mock.calls.slice(before).map(call=>call[1])).toEqual([{
      officeSnapshot:officeContext().observation!.id,selectionId:officeContext().selection.id,limit:50,pageNumber:2,
    }]));
  });
  it("places unknown evidence beneath its person and keeps singular app counts separate", async () => {
    const unknown=officePerson(4,{recentApps:[],latestRecentDate:null,unknownReasons:["no_app_dates"],
      dates:{word:null,excel:null,powerpoint:null,outlook:null,onenote:null,loop:null,teams:null}});
    const single=officePerson(5,{recentApps:["word"],
      dates:{word:"2026-10-20",excel:null,powerpoint:null,outlook:null,onenote:null,loop:null,teams:null}});
    vi.mocked(officeAdoption.people).mockImplementation(async (_group,input)=>
      officePage([officePerson(1),unknown,single],officeFixtureContext(input!)));
    render(<Harness />);
    const unknownName=await screen.findByRole("button",{name:"Office Person 4"});
    const row=within(unknownName.closest("li")!);
    expect(row.getByText("Unknown evidence").parentElement).toHaveClass("office-person-identity");
    expect(row.getByText("Unknown evidence")).toHaveAttribute("title",expect.stringContaining("does not prove inactivity"));
    expect(row.getByText("0 apps")).toHaveClass("adoption-count");
    expect(row.queryByText("Office Champ")).not.toBeInTheDocument();
    expect(screen.getByText("1 app")).toBeVisible();
    expect(screen.queryByText("1 apps")).not.toBeInTheDocument();
  });
  it("marks a qualifying champion when that person appears on a later people page", async () => {
    vi.mocked(officeAdoption.groups).mockImplementation(async input=>
      officePage([officeGroup(1,{champions:[officePerson(54)]})],officeFixtureContext(input!)));
    render(<Harness />);
    const group=within(await screen.findByRole("region",{name:"Contoso / Engineering"}));
    await group.findByRole("button",{name:"Office Person 1"});
    expect(group.queryByText("Office Champ")).not.toBeInTheDocument();
    fireEvent.click(group.getByRole("button",{name:"Next people"}));
    await group.findByRole("button",{name:"Office Person 54"});
    expect(group.getByText("Office Champ")).toHaveClass("copilot-user-badge");
    expect(group.getAllByRole("button",{name:"Office Person 54"})).toHaveLength(1);
  });
  it("does not request historical people and resets pagination when returning to current details",async()=>{
    render(<Harness />);
    const group=within(await screen.findByRole("region",{name:"Contoso / Engineering"}));
    await group.findByRole("button",{name:"Office Person 1"});
    fireEvent.click(group.getByRole("button",{name:"Next people"}));
    await group.findByRole("button",{name:"Office Person 54"});
    const older=officeContext({},2);
    const calls=vi.mocked(officeAdoption.people).mock.calls.length;
    fireEvent.change(screen.getByRole("combobox",{name:"Office observation"}),{target:{value:older.observation!.id}});
    const currentPeople=await screen.findByRole("button",{name:"Explore current people"});
    expect(screen.getByRole("group",{name:"Office adoption summary"})).not.toContainElement(currentPeople);
    expect(within(screen.getByRole("group",{name:"Office adoption summary"})).getByRole("combobox",{name:"Office observation"}))
      .toHaveValue(older.observation!.id);
    expect(currentPeople).toHaveClass("secondary");
    expect(currentPeople).not.toHaveClass("dashboard-text-link");
    expect(vi.mocked(officeAdoption.people).mock.calls).toHaveLength(calls);
    expect(screen.queryByRole("button",{name:"Office Person 1"})).not.toBeInTheDocument();
    fireEvent.click(currentPeople);
    await within(await screen.findByRole("region",{name:"Contoso / Engineering"}))
      .findByRole("button",{name:"Office Person 1"});
  });
  it("uses numbered group bookmarks and the identical selected query", async () => {
    const route: UsersRouteState = { view: "licenses", section: "adoption", adoption: "office", search: "", page: 1,
      company: null, app: "word", officeSnapshot: officeContext().observation!.id };
    render(<Harness initial={route} />);
    await waitFor(() => expect(officeAdoption.groups).toHaveBeenCalledWith(expect.objectContaining({
      officeSnapshot: route.officeSnapshot, company: null, app: "word", selectionId: officeContext().selection.id, limit: 5, pageNumber: 2,
    }), expect.any(AbortSignal)));
    expect(await screen.findByText(/People and suggestions are filtered/)).toBeVisible();
    expect(screen.getByText("40 reported active / 54 saved licensed")).toBeVisible();
  });
  it("restores a deep Office group bookmark and retains its pins while paging", async () => {
    const snapshot = officeContext().observation!.id;
    const agentSnapshot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const initial = parseUsersRoute(`section=adoption&adoption=office&page=2002&app=word&company=~null&officeSnapshot=${snapshot}&snapshot=${agentSnapshot}`);
    vi.mocked(officeAdoption.groups).mockImplementation(async input => {
      const number = input?.pageNumber ?? 1;
      return officePage([officeGroup()], officeFixtureContext(input!), {
        counts: { total: 10_006, filtered: 10_006 },
        page: { limit: 5, number, pages: 2_002, offset: (number - 1) * 5, anchor: officeGroup().id,
          nextCursor: number < 2_002 ? "next-group" : null, previousCursor: number > 1 ? "previous-group" : null },
      });
    });
    function RoutedHarness() {
      const [route, setRoute] = useState(initial);
      return <SavedQueryProvider><OfficeAdoptionView route={route} revision={0}
        change={next => setRoute(parseUsersRoute(usersRouteSearch(next).toString()))} />
        <output aria-label="Office bookmark">{usersRouteSearch(route).toString()}</output></SavedQueryProvider>;
    }
    render(<RoutedHarness />);
    await waitFor(() => expect(officeAdoption.groups).toHaveBeenCalledWith(expect.objectContaining({
      officeSnapshot: snapshot, company: null, app: "word", selectionId: officeContext().selection.id, limit: 5, pageNumber: 2_002,
    }), expect.any(AbortSignal)));
    const pages = within(screen.getByRole("navigation", { name: "groups pages" }));
    expect(await pages.findByRole("button", { name: "Page 2002" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(pages.getByRole("button", { name: "Previous groups" }));
    await waitFor(() => expect(officeAdoption.groups).toHaveBeenLastCalledWith(expect.objectContaining({
      officeSnapshot: snapshot, company: null, app: "word", pageNumber: 2_001,
    }), expect.any(AbortSignal)));
    await waitFor(() => expect(pages.getByRole("button", { name: "Page 2001" })).toHaveAttribute("aria-current", "page"));
    fireEvent.click(pages.getByRole("button", { name: "Next groups" }));
    await waitFor(() => expect(pages.getByRole("button", { name: "Page 2002" })).toHaveAttribute("aria-current", "page"));
    expect(parseUsersRoute(screen.getByLabelText("Office bookmark").textContent ?? "")).toMatchObject({
      page: 2_001, officeSnapshot: snapshot, reportSetId: agentSnapshot, company: null, app: "word",
    });
  });
  it("opens frozen facts even when no current profile or agent report exists, including direct bookmarks", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<Harness initial={{ view: "licenses", section: "adoption", adoption: "office", search: "", page: 0,
      officeSnapshot: officeContext().observation!.id, officeGroup: officeGroup().id, detailId: officePerson(54).identity }} />);
    const frozen = within(await screen.findByRole("region", { name: "Frozen Office person evidence" }));
    expect(frozen.getByText("office54@example.invalid", { exact: false })).toBeVisible();
    expect(frozen.getByRole("list", { name: "Frozen seven-app dates" })).toBeVisible();
    expect(frozen.getByText("2 of 7")).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    expect(officeAdoption.people).toHaveBeenCalledWith(officeGroup().id, expect.objectContaining({ cursor: "next-person", limit: 100 }), expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Close office person 54" }));
    expect(screen.getByRole("heading", { name: "Office adoption groups" })).toHaveFocus();
    vi.unstubAllGlobals();
  });
  it("returns focus to the groups heading when closing before the selected person's page reloads", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const pending = deferred<ReturnType<typeof officeFixtureContext>>();
    vi.mocked(officeAdoption.context).mockImplementation(input => input?.officeSnapshot
      ? pending.promise : Promise.resolve(officeFixtureContext(input!)));
    render(<Harness />);
    const person = await screen.findByRole("button", { name: "Office Person 1" });
    person.focus();
    fireEvent.click(person);
    const dialog = await screen.findByRole("dialog", { name: "Office person evidence" });
    await waitFor(() => expect(person).not.toBeInTheDocument());
    expect(within(dialog).getByRole("status")).toHaveTextContent("Loading saved data...");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close office person evidence" }));
    expect(screen.queryByRole("dialog", { name: "Office person evidence" })).not.toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: "Office adoption groups" });
    expect(heading).toHaveFocus();
    await act(async () => pending.resolve(officeFixtureContext({ officeSnapshot: officeContext().observation!.id })));
    await screen.findByRole("button", { name: "Office Person 1" });
    expect(heading).toHaveFocus();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns focus to the reloaded person on a later people page", async () => {
    render(<Harness />);
    const group = within(await screen.findByRole("region", { name: "Contoso / Engineering" }));
    await group.findByRole("button", { name: "Office Person 1" });
    fireEvent.click(group.getByRole("button", { name: "Next people" }));
    const opener = await group.findByRole("button", { name: "Office Person 54" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("region", { name: "Frozen Office person evidence" });
    const reloadedPerson = await screen.findByRole("button", { name: "Office Person 54" });
    expect(reloadedPerson).not.toBe(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close office person 54" }));
    expect(reloadedPerson).toHaveFocus();
  });
  it("labels unknown/no-recent dates honestly and displays older and future facts separately", async () => {
    const person = officePerson(1, { recentApps: [], latestRecentDate: null, unknownReasons: ["future_app_date", "retained_row"],
      dates: { ...officePerson().dates, word: "2025-01-01", excel: "2027-01-01" } });
    vi.mocked(officeAdoption.people).mockImplementation(async (_group, input) => officePage([person], officeFixtureContext(input!)));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Office Person 1" }));
    const frozen = within(await screen.findByRole("region", { name: "Frozen Office person evidence" }));
    expect(frozen.getByText("0 of 7")).toBeVisible();
    expect(frozen.getByText(/future app date, retained row/)).toBeVisible();
    expect(frozen.getAllByText(/Not qualifying in this observation/)).toHaveLength(2);
  });
  it("aligns both header toggles and places Office observation after the four summary metrics", async () => {
    render(<Harness wholeUsers />);
    expect(screen.getByRole("button", { name: "Adoption" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Users view" })).toHaveAttribute("aria-pressed", "false");
    const domain = screen.getByRole("group", { name: "Adoption domain" });
    expect(within(domain).getByRole("button", { name: "Office apps" })).toHaveAttribute("aria-pressed", "true");
    expect(within(domain).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Adoption" }).closest(".copilot-users-view-controls")).toContainElement(domain);
    expect(screen.queryByRole("combobox", { name: "Adoption domain" })).not.toBeInTheDocument();
    const summary = await screen.findByRole("group", { name: "Office adoption summary" });
    await waitFor(() => expect(within(summary).getByText("Refreshed Oct 21, 2026")).toBeVisible());
    expect(within(summary).queryByText(/Recent window:|Cohort captured/)).not.toBeInTheDocument();
    expect(within(summary).getByText("Observation", { selector: "label" })).toBeVisible();
    expect(summary.children).toHaveLength(5);
    expect(summary.lastElementChild).toHaveClass("agent-report-context", "office-observation-card");
    expect(summary.lastElementChild).toContainElement(screen.getByRole("combobox", { name: "Office observation" }));
    expect(within(summary).queryByRole("group", { name: "Adoption domain" })).not.toBeInTheDocument();
    expect(screen.queryByText("Report context", { exact: true })).not.toBeInTheDocument();
  });
  it("keeps the selected domain's filters when its active toggle is clicked", async () => {
    render(<Harness wholeUsers initial={{ view: "licenses", section: "adoption", adoption: "office",
      company: "Contoso", department: "Engineering", app: "word", search: "Contoso", page: 0,
      officeSnapshot: officeContext().observation!.id }} />);
    await screen.findByRole("region", { name: "Contoso / Engineering" });
    fireEvent.click(within(screen.getByRole("group", { name: "Adoption domain" })).getByRole("button", { name: "Office apps" }));
    expect(screen.getByRole("searchbox", { name: "Search groups" })).toHaveValue("Contoso");
    expect(screen.getByRole("button", { name: "Remove company filter" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove department filter" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove office app filter" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Office observation" })).toHaveValue(officeContext().observation!.id);
  });
  it("keeps source failures visible outside the five summary cards without disabling saved observation selection", async () => {
    const context = officeContext();
    context.status = { state: "failed", errorCode: "reports_access_denied", message: "Office report access was denied." };
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    render(<Harness />);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Office report access was denied.");
    const summary = screen.getByRole("group", { name: "Office adoption summary" });
    expect(summary.children).toHaveLength(5);
    expect(summary).not.toContainElement(notice);
    expect(within(summary).getByRole("combobox", { name: "Office observation" })).toBeEnabled();
  });
  it("preserves bounded company, department and app filters with chips", async () => {
    render(<Harness />);
    await screen.findByRole("region", { name: "Contoso / Engineering" });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const filters = within(screen.getByRole("dialog", { name: "Filter Office groups" }));
    await waitFor(() => expect(filters.getByRole("combobox", { name: "Company" })).toHaveAttribute("aria-disabled", "false"));
    fireEvent.change(filters.getByRole("combobox", { name: "Office app" }), { target: { value: "excel" } });
    await screen.findByRole("button", { name: "Remove office app filter" });
    expect(officeAdoption.context).toHaveBeenLastCalledWith({ app: "excel", selectionId: undefined }, expect.any(AbortSignal));
  });
});
