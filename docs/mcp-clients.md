# Connect an MCP client

Use an MCP client to read saved Agent Control data and request explicit collection
or control operations. MCP is optional; the web application's initial
synchronization still starts automatically after sign-in.

## Before connecting

1. Have the operator complete [server setup](mcp-integration.md).
2. Replace `https://mcp.example.test/mcp` in the examples with your public HTTPS
   MCP resource URL, including `/mcp`.
3. Give the operator your client's exact [callbacks](#oauth-callback-reference) for
   `MCP_ALLOWED_CLIENT_REDIRECT_URIS`. No wildcard hosts, ports or paths are accepted.
   The server's Entra callback, `/auth/callback`, is separate.
4. Sign in as yourself with the required [roles and Microsoft permissions](user-roles-and-permissions.md).
   Client licensing and organization policies also apply.

Never copy the server's Entra secret, signing/encryption keys, or API/Graph
tokens into client settings. Normal supported use needs no additional
application approval or feature-enable action.

## OAuth callback reference

OAuth uses two different return addresses:

- **Entra to MCP:** `https://<your-mcp-host>/auth/callback` receives Entra's
  sign-in response. Register it as a **Web** redirect URI on the MCP Entra app.
- **MCP to client:** the URLs below receive an OAuth authorization code so the
  client can finish connecting. Enter these in **Allowed client callback URLs**
  in the setup wizard, not in the MCP Entra app registration.

The allowlist prevents codes being sent to unintended destinations. Allow
addresses for the clients you use, not each individual user or installation.
Loopback addresses refer to the machine running the client, not the MCP
container; their ports are separate from the MCP server's listening port.

| Client | Client callback URLs | Notes |
| --- | --- | --- |
| VS Code / GitHub Copilot, web redirects | `https://insiders.vscode.dev/redirect`, `https://vscode.dev/redirect` | Include both with the desktop callbacks below. |
| VS Code / GitHub Copilot, desktop callbacks | `http://127.0.0.1/`, `http://127.0.0.1:33418/` | Exact addresses registered by the reviewed VS Code build; an ephemeral fallback port is not automatically allowed. |
| Standalone GitHub Copilot CLI | Prospective: `http://127.0.0.1:53110/` | The sample fixes `auth.redirectPort` to `53110`; the emitted host/path/port is not source-verified. Use the actual emitted callback, not this example without checking. |
| Copilot Studio agents, including those published to M365 Copilot | The connection wizard's exact environment-specific callback | Copy the callback supplied for that connection; do not substitute a generic Microsoft or guessed Power Platform URL. |
| M365 Copilot declarative agents | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` for the documented plugin OAuth flow | This is a downstream client callback, not a replacement for the MCP server's Entra callback. DCR handles registration separately. |
| Microsoft Copilot Cowork | `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` for the documented remote-MCP `OAuthPluginVault` flow | Use the callback required by the plugin's selected authentication flow and target host. Microsoft Copilot Cowork is not Claude Cowork. |

These are callback configuration references, not proof of native client
interoperability. In particular, Microsoft's M365 DCR documentation currently
requires the authorization server to issue a client secret; this repository's
[documented downstream contract](mcp-reference.md#oauth-and-token-flow) is public
DCR. Adding a callback alone does not establish compatibility with that M365
flow, and the MCP server's Entra secret must not be used as a downstream client
secret.

Microsoft callback/authentication references checked **2026-11-04**:
[Copilot Studio onboarding](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent),
[M365 plugin OAuth](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth),
[remote MCP plugins / Copilot Cowork](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/configure-plugin-mcp-servers)
and [M365 DCR requirements](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration).

To add clients later, rerun `start -ConfigureMcp` for the same project and supply
the combined existing and new callbacks, comma-separated. No `*`, wildcard host,
port or path is accepted. Keep the Entra `/auth/callback` unchanged.

## Choose a client

Merge the relevant entry into existing configuration; do not overwrite other servers.

| Client | Configuration or connection route |
| --- | --- |
| [VS Code / GitHub Copilot](#vs-code--github-copilot) | [Sample](../mcp/examples/clients/vscode/mcp.json) → `.vscode/mcp.json` |
| [Standalone Copilot CLI](#standalone-github-copilot-cli-not-gh-copilot) | [Sample](../mcp/examples/clients/copilot-cli/mcp-config.json) → `~/.copilot/mcp-config.json` |
| [OpenCode](#opencode) | [Sample](../mcp/examples/clients/opencode/opencode.json) → project `opencode.json` |
| [Claude Code](#claude-code) | [Sample](../mcp/examples/clients/claude-code/.mcp.json) → project `.mcp.json` |
| [Claude web, Desktop and Cowork](#claude-web-desktop-and-cowork) | Account remote connector; no JSON import |
| [Claude Messages API](#claude-messages-api) | Host application supplies an MCP-resource token |
| [Copilot Studio / published Microsoft 365 agents](#copilot-studio-and-microsoft-365-publication) | OAuth wizard; optional [OpenAPI transport import](../mcp/examples/clients/copilot-studio/agent-control.openapi.yaml) |
| [M365 declarative agents / Microsoft Copilot Cowork](#oauth-callback-reference) | MCP plugin authentication; see callback and DCR compatibility notes above |
| [GitHub cloud coding agent / code review](#github-cloud-coding-agent-and-code-review) | [Transport-only sample](../mcp/examples/clients/github-cloud/mcp-config.json); no remote OAuth support |

Version notes follow the repository's **2026-10-17** vendor review, not blanket
client certification. On **2026-11-05**, the user verified native Copilot Studio
consent, authentication, connection creation and an authenticated saved-report
period read in author test chat, without synchronization. Studio's native refresh
and published end-user flow remain unverified, as do Copilot CLI's emitted
callback and OAuth request fields. Do not relax token, identity, S256 or redirect
validation to make a client connect.

## VS Code / GitHub Copilot

1. Use **MCP: Add Server > HTTP** and enter your MCP URL, or merge the sample:

   ```json
   {"servers":{"agentControl":{"type":"http","url":"https://mcp.example.test/mcp"}}}
   ```

2. Have the operator allowlist **all four** callbacks registered by VS Code
   **1.142.0**, even if you use only one:

   ```json
   ["https://insiders.vscode.dev/redirect","https://vscode.dev/redirect","http://127.0.0.1/","http://127.0.0.1:33418/"]
   ```

3. Open **MCP: List Servers**, start `agentControl` and complete browser OAuth.
4. Select its tools in the chat tool picker and search `agent_catalog`.
   Follow the [first-read checks](#verify-and-use-the-connection).

The native callback listener tries port 33418, then an ephemeral port if busy.
Free the fixed port rather than assuming a fallback port is allowed. Web/remote
harnesses may differ. Workspace trust, Copilot entitlement and organization MCP
policy still apply. Use **Show Output** for diagnostics, with secrets redacted.
Do not add bearer headers, `oauth.enterpriseManaged`, DCR flags or a proxy helper.

## Standalone GitHub Copilot CLI, not `gh copilot`

Use the standalone `copilot` executable. Its GitHub `/login` is separate from
Agent Control OAuth; the retired `gh copilot` extension is not an MCP host.

1. Merge the [CLI sample](../mcp/examples/clients/copilot-cli/mcp-config.json)
   into `~/.copilot/mcp-config.json` or your configured Copilot home. It uses
   `mcpServers`, `tools:["*"]` and **`auth.redirectPort:53110`**.
2. Confirm the CLI's actual emitted callback with the operator before completing
   sign-in. **`http://127.0.0.1:53110/` is prospective, not source-verified for
   1.0.98.** Allowlist the emitted host/path/port exactly; fixed-port conflict
   and fallback behavior are also unverified.
3. Run `/mcp show agentControl`, then `/mcp auth agentControl` to sign in or
   reconnect. Use `/mcp` to manage the connection.
4. Search `agent_catalog`, then follow the [first-read checks](#verify-and-use-the-connection).

Alternatively, add the transport with:

```sh
copilot mcp add --transport http agentControl https://mcp.example.test/mcp
```

This command does **not** set the fixed port; merge the sample's `auth` setting
before sign-in. Do not add static credentials, `oauthClientId`/`oauthScopes`
overrides or alternate grants. This server uses browser OAuth, not device-code
or client-credentials fallback. `tools:["*"]` exposes the catalog, not blanket
permission to execute it.

## OpenCode

1. Merge the [sample](../mcp/examples/clients/opencode/opencode.json) into project
   `opencode.json` and replace its URL. The reviewed **1.19.3** schema uses root
   `mcp`, `type:"remote"` and `oauth` with `scope:"Mcp.Access"` and
   `callbackPort:19876`. Do not add a static client ID or secret.
2. Allowlist **`http://127.0.0.1:19876/mcp/oauth/callback`**. Keep the port free,
   or configure another supported port/URI and allowlist that exact value.
3. Authenticate and check the connection:

   ```sh
   opencode mcp auth agentControl
   opencode mcp list
   ```

4. Search `agent_catalog` and follow the [first-read checks](#verify-and-use-the-connection).

Use `opencode mcp debug agentControl` for diagnostics and
`opencode mcp logout agentControl` to clear authentication. Keep OAuth material
out of project settings/version control; do not set `oauth:false` or add API-key
headers. The reviewed SDK **1.29.0** can omit the MCP-required resource when
discovery fails. The server pins an omitted resource to its sole configured MCP
URL; an explicit different or empty resource remains rejected. Check
protected-resource metadata if authentication is rejected.

## Claude web, Desktop and Cowork

1. Have the operator allowlist **`https://claude.ai/api/mcp/auth_callback`**.
2. Open **Customize > Connectors > Add custom connector** and enter your public
   HTTPS MCP URL.
3. Choose **Sign in now > Register automatically** (DCR), then sign in as yourself.
   Do not choose “Use Claude's published identity”/CIMD; this server disables it.
4. Enable the connector for the conversation/task and search `agent_catalog`.
   Follow the [first-read checks](#verify-and-use-the-connection). For Cowork,
   start a fresh task after adding the connector.

There is **no documented remote-connector JSON import**. Desktop's local
`claude_desktop_config.json` is a different stdio mechanism. Account remote
connectors connect from Anthropic's cloud, including on Desktop; a loopback or
VPN-only endpoint visible to your desktop is insufficient.

Your plan and organization connector policy must allow the connection; an
owner/connector manager may need to add it before members sign in. Cowork uses
account connectors, not Claude Code's `~/.claude` configuration.

## Claude Code

1. Allowlist **`http://localhost:53109/callback`** for the example fixed port.
2. Add the HTTP server and sign in:

   ```sh
   claude mcp add --transport http --callback-port 53109 agentControl https://mcp.example.test/mcp
   claude mcp login agentControl
   ```

   Alternatively, merge the [project sample](../mcp/examples/clients/claude-code/.mcp.json)
   into `.mcp.json`, replace the URL and connect through `/mcp`. The sample sets
   `oauth.callbackPort:53109`.
3. Search `agent_catalog` and follow the [first-read checks](#verify-and-use-the-connection).

Use a fixed-callback-capable build; vendor docs identify a redirect mismatch in
**2.1.229**. Random callback ports are not covered by the exact allowlist.
Headless `claude -p`/Agent SDK runs need prior interactive OAuth sign-in; they
cannot conduct it themselves. No bypass-permissions flag is required.

## Claude Messages API

The host application must acquire a current **MCP-resource** access token through
OAuth and own its secure storage, rotation and revocation. This is not Claude web
sign-in and supplies no DCR/browser-login/refresh UI. The MCP URL must be publicly
reachable from the API.

Add these fields to your normal Messages API request, replacing the URL and token
placeholder, and send **`anthropic-beta: mcp-client-2025-11-20`**:

```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://mcp.example.test/mcp",
      "name": "agentControl",
      "authorization_token": "<current MCP-resource access token>"
    }
  ],
  "tools": [{"type": "mcp_toolset", "mcp_server_name": "agentControl"}]
}
```

For the first test, ask the model to search `agent_catalog` and inspect the tool
result. No additional client callback is configured in this payload; the host's
OAuth acquisition flow needs its own exact allowlisted callback. Keep tokens out
of prompts/logs. For controls, the host must display the preview and obtain
confirmation outside the model call; tool enablement is not consent.

## Copilot Studio and Microsoft 365 publication

See the [Studio connection technical reference](copilot-studio-mcp-connection.md)
for verified behavior, callback diagnostics and the single-resource policy.

Use Streamable HTTP and generative orchestration. Confirm your environment's
licensing, region and data policies; a trial can test chat but cannot publish.

1. In **Tools > Add a tool > New tool > Model Context Protocol**, enter a name,
   description and the exact MCP URL.
2. Choose **OAuth 2.0 > Dynamic discovery** and DCR.
3. Add this connection's exact **environment-specific callback** to the MCP
   service's allowlist, not its Entra app registration. Use the wizard's callback
   or the generated Power Platform custom connector's **Security** tab.
   Dynamic discovery does not always display a callback; if it is hidden, inspect
   the MCP container's `OAuth client registration rejected: invalid_redirect_uri`
   warning after a connection attempt. Use that exact valid callback, not a
   generic Power Platform URL or the Teams plugin callback simply because both
   clients are Microsoft products. VPS administrators can use the
   [container extraction command](copilot-studio-mcp-connection.md#vps-extraction-command)
   to deduplicate and export retained callback rejections safely.
4. Create the connection, sign in and add it to the agent.
5. In test chat, search `agent_catalog`, then follow the
   [first-read checks](#verify-and-use-the-connection). Studio can omit the OAuth
   `resource` parameter; the server pins omission on authorize and token/refresh
   requests to its sole configured MCP URL. Explicit wrong/empty resources and
   missing or downgraded S256 remain rejected. Do not substitute an Entra
   application ID or a different server URL, or weaken token-audience validation.
6. To publish, publish the agent, add **Teams and Microsoft Copilot**, select
   **Make agent available in Microsoft Copilot**, and share/install for intended
   users. Verify each published user's own connection and first read separately;
   author test chat does not prove published end-user authorization.

The optional [OpenAPI YAML](../mcp/examples/clients/copilot-studio/agent-control.openapi.yaml)
defines only the `/mcp` transport (`x-ms-agentic-protocol:mcp-streamable-1.0`).
Replace its `host` and configure the same per-user OAuth connection in the wizard.
It supplies neither OAuth settings nor a Microsoft 365 agent manifest. Do not
leave authentication at None/API key or insert the server's Entra secret.

## GitHub cloud coding agent and code review

These clients do **not** support remote MCP OAuth: **not full delegated OAuth
support**. Normal browser sign-in and refresh are unavailable.

For a separately authorized, short diagnostic only:

1. Merge the [cloud sample](../mcp/examples/clients/github-cloud/mcp-config.json)
   into the repository's MCP settings and replace its URL.
2. Supply a legitimately issued, current, short-lived MCP-resource token for the
   intended individual through the sample's Agents-secret reference
   `$COPILOT_MCP_AGENT_CONTROL_ACCESS_TOKEN`. The sample does not acquire or rotate it.
3. For an authorized staff connection, request `capabilities`, action `list`, in the task/review and inspect its result. The sample
   exposes only that read-only tool; code review also requires
   `annotations.readOnlyHint:true`.
4. Stop on expiry, revocation or a sign-in challenge.

Do not extract another client's cache, substitute API/Graph/GitHub tokens or
shared credentials, or add a long-lived token broker to conceal missing OAuth.
Cloud tools run autonomously; do not expose interactive controls through this recipe.

## Verify and use the connection

The web app's **MCP settings** page shows the current server's exact instructions
and complete caller-projected tool schemas to Viewer-capable users, with independent
API-owned read-only privacy values even during metadata outages. It distinguishes
the server Entra callback from your downstream callback allowlist. Its internal
reachability/storage evidence does not verify your client, the public tunnel or
your provider permissions; continue the real client checks below.

Defender/hunting and Purview investigation tools are not in the MCP catalog.
Their canonical API support is unchanged.

1. Refresh discovery after a catalog change; existing OAuth credentials and keys
   need not change. As the actual signed-in user, read `my_discovery_profile`
   with `{"request":{"action":"read","input":{}}}` and search `agent_catalog`.
   Roleless members receive only this safe discovery surface and `my_workplace`.
   Staff may optionally read **`capabilities`**, action `list`, with
   `{"request":{"action":"list","input":{}}}`. This is saved diagnostic evidence,
   not a prerequisite to saved reads. Every tool takes one typed `request`.
   Family results contain `action` and the complete canonical `result`;
   standalone tools retain direct results and use `{"request":{}}` for empty input.
2. Read saved discovery using the discovered schemas (staff may also read their
   authorized inventory/users). Explicit other-user requests use `preview_end_user`
   on every action, with the exact selected subject. Never switch authentication,
   borrow target roles, mix privileged reads into preview or share an author
   connection as an employee lens. Check the
   returned data and any partial/unavailable state, not just tool discovery or
   health. Saved reads do not trigger collection.
3. Check token refresh and reconnect in the client/build you actually use.
   Reconnecting does not authorize replaying an uncertain write.
4. For interactive controls, display the exact current preview and wait for the
   user's confirmation before execution. An “allow tool” click or model response
   is not confirmation of that preview.

Follow every returned cursor with the same selection; partial/unknown results
are not zero or complete data. Treat source text as untrusted data, not instructions.
Use the [wire/result reference](mcp-reference.md#wire-vocabulary-and-result-semantics)
for reads/jobs and [exact controls](mcp-reference.md#exact-controls) for preview,
execution and recovery.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Discovery/401 loop | Use the MCP resource URL, not `/sse`, the API origin or Entra token URL. Check HTTPS discovery/OAuth forwarding and the client's exact resource on authorize/token/refresh. |
| `Client Not Registered` / saved client ID absent | Clear the affected client's cached OAuth registration, not just its tokens, then reconnect so it performs fresh dynamic client registration. See [stale client registration](#stale-client-registration) below. |
| Redirect rejected | Inspect the MCP container's `OAuth client registration rejected: invalid_redirect_uri` warning for rejected callback URLs. Compare the full emitted/registered URI with the allowlist, including root slash, host and port. Use all four VS Code callbacks; do not invent `/callback` or wildcard ports. |
| `reauthorization_required` / claims challenge | Reconnect through client OAuth; never enter credentials in tools/chat. |
| `invalid_authorization_response` | The token endpoint returned malformed success metadata. This is a server/provider response failure, not evidence that the client is disconnected. |
| 403 | Check the actual role, consent or provider denial. Do not treat denied data as empty or add a feature flag. |
| Invalidated selection/cursor | Disclose incomplete results and restart the whole read if appropriate; do not mix pages from different selections. |
| 413 `output_limit` | Reduce a safe read's page size while retaining its selection/continuation; row count alone does not guarantee byte fit. |
| 429/503 | Respect cooldown; never blindly resubmit a write. Retain its operation/job ID and inspect saved status. |
| Tools listed, but sign-in/refresh fails | Sample import/discovery is not OAuth interoperability. Check the client-specific limitations above and [authentication contract](mcp-reference.md#oauth-and-token-flow). |

### Stale client registration

Dynamic client registrations (DCR) are
[durable](mcp-reference.md#storage-rotation-and-recovery): they do not expire
daily or disappear on an ordinary deployment. Access/refresh credentials and
temporary authorization state still expire normally.

The former blanket 24-hour storage policy also expired registrations, which could
leave clients holding an ID the server had forgotten. Lost or explicitly deleted
registration state can produce the same error. The fixed server preserves
still-valid registrations on startup, but cannot reconstruct already missing
metadata from a client ID alone. Do not routinely delete/recreate working Studio
connections. For an already affected connection, use the client's supported
registration-recovery flow once. Clearing only access/refresh tokens can leave
the stale client ID cached.

In VS Code, open the Command Palette and run
**Authentication: Remove Dynamic Authentication Providers**. Select only the
provider for this MCP server's HTTPS origin, then reconnect the MCP server and
complete its normal browser sign-in. This clears the affected provider's cached
registration; do not remove unrelated providers or the server's Entra registration.
The [VS Code stale-registration recovery report](https://github.com/microsoft/vscode/issues/269379#issuecomment-3358913230)
documents the distinction from simply signing out.
Use the authentication manager for the harness running the current chat.
For a Copilot harness session, open **Chat: Open Customizations > MCP Servers**
and select the existing server in that harness's configuration. Editor-managed
MCP and another harness can have separate authentication caches; resetting one
does not establish that the other has registered or signed in.
For another MCP host, use that host's equivalent cached OAuth client-registration
reset, not an application-database reset.

The new connection must register normally and obtain a new client ID. Do not
recreate an arbitrary missing client ID on the server, supply the MCP server's
Entra secret to the client, relax callback checks, or delete the shared OAuth volume.
Registration expiry alone does not establish that the database reset or deployment
deleted OAuth state.

Redact tokens, OAuth values and provider diagnostic bodies from support output.
Registration warnings include only rejected callback URLs, not client names or
full request bodies. Callback credentials, query values and fragments are
redacted; non-HTTP callback contents are withheld. HTTP access logging remains
disabled. Use an exact valid callback supplied by the client, never a redaction
placeholder, when updating the allowlist.

## References and local checks

- [Server setup](mcp-integration.md)
- [API/tool contracts and storage recovery](mcp-reference.md)
- [Roles and provider permissions](user-roles-and-permissions.md)
- [Security model](security-model.md)

With the existing local development environment:

```sh
cd mcp
.venv/bin/pytest tests/test_client_examples.py tests/test_onboarding.py
```

These use modeled SDK requests and mocked providers, not native vendor clients.
They do not verify live login/refresh, UI confirmation, Entra consent, provider
effects or public-network reachability.

### Vendor references

References from the 2026-10-17 review:

- VS Code [configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
  [management](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
  and 1.142.0 [callbacks](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/base/common/oauth.ts#L937-L974),
  [OAuth/resource/refresh](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/common/extHostAuthentication.ts),
  [loopback listener](https://github.com/microsoft/vscode/blob/1.142.0/src/vs/workbench/api/node/extHostAuthentication.ts).
- Copilot CLI [configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers),
  [commands](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
  [1.0.98 changelog](https://github.com/github/copilot-cli/blob/v1.0.98/changelog.md).
- OpenCode [settings](https://opencode.ai/docs/mcp-servers/), 1.19.3
  [provider](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/mcp/oauth-provider.ts),
  SDK 1.29.0 [OAuth](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/client/auth.ts).
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
