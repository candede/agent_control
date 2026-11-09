import { describe, expect, it } from "vitest";
import { createAdoptionContentRouter } from "./adoptionContent.js";
import { createAgentDiscoveryRouter } from "./agentDiscovery.js";
import { declaredRoutePolicies } from "./policy.js";
import type pg from "pg";

describe("adoption routes use ordinary staff/browser/bearer policies", () => {
  it("registers finite read/write contracts with exactly the existing Viewer hierarchy and CSRF", () => {
    const database = { options: { max: 4 } } as pg.Pool;
    createAdoptionContentRouter(database);
    createAgentDiscoveryRouter(database);
    for (const key of ["GET /adoption-content", "GET /adoption-content/:id", "POST /adoption-content",
      "PATCH /adoption-content/:id", "DELETE /adoption-content/:id", "POST /adoption-content/:id/follow-up"]) {
      expect(declaredRoutePolicies.get(key)).toMatchObject({ access: "authenticated", roles: ["AgentControl.Viewer"], dataClass: "adoption_content" });
      if (!key.startsWith("GET")) expect(declaredRoutePolicies.get(key)).toMatchObject({ csrf: true });
      expect(declaredRoutePolicies.get(key)).not.toHaveProperty("capabilityId");
    }
    expect(declaredRoutePolicies.get("POST /discovery/learning")).toEqual({ access: "authenticated", dataClass: "employee_discovery", csrf: true });
    expect(declaredRoutePolicies.get("POST /discovery/learning/preview")).toMatchObject({ roles: ["AgentControl.Viewer"], csrf: true });
  });
});
