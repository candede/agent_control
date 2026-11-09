import { afterEach, describe, expect, it } from "vitest";
import { closeAuditOriginHttp, setupAuditOriginHttp } from "./auditOriginHttpTestSupport.js";
import { account } from "../auth/authFoundationTestSupport.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { departmentEvidence, publishDepartmentEvidenceOffice, publishDepartmentEvidenceReports } from "../../scripts/departmentEvidenceFixtures.js";
import type { OpportunityPage, OpportunityPeoplePage } from "../types/departmentOpportunity.js";
import type { AppRole } from "../types/capability.js";
import { sdkJourney } from "./mcpSdkJourneyTestSupport.js";
import { randomUUID } from "node:crypto";
import { saveUsageInventory } from "../db/agentUsageTestSupport.js";
import { officeFixturePerson } from "../../scripts/officeAppAdoptionFixtures.js";
import { manualDraft } from "../services/adoptionContentTestSupport.js";
import type { SdkTrace } from "./mcpSdkJourneyTestSupport.js";
import type { AdoptionPage } from "../types/adoption.js";
import type { AgentAboutPage, ChampionAgentPage } from "../types/savedReadContracts.js";
import type { ContentSave, ContentRecord, ContentFollowUp } from "../types/adoptionContent.js";

afterEach(closeAuditOriginHttp);
describe("ordinary authenticated opportunity API/MCP routes", () => {
  it.skipIf(!process.env.AGENT_CONTROL_MCP_SQL_JOURNEY)("retrieves the complete controlled customer brief then explicitly saves across SDK and another browser account", async () => {
    const h = await setupAuditOriginHttp("mcp", account(), undefined, ["AgentControl.Viewer"]);
    const identity = await reportIdentity(h.database, h.actor);
    await publishDepartmentEvidenceOffice(h.database, identity);
    const imported = await publishDepartmentEvidenceReports(h.database, identity, { microsoftAgents: [departmentEvidence.agents[1]] });
    const ids = [1, 2, 3].map(index => `94000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    const descriptions = ids.map((_, index) => `${"Review approved business material. ".repeat(index === 0 ? 200 : 10)}Complete About tail ${index}.`);
    await saveUsageInventory(h.database, identity, ids.map((canonicalId, index) => ({
      canonicalId, packages: [departmentEvidence.agents[index]],
      packageFields: { type: index === 1 ? "firstParty" : "custom", publisher: index === 1 ? "Microsoft" : "Example",
        displayName: "Duplicate assistant name", longDescription: descriptions[index], ownerId: null },
      ...(index === 0 ? { native: { nativeId: "controlled-local", environmentId: null,
        createdBy: officeFixturePerson(1).identity.objectId! } } : {}),
    })));
    const traces: SdkTrace[] = [], start = performance.now();
    const call = async <T>(name: string, request: Record<string, unknown>): Promise<T> =>
      (await sdkJourney(h, [{ name, request }], undefined, trace => traces.push(...trace)))[0] as T;
    const options = await call<{ value: unknown[]; nextCursor: string | null }>("list_report_options", { limit: 50 });
    expect(JSON.stringify(options)).toContain(imported.setId);
    expect(options.nextCursor ?? null).toBeNull();
    const inventory = await call<{ id: string }>("capture_agent_inventory", { query: { inventoryScope: "all" } });
    const scope = { company: departmentEvidence.company, department: departmentEvidence.department, setId: imported.setId };
    const opportunity = await call<OpportunityPage>("list_department_opportunities", { ...scope, inventorySelectionId: inventory.id, limit: 10 });
    expect(opportunity.value).toHaveLength(1);
    const group = opportunity.value[0];
    expect(group.agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
    expect(opportunity.page.nextCursor).toBeNull();
    expect(opportunity.context.office.observation!.reportRefreshDate).not.toBe(opportunity.context.report.reports.reportingPeriod!.endDate);
    const report = await call<AdoptionPage>("list_adoption_groups", { ...scope, limit: 10 });
    expect(report.value).toHaveLength(1); expect(report.page.nextCursor).toBeNull();
    const peers = await call<ChampionAgentPage>("list_champion_agents", {
      selectionId: report.selection.id, inventorySelectionId: inventory.id, limit: 50,
    });
    expect(peers.champions).toHaveLength(3); expect(peers.page.nextCursor).toBeNull();
    const championIds = report.value[0].people.filter(person => person.champion).map(person => person.id);
    expect(peers.champions.map(person => person.objectId)).toEqual(championIds);
    expect(peers.value.filter(edge => edge.relationship === "used").map(edge => [edge.personId, edge.id]).sort()).toEqual(
      [1, 2, 3].map(index => [officeFixturePerson(index).identity.objectId, `agent:${ids[index - 1]}`]).sort());
    expect(peers.value.filter(edge => edge.relationship === "created")).toEqual([
      expect.objectContaining({ personId: officeFixturePerson(1).identity.objectId, id: `agent:${ids[0]}`, relationship: "created" }),
    ]);
    for (const [index, id] of ids.entries()) {
      const recordId = `agent:${id}`;
      const members = await call<{ value: Array<{ source_scope_id: string; source_identity: string; domain: string }>; nextCursor: string | null }>(
        "list_agent_members", { selectionId: inventory.id, recordId, limit: 50 });
      expect(members.nextCursor).toBeNull();
      let graphText = "";
      for (const member of members.value) {
        const field = member.domain === "packages" ? "long" : "native";
        let cursor: string | undefined, returned = 0, text = "";
        do {
          const about = await call<AgentAboutPage>("read_agent_about", { selectionId: inventory.id, recordId,
            sourceScopeId: member.source_scope_id, sourceIdentity: member.source_identity, field, ...(cursor ? { cursor } : {}) });
          expect(about.totalBytes).toBeLessThanOrEqual(16384);
          text += about.text ?? ""; returned += about.returnedBytes; cursor = about.nextCursor ?? undefined;
          if (!cursor) expect(returned).toBe(about.totalBytes);
          if (field === "native") expect(about.state).toBe("missing");
        } while (cursor);
        if (field === "long") graphText += text;
      }
      expect(graphText).toBe(descriptions[index]);
      await call("get_agent_usage", { recordId, selectionId: inventory.id,
        inventorySelectionId: inventory.id, setId: imported.setId });
    }
    const retrieval = { calls: traces.length, bytes: traces.reduce((sum, trace) => sum + trace.bytes, 0),
      seconds: (performance.now() - start) / 1000, traces: [...traces] };
    console.info(JSON.stringify({ event: "complete_department_customer_retrieval", ...retrieval,
      peers: peers.champions.length, agents: ids.length, descriptionBytes: descriptions.map(text => Buffer.byteLength(text)),
      semanticModelProof: false, authWaitSeconds: 0 }));
    expect(retrieval.calls).toBeLessThanOrEqual(16); expect(retrieval.bytes).toBeLessThanOrEqual(1024 ** 2);
    expect(retrieval.calls).toBeLessThanOrEqual(32); expect(retrieval.bytes).toBeLessThanOrEqual(4 * 1024 ** 2);
    expect(retrieval.seconds).toBeLessThanOrEqual(180);
    const draft = { ...manualDraft(), scope: { company: scope.company, department: scope.department },
      evidenceKind: "generated_draft" as const, agentIds: ids,
      baseline: { groupId: group.id, query: group.drilldowns.audience.query } };
    draft.narrative.exercises = "Review approved synthetic material with the complete declared agent descriptions, then check sources.";
    draft.narrative.unknowns = "Descriptions are declarations, not successful use or proof of access; response volume is not expertise.";
    const requestId = `${Date.now()}.${randomUUID()}`;
    const saved = await call<ContentSave>("create_adoption_content", { requestId, draft });
    expect(saved.record!.baseline!.group.agentEvidence).toEqual(group.agentEvidence);
    expect(saved.record!.evidenceKind).toBe("generated_draft");
    expect(saved.record!.agents.map(reference => [reference.id, reference.state, reference.agent?.origin.kind])).toEqual(
      ids.map((id, index) => [id, "available", index === 1 ? "microsoft" : "organization_created"]));
    console.info(JSON.stringify({ event: "complete_department_brief", calls: traces.length,
      envelopeBytes: traces.reduce((sum, trace) => sum + trace.bytes, 0),
      seconds: (performance.now() - start) / 1000, authWaitSeconds: 0, semanticModelProof: false }));
    expect(traces.length).toBeLessThanOrEqual(16);
    const member = { ...account(), localAccountId: "95000000-0000-4000-8000-000000000001",
      homeAccountId: `95000000-0000-4000-8000-000000000001.${h.actor.tenantId}` };
    const browserRequest = await h.browserRequestFor(member, ["AgentControl.Viewer"]);
    const browserTraces: Array<{ path: string; method: string; status: number; apiBytes: number; seconds: number }> = [];
    const browser: typeof browserRequest = async (path, init) => {
      const at = performance.now(), response = await browserRequest(path, init);
      browserTraces.push({ path, method: init?.method ?? "GET", status: response.status,
        apiBytes: (await response.clone().arrayBuffer()).byteLength, seconds: (performance.now() - at) / 1000 });
      return response;
    };
    const read = await browser(`/adoption-content/${saved.id}`);
    expect(read.status).toBe(200);
    const visible = await read.json() as ContentRecord;
    expect(visible.id).toBe(saved.id); expect(visible.baseline).toEqual(saved.record!.baseline);
    expect(visible.permissions.core).toBe(false);
    expect((await browser("/adoption-content", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: `${Date.now()}.${randomUUID()}`, draft }) })).status).toBe(409);
    const action = await call<ContentSave>("create_adoption_content", { requestId: `${Date.now()}.${randomUUID()}`,
      draft: { ...manualDraft("action"), linkedIds: [saved.id], assigneeId: member.homeAccountId } });
    expect((await browser(`/adoption-content/${action.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, status: "in_progress", progress: "Contributor reviewed the draft." }) })).status).toBe(200);
    expect((await browser(`/adoption-content/${action.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, status: "completed" }) })).status).toBe(409);
    const replay = await call<ContentSave>("create_adoption_content", { requestId, draft });
    expect(replay).toMatchObject({ id: saved.id, replayed: true });
    const follow = await call<ContentFollowUp>("follow_up_adoption_content", {
      id: saved.id, groupId: group.id, query: group.drilldowns.audience.query,
    });
    expect(follow.sameOriginalPeople).toBe(false);
    expect(follow.caveats).toContain("The selected Office D28 windows overlap and are non-additive.");
    expect(follow.caveats).toContain("The selected report activity ranges overlap and are non-additive.");
    await call("delete_adoption_content", { id: saved.id, expectedRevision: 1, confirmation: `delete:${saved.id}` });
    expect((await call<ContentSave>("create_adoption_content", { requestId, draft })).state).toBe("deleted");
    const surviving = await browser(`/adoption-content/${action.id}`);
    expect(surviving.status).toBe(200);
    expect((await surviving.json()).links).toEqual([{ id: saved.id, state: "removed" }]);
    const journey = { calls: traces.length + browserTraces.length,
      bytes: traces.reduce((sum, trace) => sum + trace.bytes, 0) + browserTraces.reduce((sum, trace) => sum + trace.apiBytes, 0),
      seconds: (performance.now() - start) / 1000, traces, browserTraces, authWaitSeconds: 0 };
    console.info(JSON.stringify({ event: "complete_department_cross_account_lifecycle", ...journey }));
    expect(journey.calls).toBeLessThanOrEqual(32); expect(journey.bytes).toBeLessThanOrEqual(4 * 1024 ** 2);
    expect(journey.seconds).toBeLessThanOrEqual(180);
  }, 180000);
  it.each(["webapp", "mcp"] as const)("serves exact saved evidence through %s without a provider permission or manual start", async transport => {
    const h = await setupAuditOriginHttp(transport, account(), undefined, ["AgentControl.Viewer"]);
    const identity = await reportIdentity(h.database, h.actor);
    await publishDepartmentEvidenceOffice(h.database, identity);
    await publishDepartmentEvidenceReports(h.database, identity);
    const response = await h.request(`/copilot-usage/adoption/opportunities?${new URLSearchParams({
      company: "~string:" + departmentEvidence.company, department: "~string:" + departmentEvidence.department,
    })}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const page = await response.json() as OpportunityPage, group = page.value[0];
    expect(group.agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
    const params = new URLSearchParams(Object.entries(group.drilldowns.audience.query).map(([key, value]) =>
      [key, value === null ? "~null" : ["company", "department"].includes(key) ? "~string:" + value : String(value)]));
    params.set("cohort", "no_reported"); params.set("limit", "6");
    const first = await h.request(`/copilot-usage/adoption/opportunities/${group.id}/people?${params}`);
    expect(first.status, await first.clone().text()).toBe(200);
    const people = await first.json() as OpportunityPeoplePage;
    expect(people.counts).toEqual({ total: 15, returned: 6 });
    params.set("cursor", people.page.nextCursor!);
    const second = await h.request(`/copilot-usage/adoption/opportunities/${group.id}/people?${params}`);
    expect(second.status).toBe(200);
    const secondPeople = await second.json() as OpportunityPeoplePage;
    if (transport === "mcp" && process.env.AGENT_CONTROL_MCP_SQL_JOURNEY) {
      const audience = { ...group.drilldowns.audience.query, groupId: group.id, cohort: "no_reported", limit: 6 };
      const actual = await sdkJourney(h, [
        { name: "list_department_opportunities", request: group.drilldowns.audience.query },
        { name: "list_opportunity_people", request: audience },
        { name: "list_opportunity_people", request: { ...audience, cursor: people.page.nextCursor } },
        { name: "list_opportunity_people", request: { ...audience, cursor: secondPeople.page.nextCursor } },
        { name: "list_opportunity_people", request: { ...audience, cohort: "positive", limit: 50 } },
      ]);
      expect((actual[0] as OpportunityPage).value[0].agentEvidence).toEqual({ positive: 7, noReported: 15, unknown: 0 });
      const negatives = (actual.slice(1, 4) as OpportunityPeoplePage[]).flatMap(result => result.value.map(row => row.person.identity));
      const positive = actual[4] as OpportunityPeoplePage;
      expect(negatives).toHaveLength(15); expect(new Set(negatives).size).toBe(15);
      expect(positive.counts).toEqual({ total: 7, returned: 7 });
      expect(positive.value.some(row => row.person.userPrincipalName === `person-${departmentEvidence.usersOnlyPositive}@example.invalid`)).toBe(true);
      expect(positive.value.every(row => !negatives.includes(row.person.identity))).toBe(true);
      for (const result of actual as Array<OpportunityPage | OpportunityPeoplePage>) {
        expect(result.context.office.selection.id).toBe(page.context.office.selection.id);
        expect(result.context.report.selection.id).toBe(page.context.report.selection.id);
      }
    }
    expect(h.providerWork.requests).toBe(0);
    for (const query of ["limit=11", "company=a&company=b", "selectionId=bad", "officeSelectionId=bad",
      "pageNumber=2", "app=chat", "cursor=unsigned", "setId=bad"]) {
      expect((await h.request(`/copilot-usage/adoption/opportunities?${query}`)).status).toBe(400);
    }
  }, 180000);
  it.each(([[], ["AgentControl.UsageReportUploader"], ["AgentControl.Admin"]] as AppRole[][]).map(roles => ({ roles })))(
    "keeps actual role hierarchy for $roles", async ({ roles }) => {
      const h = await setupAuditOriginHttp("mcp", account(), undefined, roles);
      const response = await h.request("/copilot-usage/adoption/opportunities?company=~null&department=~null");
      expect(response.status, await response.clone().text()).toBe(roles.length ? 200 : 403);
    }, 30000);
});
