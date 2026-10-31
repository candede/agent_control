# Security model

The [MCP integration contract](mcp-integration.md) documents shared API
identity, bounded credentials, audit attribution, and browser/bearer boundaries.
Its feasibility fixtures are synthetic; unproven bearer identity remains closed,
and the existing browser authentication and source isolation stay authoritative.

The MCP catalog forwards each named operation through the
authenticated, request-local canonical API owner. Saved reads do not initiate
provider work; explicit collection/investigation tools remain delegated-only.
Exact control adapters use the same current Admin/provider authority, receipts,
prestate/readback and jobs as the browser. No app-identity fallback, arbitrary
endpoint or SQL/KQL input is registered. Returned source text is inert untrusted data.
Selection/source/revision continuations are explicit, and API errors never
trigger automatic recapture or POST/PATCH/DELETE replay. Tool annotations distinguish
saved reads from live lookups, submissions and exact confirmed local-cache
deletion. The60s/four-concurrent/eight-request/two-OBO/524288-output-byte ceilings
also cover cancellation and the final serialized result. Browser application
investigations keep their existing authorized configuration/shared-scope flow.
Stable idempotency keys never authorize automatic mutation retries. Uncertain
writes require saved status/items and explicit GET-only provider reconciliation.
Interactive clients must show the exact preview and ask current confirmation;
scheduled clients use the same current receipt without a human pause. MCP does
not attest to human intent or accept an approval/bypass flag. Accepted initiator
is immutable; each lifecycle request carries separate current attribution.
No optional canary or release/test artifact gates supported controls.

Agent Control uses Microsoft Entra ID for authentication, app roles for product
authorization, and provider permissions for Microsoft operations.

## Identity and tenant routing

Users enter a work or school username before sign-in. The exact configured
domain selects one tenant profile and Entra app registration.

- Unknown or overlapping domains are rejected.
- Each tenant has separate credentials and accepted domains.
- The verified tenant and account from Entra establish identity.
- Client-supplied identity headers are not trusted.
- Sign-in return targets must remain local application paths after URL
  normalization; network-path redirects are rejected.

See [deployment setup](deployment-setup.md).

## App roles

Agent Control has three app roles:

| Role | Access |
| --- | --- |
| `AgentControl.Viewer` | View tenant data and request read-only synchronization |
| `AgentControl.UsageReportUploader` | Viewer access plus new report-set uploads, validation, publication and own unaccepted-draft cleanup |
| `AgentControl.Admin` | Viewer/Uploader access plus published-report corrections/selection/deletion, supported controls, configuration and local Audit read/export |

Set **Assignment required?** to **Yes** on the Enterprise application. Assign
each approved user or group one role.
Use **Enterprise applications > Agent Control > Users and groups**. Uploader
includes Viewer; Admin includes both. Only Admin can see Audit or read/export
local administrative audit logs, including through direct URLs/APIs.
Audit recording is unchanged; this restriction is separate from retained
Microsoft Purview investigation authorization.
Saved administrative audit JSON rechecks the initiating account generation,
current scope and Admin role after its database reads, before publication.
Logout, superseding sign-in or revoked request authority withholds the response.
Saved inventory selections, availability, pages and detail reads likewise recheck
the initiating account generation, current scope and Viewer role immediately
before JSON publication, including after temporary health-selection cleanup.
Saved agent investigation context, explicit identity resolution, saved Purview
records and resolved people apply the same final Viewer fence after their
asynchronous reads and audit completion.

App roles do not grant Microsoft Graph, Power Platform, Purview, or Defender
access. Those providers still enforce their own permissions, roles, licenses,
policies, and data scope.

Standard Graph collection uses application read grants regardless of the
requesting user's Microsoft reader roles. User authentication and app-role/session
validation still apply to every request and publication. There is no delegated
fallback for package, people, license or Office app activity collection.
Power Platform and administrative provider changes retain delegated authority.
Defender/Purview entry points and setup are hidden in the UI only; their backend
authorization and stored evidence have not been removed or broadened.

## Shared exact agent controls

`POST /api/agent-controls/preview` and `/execute`, plus
`GET /api/agent-controls/:receiptId`, use the same registered Admin
handlers for verified same-origin browser sessions and the configured delegated
API bearer grant. Browser CSRF and mixed-credential rejection remain unchanged.
There is no caller-selected identity, permission bypass, API approval engine or
scheduler. Interactive confirmation and external scheduling are client workflows;
both submit the same current server receipt.

Generic Studio effects are quarantine/unquarantine only. Other exactly supported
agents use existing package block/unblock. Explicit package controls, including
Studio-linked package buttons, remain package-only; explicit Studio controls
remain distinct. Names, descriptions and reported origin labels never establish
provider identity or authority.

Private exact receipts bind tenant/home-account principal, authorization and
session epoch, selected source memberships/revisions, prestate, action, provider
effect, IDs/names and expiry. Ineligible/report-only/ambiguous targets are explicit
and never sent. First acceptance atomically fixes initiating actor/origin and the
stable key. Crash/replay recovers deterministic existing child jobs without
copying execution state; expiry prohibits admission of a missing child even
after parent acceptance. Current lifecycle attribution is separate. Mixed
providers are not atomic. Accepted, final and verified are distinct; existing
child status/items/recovery routes disclose authorization-wait and unknown
readback, and uncertain writes require read-only reconciliation, never resend.
The generic GET projects only retained accepted receipts and existing child
repositories; it is provider-free and cannot admit, resume or reconcile work.

## Tenant and account isolation

Saved provider data is partitioned by tenant and, where required, by the account
that collected or authorized it.

- One tenant cannot read or change another tenant's data.
- Private delegated evidence is not shared between accounts.
- Application-mode data is available only within its approved tenant scope.
- Exact current inventory identity is required before provider changes.

## Sessions

Sessions are stored server-side and use secure, HTTP-only cookies in production.
The browser receives only the information needed to render the signed-in
experience.

Role and tenant configuration changes require a new sign-in. Runtime checks also
reject sessions whose tenant or application binding no longer matches current
configuration.

Sign-in opens the new account generation only after session persistence succeeds;
failed or superseded sign-ins cannot reopen revoked authority. Account mutation
queues remain serialized while work is pending, including under cache pressure.
The 10,000-account cache limit evicts only idle entries; excess active entries
are pruned as their queued work settles.

## Browser request protection

State-changing browser requests require:

- a valid authenticated session;
- the required Agent Control role;
- same-origin checks;
- a current CSRF token;
- validated request data;
- explicit confirmation for provider changes.

Provider changes also recheck the exact target, current authorization, current
inventory authority, provider prestate, and provider readback.

## Delegated API foundation and canonical integration

The [current principal foundation](mcp-integration.md#current-principal-and-credential-foundation)
serves canonical routes, services and workers. It
uses exact tenant/API/client/scope-bound RS256 validation, bounded JWKS refresh,
and an actual SDK OBO exchange proving the existing private home-account key.
Guest resource object IDs are not home keys. Missing client info/account,
sub-only identity or contradictory metadata explicitly closes admission.
API roles come from the verified API assertion, never Graph roles or reported
client labels. An assertion older than five minutes cannot refresh its own role
evidence; a new API token is required.

The credential source is separate process memory. Job references are non-secret
and unusable after restart; expiry, changed epochs, revoked authority and claims
challenges require same-principal reauthorization. Account-wide revocation uses
the existing account/durable epoch authority; connection disconnect removes only
that source and later the MCP-owned OAuth connection. Internal fences are
immediate, including after awaited work; actual Entra revocation follows expiry,
Conditional Access/provider denial and challenge timing, not an instantaneous
external event. Phase 03 preserves existing pre-COMMIT epoch locks and browser
stored-session checks. These sources never serialize
assertions/provider tokens into sessions, jobs, audit, SQL or principal DTOs.
Fresh verified native/guest API issuance can reauthorize its exact private
principal after account revocation without portal sign-in. The existing durable
epoch row also retains a non-secret monotonic `bearer_issued_after` cutoff.
Assertions issued at/before that cutoff remain rejected, including after
restart or another fresh grant; same-second issuance requires a later token.
Recovery uses existing account mutation serialization, does not supersede valid
independent peer grants, and preserves old workers' captured generation/epoch.
The current DDL installs this cutoff directly. Synthetic native/guest fixtures
do not establish live consent or provider admission.

Both transports use the same registered handlers and authorization/data fences.
Only verified bearer authority bypasses cookie Origin/CSRF; mixed credentials
return `ambiguous_authentication` with no fallback. Public endpoints retain public
admission; browser-only boundaries reject bearer authority. Saved reads remain provider-free and browser saved
reads survive an empty process-local MSAL cache without inventing a local ID.
Nested operations inherit one initiating ephemeral source; new requests cannot
lend authority to already-running jobs. Expiry, stale issuance, revocation or
restart pauses work for explicit same-principal recovery. SQL exports retain
queued `authorization_required` state and require explicit idempotent resume;
partial files cannot be published. Uncertain sent provider writes retain their
existing reconciliation-before-resend gates. See the
[canonical integration contract](mcp-integration.md#current-canonical-integration).

## FastMCP OAuth state and recovery

The optional Python MCP service uses FastMCP4.1.0's AzureProvider/OAuthProxy
and verified public token context. A narrow provider validates exact tenant,
v2 GUID audience, delegated `Mcp.Access`, MCP `azp`, user identity and finite
times after SDK signature verification. It rejects raw upstream/API/ID tokens
as downstream credentials, app-only tokens and alternate assertion grants.
The fixed-tenant API OBO exchange uses only the recovered upstream MCP-audience
access token; the reference JWT never becomes an API assertion. API roles and
the existing private native/guest identity proof remain API-owned.
OBO responses require a string Bearer token type; malformed types return a
bounded reauthorization error without dispatching API work. Shared HTTP-client
authentication defaults cannot replace the adapter's per-request credentials.

The public SDK reference-JWT verifier establishes an opaque downstream OAuth
client ID independently of reported labels. It binds SDK transport sessions to
that client and verified upstream user, while preserving the upstream assertion
unchanged. Original signed `oid/tid/sub/azp` must remain identical after automatic
or explicit refresh; a changed identity requires reconnect. This is not a
vendor/agent identity claim. Reported initialize names/versions and namespaced
request labels remain untrusted API attribution, not authority.

Only OAuth connection material is stored. The SDK's FileTreeStore supplies
atomic writes/TTL/culling; its FernetEncryptionWrapper with maintained
cryptography MultiFernet supplies authenticated encryption. A public wrapper
rejects the SDK's plaintext-read fallback. All OAuth values, including DCR,
consent, code, tokens, binding and revocation state, pass through encryption.
The FileTreeStore's public key-sanitization extension hashes lookup names with
standard SHA256: OAuth codes must not appear as plaintext filenames. Non-secret
collection names, hashed lookup filenames and TTL metadata are not a
customer-data warehouse. MCP stores no SQL connection, provider token cache,
API assertions, jobs, audit warehouse, scheduler or application records.

Signing and encryption keys are independent protected files, never derived from
the confidential client credential. The dedicated storage root and descendants
must be owned by the service UID, directories0700/files0600, without symlinks;
startup sets umask0077 before the SDK creates files. Run one service instance/
worker with this volume, not shared multi-worker storage. The bounded store
admits at most4096 files/64MiB, with conservative write headroom and256KiB per
plaintext record. Use a dedicated OS/filesystem quota as an additional deployment
control. OAuth writes stop explicitly at capacity; do not redirect state to an
ephemeral directory or add Redis/SQL as a fallback.
Authorization-code consumption is serialized within that one process because
the file backend's individual atomic writes are not atomic get-and-consume.
Concurrent redemption still issues exactly one credential pair.

Reference access lifetime is900s. Refresh fallback and **every persisted entry**
are capped at86400s; known shorter expiries remain shorter. The SDK renews
upstream tokens within60s of expiry and checks upstream validity on requests.
Unrefreshed DCR registrations also expire within24h, requiring registration/
reconnect rather than indefinite forgotten state. Expired state is inaccessible
and culled on startup/readiness; no background scheduler is added. Back up only
the protected encrypted OAuth directory and independently escrowed keys, never
the API data volume into MCP. The encrypted binding sentinel detects a wrong
key ring or tenant/client/API/resource reuse before readiness. Invalid/corrupt
state does not become plaintext, an anonymous identity or an empty business
result.

Restart with the same binding, keys and persistent directory retains supported
OAuth connections and SDK refresh. An API assertion is reacquired per invocation
and never recovered from disk. Restart does not resurrect API worker authority.
To rotate encryption, stop/restart with `[new, previous]` (at most3 keys);
new writes use the first key and existing records remain readable. Keep the old
key through the maximum24h retained-entry lifetime and cull expired state before
removing it. There is no implicit decryption fallback or bulk re-encryption.
Signing-key rotation intentionally invalidates reference access/refresh JWTs;
old refresh credentials return `invalid_grant` without contacting Entra, and
clients reconnect using the same approved OAuth flow. Emergency encryption-key
replacement also requires reconnect and operator-controlled disposal of the old
dedicated OAuth state; no automated application-data reset is performed.

OAuth `/revoke` durably tombstones the exact presented reference and the SDK
removes refresh metadata. A client disconnect must revoke **both access and
refresh** credentials: each revoked reference fails immediately, including after
restart, and in-flight adapter work rechecks revocation after awaits. A refresh
revoked during its upstream await cannot publish newly issued credentials. Revoking
only refresh prevents renewal but does not revoke an independent outstanding
access reference; it expires within900s. Unreachable encrypted backing state is
retained only until its TTL/cull. Entra has no configured RFC7009 revocation
endpoint here; this does not revoke the tenant's consent or another connection.
Already accepted API work retains its own ephemeral expiry/internal epoch
fences; OAuth disconnect does not fabricate account-wide API logout.
Actual account-wide revocation remains the existing API epoch authority.
The provider explicitly enables the SDK's public revocation option (it is off
by default). A small form-boundary normalization supplies an empty optional
`client_secret` for public clients because MCP SDK2.3.0's revocation model
otherwise incorrectly requires the field's presence; the maintained SDK still
owns client authentication, token ownership and RFC7009 handling.

Public health/readiness expose status only; authenticated diagnostics expose
non-secret service/protocol/storage metadata and the opaque authenticated OAuth
client ID. Problems are bounded and redact credential fields/JWTs; OBO errors
expose only bounded standards-defined claims challenges or safe cooldown.
Challenges accept only the API's `access_token` object and the same bounded
claim-name/`essential`/`value`/`values` grammar; ID-token or arbitrary diagnostic
objects are discarded while the reauthorization error remains explicit.
Expected readiness storage errors emit a non-secret operator error and503;
unexpected implementation errors are not silently converted into storage status.
Token-refresh and API-OBO outages remain503/504, not a destructive invalid-grant
classification; a valid refresh can recover after the outage. Callback failures
preserve the SDK's error status but replace provider diagnostic text with a safe
restart instruction; error redirects contain only normalized OAuth errors.
OAuth endpoint handling has a30s wall deadline, separate from request-body limits.
Callback responses are non-cacheable. API requests
explicitly request identity encoding and reject compressed bodies before
decoding, preserving the finite response budget.
Secrets, raw provider bodies, prompts and protocol session/connection handles
must not enter audit labels or diagnostic output. Local tests are synthetic SDK
proof, not live consent, external revocation timing or real client compatibility.
The package disables SDK dotenv discovery and native telemetry through its
supported environment switches before importing FastMCP.
The pinned SDK logs rejected OAuth codes verbatim at ERROR. A standard Python
log-record factory therefore normalizes SDK authentication messages/tracebacks
before any handler sees them, retaining severity, module and source location
without credential-bearing text. Uvicorn access logging is disabled so callback
query credentials are not logged.

## Provider credentials and permissions

Delegated tokens are acquired for the signed-in account only for Power Platform,
management and deferred investigations. Standard package, people, user/license
and Office app activity reads use application permissions and configured tenant
credentials automatically. Only optional deferred application investigations
retain separately configured enablement/shared scope.

Agent creator/owner identity enrichment uses a tenant-owned saved cache, separate from the license-reporting roster. All Viewer-capable roles share those labels without user directory permissions. The CSRF-protected resolver accepts only an authorized saved agent record, derives exact referenced user IDs server-side, and uses `graph.users.read` with application `User.Read.All`. Explicit Users sync also resolves referenced accounts outside the licensed cohort, with at most eight concurrent lookups, a two-minute deadline covering saved reads, authentication, provider work and publication, and a 100,000-reference limit applied only to exact native user IDs. Authorization or throttling stops further lookups without erasing collected license data. The initiating session and capability are rechecked through transactional publication and the final current-membership read; reset and active-job fences remain independent of tenant ownership. Timed-out or revoked callers cannot publish late results. Only bounded identity labels, exact IDs, timestamps, collector attribution and normalized outcome codes are persisted; raw Graph bodies are not retained. Resolved, not-found and failed observations expire after seven days, one day and fifteen minutes respectively. Failures may retain previously known labels with their original observation date, but never assert deletion. Licensed snapshots additionally retain nullable company/department attributes under the tenant snapshot scope and retention.

Only directory generations matching the current scope and session epochs exclude referenced accounts from agent-people lookup; invalidated license rosters do not suppress enrichment. Direct people resolution and reference refresh pin the initiating directory capability generation at service entry, before any generation, reference, directory or cache read, and retain that assertion across all reference pages, token acquisition, provider requests and transactional publication. Capability changes stop the operation rather than adopting replacement authority or becoming cached lookup failures. Cache-only resolution does not acquire a token, check live provider authorization or record provider-operation evidence. The explicit people endpoint retains that fence through its final saved-label and current-membership reads. Directory request deadlines cover headers and body consumption. An error-body deadline preserves the HTTP status and retry headers already received, so authorization/throttling failures still stop Users sync and a received 404 remains not-found. Caller cancellation, the overall resolution deadline, session revocation and provider admission remain authoritative.

- accept provider access tokens from the browser;
- grant consent during sign-in;
- treat a client secret as provider authorization;
- infer permission from a successful login;
- report unavailable provider data as a successful empty result.

Use **Permissions > Check status** to inspect current readiness. Providers make
the final authorization decision when an operation runs.

## Data handling

Inventory association candidates come only from the selected current tenant snapshot, before page filtering, not the source identifier table or loaded browser packages. Missing required environment scope cannot establish identity, and resource IDs include their resource type. No currently documented package-to-Power-Platform equivalence is inferred. All CSV exports prefix spreadsheet-sensitive cells with an apostrophe, including LF-prefixed cells and formula markers hidden behind leading whitespace or a text BOM; source whitespace, embedded newlines and Unicode remain intact. Inventory work revalidates the initiating principal before dispatch and publication; account changes signal cancellation independently of tenant data ownership. Shutdown separately drains all active work. Saved-data GETs remain provider-free. The workbench admits scheduled reads through the authenticated, CSRF-protected automatic-refresh POST while signed in, online, visible, and not paused; it cannot select another account, force destructive cleanup, or trigger hunts/imports/mutations.

Directory/licensing/activity, Graph packages, Power Platform, canonical inventory and saved people are one tenant-owned dataset. Viewer, UsageReportUploader and Admin can read saved tenant data without provider source-read permission. Graph refreshes use application grants; Power Platform refreshes use the initiating user's delegated permission and inventory role. Delegated tokens are never borrowed. Application-mode package refreshes publish into the same tenant root. Source freshness and active collection admission are shared across accounts, tabs and processes. Failed refreshes preserve saved publications; limited-visibility catalogs retain unseen records rather than treating absence as deletion. Collector identity, audit attribution, jobs, credentials, capability evidence, mutation authorization and private execution receipts remain actor-bound. Revocation fences that actor's in-flight writers and selections, not published tenant data or other readers. A later authenticated Viewer can resume provider-free canonical derivation from saved tenant sources even after their collector signs out; this grants no provider collection or mutation permission. Fast catalog refresh and slower detail enrichment retain independent freshness. Cached access assignments never replace live mutation prestate/readback checks. First-run eligible read-only collection starts automatically; missing sources or provider denial do not block access to the workspace. Restart recovery requires a signed-in request before new automatic provider work.

Provider changes require the logged-in user's current Admin app role, delegated
API permission and applicable Microsoft role/license. Application read grants
never authorize changes. Power Platform inventory has no application equivalent:
recommend **AI Reader**, the least-privileged supported Entra inventory role for
agent/environment sync. Broader supported roles are alternatives only if already
assigned. A Privileged Role Administrator assigns it through **Identity > Roles &
admins > AI Reader > Add assignments**; the viewer signs out/in and first
activates a PIM-eligible role. Inventory access does not authorize quarantine
status or changes; both require **AI Administrator**, **Power Platform
Administrator** or **Global Administrator** and the separate delegated permission.
See the [current 11-entry API reference](user-roles-and-permissions.md#app-registration-permissions).

Agent environment context is selected only for exact IDs on authorized canonical agents, from current, validated saved snapshots in the same tenant. Environment observation timestamps are not borrowed from the agent snapshot; unrelated, invalidated or unverified environment records are not exposed. Older retained observations preserve their original dates and do not establish live provider authority. Connector operations are minimised allowlisted agent-embedded configuration, not recursive package-name/URL inference. The operation configuration creator is separate from agent responsibility. Connection IDs, credentials and callback URLs are discarded. Invoked-flow relationships remain explicitly unavailable from the synchronized sources; no Dataverse authorization or broad flow inventory is introduced. Official-console links are fixed allowlisted Microsoft landing URLs, never provider-supplied URLs. Overview reads saved people only; **Look up people** is an explicit capability- and CSRF-protected directory request.

Direct directory search/resolution and package access-principal validation pin the initiating session and directory capability generation before capability/token acquisition, propagate HTTP disconnects, and share a two-minute wall-clock deadline. Session/capability authority and provider admission are checked before each Graph dispatch, after response headers, and before returning labels or accepting resolved principals. Authority is also rechecked when authentication, transport or body parsing rejects, so stale authority takes precedence over upstream failures. Explicit agent people lookups and reference sync retain their initiating authority on rejected repository and authentication work as well; cached-only service resolutions remain provider-free. A response received under changed authority is cancelled before reading its body. Late authentication or provider results cannot start queued lookups or publish a response after cancellation. Each Graph request retains its ten-second body-inclusive deadline even if its transport ignores abort; late response bodies are cancelled and late transport rejections are observed. A failed search collection cancels its peer, and a failed resolution cancels peers and stops queued IDs. Received Graph error status and Retry-After survive an error-body deadline while authority remains current. Only exact object-ID 404s fall back to unknown labels; permission failures and malformed responses remain errors.

Directory principal IDs follow Microsoft Graph's hexadecimal 8-4-4-4-12 GUID syntax without RFC version/variant restrictions and are returned and dispatched in lowercase. Names, mail and UPN casing remain independent of identity; opaque package, report and provider-native identifiers are not directory IDs. Principal input is bounded and control-free, and duplicate resolution requests are rejected case-insensitively. Search text permits 2–120 trimmed characters without C0, DEL or C1 controls; the principal selector rejects these locally and cancels an earlier pending search. Searches inspect only the first bounded users/groups pages, ignore continuation links and counts, deduplicate canonical typed identities before sorting and applying the combined limit, and do not offer a directory cursor or complete-match count. Equal display-name sort keys are ordered by resource type and canonical object ID so provider ordering cannot change which tied principals survive the limit.

## Sessions and role freshness

- Sessions are opaque, server-side PostgreSQL records addressed by an `HttpOnly` cookie with an eight-hour lifetime. HTTPS cookies are `Secure`; `SameSite=Lax` permits the Entra top-level GET callback.
- Only sanitized identity, recognized app roles, expiry metadata, CSRF state, authorization freshness metadata, and the random authentication-transaction handle are persisted. Access tokens, refresh tokens, ID tokens, authorization codes, OAuth state, OIDC nonces, PKCE verifiers, and MSAL cache contents are never stored in PostgreSQL or sent to the browser.
- MSAL's token cache remains process-local. A restart requires token reacquisition; persisted application data and sessions remain governed by their own expiry rules.
- MSAL discovery and token response bodies are limited to 128 KiB within the existing ten-second request deadline. Token-endpoint throttling preserves `Retry-After` without reading the response body. Malformed or oversized successful responses are not classified as retryable network failures; non-JSON server failures retain their HTTP status and transient classification.
- Protected requests require a recognized app role and enforce the operation's required role. Viewer-capable access includes Usage Report Uploader; local Audit reads/exports require Admin. Role-bound capability evidence is reacquired or revalidated under the current session/account fences; unsupported roles grant no protected access.
- App roles are revalidated with Entra every five minutes. Revocation can therefore take up to that interval to affect an otherwise active session. Consent/account changes and logout are ordered against concurrent refreshes so stale role data cannot restore a revoked session.
- Long-running browser read-only sync revalidates the initiating identity before that role evidence expires. Already-cancelled browser reads are not dispatched. Concurrent identity revalidation cannot replace the initiating authorization: renewal checks and both successful and failed read completion recheck that binding, with cancellation or invalid authority taking precedence over provider results. Changed authorization, actual revalidation failures and session revocation stop the work; bearer assertion freshness is never extended.
- Logout evicts the account credential cache, pauses its delegated jobs, advances the principal authorization epoch, cancels that actor's unfinished generations, deletes all server-side sessions for that tenant/account, and expires the browser cookie. Complete validated tenant publications remain readable by other authorized tenant accounts until replacement, explicit invalidation or deletion; observation age alone does not remove them. The logged-out actor's selections, exports and writers remain fenced.
- Power Platform role-template IDs are allowlisted from validated ID-token role claims into sanitized session state. Only the six documented inventory role IDs are retained; raw claims are not persisted. Full, AI and unknown remain distinct diagnostic hints, not provider authorization or measured coverage. All supported hints request the same allowlisted agents and supporting environments; only the actual executed query and validated saved counts establish coverage.

## Browser mutation controls

Inventory read/export selection is available to Viewers, including bounded
canonical group references whose full package membership is not downloaded.
Mutation target counts, previews and controls remain Admin-only. Selection
ownership still resets on tenant, principal, role or inventory-selection change.
Retained older saved evidence is readable with its original dates, not an
active browser expiration dependency. Read-selection leases still expire
normally and must be recaptured under current authority. Bounded TanStack Query
caches are in-memory and cleared on logout or principal/role change; historical
display data cannot certify a selected export or mutation. Independently, mutation staging and final
dispatch require unexpired current inventory authority; a readable historical
selection never grants permission to dispatch.

- All authenticated state-changing API requests require a session-bound CSRF token in `X-CSRF-Token`.
- The backend also requires the request `Origin` to equal the configured application origin. Missing or mismatched `Origin` is rejected; there is no `Referer` fallback.
- App Service trusts exactly one reverse-proxy hop. Local deployments do not trust forwarding headers unless an operator explicitly sets `TRUST_PROXY=1` for a controlled proxy. The application origin is canonical and singular; wildcard origins and cross-origin API use are unsupported. Client-supplied identity headers never authenticate a caller.
- That hop policy belongs to the Node API, not the independent MCP container.
  MCP ignores forwarded headers and retains exact SDK Host/Origin/resource
  binding. The [Azure MCP profile](azure-production-deployment.md#optional-independent-mcp-app-service)
  uses a distinct exact user-assigned managed identity, versioned native Key
  Vault references and one encrypted HTTPS/private-endpoint Blob object. Every
  mutation is server-fenced by a lease on that exact data blob plus ETag; expired,
  lost or unknown ownership permanently stops issuance/publication and readiness.
  There is no separate guard-blob/unfenced-key writer, cached authorization
  fallback, default credential chain or automatic uncertain-write replay.
  Exact object-conditioned container RBAC and DNS/egress remain mandatory.
  Local protected-file ownership/mode guards remain unchanged. MCP failure never
  disables the independent Node/PostgreSQL path.

### Permission Center

- Workbench views and actions are code-owned, immutable definitions; each metadata response gets independent role arrays. The browser accepts only the bounded (64 KiB), unique-ID JSON contract with explicit registered roles, capabilities, safe local paths, and finite action semantics. Missing or malformed authorization fields fail the metadata read closed, rather than making actions role-free. Unknown fields are not forwarded to routing or action consumers; JSON parsing never inspects caller-owned accessors or proxies. A null capability is intentional for saved-data reads; provider workflows authorize their actual delegated or application collection mode independently.
- The UI imports the backend capability types and renders only registered adapters. One shared gate explains backend decisions on provider actions and separately applies local data-role visibility. It does not infer grants, Microsoft roles, licenses or write qualification from a successful read.
- Permissions shows Issues, App-defined roles and App registration permissions without a shortcut bar. Directly assigned roles use purple cards; inherited roles remain neutral. The API reference has four groups and 11 entries, keeps OpenID Connect separate from Graph, and excludes local app-role requirements and deferred investigation setup. See the [complete reference](user-roles-and-permissions.md#app-registration-permissions).
- Permission diagnostics do not continuously gate ordinary operation attempts. Requested reads obtain current authorization; cached diagnostic expiry is not a separate approval requirement. Disabled modes, internal roles and current application-sharing configuration still apply. Admin writes require current provider authority, exact-target confirmation and readback, not prior probe evidence.
- When an assigned Viewer-capable session appears, the UI loads `GET /api/capabilities` and makes one `POST /api/capabilities/check`, deferring that initial check while hidden. Subsequent checks require **Check status**. Expiry, focus, visibility changes, page entry and rerenders do not trigger recurring provider checks; local timers only age diagnostic labels and issue reports. One check promise runs per session generation. Requests use `AbortSignal`; logout, unmount, or a tenant/principal/role/session change aborts and fences stale results. A transient transport failure gets one abortable retry after one second, not a recurring expiry-retry loop.
- Sign-in callback failures consume the one-time flow before redirecting to a safe local path with a fixed cancellation, interaction-required or failed outcome. Provider error descriptions, OAuth state and token data are never reflected into UI notices.
- Missing API permission is an administrator prerequisite: the UI links to Entra setup and lists exact delegated/application permissions, never Request consent or Authorize controls. `interaction_required` and `authorization_expired` offer ordinary **Sign in again** for MFA/session recovery, not capability-scoped consent. Setup remains external, and normal authentication does not establish feature grants. No action redirects automatically.
- Permission diagnostics expose only allowlisted error categories, bounded provider error codes, HTTP status and validated correlation identifiers, alongside code-owned requirements and observation timestamps. They never expose provider response bodies, token/claim data or another principal's evidence. A consent-required Entra suberror is not labeled expired authorization; generic `invalid_grant` requires interaction without asserting its cause.
- Browser tests use a separate fixture app and isolated PostgreSQL databases. Test auth/provider mocks are not runtime routes or configuration options. Ordinary runtime rejects fixture mode, and production images exclude fixture runners/browser dependencies. See [validation](operations.md#validation).

## Capabilities and provider credentials

- Side-effect-free `GET /api/capabilities` returns `{ value: CapabilityView[] }`. Assigned Viewer-capable users may call CSRF-protected `POST /api/capabilities/check` with an absent/empty-object body. Other bodies return `400 invalid_request`. Unassigned sessions do not run checks; the backend does not schedule page-load checks itself. `POST /api/capabilities/:id/probe` is an explicit targeted retry, not a prerequisite UI step.
- Read-only `GET /api/capabilities/check-progress` accepts only the same optional `retry=failed` query as the batch POST. It requires an assigned Viewer-capable session, returns `Cache-Control: no-store`, and reports only that tenant/principal/generation/effective-role/retry-mode batch, or `null` when absent. Copied in-memory entries contain only automatic-check capability IDs and `reviewing`, `checking` or `complete` states; no provider requests, persistent progress records, target selection or authorization changes occur. Completed reviews include reused evidence and failed checks, not necessarily provider verification. Entries disappear when the batch settles.
- An automatic batch failure releases its ownership of pending probes and cancels probes with no other caller, preventing abandoned provider work and late evidence publication. A probe shared with an independently active batch or targeted caller continues for that caller; the original batch failure remains an error, not a partial-success response.
- Each `CapabilityView` carries its code-owned definition/decision and emitted `enabled` state. Application `configuration: { enabled, sharedDataScope, revision }` binds saved results to exact current configuration, including revisions that leave flags unchanged. Disabled application modes or missing configured shared scope remain `not_configured`. Decisions include status/authorization/freshness, optional verified timestamps/evidence, remediation and optional mutation-diagnostic qualification state. `on_demand` reports current internal-role authorization, not token/provider proof; requested operations obtain actual provider authority. Failed/unchecked/expired checks make no successful verification claim. Optional mutation diagnostics never gate ordinary reads or writes.
- Provider statuses are `available`, `missing_permission`, `missing_internal_role`, `missing_role`, `missing_license`, `not_configured`, `unsupported`, `preview_disabled`, `provider_error`, and `unknown`. `interaction_required` and `authorization_expired` are evidence categories, not additional capability statuses: their decisions map to `unknown` while preserving the exact safe category. The UI consumes those categories for normal sign-in recovery, not permission requests. A confirmed missing grant remains status/category `missing_permission`; ambiguous `401`/`403` and source failures map to `provider_error`, while explicit unsupported or `404` responses map to `unsupported`. Correlation IDs are sanitized, and bearer data/provider bodies are stripped.
- Capability definitions are code-owned contracts. Standard application collection has fixed enabled tenant scope and cannot be manually disabled or scope-approved. Admins can configure only optional application investigations. Automatic and explicit checks are non-mutating and session-scoped; neither accepts fabricated evidence or edits provider, audience, permissions, roles, or write qualification.
- Application configuration writes retain the initiating account-session and principal-authorization generations while queued. Sign-out, replacement sign-in or role/authorization invalidation rejects an old queued write before persistence; another administrator's configuration request does not invalidate the initiating principal.
- Readiness and operation evidence retain the initiating account-session generation before configuration/evidence lookups. Replacement sign-in cannot authorize older pending work or join its batch/probe under another session.
- Package access, block/unblock and Copilot Studio quarantine management use `on_demand` probing. Ordinary Admin-confirmed writes require no prior canary or qualification record. Token/status readiness is not exact-target operation proof; current provider authorization, exact targets, immediate prestate checks and readback are enforced by the submitted operation.
- Provider permission is acquired only for the capability that needs it. OIDC login scopes, delegated capability scopes, and application-role capability permissions are separate authorization paths.
- Microsoft access tokens are client-opaque. The runtime validates MSAL response tenant, account, token mode, returned delegated scopes or exposed application roles, resource metadata when exposed, and expiry. Optional readable JWT claims can reject contradictions, but the client does not require Microsoft-owned access tokens to be parseable JWTs.
- Provider-read evidence is keyed by tenant, resource principal/application, authorizing principal, capability, resource audience, environment, token mode, permission revision, contract revision, and configuration revision. Full check batches are singleflight by tenant/principal/generation/effective Admin access/retry mode, individual refreshes are singleflight by evidence key, and fresh successes or failures are reused during the five-minute cooldown. A concurrent Viewer batch cannot suppress Admin-only token checks. Automatic, targeted-refresh, and read-through paths capture the generation before any await. Invalidation during configuration, token, or provider work prevents later provider steps and evidence publication. Readiness, live-qualification and operation-diagnostic evidence writes also recheck their initiating session, principal/capability generations and cancellation inside the transaction immediately before commit; stale writes roll back without replacing previous evidence. Audit and hunting workers pass their publication/failure-evidence cancellation signals through to that fence. Successful login/consent plus logout or demotion invalidation increments the generation and deletes that principal's evidence. A generation change fails with `401 authorization_expired` rather than returning stale or mixed results. Each coalesced caller receives a separate current-role projection, preventing an Admin-shaped response from leaking to a Viewer.
- Optional application-investigation evidence retains the captured configuration revision. Disabled mode, withdrawn shared scope or a superseded revision rejects stale publication; an earlier operation cannot overwrite evidence for a newer configuration. Standard application collection has fixed tenant scope and no enablement or scope-approval step.
- Authorization-check evidence expires after five minutes and stops authorizing evidence-backed actions, while stale metadata remains until retention. Safe checks separately bound each token attempt to ten seconds and each provider-read attempt to ten seconds, except package catalog reads use thirty seconds. A genuinely transient failure, including a deadline, receives at most one retry with a fresh bounded signal; caller cancellation, session revocation and deterministic denials never retry. Provider `Retry-After` is honored: only a short cooldown within the one-second backoff ceiling may retry, while longer cooldowns are persisted. The maximum token-plus-catalog check is eighty-two seconds including retry backoff. Response bodies share the attempt's signal and two-MB limit. The fixed eligible set runs concurrently. Eligible explicit operations refresh absent/expired readiness once without requiring a manual probe.
- Ordinary catalog, directory and inventory checks may invoke their bounded safe read adapter. Authorized quarantine read, Purview, Defender and implemented Admin write checks acquire only the scoped delegated token; token success is not proof that an exact provider operation, tenant data source or license is available. Package access/block and quarantine management initially report `on_demand` Admin authorization only when no evidence exists. Automatic checks replace this with expiring `token` evidence or a failure; on-demand readiness never overrides missing permission, interaction errors or expired evidence. The submitted operation still acquires and validates provider authorization. Viewer receives `missing_internal_role`. Management availability selects no target, calls no quarantine status or mutation, executes/resumes/reconciles no job, and runs no canary.
- Automatic checks include a bounded application package-catalog read, but not exact people or management-directory lookups, imports, provider writes, mutation canary execution, raw-data collectors, Audit Search or Defender workloads, or data-refresh jobs. Disabled optional investigation modes are excluded from primary health, remain Admin-configured, and are never used as delegated fallback. Initial read-only synchronization starts automatically for Viewer-capable accounts while the browser is visible and online; no administrator session or manual enablement is needed for Graph reads. Tenant/source admission and freshness coalesce work across accounts; authorization and cancellation remain bound to the initiating user even when provider credentials belong to the application. Package jobs persist the application owner separately from that authorizing user. A Permissions first-page check alone does not import inventory.
- Permissions renders actual recent failures only. Successful, unchecked, stale, local-policy and disabled-mode decisions are not issues. A Viewer's normal lack of Admin-only actions is not a failure. The neutral **No issues reported.** state does not certify untested provider access. Authorization still uses registered, matching, enabled, current capability decisions; hiding a status never relaxes action gates.
- Recent `operationFailure` metadata is separate from the admission decision. It contains a failure status, checked/expiry timestamps and optional sanitized evidence/remediation, scoped by the existing tenant/principal/resource/permission/configuration evidence key and an `operation-v1:` contract namespace. Reports persist for at most 24 hours, clear after actual operation success, and are invalidated with principal/capability evidence. Token-only checks cannot clear them. The frontend hides expired or malformed reports. Only real permission, role, license, authentication or ambiguous provider 401/403 failures are published; transient network/latency failures stay in their owning feature instead of becoming permission issues. An on-demand read can remain admissible for an explicit retry without fabricating provider verification. Recording is best effort with an explicit operational warning on storage failure, never replacing the original operation result or replaying a mutation.
- Primary health shows **Permissions**, a real issue count or a check failure, with `aria-busy` during checks. Setup references group exact delegated grants and collapsed optional application permissions without access-status tabs. Opening Permissions shows already-loaded diagnostics; **Check status** reloads GET and the bounded POST with `?retry=failed`, reusing current successes and throttling cooldowns. These checks never select application capabilities, execute target-scoped on-demand reads or perform provider writes; implemented Admin write scopes receive only non-mutating token checks. One abortable transport retry precedes reporting transient network/408/500/502/503/504 errors; deterministic denials, invalid-input and throttling responses are not retried. Cached transient failures are confirmed on initial load before being shown.
- Remediation remains code-owned. Interaction and expired authorization use normal sign-in recovery. Missing grants require administrator-managed app registration and consent. Ambiguous provider failures do not establish a missing role or license, and unused audit/hunting capabilities do not create issue rows.
- Azure runtime configuration uses 3 native Key Vault references: `TENANTS_JSON`, `SESSION_SECRET`, and `PGPASSWORD`. The complete tenant registry contains each tenant's identity configuration; standalone tenant/client credential references are not runtime inputs. The separate PostgreSQL administrator password is available only to provisioning, initialization, and operator maintenance.
- Provider URLs and pagination links are parsed and checked against the expected HTTPS origin and route family before an authorization header is attached. Redirects are rejected. These checks prevent hostile configuration or provider links from forwarding bearer credentials to another host.
- Shared Graph/directory/inventory body readers enforce byte limits and recheck cancellation after the final read, reader release, and JSON parsing/checkpoints. An already-cancelled read preserves its reason even if another consumer holds the reader lock; it never releases that consumer's lock. JSON and report text reject malformed UTF-8 before decoding so replacement characters cannot silently change source identities or values; valid Unicode and text byte-order marks remain unchanged. Malformed JSON becomes a sanitized schema error; local parse-checkpoint failures are not relabelled as malformed provider JSON. Discarding oversized bodies or failed/redirected report and inventory responses is best effort: cleanup cannot delay completion or replace the provider error. Report downloads also check cancellation before following their allowlisted redirect.

## Durable jobs

Long-running synchronization, investigation, and provider-change jobs keep
bounded progress and results. Interrupted work is recovered only when the
operation is safe to resume. A provider write with an uncertain outcome is not
sent again automatically.

Package job status, history and item/target pages retain the initiating account
session through selection identity lookup and storage completion. Revocation or
replacement sign-in rejects late results and takes precedence over late storage
failures. Explicit bulk-job resume rechecks that session before provider token
acquisition, ordered recovery and worker launch; replacement authority cannot
continue the earlier request.

## Deployment

Local deployment binds the frontend and API to one origin. Azure deployment uses
HTTPS, App Service, PostgreSQL, and versioned Key Vault references.

Run software checks before release:

Power Platform refresh jobs are a separate read-only lifecycle. Submission records immutable principal/environment/type/query intent and the optional role hint before work. A current capability decision and process-local delegated token are required before `running`; the initiating session and capability generations remain pinned through admission, provider page requests/retries, response consumption and the synchronous pre-COMMIT publication check. Later capability revalidation cannot adopt replacement authority for an existing execution. Page/count progress is safe metadata, while resource rows publish atomically only after complete paging. Provider/schema/limit failure preserves the previous snapshot. Cancellation and sign-out also fence pending admission, before provider dispatch. Shutdown closes admission, aborts and joins both pending starts and in-flight reads, and returns interrupted running jobs to `waiting_authorization`; startup performs that state conversion only and never calls a provider. There is no scheduler, navigation-triggered fetch, application-token substitution or raw-response persistence.

Package inventory uses actor-owned read-only refresh jobs and one tenant-owned saved dataset, irrespective of delegated/application collection. Saved list/detail requests accept no provider-mode selector and acquire no provider token. Eligible signed-in accounts automatically initiate due read-only synchronization; active collection and successful freshness are deduplicated per tenant/source. Opening the access editor explicitly refreshes the exact package and fetches current details; bulk access preparation refreshes selected targets before confirmation. These reads do not replace dispatch-time prestate checks or perform writes. Delegated collection requires the caller's `CopilotPackages.Read.All`; application collection requires its configured credentials and genuine Graph application permissions. Failed scans preserve saved data. Successful limited-visibility catalogs retain unseen records, report their limited coverage honestly, and never manufacture deletion evidence.

Package catalog continuation retains the exact global-cloud v1.0 endpoint and Copilot filter, with only one nonempty opaque `$skiptoken`. Other query options, duplicate/encoded-duplicate keys, malformed encoding, controls, credentials, fragments and changed paths fail before another fetch or page release. Canonical continuation loops and duplicate exact package IDs fail the scan; case-distinct opaque package IDs remain distinct. Count annotations are validated hints, not completion evidence: only the absence of a continuation establishes the observed final total. IDs are never shortened or case-folded, and controls and dot-only path segments are rejected consistently at request, observation and durable-target admission.

Package refreshes pin the initiating capability generation through token renewal, physical reads, publication and response release. Every physical inventory GET, including retries, rechecks its durable generation immediately before transport; synchronous caller authority and provider-admission checks also run before transport and terminal COMMIT. Non-cooperative fetches and authorization calls cannot retain the operation beyond cancellation or their finite local deadlines; late response bodies are disposed and late rejections observed. Readbacks and one-shot mutations retain the same synchronous authority checks. Malformed supplied access scopes do not become successful empty/specific assignments, and an additive all-users no-op still requires the selected collection. An explicit unknown scope with principal entries remains Unknown in the editor and cannot establish mutation verification or preservation.

Automatic detail fallback reads also recheck the initiating account session and capability before returning saved job history, including during shutdown or capacity exhaustion. If admission loses authority after claiming a job, compensating failure cleanup may transition only that exact automatic job while it remains `waiting_authorization` at the captured result revision and has never been started (`attempted_at IS NULL`). It cannot overwrite running, resumed, cancelled or completed work, and stale authority still rejects the caller response.

For both refresh services, local pending/running reservations are private to the owning tenant and principal: other callers receive `404 not_found`, not a lifecycle conflict. UUID casing does not create a separate reservation or prevent cancellation from reaching its worker. Cancellation and execution deadlines are observed eagerly throughout execution, including pending publication authorization; the first interruption remains authoritative even if shutdown or another interruption follows before work settles. Later provider or authorization results cannot replace that cancellation, authorization-wait, or execution-deadline outcome. Abort listeners are released when execution settles, and shutdown still joins the work rather than abandoning it. Outcome-persistence failures still surface separately and do not count as a recorded outcome.

The retained Purview Audit Search backend is an explicit provider-read lifecycle; its UI entry points and setup are deferred. Viewer-capable callers may submit ordinary delegated/private or configured application/shared searches directly under current authority. Admin does not gain another principal's private results or job lifecycle ownership. Code-owned presets, required operation subsets and structured filters bind the request. A durable create marker prevents ambiguous POST replay; interrupted work needs explicit current authorization. Per-attempt durable capacity and execution-owner/version fences protect dispatch/publication. Automatic checks create no Graph queries. Cancel/delete are local; Microsoft may continue remote work. Rows contain minimized metadata/message IDs, not prompts, responses, transcripts or unrestricted `auditData`. Results expire after 30 days and remain distinct from Admin-only local audit/official usage. Agent interactions require the current typed verified mapping; Studio administration retains exact Bot ID/environment scope. See [Audit Search](purview-audit-search.md).

Every available package mutation requires a current server preview hash over the actor, exact native targets, frozen mutation-relevant prestate and requested intent. Jobs retain the scalar confirmation metadata and per-target prestate immutably; sampled before/after targets remain in the reviewed preview and its hash, not duplicated in the bounded job metadata. Job status and result paging retain their existing contracts. A tenant/package advisory lock serializes this application's local operations; under it the worker immediately rereads and hashes provider state before dispatch. Microsoft documents no ETag/`If-Match` on these endpoints, so this cannot prevent an external administrator from changing state after the reread and is never represented as provider atomicity. Full access replacement can overwrite such a concurrent change even though the app preserves and verifies the unselected collection. This risk is disclosed, not used to withhold implemented access or block/unblock functionality. Duplicate, non-UUID, unresolved, deleted or redirected principals are rejected.

Mutation-selection counts and previews honor the same pinned inventory filters. Submission resolves the preview using its actor, authorization, confirmation hash, optional selection ID and exact target criteria; a newer equivalent preview with different criteria cannot shadow the reviewed selection.

Implemented Admin package access, block/unblock and quarantine operations run on demand without prior canaries, qualification records, or extra configuration in any deployment. Authentication, Admin revalidation, Microsoft delegated authorization, CSRF, exact targets, frozen intent, immediate prestate checks, audit, one-shot dispatch and readback remain enforced. Optional canaries retain their actual approval/restoration rules without gating ordinary operations. Owner reassignment has no implemented product workflow or documented owner readback. Optional application investigations retain their separate configuration and scope requirements; standard Graph collection has fixed tenant scope.

For an actual access change, preserving the untouched setting requires `none` plus an empty collection or `some` plus a nonempty collection. A collection-only PATCH cannot safely preserve all-users access, inactive principals under an explicit no-users scope, or an explicit some-users scope without principals. Preview and pre-dispatch validation reject these combinations without a write marker; the editor disables only the affected access target and explains why. Exact no-ops and block/unblock remain available. Historical sent receipts still support GET-only reconciliation; this admission rule neither changes frozen hashes nor replays or discards uncertain outcomes.

Quarantine preview and submission revalidate the actor and management capability, even when direct status is cached, so confirmation and audit identity use the same current actor. New-job publication is fenced against logout or account changes during the request. An exact idempotent retry can launch its existing, still-queued ordinary job after temporary worker-capacity failure without recreating the job or resolving the frozen targets again. Running, authorization-paused, terminal and canary receipts are returned without dispatch; paused jobs still require explicit resume, and canaries retain their approval-controlled execution path.

Quarantine provider work also pins the capability service's initiating authority generation: invalidation during token acquisition, provider reads, observation/job commit or launch handoff cannot adopt newer authority. Each target read revalidates the current actor after token acquisition, and every adapter GET retry rechecks the caller's session, authority and provider-admission fence. Publication and queued-job launch retain that same fence. A launch failure leaves the committed submission and its idempotency identity intact. Cached status and non-dispatching receipt retries require the current internal role, not provider-capability preflight; the UI permits those reads while live rechecks, new confirmations and queued execution still require provider authority. Opaque native resource IDs, including GUID-shaped IDs, retain exact case in inventory resolution and quarantine selection/bookmark keys; only environment/bot GUID identity is case-insensitive.

Quarantine execution and GET-only reconciliation retain the initiating account-session generation throughout the operation. Even a replacement sign-in by the same account cannot authorize late dispatch, readback publication or a stale response. Cancellation retains its cause over late provider failures and stops admission of further items; UUID casing and duplicate tracked executions cannot bypass cancellation or shutdown draining. Shutdown reports persistence failures rather than treating a logged failure as success. Each newly started item renews its still-valid fenced lease and restores the job's running status, allowing all 25 targets to complete their bounded execution windows without reviving expired leases. Cancellation and reconciliation aggregation keep jobs running while any item is running, so interrupted active work remains eligible for lease recovery. Recovery and authorization pause honor persisted cancellation before aggregating requeued unsent work.

Direct quarantine reads recheck provider admission around authorization and token acquisition, before provider dispatch, and immediately before observation commit. New-job and optional canary claim/job/qualification commits also reject admission closing during awaited work. Saved status observations and terminal receipts do not themselves admit provider work. A received HTTP denial remains authoritative when its optional error body stalls: authorization, missing-target and classic-bot failures are not retried as transport timeouts, throttling retains its bounded `Retry-After`, and caller cancellation or the overall operation deadline still takes precedence.

Quarantine target identity comparisons, target locks, unresolved-write checks, and optional canary qualification reads treat native environment/bot GUID casing aliases as the same target, without changing the frozen provider evidence. New observations, canary approvals, and qualifications store lowercase target GUIDs; reads also compare existing source-cased rows case-insensitively. Canary inverse pairing and durable-job evidence checks use that same identity while keeping exact native resource, actor, state, timestamp, and authority requirements. A sent item still awaiting durable completion also blocks sibling dispatch, including the gap between lock release and inconclusive-outcome persistence. Losing the target-lock connection aborts provider work and fences dispatch-marker and verified-result transactions before commit. Observation, new-job, canary approval/claim/qualification, dispatch and readback publication recheck the initiating session immediately before commit; readback publication also rechecks provider admission. Exhausted convergence evidence cannot be promoted to cached/inventory state after interruption. Sent work remains inconclusive and is never replayed. Lock cleanup must confirm release; failed cleanup discards the connection and surfaces an error without overwriting a committed item or reporting committed reconciliation as an unpublished read failure. The UI retains the exact job receipt and reports failed GET-only reconciliation targets, allowing an explicit status refresh or retry.

Native inventory readback settlement retains the receipt's exact case-sensitive resource ID, even when it looks like a GUID. It does not remap that ID to a case-changed current membership or infer a missing bot ID from the resource ID. Current inventory must still prove the receipt's environment/bot identity before its saved quarantine state is updated; an intervening identity change leaves that inventory state unchanged without rewriting the committed job receipt.

Package previews, submission, resume, execution and reconciliation retain the initiating account-session generation. Logout or a replacement sign-in, including the same account, cannot authorize late writes or publish old readback. Exact idempotent package retries can launch a still-queued receipt after worker-capacity failure without rebuilding its frozen targets; an already admitted retry does not consume another worker slot. Authorization-paused and terminal work never launches through that retry path, and explicit resume checks the current post-recovery job state. Interruption stops admission of further items and retains its cause over late failures. Shutdown joins the workers and reports persistence failures instead of treating a logged failure as a successful drain.

Persisted package cancellation wins over an authorization pause before dispatch: the unsent item is cancelled, not requeued. An inconclusive sibling keeps the aggregate `partial`, but cancelled work cannot resume. Losing a mutation or reconciliation lock connection aborts active provider work and fences dispatch-marker and verified-result transactions before commit; already-sent work remains inconclusive rather than being retried. Lock-loss listeners are removed when work settles. Locks must be confirmed released before returning their connection to the pool; failed cleanup discards the connection and reports failure without overwriting a committed item outcome. Cleanup failure after reconciliation publication propagates as a request error rather than falsely reporting that the provider read failed and no state was published; saved status and result pages remain authoritative.

Package mutation dispatch is one-shot. Bounded detail reads must observe the expected semantic state before success; HTTP `204` is only acceptance. Timeout or ambiguous state after dispatch is durable `inconclusive`. Reconciliation acquires current Admin identity and delegated package-read authority before each target and before publishing its result, honors cancellation, and performs provider reads only; it can mark an operation observed-applied, observed-not-applied/retry-eligible, or conflicting, but never automatically retries a mutation or depends on an unexpired write qualification. Maintenance or disabled provider work also blocks reconciliation, including further reads and publication when admission closes during an in-flight check; unresolved items remain available for a later explicit reconciliation after admission reopens.

Optional write qualification is separate from read evidence and ordinary write authorization. An Admin creates a 30-minute typed approval and a different Admin principal claims it once with current code-derived contract/configuration/delegated-auth identity. Attempted evidence has 30-day retention. The restoration service stores no token, stops before writing on intervening state, dispatches once, and qualifies only after exact semantic read-back; unknown state/criteria keys are never accepted from callers. A full block canary records both directional outcomes. A changed contract/configuration/auth mode or expired approval prevents that canary execution/publication, not ordinary Admin-confirmed writes. The restoration and intervening-change stop rules are defined in [mutation-canaries.md](mutation-canaries.md).

## Audit and residual risk

Durable-operation requested, started, skipped, succeeded, failed, inconclusive and provider-verified outcomes use the existing append-only audit service with exact target, actor, operation/job/correlation identifiers and minimal before/after evidence. Capability configuration records the updating principal/revision. Application enablement/shared-scope changes and capability-evidence invalidation share one transaction, fenced against the initiating administrator's account-session and principal generations before writing and before commit. Logout, replacement sign-in or principal invalidation observed before commit rolls back the configuration, revision and evidence changes; independently current administrators retain ordered writes. The existing capability mutation queue orders configuration writes, authorization cleanup and subsequent scope reads without acquiring an account-session lock inside that queue. Probe evidence retains only allowlisted diagnostic fields. Provider tokens, provider response bodies and unnecessary principal attributes are excluded from persisted diagnostics. This is ordinary local audit, not a hash chain or external checkpoint service.

Audit completion merges allowlisted outcome metadata into the existing event evidence, retaining start-time lease, correlation and prestate identifiers through reconciliation. Audit reads, counts, exports and inventory operation-reference filters exclude observations older than 90 days even before operator cleanup. Operation prefixes use the same case-insensitive, literal letter/digit/underscore/hyphen grammar in audit and inventory. Local Audit search is limited to 200 characters and paging to offset 100,000; larger offsets are rejected rather than silently returning a different page. The UI applies these bounds and asks users to refine filters when older matches exceed the paging window.

Local Audit service reads and details display apply the same bounded metadata allowlist used for persistence, including mutation verification and export provenance when no outcome message is present. Stored disallowed fields are neither returned by the service nor carried into appended outcomes; existing rows are not rewritten. Raw provider errors, principal collections and exported rows are not metadata evidence. Audit actors contain only their recorded tenant/account identifiers and display labels, not current session roles or provider permissions. Export jobs persist that same identity-only actor projection for their audit receipts; a session user's additional authorization claims are not serialized.

Residual risks include the configured role-revalidation delay, process-local token-cache loss on restart, upstream provider/API changes, preview connector/capability-detail fields, Resource Query availability differences outside global cloud, classic/V1 bot exclusion, unpublished configuration omissions, hidden workflow environments, Azure Resource Manager Conditional Access dependencies, and the operator's responsibility to assign Entra roles correctly. No live Power Platform tenant was available for this phase, so local tests qualify bounds and failure behavior but do not claim consent, role, cloud or tenant-data success.

## Transport, admission and recovery

Production serves one HTTPS origin with HSTS for one year including subdomains, CSP limited to self (with inline CSS only), frame denial, `nosniff`, no-referrer and disabled camera/microphone/geolocation/payment/USB. Local HTTP intentionally omits HSTS. API, HTML and deep links are `no-store`; content-hashed assets are immutable for one year. API JSON is limited to 512 KiB. Provider clients use fixed HTTPS origins, manual redirect rejection, bounded pages/rows/bytes and deadlines.

API `no-store` headers are installed before path validation, public probes, body parsing, sessions and authentication, including their failure responses. Unsupported JSON charsets or content encodings return sanitized HTTP 415 problem responses rather than server errors. Errors after response headers have been sent retain sanitized operational logging and delegate to Express to terminate incomplete output instead of attempting a second response.

Bounded administrative Audit, Purview and Defender CSV downloads check the current account/session and source before headers and each chunk, then again after final audit completion. Source reads do not hold the logout lock; durable session validity is rechecked after those reads, and a synchronous account-generation and request-identity fence runs immediately before publication so intervening promise continuations cannot release revoked-session bytes. Earlier chunks honor backpressure, while the final authorized write is followed synchronously by `end()` without another drain wait. Empty payloads follow the same audit, header and exactly-once ending path. Completion and its deadline are checked at the response's actual `finish`, not when a later promise continuation resumes. Deadline or failure tears down incomplete output immediately, even while an ordered audit write is still settling; an already-ended response is never written or ended again. Before bytes begin, download-only headers are removed on transport failure so the normal problem response remains valid. Failure-audit errors are logged separately and never replace the original export error or change an HTTP status after bytes begin.

One process admits at most 1,200 read or 300 write API requests per minute per trusted IP and 600 read or 200 write requests per minute per authenticated principal. Liveness, readiness and auth status are excluded. The limiter holds at most 10,000 local keys and is intentionally not a distributed quota. Uploads allow two concurrent 8 MiB/50,000-row operations. Exports have source-specific row/byte ceilings and a 15-second publication deadline. CSV formatting stops at the first cell exceeding the byte or time budget, without formatting the remaining cells or rows. Publication rechecks the captured account generation and request identity after both stored-session and source validation, so logout or a superseding sign-in during those reads cannot release another chunk. Source validation does not hold the account mutation lock needed by logout. Provider workers and durable queues retain their smaller per-principal, attempt, page and concurrency bounds; durable database admission, leases and one-shot dispatch survive process restart.

The singleton operational state is runtime-readable and operator-writable.
Readiness fails for missing/changed schema or actual file/database maintenance.
A marker also closes admission when inspection fails for anything except a
missing path; removing it never reopens a draining process. SIGTERM/SIGINT close
HTTP admission, drain sync before child workers and wait for admitted requests
before closing sessions/PostgreSQL. Failed drains or the 125-second deadline
produce nonzero exit and sanitized failure telemetry.

Safe Admin diagnostics expose auth configuration, current maintenance/admission,
schema fingerprint and fixed resource limits, not secrets. Optional provider
failure does not fail process liveness. Current-schema restore verifies dump/
table fingerprints, revokes sessions and recovered execution authority, clears
staging/previews, fences owners and marks uncertain writes inconclusive.
Bounded retention and automatic current owner/deletion/configuration
reconciliation precede reopening. Mismatched cache content is purged; unavailable
or over-bound reconciliation leaves actual maintenance. Successful reopen
returns to normal authenticated operation without review timestamps or a second
provider-enable action. Uncertain writes are never replayed.
