# Copilot Studio MCP connection: technical reference

Verified on **2026-11-05** against Agent Control's MCP server and Copilot Studio's
native **OAuth 2.0 > Dynamic discovery** connection flow.

## TLDR

Only **two connection-blocking issues** were fixed:

1. **Missing allowed callback:** Added Copilot Studio's exact generated connector
   redirect URL to the MCP server's allowlist, not the Entra app registration.
2. **Missing OAuth `resource` parameter:** Studio omitted it from the authorization
   request. The server now defaults omission to its exact `MCP_PUBLIC_URL` during
   authorization and token processing. This was not a missing access-token field.

Supporting work added sanitized callback diagnostics, regression tests and
documentation, followed by an MCP-only redeployment.

The Entra registration, credentials, permissions, PKCE and token-audience checks
were unchanged. The application and database were not restarted.

**Result:** Studio authentication succeeded, and the agent read saved reporting
periods through MCP without synchronization.

## 1. Verified outcome and limits

The current native catalog is request-scoped to the actual connection user.
An active member without staff roles receives `agent_catalog`, `my_workplace`
and `my_discovery_profile`; staff also receive authorized staff operations and
`preview_end_user`. Use an individual delegated connection, not a shared
privileged author connection as an employee lens. Explicit subject requests
must use safe preview on every action; this never authenticates as that subject
or borrows its roles. API-owned privacy applies independently to owner/champion
identities. Source descriptions remain inert data and discovery grants no use
permission. These current contracts do not expand the historical native-client
verification in the table below.

For on-demand tool/session diagnostics after connection, see
[MCP session flight recorder](mcp-session-recording.md). It captures MCP traffic,
not the Studio conversation transcript.

| Check | Evidence |
| --- | --- |
| Studio registration and authentication | User completed MCP access consent, authentication and connection creation. |
| Authorized MCP data access | Author test chat returned three saved reporting periods without synchronization. |
| Missing-resource handling | Server tests covered authorization, code exchange and refresh; local and public HTTP probes reached SDK client validation instead of failing resource validation. |
| Security regression checks | 248 focused OAuth, storage, authority, metadata and client tests passed; targeted Ruff and mypy checks passed. |
| VPS diagnostic extraction | Public registration rejections were extracted through `docker logs` piped to `docker exec -i`; table, JSON and CSV outputs verified counts, UTC timestamps and repeated redaction. |
| Native refresh and published channels | Not tested. Author test chat does not verify published end-user connections. |

The captured Studio authorization request omitted `resource`. Native Studio
token-request fields were not logged. Do not claim every Studio request omits
that parameter, or generalize this result to other Microsoft MCP clients.

## 2. Keep the three URL roles separate

Examples below use a placeholder host.

| Purpose | Example | Configuration owner |
| --- | --- | --- |
| MCP protected resource | `https://mcp.example.test/mcp` | `MCP_PUBLIC_URL` and Studio's server URL |
| Entra returns authorization to MCP | `https://mcp.example.test/auth/callback` | **Web** redirect URI on the MCP Entra app registration |
| MCP returns authorization to Studio | Exact generated connector callback | MCP `MCP_ALLOWED_CLIENT_REDIRECT_URIS` |

Flow:

```text
Studio -> MCP /authorize -> Entra sign-in
Entra -> MCP /auth/callback -> Studio connector callback
Studio -> MCP /token -> authenticated MCP /mcp requests
```

- Studio's downstream callback is not the MCP server's Entra redirect.
- The observed callback used the shape
  `https://global.consent.azure-apim.net/redirect/<connector-specific-id>`.
  This is a shape example, not an address to register.
- Obtain the complete callback from the current connector or request diagnostics.
  Do not derive it from the connector's display name.
- `https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect` belongs to the
  documented Microsoft plugin flow. Its presence in the allowlist did not satisfy
  this Studio connector.
- No Entra redirect change was needed in this session: `/auth/callback` was
  already correct. The missing Studio callback belonged in MCP configuration.
- Studio runs remotely. A local Docker listener needs reachable public HTTPS
  ingress; `localhost` or a Docker service name is not Studio's server URL.

## 3. Failure signatures and root causes

| Failure | Boundary | Confirmed cause | Correct response |
| --- | --- | --- | --- |
| `invalid_redirect_uri`: `Only exact approved client redirects are supported.` | DCR `/register` | Studio's generated callback was absent from the MCP allowlist. | Add that exact approved callback, retaining existing callbacks. |
| `invalid_request`: `Exact resource and PKCE required.` | `/authorize` before SDK processing | Studio sent S256 PKCE and a valid-length challenge, but omitted `resource`. | Apply the fixed single-resource policy described below; do not remove PKCE checks. |
| `Invalid OAuth resource, PKCE, or grant type.` | Current HTTP boundary | Explicit invalid resource, invalid authorization method or unsupported token grant. | Inspect the relevant non-secret parameters; do not disable validation. |
| `Client Not Registered` | `/authorize` or refresh client validation | The connector presents a saved DCR ID with no server registration. The former blanket 24-hour retention policy could cause this even for working connections. | Current registrations are durable and survive daily boundaries/redeployments. Existing missing IDs require the connector's supported registration recovery; do not repeatedly recreate working connections, reset SQL or fabricate the old registration. |

An error naming both resource and PKCE does not prove PKCE is missing. Diagnose
the actual parameters. Start a fresh Studio authorization attempt after a fix;
do not reload an old authorization URL with expired state.

## 4. Discover callbacks without exposing OAuth credentials

Dynamic discovery did not display the callback in this wizard. Alternatives:

1. Check the generated custom connector's **Security** tab.
2. Retry registration and inspect the MCP service's sanitized rejection warning.

Diagnostic format:

```text
OAuth client registration rejected: invalid_redirect_uri; rejected_redirect_uris=[...]
```

Example for the local project used during verification:

```sh
docker logs --since 10m seha-agent-control-mcp-1 2>&1 \
  | grep -F 'OAuth client registration rejected:'
```

Use the current container name. Another deployment can replace the container
while troubleshooting.

- Few startup log lines do not prove a request never reached MCP. Uvicorn access
  logging is deliberately disabled, and the original registration rejection had
  no application-owned callback diagnostic.
- The added warning logs only rejected callbacks. User information, query values
  and fragments are redacted; unsupported URI schemes are withheld.
- SDK OAuth log records are separately sanitized because the pinned SDK can log
  rejected authorization codes.
- Do not enable raw OAuth request logging or record full authorization URLs,
  client secrets, authorization codes, state values or tokens.
- Redacted callback components are not configuration values. Obtain an exact
  callback securely if redaction removed anything required for registration.

### VPS extraction command

The installed helper reads log lines from **stdin**. Docker's daemon owns the
container logs; `docker exec` alone cannot read them. Pipe the host's `docker logs`
output into the helper. No Docker socket mount or duplicate log file is needed.

Run in **Bash on the VPS**, with Docker access:

```bash
set -o pipefail
MCP_CONTAINER=seha-agent-control-mcp-1

docker logs --since 24h --timestamps "$MCP_CONTAINER" 2>&1 \
  | docker exec -i "$MCP_CONTAINER" \
      python -m agent_control_mcp.redirect_diagnostics
```

Replace the container name for the installation. Use `-i`, **not `-t`**, and do
not use `docker logs --follow`. Keep `pipefail` so a Docker command failure cannot
be mistaken for an empty successful extraction.

For a JSON export saved on the **VPS host**:

```bash
docker logs --since 24h --timestamps "$MCP_CONTAINER" 2>&1 \
  | docker exec -i "$MCP_CONTAINER" \
      python -m agent_control_mcp.redirect_diagnostics --format json \
  > mcp-redirect-diagnostics.json
```

Use `--format csv` and a `.csv` output filename for CSV. The helper deduplicates
callbacks and reports occurrence count, first/last known UTC timestamps, and:

| Status | Meaning |
| --- | --- |
| `not_allowed` | Canonical callback absent from this container's current allowlist. Review its legitimacy before configuring it. |
| `allowed_now` | A historical rejection is now present in the current allowlist. |
| `invalid_or_redacted` | Invalid or sanitized URI; do not paste it into configuration. |

- A callback repeated within one rejection counts once for that event.
- Missing Docker timestamps produce empty timestamp fields, not invented times.
- Output includes no raw request, client name, token or OAuth state. URI credentials,
  query values and fragments are redacted again during extraction.
- Redaction preserves noncanonical spelling and empty query/fragment delimiters,
  and escapes control characters before URL parsing. It never turns an invalid
  callback into an `allowed_now` match.
- The helper is read-only: it does not register clients, approve callbacks or
  change configuration.
- Malformed matching diagnostics, invalid or unrepresentable UTC timestamps,
  invalid runtime allowlists or exceeded input bounds produce an explicit error
  and exit code `2`, not partial success output.
  Input is bounded at 64 KiB per line, 64 MiB total and 4,096 distinct callbacks.
  Rejection events may contain more callbacks than the configured allowlist;
  extraction applies the log-input bounds, not the allowlist's 32-entry limit.
- An empty result prints an explicit notice. It does not prove no request arrived.
  Logs may have rotated, the selected time window/container may be wrong, or
  validation may have failed before a callback diagnostic was emitted.
- Docker log retention is finite, and removed containers lose their logs.
  Extract promptly after reproducing the failure and before container recreation.
  Registration warnings go to the existing server log stream; access logging and
  SDK credential-log sanitization remain unchanged.

## 5. Fixed single-resource policy

Agent Control's authorization server serves one configured MCP resource.
An **absent** `resource` is pinned to `MCP_PUBLIC_URL` before the SDK creates or
redeems an OAuth grant.

| Surface | Normalization |
| --- | --- |
| `GET /authorize` | Add the configured resource to the authorization query. |
| `POST /authorize` | Add it to the form body and update `Content-Length`. |
| `POST /token`, authorization-code grant | Add it before SDK code redemption. |
| `POST /token`, refresh-token grant | Add it before SDK refresh processing. |

Required invariants:

- Default only absence. Reject explicit empty, duplicate, different-host or
  different-path resource values.
- Never use an Entra application GUID, caller-selected audience or a shared
  authorization server's generic default as the MCP resource.
- Keep the provider's exact-resource validation. HTTP normalization supplies its
  required value; it does not bypass that validation.
- Keep S256, exact redirects, client binding, single-use codes, issuer, audience,
  tenant, delegated scopes, user identity, API roles and revocation checks.
- Preserve other form values and enforce the **65,536-byte** raw and rewritten
  authorization/token input bounds.
- Do not forward the downstream HTTPS resource to Entra. The provider retains
  `forward_resource=False` and uses its configured Entra scopes.

**Standards distinction:** RFC 8707 section 2.1 permits an authorization server
to use a predefined resource when the client omits it. The MCP authorization
specification still requires clients to send `resource` in authorization and
token requests. This server policy does not make Studio's observed omission
MCP-client-spec compliant.

## 6. Durable configuration and MCP-only rollout

- Persist the callback in project settings and the generated Compose environment;
  a one-off container environment edit is insufficient.
- Verify the running container actually has the configured resource and complete
  callback set. Preserve other clients' callbacks.
- For a code-only MCP fix, recreate **MCP only**. Do not restart the application
  or database, reset the schema, or delete the encrypted OAuth volume.
- Preserve confidential credentials, signing/encryption keys, protected mounts,
  non-root user, loopback listener, network and container security settings.
- A non-editable package in a read-only container needs a new image. The verified
  recovery used an offline derivative of the exact running image, copying only
  the changed installed Python module; no dependency downloads were needed.
- Pin the resulting immutable image. Keep deployment and operation receipts
  consistent with the repository lifecycle contract.
- The lifecycle helper removes inherited project-owned environment overrides
  before Compose so the project's environment file remains authoritative.
- Compare Docker environment **key/value mappings**, not list order. Ordering
  changed during recreation without any configuration value changing.
- On macOS Docker Desktop, a bind source can appear under `/host_mnt/Users/...`.
  Use the repository's verified Desktop mapping rule, not arbitrary path stripping.
- Confirm application/database container IDs **and start times** are unchanged.
  Verify live module bytes match the tested source.

Normal supported use requires real authentication and consent, not an extra
application approval, feature-enable switch or manual synchronization.

## 7. Minimal Studio setup and real verification

1. Add the exact public MCP URL as a **Model Context Protocol** tool using
   Streamable HTTP.
2. Select **OAuth 2.0 > Dynamic discovery**. The server supplies discovery and
   public DCR; do not give Studio the MCP server's Entra client secret.
3. Configure the exact generated Studio callback as described above.
4. Create a fresh connection, complete sign-in and MCP access consent, and attach
   the connection to the agent.
5. In the agent's **Test chat**, send:

   > Use the MCP server to list the saved reporting periods. Do not run any synchronization.

6. Confirm a real MCP read returns saved periods or explicitly reports none.
   Tool discovery, a created connection and a green health check alone do not
   prove saved-data access. A reply without a tool call is not read verification.

Connection display names are management labels, not resource URLs, audiences,
permissions or public agent names. Server descriptions and agent instructions
are context, not authorization.

A local Copilot CLI MCP configuration is separate from Studio's cloud connection.
Changing the local JSON does not configure Studio's callback or authentication.
An unrestricted tool list in a local client is not a read-only security policy.

For an adoption advisor, enable only the read-only operations it needs. Treat
saved MCP data as the primary organizational source; identify report periods,
freshness and missing metrics. Do not add totals across overlapping reporting
periods or treat unavailable metrics as zero. Reading saved data must not trigger
synchronization or administrative control.

## 8. Implementation and references

| Concern | Repository source |
| --- | --- |
| Exact callback validation and sanitized rejection logging | [auth.py](../mcp/src/agent_control_mcp/auth.py) |
| Read-only container log extraction | [redirect_diagnostics.py](../mcp/src/agent_control_mcp/redirect_diagnostics.py) |
| Resource normalization, request bounds and content length | [service.py](../mcp/src/agent_control_mcp/service.py) |
| SDK OAuth log sanitization | [package initialization](../mcp/src/agent_control_mcp/__init__.py) |
| Disabled access logging | [entry point](../mcp/src/agent_control_mcp/__main__.py) |
| Omission, invalid-resource, PKCE, replay and redaction tests | [test_oauth.py](../mcp/tests/test_oauth.py) |
| MCP-only lifecycle and receipt binding | [local-mcp.ps1](../scripts/local-mcp.ps1) |
| Environment authority and Desktop bind mapping | [local-deployment.ps1](../scripts/local-deployment.ps1) |

- [Client setup guide](mcp-clients.md#copilot-studio-and-microsoft-365-publication)
  and [authentication contract](mcp-reference.md#oauth-and-token-flow).
- [Microsoft: connect an existing MCP server](https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent).
- [Microsoft: custom connector OAuth configuration](https://learn.microsoft.com/en-us/connectors/custom-connectors/#21-oauth-20).
- [Microsoft: plugin OAuth callback](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth).
- [RFC 8707 section 2.1: authorization resource defaults](https://www.rfc-editor.org/rfc/rfc8707.html#section-2.1).
- [MCP 2026-07-28: Resource Parameter Implementation](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#resource-parameter-implementation).

Microsoft and standards references were checked on **2026-11-05**. They document
the protocols and setup; the verification table records this session's narrower
runtime evidence.
