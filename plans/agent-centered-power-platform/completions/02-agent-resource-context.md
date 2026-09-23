# Phase 02 completion — Agent configuration and verified dependencies

## Result and boundaries

**Complete and locally verified.** Phase 02 of 4 is implemented end to end. The assigned prompt SHA-256 is `d6939fd83309713b0bb7f9b6033a3b466abb3c5304fe8275252194d60118750c`.

The worker used the requested extra-high reasoning posture without nested delegation. Accepted phase-01 changes and parent-owned plans were preserved. The campaign manifest was not edited. No commits, pushes, branches, production deployment, live tenant requests, or new providers were made.

## Implemented requirements

- Overview now groups responsibility, environment, configuration, and configured connectors/operations. Owner, creator and last modifier remain distinct; a last modifier is not presented as a maintainer or permission grant.
- Saved environment context includes exact identity, name, region, type, managed state, environment group, independent observation and source provenance. Enrichment is scoped to the same tenant/principal and verified current saved environment snapshots. Unknown, unmatched and expired context is not invented. Both native and Graph-only records can receive context when they have an established exact environment identity.
- Native connector operations retain documented `usedAs`, `isEnabled`, `requiresEndUserConsent`, `connectionProvider`, `whenCanBeUsed`, and `createdBy`. The last field means **operation configuration creator**, never agent owner/creator.
- Reported connector/operation totals remain separate from bounded saved details and observed activity. Missing, explicit empty, zero, false, partial, malformed and provider-limit cases have separate truthful behavior. Undocumented enum values and malformed optional fields are not promoted to verified facts.
- Connection identifiers, callback URLs, credentials, arbitrary nested references and unsupported fields are not retained in the minimized capability projection. Exports explicitly project safe fields even when a fixture injects unexpected properties.
- Removed recursive package JSON/URL/name heuristics from both the canonical Overview and the older package-detail consumer, together with their helper, type, panel/stat and obsolete CSS. Package metadata remains useful description/configuration evidence, not native connector/flow relationships.
- Invoked-flow context explicitly states that the synced sources do not establish the relationship. It never renders an empty confirmed flow list, guesses a `flowIds` payload, creates unused relationship scaffolding, or queries a flow/connector catalog.
- Console handoffs use fixed allowlisted Microsoft origins and are explicitly labelled **console landing page**. No documented exact-target guarantee was established, so no deep-link route is fabricated or built from a provider URL.
- Ordinary detail browsing reads saved data only. Missing/expired people no longer trigger automatic directory resolution; the existing authorized resolver runs on an explicit **Look up people** action. Exact IDs, saved labels, negative/error evidence, retry, cancellation and session/scope fences remain intact.
- Selected Graph package/version, management gating, quarantine freshness, saved activity and usage remain intact. Native configuration and environment context carry their own observations rather than borrowing selected-package freshness.
- Canonical and source-agent CSV exports include relevant responsibility, configuration, reported/saved counts, provenance and explicit flow-unavailability context. Canonical export also includes saved environment context. Missing values remain blank; explicit empty connector lists remain `[]`.

## Schema, persistence and API contracts

- `PowerPlatformConnectorOperation.createdBy` is an optional validated GUID. Existing minimized resource JSONB persists it; **no database migration or parallel schema** is needed.
- `UnifiedAgentRecord.environment` carries `SavedAgentEnvironment` or null. Shared backend types already supply the frontend API contract; no duplicate frontend schema or compatibility reader was added.
- `readAgentEnvironments` is an exact-ID, scoped repository projection, not an environment catalog endpoint. It verifies matching saved snapshot coverage and uses the newest eligible observation for each identity. Its 10,000-ID bound accommodates two independently bounded 5,000-record source inventories.
- Native connector detail completeness is downgraded for malformed optional metadata, inconsistent totals, omitted operation lists and the documented 200-entry boundary without confirming totals. Counts themselves are not reconstructed from a partial list.
- CSV `invokedFlowContext` is `unavailable_from_synced_sources`. The human-readable UI limitation explicitly says this is not evidence that an agent invokes no flows.
- CSV empty cells now use standard unquoted empty serialization. This preserves parsed values and formula protection while retaining the unchanged 5,000-agent / 10,000-target / 8 MB / 15-second export guarantee after adding columns.

## Binding source evidence and autonomous decisions

The parent decision not to add Dataverse or another provider was followed.

1. [Copilot Studio agent inventory](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-agent-inventory) documents the native configuration and connector-operation fields, operation creator semantics and bounded resource details. Its example uses `operationId`; that documented JSON spelling is retained. Preview/bounded configuration is not claimed as selected-published-version proof.
2. [Power Platform inventory schema](https://learn.microsoft.com/en-us/power-platform/admin/inventory-schema) supports environment type, managed state/group and shared location metadata. Environment evidence therefore comes from verified saved environment resources, not guessed agent/package fields.
3. [Graph package elements](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/packageelement), [declarative actions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8#actions-object), and [plugin runtimes](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4#runtime-object) do not establish a native invoked-flow relationship.
4. [Dataverse botcomponent_workflow](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/botcomponent#botcomponent_workflow) is an association, not guaranteed invocation or published-version scope. [Dataverse authentication](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/authenticate-oauth) would require separate URL/auth integration. This phase does not add that integration.

Further grounded choices:

- Use read-time verified environment projection instead of duplicating environment facts into agent observations.
- Use explicit people lookup instead of allowing saved browsing or a permission transition to initiate provider work.
- Use Copilot Studio, Power Platform admin center and Microsoft 365 admin center landing URLs appropriate to the available source. Graph-only package identity does not imply a native Studio target.
- Add a bounded fixture-only exact-spec selector to the existing browser runner. It rejects paths, arguments, duplicates, wildcards and excessive selections. Selected runs retain readiness and no-package-mutation checks. The default full run still performs all browser tests and its report-restart/quarantine postconditions.
- Keep full aggregate verification with phase 04, as assigned; focused browser proof is not presented as a substitute for that campaign-wide validation.

## Changed files and cross-application impact

All paths below belong to this repository; phase-01 changes in the same worktree remain preserved.

| Root / surface | Phase-02 changes and impact |
| --- | --- |
| Backend types | `src/types/powerPlatformInventory.ts`, `unifiedAgents.ts`, new `agentContext.ts`: documented operation creator, saved environment context, safe fixed console URLs and shared limitation. |
| Backend ingestion and canonical service | `src/services/powerPlatformResourceQuery.ts`, `unifiedAgents.ts`, `packageAgentMetadata.ts`: minimized validated configuration, exact saved context, removal of obsolete heuristic-consumer commentary. |
| Backend persistence | `src/db/powerPlatformInventory.ts`: exact scoped environment projection and removal of the obsolete source-level environment-name map. Existing JSONB/schema suffices; no migration. |
| Backend exports and route | New `src/services/agentContextExport.ts`; `unifiedAgentExport.ts`, `csvExport.ts`, `src/routes/inventory.ts`: aligned source/canonical projection, safe bounded export and unchanged authorization/audit limits. |
| Backend tests | Parser, inventory repository, actual PostgreSQL unified integration, canonical service/snapshot/export, CSV and authorized application route tests were updated. They cover persistence-to-response-to-CSV, independent environment observation/revision, isolation, same-name/shared-connector non-merges and secret exclusion. |
| Frontend UI / consumers | `src/components/AgentOverview.tsx` and new test; `UnifiedAgentDetailModal.tsx`, `AgentDetailModal.tsx` and their tests; `unifiedAgent.css`; `src/App.tsx`, `App.css`; `agentDetails.ts` and its test. The agent table still receives its required environment-name map; only the modal's obsolete prop was removed. |
| Frontend identity state | `src/useAgentPeople.ts` and its test: explicit-only provider lookup, with saved identities and all scope/cancellation behavior preserved. |
| Browser consumers | New `browser/agentContext.spec.ts`; updated `agentPeople.spec.ts` and `unifiedAgents.spec.ts`. Fixtures now carry canonical environment context and exact authorized saved-activity responses. |
| Backend scripts | `scripts/browser-fixture.browser.ts`, `fixtureSupport.ts` and its test: bounded optional `AGENT_CONTROL_BROWSER_TEST_FILES`, actual readiness probe and correctly scoped selected/full postconditions. |
| Current documentation | Root `README.md`, `docs/security-model.md`, `docs/provider-contract-inventory-2026-09-08.md`: configuration-versus-usage semantics, source limits, explicit lookup, safe links, export fields and focused fixture instructions. |
| Other root scripts, deployment and dependencies | Impact checks found no runtime provider/API consumer requiring changes outside the application roots and fixture scripts above. No dependency, installation, container/deployment configuration or runtime environment-contract change was needed. |
| Plans | This completion record only; parent campaign state and later-phase plans were not edited. |

## Validation and observed evidence

The initial falsifiable parser tests produced **6 expected failures**: operation creator was dropped and malformed optional metadata was incorrectly marked complete. Those defects were repaired; the immediate parser rerun passed. Further count/provider-boundary cases were subsequently included in the final aggregation.

| Executed validation | Result |
| --- | --- |
| Focused backend Vitest aggregation via `npm --prefix backend test -- … --reporter=dot` (parser, repository, actual PostgreSQL unified integration, unified/snapshot/export, CSV, application/control and fixture contracts) | **16 files, 457 tests passed**. Persisted output: `.local/agent-context-phase02/backend-run.log`. |
| Focused frontend Vitest aggregation via `npm --prefix frontend test -- … --reporter=json --outputFile=../.local/agent-context-phase02/frontend-results.json` | **10 files, 435 tests passed**. Exact selectors: `src/App.session.test.tsx`, `src/agentDetails.test.ts`, `src/agentExport.test.ts`, `src/useAgentPeople.test.tsx`, `src/api/inventoryExport.test.ts`, and component tests for `AgentDetailModal`, `AgentOverview`, `PackageManagement`, `UnifiedAgentDetailModal`, `UnifiedAgentTable`. |
| `npm --prefix backend run build`; `npm --prefix backend run typecheck` | Passed. |
| `npm --prefix frontend run build`; `npm --prefix frontend run lint` | Passed, including the final unused-CSS cleanup. Existing nonfatal Vite chunk-size warning remains; no threshold or assertion was relaxed. |
| `npm --prefix backend test -- --config scripts/browser-fixture.config.ts`, with `AGENT_CONTROL_BROWSER_TEST_FILES=agentContext.spec.ts,unifiedAgents.spec.ts,agentPeople.spec.ts,inlineAgentManage.spec.ts,agentCatalog.spec.ts` | **28 desktop/mobile Chromium tests passed**, plus enclosing fixture. Saved output: `.local/agent-context-phase02/browser-run.log`; JSON/screenshots under that evidence directory. |
| Same fixture command with `AGENT_CONTROL_BROWSER_TEST_FILES=agentContext.spec.ts` after the final CSS cleanup and screenshot framing improvement | **6 desktop/mobile tests passed**, plus enclosing fixture. `.local/agent-context-phase02/context-browser-run.log` and `context-proof/` contain this final-build evidence. |
| Editor diagnostics; `git diff --check`; stale-heuristic consumer search | Clean. Remaining fake `flowIds` and “Connected services” references are deliberate negative tests, not product behavior. |

The browser cases prove meaningful environment and operation fields, distinct responsibilities, false/zero handling, sparse Graph-only records, explicit-empty versus unavailable dependencies, fixed link destinations, responsive layout and no detail-triggered POST after the existing single bootstrap capability check. Existing selected-version and inline management/browser cases also pass. Desktop and mobile screenshots were inspected; final environment and operation screenshots are in `context-proof/playwright/agentContext-*`.

An initial export-size regression caused by the additional columns was repaired with standard empty CSV serialization; the existing stress-test limits were not increased. Initial new-browser fixture failures were corrected by explicitly accounting for the already-existing bootstrap capability check and supplying the exact saved-activity fixture, not by weakening product assertions.

### Authorized local environment

- Used only parent-authorized PostgreSQL at `127.0.0.1:55533`, base database `agentcontrol_test_campaign`, user `agentcontrol_admin`, with SSL disabled and the supplied synthetic fixture credentials. PostgreSQL reported **17.11**.
- Existing test machinery created and dropped bounded per-suite databases. Post-run read-only verification showed only the base campaign database among `agentcontrol_test_%` databases.
- The isolated fixture used `NODE_ENV=test`, `AGENT_CONTROL_FIXTURE_MODE=browser`, and `PLAYWRIGHT_BASE_URL=http://127.0.0.1:55534`. All provider adapters were fixtures; external provider fetches were forbidden.
- The fixture listener was verified closed after execution. The parent container, existing services and shared resources were not stopped, reset or deleted.
- Campaign evidence remains in ignored `.local/agent-context-phase02/`; no temporary-directory artifacts or dependency installations were created by this work.

## Residual source limitations and phase-03 handoff

There is no unresolved implementation decision or blocker. Native invoked-flow identity, invocation direction and published-version scope remain genuinely unavailable from the authorized synced sources; the shipped experience and exports say so. No live-tenant behavior is claimed.

Phase 03 can use the preserved canonical agent IDs and exact owner/creator/last-modifier identities to build bidirectional responsibility navigation. It must not treat operation configuration creators, access assignments, environment membership, shared connectors, last modifiers or observed usage as interchangeable responsibility edges. Operation creators are displayed only as operation configuration evidence. Saved browsing remains provider-free; explicit people lookup is the authorized enrichment action. Phase 03's navigation/cohort work and phase 04's full final aggregation remain with their assigned owners.
