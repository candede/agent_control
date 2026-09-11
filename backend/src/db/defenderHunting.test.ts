import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
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
  const retainedScope = await qualifyScope(`${key}-qualification`, scope, selectedFilters);
  const job = await repository.submit(scope, { idempotencyKey: key, filters: selectedFilters, retainedScope });
  return { job, execution: await repository.begin(scope, job.id) };
}

async function qualifyScope(key: string, scope = principalScope, selectedFilters = filters) {
  const selectedAuthority = { ...authority, capabilityId: scope.tokenMode === "delegated" ? "defender.hunting.delegated" as const : "defender.hunting.application" as const,
    configurationRevision: scope.resultScope.configurationRevision ?? authority.configurationRevision };
  const job = await repository.submit(scope, { idempotencyKey: key, filters: selectedFilters,
    qualification: { ...selectedAuthority, approvedBy: "administrator" } });
  const execution = await repository.begin(scope, job.id);
  const qualificationRow = selectedFilters.templateId === "agents_inventory"
    ? inventoryRow({ agentId: selectedFilters.agentIds[0] ?? "defender-agent", entraBlueprintId: selectedFilters.blueprintIds[0] ?? null })
    : activityRow({ actionType: selectedFilters.operations[0] ?? "InvokeAgent",
      operation: selectedFilters.operations[0]?.startsWith("ExecuteTool") ? "execute_tool" : selectedFilters.operations[0] === "InferenceCall" ? "chat" : "invoke_agent",
      targetAgentId: selectedFilters.agentIds[0] ?? null, targetAgentBlueprintId: selectedFilters.blueprintIds[0] ?? null,
      actorAccountObjectId: selectedFilters.actorObjectIds[0] ?? null,
      spanRole: selectedFilters.operations[0] === "InvokeAgent" ? "root_invoke_agent" : "unresolved",
      rootSpanObserved: selectedFilters.operations[0] === "InvokeAgent" });
  await repository.publish(scope, job.id, execution, result([qualificationRow]));
  return repository.requireQualifiedScope(scope, selectedFilters, selectedAuthority);
}

describe.sequential("Defender hunting repository", () => {
  it("filters source-detail matches by retained authorization before rows and counts", async () => {
    const scope: DefenderHuntingScope = { ...principalScope, authorizationPrincipalId: "detail-reader",
      resultScope: { kind: "principal", scopeId: "detail-reader", configurationRevision: null } };
    const { job, execution } = await submitAndBegin("detail-visibility", scope);
    await repository.publish(scope, job.id, execution, result([inventoryRow()]));
    const readScope = { tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId,
      resultScopes: [scope.resultScope], qualifications: [{ resultScope: scope.resultScope, authority }] };
    const nativeId = inventoryRow().entraAgentObjectId!;
    expect((await repository.relatedInventoryRows(readScope, nativeId)).value).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: job.id, matchedKind: "entra_agent_id" }),
    ]));
    expect(await repository.relatedInventoryRows({ ...readScope, qualifications: [] }, nativeId)).toEqual({ count: 0, value: [] });
    const retained = await repository.requireQualifiedScope(scope, filters, authority);
    await repository.revokeRetainedScope(readScope, retained.id, scope.authorizationPrincipalId);
    expect(await repository.relatedInventoryRows(readScope, nativeId)).toEqual({ count: 0, value: [] });
  });

  it("qualifies only one exact bounded template and target scope", async () => {
    const qualifiedFilters = filters;
    const qualified = await repository.submit(principalScope, { idempotencyKey: "qualified-scope", filters: qualifiedFilters,
      qualification: { ...authority, approvedBy: "administrator" } });
    const execution = await repository.begin(principalScope, qualified.id);
    await repository.publish(principalScope, qualified.id, execution, result([inventoryRow()]));
    await expect(repository.requireQualifiedScope(principalScope, qualifiedFilters, authority)).resolves.toMatchObject({
      id: expect.any(String), authority,
    });
    await expect(repository.requireQualifiedScope(principalScope, { ...qualifiedFilters, templateId: "agent_activity", operations: ["InvokeAgent"] }, authority))
      .rejects.toMatchObject({ code: "hunting_scope_unqualified" });
    await expect(repository.submit(principalScope, { idempotencyKey: "unbounded-qualification", filters: { ...filters, agentIds: [] },
      qualification: { ...authority, approvedBy: "administrator" } })).rejects.toMatchObject({ code: "invalid_qualification" });
  });

  it("cannot publish old application qualification evidence across a configuration update race", async () => {
    const applicationScope: DefenderHuntingScope = { tenantId: "tenant-a", authorizationPrincipalId: "security-a",
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 1 }, tokenMode: "application" };
    const qualifiedFilters = { ...filters, agentIds: ["defender-agent"] };
    await fixture.operator.query(`INSERT INTO capability_configuration
      (tenant_id,capability_id,enabled,shared_data_scope,updated_by) VALUES('tenant-a','defender.hunting.application',true,true,'administrator')`);
    const job = await repository.submit(applicationScope, { idempotencyKey: "application-configuration-race", filters: qualifiedFilters,
      qualification: { capabilityId: "defender.hunting.application", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64),
        configurationRevision: 1, approvedBy: "administrator" } });
    const execution = await repository.begin(applicationScope, job.id);
    const configurationWriter = await fixture.operator.connect();
    try {
      await configurationWriter.query("BEGIN");
      await configurationWriter.query(`UPDATE capability_configuration SET revision=2,updated_at=clock_timestamp()
        WHERE tenant_id='tenant-a' AND capability_id='defender.hunting.application'`);
      const publication = repository.publish(applicationScope, job.id, execution, result([inventoryRow()]));
      await vi.waitFor(async () => expect(Number((await fixture.operator.query<{ count: string }>(`SELECT count(*) AS count FROM pg_stat_activity
        WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`)).rows[0].count)).toBeGreaterThan(0));
      await configurationWriter.query("COMMIT");
      await expect(publication).rejects.toMatchObject({ code: "qualification_superseded" });
    } finally {
      await configurationWriter.query("ROLLBACK").catch(() => undefined);
      configurationWriter.release();
    }
    expect((await fixture.operator.query("SELECT id FROM defender_hunting_qualification_evidence WHERE qualified_job_id=$1", [job.id])).rowCount).toBe(0);
    expect(await repository.getJob(applicationScope, job.id)).toMatchObject({ status: "running", snapshotId: null });
    await repository.cancel(applicationScope, job.id);
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
    const delegatedRetained = await qualifyScope("private-qualification");
    const delegated = await repository.submit(principalScope, { idempotencyKey: "private", filters, retainedScope: delegatedRetained });
    expect(await repository.getJob({ tenantId: "tenant-a", authorizationPrincipalId: "security-b", resultScopes: [{ kind: "principal", scopeId: "security-b", configurationRevision: null }] }, delegated.id)).toBeUndefined();
    const applicationScope: DefenderHuntingScope = { tenantId: "tenant-a", authorizationPrincipalId: "security-a",
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 3 }, tokenMode: "application" };
    await fixture.operator.query(`UPDATE capability_configuration SET revision=3,updated_at=clock_timestamp()
      WHERE tenant_id='tenant-a' AND capability_id='defender.hunting.application'`);
    const applicationRetained = await qualifyScope("shared-qualification", applicationScope);
    const application = await repository.submit(applicationScope, { idempotencyKey: "shared", filters, retainedScope: applicationRetained });
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
    const retainedScope = await qualifyScope("expired-waiting-qualification");
    const expired = await repository.submit(principalScope, { idempotencyKey: "expired-waiting", filters, retainedScope });
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

  it("associates only an explicit exact Entra agent ID and never treats a matching blueprint as child equivalence", async () => {
    const inventoryJob = (await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_refresh_jobs
      (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types,status)
      VALUES(gen_random_uuid(),'tenant-a','security-a','defender-association',repeat('a',64),'full','["microsoft.copilotstudio/agents"]','succeeded') RETURNING id`)).rows[0].id;
    const snapshot = (await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_inventory_snapshots
      (id,job_id,tenant_id,principal_id,query_hash,role_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count)
      VALUES(gen_random_uuid(),$1,'tenant-a','security-a',repeat('a',64),'full','["microsoft.copilotstudio/agents"]',$2,1,1,1,0) RETURNING id`,
    [inventoryJob, JSON.stringify(Array.from({ length: 11 }, () => ({ type: "fixture", status: "unknown", count: null })))])).rows[0].id;
    await fixture.operator.query(`INSERT INTO power_platform_inventory_resources
      (snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,source_system,creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
      VALUES($1,'tenant-a','security-a','power-agent','microsoft.copilotstudio/agents','environment-a','power_platform','unknown','copilot_studio_agent','unknown','exact_native',$2,'{}','{}',0)`,
    [snapshot, JSON.stringify([{ kind: "entra_agent_id", value: "11111111-1111-4111-8111-111111111111" }, { kind: "entra_blueprint_id", value: "22222222-2222-4222-8222-222222222222" }])]);
    const exact = await submitAndBegin("exact-association", principalScope, { ...filters, agentIds: ["defender-agent"] });
    await repository.publish(principalScope, exact.job.id, exact.execution, result([inventoryRow()]));
    const readScope = { tenantId: "tenant-a", authorizationPrincipalId: "security-a", resultScopes: [principalScope.resultScope], qualifications: [{ resultScope: principalScope.resultScope,
      authority: { capabilityId: "defender.hunting.delegated" as const, contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 } }], inventoryIdentityScope: {
      principalId: "security-a", roleScope: "full" as const, resourceTypes: ["microsoft.copilotstudio/agents" as const] } };
    expect((await repository.listRows(readScope, exact.job.id)).value[0].association).toMatchObject({ status: "resolved", nativeId: "power-agent", matchedKind: "entra_agent_id" });

    const activityFilters: DefenderHuntingFilters = { ...filters, templateId: "agent_activity", operations: ["InvokeAgent"],
      agentIds: [], blueprintIds: ["22222222-2222-4222-8222-222222222222"] };
    const activityQualification = await repository.submit(principalScope, { idempotencyKey: "blueprint-qualification", filters: activityFilters,
      qualification: { capabilityId: "defender.hunting.delegated", contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "administrator" } });
    const activityQualificationExecution = await repository.begin(principalScope, activityQualification.id);
    await repository.publish(principalScope, activityQualification.id, activityQualificationExecution,
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