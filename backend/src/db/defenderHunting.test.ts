import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { nativeInventoryFixture } from "../../scripts/inventoryFixtures.js";
import type { DefenderAgentActivityRow, DefenderAgentInventoryRow, DefenderHuntingFilters, DefenderHuntingQueryResult } from "../types/defenderHunting.js";
import { DefenderHuntingRepository, type DefenderHuntingScope } from "./defenderHunting.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DefenderHuntingRepository;
const principalScope: DefenderHuntingScope = { tenantId: "tenant-a", authorizationPrincipalId: "security-a",
  resultScope: { kind: "principal", scopeId: "security-a", configurationRevision: null }, tokenMode: "delegated" };
const filters: DefenderHuntingFilters = { templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z",
  endDateTime: "2026-09-09T11:00:00.000Z", agentIds: ["defender-agent"], blueprintIds: [], actorObjectIds: [], operations: [] };
const authority = { capabilityId: "defender.hunting.delegated" as const, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };

beforeAll(async () => { fixture = await testDatabase(); repository = new DefenderHuntingRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

function inventoryRow(overrides: Partial<DefenderAgentInventoryRow> = {}): DefenderAgentInventoryRow {
  return { projectionVersion: 3, sourceTable: "AgentsInfo", observationTime: "2026-09-09T10:30:00.000Z", agentId: "defender-agent",
    agentName: null, platform: null, agentDescription: null, version: null, sourceAgentId: null,
    entraAgentObjectId: "11111111-1111-4111-8111-111111111111", entraBlueprintId: "22222222-2222-4222-8222-222222222222",
    observabilityId: null, publishedStatus: null, lifecycleStatus: null, availability: null, createdDateTime: null,
    lastPublishedDateTime: null, lastUpdatedDateTime: null, instanceCount: null, model: null, ownerCount: null,
    sharedWithCount: null, permissionMetadataKeyCount: null, authenticationMetadataKeyCount: null,
    detailStates: { owners: "not_supplied", sharing: "not_supplied", permissions: "not_supplied", authentication: "not_supplied", risk: "not_exposed" }, ...overrides };
}

function activityRow(overrides: Partial<DefenderAgentActivityRow> = {}): DefenderAgentActivityRow {
  return { projectionVersion: 3, sourceTable: "CloudAppEvents", timestamp: "2026-09-09T10:40:00.000Z", actionType: "InvokeAgent",
    cloudApplication: null, cloudApplicationId: null, cloudAppInstanceId: null, actorAccountObjectId: null, actorProviderAccountId: null,
    objectId: null, reportId: "report-a", oauthAppId: null, operation: "invoke_agent", organizationId: null, targetAgentId: null,
    targetAgentName: null, targetAgentBlueprintId: null, agentId: null, agentName: null, agentBlueprintId: null,
    alternatePlatformAgentId: null, platformAgentType: null, conversationId: null, conversationThreadId: null, sessionIdentity: null, channelName: null,
    humanActorUserObjectId: null, humanActorUserPrincipalName: null, agentUserObjectId: null, agentUserPrincipalName: null, targetAgentUserObjectId: null,
    spanId: "0123456789abcdef", parentSpanId: null, creationTime: null, completionTime: null, errorType: null, toolName: null, toolType: null,
    toolCallId: null, invokeSource: null, durationMilliseconds: null, outcome: "unknown", spanRole: "root_invoke_agent", rootSpanObserved: true,
    fieldStates: { conversationId: "null", conversationThreadId: "unavailable", channelName: "null", humanActorUserObjectId: "null", agentUserObjectId: "unavailable",
      targetAgentUserObjectId: "null", completionTime: "null", errorType: "null", platformAgentId: "null", platformAgentType: "null" }, contentAvailable: false, ...overrides };
}

function result(rows: Array<DefenderAgentInventoryRow | DefenderAgentActivityRow>, complete = true): DefenderHuntingQueryResult {
  return { rows, providerRowCount: complete ? rows.length : 201, storedRowCount: rows.length, byteCount: 1024,
    complete, partialReason: complete ? null : "hunting_row_limit" };
}

async function submitAndBegin(key: string, scope = principalScope, selectedFilters = filters) {
  const job = await repository.submit(scope, { idempotencyKey: key, filters: selectedFilters });
  return { job, execution: await repository.begin(scope, job.id) };
}

describe.sequential("Defender hunting repository", () => {
  it("publishes ordinary application results and preserves tenant/configuration sharing boundaries", async () => {
    const scope: DefenderHuntingScope = {
      tenantId: "ordinary-app-tenant", authorizationPrincipalId: "requesting-viewer",
      resultScope: { kind: "application", scopeId: "configured-client", configurationRevision: 2 },
      tokenMode: "application",
    };
    const job = await repository.submit(scope, { idempotencyKey: "ordinary-application", filters });
    expect(job).toMatchObject({ status: "waiting_authorization", tokenMode: "application", resultScope: scope.resultScope });
    const execution = await repository.begin(scope, job.id);
    const published = await repository.publish(scope, job.id, execution, result([inventoryRow()]));
    expect(published.status).toBe("succeeded");
    const shared = { tenantId: scope.tenantId, authorizationPrincipalId: "another-viewer",
      resultScopes: [scope.resultScope], };
    expect((await repository.listJobs(shared, 20, 0)).value.map(value => value.id)).toEqual([job.id]);
    expect((await repository.listRows(shared, job.id, 100, 0)).value).toHaveLength(1);
    await expect(repository.cancel(shared, job.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
    for (const forbidden of [
      { ...shared, tenantId: "another-tenant" },
      { ...shared, resultScopes: [{ ...scope.resultScope, configurationRevision: 3 }] },
      { ...shared, resultScopes: [{ ...scope.resultScope, scopeId: "another-client" }] },
    ]) {
      expect((await repository.listJobs(forbidden, 20, 0)).count).toBe(0);
      expect(await repository.getJob(forbidden, job.id)).toBeUndefined();
    }
  });
  it("filters human scope before counts and denies other-human job access even on the same agent", async () => {
    const owner: DefenderHuntingScope = { ...principalScope, authorizationPrincipalId: "human-history-reader",
      resultScope: { kind: "principal", scopeId: "human-history-reader", configurationRevision: null } };
    const userObjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const selected: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"],
      agentIds: [], entraAgentApplicationIds: [applicationId], userObjectId };
    const matching = await repository.submit(owner, { idempotencyKey: "human-match", filters: selected });
    const other = await repository.submit(owner, { idempotencyKey: "human-other", filters: { ...selected, userObjectId: applicationId } });
    const broad = await repository.submit(owner, { idempotencyKey: "human-broad", filters: { ...selected, userObjectId: undefined } });
    const read = { tenantId: owner.tenantId, authorizationPrincipalId: owner.authorizationPrincipalId,
      resultScopes: [owner.resultScope], userObjectId, entraAgentApplicationIds: [applicationId] };
    const page = await repository.listJobs(read, 1, 0);
    expect(page.count).toBe(1);
    expect(page.value.map(job => job.id)).toEqual([matching.id]);
    expect(await repository.getJob(read, other.id)).toBeUndefined();
    await expect(repository.cancel(read, other.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
    for (const job of [matching, other, broad]) await repository.cancel(owner, job.id);
  });
  it("isolates typed agent history before real database counts, pagination and lifecycle access", async () => {
    const scope: DefenderHuntingScope = { ...principalScope, authorizationPrincipalId: "agent-history-reader",
      resultScope: { kind: "principal", scopeId: "agent-history-reader", configurationRevision: null } };
    const identity = "33333333-3333-4333-8333-333333333333";
    const otherIdentity = "44444444-4444-4444-8444-444444444444";
    const inventoryFilters = { ...filters, agentIds: [], entraAgentIds: [identity] };
    const runtimeFilters: DefenderHuntingFilters = { ...filters, agentIds: [], templateId: "agent_activity",
      operations: ["InvokeAgent"], entraAgentApplicationIds: [identity] };
    const inventory = await repository.submit(scope, { idempotencyKey: "agent-inventory", filters: inventoryFilters });
    const activity = await repository.submit(scope, { idempotencyKey: "agent-activity", filters: runtimeFilters });
    const tools = await repository.submit(scope, { idempotencyKey: "agent-tools",
      filters: { ...runtimeFilters, templateId: "agent_tools", operations: ["ExecuteToolBySDK"] } });
    const other = await repository.submit(scope, { idempotencyKey: "other-agent",
      filters: { ...runtimeFilters, entraAgentApplicationIds: [otherIdentity] } });
    const legacy = await repository.submit(scope, { idempotencyKey: "legacy-mistyped-agent",
      filters: { ...runtimeFilters, entraAgentApplicationIds: [], entraAgentIds: [identity] } });
    const readScope = { tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId,
      resultScopes: [scope.resultScope], entraAgentIds: [], entraAgentApplicationIds: [identity] };
    const page = await repository.listJobs(readScope, 1, 1);
    expect(page).toMatchObject({ count: 2, limit: 1, offset: 1 });
    expect(page.value).toHaveLength(1);
    expect([activity.id, tools.id]).toContain(page.value[0].id);
    expect(await repository.listJobs({ ...readScope, entraAgentIds: [identity], entraAgentApplicationIds: [] }))
      .toMatchObject({ count: 1, value: [{ id: inventory.id }] });
    expect(await repository.getJob(readScope, inventory.id)).toBeUndefined();
    await expect(repository.cancel(readScope, inventory.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await repository.cancel(readScope, activity.id)).toMatchObject({ status: "cancelled" });
    expect((await repository.listJobs({ ...readScope, tenantId: "different-tenant" })).count).toBe(0);
    expect((await repository.listJobs({ ...readScope, authorizationPrincipalId: "different-reader",
      resultScopes: [{ kind: "principal", scopeId: "different-reader", configurationRevision: null }] })).count).toBe(0);
    for (const job of [inventory, tools, other, legacy]) await repository.cancel(scope, job.id);
  });

  it("accepts ordinary delegated and application jobs directly", async () => {
    const delegated = await repository.submit(principalScope, { idempotencyKey: "ordinary-delegated", filters });
    expect(delegated).toMatchObject({ tokenMode: "delegated", });
    const readScope = { tenantId: principalScope.tenantId, authorizationPrincipalId: principalScope.authorizationPrincipalId,
      resultScopes: [principalScope.resultScope], };
    await expect(repository.getJob(readScope, delegated.id)).resolves.toMatchObject({ id: delegated.id });
    await expect(repository.listJobs(readScope)).resolves.toMatchObject({ value: expect.arrayContaining([expect.objectContaining({ id: delegated.id })]) });
    const applicationScope: DefenderHuntingScope = {
      tenantId: principalScope.tenantId,
      authorizationPrincipalId: principalScope.authorizationPrincipalId,
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 },
      tokenMode: "application",
    };
    const application = await repository.submit(applicationScope, { idempotencyKey: "ordinary-application", filters });
    expect(application).toMatchObject({ tokenMode: "application", });
    await repository.cancel(applicationScope, application.id);
    await repository.cancel(principalScope, delegated.id);
  });

  it("rejects foreign tenant, mixed source, and arbitrary extra retained fields at publication", async () => {
    const activityFilters: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"] };
    for (const [key, row] of [
      ["foreign-tenant", activityRow({ organizationId: "foreign-tenant" })],
      ["mixed-source", inventoryRow()],
      ["extra-field", { ...activityRow(), rawSecret: "must-not-persist" }],
      ["known-scalar-object", activityRow({ targetAgentName: { secret: "must-not-persist" } as never })],
    ] as const) {
      const value = await submitAndBegin(key, principalScope, activityFilters);
      await expect(repository.publish(principalScope, value.job.id, value.execution, result([row as DefenderAgentActivityRow])))
        .rejects.toMatchObject({ code: "invalid_hunting_publication" });
      await repository.cancel(principalScope, value.job.id);
    }
  });

  it("rejects malformed nested projection states without publishing a snapshot", async () => {
    const invalidInventory = await submitAndBegin("invalid-inventory-state");
    await expect(repository.publish(principalScope, invalidInventory.job.id, invalidInventory.execution, result([inventoryRow({
      detailStates: { owners: "value", sharing: "not_supplied", permissions: "not_supplied", authentication: "not_supplied", risk: "not_exposed" } as never,
    })]))).rejects.toMatchObject({ code: "invalid_hunting_publication" });
    expect(await repository.getJob(principalScope, invalidInventory.job.id)).toMatchObject({ status: "running", snapshotId: null });
    await repository.cancel(principalScope, invalidInventory.job.id);

    const activityFilters: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"] };
    const invalidActivity = await submitAndBegin("invalid-activity-state", principalScope, activityFilters);
    await expect(repository.publish(principalScope, invalidActivity.job.id, invalidActivity.execution, result([activityRow({
      fieldStates: { ...activityRow().fieldStates, providerSecretState: "value" } as never,
    })]))).rejects.toMatchObject({ code: "invalid_hunting_publication" });
    expect(await repository.getJob(principalScope, invalidActivity.job.id)).toMatchObject({ status: "running", snapshotId: null });
    await repository.cancel(principalScope, invalidActivity.job.id);
  });

  it("keeps delegated snapshots private and shares only the exact current application scope", async () => {
    const delegated = await repository.submit(principalScope, { idempotencyKey: "private", filters, });
    expect(await repository.getJob({ tenantId: "tenant-a", authorizationPrincipalId: "security-b", resultScopes: [{ kind: "principal", scopeId: "security-b", configurationRevision: null }] }, delegated.id)).toBeUndefined();
    const applicationScope: DefenderHuntingScope = { tenantId: "tenant-a", authorizationPrincipalId: "security-a",
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 3 }, tokenMode: "application" };
    await fixture.operator.query(`UPDATE capability_configuration SET revision=3,updated_at=clock_timestamp()
      WHERE tenant_id='tenant-a' AND capability_id='defender.hunting.application'`);
    const application = await repository.submit(applicationScope, { idempotencyKey: "shared", filters, });
    expect(await repository.getJob(applicationScope, application.id)).toMatchObject({ id: application.id });
    expect(await repository.getJob({ ...applicationScope, resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 4 } }, application.id)).toBeUndefined();
    await repository.cancel(principalScope, delegated.id);
    await repository.cancel(applicationScope, application.id);
  });

  it("publishes an allowlisted successful snapshot and distinguishes valid empty no_data", async () => {
    const populated = await submitAndBegin("publish");
    await repository.authorizeProviderRequest(principalScope, populated.job.id, populated.execution);
    await repository.recordProviderResponse(principalScope, populated.job.id, populated.execution, "provider-a");
    await repository.publish(principalScope, populated.job.id, populated.execution, result([inventoryRow()]));
    expect(await repository.getJob(principalScope, populated.job.id)).toMatchObject({ status: "succeeded", complete: true, noData: false, storedRowCount: 1,
      observedRange: { startDateTime: "2026-09-09T10:30:00.000Z", endDateTime: "2026-09-09T10:30:00.000Z" }, providerRequestId: "provider-a" });
    const page = await repository.listRows(principalScope, populated.job.id);
    expect(page).toMatchObject({ count: 1, snapshot: { sourceTable: "AgentsInfo", noData: false }, value: [{ agentId: "defender-agent", association: { status: "unresolved" } }] });
    expect(JSON.stringify(page)).not.toMatch(/RawEventData|Instructions|Memory|ToolArguments|ToolResult/);

    const empty = await submitAndBegin("empty");
    await repository.publish(principalScope, empty.job.id, empty.execution, result([]));
    expect(await repository.getJob(principalScope, empty.job.id)).toMatchObject({ status: "succeeded", complete: true, noData: true, observedRange: null });
  });

  it("records truncation and the full requested interval as unobserved", async () => {
    const value = await submitAndBegin("partial");
    await repository.publish(principalScope, value.job.id, value.execution, result([inventoryRow()], false));
    expect(await repository.getJob(principalScope, value.job.id)).toMatchObject({ status: "partial", complete: false, noData: false,
      providerRowCount: 201, partialReason: "hunting_row_limit", unobservedRange: { startDateTime: filters.startDateTime, endDateTime: filters.endDateTime } });
  });

  it("fences cancellation and recovered executions from late publication", async () => {
    const cancelled = await submitAndBegin("cancel");
    await repository.cancel(principalScope, cancelled.job.id);
    await expect(repository.publish(principalScope, cancelled.job.id, cancelled.execution, result([]))).rejects.toMatchObject({ code: "hunting_execution_lost" });

    const recovered = await submitAndBegin("recovered");
    expect(await repository.recoverInterrupted()).toBeGreaterThan(0);
    const replacement = await repository.begin(principalScope, recovered.job.id);
    await expect(repository.publish(principalScope, recovered.job.id, recovered.execution, result([]))).rejects.toMatchObject({ code: "hunting_execution_lost" });
    await repository.publish(principalScope, recovered.job.id, replacement, result([]));
  });

  it("terminalizes exhausted waiting work so it cannot consume unfinished capacity", async () => {
    const expired = await repository.submit(principalScope, { idempotencyKey: "expired-waiting", filters });
    await fixture.operator.query("UPDATE defender_hunting_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    await expect(repository.begin(principalScope, expired.id)).rejects.toMatchObject({ code: "hunting_job_expired" });
    expect(await repository.getJob(principalScope, expired.id)).toMatchObject({ status: "inconclusive", errorCode: "hunting_job_expired", canResume: false });

    const exhausted = await submitAndBegin("activation-exhausted");
    await fixture.operator.query("UPDATE defender_hunting_jobs SET activation_count=4 WHERE id=$1", [exhausted.job.id]);
    await repository.markWaitingAuthorization(principalScope, exhausted.job.id, exhausted.execution);
    expect(await repository.getJob(principalScope, exhausted.job.id)).toMatchObject({ status: "inconclusive", errorCode: "hunting_activation_limit", canResume: false });
  });

  it("retains an earlier successful snapshot when a later explicit attempt fails", async () => {
    const success = await submitAndBegin("prior-success");
    await repository.publish(principalScope, success.job.id, success.execution, result([inventoryRow()]));
    const failure = await submitAndBegin("later-failure");
    await repository.fail(principalScope, failure.job.id, failure.execution, "provider_error", "Bounded provider failure.", true);
    expect(await repository.getJob(principalScope, failure.job.id)).toMatchObject({ status: "inconclusive", snapshotId: null, priorSuccessfulJobId: success.job.id });
    expect((await repository.listRows(principalScope, success.job.id)).value).toHaveLength(1);
  });

  it("does not equate opaque saved Entra agent IDs with enterprise object IDs or blueprint parent identities", async () => {
    await nativeInventoryFixture(fixture.runtime, { tenantId: "tenant-a", principalId: "security-a" },
      [{ nativeId: "power-agent", environmentId: "environment-a", identifiers: [
        { kind: "entra_agent_id", value: "11111111-1111-4111-8111-111111111111" },
        { kind: "entra_blueprint_id", value: "22222222-2222-4222-8222-222222222222" },
      ] }]);
    const exact = await submitAndBegin("exact-association", principalScope, { ...filters, agentIds: ["defender-agent"] });
    await repository.publish(principalScope, exact.job.id, exact.execution, result([inventoryRow()]));
    const readScope = { tenantId: "tenant-a", authorizationPrincipalId: "security-a", resultScopes: [principalScope.resultScope], inventoryIdentityScope: {
      principalId: "security-a", resourceTypes: ["microsoft.copilotstudio/agents" as const] } };
    expect((await repository.listRows(readScope, exact.job.id)).value[0].association).toMatchObject({ status: "unresolved", reason: "blueprint_is_parent_not_equivalence" });

    const activityFilters: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"],
      agentIds: [], blueprintIds: ["22222222-2222-4222-8222-222222222222"] };
    const activity = await repository.submit(principalScope, { idempotencyKey: "blueprint-activity", filters: activityFilters });
    const activityExecution = await repository.begin(principalScope, activity.id);
    await repository.publish(principalScope, activity.id, activityExecution,
      result([activityRow({ targetAgentBlueprintId: "22222222-2222-4222-8222-222222222222" })]));
    const child = await submitAndBegin("blueprint-child", principalScope, activityFilters);
    await repository.publish(principalScope, child.job.id, child.execution, result([activityRow({
      targetAgentBlueprintId: "22222222-2222-4222-8222-222222222222", parentSpanId: "0123456789abcdef",
      spanRole: "child", rootSpanObserved: false,
    })]));
    expect((await repository.listRows(readScope, child.job.id)).value[0].association).toEqual({ status: "unresolved", reason: "blueprint_is_parent_not_equivalence" });
  });

  it("applies finite cascading retention and prevents runtime row deletion", async () => {
    const value = await submitAndBegin("retention");
    await repository.publish(principalScope, value.job.id, value.execution, result([inventoryRow()]));
    await expect(fixture.runtime.query("DELETE FROM defender_hunting_rows WHERE snapshot_id=$1", [(await repository.getJob(principalScope, value.job.id))!.snapshotId])).rejects.toThrow();
    await fixture.operator.query("UPDATE defender_hunting_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [value.job.id]);
    await retain(fixture.operator);
    expect(await repository.getJob(principalScope, value.job.id)).toBeUndefined();
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM defender_hunting_snapshots WHERE job_id=$1", [value.job.id])).rows[0].count).toBe(0);
  });
});