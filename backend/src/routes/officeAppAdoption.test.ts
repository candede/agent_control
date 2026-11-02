import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { officeFixtureActivity, officeFixtureDate, officeFixturePerson, publishOfficeSource } from "../../scripts/officeAppAdoptionFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficeAppAdoptionReads } from "../services/officeAppAdoptionReads.js";
import { config } from "../config.js";
import { createOfficeAppAdoptionRouter } from "./officeAppAdoption.js";
import { errorHandler } from "../errors.js";
import type { OfficeContext, OfficePage, OfficeGroup, OfficeSummary } from "../types/officeAppAdoption.js";
vi.hoisted(()=>{
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON=JSON.stringify([{ tenantId:"11111111-1111-4111-8111-111111111111",
    clientId:"22222222-2222-4222-8222-222222222222",clientSecret:"synthetic-office-http-secret",domains:["example.invalid"] }]);
  process.env.SESSION_SECRET="synthetic-office-http-session-secret";
});
describe("Viewer-capable Office HTTP saved reads",()=>{
  let fixture:Awaited<ReturnType<typeof testDatabase>>, server:Server, origin:string;
  let signedIn=true, roles=["AgentControl.Viewer"];
  const who={ ...selectionIdentity,tenantId:config.tenants[0].tenantId! };
  beforeAll(async()=>{
    fixture=await testDatabase();
    await publishOfficeSource(fixture.runtime,"directory",[officeFixturePerson(),officeFixturePerson(2)],who.tenantId);
    await publishOfficeSource(fixture.runtime,"app_activity",[officeFixtureActivity(1,{ word_date:officeFixtureDate })],who.tenantId);
    const app=express();
    app.use(session({ secret:"synthetic-office-http-session-secret",resave:false,saveUninitialized:false }));
    app.use((request,_response,next)=>{
      if(signedIn) {
        request.session.accountId=who.principalId; request.session.tenantId=who.tenantId;
        request.session.clientId=config.tenants[0].clientId; request.session.rolesValidatedAt=Date.now();
        request.session.user={ tenantId:who.tenantId,homeAccountId:who.principalId,username:"reader@example.invalid",displayName:"Reader",roles };
      }
      next();
    });
    app.use("/api",createOfficeAppAdoptionRouter(new OfficeAppAdoptionReads(fixture.runtime,"synthetic-office-http-cursor-secret"),async()=>who));
    app.use(errorHandler);
    server=await new Promise<Server>(resolve=>{ const listening=app.listen(0,"127.0.0.1",()=>resolve(listening)); });
    const address=server.address(); if(!address || typeof address==="string") throw new Error("http_fixture_missing");
    origin=`http://127.0.0.1:${address.port}`;
  },30000);
  afterAll(async()=>{ await new Promise<void>((resolve,reject)=>server?.close(error=>error ? reject(error) : resolve()));
    await fixture?.close(); });
  const get=(path:string)=>fetch(`${origin}/api/office-app-adoption/${path}`);
  it("returns a typed shared context/summary/groups/facets/people without source permission, inventory or agent report",async()=>{
    const response=await get("context");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const context=await response.json() as OfficeContext;
    expect(context.observation).not.toBeNull();
    expect(Object.keys(context.selection.publicationRevisions).sort()).toEqual(["graph_packages","power_platform","users"]);
    const summary=await (await get(`summary?selectionId=${context.selection.id}`)).json() as OfficeSummary;
    expect(summary.organization?.savedLicensedPeople).toBe(2); expect(summary.organization?.reportedActiveUsers).toBe(1);
    const groups=await (await get(`groups?selectionId=${context.selection.id}&limit=5`)).json() as OfficePage<OfficeGroup>;
    expect(groups.value).toHaveLength(1);
    for(const path of ["departments","history","comparison","facets?kind=company",`groups/${groups.value[0].id}/people`]) {
      expect((await get(`${path}${path.includes("?") ? "&" : "?"}selectionId=${context.selection.id}`)).status).toBe(200);
    }
  });
  it("rejects invalid query/app/group/page/cursor and separate agent context explicitly",async()=>{
    for(const path of ["summary?app=chat","summary?snapshot=agent","groups?limit=100","groups?pageNumber=999",
      "history?limit=101","facets?kind=agent","groups/not-a-group/people","groups?cursor=unsigned","context?company=a&company=b"]) {
      expect((await get(path)).status).toBe(400);
    }
  });
  it("keeps filters bound to the selected observation and refuses actor changes or invalidated sessions",async()=>{
    const context=await (await get("context")).json() as OfficeContext;
    expect((await get(`summary?selectionId=${context.selection.id}&app=word`)).status).toBe(400);
    signedIn=false;
    expect((await get("context")).status).toBe(401);
    signedIn=true; roles=[];
    expect((await get("context")).status).toBe(403);
    roles=["AgentControl.Viewer"];
  });
});
