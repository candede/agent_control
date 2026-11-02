import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { OfficeContext } from "../../../backend/src/types/officeAppAdoption";
import { officeAdoption } from "../api/officeAppAdoption";
import { officeContext, officeFixtureContext, officeGroup, officeHistory, officePage, officeSummary } from "../test/officeAdoptionFixture";
import type { DashboardRouteState } from "../workbenchRouting";
import { AdoptionDashboard } from "./AdoptionDashboard";
import { SavedQueryProvider } from "./SavedQueryProvider";

vi.mock("../api/officeAppAdoption", async original => ({ ...await original<typeof import("../api/officeAppAdoption")>(),
  officeAdoption: { context: vi.fn(), summary: vi.fn(), history: vi.fn(), departments: vi.fn(), facets: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
beforeEach(() => {
  vi.mocked(officeAdoption.context).mockImplementation(async input => officeFixtureContext(input!));
  vi.mocked(officeAdoption.summary).mockImplementation(async input => officeSummary(officeFixtureContext(input!)));
  vi.mocked(officeAdoption.history).mockImplementation(async input => {
    const context = officeFixtureContext(input!);
    return officePage(officeHistory(context), context);
  });
  vi.mocked(officeAdoption.departments).mockImplementation(async input => {
    return officePage([officeGroup()], officeFixtureContext(input!));
  });
  vi.mocked(officeAdoption.facets).mockImplementation(async (_kind, input) => {
    return officePage([{ value: "Contoso", groups: 1, people: 54 }], officeFixtureContext(input!));
  });
});
function Harness({ initial = { adoption: "office" } }: { initial?: DashboardRouteState }) {
  const [route, change] = useState(initial);
  return <SavedQueryProvider><AdoptionDashboard route={route} onRouteChange={change} revision={0}
    onBaselineChange={vi.fn()} onCompanyChange={vi.fn()} /></SavedQueryProvider>;
}
describe("Office dashboard", () => {
  it("preserves the selected observation and baseline in drill-through links while context loads", async () => {
    const officeSnapshot = officeContext({}, 2).observation!.id;
    const officeBaseline = officeContext({}, 1).observation!.id;
    let complete!: (context: OfficeContext) => void;
    vi.mocked(officeAdoption.context).mockReturnValue(new Promise(resolve => { complete = resolve; }));
    render(<Harness initial={{ adoption: "office", officeSnapshot, officeBaseline }} />);
    const expectPins = () => {
      const links = [...within(screen.getByRole("list", { name: "Seven Office app active-user counts" })).getAllByRole("link"),
        screen.getByRole("link", { name: "Explore Office groups" })];
      for (const link of links) {
        const params = new URL(link.getAttribute("href")!, window.location.origin).searchParams;
        expect(params.get("officeSnapshot")).toBe(officeSnapshot);
        expect(params.get("officeBaseline")).toBe(officeBaseline);
      }
    };
    expectPins();
    await act(async () => { complete(officeFixtureContext({ officeSnapshot, officeBaseline })); });
    await waitFor(() => expect(screen.getByRole("link", { name: /Engineering/ })).toBeVisible());
    expectPins();
  });
  it("preserves the selected observation in drill-through links after a retryable context failure", async () => {
    const officeSnapshot = officeContext({}, 2).observation!.id;
    vi.mocked(officeAdoption.context).mockRejectedValueOnce(new Error("Saved Office context could not be loaded."));
    render(<Harness initial={{ adoption: "office", officeSnapshot }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved Office context could not be loaded.");
    for (const link of [...within(screen.getByRole("list", { name: "Seven Office app active-user counts" })).getAllByRole("link"),
      screen.getByRole("link", { name: "Explore Office groups" })]) {
      expect(new URL(link.getAttribute("href")!, window.location.origin).searchParams.get("officeSnapshot")).toBe(officeSnapshot);
    }
    fireEvent.click(screen.getByRole("button", { name: "Retry saved data" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Engineering/ })).toBeVisible());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(officeAdoption.context).toHaveBeenLastCalledWith({ officeSnapshot, selectionId: undefined }, expect.any(AbortSignal));
    expect(new URL(screen.getByRole("link", { name: "Explore Office groups" }).getAttribute("href")!,
      window.location.origin).searchParams.get("officeSnapshot")).toBe(officeSnapshot);
  });
  it("shows all seven app trends together with one shared measure and no app selector", async () => {
    render(<Harness />);
    const title = screen.getByRole("heading", { name: "Understand adoption. Empower your people." });
    const domain = screen.getByRole("group", { name: "Dashboard adoption domain" });
    expect(title.closest(".dashboard-title-row")).toContainElement(domain);
    expect(within(domain).getByRole("button", { name: "Copilot in Office apps" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Copilot participation in the seven Office apps, from saved provider observations.")).toBeVisible();
    const people = within(await screen.findByRole("region", { name: "Office participation" }));
    await waitFor(()=>expect(people.getByText(/74.1% of enabled users/)).toBeVisible());
    expect(people.getByText("14", { exact: true })).toBeVisible();
    expect(people.queryByText("Unknown Office evidence")).not.toBeInTheDocument();
    expect(screen.queryByText("Active user-app pairs", {exact:true})).not.toBeInTheDocument();
    expect(screen.queryByText("Potential Office champions", {exact:true})).not.toBeInTheDocument();
    const trends=within(screen.getByRole("region",{name:"App adoption over time"}));
    expect(trends.getAllByRole("article")).toHaveLength(7);
    expect(trends.getAllByRole("img",{name:/participation over weekly snapshots/})).toHaveLength(7);
    expect(screen.queryByRole("combobox",{name:"Trend Office app"})).not.toBeInTheDocument();
    expect(trends.getAllByRole("combobox",{name:"App trend measure"})).toHaveLength(1);
    fireEvent.change(screen.getByRole("combobox",{name:"App trend measure"}),{target:{value:"count"}});
    expect(trends.getAllByRole("img",{name:/active users over weekly snapshots/})).toHaveLength(7);
    const apps = within(screen.getByRole("list", { name: "Seven Office app active-user counts" }));
    expect(apps.getAllByRole("link")).toHaveLength(7);
    expect(apps.getByRole("link", { name: "Word" })).toHaveAttribute("href", expect.stringContaining("app=word"));
    expect(apps.getByRole("link", { name: "Word" })).toHaveAttribute("href", expect.stringContaining("officeSnapshot="));
    expect(screen.getByRole("region", { name: "Office participation" })).toHaveClass("dashboard-panel-purple");
    expect(screen.getByRole("region", { name: "App adoption over time" })).toHaveClass("dashboard-panel-blue");
    expect(screen.queryByText("Active agents")).not.toBeInTheDocument();
  });
  it.each([0, 1])("keeps all supported panels visible with %s observations and hides unsupported comparisons", async count => {
    const context = officeContext();
    if (!count) { context.observation = null; context.status.state = "waiting_sources"; }
    vi.mocked(officeAdoption.context).mockResolvedValue(context);
    vi.mocked(officeAdoption.summary).mockResolvedValue(officeSummary(context));
    vi.mocked(officeAdoption.history).mockResolvedValue(officePage(count ? officeHistory(context).slice(-1) : [], context));
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Office participation" })).toBeVisible());
    expect(screen.getByRole("region", { name: "Copilot adoption by app" })).toBeVisible();
    expect(screen.queryByRole("combobox", { name: "Office baseline" })).not.toBeInTheDocument();
    expect(screen.queryByText("vs baseline", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("img",{name:/over weekly snapshots/})).not.toBeInTheDocument();
    const trends=within(screen.getByRole("region",{name:"App adoption over time"}));
    expect(trends.queryByRole("combobox")).not.toBeInTheDocument();
    expect(trends.queryByRole("article")).not.toBeInTheDocument();
    if (count) expect(await screen.findByText("App adoption history is building.")).toBeVisible();
    else expect(await screen.findByText(/Agent CSV reports are not required/)).toBeVisible();
  });
  it("compares every app against its captured cohort, not population growth", async () => {
    const points=officeHistory();
    points[0].metrics={...points[0].metrics,savedLicensedPeople:27,
      perApp:{word:15,excel:5,powerpoint:4,outlook:3,onenote:2,loop:2,teams:10}};
    vi.mocked(officeAdoption.history).mockImplementation(async input=>officePage(points,officeFixtureContext(input!)));
    render(<Harness />);
    const trends=within(await screen.findByRole("region",{name:"App adoption over time"}));
    await waitFor(()=>expect(trends.getAllByRole("article")).toHaveLength(7));
    expect(trends.getByText("Enabled cohort changed from 27 to 54 people.")).toBeVisible();
    expect(within(trends.getByRole("article",{name:"Word adoption trend"})).getByText("0.0 percentage points")).toBeVisible();
    expect(within(trends.getByRole("article",{name:"Outlook adoption trend"})).getByText("+1.9 percentage points")).toBeVisible();
    expect(within(trends.getByRole("article",{name:"Teams adoption trend"})).getByText("-25.9 percentage points")).toBeVisible();
    fireEvent.change(trends.getByRole("combobox",{name:"App trend measure"}),{target:{value:"count"}});
    expect(within(trends.getByRole("article",{name:"Word adoption trend"})).getByText("+15 (+100%)")).toBeVisible();
  });
  it("leaves rate gaps for a missing cohort instead of inventing zero adoption", async () => {
    const points=officeHistory();
    points[0].metrics={...points[0].metrics,savedLicensedPeople:0,
      perApp:{word:0,excel:0,powerpoint:0,outlook:0,onenote:0,loop:0,teams:0}};
    vi.mocked(officeAdoption.history).mockImplementation(async input=>officePage(points,officeFixtureContext(input!)));
    render(<Harness />);
    const chart=await screen.findByRole("img",{name:"Outlook participation over weekly snapshots"});
    expect(chart.querySelectorAll("circle")).toHaveLength(2);
    expect(chart.querySelectorAll(".dashboard-trend-line")).toHaveLength(1);
    expect(screen.getByRole("article",{name:"Outlook adoption trend"}).querySelector(".dashboard-change")).toBeNull();
  });
  it.each([
    [102, 1000, "+0.1 percentage points"],
    [205, 2000, "+0.2 percentage points"],
  ] as const)("shows the measured Word participation change for %s users in a cohort of %s", async (users, licensed, label) => {
    const points = officeHistory();
    points[0].metrics = { ...points[0].metrics, savedLicensedPeople: 1000, reportedActiveUsers: 101, activeUserAppPairs: 141,
      noRecentEvidencePeople: 899, perApp: { ...points[0].metrics.perApp, word: 101 } };
    vi.mocked(officeAdoption.history).mockImplementation(async input => officePage(points, officeFixtureContext(input!)));
    vi.mocked(officeAdoption.summary).mockImplementation(async input => {
      const summary = officeSummary(officeFixtureContext(input!));
      summary.organization = { ...summary.organization!, savedLicensedPeople: licensed, reportedActiveUsers: users, activeUserAppPairs: users + 40,
        noRecentEvidencePeople: licensed - users, perApp: { ...summary.organization!.perApp, word: users } };
      return summary;
    });
    render(<Harness />);
    const word = within(await screen.findByRole("article", { name: "Word adoption trend" }));
    const trends = within(screen.getByRole("region", { name: "App adoption over time" }));
    expect(await word.findByText(label)).toBeVisible();
    fireEvent.change(trends.getByRole("combobox", { name: "App trend measure" }), { target: { value: "count" } });
    expect(word.getByText(users === 102 ? "+1 (+1%)" : "+104 (+103%)")).toBeVisible();
  });
  it("selects historical Office observations and excludes every later point", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Office observation" }).querySelectorAll("option")).toHaveLength(4));
    fireEvent.click(screen.getByText("Weekly Office history",{selector:"summary"}));
    fireEvent.change(screen.getByRole("combobox", { name: "Office observation" }), { target: { value: officeContext({}, 2).observation!.id } });
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Office observations and comparisons" })).getAllByRole("rowheader")).toHaveLength(2));
    for (const chart of screen.getAllByRole("img",{name:/participation over weekly snapshots/})) {
      expect(chart.querySelectorAll("circle")).toHaveLength(2);
    }
    expect(screen.getByText(/Weekly history contains app and group totals/)).toBeVisible();
    expect(officeAdoption.context).toHaveBeenLastCalledWith({ officeSnapshot: officeContext({}, 2).observation!.id, selectionId: undefined }, expect.any(AbortSignal));
  });
});
