# MCP interface and web settings

## Outcome and approved boundaries

Preserve every currently supported MCP capability while making the interface
easier for an AI agent to choose and use. Supply concise server instructions,
then expose the running server's exact client-visible definitions in the web app.

The user approved:

- Native, typed domain tools rather than a discovery/dispatch gateway.
- A **read-only** MCP settings page for all users with Viewer-capable roles,
  including Admins. Configuration remains owned by deployment tooling.
- Local isolated testing and, **only after the user explicitly starts a future
  implementation campaign**, redeployment and observation of project `seha`.
- Preservation of the database, volumes, existing OAuth keys and connections.

Creating or reading this folder does not authorize deployment now. This is a
plan-only change; no application implementation or deployment is claimed.
The future campaign does not need another application-owned acceptance gate.
Real interactive authentication, role checks and destructive-action confirmation
remain mandatory where applicable.

**Review decision (2026-11-04):** the user selected `prepared-secret`. Local
deployment automatically creates the independent metadata credential. Azure
keeps its existing prepared, version-pinned Key Vault secret model, adding one
metadata-only secret shared with the API/MCP services. Do not add Key Vault write
privileges or a second secret-provisioning workflow. This changes neither the
local deployment authorization nor ordinary application access.

## Runtime flow and design decision

**Current:** deployment settings -> Python MCP server -> 124 individual operation
tools -> canonical API. Clients receive individual descriptions but no explicit
server instructions. The browser has no MCP metadata connection.

**Target:**

1. Deployment supplies the configured MCP binding and protected credentials.
2. The MCP owner registers typed domain tools and concise `instructions`.
   Public tools dispatch only to the existing finite canonical operations.
3. Clients receive those instructions at initialization and the registered
   definitions through normal MCP discovery.
4. A protected, metadata-only MCP endpoint exposes that same final wire metadata
   and nonsecret runtime settings. The authenticated web API reads it directly.
5. The browser shows an MCP settings page for the current configured tenant,
   with exact descriptions, instructions, tool count, schemas and truthful status.

**Verdict: simplify the interface, retain the canonical API.** Do not redesign
business handlers, introduce a generic HTTP/SQL/KQL executor, add a registry
service/database, or copy a tool catalog into TypeScript or Markdown for the UI.
Grouping has a real tradeoff: fewer tools can produce larger schemas. Measure
both discovery size and tool-selection usability rather than merely renaming
124 operations behind a giant untyped dispatcher.

The simpler alternatives do not meet the agreed outcome: instructions alone
leave the 124-tool surface unchanged, a bundled catalog can drift from a
separately deployed sidecar, and using delegated MCP OAuth for the page would
require user authority that ordinary saved-data viewers need not have.
A dedicated metadata-only credential therefore has a concrete purpose; it
never authorizes business tools or adds a user approval/feature-enable step.

Keep three cohesive phases: the public contract has its own SDK/consumer proof,
the settings feature owns its entire producer-to-page path, and the final phase
owns aggregate verification and production convergence. Splitting credentials,
API and UI into separate micro-phases would add handoffs, not useful cutovers.

## Repository and controlling evidence

All application roots are in this repository; resolve paths from the current
checkout, not a previous machine:

| Root | Controlling surfaces |
| --- | --- |
| MCP | [catalog](../../mcp/src/agent_control_mcp/tools.py), [service](../../mcp/src/agent_control_mcp/service.py), [settings](../../mcp/src/agent_control_mcp/config.py), [API invocation](../../mcp/src/agent_control_mcp/api.py), [tests](../../mcp/tests) |
| Backend | [configuration](../../backend/src/config.ts), [route policy](../../backend/src/routes/policy.ts), [workbench metadata](../../backend/src/services/workbenchMetadata.ts), [shared metadata types](../../backend/src/types/workbench.ts), [API assembly](../../backend/src/app.ts) |
| Frontend | [application](../../frontend/src/App.tsx), [routing](../../frontend/src/workbenchRouting.ts), [authorization](../../frontend/src/authorization.ts), [API client](../../frontend/src/api/client.ts), [browser tests](../../frontend/browser) |
| Deployment | [MCP deployment owner](../../scripts/local-mcp.ps1), [local environment writer](../../scripts/local-deployment.ps1), [runtime](../../scripts/local-runtime.ps1), [Compose](../../compose.yaml), [MCP overlay](../../compose.mcp.yaml), [Azure owner](../../scripts/azure-deployment.ps1), [API infrastructure](../../infra/main.bicep), [MCP infrastructure](../../infra/mcp.bicep), [secret access](../../infra/key-vault-access.bicep) |
| Integration proof | [isolated suite entry point](../../scripts/large-tenant-tests.ps1), [SDK/API suite owner](../../backend/scripts/largeTenantFixture.ts), [MCP container fixture](../../scripts/local-mcp-fixture.ps1), [real API/browser fixture](../../backend/scripts/browser-fixture.browser.ts), [browser fixture safeguards](../../backend/scripts/fixtureSupport.ts) |
| Existing contracts | [repository instructions](../../AGENTS.md), [MCP reference](../mcp-reference.md), [setup](../mcp-integration.md), [clients](../mcp-clients.md), [operations](../operations.md) |

Static source baseline: 124 unique operation/tool names, comprising 76 GET, 45 POST,
2 DELETE and 1 PATCH operations. There are 37 provider-marked and 16
destructive-marked operations; those classifications overlap. Counts are not
runtime discovery measurements or proof that all operations are available to
every user or provider. Phase 01 captures the actual SDK baseline before editing.

## Ordered manifest

Execute exactly these prompts, sequentially. README and completion records are
not phases.

| Order | Prompt | Outcome / owner | Prerequisite | Exact completion record |
| --- | --- | --- | --- | --- |
| 01 | [Simplify MCP contract and add instructions](01-simplify-mcp-contract.md) | MCP public contract, all changed consumers, capability preservation | None | `completions/01-simplify-mcp-contract.md` |
| 02 | [Expose runtime metadata and build settings page](02-mcp-settings-page.md) | End-to-end protected metadata, deployment wiring, web API and page | 01 | `completions/02-mcp-settings-page.md` |
| 03 | [Verify journeys, deploy and observe](03-verify-and-rollout.md) | Aggregate proof, authorized `seha` rollout and fix-forward convergence | 01 and 02 | `completions/03-verify-and-rollout.md` |

Each phase implements and tests its own outcome. Phase 03 reconciles and verifies;
it is not the owner of unfinished functionality from earlier phases.

## Shared implementation contracts

### A. Capability-preserving public interface

- Retain 100% of the baseline canonical operations, request semantics, full
  results, exact selections, pagination, provider identity, role enforcement,
  attribution, jobs and recovery behavior. Maintain a complete baseline-to-new
  mapping in phase 01's completion record and exercise it in tests.
- Target at most **62 public tools**, half the current count, and a strictly
  smaller complete serialized discovery payload. Record baseline and final
  UTF-8 bytes for identical discovery fields, including input/output schemas.
  Meet both targets through coherent consolidation, not capability removal,
  missing schemas, truncated descriptions or an arbitrary executor.
  Measure compact UTF-8 JSON of `{"initialize": <complete InitializeResult>,
  "tools": [<every Tool from every tools/list page>]}` with identical serializer
  options and SDK version before/after. Record those options and both byte totals;
  transport headers and JSON-RPC request IDs are not catalog content.
- Use clear typed families and literal/discriminated actions where appropriate.
  Preserve explicit destructive operations and their preview/confirmation
  boundaries. Do not mix side effects into a tool advertised as read-only.
  Keep side-effect and destructive annotations accurate and conservative.
- Keep internal finite API operation bindings if they remain the current owner;
  that is not permission to retain superseded public names as aliases.
  Remove replaced public tools and update all clients, fixtures, tests and docs.
- Public diagnostics/counts come from the registered public tools, not
  `len(OPERATIONS)`: canonical operation count and public tool count now differ.
- Do not add business joins, provider writers, schedulers or automatic retries.
  Saved reads must not trigger collection or capability probes.

### B. Instructions and exact metadata

- One MCP-owned instruction string covers purpose, domain terminology, normal
  workflows, saved versus freshly collected data, exact identifiers/selections,
  pagination, partial/unknown results, provider actions, confirmation and errors.
  Keep it concise: at most **800 words**, without duplicating every tool schema.
- Instructions guide use; they do not train a model, override client policy,
  replace real authorization, or make capability checks a prerequisite to reads.
- The metadata producer uses the final SDK/client-visible serialization. Compare
  its server information/instructions against `initialize` and its tool objects
  against fully paginated `tools/list` from the same running instance.
- Names, descriptions, instruction strings, schemas and annotations must match,
  without paraphrasing or dropping tools. Descriptions rendered on screen retain
  their exact text; client use of that guidance remains client-dependent.
- No extra public MCP prompts/resources or generic discovery gateway are needed.
  Do not add a separate hand-maintained runtime server description: the purpose
  comes from the same instructions or supported server-information fields.
  Connector-wizard descriptions and consumer system-instruction templates may
  be delivered as canonical customer setup assets. Clearly distinguish them
  from exact runtime metadata; never substitute them for advertised instructions.

### C. Private runtime visibility

- Phase 02 owns `GET /internal/mcp-metadata` on the MCP service and
  `GET /api/mcp/settings` on the web API. These are metadata routes, not new MCP
  business tools. Reserve the internal path against resource-path collisions.
- Protect the internal route with an independent, strong metadata-only
  credential. Never reuse OAuth signing/encryption keys, Entra credentials or a
  user's bearer token. Locally, the existing owner creates/persists
  `secrets/mcp-metadata` automatically from at least 32 independent random bytes.
  Azure consumes one additional prepared, version-pinned Key Vault secret;
  deployment does not create its value or broaden secret-writing permissions.
  Only the relevant API/MCP identities may read it. API access to this one
  metadata secret does not grant access to the three MCP OAuth secrets.
- Only the authenticated web API contacts the deployment-controlled metadata
  origin. No caller-supplied destination, followed redirects, browser-to-MCP
  calls, Docker socket access, arbitrary filesystem reads or provider requests.
- Use a finite fetch deadline of **3 seconds** and a **4 MiB** streamed response
  limit. Validate identity, shape, duplicate tool names and bounded JSON before
  exposing data. If measured valid metadata requires a different byte limit,
  adjust both producer/consumer tests together and document the measurement.
- Verify tenant, API application, MCP application and resource binding against
  the current configured tenant. Never display another tenant/project's catalog.
  One backend binding check serves both navigation and the settings route; an
  API `integration` entry alone does not establish a deployed MCP binding.
  Use a direct page request, not a new cache/polling layer or SQL catalog owner.
- The backend supplies only whitelisted nonsecret fields: actual resource URL,
  callback allowlist, server identity/version/instructions/tools, readiness and
  observation time. Local host port is deployment metadata, not container port
  8000; show it only when genuinely known. Mark non-applicable fields honestly.
- The browser and its logs never receive metadata credentials, client secrets,
  signing/encryption material, tokens, cookies, OAuth transactions or raw env.
- Configured, reachable, storage-ready and authenticated-client-verified are
  different facts. A saved binding or HTTP 200 must not become “all tools work.”
  A metadata failure is explicit, never an empty catalog reported as success.
  App-to-MCP reachability does not prove that the public URL/tunnel is reachable
  or that a native client has authenticated. Label those checks unverified when
  there is no actual evidence; do not add background public/provider probes.
- Failure of this optional visibility path must not block web sign-in, ordinary
  MCP business use, saved reads or automatic browser synchronization.
  Missing, invalid or unresolved metadata-only configuration fails that path
  explicitly, not global API/MCP startup or existing OAuth admission. Do not
  weaken business authentication/storage fencing to obtain metadata.

### D. Web behavior

- Use workbench view ID `mcp-settings` and path `/mcp-settings`, consistent with
  the current metadata parser's `/${id}` rule. Reuse existing navigation,
  authorization, query/cancellation and accessible component patterns.
- Include the view for Viewer-capable users only when MCP is configured for the
  signed-in tenant. Once configured, keep it visible during MCP outages.
  An unconfigured direct link explains the state; it does not invent a setup gate.
- The existing workbench metadata body is capped at 65,536 bytes with shallow
  parsing. Add only navigation/configured presence there, not the tool catalog.
  Compute presence from the current tenant's deployment binding without an MCP
  request; fetch settings separately when the page is opened.
- Show exact server instructions, full resource URL, distinct Entra server
  callback versus allowed client callbacks, tool count, searchable tool names
  and descriptions, safety hints and expandable input/output schemas.
- Explain “advertised” versus “authorized/available.” Do not auto-run tools,
  sync, probes, OAuth enrollment or provider work just to populate the page.
- Provide loading, retryable failure, not-configured and unavailable states.
  A metadata-only refresh control is allowed; configuration editing is not.
  Clear stale principal-bound data on logout, tenant change and authorization loss.
- Render descriptions and schemas as inert text. Cover keyboard access,
  desktop/mobile layouts, long URLs and long descriptions without truncating
  the underlying information.

## Execution and completion records

Start a new session with:

```text
/implement-folder docs/mcp-interface-and-settings/
```

Use the installed `implement-folder` skill and its step-worker contract. Prefer
one fresh sequential worker context per phase, not concurrent editing workers.
A manual fresh session may execute one prompt, then hand off through its exact
completion record; never restart completed work merely because chat context ended.
The parent campaign owns integration and
`completions/IMPLEMENTATION_CAMPAIGN.md`; do not pre-create successful records.

Each phase reads this README, applicable repository instructions, its prerequisites
and their completion records. Record implemented/deleted contracts, decisions,
changed files by root, unchanged-root impact checks, actual commands/environments/
counts/results, content identity, authorized environment actions, residuals and
observable next-phase preconditions. Distinguish `passed`, `failed`, `not_run`,
`unavailable` and `inconclusive`. Never put credentials or customer records in receipts.

Keep the current-only implementation. No compatibility aliases, migration chains,
parallel metadata authorities, speculative frameworks or unrelated cleanup.
No database/schema change is expected for read-only runtime metadata.

### Verification boundaries

The normal `check` command runs software/SDK checks, not all browser, MCP
container or SDK-to-real-API journeys. The conditional SDK leg in backend read
tests is not exercised merely because those tests pass. Phase 01 owns real
SDK/API dispatch proof; phase 02 owns metadata wiring and a same-run browser ->
real API -> real MCP metadata journey. Phase 03 reconciles/reuses those results
against exact content and performs production proof.

Reuse the linked isolated suite owners. Phase 02 repairs only the implicated
runner/image wiring: remove the unrelated historical Node-image prerequisite
from the MCP-only container branch, and accept explicitly identified current
dependency/browser images instead of a historical browser tag/digest. Preserve
manifest, architecture, engine, ownership and isolation checks. Selected specs
must actually run with recorded case counts; zero selected cases is not success.
Do not use the older permission-browser helper against `seha` PostgreSQL.

Never commit, push or create branches without a separate explicit request.
Use only the package feeds in AGENTS; install only for a dependency-manifest
change or an actual missing-dependency/tool failure.

## Binding production-continuation policy

Every phase must obey this section. The future campaign ends with deployment,
production observation and fix-forward handling, not a test-only readiness report.

**Exact target:** the existing local `seha` project on this macOS host's verified
Docker Desktop `desktop-linux` context and local Unix socket. Reconcile current
service labels and project state before mutation; never assume old container IDs
or display names. Expected resources are `seha_data`, `seha_mcp-oauth`,
`seha_default`, web port 3002 and MCP port 3003. The last confirmed resource URL
was `https://ddnv5p3z-3003.eun1.devtunnels.ms/mcp`; verify saved/current settings
because the tunnel can change.

**Authorized after explicit campaign start:** project-owned disposable local
test stacks, existing validation tooling, building the changed application/MCP
images, normal `seha` deployment, app/MCP replacement/restart, read-only live
qualification and exact disposable-resource cleanup. Preserve PostgreSQL's
container/data, the two retained data volumes, project/network identity, existing
OAuth credentials/keys/state and configured tenant registrations.

Not authorized: resetting/recreating production PostgreSQL, deleting retained
volumes, clearing OAuth state, rotating existing keys, changing Entra grants or
redirects, production destructive/provider-control tests, unrelated Docker
resources, remote hosts, Azure deployment or additional paid services.
Update supported Azure configuration/templates/tests offline where a changed
contract requires it; no Azure control-plane action is implied.

1. Attempt applicable local, protocol, database, container, browser, model-assisted
   selection and capacity/bounds checks. Repair reproducible defects and record
   actual evidence. Attempt isolated restore proof if PostgreSQL or OAuth
   persistence formats/lifecycle change. The additive metadata credential needs
   restart/recovery and original-key continuity proof, not a new database backup
   subsystem; record why unchanged data stores need no campaign restore exercise.
2. `failed`, `not_run`, `unavailable` and `inconclusive` never become `passed`;
   none alone cancels authorized deployment. Each residual records affected
   scope, containment, telemetry/read-only canary, numeric alert threshold,
   owner and exact fix-forward trigger.
3. Preserve existing authentication, roles, confirmations and integrity controls.
   Contain proven unsafe behavior using relevant existing boundaries while
   deploying safe code and observability. Do not invent runtime release,
   requalification, feature-enable, canary-approval or manual-sync gates.
   Merely unmeasured functionality is not permission to disable working features.
4. Verify the exact deployed content, isolate synthetic data from `seha`, observe
   real workflows and unrelated web health, then fix -> focused check -> redeploy
   -> observe until the promised journey works. No legacy fallback implementation.
5. Own disposable cleanup alongside production hardening. A cleanup failure is
   an owned cost/security incident, not permission to delete unrelated resources
   or cancel deployment.
6. Only missing live-action authorization or literal inability to execute the
   authorized control-plane action leaves `deployment_pending`. Keep the campaign
   open with an exact resumable action. Deployed but unproven/contained promised
   behavior is `production_hardening_pending`, not complete or “NO-GO.”

Preserve normal deployment/reset/sign-in behavior: initial read-only sync starts
automatically. Prove a clean first run only in the isolated fixture, never by
resetting `seha`. Future execution approval is not runtime authorization.
