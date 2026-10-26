import { afterEach, describe, expect, it, vi } from "vitest";
import { setupAuditOriginHttp, closeAuditOriginHttp } from "./auditOriginHttpTestSupport.js";
import { saveUsageInventory, type UsageGroup } from "../db/agentUsageTestSupport.js";
import type { AgentControlExecution, AgentControlPreview } from "../types/agentControls.js";
import type { UnifiedAgentInventoryPage } from "../types/unifiedAgents.js";
import { AuditLog } from "../services/auditLog.js";
import { drainBulkJobs } from "../services/bulkJobs.js";
import { drainCopilotStudioQuarantineJobs } from "../services/copilotStudioQuarantineJobs.js";
import * as packageSubmission from "./inventoryMutations.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { observeTransactionStart } from "../services/peakMemory.js";
import type pg from "pg";
import { copilotStudioQuarantineControl } from "../services/copilotStudioQuarantineControl.js";
import { AppError } from "../errors.js";
import { sdkJourney } from "./mcpSdkJourneyTestSupport.js";

const canonical = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const environmentId = "40000000-0000-4000-8000-000000000001", botId = "50000000-0000-4000-8000-000000000001";
const native = { nativeId: "studio-agent-001", environmentId,
  identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }] };
afterEach(async () => { await drainBulkJobs(); await drainCopilotStudioQuarantineJobs(); await closeAuditOriginHttp(); });
type Fixture = Awaited<ReturnType<typeof setupAuditOriginHttp>>;
async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const received = await response;
  expect(received.status, await received.clone().text()).toBe(status);
  return received.json();
}
const body = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
async function seed(fixture: Fixture, blocked = false, groups?: UsageGroup[], expiresAt?: Date) {
  await saveUsageInventory(fixture.database, fixture.scope, groups ?? [
    { canonicalId: canonical(1), packages: ["T_pkg_001"], packageFields: { isBlocked: blocked, platform: "Microsoft 365 Copilot Agent Builder" } },
    { canonicalId: canonical(2), packages: ["Studio-package"], packageFields: { platform: "Copilot Studio", isBlocked: blocked }, native },
    { canonicalId: canonical(3), packages: ["Unknown-package"] },
  ], { expiresAt });
  return json<UnifiedAgentInventoryPage>(fixture.request("/agent-inventory?limit=100"));
}
function providers(initial: boolean) {
  const before = vi.mocked(globalThis.fetch).getMockImplementation()!, writes: string[] = [], reads: string[] = [];
  const state = { package: initial, studio: initial, failStudio: false, denyStudioRead: false,
    unknownPackageReadback: false, holdWrites: Promise.resolve() };
  vi.spyOn(globalThis,"fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.microsoft.com" && url.hostname !== "api.powerplatform.com") return before(input, init);
    const isStudio = url.hostname === "api.powerplatform.com";
    if (init?.method === "POST") {
      await state.holdWrites;
      writes.push(url.pathname);
      if (isStudio) {
        if (state.failStudio) return Response.json({ error: { code: "Forbidden" } }, { status: 403 });
        state.studio = url.pathname.endsWith("SetAsQuarantined");
        return Response.json({ isBotQuarantined: state.studio, lastUpdateTimeUtc: "2026-09-09T19:01:00.000Z" });
      }
      state.package = url.pathname.endsWith("/block");
      return new Response(null, { status: 204 });
    }
    reads.push(url.pathname);
    if (!isStudio && url.pathname.endsWith("/copilot/admin/catalog/packages")) return Response.json({value:[]});
    if (isStudio && state.denyStudioRead) return Response.json({ error: { code: "Forbidden" } }, { status: 403 });
    if (isStudio) return Response.json({ isBotQuarantined: state.studio, lastUpdateTimeUtc: "2026-09-09T19:01:00.000Z" });
    if (state.unknownPackageReadback && writes.some(path => path.includes("T_pkg_001"))) throw new Error("synthetic disconnected readback");
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
    return Response.json({ id, displayName: `Inventory ${id}`, isBlocked: state.package, platform: "Microsoft 365 Copilot Agent Builder" });
  });
  return { state, writes, reads };
}
async function preview(f: Fixture, selectionId: string, action: "block" | "unblock", recordIds = [`agent:${canonical(1)}`,`agent:${canonical(2)}`]) {
  return json<AgentControlPreview>(f.request("/agent-controls/preview", body({ selectionId, action, recordIds })));
}
async function execute(f: Fixture, receipt: AgentControlPreview, key = "same-operation") {
  return json<AgentControlExecution>(f.request("/agent-controls/execute", { ...body({ receiptId: receipt.receiptId, confirmationHash: receipt.confirmationHash }),
    headers: { "Content-Type": "application/json", "Idempotency-Key": key } }), 202);
}
async function settle(f: Fixture, execution: AgentControlExecution) {
  return vi.waitFor(async () => {
    const children: Array<{status:string}>=[];
    for (const child of execution.children) {
      if (!child.statusUrl) continue;
      const current = await json<{ status: string }>(f.request(child.statusUrl.replace(/^\/api/,"")));
      expect(["queued","running"]).not.toContain(current.status);
      children.push(current);
    }
    return children;
  }, { timeout: 15_000, interval: 30 });
}

describe.sequential("shared exact agent controls on the actual registered browser/bearer handlers", () => {
  it.each([
    { label:"classic bot", selected:{...native,agentKind:"classic_bot"},reason:"unsupported_classic_bot" },
    { label:"incomplete bot identity",selected:{...native,identifiers:[native.identifiers[0]]},reason:"quarantine_native_identity_unavailable" },
    { label:"ambiguous bot identity",selected:{...native,identifiers:[...native.identifiers,{kind:"cds_bot_id",value:"50000000-0000-4000-8000-000000000002"}]},reason:"quarantine_native_identity_unavailable" },
  ])("keeps $label ineligible without provider dispatch",async({selected,reason})=>{
    const f=await setupAuditOriginHttp("mcp"),provider=providers(false);
    const inventory=await seed(f,false,[{canonicalId:canonical(2),packages:["Studio-package"],
      packageFields:{platform:"Copilot Studio",isBlocked:false},native:selected}]);
    const reviewed=await preview(f,inventory.selection.id,"block",[`agent:${canonical(2)}`]);
    expect(reviewed).toMatchObject({eligibleCount:0,ineligibleCount:1,targets:[{eligible:false,reason,effects:[]}]});
    expect(await execute(f,reviewed)).toMatchObject({accepted:true,outcome:"ineligible",children:[],verified:false});
    expect(provider.writes).toHaveLength(0);
  });
  it.each(["block","unblock"] as const)("preserves independent provider effects and browser/bearer parity for %s without canary approval", async action => {
    const results: unknown[] = [];
    for (const transport of ["webapp","mcp"] as const) {
      const f = await setupAuditOriginHttp(transport), provider = providers(action === "unblock");
      const inventory = await seed(f, action === "unblock");
      const useSdk = process.env.AGENT_CONTROL_MCP_SQL_JOURNEY && transport === "mcp";
      const recordIds = [`agent:${canonical(1)}`,`agent:${canonical(2)}`,`agent:${canonical(3)}`, "report:unmanaged"];
      const reviewed = useSdk ? (await sdkJourney(f, [{ name: "preview_agent_control",
        request: { selectionId: inventory.selection.id, action, recordIds } }]))[0] as AgentControlPreview
        : await preview(f, inventory.selection.id, action, recordIds);
      expect(reviewed).toMatchObject({ eligibleCount: 2, ineligibleCount: 2, alreadyInStateCount: 0, providerAtomicity: false });
      expect(reviewed.targets.find(target => target.recordId === `agent:${canonical(2)}`)?.effects).toEqual([
        expect.objectContaining({ provider: "power_platform", action: action === "block" ? "quarantine" : "unquarantine", id: native.nativeId, botId, environmentId }),
      ]);
      expect(reviewed.targets.find(target => target.recordId === `agent:${canonical(3)}`)?.reason).toBe("missing_platform");
      expect(reviewed.targets.find(target => target.recordId.startsWith("report:"))?.reason).toBe("report_only");
      const accepted = useSdk
        ? (await sdkJourney(f, [{ name: "execute_agent_control", request: { receiptId: reviewed.receiptId,
          confirmationHash: reviewed.confirmationHash, idempotencyKey: "same-operation" } }]))[0] as AgentControlExecution
        : await execute(f, reviewed);
      expect(accepted).toMatchObject({ accepted: true, outcome: "partial", final: false, verified: false, origin: { channel: transport } });
      expect(accepted.children).toHaveLength(2);
      const settled=await settle(f, accepted);
      const replay = await execute(f, reviewed);
      expect(replay.children.map(child => child.jobId)).toEqual(accepted.children.map(child => child.jobId));
      expect(replay,JSON.stringify(settled)).toMatchObject({ final: true, verified: true, origin: accepted.origin });
      if (useSdk) await sdkJourney(f, [{ name: "get_agent_control", request: { receiptId: reviewed.receiptId }, expected: replay }]);
      expect(provider.writes).toHaveLength(2);
      expect(provider.writes.some(path => path.includes("Studio-package"))).toBe(false);
      expect(f.providerWork.requests).toBe(0);
      const events = await new AuditLog(f.scope, f.database).listEvents({ operationIdPrefix: accepted.children[0].jobId! });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(event => event.origin.channel === transport)).toBe(true);
      const nativeOrigins = (await f.database.query("SELECT origin FROM copilot_quarantine_audit")).rows;
      expect(nativeOrigins.every(row => row.origin.channel === transport)).toBe(true);
      results.push({ targets: reviewed.targets, counts: [reviewed.eligibleCount,reviewed.ineligibleCount,reviewed.alreadyInStateCount],
        effects: provider.writes.sort(), statuses: replay.children.map(child => [child.provider,child.status,child.final,child.verified]) });
      await closeAuditOriginHttp();
    }
    expect(results[0]).toEqual(results[1]);
  },30_000);
  it("keeps explicit package actions on Studio groups package-only, and rejects raw or spoofed generic inputs equally", async () => {
    const f = await setupAuditOriginHttp("webapp"), provider = providers(false), inventory = await seed(f);
    const prepared = await json<{ confirmationHash: string }>(f.request("/agents/mutation-preview", body({
      action: "block", ids: ["Studio-package"], selectionId: inventory.selection.id, mutationScope: "bulk" })));
    const job = await json<{ id: string }>(f.request("/agents/block", body({ ids: ["Studio-package"],
      selectionId: inventory.selection.id, confirmationHash: prepared.confirmationHash })),202);
    await vi.waitFor(async () => expect(await json(f.request(`/agents/bulk-jobs/${job.id}`))).toMatchObject({ status: "succeeded" }), { timeout: 15_000 });
    expect(provider.writes).toHaveLength(1); expect(provider.writes[0]).toContain("Studio-package/block");
    for (const transport of ["webapp","mcp"] as const) {
      for (const input of [{ recordIds: ["Studio-package"] }, { recordIds: [`agent:${canonical(2)}`], bypassConfirmation: true },
        { recordIds: [`agent:${canonical(2)}`,`agent:${canonical(2)}`] }]) {
        const response = await f.requestAs(transport,"/agent-controls/preview", body({ selectionId: inventory.selection.id, action: "block", ...input }));
        expect(response.status).toBe(400); expect((await response.json()).code).toBe("invalid_control_request");
      }
    }
  });
  it.each(["block","unblock"] as const)("keeps frozen filtered 100+1-page discovery bound to both provider effects for %s", async action => {
    for (const transport of ["webapp","mcp"] as const) {
      const f = await setupAuditOriginHttp(transport), provider = providers(action === "unblock");
      const evaluatedAt = new Date(), cutoff = evaluatedAt.getTime()-30*86_400_000;
      const groups: UsageGroup[] = Array.from({length:103},(_,index) => {
        const createdAt = index === 100 ? new Date(cutoff).toISOString()
          : index === 101 ? new Date(cutoff-1).toISOString() : index === 102 ? null : evaluatedAt.toISOString();
        return index === 0
          ? { canonicalId:canonical(1), packages:["T_pkg_001"],packageFields:{
            platform:"Microsoft 365 Copilot Agent Builder",isBlocked:action==="unblock",createdDateTime:createdAt! } }
          : { canonicalId:canonical(index+1),packages:[],native:{
            ...native,nativeId:index===100 ? native.nativeId : `caseC-native-${index+1}`,createdAt,
            identifiers:[{kind:"environment_id",value:environmentId},{kind:"cds_bot_id",
              value:index===100 ? botId : `50000000-0000-4000-8000-${String(index+2).padStart(12,"0")}`}] } };
      });
      await saveUsageInventory(f.database,f.scope,groups);
      let clock=evaluatedAt.toISOString();
      const originals = new Map<pg.PoolClient,pg.PoolClient["query"]>();
      const stop=observeTransactionStart(async client => {
        if (originals.has(client)) return;
        const original=client.query; originals.set(client,original);
        client.query=((...args:unknown[]) => {
          if(typeof args[0]==="string") args[0]=args[0].replaceAll("clock_timestamp()",`TIMESTAMPTZ '${clock}'`);
          return Reflect.apply(original,client,args);
        }) as typeof client.query;
      });
      let reviewed: AgentControlPreview;
      try {
        const first=await json<UnifiedAgentInventoryPage>(f.request("/agent-inventory?view=all&createdWithinDays=30&limit=100"));
        expect(first.counts).toMatchObject({total:103,filtered:101});
        expect(first.value).toHaveLength(100);
        clock=new Date(evaluatedAt.getTime()+30_000).toISOString();
        const second=await json<UnifiedAgentInventoryPage>(f.request(`/agent-inventory?${new URLSearchParams({
          selectionId:first.selection.id,cursor:first.page.nextCursor!,limit:"100",
        })}`));
        expect(second.selection.evaluatedAt).toBe(evaluatedAt.toISOString());
        expect(second.value.map(row=>row.id)).toEqual([`agent:${canonical(101)}`]);
        expect(second.page.nextCursor).toBeNull();
        const retarget=await f.request("/agent-controls/preview",body({selectionId:first.selection.id,action,
          recordIds:[`agent:${canonical(102)}`,`agent:${canonical(103)}`]}));
        expect(retarget.status).toBe(409);
        reviewed=await preview(f,first.selection.id,action,[first.value[0].id,second.value[0].id]);
        expect(reviewed.targets.flatMap(target=>target.effects).map(effect=>effect.id).sort()).toEqual(["T_pkg_001",native.nativeId].sort());
      } finally {
        stop(); for(const [client,original] of originals) client.query=original;
      }
      const accepted=await execute(f,reviewed);
      const settled=await settle(f,accepted);
      expect((await execute(f,reviewed)).verified,JSON.stringify(settled)).toBe(true);
      expect(provider.writes).toHaveLength(2);
      await closeAuditOriginHttp();
    }
  },120_000);
  it.each(["block","unblock"] as const)("publishes verified already-in-state %s skips without a provider write",async action=>{
    const f=await setupAuditOriginHttp("webapp"),provider=providers(action==="block"),inventory=await seed(f,action==="block");
    const reviewed=await preview(f,inventory.selection.id,action);
    expect(reviewed.alreadyInStateCount).toBe(2);
    const accepted=await execute(f,reviewed);
    await settle(f,accepted);
    expect((await execute(f,reviewed)).verified).toBe(true);
    expect(provider.writes).toHaveLength(0);
    expect((await f.database.query("SELECT count(*)::int AS pending FROM inventory_control_pending")).rows[0].pending).toBe(0);
    expect((await json<UnifiedAgentInventoryPage>(f.request("/agent-inventory"))).value).not.toHaveLength(0);
  });
  it("returns explicit permission eligibility and admits independent remaining package effects",async()=>{
    const f=await setupAuditOriginHttp("mcp"),provider=providers(false),inventory=await seed(f);
    provider.state.denyStudioRead=true;
    const reviewed=await preview(f,inventory.selection.id,"block");
    expect(reviewed).toMatchObject({eligibleCount:1,ineligibleCount:1});
    expect(reviewed.targets[1]).toMatchObject({eligible:false,reason:"missing_permission",effects:[]});
    const accepted=await execute(f,reviewed);
    expect(accepted).toMatchObject({outcome:"partial"});
    await settle(f,accepted);
    expect(provider.writes).toHaveLength(1);
  });
  it("uses one child per provider for simultaneous retries from different clients",async()=>{
    const f=await setupAuditOriginHttp("webapp"),provider=providers(false),inventory=await seed(f);
    const reviewed=await preview(f,inventory.selection.id,"block");
    let release=()=>{};
    provider.state.holdWrites=new Promise<void>(resolve=>{release=resolve;});
    try {
      const accepted=await Promise.all((["webapp","mcp"] as const).map(kind=>json<AgentControlExecution>(
        f.requestAs(kind,"/agent-controls/execute",{...body({receiptId:reviewed.receiptId,confirmationHash:reviewed.confirmationHash}),
          headers:{"Content-Type":"application/json","Idempotency-Key":"concurrent-key"}}),202)));
      expect(accepted[0].children.map(child=>child.jobId)).toEqual(accepted[1].children.map(child=>child.jobId));
      expect((await f.database.query("SELECT count(*)::int AS jobs FROM jobs")).rows[0].jobs).toBe(1);
      expect((await f.database.query("SELECT count(*)::int AS jobs FROM copilot_quarantine_jobs")).rows[0].jobs).toBe(1);
      release(); await settle(f,accepted[0]);
      expect(provider.writes).toHaveLength(2);
    } finally {release();}
  });
  it("reuses the first durable child after a later child acceptance crash without rewriting origin or resending",async()=>{
    const f=await setupAuditOriginHttp("webapp"),provider=providers(false),inventory=await seed(f);
    const reviewed=await preview(f,inventory.selection.id,"block");
    const crash=vi.spyOn(copilotStudioQuarantineControl,"submit").mockRejectedValueOnce(new Error("synthetic second child crash"));
    const first=await f.request("/agent-controls/execute",{...body({receiptId:reviewed.receiptId,confirmationHash:reviewed.confirmationHash}),
      headers:{"Content-Type":"application/json","Idempotency-Key":"partial-crash"}});
    expect(first.status).toBe(500); crash.mockRestore();
    const original=(await f.database.query("SELECT id,origin FROM jobs")).rows[0];
    const replay=await json<AgentControlExecution>(f.requestAs("mcp","/agent-controls/execute",{
      ...body({receiptId:reviewed.receiptId,confirmationHash:reviewed.confirmationHash}),
      headers:{"Content-Type":"application/json","Idempotency-Key":"partial-crash"}}),202);
    expect(replay.children[0].jobId).toBe(original.id);
    await settle(f,replay);
    expect(provider.writes).toHaveLength(2);
    expect((await f.database.query("SELECT origin FROM copilot_quarantine_jobs")).rows[0].origin).toEqual(original.origin);
  });
  it("retains exact accepted input/origin across a parent-acceptance crash, different client retry and child replay", async () => {
    const f = await setupAuditOriginHttp("webapp"), provider = providers(false), inventory = await seed(f);
    const reviewed = await preview(f, inventory.selection.id, "block", [`agent:${canonical(1)}`]);
    expect((await f.request(`/agent-controls/${reviewed.receiptId}`)).status).toBe(404);
    const crash = vi.spyOn(packageSubmission,"submitInventoryBlock").mockRejectedValueOnce(new Error("synthetic acceptance crash"));
    const first = await f.request("/agent-controls/execute", { ...body({ receiptId: reviewed.receiptId, confirmationHash: reviewed.confirmationHash }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "crash-key" } });
    expect(first.status).toBe(500); expect(provider.writes).toHaveLength(0); crash.mockRestore();
    const acceptedRow = (await f.database.query("SELECT origin,initiating_actor FROM agent_control_receipts WHERE id=$1", [reviewed.receiptId])).rows[0];
    expect(acceptedRow.origin.channel).toBe("webapp");
    const reads=provider.reads.length;
    expect(await json<AgentControlExecution>(f.requestAs("mcp",`/agent-controls/${reviewed.receiptId}`))).toMatchObject({
      accepted:true,origin:acceptedRow.origin,children:[{accepted:false,errorCode:"child_not_accepted"}]});
    expect(provider.reads).toHaveLength(reads);
    expect((await f.database.query("SELECT count(*)::int AS count FROM jobs")).rows[0].count).toBe(0);
    const resumed = await json<AgentControlExecution>(f.requestAs("mcp","/agent-controls/execute", { ...body({
      receiptId: reviewed.receiptId, confirmationHash: reviewed.confirmationHash }), headers: { "Content-Type": "application/json", "Idempotency-Key": "crash-key" } }),202);
    expect(resumed.origin).toEqual(acceptedRow.origin);
    await settle(f,resumed);
    const replay = await execute(f,reviewed,"crash-key");
    expect(replay.children[0].jobId).toBe(resumed.children[0].jobId); expect(provider.writes).toHaveLength(1);
    const savedReads=provider.reads.length;
    expect(await json<AgentControlExecution>(f.requestAs("mcp",`/agent-controls/${reviewed.receiptId}`))).toMatchObject({
      verified:true,final:true,origin:acceptedRow.origin});
    expect(provider.reads).toHaveLength(savedReads); expect(provider.writes).toHaveLength(1);
    expect((await f.database.query("SELECT origin,actor_name,actor_username FROM jobs")).rows[0]).toMatchObject({
      origin: acceptedRow.origin, actor_name: acceptedRow.initiating_actor.displayName, actor_username: acceptedRow.initiating_actor.username });
    const cancel = await f.requestAs("mcp", replay.children[0].cancelUrl!.replace(/^\/api/,""), { method: "POST" });
    expect(cancel.status).toBe(200);
    const wrongKey = await f.request("/agent-controls/execute", { ...body({ receiptId: reviewed.receiptId, confirmationHash: reviewed.confirmationHash }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "other-key" } });
    expect(wrongKey.status).toBe(409);
  });
  it("returns a durably accepted child after a worker admission error without another provider write", async () => {
    const f=await setupAuditOriginHttp("webapp"),provider=providers(false),inventory=await seed(f);
    const reviewed=await preview(f,inventory.selection.id,"block",[`agent:${canonical(1)}`]);
    const submit=packageSubmission.submitInventoryBlock;
    vi.spyOn(packageSubmission,"submitInventoryBlock").mockImplementationOnce(async (...args)=>{
      await submit(...args);
      throw new AppError(429,"workers_busy","Synthetic post-acceptance worker admission failure.");
    });
    const accepted=await execute(f,reviewed);
    expect(accepted.children).toMatchObject([{accepted:true,errorCode:"workers_busy"}]);
    await settle(f,accepted);
    expect(await execute(f,reviewed)).toMatchObject({verified:true,final:true});
    expect(provider.writes).toHaveLength(1);
  });
  it("retains accepted correlation after expiry without admitting a missing child", async () => {
    const f=await setupAuditOriginHttp("webapp"),provider=providers(false),
      inventory=await seed(f,false,undefined,new Date(Date.now()+2_000));
    const reviewed=await preview(f,inventory.selection.id,"block",[`agent:${canonical(1)}`]);
    const failure=vi.spyOn(packageSubmission,"submitInventoryBlock").mockRejectedValueOnce(new Error("Synthetic parent-acceptance crash"));
    const first=await f.request("/agent-controls/execute",{...body({receiptId:reviewed.receiptId,confirmationHash:reviewed.confirmationHash}),
      headers:{"Content-Type":"application/json","Idempotency-Key":"expired-accepted"}});
    expect(first.status).toBe(500); failure.mockRestore();
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(reviewed.expiresAt)-Date.now())+30));
    expect(await execute(f,reviewed,"expired-accepted")).toMatchObject({
      accepted:true,outcome:"failed",children:[{accepted:false,errorCode:"child_admission_expired"}]});
    expect(provider.writes).toHaveLength(0);
  });
  it.each(["membership","epoch","expiry","prestate"] as const)("rejects stale %s before any generic provider write", async change => {
    const f = await setupAuditOriginHttp("mcp"), provider = providers(false),
      inventory = await seed(f,false,undefined,change === "expiry" ? new Date(Date.now()+1500) : undefined);
    const reviewed = await preview(f,inventory.selection.id,"block");
    if (change === "prestate") provider.state.studio = true;
    else if (change === "membership") await seed(f,false, [{ canonicalId: canonical(1), packages: ["Replacement"], packageFields: { authoringTool: "Visual Studio" } }]);
    else if (change === "epoch") await new DataGenerations(f.database).revokePrincipal(f.scope.tenantId,f.scope.principalId);
    else {
      await new Promise(resolve => setTimeout(resolve, Math.max(0,Date.parse(reviewed.expiresAt)-Date.now())+30));
    }
    const response = await f.request("/agent-controls/execute", { ...body({ receiptId: reviewed.receiptId, confirmationHash: reviewed.confirmationHash }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": "stale-key" } });
    expect([401,409]).toContain(response.status); expect(provider.writes).toHaveLength(0);
  });
  it("reports mixed provider failure independently and never replays a sent-unknown package write", async () => {
    const f = await setupAuditOriginHttp("mcp"), provider = providers(false), inventory = await seed(f);
    const reviewed = await preview(f,inventory.selection.id,"block");
    provider.state.failStudio = true; provider.state.unknownPackageReadback = true;
    const accepted = await execute(f,reviewed);
    await settle(f,accepted);
    const replay = await execute(f,reviewed);
    expect(provider.writes).toHaveLength(2);
    expect(replay.verified).toBe(false);
    expect(replay.children.some(child => child.status === "partial")).toBe(true);
    expect(replay.children.some(child => child.verification === "readback_unknown")).toBe(true);
    expect(replay.children).toEqual(expect.arrayContaining([
      expect.objectContaining({provider:"graph_packages",status:"partial",verification:"readback_unknown"}),
      expect.objectContaining({provider:"power_platform",status:"inconclusive",verification:"readback_unknown"}),
    ]));
    expect(replay.children.every(child => child.reconcileUrl && child.resumeUrl && child.cancelUrl)).toBe(true);
    provider.state.unknownPackageReadback=false;
    const packageChild=replay.children.find(child=>child.provider==="graph_packages")!;
    const reconciled=await json<{reconciliation:{attempted:number;failed:number}}>(f.requestAs("webapp",
      packageChild.reconcileUrl!.replace(/^\/api/,""),{method:"POST"}));
    expect(reconciled.reconciliation).toMatchObject({attempted:1,failed:0});
    expect(provider.writes).toHaveLength(2);
    expect((await f.database.query("SELECT reconciliation_status FROM job_items WHERE job_id=$1",[packageChild.jobId])).rows)
      .toEqual([{reconciliation_status:"verified_applied"}]);
    expect((await f.database.query("SELECT origin FROM jobs WHERE id=$1",[packageChild.jobId])).rows[0].origin.channel).toBe("mcp");
    const nativeChild=replay.children.find(child=>child.provider==="power_platform")!;
    const nativeRecovery=await f.requestAs("webapp",nativeChild.reconcileUrl!.replace(/^\/api/,""),{method:"POST"});
    expect(nativeRecovery.status).toBe(200);
    expect(await nativeRecovery.json()).toMatchObject({reconciliation:{attempted:1,failed:0}});
    expect((await f.database.query("SELECT reconciliation_status FROM copilot_quarantine_job_items WHERE job_id=$1",[nativeChild.jobId])).rows)
      .toEqual([{reconciliation_status:"verified_not_applied"}]);
    expect((await f.database.query("SELECT origin FROM copilot_quarantine_jobs WHERE id=$1",[nativeChild.jobId])).rows[0].origin.channel).toBe("mcp");
    expect((await f.database.query("SELECT origin FROM copilot_quarantine_audit WHERE job_id=$1 AND action='reconcile'",[nativeChild.jobId])).rows)
      .toMatchObject([{origin:{channel:"webapp"}}]);
    const audit=await new AuditLog(f.scope,f.database).listEvents({operationIdPrefix:packageChild.jobId!});
    expect(audit.some(event=>event.origin.channel==="webapp")).toBe(true);
    expect(audit.some(event=>event.origin.channel==="mcp")).toBe(true);
    const readsBeforeStatus=provider.reads.length;
    const recovered=await json<AgentControlExecution>(f.requestAs("webapp",`/agent-controls/${reviewed.receiptId}`));
    expect(recovered).toMatchObject({final:true,verified:false,children:[
      {provider:"graph_packages",verified:true,verification:"verified"},
      {provider:"power_platform",verified:false,verification:"unverified"},
    ]});
    expect(provider.reads).toHaveLength(readsBeforeStatus);
    expect(provider.writes).toHaveLength(2);
    expect(provider.writes).toHaveLength(2);
    expect((await f.database.query("SELECT count(*)::int AS count FROM inventory_control_pending")).rows[0].count).toBe(0);
    expect((await f.database.query("SELECT count(*)::int AS count FROM inventory_native_control_pending")).rows[0].count).toBe(0);
    const current=await json<UnifiedAgentInventoryPage>(f.request("/agent-inventory?limit=100"));
    expect((await preview(f,current.selection.id,"block",[`agent:${canonical(1)}`])).alreadyInStateCount).toBe(1);
  },30_000);
});
