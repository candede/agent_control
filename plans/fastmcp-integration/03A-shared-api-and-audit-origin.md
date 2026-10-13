# 03A - Shared API parity and administrative audit origin

## Mission

Implement first-class administrative action origin and best-effort caller attribution across existing audit writers, durable jobs, API reads/exports, and frontend audit views. Establish executable same-route web/bearer parity fixtures before MCP adapters consume the contract.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), [03](03-api-auth-integration.md), and `completions/01-contracts-and-feasibility.md` and `completions/03-api-auth-integration.md`. Use the frozen canonical route map, verified principal, and origin v1 schema. Inspect scoped status and applicable repository/worker instructions. This lettered phase executes before 04 and 05.

## Read first

- [Audit types](../../backend/src/types/audit.ts), [audit writer/projection reader](../../backend/src/services/auditLog.ts), [audit routes/CSV](../../backend/src/routes/audit.ts), [current schema](../../backend/src/db/currentSchema.ts), [schema verification](../../backend/src/db/schema.ts).
- [Package job persistence](../../backend/src/db/jobs.ts), [mutation staging](../../backend/src/db/inventoryMutationStages.ts), [quarantine persistence/audit](../../backend/src/db/copilotStudioQuarantine.ts), [package workers](../../backend/src/services/bulkJobs.ts), [Studio workers](../../backend/src/services/copilotStudioQuarantineJobs.ts).
- [Frontend API types/adapters](../../frontend/src/api/client.ts), [audit view](../../frontend/src/components/AuditLogView.tsx), [audit view tests](../../frontend/src/components/AuditLogView.test.tsx), [route/filter state](../../frontend/src/workbenchRouting.ts), [frontend commands](../../frontend/src/App.tsx).
- [Database operator](../../backend/scripts/database.ts), [reset operator for comparison only](../../backend/scripts/databaseReset.ts), [retention](../../backend/src/db/dataRetention.test.ts), [audit tests](../../backend/src/services/auditLog.test.ts), [audit route tests](../../backend/src/routes/audit.test.ts), and the 02/03 principal implementation.

## Required implementation

1. Extend the 01 shared operation map with exact HTTP method/path/query/body/default/error contracts used by existing web adapters and future MCP tools. Reject MCP-only duplicate routes. Add a reusable parity fixture that exercises authenticated browser and authorized MCP-bearer requests against the same registered handler.
2. Implement a typed immutable action-origin context separate from the verified actor, provider `source`, target `agentId`, and mutation authority. Derive `webapp` from the validated web session path and `mcp` from the approved MCP application/client token binding. Browser headers, User-Agent, HTTP Origin, request body, or tool arguments cannot choose the channel/actor.
3. Accept only the bounded optional attribution descriptor frozen in 01 from the authenticated MCP integration. Validate encoding, field/evidence enums, maximum bytes/lengths, control characters, and reserved fields. Reject malformed context and attempted actor/channel replacement explicitly. Absence of optional client/agent information is an honest unknown, not failure or a guessed label.
4. Distinguish verified integration identity, supported authenticated downstream client ID, reported client name/version, and reported calling-agent identity. Evidence is per field: a verified OAuth ID cannot authenticate its display name or agent label. Most `initialize.clientInfo`, DCR names, and namespaced request metadata are reported. Do not claim publisher/agent verification without an actual binding.
5. Add first-class persisted origin fields using existing schema conventions: immutable forward upgrade, fresh-init/current-schema parity, projection changes, schema fingerprint/verification, grants/constraints/indexes, migration tests, and deployment operator integration. The current fingerprint verifier is not a migration runner: implement a narrowly scoped, checkpointed upgrade from the exact prior schema; never require a destructive reset just to add audit origin.
6. Preserve historical evidence: old rows and pre-upgrade job/stage provenance are explicitly `unknown`, with no retroactive webapp/client/agent inference. Keep append-only event history and existing retention/privacy/reset semantics. Each latest audit projection must retain the same initiating origin across status appends.
7. Trace every existing audit-producing path, including `AuditLog`, batch/direct SQL, package jobs/stages/items, quarantine jobs/audit, and other audited administrative/export/import/configuration actions where currently implemented. Persist non-secret initiating context at first accepted execution submission, in the same transaction as existing job/audit acceptance; workers propagate stored context without request-local globals.
8. Preserve initiating context through bulk children, background dispatch, completion, partial failure, restart, retry, and idempotent replay. An identical replay cannot overwrite original attribution or trigger another provider write. A later resume/cancel/reconcile request records its own lifecycle actor/origin separately while leaving the original operation unchanged. Display metadata is not a target/authorization/idempotency semantic input.
9. Extend current audit JSON types, parsers, projections, list/count filters, bounded search, detail, and CSV exports with channel/client/calling-agent/evidence/trace fields. Keep local control audit and native quarantine audit authorities separate but expose attribution consistently. Do not replace existing provider-source fields, widen tenant/principal visibility, or create a second audit warehouse.
10. Update the existing frontend audit table with an Origin column and client/calling-agent details, evidence labels, channel filter, and historical unknown state. Update URL filter state, cache keys, page-reset/selection invalidation, accessible layout/details, empty/error states, and CSV selection behavior. Calling-agent identity must not be confused with the managed target Agent column.
11. Render all reported names inertly and use existing CSV formula-safety helpers. No token/session handles, prompts, conversations, arbitrary agent metadata, or confidential authoring text in attribution. Bound retention/storage and include origin fields in existing cleanup/backup/account-reset handling.
12. Update shared types and directly affected producers/consumers in one phase. Add audit-origin/migration/parity/backend/frontend fixtures and document the trust model, unsupported attribution, schema upgrade, and lifecycle display. 05 consumes this contract; do not implement its Python collector here.

## Scope guard

No new admin permission, approval engine, scheduler, agent identity registry, universal audit framework, historical inference, new data visibility, MCP-only API mirror, or frontend dependency on MCP. Do not weaken provider/CSRF/role checks to make parity succeed.

## Validation

- Add focused suites such as `src/routes/actionOrigin.test.ts`, `src/services/auditOrigin.test.ts`, and `src/db/auditOriginSchema.test.ts`; run them with existing audit/job/quarantine suites using the isolated DB harness.
- Prove exact same method/route and equivalent domain data/errors for browser and bearer requests under matched user/input/source/prestate. Use fixture request capture; exclude legitimate auth/trace/timestamp/origin differences.
- Prove spoofed channels/actors/evidence are rejected; authenticated integration ID is distinct from reported client/agent names; unsupported metadata is unknown; full names remain bounded/inert.
- Test historical schema upgrade without data loss, fresh-init parity, append/projection stability, package and quarantine direct writers, concurrent users/clients, mixed-provider children, replay from another client, web resume of an MCP job, retention, and CSV list/count/filter equivalence.
- Run affected frontend audit/API/routing tests, frontend lint/build, backend typecheck, and the existing browser harness where available. Verify visible Origin/filter/details/CSV, keyboard/focus, and overflow using synthetic records.
- Check schema/deployment upgrade commands and `git diff --check`. All dependency subprocesses use README feeds; do not install absent a manifest change or missing-tool failure.

## Production continuation

Apply README's Always-Deploy and two-part contracts. 04C first proves deployed web origin and historical upgrade without MCP; 12 later proves actual MCP attribution on approved disposable targets. Unknown historical/client/agent evidence remains unknown. Audit schema/append/provenance defects require root repair and affected write containment, not guessed origin, a dropped event, destructive reset, or deferral of the web audit consumer into Part 2.

## Completion record

Write `completions/03A-shared-api-and-audit-origin.md`: canonical route/parity fixture map; origin schema, trust/bounds and migration/checkpoint; all audited stores/direct writers and job lifecycle propagation; frontend/filter/CSV contracts; root impact; exact tests/results; residuals; and 04/04A/04B/04C consumers plus later 05/07 adapters.

## Done and handoff

Existing web actions produce verified webapp origin; authorized bearer fixtures produce mcp origin with separately evidenced optional caller labels. Both reach the same API routes. Origin survives all existing durable audit/job paths and is visible/filterable/exportable without rewriting history. 05 can implement actual MCP context capture/forwarding against this established contract.
