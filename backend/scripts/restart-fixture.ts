import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { databaseSettings, secretValue } from "../src/db/pool.js";
import { createJobConfirmation, JobRepository, type JobInput, type JobIntentInput } from "../src/db/jobs.js";
import { PackageMutationQualificationRepository } from "../src/db/packageMutationQualifications.js";
import { PowerPlatformInventoryRepository } from "../src/db/powerPlatformInventory.js";
import { PackageInventoryRepository } from "../src/db/packageInventory.js";
import { OfficialUsageRepository } from "../src/db/officialUsage.js";
import { PurviewAuditRepository, type PurviewAuditScope } from "../src/db/purviewAudit.js";
import { DefenderHuntingRepository, type DefenderHuntingScope } from "../src/db/defenderHunting.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "../src/db/copilotStudioQuarantine.js";
import type { FrozenQuarantineTarget, QuarantineAuthority } from "../src/types/copilotStudioQuarantine.js";
import { runBulkJob } from "../src/services/bulkJobs.js";
import { GraphPackagesClient } from "../src/services/graphPackages.js";
import { parseOfficialUsageReport } from "../src/services/officialUsageParser.js";
import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "../src/services/officialUsageViews.js";
import { testDatabase } from "./testDatabase.js";
import { fingerprints } from "./backup.js";

const receiptFile=process.argv[3];
const scope={tenantId:"11111111-1111-4111-8111-111111111111",principalId:"phase01-fixture-principal"};
const quarantineAuthority:QuarantineAuthority={contractRevision:"7".repeat(64),permissionRevision:"8".repeat(64),configurationRevision:9};
const quarantineTargetIds=[
  {nativeId:"restart-quarantine-succeeded",botId:"71111111-1111-4111-8111-111111111111"},
  {nativeId:"restart-quarantine-sent",botId:"72222222-2222-4222-8222-222222222222"},
  {nativeId:"restart-quarantine-unsent",botId:"73333333-3333-4333-8333-333333333333"},
] as const;
const input=(ids:string[]):JobInput=>{
  const intent:JobIntentInput={targets:ids.map(id=>({id,displayName:id,prestate:{kind:"block",isBlocked:false}})),action:"block",scope:"bulk",requestPath:"/fixture/restart",actor:{tenantId:scope.tenantId,homeAccountId:scope.principalId,username:"fixture@example.invalid",displayName:"Fixture"}};
  return {...intent,idempotencyKey:randomUUID(),confirmationHash:createJobConfirmation(intent).confirmationHash};
};
if (process.argv[2] === "seed") {
  const fixture=await testDatabase();
  const repository=new JobRepository(fixture.runtime);
  const qualifications=new PackageMutationQualificationRepository(fixture.runtime);
  const inventory=new PowerPlatformInventoryRepository(fixture.runtime);
  const packages=new PackageInventoryRepository(fixture.runtime);
  const officialUsage=new OfficialUsageRepository(fixture.runtime);
  const purviewAudit=new PurviewAuditRepository(fixture.runtime);
  const defenderHunting=new DefenderHuntingRepository(fixture.runtime);
  const quarantine=new CopilotStudioQuarantineRepository(fixture.runtime);
  let seeded=false;
  try {
    const job=await repository.submit(scope,input(["a-success","b-uncertain","c-unsent"]));
    const unsent=await repository.submit(scope,input(["only-unsent"]));
    const inventoryCompleted=await inventory.submit(scope,{idempotencyKey:"restart-completed",roleScope:"full",requestedTypes:["microsoft.powerplatform/environments"]});
    assert.equal(await inventory.markRunning(scope,inventoryCompleted.id),true);
    await inventory.publish(scope,inventoryCompleted.id,{resources:[],totalRecords:0,pages:1,unknownFieldCount:0});
    const quarantineInventory=await inventory.submit(scope,{idempotencyKey:"restart-quarantine-inventory",roleScope:"full",requestedTypes:["microsoft.copilotstudio/agents"]});
    assert.equal(await inventory.markRunning(scope,quarantineInventory.id),true);
    await inventory.publish(scope,quarantineInventory.id,{resources:quarantineTargetIds.map(target=>({tenantId:scope.tenantId,nativeId:target.nativeId,
      type:"microsoft.copilotstudio/agents" as const,location:null,displayName:target.nativeId,environmentId:scope.tenantId,createdAt:null,createdBy:null,
      lastPublishedAt:null,sourceSystem:"power_platform" as const,authoringTool:"Copilot Studio",creatorType:"unknown" as const,agentKind:"copilot_studio_agent",
      lifecycle:"published" as const,identityConfidence:"exact_native" as const,identifiers:[{kind:"power_platform_resource_id" as const,value:target.nativeId},
        {kind:"environment_id" as const,value:scope.tenantId},{kind:"cds_bot_id" as const,value:target.botId}],provenance:{},
      details:{isQuarantined:false},unknownFieldCount:0})),totalRecords:quarantineTargetIds.length,pages:1,unknownFieldCount:0});
    const quarantineSnapshotId=(await inventory.getJob(scope,quarantineInventory.id))!.snapshotId!;
    const resolvedQuarantineTargets=await inventory.resolveQuarantineTargets(scope,quarantineSnapshotId,quarantineTargetIds.map(target=>target.nativeId));
    const frozenQuarantineTargets=resolvedQuarantineTargets.map((target):FrozenQuarantineTarget=>({...target,directStatus:{environmentId:target.environmentId,
      botId:target.botId,isBotQuarantined:false,lastUpdateTimeUtc:"2026-09-09T10:00:00.123Z",observedAt:new Date().toISOString(),correlationId:randomUUID()}}));
    for (const target of quarantineTargetIds) await fixture.operator.query(`INSERT INTO copilot_quarantine_qualifications
      (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,
       contract_revision,permission_revision,configuration_revision,auth_mode)
      VALUES(gen_random_uuid(),$1,$1,$2,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$3,$4,$5,'delegated')`,
    [scope.tenantId,target.botId,quarantineAuthority.contractRevision,quarantineAuthority.permissionRevision,quarantineAuthority.configurationRevision]);
    const quarantineActor={tenantId:scope.tenantId,homeAccountId:scope.principalId,displayName:"Fixture",username:"fixture@example.invalid"};
    const submitQuarantine=async(target:FrozenQuarantineTarget,label:string)=>{
      const intent={action:"quarantine" as const,targets:[target],actor:quarantineActor,authority:quarantineAuthority,requestPath:"/fixture/restart-quarantine"};
      return quarantine.submit(scope,{...intent,idempotencyKey:`restart-quarantine-${label}`,confirmationHash:createQuarantineConfirmation(intent).confirmationHash});
    };
    const quarantineSucceeded=await submitQuarantine(frozenQuarantineTargets.find(target=>target.resourceNativeId==="restart-quarantine-succeeded")!,"succeeded");
    const quarantineSent=await submitQuarantine(frozenQuarantineTargets.find(target=>target.resourceNativeId==="restart-quarantine-sent")!,"sent");
    const quarantineUnsent=await submitQuarantine(frozenQuarantineTargets.find(target=>target.resourceNativeId==="restart-quarantine-unsent")!,"unsent");
    const inventoryInterrupted=await inventory.submit(scope,{idempotencyKey:"restart-interrupted",roleScope:"full",requestedTypes:["microsoft.copilotstudio/agents"]});
    assert.equal(await inventory.markRunning(scope,inventoryInterrupted.id),true);
    const packageInterrupted=await packages.submit(scope,{authorizationPrincipalId:scope.principalId,tokenMode:"delegated",idempotencyKey:"package-restart-interrupted",requestedIds:["package-restart-target"]});
    assert.equal(await packages.markRunning(scope,packageInterrupted.id),true);
    const packageCompleted=await packages.submit(scope,{authorizationPrincipalId:scope.principalId,tokenMode:"delegated",idempotencyKey:"package-restart-completed"});
    assert.equal(await packages.markRunning(scope,packageCompleted.id),true);
    await packages.publish(scope,packageCompleted.id,{packages:[],totalRecords:0,pages:1});
    const purviewScope:PurviewAuditScope={tenantId:scope.tenantId,authorizationPrincipalId:scope.principalId,resultScope:{kind:"principal",scopeId:scope.principalId,configurationRevision:null},tokenMode:"delegated"};
    const purviewFilters={presetId:"copilot_interactions" as const,operations:["CopilotInteraction"],startDateTime:"2026-09-09T09:00:00.000Z",endDateTime:"2026-09-09T09:30:00.000Z",userPrincipalNames:[],ipAddresses:[],objectIds:[],administrativeUnitIds:[]};
    const purviewInterruptedCreate=await purviewAudit.submit(purviewScope,{idempotencyKey:"purview-restart-create",filters:purviewFilters});
    const purviewCreateExecution=await purviewAudit.begin(purviewScope,purviewInterruptedCreate.id);
    assert.equal(purviewCreateExecution.action,"create");
    await purviewAudit.authorizeProviderRequest(purviewScope,purviewInterruptedCreate.id,purviewCreateExecution);
    const purviewInterruptedPoll=await purviewAudit.submit(purviewScope,{idempotencyKey:"purview-restart-poll",filters:purviewFilters});
    const purviewPollExecution=await purviewAudit.begin(purviewScope,purviewInterruptedPoll.id);
    assert.equal(purviewPollExecution.action,"create");
    await purviewAudit.authorizeProviderRequest(purviewScope,purviewInterruptedPoll.id,purviewPollExecution);
    await purviewAudit.recordProviderQuery(purviewScope,purviewInterruptedPoll.id,purviewPollExecution,"purview-provider-poll","running");
    const purviewCompleted=await purviewAudit.submit(purviewScope,{idempotencyKey:"purview-restart-completed",filters:purviewFilters});
    const purviewCompletedExecution=await purviewAudit.begin(purviewScope,purviewCompleted.id);
    assert.equal(purviewCompletedExecution.action,"create");
    await purviewAudit.authorizeProviderRequest(purviewScope,purviewCompleted.id,purviewCompletedExecution);
    await purviewAudit.recordProviderQuery(purviewScope,purviewCompleted.id,purviewCompletedExecution,"purview-provider-completed","succeeded");
    await purviewAudit.publish(purviewScope,purviewCompleted.id,purviewCompletedExecution,{records:[],pageCount:1,providerRowCount:0,storedRowCount:0,byteCount:2,unknownFieldCount:0,complete:true,nextLink:null,partialReason:null});
    const defenderScope:DefenderHuntingScope={tenantId:scope.tenantId,authorizationPrincipalId:scope.principalId,resultScope:{kind:"principal",scopeId:scope.principalId,configurationRevision:null},tokenMode:"delegated"};
    const defenderFilters={templateId:"agents_inventory" as const,startDateTime:"2026-09-09T09:00:00.000Z",endDateTime:"2026-09-09T09:30:00.000Z",agentIds:["restart-defender-agent"],blueprintIds:[],actorObjectIds:[],operations:[]};
    const defenderQualification={capabilityId:"defender.hunting.delegated" as const,contractRevision:"d".repeat(64),permissionRevision:"e".repeat(64),configurationRevision:1,approvedBy:scope.principalId};
    const defenderInterrupted=await defenderHunting.submit(defenderScope,{idempotencyKey:"defender-restart-interrupted",filters:defenderFilters,qualification:defenderQualification});
    await defenderHunting.begin(defenderScope,defenderInterrupted.id);
    const defenderCompleted=await defenderHunting.submit(defenderScope,{idempotencyKey:"defender-restart-completed",filters:defenderFilters,qualification:defenderQualification});
    const defenderCompletedExecution=await defenderHunting.begin(defenderScope,defenderCompleted.id);
    await defenderHunting.authorizeProviderRequest(defenderScope,defenderCompleted.id,defenderCompletedExecution);
    await defenderHunting.recordProviderResponse(defenderScope,defenderCompleted.id,defenderCompletedExecution,"defender-provider-completed");
    await defenderHunting.publish(defenderScope,defenderCompleted.id,defenderCompletedExecution,{rows:[],providerRowCount:0,storedRowCount:0,byteCount:2,complete:true,partialReason:null});
    const administrator={tenantId:scope.tenantId,homeAccountId:"restart-canary-approver",displayName:"Canary approver",username:"approver@example.invalid",roles:["AgentControl.Administrator"] as const};
    const operator={tenantId:scope.tenantId,homeAccountId:scope.principalId,displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Operator"] as const};
    const qualificationIdentity={contractRevision:"a".repeat(64),configurationRevision:7,authMode:"delegated" as const};
    const canaryOriginal=await qualifications.createApproved(administrator,{targetId:"restart-canary",action:"block",...qualificationIdentity,prestate:{kind:"block",isBlocked:false},poststate:{kind:"block",isBlocked:true}});
    const canaryRestoration=await qualifications.createApproved(administrator,{targetId:"restart-canary",action:"unblock",...qualificationIdentity,prestate:{kind:"block",isBlocked:true},poststate:{kind:"block",isBlocked:false}});
    const claimed=await qualifications.claimCycle(operator,canaryOriginal.id,canaryRestoration.id,qualificationIdentity,qualificationIdentity);
    const canaryIntent:JobIntentInput={targets:[{id:"restart-canary",displayName:"Restart canary",prestate:claimed.original.prestate}],action:"block",scope:"single",requestPath:"/fixture/restart-canary",actor:operator};
    const canaryJob=await repository.submit(scope,{...canaryIntent,idempotencyKey:`canary-${canaryOriginal.id}-original`,confirmationHash:createJobConfirmation(canaryIntent).confirmationHash});
    await qualifications.recordCycleJob(operator,canaryOriginal.id,canaryJob.id);
    const usageBundleId=randomUUID();
    const usageMetadata={reportingPeriod:{startDate:"2026-06-07",endDate:"2026-07-06",provenance:"operator_asserted" as const}};
    const usageReports=[
      "Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\nrestart-agent,Restart agent,Declarative,3,1,7,2026-07-06",
      "Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\nrestart-agent,Restart agent,Declarative,Restart-User-A,7,2026-07-06",
      "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\nRestart-User-B,Restart user,1,7,2026-07-06",
    ];
    for (const csv of usageReports) {
      const bytes=Buffer.from(csv,"utf8");
      await officialUsage.stage(scope,{report:parseOfficialUsageReport(bytes,usageMetadata),fileHash:createHash("sha256").update(bytes).digest("hex"),bundleId:usageBundleId});
      bytes.fill(0);
    }
    const usagePreview=await officialUsage.previewBundle(scope,usageBundleId);
    assert.deepEqual(usagePreview.missingKinds,[]);
    assert.equal((await officialUsage.acceptBundle(scope,usageBundleId,{bundleHash:usagePreview.bundleHash,expectedActiveRevision:usagePreview.expectedActiveRevision})).complete,true);
    await assertOfficialUsageRawBytesAbsent(fixture.operator);
    writeFileSync(receiptFile,JSON.stringify({database:fixture.name,job:job.id,unsent:unsent.id,inventoryInterrupted:inventoryInterrupted.id,inventoryCompleted:inventoryCompleted.id,packageInterrupted:packageInterrupted.id,packageCompleted:packageCompleted.id,purviewInterruptedCreate:purviewInterruptedCreate.id,purviewInterruptedPoll:purviewInterruptedPoll.id,purviewCompleted:purviewCompleted.id,defenderInterrupted:defenderInterrupted.id,defenderCompleted:defenderCompleted.id,quarantineSucceeded:quarantineSucceeded.id,quarantineSent:quarantineSent.id,quarantineUnsent:quarantineUnsent.id,quarantineAuthority,quarantineTargets:quarantineTargetIds,canaryJob:canaryJob.id,canaryOriginal:canaryOriginal.id,canaryRestoration:canaryRestoration.id,canaryIdentity:qualificationIdentity,officialUsage:await officialUsageFingerprint(officialUsage),tables:await fingerprints(fixture.operator)}),{mode:0o600});
    seeded=true;
    console.log(JSON.stringify({event:"restart_fixture_seeded",outcome:"passed"}));
  } finally {
    if (seeded) await Promise.allSettled([fixture.operator.end(),fixture.runtime.end()]);
    else await fixture.close();
  }
} else if (process.argv[2] === "verify" || process.argv[2] === "expire") {
  const receipt=JSON.parse(readFileSync(receiptFile,"utf8"));
  assert.match(receipt.database,/^agentcontrol_test_[a-z0-9_]+$/);
  const operator=new pg.Pool({...databaseSettings(),database:receipt.database});
  try {
    if (process.argv[2] === "verify") {
      assert.deepEqual(await fingerprints(operator),receipt.tables);
      console.log(JSON.stringify({event:"persistent_fixture_fingerprints",outcome:"passed"}));
    } else await operator.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",[[receipt.job,receipt.canaryJob]]);
  }
  finally { await operator.end(); }
} else {
  const receipt=JSON.parse(readFileSync(receiptFile,"utf8"));
  assert.match(receipt.database,/^agentcontrol_test_[a-z0-9_]+$/);
  const operator=new pg.Pool({...databaseSettings(),database:receipt.database});
  const runtime=new pg.Pool({...databaseSettings(),database:receipt.database,user:"agentcontrol_app",password:secretValue("APP_PGPASSWORD") ?? "isolated-fixture-password-never-production-01"});
  const repository=new JobRepository(runtime);
  try {
    await operator.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[receipt.job]);
    await repository.recover(scope.tenantId,true);
    assert.equal((await repository.get(receipt.job,scope))?.status,"partial");
    assert.equal((await repository.get(receipt.unsent,scope))?.status,"waiting_authorization");
    const writes:string[]=[];
    const blocked=new Set<string>();
    const provider=new GraphPackagesClient(async (url,request) => {
      const segments=new URL(url).pathname.split("/");
      const id=request?.method === "POST" ? segments.at(-2)! : segments.at(-1)!;
      if (request?.method === "POST") { writes.push(id);blocked.add(id);return new Response(null,{status:204}); }
      return Response.json({id,displayName:"Fixture",isBlocked:blocked.has(id)});
    });
    await runBulkJob(receipt.job,scope,false,repository,provider,async()=>"fixture-token");
    assert.equal(writes.length,0);
    await runBulkJob(receipt.job,scope,true,repository,provider,async()=>"explicit-fixture-authorization");
    await runBulkJob(receipt.unsent,scope,true,repository,provider,async()=>"explicit-fixture-authorization");
    assert.deepEqual(writes,["c-unsent","only-unsent"]);
    assert.equal((await repository.get(receipt.job,scope))?.inconclusive,1);
    assert.equal((await repository.get(receipt.job,scope))?.succeeded,2);
    assert.equal((await repository.get(receipt.unsent,scope))?.status,"succeeded");
    console.log(JSON.stringify({event:"restart_fixture_recovered",outcome:"passed",successfulItemsNeverReplayed:true,uncertainItemsNeverReplayed:true}));
  } finally {
    await Promise.allSettled([operator.end(),runtime.end()]);
    const cleanup=new pg.Pool(databaseSettings());
    try { await cleanup.query(`DROP DATABASE "${receipt.database}" WITH (FORCE)`); } finally { await cleanup.end(); }
  }
}

async function officialUsageFingerprint(repository:OfficialUsageRepository) {
  const published=await repository.getPublished(scope.tenantId);
  const options={staleAfterDays:35,now:new Date("2026-09-08T12:00:00.000Z")};
  const aggregate=buildOfficialUsageAggregateView(published,[],options);
  const users=buildOfficialUsageUserView(published,options);
  return {
    activeSetId:published.activeSet?.id??null,
    activeRevision:published.activeRevision,
    lineage:aggregate.lineages.map(value=>({...value,sourceAsOf:value.sourceAsOf??null,downloadedAt:value.downloadedAt??null})).sort((left,right)=>left.versionId<right.versionId?-1:left.versionId>right.versionId?1:0),
    aggregate:{responses:aggregate.summary.usage.totalResponses,activeUsers:aggregate.summary.usage.totalActiveUsers,reportAgents:aggregate.agents.count},
    users:{count:users.users.count,responses:users.counts.totalResponsesReceived,accessRows:users.counts.accessRows},
  };
}

async function assertOfficialUsageRawBytesAbsent(database:pg.Pool) {
  const byteColumns=await database.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'official_usage_%' AND data_type='bytea'`);
  assert.equal(byteColumns.rowCount,0);
  assert.equal((await database.query("SELECT count(*)::int AS count FROM official_usage_staged_rows")).rows[0].count,0);
}