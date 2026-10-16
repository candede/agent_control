import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import session from "express-session";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { InventoryQueries } from "../src/db/inventoryQueries.js";
import { LargeTenantUsersReports } from "../src/services/largeTenantUsersReports.js";
import { OfficialReportExports } from "../src/services/officialReportExports.js";
import { fixtureTenant } from "./capacityProvider.js";
import type { InventoryRoot } from "../src/types/inventoryRecords.js";
import type { CapacityTelemetry } from "./capacityTelemetry.js";
import { capacityInitialSync } from "./capacityRuntime.js";

export async function capacityHttp(database: pg.Pool, telemetry: CapacityTelemetry, root: InventoryRoot | undefined,
  principal: string, browserOnly: boolean | "bootstrap" | "web" = false) {
  assert.equal(process.env.AGENT_CONTROL_ISOLATED_TESTS, "1");
  assert.equal(process.env.PGHOST, "test-postgres");
  assert.equal(database,pool,"The complete app and capacity workers must share the same four-connection pool.");
  const application = createApp(database,"/app/frontend/dist"), id = randomUUID();
  const user = { tenantId: fixtureTenant, homeAccountId: principal, username: "capacity@example.invalid",
    displayName: "Synthetic capacity", roles: ["AgentControl.Admin"] };
  assert.equal(config.tenants[0].tenantId, fixtureTenant);
  const signedInAt = Date.now();
  const sessionData = {
    cookie: new session.Cookie({ maxAge: 8*3600_000 }), tenantId: fixtureTenant, accountId: principal,
    clientId: config.tenants[0].clientId, signedInAt, rolesValidatedAt: signedInAt, csrfToken: "capacity-synthetic-csrf", user,
  };
  await new Promise<void>((resolve,reject) => application.store.set(id, sessionData, error => error ? reject(error) : resolve()));
  let renewal: Promise<void> | undefined;
  let lastIssued = Date.now(), issuerUnavailable = false;
  const issuer = setInterval(() => {
    if (renewal) return;
    renewal = new Promise<void>(resolve => application.store.set(id,{ ...sessionData,rolesValidatedAt: Date.now() },error => {
      if (!error) lastIssued = Date.now();
      telemetry.write({ event: "synthetic-session-issuer",at: Date.now(),error: error ? String(error) : null }); resolve();
    })).finally(() => { renewal = undefined; });
  },30_000);
  const signature = createHmac("sha256", config.sessionSecret).update(id).digest("base64").replace(/=+$/g,"");
  const cookie = `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}`;
  let server: Server | undefined;
  const issuerGuard = setInterval(() => {
    if (!issuerUnavailable && Date.now()-lastIssued>=240_000) {
      issuerUnavailable = true;
      telemetry.write({ event: "http-issuer-guard",reason: "Stop before five-minute Entra role revalidation." });
      server?.closeAllConnections(); server?.close();
    }
  },1000);
  const dispatch = async (action: "readers" | "download" | "browser" | "browser-platform", exportId?: string) => {
    const response = await fetch("http://controller:8080/load", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ action, cookie, exportId }),
      signal: AbortSignal.timeout(30*60_000) });
    const result = await response.json();
    telemetry.write({ event: "http-controller", action, status: response.status, result });
    if (result?.controllerError) {
      throw new Error(`capacity_controller_${action}: ${result.controllerError.message}`,{ cause: result.controllerError });
    }
    assert.equal(response.status, 200); return result;
  };
  try {
    server = await new Promise<Server>((resolve,reject) => {
      const value = application.app.listen(8081,"0.0.0.0", () => resolve(value)); value.once("error",reject);
    });
    if (browserOnly==="bootstrap") {
      const routes = [];
      for (const path of ["/api/capabilities","/api/data-sync/state","/api/inventory/refresh-jobs"]) {
        const response = await fetch(`http://127.0.0.1:8081${path}`,{
          headers: { cookie },signal: AbortSignal.timeout(20_000),
        });
        const body = await response.text();
        assert.ok(Buffer.byteLength(body)<=1_048_576);
        assert.equal(response.status,200,`${path}: ${body.slice(0,1024)}`);
        routes.push({ path,status: response.status,bytes: Buffer.byteLength(body) });
      }
      const browserPlatform = await dispatch("browser-platform");
      return { routes,browserPlatform,database: String(database.options.database),user: database.options.user,
        poolMaximum: database.options.max,sharedApplicationPool: database===pool };
    }
    let initialSync;
    if (browserOnly) {
      initialSync = await capacityInitialSync(database,user,100_000);
      telemetry.write({ event: "capacity-real-initial-sync",result: initialSync });
      const deadline = AbortSignal.timeout(30*60_000);
      for (;;) {
        const response = await fetch("http://127.0.0.1:8081/api/agent-inventory/selections",{
          method: "POST",headers: { cookie,origin: "http://test-db:8081","content-type": "application/json",
            "x-csrf-token": sessionData.csrfToken },body: JSON.stringify({ query: {} }),signal: deadline,
        });
        assert.ok(response.status===200 || response.status===201);
        const selection = await response.json();
        if (response.status===201) break;
        assert.equal(selection.state,"preparing",JSON.stringify(selection));
        await delay(1500,undefined,{ signal: deadline });
      }
      if (browserOnly===true) return { initialSync,browser: await dispatch("browser") };
    }
    assert.ok(root || browserOnly==="web");
    const readers = await dispatch("readers");
    const identity = await reportIdentity(database,user);
    const selected = root ? await new InventoryQueries(database,config.sessionSecret).capture(identity,root.scopeId)
      : { id: readers.warmup.selectionId };
    const engine = new OfficialReportExports(new LargeTenantUsersReports(database,config.sessionSecret,35),user,config.sessionSecret);
    const exportId = await engine.create(identity,{ selectionId: selected.id,kind: "graph_packages" });
    await engine.build(exportId,identity,"graph_packages");
    const download = await dispatch("download",exportId);
    const expected = (await database.query("SELECT checksum,byte_count::text FROM data_exports WHERE id=$1",[exportId])).rows[0];
    assert.equal(download.checksum,expected.checksum); assert.equal(download.bytes,Number(expected.byte_count));
    await engine.engine.cancel(exportId,identity);
    assert.equal(readers.requests,1008); assert.equal(readers.failures,0);
    return { readers,download,...(browserOnly==="web" ? { initialSync,browser: await dispatch("browser") } : {}),
      transport: "Real authenticated Express routes; 12 clients and slow/disconnected downloads in the separately capped controller." };
  } finally {
    clearInterval(issuer);
    clearInterval(issuerGuard);
    await renewal;
    application.store.close();
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections(); });
  }
}
