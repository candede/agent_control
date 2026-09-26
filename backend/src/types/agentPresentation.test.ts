import { describe, expect, it } from "vitest";
import { agentColumnValue, agentManagement, agentPersonLabel, agentRelevanceReasons, agentUserAvailability, matchesAgentFilters, matchesAgentView, summarizeAgentAvailability } from "./agentPresentation.js";
import type { CopilotPackage } from "./copilotPackage.js";
import type { PowerPlatformResource } from "./powerPlatformInventory.js";
import type { UnifiedAgentRecord } from "./unifiedAgents.js";
import { unifiedAgentAccessFilters, unifiedAgentManagementFilters, unifiedAgentQuickViews, unifiedAgentRelevanceFilters, unifiedAgentUsageFilters } from "./unifiedAgents.js";

function record(packages: Array<Partial<CopilotPackage>> = [{}]): UnifiedAgentRecord {
  return {
    id: "agent-1", displayName: "Agent", environmentId: null, presence: "graph_packages",
    packages: packages.map((item, index) => ({
      id: `package-${index}`, displayName: "Agent", isBlocked: false, sourceSystem: "graph_packages",
      authoringTool: null, creatorType: "unknown", agentKind: "copilot_package",
      lifecycle: "unknown", identityConfidence: "exact_native", provenance: {}, ...item,
    })),
    powerPlatformResource: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: null },
  };
}

function nativeResource(overrides: Partial<PowerPlatformResource> = {}): PowerPlatformResource {
  return {
    tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
    location: null, displayName: null, environmentId: "environment", createdAt: null, createdBy: null,
    lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
    agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [],
    provenance: {}, details: {}, unknownFieldCount: 0, ...overrides,
  };
}

const accessObservation = {
  snapshotId: "control", observedAt: "2026-09-17T10:00:00Z", expiresAt: "2026-09-24T10:00:00Z",
};
const personalPackage: Partial<CopilotPackage> = {
  type: "custom", authoringTool: "Microsoft 365 Copilot Agent Builder", availableTo: "none", deployedTo: "none",
};

describe("agent quick views and independent filters", () => {
  it.each([
    { types: ["microsoft"], first: true, third: false },
    { types: [" MICROSOFT ", "microsoft"], first: true, third: false },
    { types: ["external"], first: false, third: true },
    { types: ["EXTERNAL", " external "], first: false, third: true },
    ...[[], ["custom"], ["shared"], ["first_party"], ["third_party"], ["Microsoft Corporation"],
      [undefined], ["future"], ["microsoft", "external"], ["microsoft", "custom"], ["external", "shared"],
      ["microsoft", undefined], ["external", "future"]].map(types => ({ types, first: false, third: false })),
  ])("classifies publisher party only from consistent saved package types: $types", ({ types, first, third }) => {
    const value = record(types.map(type => ({
      type, publisher: "Microsoft", displayName: "Microsoft Copilot", authoringTool: "Microsoft Copilot Studio",
    })));
    value.usage = { status: "unlinked", responses: 100, reportSetId: "report", activeUsers: 1, lastActivityDateUtc: null,
      associations: [{ reportAgentId: "report-agent", reportAgentName: "Microsoft Copilot",
        basis: "exact_package_id", target: { source: "graph_packages", packageId: "package-0" } }] };
    expect(matchesAgentView(value, "first_party")).toBe(first);
    expect(matchesAgentView(value, "third_party")).toBe(third);
  });

  it.each([
    { authoringTool: "Copilot Studio" }, { authoringTool: "Microsoft Copilot Studio" },
    { platform: "CopilotStudio" }, { shortDescription: "Built using Copilot Studio." },
  ])("uses normalized saved package authoring evidence for Studio: %j", item => {
    const value = record([item]);
    expect(matchesAgentView(value, "copilot_studio")).toBe(true);
    expect(matchesAgentView(value, "first_party")).toBe(false);
  });

  it.each(["Copilot Studio Lite", "Microsoft Copilot Studio Lite", "Microsoft 365 Copilot Agent Builder", "Agent Builder"])(
    "does not put %s in the full Studio quick view", authoringTool => {
      expect(matchesAgentView(record([{ authoringTool }]), "copilot_studio")).toBe(false);
    },
  );

  it.each([
    { details: {}, studio: false }, { details: { createdIn: "Future authoring tool" }, studio: false },
    { details: { createdIn: "Copilot Studio" }, studio: true },
    { details: { createdIn: "Copilot Studio Lite" }, studio: false },
    { details: { createdIn: "Microsoft 365 Copilot Agent Builder" }, studio: false },
  ])("uses native authoring evidence rather than the resource type: $details", ({ details, studio }) => {
    const value = record([]);
    value.powerPlatformResource = nativeResource({ details });
    expect(matchesAgentView(value, "copilot_studio")).toBe(studio);
    expect(matchesAgentView(value, "first_party")).toBe(false);
    expect(matchesAgentView(value, "third_party")).toBe(false);
    expect(agentManagement(value)).toBe("unknown");
  });

  it.each([
    personalPackage,
    { ...personalPackage, type: " SHARED " },
    { ...personalPackage, authoringTool: "Copilot Studio Lite" },
    { ...personalPackage, authoringTool: null, platform: "Microsoft 365 Copilot Agent Builder" },
    { ...personalPackage, authoringTool: null, shortDescription: "Built using Microsoft 365 Copilot Agent Builder." },
    { ...personalPackage, availableTo: "allowedForNoOne", deployedTo: "notDeployed", isBlocked: true },
  ])("confirms user management only with internal origin, Builder and explicit negative scopes: %j", item => {
    const value = record([item]);
    expect(agentManagement(value)).toBe("user_managed");
    expect(matchesAgentView(value, "user_managed")).toBe(true);
    expect(matchesAgentView(value, "organization_managed")).toBe(false);
  });

  it.each([
    { type: undefined }, { type: "microsoft" }, { type: "external" }, { type: "future" },
    { authoringTool: null }, { authoringTool: "Copilot Studio" }, { authoringTool: "Agent Builder" },
    { availableTo: undefined }, { availableTo: "future" }, { availableTo: "all" },
    { deployedTo: undefined }, { deployedTo: "future" }, { deployedTo: "some" },
  ])("leaves incomplete or contrary user-management evidence unknown: %j", override => {
    expect(agentManagement(record([{ ...personalPackage, ...override }]))).toBe("unknown");
  });

  it("requires every package's internal origin and explicit negative scopes without inferring from missing catalogs", () => {
    const value = record([personalPackage, { ...personalPackage, type: "shared", authoringTool: null }]);
    expect(agentManagement(value)).toBe("user_managed");
    for (const other of [{}, { type: "external", availableTo: "none", deployedTo: "none" },
      { type: "custom", availableTo: "none" }, { type: "shared", availableTo: "none", deployedTo: "some" }]) {
      value.packages = record([personalPackage, other]).packages;
      expect(agentManagement(value)).toBe("unknown");
    }
    value.packages = record([{ ...personalPackage, authoringTool: null }]).packages;
    value.powerPlatformResource = nativeResource({ details: { createdIn: "Copilot Studio Lite" } });
    expect(agentManagement(value)).toBe("user_managed");
    value.packages = [];
    expect(agentManagement(value)).toBe("unknown");
  });

  it.each([
    { availableTo: "all" }, { availableTo: "availableToSome" },
    { deployedTo: "Installed-For-All" }, { deployedTo: "some" },
  ])("requires verified administrative access controls as well as positive scopes: %j", scopes => {
    const value = record([{ type: "external", ...scopes }]);
    expect(agentManagement(value)).toBe("unknown");
    value.packages[0].controlObservations = { block: accessObservation };
    expect(agentManagement(value)).toBe("unknown");
    value.packages[0].controlObservations.access = accessObservation;
    expect(agentManagement(value)).toBe("organization_managed");
    expect(matchesAgentView(value, "organization_managed")).toBe(true);
  });

  it("does not combine unrelated controls and installation scopes or infer an actor from native management/publication", () => {
    const value = record([
      { availableTo: "none", deployedTo: "none", controlObservations: { access: accessObservation } },
      { type: "shared", availableTo: "some", deployedTo: "all", authoringTool: "Copilot Studio" },
    ]);
    value.powerPlatformResource = nativeResource({ lifecycle: "published", authoringTool: "Copilot Studio", details: { isManaged: true } });
    expect(agentManagement(value)).toBe("unknown");
    value.packages.pop();
    expect(agentManagement(value)).toBe("unknown");
    value.packages[0].availableTo = undefined;
    value.packages[0].deployedTo = "future";
    expect(agentManagement(value)).toBe("unknown");
    value.packages = [];
    expect(agentManagement(value)).toBe("unknown");
  });

  it("keeps management independent of block/quarantine and lets positive admin evidence override personal packages", () => {
    const value = record([personalPackage, {
      type: "shared", availableTo: "some", deployedTo: "none", isBlocked: true,
      controlObservations: { access: accessObservation },
    }]);
    expect(agentManagement(value)).toBe("organization_managed");
    expect(agentUserAvailability(value)).toBe("unavailable");
    value.packages[1].isBlocked = false;
    value.powerPlatformResource = nativeResource({ details: { isQuarantined: true } });
    expect(agentManagement(value)).toBe("organization_managed");
    expect(matchesAgentFilters(value, { view: "organization_managed", endUserAccess: "unavailable" })).toBe(true);
    expect(matchesAgentFilters(value, { view: "organization_managed", endUserAccess: "available" })).toBe(false);
    value.packages = record([personalPackage]).packages;
    expect(agentManagement(value)).toBe("user_managed");
  });

  it.each([
    { status: "linked", responses: 1, used: true },
    { status: "linked", responses: 0, used: false },
    { status: "linked", responses: null, used: false },
    { status: "unlinked", responses: 5, used: false },
    { status: "unavailable", responses: 5, used: false },
  ] as const)("filters reported usage by positive linked responses, not activity or report names: $status $responses", ({ status, responses, used }) => {
    const value = record([{ type: "external", availableTo: "all" }]);
    value.usage = { status, responses, reportSetId: "report", activeUsers: 99, lastActivityDateUtc: "2026-09-17", associations: [] };
    expect(matchesAgentFilters(value, { reportedUsage: "used" })).toBe(used);
    expect(matchesAgentView(value, "used")).toBe(used);
    expect(matchesAgentFilters(value, { relevance: "organization" })).toBe(used);
    expect(matchesAgentFilters(value, { relevance: "unknown" })).toBe(!used);
  });

  it("intersects all six quick views with every independent filter and preserves legacy view meanings", () => {
    const value = record([{
      type: "external", authoringTool: "Copilot Studio", availableTo: "all", controlObservations: { access: accessObservation },
    }]);
    value.usage = { status: "linked", responses: 3, reportSetId: "report", activeUsers: 1, lastActivityDateUtc: null, associations: [] };
    for (const view of unifiedAgentQuickViews) {
      for (const endUserAccess of unifiedAgentAccessFilters) {
        for (const reportedUsage of unifiedAgentUsageFilters) {
          for (const management of unifiedAgentManagementFilters) {
            for (const relevance of unifiedAgentRelevanceFilters) {
              const query = { view, endUserAccess, reportedUsage, management, relevance };
              expect(matchesAgentFilters(value, query), JSON.stringify(query)).toBe(
                ["all", "third_party", "copilot_studio", "organization_managed"].includes(view)
                && ["all", "available"].includes(endUserAccess)
                && ["all", "organization_managed"].includes(management)
                && ["all", "organization"].includes(relevance),
              );
            }
          }
        }
      }
    }
    expect(matchesAgentFilters(value, { view: "used", management: "organization_managed" })).toBe(true);
    expect(matchesAgentFilters(value, { view: "organization", endUserAccess: "available" })).toBe(true);
    expect(matchesAgentFilters(value, { view: "available", endUserAccess: "unavailable" })).toBe(false);
    const unknown = record([{}]);
    expect(matchesAgentFilters(unknown, { view: "unknown", management: "unknown", endUserAccess: "unknown", relevance: "unknown" })).toBe(true);
    expect(matchesAgentFilters(unknown, { view: "availability_unknown", reportedUsage: "used" })).toBe(false);
    expect(matchesAgentFilters(unknown, {})).toBe(true);
  });
});

describe("agent presentation and organizational relevance", () => {
  it("only presents a saved person's label for the same exact native user ID", () => {
    const person = {
      objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", displayName: "Saved Person",
      userPrincipalName: "saved@example.invalid", observedAt: "2026-09-17T10:00:00Z",
    };
    expect(agentPersonLabel(person, person.objectId.toUpperCase())).toBe("Saved Person (saved@example.invalid)");
    expect(agentPersonLabel(person, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(agentPersonLabel(person, null)).toBeNull();
    expect(agentPersonLabel({ ...person, userPrincipalName: null }, person.objectId)).toBe("Saved Person");
    expect(agentPersonLabel({ ...person, status: "lookup_failed" }, person.objectId))
      .toBe("Saved Person (saved@example.invalid) (lookup failed)");
    expect(agentPersonLabel({ ...person, status: "not_found", displayName: null, userPrincipalName: null }, person.objectId))
      .toBe(`${person.objectId} (not found)`);
  });

  it("uses known legacy authoring evidence and deduplicates Lite and Agent Builder labels across sources", () => {
    const value = record([{ authoringTool: "Microsoft 365 Copilot Agent Builder" }, { authoringTool: "Copilot Studio Lite" }]);
    value.powerPlatformResource = {
      tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
      location: null, displayName: null, environmentId: "environment", createdAt: null, createdBy: null,
      lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
      agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [],
      provenance: {}, details: { createdIn: "Copilot Studio Lite" }, unknownFieldCount: 0,
    };
    expect(agentColumnValue(value, "builtWith")).toBe("Microsoft 365 Copilot Agent Builder");
    value.packages = [];
    expect(agentColumnValue(value, "builtWith")).toBe("Microsoft 365 Copilot Agent Builder");
    value.powerPlatformResource.details.createdIn = "Future authoring service";
    expect(agentColumnValue(value, "builtWith")).toBeNull();
    value.powerPlatformResource.authoringTool = "Explicit provider tool";
    expect(agentColumnValue(value, "builtWith")).toBe("Explicit provider tool");
  });

  it("counts created or Teams-available logical agents once without claiming usage", () => {
    const both = record([
      { type: "custom", availableTo: "all", supportedHosts: ["Teams"] },
      { type: "custom", availableTo: "some", supportedHosts: ["teams"] },
    ]);
    const available = record([{ type: "external", availableTo: "availableToSome", supportedHosts: [" Teams "] }]);
    const created = record([{ type: "custom", isBlocked: true }]);
    const unknown = record([{ type: "external", supportedHosts: ["Teams"], availableTo: "unknown" }]);
    const blocked = record([{ type: "external", isBlocked: true, supportedHosts: ["Teams"], availableTo: "all" }]);
    const otherHost = record([{ type: "external", supportedHosts: ["Copilot"], availableTo: "all" }]);
    expect(summarizeAgentAvailability([both, available, created, unknown, blocked, otherHost])).toEqual({
      availableToUsers: 3, organizationCreated: 2, teamsAvailable: 2, createdOrAvailable: 3,
    });
    expect(matchesAgentView(both, "used")).toBe(false);
    expect(summarizeAgentAvailability([])).toEqual({ availableToUsers: 0, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 0 });
  });

  it.each([
    { packages: [{ type: "external", availableTo: "all", supportedHosts: ["Copilot"] }], state: "available", label: "All users" },
    { packages: [{ availableTo: "Available-To-Some" }], state: "available", label: "Specific users or groups" },
    { packages: [{ availableTo: "all", isBlocked: true }], state: "unavailable", label: "Not available" },
    { packages: [{ availableTo: "none", type: "custom", deployedTo: "all" }], state: "unavailable", label: "Not available" },
    { packages: [{ availableTo: "futureValue", type: "microsoft", deployedTo: "all" }], state: "unknown", label: null },
    { packages: [{ availableTo: "all", isBlocked: undefined }], state: "unknown", label: null },
    { packages: [{ availableTo: "all", isBlocked: true }, { availableTo: "none" }], state: "unavailable", label: "Not available" },
    { packages: [{ availableTo: "all", isBlocked: true }, { availableTo: "some" }], state: "available", label: "Specific users or groups" },
    { packages: [{ availableTo: "all", isBlocked: true }, {}], state: "unknown", label: null },
    { packages: [], state: "unknown", label: null },
  ])("uses the same end-user access classification for counts, filters and columns: $state $label", ({ packages, state, label }) => {
    const value = record(packages);
    value.usage = { status: "linked", reportSetId: "report", responses: 12, activeUsers: 1, lastActivityDateUtc: null, associations: [] };
    expect(agentUserAvailability(value)).toBe(state);
    expect(matchesAgentView(value, "all")).toBe(true);
    expect(matchesAgentView(value, "available")).toBe(state === "available");
    expect(matchesAgentView(value, "unavailable")).toBe(state === "unavailable");
    expect(matchesAgentView(value, "availability_unknown")).toBe(state === "unknown");
    expect(summarizeAgentAvailability([value]).availableToUsers).toBe(Number(state === "available"));
    expect(agentColumnValue(value, "availability")).toBe(label);
  });

  it("does not treat native publication as user access and excludes known quarantine", () => {
    const value = record([{ availableTo: "all" }]);
    value.powerPlatformResource = {
      tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
      location: null, displayName: null, environmentId: "environment", createdAt: null, createdBy: null,
      lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
      agentKind: "agent", lifecycle: "published", identityConfidence: "exact_native", identifiers: [],
      provenance: {}, details: { isQuarantined: true }, unknownFieldCount: 0,
    };
    expect(agentUserAvailability(value)).toBe("unavailable");
    expect(summarizeAgentAvailability([value]).availableToUsers).toBe(0);
    value.powerPlatformResource.details.isQuarantined = false;
    value.packages = [];
    expect(agentUserAvailability(value)).toBe("unknown");
  });

  it.each(["microsoft", "custom", "shared"])("includes documented %s origin without pretending it was used", type => {
    const value = record([{ type, deployedTo: "none", isBlocked: true }]);
    expect(matchesAgentView(value, "organization")).toBe(true);
    expect(matchesAgentView(value, "used")).toBe(false);
  });

  it.each(["all", "some", "deployedToSome", "Installed-For-All"])("includes deployed third-party agents (%s)", deployedTo => {
    const value = record([{ type: "external", deployedTo }]);
    expect(agentRelevanceReasons(value)).toEqual(["deployed"]);
  });

  it("does not infer use from availability, authoring tool, publisher, or unknown future statuses", () => {
    const value = record([{
      type: "external", availableTo: "all", deployedTo: "unknownFutureValue", publisher: "Microsoft",
      authoringTool: "Copilot Studio",
    }]);
    expect(matchesAgentView(value, "organization")).toBe(false);
    expect(matchesAgentView(value, "used")).toBe(false);
    expect(matchesAgentView(value, "unknown")).toBe(true);
    expect(matchesAgentView(value, "all")).toBe(true);
  });

  it("considers every associated package and does not exclude a used vendor", () => {
    const value = record([{ type: "external", deployedTo: "none" }, { type: "custom" }]);
    expect(matchesAgentView(value, "organization")).toBe(true);
    value.packages.pop();
    value.usage = { status: "linked", reportSetId: "report", responses: 10, activeUsers: 1, lastActivityDateUtc: null, associations: [] };
    expect(matchesAgentView(value, "used")).toBe(true);
    expect(matchesAgentView(value, "organization")).toBe(true);
    value.usage.responses = 0;
    expect(matchesAgentView(value, "used")).toBe(false);
    expect(agentColumnValue(value, "responses")).toBe(0);
    value.usage.status = "unlinked";
    expect(agentColumnValue(value, "responses")).toBeNull();
  });

  it("uses normalized union values and distinguishes mixed and unknown scopes", () => {
    const value = record([
      { supportedHosts: ["Teams", "Copilot"], authoringTool: "CopilotStudio", availableTo: "all", deployedTo: "none", version: "2" },
      { supportedHosts: ["Teams"], authoringTool: "Copilot Studio", availableTo: "some", deployedTo: "unknownFutureValue", version: "1" },
    ]);
    expect(agentColumnValue(value, "hosts")).toBe("Copilot / Teams");
    expect(agentColumnValue(value, "builtWith")).toBe("Copilot Studio");
    expect(agentColumnValue(value, "availability")).toBe("All users");
    expect(agentColumnValue(value, "deployment")).toBe("Partially known");
    expect(agentColumnValue(value, "versions")).toBe("1 / 2");
  });

  it("preserves saved authoring fields and package hints without using them as origin evidence", () => {
    const value = record([
      { authoringTool: null, platform: "CopilotStudio" },
      { authoringTool: null, shortDescription: "Built using Agent Builder." },
      { authoringTool: "Copilot Studio", platform: "Other platform" },
      { authoringTool: null },
    ]);
    expect(agentColumnValue(value, "builtWith")).toBe("Agent Builder / Copilot Studio");
    expect(matchesAgentView(value, "organization")).toBe(false);
    expect(agentColumnValue(value, "origin")).toBeNull();
  });

  it.each(["unknownFutureValue", "constructor", "__proto__"])("keeps unrecognized origin %s unknown without inheriting object properties", type => {
    const value = record([{ type, publisher: "Microsoft", authoringTool: "Copilot Studio" }]);
    expect(agentColumnValue(value, "origin")).toBeNull();
    expect(matchesAgentView(value, "organization")).toBe(false);
  });

  it("retains unknown markers when only part of a grouped origin or version is known", () => {
    const value = record([{ type: "custom", version: "2" }, {}]);
    expect(agentColumnValue(value, "origin")).toBe("Organization-created / Unknown");
    expect(agentColumnValue(value, "versions")).toBe("2 / Unknown");
  });

  it("uses real instants and does not inspect unrelated invalid date fields", () => {
    const value = record([
      { lastModifiedDateTime: "2026-09-01T12:00:00+04:00", createdDateTime: "not-a-date" },
      { lastModifiedDateTime: "2026-09-01T09:00:00Z" },
    ]);
    expect(agentColumnValue(value, "lastModifiedAt")).toBe(Date.parse("2026-09-01T09:00:00Z"));
    expect(agentColumnValue(value, "displayName")).toBe("Agent");
    expect(() => agentColumnValue(value, "createdAt")).toThrow("invalid timestamp");
  });
});
