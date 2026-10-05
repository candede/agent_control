// The index horizon uses execution-time wall clock, not transaction start.
// Newly expiring rows are picked up by the next bounded scheduler statement.
export const pendingInventoryIdentityExpirySql = `WITH expired_records AS MATERIALIZED (
    SELECT generation_id,identity FROM unified_agent_rows
    WHERE scope_id=$1 AND identity_expires_at<=(SELECT clock_timestamp())
      AND identity_expires_at<=clock_timestamp()
  ) SELECT DISTINCT source.source_scope_id,source.source_identity
  FROM expired_records record JOIN inventory_roots root ON root.scope_id=$1 AND root.current
  CROSS JOIN LATERAL (
    SELECT 1 FROM inventory_memberships member WHERE member.baseline_id=root.baseline_id
      AND member.generation_id=record.generation_id AND member.identity=record.identity
      AND member.valid_from_revision<=root.revision AND (member.valid_to_revision IS NULL OR member.valid_to_revision>root.revision)
    LIMIT 1 OFFSET 0
  ) member
  CROSS JOIN LATERAL (
    SELECT source_scope_id,source_identity FROM unified_agent_memberships
    WHERE generation_id=record.generation_id AND identity=record.identity OFFSET 0
  ) source`;
