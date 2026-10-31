// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AppRole, SessionUser } from "./api/client";
import { allowedViews, hasRole } from "./authorization";

function user(role: AppRole): SessionUser {
  return { displayName: role, username: "fixture@example.invalid", homeAccountId: role, roles: [role] };
}

describe("role-aware views", () => {
  const observationalViews = ["dashboard", "agents", "users", "sync", "permissions"];
  const adminViews = ["dashboard", "agents", "users", "sync", "audit", "permissions"];

  it("reserves Audit for Admin while keeping ordinary data views available to Viewer", () => {
    expect(allowedViews(user("AgentControl.Viewer"))).toEqual(observationalViews);
    expect(allowedViews(user("AgentControl.Admin"))).toEqual(adminViews);
    expect(hasRole(user("AgentControl.Admin"), "AgentControl.Viewer")).toBe(true);
  });

  it("lets a standalone Uploader view data and upload without administrative authority", () => {
    const uploader = user("AgentControl.UsageReportUploader");
    expect(allowedViews(uploader)).toEqual(observationalViews);
    expect(hasRole(uploader, "AgentControl.Viewer")).toBe(true);
    expect(hasRole(uploader, "AgentControl.UsageReportUploader")).toBe(true);
    expect(hasRole(uploader, "AgentControl.Admin")).toBe(false);
    expect(hasRole(user("AgentControl.Admin"), "AgentControl.UsageReportUploader")).toBe(true);
    expect(hasRole(user("AgentControl.Viewer"), "AgentControl.UsageReportUploader")).toBe(false);
  });

  it("denies protected views to unassigned and legacy-role sessions", () => {
    expect(allowedViews({ ...user("AgentControl.Viewer"), roles: [] })).toEqual(["permissions"]);
    const legacy = { ...user("AgentControl.Viewer"), roles: ["AgentControl.Reader"] } as unknown as SessionUser;
    expect(allowedViews(legacy)).toEqual(["permissions"]);
    expect(hasRole(legacy, "AgentControl.Viewer")).toBe(false);
  });

  it("does not grant Admin authority to a Viewer or an absent session", () => {
    expect(hasRole(user("AgentControl.Viewer"), "AgentControl.Admin")).toBe(false);
    for (const role of ["AgentControl.Viewer", "AgentControl.Admin"] as const) {
      expect(hasRole(undefined, role)).toBe(false);
      expect(hasRole({ ...user(role), roles: [] }, role)).toBe(false);
    }
    expect(allowedViews(undefined)).toEqual(["permissions"]);
  });

  it("uses only the current role assignment without retaining earlier grants", () => {
    const principal = user("AgentControl.Admin");
    expect(hasRole(principal, "AgentControl.Admin")).toBe(true);
    principal.roles = ["AgentControl.Viewer"];
    expect(hasRole(principal, "AgentControl.Admin")).toBe(false);
    expect(allowedViews(principal)).toEqual(observationalViews);
    principal.roles = [];
    expect(hasRole(principal, "AgentControl.Viewer")).toBe(false);
    expect(allowedViews(principal)).toEqual(["permissions"]);
  });

  it("returns independent observational views for equivalent role sets", () => {
    const principal = { ...user("AgentControl.Admin"), roles: ["AgentControl.Admin", "AgentControl.Viewer"] as AppRole[] };
    const views = allowedViews(principal);
    views.pop();
    principal.roles.reverse();
    expect(allowedViews(principal)).toEqual(adminViews);
  });
});