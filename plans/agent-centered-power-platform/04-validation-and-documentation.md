# 04 - Fresh-schema and end-to-end convergence

Reasoning posture: extra-high. Read roadmap and every prior completion record.

## Outcome

All changed architecture works end to end on a fresh database, current documentation matches it, and no obsolete catalog compatibility path remains.

## Required work

1. Review the complete diff and requirements, not just phase reports. Repair omitted producers/consumers, schema constraints, fixtures, exports, job inspection/recovery, permission metadata and documentation.
2. Sweep runtime source, API contracts, browser/unit fixtures and current docs for retired page routes, generic explorer fields/types, backward redirects, old refresh defaults, unrelated resource parsers and contradictory labels. Historical plan evidence is not active architecture.
3. Prove bootstrap/migration/grants on new campaign-owned PostgreSQL databases. Confirm retired resource types cannot be collected/persisted and agents/environments/embedded capabilities still round-trip; prove canonical identity, people context and exact control reads remain intact. Do not migrate or reset unrelated databases.
4. Run the full backend and frontend unit suites using isolated PostgreSQL, all builds/typechecks, frontend lint and diff hygiene. Repair tightly coupled failures; record a genuine unrelated baseline failure only with evidence.
5. Run existing browser fixture end to end with desktop/mobile projects. Exercise agent/user context, sparse/missing/partial dependencies, retired navigation absence, source diagnostics, exact job links and recovery, package/PP-only management, and error/authorization behavior. Inspect actual layout using browser tools/screenshots when possible; do not claim UI proof from a build.
6. Document the two-type source contract, explicit configured-versus-used relationship semantics, unavailable invoked-flow evidence if applicable, official-console handoff, and fresh-development schema/reset expectations. Avoid migration/rollback/backward-compatibility recipes for retired data.
7. Review container/process/database ownership. Clean up only the named campaign disposable container, its generated fixture databases and temporary artifacts; preserve useful test results in the session folder or existing ignored artifacts. Never stop shared app processes.
8. Record exact final changed files/status, tests/results, source limitations and any live-provider proof not attempted. Do not commit or deploy.

## Completion

Create `completions/04-validation-and-documentation.md`. Every phase must have a factual completion record and all actionable work must be resolved. Parent reviews and closes campaign only after final independent discriminating checks and worktree hygiene.
