import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, grantRuntime, migrate } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { OfficialUsageHistoryService } from "../services/officialUsageHistory.js";
import { OfficialUsageRepository } from "./officialUsage.js";
import { officialUsageHistoryMigrationSql } from "./officialUsageHistorySchema.js";
import { migrations } from "./schema.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;

beforeAll(async () => {
  fixture = await testDatabase(false);
  await bootstrap(fixture.operator, fixturePassword);
  await migrate(fixture.operator, migrations.slice(0, 28));
  await grantRuntime(fixture.operator);
});
afterAll(async () => { await fixture?.close(); });

describe("official usage history migration", () => {
  it("backfills schema 28 observations into shared immutable facts without changing prior migrations", async () => {
    const tenantId = "tenant-history-backfill";
    const setId = randomUUID();
    const bundleId = randomUUID();
    await fixture.operator.query(`INSERT INTO official_usage_sets
      (id,tenant_id,bundle_id,actor_principal_id,reporting_start,reporting_end,period_provenance,complete,accepted_at)
      VALUES($1,$2,$3,'legacy-administrator','2026-06-02','2026-07-01','operator_asserted',true,clock_timestamp())`,
    [setId, tenantId, bundleId]);
    for (const kind of ["agents", "userAgents", "users"] as const) {
      const artifactId = randomUUID();
      const stagingId = randomUUID();
      const versionId = randomUUID();
      const fileHash = createHash("sha256").update(kind).digest("hex");
      await fixture.operator.query(`INSERT INTO official_usage_artifacts
        (id,tenant_id,kind,file_hash,parser_version,schema_version)
        VALUES($1,$2,$3,$4,'1',$5)`,
      [artifactId, tenantId, kind, fileHash, `legacy-${kind}`]);
      await fixture.operator.query(`INSERT INTO official_usage_staging
        (id,tenant_id,actor_principal_id,status,kind,file_hash,parser_version,schema_version,bundle_id,
         reporting_start,reporting_end,period_provenance,source_as_of_provenance,source_freshness,
         row_count,stored_bytes,active_revision,accepted_version_id,accepted_set_id,
         accepted_result_revision,accepted_at)
        VALUES($1,$2,'legacy-administrator','accepted',$3,$4,'1',$5,$6,
          '2026-06-02','2026-07-01','operator_asserted','absent','unknown',
          1,128,1,$7,$8,2,clock_timestamp())`,
      [stagingId, tenantId, kind, fileHash, `legacy-${kind}`, bundleId, versionId, setId]);
      await fixture.operator.query(`INSERT INTO official_usage_versions
        (id,tenant_id,artifact_id,staging_id,kind,reporting_start,reporting_end,period_provenance,
         source_as_of_provenance,source_freshness,row_count,accepted_by)
        VALUES($1,$2,$3,$4,$5,'2026-06-02','2026-07-01','operator_asserted',
          'absent','unknown',1,'legacy-administrator')`,
      [versionId, tenantId, artifactId, stagingId, kind]);
      await fixture.operator.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,row_data)
        VALUES($1,$2,$3,0,$4::jsonb)`,
      [versionId, tenantId, kind, JSON.stringify({ identity: kind, lastActivityDateUtc: "2026-07-01T00:00:00.000Z" })]);
      await fixture.operator.query(`INSERT INTO official_usage_set_versions(set_id,tenant_id,kind,version_id)
        VALUES($1,$2,$3,$4)`, [setId, tenantId, kind, versionId]);
    }
    await fixture.operator.query(`INSERT INTO official_usage_state(tenant_id,active_set_id,revision)
      VALUES($1,$2,2)`, [tenantId, setId]);
    const migrationRowsBefore = await fixture.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version");

    await fixture.operator.query(officialUsageHistoryMigrationSql);

    expect((await fixture.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows)
      .toEqual(migrationRowsBefore.rows);
    expect((await fixture.runtime.query<{ facts: number; rows: number; missing_hashes: number }>(`SELECT
      (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts,
      (SELECT count(*)::int FROM official_usage_version_rows WHERE tenant_id=$1) AS rows,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1 AND content_hash IS NULL) AS missing_hashes`,
    [tenantId])).rows[0]).toEqual({ facts: 3, rows: 3, missing_hashes: 0 });
    expect((await fixture.runtime.query(`SELECT table_name,is_nullable,column_default
      FROM information_schema.columns
      WHERE table_schema='public' AND column_name='expires_at'
        AND table_name IN ('official_usage_artifacts','official_usage_sets','official_usage_versions')
      ORDER BY table_name`)).rows).toEqual([
      { table_name: "official_usage_artifacts", is_nullable: "YES", column_default: null },
      { table_name: "official_usage_sets", is_nullable: "YES", column_default: null },
      { table_name: "official_usage_versions", is_nullable: "YES", column_default: null },
    ]);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_artifacts WHERE expires_at IS NOT NULL) AS artifacts,
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1 AND deleted_at IS NULL AND expires_at IS NOT NULL) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1 AND deleted_at IS NULL AND expires_at IS NOT NULL) AS versions`,
    [tenantId])).rows[0]).toEqual({ artifacts: 0, sets: 0, versions: 0 });
    expect((await new OfficialUsageRepository(fixture.runtime).getPublished(tenantId)).activeSet)
      .toMatchObject({ id: setId, expiresAt: null });
    expect((await new OfficialUsageHistoryService(fixture.runtime).getHistory(tenantId)).summary)
      .toMatchObject({ importCount: 1, uniqueObservationCount: 3, uniquePayloadCount: 3 });
    await expect(fixture.runtime.query(`UPDATE official_usage_row_facts
      SET row_data='{}'::jsonb WHERE tenant_id=$1`, [tenantId])).rejects.toThrow(/permission denied|immutable/);
  });
});
