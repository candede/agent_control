import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { officeFixtureActivity, officeFixtureDate as date, officeFixturePerson, publishOfficeSource } from "../../scripts/officeAppAdoptionFixtures.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficeAppAdoptionRepository } from "./officeAppAdoption.js";
import { OfficeAppAdoptionReads } from "../services/officeAppAdoptionReads.js";
import { DataGenerations } from "./dataGenerations.js";
import { DataSyncService } from "../services/dataSync.js";
import { DataSyncRepository } from "./dataSync.js";
import { readAutomaticInventoryRevisions } from "./inventoryAutomaticRevisions.js";
import { retainRecordData } from "./dataRetention.js";
import { verifyDataGenerationCharges } from "./dataGenerationAccountingSchema.js";
import { verifySchema } from "./schema.js";
import { officeRetentionCutoff } from "../services/officeAppAdoption.js";
import * as officeSemantics from "../services/officeAppAdoption.js";
import * as copilotSemantics from "../types/copilotUsage.js";
import { reconcileRestoredSources } from "../../scripts/backup.js";
import { checkpointQueries, observeQueryWork } from "../services/peakMemory.js";

describe("retained Office SQL/publication/lifecycle",()=>{
  let fixture:Awaited<ReturnType<typeof testDatabase>>, reads:OfficeAppAdoptionReads, repository:OfficeAppAdoptionRepository;
  beforeEach(async()=>{ fixture=await testDatabase(); reads=new OfficeAppAdoptionReads(fixture.runtime,"synthetic-office-cursor-secret-32");
    repository=new OfficeAppAdoptionRepository(fixture.runtime); },30000);
  afterEach(async()=>{ vi.restoreAllMocks(); vi.useRealTimers(); await fixture?.close(); });
  async function seed() {
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson(),officeFixturePerson(2)]);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date,excel_date:date }),
      officeFixtureActivity(2,{ chat_date:date,last_activity_date:date })]);
  }
  async function gc() {
    let idle=0;
    for(let pass=0;pass<80;pass++) {
      const changes=await repository.connections.run(client=>retainRecordData(client,250));
      idle=Object.values(changes).some(value=>value>0) ? 0 : idle+1;
      if(idle===2) break;
    }
    await verifyDataGenerationCharges(fixture.operator);
  }
  it.each(["directory","app_activity"] as const)("captures automatically after %s-first publication, independent of agent imports/inventory",async first=>{
    const persons=[officeFixturePerson(),officeFixturePerson(2)], apps=[officeFixtureActivity(1,{ word_date:date,teams_date:date }),
      officeFixtureActivity(2,{ chat_date:date,last_activity_date:date })];
    await publishOfficeSource(fixture.runtime,first,first==="directory" ? persons : apps);
    expect((await reads.context(selectionIdentity,{})).observation).toBeNull();
    await publishOfficeSource(fixture.runtime,first==="directory" ? "app_activity" : "directory",first==="directory" ? apps : persons);
    const summary=await reads.summary(selectionIdentity,{});
    expect(summary.organization).toMatchObject({ savedLicensedPeople:2,reportedActiveUsers:1,activeUserAppPairs:2,
      appsUsed:2,noRecentEvidencePeople:1,unknownEvidencePeople:1 });
    expect(summary.context.observation?.coverage.state).toBe("partial");
    expect((await fixture.operator.query("SELECT (SELECT count(*) FROM official_usage_sets) AS reports,(SELECT count(*) FROM inventory_roots) AS inventory")).rows[0])
      .toEqual({ reports:"0",inventory:"0" });
  });
  it("freezes complete header coverage once and denies published coverage or provenance changes",async()=>{
    await seed();
    const context=await reads.context(selectionIdentity,{});
    const header=(await fixture.operator.query("SELECT coverage FROM office_observations WHERE generation_id=$1",[context.observation!.id])).rows[0];
    expect(header.coverage).toEqual(context.observation!.coverage);
    expect(header.coverage).toMatchObject({ directoryPeople:2,reportedRows:2,paidInactivePeople:0,
      noPaidPeople:0,unknownLicensePeople:0,unknownReasons:{ no_app_dates:1 } });
    await expect(fixture.runtime.query("UPDATE office_observations SET coverage=coverage WHERE generation_id=$1",[context.observation!.id]))
      .rejects.toThrow("Office evidence is immutable");
    await expect(fixture.runtime.query("UPDATE office_observations SET report_refresh_date=report_refresh_date WHERE generation_id=$1",[context.observation!.id]))
      .rejects.toThrow("permission denied");
    expect((await reads.context(selectionIdentity,{},context.selection.id)).observation).toEqual(context.observation);
    await verifyDataGenerationCharges(fixture.operator);
  });
  it("admits automatic current and weekly capture as one writer beside another tenant collection",async()=>{
    const input=generationInput();
    const other=await repository.generations.begin(generationInput({
      scope:{ ...input.scope,source:"inventory_packages" },
    }));
    try {
      await seed();
      expect((await reads.summary(selectionIdentity,{})).organization?.reportedActiveUsers).toBe(1);
      expect((await reads.history(selectionIdentity,{})).value).toHaveLength(1);
    } finally {
      await repository.generations.abort(other);
    }
  });
  it("preserves current and weekly evidence when the incoming provider report date regresses",async()=>{
    await seed();
    const before=await reads.summary(selectionIdentity,{});
    const history=await reads.history(selectionIdentity,{});
    const previous=new Date(Date.parse(`${date}T00:00:00Z`)-7*86400000).toISOString().slice(0,10);
    vi.spyOn(copilotSemantics,"isCopilotAppActivityFresh").mockReturnValue(true);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{outlook_date:previous},previous)]);
    const after=await reads.summary(selectionIdentity,{});
    expect(after.organization).toEqual(before.organization);
    expect(after.context.observation).toEqual(before.context.observation);
    expect(after.context.status).toMatchObject({state:"unavailable",errorCode:"office_report_regressed"});
    expect((await reads.history(selectionIdentity,{})).value).toEqual(history.value);
  });
  it("keeps unrelated-writer limits and source exclusivity when admitting a paired Office job",async()=>{
    const input=generationInput();
    const current=await repository.generations.begin(generationInput({
      scope:{ ...input.scope,source:"office_app_adoption",selector:"current" },jobKind:"derived",jobId:input.jobId,
    }));
    try {
      const weekly=await repository.generations.begin(generationInput({
        scope:{ ...input.scope,source:"office_history",selector:`${officeSemantics.officeWeekStart(date)}:D28:v2` },
        jobKind:"derived",jobId:input.jobId,
      }));
      try {
        const unrelated=await repository.generations.begin(generationInput());
        try {
          await expect(repository.generations.begin(generationInput({
            scope:{ ...input.scope,source:"app_activity" },
          }))).rejects.toMatchObject({code:"data_ingestion_admission"});
          await expect(repository.generations.begin(generationInput({
            scope:{ ...input.scope,source:"office_history",selector:"another-week" },jobKind:"derived",jobId:input.jobId,
          }))).rejects.toMatchObject({code:"data_source_active"});
        } finally {
          await repository.generations.abort(unrelated);
        }
      } finally {
        await repository.generations.abort(weekly);
      }
    } finally {
      await repository.generations.abort(current);
    }
  });
  it("rejects the entire bounded fact insert when even one generation is already published",async()=>{
    await seed();
    const original=await reads.context(selectionIdentity,{});
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson(),officeFixturePerson(2)]);
    recovery.mockRestore();
    let checked=false;
    const result=await repository.reconcile(selectionIdentity.tenantId,{ afterBatch:async()=>{
      if(checked) return;
      checked=true;
      const active=(await fixture.runtime.query(`SELECT g.id FROM data_generations g JOIN office_observations o
        ON o.generation_id=g.id WHERE g.state='staging' AND g.tenant_id=$1`,[selectionIdentity.tenantId])).rows[0].id;
      await expect(fixture.runtime.query(`INSERT INTO office_person_facts(generation_id,scope_id,tenant_id,identity,payload)
        SELECT generation_id,scope_id,tenant_id,identity||':probe',
          jsonb_set(payload,'{identity}',to_jsonb(identity||':probe'))
        FROM office_person_facts WHERE generation_id=ANY($1::uuid[])
          AND identity=(SELECT min(identity) FROM office_person_facts WHERE generation_id=$2)
        ORDER BY generation_id=$2 DESC`,[[original.observation!.id,active],active]))
        .rejects.toThrow("Office evidence requires a fenced staging lease");
      expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM office_person_facts WHERE identity LIKE '%:probe'")).rows[0].n).toBe(0);
    } });
    expect(checked).toBe(true);
    expect(result.state).toBe("noop");
    expect((await reads.context(selectionIdentity,{},original.selection.id)).observation).toEqual(original.observation);
    await verifyDataGenerationCharges(fixture.operator);
  });
  it("preserves capture/provenance on semantic six-hour replays; two idle recovery ticks never recopy",async()=>{
    await seed();
    const first=await reads.context(selectionIdentity,{});
    await new Promise(resolve=>setTimeout(resolve,5));
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson(),officeFixturePerson(2)]);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date,excel_date:date }),
      officeFixtureActivity(2,{ chat_date:date,last_activity_date:date })]);
    const next=await reads.context(selectionIdentity,{});
    expect(next.observation).toEqual(first.observation);
    const query=vi.spyOn(repository.connections,"selectedRead"), graph=vi.spyOn(globalThis,"fetch");
    await repository.recover(); await repository.recover();
    expect(query).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(await repository.reconcile(selectionIdentity.tenantId)).toEqual({ state:"idle",copied:0 });
    await gc();
    expect((await reads.context(selectionIdentity,{},first.selection.id)).observation).toEqual(first.observation);
  });
  it("reuses signed frozen people counts only after validating the same query, group and selected roots",async()=>{
    await seed();
    const context=await reads.context(selectionIdentity,{});
    const group=(await reads.groups(selectionIdentity,context.query,context.selection.id)).value[0];
    let countReads=0;
    const stop=observeQueryWork(point=>{
      if(point.sql.includes("SELECT count(*)::text AS total,") && point.sql.includes("payload->>'groupId'=$3")) countReads++;
    });
    fixture.runtime.on("acquire",checkpointQueries);
    try {
      const first=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:1});
      const second=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:1,cursor:first.page.nextCursor!});
      const back=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:1,cursor:second.page.previousCursor!});
      expect([first.counts,second.counts,back.counts]).toEqual(Array(3).fill({total:2,filtered:2}));
      expect(second.value[0].identity).not.toBe(first.value[0].identity);
      expect(back.value).toEqual(first.value);
      expect(countReads).toBe(1);
      await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:1,pageNumber:2});
      expect(countReads).toBe(2);
      await expect(reads.people(selectionIdentity,context.query,"f".repeat(64),context.selection.id,{limit:1,cursor:first.page.nextCursor!}))
        .rejects.toThrow();
      await expect(reads.people(selectionIdentity,{app:"word"},group.id,context.selection.id,{limit:1,cursor:first.page.nextCursor!}))
        .rejects.toThrow();
      await new DataSyncRepository(fixture.runtime).submit(selectionIdentity,{mode:"full",clearSavedData:true});
      await expect(reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:1,cursor:first.page.nextCursor!}))
        .rejects.toThrow();
      expect(countReads).toBe(2);
    } finally { stop(); fixture.runtime.off("acquire",checkpointQueries); }
  });
  it("seeks forward and backward through canonical ties and missing display names without scanning preceding people pages",async()=>{
    const names=["Ａlpha","Alpha","Beta","Beta","Middle",null,null];
    const people=names.map((displayName,index)=>{
      const person=officeFixturePerson(index+1);
      return {...person,identity:{...person.identity,displayName}};
    });
    await publishOfficeSource(fixture.runtime,"directory",people);
    await publishOfficeSource(fixture.runtime,"app_activity",people.map((_,index)=>
      officeFixtureActivity(index+1,{word_date:index%2===0 && index<5 ? date : null})));
    const context=await reads.context(selectionIdentity,{});
    const group=(await reads.groups(selectionIdentity,context.query,context.selection.id)).value[0];
    const first=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:3});
    const sql:string[]=[];
    const stop=observeQueryWork(point=>{
      if(point.sql.startsWith("SELECT payload,identity")) sql.push(point.sql);
    });
    fixture.runtime.on("acquire",checkpointQueries);
    try {
      const second=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:3,cursor:first.page.nextCursor!});
      const third=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:3,cursor:second.page.nextCursor!});
      const back=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:3,cursor:third.page.previousCursor!});
      const beginning=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:3,cursor:back.page.previousCursor!});
      expect([first,second,third].map(page=>page.value.map(person=>person.identity)))
        .toEqual([people.slice(0,3),people.slice(3,6),people.slice(6)].map(rows=>rows.map(person=>person.identity.objectId)));
      expect([first,second,third].map(page=>page.page.number)).toEqual([1,2,3]);
      expect([first,second,third].map(page=>page.counts)).toEqual(Array(3).fill({total:7,filtered:7}));
      expect(third.page.nextCursor).toBeNull();
      expect(back.value).toEqual(second.value);
      expect(beginning.value).toEqual(first.value);
      expect(beginning.page.previousCursor).toBeNull();
      expect(sql).toHaveLength(4);
      expect(sql.every(query=>!query.includes("OFFSET"))).toBe(true);
      const numbered=await reads.people(selectionIdentity,context.query,group.id,context.selection.id,{limit:3,pageNumber:2});
      expect(numbered.value).toEqual(second.value);
      expect(sql.at(-1)).toContain("OFFSET");
      const narrowed=await reads.context(selectionIdentity,{app:"word"});
      const active=await reads.people(selectionIdentity,narrowed.query,group.id,narrowed.selection.id,{limit:2});
      const end=await reads.people(selectionIdentity,narrowed.query,group.id,narrowed.selection.id,{limit:2,cursor:active.page.nextCursor!});
      expect([active.counts,end.counts]).toEqual(Array(2).fill({total:7,filtered:3}));
      expect([...active.value,...end.value].map(person=>person.identity))
        .toEqual([people[0],people[2],people[4]].map(person=>person.identity.objectId));
    } finally { stop(); fixture.runtime.off("acquire",checkpointQueries); }
  });
  it("atomically replaces same-date changed facts, invalidates old selections, and serializes simultaneous corrections",async()=>{
    await seed();
    const first=await reads.context(selectionIdentity,{});
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date,teams_date:date }),
      officeFixtureActivity(2,{ word_date:date })]);
    recovery.mockRestore();
    const outcomes=await Promise.all([repository.reconcile(selectionIdentity.tenantId),repository.reconcile(selectionIdentity.tenantId)]);
    expect(outcomes.some(outcome=>outcome.state==="published")).toBe(true);
    expect(outcomes.filter(outcome=>outcome.state==="published")).toHaveLength(1);
    const next=await reads.context(selectionIdentity,{});
    expect(next.observation!.id).not.toBe(first.observation!.id);
    expect((await reads.history(selectionIdentity,{})).value).toHaveLength(1);
    await expect(reads.context(selectionIdentity,{},first.selection.id)).rejects.toMatchObject({ code:"selection_invalidated" });
    expect((await reads.summary(selectionIdentity,{})).organization).toMatchObject({ reportedActiveUsers:2,activeUserAppPairs:3 });
  });
  it("replaces omitted report rows with unknown evidence while preserving unverified directory identities",async()=>{
    await seed();
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(2,{ word_date:date })]);
    const summary=await reads.summary(selectionIdentity,{});
    expect(summary.organization).toMatchObject({ reportedActiveUsers:1,unknownEvidencePeople:1,noRecentEvidencePeople:1 });
    expect(summary.context.observation?.coverage.retainedRows).toBe(0);
    const group=(await reads.groups(selectionIdentity,{})).value[0];
    const people=(await reads.people(selectionIdentity,{},group.id)).value;
    expect(people[0].dates.word).toBeNull();
    expect(people[0].recentApps).toEqual([]);
    expect(people[0].unknownReasons).toContain("missing_row");
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson(2)]);
    expect((await reads.context(selectionIdentity,{})).observation?.coverage.unknownReasons.retained_directory).toBe(1);
  });
  it("does not guess ambiguous/duplicate/concealed aliases and freezes paid eligibility/organization context",async()=>{
    const one=officeFixturePerson(), two=officeFixturePerson(2), inactive=officeFixturePerson(3);
    two.identity.userPrincipalName=one.identity.userPrincipalName;
    inactive.copilotServiceState="disabled"; inactive.servicePlans=inactive.servicePlans.map(plan=>({ ...plan,state:"disabled",capabilityStatus:null }));
    await publishOfficeSource(fixture.runtime,"directory",[one,two,inactive,
      officeFixturePerson(4,{ copilotServiceState:"warning",servicePlans:one.servicePlans.map(plan=>({ ...plan,state:"warning",capabilityStatus:"Warning" })) }),
      officeFixturePerson(5,{ copilotServiceState:"unknown",servicePlans:[] })]);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date }),officeFixtureActivity(4,{ excel_date:date }),
      officeFixtureActivity(6,{ upn_key:"concealed-token",word_date:date })]);
    const context=await reads.context(selectionIdentity,{});
    expect((await reads.summary(selectionIdentity,{},context.selection.id)).organization).toMatchObject({ savedLicensedPeople:3,reportedActiveUsers:1,
      noRecentEvidencePeople:2,unknownEvidencePeople:2 });
    expect(context.observation?.coverage).toMatchObject({ paidInactivePeople:1,unknownLicensePeople:1,unknownReasons:{ ambiguous_identity:2 } });
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ upn_key:one.identity.objectId,word_date:date }),
      officeFixtureActivity(4,{ excel_date:date }),officeFixtureActivity(7,{ upn_key:one.identity.objectId,word_date:date })]);
    expect((await reads.context(selectionIdentity,{})).observation?.coverage.unknownReasons.ambiguous_identity).toBeGreaterThan(0);
  });
  it("bounds full-dataset groups/facets/people and ranks champions before pagination; app filters preserve group denominators",async()=>{
    const persons=Array.from({ length:112 },(_,index)=>officeFixturePerson(index+1));
    for(let index=0;index<persons.length;index++) {
      persons[index].identity.companyName=index<102 ? " Ｅxample " : `Company ${index}`;
      persons[index].identity.department=index<102 ? " Office " : null;
    }
    await publishOfficeSource(fixture.runtime,"directory",persons);
    await publishOfficeSource(fixture.runtime,"app_activity",persons.map((_,index)=>officeFixtureActivity(index+1,{
      word_date:date,...(index===101 ? { excel_date:date,teams_date:date } : {}),
    })));
    const groups=await reads.groups(selectionIdentity,{});
    expect(groups.counts).toEqual({ total:11,filtered:11 }); expect(groups.value).toHaveLength(5); expect(groups.page.pages).toBe(3);
    const second=await reads.groups(selectionIdentity,{},groups.context.selection.id,{ cursor:groups.page.nextCursor! });
    expect(second.page.number).toBe(2); expect(second.value[0].id).not.toBe(groups.value[0].id);
    const third=await reads.groups(selectionIdentity,{},groups.context.selection.id,{ pageNumber:3 });
    expect(third.value).toHaveLength(1);
    const anchored=await reads.groups(selectionIdentity,{},groups.context.selection.id,{ anchor:third.value[0].id });
    expect(anchored.page.number).toBe(3);
    const facets=await reads.facets(selectionIdentity,{},"company",undefined,{ limit:5 });
    expect(facets.counts.total).toBe(11); expect(facets.page.nextCursor).not.toBeNull();
    const facetSecond=await reads.facets(selectionIdentity,{},"company",facets.context.selection.id,{ limit:5,cursor:facets.page.nextCursor! });
    const facetThird=await reads.facets(selectionIdentity,{},"company",facets.context.selection.id,{ limit:5,cursor:facetSecond.page.nextCursor! });
    expect(new Set([...facets.value,...facetSecond.value,...facetThird.value].map(facet=>facet.value)).size).toBe(11);
    await expect(reads.groups(selectionIdentity,{},groups.context.selection.id,{ anchor:third.value[0].id,pageNumber:1 })).rejects.toMatchObject({ code:"invalid_cursor" });
    const scoped=await reads.groups(selectionIdentity,{ company:"example",app:"excel" });
    expect(scoped.value).toHaveLength(1);
    const group=scoped.value[0];
    expect(group.metrics).toMatchObject({ savedLicensedPeople:102,reportedActiveUsers:102,activeUserAppPairs:104,perApp:{ word:102,excel:1,teams:1 } });
    expect(group.filteredPeople).toBe(1); expect(group.champions[0].identity).toBe(persons[101].identity.objectId);
    const filtered=await reads.people(selectionIdentity,{ company:"example",app:"excel" },group.id,scoped.context.selection.id);
    expect(filtered.counts).toEqual({ total:102,filtered:1 });
    const all=await reads.people(selectionIdentity,{ company:"example" },group.id,undefined,{ limit:100 });
    expect(all.value).toHaveLength(100); expect(all.counts).toEqual({ total:102,filtered:102 });
    expect((await reads.people(selectionIdentity,{ company:"example" },group.id,all.context.selection.id,{ limit:100,cursor:all.page.nextCursor! })).value).toHaveLength(2);
    expect((await reads.groups(selectionIdentity,{ company:"example" })).value[0].champions[0].identity).toBe(persons[101].identity.objectId);
    expect((await reads.summary(selectionIdentity,{ company:"example" })).organization!.savedLicensedPeople).toBe(112);
    expect(await reads.summary(selectionIdentity,{company:"example",app:"excel"})).toMatchObject({
      suggestedChampions:13,filteredSuggestedChampions:1,
    });
    expect(()=>reads.groups(selectionIdentity,{},groups.context.selection.id,{ limit:100 })).toThrow(expect.objectContaining({ status:400 }));
    await expect(reads.people(selectionIdentity,{},group.id,groups.context.selection.id,{ limit:101 })).rejects.toMatchObject({ code:"invalid_cursor" });
  },30000);
  it("recovers committed sources after interrupted derivation without Graph or a page visit; source success stays healthy",async()=>{
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockRejectedValue(new Error("interruption"));
    await seed();
    expect((await reads.context(selectionIdentity,{})).observation).toBeNull();
    recovery.mockRestore();
    const before=await readAutomaticInventoryRevisions(selectionIdentity,fixture.runtime);
    const service=new DataSyncService(fixture.runtime);
    await service.recover();
    const after=await readAutomaticInventoryRevisions(selectionIdentity,fixture.runtime);
    expect(after.users).not.toBe(before.users); expect(after.graph_packages).toBe(before.graph_packages); expect(after.power_platform).toBe(before.power_platform);
    expect((await reads.context(selectionIdentity,{})).observation).not.toBeNull();
    expect((await fixture.operator.query("SELECT status FROM user_source_attempts WHERE source IN ('directory','app_activity')")).rows.every(row=>row.status==="available")).toBe(true);
  });
  it("ranks champion ties by normalized label and exact identity; zero breadth never becomes a suggestion",async()=>{
    const persons=Array.from({length:4},(_,index)=>officeFixturePerson(index+1));
    persons[0].identity.displayName=" Alex "; persons[1].identity.displayName="ＡLEX"; persons[2].identity.displayName="Later";
    await publishOfficeSource(fixture.runtime,"directory",persons);
    await publishOfficeSource(fixture.runtime,"app_activity",persons.map((_,index)=>officeFixtureActivity(index+1,index<3 ? {word_date:date} : {})));
    const group=(await reads.groups(selectionIdentity,{})).value[0];
    expect(group.champions.map(person=>person.identity)).toEqual(persons.slice(0,3).map(person=>person.identity.objectId));
    expect(group.champions.every(person=>person.recentApps.length>0)).toBe(true);
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await publishOfficeSource(fixture.runtime,"app_activity",persons.map((_,index)=>officeFixtureActivity(index+1)));
    recovery.mockRestore(); await repository.recover();
    expect((await reads.groups(selectionIdentity,{})).value[0].champions).toEqual([]);
  });
  it("freezes partially-enabled/no-paid/unknown eligibility and normalizes facet identities across departments",async()=>{
    const one=officeFixturePerson(1,{copilotServiceState:"partially_enabled"}), two=officeFixturePerson(2),
      noPaid=officeFixturePerson(3,{copilotServiceState:"disabled",servicePlans:[]}),
      unknown=officeFixturePerson(4,{copilotServiceState:"unknown",servicePlans:[]});
    one.servicePlans.push({...one.servicePlans[0],servicePlanId:"b95945de-b3bd-46db-8437-f2beb6ea2347",
      service:"M365_COPILOT_TEAMS",state:"disabled",capabilityStatus:null});
    one.identity.companyName=" ＥXample "; one.identity.department="A"; two.identity.department="B";
    await publishOfficeSource(fixture.runtime,"directory",[one,two,noPaid,unknown]);
    await publishOfficeSource(fixture.runtime,"app_activity",[1,2,3,4].map(index=>officeFixtureActivity(index,{word_date:date})));
    const summary=await reads.summary(selectionIdentity,{});
    expect(summary.organization).toMatchObject({savedLicensedPeople:2,reportedActiveUsers:2,activeUserAppPairs:2});
    expect(summary.context.observation?.coverage).toMatchObject({noPaidPeople:1,unknownLicensePeople:1});
    const facets=await reads.facets(selectionIdentity,{},"company");
    expect(facets.value).toEqual([{value:"Example",groups:2,people:2}]);
    expect((await reads.groups(selectionIdentity,{company:"example"})).value).toHaveLength(2);
  });
  it("retries failed pending local work and handles cancellation without publishing partial capture",async()=>{
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await seed(); recovery.mockRestore();
    const controller=new AbortController();
    await expect(repository.reconcile(selectionIdentity.tenantId,{ signal:controller.signal,afterBatch:async()=>controller.abort(new Error("cancelled")) })).rejects.toThrow("cancelled");
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("failed");
    await repository.recover();
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("available");
    expect((await fixture.operator.query("SELECT count(*) FROM data_generations WHERE state='published' AND job_kind='derived'")).rows[0].count).toBe("2");
  });
  it("permits derived status checkpoints without allowing published source fields to change",async()=>{
    await seed();
    await fixture.runtime.query(`UPDATE user_source_attempts SET office_status='failed',office_error_code='office_capture_failed',
      office_revision=office_revision+1 WHERE source='app_activity'`);
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("failed");
    await expect(fixture.runtime.query(`UPDATE user_source_attempts SET status='failed',office_revision=office_revision+1
      WHERE source='app_activity'`)).rejects.toThrow("user_source_attempt_fenced");
    await expect(fixture.runtime.query(`UPDATE user_source_attempts SET report_period='D7',office_revision=office_revision+1
      WHERE source='app_activity'`)).rejects.toThrow("user_source_attempt_fenced");
    await repository.recover();
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("available");
    expect((await fixture.operator.query("SELECT status FROM user_source_attempts WHERE source='app_activity'")).rows[0].status).toBe("available");
  });
  it("protects leased source reachability but rejects changed heads before staged evidence can publish",async()=>{
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await seed();
    const old=(await fixture.operator.query("SELECT generation_id FROM data_generation_heads h JOIN data_scope_epochs s ON s.id=h.scope_id WHERE s.source='app_activity'")).rows[0].generation_id;
    await expect(repository.reconcile(selectionIdentity.tenantId,{ afterBatch:async()=>{
      await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ teams_date:date })]);
      await gc();
      expect((await fixture.operator.query("SELECT state FROM data_generations WHERE id=$1",[old])).rows[0].state).toBe("retired");
    } })).rejects.toMatchObject({ code:"office_source_changed" });
    recovery.mockRestore();
    await repository.recover();
    expect((await reads.summary(selectionIdentity,{})).organization?.perApp.teams).toBe(1);
  },30000);
  it("recovers an expired staging lease without retaining partial facts as a canonical capture",async()=>{
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await seed(); recovery.mockRestore();
    await expect(repository.reconcile(selectionIdentity.tenantId,{ afterBatch:async()=>{
      await fixture.operator.query("UPDATE data_generations SET lease_until=clock_timestamp()-interval '1 second' WHERE job_kind='derived' AND state='staging'");
    } })).rejects.toThrow();
    await repository.recover();
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("available");
    expect((await reads.history(selectionIdentity,{})).value).toHaveLength(1);
    await gc();
    expect((await fixture.operator.query("SELECT count(DISTINCT generation_id) FROM office_person_facts")).rows[0].count).toBe("1");
  },30000);
  it("does not downgrade a committed capture when post-commit cleanup is interrupted",async()=>{
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await seed(); recovery.mockRestore();
    const publish=repository.generations.publish.bind(repository.generations);
    vi.spyOn(repository.generations,"publish").mockImplementation(async(lease,options)=>{
      await publish(lease,options);
      throw new Error("cleanup interrupted after commit");
    });
    expect((await repository.reconcile(selectionIdentity.tenantId)).state).toBe("published");
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("available");
    expect((await repository.reconcile(selectionIdentity.tenantId)).state).toBe("idle");
  });
  it("acknowledges a semantic no-op when its commit succeeds but the commit response is lost",async()=>{
    await seed();
    const original=await reads.context(selectionIdentity,{});
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{word_date:date,excel_date:date}),
      officeFixtureActivity(2,{chat_date:date,last_activity_date:date})]);
    recovery.mockRestore();
    const run=repository.connections.run.bind(repository.connections);
    vi.spyOn(repository.connections,"run").mockImplementation(async(work,...options)=>{
      const result=await run(work,...options);
      if(result===true) throw new Error("semantic no-op commit response lost");
      return result;
    });
    expect((await repository.reconcile(selectionIdentity.tenantId)).state).toBe("noop");
    expect((await reads.context(selectionIdentity,{})).observation).toEqual(original.observation);
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("available");
    expect((await repository.reconcile(selectionIdentity.tenantId)).state).toBe("idle");
  });
  it("restore review fences cleared source epochs and never recreates superseded Office facts from old heads",async()=>{
    await seed();
    const current=await testDatabase(), live=await current.operator.connect(), restored=await fixture.operator.connect();
    try {
      await publishOfficeSource(current.runtime,"directory",[officeFixturePerson()]);
      await publishOfficeSource(current.runtime,"app_activity",[officeFixtureActivity(1,{ teams_date:date })]);
      await reconcileRestoredSources(live,restored);
      expect((await reads.context(selectionIdentity,{})).observation).toBeNull();
      expect((await repository.reconcile(selectionIdentity.tenantId)).state).toBe("idle");
      await live.query("UPDATE data_scope_epochs SET epoch=epoch+1 WHERE source IN ('directory','app_activity')");
      await reconcileRestoredSources(live,restored);
      expect((await fixture.operator.query("SELECT count(*) FROM data_generation_heads h JOIN data_scope_epochs s ON s.id=h.scope_id WHERE s.source IN ('directory','app_activity','office_app_adoption')")).rows[0].count).toBe("0");
      await gc();
      expect((await fixture.operator.query("SELECT count(*) FROM office_person_facts")).rows[0].count).toBe("0");
    } finally { live.release(); restored.release(); await current.close(); }
  },30000);
  it("clear during staged copy fences publication and privacy clear cannot resurrect saved identities",async()=>{
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await seed(); recovery.mockRestore();
    await expect(repository.reconcile(selectionIdentity.tenantId,{ beforePublish:async()=>{
      await new DataSyncRepository(fixture.runtime).submit(selectionIdentity,{ mode:"full",clearSavedData:true });
    } })).rejects.toMatchObject({ code:"office_source_changed" });
    await repository.recover();
    expect((await reads.context(selectionIdentity,{})).observation).toBeNull();
    await gc();
    expect((await fixture.operator.query("SELECT count(*) FROM office_person_facts")).rows[0].count).toBe("0");
  });
  it("historical pins survive newer sources and retirement, freeze paid/groups and never include a later comparison point",async()=>{
    const previous=new Date(Date.parse(`${date}T00:00:00Z`)-7*86400000).toISOString().slice(0,10);
    const freshness=vi.spyOn(copilotSemantics,"isCopilotAppActivityFresh").mockReturnValue(true);
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson()]);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:previous },previous)]);
    const archived=(await reads.history(selectionIdentity,{})).value[0].observation;
    const past=await reads.context(selectionIdentity,{officeSnapshot:archived.id});
    freshness.mockRestore();
    const newer=officeFixturePerson(); newer.identity.companyName="New Company"; newer.copilotServiceState="disabled";
    newer.servicePlans=newer.servicePlans.map(plan=>({ ...plan,state:"disabled",capabilityStatus:null }));
    // App-first avoids a same-date correction of the prior capture.
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date })]);
    await publishOfficeSource(fixture.runtime,"directory",[newer]);
    await gc();
    const pinned=await reads.summary(selectionIdentity,past.query,past.selection.id);
    expect(pinned.organization?.savedLicensedPeople).toBe(1);
    expect((await reads.groups(selectionIdentity,past.query,past.selection.id)).value[0].company).toBe("Example");
    await expect(reads.people(selectionIdentity,past.query,(await reads.groups(selectionIdentity,past.query,past.selection.id)).value[0].id,
      past.selection.id)).rejects.toMatchObject({code:"office_history_aggregate_only"});
    expect((await reads.history(selectionIdentity,{ officeSnapshot:past.observation!.id })).value.map(point=>point.observation.id)).toEqual([past.observation!.id]);
    const latest=await reads.context(selectionIdentity,{});
    expect((await reads.summary(selectionIdentity,{ officeBaseline:past.observation!.id })).baseline?.savedLicensedPeople).toBe(1);
    await expect(reads.context(selectionIdentity,{ officeSnapshot:past.observation!.id,officeBaseline:latest.observation!.id })).rejects.toMatchObject({ code:"invalid_office_baseline" });
  });
  it("rejects header-only/future/stale sources, then automatically resumes on valid refreshed evidence",async()=>{
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson()]);
    await publishOfficeSource(fixture.runtime,"app_activity",[]);
    expect((await reads.context(selectionIdentity,{})).observation).toBeNull();
    const future=new Date(Date.parse(`${date}T00:00:00Z`)+86400000).toISOString().slice(0,10);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date },future)]);
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("unavailable");
    const stale=new Date(Date.parse(`${date}T00:00:00Z`)-6*86400000).toISOString().slice(0,10);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:stale },stale)]);
    expect((await reads.context(selectionIdentity,{})).observation).toBeNull();
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:date })]);
    expect((await reads.context(selectionIdentity,{})).observation).not.toBeNull();
  });
  it("resumes automatically when a stale directory refreshes without another app or Graph scan",async()=>{
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson()],selectionIdentity.tenantId,new Date(Date.now()-6*3600000-1000));
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{word_date:date})]);
    expect((await reads.context(selectionIdentity,{})).status.state).toBe("unavailable");
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson()]);
    expect((await reads.summary(selectionIdentity,{})).organization?.reportedActiveUsers).toBe(1);
  });
  it("discloses aged current sources without aging frozen facts or recopying an acknowledged vector",async()=>{
    await seed();
    const original=await reads.summary(selectionIdentity,{});
    vi.useFakeTimers({toFake:["Date"]});
    vi.setSystemTime(new Date(Date.now()+6*3600000+1000));
    const copy=vi.spyOn(repository.connections,"selectedRead");
    await repository.recover(); await repository.recover();
    expect(copy).not.toHaveBeenCalled();
    const aged=await reads.summary(selectionIdentity,{},original.context.selection.id);
    expect(aged.organization).toEqual(original.organization);
    expect(aged.context.observation).toEqual(original.context.observation);
    expect(aged.context.status.state).toBe("unavailable");
  });
  it("invalidates tenant/session/expired reads, renews with anchors, and enforces immutable runtime/root/grant constraints",async()=>{
    await seed();
    const context=await reads.context(selectionIdentity,{});
    await expect(reads.context({ ...selectionIdentity,tenantId:"different" },{},context.selection.id)).rejects.toMatchObject({ code:"selection_invalidated" });
    await expect(reads.context({ ...selectionIdentity,principalId:"other" },{},context.selection.id)).rejects.toMatchObject({ code:"selection_invalidated" });
    await expect(fixture.runtime.query("UPDATE office_person_facts SET identity='changed'")).rejects.toMatchObject({ code:"42501" });
    await expect(fixture.runtime.query("DELETE FROM office_person_facts")).rejects.toThrow("Office evidence requires lifecycle deletion");
    await fixture.operator.query("UPDATE data_read_selections SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[context.selection.id]);
    await expect(reads.context(selectionIdentity,{},context.selection.id)).rejects.toMatchObject({ code:"selection_invalidated" });
    const renewed=await reads.groups(selectionIdentity,{});
    expect(renewed.context.selection.id).not.toBe(context.selection.id);
    await new DataGenerations(fixture.runtime).revokePrincipal(selectionIdentity.tenantId,selectionIdentity.principalId,{ preserveSources:true });
    await expect(reads.context(selectionIdentity,{},renewed.context.selection.id)).rejects.toMatchObject({ code:"selection_invalidated" });
    await verifySchema(fixture.runtime);
  });
  it("retains cutoff equality and bounds dependent-first deletion while releasing generation bytes",async()=>{
    vi.spyOn(officeSemantics,"officeExpiry").mockImplementation(()=>new Date(Date.now()+1000));
    await seed();
    const current=await reads.context(selectionIdentity,{});
    const cutoff=officeRetentionCutoff(new Date());
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(current.observation!.expiresAt)-Date.now())+20));
    await expect(reads.context(selectionIdentity,{},current.selection.id)).rejects.toMatchObject({ code:"selection_invalidated" });
    await gc();
    expect((await fixture.operator.query("SELECT count(*) FROM office_person_facts")).rows[0].count).toBe("0");
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await fixture.operator.query("SELECT generation_bytes FROM data_generation_charges WHERE scope_id=(SELECT scope_id FROM data_generations WHERE id=$1)",[current.observation!.id])).rows[0]?.generation_bytes ?? "0").toBe("0");
  },30000);
  it("invalidates older timeline range dependents before expiry deletion without invalidating newly captured reads",async()=>{
    const expiry=vi.spyOn(officeSemantics,"officeExpiry").mockImplementation(()=>new Date(Date.now()+1500));
    const previous=new Date(Date.parse(`${date}T00:00:00Z`)-7*86400000).toISOString().slice(0,10);
    const freshness=vi.spyOn(copilotSemantics,"isCopilotAppActivityFresh").mockReturnValue(true);
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson()]);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{word_date:previous},previous)]);
    await reads.context(selectionIdentity,{});
    expiry.mockRestore();
    freshness.mockRestore();
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{word_date:date})]);
    const latest=await reads.context(selectionIdentity,{});
    expect((await reads.history(selectionIdentity,{},latest.selection.id)).value).toHaveLength(2);
    expect(Date.parse(latest.selection.expiresAt)-Date.now()).toBeGreaterThan(1000);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(latest.selection.expiresAt)-Date.now())+20));
    await expect(reads.history(selectionIdentity,{},latest.selection.id)).rejects.toMatchObject({code:"selection_invalidated"});
    let invalidated=false;
    for(let pass=0;pass<5 && !invalidated;pass++) {
      await repository.connections.run(client=>retainRecordData(client,1));
      const dependent=(await fixture.operator.query("SELECT invalidated_at IS NOT NULL AS invalidated FROM data_read_selections WHERE id=$1",[latest.selection.id])).rows[0];
      invalidated=!dependent || dependent.invalidated===true;
      if(!invalidated) expect((await fixture.operator.query(`SELECT count(*) FROM office_observations WHERE tenant_id=$1 AND kind='weekly'
        AND report_refresh_date=$2::date`,[selectionIdentity.tenantId,previous])).rows[0].count).toBe("1");
    }
    expect(invalidated).toBe(true);
    await gc();
    await expect(reads.history(selectionIdentity,{},latest.selection.id)).rejects.toMatchObject({code:"selection_invalidated"});
    expect((await reads.history(selectionIdentity,{})).value).toHaveLength(1);
  },30000);
  it("preserves weekly pins when only current person details change or expire",async()=>{
    vi.spyOn(officeSemantics,"officeExpiry").mockReturnValueOnce(new Date(Date.now()+2000));
    await seed();
    const current=await reads.context(selectionIdentity,{});
    const point=(await reads.history(selectionIdentity,{})).value[0];
    const weekly=await reads.context(selectionIdentity,{officeSnapshot:point.observation.id});
    const person=officeFixturePerson();
    await publishOfficeSource(fixture.runtime,"directory",[
      {...person,identity:{...person.identity,displayName:"Updated current person"}},officeFixturePerson(2),
    ]);
    expect((await reads.context(selectionIdentity,weekly.query,weekly.selection.id)).observation).toEqual(point.observation);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(current.observation!.expiresAt)-Date.now())+20));
    expect((await reads.history(selectionIdentity,weekly.query,weekly.selection.id)).value).toEqual([point]);
    await gc();
    expect((await reads.context(selectionIdentity,weekly.query,weekly.selection.id)).observation).toEqual(point.observation);
  },30000);
  it("invalidates a replaced weekly pin when its same-week aggregate actually changes",async()=>{
    await seed();
    const point=(await reads.history(selectionIdentity,{})).value[0];
    const weekly=await reads.context(selectionIdentity,{officeSnapshot:point.observation.id});
    await publishOfficeSource(fixture.runtime,"app_activity",[
      officeFixtureActivity(1,{outlook_date:date}),officeFixtureActivity(2,{outlook_date:date}),
    ]);
    await expect(reads.context(selectionIdentity,weekly.query,weekly.selection.id)).rejects.toMatchObject({code:"selection_invalidated"});
    const next=await reads.history(selectionIdentity,{});
    expect(next.value).toHaveLength(1);
    expect(next.value[0].metrics.perApp.outlook).toBe(2);
  });
  it("rejects atomic publication of generations from unrelated derived jobs",async()=>{
    const input=generationInput();
    const current=await repository.generations.begin(generationInput({
      scope:{...input.scope,source:"office_app_adoption",selector:"current"},jobKind:"derived",
    }));
    try {
      const weekly=await repository.generations.begin(generationInput({
        scope:{...input.scope,source:"office_history",selector:`${officeSemantics.officeWeekStart(date)}:D28:v2`},jobKind:"derived",
      }));
      try {
        await fixture.runtime.query(`UPDATE data_generations SET state='validating',validated=true,
          validation_phase='complete',content_hash=$2 WHERE id=ANY($1::uuid[])`,[[current.id,weekly.id],"a".repeat(64)]);
        await expect(repository.generations.publish(current,{
          relatedLeases:[weekly],validateInputs:async()=>undefined,completeJob:async()=>undefined,
        })).rejects.toThrow("data_related_publication_job");
        expect((await fixture.runtime.query("SELECT count(*) FROM data_generation_heads WHERE generation_id=ANY($1::uuid[])",
          [[current.id,weekly.id]])).rows[0].count).toBe("0");
      } finally {
        await repository.generations.abort(weekly);
      }
    } finally {
      await repository.generations.abort(current);
    }
  });
  it("keeps one aggregate point per UTC week and no historical person rows after seven daily publications",async()=>{
    const start=Date.parse(`${officeSemantics.officeWeekStart(date)}T00:00:00Z`)-7*86400000;
    const freshness=vi.spyOn(copilotSemantics,"isCopilotAppActivityFresh").mockReturnValue(true);
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson(),officeFixturePerson(2)]);
    for(let day=0;day<7;day++) {
      const refresh=new Date(start+day*86400000).toISOString().slice(0,10);
      await publishOfficeSource(fixture.runtime,"app_activity",[
        officeFixtureActivity(1,{outlook_date:refresh},refresh),
        officeFixtureActivity(2,day%2 ? {outlook_date:refresh} : {},refresh),
      ]);
    }
    freshness.mockRestore();
    await gc();
    const history=await reads.history(selectionIdentity,{});
    expect(history.value).toHaveLength(1);
    expect(history.value[0].metrics.perApp.outlook).toBe(1);
    expect((await fixture.operator.query(`SELECT o.kind,count(*)::int AS people FROM office_person_facts p
      JOIN office_observations o ON o.generation_id=p.generation_id GROUP BY o.kind`)).rows).toEqual([{kind:"current",people:2}]);
    const archived=await reads.context(selectionIdentity,{officeSnapshot:history.value[0].observation.id});
    const group=(await reads.groups(selectionIdentity,archived.query,archived.selection.id)).value[0];
    expect(group.metrics.perApp.outlook).toBe(1);
    expect(group.champions).toEqual([]);
    await expect(reads.people(selectionIdentity,archived.query,group.id,archived.selection.id))
      .rejects.toMatchObject({code:"office_history_aggregate_only"});
    await expect(fixture.runtime.query(`INSERT INTO office_person_facts(generation_id,scope_id,tenant_id,identity,payload)
      SELECT o.generation_id,o.scope_id,o.tenant_id,p.identity,p.payload FROM office_person_facts p CROSS JOIN office_observations o
      WHERE o.generation_id=$1 LIMIT 1`,[archived.observation!.id])).rejects.toThrow("Historical Office snapshots contain aggregates only");
    await verifyDataGenerationCharges(fixture.operator);
  },30000);
  it("rolls back current and weekly publication together and retries automatically",async()=>{
    await seed();
    const before=await reads.summary(selectionIdentity,{});
    const weekly=(await reads.history(selectionIdentity,{})).value[0];
    const recovery=vi.spyOn(OfficeAppAdoptionRepository.prototype,"recover").mockResolvedValue();
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{outlook_date:date}),officeFixtureActivity(2,{outlook_date:date})]);
    recovery.mockRestore();
    const publish=repository.generations.publish.bind(repository.generations);
    const failure=vi.spyOn(repository.generations,"publish").mockImplementation((lease,options)=>publish(lease,{
      ...options,beforeCommit:()=>{throw new Error("interrupted atomic publication");},
    }));
    await expect(repository.reconcile(selectionIdentity.tenantId)).rejects.toThrow("interrupted atomic publication");
    expect((await reads.summary(selectionIdentity,{})).organization).toEqual(before.organization);
    expect((await reads.history(selectionIdentity,{})).value[0]).toEqual(weekly);
    failure.mockRestore();
    await repository.recover();
    const current=await reads.summary(selectionIdentity,{});
    const next=(await reads.history(selectionIdentity,{})).value[0];
    expect(current.organization?.perApp.outlook).toBe(2);
    expect(next.metrics).toEqual(current.organization);
    expect((await reads.groups(selectionIdentity,{})).value[0].metrics).toEqual(current.organization);
    await gc();
  },30000);
});
