import { describe, expect, it } from "vitest";
import { agentColumnValue, agentPersonLabel, agentRelevanceReasons, agentUserAvailability, matchesAgentView, summarizeAgentAvailability } from "./agentPresentation.js";
import type { CopilotPackage } from "./copilotPackage.js";
import type { UnifiedAgentRecord } from "./unifiedAgents.js";

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
