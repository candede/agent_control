# Phase 06 - Official Microsoft 365 Usage Report Ingestion

## Mission

Preserve the Microsoft 365 admin-center Copilot Agents usage exports as the only official per-agent and per-user usage authority, move ingestion to a durable audited backend pipeline, and expose report lineage, reconciliation, freshness, and safe replacement semantics.

## Prerequisites

- Read the roadmap and completion records for Phases 01-05.
- Durable report-run persistence, normalized identities, app roles, Permission Center, and server-side upload limits must exist.
- Do not deploy in this phase.

## Read first

- `frontend/src/reportImports.ts` and tests
- `frontend/src/reportingModels.ts` and tests
- `frontend/src/usageModels.ts` and tests
- `frontend/src/components/ReportingView.tsx`
- `frontend/src/components/UserAccessView.tsx`
- `frontend/src/App.tsx`
- Phase 01 report-run schema and Phase 04 identity resolver
- Current Microsoft Copilot Agents Usage Report documentation and current `copilotReportRoot` methods

## Source contract

- The official report's three exports are **Agents**, **Users & agents**, and **Users**.
- There is no supported Microsoft Graph method for these per-agent datasets at campaign creation. Existing Copilot usage APIs are not substitutes.
- Manual CSV ingestion therefore remains a product feature, not a temporary error path.
- Audit, Defender, telemetry, transcript, and package event counts must never be relabeled or reconciled as official usage totals.

## Required implementation

1. Move the CSV parser and canonical report models into a shared or backend-owned TypeScript module. The backend must parse, validate, persist, and serve accepted reports; the browser must no longer be the production report authority. On first load after cutover, detect only whether legacy report keys exist, delete them without parsing or uploading their contents, and show a one-time notice to re-import the original three CSV files. Do not retain a legacy read path or silently promote untrusted browser rows.
2. Preserve current supported schemas and add a fixture-captured schema registry with normalized header aliases only for Microsoft-observed variations. Unknown required-column changes fail validation with a clear schema-drift report; do not silently map by column position.
3. Add multipart upload endpoints protected by `AgentControl.Administrator` or a dedicated import entitlement, CSRF, MIME and extension checks, byte/row/field limits, UTF-8 validation, formula-injection-safe export handling, and temporary-file cleanup. Never log CSV rows.
4. Parse into a staging transaction. Return a preview containing report kind, file hash, source timestamp, period, row count, warning/error counts, report identity, overlapping accepted versions, and reconciliation statistics. Require a second explicit accept request bound to the preview hash/revision.
5. Persist immutable import artifact metadata, row data, parser/schema version, actor, timestamps, content hash, lineage, warnings, and acceptance/supersession events. Store the original CSV only when an explicit encrypted-artifact retention policy is enabled; default to no original-file retention.
6. Define report-set identity using tenant, report kind, source-generated timestamp, period/window, and content hash. Exact duplicate import is idempotent. A corrected file becomes a new immutable version and may supersede, never mutate, the prior version.
7. Add explicit active report-set selection. Do not combine mismatched generation times or periods as though one coherent snapshot. Show gaps, overlaps, stale files, missing companion exports, anonymized usernames, and cross-report count discrepancies.
8. Reconcile usage agent IDs only through exact source identifiers and reviewed identity links. Retain report-only agents and unknown users as first-class unresolved rows. Never join by display name or creator string.
9. Rebuild reporting and user-access views from backend APIs while preserving all current metrics. Add lineage/freshness, source period, coverage, unresolved identity, report-only, superseded, and official-authority labels.
10. Keep `creatorType` as a usage-report attribute with provenance; do not let it overwrite Power Platform authoring source. Show both when they disagree.
11. Add safe deletion/retention workflows: deleting an accepted set requires confirmation, `AgentControl.Administrator`, audit, and a reason; default retention must preserve enough immutable versions for the POC audit trail.
12. Add a documented operator workflow that names the exact Microsoft admin-center navigation/export steps, all three files, expected freshness, and the fact that API automation is unavailable. Surface this in the import dialog without claiming the app can fetch the report.
13. Model `never imported`, `incomplete three-file set`, `active`, and `stale` as distinct official-usage states. Staleness uses a documented configurable threshold based on the report period and last accepted set. The empty state links to the export/import workflow; removal or tenant unavailability of the admin-center export leaves official usage visibly unavailable rather than substituting another source.

## Focused validation

- Port all existing parser/reporting/user-access tests before deleting browser authority.
- Add tests for large/empty/non-UTF8/malformed CSV, BOM/quotes/newlines, formula-leading cells, duplicate headers, unknown schema, row limits, duplicate imports, corrected versions, overlapping windows, mixed report sets, rollback, and cleanup.
- Add reconciliation tests for exact IDs, reviewed links, collisions, report-only agents, anonymized users, and creator-type disagreement.
- Route tests must cover CSRF, app roles, two-step acceptance revision, concurrent accept/delete, and log redaction.
- UI tests must cover all three imports, preview, warnings, lineage, stale/missing sets, supersession, unresolved records, and responsive tables.

## Aggregate validation

Run the global validation baseline. Import a sanitized three-file fixture set through the real HTTP/UI flow, restart the backend, and prove reports, lineage, selection, and derived metrics remain identical.

## Production continuation

Schema drift or one bad file does not stop the campaign and must not damage the active report set. Reject it transactionally, preserve the prior official set, display exact remediation, record telemetry without rows, and continue.

## Scope guard

Do not automate browser scraping or unsupported report APIs. Do not use audit/Defender/transcript data as official usage. Do not ingest transcript content. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/06-official-usage-ingestion.md` with schema versions, fixture evidence, legacy-key deletion and authority-cutover confirmation, retention/staleness settings, and Phase 07 preconditions.

## Done conditions

- Official usage ingestion is durable, immutable, transactional, audited, and backend-owned.
- All three Microsoft exports, lineage, snapshot consistency, and unresolved identities are visible.
- Existing metrics and workflows preserve their behavior after an explicit re-import; legacy browser rows are not migrated or retained as an authority.
- No other source is presented as official usage.
