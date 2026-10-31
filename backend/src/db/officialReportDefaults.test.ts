import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventorySelectionFixture } from "../../scripts/inventoryFixtures.js";
import { deleteUsageSet, newUsageScope, publishUsageReports, saveUsageInventory, usageIdentity } from "./agentUsageTestSupport.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let reports: LargeTenantUsersReports;
const dates = (date: string) => (_kind: string, content: string) => content.replaceAll(/2026-09-\d{2}/g, date);

beforeAll(async () => {
  fixture = await testDatabase();
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-automatic-default-report-secret", 35);
}, 30_000);
afterAll(async () => { await fixture?.close(); });

describe("automatic chronological defaults and personal report contexts", () => {
  it("orders content periods, repairs manually chosen heads on first read, and falls back after correction deletion and expiry", async () => {
    const scope = newUsageScope(), identity = await usageIdentity(fixture.runtime, scope);
    const first = await publishUsageReports(fixture.runtime, scope, 44, dates("2026-09-05"));
    const latest = await publishUsageReports(fixture.runtime, scope, 50, dates("2026-10-20"));
    const backfill = await publishUsageReports(fixture.runtime, scope, 4, dates("2026-09-01"));
    const undated = await publishUsageReports(fixture.runtime, scope, 1, dates(""));
    expect(backfill.activeRevision).toBe(latest.activeRevision);
    expect(undated.activeRevision).toBe(latest.activeRevision);
    const corrected = await publishUsageReports(fixture.runtime, scope, 77, dates("2026-10-19"), { correctionOfSetId: latest.setId });
    expect(corrected.activeRevision).toBe(String(BigInt(latest.activeRevision) + 1n));
    const oldCorrection = await publishUsageReports(fixture.runtime, scope, 40, dates("2026-09-05"), { correctionOfSetId: first.setId });
    expect(oldCorrection.activeRevision).toBe(corrected.activeRevision);
    const head = async () => (await fixture.runtime.query("SELECT active_set_id,revision::text FROM official_usage_state WHERE tenant_id=$1",
      [scope.tenantId])).rows[0] as { active_set_id: string | null; revision: string };
    expect((await head()).active_set_id).toBe(corrected.setId);

    await fixture.operator.query("UPDATE official_usage_state SET active_set_id=$2,revision=revision+1 WHERE tenant_id=$1",
      [scope.tenantId, backfill.setId]);
    const manual = await head();
    const repaired = await reports.capture(identity, "official_agents");
    expect((await reports.page(repaired.id, identity)).reports).toMatchObject({ setId: corrected.setId, activeSetId: corrected.setId });
    expect(await head()).toEqual({ active_set_id: corrected.setId, revision: String(BigInt(manual.revision) + 1n) });
    const stable = await head();
    await reports.history.ensure(scope.tenantId);
    expect(await head()).toEqual(stable);

    expect(await deleteUsageSet(fixture.runtime, scope, corrected.setId)).toMatchObject({ activeSetId: oldCorrection.setId });
    expect(await deleteUsageSet(fixture.runtime, scope, oldCorrection.setId)).toMatchObject({ activeSetId: backfill.setId });
    await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [backfill.setId]);
    expect(await reports.history.expire(scope.tenantId)).toBe(1);
    expect((await head()).active_set_id).toBe(undated.setId);
    const archived = await reports.capture(identity, "official_agents", { setId: latest.setId });
    expect((await reports.page(archived.id, identity)).reports.setId).toBe(latest.setId);
    await expect(reports.capture(identity, "official_agents", { setId: backfill.setId }))
      .rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
    await expect(reports.capture(identity, "official_agents", { setId: randomUUID() }))
      .rejects.toMatchObject({ status: 404, code: "usage_report_unavailable" });
  });

  it("captures independent Viewer report choices for Users and Agents without changing the tenant head", async () => {
    const scope = newUsageScope();
    const [agent] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const older = await publishUsageReports(fixture.runtime, scope, 44, dates("2026-09-05"));
    const latest = await publishUsageReports(fixture.runtime, scope, 77, dates("2026-10-20"));
    const viewer = { ...scope, principalId: "personal-viewer" }, other = { ...scope, principalId: "latest-viewer" };
    const before = (await fixture.runtime.query("SELECT active_set_id,revision,updated_at FROM official_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows;
    const personal = await inventorySelectionFixture(fixture.runtime, viewer, { setId: older.setId, sortBy: "responses", sortDirection: "desc" });
    const automatic = await inventorySelectionFixture(fixture.runtime, other);
    const usage = new OfficialAgentUsage(reports, personal.queries);
    expect((await usage.summaries(personal.selection.id, personal.identity, [agent.id]))[0])
      .toMatchObject({ responses: 44, context: { reportSetId: older.setId, reports: { activeSetId: latest.setId } } });
    expect(personal.raw.value).toHaveLength(1);
    expect(automatic.raw.value).toHaveLength(1);
    expect(personal.raw.value[0]).toMatchObject({ responses: 44 });
    expect(automatic.raw.value[0]).toMatchObject({ responses: 77 });
    expect((await personal.queries.usage(personal.selection.id, personal.identity, [personal.raw.value[0].id]))[0]).toMatchObject({ responses: 44 });
    expect((await automatic.queries.usage(automatic.selection.id, automatic.identity, [automatic.raw.value[0].id]))[0]).toMatchObject({ responses: 77 });
    const users = await reports.capture(personal.identity, "official_users", { setId: older.setId });
    expect((await reports.page(users.id, personal.identity)).reports).toMatchObject({ setId: older.setId, activeSetId: latest.setId });
    expect((await fixture.runtime.query("SELECT report_context->'report'->>'setId' AS set_id,query_values->>'setId' AS query_set_id FROM inventory_read_contexts WHERE selection_id=$1",
      [personal.selection.id])).rows).toEqual([{ set_id: older.setId, query_set_id: older.setId }]);
    expect((await fixture.runtime.query("SELECT active_set_id,revision,updated_at FROM official_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows).toEqual(before);
  });
});
