import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { testDatabase } from "./testDatabase.js";
import { PackageRefreshJobs } from "../src/db/packageRefreshJobs.js";
import { OfficialReportImports } from "../src/db/officialReportImports.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { OfficialReportExports } from "../src/services/officialReportExports.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { packageInventoryRecord } from "../src/services/inventoryRecordProjection.js";
import { completeInventoryJob, inventoryJobInput } from "../src/services/inventoryRuntime.js";

const fixture=await testDatabase();
const packageRepository=new PackageRefreshJobs(fixture.runtime);
const usageRepository=new OfficialReportImports(fixture.runtime);
const scope={tenantId:"load-tenant",principalId:"load-principal"};
const durations:number[]=[];
const initialRss=process.memoryUsage().rss;
const initialSize=Number((await fixture.operator.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
try {
  const actor={tenantId:scope.tenantId,homeAccountId:scope.principalId,username:"fixture@example.invalid",displayName:"Load fixture"};
  const identity=await reportIdentity(fixture.runtime,{...actor,roles:["AgentControl.Admin"]});
  const reader=new LargeTenantUsersReports(fixture.runtime,"synthetic-cache-load-cursor-secret",35);
  const exports=new OfficialReportExports(reader,actor);
  const packageJob=await packageRepository.submit(scope,{authorizationPrincipalId:scope.principalId,tokenMode:"delegated",idempotencyKey:"cache-load-publish"});
  assert.equal(await packageRepository.markRunning(scope,packageJob.id),true);
  const store=new InventoryGenerations(fixture.runtime);
  const input=await inventoryJobInput(fixture.runtime,scope,"packages",packageJob.id);
  const root=await store.execute(input,{domain:"packages",mode:"baseline",channel:"catalog"},async lease=>{
    for(let offset=0;offset<1000;offset+=100) {
      const records=Array.from({length:100},(_,position)=>{
        const index=offset+position;
        return packageInventoryRecord(allowlistedPackage({id:`load-${String(index).padStart(4,"0")}`,
          displayName:`Load package ${index}`,isBlocked:index%3===0,appId:`load-app-${index}`,
          manifestId:`load-manifest-${index}`,assetId:`load-asset-${index}`,
          publisher:index%2 ? "Odd publisher" : "Even publisher",supportedHosts:["Copilot"]}));
      });
      await store.visit(lease,String(offset));
      await store.appendBounded(lease,records);
      await store.acceptPage(lease,{token:String(offset),nextToken:offset+100<1000?String(offset+100):null,
        records,rawCount:records.length,expectedCount:1000,page:offset/100+1},records.length);
    }
  },{authorize:async()=>{},completeJob:completeInventoryJob(input,"packages")});
  const inventorySelection=await exports.inventory.capture(identity,root.scopeId,{sortBy:"displayName"});
  await Promise.all(Array.from({length:8},async()=>{
    let cursor:string|undefined;
    for(let request=0;request<15;request++) {
      const started=performance.now();
      const page=await exports.inventory.page(inventorySelection.id,identity,{limit:50,cursor});
      durations.push(performance.now()-started);
      assert.equal(page.value.length,50);
      assert.equal(page.counts.total,1000);
      assert.equal(page.counts.filtered,1000);
      cursor=page.page.nextCursor??undefined;
    }
  }));
  const inventoryExport=await exports.create(identity,{selectionId:inventorySelection.id,kind:"graph_packages"});
  await exports.build(inventoryExport,identity,"graph_packages");
  const inventoryCsv=await exports.status(inventoryExport,identity);
  const childRows=(await fixture.runtime.query(`SELECT count(*)::int AS count FROM inventory_facts
    WHERE generation_id=$1 AND (kind LIKE 'detail:%' OR kind IN ('collection','element','elementGroup','identifier',
      'connectorOperation','supportedHosts','elementTypes','categories','allowedUsersAndGroups','acquireUsersAndGroups'))`,
  [root.baselineId])).rows[0].count;
  assert.equal(childRows,2000);
  assert.equal(inventoryCsv.rows,3000);
  let inventoryBytes=0;
  for await(const chunk of exports.engine.download(inventoryExport,identity,new AbortController().signal)) {
    assert.ok(chunk.length<=262144); inventoryBytes+=chunk.length;
  }
  assert.equal(inventoryBytes,inventoryCsv.bytes);

  const bundleId=randomUUID();
  const metadata={reportingPeriod:{startDate:"2026-06-01",endDate:"2026-06-30",provenance:"operator_asserted" as const},sourceAsOf:{value:"2026-07-01T00:00:00Z",provenance:"operator_asserted" as const}};
  const reports={
    agents:"Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)\n"
      +Array.from({length:250},(_,i)=>`agent-${i},Agent ${i},Your org,1,0,${i+1},2026-06-30`).join("\n"),
    userAgents:"Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)\n"
      +Array.from({length:250},(_,i)=>`agent-${i},Agent ${i},Your org,user-${i}@example.invalid,${i+1},2026-06-30`).join("\n"),
    users:"Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\n"
      +Array.from({length:250},(_,i)=>`user-${i}@example.invalid,User ${i},1,${i+1},2026-06-30`).join("\n"),
  };
  for (const content of Object.values(reports)) {
    await usageRepository.stage(identity,{bundleId},(async function*(){yield Buffer.from(content);})(),metadata);
  }
  await usageRepository.acceptBundle(identity,bundleId,await usageRepository.bundle(identity,bundleId));
  const selection=await reader.capture(identity,"delegated","official_users");
  const page=await reader.page(selection.id,identity,{limit:50});
  assert.equal(page.counts.total,250); assert.equal(page.value.length,50); assert.ok(page.page.nextCursor);
  const exportId=await exports.create(identity,{selectionId:selection.id,kind:"official_users"});
  await exports.build(exportId,identity,"official_users");
  const exported=await exports.status(exportId,identity), checksum=createHash("sha256");
  let exportedBytes=0;
  for await(const chunk of exports.engine.download(exportId,identity,new AbortController().signal)) {
    assert.ok(chunk.length<=262144); checksum.update(chunk); exportedBytes+=chunk.length;
  }
  assert.equal(exported.rows,250); assert.equal(exportedBytes,exported.bytes); assert.equal(checksum.digest("hex").length,64);

  const submitted=[];
  for (let index=0;index<5;index+=1) submitted.push(await packageRepository.submit(scope,{
    authorizationPrincipalId:scope.principalId,tokenMode:"delegated",idempotencyKey:`cache-load-queue-${index}`,requestedIds:[`load-${String(index).padStart(4,"0")}`],
  }));
  await assert.rejects(()=>packageRepository.submit(scope,{
    authorizationPrincipalId:scope.principalId,tokenMode:"delegated",idempotencyKey:"cache-load-queue-overflow",requestedIds:["load-0009"],
  }),error=>Boolean(error && typeof error==="object" && "code" in error && error.code==="job_limit"));
  const oldestAge=Date.now()-Math.min(...submitted.map(job=>Date.parse(job.createdAt)));
  assert.ok(oldestAge<30_000,"Cache-only queue age exceeded 30 seconds.");

  durations.sort((left,right)=>left-right);
  const p95=durations[Math.ceil(durations.length*0.95)-1];
  const finalRss=process.memoryUsage().rss;
  const finalSize=Number((await fixture.operator.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
  const result={event:"cache_only_load",outcome:"passed",requests:durations.length,p95Ms:Number(p95.toFixed(2)),
    csvRows:inventoryCsv.rows,usageRows:750,queueAccepted:5,queueRejected:1,poolConnections:fixture.runtime.totalCount,
    rssGrowthBytes:finalRss-initialRss,databaseGrowthBytes:finalSize-initialSize,oldestQueueAgeMs:oldestAge};
  assert.ok(p95<2_000,`Cache-only p95 ${p95}ms exceeded 2000ms.`);
  assert.ok(finalRss-initialRss<256*1024*1024,"Load memory growth exceeded 256 MiB.");
  assert.ok(finalSize-initialSize<128*1024*1024,"Load database growth exceeded 128 MiB.");
  assert.ok(fixture.runtime.totalCount<=4 && fixture.runtime.waitingCount===0,"Database pool exceeded its four-connection bound.");
  console.log(JSON.stringify(result));
} finally {
  await fixture.close();
}
