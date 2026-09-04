# Phase 13 - Security, Operations, Retention, and Recovery

## Mission

Harden the complete application for production deployment: threat model and enforce trust boundaries, make auditing tamper-evident, instrument actionable telemetry, exercise retention/backup/recovery, and establish operational runbooks and measurable service objectives.

## Prerequisites

- Read the roadmap and completion records for Phases 01-12.
- All application features, data classes, routes, workers, exports, and UI personas must be present.
- Do not deploy in this phase; produce deployment-ready artifacts for Phase 14.

## Read first

- Entire backend middleware/server/config/auth/provider/job/persistence surface
- Entire frontend API/auth/content-rendering surface
- Infrastructure, Static Web Apps config, deployment script, package manifests/lockfile
- All migrations, retention, encryption, backup, export, audit, capability, and health code
- Current Microsoft identity, OWASP ASVS, Express production, Azure App Service, Key Vault, and Application Insights guidance

## Required implementation

1. Add a checked-in threat model and data-flow diagram covering browser, Static Web Apps, App Service, Entra, Graph, Power Platform, Dataverse environments, Office Management API, Key Vault, database, telemetry, backups, exports, and admin operators. Classify official usage, identities, audit, security, and transcripts; list abuse cases and controls.
2. Centralize authentication/authorization. Validate issuer, tenant, audience, nonce/state, token cache ownership, session regeneration/expiry/revocation, internal app roles, capability, target tenant/environment, and recent-auth requirements. Add deny-by-default route metadata tests.
3. Implement CSRF protection for all state-changing cookie-authenticated routes, strict CORS allowlist, secure cookie prefixes/attributes where hosting permits, body/content-type limits, request timeouts, slow-client protection, and trusted-proxy validation.
4. Define a production Content Security Policy compatible with Vite assets, no unsafe inline/eval, clickjacking protection, HSTS, nosniff, strict referrer/permissions policies, safe cache headers, and Static Web Apps fallback rules that never rewrite `/api` errors to HTML.
5. Apply per-user, per-IP, per-tenant, and per-operation rate/concurrency limits with stricter budgets for login, consent, probes, searches, exports, reveals, imports, and mutations. Distributed enforcement must use the database after Phase 14 and fail safely.
6. Validate every outbound URL through provider-specific fixed origins and cloud/environment allowlists. Revalidate redirects and next links, block private/link-local metadata endpoints, use DNS/TLS defaults safely, and test SSRF variants.
7. Standardize `application/problem+json` errors and structured logs with request/operation/job/provider correlation. Add a redaction allowlist so tokens, secrets, cookies, auth codes, transcript text, report rows, KQL results, and raw provider payloads cannot enter logs/telemetry.
8. Make local administrative audit append-only and tamper-evident with per-tenant hash chaining. Sign periodic chain heads with a non-exportable Key Vault key and store timestamp, tenant-safe identifier, root hash, signature, key version, and schema version in a separately authorized immutable Azure Blob container with retention. Do not store the only checkpoint copy in PostgreSQL or ordinary application logs. Verify chains and external checkpoints on demand/startup samples, alert on breaks, and document that this detects but cannot by itself prevent deletion by a principal that controls both stores.
9. Instrument OpenTelemetry/Application Insights metrics and traces for HTTP latency/errors, provider latency/status/throttle, capability state changes, token errors, job/lease/checkpoint state, collector lag/gaps, schema drift, identity conflicts, mutation verification, exports/reveals, encryption failures, retention, backup, and restore.
10. Define liveness, readiness, and deep authenticated diagnostics. Readiness covers schema, database, encryption keys, lease system, and critical configuration; optional provider failure degrades capability but does not kill the process. No health route exposes secrets or sensitive topology.
11. Add configurable retention/hold/purge policies for sessions, token cache, provider observations/raw evidence, normalized history, official usage, local/provider audit, Defender results, transcripts, jobs, exports, backups, and logs. Purges are dry-runnable, leased, idempotent, audited, and hold-aware.
12. Exercise backup/restore and disaster recovery with representative encrypted synthetic data. Verify database integrity, migrations, encryption keys/versions, audit chains, jobs/checkpoints, report lineage, and no duplicate collector replay. Record RPO/RTO measurements rather than aspirations.
13. Add bounded performance/load tests for inventory paging, concurrent readers, report import, provider job queues, audit ingestion, transcript parsing/encryption, exports, and multi-instance lease contention. Establish explicit POC SLOs and capacity ceilings with alert thresholds.
14. Add dependency/license/secret/static analysis commands, lockfile integrity, production dependency audit, SBOM generation, build artifact manifest/checksums, and container/zip content inspection. Resolve actionable high/critical issues or contain them with owner/expiry; do not suppress findings without rationale.
15. Create runbooks for auth/consent, role/licensing, provider outage/throttle/schema drift, Management Activity gap, Defender no-data, transcript privacy incident, key rotation/loss, database saturation, migration failure, audit-chain break, backup restore, rollback/fix-forward, and preview API withdrawal.
16. Add startup/configuration tests that reject development bypasses, permissive origins, plaintext transcript mode, raw export, advanced KQL, missing encryption keys, unsafe retention, or SQLite when `NODE_ENV=production` after the Phase 14 cutover.

## Focused validation

- Automated threat-control tests for IDOR, CSRF, role/capability bypass, cross-tenant/environment access, session fixation, callback/state replay, SSRF, redirect abuse, oversized/slow inputs, CSV/formula injection, stored/reflected XSS, and sensitive logs.
- Audit-chain tamper/recovery/checkpoint tests; encryption/key-rotation/tamper/purge tests.
- Retention/hold/dry-run/restart/lease tests for every data class.
- Backup/restore drill and measured RPO/RTO with encrypted synthetic content.
- Load/capacity tests with explicit pass thresholds and resource observations.
- Dependency, SBOM, artifact, and production configuration checks.

## Aggregate validation

Run the global validation baseline, full Playwright suite, security suite, load smoke profile, artifact checks, and backup/restore drill. Record real statuses and residuals.

## Production continuation

Security findings never disappear into a generic waiver. Repair reproducible defects; otherwise disable the affected feature, constrain exposure, add telemetry/alerting and an owner/expiry/trigger, then continue to Phase 14. A failure in core auth, tenant isolation, transcript encryption, or database integrity requires fail-closed containment of that surface before deployment, not cancellation of unaffected deployment.

## Scope guard

Do not add product features or provider permissions. Do not deploy. Do not claim certifications or compliance guarantees.

## Completion record

Create `plans/admin-poc-production/completions/13-security-operations.md` with threat model changes, test/scanner findings, SLO/capacity, RPO/RTO, runbooks, contained residuals, artifact checksums, and exact Phase 14 preconditions.

## Done conditions

- Trust boundaries, app roles, tenant/environment isolation, input/output/egress controls, and sensitive-data handling are tested.
- Audit, telemetry, alerts, retention, backup, restore, performance, dependencies, and runbooks are operationally credible.
- Every residual has explicit containment and fix-forward ownership.
- Production infrastructure can consume deterministic artifacts and health signals.
