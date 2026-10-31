import { describe, expect, it } from "vitest";
import { appRoles, capabilityIds, hasAppRole, supportsAutomaticCapabilityCheck } from "../types/capability.js";
import { capabilityDefinitions, hasAnyRole } from "./capabilityRegistry.js";
import { capabilityContractRevision, capabilityPermissionRevision } from "../db/capabilities.js";

describe("capability registry", () => {
  it("defines every retained capability exactly once with source-linked requirements", () => {
    expect(capabilityDefinitions.map(definition => definition.id)).toEqual(capabilityIds);
    expect(new Set(capabilityDefinitions.map(definition => definition.id)).size).toBe(18);
    for (const definition of capabilityDefinitions) {
      expect(definition.sources, definition.id).not.toHaveLength(0);
      expect(definition.sources.every(source => source.startsWith("https://learn.microsoft.com/"))).toBe(true);
      expect(definition.internalRoles, definition.id).not.toHaveLength(0);
      expect(definition.internalRoles.every(role => appRoles.includes(role))).toBe(true);
      expect(definition.probe.adapterRegistered || definition.probe.kind === "not_registered").toBe(true);
      expect(definition).not.toHaveProperty("consentOnSignIn");
    }
  });

  it("gives Uploaders Viewer access and keeps administrative authority separate", () => {
    expect(appRoles).toEqual(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"]);
    expect(hasAppRole(["AgentControl.Admin"], "AgentControl.Viewer")).toBe(true);
    expect(hasAnyRole(["AgentControl.Admin"], ["AgentControl.Viewer"])).toBe(true);
    expect(hasAppRole(["AgentControl.Viewer"], "AgentControl.Admin")).toBe(false);
    expect(hasAppRole(["AgentControl.UsageReportUploader"], "AgentControl.Viewer")).toBe(true);
    expect(hasAppRole(["AgentControl.UsageReportUploader"], "AgentControl.Admin")).toBe(false);
    expect(hasAppRole(["AgentControl.Viewer"], "AgentControl.UsageReportUploader")).toBe(false);
    expect(hasAppRole(["AgentControl.Admin"], "AgentControl.UsageReportUploader")).toBe(true);
    expect(hasAnyRole([], ["AgentControl.Viewer"])).toBe(false);
  });

  it("keeps application mode, preview writes, and local policy explicit", () => {
    expect(capabilityDefinitions.filter(definition => definition.mode === "application")).toHaveLength(6);
    expect(capabilityDefinitions.filter(definition => definition.probe.kind === "on_demand").map(definition => definition.id)).toEqual([
      "graph.package.read.delegated", "graph.package.access.manage", "graph.package.block.manage", "graph.directory.read", "graph.users.read", "graph.agentIdentity.read", "graph.licenses.read", "powerPlatform.quarantine.manage",
      "purview.audit.search.delegated", "purview.audit.search.application", "defender.hunting.delegated", "defender.hunting.application",
      "reports.copilotUsage.read",
    ]);
    expect(capabilityDefinitions.find(definition => definition.id === "reports.official.import")).toMatchObject({
      displayName: "Import reports",
      purpose: expect.stringContaining("new Microsoft 365 usage CSV report sets"),
      mode: "local", permissions: [], internalRoles: ["AgentControl.UsageReportUploader"],
      probe: { kind: "local_policy" },
    });
    expect(JSON.stringify(capabilityDefinitions)).not.toMatch(/Phase\s*0?5|owning.*phase/i);
    for (const definition of capabilityDefinitions.filter(definition => definition.probe.kind === "on_demand"
      && definition.mode === "delegated" && (definition.id.startsWith("graph.") || definition.id === "powerPlatform.quarantine.manage"))) {
      expect(definition.probe.description).toContain("Microsoft authorizes the delegated request when it runs.");
      expect(definition.configuration.join(" ")).not.toMatch(/qualification|canary|disabled/i);
    }
    expect(capabilityDefinitions.find(definition => definition.id === "reports.copilotUsage.read")).toMatchObject({
      permissions: ["Reports.Read.All"],
      mode: "application",
      dataClass: "licensed_usage",
      purpose: expect.stringContaining("does not replace the three agent-usage CSV reports"),
      probe: { description: expect.stringContaining("saved dashboard reads and background capability checks never scan the report") },
    });
    expect(capabilityDefinitions.find(definition => definition.id === "graph.directory.read")?.permissions).toEqual(["Group.Read.All"]);
    expect(capabilityDefinitions.find(definition => definition.id === "graph.licenses.read")?.permissions).toEqual(["User.Read.All", "LicenseAssignment.Read.All"]);
    for (const definition of capabilityDefinitions.filter(definition => definition.id === "graph.package.read.application")) {
      expect(definition.probe.description).toMatch(/Response-size\/time-bounded.*first-page.*documented filter.*without following pagination/);
    }
  });

  it("runs audit and hunting reads on demand with current Viewer authority", () => {
    for (const id of ["purview.audit.search.delegated", "purview.audit.search.application", "defender.hunting.delegated", "defender.hunting.application"] as const) {
      expect(capabilityDefinitions.find(definition => definition.id === id)).toMatchObject({
        internalRoles: ["AgentControl.Viewer"], probe: { kind: "on_demand", adapterRegistered: true },
      });
      expect(supportsAutomaticCapabilityCheck(id)).toBe(id.endsWith(".delegated"));
    }
  });

  it("declares only the narrow delegated agent identity permission without automatic target lookups", () => {
    expect(capabilityDefinitions.find(definition => definition.id === "graph.agentIdentity.read")).toMatchObject({
      permissions: ["AgentIdentity.Read.All"], mode: "delegated", internalRoles: ["AgentControl.Viewer"],
      consentGroup: "graph.agentIdentity.read", probe: { kind: "on_demand", adapterRegistered: true },
    });
    expect(capabilityDefinitions.find(definition => definition.id === "graph.agentIdentity.read")?.acceptedPermissions).toBeUndefined();
    expect(supportsAutomaticCapabilityCheck("graph.agentIdentity.read")).toBe(false);
  });

  it("preserves provider evidence revisions when retiring interactive-consent metadata", () => {
    const definition = capabilityDefinitions.find(value => value.id === "graph.agentIdentity.read")!;
    const previous = Object.assign({}, definition, { consentOnSignIn: false });
    expect(capabilityContractRevision(definition)).toBe(capabilityContractRevision(previous));
    expect(capabilityPermissionRevision(definition)).toBe(capabilityPermissionRevision(previous));
  });
});