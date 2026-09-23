# Agent-centered Power Platform

## Goal and authority

Implement the 2026-09-23 decision to retire the standalone Power Platform catalog and make useful platform information context for an agent or user. The user explicitly authorized a forward-only development design, schema changes, and discarding obsolete data. There is no production deployment in this campaign.

Application boundary: the repository containing this plan, including `backend`, `frontend`, database/bootstrap scripts, browser fixtures, and current documentation. The historical `admin-poc-production` roadmap is not an execution or deployment authority for this campaign.

## Ordered implementation

1. [01 - Retire the catalog and narrow collection](01-retire-catalog-and-narrow-sync.md)
2. [02 - Agent configuration and verified dependencies](02-agent-resource-context.md)
3. [03 - User-to-agent responsibility relationships](03-user-agent-responsibility.md)
4. [04 - Fresh-schema and end-to-end convergence](04-validation-and-documentation.md)

Execution state and per-phase results belong in [completions](completions/IMPLEMENTATION_CAMPAIGN.md).

## Binding product decisions

- Agents and Users are business entry points. Sync, Permissions, Jobs, Audit, and Security remain supporting workflows; this is not a redesign of unrelated pages.
- Remove the Power Platform page, generic object modal, non-agent browser/export/filter controls, and obsolete page routes. Do not redirect or migrate old Power Platform bookmarks.
- Power Platform collection supports agents and environment metadata, not a hidden general app/flow/connector/environment-group catalog.
- Preserve Power Platform-only agents and draft/unknown states, Graph package associations, exact management targets, source privacy, freshness, coverage, and fail-closed controls.
- Preserve connector and operation details embedded in the agent payload. They do not depend on standalone connector records.
- Environments supply contextual name, location/type and relevant managed-environment facts, not an independent browse destination.
- Dependencies mean explicit source-declared configuration, not observed execution. Names, common ownership, common environment, GUID fragments, and arbitrary JSON key matching never establish an agent-component relationship.
- Components can be shared by multiple agents; do not invent exclusive ownership.
- Ownership, creation, last modification, access assignments, and report-observed usage are different relationships and must stay distinct.
- Report unavailable, partial, malformed, denied, stale, and explicit-zero data truthfully. Unknown connector/flow data is not an empty confirmed list.
- Useful agent information answers configured connectors/operations, explicitly established invoked flows, responsible people, runtime environment, configuration, activity, and supported actions.
- The public Resource Query agent schema currently exposes connector capabilities but no invoked-flow list. Use only a verified documented explicit flow relationship available from an authorized source. If the current sources cannot establish a relationship, explain the source limitation in the agent view and provide an appropriate official-console handoff; do not invent a flow parser, relationship or silent empty success.
- Minimize retained metadata. Never retain credentials, connection strings, callback URL secrets, transcripts, or raw provider archives to enrich this view.
- Official Microsoft consoles own platform-wide administration. Validated official links are handoffs, not authority to mutate or proof of relationship.

## Forward-only implementation

- No compatibility aliases, legacy snapshot readers, dual schemas, old route redirects, feature flags preserving the catalog, or data migration/backfill designed to rescue discarded objects.
- Update the development schema directly where needed. Existing historical migration machinery can remain for unrelated contracts, but do not add compatibility complexity for this change.
- Retain a shared active API/helper only for demonstrated agent, user, sync, job, activity or control consumers, not to keep the deleted explorer functional.
- Remove unused types, response fields, endpoints, styles, imports, tests and fixtures along with their retired behavior. Keep shared agent modal styles and meaningful exact-identity helpers.
- Keep snapshot verification, export authorization/auditing, role gates, CSRF and exact-target confirmation. Scope reduction does not itself reduce OAuth permission requirements.
- Current documentation must describe the new system. Historical campaign evidence need not be rewritten as if it never happened.
- Do not commit, push, create branches, or change unrelated functionality.

## Environment and verification boundary

Implementation and validation are local. Do not deploy to Azure or call live tenant mutation APIs.

Use an isolated campaign-owned PostgreSQL 17 container named `agent-control-agent-context-744531fc`, labelled for this campaign, with an ephemeral loopback port and no existing application volume. Only its generated `agentcontrol_test_*` databases, fixture runtime, named container and campaign artifacts may be reset/removed. Do not modify the already-running `agent-control-phase01`, `seha`, or other users' databases or processes. Call the container configuration tool before container commands.

Use existing `backend/scripts/testDatabase.ts` bootstrap/migrate/grant/cleanup and browser fixture machinery. This proves the fresh schema without touching existing data. If dependencies are missing, attempt the existing supported local/container path before reporting a blocker.

Required final evidence:

- Behavioral tests for collection of only agents/environments; rejection of retired types; retained environment/identity/connector metadata; absence of page/route and generic tab behavior.
- Exact relationship, scope isolation, false-positive, duplicate/shared-resource, partial/unknown/zero and malformed-source tests.
- Ownership versus usage tests and navigation from users to the correct canonical agents.
- Fresh database repository/schema tests with actual PostgreSQL; frontend and backend unit suites; build/typecheck; frontend lint; diff hygiene.
- Browser checks at desktop/mobile sizes for agent context, user responsibility, sync diagnostics, jobs, navigation, relevant action gates and empty/error cases.
- Old Power Platform refresh links lead to current Sync job details through the canonical job response, not through a legacy redirect.
- A final deletion sweep and unchanged unrelated worktree boundaries.

External provider authentication is not available by assumption. Faithful documented fixtures validate contracts; no test result may be described as a live tenant proof.
