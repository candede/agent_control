import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { withQueries } from "../../scripts/lifecycleEvidence.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import { officialReportLimits } from "../services/officialReportStream.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { OfficialReportImports } from "./officialReportImports.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); }, 30_000);
afterAll(async () => { await fixture?.close(); });

async function* csv(kind: keyof typeof schemaRegistry, rows: string[]) {
  yield Buffer.from(`${schemaRegistry[kind].headers.join(",")}\n`);
  for (const row of rows) yield Buffer.from(`${row}\n`);
}
const owner = () => ({ ...selectionIdentity, tenantId: `import-batches-${randomUUID()}` });

describe("bounded import copies", () => {
  it("checks, accepts and verifies a complete 1,302-row bundle with seven copy transactions per phase", async () => {
    const identity = owner(), bundleId = randomUUID(), imports = new OfficialReportImports(fixture.runtime);
    const counts = { agents: 325, userAgents: 633, users: 344 };
    const occurrences = (index: number, total: number) => Math.floor((632 - index) / total) + 1;
    const rows = {
      agents: Array.from({ length: counts.agents }, (_, n) =>
        `agent-${n},Agent ${n},Your org,${occurrences(n, counts.agents)},0,${occurrences(n, counts.agents)},2026-07-06`),
      userAgents: Array.from({ length: counts.userAgents }, (_, n) =>
        `agent-${n % counts.agents},Agent ${n % counts.agents},Your org,user-${n % counts.users}@example.invalid,1,2026-07-06`),
      users: Array.from({ length: counts.users }, (_, n) =>
        `user-${n}@example.invalid,User ${n},${occurrences(n, counts.users)},${occurrences(n, counts.users)},2026-07-06`),
    };
    let stagingCopies = 0, acceptanceCopies = 0;
    const started = performance.now();
    await withQueries(fixture.runtime, text => {
      if (text.startsWith("INSERT INTO official_usage_staged_rows")) stagingCopies++;
      return text;
    }, async () => {
      for (const kind of ["agents", "userAgents", "users"] as const) {
        const preview = await imports.stage(identity, { bundleId }, csv(kind, rows[kind]));
        expect(preview.rowCount).toBe(counts[kind]);
      }
    });
    const checkedAt = performance.now(), preview = await imports.bundle(identity, bundleId);
    const accepted = await withQueries(fixture.runtime, text => {
      if (text.startsWith("INSERT INTO official_usage_version_rows")) acceptanceCopies++;
      return text;
    }, () => imports.acceptBundle(identity, bundleId, preview));
    const acceptedAt = performance.now();
    expect(stagingCopies).toBe(7);
    expect(acceptanceCopies).toBe(7);
    expect(accepted.complete).toBe(true);
    expect(await imports.acceptBundle(identity, bundleId, preview)).toEqual(accepted);
    const reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-import-batch-verification-secret", 35);
    const viewer = { ...identity, principalId: "separate-report-viewer" };
    const selection = await reports.capture(viewer, "official_agents", { setId: accepted.setId });
    const saved = await reports.page(selection.id, viewer, { limit: 1 });
    expect(saved.reports.setId).toBe(accepted.setId);
    expect(saved.reports.lineages).toHaveLength(3);
    for (const lineage of saved.reports.lineages) expect(lineage.rowCount).toBe(counts[lineage.kind]);
    expect(saved.counts.total).toBe(counts.agents);
    process.stdout.write(`IMPORT_BATCH_RECEIPT ${JSON.stringify({
      rows: 1302, stagingCopies, acceptanceCopies, checkingMs: checkedAt - started,
      acceptanceMs: acceptedAt - checkedAt, verificationMs: performance.now() - acceptedAt,
    })}\n`);
  });

  it("splits wide rows by the payload-byte budget before reaching the row limit", async () => {
    const identity = owner(), bundleId = randomUUID(), imports = new OfficialReportImports(fixture.runtime);
    const rows = Array.from({ length: 750 }, (_, n) => {
      const identifier = `${"\u4e00".repeat(508)}${String(n).padStart(4, "0")}`;
      return `${identifier},${"\u4e00".repeat(512)},${"\u4e00".repeat(128)},${identifier},4,2026-07-06`;
    });
    const staging: [number, number][] = [], acceptance: [number, number][] = [];
    const preview = await withQueries(fixture.runtime, (text, values) => {
      if (text.startsWith("INSERT INTO official_usage_staged_rows")) staging.push([Number(values[2]), Number(values[3])]);
      return text;
    }, () => imports.stage(identity, { bundleId }, csv("userAgents", rows)));
    expect(staging.length).toBeGreaterThan(Math.ceil(rows.length / officialReportLimits.batchRows));
    expect(staging[0][1]).toBeLessThan(officialReportLimits.batchRows);
    const ingestion = (await fixture.runtime.query<{ id: string }>(
      "SELECT id FROM official_usage_ingestions WHERE staging_id=$1", [preview.id])).rows[0];
    for (const [start, end] of staging) {
      const batch = (await fixture.runtime.query<{ rows: number; bytes: string }>(`SELECT count(*)::int AS rows,
        sum(octet_length(row_data::text))::text AS bytes FROM official_usage_ingestion_rows
        WHERE ingestion_id=$1 AND ordinal>=$2 AND ordinal<$3`, [ingestion.id, start, end])).rows[0];
      expect(batch.rows).toBe(end - start);
      expect(batch.rows).toBeLessThanOrEqual(officialReportLimits.batchRows);
      expect(Number(batch.bytes)).toBeLessThanOrEqual(officialReportLimits.batchBytes);
    }
    const accepted = await withQueries(fixture.runtime, (text, values) => {
      if (text.startsWith("INSERT INTO official_usage_version_rows")) acceptance.push([Number(values[3]), Number(values[4])]);
      return text;
    }, () => imports.accept(identity, { stagingId: preview.id, revision: preview.revision,
      contentHash: preview.contentHash, expectedActiveRevision: preview.activeRevision }));
    expect(acceptance).toEqual(staging);
    expect(accepted.complete).toBe(false);
    const saved = (await fixture.runtime.query<{ rows: number }>(
      "SELECT count(*)::int AS rows FROM official_usage_version_rows WHERE tenant_id=$1", [identity.tenantId])).rows[0];
    expect(saved.rows).toBe(rows.length);
  });
});
