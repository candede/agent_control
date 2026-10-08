import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import session from "express-session";
import type { Server } from "node:http";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { usageAudit } from "../db/agentUsageTestSupport.js";
import { createHmac, randomUUID } from "node:crypto";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { createApp } from "../app.js";
import { ReportExportDispatcher, reportRuntime } from "../services/reportExportDispatcher.js";
import { reportIdentity } from "../services/reportIdentity.js";
import { config } from "../config.js";
import { reportQueryString } from "../../../frontend/src/api/reportData.js";
import type { ReportAgent, ReportHistorySet, ReportPage, ReportRelationship, ReportUser } from "../types/officialReportData.js";
import type { OfficialReportBundlePreview, OfficialReportDetail, OfficialReportExportStatus, OfficialReportPreview } from "../types/officialReportApi.js";
import type { AppRole } from "../types/capability.js";
import { declaredRoutePolicies } from "./policy.js";
import { InventoryQueries } from "../db/inventoryQueries.js";
import { DataExports } from "../services/dataExports.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-cutover-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "cutover-synthetic-session-secret";
});

describe("users/report route-to-client boundary", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>, server: Server, base: string;
  let application: ReturnType<typeof createApp>, reports: LargeTenantUsersReports, imports: OfficialReportImports, cookie: string;
  const identity = { ...selectionIdentity, tenantId: "11111111-1111-1111-1111-111111111111", principalId: "cutover-http" };
  async function sessionCookie(principalId = identity.principalId, roles: AppRole[] = ["AgentControl.Admin"], tenantId = identity.tenantId) {
    const id = randomUUID(), signature = createHmac("sha256", config.sessionSecret).update(id).digest("base64").replace(/=+$/g, "");
    const data = { cookie: new session.Cookie({ maxAge: 600000 }),
      tenantId, accountId: principalId, clientId: config.tenants[0].clientId, csrfToken: "cutover-csrf",
      rolesValidatedAt: Date.now(), user: { ...usageAudit(identity).actor, tenantId, homeAccountId: principalId, roles },
    };
    const write = () => new Promise<void>((resolve, reject) => application.store.set(id, data, error => error ? reject(error) : resolve()));
    if (tenantId === identity.tenantId) await write();
    else {
      await expect(write()).rejects.toThrow("Session tenant/principal/client mismatch");
      await fixture.operator.query("INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,clock_timestamp()+interval '1 minute')", [id, data]);
    }
    return `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}`;
  }
  function api(path: string, options: RequestInit = {}) {
    return fetch(`${base}${path}`, { ...options, redirect: "manual", headers: { Cookie: cookie, Origin: config.frontendOrigin,
      "x-csrf-token": "cutover-csrf", ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  }
  async function acceptSet(number: number, correctionOfSetId?: string) {
    const bundleId = randomUUID(), date = new Date().toISOString().slice(0, 10);
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const row = kind === "agents" ? `agent-${number},Agent ${number},Your org,1,0,${number + 1},${date}`
        : kind === "userAgents" ? `agent-${number},Agent ${number},Your org,user-${number}@example.invalid,${number + 1},${date}`
          : `user-${number}@example.invalid,User ${number},1,${number + 1},${date}`;
      await imports.stage(identity, { bundleId, correctionOfSetId }, (async function* () { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${row}\n`); })());
    }
    return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
  }
  async function correctThroughHttp(correctionOfSetId: string) {
    const bundleId = randomUUID(), date = new Date().toISOString().slice(0, 10);
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const row = kind === "agents" ? `corrected,Corrected,Your org,1,0,80,${date}`
        : kind === "userAgents" ? `corrected,Corrected,Your org,corrected@example.invalid,80,${date}`
          : `corrected@example.invalid,Corrected,1,80,${date}`;
      const body = new FormData();
      if (kind === "agents") body.append("downloadedAt", "2026-01-01T00:00:00Z");
      body.append("file", new Blob([`${schemaRegistry[kind].headers.join(",")}\n${row}\n`]), `${kind}.csv`);
      if (kind !== "agents") body.append("downloadedAt", "2026-01-01T00:00:00Z");
      const uploaded = await api(`/official-usage/staging?bundleId=${bundleId}&correctionOfSetId=${correctionOfSetId}`,
        { method: "POST", body });
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      const preview = await uploaded.json() as OfficialReportPreview;
      expect(preview).toMatchObject({ bundleId, correctionOfSetId, rowCount: 1, kind });
      expect(preview.examples).toHaveLength(1);
      expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(1048576);
    }
    const preview = await (await api(`/official-usage/bundles/${bundleId}/preview`, { method: "POST", body: "{}" })).json() as OfficialReportBundlePreview;
    expect(preview.complete).toBe(true);
    const accepted = await api(`/official-usage/bundles/${bundleId}/accept`, { method: "POST",
      body: JSON.stringify({ bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision }) });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
  }
  beforeAll(async () => {
    fixture = await testDatabase();
    application = createApp(fixture.runtime);
    Object.assign(identity, await reportIdentity(fixture.runtime, { ...usageAudit(identity).actor, roles: ["AgentControl.Admin"] }));
    cookie = await sessionCookie();
    reports = reportRuntime(fixture.runtime).reports; imports = new OfficialReportImports(fixture.runtime);
    const bundleId = randomUUID();
    for (const kind of ["users", "agents", "userAgents"] as const) {
      async function* source() {
        const rows = kind === "users" ? "a@example.invalid,A,0,0,\nb@example.invalid,B,1,4,\n"
          : kind === "agents" ? "Report-A,Same name,Custom,2,2,10,\nreport-a,Same name,Custom,1,0,7,\n"
            : "Report-A,Same name,Custom,a@example.invalid,0,\nReport-A,Same name,Custom,b@example.invalid,4,\nreport-a,Same name,Custom,b@example.invalid,1,\n";
        yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${rows}`);
      }
      await imports.stage(identity, { bundleId }, source());
    }
    await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    reportRuntime(fixture.runtime).start();
    server = await new Promise<Server>(resolve => { const started = application.app.listen(0, "127.0.0.1", () => resolve(started)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  }, 30_000);
  afterAll(async () => {
    if (fixture) await reportRuntime(fixture.runtime).drain();
    application?.store.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await fixture?.close();
  });
  it.each([
    ["/copilot-usage/users", "licensed_copilot_usage"],
    ["/official-usage/history", "official_usage_history"],
    ["/official-usage/history/options", "official_usage_history"],
    ["/official-usage/overview", "official_usage_overview"],
    ["/official-usage/aggregate", "official_usage_aggregate"],
    ["/official-usage/users", "official_usage_user"],
    ["/official-usage/agents/Report-A", "official_usage_user"],
  ])("preserves real Viewer/Admin policy and read-only navigation for %s", async (path, dataClass) => {
    expect(declaredRoutePolicies.get(`GET ${path === "/official-usage/agents/Report-A" ? "/official-usage/agents/:agentId" : path}`)).toEqual({
      access: "authenticated", dataClass, roles: ["AgentControl.Viewer"],
    });
    expect(declaredRoutePolicies.has(`POST ${path}`)).toBe(false);
    const inventory = vi.spyOn(InventoryQueries.prototype, "page").mockRejectedValue(new Error("No inventory-wide enrichment on report navigation"));
    const fetcher = globalThis.fetch, provider = vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      expect(String(input).startsWith(`${base}/`)).toBe(true);
      return fetcher(input, options);
    });
    try {
      expect((await api(path, { headers: { Cookie: "" } })).status).toBe(401);
      const unassigned = await sessionCookie(`unassigned-${randomUUID()}`, []);
      expect((await api(path, { headers: { Cookie: unassigned } })).status).toBe(403);
      const foreign = await sessionCookie(`foreign-${randomUUID()}`, ["AgentControl.Viewer"], "99999999-9999-4999-8999-999999999999");
      expect((await api(path, { headers: { Cookie: foreign } })).status).toBe(401);
      const foreignId = decodeURIComponent(foreign.split("=")[1]).slice(2).split(".")[0];
      expect((await fixture.runtime.query("SELECT sid FROM sessions WHERE sid=$1", [foreignId])).rows).toEqual([]);
      for (const role of ["AgentControl.Viewer", "AgentControl.Admin"] as const) {
        const session = await sessionCookie(`reader-${randomUUID()}`, [role]);
        const result = await api(path, { headers: { Cookie: session } });
        expect(result.status, await result.clone().text()).toBe(200);
        expect(result.headers.get("cache-control")).toBe("private, no-store");
      }
      expect((await api(`${path}?search=${path.endsWith("/Report-A") ? "Same" : "typing"}`)).status).toBe(200);
      expect((await api(`${path}?offset=1`)).status).toBe(400);
      expect((await api(path, { method: "POST", body: "{}" })).status).toBe(404);
      expect(inventory).not.toHaveBeenCalled();
    } finally { inventory.mockRestore(); provider.mockRestore(); }
  });
  it("does not let a renewed session discard private staging owned by its previous epoch", async () => {
    const principalId = `staging-session-${randomUUID()}`;
    const owner = await reportIdentity(fixture.runtime, { ...usageAudit(identity).actor, homeAccountId: principalId, roles: ["AgentControl.Admin"] });
    const staged = await imports.stage(owner, { bundleId: randomUUID() }, (async function* () {
      yield Buffer.from(`${schemaRegistry.users.headers.join(",")}\nrenewed@example.invalid,Renewed,1,1,\n`);
    })());
    const renewedCookie = await sessionCookie(principalId);
    await fixture.runtime.query("UPDATE data_principal_epochs SET epoch=epoch+1 WHERE tenant_id=$1 AND principal_id=$2", [owner.tenantId, owner.principalId]);
    const preview = await api(`/official-usage/staging/${staged.id}`, { headers: { Cookie: renewedCookie } });
    expect(preview.status).toBe(409);
    const removed = await api(`/official-usage/staging/${staged.id}`, { method: "DELETE", headers: { Cookie: renewedCookie } });
    expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ code: "staging_unavailable" });
    expect((await fixture.runtime.query("SELECT status FROM official_usage_staging WHERE id=$1", [staged.id])).rows[0].status).toBe("active");
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_audit WHERE target_id=$1 AND action='discarded'", [staged.id])).rows[0].n).toBe(0);
  });

  it.each([
    "?tenantId=other", "?scope=", "?scope=history&scope=selected", "?scope[value]=selected",
    "?search=one&search=two", "?limit=25&limit=50", "?search[name]=test", "?search=%00",
    "?startDate=", "?endDate=", "?sortBy=responses", "?sortDirection=DESC", "?sortBy=", "?sortDirection=",
    "?limit=0", "?limit=101", "?offset=-1", "?offset=100001", "?limit=1.5", "?limit=", "?offset=1e2",
  ])("rejects malformed overview scalars and removed query fields before report capture: %s", async query => {
    const capture = vi.spyOn(reports, "capture");
    try {
      const response = await api(`/official-usage/overview${query}`);
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_usage_query" });
      expect(capture).not.toHaveBeenCalled();
    } finally { capture.mockRestore(); }
  });
  it.each([
    "?scope=all", "?scope=Selected", "?creatorType=Custom", `?search=${"x".repeat(257)}`,
    "?startDate=2026-02-29", "?endDate=2026-04-31", "?startDate=2026-7-01",
    "?startDate=2026-07-01T00%3A00%3A00Z", "?startDate=2026-07-16&endDate=2026-07-15",
    "?sort=responses", "?order=DESC",
  ])("rejects unsupported overview intent before report capture: %s", async query => {
    const capture = vi.spyOn(reports, "capture");
    try {
      const response = await api(`/official-usage/overview${query}`);
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_cursor" });
      expect(capture).not.toHaveBeenCalled();
    } finally { capture.mockRestore(); }
  });
  it.each(["history", "selected"] as const)("returns explicit overview scope %s with bounded frozen metadata", async scope => {
    const response = await api(`/official-usage/overview${reportQueryString({ scope, limit: 100, sort: "lastActivity", order: "desc" })}`);
    expect(response.status).toBe(200);
    const page = await response.json() as ReportPage<import("../types/officialReportData.js").ReportOverviewAgent>;
    expect(page.filters).toMatchObject({ scope, sort: "lastActivity", order: "desc" });
    expect(page.page.limit).toBe(100); expect(page.value.length).toBeLessThanOrEqual(100);
    expect(page.analytics).toMatchObject({ basis: "filtered_rows", responses: null, overview: { asOf: page.selection.evaluatedAt } });
    expect(JSON.stringify(page.value)).not.toMatch(/responsesSentToUsers|totalResponses|username/);
  });

  it("serializes the frozen query and retains one selection through a byte/row-bounded continuation", async () => {
    const first = await api(`/official-usage/users${reportQueryString({ limit: 1, sort: "responses", order: "asc" })}`);
    expect(first.status, await first.clone().text()).toBe(200);
    const page = await first.json() as ReportPage<ReportUser>;
    expect(page.value.map(row => row.reportedResponses)).toEqual([0]);
    expect(page.counts).toEqual({ total: 2, filtered: 2 });
    expect(page.page.nextCursor).toBeTruthy();
    const next = await api(`/official-usage/users${reportQueryString({ limit: 1, cursor: page.page.nextCursor! })}`);
    const continued = await next.json() as ReportPage<ReportUser>;
    expect(next.status).toBe(200);
    expect(Date.parse(continued.selection.validatedAt)).toBeGreaterThanOrEqual(Date.parse(page.selection.validatedAt));
    expect(continued.selection).toEqual({ ...page.selection, validatedAt: continued.selection.validatedAt });
    expect(continued.value.map(row => row.reportedResponses)).toEqual([4]);
    expect(continued.page.nextCursor).toBeNull();
    expect(JSON.stringify(continued).length).toBeLessThan(1048576);
  });
  it("rejects old all/offset contracts and preserves static paths and nullable organization intent", async () => {
    expect(reportQueryString({ company: "~null", department: null })).toBe("?company=%7Estring%3A%7Enull&department=%7Enull");
    expect((await api("/official-usage/users?offset=0")).status).toBe(400);
    expect((await api("/copilot-usage/users?limit=101")).status).toBe(400);
    expect((await api("/copilot-usage/users/unresolved-identities")).status).toBe(200);
  });
  it("serves exact case-sensitive agent details and paged children without rewriting parent evidence", async () => {
    const response = await api("/official-usage/agents/Report-A");
    expect(response.status).toBe(200);
    const detail = await response.json() as OfficialReportDetail<ReportAgent>;
    expect(detail.value).toMatchObject({ agentId: "Report-A", responses: 10, activeUsers: 1, licensedUserOccurrences: 2, identityStatus: "unresolved" });
    expect(detail).not.toHaveProperty("users");
    const children = await api(`/official-usage/agents/Report-A/users${reportQueryString({ selectionId: detail.selection.id, sort: "responses", order: "desc", limit: 1 })}`);
    expect(children.status).toBe(200);
    const first = await children.json() as ReportPage<ReportRelationship>;
    expect(first.counts).toEqual({ total: 2, filtered: 2 }); expect(first.value).toMatchObject([{ username: "b@example.invalid", responses: 4 }]);
    const next = await api(`/official-usage/agents/Report-A/users${reportQueryString({ cursor: first.page.nextCursor!, limit: 1, sort: "responses", order: "desc" })}`);
    expect(next.status).toBe(200);
    expect((await next.json() as ReportPage<ReportRelationship>).value).toMatchObject([{ username: "a@example.invalid", responses: 0 }]);
    expect((await (await api(`/official-usage/agents/Report-A?selectionId=${detail.selection.id}`)).json()).value).toEqual(detail.value);
    expect((await (await api("/official-usage/agents/report-a")).json()).value).toMatchObject({ agentId: "report-a", responses: 7 });
    for (const id of ["REPORT-A", "Same name", "inventory-Report-A", "unknown"]) {
      expect((await api(`/official-usage/agents/${encodeURIComponent(id)}`)).status).toBe(404);
    }
    const filtered = await (await api("/official-usage/users?agentId=report-a")).json() as ReportPage<ReportUser>;
    expect(filtered.counts.filtered).toBe(1);
    expect(filtered.value).toMatchObject([{ username: "b@example.invalid", reportedResponses: 4, bridgeResponses: 5, relationshipCount: 2 }]);
  });
  it.each([
    "search=a&search=b", "sort=name&sort=responses", "order=asc&order=desc", "limit=1&limit=2",
    "search[]=user", "search[nested]=user", "limit[]=1", "setId[nested]=value", "unknown=value",
    "limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1e2", "limit=", "limit=9007199254740992",
    "offset=0", "sortBy=responses", "sortDirection=asc", `search=${"x".repeat(257)}`, "search=bad%0Atext",
    "search=bad%00text", "setId=not-a-uuid", "startDate=2026-02-29", "endDate=2026-09-31",
    "startDate=2026-09-10&endDate=2026-09-09", "lowResponseThreshold=0", "lowResponseThreshold=1.5",
    "lowResponseThreshold=100000001", "licenseCohort=free", "licenseCohort[]=active_without_paid",
    "licenseCohort=active_without_paid&licenseCohort=active_without_paid", "agentId=", "agentId=%20",
    "agentId=Report-A&agentId=report-a", "agentId[]=Report-A", `agentId=${"x".repeat(513)}`,
    "agentId=bad%0Atext", "agentId=bad%00text", "company[]=Contoso", `company=${"x".repeat(257)}`,
  ])("rejects invalid user-report intent before capture: %s", async query => {
    const capture = vi.spyOn(reports, "capture");
    try {
      for (const path of ["/official-usage/users", "/official-usage/agents/Report-A"]) {
        expect((await api(`${path}?${query}`)).status).toBe(400);
      }
      expect(capture).not.toHaveBeenCalled();
    } finally { capture.mockRestore(); }
  });
  it.each(["%20", "%00", "%0A", "a".repeat(513)])("rejects malformed opaque detail identity before capture: %s", async id => {
    const capture = vi.spyOn(reports, "capture");
    try {
      expect((await api(`/official-usage/agents/${id}`)).status).toBe(400); expect(capture).not.toHaveBeenCalled();
    } finally { capture.mockRestore(); }
  });
  it("rejects the removed multi-agent array and never falls back from an unavailable retained set", async () => {
    for (const ids of ["", "null", "{}", "[]", '[""]', "[1]", "not-json", JSON.stringify(Array(101).fill("Report-A"))]) {
      expect((await api(`/official-usage/agent-users?agentIds=${encodeURIComponent(ids)}`)).status).toBe(400);
    }
    const missing = randomUUID();
    for (const path of ["/official-usage/users", "/official-usage/agents/Report-A"]) {
      expect((await api(`${path}?setId=${missing}`)).status).toBe(409);
    }
  });
  it.each(["/official-usage/users.csv", "/official-usage/aggregate.csv", "/copilot-usage/users.csv", "/official-usage/admin"])(
    "removes %s from the actual app without redirecting or retaining an alias", async path => {
      const response = await api(path);
      expect(response.status).toBe(404); expect(response.headers.get("location")).toBeNull();
    });
  it("removes the old browser acknowledgement write route", async () => {
    expect((await api("/official-usage/legacy-cleanup-acknowledgements", { method: "POST", body: "{}" })).status).toBe(404);
  });
  it("preserves real authentication, Viewer/Admin and CSRF policy", async () => {
    expect((await api("/official-usage/users", { headers: { Cookie: "" } })).status).toBe(401);
    expect((await api("/official-usage/users", { headers: { Cookie: await sessionCookie("no-role", []) } })).status).toBe(403);
    const viewer = await sessionCookie("viewer", ["AgentControl.Viewer"]);
    expect((await api("/official-usage/users", { headers: { Cookie: viewer } })).status).toBe(200);
    expect((await api(`/official-usage/sets/${randomUUID()}/preview`, { method: "POST", body: JSON.stringify({ operation: "delete" }), headers: { Cookie: viewer } })).status).toBe(403);
    expect((await api("/data-exports", { method: "POST", body: "{}", headers: { "x-csrf-token": "" } })).status).toBe(403);
  });
  it("addresses 33 retained sets through one history root and preserves membership across between-page acceptance", async () => {
    for (let index = 0; index < 32; index++) await acceptSet(index);
    const response = await api("/official-usage/history?limit=5");
    expect(response.status, await response.clone().text()).toBe(200);
    const first = await response.json() as ReportPage<ReportHistorySet>;
    const options = await api(`/official-usage/history/options?limit=5&selectionId=${first.selection.id}`);
    expect(options.status).toBe(200);
    const lightweight = await options.json();
    expect(Object.keys(lightweight).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
    expect(Date.parse(lightweight.selection.validatedAt)).toBeGreaterThanOrEqual(Date.parse(first.selection.validatedAt));
    expect(lightweight).toEqual({ value: first.value, page: first.page, counts: first.counts,
      selection: { ...first.selection, validatedAt: lightweight.selection.validatedAt }, reports: first.reports });
    expect(first.counts.total).toBe(33);
    const pins = (await fixture.runtime.query("SELECT root_kind FROM data_generation_pins WHERE selection_id=$1", [first.selection.id])).rows;
    expect(pins.filter(pin => pin.root_kind === "tenant_history")).toHaveLength(1); expect(pins.length).toBeLessThanOrEqual(16);
    await acceptSet(32);
    const ids = new Set(first.value.map(set => set.id)); let cursor = first.page.nextCursor;
    while (cursor) {
      const next = await api(`/official-usage/history/options${reportQueryString({ limit: 5, cursor })}`);
      expect(next.status, await next.clone().text()).toBe(200);
      const page = await next.json() as ReportPage<ReportHistorySet>;
      expect(Date.parse(page.selection.validatedAt)).toBeGreaterThanOrEqual(Date.parse(first.selection.validatedAt));
      expect(page.selection).toEqual({ ...first.selection, validatedAt: page.selection.validatedAt }); expect(page.counts.total).toBe(33);
      for (const row of page.value) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1048576); cursor = page.page.nextCursor;
    }
    expect(ids.size).toBe(33);
    const current = await api("/official-usage/history?limit=1");
    expect((await current.json() as ReportPage<ReportHistorySet>).counts.total).toBe(34);
  }, 60_000);
  it("discovers durable queued work after dispatcher replacement and audits ready cancellation", async () => {
    const original = reportRuntime(fixture.runtime), replacement = new ReportExportDispatcher(reports);
    await original.drain();
    try {
      const selected = await (await api("/official-usage/users")).json() as ReportPage<ReportUser>;
      const queued = await api("/data-exports", { method: "POST", body: JSON.stringify({ selectionId: selected.selection.id, kind: "official_users" }) });
      expect(queued.status).toBe(202);
      const job = await queued.json() as OfficialReportExportStatus;
      expect((await fixture.runtime.query("SELECT status,owner FROM data_exports WHERE id=$1", [job.id])).rows[0]).toEqual({ status: "queued", owner: null });
      replacement.start();
      await vi.waitFor(async () => {
        const status = await api(`/data-exports/${job.id}`);
        expect(status.status).toBe(200);
        expect((await status.json() as OfficialReportExportStatus).status).toBe("ready");
      }, { timeout: 10000, interval: 100 });
      await replacement.drain();
      expect((await api(`/data-exports/${job.id}`, { method: "DELETE" })).status).toBe(204);
      expect((await (await api(`/data-exports/${job.id}`)).json() as OfficialReportExportStatus).status).toBe("cancelled");
      const download = await api(`/data-exports/${job.id}/download`);
      expect(download.status).toBe(409); expect(download.headers.get("content-disposition")).toBeNull();
      expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM audit_events
        WHERE tenant_id=$1 AND action='export-official-usage-users' AND status='failed' AND error_code='export_cancelled'`,
      [identity.tenantId])).rows[0].n).toBe(1);
    } finally { await replacement.drain(); original.start(); }
  });
  it("withholds the final CSV chunk when completion validation fails instead of reporting a successful attachment", async () => {
    const selected = await (await api("/official-usage/users")).json() as ReportPage<ReportUser>;
    const job = await (await api("/data-exports", { method: "POST",
      body: JSON.stringify({ selectionId: selected.selection.id, kind: "official_users" }) })).json() as { id: string };
    await vi.waitFor(async () => {
      expect((await (await api(`/data-exports/${job.id}`)).json() as OfficialReportExportStatus).status).toBe("ready");
    }, { timeout: 10000, interval: 100 });
    const original = DataExports.prototype.download;
    const download = vi.spyOn(DataExports.prototype, "download").mockImplementation(async function* (this: DataExports, ...args: Parameters<DataExports["download"]>) {
      yield* original.apply(this, args);
      throw new Error("synthetic_final_audit_failure");
    });
    try {
      const response = await api(`/data-exports/${job.id}/download`);
      expect(response.status).toBe(500);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("content-type")).not.toContain("text/csv");
      expect((await response.text()).length).toBeLessThan(4096);
    } finally { download.mockRestore(); }
  });
  it.each(["correction", "deletion"] as const)("dispatches real persisted work, serves CSV bytes natively and invalidates all domains on nonactive %s", async operation => {
    const history = await (await api("/official-usage/history?limit=3")).json() as ReportPage<ReportHistorySet>;
    const overview = await (await api("/official-usage/overview?limit=1")).json() as ReportPage<unknown>;
    const jobs: string[] = [];
    for (const [path, kind] of [["/copilot-usage/users", "copilot_users"], ["/official-usage/aggregate", "official_agents"], ["/official-usage/users", "official_users"]] as const) {
      const response = await api(path);
      expect(response.status, await response.clone().text()).toBe(200);
      const selected = await response.json() as ReportPage<unknown>;
      const queued = await api("/data-exports", { method: "POST", body: JSON.stringify({ selectionId: selected.selection.id, kind }) });
      expect(queued.status, await queued.clone().text()).toBe(202);
      const job = await queued.json() as { id: string }; jobs.push(job.id);
      await vi.waitFor(async () => {
        const response = await api(`/data-exports/${job.id}`); expect(response.status).toBe(200);
        expect((await response.json() as OfficialReportExportStatus).status).toBe("ready");
      }, { timeout: 10000, interval: 100 });
      const download = await api(`/data-exports/${job.id}/download`);
      expect(download.headers.get("content-type")).toContain("text/csv");
      expect(download.headers.get("content-disposition")).toContain("attachment;");
      expect((await download.text()).length).toBeGreaterThan(32);
      expect((await fixture.runtime.query(`SELECT metadata->>'checksum' AS checksum FROM audit_events
        WHERE operation_id=$1 AND status='succeeded' ORDER BY completed_at DESC LIMIT 1`, [`data-export:${job.id}`])).rows[0].checksum)
        .toMatch(/^[a-f0-9]{64}$/);
    }
    const target = history.value.find(row => row.id !== history.reports.activeSetId)!;
    if (operation === "deletion") {
      const confirmation = await (await api(`/official-usage/sets/${target.id}/preview`, { method: "POST", body: JSON.stringify({ operation: "delete" }) })).json() as { id: string };
      const deleted = await api(`/official-usage/confirmations/${confirmation.id}`, { method: "POST", body: JSON.stringify(confirmation) });
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await deleted.json()).toMatchObject({ activeSetId: history.reports.activeSetId, activeRevision: history.reports.activeRevision });
    } else await correctThroughHttp(target.id);
    for (const [path, id] of [["/official-usage/history", history.selection.id], ["/official-usage/overview", overview.selection.id]] as const) {
      const response = await api(`${path}?selectionId=${id}`);
      expect(response.status).toBe(409); expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toMatchObject({ code: "selection_invalidated", status: 409 });
    }
    for (const id of jobs) {
      expect((await api(`/data-exports/${id}`)).status).toBe(409);
      const download = await api(`/data-exports/${id}/download`);
      expect(download.status).toBe(409); expect(download.headers.get("content-disposition")).toBeNull();
    }
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id=$1
      AND action IN ('export-official-usage-users','export-official-usage-aggregate') AND status='succeeded'`, [identity.tenantId])).rows[0].n).toBeGreaterThanOrEqual(6);
    const current = await reports.page((await reports.capture(identity, "delegated", "history")).id, identity);
    expect(current.reports).toMatchObject({ activeSetId: history.reports.activeSetId, activeRevision: history.reports.activeRevision });
    expect(current.counts.total).toBe(history.counts.total + (operation === "correction" ? 1 : -1));
  }, 30000);
});
