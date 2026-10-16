# 04C - Current-only API/web release

## Mission

Release the supported API/web app to the confirmed current-host `seha` Compose
project, using current-only installation or the explicitly authorized fresh
database reset. Verify normal sign-in, automatic first sync and affected user
journeys without MCP or additional qualification/acceptance/enable steps.
This plan does not claim that deployment or live verification has happened.

## Current inputs

- [Roadmap](README.md), [canonical API contract](../../docs/mcp-integration.md),
  [data architecture](../../docs/data-architecture.md),
  [security](../../docs/security-model.md) and
  [operations](../../docs/operations.md#existing-installation-maintenance).
- [Local entry point](../../deploy-local.ps1),
  [deployment owner](../../scripts/local-deployment.ps1),
  [runtime owner](../../scripts/local-runtime.ps1), [Compose](../../compose.yaml).
- [Current schema](../../backend/src/db/schema.ts),
  [database operator](../../backend/scripts/database.ts),
  [reset guard](../../backend/scripts/databaseReset.ts),
  [backup/restore](../../docs/operations.md#backup-and-isolated-restore) and
  [recovery](../../infra/disaster-recovery.md).

## Implementation and release

1. Inspect current source/worktree and use existing owners. Remove obsolete
   compatibility constructors, schema recognition, old routes/data owners and
   inert gate fields rather than keeping parallel implementations.
2. Validate exact host/Docker context, `seha` project, app/PostgreSQL identities,
   database, `seha_data` volume, configured origin and intended artifact without
   displaying settings/secrets. Preserve configuration, credentials, roles,
   volume and backups. Do not provision MCP, Azure resources or public ingress.
3. Run focused source, route, schema and deployment tests. Existing preflight
   verifies current/empty installation before drain. Incompatible schema is
   refused unless the exact destructive reset action is authorized; no automatic
   upgrade, marker rewriting or fallback writer.
4. For the user-authorized reset, use
   `pwsh ./deploy-local.ps1 start -Project seha -DbReset` through the existing
   guarded owner. Reset deletes application reports/history, audit, sessions,
   jobs and database configuration/evidence. Reimport official CSVs and restore
   required sharing configuration after reset; provider sync cannot recreate
   saved history. Never repeat an unknown destructive outcome automatically.
   Completed deployment receipts must not block a new ordinary `start -DbReset`
   request. A non-destructive repeat uses `start` without `-DbReset`.
5. Initialization creates the current schema/grants and normal readiness.
   Actual maintenance closes during database work and clears after success.
   The existing PostgreSQL/container/volume remains the target. Normal start,
   completed reset and reviewed restore need no second provider-enable action.
6. Verify actual served revision, health/readiness, sign-in/out, Origin/CSRF,
   Viewer/Admin and principal-private scope. On first sign-in verify automatic
   Users/package/Power Platform sync starts and publishes without a Start button,
   separate Permissions visit, qualification query or approval artifact.
7. Verify inventory scopes/details/full About, Users/licensing/responsibility,
   adoption/champions, report import/selection/history, bounded exports, Sync
   history/deep links, explicit hunts/audit searches and job recovery. Real
   provider role, permission, licensing or configuration failures stay explicit.
   Configured application reads use current shared scope; delegated data stays
   private. Saved reads must remain available during unrelated provider outage.
8. Exercise provider writes only on separately authorized exact disposable
   targets. Check prestate, confirmation, one-shot dispatch and readback, then
   restore approved prestate. Do not run real department-wide bulk canaries.
   Uncertain writes require read-only reconciliation, never blind replay.
9. Observe actual error/auth/latency/queue/audit/resource signals for the
   operator's stated interval and workload. For a defect, contain the affected
   operation, repair the owning source/contracts, rerun focused tests and
   redeploy through the same owner. Do not substitute health for journey proof,
   fabricate measurements or add a new runtime gate as containment.
10. Hand over the actual URL/revision, tested journeys, commands/results and
    concrete unavailable provider/client evidence. User feedback drives normal
    bug fixes, not an acceptance-file prerequisite for supported application
    flows or future MCP implementation.

## Validation boundaries

Use `npm run check:unused`, existing local deployment/runtime tests and focused current-schema,
authentication, route, read/control and browser fixtures. Keep test databases,
restore drills and capacity workloads isolated from production. Document only
observed results. Source-only work must not run Docker, database, deployment or
remote-provider commands; the authorized release operator performs live steps.

## Done

Current-only API/web release and any authorized reset use one deployment/schema
owner. The normal first-run and affected journeys are observed, limitations are
specific, and no obsolete compatibility or qualification prerequisite remains.
Future MCP work remains separate; the web app has no MCP dependency.
