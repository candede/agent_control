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

export async function directoryNeedsReportRefresh(database: Pick<pg.PoolClient, "query">,
  scope: { tenantId: string; principalId: string }): Promise<boolean> {
  // Compare collection start, not completion: a report can change while Users sync is running.
  const result = await database.query(`SELECT 1 FROM official_usage_state report
    JOIN official_usage_sets current ON current.id=report.active_set_id AND current.tenant_id=report.tenant_id
    WHERE report.tenant_id=$1 AND current.complete AND current.deleted_at IS NULL
      AND (current.expires_at IS NULL OR current.expires_at>clock_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM data_scope_epochs scope
        JOIN data_generation_heads head ON head.scope_id=scope.id
        JOIN data_generations generation ON generation.id=head.generation_id AND generation.state='published'
          AND generation.scope_epoch=scope.epoch AND generation.session_epoch=scope.session_epoch
        WHERE scope.tenant_id=$1 AND scope.principal_id=$2 AND scope.token_mode='delegated'
          AND scope.source='directory' AND scope.selector='complete' AND generation.created_at>=report.updated_at
      )`, [scope.tenantId, scope.principalId]);
  return result.rowCount === 1;
}
