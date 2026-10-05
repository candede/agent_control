import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const receipt=JSON.parse(readFileSync(process.argv[3] ?? "/evidence/restart-fixture.json","utf8"));
assert.ok(["crash","crash-quarantine","crash-canary","crash-bulk","recover"].includes(process.argv[2]));
assert.match(receipt.database,/^agentcontrol_test_[a-z0-9_]+$/);
process.env.PGDATABASE=receipt.database;
const { createApp }=await import("/app/backend/dist/app.js");
const { AppError }=await import("/app/backend/dist/errors.js");
const { pool }=await import("/app/backend/dist/db/pool.js");
const { PowerPlatformRefreshJobs }=await import("/app/backend/dist/db/powerPlatformRefreshJobs.js");
const { PackageRefreshJobs }=await import("/app/backend/dist/db/packageRefreshJobs.js");
const { StreamedInventory }=await import("/app/backend/dist/services/streamedInventory.js");
const { LargeTenantUsersReports }=await import("/app/backend/dist/services/largeTenantUsersReports.js");
const { officialReportFingerprint }=await import("/app/backend/dist/services/officialReportFingerprint.js");
const { reportIdentity }=await import("/app/backend/dist/services/reportIdentity.js");
const { reportRuntime }=await import("/app/backend/dist/services/reportExportDispatcher.js");
const { OfficialReportExports }=await import("/app/backend/dist/services/officialReportExports.js");
const { PurviewAuditRepository }=await import("/app/backend/dist/db/purviewAudit.js");
const { DefenderHuntingRepository }=await import("/app/backend/dist/db/defenderHunting.js");
const { CopilotStudioQuarantineRepository }=await import("/app/backend/dist/db/copilotStudioQuarantine.js");
const { PackageMutationQualificationRepository }=await import("/app/backend/dist/db/packageMutationQualifications.js");
const { bulkJobs, runBulkJob }=await import("/app/backend/dist/services/bulkJobs.js");
const { PowerPlatformInventoryService, powerPlatformInventory }=await import("/app/backend/dist/services/powerPlatformInventory.js");
const { PackageInventoryService, packageInventory }=await import("/app/backend/dist/services/packageInventory.js");
const { PurviewAuditService }=await import("/app/backend/dist/services/purviewAudit.js");
const { DefenderHuntingService }=await import("/app/backend/dist/services/defenderHunting.js");
const { runCopilotStudioQuarantineJob,reconcileCopilotStudioQuarantineJob }=await import("/app/backend/dist/services/copilotStudioQuarantineJobs.js");
const { createProviderQueryBody }=await import("/app/backend/dist/services/graphAuditSearch.js");
const { GraphPackagesClient }=await import("/app/backend/dist/services/graphPackages.js");
const { DataGenerations,generationHeartbeat }=await import("/app/backend/dist/db/dataGenerations.js");
const generations=new DataGenerations(pool);
const scope={tenantId:"11111111-1111-4111-8111-111111111111",principalId:"phase01-fixture-principal"};
const purviewReadScope={tenantId:scope.tenantId,resultScopes:[{kind:"principal",scopeId:scope.principalId,configurationRevision:null}]};
const defenderResultScope={kind:"principal",scopeId:scope.principalId,configurationRevision:null};
const defenderAuthority={capabilityId:"defender.hunting.delegated",contractRevision:"d".repeat(64),permissionRevision:"e".repeat(64),configurationRevision:1};
const defenderReadScope={tenantId:scope.tenantId,authorizationPrincipalId:scope.principalId,resultScopes:[defenderResultScope],qualifications:[{resultScope:defenderResultScope,authority:defenderAuthority}]};
const inventoryRepository=new PowerPlatformRefreshJobs(pool);
const packageRepository=new PackageRefreshJobs(pool);
const reportReader=new LargeTenantUsersReports(pool,"synthetic-restart-report-cursor-secret",35);
const purviewRepository=new PurviewAuditRepository(pool);
const defenderRepository=new DefenderHuntingRepository(pool);
const quarantineRepository=new CopilotStudioQuarantineRepository(pool);
const qualifications=new PackageMutationQualificationRepository(pool);
assert.equal((await pool.query("SELECT current_user AS role,has_schema_privilege(current_user,'public','CREATE') AS can_create")).rows[0].role,"agentcontrol_app");
assert.equal((await pool.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS can_create")).rows[0].can_create,false);
let inventoryScans=0;
let packageScans=0;
const purviewProviderCalls={create:0,get:0,list:0,records:0};
let defenderProviderCalls=0;
const quarantineProviderCalls={get:0,set:0};
const observeOperation=async(_capability,_user,operation)=>operation(()=>undefined);
const quarantineState=new Map(receipt.quarantineTargets.map(target=>[target.botId,process.argv[2] === "recover" && target.nativeId !== "restart-quarantine-unsent"]));
let releaseQuarantineDispatch;
const quarantineProvider={
  getStatus:async(_token,target,options)=>{
    quarantineProviderCalls.get+=1;
    return {...target,isBotQuarantined:quarantineState.get(target.botId)??false,
      lastUpdateTimeUtc:quarantineState.get(target.botId)?"2026-09-09T10:00:01.123Z":"2026-09-09T10:00:00.123Z",
      observedAt:new Date().toISOString(),correlationId:options.correlationId};
  },
  setQuarantine:async(_token,target,value)=>{
    quarantineProviderCalls.set+=1;
    const descriptor=receipt.quarantineTargets.find(candidate=>candidate.botId===target.botId);
    if(["crash","crash-quarantine"].includes(process.argv[2])&&descriptor?.nativeId==="restart-quarantine-sent") return new Promise((_,reject)=>{
      releaseQuarantineDispatch=()=>reject(new AppError(504,"provider_timeout","Synthetic dispatched response was lost."));
    });
    quarantineState.set(target.botId,value);
  },
};
const quarantineAuthorization=async()=>({accessToken:"explicit-fixture-authorization",authority:receipt.quarantineAuthority});
let purviewInterruptedCreate;
let purviewInterruptedPoll;
const purviewUser={tenantId:scope.tenantId,homeAccountId:scope.principalId,displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Viewer"],providerRoles:[],providerRoleScope:"unknown"};
const purviewService=new PurviewAuditService(purviewRepository,{
  observeOperation,
  delegatedToken:async()=>"explicit-fixture-authorization",
  applicationToken:async()=>{throw new Error("application token not expected");},
  revalidateUser:async()=>purviewUser,
  requireAvailable:async()=>({authorized:true}),
  requireApplicationDataScope:async()=>undefined,
  applicationIdentity:()=>undefined,
  qualificationContext:async()=>{throw new Error("qualification context not expected");},
  recordQualificationEvidence:async()=>{throw new Error("qualification evidence not expected");},
  createQuery:async()=>{purviewProviderCalls.create+=1;throw new Error("provider create must not be replayed after an ambiguous dispatch");},
  getQuery:async(_token,id)=>{purviewProviderCalls.get+=1;const job=id===purviewInterruptedPoll.providerQueryId?purviewInterruptedPoll:purviewInterruptedCreate;
    return {id,status:"succeeded",...createProviderQueryBody(job.displayName,job.filters)};},
  listQueries:async()=>{purviewProviderCalls.list+=1;return {value:[{id:"purview-provider-reconciled",status:"succeeded",...createProviderQueryBody(purviewInterruptedCreate.displayName,purviewInterruptedCreate.filters)}],complete:true,nextLink:null};},
  listRecords:async()=>{purviewProviderCalls.records+=1;return {records:[],pageCount:1,providerRowCount:0,storedRowCount:0,byteCount:2,unknownFieldCount:0,complete:true,nextLink:null,partialReason:null};},
  wait:async()=>undefined,
  random:()=>0,
});
const defenderUser={tenantId:scope.tenantId,homeAccountId:scope.principalId,displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Admin"],providerRoles:[],providerRoleScope:"unknown"};
const defenderService=new DefenderHuntingService(defenderRepository,{
  observeOperation,
  delegatedToken:async()=>"explicit-fixture-authorization",
  applicationToken:async()=>{throw new Error("application token not expected");},
  revalidateUser:async()=>defenderUser,
  requireApplicationDataScope:async()=>{throw new AppError(503,"not_configured","Application scope not configured for this fixture.");},
  applicationIdentity:()=>undefined,
  qualificationContext:async capabilityId=>({...defenderAuthority,capabilityId}),
  auditLog:()=>({startEvent:async()=>({id:"defender-restart-audit"}),completeEvent:async()=>undefined}),
  runQuery:async(_token,_filters,options)=>{
    defenderProviderCalls+=1;
    await options.beforeRequest();
    await options.onResponse("defender-provider-resumed");
    return {rows:[],providerRowCount:0,storedRowCount:0,byteCount:2,complete:true,partialReason:null};
  },
});
const { app,store }=createApp();
const server=app.listen(3001,"0.0.0.0");
await new Promise(resolve => server.once("listening",resolve));
assert.equal((await fetch("http://localhost:3001/api/ready")).status,200);
console.log(JSON.stringify({event:"restart_runtime_ready",mode:process.argv[2],status:200,role:"agentcontrol_app"}));
if(process.argv[2] === "recover"){
  await powerPlatformInventory.recover();
  await packageInventory.recover();
  await purviewService.recover();
  await defenderService.recover();
  while(await quarantineRepository.recoverInterrupted(scope.tenantId,true)>0) {}
  assert.equal((await inventoryRepository.getJob(scope,receipt.inventoryInterrupted)).status,"waiting_authorization");
  assert.equal((await inventoryRepository.getJob(scope,receipt.inventoryCompleted)).status,"succeeded");
  assert.equal((await packageRepository.getJob(scope,receipt.packageInterrupted)).status,"waiting_authorization");
  assert.equal((await packageRepository.getJob(scope,receipt.packageCompleted)).status,"succeeded");
  purviewInterruptedCreate=await purviewRepository.getJob(purviewReadScope,receipt.purviewInterruptedCreate);
  assert.equal(purviewInterruptedCreate.status,"waiting_authorization");
  assert.equal(purviewInterruptedCreate.providerQueryId,null);
  assert.notEqual(purviewInterruptedCreate.attemptedAt,null);
  purviewInterruptedPoll=await purviewRepository.getJob(purviewReadScope,receipt.purviewInterruptedPoll);
  assert.equal(purviewInterruptedPoll.status,"waiting_authorization");
  assert.equal((await purviewRepository.getJob(purviewReadScope,receipt.purviewCompleted)).status,"succeeded");
  assert.equal((await defenderRepository.getJob(defenderReadScope,receipt.defenderInterrupted)).status,"waiting_authorization");
  assert.equal((await defenderRepository.getJob(defenderReadScope,receipt.defenderCompleted)).status,"succeeded");
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineSucceeded)).status,"succeeded");
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineSent)).status,"inconclusive");
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineSent)).canReconcile,true);
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineUnsent)).status,"waiting_authorization");
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineUnsent)).canResume,true);
  assert.equal(inventoryScans,0);
  assert.equal(packageScans,0);
  assert.deepEqual(purviewProviderCalls,{create:0,get:0,list:0,records:0});
  assert.equal(defenderProviderCalls,0);
  assert.deepEqual(quarantineProviderCalls,{get:0,set:0});
}
const usageFingerprint=await officialReportFingerprint(reportReader,await reportIdentity(pool,{
  tenantId:scope.tenantId,homeAccountId:scope.principalId,username:"fixture@example.invalid",displayName:"Fixture",roles:["AgentControl.Admin"],
}));
assert.deepEqual(usageFingerprint,receipt.officialUsage);
assert.equal((await pool.query(`SELECT count(*)::int AS count FROM information_schema.columns
  WHERE table_schema='public' AND table_name LIKE 'official_usage_%' AND data_type='bytea'`)).rows[0].count,0);
assert.equal((await pool.query("SELECT count(*)::int AS count FROM official_usage_staged_rows")).rows[0].count,0);
console.log(JSON.stringify({event:"official_usage_restart_proof",mode:process.argv[2],outcome:"passed",activeSetId:usageFingerprint.activeSetId,lineage:usageFingerprint.lineage.length,responses:usageFingerprint.aggregate.responses,distinctUsers:usageFingerprint.aggregate.activeUsers,originalBytesRetained:false}));
const writes=[];
const blocked=new Set();
const provider=new GraphPackagesClient(async (url,request) => {
  const segments=new URL(url).pathname.split("/");
  const id=request?.method === "POST" ? segments.at(-2) : segments.at(-1);
  if (request?.method === "POST") {
    writes.push(id); blocked.add(id);
    if (["crash","crash-bulk"].includes(process.argv[2]) && id === "b-uncertain") {
      console.log(JSON.stringify({event:"fixture_runtime_crash_after_dispatch",previousSuccess:true}));
      process.exit(17);
    }
    return new Response(null,{status:204});
  }
  return Response.json({id,displayName:"Fixture",isBlocked:blocked.has(id)});
});
try {
  if(process.argv[2] === "crash" && receipt.lifecycleLease) {
    const before=(await pool.query("SELECT lease_until FROM data_generations WHERE id=$1",[receipt.lifecycleLease.id])).rows[0].lease_until;
    generationHeartbeat(()=>generations.renew(receipt.lifecycleLease));
    await new Promise(resolve=>setTimeout(resolve,21_000));
    const after=(await pool.query("SELECT lease_until FROM data_generations WHERE id=$1",[receipt.lifecycleLease.id])).rows[0].lease_until;
    assert.ok(after.getTime()>before.getTime()+15_000);
    console.log(JSON.stringify({event:"generation_quiet_wait_heartbeat",outcome:"passed",waitMs:21000,renewedMs:after-before}));
  }
  if (["crash","crash-quarantine"].includes(process.argv[2])) {
    await runCopilotStudioQuarantineJob(receipt.quarantineSucceeded,scope,false,quarantineRepository,quarantineProvider,quarantineAuthorization);
    assert.equal((await quarantineRepository.get(scope,receipt.quarantineSucceeded)).status,"succeeded");
    assert.deepEqual(quarantineProviderCalls,{get:3,set:1});
    const dispatch=runCopilotStudioQuarantineJob(receipt.quarantineSent,scope,false,quarantineRepository,quarantineProvider,quarantineAuthorization);
    for(let attempt=0;attempt<100;attempt+=1){
      const sent=await pool.query("SELECT sent_at IS NOT NULL AS sent FROM copilot_quarantine_job_items WHERE job_id=$1",[receipt.quarantineSent]);
      if(sent.rows[0]?.sent)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal((await pool.query("SELECT sent_at IS NOT NULL AS sent FROM copilot_quarantine_job_items WHERE job_id=$1",[receipt.quarantineSent])).rows[0].sent,true);
    assert.deepEqual(quarantineProviderCalls,{get:5,set:2});
    console.log(JSON.stringify({event:"fixture_runtime_crash_after_quarantine_dispatch",previousSuccess:true}));
    if(process.argv[2] !== "crash") process.exit(17);
    releaseQuarantineDispatch();
    await dispatch;
    assert.equal((await quarantineRepository.get(scope,receipt.quarantineSent)).status,"inconclusive");
  }
  if (["crash","crash-canary"].includes(process.argv[2])) {
    let canaryWrites=0;
    let releaseCanaryDispatch;
    const canaryProvider=new GraphPackagesClient(async (_url,request) => {
      if (request?.method === "POST") {
        canaryWrites+=1;
        return new Promise((_,reject)=>{releaseCanaryDispatch=()=>reject(new Error("Synthetic dispatched response was lost."));});
      }
      return Response.json({id:"restart-canary",displayName:"Restart canary",isBlocked:false});
    });
    const dispatch=runBulkJob(receipt.canaryJob,scope,false,bulkJobs,canaryProvider,async()=>"fixture-token");
    for (let attempt=0;attempt<100;attempt+=1) {
      const sent=await pool.query("SELECT sent_at IS NOT NULL AS sent FROM job_items WHERE job_id=$1",[receipt.canaryJob]);
      if (sent.rows[0]?.sent) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal((await pool.query("SELECT sent_at IS NOT NULL AS sent FROM job_items WHERE job_id=$1",[receipt.canaryJob])).rows[0].sent,true);
    assert.equal(canaryWrites,1);
    console.log(JSON.stringify({event:"fixture_runtime_crash_after_canary_dispatch",writes:1}));
    if(process.argv[2] !== "crash") process.exit(17);
    releaseCanaryDispatch();
    await dispatch;
    assert.equal((await bulkJobs.get(receipt.canaryJob,scope)).inconclusive,1);
  }
  if (["crash","crash-bulk"].includes(process.argv[2])) {
    await runBulkJob(receipt.job,scope,false,bulkJobs,provider,async()=>"fixture-token");
    throw new Error("Expected the dispatched fixture to terminate the runtime process.");
  }
  if(receipt.lifecycleLease) {
    const input={...receipt.lifecycleInput,jobId:randomUUID(),observedAt:new Date(),expiresAt:new Date(receipt.lifecycleInput.expiresAt),deadlineAt:new Date(receipt.lifecycleInput.deadlineAt)};
    const replacement=await generations.begin(input);
    await assert.rejects(()=>generations.renew(receipt.lifecycleLease),/data_writer_fenced/);
    await assert.rejects(()=>generations.publish(receipt.lifecycleLease),/data_writer_fenced/);
    await generations.abort(replacement,true);
    await generations.abort(replacement,true);
    assert.equal((await pool.query("SELECT sum(reserved_bytes)::text AS bytes FROM data_generations WHERE scope_id=$1",[replacement.scopeId])).rows[0].bytes,"0");
    console.log(JSON.stringify({event:"generation_process_death_takeover",outcome:"passed",staleOwnerFenced:true,remainingReservationBytes:0}));
  }
  while(await bulkJobs.recover(scope.tenantId,true)>0) {}
  await qualifications.recoverInterrupted(scope.tenantId);
  assert.equal((await bulkJobs.get(receipt.job,scope)).status,"partial");
  assert.equal((await bulkJobs.get(receipt.unsent,scope)).status,"waiting_authorization");
  assert.equal((await bulkJobs.get(receipt.canaryJob,scope)).status,"partial");
  assert.equal((await bulkJobs.get(receipt.canaryJob,scope)).inconclusive,1);
  assert.equal((await qualifications.current(scope.tenantId,"block",receipt.canaryIdentity.contractRevision,receipt.canaryIdentity.configurationRevision)),undefined);
  assert.equal((await qualifications.current(scope.tenantId,"unblock",receipt.canaryIdentity.contractRevision,receipt.canaryIdentity.configurationRevision)),undefined);
  const canaryRecords=(await pool.query("SELECT status FROM package_mutation_qualifications WHERE id=ANY($1::uuid[]) ORDER BY id",[[receipt.canaryOriginal,receipt.canaryRestoration]])).rows;
  assert.deepEqual(canaryRecords,[{status:"inconclusive"},{status:"inconclusive"}]);
  await runBulkJob(receipt.job,scope,false,bulkJobs,provider,async()=>"fixture-token");
  assert.equal(writes.length,0);
  await assert.rejects(runBulkJob(receipt.unsent,scope,true,bulkJobs,provider,async()=>{throw new Error("reauthorization required");}));
  assert.equal(writes.length,0);
  await runBulkJob(receipt.job,scope,true,bulkJobs,provider,async()=>"explicit-fixture-authorization");
  await runBulkJob(receipt.unsent,scope,true,bulkJobs,provider,async()=>"explicit-fixture-authorization");
  assert.deepEqual(writes,["c-unsent","only-unsent"]);
  assert.equal((await bulkJobs.get(receipt.job,scope)).inconclusive,1);
  assert.equal((await bulkJobs.get(receipt.job,scope)).succeeded,2);
  assert.equal((await bulkJobs.get(receipt.unsent,scope)).status,"succeeded");
  const quarantineCallsBeforeExplicit={...quarantineProviderCalls};
  await runCopilotStudioQuarantineJob(receipt.quarantineSucceeded,scope,false,quarantineRepository,quarantineProvider,quarantineAuthorization);
  await runCopilotStudioQuarantineJob(receipt.quarantineSent,scope,false,quarantineRepository,quarantineProvider,quarantineAuthorization);
  assert.deepEqual(quarantineProviderCalls,quarantineCallsBeforeExplicit);
  await assert.rejects(runCopilotStudioQuarantineJob(receipt.quarantineUnsent,scope,true,quarantineRepository,quarantineProvider,async()=>{throw new Error("reauthorization required");}));
  assert.deepEqual(quarantineProviderCalls,quarantineCallsBeforeExplicit);
  await runCopilotStudioQuarantineJob(receipt.quarantineUnsent,scope,true,quarantineRepository,quarantineProvider,quarantineAuthorization);
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineUnsent)).status,"succeeded");
  assert.equal(quarantineProviderCalls.set,1);
  const writesBeforeReconciliation=quarantineProviderCalls.set;
  await reconcileCopilotStudioQuarantineJob(receipt.quarantineSent,scope,quarantineRepository,quarantineProvider,quarantineAuthorization);
  assert.equal(quarantineProviderCalls.set,writesBeforeReconciliation);
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineSent)).status,"succeeded");
  assert.equal((await quarantineRepository.get(scope,receipt.quarantineSent)).canReconcile,false);
  const inventoryUser={tenantId:scope.tenantId,homeAccountId:scope.principalId,displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Viewer"],providerRoleIds:["f2ef992c-3afb-46b9-b7cf-a126ee74c451"]};
  const inventoryService=new PowerPlatformInventoryService(inventoryRepository,{
    observeOperation,
    delegatedToken:async()=>"explicit-fixture-authorization",revalidateUser:async()=>inventoryUser,requireAvailable:async()=>undefined,
    streams:database=>new StreamedInventory(database,undefined,{
      pages:async function*(_token,_types,options){
        inventoryScans+=1;assert.equal(options.expectedTenantId,scope.tenantId);options.signal.throwIfAborted();
        await options.visit("restart-native-page");
        yield {token:"restart-native-page",nextToken:null,records:[],rawCount:0,expectedCount:0,page:1};
      },
    }),
  });
  await inventoryService.start(inventoryUser,receipt.inventoryInterrupted);
  for (let attempt=0;attempt<100&&(await inventoryRepository.getJob(scope,receipt.inventoryInterrupted)).status!=="succeeded";attempt+=1) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await inventoryRepository.getJob(scope,receipt.inventoryInterrupted)).status,"succeeded");
  assert.equal((await inventoryRepository.getJob(scope,receipt.inventoryCompleted)).status,"succeeded");
  assert.equal(inventoryScans,1);
  const packageUser={tenantId:scope.tenantId,homeAccountId:scope.principalId,displayName:"Fixture",username:"fixture@example.invalid",roles:["AgentControl.Viewer"]};
  const packageService=new PackageInventoryService(packageRepository,{
    observeOperation,
    delegatedToken:async()=>"explicit-fixture-authorization",applicationToken:async()=>{throw new Error("application token not expected");},revalidateUser:async()=>packageUser,
    requireAvailable:async()=>undefined,requireApplicationDataScope:async()=>{throw new Error("application scope not expected");},applicationPrincipalId:()=>undefined,
    streams:database=>new StreamedInventory(database,{
      getPackageDetails:async(_token,id,options)=>{
        options.signal.throwIfAborted();packageScans+=1;assert.equal(id,"package-restart-target");
        throw new AppError(404,"not_found","The synthetic exact target is absent.");
      },
    }),
    wait:async()=>undefined,
  });
  await packageService.start(packageUser,receipt.packageInterrupted,"delegated");
  for (let attempt=0;attempt<100&&(await packageRepository.getJob(scope,receipt.packageInterrupted)).status!=="succeeded";attempt+=1) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await packageRepository.getJob(scope,receipt.packageInterrupted)).status,"succeeded");
  assert.equal((await packageRepository.getJob(scope,receipt.packageCompleted)).status,"succeeded");
  assert.equal(packageScans,1);
  await purviewService.start(purviewUser,receipt.purviewInterruptedCreate,"delegated");
  await waitForPurviewStatus(receipt.purviewInterruptedCreate,"succeeded");
  await purviewService.start(purviewUser,receipt.purviewInterruptedPoll,"delegated");
  await waitForPurviewStatus(receipt.purviewInterruptedPoll,"succeeded");
  assert.equal((await purviewService.start(purviewUser,receipt.purviewCompleted,"delegated")).status,"succeeded");
  assert.equal((await purviewService.start(purviewUser,receipt.purviewInterruptedCreate,"delegated")).status,"succeeded");
  assert.deepEqual(purviewProviderCalls,{create:0,get:2,list:1,records:2});
  await defenderService.start(defenderUser,receipt.defenderInterrupted,"delegated");
  await waitForDefenderStatus(receipt.defenderInterrupted,"succeeded");
  assert.equal((await defenderService.start(defenderUser,receipt.defenderCompleted,"delegated")).status,"succeeded");
  assert.equal((await defenderService.start(defenderUser,receipt.defenderInterrupted,"delegated")).status,"succeeded");
  assert.equal(defenderProviderCalls,1);
  const exportActor={tenantId:scope.tenantId,homeAccountId:scope.principalId,username:"fixture@example.invalid",displayName:"Fixture",roles:["AgentControl.Admin"]};
  const exportIdentity=await reportIdentity(pool,exportActor), exports=new OfficialReportExports(reportReader,exportActor), dispatcher=reportRuntime(pool);
  dispatcher.start();
  try {
    let status=await exports.status(receipt.exportId,exportIdentity);
    for(let attempt=0;attempt<100&&status.status!=="ready";attempt+=1){
      assert.ok(["queued","building"].includes(status.status));
      await new Promise(resolve=>setTimeout(resolve,20));
      status=await exports.status(receipt.exportId,exportIdentity);
    }
    assert.equal(status.status,"ready");assert.ok(status.rows>0);
    let bytes=0;
    for await(const chunk of exports.engine.download(receipt.exportId,exportIdentity,new AbortController().signal)) {
      assert.ok(chunk.length<=262144);bytes+=chunk.length;
    }
    assert.equal(bytes,status.bytes);
    console.log(JSON.stringify({event:"compiled_report_export_restart_proof",outcome:"passed",rows:status.rows,bytes}));
  } finally { await dispatcher.drain(); }
  console.log(JSON.stringify({event:"runtime_recreation_proof",outcome:"passed",writesAfterExplicitAuthorization:2,completedReplays:0,uncertainReplays:0,canarySentReplays:0,canaryQualifications:0,quarantineProviderCallsAtStartup:0,quarantineCompletedReplays:0,quarantineSentReplays:0,quarantineWritesAfterExplicitAuthorization:1,quarantineReconciliationWrites:0,inventoryScansBeforeExplicitAuthorization:0,inventoryScansAfterExplicitAuthorization:1,packageScansBeforeExplicitAuthorization:0,packageScansAfterExplicitAuthorization:1,purviewProviderCallsAtStartup:0,purviewCreatesAfterResume:0,purviewReconciliationsAfterResume:1,purviewPollsAfterResume:purviewProviderCalls.get,purviewDownloadsAfterResume:2,purviewCompletedReplays:0,defenderProviderCallsAtStartup:0,defenderQueriesAfterExplicitResume:1,defenderCompletedReplays:0}));
} finally {
  await new Promise(resolve=>server.close(resolve));
  store.close();
  await pool.end();
}

async function waitForPurviewStatus(id,status) {
  for (let attempt=0;attempt<100;attempt+=1) {
    const job=await purviewRepository.getJob(purviewReadScope,id);
    if (job.status===status) return;
    if (["failed","inconclusive","cancelled","partial"].includes(job.status)) assert.fail(`Purview Audit job ${id} reached ${job.status}: ${job.errorCode??"none"} ${job.message??""}`);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(`Purview Audit job ${id} did not reach ${status}.`);
}

async function waitForDefenderStatus(id,status) {
  for (let attempt=0;attempt<100;attempt+=1) {
    const job=await defenderRepository.getJob(defenderReadScope,id);
    if (job.status===status) return;
    if (["failed","inconclusive","cancelled","partial"].includes(job.status)) assert.fail(`Defender hunting job ${id} reached ${job.status}: ${job.errorCode??"none"} ${job.message??""}`);
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(`Defender hunting job ${id} did not reach ${status}.`);
}