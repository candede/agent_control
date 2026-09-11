import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { PurviewAuditFilters, PurviewAuditPartialReason, PurviewAuditRecord, PurviewAuditResult } from "../types/purviewAudit.js";
import { PurviewAuditRepository, type PurviewAuditScope } from "./purviewAudit.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: PurviewAuditRepository;
const scope: PurviewAuditScope = { tenantId: "tenant-a", authorizationPrincipalId: "reader-a",
  resultScope: { kind: "principal", scopeId: "reader-a", configurationRevision: null }, tokenMode: "delegated" };
const filters: PurviewAuditFilters = { presetId: "copilot_interactions", operations: ["CopilotInteraction"], startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z", userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };

beforeAll(async () => { fixture = await testDatabase(); repository = new PurviewAuditRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

function record(overrides: Partial<PurviewAuditRecord> = {}): PurviewAuditRecord {
  return { projectionVersion: 1, wrapperId: "wrapper-1", nativeEventId: "11111111-1111-4111-8111-111111111111", eventDateTime: "2026-09-09T10:30:00.000Z",
    auditLogRecordType: "copilotInteraction", operation: "CopilotInteraction", service: "Copilot", resultStatus: "Succeeded", actorUserId: "actor-a",
    actorUserPrincipalName: "reader@example.invalid", actorUserType: "regular", objectId: "object-a", clientIp: "192.0.2.1", administrativeUnits: [],
    correlationId: "correlation-a", agentId: "agent-a", appIdentity: "app-a", appHost: "Teams", botId: null, environmentId: null,
    botComponentId: null, aiPluginOperationId: null, messages: [{ id: "message-a", isPrompt: true }], contentAvailable: false, unknownFieldCount: 2, ...overrides };
}

function result(records: PurviewAuditRecord[], complete = true, partialReason: PurviewAuditPartialReason = "audit_page_limit"): PurviewAuditResult {
  return { records, pageCount: 1, providerRowCount: records.length, storedRowCount: records.length, byteCount: 1024, unknownFieldCount: records.reduce((count, value) => count + value.unknownFieldCount, 0), complete,
    nextLink: complete ? null : "https://graph.microsoft.com/v1.0/security/auditLog/queries/provider/records?$skiptoken=opaque", partialReason: complete ? null : partialReason };
}

async function submitAndBegin(key: string, owner = scope) {
  const job = await repository.submit(owner, { idempotencyKey: key, filters });
  const execution = await repository.begin(owner, job.id);
  expect(execution.action).toBe("create");
  return { ...job, execution };
}

describe.sequential("Purview audit repository", () => {
  it("keeps delegated results private and shares application results only under the current configured scope", async () => {
    const job = await repository.submit(scope, { idempotencyKey: "private", filters });
    expect(job).toMatchObject({ status: "waiting_authorization", displayName: `agent-control-audit:${job.id}`, providerQueryId: null, attemptedAt: null });
    expect(await repository.submit(scope, { idempotencyKey: "private", filters })).toMatchObject({ id: job.id });
    expect((await repository.listJobs({ tenantId: scope.tenantId, resultScopes: [{ kind: "principal", scopeId: "reader-b", configurationRevision: null }] })).value).toEqual([]);

    const applicationScope: PurviewAuditScope = { ...scope,
      resultScope: { kind: "application", scopeId: "application-client", configurationRevision: 7 }, tokenMode: "application" };
    const applicationJob = await repository.submit(applicationScope, { idempotencyKey: "application-shared", filters });
    const readerBCurrent = { tenantId: scope.tenantId, resultScopes: [
      { kind: "principal" as const, scopeId: "reader-b", configurationRevision: null },
      { kind: "application" as const, scopeId: "application-client", configurationRevision: 7 },
    ] };
    expect((await repository.listJobs(readerBCurrent)).value.map(value => value.id)).toContain(applicationJob.id);
    expect(await repository.getJob(readerBCurrent, applicationJob.id)).toMatchObject({ resultScope: applicationScope.resultScope });
    expect(await repository.getJob({ tenantId: scope.tenantId, resultScopes: [{ kind: "application", scopeId: "application-client", configurationRevision: 8 }] }, applicationJob.id)).toBeUndefined();
    expect(await repository.getJob({ tenantId: "tenant-b", resultScopes: [applicationScope.resultScope] }, applicationJob.id)).toBeUndefined();
    await repository.cancel(scope, job.id);
    await repository.cancel(applicationScope, applicationJob.id);
  });

  it("rejects non-string idempotency keys before persistence", async () => {
    for (const idempotencyKey of [7, true, ["coerced"]]) {
      await expect(repository.submit(scope, { idempotencyKey, filters } as never)).rejects.toMatchObject({ code: "invalid_idempotency_key" });
    }
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM purview_audit_jobs WHERE tenant_id=$1 AND idempotency_key IN ('7','true','coerced')", [scope.tenantId])).rows[0].count).toBe(0);
  });

  it("preserves ambiguous create for reconciliation across restart without a second create stage", async () => {
    const job = await submitAndBegin("ambiguous");
    await repository.authorizeProviderRequest(scope, job.id, job.execution);
    expect((await repository.getJob(scope, job.id))?.status).toBe("reconciling_create");
    expect(await repository.recoverInterrupted()).toBeGreaterThan(0);
    expect(await repository.getJob(scope, job.id)).toMatchObject({ status: "waiting_authorization", canResume: true, providerQueryId: null });
    expect((await repository.begin(scope, job.id)).action).toBe("reconcile");
    await repository.cancel(scope, job.id);
  });

  it("durably binds provider identity, publishes minimized records, and reports complete range coverage", async () => {
    const job = await submitAndBegin("publish");
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-query-a", "running");
    await repository.recordProviderStatus(scope, job.id, job.execution, "succeeded");
    await repository.publish(scope, job.id, job.execution, result([record()]));
    expect(await repository.getJob(scope, job.id)).toMatchObject({ status: "succeeded", providerQueryId: "provider-query-a", providerStatus: "succeeded", pageComplete: true,
      storedRowCount: 1, observedRange: { startDateTime: "2026-09-09T10:30:00.000Z", endDateTime: "2026-09-09T10:30:00.000Z" }, unobservedRange: null, projectionVersion: 1 });
    const page = await repository.listRecords(scope, job.id);
    expect(page).toMatchObject({ count: 1, value: [{ wrapperId: "wrapper-1", contentAvailable: false, messages: [{ id: "message-a", isPrompt: true }] }] });
    expect(JSON.stringify(page)).not.toContain("auditData");
    await expect(repository.listRecords({ tenantId: scope.tenantId, resultScopes: [{ kind: "principal", scopeId: "reader-b", configurationRevision: null }] }, job.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("marks bounded publication partial and leaves the entire requested range unobserved", async () => {
    const job = await submitAndBegin("partial");
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-query-partial", "succeeded");
    await repository.publish(scope, job.id, job.execution, result([record({ wrapperId: "partial", nativeEventId: "22222222-2222-4222-8222-222222222222" })], false));
    expect(await repository.getJob(scope, job.id)).toMatchObject({ status: "partial", pageComplete: false,
      observedRange: { startDateTime: "2026-09-09T10:30:00.000Z", endDateTime: "2026-09-09T10:30:00.000Z" },
      unobservedRange: { startDateTime: filters.startDateTime, endDateTime: filters.endDateTime }, errorCode: "audit_page_limit" });
  });

  it("retains the specific safe provider reason for a partial result", async () => {
    const job = await submitAndBegin("provider-partial");
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-query-provider-partial", "succeeded");
    await repository.publish(scope, job.id, job.execution, result([
      record({ wrapperId: "provider-partial", nativeEventId: "88888888-8888-4888-8888-888888888888" }),
    ], false, "provider_error"));
    expect(await repository.getJob(scope, job.id)).toMatchObject({ status: "partial", pageComplete: false, errorCode: "provider_error" });
  });

  it("associates only exact BotId plus environment matches from the reader's current inventory", async () => {
    const inventoryJob = (await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_refresh_jobs
      (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types,status)
      VALUES(gen_random_uuid(),$1,$2,'audit-association',repeat('a',64),'full','["microsoft.copilotstudio/agents"]','succeeded') RETURNING id`, [scope.tenantId, scope.resultScope.scopeId])).rows[0].id;
    const snapshot = (await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_inventory_snapshots
      (id,job_id,tenant_id,principal_id,query_hash,role_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count)
      VALUES(gen_random_uuid(),$1,$2,$3,repeat('a',64),'full','["microsoft.copilotstudio/agents"]',$4,1,1,1,0) RETURNING id`,
      [inventoryJob, scope.tenantId, scope.resultScope.scopeId, JSON.stringify(Array.from({ length: 11 }, () => ({ type: "fixture", status: "unknown", count: null })))])).rows[0].id;
    await fixture.operator.query(`INSERT INTO power_platform_inventory_resources
      (snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,source_system,creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
      VALUES($1,$2,$3,'inventory-agent','microsoft.copilotstudio/agents','environment-a','power_platform','unknown','copilot_studio_agent','unknown','exact_native',$4,'{}','{}',0)`,
    [snapshot, scope.tenantId, scope.resultScope.scopeId, JSON.stringify([{ kind: "cds_bot_id", value: "bot-a" }])]);
    const job = await submitAndBegin("association");
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-query-association", "succeeded");
    await repository.publish(scope, job.id, job.execution, result([
      record({ wrapperId: "exact", nativeEventId: "33333333-3333-4333-8333-333333333333", auditLogRecordType: "powerPlatformAdministratorActivity", operation: "BotCreate", service: "PowerPlatform", botId: "bot-a", environmentId: "environment-a", agentId: null }),
      record({ wrapperId: "missing-env", nativeEventId: "44444444-4444-4444-8444-444444444444", auditLogRecordType: "powerPlatformAdministratorActivity", operation: "BotCreate", service: "PowerPlatform", botId: "bot-a", environmentId: null, agentId: null }),
      record({ wrapperId: "copilot-agent", nativeEventId: "55555555-5555-4555-8555-555555555555", botId: null, agentId: "agent-a" }),
    ]));
    const values = (await repository.listRecords({ tenantId: scope.tenantId, resultScopes: [scope.resultScope],
      inventoryIdentityScope: { principalId: scope.authorizationPrincipalId, roleScope: "full", resourceTypes: ["microsoft.copilotstudio/agents"] } } as never, job.id)).value;
    expect(values.find(value => value.wrapperId === "exact")?.association).toEqual({ status: "resolved", sourceSystem: "power_platform", nativeId: "inventory-agent", resourceType: "microsoft.copilotstudio/agents", environmentId: "environment-a", matchedKind: "cds_bot_id" });
    expect(values.find(value => value.wrapperId === "missing-env")?.association).toEqual({ status: "unresolved", reason: "missing_environment" });
    expect(values.find(value => value.wrapperId === "copilot-agent")?.association).toEqual({ status: "unresolved", reason: "no_documented_cross_source_relation" });
  });

  it("records cancellation as local-only and fences late provider publication", async () => {
    const job = await submitAndBegin("cancel");
    await repository.authorizeProviderRequest(scope, job.id, job.execution);
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-query-cancel", "running");
    expect(await repository.cancel(scope, job.id)).toMatchObject({ status: "cancelled", providerQueryId: "provider-query-cancel", remoteWorkMayContinue: true });
    await expect(repository.recordProviderStatus(scope, job.id, job.execution, "succeeded")).rejects.toMatchObject({ code: "audit_job_state" });
    await expect(repository.publish(scope, job.id, job.execution, result([]))).rejects.toMatchObject({ code: "audit_execution_lost" });
  });

  it("closes cancelled and deleted qualification runs so a replacement can be approved", async () => {
    const qualificationInput = { filters, capabilityId: "purview.audit.search.delegated" as const,
      contractRevision: "1".repeat(64), permissionRevision: "2".repeat(64), configurationRevision: 1, approvedBy: "administrator-a" };
    const cancelledQualification = await repository.approveQualification(scope, qualificationInput);
    const cancelledJob = await repository.submit(scope, { idempotencyKey: "qualification-cancelled", filters, qualificationId: cancelledQualification.id });
    await repository.begin(scope, cancelledJob.id);
    await repository.cancel(scope, cancelledJob.id);
    expect(await repository.getQualification(scope.tenantId, cancelledQualification.id)).toMatchObject({ status: "failed", errorCode: "audit_cancelled" });

    const deletedQualification = await repository.approveQualification(scope, { ...qualificationInput, contractRevision: "3".repeat(64) });
    const deletedJob = await repository.submit(scope, { idempotencyKey: "qualification-deleted", filters, qualificationId: deletedQualification.id });
    await repository.delete(scope, deletedJob.id);
    expect(await repository.getQualification(scope.tenantId, deletedQualification.id)).toMatchObject({ status: "failed", errorCode: "audit_deleted" });
    const replacement = await repository.approveQualification(scope, { ...qualificationInput, contractRevision: "4".repeat(64) });
    expect(replacement.status).toBe("approved");
    await fixture.operator.query("UPDATE purview_audit_qualifications SET status='failed',finished_at=clock_timestamp() WHERE id=$1", [replacement.id]);
  });

  it("fences a recovered execution from mutating or publishing over its replacement", async () => {
    const job = await submitAndBegin("stale-execution");
    await repository.authorizeProviderRequest(scope, job.id, job.execution);
    await repository.recoverInterrupted();
    const replacement = await repository.begin(scope, job.id);
    expect(replacement.version).toBe(job.execution.version + 1);
    await expect(repository.recordProviderQuery(scope, job.id, job.execution, "stale-query", "succeeded")).rejects.toMatchObject({ code: "audit_job_state" });
    await expect(repository.markWaitingAuthorization(scope, job.id, job.execution)).rejects.toMatchObject({ code: "audit_execution_lost" });
    await expect(repository.publish(scope, job.id, job.execution, result([record({ wrapperId: "stale" })]))).rejects.toMatchObject({ code: "audit_execution_lost" });
    await repository.recordProviderQuery(scope, job.id, replacement, "replacement-query", "succeeded");
    await repository.publish(scope, job.id, replacement, result([]));
    expect(await repository.getJob(scope, job.id)).toMatchObject({ status: "succeeded", providerQueryId: "replacement-query", storedRowCount: 0 });
  });

  it("reserves durable provider and activation budgets before work starts", async () => {
    const requests = await submitAndBegin("request-budget");
    await fixture.operator.query("UPDATE purview_audit_jobs SET provider_request_count=63 WHERE id=$1", [requests.id]);
    await repository.authorizeProviderRequest(scope, requests.id, requests.execution);
    await expect(repository.authorizeProviderRequest(scope, requests.id, requests.execution)).rejects.toMatchObject({ code: "audit_provider_request_limit" });
    await repository.recordProviderResponse(scope, requests.id, requests.execution, "provider-request-64");
    expect(await repository.getJob(scope, requests.id)).toMatchObject({ providerRequestCount: 64, providerRequestId: "provider-request-64" });
    await repository.cancel(scope, requests.id);

    const activationJob = await repository.submit(scope, { idempotencyKey: "activation-budget", filters });
    await fixture.operator.query("UPDATE purview_audit_jobs SET activation_count=11 WHERE id=$1", [activationJob.id]);
    await repository.begin(scope, activationJob.id);
    await repository.recoverInterrupted();
    expect(await repository.getJob(scope, activationJob.id)).toMatchObject({ status: "inconclusive", errorCode: "audit_activation_limit", activationCount: 12, canResume: false });
    await expect(repository.begin(scope, activationJob.id)).rejects.toMatchObject({ code: "audit_job_state" });
  });

  it("makes reached request and activation caps terminal during waiting and recovery", async () => {
    const requestCap = await submitAndBegin("request-cap-terminal");
    await fixture.operator.query("UPDATE purview_audit_jobs SET provider_request_count=64 WHERE id=$1", [requestCap.id]);
    await expect(repository.markWaitingAuthorization(scope, requestCap.id, requestCap.execution)).resolves.toMatchObject({ status: "inconclusive", errorCode: "audit_provider_request_limit", canResume: false });

    const activationCap = await submitAndBegin("activation-cap-terminal");
    await fixture.operator.query("UPDATE purview_audit_jobs SET activation_count=12 WHERE id=$1", [activationCap.id]);
    await repository.recoverInterrupted();
    expect(await repository.getJob(scope, activationCap.id)).toMatchObject({ status: "inconclusive", errorCode: "audit_activation_limit", canResume: false });
  });

  it("sets remote continuation only when inconclusive work may actually still run", async () => {
    const unsent = await submitAndBegin("failure-unsent");
    await repository.fail(scope, unsent.id, unsent.execution, "provider_schema", "schema", true);
    expect(await repository.getJob(scope, unsent.id)).toMatchObject({ status: "inconclusive", remoteWorkMayContinue: false });

    const attempted = await submitAndBegin("failure-attempted");
    await repository.authorizeProviderRequest(scope, attempted.id, attempted.execution);
    await repository.fail(scope, attempted.id, attempted.execution, "provider_error", "network", true);
    expect(await repository.getJob(scope, attempted.id)).toMatchObject({ status: "inconclusive", remoteWorkMayContinue: true });

    const terminal = await submitAndBegin("failure-terminal-provider");
    await repository.recordProviderQuery(scope, terminal.id, terminal.execution, "provider-terminal", "failed");
    await repository.fail(scope, terminal.id, terminal.execution, "provider_query_failed", "failed", true);
    expect(await repository.getJob(scope, terminal.id)).toMatchObject({ status: "inconclusive", remoteWorkMayContinue: false });
  });

  it("does not inspect private inventory when the current read lacks explicit Reader identity scope", async () => {
    const job = await submitAndBegin("association-no-reader");
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-no-reader", "succeeded");
    await repository.publish(scope, job.id, job.execution, result([record({ wrapperId: "no-reader", nativeEventId: "99999999-9999-4999-8999-999999999999", botId: "bot-a", environmentId: "environment-a" })]));
    const query = vi.spyOn(fixture.runtime, "query");
    try {
      const values = (await repository.listRecords(scope, job.id)).value;
      expect(values[0].association).toEqual({ status: "unresolved", reason: "no_documented_cross_source_relation" });
      expect(query.mock.calls.some(call => String(call[0]).includes("power_platform_inventory_resources"))).toBe(false);
    } finally {
      query.mockRestore();
    }
  });

  it("requires exact qualification scope and records successful fixture lifecycle without fabricating capability evidence", async () => {
    const qualificationFilters = { ...filters, startDateTime: "2026-09-09T10:30:00.000Z" };
    const qualification = await repository.approveQualification(scope, { filters: qualificationFilters, capabilityId: "purview.audit.search.delegated",
      contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: "administrator-a" });
    expect(qualification).toMatchObject({ status: "approved", jobId: null });
    await expect(repository.submit({ ...scope, resultScope: { kind: "principal", scopeId: "reader-b", configurationRevision: null }, authorizationPrincipalId: "reader-b" },
      { idempotencyKey: "wrong-qualification", filters: qualificationFilters, qualificationId: qualification.id })).rejects.toMatchObject({ code: "qualification_mismatch" });
    const job = await repository.submit(scope, { idempotencyKey: "qualification", filters: qualificationFilters, qualificationId: qualification.id });
    const execution = await repository.begin(scope, job.id);
    expect(execution.action).toBe("create");
    await repository.recordProviderQuery(scope, job.id, execution, "provider-query-qualification", "succeeded");
    await repository.publish(scope, job.id, execution, result([]));
    expect(await repository.getQualification(scope.tenantId, qualification.id)).toMatchObject({ status: "qualified", jobId: job.id });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM capability_evidence WHERE capability_id LIKE 'purview.audit.%'")).rows[0].count).toBe(0);
  });

  it("deletes only local cache rows and applies operator retention without runtime record deletion", async () => {
    const job = await submitAndBegin("delete-local");
    await repository.recordProviderQuery(scope, job.id, job.execution, "provider-query-delete", "succeeded");
    await repository.publish(scope, job.id, job.execution, result([record({ wrapperId: "delete", nativeEventId: "66666666-6666-4666-8666-666666666666" })]));
    await expect(fixture.runtime.query("DELETE FROM purview_audit_records WHERE job_id=$1", [job.id])).rejects.toThrow();
    await repository.delete(scope, job.id);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM purview_audit_records WHERE job_id=$1", [job.id])).rows[0].count).toBe(0);

    const ambiguous = await submitAndBegin("retention-ambiguous");
    await repository.authorizeProviderRequest(scope, ambiguous.id, ambiguous.execution);
    await fixture.operator.query("UPDATE purview_audit_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [ambiguous.id]);
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT status,error_code,remote_work_may_continue FROM purview_audit_jobs WHERE id=$1", [ambiguous.id])).rows)
      .toEqual([{ status: "inconclusive", error_code: "audit_job_expired", remote_work_may_continue: true }]);

    const expired = await submitAndBegin("retention");
    await repository.recordProviderQuery(scope, expired.id, expired.execution, "provider-query-retention", "succeeded");
    await repository.publish(scope, expired.id, expired.execution, result([]));
    await fixture.operator.query("UPDATE purview_audit_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.id]);
    await retain(fixture.operator);
    expect(await repository.getJob(scope, expired.id)).toBeUndefined();

    const qualification = await repository.approveQualification(scope, { filters, capabilityId: "purview.audit.search.delegated",
      contractRevision: "d".repeat(64), permissionRevision: "e".repeat(64), configurationRevision: 2, approvedBy: "administrator-a" });
    const qualifiedJob = await repository.submit(scope, { idempotencyKey: "retained-qualification", filters, qualificationId: qualification.id });
    const qualifiedExecution = await repository.begin(scope, qualifiedJob.id);
    await repository.recordProviderQuery(scope, qualifiedJob.id, qualifiedExecution, "provider-query-retained-qualification", "succeeded");
    await repository.publish(scope, qualifiedJob.id, qualifiedExecution, result([]));
    await fixture.operator.query("UPDATE purview_audit_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [qualifiedJob.id]);
    await fixture.operator.query("UPDATE purview_audit_qualifications SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [qualification.id]);
    await retain(fixture.operator);
    expect(await repository.getJob(scope, qualifiedJob.id)).toBeUndefined();
    expect(await repository.getQualification(scope.tenantId, qualification.id)).toMatchObject({ status: "expired", jobId: null });
    await fixture.operator.query("UPDATE purview_audit_qualifications SET expires_at=clock_timestamp()-interval '31 days' WHERE id=$1", [qualification.id]);
    await retain(fixture.operator);
    expect(await repository.getQualification(scope.tenantId, qualification.id)).toBeUndefined();
  });
});