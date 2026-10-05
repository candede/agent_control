import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { generationInput, selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { canonicalQuery, DataSelections } from "./dataSelections.js";
import { DataExports, type ExportAudit, type ExportKind } from "./dataExports.js";
import { retainRecordData } from "../db/dataRetention.js";

describe("all artifact producer lifecycle contracts", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); });
  afterAll(async () => { await fixture?.close(); });
  async function setup(kind: ExportKind) {
    const identity = { ...selectionIdentity, tenantId: `exports-${randomUUID()}` };
    const generations = new DataGenerations(fixture.runtime), selections = new DataSelections(fixture.runtime);
    const lease = await generations.begin(generationInput({ scope: { ...generationInput().scope, tenantId: identity.tenantId } }));
    await generations.validate(lease, { rows: 0, children: 0, batches: 0, pages: 0, wireRows: 0 });
    await generations.publish(lease);
    const selection = await selections.capture(identity, "/fixture", { values: {}, allowed: [] }, [{
      kind: "generation", scopeId: lease.scopeId, generationId: lease.id, revision: "1", expiresAt: new Date(Date.now() + 600_000),
    }]);
    const events: Parameters<ExportAudit>[1][] = [];
    const engine = new DataExports(fixture.runtime, selections, async (_client, event) => { events.push(event); });
    const input = { selectionId: selection.id, queryHash: canonicalQuery({}, []), kind, filename: "fixture.csv", idempotencyKey: randomUUID() };
    return { identity, lease, generations, selections, selection, engine, events, input };
  }
  it.each<ExportKind>(["copilot_users", "official_agents", "official_users", "graph_packages", "power_platform_agents", "unified_agents"])(
    "%s releases the database during backpressure and never succeeds after source deletion", async kind => {
      const { identity, lease, generations, engine, events, input } = await setup(kind);
      const id = await engine.create(identity, input);
      await engine.build(id, identity, ["Name"], async function* () {
        for (let i = 0; i < 4; i++) yield [{ Name: "界".repeat(60_000) }];
      });
      const iterator = engine.download(id, identity, new AbortController().signal);
      expect((await iterator.next()).value?.length).toBe(262_144);
      expect(fixture.runtime.totalCount - fixture.runtime.idleCount).toBe(0);
      await generations.invalidate(lease.scopeId, identity.tenantId);
      await expect(iterator.next()).rejects.toMatchObject({ code: "selection_invalidated" });
      expect(events.filter(event => event.phase === "download").map(event => event.status)).toEqual(["started", "failed"]);
      expect(events.at(-1)?.bytes).toBe(262_144);
        expect(events.at(-1)?.checksum).toMatch(/^[a-f0-9]{64}$/);
      await expect(engine.download(id, identity, new AbortController().signal).next()).rejects.toMatchObject({ code: "selection_invalidated" });
    });
  it("reuses one immutable creation on retry, rejects changed intent, and cancels only once", async () => {
    const { identity, engine, events, input } = await setup("copilot_users");
    const ids = await Promise.all([engine.create(identity, input), engine.create(identity, input)]);
    expect(ids[0]).toBe(ids[1]);
    expect(events).toHaveLength(1);
    await expect(engine.create(identity, { ...input, idempotencyKey: "-".repeat(36) })).rejects.toMatchObject({ status: 400 });
    await expect(engine.create(identity, { ...input, ids: ["changed"] })).rejects.toMatchObject({ code: "export_idempotency_conflict" });
    await engine.cancel(ids[0], identity);
    await engine.cancel(ids[0], identity);
    expect(events.map(event => event.status)).toEqual(["started", "failed"]);
    expect(await engine.create(identity, input)).toBe(ids[0]);
    expect((await engine.status(ids[0], identity)).status).toBe("cancelled");
  });
  it("expires invalidated export ownership and releases its pins without waiting for artifact expiry", async () => {
    const { identity, selection, generations, engine, input } = await setup("official_users");
    const peer = await setup("official_users");
    const id = await engine.create(identity, input), other = await peer.engine.create(peer.identity, peer.input);
    await engine.build(id, identity, ["Name"], async function* () { yield [{ Name: "private" }]; });
    await peer.engine.build(other, peer.identity, ["Name"], async function* () { yield [{ Name: "unaffected" }]; });
    await fixture.operator.query("UPDATE data_read_selections SET invalidated_at=clock_timestamp() WHERE id=$1", [selection.id]);
    expect(await engine.expire(id)).toBe(1);
    expect(await engine.expire(id)).toBe(0);
    for (let index = 0; index < 8; index++) await generations.connections.run(client => retainRecordData(client));
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM data_generation_pins WHERE selection_id=$1", [selection.id])).rows[0].n).toBe(0);
    expect((await peer.engine.status(other, peer.identity)).status).toBe("ready");
  });
  it.each(["disconnect", "role-loss", "expiry"] as const)("audits %s after a partial native stream", async mode => {
    const { identity, generations, engine, events, input } = await setup("unified_agents");
    const id = await engine.create(identity, input);
    await engine.build(id, identity, ["Name"], async function* () { yield [{ Name: "x".repeat(300_000) }]; });
    const controller = new AbortController(), iterator = engine.download(id, identity, controller.signal);
    await iterator.next();
    if (mode === "disconnect") controller.abort(new Error("disconnected"));
    if (mode === "role-loss") await generations.revokePrincipal(identity.tenantId, identity.principalId);
    if (mode === "expiry") await fixture.operator.query("UPDATE data_exports SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await expect(iterator.next()).rejects.toThrow();
    expect(events.filter(event => event.phase === "download").map(event => event.status)).toEqual(["started", "failed"]);
  });
});
