import type pg from "pg";
import { generationInput, selectionIdentity } from "./largeTenantFixtures.js";
import { UserSourceStages } from "../src/db/userSourceStages.js";
import type { CopilotDirectoryUser } from "../src/types/copilotUsage.js";
import type { ActivityRecord } from "../src/db/dataGenerations.js";
import { activitySourceRecord } from "../src/services/userSourceRecords.js";

export const officeFixtureDate = new Date().toISOString().slice(0,10);
export function officeFixturePerson(index=1, overrides: Partial<CopilotDirectoryUser> = {}): CopilotDirectoryUser {
  const id=`00000000-0000-0000-0000-${String(index).padStart(12,"0")}`;
  return { serviceEvidenceVersion:1, identity:{ objectId:id,userPrincipalName:`person-${index}@example.invalid`,
    displayName:`Person ${String(index).padStart(4,"0")}`,accountEnabled:true,userType:"Member",employeeType:null,
    companyName:"Example",department:"Office" },copilotServiceState:"enabled",servicePlans:[{
      servicePlanId:"a62f8878-de10-42f3-b68f-6149a25ceb97",service:"M365_COPILOT_APPS",displayName:"Copilot",
      state:"enabled",capabilityStatus:"Enabled",assignedDateTime:null,
    }],...overrides };
}
export function officeFixtureActivity(index=1, dates: Partial<ActivityRecord> = {}, refresh=officeFixtureDate): ActivityRecord {
  return { ...activitySourceRecord({ normalizedUserPrincipalName:`person-${index}@example.invalid`, activity:{
    reportRefreshDate:refresh,lastActivityDate:null,copilotChatLastActivityDate:null,microsoftTeamsCopilotLastActivityDate:null,
    wordCopilotLastActivityDate:null,excelCopilotLastActivityDate:null,powerpointCopilotLastActivityDate:null,
    outlookCopilotLastActivityDate:null,onenoteCopilotLastActivityDate:null,loopCopilotLastActivityDate:null,
  } },index),...dates };
}
export async function publishOfficeSource(database: pg.Pool, source:"directory"|"app_activity",
  rows: readonly CopilotDirectoryUser[] | readonly ActivityRecord[], tenantId=selectionIdentity.tenantId, observedAt?:Date) {
  const stages=new UserSourceStages(database);
  return stages.execute(generationInput({ ...(observedAt ? { observedAt } : {}),
    scope:{ tenantId,kind:"tenant",principalId:null,tokenMode:"tenant",source,selector:"complete" } }),
    async lease => {
      const key=await stages.query(lease,source==="directory" ? "discovery" : "activity",`https://fixture.invalid/${source}`);
      await stages.page(lease,key,`https://fixture.invalid/${source}`,rows.length,source==="directory" ? rows.length : undefined);
      for(let offset=0;offset<rows.length;offset+=250) {
        if(source==="directory") await stages.directory(lease,key,(rows as readonly CopilotDirectoryUser[]).slice(offset,offset+250));
        else await stages.activity(lease,key,(rows as readonly ActivityRecord[]).slice(offset,offset+250));
      }
      await stages.finishQuery(lease,key);
    },{ beforePublish:async()=>{} });
}
