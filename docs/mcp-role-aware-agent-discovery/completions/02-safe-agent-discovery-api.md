# Phase 02 — canonical safe agent discovery API

## Result and authority

- **Phase result: `complete_with_risk` (2026-11-06).** Implementation, local
  first-run/affected journeys and final selected-source checks are finished.
  Full-scale capacity **failed**, with all four queries hitting the existing
  statement deadline; it is not qualified. The retained discovery failure is
  the independently reproduced pre-phase02 Office restore; a bounded follow-up
  additionally exposed one independently reproduced pre-auth-repair source-
  cardinality assertion. All repaired reset/auth checks pass. This supersedes the
  PAUSED/INCOMPLETE checkpoint; no owned run remains active.
- Actual supplied worker launch: `gpt-6.1-sol`, `xhigh`; no nested agents.
- Repository: `/Users/candede/repos/agent365/agent_control`; preserved campaign
  baseline `c28fa870c39a009c2f3537e0db87142739f893e4`.
- All prior campaign edits are preserved. The parent alone owns
  `completions/IMPLEMENTATION_CAMPAIGN.md`; this worker has not edited it.
- Authorized work was local code and isolated Docker fixtures only. No seha,
  production database, remote, Entra, registration, assignment, consent, OAuth
  state/key, commit, push or branch operation occurred. Phase 03/04 were not run.
- Production remains `deployment_pending` / `production_hardening_pending`.
  Campaign verification is not runtime authorization: no approval, manual start,
  feature-enable, requalification or release-acceptance gate was added.

## Completed implementation and material repairs

The API now owns one restricted discovery implementation for employees,
ordinary staff discovery and Viewer/Uploader/Admin preview:

- Positive DTOs and SQL provide own saved profile/champion status, complete
  organization-created description search/detail, workplace champions/use cases
  and department/company popularity without metric/admin/person-ID leakage.
- Finished the paused SQL/service provenance change coherently. SQL computes
  source-specific excerpts; the service positively projects them instead of
  labeling a combined description with the first source. A native-only purpose
  match proves `power_platform` evidence even when Graph provenance also exists.
- A bounded parent-requested reset/auth follow-up reproduced rejection of a
  genuine fresh signed MCP OAuth/OBO token with provider-normal `iat`/`nbf`
  backdated 300 seconds. The blanket reset-time cutoff was removed. Reset now
  preserves only actual canonical per-principal revocation epochs/cutoffs in
  protected maintenance storage, then seeds the same canonical owner during
  fresh transactional initialization. Signed timestamps, known revocation,
  tenant/account/roles, expiry and OAuth continuity are not relaxed.
- Removed the invalid repeated Package-3/Alice natural-identity CSV rows.
  Importer integrity was not weakened. Distinct valid Package-3 aliases remain
  and canonical distinct-user popularity collapses them.
- Full saved native/About descriptions are assembled before rendering, matching,
  excerpts or chunks. The query covers complete selected/current inventory,
  not a staff endpoint's first page.
- Raw approved descriptions narrow canonical candidates before people rendering;
  only permitted rendered text determines final matching/ranking/excerpts.
  All sources of a selected candidate are retained. Unfiltered reads bound
  candidates before rendering. Full direct descriptions avoid unnecessary
  About-fact scans; title ties use `COLLATE "C"`.
- Workplace counts group the distinct user-agent relation once rather than
  rescanning it per person. Relevant report identities bound source-link work;
  eligibility is restricted to scoped popular candidates. Ambiguous links are
  still checked across all live sources matching those identities.
- The selected-directory helper checks global alias ambiguity with two exact
  identity/UPN equality lookups joined by UNION, deduplicating a row that matches
  both keys. This replaces repeated generation-wide OR scans without narrowing
  the authoritative ambiguity set. Owner-array DISTINCT work now follows
  canonical candidate narrowing; known detail/workplace agent IDs constrain
  current-source materialization before people rendering.
- A real full-scale search attempt exposed PostgreSQL parallel-hash shared-memory
  exhaustion. Discovery now uses transaction-local
  `SET LOCAL enable_parallel_hash = off`, allowing ordinary hashes to spill
  rather than exhausting bounded `/dev/shm`. The benchmark completes its actual
  50 measurements before EXPLAIN under that same setting, while its selection
  remains live. An instrumentation failure is separately reported and cannot
  erase completed samples or manufacture plan evidence. Invalidation follows
  EXPLAIN. Other readers' settings and the existing 15-second statement budget
  are unchanged.
- Saved workplace display labels and nonidentifying affiliations are rendered
  safely, separately from raw saved query scope. Hidden champion evidence also
  sanitizes another selected member's identity-bearing workplace labels.
  Redacting display labels cannot change scope, popularity or championship.
- An intermediate integrated run exposed a genuine shutdown/sign-in race:
  a users attempt could be `cancelled` with `interaction_required`, rather than
  `waiting_authorization`, and therefore retain the ordinary one-hour failure
  backoff after fresh sign-in. `CopilotUsageService` now treats only that
  authenticated-shutdown cancellation as due after a newer sign-in. Provider
  failure and explicit `read_job_cancelled` backoff remain unchanged. The real
  restart fixture now deliberately blocks directory I/O until its actual
  cancellation signal fires, verifies the stored cancellation, then verifies
  automatic recovery. Six unit cases cover both sources, stale sign-in and
  explicit user cancellation.
- Restored the lifecycle helper's missing real Git offline, then corrected its
  first MCP setup answer queue for the two privacy defaults. No fake Git,
  skipped guard, package download or external registry probe was used.

No second catalog/profile/search store, vector/model service, social graph,
generic privacy NLP framework, compatibility route, migration chain,
speculative index, recommendation scheduler or new test runner was introduced.
Necessary complexity is limited to positive projection, saved identity/privacy
rendering, current authority, immutable actor-owned selections and protected
actual principal revocation. The superseded global singleton and its reset,
reader, grant, backup, verifier, test and documentation consumers were removed
together; there is no compatibility path.

## Exact phase 03 API/action/projection map

`backend/src/types/agentDiscovery.ts` is the public typed source of truth.
`AgentDiscovery.execute` is the single business owner:

| Intent/action | Canonical method and input | Result |
| --- | --- | --- |
| Own saved workplace/profile and nameless own champion status | `POST /api/discovery/read`, `{operation:"profile",selectionId?}` | `DiscoveryProfile` |
| Organization goal search or bounded catalog continuation | same method, `{operation:"search",selectionId?,goal?,terms?,limit?,cursor?}` | `DiscoveryPage` |
| Complete safe purpose/detail continuation | same method, `{operation:"detail",selectionId?,agentId,cursor?}` | `DiscoveryDetail` |
| Champions, use cases and department/company top three | same method, `{operation:"workplace",selectionId?,scope?:"department"\|"company"\|"both",limit?}` | `DiscoveryWorkplace` |
| Staff read-only saved-member preview | `POST /api/discovery/preview`, same operation plus required exact saved `subject` | Same result; neutral preview context |

The API-owned access profile exposes effective audience, finite input choices,
preview authorization and both privacy values. The roleless operation set is
access profile, authenticated entry and discovery read; preview is staff-only.
`POST /api/mcp/authenticated-entry` remains the phase 01 idempotent due-admission
owner. Normal access-profile/catalog reads do not dispatch collection.
Phase 03 binds initialize/list to that owner and wraps these reads; it must not
join data, compute business ranks, copy staff DTOs or invent a public tool name
in the API. Native protocol/catalog implementation remains phase 03 work.

### Inputs, selection, actor and continuation

- Goal <=512 characters; <=8 unique normalized expanded terms, each <=128.
  Search defaults to 5 cards, maximum 20; workplace defaults to 3, maximum 20
  separately per requested scope. Cursor <=4096 bytes.
- Safe detail chunks <=4096 UTF-16 characters with surrogate protection;
  card description <=512; per-source evidence excerpt <=320 SQL characters.
  Serialized response budget is 1,048,000 bytes. Existing acquisition/queue/
  deadline/cursor limits are retained; PG statement timeout is 15,000 ms.
- Unknown options, personal/owner filters, forged privacy/workplace/role fields,
  malformed inputs and oversized limits fail explicitly.
- Omitted selection captures through the existing owner. Selection endpoint is
  `agent_discovery`; `query_json` binds `mode,subject,profile,directory,report,
  association`. Its authorization principal is the actual actor, never the
  selected preview member.
- Every read/reuse rechecks actor authority, saved subject/profile, directory,
  association revision and current-clock inventory authority. Current policy
  is applied; cursor hashes bind request, mode, subject, profile/data and privacy.
  Unrestricted staff selections, cross-principal/subject cursors, changed profiles
  and tightened-policy cursors cannot be reused.
- Preview requires the actual actor's Viewer hierarchy. It resolves one exact
  same-tenant saved enabled Member by ID/UPN; unknown, guest, disabled or ambiguous
  subjects fail safely. Target roles, token, sign-in and licensing are not used.
  A target with Admin assigned cannot elevate the actor. Later self-service
  returns to the actual actor's own account; concurrent previews do not mutate it.

### Positive response allowlist and honest states

- Common: neutral self/preview context, safe saved company/department,
  profile state, opaque selection/revision/expiry and effective privacy.
- Profile/workplace: content-period dates, `available|stale|unavailable` report
  state; own champion `suggested|not_suggested|unavailable` with safe reason.
- Card: canonical agent ID; safe title/description and withholding state;
  `draft|published|unknown`; permitted creator/owner name/contact; safe
  nonidentifying affiliations; limited source/observation/description provenance;
  source-specific task excerpts. Internal people IDs, counts and ranks are
  positively omitted, including nested objects.
- Text objects are exactly `{state:"available"|"absent"|"privacy_withheld"|
  "unsafe_withheld",text:string|null}`; descriptions also have `clipped`.
  Contacts contain only `name,contact,company,department`; affiliations only
  `company,department`. Evidence contains only `source,field,excerpt`; sources
  only `source,observedAt,descriptionField,descriptionState`.
- Search: `candidate|no_matching_saved_evidence|coverage_incomplete`, bounded
  cards and continuation. A textual match is not invented capability/provider
  access, and no match is not “no agent anywhere”.
- Current approved saved contracts contain no verified provider-use URL.
  `useLink` is explicitly absent; no management URL is fabricated.
- No raw reports/configuration/instructions/knowledge/connectors/credentials,
  metrics/scores/activity rosters, person IDs, controls/jobs/audit/security data
  or administrative links are projected.

## Authority, workplace, ranking and privacy

- Organization-created eligibility requires a current authoritative native
  Power Platform source or Graph package `lob|custom` source. Presence, sharing,
  deployment, reported use, first-party/third-party/unknown origin do not confer
  eligibility. Selected membership and live current-clock authority must agree;
  removal/expiry of the sole creating source prevents stale discovery.
- Department means saved company AND department; company means saved company
  across its departments, never the tenant/all missing users. No token/email
  affiliation or live member lookup supplies workplace. An unlicensed employee
  missing from the saved source remains catalog-only.
- One report Latest by content end/start period and acceptance tie-break is
  pinned per answer/continuation. No overlapping-period sum or personal report
  preference mutation occurs.
- Popularity counts distinct saved directory users per canonical agent,
  collapses valid aliases and excludes ambiguous links. Used-here and
  proven-created-here relationships are distinguished.
- `championRanking.ts` shares the exact existing staff ordering:
  responses DESC NULLS LAST, distinct used report-agent count DESC,
  lowercase name COLLATE C, identity. Equality is proved for the same resolved
  set/period; discovery independently chooses current Latest, not an older
  personal staff preference. Own status compares that exact top-three set.
  Missing/anonymized/ambiguous linkage is unavailable, not a negative inference.
- Independent deployment flags default false. Employee hiding controls structured
  creator/owner identification; champion hiding independently controls
  identification as champion. An allowed category may name a both-role person
  without linking them to the hidden category.
- API policy applies before JSON to roleless, ordinary staff and all previews.
  Prose is conservatively sanitized under either hiding setting. Saved identity
  evidence is NFKC-normalized; known ID/name/contact tokens are removed
  longest-first, links/email/UUID are redacted before excerpts/chunks, and unsafe
  or insufficiently evidenced fields are explicitly withheld without dropping
  the agent. This is not a promise to detect arbitrary personal data with NLP.
- Hidden text cannot select/rank/excerpt an agent. All four combinations retain
  the internal catalog, popularity and champion set, safe affiliations and
  nameless own status. Display-label sanitization never supplies query scope.
  Contact subobjects suppress duplicate raw workplace labels under hiding;
  safe nonidentifying workplace metadata remains separately available.
- Both routes are no-store. Reads perform zero provider collection/control work
  after authentication/bootstrap; missing report/scope affects dependent answers,
  not supported organization discovery or unaffected staff paths.

## Current query → storage/index/publication/removal ownership

| Query/read | Canonical storage and existing index families | Publication/removal owner |
| --- | --- | --- |
| Profile/preview and stored scope | `data_generations`, `directory_user_rows`; generation/identity PK, `directory_user_upn`, existing entitlement/name/scope indexes | `UserSourceStages` / `UserSourcesRepository`, application users source, existing clear/retention |
| Current eligibility, full purpose/search/detail | `inventory_roots`, `inventory_memberships`, typed package/native/unified rows, `inventory_facts`; current-root/member/source/typed-row PKs, `inventory_fact_children` | Existing package/native collection, `InventoryGenerations` and `InventoryReconciliation`; authority/expiry/clear owners |
| Report Latest, resolution, champions | `official_usage_sets/versions/set_versions/version_rows/row_facts`, saved directory; report membership/payload/directory-identity indexes | `OfficialReportImports` and existing publication/deletion/retention owners |
| Canonical popularity/link ambiguity | Same report/directory/inventory owners plus `agent_usage_associations/state`; association PK and target index | Existing canonical association owner and report-delete cascade/revision triggers |
| Selection/cursor fences | `data_read_selections`, parts/pins and existing scope/principal epochs; admission/pin/reachability indexes | `DataSelections` / selected-read/inventory locking owners |
| Safe text and reset revocation | Immutable `discovery_safe_text`; existing `data_principal_epochs`; protected maintenance principal-revocation snapshot | Current schema/operator and the same principal/bearer authority owners |

No extra persistent search table/materialization/index is retained. Observed
small-fixture plans use existing typed-row/member/root, About-child, directory
identity/name, report-membership/payload and association indexes. Full-scale
plans/measurements below, not a small proxy, determine capacity status.

## Schema, protected reset, resume and automatic rebuild

- Compiled current schema after the bounded auth repair: **107 tables /81
  functions**; fingerprint
  `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`.
  Current saved directory Member/enabled fields support preview. DDL, fingerprint,
  schema verification, least-privilege grants and backup inventory share owners.
  No legacy schema path or migration chain was added.
- Runtime consumes the existing canonical `data_principal_epochs` owner and its
  unchanged strict per-principal signed `iat*1000 > bearer_issued_after` rule.
  Reset never advances a cutoff merely because the database was reset. There
  is no additional runtime store, singleton, grace window or timestamp rewrite.
- Exact confirmed operator reset uses `agentcontrol_admin` on `postgres`,
  validates only `agentcontrol` or separately named `agentcontrol_test_*`,
  ownership/non-template status and exact confirmation, and serializes reset.
  Protected `postgres.public.agentcontrol_principal_revocations(database_name,
  tenant_id,principal_id,epoch,bearer_issued_after)` is not runtime/PUBLIC-
  accessible. Only actual rows with a positive revocation cutoff are retained.
- The operator holds a SHARE lock on the target's canonical principal owner
  through `DROP ... WITH (FORCE)`, capturing committed revocations without
  admitting later principal writes. It publishes monotonic exact epochs/cutoffs
  in bounded batches before DROP. An initialized target missing that owner or
  a failed protected publication fails closed before deletion. A failed CREATE
  retains the protected rows; an absent-target retry never overwrites them with
  an empty snapshot. Fresh initialization transactionally seeds those rows in
  the existing canonical principal table and the new current fingerprint.
  Only minimum security authority survives, not roles, sessions, employee/
  report/catalog business data or another active authority owner.
- Isolated tests populate inventory, selection and sessions, reset through the
  real operator, verify deletion, initialize/grant the current schema and use
  real signed tokens to reject a genuinely revoked known principal. An otherwise
  valid unknown/unrevoked token remains valid by design, not blanket-invalidated
  to manufacture fence proof. A genuinely fresh signed roleless OAuth/OBO token
  with both API and ID-token `iat`/`nbf = now-300s` succeeds immediately with
  unchanged timestamps and no sleep; current role/tenant/account checks remain.
- This distinction is necessary: signed `iat` alone cannot distinguish a valid
  freshly obtained backdated token from an unrevoked valid older assertion.
  Reset is not an account revocation. For a genuinely revoked account, even a
  freshly obtained token remains denied if its signed issuance predates the
  actual account cutoff; no reset grace bypass weakens that existing authority.
- Pre-reset denial/failed DROP preserve the target; a real injected creation
  failure after DROP leaves the exact database absent and exact protected
  principal authority retained. Recovery safely recreates the missing target.
- Successful reset/recreation plus failed transactional initialization resumes
  ordinary start **without `-DbReset`**, not a second destructive reset.
  Failed creation is an incomplete reset: inspect the absent exact target and
  recover it; never drop an already completed replacement.
- Current source owners automatically rebuild directory/inventory after normal
  startup/sign-in. Deleted official reports/history are not inferred or restored
  from synthetic fixtures; genuine staff import remains the existing workflow.
  External encrypted MCP OAuth state/keys, settings, registrations, assignments,
  consent, callbacks, secrets and the PostgreSQL volume are outside this reset.
  No seha reset was performed in phase 02.

## Verification and reproducibility

### Required focused/current checks

```sh
npm run test --workspace backend -- src/services/agentDiscovery.unit.test.ts src/routes/agentDiscovery.unit.test.ts src/services/adoptionGroups.unit.test.ts src/db/inventoryAuthority.unit.test.ts src/services/copilotUsage.unit.test.ts
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
git diff --check
```

- Required four files: **52/52 passed**, current selected sources.
- Cancelled-source unit suite: **170/170 passed**, including six new cases.
- Backend/frontend typechecks and diff hygiene: exit 0.
- The final combined invocation selected all five files in one runner:
  **222/222 passed /5 files**, 1.34 seconds.
- Logs: `artifacts/test-scratch/discovery-resume-focused-final-7.log`,
  `discovery-resume-backend-typecheck-final-7.log`,
  `discovery-resume-frontend-typecheck-final-7.log`. Earlier separate invocations
  are comparisons, not substitutes for this final frozen-source proof.
- Bounded auth follow-up additionally ran:

  ```sh
  node --import tsx --input-type=module -e 'const m = await import("./backend/scripts/databaseReset.ts"); console.log("Reset operator module parsed:", typeof m.resetDatabase)'
  npm run test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/requestPrincipal.test.ts src/auth/delegatedCredentials.test.ts src/db/schema.test.ts
  ```

  Operator module parsed; **375/375 passed /4 files**, 1.59 seconds.
  Log `artifacts/test-scratch/discovery-reset-auth-focused-2.log`.
  Required discovery 52/cancelled-source 170 and frontend typecheck proofs are
  reused only for unchanged exact-content owners; current backend typecheck
  additionally passed in both new isolated selectors.

### Existing isolated command, not a new runner

```sh
docker run --rm --pull=never --network none --user 501:20 --group-add 0 \
  -e PATH=/usr/local/bin:/usr/bin -v "$PWD:$PWD" \
  -v /Users/candede/.docker/run/docker.sock:/Users/candede/.docker/run/docker.sock \
  -w "$PWD" --entrypoint pwsh agent-control-roleless-powershell:local \
  -NoProfile -Command \
  'function docker { & /usr/local/bin/docker --config (Join-Path (Get-Location) "artifacts/test-scratch/roleless-docker-config") @args }; & ./scripts/large-tenant-tests.ps1 -Suite mcp-agent-discovery -BaselineImage agent-control-roleless-baseline:local -BaselineImageId sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd'
```

Change only the existing selector to `mcp-roleless-authority` for shared
authority/first-entry or `mcp-agent-discovery-capacity` for full capacity.
The bounded auth follow-up used the same command with `mcp-roleless-authority`
and `auth-recovery`; no runner or selector was added.
The discovery selector includes the required four files, SQL/HTTP discovery,
policy/access profile, schema, reset/operator, backup/restore, fixture selector,
selections, reports, inventory publication and automatic-refresh integration;
it also runs backend typecheck.

### Current integrated receipts and test coverage

- Final bounded reset/authority: **794 passed /16 files**, no failures; backend
  typecheck passed. Exact project `3487cf8598ce4cae8f4ec0a0770bde27`;
  test 61,696 ms, typecheck 4,127 ms. The fresh signed backdated roleless OAuth
  regression passed in 838 ms, protected preservation/interrupted initialization
  in 1,421 ms, missing-owner denial in 475 ms, pre-DROP publication failure in
  499 ms and concurrent committed-revocation capture in 610 ms.
  Driver `artifacts/test-scratch/discovery-reset-authority-final-2.log`.
- Current `auth-recovery` selector: **316 passed /1 failed /317**, five files
  passed/one failed; project `fa9a7d5da8c541379645df2055c0f1ce`.
  Test 20,930 ms/exit1; backend typecheck 4,282 ms/exit0. Current backup/restore,
  sessions, schema, operator and API-auth checks pass. The sole failure is the
  separately reproduced pre-auth-repair source-ceiling assertion below, not a
  reset/OAuth defect. Driver
  `artifacts/test-scratch/discovery-reset-backup-final-2.log`.
- Retained discovery project `5d03ef2beb6940e1992749d48ffc762a`: **535 passed /
  1 failed /536**, 16 files passed /1 failed; sole failure is the independently
  reproduced pre-phase02 Office restore below. Test receipt: 272,996 ms/exit1;
  backend typecheck: 2,727 ms/exit0. The forced real directory-cancellation/
  fresh-sign-in recovery case passed in 1,512 ms; cross-subject identity-bearing
  label sanitization passed in 1,387 ms. This preceded the bounded auth follow-up;
  its discovery SQL/service/DTO/retrieval source hashes remain exact-current.
  It is explicitly reused projection/query proof, not a claimed full rerun on
  the new authentication schema. Changed auth/schema/backup owners were newly
  verified by the two existing selectors above.
- Real-Git lifecycle: **451 assertions passed**; mocked Docker, actual
  Git/source checks and Compose interpolation. This is not deployment proof.
  Entry point was `./scripts/local-runtime.tests.ps1` under `pwsh -NoProfile`
  inside the fixture-only real-Git helper identified below; log
  `artifacts/test-scratch/discovery-resume-runtime-tests-2.log`.

Current SQL/HTTP coverage includes all twelve deterministic retrieval cases,
75 records/71 eligible, underlying staff first page 50, agent-70 tail match,
agent-75 >20,000-character About and complete paging; native-only provenance;
private/draft/current creating authority; exact current champion equality;
department/company top three and valid alias collapse; same department across
two companies/multiple departments/provider-affiliation mismatch; missing
profile/company/department/report and anonymized/ambiguous/tied identities;
changed/deleted/overlapping reports; actor/role/tenant/subject/source/selection/
cursor changes; guest/disabled/unknown/ambiguous and target-Admin preview;
default self-service and concurrent previews; all four privacy combinations for
roleless and each staff-role preview, complete descriptions, both-role people,
identity-only probes, hostile text/links/errors/nested output, tightened policy;
bounded/malformed inputs, zero provider work; fresh/reset initialization,
fingerprint/grants, missing canonical principal owner, real revoked-token
non-resurrection, immediate backdated OAuth sign-in and recovery failures.

### Comparisons, not interchangeable final passes

- Backdated-auth reproducer `d56b14c0d9bb4c9fac4d42cc4d18f2dc`:
  **790 passed /1 failed /791**, 56,717 ms; exact new reset regression rejected
  the genuine signed `now-300s` token as “The bearer predates account
  revocation” at `requestPrincipal.ts:96`. This proves the removed blanket
  cutoff caused a normal first-run delay, not a hypothesized provider issue.
  Driver `artifacts/test-scratch/discovery-reset-backdated-repro.log`.
- Initial follow-up snapshots `3576d128b045414da6f0dc9f5c308bcb` and
  `90d2993774794e6884a7347e2b8242b0` had respectively 658 passes/1 failure
  plus six collection errors, and 267 passes/1 failure plus four collection
  errors. A misplaced new script type export and stale 108-table assertion
  were corrected; final snapshots above supersede them. The initial focused
  run had 374 passes/1 schema-count failure; final focused **375/375** passed.
- Resume attempts 1/2: 507 passed / 1 failed / 508; invalid CSV failures repaired.
- Later projects `122c27c0f77148aca7eca00d402561d8`,
  `3324d3dbb07d49cc9bc6db3afc182fe5`,
  `3b550d08be264dd191804f8e0bd5afbf` and
  `bfd02810d1934770a18c72945b988b05`: 535 passed / 1 failed / 536,
  sole Office restore failure.
- Earlier final-5 discovery/authority projects
  `18c0b488734a47488f06ef98af792b7d` and
  `23ae88297dce4c9f9841d578dd39ab1a` had respectively 535/1/536 and 790/790.
  The final-7 proofs above supersede them after the shared query-root repairs.
- Pre-auth-repair final-7 shared authority
  `912acc2db6f8473d8f96a77c162d7c7e` passed 790/790, 49,474 ms; its 2,974-ms
  typecheck and forced restart proof are retained comparisons. The new 794-case
  proof supersedes it for current reset/auth/schema content.
- `fb2dcc6f776e4384bc8f521f4e33d539`: 534 passed / 2 failed / 536;
  Office restore plus cancelled-users restart race. The latter is now repaired
  with the real deterministic fixture and unit backoff cases above.
- A host full `largeTenantFixture.test.ts` attempt without isolated PostgreSQL
  had 77 passes/2 environment failures; the entire 27-case file is now included
  in the isolated discovery selector. That host attempt is not SQL qualification.
- Old PAUSED results (496/12/508 and incomplete capacity) are historical failed/
  interrupted evidence only, not final passes.

### Small-fixture plans, not capacity qualification

The final SQL was explained in the final discovery run against 5 people/
75 records/71 eligible: search 15.162 ms/4 rows/4,320 shared hits; combined
popularity 8.902 ms/3 rows/14,780 hits; full description
1.799 ms/1 row/67 hits.
All recorded 0 shared reads and 0 temporary blocks. These are cached correctness/
query-plan observations, not <=2-second scale qualification.

### Full-scale capacity — final current-source failure

- Required: 100,000 people, 200,000 canonical records, 1,000,000 accepted
  user-agent report facts; search, department popularity, company popularity
  and combined preview separately; 3 warmups +50 measured requests each;
  p95 <=2,000 ms. Authentication/model latency excluded.
- Existing allowance: command 1,740,000 ms, test 1,700,000 ms, outer 30 minutes.
  Dataset counts/machine are emitted after real report acceptance, not just
  staging; actual measurements precede EXPLAIN with a live selection/current
  query setting. Plan failures are explicit independent evidence; failed shapes
  report actual completed samples and null missing p95.
- Comparison `9ae04a68a38e4c3a92b9f3be77463fd7` published 100k people/200k
  catalog and staged all 1m edges, then failed the first search on parallel-hash
  shared memory (`No space left on device`, requested 8,388,608 bytes).
  No measured samples/p95 or final dataset-count receipt were produced.
  This prompted the transaction-local hash repair; no old timing is reused.
- Intermediate source snapshots `e3feb487ef1c4bca9eca95b7462c5fc7`,
  `6718ad000ae04dbc9eb72fa7b0c6903b`,
  `b8710bf321404598a3fa004e5675b762`,
  `144dc5fa684c4de2ab3b514724b79a5f` were deliberately replaced before
  measurement after source/verification repairs. Each workload exited 130 with
  `OOMKilled=False`; its existing runner cleaned its own resources. They provide
  no capacity pass.
- Completed comparison `20d77c48f99c4c958b6a391c6878f587` physically accepted
  **100,000 people /200,000 canonical records /1,000,000 report facts**.
  All four shapes failed `57014` statement cancellation: search completed
  3 warmups/0 measurements before EXPLAIN timed out; each popularity/preview
  shape completed 0 warmups/0 measurements. The single capacity test failed;
  command 1,315,004 ms/exit1, OOMKilled=False. No p95, response-size or actual-plan
  receipt was produced. This prompted the exact ambiguity/candidate repairs
  and moving actual measurements before instrumentation; it is not final proof.
- **Final frozen-source project `2db33721b1c34abf84770e05d35e2927` finished**;
  command `npm run test --workspace backend --
  scripts/agentDiscoveryCapacity.test.ts --silent=false`:
  **1 failed /1 test**, 1,446,994 ms/exit1, no signal, OOMKilled=False.
  Existing runner cleaned its exact containers/volume; shell
  `discovery-resume-capacity-final-7` finished exit1. Driver:
  `artifacts/test-scratch/discovery-resume-capacity-final-7.log`; workload:
  `artifacts/large-tenant-data-platform/2db33721b1c34abf84770e05d35e2927/1f78906ea988d98e6f5d155e2179325f54276ba853fa7aa17c2b26dc7c228edf.log`.
- Real accepted dataset: **100,000 directory people /200,000 current canonical
  catalog records /1,000,000 user-agent report facts**. Staging alone was not
  used as proof. Catalog source checksum:
  `0b0a6422a4f7852cf1c42f066f4e369a13ead5628fd2b6ecbdcd60e478fc2d37`.

| Shape | Completed warmups | Completed measured requests | p95/max/capture/response bytes/cards | Actual failure |
| --- | ---: | ---: | --- | --- |
| Search | 0 | 0 | unavailable | `57014`, first search SQL statement cancelled |
| Department popularity | 0 | 0 | unavailable | `57014`, first popularity SQL statement cancelled |
| Company popularity | 0 | 0 | unavailable | `57014`, first popularity SQL statement cancelled |
| Combined saved-member preview | 0 | 0 | unavailable | `57014`, first popularity SQL statement cancelled |

The planned 3 warmups/50 measurements per shape were attempted, not completed.
The 15,000-ms SQL deadline terminated all four first reads; this is an observed
query-capacity failure, not an unavailable tool, empty dataset, authentication
failure, OOM, successful benchmark or a measured p95 of 15,000 ms. PostgreSQL
logs identify `live AS MATERIALIZED` search and `selected_directory` popularity
statements as the cancelled owners. No EXPLAIN could follow completed samples:
full-scale actual scanned rows/blocks/bytes, response sizes, capture/max latency
and p95 therefore remain **unavailable**, not zero. Auth/model latency was
excluded. The observed practical source/candidate/ambiguity/hash repairs did
not meet the required capacity contract; small cached plans cannot erase that.
The parent explicitly accepted this failed residual under Always-Deploy and
directed no further huge benchmark during the bounded auth repair. This receipt
is retained unchanged-query evidence, not a new 107-table-schema capacity run;
no measurement is invented or upgraded.

## Environment and source identities

- Actual host: Apple M5 Pro, Mac17,8, macOS26.7.2, Node24.22.2;
  fixture Node24.20.0/Vitest4.1.11. Docker29.9.2,
  `desktop-linux`, exact existing Unix socket. PostgreSQL17 bookworm.
- Existing fixture resources: work 1.5GiB/1.5CPU, PG1GiB/0.5CPU,
  disk-backed owned volume, shared_buffers32MiB. Actual machine/plan/response
  metadata from the final capacity receipt: linux/arm64, Node24.20.0,
  CPU model `"unknown"`, 18 logical CPUs, OS memory 8,317,267,968 bytes,
  work cgroup memory 1,610,612,736 bytes; PostgreSQL17.11
  Debian17.11-1.pgdg12+2/aarch64/gcc12.2/64-bit. The host model is not substituted
  for unavailable container CPU metadata.
- Host pwsh/dotnet previously exited137; not blindly retried. Offline helper
  `agent-control-roleless-powershell:local`:
  `sha256:d8c890e2a42c8f7763b972e2c17e9bbf3e301597c0bc24d52eaf8332abb61162`.
  Cached dependency baseline:
  `sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd`.
- Missing lifecycle Git was repaired from genuine cached Git2.39.5 plus its
  arm64 loader/libraries/templates in `node:24-bookworm`
  `sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`.
  Fixture-only helper `agent-control-discovery-powershell-git:local`:
  `sha256:5451d557af6acecb7027f958ced486e1580b5610526e8cb9c71768156af73b74`.
  It executes actual Git, not simulated guard responses.
- No dependency install/download. npm/Python approved proxies remain mandatory
  for any later required installation; public/default registries were not probed.
  Scratch/evidence paths stay inside the repository; no production credentials
  appear in this record.

### SHA256: binding prompts and final implementation

```text
README.md                           e09a877b4a7a7ec13278c2eae52a8443f70f37b1f0428d4db4439a3ba0c4f519
02-safe-agent-discovery-api.md       6516994a3a247359381a3af315d6b258d5dd5981ac72ff59988ecaeecc0bd2a5
db/agentDiscoveryQueries.ts         7ef6a97d8b15af5bdb0007ca9d3233a37f181624531045407fbb2c5a92aa1150
db/officialReportQueries.ts         4d08a599e132e25446e8915e64d4bc906cca68df99aee89f56a720ab0da3f029
services/agentDiscovery.ts          eb71715af7ebab4d99ef84bff26ae2993b68e11d8a88013fcce51c82e0bdd32b
types/agentDiscovery.ts             31359c0843a390106188f66c9bc8f87f870b8cfa8ed758f0eb9e5c49f9689073
routes/agentDiscovery.test.ts       2f15c69a5f59166cd6486dd2470970dbcc54dc892d367645505c066be46e3127
scripts/agentDiscoveryCapacity.test.ts 1bca517b47553697aa8aa6507a68cc544fa5471e0dc1e2ee9d17ec65e8530a73
scripts/databaseReset.test.ts       8ea64634ed4f6fd3bf6ce87641ffb2bc9e2a2fc8473fa7e35cd8e4a49354d05c
db/agentDiscoverySchema.ts          72d620b7844c889aa363faec74f7ba132748f65a9e6d2fb16dd2a7623cb060f7
scripts/databaseReset.ts           714bb154d74cac3841e42df4e7bf700f01edd9b5b6089cf8783edb36f28009f1
scripts/database.ts                65091050da474156934d787c06141bfcbf4b7f40ea1d8377868601c0d5bca22b
db/dataGenerations.ts              9b574217fd813b1bc122b6e056fc643a4fe1e74e3116c0bd6bfec80bedafd744
db/schema.test.ts                  6afd66fba36f006564911e9f2403b4ba15203392766e36749425eea58e15118f
scripts/backup.ts                  4f717e5ae97c701acdccb9c094ba3ea66d87ac074ef0f89c78f4ab2a1a23edaa
scripts/backup.test.ts             d411af4f1e660e727e6b68c471de53fd416216bdcfc0816abe263c90f30add11
scripts/backupInventory.ts         18b15bd688ec47bbf5264b26a99e14767fed36b62916959f907dea4c47ef0263
db/currentSchema.ts                f2d1d4189ece889534eaf002d50ee623277d12d6600de4fa5577343e6065817a
auth/authorityContext.ts           10d209a0ca6a263a21e9e5bdfaa38dda5fb8884b6a524c397e77d0ffcefd0684
auth/mcpBearer.ts                  792fdc39378e07627fee26e0c1c05bafa5efd739f8e33377572006e6a20cd3f8
auth/requestPrincipal.ts           7fbc21d907099b28b2cdc1b09297a5ac141ff9d3504d992201866c525394fa90
auth/delegatedCredentials.ts       aff35559f685c74c5d45f4a3b7409a0123d3cb7245e57c44112697efe21adbb5
services/championRanking.ts         8b5e0d6402f49a83c1467fd0f4ff5d959281dbf797577a64ec88960068430f4e
services/copilotUsage.ts            b1cc91ba541b52bc2f05ed68d7a7fb44a09ec303c5561f776df8c22c6ec3f147
services/copilotUsage.unit.test.ts   629513618429bae59b8cbb2bb0b282b0a046db540ee4a46400c1c0f28daaecdd
services/automaticRefreshIntegration.test.ts fc0c2a5a1a14023458dbb37519f00690193271fb483c74bed5851f7d468c2d74
scripts/local-runtime.tests.ps1     452ab4047510a550360ce29b34d359528dce08ea081ff9b75dbe8b71b9d7c647
```

Backend paths above are relative to `backend/src/` except `scripts/*`, which
are relative to `backend/`; final lifecycle path is repository `scripts/`.

## Proven pre-existing Office residual and live boundaries

Office historical restore is not weakened or silently classified from file
ownership alone. The exact successful phase01 source snapshot image
`agent-control-ltdp-e039ba1aac4f4e5ea23e5a59d6eb1cd4-operator:local`,
`sha256:91d58428403e62dc3732c94bb367cf1965672b3683ce7ab7bd11c43a4ba6a2a4`,
ran the same restore case against isolated PostgreSQL: **2 passed /1 failed /3**,
the identical `OfficeAppAdoptionReads.capture` line73 `selection_invalidated`
from restore test line79 after same-period retention.
The image command was `npm run test --workspace backend --
scripts/largeTenantRestore.test.ts --silent=false`; the control log is
`artifacts/test-scratch/discovery-office-baseline-2.log`. The earlier dependency
baseline had no test sources and therefore supplies no causation evidence.

Unchanged baseline/current hashes:

```text
scripts/largeTenantRestore.test.ts 4d36af1aab3d41cf8270928e5f130b6b12e7ea4d27ebbc427bd51003fd05b01e
src/db/officeAppAdoption.ts        567f8d57e131ea033ed9209eb48cf18f2af8aa129d6dedcdb2be76ca684f4287
src/services/officeAppAdoptionReads.ts 2aaa2834afb7a14e803ce8effd5fca27c65a24dc0e5bff69b757c44c1a6ce1fa
```

### Independently proven pre-auth-repair source-ceiling assertion

The added existing `auth-recovery` selector exposed
`dataGenerations.test.ts:339`: a raw runtime SQL update to a source generation's
`row_count=100001` resolves where the test expects a constraint rejection.
This was not classified from file ownership alone. Exact pre-auth-repair
source image `agent-control-ltdp-5d03ef2beb6940e1992749d48ffc762a-operator:local`,
`sha256:45bd4a37ec1010eaa44618178308c633bfc1e497196686464e3abac2f4c9507c`,
ran only:

```sh
npm run test --workspace backend -- src/db/dataGenerations.test.ts --testNamePattern "reserves the frozen" --silent=false
```

It reproduced the identical line339 assertion: **1 failed /21 skipped /22**,
workload exit1/OOMKilled=False, isolated project
`5649a9bda91f43979993f631becd70a2`. Existing
`Invoke-OwnedFixtureWorkload`/`Remove-OwnedFixture` supplied the same bounded
Compose/PG/resource ownership and cleanup; no runner or guard bypass was added.
Driver `artifacts/test-scratch/discovery-reset-source-ceiling-control.log`.
Unchanged control/current hashes:

```text
src/db/dataGenerations.test.ts bdd7927ccdc3178c795f7dedbb2edf7d475cb0d172e8a9cf9ca9431004bdda92
src/db/currentSchema.ts f2d1d4189ece889534eaf002d50ee623277d12d6600de4fa5577343e6065817a
scripts/largeTenantFixtures.ts e1c68aacb381586500b1caa2f0c2f94edea2d7330ca1afc96b7ccb46b927c135
```

This bounded auth task does not change source-cardinality policy or weaken the
test. Canonical revocation, backdated OAuth, reset, backup and first-entry checks
pass; the unrelated generation-metadata guard remains explicitly owned.

| Residual / scope | Containment and numeric signal | Owner / fix-forward trigger |
| --- | --- | --- |
| Office historical-selection restore after retention | One reproducible restore assertion; pre-phase02 control 1/3 fails. Discovery exposes no Office data and current operator/reset/backup assertions are independently tested. | Existing Office/restore owner; reconcile current same-period retention/observation selection when this historical restore path is exercised. Do not bypass its selection guard or gate safe discovery. |
| Existing source-generation metadata ceiling | One current and one exact pre-auth-repair assertion fail: raw `row_count=100001` update is accepted instead of rejected. Existing service batch/row/byte bounds are unchanged; the reset/auth patch does not alter generation capacity. Signal: any source generation above the intended 100,000-row ceiling or this line339 failure. | Existing generation-capacity/schema owner; reconcile the current database metadata constraint with the supported source ceiling when exercising/expanding this source-capacity path. Preserve the test and real integrity constraints; do not turn it into a discovery sign-in/approval gate. |
| Full-scale search/dept/company/combined-preview query capacity | Accepted 100k/200k/1m fixture; 4/4 first statements cancelled `57014` at the existing 15,000-ms deadline, 0 warmups/0 samples each. No p95/scan/response qualification. Existing bounded inputs/results, actor/privacy fences and SQL deadline remain; there is no unbounded or unsafe fallback. Alert on any discovery `57014`, or per-shape p95 >2,000 ms over >=50 post-warmup requests. | Phase02 query owner/parent fix-forward: obtain non-ANALYZE and safely bounded actual plans at this exact scale, repair observed search materialization/scoped popularity work, then rerun the existing four-shape capacity selector with >=50 measurements each. Phase04 observes real affected-query latency and deadline errors during deployment; this failure is not an application-owned approval/start switch. |
| Bicep/tool availability | No Bicep validation available; phase02 did not alter infra. | Existing infra owner/parent at deployment; run existing validation when protected tooling is available. No new registry probe. |
| Production/Studio/client/provider first-use | 0 live production observations/resets/deployments here; local fixtures/mock providers are not real consent or published-client proof. | Phase04 owns coherent seha API/frontend/MCP deployment, one exact authorized reset and real sign-in/source-rebuild/staff/employee/Studio journeys, preserving settings/secrets/roles/OAuth/volume. |

## Changed/unchanged roots and finalization/handoff

- New phase02 owners/contracts: `backend/src/db/agentDiscoveryQueries.ts`,
  `agentDiscoverySchema.ts`; `backend/src/routes/agentDiscovery.ts`,
  `agentDiscovery.test.ts`, `agentDiscovery.unit.test.ts`;
  `backend/src/services/agentDiscovery.ts`, `agentDiscovery.unit.test.ts`,
  `championRanking.ts`; `backend/src/types/agentDiscovery.ts`;
  `backend/scripts/agentDiscoveryCapacity.test.ts`.
- Reused/modified current owners: backend `app.ts`, schema/current-schema and
  schema tests, official-report query helper, adoption groups/ranking consumer,
  authority/bearer principal/reset fence, existing selected reads, canonical
  source/directory fields, backup/reset operators and tests, existing large-
  tenant selector/tests, users due admission/unit/restart integration;
  repository `scripts/large-tenant-tests.ps1` and `local-runtime.tests.ps1`.
  Documentation: `data-architecture.md`, `user-roles-and-permissions.md`,
  `operations.md`, `mcp-reference.md`, and this exact completion record. Prior phase01 authority/
  source edits in shared files are reused, not reimplemented or claimed anew.
- Phase02 changes backend discovery/API/schema/report/selection/shared ranking
  and fixtures, existing script fixture/reset/lifecycle integration and directly
  controlling data/role/operations documentation. The repair also changes the
  tightly coupled phase01 users retry and real restart fixture, explicitly
  reverified by the final authority run.
- Frontend, MCP, infra and Compose/deployment producers retain the prior phase01
  campaign edits; this phase did not add a browser catalog, MCP business query
  or native public tool. Do not attribute the entire baseline worktree diff to
  this phase. All prior owners/edits remain preserved.
- Final discovery, shared authority and capacity completed with existing
  exact-project cleanup. Final capacity project
  `2db33721b1c34abf84770e05d35e2927` has no remaining container/network/volume.
  Actual receipts were classified above; no active bounded work remains.
  Seha is not owned and its three pre-existing healthy containers remain.
- The bounded reset-auth follow-up also completed both existing selectors and
  the exact pre-repair control with exact-project cleanup. No production,
  phase03 implementation, worker, dependency install or capacity rerun occurred.
  The genuinely signed timestamp/issuer/OBO/account/role consumers are unchanged;
  only actual canonical revocations survive reset in protected storage.
- Removed only this worker's owned `StartupProfileData-NonInteractive`
  ConsoleHost cache (uid501/gid20) and ignored offline-Git build Dockerfile.
  The genuine local restored-tool image remains cached; evidence logs remain.
  Final inspection found zero fixture-prefix containers/networks/volumes.
  All 33 recorded binding/current/control hash entries matched exact files;
  final `git diff --check` passed. Parent-owned manifest was not edited.
- Parent alone advances the manifest. The phase is locally implemented and
  verified with the explicit failed/unqualified scope above, not universally
  green. No further permission/requalification is required to implement phase03
  or deploy safe supported paths under the binding phase04 authorization.
  Parent reconciles the manifest/current shared schema-authority pointers to
  the new 107-table fingerprint and current reset/auth hashes above for phase03,
  preserving earlier phase01 exact-content receipts as historical evidence;
  this worker does not edit those parent-owned records.
- Phase03 consumes the exact method/type/selection/policy map above with opaque
  selections/cursors and immutable actual actor. It owns native initialize/list/
  call/projection and settings serialization; phase04 owns live convergence.
  Missing report/scope and scoped qualification residuals must not become
  application feature/start/manual-sync/acceptance prerequisites.

## Phase 04 owning-contract follow-up

The existing aggregate selector now combines authority, discovery, metadata,
automatic collection, current-schema/reset and backup contracts in one isolated
invocation. Project `563ac25cf7a24b9780e21bd4046fb662` recorded **1,315 passed,
one failed, one skipped**, plus two native metadata-stream uncaught errors.
The sole assertion failure is the already independently baselined historical
Office restore `selection_invalidated`; it is not relabeled as passing.
The metadata-stream owner was subsequently repaired and its **71 focused cases
passed both host Node 24.22.2 and the exact failing Node 24.20.0 fixture runtime**.
The aggregate itself was not rerun or retrospectively declared green.

Current reset **18/18** and backup **4/4** cases passed, including immediate
genuine signed backdated-unrevoked OAuth admission, preserved genuine principal
revocations, interrupted initialization recovery without another reset, and
isolated native PostgreSQL restore with exact schema/count/content checks.
Production was not reset or restored. The schema remains **107 tables,
81 functions**, fingerprint
`78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`.

Knip cleanup removed the unused `discoveryCatalogSql` wrapper, made two SQL
fragments and three internal type aliases module-local, and used the public
`DiscoveryProfile` at its actual producer. Every generated SQL shape/variant
and emitted discovery-service JavaScript remained byte-identical; before/after
proof is under `artifacts/test-scratch/phase04/discovery-*-unused-cleanup.json`.
No query/schema/selection semantics changed. The accepted full-scale
**four 57014 failures, zero measured samples and unknown p95** remain failures;
the large workload was not rerun without a plan-led root repair.
Final source/build identities and all continuation ownership are in
[phase 04](04-verify-deploy-and-observe.md).
