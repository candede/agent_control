import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportQuery, ReportUser } from "../../../backend/src/types/officialReportData";
import { captureSelectedCohort, selectedCohortData, selectedCohortExportRows, selectedCohortRead } from "../../browser/selectedCohortFixture";
import { CapabilityContext, type useCapabilityContext } from "../capabilityContext";
import { ReportedUserActivity } from "../components/ReportedUserActivity";
import { ReportedUserAgents } from "../components/ReportedUserAgents";
import { SavedQueryProvider } from "../components/SavedQueryProvider";
import { createSavedQueryClient } from "../savedQueries";
import { useReportPage } from "../useReportPage";
import { deferred } from "./deferred";
import { reportSelection, reportUser } from "./reportDataFixture";
import { selectedLicensedUser } from "./selectedUsageFixture";

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function cohortTransport(source = selectedCohortData()) {
  const captures = new Map<string, ReturnType<typeof captureSelectedCohort>>();
  function respond(input: Parameters<typeof fetch>[0]) {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.startsWith("/api/official-usage/users")) throw new Error(`Unexpected cohort request: ${url.pathname}`);
    const requestedId = url.searchParams.get("selectionId");
    if (!requestedId) {
      if (url.pathname !== "/api/official-usage/users") throw new Error("A child requires a captured selection");
      const selection = reportSelection(20 + captures.size);
      captures.set(selection.id, captureSelectedCohort(url.href, { ...source, directory: { ...source.directory, selection } }));
      return Response.json(captures.get(selection.id)!.read(url.href));
    }
    const captured = captures.get(requestedId);
    if (!captured) return Response.json({ code: "selection_invalidated", detail: "Unknown synthetic selection" }, { status: 409 });
    const value = captured.read(url.href);
    return value ? Response.json(value) : Response.json({ code: "data_record_not_found", detail: "Not in this cohort" }, { status: 404 });
  }
  const transport = vi.fn<typeof fetch>(async input => respond(input));
  vi.stubGlobal("fetch", transport);
  return { source, captures, transport, respond };
}

describe("reported user browser fixture contracts", () => {
  it("does not let diagnostic snapshots or a requested selection ID replace captured evidence", () => {
    const source = selectedCohortData();
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source);
    const expected = capture.read("/api/official-usage/users");
    capture.source.users.length = 0;
    capture.source.directory.selection.revision = "other";
    capture.query.set("search", "other");
    expect(capture.read("/api/official-usage/users")).toEqual(expected);
    expect(capture.query.has("search")).toBe(false);
    for (const path of ["", "/facets?field=company", "/emery%40example.invalid/agents", "/emery%40example.invalid/directory"]) {
      expect(() => capture.read(`/api/official-usage/users${path}${path.includes("?") ? "&" : "?"}selectionId=other`))
        .toThrow("Synthetic selection context mismatch");
    }
  });

  it("accepts equivalent filters but rejects changed parent and facet restrictions", () => {
    const root = "/api/official-usage/users", source = selectedCohortData();
    const capture = captureSelectedCohort(`${root}?licenseCohort=active_without_paid&search=Emery`, source);
    expect(capture.read(`${root}?licenseCohort=active_without_paid&search=%20EMERY%20&inactiveDays=30&lowResponseThreshold=5`))
      .toEqual(capture.read(root));
    for (const request of [
      `${root}?licenseCohort=active_without_paid&search=Finley&cursor=fixture:1`,
      `${root}/facets?field=company&licenseCohort=active_without_paid&department=~string:Other`,
    ]) expect(() => capture.read(request)).toThrow("Synthetic selection filters are immutable");
    const otherSetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(() => capture.read(`${root}/emery%40example.invalid/agents?setId=${otherSetId}`)).toThrow("Synthetic selection context mismatch");
    expect(() => selectedCohortRead(`${root}?setId=${otherSetId}`, source)).toThrow("Synthetic report set mismatch");
    expect(capture.read(`${root}/emery%40example.invalid/agents?search=helpdesk&sort=responses&order=desc`))
      .toMatchObject({ value: [{ agentName: "Helpdesk" }], selection: source.directory.selection });
    expect(capture.read(`${root}/emery%40example.invalid/agents/extra`)).toBeUndefined();
  });

  it("retains unfiltered relationship counts, exact ownership and independent child pages", () => {
    const root = "/api/official-usage/users", capture = captureSelectedCohort(`${root}?licenseCohort=active_without_paid&search=Emery`, selectedCohortData());
    const path = `${root}/emery%40example.invalid/agents`;
    expect(capture.read(`${path}?limit=1&sort=responses&order=desc`)).toMatchObject({
      value: [{ username: "emery@example.invalid", agentId: "synthetic-researcher" }],
      counts: { total: 2, filtered: 2 }, page: { nextCursor: "fixture:1" },
    });
    expect(capture.read(`${path}?limit=1&sort=responses&order=desc&cursor=fixture:1`)).toMatchObject({
      value: [{ username: "emery@example.invalid", agentId: "helpdesk/report:2" }],
      counts: { total: 2, filtered: 2 }, page: { nextCursor: null, previousCursor: "fixture:0" },
    });
    expect(capture.read(`${path}?search=missing`)).toMatchObject({ value: [], counts: { total: 2, filtered: 0 } });
    expect(capture.read(`${path}?username=finley%40example.invalid`)).toMatchObject({ value: [], counts: { total: 2, filtered: 0 } });
    expect(capture.read(`${root}/finley%40example.invalid/agents`)).toBeUndefined();
    for (const suffix of ["cursor=broken", "cursor=fixture:-1", "limit=0", "limit=101"]) {
      expect(() => capture.read(`${path}?${suffix}`)).toThrow("Invalid synthetic cursor page");
    }
  });

  it("anchors parent and child inactivity to their observed dates with inclusive UTC bounds", () => {
    const source = selectedCohortData(), root = "/api/official-usage/users";
    source.users.find(row => row.displayName === "Emery")!.userLastActivityDateUtc = "2020-01-31T12:00:00.000Z";
    source.users.find(row => row.displayName === "Finley")!.userLastActivityDateUtc = "2020-01-01T12:00:00.000Z";
    source.users.filter(row => !["Emery", "Finley"].includes(row.displayName)).forEach(row => { row.userLastActivityDateUtc = null; });
    expect(selectedCohortRead(`${root}?licenseCohort=active_without_paid&reportActivity=recent&inactiveDays=30&activityWindowDays=365`, source))
      .toMatchObject({ value: [{ displayName: "Emery" }], counts: { filtered: 1 } });
    expect(selectedCohortRead(`${root}?licenseCohort=active_without_paid&reportActivity=inactive&inactiveDays=30`, source))
      .toMatchObject({ value: [{ displayName: "Finley" }], counts: { filtered: 1 } });
    expect(selectedCohortRead(`${root}?licenseCohort=active_without_paid&startDate=2020-01-31&endDate=2020-01-31`, source))
      .toMatchObject({ value: [{ displayName: "Emery" }], counts: { filtered: 1 } });
    const links = source.relationships.filter(row => row.username === "emery@example.invalid");
    links[0].lastActivityDateUtc = "2020-01-31T12:00:00.000Z";
    links[1].lastActivityDateUtc = "2020-01-01T12:00:00.000Z";
    const capture = captureSelectedCohort(`${root}?licenseCohort=active_without_paid&search=Emery`, source);
    expect(capture.read(`${root}/emery%40example.invalid/agents?reportActivity=recent&inactiveDays=30`))
      .toMatchObject({ value: [{ agentId: links[0].agentId }], counts: { total: 2, filtered: 1 } });
    expect(capture.read(`${root}/emery%40example.invalid/agents?startDate=2020-01-01&endDate=2020-01-01`))
      .toMatchObject({ value: [{ agentId: links[1].agentId }], counts: { total: 2, filtered: 1 } });
  });

  it.each(["unavailable", "partial", "stale"] as const)("requires current license evidence rather than treating %s candidates as verified", state => {
    const source = selectedCohortData();
    source.directory.sources.directory.state = state;
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source);
    expect(capture.read("/api/official-usage/users")).toMatchObject({
      value: [], counts: { total: 6, filtered: 0 }, summary: { activeWithoutPaidUsers: null, unknownLicenseActiveReportUsers: 5 },
      sources: { directory: { state } },
    });
    expect(capture.read("/api/official-usage/users/emery%40example.invalid/directory")).toBeUndefined();
    expect(selectedCohortExportRows(capture)).toEqual([]);
    source.directory.sources.directory.state = "available";
    expect(capture.read("/api/official-usage/users")).toMatchObject({ value: [] });
    expect(captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source)
      .read("/api/official-usage/users")).toMatchObject({ counts: { filtered: 2 } });
  });

  it.each(["never_imported", "incomplete", "not_selected", "deleted"] as const)("does not serve retained report rows when reports are %s", availability => {
    const source = selectedCohortData();
    source.directory.reports = { ...source.directory.reports, availability, setId: null, activeSetId: null, lineages: [] };
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source);
    expect(capture.read("/api/official-usage/users")).toMatchObject({
      value: [], counts: { total: 0, filtered: 0 }, reports: { availability, setId: null },
      analytics: { rowCount: 0, responses: null, zeroResponses: 0, unknownResponses: 0 },
    });
    expect(capture.read("/api/official-usage/users/facets?field=company")).toMatchObject({ value: [] });
    expect(capture.read("/api/official-usage/users/emery%40example.invalid/agents")).toBeUndefined();
    expect(selectedCohortExportRows(capture)).toEqual([]);
  });

  it("distinguishes missing relationship evidence from a measured empty breakdown and unknown Users totals", () => {
    const source = selectedCohortData(), root = "/api/official-usage/users";
    source.directory.reports.lineages = source.directory.reports.lineages.filter(row => row.kind !== "userAgents");
    const capture = captureSelectedCohort(`${root}?licenseCohort=active_without_paid&search=Emery`, source);
    expect(capture.read(`${root}/emery%40example.invalid`)).toMatchObject({
      value: { reportedResponses: 215, relationshipCount: 0, bridgeResponses: null, hasReportMismatch: false },
    });
    expect(capture.read(`${root}/emery%40example.invalid/agents`)).toMatchObject({ value: [], counts: { total: 0, filtered: 0 } });
    expect(selectedCohortExportRows(capture)).toEqual([expect.objectContaining({ username: "emery@example.invalid", agentId: undefined })]);
    const unknown = selectedCohortData();
    unknown.users.find(row => row.displayName === "Emery")!.reportedResponses = null;
    const unknownCapture = captureSelectedCohort(`${root}?licenseCohort=active_without_paid&search=Emery`, unknown);
    expect(unknownCapture.read(root)).toMatchObject({
      value: [{ reportedResponses: null, bridgeResponses: 215 }], analytics: { responses: null, unknownResponses: 1, zeroResponses: 0 },
    });
    unknown.directory.reports.availability = "stale";
    expect(captureSelectedCohort(`${root}?licenseCohort=active_without_paid`, unknown).read(root))
      .toMatchObject({ counts: { filtered: 2 }, reports: { availability: "stale" } });
  });

  it("keeps bridge-only activity unknown and identifies mismatched agent counts without changing user totals", () => {
    const source = selectedCohortData(), root = "/api/official-usage/users?licenseCohort=active_without_paid&search=Emery";
    source.users.find(row => row.displayName === "Emery")!.reportedAgentsUsed = 1;
    expect(selectedCohortRead(root, source)).toMatchObject({
      value: [{ reportedResponses: 215, reportedAgentsUsed: 1, relationshipCount: 2, hasReportMismatch: true }],
    });
    source.directory.reports.lineages = source.directory.reports.lineages.filter(row => row.kind !== "users");
    expect(selectedCohortRead(root, source)).toMatchObject({
      value: [{ reportedResponses: null, reportedAgentsUsed: null, userLastActivityDateUtc: null, missingUserReport: true,
        bridgeResponses: 215, hasActivity: true, hasReportMismatch: false, reviewCohort: "unknown" }],
      analytics: { responses: null, unknownResponses: 1 },
    });
  });

  it("applies exact user, license and feature filters and searches normalized organization evidence", () => {
    const source = selectedCohortData(), root = "/api/official-usage/users";
    expect(selectedCohortRead(`${root}?username=emery%40example.invalid&entitlement=paid_active`, source)).toMatchObject({ value: [] });
    expect(selectedCohortRead(`${root}?username=emery%40example.invalid&serviceState=enabled`, source)).toMatchObject({ value: [] });
    expect(selectedCohortRead(`${root}?username=emery%40example.invalid&entitlement=no_paid&serviceState=disabled&search=%20CONTOSO%20`, source))
      .toMatchObject({ value: [{ displayName: "Emery" }], counts: { filtered: 1 } });
    expect(selectedCohortExportRows(captureSelectedCohort(`${root}?username=ada%40example.invalid`, source)))
      .toEqual([expect.objectContaining({ licenseAssignmentStatus: "unavailable", entitlement: "paid_active" }),
        expect.objectContaining({ licenseAssignmentStatus: "unavailable", entitlement: "paid_active" })]);
  });

  it("isolates delivered exact-directory responses from their captured source and later reads", () => {
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", selectedCohortData());
    const path = "/api/official-usage/users/emery%40example.invalid/directory", first = capture.read(path);
    if (!first || Array.isArray(first.value) || !("directory" in first.value)) throw new Error("Expected an exact directory response.");
    first.value.directory.displayName = "Other account";
    first.selection.revision = "changed";
    first.selection.expiresAt = "invalid";
    if ("reports" in first) first.reports.lineages[0].versionId = "changed";
    expect(capture.read(path)).toMatchObject({ value: { directory: { displayName: "Emery" } },
      selection: capture.source.directory.selection, reports: capture.source.directory.reports });
  });

  it("applies agent, creator and response restrictions to the same relationship, including blank creator types", () => {
    const source = selectedCohortData(), root = "/api/official-usage/users?licenseCohort=active_without_paid&search=Emery";
    expect(selectedCohortRead(`${root}&agentId=synthetic-researcher&creatorType=Your%20org`, source)).toMatchObject({ value: [] });
    expect(selectedCohortRead(`${root}&creatorType=`, source)).toMatchObject({ value: [] });
    const link = source.relationships.find(row => row.username === "emery@example.invalid" && row.agentId === "synthetic-researcher")!;
    link.creatorType = ""; link.responses = 0;
    expect(selectedCohortRead(`${root}&agentId=synthetic-researcher&responsesOnly=true`, source)).toMatchObject({ value: [] });
    expect(selectedCohortRead(`${root}&creatorType=`, source)).toMatchObject({ value: [{ displayName: "Emery" }] });
    expect(selectedCohortRead("/api/official-usage/users?search=helpdesk&creatorType=", source)).toMatchObject({ value: [] });
    expect(selectedCohortRead("/api/official-usage/users/emery%40example.invalid/agents?creatorType=", source))
      .toMatchObject({ value: [{ agentId: "synthetic-researcher", creatorType: "" }], counts: { filtered: 1 } });
  });

  it("applies the other organization filter and normalizes facet values", () => {
    const source = selectedCohortData();
    const emery = source.directory.value.find(user => user.directory.displayName === "Emery")!;
    const finley = source.directory.value.find(user => user.directory.displayName === "Finley")!;
    emery.directory.companyName = " Contoso ";
    emery.directory.department = "Engineering";
    finley.directory.companyName = "Fabrikam";
    finley.directory.department = "Sales";
    expect(selectedCohortRead("/api/official-usage/users/facets?field=company&licenseCohort=active_without_paid&department=~string:Engineering", source))
      .toMatchObject({ value: [{ value: "Contoso", count: 1 }], counts: { filtered: 1 } });
  });

  it("searches and sorts normalized organization options without filtering users by the facet search", () => {
    const source = selectedCohortData();
    const emery = source.directory.value.find(user => user.directory.displayName === "Emery")!;
    const finley = source.directory.value.find(user => user.directory.displayName === "Finley")!;
    emery.directory.companyName = " Contoso ";
    finley.directory.companyName = "Contoso";
    expect(selectedCohortRead("/api/official-usage/users/facets?field=company&licenseCohort=active_without_paid&search=%20CONT%20", source))
      .toMatchObject({ value: [{ value: "Contoso", count: 2 }] });
    expect(selectedCohortRead("/api/official-usage/users/facets?field=company&licenseCohort=active_without_paid&search=missing", source))
      .toMatchObject({ value: [], counts: { filtered: 0 } });
  });

  it("pins directory, report, relationship and filter evidence until a new capture", () => {
    const source = selectedCohortData();
    const input = "/api/official-usage/users?licenseCohort=active_without_paid&search=Emery&lowResponseThreshold=250";
    const capture = captureSelectedCohort(input, source);
    source.users.find(user => user.displayName === "Emery")!.reportedResponses = 999;
    source.relationships = [];
    const emery = source.directory.value.find(user => user.directory.displayName === "Emery")!;
    emery.entitlement = "paid_active";
    source.directory.reports.setId = "70000000-0000-4000-8000-000000000007";
    expect(capture.read("/api/official-usage/users?limit=1")).toMatchObject({
      value: [{ displayName: "Emery", reportedResponses: 215, reviewCohort: "low", entitlement: "no_paid" }],
      counts: { filtered: 1 }, reports: { setId: capture.source.directory.reports.setId },
    });
    expect(capture.read("/api/official-usage/users/emery%40example.invalid")).toMatchObject({
      value: { reportedResponses: 215, reviewCohort: "low", relationshipCount: 2 },
    });
    expect(capture.read("/api/official-usage/users/emery%40example.invalid/directory")).toMatchObject({
      value: { entitlement: "no_paid" },
    });
    expect(capture.read("/api/official-usage/users/emery%40example.invalid/agents?search=helpdesk")).toMatchObject({
      value: [{ agentId: "helpdesk/report:2" }], counts: { filtered: 1 },
    });
    expect(capture.read("/api/official-usage/users/emery%40example.invalid/agents?search=missing")).toMatchObject({
      value: [], counts: { filtered: 0 },
    });
    expect(capture.read("/api/official-usage/users/finley%40example.invalid")).toBeUndefined();
    expect(capture.read("/api/official-usage/users/ada%40example.invalid/directory")).toBeUndefined();
    expect(() => capture.read("/api/official-usage/users?licenseCohort=active_without_paid&search=Finley"))
      .toThrow("Synthetic selection filters are immutable");
    expect(captureSelectedCohort(input, source).read(input)).toMatchObject({ value: [] });
    expect(selectedCohortExportRows(capture)).toEqual([
      expect.objectContaining({ username: "emery@example.invalid", reportedResponsesReceived: 215, agentId: "helpdesk/report:2" }),
      expect.objectContaining({ username: "emery@example.invalid", reportedResponsesReceived: 215, agentId: "synthetic-researcher" }),
    ]);
  });

  it("retains parent search and other filters while faceting independently", () => {
    const source = selectedCohortData();
    source.directory.value.find(user => user.directory.displayName === "Emery")!.directory.companyName = "Contoso";
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid&search=Emery&company=~string:Other", source);
    expect(capture.read("/api/official-usage/users/facets?field=company&search=CONT")).toMatchObject({
      value: [{ value: "Contoso", count: 1 }], counts: { filtered: 1 },
    });
    expect(capture.read("/api/official-usage/users/facets?field=department")).toMatchObject({ value: [] });
  });

  it("exports every selected page, not just the displayed page", () => {
    const source = selectedCohortData();
    source.users = Array.from({ length: 205 }, (_, index) => reportUser(index + 1, {
      username: `person${index}@example.invalid`, displayName: `Person${index}`, reportedResponses: 10,
    }));
    source.directory.value = source.users.map((user, index) => {
      const directory = selectedLicensedUser(index + 1, user.displayName, 10);
      directory.directory.userPrincipalName = user.username;
      directory.entitlement = "no_paid";
      directory.copilotServiceState = "disabled";
      return directory;
    });
    source.relationships = [];
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid&limit=50&sort=name&order=asc", source);
    expect(capture.read("/api/official-usage/users?limit=50")).toMatchObject({
      counts: { filtered: 205 }, page: { nextCursor: "fixture:50" },
    });
    expect(capture.read("/api/official-usage/users?limit=50&cursor=fixture:200")).toMatchObject({
      page: { nextCursor: null, previousCursor: "fixture:150" },
    });
    const rows = selectedCohortExportRows(capture);
    expect(rows).toHaveLength(205);
    expect(new Set(rows.map(row => row.username))).toEqual(new Set(source.users.map(user => user.username)));
    const reportSetId = capture.source.directory.reports.setId;
    expect(rows.every(row => row.reportSetId === reportSetId)).toBe(true);
  });

  it("keeps uncaptured relationship queries compatible with other browser fixtures", () => {
    expect(selectedCohortRead("/api/official-usage/users/emery%40example.invalid/agents?search=missing", selectedCohortData()))
      .toMatchObject({ value: [], counts: { filtered: 0 } });
  });

  it("preserves the nonpaid facet scope of uncaptured browser fixtures", () => {
    expect(selectedCohortRead("/api/official-usage/users/facets?field=company", selectedCohortData()))
      .toMatchObject({ value: [{ value: "Contoso Health", count: 1 }, { value: null, count: 1 }] });
  });

  it("keeps facet ordering, null values and cursor pages bounded", () => {
    const source = selectedCohortData();
    const emery = source.directory.value.find(user => user.directory.displayName === "Emery")!;
    const finley = source.directory.value.find(user => user.directory.displayName === "Finley")!;
    emery.directory.companyName = "Zulu";
    finley.directory.companyName = "Alpha";
    const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source);
    expect(capture.read("/api/official-usage/users/facets?field=company&limit=1")).toMatchObject({
      value: [{ value: "Alpha", count: 1 }], counts: { filtered: 2 }, page: { nextCursor: "fixture:1", previousCursor: null },
    });
    expect(capture.read("/api/official-usage/users/facets?field=company&limit=1&cursor=fixture:1")).toMatchObject({
      value: [{ value: "Zulu", count: 1 }], page: { nextCursor: null, previousCursor: "fixture:0" },
    });
    finley.directory.companyName = "  ";
    expect(captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source)
      .read("/api/official-usage/users/facets?field=company")).toMatchObject({
      value: [{ value: "Zulu", count: 1 }, { value: null, count: 1 }],
    });
  });

  describe("reported cohort fixtures through their real consumers", () => {
    const route = { view: "activity", search: "", page: 0 } as const;

    it.each(["empty", "license-unavailable", "report-unavailable"] as const)("presents %s without a misleading loading state or automatic reload", async state => {
      const { source, transport } = cohortTransport();
      if (state === "license-unavailable") source.directory.sources.directory.state = "unavailable";
      if (state === "report-unavailable") source.directory.reports = {
        ...source.directory.reports, setId: null, activeSetId: null, availability: "not_selected", lineages: [],
      };
      const props = { route: { ...route, search: "missing" }, onRouteChange: vi.fn() };
      const view = render(createElement(ReportedUserActivity, props));
      const heading = state === "empty" ? "No matching reported users" : state === "license-unavailable"
        ? "Non-paid user activity unavailable" : "No report selected";
      expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
      expect(screen.getByRole("status", { name: "Matching users" })).toHaveTextContent(state === "empty" ? "0" : "Unavailable");
      expect(screen.getByRole("button", { name: "Export users CSV" })).toHaveProperty("disabled", state !== "empty");
      expect(screen.queryByText("Loading saved data...")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      view.rerender(createElement(ReportedUserActivity, props));
      expect(transport).toHaveBeenCalledOnce();
    });

    it.each(["filtered", "empty", "unavailable"] as const)("preserves the %s relationship explanation without returning another user's links", async state => {
      const { source, captures, transport } = cohortTransport();
      if (state === "empty") source.relationships = [];
      if (state === "unavailable") source.directory.reports.lineages = source.directory.reports.lineages.filter(row => row.kind !== "userAgents");
      const capture = captureSelectedCohort("/api/official-usage/users?licenseCohort=active_without_paid", source);
      const selectionId = source.directory.selection.id;
      captures.set(selectionId, capture);
      render(createElement(ReportedUserAgents, {
        path: "official-usage/users/emery%40example.invalid/agents", selectionId,
        query: { search: "missing", showAll: false, sort: "responses", order: "desc" }, onQueryChange: vi.fn(),
      }));
      const heading = state === "filtered" ? "No agent relationships match" : state === "empty"
        ? "No agent relationships reported" : "Agent relationships unavailable";
      expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
      expect(screen.getByRole("region", { name: "Reported agent relationships" })).toHaveAttribute("aria-busy", "false");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(transport).toHaveBeenCalledOnce();
    });

    it("shares captures and retires cancelled cursor responses, then invalidates both observers before an explicit recapture", async () => {
      const { source, transport, respond } = cohortTransport(), client = createSavedQueryClient();
      clients.push(client);
      const wrapper = ({ children }: { children: ReactNode }) => createElement(SavedQueryProvider, { client, children });
      const initialQuery: ReportQuery & { limit: number } = { licenseCohort: "active_without_paid", limit: 1 };
      const { result, rerender } = renderHook(({ query }) => ({
        first: useReportPage<ReportUser>("official-usage/users", query),
        second: useReportPage<ReportUser>("official-usage/users", query),
      }), { wrapper, initialProps: { query: initialQuery } });
      await waitFor(() => expect(result.current.first.data?.value[0].displayName).toBe("Emery"));
      expect(transport).toHaveBeenCalledOnce();
      expect(result.current.second.selectionId).toBe(result.current.first.selectionId);
      const next = deferred<Response>(), replacement = deferred<Response>();
      let late: Response | undefined;
      transport.mockImplementationOnce(async input => { late = respond(input); return next.promise; }).mockReturnValueOnce(replacement.promise);
      act(() => { result.current.first.next(); result.current.first.next(); });
      expect(transport).toHaveBeenCalledTimes(2);
      const cursorSignal = transport.mock.lastCall![1]?.signal;
      expect(String(transport.mock.lastCall![0])).toContain("cursor=fixture%3A1");
      rerender({ query: { ...initialQuery, search: "Finley" } });
      expect(cursorSignal?.aborted).toBe(true);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(String(transport.mock.lastCall![0])).not.toContain("cursor=");
      await act(async () => next.resolve(late!));
      expect(result.current.first).toMatchObject({ data: undefined, loading: true, error: null });
      expect(result.current.second).toMatchObject({ data: undefined, loading: true, error: null });
      await act(async () => replacement.resolve(respond(transport.mock.lastCall![0])));
      await waitFor(() => expect(result.current.first.data?.value[0].displayName).toBe("Finley"));
      const capturedId = result.current.first.selectionId;
      source.directory.value.find(row => row.directory.displayName === "Finley")!.entitlement = "paid_active";
      act(() => { void client.invalidateQueries({ queryKey: ["saved", "record-page"] }); });
      await waitFor(() => expect(result.current.first.loading).toBe(false));
      expect(transport).toHaveBeenCalledTimes(4);
      expect(result.current.first.selectionId).toBe(capturedId);
      expect(result.current.first.data?.value[0].entitlement).toBe("no_paid");
      act(() => result.current.first.invalidateSelection());
      await waitFor(() => expect(result.current.second.invalidated).toBe(true));
      expect(result.current.first).toMatchObject({ data: undefined, loading: false, invalidated: true });
      expect(transport).toHaveBeenCalledTimes(4);
      act(() => { result.current.first.restart(); result.current.first.restart(); });
      await waitFor(() => expect(result.current.first.data?.counts.filtered).toBe(0));
      expect(result.current.first.selectionId).not.toBe(capturedId);
      expect(transport).toHaveBeenCalledTimes(5);
      expect(result.current.second.invalidated).toBe(true);
    });

    it("resets account-owned controls and rejects late A-B-A reads through query-client replacement", async () => {
      const { transport, respond } = cohortTransport();
      const rootReads = () => transport.mock.calls.filter(([input]) => new URL(String(input), "http://localhost").pathname === "/api/official-usage/users");
      const account: ReturnType<typeof useCapabilityContext> = {
        user: { tenantId: "tenant", homeAccountId: "A", displayName: "Viewer", username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] },
        loading: false, pending: false, error: undefined, views: [], now: Date.now(), reload: vi.fn(async () => {}), openPermissions: vi.fn(),
      };
      const owners = Array.from({ length: 3 }, () => createSavedQueryClient());
      clients.push(...owners);
      const panel = (index: number) => createElement(SavedQueryProvider, { client: owners[index], children:
        createElement(CapabilityContext, { value: { ...account, user: { ...account.user!, homeAccountId: index === 1 ? "B" : "A" } } },
          createElement(ReportedUserActivity, { route, onRouteChange: vi.fn() })) });
      const view = render(panel(0));
      await screen.findByRole("button", { name: "Emery" });
      fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
      fireEvent.change(screen.getByLabelText("Low-response threshold"), { target: { value: "8" } });
      await waitFor(() => expect(rootReads()).toHaveLength(2));
      await waitFor(() => expect(screen.getByRole("button", { name: "Export users CSV" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Close filters" }));
      const abandoned = deferred<Response>(), replacement = deferred<Response>();
      let old: Response | undefined;
      transport.mockImplementationOnce(async input => { old = respond(input); return abandoned.promise; }).mockReturnValueOnce(replacement.promise);
      view.rerender(panel(1));
      const signal = transport.mock.lastCall![1]?.signal;
      expect(String(transport.mock.lastCall![0])).toContain("lowResponseThreshold=5");
      expect(screen.queryByRole("button", { name: "Emery" })).not.toBeInTheDocument();
      view.rerender(panel(2));
      expect(signal?.aborted).toBe(true);
      expect(rootReads()).toHaveLength(4);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => abandoned.resolve(old!));
      expect(screen.queryByRole("button", { name: "Emery" })).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => replacement.resolve(respond(transport.mock.lastCall![0])));
      await screen.findByRole("button", { name: "Emery" });
      fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
      expect(screen.getByLabelText("Low-response threshold")).toHaveValue(5);
      expect(rootReads()).toHaveLength(4);
      expect(String(rootReads()[3][0])).not.toContain("selectionId=");
    });
  });
});
