# Security model

Agent Control protects tenant data and authorizes agent changes. **Entra ID
proves identity; app roles govern application access; Microsoft authorizes
provider operations.** None substitutes for another.

Use [setup](deployment-setup.md) for configuration and the
[role and permission guide](user-roles-and-permissions.md) for grants and licensing.

## Access boundaries

| Data | Access boundary |
| --- | --- |
| Saved inventory, people, directory/license/activity sources and imported reports | Shared within the tenant among Viewer-capable roles |
| Delegated investigation evidence | Authorizing account and current sharing rules |
| Configured application investigation evidence | Exact tenant, configuration revision and shared application scope |
| Jobs, control receipts and capability evidence | Initiating account and current authorization |
| Local administrative Audit | Admin-only, scoped to the current tenant and account |

The [role matrix](user-roles-and-permissions.md#app-defined-roles) defines tasks
and inheritance. Management, configuration and local Audit require Admin, including
direct URLs/APIs. An app role never grants Microsoft permissions.

Saved tenant data is readable without the reader's Microsoft source-read
permission. Failed or limited-visibility collection preserves saved data and dates;
absence alone is not deletion. Account revocation fences that account's unfinished work
and private selections, not other accounts or completed tenant publications.

## Authentication and sessions

- Initial username domains select an exact configured tenant, not identity;
  unknown/overlapping domains are rejected. Each tenant has separate credentials.
  Verified Entra tenant/account claims—not identity headers or client labels—are authoritative.
- Sign-in uses session-bound, single-use state, nonce and PKCE. Return URLs must
  be local application paths, never network-path redirects.
- Browser sessions are opaque PostgreSQL records with an eight-hour maximum.
  Cookies are `HttpOnly`, `SameSite=Lax` and `Secure` on HTTPS. Stored data is
  allowlisted identity/roles, expiry/freshness, CSRF state and a random transaction
  handle—not tokens, OAuth codes/state/nonces, PKCE verifiers or MSAL caches.
  OAuth parameters pass through browser redirects; access/refresh/ID tokens are
  not returned as browser app data.
- MSAL caches and pending sign-ins are process-local. Restart loses them, not
  saved tenant data; reauthenticate when needed.
- Protected browser requests revalidate roles with Entra after five minutes;
  long-running reads refresh before evidence expires. Revocation is not instant.
  Removed tenants or changed application bindings invalidate sessions.
- Logout removes account credentials/sessions and advances authorization epochs.
  Earlier requests remain fenced after replacement sign-in; asynchronous results
  recheck authority before release.

## Browser request protection

Authenticated browser writes require a current session, applicable app role,
validated input, exact configured `Origin` and session-bound `X-CSRF-Token`.
Missing Origin is rejected without Referer fallback. Public `POST` sign-in also
requires exact Origin, but not an authenticated session or CSRF token.

API bearer requests use verified token authority, not cookie CSRF. Mixed bearer/
session-cookie credentials are rejected without fallback; browser-only and public
auth endpoints reject bearers. API tokens bind tenant, audience, client and scope.
App roles come from that assertion, not Graph roles. Assertions five minutes old
require newly issued authorization; browser role refresh cannot extend them.

API identity proof and restart-safe revocation checks are defined in the
[MCP/API contract](mcp-reference.md). Reported client metadata is attribution, not authority.

## Provider authority

| Operation | Provider credentials |
| --- | --- |
| Graph package collection, users, licenses, Office activity and user resolution | Configured tenant application credentials |
| Power Platform inventory/quarantine, management group lookup and package controls/readback | Initiating user's delegated credentials |
| Agent identity resolution and MCP/API investigations | Initiating user's delegated credentials |
| Browser investigations | Delegated credentials, or separately configured application/shared scope where supported |

**Read-only Graph sync starts automatically** after eligible sign-in while visible
and online, in fixed tenant scope. It needs no Microsoft directory/reporting role
for the user, Admin session, manual enablement, prior status check or acceptance.
Delegated MCP/API authentication does not change application collection to delegated.

Microsoft enforces grants, roles, licensing and resource/cloud support. Login,
token or readiness success proves neither full visibility nor later write access.
There is no credential-mode fallback. **Permissions > Check status** diagnoses
access; it does not grant consent, approve operations or enable workflows.

## Agent changes and durable work

- Browser/API controls share Admin handlers. Previews bind exact targets, source
  revisions, actor/session, effect, prestate and expiry. Interactive clients show
  the preview and request confirmation; scheduled clients submit the same current
  receipt, not an approval/bypass flag. The app supplies no scheduler.
- Names, origin labels, historical identity evidence and report-only matches
  cannot authorize writes. Studio quarantine/unquarantine and package block/access
  are distinct controls.
- Live prestate is checked before one-shot dispatch; provider state is verified
  afterward. Local locks do not serialize external administrators. Package APIs
  without ETag/If-Match cannot promise provider atomicity.
- Unknown post-dispatch outcomes are inconclusive. Explicit GET-only
  reconciliation never resends writes; idempotency keys recover original receipts,
  not authority for automatic write retries.
- Jobs retain intent/progress/ownership, not tokens or assertions. Admission and
  publication recheck initiating identity, session, capability and source/configuration.
  Cancellation/lost authority fences late results. Restart recovers status, not
  credentials: new provider work needs current same-principal authority. Safe
  unsent work may resume; uncertain writes are never replayed automatically.
  Partial exports are not completed results.

Optional [mutation diagnostics](mutation-canaries.md) retain their own approval
and restoration rules but never gate ordinary supported controls.

## Data handling and audit

- Saved reads use saved data; provider lookups/collection require separate
  authorization. Catalog and detail freshness are independent.
- Provider fields are allowlisted/minimized. Verified IDs establish associations;
  source text is untrusted data, not instructions.
- Concealment, missing evidence and partial coverage stay explicit; unknown is not
  zero or inactivity. CSVs escape spreadsheet-sensitive cells without losing
  whitespace, newlines or Unicode.
- Saved pages, details and export chunks recheck owner/configuration/source and
  session authority before release.

Local Audit retains actor, operation/job/correlation IDs, minimal change evidence
and outcomes—not tokens, raw provider errors, prompts, transcripts or exported rows.
Metadata is allowlisted on write/read; reads/exports exclude records older than
ninety days. It is append-only application history, not a hash chain or Purview history.

## Transport and secrets

The web app/API share one canonical origin; local HTTP is supported. Responses
use CSP, frame denial, `nosniff`, no-referrer and browser-feature restrictions;
HTTPS adds HSTS. API/HTML are `no-store`; hashed assets are immutable.
Azure trusts one reverse-proxy hop; local deployment trusts none unless a
controlled proxy is explicitly configured.

Provider credentials go only to validated HTTPS origins/route families. Redirects
are rejected except allowlisted Office downloads, which receive no Graph token.
Requests enforce response/record limits, deadlines and retry budgets; streaming
collection has no total tenant row/page ceiling. Request limits are per-process,
not distributed quotas.

- Azure runtime configuration uses 3 native Key Vault references: `TENANTS_JSON`, `SESSION_SECRET`, and `PGPASSWORD`. The PostgreSQL administrator password is provisioning/maintenance-only.
- Protect configuration, backups, tenant credentials and OAuth keys separately.
  Follow [operations](operations.md) for rotation, retention, shutdown and restore.

FastMCP has independent Host/Origin/resource and OAuth checks. Protect encrypted
OAuth state and signing/encryption keys separately from client secrets and
PostgreSQL backups. Changed identity requires reconnect; storage failures have
no plaintext/ephemeral fallback. Disconnect revokes MCP access/refresh credentials,
not API sessions, Entra consent or accepted work. Storage/worker limits and
recovery: [technical reference](mcp-reference.md),
[client setup](mcp-clients.md), [Azure deployment](azure-production-deployment.md).

## Administrator actions and limitations

| Need | Action |
| --- | --- |
| App access | Assign app roles; set Enterprise application **Assignment required?** to **Yes**. Missing Admin actions for a Viewer are intentional. |
| Application collection failure | Verify application credentials and consented grants; user reauthentication cannot repair them. |
| Delegated access failure | Complete requested sign-in/MFA/Conditional Access. Administrators must supply missing grants, Microsoft roles or licenses externally. |
| Origin failure | Use the canonical URL; ensure the controlled proxy preserves Origin. Do not bypass Origin/CSRF checks. |
| Restore | Follow current-schema recovery: verify schema, revoke sessions/execution authority, clear transient staging and reconcile ownership. Reopening needs no additional provider-enable/review step. |

External revocation timing, credential-cache loss, API/Preview changes, licensing
and cloud/source availability remain limits. Health and local fixtures cannot prove
live consent, full visibility, client compatibility or provider success. Verify
first-run, sign-in and affected journeys in an authorized deployment.
