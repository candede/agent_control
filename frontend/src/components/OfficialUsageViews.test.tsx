import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as usageApi from "../api/client";
import { downloadBlob } from "../agentExport";
import { usageAggregateFixture, usageFixtureSetId } from "../test/usageInsightsFixture";
import { ReportingView } from "./ReportingView";

vi.mock("../agentExport", () => ({ downloadBlob: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function renderReport(overrides: Partial<Parameters<typeof ReportingView>[0]> = {}) {
  const props = {
    data: usageAggregateFixture(), query: {}, offset: 0, onRetry: vi.fn(),
    onAgentQueryChange: vi.fn(), onAgentPageChange: vi.fn(), ...overrides,
  };
  return { ...render(<ReportingView {...props} />), props };
}

describe("focused official agent reporting", () => {
  it("leads with three snapshot measures and one bounded-width table, not duplicate dashboards or user objects", () => {
    const data = usageAggregateFixture();
    data.summary.catalog.totalAgents = 500;
    renderReport({ data });
    const summary = screen.getByRole("region", { name: "Usage summary" });
    expect(within(summary).getByText("Responses").parentElement).toHaveTextContent("270");
    expect(within(summary).getByText("Active report users").parentElement).toHaveTextContent("3");
    expect(within(summary).getByText("Reported agents").parentElement).toHaveTextContent("2");
    expect(summary.children).toHaveLength(3);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.getByRole("heading", { name: "Agent comparison" })).toBeVisible();
    expect(screen.queryByText("User engagement")).not.toBeInTheDocument();
    expect(screen.queryByText("Catalog-only analysis")).not.toBeInTheDocument();
    expect(screen.queryByText("Active agents")).not.toBeInTheDocument();
    expect(screen.queryByText("Top agents by responses")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("ada@example.invalid")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Agent last activity on or after (UTC)")).not.toBeVisible();
  });

  it("keeps stale state, observed-date limitations and discrepancies visible, with technical evidence on demand", async () => {
    const data = usageAggregateFixture();
    data.availability = "stale";
    data.activeSet!.reportingPeriod.provenance = "activity_range";
    data.lineages[0].warnings = ["Source metadata was not supplied."];
    renderReport({ data });
    expect(screen.getByText("Out-of-date report")).toBeVisible();
    expect(screen.getByText(/These reports are out of date/)).toBeVisible();
    expect(screen.getByText(/Observed dates are last-activity dates, not a proven reporting window/)).toBeVisible();
    expect(screen.getAllByText("Source totals differ")[0]).toBeVisible();
    expect(screen.getByText(/Source discrepancies are preserved/)).not.toBeVisible();
    expect(screen.getByText("Source metadata was not supplied.")).not.toBeVisible();
    await userEvent.click(screen.getByText("Report quality & sources", { exact: false }));
    expect(screen.getByText(/Headline responses use the Agents export only/)).toBeVisible();
    await userEvent.click(screen.getByText("Agents export: 2 rows; 1 warnings"));
    expect(screen.getByText("Source metadata was not supplied.")).toBeVisible();
    expect(screen.getAllByText("insights-agents")[0]).toBeVisible();
    expect(screen.getByText(/Import time does not establish source freshness/)).toBeVisible();
  });

  it("opens only the chosen agent's source evidence and never adds overlapping license categories", async () => {
    renderReport();
    const table = screen.getByRole("region", { name: "Agent comparison rows" });
    expect(within(table).queryByText("synthetic-researcher")).not.toBeInTheDocument();
    const researcher = within(table).getByRole("button", { name: "Researcher" });
    await userEvent.click(researcher);
    const detail = screen.getByRole("region", { name: "Source details for Researcher" });
    expect(researcher).toHaveAttribute("aria-expanded", "true");
    expect(within(detail).getByText("synthetic-researcher")).toBeVisible();
    expect(within(detail).getByText(/Licensed and unlicensed source categories can overlap and are never added/)).toBeVisible();
    expect(within(detail).getByText("Licensed active users (Agents export)").parentElement).toHaveTextContent("2");
    expect(within(detail).getByText("Unlicensed active users (Agents export)").parentElement).toHaveTextContent("1");
    await userEvent.click(within(table).getByRole("button", { name: "Helpdesk" }));
    expect(screen.queryByRole("region", { name: "Source details for Researcher" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Source details for Helpdesk" })).toBeVisible();
  });

  it("shows unknown reach rather than zero and explicitly labels bridge-only response totals", () => {
    const data = usageAggregateFixture();
    data.agents.value[0] = { ...data.agents.value[0], sourceReport: "userAgents", sourceReports: ["userAgents"], activeUsersIdentityCount: null };
    renderReport({ data });
    const row = screen.getByRole("row", { name: /Researcher/ });
    expect(within(row).getByText("Unknown")).toBeVisible();
    expect(within(row).getByText("Users & agents only")).toBeVisible();
    expect(within(row).getByText("215")).toBeVisible();
  });

  it.each([
    ["activeUsers-desc", "activeUsers", "desc"],
    ["responses-asc", "responses", "asc"],
    ["lastActivity-desc", "lastActivity", "desc"],
    ["agentName-asc", "agentName", "asc"],
  ])("uses the same server-backed table for order %s", async (selection, sortBy, sortDirection) => {
    const { props } = renderReport();
    await userEvent.selectOptions(screen.getByLabelText("Order agents by"), selection);
    expect(props.onAgentQueryChange).toHaveBeenLastCalledWith({ sortBy, sortDirection });
  });

  it("preserves snapshot totals while searches and pagination apply to the whole agent dataset", async () => {
    const data = usageAggregateFixture();
    data.agents = { ...data.agents, count: 2_000, limit: 25, offset: 0 };
    const { props } = renderReport({ data });
    await userEvent.click(screen.getByRole("button", { name: "Next agents" }));
    expect(props.onAgentPageChange).toHaveBeenLastCalledWith(25);
    await userEvent.type(screen.getByLabelText("Search agents"), "x");
    expect(props.onAgentQueryChange).toHaveBeenLastCalledWith({ search: "x" });
    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent("270");
  });

  it("keeps controls usable on empty and out-of-range pages", async () => {
    const data = usageAggregateFixture();
    data.agents = { value: [], count: 2, limit: 25, offset: 50 };
    const { props } = renderReport({ data, offset: 50 });
    expect(screen.getByRole("heading", { name: "No agents on this page" })).toBeVisible();
    expect(screen.getByLabelText("Search agents")).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "First agent page" }));
    expect(props.onAgentPageChange).toHaveBeenCalledWith(0);
    expect(screen.getAllByText(/No agents on this page \(2 matching\)/).length).toBeGreaterThan(0);
  });

  it("distinguishes a known empty export from missing agent evidence", () => {
    const data = usageAggregateFixture();
    data.agents = { value: [], count: 0, limit: 25, offset: 0 };
    data.summary.usage.hasAgentUsage = false;
    data.summary.activityWindow.totalAgents = 0;
    const { props, rerender } = renderReport({ data });
    const metric = within(screen.getByRole("region", { name: "Usage summary" })).getByText("Reported agents").parentElement;
    expect(metric).toHaveTextContent("0");
    expect(screen.getByRole("heading", { name: "No reported agents" })).toBeVisible();
    rerender(<ReportingView {...props} data={{ ...data, lineages: [] }} />);
    expect(within(screen.getByRole("region", { name: "Usage summary" })).getByText("Reported agents").parentElement).toHaveTextContent("Unknown");
    expect(screen.queryByRole("heading", { name: "No reported agents" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent usage evidence unavailable" })).toBeVisible();
  });

  it("explains last-activity filters and rejects reversed dates without exporting stale results", async () => {
    const { props, rerender } = renderReport();
    await userEvent.click(screen.getByText("Last-activity filters"));
    expect(screen.getByLabelText("Agent last activity on or after (UTC)")).toBeVisible();
    expect(screen.getByText(/Responses remain full-snapshot totals/)).toBeVisible();
    rerender(<ReportingView {...props} query={{ startDate: "2026-09-12", endDate: "2026-09-01" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before the end date");
    expect(screen.getByRole("region", { name: "Agent comparison" })).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
    expect(screen.queryByRole("region", { name: "Agent comparison rows" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset agent filters" }));
    expect(props.onAgentQueryChange).toHaveBeenCalledWith({});
  });

  it("does not describe a failed read as loading or expose old rows under changed filters", () => {
    const { props, rerender } = renderReport({ error: "The report could not be read.", query: { search: "different" } });
    expect(screen.getByRole("alert")).toHaveTextContent("last loaded summary");
    expect(screen.getByRole("region", { name: "Agent comparison" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Loading official usage...")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent comparison rows" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
    rerender(<ReportingView {...props} error={undefined} query={{ search: "different" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Updating agent results");
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
  });

  it("withholds previous-page rows before the next-page loading effect starts", () => {
    const data = usageAggregateFixture();
    data.agents = { ...data.agents, count: 50, limit: 25, offset: 0 };
    const { props, rerender } = renderReport({ data });
    rerender(<ReportingView {...props} offset={25} />);
    expect(screen.getByRole("region", { name: "Agent comparison" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("region", { name: "Agent comparison rows" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Usage summary" })).toHaveTextContent("270");
    rerender(<ReportingView {...props} offset={25} data={{ ...data, agents: { ...data.agents, offset: 25 } }} />);
    expect(screen.getByRole("region", { name: "Agent comparison rows" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Agent comparison" })).toHaveAttribute("aria-busy", "false");
  });

  it("does not announce loading when reversed dates prevent the first report read", () => {
    renderReport({ data: undefined, loading: true, query: { startDate: "2026-09-12", endDate: "2026-09-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("start date must be on or before the end date");
    expect(screen.getByRole("region", { name: "Agent comparison" })).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByText("Loading official usage...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
  });

  it("offers explicit read retry and distinguishes missing reports from zero usage", async () => {
    const { props, rerender } = renderReport({ data: undefined, error: "Reports are unavailable." });
    await userEvent.click(screen.getByRole("button", { name: "Retry report" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
    rerender(<ReportingView {...props} error={undefined} data={{ ...usageAggregateFixture(), activeSet: null, availability: "never_imported" }} />);
    expect(screen.getByRole("heading", { name: "Reports not imported" })).toBeVisible();
    expect(screen.getByText("Missing reports are not zero activity.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Usage summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeDisabled();
  });
});

describe("agent CSV boundaries", () => {
  it("exports the applied filters and exact displayed snapshot, not just the current page", async () => {
    const blob = new Blob(["csv"]);
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv").mockResolvedValue(blob);
    const data = usageAggregateFixture({ staleAfterDays: 35, search: "Researcher", creatorType: "Microsoft", agentSortBy: "activeUsers", limit: 1 });
    renderReport({ data, query: { search: "Researcher", creatorType: "Microsoft", sortBy: "activeUsers" } });
    await userEvent.click(screen.getByRole("button", { name: "Export agents CSV" }));
    expect(download).toHaveBeenCalledWith("aggregate", {
      setId: usageFixtureSetId, search: "Researcher", creatorType: "Microsoft",
      startDate: undefined, endDate: undefined, sortBy: "activeUsers", sortDirection: "desc",
    }, expect.any(AbortSignal));
    expect(downloadBlob).toHaveBeenCalledWith("official-agent-usage.csv", blob);
  });

  it("surfaces export failure and allows a retry", async () => {
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv")
      .mockRejectedValueOnce(new Error("Export size limit exceeded.")).mockResolvedValueOnce(new Blob(["csv"]));
    renderReport();
    await userEvent.click(screen.getByRole("button", { name: "Export agents CSV" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export size limit exceeded.");
    await userEvent.click(screen.getByRole("button", { name: "Export agents CSV" }));
    expect(download).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows a fresh export after A-to-B-to-A filters even when the cancelled transport never settles", async () => {
    let resolve!: (blob: Blob) => void;
    const fresh = new Blob(["fresh export"]);
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv")
      .mockReturnValueOnce(new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce(fresh);
    const { props, rerender } = renderReport();
    await userEvent.click(screen.getByRole("button", { name: "Export agents CSV" }));
    rerender(<ReportingView {...props} query={{ search: "other" }} loading />);
    rerender(<ReportingView {...props} />);
    expect(download.mock.calls[0][2]?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Export agents CSV" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Export agents CSV" }));
    expect(downloadBlob).toHaveBeenCalledExactlyOnceWith("official-agent-usage.csv", fresh);
    await act(async () => resolve(new Blob(["superseded export"])));
    expect(downloadBlob).toHaveBeenCalledOnce();
  });

  it.each(["query", "snapshot", "unmount", "reload"] as const)("aborts and withholds a late export after %s changes", async boundary => {
    let resolve!: (blob: Blob) => void;
    const download = vi.spyOn(usageApi, "downloadOfficialUsageCsv").mockReturnValue(new Promise(done => { resolve = done; }));
    const { props, rerender, unmount } = renderReport();
    await userEvent.click(screen.getByRole("button", { name: "Export agents CSV" }));
    if (boundary === "query") rerender(<ReportingView {...props} query={{ search: "other" }} />);
    else if (boundary === "snapshot") rerender(<ReportingView {...props} data={{ ...props.data!, activeSet: { ...props.data!.activeSet!, id: "other-set" } }} />);
    else if (boundary === "reload") rerender(<ReportingView {...props} loading />);
    else unmount();
    expect(download.mock.calls[0][2]?.aborted).toBe(true);
    await act(async () => resolve(new Blob(["old export"])));
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
