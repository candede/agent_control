# Phase 06 - Official Microsoft 365 Usage Report Ingestion

## Mission

Preserve the Microsoft 365 admin-center Copilot Agents usage exports as the only official per-agent and per-user usage authority, move ingestion to a durable audited backend pipeline, and expose report lineage, reconciliation, freshness, and safe replacement semantics.

## Prerequisites

- Follow the roadmap's manual fresh-session contract; read Phase 05's completion record, Phase 04 identity, Phase 02 data-access policy, and Phase 01 repository/migration artifacts.
- PostgreSQL migrations/repositories, normalized identities, app roles, Permission Center, and server-side upload limits must exist. This phase owns report-run, staging, set/version, selection, and retention schema.
- Do not deploy to Azure in this phase; use Phase 01's Docker deployment/test commands locally.

## Read first

- `frontend/src/reportImports.ts` and tests
- `frontend/src/reportingModels.ts` and tests
- `frontend/src/usageModels.ts` and tests
- `frontend/src/components/ReportingView.tsx`
- `frontend/src/components/UserAccessView.tsx`
- `frontend/src/App.tsx`
- Phase 01 repository/migration contract and Phase 04 identity resolver
- Current Microsoft Copilot Agents Usage Report documentation and current `copilotReportRoot` methods

## Source contract

- The official report's three exports are **Agents**, **Users & agents**, and **Users**.
- There is no supported Microsoft Graph method for these per-agent datasets at campaign creation. Existing Copilot usage APIs are not substitutes.
- Manual CSV ingestion therefore remains a product feature, not a temporary error path.
- Audit, Defender, telemetry, transcript, and package event counts must never be relabeled or reconciled as official usage totals.

## Required implementation

1. Move the CSV parser and canonical report models into a shared or backend-owned TypeScript module. The backend parses, validates, persists, and serves accepted reports; remove all browser report readers/writers in this cutover. A one-time cleanup may detect legacy key presence but never parse, upload, or automatically delete their values. Notify only affected browsers to re-import original exports; clear those keys after successful re-import and explicit confirmation, or an explicit discard acknowledgement. Preserve other local storage and never silently promote untrusted browser rows. Fresh browsers see no migration notice.
2. Preserve current supported schemas and add a fixture-captured schema registry with normalized header aliases only for Microsoft-observed variations. Unknown required-column changes fail validation with a clear schema-drift report; do not silently map by column position.
3. Add multipart upload endpoints protected by `AgentControl.Administrator`, CSRF, byte/row/field limits, UTF-8/content validation, formula-injection-safe export handling, and temporary-file cleanup. MIME/extension are hints, not proof that input is safe CSV. Never log rows. Per-user usage APIs/exports additionally require `SecurityReader`; aggregate official metrics use the README matrix.
4. Parse into durable staging with short transactions, tenant/actor ownership, finite expiry, and bounded storage. Never hold a database transaction or upload connection open while a user reviews a preview. Return kind, hash, source/as-of timestamp with confidence, reporting period, counts/warnings, overlapping versions, and reconciliation statistics. Require an idempotent second accept bound to actor/tenant, staging hash/revision, and the active-set revision; publish rows and active selection atomically. Expired/replaced previews cannot be accepted.
5. Persist validated rows and minimal import metadata: kind, parser/schema version, actor, timestamps, content hash, warnings and acceptance/supersession. Original CSV files are never archived; delete temporary upload bytes on success, rejection, cancellation and expiry, including crash-recovery cleanup. Staged validated rows have finite expiry. No optional encrypted archive switch.
6. Separate artifact identity (tenant, kind, file hash) from report-set identity (tenant, reporting period/as-of basis, bundle ID with one version of each kind). Exact duplicates are idempotent; corrections create immutable versions and an explicit superseding set. Allow an administrator to select a retained complete compatible set with preview/confirmation and the same revision-fenced transaction; never restore selection automatically. This permits controlled report-set recovery without reupload archives. Never sum overlapping versions/windows or distinct-user totals across agents.
7. Require compatible reporting periods and documented source snapshot metadata across the three exports, not identical download timestamps. A filename timestamp is not a reporting period; accept explicit operator-supplied period/as-of when absent, label it operator-asserted, and show unknown source freshness. Missing companion files remain an incomplete set and do not replace an active complete set. Show gaps, overlaps, pseudonymized usernames, non-additive metrics, and count discrepancies without inventing corrections.
8. Associate usage agent IDs only through Phase 04's exact documented identifier rules. Keep ambiguous/report-only agents and unknown users as separately visible rows. No manual identity review dependency; never join by display name or creator string.
9. Rebuild reporting and user-access views from backend APIs while preserving all current metrics. Add lineage/freshness, source period, coverage, unresolved identity, report-only, superseded, and official-authority labels.
10. Keep `creatorType` as a usage-report attribute with provenance; do not let it overwrite Power Platform authoring source. Show both when they disagree.
11. Provide ordinary finite report/staging retention and a confirmed administrator delete with audit. Removing an active set clears selection without silently choosing an older version and invalidates its derived rows/caches/exports. Keep only minimal non-content import/audit metadata after deletion; no legal holds, deletion ledger or backup-erasure subsystem. Pseudonymous identifiers remain dataset-scoped, never resolved through guessed names.
12. Add a documented operator workflow that names the exact Microsoft admin-center navigation/export steps, all three files, expected freshness, and the fact that API automation is unavailable. Surface this in the import dialog without claiming the app can fetch the report.
13. Model `never imported`, `incomplete three-file set`, `active`, and `stale` as distinct official-usage states. Staleness uses a documented configurable threshold based on the report period and last accepted set. The empty state links to the export/import workflow; removal or tenant unavailability of the admin-center export leaves official usage visibly unavailable rather than substituting another source.

## Focused validation

- Port all existing parser/reporting/user-access tests before deleting browser authority.
- Add tests for large/empty/non-UTF8/malformed CSV, BOM/quotes/newlines, formula-leading cells, duplicate headers, unknown schema, row limits, duplicate imports, corrected versions, overlapping windows, mixed report sets, rollback, and cleanup.
- Add association tests for exact IDs, collisions, separate report-only agents, anonymized users and creator-type disagreement.
- Route tests cover CSRF, app roles, two-step acceptance revision, concurrent accept/select/delete, explicit selection of a retained complete set, rejected incomplete/deleted sets and log redaction.
- Test sequential export timestamps with the same valid period, unknown period rejection, expired/wrong-actor previews, atomic three-file publication, distinct-user non-additivity, private per-user exports, original-byte cleanup on every exit/restart and legacy key preservation until confirmed cleanup.
- UI tests must cover all three imports, preview, warnings, lineage, stale/missing sets, supersession, unresolved records, and responsive tables.

## Aggregate validation

Run the global validation baseline. Import a sanitized three-file fixture set through the real HTTP/UI flow, restart the backend, and prove reports, lineage, selection, and derived metrics remain identical.

## Production continuation

Schema drift or one bad file does not stop the campaign and must not damage the active report set. Reject it transactionally, preserve the prior official set, display exact remediation, record telemetry without rows, and continue.

## Scope guard

Do not automate browser scraping or unsupported report APIs. Do not use audit/Defender/transcript data as official usage. Do not ingest transcript content. Do not deploy to Azure.

## Completion record

Create `plans/admin-poc-production/completions/06-official-usage-ingestion.md` with schema versions, fixture evidence, browser-authority removal and confirmed-cleanup behavior, retention/staleness settings, and Phase 07 preconditions.

## Done conditions

- Official usage ingestion is durable, immutable, transactional, audited, and backend-owned.
- All three Microsoft exports, lineage, snapshot consistency, and unresolved identities are visible.
- Existing metrics and workflows preserve their behavior after an explicit re-import; legacy browser rows are not migrated or retained as an authority.
- No other source is presented as official usage.
