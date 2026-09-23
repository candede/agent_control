export const inventoryVerificationMigrationSql = `
ALTER TABLE power_platform_inventory_snapshots ADD COLUMN queried_types jsonb;

UPDATE power_platform_inventory_snapshots snapshot SET queried_types=(
  SELECT jsonb_agg(requested.type ORDER BY requested.position)
  FROM jsonb_array_elements(snapshot.requested_types) WITH ORDINALITY requested(type,position)
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot.coverage) entry(value)
    WHERE entry.value->'type'=requested.type AND entry.value->>'status'='not_authorized_scope'
  )
);

ALTER TABLE power_platform_inventory_snapshots
  ALTER COLUMN queried_types SET NOT NULL,
  ADD CONSTRAINT power_platform_inventory_queried_types CHECK (
    jsonb_typeof(queried_types)='array' AND jsonb_array_length(queried_types) BETWEEN 1 AND 2
    AND octet_length(queried_types::text)<=2048 AND requested_types @> queried_types
  ),
  DROP COLUMN coverage;
`;
