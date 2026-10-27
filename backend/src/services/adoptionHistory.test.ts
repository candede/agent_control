import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import type { OfficialUsageReportKind } from "../types/officialReportRecords.js";
import { readAdoptionHistory } from "./adoptionHistory.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";
import { schemaRegistry } from "./officialReportFields.js";

type Rows = Record<OfficialUsageReportKind, string[]>;
const rows: Rows = {
  agents: ["Agent,Primary,Your org,99,99,5,2024-01-15", "agent,Lowercase,Your org,99,99,4,2024-01-15", "zero,Zero,Your org,0,0,0,"],
  users: ["Case,Uppercase,2,7,2024-01-15", "Only,User only,1,9,2024-01-15", "Zero,Zero,0,0,"],
  userAgents: ["Agent,Primary,Your org,Case,1,2024-01-15", "bridge,Bridge only,Your org,Case,2,2024-01-15",
    "bridge,Bridge only,Your org,case,3,2024-01-15", "zero,Zero,Your org,Zero,0,"],
};
const empty: Rows = { agents: [], users: [], userAgents: [] };
const owner = (): SelectionIdentity => ({ ...selectionIdentity, tenantId: `adoption-history-${randomUUID()}` });

describe("official retained adoption history", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>, imports: OfficialReportImports, reports: LargeTenantUsersReports;
  beforeAll(async () => {
    fixture = await testDatabase();
    imports = new OfficialReportImports(fixture.runtime);
    reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-adoption-history-integration-secret", 35);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  async function bundle(identity: SelectionIdentity, input: Rows, correctionOfSetId?: string) {
    const bundleId = randomUUID();
    for (const kind of ["agents", "userAgents", "users"] as const) {
      await imports.stage(identity, { bundleId, correctionOfSetId }, (async function* () {
        yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n${input[kind].join("\n")}${input[kind].length ? "\n" : ""}`);
      })());
    }
    return imports.acceptBundle(identity, bundleId, await imports.bundle(identity, bundleId));
  }
  async function history(identity: SelectionIdentity, selectionId?: string, cursor?: string) {
    const id = selectionId ?? (await reports.capture(identity, "delegated", "adoption_history")).id;
    return reports.read(id, identity, (client, context) => readAdoptionHistory(client, reports, context, { limit: 1, cursor }));
  }
  const remove = (identity: SelectionIdentity, setId: string) => imports.confirmPreview(identity, setId, "delete")
    .then(preview => imports.confirm(identity, preview));

  it("counts exact case-sensitive per-set unions, deduplicates relationship repetitions and keeps source totals independent", async () => {
    const identity = owner(), accepted = await bundle(identity, rows);
    await bundle(owner(), { ...rows, agents: ["foreign,Foreign,Your org,100,100,100,2024-01-15"] });
    const page = await history({ ...identity, principalId: "viewer-not-importer" });
    expect(page.counts).toEqual({ total: 1, filtered: 1 });
    expect(page.reports.setId).toBeNull();
    expect(page.value).toMatchObject([{
      id: accepted.setId, reportingStart: "2024-01-15", reportingEnd: "2024-01-15", periodProvenance: "activity_range",
      activeUsers: 3, activeAgents: 3, responses: 9, userReportActiveUsers: 2, relationshipActiveUsers: 2,
      userReportResponses: 16, relationshipResponses: 6,
    }]);
  });

  it("retains complete zero-row sets as undated explicit zero snapshots and paginates without mixing identities across sets", async () => {
    const identity = owner(), measured = await bundle(identity, rows), zero = await bundle(identity, empty);
    const first = await history(identity);
    expect(first.value.map(item => item.id)).toEqual([measured.setId]);
    expect(first.counts.total).toBe(2);
    const next = await history(identity, first.selection.id, first.page.nextCursor!);
    expect(next.value).toMatchObject([{
      id: zero.setId, reportingStart: null, reportingEnd: null, activeUsers: 0, activeAgents: 0, responses: 0,
      userReportActiveUsers: 0, relationshipActiveUsers: 0, userReportResponses: 0, relationshipResponses: 0,
    }]);
    expect(next.page.nextCursor).toBeNull();
    const previous = await history(identity, first.selection.id, next.page.previousCursor!);
    expect(previous.value).toEqual(first.value);
    await expect(history({ ...identity, principalId: "foreign" }, first.selection.id)).rejects.toMatchObject({
      code: "selection_invalidated",
    });
  });

  it("excludes incomplete, deleted and superseded sets and never revives a superseded set after deleting its correction", async () => {
    const identity = owner(), original = await bundle(identity, rows), pinned = await history(identity);
    const stage = await imports.stage(identity, { bundleId: randomUUID() }, (async function* () {
      yield Buffer.from(`${schemaRegistry.users.headers.join(",")}\nPartial,Partial,1,1,\n`);
    })());
    await imports.accept(identity, { stagingId: stage.id, revision: stage.revision,
      contentHash: stage.contentHash, expectedActiveRevision: stage.activeRevision });
    const correction = await bundle(identity, { ...rows,
      agents: ["Agent,Corrected,Your org,99,99,10,2024-01-15"] }, original.setId);
    await expect(history(identity, pinned.selection.id)).rejects.toMatchObject({ code: "selection_invalidated" });
    const corrected = await history(identity);
    expect(corrected.value.map(item => item.id)).toEqual([correction.setId]);
    expect(corrected.value[0].responses).toBe(10);
    await remove(identity, correction.setId);
    await expect(history(identity, corrected.selection.id)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await history(identity)).value).toEqual([]);
  });

  it.each(["expired", "damaged"] as const)("invalidates a pinned %s set and excludes it on a fresh capture", async failure => {
    const identity = owner(), accepted = await bundle(identity, rows), selected = await history(identity);
    if (failure === "expired") {
      await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [accepted.setId]);
    } else {
      await fixture.operator.query(`DELETE FROM official_usage_version_rows r USING official_usage_set_versions m
        WHERE m.set_id=$1 AND r.version_id=m.version_id AND r.tenant_id=m.tenant_id AND r.kind=m.kind AND r.ordinal=1`, [accepted.setId]);
    }
    await expect(history(identity, selected.selection.id)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect((await history(identity)).value).toEqual([]);
  });
});
