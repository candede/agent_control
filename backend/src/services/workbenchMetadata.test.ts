import { describe, expect, it } from "vitest";
import { appRoles, capabilityIds } from "../types/capability.js";
import { workbenchViewIds } from "../types/workbench.js";
import { createApp } from "../app.js";
import { declaredRoutePolicies } from "../routes/policy.js";
import { getWorkbenchMetadata } from "./workbenchMetadata.js";

createApp();

describe("workbench metadata", () => {
  it("declares every required view once with Agents first", () => {
    const metadata = getWorkbenchMetadata();
    expect(metadata.views.map(view => view.id)).toEqual(workbenchViewIds);
    expect(metadata.views[0]).toMatchObject({ id: "agents", path: "/agents" });
    expect(new Set(metadata.views.map(view => view.path)).size).toBe(metadata.views.length);
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
  });
});
