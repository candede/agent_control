import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import session from "express-session";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import type { AppRole } from "../src/types/capability.js";
import { reportIdentity } from "../src/services/reportIdentity.js";
import { reportRuntime } from "../src/services/reportExportDispatcher.js";
import { testDatabase } from "./testDatabase.js";

export async function reportHttpFixture() {
  const database = await testDatabase(), application = createApp(database.runtime);
  const user = { tenantId: config.tenants[0].tenantId!, homeAccountId: `report-http-${randomUUID()}`,
    username: "reports@example.invalid", displayName: "Synthetic report administrator", roles: ["AgentControl.Admin"] as AppRole[] };
  const identity = await reportIdentity(database.runtime, user);
  const server = await new Promise<Server>(resolve => {
    const started = application.app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  async function sessionCookie(roles: AppRole[] = user.roles) {
    const id = randomUUID(), signature = createHmac("sha256", config.sessionSecret).update(id).digest("base64").replace(/=+$/g, "");
    await new Promise<void>((resolve, reject) => application.store.set(id, {
      cookie: new session.Cookie({ maxAge: 600000 }), tenantId: user.tenantId, accountId: user.homeAccountId,
      clientId: config.tenants[0].clientId, csrfToken: "report-http-csrf", rolesValidatedAt: Date.now(), user: { ...user, roles },
    }, error => error ? reject(error) : resolve()));
    return `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}`;
  }
  const cookie = await sessionCookie();
  function api(path: string, options: RequestInit = {}) {
    return fetch(`${base}${path}`, { ...options, redirect: "manual", headers: {
      Cookie: cookie, Origin: config.frontendOrigin, "x-csrf-token": "report-http-csrf",
      ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}), ...options.headers,
    } });
  }
  return { database, application, identity, api, sessionCookie, base,
    async close() {
      await reportRuntime(database.runtime).drain(); application.store.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await database.close();
    } };
}
