import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityStatus, CapabilityView } from "./api/client";
import { providerActionAllowed } from "./capabilityState";
import { isTransientPermissionCheck, permissionIssue, permissionIssues } from "./permissionIssues";

const now = Date.parse("2026-09-24T00:00:00Z");
function fixture(status: CapabilityStatus = "missing_permission"): CapabilityView {
  return {
    definition: capabilityDefinitions[0],
    decision: {
      capabilityId: capabilityDefinitions[0].id, status, authorized: false, fresh: true,
      checkedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
      previewQualification: "not_required", remediation: [],
    },
  };
}

describe("actual permission issues", () => {
  it.each(["available", "unknown", "preview_disabled", "missing_internal_role"] as const)("does not turn %s into a problem", status => {
    expect(permissionIssue(fixture(status), now)).toBeUndefined();
  });
  it.each(["missing_permission", "missing_role", "missing_license", "not_configured", "unsupported", "provider_error"] as const)(
    "reports a fresh actual %s failure without relaxing authorization", status => {
      const view = fixture(status);
      const before = structuredClone(view);
      expect(permissionIssue(view, now)?.view).toEqual(view);
      expect(providerActionAllowed(view, false, now)).toBe(false);
      expect(view).toEqual(before);
    });
  it.each(["missing_permission", "missing_role", "missing_license", "not_configured", "unsupported", "provider_error"] as const)(
    "does not infer %s without an actual check", status => {
      const view = fixture(status);
      view.decision.checkedAt = undefined;
      expect(permissionIssue(view, now)).toBeUndefined();
    });
  it.each([undefined, "invalid", new Date(now + 1).toISOString()])("rejects an invalid/future check timestamp %s", checkedAt => {
    const view = fixture();
    view.decision.checkedAt = checkedAt;
    expect(permissionIssue(view, now)).toBeUndefined();
  });
  it.each([undefined, "invalid", new Date(now).toISOString()])("does not report expired failure evidence %s", expiresAt => {
    const view = fixture();
    view.decision.expiresAt = expiresAt;
    expect(permissionIssue(view, now)).toBeUndefined();
  });
  it("ignores stale, mismatched, local and unregistered decisions", () => {
    const view = fixture();
    expect(permissionIssue({ ...view, decision: { ...view.decision, fresh: false } }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, decision: { ...view.decision, capabilityId: "graph.directory.read" } }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, definition: { ...view.definition, mode: "local" } }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, definition: { ...view.definition, probe: { ...view.definition.probe, adapterRegistered: false } } }, now)).toBeUndefined();
  });
  it("omits disabled application modes and allows an actual enabled-mode failure", () => {
    const view = fixture();
    view.definition = capabilityDefinitions.find(definition => definition.id === "defender.hunting.application")!;
    view.decision.capabilityId = view.definition.id;
    expect(permissionIssue({ ...view, enabled: false }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, configuration: { enabled: false, sharedDataScope: false } }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, enabled: true }, now)?.name).toBe("App-only Defender logs");
  });
  it.each(["graph.licenses.read", "reports.copilotUsage.read"] as const)("keeps an unused or successfully admitted %s read silent and actionable", id => {
    const view = fixture("available");
    view.definition = capabilityDefinitions.find(definition => definition.id === id)!;
    view.decision = { capabilityId: id, status: "available", authorized: true, fresh: true, verification: "on_demand",
      previewQualification: "not_required", remediation: [] };
    expect(permissionIssue(view, now)).toBeUndefined();
    expect(providerActionAllowed(view, false, now)).toBe(true);
  });
  it.each(["interaction_required", "authorization_expired"])("reports actual %s as sign-in recovery, not a missing grant", category => {
    const view = fixture("unknown");
    view.decision.evidence = { category };
    const issue = permissionIssue(view, now);
    expect(issue?.action).toEqual({ label: "Sign in again", href: "/api/auth/login?returnTo=%2Fpermissions" });
    expect(issue?.message).not.toMatch(/permission|consent/);
  });
  it.each(["graph.licenses.read", "reports.copilotUsage.read", "graph.agentIdentity.read"] as const)(
    "reports a real %s operation failure separately from its admission decision and clears it on recovery", id => {
      const view = fixture("available");
      view.definition = capabilityDefinitions.find(definition => definition.id === id)!;
      view.decision = { capabilityId: id, status: "available", authorized: true, fresh: true, verification: "on_demand",
        previewQualification: "not_required", remediation: [] };
      view.operationFailure = { status: "missing_permission", checkedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(), evidence: { httpStatus: 403 }, remediation: ["Administrator setup is required."] };
      const before = structuredClone(view);
      const issue = permissionIssue(view, now);
      expect(issue?.decision.status).toBe("missing_permission");
      expect(issue?.decision.evidence?.httpStatus).toBe(403);
      expect(issue?.view).toBe(view);
      expect(providerActionAllowed(view, false, now)).toBe(true);
      expect(view).toEqual(before);
      expect(permissionIssue({ ...view, operationFailure: undefined }, now)).toBeUndefined();
    });
  it.each([
    ["checkedAt", "invalid"], ["checkedAt", new Date(now + 1).toISOString()],
    ["expiresAt", "invalid"], ["expiresAt", new Date(now).toISOString()],
  ] as const)("ignores operation failures with invalid %s %s", (field, value) => {
    const view = fixture("available");
    view.operationFailure = { status: "missing_license", checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(), remediation: [], [field]: value };
    expect(permissionIssue(view, now)).toBeUndefined();
  });
  it("keeps operation failures quiet for disabled, unregistered or no-longer-authorized capabilities", () => {
    const view = fixture("available");
    view.operationFailure = { status: "missing_role", checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(), remediation: [] };
    expect(permissionIssue({ ...view, definition: { ...view.definition, mode: "application" }, enabled: false }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, definition: { ...view.definition, probe: { ...view.definition.probe, adapterRegistered: false } } }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, decision: { ...view.decision, status: "missing_internal_role" } }, now)).toBeUndefined();
    expect(permissionIssue({ ...view, decision: { ...view.decision, capabilityId: "graph.directory.read" } }, now)).toBeUndefined();
  });
  it("retains a real operation denial while confirming an unrelated cached timeout", () => {
    const view = fixture("provider_error");
    view.decision.evidence = { category: "provider_timeout" };
    view.operationFailure = { status: "missing_permission", checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(), remediation: [] };
    expect(permissionIssues([view], now, true)[0]?.decision.status).toBe("missing_permission");
  });
  it("describes ambiguous operation denials without inventing a missing grant", () => {
    const view = fixture("available");
    view.operationFailure = { status: "provider_error", checkedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(), evidence: { httpStatus: 403 }, remediation: [] };
    expect(permissionIssue(view, now)?.message).toBe("Microsoft denied this operation. Review the details.");
  });
  it("suppresses only transient cached checks during initial confirmation", () => {
    const timeout = fixture("provider_error");
    timeout.decision.evidence = { category: "provider_timeout" };
    expect(isTransientPermissionCheck(timeout)).toBe(true);
    expect(permissionIssues([timeout, fixture("missing_permission")], now, true)).toHaveLength(1);
    expect(permissionIssues([timeout, fixture("missing_permission")], now, false)).toHaveLength(2);
  });
  it.each(["provider_timeout", "provider_network_error", "provider_throttled"])("does not label %s as a missing permission", category => {
    const view = fixture("provider_error");
    view.decision.evidence = { category };
    expect(permissionIssue(view, now)?.message).not.toMatch(/permission|license|consent/i);
  });
});
