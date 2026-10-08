// @vitest-environment node
import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityStatus, CapabilityView } from "./api/client";
import { providerActionAllowed } from "./capabilityState";
import { isTransientPermissionCheck, permissionIssue, permissionIssues } from "./permissionIssues";

const now = Date.parse("2026-09-24T00:00:00Z");
function fixture(status: CapabilityStatus = "missing_permission", id: CapabilityId = "graph.package.read.delegated"): CapabilityView {
  return {
    definition: capabilityDefinitions.find(definition => definition.id === id)!,
    decision: {
      capabilityId: id, status, authorized: status === "available", fresh: true,
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
    expect(permissionIssue({ ...view, configuration: { enabled: false, sharedDataScope: false, revision: 1 } }, now)).toBeUndefined();
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
  it.each(["interaction_required", "authorization_expired"])("routes app-only %s checks and operation failures to administrator recovery", category => {
    const view = fixture("unknown");
    view.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    view.decision.capabilityId = view.definition.id;
    view.decision.evidence = { category };
    for (const operation of [false, true]) {
      if (operation) {
        view.operationFailure = { status: "unknown", checkedAt: view.decision.checkedAt!, expiresAt: view.decision.expiresAt!,
          evidence: { category }, remediation: [] };
        view.decision = { ...view.decision, status: "available", authorized: true, evidence: undefined };
      }
      const issue = permissionIssue(view, now);
      expect(issue?.action).toEqual({ label: "Admin setup", href: "https://entra.microsoft.com/" });
      expect(issue?.message).toMatch(/administrator.*application/i);
      expect(issue?.message).not.toMatch(/sign in/i);
    }
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
    const denied = fixture("missing_permission", "graph.directory.read");
    expect(isTransientPermissionCheck(timeout, now)).toBe(true);
    expect(permissionIssues([timeout, denied], now, true).map(issue => issue.view.definition.id)).toEqual([denied.definition.id]);
    expect(permissionIssues([timeout, denied], now, false).map(issue => issue.view.definition.id))
      .toEqual([timeout.definition.id, denied.definition.id]);
  });
  it.each([
    { fresh: false },
    { checkedAt: undefined },
    { checkedAt: "invalid" },
    { checkedAt: new Date(now + 1).toISOString() },
    { expiresAt: undefined },
    { expiresAt: "invalid" },
    { expiresAt: new Date(now).toISOString() },
  ] satisfies Partial<CapabilityView["decision"]>[])("does not request failed-check retries from stale or invalid evidence: %j", override => {
    const timeout = fixture("provider_error");
    timeout.decision = { ...timeout.decision, evidence: { category: "provider_timeout" }, ...override };
    expect(isTransientPermissionCheck(timeout, now)).toBe(false);
    expect(permissionIssues([timeout], now)).toEqual([]);
  });
  it("reports one issue per capability when both a check and an operation failed", () => {
    const view = fixture("missing_permission");
    view.operationFailure = { status: "missing_role", checkedAt: new Date(now - 500).toISOString(),
      expiresAt: new Date(now + 1000).toISOString(), remediation: [] };
    const before = structuredClone(view);
    expect(permissionIssues([view], now).map(issue => issue.decision.status)).toEqual(["missing_role"]);
    expect(permissionIssues([view], now + 1000).map(issue => issue.decision.status)).toEqual(["missing_permission"]);
    expect(view).toEqual(before);
  });
  it.each(["provider_timeout", "provider_network_error", "provider_throttled"])("does not label %s as a missing permission", category => {
    const view = fixture("provider_error");
    view.decision.evidence = { category };
    expect(permissionIssue(view, now)?.message).not.toMatch(/permission|license|consent/i);
  });
});
