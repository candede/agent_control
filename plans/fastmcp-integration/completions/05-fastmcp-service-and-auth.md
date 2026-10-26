# Phase 05 — FastMCP service and Entra authentication

## Phase Result

**Complete for the authorized local-source/synthetic-validation scope.**
Position **2 of the stable nine-row remaining manifest**, assigned
`05-fastmcp-service-and-auth.md`, was implemented without implementing06+.
The confirmed worker launch was **GPT-6.1 Sol (`gpt-6.1-sol`), `xhigh`**;
no nested agents were launched.

Repository/application root:
`/Users/candede/repos/agent365/agent_control`. Backend, frontend and the new
Python package are one application. Source baseline:
`d3a82a8d7673cb55300b6ab30fc3848d40554015`. Final validation was observed on
2026-10-16 UTC (the parent review uses its local date2026-10-17).

This result does **not** complete the independent04C live outcome, which remains
`deployment_pending`/unverified. Historical release/acceptance artifacts are not
MCP coding prerequisites or runtime feature-enable gates. `seha` was a planning
target only. There was no Always-Deploy contract or authorization to deploy.
The parent-owned campaign state and prerequisite review were preserved.

## Implemented

- An installable Python3.14 package, console entrypoint, fully pinned manifest
  and reproducible uv lock. The approved feed supplied the real FastMCP4.1.0
  implementation; tests execute that installed SDK, not a replacement provider.
- Tenant-specific AzureProvider/OAuthProxy, real discovery, interactive
  consent/CSRF binding, exact resource/redirect validation, S256 PKCE and
  authenticated stateful Streamable HTTP. Each HTTP request authenticates;
  an existing protocol session is not a credential.
- Public verified upstream recovery through
  `fastmcp.server.dependencies.get_access_token()`. Only the recovered Entra
  MCP-audience assertion enters fixed-tenant API OBO with MCP confidential
  credentials and `api://<apiClientId>/AgentControl.Access`. The proxy reference
  JWT, ID tokens and other audiences are not API assertions.
- Exact verified v2 issuer/tenant/scalar GUID audience/client/user/scope/time
  checks after maintained SDK signature verification. API assertions require
  recognized API roles and immutable issuance evidence no older than five
  minutes. API private native/guest identity proof remains API-owned.
- Independently protected signing, encryption-key-ring and confidential-client
  files; no derived/default keys. Maintained FileTreeStore,
  FernetEncryptionWrapper and cryptography MultiFernet persist only encrypted
  bounded OAuth connection material. A public sanitization hook hashes lookup
  filenames, including authorization-code lookup keys.
- Restart/binding verification, encryption rotation, signing rotation/reconnect,
  encrypted exact-reference revocation tombstones, bounded retention/capacity
  and real encrypted write/read/delete readiness. Plaintext storage fallback
  and automatic data reset are rejected.
- Authenticated downstream OAuth-client/session binding separate from reported
  client/agent labels. The signed original user binding survives checks across
  automatic/explicit refresh. Concurrent code redemption issues one pair only;
  refresh revoked while upstream work is awaited cannot publish fresh references.
- Typed `CanonicalApi.invocation(ctx)` and three useful named canonical reads:
  capabilities, capability-check progress and exact saved agent About pages.
  All other paths/methods are disabled by the closed adapter allowlist, not
  merely omitted from discovery. No arbitrary HTTP tool exists.
- Strict typed wire contracts preserve unknown/pending capability evidence,
  exact About selection/source/cursor, nulls and complete accepted payloads.
  Invalid/oversized responses fail explicitly; there is no truncation, join,
  recalculation, auto-recapture or empty-success fallback.
- Per invocation:60s wall deadline, four concurrent requests, eight physical
  requests, two OBO exchanges, <=30s per API request, <=10s per OBO exchange,
  and524288 aggregate UTF-8 output bytes. GET retries once only for429/503
  when a bounded honored Retry-After fits the remaining deadline. Cancellation,
  expiry/revocation after awaits and principal/client isolation are tested.
- Cookie-free fixed-origin requests without proxy-environment inheritance or
  redirects. Identity encoding is requested; unsolicited compressed bodies fail
  before decoding. Typed errors preserve API status/code/correlation/cooldown
  and bounded sanitized details; claims challenges use only their bounded
  standards-defined object. Refresh/OBO outages remain503/504, not invalid-grant
  destruction of a valid connection.
- Request-local SDK RPC metadata and initialize `client_info` produce exactly
  the API's bounded `X-Agent-Control-Mcp-Context` descriptor. Its optional labels
  remain reported, not authenticated vendor/agent evidence. Concurrent callers
  cannot reuse a connection's last caller, prompt or target ID.
- Public status-only health/readiness and authenticated safe diagnostics.
  POST input is capped at512KiB/30s, OAuth handling at30s, callback query at16KiB,
  and duplicate/mixed credentials are rejected. Callback diagnostic text is
  normalized and non-cacheable. SDK OAuth log records are normalized before
  handlers; access logs and SDK dotenv discovery/telemetry are disabled.
- Real SDK initialization and `tools/list` return an **empty business catalog**.
  A test-only tool exercises real request-local context; it is not registered by
  the production factory.

## Deleted

No existing backend/frontend runtime, schema, route, provider writer or
configuration was removed or replaced. Obsolete “MCP has no implementation”
documentation/prose expectations were updated to the actual phase05 state.
No compatibility aliases, shadow implementation or legacy fallback were added.

## Design and necessary complexity

The flow remains:

`SDK OAuth -> verified upstream MCP assertion -> API-audience OBO ->
existing canonical API/policy/principal/provider writer`.

There is one business authority/writer. The Python allowlist is an adapter
boundary for three named calls, not a second domain policy/catalog. Python has
no SQL/provider client, application data store, Redis, worker/scheduler, LLM,
approval engine, release-file reader or generic HTTP tool.

Inspection/tests of the **actual pinned SDK** required the following narrow
public-method, standard logging, public storage-extension or ASGI guards:

| Observed SDK behavior | Required application guard |
| --- | --- |
| AzureProvider clears `resource` before OAuthProxy checks it | Validate exact resource before the SDK and on authorize/token HTTP forms |
| JWT audience verifier accepts GUID/`api://` and arrays | Narrow signature-verified claims to exact scalar v2 GUID audience |
| Upstream access-token client ID is Entra `azp`, not the downstream DCR client | Public reference-JWT verification binds SDK session ownership to authenticated downstream client while retaining upstream token |
| SDK encryption wrapper reads plaintext as fallback | Reject non-encrypted envelopes before maintained decryption |
| File keys can contain authorization codes | Public FileTreeStore sanitization hook uses standard SHA256 lookup names |
| File atomic writes are not atomic code get-and-consume | Serialize the short public authorization-code exchange in the one service process |
| Revocation defaults off and access mappings otherwise survive until TTL | Enable public revocation options and encrypted exact-reference tombstones |
| MCP SDK2.3.0 incorrectly requires an optional public-client revocation secret field | Supply an empty absent field; SDK still authenticates clients/checks ownership |
| Refresh can finish after disconnect or return another user | Recheck original reference and signed user after await; reject/revoke newly issued references |
| SDK logs rejected codes verbatim and callback errors can reflect diagnostic text | Normalize authentication log records and callback errors without removing failure status/severity/location |

No SDK-private token store is accessed. No application encryption/signing
algorithm or OAuth token issuer was written. Standard hashing is lookup-name
privacy/revocation indexing; all encryption and verification remain maintained
SDK/cryptography implementations.

One process/worker owns the dedicated OAuth directory. Directories/files are
owned and group/world-inaccessible, without symlinks, under umask0077.
Storage stops before4096 files/64MiB, with256KiB maximum plaintext record and
conservative headroom. Every persisted entry is <=86400s; known shorter TTLs
stay shorter. Reference access lifetime is900s, refresh fallback86400s, upstream
renewal threshold60s. Readiness/startup culls expired entries; no scheduler was
invented.

Encryption rotation is `[new, previous]` (<=3 independent keys), with old keys
retained through the maximum24h record lifetime/cull. Signing rotation invalidates
references and requires reconnect. Emergency lost encryption keys require
operator-controlled disposal of the dedicated OAuth state, never app-data reset.
Disconnect revokes **both access and refresh**. Refresh-only revocation does not
invalidate a separate outstanding access reference (<=900s). OAuth revocation
is not tenant-consent revocation or account-wide API logout; API expiry and
internal epochs retain their own authority.

## Modified surfaces and cross-root impact

| Surface | Changes / impact evidence |
| --- | --- |
| `mcp/pyproject.toml`, `mcp/uv.lock` | New pinned Python runtime/dev/build dependencies and approved-feed lock |
| `mcp/src/agent_control_mcp/{__init__,__main__,config,errors,storage,origin,auth,models,api,service}.py` | Service, supported OAuth boundaries, encrypted SDK state, typed API adapter and request-local origin |
| `mcp/tests/{conftest,test_config_storage,test_oauth,test_api_origin}.py` | Synthetic RSA/JWKS/Entra/API transports; actual SDK OAuth/HTTP/context, isolation, recovery and limits |
| Backend `src/routes/mcpContractFeasibility.test.ts` | Coupled obsolete documentation assertion updated for the implemented foundation and reported-label trust; canonical operation table/policy/browser parity checks preserved |
| Backend runtime | Unchanged: method/path/policy, bearer/principal/credential, epoch/provider authority, DTOs and bounded origin consumer remain canonical. Seven affected suites pass |
| Frontend | Unchanged after producer/consumer tracing: same existing canonical API routes/DTOs and browser authentication; AST/browser parity fixtures still pass. No MCP dependency or initialization gate was added |
| `docs/{mcp-integration,deployment-setup,security-model}.md`, root `README.md` | Actual package/config/setup/SDK APIs, bounds, trust and lifecycle; exact test results, no live claims |
| `.gitignore`, `.dockerignore` | Exclude new local Python environments/caches only; no Dockerfile, image, Compose/service/volume/ingress or deployment implementation |
| This completion record | Required phase handoff; parent campaign/review files unchanged |

The shared canonical operation table was not changed or independently copied.
The Python parity fixture asserts each finite adapter route exists in that
authoritative table. Existing backend/browser parity and origin trust assertions
remain active. There is no changed backend/frontend wire contract to leave for
another phase.

## Validation

### Hypothesis and cheapest falsification

Initial hypothesis: the actual approved-feed FastMCP4.1.0 public API can recover
the verified upstream assertion and retain encrypted restart-safe OAuth state
without another credential authority. Inspecting/installing the actual pinned
wheel and exercising discovery/code/PKCE/verified upstream recovery were the
cheapest checks. SDK default-policy differences were corrected in narrow guards
rather than accepting the hypothesis uncritically.

### Actual environment and final commands

macOS; Python3.14.6; uv0.12.17; Nodev24.18.1; FastMCP/fastmcp-slim4.1.0;
MCP SDK2.3.0; HTTPX2 2.13.1; py-key-value-aio0.4.6; cryptography48.0.1;
pytest9.1.1; mypy1.20.2; Ruff0.17.0. The uv build backend0.12.17 is pinned
for build isolation, not installed as a runtime distribution.

From the application root:

```sh
cd mcp
UV_CACHE_DIR="$PWD/../.local/uv-cache" UV_PYTHON_DOWNLOADS=never \
  uv lock --check --offline \
  --index-url https://packagefeedproxy.microsoft.io/pypi/simple
.venv/bin/ruff check src tests
.venv/bin/ruff format --check src tests
.venv/bin/mypy src
.venv/bin/pytest --tb=short
```

**Passed, exit0:**82 locked packages; Ruff clean;14 Python files already
formatted; strict mypy clean on10 source files; **94 Python cases passed**
(no skips), final run10.17s.

From the application root:

```sh
NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
npm test --workspace backend -- \
  src/auth/mcpBearer.test.ts \
  src/auth/delegatedCredentials.test.ts \
  src/auth/requestPrincipal.test.ts \
  src/routes/mcpApiAuth.test.ts \
  src/routes/mcpContractFeasibility.test.ts \
  src/routes/policy.test.ts \
  src/routes/actionOrigin.test.ts \
  --reporter=dot
git diff --check
```

**Passed, exit0:** **7 suites /176 API cases**, no skips, final run2.87s.
Tracked diff whitespace and explicit line-by-line checks over the new package
manifest/lock/source/tests passed. Node typecheck/unused results belong to the
parent's independent review; they are not relabeled as worker-run checks here.

Tests cover discovery/initialization, consent/PKCE/resource and redirect binding,
wrong/mixed/expired/ID/app/audience credentials, missing/non-independent keys,
mode/symlink validation, ciphertext/plaintext absence including lookup names,
restart/key rotation/refresh denial/revocation, in-flight refresh revocation,
one-time concurrent code redemption, same-user different-client SDK session
isolation, concurrent principal/agent attribution, role freshness/OBO audience,
safe claims/cooldowns/statuses/correlation, retry/output/request/exchange limits,
cancellation, deadline/outage recovery and log/callback redaction.

Intermediate verification caught ordinary manifest/API-name, collection-creation
and test-lifespan/fixture mistakes; these were repaired and the complete suites
rerun. An obsolete Node documentation assertion was updated alongside the
owning current-contract text, not removed. The concurrent-code test initially
expected only400; the actual SDK rejects with401 too. It now requires exactly
one200 and one400/401, preserving the one-use invariant.

### Worker handoff feed and content identities

All package registry sources are exactly
`https://packagefeedproxy.microsoft.io/pypi/simple`; no public/default/extra
index or fallback was used. All locked artifact URLs are the Microsoft
`ms-feed-25.pkgs.visualstudio.com` backing feed advertised by that approved
proxy. An initially over-strict audit assertion expected the proxy hostname
also on artifacts; a direct read-only fetch of the approved FastMCP simple index
confirmed its advertised4.1.0 wheel hostname/hash. This was not a registry switch.
The source/index relationship and hash were verified without exposing credentials.

FastMCP4.1.0 wheel SHA256:
`cf19fd603315b48ef1829c8579431e77793feafdcbed51f0dc5607af10a24e9b`.

| Content | SHA256 |
| --- | --- |
| `mcp/pyproject.toml` | `3a2f2047d79c94ba8e0e32102bc96ea8e36832c724f428e4b73859a814a5bf4b` |
| `mcp/uv.lock` | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |
| Assigned phase prompt | `9cabaf0aa231dba5445d1796ac7c0960dca104610bab76c84fe5793ed7a4a445` |
| Roadmap `README.md` | `40fdb91510ba7d8a8c0c844bf3bf0405f87384aaf214c829cb0ccfee8561ad71` |
| `docs/mcp-integration.md` | `32e059c2cc0aa549982d11505380c27649041f1c1109c0b5523cc78b1690f1f5` |
| `docs/security-model.md` | `f702cca081458c7e82f8162fd2644705a1a341738c7310bc8afdf11e79a82b2d` |
| `docs/deployment-setup.md` | `76aad5d8eb1f47cf6436eddda68db39048cdc4cf02a5ec03322b9558a5b0ee4c` |
| Package content aggregate (16 files) | `1e52912e4f9928c6e6ba1d9c928f70f43fab9513bfefdfe83c66fd3b884c1f84` |

Aggregate algorithm: sort the relative POSIX paths of manifest, lock,
`mcp/src/**/*.py` and `mcp/tests/*.py`; feed each `path + NUL + file bytes + NUL`
to SHA256. It excludes environments, caches and completion/docs, avoiding a
self-referential record hash.

### Parent integration review and final proof

The parent reviewed the changed OAuth/storage/service/adapter/origin contracts,
their canonical backend DTOs and operation table, coupled documentation/test
changes and next-phase preconditions. The backend remains the sole business
authority; the browser requires no MCP changes. No replacement writer, database,
business tool, infrastructure or runtime acceptance gate was introduced.

Two concrete phase-owned findings were repaired directly:

- OBO challenge forwarding now matches the existing API's
  `boundedClaimsChallenge` grammar: exactly an `access_token` object, at most16
  claim names, bounded names/values, and only `essential`, `value`, `values`.
  ID-token requests, arbitrary nested diagnostics and malformed fields stay
  an explicit401 without unsafe challenge details. Nine new negative cases
  exercise the actual OBO/API adapter path.
- Readiness no longer catches every exception without diagnostics. It handles
  known configuration/OS/maintained-storage errors with503 and a safe operator
  log, without secret exception text; unexpected defects propagate. One new
  HTTP regression verifies both response and log redaction.

Focused repair check:

```sh
cd mcp
.venv/bin/pytest tests/test_api_origin.py tests/test_oauth.py \
  -k 'claims_challenge or challenges_share or readiness_failure' --tb=short
```

**Passed:11 cases,64 deselected**, exit0. All four edited Python files already
matched Ruff formatting.

The parent then reran the complete documented Python lock/lint/format/type/test
commands and the seven-suite API selector above:

- **104 Python cases passed, no skips,11.74s**.
- Offline lock check:82 packages; Ruff/format clean on14 files; strict mypy
  clean on10 source files.
- **7 API suites /176 cases passed, no skips,3.00s**.
- `npm run typecheck --workspace backend`: passed.
- `npm run check:unused`: passed.
- `git diff --check`: passed.
- Final local Markdown target validation:48 links across7 changed/review documents
  resolved. External links/live services were not treated as tested.
- Explicit whitespace checks over19 untracked package/record files passed.
  The exact owned `.local/mcp-tests` scratch directory was removed and absence
  verified; ignored development dependencies/caches remain available.

Final identities supersede the worker-only identities above where changed:

| Content | Final SHA256 |
| --- | --- |
| `mcp/pyproject.toml` | `3a2f2047d79c94ba8e0e32102bc96ea8e36832c724f428e4b73859a814a5bf4b` |
| `mcp/uv.lock` | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |
| `docs/mcp-integration.md` | `0692db114738cd770b757584761d898c1c40e0214edc095871859e426e05fc1e` |
| `docs/security-model.md` | `9e91116d7722088543769e68fef17946e5eef98718f3473fa7fcfdc2fbafdc03` |
| `docs/deployment-setup.md` | `9277e6a4ab2ddf67a4d8f685481c25c94be99ed1d3b54695f66b79edef3c3af6` |
| Package content aggregate (same16-file algorithm) | `659504d1ad6a4ae6abaa6b3aec548b7af98a4ceab9e7cdfea7c10bde9791c8cd` |

The phase prompt/roadmap identities are unchanged. These are local content
identities, not a deployed artifact or accepted production revision.

### Unavailable / not run

- **Unavailable, reused prerequisite evidence:** real SQL suites lack a
  separately named `agentcontrol_test_*` database. The parent review records
  `mcpReadContracts`, `sharedAgentControls`, `auditOriginHttp` stopping at that
  safeguard and SQL `auditOrigin` setup unavailable. No guard was bypassed,
  database provisioned or SQL fixture result counted as passed.
- **Not run / not authorized:** live Entra native/guest consent, real client-host
  interactive recovery, real downstream grants/account mapping, provider calls,
  account-wide external revocation, deployed HTTPS/discovery/ingress, container
  image/mount ownership, restart on a deployed volume and production operation.
  Synthetic SDK/JWKS fixtures are not evidence for those outcomes.
- No listener or service was left running. Only approved package/index reads
  and local package installation/validation occurred; no Docker commands,
  database operations, Entra mutation, ingress/deployment, commit, push or
  branch creation occurred. No `.env`/real secret file was read.
- Owned synthetic test state/install scratch under `.local/mcp-tests` and
  `.local/python-work` is removed after final verification. The local `.venv`
  and approved dependency cache remain ignored for reproducible parent checks.

## Autonomous Decisions

- Pin the available approved-feed4.1.0 implementation and its real HTTPX2
  dependency rather than coding against a hypothesized SDK or legacy HTTPX.
- Reuse maintained SDK OAuth, verification, encryption, file atomicity and TTL;
  narrow observed permissive defaults only at documented/public boundaries.
- Keep one-process OAuth persistence and a short code-consumption lock instead
  of adding a database, distributed lock, state machine or service registry.
- Keep API tokens invocation-local; no cross-user token cache or duplicated
  provider credential authority.
- Implement three concrete finite typed reads, including complex saved About
  pagination/source preservation, instead of a generic HTTP shell or premature
  business tool catalog.
- Separate authenticated opaque OAuth-client/session binding from reported
  vendor/agent labels; preserve existing API trust semantics.

## Decision Needed

None remains for this authorized phase. SDK limitations were addressed within
the approved architecture and recorded above; no architecture, live authority,
acceptance or later-phase boundary was silently changed.

## Residuals and Next Preconditions

No known failing owned local check or deferred phase05 implementation defect
remains. Live SDK/client/tenant and deployment behavior is still unverified;
an authorized operator owns that evidence, not this synthetic completion.
Single-process persistence,24h retained state,900s outstanding-access disconnect
bound and explicit reconnect/key-loss behavior are implemented constraints, not
unbounded/instantaneous revocation claims.

Phase06 can consume the tested authenticated typed adapter and add its assigned
named read tools/DTOs while extending the finite allowlist from the canonical
operation table. It needs no historical release file or extra runtime
feature-enable ceremony. Phase07 mutation/control tools,08 container integration,
09 broader client/live qualification and subsequent deployment/production work
were not implemented. Their exact action authority and required real evidence
must be established in their owning phases. The independent04C live status and
any parent campaign acceptance state remain unchanged.
