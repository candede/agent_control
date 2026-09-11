# Agent Control

Agent Control is a Microsoft 365 package administration POC using Express, React, Microsoft Graph and the Power Platform Resource Query API. One Node process serves the API and built UI; PostgreSQL owns sessions, on-demand jobs, private inventory snapshots, minimized Purview audit-search results, official Microsoft 365 usage reports and append-only administrative audit.

The binding [13-phase plan](plans/admin-poc-production/README.md) distinguishes delivered work from planned integrations. Phases 01-03 provide the local runtime, persistence, identity/capability contracts, Permissions and shared gates. Phase 04 adds explicit delegated Power Platform inventory refreshes, private normalized snapshots, exact typed identity association and the Inventory Explorer. Phase 05 adds saved package observations, explicit refresh jobs, confirmed/fenced block mutations, provider readback, read-only reconciliation and a role-separated durable canary restoration command. Phase 06 adds backend-owned ingestion of the three official Microsoft 365 admin-center usage exports. Phase 07 adds bounded, on-demand Microsoft Purview Audit Search with private minimized results and a separate local/Purview audit view. Phase 08 adds bounded Defender hunting. Phase 09 adds direct Copilot Studio quarantine status plus exact, confirmed, durable and separately qualified quarantine/restoration controls in Inventory Explorer. Phase 10 unifies these contracts under canonical `/agents`, `/power-platform`, `/users`, `/official-usage`, `/audit`, `/security`, `/permissions` and `/jobs` routes served by the same Express artifact. No live package or quarantine canary, quarantine status read, Purview lifecycle or Defender query was authorized in this unconfigured local environment, so those provider operations remain unavailable pending their separate evidence. Package access and reassignment also remain unavailable under their current lost-update/readback contracts. No transcripts, continuous collection or raw archives are implemented.

## Unified Workbench

The eight canonical views share the existing backend capability and source-read policies. Roles are additive, not hierarchical: Reader sees inventory and aggregate usage; Operator sees exact control targets; SecurityReader sees user reports and investigations; Administrator manages submitted imports without inheriting report or investigation reads.

- Agents uses server-side search, filters, stable sorting, totals and 50-row pages. URLs retain filters, page, exact selection and source-detail tabs. Power Platform retains its broader typed inventory explorer and independent native quarantine controls.
- Source details show exact identifier kinds, observation times and authorized related observations. An undocumented association stays unmatched; a name, package ID, blueprint or Defender ID never becomes a quarantine target. Official usage is authoritative only from the three companion Microsoft exports.
- Jobs shows minimized, authorized user-work status and explicit recovery. Navigation loads saved data only. Progress polling is sequential and finite; waiting-for-authorization work requires an explicit action. Uncertain writes offer GET-only reconciliation, never replay or automatic inverse operations.
- Downloads are authenticated server exports tied to an exact source selection. Inventory exports are capped at 5,000 rows, official exports at 100,000 output rows, Defender at 200 rows, and local administrative audit at 100 exact selected events. CSV generation is bounded to 8 MB (2 MB for Defender; 1 MB for local administrative audit), with a 15-second publication deadline and disconnect handling. Oversize selections fail rather than silently truncate. Current session, role and source validity are checked again before publication; stale scope, deletion or revocation stops the download.
- CSV formulas are neutralized and only approved fields leave the server. Audit records source/selection/count metadata, never exported rows. No export file, bearer link, original CSV archive, transcript viewer or maintenance console is created.

The local workbench can show truthful setup/disabled states without live provider credentials. Deterministic browser fixtures are isolated test tooling, not qualification or a production sign-in bypass. See the [Phase 10 completion](plans/admin-poc-production/completions/10-unified-admin-workbench.md) for exact tested commands and retained-environment evidence.

## Local Deployment

Host prerequisites: PowerShell 7, company-approved Docker Engine/Desktop with Compose v2 or newer, and a browser. Node, npm, Vite, PostgreSQL, tests and browser automation run **inside Docker**. No Azure subscription, Key Vault or provider credentials are needed to start the sign-in-unconfigured app.

From the repository root:

```powershell
pwsh -NoProfile -File ./deploy-local.ps1
```

Open **http://localhost:3001**. Use this canonical origin, not a second `127.0.0.1` browser origin. The script builds operator/runtime images, starts PostgreSQL, waits up to 90 seconds, runs serialized bootstrap/migrations and the full test baseline in disposable containers, then waits for healthy app/database/schema responses. Failure returns nonzero without resetting data or announcing success. Two long-running services remain: `app` and `postgres`.

- Default project: `agent-control`; volume: `agent-control_data`; network: `agent-control_default`.
- The app listens on all interfaces **inside** its container but publishes only `127.0.0.1:3001`. PostgreSQL has no published host port. The project bridge permits normal outbound DNS/HTTPS for Entra/Graph.
- Use `-Project <name>` for a separate installation and `-Port <1024-65535>` for an available host port. Keep the same project, state root and port on reruns. Paths with spaces are supported; newlines and single quotes are rejected.
- Normal redeployment preserves the volume and secrets. Before migrations it closes admissions and stops/drains the app, with a 130-second grace period. It never imports legacy data or resets storage automatically.
- `GET /api/health` returns only liveness; `/api/ready` validates database and migration checksums; `/api/auth/status` describes setup. Diagnostics require authentication. Unknown API routes and missing assets return errors, not SPA HTML.

### Sign-In Setup

Use an existing approved single-tenant Entra web application. Its default local Web reply URL is exactly `http://localhost:3001/api/auth/callback`. A different `-Port` requires a matching registered reply URL. The script does not modify app registrations or grants.

```powershell
pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control `
  -TenantId "<tenant-guid>" -ClientId "<application-guid>" `
  -ClientSecretFile "<existing-restricted-secret-file>"
```

On an initial configured setup, omitting `-ClientSecretFile` prompts securely in the terminal. Never enter a secret in AI/chat or a command argument. To configure an already unconfigured installation, supply the secret file explicitly. Missing identity configuration keeps the app healthy but disables the sign-in link and shows setup guidance. No fake identity or runtime auth bypass exists.

Initial sign-in requests only OIDC identity scopes: `openid` and `profile`. Provider permissions are requested incrementally for one capability group through authenticated, CSRF-protected consent. Package read requests least-privileged `CopilotPackages.Read.All`; package controls request delegated `CopilotPackages.ReadWrite.All` only when that separately qualified capability needs it. Power Platform inventory requests delegated `ResourceQuery.Resources.Read`; Copilot Studio quarantine separately requests delegated `CopilotStudio.AdminActions.Invoke`. Directory, Purview and Defender grants likewise stay resource- and capability-specific. Do not add broad grants to conceal an unavailable or unproven provider contract.

Import [infra/entra-app-manifest.json](infra/entra-app-manifest.json) into the approved single-tenant app registration. Its four independent roles are `AgentControl.Reader`, `AgentControl.Operator`, `AgentControl.SecurityReader` and `AgentControl.Administrator`; Administrator does not inherit the other roles. A recognized user without an assigned role receives setup diagnostics and no protected data. [docs/security-model.md](docs/security-model.md) defines the role/data matrix and [docs/deployment-setup.md](docs/deployment-setup.md) defines local and prepared-vault setup.

Authenticated users can read `GET /api/capabilities` and refresh their own capability evidence through the CSRF-protected probe route. Only Administrator can change capability configuration. Reader owns broad inventory; Operator can read exact targets needed for package controls but cannot list or batch-read the catalog. Registry requirements remain code-owned, all live provider capabilities start unavailable without credentialed evidence, and missing credentials never produce synthetic provider results. Microsoft access tokens are treated as opaque: MSAL response metadata and returned scopes/roles are authoritative, while readable JWT claims are used only to reject contradictions. The dated review is [docs/provider-contract-inventory-2026-09-08.md](docs/provider-contract-inventory-2026-09-08.md).

### Local Secrets

Default state is the ignored `.local/<project>/` directory. `-StateRoot` changes its parent; use an ignored, private directory. Directories are mode `0700` and files `0600` on Unix; Windows uses an explicit current-user ACL with inheritance removed. Keep the state directory with the retained Docker volume in your recovery inventory.

| Relative path | Format / lifetime | Mounted consumer |
| --- | --- | --- |
| `secrets/postgres-admin` | 48 random bytes, 64-character Base64; generated once | PostgreSQL bootstrap and disposable operator only |
| `secrets/postgres-app` | Independent value, same format; generated once | Bootstrap plus restricted app login |
| `secrets/session` | Independent value, same format; generated once | App session-cookie signing only |
| `secrets/client-secret` | Trimmed Entra client-secret text, or empty when unconfigured | App only |
| `settings.json` | Non-secret tenant/client IDs and port | Local script |
| `compose.env` | Non-secret paths, IDs, image names, port and UID/GID | Compose |
| `control/maintenance` | Presence closes new work admissions | App read-only mount |
| `backups/` | Native dump plus count/hash receipt | Operator only |

Secrets are file mounts, never image layers, build arguments or logged values. The runtime receives no admin password or operator code and has a read-only root filesystem, dropped capabilities and no Docker socket. It uses the host UID/GID locally to read restricted bind-mounted files.

With an existing volume, missing or corrupt DB/session secrets **stop deployment**. Restore their original bytes from the same installation's protected state backup; do not generate replacements. A valid-looking but incorrect password also fails actual authentication. Credential rotation is a coordinated operator action, not a deploy side effect. Keep project tenant and origin stable; create another project for another tenant.

## Lifecycle And Recovery

```powershell
pwsh ./deploy-local.ps1 -Action Stop
pwsh ./deploy-local.ps1 -Action Start
pwsh ./deploy-local.ps1 -Action Test
pwsh ./deploy-local.ps1 -Action Retain
pwsh ./deploy-local.ps1 -Action Backup
```

Add the same `-Project`, `-Port` and `-StateRoot` used at installation. Stop leaves storage intact; Start uses the existing image and verifies readiness, without migrations. After a failed build, the previous runtime is unchanged. After a migration/test/start failure, maintenance remains closed; fix the reported target/configuration/schema problem and rerun Deploy. Never remove the volume as a recovery shortcut. Health remains separate from provider availability.

The Backup action writes a new timestamped `.dump` and `.dump.json` under the protected project backup directory, using a PostgreSQL repeatable-read snapshot and `pg_dump` custom format. The receipt records SHA-256, schema and per-table counts/content fingerprints, not row contents. Use `-BackupFile` for an explicit new filename in an existing restricted directory. Existing files are never overwritten.

Restore always creates a **new isolated database**, never the source/default database:

```powershell
pwsh ./deploy-local.ps1 -Action Restore `
  -BackupFile ".local/agent-control/backups/<timestamp>.dump" `
  -RestoreDatabase "agentcontrol_restore_check"
```

`pg_restore` runs transactionally, followed by schema/count/content validation and explicit grants. Existing targets and changed receipts fail. A failed restore target remains isolated for review; the source is unchanged. Review retained data and run operator retention before any separately approved promotion. Phase 01 does not switch the running app to a restored database. After a successful check, remove only that exact isolated target:

```bash
docker compose --env-file .local/agent-control/compose.env -p agent-control exec -T postgres \
  psql -U agentcontrol_admin -d agentcontrol -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE agentcontrol_restore_check WITH (FORCE)'
```

Keep local dump/receipt pairs for at most **seven days** and remove expired pairs during routine operator maintenance (`-Action Retain`). Keep secret-file recovery copies under the organization's credential policy, separately protected from data dumps. Database retention removes expired sessions, capability evidence and package mutation qualification records, seven-day jobs/items/attempts, expired package snapshots/refresh jobs, 30-day Purview jobs/results, audit older than 90 days, old import receipts and unused source identifiers. Expired capability or qualification evidence stops authorizing immediately. Run Retain at least daily while actively using this POC; it never calls providers. Backups have a finite lifetime, not an instant deletion guarantee.

Destructive reset is a separate, explicit action, never a deploy step:

```powershell
pwsh ./deploy-local.ps1 -Action Reset -Project agent-control `
  -ConfirmReset "agent-control/agent-control_data"
```

This removes that project's containers, volume and local state including its backups. Back up anything needed outside that directory first. The exact case-sensitive project/volume confirmation is mandatory.

## Persistence And Jobs

PostgreSQL **17** is pinned in Compose. The fixed database is `agentcontrol`, operator login `agentcontrol_admin`, runtime login `agentcontrol_app`. Structural driver settings use `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD_FILE` (or injected `PGPASSWORD`); remote connections require TLS verification, while the private local container connection uses disabled SSL. Passwords are not concatenated into connection URLs. The app pool caps at four connections, 5-second connect and 15-second statement timeouts, with UTC timestamps.

[backend/scripts/database.ts](backend/scripts/database.ts) owns bootstrap, explicit checksum-verified migrations and grants. [backend/src/db/schema.ts](backend/src/db/schema.ts) defines schema versions 1 through 22. Migrations 5-6 own private Power Platform inventory; migrations 7-12 own package observations, mutation confirmation/readback/reconciliation, and finite canary qualification; migrations 13-15 own official usage staging, immutable publication, selection and exact retry receipts. Migrations 16-17 own Purview qualification, durable minimized results, scoped execution fencing and request budgets. Migrations 18-21 own Defender hunting, qualification and retained scopes. Migration 22 owns Copilot Studio quarantine observations, durable jobs/items/attempts, append-only audit, separate canary approvals and finite qualification. Advisory transaction locks serialize migration attempts. Unknown/newer or modified applied migrations fail; upgrades are forward-only and an individual failed migration rolls back. Never edit an applied migration; add a new version. Bootstrap uses ordinary operator role/schema privileges, not a required cloud superuser. The app cannot create schema, own its objects, elevate roles or change/delete/truncate audit events, published inventory snapshots or accepted official usage content. Library auto-DDL is disabled.

All available single, selected bulk and block-all mutation routes require a current server-issued preview with `risk: true`, a confirmation hash, and a durable `Idempotency-Key`, then return **202 durable jobs**. The preview includes operation, exact targets and current/requested state, Microsoft Graph endpoint/maturity, delegated permission, actor, affected principal count and rollback limits. Same-key/same-confirmation retries return the original job even after saved package state changes; another payload returns 409. Access and reassignment routes fail closed before dispatch. Job states are `queued`, `running`, `waiting_authorization`, `succeeded`, `failed`, `cancelled` and `partial`, with no `completed` alias. Items also distinguish `skipped` and `inconclusive`.

- At most two in-process workers, five unfinished jobs per principal and 5,000 items per job. No recurring provider refresh or startup collection.
- Database-time leases last 120 seconds with owner/version fences; up to ten claims, a 30-minute dispatch deadline and seven-day retention. Stale workers cannot commit outcomes or dispatch another item.
- Intent/attempt audit is persisted before remote dispatch. A per-tenant/package advisory lock serializes local operations; under that lock the worker rereads the exact target and compares the frozen mutation-state hash. It then rechecks role/capability and reacquires the exact delegated tenant/account/resource authorization. Writes dispatch once and are never automatically retried. Successful outcomes require bounded provider readback; uncertain accepted writes remain `inconclusive`. `POST /api/agents/bulk-jobs/:id/reconcile` uses current `AgentControl.Operator` plus delegated `CopilotPackages.Read.All`, revalidates around each result, honors cancellation, performs provider reads only and never requires a still-qualified write capability.
- Restart cannot recover MSAL tokens. Unsent delegated work waits for current authentication and explicit resume; completed/uncertain items never replay. Cancel stops unsent items, not an already accepted remote operation.
- Poll `GET /api/agents/bulk-jobs/:id`; cancel with `POST .../:id/cancel`; resume unsent work with `POST .../:id/resume` and `{ "confirmed": true }`; reconcile inconclusive items with `POST .../:id/reconcile`. Tenant/principal filtering applies before job, session and audit access.
- Sessions expire after eight hours, IDs regenerate at login, and only allowlisted account/user state plus a random authentication-transaction handle is serialized. OAuth state, nonce, PKCE verifier, tokens, and MSAL cache blobs never enter PostgreSQL. One-time process-local authentication transactions expire after ten minutes.
- Administrative audit appends confirmed request, attempt start and outcome/reconciliation rows and reads a projection. Unknown legacy tenant attribution is not exposed by scoped app routes.

Requests cap JSON at 512 KiB; package pages cap at 100/5,000 total rows and 2 MB per response; provider calls time out at ten seconds. Read retries cap at three with delays capped at 30 seconds; mutations never retry. Directory search returns at most 50 principals, resolves at most 500 native Entra UUIDs with concurrency eight, rejects duplicate/deleted/unresolved identities and rejects a Graph response whose ID differs from the exact requested ID. Unknown package fields are omitted with value-free schema diagnostics. Package responses are not archived; Power Platform snapshots contain only their validated allowlisted projection.

Package list/detail reads use Graph v1.0 and save only allowlisted complete observations for seven days; failed or partial refreshes never replace the last complete broad snapshot. Navigation reads saved data only. **Refresh agents** explicitly submits and polls a delegated refresh job before reloading saved rows. A provider-verified block mutation updates only its touched state in the current UI; publishing a new persisted observation still requires that explicit refresh. Preview block/unblock use Graph beta and delegated `CopilotPackages.ReadWrite.All`; application permission is not supported. Microsoft documents global cloud and a Microsoft Agent 365 license, but no additional human Entra administrator role. Local serialization and immediate prestate hashing bound this application's block races but are not provider atomicity. Access replacement remains disabled even after generic qualification because Graph documents no ETag/`If-Match` or equivalent lost-update bound. Reassign remains visibly disabled because package detail exposes no owner field for readback and the operation exposes no conditional-write header. [docs/mutation-canaries.md](docs/mutation-canaries.md) defines the durable role-separated restoration command; no current record exists until an approved live canary is restored and verified.

Power Platform inventory uses delegated `ResourceQuery.Resources.Read` against the global `api.powerplatform.com` Resource Query endpoint. Each explicit refresh uses code-owned structured clauses, `Top=100`, continuation tokens, a 50-page/5,000-row ceiling, 10-second requests, three read attempts, a 10-second retry ceiling and 2 MB response limit. Results are allowlisted and publish only after complete enumeration; raw provider responses, connection/sharing secrets and tokens are discarded. Failed or interrupted work preserves the prior snapshot. Restart converts running jobs to `waiting_authorization` without calling a provider; only an explicit current-user resume can reacquire authorization.

Inventory snapshots are tenant/principal-private. Reader can query, filter, sort, page, inspect and export saved rows even when provider evidence is unavailable. Full inventory roles are Global Administrator, Power Platform Administrator, Dynamics 365 Administrator and Global Reader. AI Administrator/Reader coverage excludes ordinary canvas/model-driven apps and cloud flows as `not_authorized_scope`, never zero. Unknown role evidence remains unknown. Snapshot resources expire after 30 days and refresh jobs after seven days through operator retention. The app supports global cloud only; sovereign-cloud endpoint/support differences are reported as unsupported configuration rather than guessed.

Inventory admits at most four active refreshes globally and five unfinished requests per principal. Queries have a 30-second overall deadline, active execution a 45-second bound, and unsent requests a 30-minute dispatch window. Saved scope selection and recent job discovery survive navigation/restart without submitting a scan. Explicit resume revalidates the current principal; logout cancels inventory work without waiting under the account-session lock. Publication rechecks authorization, refuses stale/superseded work, and preserves broad scopes when a narrow scope completes. Source freshness remains readable after its refresh job expires.

Exact identifier outcomes are computed server-side from the complete selected private snapshot before paging. Resource type, identifier kind, tenant and required environment remain distinct; ambiguous candidate details are bounded to 20 identities with their total retained. Relationships never merge resources or redirect native mutation targets. The current package and Power Platform schemas document no cross-source package identifier relationship, so package associations remain explicitly unresolved. CSV exports apply the same Reader/private scope and neutralize spreadsheet formula prefixes.

## Copilot Studio Quarantine

Quarantine is delegated-only and global-cloud-only. It uses Power Platform audience `8578e004-a5c6-46e7-913e-12f58912df43`, scope `CopilotStudio.AdminActions.Invoke`, internal role `AgentControl.Operator`, and one current provider role: Global Administrator, AI Administrator or Power Platform Administrator. Built-in Power Platform RBAC, Environment Maker, Reader, application credentials, package IDs and display names are not substitutes. Classic/V1 bots remain unsupported.

The implemented endpoint contract is `GET .../copilotstudio/environments/{EnvironmentId}/bots/{BotId}/api/botQuarantine?api-version=1`, with one-shot POSTs to `SetAsQuarantined` or `SetAsUnquarantined` using the same `api-version=1`. Microsoft documentation rechecked on 2026-09-10 is inconsistent: the Copilot Studio quarantine guide specifies `1`, while all three generated REST request examples specify `2024-10-01`. Agent Control follows the Phase 09 contract and guide with version `1`; it never retries against another version. An approved exact-target live probe must qualify that version before any live canary. Resource Query inventory separately remains `api-version=2024-10-01`.

Controls accept only a current principal-private `microsoft.copilotstudio/agents` snapshot and its exact native resource, environment and CDS bot IDs. Inventory older than 24 hours, expired/removed/ambiguous targets and absent IDs disable status and mutations. An explicit status read retains `isBotQuarantined`, exact `lastUpdateTimeUtc`, observation time and correlation for 30 days with a 60-second cache. It stays visibly separate from lagging inventory state; unknown/unavailable never becomes `false`, and direct state never rewrites the inventory snapshot.

Single and bulk operations are bounded to 25 targets. Preview freezes direct prestate/timestamp, exact targets, actor, capability revisions and requested state. A normal submit requires current independently approved quarantine and restoration canary evidence. Workers serialize each provider target, perform two current pre-reads, mark the one permitted POST sent durably, and require bounded GET convergence before success. Accepted, timed-out or interrupted sent work becomes `inconclusive`; reconciliation performs GET only and never replays or automatically inverts a partial bulk result. Startup moves unclaimed/unsent work to `waiting_authorization` without a provider call; explicit resume reacquires current delegated authorization. SecurityReader can review only current-principal quarantine audit events; Administrator does not inherit that role.

Makers may still see and test a quarantined bot in Copilot Studio while users cannot use it through connected channels. Graph package blocking is an independent control with independent state and qualification. [docs/mutation-canaries.md](docs/mutation-canaries.md) defines the separate quarantine canary procedure. The current local installation reports `authConfigured: false`; no exact live target or canary approval was available, so live read/write evidence is `unavailable`, not passed from fixtures.

## Purview Audit Search

Purview Audit Search is an explicit SecurityReader workflow, not a scheduler or navigation-triggered collection. It uses Microsoft Graph v1.0 `auditLogQuery` with `AuditLogsQuery.Read.All`, code-owned Copilot interaction and Copilot Studio administration presets, required caller-selected subsets of each preset's allowlisted operations, a seven-day maximum requested window, and bounded polling/paging. The adapter stores typed allowlisted metadata and message IDs only. Prompt/response text, transcripts, raw `auditData` and provider response archives are prohibited.

Microsoft's current create/list/records references and query resource remain inconsistent over `serviceFilter`/`serviceFilters`; single-query GET also lists an unrelated permission. Agent Control selects singular `serviceFilter`, direct create/get query objects and collection list envelopes, with no runtime fallback. Both delegated and application modes remain disabled until one separately approved complete lifecycle proves the exact contract. Routine Permission Center refresh creates zero queries.

Submission returns a durable job promptly. Each physical Graph attempt reserves one of 64 durable request slots immediately before dispatch; each job has at most 12 explicit activations, each activation has a 60-second bound and at most six polls, and each logical Graph request has a 30-second retry budget with 2 MB per response. Interrupted work returns to `waiting_authorization` without provider calls. Explicit resume reconciles an ambiguous create marker or polls a saved provider ID; it does not replay create or completed work. Cancel and delete are local-only and do not claim remote cancellation/deletion. Delegated results stay private to their principal; application results are readable only through the current configured shared scope. Minimized results expire after 30 days and remain separate from local administrative audit and official usage. [docs/purview-audit-search.md](docs/purview-audit-search.md) defines the selected contract, authorization, caps, privacy, recovery and retention.

## Legacy Audit Import

[backend/scripts/import-legacy-audit.ts](backend/scripts/import-legacy-audit.ts) is an **operator-only** SQLite reader, excluded from the runtime image and ZIP. Never point it at a live SQLite/WAL file. Obtain a SQLite online-backup/safely closed standalone backup and its independently recorded SHA-256, then mount it read-only into an operator container. Phase 12 owns actual production backup/import execution; this phase tests fixtures only.

```bash
docker run --rm --network agent-control_default \
  --mount "type=bind,source=$PWD/.local/agent-control/secrets,target=/run/secrets,readonly" \
  --mount "type=bind,source=<absolute-protected-backup-directory>,target=/legacy,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol \
  -e PGPASSWORD_FILE=/run/secrets/postgres-admin \
  agent-control-operator:local backend/scripts/import-legacy-audit.ts \
  /legacy/audit-backup.sqlite <expected-sha256>
```

The importer validates the known schema, a 64 MiB/100,000-row limit, integrity and allowlisted audit fields. It assigns deterministic source IDs and atomically verifies exact row count/content hashes plus a checksum-keyed receipt. Same-backup retries are idempotent; changed, malformed or unapproved fields stop the entire import for operator review. Never edit the source backup to make a check pass. Unknown tenant remains unknown and restricted. Old in-memory jobs/sessions were never in SQLite: require login and manually reconcile legacy writes without replay.

## Official Usage Reports

The only official per-agent and per-user usage authority is the Microsoft 365 admin-center **Copilot Agents usage** report. Microsoft currently documents 7- and 30-day report windows and says usage can appear within one hour of interaction; treat that as source latency, not a guarantee that an operator has imported the latest export. Microsoft Graph `copilotReportRoot` has three current `v1.0`/`beta` methods for licensed Microsoft 365 Copilot app user counts, trends and user activity, but none returns the equivalent per-agent Agents, Users & agents and Users datasets. Import therefore remains a manual operator workflow. Audit, Defender, telemetry, transcripts and package events are never substituted or relabelled as official usage.

1. In the Microsoft 365 admin center, open **Reports** (use **Show all** if Reports is hidden), then **Usage**. Under **Reports**, select **Microsoft Copilot > Agents**.
2. Select the same documented 7- or 30-day period for the complete bundle. Select each **Agents**, **Users & agents**, and **Users** table/tab and use its **Export CSV** action. Keep the original CSV files until the import is accepted.
3. In Agent Control, sign in with `AgentControl.Administrator`, open **Official usage**, enter the source reporting start/end dates in the role-gated import panel, and optionally enter the source as-of timestamp only when the Microsoft report shows it.
4. Choose all three CSVs, review the server-produced kind, hashes, schemas, row counts, period, source basis, warnings, reconciliation and complete bundle hash, then accept the reviewed bundle. All three kinds publish in one revision-fenced transaction. Missing companion files remain resumable actor-owned staging or an incomplete retained set and never replace active data.

The parser accepts only the current Microsoft-documented and fixture-observed headers listed in [the official usage import runbook](docs/official-usage-import.md), validates UTF-8/content/row/field/byte bounds, and rejects unknown required-column changes as schema drift. Filenames, MIME types and extensions are not reporting-period authority. The supported CSVs contain no report-period or source-as-of metadata columns, so supplied period/as-of values are always labelled `operator_asserted` and source freshness remains `unknown`. Companion source basis must match exactly; download timestamps are recorded independently and are not used to guess compatibility.

Accepted rows are immutable. Exact three-file retries return the original finite content-free bundle receipt even after staging cleanup or an active-pointer change; they do not reselect, replay or create another version. Changed hashes/revisions fail. A correction requires explicit acknowledgement, creates a superseding immutable set, and becomes active only when all three compatible kinds are accepted atomically. An administrator can preview and confirm selection of another retained complete set or deletion. Deleting the active set clears selection without falling back to an older set. Original upload bytes are never archived.

`AgentControl.Reader` can read/export aggregate official usage. `AgentControl.SecurityReader` can read/export user-level official usage. `AgentControl.Administrator` can stage, review, accept, select and delete operational report sets but does not inherit either content-read role. Report agent IDs remain report-only and unresolved unless an exact documented cross-source identifier contract exists; names and creator strings are never identity keys. Pseudonymous usernames remain case-distinct and explicitly scoped to their report set and Users/Users & agents versions. Licensed and unlicensed active-user categories are not additive even within one agent because license changes can place one person in both categories; their sum is never presented as a distinct-user total. Exact distinct totals use the case-sensitive Users plus Users & agents dataset identity union, while each source's response total remains independent. In Users & agents, last activity is the date the agent was last used by anyone, not that user's last interaction. User recency comes only from Users and is unknown when that row is absent. Source disagreements remain visible instead of being corrected or hidden.

Staging rows expire after 30 minutes and startup plus periodic runtime cleanup removes abandoned preview rows; accepted content, artifacts, versions, sets and bundle receipts expire independently after 180 days; minimal report audit metadata expires after 90 days. Upload parsing and processing have an active 15-second wall-clock timeout, and disconnected work keeps its admission slot until parsing/database work has settled. Admission caps are 8 MiB and 50,000 rows per file, two concurrent uploads per process, nine retained staging rows/150,000 rows/96 MiB per actor, and 30 rows/500,000 rows/256 MiB per tenant. Run `pwsh ./deploy-local.ps1 -Action Retain -Project <project>` during ordinary maintenance. `OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to `35`, accepts 1 through 365, and marks a selected set stale when either report-period age or accepted-set age exceeds the threshold. `never imported`, `incomplete`, `active`, `stale`, `not selected` and `deleted` remain distinct and never trigger another source fallback.

The legacy browser key `agent-control:usage-reports:v1` is detected by key enumeration only. Its value is never read, parsed or uploaded. Every affected authenticated browser receives a content-free notice regardless of app role; only Administrator receives cleanup controls. The key survives sign-out, unmount and failed import. It is removed only after server-acknowledged successful original-file re-import confirmation or explicit discard acknowledgement; unrelated local-storage keys remain untouched. Storage at an older origin such as `http://localhost:5173` cannot be detected from `http://localhost:3001` and must be handled explicitly at that origin.

Operator workflow: [docs/official-usage-import.md](docs/official-usage-import.md). Microsoft source: [Microsoft 365 Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide).

## Permissions And Saved Data

Every signed-in account can open **Permissions**, including an account awaiting internal role assignment. Registered adapters include package delegated/application reads, package block qualification, the fixture-tested but operation-disabled access adapter, directory lookup, delegated Power Platform inventory, delegated Copilot Studio quarantine behind separate full-cycle qualification, delegated/application Purview Audit Search behind live qualification, Defender hunting and local official report import. Later provider adapters appear when their owning phase registers them; contract definitions alone do not advertise working integrations.

Permission rows consume the backend's exact resource audience, token mode, permissions, Microsoft/internal roles, licenses, cloud, configuration, source links, safe evidence, freshness and separate write qualification. **Request consent** starts one capability group's Entra flow, and **Retry probe** requests a current-account bounded read explicitly. Neither action assigns a role or license; a read probe never qualifies a write. Cancellation and interaction/Conditional Access outcomes return safe messages to the app without reflecting provider descriptions.

The health control opens Permissions and summarizes available, degraded and blocked adapters. Expiry updates the UI locally without polling a provider. Provider actions fail closed on unavailable or expired evidence, while role-authorized saved package observations, saved Power Platform snapshots, saved reports and local audit remain accessible. **Refresh agents** creates and polls a durable package refresh; **Refresh inventory** creates a Power Platform refresh. Navigation performs no provider scan. Package details show saved observation time/expiry, source, v1.0-read/preview-control maturity, availability, deployment and assignments. Package block is explicitly distinct from Copilot Studio quarantine. Access and reassign actions remain visible but disabled with their exact lost-update/readback limitations and the reassign documentation link. The principal-scoped **Jobs** view exposes only role-authorized imports, refreshes, searches and controls, with explicit reauthentication, unsent cancellation/resume and read-only uncertain-write reconciliation. Inventory CSV uses server-side private filtering and details distinguish null/not-supplied, preview provenance, capability truncation and exact association outcomes. Administrator sees the import panel within **Official usage** without gaining aggregate, user-report or investigation data. Report storage, expiry and logout behavior are unchanged.

Defender hunting has two separate finite authorizations. An exact successful query-version-3 qualification is valid for 24 hours and is required before every new provider send. The same Administrator plus SecurityReader approval creates an exact 30-day retained-scope authorization, which lets a current SecurityReader read only the bound saved history, counts, rows and CSV while the provider is unavailable or the 24-hour proof has expired. Revoking that exact retained scope hides the bound saved data immediately without deleting it. Delegated data remains principal-private; application-mode data may be shared only under the exact current enabled application scope and configuration revision. This local authorization cannot discover an external Defender RBAC/data-source revocation while offline, so it must not be represented as proof of current provider visibility. See [docs/defender-agent365-hunting.md](docs/defender-agent365-hunting.md) for the source/projection allowlists, dynamic-detail limitations, 15-minute job deadline and `rootSpanObserved` boundary.

## Container Validation

`-Action Test` builds the operator, creates a separately named `agentcontrol_test_*` PostgreSQL database, runs the following baseline and drops only guarded fixture databases. It never uses rollback-only isolation against demo data:

```text
npm run test --workspace backend
npm run test --workspace frontend
npm run typecheck --workspace backend
npm run lint --workspace frontend
npm run build
```

These commands are invoked inside Docker by [backend/scripts/test-all.ts](backend/scripts/test-all.ts). For a focused check, build `docker build --target operator -t agent-control-operator:local .`, use the same secret/network mounts as the importer, point `PGDATABASE` at a separately created `agentcontrol_test_*` control database, and override the entrypoint with `--entrypoint npm` followed by `run test --workspace backend -- <test-path>`. Remove that exact fixture database afterward, never `agentcontrol`. The `test` target also supports non-database frontend/type checks with `docker run --rm <test-image> npm run ...`.

```bash
pwsh -NoProfile -File scripts/local-deployment.tests.ps1
pwsh -NoProfile -File scripts/restart-runtime.tests.ps1 -Project agent-control
pwsh -NoProfile -File scripts/persistence.tests.ps1 -Project agent-control
docker run --rm --network agent-control_default agent-control-operator:local \
  backend/scripts/package-smoke.ts http://app:3001
docker build --target browser-test -t agent-control-browser .
docker run --rm --network agent-control_default \
  --mount "type=bind,source=$PWD/artifacts,target=/evidence" agent-control-browser
git diff --check
```

The restart harness uses guarded synthetic databases on the same project volume, the actual runtime image and a test-only bind-mounted provider fixture; it removes fixture containers/databases. It never installs an auth bypass. The minimal disposable Playwright stage checks the unconfigured built app at desktop/mobile sizes and writes screenshots under ignored `artifacts/` (create that directory first). Its bridge origin is `http://app:3001`, corresponding to canonical host `http://localhost:3001`. No host Node/browser automation is required; VS Code may report missing host Vite types until attached to a container, and container type checks are authoritative.

### Permission Center Qualification

Reuse the retained local project, without resetting its volume or rotating secrets:

```powershell
pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01
pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01
```

The second command builds the `permission-browser-test` target and runs [backend/scripts/browser-fixture.browser.ts](backend/scripts/browser-fixture.browser.ts) through its dedicated Vitest configuration. A disposable container contains the **built** React app, real Express API/routes/policy/capability repository, isolated PostgreSQL session/evidence data, Chromium and axe. PostgreSQL is reached as `postgres` over `agent-control-phase01_default`. App and browser share **http://localhost:3001 inside that container**, with no published fixture port and no access to the demo app's browser origin/storage. The retained demo remains at **http://localhost:3001 on the host**.

The script creates one random `agentcontrol_test_*` control database; the test helper creates and migrates a second random fixture database, using the existing restricted app password without changing it. Auth and provider HTTP behavior are deterministic test-only mocks, with outbound browser/provider requests blocked. There are no live provider grants, writes or credentials. The fixture requires `NODE_ENV=test` and `AGENT_CONTROL_FIXTURE_MODE=browser`; ordinary runtime configuration rejects that marker in every environment. The fixture entry point, mocks, browsers and dev dependencies are excluded from production artifacts.

[frontend/browser/permissions.spec.ts](frontend/browser/permissions.spec.ts) exercises every status, exact requirement text, role separation, current-principal evidence, explicit refresh, consent cancellation, stale saved data, direct denied API writes, loading, errors, keyboard focus and mobile overflow. Axe runs WCAG A/AA checks including rendered contrast at **1440x1000** and **360x780**. Synthetic-only viewport/row screenshots and the JSON report are written under `artifacts/phase03/`. No traces containing auth transactions are retained.

Exact focused component/DOM-axe command, after the operator image is built:

```bash
docker run --rm --entrypoint npm agent-control-phase01-operator:local \
  run test --workspace frontend -- src/components/PermissionCenter.test.tsx \
  src/capabilityState.test.ts src/useCapabilities.test.tsx src/authorization.test.ts
```

[frontend/vitest.config.ts](frontend/vitest.config.ts) runs React Testing Library in jsdom, with API-client HTTP fixtures. DOM axe disables only contrast, which Chromium checks. Native details/dialog keyboard behavior is qualified in Chromium, not simulated by jsdom. These tests are also part of the aggregate frontend suite. Run the normal aggregate with `pwsh ./deploy-local.ps1 -Action Test -Project agent-control-phase01`.

Normal success or assertion failure closes the fixture server/session store, drops its fixture database, removes the disposable container (`--rm`), and drops the control database in PowerShell `finally`. Only the two normal Compose services remain. On hard host/container interruption, use the printed `isolated_browser_fixture` database name and the exact control name from that run to inspect and remove those guarded targets only; never bulk-delete databases, volumes, or project secrets. Reruns use new database/container names.

## Package Feed And Export

Dependency, test, operator and browser build stages select the approved **`https://packagefeedproxy.microsoft.io/npm/`** registry automatically. Runtime receives no registry credentials. Stock Node maintenance containers must pass that setting explicitly:

```bash
docker run --rm -e NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
  --mount "type=bind,source=$PWD,target=/app" -w /app node:24-bookworm-slim \
  npm install --package-lock-only --ignore-scripts
```

When feed authentication is required, use company onboarding and the optional BuildKit `--secret "id=npmrc,src=$HOME/.npmrc"` supported by install/prune stages. Never put credentials in build arguments or disable TLS/Defender. This is npm registry configuration for this project, not a Docker-wide network policy or a redirect for image/OS downloads.

```bash
docker build --platform linux/amd64 --target export --output type=local,dest=artifacts .
docker run --rm --network agent-control_default \
  --mount "type=bind,source=$PWD/artifacts,target=/evidence,readonly" \
  agent-control-operator:local backend/scripts/package-smoke.ts \
  http://app:3001 /evidence/agent-control-linux-x64.zip
```

[Dockerfile](Dockerfile) uses Node 24, compiles both workspaces, and exports `artifacts/agent-control-linux-x64.zip` from the same release tree. Linux/x64 checks reject an ARM-target export. The ZIP starts with `npm start` (one `node backend/dist/server.js` process), includes production dependencies and built assets, and excludes tests, operator scripts, SQLite data and local credentials. API/auth routing precedes static fallback; immutable hashed assets and no-store HTML have separate caching.

## Production Boundary

Production has one code path: [deploy-azure.ps1](deploy-azure.ps1), the [approved-target contract](infra/production-target.example.json), and [Bicep](infra/main.bicep). It deploys the same tested Linux/x64 ZIP to one Linux B1 App Service and one PostgreSQL 17 Flexible Server (`Standard_B1ms`, 32 GiB, seven-day backups), using five versioned runtime references from an existing prepared vault. The administrator database secret remains bootstrap-only. Resource deployment starts in maintenance and is stopped before bootstrap; opening follows contained smoke and human authentication evidence. Monitoring exports only redacted application console events plus aggregate metrics, never raw HTTP/IP/URL or PostgreSQL query/session logs; backup health requires an exact receipt-bound restore-point probe rather than the backup-storage cost metric. The script requires an exact target, dated itemized estimate, budget/change/maintenance approval and explicit Burstable POC risk acceptance; examples and mock receipts are not approval or cloud evidence. See [Azure deployment](docs/azure-production-deployment.md) and [disaster recovery](infra/disaster-recovery.md). The removed `deploy-production.ps1`/Static Web Apps path has no compatibility wrapper. No local-only Phase 12 work accessed Azure.