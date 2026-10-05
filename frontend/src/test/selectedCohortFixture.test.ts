import { describe, expect, it } from "vitest";
import { captureSelectedCohort, selectedCohortData, selectedCohortExportRows, selectedCohortRead } from "../../browser/selectedCohortFixture";
import { reportUser } from "./reportDataFixture";
import { selectedLicensedUser } from "./selectedUsageFixture";

describe("reported user browser fixture contracts", () => {
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
    expect(selectedCohortRead("/api/official-usage/users/facets?field=company&licenseCohort=active_without_paid&search=CONT", source))
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
      expect.objectContaining({ username: "emery@example.invalid", reportedResponsesReceived: 215, agentId: "synthetic-researcher" }),
      expect.objectContaining({ username: "emery@example.invalid", reportedResponsesReceived: 215, agentId: "helpdesk/report:2" }),
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
    expect(rows.every(row => row.reportSetId === capture.source.directory.reports.setId)).toBe(true);
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
});
