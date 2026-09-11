import { describe, expect, it } from "vitest";
import type { AppRole, SessionUser } from "./api/client";
import { allowedViews } from "./authorization";

function user(role: AppRole): SessionUser {
  return { displayName: role, username: "fixture@example.invalid", homeAccountId: role, roles: [role] };
}

describe("role-aware views", () => {
  it("keeps all four roles non-hierarchical", () => {
    expect(allowedViews(user("AgentControl.Reader"))).toEqual(["agents", "power-platform", "official-usage", "permissions", "jobs"]);
    expect(allowedViews(user("AgentControl.Operator"))).toEqual(["agents", "power-platform", "permissions", "jobs"]);
    expect(allowedViews(user("AgentControl.SecurityReader"))).toEqual(["users", "audit", "security", "permissions", "jobs"]);
    expect(allowedViews(user("AgentControl.Administrator"))).toEqual(["official-usage", "permissions", "jobs"]);
  });
});