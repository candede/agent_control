import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { testDatabase } from "./testDatabase.js";
import { PackageInventoryRepository } from "../src/db/packageInventory.js";
import { OfficialUsageRepository } from "../src/db/officialUsage.js";
import { allowlistedPackage } from "../src/services/packageObservation.js";
import { parseOfficialUsageReport } from "../src/services/officialUsageParser.js";
import { buildBoundedCsv } from "../src/services/csvExport.js";

const fixture=await testDatabase();
const packageRepository=new PackageInventoryRepository(fixture.runtime);
const usageRepository=new OfficialUsageRepository(fixture.runtime);
const scope={tenantId:"load-tenant",principalId:"load-principal"};
const durations:number[]=[];
const initialRss=process.memoryUsage().rss;
const initialSize=Number((await fixture.operator.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
try {
  const packageJob=await packageRepository.submit(scope,{authorizationPrincipalId:scope.principalId,tokenMode:"delegated",idempotencyKey:"cache-load-publish"});
  assert.equal(await packageRepository.markRunning(scope,packageJob.id),true);
  const packages=Array.from({length:1000},(_,index)=>allowlistedPackage({
    id:`load-${String(index).padStart(4,"0")}`,
    displayName:`Load package ${index}`,
    isBlocked:index%3===0,
    appId:`load-app-${index}`,
    manifestId:`load-manifest-${index}`,
    assetId:`load-asset-${index}`,
    publisher:index%2 ? "Odd publisher" : "Even publisher",
    supportedHosts:["Copilot"],
  }));
  await packageRepository.publish(scope,packageJob.id,{packages,totalRecords:packages.length,pages:10});

  const concurrent=Array.from({length:120},async (_,index)=>{
    const started=performance.now();
    const page=await packageRepository.list(scope,{limit:50,offset:(index%20)*50,sortBy:"displayName"});
    durations.push(performance.now()-started);
    assert.equal(page.value.length,50);
    assert.equal(page.count,1000);
    assert.ok(page.value.length<=50);
    return page.value.map(row=>({id:row.id,name:row.displayName,blocked:row.isBlocked}));
  });
  const pages=(await Promise.all(concurrent)).flat();
  const exportRows=pages.slice(0,1000);
  const csv=buildBoundedCsv(["id","name","blocked"],exportRows,{maximumRows:1000,maximumBytes:2_000_000,deadlineAt:Date.now()+15_000});
  assert.equal(csv.rowCount,1000);

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
    const preview=await usageRepository.stage(scope,{report:parseOfficialUsageReport(Buffer.from(content),metadata),fileHash:createHash("sha256").update(content).digest("hex"),bundleId});
    await usageRepository.accept(scope,preview.id,{stagingRevision:preview.revision,fileHash:preview.fileHash,expectedActiveRevision:preview.activeRevision});
  }
  const published=await usageRepository.getPublished(scope.tenantId);
  assert.equal(published.reports.users?.rows.length,250);

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
    csvRows:csv.rowCount,usageRows:750,queueAccepted:5,queueRejected:1,poolConnections:fixture.runtime.totalCount,
    rssGrowthBytes:finalRss-initialRss,databaseGrowthBytes:finalSize-initialSize,oldestQueueAgeMs:oldestAge};
  assert.ok(p95<2_000,`Cache-only p95 ${p95}ms exceeded 2000ms.`);
  assert.ok(finalRss-initialRss<256*1024*1024,"Load memory growth exceeded 256 MiB.");
  assert.ok(finalSize-initialSize<128*1024*1024,"Load database growth exceeded 128 MiB.");
  assert.ok(fixture.runtime.totalCount<=4 && fixture.runtime.waitingCount===0,"Database pool exceeded its four-connection bound.");
  console.log(JSON.stringify(result));
} finally {
  await fixture.close();
}
