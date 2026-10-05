import type pg from "pg";
import { dataConnections } from "./dataConnections.js";
import { officialReportCount } from "./officialReportBounds.js";

export type OfficialReportStatus = { complete: boolean; count: number; acceptedAt: string | null };
export class OfficialReportStatusRepository {
  constructor(readonly database: pg.Pool) {}
  read(tenantId: string): Promise<OfficialReportStatus> {
    return dataConnections(this.database).selectedRead(async client => {
      const row = (await client.query(`SELECT s.accepted_at,count(v.id)::int AS kinds,coalesce(sum(v.row_count),0)::text AS rows
        FROM official_usage_state head JOIN official_usage_sets s ON s.id=head.active_set_id AND s.tenant_id=head.tenant_id
        JOIN official_usage_set_versions sv ON sv.set_id=s.id AND sv.tenant_id=s.tenant_id
        JOIN official_usage_versions v ON v.id=sv.version_id AND v.tenant_id=s.tenant_id
        JOIN official_usage_artifacts a ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id
        WHERE head.tenant_id=$1 AND s.complete AND s.deleted_at IS NULL AND v.deleted_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
          AND (v.expires_at IS NULL OR v.expires_at>clock_timestamp())
          AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
        GROUP BY s.id,s.accepted_at`, [tenantId])).rows[0];
      return { complete: row?.kinds === 3, count: row?.kinds === 3 ? officialReportCount(row.rows) : 0,
        acceptedAt: row?.accepted_at?.toISOString() ?? null };
    });
  }
}
