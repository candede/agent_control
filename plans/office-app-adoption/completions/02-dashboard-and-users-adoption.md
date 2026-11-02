# Phase 02 — Dashboard and Users adoption

## Phase Result

**complete_with_risk.** Every owned Office/related-dashboard requirement is implemented and verified: 757 focused frontend tests, all 32 focused desktop/mobile adoption browser cases, and all 32 owned cases repeated inside the full aggregate passed. The full aggregate remains failed outside those owned cases, with exact residuals below. All nine owned fixture projects and 27 image tags are cleaned. Campaign deployment, real-provider first-run and broader convergence are not claimed complete; phase 03 owns those pending actions/proof. No new application authorization or activation gate was introduced.

Worker: `gpt-6.1-sol`, `xhigh`; one worker, no nested agents. Application/repository root: `/Users/candede/repos/agent365/agent_control`. Read the assigned phase, README, skill/design/worker contracts, root instructions, phase 01 evidence and parent campaign state before editing. Preserved phase 01 and parent changes. No commit, push, branch creation, live deployment/reset, package installation or campaign-state edit.

## Implemented

- Dashboard defaults to **Agent adoption**, with explicit bookmarkable **Copilot in Office apps**. Both use the same concrete panel headings, cards, rounded panel styles, observation chart, colors and domain-control interaction pattern.
- Real retained-observation **Active users** and **Active user-app pairs** trends, baseline/previous comparisons and an accessible observation table. Complete history follows every signed page; selected historical observations exclude later points. No interpolated daily events, summed overlapping windows or agent/Office metric substitution.
- Organization-wide People/Apps cards; company-filtered, server participation-ordered department pages and exact department/app links into Office Users. Company changes retain department layout with inaccessible skeleton evidence until replacement arrives.
- Users retains **Users / Adoption**. Its **Agents / Office apps** dropdown is inside the existing Adoption summary row, preserving the actual agent layout. Office includes bounded search, company/department facets, chips, seven-app filtering, five-group numbered pages, separately paginated people and whole-population suggested champions.
- App filters affect people and suggestions, not the group's frozen licensed denominator or full seven-app totals. Unknown is disclosed as a subset of no-recent evidence; participation is a lower bound. Missing observations show Unknown population metrics, not invented zeros; one observation hides only unsupported comparisons.
- Frozen Office person facts open without an agent report, inventory or current profile. Direct bookmarks retain the observation, exact identity and saved group. The optional separate current profile cannot replace historical dates, paid-feature evidence, groups or suggestions.
- Existing `users` publications and selected-read expiry renew automatically. Latest advances; valid historical observations remain fixed. Correction/removal/retention recovery is explicit. Cancellation, stale replies, account changes and denied/inconsistent selections cannot expose accepted stale or mixed evidence.

## Deleted and shared presentation

- Removed the old inline agent SVG implementation in its owning edit; the agent wrapper and Office view now render `DashboardObservationChart`.
- Reused exported `InsightCard`, `DashboardPanelHeading`, `FacetDropdown`, `FilterPopover`, `WorkbenchDialog`, existing counts/dates, selected-read helpers, query client and paging/status controls.
- Extended the existing shared domain-control selectors in `agentWorkspace.css` to Dashboard rather than copying their declarations. Office additions live in the existing `adoptionDashboard.css`; there is no second copied dashboard stylesheet.
- `ReportPageControls` now accepts the structural fields it actually renders, rather than an unused anchor type. Agent paging behavior is preserved.
- No new dependency, aggregate store, generic analytics plugin, polling/provider/scheduler, compatibility route, alias, migration, preference table or runtime approval/activation gate.

## URL, selection, detail and refresh contracts

- `adoption=office` is the sole Office discriminator. `officeSnapshot` / `officeBaseline` are independent UUIDs; existing agent `snapshot` / `baseline` never become Office API parameters. Company/department preserve nullable encoded values, app uses the seven-app catalog, search is bounded, Office group `page` is numbered.
- Reader-personal Office navigation is shared through the existing Dashboard/Users route states and remembered searches. Valid pins survive Back/Forward, links, reload and domain changes. Incompatible filters/paging reset intentionally; account cleanup removes private source/person fields.
- Valid agent snapshot/baseline choices travel as inert navigation metadata through Office hard links. A UUID `snapshot` carried on Dashboard remains inert even after Latest Office changes back to Agent adoption; it never filters agent Dashboard history. Ordinary agent Dashboard baseline navigation still produces the existing plain Users URL. Personal-report changes update already-existing latent Office navigation, not a new preference owner.
- One source-specific Office owner captures context per active query/principal. Every summary/history/page/facet/person read carries the identical normalized Office query and selection ID; selected context/observation/baseline metadata is checked before acceptance.
- Renewal retains readable same-observation data and the last validated group anchor. Explicit numbered navigation clears anchors. Complete history rejects inconsistent counts, duplicates, later points, non-advancing pages and incomplete results through the existing selected-read withdrawal policy.
- Direct person lookup follows bounded 100-person pages of the existing group API until the exact frozen identity is found. This is necessary because phase 01 intentionally has no separate person endpoint; no guessed current-profile prerequisite or duplicate backend owner was added.
- Frozen and current details are separate dialogs. Native Escape/focus restoration, selected/pressed controls, accessible headings/statuses and disabled-during-renewal actions are verified.

## Changed files and cross-root impact

**Frontend runtime:** `App.tsx`, `workbenchRouting.ts`, `useOfficeAdoption.ts`, `officeAdoptionTrends.ts`; `AdoptionDashboard`, `DashboardInsights`, `DashboardObservationChart`, `CopilotUsersView`, `AdoptionView`, `ReportPageControls`; new `OfficeAdoptionDashboard`, `OfficeAdoptionView`, `OfficeObservationContext`, `OfficeFacet`, `OfficeAppBreakdown`, `OfficePersonDialog`; existing `adoptionDashboard.css` and `agentWorkspace.css`.

**Frontend tests/fixtures:** `workbenchRouting.test.ts`, `test/appSessionCases.tsx`, `test/officeAdoptionFixture.ts`, `useOfficeAdoption.test.tsx`, `officeAdoptionTrends.test.ts`, the two Office component test files; existing `browser/adoptionDashboard.spec.ts`, `browser/adoption.spec.ts`, `browser/permissionFixtures.ts`.

**Backend fixture:** existing `backend/scripts/browser-fixture.browser.ts` gains isolated Office tenant/source fixtures and canonical-count checks. No phase 02 backend runtime/API/schema change. Phase 01 types, routes, lifecycle/publication owner and typed transport are consumed unchanged. Its `UserDetailModal` catalog change is preserved and reused, not claimed as a new phase 02 edit.

**MCP:** inspected `mcp/src/agent_control_mcp/tools.py`'s `list_adoption_groups`, `list_adoption_facets`, `list_champion_agents` producers/consumers. They still use existing agent adoption routes/types; Office UI state does not alter their API/report-selection meaning. No MCP change is required or claimed.

**Deployment/tooling:** used existing `large-tenant-tests.ps1` / lifecycle / fixture-diagnostic owners without adding a runner or changing deployment settings. No phase 02 deployment/feed/schema-owner change. Root `.npmrc` / Docker registry policy and four approved baseline manifests remained aligned. Phase 03 owns reset/deployment/capacity/real-provider convergence.

**Documentation:** Office UI/navigation/details/publication sections in `docs/copilot-license-usage.md`; this exact completion record. Parent campaign state remains untouched.

## Design and autonomous decisions

Falsifiable slices were checked before aggregate qualification:

1. Routing/typed owner tests disprove mixed Office/agent pins and mismatched contexts. Missing remembered Dashboard state was repaired by overlaying current Office navigation, not by adding another persistence layer.
2. Existing named agent chart/card tests validate the concrete extraction. Screenshot inspection found that Dashboard's new domain controls were outside the old scoped CSS; extending the shared selectors fixed genuinely indistinguishable buttons.
3. Group/person tests verify stable complete counts and suggestions on later pages. A dedicated owner test verifies renewal through the last validated anchor instead of page-one reset.
4. Incomplete history is an invalid selected read: counts are withdrawn explicitly, not accepted as a partial trend. This follows the repository's existing integrity policy rather than inventing a separate Office error policy.
5. Actual browser/SQL results established the backend's group and lexical person ordering. Tests now wait for the real last page and use its Person 6; they do not reorder the API or trust pending placeholder rows.
6. A new regression falsified Latest Office → Agent → hard-reload retention of an independent agent snapshot. UUID navigation metadata and the existing personal-report producers were completed together. Invalid old Dashboard snapshot text remains ignored; agent history metrics and ordinary default URLs are unchanged.
7. Aggregate attempt 09 exposed the combined real-SQL visual/history/person journey's 20-second case-budget failure under load. Separated its complete three-width SQL visual/accessibility assertions into another case in the same spec; retained every assertion and the historical/navigation journey. No timeout or diagnostic was relaxed. Current focused execution verifies both bounded slices.

## Exact validation commands and environment

Local macOS; host Node `24.18.1`, npm `11.16.0`, PowerShell `7.6.6`; owned arm64 browser container Node `24.20.0`. Existing dependencies only. No public/default registry or external deployment used.

```bash
npm test --workspace frontend -- src/components/AdoptionDashboard.test.tsx src/components/DashboardInsights.test.tsx src/components/AdoptionView.test.tsx src/components/CopilotUsersView.test.tsx src/adoptionTrends.test.ts src/useAutomaticRefresh.test.tsx src/components/OfficeAdoptionDashboard.test.tsx src/components/OfficeAdoptionView.test.tsx src/useOfficeAdoption.test.tsx src/officeAdoptionTrends.test.ts src/workbenchRouting.test.ts src/App.session.test.tsx src/useReportPage.test.tsx src/components/UserDetailModal.test.tsx src/api/officeAppAdoption.test.ts
npm run typecheck --workspace frontend
npm run lint --workspace frontend
npm run build --workspace frontend
npm run typecheck --workspace backend
(cd frontend && npm exec --offline -- eslint browser/adoption.spec.ts browser/adoptionDashboard.spec.ts browser/permissionFixtures.ts)
git diff --check
```

Final focused result: **757 passed / 15 files**. Actual discovered file counts: App session 207; report paging 130; Copilot Users 120; current user detail 57; agent Adoption 29; agent Dashboard 29; Dashboard Insights 14; automatic refresh 69; routing 65; agent trends 14; Office owner 9; Office Users 7; Office Dashboard 4; Office trends 1; existing Office transport 2.

Evidence: `artifacts/office-phase02-final-focused.log`, `office-phase02-final-test-discovery.json`, `office-phase02-final-navigation.log`, `office-phase02-final-checks.log`. After the final browser owner exited, the combined 757-case command and all listed typecheck/lint/build/fixture/diff commands were run again and passed. The rebuilt JS/CSS names and content remain identical to the actually HTTP-served browser artifact. Vite's existing >500-kB chunk warning remains visible; it was not suppressed and no chart dependency was introduced.

The actual final browser command is:

```powershell
pwsh ./scripts/large-tenant-tests.ps1 -Suite browser -BrowserFiles 'adoptionDashboard.spec.ts,adoption.spec.ts' -BaselineImage 'agent-control-office-adoption-baseline-4b34cc5b:local' -BaselineImageId 'sha256:3f334d1f5324d9655f94cf4c0f0617d71e8a1c37c1b138f8bebe44783fbd50be'
```

The existing owner verifies all four manifest hashes, protected browser image `sha256:b4eda044a9e58194703b1aa3e3209d3a7ea9cc219f9df14d36d418db873bb60b`, equal arm64 architecture, internal network and no published host ports; builds current images offline; runs focused and full desktop/mobile browser passes; owns diagnostic capture/database/resource cleanup.

**Final focused browser:** **32 passed / 32 discovered, zero skipped/flaky/unexpected**: six Office cases plus ten existing agent Adoption/Dashboard cases, each in desktop and mobile. Discovery: `artifacts/office-phase02-final-browser-discovery.json`. Real SQL Viewer, historical/frozen/current-person, separate complete three-width SQL visuals, zero/one observations, unknowns, long names, paging, app filters, direct links, reload/Back/Forward, invalid pins, Latest/Agent latent pins, keyboard/focus, idle renewal and accessibility assertions passed.

**Final aggregate browser: failed**, not waived or relabeled:

| Project | Discovered | Passed | Unexpected | Skipped | Flaky |
| --- | ---: | ---: | ---: | ---: | ---: |
| Desktop | 429 | 384 | 41 | 4 | 0 |
| Mobile | 429 | 375 | 41 | 13 | 0 |
| Total | 858 | 759 | 82 | 17 | 0 |

Both projects completed their JSON reporters inside the existing owner bounds. All **16 owned cases per project** passed, including the repaired real-SQL visual and historical/person/navigation slices. Desktop duration: 849,045 ms; mobile: 736,586 ms. The owner exited **1**, `OOMKilled=False`. Its two aggregate wrapper assertions failed on the real nonzero browser exits; the separate native persistence/restart assertion also failed: **seven**, not **nine**, responses, with active users one. This is actual fixture/readback evidence, not an external-provider excuse.

Raw results: `all/desktop/permission-browser-results.json` and `all/mobile/permission-browser-results.json` under the final evidence root. `artifacts/office-phase02-final-aggregate.json` contains every unexpected case/file/line/project/error, every skipped case and all owned statuses; `office-phase02-final-aggregate-desktop.json` preserves the independently inspected complete desktop result. The 17 skips do not establish those workflows as passed. The residual table below applies to every listed failing/skipped scope.

## Artifact and source identities

Final owner/project: `agent-control-ltdp-ae74f964684c4336ac0471259d8393f8`.
Evidence root: `artifacts/large-tenant-data-platform/ae74f964684c4336ac0471259d8393f8`; command log `artifacts/office-phase02-browser-10.log`.

- Qualification image: `sha256:85d052c6bca5a9841264bb637c6732b27f1f9eba2a382e6733f1f585870e01e7`.
- Permission-browser image: `sha256:cbafbface6c08939b1f97333bbb0d2b2b048a4391a5e2b43d88a6e5e6320e351`.
- Runtime image: `sha256:20b8ef6a63dd455731319a8120ae08e4b533d5a4fe1635e9748ed9ff4499e708`.
- 807 backend/frontend fixture/runtime/test source files in the final image match current source exactly: aggregate SHA-256 `806741f41d3af59e0b879f327e72783f347930a36ff0f4240a0d5a0eba177d90`.
- Wider 827-file source receipt, including unchanged MCP source: `7c2827ef1c20bcfc2aa7bc0ae4e0fcb72144736743c7d90adc36e6ef544b4555`. Both source fingerprints use SHA-256 of JSON-serialized ordered `{path,sha256}` records, stated in the receipts.
- Actual internal HTTP returned 200 and served the image's identical current local-build assets: `index-CRoMXZli.js` (1,008,063 bytes), SHA-256 `077caa022887edf472051bfc211d759f93808fda6ffc4bb8540b1ee07473b7f2`; `index-BSfWtEgs.css` (165,029 bytes), SHA-256 `6fd40855da217cd487445dd7e3613da0f09735430b99eb45ee34bcf4b866aa66`.

Receipts: `images.json` in the final owner evidence root, `artifacts/office-phase02-final-source.json`, `artifacts/office-phase02-served-artifact.json`. The syntax-checked receipt helper was deleted after verification.

Phase 01's schema fingerprint `05d36a05ce28de5573541ad107788edaab862688d70ae86ff7de83a9f101a0fc` is prior owning evidence, not a newly rerun phase 02 SQL aggregate claim.

## Browser fixtures, repairs and visual proof

The existing disposable owner seeds two distinct synthetic Office tenants, 60 paid people, seven groups (54 Engineering people), three canonical observations with active users 20/30/40 and user-app pairs 52/72/92. Latest source names/groups differ from historical facts. App breadth 7/6/5 gives real server-ranked suggestions; missing/future/older evidence supplies genuine unknown/no-recent cases. Office tenants have no agent reports or inventory. No synthetic auth/users/reports enter `seha`.

The fixture preserves these saved synthetic publications rather than invoking live providers. Thus this is real packaged frontend → authenticated HTTP → canonical SQL proof, **not** real-provider first-run/reset/deployment proof. Existing first-sync notice is dismissed with its ordinary **Continue to workspace** action after Users is saved while the two inventory sources remain unsaved; no manual-start, import or new enable prerequisite is introduced.

Attempts and factual repairs:

| Attempt | Exact owner suffix | Focused outcome / reason |
| --- | --- | --- |
| 01 | `dbb4d280fb4141939bb7516763aaec4e` | Setup failed before discovery: three requested observations produced only two; repaired fixture dates to the existing three-day freshness boundary and asserted canonical counts at every point. |
| 02 | `67dc6569dfd9401a81fb0c812e0e62c5` | 24 passed, four failed / 28. Repaired real agent summary layout and incorrect first-group-order assumption. |
| 03 | No project created | Mistyped baseline identity rejected by the explicit preflight guard; no qualification claimed. |
| 04 | `86fbc144ac1c43ab84bfce8035073447` | 26 passed, four failed / 30. Repaired ordinary-agent baseline leakage; followed existing first-sync dismissal instead of clicking through an overlay. |
| 05 | `91cf5932e2464e9bb1a6e8a00114fdc9` | 28 passed, two failed / 30. Fixed the lexical last-person-page expectation and waited for the actual page, not placeholder Person 54. |
| 06 | `d4319b41ae984265b0ee19d1558733ea` | 30/30 passed; subsequently superseded by actual shared-control styling and first-use fixes. |
| 07 | `6b2249655e674bfcb93dddd27a7de553` | 30/30 passed, including visible shared selected-state styles; superseded by missing-observation and Latest latent-pin completion. |
| 08 | `7f365d72784f4c9da192494ec69269a1` | 30/30 passed, including working zero/one Office states; superseded by the final Latest hard-reload pin contract. |
| 09 | `1ea3a241222447818e8067f9ef326bb6` | 30/30 focused passed. Aggregate desktop incomplete: 371 passed, 34 failed, four skipped in 409 observed events / 428 discovered; existing wrapper timed out at 900,000 ms. Its combined SQL Office journey failed the existing case budget; mobile's five Office cases passed. Mobile aggregate: 374 passed, 41 unexpected, 13 skipped / 428. Native persistence assertion failed: seven rather than nine responses. Repaired the owned long SQL case by retaining all assertions in two bounded slices. |
| 10 | `ae74f964684c4336ac0471259d8393f8` | Current exact source: 32/32 focused passed and all 32 owned aggregate cases passed. Complete desktop: 384 passed, 41 unexpected, four skipped / 429. Complete mobile: 375 passed, 41 unexpected, 13 skipped / 429. Overall owner/native persistence remain failed; all owned resource/image cleanup complete. |

Earlier aggregate failures were retained, not converted into passes. Attempt 02 desktop: 380 passed, 43 unexpected, four skipped / 427; mobile: 371 passed, 43 unexpected, 13 skipped / 427. Attempt 04's desktop completed; its mobile aggregate did not finish within the owner deadline. Runs overlapped during iterative repairs on the shared Docker engine; this is a limitation of that evidence, not an external-provider excuse. After final-source focused qualification, only superseded 06–08 workload containers were stopped using exact image/project/mount safeguards; their existing monitors preserved partial diagnostics and performed cleanup. Those aggregates are incomplete, not passed.

Attempt 09's structured observed events, every mobile unexpected case and error, and all owned-selector statuses are retained in `artifacts/office-phase02-aggregate-09.json`. Its actual JSON reporter result exists for mobile only; desktop is explicitly incomplete, not a fabricated 428-case result. The inspected ordinary-agent organization-link mismatch involves the same `handleUsersRouteChange` personal-pin override present in HEAD, but no unchanged-HEAD full browser baseline was run and the broader failures are not claimed pre-existing or external.

Visual inspection—not only element presence—confirmed the actual rounded blue/teal/purple/gold panels, blue active-user and purple user-app-pair observation lines, white selected domain control, complete seven-app counts and frozen-context disclosures. Verified 360/760/1440 document widths with no document horizontal overflow, native keyboard/pressed/selected states, Escape/focus return, long organizations, readable responsive cards, accessible chart/table/status semantics and zero scoped axe violations. Tables retain their existing keyboard-accessible internal scrolling rather than overflowing the page.

Final captures are under `focused/playwright/` in the final evidence root: `office-dashboard-{1440,760,360}.png`, `office-groups-{1440,760,360}.png`, `office-partial-long-{1440,760,360}.png`, and `office-first-use.png`, in both configured projects. Real SQL screenshots establish measured values; mock-response captures establish layout/navigation/loading/error behavior and are not substituted for SQL/provider counts.

## Cleanup, residuals and next preconditions

The nine exact disposable browser projects above (all except preflight attempt 03) are this worker's resources only. **All nine owners and exact image cleanup are complete:** zero fixture database connections/remaining databases, zero project containers/internal networks/volumes and **27 exact tags removed**, recorded in `artifacts/office-phase02-owned-image-cleanup.json` and each project's `database-cleanup.json`/`result.json`. Image tags were removed only after owner completion, zero project resources, no using container and equality with each `images.json` ID. Both protected baseline tags/IDs were reverified unchanged. Evidence stays in repository `artifacts/`; scratch helpers are deleted. No owned service/helper remains active. No prune, broad deletion, name-based process killing or live resource mutation.

`seha` app/postgres, `seha_data`, database `agentcontrol`, loopback `http://localhost:3002`, configured public/auth origin `https://mgzftq2n-3002.euw.devtunnels.ms`, settings/secrets and unrelated services remain untouched.

### Residual handling — no new runtime authorization

The final case inventory is persisted in `artifacts/office-phase02-final-aggregate.json`. The following scope/containment/signal/threshold/owner/fix-forward rules classify every observed failing/skipped aggregate scope and the explicitly future-phase proof. These existing controls do not prove a failing workflow correct; no new feature restriction, canary approval or manual-start step is claimed as containment.

| Residual scope | Actual existing containment and signal/canary | Numeric threshold, owner and exact fix-forward trigger |
| --- | --- | --- |
| Agent catalog/detail/cohort/person/organization navigation (`agentActivity`, `agentCatalog`, `agentExperience`, `agentPeople`, `agentResponsibility`, `userDetails`) | Existing authentication, read policy, provider checks and selected-read validation remain. Office read ownership is separate. Retained browser errors expose unexpected requests, unreachable controls and wrong URLs; normal Agent → person → organization navigation is the canary. Correct UX is not proven by those controls. | Any **one** reproducible current failure or wrong source pin triggers phase 03/parent repair of the implicated current producer/consumer and focused rerun. The observed organization-link override is also present in HEAD; do not invent compatibility or alter report-selection meaning solely to satisfy a stale expectation. |
| Agent/Users publication, cache, idle report choices, CSV/source-dependent metrics (`automaticRefresh`, `cacheNavigation`, `copilotUsers`, `csvUsageReports`, `layout`) | Existing publication signal, selected-read expiry/withdrawal and explicit unavailable/error states remain; no extra polling/cache owner was added. Existing request diagnostics, exact read-count assertions and measured metric/URL assertions are the signals. | Any **one** wrong metric/pin, cache two-frame canary failure, or excess read over the named test's bound triggers phase 03/parent contract/fixture diagnosis and fix-forward. Attempt 09 observed, for example, **11** report-option reads where **2** were expected; it is not called a pass or external limitation. |
| Permission/setup/progress/layout and real fixture collection/lifecycle (`appStyles`, `dataSync`, `modalLayout`, `permissions`, `savedBackendLifecycle`) | Real role/provider/destructive/data-integrity checks stay enforced. Existing `request_rejected`/HTTP diagnostics and UI error/setup statuses expose actual **400/401** responses; source status and saved-read lifecycle cases provide canaries. The unchanged original login guard admits generic `lifecycle.example.invalid` but rejects configured desktop/mobile running/failed identities; this is a concrete fixture-contract defect, not a provider outage. | Any **one** rejected supported fixture identity, failed ordinary authorized setup/collection, missing saved publication or layout/control failure triggers phase 03/parent current-contract repair and exact rerun. Align fixture identities with current configured tenants rather than adding aliases or bypassing the real controls. |
| Retired `/jobs` expectations (`jobs`) | Canonical Sync navigation remains supported; no compatibility redirect/duplicate Jobs dashboard was added. Exact bookmark/URL browser assertions expose the obsolete-path discrepancy. | **One** retained obsolete consumer/test expectation triggers phase 03/parent removal/update to canonical Sync behavior. Do not restore a forbidden compatibility alias. |
| Aggregate completeness and native restart/provider counts | Existing 900,000-ms workflow and 30-minute owner bounds, workload exit/OOM diagnostics, signed source reads and normal cleanup contain execution/resource exposure, not incorrect application behavior. JSON reporters, actual case events and native SQL/readback assertions are the signals. | Any **one** unexpected case, missing reporter, unobserved case or native-count discrepancy triggers phase 03/parent targeted repairs and aggregate rerun. Attempt 09 desktop had **19** unobserved cases; native readback returned **7**, not **9**, responses. Never manufacture aggregate counts or relax global timeouts/assertions to obtain a pass. |
| Nonfatal JS chunk warning | Current single shared chart/style implementation and existing dependencies avoid a second library/duplicated dashboard. Existing build warning and actual browser navigation/interaction tests are the available signals; no new performance-monitoring service is claimed. | Current JS is **1,008,063 bytes**, exceeding the existing **500-kB** build warning. Phase 03 owns measured performance/fix-forward if **one** reproducible affected navigation/interaction case times out or exceeds its existing assertion bound; this warning alone is not runtime authorization. |
| Real-provider first run, reset/deployment, capacity/recovery and full frontend/backend aggregates | These are explicitly phase 03's authorized actions, not performed or accepted here. Existing source status/publication metadata, HTTP logs and ordinary signed-in Dashboard/Users journeys are the canaries; authentication/provider controls and explicit unknown evidence remain. The disposable seeded source proof is not substituted for a live provider. | Phase 03/parent owns mandatory attempts. **One** complete automatic Users publication containing required Office evidence without a valid Office observation, **one** accepted mixed/invalid selected read, or **one** failed affected ordinary journey triggers current-code fix-forward. Specific genuine provider limitations remain honestly reported. Later fix-forward omits `DbReset`; an uncertain reset is inspected, not replayed. |

**Decision Needed:** none for the owned implementation. The parent must carry the exact non-passing broader evidence into phase 03 and coordinate any earlier-owner repairs; this worker does not edit campaign state or presume user acceptance.

### Parent integration repair

Parent review found that complete-history validation rejected duplicate IDs across pages but could accept duplicate IDs within one page, or two IDs representing the same canonical provider refresh date. The parent repaired the existing history owner directly: each accepted point now checks both immutable ID and provider date against the accumulated sets before admission. There is no new runner, abstraction, evidence store or runtime gate.

Added four regression cases covering duplicate identity/provider date within and across pages, including withdrawal of dependent summary facts. Newly run checks:

- `npm test --workspace frontend -- src/useOfficeAdoption.test.tsx src/components/OfficeAdoptionDashboard.test.tsx src/components/OfficeAdoptionView.test.tsx`: **passed, 24 tests / 3 files**.
- `npm run typecheck --workspace frontend`: **passed**.
- `npm exec --offline --workspace frontend -- eslint src/useOfficeAdoption.ts src/useOfficeAdoption.test.tsx`: **passed**.
- `git diff --check`: **passed**.

These checks repair the concrete malformed-history case; they are not a new full-aggregate/browser pass. The earlier browser/source/artifact identities remain historical evidence for their exact revision, not the parent's modified owner. Phase 03 must rerun the combined browser owner against the stabilized current artifact, preserve all 82 broader failures/17 skips until diagnosed, and update this record with current identity-bound proof. No user-visible metric, valid observation/navigation flow or approved boundary changed.

Phase 03 may rely on the concrete UI/API/URL contracts and current focused SQL/browser evidence, **not** an aggregate/live/capacity acceptance claim. It must complete current full aggregates, capacity/recovery checks, authorized database-only local-development reset/deployment, ordinary sign-in source/Office convergence before CSV import and actual affected user journeys. Non-passing preproduction evidence is not a new runtime or deployment authorization gate; fix-forward after a deployment omits `DbReset`.

### Phase 03 coupled UI/harness addendum

Phase 03 measured the accepted-person path and removed its unnecessary scan from
the beginning of a large group. Opening accepted frozen facts now requires the
same principal, observation, query, identity and group plus a validated current
Office selection. Direct bookmarks retain bounded fallback. A regression opens
the accepted 100,000th identity with **zero people requests**; the existing
late-page browser journey also records actual open time/request counts. These
are not claims of a live 100,000-person browser tenant.

The shared personal report owner stays authoritative: organization/agent links
preserve a reader's explicit pin and do not synthesize one from a Latest read.
The directly coupled producers, Users/agent-detail consumers and Latest/pinned
regressions now agree with that owner. Default Agents reporting remains separate
from Office; invalid evidence still withdraws under existing selected-read
guards.

Required fixtures now use the configured lifecycle identities, application
package collection and current creator lookup (`graph.users.read`, not the
administrative group lookup), selected usage context, coherent report IDs and
revisions, canonical Sync routes and automatic bounded About continuation.
Superseded tests expecting no personal snapshot after an explicit selection,
every retained report row to be the sole current row, or an unused delegated
readback to stand in for application collection were repaired from the current
canonical input/contracts; no runtime compatibility alias was added.

Current focused verification passed **286 tests / 6 files** (Office hooks,
dashboard/view and the directly coupled Users/detail/report owners), plus
separate fixture checks, frontend typecheck/lint, unused-code and diff hygiene.
The original 32 browser cases and failed 82-case broader aggregate/native
readback above remain historical until phase 03's current combined owner
supplies its exact receipt. Deployment/live evidence remains parent-owned.

### Current aggregate fixture-contract repair addendum

The initial phase 03 infrastructure-free frontend aggregate failed **7 / 5,559**
cases in three files; no baseline correctness was assumed. Its actual contracts
require Admin for the Manage history tab, a separate unfiltered organization
summary request, and the real saved QueryClient provider for query reuse.
The corrected fixtures preserve role denial and exact summary/row call counts,
sorting, focus, facet normalization and bounded cache assertions. Affected
focused verification passed **353 / 3 files**
(`artifacts/office-phase03-frontend-coupled-02.log`).

The required native recovery fixture now faithfully includes provider-native
identifiers and the real service's existing `settleControls` after verified
readback. It explicitly proves current-source withdrawal before settlement,
restoration afterward, and both original inter-item lease/recovery outcomes;
no production dispatch guard was weakened. This and other coupled backend
fixtures passed in current **945 / 20-file** SQL qualification
(`artifacts/large-tenant-data-platform/430c543eeb084af491d11049ed4885da`).
Final current full frontend and combined desktop/mobile browser receipts still
belong to phase 03, not the superseded 32-case/82-failure history above.

### Phase 03 same-contract large-group paging

`OfficePage`/HTTP/typed frontend request contracts remain unchanged. Current
SQL **947 / 20 files** and scale **89 / 2 files** prove full group denominators,
server champions and every 100,000-person fixture identity. The existing
`useOfficePage.next()` cursor input now seeks the indexed canonical label/exact
identity and reuses authenticated frozen counts; ten numbered deep links retain
counting/offset behavior. Large-department paging measured **6,936.55ms** rather
than materializing its 99,000 people in the browser. Accepted frozen person
opening remains guarded/no-rescan. Source/current coverage, agent report pins
and selected Office context ownership are not merged. See phase 03's exact
current scale root `95802f940e124d74a8c1ab762b0b2608`; current full software,
browser/native and compiled fresh receipts must be appended there.

The first current browser run measured a legitimate limit-50/page-2 listing
renewal when a Latest person link became an explicit frozen snapshot bookmark;
it was not a person fallback. The new assertion now requires exactly that
same-page pinned-context request and no additional scan, preserving frozen
facts/counts/latency. Current component/hook regressions **32 / 3 files** prove
zero person-fallback reads, cursor-based group Next/Previous with controlled
page-number admission, numbered jumps and new-observation page/authority reset.
The same-observation pin keeps the people position. No second context/cache
owner or endpoint was added; final browser/compiled receipts remain phase 03.

### Phase 03 shared presentation and current verification contracts

The current personal report selector preserves only its validated choice strings
during a pending minute recapture, with the control disabled. It does not retain
option authority, extend a lease, infer a pin or cross account/role/selected-report
scope. Ten separate minute captures for Latest and explicit pins now have focused
regressions; the coupled Office/history/reported-user scope passed **152 / 5files**
at `artifacts/office-phase03-shared-context-06.log`.

Current browser verification preserves the separate unfiltered licensed summary
and searched listing renewal requests, and coherent automatic Users/report
metadata. Both reported-person organization links now pass their exact source,
route, focus and no-write assertions. Current Permissions is inline evidence,
including long notices and reachable recovery; obsolete dialog CSS/fixture
aliases were removed. Its independent gutter test is registered at top level.
First-Agent scenarios now use two fresh exact synthetic profiles in the existing
disposable owner, not the seeded Office profiles whose automatic refresh is
deliberately suppressed for frozen-evidence fixture reads.

The existing protected current focused browser owner passed **143 / 152 cases**
for styles/layout/modal gutters and **146 / 154 cases** for automatic refresh,
Users, Permissions and person navigation. Remaining skips are nine mobile
duplicate viewport/density cases (the desktop project runs the complete width
matrix) and eight deliberately deferred Security/investigation/Purview/Defender
cases. The nine are not serial-failure fallout. Skipped cases are not passed.
Exact roots/commands/failed repairs are preserved in phase03.

The current full browser03 desktop passed425cases with4intentional skips.
Mobile had415passes/1Office assertion race/13intentional skips. The fixture now
awaits its exact mandatory repinned listing request before checking its count,
including that wait in the unchanged5-second opening bound. No runtime repair,
request suppression or weaker no-scan assertion was introduced for that race.
Current compiled fresh05 and nonempty restore04 passed; the final combined
browser/software receipts and all parent deployment/live proof remain phase03.

### Phase 03 final current-source/shared-presentation addendum

The selected report's exact outside-page annotation also survives pending minute
recapture as validated disabled choice text, not retained option authority.
Its third ten-capture regression brings the directly coupled Office/report/
history/person scope to **153/5files passed**. Independent current full frontend
passed **5,564/128files**; mandatory CheckOnly06 separately passed the same full
frontend and backend9,373/292files, four steps total. These current receipts
belong to phase03; no phase02 historical pass/failure was rewritten.

Final source manifest:
`fdc06bd67161b219c5e356e2a10ecc995709f6f16552611c5b11ca0ca7aaf118`.
Compiled fresh06 uses the exact same1,021common source inputs and serves
`/assets/index-DQUoO3Ix.js` with SHA-256
`148e4cdeb37c3100caec43136ce40abbe852aa2f6b3618cd2c98cbb978f68795`.
Final nonempty restore05 and fresh06 passed; the existing final combined
browser owner qualifies this stable candidate, including the unchanged5second
accepted-person opening budget and exact single same-page repinned request.
Parent-owned deployment, ordinary real-provider/browser first-run and at least
ten-minute observation remain pending; neither compiled fixtures nor healthy
endpoints substitute for them.

Final current Browser04 passed **32/32focused Office**, all32owned Office cases
inside **841passed /17intentional skipped /0unexpected /0flaky of858**:
desktop425/4skips, mobile416/13skips. Native restart/readback9responses/
1active user/2writes passed unchanged. Accepted-person attachments measured
127.003ms desktop/178.003ms mobile in the aggregate, including exactly one
repinned limit50/page2 listing and no fallback scan, under the unchanged5s
opening bound. Phase03 owns root `daa929cb5ca04d98b71996f2a6d7d459`, final
guarded zero-resource/tag cleanup and deployment_pending parent continuation.
Earlier failed aggregate/native evidence was not relabeled as passed.
