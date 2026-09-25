import { describe, expect, it, vi } from "vitest";
import type { UnifiedAgentInventoryPage } from "../types/unifiedAgents.js";
import { AgentInvestigationsService, assertAgentHuntingScope, bindAgentHuntingFilters, investigationRecordId } from "./agentInvestigations.js";
import { createHuntingRequest, validateDefenderHuntingFilters } from "./graphHunting.js";
import type { InventoryIdentityRecord } from "./inventoryIdentity.js";
import type { AgentIdentityCacheState } from "../db/agentIdentity.js";
import { GraphAgentIdentityClient } from "./graphAgentIdentity.js";
import { verifiedAgentIdentityClientIdProvenance } from "../types/agentInvestigations.js";
import { AgentIdentityResolutionService } from "./agentIdentityResolution.js";
import type { AuthenticatedUser } from "../types/session.js";
import { defenderHuntingTemplates } from "../types/defenderHunting.js";
import { AppError } from "../errors.js";

const entra = "11111111-1111-4111-8111-111111111111";
const bot = "22222222-2222-4222-8222-222222222222";
const recordId = "agent:33333333-3333-4333-8333-333333333333";
const scope = { tenantId: "tenant-a", principalId: "reader-a" };

function setup() {
  const page = {
    count: 1, revision: "a".repeat(64), sources: { powerPlatform: { state: "available" } },
    value: [{
      id: recordId, displayName: "Saved agent", environmentId: "environment-a", packages: [{ id: entra, appId: entra }],
      identity: { state: "matched", evidence: [], packageEvidence: [], reason: null },
      observations: { powerPlatform: { current: true, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
      powerPlatformResource: { type: "microsoft.copilotstudio/agents", tenantId: "tenant-a", environmentId: "environment-a", nativeId: entra,
        identifiers: [{ kind: "entra_app_id", value: entra }, { kind: "cds_bot_id", value: bot }],
        provenance: { entraAppId: { sourceSystem: "power_platform", path: "properties.entraAppId", maturity: "ga" } } },
    }],
  } as unknown as UnifiedAgentInventoryPage;
  const inventory = { list: vi.fn(async () => page), assertRevision: vi.fn(async (_scope: typeof scope, _revision: string) => {}) };
  const identities = { readIdentityCandidates: vi.fn(async (): Promise<InventoryIdentityRecord[]> => [{
    nativeId: entra, tenantId: "tenant-a", environmentId: "environment-a", sourceSystem: "power_platform", resourceType: "microsoft.copilotstudio/agents",
    identifiers: page.value[0]?.powerPlatformResource?.identifiers ?? [],
  }]) };
  const mappings = { readState: vi.fn(async (): Promise<AgentIdentityCacheState> => ({ status: "missing" })) };
  return { page, record: page.value[0], inventory, identities, mappings, service: new AgentInvestigationsService(inventory, identities, mappings) };
}

describe("source-verified agent investigation context", () => {
  function modern() {
    const fixture = setup();
    fixture.page.revision = "a".repeat(64);
    fixture.record.observations.powerPlatform!.snapshotId = "44444444-4444-4444-8444-444444444444";
    fixture.record.powerPlatformResource!.agentKind = "copilot_studio_agent";
    fixture.record.powerPlatformResource!.identifiers = [{ kind: "entra_agent_id", value: entra }];
    fixture.record.powerPlatformResource!.provenance.entraAgentId = { sourceSystem: "power_platform", path: "properties.entraAgentId", maturity: "ga" };
    return fixture;
  }

  it("offers explicit source-bound resolution without contacting Graph or requiring a bot ID", async () => {
    const fixture = modern();
    const lookup = vi.spyOn(GraphAgentIdentityClient.prototype, "resolve");
    try {
      const saved = await fixture.service.resolve(scope, recordId);
      expect(saved.context.defender).toMatchObject({ status: "unavailable", entraAgentIds: [],
        resolution: { canResolve: true, capabilityId: "graph.agentIdentity.read", reasonCode: "identity_resolution_required" } });
      expect(saved.identitySource).toMatchObject({ recordId, candidateId: entra,
        snapshotId: fixture.record.observations.powerPlatform!.snapshotId, environmentId: "environment-a", sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(fixture.mappings.readState).toHaveBeenCalledWith(scope, saved.identitySource);
      expect(saved.context.purview.status).toBe("unavailable");
      expect(lookup).not.toHaveBeenCalled();
    } finally { lookup.mockRestore(); }
  });

  it.each(["legacy", "typed"] as const)("rejects a changed inventory revision after %s identity reads", async kind => {
    const fixture = kind === "legacy" ? setup() : modern();
    const changed = new AppError(409, "inventory_changed", "Saved inventory changed.");
    fixture.inventory.assertRevision.mockImplementation(async () => {
      expect(fixture.identities.readIdentityCandidates).toHaveBeenCalledOnce();
      if (kind === "typed") expect(fixture.mappings.readState).toHaveBeenCalledOnce();
      throw changed;
    });
    await expect(fixture.service.resolve(scope, recordId)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(fixture.inventory.assertRevision).toHaveBeenCalledExactlyOnceWith(scope, fixture.page.revision);
  });

  it("does not mask storage failures from the inventory revision fence", async () => {
    const fixture = modern();
    const unavailable = new Error("Inventory revision read failed.");
    fixture.inventory.assertRevision.mockRejectedValue(unavailable);
    await expect(fixture.service.resolve(scope, recordId)).rejects.toBe(unavailable);
  });

  it.each(["legacy", "typed"] as const)("rejects a %s identity selection invalidated during the candidate read", async kind => {
    const fixture = kind === "legacy" ? setup() : modern();
    fixture.identities.readIdentityCandidates.mockRejectedValue(new AppError(409, "snapshot_invalidated", "Inventory changed."));
    await expect(fixture.service.resolve(scope, recordId)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
    expect(fixture.mappings.readState).not.toHaveBeenCalled();
  });

  it("does not mask storage failures while reading identity candidates", async () => {
    const fixture = modern();
    const unavailable = new Error("Inventory identity read failed.");
    fixture.identities.readIdentityCandidates.mockRejectedValue(unavailable);
    await expect(fixture.service.resolve(scope, recordId)).rejects.toBe(unavailable);
  });

  it.each(["legacy candidates", "typed candidates", "typed cache", "revision"] as const)(
    "rejects a source expiring during the awaited %s read", async stage => {
      const fixture = stage === "legacy candidates" ? setup() : modern();
      const expiresAt = Date.parse(fixture.record.observations.powerPlatform!.expiresAt);
      const clock = vi.spyOn(Date, "now");
      try {
        if (stage.endsWith("candidates")) {
          const candidates = await fixture.identities.readIdentityCandidates();
          fixture.identities.readIdentityCandidates.mockImplementation(async () => {
            clock.mockReturnValue(expiresAt);
            return candidates;
          });
        } else if (stage === "typed cache") {
          fixture.mappings.readState.mockImplementation(async () => {
            clock.mockReturnValue(expiresAt);
            return { status: "missing" };
          });
        } else {
          fixture.inventory.assertRevision.mockImplementation(async () => { clock.mockReturnValue(expiresAt); });
        }
        await expect(fixture.service.resolve(scope, recordId)).rejects.toMatchObject({ code: "agent_identity_source_changed" });
      } finally { clock.mockRestore(); }
    },
  );

  it.each(["cache", "revision"] as const)("does not expose a verified mapping that expires during the awaited %s read", async stage => {
    const fixture = modern();
    const now = Date.now();
    const dates = { checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10_000).toISOString() };
    const cached: AgentIdentityCacheState = { status: "resolved", ...dates, value: { objectId: entra, applicationId: entra,
      runtimeStatus: "available", runtimeProvenance: verifiedAgentIdentityClientIdProvenance, ...dates } };
    fixture.mappings.readState.mockResolvedValue(cached);
    const clock = vi.spyOn(Date, "now");
    try {
      if (stage === "cache") fixture.mappings.readState.mockImplementation(async () => {
        clock.mockReturnValue(now + 10_000);
        return cached;
      });
      else fixture.inventory.assertRevision.mockImplementation(async () => { clock.mockReturnValue(now + 10_000); });
      const { context } = await fixture.service.resolve(scope, recordId);
      expect(context.defender).toMatchObject({ status: "unavailable", entraAgentIds: [], entraAgentApplicationIds: [],
        reasonCode: "identity_resolution_expired", resolution: { canResolve: true, cacheStatus: "expired",
          lastCheckedAt: dates.checkedAt, expiresAt: dates.expiresAt },
        templates: { agents_inventory: { status: "unavailable" }, agent_activity: { status: "unavailable" }, agent_tools: { status: "unavailable" } } });
      expect(context.defender.resolution?.resolvedAt).toBeUndefined();
      expect(cached.status).toBe("resolved");
    } finally { clock.mockRestore(); }
  });

  it("reports an expired saved denial after the final inventory check", async () => {
    const fixture = modern();
    const expiresAt = Date.now() + 10_000;
    fixture.mappings.readState.mockResolvedValue({ status: "authorization_required",
      expiresAt: new Date(expiresAt).toISOString(), lastErrorCode: "missing_permission" });
    const clock = vi.spyOn(Date, "now");
    try {
      fixture.inventory.assertRevision.mockImplementation(async () => { clock.mockReturnValue(expiresAt); });
      const { context } = await fixture.service.resolve(scope, recordId);
      expect(context.defender.resolution).toMatchObject({ cacheStatus: "expired",
        reasonCode: "identity_resolution_expired", lastErrorCode: "missing_permission" });
    } finally { clock.mockRestore(); }
  });

  it("requires a saved revision for legacy runtime and Purview identities as well as typed resolution", async () => {
    const fixture = setup();
    fixture.page.revision = undefined;
    const { context, identitySource, purviewTarget } = await fixture.service.resolve(scope, recordId);
    expect(context.defender).toMatchObject({ status: "unavailable", entraAgentApplicationIds: [], reasonCode: "stale_source" });
    expect(context.purview).toMatchObject({ status: "unavailable", reasonCode: "stale_source" });
    expect(identitySource).toBeUndefined();
    expect(purviewTarget).toBeUndefined();
    expect(fixture.identities.readIdentityCandidates).not.toHaveBeenCalled();
  });

  it("turns a minimal typed GET with no appId or bot ID into saved inventory and runtime scopes", async () => {
    const fixture = modern();
    const user: AuthenticatedUser = { tenantId: scope.tenantId, homeAccountId: scope.principalId, roles: ["AgentControl.Viewer"],
      displayName: "Fixture", username: "fixture@example.invalid" };
    const fetcher = vi.fn(async () => Response.json({ id: entra, servicePrincipalType: "ServiceIdentity" }));
    const resolver = new AgentIdentityResolutionService({
      observeOperation: async (_id, _user, operation) => operation(() => undefined),
      inventory: fixture.service, directory: new GraphAgentIdentityClient(fetcher),
      repository: {
        invalidate: async () => { fixture.mappings.readState.mockResolvedValue({ status: "missing" }); },
        saveFailure: async () => { throw new Error("Unexpected failure in the minimal typed identity fixture"); },
        save: async (_scope, _source, identity, fence) => {
          await fence();
          const dates = { checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
          fixture.mappings.readState.mockResolvedValue({ status: "resolved", ...dates, value: { ...identity, ...dates } });
        },
      },
      revalidateUser: async () => user, delegatedToken: async () => "fixture",
      requireAvailable: async capabilityId => ({ capabilityId, status: "available", fresh: true, authorized: true,
        verification: "on_demand", previewQualification: "not_required", remediation: [] }),
      admissions: () => {},
    });
    const context = await resolver.resolve(user, recordId);
    expect(context.defender).toMatchObject({ entraAgentIds: [entra], entraAgentApplicationIds: [entra],
      resolution: { runtimeProvenance: verifiedAgentIdentityClientIdProvenance },
      templates: { agents_inventory: { status: "available" }, agent_activity: { status: "available" }, agent_tools: { status: "available" } } });
    expect(context.purview.status).toBe("unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
    await fixture.service.resolve(scope, recordId);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("enables all templates from a verified agentIdentity while retaining separate filter namespaces", async () => {
    const fixture = modern();
    fixture.mappings.readState.mockResolvedValue({ status: "resolved", value: { objectId: entra, applicationId: entra,
      runtimeStatus: "available", runtimeProvenance: verifiedAgentIdentityClientIdProvenance, checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString() } });
    const { context } = await fixture.service.resolve(scope, recordId);
    expect(context.defender).toMatchObject({ status: "available", entraAgentIds: [entra], entraAgentApplicationIds: [entra],
      resolution: { runtimeStatus: "available", runtimeProvenance: verifiedAgentIdentityClientIdProvenance },
      templates: { agents_inventory: { status: "available" }, agent_activity: { status: "available" }, agent_tools: { status: "available" } } });
    const target = await fixture.service.defenderScope(scope, recordId);
    const dates = { startDateTime: new Date(Date.now() - 60_000).toISOString(), endDateTime: new Date().toISOString(), operations: [] };
    const inventory = bindAgentHuntingFilters({ templateId: "agents_inventory", ...dates }, target);
    expect(inventory).toMatchObject({ entraAgentIds: [entra] });
    expect(inventory).not.toHaveProperty("entraAgentApplicationIds");
    const inventoryQuery = createHuntingRequest(validateDefenderHuntingFilters(inventory)).Query;
    expect(inventoryQuery).toContain(`EntraAgentId in~ (@'${entra}')`);
    for (const templateId of ["agent_activity", "agent_tools"] as const) {
      const runtime = bindAgentHuntingFilters({ templateId, ...dates, operations: defenderHuntingTemplates[templateId].operations }, target);
      expect(runtime).toMatchObject({ entraAgentApplicationIds: [entra] });
      expect(runtime).not.toHaveProperty("entraAgentIds");
      const query = createHuntingRequest(validateDefenderHuntingFilters(runtime)).Query;
      expect(query).toContain(`tolower(tostring(Event.TargetAgentId)) in (@'${entra}')`);
      expect(query).toContain(`tolower(tostring(Event.AgentId)) in (@'${entra}')`);
      expect(query).not.toContain(`tostring(Event.PlatformAgentId)) in (@'${entra}')`);
    }
  });

  it("distinguishes unsupported sources, missing candidates, ambiguity and stale identity without cache access", async () => {
    for (const [mutate, reasonCode] of [
      [(f: ReturnType<typeof modern>) => { f.record.powerPlatformResource!.agentKind = "agent_builder_agent"; }, "unsupported_identity_crosswalk"],
      [(f: ReturnType<typeof modern>) => { f.record.powerPlatformResource!.identifiers = []; }, "missing_identity_candidate"],
      [(f: ReturnType<typeof modern>) => { f.record.powerPlatformResource!.identifiers[0].value = "00000000-0000-0000-0000-000000000000"; }, "invalid_identity_candidate"],
      [(f: ReturnType<typeof modern>) => { f.record.powerPlatformResource!.identifiers.push({ kind: "entra_agent_id", value: bot }); }, "invalid_identity_candidate"],
      [(f: ReturnType<typeof modern>) => { f.record.powerPlatformResource!.provenance.entraAgentId.path = "properties.entraAgentBlueprintId"; }, "invalid_identity_candidate"],
      [(f: ReturnType<typeof modern>) => { f.record.observations.powerPlatform!.current = false; }, "stale_source"],
      [(f: ReturnType<typeof modern>) => { f.page.revision = undefined; }, "stale_source"],
      [(f: ReturnType<typeof modern>) => { f.record.identity.state = "ambiguous"; }, "ambiguous_identity"],
      [(f: ReturnType<typeof modern>) => { f.identities.readIdentityCandidates.mockResolvedValue([]); }, "ambiguous_identity"],
    ] as const) {
      const fixture = modern();
      mutate(fixture);
      const value = await fixture.service.resolve(scope, recordId);
      expect(value.context.defender.resolution).toMatchObject({ canResolve: false, reasonCode });
      if (reasonCode === "unsupported_identity_crosswalk") {
        expect(value.context.defender.resolution?.reason).toContain("Provider-native logs may exist");
        expect(value.context.defender.resolution?.reason).toContain("verified crosswalk");
      }
      expect(value.identitySource).toBeUndefined();
      expect(fixture.mappings.readState).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["expired", "identity_resolution_expired"], ["authorization_required", "identity_authorization_required"],
    ["not_found", "identity_not_found"], ["provider_error", "identity_provider_error"], ["setup_required", "identity_setup_required"],
  ] as const)("reports saved %s outcomes without treating their candidate IDs as verified mappings", async (status, reasonCode) => {
    const fixture = modern();
    const dates = { checkedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    fixture.mappings.readState.mockResolvedValue({ status, ...dates, lastErrorCode: "fixture_error",
      value: { objectId: entra, applicationId: bot, ...dates } });
    const { context } = await fixture.service.resolve(scope, recordId);
    expect(context.defender).toMatchObject({ status: "unavailable", entraAgentIds: [], entraAgentApplicationIds: [],
      reasonCode, resolution: { canResolve: true, cacheStatus: status, reasonCode, lastErrorCode: "fixture_error",
        lastCheckedAt: dates.checkedAt, expiresAt: dates.expiresAt } });
    expect(context.defender.resolution?.resolvedAt).toBeUndefined();
  });

  it.each([null, bot, entra])("does not infer client-ID equivalence from cached values without typed provenance: %s", async applicationId => {
    const fixture = modern();
    const dates = { checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
    fixture.mappings.readState.mockResolvedValue({ status: "resolved", ...dates,
      value: { objectId: entra, applicationId, ...dates } });
    const { context } = await fixture.service.resolve(scope, recordId);
    expect(context.defender).toMatchObject({ status: "available", entraAgentIds: [entra], entraAgentApplicationIds: [],
      resolution: { cacheStatus: "resolved", runtimeStatus: "unverified", resolvedAt: dates.checkedAt },
      templates: { agents_inventory: { status: "available" }, agent_activity: { status: "unavailable" }, agent_tools: { status: "unavailable" } } });
    expect(context.defender.resolution?.runtimeProvenance).toBeUndefined();
  });

  it("resolves the current visible saved record without provider search or caller identity filters", async () => {
    const fixture = setup();
    await expect(fixture.service.resolve(scope, recordId)).resolves.toMatchObject({
      context: { recordId, displayName: "Saved agent", defender: { status: "available", entraAgentIds: [], entraAgentApplicationIds: [entra],
        templates: { agents_inventory: { status: "unavailable" }, agent_activity: { status: "available" }, agent_tools: { status: "available" } } },
      purview: { status: "available", mode: "saved_only" } },
      purviewTarget: { environmentId: "environment-a", botId: bot },
    });
    expect(fixture.inventory.list).toHaveBeenCalledExactlyOnceWith(scope, { recordId, limit: 1 });
    expect(fixture.identities.readIdentityCandidates).toHaveBeenCalledExactlyOnceWith(scope, ["microsoft.copilotstudio/agents"]);
  });

  it.each(["package_id", "package_app_id", "entra_agent_id", "entra_blueprint_id", "cds_bot_id"] as const)("never substitutes unverified %s, a native ID or a canonical ID for a verified runtime application identity", async kind => {
    const fixture = setup();
    fixture.record.powerPlatformResource!.identifiers = [{ kind, value: entra }];
    await expect(fixture.service.resolve(scope, recordId)).resolves.toMatchObject({ context: { defender: { status: "unavailable", entraAgentIds: [] } } });
    await expect(fixture.service.defenderScope(scope, recordId)).rejects.toMatchObject({ code: "agent_investigation_unavailable" });
  });

  it.each(["ambiguous", "conflicting"] as const)("denies %s identity metadata", async state => {
    const fixture = setup();
    fixture.record.identity.state = state;
    await expect(fixture.service.resolve(scope, recordId)).resolves.toMatchObject({ context: { defender: { status: "unavailable" }, purview: { status: "unavailable" } } });
  });

  it("denies invalid metadata, stale snapshots, wrong tenants and multiple or invalid Entra IDs", async () => {
    for (const change of [
      (f: ReturnType<typeof setup>) => { f.record.identity.invalidMetadata = true; },
      (f: ReturnType<typeof setup>) => { f.record.observations.powerPlatform!.expiresAt = new Date(0).toISOString(); },
      (f: ReturnType<typeof setup>) => { f.record.powerPlatformResource!.tenantId = "other-tenant"; },
      (f: ReturnType<typeof setup>) => { f.record.powerPlatformResource!.identifiers.push({ kind: "entra_app_id", value: bot }); },
      (f: ReturnType<typeof setup>) => { f.record.powerPlatformResource!.identifiers.push({ kind: "entra_app_id", value: "not-an-application-id" }); },
      (f: ReturnType<typeof setup>) => { f.record.powerPlatformResource!.provenance = {}; },
      (f: ReturnType<typeof setup>) => { f.record.powerPlatformResource!.provenance.entraAppId.path = "properties.entraAgentId"; },
      (f: ReturnType<typeof setup>) => { f.record.powerPlatformResource = null; },
    ]) {
      const fixture = setup(); change(fixture);
      await expect(fixture.service.defenderScope(scope, recordId)).rejects.toMatchObject({ code: "agent_investigation_unavailable" });
    }
  });

  it("requires the current environment and a typed bot ID for saved Purview, not runtime AgentId", async () => {
    const fixture = setup();
    fixture.record.powerPlatformResource!.identifiers = [{ kind: "entra_app_id", value: entra }];
    await expect(fixture.service.resolve(scope, recordId)).resolves.toMatchObject({ context: { defender: { status: "available" }, purview: { status: "unavailable" } } });
    fixture.record.powerPlatformResource!.identifiers.push({ kind: "cds_bot_id", value: bot });
    fixture.record.environmentId = "other-environment";
    expect((await fixture.service.resolve(scope, recordId)).purviewTarget).toBeUndefined();
  });

  it("denies identifiers that resolve to multiple saved agents or no longer belong to this saved agent", async () => {
    const fixture = setup();
    const candidates = await fixture.identities.readIdentityCandidates();
    fixture.identities.readIdentityCandidates.mockResolvedValue([...candidates, { ...candidates[0], nativeId: "different-native-agent" }]);
    await expect(fixture.service.resolve(scope, recordId)).resolves.toMatchObject({
      context: { defender: { status: "unavailable" }, purview: { status: "unavailable" } },
    });
    fixture.identities.readIdentityCandidates.mockResolvedValue([{ ...candidates[0], nativeId: "replacement-agent" }]);
    await expect(fixture.service.defenderScope(scope, recordId)).rejects.toMatchObject({ code: "agent_investigation_unavailable" });
    fixture.identities.readIdentityCandidates.mockResolvedValue([]);
    await expect(fixture.service.defenderScope(scope, recordId)).rejects.toMatchObject({ code: "agent_investigation_unavailable" });
  });

  it("rejects missing/invisible and malformed records before using any source identity", async () => {
    const fixture = setup();
    fixture.page.count = 0;
    await expect(fixture.service.resolve(scope, recordId)).rejects.toMatchObject({ status: 404 });
    for (const invalid of ["", "plain-id", [], {}, "agent:not-uuid", "power_platform:env:%zz", "graph_packages:"]) {
      expect(() => investigationRecordId(invalid)).toThrow();
    }
  });

  it("accepts exact context IDs and empty legacy fields but rejects conflicting or broad identity filters", () => {
    const agent = { recordId, entraAgentIds: [entra] };
    const input = { templateId: "agents_inventory", startDateTime: new Date(Date.now() - 30_000).toISOString(), endDateTime: new Date().toISOString(), actorObjectIds: [], operations: [] };
    expect(validateDefenderHuntingFilters(bindAgentHuntingFilters(input, agent))).toMatchObject({ agentIds: [], blueprintIds: [], entraAgentIds: [entra] });
    for (const supplied of [
      {}, { agentIds: [], blueprintIds: [], entraAgentIds: [], actorObjectIds: [] }, { entraAgentIds: [entra] },
      { entraAgentIds: [entra.toUpperCase()] }, { actorObjectIds: undefined },
    ]) {
      expect(validateDefenderHuntingFilters(bindAgentHuntingFilters({ ...input, ...supplied }, agent)))
        .toMatchObject({ agentIds: [], blueprintIds: [], actorObjectIds: [], entraAgentIds: [entra] });
    }
    for (const supplied of [
      { agentIds: [entra] }, { blueprintIds: [bot] }, { actorObjectIds: [bot] }, { entraAgentIds: [bot] },
      { entraAgentIds: [entra, bot] }, { entraAgentIds: [entra, entra] }, { entraAgentIds: null },
      { entraAgentIds: entra }, { agentIds: null }, { blueprintIds: "bad" }, { actorObjectIds: {} },
    ]) {
      expect(() => bindAgentHuntingFilters({ ...input, ...supplied }, agent)).toThrowError(expect.objectContaining({ code: "agent_identity_override" }));
    }
    for (const filters of [
      { agentIds: [], blueprintIds: [] }, { agentIds: [], blueprintIds: [], entraAgentIds: [] },
      { agentIds: [], blueprintIds: [], entraAgentIds: [entra, bot] }, { agentIds: [], blueprintIds: [], entraAgentIds: [bot] },
      { agentIds: [entra], blueprintIds: [], entraAgentIds: [entra] }, { agentIds: [], blueprintIds: [bot], entraAgentIds: [entra] },
    ]) expect(() => assertAgentHuntingScope({ ...filters, templateId: "agents_inventory" }, agent)).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("binds runtime application IDs separately and refuses inventory without a verified enterprise object ID", () => {
    const agent = { recordId, entraAgentIds: [], entraAgentApplicationIds: [entra] };
    const runtime = { templateId: "agent_activity", startDateTime: new Date(Date.now() - 30_000).toISOString(),
      endDateTime: new Date().toISOString(), operations: ["InvokeAgent"] };
    const bound = validateDefenderHuntingFilters(bindAgentHuntingFilters({ ...runtime, entraAgentApplicationIds: [entra] }, agent));
    expect(bound.entraAgentApplicationIds).toEqual([entra]);
    expect(bound.entraAgentIds).toBeUndefined();
    expect(() => assertAgentHuntingScope(bound, agent)).not.toThrow();
    for (const supplied of [[bot], [entra, bot], [entra, entra], null, entra, {}]) {
      expect(() => bindAgentHuntingFilters({ ...runtime, entraAgentApplicationIds: supplied }, agent))
        .toThrowError(expect.objectContaining({ code: "agent_identity_override" }));
    }
    expect(() => bindAgentHuntingFilters({ ...runtime, entraAgentIds: [entra] }, agent)).toThrowError(expect.objectContaining({ code: "agent_identity_override" }));
    expect(() => bindAgentHuntingFilters({ ...runtime, templateId: "agents_inventory" }, agent)).toThrowError(expect.objectContaining({ code: "agent_investigation_unavailable" }));
    expect(() => assertAgentHuntingScope({ ...bound, entraAgentApplicationIds: undefined, entraAgentIds: [entra] }, agent)).toThrow();
  });
});
