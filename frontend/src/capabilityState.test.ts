import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityStatus, CapabilityView } from "./api/client";
import { capabilityExplanation, providerActionAllowed, statusLabels } from "./capabilityState";

function view(status: CapabilityStatus): CapabilityView {
  return { definition: capabilityDefinitions[0], decision: { capabilityId: capabilityDefinitions[0].id, status, authorized: status === "available", fresh: true, expiresAt: new Date(Date.now() + 60000).toISOString(), previewQualification: "not_required", remediation: [] } };
}

describe("capability UX decisions", () => {
  it.each(Object.keys(statusLabels) as CapabilityStatus[])("fails closed for %s", status => {
    expect(providerActionAllowed(view(status))).toBe(status === "available");
    expect(capabilityExplanation(view(status))).not.toBe("");
  });
  it("names backend permissions and independent roles exactly", () => {
    expect(capabilityExplanation(view("missing_permission"))).toContain("delegated CopilotPackages.Read.All");
    expect(capabilityExplanation(view("missing_internal_role"))).toContain("AgentControl.Reader or AgentControl.Operator");
  });
  it("does not promote expired reads or unqualified writes", () => {
    const stale = view("available");
    stale.decision.expiresAt = new Date(0).toISOString();
    expect(providerActionAllowed(stale)).toBe(false);
    expect(capabilityExplanation(stale)).toContain("saved data remains readable");
    const unqualified = view("available"); unqualified.decision.previewQualification = "unqualified";
    expect(providerActionAllowed(unqualified, true)).toBe(false);
  });
  it("names the operation-specific package access concurrency boundary", () => {
    const accessDefinition = capabilityDefinitions.find(definition => definition.id === "graph.package.access.manage")!;
    const access = view("preview_disabled");
    access.definition = accessDefinition;
    access.decision.capabilityId = accessDefinition.id;
    expect(capabilityExplanation(access)).toContain("no If-Match or equivalent lost-update protection");
  });
});