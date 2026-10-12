import { describe, expect, it } from "vitest";
import {
  buildCopilotReportUrl, buildCopilotUsersUrl, buildReportedUsersUrl, buildSubscribedSkusUrl,
  parseDirectoryUser, parseReportedIdentity, parseReportUser, parseSubscribedSku, reportHeaders,
  validateGraphUrl, validateReportDownloadUrl,
} from "./userSourceGraphFields.js";
import { directoryPlanRecord, directorySourceRecord } from "./userSourceRecords.js";

const skuId = "639dec6b-bb19-468b-871c-c5c441c4b0cb";
const otherSku = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const apps = "a62f8878-de10-42f3-b68f-6149a25ceb97";
const teams = "b95945de-b3bd-46db-8437-f2beb6ea2347";
const chat = "3f30311c-6b1e-48a4-ab79-725b469da960";
const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const upn = "person@example.com";
const catalog = new Map([[skuId, [apps]]]);
const productFilter = { kind: "products" as const, skuIds: [skuId] };
const exactFilter = { kind: "reported" as const, identities: [upn] };

function graphUser() {
  return { id: objectId, userPrincipalName: upn, displayName: "Person", accountEnabled: true,
    employeeType: "Employee", companyName: "Contoso", department: "Engineering", userType: "Member",
    assignedLicenses: [{ skuId, disabledPlans: [] as string[] }],
    assignedPlans: [{ servicePlanId: apps, service: "M365_COPILOT_APPS",
      assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled" }],
    licenseAssignmentStates: [{ skuId, state: "ActiveWithError", error: "UnrelatedPackageServiceError" }] };
}

describe("native user-source Graph fields", () => {
  it("requests the supported v2 report with its exact D28 window, not the legacy D30 download", () => {
    expect(buildCopilotReportUrl()).toBe("https://graph.microsoft.com/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')");
    expect(() => validateGraphUrl("https://graph.microsoft.com/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D30',version='v1')", "report")).toThrow();
  });

  it("builds bounded explicit advanced queries without product-name heuristics", () => {
    const url = new URL(buildCopilotUsersUrl([skuId, otherSku]));
    expect(url.searchParams.get("$filter")).toBe([skuId, otherSku]
      .map(id => `assignedLicenses/any(value:value/skuId eq ${id})`).join(" or "));
    expect(url.searchParams.get("$count")).toBe("true");
    expect(url.searchParams.get("$top")).toBe("100");
    expect(url.searchParams.get("$select")?.split(",")).toEqual([
      "id", "userPrincipalName", "displayName", "accountEnabled", "employeeType", "companyName", "department",
      "userType", "assignedLicenses", "assignedPlans",
    ]);
    expect(new URL(buildSubscribedSkusUrl()).searchParams.get("$select")).toBe("skuId,appliesTo,servicePlans");
    for (const size of [0, 21]) {
      expect(() => buildCopilotUsersUrl(Array.from({ length: size }, () => skuId))).toThrow();
      expect(() => buildReportedUsersUrl(Array.from({ length: size }, () => upn))).toThrow();
    }
  });

  it("normalizes exact identities and escapes only exact UPN literals", () => {
    const values = [" O'Brien+tag@EXAMPLE.COM ", objectId.toUpperCase(), "x%27%20or%20true@example.com"];
    const identities = values.map(value => parseReportedIdentity(value)!);
    const exact = new URL(buildReportedUsersUrl(identities)), products = new URL(buildCopilotUsersUrl([skuId]));
    expect(exact.origin + exact.pathname).toBe("https://graph.microsoft.com/v1.0/users");
    expect(exact.searchParams.get("$filter")).toBe(
      `userPrincipalName eq 'o''brien+tag@example.com' or id eq '${objectId}' or userPrincipalName eq 'x%27%20or%20true@example.com'`);
    for (const field of ["$select", "$count", "$top"]) expect(exact.searchParams.get(field)).toBe(products.searchParams.get(field));
  });

  it.each(["", " ", "concealed-identifier", objectId.replaceAll("-", ""), "not-a-uuid", "Person Name",
    "@example.com", "one@@example.com", "one@localhost", "one@-example.com", "one@example..com",
    ".one@example.com", "one.@example.com", "one..two@example.com", "one two@example.com",
    `${"x".repeat(65)}@example.com`, "x".repeat(321), "one@example.com\ninjected",
    "person@example.com' or accountEnabled eq true", "x') or true or ('x@example.com",
  ])("does not invent a verifiable identity from %j", value => {
    expect(parseReportedIdentity(value)).toBeNull();
  });

  it.each([
    [buildCopilotUsersUrl([skuId]), "directory"], [buildSubscribedSkusUrl(), "catalog"], [buildCopilotReportUrl(), "report"],
  ] as const)("retains the documented Graph endpoint %s", (url, kind) => {
    expect(() => validateGraphUrl(url, kind)).not.toThrow();
    for (const invalid of ["https://attacker.invalid/v1.0/users", "https://graph.microsoft.com:444/v1.0/users",
      "https://private@graph.microsoft.com/v1.0/users", "http://graph.microsoft.com/v1.0/users",
      "https://graph.microsoft.com/v1.0/users/private/licenseDetails", "not a URL"]) {
      expect(() => validateGraphUrl(invalid, kind)).toThrow();
    }
  });

  it.each([
    [buildCopilotUsersUrl([skuId]), "directory"], [buildSubscribedSkusUrl(), "catalog"],
  ] as const)("bounds pagination to the requested %s projection", (initial, kind) => {
    const next = new URL(initial);
    next.searchParams.set("$skiptoken", "opaque+/=%token");
    expect(() => validateGraphUrl(next.toString(), kind)).not.toThrow();
    for (const change of [
      (url: URL) => url.searchParams.delete("$select"),
      (url: URL) => url.searchParams.set("$select", "id"),
      (url: URL) => url.searchParams.append("$select", url.searchParams.get("$select")!),
      (url: URL) => url.searchParams.set("$expand", "manager"),
      (url: URL) => url.searchParams.set("$skiptoken", ""),
      (url: URL) => url.searchParams.append("$skiptoken", "second"),
      (url: URL) => { url.hash = "fragment"; },
      (url: URL) => url.searchParams.set("$skiptoken", "x".repeat(8192)),
    ]) {
      const invalid = new URL(next);
      change(invalid);
      expect(() => validateGraphUrl(invalid.toString(), kind))
        .toThrow(expect.objectContaining({ status: 502, code: "invalid_provider_link" }));
    }
  });

  it("requires bounded directory query controls and a query-free exact report endpoint", () => {
    for (const [field, value] of [
      ["$count", "false"], ["$top", "101"], ["$top", "1"], ["$filter", ""], ["$filter", " \t "],
      ["$orderby", "displayName"], ["filter", "accountEnabled eq true"],
    ]) {
      const invalid = new URL(buildReportedUsersUrl([upn]));
      invalid.searchParams.set(field, value);
      expect(() => validateGraphUrl(invalid.toString(), "directory")).toThrow();
    }
    for (const field of ["$select", "$filter", "$count", "$top"]) {
      const invalid = new URL(buildReportedUsersUrl([upn]));
      invalid.searchParams.delete(field);
      expect(() => validateGraphUrl(invalid.toString(), "directory")).toThrow();
    }
    expect(() => validateGraphUrl(`${buildCopilotReportUrl()}?$format=json`, "report")).toThrow();
  });

  it("bounds the serialized URL when an opaque token expands through percent encoding", () => {
    const token = "é".repeat(1500);
    const graph = `${buildSubscribedSkusUrl()}&$skiptoken=${token}`;
    const report = `https://reports.office.com/data/v1.0/download?token=${token}`;
    for (const url of [graph, report]) {
      expect(url.length).toBeLessThan(8192);
      expect(new URL(url).toString().length).toBeGreaterThan(8192);
    }
    expect(() => validateGraphUrl(graph, "catalog")).toThrow();
    expect(() => validateReportDownloadUrl(report)).toThrow();
  });

  it.each(["https://reports.office.com", "https://reportsweu.office.com"])("recognizes only documented signed report paths on %s", origin => {
    for (const path of ["/data/download/opaque_123-a", "/data/v1.0/download?token=signed"]) {
      expect(validateReportDownloadUrl(origin + path)).toBe(origin + path);
    }
    for (const path of ["/", "/data/download/", "/data/download/private/more", "/data/v1.0/download",
      "/data/v1.0/download?token=", "/data/v1.0/download?token=one&token=two", "/data/download/opaque#fragment",
      "/data/download/opaque?token=one&token=two", "/data/download/opaque?redirect=https%3A%2F%2Fattacker.invalid",
      "/data/v1.0/download?token=one&%74oken=two", "/data/v1.0/download?token=one&format=json"]) {
      expect(() => validateReportDownloadUrl(origin + path)).toThrow();
    }
  });

  it.each([null, "", "not a URL", "http://reports.office.com/data/download/key",
    "https://attacker.invalid/data/download/key", "https://private@reports.office.com/data/download/key",
    `https://reports.office.com/data/download/${"x".repeat(8192)}`])("rejects an unsupported signed download %j", url => {
    expect(() => validateReportDownloadUrl(url)).toThrow();
  });

  it.each([
    { companyName: "  Contoso Health  ", department: "  Clinical Operations  ", company: "Contoso Health", departmentValue: "Clinical Operations" },
    { companyName: undefined, department: undefined, company: null, departmentValue: null },
    { companyName: null, department: null, company: null, departmentValue: null },
    { companyName: "", department: " \t ", company: null, departmentValue: null },
    { companyName: "C".repeat(256), department: "D".repeat(256), company: "C".repeat(256), departmentValue: "D".repeat(256) },
  ])("preserves nullable organization metadata %#", ({ companyName, department, company, departmentValue }) => {
    expect(parseDirectoryUser({ ...graphUser(), companyName, department }, catalog, productFilter)?.identity)
      .toMatchObject({ companyName: company, department: departmentValue });
  });

  it.each(["companyName", "department"])("rejects malformed or oversized %s", field => {
    for (const value of [42, {}, ["Operations"], "x".repeat(257)]) {
      expect(() => parseDirectoryUser({ ...graphUser(), [field]: value }, catalog, productFilter)).toThrow();
    }
  });

  it.each(["Microsoft_365_Copilot", "M365_Copilot", "Microsoft_365_Copilot_EDU", "MICROSOFT_365_E7", "Future_product", undefined])(
    "recognizes a paid service independently of product name %s", skuPartNumber => {
      const sku = parseSubscribedSku({ skuId: otherSku, skuPartNumber, appliesTo: "User", servicePlans: [{ servicePlanId: apps }] });
      const row = { ...graphUser(), assignedLicenses: [{ skuId: otherSku, disabledPlans: [] }] };
      const user = parseDirectoryUser(row, new Map([[sku.skuId, sku.servicePlanIds]]), { kind: "products", skuIds: [otherSku] });
      expect(user).toMatchObject({ serviceEvidenceVersion: 1, copilotServiceState: "enabled",
        servicePlans: [{ servicePlanId: apps, service: "M365_COPILOT_APPS",
          displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled", capabilityStatus: "Enabled" }] });
      expect(JSON.stringify(user)).not.toMatch(/skuId|skuPartNumber|licenseAssignmentStates|MICROSOFT_365_E7/);
    });

  it.each([
    { skuPartNumber: "Copilot_Studio", appliesTo: "User", servicePlans: [{ servicePlanId: "fe6c28b3-d468-44ea-bbd0-a10a5167435c" }] },
    { skuPartNumber: "Microsoft_365_E3", appliesTo: "User", servicePlans: [] },
    { skuPartNumber: "Copilot_Chat", appliesTo: "User", servicePlans: [] },
    { skuPartNumber: "Microsoft_365_Copilot", appliesTo: "User", servicePlans: [] },
    { skuPartNumber: "Microsoft_365_Copilot", appliesTo: "Company", servicePlans: [{ servicePlanId: apps }] },
  ])("does not mistake $skuPartNumber/$appliesTo for paid user service evidence", fields => {
    expect(parseSubscribedSku({ skuId, ...fields }).servicePlanIds).toEqual([]);
  });

  it.each(["Enabled", "Warning", "Deleted", "Suspended", "LockedOut", null])(
    "keeps a disabled paid component disabled despite package capability %s", capabilityStatus => {
      const original = graphUser();
      const row = { ...original, assignedLicenses: [{ skuId, disabledPlans: [apps.toUpperCase()] }],
        assignedPlans: capabilityStatus ? [{ ...original.assignedPlans[0], capabilityStatus }] : [] };
      const user = parseDirectoryUser(row, catalog, productFilter);
      expect(user?.copilotServiceState).toBe("disabled");
      expect(user?.servicePlans[0]).toMatchObject({ state: "disabled", capabilityStatus });
    });

  it.each([
    ["Enabled", "enabled"], ["Warning", "warning"], ["Deleted", "disabled"],
    ["Suspended", "suspended"], ["LockedOut", "locked_out"], [null, "unknown"],
  ])("uses component capability %s rather than unrelated package state", (capabilityStatus, expected) => {
    const original = graphUser();
    const user = parseDirectoryUser({ ...original, assignedPlans: capabilityStatus ? [{ ...original.assignedPlans[0], capabilityStatus }] : [] }, catalog, productFilter);
    expect(user?.copilotServiceState).toBe(expected);
    expect(user?.servicePlans[0]).toMatchObject({ state: expected, capabilityStatus });
  });

  it.each([[true, false, "enabled"], [false, true, "enabled"], [true, true, "disabled"]] as const)(
    "resolves two current assignments with disabled flags %s/%s", (first, second, expected) => {
      const user = parseDirectoryUser({ ...graphUser(), assignedLicenses: [
        { skuId, disabledPlans: first ? [apps] : [] }, { skuId: otherSku, disabledPlans: second ? [apps] : [] },
      ] }, new Map([[skuId, [apps]], [otherSku, [apps]]]), productFilter);
      expect(user?.copilotServiceState).toBe(expected);
      expect(user?.servicePlans).toHaveLength(1);
    });

  it.each([false, true])("rejects conflicting effective assignments of the same SKU (reverse: %s)", reverse => {
    const assignedLicenses = [{ skuId, disabledPlans: [apps] }, { skuId: skuId.toUpperCase(), disabledPlans: [] }];
    if (reverse) assignedLicenses.reverse();
    for (const filter of [productFilter, exactFilter]) {
      expect(() => parseDirectoryUser({ ...graphUser(), assignedLicenses }, catalog, filter))
        .toThrow(expect.objectContaining({ status: 502, code: "provider_schema" }));
    }
  });

  it("accepts equivalent duplicate SKU assignments without confusing them with independent products", () => {
    const original = { ...graphUser(), assignedLicenses: [{ skuId, disabledPlans: [apps, teams] }] };
    const duplicate = { skuId: skuId.toUpperCase(), disabledPlans: [teams.toUpperCase(), apps, apps] };
    for (const filter of [productFilter, exactFilter]) {
      expect(parseDirectoryUser({ ...original, assignedLicenses: [...original.assignedLicenses, duplicate] }, catalog, filter))
        .toEqual(parseDirectoryUser(original, catalog, filter));
    }
  });

  it.each([teams, chat])("recognizes paid component %s without an Apps or E7 assignment", servicePlanId => {
    const original = graphUser();
    const user = parseDirectoryUser({ ...original, assignedPlans: [{ ...original.assignedPlans[0], servicePlanId }] },
      new Map([[skuId, [servicePlanId]]]), productFilter);
    expect(user?.copilotServiceState).toBe("enabled");
    expect(user?.servicePlans).toEqual([expect.objectContaining({ servicePlanId, state: "enabled" })]);
  });

  it("preserves partial enablement without promoting disabled or unknown components", () => {
    const original = graphUser();
    const user = parseDirectoryUser({ ...original, assignedLicenses: [{ skuId, disabledPlans: [apps] }],
      assignedPlans: [{ ...original.assignedPlans[0], capabilityStatus: "Deleted" }, { ...original.assignedPlans[0], servicePlanId: teams }],
    }, new Map([[skuId, [apps, teams, chat]]]), productFilter);
    expect(user?.copilotServiceState).toBe("partially_enabled");
    expect(user?.servicePlans.map(plan => [plan.servicePlanId, plan.state])).toEqual([[apps, "disabled"], [teams, "enabled"], [chat, "unknown"]]);
  });

  it.each([["Enabled", "enabled", "Enabled"], ["Warning", "enabled", "Enabled"], ["Deleted", "unknown", null]])(
    "does not invent active evidence from duplicate capability %s", (status, expected, capabilityStatus) => {
      const original = graphUser();
      const user = parseDirectoryUser({ ...original, assignedPlans: [original.assignedPlans[0], { ...original.assignedPlans[0], capabilityStatus: status }] }, catalog, productFilter);
      expect(user?.copilotServiceState).toBe(expected);
      expect(user?.servicePlans).toEqual([expect.objectContaining({ state: expected, capabilityStatus })]);
    });

  it("normalizes equivalent assignment instants and ordering while retaining real submillisecond differences", () => {
    const original = graphUser(), observation = original.assignedPlans[0];
    const utc = { ...observation, assignedDateTime: "2026-01-01T00:00:00Z" };
    const offset = { ...observation, assignedDateTime: "2026-01-01T01:00:00+01:00" };
    const parse = (assignedPlans: typeof original.assignedPlans) => parseDirectoryUser({ ...original, assignedPlans }, catalog, productFilter);
    expect(parse([utc])).toEqual(parse([offset]));
    expect(parse([utc, offset])).toEqual(parse([offset, utc]));
    expect(parse([utc])?.servicePlans[0].assignedDateTime).toBe("2026-01-01T00:00:00.000Z");
    for (const assignedDateTime of ["2026-01-01T00:00:00.001Z", "2026-01-01T00:00:00.0000001Z"]) {
      expect(parse([{ ...observation, assignedDateTime }])).not.toEqual(parse([utc]));
    }
    expect(parse([{ ...observation, assignedDateTime: "2026-01-01T00:30:00Z" }, offset])?.servicePlans[0].assignedDateTime)
      .toBe("2026-01-01T00:30:00.000Z");
  });

  it.each([
    "2026-01-01T00:00:00", "2026-01-01T00:00:00.1234500", "2026-01-01", "January 1, 2026",
    "2026-02-30T00:00:00Z", "2025-02-29T01:00:00+01:00", "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+24:00", "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00+01:00", "9999-12-31T23:30:00-01:00",
  ])("rejects assignment dates without a valid explicit instant: %s", assignedDateTime => {
    const original = graphUser();
    for (const filter of [productFilter, exactFilter]) {
      expect(() => parseDirectoryUser({ ...original, assignedPlans: [{ ...original.assignedPlans[0], assignedDateTime }] }, catalog, filter))
        .toThrow(expect.objectContaining({ status: 502, code: "provider_schema" }));
    }
  });

  it.each([
    ["2024-02-29T23:59:59.1234500Z", "2024-02-29T23:59:59.12345Z"],
    ["2026-01-01T00:30:00.0000001+01:00", "2025-12-31T23:30:00.0000001Z"],
    ["2025-12-31T23:30:00.1-0100", "2026-01-01T00:30:00.100Z"],
    ["0001-01-01T01:00:00+01:00", "0001-01-01T00:00:00.000Z"],
    ["9999-12-31T22:59:59.9999999-01:00", "9999-12-31T23:59:59.9999999Z"],
  ])("preserves valid calendar and timezone boundaries: %s", (assignedDateTime, expected) => {
    const original = graphUser();
    const user = parseDirectoryUser({ ...original, assignedPlans: [{ ...original.assignedPlans[0], assignedDateTime }] }, catalog, productFilter)!;
    expect(user.servicePlans[0].assignedDateTime).toBe(expected);
    const parent = directorySourceRecord(user);
    expect(directoryPlanRecord(parent.identity, user.servicePlans[0])).toMatchObject({
      assigned_at: expected, residual: { assignedDateTime: expected },
    });
  });

  it.each([{ assignments: [] as string[] }, { assignments: [otherSku] }])("distinguishes an exact known non-paid user from unknown SKU evidence %j", ({ assignments }) => {
    const original = graphUser();
    const row = { ...original, assignedLicenses: assignments.map(skuId => ({ skuId, disabledPlans: [] })) };
    expect(parseDirectoryUser(row, catalog, exactFilter)).toMatchObject({
      identity: { objectId, userPrincipalName: upn }, servicePlans: [], copilotServiceState: assignments.length ? "unknown" : "disabled",
    });
    expect(parseDirectoryUser(row, new Map([[skuId, [apps]], [otherSku, []]]), exactFilter)?.copilotServiceState).toBe("disabled");
    expect(parseDirectoryUser(row, catalog, productFilter)).toBeNull();
  });

  it.each([["Enabled", "enabled"], ["Warning", "warning"], ["Deleted", "unknown"], ["Suspended", "unknown"], ["LockedOut", "unknown"], [null, "unknown"]])(
    "requires positive active paid evidence beside an unresolved current SKU: %s", (capabilityStatus, expected) => {
      const original = graphUser();
      const row = { ...original, assignedLicenses: [...original.assignedLicenses, { skuId: otherSku, disabledPlans: [] }],
        assignedPlans: capabilityStatus ? [{ ...original.assignedPlans[0], capabilityStatus }] : [] };
      for (const filter of [productFilter, exactFilter]) expect(parseDirectoryUser(row, catalog, filter)?.copilotServiceState).toBe(expected);
      expect(parseDirectoryUser({ ...row, assignedLicenses: [{ skuId, disabledPlans: [apps] }, { skuId: otherSku, disabledPlans: [] }] }, catalog, exactFilter)?.copilotServiceState)
        .toBe("unknown");
    });

  it("canonicalizes Graph GUIDs without imposing unrelated UUID version restrictions", () => {
    expect(parseDirectoryUser({ ...graphUser(), id: objectId.toUpperCase() }, catalog, productFilter)?.identity.objectId).toBe(objectId);
    expect(parseDirectoryUser({ ...graphUser(), id: "11111111-1111-7111-1111-111111111111" }, catalog, productFilter)).not.toBeNull();
    expect(parseDirectoryUser(graphUser(), catalog, { kind: "reported", identities: [objectId] })).not.toBeNull();
    expect(parseDirectoryUser(graphUser(), catalog, { kind: "reported", identities: ["other@example.com"] })).toBeNull();
  });

  it.each([
    { id: "not-an-object-id" }, { userPrincipalName: "" }, { accountEnabled: "true" }, { displayName: "x".repeat(513) },
    { employeeType: "x".repeat(129) }, { userType: "x".repeat(65) }, { assignedLicenses: null }, { assignedPlans: null },
    { assignedLicenses: [{ skuId, disabledPlans: null }] },
    { assignedPlans: [{ servicePlanId: apps, service: "M365_COPILOT_APPS", capabilityStatus: "Invalid" }] },
    { assignedPlans: [{ servicePlanId: apps, service: "M365_COPILOT_APPS", capabilityStatus: "Enabled", assignedDateTime: "not-a-date" }] },
  ])("applies the same strict directory schema to product and exact records %#", fields => {
    for (const filter of [productFilter, exactFilter]) expect(() => parseDirectoryUser({ ...graphUser(), ...fields }, catalog, filter)).toThrow();
  });

  it.each([null, [], {}, { skuId, appliesTo: "Unknown", servicePlans: [] }, { skuId, appliesTo: "User", servicePlans: null },
    { skuId, appliesTo: "User", servicePlans: [{}] }, { skuId, appliesTo: "User", servicePlans: Array.from({ length: 1001 }, () => ({ servicePlanId: apps })) },
  ])("rejects an incomplete or unbounded license catalog entry %#", value => {
    expect(() => parseSubscribedSku(value)).toThrow();
  });

  it("deduplicates canonical recognized plan IDs without exposing unrecognized products", () => {
    expect(parseSubscribedSku({ skuId: skuId.toUpperCase(), appliesTo: "User", servicePlans: [
      { servicePlanId: apps }, { servicePlanId: apps.toUpperCase() }, { servicePlanId: otherSku },
    ] })).toEqual({ skuId, servicePlanIds: [apps] });
  });

  it("retains blank activity dates as unknown with normalized report identities", () => {
    const row = ["2026-09-13", " PERSON@EXAMPLE.COM ", "Person", "2026-09-12", "", "2026-09-12", "", "", "", "", "", "", "28"];
    expect(row).toHaveLength(reportHeaders.length);
    expect(parseReportUser(row)).toMatchObject({ normalizedUserPrincipalName: upn,
      activity: { reportRefreshDate: "2026-09-13", lastActivityDate: "2026-09-12",
        microsoftTeamsCopilotLastActivityDate: "2026-09-12", wordCopilotLastActivityDate: null, copilotChatLastActivityDate: null } });
    for (const date of ["2026-02-31", "2026-09-12T00:00:00Z", "2026-13-01"]) {
      expect(() => parseReportUser(row.map((value, index) => index === 3 ? date : value))).toThrow();
    }
    expect(() => parseReportUser([...row, "extra"])).toThrow();
    expect(() => parseReportUser(row.slice(1))).toThrow();
    expect(() => parseReportUser(row.map((value, index) => index === 12 ? "7" : value))).toThrow();
    expect(() => parseReportUser(row.map((value, index) => index === 12 ? "30" : value))).toThrow();
    expect(() => parseReportUser(row.map((value, index) => index === 2 ? "x".repeat(1025) : value))).toThrow();
  });

  it("rejects year zero in required and optional report dates while retaining positive four-digit years", () => {
    const row = ["2026-09-13", upn, "Person", "", "", "", "", "", "", "", "", "", "28"];
    for (const index of [0, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      expect(() => parseReportUser(row.map((value, field) => field === index ? "0000-01-01" : value)))
        .toThrow(expect.objectContaining({ status: 502, code: "provider_schema" }));
    }
    for (const reportRefreshDate of ["0001-01-01", "9999-12-31"]) {
      expect(parseReportUser([reportRefreshDate, ...row.slice(1)]).activity.reportRefreshDate).toBe(reportRefreshDate);
    }
  });
});
