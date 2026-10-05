import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { seedReportSet } from "../../scripts/officialReportFixtures.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficialReportHistory, readableHistorySql } from "./officialReportHistory.js";
import { DataSelections } from "../services/dataSelections.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { OfficialReportExports } from "../services/officialReportExports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { randomUUID } from "node:crypto";
import { retainUntilConverged } from "../../scripts/database.js";
import { verifySchema } from "./schema.js";

describe("live relational official history selection", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("pins 32 retained sets with one root and preserves acceptance continuity", async () => {
    const identity = { ...selectionIdentity, tenantId: "history-32", principalId: "viewer-not-importer" };
    const history = new OfficialReportHistory(fixture.runtime);
    await history.ensure(identity.tenantId);
    let first = "";
    for (let n = 0; n < 32; n++) {
      const set = await seedReportSet(fixture.operator, identity.tenantId, n);
      first ||= set.id;
      await history.connections.run(client => history.accepted(client, identity.tenantId, set.id));
    }
    const selections = new DataSelections(fixture.runtime, (client, root, who) => history.validateRoot(client, root, who));
    const captured = await selections.captureWith(identity, "/history", { values: {}, allowed: [] }, async (client, now) => ({
      roots: [await history.root(client, identity.tenantId, now)],
    }));
    const count = () => selections.read(captured.id, identity, async (client, selected) => {
      expect(selected.pins).toHaveLength(1);
      return Number((await client.query(`SELECT count(*) AS count FROM (${readableHistorySql}) history`,
        [identity.tenantId, selected.pins[0].revision])).rows[0].count);
    });
    expect(await count()).toBe(32);
    const extra = await seedReportSet(fixture.operator, identity.tenantId, 32);
    await history.connections.run(client => history.accepted(client, identity.tenantId, extra.id));
    expect(await count()).toBe(32);
    await history.connections.run(client => history.invalidate(client, identity.tenantId, first, true));
    await expect(count()).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await history.collect(identity.tenantId)).toBe(0);
    await expect(fixture.runtime.query("UPDATE official_usage_history_state SET revision=0 WHERE tenant_id=$1", [identity.tenantId])).rejects.toThrow("official_history_state_immutable");
  });
  it("collects unreferenced report facts through the current bounded operator", async () => {
    const tenant = "history-collector";
    await verifySchema(fixture.runtime);
    expect((await fixture.runtime.query(`SELECT
      has_table_privilege(current_user,'official_usage_row_facts','DELETE') AS allowed`)).rows[0].allowed).toBe(false);
    for (const username of ["first", "second"]) {
      const row = { username, displayName: "Name", agentResponsesReceived: 1, numberOfAgentsUsed: 1 };
      await fixture.operator.query(`INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at,
        identity_key,username,display_name,responses,agents_used) VALUES($1,'users',official_usage_payload_hash($2::jsonb),$2::jsonb,clock_timestamp(),
          $3,$3,'Name',1,1)`, [tenant, JSON.stringify(row), username]);
    }
    await retainUntilConverged(fixture.operator);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM official_usage_row_facts WHERE tenant_id=$1", [tenant])).rows[0].count).toBe(0);
  }, 30_000);

  it("allows deleting an incomplete import but never selecting it", async () => {
    const identity = { ...selectionIdentity, tenantId: "history-partial-delete" }, imports = new OfficialReportImports(fixture.runtime);
    async function* csv() { yield Buffer.from(`${schemaRegistry.users.headers.join(",")}\nuser,User,1,1,\n`); }
    const stage = await imports.stage(identity, { bundleId: randomUUID() }, csv());
    const partial = await imports.accept(identity, { stagingId: stage.id, revision: stage.revision,
      contentHash: stage.contentHash, expectedActiveRevision: stage.activeRevision });
    expect(partial.complete).toBe(false);
    await expect(imports.confirmPreview(identity, partial.setId, "select")).rejects.toBeInstanceOf(Error);
    await imports.confirm(identity, await imports.confirmPreview(identity, partial.setId, "delete"));
    expect((await fixture.runtime.query("SELECT deleted_at FROM official_usage_sets WHERE id=$1", [partial.setId])).rows[0].deleted_at).not.toBeNull();
  });

  it("drains abandoned staging over persisted byte-bounded slices before releasing its reservation", async () => {
    const identity = { ...selectionIdentity, tenantId: "history-staging-slices" };
    let imports = new OfficialReportImports(fixture.runtime);
    async function* csv() {
      yield Buffer.from(`${schemaRegistry.users.headers.join(",")}\n`);
      for (let index = 0; index < 76; index++) yield Buffer.from(`user${index},Name,1,1,\n`);
    }
    const stage = await imports.stage(identity, { bundleId: randomUUID() }, csv());
    const ingestion = (await fixture.runtime.query("SELECT id FROM official_usage_ingestions WHERE staging_id=$1", [stage.id])).rows[0].id;
    await imports.cancel(identity, ingestion);
    const retained = async () => (await fixture.runtime.query("SELECT stored_bytes::int AS bytes FROM official_usage_ingestions WHERE id=$1", [ingestion])).rows[0].bytes;
    expect(await retained()).toBeGreaterThan(0);
    imports = new OfficialReportImports(fixture.runtime);
    for (let index = 0; index < 12 && await retained(); index++) {
      const before = (await fixture.runtime.query("SELECT rows_collected,bytes_collected FROM data_lifecycle_progress WHERE worker='report_staging'")).rows[0];
      expect(await imports.sweep(identity.tenantId)).toBe(1);
      const after = (await fixture.runtime.query("SELECT rows_collected,bytes_collected FROM data_lifecycle_progress WHERE worker='report_staging'")).rows[0];
      expect(Number(after.rows_collected) - Number(before.rows_collected)).toBeLessThanOrEqual(1000);
      expect(Number(after.bytes_collected) - Number(before.bytes_collected)).toBeLessThanOrEqual(1_048_576);
    }
    expect(await retained()).toBe(0);
    expect(await imports.sweep(identity.tenantId)).toBe(0);
    expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM official_usage_ingestion_rows WHERE ingestion_id=$1", [ingestion])).rows[0].n).toBe(0);
  });

  it("revalidates target expiry when consuming a select confirmation", async () => {
    const identity = { ...selectionIdentity, tenantId: "history-confirm-expiry" }, imports = new OfficialReportImports(fixture.runtime);
    await imports.history.ensure(identity.tenantId);
    const bundleId = randomUUID();
    for (const kind of ["users", "agents", "userAgents"] as const) {
      async function* csv() { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n`); }
      await imports.stage(identity, { bundleId }, csv());
    }
    const set = await imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    expect(await imports.confirm(identity, await imports.confirmPreview(identity, set.setId, "select"))).toMatchObject({ activeSetId: set.setId });
    const confirmation = await imports.confirmPreview(identity, set.setId, "select");
    await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [set.setId]);
    await expect(imports.confirm(identity, confirmation)).rejects.toBeInstanceOf(Error);
    expect((await fixture.runtime.query("SELECT revision::text FROM official_usage_state WHERE tenant_id=$1", [identity.tenantId])).rows[0].revision).toBe(confirmation.activeRevision);
    expect((await fixture.runtime.query("SELECT consumed_at FROM official_usage_confirmations WHERE id=$1", [confirmation.id])).rows[0].consumed_at).toBeNull();
  });

  it.each(["correction", "delete", "expiry"] as const)("invalidates a non-active %s without changing the active head and prevents old exports", async operation => {
    const identity = { ...selectionIdentity, tenantId: `history-${operation}` }, imports = new OfficialReportImports(fixture.runtime);
    const reports = new LargeTenantUsersReports(fixture.runtime, "candidate-report-secret-never-production-000000", 30);
    const today = new Date().toISOString().slice(0, 10);
    const publish = async (count: number, correctionOfSetId?: string) => {
      const bundleId = randomUUID();
      const contents = { users: `user,User,1,${count},${today}`, agents: `agent,Agent,User,1,0,${count},${today}`,
        userAgents: `agent,Agent,User,user,${count},${today}` };
      for (const kind of ["users", "agents", "userAgents"] as const) {
        async function* stream() { yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${contents[kind]}\n`); }
        await imports.stage(identity, { bundleId, correctionOfSetId }, stream());
      }
      return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
    };
    const first = await publish(1), second = await publish(2);
    const viewer = { ...identity, principalId: "not-the-importer" };
    const selected = await reports.capture(viewer, "delegated", "official_agents");
    const history = await reports.capture(viewer, "delegated", "history");
    const exports = new OfficialReportExports(reports, { tenantId: viewer.tenantId, homeAccountId: viewer.principalId, username: "fixture@example.invalid", displayName: "Fixture" });
    const id = await exports.create(viewer, { selectionId: selected.id, kind: "official_agents" });
    await exports.build(id, viewer, "official_agents");
    const pending = await exports.create(viewer, { selectionId: selected.id, kind: "official_agents" });
    expect(await exports.engine.status(id, viewer)).toMatchObject({ status: "ready" });
    const before = (await fixture.runtime.query("SELECT active_set_id,revision FROM official_usage_state WHERE tenant_id=$1", [identity.tenantId])).rows[0];
    expect(before).toMatchObject({ active_set_id: second.setId });
    if (operation === "correction") await publish(3, first.setId);
    if (operation === "delete") await imports.confirm(identity, await imports.confirmPreview(identity, first.setId, "delete"));
    if (operation === "expiry") {
      await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [first.setId]);
      expect(await reports.history.expire(identity.tenantId)).toBe(1);
    }
    expect((await fixture.runtime.query("SELECT active_set_id,revision FROM official_usage_state WHERE tenant_id=$1", [identity.tenantId])).rows[0]).toEqual(before);
    await expect(reports.page(history.id, viewer)).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(exports.engine.status(id, viewer)).rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(async () => { for await (const _chunk of exports.engine.download(id, viewer, new AbortController().signal)) throw new Error("leaked old export"); })
      .rejects.toMatchObject({ code: "selection_invalidated" });
    await expect(exports.build(pending, viewer, "official_agents")).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await fixture.runtime.query("SELECT status FROM data_exports WHERE id=$1", [pending])).rows[0].status).not.toBe("ready");
    const latest = await reports.capture(viewer, "delegated", "history");
    expect((await reports.page(latest.id, viewer)).counts.total).toBe(operation === "correction" ? 3 : 1);
    expect((await fixture.runtime.query("SELECT invalidation_epoch::text FROM official_usage_history_state WHERE tenant_id=$1", [identity.tenantId])).rows[0].invalidation_epoch).toBe("1");
    const payloadCounts = async (setId: string | null = null) => (await fixture.runtime.query(`WITH versions AS (
      SELECT version_id FROM official_usage_set_versions WHERE tenant_id=$1 AND ($2::uuid IS NULL OR set_id=$2))
      SELECT
      (SELECT count(*)::int FROM official_usage_version_rows WHERE tenant_id=$1 AND ($2::uuid IS NULL OR version_id IN(SELECT version_id FROM versions))) AS rows,
      (SELECT count(*)::int FROM official_usage_row_facts f WHERE tenant_id=$1 AND ($2::uuid IS NULL OR EXISTS(
        SELECT 1 FROM official_usage_version_rows r WHERE r.version_id IN(SELECT version_id FROM versions)
          AND r.tenant_id=f.tenant_id AND r.kind=f.kind AND r.payload_hash=f.payload_hash))) AS facts,
      (SELECT count(*)::int FROM versions) AS links`,
    [identity.tenantId, setId])).rows[0];
    const protectedPayloads = await payloadCounts(second.setId);
    const retiredPayloads = await payloadCounts(first.setId);
    const allPayloads = await payloadCounts();
    await retainUntilConverged(fixture.operator);
    expect(await payloadCounts(second.setId)).toEqual(protectedPayloads);
    expect(await payloadCounts(first.setId)).toEqual(operation === "correction"
      ? retiredPayloads : { rows: 0, facts: 0, links: retiredPayloads.links });
    expect(await payloadCounts()).toEqual(operation === "correction" ? allPayloads : {
      rows: allPayloads.rows - retiredPayloads.rows, facts: allPayloads.facts - retiredPayloads.facts, links: allPayloads.links,
    });
  }, 30_000);
});
