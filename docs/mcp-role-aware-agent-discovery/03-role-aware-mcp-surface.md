# 03 - Role-aware native MCP tools and runtime metadata

## Mission and prerequisites

Expose the right native tools and action schemas for each authenticated audience,
wire the discovery and staff-preview API, and preserve canonical invocation
authorization.
Prerequisites: phases 01/02 and their exact completion records:
`completions/01-roleless-discovery-authority.md` and
`completions/02-safe-agent-discovery-api.md`.

Read and obey [README](README.md), especially contracts A/E and the binding
always-deploy production contract. Read installed implementation/worker
contracts and the campaign record.

## Read first

- [Phase 01](01-roleless-discovery-authority.md),
  [phase 02](02-safe-agent-discovery-api.md) and their implemented contracts.
- [Tool owner](../../mcp/src/agent_control_mcp/tools.py),
  [family owner](../../mcp/src/agent_control_mcp/domains.py),
  [service](../../mcp/src/agent_control_mcp/service.py),
  [instructions](../../mcp/src/agent_control_mcp/instructions.py),
  [API invocation](../../mcp/src/agent_control_mcp/api.py),
  [MCP auth](../../mcp/src/agent_control_mcp/auth.py),
  [pinned SDK/dependencies](../../mcp/pyproject.toml).
- [SDK discovery tests](../../mcp/tests/test_discovery.py),
  [tool tests](../../mcp/tests/test_tools.py),
  [metadata tests](../../mcp/tests/test_settings_metadata.py),
  [workflow tests](../../mcp/tests/test_workflows.py),
  [recording owner](../../mcp/src/agent_control_mcp/recording.py).
- [Settings API](../../backend/src/routes/mcpSettings.ts),
  [metadata transport](../../backend/src/services/mcpSettings.ts),
  [settings types](../../backend/src/types/mcpSettings.ts),
  [settings page](../../frontend/src/components/McpSettings.tsx),
  [browser spec](../../frontend/browser/mcpSettings.spec.ts).
- [MCP reference](../mcp-reference.md), [client guide](../mcp-clients.md),
  [integration guide](../mcp-integration.md) and
  [Studio reference](../copilot-studio-mcp-connection.md).

## Concrete work

1. First falsify SDK feasibility with real supported initialize/tools-list/
   tools-call hooks using two authenticated audiences. Inspect the pinned SDK
   public contracts, not assumptions about a newer version or a private-store
   workaround. Keep the existing native MCP transport; no generic dispatcher,
   client-only hiding or custom protocol implementation.
2. Bind phase 02's finite canonical operations using existing typed DTO patterns.
   Group employee reads around three useful responsibilities: `agent_catalog` for
   search/detail and necessary provider-free selection/description continuation,
   `my_workplace` for department champions/use-cases and department/company
   popular agents, and
   `my_discovery_profile` for own context/self-champion status.
   Keep concrete typed actions and complete output schemas. Reuse native family
   patterns; do not introduce a universal discovery executor or user-selected
   route/SQL/KQL. Record exact final names/actions and operation mapping.
   Add `preview_end_user` only for Viewer/Uploader/Admin, with exact subject
   input and finite typed preview actions bound to phase 02's shared reads.
   Requests such as "assume I am abc@domain.com" use that tool, not an auth
   account switch or unrestricted adoption data. Remove the superseded planned
   `my_department` name; do not add an alias for an unimplemented old contract.
3. Obtain the current caller's bounded access projection through the API's
   phase 01 authority endpoint using the same validated delegated/OBO identity.
   Preserve existing invocation/exchange deadlines, byte limits, revocation,
   attribution and cancellation. No member/admin inference from upstream
   display names, client hints, headers or a tool caller's chosen role.
4. Project the immutable public catalog per request. Remove unauthorized tools,
   family actions, descriptive text and input/output/unreachable `$defs`.
   Apply the API's finite role-controlled input constraints, including capability
   probe enums, rather than exposing Admin choices under a Viewer-allowed route.
   Keep original family request/result shape even when only one action remains;
   `PublicTool.grouped` currently depends on branch count and must not cause
   a filtered family to become a standalone wire shape. Recompute annotations
   honestly from surviving operations. No shared registry mutation.
5. Enforce operation permission again for every call, including hidden tool
   names, forged action/input, stale cached schemas and resumed sessions.
   The API remains the final authority. Role/member/tenant/epoch changes discard
   stale projections under current freshness/expiry rules. Any cache must be
   principal/authorization/expiry-bound and never share one user's catalog.
   Projection lookup failure is explicit; never return the full catalog as a
   successful fallback. Do not turn provider readiness into tool authorization.
   EndUser schemas/operations must contain no other-user preview capability or
   subject override. Staff preview keeps the actual actor's tool catalog and
   roles unchanged; only its response is the restricted EndUser lens.
   Consume the API's effective privacy flags without request/client overrides
   or a separate Python environment-policy owner. Respect privacy revision in
   any cached guidance/projection; canonical safe API output is authoritative.
6. Remove the global instructions' employee-inappropriate management/metric
   guidance. Use supported dynamic instructions if available; otherwise keep
   common initialization role-neutral and use projected tool descriptions.
   Guide employees to interpret goals, expand terms, fetch evidence, distinguish
   created/used/popular/champion suggestions, contact relevant owners, and
   recognize that discovery does not grant access. Contact guidance is
   conditional on the corresponding privacy flag; hidden identities are not
   absent owners/champions and must not be inferred from other staff tools.
   Retain explicit source-text
   instruction isolation, paging/freshness/error semantics and staff controls'
   current confirmation/recovery guidance where those tools are visible.
   For staff preview, state the selected account and stored workplace scope,
   use the safe preview tool on every explicitly subject-aware request, and
   never claim to authenticate/act as that account or prove its live access.
   Department popularity uses stored company + department; company popularity
   uses stored company alone. Honor top three independently for both scopes.
   When a privacy category is hidden, do not echo the preview subject's identity
   as that owner/champion; own champion status can remain a nameless answer.
7. Update the existing private metadata endpoint/transport so staff MCP settings
   renders the same caller projection serialized by the MCP owner, not a
   TypeScript copy/filter that can drift. Backend derives trusted projection
   input from its current policy; clients cannot submit arbitrary audience/
   permission keys. The metadata credential remains metadata-only, with current
   Host/origin/binding/no-store/byte/time bounds and no business-token authority.
   Existing privileged operator/recorder catalog access stays internal.
   Extend the read-only settings response/page with both API-owned effective
   privacy values and their EndUser/preview scope. Keep these separate from
   MCP-observed metadata and available even when that metadata is unreachable.
   Do not add browser editing or pretend MCP supplied an independent policy.
8. Preserve current allowed operations for Viewer/Uploader/Admin; remove only
   unauthorized advertising, not supported admin recovery or saved-read
   functionality. Update every affected test/fixture/client/settings consumer
   and directly related setup/reference/Studio documentation.
   Remove superseded unconditional catalog paths and stale all-tools-for-all
   assertions; retain no compatibility catalog, alias or roleless-full-catalog
   fallback. Keep the employee browser scope from phase 01.

## Focused verification

Use actual SDK clients with synthetic signed identities and the canonical API
adapter, not snapshots of locally edited Python dictionaries:

```sh
cd mcp
.venv/bin/python -m pytest tests/test_discovery.py tests/test_tools.py tests/test_service.py tests/test_settings_metadata.py tests/test_oauth.py tests/test_workflows.py tests/test_recording.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

From the repository root:

```sh
npm run test --workspace backend -- src/services/mcpSettings.unit.test.ts src/routes/mcpSettings.unit.test.ts src/routes/policy.test.ts
npm run test --workspace frontend -- src/components/McpSettings.test.tsx src/authorization.test.ts
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
git diff --check
```

Use the existing isolated MCP/API/database fixture for end-to-end operation
binding and metadata equality. Run the settings browser spec through the
existing browser runner, recording exact selected/executed cases.

Required assertions:

- Roleless active member sees only discovery; roleless guest sees no granted
  business catalog. Viewer/Uploader have no Admin-only tools/actions/schemas;
  Admin retains the actual supported baseline plus discovery. All three staff
  roles have the safe preview tool; EndUser cannot discover or call it.
- No forbidden variants or definitions survive nested schema references,
  instructions, descriptions, metadata or error details.
- A one-action projected family preserves the family envelope; empty tools
  disappear; all retained schemas validate real requests/responses.
- Same-server concurrent employee/Viewer/Admin and tenant/account switches do
  not contaminate each other's discovery or selections.
- Same-actor previews of two employees retain separate subject-bound cursors
  and results. Previewing an Admin account grants no Admin operation to a
  Viewer. EndUser forged preview/subject calls fail; subsequent default
  self-service resolves the real actor, not the last previewed subject.
- Real SDK calls return the selected account's stored department/company top
  three exactly as genuine self-service does, with explicit preview labels,
  the same period and no counts. A stored company is not replaced by tenant
  scope, email domain or provider claim.
- Expiry, refresh, demotion and canonical revocation invalidate permissions;
  named hidden calls and forged actions are rejected with no provider effect.
- Normal saved discovery after auth performs zero collection/control dispatches;
  phase 01 sign-in bootstrap is identified separately.
- Staff browser metadata equals that staff principal's actual SDK discovery
  definitions and instructions, including outage/freshness behavior.
- Hostile source descriptions stay data; they cannot cause administrative calls,
  credential disclosure, additional fetching or a fabricated task capability.
- Verify all four privacy combinations through actual MCP text and structured
  content, complete About/description paging and staff preview. There must be
  no hidden identity in tool examples, URLs, nested results, provenance or error
  details. Raw permitted staff tools remain unchanged, not mixed into preview.
- The read-only settings page shows the same effective booleans as the API
  access profile, including false defaults and metadata outages. Stale
  discovery/cursors after tightening do not restore personal data. Do not
  claim to erase identities already present in prior client conversation history.

Measure actual discovery count/bytes per audience; preserve complete valid
schemas rather than imposing an arbitrary new tool-count target. Compare the
current operation map against all retained authorized staff bindings.

## Production continuation

Obey the README always-deploy contract. Phase 04 deploys coordinated API/MCP
changes, not an adapter against an old API. Preserve OAuth state and callbacks.
Projection/authority failure must fail closed for the affected caller, not leak
the global catalog or impose an application-owned feature-enable gate.
Record residuals with exact signals, thresholds, owner and fix-forward trigger.

## Completion record and done conditions

Write `completions/03-role-aware-mcp-surface.md` with the README completion
content, SDK hook evidence, per-audience operation/schema map, single-action
family proof, staff-preview/EndUser denial and subject isolation, cache/authority
behavior, four-combination privacy and effective-settings parity, metadata
equality, measured count/bytes,
consumer deletions and actual focused/integration results.

Done when real MCP discovery and calls are audience-correct, all six employee
question types plus company popularity and explicit staff preview are bound to
safe shared canonical reads, unauthorized advertising and calls are prevented,
and staff metadata/clients remain coherent. Phase 04 can
test/deploy one current implementation without hidden switches or aliases.
