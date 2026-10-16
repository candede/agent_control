import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AuditLog } from "./auditLog.js";
import { currentActionOrigin, originCsv, unknownOrigin, withActionOrigin } from "./actionOrigin.js";
import { buildBoundedCsv } from "./csvEncoding.js";
import { createJobConfirmation, JobRepository } from "../db/jobs.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "../db/copilotStudioQuarantine.js";
import { NativeInventory } from "../db/nativeInventory.js";
import { nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import type { AuditOriginV1 } from "../types/actionOrigin.js";
import { DefenderHuntingRepository } from "../db/defenderHunting.js";
import { saveUsageInventory, usageAudit, usageIdentity } from "../db/agentUsageTestSupport.js";
import { InventoryMutationStages } from "../db/inventoryMutationStages.js";
import { OfficialReportImports } from "../db/officialReportImports.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const scope = { tenantId: "origin-tenant", principalId: "origin-principal" };
const actor = { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "origin@example.invalid", displayName: "Original actor" };
const reported = (value: string) => ({ value, evidence: "reported" as const });
const mcp: AuditOriginV1 = { ...unknownOrigin, channel: "mcp", integrationClientId: "44444444-4444-4444-4444-444444444444",
  client: { id: reported("client-a"), name: reported("=1+1"), version: reported("1") },
  callingAgent: { id: reported("caller-a"), name: reported("<script>inert</script>") }, requestId: randomUUID(), mcpCallId: "123" };
const web: AuditOriginV1 = { ...unknownOrigin, channel: "webapp", integrationClientId: "22222222-2222-2222-2222-222222222222", requestId: randomUUID() };
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });
describe.sequential("durable audit initiating provenance", () => {
  it("retains accepted upload origin when detached callbacks run under another request and audits later discard independently", async () => {
    const selected = await usageIdentity(fixture.runtime, { ...scope, principalId: "origin-upload-principal" });
    const imports = new OfficialReportImports(fixture.runtime), bundleId = randomUUID();
    const upload = await withActionOrigin(mcp, () => imports.open(selected, { bundleId }));
    const ingestion = (await fixture.runtime.query("SELECT id,origin FROM official_usage_ingestions WHERE bundle_id=$1", [bundleId])).rows[0];
    expect(ingestion.origin).toEqual(mcp);
    await expect(fixture.runtime.query("UPDATE official_usage_ingestions SET origin=$2 WHERE id=$1", [ingestion.id, web])).rejects.toThrow("immutable");
    const csv = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nuser,Name,1,1,\n";
    await withActionOrigin(web, () => upload.receive((async function* () { yield Buffer.from(csv); })()));
    const preview = await withActionOrigin(web, () => upload.finish());
    await withActionOrigin(web, () => imports.discard(selected, preview.id));
    const events = (await fixture.runtime.query("SELECT action,origin FROM official_usage_audit WHERE tenant_id=$1 AND actor_principal_id=$2 ORDER BY observed_at,id",
      [selected.tenantId, selected.principalId])).rows;
    expect(events.find(event => event.action === "staged")?.origin).toEqual(mcp);
    expect(events.find(event => event.action === "discarded")?.origin).toEqual(web);
  });
  it("captures the execution transport at the atomic stage/job/audit handoff rather than the preview context", async () => {
    const stagedScope = { ...scope, principalId: "origin-staged-principal" };
    await saveUsageInventory(fixture.runtime, stagedScope, [{ packages: ["staged-target"] }]);
    const identity = await usageIdentity(fixture.runtime, stagedScope), stages = new InventoryMutationStages(fixture.runtime);
    const selection = await stages.currentSelection(identity), intent = { ...usageAudit(stagedScope), action: "block" as const, scope: "single" as const };
    const preview = await withActionOrigin(web, () => stages.preview(identity, selection, intent, ["staged-target"]));
    expect((await fixture.runtime.query("SELECT origin FROM inventory_mutation_stages WHERE confirmation_hash=$1", [preview.confirmationHash])).rows[0].origin).toEqual(unknownOrigin);
    const input = { ...intent, ids: ["staged-target"], confirmationHash: preview.confirmationHash, idempotencyKey: randomUUID() };
    const job = await withActionOrigin(mcp, () => stages.submit(identity, input));
    expect(job.origin).toEqual(mcp);
    expect((await fixture.runtime.query("SELECT origin FROM inventory_mutation_stages WHERE job_id=$1", [job.id])).rows[0].origin).toEqual(mcp);
    expect((await new AuditLog(stagedScope, fixture.runtime).listEvents({ operationIdPrefix: job.id }))[0].origin).toEqual(mcp);
    expect(await withActionOrigin(web, () => stages.submit(identity, input))).toMatchObject({ id: job.id, origin: mcp });
    await expect(fixture.runtime.query("UPDATE inventory_mutation_stages SET origin=$2 WHERE job_id=$1", [job.id, web])).rejects.toThrow("immutable");
  });
  it("persists hunting initiator at accepted submission and does not replace it on replay/activation/recovery", async () => {
    const repository = new DefenderHuntingRepository(fixture.runtime);
    const selected = { tenantId: scope.tenantId, authorizationPrincipalId: scope.principalId, tokenMode: "delegated" as const,
      resultScope: { kind: "principal" as const, scopeId: scope.principalId, configurationRevision: null } };
    const intent = { idempotencyKey: randomUUID(), actor, filters: { templateId: "agents_inventory" as const,
      startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z",
      agentIds: ["defender-agent"], blueprintIds: [], actorObjectIds: [], operations: [] },
      qualification: { capabilityId: "defender.hunting.delegated" as const, contractRevision: "a".repeat(64),
        permissionRevision: "b".repeat(64), configurationRevision: 1, approvedBy: scope.principalId } };
    const job = await withActionOrigin(mcp, () => repository.submit(selected, intent));
    expect(job).toMatchObject({ origin: mcp, initiatingActor: actor });
    expect(await withActionOrigin(web, () => repository.submit(selected, { ...intent, actor: { ...actor, displayName: "Later actor" } })))
      .toMatchObject({ id: job.id, origin: mcp, initiatingActor: actor });
    await withActionOrigin(web, () => repository.begin(selected, job.id));
    expect(await repository.getJob(selected, job.id)).toMatchObject({ origin: mcp, initiatingActor: actor });
    await expect(fixture.runtime.query("UPDATE defender_hunting_jobs SET initiating_actor=$2 WHERE id=$1",
      [job.id, { ...actor, displayName: "Replacement" }])).rejects.toThrow("immutable");
  });
  it("keeps batch/status/latest/list/count/detail/export filters private and exact, CSV labels inert and formula safe", async () => {
    const log = new AuditLog(scope, fixture.runtime);
    const input = { operationId: "origin-batch", action: "block" as const, targetBlockedState: true, scope: "bulk" as const,
      agentId: "target", actor, requestPath: "/api/agents/block" };
    const events = await withActionOrigin(mcp, () => log.requestEvents([input, { ...input, agentId: "target-two" }]));
    await withActionOrigin(web, () => log.completeEvent(events[0].id, { status: "succeeded" }));
    await withActionOrigin(web, () => log.startEvent({ ...input, operationId: "web-origin" }));
    await new AuditLog({ ...scope, principalId: "other" }, fixture.runtime).startEvent({ ...input, origin: mcp, actor: { ...actor, homeAccountId: "other" } });
    const filters = { originChannel: "mcp" as const, originClientId: "client-a", originCallingAgentId: "caller-a", originIntegrationClientId: mcp.integrationClientId! };
    expect(await log.countEvents(filters)).toBe(2);
    expect(await log.countEvents({ ...filters, originClientId: "client_%" })).toBe(0);
    expect(await log.countEvents({ ...filters, search: "<script>inert" })).toBe(2);
    expect(await log.listEvents({ ...filters, limit: 1, offset: 1 })).toHaveLength(1);
    for (const event of await log.getExportEvents(events.map(event => event.id))) expect(event.origin).toEqual(mcp);
    // JSONB property order is storage-specific, compare semantic objects instead.
    expect((await fixture.runtime.query("SELECT origin FROM audit_events WHERE event_id=$1", [events[0].id])).rows.map(row => row.origin)).toEqual([mcp, mcp]);
    const csv = buildBoundedCsv(Object.keys(originCsv(mcp)), [originCsv(mcp)], { maximumRows: 1, maximumBytes: 4096, deadlineAt: Date.now() + 1000 });
    expect(csv.buffer.toString()).toContain("'=1+1");
    expect(csv.buffer.toString()).toContain("<script>inert</script>");
    expect(csv.buffer.toString()).toContain("reported");
  });
  it("captures accepted execution, not preview/replay/resumer; preserves job/item provenance through authorization wait and recovery", async () => {
    const jobs = new JobRepository(fixture.runtime), log = new AuditLog(scope, fixture.runtime);
    const input = { action: "block" as const, scope: "bulk" as const, actor, requestPath: "/api/agents/block",
      targets: [{ id: "origin-package", displayName: "Target, not caller", prestate: { kind: "block" as const, isBlocked: false } }] };
    const confirmation = await withActionOrigin(web, async () => createJobConfirmation(input));
    const request = { ...input, confirmationHash: confirmation.confirmationHash, idempotencyKey: randomUUID() };
    const job = await withActionOrigin(mcp, () => jobs.submit(scope, request));
    expect(job.origin).toEqual(mcp);
    const replay = await withActionOrigin(web, () => jobs.submit(scope, request));
    expect(replay.id).toBe(job.id); expect(replay.origin).toEqual(mcp);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM jobs WHERE idempotency_key=$1", [request.idempotencyKey])).rows[0].count).toBe(1);
    await jobs.waitForAuthorization(job.id, scope);
    const lease = await withActionOrigin(web, () => jobs.claim(job.id, scope, randomUUID(), true));
    const started = await withActionOrigin(web, () => jobs.beginItem(lease!));
    expect(started?.job.origin).toEqual(mcp);
    await withActionOrigin(web, () => jobs.finishItem(lease!, started!.item.id, "failed", { errorCode: "synthetic_no_provider" }));
    const events = await log.listEvents({ operationIdPrefix: job.id });
    expect(events.filter(event => event.action === "block").map(event => event.origin)).toEqual([mcp, mcp]);
    expect(events.find(event => event.action === "resume-control")?.origin).toEqual(web);
    expect((await jobs.get(job.id, scope))?.origin).toEqual(mcp);
    await expect(fixture.runtime.query("UPDATE jobs SET origin=$2 WHERE id=$1", [job.id, web])).rejects.toThrow("immutable");
    expect(await jobs.get(job.id, { ...scope, tenantId: "foreign" })).toBeUndefined();
    expect(currentActionOrigin()).toEqual(unknownOrigin);
  });
  it("keeps native quarantine authority separate with original direct-writer origin and separately attributed lifecycle requests", async () => {
    const repository = new CopilotStudioQuarantineRepository(fixture.runtime);
    const environmentId = randomUUID(), botId = randomUUID();
    const root = await nativeInventoryFixture(fixture.runtime, scope, [{ nativeId: "origin-native", environmentId, displayName: "Native target",
      lifecycle: "published", identifiers: [{ kind: "power_platform_resource_id", value: "origin-native" },
        { kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }], details: { isQuarantined: false } }]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    const target = (await new NativeInventory(fixture.runtime).resolveQuarantineTargets(scope, root.baselineId, ["origin-native"]))[0];
    const intent = { action: "quarantine" as const, actor, requestPath: "/api/quarantine/jobs",
      authority: { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 },
      targets: [{ ...target, directStatus: { environmentId, botId, isBotQuarantined: false,
        lastUpdateTimeUtc: "2026-09-01T00:00:00.000Z", observedAt: new Date().toISOString(), correlationId: randomUUID() } }] };
    const request = { ...intent, confirmationHash: createQuarantineConfirmation(intent).confirmationHash, idempotencyKey: randomUUID() };
    const job = await withActionOrigin(mcp, () => repository.submit(scope, request));
    expect((await withActionOrigin(web, () => repository.submit(scope, request))).origin).toEqual(mcp);
    await repository.waitForAuthorization(scope, job.id);
    const lease = await withActionOrigin(web, () => repository.claim(scope, job.id, randomUUID(), true));
    const started = await withActionOrigin(web, () => repository.beginItem(lease!));
    await withActionOrigin(web, () => repository.finishItem(lease!, started!.item, "failed", { errorCode: "synthetic_no_provider" }));
    const audit = await repository.listAudit(scope, 100, { originChannel: "mcp" });
    expect(audit.count).toBe(3);
    expect(audit.value.every(event => event.origin.channel === "mcp" && event.actor.displayName === actor.displayName)).toBe(true);
    expect((await repository.listAudit(scope, 100, { originChannel: "webapp" })).value).toMatchObject([{ action: "resume", origin: web }]);
    await expect(fixture.runtime.query("UPDATE copilot_quarantine_jobs SET origin=$2 WHERE id=$1", [job.id, web])).rejects.toThrow("immutable");
    expect((await new AuditLog(scope, fixture.runtime).listEvents({ search: "origin-native" }))).toEqual([]);
  });
});
