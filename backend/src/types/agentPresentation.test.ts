import { describe, expect, it } from "vitest";
import { agentColumnValue, agentRelevanceReasons, matchesAgentView } from "./agentPresentation.js";
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
    expect(agentColumnValue(value, "availability")).toBe("Varies by package");
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
