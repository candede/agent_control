# MCP technical reference

Developer and operator contracts for the optional Python MCP service.
For Entra registration and startup, use [Enable the MCP server](mcp-integration.md);
for client settings, use [Connect an MCP client](mcp-clients.md).
The [role guide](user-roles-and-permissions.md) owns permission explanations.

MCP authenticates external clients and calls the same canonical API handlers as
the browser. The API owns SQL, joins, metrics, provider effects, jobs and audit;
the browser never calls MCP. MCP adds no scheduler, classifier, generic
HTTP/SQL/KQL proxy, second provider writer or business approval system.
Configured operation needs no release receipt, feature-enable action or
qualification record. Initial browser synchronization remains automatic after
deployment/reset and sign-in.

**Find a contract:**

- **Tools:** [catalog](#typed-business-catalog), [wire semantics](#wire-vocabulary-and-result-semantics), [operation map](#canonical-operation-map).
- **Authority:** [authentication and providers](#authentication-and-authority), [audit origin](#administrative-audit-origin-v1).
- **Operations:** [configuration](#advanced-service-configuration), [storage and recovery](#storage-rotation-and-recovery).
- **Validation:** [browser contracts](#browser-contract-checks), [local checks](#verification).

## Typed business catalog

The service registers **50 native domain tools** covering **105 canonical operations**,
each with one typed `request` object and complete nested input/output schemas.
[`domains.py`](../mcp/src/agent_control_mcp/domains.py) owns the public families;
[`tools.py`](../mcp/src/agent_control_mcp/tools.py) owns canonical names/methods/routes/DTOs:
no caller-selected URLs, arbitrary queries, resources/prompts or hidden proxies.
The request-local invocation owner forwards authenticated attribution and
canonical defaults/errors; the API authorizes.

For a family use `{"request":{"action":"list","input":{}}}`, for example
`capabilities` (saved list), or `inventory` with action `about` and its exact
selection/source/field input. Family output is `{"action":"list","result":...}`;
`result` is the full unchanged canonical payload. Discriminated variants reject
unknown actions and another action's fields. Standalone tools (including previews,
provider-specific resume/reconcile) keep their exact request
and direct result. Package block/access execution uses explicit typed actions,
not a universal control executor. Full schemas retain local `$defs` references.

Read families are `capabilities`, `inventory`, `packages`, `native_inventory`,
`users`, `adoption`, `report_agents`, `report_users`, `report_datasets`,
`agent_usage`, `sync`, `package_refresh_jobs`, `studio_refresh_jobs`,
`package_control_jobs` and `studio_control_jobs`. Provider families
`collect_sync`, `collect_packages`, `access_principals` and destructive execution
families `set_package_block`, `set_package_access` are not advertised read-only.
The current operation-to-tool/action mapping is defined by `domains.py` and the
canonical map below. `/diagnostics` reports registered `businessTools` separately
from `canonicalOperations`.

Defender/hunting and Purview investigation tools, including their dedicated
identity/context helpers, are not exposed through MCP. Their canonical APIs and
provider implementations remain available, with unchanged authorization. Remaining
generic tools retain complete API payloads, including saved related audit/security
evidence, capability definitions and administrative audit actions from these sources.

The server's sole instruction owner is
[`instructions.py`](../mcp/src/agent_control_mcp/instructions.py), sent at initialize.
After a catalog rename refresh/reconnect tool discovery in the client. Do not
delete OAuth caches or rotate keys merely to refresh tools.

SDK annotations distinguish saved reads, selections, provider work and destructive
controls; idempotency is not replay permission. CSV import, capability configuration,
automatic browser refresh, binary download and optional operator canaries have no
tools.

## Read-only runtime visibility

Viewer, Uploader and Admin can open **MCP settings** at `/mcp-settings`.
Navigation is tenant-bound and remains present during metadata outages; a direct
link for an unconfigured tenant reports that no server is configured. This page
does not edit configuration, execute tools, enroll clients, probe providers or
start synchronization. Existing first-sign-in read synchronization is unchanged.

Connection details and observed runtime status are separate cards. Client
redirects, exact server instructions and individual tool contracts expand on
demand, without truncating their contents. The catalog searches complete names,
descriptions and schemas; tools without a nonblank display title show their
advertised name. Its read-only filter uses explicit SDK annotation hints,
not inferred permission. Endpoint/instruction copy actions affect only the
clipboard and report failure explicitly. No action on this page runs a tool.
Expanded schema panes are named, keyboard-focusable regions with bounded
scrolling; the complete schema remains available without widening the page.

The API reads `GET /internal/mcp-metadata` at its fixed deployment-controlled
origin with the independent `X-Agent-Control-Mcp-Metadata-Token` header.
The private HTTP(S) transport sends the validated public resource's `Host`,
as the local readiness check does; MCP's public Host/Origin protection remains
enabled. Node's built-in `fetch` does not preserve this Host override.
`GET /api/mcp/settings` accepts browser sessions and Viewer hierarchy only,
rechecks initiating authority and disables caching. The private metadata read
enforces a three-second total deadline and 4 MiB streamed bound. The browser
allows an additional 16 KiB for the settings envelope, plus its outer JSON level
and bounded wrapper tokens, so a valid boundary-sized catalog remains readable.
Instructions and the complete tool objects
come from the same registered SDK serialization as initialize/tools-list.
The existing shallow 65,536-byte workbench response contains navigation only.

Configured intent, internal reachability, observed OAuth storage readiness and
observation time are separate evidence. Readiness retains the last completed
probe result while a new health check runs; a failed check publishes not-ready.
Metadata observation itself never runs that probe. Public HTTPS/tunnel reachability and
authenticated native-client operation remain **unverified** by this page.
The displayed local host port is deployment-owned, not container port 8000.
Server `/auth/callback` and downstream client redirects serve different roles.
Missing, invalid or unresolved metadata protection fails this optional path
explicitly; it never vetoes business startup, sign-in or ordinary MCP admission.
Readiness observation reads no OAuth transactions/credentials and writes no probes.

## Supported implementation

| Component | Supported baseline |
| --- | --- |
| Service | `agent-control-mcp` 0.1.0; Python 3.14; production image Python 3.14.6 |
| Protocol and transport | MCP 2025-11-25; Streamable HTTP at the configured HTTPS resource path |
| OAuth server | FastMCP 4.1.0; MCP SDK 2.3.0; maintained JWT verification |
| HTTP and storage | httpx2 2.13.1; py-key-value-aio 0.4.6; cryptography 48.0.1 |
| Dependency owner | [`mcp/pyproject.toml`](../mcp/pyproject.toml), [`uv.lock`](../mcp/uv.lock); uv 0.12.17 |
| Routes and schemas | [`routes/policy.ts`](../backend/src/routes/policy.ts), current API DTOs and the canonical map below |
| Tool bindings | [`tools.py`](../mcp/src/agent_control_mcp/tools.py), [`inputs.py`](../mcp/src/agent_control_mcp/inputs.py), [`control_inputs.py`](../mcp/src/agent_control_mcp/control_inputs.py) |

Pins define the supported implementation, not vendor-client certification.
See the [client guide](mcp-clients.md#choose-a-client) for versions, callbacks
and known incompatibilities.

## Authentication and authority

### OAuth and token flow

| Boundary | Required contract |
| --- | --- |
| Client → MCP | Streamable HTTP, authorization on every request; protocol session IDs are not credentials |
| Discovery | 401 challenge points to protected-resource metadata for the exact resource path; issuer and `/authorize`, `/token`, `/register`, `/revoke` are on the MCP origin root |
| Downstream OAuth | Public DCR, exact allowlisted redirects, authorization code with S256/state; exact `resource=MCP_PUBLIC_URL` on authorize and code/refresh token requests |
| MCP → Entra | Exact tenant authority, MCP confidential credentials, `api://<MCP GUID>/Mcp.Access openid profile offline_access`; `forward_resource=false` for Entra's scope-based request |
| MCP → API token | OBO with MCP confidential credentials, upstream Entra MCP-audience assertion and only `api://<API GUID>/AgentControl.Access` |
| API admission | Verified signature/issuer/tenant, scalar v2 API GUID audience, delegated scope, configured integration `azp`, user identity and recognized API roles |

CIMD and alternate identity-assertion grants are disabled. SDK OAuth consent/CSRF
is retained, not application release/business approval. The signed downstream
reference JWT has the MCP HTTPS resource audience. It is **not** an OBO assertion:
public `get_access_token()` returns the verified upstream Entra token after SDK
token swap. No private SDK token store is read.

The service narrows upstream/API claims beyond SDK defaults: exact v2 scalar
GUID audience/issuer/tenant, delegated scope, integration `azp`, same user,
finite issuance/not-before/expiry, no ID/app token mode. Resource/S256 guards
cover both HTTP endpoints; refresh must preserve the original user.
Only maintained cryptography/storage verification is used.
Reference credentials that expire during the awaited upstream token swap are
rejected as unauthenticated (401), not reported as a server failure.

### Current principal and credential foundation

[`RequestPrincipal`](../backend/src/types/requestPrincipal.ts) is immutable,
non-secret authority. Credentials are ephemeral; assertions, provider tokens and
SDK caches are not serialized into SQL or MCP state. The API maps bearer identity
through its validated MSAL OBO response and client-info-backed
`account.homeAccountId`, matching resource tenant/local user and API binding.
Reject absent account/client info, sub-only fallback, changed identity or
contradictory audience/tenant.

Bootstrap requests only `openid profile` metadata, not Graph data or directory
read grants, and requires no prior browser login/cache. Provider acquisition is
for explicit provider work, not saved-data GETs. Unsupported live Entra responses
return `principal_mapping_unavailable`.
Entra may return already-consented grants with resource-GUID-qualified scopes,
including Graph's `00000003-0000-0000-c000-000000000000/<permission>`.
Scope validation recognizes the same exact provider URI/GUID identities as token
audience validation; other resources remain rejected. Returned grants do not
change Agent Control roles or trigger provider calls.

JWKS verification is RS256 at the fixed tenant endpoint, with bounded key/body
sizes, five-minute cache, 30-second unknown-key cooldown and ten-second fetch/
waiter deadline. Malformed JWT JSON and non-object payloads return
`401 invalid_bearer` before signing-key lookup. Expired keys are not an outage
fallback. Entra can backdate
`iat`/`nbf` by five minutes; token validity follows the verified signature, claims
and exact expiry, not a five-minute age limit on `iat`. Each API request verifies
its assertion and gives that immutable request authority at most five minutes
from server verification. Nested OBO/browser refresh cannot extend the same
authority; a subsequent request must verify its assertion again. Signed issuance
remains unchanged for account-revocation fences and provenance. External role
changes remain bounded by token expiry/reauthorization/provider denial, not by
local verification time. Browser sessions retain their original eight-hour
sign-in ceiling. Provider leases honor the earlier verified
assertion/session/provider expiry.

Reference-token lifetimes follow the [storage contract](#storage-rotation-and-recovery);
renewal threshold is 60 seconds. Local signing cannot renew expired/revoked
upstream connections. Claims challenges return bounded safe reauthorization data,
never raw provider bodies or silent provider-write retries. External revocation
is bounded by token expiry/reauthorization/provider denial; internal epochs fence
immediately.

Malformed token-endpoint success metadata returns 502
`invalid_authorization_response`, not a misleading request to reconnect.

### Current canonical integration

The API admits one verified authority before route policy, roles and capability
evaluation. Cookie plus bearer is 400 `ambiguous_authentication`; an invalid
bearer never falls back to cookies. Browser Origin/CSRF and session bookkeeping
remain intact. Public/browser-only routes reject bearer credentials.

Request-local authority follows nested services and in-memory worker handoff.
Awaited acquisition/publication rechecks the initiator, role hash, epoch and
expiry; other users' or later requests' grants cannot authorize old work.
Restart loses volatile credentials and pauses eligible work for explicit
same-principal reauthorization. Saved status does not resume it; sent-unknown
work needs read-only reconciliation, not automatic resend.

### Provider identity

Delegated MCP/API authentication does **not** make every provider read delegated:

| Operations | Provider identity |
| --- | --- |
| Package catalog/exact/selected refresh, resume, package detail sync | Configured API application's Graph token |
| `collect_sync`, actions `start` / `retry`: users, licensing, app activity, Graph packages | Application Graph tokens; actor's current API authority still required |
| `resolve_agent_people`; user entries in access-principal lookup/resolution | Application Graph `graph.users.read` |
| Studio inventory refresh/resume; Power Platform sync | Delegated Power Platform |
| Group entries in access-principal lookup/resolution | Delegated Graph `graph.directory.read` |

Application collection capabilities are `graph.package.read.application`,
`graph.users.read`, `graph.licenses.read` and `reports.copilotUsage.read`.
The API permits these for authenticated bearer actors; probes follow their
registered mode. This is collection authority, not fallback from denied delegated
requests. API-only identity resolution and investigations retain their existing
delegated or explicitly configured application/shared authority; they have no MCP tools.

## Source/schema/private identity baseline

[Current DDL](../backend/src/db/currentSchema.ts) and the
[strict verifier](../backend/src/db/schema.ts) define the sole supported schema.
Startup verifies it; incompatibility requires the explicitly confirmed operator
[reset/restore flow](operations.md), not an MCP compatibility migration.
Provider synchronization cannot recreate lost CSV history; reimport it.

Private identity is `(tenantId, MSAL account.homeAccountId)`, not email, name
or guessed `oid.tid`; guest home/resource identities can differ. Selections,
cursors, receipts and private investigations retain the actor's authorization
hash/epoch. Durable `bearer_issued_after` fences require JWT `iat*1000` strictly
after the cutoff; reissue in a later second if necessary. Recovery never rebinds
old workers/selections to fresh grants.

Saved directory/licensing/activity, packages, Power Platform and canonical
inventory have one tenant owner. Viewer-capable readers need no collector
provider permission for saved datasets. Narrower environment/type collections
update the same source, preserving unseen rows and original observations.
Refreshes require the initiating actor's current application/provider authority.

## Wire vocabulary and result semantics

- **I** inventory query: `inventoryScope=catalog|power_platform_only|all`
  (default all), canonical source/platform/category/access/creation filters,
  search ≤256, exact current sort keys/direction. POST `{query:I}` captures
  without paging; GET uses `selectionId`, cursor and limit 1–100 (default 50).
- **IS** dependent inventory page: required selection, optional cursor/limit.
  **R(endpoint)** report filters/selections are endpoint-specific and API-owned;
  meaningless or malformed filters fail 400. Company/department/facet null uses
  `~null`, literal strings use `~string:<literal>`. `~some-or-all` retains its
  special availability meaning. Omit unrelated optional fields rather than null.
- **U** inventory usage: matching `inventorySelectionId`/`selectionId`, optional
  set/cursor/limit; otherwise the endpoint's official-agent report selection.
- **T** exact package targets: `{selectionId?,ids?,recordIds?}`, max 5000,
  access max 100; all-matching requires a saved selection.
  **P** preview adds action/mutationScope/access. Parser acceptance of `reassign`
  is not implemented provider support.
- **X** access: availability/installation, add/replace, specific/none,
  ≤500 unique typed directory UUIDs. `none` is replace/empty; single PATCH is
  replace-only. All-users writes remain unsupported by the provider.
- **Q** Studio preview: action, snapshot and 1–25 exact native IDs, optional
  forceStatus; execute drops forceStatus and adds confirmation hash/key.
- **J** job history: limit 1–50 (20); item pages limit 1–100 (50) with exact
  revision/signed cursor. For the API-only investigation routes, **H** is an
  optional exact agent/person target; duplicate body/query fields must agree.
  **AF/HF** are curated Purview/Defender filters, never arbitrary KQL.
- **A** audit query: default limit 100 (clamped 1–5000), offset 0–100000,
  exact registered action/status/scope and actor/target filters; literal
  operation prefix ≤64 `[A-Za-z0-9_-]`, trimmed search ≤200; retention 90 days.

DTO owners: [inventory](../backend/src/types/unifiedAgents.ts),
[reports](../backend/src/types/officialReportApi.ts),
[package jobs/access](../backend/src/types/copilotPackage.ts),
[Studio](../backend/src/types/copilotStudioQuarantine.ts),
[Purview](../backend/src/types/purviewAudit.ts),
[Defender](../backend/src/types/defenderHunting.ts).

### Selections and identity

Continue only returned cursors with the same principal/selection/source/revision/
limit. Invalidated/expired pages fail without recapture. Counts distinguish
total/returned and saved memberships/latest collected rows. Unknown metrics,
dates, descriptions and incomplete evidence stay null/explicit, not zero/empty
success. Source/report/package IDs preserve case; UUIDs normalize lowercase.
Source-qualified references allow 10000 encoded characters and 512 UTF-16-unit
decoded identities; investigation references allow 2048 characters.

Saved exact user resolution is trimmed case-insensitive directory UPN matching,
not fuzzy names. `objectId` is null unless one directory object matches; report
ambiguity/missing directory and unknown concealment remain explicit. Paired
person/champion reads require unfiltered all-inventory and report selections
with matching dependencies. Report-only identities remain readable, not controllable.
Champions rank by responses descending, then positively used agent count, name
and identity; creation counts do not influence rank. Department agent lists are
not champions-only.

`createdWithinDays` freezes at selection `evaluatedAt`: any saved source creation
at or after the cutoff qualifies. Unknown creation excludes; modification/import/
observation dates do not substitute. SQL has no upper-bound future-time rejection.
The displayed earliest source creation may differ from membership.

### Saved text and comparisons

About continuation returns up to 16384 Unicode characters per exact source/
field/generation, preserving provenance and UTF-8 byte totals. Exhaust all
cursors for full text; no truncation/preview substitution. Bounds are 4 MiB/field
and 16 MiB/saved component. Adoption descriptions are 2048-character previews;
sections/children own saved configuration. Source text is inert, untrusted data,
not tool instructions or provider authority.

Trends compare retained snapshots, not inferred daily/all-time totals. Only
known, same-provenance, equal-length non-overlapping windows with matching
cohorts and complete unambiguous coverage permit deltas/growth. Overlapping,
unequal or undated windows do not prove growth. Zero baseline gives null percent
with new activity; absent metrics remain null. Never sum overlapping imports or
add non-additive active-user categories.

### Errors

Errors preserve bounded `application/problem+json` status/code/requestId,
sanitized details and cooldown: 400 input/cursor, 401 reauthorization, 403 role/
provider denial, 404 private-or-missing, 409 stale selection/receipt/prestate,
413 output, 429 cooldown, 503 admission/unavailability, 504 deadline.
Secrets/provider diagnostic bodies are not forwarded or logged.

## Invocation budgets

| Boundary | Enforced limit |
| --- | --- |
| Tool invocation | 60 seconds including token exchange, calls and safe-read retry |
| API dispatch | Four concurrent requests, eight physical requests, 30 seconds/request |
| API token exchange | Two exchanges, 10 seconds/exchange |
| Tool output | 524288 UTF-8 bytes including SDK text/structured/error envelope; explicit 413, never truncation |
| Retry | Safe GET only, once for 429/503 with bounded honored Retry-After; no deadline extension |
| Lists | One page/call; inventory/report ≤100, adoption groups ≤10 |
| Client example polling | ≤12 polls, ≥2 seconds apart, ≤120 seconds, then return pending |
| OAuth endpoints | 30 seconds/request |

POST/PATCH/DELETE submissions are never automatically replayed, including after
503, timeout or lost response. Transport dispatch rejects cookies, redirects,
proxy-environment authority and unsolicited compressed responses. Cancellation,
expiry and revocation are checked after awaited work and before response release.
Client context/result limits may be smaller than service limits.

API limits remain independently authoritative: body 512 KiB, selection ≤10 minutes
or earlier dependency transition, inventory pages/detail 524288 bytes, directory
physical request 10 seconds and resolution wall time 120 seconds (MCP may cancel
earlier). Example read workflows budget 32 calls/4 MiB/180 seconds, excluding
confirmation/job-completion waits; disclose incomplete scope instead of hiding pages.

## Exact controls

Controls require current Admin/provider authority, exact source/selection/prestate
and current receipt/hash. Generic Studio block/unblock is quarantine/unquarantine;
explicit package controls remain package effects even for Studio-linked packages.
Cross-provider work is not atomic.

Submissions retain stable caller keys: generic printable ASCII ≤200 non-whitespace
characters; package/Studio `[A-Za-z0-9_-]{1,128}`. Keys travel only in
`Idempotency-Key`. Generic receipts bind exact private user/action/targets/source/
prestate and expire at the earlier source expiry and ten minutes. Package stages
are at most ten minutes; Studio validity remains provider/source-owned.
Package previews show at most 20 targets plus an additional count.

Interactive clients display the preview and obtain current human confirmation.
Independently authorized schedulers can submit the same current receipt without
a human pause; no scheduler, bypass flag or human-proof API is supplied.
Changed/expired evidence needs a new preview, not carried-forward confirmation.
Resume `confirmed:true` covers only eligible unsent work.

Acceptance fixes initiator/origin once. Generic execution stores immutable
reviewed intent and child references, not a parent job/queue/outcome store.
Accepted/partial/final/verified, ineligible targets, authorization-wait and unknown
readback remain distinct. Receipt expiry prevents admitting missing children but
does not erase accepted child status. Status, item pages, cancel, explicit resume
and GET-only provider reconciliation remain the recovery authorities.
There is no automatic double dispatch. Local locks do not provide provider
atomicity/ETag guarantees; external post-reread change remains a readback risk.

## Canonical operation map

These are the **172** current registrations. API modules mount once under `/api`;
parameter names are literal route grammar. `V` includes Viewer, Uploader and
Admin; `U` includes Uploader/Admin; `A` Admin; `S` any validated session; `P` public.

The operation column below uses **internal canonical operation names**, not
public tool aliases; consult the mapping above for the current tool/action.
`—` means no MCP binding **and no bearer admission**. `HTTP only` is a shared
canonical API operation without a tool branch. Public tools use these exact handlers.
Browser mutations retain Origin/CSRF. Capabilities are registered IDs; dynamic
checks remain service-owned. Route/tool tests parse this table; update
registrations, schemas and rows together.

### Public, authentication, setup and Permissions

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/health` | none → ok | liveness | — | P |
| `GET /api/ready` | none → schema/maintenance readiness, 503 unavailable | readiness | — | P |
| `GET /api/auth/status` | none → configured/callback/setup | sign-in | — | P |
| `GET /api/diagnostics` | none → non-secret admission/fingerprint/limits | operator diagnostics | — | A |
| `GET /{*path}` | SPA path without asset/dot → HTML | deep links | — | P |
| `POST /api/auth/login` | username, returnTo default / → authorization URL | startSignIn | — | P |
| `GET /api/auth/login` | username?, returnTo? → redirect | sign-in recovery | — | P |
| `GET /api/auth/callback` | one-use code/state or error → safe redirect | Entra callback | — | P |
| `POST /api/auth/logout` | empty → 204, account session/authority revocation | signOut | — | S |
| `GET /api/me` | none → user/CSRF/role state | current user | — | S |
| `GET /api/workbench/metadata` | none → code-owned definitions | navigation | — | V |
| `GET /api/workbench/jobs` | none → ≤100 summaries/unavailable sources | Sync recovery | list_workspace_jobs | V |
| `GET /api/mcp/settings` | none → tenant-bound runtime metadata or explicit unavailable state | MCP settings | — | V |
| `GET /api/capabilities` | none → saved capability views | Permissions | list_capabilities | V |
| `GET /api/capabilities/check-progress` | retry?:failed → progress | check progress | get_capability_check_progress | V |
| `POST /api/capabilities/check` | empty body, retry?:failed → explicit token/read checks | Check status | check_capabilities | V |
| `POST /api/capabilities/:id/probe` | exact capability → view | targeted diagnostic | probe_capability | V |
| `PUT /api/capabilities/:id/configuration` | enabled/sharedDataScope → revision/view | configuration API | — | A |

### Inventory, About, configuration and responsibility

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/agent-inventory/selections` | query:I → selection/availability | inventory capture | capture_agent_inventory | V |
| `GET /api/agent-inventory` | I + selected paging → inventory page | Agents | list_agents | V |
| `GET /api/agent-inventory/health` | none → saved health/availability | summary cards | get_inventory_health | V |
| `GET /api/agent-inventory/summary` | IS → selected summary | selected summary API | get_inventory_summary | V |
| `GET /api/agent-inventory/facets` | IS, field, search?, selected? → facets | filters | list_agent_facets | V |
| `GET /api/agent-inventory/:recordId/detail` | IS → exact detail; 404/409/413 | detail modal | get_agent | V |
| `GET /api/agent-inventory/:recordId/members` | IS → source membership page | versions/export | list_agent_members | V |
| `GET /api/agent-inventory/:recordId/children` | IS, kind, source/value? → children | configuration | list_agent_children | V |
| `GET /api/agent-inventory/:recordId/sections` | IS, exact source scope/identity → sections | configuration | list_agent_sections | V |
| `GET /api/agent-inventory/:recordId/about` | selection/source/field, cursor? → 16384-character segment | full saved About | read_agent_about | V |
| `GET /api/agent-responsibility` | objectId/search/selection/cursor?, limit50≤100 → responsibility | Users responsibility | list_agent_responsibility | V |
| `POST /api/agent-inventory/people/resolve` | recordId, force?:false → people/change state | Look up people | resolve_agent_people | V; graph.users.read (application) |
| `POST /api/agents/selections` | query:I → actor-bound package selection | package capture | capture_packages | V |
| `GET /api/agents` | I + paging → package page | package/access views | list_packages | V |
| `GET /api/agents/:id/detail` | exact selection → saved package detail | package editor | get_package | V |
| `GET /api/inventory/resources/:nativeId/related` | snapshotId, environmentId? default empty → saved activity | source activity API | get_native_agent_activity | V |
| `GET /api/inventory/quarantine-selection` | snapshotId, 1–25 repeated selected IDs → exact resources/snapshot | native target API | resolve_studio_targets | V |

### Users, licensing, official reports, cohorts and retained history

These are saved reads, not provider requests or CSV reparses.

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/copilot-usage/users` | R(copilot_users) → user page | paid roster/licenses | list_users | V |
| `GET /api/copilot-usage/users/facets` | R, field, search? → facets | Users filters | list_user_facets | V |
| `GET /api/copilot-usage/users/unresolved-identities` | R → unresolved page | source quality | list_unresolved_users | V |
| `GET /api/copilot-usage/users/resolve` | exact username≤512; selectionId or setId → resolution | exact user lookup | resolve_user | V |
| `GET /api/copilot-usage/users/:objectId` | R, UUID → detail | user modal | get_user | V |
| `GET /api/copilot-usage/users/:objectId/service-plans` | R → plan page | licensing | list_user_service_plans | V |
| `GET /api/copilot-usage/users/:objectId/agents` | R + relationship filters → page | person agents | list_user_used_agents | V |
| `GET /api/copilot-usage/users/:objectId/agent-relationships` | paired selections, relationship, cursor/limit → edges | exact relationships | list_user_agent_relationships | V |
| `GET /api/copilot-usage/adoption` | R(adoption), ≤10 groups → adoption page | Adoption | list_adoption_groups | V |
| `GET /api/copilot-usage/adoption/summary` | R → unfiltered organization summary | adoption totals | HTTP only | V |
| `GET /api/copilot-usage/adoption/departments` | R, limit/cursor/pageNumber → departments | department groups | HTTP only | V |
| `GET /api/official-usage/history/adoption` | R, limit/cursor → retained history | adoption trends | HTTP only | V |
| `GET /api/copilot-usage/adoption/facets` | R, field/search? → facets | organization filters | list_adoption_facets | V |
| `GET /api/copilot-usage/adoption/champions` | exact-group/full-inventory selections, paging → top-three edges | champions | list_champion_agents | V |
| `GET /api/office-app-adoption/context` | OfficeQuery, selection? → frozen context | Office dashboard | HTTP only | V |
| `GET /api/office-app-adoption/summary` | OfficeQuery/selection → organization totals/comparison | Office cards | HTTP only | V |
| `GET /api/office-app-adoption/comparison` | OfficeQuery/selection/baseline → summary | Office comparison | HTTP only | V |
| `GET /api/office-app-adoption/history` | OfficeQuery/selection/paging → provider-date history | Office trends | HTTP only | V |
| `GET /api/office-app-adoption/groups` | OfficeQuery/selection, limit5/paging → groups | Office group drilldown | HTTP only | V |
| `GET /api/office-app-adoption/departments` | OfficeQuery/selection/paging → departments | Office departments | HTTP only | V |
| `GET /api/office-app-adoption/facets` | OfficeQuery/selection/kind/search/paging → facets | Office filters | HTTP only | V |
| `GET /api/office-app-adoption/groups/:groupId/people` | OfficeQuery/selection, limit100/paging → paid people | person suggestions | HTTP only | V |
| `GET /api/official-usage/aggregate` | R(official_agents) → agent report page | report inspector | list_report_agents | V |
| `GET /api/official-usage/aggregate/facets` | R, field/search? → facets | inspector filters | list_report_agent_facets | V |
| `GET /api/official-usage/users` | R(official_users) → report users | reported users | list_report_users | V |
| `GET /api/official-usage/users/facets` | R, field/search? → facets | reported-user filters | list_report_user_facets | V |
| `GET /api/official-usage/agent-users` | R(relationships) → bridge page | bridge API | list_report_relationships | V |
| `GET /api/official-usage/agents/:agentId` | R, case-sensitive ID → detail | agent report detail | get_report_agent | V |
| `GET /api/official-usage/agents/:agentId/users` | R + child filters → relationships | agent users | list_report_agent_users | V |
| `GET /api/official-usage/users/:username` | R, case-sensitive username → detail | reported-user detail | get_report_user | V |
| `GET /api/official-usage/users/:username/agents` | R + child filters → relationships | reported-user agents | list_report_user_agents | V |
| `GET /api/official-usage/users/:username/directory` | R → uniquely linked directory detail/404 | directory follow-up | get_report_user_directory | V |
| `GET /api/official-usage/users/:username/service-plans` | R → linked plans/404 | license follow-up | list_report_user_service_plans | V |
| `GET /api/official-usage/history` | R(history) → sets/history summary | report history | list_report_history | V |
| `GET /api/official-usage/history/options` | R, setId? → ordered options | personal report picker | list_report_options | V |
| `GET /api/official-usage/history/:setId/observations` | R → observations | source detail | list_report_observations | V |
| `GET /api/official-usage/overview` | R, scope default history → locator | overview API | get_report_overview | V |
| `GET /api/agent-inventory/:recordId/usage` | U → usage summary | modal metrics | get_agent_usage | V |
| `GET /api/agent-inventory/:recordId/usage-history` | U without set/search, paired comparison IDs? → history/comparison | usage trends | list_agent_usage_history | V |
| `GET /api/agent-inventory/:recordId/usage-users` | U, search? → grouped users | usage users | list_agent_usage_users | V |
| `GET /api/agent-inventory/:recordId/usage-associations` | U → reviewed/exact associations | usage links | list_agent_usage_associations | V |
| `GET /api/agent-inventory/:recordId/usage-candidates` | R, inventoryRevision? → candidates | repair API | list_agent_usage_candidates | A |
| `POST /api/agent-inventory/:recordId/usage-associations` | exact selection/report/source/revisions, confirmed:true → context | reviewed repair | — | A |
| `DELETE /api/agent-inventory/:recordId/usage-associations` | same confirmation/revisions without target → context | remove reviewed link | — | A |

### CSV import, personal report viewing, deletion and export

Streaming upload is 256 MiB/file, up to 100000 Users, 200000 Agents or 1000000
User-Agent rows; one file/six metadata fields, four global/two tenant streams,
30-minute deadline and separate staging quotas. Latest follows report content
period automatically. Personal `setId` reads do not write a tenant selection.

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/official-usage/staging` | multipart + bounded metadata/bundle/correction → preview | Add CSV reports | — | U; corrections A |
| `GET /api/official-usage/staging/:id` | UUID → preview | resume draft | — | U; own new drafts; corrections A |
| `GET /api/official-usage/staging/:id/diagnostics` | cursor, limit50≤100 → diagnostics | import errors | — | U; own new drafts; corrections A |
| `DELETE /api/official-usage/staging/:id` | UUID → 204 | discard draft | — | U; own unaccepted new drafts; corrections A |
| `POST /api/official-usage/staging/:id/accept` | exact intent/hash/revision → accepted | single-stage API | — | U; own new imports; corrections A |
| `POST /api/official-usage/bundles/:id/preview` | forDiscard? → bundle preview | validate/cleanup | — | U; own new imports; corrections A |
| `POST /api/official-usage/bundles/:id/accept` | bundleHash/expectedActiveRevision → accepted | import bundle | — | U; own new imports; corrections A |
| `POST /api/official-usage/sets/:id/preview` | operation:delete → confirmation | deletion preview | — | A |
| `POST /api/official-usage/confirmations/:id` | exact full confirmation → confirmed | confirmed deletion | — | A |
| `POST /api/data-exports` | selection/kind/IDs?/idempotencyKey → 202 ID | selected CSV export | — | V |
| `GET /api/data-exports/:id` | UUID → status/bytes/expiry | export polling | — | V |
| `DELETE /api/data-exports/:id` | UUID → 204 | cancel export | — | V |
| `GET /api/data-exports/:id/download` | UUID → streamed CSV | native download | — | V |

### Refresh and job recovery

MCP refresh is explicit. Browser initial/visibility/due synchronization stays
automatic; ordinary saved handlers do not refresh. MCP `collect_sync` actions `start`/`retry`
accept distinct users/graph_packages/power_platform source names, not report
upload or `clearSavedData`. Omission retains API default source selection.

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/data-sync/state` | none → sync state | Sync history | get_sync_state | V |
| `POST /api/data-sync/auto-refresh` | empty → automatic result | visible workbench | — | V |
| `POST /api/data-sync/runs` | initial/incremental/full, sources?, clearSavedData?:false → run | Sync all | start_sync | V; dynamic capabilities |
| `GET /api/data-sync/runs/:id` | UUID → run | run status | get_sync_run | V |
| `POST /api/data-sync/runs/:id/retry` | sources? → run | explicit recovery | retry_sync | V |
| `POST /api/data-sync/runs/:id/cancel` | empty → run | cancel sync | cancel_sync | V |
| `GET /api/data-sync/package-details` | none → detail state | detail progress | get_package_detail_sync | V |
| `POST /api/data-sync/package-details/start` | empty → detail state | detail collection | start_package_detail_sync | V |
| `POST /api/data-sync/package-details/cancel` | empty → state | cancel details | cancel_package_detail_sync | V |
| `POST /api/agents/refresh-jobs` | mode?:application, IDs?≤5000, key? → job | package refresh | refresh_packages | V; graph.package.read.application |
| `POST /api/agents/:id/refresh-jobs` | mode?:application, key? → exact job | exact refresh | refresh_package | V |
| `POST /api/agents/refresh-selection` | selection, IDs/recordIds?, key? → job | selected refresh | refresh_selected_packages | V; graph.package.read.application |
| `GET /api/agents/refresh-jobs` | J, mode=application → jobs | refresh history | list_package_refresh_jobs | V |
| `GET /api/agents/refresh-jobs/:id` | mode=application → job | refresh status | get_package_refresh_job | V |
| `GET /api/agents/refresh-jobs/:id/targets` | mode, revision/cursor/limit50≤100 → targets | refresh targets | list_package_refresh_targets | V |
| `POST /api/agents/refresh-jobs/:id/resume` | mode?:application → job | authorized resume | resume_package_refresh | V |
| `POST /api/agents/refresh-jobs/:id/cancel` | mode?:application → job | cancel refresh | cancel_package_refresh | V |
| `POST /api/inventory/refresh-jobs` | environmentId?, allowlisted types?, key? → job | Studio refresh | refresh_studio_inventory | V; powerPlatform.inventory.read |
| `GET /api/inventory/refresh-jobs` | J → jobs | native refresh history | list_studio_refresh_jobs | V |
| `GET /api/inventory/refresh-jobs/:id` | UUID → job | native refresh status | get_studio_refresh_job | V |
| `POST /api/inventory/refresh-jobs/:id/resume` | UUID → job | native resume | resume_studio_refresh | V; powerPlatform.inventory.read |
| `POST /api/inventory/refresh-jobs/:id/cancel` | UUID → job | native cancel | cancel_studio_refresh | V |

### Package controls and explicit Studio controls

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/agents/mutation-selection` | T + selection → counts | target counts | count_package_targets | A |
| `POST /api/agents/mutation-preview` | P → hash/summary/prestates | confirmation preview | preview_package_control | A; dynamic capability |
| `POST /api/agents/block` | T/hash/key? → 202 job | block selected | block_packages | A; graph.package.block.manage |
| `POST /api/agents/unblock` | T/hash/key? → 202 job | unblock selected | unblock_packages | A; graph.package.block.manage |
| `POST /api/agents/block-all` | selection/hash/key? → job | block matching | block_selected_packages | A; graph.package.block.manage |
| `POST /api/agents/unblock-all` | selection/hash/key? → job | unblock matching | unblock_selected_packages | A; graph.package.block.manage |
| `POST /api/agents/:id/block` | selection?/hash/key? → job | block exact | block_package | A; graph.package.block.manage |
| `POST /api/agents/:id/unblock` | selection?/hash/key? → job | unblock exact | unblock_package | A; graph.package.block.manage |
| `POST /api/agents/access` | T+X/hash/key? → job | bulk access | update_packages_access | A; graph.package.access.manage |
| `PATCH /api/agents/:id/access` | X replace/selection?/hash/key? → job | exact access | update_package_access | A; graph.package.access.manage |
| `GET /api/agents/bulk-jobs` | J → jobs | control history | list_package_control_jobs | V |
| `GET /api/agents/bulk-jobs/:id` | UUID → status | control progress | get_package_control_job | V |
| `GET /api/agents/bulk-jobs/:id/items` | revision/cursor/limit50≤100 → items | verified outcomes | list_package_control_items | V |
| `POST /api/agents/bulk-jobs/:id/cancel` | UUID → job | cancel | cancel_package_control | A |
| `POST /api/agents/bulk-jobs/:id/resume` | confirmed:true → unsent job | resume | resume_package_control | A; job capability |
| `POST /api/agents/bulk-jobs/:id/reconcile` | UUID → read-only provider outcomes | reconcile | reconcile_package_control | A; delegated read |
| `POST /api/agents/mutation-canaries` | exact action/target/pre/poststate → approval | optional operator API | — | A |
| `POST /api/agents/mutation-canaries/:id/execute` | confirmed/restorationApprovalId → result | optional restoration cycle | — | A |
| `GET /api/quarantine/status` | snapshot/nativeId/force?:false → status | Studio Manage | get_studio_status | V; dynamic powerPlatform.quarantine.read |
| `POST /api/quarantine/preview` | Q → preview | Studio confirmation | preview_studio_control | A; powerPlatform.quarantine.manage |
| `POST /api/quarantine/jobs` | Q execute/hash/key → job | Studio execute | execute_studio_control | A; dynamic manage |
| `GET /api/quarantine/jobs` | J → jobs | Studio history | list_studio_control_jobs | V |
| `GET /api/quarantine/jobs/:id` | UUID → job | Studio status | get_studio_control_job | V |
| `POST /api/quarantine/jobs/:id/cancel` | UUID → job | Studio cancel | cancel_studio_control | A |
| `POST /api/quarantine/jobs/:id/resume` | confirmed:true → unsent job | Studio resume | resume_studio_control | A; powerPlatform.quarantine.manage |
| `POST /api/quarantine/jobs/:id/reconcile` | empty → read-only outcomes | Studio reconcile | reconcile_studio_control | A; powerPlatform.quarantine.manage |
| `GET /api/quarantine/audit` | limit100≤500 → audit | Studio audit | list_studio_control_audit | V |
| `POST /api/quarantine/canary-approvals` | exact action/native/pre/post/snapshot → approval | optional operator API | — | A |
| `GET /api/quarantine/canary-approvals` | limit50≤100 → approvals | optional operator API | — | A |
| `POST /api/quarantine/canary-approvals/:id/execute` | confirmed/restorationApprovalId → result | optional restoration cycle | — | A; powerPlatform.quarantine.manage |
| `GET /api/directory/principals` | search2–120, limit≤50(default25) → bounded principals | access picker | search_access_principals | V; application graph.users.read for users; delegated graph.directory.read for groups |
| `POST /api/directory/principals/resolve` | 1–500 typed UUIDs → principals | access validation | resolve_access_principals | V; application graph.users.read for user IDs; delegated graph.directory.read for group IDs; require only the supplied types |

### API-only investigations and MCP administrative audit

Investigation routes remain available through the canonical API but have no MCP
bindings. Administrative audit remains an MCP tool. Saved
context/history/results do not silently refresh providers. Live API queries
use curated presets and exact identities. Purview is bounded to 168 hours,
20 pages/5000 rows/8 MiB, six polls/activation, 64 requests/12 activations;
Defender to 168 hours, 200 rows/2 MiB, 12 requests/four activations. Partial/
unknown coverage or empty no_data is not proof of completeness.

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/agent-inventory/investigations/context` | recordId → saved context | API-only saved context | HTTP only | V |
| `POST /api/agent-inventory/investigations/resolve` | recordId → verified identity context | API-only identity lookup | HTTP only | V; graph.agentIdentity.read |
| `GET /api/agent-inventory/investigations/purview` | recordId, paging/search/operation → saved records | API-only agent audit records | HTTP only | V |
| `GET /api/audit-search/catalog` | none → presets/limits/notices | API-only Purview catalog | HTTP only | V |
| `POST /api/audit-search/jobs` | tokenMode/AF/agentRecordId?, key? → job | API-only search | HTTP only | V; purview.audit.search.delegated |
| `GET /api/audit-search/jobs` | J, offset/user/agent? → history | API-only Purview history | HTTP only | V |
| `GET /api/audit-search/jobs/:id` | UUID → job | API-only Purview status | HTTP only | V |
| `POST /api/audit-search/jobs/:id/resume` | UUID → authorized job | API-only activation | HTTP only | V |
| `POST /api/audit-search/jobs/:id/cancel` | UUID → cancelled | API-only cancel | HTTP only | V |
| `DELETE /api/audit-search/jobs/:id` | confirmation:exact job ID → 204 | API-only local cache deletion | HTTP only | V |
| `GET /api/audit-search/jobs/:id/records` | limit100≤500/offset → records/count/job | API-only saved results | HTTP only | V |
| `GET /api/audit-search/jobs/:id/export.csv` | UUID → CSV ≤5000 rows/8 MiB/15s | CSV download | — | V |
| `GET /api/hunting/catalog` | H → templates/limits | API-only hunting catalog | HTTP only | V |
| `POST /api/hunting/jobs` | tokenMode/HF/H, key? → job | API-only hunt | HTTP only | V; defender.hunting.delegated |
| `GET /api/hunting/jobs` | J, offset/H → history | API-only hunting history | HTTP only | V |
| `GET /api/hunting/jobs/:id` | UUID/H → job | API-only hunting status | HTTP only | V |
| `POST /api/hunting/jobs/:id/resume` | UUID/H → authorized job | API-only activation | HTTP only | V |
| `POST /api/hunting/jobs/:id/cancel` | UUID/H → cancelled | API-only cancel | HTTP only | V |
| `DELETE /api/hunting/jobs/:id` | confirmation:exact ID/H → 204 | API-only local cache deletion | HTTP only | V |
| `GET /api/hunting/jobs/:id/rows` | limit100≤200/offset/H → rows/job | API-only saved hunt results | HTTP only | V |
| `GET /api/hunting/jobs/:id/export.csv` | UUID/H → CSV ≤200 rows/2 MiB/15s | hunt CSV | — | V |
| `GET /api/audit/events` | A → events/count | Admin Audit | list_administrative_audit | A |
| `POST /api/audit/events/export.csv` | 1–100 exact event IDs → CSV ≤1 MiB/15s | selected audit CSV | — | A |

### Shared generic controls

| Method route | Input → output | Browser consumer / feature | Canonical operation | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/agent-controls/preview` | selection, 1–100 recordIds, block/unblock → exact immutable effects/receipt | API-only generic control | preview_agent_control | A; dynamic provider capability |
| `POST /api/agent-controls/execute` | receiptId/hash, required key → child references/admission | existing child writers | execute_agent_control | A; dynamic provider capability |
| `GET /api/agent-controls/:receiptId` | private receipt → bounded child projection | provider-free receipt status | get_agent_control | A; saved private correlation |

## Administrative audit origin v1

[`AuditOriginV1`](../backend/src/types/audit.ts) carries version, channel,
integration client, client ID/name/version, calling-agent ID/name and API/MCP
request traces. Each attribution field is authenticated, reported or unknown;
unknown values are null, never guessed historical webapp identity.

Channel/integration come from verified API transport/registration, not headers.
The verified downstream OAuth registration ID binds MCP session ownership, not
vendor identity. `Context.client_id` remains reported meta, not authority.
Initialize clientInfo and namespaced call metadata are optional reported labels
from request-local SDK context, not last-caller state. The API still assigns **reported**
to every forwarded descriptor label/ID.

Only the bounded `X-Agent-Control-Mcp-Context` base64url UTF-8 JSON header is
accepted from the authorized integration: version/client/callingAgent/mcpCallId,
not channel/evidence/requestId/integration authority. Labels/IDs ≤256 Unicode
scalars, version ≤64, no control characters; whole descriptor ≤4096 bytes.
MCP call trace is bounded ≤128 `[A-Za-z0-9_.:-]`; API requestId is generated.
Do not retain protocol session IDs, connection handles, prompts, arbitrary meta
or bearer/provider credentials in audit.

Origin is fixed by the first **accepted execution submission**, transactionally
with handoff, not by preview generation or polling. Same idempotency key returns
original origin. Resume/cancel/reconcile append their current request origin as
separate lifecycle evidence while preserving the original initiator.
Append/latest projections, package/stage/quarantine/export/hunting/import stores,
CSV and browser details retain the same contract; no origin warehouse is added.
Exact origin filters participate in both list/count and CSV predicates.

## Advanced service configuration

The [setup wizard](mcp-integration.md#4-configure-and-start-the-server) saves the
API tenant-profile binding
`integration:{clientId:<MCP GUID>,audience:<API GUID>,scope:"AgentControl.Access"}`.
Omission disables bearer admission without affecting the browser. Provider
permissions and database credentials remain on the API, not MCP.

### Settings import

Copy the [server settings example](../mcp/examples/local-settings.example.json)
to a private location and replace its synthetic metadata:

```powershell
./deploy-local.ps1 start -Project YOUR_PROJECT -McpConfig /absolute/private/mcp.json
./deploy-local.ps1 edit-config -Project YOUR_PROJECT -ConfigureMcp -McpConfig /absolute/private/mcp.json
./deploy-local.ps1 start -Project YOUR_PROJECT
./deploy-local.ps1 check -Project YOUR_PROJECT
./deploy-local.ps1 stop -Project YOUR_PROJECT
```

`tenantId`/`apiClientId` select an existing API profile; `clientId` is the MCP
Entra GUID, not a downstream DCR client ID or `*`. Optional import fields
`clientSecretFile`, `signingKeyFile`, `encryptionKeyFile` are absolute paths to
distinct protected regular files, never inline values.

The wizard persists `.local/<project>/secrets/mcp-client`, `mcp-signing` and
`mcp-encryption` as protected 0600 files. Reconfiguration retains existing keys;
Enter retains a saved credential. Missing/corrupt keys are not regenerated,
including when metadata is missing but OAuth state/receipts already exist.
Restore them instead. Omitted paths preserve saved values.

Normal configured startup also automatically creates the independent 32-random-byte
`secrets/mcp-metadata` file, then reuses it on subsequent starts. API and MCP share
only this protected read-only file through the conditional metadata Compose overlay.
An invalid, linked, incorrectly owned or unreadable existing file is never silently
replaced: deployment reports a scoped warning and omits only that optional mount.
Restoring/removing that metadata-only file permits recovery without touching OAuth
keys, sessions, databases or persisted OAuth state.

`-ConfigureMcp` is a setup operation accepted by `start`/`edit-config`, not a
runtime flag or a pinned-release option. Configured MCP starts without it;
projects without MCP do not prompt for credentials. The optional Compose service
has a dedicated OAuth volume, separate from PostgreSQL.
See [local deployment](deployment-setup.md#optional-local-mcp-container).

### Direct Python service

Use Python 3.14 and the locked approved-feed packages. If uv is missing, install
only uv 0.12.17 through
`python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple uv==0.12.17`.
Do not use public/default or extra-index fallbacks or automatic Python downloads.

```sh
cd mcp
UV_PYTHON_DOWNLOADS=never uv sync --frozen \
  --index-url https://packagefeedproxy.microsoft.io/pypi/simple
uv run --frozen --no-sync agent-control-mcp
```

Supply configuration through the operator environment/secret manager; the
service does not load `.env` files. It listens on port 8000, while the configured
external host/resource must remain exact.

| Setting | Contract |
| --- | --- |
| `MCP_TENANT_ID` | Exact configured tenant GUID |
| `MCP_CLIENT_ID` | Separate confidential MCP client/resource GUID |
| `MCP_API_CLIENT_ID` | Existing API GUID, different from MCP |
| `MCP_API_ORIGIN` | One canonical origin without path/query; HTTPS, or supported loopback/single-label private HTTP service origin |
| `MCP_PUBLIC_URL` | Canonical HTTPS resource, e.g. `https://mcp.example.test/mcp`; no query or trailing slash |
| `MCP_ALLOWED_CLIENT_REDIRECT_URIS` | JSON array of 1–32 exact callbacks; HTTPS or HTTP loopback; explicit canonical `/` accepted, no wildcards/query/fragment |
| `MCP_SECRET_SOURCE` | `files` by default, or explicit `app-service-key-vault`; no automatic profile fallback |
| `MCP_CLIENT_SECRET_FILE` | Local mode: owned regular 0600 UTF-8 MCP confidential credential file |
| `MCP_JWT_SIGNING_KEY_FILE` | Local mode: distinct owned regular 0600 file; canonical URL-safe base64 of 32 independent random bytes |
| `MCP_OAUTH_ENCRYPTION_KEY_FILE` | Local mode: distinct owned regular 0600 file; JSON array of 1–3 independent Fernet keys, newest first |
| `MCP_OAUTH_STORAGE_PATH` | Local mode: absolute dedicated owned 0700 persistent directory, e.g. `/var/lib/agent-control-mcp/oauth` |
| `MCP_AZURE_CLIENT_SECRET`, `MCP_AZURE_JWT_SIGNING_KEY`, `MCP_AZURE_OAUTH_ENCRYPTION_KEY` | Azure mode only: resolved native Key Vault values in memory, not simultaneous file inputs or raw CLI values |
| `MCP_AZURE_BLOB_ACCOUNT_URL`, `MCP_AZURE_BLOB_CONTAINER`, `MCP_AZURE_BLOB_NAME` | Azure mode: exact HTTPS Blob account, dedicated private container, prepared `oauth-state.v1.fernet` object |
| `MCP_AZURE_IDENTITY_CLIENT_ID` | Azure mode: exact user-assigned managed identity client GUID |
| `MCP_METADATA_TOKEN_FILE` | Optional local metadata-only owned regular 0600 file; canonical URL-safe base64 of 32 independent random bytes |
| `MCP_AZURE_METADATA_TOKEN` | Optional resolved native Azure reference to the same pinned metadata-only secret on API/MCP; unresolved values are scoped failures |
| API `MCP_METADATA_ORIGIN` | Fixed internal `http://mcp:8000` locally; approved MCP HTTPS origin on Azure, never a request parameter |
| API `MCP_LOCAL_HOST_PORT` | Known deployment host port only; omitted on Azure |

Configured URLs reject query and fragment delimiters even when their values are empty.
Secret files are distinct, non-linked, owned regular files of 1–8192 bytes.
Signing/encryption/confidential values must be independent; direct configuration
does not generate or derive keys. API tenant/session/PostgreSQL secrets stay API-only.

### Azure hosting profile

Use the existing version-2 target's optional `mcp` fragment from
[`infra/mcp-target.example.json`](../infra/mcp-target.example.json), not a second
target format. The supported profile is one separate Linux container App Service
with immutable image digest and one encrypted state Blob. The initial resource
is `https://<mcp-site>.azurewebsites.net/mcp`; custom domains/front doors/extra
proxies are not implemented by this profile.

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -Component Mcp -TargetFile <target.json>
pwsh ./deploy-azure.ps1 -Action Deploy -Component Mcp -TargetFile <target.json>
pwsh ./deploy-azure.ps1 -Action Stop -Component Mcp -TargetFile <target.json>
```

The same API tenant/client/origin and API integration binding must be configured.
MCP-only operations do not read API secrets. API/web lifecycle is independent;
an MCP failure is not an API rollback/reset request.

Prepared resources and permissions:

- Use the exact same-tenant/subscription UAMI, registry RBAC `AcrPull` on the
  exact registry, disabled ACR admin credentials, and `Key Vault Secrets User`
  on only `agent-control-mcp-client`, `agent-control-mcp-signing`,
  `agent-control-mcp-encryption`, plus optional `agent-control-mcp-metadata`.
  The prepared metadata value canonically encodes 32 independent random bytes.
  Pin its same immutable version in both API and MCP native references. The API
  identity can read only this MCP metadata secret, never the three OAuth secrets.
  No secret values are generated or written by Azure deployment. Broad/inherited/custom or
  group-derived grants, including access to API/session/database secrets, are
  rejected. Operators need effective role-assignment visibility; failed
  enumeration is not evidence that access is narrow.
- Prepare a same-region `StorageV2` Standard_LRS/ZRS account, HTTPS-only/TLS 1.2,
  shared-key authorization and public Blob/network access disabled. The dedicated
  container has `publicAccess=None`. Its exact prepared Block Blob is
  `oauth-state.v1.fernet`; the runtime never creates the container/object.
- Grant `Storage Blob Data Contributor` on only that container resource ID,
  conditionVersion `2.0`, with the exact object condition:

  ```text
  @Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals 'oauth-state.v1.fernet'
  ```

  No unconditioned/account/subscription/other-object grant is accepted. Runtime
  uses `ManagedIdentityCredential(client_id=<exact UAMI>)`, not default/user/
  environment credentials, SAS or storage keys.
- Prepare the approved Blob private endpoint, its `default` private DNS zone
  group for `privatelink.blob.core.windows.net`, and completed non-registering
  VNet link. Use the Web/serverFarms-delegated integration subnet and
  `vnetRouteAllEnabled=true`. Record effective DNS/HTTPS443 and bounded
  Entra/API/Key Vault/ACR egress in the target's prepared/reachability references.
  Do not open public storage or weaken TLS to repair DNS.

The data Blob is also the lease object: acquire once for 15 seconds, renew every
four seconds during service lifespan, verify ownership at read/auth boundaries,
and condition every mutation on that lease plus ETag. SDK I/O is bounded to five
seconds with retries disabled; the local ownership deadline is ten seconds from
dispatch. Lost/unknown ownership or an ambiguous write permanently halts this
process's issuance/readiness with a safe 503. Stop and reconcile; no stale-cache
success, automatic reacquisition or write replay is supported. After a crash,
wait for finite lease expiry; never break an active holder to force replacement.

The encrypted map binds tenant/MCP/API/resource and exact object, with the
[storage limits](#storage-rotation-and-recovery) below. Mutations/readiness cull
expired records. Encrypted bytes stay below 64 MiB in one bounded Put Blob,
without unfenced block staging.
See [Azure lifecycle](azure-production-deployment.md#optional-independent-mcp-app-service)
and [disaster recovery](../infra/disaster-recovery.md#independent-azure-mcp-recovery).
ARM checks do not prove effective private DNS, traffic or provider connectivity.

## Storage, rotation and recovery

OAuth storage is separate from application SQL. Local FileTree lookup names are
hashed; all OAuth records use maintained Fernet encryption and reject plaintext.
Storage binds tenant/MCP/API/resource and validates ownership/modes.

| Requirement | Current contract |
| --- | --- |
| Process ownership | One service worker; owned non-linked local directories 0700 and regular files 0600 |
| Capacity | 4096 files/records, 256 KiB plaintext per record, 64 MiB aggregate; Azure additionally bounds its plaintext map below 48 MiB |
| Persisted lifetime | Every OAuth entry, including DCR metadata, has a maximum 24-hour TTL; expired state is culled |
| Reference access | 900 seconds; refresh-expiry fallback 86400 seconds, never extending shorter known expiry |
| Independent keys | Confidential credential, signing key and storage-encryption material are distinct |
| Encryption ring | At most three independent keys, new key first; keep prior keys through their records' maximum 24-hour TTL, cull expired records and rewrite retained records before removal |
| Signing rotation | Old reference tokens fail; clients reconnect, while encrypted state/keys remain intact |
| Disconnect | Revoke both held access and refresh credentials at `/revoke`; exact-token revocation is not API account-wide logout |

Readiness checks storage/binding, not provider permission or database readiness.
Overlapping local readiness checks use independent encrypted probes; storage scans
tolerate files disappearing during atomic writes or expiry culling, while still
rejecting missing roots, insecure permissions and symbolic links.
Public `/health` is process health; `/ready` returns 503 on storage failure;
authenticated `/diagnostics` reports non-secret protocol/build/storage usage
and downstream OAuth client ID, not user names/tokens/provider/SQL details.

### Local backup and restore

Stop the exact project for a coherent backup. Protect the whole
`<project>_mcp-oauth` volume, original three `secrets/mcp-*` files, `settings.json`,
`compose.env`, `mcp-storage.json` and MCP receipts. Protect keys separately from
encrypted state; never put them in images/source/test reports.
Restore only the same tenant/client/API/resource, UID/GID and 0700/0600 permissions.
Missing or undecryptable state is not permission to start empty or regenerate keys.

If an authorized disaster restore recreates the volume, first verify the complete
encrypted inventory/digests, original binding and keys. Preserve the old
`mcp-storage.json` outside its active filename as recovery evidence; normal
`start` can then validate and record the restored volume's changed creation
identity. This is an explicit restoration action, not automatic missing-volume
recovery. Retain the original receipt and backup evidence.

### Key and connection recovery

- **Encryption:** import a protected ring with the new independent key first,
  retaining old keys, then normal start. Honor the TTL/culling rule above;
  no bulk plaintext/reset path is supported.
- **Signing:** rotate only the signing key and start; old reference tokens fail
  and clients reconnect. Preserve encryption keys/state.
- **Confidential credential:** replace only the MCP confidential credential,
  not API credentials or internal keys.
- **Revocation:** exact-token tombstones remain encrypted and survive restart;
  revoke access and refresh separately when disconnecting. Reconnect does not
  revive revoked credentials or perform API account logout.
- **API restart:** credentials stay volatile. Read saved jobs, reacquire fresh
  same-account authority and explicitly resume only eligible unsent work.
  Sent-unknown writes require read-only reconciliation.

Azure recovery preserves the exact encrypted Blob/binding and secret versions,
reconciles lease/ETag ownership, and waits for lease expiry before replacement.
Never break a live lease, replay an ambiguous write, broaden grants or silently
fall back to files. Use the [independent recovery owner](../infra/disaster-recovery.md#independent-azure-mcp-recovery).
MCP loss/removal does not authorize resetting API/PostgreSQL data.

## Browser contract checks

The web application uses canonical API methods/paths, not MCP or direct provider
transport. This is the maintainer regression checklist, not a release/runtime gate:

| Page / boundary | Contract to preserve | Focused owners |
| --- | --- | --- |
| Setup/sign-in/session | Existing callback, Origin/CSRF, eight-hour ceiling, logout/revocation; saved reads after restart do not fabricate provider authority | authHttp, mcpApiAuth, App.signIn/session, signIn.spec.ts |
| `permissions` | Roles versus provider consent, current capability checks, tenant saved reads during provider outage; no new consent/hunt prerequisite | capabilities, PermissionCenter, permissions.spec.ts |
| `mcp-settings` | Exact registered runtime strings/schemas, tenant binding, Viewer hierarchy, bounded independent metadata access and explicit outages; no execution/editing | test_settings_metadata, mcpSettings route/service, McpSettings, mcpSettings.spec.ts |
| `agents` | Full selected paging/facets/About/configuration, unknown evidence, exact previews/confirmation, package versus quarantine effects | mcpReadContracts, inventory/agent-controls suites, agentExperience/packageConfirmation |
| `users` | Paid/unpaid/unknown licenses, exact identity/relationships, API-ranked champions, report windows and personal set isolation | mcpReadContracts, adoptionGroups, savedReadContracts, userDetails/adoption |
| `sync` | Automatic first-run/due admission, actual source outcomes, report-preserving refresh, CSV acceptance and confirmed deletion, authorization-wait/export recovery | automaticRefreshIntegration, dataSyncPersistence, dataSync/savedReadLifecycle |
| `audit` | Admin-only UI/API, immutable initiator, reported/unknown labels and exact filters/CSV | auditOriginHttp, AuditLogView, auditOrigin.spec.ts |
| API-only operations | Generic control receipts and child outcomes remain API-only; optional canaries do not gate ordinary controls | sharedAgentControls, policy, packageCanaryAuthorization |

## Verification

Metadata transport and request-lifecycle checks can run without sockets or services.
The native HTTP(S) transport is mocked with in-memory streams; both typechecks
cover the shared reader contract under Node and browser DOM declarations.

```sh
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
npm run test --workspace backend -- src/services/mcpSettings.unit.test.ts src/routes/mcpSettings.unit.test.ts
npm run test --workspace frontend -- src/components/McpSettings.test.tsx
```

Run focused local contracts with the existing dependencies:

```sh
npm run test --workspace backend -- src/routes/mcpContractFeasibility.test.ts src/routes/mcpApiAuth.test.ts
cd mcp
.venv/bin/pytest tests/test_client_examples.py tests/test_onboarding.py tests/test_api_origin.py tests/test_workflows.py
```

Python tests use the pinned SDK and synthetic Entra/JWKS/API transports; DTO
fixtures use existing Node/TypeScript dependencies. They do not prove vendor-client
interoperability, consent/provider access or whole-tenant performance.
Keep the shared synthetic corpus in
[`mcp-workflows.json`](../backend/scripts/fixtures/mcp-workflows.json), not user instructions.

For isolated database/browser/image checks, use the [validation owners](operations.md#validation).
Live checks must cover native/guest home identity, consent, client discovery/
callback/resource/S256/refresh/revocation, UI confirmation, provider effects and
Azure networking/identity/storage recovery. Local tests/health endpoints do not
prove these outcomes or gate normal configured use.

## Protocol references

- MCP [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
  and [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- Pinned FastMCP [AzureProvider](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/auth/providers/azure.py),
  [OAuthProxy](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/auth/oauth_proxy/proxy.py)
  and [dependencies](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/dependencies.py).
- Entra [OBO flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow).
- Azure [Blob leases](https://learn.microsoft.com/rest/api/storageservices/lease-blob)
  and [ABAC conditions](https://learn.microsoft.com/azure/storage/blobs/storage-auth-abac-examples).
