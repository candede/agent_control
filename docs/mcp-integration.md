# MCP integration v1: canonical API contract

The canonical API, browser and worker contracts are implemented in current
source. The optional Python FastMCP service provides authentication/storage/API
adapters and typed saved-read, collection, investigation and exact control tools.
It is not required for the web application. Local implementation/tests do not
prove a live deployment, Entra consent or provider result.
Update this operation/feature map when current contracts change.

The [phase11 release record](../plans/fastmcp-integration/completions/11-release-qualification.md)
separates current local SDK/canonical-HTTP/SQL, compiled-browser, production-image
and real Azurite evidence. It does not establish real client, Entra/provider or
App Service compatibility. Reproduce it through the
[existing guarded owners](operations.md#current-release-qualification-for-deployment-testing),
not an approval file or a second API/domain implementation.

## Authority and activation

Browser -> session -> canonical API -> saved SQL / explicit Microsoft work ->
existing jobs/audit -> browser remains supported. The implemented MCP path is: signed-in external
client -> FastMCP OAuth -> delegated API token -> **the same method/route** ->
the same API authority -> typed bounded result -> client reasoning. Web never
calls MCP. API owns queries, joins, metrics, controls, workers and audit.
Client owns schedules, LLM interpretation and interactive confirmation. Neither
service adds a scheduler, classifier, approval engine, identity registry, generic
HTTP/SQL/KQL proxy, second provider writer or application-identity fallback.

Current route policies share verified principal authority with service/worker
consumers atomically. Cookie requests keep Origin/CSRF. Bearer admission is
disabled when tenant integration configuration is absent or identity proof
fails. Cookie plus bearer is an explicit 400 `ambiguous_authentication`,
never precedence/fallback. Invalid bearer on a shared route is 401; bearer on a
browser-only route is rejected, never a global CSRF/Origin bypass.

The API/web release is independent of MCP. Normal installation, completed reset
and sign-in need no release-acceptance file, provider-enable action or read
qualification. Live resource/grant changes and provider writes retain their
actual operator authority; reset needs exact target/data-loss confirmation.
See [release instructions](../plans/fastmcp-integration/04C-api-webapp-production-release.md).

## Source/schema/private identity baseline

[Current DDL](../backend/src/db/currentSchema.ts) and the
[strict verifier](../backend/src/db/schema.ts) define one supported schema.
Its fingerprint hashes compiled SQL, not the TypeScript file. Startup/readiness
verify the marker, structure and runtime grants. Initialization accepts empty/
current only; incompatible input fails before drain without conversion/deletion.
An explicitly confirmed `-DbReset` deletes application data while retaining the
PostgreSQL container/volume, configuration, secrets and backups. Official CSV
history requires reimport; provider sync cannot recreate it. Successful
installation/reset/restore returns to normal authenticated operation.

Current DDL includes non-secret
`data_principal_epochs.bearer_issued_after bigint NOT NULL DEFAULT 0`.
Epoch alone cannot distinguish a newly issued assertion from stale replay after
restart. The existing epoch writer atomically increments epoch and advances this
monotonic millisecond cutoff using the later application/database clock; restore
reconciliation does the same. Verified JWT `iat*1000` must be **strictly later**.
An assertion in the revocation second is conservatively rejected: obtain a token
issued in a later second, not just a different token with the same `iat`.
Fresh native/guest authority may reopen only its proven private principal,
without browser login/cache. Recovery is serialized with existing account
mutations and never advances a generation merely for another valid grant.
Old sources/validations keep their exact captured generation and epoch; a fresh
request cannot lend authority to an old worker or silently rebind its intent.

The DDL includes issuance cutoffs, origin and exact control receipts directly.
The [database operator](../backend/scripts/database.ts)
owns current/empty preflight, initialization/grants and actual maintenance.
The [reset guard](../backend/scripts/databaseReset.ts)
requires the exact operator-owned target on the `postgres` maintenance database.
The [backup owner](../backend/scripts/backup.ts) supports current-schema backups
and isolated restore with revocation/current-cache fencing. Incompatible dumps
are not supported restore inputs. See [operations](operations.md).

Private delegated key is `(tenantId, MSAL account.homeAccountId)`, retained as
`session.accountId`, `user.homeAccountId` and SQL `principal_id`.
`requestScope`, `reportIdentity`, `data_principal_epochs`,
selections/cursors, private caches, job/refresh/sync actors,
capability evidence, quarantine and audit use this key. Sessions' generated
`principal_id` reads `sess->>'accountId'`. Tenant official report history and
reviewed usage associations are tenant-wide. Directory/licensing/activity,
Graph packages, Power Platform, canonical inventory and saved people joins also
have one tenant owner (`scope_kind=tenant`, `principal_id=NULL`, `token_mode=tenant`).
Viewer, UsageReportUploader and Admin roles read that saved data without provider source-read permission.
Provider refreshes still use the initiating actor's current authorization and
credentials; application-mode packages publish to the same tenant root.
Collector/session fencing and private execution receipts remain actor-bound.
Never use another user's delegated token. Selection and cursor handles cannot
be transferred between actors, roles or tenants.
Power Platform environment/type filters describe the actual provider query,
not separate saved-data owners. Successful narrower queries update the same
tenant source and preserve unseen agents, environments and original observations.

### Supported mapping, and its evidence limit

MSAL 5.3.1 derives `homeAccountId` from token-endpoint **`client_info.uid.utid`**;
without that information it falls back to ID-token `sub`, not `oid.tid`.
Guest `oid` is the resource-tenant object, while home `uid/utid` can belong to
another tenant. `sub` can be application-specific. Email, UPN, names, `idp`,
`oid.tid`, or a caller-supplied home key cannot recover this contract.

The supported mapping candidate is the API's own tenant-bound
`ConfidentialClientApplication.acquireTokenOnBehalfOf` result, obtained from
Entra using the validated API assertion, with `client_info` requested by MSAL.
Use the returned `account.homeAccountId` **only with a present SDK account and
valid client-info-backed home identity**, matching resource tenant and local
`oid`, expected API client binding in identity metadata, and same verified user.
Reject absent account/client info, sub-only fallback, changed local/home identity
or contradictory tenant/audience. Never accept the MCP's unsigned mapping
header or create a fabricated browser session.

02 must retain ephemeral identity evidence from this exchange, not raw response
claims in PostgreSQL. The bounded bootstrap exchange requests only `openid`
and `profile` for OIDC identity metadata;
it makes **no Graph data request** and requires no directory-read grant. This adds no Graph grant to ordinary browser
saved reads. For a bearer user without sufficient verified exchange evidence,
saved bearer admission stays closed; never impose provider work on ordinary
saved-data GET handlers. Once mapped, saved reads use only verified principal
and SQL. Provider token acquisition happens only for explicit provider work.

The checked-in fixture executes the **real installed MSAL SDK** with synthetic
native/guest code/OBO endpoint responses and distinct resource/home IDs. It
proves SDK interpretation and demonstrates why `oid.tid` is wrong; it does not
prove that a live Entra OBO response contains matching client info/account for
these registrations. 02/03 must fail closed on unsupported response shapes;
Live native/guest identity continuity must be observed separately from fixtures.
Requests require supported identity proof, not a prequalification record or
prior portal login; the existing private key is unchanged.

## Registrations, token audiences and consent

Primary evidence is dated below. Implemented pin: FastMCP **4.1.0**, release
2026-10-08, tag commit `51b618f7d5970d2870dc351081e16600f371291f`.
`mcp/pyproject.toml` and `mcp/uv.lock` pin the actual approved-feed distribution
and transitive dependencies; recheck this contract on drift.

1. Existing API registration remains browser confidential/OIDC client, owns
   Viewer, UsageReportUploader and Admin user roles, the four standard Graph
   application read grants, and delegated Power Platform/management permissions.
   Expose one delegated scope `api://<apiClientId>/AgentControl.Access`;
   configure v2 access tokens and required user identity/role claims. Assign
   the users on this API enterprise application; MCP login roles do not confer
   API roles. Preserve all existing tenants.
2. Separate tenant-specific MCP registration is a confidential OAuth client and
   resource with `api://<mcpClientId>/Mcp.Access`. Exact tenant GUID authority
   `https://login.microsoftonline.com/<tenantId>` only. Request its own resource
   scope, OIDC scopes and offline access through AzureProvider, with v2 access
   tokens. Register exact approved MCP `/auth/callback`; browser's
   `/api/auth/callback` remains separate. No `common`, `organizations`, wildcard
   redirects, unbounded client redirect defaults or Entra custom-signing-key mode.
3. MCP registration receives admin-managed delegated API `AgentControl.Access`.
   API registration receives existing capability-specific delegated Graph and
   Power Platform grants. Consent is managed out of band by the tenant admin;
   no runtime consent writer, personal API key or app-only customer identity.
4. AzureProvider validates upstream Entra MCP-audience access tokens against
   tenant issuer/JWKS, MCP client audience and `Mcp.Access`. FastMCP issues its
   own reference JWT with the MCP HTTPS resource audience to downstream clients.
   **That JWT is not an OBO assertion.** In 4.1.0,
   `fastmcp.server.dependencies.get_access_token().token` after OAuthProxy's
   verified token swap is the upstream Entra access token. Missing context,
   alternate identity-assertion grants, wrong audience or ID-token mode fail
   closed; do not read private `_upstream_token_store` or pass client JWTs to API.
   The local `TenantAzureProvider` narrows the verified
   upstream claims to an exact v2 GUID audience, tenant, delegated scope, user,
   integration `azp` and finite issuance/expiry. ID tokens and app credentials
   are rejected. The signed reference's original user must match after refresh.
5. MCP exchanges that assertion at the fixed tenant endpoint, using **MCP**
   confidential credentials and API delegated scope (`requested_token_use=
   on_behalf_of`). API accepts only its own exact v2 audience, verified tenant,
   `scp=AgentControl.Access`, recognized roles, user `oid`, bounded `exp/nbf`,
   and configured authorized `azp=<mcpClientId>`. Check signature and issuer,
   not payload decoding alone. Reject app tokens, ID tokens and other audiences.
6. API obtains provider tokens via its **own** MSAL OBO credentials and exact
   capability scopes from the verified API assertion. Graph audience is
   `https://graph.microsoft.com` / `00000003-0000-0000-c000-000000000000`;
   Power Platform is `https://api.powerplatform.com` /
   `8578e004-a5c6-46e7-913e-12f58912df43`. Provider tokens are opaque to clients:
   SDK tenant/account/scopes/expiry are authoritative, exposed claims can reject
   contradictions. MCP has no provider clients or database credentials.

No multi-resource scope mixture, ID-token assertion, token passthrough or
audience widening. AzureProvider prefixes bare `required_scopes`; use
`required_scopes=["Mcp.Access"]`, its own identifier URI and no Graph additional
scope. Set `forward_resource=false` for Entra's scope-based upstream request;
the downstream FastMCP resource binding still applies. Clients must supply
resource indicators to FastMCP and authorization on every HTTP request.

The actual SDK defaults are not the application security policy:
`AzureProvider.authorize` clears the resource before the parent checks it,
default JWT audience validation also accepts `api://` and audience arrays,
default revocation leaves access mappings alive, and the SDK encryption wrapper
accepts plaintext input. Public-method/ASGI boundary guards enforce exact
resource indicators on authorize **and** token requests, S256, exact redirects,
strict verified claims and durable encrypted exact-token revocation. A public
storage wrapper rejects plaintext before SDK decryption. No private token store
is read and no application cryptography is implemented. The maintained file
store's public sanitization hook hashes lookup filenames; SDK authentication
logs retain only safe event metadata, not rejected OAuth codes. Single-process
code-consumption serialization and post-await revocation checks prevent
concurrent code reuse or renewal after an in-flight disconnect.

API app roles are revalidated at most five minutes after the last verified
authority. An immutable bearer token cannot be called refreshed evidence; expiry
or stale role evidence requires a fresh API assertion with newer issuance/
verified exchange evidence. Do not accept Graph roles as Agent Control roles.
Allowlisted `wids`/provider-role hints remain diagnostic only; actual delegated
grant, Microsoft provider RBAC/license and prestate/readback decide operation
authority. External revocation is bounded by token expiry, reauthorization,
provider denial/Conditional Access and claims challenges, not an instantaneous
signal. Internal account/session, capability and data epochs remain immediate
fences, including inside pre-COMMIT publication and after awaited work.

An OBO claims challenge is returned as bounded reauthorization information over
the approved auth error channel; never raw provider bodies, tokens or silently
retried writes. Current API tests cover SDK handling; future MCP tests cover each
client's interactive recovery. Passwords, secrets and consent are not entered
in tools/chat. Scheduled clients must handle reauthorization explicitly.

Existing browser sessions expire after eight hours and MSAL cache is process-local.
API assertions/provider tokens never outlive their verified issuer/SDK expiry;
worker leases end at the earlier assertion/provider deadline and authorization
fence. The service sets FastMCP reference access lifetime900s, refresh-expiry fallback86400s
(never overriding a shorter known expiry), and renewal threshold60s. An expired
or revoked upstream connection cannot be renewed with a locally signed JWT.
These are explicit SDK constructor limits, not additional configuration names.
Role freshness may require a new API token before its nominal expiry; MCP forces
an OBO exchange rather than relabeling an old `iat` as refreshed evidence.
An Entra denial/challenge pauses authority and never retries a provider write.

### Implemented local service foundation (phase 05)

`mcp/src/agent_control_mcp` is an installable Python 3.14 package. It uses
FastMCP4.1.0, MCP SDK2.3.0, the maintained JWT verifier, HTTPX2, and
`py-key-value-aio` **0.4.6** FileTreeStore/Fernet wrapper with
cryptography48.0.1 (the exact versions/hashes are in `uv.lock`).
There is one tenant, one configured API origin and one confidential MCP client.
Discovery/OAuth endpoints are rooted at the configured public origin; the
Streamable HTTP resource is the exact `MCP_PUBLIC_URL` path. No caller can choose
a tenant, upstream endpoint or resource origin. CIMD/alternate assertion grants
are disabled; DCR accepts only exact configured client redirects. The SDK's
interactive OAuth consent/CSRF binding is retained; it is not an application
release/business-approval gate.

Every HTTP request authenticates independently, including an existing protocol
session. The service recovers the upstream JWT using public `get_access_token()`
and obtains an API token at the exact tenant endpoint with fixed MCP confidential
credentials, `requested_token_use=on_behalf_of` and only
`api://<apiClientId>/AgentControl.Access`. SDK signature verification plus exact
claims checks reject another user/audience, app/ID tokens and role evidence
older than five minutes. No API assertion or provider token is persisted.

The shared `CanonicalApi.invocation(ctx)` owns one60s deadline, four concurrent
requests, eight physical requests, two OBO exchanges and524288 aggregate output
bytes. Requests are <=30s; exchanges are <=10s. Only a safe GET can retry once
on429/503 with a bounded honored `Retry-After`; otherwise cooldown is returned.
API requests require identity encoding; unsolicited compressed bodies fail
before decoding rather than bypassing the byte bound. Refresh/OBO upstream503
and transport deadlines remain safe503/504 errors rather than forcing an
invalid-grant reset. OAuth endpoints have a30s handling deadline; callback
errors are normalized/non-cacheable and never forward provider diagnostic text.
Cancellation propagates, and expiry/revocation is checked after awaited work.
Invocation lifetime and upstream claims are checked both before and after each
awaited revocation lookup, before API dispatch or response release.
No cookies, redirects, proxy environment or caller-supplied URL/auth headers
enter API dispatch. The adapter's named calls use the finite catalog in
`mcp/src/agent_control_mcp/tools.py`; caller-selected endpoints/methods are
unreachable, not hidden tools. The catalog follows the canonical map below;
there is no second API authorization-policy map or domain query implementation.
Successful API request UUIDs are retained in the invocation; bounded errors
preserve status/code/correlation/cooldown and sanitized details, not raw
provider responses. Credential-bearing detail keys are omitted with their values,
including in nested objects. The 524288-byte ceiling includes final SDK error envelopes,
not only successful text/structured results. An oversized error becomes an explicit
413 `output_limit`, retaining correlation and cooldown but omitting oversized details.
POST/PATCH/DELETE submissions are never automatically replayed,
and MCP introduces no provider writer.
OBO claims challenges use the same bounded `access_token` claim-name, field and
value allowlist as the API; ID-token requests and arbitrary nested diagnostics
are never forwarded as reauthorization data.

Public `/health` reports process health. `/ready` verifies protected encrypted
storage and its tenant/client/API/resource binding, not provider permission or
database readiness. Expected storage failures return503 and emit a safe operator
error without secret-bearing exception text; unexpected defects are not hidden
by a catch-all. `/diagnostics` requires a fresh verified MCP credential
and returns non-secret protocol/build/storage metadata plus the authenticated
downstream OAuth client ID. It does not expose tokens, connection handles,
session IDs, user names or provider/SQL details. It reports the actual registered
business-tool count and bounded OAuth file/byte usage, not inferred readiness
or provider permission. Storage inspection failures return a redacted503.
See [setup](deployment-setup.md#optional-mcp-service) and
[storage lifecycle](security-model.md#fastmcp-oauth-state-and-recovery).

### Implemented typed business catalog (phase 06)

Ordinary configured service construction registers **124 named tools**, with no
extra enable flag or approval ceremony. Each tool takes one concrete `request`
object and publishes an explicit nested output schema. Empty-input tools use
`{"request": {}}`. `tools.py` owns names/methods/routes/input/output bindings;
`inputs.py`, `control_inputs.py` and the inventory/report/job/control DTO modules
carry the wire contracts. Phase06's96 operations are retained; phase07 adds28
control operations and reuses the existing two directory-principal adapters.
The real SDK `tools/list` and authenticated `tools/call` are tested against
synthetic Entra/JWKS/API transports and current TypeScript source-derived
fixtures, including optional nested evidence. This is local source evidence,
not live SQL, Entra consent, provider or external-client qualification.
Cancellation coverage waits for the mocked API request to start, including after
a delayed token exchange, and collects the pending SDK task on failure as well as
success.

Usage association targets preserve the API's source-specific identity contract:
`graph_packages` requires `packageId` and `snapshotId`; `power_platform` requires
`nativeId`, explicit nullable `environmentId`, and `snapshotId`. Missing required
fields or fields from the other source produce `invalid_api_response`, not a
successful association with incomplete identity.

The catalog covers saved capabilities/workspace jobs; inventory selections,
facets, detail, members, sections, children and About; exact saved users,
licensing, responsibility and relationships; adoption/champions; official
reports, history, analytics, usage and explicit comparisons; saved
investigations/audit; and explicit application Graph collection, delegated Power Platform collection, directory enrichment,
identity resolution, capability checks, Audit Search/hunts and their bounded
job/results/recovery operations, plus the exact controls below.
Local Purview/Defender cache deletion requires confirmation of the exact job ID
and is marked destructive. No CSV import, capability configuration, binary
download, automatic browser
refresh, arbitrary HTTP/SQL/KQL or application-identity fallback is registered.
Browser application-mode investigation behavior is unchanged. MCP investigation
submissions remain delegated-only. Standard Graph collection uses the configured
tenant application, with the authenticated initiating user's current app-role and
session authority; package refresh inputs accept only `application`.

### Implemented exact controls (phase 07)

The normal catalog includes the three generic control tools and all supported
package/Studio control preview, execution, saved job/status/item, cancel,
explicit resume, GET-only provider reconciliation and audit adapters in the
canonical map below. Existing `search_access_principals` and
`resolve_access_principals` serve access editing; search is bounded and is not
exhaustive discovery. No canary, release receipt, enable switch or MCP approval
state gates ordinary supported controls.

For the signed-in package operator, recommend **AI Administrator**;
**Global Administrator** is a broader alternative. This follows Microsoft's
Microsoft 365 admin-center role guidance, not a confirmed exclusive API role
minimum. See the [role recommendation and its scope](user-roles-and-permissions.md#package-management-administrator-roles).

Controls require current API-owned **Admin** authority and the actual delegated
provider permission: Graph `CopilotPackages.ReadWrite.All` or Power Platform
`CopilotStudio.AdminActions.Invoke`. Saved package/Studio job reads retain their
Viewer policy; private generic receipt reads require Admin. Python forwards exact
canonical, selection, native, source/environment and opaque package identities,
not names or inferred associations. Generic Studio block/unblock means
quarantine/unquarantine; explicit package-only controls stay package-only even
for a Studio-linked package. Access uses exact typed directory UUIDs,
availability/installation, add/replace and specific/none; single-package access
uses the canonical **PATCH** and replace only. All-users writes remain
unsupported by the provider, not enabled through MCP.

Every submission requires a caller-retained stable `idempotencyKey`, forwarded
only as `Idempotency-Key`, plus the exact current confirmation hash/receipt.
Generic receipt keys are printable ASCII within the API's200-character
non-whitespace bound (no unsupported Unicode HTTP-header encoding);
package/Studio submissions use1–128 ASCII alphanumeric/underscore/hyphen keys.
The SDK's readOnly/destructive/idempotent/openWorld annotations distinguish saved
reads, live provider work, potentially disruptive changes and exact-key
idempotent submissions. An idempotent annotation is **not** permission to retry
a mutation automatically: POST/PATCH are single-attempt, including503, timeout
or response loss. A sent-unknown effect is inspected through existing saved
job/item routes and explicit read-only reconciliation, never replayed by MCP.
There is no Python scheduler, polling loop, receipt store, child-job writer,
provider client or domain outcome projection.

Clients must display the exact preview, including names/IDs, provider effects,
prestates, counts, already-state/ineligible reasons and expiry where returned.
Package previews disclose at most20 targets plus `additionalTargetCount`;
do not claim that bounded summary enumerates omitted targets. Generic receipts
expire at the earlier current-source expiry and ten minutes; package stages
are at most ten minutes, and Studio validity stays provider/source-owned.
Never extend validity, recapture/substitute targets after an error or convert
unknown identity/date/readback into an empty or successful result.
Interactive clients ask for **current confirmation after that preview**.
Externally scheduled clients obtain the same current receipt without a human
pause. MCP cannot prove human intent and accepts no fabricated human-confirmed,
scheduled bypass or client-confirmation-proof field. The existing resume
`confirmed:true` is only the canonical unsent-work contract.

API acceptance fixes the initiator/origin once. Every later request forwards
its own SDK request-local origin automatically for lifecycle attribution,
without replacing that accepted initiator. Accepted, final, verified,
authorization-wait, partial children, not-applied/conflict and unknown readback
remain separate nested API evidence. Mixed providers are never atomic.
Job pages retain exact revision/cursors; no implicit all-pages discovery,
status polling, replay or restart authorization is added. API owns provider
effects, authority, jobs, audit and the existing browser-only CSV export.
Synthetic SDK/browser capture tests verify identical canonical methods, bodies,
defaults, errors and returned audit/outcome DTOs; they are not live provider,
database durability or human-confirmation proof.

Unspecified API defaults stay unspecified. Defender hunt submissions include the
API-required `agentIds`, `blueprintIds`, `actorObjectIds` and `operations` arrays,
using empty arrays when omitted; optional Entra identity namespaces remain omitted.
Null facet values, including inventory `environmentId`, are encoded distinctly
from literal `"~null"` strings; native-activity environment identities remain
untagged. Unrelated optional inputs must be omitted rather than null.
Source-qualified record references allow up to10000 encoded characters while each
decoded source identity remains bounded to512 UTF-16 code units. Investigation
references retain their separate2048-character API bound.
Source/report/package identities retain exact case;
directory/selection/job UUIDs normalize to lowercase. API errors retain safe
status/code, correlation, cooldown and structured details. Unknown/partial/
missing states and incomparable report windows never become successful empty
arrays, zeros or inferred authority. API joins, rankings and calculations
remain authoritative.

Every result is one bounded page. Continue only the returned cursor with the
same selection/source/revision; expired or cross-principal cursors fail without
recapture. `read_agent_about` returns up to16384 Unicode characters per explicit
call; repeat the exact field/source until `nextCursor` is null to obtain all
available saved text. No truncation, fallback or hidden loop occurs. The524288
output-byte ceiling includes the final SDK text/structured result envelope;
oversized results fail explicitly rather than being shortened. Returned source
text is untrusted inert data. GET saved reads are annotated read-only; selection
captures, live lookups and collection/investigation submissions are not.
Authenticated attribution is forwarded automatically by the existing
request-local invocation owner, never accepted as caller-selected authority.

### Principal authority and worker propagation

The single non-secret `RequestPrincipal` interface in
`backend/src/types/requestPrincipal.ts` (object and role arrays are immutable):

```ts
type RequestPrincipal = {
  tenantId: string; principalId: string; apiClientId: string;
  localAccountId: string; username: string; displayName: string;
  roles: readonly AppRole[]; providerRoleIds: readonly string[];
  transport: "browser" | "bearer";
  integrationClientId: string; // verified API client (web) or azp (MCP)
  rolesValidatedAt: number; authenticatedAt: number; expiresAt: number;
  sessionEpoch: string; authorizationHash: string;
};
```

Existing private principal spelling stays unchanged. Millisecond timestamps are
finite and never later than their validation clock; bearer JWT times convert
from seconds. Credentials are a separate **ephemeral** context, not principal
properties: exact tenant/principal/source binding, `assertCurrent()`,
`revalidate(signal): Promise<RequestPrincipal>`,
`acquire(capabilityId, signal): Promise<opaque token>`, and expiration/
revocation. Browser implementation uses existing MSAL account cache; bearer
implementation uses only its own verified assertion and OBO. Worker handoff
retains this bounded context in memory with durable non-secret owner/epoch
references. Restart has no assertion and pauses for same-principal
reauthorization. Connection disconnect removes MCP OAuth authority; account-wide
logout/revocation retains existing epochs and pauses all delegated work.
Another user's or expired connection's grant cannot resume a job.

#### Current principal and credential foundation

- `McpBearerVerifier.verify(assertion, signal)` uses the maintained
  `jsonwebtoken` **9.0.3** verifier already installed through MSAL, now declared
  directly. It accepts RS256 only, exact configured v2 issuer/tenant, a single
  API-client GUID audience, exact integration `azp`, delegated
  `AgentControl.Access`, a GUID `oid`, bounded `sub`, recognized nonempty API
  roles and optional well-formed `wids`. Required positive integer `iat/nbf/exp`
  have zero clock tolerance and a maximum 24-hour lifetime. Tokens older than
  five minutes require a **new API assertion**, not a refreshed local timestamp.
  Missing claims, ID-token nonce, app-only/v1 tokens, alternate audiences,
  unknown tenants, unsigned/symmetric/forged signatures and supplied key URLs
  fail closed. The assertion lives in a private WeakMap, never the identity DTO.
- JWKS is fetched only from the exact tenant's Microsoft v2 key endpoint,
  without redirects. Keys are RSA signature keys (2048–8192 bits), unique by
  bounded `kid`, with optional issuer binding checked. The body is at most
  256 KiB/32 keys. Cache lifetime is five minutes; unknown-key refreshes have
  a 30-second cooldown. Expired keys are never an outage fallback. Fetch,
  body consumption and coalesced waiter cancellation share a ten-second deadline.
- `createBearerCredentials` runs the actual supported MSAL OBO method with
  `skipCache:true` in an isolated ephemeral SDK client, API application
  credentials and fixed tenant endpoints. The supported `INetworkModule`
  captures **that response's** `client_info`; it does not inspect SDK-private
  cache entities. The SDK's sole `client-request-id` query is allowed; no
  alternate endpoint, discovery, redirect or browser cache supplies identity.
  Bootstrap requests only the existing `openid` and `profile` scopes for
  identity metadata, without a Graph directory-read permission.
  It performs **zero Graph data requests**. Every provider acquisition requests
  only its capability's resource scopes and proves the same SDK home/local/
  tenant/API identity, expiry and grants. A successful endpoint response must
  include returned scopes, Bearer type and a positive integral lifetime at most
  48 hours; MSAL's missing-scope fallback is not grant evidence. The earlier SDK
  expiry/exact request-time-plus-lifetime bounds the lease, never a rounded-up
  timestamp or extended outage expiry. Missing/sub-only/contradictory evidence
  returns `principal_mapping_unavailable`, not a synthetic home key.
- `browserRequestPrincipal` binds a validated existing session to its actual
  MSAL account when cached. A process restart may leave saved browser reads with
  no cached account: its local ID is explicitly unavailable, never guessed.
  Provider acquisition still proves the exact SDK tenant/home account and any
  previously known local ID. Rolling cookie touches cannot extend the original
  eight-hour sign-in ceiling. `createBrowserCredentials` retains silent token
  acquisition and forced role refresh. `acquireDelegatedToken` remains the
  original string-returning adapter; its result helper preserves SDK expiry.
  The existing browser revalidation result helper retains the verified local
  account so the common source rejects an in-flight account substitution.
  Both transports reuse `principalAuthorizationHash` and the existing
  `DataGenerations.sessionEpoch`/account-mutation fences. Principal objects
  cannot be reconstructed from serialized or caller-supplied metadata.
- `DelegatedCredentialSource` exposes immutable `principal`, non-secret
  `reference`, a conservative `expiresAt` lease (earliest API/session/obtained
  provider expiry, with one-second SDK rounding safety on acquired tokens),
  `assertCurrent`, `revalidate`, capability-specific `acquire`,
  and `revoke`. Duplicate requests coalesce only inside the exact source and
  capability/authorization hash. Every acquisition waiter rechecks current
  authorization before returning a token, including concurrent role changes.
  Cancelling one waiter leaves other callers;
  the last cancellation stops shared work and prevents late publication.
  Late failures from cancelled or timed-out work cannot revoke renewed authority
  or impose a cooldown. Concurrent `Retry-After` delta/date responses preserve
  the longest outstanding cooldown; there is no automatic token or
  provider-write replay. Whole exchange/bootstrap/epoch work is bounded to ten
  seconds. A bounded validated `access_token` claims challenge is returned
  only as safe reauthorization details; raw provider errors and tokens are not.
- `DelegatedCredentialStore` is bounded to 10,000 in-memory sources, with random
  non-secret references containing tenant/principal/API/client/transport,
  authorization hash, session epoch and maximum auth expiry. No assertion,
  provider token, SDK cache or connection secret is serialized. A source also
  enforces its earlier provider lease; the reference is a ceiling, not proof
  of current authority. `resolve(reference, verifiedPrincipal)` requires current
  exact principal/API/epoch/role-hash authority; knowing a reference never grants
  another user's credential. Restart cannot resolve old references.
  `reauthorize` requires the exact same tenant/private principal/API and epoch;
  retrying with an already current retained source is idempotent, not
  self-revoking. Changed epochs cannot silently resume an old job. `disconnect`
  revokes one API source; MCP's future OAuth owner separately deletes that connection.
  `revokePrincipal` removes retained sources for the account, while the existing
  durable/account fences remain the authority across transports.

`assertCurrent` checks current in-process account/configuration/freshness/expiry
fences synchronously. `revalidate`/`acquire` check durable epochs before and after
awaited work; existing transactional epoch locks apply at publication/
pre-COMMIT and browser stored-session checks. Returning a principal does not
validate capability generations or grant a provider operation. A worker retains
the source, not the HTTP request's abort signal, then supplies its own job
cancellation signal. Expiry/challenge/revocation/restart pauses work for explicit
same-principal authorization. Browser middleware retains real session
reload/save/destroy and capability invalidation; it does not save bearer claims
or fabricate sessions.

Signed JWT/SDK/guest/concurrency/deadline fixtures are not live Entra proof.
These adapters are registered at the current HTTP boundary. The current issuance
cutoff supports durable replay-safe recovery without changing the private key.
Omitted integration disables bearer admission without affecting browser startup; explicit invalid
configuration fails in both Node and existing local/Azure registry tooling.

Current principal consumers: `middleware/auth`,
`routes/policy`, `requestScope`, `reportIdentity`, auth/logout/session fences,
`services/capabilities`, directory/agentPeople/agentIdentityResolution,
packageInventory, powerPlatformInventory, dataSync/automatic/detail admission,
bulkJobs, copilotStudioQuarantineControl/Jobs/Canaries, purviewAudit,
defenderHunting, csvExport/publication and reportExportDispatcher. Check direct
`acquireDelegatedToken`/`revalidateAuthenticatedUser` calls plus nested workers,
not only routes. Saved reads and export builds retain SQL selection validation
and do not obtain provider tokens. Browser session bookkeeping stays in browser
adapters; no worker manufactures `express-session`.

#### Current canonical integration

`createApp` admits one verified source before canonical route policy, scope,
role and capability evaluation. Cookie plus Authorization is rejected before
exchange or domain SQL; a bad Authorization header never falls back to cookies.
Only a successfully verified bearer source bypasses cookie Origin/CSRF checks.
Every existing public/browser-only boundary remains classified in the sole
operation tables below; no bearer alias or secondary operation map exists.
`requestUser` projects the same existing user DTO and `requestScope` uses the
verified private key. Browser-only auth, imports, configuration
and file-download boundaries remain browser-only.

One async context propagates the initiating `DelegatedCredentialSource` through
nested services and promise-launched workers. Active provider consumers use
`acquireAuthorizedToken`/`revalidateAuthorizedUser`; these reject absent or
mismatched authority and cannot adopt a cached browser account after restart.
Browser SDK adapters handle supported middleware/session bookkeeping.
Session-validation and capability closures capture the initiating
source, role hash and existing generation; report identity retains its exact
epoch instead of refreshing authority around old work. Application-token and
shared application-data paths reject bearer contexts.

Existing inventory and SQL-export timers retain bounded, process-local
pending-work-to-source associations (at most 10,000 each), not a user identity
registry or durable token cache. New requests cannot replace authority in
already-running work. Expired/revoked/stale sources are pruned on explicit
admission; unexpected failures propagate. Inventory restart work with no source
does not publish: only existing bounded orphan-metadata/retention cleanup runs.
An explicit same-principal enqueue may resume pending derived work. Export
restart/authorization loss leaves a lease-fenced queued job with
`error=authorization_required`, clears partial chunks, and never reports ready.
The browser stops polling that state and explicitly resubmits the same saved
intent/idempotency key. Existing private selection/epoch checks still apply;
changed epochs require a new selection, not silent rebinding.

Package/quarantine/search/hunting refresh workers retain their existing
authorization-wait states, cancellation, sent-unknown reconciliation,
prestate/readback, capacity, maintenance and pre-COMMIT fences. Bearer role
freshness remains five minutes from immutable API issuance: OBO or an internal
retry cannot extend it. Browser middleware refreshes roles through its existing
session-saving flow; long work that loses authority pauses for an explicit fresh
call. Provider grants, role evidence and real provider denial remain independent
of successful login. Validated `transport` and `integrationClientId` are retained
for authenticated audit-origin attribution.

The registered HTTP/RSA/JWKS/real-SDK fixtures prove native/guest private SQL and
method/route/input/default/result/error parity without portal cache or provider
data reads, explicit nested provider dispatch, internal revocation, newer-issued
assertion recovery and concurrent-source isolation. These are synthetic local
proofs, not live native/guest verification or a deployment result.

## Wire vocabulary, bounds and evidence semantics

Map rows below use these exact reusable contracts:

- **I** inventory query: single string-valued `inventoryScope=catalog|
  power_platform_only|all` (default **all**), `type`, `view`, `endUserAccess`,
  `reportedUsage`, `management`, `relevance`, `recordId`, `operationIdPrefix`,
  `search` <=256, `source=all|graph_packages|power_platform|both` (default all),
  `linkState=matched|unmatched|ambiguous|conflicting`, `environmentId`, `blocked=
  true|false`, `publisher`, `availableTo`, `host`, `platform`,
  `createdWithinDays=1..3650`, `sortBy` (the exact `unifiedAgentSortKeys` below,
  default displayName), `sortDirection=asc|desc` (asc).
  Facets use `~null` or `~string:<literal>`; `availableTo=~some-or-all` has its
  existing special meaning. Empty/duplicate/structured wire fields are not
  authoritative. POST captures `{query:I}` **without** paging; GET pages use
  `selectionId`, opaque `cursor`, `limit=1..100` (50).
- **IS** strict dependent inventory page: required `selectionId`, optional
  `cursor`, `limit=1..100` (50). No recapture on continuation.
- **R(endpoint)** report filters: `setId`, `scope`, `search`, `company`,
  `department`, `entitlement`, `serviceState`, `appActivity`, `reportActivity`,
  `cohort`, `licenseCohort`, `creatorType`, `agentId`, `username`,
  `responsesOnly`, `startDate/endDate`, `lowResponseThreshold` (5, 1..100000000),
  `inactiveDays` (30, 1..365), `activityWindowDays` (30, 1..365),
  `adoptionChamps/adoptionAgents=with|without`, `sort`, `order`, plus optional
  `selectionId`, `cursor`, `limit=1..100` (50). Endpoint validation in
  `largeTenantUsersReports.reportQuery` rejects meaningless organization/
  relationship/date filters. `adoptionChamps/adoptionAgents` accept only
  `with|without` on adoption; malformed or inapplicable filters reject with400.
  Normal browser defaults and licensing/user filters retain their existing meanings.
  Company/department tagging is `~null|~string:<literal>`.
  Exact sort sets/defaults and enums are below. Child relationships may accept
  their own relationship search/filter within the frozen parent.
- **U** inventory usage: `inventorySelectionId` with matching `selectionId`,
  optional retained local `setId`, cursor and limit=1..100 (50); otherwise use
  an `R(official_agents)` selection. Record IDs preserve canonical/source types.
- **T** selected package targets: `{selectionId?, ids?, recordIds?}`; exact
  native IDs or canonical `agent:<uuid>` groups; max5000, access max100.
  Selection required for all-matching, never a browser-expanded tenant list.
- **P** package preview: `{...T, action:block|unblock|update-availability|
  update-installation|reassign, mutationScope:single|bulk, ...access?}`.
  `reassign` parser acceptance is **not** implemented reassignment support.
  **X** access: `{target:availability|installation, mode:add|replace,
  scope:specific|none, principals:[{resourceType:user|group,resourceId:<guid>}]}`
  max500, unique canonical typed IDs. `none` requires replace/empty; `all`
  is unsupported. Single-target PATCH requires replace. Directory resolution
  and preservation/prestate checks remain enforced.
- **Q** Studio preview: `{action:quarantine|unquarantine,snapshotId,
  resourceNativeIds:[1..25 exact IDs],forceStatus?:boolean}`. Execute drops
  `forceStatus`, adds exact `confirmationHash` and required `Idempotency-Key`
  matching `[A-Za-z0-9_-]{1,128}`.
- **J** bounded job history: `limit=1..50` (20). Item paging uses
  `revision`, signed `cursor`, limit=1..100 (50). Persisted jobs/results are
  authoritative; `202` is accepted, not verified completion.
- **H** hunting target: optional exact `agentRecordId`, `userObjectId`;
  body/query duplicates must agree. **HF** curated `DefenderHuntingFilters`;
  **AF** curated `PurviewAuditFilters` from linked types, never raw KQL/HTTP.
  Explicit `tokenMode=delegated|application` is required on submission.
  MCP adapters accept delegated only; preserve separately approved browser
  application/shared workflows.
- **A** audit query: `limit` default100, clamped1..5000; `offset=0..100000`
  (0), `agentId`, `actorUsername`, `scope=single|bulk`, registered `action`,
  registered `status`, literal case-insensitive `operationIdPrefix` <=64
  `[A-Za-z0-9_-]`, `search` trimmed<=200. Retention90 days.

Inventory enums: `view=all|first_party|third_party|user_managed|copilot_studio|
organization_managed|available|unavailable|availability_unknown|organization|
used|unknown`; `endUserAccess=all|available|unavailable|unknown`;
`reportedUsage=all|used`; `management=all|user_managed|organization_managed|
unknown`; `relevance=all|organization|unknown`. Sort keys:
`displayName,environment,builtWith,availability,status,hosts,publisher,origin,
deployment,owner,createdBy,createdAt,lastModifiedAt,lastPublishedAt,agentType,
versions,publication,quarantine,location,model,authentication,channels,
orchestration,webSearch,managed,source,observedAt,linkState,responses,activeUsers,
lastActivity`.

Report enums: `scope=history|selected` (overview default history),
`entitlement=paid_active|paid_inactive|no_paid|unknown`;
`serviceState=enabled|warning|partially_enabled|disabled|suspended|locked_out|
unknown`; `appActivity=active|inactive|unknown`;
`reportActivity=all|recent|inactive|no-activity`;
`cohort=all|zero|low|review|licensed|using_agents|no_agent_activity|
needs_attention|unknown_metrics`; `licenseCohort=active_without_paid`.
`responsesOnly` is boolean. Dates are inclusive real `YYYY-MM-DD` UTC activity
filters, not new reporting periods. Sort sets: copilot_users
`name|upn|company|department|service|appActivity|responses|agentsUsed|lastActivity`;
official_users `name|responses|agentsUsed|lastActivity`; official_agents
`name|responses|activeUsers|licensedUsers|unlicensedUsers|lastActivity`;
relationships `name|responses|lastActivity|creatorType`; history
`reportingPeriod|acceptedAt`; overview `name|lastActivity`; adoption/plans/
observations `name`. Default history is reportingPeriod/desc, official_agents
responses/desc, other endpoints name/asc. All filters are API-owned before paging.

Payload authority is current [inventory types](../backend/src/types/unifiedAgents.ts),
[report types](../backend/src/types/officialReportData.ts),
[report API](../backend/src/types/officialReportApi.ts),
[jobs](../backend/src/types/copilotPackage.ts),
[quarantine](../backend/src/types/copilotStudioQuarantine.ts),
[Purview](../backend/src/types/purviewAudit.ts) and
[Defender](../backend/src/types/defenderHunting.ts). v1 adapters project these
domain shapes, not a new universal data envelope. Selected pages keep `value`
(responsibility uses `people/selected`), `counts`, `page.nextCursor/
previousCursor`, `selection` with id/revision/evaluatedAt/expiresAt/validatedAt
and publication revisions, source/report/freshness/partial evidence.
Continuation is explicit, total versus returned counts stay separate.
Inventory freshness sources preserve both `row_count` (saved memberships) and
`collected_count` (the latest collection), including PostgreSQL bigint strings.
These counts can differ when a narrower collection retains earlier saved rows.
The current source projection has no `token_mode`; saved tenant data is not
partitioned by the collector's authentication mode.
Native quarantine identities retain their saved field provenance, including
explicit null when provenance was not supplied. Optional package provider
telemetry remains separate from report usage: runtime hours and exception rates
must be finite, nonnegative numbers no larger than `Number.MAX_SAFE_INTEGER`;
invalid values fail response validation instead of becoming null.
Usage timestamps must be real, timezone-qualified calendar instants; original
offsets and fractional precision (up to nine digits) are preserved.

Errors use the existing `application/problem+json` envelope
(`type,title,status,detail,code,requestId,details?`; also `X-Request-ID`; see
`errors.ts`); adapters return a bounded
tool error with original status/code, safe message, requestId, optional
retryAfterSeconds and same sanitized details. Preserve 400 invalid input/cursor,
401 reauthorization, 403 role/grant, 404 private-or-missing, 409 stale selection/
receipt/idempotency/prestate, 413 output bound, 429 cooldown, 503 admission and
504 deadline. Never catch-to-empty success or automatically recapture page two.
Auth failures stay auth errors, not business zero results.

Counts/responses are nonnegative exact safe integers. Unknown metrics/date/
description are null with source availability, not 0/empty evidence. Display
names never identify targets. Opaque package/report IDs remain case-sensitive;
directory UUIDs normalize lowercase; native/environment normalization remains
source-specific. Report-only rows are readable but cannot control a provider.
Creator, owner, modifier and usage are separate relationships. Licensing is
current saved service-plan evidence, not historical or inferred from report
categories. Licensed/unlicensed active categories are non-additive.

`createdWithinDays` freezes at selection `evaluatedAt`: **any** selected source
creation fact `>= evaluatedAt - days*86400000` qualifies, inclusive at the
boundary; current SQL has no upper-bound/future-time rejection. The displayed
earliest creation column can therefore differ from membership when several
versions exist. Only package `createdDateTime` / native `createdAt` create this
fact. Modification, publication, collection, import and last activity never
substitute. Unknown creation excludes the record from this predicate; expose
unknown counts separately. Preserve this semantics unless a separately approved
business change is required; 04 tests exact boundary and more than one page.

Descriptions: full available native/long/short About with provenance and
unknown state; prefer existing selected detail/sections/member APIs. Current
detail max524288 bytes can reject one large record: 04 owns an explicit
version-pinned text continuation, **not** truncation. Authorized configuration
includes saved model/auth/channels/orchestration/knowledge/tools/connectors/
versions/environment metadata; no connection credentials, callback URLs,
transcripts or arbitrary raw provider archive.

Trends compare retained snapshots, never all-time/daily inferred totals.
Only comparable, known equal-length non-overlapping reporting windows with
matching source/identity semantics support growth rates; zero baseline means
new activity, absent counts stay null. Overlap, unequal lengths, same-end or
undated/activity_range-only windows remain explicit incomparable observations.
Imported-at/activity endpoints do not prove reporting windows or freshness.

### Invocation budgets (initial ceilings, not measured capacity)

- Four concurrent API requests per tool; each request <=30s, exchange <=10s.
  A tool wall-clock <=60s includes exchanges, requests, one safe-read retry and
  cooldown. <=8 physical API requests and <=2 token exchanges per invocation.
  Retry cannot extend this budget; honor `Retry-After` or return cooldown.
- One page per ordinary list tool (inventory/report <=100; adoption <=10).
  Compound API projections must be bounded server-side, not client N+1 joins.
  Output <=524288 UTF-8 bytes per tool; preserve domain continuation or return
  explicit output-limit error. Adoption's existing API max1048000 bytes is
  not permission to raise tool limits; 04 supplies bounded champion projections.
- Submit long work and return job reference; status does not wait for the job.
  MCP polling is client-driven, max12 polls per example workflow, >=2s apart,
  <=120s workflow budget, then return pending with exact resume reference.
  Never replay uncertain writes; reads/cancel respect cancellation.
- Current API body512KiB; selection max10min or earlier dependency transition;
  inventory pages/detail524288 bytes; directory physical request10s and
  explicit resolution wall120s (MCP60s may cancel earlier); native Studio25
  targets; package5000/access100; provider jobs retain their smaller limits.
  Existing browser timings/defaults are **not** reduced by adapter budgets.
- Cases A-C <=32 tool calls, <=4MiB aggregate delivered JSON and <=180s each,
  excluding user confirmation wait or durable job completion; report actual
  pages/calls/bytes/time in 09/11, not a favorable first page. Host CPU/RSS/disk/
  Docker-context measurements must come from the actual tested deployment.

## Canonical operation and web feature map

Rows below describe the current registrations after `createApp()`, including
public SPA boundaries. All route
modules are mounted once under `/api`; tables show full HTTP paths. Parameter
names are literal route grammar, not display-name selectors. `—` means **no
MCP tool / no bearer admission**, not missing implementation. `V` includes
UsageReportUploader and Admin, `U` means UsageReportUploader or Admin, `A` means
Admin, `S` means any validated session, `P` public. Authenticated
non-GETs retain CSRF and same-Origin for browser transport. Capabilities are
exact IDs from `capabilityRegistry`; where dynamic, the service rechecks them.
Tool names are the finite server allowlist. Phase06 read/collection/investigation
and phase07 exact-control tools below are registered now.
No allowlisted tool may invoke a route omitted here. Application-mode options,
canaries, import/shared-selection writes, binary downloads and browser automation
are deliberately omitted. The SDK rejects direct calls to unregistered/omitted tools,
not merely hide `tools/list` results.

### Public, authentication, setup and Permissions

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/health` | none -> `{ok:true}` | deployment liveness | — | P |
| `GET /api/ready` | none -> `{ok:boolean}`,503 on schema/maintenance | deployment readiness | — | P |
| `GET /api/auth/status` | none -> authConfigured/callback/setup | App setup/sign-in | — | P |
| `GET /api/diagnostics` | none -> admission/fingerprint/fixed limits | operator diagnostics | — | A |
| `GET /{*path}` | SPA path; no dot/assets ->HTML | all browser deep links | — | P |
| `POST /api/auth/login` | `{username,returnTo?:"/"}` ->authorizationUrl | startSignIn | — | P |
| `GET /api/auth/login` | `username?,returnTo?:"/"` ->redirect | Sign in again | — | P |
| `GET /api/auth/callback` | one-use `code,state` or provider error ->safe redirect | Entra callback | — | P |
| `POST /api/auth/logout` | no body ->204; evict/pause/revoke all account sessions | signOut | — | S |
| `GET /api/me` | none ->user/csrfToken/roleAssignmentRequired | getCurrentUser | — | S |
| `GET /api/workbench/metadata` | none ->bounded code-owned definitions | getWorkbenchMetadata/navigation/gates | — | V |
| `GET /api/workbench/jobs` | none ->up to100 combined summaries/unavailableSources | getWorkbenchJobs/Sync recovery | list_workspace_jobs | V |
| `GET /api/capabilities` | none ->`{value:CapabilityView[]}` saved readiness | getCapabilities/Permissions | list_capabilities | V |
| `GET /api/capabilities/check-progress` | `retry?:failed` ->`{progress:null\|checks}` | getCapabilityCheckProgress | get_capability_check_progress | V |
| `POST /api/capabilities/check` | absent/empty object; `retry?:failed` ->views; explicit tokens/read checks | checkCapabilities, one browser initial check | check_capabilities | V |
| `POST /api/capabilities/:id/probe` | registered capability ID ->CapabilityView | targeted retry API, no current UI prerequisite | probe_capability | V |
| `PUT /api/capabilities/:id/configuration` | `{enabled:boolean,sharedDataScope:boolean}` ->view/revision | application/shared setup API, no current adapter | — | A |

### Inventory, About, configuration and responsibility

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/agent-inventory/selections` | `{query:I}` ->201 selection or200 availability state | getUnifiedAgents capture, all five category views | capture_agent_inventory | V |
| `GET /api/agent-inventory` | I + selected paging ->UnifiedAgentInventoryPage | getUnifiedAgents/Agents table | list_agents | V |
| `GET /api/agent-inventory/health` | no query ->health or not_collected/preparing/unavailable | getInventoryHealth/summary cards | get_inventory_health | V |
| `GET /api/agent-inventory/summary` | IS ->selected summary | API-only selected summary; cards use page summary | get_inventory_summary | V |
| `GET /api/agent-inventory/facets` | IS, `field`, `search?<=256`, `selected?:true\|false` ->facet page | getInventoryFacets/dropdowns | list_agent_facets | V |
| `GET /api/agent-inventory/:recordId/detail` | IS ->one exact record,404 absent/409 ambiguous/413 large | getUnifiedAgentDetail/modal | get_agent | V |
| `GET /api/agent-inventory/:recordId/members` | IS ->source membership page | getInventoryMembers/versions/export | list_agent_members | V |
| `GET /api/agent-inventory/:recordId/children` | IS, `kind`, `sourceScopeId?`, `sourceIdentity?`, `value?` ->child page | getInventoryChildren/config/details | list_agent_children | V |
| `GET /api/agent-inventory/:recordId/sections` | IS, exact `sourceScopeId,sourceIdentity` ->section page | getInventorySections/Overview config | list_agent_sections | V |
| `GET /api/agent-inventory/:recordId/about` | required selectionId/sourceScopeId/sourceIdentity,field long/native/short,cursor? ->AgentAboutPage;16384 Unicode characters/segment,full saved bytes via continuation | getAgentAbout/SavedAgentAbout/AgentOverview; long then native then short; automatically loads complete text without load-more controls or inline provenance | read_agent_about | V |
| `GET /api/agent-responsibility` | `objectId?,search?<=256,selectionId?,cursor?,limit=50<=100` ->people or selected person's agents/roles | getAgentResponsibility/Users responsibility | list_agent_responsibility | V |
| `POST /api/agent-inventory/people/resolve` | `{recordId,force?:false}` ->saved people/changed; derive referenced IDs | resolveAgentPeople/Look up people | resolve_agent_people | V; graph.users.read (application) |
| `POST /api/agents/selections` | `{query:I}` ->201 actor-bound tenant package selection | getAgents capture | capture_packages | V |
| `GET /api/agents` | I + paging ->tenant PackagePage | getAgents/package/access views | list_packages | V |
| `GET /api/agents/:id/detail` | exact `selectionId` ->saved CopilotPackageDetail | getAgentDetails/package editor | get_package | V |
| `GET /api/inventory/resources/:nativeId/related` | required `snapshotId`, `environmentId?:""`; no type ->saved source-aware activity | retained API; modal uses investigation context | get_native_agent_activity | V |
| `GET /api/inventory/quarantine-selection` | required `snapshotId`, 1–25 distinct repeated exact `selected` IDs ->native resources (`PowerPlatformResource[]`) and current snapshot | retained native selection API | resolve_studio_targets | V |

### Users, licensing, official reports, cohorts and retained history

`R` is endpoint-specific above. These are saved reads; no provider call or CSV
reparse. `reportData.readReportPage/readReportDetail` also serve lazy children.
`HTTP only` identifies a canonical session/bearer read without a named MCP tool;
it does not make the endpoint browser-only (`—`).

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/copilot-usage/users` | R(copilot_users) ->ReportPage<CombinedUser> | reportPages.users/paid roster/licensing | list_users | V |
| `GET /api/copilot-usage/users/facets` | R(copilot_users),field company/department/creatorType,search? ->facets | readReportFacet/Users filters | list_user_facets | V |
| `GET /api/copilot-usage/users/unresolved-identities` | R(copilot_users) ->unresolved page | Users source-quality details | list_unresolved_users | V |
| `GET /api/copilot-usage/users/resolve` | exact username<=512,selectionId? **or** setId? ->UserResolution with explicit identity/directory/report states | resolveSavedUsername/shared Users adapter | resolve_user | V |
| `GET /api/copilot-usage/users/:objectId` | R(copilot_users), UUID path ->exact detail | UserDetails/directory identity | get_user | V |
| `GET /api/copilot-usage/users/:objectId/service-plans` | R(copilot_users) ->plans page | UserDetails/license plans | list_user_service_plans | V |
| `GET /api/copilot-usage/users/:objectId/agents` | R(copilot_users), child relationship filters ->relationships page | Users per-person agent drilldown | list_user_used_agents | V |
| `GET /api/copilot-usage/users/:objectId/agent-relationships` | required selectionId/inventorySelectionId,relationship used/created/owned/modified,limit50<=100,cursor? ->SavedRelationshipPage;distinct native evidence/canonical/report-only IDs | readUserAgentRelationships/shared responsibility adapter; existing responsibility route unchanged | list_user_agent_relationships | V |
| `GET /api/copilot-usage/adoption` | R(adoption), group limit=min(request,10) ->AdoptionPage | AdoptionView/champions and department agents | list_adoption_groups | V |
| `GET /api/copilot-usage/adoption/summary` | R(adoption), unfiltered organization summary | AdoptionView organization totals | HTTP only | V |
| `GET /api/copilot-usage/adoption/departments` | R(adoption_departments), limit,cursor?/pageNumber? ->selected department page | AdoptionView department groups | HTTP only | V |
| `GET /api/official-usage/history/adoption` | R(adoption_history), unfiltered retained history,limit,cursor? ->selected adoption history | AdoptionView retained report history | HTTP only | V |
| `GET /api/copilot-usage/adoption/facets` | R(adoption),field,search? ->facets | AdoptionView company/department | list_adoption_facets | V |
| `GET /api/copilot-usage/adoption/champions` | required exact-group adoption selectionId/full inventorySelectionId,limit50<=100,cursor? ->ChampionAgentPage;top3 portal rank,only their complete used/created edges | readChampionAgents/shared Adoption adapter; department array unchanged | list_champion_agents | V |
| `GET /api/official-usage/aggregate` | R(official_agents) ->ReportPage<ReportAgent> | reportPages.agents/snapshot inspector | list_report_agents | V |
| `GET /api/official-usage/aggregate/facets` | R(official_agents),field,search? ->facets | inspector creator filter | list_report_agent_facets | V |
| `GET /api/official-usage/users` | R(official_users) ->ReportPage<ReportUser> | reportPages.reportedUsers/unpaid active cohort | list_report_users | V |
| `GET /api/official-usage/users/facets` | R(official_users),field,search? ->facets | reported-user filters | list_report_user_facets | V |
| `GET /api/official-usage/agent-users` | R(relationships) ->bridge page | API-only complete bridge | list_report_relationships | V |
| `GET /api/official-usage/agents/:agentId` | R(official_agents),case-sensitive full ID ->exact report detail | snapshot inspector | get_report_agent | V |
| `GET /api/official-usage/agents/:agentId/users` | R(official_agents),child filters ->relationship page | snapshot agent drilldown | list_report_agent_users | V |
| `GET /api/official-usage/users/:username` | R(official_users),case-sensitive username ->exact report detail | reported-user details | get_report_user | V |
| `GET /api/official-usage/users/:username/agents` | R(official_users),child filters ->relationship page | reported-user agents | list_report_user_agents | V |
| `GET /api/official-usage/users/:username/directory` | R(official_users) ->exact uniquely linked directory detail or404 | reported-user license follow-up | get_report_user_directory | V |
| `GET /api/official-usage/users/:username/service-plans` | R(official_users) ->linked plans or404 | reported-user plans | list_report_user_service_plans | V |
| `GET /api/official-usage/history` | R(history) ->sets,whole-history summary | reportPages.history/Manage reports | list_report_history | V |
| `GET /api/official-usage/history/options` | R(history) ->options page, same ordering | shared report dropdown/latest period | list_report_options | V |
| `GET /api/official-usage/history/:setId/observations` | R(history) ->exact set observations page | inspector source details | list_report_observations | V |
| `GET /api/official-usage/overview` | R(overview),scope default history ->history locator/no summed responses | overview cards/API retained locator | get_report_overview | V |
| `GET /api/agent-inventory/:recordId/usage` | U ->source-backed CandidateAgentUsageSummary | readAgentReportSummary/modal metrics | get_agent_usage | V |
| `GET /api/agent-inventory/:recordId/usage-history` | U without setId/search,optional paired compareFromSetId/compareToSetId UUIDs ->unchanged history page/latest plus qualified comparison | readAgentReportHistory/trend/shared comparison adapter | list_agent_usage_history | V |
| `GET /api/agent-inventory/:recordId/usage-users` | U,search? ->grouped case-sensitive users page | readAgentReportUsers via readReportPage/Users tab | list_agent_usage_users | V |
| `GET /api/agent-inventory/:recordId/usage-associations` | U ->reviewed versus exact_package_id associations page | readAgentReportAssociations/collapsed reviewed links | list_agent_usage_associations | V |
| `GET /api/agent-inventory/:recordId/usage-candidates` | R(official_agents),inventoryRevision?64hex ->saved candidates page | readAgentReportCandidates/repair API | list_agent_usage_candidates | A |
| `POST /api/agent-inventory/:recordId/usage-associations` | confirmed association fields below with exact source target ->updated context | mutateAgentReportAssociation/explicit repair API | — | A |
| `DELETE /api/agent-inventory/:recordId/usage-associations` | same fields without target; matching inventorySelectionId? ->context | mutateAgentReportAssociation/remove reviewed link | — | A |

Association body: exact `selectionId,reportSetId,reportAgentId,inventoryRevision,
usageRevision,confirmed:true`; POST target `{source:graph_packages,packageId}`
or `{source:power_platform,nativeId,environmentId:string|null}`. DELETE omits
target. Preserve active report/current membership fences and transactional
audit. These tenant shared repair writes are browser-only, not reasoning tools.

### CSV import, shared report selection and export

The actual streaming server upload is **256MiB per file**, maximum100000 Users,
200000 Agents or1000000 User-Agent rows. Multipart accepts one file and six
bounded metadata fields; admission is four global/two tenant streams, deadline
30min. Tenant retained staging is separately quota-bound. Preserve these server
limits and bounded SQL stream batches; no MCP file/blob/download tool.

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/official-usage/staging` | multipart file + optional operator reportingStart/End,periodProvenance,sourceAsOf/Provenance,downloadedAt; query bundleId,correctionOfSetId?,rejectDuplicateKind? ->preview | stageReport/Add CSV reports | — | U; corrections A |
| `GET /api/official-usage/staging/:id` | exact UUID ->OfficialReportPreview | readReportStage/resume explicit draft | — | U; own new drafts; corrections A |
| `GET /api/official-usage/staging/:id/diagnostics` | cursor?,limit=50<=100 ->diagnostics page | readReportDiagnostics/import errors | — | U; own new drafts; corrections A |
| `DELETE /api/official-usage/staging/:id` | exact UUID ->204 | discardReportStage/confirmed cleanup | — | U; own unaccepted new drafts; corrections A |
| `POST /api/official-usage/staging/:id/accept` | OfficialReport acceptance intent/hash/revision ->accepted | retained single-stage API; ordinary browser uses bundle | — | U; own new imports; corrections A |
| `POST /api/official-usage/bundles/:id/preview` | `{forDiscard?:boolean}` ->OfficialReportBundlePreview | previewReportBundle/validate or cleanup | — | U; own new imports; corrections A |
| `POST /api/official-usage/bundles/:id/accept` | `{contentHash,expectedActiveRevision,acknowledgeCorrection?}` ->OfficialReportAccepted | acceptReportBundle/import/replay verification | — | U; own new imports; corrections A |
| `POST /api/official-usage/sets/:id/preview` | `{operation:select\|delete}` ->OfficialReportConfirmation | previewReportOperation/dropdown/delete | — | A |
| `POST /api/official-usage/confirmations/:id` | exact full server confirmation,body id=path ->confirmed | confirmReportOperation/shared selection/deletion | — | A |
| `POST /api/data-exports` | OfficialReportExportRequest `{selectionId,kind,ids?,idempotencyKey}` ->202 `{id}` | createReportExport/all filtered inventory/users/report CSV | — | V |
| `GET /api/data-exports/:id` | exact UUID ->status/bytes/expiry | reportExportStatus/download polling | — | V |
| `DELETE /api/data-exports/:id` | exact UUID ->204 | cancelReportExport | — | V |
| `GET /api/data-exports/:id/download` | exact UUID ->authorized streamed CSV | reportExportDownload/native download | — | V |

Exact import/confirmation/export members are frozen by
`types/officialReportApi.ts` and `db/officialReportImports.ts`; no dates are
guessed. `kind=copilot_users|official_agents|official_users|graph_packages|
power_platform_agents|unified_agents`. Duplicates reuse immutable receipts;
first import selection/later shared-selection semantics stay API-owned.
Unknown/uncertain acceptance is verified, not reuploaded. CSV keeps whole
matching selected datasets, source metric meanings and spreadsheet escaping.
Local browser storage is not an API data source.

### Refresh and job recovery

MCP refresh tools are explicit calls; none run from ordinary saved read handlers.
Existing signed-in browser visibility/initial/check/due behaviors stay unchanged.
`data-sync/auto-refresh` is browser automation, not an application scheduler.

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/data-sync/state` | no query ->DataSyncState | getDataSyncState/Sync history | get_sync_state | V |
| `POST /api/data-sync/auto-refresh` | absent/empty object,no query ->AutomaticRefreshResult | checkAutomaticRefresh/visible signed-in workbench | — | V |
| `POST /api/data-sync/runs` | `{mode:initial\|incremental\|full,sources?,clearSavedData?:false}` ->202 run | startDataSync/Sync all/reset saved data | start_sync | V; dynamic capabilities |
| `GET /api/data-sync/runs/:id` | UUID,no query ->run | getDataSyncRun | get_sync_run | V |
| `POST /api/data-sync/runs/:id/retry` | `{sources?}` ->202 run | retained recovery API (current UI starts fresh runs) | retry_sync | V |
| `POST /api/data-sync/runs/:id/cancel` | absent/empty object ->run | cancelDataSyncRun | cancel_sync | V |
| `GET /api/data-sync/package-details` | no query ->PackageDetailSyncState | getPackageDetailSyncState | get_package_detail_sync | V |
| `POST /api/data-sync/package-details/start` | absent/empty object,no query ->202 state | startPackageDetailSync | start_package_detail_sync | V |
| `POST /api/data-sync/package-details/cancel` | absent/empty object,no query ->state | cancelPackageDetailSync | cancel_package_detail_sync | V |
| `POST /api/agents/refresh-jobs` | `{mode?:application,ids?:1..5000}`; Idempotency-Key? ->202 job | startPackageRefresh/explicit catalog | refresh_packages | V; graph.package.read.application |
| `POST /api/agents/:id/refresh-jobs` | `{mode?:application}` exact package path ->202 exact job | startExactPackageRefresh/access editor | refresh_package | V |
| `POST /api/agents/refresh-selection` | `{selectionId,ids?,recordIds?}` key? ->202 selected job | refreshPackageIdentityDetails/bulk preparation | refresh_selected_packages | V; graph.package.read.application |
| `GET /api/agents/refresh-jobs` | J,mode=application ->job list | getPackageRefreshJobs/initial discovery | list_package_refresh_jobs | V |
| `GET /api/agents/refresh-jobs/:id` | mode=application ->job | getPackageRefreshJob | get_package_refresh_job | V |
| `GET /api/agents/refresh-jobs/:id/targets` | mode=application,revision?,cursor?,limit=50<=100 ->targets | getPackageRefreshTargets | list_package_refresh_targets | V |
| `POST /api/agents/refresh-jobs/:id/resume` | `{mode?:application}` ->202 job | refreshPackageIdentityDetails/API recovery | resume_package_refresh | V |
| `POST /api/agents/refresh-jobs/:id/cancel` | `{mode?:application}` ->job | cancel_package_refresh | cancel_package_refresh | V |
| `POST /api/inventory/refresh-jobs` | `{environmentId?,types?:allowlisted agents/environments}`,key? ->202 job | refreshInventory | refresh_studio_inventory | V; powerPlatform.inventory.read |
| `GET /api/inventory/refresh-jobs` | J ->job list | getInventoryRefreshJobs | list_studio_refresh_jobs | V |
| `GET /api/inventory/refresh-jobs/:id` | UUID ->job | getInventoryRefreshJob | get_studio_refresh_job | V |
| `POST /api/inventory/refresh-jobs/:id/resume` | UUID ->202 job | resumeInventoryRefresh | resume_studio_refresh | V; powerPlatform.inventory.read |
| `POST /api/inventory/refresh-jobs/:id/cancel` | UUID ->job | cancelInventoryRefresh | cancel_studio_refresh | V |

Sources are `users|graph_packages|power_platform|usage_reports`; automatic
sources exclude manual usage. `clearSavedData=true` requires full and omitted
sources and clears users/inventory, **never reports**. MCP start_sync does not
expose clearSavedData or manual upload source. This is narrowed adapter input,
not a second server route/default. Browser retains its confirmed reset action.
MCP `start_sync` and `retry_sync` accept only distinct source names; omit
`sources` to retain the API's default source selection.

### Package controls and explicit Studio controls

Existing package effects remain package effects even for a Studio-linked package.
Generic Studio routing is a **distinct operation** below. API enforces
target/receipt/current authorization, not a claim of human/scheduled intent.

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/agents/mutation-selection` | T with selectionId ->selected counts | countPackageMutationSelection/bulk counts | count_package_targets | A |
| `POST /api/agents/mutation-preview` | P ->bound hash/summary/prestates/eligibility | previewPackageMutation/confirmation | preview_package_control | A; dynamic capability |
| `POST /api/agents/block` | T,confirmationHash;key? ->202 BulkJobStatus | blockAgents/selected package block | block_packages | A; graph.package.block.manage |
| `POST /api/agents/unblock` | T,confirmationHash;key? ->202 BulkJobStatus | unblockAgents/selected package unblock | unblock_packages | A; graph.package.block.manage |
| `POST /api/agents/block-all` | `{selectionId,confirmationHash}` only;key? ->202 job | submitSelectedPackageMutation/all matching | block_selected_packages | A; graph.package.block.manage |
| `POST /api/agents/unblock-all` | `{selectionId,confirmationHash}` only;key? ->202 job | submitSelectedPackageMutation/all matching | unblock_selected_packages | A; graph.package.block.manage |
| `POST /api/agents/:id/block` | `{selectionId?,confirmationHash}`,key? ->202 single job | blockAgent | block_package | A; graph.package.block.manage |
| `POST /api/agents/:id/unblock` | same ->202 single job | unblockAgent | unblock_package | A; graph.package.block.manage |
| `POST /api/agents/access` | T+X+confirmationHash,key? ->202 job,max100 targets | updateAgentsAccess/bulk assignments | update_packages_access | A; graph.package.access.manage |
| `PATCH /api/agents/:id/access` | X(replace)+selectionId?+confirmationHash,key? ->202 single job | updateAgentAccess | update_package_access | A; graph.package.access.manage |
| `GET /api/agents/bulk-jobs` | J ->job list | getBulkActionJobs/receipt discovery | list_package_control_jobs | V |
| `GET /api/agents/bulk-jobs/:id` | UUID ->BulkJobStatus | getBulkActionJob/progress | get_package_control_job | V |
| `GET /api/agents/bulk-jobs/:id/items` | revision?,cursor?,limit=50<=100 ->item page | getBulkActionJobItems/verified outcomes | list_package_control_items | V |
| `POST /api/agents/bulk-jobs/:id/cancel` | UUID ->job | cancelBulkActionJob | cancel_package_control | A |
| `POST /api/agents/bulk-jobs/:id/resume` | `{confirmed:true}` ->202 unsent job | resumeBulkActionJob | resume_package_control | A; job capability |
| `POST /api/agents/bulk-jobs/:id/reconcile` | UUID ->GET-only readback outcomes | reconcileBulkActionJob | reconcile_package_control | A; delegated read |
| `POST /api/agents/mutation-canaries` | exact `{action,targetId,prestate,poststate}` ->201 approval | optional operator API,no ordinary gate | — | A |
| `POST /api/agents/mutation-canaries/:id/execute` | `{confirmed:true,restorationApprovalId}` ->qualified or conflict | optional separate-admin restoration cycle | — | A |
| `GET /api/quarantine/status` | snapshotId,nativeId,force?:false ->QuarantineStatusView; cache or explicit live | getQuarantineStatus/Studio Manage | get_studio_status | V; dynamic powerPlatform.quarantine.read |
| `POST /api/quarantine/preview` | Q ->QuarantinePreview | previewQuarantine/Studio confirmation | preview_studio_control | A; powerPlatform.quarantine.manage |
| `POST /api/quarantine/jobs` | Q execute,key required ->202 QuarantineJob | submitQuarantine | execute_studio_control | A; dynamic manage |
| `GET /api/quarantine/jobs` | J ->job list | getQuarantineJobs/recovery | list_studio_control_jobs | V |
| `GET /api/quarantine/jobs/:id` | UUID ->QuarantineJob | getQuarantineJob | get_studio_control_job | V |
| `POST /api/quarantine/jobs/:id/cancel` | UUID ->job | cancelQuarantineJob | cancel_studio_control | A |
| `POST /api/quarantine/jobs/:id/resume` | only `{confirmed:true}` ->202 unsent job | resumeQuarantineJob | resume_studio_control | A; powerPlatform.quarantine.manage |
| `POST /api/quarantine/jobs/:id/reconcile` | absent/empty object ->GET-only outcomes | reconcileQuarantineJob | reconcile_studio_control | A; powerPlatform.quarantine.manage |
| `GET /api/quarantine/audit` | limit=100<=500 ->audit rows | saved quarantine audit API | list_studio_control_audit | V |
| `POST /api/quarantine/canary-approvals` | `{action,nativeId,poststate,prestate,prestateProviderUpdatedAt,snapshotId}` ->201 approval | optional operator API | — | A |
| `GET /api/quarantine/canary-approvals` | limit=50<=100 ->approvals | optional operator API | — | A |
| `POST /api/quarantine/canary-approvals/:id/execute` | `{confirmed:true,restorationApprovalId}` ->result | optional restoration cycle | — | A; powerPlatform.quarantine.manage |
| `GET /api/directory/principals` | search2..120,limit<=50 (service default25) ->bounded `{value}`; **not exhaustive** | searchDirectoryPrincipals/access editor | search_access_principals | V; application graph.users.read for users; delegated graph.directory.read for groups |
| `POST /api/directory/principals/resolve` | `{principals:[1..500 typed exact UUIDs]}` ->`{value}` | resolveDirectoryPrincipals/access validation | resolve_access_principals | V; application graph.users.read for user IDs; delegated graph.directory.read for group IDs; require only the supplied types |

Receipts bind exact user/action/provider/source/current inventory/prestate/revision/
expiry. Package stage expiry10min; Studio preview validity is provider-specific,
never lengthened by adapter. Both interactive and externally scheduled clients
must obtain current receipts. Interactive client shows every target/effect and
pauses for confirmation; scheduled client submits a current receipt directly.
No `scheduled=true`, human-confirmed authorization flag or second execute route.
Package locks protect local concurrent operations, not provider atomicity:
there is no documented ETag/If-Match. Changed prestate fails; a post-reread
external change remains a disclosed readback risk. Sent-unknown work reconciles
GET-only before a new explicit eligible retry; no automatic double dispatch.

### Investigations, Purview, Defender and administrative Audit

Provider source metadata is not origin. Retain source/data-scope/privacy notices.
All live investigations are explicit; saved lists/catalog/status/records are not
silent provider refreshes.

| Method route | Exact input/default -> output | Browser consumer / feature | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `GET /api/agent-inventory/investigations/context` | recordId only ->saved AgentInvestigationContext | getAgentInvestigationContext/Activity | get_agent_investigation | V |
| `POST /api/agent-inventory/investigations/resolve` | `{recordId}` only ->verified saved identity context | resolveAgentInvestigationIdentity | resolve_agent_identity | V; graph.agentIdentity.read |
| `GET /api/agent-inventory/investigations/purview` | recordId,limit=50<=100,offset=0<=100000,search<=256,allowlisted operation ->saved records | getAgentPurviewRecords | list_agent_purview_records | V |
| `GET /api/audit-search/catalog` | none ->presets/limits/notices | getPurviewAuditCatalog | get_purview_catalog | V |
| `POST /api/audit-search/jobs` | `{tokenMode,filters:AF,agentRecordId?}`,key? ->202 job | submitPurviewAuditSearch/UserPurviewAudit | start_purview_search | V; purview.audit.search.delegated |
| `GET /api/audit-search/jobs` | J,offset=0<=100000,userPrincipalName?,agentRecordId? ->history | getPurviewAuditJobs/user/agent investigations | list_purview_jobs | V |
| `GET /api/audit-search/jobs/:id` | UUID ->job | getPurviewAuditJob | get_purview_job | V |
| `POST /api/audit-search/jobs/:id/resume` | UUID ->202 explicit authorized activation | resumePurviewAuditSearch | resume_purview_search | V |
| `POST /api/audit-search/jobs/:id/cancel` | UUID ->local cancelled job | cancelPurviewAuditSearch | cancel_purview_search | V |
| `DELETE /api/audit-search/jobs/:id` | `{confirmation:<exact jobId>}` ->204 local cache deletion | deletePurviewAuditSearch | delete_purview_cache | V |
| `GET /api/audit-search/jobs/:id/records` | limit=100<=500,offset=0<=100000 ->records/count/job | getPurviewAuditRecords | list_purview_records | V |
| `GET /api/audit-search/jobs/:id/export.csv` | UUID ->CSV,max5000rows/8MB/15s | downloadPurviewAuditCsv | — | V |
| `GET /api/hunting/catalog` | H ->templates/limits | getDefenderHuntingCatalog | get_hunting_catalog | V |
| `POST /api/hunting/jobs` | `{tokenMode,filters:HF,...H}`,key? ->202 job | submitDefenderHunt/UserHunting | start_hunt | V; defender.hunting.delegated |
| `GET /api/hunting/jobs` | J,offset=0<=100000,H ->history | getDefenderHuntingJobs | list_hunting_jobs | V |
| `GET /api/hunting/jobs/:id` | UUID,H ->job | getDefenderHuntingJob | get_hunting_job | V |
| `POST /api/hunting/jobs/:id/resume` | UUID,H ->202 authorized activation | resumeDefenderHunt | resume_hunt | V |
| `POST /api/hunting/jobs/:id/cancel` | UUID,H ->local cancelled job | cancelDefenderHunt | cancel_hunt | V |
| `DELETE /api/hunting/jobs/:id` | `{confirmation:<id>,...H}` ->204 local cache deletion | deleteDefenderHunt | delete_hunting_cache | V |
| `GET /api/hunting/jobs/:id/rows` | limit=100<=200,offset=0<=100000,H ->rows/snapshot/job | getDefenderHuntingRows | list_hunting_rows | V |
| `GET /api/hunting/jobs/:id/export.csv` | UUID,H ->CSV,max200rows/2MB/15s | downloadDefenderHuntingCsv | — | V |
| `GET /api/audit/events` | A ->`{value:AuditEvent[],count}` | getAuditEvents/AuditLogView/filter/details | list_administrative_audit | A |
| `POST /api/audit/events/export.csv` | `{ids:[1..100 unique event IDs]}` ->CSV,max1MB/15s | downloadAdministrativeAuditCsv | — | A |

AF/HF are structured presets/time ranges and supported exact filters only.
Purview UTC timestamps accept whole seconds or exactly three fractional digits;
hunting additionally accepts one or two fractional digits. Both require `Z`.
Purview maximum window168h,20pages/5000rows/8MB,6polls/activation,
64provider requests/12activations; records retain metadata/message IDs, not
prompts. Defender maximum168h,200rows/2MB,12requests/4activations, curated
templates; unknown coverage/empty no_data is not measured completeness.
Application/shared modes use current tenant/client/configuration and configured
shared scope directly. Delegated observations remain private; one mode cannot
silently become fallback authority for another. No read qualification is needed.

The same list/submission handlers forward the optional
`agentRecordId` to the existing service. It resolves the current saved bot,
environment and, for interaction searches, verified application identity before
persisting effective AF scope. Caller-supplied `filters.agent` is rejected.
History intersects the exact saved record reference and optional user before
SQL pagination; no provider DATA request is needed. Existing HTTP wiring,
service-bound identity validation and real SQL intersection fixtures cover
these producer/consumer boundaries. No new route, target inference, provider
writer, permission or bearer admission is introduced.

### Shared generic controls

These **three** canonical registrations reuse current saved selections/SQL and
the sole package and quarantine writers. Both browser and approved delegated
bearer transports use these exact handlers. Explicit package and Studio controls
above remain distinct and unchanged; no UI button was reinterpreted.
Saved-read composition routes support canonical browser/bearer authority, with
static `/resolve` and `/champions` preceding parameterized handlers.

| Method route | Frozen v1 input/output | Web impact and owner | MCP tool | Policy |
| --- | --- | --- | --- | --- |
| `POST /api/agent-controls/preview` | Admin+CSRF; `{selectionId,recordIds:[1..100 exact canonical/report IDs],action:block\|unblock}` ->immutable exact provider effects, eligible/ineligible/already counts, child receipts and expiry, no new business approval | API-only generic operation; explicit package/Studio UI unchanged | preview_agent_control | A; dynamic provider capability |
| `POST /api/agent-controls/execute` | Admin+CSRF; `{receiptId,confirmationHash}`,required `Idempotency-Key` ->202 non-secret correlation with existing package/Studio child references; each child's existing status/items/cancel/resume/reconcile routes are sole outcome authority | API-only generic execution; no parent outcome store | execute_agent_control | A; dynamic provider capability |
| `GET /api/agent-controls/:receiptId` | Admin; private accepted receipt ->current bounded child projection; provider-free read, never admits or resumes work | API-only receipt read; canonical child references | get_agent_control | A; saved private correlation |

No generic parent job or queue is introduced: the receipt GET only projects
existing children, and clients follow their typed references and existing APIs.
If one provider fails, return partial child
admission/result with exact failed scope; do not imply cross-provider atomicity.
Expiry/prestate/cancel/restart/idempotency handling belongs to existing writers.
Generic Studio effects are quarantine/unquarantine only; explicit package
effects retain package block/unblock only. Unknown platform, classic/V1 bots,
ambiguous native IDs, report-only IDs or missing authority are ineligible.

The generic wire DTOs are `AgentControlPreview` and `AgentControlExecution`.
Only current delegated canonical selection membership can supply provider IDs.
The exact source/generation/environment/revision and saved prestate binding is
rechecked before acceptance; native direct status and permission/contract
revision are rechecked too. Package workers retain their exact live prestate,
readback and dispatch fences. Receipt lifetime is the earlier selected-source
expiry and ten minutes; max100 canonical targets and100 effects/provider,
25 native effects/child, 524288-byte persisted envelope. `report:` references
are explicitly ineligible; source names and descriptions never resolve controls.
Already-in-state effects remain eligible and use existing verified skipped-item
outcomes, not synthetic success.

`agent_control_receipts` stores only immutable exact reviewed input and first
accepted idempotency/initiator/origin, not job/item status or provider credentials.
First acceptance is transactional and private principal/hash/epoch-bound.
Child keys are deterministic `agent-control-<receipt UUID>-<ordinal>`; a crash
between acceptance and child creation can retry that exact key. Existing jobs
remain the sole item/outcome authority. After receipt expiry a retry can return
retained children, but cannot admit a missing child (`child_admission_expired`).
A later client cannot replace initiating
origin/actor, change the receipt or key, or use attribution as operation identity.
Execution reports admission (`accepted|partial|ineligible|failed`) independently
from each child's status and final/verified flags. All-ineligible receipts are
final but never verified. A missing child is non-final only while its receipt
can still admit work; after expiry it is final and unverified. Existing children
retain their own lifecycle state even after receipt expiry. Parent `verified` means all
eligible submitted child effects are verified; it never converts an ineligible
requested target into success. `partial` and `ineligibleCount` remain authoritative
even when those eligible effects are verified. Current canonical unresolved-
reconciliation counts/flags determine `readback_unknown`; a reconciled known
not-applied/conflict result remains `unverified`, not unknown or verified success.
Unknown/sent outcomes are not
automatically reconciled or resent. Existing child status/items, cancel, explicit
resume and reconcile routes remain the recovery boundary. There is no parent
scheduler, queue, approval engine, confirmation-bypass flag or atomicity claim.
No matching generic UI existed: new typed adapters expose this operation;
existing explicit control/lifecycle adapters still use their canonical URLs,
labels, filters, confirmations and effects.

Current `/agent-responsibility` reports only native responsibility, not all
usage; `search` is substring search, not exact UPN resolution. Current adoption
`agents` includes **all group's** positively used report agents, including
Microsoft, third-party and report-only agents; it is not champions-only. Inventory
is optional enrichment, never a usage-membership requirement. The04 SQL joins
the requested champions against their full authorized associations, not consume
that department array. Shared Adoption SQL ranking is responses DESC NULLS LAST,
distinct positively used report agents DESC, lowercase name then exact identity;
eligible means positive responses or agent usage, max3. Creation counts are
separate inventory metrics and do not influence rank. Missing relationship-report
counts are null, not measured zeroes. No designated groups.

04 extends the **existing** usage-history operation, not a new comparison
route: optional paired `compareFromSetId,compareToSetId` UUIDs under its pinned
inventory/report-history authority. Keep the normal history page and add
`comparison={state:comparable|incomparable|unknown,reasons:string[],
from:{setId,window,metrics},to:{setId,window,metrics},
responsesDelta:number|null,responseGrowthPercent:number|null}`. API SQL/services
own window qualification and calculations; the thin tool never computes them.
Delta is signed; percent is relative snapshot response change, not daily volume
or user-population-normalized growth. Zero baseline gives null
percent with `new_activity`, absent metrics null, overlapping/unequal/undated
windows incomparable/unknown. Existing web history consumers preserve their default
page and use the same optional comparison fields and errors.

#### Saved-read semantics and continuation

- `UserResolution.state` is `resolved|ambiguous|concealed_or_unresolved|
  unresolved|directory_missing`. Directory UPN matching uses its existing exact
  trimmed case-insensitive key, not display names, fuzzy search, inferred email,
  `oid.tid`, or report usernames as private keys. `objectId` is null unless one
  directory object matches. `reportIdentityState=matched|ambiguous|unresolved|
  missing`, `reportedUsername`, `directoryMatches`, directory/reports and selection
  metadata remain explicit. The saved schemas do **not** retain the tenant's
  concealment setting: `concealment:"unknown"` and `concealed_or_unresolved`
  deliberately do not claim known concealment. No Graph settings enrichment.
  A supplied selection must be `copilot_users`; setId and selectionId cannot be
  supplied together.
- Compound reads require delegated all-inventory canonical selections, not a
  category/creation/platform UI subset. Capture `{query:{inventoryScope:"all",
  view:"all",source:"all"}}` through the existing inventory selection API and
  capture users or adoption through the existing report route. Adoption must
  explicitly select company and department (including tagged nulls). Both
  selections must share exact directory generation and retained-history
  revision/epoch. Every continuation checks private tenant/MSAL home-account,
  authorization hash/session epoch, generations, revisions, expiration and source
  authority. Cursors also bind both selections, evaluatedAt, requested person/
  relationship or exact group/champion IDs, and limit. No revision recapture.
- `SavedRelationshipPage.value` carries `id`, canonicalId, reportAgentId, name,
  relationship, personId, reportedUsername, responses|null, lastActivityDateUtc,
  source, identityState and selected `sourceReferences` to the existing `/members`
  operation. Canonical IDs keep `agent:<uuid>`; report-only IDs use `report:<exact
  reported id>`. Native/source IDs are retained in paginated memberships, never
  reconstructed from labels. `used` includes saved zero-response associations;
  creation/ownership/modification use their separate saved person facts.
  `counts={total,distinctAgents,returned}` count evidence edges and distinct
  identities separately. Missing userAgents evidence gives `relationshipState:
  "unavailable"`, `missingReasons:["userAgents_report_missing"]`, null totals,
  not an empty complete success. Inventory-only creation still works.
- Champions use the existing exact portal rank and eligibility, max3. Their
  created/used projection includes full authorized associations, report-only and
  non-organization/zero-response usage; the old department array still excludes/
  includes records under its original organization rules. The **group** page
  keeps its existing10-group cap; the new relationship page uses the ordinary
  shared50/default100/max, not a hidden10-edge clamp or MCP-specific default.
  Both HTTP handlers and the shared relationship service reject non-integer
  limits and values outside 1–100.
  Returned company/department are actual saved labels, not their `~string:`
  wire encodings; a missing champion name remains null.
  Source references lead to full About/configuration on the same pinned inventory.
- `AgentAboutPage` carries recordId, exact sourceScopeId/sourceIdentity,
  generationId, field, `state=available|missing`, source, observedAt,
  `provenance={path|null,maturity:ga|preview|observed|unknown}`, text|null,
  totalBytes, returnedBytes, nextCursor and selection metadata. Exact source
  membership is mandatory; no source404, ambiguous source409. Text segments are
 16384 PostgreSQL Unicode characters, no split surrogate pairs. Ordinary HTTP
  output remains524288bytes. The existing4MiB per-field and16MiB saved-component
  work bounds still apply; over-bound text rejects explicitly. Text over16384
  UTF-8 bytes is retained in bounded ordered existing `about:long|native|short`
  child facts; small saved residuals remain compatible. The provider transport
  validator is unchanged and distinct from the authorized saved validator.
  Native `properties.description` is observed, not asserted GA. Missing
  provenance stays unknown. Sections/children remain the saved configuration
  authority; no raw transcripts, instructions, diagnostics or archive endpoint.
  Existing selected inventory CSV child rows retain these exact three About
  kinds as ordered `childKind,childOrdinal,childData` records, with the same
  source identity/generation context and export bounds. Summaries are not a
  substitute for complete text; no new export columns or origin semantics.
  Adoption descriptions are bounded2048-character **previews**, including saved
  chunked text, not false absence or a substitute for full About.
  The existing About browser flow preserves long/native/short fallback for
  completely empty fields, but never skips an available multi-segment field
  because its first segment is whitespace. Continuation uses its returned exact
  source, not a newly chosen source. Ordinary adoption group responses keep their
  1,048,000-byte envelope; SQL people/agent details each fetch at most16,385 rows
  and reject the16,385th sentinel with413 `adoption_page_too_large`, never partial
  success. A complete16,385-item DTO cannot fit that existing envelope.
- Optional history comparison metrics carry `source:"agents"`, cohortHash,
  `cohortKind:"report_agent_associations"` and coverage `{expectedAssociations,
  matchedAssociations,ambiguousReportRows}`. This is an association cohort, not a
  claim of a fixed human/license population. Complete unambiguous Agents coverage,
  matching cohorts and known same-provenance equal-length ordered nonoverlapping
  windows are necessary. Unknown metrics/coverage/associations/windows withhold
  deltas and percentages; changed cohorts, overlap, unequal windows and differing
  provenance are explicit. Imports are never summed across windows. Agents and
  userAgents/Users metrics remain separately sourced, including disagreements.
  Both UUIDs are required together and must belong to the pinned retained history;
  absent snapshots404, source/history invalidation409.

The SQL owners are existing `LargeTenantUsersReports`/`reportRelationsSql`,
`InventoryQueries`, `adoptionDataset`, `OfficialAgentUsage`/`readAgentHistory`,
with one small `SavedReadContracts` composition owner. Queries use existing
directory UPN/name, report fact/membership, source/canonical membership, person
fact and generation/identity/kind indexes. Saved composition adds no warehouse,
classification registry, scheduler, queue, provider operation or MCP package.
Normal startup verifies only. Backend/frontend share the same DTOs, errors,
About continuation and adoption preview semantics.
The existing export SQL owner includes the three ordered About child kinds;
origin/audit/export metadata and trust semantics are shared across consumers.
Use current focused tests to verify affected contracts.

## Administrative audit origin v1

```ts
type AttributionField = {
  value: string | null; evidence: "authenticated" | "reported" | "unknown";
};
type AuditOriginV1 = {
  version: 1; channel: "webapp" | "mcp" | "unknown";
  integrationClientId: string | null;
  client: { id: AttributionField; name: AttributionField; version: AttributionField };
  callingAgent: { id: AttributionField; name: AttributionField };
  requestId: string | null; mcpCallId: string | null;
};
```

All fields always present. Unknown means null plus unknown evidence; non-null
fields cannot claim unknown. Channel/integration app are API-derived from the
verified transport/registration, never headers. Browser integration ID is its
validated tenant API client; browser code-owned name/version can be authenticated
only if server-derived. Unknown historical attribution uses channel unknown,
all IDs/labels/traces null. Do not backfill guessed webapp.

Each label/id <=256 Unicode scalar characters, version<=64, control-free valid
Unicode, whole serialized descriptor <=4096 UTF-8 bytes; malformed inputs reject
with400, missing inputs become explicit unknown. API requestId is its generated
UUID, never supplied text; MCP call ID is normalized JSON-RPC integer/string
trace <=128 `[A-Za-z0-9_.:-]`, otherwise null. Do not retain protocol session IDs,
OAuth connection handles, prompt text, bearer credentials or arbitrary `_meta`.

Transport: one bounded `X-Agent-Control-Mcp-Context` base64url UTF-8 JSON header,
only on an authorized bearer integration, containing version1, optional
client id/name/version, callingAgent id/name and mcpCallId. No channel,
integrationClientId, evidence or requestId accepted from caller. Browser sending
this header does not become MCP; reject. API assigns **reported** to supplied
labels/IDs and validates size/grammar. 05 uses only allowlisted initialize
`clientInfo.name/version`, namespaced request `_meta["com.agentcontrol/origin"]`
for optional caller labels and actual request ID. Missing agent identity remains
unknown. Client context is not an authorization/target/receipt input.

FastMCP4.1.0's **default** AzureProvider returns the upstream verifier's
`client_id` (Entra `azp`, the integration app). The implemented provider also
verifies the reference JWT using public `jwt_issuer.verify_token`, preserves
its verified downstream OAuth/DCR `client_id` as the SDK transport owner, and
retains the original upstream JWT/claims unchanged for OBO. SDK session ownership
therefore binds both signed-in user and downstream credential, including when
two clients use the same user. This opaque authenticated client ID is separate
from optional reported vendor/agent labels; it does not prove Claude/Copilot/
cowork identity or a calling agent. `Context.client_id` remains reported meta,
not authority. `origin_header` reads public request-local `Context.request_context`
and `Context.session.client_params.client_info`; it never uses last-caller state.
The API still assigns **reported** to every forwarded descriptor label/ID.
No new authenticated-origin header, identity registry or trust widening exists.

Provenance captures the first **accepted execution submission**, transactionally
with job/stage handoff, not the preview generator. A web preview followed by MCP
execution has MCP origin. Requested/started/completed append events, bulk
children, dispatch, readback, retries and recovered jobs retain that immutable
initiator. Same idempotency key returns original origin even from another
current transport; origin labels cannot change operation hash. Resume/cancel/
reconcile by another client preserves initiator and appends a separate lifecycle
entry with its own resumer/request context. No late status polling overwrites it.

### Stores, writers, exports, current schema

| Existing surface | Origin implementation owner / exact impact |
| --- | --- |
| `audit_events` append + `audit_projection` latest event | Bounded origin in both projections; AuditLog append/list/count/export preserve and filter provenance under append-only grants and 90-day visibility |
| Direct SQL `officialReportImports` / `official_usage_audit` | Upload acceptance stores immutable `official_usage_ingestions.origin` in its first transaction; detached receive/finish callbacks retain that origin for staged/replaced outcomes. Later accept/select/delete/discard/cancel use their own context. No credentials or invented historical actor labels |
| Direct SQL `jobs.ts` + `inventoryMutationStages.ts` | Immutable accepted origin survives stage/job submission, batching, item readback/recovery and queued replay |
| `copilot_quarantine_jobs/items` + `copilot_quarantine_audit` | Existing quarantine append/list and control/canary/reconcile writers retain the same origin contract |
| `data_exports` actor/job + `reportExportAudit` | Accepted export initiating actor/origin survives dispatcher restart and identical replay; downloads and cancellation have distinct current-request events, not another build/provider write |
| `defender_hunting_jobs` + hunting worker | Accepted submission stores immutable reduced initiating actor and origin before dispatch. Fresh execution authorization cannot replace them; historical origin remains unknown |
| `purviewAudit`, `defenderHunting`, `unifiedAgents`, `officialAgentUsage` route audit and CSV | Existing local administrative start/complete writers inherit verified request context; keep Microsoft source actor/appIdentity metadata distinct. Configuration writes without an existing audit producer do not acquire a parallel writer |
| `backend/scripts/database.ts` restore/retention/runtime grants | Current-only construction/grant/projection verification; explicit separately approved reset only, no widening UPDATE/TRUNCATE on append stores; retention unchanged |
| `frontend/src/api/client.ts`, `AuditLogView.tsx`, audit details and CSV | Shared Origin/client/agent fields and typed filters; CSV retains evidence and spreadsheet escaping; unknown attribution remains explicit |
| `inventoryQueries` operationIdPrefix and audit matching SQL | Same scope/90-day/literal grammar; origin filters never change target matching/provider authorization |

The existing audit GET and quarantine list contracts accept `originChannel`,
exact `originIntegrationClientId`, `originClientId`, `originCallingAgentId`;
list and count use the same private predicate. IDs are literal equality, never
wildcard name matching. The CSV includes version/channel/integration, each
client/calling-agent value and evidence, and both trace IDs, using the existing
spreadsheet-formula escaping helper. The existing web audit view has an Origin
column and keyboard-accessible details; channel/exact-ID filters participate in
URL, query cache, page reset and export-selection invalidation. Explicit unknown renders Unknown /
historical, not webapp. No audit event-specific API currently
exists: details use returned events; do not invent a second read authority.
All three existing append stores have bounded non-null checked origin. Six
durable stores (package jobs, stages, quarantine jobs, exports, hunting jobs,
upload ingestions) retain it; stages transition only with their same private
job's accepted transaction. Append identity/origin cannot change across status
events. Fresh initialization installs the sole current constraints, private
channel indexes and projection/grants. Startup remains
verification-only. There is no separate origin warehouse, MCP dependency,
migration framework or collector;05 consumes this contract.

## Web regression and manual handoff

This section completes the **same** operation map above, not a second route
catalog. Every method/path row inherits its authority and proof family below.
`mcpContractFeasibility.test.ts` compares the route rows with actual registrations,
roles and capabilities; its frontend AST checks compare HTTP **methods and
paths**, including report adapters, and reject frontend fetch bypass/MCP/provider
transport. These checks prove wiring, not every business outcome. Existing
adapter tests capture HTTP requests; the named SQL/HTTP/browser suites prove
behavior. Record actual outcomes and unavailable infrastructure for the revision
being tested; previous results do not establish current live behavior.

Transport classifications are authoritative in `routes/policy.ts`: `P` public;
`C` cookie-only; `D` declared shared delegated operation, with browser
Origin/CSRF unchanged. A future tool name is not blanket bearer authority:
application mode, administrator configuration, uploads, automation and
downloads remain cookie-only. Static `/assets` is public immutable content;
SPA/auth redirects are protocol boundaries, not business tools. Mixed
cookie/bearer is denied. Generic control adapters exist but no generic control
page/button is invented; explicit package/native UI keeps its original effect.

Proof paths below are relative to `backend/src/` (HTTP/SQL), `frontend/src/`
(component/adapter), or `frontend/browser/` (`.spec.ts`). All use existing
fixtures; none is live Entra/provider or user-acceptance evidence.

Real permission scenarios complete automatic initial synchronization when they
need an initialized workspace. First-visit cases observe automatic admission
and wait for all three durable source outcomes,
not just a dialog-title change. Synthetic empty Graph pages/CSV pass through
the real user-source parser, identity verification, staged publication and
authorization fences; no success markers are fabricated. CSV desktop/mobile
scenarios use their existing isolated synthetic tenants, retaining selection
admission bounds. Import success is verified before closing the current
`Close` control back to Sync. Saved tenant data remains readable for Viewer
during a permission-check outage; local Audit remains Admin-only.

CSV acceptance preserves the current report choice, including no active set
after earlier history. The first-ever accepted set becomes active; an empty
history page after prior deletions is not a new first publication. A rejected
correction must leave the captured active choice unchanged. The Admin may
explicitly choose its exact set; the Viewer sees read-only selected-report
context, not an editable Admin selector. Available-but-empty directory
evidence is distinct from unavailable evidence: unknown-license report users
remain excluded and counted as unknown, rather than becoming non-paid users
or an invented synchronization error.

Responsive tests retain all controls. At761–900px the bulk-selection
and Columns controls wrap below the inline query row without overlap; wider
desktops retain their compact row. Mobile agent tabs retain44px touch targets.
Loading skeletons are decorative under the existing busy-state semantics.

| Existing page / feature | Canonical rows above / transport | Actual consumer -> backend authority | Regression proof / executable manual check for04C |
| --- | --- | --- | --- |
| Setup/sign-in, callback errors, sign-out, session recovery | auth/status, auth/login GET/POST, callback, me, logout; P/C | App/startSignIn/getCurrentUser/signOut -> auth.ts, flows, MSAL, sessions | routes/authHttp, mcpApiAuth; App.signIn/App.session; signIn.spec.ts. Open configured origin, sign in/out, reopen an existing saved session after restart; no stale authority recovery. |
| `permissions`: Issues, App-defined roles, App registration permissions | capabilities/check/check-progress/probe/configuration; D except C configuration | PermissionCenter/useCapabilities -> capabilities route/service | routes/capabilities, services/capabilities; PermissionCenter/PermissionDetails; permissions/permissionLayout.spec.ts. Inline diagnostics, Check status, purple directly assigned roles, four groups/11 API entries, no shortcut bar or automatic consent/hunt. Microsoft API guidance excludes local app-role requirements; deferred investigations are hidden. Configuration API has no current UI adapter. |
| Navigation, history and unavailable/error gates across workbench pages | workbench/metadata/jobs, SPA deep links; C metadata, D jobs, P SPA | App/workbenchRouting/savedQueries -> workbench.ts | workbenchJobs, workbenchRouting/App.session; cacheNavigation/layout/dialogFocus.spec.ts. Back/forward preserves filters, retained-tab state and focus without repeating provider work. |
| `agents`: catalog/additional/all selection, search/sort/facets/creation/access/management/platform filters and authoritative cards | agent-inventory selections/list/health/summary/facets; D | agentInventoryQueries/useInventoryHealth/AgentInventoryOverview -> inventoryData/InventoryQueries | largeTenantInventory, mcpReadContracts; agentInventoryQueries/LargeTenantInventory; agentCatalog/agentFilters/unifiedAgents/inventoryAcceptance.spec.ts. Browse all pages, exact cutoff stable, admin-permitted is not maker sharing, unknown is not zero. Summary API is retained; cards consume selected page summary. |
| Saved detail/About/environment/responsibility/configuration/versions/connector operations | detail/members/children/sections/about; D | UnifiedAgentDetailModal/AgentOverview/SavedAgentAbout/SavedAgentConfiguration/InventoryMembers -> inventoryData, savedReadContracts, saved facts | mcpReadContracts/inventoryExports; AgentOverview/SavedAgentAbout/AgentDetailPaging; agentContext/agentExperience.spec.ts. Read complete Unicode About, source-pinned continuation, explicit missing/partial and real technical IDs; hidden retained tabs do not duplicate visible fields. |
| Exact people resolution/directory access picker | agent-inventory/people/resolve, directory/principals and resolve; D | useAgentPeople/PrincipalPicker -> agentPeople/directory, existing capability/provider adapters | agentPeople/agentInvestigationHttp; useAgentPeople/PrincipalPicker; agentPeople.spec.ts. Saved view is provider-free; click Look up people explicitly, check unresolved identities and permission failures. |
| `users`: paid roster, licenses/plans, activity/cohorts, exact people and report-only users | copilot-usage/users, facets, unresolved-identities, resolve, object detail/plans/agents/agent-relationships; official-usage/users and children; D | useReportPage/UserDetailModal/CopilotUsersView/ReportedUserAgents -> officialReportData/LargeTenantUsersReports/savedReadContracts | dataPages/mcpReadContracts/largeTenantUserSources; LargeTenantUsersReports/ReportedUserAgents; copilotUsers/userDetails.spec.ts. Search/filter/page then drill down; unpaid/concealed/ambiguous/missing remain distinct. New exact relationship adapter is API-backed, not a replacement for the existing UI responsibility route. |
| Person responsibility and exact modal links | agent-responsibility; D | UserAgentResponsibility/useAgentPeople -> inventoryData/InventoryQueries | largeTenantInventory; UserAgentResponsibility/App.session; agentResponsibility.spec.ts. Separate created/owned/modified associations, exact person,0 edges legitimate, explicit invalidated-cursor reload. |
| Adoption/champions, company/department filters | copilot-usage/adoption/facets/champions; D | AdoptionView/readChampionAgents -> adoptionGroups/savedReadContracts | mcpReadContracts/adoptionGroups; AdoptionView; adoption.spec.ts. Portal top3 unchanged; department list includes nonchampions; shared champion adapter enumerates only champion relationships across all pages. |
| Usage, report identity association/repair and retained-window comparisons | inventory usage/usage-history/usage-associations/usage-candidates; D reads, C association writes | AgentUsagePanel/reportData/OfficialUsageHistoryPanel -> officialReportData, officialAgentUsage/History | agentUsageHistory/mcpReadContracts/officialUsageHistorySelection; AgentUsagePanel; agentUsageHistory/agentActivity.spec.ts. Keep exact report set; compare overlap/unknown/unequal windows without invented growth; association repair requires confirmation/current revision. |
| Report snapshot inspector/aggregates/bridge/overview/observations | official-usage aggregate/facets, agents/users children, agent-users, history/options, overview, observations; D | ReportingView/reportPages/OfficialUsageReportSelector -> officialReportData/LargeTenantUsersReports | dataPages/officialReportReads/officialUsageViews; OfficialUsageSnapshot/OfficialUsageViews; officialUsage/cumulativeUsage.spec.ts. Switch retained set explicitly, preserve source-specific totals and discrepancy, read complete pages. Bridge remains API-only, no new page. |
| `sync`: CSV upload/diagnostics/drafts/bundle acceptance/correction | official-usage staging/diagnostics/bundles; C | OfficialUsageImportPanel/stageReport/previewReportBundle/acceptReportBundle -> officialReportData/officialReportImports | officialUsageCsv/officialUsageImports/officialReportStream; OfficialUsageImportModal; csvUsageReports/reportSets.spec.ts. In isolated approved data only: upload supported CSV, inspect warnings, cancel/discard, verify uncertain acceptance without duplicate upload. Production defaults read-only absent separate approval. |
| Report management/shared selection/deletion | sets preview/confirmations/history; C writes, D history | OfficialUsageManageReports/previewReportOperation/confirmReportOperation -> officialReportImports | officialUsageImports/officialUsageHistorySelection; OfficialUsageManageReports; reportSets.spec.ts. Select/delete only exact approved synthetic data; source revision invalidates old selections. No customer write implied. |
| Selected CSV export, polling/cancel/authorization-wait/expiry/native download | data-exports POST/GET/DELETE/download; C | ReportExportButton/reportData -> dataExports/inventoryExports/reportExportDispatcher/reportExportAudit | dataExports/inventoryExports/reportExportAudit; ReportExportLifecycle; savedReadLifecycle.spec.ts. Export pinned all-matching/explicit references, full About child rows, native download (no Blob), cancel/reauthorize with same intent; no partial CSV success. |
| Sync initial/incremental/full/confirmed clear saved data/history | data-sync state/runs/retry/cancel; D, explicit C browser automation | DataSyncPanel/SyncHistoryView/getDataSyncState/startDataSync -> dataSync route/service | automaticRefreshIntegration/dataSyncPersistence; DataSyncPanel/SyncHistoryView; dataSync/savedBackendLifecycle.spec.ts. Ordinary saved read does not refresh; explicit refresh preserves accepted reports. Full clear is isolated-only manual write. |
| Existing visibility/due-check browser automation | data-sync/auto-refresh; C | useAutomaticRefresh/checkAutomaticRefresh -> existing dataSync scheduler admission | automaticRefreshIntegration/automaticRevisions; useAutomaticRefresh; automaticRefresh.spec.ts. Preserve existing due behavior without adding automatic refresh to saved handlers or exposing it as a tool. |
| Package refresh/detail enrichment and native refresh jobs/target pages | agents refresh-jobs/exact/refresh-selection/targets/resume/cancel; inventory refresh-jobs/resume/cancel; D | AgentSyncTools/InventoryRefreshTargets/PowerPlatformSourceJob/PackageDetailsSyncPanel -> existing packageInventory/powerPlatformInventory/InventoryRuntime | inventoryRuntime/packageInventory/powerPlatformInventory; InventoryRefreshTargets/PowerPlatformSourceJob; dataSync/jobs.spec.ts. Explicit start, partial/errors/expiry/restart pause, exact target pagination and separate current authorization. |
| Explicit package block/unblock/single/all matching | mutation-selection/preview, block/unblock/block-all/unblock-all, bulk jobs/items/cancel/resume/reconcile; D | BulkActions/PackageManagement/BulkJobItems -> inventoryMutations/bulkJobs/jobs | inventoryMutationStages/sharedAgentControls/bulkJobs; BulkActions/PackageManagement; bulkActions/packageConfirmation.spec.ts. Preview exact targets, explicit confirm, already-state skip,0 pending after verified settlement; sent-unknown uses read-only provider reconciliation, never replay. Live mutation needs separate approved disposable target. |
| Explicit package availability/installation access | package access PATCH, bulk access/preview, directory lookup; D | AgentAccessManagement/AccessAssignmentModal/PrincipalPicker -> inventoryMutations/packageInventory | packageAccessPreservation/packageCanaryAuthorization; PackageManagement/AccessAssignmentModal; inlineAgentManage.spec.ts. Opening editor is read-only preparation; preserve unselected existing principals, specific/none semantics and exact prestate. |
| Explicit native Studio quarantine/unquarantine/status/audit/reconcile | quarantine preview/jobs/status/cancel/resume/reconcile/audit; D | CopilotStudioQuarantineControls -> copilotStudioQuarantineControl/Jobs/Repository | sharedAgentControls/copilotStudioQuarantineJobs; CopilotStudioQuarantineControls; permissions.spec.ts plus API provider fixtures. No package dispatch is silently added; unknown identity/status denies. |
| Generic exact controls (API-only; no generic UI) | agent-controls preview/execute/status; D | AgentControls and existing child authorities; no browser adapter | sharedAgentControls/agentControlReceiptsSchema; exact receipt/expiry/partial/idempotency and initiator provenance through API fixtures |
| Retained Purview investigations and identity resolution (UI/setup hidden) | investigations/context/resolve, audit-search jobs/records/resume/cancel/delete; transport policy remains current-source authority | Retained AgentInvestigationsPanel/UserPurviewAudit/PurviewAuditView -> agentIdentityResolution/purviewAudit | agentInvestigationHttp/purviewAudit; explicit curated query, exact typed identity, private delegated or configured application sharing. Not current Permissions prerequisites; saved reads make no provider calls. |
| Retained Defender hunting/history/rows/recovery (UI/setup hidden) | hunting jobs/rows/catalog and lifecycle; transport policy remains current-source authority | Retained DefenderHuntingView/AgentInvestigationsPanel -> defenderHunting/GraphHuntingClient/repository | defenderHunting/agentInvestigationHttp; current identity/configuration/owner scope, explicit hunts, partial/unobserved ranges and Viewer-capable shared reads. Not current Permissions prerequisites. |
| `audit`: Admin-only tab/page, search/action/status/Origin/caller filters/details/selected CSV | audit/events: Admin read; export.csv: browser-only Admin with CSRF | AuditLogView/workbenchRouting/getAuditEvents -> audit/AuditLog | auditOriginHttp/actionOrigin/auditOrigin; AuditLogView/workbenchRouting/client; auditOrigin.spec.ts. Viewer/Uploader have no UI/API access. Historical unknown, reported labels inert, initiating origin immutable, current lifecycle separate; CSV matches displayed selection and escapes formulas. Recording is unchanged. |
| Operational metadata, canaries and API-only boundaries | diagnostics, package/native canaries, capabilities/configuration, native related/quarantine-selection; C where declared | current policy/services | policy/mcpApiAuth/packageCanaryAuthorization; command mocks. Diagnose without provider work; optional canaries require exact target authority. |

Current canonical registrations are not aliases. Presentation-only formatting, ranking displays,
selection state and CSV download UI remain frontend; SQL metrics, joins,
source scope, provider effects and durable job/audit writers remain API-owned.
The current-only schema/reset/recovery contract is above.
The real operator image must contain the current schema, database/reset and
backup owners. Packaging tests alone cannot establish live correctness.
The release operator verifies actual source/image identities, current route/
schema/DTO contracts and working user journeys.

Automatic-sync recovery repairs a stale aggregate from the existing child
source statuses before deciding whether more work is due; it does not recollect
already-fresh sources. After export-dispatcher replacement, persisted queued
work without request credentials reports `authorization_required`. The existing
**Authorize and resume export** action resubmits the same idempotent intent;
polling alone does not reacquire authority. Cancelling a ready export records a
separate successful `cancel-control` lifecycle event without rewriting the
successful initiating build. A provider-token failure can deny the initiating
request while retaining a durable waiting job; a fresh authorized saved-status
request remains provider-free.

## Synthetic workflow corpus and test isolation

Phase 09 executes the shared
[`mcp-workflows.json`](../backend/scripts/fixtures/mcp-workflows.json) corpus
through SDK HTTP/OAuth clients, actual browser adapters and canonical SQL/web/
bearer owner tests. See [client-specific onboarding, complete recipes and proof
boundaries](mcp-clients.md) and the [current completion evidence](../plans/fastmcp-integration/completions/09-client-workflows-and-evaluation.md).
This is not a production workflow engine or a vendor/model certification.

Fixture domains `example.invalid` only, no customer
data. Tenant T=`11111111-1111-1111-1111-111111111111`; other tenant
`44444444-4444-4444-4444-444444444444`; API app
`22222222-2222-2222-2222-222222222222`; MCP app
`33333333-3333-3333-3333-333333333333`. Native user local/home UID
`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, home tenant T; guest local
`bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`, home UID
`cccccccc-cccc-cccc-cccc-cccccccccccc`, home tenant
`dddddddd-dddd-dddd-dddd-dddddddddddd`. Guest key is `cccc....dddd...`,
**not** guest `bbbb....1111...`. Other-principal/tenant/cursor reuse rejects.
Names deliberately duplicate; report-only usernames are not directory keys.

| Case | Exact data and expected useful result |
| --- | --- |
| A | `alex@example.invalid`, exact objectId `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, 103 agents `agent:10000000-0000-4000-8000-000000000001` through suffix`000000000103`, duplicate label `Shared name`. SQL inventory pages100+3; SDK used-relationship pages50+49 (98 canonical006..103 plus report-only `report:P_report_only`), created=001..003, owned=004..005, modified=005. All source associations and Unicode long101/native102 About continuations are exact; About103 stays missing. No guessed UPN/report linkage; native/guest private home-account keys remain distinct. |
| B | company`Example Company`,department`Research`; five people p1..p5 (`20000000-0000-4000-8000-000000000001`..005). (created,responses,used): p1=(3,10,2),p2=(2,50,2),p3=(2,20,7),p4=(0,100,1),p5=(0,null,0). Champions p4,p2,p3 in that order; p1's `P_extra_9` excluded from champions-only result, not the department list. Report sets `30000000-0000-4000-8000-000000000001`..005: Jan1-30 responses100; Jan16-Feb14 responses120 (overlap); Mar1-30 responses150; Apr1-7 responses40 (unequal); undated null. All operator_asserted except undated unknown; Jan->Mar comparable50% snapshot increase, Jan->overlap/Jan->Apr/undated not growth. Separate Agents/bridge totals100/97 stay discrepant; licensed/unlicensed7/3 not total10. |
| C | selected evaluatedAt`2026-01-31T00:00:00.000Z`,createdWithinDays30 ->cutoff`2026-01-01T00:00:00.000Z`. 101 eligible exact records across100+1 pages; created at boundary included,1ms before excluded even modified/collected/imported Jan31; unknown creation excluded. Existing any-source semantics preserved. Both explicit package and generic Studio actions tested in both directions in04A: package ID`T_pkg_001`; Studio native`studio-agent-001`,environment`40000000-0000-4000-8000-000000000001`,bot`50000000-0000-4000-8000-000000000001`. Interactive waits after exact preview; externally scheduled execution does not. Expired hash, changed membership/prestate, revoked authority, duplicate key, one failed child and sent-unknown outcomes remain explicit, no blind retry. |

Fixtures execute bounded corpus/SDK/parser/projection/cursor behavior, direct
interactive confirmation/reconfirmation pauses, an external scheduled receipt
without a human pause, attribution isolation, explicit provider-work submission,
denial/challenge/refresh/revocation/reconnect, not live vendor controls. Actual
tool traces measure complete-page calls/bytes/time; client/server descriptions
are not consent proof. Current API HTTP/SQL parity remains authoritative.
No production fixture-auth route, synthetic
import into customer reports, latest/shared selection change, broad sync, real
bulk canary or production reset.

Commands from repository root:

```sh
npm run test --workspace backend -- src/routes/mcpContractFeasibility.test.ts
npm run typecheck --workspace backend
npm run check:unused
cd mcp && .venv/bin/pytest tests/test_onboarding.py tests/test_workflows.py
```

Existing DB/browser contracts (only for changed DB/UI owners):

```powershell
pwsh ./scripts/large-tenant-tests.ps1 -Suite inventory-integration
pwsh ./scripts/large-tenant-tests.ps1 -Suite lifecycle-read-contract
pwsh ./scripts/large-tenant-tests.ps1 -Suite cutover-browser-contract -BrowserFiles savedBackendLifecycle.spec.ts,savedReadLifecycle.spec.ts,inventoryAcceptance.spec.ts,cacheNavigation.spec.ts
```

Read [validation](operations.md#validation)
and `scripts/large-tenant-tests.ps1`, `scripts/local-deployment.ps1`,
`compose.large-tenant-test.yaml` before invocation. The runner rejects inherited
PG/APP_PG/TENANT/CLIENT/SESSION authority, requires a pinned preinstalled baseline
image/manifests, creates only unique `agent-control-ltdp-<guid>` resources under
`artifacts/large-tenant-data-platform/<guid>`, and owns exact Compose/purpose
labels plus `<project>-data` mount. Cleanup verifies ownership first and removes
only those resources, no prune. Never target `seha` DB/ports/volume/settings.
The contract-feasibility Node fixture opens no DB, listener or provider transport.

## Configuration and secret ownership

Tenant integration binding remains API configuration. The `MCP_*` names below
are implemented service configuration. Phase08's optional Compose lifecycle and
phase10's Azure source tooling do not establish a live deployment.

| Name | Owner / contract |
| --- | --- |
| Tenant `integration` inside existing `TENANTS_JSON` | Optional strict object `{clientId:<MCP UUID>,audience:<API UUID>,scope:"AgentControl.Access"}`; absent disables bearer; exact tenant/API binding |
| `MCP_TENANT_ID`, `MCP_CLIENT_ID`, `MCP_API_CLIENT_ID` | 05 exact GUIDs, separate registrations, no email/argument tenant routing |
| `MCP_API_ORIGIN` | 05 one exact allowlisted API origin, no caller URL; Compose internal transport still binds external identity correctly |
| `MCP_PUBLIC_URL` | 05/08/10 approved canonical HTTPS resource URL/mount and callback; no guessed loopback origin for remote clients |
| `MCP_SECRET_SOURCE` | `files` by default; explicit `app-service-key-vault` accepts only resolved native references and the leased encrypted Blob profile, never a fallback |
| `MCP_CLIENT_SECRET_FILE` | MCP confidential/OBO credential, operator-owned mounted secret; never API/provider credential |
| `MCP_JWT_SIGNING_KEY_FILE` | independent MCP signing key, operator-owned; do not derive from client secret |
| `MCP_OAUTH_ENCRYPTION_KEY_FILE` | independent MCP storage-encryption key, operator-owned; rotation/restart proof05/08/11 |
| `MCP_OAUTH_STORAGE_PATH` | Local/direct/Compose only: dedicated non-root0700 directory `/var/lib/agent-control-mcp/oauth`; protected FileTree plus authenticated encryption for all OAuth state; forbidden in Azure profile, never app DB/data volume |
| `MCP_AZURE_CLIENT_SECRET`, `MCP_AZURE_JWT_SIGNING_KEY`, `MCP_AZURE_OAUTH_ENCRYPTION_KEY` | Azure-only native Key Vault reference outputs in memory; independent values/versions, no simultaneous `*_FILE` inputs or raw CLI parameters |
| `MCP_AZURE_BLOB_ACCOUNT_URL`, `MCP_AZURE_BLOB_CONTAINER`, `MCP_AZURE_BLOB_NAME` | Azure-only exact HTTPS `*.blob.core.windows.net` account, dedicated private container and prepared `oauth-state.v1.fernet` object; all writes require its lease plus ETag |
| `MCP_AZURE_IDENTITY_CLIENT_ID` | Azure-only exact UAMI client ID; explicit ManagedIdentityCredential, no default/user/environment chain or storage keys |
| `MCP_ALLOWED_CLIENT_REDIRECT_URIS` | JSON exact approved callbacks including exact loopback port/path; no wildcard/port-agnostic patterns; empty denies; no AzureProvider permissive `None` default |
| Existing `TENANTS_JSON_FILE`, `SESSION_SECRET_FILE`, PostgreSQL secrets | remain API-only, unchanged; MCP receives no DB/provider secret/cache/access |

No standalone API provider secret or token cache persistence. File storage alone
is plaintext, so 05 supplies the SDK-supported encrypted store using the
independent encryption key, not default auto-derived signing/encryption.
One MCP instance. Optional Compose uses a dedicated OAuth volume while retaining
current `app/postgres/seha_data`. The three `*_FILE` settings are local-file-mode
inputs, not Azure native-reference inputs.
Azure10 retains Node24 App Service and supports a separate Linux container App
Service with immutable image digest and one bounded encrypted state Blob.
One worker is capacity policy, not exclusivity: the maintained Azure SDK leases
the exact data object, every mutation carries that lease and ETag, and lost/
unknown ownership fails closed for reads, issuance and publication. No stale
cache, unfenced separate key/object or auto-reacquisition/replay exists. See the
[Azure contract and remaining cloud proof](azure-production-deployment.md#prepared-identities-storage-and-network).
No Redis/autoscale/second application DB/queue. Lease/key rotation/backups/
callbacks/streaming are executable/live obligations, not proof from this table.

Current-host target is `compose.yaml` via `deploy-local.ps1 -Project seha`,
`.local/seha`, `seha_default`, app/postgres and retained `seha_data`. Planning
target is not action approval or a tenant branch. 04C verifies origin/port/
Docker labels/image/schema/resources and exact intended maintenance actions.
08 extends the existing tooling for MCP;
10 validates Azure tooling, no live cloud rollout here. Remote ingress/tunnel,
Entra grants, tenant setup, key rotation and provider writes remain separately
subject to actual operator authorization. This document claims no host measurement.

## Dated primary sources and proof ownership

These SDK/source references support the proposed MCP design; verify the selected
package version when implementing it. Documentation describes constraints,
not live registration/guest/consent/client success.

| Source | Verified claim / remaining proof owner |
| --- | --- |
| [FastMCP4.1.0 release](https://github.com/PrefectHQ/fastmcp/releases/tag/v4.1.0), [AzureProvider source](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/auth/providers/azure.py) | Tenant/resource scope/JWKS/audience, callback/client redirect/signing/storage parameters; 05 pinned executable proof |
| [OAuthProxy source](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/auth/oauth_proxy/proxy.py), [dependencies](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/dependencies.py), [JWTVerifier](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/auth/providers/jwt.py) | Verified reference JWT -> upstream token swap; dependency returns it; upstream client ID is not downstream vendor identity; 05 protocol/redaction proof |
| [FastMCP storage](https://gofastmcp.com/servers/storage-backends), [OAuth proxy](https://gofastmcp.com/servers/auth/oauth-proxy) | FileTree sanitization required, file persistence is not encryption; explicit signing/persistent encrypted store; 05/08/10/11 restart/rotation/mount proof |
| [MSAL5.3.1 AccountEntityUtils](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-node-v5.3.1/lib/msal-common/src/cache/utils/AccountEntityUtils.ts), [ResponseHandler](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-node-v5.3.1/lib/msal-common/src/response/ResponseHandler.ts), [OBO client](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/msal-node-v5.3.1/lib/msal-node/src/client/OnBehalfOfClient.ts) | client_info home key versus sub fallback, account/local tenant metadata, supported OBO; synthetic SDK01, live guest/native05/12 |
| [Entra OBO](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-on-behalf-of-flow), [MSAL OBO](https://learn.microsoft.com/en-us/entra/msal/dotnet/acquiring-tokens/web-apps-apis/on-behalf-of-flow) | Assertion audience must equal middle-tier app, delegated scopes only; resource tenant for guest authority, claims challenge propagation; live Graph/Power Platform12 |
| [MCP2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | Protected resource/AS discovery, PKCE/resource binding, auth per request, no token passthrough, Streamable HTTP/SSE response/cancellation/Origin; 05/09/12 |
| [Python SDK public client_params](https://github.com/modelcontextprotocol/python-sdk/blob/754254c08fe1c3eda18b69da3d336106fe8d72d6/src/mcp/server/session.py), [FastMCP Context](https://github.com/PrefectHQ/fastmcp/blob/v4.1.0/fastmcp_slim/fastmcp/server/context.py) | `ctx.request_context.session.client_params.clientInfo` is reported initialize metadata; missing context/params stay unknown, request_id is safe bounded call trace; 05 rechecks exact installed SDK, no protocol package installed01 |
| [Copilot Studio onboarding](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent) (ms.date2026-05-28; updated2026-08-19) | Streamable HTTP only, OAuth discovery/DCR/manual connection; separate signed-in-user connection proof09/12, never maker shared-service identity |
| [M365 Copilot MCP plugin capabilities](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-type-mcp-servers) (ms.date2026-09-30; commit`f12c7f22717c1fe9aa3436b565d0146458db5c21`), [Studio overview](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp) | Remote MCP can be plugin capability; authentication/protocol support varies by host and certification does not prove every host. A Studio connection does not prove M365 Copilot/Agent365 user delegation; 09 separately tests signed-in user/channel |
| [VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers) | Remote HTTP configuration/discovery/auth support, actual VS Code/GitHub Copilot version/OAuth/refresh/confirmation proof09/12 |
| [Claude connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Claude API MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector) | Custom remote connector versus API bearer connector differ; support page modified2026-10-01; API token supplied by caller does not prove interactive OAuth; Claude web/desktop/code each tested09/12 |

Compatible cowork apps need their own versioned discovery/PKCE/streaming/
refresh/cancel/confirmation qualification. No universal-client claim, no
anonymous/API-key fallback. No source code, customer dataset, credentials or
workspace text sent to external research/client services. Public document path
404s do not justify an invented SDK feature.
