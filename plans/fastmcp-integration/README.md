# FastMCP integration: ordered implementation campaign

## Outcome and confirmed scope

Add a Python FastMCP container as an Entra-authenticated integration layer between customer agent clients and Agent Control. The API remains the authority for application data, queries, calculations, Microsoft provider access, controls, jobs, and audit. The external LLM agent owns reasoning, use-case interpretation, conversation, and scheduling. This folder contains implementation instructions, not evidence of implementation or deployment.

The confirmed product contract is:

- Signed-in users only. Preserve `AgentControl.Viewer`, `AgentControl.Admin`, Microsoft delegated permissions, and existing tenant/principal-private data boundaries. No app-only customer identity or shared service-account fallback.
- Web app and MCP actions for the same business operation must call the same backend HTTP method/route and use the same request, response, validation, permissions, defaults, and provider effects. The web app does not call or depend on the MCP server.
- Existing administrative audit records gain a first-class origin showing `webapp`, `mcp`, or historical/unavailable `unknown`, plus available calling-client and calling-agent attribution. The verified admin remains the actor; the calling agent is not the managed target agent.
- Support Copilot Studio/Microsoft 365 Copilot agents, VS Code/GitHub Copilot, Claude clients, and compatible customer cowork apps over Streamable HTTP. Verify each client separately; do not claim universal compatibility from an SDK fixture.
- Scheduling and LLM decisions live in the customer client. Do not add an Agent Control scheduler, automation-policy engine, business approval system, or a server classifier.
- Interactive block/unblock workflows display an exact preview and obtain explicit confirmation for each target block. Scheduled workflows obtain current target receipts and execute without waiting for human confirmation.
- The API executes authorized exact commands. Preserve existing permission, inventory, prestate, readback, idempotency, capacity, and audit checks. Existing preview hashes bind exact operations; they are not new business approvals. Optional mutation canaries do not gate ordinary controls.
- Generic agent block/unblock uses quarantine/unquarantine for Studio agents and package block/unblock for other supported agents. Existing explicitly named package-only or Studio-only controls remain distinct operations with the same effects through web and MCP; do not silently reinterpret them or automatically apply both. Unknown platform/control identity is explicit, not a reason to guess.
- Reuse the existing computed champions: up to three eligible people per company/department, ranked by created agents, responses, and associated agents. Do not introduce designated-group membership or change the portal definition.
- Saved data is the default. Refresh, directory enrichment, live investigation, and provider work require explicit tool calls; ordinary saved reads must remain provider-free.
- Expose all authorized agent/user/usage information through typed tools, including full available About descriptions and configuration metadata. No arbitrary SQL, arbitrary HTTP/KQL, raw diagnostic archives, secrets, or new transcript collection.
- Trends are constrained by actual report windows, source semantics, coverage, and history. Missing data is unknown, not zero. Descriptions support LLM inferences; inferred use cases are not authoritative stored classifications.
- Deliver local Compose and Azure production hosting. Preserve the current Node App Service; add a separate MCP container service.

## Two-part rollout and user acceptance

This campaign has two independently released parts, not one combined API/MCP cutover:

1. **Part 1 - API and web app (01 through 04C).** Complete shared API identity, authorization, reads, controls, audit origin, and every affected frontend consumer. The web app exclusively uses the canonical API operations, and every existing web feature retains its current business behavior. Deploy and observe the API/web app using the existing hosting topology, with no MCP package, container, Python dependency, OAuth storage, or MCP infrastructure. Then stop so the user can manually exercise the deployed web app.
2. **Part 2 - MCP integration (05 through 12).** Start only after the user explicitly accepts the exact Part 1 deployed revision and authorizes beginning Part 2. Add the FastMCP service, protocol authentication, thin read/control adapters, containers, client workflows, and a second production release. Consume the already accepted API routes/functions; do not postpone API routing or frontend cutover into this part.

The goal is one canonical API operation per business action, not a mandatory new URL/version for every existing endpoint. Reuse routes that already satisfy the contract; replace only deficient routes and remove their superseded frontend/runtime consumers. Do not rewrite unrelated working endpoints or create a permanent old/new compatibility layer. Classify every current web operation, including uploads/downloads, exports, investigations, refresh, job recovery, and authentication boundaries. A browser-only operation may stay browser-only; shared business logic does not make all routes bearer-accessible or all actions MCP tools.

Part 1 proves browser regression behavior and browser/bearer API parity with synthetic direct HTTP fixtures, not a running MCP server. Missing MCP client credentials or live protocol proof cannot require bringing MCP into Part 1: unsupported bearer admission remains closed through validated configuration/admission while normal web functionality stays available. Preserve all existing web effects/defaults, including explicitly named package controls; the requested Origin display is an additive audit enhancement, not permission to change control behavior or add unrelated pages.

04C produces a real API/web deployment receipt and a feature-by-feature manual-test handoff. Its deployed/observed completion is not user acceptance. At the boundary, the campaign state is `awaiting_user_acceptance`; do not start 05, provision MCP, install its dependencies, or infer acceptance from automated checks, silence, or a deployment receipt. After the actual user response, record `completions/PART-1-ACCEPTANCE.md` with the accepted revision/content hashes, production receipt, user-reported manual outcomes, remaining limitations, and explicit authorization to begin Part 2. This is a supporting approval record, not an executable prompt or a new runtime business approval engine.

If manual testing finds a regression, repair it in its Part 1 owner, run focused regressions, redeploy, and provide the updated revision for acceptance. Acceptance of an older revision does not automatically cover material later API/web changes. Part 2 adapter defects are repaired in Part 2; a material shared-contract/business change discovered there returns to its Part 1 owner and requires renewed deployed web validation and user acceptance before continuing the affected MCP work. "No known blocking regressions in the tested scope" is evidence-based; never promise that manual testing proves the entire app bug-free.

## Roots and current baseline

This is one repository, `candede/agent_control`. Resolve paths from its root, not a machine-specific absolute path. Implicated roots are `backend/`, `frontend/`, new `mcp/`, `infra/`, `scripts/`, `docs/`, and root build/deployment configuration.

Read current [repository instructions](../../AGENTS.md), [security model](../../docs/security-model.md), [usage semantics](../../docs/official-usage-import.md), [local deployment](../../deploy-local.ps1), and [Azure deployment](../../docs/azure-production-deployment.md). The drafting baseline was revision `044e53e1`; recheck current code and scoped status at execution time. Historical roadmap/completion files are evidence, not permission to restore superseded roles, canary gates, or deployment targets.

The current API is session/Origin/CSRF-based. Provider token acquisition and user revalidation assume MSAL browser-account cache entries. This campaign must address both request authentication and asynchronous service/worker authorization, not merely install a JWT middleware.

## Binding architecture and authority

1. **Client:** owns LLM calls, reasoning, schedules, and interactive confirmation. No model calls, model credentials, or scheduler in MCP/API. Publish tool descriptions and client workflow instructions; do not mistake instructions for a security boundary.
2. **MCP:** owns protocol, OAuth proxy/discovery, encrypted OAuth connection state, typed API adapters, bounded output projection, cancellation, and safe error translation. It has no application-data database credentials and does not join tenant datasets or calculate business metrics.
3. **API:** owns role/capability enforcement, canonical identities, data selections, SQL joins/aggregates, source evidence, provider token acquisition, control routing, jobs, and readback. Each business operation has one canonical method/route/controller used by both web and MCP adapters, not merely two routes sharing a service. No MCP-only mirror of existing routes, separate defaults, or alternate control path.
4. **Identity:** use a configured, tenant-specific Entra authority. Each MCP deployment binds one exact configured tenant and API origin; additional tenants use separate configured deployments. Preserve the API's existing multi-tenant behavior. Never derive authority or data scope from an email, client-supplied header, tool argument, or unrestricted `common`/`organizations` login.
5. **Audiences:** use a distinct MCP Entra registration and the existing API registration with documented delegated access scopes. FastMCP's proxy-issued credential is not an Entra OBO assertion. Retrieve the verified upstream Entra token through supported pinned-version APIs, exchange it for an API-audience token, and let the API obtain provider-audience tokens. Reject token passthrough, ID-token-as-access-token use, and audience widening.
6. **Principal:** introduce one verified request-principal contract for browser and bearer transports, with a proven mapping to existing saved-data principal keys. Do not fabricate `express-session` objects, guess `homeAccountId` from `oid`, or require a prior portal login. Include guest identities, provider-role evidence, epochs, role freshness, and revocation. Preserve immediate internal epoch fences and the current bounded role-revalidation cadence; external Entra revocation follows documented token/provider/claims-challenge behavior, not a promised instantaneous signal.
7. **Route activation:** phase 02 is dormant foundation; phase 03 atomically wires all affected API/service/worker consumers. Keep existing browser sessions as a supported transport, not a replaced legacy behavior. Bearer support is limited to declared integration operations. Browser requests retain Origin/CSRF checks; ambiguous cookie-plus-bearer requests fail explicitly rather than falling back.
8. **Credentials:** preserve ephemeral API MSAL/provider credentials. Persist encrypted OAuth state only in the MCP-owned, access-restricted volume using independent signing/encryption keys. No provider tokens, assertions, cache blobs, or MCP secrets in application records, jobs, audit, sessions, receipts, or completion files. API restart/expired authority pauses jobs honestly until fresh same-principal authorization is supplied.
9. **Reads:** preserve native/canonical/report-only distinctions, exact source associations, selection/cursor revisions, full available descriptions, user licensing/service-plan facts, field provenance, report metadata, partial coverage, and invalidation. Champions-only queries cannot substitute the adoption group's department-wide agent list. Official usage remains imported-report authority; explicit refresh cannot manufacture new CSV reports from Graph.
10. **Controls:** phase 04A owns the shared canonical preview/execute/status adapter, receipts, provider routing, and frontend controls; 07 only adds MCP adapters. Never mutate by display name, inferred use case, ambiguous association, or report-only identity. Existing server-issued previews remain target-consistency receipts for both interactive and scheduled execution. Preserve existing explicit package versus Studio operation effects through the Part 1 cutover.
11. **Confirmation:** without a new approval gate, the server cannot prove human confirmation or authenticate a caller's claim that a task is scheduled. The same execution tool is usable by both workflows. Client recipes/evaluations enforce the interactive conversation requirement; never add a `scheduled=true` authorization bypass.
12. **Hosting:** start with one non-root MCP instance and encrypted file-backed OAuth state on a dedicated persistent mount. No Redis, separate application-data database, autoscaling, or second queue. Azure uses a separate Linux custom-container App Service with immutable image digest; reuse the existing plan only after capacity/cost approval. Streaming, callbacks, persistence, key rotation, and restart recovery must be measured.
13. **Release containment:** use existing operational admission plus a deployment-owned server tool allowlist, implemented in 05 and configured in 10. An omitted tool must be unavailable to direct `tools/call`, not merely hidden in a client's UI. The complete configured catalog is the normal product; this narrow release control is not per-task business approval and cannot override API authorization.
14. **Audit origin:** phase 03A owns the non-secret origin descriptor, schema/projection/job propagation, audit API/filter/export contracts, and frontend display. Phase 05 captures MCP protocol/client context; 06/07 transmit it without becoming audit writers. Origin is authenticated API provenance, never an authorization input or a replacement for provider `source` metadata.

Phase 01 pins the supported FastMCP/MSAL behavior with dated primary sources. If a library limitation disproves the stated token flow, the parent selects one supported audience-correct flow and updates this contract and all consumers before proceeding; never create parallel speculative authentication paths.

## Shared API and audit-origin contract

For the same verified user, selected data/prestate, and normalized inputs, both transports use identical business routes and receive equivalent domain results/errors. Cookie/CSRF versus bearer credentials, request IDs, timestamps, presentation, and audit origin may differ. Compare business semantics rather than byte-identical ephemeral receipts. Default scope/filter semantics live in the API; "all agents" is an explicit common query scope, not an MCP-only default. Existing web flows must use the canonical route selected in 01/04/04A, with exhaustive consumer cutover and regression ownership in 04B; update those flows when necessary, without unrelated new pages. No MCP-owned endpoint design remains for Part 2.

Audit origin is a first-class typed descriptor, exposed consistently in API JSON, web audit views/details/filters, CSV exports, and MCP audit tools:

| Field | Meaning and trust |
| --- | --- |
| `origin.channel` | `webapp`, `mcp`, or `unknown`; API-derived from the validated session or authorized MCP client credential binding, not caller headers |
| `origin.integrationClientId` | Validated application/client ID for the web or MCP integration; not automatically the downstream Claude/Cowork/agent identity |
| `origin.client` | Nullable client ID/name/version with per-field evidence: `authenticated`, `reported`, or `unknown`; protocol/DCR display names are not proof of vendor identity |
| `origin.callingAgent` | Nullable caller agent ID/name with the same per-field evidence; typically reported or unavailable, never inferred from the target agent or prompt |
| `origin.requestId`, `origin.mcpCallId` | Bounded non-secret trace references; never tokens, cookies, credential-bearing session handles, or prompt bodies |

01 freezes the concrete v1 shape and bounds; 03A implements it. `authenticated` requires an independently verified credential/session binding for that exact field. An authenticated OAuth client ID does not authenticate its self-declared name, version, or agent label. Missing attribution is explicitly unknown; do not add an agent identity registry or collect conversations to fill gaps.

Capture mutation provenance at the first accepted execution submission, not from whichever client generated its preview. Preserve it across append-only status events, bulk children, dispatch, restart, retries, and idempotent replays. A later web resume of an MCP-origin job does not rewrite its initiating origin; record the resumer's context separately in a lifecycle audit entry. Attribution does not grant permissions, alter target matching, or invalidate an otherwise identical operation merely because a display label changed.

Old rows and already-running pre-upgrade jobs remain `unknown` unless original trustworthy evidence exists; no retroactive guess that all past actions were webapp. Preserve existing audit stores, retention, tenant/principal visibility, and provider-source distinctions. Cover both local administrative audit and the separate Copilot Studio quarantine audit; do not create a competing universal audit warehouse.

## Ordered manifest

| Step | Executable prompt | Direct prerequisites | Required completion record |
| --- | --- | --- | --- |
| 01 | [Contracts and feasibility](01-contracts-and-feasibility.md) | None | `completions/01-contracts-and-feasibility.md` |
| 02 | [Dormant API identity and credentials](02-api-auth-foundation.md) | 01 | `completions/02-api-auth-foundation.md` |
| 03 | [API authentication and worker integration](03-api-auth-integration.md) | 01, 02 | `completions/03-api-auth-integration.md` |
| 03A | [Shared API parity and audit origin](03A-shared-api-and-audit-origin.md) | 01, 03 | `completions/03A-shared-api-and-audit-origin.md` |
| 04 | [Complete API read and analysis contracts](04-api-read-contracts.md) | 01, 03, 03A | `completions/04-api-read-contracts.md` |
| 04A | [Shared API controls and web consumers](04A-api-agent-controls.md) | 01, 03, 03A, 04 | `completions/04A-api-agent-controls.md` |
| 04B | [Complete web cutover and regression qualification](04B-webapp-cutover-and-qualification.md) | 01, 03, 03A, 04, 04A | `completions/04B-webapp-cutover-and-qualification.md` |
| 04C | [API/web production release and manual-test handoff](04C-api-webapp-production-release.md) | 04B | `completions/04C-api-webapp-production-release.md` |
| 05 | [FastMCP service and Entra authentication](05-fastmcp-service-and-auth.md) | 01, 03, 03A, 04C; explicit Part 1 acceptance | `completions/05-fastmcp-service-and-auth.md` |
| 06 | [Inventory, people, usage, and investigation tools](06-mcp-read-tools.md) | 04, 05 | `completions/06-mcp-read-tools.md` |
| 07 | [Thin MCP block/unblock tools](07-mcp-agent-controls.md) | 03A, 04A, 05, 06 | `completions/07-mcp-agent-controls.md` |
| 08 | [Local container and lifecycle integration](08-local-container-integration.md) | 05, 06, 07 | `completions/08-local-container-integration.md` |
| 09 | [Client onboarding and prompt evaluations](09-client-workflows-and-evaluation.md) | 06, 07, 08 | `completions/09-client-workflows-and-evaluation.md` |
| 10 | [Azure infrastructure and deployment automation](10-azure-deployment-integration.md) | 03, 04C, 05, 08, 09 | `completions/10-azure-deployment-integration.md` |
| 11 | [Release, recovery, and capacity qualification](11-release-qualification.md) | 01, 02, 03, 03A, 04, 04A, 04B, 04C, 05, 06, 07, 08, 09, 10 | `completions/11-release-qualification.md` |
| 12 | [Production deployment and live hardening](12-production-convergence.md) | 10, 11 | `completions/12-production-convergence.md` |

The exact manifest has sixteen prompts. Execute Part 1 sequentially: 01, 02, 03, 03A, 04, 04A, 04B, 04C; stop for user acceptance. After explicit acceptance/authorization, execute Part 2 sequentially: 05, 06, 07, 08, 09, 10, 11, 12. Preserve the lettered phases and existing filenames. README, supporting documentation, and completion/acceptance records are not executable phases. A single-phase invocation implements only that phase. 04C owns the first production release; 12 owns the second. Full MCP convergence remains unfinished until 12, but Part 1 is independently deployed and tested without MCP.

## Requirement ownership and proof

| Requirement | Implementation owner | Focused/integration proof | Production proof owner |
| --- | --- | --- | --- |
| Audience-correct identity and same-user data scope | 02, activation in 03; MCP side 05 | Invalid JWTs, native/guest principal parity, no portal-cache dependency, refresh/revocation | Web 04C; live MCP 12 |
| Same API routes and domain behavior for web/MCP | Contract 01; activation 03; reads 04; API controls 04A; full web cutover 04B; adapters 06/07 | Captured identical method/route/normalized payload; matched user/source/prestate results and errors; no MCP dependency in web app | Web 04C; paired MCP 11/12 |
| Admin origin and calling-client/agent audit | Schema/writers/API/export/UI 03A; capture/forward 05-07 | Verified channel, reported/unknown labels, spoof rejection, historical migration, async/replay/resume provenance, UI/CSV/MCP parity | Web/upgrade 04C; live MCP 12 |
| API queries, full About, creators/users/champions/trends | 04; adapters 06 | Full pagination, exact joins, provenance, unknown/overlapping periods, complete text | Web/API 04C; MCP 12 |
| Package/Studio block and unblock | API/web 04A; MCP adapter 07 | Preview binding, both providers, unchanged web effects, no guessed targets, readback, idempotency | Web 04C; MCP 12 |
| Every existing web feature and exclusive canonical endpoint use | Complete map 01; per-contract consumers 03/03A/04/04A; exhaustive cutover 04B | Feature/route coverage, no obsolete consumers, no MCP process/dependency, browser and direct bearer regression | 04C plus explicit user acceptance |
| Interactive confirmation and autonomous scheduling | Client workflows 09; shared tools 07 | Interactive pause and scheduled no-pause transcripts; no API policy engine | 12 |
| Explicit refresh and investigations | API authentication 03; full web consumers 04B; adapters 06 | Provider-free saved reads, explicit dispatch, cancellation, permission errors | Web 04C; MCP 12 |
| OAuth persistence and credential recovery | 05; mounts/lifecycle 08 and 10 | Restart, key rotation, revoked connection, worker authorization pause/resume | 11, 12 |
| Local/Azure delivery and portal preservation | API/web release tooling 04C; MCP extension 08/10 | Deployment mocks, Compose cold/restart tests, browser/API regressions, first release without MCP | 04C, 12 |
| Client interoperability, capacity, errors, and audit | 09, 11 | Synthetic prompt corpus, real-client attempts, fixed limits, redacted evidence | 12 |

## Bounded execution and validation contract

- Reuse existing bounds: inventory pages at most 100, current adoption group-page limits, API detail envelope at most 524,288 bytes, and provider-specific mutation/job limits. Never raise limits to hide an adapter problem.
- Use explicit continuation for oversized text/collections; do not silently truncate About descriptions or claim first-page results are exhaustive. Return total/returned counts and next cursors.
- Start MCP adapter reads with at most four concurrent API requests per invocation, 30-second request deadlines, and a bounded 10-second token-exchange deadline consistent with existing MSAL networking. Pin actual end-to-end limits in 01, prove them in 11, and keep retries inside the same budget. Honor cancellation and `Retry-After`; never automatically replay uncertain writes.
- Submit asynchronous operations and return job references rather than hold a tool call until a large job finishes. Job state and verified item outcomes remain separate.
- Use synthetic fixtures for authentication, directory, report, content, and provider tests. Real-model/client evaluations may send only synthetic or explicitly approved customer-controlled data; never export workspace source or credentials to third-party services.
- Tests must distinguish `passed`, `failed`, `not_run`, `unavailable`, and `inconclusive`. Mock, SDK, live-client, and live-provider evidence are different. Builds do not prove behavior.
- Use existing Node/Vitest, PowerShell deployment tests, Compose isolation, and browser harnesses. Add pytest only for the new Python service in Part 2 and only after its manifest is created. Phase prompts name focused selectors; aggregate API/web regressions belong to 04B and complete API/MCP qualification to 11.
- Every phase updates directly related docs and traces all affected roots. A root may remain unchanged only after a recorded impact check. No unrelated refactoring, commits, pushes, branches, production resets, or broad cleanup.
- Parity tests use identical principal/source/input/prestate with independent synthetic mutation fixtures; do not mutate the same live target twice to pretend to compare outcomes. Audit tests separately verify that channel/client differences are retained without changing business results.

## Package feeds, workers, and questions

All npm access must use `https://packagefeedproxy.microsoft.io/npm/`. All Python installation must use `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple ...`; lock/install subprocesses and containers must use the same feed. Reject conflicting public extra indexes and direct package URLs. Never probe or fall back to default/public registries. Install only after a dependency-manifest change or a genuine missing-tool/package failure.

For delegated execution, use one fresh GPT-6 Astra worker with `xhigh` reasoning per phase, overriding the implementation skill's model default. Do not silently substitute another model or nest implementation workers. If that model cannot be launched, record the limitation and let the parent work directly. Read the applicable implement-folder worker contract and campaign state. Parent decisions own material architecture changes.

If a necessary question is asked, stop and wait for the actual answer. No autopilot, unavailable tool, historical target, or existing credentials imply consent. Secrets are entered directly into the operator's approved terminal/secret store, never chat.

## Always-Deploy Production Contract

Each part requires its own production deployment, live observation, and fix-forward handling, not a test-only readiness artifact. 04C releases API/web only; 12 adds MCP after the explicit user acceptance boundary. **Creating this plan authorizes no live action.** Execution may touch production only after the operator explicitly identifies and approves the exact target and bounded changes through the deployment target/approval contract. Part 1 approval never authorizes Part 2 MCP resources/exposure. Historical campaigns' `seha` targets or reset permissions do not carry into this campaign.

- Attempt every applicable local, fixture, client/model, disposable deployment, browser, recovery, and capacity check. Repair reproducible defects; preserve every true result.
- Residual non-passing preproduction evidence alone does not veto deployment. For each residual record affected scope, containment, telemetry/canary, alert threshold, named operating owner, and exact fix-forward trigger.
- Never weaken authentication, authorization, source isolation, or provider-write validation to make deployment succeed. Deploy code, observability, and unaffected paths with only affected unsafe routes/tool exposure closed through operational admission or the server tool allowlist. Withholding a client UI entry alone is not containment. This release containment is not a new customer approval-policy engine.
- 04C expresses API/web admission, checkpointed schema upgrade, and exact artifact receipt using existing deployment tooling without MCP; 10 extends that accepted contract for MCP route/tool containment. Do not invent ad hoc production flags during either release or resurrect alternate/legacy writers.
- Verify production identity, approved resource IDs, Entra registrations, callbacks, consent, current health, and strongest available backup/checkpoint. Unknown recovery evidence stays unknown.
- Qualify the exact deployed revision using isolated synthetic namespaces and explicitly approved disposable provider targets. Never block a real department/company as a canary. Restore approved canary prestate and verify readback.
- Observe existing web/API workflows in 04C and critical MCP workflows plus unrelated portal/API health in 12. Production feedback drives containment, root fix, focused validation, redeployment, and repeat canary.
- Cleanup failures remain owned cost/security incidents, not a reason to cancel safe deployment or hide a failure.
- Missing explicit target approval or literal inability to execute required production control-plane actions leaves the campaign open as `deployment_pending`, with the exact resumable action. It must not close as test-only success.
- If safe deployed containment prevents proving a required tool, record `production_hardening_pending`, keep the campaign open, and continue fix-forward until the agreed paths are exposed and proven. Deployment alone is not completion.
- The user-requested Part 1 manual-test pause is mandatory, not a failed preproduction check to bypass under Always-Deploy. `awaiting_user_acceptance` is an intentional open campaign state after a successful first release. No automatic continuation across this boundary; only an actual user acceptance/start instruction unlocks Part 2.

## Completion and resuming

Do not create fictional completion records during planning. Each worker writes the exact manifest path after implementation with requirements, changed files, contracts, decisions, root impact checks, test commands/results, environment evidence, residuals, and next-phase preconditions.

The parent maintains `completions/IMPLEMENTATION_CAMPAIGN.md` when execution begins, with the sixteen-step manifest, part membership, prompt SHA-256 hashes, dependency/status ledger, current revision, separate release target references without secrets, and Part 1 acceptance state. Changed prompts require revalidation of affected completed phases. Keep one implementation phase active at a time. Preserve both production receipts; never overwrite Part 1 evidence with Part 2 qualification.

Start with [01](01-contracts-and-feasibility.md). To execute manually, ask the agent to implement the selected prompt while reading this README and prerequisite completion records. An `implement-folder` invocation for `plans/fastmcp-integration` initially runs only Part 1 through 04C, then stops for the actual user response regardless of automatic-continuation defaults. A later explicit accepted-revision/start-Part-2 instruction resumes at 05; production actions still require the separate exact target/change approvals above.
