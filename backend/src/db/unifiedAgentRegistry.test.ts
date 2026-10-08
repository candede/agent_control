import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import {
  inventoryInput, inventorySelectionFixture, nativeInventoryFixture, reconcileInventoryFixture, streamedPackageFixture,
} from "../../scripts/inventoryFixtures.js";
import { AuditLog } from "../services/auditLog.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { inventoryPresentation } from "../services/inventoryPresentation.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { LiveInventory } from "./liveInventory.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";

type Scope = { tenantId: string; principalId: string };
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); }, 60_000);
afterAll(async () => { await fixture?.close(); });
const nativeGuid = "abcdefab-1234-4567-89ab-abcdefabcdef";
const otherGuid = "bbbbbbbb-1234-4567-89ab-abcdefabcdef";
const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const newScope = (): Scope => ({ tenantId: `registry-${randomUUID()}`, principalId: randomUUID() });
const packageValue = (id: string, nativeId?: string): CopilotPackageDetail => allowlistedPackage({
  id, displayName: "Equal display name", isBlocked: false, version: "1",
  elementTypes: ["AgentMetadatas"],
  elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "identity", definition: JSON.stringify({
    ...(nativeId ? { SourceIds: { EnvironmentId: environmentId, CdsBotId: nativeId } } : {}),
    description: "Private provider payload",
  }) }] }],
});
const nativeValue = (nativeId = nativeGuid, environment = environmentId) => ({
  nativeId, environmentId: environment, displayName: "Equal display name",
  identifiers: [{ kind: "environment_id" as const, value: environment }, { kind: "cds_bot_id" as const, value: nativeId }],
  details: { description: "Private provider payload", isQuarantined: false },
});
async function publish(scope: Scope, values: CopilotPackageDetail[], natives = [nativeValue()]) {
  await streamedPackageFixture(fixture.runtime, scope, values, { exact: true });
  await nativeInventoryFixture(fixture.runtime, scope, natives, { resourceTypes: ["microsoft.copilotstudio/agents"] });
  await reconcileInventoryFixture(fixture.runtime, scope);
  return selected(scope);
}
async function selected(scope: Scope) {
  const result = await inventorySelectionFixture(fixture.runtime, scope);
  return { ...result, page: inventoryPresentation(result.raw) };
}
async function membership(scope: Scope) {
  return (await fixture.runtime.query(`SELECT r.identity,r.generation_id,m.source_scope_id,m.source_identity,
    source.domain,source.native_id,source.environment_id,r.residual
    FROM inventory_roots root JOIN data_scope_epochs scope ON scope.id=root.scope_id
    JOIN inventory_memberships members ON members.baseline_id=root.baseline_id AND members.valid_from_revision<=root.revision
      AND (members.valid_to_revision IS NULL OR members.valid_to_revision>root.revision)
    JOIN unified_agent_rows r ON r.generation_id=members.generation_id AND r.identity=members.identity
    JOIN unified_agent_memberships m ON m.generation_id=r.generation_id AND m.identity=r.identity
    JOIN inventory_records source ON source.generation_id=m.source_generation_id AND source.identity=m.source_identity
    WHERE root.current AND root.domain='canonical' AND scope.tenant_id=$1 AND scope.principal_id=$2
    ORDER BY source.domain,source.native_id,source.environment_id`, [scope.tenantId, scope.principalId])).rows;
}

describe("typed canonical identity registry", () => {
  it("derives many opaque package memberships without copying provider bodies into canonical storage", async () => {
    const scope = newScope(), ids = ["Graph/Alpha:%", "Graph/alpha:%", nativeGuid, nativeGuid.toUpperCase()];
    const result = await publish(scope, ids.map(id => packageValue(id, nativeGuid)));
    expect(result.page.counts.total).toBe(1);
    const record = result.page.value[0];
    expect(record.id).toMatch(/^agent:[0-9a-f-]{36}$/);
    expect(record.presence).toBe("both");
    const stored = await membership(scope);
    expect(stored).toHaveLength(5);
    expect(new Set(stored.map(row => row.identity))).toEqual(new Set([record.id.slice(6)]));
    expect(stored.filter(row => row.domain === "packages").map(row => row.native_id).sort()).toEqual([...ids].sort());
    expect(JSON.stringify(stored.map(row => row.residual))).not.toContain("Private provider payload");
    const first = await result.queries.members(result.selection.id, result.identity, record.id.slice(6), { limit: 2 });
    expect(first.value).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await result.queries.members(result.selection.id, result.identity, record.id.slice(6),
      { limit: 2, cursor: first.nextCursor! });
    expect(second.value).toHaveLength(2);
    expect(new Set([...first.value, ...second.value].map(row => JSON.stringify([row.source_scope_id, row.source_identity]))).size).toBe(4);
  });

  it("preserves IDs through source order, new generations and normalized native GUID casing", async () => {
    const scope = newScope();
    const first = await publish(scope, [packageValue("a", nativeGuid), packageValue("b", nativeGuid), packageValue("c")]);
    const firstMembers = await membership(scope);
    const ids = new Map(firstMembers.filter(row => row.domain === "packages").map(row => [row.native_id, row.identity]));
    const next = await publish(scope, [packageValue("c"), packageValue("b", nativeGuid), packageValue("a", nativeGuid)],
      [nativeValue(nativeGuid.toUpperCase(), environmentId.toUpperCase())]);
    expect(next.page.counts.total).toBe(2);
    for (const row of (await membership(scope)).filter(row => row.domain === "packages")) expect(row.identity).toBe(ids.get(row.native_id));
    const stored = await membership(scope);
    expect(stored.find(row => row.domain === "power_platform")).toMatchObject({
      native_id: nativeGuid.toUpperCase(), environment_id: environmentId.toUpperCase(),
    });
    await next.queries.page(next.selection.id, next.identity);
    expect(await membership(scope)).toEqual(stored);
    expect((await first.queries.page(first.selection.id, first.identity)).counts.total).toBe(2);
  });

  it.each(["oldest", "uuid"] as const)("chooses the deterministic %s survivor on a real provider-evidence merge", async preference => {
    const scope = newScope();
    const first = await publish(scope, [packageValue("a"), packageValue("b", nativeGuid)]);
    expect(first.page.counts.total).toBe(2);
    const ids = [...new Set((await membership(scope)).map(row => row.identity))].sort();
    const expected = preference === "uuid" ? ids[0] : ids[1];
    await fixture.operator.query(`UPDATE inventory_canonical_ids ids SET created_at=
      CASE WHEN ids.id=$3 THEN '2000-01-01'::timestamptz ELSE $4::timestamptz END
      FROM data_scope_epochs scope WHERE scope.id=ids.scope_id AND scope.tenant_id=$1 AND scope.principal_id=$2`,
    [scope.tenantId, scope.principalId, expected,
      preference === "uuid" ? "2000-01-01" : "2001-01-01"]);
    const next = await publish(scope, [packageValue("b", nativeGuid), packageValue("a", nativeGuid)]);
    expect(next.page.value.map(row => row.id)).toEqual([`agent:${expected}`]);
    expect(new Set((await membership(scope)).map(row => row.identity))).toEqual(new Set([expected]));
  });

  it("splits withdrawn matching evidence without borrowing one UUID twice or matching equal names", async () => {
    const scope = newScope();
    const first = await publish(scope, [packageValue("a", nativeGuid), packageValue("b", nativeGuid)]);
    const next = await publish(scope, [packageValue("a"), packageValue("b", nativeGuid)]);
    expect(next.page.counts.total).toBe(2);
    expect(new Set(next.page.value.map(row => row.id)).size).toBe(2);
    expect(next.page.value.filter(row => row.id === first.page.value[0].id)).toHaveLength(1);
    expect(next.page.value.map(row => row.presence).sort()).toEqual(["both", "graph_packages"]);
    expect((await first.queries.page(first.selection.id, first.identity)).counts.total).toBe(1);
  });

  it("retains both prior UUIDs across simultaneous source merge and split", async () => {
    const scope = newScope();
    const first = await publish(scope, [packageValue("a", nativeGuid), packageValue("b", nativeGuid), packageValue("c", otherGuid)],
      [nativeValue(nativeGuid), nativeValue(otherGuid)]);
    const next = await publish(scope, [packageValue("a", otherGuid), packageValue("b", nativeGuid), packageValue("c", nativeGuid)],
      [nativeValue(nativeGuid), nativeValue(otherGuid)]);
    expect(next.page.value.map(row => row.id).sort()).toEqual(first.page.value.map(row => row.id).sort());
    const rows = await membership(scope);
    for (const id of new Set(rows.map(row => row.identity))) expect(rows.filter(row => row.identity === id && row.domain === "power_platform")).toHaveLength(1);
  });

  it("removes complete-view membership, preserves read pins, and closes current authority before reconciliation", async () => {
    const scope = newScope(), first = await publish(scope, [packageValue("a", nativeGuid)]);
    const id = first.page.value[0].id;
    await streamedPackageFixture(fixture.runtime, scope, []);
    await nativeInventoryFixture(fixture.runtime, scope, [], { resourceTypes: ["microsoft.copilotstudio/agents"] });
    await expect(new LiveInventory(fixture.runtime).record(scope, id)).rejects.toMatchObject({ code: "agent_not_found" });
    expect((await first.queries.page(first.selection.id, first.identity)).counts.total).toBe(1);
    await reconcileInventoryFixture(fixture.runtime, scope);
    expect((await selected(scope)).page.counts.total).toBe(0);
    expect(await membership(scope)).toEqual([]);
  });

  it.each(["Graph", "native"] as const)("does not reuse an opaque %s source identity after a case-only replacement", async domain => {
    const scope = newScope();
    const first = await publish(scope, domain === "Graph" ? [packageValue("Opaque")] : [],
      domain === "native" ? [{ ...nativeValue("Opaque"), identifiers: [] }] : []);
    const next = await publish(scope, domain === "Graph" ? [packageValue("opaque")] : [],
      domain === "native" ? [{ ...nativeValue("opaque"), identifiers: [] }] : []);
    expect(next.page.counts.total).toBe(1);
    expect(next.page.value[0].id).not.toBe(first.page.value[0].id);
  });

  it("isolates canonical UUIDs, source selections and live references across principal and tenant", async () => {
    const scopes = [newScope(), newScope()];
    scopes.push({ ...scopes[0], principalId: "other-principal" });
    const saved = [];
    for (const scope of scopes) saved.push(await publish(scope, [packageValue("shared", nativeGuid)]));
    expect(new Set(saved.map(value => value.page.value[0].id)).size).toBe(3);
    for (let index = 0; index < scopes.length; index++) {
      for (let other = 0; other < scopes.length; other++) if (index !== other) {
        await expect(saved[index].queries.page(saved[other].selection.id, saved[index].identity))
          .rejects.toMatchObject({ code: "selection_invalidated" });
        await expect(new LiveInventory(fixture.runtime).record(scopes[index], saved[other].page.value[0].id))
          .rejects.toMatchObject({ code: "agent_not_found" });
      }
    }
  });

  it("keeps compaction content-addressed and retains canonical identity through subsequent refresh", async () => {
    const scope = newScope(), first = await publish(scope, [packageValue("a", nativeGuid)]);
    const before = await membership(scope);
    const root = (await fixture.runtime.query(`SELECT r.scope_id AS "scopeId",r.tenant_id AS "tenantId",
      r.baseline_id AS "baselineId",r.revision,s.epoch FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
      WHERE r.current AND r.domain='canonical' AND s.tenant_id=$1 AND s.principal_id=$2`,
    [scope.tenantId, scope.principalId])).rows[0];
    const input = inventoryInput(scope.principalId, "canonical"); input.scope.tenantId = scope.tenantId;
    await new InventoryGenerations(fixture.runtime).compact(input, root, { authorize: async () => {} });
    expect(await membership(scope)).toEqual(before);
    const next = await publish(scope, [packageValue("a", nativeGuid)]);
    expect(next.page.value[0].id).toBe(first.page.value[0].id);
    expect((await first.queries.page(first.selection.id, first.identity)).value).toEqual(first.raw.value);
  });

  it("does not authorize a historical canonical selection after a newer exact omission", async () => {
    const scope = newScope(), first = await publish(scope, [packageValue("a")], []);
    const reference = unifiedAgentRecordId({ source: "graph_packages", packageId: "a" });
    expect((await new LiveInventory(fixture.runtime).record(scope, reference)).id).toBe(first.page.value[0].id);
    await streamedPackageFixture(fixture.runtime, scope, []);
    await expect(new LiveInventory(fixture.runtime).record(scope, first.page.value[0].id)).rejects.toMatchObject({ code: "agent_not_found" });
    expect((await first.queries.exact(first.selection.id, first.identity, [first.page.value[0].id.slice(6)]))).toHaveLength(1);
  });

  it("resolves selected native GUID aliases case-insensitively while retaining distinct opaque native IDs", async () => {
    const scope = newScope();
    const result = await publish(scope, [], [
      nativeValue(nativeGuid.toUpperCase(), environmentId.toUpperCase()),
      nativeValue("Opaque/Native"), nativeValue("opaque/native"),
    ]);
    for (const nativeId of [nativeGuid, nativeGuid.toUpperCase(), "Opaque/Native", "opaque/native"]) {
      const recordId = `power_platform:${environmentId.toUpperCase()}:${encodeURIComponent(nativeId)}`;
      const selected = inventoryPresentation(await result.queries.page(result.selection.id, result.identity, { recordId, limit: 2 }));
      expect(selected.value).toHaveLength(1);
      const expected = result.page.value.find(row => row.powerPlatformResource?.nativeId
        === (nativeId.toLowerCase() === nativeGuid ? nativeGuid.toUpperCase() : nativeId))!;
      expect(selected.value[0].id).toBe(expected.id);
      expect((await new LiveInventory(fixture.runtime).record(scope, recordId)).id).toBe(expected.id);
    }
    const wrongEnvironment = inventoryPresentation(await result.queries.page(result.selection.id, result.identity, {
      recordId: `power_platform::${nativeGuid}`, limit: 2,
    }));
    expect(wrongEnvironment.value).toEqual([]);
  });

  it("admits unified export audit events only with null blocked state", async () => {
    const scope = newScope(), audit = new AuditLog(scope, fixture.runtime);
    const started = await audit.startEvent({
      operationId: `export-agent-inventory:${randomUUID()}`, action: "export-agent-inventory", scope: "bulk",
      agentId: "agent-inventory", requestPath: "/api/data/exports",
      actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
      metadata: { source: "unified_agents" },
    });
    expect(started).toMatchObject({ action: "export-agent-inventory", status: "started" });
    expect(started).not.toHaveProperty("targetBlockedState");
    await expect(audit.completeEvent(started.id, { status: "succeeded" })).resolves.toMatchObject({ status: "succeeded" });
    for (const state of [true, false]) await expect(appendAuditEvent(fixture.runtime, scope, "export-agent-inventory", state))
      .rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_state" });
    for (const action of ["block", "unblock"]) await expect(appendAuditEvent(fixture.runtime, scope, action, null))
      .rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_state" });
    await expect(appendAuditEvent(fixture.runtime, scope, "unknown-export", null))
      .rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_check" });
  });
});

function appendAuditEvent(database: pg.Pool, scope: Scope, action: string, blockedState: boolean | null) {
  return database.query(`INSERT INTO audit_events(
    id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,
    agent_id,started_at,status,request_path)
    VALUES(gen_random_uuid(),gen_random_uuid()::text,gen_random_uuid()::text,$1,$2,'fixture@example.invalid',
      'Fixture','bulk',$3,$4,'fixture',clock_timestamp(),'succeeded','/fixture')`,
  [scope.tenantId, scope.principalId, action, blockedState]);
}
