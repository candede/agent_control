import type pg from "pg";

export async function verifyReportCapacitySchema(database: Pick<pg.Pool,"query">) {
  const result = await database.query(`SELECT
    (SELECT count(*)=2 AND bool_and(convalidated)
      FROM pg_constraint WHERE conrelid='official_usage_row_facts'::regclass
        AND contype='c' AND conname IN ('official_usage_typed_fact','official_usage_typed_payload')) AS valid,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='official_usage_version_rows'::regclass
      AND contype='f' AND convalidated AND confrelid='official_usage_row_facts'::regclass
      AND pg_get_constraintdef(oid)='FOREIGN KEY (tenant_id, kind, payload_hash) REFERENCES official_usage_row_facts(tenant_id, kind, payload_hash) ON DELETE RESTRICT') AS keys`);
  if (result.rows[0]?.valid !== true || result.rows[0]?.keys !== true) throw new Error("Official report typed-fact contract is missing or invalid.");
}

// The scoped FK and required typed payload make membership counts sufficient.
export function completeReportVersionSql(version: string, tenant: string, kind: string, count: string) {
  return `(${count}=(SELECT count(*) FROM official_usage_version_rows counted
    WHERE counted.version_id=${version} AND counted.tenant_id=${tenant} AND counted.kind=${kind}))`;
}

export function readableReportVersionSql(version: string, tenant: string, kind: string, count: string) {
  return `(${count}=COALESCE((SELECT row_count FROM official_usage_membership_counts counted
    WHERE counted.version_id=${version} AND counted.tenant_id=${tenant} AND counted.kind=${kind}),0))`;
}
