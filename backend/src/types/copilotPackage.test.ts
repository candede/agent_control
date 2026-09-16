import { describe, expect, it } from "vitest";
import { formatAgentAuthoringTool, formatPackageFacetLabel, normalizePackageAuthoringTool, normalizePackageStatus } from "./copilotPackage.js";

describe("package status normalization", () => {
  it.each(["all", "everyone", "allowedForAll", "availableToAll", "deployedToAll", "installedForAll"])("normalizes %s to all", value => {
    expect(normalizePackageStatus(value)).toBe("all");
  });

  it.each(["some", "allowedForSome", "availableToSome", "deployedToSome", "installedForSome"])("normalizes %s to some", value => {
    expect(normalizePackageStatus(value)).toBe("some");
  });

  it.each(["none", "noOne", "allowedForNoOne", "availableToNoOne", "deployedToNoOne", "deployedToNone", "installedForNoOne", "notAvailable", "notDeployed"])("normalizes %s to none", value => {
    expect(normalizePackageStatus(value)).toBe("none");
  });

  it("ignores case and separators in recognized statuses", () => {
    expect(normalizePackageStatus(" DEPLOYED_TO-NO_ONE ")).toBe("none");
    expect(normalizePackageStatus("ALLOWED FOR ALL")).toBe("all");
  });

  it.each([undefined, "", "unknownFutureValue", "futureStatus"])("preserves unknown status %s", value => {
    expect(normalizePackageStatus(value)).toBeUndefined();
  });
});

describe("package authoring labels", () => {
  it.each(["Copilot Studio", "MicrosoftCopilotStudio", "Microsoft Copilot Studio", "copilot_studio"])("keeps the label and filter equivalent for %s", value => {
    expect(formatAgentAuthoringTool(value)).toBe("Copilot Studio");
    expect(normalizePackageAuthoringTool(value)).toBe("copilotstudio");
    expect(normalizePackageAuthoringTool(formatAgentAuthoringTool(value))).toBe("copilotstudio");
  });

  it("preserves non-Studio authoring tools and facet labels", () => {
    expect(formatAgentAuthoringTool("CustomSDK")).toBe("Custom SDK");
    expect(normalizePackageAuthoringTool("CustomSDK")).toBe("customsdk");
    expect(formatPackageFacetLabel("  custom_tool-host2Value  ")).toBe("custom tool host2 Value");
    expect(formatAgentAuthoringTool("")).toBe("");
  });
});
