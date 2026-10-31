// @vitest-environment node
import { describe, expect, it } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityStatus, CapabilityView } from "./api/client";
import { capabilityExplanation, currentOperationFailure, currentVerification, evidenceIsFresh, evidenceIsStale, providerActionAllowed, queryReadAllowed, operationAccessLabel, statusLabels } from "./capabilityState";

function view(status: CapabilityStatus, id: CapabilityId = "graph.package.read.application"): CapabilityView {
  const definition = capabilityDefinitions.find(candidate => candidate.id === id)!;
  return { enabled: true, definition, decision: { capabilityId: id, status, authorized: status === "available", fresh: true, verification: "provider", checkedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), previewQualification: "not_required", remediation: [] } };
}

const onDemandIds = capabilityDefinitions.filter(definition => definition.probe.kind === "on_demand").map(definition => definition.id);

describe("capability UX decisions", () => {
  it.each(["purview.audit.search.delegated", "purview.audit.search.application", "defender.hunting.delegated", "defender.hunting.application"] as const)(
    "keeps %s retryable without admitting a disabled or unshared application", id => {
      const candidate = view("unknown");
      candidate.definition = capabilityDefinitions.find(definition => definition.id === id)!;
      candidate.decision.capabilityId = id;
      if (candidate.definition.mode === "application") candidate.configuration = { enabled: true, sharedDataScope: true, revision: 1 };
      for (const status of ["unknown", "provider_error", "missing_permission", "missing_role"] as const) {
        candidate.decision = { ...candidate.decision, status, authorized: false, fresh: false, expiresAt: new Date(0).toISOString() };
        expect(queryReadAllowed(candidate)).toBe(true);
      }
      candidate.enabled = false;
      expect(queryReadAllowed(candidate)).toBe(false);
      candidate.enabled = true;
      if (candidate.configuration) {
        candidate.configuration.sharedDataScope = false;
        expect(queryReadAllowed(candidate)).toBe(false);
      }
      candidate.definition = { ...candidate.definition, probe: { ...candidate.definition.probe, adapterRegistered: false } };
      expect(queryReadAllowed(candidate)).toBe(false);
    },
  );
  it("does not use query retry admission for mutation controls or absent capabilities", () => {
    const mutation = view("available");
    mutation.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.block.manage")!;
    expect(queryReadAllowed(mutation)).toBe(false);
    expect(queryReadAllowed(undefined)).toBe(false);
  });
  it("expires operation failures without mutating the admission decision", () => {
    const now = Date.now();
    const candidate = view("available");
    candidate.operationFailure = {
      status: "missing_permission", checkedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 1_000).toISOString(), remediation: [],
    };
    expect(currentOperationFailure(candidate, now)).toBe(candidate.operationFailure);
    expect(currentOperationFailure(candidate, now + 1_000)).toBeUndefined();
    expect(providerActionAllowed(candidate, false, now + 1_000)).toBe(true);
    expect(candidate.operationFailure.status).toBe("missing_permission");
  });

  it.each([
    { checkedAt: "invalid" }, { checkedAt: "2999-01-01T00:00:00Z" },
    { expiresAt: "invalid" }, { expiresAt: "1970-01-01T00:00:00Z" },
  ])("ignores malformed or noncurrent operation failures: %j", override => {
    const candidate = view("available");
    candidate.operationFailure = {
      status: "missing_role", checkedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 1_000).toISOString(), remediation: [], ...override,
    };
    expect(currentOperationFailure(candidate)).toBeUndefined();
  });

  it.each(["interaction_required", "authorization_expired"])("keeps application %s recovery separate from user sign-in", category => {
    const application = view("available");
    application.definition = capabilityDefinitions.find(definition => definition.id === "graph.package.read.application")!;
    application.decision.capabilityId = application.definition.id;
    application.decision.evidence = { category };
    expect(capabilityExplanation(application)).toMatch(/administrator.*credentials/i);
    expect(capabilityExplanation(application)).not.toMatch(/Sign in again|reauthorize this delegated/);
  });

  function onDemandView(id: CapabilityId): CapabilityView {
    return {
      enabled: true, definition: capabilityDefinitions.find(definition => definition.id === id)!,
      decision: {
        capabilityId: id, status: "available", authorized: true, fresh: true, verification: "on_demand",
        previewQualification: "not_required", remediation: [],
      },
    };
  }

  it.each(["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const)(
    "allows on-demand %s without claiming token or provider evidence", id => {
      const ready = onDemandView(id);
      expect(providerActionAllowed(ready)).toBe(true);
      expect(providerActionAllowed(ready, true)).toBe(true);
      expect(currentVerification(ready)).toBe("on_demand");
      expect(evidenceIsFresh(ready)).toBe(false);
      expect(evidenceIsStale(ready)).toBe(false);
      expect(operationAccessLabel(ready)).toBe("Microsoft validates permission when the operation is requested");
      expect(capabilityExplanation(ready)).toContain("Microsoft validates delegated permissions and provider roles on the actual operation");
      expect(capabilityExplanation(ready)).toContain("Review and confirm the exact targets");
    },
  );
  it.each(["graph.licenses.read", "reports.copilotUsage.read"] as const)(
    "recognizes registered on-demand read readiness for %s without write instructions", id => {
      const ready = onDemandView(id);
      expect(providerActionAllowed(ready)).toBe(true);
      expect(currentVerification(ready)).toBe("on_demand");
      expect(evidenceIsFresh(ready)).toBe(false);
      expect(evidenceIsStale(ready)).toBe(false);
      expect(operationAccessLabel(ready)).toBe("Microsoft validates permission when the operation is requested");
      expect(capabilityExplanation(ready)).toContain("Microsoft validates application permissions and provider roles on the actual operation");
      expect(capabilityExplanation(ready)).not.toMatch(/confirm|submitting a change|Not checked|provider request succeeded/);
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
    { previewQualification: "unqualified" },
    { previewQualification: "qualified" },
    { checkedAt: new Date(0).toISOString() },
    { expiresAt: new Date(0).toISOString() },
    { lastSuccessAt: new Date(0).toISOString() },
    { capabilityId: "graph.package.read.application" },
  ] satisfies Partial<CapabilityView["decision"]>[])("rejects inconsistent on-demand decisions: %j", override => {
    for (const id of onDemandIds) {
      const ready = onDemandView(id);
      Object.assign(ready.decision, override);
      expect(providerActionAllowed(ready, true)).toBe(false);
      expect(currentVerification(ready)).toBeUndefined();
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
  it("requires explicit investigation scope and rejects malformed or denied read decisions", () => {
    const candidate = view("available");
    const now = Date.now();
    candidate.decision.expiresAt = new Date(now - 1).toISOString();
    expect(providerActionAllowed(candidate, false, now)).toBe(true);
    candidate.definition = capabilityDefinitions.find(item => item.id === "defender.hunting.application")!;
    candidate.decision.capabilityId = candidate.definition.id;
    expect(providerActionAllowed(candidate, false, now)).toBe(false);
    candidate.definition = capabilityDefinitions.find(item => item.id === "graph.package.read.application")!;
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
      if (candidate.definition.mode === "application") candidate.configuration = { enabled: true, sharedDataScope: true, revision: 1 };
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
      expect(capabilityExplanation(candidate)).not.toMatch(/Token acquired|request succeeded|Authorized by current local/);
    },
  );
  it("names backend permissions and independent roles exactly", () => {
    expect(capabilityExplanation(view("missing_permission"))).toContain("application CopilotPackages.Read.All");
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
    "does not turn optional mutation diagnostics into a write-approval gate: %s", previewQualification => {
      for (const id of ["graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage"] as const) {
        const authorized = view("available");
        authorized.definition = capabilityDefinitions.find(definition => definition.id === id)!;
        authorized.decision = { ...authorized.decision, capabilityId: id, previewQualification };

        for (const verification of ["provider", "token"] as const) {
          authorized.decision.verification = verification;
          expect(evidenceIsFresh(authorized)).toBe(true);
          expect(providerActionAllowed(authorized, true)).toBe(true);
          expect(currentVerification(authorized)).toBe(verification);
          expect(operationAccessLabel(authorized)).toBe(verification === "provider"
            ? "Bounded provider operation succeeded" : "Microsoft validates permission when the operation is requested");
        }
        authorized.decision.expiresAt = new Date(0).toISOString();
        expect(providerActionAllowed(authorized, true)).toBe(false);
        expect(currentVerification(authorized)).toBeUndefined();
      }
    },
  );
  it("uses evidence categories for interactive authorization states", () => {
    const interaction = view("unknown", "powerPlatform.inventory.read");
    interaction.decision.evidence = { category: "interaction_required" };
    expect(capabilityExplanation(interaction)).toContain("Sign in again for MFA or Conditional Access");

    const expired = view("unknown", "powerPlatform.inventory.read");
    expired.decision.evidence = { category: "authorization_expired" };
    expect(capabilityExplanation(expired)).toContain("Sign in again");
  });
  it("keeps unregistered package reassignment disabled regardless of diagnostic evidence", () => {
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
    expect(capabilityExplanation(unsupported)).not.toContain("provider request succeeded");
    unsupported.decision.status = "not_configured";
    unsupported.decision.authorized = false;
    expect(currentVerification(unsupported)).toBeUndefined();
  });
  it.each(Object.keys(statusLabels).filter(status => status !== "available") as CapabilityStatus[])(
    "does not turn %s provenance or historical success into current verification", status => {
      for (const verification of ["provider", "token", "local", "on_demand"] as const) {
        const failed = view(status);
        failed.decision.verification = verification;
        failed.decision.lastSuccessAt = new Date(Date.now() - 30_000).toISOString();
        expect(currentVerification(failed)).toBeUndefined();
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
      for (const verification of ["provider", "token"] as const) {
        candidate.decision.verification = verification;
        expect(currentVerification(candidate)).toBeUndefined();
        expect(capabilityExplanation(candidate)).not.toMatch(/Token acquired|request succeeded/);
      }
    },
  );
  it("distinguishes local policy from provider checks and local authorization failures", () => {
    const local = view("available");
    local.definition = capabilityDefinitions.find(item => item.mode === "local")!;
    local.decision = { ...local.decision, capabilityId: local.definition.id, verification: "local", checkedAt: undefined, expiresAt: undefined };
    expect(currentVerification(local)).toBe("local");
    expect(capabilityExplanation(local)).toBe("Authorized by current local application policy.");
    local.decision.status = "missing_internal_role";
    local.decision.authorized = false;
    expect(currentVerification(local)).toBeUndefined();
    expect(providerActionAllowed(local)).toBe(false);
    expect(capabilityExplanation(local)).toContain("Requires");
  });
  it("does not call a fresh failed check stale", () => {
    const inconclusive = view("unknown");
    expect(capabilityExplanation(inconclusive)).toContain("check did not establish availability");
    expect(capabilityExplanation(inconclusive)).not.toContain("stale");
    inconclusive.decision.checkedAt = undefined;
    expect(currentVerification(inconclusive)).toBeUndefined();
    expect(capabilityExplanation(inconclusive)).toContain("Not checked yet");
  });
  it("does not treat quarantine status token readiness as provider verification", () => {
    const quarantine = view("available");
    quarantine.definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.read")!;
    quarantine.decision.capabilityId = quarantine.definition.id;
    quarantine.decision.verification = "token";
    expect(currentVerification(quarantine)).toBe("token");
    expect(capabilityExplanation(quarantine)).toContain("provider role, license, and operation access have not been verified");
    expect(operationAccessLabel(quarantine)).toBe("No separate operation check");
  });
  it("distinguishes token readiness from a successful bounded provider operation", () => {
    const operation = view("available");
    operation.definition = capabilityDefinitions.find(item => item.id === "defender.hunting.delegated")!;
    operation.decision.capabilityId = operation.definition.id;
    operation.decision.verification = "token";
    expect(operationAccessLabel(operation)).toBe("Microsoft validates permission when the operation is requested");
    operation.decision.verification = "provider";
    expect(operationAccessLabel(operation)).toBe("Bounded provider operation succeeded");
    operation.decision.status = "preview_disabled";
    operation.decision.authorized = false;
    expect(capabilityExplanation(operation)).toContain("not currently available");
    expect(capabilityExplanation(operation)).not.toContain("writes");
  });
  it.each(["purview.audit.search.application", "defender.hunting.application"])(
    "requests %s directly without claiming prior provider verification", capabilityId => {
      const application = view("available");
      application.definition = capabilityDefinitions.find(item => item.id === capabilityId)!;
      application.decision.capabilityId = application.definition.id;
      application.configuration = { enabled: true, sharedDataScope: true, revision: 1 };
      application.decision.checkedAt = undefined;
      application.decision.expiresAt = undefined;
      application.decision.verification = "on_demand";
      application.decision.previewQualification = "not_required";
      expect(operationAccessLabel(application)).toBe("Microsoft validates permission when the operation is requested");
      expect(capabilityExplanation(application)).toContain("Microsoft validates application permissions and provider roles on the actual operation");
      expect(providerActionAllowed(application)).toBe(true);
      expect(currentVerification(application)).toBe("on_demand");
      application.decision.checkedAt = new Date(0).toISOString();
      application.decision.expiresAt = new Date(60_000).toISOString();
      application.decision.verification = "token";
      expect(capabilityExplanation(application)).toContain("Evidence is stale");
      expect(capabilityExplanation(application)).toContain("Request the operation from its feature");
      expect(providerActionAllowed(application)).toBe(true);
      for (const configuration of [{ enabled: false, sharedDataScope: true }, { enabled: true, sharedDataScope: false }]) {
        application.enabled = configuration.enabled;
        application.configuration = { ...configuration, revision: 1 };
        expect(providerActionAllowed(application)).toBe(false);
      }
    },
  );
  it.each([
    "graph.package.read.delegated", "purview.audit.search.application", "defender.hunting.application",
    "graph.licenses.read", "reports.copilotUsage.read",
  ] as const)("never directs excluded capability %s to automatic checks for recovery", id => {
    const candidate = view("unknown");
    candidate.definition = capabilityDefinitions.find(definition => definition.id === id)!;
    candidate.decision.capabilityId = id;
    candidate.decision.checkedAt = undefined;
    expect(capabilityExplanation(candidate)).not.toMatch(/Automatic safe checks run/);
    expect(capabilityExplanation(candidate)).toMatch(/operation|read from the dashboard/);

    candidate.decision.checkedAt = new Date(0).toISOString();
    candidate.decision.expiresAt = new Date(0).toISOString();
    for (const status of ["unknown", "available"] as const) {
      candidate.decision.status = status;
      candidate.decision.authorized = status === "available";
      expect(capabilityExplanation(candidate)).not.toMatch(/use Check status to retry/i);
      expect(capabilityExplanation(candidate)).toMatch(/operation|read from the dashboard/);
    }

    candidate.decision.status = "provider_error";
    candidate.decision.authorized = false;
    for (const category of ["provider_timeout", "provider_network_error"]) {
      candidate.decision.evidence = { category, phase: "provider_read", timeoutMs: 30_000 };
      expect(capabilityExplanation(candidate)).not.toMatch(/use Check status to retry/i);
      expect(capabilityExplanation(candidate)).toMatch(/operation|read from the dashboard/);
    }
  });
});