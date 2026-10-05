export function inventoryNativeRootChoicesSql(roots: "roots" | "inputs" | "input_roots" | "authorized_roots") {
  return `SELECT DISTINCT ON (kind) saved.scope_id,captured.baseline_id,captured.revision,kind
    FROM ${roots} captured JOIN inventory_roots saved ON saved.baseline_id=captured.baseline_id
    JOIN inventory_revisions revision ON revision.scope_id=saved.scope_id
      AND revision.baseline_id=captured.baseline_id AND revision.revision=captured.revision
    JOIN inventory_attempts attempt ON attempt.generation_id=revision.generation_id
    CROSS JOIN LATERAL unnest(attempt.resource_types) types(kind)
    WHERE saved.domain='power_platform'
    ORDER BY kind,(coalesce(attempt.environment_id,'')='') DESC,
      saved.catalog_observed_at DESC NULLS LAST,saved.scope_id`;
}
