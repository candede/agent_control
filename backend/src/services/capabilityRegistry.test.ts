import { describe, expect, it } from "vitest";
import { appRoles, capabilityIds, hasAppRole } from "../types/capability.js";
import { capabilityDefinitions, hasAnyRole, resolveCapabilityStatus } from "./capabilityRegistry.js";

describe("capability registry", () => {
  it("defines every retained capability exactly once with source-linked requirements", () => {
    expect(capabilityDefinitions.map(definition => definition.id)).toEqual(capabilityIds);
    expect(new Set(capabilityDefinitions.map(definition => definition.id)).size).toBe(14);
    for (const definition of capabilityDefinitions) {
      expect(definition.sources.every(source => source.startsWith("https://learn.microsoft.com/"))).toBe(true);
      expect(definition.internalRoles.every(role => appRoles.includes(role))).toBe(true);
      expect(definition.probe.adapterRegistered || definition.probe.kind === "not_registered").toBe(true);
    }
  });

  it("defines only Viewer and Admin and gives Admin all Viewer authority", () => {
    expect(appRoles).toEqual(["AgentControl.Viewer", "AgentControl.Admin"]);
    expect(hasAppRole(["AgentControl.Admin"], "AgentControl.Viewer")).toBe(true);
    expect(hasAnyRole(["AgentControl.Admin"], ["AgentControl.Viewer"])).toBe(true);
    expect(hasAppRole(["AgentControl.Viewer"], "AgentControl.Admin")).toBe(false);
    expect(hasAnyRole([], ["AgentControl.Viewer"])).toBe(false);
  });

  it("keeps application mode, preview writes, and local policy explicit", () => {
    expect(capabilityDefinitions.filter(definition => definition.mode === "application")).toHaveLength(3);
    expect(capabilityDefinitions.filter(definition => definition.probe.kind === "on_demand").map(definition => definition.id)).toEqual([
      "graph.package.access.manage", "graph.package.block.manage", "powerPlatform.quarantine.manage",
    ]);
    expect(capabilityDefinitions.find(definition => definition.id === "reports.official.import")?.mode).toBe("local");
    expect(JSON.stringify(capabilityDefinitions)).not.toMatch(/Phase\s*0?5|owning.*phase/i);
    for (const definition of capabilityDefinitions.filter(definition => definition.probe.kind === "on_demand")) {
      expect(definition.probe.description).toContain("Microsoft authorizes the delegated request when it runs.");
      expect(definition.configuration.join(" ")).not.toMatch(/qualification|canary|disabled/i);
    }
    for (const definition of capabilityDefinitions.filter(definition => definition.id.startsWith("graph.package.read."))) {
      expect(definition.probe.description).toMatch(/Response-size\/time-bounded.*first-page.*documented filter.*without following pagination/);
    }
  });

  it("uses conservative status precedence", () => {
    expect(resolveCapabilityStatus(["available", "missing_license"])).toBe("missing_license");
    expect(resolveCapabilityStatus(["provider_error", "missing_internal_role"])).toBe("missing_internal_role");
    expect(resolveCapabilityStatus([])).toBe("unknown");
  });
});