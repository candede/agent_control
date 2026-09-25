import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityStatus, CapabilityView } from "./api/client";
import { capabilityExplanation, capabilityNextStep, capabilityStatusLabel, currentVerification, evidenceIsFresh, evidenceIsStale, providerActionAllowed, operationAccessLabel, statusLabels, verificationLabel } from "./capabilityState";

function view(status: CapabilityStatus): CapabilityView {
  return { definition: capabilityDefinitions[0], decision: { capabilityId: capabilityDefinitions[0].id, status, authorized: status === "available", fresh: true, verification: "provider", checkedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), previewQualification: "not_required", remediation: [] } };
}

const onDemandIds = capabilityDefinitions.filter(definition => definition.probe.kind === "on_demand").map(definition => definition.id);

describe("capability UX decisions", () => {
  it.each(["interaction_required", "authorization_expired"])("keeps application %s recovery separate from user sign-in", category => {
    const application = view("unknown");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision.capabilityId = application.definition.id;
    application.decision.evidence = { category };
    expect(capabilityExplanation(application)).toMatch(/administrator.*credentials/i);
    expect(capabilityExplanation(application)).not.toMatch(/Sign in again|reauthorize this delegated/);
    expect(capabilityNextStep(application)).toMatchObject({ label: "Admin setup", href: "https://entra.microsoft.com/" });
    expect(capabilityNextStep(application)?.text).toMatch(/application.*permissions/i);
  });

  function onDemandView(id: CapabilityId): CapabilityView {
    return {
      definition: capabilityDefinitions.find(definition => definition.id === id)!,
      decision: {
        capabilityId: id, status: "available", authorized: true, fresh: true, verification: "on_demand",
        previewQualification: "not_required", remediation: [],
      },
    };
  }

  it.each(["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const)(
    "allows on-demand %s without claiming token, provider, or qualification evidence", id => {
      const ready = onDemandView(id);
      expect(providerActionAllowed(ready)).toBe(true);
      expect(providerActionAllowed(ready, true)).toBe(true);
      expect(currentVerification(ready)).toBe("on_demand");
      expect(evidenceIsFresh(ready)).toBe(false);
      expect(evidenceIsStale(ready)).toBe(false);
      expect(capabilityStatusLabel(ready)).toBe("Ready to try");
      expect(verificationLabel(ready)).toBe("Ready to try; Microsoft validates permission on the actual operation");
      expect(operationAccessLabel(ready)).toBe("Microsoft validates permission when the operation is requested");
      expect(capabilityExplanation(ready)).toContain("Microsoft validates delegated permissions and provider roles on the actual operation");
      expect(capabilityExplanation(ready)).toContain("Review and confirm the exact targets");
      expect(capabilityNextStep(ready)?.text).toContain(id === "powerPlatform.quarantine.manage" ? "Microsoft validates permission on each operation" : "CopilotPackages.ReadWrite.All");
      expect(capabilityNextStep(ready)?.href).toBe("/agents");
    },
  );
  it.each(["graph.licenses.read", "reports.copilotUsage.read"] as const)(
    "recognizes registered on-demand read readiness for %s without write instructions", id => {
      const ready = onDemandView(id);
      expect(providerActionAllowed(ready)).toBe(true);
      expect(currentVerification(ready)).toBe("on_demand");
      expect(evidenceIsFresh(ready)).toBe(false);
      expect(evidenceIsStale(ready)).toBe(false);
      expect(capabilityStatusLabel(ready)).toBe("Ready to try");
      expect(verificationLabel(ready)).toBe("Ready to try; Microsoft validates permission on the actual operation");
      expect(operationAccessLabel(ready)).toBe("Microsoft validates permission when the operation is requested");
      expect(capabilityExplanation(ready)).toContain("Microsoft validates delegated permissions and provider roles on the actual operation");
      expect(capabilityExplanation(ready)).not.toMatch(/confirm|submitting a change|Not checked|provider request succeeded/);
      expect(capabilityNextStep(ready)).toBeUndefined();
    },
  );
  it.each([
    { fresh: false },
    { authorized: false },
    { status: "missing_internal_role" },
    { status: "preview_disabled" },
    { verification: undefined },
    { verification: "local" },
    { verification: "token" },
    { verification: "provider" },
    { verification: "qualification" },
    { previewQualification: "unqualified" },
    { previewQualification: "qualified" },
    { checkedAt: new Date(0).toISOString() },
    { expiresAt: new Date(0).toISOString() },
    { lastSuccessAt: new Date(0).toISOString() },
    { capabilityId: "graph.package.read.delegated" },
  ] satisfies Partial<CapabilityView["decision"]>[])("rejects inconsistent on-demand decisions: %j", override => {
    for (const id of onDemandIds) {
      const ready = onDemandView(id);
      Object.assign(ready.decision, override);
      expect(providerActionAllowed(ready, true)).toBe(false);
      expect(currentVerification(ready)).toBeUndefined();
      expect(capabilityNextStep(ready)).toBeUndefined();
    }
  });
  it("does not extend on-demand readiness to other probe kinds or modes", () => {
    for (const definition of capabilityDefinitions.filter(definition => definition.probe.kind !== "on_demand")) {
      const forged = onDemandView(definition.id);
      expect(providerActionAllowed(forged, true)).toBe(false);
      expect(currentVerification(forged)).toBeUndefined();
    }
    const unregistered = onDemandView("graph.package.block.manage");
    unregistered.definition = { ...unregistered.definition, probe: { ...unregistered.definition.probe, adapterRegistered: false } };
    expect(providerActionAllowed(unregistered, true)).toBe(false);
    expect(currentVerification(unregistered)).toBeUndefined();
    const wrongProbe = onDemandView("graph.package.block.manage");
    wrongProbe.definition = { ...wrongProbe.definition, probe: { ...wrongProbe.definition.probe, kind: "provider_read" } };
    expect(providerActionAllowed(wrongProbe, true)).toBe(false);
    expect(currentVerification(wrongProbe)).toBeUndefined();
    for (const mode of ["application", "local"] as const) {
      const wrongMode = onDemandView("graph.package.block.manage");
      wrongMode.definition = { ...wrongMode.definition, mode };
      expect(providerActionAllowed(wrongMode, true)).toBe(false);
      expect(currentVerification(wrongMode)).toBeUndefined();
    }
  });
  it.each(Object.keys(statusLabels) as CapabilityStatus[])("fails closed for %s", status => {
    expect(providerActionAllowed(view(status))).toBe(status === "available");
    expect(capabilityExplanation(view(status))).not.toBe("");
  });
  it.each([undefined, false, true])("does not treat delegated diagnostic expiry as revoked access with write=%s", write => {
    const available = view("available");
    available.decision.checkedAt = "2026-09-12T09:00:00.000Z";
    available.decision.expiresAt = "2026-09-12T09:01:00.000Z";
    const expiresAt = Date.parse(available.decision.expiresAt);

    expect(providerActionAllowed(available, write, expiresAt - 1)).toBe(true);
    expect(providerActionAllowed(available, write, expiresAt)).toBe(true);
    expect(providerActionAllowed(available, write, expiresAt + 1)).toBe(true);
    expect(evidenceIsFresh(available, expiresAt)).toBe(false);
  });
  it.each([undefined, "invalid", "2026-09-12T09:00:01.000Z"])(
    "rejects evidence without a valid check at or before the current clock: %s", checkedAt => {
      const now = Date.parse("2026-09-12T09:00:00.000Z");
      const candidate = view("available");
      candidate.decision = {
        ...candidate.decision, checkedAt, expiresAt: "2026-09-12T09:01:00.000Z",
        lastSuccessAt: "2026-09-12T08:59:00.000Z",
      };
      for (const verification of ["provider", "token", undefined] as const) {
        candidate.decision.verification = verification;
        expect(evidenceIsFresh(candidate, now)).toBe(false);
        expect(currentVerification(candidate, now)).toBeUndefined();
        expect(capabilityStatusLabel(candidate, now)).not.toMatch(/^(Available|Ready to try)$/);
        for (const write of [undefined, false, true]) {
          expect(providerActionAllowed(candidate, write, now)).toBe(false);
        }
      }
    },
  );
  it("expires verification claims without disabling an attempt using known delegated access", () => {
    const now = Date.parse("2026-09-12T09:00:00.000Z");
    const candidate = view("available");
    candidate.decision.checkedAt = new Date(now).toISOString();
    candidate.decision.expiresAt = new Date(now + 1).toISOString();
    expect(evidenceIsFresh(candidate, now)).toBe(true);
    expect(currentVerification(candidate, now)).toBe("provider");
    expect(providerActionAllowed(candidate, false, now)).toBe(true);
    expect(evidenceIsFresh(candidate, now + 1)).toBe(false);
    expect(currentVerification(candidate, now + 1)).toBeUndefined();
    expect(providerActionAllowed(candidate, false, now + 1)).toBe(true);
  });
  it("retains application-scope expiry requirements and rejects malformed or denied delegated decisions", () => {
    const candidate = view("available");
    const now = Date.now();
    candidate.decision.expiresAt = new Date(now - 1).toISOString();
    expect(providerActionAllowed(candidate, false, now)).toBe(true);
    candidate.definition = capabilityDefinitions.find(item => item.id === "graph.package.read.application")!;
    candidate.decision.capabilityId = candidate.definition.id;
    expect(providerActionAllowed(candidate, false, now)).toBe(false);
    candidate.definition = capabilityDefinitions[0];
    candidate.decision.capabilityId = candidate.definition.id;
    candidate.decision.expiresAt = candidate.decision.checkedAt;
    expect(providerActionAllowed(candidate, false, now)).toBe(false);
    candidate.decision.expiresAt = new Date(now - 1).toISOString();
    candidate.decision.authorized = false;
    expect(providerActionAllowed(candidate, false, now)).toBe(false);
    candidate.decision.authorized = true;
    candidate.decision.status = "missing_permission";
    expect(providerActionAllowed(candidate, false, now)).toBe(false);
  });
  it.each([
    { id: "graph.package.read.delegated", verification: "provider" },
    { id: "graph.package.read.delegated", verification: undefined },
    { id: "graph.package.read.application", verification: "provider" },
    { id: "graph.package.block.manage", verification: "token" },
    { id: "purview.audit.search.delegated", verification: "token" },
    { id: "reports.official.import", verification: "local" },
  ] satisfies { id: CapabilityId; verification: CapabilityView["decision"]["verification"] }[])(
    "does not use another capability's $verification decision for $id", ({ id, verification }) => {
      const candidate = view("available");
      candidate.definition = capabilityDefinitions.find(definition => definition.id === id)!;
      candidate.decision = { ...candidate.decision, capabilityId: id, verification };
      if (candidate.definition.mode === "local") {
        candidate.decision.fresh = false;
        candidate.decision.checkedAt = undefined;
        candidate.decision.expiresAt = undefined;
      }
      expect(providerActionAllowed(candidate)).toBe(true);
      expect(currentVerification(candidate)).toBe(verification);

      candidate.decision.capabilityId = "graph.directory.read";
      for (const write of [undefined, false, true]) {
        expect(providerActionAllowed(candidate, write)).toBe(false);
      }
      expect(currentVerification(candidate)).toBeUndefined();
      expect(capabilityStatusLabel(candidate)).toBe("Verification unavailable");
      expect(verificationLabel(candidate)).not.toMatch(/Provider-verified|Token acquired|Authorized by local policy/);
      expect(capabilityExplanation(candidate)).not.toMatch(/Token acquired|request succeeded|Authorized by current local/);
      expect(capabilityNextStep(candidate)).toBeUndefined();
    },
  );
  it("names backend permissions and independent roles exactly", () => {
    expect(capabilityExplanation(view("missing_permission"))).toContain("delegated CopilotPackages.Read.All");
    expect(capabilityExplanation(view("missing_internal_role"))).toContain("AgentControl.Viewer");
  });
  it("provides stale-evidence recovery without claiming an automatic check is pending", () => {
    for (const status of ["available", "unknown"] as const) {
      const stale = view(status);
      stale.decision.expiresAt = new Date(Date.now() - 1).toISOString();
      stale.decision.fresh = false;
      expect(capabilityExplanation(stale)).toContain("Check status");
      expect(capabilityExplanation(stale)).toContain("authorized saved data remains readable");
      expect(capabilityExplanation(stale)).not.toContain("pending");
      expect(providerActionAllowed(stale)).toBe(status === "available");
    }
  });
  it.each(["token_acquisition", "provider_read"] as const)("identifies a %s timeout instead of implying a permission failure", phase => {
    const failed = view("provider_error");
    failed.decision.evidence = { category: "provider_timeout", phase, timeoutMs: 30_000 };
    expect(capabilityStatusLabel(failed)).toBe("Check timed out");
    expect(capabilityExplanation(failed)).toContain(phase === "token_acquisition" ? "Microsoft token acquisition" : "bounded provider check");
    expect(capabilityExplanation(failed)).toContain("30 seconds");
    expect(capabilityExplanation(failed)).toContain("does not establish missing permissions");
    expect(providerActionAllowed(failed)).toBe(false);
  });
  it.each([
    { expiresAt: new Date(0).toISOString() },
    { expiresAt: undefined },
    { expiresAt: "invalid" },
    { fresh: false },
  ] satisfies Partial<CapabilityView["decision"]>[])("does not promote stale read evidence: %j", override => {
    const stale = view("available");
    Object.assign(stale.decision, override);
    expect(providerActionAllowed(stale)).toBe(false);
    expect(capabilityExplanation(stale)).toContain("saved data remains readable");
  });
  it.each(Object.keys(statusLabels).filter(status => status !== "available") as CapabilityStatus[])(
    "does not let on-demand readiness override %s", status => {
      for (const id of onDemandIds) {
        const unavailable = onDemandView(id);
        unavailable.decision.status = status;
        expect(providerActionAllowed(unavailable, true)).toBe(false);
        expect(currentVerification(unavailable)).toBeUndefined();
        expect(capabilityStatusLabel(unavailable)).toBe(statusLabels[status]);
        if (status === "missing_permission") expect(capabilityNextStep(unavailable)).toMatchObject({ label: "Admin setup", href: "https://entra.microsoft.com/" });
        else expect(capabilityNextStep(unavailable)).toBeUndefined();
      }
    },
  );
  it("does not overstate token-only authorization", () => {
    const tokenOnly = view("available");
    tokenOnly.decision.verification = "token";
    expect(capabilityExplanation(tokenOnly)).toContain("Ready to try");
    expect(capabilityExplanation(tokenOnly)).toContain("have not been verified");
    expect(capabilityExplanation(view("available"))).toContain("bounded provider request succeeded");
  });
  it("tolerates omitted verification without claiming provider proof", () => {
    const unclassified = view("available");
    unclassified.decision.verification = undefined;

    expect(providerActionAllowed(unclassified)).toBe(true);
    expect(capabilityExplanation(unclassified)).toContain("verification level was not reported");
  });
  it.each(["not_required", "unqualified", "qualified"] as const)(
    "does not require a separate write qualification for current authorization: %s", previewQualification => {
      for (const id of ["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const) {
        const authorized = view("available");
        authorized.definition = capabilityDefinitions.find(definition => definition.id === id)!;
        authorized.decision = { ...authorized.decision, capabilityId: id, previewQualification };

        for (const verification of ["provider", "token"] as const) {
          authorized.decision.verification = verification;
          expect(evidenceIsFresh(authorized)).toBe(true);
          expect(providerActionAllowed(authorized, true)).toBe(true);
          expect(currentVerification(authorized)).toBe(verification);
          expect(operationAccessLabel(authorized)).toBe("Microsoft validates permission when the operation is requested");
        }
        authorized.decision.expiresAt = new Date(0).toISOString();
        expect(providerActionAllowed(authorized, true)).toBe(false);
        expect(currentVerification(authorized)).toBeUndefined();
      }
    },
  );
  it("uses evidence categories for interactive authorization states", () => {
    const interaction = view("unknown");
    interaction.decision.evidence = { category: "interaction_required" };
    expect(capabilityExplanation(interaction)).toContain("Sign in again for MFA or Conditional Access");

    const expired = view("unknown");
    expired.decision.evidence = { category: "authorization_expired" };
    expect(capabilityExplanation(expired)).toContain("Sign in again");
  });
  it("keeps unregistered package reassignment disabled regardless of historical qualification", () => {
    const definition = capabilityDefinitions.find(item => item.id === "graph.package.reassign.manage")!;
    const unsupported = view("available");
    unsupported.definition = definition;
    unsupported.decision = {
      ...unsupported.decision,
      capabilityId: definition.id,
      previewQualification: "qualified",
    };

    expect(providerActionAllowed(unsupported, true)).toBe(false);
    expect(currentVerification(unsupported)).toBeUndefined();
    expect(capabilityStatusLabel(unsupported)).toBe("Verification unavailable");
    expect(verificationLabel(unsupported)).toBe("Current verification unavailable");
    expect(capabilityExplanation(unsupported)).not.toContain("provider request succeeded");
    expect(capabilityNextStep(unsupported)).toBeUndefined();
    unsupported.decision.status = "not_configured";
    unsupported.decision.authorized = false;
    expect(currentVerification(unsupported)).toBeUndefined();
    expect(capabilityStatusLabel(unsupported)).toBe("Not configured");
  });
  it.each(Object.keys(statusLabels).filter(status => status !== "available") as CapabilityStatus[])(
    "does not turn %s provenance or historical success into current verification", status => {
      for (const verification of ["provider", "token", "local", "qualification", "on_demand"] as const) {
        const failed = view(status);
        failed.decision.verification = verification;
        failed.decision.lastSuccessAt = new Date(Date.now() - 30_000).toISOString();
        expect(currentVerification(failed)).toBeUndefined();
        expect(verificationLabel(failed)).not.toMatch(/Provider-verified|Token acquired|Current independent/);
        expect(evidenceIsStale(failed)).toBe(false);
      }
    },
  );
  it.each(["unchecked", "expired", "not-fresh", "unauthorized", "future-check", "invalid-check", "invalid-expiry", "disabled"] as const)(
    "does not claim current success for %s evidence", scenario => {
      const candidate = view("available");
      if (scenario === "unchecked") candidate.decision.checkedAt = undefined;
      if (scenario === "expired") candidate.decision.expiresAt = new Date(0).toISOString();
      if (scenario === "not-fresh") candidate.decision.fresh = false;
      if (scenario === "unauthorized") candidate.decision.authorized = false;
      if (scenario === "future-check") candidate.decision.checkedAt = new Date(Date.now() + 30_000).toISOString();
      if (scenario === "invalid-check") candidate.decision.checkedAt = "invalid";
      if (scenario === "invalid-expiry") candidate.decision.expiresAt = "invalid";
      if (scenario === "disabled") {
        candidate.definition = capabilityDefinitions.find(item => item.id === "graph.package.read.application")!;
        candidate.enabled = false;
        expect(providerActionAllowed(candidate)).toBe(false);
      }
      for (const verification of ["provider", "token", "qualification"] as const) {
        candidate.decision.verification = verification;
        expect(currentVerification(candidate)).toBeUndefined();
        expect(verificationLabel(candidate)).not.toMatch(/Provider-verified|Token acquired|Current independent/);
        expect(capabilityStatusLabel(candidate)).not.toMatch(/^(Available|Ready to try)$/);
        expect(capabilityExplanation(candidate)).not.toMatch(/Token acquired|request succeeded|qualification is valid/);
      }
    },
  );
  it("distinguishes local policy from provider checks and local authorization failures", () => {
    const local = view("available");
    local.definition = capabilityDefinitions.find(item => item.mode === "local")!;
    local.decision = { ...local.decision, capabilityId: local.definition.id, verification: "local", checkedAt: undefined, expiresAt: undefined };
    expect(currentVerification(local)).toBe("local");
    expect(verificationLabel(local)).toBe("Authorized by local policy; no provider check");
    local.decision.status = "missing_internal_role";
    local.decision.authorized = false;
    expect(currentVerification(local)).toBeUndefined();
    expect(verificationLabel(local)).toBe("Local policy authorization not established");
  });
  it("does not call a fresh failed check stale", () => {
    const inconclusive = view("unknown");
    expect(capabilityExplanation(inconclusive)).toContain("check did not establish availability");
    expect(capabilityExplanation(inconclusive)).not.toContain("stale");
    inconclusive.decision.checkedAt = undefined;
    expect(verificationLabel(inconclusive)).toBe("Not checked; no current verification");
  });
  it("does not treat quarantine status token readiness as provider verification", () => {
    const quarantine = view("available");
    quarantine.definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.read")!;
    quarantine.decision.capabilityId = quarantine.definition.id;
    quarantine.decision.verification = "token";
    expect(currentVerification(quarantine)).toBe("token");
    expect(capabilityExplanation(quarantine)).toContain("provider role, license, and operation access have not been verified");
    expect(operationAccessLabel(quarantine)).toBe("No separate operation check");
    expect(capabilityNextStep(quarantine)?.text).toContain("Microsoft validates permission on each operation");
  });
  it("does not label legacy qualification provenance as current provider verification", () => {
    const qualified = view("available");
    qualified.definition = capabilityDefinitions.find(item => item.id === "graph.package.block.manage")!;
    qualified.decision.capabilityId = qualified.definition.id;
    qualified.decision.previewQualification = "qualified";
    qualified.decision.verification = "qualification";
    expect(currentVerification(qualified)).toBeUndefined();
    expect(verificationLabel(qualified)).toBe("Current verification unavailable");
    expect(capabilityStatusLabel(qualified)).toBe("Verification unavailable");
    expect(capabilityExplanation(qualified)).toContain("current verification evidence is missing or inconsistent");
    expect(operationAccessLabel(qualified)).toBe("Microsoft validates permission when the operation is requested");
    qualified.decision.status = "provider_error";
    qualified.decision.authorized = false;
    expect(providerActionAllowed(qualified, true)).toBe(false);
    expect(currentVerification(qualified)).toBeUndefined();
    expect(evidenceIsStale(qualified)).toBe(false);
  });
  it("does not mistake expired legacy qualification evidence for on-demand readiness", () => {
    const qualified = view("available");
    qualified.definition = capabilityDefinitions.find(item => item.id === "graph.package.block.manage")!;
    qualified.decision.capabilityId = qualified.definition.id;
    qualified.decision.previewQualification = "qualified";
    qualified.decision.verification = "qualification";
    qualified.decision.expiresAt = new Date(0).toISOString();
    expect(capabilityStatusLabel(qualified)).toBe("Evidence stale");
    expect(capabilityExplanation(qualified)).toContain("Evidence is stale");
    expect(currentVerification(qualified)).toBeUndefined();
    expect(providerActionAllowed(qualified, true)).toBe(false);
  });
  it("distinguishes token readiness from a successful bounded provider operation", () => {
    const operation = view("available");
    operation.definition = capabilityDefinitions.find(item => item.id === "defender.hunting.delegated")!;
    operation.decision.capabilityId = operation.definition.id;
    operation.decision.verification = "token";
    expect(operationAccessLabel(operation)).toBe("Provider access is checked by an explicit bounded operation; no separate pre-approval required");
    operation.decision.verification = "provider";
    expect(operationAccessLabel(operation)).toBe("Bounded provider operation succeeded");
    operation.decision.status = "preview_disabled";
    operation.decision.authorized = false;
    expect(capabilityExplanation(operation)).toContain("explicit bounded operation; no separate pre-approval required");
    expect(capabilityExplanation(operation)).not.toContain("writes");
  });
  it.each(["purview.audit.search.application", "defender.hunting.application"])(
    "does not promise automatic operation qualification for %s", capabilityId => {
      const application = view("unknown");
      application.definition = capabilityDefinitions.find(item => item.id === capabilityId)!;
      application.decision.checkedAt = undefined;
      expect(operationAccessLabel(application)).toBe("Requires an explicitly approved bounded application-scope operation");
      expect(capabilityExplanation(application)).toContain("An Admin must explicitly approve");
      expect(capabilityExplanation(application)).toContain("automatic refresh does not run it");
      application.decision.checkedAt = new Date(0).toISOString();
      application.decision.expiresAt = new Date(0).toISOString();
      expect(capabilityExplanation(application)).toContain("evidence is stale");
      expect(capabilityExplanation(application)).toContain("explicitly approve a new bounded application-scope operation");
    },
  );
  it.each([
    "graph.package.read.application", "purview.audit.search.application", "defender.hunting.application",
    "graph.licenses.read", "reports.copilotUsage.read",
  ] as const)("never directs excluded capability %s to automatic checks for recovery", id => {
    const candidate = view("unknown");
    candidate.definition = capabilityDefinitions.find(definition => definition.id === id)!;
    candidate.decision.capabilityId = id;
    candidate.decision.checkedAt = undefined;
    expect(capabilityExplanation(candidate)).not.toMatch(/Automatic safe checks run/);
    expect(capabilityExplanation(candidate)).toMatch(/application-scope|read from the dashboard/);

    candidate.decision.checkedAt = new Date(0).toISOString();
    candidate.decision.expiresAt = new Date(0).toISOString();
    for (const status of ["unknown", "available"] as const) {
      candidate.decision.status = status;
      candidate.decision.authorized = status === "available";
      expect(capabilityExplanation(candidate)).not.toMatch(/use Check status to retry/i);
      expect(capabilityExplanation(candidate)).toMatch(/application-scope|read from the dashboard/);
    }

    candidate.decision.status = "provider_error";
    candidate.decision.authorized = false;
    for (const category of ["provider_timeout", "provider_network_error"]) {
      candidate.decision.evidence = { category, phase: "provider_read", timeoutMs: 30_000 };
      expect(capabilityExplanation(candidate)).not.toMatch(/use Check status to retry/i);
      expect(capabilityExplanation(candidate)).toMatch(/application-scope|read from the dashboard/);
    }
  });
});