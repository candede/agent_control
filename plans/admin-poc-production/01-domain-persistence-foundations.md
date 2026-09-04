# Phase 01 - Domain, Persistence, and Provider Foundations

## Mission

Create the durable backend foundation for every later provider without activating unimplemented Microsoft integrations. Replace process-memory production authorities for sessions and jobs, introduce transactional schema migrations, and define source-aware identities and bounded ingestion primitives.

## Prerequisites

- Read `plans/admin-poc-production/README.md` and honor all binding architecture and production-continuation rules.
- No prior phase completion record is required.
- Preserve unrelated worktree changes. Do not commit, push, or deploy in this phase.

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

1. Add an ordered, transactional SQLite migration runner using the existing Node 24 `node:sqlite` stack. It must support fresh creation, upgrade, a migration ledger, one transaction per migration, startup failure on unknown/newer schema, and deterministic tests. Never mutate an applied migration.
   Isolate SQLite adapters behind explicit repository and transaction contracts so Phase 14 can perform one global PostgreSQL cutover without changing service/domain callers or retaining dual runtime authorities.
2. Create backend-owned tables and repositories for:
   - durable Express sessions with expiry and purge;
   - durable background jobs, attempts, leases, progress, cancellation, and structured errors;
   - provider configurations without secret values;
   - provider capability probe results and evidence timestamps;
   - provider checkpoints and immutable source observations;
   - normalized agents, source identifiers, identity links, and unresolved identity conflicts;
   - imported report runs and local administrative audit events.
3. Distinguish `tenantId`, normalized `agentId`, provider/source, source-native ID, environment ID, observation ID, ingestion run ID, provider event ID, and revision/checkpoint. Enforce uniqueness only where the provider contract guarantees it.
4. Implement a single-writer lease for scheduled ingestion. The lease must be transactional, expiring, renewable, owner-fenced, safe after crashes, and usable even though production remains one App Service instance.
5. Replace in-memory bulk-job state with the durable job repository. Preserve the public behavior, add restart/recovery tests, and fence stale workers so they cannot overwrite terminal job state.
6. Replace Express's default memory session store with a tested `node:sqlite`-backed store using the existing database authority. Regenerate IDs at login, purge expired sessions, and retain current cookie security behavior.
7. Add readiness details that distinguish process liveness, database/migration readiness, lease readiness, and auth configuration without disclosing secrets.
8. Add finite defaults and configuration validation for request bytes, page size, provider retries, job attempts, lease duration, job age, observation bytes, and retention. Reject invalid or unsafe production defaults at startup.
9. Add a backup/checkpoint service for the SQLite database that uses SQLite-safe backup semantics, records metadata, never copies a live WAL database with an unsafe file copy, and supports a non-destructive restore verification command against a temporary path.
10. Keep the existing report browser-local authority untouched until Phase 06 performs its direct migration and cutover. Do not add a second report writer now.

## API and domain contract

- Provider adapters must return typed observations and typed capability failures; route code must not parse provider-specific JSON.
- Every observation stores source, source-native ID, observed time, schema version, content hash, and bounded raw payload where policy allows.
- Raw payloads are evidence, not normalized authority. Projection rebuilds must be deterministic.
- Job states are `queued`, `running`, `succeeded`, `failed`, `cancelled`, and `partial`; attempts and item failures remain queryable.
- Evidence states use `passed`, `failed`, `not_run`, `unavailable`, or `inconclusive`.

## Security and privacy

- Do not persist access tokens, refresh tokens, client secrets, transcript content, or raw audit content in this phase.
- Ensure SQL parameters are bound, JSON size is bounded, logs are structured and redacted, and health responses expose no filesystem paths.
- Production remains explicitly single-instance until a future shared-database migration. Enforce and document that constraint rather than implying high availability.

## Focused validation

- Migration tests: fresh database, sequential upgrade, failed migration rollback, duplicate startup, unknown newer schema.
- Repository tests: session expiry, job recovery, lease acquisition/renewal/fencing, observation deduplication, identity conflict retention.
- Backup test: write fixture data, checkpoint safely, restore to a temporary database, run integrity check, compare required counts/hashes.
- Existing agent, audit, and bulk-job tests must continue to pass.

## Aggregate validation

Run the global validation baseline from the roadmap. Also restart the backend during an active fixture bulk job and prove recovery to a correct terminal state.

## Production continuation

Non-passing local or restore evidence does not terminate the campaign. Repair reproducible defects; otherwise record exact containment, keep affected background processing disabled, preserve liveness/read-only package behavior, and carry the residual with telemetry, owner, threshold, and fix-forward trigger.

## Scope guard

Do not implement provider authentication, Power Platform, Purview, Defender, Management Activity, quarantine, or Dataverse calls. Do not change the official usage authority. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/01-domain-persistence-foundations.md` with the roadmap-required fields, schema version, recovery evidence, and exact Phase 02 preconditions.

## Done conditions

- All production state used by current sessions and bulk jobs is durable and restart-tested.
- Migrations, leases, observations, identity links, checkpoints, backup, and restore verification have one backend authority.
- Existing functionality and aggregate validation have truthful results.
- The Phase 02 worker can add token-cache and capability records without redesigning persistence.
