import { describe, expect, it } from "vitest";
import { resolveCopilotServicePlan, summarizeCopilotServices, type CopilotPlanObservation } from "./copilotServicePlans.js";
import type { CopilotServiceState } from "../types/copilotUsage.js";

const appsPlanId = "a62f8878-de10-42f3-b68f-6149a25ceb97";

describe("Copilot service-plan evidence", () => {
  it.each([
    ["2026-01-01T00:00:00Z"],
    ["2026-01-01T01:00:00+01:00"],
    ["2026-01-01T00:00:00.000Z"],
    ["2026-01-01T00:00:00Z", "2026-01-01T01:00:00+01:00"],
    ["2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z"],
  ].map(dates => ({ dates })))("canonicalizes equivalent assignment instants: $dates", ({ dates }) => {
    const observations = dates.map(assignedDateTime => ({
      servicePlanId: appsPlanId, assignedDateTime, capabilityStatus: "Enabled" as const,
    }));
    expect(resolveCopilotServicePlan(appsPlanId, true, observations)).toMatchObject({
      state: "enabled", capabilityStatus: "Enabled", assignedDateTime: "2026-01-01T00:00:00.000Z",
    });
  });

  it.each([
    ["Enabled", "enabled"],
    ["Warning", "warning"],
    ["Suspended", "suspended"],
    ["LockedOut", "locked_out"],
    ["Deleted", "disabled"],
    [null, "unknown"],
  ] as const)("resolves %s only when the current assignment enables the feature", (capabilityStatus, state) => {
    const observations: CopilotPlanObservation[] = [{
      servicePlanId: appsPlanId, assignedDateTime: null, capabilityStatus,
    }];
    expect(resolveCopilotServicePlan(appsPlanId, true, observations)).toMatchObject({ state, capabilityStatus });
    expect(resolveCopilotServicePlan(appsPlanId, false, observations)).toMatchObject({ state: "disabled", capabilityStatus });
  });

  it("does not use a newer assignment timestamp to override conflicting capability evidence", () => {
    const observations: CopilotPlanObservation[] = [
      { servicePlanId: appsPlanId, assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Deleted" },
      { servicePlanId: appsPlanId, assignedDateTime: "2026-01-02T00:00:00Z", capabilityStatus: "Enabled" },
    ];
    expect(resolveCopilotServicePlan(appsPlanId, true, observations)).toMatchObject({
      state: "unknown", capabilityStatus: null, assignedDateTime: "2026-01-02T00:00:00.000Z",
    });
  });

  it.each([false, true])("preserves submillisecond assignment evidence when ordering observations (reverse: %s)", reverse => {
    const dates = ["2026-01-01T00:00:00.1234Z", "2026-01-01T01:00:00.1234500+01:00"];
    if (reverse) dates.reverse();
    const observations: CopilotPlanObservation[] = dates.map(assignedDateTime => ({
      servicePlanId: appsPlanId, assignedDateTime, capabilityStatus: "Enabled",
    }));
    expect(resolveCopilotServicePlan(appsPlanId, true, observations).assignedDateTime)
      .toBe("2026-01-01T00:00:00.12345Z");
  });

  it("normalizes equivalent submillisecond timestamps without losing their precision", () => {
    const resolve = (assignedDateTime: string) => resolveCopilotServicePlan(appsPlanId, true, [{
      servicePlanId: appsPlanId, assignedDateTime, capabilityStatus: "Enabled",
    }]);
    expect(resolve("2026-01-01T01:00:00.1234500+01:00")).toEqual(resolve("2026-01-01T00:00:00.12345Z"));
  });

  it("preserves absent dates and ignores observations of unrelated services", () => {
    expect(resolveCopilotServicePlan(appsPlanId, true, [{
      servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347",
      assignedDateTime: "2026-01-01T00:00:00Z", capabilityStatus: "Enabled",
    }])).toMatchObject({ state: "unknown", assignedDateTime: null, capabilityStatus: null });
  });
});

describe("Copilot service summaries", () => {
  it.each([
    { states: [], expected: "unknown" },
    { states: ["enabled", "enabled"], expected: "enabled" },
    { states: ["enabled", "warning"], expected: "warning" },
    { states: ["warning", "disabled"], expected: "partially_enabled" },
    { states: ["enabled", "unknown"], expected: "partially_enabled" },
    { states: ["disabled", "unknown"], expected: "unknown" },
    { states: ["disabled", "suspended"], expected: "suspended" },
    { states: ["locked_out", "suspended"], expected: "locked_out" },
    { states: ["disabled"], expected: "disabled" },
  ] satisfies { states: CopilotServiceState[]; expected: string }[])("summarizes $states as $expected", ({ states, expected }) => {
    const plans = states.map(state => ({ ...resolveCopilotServicePlan(appsPlanId, true, []), state }));
    expect(summarizeCopilotServices(plans)).toBe(expected);
  });
});
