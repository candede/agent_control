# MCP clients and ordinary workflows

Checked **2026-10-17** against the primary sources below. Service **0.1.0** uses
Python **3.14.6**, FastMCP **4.1.0**, MCP SDK **2.3.0**, httpx2 **2.13.1** and
protocol **2025-11-25** in the local fixtures. VS Code installed here is
**1.142.0**, commit `6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`. Standalone
Copilot CLI **1.0.78** is installed (version/help only, no sign-in attempted);
the public release checked is **1.0.98** (2026-10-14). OpenCode **1.19.3**
(2026-10-16) was source-checked, not installed; Claude Code is not installed.
Vendor web products roll continuously: the research date and
source revision/date, not an invented client binary version, identify them.

**These are client-specific recipes, not universal compatibility certification.**
The [phase 09 record](../plans/fastmcp-integration/completions/09-client-workflows-and-evaluation.md)
separates SDK wire-profile tests, canonical API/SQL/browser-adapter evidence and
unavailable vendor-client/model/provider proof. No authorized synthetic account
and public endpoint were supplied. Do not create ingress/tunnels, register apps,
grant consent, use customer data or run paid models to reproduce local tests.
Normal configured application use has no release/qualification/enable prerequisite.

## Checked-in client settings and evidence

The files below contain **synthetic HTTPS placeholders**, not live connections.
Merge the relevant entry into an existing client configuration; do not overwrite
other servers or copy every product's file into the same client. Replace
`https://mcp.example.test/mcp` with the approved, externally reachable MCP URL.
Do not copy these files into a live configuration as part of running tests.

| Client/surface | Actual configuration or setup recipe | Protocol/config evidence here | Actual vendor sign-in/tool/refresh evidence |
| --- | --- | --- | --- |
| VS Code GitHub Copilot agents | [`vscode/mcp.json`](../mcp/examples/clients/vscode/mcp.json) → `.vscode/mcp.json` | Native HTTP/DCR/resource/S256 implementation source; root-path callback validation must permit its exact registered URIs | Unavailable; installed version or SDK profile alone is not a pass |
| Standalone GitHub Copilot CLI (`copilot`) | [`copilot-cli/mcp-config.json`](../mcp/examples/clients/copilot-cli/mcp-config.json) → `~/.copilot/mcp-config.json`, or merge into project `.mcp.json`/`.github/mcp.json` | Configuration/fixed-port release notes; exact current callback and endpoint-by-endpoint OAuth requirements **not implementation-verified** | Unavailable; help/version only; exact-root setup acceptance does not establish native behavior |
| OpenCode | [`opencode/opencode.json`](../mcp/examples/clients/opencode/opencode.json) → project `opencode.json` | 1.19.3 accepted JSON schema/provider and pinned SDK resource/S256 implementation; SDK callback registration test | Unavailable; not installed |
| Claude Code | [`claude-code/.mcp.json`](../mcp/examples/clients/claude-code/.mcp.json) → project `.mcp.json` | Documented `oauth.callbackPort`; existing SDK OAuth profile | Unavailable; not installed |
| Claude Desktop / web / Cowork | [Account remote-connector UI](#web-and-desktop-remote-connector), not a remote `claude_desktop_config.json` entry | Documented DCR/hosted callback; existing SDK profiles | Unavailable |
| Copilot Studio → Microsoft 365 Copilot | [OAuth onboarding wizard](#copilot-studio-and-microsoft-365-publication); optional [`agent-control.openapi.yaml`](../mcp/examples/clients/copilot-studio/agent-control.openapi.yaml) custom-connector transport import | DCR/Streamable transport documented; native resource/S256 behavior **unavailable**; SDK callback is **synthetic** | Unavailable, including publication/end-user refresh |
| GitHub Copilot **cloud coding agent** / code review | [`github-cloud/mcp-config.json`](../mcp/examples/clients/github-cloud/mcp-config.json) → repository **Settings > Copilot > MCP servers**, **transport-only** | Current header/Agents-secret schema; **remote OAuth unsupported by vendor** | Unavailable; **not full delegated OAuth support** |
| Legacy GitHub CLI extension (`gh copilot`) | No MCP configuration; [migrate to standalone CLI](#standalone-github-copilot-cli-not-gh-copilot) | Archived/deprecated product, not a current MCP client | Not supported |

Hosted Claude has **no documented remote-connector JSON import**. An empty
Desktop file or an HTTP entry in its stdio-only local configuration would not
connect this service, so neither is supplied. Studio's YAML is the documented
**custom connector transport definition**, not an OAuth configuration or a
Microsoft 365 agent manifest. Use the wizard for DCR and copy its callback;
there is no universal M365 MCP settings JSON to import.

“Any downstream MCP consumer” (the user's `*`) means no vendor-client allowlist.
It does **not** mean `clientId: "*"`, a wildcard Entra application/audience,
anonymous access, or broader API caller trust. DCR already issues opaque
downstream IDs; keep the server's Entra GUID/credential, tenant, scopes,
audiences, API roles and delegated OBO authority unchanged. Tool-filter
`["*"]` in the standalone CLI sample only exposes the catalog; it is not an
OAuth identity or blanket tool execution approval.

## Shared service contract

Start from [deployment setup](deployment-setup.md#local-fastmcp-foundation-phase-05)
and the [optional local container](deployment-setup.md#optional-local-mcp-container).
The [local server-settings sample](../mcp/examples/local-settings.example.json)
belongs to that documented `ConfigureMcp` wizard, **not** to any client below.
Use setup to configure the exact approved callbacks and confidential server
identity; do not put its Entra credential or generated keys in client settings.
The example origin below is synthetic; use an operator-approved existing origin.

| Property | Exact current contract |
| --- | --- |
| Transport/resource | Streamable HTTP `https://mcp.example.test/mcp`, not `/sse`, stdio, the API origin or an Entra token URL |
| Unauthenticated request | HTTP 401, `WWW-Authenticate` points to `https://mcp.example.test/.well-known/oauth-protected-resource/mcp` |
| Resource metadata | `resource` equals the full configured MCP URL; `authorization_servers` names the origin-root MCP OAuth issuer; `scopes_supported` is `["Mcp.Access"]` |
| Authorization metadata | `https://mcp.example.test/.well-known/oauth-authorization-server` advertises `/authorize`, `/token`, `/register`, `/revoke` and S256 |
| Downstream client | DCR `/register` with JSON metadata, public `token_endpoint_auth_method:"none"`; all requested redirect URIs must be exactly allowlisted. Explicit canonical root `/` callbacks are accepted; no wildcard hosts/ports/paths, nonloopback HTTP, queries or fragments. CIMD and ID-JAG/enterprise-managed auth are **not** enabled |
| Login | Authorization code + S256 PKCE + state. Both `/authorize` and form-encoded `/token` require `resource=https://mcp.example.test/mcp`; downstream scope `Mcp.Access` |
| Two separate callbacks | Entra returns to **`https://mcp.example.test/auth/callback`**. MCP then returns to the exact **client's** allowlisted callback. Never register the vendor callback as the MCP application's Entra callback |
| Upstream scopes | SDK requests `api://<MCP-client-guid>/Mcp.Access openid profile offline_access`; delegated OBO requests only `api://<API-client-guid>/AgentControl.Access`. Never paste API/Graph tokens into client settings |
| Refresh | Form POST `/token`, `grant_type=refresh_token`, same downstream `client_id`, exact `resource`, current refresh token. Store the returned rotated refresh token. Revocation returns `invalid_grant` (pinned SDK currently HTTP 401); reconnect, not a mutation retry |
| Authorization | Per-user delegated identity, API Viewer/Admin and actual provider permissions. DCR client names and tool annotations grant no permission |
| Catalog | **124 tools**, one typed **`request` object** per call, including `{"request":{}}` for empty input. Discover the current schemas; no resources/prompts or client scheduler are implemented by this service |

### Native OAuth evidence matrix

**Source-backed capability is not observed interoperability.** No native client
below completed this FastMCP service's login, refresh and tool journey here.
The Python SDK profiles construct compliant requests themselves; they do not
execute VS Code, Copilot CLI, OpenCode or Studio code. Likewise, a sample's URL
matching server discovery does not prove that a native client sends `resource`.

| Native consumer | `resource` on `/authorize` | `resource` on `/token`: code / refresh | S256 / code verifier | DCR with CIMD disabled | Current FastMCP compatibility classification |
| --- | --- | --- | --- | --- | --- |
| VS Code 1.142.0 native/local host | **Source-backed**, when protected-resource metadata is discovered and OAuth issuer/endpoints are the MCP service, not Microsoft auth | **Source-backed / source-backed**, with the same condition | **Source-backed / source-backed** | **Source-backed** when `registration_endpoint` exists and no static client ID is supplied | Protocol-capable by source; exact root callbacks are accepted by aligned setup validators; actual vendor journey **unavailable** |
| Standalone Copilot CLI 1.0.98 | **Unavailable endpoint-specific proof**; release 1.0.4 says “proper resource indicators” generally | **Unavailable / unavailable endpoint-specific proof**; refresh capability is documented | **Unavailable in reviewed public implementation/docs**; not inferred from the MCP specification | **Documented capability**, not a reviewed current registration implementation | Configuration example only; prospective root callback is now admissible if explicitly allowlisted, but exact native callback/strict resource/S256 interoperability remains **unverified** |
| OpenCode 1.19.3 → MCP TypeScript SDK 1.29.0 | **Source-backed if protected-resource metadata was obtained** | **Source-backed / source-backed**, with the same condition | **Source-backed / source-backed** | **Source-backed**; absent cached/static client information and no advertised CIMD selects DCR | Protocol-capable by source with the explicit non-root callback; actual vendor journey **unavailable** |
| Copilot Studio standard harness / published M365 agent | **Unavailable** in the reviewed vendor guide | **Unavailable / unavailable** in that guide; code/refresh exchanges are described, not their complete bodies | **Unavailable** in the reviewed vendor guide | **Documented** Dynamic discovery/Dynamic DCR | Wizard/transport recipe only; strict FastMCP OAuth compatibility and published end-user flow **unverified** |

The exact source chains, rather than generic “supports OAuth” claims, are:

- **VS Code [VS3, VS5]:** `createAuthMetadata` reads the 401 metadata challenge,
  fetches protected-resource metadata and selects its first authorization
  server. `ExtHostAuthentication.$registerDynamicAuthProvider` calls
  `fetchDynamicRegistration`. Native
  `NodeDynamicAuthProvider._createWithLoopbackServer` adds S256 and `resource`; inherited
  `DynamicAuthProvider.exchangeCodeForToken` adds `code_verifier` and
  `resource`; `exchangeRefreshTokenForToken` also adds `resource`.
  `_resourceIndicator` returns metadata's resource **except for Microsoft
  authorization servers/endpoints**. This service's own origin-root OAuth
  issuer/authorization/token endpoints therefore matter; pointing the client
  directly at Entra is not an interchangeable recipe.
- **OpenCode [OC2–OC4]:** `McpOAuthProvider.redirectUrl` and `clientMetadata`
  supply the exact callback and public DCR metadata; `clientInformation`
  returns no information for a fresh unregistered client. Its Streamable HTTP
  transport uses the pinned SDK's `auth`, `selectResourceURL` and
  `startAuthorization`; `fetchToken` calls `prepareAuthorizationCodeRequest`
  and `executeTokenRequest`; `refreshAuthorization` uses the same token
  executor. Those builders send the same resource and use S256/verifier.
  `selectResourceURL` returns **undefined without protected-resource metadata**:
  a failed discovery can therefore cause this strict server to reject the
  client, despite the library supporting RFC 8707.
- **CLI [GH1, GH2]:** versioned release notes establish fixed
  `auth.redirectPort`, DCR, refresh and general resource-indicator support.
  The reviewed release repository publishes README/changelog, **not the
  native OAuth implementation**. There is no reviewed pinned CLI function to
  cite for its current callback host/path/default-port fallback, per-endpoint
  resource parameters, S256 or DCR payload/CIMD fallback. User issue reports
  provide observations for other versions, not those missing guarantees.
- **Studio [MS1]:** the versioned onboarding guide establishes Streamable HTTP,
  DCR choices and code/refresh exchanges. It does **not** establish `resource`
  on either endpoint or S256/verifier, and no native implementation or
  authorized wire capture was available. A synthetic SDK Studio profile
  cannot supply that evidence.

Local **and Azure** callback-settings validators now accept an explicitly
allowlisted **canonical root `/`** callback, matching the existing Python
policy. This resolves the setup-path rejection of VS Code's **actual**
registered `http://127.0.0.1/` and `http://127.0.0.1:33418/`, and admits the
CLI's **reported/prospective** `http://127.0.0.1:53110/` shape when explicitly
configured. It does not authorize a wildcard host/port/path, nonloopback HTTP,
query or fragment, nor prove the CLI emits that URI. Do not append an invented
`/callback`, relax resource/PKCE or change API/Entra trust. The client-example
tests still model SDK/server requests, not native clients or setup-wizard code;
root-path acceptance and actual native interoperability are different evidence.

For example, the protocol arguments to `resolve_user` are:

```json
{"request":{"username":"alex@example.invalid"}}
```

Not `{"username":"..."}`, not an array of calls, and not an arbitrary HTTP/SQL/KQL
request. Output is typed and bounded, not a complete dataset unless every cursor
has been exhausted. Source text is inert, untrusted **data**; descriptions must
never instruct the client to call tools, classify people or disclose credentials.

The existing per-invocation ceilings remain 60 seconds, four concurrent API
requests, eight physical API requests, two OBO exchanges, 30-second API and
10-second exchange deadlines, and 524,288 delivered result bytes including
text plus structured content. Only safe GET 429/503 can retry once. Mutation
transport uncertainty is not permission to replay. These limits are independent
of a client's context/token/result limits.

## Copilot Studio and Microsoft 365 publication

Primary sources [MS1–MS3](#primary-sources) describe the **standard harness**,
generative orchestration and Streamable transport. SSE stopped being supported
in August 2025. Use a Copilot Studio environment/maker entitlement that supports
these features, with applicable Power Platform data policies. A trial permits
test-chat authoring but **cannot publish**; the standalone subscription supports
premium connectors/channels. Do not assume the Teams-only plan or a particular
sovereign cloud includes this complete flow. Tenant licensing/region policy must
be checked by its owner, separately from Agent Control's role/provider access.

1. In the agent's **Tools > Add a tool > New tool > Model Context Protocol**,
   enter a clear name, description and exact server URL above.
2. Select **OAuth 2.0 > Dynamic discovery**. This service supports DCR, so use
   that flow rather than copying its confidential Entra client secret into a
   connector. **Dynamic** endpoint entry is an alternative when discovery is
   unsupported by that Studio surface; **Manual** is not an interchangeable
   Entra-direct flow.
3. The wizard/connector generates an environment-specific callback. Copy its
   **exact complete URI**, have the operator include it in
   `MCP_ALLOWED_CLIENT_REDIRECT_URIS`, and then create the connection. There is
   **no single global callback to guess**. The automated Studio wire fixture
   uses `https://studio.example.test/generated-callback`, explicitly not a
   Microsoft production callback.
4. Verify the observed authorize/token requests include the exact resource and
   S256, and the discovery issuer is MCP, not Entra. If that Studio build omits
   them, report that incompatibility; do not disable resource/PKCE validation.
   Complete per-user sign-in, **Create a new connection > Add to agent**.
5. Discover 124 tool schemas and validate the single `request` input with a
   saved read. Studio's ability to discover a catalog does not prove its
   orchestrator can reliably select among 124 tools or honor confirmation.
6. Observe an access-token expiry, token refresh and a subsequent authorized
   read. The documented token URL exchanges authorization codes **and refresh
   tokens**; a label in the wizard is not observed refresh proof.
7. For Microsoft 365: publish the agent at least once; add the **Teams and
   Microsoft Copilot** channel, select **Make agent available in Microsoft
   Copilot**, share/install for the intended synthetic users. Organization-wide
   store distribution may require real Teams/admin approval. Publishing a
   connector across tenants/certification is **not** required for a private
   agent connection, and none was performed here.
8. Test the published agent separately: each end user's connector authorization,
   role, private selection, tool invocation and refresh must remain intact.
   Author test-chat success is not Microsoft 365 publication proof.

For manual diagnostics, endpoints are MCP `/authorize`, `/token` (also refresh)
and DCR `/register`; scope is `Mcp.Access`. A manual connector additionally needs
a legitimately registered **downstream** OAuth client and exact generated
callback. Do not invent a registration store/secret, set API-key/None auth, or
substitute `AgentControl.Access` as the downstream scope to make a wizard pass.

For the optional Power Apps **Import OpenAPI file** route, start with the
[checked-in YAML](../mcp/examples/clients/copilot-studio/agent-control.openapi.yaml)
and change its `host` to the approved MCP host. It describes `/mcp` with
`x-ms-agentic-protocol: mcp-streamable-1.0`; it does not enumerate the 124 tools
as REST operations or establish a connection. Configure the same **per-user
OAuth 2.0/DCR** connection above. Import success alone is not authentication
success. Never leave authentication at None/API key, fill a confidential
Entra credential into this file, or guess the generated environment callback.
For Microsoft 365 agents use the published Studio/channel flow above; do not
confuse it with GitHub cloud agents, Microsoft Agent 365 registration, or an
arbitrary declarative-agent manifest.

## VS Code / GitHub Copilot

[VS1–VS4](#primary-sources): MCP was GA in VS Code 1.102; the older documented
minimum is 1.99. Use a current supported build. Copilot Free, Pro, Pro+, Max,
Business and Enterprise access is subject to usage and current product terms;
the organization's **MCP servers in Copilot** policy governs Business/Enterprise.
That policy is not an Agent Control feature flag.

Use **MCP: Add Server > HTTP**, or merge the
[VS Code sample](../mcp/examples/clients/vscode/mcp.json) into `.vscode/mcp.json`:

```json
{"servers":{"agentControl":{"type":"http","url":"https://mcp.example.test/mcp"}}}
```

Current Copilot harnesses also support a portable workspace-root `.mcp.json`:

```json
{"mcpServers":{"agentControl":{"type":"http","url":"https://mcp.example.test/mcp"}}}
```

Use **one** configuration location. The current configuration reference, not
old personal `settings.json` examples, owns the applicable harness format.
Do not add static bearer headers, secrets, `oauth.enterpriseManaged`, invented
DCR-enable flags, npm helpers or a second proxy.

VS Code **1.142.0's actual public DCR implementation** requests **all four**
redirects, even when only one is used for this sign-in. The operator must
approve these exact four (including slashes), not only the selected callback:

```json
["https://insiders.vscode.dev/redirect","https://vscode.dev/redirect","http://127.0.0.1/","http://127.0.0.1:33418/"]
```

The installed version's source uses S256 and refreshes a refreshable session
through `grant_type=refresh_token`; the native flow tries port 33418. If it must
fall back to a different port, this server's **exact** redirect policy refuses
it. Free that port/use an already approved callback; do not allow wildcard ports.
Insiders/web/remote/harness changes need their own observed callback, not a
claim that these four cover all future clients.

Start via **MCP: List Servers**, complete browser OAuth, inspect **Show Output**
with secrets redacted, enable the appropriate tools in the chat tool picker,
and issue a saved-read request. Confirm catalog count/schema, resource, expiry/
refresh, reconnect and exact preview/confirmation in the actual chosen harness.
Workspace trust/start prompts and “allow tool” settings are **not** confirmation
of the current target receipt. Avoid blanket tool auto-approval for interactive
controls. Clear/reconnect auth through the client's account/MCP controls after
revocation; never retry a control merely because OAuth refreshed.

## Claude web, Desktop, Code, API and Cowork are distinct

[CL1–CL6](#primary-sources) verify the following, not a blanket “Claude works”.

| Surface | Supported edition/route and current limitations |
| --- | --- |
| Claude web | Custom remote connectors: Free (one custom connector), Pro, Max, Team, Enterprise. Team Owners/Primary Owners, or Enterprise roles permitted to manage Libraries, add organization connectors; members sign in individually |
| Claude Desktop | Same **remote account connector**, same hosted callback, cloud-originated network traffic even on a desktop. A local desktop extension/`claude_desktop_config.json` is a different stdio mechanism and does **not** turn this HTTP service into a local/Cowork connector |
| Claude Code | Independent CLI/native OAuth and loopback callback, not the hosted callback; requires actual Code entitlement/billing. No local CLI was available here. Never use a paid API key as proof of approved use |
| Claude Messages API | Remote MCP connector **beta `mcp-client-2025-11-20`**, tool calls only; publicly reachable HTTP endpoint and caller-supplied `authorization_token`. Not a web subscription benefit, OAuth login/refresh UI, stdio client, or server-side human-confirmation system |
| Cowork | Primary docs explicitly support MCP connectors. Paid Pro/Max/Team/Enterprise; macOS and latest Windows desktop; web/mobile beta on Pro/Max/Team and admin-enabled Enterprise. Cloud/unified experience varies by rollout/organization. It loads account connectors at session start, **not** Code's `~/.claude` configuration. No Cowork run was available here |

### Web and Desktop remote connector

1. In **Customize > Connectors > Add custom connector**, enter the exact HTTPS
   MCP URL. Organization owners add it first where required.
2. Choose **Sign in now**, OAuth client **Register automatically** (DCR).
   Current Claude may recommend **Use Claude's published identity** (CIMD);
   this server explicitly disables CIMD. Do not choose a mechanism the server
   does not advertise. No fixed request header/shared organization credential
   can replace this per-user delegated model.
3. Allowlist exactly **`https://claude.ai/api/mcp/auth_callback`** in the MCP
   downstream redirects, not `claude.com`, `/callback`, or the Entra callback.
4. Sign in; verify discovery points to MCP, resource matches `/mcp`, S256 and
   current refresh work, then make a saved read. Claude uses the first issuer
   in `authorization_servers`. Hosted clients connect from Anthropic's cloud;
   a Desktop-visible loopback/VPN-only endpoint is insufficient.
5. Claude documents proactive refresh up to five minutes before expiry and
   reactive refresh on 401, endpoint deadlines of 10 seconds (30 for refresh),
   and hosted tool limits around 150,000 characters/240 seconds. The service's
   60-second/byte bounds are still authoritative. Neither set of limits proves
   the client's context can hold the entire dataset; use bounded pages.

### Claude Code

The current CLI documents a **fixed** callback option, compatible with this
server's exact allowlist. Have the operator approve
`http://localhost:53109/callback` (example dedicated unused local port), then:

```sh
claude mcp add --transport http --callback-port 53109 agentControl https://mcp.example.test/mcp
claude mcp login agentControl
```

Alternatively use `/mcp` interactively. Do not run those commands here against
an unapproved endpoint/account. Default random-port registration and CIMD's
port-agnostic recommendations are **not supported by this server's exact
redirect policy**. A port conflict is an explicit limitation, not a reason to
weaken it. The docs identify a redirect mismatch issue in Code 2.1.229; use a
current fixed-callback-capable build and record its actual version.

Code securely stores/refreshes OAuth credentials; on 401 it can refresh,
reconnect and retry a request once. Do **not** rely on that generic behavior for
mutations: retain exact operation identity, inspect saved status and avoid
blind resubmission. Headless `claude -p`/Agent SDK runs cannot conduct an
interactive OAuth flow; sign in beforehand in an authorized interactive client.
No “bypass permissions” flag is part of this recipe.

### Claude Messages API

The API's `mcp_servers` entry uses `type:"url"`, `url`, a caller-chosen `name`,
and an externally acquired **MCP-resource** `authorization_token`; `tools`
includes `{"type":"mcp_toolset","mcp_server_name":"agentControl"}`. Use
`anthropic-beta: mcp-client-2025-11-20`, not the deprecated 2025-04-04 beta.
The host application owns OAuth storage/rotation/revocation and replacing that
token on later calls. API connector support for sending a token is **not**
support for doing DCR/browser login/refresh for you.

No executable paid-model request, credential example or external data export
is needed for local proof. Interactive applications must split preview/display
and execution across their own user-confirmation boundary. An API model call
with every tool enabled does not establish consent. A separately authorized
external scheduler may use the same receipt without a human pause, below.

### Cowork

Add/connect the **account** connector as for hosted Claude and start a fresh
Cowork task so the connector list is synced. Hosted callback/discovery/OAuth/
cloud reachability rules apply. Actual Cowork organization permissions may
offer per-task/always-allow/automatically-approve modes; these are client
policies, not a server-authenticated human approval or provider grant.
For interactive controls require a fresh displayed preview and confirmation
for each execution. Do not infer scheduled authority from a Cowork feature,
paid plan or a saved “always allow” preference. Any other cowork product not
listed here has **no researched/observed compatibility claim**.

## Ordinary workflow recipes

Use the current tool schema, not a prompt-side business join. The existing
[API semantics](mcp-integration.md), [usage constraints](official-usage-import.md)
and [security boundary](security-model.md) remain authoritative.

An API row-count ceiling is not a guaranteed MCP byte ceiling: the final text
plus structured result must still fit524288 UTF-8 bytes. For wide mixed/package
inventory pages start with explicit `limit:25`, retain the same selection/query
and exhaust **every** cursor. Real SQL qualification traverses all103 mixed
agents in five such pages, including complete separately paged About. A100-row
wide page correctly returns413 `output_limit`; it is not an empty list or a
reason to increase the ceiling. A safe read may use a smaller limit with the
same selection and continuation; never recapture or truncate to hide missing
rows. The narrow native-only C example below separately fits100+1. Stay within
the whole-workflow32-call/4MiB/180s budgets; otherwise disclose the incomplete
scope rather than claiming completeness. This is not a write-retry policy.

### A: exact person, every relationship page and full About

1. `resolve_user({"request":{"username":"alex@example.invalid"}})`. Require
   `state:"resolved"` and non-null `objectId`; retain returned report selection.
   Names, concealed identifiers, duplicate usernames, missing directory or
   ambiguous matches are **not** permission to choose a person. Native/guest
   API-private identity uses verified MSAL home account, not guessed `oid.tid`.
2. `capture_agent_inventory({"request":{"query":{"inventoryScope":"all"}}})`
   supplies the complete authorized inventory selection. Do not substitute a
   narrowed creation/platform filter for relationship scope.
3. For **each** `used`, `created`, `owned`, `modified`, call
   `list_user_agent_relationships` with exact `objectId`, report `selectionId`,
   `inventorySelectionId`, relationship and `limit:50`. Repeat with that exact
   selection pair and `page.nextCursor` until null. A count/first page is not a
   complete list. Keep report-only IDs and `sourceReferences`; no guessed join
   to similarly named inventory. Missing counts remain null, not zero.
4. For each requested agent/source About, exhaust `list_agent_members` using
   `nextCursor`; choose the exact returned source identity/scope/generation.
   `read_agent_about` takes `recordId`, inventory `selectionId`, `sourceScopeId`,
   `sourceIdentity`, `field:"long"|"native"|"short"` and optional cursor.
   Repeat until null; concatenate only that exact source/field/generation.
   Check total/returned UTF-8 bytes. Do not replace long/native text with a
   short preview or stop at 2,048 characters. `state:"missing"` stays unknown.
5. Cite exact person/agent/report/source/selection references and qualify any
   partial pages. In corpus A: **99 used** (98 canonical + one report-only),
   **3 created**, **2 owned**, **1 modified**; long About 101, native About 102,
   missing About 103. Unicode and adversarial suffixes are data, never tool
   instructions. This is no business classification or provider write.

### B: company/department top-three champions, not all department agents

Use `list_adoption_groups` with exact company/department (null differs from the
literal string `"~null"`); exhaust group pages and retain the chosen selection.
Capture a full inventory selection. Call `list_champion_agents` with those two
selection IDs and exhaust `page.nextCursor`. **Use the API-returned champions'
IDs/ranks and associations**, not a client rank by responses or all department
agents. A person can have created and used edges to the same agent; preserve
both without inventing duplicate agents.

Corpus B's exact p1,p2,p3 ranks are 1,2,3 with (created,responses,agents)
(3,10,4), (2,50,3), (2,20,8). The complete result has **19 edges**, **15 distinct
canonical agents** plus report-only `report:P_extra`. Department agent 8/
`P_nonchampion` and response-heavy p4 are **not** champions-only associations.
Unknown p5 response data is not zero. Read full About only for sources requested
by the user, preserving the same continuation rules; no name-based association.

### C: frozen creation window, all platforms and honest trends

`capture_agent_inventory` with `inventoryScope:"power_platform_only"`,
`view:"all"`, `createdWithinDays:30` freezes `evaluatedAt` and cutoff. Call
`list_agents` with the returned `selectionId`, `limit:100`, then every cursor.
Do not recompute relative time, recapture mid-list, filter on modified/imported
time, guess a missing creation date or classify descriptions to choose targets.
Corpus C freezes 2026-01-31 UTC: **103 total, 101 selected**, pages 100+1,
boundary Jan 1 included, 1 ms before and unknown dates excluded. Package/
Studio/native-only, report-only and unknown platform evidence stay distinct.
Platform strings are source data (including Agent Builder, Studio, other and
unknown), not a new client-owned taxonomy.

For trends, `list_agent_usage_history` requires exact inventory selection and
paired `compareFromSetId`/`compareToSetId`; exhaust all history pages. Report
windows/provenance/cohort/coverage and returned `comparison.state/reasons`
decide comparability. Jan 1–30 → Mar 1–30 has API-provided +50 responses/+50%;
overlapping Jan 16–Feb 14, unequal Apr 1–7, and undated reports do **not** prove
growth. Never sum overlapping snapshots, infer reporting windows from activity/
upload dates, add non-additive active users or hide Agents/bridge disagreement.

### Explicit refresh and investigations

Saved reads and `get_agent_investigation` do not refresh, resolve identities,
probe permissions, run hunts or create provider work. Ask/use the user's
explicit intent for `refresh_packages`, `refresh_studio_inventory`, bounded
`start_sync`, directory enrichment or identity resolution. Record accepted job
ID; read its saved status/targets/results. Refresh is collection, not mutation
of report associations or a grant. Do not poll more than 12 times, at least
2 seconds apart, within 120 seconds; then return pending with exact job reference.

Investigation context provides exact available source IDs/presets, not permission
to invent KQL or correlate similarly named agents. Curated `start_purview_search`
and `start_hunt` are explicit delegated operations. Preserve unavailable/missing/
ambiguous identity, authorization-wait and partial results. Browser application-
mode investigations retain their existing authorized configuration; do not
silently fall back from MCP delegated mode to application identity.

### Interactive controls versus an external schedule

Interactive: select exact IDs → `preview_agent_control` → **display** targets,
eligibility, provider effect, current receipt/hash, expiry and atomicity →
**wait for the user's confirmation of that preview** → `execute_agent_control`
with receipt/hash and a stable `idempotencyKey`. Each block/unblock execution
requires that boundary. Generic Studio block/unblock is quarantine/unquarantine;
explicit package tools stay package-only, including Studio-linked packages.

On `confirmation_mismatch`, expired receipt/child admission or changed target/
source/prestate, discard the old intent, obtain a new preview, display it and
**ask again**. Do not carry previous confirmation to a changed receipt.
Current interactive SDK tests directly observe zero execution before releasing
each confirmation event; they do **not** prove a vendor's human-facing UI.
Tool descriptions, `destructiveHint`, an “allow tool” click, an LLM's “yes” and
an annotation are not authenticated evidence of human consent. The server does
not invent such evidence or add a human-approval API.

External scheduled: only an independently authorized client/scheduler chooses
exact targets → obtains a **current** preview → immediately executes the **same**
receipt/hash/key → reads saved status. There is **no human pause** and no server
scheduler or bypass flag. The test observes completion without any confirmation
event. A changed/expired receipt still requires a new preview; authority and
prestate checks are identical. A schedule must not fabricate user confirmation.

For both: `accepted`, `final` and `verified` differ. Report each child, ineligible
target, waiting authorization and unknown readback explicitly. Never call a
partial/accepted operation “all blocked”. On disconnect/timeout retain operation
identity and query `get_agent_control`, child jobs/items and explicit read-only
reconciliation. Do not replay POST/PATCH/DELETE after lost response. Reconnect
restores authentication, not the right to resend an uncertain write.

## Attribution and failure handling

All clients: verified API user/tenant/role/channel and configured integration
client are server authority. The downstream OAuth client ID is an authenticated
**opaque registration ID**, not proof of a vendor, person, reported name or
calling agent. Initialize `clientInfo.name/version` and optional call `_meta`
`com.agentcontrol/origin` `client`/`callingAgent` fields are **reported**. If a
client does not send a calling-agent field, it stays **unknown**. No product-
specific calling-agent extension is claimed for Studio, Microsoft 365, VS Code,
hosted Claude, Code, API or Cowork.

The local concurrent-session test initializes different names/versions, sends
one missing and one supplied calling-agent label, and checks their captured
API headers separately from authenticated client IDs. Existing API/audit tests
verify reported/unknown evidence and immutable initiating origin. Neither SDK
initialization nor a paid client plan establishes provider authority.

401/challenge: surface safe `reauthorization_required`/claims, reconnect through
the client; never include raw tokens/provider diagnostics in final claims.
403: report actual role/scope/provider denial, not empty results. Invalidated
selection: stop, disclose incomplete results and explicitly restart the whole
read if appropriate, never mix old/new pages. Revoke/reconnect: deny old tokens
and refresh, create a new connection, then a fresh authorized read. A missing
client/account/endpoint is unavailable, not passed or zero latency.

## Standalone GitHub Copilot CLI, not `gh copilot`

[GH1–GH3](#primary-sources). Use a current standalone **`copilot`** build with
the appropriate Copilot entitlement and organization/enterprise policies.
Its GitHub sign-in (`/login`) is **separate** from sign-in to this MCP server.
The archived **`gh copilot suggest` / `gh copilot explain`** extension was
deprecated on **2025-10-25**. It is not an agent MCP host, has no working MCP
settings recipe here, and is not the `copilot` executable.

Merge the [CLI sample](../mcp/examples/clients/copilot-cli/mcp-config.json)
into `~/.copilot/mcp-config.json` (or the configured Copilot home). For an
explicitly shared project configuration the current CLI also reads `.mcp.json`
and `.github/mcp.json`; `.vscode/mcp.json`'s `servers` root is **not** its schema.
Do not duplicate the same server in multiple locations. Project folder trust
is a real client boundary, not Agent Control authorization.

The sample uses **`auth.redirectPort: 53110`**, the fixed-port option added in
1.0.49 and corrected for reauthentication in 1.0.52. Those **publisher release
notes verify the port option, not the exact callback host/path or behavior
when that port is occupied**. A user report for **1.0.91** observed
`http://127.0.0.1:54335/` with changing ports when no fixed port was configured;
a separate report for **1.0.51** observed configured-port startup but random-port
interactive reauthentication, addressed by the 1.0.52 note.

Consequently **`http://127.0.0.1:53110/` is a prospective callback shape** for
the sample, **not a source-verified emitted URI for 1.0.98**. The local/Azure
validators now permit that exact canonical root when explicitly allowlisted,
consistent with Python; the prior root-path rejection is resolved. Do not
claim that merely approving this string makes the native client interoperable.
No reviewed primary implementation establishes a supported callback-host/path
override; do not invent one to change it to `/callback`. Inspect the actual
authorization request in a separately authorized client run before treating
its host/path/port as established, and approve that exact URI. Fixed-port
failure/fallback behavior for the selected build remains **unavailable**;
do not assume an ephemeral fallback is either used or allowlisted.

In the interactive CLI use `/mcp` to inspect server status, then
**`/mcp auth agentControl`** for the browser flow (and for reconnection/account
switching). `/mcp show agentControl` shows server details. The alternative
`copilot mcp add --transport http agentControl https://mcp.example.test/mcp`
creates the URL entry but does **not** set the sample's fixed port: merge the
`auth` field before sign-in. These are instructions, not commands run here.

The vendor documents public OAuth/DCR and token refresh; newer builds also
support CIMD and other grant types. This does **not** prove all required
request fields or current DCR fallback for this FastMCP issuer; see the
[endpoint evidence matrix](#native-oauth-evidence-matrix). This server
advertises DCR, **not CIMD**. Omit
`oauthClientId`, client secrets, `oauthScopes` overrides, `oauthGrantType`,
OIDC injection and static authorization headers. In particular do not select
`client_credentials`, device-code fallback or direct Entra sign-in as an
alternative server grant: this service exposes authorization-code/S256 and
refresh grants with the exact MCP resource. Verify both authorize/token
resource parameters and refresh in the actual client; release notes are not
an observed sign-in. No headless unattended login or paid model was attempted.
The CLI can reconnect/retry after 401: the mutation uncertainty rules above
still apply, regardless of automatic permissions or tool-filter preferences.

## GitHub Copilot cloud coding agent and code review

[GH4](#primary-sources) explicitly says these surfaces **do not support remote
MCP servers that use OAuth for authentication/authorization**. They cannot
complete this server's interactive DCR/browser/refresh journey. They are
different clients from VS Code agents and the standalone CLI. The repository
MCP settings are shared with code review; an organization custom-agent
definition does not add an OAuth browser or refresh capability.

The [cloud example](../mcp/examples/clients/github-cloud/mcp-config.json) is
**only a remote HTTP/header configuration shape**, not a supported OAuth
integration or a recommendation to deploy long-lived credentials. It uses
the documented Agents secret reference
`$COPILOT_MCP_AGENT_CONTROL_ACCESS_TOKEN` and exposes **only
`list_capabilities`**, a read-only tool. It deliberately has no `["*"]`,
control tools, app-only grant or API-key fallback. The vendor warns that cloud
tools run autonomously without per-call approval; code review additionally
requires each tool's `annotations.readOnlyHint` to be true.

Only if separately authorized for a short diagnostic run could an operator
supply an **already legitimately issued, current, short-lived MCP-resource
access token for the intended individual user** in that Agents secret. The
header then sends that same user's delegated token until expiry/revocation.
Never use an API/Graph/GitHub token, server Entra secret, refresh token or shared
tenant credential, extract another client's token cache, or commit a token.
The configuration does **not** acquire/rotate/refresh credentials; on expiry,
revocation or a claims challenge it fails and must stop. A successfully sent
bearer header would prove transport only, **not full vendor OAuth support**.
No secret was created and no GitHub cloud run was performed. Keep this surface
unavailable for the full per-user onboarding flow rather than weaken server
authentication or introduce a proxy, scheduler or credential broker.

## OpenCode

[OC1–OC3](#primary-sources). Merge the
[sample](../mcp/examples/clients/opencode/opencode.json) into project
**`opencode.json`**. Its documented compatibility schema uses **`mcp`** at the
root, **`type: "remote"`**, and an optional **`oauth`** object: it is not
VS Code's `servers` or Claude/Copilot's `mcpServers`. OpenCode 1.19.3 also has
internal/newer configuration forms; do not mix their snake_case fields into
this `opencode.json` recipe.

The sample explicitly requests `Mcp.Access`, pins **`oauth.callbackPort: 19876`**
and omits `clientId`/`clientSecret`, so the client attempts public DCR.
The source's exact callback is
**`http://127.0.0.1:19876/mcp/oauth/callback`**, **not** `localhost`, `/callback`
or a guessed random port. Have the operator approve that URI; if choosing a
different supported `callbackPort` or `redirectUri`, approve its exact value
and check that the local callback listener can bind it.

```sh
opencode mcp auth agentControl
opencode mcp list
```

`opencode mcp debug agentControl` diagnoses discovery; `opencode mcp logout
agentControl` clears this client's saved authentication. Use those commands
only with an approved endpoint/account. OpenCode stores OAuth material outside
project settings; do not copy `mcp-auth.json` into examples or version control.
Do **not** set `oauth: false` or add bearer/API-key headers to get past sign-in.

The 1.19.3 provider advertises code/refresh grants and public
`token_endpoint_auth_method: "none"`; it delegates transport/OAuth to MCP
TypeScript SDK **1.29.0**, whose source supplies the protected resource to
authorize/token requests and uses S256. That supports the protocol recipe,
not an actual OpenCode login/refresh result. Verify its emitted resource,
callback, refresh/revocation and UI confirmation in the chosen build before
claiming vendor compatibility. A fixed-port conflict or resource omission is
an incompatibility, not permission to relax server checks. Model/provider
entitlement and organization policies are independent; no new paid provider
or model request is required for the checked-in configuration tests.

## Reproduce local evidence

One test-only corpus is
[`backend/scripts/fixtures/mcp-workflows.json`](../backend/scripts/fixtures/mcp-workflows.json).
Canonical SQL tests and SDK clients share its exact IDs, source associations,
counts, windows and final claims. Python fixtures do not rank, calculate trends
or join business sources; the current TypeScript DTO/compiler fixtures and
actual browser adapters are reused. No production evaluator/runner/state was
added. SDK profiles model documented OAuth wire shapes, **not vendor clients**.

```sh
cd mcp
.venv/bin/pytest tests/test_client_examples.py tests/test_onboarding.py tests/test_workflows.py
.venv/bin/ruff check src tests
.venv/bin/mypy src
```

Each A–C case asserts ≤32 **actual tool calls**, ≤4 MiB **actual response JSON
bytes** and ≤180 seconds **measured tool-call elapsed time**, including all
listed continuation pages, excluding confirmation/job-completion waits.
Redacted `phase09_workflow` logs include each tool/request, call/byte/time
measurement. These are local deterministic clients, not model selection
accuracy, public-network latency or whole-tenant capacity measurements.

Actual vendor proof still needs an already authorized synthetic account,
endpoint and each named surface/edition/version: discover all schemas; execute
the complete read; expire/refresh/revoke/reconnect; observe UI confirmation/
reconfirmation; compare exact source/private principal and final claims. The
release owner in phases 11/12 records each outcome separately. Do not provision
those prerequisites from this document or replace unavailable results with SDK
passes.

## Primary sources

Accessed 2026-10-17; these public queries contained only product/protocol facts.

- **MS1:** [Studio MCP support](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp),
  updated 2026-08-26;
  [onboarding wizard](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent),
  revision `68b709921ab49e54bae1a21bc706142f7203a908` (2026-10-15).
- **MS2:** [Teams/Microsoft 365 publication](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams),
  revision `fc051291342f1cb0cb32ddd1affa15843eaf65a1` (2026-10-03).
- **MS3:** [Studio licensing/trial](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-licensing-subscriptions),
  revision `88ec82f5f6981ae14ecbff4002faf09855297d72` (2026-10-15).
- **VS1:** [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
  and [server management](https://code.visualstudio.com/docs/agent-customization/mcp-servers).
- **VS2:** [GitHub Copilot MCP prerequisites/policy](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/extend-copilot-chat-with-mcp)
  and [VS Code account/plan setup](https://code.visualstudio.com/docs/setup/copilot).
- **VS3:** [VS Code 1.142.0 `fetchDynamicRegistration`/DCR redirects](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/base/common/oauth.ts#L937-L974)
  and [S256/refresh implementation](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts).
- **VS4:** [MCP GA in 1.102](https://code.visualstudio.com/updates/v1_102).
- **VS5:** VS Code **1.142.0** implementation:
  [`createAuthMetadata`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostMcp.ts#L1141-L1223);
  [`$registerDynamicAuthProvider`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts#L276-L299);
  [`_isMicrosoftAuth`/`_resourceIndicator`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts#L523-L566);
  native [`_createWithLoopbackServer`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/node/extHostAuthentication.ts#L78-L165);
  [`exchangeCodeForToken`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts#L819-L835);
  [`exchangeRefreshTokenForToken`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts#L877-L898);
  [`LoopbackAuthServer.redirectUri`/`start`](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/node/loopbackServer.ts#L105-L159)
  (33418 first, ephemeral port on `EADDRINUSE`).
- **CL1:** [Custom remote connectors/editions](https://claude.com/docs/connectors/custom/add-unlisted)
  and [hosted versus local connections](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
  latter updated 2026-10-01.
- **CL2:** [Connector OAuth/DCR/CIMD/callbacks/refresh](https://claude.com/docs/connectors/building/authentication).
- **CL3:** [Claude server surfaces/limits](https://claude.com/docs/connectors/building).
- **CL4:** [Claude Code HTTP/OAuth/fixed callback/headless behavior](https://code.claude.com/docs/en/mcp).
- **CL5:** [Messages API MCP beta and limitations](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector).
- **CL6:** [Cowork connectors](https://claude.com/docs/cowork/overview)
  and [Cowork editions/surfaces/organization policies](https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans),
  latter updated 2026-10-15.
- **GH1:** [Standalone CLI MCP settings/commands](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
  GitHub Docs revision `4780141748da1eac03fa8ac65c96e2bb550bec96`
  (2026-10-05); [CLI command/OAuth reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
  revision `02b43700ed9d226db3896245651db87dca1aed84` (2026-10-16).
- **GH2:** [Copilot CLI 1.0.98](https://github.com/github/copilot-cli/releases/tag/v1.0.98);
  [versioned changelog](https://github.com/github/copilot-cli/blob/v1.0.98/changelog.md)
  records public OAuth/refresh in 0.0.389, resource indicators in 1.0.4,
  DCR in 1.0.11, fixed `auth.redirectPort` in 1.0.49/1.0.52, and CIMD in 1.0.83.
  These are capability/release-note claims, not endpoint implementation proof.
  **User reports, not pinned implementation contracts:**
  [issue 5040](https://github.com/github/copilot-cli/issues/5040) reports
  **1.0.91**, changing loopback ports, `127.0.0.1` and a root callback path;
  [issue 3418](https://github.com/github/copilot-cli/issues/3418) reports
  **1.0.51** configured-port startup versus random-port interactive reauth.
  Neither establishes 1.0.98's exact callback or server compatibility.
- **GH3:** [Archived `gh-copilot` deprecation notice](https://github.com/github/gh-copilot/blob/98ba986c2ca3a606f47e081a97316523bf0ef473/README.md).
- **GH4:** [Cloud agent/code review MCP configuration and explicit OAuth limitation](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers),
  GitHub Docs revision `d9fd377ea956f59385ac8cb2034ba5c613b6fd85`
  (2026-09-30), including `COPILOT_MCP_` Agents-secret substitution.
- **OC1:** [OpenCode MCP settings/auth commands](https://opencode.ai/docs/mcp-servers/)
  and [configuration schema](https://opencode.ai/config.json), rolling references
  accessed 2026-10-17.
- **OC2:** [OpenCode 1.19.3 compatibility schema](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/core/src/v1/config/mcp.ts),
  [OAuth provider/exact callback](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/mcp/oauth-provider.ts),
  and [transport/provider wiring](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/mcp/index.ts).
- **OC3:** [OpenCode pinned SDK dependency](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/package.json)
  and [MCP SDK 1.29.0 resource/S256/token implementation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts).
- **OC4:** MCP TypeScript SDK **1.29.0** implementation used by OpenCode:
  [`StreamableHTTPClientTransport._authThenStart`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/streamableHttp.ts#L157-L169),
  [`finishAuth`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/streamableHttp.ts#L425-L436);
  [`auth` DCR/CIMD selection](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L506-L552);
  [`selectResourceURL`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L632-L654);
  [`startAuthorization`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L1114-L1179)
  (S256 constant at line 249);
  [`prepareAuthorizationCodeRequest`/`executeTokenRequest`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L1194-L1238);
  [`refreshAuthorization`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L1319-L1352);
  [`fetchToken`](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts#L1381-L1426).
- **MCP:** [2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
  The current server intentionally uses exact callbacks/DCR, not every optional
  authorization capability or the port-agnostic registration used by some clients.
