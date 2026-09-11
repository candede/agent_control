import { describe, expect, it } from "vitest";
import { getBuiltWithLabel } from "./agentDisplay";

describe("agent display classification", () => {
  it("uses normalized authoring metadata instead of a conflicting package description", () => {
    expect(getBuiltWithLabel({ authoringTool: "copilotStudio", platform: "ignored", shortDescription: "Built using Agent Builder" })).toBe("Copilot Studio");
  });

  it("labels description parsing as a package hint when no authority is supplied", () => {
    expect(getBuiltWithLabel({ authoringTool: null, shortDescription: "Built using Agent Builder." })).toBe("Package hint: Agent Builder");
  });
});