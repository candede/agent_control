import { describe, expect, it } from "vitest";
import { declaredRoutePolicies } from "./policy.js";
import { createOfficialUsageRouter } from "./officialUsage.js";

describe("official usage history route", () => {
  it("declares tenant history as a Viewer-scoped authenticated read", () => {
    createOfficialUsageRouter();

    expect(declaredRoutePolicies.get("GET /official-usage/history")).toEqual({
      access: "authenticated",
      dataClass: "official_usage_history",
      roles: ["AgentControl.Viewer"],
    });
  });
});
