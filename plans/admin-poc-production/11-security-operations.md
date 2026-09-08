# Phase 11 - Security and Basic Operations

## Mission

Verify the retained application's security boundaries and deliver small, usable operations runbooks, ordinary retention, backups and measured recovery/capacity evidence. Do not build an audit cryptography or maintenance platform.

## Prerequisites

- Follow the README's fresh-session contract. Read Phase 10's completion and linked issues, Phase 02 security/auth/vault setup, Phase 01 Docker/local script/backup/import/jobs and Phase 05 canary artifacts.
- Retained routes, data classes and the single-app artifact exist. Earlier owners implemented their security baseline; repair gaps in that code instead of inventing parallel controls.
- No Azure deployment; use local Docker checks and deliver the operating limits/commands to Phase 12.

## Read first

- `docs/security-model.md`, `docs/deployment-setup.md`, `docs/mutation-canaries.md` and delivered auth/middleware/configuration tests
- Provider URL/response validation, scoped repositories, on-demand job transitions, audit, retention and exports
- Phase 10 packaged server/static routing, package manifests/lockfile and existing Azure release assets
- Current Express/MSAL, OWASP, App Service, PostgreSQL, Key Vault and managed monitoring guidance

## Required implementation

1. Complete `docs/security-model.md` against the actual single-origin design: browser, Express, Entra/providers, PostgreSQL, Key Vault, telemetry, temporary files, backups and operators. Test the four-role/data-scope matrix and deny-by-default routes, including saved results, counts, import preview and exports.
2. Verify issuer/tenant/audience, state/nonce/PKCE, safe returns, session regeneration/expiry/logout, recent claims, CSRF, canonical origin and trusted proxy behavior. Never trust supplied identity headers. Persist no MSAL tokens/cache; prove cache-loss reauthentication and account-scoped eviction without plaintext token storage.
3. Verify body/content/timeout limits, provider fixed origins, redirects/next links, SSRF/private-metadata targets, safe CSV exports and inert stored content. Review production CSP, HSTS, nosniff, framing/referrer policies and API/static caching/routing against Phase 10's built app.
4. Tune existing finite per-user/IP/operation admission, upload/export/search and provider budgets for the single instance. Use bounded local rate-limit libraries where sufficient and database job admission for durable work; do not build distributed rate-limit/scale infrastructure. Restart must not bypass durable job/remote-write safety.
5. Keep ordinary append-only administrative audit. Verify Phase 01's two fixed DB logins and bootstrap/grants: runtime inserts/reads audit but cannot update/delete/truncate it, own schema objects, create tables or assume the admin role; controlled operator retention deletes expired rows. Test attempts/outcomes and legacy import provenance. Inspect local mounts and Azure setting specifications for admin-password exclusion from the app. Document that this is not cryptographic tamper proof against privileged database administrators. No chains, signatures, signing keys, immutable Blob checkpoints, outboxes or signed retention receipts.
6. Use existing managed telemetry where possible: redacted structured HTTP/provider/job correlations, latency/errors, throttling, capability changes, job age/failures, uncertain writes, schema drift, storage and cleanup/backup failures. Do not add an additional telemetry stack solely for this POC. Logs exclude tokens, cookies, auth codes, report rows and provider result bodies.
7. Provide minimal public liveness/readiness and authenticated safe diagnostics. Database/schema/core config failure blocks readiness; optional provider failure affects only its capability. Check maintenance admission and suspended unsent work. No health disclosure of secrets, internal network details or sensitive record counts.
8. Consolidate ordinary retention for sessions, expired job/results, provider snapshots, official reports, local/provider audit, exports, logs and backups. Each class has a finite documented default, a single owning cleanup path, safe batch limits and failure reporting. Audit/report deletion follows existing role/confirmation policy. No hold engine, token-store policy, custom content encryption or external deletion ledger.
9. Provide an operator-only cleanup command with target confirmation and dry run, not a browser maintenance endpoint. Apply dependent projection/export invalidation and use existing job ownership or a short database lock to avoid competing cleanup. Preserve minimal non-content audit metadata where appropriate. Document finite backup retention and restore limitations honestly.
10. Exercise supported logical backup/restore into an isolated PostgreSQL target using synthetic retained data. Verify schema, counts, report selection, job/audit integrity and data scope. A restored app starts in maintenance with provider work disabled; invalidate restored sessions, expire old ownership, apply current retention and review any known deletions before opening. If current deletion/access changes cannot be established, purge the affected restored cached datasets rather than expose them. Never replay uncertain provider writes. No promise of automatic cross-backup privacy suppression.
11. Measure backup/restore time and recoverable data age; record observed RPO/RTO, not HA guarantees. Native Azure point-in-time restore is exercised in Phase 12 with the same reopening checks. Rehearse Phase 01's legacy-audit-only importer against the complete current schema; sessions/jobs were in memory and are not imported.
12. Add a bounded local/cache-only load profile for paging, concurrent readers, CSV staging/acceptance, on-demand queues and exports inside Docker with isolated test data. Record request/job/pool/memory/storage ceilings and a small set of latency/error/job-age thresholds with owners. Evaluate the README's small App Service/Burstable PostgreSQL target and CPU-credit limits; local measurements do not prove Azure throughput. Require a new cost preview/approval for a larger tier, not an automatic upgrade. Competing-job/restart tests run locally; cloud multi-instance qualification is not required.
13. Run dependency/license/secret/static checks and inspect the production package for secrets, local databases, uploads, test fixtures and dev bypasses. Add a repeatable release manifest with revision and artifact checksum; no per-file phase ledger, mandatory SBOM program or bespoke supply-chain framework. Fix actionable findings or contain affected paths with evidence.
14. Own `docs/operations.md` with exact commands for auth/consent/role setup, provider outage/schema drift/no-data, uncertain write reconciliation, credential expiry/replacement, ordinary retention, maintenance, backup/restore, migration failure and compatible recovery/fix-forward. Reference Phase 02's vault preparation and Phase 01's local secret paths/backup commands instead of duplicating them. Document containerized local stop/start, retained volume/secret recovery and explicitly confirmed reset. Azure releases use only `deploy-azure.ps1`. Credential rotation remains a separately approved administrator runbook: coordinate DB passwords with prepared vault versions under maintenance, refresh native references/restart, verify least privilege and invalidate sessions when replacing their secret; the wizard never silently rotates values. Document continuing paid-resource charges and teardown/backup implications with current Azure references, not a promise that stopping an app eliminates cost. No transcript/feed/audit-signature runbooks.
15. Provide `infra/production-target.example.json` and `infra/qualification-targets.example.json` as minimal non-secret examples: exact resource/tenant/app/origin boundary, existing vault resource ID, region, selected app/database SKUs and limits, estimate currency/date/source, approved budget, maintenance approval, optional test personas/native canary targets, allowed actions, expiry and restoration owner. Store no secret values or connection URLs. They are not approvals. Phase 12 verifies real target approval and current prices; never infer authorization from CLI state or add a second wizard.
16. Reject production fixture/bootstrap auth bypass, permissive origins, SQLite runtime, unbounded retention and unsupported raw-data/KQL options. Verify the six prepared-vault names and five runtime consumers from the README, least-privilege access and short-lived bootstrap secret cleanup. Keep one password-based DB contract, not a managed-identity/password fallback matrix. No mandatory certificate redesign or persistent token-cache encryption.

## Focused validation

- IDOR/role/scope denial, CSRF, session fixation/replay, callback/return URL, SSRF/redirect, oversized input, CSV/XSS and log-redaction tests.
- Real PostgreSQL runtime audit update/delete denial, maintenance-only retention, dependency invalidation and cleanup retry/expiry.
- Isolated restore with revoked sessions, cache-loss reauthentication, expired job owners, current retention/deletion review and uncertain writes not replayed.
- Single-app production configuration/package inspection, bounded load thresholds and secret/dependency checks.
- Importer idempotence/rollback/count checks against current schema; no import of unrecoverable legacy sessions/jobs.
- Local missing-secret recovery without destructive reset; runtime/admin separation; secret redaction in container configuration, command arguments, package layers and deployment receipts; coordinated administrator rotation and expiry guidance.

## Aggregate validation

Run the README baseline, PostgreSQL integration tests, packaged-app browser/security suite, bounded load profile, artifact checks and isolated backup/restore drill inside Phase 01/03's Docker targets. Host PowerShell/static checks are allowed; no host app/test database/browser automation installation is required. Record actual results and exact commands/prerequisites for release; no provider traffic in load tests.

## Production continuation

Repair reproducible defects and keep unsafe affected paths closed with actionable residuals. External test/provider unavailability is honest evidence, not a reason to abandon production. Broken core auth or database integrity keeps implementation in progress until repaired, never disguised as an optional capability. Phase 12 deploys the safe artifact under the README contract.

## Scope guard

No product features, provider grants, custom audit/content cryptography, maintenance UI, recurring provider collectors or cloud deployment. Do not claim compliance certification or high availability.

## Completion record

Create `plans/admin-poc-production/completions/11-security-operations.md` with changed security contracts, actual test/scanner/load/restore results, finite operating defaults, runbook commands, linked issues and Phase 12 preconditions. Do not duplicate earlier issue tables.

## Done conditions

- Retained data/actions have tested auth, scope, input/output/egress and redaction controls.
- Ordinary audit/retention, safe restore, job recovery, monitoring and operator commands are usable with truthful evidence.
- Phase 12 has a single tested artifact contract, limits and an approved-target template, not an enterprise operations framework.
