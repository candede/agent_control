import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import pg from "pg";
import { databaseSettings } from "../src/db/pool.js";
import { schemaFingerprint } from "../src/db/schema.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";
import { assertDistinctDatabaseTargets, backup, restore, fingerprints, reopenRestoredDatabase } from "./backup.js";
import { AuditLog } from "../src/services/auditLog.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { DefenderHuntingRepository, type DefenderHuntingScope } from "../src/db/defenderHunting.js";
import { PackageRefreshJobs } from "../src/db/packageRefreshJobs.js";
import { PurviewAuditRepository, type PurviewAuditScope } from "../src/db/purviewAudit.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import type { DefenderAgentInventoryRow, DefenderHuntingFilters } from "../src/types/defenderHunting.js";
import type { PurviewAuditFilters } from "../src/types/purviewAudit.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { inventoryBaseline, inventoryInput, packageRecord, refreshInventoryFixture } from "./inventoryFixtures.js";
import { packageInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { InventoryQueries } from "../src/db/inventoryQueries.js";
import { backupTableKeys, fingerprintAlgorithm } from "./backupInventory.js";
import { seedDisjointReportUnion } from "./officialReportFixtures.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const directory = join(process.cwd(), "artifacts", "test-scratch", `postgres-backup-${randomUUID()}`);
const target = `agentcontrol_restore_${randomUUID().replaceAll("-","")}`;
beforeAll(async () => { mkdirSync(directory, { recursive: true }); fixture = await testDatabase(); });
afterAll(async () => {
  if (fixture) await fixture.operator.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
  await fixture?.close(); rmSync(directory,{recursive:true,force:true});
}, 30_000);

it("rejects count corruption before creating a snapshot dump or success receipt", async () => {
  const isolated = await testDatabase();
  const file = join(directory, "invalid-membership-count.dump");
  try {
    const set = await seedDisjointReportUnion(isolated.operator, randomUUID(), 3);
    await isolated.operator.query("UPDATE official_usage_membership_counts SET row_count=2 WHERE version_id=$1", [set.versions.users]);
    await expect(backup(isolated.operator, file)).rejects.toThrow("official_membership_count_mismatch");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.json`)).toBe(false);
  } finally { await isolated.close(); }
});

it("retains exact fingerprint bytes across indexed 250-record COPY pages without growing offsets", async () => {
  const isolated = await testDatabase();
  try {
    await inventoryBaseline(new InventoryGenerations(isolated.runtime), randomUUID(), 501);
    const keys = backupTableKeys.package_record_rows.map(key => `"${key}"`).join(",");
    const expected = (await isolated.operator.query(`SELECT convert_to(row_to_json(record)::text,'UTF8') AS body
      FROM package_record_rows record ORDER BY ${keys}`)).rows;
    const hash = createHash("sha256");
    for (const [index, row] of expected.entries()) { if (index) hash.update("\n"); hash.update(row.body); }
    const result = await fingerprints(isolated.operator, ["package_record_rows"]);
    expect(result.package_record_rows).toEqual({ count: 501, hash: hash.digest("hex") });
  } finally { await isolated.close(); }
}, 30_000);

it("binds restore isolation to the exact server and database identity", () => {
  const target = (host: string, database: string) => ({ options: { host, database } }) as Pick<pg.Pool, "options">;
  expect(() => assertDistinctDatabaseTargets(target("retained.postgres.database.azure.com", "agentcontrol"),
    target("retained.postgres.database.azure.com", "agentcontrol"))).toThrow("exact separate server/database");
  expect(assertDistinctDatabaseTargets(target("retained.postgres.database.azure.com", "agentcontrol"),
    target("restored.postgres.database.azure.com", "agentcontrol"))).toEqual({
      current: { host: "retained.postgres.database.azure.com", database: "agentcontrol" },
      restored: { host: "restored.postgres.database.azure.com", database: "agentcontrol" },
    });
  expect(assertDistinctDatabaseTargets(target("postgres", "agentcontrol"),
    target("postgres", "agentcontrol_restore_fixture"))).toEqual({
      current: { host: "postgres", database: "agentcontrol" },
      restored: { host: "postgres", database: "agentcontrol_restore_fixture" },
    });
});

it("restores an isolated native PostgreSQL backup with exact schema/count/content checks", async () => {
  const inventory = new InventoryGenerations(fixture.runtime), inventoryPrincipal = randomUUID();
  const inventoryRoot = await inventoryBaseline(inventory, inventoryPrincipal, 1, new Date(Date.now() - 1000));
  await inventory.execute(inventoryInput(inventoryPrincipal),
    { domain: "packages", mode: "delta", channel: "exact", targets: ["package-000000"] },
    lease => inventory.append(lease, [{ ...packageRecord(0), deleted: true }]).then(() => {}), { authorize: async () => {} });
  const inventoryIdentity = { ...selectionIdentity, principalId: inventoryPrincipal };
  const inventoryReader = new InventoryQueries(fixture.runtime, "synthetic-inventory-restore-read-secret");
  const inventorySelection = await inventoryReader.capture(inventoryIdentity, inventoryRoot.scopeId);
  const audit = new AuditLog({tenantId:"fixture-tenant",principalId:"fixture-principal"},fixture.runtime);
  await audit.startEvent({operationId:"fixture-operation",scope:"single",action:"block",targetBlockedState:true,agentId:"fixture-package",actor:{tenantId:"fixture-tenant",homeAccountId:"fixture-principal",displayName:"Fixture",username:"fixture@example.invalid"},requestPath:"/fixture"});
  const packages = new PackageRefreshJobs(fixture.runtime);
  const packageScope={tenantId:"fixture-tenant",principalId:"fixture-principal"};
  const packageJob=await packages.submit(packageScope,{authorizationPrincipalId:packageScope.principalId,tokenMode:"delegated",idempotencyKey:"backup-fixture"});
  await packages.markRunning(packageScope,packageJob.id);
  const packageRoot = await refreshInventoryFixture(fixture.runtime,packageScope,packageJob.id,"packages",[
    packageInventoryRecord(allowlistedPackage({id:"fixture-package",displayName:"Fixture package",isBlocked:false,
      appId:"fixture-app",manifestId:"fixture-manifest",assetId:"fixture-asset"}))]);
  const usage = new OfficialReportImports(fixture.runtime);
  const reader = new LargeTenantUsersReports(fixture.runtime, "synthetic-backup-read-secret-never-production", 35);
  const usageScope={...selectionIdentity,tenantId:"fixture-tenant",principalId:"fixture-principal"};
  const metadata={reportingPeriod:{startDate:"2026-06-01",endDate:"2026-06-30",provenance:"operator_asserted" as const},sourceAsOf:{value:"2026-07-01T00:00:00Z",provenance:"operator_asserted" as const}};
  const reports=[
    "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nfixture-agent,Fixture agent,Your org,1,0,2,2026-06-30",
    "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nfixture-agent,Fixture agent,Your org,user@example.invalid,2,2026-06-30",
    "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nuser@example.invalid,Fixture user,1,2,2026-06-30",
  ];
  const acceptBundle = async (correctionOfSetId?: string, owner = usageScope) => {
    const bundleId=randomUUID();
    for (const [index, original] of reports.entries()) {
      const content = correctionOfSetId && index === 2
        ? original.replace("Fixture user,1,2,2026-06-30", "Fixture user,1,3,2026-06-30")
        : original;
      await usage.stage(owner,{bundleId,correctionOfSetId},(async function* () { yield Buffer.from(content); })(),metadata);
    }
    return usage.acceptBundle(owner,bundleId,await usage.bundle(owner,bundleId));
  };
  const historicalReports = await acceptBundle();
  const historicalSelection = await reader.capture(usageScope,"delegated","official_users");
  const historicalVersionIds = (await reader.page(historicalSelection.id,usageScope)).reports.lineages.map(lineage => lineage.versionId);
  const currentReports = await acceptBundle(historicalReports.setId);
  expect(currentReports.setId).not.toBe(historicalReports.setId);
  const currentSelection = await reader.capture(usageScope,"delegated","official_users");
  const currentVersionIds = new Set((await reader.page(currentSelection.id,usageScope)).reports.lineages.map(lineage => lineage.versionId));
  const sharedVersionIds = historicalVersionIds.filter(id => currentVersionIds.has(id));
  const historicalOnlyVersionIds = historicalVersionIds.filter(id => !currentVersionIds.has(id));
  expect(sharedVersionIds).toHaveLength(2);
  expect(historicalOnlyVersionIds).toHaveLength(1);
  const laterCorrectionScope = { ...usageScope, tenantId: "fixture-later-correction" };
  const laterCorrectedOriginal = await acceptBundle(undefined, laterCorrectionScope);

  const hunting = new DefenderHuntingRepository(fixture.runtime);
  const huntingScope: DefenderHuntingScope = { tenantId:"fixture-tenant",authorizationPrincipalId:"fixture-principal",
    resultScope:{kind:"principal",scopeId:"fixture-principal",configurationRevision:null},tokenMode:"delegated" };
  const huntingAuthority={capabilityId:"defender.hunting.delegated" as const,contractRevision:"a".repeat(64),permissionRevision:"b".repeat(64),configurationRevision:1};
  const publishHunt = async (key: string, agentId: string) => {
    const filters: DefenderHuntingFilters={templateId:"agents_inventory",startDateTime:"2026-09-09T10:00:00.000Z",
      endDateTime:"2026-09-09T11:00:00.000Z",agentIds:[agentId],blueprintIds:[],actorObjectIds:[],operations:[]};
    const qualification=await hunting.submit(huntingScope,{idempotencyKey:`${key}-qualification`,filters,
      qualification:{...huntingAuthority,approvedBy:"fixture-administrator"}});
    const qualificationExecution=await hunting.begin(huntingScope,qualification.id);
    await hunting.publish(huntingScope,qualification.id,qualificationExecution,{rows:[huntingInventoryRow(agentId)],providerRowCount:1,
      storedRowCount:1,byteCount:1024,complete:true,partialReason:null});
    const retainedScope=await hunting.requireQualifiedScope(huntingScope,filters,huntingAuthority);
    const job=await hunting.submit(huntingScope,{idempotencyKey:key,filters,retainedScope});
    const execution=await hunting.begin(huntingScope,job.id);
    await hunting.publish(huntingScope,job.id,execution,{rows:[huntingInventoryRow(agentId)],providerRowCount:1,
      storedRowCount:1,byteCount:1024,complete:true,partialReason:null});
    return {jobId:job.id,retainedScopeId:retainedScope.id};
  };
  const historicalHunt=await publishHunt("restore-historical","historical-agent");
  const currentHunt=await publishHunt("restore-current","current-agent");
  const purview=new PurviewAuditRepository(fixture.runtime);
  const purviewScope: PurviewAuditScope={tenantId:"fixture-tenant",authorizationPrincipalId:"fixture-principal",
    resultScope:{kind:"principal",scopeId:"fixture-principal",configurationRevision:null},tokenMode:"delegated"};
  const purviewFilters: PurviewAuditFilters={presetId:"copilot_interactions",operations:["CopilotInteraction"],
    startDateTime:"2026-09-09T10:00:00.000Z",endDateTime:"2026-09-09T11:00:00.000Z",userPrincipalNames:[],
    ipAddresses:[],objectIds:[],administrativeUnitIds:[]};
  const purviewQualification=await purview.approveQualification(purviewScope,{filters:purviewFilters,
    capabilityId:"purview.audit.search.delegated",contractRevision:"a".repeat(64),permissionRevision:"b".repeat(64),
    configurationRevision:1,approvedBy:"fixture-administrator"});
  const purviewJob=await purview.submit(purviewScope,{idempotencyKey:"restore-purview",filters:purviewFilters,qualificationId:purviewQualification.id});
  await purview.begin(purviewScope,purviewJob.id);
  const uncertainJob=randomUUID();
  await fixture.operator.query(`INSERT INTO jobs(id,tenant_id,principal_id,token_mode,capability,action,request_hash,idempotency_key,actor_name,actor_username,request_path,scope,status,lease_owner,lease_until)
    VALUES($1,'fixture-tenant','fixture-principal','delegated','graph.package.block.manage','block',repeat('a',64),'restore-uncertain','Fixture','fixture@example.invalid','/fixture','single','running',gen_random_uuid(),clock_timestamp()+interval '1 minute')`,[uncertainJob]);
  await fixture.operator.query(`INSERT INTO job_items(id,job_id,ordinal,target_id,display_name,status,sent_at)
    VALUES(gen_random_uuid(),$1,0,'fixture-package','Fixture package','running',clock_timestamp())`,[uncertainJob]);
  await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES ('restored-session','{}',clock_timestamp()+interval '1 hour')");
  const filename = join(directory,"fixture.dump");
  const before = await fingerprints(fixture.operator);
  expect(before.inventory_exact_heads.count).toBe(1);
  expect(Object.keys(before)).toEqual(Object.keys(backupTableKeys).sort());
  await expect(fingerprints(fixture.operator, Array.from({ length: 129 }, (_, index) => `table_${index}`)))
    .rejects.toThrow("Backup table inventory is invalid.");
  await backup(fixture.operator,filename);
  expect(statSync(filename).mode & 0o777).toBe(0o600);
  expect(statSync(`${filename}.json`).mode & 0o777).toBe(0o600);
  const receipt=JSON.parse(readFileSync(`${filename}.json`,"utf8"));
  expect(receipt.format).toBe("agent-control-backup-v1");
  expect(receipt.schemaFingerprint).toBe(schemaFingerprint);
  expect(receipt.fingerprintAlgorithm).toBe(fingerprintAlgorithm);
  expect(Date.parse(receipt.snapshotAt)).toBeLessThanOrEqual(Date.parse(receipt.createdAt));
  for (const incompatible of [{ schemaFingerprint: "0".repeat(64) }, { format: "unsupported" }]) {
    writeFileSync(`${filename}.json`, JSON.stringify({ ...receipt, ...incompatible }));
    try {
      await expect(restore(fixture.operator, filename, target)).rejects.toThrow("Backup receipt/checksum mismatch.");
      expect((await fixture.operator.query("SELECT 1 FROM pg_database WHERE datname=$1", [target])).rowCount).toBe(0);
    } finally { writeFileSync(`${filename}.json`, JSON.stringify(receipt)); }
  }
  const laterCorrection = await acceptBundle(laterCorrectedOriginal.setId, laterCorrectionScope);
  await usage.confirm(laterCorrectionScope,await usage.confirmPreview(laterCorrectionScope,laterCorrection.setId,"delete"));
  await usage.confirm(usageScope,await usage.confirmPreview(usageScope,historicalReports.setId,"delete"));
  await fixture.operator.query("UPDATE defender_hunting_retained_scopes SET revoked_at=clock_timestamp(),revoked_by='current-review' WHERE id=$1",[historicalHunt.retainedScopeId]);
  const currentAfterReviewChanges=await fingerprints(fixture.operator);
  expect(await restore(fixture.operator,filename,target)).toEqual(before);
  expect(await fingerprints(fixture.operator)).toEqual(currentAfterReviewChanges);
  const restoredOperator = new pg.Pool({ ...databaseSettings(), database: target });
  const restoredRuntime = new pg.Pool({ ...databaseSettings(), database: target, user: "agentcontrol_app", password: fixturePassword });
  try {
    const restoredInventory = new InventoryQueries(restoredRuntime, "synthetic-inventory-restore-read-secret");
    await expect(restoredInventory.page(inventorySelection.id, inventoryIdentity)).rejects.toMatchObject({ code: "selection_invalidated" });
    const restoredStore = new InventoryGenerations(restoredRuntime);
    expect((await restoredStore.gcMetadata(inventoryRoot.scopeId, inventoryRoot.tenantId)).exactHeads).toBe(1);
    expect((await restoredRuntime.query("SELECT identity FROM inventory_exact_heads WHERE scope_id=$1", [inventoryRoot.scopeId])).rows).toEqual([]);
    const state = await restoredRuntime.query("SELECT mode,provider_work_enabled,deletion_reviewed_at,access_reviewed_at FROM operational_state");
    expect(state.rows[0]).toMatchObject({ mode: "maintenance", provider_work_enabled: false });
    expect(state.rows[0].deletion_reviewed_at).toBeTruthy();
    expect(state.rows[0].access_reviewed_at).toBeTruthy();
    expect((await restoredRuntime.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count).toBe(0);
    expect((await restoredRuntime.query("SELECT status,error_code FROM job_items WHERE job_id=$1",[uncertainJob])).rows[0]).toEqual({status:"inconclusive",error_code:"restored_uncertain_write"});
    expect((await restoredRuntime.query("SELECT status,lease_owner,lease_until FROM jobs WHERE id=$1",[uncertainJob])).rows[0]).toEqual({status:"partial",lease_owner:null,lease_until:null});
    expect((await restoredRuntime.query("SELECT count(*)::int AS count FROM package_record_rows WHERE scope_id=$1",
      [packageRoot.scopeId])).rows[0].count).toBe(1);
    await expect(restoredInventory.capture({ ...usageScope, sessionEpoch: "1" }, packageRoot.scopeId))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(restoredInventory.capture({ ...usageScope, principalId: "other", sessionEpoch: "0" }, packageRoot.scopeId))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await restoredRuntime.query("SELECT count(*)::int AS count FROM inventory_live_sources WHERE tenant_id=$1 AND principal_id=$2",
      [packageScope.tenantId, packageScope.principalId])).rows[0].count).toBe(0);
    const restoredReader = new LargeTenantUsersReports(restoredRuntime,"synthetic-backup-read-secret-never-production",35);
    const restoredIdentity={...usageScope,sessionEpoch:"1"},restoredCorrectionIdentity={...laterCorrectionScope,sessionEpoch:"1"};
    await expect(restoredReader.page(currentSelection.id,usageScope)).rejects.toMatchObject({code:"selection_invalidated"});
    const restoredUsers=await restoredReader.capture(restoredIdentity,"delegated","official_users");
    expect((await restoredReader.page(restoredUsers.id,restoredIdentity)).value).toHaveLength(1);
    const restoredOverview=await restoredReader.capture(restoredCorrectionIdentity,"delegated","overview");
    expect((await restoredReader.page(restoredOverview.id,restoredCorrectionIdentity)).analytics.overview)
      .toMatchObject({ retainedSets: 0, reportedAgents: 0 });
    await expect(restoredReader.capture(restoredCorrectionIdentity,"delegated","official_users",{setId:laterCorrectedOriginal.setId}))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await restoredOperator.query("SELECT count(*)::int AS count FROM official_usage_version_rows WHERE version_id=ANY($1::uuid[])",[
      historicalOnlyVersionIds])).rows[0].count).toBe(0);
    expect((await restoredOperator.query("SELECT count(*)::int AS count FROM official_usage_version_rows WHERE version_id=ANY($1::uuid[])",[
      sharedVersionIds])).rows[0].count).toBe(2);
    const restoredHunting=new DefenderHuntingRepository(restoredRuntime);
    expect(await restoredHunting.getJob(huntingScope,historicalHunt.jobId)).toBeUndefined();
    expect(await restoredHunting.getJob(huntingScope,currentHunt.jobId)).toBeTruthy();
    expect((await restoredOperator.query("SELECT count(*)::int AS count FROM purview_audit_qualifications")).rows[0].count).toBe(0);
    expect((await restoredOperator.query("SELECT execution_owner FROM purview_audit_jobs WHERE id=$1",[purviewJob.id])).rows[0].execution_owner).toBeNull();
    expect((await restoredRuntime.query("SELECT count(*)::int AS count FROM audit_events")).rows[0].count).toBe(1);
    await expect(restoredRuntime.query("DELETE FROM operational_state")).rejects.toThrow();
    const unavailableCurrent=new pg.Pool({...databaseSettings(),database:"agentcontrol_unavailable",port:1,connectionTimeoutMillis:100});
    await expect(reopenRestoredDatabase(unavailableCurrent,target)).rejects.toThrow();
    await unavailableCurrent.end();
    expect((await restoredOperator.query("SELECT mode FROM operational_state")).rows[0].mode).toBe("maintenance");
    await usage.confirm(usageScope,await usage.confirmPreview(usageScope,currentReports.setId,"delete"));
    await fixture.operator.query("UPDATE defender_hunting_retained_scopes SET revoked_at=clock_timestamp(),revoked_by='current-review' WHERE id=$1",[currentHunt.retainedScopeId]);
    expect(await reopenRestoredDatabase(fixture.operator,target)).toEqual({mode:"normal",providerWorkEnabled:false});
    expect((await restoredOperator.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0]).toEqual({mode:"normal",provider_work_enabled:false});
    await expect(restoredReader.page(restoredUsers.id,restoredIdentity)).rejects.toMatchObject({code:"selection_invalidated"});
    const reopenedUsers=await restoredReader.capture(restoredIdentity,"delegated","official_users");
    expect((await restoredReader.page(reopenedUsers.id,restoredIdentity)).value).toEqual([]);
    expect(await restoredHunting.getJob(huntingScope,currentHunt.jobId)).toBeUndefined();
    await expect(restoredHunting.listRows(huntingScope,currentHunt.jobId)).rejects.toThrow("not found");
  } finally {
    await restoredRuntime.end();
    await restoredOperator.end();
  }
  await expect(restore(fixture.operator,filename,"agentcontrol")).rejects.toThrow("isolated");
  await expect(restore(fixture.operator,filename,target)).rejects.toThrow("already exists");
}, 30_000);

function huntingInventoryRow(agentId: string): DefenderAgentInventoryRow {
  return {projectionVersion:3,sourceTable:"AgentsInfo",observationTime:"2026-09-09T10:30:00.000Z",agentId,agentName:null,
    platform:null,agentDescription:null,version:null,sourceAgentId:null,entraAgentObjectId:null,entraBlueprintId:null,
    observabilityId:null,publishedStatus:null,lifecycleStatus:null,availability:null,createdDateTime:null,lastPublishedDateTime:null,
    lastUpdatedDateTime:null,instanceCount:null,model:null,ownerCount:null,sharedWithCount:null,permissionMetadataKeyCount:null,
    authenticationMetadataKeyCount:null,detailStates:{owners:"not_supplied",sharing:"not_supplied",permissions:"not_supplied",
      authentication:"not_supplied",risk:"not_exposed"}};
}