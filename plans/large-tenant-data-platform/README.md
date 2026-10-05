# Large-tenant data platform: forward-only execution campaign

## Outcome and authority

Execute this campaign to completion, not merely to a readiness report. PostgreSQL remains the sole application-data authority. Replace tenant-sized payloads and application/browser materialization with versioned records, indexed relational facts, bounded ingestion, atomic publication, SQL queries, generation-pinned pages, and streamed exports. Preserve business meaning and existing user capabilities at tens of thousands of users and more agents.

Repository root: `/Users/candede/repos/agent365/agent_control`. This is **one repository**, with implicated roots `backend/`, `frontend/`, `scripts/`, `docs/`, and root deployment/build configuration. A prompt's directory is not an implementation boundary. Read current root `AGENTS.md` and `.npmrc`: all dependency access, including subprocesses/containers, must use the approved package-feed proxy; npm registry is `https://packagefeedproxy.microsoft.io/npm/`. Preserve that configuration and aligned Docker registry settings; never probe/fall back to public registries. Install only for a dependency change or a missing-tool failure.

The parent executes the following exact manifest sequentially with one fresh **GPT-6 Astra, `xhigh`** worker per phase, overriding the implementation skill's default model. Read the implement-folder step-worker contract, this README, all earlier completion records, and parent campaign state. Preserve dirty changes. No commits, pushes, branches, unrelated rewrites, or nested implementation delegation. The parent owns integration and any material deviation from this binding contract.

**Launch boundary:** all three parent reviews are complete; apply their accepted repairs, reconcile this revised nine-phase manifest and complete the parent's final fresh adversarial review before launching 01. Plan repair itself launches no workers.

## Binding question-handling contract for every worker

If a necessary user question is asked, **stop and wait for the user's actual answer**. Do not continue under an assumption, interpret autopilot or an unavailable-question-tool result as consent, or substitute a default. Complete independent work before asking where practical; once the question is asked, remain paused until answered. The production target below is already explicitly confirmed: do not manufacture a new ambiguity or ask the same question again unless physical target verification exposes a real mismatch.

## Binding tooling contract for every worker

This is a **company-protected machine**. **NEVER contact default/public npm or PyPI registries**: Microsoft Defender blocks them. This restriction applies to every worker, command, install/restore, `npx`/package-manager subprocess, container build/runtime, fixture and CI path; no probe or fallback exception.

- All npm registry access must use **`https://packagefeedproxy.microsoft.io/npm/`**, through approved repository configuration or explicit `NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/`. The parent confirms root `AGENTS.md`, `.npmrc` and the user's npm registry configuration now persist the approved feeds. Preserve them; do not unnecessarily rewrite machine configuration. `Dockerfile` already has the approved `ENV NPM_CONFIG_REGISTRY`; do not remove/override it with a default registry.
- Python installation, only if necessary, must use **`python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`**. No public extra index or fallback; clear/reject inherited public `PIP_EXTRA_INDEX_URL` or conflicting installer configuration before any install.
- Check effective configuration locally before registry access. Environment scrubbing in isolated runners must retain or explicitly reinject the approved npm registry for children; Docker's parent environment alone is not proof a sanitized subprocess inherits it. Check direct package URLs/lockfile resolution and install hooks for bypasses; refuse a command that would contact a prohibited registry.
- Do not install packages unnecessarily. Use existing dependencies and standard-library tools; install/restore only after a dependency-manifest change or a genuine missing-package/tool failure. Do not let `npx` implicitly download a missing tool. If the approved feed is unavailable, report the exact limitation and continue independent work without switching registries.

Each phase repeats this tooling contract so a fresh worker cannot miss it. Package-feed failure does not grant production-target authorization or permission to weaken the 5/5 deployment gate.

## Exact ordered manifest

| Step | Executable prompt | Authority transition | Required completion record |
| --- | --- | --- | --- |
| 01 | [Record foundation and isolated qualification](01-record-foundation.md) | Introduce dormant records, fences, selections, and export primitives | `completions/01-record-foundation.md` |
| 02 | [Dormant user-source ingestion, licensing SQL and people](02-users-and-reports-cutover.md) | Implement user-source ingestion, directory licensing SQL and targeted people; no live writer/wire change | `completions/02-user-sources-foundation.md` |
| 02A | [Dormant official reports and combined projections](02A-official-reports-foundation.md) | Implement report import/history, combined SQL, targeted agent usage and export producers; freeze combined contracts/proofs | `completions/02A-official-reports-foundation.md` |
| 02B | [Users and official reports atomic cutover](02B-users-and-reports-cutover.md) | Activate both foundations, all API/UI/export consumers and predecessor deletion together | `completions/02B-users-and-reports-cutover.md` |
| 03 | [Inventory ingestion and reconciliation foundation](03-inventory-foundation.md) | Introduce dormant staged inventory/reconciliation implementation | `completions/03-inventory-foundation.md` |
| 04 | [Inventory and agent experience atomic cutover](04-inventory-cutover.md) | Activate inventory, canonical identities, query APIs, and consumers together | `completions/04-inventory-cutover.md` |
| 05 | [Lifecycle and bounded-work closure](05-lifecycle-and-bounded-work.md) | Complete retention, invalidation, streaming, and recovery across domains | `completions/05-lifecycle-and-bounded-work.md` |
| 06 | [Fixed-budget capacity qualification](06-capacity-qualification.md) | Prove resource bounds; repair bottlenecks without changing semantics | `completions/06-capacity-qualification.md` |
| 07 | [Retained production deployment and observation](07-production-convergence.md) | Qualify fresh disposable installation; reverify and deploy explicitly authorized `seha`; sole production reset owner | `completions/07-production-convergence.md` |

Only those nine files are executable prompts, in dependency order **01 -> 02 -> 02A -> 02B -> 03 -> 04 -> 05 -> 06 -> 07**. The 02 prompt retains its historical filename; its title/contract and completion record identify the user-source foundation. Completion records are created by workers, not fabricated during authoring. No phase deploys independently; the complete cross-root revision deploys in 07. Dormant 01/02/02A/03 code has no production route registration, scheduler, writer, feature switch or shadow publication. Shared types remain additive/dormant and existing users/report runtime remains sole authority through 02A. Before 02B, require frozen bounded response/query/export contracts, complete executable combined semantic fixtures and recorded verification attempts/results from 02A. Repair missing prerequisite implementation and reproducible semantic defects before opening affected behavior; environmental evidence gaps retain truthful containment under Always-Deploy, not a new blanket veto. 02B activates 01/02/02A and deletes their predecessor runtime; 04 does the same for 03. No deployed half-contract or compatibility window.

## Non-negotiable boundaries

- A fresh **application database for Compose project `seha`, exposing localhost:3002, is explicitly authorized**. Preserve its tenant/domain/client/sign-in configuration, `tenants.json`, client secrets, database passwords, session secret, backups, saved port/public URL/origin/callback/proxy settings, and project identity. No Entra or other external-provider reset, mutation, onboarding, app-registration replacement, consent change, or credential regeneration is authorized.
- No backward compatibility, aliases for retired APIs/fields, dual reads/writes, shadow authority, old-format reader, existing-app-data converter, or restore-old-data rollback. Provider re-fetch and new CSV imports are new observations, not migration.
- Only 07 may reset the production application DB, using the checked-in `pwsh ./deploy-local.ps1 start -Project seha -DbReset` path after rechecking the authorized identity below and passing deployment safeguards. **Never** use internal `Invoke-LocalDeployment ... Reset`: it deletes project state/secrets and the volume. Never run a production `down --volumes`.
- The production target is now concretely **`seha` on localhost:3002**, not an unresolved placeholder. Reverify Compose project/service labels, port binding, `seha_data` volume mount and `.local/seha` state before reset; resolve the actual network from verified metadata. Do not inspect secret contents or infer a substitute if anything mismatches. Record the identity receipt and preserve the existing public URL, which must not be guessed from the loopback address.
- Keep authentication, authorization, CSRF, admission, audited mutation qualification, maintenance, startup/schema checks, and deploy software qualification intact. Fresh application data does not authorize unsafe provider writes or synthetic facts in real provider inventories.
- Preserve unrelated historical migration infrastructure. `db/schema.ts` has checksum-verified migrations; `scripts/database.ts` owns bootstrap/grants/preflight. Append immutable forward DDL and update final-schema verification/grants. Cutover DDL may remove obsolete empty tables and must reject populated replaced stores with `fresh_application_database_required`, not copy/convert their data. A fresh initialization can run historical DDL then forward removals. Keeping those migrations, audit import infrastructure, and unrelated tables is not an old-format runtime reader. Do not rewrite applied checksums or delete the migration framework.

## Confirmed production authorization and separate duplicate cleanup

Parent preflight on 2026-09-28 established a clean pre-campaign baseline at HEAD `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`. The user's subsequent explicit answer resolves the earlier two-installation ambiguity:

| Project | Verified earlier loopback address | Current explicit authorization |
| --- | --- | --- |
| `seha` | `http://localhost:3002` | Correct production; 07 may reset only its application DB through the checked-in deployment script after exact revalidation |
| `agent-control-phase01` | `http://localhost:3001` before removal | Duplicate application containers/network already removed by the parent; recovery data/configuration/backups retained |

Confirmed production identity: Compose project **`seha`**, app **`seha-app-1`**, database container **`seha-postgres-1`**, volume **`seha_data`**, state **`/Users/candede/repos/agent365/agent_control/.local/seha`**, host port **3002**. Names are an expected identity, not sufficient verification: compare exact labels, port and volume mounts again immediately before reset, and preserve tenant/sign-in config, every secret, backups, saved port/public URL and unrelated workload services.

07 must still fully build and qualify a **fresh, uniquely owned disposable installation with synthetic configuration**, using checked-in local deployment machinery and all its safety checks. Do not copy either installation's production configuration into fixtures or use either application database for qualification. After qualification and exact production revalidation, the authorized initial command is:

```powershell
pwsh ./deploy-local.ps1 start -Project seha -DbReset
```

The prior unavailable-question result is superseded by the explicit answer. **Do not report `deployment_pending` for target ambiguity or missing reset-target confirmation.** Fresh-installation qualification is not a claim that production was deployed; 07 must continue to the authorized `seha` deployment and observation unless a real access/control-plane/safety blocker prevents it.

### Completed duplicate-cleanup prerequisite

**Parent-reported completed lifecycle action, 2026-09-28:** after verifying Docker project/service labels, project `working_dir`, source mounts and port map, the parent used checked-in `Invoke-DockerCommand` with the `agent-control-phase01` context for Compose `down` with a 130-second timeout, **without `--volumes` or `--remove-orphans`**. No precise action time is asserted without the underlying receipt.

- Removed only `agent-control-phase01-app-1`, `agent-control-phase01-postgres-1` and `agent-control-phase01_default`.
- Retained `agent-control-phase01_data` and `/Users/candede/repos/agent365/agent_control/.local/agent-control-phase01`, including configuration, secrets and backups, for recovery.
- Parent observed `seha` on localhost:3002 healthy and untouched; it remains the exact final production target. Separate workload services were not cleanup targets.

This is a **completed prerequisite**, not an executable worker cleanup task. 07 consumes this receipt, may check recovery-resource presence read-only, and must not repeat deletion, recreate the duplicate, require port 3001 to respond, or erase its volume/configuration/secrets/backups/images. Any later service on port 3001 is not automatically this duplicate. Further data erasure requires a separate explicit user request. Attribute the completed action to the parent, not to the implementation worker.

### Campaign-owned baseline image and protected retained tags

The parent successfully built **`agent-control-scale-5096-operator:local`** as the campaign-owned baseline operator image. Record its resolved image ID/digest before using it for baseline evidence; a successful image build is not software qualification. Preserve that baseline and build changed candidate images under unique campaign/run-owned tags. Do not mutate `seha` or `agent-control-phase01` app/operator image tags during implementation or disposable qualification. Only 07's authorized official `seha` deployment may update that production project's tags; duplicate cleanup does not authorize image deletion or replacement.

## Repository evidence and replacement rationale

| Current controlling path | Problem and required replacement | Owner |
| --- | --- | --- |
| `backend/src/db/dataSync.ts`, `dataSyncSchema.ts` | `publishDirectory`/`publishAppActivity` serialize one JSONB value; directory storage encoding and full getters recreate whole arrays. Replace authority with generation metadata plus records. | 01/02 foundation; 02B activation |
| `services/copilotUsageGraph.ts`, `copilotUsage.ts`, `copilotUsageIdentity.ts` | Graph collectors hold Maps/full CSV; service joins complete directory/report sets. Stream into staging; database deduplication and exact-identity joins. | 02 user sources; 02A combined joins; 02B activation |
| `services/savedAgentPeople.ts` | `read(ids)` nevertheless loads/validates/maps the whole directory. Read metadata plus exactly requested IDs and preserve cached-person precedence. | 02 implementation; 02B activation |
| `db/officialUsage.ts`, `services/officialUsageParser.ts`, `officialUsageViews.ts`, `db/agentUsage.ts` | Buffered upload, sync CSV parse, whole-report JSON parameters and `jsonb_agg`, full report reconstruction and relationship arrays. Preserve report-set/version/fact semantics using streamed parse and relational queries. | 02A implementation/history authority; 02B activation |
| `db/packageInventory.ts` | `list` reads/projects all packages, then sends them back through `jsonb_to_recordset`; whole-source getters feed unified inventory. Compute projection/filter/order/count/facets in SQL. | 03/04 |
| `services/graphPackages.ts`, `powerPlatformResourceQuery.ts`, `powerPlatformInventory.ts`, `db/powerPlatformInventory.ts` | Collectors hold full lists; PP publication binds the entire collection. Incremental bounded staging with complete-source publication. | 03/04 |
| `services/unifiedAgents.ts`, `db/unifiedAgentRegistry.ts`, `services/agentUsage.ts` | A GET loads all sources, reconciles identities, enriches all records, filters/sorts in JS, then slices. Publish canonical generations off-request; GETs are read-only, page-bounded. | 03/04 |
| `routes/officialUsage.ts`, `routes/inventory.ts`, `routes/unifiedAgents.ts`, export services | CSV paths load entire selected sets and often buffer the CSV. Stream bounded pinned queries into authorized export artifacts and stream download. | 01 infrastructure; 02A dormant user/report producers; 02B/04 activation; 05 lifecycle proof |
| `frontend/src/api/client.ts`, `CopilotUsersView`, `ReportedUserAgents`, `UserAgentResponsibility`, `App.tsx` | Full-list local filters/paging, embedded detail relationships, selection/export payloads and polling can undo backend bounds. Atomic API/consumer changes, server filters, paged nested views, bounded cache. | 02B/04; 05 closure |
| `compose.yaml`, `backend/scripts/cache-load.ts`, `scripts/local-deployment.ps1` | Existing 1,000-package/end-RSS check and 256 MiB test DB tmpfs do not qualify target scale or PG memory. Reuse isolation safeguards; add named-volume fixed-budget qualification. | 01 harness; 06 measurements; 07 deployment |

Do not turn this into a new ORM, generic workflow framework, data lake, search engine, message broker, or unrelated application rewrite. Reuse `pg`, existing jobs/admission/session/audit services, `csv-parse`, Express, React Query/Table, and checked-in operator tooling. A small shared generation/selection/export utility is justified; business projections remain domain-specific.

## Frozen record and publication contract

### Identity, schema, and typed facts

Introduce `data_generations`, `data_generation_heads`, `data_generation_batches`, `data_scope_epochs`, `data_read_selections`, and `data_generation_pins` in 01. Domain payload tables are `directory_user_rows`, `directory_service_plan_rows`, `app_activity_rows`; 03 adds `package_record_rows`, `power_platform_record_rows`, `unified_agent_rows`, and `unified_agent_memberships`, with typed child facts for multivalued fields. Reuse official usage artifacts/versions/sets/row-facts and add typed indexed fact columns/relations; do not duplicate the report-set authority.

Every domain record identifies its generation, tenant, scope, natural identity, schema version, and content hash. Principal-scoped sources include principal, token mode, source selector, environment/type scope where applicable. Tenant-wide official reports remain tenant-wide; importing actor is provenance, not an invented visibility restriction. Metadata uses checked `scope_kind` (`tenant` or `principal`) and nullable principal with `UNIQUE NULLS NOT DISTINCT`; do not conflate null with an all-principals sentinel. Scope-composite foreign keys prevent cross-tenant/principal references.

Filter/sort/join fields are typed and indexed: normalized identity keys, display/sort text, company/department, service state, source/native IDs, environment, publisher/host/platform, observed/expiry/activity dates, creator type, response/count metrics, control state, association/evidence status. Preserve original display text separately. Use child fact tables for plans, hosts, connectors/operations, canonical memberships and observed user-agent relationships; **never** synthesize a users × agents matrix or precompute non-observed pairs. JSONB is bounded residual per-record detail, never a collection, search authority, or nested unbounded relationship list.

### Staging and fencing

- State machine: `staging -> validating -> published -> retired -> deleting`; `failed`/`cancelled` are terminal unpublished alternatives. Published record content is immutable; validity metadata may be closed exactly once under the fenced temporal-membership contract below. Retiring changes metadata only. Existing attempt/source/job status vocabulary stays truthful and separate from generation state.
- `begin` reserves quotas and captures expected head revision, source job/run, durable scope/session epoch, lease owner/version, cancellation generation, schema version and request selector. One active writer per source selector; global admission is below.
- `append` accepts at most **250 records AND 1 MiB encoded parameters**, shrinking the batch when either is reached. One record must fit the per-record cap. Batch ordinal + digest is idempotent; identical retry is a no-op, different bytes for the same ordinal fail. Natural-key duplicates with identical facts may coalesce only where the provider contract already permits; conflicting duplicates fail completeness.
- A dedicated heartbeat renews the **60-second** lease **every 20 seconds independently of append, provider wait/Retry-After, validation or reconciliation progress**. Each renewal is a short transaction fenced by owner, lease version, scope/session epoch, cancellation and deadline; zero affected rows or a renewal error aborts in-flight work and prevents subsequent writes/publication. Never renew an expired/stolen lease. Reserve heartbeat scheduling/acquisition capacity within the existing four-connection budget, not an extra unbounded pool. Heartbeats continue through an accepted **600-second Retry-After** and quiet validation stages; stop/release on completion/cancellation. Process death must permit expiry/takeover, and the old owner must then fail every fence.
- Appends independently check the same durable fences. No transaction, lock, pool client or provider response buffer persists while awaiting the next network page; only the independent heartbeat briefly acquires a client. In-memory queues: at most two batches per worker, one provider page, no growing seen-ID sets; dedup/page-token hashes and counts belong in staging tables.
- Validation proves complete expected pages/rows, schema, exact identity uniqueness, child completeness and totals using SQL. Run cancellable statements within the existing **15-second** statement timeout; slice larger validation work into durable bounded steps. No validation by re-loading the generation into Node.
- Publication is one short transaction locking the domain head and durable fences in a documented common order: scope epoch, source head(s) sorted by source/selector, job lease. Recheck every fence in SQL, the expected **output** head, quotas, expiry and complete validation; swap pointer, publish count/provenance and terminal success atomically. Derived canonical work follows the captured-input rule below, not an equality requirement against every newest safe source head. No partially visible batch or fenced-out worker publication. Session revocation/clear-saved-data increments durable epoch before cancelling work. An AbortSignal alone is not a fence.
- Latest failed/denied/partial attempts retain the prior good head where current semantics permit, with correct stale/partial/unknown labels. Missing rows in a complete replacement remove membership; partial provider enumeration never does. Empty successful generations are distinct from unavailable data.

### Changed-key publication and reconciliation progress

03 implements, and 04 activates, **temporal membership/version references** rather than copying all N manifest keys for each 20-record detail update. A root identifies a broad baseline generation plus a monotonic delta revision. Per-key reference rows carry `valid_from_revision` and nullable `valid_to_revision`, scoped to that baseline; immutable content versions are separate. An existing interval may be closed once by the fenced transaction publishing its replacement, never reopened or rewritten. Queries resolve membership at the captured revision with scoped indexes; pins retain reachable versions.

Exact/detail/control updates write only changed keys and affected identity components, with deduplicated change-log keys for downstream work. No full N-row manifest clone, all-source scan or all-record summary rewrite per batch. Full rebuild is allowed only for a genuinely broad complete-source replacement or explicitly scheduled, measured compaction; broad baseline pointer swaps remain atomic. GC reclaims closed intervals/content in bounded slices only after selection/worker/history reachability permits, not a full generation copy/delete for each detail page.

Each canonical scope has **one active reconciliation plus one coalesced latest pending request**, with changed-key ranges stored relationally. Normal newer **safe** source updates update that pending request; they do not repeatedly cancel the active worker. Its pinned, captured still-valid input vector may finish and publish against its expected canonical output head, explicitly marked `catching_up`/stale if newer input exists; then process the coalesced latest vector. Clear/revocation/expiry/correction and unsafe-control invalidation still fence affected work immediately. Do not misclassify harmless enrichment as unsafe to recreate starvation. Read counts/provenance describe the published captured vector; mutation qualification always rechecks current live authority, never a merely readable stale canonical selection. 06 must prove progress and changed-key-proportional writes/GC under 100k detail churn.

### Pinned query contract

First-page requests capture a scoped immutable **selection**: relevant source-generation vector, official report-set/version IDs, canonical revision, control/association/people revisions, authorization epoch, evaluated-at instant and next freshness transition. Reuse that selection for pages, summary, facets, detail and export. Ordinary complete replacement does not mix pages; a pinned prior generation is readable until its **10-minute** selection TTL or earlier availability expiry/next freshness transition. Stale-at-selection data remains readable and labeled stale according to existing business policy; an already-past freshness threshold is not a reason to hide retained history or create an immediately expired selection. Explicit deletion, correction/retraction, clear, authorization revocation or unsafe-control invalidation invalidates dependent selections immediately. Mutations always require a fresh current revision, not merely a readable historical selection.

Selections contain at most **16 root generation/version references**, not an array of every exact observation, environment, person, package or historical report set. Effective inventory/canonical roots address temporal membership references; pins protect their dependencies through scoped SQL reachability. 03 owns that changed-key construction. For existing mutable caches/association/control rows that cannot be read at a historical revision, increment their dependency revision and invalidate referencing selections on change; never silently join latest mutable values into an old page. Each request uses a short repeatable-read transaction, verifies authorization/dependency epochs before sending its bounded result, and computes temporal semantics at the selection's evaluated-at instant.

**Tenant-history selection (02A foundation, 02B activation):** add `official_usage_history_state` (one tenant row with monotonic history revision and invalidation epoch) and `official_usage_history_memberships` (set ID and readable validity interval, no copied report payload). Existing report sets/versions remain the sole data/provenance authority; this is their scoped readable-membership index, not a parallel report source. A history/overview/export selection captures **one tenant-history revision/root plus invalidation epoch**, not every set ID and not only the active-set revision. SQL joins readable memberships at that revision to the original sets/versions, with exact scoped summaries/facets/counts and bounded result pages.

Advance history revision atomically with every acceptance or history-visible change. Ordinary new acceptance preserves the selected historical membership snapshot until its pin expires. Corrections, deletion/retraction, expiry/visibility changes and provenance changes affecting **any** retained set, including a non-active set, also advance the history invalidation epoch and invalidate dependent history/overview/export selections immediately; active-set revision need not change. Preserve existing retained/superseded-set visibility policy rather than arbitrarily hiding superseded sets. Bound membership writes by changed sets, and protect pinned reachable memberships/facts from GC. Prove >16 retained sets, concurrent acceptance and non-active correction/delete; a one-active-set token cannot stand in for tenant history.

All changed list routes keep their existing path but use the **new contract only**:

```text
GET <list>?limit=50&cursor=<opaque>&<allowlisted existing filters/sort>
{
  value: [...bounded summaries...],
  page: { limit, nextCursor, previousCursor },
  selection: { id, revision, expiresAt },
  counts: { total, filtered },
  ...domain summary, source-state, provenance, freshness and verification metadata
}
```

`limit` defaults to 50, maximum 100; reject invalid/excess values rather than clamp. No offset or all-record switch. Cursor is authenticated using the existing server secret, versioned, scoped to principal/tenant/authorization, endpoint, selection, canonical filter/sort hash, direction, normalized boundary key, null-rank and immutable tie-break ID. Maximum encoded cursor 4 KiB. SQL keyset comparison uses the same null ordering and stable normalized/collated keys as ORDER BY; reverse queries return previous pages in display order. A cursor is not authorization. Invalid/tampered/mismatched query: 400 `invalid_cursor`; invalidated/expired selection: 409 `selection_invalidated`. Client clears incompatible cached pages and offers restart, never silently resumes against a new generation.

Small scalar metadata retains existing field meaning/names where practical; there are no aliases for deleted collection fields. `counts.total` is the endpoint's unfiltered authorized cohort, `counts.filtered` matches every applied row filter. Domain tenant/source/checked/licensed/canonical counts remain explicitly separate. Null/unknown is never replaced with zero. Counts/summaries/facets use the identical selection and declared filter scope. Counts are exact safe integers; checked SQL bigint-to-JSON conversion fails on overflow, never rounds.

High-cardinality facets are their own keyset-paged endpoint (`<list>/facets?field=...&selectionId=...&search=...&limit=50`), max 100 options, with exact distinct count. Preserve current self-filter/global facet semantics and document them per endpoint; finite enum facets may be embedded. Exact detail is ID-qualified plus `selectionId`; each child collection is separately paged. Targeted-ID repository queries accept at most 100 IDs (internal ingestion batch APIs use their separate 250-record bound).

### Concrete endpoint ownership

| Owner | Changed/new contract |
| --- | --- |
| 02B (02 user-source SQL; 02A combined handlers) | `/api/copilot-usage/users` server cohort/search/company/department/threshold/sort; `/api/copilot-usage/users/:objectId` detail and `/api/copilot-usage/users/:objectId/service-plans`; `/api/copilot-usage/users/unresolved-identities`; paged facets. Register static paths before `:objectId`. |
| 02B (backend built dormant in 02A) | Existing `/api/official-usage/{aggregate,users,agent-users,agents/:agentId,history,overview}` use SQL/pins/cursors; `/api/official-usage/users/:username/agents` replaces embedded full relationship rows. Existing staging/bundle/accept/select/delete operations preserve immutable confirmation and revision semantics, bounded previews and metadata. |
| 04 | Existing `/api/agent-inventory`, `/api/agent-responsibility`, `/api/agents`, exact package details, agent usage candidate/association and `/api/inventory/resources/:nativeId/related` routes. Add `/api/agent-inventory/:recordId` for exact pinned detail instead of list scanning. Preserve all allowlisted filter/sort and source-scope behavior; details/related resources use child-page routes. |
| 04 | `/api/agents/bulk-jobs` and `/api/agents/bulk-jobs/:id` become metadata/counts only; `/api/agents/bulk-jobs/:id/items` pages outcomes at max 100. Refresh status similarly omits target arrays; `/api/agents/refresh-jobs/:id/targets` pages them. Job-item cursors bind a monotonic outcome revision and invalidate on progress instead of claiming immutable generation history. |
| 01 infrastructure; 02A dormant user/report producers; 02B/04 registration | `POST /api/data-exports`, `GET /api/data-exports/:id`, `DELETE /api/data-exports/:id`, `GET /api/data-exports/:id/download`. Delete superseded `.csv` routes/functions when each domain moves; no redirect/alias. |

All API producers, shared wire types, frontend API functions, hooks, cache keys, components, browser fixtures, tests and docs activate/change in the same cutover phase. 02 builds dormant user-source/licensing/people SQL; 02A adds report/history/combined handlers, targeted agent usage and export producers. Candidate shared types are additive/dormant through 02A; that phase freezes the bounded combined contracts and semantic proofs before 02B registers them and updates all consumers. Existing agent consumers of official usage move in 02B even though canonical inventory activation is 04; 02A's targeted SQL report queries are the boundary, not a retained full-report adapter.

### Export contract

Create a persistent audited job with kind `copilot_users`, `official_agents`, `official_users`, `graph_packages`, `power_platform_agents`, or `unified_agents`; supply selection ID, canonical filters/sort and either all matching rows or at most 5,000 explicitly selected IDs. Selection rows for explicit IDs are inserted in bounded batches. Preserve complete selection semantics, formula-injection protection, exact CSV column meaning and source-validation authorization.

Build asynchronously using at most 250-row/1-MiB SQL reads and backpressure; write artifact chunks of at most **256 KiB** to `data_export_chunks`. No giant strings, Buffers, `arrayBuffer()`, browser Blob, or required writable application filesystem. This fits the current read-only runtime and avoids a new object-store dependency. Validate final row/byte counts, checksum and all invalidation fences before marking ready. Poll returns only metadata/progress/error and never rows or chunks. Download streams chunks with `Content-Length`, attachment filename, private/no-store headers, auth/role/epoch checks and disconnect cancellation. Recheck invalidation during streaming; abort an already-started response on invalidation, with failed audited outcome, never a successful truncated CSV.

Jobs expire after 30 minutes; construction deadline 15 minutes, pinned until the earlier artifact expiry/source expiry, and explicit invalidation still wins. Maximum **2,000,000 CSV rows / 1 GiB per job**, 2 active exports per tenant and 4 globally, no more than 10 queued per tenant; explicit limit failure does not publish a partial file. Status polling is at most one request every 2 seconds with bounded backoff to 10 seconds, stops at terminal/expiry, and aborts on scope/logout/unmount. The browser initiates a native same-origin download, not a fetch-and-buffer.

## Workload envelope and admission defaults

Implement these numbers as **default runtime ceilings**, not merely fixture sizes or future options. They are implementation/qualification targets, **not claims already demonstrated**; 06 must measure them unchanged before calling them supported. The supported target must include at least 100,000 users and 100,000 logical agents plus 1,000,000 actual observed relationship facts, not a users × agents matrix. Existing repo anchors: directory/report cap 100,000, SKU cap 1,000, Graph directory page 100/16 MiB, Graph package deadline 4 hours, PP current 5,000/120-second ceiling, official retained-row ceiling 25,000,000, `pg` pool 4 and statement timeout 15 seconds, isolated Node 1,536 MiB and PG 1,024 MiB. Raising row ceilings alone is not a solution.

| Dimension | Binding target/limit |
| --- | --- |
| Scope size | 100,000 unique directory users; 100,000 app-activity identities; 100,000 Graph packages and 100,000 PP resources per authorized complete source selector; up to 200,000 logical agents |
| Official set | 100,000 user rows, 200,000 agent rows, 1,000,000 observed user-agent facts; 25,000,000 retained fact memberships per tenant (existing ceiling) |
| Bytes | 256 KiB normalized residual JSONB per record; 4 KiB official CSV field (existing rule); 256 MiB per uploaded CSV; 8 GiB normalized staged bytes per inventory/directory generation |
| Ingestion/export SQL batch | At most 250 records AND 1 MiB encoded parameters/result payload per batch; shrink at either boundary, reject a single over-limit record |
| Child cardinality | At most 1,000 service-plan facts per user; 10,000 connector/operation/membership facts per individual logical entity; all are paged/relational, not embedded in list JSON |
| Staging/storage | 1 GiB open official-import bytes per actor, 2 GiB per tenant; 64 GiB retained logical application data per tenant; transactional reservations prevent concurrent oversubscription |
| Provider transport | Directory 100 rows/page, retain 16 MiB page byte ceiling; other JSON pages use existing stricter byte ceiling (normally 2,000,000 bytes). Stream official/app CSV; app report retains 64 MiB wire limit. Never buffer an entire report |
| Collection completeness | Max 10,000 pages and 5,000,000 observed wire rows per source attempt (dedup across filtered discovery is separate from 100,000 unique rows); SKU catalog retains 1,000 cap. Exact reported-identity batches retain 20 IDs and URL validation. Page/token/count inconsistencies fail |
| Execution | At most 4 active ingestion producer streams globally and 2 per tenant, one per source selector; max 20 queued per tenant. Persist admission leases so parent jobs/fan-out or a second app instance cannot evade the limits. Preserve stricter provider pacing. PP complete enumeration deadline 30 minutes; Graph packages retain 4 hours; user source attempt 30 minutes |
| Query/export | Four DB pool connections; finite request queue 32, 5-second acquisition deadline with 429/503 and Retry-After. Max 100 active read selections per principal, 1,000 per tenant; batches/pages/exports as above |
| Response | List/summary/facet response at most 1 MiB serialized, excluding streamed download; summary rows never embed large details. Exact record detail max 512 KiB including envelope, with children paged separately |
| GC | At most 1,000 child rows or 1 MiB payload budget per transaction, whichever first; one worker; 5-second work slice then yield; no cascading multi-million-row delete |

For aggregate byte/cardinality exhaustion, fail the attempt/job with dimension, configured bound and safe observed count, retaining the prior good generation. Never silently truncate, increase budgets on failure, invent success, hide provider omissions, or reinterpret unknown as empty. Provider-origin partial/omitted-detail evidence remains explicit; no new local truncation is allowed. Rows close to the per-record cap and high-cardinality facets/relationships are mandatory tests. The envelope is conjunctive: reaching a byte quota earlier than a row maximum is a documented explicit failure, not support for all maxima multiplied together.

## Business fidelity

02 owns user-source/licensing/people SQL parity; 02A owns report/history/combined semantic goldens and frozen bounded contracts; 02B owns activation, wire/UI/export fidelity and predecessor deletion. 04 owns inventory/identity/control activation parity; 05 proves lifecycle interactions. Freeze golden outputs and deterministic relational truth assertions before deleting helpers. Pure legacy functions may be copied into **test-only tiny fixture oracles** while being removed from runtime at cutover; no production old-format decoder remains afterward.

Preserve paid-feature enabled/warning/partially-enabled vs inactive/unknown; verified active-without-paid cohorts; candidate roster vs licensed vs tenant headcount; D30 activity and three-day app freshness; configured official freshness; unresolved/ambiguous identity effects on unknown metrics; exact UPN/object-ID matching without guessed aliases; nullable availability; blank vs zero; source provenance and date-window/threshold semantics. Preserve official three-kind complete sets, correction/supersession, content dedup, periods/provenance, historical selection, mismatch diagnostics and count bases.

Preserve broad vs exact observations, delegated vs application visibility, catalog-only/detail/control freshness, source-qualified fallback vs canonical identities, merge/split survivor rules, ambiguous/conflicting links, environment/type scope, operation-reference filters, ownership/created-by/modified-by evidence precedence, usage associations, mutation qualification/readback, investigations, access UI and safe bulk selection. Inventory GET must not mutate canonical membership. No principal may gain another principal's saved provider data through a tenant-wide report join.

## Validation execution contract

01 creates `scripts/large-tenant-tests.ps1`, a small checked-in wrapper around the repo's isolated Compose fixture pattern, and `compose.large-tenant-test.yaml`. The wrapper takes `-Suite`, generates a project `agent-control-ltdp-<unique-id>` and uses `artifacts/large-tenant-data-platform/<run-id>/`. It rejects inherited application PG/tenant/credential settings, uses only synthetic fixture credentials, no published integration DB port, no application-secret mounts, no external provider network, and only exact project-labeled containers/volumes. Build uniquely tagged operator/test images; the parent-built baseline image above is available without borrowing retained tags.

**Database naming and roles are purpose-specific, not interchangeable:**

| Purpose | Database name / boundary | Roles and guards |
| --- | --- | --- |
| Integration, browser and restart control/fixture DBs | `agentcontrol_test_*` in the owned disposable PostgreSQL instance | `agentcontrol_admin` bootstraps/cleans; application queries run as `agentcontrol_app`. Preserve `testDatabase.ts` prefix/ownership guards. |
| Isolated restore verification | New `agentcontrol_restore_*`, distinct from source DB, in the owned instance | Existing backup/restore operator guards and source/target checks remain; no restore over the active DB. |
| Full fresh synthetic installation (07) | Actual application DB `agentcontrol` inside a never-before-used, uniquely owned project/instance | Use existing production-shaped bootstrap/grants; instance/project ownership supplies isolation, not a renamed application DB. |

Do not weaken naming guards to route restore through `testDatabase.ts` or rename the fresh application's DB to appease an integration-only helper. None of these fixtures uses the retained `seha` or duplicate recovery instance.

The existing `test-postgres` has a **1-GiB cgroup limit and 256-MiB PGDATA tmpfs**. That tmpfs is suitable only for small existing fixtures, not realistic cardinality. 01 supplies the isolated override; **06 explicitly owns verifying and, where necessary, correcting its effective storage configuration before scale qualification**: run-owned disk-backed PGDATA, WAL and PostgreSQL temporary files, not a larger RAM filesystem. Remove the inherited tmpfs mount rather than merely adding a conflicting volume at the same path. Capture effective mounts, disk/WAL/temp usage and charged-memory/page-cache telemetry, then clean the exact owned volume after diagnostics. Keep Node/PG fixed memory/headroom budgets; disk-backed storage is not permission for arbitrary RAM escalation.

Call the container configuration tool before generating/running container commands; current configured bases are `docker` and `docker compose`. Never use shared default Compose projects, global prune, name-based kills, or application credentials for tests. Artifacts/scratch stay under this repo; do not write to system temporary directories. Diagnostics (logs, inspect/OOM/cgroup counters, SQL plans, snapshots, command/results) are captured **before** cleanup; cleanup uses exact recorded owned IDs only and is independently reported.

**The existing deployment gate needs its own capture boundary (01 owner):** modify `Invoke-LocalSoftwareChecks` in `scripts/local-deployment.ps1`, not only the new outer wrapper. Its current `run --rm` and `finally` PostgreSQL teardown destroy evidence before a caller can recover it. Retain the exact-owned test container until capture, start live cgroup/log capture before workload execution, and capture final available test/PG inspect, exit/signal/OOM and counters before explicit removal/PG `down`. Persist sanitized evidence outside deleted scratch at `artifacts/software-checks/<check-id>/`. Partial startup, software failure, OOM, capture failure and cleanup failure must retain truthful outcomes and every original gate exception; no success fallback or gate bypass. Unavailable post-exit counters are unavailable, not zero. Extend existing failure-path/order/ownership tests in 01; 06 adds full fixed-budget/peak-sensitive metrics.

**Peak evidence (06 owner):** 250-ms Node timer readings are sampled maxima, not proof of maximum heap during synchronous JSON allocation. Combine them with V8 pre/post-GC heap/allocation telemetry and synchronous stage checkpoints, verified by an intentional <250-ms high-allocation burst test. Record sampled and peak-sensitive heap evidence separately from cgroup `memory.peak`, which proves charged-memory high water, not heapUsed. Missing peak-sensitive coverage makes the heap-bound result inconclusive, not passed; prefer existing V8/Node standard libraries, no new profiling dependency.

Exact phase entry commands, run from repository root:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite foundation
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite user-sources-foundation
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite official-reports-foundation
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite users-reports-cutover
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite inventory-foundation
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite inventory
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite lifecycle
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite capacity
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite browser
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restore
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restart
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite fresh-installation
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all
```

The suite owner supplies the suite implementation and test files before its first invocation; later suite names initially fail explicitly as not yet implemented, never green stubs. Focused exact inner commands appear in each phase. `all` runs backend tests, frontend tests, backend typecheck, frontend lint and production build as **separate attempted commands**, then available lifecycle/browser/restore/restart/capacity suites and, once implemented in 07, `fresh-installation`, reporting every status. The fresh-installation suite runs the deployment gate's existing software checks, not `-Suite all` recursively. Preserve the existing deployment gate's own `backend/scripts/test-all.ts` and its refusal on failure; this additional wrapper does not impersonate its result.

Aggregate inner commands:

```sh
npm run test --workspace backend
npm run test --workspace frontend
npm run typecheck --workspace backend
npm run lint --workspace frontend
npm run build
git diff --check
```

Run software commands inside the owned isolated fixture; `git diff --check` runs at the repository root. 01 introduces fixture-support tests; no application credentials are needed. The mocked PowerShell tests are an additional host-side check: `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1`. Browser must enter the `permission-browser-test` image's **Vitest bootstrap** from `/app/backend`: `node /app/node_modules/vitest/vitest.mjs run --config scripts/browser-fixture.config.ts`. That bootstrap installs synthetic MSAL/provider mocks, creates its guarded test DB, starts the app, verifies readiness, then launches Playwright; standalone Playwright would omit those prerequisites. 05 specifies the exact browser and operator-versus-compiled-runtime restart matrix. No production test-auth switch. Do **not** invoke `scripts/permission-browser.tests.ps1`, `scripts/persistence.tests.ps1` or `scripts/restart-runtime.tests.ps1` against a retained application project: they use project secret mounts. Browser/restore/restart suites must use the new owned fixture wrapper with synthetic fixture credentials.

## Requirements and proof ownership

| Requirement | Implementation owner | Focused proof | Aggregate/integration owner | Production owner/signal |
| --- | --- | --- | --- | --- |
| Records, typed keys, DB constraints/grants, independent heartbeats and commit fences | 01; domain activation 02B/04 | generation/cursor/grant, 600-second wait/lease takeover tests | 05 restart/race/invalidation; 06 live pauses | 07 pointer/fence telemetry |
| User directory/activity, licensing SQL and targeted people | 02 dormant implementation; 02B activation | user-sources-foundation goldens and query bounds | 02A combined semantics; 05/06 lifecycle and 100k users | 07 refresh/count/stale canary |
| Official imports, relational reports/history/associations and combined user projections | 02A dormant implementation; 02B activation | official-reports-foundation combined goldens and frozen bounded contracts; users-reports-cutover route/UI tests | 05 correction/export races; 06 1m facts | 07 authorized import/selection observation |
| Bounded tenant-history revision/readable membership and invalidation | 02A implementation; 02B history/overview/export consumers | >16 sets, concurrent accept and non-active correction/delete | 05 pinned history/GC; 06 cardinality | 07 history revision/invalidation canary |
| Package/PP collectors and complete publication | 03 dormant; 04 activates | paging/count/duplicate/fence tests | 06 large provider fixture | 07 read-only provider refresh telemetry |
| Temporal changed-key membership, coalesced reconciliation progress, mutation safety | 03 foundation; 04 cutover | identity survivor/SQL parity, fixed-N changed-key write-count and progress tests | 05 temporal GC; 06 100k detail churn | 07 canonical catch-up/progress/control canary |
| Every UI/API/detail/facet/export consumer | 02B/04 atomically | React/client/route contracts | 05 bootstrapped browser bounds; 06 network/heap | 07 signed-in UI observation |
| Export artifact/pin state machine | 01 infrastructure; 02A dormant producers; 02B/04 activation | stream/backpressure/auth tests | 05 expiry/disconnect/GC; 06 concurrent exports | 07 small verified download/audit |
| Bounded GC, quota, privacy invalidation, restart/restore | 01 primitives; 05 full lifecycle | lifecycle integration and dry-run proofs | 06 repeated replacement | 07 retention/restore receipt |
| Existing software gate captures evidence before removal/PG teardown | 01 inside Invoke-LocalSoftwareChecks | success/failure/OOM/capture/cleanup order and exception-preservation tests | 06 extends metrics; 07 real gate | 07 gate diagnostic receipt |
| Fixed Node **and PostgreSQL** budgets, OOM/headroom, peak-sensitive diagnostics | 06 (01 capture boundaries) | cgroups + live RSS/heap + V8/stage peaks; <250-ms burst detection | 06 repeated runs and coverage status; 07 exact artifact | 07 live memory/latency alerts |
| Fresh disposable installation, retained config protection, exact target revalidation, safe reset/deployment | 07 only | local-deployment/reset tests and fresh-installation suite | 07 all-check reconciliation; `seha` identity reverified; completed parent duplicate-cleanup receipt consumed without repetition | 07 `seha` production receipt and fix-forward |

Every completion record lists implementation/deletions, exact contracts/decisions, changed files by root, all producer/consumer impact checks (including evidence for unchanged roots), commands and true outcomes, environment ownership/actions, residuals, and next-phase preconditions. Parent verifies the record before advancing; no speculative completion records.

## Always-Deploy Production Contract

The campaign must deploy to the explicitly authorized **`seha` production application on localhost:3002**, observe it live, and fix forward. A test-only/readiness/NO-GO report is not completion. Every phase carries its residuals forward and continues safe implementation; 07 must also build/qualify the fresh synthetic disposable installation. The earlier target ambiguity is resolved, not a remaining deployment blocker. Exact label/port/volume verification, unchanged external configuration and all deployment safeguards remain mandatory. Parent duplicate cleanup is already completed; do not repeat it or touch unrelated workloads or retained recovery data.

All focused/aggregate, schema/grants, deterministic/provider-fixture, browser, restore, concurrency/capacity, deployment and live checks are mandatory **attempts**. Where evaluator/model/test-VM categories are irrelevant to this non-model storage refactor, record applicability and evidence rather than invent a model test. Statuses are `passed`, `failed`, `not_run`, `unavailable`, `inconclusive`; never relabel a missing run as passed. Repair reproducible defects and rerun. Each residual records scope, containment, signal/canary, numeric alert threshold, owner (07 until handoff), exact fix-forward trigger and evidence location.

Non-passing preproduction evidence alone is not permission to stop at planning and is not permission to bypass deployment safeguards. Deploy schema/services/observability/safe paths while affected admission/publication/mutations remain closed using existing maintenance/provider/capability/job controls. Open progressively only after their actual invariants hold. Do not introduce compatibility runtime, expose unsafe writes, disable qualification checks, fake test results, or use internal `Start`/direct container startup to evade `Deploy`.

The checked-in local `Test`/`Deploy` path builds the operator image and requires the **5/5 software gate** (backend tests, frontend tests, backend typecheck, frontend lint, production build) before any reset. The parent-built baseline image does not replace that gate. `Invoke-LocalSoftwareChecks` presently refuses deployment on its failed tests **and cleanup failures**. Honor that safety check: diagnose/repair/retry the official path. Record and contain test-resource cleanup incidents; an optional auxiliary qualification cleanup issue need not prevent safe deployment, but a checked-in gate refusal must not be bypassed. If safe mandatory deployment still cannot occur, state the literal refusing command/guard, attempted repairs, affected resources and exact resumable action; keep the campaign open as `blocked_safety_check`. Do not weaken the guard to manufacture completion or misclassify the already-resolved target as unauthorized.

Only a real inability to reach/control the verified production target or obtain required authentication may leave `deployment_pending`, with exact evidence/resumable action and no success claim. `seha` reset authorization is already supplied; the superseded ambiguity is not such a blocker. A physical identity mismatch must stop reset and remain an explicit safety blocker; if it requires a user question, stop and wait for the actual answer. Production feedback drives repeated contain → capture diagnostics → root fix → focused checks → official redeploy → rerun canaries. Disposables are cleaned while production hardening continues. Never reset a second time as a generic fix; after the authorized initial fresh DB reset, redeploy forward with new DDL and new observations.
