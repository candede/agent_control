import { describe, expect, it } from "vitest";
import { appRoles, capabilityIds } from "../types/capability.js";
import { capabilityDefinitions, resolveCapabilityStatus } from "./capabilityRegistry.js";

describe("capability registry", () => {
  it("defines every retained capability exactly once with source-linked requirements", () => {
    expect(capabilityDefinitions.map(definition => definition.id)).toEqual(capabilityIds);
    expect(new Set(capabilityDefinitions.map(definition => definition.id)).size).toBe(13);
    for (const definition of capabilityDefinitions) {
      expect(definition.sources.every(source => source.startsWith("https://learn.microsoft.com/"))).toBe(true);
      expect(definition.internalRoles.every(role => appRoles.includes(role))).toBe(true);
      expect(definition.probe.adapterRegistered || definition.probe.kind === "not_registered").toBe(true);
    }
  });

  it("keeps application mode, preview writes, and local policy explicit", () => {
    expect(capabilityDefinitions.filter(definition => definition.mode === "application")).toHaveLength(3);
    expect(capabilityDefinitions.filter(definition => definition.probe.kind === "qualification_only").map(definition => definition.id)).toEqual([
      "graph.package.access.manage", "graph.package.block.manage",
    ]);
    expect(capabilityDefinitions.find(definition => definition.id === "reports.official.import")?.mode).toBe("local");
  });

  it("uses conservative status precedence", () => {
    expect(resolveCapabilityStatus(["available", "missing_license"])).toBe("missing_license");
    expect(resolveCapabilityStatus(["provider_error", "missing_internal_role"])).toBe("missing_internal_role");
    expect(resolveCapabilityStatus([])).toBe("unknown");
  });
});