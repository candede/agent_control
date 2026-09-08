# Phase 01 - Domain, Persistence, and Provider Foundations

## Mission

Create the minimal PostgreSQL foundation and the complete Docker-only local deployment used by all later phases. Replace process-memory session/job state, preserve legacy audit history and serve the current React build from Express in one app container. Do not activate future integrations or alter the running Azure revision.

## Prerequisites

- Read `plans/admin-poc-production/README.md` and honor all binding architecture and production-continuation rules.
- No prior phase completion record is required.
- Preserve unrelated changes. Do not commit, push or deploy to Azure. Local deployment and validation through the new `deploy-local.ps1` are required.

## Read first

- `backend/src/config.ts`
- `backend/src/server.ts`
- `backend/src/types/session.ts`
- `backend/src/services/auditLog.ts`
- `backend/src/services/bulkJobs.ts`
- `backend/src/routes/agents.ts`
- `infra/main.bicep`
- `deploy-production.ps1`
- Root and workspace `package.json` files

## Required implementation

1. Use a supported PostgreSQL driver/migration library, bound parameters, short transactions, UTC and a small capped pool. Pin one supported PostgreSQL major compatible with Azure Flexible Server. Serialize explicit migrations and reject unknown/newer schema or modified applied migrations. Test fresh/upgrade/rollback/retry. No SQLite runtime adapter, Cosmos adapter or generic database framework. Own bootstrap/grant SQL for the README's two fixed logins: operator-owned schema/migrations and restricted runtime DML, with audit SELECT/INSERT but no UPDATE/DELETE/TRUNCATE, object ownership or role escalation. Disable library auto-DDL, including session-store table creation, in runtime. Azure consumes these same commands; do not require cloud-superuser privileges that Flexible Server does not provide.
2. Create only the shared tables required now: durable sessions, on-demand jobs/items/attempts/leases, tenant-scoped source identifiers, and append-only administrative audit. Use small typed repositories and explicit transactions, not a generic framework. Phase 02 owns capability/configuration schema; Phase 04 owns allowlisted inventory snapshots and exact-ID associations; Phase 06 owns reports. Do not add raw-payload, collector, identity-review, or unused future tables.
3. Distinguish tenant, principal, source, source-native identifier kind/value, environment, job/item and provider event IDs. Enforce uniqueness only under documented provider scope. Store typed allowlisted observations in their owning provider tables, not a universal raw JSON store.
4. Implement bounded job claiming with database-time expiring leases and owner/version checks on result commits. This prevents overlapping attempts after restart; it is not a scheduler or a multi-instance product. Lease loss stops unsent work but cannot undo a remote write already sent. Test competing attempts locally; no cloud scale-out requirement.
5. Replace in-memory bulk-job state and all single/bulk/block-all mutation dispatch paths with the durable job/item contract. Store tenant, initiating principal, token mode, capability, target, immutable request hash, and scoped idempotency key, never a bearer token or closure. Preserve workflows, but atomically update backend/frontend job status consumers and tests, with no legacy `completed` alias. Until Phase 02 can reacquire delegated credentials, restart-recovered delegated work waits for reauthorization; never replay an uncertain provider write. Persist intent before dispatch and reconcile uncertain outcomes by read in Phase 05.
6. Replace Express's memory store with a maintained PostgreSQL-backed session store on the same database. Regenerate IDs at login, purge expired sessions, and keep tokens out of serialized sessions. Update all async callers and existing audit routes/tests. Administrative audit records become append-only events with a read projection; do not continue updating the original `started` row to represent completion.
7. Separate minimal public liveness from database/schema readiness and authenticated diagnostics. Support a maintenance switch that denies new jobs/mutations and stops unsent work while health and controlled recovery remain available. Phase 12 uses this for maintenance-window deployment; no slots are required.
8. Validate finite request/page/result sizes, retry/attempt/deadline limits, job age and ordinary retention. In-process execution services only explicitly submitted jobs; no recurring provider collection or automatic startup refresh.
9. Provide supported local PostgreSQL backup/restore commands with isolated-target and count/schema checks. Native Azure recovery is owned by Phase 12. Build `backend/scripts/import-legacy-audit.ts` as an operator-only reader of a SQLite-safe backup, excluded from runtime. Preserve existing audit rows with deterministic source IDs and count/content checks in a transactional receipt keyed by backup checksum. Keep unknown legacy tenant attribution in restricted history; never guess it. Same-backup retry is idempotent, malformed/changed input fails without partial import, and startup never imports or resets data. Phase 12 executes the production import. Existing in-memory jobs/sessions cannot be recovered from SQLite; require login and reconcile legacy writes without replay.
10. Keep the existing report browser-local authority untouched until Phase 06 performs its direct migration and cutover. Do not add a second report writer now.
11. Own root `Dockerfile`, `.dockerignore`, `compose.yaml` and `deploy-local.ps1`. Multi-stage build/test/runtime/export targets build both workspaces inside Docker; no host npm/Node/Vite/PostgreSQL dependency. Runtime contains one Node process serving Express and the built React assets, not a second frontend process. The two long-running Compose services are `app` and `postgres`, with a project-scoped bridge network, named database volume and only the loopback-bound app port exposed. Preserve outbound app HTTPS/DNS to Entra/providers; do not confuse unpublished DB ports with an egress-blocked Compose network. Do not mount the Docker socket in the app. Exclude local secrets, uploads, SQLite files, tests and credentials from production image/artifact layers. Publish an Azure Linux-target ZIP export from the same build, with runtime/architecture compatibility checks rather than assuming the developer host architecture.
12. Move minimum combined static serving/package ownership here from Phase 10. API/auth/health take precedence over SPA fallback; unknown API routes and missing assets return errors, not HTML. Preserve existing login and UI behavior with one configured origin/callback, safe asset paths and appropriate caching. Add basic routing/package smoke now; Phase 02 owns strengthened auth policy and Phase 10 extends integrated UI/security checks, not a second packaging implementation.
13. `deploy-local.ps1` checks PowerShell 7/Docker/Compose, validates paths/ports/config, creates/reuses scoped local secrets/network/volume, builds, starts PostgreSQL and waits boundedly for readiness. Use a temporary operator command container for bootstrap/migrations, removed before starting the runtime app; the app never receives admin credentials. Start app, wait for HTTP/database/schema health and print exact URL/configuration status. On failure exit nonzero with safe logs, retain existing data and do not announce success. All database/backup commands run in containers.
14. Support the README local secret/config contract, using ignored restricted files mounted at runtime and no secret prompts via AI/chat. Own and document exact file paths, formats, permissions and mount consumers in the repository README. Generate local-only DB/session values once and preserve them on repeat runs; accept tenant/client IDs and securely entered Entra credentials. Missing/corrupt DB secrets with an existing volume must stop with recovery instructions, never regenerate passwords or reset data. Never auto-create fake identities or enable a production auth bypass. Document default local Entra reply URL and unconfigured-sign-in behavior. Before combining origins, document the old browser-report key/origin and re-import/explicit cleanup procedure; retain old browser data. The new origin cannot detect/read it, and no automatic cross-origin migration or deletion is permitted.
15. Make reruns idempotent for the same Compose project: stop app admission before migration, preserve volumes/credentials, verify schema and restart without losing reports/audit. Document safe stop/start, containerized tests and backup/restore; destructive volume reset requires explicit project/volume confirmation and is never part of normal deploy. Declare exact Docker Compose test/build invocations and temporary test targets. Use separately named disposable PostgreSQL test databases with a target guard preventing demo/production database cleanup; SQLite and rollback-only isolation against demo data are not substitutes. Record the test origin, network and setup/teardown commands for Phase 03's browser harness, which extends this container foundation. Local deployment needs no Azure subscription/vault; optional live provider work still needs real approved Entra setup.

## API and domain contract

- Provider adapters return typed observations; Phase 02 adds the typed capability decision contract. Route code must not parse provider-specific JSON.
- Provider-owned records retain source/native IDs, observed time, scope, schema version and only allowed typed fields. Discard the original response after validation; unknown fields are omitted with safe schema diagnostics.
- Keep current snapshots and the bounded history explicitly required by a retained feature. Do not build a general event-replay or immutable-observation warehouse.
- Job states are `queued`, `running`, `waiting_authorization`, `succeeded`, `failed`, `cancelled`, and `partial`; per-item outcomes also distinguish `inconclusive` and `skipped`. Cancellation stops unsent items, not remote work already accepted. Uncertain items keep the aggregate `partial` until reconciled; terminal item success is never replayed.
- Evidence states use `passed`, `failed`, `not_run`, `unavailable`, or `inconclusive`.

## Security and privacy

- Do not persist access/refresh tokens, client secrets, or unrestricted provider payloads. Phase 02 uses MSAL's in-memory token cache; no token encryption repository is needed.
- Ensure SQL parameters are bound, JSON size is bounded, logs are structured and redacted, and health responses expose no filesystem paths.
- Use tenant/principal filtering for jobs, sessions, snapshots and audit from the start. Phase 02 adds role/capability enforcement before new integrations activate. Expired/replaced job owners cannot commit an item.

## Focused validation

- Migration tests: fresh database, sequential upgrade, failed migration rollback, duplicate startup, unknown newer schema, runtime DDL/audit mutation denial and successful operator-only bootstrap/retention.
- Repository tests: session expiry, job recovery, lease ownership/expiry, exact source-ID scope, append-only audit, and maintenance denial of new work.
- Backup test: write fixture data, restore to an isolated PostgreSQL database, verify constraints and required counts/hashes.
- Legacy importer tests: current/older audit fixtures, unknown tenant, duplicate run, changed checksum, malformed rows, interruption/rollback, exact count/hash preservation, and absence of SQLite imports from server runtime.
- Job API tests: updated frontend terminal/polling states, idempotency request mismatch, authorization wait on restart, stale fence rejection, cancel-after-dispatch, and no automatic ambiguous write replay.
- Existing agent, audit, and bulk-job tests must continue to pass.
- PowerShell syntax and mocked orchestration tests: unavailable Docker/Compose, occupied port, paths with spaces, database/app startup timeout, failed build/migration, secret redaction, repeat deploy, missing/corrupt secrets with an existing volume and explicit-reset denial. Run application/test tools in Docker, not host npm.
- Docker integration: clean start through `deploy-local.ps1`, exactly two healthy long-running containers, one frontend/API origin, no published DB port, persistent data/credentials across recreate, no admin credential in runtime and complete cleanup of temporary migration/test containers. Restore a fixture backup into an isolated database without touching demo data.
- Built-app routing: assets/deep links, API 404, missing asset 404, auth callback precedence, traversal denial and container-only operation without a host Node toolchain. Inspect image/ZIP for secret exclusion and Linux target compatibility.

## Aggregate validation

Run the README baseline inside Docker and invoke `pwsh ./deploy-local.ps1` end to end with isolated local fixture configuration. Recreate the app container during a fixture bulk job: unsent delegated work waits for reauthorization, uncertain sent work stays inconclusive and completed items never replay. Explicitly authorized test resume proves eventual completion. Repeat local deployment and verify data, origin and two-container health are unchanged; restart alone never authorizes a write.

## Production continuation

Non-passing local or restore evidence does not terminate the campaign. Repair reproducible defects; otherwise record exact containment, keep affected background processing disabled, preserve liveness/read-only package behavior, and carry the residual with telemetry, owner, threshold, and fix-forward trigger.

## Scope guard

Do not implement new provider calls, scheduled collection, raw archives or future ideas. Do not change official usage authority. Do not implement/run the Azure wizard or deploy remotely. Minimum static serving and the local script are required here, not deferred to Phase 10.

## Completion record

Create `plans/admin-poc-production/completions/01-domain-persistence-foundations.md` with schema/role/bootstrap contract, local script/container/artifact paths, exact containerized test/build/migration commands, local URL/configuration guidance, recovery/rerun proof and Phase 02 preconditions.

## Done conditions

- The new application uses PostgreSQL-only runtime persistence with durable sessions and jobs; the existing production deployment is unchanged.
- Sessions, on-demand jobs and append-only audit have one database authority. The standalone legacy audit importer is tested for Phase 12.
- Existing functionality and aggregate validation have truthful results.
- Phase 02 can add auth/capability policy without a persistent token store or persistence redesign.
- `deploy-local.ps1` builds/starts the current app plus PostgreSQL in exactly two long-running containers without host app processes. Later phases reuse its package, commands, data volume and stable secret/config contract.
