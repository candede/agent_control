# Phase 06 - Official Microsoft 365 Usage Report Ingestion

## Status

```yaml
phase_file: 06-official-usage-ingestion.md
phase_status: complete
outcome: completed_with_residuals
validated_at_utc: 2026-09-09T09:33:30Z
execution_target: retained local Docker project agent-control-phase01; isolated PostgreSQL/browser/restart fixtures; no Azure or live provider changes
```

Phase 06 is complete after two same-phase repair passes and a final upload-admission correction. The first earlier claim was reopened because aggregate distinct users summed non-additive per-agent counts, and migration 13 made accepted provenance depend on short-lived staging. Forward migration 14 and exact dataset union projections repaired those defects. The second claim was reopened by the parent RED assertion: the identical three-file bundle acceptance failed even on immediate retry because publication changed the preview hash and active revision. Further review found upload-settlement, source-semantics, export-provenance and published-row closure defects. Migrations 1-14 remained immutable. Forward migration 15 provides durable original intent/result authority independently of staging cleanup and later selection. Final parent review moved missing-file validation inside upload settlement; repeated metadata-only requests no longer exhaust admission. These defects originated in Phase 06, not the verified earlier prerequisites.

No branch, commit, push, Azure deployment, provider grant, tenant scrape, unsupported report API, transcript ingestion, campaign ledger, reset, or Phase 07 implementation occurred. Tests use sanitized synthetic report content only. The retained `agent-control-phase01` volume, network, origin, and restricted secrets were preserved.

## Delivered Contracts

- **Official authority:** Only the Microsoft 365 admin-center Copilot Agents **Agents**, **Users & agents**, and **Users** exports feed official usage. Audit, Purview, Defender, telemetry, transcripts, package events, and Microsoft 365 Copilot app-adoption reports are never substituted or reconciled as official totals.
- **Current API review:** Microsoft sources were rechecked on 2026-09-09. `copilotReportRoot` lists exactly `getMicrosoft365CopilotUserCountSummary`, `getMicrosoft365CopilotUserCountTrend`, and `getMicrosoft365CopilotUsageUserDetail`, each with `v1.0` and `beta` forms and `Reports.Read.All`. They expose licensed Microsoft 365 Copilot app adoption/activity, not the three per-agent exports, so manual import remains the product workflow.
- **Backend authority:** The backend owns parser version `1`, schema identification, validation, persistence, projection, and export. The browser no longer reads, calculates, or stores authoritative report rows.
- **Schemas and provenance:** The parser recognizes only `m365-agents-observed-v1`, `m365-users-agents-observed-v1`, and `m365-users-observed-v1` with normalized case/whitespace and exact required headers. The supported CSVs contain no source period or source-as-of fields. Operator values are always labelled `operator_asserted`, source freshness is `unknown`, and companion source basis must match exactly. Download times never establish compatibility.
- **Input boundaries:** Administrator-only same-origin/CSRF multipart routes accept one 8 MiB file, at most 50,000 rows, 4 KiB fields, valid UTF-8, one file/nine parts and two concurrent process uploads. A real 15-second wall-clock deadline covers multipart parsing, report parsing and repository staging. Schema/content establish validity; filename and MIME type do not. Rows and filenames are not logged.
- **Finite staging and settlement:** Staging is tenant/actor/bundle owned and expires after 30 minutes. Admission is bounded to nine staging rows, 150,000 rows, and 96 MiB per actor; 30 staging rows, 500,000 rows, and 256 MiB per tenant. Disconnect/deadline cancellation reaches repository work and is rechecked before commit. Capacity remains reserved until parser and started repository work settle. Cleanup runs before admission, before server listen, periodically, and through operator retention. A cleanup verification failure returns `upload_cleanup_failed` when possible and emits only `official_usage_upload_cleanup_failed` without report values.
- **Atomic publication authority:** The only HTTP publication operation accepts the reviewed bundle; the old per-staging accept route is denied. One preview hash covers all staged and retained companion intents. All three kinds publish under the tenant lock in one revision-fenced transaction or none do. A bad companion, stale hash/revision, wrong actor, expired stage, or incomplete bundle cannot change the active set. Explicit corrections create superseding sets.
- **Durable exact retries:** Migration 15's content-free receipt is independent of staging and bound to tenant, actor, bundle, bundle hash and expected active revision. An exact retry returns its original set/version/revision/completeness after staging cleanup or later active-selection change without replaying or reselecting. Changed actor/hash/revision fails.
- **Recovery and deletion:** Actor-owned staging resumes after reload. Incomplete retained sets remain nonactive and resumable. Selecting or deleting a retained set requires a short-lived server confirmation and active revision fence. Deleting the active set clears selection and never selects an older set automatically.
- **Projection semantics:** Aggregate distinct users are the exact case-sensitive union of Users and Users & agents identities, never a sum of per-agent active-user values. A 50,000 plus disjoint 50,000 regression proves the 100,000 identity union in both user paging and aggregate summary. Licensed/unlicensed categories are never added, including within one agent after a license change. Per-agent distinct totals use Users & agents identities and are `Unknown` without that bridge. Headline responses use Agents only; source totals remain separate. User recency uses Users only; Users & agents activity remains agent-last-used-by-anyone.
- **Identity and source separation:** Report agent IDs remain report-only unless a future exact documented cross-source contract exists. Names and creator strings are never identity keys. Usernames are scoped to report-set and version IDs. Usage `creatorType` retains report provenance and cannot overwrite package or Power Platform authoring metadata.
- **Views and exports:** Reader receives aggregate reporting; SecurityReader receives user-level reporting; Administrator receives import/set metadata without inherited content access. Filtering precedes count, paging, joins, and lazy formula-safe CSV export. Agent and user CSVs include set/version IDs, reporting period, period provenance, source freshness, basis fields and explicit `Unknown` nullable values. Stream drain/error/close listeners are removed on completion, failure and disconnect.
- **Official states and dual-age staleness:** `never_imported`, `incomplete`, `active`, `stale`, `not_selected`, and `deleted` are distinct. `OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to 35, accepts 1-365, and marks a selected set stale when either report-period age or accepted-set age exceeds the threshold.
- **Independent retention:** Accepted artifacts, immutable versions, sets, rows and bundle receipts expire independently after 180 days. Minimal content-free import audit expires after 90 days. Migration 14 removes the accepted-version staging foreign key and preserves accepted provenance; migration 15 adds independent receipts and closes published versions to runtime appends.
- **Original-byte exclusion:** Upload buffers are cleared; original CSV files are never archived. The compiled restart harness proves accepted staging rows are absent and official-usage schema contains no `bytea` archive while selected content remains available.
- **Legacy cutover:** Every affected authenticated browser receives a content-free notice after key-name enumeration only. The value of `agent-control:usage-reports:v1` is never read, parsed, or uploaded. Only Administrator receives cleanup controls. Removal requires server-acknowledged re-import or explicit discard and deletes only that key; sign-out, unmount, cancellation, and failure preserve it.
- **Operator workflow:** [The official usage import runbook](../../../docs/official-usage-import.md) records **Reports** (use **Show all** if hidden) > **Usage** > under **Reports**, **Microsoft Copilot > Agents**; selecting each Agents, Users & agents and Users table/tab and its Export CSV action for one 7/30-day period; one-hour source latency; anonymization; source semantics; review/accept; limits; cleanup; and API non-equivalence.

## Migrations 14-15

[Migration 14](../../../backend/src/db/schema.ts) remains checksum-verified and immutable. It:

- removes the restrictive accepted-version-to-staging foreign key;
- stores set actor ownership and version reconciliation independent of staging;
- records idempotent accepted result revision on staging receipts;
- adds runtime guards for staging transitions, set immutability/expiry, and one-step selection revision changes; and
- preserves migration 13 content while allowing short-lived staging cleanup.

Migration 15 is applied to the retained database and is now immutable. It:

- adds `official_usage_bundle_receipts` with content-free immutable result fields and 180-day expiry;
- grants the runtime role only `SELECT, INSERT`, while operator retention owns expiry deletion;
- replaces the accepted-row trigger so runtime inserts are allowed only before membership publication; and
- preserves all nonempty migration-14 accepted content during forward upgrade.

Fresh 1-to-15 creation, nonempty 14-to-15 upgrade, checksum verification, duplicate migrator serialization, failed-migration rollback/retry, restricted grants, real accepted content through staging expiry, independent retention, receipt expiry and published-row append denial are covered. Future schema work starts at migration 16.

## Changed Files

- Backend source: [officialUsage.ts](../../../backend/src/types/officialUsage.ts), [officialUsageParser.ts](../../../backend/src/services/officialUsageParser.ts), [officialUsageViews.ts](../../../backend/src/services/officialUsageViews.ts), [officialUsage repository](../../../backend/src/db/officialUsage.ts), [schema.ts](../../../backend/src/db/schema.ts), [officialUsage routes](../../../backend/src/routes/officialUsage.ts), [app.ts](../../../backend/src/app.ts), [server.ts](../../../backend/src/server.ts), and [config.ts](../../../backend/src/config.ts).
- Backend qualification: [app.test.ts](../../../backend/src/app.test.ts), [officialUsage repository tests](../../../backend/src/db/officialUsage.test.ts), [parser tests](../../../backend/src/services/officialUsageParser.test.ts), [projection tests](../../../backend/src/services/officialUsageViews.test.ts), [database tests](../../../backend/scripts/database.test.ts), [browser fixture](../../../backend/scripts/browser-fixture.browser.ts), [restart seed](../../../backend/scripts/restart-fixture.ts), and [compiled restart runtime](../../../backend/scripts/restart-runtime.mjs).
- Frontend: [App.tsx](../../../frontend/src/App.tsx), [OfficialUsageImportPanel.tsx](../../../frontend/src/components/OfficialUsageImportPanel.tsx), [ReportingView.tsx](../../../frontend/src/components/ReportingView.tsx), [UserAccessView.tsx](../../../frontend/src/components/UserAccessView.tsx), [API client](../../../frontend/src/api/client.ts), [legacyUsageStorage.ts](../../../frontend/src/legacyUsageStorage.ts), usage component tests, and [browser scenarios](../../../frontend/browser/permissions.spec.ts).
- Operations and documentation: [database.ts](../../../backend/scripts/database.ts), [compose.yaml](../../../compose.yaml), [README.md](../../../README.md), [official usage import runbook](../../../docs/official-usage-import.md), [security model](../../../docs/security-model.md), [provider inventory](../../../docs/provider-contract-inventory-2026-09-08.md), package manifests/lockfile, browser evidence, release ZIP, and this record.

## Validation Evidence

| Check / exact command | Environment | Status | Observed result |
| --- | --- | --- | --- |
| Parent RED and focused receipt/repository repair | Docker operator; guarded PostgreSQL | failed, repaired, passed | Exact retry after staging cleanup initially failed. Independent receipt lookup now precedes mutable preview. Final repository 15/15 and migration 16/16 passed together (31/31); the parent exact-retry assertion remains unchanged. |
| Focused HTTP/projection/export boundaries | Docker operator; guarded PostgreSQL | passed | App 25/25, projection 6/6 and CSV streaming 3/3 passed together (34/34). Parser 22/22 also passes. Coverage includes Multer failure recovery, held-work admission, timeout/disconnect rollback, stale additive-field rejection, 100,000 identities, explicit unknowns and listener cleanup. |
| Aggregate source gate: `deploy-local.ps1 -Action Test` | isolated Docker database | failed, repaired, passed | First aggregate found a race test that assumed selection always won. The regression now accepts either valid winner, passed five consecutive focused runs, then the final aggregate passed backend 294/294 in 36 files and frontend 83/83 in 14 files, backend typecheck, zero-warning frontend lint and both production builds. The inherited 771.65 kB main-chunk warning remains unsuppressed. |
| Retained deploy and persistence | retained project plus isolated restore | passed | Initial deploy build found and repaired a missing `activeUsersBasis` test fixture. Final persistence run repeated aggregate validation, applied/verified migration 15, preserved data/credential/origin fingerprints through restart/redeploy, completed native backup/isolated restore and left exactly two healthy services. |
| `permission-browser.tests.ps1` | packaged isolated browser fixture | failed, repaired, passed | First run passed 34/36 but retained a stale generic `Responses` assertion. The source-qualified `Responses (Agents report)` assertion then passed Chromium 36/36 at 1440x1000 and 360x780 plus outer axe fixture 1/1. The generated database was dropped. [JSON evidence](../../../artifacts/phase03/permission-browser-results.json). |
| `restart-runtime.tests.ps1` | actual compiled runtime; guarded databases | passed | The same active set, three lineage records, seven responses and two exact users survived crash/recreate; original bytes retained false. Completed, uncertain and sent-canary replay counts were zero. Both generated databases were dropped. |
| Migration/retention/orchestration | Docker PostgreSQL plus PowerShell | passed | Database migration suite 16/16 covers fresh, nonempty upgrade and failure paths. Local deployment assertions passed 19/19. Migration-15-aware operator retention succeeded. |
| Linux ZIP export and runtime smokes | Docker `linux/amd64`, Node 24.20.0 | passed | Current `artifacts/agent-control-linux-x64.zip` exported (18.82 MB build transfer). Deployed package smoke inspected ZIP exclusions/routes; extracted-ZIP startup passed Linux/x64, secret scan and clean shutdown. |
| Final retained audit | read-only Docker/HTTP/SQL | passed | Exactly healthy `app` and `postgres`; exactly `agentcontrol` and `postgres`; migration max/count 15/15; health/readiness 200; expected callback with `authConfigured:false`; loopback-only app port; no published database port, fixture containers, literal secrets, app admin-secret mount or Docker socket. Seven owned `agentcontrol_test_phase06_*` databases left by earlier interrupted focused commands were inspected and dropped by exact guarded name before this audit. |
| Parent final missing-file and full-baseline reruns, exact commands below | Current source; generated control/child databases | passed | HTTP 25/25 at 09:28 UTC proves three metadata-only requests return `missing_report`, then oversized rejection and a valid upload settle correctly. Deploy at 09:29 and preservation redeploy at 09:32 both passed backend 294/294, frontend 83/83, typecheck, lint and builds. |
| Parent final browser, compiled restart and Linux/x64 package reruns | Current built source; owned isolated fixtures | passed | Browser 36/36 plus outer 1/1; desktop/mobile screenshots inspected. Compiled crash/recover preserved the same active set, three lineage records, seven responses and two distinct users, with zero write replays. Extracted ZIP returned `extracted_zip_runtime: passed`; deployed smoke returned `zipInspected:true`. |
| Parent final preservation, maintenance and inventory | Retained project, 09:33 UTC | passed | Persistence fingerprints, credentials, canonical origin, native backup/isolated restore passed; generated databases removed. Local lifecycle assertions 19/19 and Retain passed. Only the two retained services/databases remain; schema 1-15 verifies; package qualifications remain zero; readiness true and `authConfigured:false`. |

The final Vite main JavaScript chunk is 771.71 kB minified / 223.18 kB gzip and still emits the inherited over-500 kB warning. No threshold or lint rule was suppressed. The route-policy enumeration test emits the pre-existing unused-session-secret deprecation warning; real session/HTTP tests and the packaged runtime pass.

### Exact Parent Commands

The final source was validated with the following host PowerShell entry points. Each application, database, build and browser operation runs in the existing Docker targets:

```powershell
pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01
pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01
pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01
pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001
pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1
pwsh -NoProfile -File ./deploy-local.ps1 -Action Retain -Project agent-control-phase01
```

The immediate parent HTTP check used this generated control database and current-source mount. The same invocation with `src/db/officialUsage.test.ts` exposed the bundle-retry failure before migration 15. Test helpers create/drop their own guarded child databases; the outer `finally` removes only this command's control database:

```powershell
$ErrorActionPreference = "Stop"
$databaseName = "agentcontrol_test_" + [Guid]::NewGuid().ToString("N")
docker compose --project-name agent-control-phase01 exec -T postgres psql `
	-U agentcontrol_admin -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $databaseName"
if ($LASTEXITCODE) { throw "Control database creation failed" }
try {
	docker run --rm --network agent-control-phase01_default `
		--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" `
		--mount "type=bind,source=$PWD/backend/src,target=/app/backend/src,readonly" `
		--mount "type=bind,source=$PWD/backend/scripts,target=/app/backend/scripts,readonly" `
		-e PGHOST=postgres -e PGUSER=agentcontrol_admin -e "PGDATABASE=$databaseName" `
		-e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app `
		--entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- src/app.test.ts
	$testExit = $LASTEXITCODE
} finally {
	docker compose --project-name agent-control-phase01 exec -T postgres psql `
		-U agentcontrol_admin -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE $databaseName WITH (FORCE)"
	if ($LASTEXITCODE) { throw "Owned control database cleanup failed" }
}
if ($testExit) { throw "Focused HTTP regression failed ($testExit)" }
```

Exact final package/extracted-runtime commands, with existing runtime-only secret files mounted read-only and no provider credentials supplied:

```bash
docker build --platform linux/amd64 --target package -t agent-control-phase01-package .
docker build --platform linux/amd64 --target export --output type=local,dest=artifacts .
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
	-e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
	-e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
	--entrypoint node agent-control-phase01-package backend/scripts/zip-runtime-smoke.mjs
docker run --rm --network agent-control-phase01_default \
	--mount "type=bind,source=$PWD/artifacts,target=/evidence,readonly" \
	agent-control-phase01-operator:local backend/scripts/package-smoke.ts \
	http://app:3001 /evidence/agent-control-linux-x64.zip
```

## Open Issues

No new Phase 06 implementation defect, failed required local check, or cleanup incident remains. No approved real tenant export was supplied, so this phase does not claim live tenant data, tenant eligibility, report availability or source freshness; sanitized fixtures qualify application behavior without fabricating Microsoft service evidence. Manual source acquisition is the intended product boundary.

| ID / origin | Affected scope / evidence | Containment | Signal / threshold | Owner | Exact fix-forward trigger |
| --- | --- | --- | --- | --- | --- |
| P06-LIVE-SOURCE | Actual tenant availability and export-schema qualification are unavailable because retained authentication is unconfigured and no approved tenant exports were supplied | Manual import only; strict schema rejection preserves active data; operator assertions never become known source freshness; no extra API permission or automatic acquisition | Any schema drift, missing admin-center Agents export, or claim of tenant qualification based only on fixtures | Tenant reporting administrator and Phase 13 live qualification owner | Configure the existing approved identity through restricted inputs, obtain the three original same-period exports under approved data scope, and run the documented preview/accept workflow; retain only safe counts/schema/provenance evidence and never original bytes. If the portal export is unavailable, leave official usage unavailable without substituting another source. |

Inherited [P05 package provider limitations](05-package-management.md#open-issues), [P04-LIVE-INVENTORY](04-power-platform-inventory.md#open-issues), [P01-LIVE-IDENTITY](01-domain-persistence-foundations.md#open-issues), and [P01-BUNDLE-SIZE](01-domain-persistence-foundations.md#open-issues) remain owned by their originating phases.

## Phase 07 Preconditions

Phase 07 may consume checksum-verified migrations 1-15, durable jobs, multi-resource Graph authentication, independent app roles, Permission Center evidence, exact source identities, the separate local administrative audit, and backend-owned official usage. It must preserve official usage and Purview audit as separate authorities.

Phase 07 may not update official usage from audit events, infer report/package identity from display values, retrieve transcript content, create recurring collection, or assume tenant permission/license success. Migration 16 is the next schema version. No Purview grant, live query, tenant data, or provider capability was activated or qualified here.

## Next Session

```text
Implement only plans/admin-poc-production/07-graph-audit-search.md.
Read the binding README and Phase 01-06 completion records. Preserve migrations
1-15, the retained agent-control-phase01 volume/secrets, and the backend-owned
official usage authority. Start any schema work at migration 16. Keep audit and
official usage separate; do not retrieve transcripts or add recurring collection.
Use Docker and isolated fixtures. Do not change provider grants without explicit
approval, commit, push, deploy Azure, create campaign bookkeeping, or continue
beyond Phase 07.
```

This session stopped after Phase 06. Phase 07 was not implemented.