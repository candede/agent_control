# Security model

Agent Control uses Entra ID for authentication, app roles for application access,
and Microsoft permissions for provider operations. This is the current security
reference; configuration steps are in [setup](deployment-setup.md) and the
[role and permission guide](user-roles-and-permissions.md).

## Identity and tenant routing

- The entered work/school username selects an exact configured tenant domain.
  Unknown or overlapping domains are rejected.
- Verified Entra tenant/account claims establish identity; client-supplied
  identity headers and reported client names do not.
- Each tenant has separate registration credentials and accepted domains.
- Sign-in return targets must normalize to local application paths; network-path
  redirects are rejected.
- Protected operations require a recognized current Agent Control role.

## App roles

The [role matrix](user-roles-and-permissions.md#app-defined-roles) defines Viewer,
Usage Report Uploader and Admin access. Uploader includes Viewer; Admin includes
both. Set **Assignment required?** to **Yes** on the Enterprise application.

Only Admin can access agent management, configuration and local Audit
reads/exports, including through direct URLs/APIs. Provider changes also require
Microsoft authorization. A role assignment never grants provider access.

## Tenant and account isolation

| Data | Access boundary |
| --- | --- |
| Saved inventory, people, directory/license/activity sources and imported reports | Shared within the tenant among Viewer-capable roles |
| Delegated private investigation evidence | Collecting/authorizing account and current sharing rules |
| Configured application investigation evidence | Exact tenant, configuration revision and shared scope |
| Job lifecycle, control receipts, credentials and capability evidence | Initiating principal and current authorization |
| Local administrative Audit | Admin-only |

Saved tenant data remains readable without Microsoft source-read permission.
Failed or limited-visibility collection preserves existing publications and
observation dates; absence is not automatically deletion.

Revoking one account fences its unfinished work, selections and private receipts,
not other accounts or completed tenant publications. Saved historical identity
evidence never substitutes for current, unexpired authority to change a provider.

## Sessions and role freshness

- Browser sessions are opaque server-side PostgreSQL records with an eight-hour
  lifetime. Production cookies are `HttpOnly`, `Secure` and `SameSite=Lax`.
- Stored session data contains sanitized identity/roles, expiry/freshness, CSRF
  state and a random authentication-transaction handle.
- Provider tokens, refresh/ID tokens, OAuth codes/state/nonces, PKCE verifiers and
  MSAL cache contents are not stored in PostgreSQL or sent to the browser.
- MSAL token caches are process-local. Restart loses those caches, not saved
  tenant data.
- Browser app roles are revalidated with Entra every five minutes. External role
  revocation may take that interval to affect an active session.
- Long-running browser reads revalidate before role evidence expires. An expired
  bearer assertion is never extended by that browser mechanism.
- Logout removes account credentials and server sessions, advances authorization
  epochs, and cancels that actor's unfinished work. A replacement sign-in cannot
  lend authority to an earlier request.
- Changed tenant/application bindings invalidate sessions. Publication rechecks
  the initiating identity after asynchronous work and before releasing data.

## Browser request protection

State-changing browser requests require an authenticated session, the operation's
app role, an exact configured `Origin`, a session-bound `X-CSRF-Token` and validated
input. Missing Origin is rejected; there is no Referer fallback.

Verified API bearer requests use their own authentication boundary, not cookie
CSRF. Mixed bearer/cookie credentials are rejected without fallback. Browser-only
and public authentication endpoints reject bearer credentials.

The API serves one canonical origin. Azure trusts one reverse-proxy hop; local
deployments trust no forwarding headers unless an operator explicitly configures
a controlled proxy. MCP has its own Host/Origin/resource binding and does not
inherit the Node proxy policy.

## Delegated API foundation and canonical integration

The [MCP/API contract](mcp-integration.md) defines the same registered handlers
used by browser and delegated API callers:

- Exact tenant, API audience, client and scope binding with RS256 verification
  and bounded JWKS refresh.
- SDK OBO proof of the existing private home-account identity. Guest resource
  object IDs and `sub` alone are not home-account keys.
- API app roles from the verified API assertion, never Graph roles or client
  labels. Assertions older than five minutes cannot refresh their own role evidence.
- Process-local credential sources and non-secret job references. Assertions and
  provider tokens are not serialized into sessions, jobs, audit or principal DTOs.
- Durable epoch and issuance-cutoff checks prevent revoked assertions from
  regaining authority after restart. Recovery requires fresh same-principal
  authorization, not automatic replay.
- Separate immutable execution initiator and current lifecycle attribution.
  Client metadata is reported attribution, not proof of identity or intent.

Delegated MCP/API caller authentication does **not** make every provider request
delegated. Provider-token mode is defined by the requested capability below.

## Provider credentials and permissions

| Operation | Provider credentials |
| --- | --- |
| Graph package collection, directory/users, licenses, Office activity and user resolution | Configured tenant application credentials |
| Power Platform inventory/quarantine, management group lookup and package controls/readback | Initiating user's delegated credentials |
| Retained investigations | Delegated credentials, or separately configured application/shared scope where supported |

Standard Graph collection has fixed tenant scope and starts automatically after
eligible sign-in while visible and online. It needs no administrator session,
manual enablement, prior permission check or release acceptance.

**Application authorization failures:** administrator verifies application
credentials and consented grants; user sign-in does not repair them.
**Delegated interaction/expiry:** sign in again for MFA or Conditional Access;
missing API grants still require external administrator setup.

Provider permissions, roles, licensing, cloud availability and resource support
are enforced by Microsoft. Readiness/token success is not proof of full provider
visibility or permission for a later write. No automatic credential-mode fallback
is used.

## Shared exact agent controls

Preview, execute and receipt reads use the same current Admin handlers for
browser and configured API callers. A control binds the exact provider target,
source revisions, actor/session, requested effect, prestate and expiry.

- Interactive clients show the exact preview and request confirmation.
- Scheduled clients submit the same current server receipt; there is no
  application approval/bypass flag or new scheduler.
- Generic Studio effects are quarantine/unquarantine. Package block/access
  controls remain distinct from Studio controls.
- Names, origin labels and report-only matches do not establish provider identity.
- The app checks live prestate immediately before one-shot dispatch and verifies
  semantic provider state afterward.
- Local locks serialize this app's operations, not external administrators.
  Package APIs without ETag/If-Match cannot promise provider atomicity.
- A timeout or unknown result after dispatch is inconclusive, not success.
  Explicit GET-only reconciliation never resends the write.
- Stable idempotency keys recover the original receipt; they do not authorize
  automatic mutation retries.

Optional [mutation diagnostics](mutation-canaries.md) retain their own approval
and restoration rules but never gate ordinary supported controls.

## Durable jobs

Jobs retain immutable intent, bounded progress, owner and execution fences.
Admission and publication recheck the initiating principal, session, capability,
source and configuration revision.

| Situation | Required behavior |
| --- | --- |
| Cancellation, sign-out or lost authority | Stop further admission; reject late publication |
| Restart or expired credentials | Recover durable status; require current authorization before new provider work |
| Unsent work with safe recovery | Resume through its existing lifecycle |
| Write sent with unknown outcome | Preserve inconclusive status; reconcile with provider reads only |
| Partial export or failed publication | Do not publish a completed file/result |
| Shutdown | Close admission, cancel and join active work; report drain/persistence failures |

Power Platform collection remains delegated; package and user-source collection
use application credentials while retaining the initiating user's authorization.
Catalog and detail freshness are independent. Refresh failure preserves the last
successful tenant data.

## Data handling

- Saved reads use saved data; they do not initiate hidden provider collection.
  Explicit lookups/collection are separately authorized.
- Provider fields are allowlisted and minimized. Raw provider bodies, prompts,
  transcripts, tokens and unnecessary principal data are not audit evidence.
- Exact verified IDs establish associations; names or guessed cross-provider
  equivalence do not.
- Report privacy concealment, missing evidence and partial coverage remain
  explicit; unknown data does not become zero or proof of inactivity.
- CSV exports escape spreadsheet-sensitive cells without discarding source
  whitespace, embedded newlines or Unicode.
- Current owner/configuration/source and session authority are checked before
  saved pages, details and export chunks are released.
- Returned source text is inert untrusted data, not executable instructions.

## FastMCP OAuth state and recovery

The optional service has an independent OAuth boundary. Full configuration,
storage limits, key rotation and reconnection procedures are in
[MCP integration](mcp-integration.md) and [client setup](mcp-clients.md).

- Validate tenant, resource/audience, scope, client and upstream user identity.
  Reference credentials are not upstream/API/ID tokens.
- Encrypt persistent OAuth connection state. Keep signing/encryption keys separate
  from the confidential client credential.
- Local storage requires protected ownership/modes and one service worker;
  capacity or corrupt-state failures are explicit, not plaintext/ephemeral fallback.
- Azure uses the exact managed identity and leased/ETag-fenced encrypted Blob
  object described in [Azure deployment](azure-production-deployment.md).
- Refresh/restart must preserve the bound upstream identity. Changed identity
  requires reconnect; API assertions are reacquired per invocation.
- Disconnect revokes both access and refresh credentials. It does not fabricate
  account-wide API logout, Entra consent revocation or cancellation of accepted work.
- Redact OAuth diagnostics and callback data before logging. MCP does not store
  application records, SQL access, a provider-token warehouse or a scheduler.

## Permission Center

The UI renders code-owned capabilities and actual current failures. **Check
status** is diagnostic, not runtime approval. It does not infer a grant, role,
license or mutation authority from successful login/read/token acquisition.

Saved-data role visibility is separate from source-read permission. A Viewer's
lack of Admin actions is not a permission failure. Local test/qualification
artifacts do not enable or authorize application workflows.

## Transport, admission and recovery

Production uses one HTTPS origin with HSTS, CSP, frame denial, `nosniff`,
no-referrer and disabled sensitive browser features. API/HTML responses are
`no-store`; content-hashed assets are immutable. Local HTTP omits HSTS.

Provider clients validate fixed HTTPS origins and route families before attaching
credentials. Redirects are rejected except the explicit allowlisted Office
report download, which does not receive the Graph token. UTF-8, JSON contract
fields, record/body sizes, idle waits, execution deadlines and retry budgets are
validated. Streaming collection does not impose a total tenant row/page ceiling.

API JSON is limited to 512 KiB. Uploads allow two concurrent 8 MiB/50,000-row
operations. Per-process request limits are 1,200 reads/300 writes per minute per
trusted IP and 600 reads/200 writes per authenticated principal; they are not a
distributed quota. Exports retain source-specific limits and a fifteen-second
publication deadline.

Liveness is separate from provider access. Readiness fails for actual schema,
database/file maintenance or admission problems. Current-schema restore verifies
fingerprints, revokes sessions/execution authority, clears transient staging and
reconciles current ownership before reopening. Uncertain writes are not replayed.
Successful reopening requires no additional provider-enable or review step.

## Deployment

- Local deployment serves the web app and API from one origin.
- Azure runtime configuration uses 3 native Key Vault references: `TENANTS_JSON`, `SESSION_SECRET`, and `PGPASSWORD`. The PostgreSQL administrator password is provisioning/maintenance-only.
- Protect configuration, backups, tenant credentials and OAuth keys separately.
  Follow [operations](operations.md) for rotation, retention and restore.
- Run software checks, but verify actual first-run/sign-in/provider journeys in
  an authorized deployment before claiming they work.

## Audit and residual risk

Local Audit records actor, operation/job/correlation identifiers, minimal
before/after evidence and outcomes. Metadata is allowlisted on write and read;
tokens, raw provider errors and exported rows are excluded. Audit reads/exports
exclude records older than ninety days. This is append-only application audit,
not a hash chain or Microsoft Purview history.

Remaining limits include external revocation timing, process-local credential
loss, provider/API changes, Preview fields, licensing and cloud/data-source
availability. Local fixtures do not establish live consent, production coverage,
vendor-client compatibility or provider success.
