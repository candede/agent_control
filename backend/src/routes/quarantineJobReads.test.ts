import { createHmac, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type pg from "pg";
import session from "express-session";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { createApp } from "../app.js";
import { config } from "../config.js";
import { NativeInventory } from "../db/nativeInventory.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "../db/copilotStudioQuarantine.js";
import { copilotStudioQuarantineJobs } from "../services/copilotStudioQuarantineJobs.js";
import * as quarantineService from "../services/copilotStudioQuarantineJobs.js";
import { capabilities } from "../services/capabilities.js";
import { lifecycleEvidence } from "../../scripts/lifecycleEvidence.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-quarantine-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "synthetic-quarantine-session-secret";
});
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: CopilotStudioQuarantineRepository;
let application: ReturnType<typeof createApp>, server: Server, base: string, cookie: string, sessionId: string;
const principalId = randomUUID();
beforeAll(async () => {
  fixture = await testDatabase();
  repository = new CopilotStudioQuarantineRepository(fixture.runtime);
  application = createApp(fixture.runtime);
  const id = randomUUID();
  sessionId = id;
  const signature = createHmac("sha256", config.sessionSecret).update(id).digest("base64").replace(/=+$/g, "");
  await new Promise<void>((resolve, reject) => application.store.set(id, {
    cookie: new session.Cookie({ maxAge: 600_000 }), tenantId: config.tenants[0].tenantId, accountId: principalId,
    clientId: config.tenants[0].clientId, rolesValidatedAt: Date.now(), csrfToken: "synthetic",
    user: { tenantId: config.tenants[0].tenantId, homeAccountId: principalId,
      username: "fixture@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"] },
  }, error => error ? reject(error) : resolve()));
  cookie = `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}`;
  server = await new Promise<Server>(resolve => { const value = application.app.listen(0, "127.0.0.1", () => resolve(value)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/quarantine`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  application?.store.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await fixture?.close();
});

async function running(tenantId: string, principal = principalId, claim = true, count = 1) {
  const scope = { tenantId, principalId: principal };
  const environmentId = randomUUID();
  const resources = Array.from({ length: count }, (_, n) => ({
    nativeId: `native-agent-${n}`, environmentId, displayName: "Agent", lifecycle: "published",
    identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: randomUUID() }],
  }));
  const source = await nativeInventoryFixture(fixture.runtime, scope, resources);
  await reconcileInventoryFixture(fixture.runtime, scope);
  const targets = await new NativeInventory(fixture.runtime).resolveQuarantineTargets(scope, source.baselineId, resources.map(row => row.nativeId));
  const intent = { action: "quarantine" as const, actor: { tenantId, homeAccountId: principal,
    username: "fixture@example.invalid", displayName: "Fixture" }, requestPath: "/api/quarantine/jobs",
    authority: { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 },
    targets: targets.map(target => ({ ...target, directStatus: { environmentId, botId: target.botId, isBotQuarantined: false,
      lastUpdateTimeUtc: "2026-09-20T00:00:00Z", observedAt: new Date().toISOString(), correlationId: randomUUID() } })) };
  if (count === 25) expect(() => createQuarantineConfirmation({ ...intent, targets: [...intent.targets, intent.targets[0]] }))
    .toThrow("1-25 exact quarantine targets");
  const job = await repository.submit(scope, { ...intent, confirmationHash: createQuarantineConfirmation(intent).confirmationHash,
    idempotencyKey: randomUUID() });
  if (!claim) return { job, scope };
  const lease = (await repository.claim(scope, job.id, randomUUID()))!;
  for (let n = 0; n < count; n++) await repository.beginItem(lease);
  await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
  return { job, scope };
}

it("acceptance: owned, foreign and missing job-status GETs never recover or write job authority", async () => {
  const own = await running(config.tenants[0].tenantId), foreign = await running(`foreign-${randomUUID()}`);
  for (const method of ["get", "list", "listAudit", "recoverInterrupted"] as const) {
    vi.spyOn(copilotStudioQuarantineJobs, method).mockImplementation(repository[method].bind(repository) as never);
  }
  const writes: string[] = [], clients = new Set<pg.PoolClient>();
  const acquire = (client: pg.PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    const query = client.query.bind(client);
    vi.spyOn(client, "query").mockImplementation(((...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      if (/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+copilot_quarantine_(?:jobs|job_items|attempts)\b/i.test(text)) writes.push(text);
      return Reflect.apply(query, client, args);
    }) as typeof client.query);
  };
  fixture.runtime.on("acquire", acquire);
  try {
    for (const [id, status] of [[own.job.id, 200], [foreign.job.id, 404], [randomUUID(), 404]] as const) {
      expect((await fetch(`${base}/jobs/${id}`, { headers: { Cookie: cookie } })).status).toBe(status);
    }
    for (const path of ["jobs", "audit"]) expect((await fetch(`${base}/${path}`, { headers: { Cookie: cookie } })).status).toBe(200);
    expect(writes).toEqual([]);
    expect((await fixture.runtime.query(`SELECT status FROM copilot_quarantine_jobs WHERE id=ANY($1::uuid[])`,
      [[own.job.id, foreign.job.id]])).rows).toEqual([{ status: "running" }, { status: "running" }]);
  } finally { fixture.runtime.removeListener("acquire", acquire); }
});

it("acceptance: background recovery is tenant-bounded and leaves other tenants and active leases untouched", async () => {
  const own = await running(`background-${randomUUID()}`, randomUUID()), foreign = await running(`foreign-${randomUUID()}`);
  const active = await running(own.scope.tenantId, randomUUID());
  await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE id=$1", [active.job.id]);
  await repository.recoverInterrupted(own.scope.tenantId);
  expect(await repository.get(own.scope, own.job.id)).toMatchObject({ status: "waiting_authorization", canResume: true });
  for (const value of [foreign, active]) expect(await repository.get(value.scope, value.job.id)).toMatchObject({ status: "running" });
  expect((await fixture.runtime.query(`SELECT outcome,finished_at IS NOT NULL AS finished FROM copilot_quarantine_attempts WHERE job_id=$1`,
    [own.job.id])).rows).toEqual([{ outcome: "cancelled", finished: true }]);
  await expect(repository.recoverInterrupted("")).rejects.toMatchObject({ code: "scope_mismatch" });
});

it("acceptance repair: explicit resume authorizes first and recovers only the requested newer principal/job", async () => {
  await new Promise<void>((resolve, reject) => application.store.get(sessionId, (error, value) => {
    if (error || !value) return reject(error ?? new Error("session_missing"));
    value.user!.roles = ["AgentControl.Admin"];
    application.store.set(sessionId, value, failure => failure ? reject(failure) : resolve());
  }));
  vi.spyOn(capabilities, "requireAvailable").mockResolvedValue(undefined as never);
  vi.spyOn(quarantineService, "launchCopilotStudioQuarantineJob").mockImplementation(() => {});
  for (const method of ["get", "recoverInterrupted", "recoverJob"] as const) {
    vi.spyOn(copilotStudioQuarantineJobs, method).mockImplementation(repository[method].bind(repository) as never);
  }
  const older = await running(config.tenants[0].tenantId, randomUUID());
  const own = await running(config.tenants[0].tenantId, principalId, true, 25);
  const foreign = await running(`foreign-${randomUUID()}`, principalId);
  const snapshots = async () => (await fixture.runtime.query(`SELECT row_to_json(j) AS job,
    (SELECT jsonb_agg(i ORDER BY i.ordinal) FROM copilot_quarantine_job_items i WHERE i.job_id=j.id) AS items,
    (SELECT jsonb_agg(a ORDER BY a.id) FROM copilot_quarantine_attempts a WHERE a.job_id=j.id) AS attempts
    FROM copilot_quarantine_jobs j WHERE id=ANY($1::uuid[]) ORDER BY id`, [[older.job.id, foreign.job.id]])).rows;
  const untouched = await snapshots();
  const monitor = await lifecycleEvidence(fixture.operator);
  const resume = (id: string) => fetch(`${base}/jobs/${id}/resume`, { method: "POST",
    headers: { Cookie: cookie, Origin: config.frontendOrigin, "Content-Type": "application/json", "x-csrf-token": "synthetic" },
    body: JSON.stringify({ confirmed: true }) });
  for (const id of [randomUUID(), foreign.job.id, older.job.id]) {
    expect((await resume(id)).status).toBe(404);
    expect(await snapshots()).toEqual(untouched);
  }
  await monitor.reset();
  const response = await resume(own.job.id);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ id: own.job.id, canResume: true, status: "waiting_authorization" });
  expect(await snapshots()).toEqual(untouched);
  await monitor.check();
  expect(quarantineService.launchCopilotStudioQuarantineJob).toHaveBeenCalledExactlyOnceWith(own.job.id, own.scope, true);
  expect((await repository.get(own.scope, own.job.id))!.total).toBe(25);
  await monitor.report("exact-quarantine-resume");
});

it("acceptance: startup queued recovery reports progress for the existing bounded drain", async () => {
  const queued = await running(`startup-${randomUUID()}`, randomUUID(), false);
  expect(await repository.recoverInterrupted(queued.scope.tenantId, true)).toBe(1);
  expect(await repository.get(queued.scope, queued.job.id)).toMatchObject({ status: "waiting_authorization", canResume: true });
  expect(await repository.recoverInterrupted(queued.scope.tenantId, true)).toBe(0);
});
