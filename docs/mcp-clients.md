# Connect an MCP client

Use this guide to connect a client, read saved Agent Control data and submit
explicit collection or control operations. The optional MCP service does not
replace the web application or its automatic initial synchronization.

The examples use the synthetic URL `https://mcp.example.test/mcp`. Replace it
with your service's public HTTPS resource URL. Client recipes were reviewed
against vendor documentation/source on **2026-10-17**; they are not a claim
that every listed client completed a live login and tool journey.

## Before connecting

1. Have the service operator complete [service setup](mcp-integration.md#service-setup),
   including the API integration binding and the separate MCP Entra registration.
2. Choose a client below and give the operator its exact callback URI(s) for
   `MCP_ALLOWED_CLIENT_REDIRECT_URIS`. No wildcard hosts, ports or paths are accepted.
3. Use your own sign-in and the required [Agent Control roles and Microsoft
   permissions](user-roles-and-permissions.md). Client subscription and organization
   policies are separate from application/provider permissions.
4. Configure the HTTP resource URL, connect and complete browser OAuth. Discover
   the tools and make a saved read such as `list_capabilities`.

The MCP registration's Entra callback is the service origin's
`/auth/callback`; it is **not** the client's callback. Never put the server's
Entra secret, signing/encryption keys, or API/Graph tokens into client settings.
There is no application release-acceptance, qualification or enable action
between a correctly configured sign-in and normal supported use.

## Choose a client

Merge only the relevant server entry; do not overwrite existing servers.

| Client | Configuration or connection route | Compatibility boundary |
| --- | --- | --- |
| VS Code GitHub Copilot agents | [VS Code sample](../mcp/examples/clients/vscode/mcp.json) → `.vscode/mcp.json` | Native OAuth/resource/S256/DCR source checked for 1.142.0; exact root callbacks required |
| Standalone GitHub Copilot CLI (`copilot`) | [CLI sample](../mcp/examples/clients/copilot-cli/mcp-config.json) → `~/.copilot/mcp-config.json` | Fixed-port configuration documented for 1.0.98; exact callback and endpoint-specific OAuth interoperability unverified |
| OpenCode | [OpenCode sample](../mcp/examples/clients/opencode/opencode.json) → project `opencode.json` | Source checked for 1.19.3 and MCP TypeScript SDK 1.29.0 |
| Claude Code | [Code sample](../mcp/examples/clients/claude-code/.mcp.json) → project `.mcp.json` | Native OAuth with documented fixed callback port; not the hosted Claude callback |
| Claude web, Desktop and Cowork | [Account remote connector](#claude-web-desktop-and-cowork) | Cloud-originated connection; DCR required because this server disables CIMD |
| Copilot Studio / published Microsoft 365 Copilot agent | [Studio OAuth wizard](#copilot-studio-and-microsoft-365-publication); optional [OpenAPI transport import](../mcp/examples/clients/copilot-studio/agent-control.openapi.yaml) | DCR/Streamable HTTP documented; strict resource/S256 and published end-user flow unverified |
| GitHub cloud coding agent / code review | [Transport-only sample](../mcp/examples/clients/github-cloud/mcp-config.json) | Vendor does not support remote OAuth; **not full delegated OAuth support** |

No native client in this table has live end-to-end interoperability evidence
in the repository. SDK tests model requests; they do not execute vendor clients.
In particular, Copilot CLI release notes and Studio guides do not prove that
their current implementations send `resource` on both authorization and token
requests, including refresh, or use S256/code verification in this exact flow.
VS Code and OpenCode have source-backed implementations when protected-resource
discovery succeeds; that still does not establish a live connection.

Any compatible downstream client can dynamically register: there is no vendor
client-ID allowlist. This does not mean `clientId:"*"`, anonymous access, a
wildcard Entra audience or permission to execute every tool. DCR issues an
opaque downstream ID; the service's confidential Entra application remains fixed.

## VS Code / GitHub Copilot

Use a supported VS Code build and applicable Copilot entitlement. MCP was GA
in 1.102; the older documented minimum is 1.99. Business/Enterprise organization
MCP policy and workspace trust still apply.

Use **MCP: Add Server > HTTP**, or merge:

```json
{"servers":{"agentControl":{"type":"http","url":"https://mcp.example.test/mcp"}}}
```

The portable workspace-root `.mcp.json` format uses `mcpServers` instead of
`servers`. Choose one configuration location supported by your harness.
Do not add static bearer headers, `oauth.enterpriseManaged`, invented
DCR-enable flags, npm helpers or another proxy.

VS Code **1.142.0** registers all four callbacks below, even when only one
is used. The operator must allowlist all four exact strings:

```json
["https://insiders.vscode.dev/redirect","https://vscode.dev/redirect","http://127.0.0.1/","http://127.0.0.1:33418/"]
```

Its native flow tries port 33418, then an ephemeral port if occupied. A different
port is not automatically allowlisted: free the fixed port or use another
already configured exact callback. Web, remote and future harnesses may differ.

Start through **MCP: List Servers**, complete OAuth and inspect **Show Output**
with secrets redacted. Select tools in the chat tool picker. Test a saved read,
refresh and reconnect in the harness you actually use. Workspace trust and
“allow tool” prompts do not confirm a particular control preview.

## Standalone GitHub Copilot CLI, not `gh copilot`

Use the standalone **`copilot`** executable with the appropriate entitlement.
Its GitHub `/login` is separate from authentication to Agent Control.
The archived `gh copilot suggest` / `gh copilot explain` extension was deprecated
on **2025-10-25** and is not an MCP agent host.

Merge the [CLI sample](../mcp/examples/clients/copilot-cli/mcp-config.json)
into `~/.copilot/mcp-config.json` or the configured Copilot home. Shared project
configuration can use `.mcp.json` or `.github/mcp.json`. These use `mcpServers`,
not VS Code's `servers`. Avoid duplicate entries.

The sample pins `auth.redirectPort:53110`, documented since 1.0.49 and corrected
for reauthentication in 1.0.52. **`http://127.0.0.1:53110/` is a prospective
callback shape, not a source-verified emitted URI for 1.0.98.** Inspect the actual
authorization request and allowlist its exact host/path/port. The service accepts
an explicitly configured canonical root `/`, but that alone does not establish
CLI compatibility. Fixed-port conflict/fallback behavior remains unverified.

Use `/mcp`, `/mcp show agentControl` and **`/mcp auth agentControl`** to inspect,
connect or reconnect. Alternatively:

```sh
copilot mcp add --transport http agentControl https://mcp.example.test/mcp
```

That command does not set the sample's fixed port; merge `auth` before sign-in.
Omit static credentials, `oauthClientId`, `oauthScopes` overrides and alternate
grant selection. This server supports authorization-code/S256 and refresh,
not client credentials or device-code fallback. Newer CLI CIMD/grant features
do not change the server's advertised contract.

The sample's `tools:["*"]` exposes the catalog; it is neither an OAuth identity
nor blanket execution approval. Client reconnect/retry behavior must not cause
uncertain controls to be blindly resubmitted.

## OpenCode

Merge the [sample](../mcp/examples/clients/opencode/opencode.json) into
`opencode.json`. The reviewed 1.19.3 compatibility schema uses root `mcp`,
`type:"remote"` and `oauth`; do not mix internal/newer snake_case schemas into it.
The sample requests `Mcp.Access`, omits a static client ID/secret for public DCR
and pins `oauth.callbackPort:19876`.

Allowlist **`http://127.0.0.1:19876/mcp/oauth/callback`** exactly. If you choose
a different supported callback port or redirect URI, configure that exact
value and ensure the listener can bind it.

```sh
opencode mcp auth agentControl
opencode mcp list
opencode mcp debug agentControl
```

`opencode mcp logout agentControl` clears the client's authentication. Keep its
OAuth material outside project settings and version control. Do not set
`oauth:false` or add API-key/bearer headers to bypass sign-in.

The reviewed provider uses MCP TypeScript SDK 1.29.0 for S256 and resource
indicators. Without protected-resource metadata the SDK can omit the resource,
which this server rejects. Verify discovery, refresh and interactive
confirmation in the chosen build.

## Claude web, Desktop and Cowork

Use **Customize > Connectors > Add custom connector**:

1. Enter the exact public HTTPS MCP URL.
2. Choose **Sign in now** and **Register automatically** (DCR). Do not select
   “Use Claude's published identity”/CIMD: this service does not advertise it.
3. Allowlist **`https://claude.ai/api/mcp/auth_callback`** on the MCP service.
4. Sign in individually, discover tools and make a saved read.

Hosted Claude has **no documented remote-connector JSON import**. Desktop's
local `claude_desktop_config.json`/extensions are a different stdio mechanism.
The account remote connector connects from Anthropic's cloud, even on Desktop;
a loopback/VPN-only endpoint visible to the desktop is insufficient.

The reviewed web editions include Free (one custom connector), Pro, Max, Team
and Enterprise. Organization owners/authorized connector managers may need to
add the connector before members sign in. Cowork requires its applicable paid
plan and supported surface/organization policy; it loads account connectors
at task start, not Claude Code's `~/.claude` configuration. Start a fresh task
after adding a connector.

Claude documents proactive refresh up to five minutes before expiry, reactive
refresh on 401, endpoint deadlines of 10 seconds (30 for refresh), and hosted
tool limits around 150,000 characters/240 seconds. The service's own smaller
[invocation bounds](mcp-integration.md#invocation-budgets) still apply.
Per-task/always-allow settings are client policy, not provider authority or
proof that a person confirmed a particular operation.

## Claude Code

Code is a separate CLI/native OAuth client, with its own entitlement/billing.
Allowlist `http://localhost:53109/callback` for the example fixed port:

```sh
claude mcp add --transport http --callback-port 53109 agentControl https://mcp.example.test/mcp
claude mcp login agentControl
```

Alternatively use `/mcp` interactively, or merge the
[project sample](../mcp/examples/clients/claude-code/.mcp.json). Default random
ports and port-agnostic registration are not supported by this server's exact
redirect policy. Use a current fixed-callback-capable build; vendor docs identify
a redirect mismatch in 2.1.229.

Headless `claude -p`/Agent SDK runs cannot conduct an interactive OAuth flow:
sign in beforehand in an authorized interactive client. No bypass-permissions
flag is required. Automatic reconnect/retry after 401 does not justify replaying
an uncertain mutation.

## Claude Messages API

The API connector is not Claude web sign-in. It requires a publicly reachable
HTTP MCP endpoint and an externally acquired MCP-resource `authorization_token`.
The host application owns OAuth acquisition, storage, rotation and revocation.

Use the documented `mcp_servers` entry with `type:"url"`, `url`, `name` and
`authorization_token`; the tools entry is
`{"type":"mcp_toolset","mcp_server_name":"agentControl"}`. The reviewed beta header
is `anthropic-beta: mcp-client-2025-11-20`, not the deprecated 2025-04-04 beta.
It supports tool calls, not a DCR/browser-login/refresh UI or stdio.

Interactive applications must display the preview and obtain confirmation
outside the model call before executing controls. Enabling all tools in a
paid API call is not consent.

## Copilot Studio and Microsoft 365 publication

Use Studio's standard harness, generative orchestration and Streamable HTTP;
SSE support ended in August 2025. Verify the environment's licensing, region
and data policies. A trial supports test-chat authoring but cannot publish.

1. In **Tools > Add a tool > New tool > Model Context Protocol**, enter the
   name, description and exact server URL.
2. Select **OAuth 2.0 > Dynamic discovery** and DCR. Dynamic endpoint entry is
   an alternative where discovery is unavailable; Manual is not Entra-direct
   sign-in. The MCP endpoints are `/authorize`, `/token`, `/register`, with
   downstream scope `Mcp.Access`, not API scope `AgentControl.Access`.
3. Copy the wizard's exact environment-specific callback into the service's
   downstream allowlist. There is no universal Microsoft callback to guess.
   `https://studio.example.test/generated-callback` is only a synthetic test
   callback, never a Microsoft production value.
4. Create the connection and sign in. Check that authorization and token/refresh
   requests use the exact resource and S256/verifier. If that Studio build omits
   required fields, report incompatibility; do not relax validation.
5. Add the connection to the agent, discover the 124 schemas and test a saved
   read and refresh. Catalog discovery does not prove reliable tool selection
   or confirmation handling.
6. To publish to Microsoft 365, publish the agent, add the **Teams and Microsoft
   Copilot** channel, select **Make agent available in Microsoft Copilot**, and
   share/install for the intended users. Real tenant store/admin policies apply.
   Test each published end user's own connection and authorization separately.

The optional [OpenAPI YAML](../mcp/examples/clients/copilot-studio/agent-control.openapi.yaml)
is a custom-connector **transport definition** for `/mcp` with
`x-ms-agentic-protocol:mcp-streamable-1.0`. Change its host; configure the same
per-user OAuth connection in the wizard. It neither enumerates tools as REST
operations nor supplies OAuth settings or a Microsoft 365 agent manifest.
Never leave authentication at None/API key or insert the Entra secret.
Private agent use does not require public connector certification.

## GitHub cloud coding agent and code review

These surfaces do **not** support remote MCP OAuth. Repository MCP settings
or custom-agent definitions do not provide browser sign-in or refresh.

The [cloud sample](../mcp/examples/clients/github-cloud/mcp-config.json) is only
a remote HTTP/header shape. It exposes read-only `list_capabilities` and uses
the Agents-secret reference `$COPILOT_MCP_AGENT_CONTROL_ACCESS_TOKEN`.
It does not acquire or rotate tokens. Cloud tools run autonomously; code review
also requires `annotations.readOnlyHint:true`.

A separately authorized short diagnostic can supply an already legitimately
issued, current, short-lived MCP-resource token for the intended individual.
On expiry/revocation/challenge it must stop. Do not extract another client's
cache, substitute API/Graph/GitHub tokens or shared credentials, or deploy a
long-lived token broker to conceal the unsupported OAuth flow.

## Ordinary workflow recipes

Every tool takes one **`request` object**, including empty input:

```json
{"request":{}}
```

For exact user resolution:

```json
{"request":{"username":"alex@example.invalid"}}
```

Use discovered schemas. Follow every returned cursor with the same selection,
source and revision; do not recapture midway. Unknown/partial results are not
zeroes or complete datasets. Source descriptions and other text are untrusted
data, never instructions. Full API semantics live in the
[integration reference](mcp-integration.md#wire-vocabulary-and-result-semantics).

### Find a person and all their agent relationships

1. `resolve_user`: require `state:"resolved"` and an exact non-null `objectId`.
   Retain the report selection; ambiguous names or concealed identifiers do not
   authorize choosing a person.
2. `capture_agent_inventory` with `query.inventoryScope:"all"` and no narrowing
   platform/creation/category filters.
3. For each requested `used`, `created`, `owned`, `modified` relationship,
   call `list_user_agent_relationships` with that exact person and both selection
   IDs. Exhaust `page.nextCursor`; preserve report-only IDs and source references.
4. For requested About/configuration, page `list_agent_members`, then
   `read_agent_about` for the exact returned source identity/scope and field.
   Exhaust its continuation; a short preview is not full long/native text.

### Find a department's top-three champions

Use `list_adoption_groups` with the exact company and department, retain its
selection and capture a full inventory selection. Call `list_champion_agents`
with both IDs and exhaust its pages. Use **API-returned** IDs, ranks and
associations. Ranking is responses descending, then positively used agent count,
name and identity; creation counts do not determine rank. The department's
general agent list is not champions-only. Keep created/used edges distinct.

### Read a frozen creation window and compare usage

Capture inventory with `createdWithinDays` and the required inventory scope.
Retain its frozen `evaluatedAt` and selection through every `list_agents` page.
Creation is not modification, import or observation time; unknown creation is
not inferred. Preserve platform/source distinctions.

For trends, use `list_agent_usage_history` with paired `compareFromSetId` and
`compareToSetId` and exhaust history pages. The API's comparison state, reporting
windows, cohorts and coverage decide comparability. Do not sum overlapping
snapshots, invent reporting windows or add non-additive active-user categories.

### Refresh saved data or investigate

Saved reads do not collect data. Explicitly submit `start_sync`, package/Studio
refresh, people enrichment, identity resolution or a curated investigation
when requested. Retain the returned job ID and inspect its saved status/results.
Graph collection uses application tokens; Power Platform collection and
investigations use delegated tokens. [Provider modes](mcp-integration.md#provider-identity)
explain the split without changing the caller's delegated authentication.

Poll at most 12 times, at least two seconds apart, within 120 seconds; return
pending with the job reference afterward. Never substitute arbitrary KQL or
guess identity matches. Preserve authorization-wait and partial outcomes.

### Preview and execute exact controls

Interactive flow: exact selected IDs → `preview_agent_control` → display
targets, effects, eligibility, receipt/hash, expiry and atomicity → **wait for
the user's confirmation of that preview** → `execute_agent_control` with the
same receipt/hash and a stable `idempotencyKey`.

A changed/expired receipt, membership or prestate requires a new displayed
preview and confirmation. Generic Studio block/unblock means
quarantine/unquarantine; explicit package controls remain package-only.
Package preview summaries show at most 20 targets plus `additionalTargetCount`;
do not imply omitted targets were displayed.

An independently authorized external scheduler uses the same current receipt
and provider checks without a human pause. The service supplies no scheduler,
bypass flag or fabricated human-confirmation field. Tool annotations,
an “allow tool” click or an LLM's “yes” do not authenticate human intent.

Acceptance is not verified completion. Inspect child jobs/items and saved
outcomes. On timeout/disconnect retain operation identity and use saved status
and explicit read-only reconciliation; never blindly replay a write.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Discovery/401 loop | Use the MCP resource, not `/sse`, API origin or Entra token URL. Verify protected-resource discovery and exact resource on authorize/token/refresh. |
| Redirect rejected | Compare the complete registered URI and allowlist, including root slash/host/port. Do not invent `/callback` or wildcard ports. |
| `reauthorization_required` / claims challenge | Reconnect through client OAuth; never enter credentials in tools/chat. Obtain fresh authority before eligible unsent work. |
| 403 | Report the actual application role, consent or provider denial; do not return empty data or enable a speculative feature flag. |
| Invalidated selection/cursor | Disclose incomplete results. Explicitly restart the whole read if appropriate; never mix generations/pages. |
| 413 `output_limit` | Reduce a safe read's page size while retaining its selection/continuation. Start wide inventory at `limit:25`; a row-count cap does not guarantee byte fit. |
| 429/503 | Respect cooldown. Only bounded safe GET retries are automatic; writes are single-attempt. |
| Revoked/expired connection | Reconnect and make a fresh read. Reconnection does not authorize replaying an uncertain control. |
| Client shows tools but cannot sign in/refresh | Discovery or sample import is not OAuth interoperability. Check the client-specific limitations above. |

Authenticated API user/tenant/role and integration identity are server authority.
The downstream OAuth client ID is opaque, not proof of a vendor. Initialize
client name/version and optional calling-agent labels are reported; absent
agent labels remain unknown. Redact tokens and provider diagnostic bodies from
logs/support reports.

## References and local checks

- [Service setup, contracts and storage recovery](mcp-integration.md).
- [Roles and provider permissions](user-roles-and-permissions.md).
- [Official usage limitations](official-usage-import.md).
- [Security model](security-model.md).

With the existing development environment, local modeled-client checks are:

```sh
cd mcp
.venv/bin/pytest tests/test_client_examples.py tests/test_onboarding.py tests/test_workflows.py
```

These checks do not prove native vendor login/refresh, UI confirmation, live
Entra consent/guest mapping, provider effects or public-network performance.

### Vendor references

Client recipes above use these references, reviewed 2026-10-17:

- VS Code [configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
  [management](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
  and 1.142.0 [DCR callbacks](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/base/common/oauth.ts#L937-L974),
  [OAuth/resource/refresh](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts),
  [native loopback](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/node/extHostAuthentication.ts).
- Copilot CLI [configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
  [commands](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
  [1.0.98 changelog](https://github.com/github/copilot-cli/blob/v1.0.98/changelog.md).
  Release notes establish capabilities, not current endpoint request bodies.
- OpenCode [settings](https://opencode.ai/docs/mcp-servers/), 1.19.3
  [provider](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/mcp/oauth-provider.ts)
  and SDK 1.29.0 [OAuth](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts).
- Claude [remote connectors](https://claude.com/docs/connectors/custom/add-unlisted),
  [OAuth](https://claude.com/docs/connectors/building/authentication),
  [Code](https://code.claude.com/docs/en/mcp),
  [Messages API](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector),
  [Cowork](https://claude.com/docs/cowork/overview).
- Studio [onboarding](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent),
  [MCP support](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agent-extend-action-mcp),
  [publication](https://learn.microsoft.com/en-us/microsoft-copilot-studio/publication-add-bot-to-microsoft-teams),
  [licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/requirements-licensing-subscriptions).
- GitHub cloud [configuration and OAuth limitation](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers).
