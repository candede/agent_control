import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AgentUsageService } from "../services/agentUsage.js";
import { SavedAgentPeopleService } from "../services/savedAgentPeople.js";
import { UnifiedAgentsService } from "../services/unifiedAgents.js";
import { resolvePackageAgentLinks } from "../services/packageAgentIdentity.js";
import type { CopilotDirectoryUser } from "../services/copilotUsageGraph.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { DataSyncRepository, type DataSyncScope } from "./dataSync.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { UnifiedAgentRegistry } from "./unifiedAgentRegistry.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import { buildUnifiedAgentCsv } from "../services/unifiedAgentExport.js";
import { parse } from "csv-parse/sync";

const personId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const observedAt = "2026-09-15T10:00:00.000Z";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new DataSyncRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function directoryUser(displayName = "Saved Person", objectId = personId): CopilotDirectoryUser {
  return {
    identity: { objectId, displayName, userPrincipalName: "saved#EXT#@example.onmicrosoft.com",
      accountEnabled: true, userType: "Guest", employeeType: null, department: null, companyName: null },
    serviceEvidenceVersion: 1, copilotServiceState: "unknown", servicePlans: [],
  };
}

async function inventory(scope: DataSyncScope) {
  const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
  const native: PowerPlatformResource = {
    tenantId: scope.tenantId, nativeId: "native-agent", environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    type: "microsoft.copilotstudio/agents", displayName: "Agent", location: null,
    createdAt: null, createdBy: personId, lastPublishedAt: null, sourceSystem: "power_platform",
    authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "agent", lifecycle: "published",
    identityConfidence: "exact_native",
    identifiers: [
      { kind: "environment_id", value: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { kind: "power_platform_resource_id", value: "native-agent" },
    ],
    provenance: {}, unknownFieldCount: 0,
    details: { ownerId: personId.toUpperCase(), lastModifiedBy: personId },
  };
  const job = await powerPlatform.submit(scope, {
    idempotencyKey: `people-${scope.principalId}`, roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"],
  });
  await powerPlatform.markRunning(scope, job.id);
  await powerPlatform.publish(scope, job.id, {
    resources: [native], queriedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null,
    totalRecords: 1, pages: 1, unknownFieldCount: 0,
  });
  return new UnifiedAgentsService({
    packages: new PackageInventoryRepository(fixture.runtime), powerPlatform,
    usage: new AgentUsageService(fixture.runtime), people: new SavedAgentPeopleService(repository, new AgentPeopleRepository(fixture.runtime)),
    registry: new UnifiedAgentRegistry(fixture.runtime), resolveLinks: resolvePackageAgentLinks,
    operationPackageIds: async () => [],
    readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
  });
}

describe("persisted saved directory agent people", () => {
  it("persists unlicensed creators into subsequent lists and exports, including explicit lookup outcomes", async () => {
    const scope = { tenantId: "cached-people", principalId: "private-reader" };
    const service = await inventory(scope);
    const cache = new AgentPeopleRepository(fixture.runtime);
    const before = await service.list(scope);
    const checkedAt = new Date(Date.now() - 1_000).toISOString();
    await cache.save(scope, [{ objectId: personId, status: "resolved", displayName: "Unlicensed Creator",
      userPrincipalName: "unlicensed@example.invalid", checkedAt }], { generation: "initial" });
    const after = await service.list(scope, { search: "Unlicensed Creator", sortBy: "createdBy" });
    expect(after.count).toBe(1);
    expect(after.value[0].id).toBe(before.value[0].id);
    expect(after.value[0].people?.createdBy?.displayName).toBe("Unlicensed Creator");
    expect((await repository.getDirectorySource(scope)).value).toBeNull();
    await expect(service.forExport(scope, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    await cache.save(scope, [{ objectId: personId, status: "lookup_failed", displayName: null,
      userPrincipalName: null, checkedAt: new Date().toISOString(), errorCode: "provider_timeout" }], { generation: "initial" });
    const failed = await service.list(scope);
    const rows = parse(buildUnifiedAgentCsv(await service.forExport(scope, failed.revision!), Date.now() + 15_000).buffer,
      { bom: true, columns: true });
    expect(rows[0]).toMatchObject({
      createdBy: personId, createdByDisplayName: "Unlicensed Creator", createdByObservedAt: checkedAt,
      createdByResolutionStatus: "lookup_failed", createdByErrorCode: "provider_timeout",
    });
    await cache.save(scope, [{ objectId: personId, status: "not_found", displayName: null,
      userPrincipalName: null, checkedAt: new Date(Date.now() + 1).toISOString() }], { generation: "initial" });
    expect((await service.list(scope)).value[0].people?.createdBy).toMatchObject({ status: "not_found", displayName: null });
  });

  it("excludes other tenants, principals, app reports, unmatched IDs and expired snapshots", async () => {
    const scope = { tenantId: "saved-people", principalId: "private-reader" };
    const service = await inventory(scope);
    const before = await service.list(scope);
    expect(before.value[0].people).toBeUndefined();
    await repository.publishDirectory({ ...scope, tenantId: "other-tenant" }, [directoryUser("Other tenant")], observedAt, "Fixture.");
    await repository.publishDirectory({ ...scope, principalId: "other-reader" }, [directoryUser("Other principal")], observedAt, "Fixture.");
    await repository.publishAppActivity(scope, { users: [], reportRefreshDate: null }, observedAt, "Fixture.");
    const isolated = await service.list(scope);
    expect(isolated.value[0].people).toBeUndefined();
    expect(isolated.revision).toBe(before.revision);
    await repository.publishDirectory(scope, [directoryUser("Unmatched", "cccccccc-cccc-4ccc-8ccc-cccccccccccc")], observedAt, "Fixture.");
    expect((await service.list(scope)).value[0].people).toBeUndefined();
    const snapshotId = await repository.publishDirectory(scope, [directoryUser()], observedAt, "Fixture.");
    const saved = await service.list(scope);
    expect(saved.value[0].people?.owner).toEqual({
      objectId: personId, displayName: "Saved Person", userPrincipalName: "saved#EXT#@example.onmicrosoft.com", observedAt,
    });
    expect(saved.value[0].people?.createdBy).toEqual(saved.value[0].people?.owner);
    expect(saved.value[0].people?.lastModifiedBy).toEqual(saved.value[0].people?.owner);
    expect(saved.value[0].id).toBe(before.value[0].id);
    await fixture.operator.query("UPDATE copilot_usage_snapshots SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [snapshotId]);
    const expired = await service.list(scope);
    expect(expired.value[0].people).toBeUndefined();
    expect(expired.value[0].powerPlatformResource?.details.ownerId).toBe(personId.toUpperCase());
    expect(expired.value[0].id).toBe(saved.value[0].id);
    await expect(service.assertRevision(scope, saved.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    await expect(service.forExport(scope, saved.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
  });

  it("invalidates exports on same-timestamp snapshot replacement without changing memberships or source identity", async () => {
    const scope = { tenantId: "saved-people", principalId: "replacement-reader" };
    const service = await inventory(scope);
    await repository.publishDirectory(scope, [directoryUser()], observedAt, "Fixture.");
    const before = await service.list(scope);
    await service.assertRevision(scope, before.revision!);
    await repository.publishDirectory(scope, [directoryUser("Replacement Person")], observedAt, "Fixture.");
    await expect(service.forExport(scope, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    await expect(service.assertRevision(scope, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    const after = await service.list(scope);
    expect(after.revision).not.toBe(before.revision);
    expect(after.value[0].people?.owner?.displayName).toBe("Replacement Person");
    expect(after.value[0].id).toBe(before.value[0].id);
    expect(after.value[0].powerPlatformResource).toEqual(before.value[0].powerPlatformResource);
    expect(after.value[0].identity).toEqual(before.value[0].identity);
    expect((await service.forExport(scope, after.revision!)).value[0].people).toEqual(after.value[0].people);
  });

  it("keeps a valid prior observation after failed refresh, but rejects malformed saved identity data explicitly", async () => {
    const scope = { tenantId: "saved-people", principalId: "failure-reader" };
    const service = await inventory(scope);
    await repository.publishDirectory(scope, [directoryUser()], observedAt, "Fixture.");
    await repository.recordUserSourceFailure(scope, "directory", "permission_required", "Fixture denial.", new Date().toISOString());
    const retained = await service.list(scope);
    expect(retained.value[0].people?.owner?.observedAt).toBe(observedAt);
    await repository.publishDirectory(scope, [{ ...directoryUser(), identity: { objectId: personId } } as CopilotDirectoryUser], observedAt, "Malformed fixture.");
    await expect(service.list(scope)).rejects.toMatchObject({ code: "copilot_usage_snapshot_invalid" });
    await repository.publishDirectory(scope, [directoryUser()], observedAt, "Fixed fixture.");
    expect((await service.list(scope)).value[0].id).toBe(retained.value[0].id);
  });
});
