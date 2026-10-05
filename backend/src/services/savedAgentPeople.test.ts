import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { fixtureDirectoryUser, publishFixtureDirectory } from "../../scripts/userSourceFixture.js";
import { dataConnections } from "../db/dataConnections.js";
import { UserSourcesRepository } from "../db/userSources.js";
import { agentColumnValue } from "../types/agentPresentation.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { SavedAgentPeopleService } from "./savedAgentPeople.js";

vi.hoisted(() => { process.env.SESSION_SECRET = "saved-people-synthetic-session-secret"; });

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function record(tenantId: string, ownerId = firstId, createdBy: string | null = firstId, lastModifiedBy = firstId): UnifiedAgentRecord {
  return {
    id: `agent:${randomUUID()}`, displayName: "Agent", presence: "power_platform", environmentId: "environment", packages: [],
    powerPlatformResource: {
      tenantId, nativeId: "native", type: "microsoft.copilotstudio/agents", environmentId: "environment", location: null,
      displayName: "Agent", createdAt: null, createdBy, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null,
      creatorType: "unknown", agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native",
      identifiers: [], provenance: {}, details: { ownerId, lastModifiedBy }, unknownFieldCount: 0,
    },
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
  };
}

describe("saved exact-ID agent people projection", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30000);
  afterAll(async () => { await fixture?.close(); });
  afterEach(() => vi.restoreAllMocks());
  function harness() {
    const identity = { ...selectionIdentity, tenantId: "saved-exact-people", principalId: randomUUID() };
    const service = new SavedAgentPeopleService(fixture.runtime), sources = new UserSourcesRepository(fixture.runtime, "synthetic-exact-people-secret-0000000");
    return { identity, service, sources, directory: (users: Parameters<typeof publishFixtureDirectory>[2], options?: Parameters<typeof publishFixtureDirectory>[3]) =>
      publishFixtureDirectory(fixture.runtime, identity, users, options) };
  }

  it("projects only exact case-normalized IDs on the caller's repeatable-read client, without provider calls or inventory mutation", async () => {
    const h = harness(), observedAt = new Date(Date.now() - 60000), provider = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider calls forbidden"));
    await h.directory([fixtureDirectoryUser(firstId)], { observedAt });
    const native = record(h.identity.tenantId, firstId.toUpperCase(), firstId, firstId.toUpperCase());
    await dataConnections(fixture.runtime).selectedRead(async client => {
      const query = vi.spyOn(client, "query"), pool = vi.spyOn(fixture.runtime, "query").mockRejectedValue(new Error("Use the supplied snapshot"));
      try {
        const [result] = await h.service.project(h.identity, [native], client);
        expect(result.people).toEqual({
          owner: { objectId: firstId, displayName: "Saved person", userPrincipalName: "person@example.invalid", observedAt: observedAt.toISOString() },
          createdBy: result.people?.owner, lastModifiedBy: result.people?.owner,
        });
        expect(result.people?.owner).toBe(result.people?.createdBy);
        expect(result.people?.owner).toBe(result.people?.lastModifiedBy);
        expect(result.powerPlatformResource).toBe(native.powerPlatformResource);
        expect(result.identity).toBe(native.identity); expect(result.packages).toBe(native.packages);
        expect(native.people).toBeUndefined();
        const exact = query.mock.calls.filter(([sql]) => String(sql).includes("FROM unnest($4::text[])"));
        expect(exact).toHaveLength(1); expect(exact[0][1]?.[3]).toEqual([firstId]);
        expect(query.mock.calls.filter(([sql]) => String(sql).includes("current_setting('transaction_isolation')"))).toHaveLength(1);
      } finally { pool.mockRestore(); query.mockRestore(); }
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([null, "Guest#EXT#@example.onmicrosoft.com"])("retains nullable cached UPNs and exact guest directory UPNs: %s", async upn => {
    const h = harness();
    if (upn === null) {
      await h.sources.capture(h.identity, "delegated");
      await h.sources.savePeople(h.identity, [{ objectId: firstId, displayName: "Known name", userPrincipalName: null,
        status: "resolved", checkedAt: new Date().toISOString() }], async () => {});
    } else await h.directory([fixtureDirectoryUser(firstId, "Known name", upn)]);
    const [value] = await h.service.project(h.identity, [record(h.identity.tenantId)]);
    expect(value.people?.owner).toMatchObject({ objectId: firstId, displayName: "Known name", userPrincipalName: upn });
    expect(agentColumnValue(value, "owner")).toContain("Known name");
  });

  it.each([true, false])("preserves the newest known directory identity after failed lookup with older cached evidence=%s", async cached => {
    const h = harness(), observedAt = new Date(Date.now() - 60000);
    await h.directory([fixtureDirectoryUser(firstId)], { observedAt });
    if (cached) await h.sources.savePeople(h.identity, [{ objectId: firstId, status: "resolved", displayName: "Old name",
      userPrincipalName: null, checkedAt: new Date(observedAt.getTime() - 60000).toISOString() }], async () => {});
    await h.sources.savePeople(h.identity, [{ objectId: firstId, status: "lookup_failed", displayName: null, userPrincipalName: null,
      checkedAt: new Date().toISOString(), errorCode: "provider_timeout" }], async () => {});
    expect((await h.service.project(h.identity, [record(h.identity.tenantId)]))[0].people?.owner).toMatchObject({
      displayName: "Saved person", observedAt: observedAt.toISOString(), status: "lookup_failed", errorCode: "provider_timeout",
    });
  });

  it("lets newer conclusive not-found clear roster names and resolves an unlicensed cached creator without any directory row", async () => {
    const h = harness();
    await h.directory([fixtureDirectoryUser(firstId)], { observedAt: new Date(Date.now() - 60000) });
    await h.sources.savePeople(h.identity, [
      { objectId: firstId, status: "not_found", displayName: null, userPrincipalName: null, checkedAt: new Date().toISOString() },
      { objectId: secondId, status: "resolved", displayName: "Unlicensed creator", userPrincipalName: null, checkedAt: new Date().toISOString() },
    ], async () => {});
    const [value] = await h.service.project(h.identity, [record(h.identity.tenantId, firstId, secondId)]);
    expect(value.people?.owner).toMatchObject({ status: "not_found", displayName: null });
    expect(value.people?.createdBy).toMatchObject({ displayName: "Unlicensed creator", userPrincipalName: null });
  });

  it("does not guess from names, UPNs, report identities, partial GUIDs or another tenant/principal/token mode", async () => {
    const h = harness();
    for (const identity of [{ ...h.identity, tenantId: "other-tenant" }, { ...h.identity, principalId: "other-principal" }]) {
      await publishFixtureDirectory(fixture.runtime, identity, [fixtureDirectoryUser(firstId)]);
    }
    await h.directory([fixtureDirectoryUser(firstId)], { tokenMode: "application" });
    const native = record(h.identity.tenantId);
    expect((await h.service.project(h.identity, [native]))[0].people).toBeUndefined();
    await h.directory([fixtureDirectoryUser(firstId)]);
    const records = [record(h.identity.tenantId, "Saved person", "person@example.invalid", firstId.slice(1)),
      record(h.identity.tenantId, secondId, null, `{${firstId}}`),
      { ...native, powerPlatformResource: null, presence: "graph_packages" as const }];
    expect((await h.service.project(h.identity, records)).every(value => value.people === undefined)).toBe(true);
  });

  it("removes stale attached people after a complete empty replacement without removing native identifiers", async () => {
    const h = harness();
    await h.directory([fixtureDirectoryUser(firstId)]);
    const [enriched] = await h.service.project(h.identity, [record(h.identity.tenantId)]);
    expect(enriched.people?.owner).toBeDefined();
    await h.directory([]);
    const [result] = await h.service.project(h.identity, [enriched]);
    expect(result.people).toBeUndefined();
    expect(result.powerPlatformResource?.details.ownerId).toBe(firstId);
    expect(result.id).toBe(enriched.id);
  });

  it("projects one caller page with three exact IDs per row using only 100-ID reads and one captured snapshot", async () => {
    const h = harness(), rows = Array.from({ length: 100 }, () => record(h.identity.tenantId, randomUUID(), randomUUID(), randomUUID()));
    await dataConnections(fixture.runtime).selectedRead(async client => {
      const query = vi.spyOn(client, "query");
      try {
        expect(await h.service.project(h.identity, rows, client)).toHaveLength(100);
        const exact = query.mock.calls.filter(([sql]) => String(sql).includes("FROM unnest($4::text[])"));
        expect(exact).toHaveLength(3);
        expect(exact.map(call => call[1]?.[3].length)).toEqual([100, 100, 100]);
        expect(new Set(exact.map(call => (call[1]?.[4] as Date).toISOString())).size).toBe(1);
      } finally { query.mockRestore(); }
    });
    await expect(h.service.project(h.identity, [...rows, rows[0]])).rejects.toMatchObject({ code: "data_page_limit" });
    await expect(h.service.read(h.identity, Array.from({ length: 101 }, () => randomUUID()))).rejects.toThrow("100");
  });

  it("rejects a cross-tenant inventory record before reading and rejects a caller transaction weaker than repeatable read", async () => {
    const h = harness(), query = vi.spyOn(fixture.runtime, "query");
    await expect(h.service.project(h.identity, [record("other-tenant")])).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(query).not.toHaveBeenCalled(); query.mockRestore();
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      await expect(h.service.project(h.identity, [record(h.identity.tenantId)], client)).rejects.toThrow("people_selected_snapshot_required");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("propagates exact evidence-read failures instead of disguising them as unknown people", async () => {
    const h = harness(), failure = new Error("Saved people database unavailable");
    vi.spyOn(fixture.runtime, "connect").mockRejectedValueOnce(failure);
    await expect(h.service.project(h.identity, [record(h.identity.tenantId)])).rejects.toBe(failure);
  });
});
