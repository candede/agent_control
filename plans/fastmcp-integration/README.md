# FastMCP integration roadmap

The current product is the Express API and React web app. API authentication,
saved-read contracts, generic controls and audit origin are described by the
[current API contract](../../docs/mcp-integration.md),
[data architecture](../../docs/data-architecture.md) and
[security model](../../docs/security-model.md), not old implementation records.
This roadmap describes remaining work; it is not deployment or live-test evidence.

## Runtime and product boundaries

- Browser -> authenticated API -> saved data or explicit provider operation ->
  durable result/job/audit. The web app must work without MCP.
- Future client -> tenant-bound FastMCP OAuth -> audience-correct delegated API
  token -> the same canonical API method/route -> bounded typed result.
- API owns identity, roles, data scope, queries/calculations, provider access,
  jobs, exact control receipts and audit. MCP owns protocol/auth adapters and
  encrypted connection state, not another application database or provider writer.
- The customer client owns LLM interpretation, scheduling and interactive
  confirmation. No server scheduler, classifier, business approval engine,
  arbitrary SQL/HTTP/KQL tool or app-only customer identity.
- Saved reads remain provider-free. Refresh, directory enrichment,
  investigation and controls are explicit operations. Missing data is unknown.
- Preserve Viewer/Admin, provider permissions, tenant/principal isolation,
  exact targets, current prestate/readback and non-replay of uncertain writes.
  Receipts establish exact intent, not an additional application approval.
- Generic Studio controls quarantine/unquarantine; other supported agents use
  package block/unblock. Explicit package-only and Studio-only operations keep
  their existing effects.
- Full available descriptions/configuration, exact source associations,
  report semantics, champions and comparable-window limits remain API-owned.
  Do not guess identity from names or sum overlapping report snapshots.
- Audit separates verified user/channel from reported calling-client/agent
  labels and provider source. Unknown historical attribution remains unknown.

## Current-only deployment

One current schema constructor/verifier supports empty installation and exact
current-schema restart. Incompatible data is reset only with explicit exact
target/data-loss confirmation; there are no supported upgrades or old writers.
Backup/isolated restore use the current schema. Reset deletes official reports
and saved history, requiring reimport; normal first sync starts automatically.
See [operations](../../docs/operations.md).

The confirmed production target is current-host Compose project `seha`.
04C verifies/releases API/web without MCP. Later MCP work extends the same local
owner while preserving `seha_data`; Azure deployment support remains tooling,
not an implicit cloud migration. Live resources, public ingress, tenant grants
and provider mutations require their actual operator authorization.

No completion file, user-acceptance artifact, read qualification, canary or
provider-enable flag may become a prerequisite for normal supported flows.
Application-mode investigations use current configuration/real authorization
and configured shared scope directly. Only actual maintenance pauses dispatch.

## Remaining sequence

| Phase | Deliverable | Inputs |
| --- | --- | --- |
| [04C](04C-api-webapp-production-release.md) | Current-only API/web installation/reset and first-run verification | Current contracts and operations |
| [05](05-fastmcp-service-and-auth.md) | FastMCP package, OAuth, encrypted state, API adapter | Current authentication/API contracts |
| [06](06-mcp-read-tools.md) | Typed saved-read, refresh and investigation tools | 05 and current API read contracts |
| [07](07-mcp-agent-controls.md) | Exact shared control adapters | 05/06 and current control contracts |
| [08](08-local-container-integration.md) | Local container, setup and lifecycle tooling | 05–07 and existing deployment owner |
| [09](09-client-workflows-and-evaluation.md) | Client onboarding and synthetic workflow evaluation | 06–08 |
| [10](10-azure-deployment-integration.md) | Azure container hosting/deployment tooling | 05/08/09 and current Azure owner |
| [11](11-release-qualification.md) | Integrated release/recovery/capacity verification | Implemented 05–10 |
| [12](12-production-convergence.md) | Authorized local MCP release and observed user journeys | Current implementation and 08–11 results |

Retained filenames provide stable roadmap links, not a mandate to replay
already implemented foundations. Implement one coherent phase at a time, inspect
current source first and update the canonical API map when a contract changes.
Do not implement future MCP behavior as part of documentation cleanup.

## Validation and evidence

Use existing Node/Vitest, frontend browser and PowerShell fixtures. Add Python
test/tooling only when the MCP package manifest exists. Run focused checks first,
then affected aggregate contracts. Never point fixture/restore/capacity tooling
at `seha` or customer data.
Run `npm run check:unused` for the current Knip dead-code/dependency contract;
do not add exclusions merely to preserve unreachable compatibility code.

Cases to cover include native/guest private identity, multi-page person/agent
relationships, exact top-three champions, full About continuation, missing and
incomparable reports, both control providers/directions, changed/expired
receipts, partial child jobs and sent-unknown reconciliation.

Use synthetic fixtures for automated auth/provider/client tests. Real client or
provider tests use only explicitly authorized data and disposable exact targets.
SDK fixtures are not live Entra consent, real client compatibility or provider
proof. Record actual commands/outcomes and unavailable infrastructure honestly;
health/build success alone does not prove a user journey. Preserve real
deployment receipts, not superseded planning/acceptance artifacts.

## Feeds and execution

Use only `https://packagefeedproxy.microsoft.io/npm/` for npm and
`python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple ...`
for Python. Keep subprocess/container/feed settings aligned. No public fallback;
install only after a manifest change or missing-dependency failure.

Follow [repository guidance](../../AGENTS.md), preserve unrelated work, and keep
source-only verification separate from authorized live actions. Do not read or
record secrets, infer consent from credentials, automatically reset data or
introduce runtime release-acceptance gates.
