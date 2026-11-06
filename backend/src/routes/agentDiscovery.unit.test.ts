import { describe, expect, it } from "vitest";
import { createAgentDiscoveryRouter } from "./agentDiscovery.js";
import { declaredRoutePolicies } from "./policy.js";

describe("canonical discovery route policy", () => {
  it("allows only restricted self reads and independently staff-authorized previews", () => {
    createAgentDiscoveryRouter({ options: { max: 4 } } as never);
    expect(declaredRoutePolicies.get("POST /discovery/read")).toEqual({
      access: "authenticated", dataClass: "employee_discovery", csrf: true,
    });
    expect(declaredRoutePolicies.get("POST /discovery/preview")).toEqual({
      access: "authenticated", dataClass: "employee_discovery", csrf: true, roles: ["AgentControl.Viewer"],
    });
  });
});
