import { describe, expect, it } from "vitest";
import type { AppRole, SessionUser } from "./api/client";
import { allowedViews, hasRole } from "./authorization";

function user(role: AppRole): SessionUser {
  return { displayName: role, username: "fixture@example.invalid", homeAccountId: role, roles: [role] };
}

describe("role-aware views", () => {
  const observationalViews = ["agents", "power-platform", "users", "official-usage", "audit", "security", "permissions", "jobs"];

  it("allows Viewer and Admin to every observational view", () => {
    expect(allowedViews(user("AgentControl.Viewer"))).toEqual(observationalViews);
    expect(allowedViews(user("AgentControl.Admin"))).toEqual(observationalViews);
    expect(hasRole(user("AgentControl.Admin"), "AgentControl.Viewer")).toBe(true);
  });

  it("denies protected views to unassigned and legacy-role sessions", () => {
    expect(allowedViews({ ...user("AgentControl.Viewer"), roles: [] })).toEqual(["permissions"]);
    const legacy = { ...user("AgentControl.Viewer"), roles: ["AgentControl.Reader"] } as unknown as SessionUser;
    expect(allowedViews(legacy)).toEqual(["permissions"]);
    expect(hasRole(legacy, "AgentControl.Viewer")).toBe(false);
  });
});