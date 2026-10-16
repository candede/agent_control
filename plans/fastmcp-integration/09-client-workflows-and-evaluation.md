# 09 - Client onboarding and workflow evaluation

## Mission and inputs

Verify client workflows over [06](06-mcp-read-tools.md)/
[07](07-mcp-agent-controls.md) using [08](08-local-container-integration.md).
Read [current API semantics](../../docs/mcp-integration.md),
[usage](../../docs/official-usage-import.md) and
[security](../../docs/security-model.md). Inspect actual catalog/configuration;
no obsolete phase snapshots or acceptance file are prerequisites.

## Implementation

1. Document actual Streamable HTTP/discovery/registration/scopes/callback
   onboarding per client: Copilot Studio/Microsoft 365 publication, VS Code/
   GitHub Copilot, Claude and supported customer cowork clients. Verify current
   supported editions and OAuth refresh behavior separately.
2. Provide ordinary workflow recipes for exact person resolution, complete
   relationship pagination/About, champions, comparable trends, explicit
   refresh/investigation, and interactive versus scheduled controls.
3. Interactive workflows display current preview and confirm each block;
   changed/expired receipts require new display/confirmation. External scheduled
   workflows use the same current receipt without pausing for a human. Explain
   that MCP annotations do not prove human consent.
4. Build one synthetic corpus spanning native/guest identities, duplicate names,
   company/department champions/nonchampions, all platforms, report-only rows,
   missing evidence, full Unicode descriptions and report overlap/unknown periods.
   Expected IDs/counts/source associations must be explicit.
5. Check actual tool calls and final claims: complete pagination, exact
   relationships, source references, no invented trends, correct control effects,
   confirmation behavior and verified versus accepted status.
6. Include adversarial source descriptions as inert data, denial, claims
   challenges, revocation, changed targets, partial results and reconnect.
7. Document attribution support per client: authenticated IDs versus reported
   names/agents and unknown values. Concurrent sessions/invocations may not leak
   labels across requests.
8. Compare paired web/MCP methods/routes/input/effects/errors under identical
   principal/source/prestate. Only legitimate transport/provenance differs.
   Repair defects in current tool/API/web owners, not client-side business joins.

## Verification and handoff

Use deterministic protocol/fixture tests first. Attempt real client/model
onboarding, tool invocation and refresh only with authorized synthetic data and
available connectivity. No auto-tunnels, paid provisioning or confidential
source/data export. Missing clients/accounts/ingress are unavailable, not passed;
SDK fixtures do not prove remote client support.

Observe interactive pause and scheduled no-pause directly, not from docstrings.
Record versions, exact cases, redacted outcomes and repeated scenario failures,
then update current client setup documentation. Run affected Python/API tests,
link checks and diff hygiene. [11](11-release-qualification.md) and
[12](12-production-convergence.md) consume concrete remaining proof obligations.
