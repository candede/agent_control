export function inventoryNativeRootChoicesSql(roots: "roots" | "inputs" | "input_roots" | "authorized_roots") {
  return `SELECT saved.scope_id,captured.baseline_id,captured.revision,kind
    FROM ${roots} captured JOIN inventory_roots saved ON saved.baseline_id=captured.baseline_id
    JOIN inventory_revisions revision ON revision.scope_id=saved.scope_id
      AND revision.baseline_id=captured.baseline_id AND revision.revision=captured.revision
    JOIN inventory_attempts attempt ON attempt.generation_id=revision.generation_id
    CROSS JOIN (VALUES('microsoft.copilotstudio/agents'),('microsoft.powerplatform/environments')) types(kind)
    WHERE saved.domain='power_platform' AND (kind=ANY(attempt.resource_types) OR EXISTS(
      SELECT 1 FROM inventory_memberships member JOIN power_platform_record_rows record
        ON record.generation_id=member.generation_id AND record.identity=member.identity
      WHERE member.baseline_id=captured.baseline_id AND member.valid_from_revision<=captured.revision
        AND (member.valid_to_revision IS NULL OR member.valid_to_revision>captured.revision)
        AND record.resource_type=kind))`;
}
