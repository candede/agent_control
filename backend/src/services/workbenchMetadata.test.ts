import { describe, expect, it } from "vitest";
import { appRoles, capabilityIds } from "../types/capability.js";
import { workbenchViewIds } from "../types/workbench.js";
import { createApp } from "../app.js";
import { declaredRoutePolicies } from "../routes/policy.js";
import { getWorkbenchMetadata } from "./workbenchMetadata.js";

createApp();

describe("workbench metadata", () => {
  it("uses application authorization for application package refresh recovery", () => {
    expect(getWorkbenchMetadata().actions.find(action => action.id === "packages.refresh.application.resume")).toMatchObject({
      roles: ["AgentControl.Viewer"], capabilityId: "graph.package.read.application",
      method: "POST", route: "/api/agents/refresh-jobs/:id/resume", recovery: "resume_unsent",
    });
  });

  it("declares every required view once with Agents first", () => {
    const metadata = getWorkbenchMetadata();
    expect(metadata.views.map(view => view.id)).toEqual(workbenchViewIds);
    expect(metadata.views.map(view => view.id)).toEqual([
      "agents", "users", "sync", "audit", "permissions",
    ]);
    expect(metadata.views[0]).toMatchObject({ id: "agents", path: "/agents" });
    expect(new Set(metadata.views.map(view => view.path)).size).toBe(metadata.views.length);
    expect(metadata.views.find(view => view.id === "users")).toMatchObject({
      path: "/users", roles: ["AgentControl.Viewer"],
      source: expect.stringContaining("exact saved Power Platform agent responsibility"),
    });
    expect(metadata.views.find(view => view.id === "sync")).toMatchObject({
      path: "/sync", roles: ["AgentControl.Viewer"],
      source: expect.stringContaining("report import, management, and snapshot inspection"),
    });
  });

  it("moves report workflow labels to Sync without renaming APIs or changing authority", () => {
    const actions = getWorkbenchMetadata().actions;
    expect(actions.find(action => action.id === "usage.import")).toMatchObject({
      label: "Import reports in Sync", roles: ["AgentControl.Admin"], capabilityId: "reports.official.import",
      method: "POST", route: "/api/official-usage/bundles/:id/accept", preview: "required", confirmation: "explicit",
    });
    expect(actions.find(action => action.id === "usage.staging.cancel")).toMatchObject({
      label: "Discard actor-owned staging in Sync", roles: ["AgentControl.Admin"],
      method: "DELETE", route: "/api/official-usage/staging/:id", confirmation: "explicit",
    });
    expect(actions.find(action => action.id === "usage.export.aggregate")).toMatchObject({
      label: "Export report snapshot in Sync", roles: ["AgentControl.Viewer"],
      method: "GET", route: "/api/official-usage/aggregate.csv",
    });
  });

  it.each(["purview.resume", "defender.resume"])("leaves %s authorization mode to the retained job", id => {
    expect(getWorkbenchMetadata().actions.find(action => action.id === id)).toMatchObject({
      roles: ["AgentControl.Viewer"], capabilityId: null, nativeTarget: "provider_job_id",
      confirmation: "explicit", recovery: "resume_unsent", method: "POST",
    });
  });

  it.each(["purview.search", "defender.search"])("leaves %s capability checks to the selected authorization mode", id => {
    expect(getWorkbenchMetadata().actions.find(action => action.id === id)).toMatchObject({
      roles: ["AgentControl.Viewer"], capabilityId: null,
      preview: "required", confirmation: "explicit", recovery: "reauthorize", method: "POST",
    });
  });

  it("uses only typed roles and capabilities and keeps write targets explicit", () => {
    const metadata = getWorkbenchMetadata();
    for (const action of metadata.actions) {
      expect(action.route).toMatch(/^\/api\//);
      expect(action.roles.every(role => appRoles.includes(role))).toBe(true);
      if (action.capabilityId) expect(capabilityIds).toContain(action.capabilityId);
      if (action.preview === "required") {
        expect(action.confirmation).not.toBe("none");
        expect(action.nativeTarget).not.toBe("none");
      }
      expect(["none", "resume_unsent", "cancel_unsent", "reconcile_get_only", "reauthorize"]).toContain(action.recovery);
      const routePolicy = declaredRoutePolicies.get(`${action.method} ${action.route.slice("/api".length)}`);
      expect(routePolicy, `${action.id} must reference a registered backend route`).toBeDefined();
      expect(routePolicy).toMatchObject({ access: "authenticated", roles: action.roles });
      if (routePolicy?.access === "authenticated" && routePolicy.capabilityId) {
        expect(action.capabilityId).toBe(routePolicy.capabilityId);
      }
      if (action.method !== "GET") expect(routePolicy).toMatchObject({ csrf: true });
    }
    expect(metadata.actions.find(action => action.id === "quarantine.change")).toMatchObject({
      nativeTarget: "copilot_environment_bot",
      confirmation: "risk_and_exact_targets",
      capabilityId: "powerPlatform.quarantine.manage",
    });
    expect(metadata.actions.find(action => action.id === "packages.refresh.identities")).toMatchObject({
      route: "/api/agents/refresh-jobs",
      method: "POST",
      nativeTarget: "graph_package_id",
      capabilityId: "graph.package.read.delegated",
      recovery: "reauthorize",
    });
    expect(metadata.actions.filter(action => action.source === "data_sync").map(action => action.id)).toEqual([
      "data-sync.auto-refresh", "data-sync.read", "data-sync.start", "data-sync.retry", "data-sync.cancel",
    ]);
    expect(metadata.actions.find(action => action.id === "data-sync.retry")).toMatchObject({
      nativeTarget: "sync_run", roles: ["AgentControl.Viewer"], recovery: "reauthorize",
    });
    const usage = metadata.actions.filter(action => action.id.startsWith("agentUsage."));
    expect(usage.map(action => action.id)).toEqual(["agentUsage.candidates", "agentUsage.associate", "agentUsage.remove"]);
    for (const action of usage) {
      expect(action).toMatchObject({ roles: ["AgentControl.Admin"], capabilityId: null, source: "official_usage", recovery: "none" });
      if (action.method !== "GET") expect(action).toMatchObject({ preview: "required", confirmation: "risk_and_exact_targets" });
    }
  });
});
