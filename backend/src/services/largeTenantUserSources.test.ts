import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { directoryRecord, generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { UserSourcesRepository, userSourceFactsSql, userSourceObjectIds, userSourcePeopleInRead, userSourceSqlParameters } from "../db/userSources.js";
import { summarizeCopilotServices } from "./copilotServicePlans.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import { UserSourceProvider, streamAppActivity } from "./userSourceProvider.js";
import { reportHeaders } from "./userSourceGraphFields.js";
import { verifySchema } from "../db/schema.js";
import { AppError } from "../errors.js";
import type { CopilotDirectoryUser, CopilotServiceSummaryState } from "../types/copilotUsage.js";
import { activitySourceRecord } from "./userSourceRecords.js";
import { parseReportUser } from "./userSourceGraphFields.js";
import { randomUUID } from "node:crypto";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { SavedAgentPeopleService } from "./savedAgentPeople.js";

vi.hoisted(() => { process.env.SESSION_SECRET = "synthetic-user-source-selected-read-secret"; });

const firstId = "00000000-0000-0000-0000-000000000001";
const secondId = "00000000-0000-0000-0000-000000000002";
const skuId = "10000000-0000-0000-0000-000000000001";
const planId = "a62f8878-de10-42f3-b68f-6149a25ceb97";
const date = new Date().toISOString().slice(0, 10);
function graphUser(id = firstId) {
  return { id, userPrincipalName: `${id}@example.invalid`, displayName: "Émployee",
    assignedLicenses: [{ skuId, disabledPlans: [] }],
    assignedPlans: [{ servicePlanId: planId, service: "Copilot", capabilityStatus: "Enabled", assignedDateTime: null }] };
}
function csv(upn = `${firstId}@example.invalid`, activity = date) {
  return `${reportHeaders.join(",")}\n${[date, upn, "Émployee", activity, "", "", "", "", "", "", "", "", "28"].join(",")}\n`;
}

it("distinguishes stalled activity networking from database backpressure using real deadlines",async () => {
  const fixture = await testDatabase();
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const guard = setTimeout(() => controller.abort(new Error("idle-read-test-guard")),18_000);
  try {
    const stages = new UserSourceStages(fixture.runtime), append = stages.activity.bind(stages);
    let paused = false;
    vi.spyOn(stages,"activity").mockImplementation(async (...args) => {
      if (!paused) { paused = true; await new Promise(resolve => setTimeout(resolve,15_200)); }
      return append(...args);
    });
    let text = reportHeaders.join(",")+"\n";
    for (let i = 0; i < 251; i++) text += csv(`backpressure-${i}@example.invalid`).split("\n")[1]+"\n";
    const provider = new UserSourceProvider(async () => new Response(text,{ headers: { "content-type": "text/csv" } }));
    const input = generationInput({ scope: { tenantId: "synthetic-tenant",principalId: randomUUID(),kind: "principal",
      tokenMode: "delegated",source: "app_activity",selector: "complete" } });
    const outcomes = await Promise.allSettled([
      provider.refresh(stages,input,{ authorize: async () => "synthetic" }),
      expect(streamAppActivity(new Response(body),controller.signal).next()).rejects.toMatchObject({ code: "provider_timeout" }),
    ]);
    for (const outcome of outcomes) if (outcome.status==="rejected") throw outcome.reason;
    const result = (outcomes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof provider.refresh>>>).value;
    expect(result.rows).toBe(251);
    expect(paused).toBe(true);
    expect(cancelled).toBe(true);
  } finally { clearTimeout(guard); controller.abort(); await fixture.close(); }
},25_000);
function sourceUser(id: string, state: CopilotServiceSummaryState = "enabled", company: string | null = "Company"): CopilotDirectoryUser {
  return { serviceEvidenceVersion: 1, identity: { objectId: id, userPrincipalName: `${id}@example.invalid`,
    displayName: "Émployee", companyName: company, department: null, employeeType: null, accountEnabled: true, userType: "Member" },
  copilotServiceState: state, servicePlans: state === "disabled" ? [] : [{
    servicePlanId: planId, service: "M365_COPILOT_APPS", displayName: "Copilot", state: state === "partially_enabled" ? "enabled" : state,
    capabilityStatus: state === "enabled" ? "Enabled" : null, assignedDateTime: null,
  }, ...(state === "partially_enabled" ? [{
    servicePlanId: "b95945de-b3bd-46db-8437-f2beb6ea2347", service: "M365_COPILOT_TEAMS", displayName: "Teams",
    state: "disabled" as const, capabilityStatus: null, assignedDateTime: null,
  }] : [])] };
}

describe("dormant user-source foundation", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("reads only requested object IDs and preserves licensing-state goldens", async () => {
    const generations = new DataGenerations(fixture.runtime);
    const input = generationInput();
    const lease = await generations.begin(input);
    await generations.append(lease, "directory", 0, [directoryRecord(firstId), directoryRecord(secondId)]);
    await generations.validate(lease, { rows: 2, children: 0, batches: 1, pages: 0, wireRows: 0 });
    await generations.publish(lease);
    await generations.connections.selectedRead(async client => {
      const spy = vi.spyOn(client, "query");
      const people = await userSourcePeopleInRead(client, {
        tenantId: input.scope.tenantId, principalId: input.scope.principalId!, tokenMode: "delegated",
      }, { generationId: lease.id, observedAt: input.observedAt }, [firstId], new Date());
      expect(people.map(person => person.objectId)).toEqual([firstId]);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("unnest($4::text[])");
      expect(spy.mock.calls[0][1]).toContainEqual([firstId]);
      spy.mockRestore();
    });
    for (const [states, expected] of [
      [["enabled"], "enabled"], [["warning"], "warning"], [["enabled", "disabled"], "partially_enabled"],
      [["suspended", "disabled"], "suspended"], [["locked_out", "suspended"], "locked_out"],
      [["unknown", "disabled"], "unknown"], [["disabled"], "disabled"],
    ] as const) expect(summarizeCopilotServices(states.map(state => ({
      state, servicePlanId: "plan", service: "service", displayName: "name", capabilityStatus: null, assignedDateTime: null,
    })))).toBe(expected);
  });

  it("rejects more than 100 exact IDs before a query, normalizes without guessing aliases", () => {
    expect(userSourceObjectIds([firstId.toUpperCase(), firstId])).toEqual([firstId]);
    expect(() => userSourceObjectIds(Array(101).fill(firstId))).toThrow("at most 100");
    expect(() => userSourceObjectIds(["someone@example.invalid"])).toThrow("exact");
  });

  it("publishes independent directory/activity sources and never replaces a good head on denied or inconsistent attempts", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: "pipeline" } });
    const fetcher = vi.fn(async (url: string | URL) => String(url).includes("subscribedSkus")
      ? Response.json({ value: [{ skuId, appliesTo: "User", servicePlans: [{ servicePlanId: planId }] }] })
      : String(url).includes("/users?")
        ? Response.json({ value: [graphUser()], "@odata.count": 1 })
        : new Response(csv()));
    const authorize = vi.fn(async () => "synthetic-token");
    const provider = new UserSourceProvider(fetcher);
    const directory = await provider.refresh(stages, input, { authorize });
    const activity = await provider.refresh(stages, { ...input, scope: { ...input.scope, source: "app_activity" } }, { authorize });
    expect(directory.rows).toBe(1);
    expect(directory.children).toBe(1);
    expect(activity.rows).toBe(1);
    expect(authorize).toHaveBeenCalledTimes(4);
    await expect(provider.refresh(stages, input, { authorize: async () => {
      throw new AppError(403, "permission_required", "LicenseAssignment.Read.All required.");
    } })).rejects.toMatchObject({ status: 403 });
    const bad = new UserSourceProvider(async url => String(url).includes("subscribedSkus")
      ? fetcher(url) : Response.json({ value: [graphUser()], "@odata.count": 2 }));
    await expect(bad.refresh(stages, input, { authorize })).rejects.toMatchObject({ code: "provider_count_mismatch" });
    expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [directory.scopeId])).rows[0].generation_id).toBe(directory.generationId);
    expect((await fixture.runtime.query("SELECT status FROM user_source_attempts WHERE scope_id=$1 ORDER BY status", [directory.scopeId])).rows)
      .toEqual([{ status: "available" }, { status: "failed" }, { status: "permission_required" }]);
    await verifySchema(fixture.runtime);
  });

  it("streams CSV across every UTF-8 boundary, retaining blank dates and rejecting malformed UTF-8", async () => {
    const bytes = Buffer.from(csv());
    const response = new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }));
    const rows = [];
    for await (const row of streamAppActivity(response, new AbortController().signal)) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0].activity.wordCopilotLastActivityDate).toBeNull();
    await expect(async () => {
      for await (const row of streamAppActivity(new Response(new Uint8Array([0xc3, 0x28])), new AbortController().signal)) void row;
    }).rejects.toMatchObject({ code: "provider_schema" });
  });

  it("pins SQL licensing/activity goldens, exact counts, self-filter facets, null/tied pages and replacement", async () => {
    const principalId = "sql-golden";
    const identity = { ...selectionIdentity, principalId };
    const stages = new UserSourceStages(fixture.runtime);
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const input = generationInput({ scope: { ...generationInput().scope, principalId } });
    const states = ["enabled", "warning", "partially_enabled", "suspended", "locked_out", "disabled", "unknown"] as const;
    const ids = states.map((_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
    const users = states.map((state, index) => sourceUser(ids[index], state, index > 3 ? null : index < 2 ? "Å" : "å"));
    const publish = (rows: CopilotDirectoryUser[]) => stages.execute(input, async lease => {
      const key = await stages.query(lease, "discovery", "synthetic:directory");
      await stages.page(lease, key, "synthetic:directory", rows.length, rows.length);
      await stages.directory(lease, key, rows);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    await publish(users);
    await stages.execute({ ...input, scope: { ...input.scope, source: "app_activity" } }, async lease => {
      const key = await stages.query(lease, "activity", "synthetic:activity");
      const rows = ids.slice(0, 3).map((id, index) => activitySourceRecord(parseReportUser([
        date, `${id}@example.invalid`, "Name", index === 0 ? date : index === 1 ? "2020-01-01" : "",
        "", "", "", "", "", "", "", "", "28",
      ]), index + 1));
      await stages.page(lease, key, "synthetic:activity", rows.length);
      await stages.activity(lease, key, rows);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    const selected = await repository.capture(identity, "delegated", { sort: "company", order: "desc" });
    const filtered = await repository.capture(identity, "delegated", { company: "Å", entitlement: "paid_active" });
    const first = await repository.page(selected.id, identity, { limit: 2 });
    expect(first.counts).toEqual({ total: 7, filtered: 7 });
    expect(first.summary).toEqual({ checkedUsers: 7, licensedUsers: 3, inactivePaidUsers: 2, noPaidUsers: 1, unknownLicenseUsers: 1,
      activeAppUsers: 1, unknownAppUsers: 1 });
    const all: string[] = first.value.map(row => row.directory.objectId);
    await publish([sourceUser(secondId)]);
    let cursor = first.page.nextCursor;
    while (cursor) {
      const page = await repository.page(selected.id, identity, { limit: 2, cursor });
      all.push(...page.value.map(row => row.directory.objectId));
      cursor = page.page.nextCursor;
      if (!cursor) {
        const back = await repository.page(selected.id, identity, { limit: 2, cursor: page.page.previousCursor! });
        expect(back.value.map(row => row.directory.objectId)).toEqual(all.slice(-3, -1));
      }
    }
    expect(new Set(all).size).toBe(7);
    expect(all).toEqual([ids[3], ids[2], ids[1], ids[0], ids[6], ids[5], ids[4]]);
    const exact = await repository.exact(selected.id, identity, ids);
    expect(exact.map(row => row.activityState)).toEqual(["active", "inactive", "unknown", "unknown", "unknown", "unknown", "unknown"]);
    expect(exact.map(row => row.entitlement)).toEqual(["paid_active", "paid_active", "paid_active", "paid_inactive", "paid_inactive", "no_paid", "unknown"]);
    expect(exact.every(row => !("importedUsage" in row))).toBe(true);
    const plan = await repository.plans(selected.id, identity, ids[0]);
    expect(plan.counts).toEqual({ total: 1, filtered: 1 });
    expect(plan.value[0].servicePlanId).toBe(planId);
    expect((await repository.page(filtered.id, identity)).counts).toEqual({ total: 7, filtered: 2 });
    const facet = await repository.facets(filtered.id, identity, { field: "company", limit: 1 });
    expect(facet.counts).toEqual({ total: 3, filtered: 2 });
    expect(facet.value).toEqual([{ value: "Å", count: 2 }]);
    const nextFacet = await repository.facets(filtered.id, identity, { field: "company", limit: 1, cursor: facet.page.nextCursor! });
    expect(nextFacet.value).toEqual([{ value: "å", count: 1 }]);
    expect((await repository.page(selected.id, identity)).counts.total).toBe(7);
    expect((await repository.page((await repository.capture(identity, "delegated")).id, identity)).counts.total).toBe(1);
    await expect(repository.page(selected.id, { ...identity, principalId: "other" })).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(repository.page(selected.id, identity, { cursor: `${first.page.nextCursor}tampered` })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(repository.page(selected.id, identity, { limit: 101 })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("preserves cache observed/checked/conclusive precedence, TTLs and invalidates captured mutable dependencies", async () => {
    const identity = { ...selectionIdentity, principalId: "people-golden" };
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const stages = new UserSourceStages(fixture.runtime);
    const observedAt = new Date(Date.now() - 60_000);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId }, observedAt });
    await stages.execute(input, async lease => {
      const key = await stages.query(lease, "discovery", "people-directory");
      await stages.directory(lease, key, [sourceUser(firstId)]);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    let selected = await repository.capture(identity, "delegated");
    await repository.savePeople(identity, [{ objectId: firstId, status: "resolved", displayName: "Old cache", userPrincipalName: "old@example.invalid",
      checkedAt: new Date(observedAt.getTime() - 10_000).toISOString() }], async () => {});
    await expect(repository.people(selected.id, identity, [firstId])).rejects.toMatchObject({ code: "selection_invalidated" });
    selected = await repository.capture(identity, "delegated");
    expect((await repository.people(selected.id, identity, [firstId]))[0].displayName).toBe("Émployee");
    await repository.savePeople(identity, [{ objectId: firstId, status: "lookup_failed", displayName: null, userPrincipalName: null,
      checkedAt: new Date().toISOString(), errorCode: "graph_error" }], async () => {});
    selected = await repository.capture(identity, "delegated");
    const failure = (await repository.people(selected.id, identity, [firstId]))[0];
    expect(failure).toMatchObject({ displayName: "Émployee", status: "lookup_failed", errorCode: "graph_error" });
    expect(Date.parse(failure.expiresAt!) - Date.parse(failure.checkedAt!)).toBe(15 * 60_000);
    await repository.savePeople(identity, [{ objectId: firstId, status: "not_found", displayName: null, userPrincipalName: null,
      checkedAt: new Date(Date.now() + 1000).toISOString() }], async () => {});
    await repository.savePeople(identity, [{ objectId: firstId, status: "lookup_failed", displayName: null, userPrincipalName: null,
      checkedAt: new Date(Date.now() + 2000).toISOString(), errorCode: "graph_error" }], async () => {});
    selected = await repository.capture(identity, "delegated");
    expect((await repository.people(selected.id, identity, [firstId]))[0]).toMatchObject({ displayName: null, userPrincipalName: null, status: "lookup_failed" });
    const missing = await repository.capture({ ...identity, tenantId: "other-tenant" }, "delegated");
    expect(await repository.people(missing.id, { ...identity, tenantId: "other-tenant" }, [firstId])).toEqual([]);
    expect((await repository.page(missing.id, { ...identity, tenantId: "other-tenant" })).summary.licensedUsers).toBeNull();
  });

  it("invalidates both token modes once per cache statement, including direct clear, and forbids moving identities", async () => {
    const identity = { ...selectionIdentity, principalId: "cache-clear-fences" };
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const selected = await repository.capture(identity, "delegated"), application = await repository.capture(identity, "application");
    const epochs = async () => (await fixture.runtime.query(`SELECT token_mode,epoch::text FROM data_scope_epochs
      WHERE tenant_id=$1 AND principal_id=$2 AND source='user_sources' AND selector='complete' ORDER BY token_mode LIMIT 3`,
    [identity.tenantId, identity.principalId])).rows.map(row => ({ mode: row.token_mode, epoch: Number(row.epoch) }));
    const before = await epochs();
    await repository.savePeople(identity, [firstId, secondId, randomUUID()].map(objectId => ({
      objectId, status: "resolved" as const, displayName: "Cached person", userPrincipalName: `${objectId}@example.invalid`, checkedAt: new Date().toISOString(),
    })), async () => {});
    expect(await epochs()).toEqual(before.map(row => ({ ...row, epoch: row.epoch + 1 })));
    await expect(repository.people(selected.id, identity, [firstId])).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(repository.people(application.id, identity, [firstId])).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(fixture.runtime.query("UPDATE agent_people_cache SET principal_id='another' WHERE tenant_id=$1 AND principal_id=$2",
      [identity.tenantId, identity.principalId])).rejects.toThrow("agent_people_identity_immutable");
    const refreshed = await repository.capture(identity, "delegated");
    await expect(fixture.runtime.query("DELETE FROM agent_people_cache WHERE tenant_id=$1 AND principal_id=$2",
      [identity.tenantId, identity.principalId])).rejects.toMatchObject({ code: "42501" });
    await fixture.operator.query("DELETE FROM agent_people_cache WHERE tenant_id=$1 AND principal_id=$2", [identity.tenantId, identity.principalId]);
    expect(await epochs()).toEqual(before.map(row => ({ ...row, epoch: row.epoch + 2 })));
    await expect(repository.people(refreshed.id, identity, [firstId])).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("rolls back the observation and dependency invalidation when a late people publication fence closes", async () => {
    const identity = { ...selectionIdentity, principalId: "late-cache-publication-fence" };
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const selected = await repository.capture(identity, "delegated");
    const clients = new Set<unknown>();
    let checks = 0;
    await expect(repository.savePeople(identity, [{
      objectId: firstId, status: "resolved", displayName: "Must not commit", userPrincipalName: "cancelled@example.invalid",
      checkedAt: new Date().toISOString(),
    }], async client => {
      clients.add(client); checks++;
      const written = await client.query(`SELECT object_id FROM agent_people_cache
        WHERE tenant_id=$1 AND principal_id=$2 AND object_id=$3 LIMIT 1`, [identity.tenantId, identity.principalId, firstId]);
      if (written.rowCount) throw new AppError(401, "unauthorized", "Publication was revoked while its write was executing.");
    })).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(checks).toBe(2);
    expect(clients.size).toBe(1);
    expect(await repository.people(selected.id, identity, [firstId])).toEqual([]);
    expect((await fixture.runtime.query(`SELECT object_id FROM agent_people_cache WHERE tenant_id=$1 AND principal_id=$2 LIMIT 1`,
      [identity.tenantId, identity.principalId])).rows).toEqual([]);
  });

  it.each([true, false])("keeps a complete people projection in one captured read with caller-owned client %s", async callerOwned => {
    const identity = { ...selectionIdentity, principalId: `composed-people-${callerOwned}` };
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    await repository.capture(identity, "delegated");
    const records = Array.from({ length: 100 }, (_, index): UnifiedAgentRecord => ({
      id: `agent:${randomUUID()}`, displayName: `Agent ${index}`, presence: "power_platform", environmentId: "environment", packages: [],
      powerPlatformResource: { tenantId: identity.tenantId, nativeId: randomUUID(), type: "microsoft.copilotstudio/agents",
        environmentId: "environment", location: null, displayName: `Agent ${index}`, createdAt: null, createdBy: randomUUID(), lastPublishedAt: null,
        sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent", lifecycle: "unknown",
        identityConfidence: "exact_native", identifiers: [], provenance: {}, details: { ownerId: randomUUID(), lastModifiedBy: randomUUID() }, unknownFieldCount: 0 },
      identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
      observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
    }));
    const read = vi.spyOn(repository.connections, "selectedRead");
    const metadata = vi.spyOn(UserSourcesRepository.prototype, "metadataInRead");
    const lookups = vi.spyOn(await import("../db/userSources.js"), "userSourcePeopleInRead");
    try {
      const service = new SavedAgentPeopleService(fixture.runtime);
      const result = callerOwned
        ? await repository.connections.selectedRead(client => service.project(identity, records, client))
        : await service.project(identity, records);
      expect(result).toHaveLength(100);
      expect(result.every(row => row.people === undefined)).toBe(true);
      expect(read).toHaveBeenCalledOnce();
      expect(metadata).toHaveBeenCalledOnce();
      expect(metadata.mock.calls[0][1]).toMatchObject({ tenantId: identity.tenantId, principalId: identity.principalId, tokenMode: "delegated" });
      expect(metadata.mock.calls[0][2]).toBeInstanceOf(Date);
      expect(lookups).toHaveBeenCalledTimes(3);
      expect(lookups.mock.calls.every(call => call[3].length === 100)).toBe(true);
      expect(lookups.mock.calls.every(call => call[0] === metadata.mock.calls[0][0] && call[4] === metadata.mock.calls[0][2])).toBe(true);
      expect(lookups.mock.calls.flatMap(call => [...call[3]]).sort()).toEqual(records.flatMap(row => [
        row.powerPlatformResource!.createdBy, row.powerPlatformResource!.details.ownerId, row.powerPlatformResource!.details.lastModifiedBy,
      ]).sort());
    } finally { read.mockRestore(); metadata.mockRestore(); lookups.mockRestore(); }
  });

  it("measures 1000/10000 rows without tenant arrays or wide parameters and records actual SQL plans", async () => {
    for (const size of [1000, 10000]) {
      const identity = { ...selectionIdentity, principalId: `measure-${size}` };
      const stages = new UserSourceStages(fixture.runtime);
      const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
      const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId } });
      const published = await stages.execute(input, async lease => {
        const key = await stages.query(lease, "discovery", "measurement");
        for (let start = 0; start < size; start += 250) {
          const users = Array.from({ length: Math.min(250, size - start) }, (_, index) => sourceUser(
            `00000000-0000-0000-0000-${String(start + index + 1).padStart(12, "0")}`));
          await stages.directory(lease, key, users);
        }
        await stages.finishQuery(lease, key);
      }, { beforePublish: async () => {} });
      const selected = await repository.capture(identity, "delegated");
      await repository.read(selected.id, identity, async (client, context) => {
        expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
        const query = `SELECT identity FROM (${userSourceFactsSql()}) facts WHERE identity=ANY($4::text[])`;
        const parameters = [...userSourceSqlParameters(context), [firstId]];
        const plan = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`, parameters)).rows[0]["QUERY PLAN"];
        expect(plan[0].Plan["Actual Rows"]).toBe(1);
        expect(JSON.stringify(plan)).toMatch(/Index/);
        expect(await repository.countsInRead(client, context)).toEqual({ total: size, filtered: size });
        process.stdout.write(JSON.stringify({ contract: "user_sources_measurement", size, rowsReturned: plan[0].Plan["Actual Rows"],
          maximumParameterBytes: stages.maximumParameterBytes, batchResidents: stages.generations.batchResidency.maximum,
          stagedBytes: published.bytes, plan }) + "\n");
      });
      expect(stages.maximumParameterBytes).toBeLessThanOrEqual(1_048_576);
      expect(stages.generations.batchResidency.maximum).toBe(2);
    }
  }, 60_000);

  it("discovers in 20-SKU batches and verifies staged exact inputs in 20-ID batches without repeated known work", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: "exact-provider" } });
    const skus = Array.from({ length: 21 }, (_, index) => `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
    const calls: string[] = [];
    const observed: number[] = [];
    const fetcher = vi.fn(async (target: string | URL) => {
      const url = new URL(target);
      if (url.pathname.endsWith("subscribedSkus")) return Response.json({ value: skus.map(skuId => ({
        skuId, appliesTo: "User", servicePlans: [{ servicePlanId: planId }],
      })) });
      const filter = url.searchParams.get("$filter")!;
      calls.push(filter);
      expect(filter.split(" or ").length).toBeLessThanOrEqual(20);
      if (filter.includes("assignedLicenses")) return Response.json({
        value: [{ ...graphUser(), assignedLicenses: skus.map(skuId => ({ skuId, disabledPlans: [] })) }], "@odata.count": 1,
      });
      return Response.json({ value: [], "@odata.count": 0 });
    });
    const published = await new UserSourceProvider(fetcher).refresh(stages, input, {
      authorize: async () => "synthetic-token",
      identities: async lease => {
        await stages.identities(lease, [firstId, ` ${firstId}@EXAMPLE.INVALID `, ...Array.from({ length: 41 }, (_, index) => `missing${index}@example.invalid`), "concealed-label"]);
      },
      progress: async count => { observed.push(count); },
    });
    expect(calls.filter(filter => filter.includes("assignedLicenses"))).toHaveLength(2);
    expect(calls.filter(filter => !filter.includes("assignedLicenses")).map(filter => filter.split(" or ").length)).toEqual([20, 20, 1]);
    expect(published.rows).toBe(1);
    expect(observed.every(value => value === 1)).toBe(true);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM user_source_identity_inputs WHERE generation_id=$1 AND NOT checked", [published.generationId])).rows[0].n).toBe(0);
  });

  it.each([
    { kind: "catalog", limit: 200, preceding: 0 },
    { kind: "discovery", limit: 1000, preceding: 1 },
    { kind: "identity", limit: 6000, preceding: 2 },
  ] as const)("checks the $kind page budget before another provider request", async ({ kind, limit, preceding }) => {
    const stages = new UserSourceStages(fixture.runtime), original = stages.query.bind(stages);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID() } });
    let generationId = "", targetRequests = 0;
    const query = vi.spyOn(stages, "query").mockImplementation(async (lease, queryKind, initialUrl) => {
      const key = await original(lease, queryKind, initialUrl);
      if (queryKind === kind) {
        generationId = lease.id;
        await fixture.operator.query("UPDATE user_source_queries SET page_count=$3 WHERE generation_id=$1 AND query_key=$2", [lease.id, key, limit - 1]);
        await fixture.operator.query("UPDATE data_generations SET page_count=page_count+$2 WHERE id=$1", [lease.id, limit - 1]);
      }
      return key;
    });
    const fetcher = vi.fn(async (target: string | URL) => {
      const url = new URL(target), current = url.pathname.endsWith("subscribedSkus") ? "catalog"
        : url.searchParams.get("$filter")!.includes("assignedLicenses") ? "discovery" : "identity";
      const body = current === "catalog" ? { value: [{ skuId, appliesTo: "User", servicePlans: [{ servicePlanId: planId }] }] }
        : { value: [], "@odata.count": 0 };
      if (current !== kind) return Response.json(body);
      targetRequests++;
      url.searchParams.set("$skiptoken", String(targetRequests));
      return Response.json({ ...body, "@odata.nextLink": url.toString() });
    });
    try {
      await expect(new UserSourceProvider(fetcher).refresh(stages, input, {
        authorize: async () => "synthetic-token", identities: lease => stages.identities(lease, ["missing@example.invalid"]),
      })).rejects.toMatchObject({ code: "provider_page_limit", details: { limit, observed: limit + 1 } });
      expect(targetRequests).toBe(1);
      expect((await fixture.runtime.query("SELECT page_count,state FROM data_generations WHERE id=$1", [generationId])).rows)
        .toEqual([{ page_count: limit + preceding, state: "failed" }]);
    } finally { query.mockRestore(); }
  });

  it.each(["conflict", "changed-count", "off-host", "changed-filter", "repeat-token"] as const)(
    "fails %s provider attempts with no partial head and SQL page evidence", async failure => {
      const stages = new UserSourceStages(fixture.runtime);
      const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID() } });
      let page = 0;
      const fetcher = vi.fn(async (target: string | URL) => {
        const url = new URL(target);
        if (url.pathname.endsWith("subscribedSkus")) return Response.json({ value: [{ skuId, appliesTo: "User", servicePlans: [{ servicePlanId: planId }] }] });
        page++;
        if (page === 1) {
          const next = new URL(url);
          next.searchParams.set("$skiptoken", "next");
          if (failure === "off-host") next.hostname = "not-a-provider.invalid";
          if (failure === "changed-filter") next.searchParams.set("$filter", "id eq 'unrelated'");
          return Response.json({ value: [graphUser()], "@odata.count": failure === "changed-count" ? 2 : 1, "@odata.nextLink": next.toString() });
        }
        return Response.json({ value: [{ ...graphUser(), ...(failure === "conflict" ? { displayName: "conflict" } : {}) }],
          "@odata.count": 1, ...(failure === "repeat-token" ? { "@odata.nextLink": url.toString() } : {}) });
      });
      await expect(new UserSourceProvider(fetcher).refresh(stages, input, { authorize: async () => "synthetic-token" })).rejects.toBeInstanceOf(AppError);
      expect(fetcher.mock.calls.every(([url]) => new URL(url).origin === "https://graph.microsoft.com")).toBe(true);
      const generations = (await fixture.runtime.query("SELECT state FROM data_generations WHERE job_id=$1", [input.jobId])).rows;
      expect(generations).toEqual([{ state: "failed" }]);
      expect((await fixture.runtime.query(`SELECT h.generation_id FROM data_generation_heads h JOIN data_scope_epochs s ON s.id=h.scope_id
        WHERE s.principal_id=$1`, [input.scope.principalId])).rows[0].generation_id).toBeNull();
    });

  it("retains duplicate CSV identities as ambiguous, including object-ID/UPN alias collisions", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const identity = { ...selectionIdentity, principalId: "activity-ambiguity" };
    const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId } });
    const users = [sourceUser(firstId), sourceUser(secondId),
      sourceUser("00000000-0000-0000-0000-000000000003"), sourceUser("00000000-0000-0000-0000-000000000004"),
      sourceUser("00000000-0000-0000-0000-000000000005")];
    users[2].identity.userPrincipalName = users[3].identity.userPrincipalName = "shared@example.invalid";
    users[4].identity.userPrincipalName = users[4].identity.objectId;
    const report = [parseReportUser([date, users[0].identity.userPrincipalName, "", date, "", "", "", "", "", "", "", "", "28"]),
      parseReportUser([date, firstId, "", date, "", "", "", "", "", "", "", "", "28"]),
      parseReportUser([date, users[1].identity.userPrincipalName, "", date, "", "", "", "", "", "", "", "", "28"]),
      parseReportUser([date, "shared@example.invalid", "", date, "", "", "", "", "", "", "", "", "28"]),
      parseReportUser([date, users[4].identity.objectId, "", date, "", "", "", "", "", "", "", "", "28"])];
    await stages.execute(input, async lease => {
      const key = await stages.query(lease, "discovery", "ambiguous-directory");
      await stages.directory(lease, key, users);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    await stages.execute({ ...input, scope: { ...input.scope, source: "app_activity" } }, async lease => {
      const key = await stages.query(lease, "activity", "ambiguous-activity");
      await stages.activity(lease, key, report.map((row, index) => activitySourceRecord(row, index)));
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const selected = await repository.capture(identity, "delegated");
    const result = await repository.page(selected.id, identity);
    expect(result.value.filter(row => row.appActivity !== null).map(row => row.directory.objectId)).toEqual([secondId, users[4].identity.objectId]);
    expect(result.sources.app_activity.state).toBe("partial");
    expect(result.value.find(row => row.directory.objectId === firstId)?.activityState).toBe("unknown");
    await repository.read(selected.id, identity, async (client, context) => {
      const parameters = userSourceSqlParameters(context);
      const complete = (await client.query(`${userSourceFactsSql()} ORDER BY d.identity`, parameters)).rows;
      const pointwise = (await client.query(`WITH selected_directory AS (
        SELECT * FROM directory_user_rows WHERE generation_id=$1
      ) ${userSourceFactsSql(true)} ORDER BY d.identity`, parameters)).rows;
      expect(complete).toEqual(pointwise);
      expect(complete.filter(row => row.activity_identity !== null).map(row => row.identity)).toEqual([secondId, users[4].identity.objectId]);
    });
    const application = await repository.capture(identity, "application");
    expect((await repository.page(application.id, identity)).counts.total).toBe(0);
  });

  it("pages the full 1000-plan child ceiling and rejects 1001 without replacing the good source", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const identity = { ...selectionIdentity, principalId: "child-ceiling" };
    const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId } });
    const user = sourceUser(firstId);
    user.servicePlans = Array.from({ length: 1000 }, (_, index) => ({ ...user.servicePlans[0], servicePlanId: `plan-${String(index).padStart(4, "0")}` }));
    user.servicePlans[0].assignedDateTime = "2026-01-01T00:00:00.1234567Z";
    const publish = () => stages.execute(input, async lease => {
      const key = await stages.query(lease, "discovery", "child-ceiling");
      await stages.directory(lease, key, [user]);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    const good = await publish();
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const selected = await repository.capture(identity, "delegated");
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await repository.plans(selected.id, identity, firstId, { limit: 100, cursor });
      count += page.value.length;
      if (!cursor) expect(page.value[0].assignedDateTime).toBe("2026-01-01T00:00:00.1234567Z");
      expect(page.counts).toEqual({ total: 1000, filtered: 1000 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1_048_576);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor);
    expect(count).toBe(1000);
    user.servicePlans.push({ ...user.servicePlans[0], servicePlanId: "plan-excess" });
    await expect(publish()).rejects.toMatchObject({ code: "provider_schema" });
    expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [good.scopeId])).rows[0].generation_id).toBe(good.generationId);
  });

  it("renews independently through a real SQL-backed controlled 600-second Retry-After and idle validation", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const originalRenew = stages.generations.renew.bind(stages.generations);
    let renewed = Promise.resolve();
    const renew = vi.spyOn(stages.generations, "renew").mockImplementation(lease => {
      renewed = originalRenew(lease);
      return renewed;
    });
    const input = generationInput({ scope: { ...generationInput().scope, principalId: "heartbeat-provider" } });
    let calls = 0;
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 20_000) {
        await vi.advanceTimersByTimeAsync(20_000);
        await renewed;
      }
    };
    const wait = vi.fn(advance);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const provider = new UserSourceProvider(async () => ++calls === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "600" } }) : Response.json({ value: [] }), wait);
      let authorizations = 0;
      await provider.refresh(stages, input, { authorize: async () => {
        if (++authorizations === 2) await advance(60_000);
        return "synthetic-token";
      } });
      expect(wait).toHaveBeenCalledWith(600_000, expect.any(AbortSignal));
      expect(renew).toHaveBeenCalledTimes(33);
    } finally { vi.useRealTimers(); renew.mockRestore(); }
  });

  it.each(["provider-wait", "validation", "revocation"] as const)("fences cancellation during %s without advancing the head", async moment => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID() } });
    const controller = new AbortController();
    const original = stages.generations.validationStep.bind(stages.generations);
    if (moment === "validation") vi.spyOn(stages.generations, "validationStep").mockImplementationOnce(async lease => {
      controller.abort(new Error("validation-cancelled"));
      return original(lease);
    });
    await expect(stages.execute(input, async (lease, signal) => {
      if (moment === "provider-wait") { controller.abort(new Error("wait-cancelled")); signal.throwIfAborted(); }
      if (moment === "revocation") await stages.generations.revokePrincipal(lease.tenantId, input.scope.principalId!);
      if (moment === "validation") {
        const key = await stages.query(lease, "catalog", "cancel-validation");
        await stages.finishQuery(lease, key);
      }
    }, { signal: controller.signal, beforePublish: async () => {} })).rejects.toBeInstanceOf(Error);
    const row = (await fixture.runtime.query(`SELECT g.state,h.generation_id FROM data_generations g
      JOIN data_generation_heads h ON h.scope_id=g.scope_id WHERE g.job_id=$1`, [input.jobId])).rows[0];
    expect(row.generation_id).toBeNull();
    expect(row.state).toBe("cancelled");
  });

  it("settles independent sources, preserves permission errors and reports partial success from SQL metadata", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const identity = { ...selectionIdentity, principalId: "partial-source" };
    const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId } });
    const provider = new UserSourceProvider(async () => Response.json({ value: [] }));
    const result = await provider.refreshSources(stages, repository, identity, [input,
      { ...input, scope: { ...input.scope, source: "app_activity" } }], {
      authorize: async source => { if (source === "app_activity") throw new AppError(403, "permission_required", "Reports.Read.All required."); return "synthetic-token"; },
    });
    expect(result.status).toBe("partial");
    expect(result.count).toBe(0);
    expect(result.sources.directory.rowCount).toBe(0);
    expect(result.sources.app_activity.rowCount).toBeNull();
    expect(result.sources.app_activity.attemptStatus).toBe("permission_required");
    expect(result.outcomes.map(outcome => outcome.status)).toEqual(["fulfilled", "rejected"]);
  });

  it("never forwards Graph credentials to signed downloads and rejects invalid redirect hosts", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: "signed-download", source: "app_activity" } });
    const calls: RequestInit[] = [];
    const provider = new UserSourceProvider(async (_url, init) => {
      calls.push(init!);
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://reports.office.com/data/download/synthetic" } }) : new Response(csv());
    });
    await provider.refresh(stages, input, { authorize: async () => "synthetic-token" });
    expect(new Headers(calls[0].headers).get("Authorization")).toBe("Bearer synthetic-token");
    expect(new Headers(calls[1].headers).has("Authorization")).toBe(false);
    const bad = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/data/download/synthetic" } }));
    await expect(new UserSourceProvider(bad).refresh(stages, input, { authorize: async () => "synthetic-token" }))
      .rejects.toMatchObject({ code: "invalid_provider_link" });
    expect(bad).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 410, 429, 500, 502, 503, 504])("requests a new signed report after download HTTP %i", async status => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID(), source: "app_activity" } });
    let reports = 0, downloads = 0;
    const wait = vi.fn(async () => {});
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      if (target.origin === "https://graph.microsoft.com") {
        expect(new Headers(init?.headers).has("Authorization")).toBe(true);
        return new Response(null, { status: 302, headers: { location: `https://reports.office.com/data/download/fresh-${++reports}` } });
      }
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(target.pathname).toBe(`/data/download/fresh-${++downloads}`);
      return downloads === 1 ? new Response("private signed-download error", { status, headers: { "Retry-After": "3" } }) : new Response(csv());
    });
    const result = await new UserSourceProvider(fetcher, wait).refresh(stages, input, { authorize: async () => "synthetic-token" });
    expect(result.rows).toBe(1);
    expect(reports).toBe(2);
    expect(downloads).toBe(2);
    expect(wait).toHaveBeenCalledWith(3000, expect.any(AbortSignal));
  });

  it.each([400, 403, 503])("bounds repeated report download HTTP %i and keeps the preceding complete source", async status => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID(), source: "app_activity" } });
    const saved = await new UserSourceProvider(async () => new Response(csv())).refresh(stages, input, { authorize: async () => "synthetic-token" });
    let requests = 0;
    const wait = vi.fn(async () => {});
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = new UserSourceProvider(async url => {
        requests++;
        return String(url).startsWith("https://graph.microsoft.com/")
          ? new Response(null, { status: 302, headers: { location: "https://reports.office.com/data/download/private-signed-token" } })
          : new Response("private signed-download error", { status });
      }, wait);
      await expect(provider.refresh(stages, { ...input, jobId: randomUUID(), observedAt: new Date() }, { authorize: async () => "synthetic-token" }))
        .rejects.toMatchObject({ code: "report_download_failed", message: expect.stringContaining(`HTTP ${status}`) });
      expect(requests).toBe(status === 400 ? 2 : 6);
      expect(wait).toHaveBeenCalledTimes(status === 400 ? 0 : 2);
      expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [saved.scopeId])).rows[0].generation_id)
        .toBe(saved.generationId);
      expect(log.mock.calls.some(([value]) => JSON.parse(String(value)).event === "report_download_failed")).toBe(true);
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-signed-token|private signed-download error|synthetic-token/);
    } finally { log.mockRestore(); }
  });

  it("cancels report-download backoff without fetching another signed URL", async () => {
    const stages = new UserSourceStages(fixture.runtime), controller = new AbortController();
    const input = generationInput({ scope: { ...generationInput().scope, principalId: randomUUID(), source: "app_activity" } });
    const reason = new AppError(409, "read_job_cancelled", "Cancelled report refresh.");
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).startsWith("https://graph.microsoft.com/")
      ? new Response(null, { status: 302, headers: { location: "https://reports.office.com/data/download/synthetic" } })
      : new Response(null, { status: 503 }));
    const provider = new UserSourceProvider(fetcher, async () => { controller.abort(reason); });
    await expect(provider.refresh(stages, input, { authorize: async () => "synthetic-token", signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["header-only", () => new Response(`${reportHeaders.join(",")}\n`), 0],
    ["reordered", () => new Response(csv().trimEnd().split("\n").map(line => line.split(",").reverse().join(",")).join("\n")), 1],
    ["added-column", () => new Response(csv().trimEnd().split("\n").map((line, index) => `${line},${index ? "ignored" : "New field"}`).join("\n")), 1],
  ] as const)("accepts %s CSV without invented refresh/activity fields", async (_name, response, expected) => {
    let count = 0;
    for await (const row of streamAppActivity(response(), new AbortController().signal)) { expect(row.activity.reportRefreshDate).toBe(date); count++; }
    expect(count).toBe(expected);
  });

  it.each(["wrong-period", "duplicate-header", "impossible-date", "long-field", "empty-added-header",
    "duplicate-added-header", "missing-added-value", "extra-added-value", "invalid-date-with-added-value", "missing-base-fields"] as const)("rejects %s CSV records", async kind => {
    let value = csv();
    if (kind === "wrong-period") value = value.replace(/,28\n$/, ",90\n");
    if (kind === "duplicate-header") value = value.replace("Display Name", "User Principal Name");
    if (kind === "impossible-date") value = value.replaceAll(date, "2026-02-30");
    if (kind === "long-field") value = value.replace("Émployee", "x".repeat(1025));
    if (kind === "empty-added-header") value = value.trimEnd().split("\n").map((line, index) => `${line},${index ? "ignored" : ""}`).join("\n");
    if (kind === "duplicate-added-header") value = value.trimEnd().split("\n").map((line, index) => `${line},${index ? "ignored" : "User Principal Name"}`).join("\n");
    if (kind === "missing-added-value") value = value.replace("\n", ",Extra\n");
    if (kind === "extra-added-value") value = value.trimEnd().split("\n").map((line, index) => `${line},${index ? "one,two" : "Extra"}`).join("\n");
    if (kind === "invalid-date-with-added-value") value = value.replaceAll(date, "2026-02-30").trimEnd()
      .split("\n").map((line, index) => `${line},${index ? "ignored" : "Extra"}`).join("\n");
    if (kind === "missing-base-fields") value = `User Principal Name,Last Activity Date\n${firstId}@example.invalid,${date}`;
    await expect(async () => { for await (const row of streamAppActivity(new Response(value), new AbortController().signal)) void row; })
      .rejects.toMatchObject({ code: "provider_schema" });
  });

  it("accepts exactly 100000 quoted multiline records and rejects the next before malformed trailing input", async () => {
    for (const size of [100000, 100001]) {
      const line = csv().split("\n")[1].replace("Émployee", '"Émployee\ncontinued"') + "\n";
      let emitted = -1;
      const response = new Response(new ReadableStream({ pull(controller) {
        emitted++;
        if (emitted === 0) controller.enqueue(Buffer.from(reportHeaders.join(",") + "\n"));
        else if (emitted <= size) controller.enqueue(Buffer.from(line));
        else if (size > 100000 && emitted === size + 1) controller.enqueue(Buffer.from('"unterminated'));
        else controller.close();
      } }));
      const consume = async () => { let count = 0; for await (const row of streamAppActivity(response, new AbortController().signal)) { void row; count++; } return count; };
      if (size === 100000) expect(await consume()).toBe(size);
      else await expect(consume()).rejects.toMatchObject({ code: "provider_report_rows", details: { limit: 100000, observed: 100001 } });
    }
  }, 30_000);

  it("verifies exact forward schema columns/grants and rejects runtime mutation of staged evidence", async () => {
    await verifySchema(fixture.runtime);
    await expect(fixture.runtime.query("UPDATE user_source_read_contexts SET token_mode='application'")).rejects.toThrow("permission denied");
    await expect(fixture.runtime.query("TRUNCATE user_source_identity_inputs")).rejects.toThrow("permission denied");
    const client = await fixture.operator.connect();
    await client.query("BEGIN");
    try {
      await client.query("ALTER TABLE user_source_attempts ALTER COLUMN source TYPE varchar");
      await expect(verifySchema(client)).rejects.toThrow("User source schema");
    } finally { await client.query("ROLLBACK"); client.release(); }
    await verifySchema(fixture.runtime);
  });

  it("projects caller pages through exact reads, discards stale people and rejects cross-tenant records before queries", async () => {
    const identity = { ...selectionIdentity, principalId: "caller-page" };
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    let selected = await repository.capture(identity, "delegated");
    await repository.savePeople(identity, [{ objectId: firstId, displayName: "Owner", userPrincipalName: "owner@example.invalid",
      status: "resolved", checkedAt: new Date().toISOString() }], async () => {});
    await repository.savePeople(identity, [{ objectId: secondId, displayName: "Expired", userPrincipalName: "expired@example.invalid",
      status: "resolved", checkedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }], async () => {});
    selected = await repository.capture(identity, "delegated");
    const row = { id: "agent", powerPlatformResource: { tenantId: identity.tenantId, createdBy: firstId,
      details: { ownerId: firstId, lastModifiedBy: secondId } }, people: { lastModifiedBy: { displayName: "stale" } } } as unknown as UnifiedAgentRecord;
    const [projected] = await repository.projectPeople(selected.id, identity, [row]);
    expect(projected.people?.owner?.displayName).toBe("Owner");
    expect(projected.people?.createdBy?.displayName).toBe("Owner");
    expect(projected.people?.lastModifiedBy).toBeUndefined();
    expect(() => repository.projectPeople(selected.id, identity, Array(101).fill(row))).toThrow("at most 100");
    expect(() => repository.projectPeople(selected.id, identity, [{ ...row, powerPlatformResource: {
      ...row.powerPlatformResource!, tenantId: "other-tenant",
    } }])).toThrow("another tenant");
  });

  it("preserves empty, stale and expired source distinctions with captured evaluation time", async () => {
    const identity = { ...selectionIdentity, principalId: "freshness" };
    const stages = new UserSourceStages(fixture.runtime);
    const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
    const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId, source: "app_activity" } });
    await new UserSourceProvider(async () => new Response(reportHeaders.join(",") + "\n")).refresh(stages, input, { authorize: async () => "synthetic-token" });
    let selected = await repository.capture(identity, "delegated");
    expect((await repository.page(selected.id, identity)).sources.app_activity).toMatchObject({
      state: "partial", rowCount: 0, reportRefreshDate: null, period: "D28", reportVersion: "v2",
    });
    const old = csv().replaceAll(date, "2020-01-01");
    await new UserSourceProvider(async () => new Response(old)).refresh(stages, input, { authorize: async () => "synthetic-token" });
    selected = await repository.capture(identity, "delegated");
    expect((await repository.page(selected.id, identity)).sources.app_activity.state).toBe("stale");
    await repository.connections.selectedRead(async client => {
      const source = await repository.metadataInRead(client, { ...identity, tokenMode: "delegated" }, new Date(Date.now() + 2 * 86_400_000));
      expect(source.app_activity).toMatchObject({ state: "unavailable", rowCount: null, generationId: null });
    });
  });

  it.each(["available", "stale", "partial"] as const)("preserves %s app-activity evidence during a running refresh", async state => {
    const identity = { ...selectionIdentity, principalId: randomUUID() };
    const input = generationInput({ scope: { ...generationInput().scope, principalId: identity.principalId, source: "app_activity" } });
    const stages = new UserSourceStages(fixture.runtime);
    await stages.execute({ ...input, scope: { ...input.scope, source: "directory" } }, async lease => {
      const key = await stages.query(lease, "discovery", "synthetic:directory");
      await stages.page(lease, key, "synthetic:directory", 1, 1);
      await stages.directory(lease, key, [sourceUser(firstId)]);
      await stages.finishQuery(lease, key);
    }, { beforePublish: async () => {} });
    const body = state === "available" ? csv() : state === "stale" ? csv().replaceAll(date, "2020-01-01") : reportHeaders.join(",") + "\n";
    await new UserSourceProvider(async () => new Response(body)).refresh(stages, input,
      { authorize: async () => "synthetic-token" });
    const generations = new DataGenerations(fixture.runtime), lease = await generations.begin(input);
    try {
      await fixture.runtime.query(`INSERT INTO user_source_attempts(generation_id,scope_id,tenant_id,source)
        VALUES($1,$2,$3,'app_activity')`, [lease.id, lease.scopeId, identity.tenantId]);
      const repository = new UserSourcesRepository(fixture.runtime, "synthetic-cursor-secret-at-least-32-bytes");
      await repository.connections.selectedRead(async client => {
        const scope = { ...identity, tokenMode: "delegated" as const };
        const current = await repository.metadataInRead(client, scope, new Date());
        expect(current.app_activity).toMatchObject({ state, attemptStatus: "running" });
        expect(current.app_activity.generationId).not.toBeNull();
        const expired = await repository.metadataInRead(client, scope, new Date(Date.now() + 2 * 86_400_000));
        expect(expired.app_activity).toMatchObject({ state: "unavailable", attemptStatus: "running", generationId: null });
      });
    } finally { await generations.abort(lease); }
  });

  it("enforces exact 64-MiB streamed wire bytes plus one without holding a report array", async () => {
    const limit = 64 * 1024 ** 2;
    for (const total of [limit, limit + 1]) {
      const header = Buffer.from(reportHeaders.join(",") + ",Extra\n");
      const prefix = csv().split("\n")[1] + ",";
      const minimum = Buffer.byteLength(prefix + "\n");
      const line = Buffer.from(prefix + "x".repeat(1000) + "\n");
      let remaining = total;
      let first = true;
      const response = new Response(new ReadableStream({ pull(controller) {
        if (first) { first = false; remaining -= header.length; controller.enqueue(header); return; }
        if (!remaining) { controller.close(); return; }
        if (remaining >= line.length + minimum) { remaining -= line.length; controller.enqueue(line); return; }
        controller.enqueue(Buffer.from(prefix + "x".repeat(remaining - minimum) + "\n"));
        remaining = 0;
      } }));
      const consume = async () => { let count = 0; for await (const row of streamAppActivity(response, new AbortController().signal)) { void row; count++; } return count; };
      if (total === limit) expect(await consume()).toBeGreaterThan(50_000);
      else await expect(consume()).rejects.toMatchObject({ code: "provider_report_bytes", details: { limit, observed: limit + 1 } });
    }
  }, 60_000);

  it("requires actual source-job completion on the publishing transaction and rolls it back with a failed head swap", async () => {
    const principalId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId }, jobKind: "data_sync", runId, jobId });
    await fixture.runtime.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,status)
      VALUES($1,$2,$3,'incremental','["users"]',repeat('a',64),'running')`, [runId, input.scope.tenantId, principalId]);
    await fixture.runtime.query(`INSERT INTO data_sync_run_sources(run_id,tenant_id,principal_id,source_id,status,job_id,message,can_retry)
      VALUES($1,$2,$3,'users','running',$4,'Synthetic source-job completion proof',false)`, [runId, input.scope.tenantId, principalId, jobId]);
    await fixture.runtime.query(`INSERT INTO data_sync_source_jobs(run_id,tenant_id,principal_id,source_id,attempt,job_id)
      VALUES($1,$2,$3,'users',1,$4)`, [runId, input.scope.tenantId, principalId, jobId]);
    const work = async (lease: Parameters<UserSourceStages["directory"]>[0]) => {
      const key = await stages.query(lease, "discovery", "transaction-job-proof");
      await stages.directory(lease, key, [sourceUser(firstId)]);
      await stages.finishQuery(lease, key);
    };
    await expect(stages.execute(input, work, { beforePublish: async () => {} })).rejects.toThrow("data_job_completion_required");
    const good = await stages.execute(input, work, { beforePublish: async () => {}, completeJob: async (client, result) => {
      expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("read committed");
      expect(result).toMatchObject({ source: "directory", runId, jobId, rows: 1 });
      expect((await client.query("SELECT state FROM data_generations WHERE id=$1", [result.generationId])).rows[0].state).toBe("published");
      await client.query("UPDATE data_sync_run_sources SET count=$2 WHERE run_id=$1 AND source_id='users'", [runId, result.rows]);
    } });
    await expect(stages.execute(input, work, { beforePublish: async () => {}, completeJob: async client => {
      await client.query("UPDATE data_sync_run_sources SET count=99 WHERE run_id=$1", [runId]);
      throw new Error("synthetic-job-commit-failure");
    } })).rejects.toThrow("synthetic-job-commit-failure");
    expect((await fixture.runtime.query("SELECT count FROM data_sync_run_sources WHERE run_id=$1", [runId])).rows[0].count).toBe(1);
    expect((await fixture.runtime.query("SELECT generation_id FROM data_generation_heads WHERE scope_id=$1", [good.scopeId])).rows[0].generation_id).toBe(good.generationId);
  });

  it("rejects missing query evidence, oversized batches and evidence reservations without publishing", async () => {
    const stages = new UserSourceStages(fixture.runtime);
    const input = generationInput({ scope: { ...generationInput().scope, principalId: "stage-limits" } });
    await expect(stages.execute({ ...input, deadlineAt: new Date(Date.now() + 3_600_000) }, async () => {},
      { beforePublish: async () => {} })).rejects.toMatchObject({ code: "user_source_deadline" });
    await expect(stages.execute(input, async () => {}, { beforePublish: async () => {} })).rejects.toMatchObject({ code: "provider_schema" });
    await expect(stages.execute(input, lease => stages.identities(lease, Array(251).fill("hidden")),
      { beforePublish: async () => {} })).rejects.toMatchObject({ code: "data_batch_rows" });
    await expect(stages.execute({ ...input, reserveBytes: 10 }, lease => stages.identities(lease, [firstId]),
      { beforePublish: async () => {} })).rejects.toMatchObject({ code: "data_generation_bytes", details: { limit: 10 } });
    expect((await fixture.runtime.query(`SELECT count(*)::int AS n FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
      WHERE s.principal_id=$1 AND g.state IN ('published','staging','validating')`, [input.scope.principalId])).rows[0].n).toBe(0);
  });

  it("backpressures streaming CSV while the consumer pauses and cancels its unread body", async () => {
    const header = Buffer.from(reportHeaders.join(",") + "\n");
    const line = Buffer.from(csv().split("\n")[1] + "\n");
    let rows = -1;
    let cancelled = false;
    const response = new Response(new ReadableStream({ pull(controller) {
      if (++rows === 0) controller.enqueue(header);
      else if (rows <= 10000) controller.enqueue(line);
      else controller.close();
    }, cancel() { cancelled = true; } }));
    const source = streamAppActivity(response, new AbortController().signal);
    expect((await source.next()).done).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(rows * line.length).toBeLessThan(40 * 1024);
    await source.return();
    await new Promise(resolve => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });
});
