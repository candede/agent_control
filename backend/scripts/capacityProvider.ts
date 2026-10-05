import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { schemaRegistry } from "../src/services/officialReportFields.js";
import { reportHeaders } from "../src/services/userSourceGraphFields.js";
import { copilotAppActivityPeriod } from "../src/types/copilotUsage.js";
import { CapacityTelemetry } from "./capacityTelemetry.js";
import { capacityHttpLoad } from "./capacityHttpLoad.js";

export const capacitySeed = "ltdp-06-v1";
export const fixtureTenant = "11111111-1111-4111-8111-111111111111";
export const otherTenant = "22222222-2222-4222-8222-222222222222";
export const fixtureEnvironment = "66666666-6666-4666-8666-666666666666";
export const otherEnvironment = "77777777-7777-4777-8777-777777777777";
export const botId = (i: number) => `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`;
export const expectedCanonical = (count: number) => 2*count-2;
export const sku = "33333333-3333-4333-8333-333333333333";
export const plan = "a62f8878-de10-42f3-b68f-6149a25ceb97";
export const key = (i: number) => String(i).padStart(6, "0");
export const userId = (i: number) => `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`;
export const activityLine = (i: number) => `2026-09-30,user-${key(i)}@example.invalid,User ${key(i)},2026-09-30,2026-09-30,,,,,,,,${copilotAppActivityPeriod.slice(1)}\n`;
export type CapacityIdentityProfile = "mixed" | "sparse" | "merge-split";
export function packageValue(i: number, version = 0, opposing = false, profile: CapacityIdentityProfile = "mixed") {
  const bots = profile==="sparse" ? [] : i === 0 ? [profile==="merge-split" && version===30 ? 1 : 0]
    : i === 1 ? [1] : i === 2 ? [2] : i === 3 ? [0, 1] : [];
  return { id: `package-${key(i)}`, displayName: `Agent ${key(i)} version ${version}`, isBlocked: opposing,
    lastModifiedDateTime: "2026-09-30T00:00:00Z", version: "1.0",
    publisher: `Publisher ${key(i)}`, supportedHosts: ["Copilot"],
    ...(bots.length ? { elementDetails: [{ elementType: "AgentMetadatas", elements: bots.map(bot => ({
      id: `identity-${bot}`, definition: JSON.stringify({ SourceIds: {
        EnvironmentId: opposing ? otherEnvironment : fixtureEnvironment, CdsBotId: botId(bot) } }),
    })) }] } : {}) };
}
export function nativeValue(i: number, opposing = false, profile: CapacityIdentityProfile = "mixed") {
  return { tenantId: opposing ? otherTenant : fixtureTenant, type: "microsoft.copilotstudio/agents", name: `native-${key(i)}`,
    properties: { displayName: `Native ${key(i)}`, environmentId: opposing ? otherEnvironment : fixtureEnvironment,
      ...(profile!=="sparse" && i < 4 ? { botId: botId(i === 3 ? 2 : i) } : {}) } };
}
export function officialLine(kind: "agents" | "users" | "userAgents", i: number, version = 0) {
  if (kind === "agents") return `agent-${key(i)},Agent ${key(i)},Your org,5,0,${5 + version},2026-09-30\n`;
  if (kind === "users") return `user-${key(i)}@example.invalid,User ${key(i)},10,${10 + version},2026-09-30\n`;
  const user = Math.floor(i / 10), agent = (user * 2 + i % 10) % 200_000;
  return `agent-${key(agent)},Agent ${key(agent)},Your org,user-${key(user)}@example.invalid,${1 + version},2026-09-30\n`;
}
export const fileBoundaryHeader = schemaRegistry.agents.headers.join(",")+"\n";
const fileBoundaryExtra = 256*1024**2-Buffer.byteLength(fileBoundaryHeader)-200_000*Buffer.byteLength(officialLine("agents",0));
export function fileBoundaryLine(i: number) {
  const line = officialLine("agents",i), position = line.indexOf(",")+1;
  const paddingBytes = Math.floor(fileBoundaryExtra/200_000)+Number(i<fileBoundaryExtra%200_000);
  const padding = "界".repeat(Math.floor(paddingBytes/3))+"x".repeat(paddingBytes%3);
  return line.slice(0,position)+padding+line.slice(position);
}
export function highDegreeLine(kind: "agents" | "users" | "userAgents", i: number) {
  if (kind === "users") return "user-000000@example.invalid,User 000000,10000,10000,2026-09-30\n";
  if (kind === "agents") return `agent-${key(i)},Agent ${key(i)},Your org,1,0,1,2026-09-30\n`;
  return `agent-${key(i)},Agent ${key(i)},Your org,user-000000@example.invalid,1,2026-09-30\n`;
}
async function write(response: ServerResponse, value: string) {
  if (response.destroyed) throw new Error("fixture_client_disconnected");
  if (!response.write(value)) await new Promise<void>((resolve, reject) => {
    const cleanup = () => { response.off("drain", drained); response.off("close", closed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(new Error("fixture_client_disconnected")); };
    response.once("drain", drained); response.once("close", closed);
  });
}
export function capacityProvider() {
  let requests = 0, active = 0;
  const server = createServer(async (request, response) => {
    requests++; active++;
    try {
      const url = new URL(request.url!, "http://controller:8080");
      if (url.pathname === "/ready") { response.end(JSON.stringify({ seed: capacitySeed, requests, active })); return; }
      if (url.pathname === "/load") {
        if (request.method !== "POST") throw new Error("fixture_load_method");
        let text = "";
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new Error("fixture_load_bytes"); }
        response.setHeader("content-type", "application/json");
        response.flushHeaders();
        const cancelled = new AbortController();
        const closed = () => cancelled.abort(new Error("fixture_load_disconnected"));
        response.once("close",closed);
        const progress = setInterval(() => {
          if (!response.destroyed && !response.writableNeedDrain) response.write("\n");
        },5000);
        try { response.end(JSON.stringify(await capacityHttpLoad(JSON.parse(text),cancelled.signal))); }
        catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (!response.destroyed) response.end(JSON.stringify({ controllerError: {
            name: failure.name.slice(0,128),message: failure.message.slice(0,4096),stack: failure.stack?.slice(0,8192),
            diagnostics: "capacityBrowserDiagnostic" in failure ? failure.capacityBrowserDiagnostic : undefined,
          } }));
        }
        finally { clearInterval(progress); response.off("close",closed); }
        return;
      }
      if (url.pathname === "/file-boundary") {
        const count = 200_000;
        response.setHeader("content-type","text/csv");
        await write(response,fileBoundaryHeader);
        for (let i = 0; i < count; i++) {
          await write(response,fileBoundaryLine(i));
        }
        if (url.searchParams.get("over")==="1") await write(response,"\n");
        response.end(); return;
      }
      const count = Number(url.searchParams.get("count") ?? 100_000), version = Number(url.searchParams.get("version") ?? 0);
      if (![0, 1, 100, 10_000, 100_000, 100_001, 200_000, 200_001, 1_000_000, 1_000_001].includes(count) || !Number.isSafeInteger(version)) throw new Error("fixture_cardinality");
      const identityProfile = url.searchParams.get("identityProfile") ?? "mixed";
      if (identityProfile!=="mixed" && identityProfile!=="sparse" && identityProfile!=="merge-split") throw new Error("fixture_identity_profile");
      const children = Number(url.searchParams.get("children") ?? 0);
      if (children!==0 && children!==10_000) throw new Error("fixture_child_profile");
      const upstream = new URL(url.searchParams.get("upstream") ?? "https://graph.microsoft.com/v1.0/users");
      if (!["graph.microsoft.com", "api.powerplatform.com"].includes(upstream.hostname)) throw new Error("fixture_origin");
      if (url.searchParams.get("retry") === "600" && !upstream.searchParams.has("retried")) {
        response.writeHead(429, { "Retry-After": "600", "content-type": "application/json" });
        response.end('{"error":{"code":"TooManyRequests"}}'); return;
      }
      if (url.pathname === "/official") {
        const kind = url.searchParams.get("kind") as "agents" | "users" | "userAgents";
        if (!Object.hasOwn(schemaRegistry, kind)) throw new Error("fixture_kind");
        response.setHeader("content-type", "text/csv");
        await write(response, schemaRegistry[kind].headers.join(",") + "\n");
        for (let offset = 0; offset < count; offset += 100) {
          let text = "";
          for (let i = offset; i < Math.min(offset + 100, count); i++) text += url.searchParams.get("shape") === "one-user"
            ? highDegreeLine(kind, i) : officialLine(kind, i, version);
          await write(response, text);
        }
        response.end(); return;
      }
      if (upstream.pathname.includes("getMicrosoft365CopilotUsageUserDetail")) {
        response.setHeader("content-type", "text/csv");
        await write(response, reportHeaders.join(",") + "\n");
        for (let offset = 0; offset < count; offset += 100) {
          let text = "";
          for (let i = offset; i < Math.min(offset + 100, count); i++) text += activityLine(i);
          await write(response, text);
        }
        response.end(); return;
      }
      const detail = /^\/v1\.0\/copilot\/admin\/catalog\/packages\/package-(\d{6})$/.exec(upstream.pathname);
      if (detail) {
        response.setHeader("content-type", "application/json");
        const value = packageValue(Number(detail[1]), version, url.searchParams.get("opposing") === "true",identityProfile);
        response.end(JSON.stringify({ ...value,
          ...(children===10_000 ? { elementDetails: [...(value.elementDetails ?? []),{ elementType: "DeclarativeCopilots",
            elements: Array.from({ length: 10_000 },(_,n) => ({ id: `child-${n}`,definition: JSON.stringify({ title: `Child ${n}` }) })) }] } : {}),
          longDescription: `Synthetic detail value ${version}` })); return;
      }
      let offset = Number(upstream.searchParams.get("$skiptoken") ?? 0);
      if (request.method === "POST") {
        let text = "";
        for await (const chunk of request) { text += chunk; if (text.length > 16_384) throw new Error("fixture_request_bytes"); }
        offset = Number(JSON.parse(text).Options?.SkipToken ?? 0);
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > count) throw new Error("fixture_offset");
      const end = Math.min(offset + 100, count), opposing = url.searchParams.get("opposing") === "true";
      const value = [];
      for (let i = offset; i < end; i++) value.push(upstream.hostname === "api.powerplatform.com" ? nativeValue(i,opposing,identityProfile) : upstream.pathname.endsWith("/users") ? {
        id: userId(i), userPrincipalName: `user-${key(i)}@example.invalid`, displayName: `User ${key(i)}`,
        companyName: `Company ${key(i)}`, department: opposing ? "Opposing" : "Primary", accountEnabled: !opposing, userType: "Member", employeeType: null,
        assignedLicenses: [{ skuId: sku, disabledPlans: opposing ? [plan] : [] }],
        assignedPlans: [{ servicePlanId: plan, service: "Microsoft365Copilot", capabilityStatus: opposing ? "Suspended" : "Enabled", assignedDateTime: "2026-09-01T00:00:00Z" }],
      } : packageValue(i, version, opposing,identityProfile));
      let body: unknown;
      if (upstream.pathname.endsWith("/subscribedSkus")) body = { value: [{ skuId: sku, appliesTo: "User", servicePlans: [{ servicePlanId: plan }] }], "@odata.count": 1 };
      else if (upstream.hostname === "api.powerplatform.com") body = {
        totalRecords: count, count: value.length, resultTruncated: end < count ? 1 : 0, data: value, ...(end < count ? { skipToken: String(end) } : {}),
      };
      else {
        const next = new URL(upstream); next.searchParams.set("$skiptoken", String(end));
        body = { value, "@odata.count": count, ...(end < count ? { "@odata.nextLink": next.toString() } : {}) };
      }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
    } catch (error) {
      if (!response.headersSent) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
      else response.destroy();
    } finally { active--; }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") throw new Error("fixture_only");
  const metrics = new CapacityTelemetry("/evidence/controller-memory.jsonl"); metrics.start();
  capacityProvider().listen(8080, "0.0.0.0", () => console.log("CAPACITY_PROVIDER_READY"));
}
