// No ingestion provenance is required: set membership protects published, history and selected versions.
// Ready uploads intentionally have no renewable lease; accepting uploads remain protected until expired.
export const orphanReportVersion = (alias: string) => `
  NOT EXISTS(SELECT 1 FROM official_usage_set_versions m WHERE m.version_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM official_usage_ingestions i WHERE i.version_id=${alias}.id
    AND i.state IN ('streaming','validating','ready','accepting') AND i.expires_at>clock_timestamp())`;

export const emptyReportStaging = (alias: string) => `
  NOT EXISTS(SELECT 1 FROM official_usage_ingestion_rows r WHERE r.ingestion_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM official_usage_staged_rows r WHERE r.staging_id=${alias}.staging_id)`;
