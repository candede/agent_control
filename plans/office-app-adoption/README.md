# Office-app adoption

## Goal and approved decisions

Give the Dashboard two familiar views: **Agent adoption** (the current default) and **Copilot in Office apps**. Give **Users > Adoption** an **Agents / Office apps** dropdown while preserving the existing Users / Adoption page controls.

The two dashboards must look and behave like related views of the same application, not separate products. Semantic accuracy takes precedence over relabeling an agent metric as an Office metric.

Decisions approved during planning on 2026-10-31:

| Decision | Binding choice |
| --- | --- |
| Office scope | Word, Excel, PowerPoint, Outlook, OneNote, Loop, and Teams. Exclude standalone Copilot Chat, Edge, and agent activity from Office totals. |
| Population | Saved people with verified active paid M365 Copilot features, using the existing paid-entitlement classifier. |
| History | Automatically retain real Office observations, with compact per-person evidence and saved paid/group context for historical drill-down. |
| Retention | Twelve calendar months of Office observations. Do not change agent-report retention. |
| Champions | Up to three potential Office champions per company/department, ranked by recent app breadth, then recency. These are suggestions, not assigned roles or volume/productivity rankings. |
| Users navigation | Keep Users / Adoption controls. Add a domain dropdown within Adoption; Agents remains the default. |
| Cumulative meaning | Aggregate within the selected report observation/window. Never sum overlapping observations or infer lifetime activity. |
| Schema transition | Current-schema clean reset, not migrations, compatibility routes, or an old/new dual implementation. |
| Execution boundary | Local development, isolated validation, and local deployment. The user explicitly authorized deleting, overriding, and resetting local development installations, including the currently running instance. |

The inspected local application is Compose project `seha`, Docker context `desktop-linux`, app origin `http://localhost:3002`, services `app` and `postgres`, application database `agentcontrol`, and project data volume `seha_data`. These are deployment identities to reverify, not permission to trust stale container IDs. Other projects and unrelated services are out of scope.

## Ordered implementation manifest

Read this README and the current installed `implement-folder` design/execution and step-worker contracts before each phase. The repository root is the directory containing [package.json](../../package.json); backend, frontend, MCP, and deployment tooling are implicated application surfaces in this one repository.

| Order | Prompt | Outcome and owner | Prerequisite | Exact completion record |
| --- | --- | --- | --- | --- |
| 01 | [Office evidence and adoption API](01-office-evidence-and-adoption-api.md) | Backend: retained observations, lifecycle, paid/app calculations, bounded selected-read APIs, and related data documentation | Approved decisions above | `completions/01-office-evidence-and-adoption-api.md` |
| 02 | [Dashboard and Users adoption](02-dashboard-and-users-adoption.md) | Frontend: related dashboard layouts, domain/context navigation, grouped Office adoption, historical drill-down, and UI documentation | Phase 01's implemented typed API and factual completion record | `completions/02-dashboard-and-users-adoption.md` |
| 03 | [Verify and deploy locally](03-verify-and-deploy-local.md) | Campaign parent/final worker: aggregate verification, authorized local reset/deployment, real first-run journeys, observation, fix-forward, cleanup, and handoff | Implemented phases 01 and 02 with attempted checks and explicit residuals | `completions/03-verify-and-deploy-local.md` |

Only these three linked prompts are executable phases. This README and future completion records are not phases. Do not create speculative completion records. Campaign orchestration state belongs in the execution skill's campaign-state location, not another implementation prompt.

## Current implementation and evidence

- [AdoptionDashboard](../../frontend/src/components/AdoptionDashboard.tsx) and [DashboardInsights](../../frontend/src/components/DashboardInsights.tsx) render agent-history trends, company/department adoption, people engagement, agents, and champions.
- [adoptionHistory](../../backend/src/services/adoptionHistory.ts) calculates retained **agent-report** observations. Its dates, response totals, and agent identities do not establish Office history.
- [CopilotUsersView](../../frontend/src/components/CopilotUsersView.tsx), [AdoptionView](../../frontend/src/components/AdoptionView.tsx), [adoptionGroups](../../backend/src/services/adoptionGroups.ts), and [adoptionDepartments](../../backend/src/services/adoptionDepartments.ts) implement the existing grouped agent view.
- [userSourceGraphFields](../../backend/src/services/userSourceGraphFields.ts) requests the current Graph v1.0 `D28`/`v2` report and projects its date columns. [CopilotAppActivity](../../backend/src/types/copilotUsage.ts) and [userSources](../../backend/src/db/userSources.ts) expose per-app last-known dates, exact identity matching, paid features, and freshness.
- [UserSourceStages](../../backend/src/db/userSourceStages.ts) publishes directory and app evidence independently, sometimes retaining unseen rows with their original evidence dates. [DataGenerations](../../backend/src/db/dataGenerations.ts) replaces current source heads; those heads are not a retained Office observation catalog.
- [Publication revisions](../../backend/src/db/inventoryAutomaticRevisions.ts) and [automatic refresh](../../frontend/src/useAutomaticRefresh.ts) already notify readers through the `users` revision. [Selected-read root types](../../backend/src/services/dataSelections.ts), [DDL](../../backend/src/db/currentSchema.ts), and [backup table keys](../../backend/scripts/backupInventory.ts) have explicit registries that a new persisted domain must wire, not bypass.
- [UserDetailModal](../../frontend/src/components/UserDetailModal.tsx) already displays separate Office dates. They must remain separate from agent response/activity evidence.
- [Official report context](../../docs/official-usage-import.md#choose-the-report-set-shown-in-agents-and-users) is reader-personal and shared across Users/Agents. Do not turn it into a tenant preference or an Office report selector.
- [Current schema](../../backend/src/db/currentSchema.ts), [schema verification](../../backend/src/db/schema.ts), [data architecture](../../docs/data-architecture.md), and [reset operations](../../docs/operations.md#reset-application-data) require the exact current schema; startup does not migrate an incompatible installation.

[Microsoft's current report contract](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/copilotreportroot-getmicrosoft365copilotusageuserdetail) documents additional v2 overall prompts/active days, but the current collector does not retain them. Those totals span a broader scope and cannot be attributed to the seven Office apps. Collecting/displaying them is not part of this campaign. The report covers licensed M365 Copilot users, not unlicensed Chat activity.

Per-app last dates can precede the selected reporting window. A nonblank date is not automatically recent activity; classify it against that observation's provider refresh window. A blank date is not proof of never using an app or wasting a license.

## Approach verdict and target runtime flow

**Verdict: keep one focused retained Office domain; simplify reconciliation, presentation reuse, and verification ownership.**

Current flow is automatic directory/app collection -> replaceable saved heads -> current user details, while imported agent CSVs -> separate retained agent reports -> agent adoption. Neither path currently creates Office history.

The tempting smaller alternative is another dashboard over today's app dates, borrowing agent snapshots for its charts. That would invent Office history and break historical group/champion drill-down. A latest-only screen was offered and rejected in favor of retained observations.

Do not copy the entire dashboard or force both domains into the agent payload. Share concrete layout/card/chart/group presentation where useful, with explicitly typed domain metrics and distinct evidence owners. No generic analytics platform, extra provider, message broker, configurable scoring framework, or duplicate aggregate store is needed.

Use the existing recovery owner and `users` publication signal, not another provider source or polling/scheduler framework. Keep three phases: the backend evidence/API contract is a useful independently verifiable boundary before its UI consumers; final integrated qualification and the authorized clean reset/deployment are a separate operating boundary. Merging them would hide those boundaries, not simplify the runtime.

Target flow:

1. Normal eligible sign-in and existing read-only sync collect directory and Office-app evidence automatically. Neither imported agent CSVs nor an administrator's session is an Office prerequisite.
2. After either source commits, existing startup/periodic recovery automatically reconciles a missing or changed Office observation from validated saved sources. This local calculation makes no extra Graph call and does not depend on a page visit.
3. Capture a coherent directory/app source vector, calculate paid-person Office facts, and publish a compact observation atomically. Independent healthy source publication must not be downgraded or blocked by a derived-observation failure.
4. Saved-read APIs select Latest or an exact retained Office observation, apply the requested scope/filters, then aggregate/rank all matching facts before pagination. Preserve the explicitly unfiltered organization/group denominators below. Actor-bound selections/cursors protect all pages and facets.
5. Both Office dashboard and Users adoption read that observation. Department/app links carry the Office domain, observation, and applicable group/app filter.
6. Successful derivation, correction, retention, and clear change the existing `users` publication revision, including recovery that runs after the original source notification. Latest updates automatically. Failed refresh preserves earlier evidence with truthful dates/status; local derivation failures are visible and retried through existing automatic recovery.

## Shared evidence contract

### Observation ownership and lifecycle

- Persist one observation header plus the compact per-person facts needed for historical groups, app participation, and champion ranking. Do not also persist a competing aggregate cache or a copied directory/license catalog.
- Preserve tenant, provider report refresh date, `D28`/`v2` identity, source observation timestamps/identifiers, evaluation time, coverage, content identity, and expiry. Preserve each person's exact directory identity, display/group context, paid eligibility at capture, seven app dates, and explicit missing/ambiguous/retained-evidence states.
- Paid eligibility/group membership are evidence **captured with the observation**, not a reconstructed workforce or licensing history for each day in the preceding window. Labels must explain this distinction.
- The normal timeline has one canonical point per tenant, provider refresh date, period, and version. Compare deterministically ordered semantic facts and coverage, not new generation IDs, collection/evaluation timestamps, or staging IDs. Repeated six-hour syncs with unchanged evidence are no-ops; preserve the original capture/provenance. Aging alone is not a correction.
- Changed evidence for the same provider date is a correction: stage a complete replacement, atomically replace the canonical observation, and invalidate affected selections. Reconcile the date actually supplied by the captured app head, never recalculate the rest of history from today's directory. A correction is a new immutable capture with its own frozen context, not facts mutated behind a readable old selection or two competing points. A removed bookmark follows the normal unavailable-context notice and Latest recovery; do not add ID aliases.
- Seed only valid current saved `D28`/`v2` evidence when possible. Do not scrape retired generations, fabricate prior points, reinterpret old dates, or require agent imports to start history.
- Use existing publication fences, bounded staging, database transactions, selected-read leases, lifecycle accounting, and recovery machinery where they fit. Protect the captured source vector during the copy and recheck its epochs/heads before publication. Source clear must fence pre-clear staging so it cannot resurrect history. A narrow Office domain helper is justified; a second job/scheduler framework is not.
- Derivation may wait for the other independently collected source. Recovery must handle either publication order, duplicate notifications, restart after commit, cancellation, and failed derivation without repeating provider scans. Successful publication or a semantic no-op acknowledges the processed source vector in existing work/status bookkeeping; idle recovery must not repeatedly recopy unchanged heads. That checkpoint is not another evidence owner or access gate.
- Snapshots and their selected reads must survive ordinary replacement/cleanup of original current source generations. Store sufficient self-contained evidence; do not retain raw generations for twelve months or make them read dependencies. Wire the minimal Office dependency into existing selection validators, schema checks, tenant-ownership constraints, backup keys, runtime grants, and lifecycle/restore owners together.
- Retention uses the provider refresh date and a twelve-calendar-month UTC date cutoff, removes dependent reads before data, and uses bounded existing lifecycle work. Test cutoff equality, leap days, and month ends. Explicit user-data clear/reset and applicable existing privacy/deletion paths must remove/fence Office history; historical snapshots must not resurrect cleared identities.
- Admit only a valid, non-future provider refresh date with known `D28`/`v2` semantics. Unknown/mixed windows, malformed dates, and header-only reports without a refresh date cannot publish a dated zero-use point. Valid partial matched evidence may be shown with coverage and unknowns.
- Each qualifying app row must belong to that observation's provider refresh date/window and be unambiguously matched. Retained unseen rows keep their old dates/provenance visible but are unknown for the new observation's participation, even if an old app date happens to fall inside its window. Do not promote them to freshly reported usage.

### Metric definitions

For an observation, the recent window is its provider refresh date minus 27 days through that date, inclusive, in UTC. Apply the existing freshness threshold when admitting current source evidence. Retained historical observations keep their original evaluation semantics; they do not become measured zero when they age.

| Metric | Exact meaning |
| --- | --- |
| Saved licensed people | Distinct saved directory people with verified active paid features at capture, including existing warning/partially-enabled eligibility. Not tenant headcount. |
| Reported active Office users | Distinct eligible, unambiguously matched people with at least one of the seven app dates inside the window. Count each person once. |
| Active user-app pairs | Distinct eligible person/app pairs with recent reported activity. One person using three apps contributes three pairs, not three people or three prompts. |
| Apps used | Distinct apps with at least one qualifying person, between zero and seven when measured. |
| Per-app active users | Distinct qualifying people for that app. App counts may overlap and must not be added to obtain distinct people. |
| Department participation | Reported active people divided by saved licensed people in the same frozen company/department context. Label it **Reported active / saved licensed**. Incomplete evidence makes this a confirmed-participation lower bound, not complete adoption or a workforce census. |
| No recent reported Office evidence | Eligible people without a qualifying app date; explicitly not proof of no use. Unknown/no-date evidence must remain identifiable, not silently classified as inactivity. |
| Unknown Office evidence | People with unavailable/ambiguous/no-date evidence according to the shared app classifier. Keep its reasons/coverage available. |
| Potential Office champions | Positive recent app breadth, ranked by distinct recent apps descending, most recent qualifying date descending, normalized display label, then exact identity. Up to three per group, computed before pagination. |

Use an explicit shared seven-app mapping and classifier in backend-owned contracts. Reuse it in UI/details instead of new scattered app lists. Standalone Chat dates and the overall last-activity field cannot contribute to these Office metrics. A valid older app date stays visible but does not count as recent; future/malformed dates require explicit error/unknown handling.

Missing source/coverage is not a numeric zero. Preserve null/unknown, stale and failure states. Historical observations may display their original measured counts, clearly labeled as historical; they must not generate current-license or current-inactivity claims.

Unknown evidence is a subset of people with no qualifying recent evidence, not an additional disjoint population. Explain that overlap; never add the two cards to derive licensed people or call either measured inactivity.

### Read API and navigation contracts

- Add a focused `/api/office-app-adoption` read surface rather than changing the existing agent endpoint's meaning. Provide bounded history/context, organization summary, departments, groups, facets, and per-group people reads using the existing authenticated read policy, error wrappers, `DataSelections`, and signed cursor patterns.
- Office observation/period, company/department/app filters, counts, rankings, facets, and cursors must bind to the same dataset. Calculate over all matching records before pagination.
- Retain five groups per page, full-dataset summary counts, numbered group navigation, and renewal anchors. Bound large individual groups with paginated people rather than silently truncating them or materializing an unbounded group; show complete counts and all seven app totals. Use existing paging controls.
- Latest follows provider refresh chronology, not collection time. It updates after ordinary publication without page refresh or manual enabling.
- Keep the three-key publication contract and existing automatic source IDs. Include Office publication/status changes in the `users` revision; do not make Office derivation another provider job or onboarding prerequisite. Ordinary new observations/source replacement leave a valid historical pin unchanged; correction/removal of that observation, clear, or revoked authorization invalidates it.
- The Office comparison endpoint is the selected observation, or Latest when unpinned. Baselines must precede it; charts/comparisons must not accidentally include later observations when a historical observation is selected. Same-date corrections are not growth.
- Use `adoption=office` as the domain URL discriminator on Dashboard and Users Adoption; absence remains Agents. Use separate `officeSnapshot` and `officeBaseline` identifiers. Preserve existing agent `snapshot` and `baseline` behavior.
- Office snapshot choice is reader-personal navigation shared between Office dashboard and Office Users Adoption, not a stored preference. Carry company/department and optional app through drill-down. Keep agent and Office snapshot/baseline choices separate.
- An app drill-down selects recent users of that app: matching groups contain qualifying people, and the displayed people/ranked suggestions come from that filtered population. Preserve the full group's saved licensed denominator and clearly distinguish filtered people counts from complete group/app totals. With no app filter, show all eligible saved people, including unknown/no-recent-evidence people.
- Existing Viewer-capable roles read shared saved Office data without provider read permission. Actual synchronization still honors current roles, sessions, provider consent, and source authority.
- Office-only queries must not accidentally require an agent report, inventory generation, agent association, or imported-report selection. Current user-details context may be newer than a historical observation: clearly separate frozen Office evidence from current licenses/agent details.
- Existing agent APIs and MCP adoption tools keep their current agent meaning. No new MCP feature is requested; phase 01 must inspect shared policy/model consumers and preserve their contracts rather than accidentally generalizing them.

## Visual contract

Preserve the existing dashboard typography, rounded panels, color assignments, spacing, responsive behavior, loading continuity, and accessible interactions.

```text
Dashboard:  [ Agent adoption | Copilot in Office apps ]
             same header + domain-specific observation/baseline context
             Adoption over time          Adoption by department
             - Active users trend        - company selector
             - User-app pairs trend      - participation ranking
             People and engagement       Apps and potential champions
             - licensed participation    - apps used / user-app pairs / champions
             - no recent evidence        - seven-app active-user breakdown
             - unknown evidence          - group/app drill-down
             Observation comparison table + metric definitions

Users:      [ Users | Adoption ]
             Adoption domain: [ Agents / Office apps ]
             same summary, context, organization search/filters, group cards
             People: apps used + latest Office date, potential champion badge
             Office apps: each app's active-user count in that group
```

Company selection affects department comparison, not organization-wide summary cards, matching the current dashboard. Office observation selection changes all Office panels. Users filters narrow matching groups and their summaries, preserving existing agent-view semantics.

Do not describe Office dates as agent responses, rank Office champions by agent responses, or imply ROI/productivity. Do not introduce theme configuration, new chart dependencies, duplicated dashboard CSS, hidden switches, or speculative features.

## Always-deploy production contract: authorized local runtime

For execution-skill terminology, the required deployed runtime is the **local development installation `seha`**, not Azure or customer production. The campaign ends with deployment to that authorized runtime, observation, and fix-forward, not test-only readiness. No external deployment is authorized.

- Applicable focused, database, capacity, browser, first-run, aggregate, and recovery checks are mandatory attempts. Repair reproducible defects and record actual outcomes. Model/evaluator/remote-VM checks are not applicable to this deterministic feature.
- `failed`, `not_run`, `unavailable`, and `inconclusive` never become `passed`, but none alone is an invented release veto. Continue authorized deployment and truthful qualification; do not use `-ForceChecks` as a new acceptance prerequisite.
- Each residual needs affected scope, containment using actual existing controls, telemetry/canary, numeric alert threshold, owner, and exact fix-forward trigger. Do not add application-owned approval, canary-enabling, feature-start, or other runtime gates.
- Invalid derived evidence must not masquerade as complete metrics; report its actual unavailable/error state while authentication, sync, agent views, and unaffected paths remain usable. Preserve real role/permission/data-integrity/destructive-action constraints.
- Reverify Docker context, Compose labels, services, volume, database, configured origin, and candidate revision before mutation. Use the existing deployment owner. Reset the application database only, retaining project settings/secrets/volume. Never touch unrelated projects, Docker-wide resources, or other repositories.
- Keep synthetic qualification data in disposable fixture databases/projects. Do not write test users, fabricated report points, or fixture authentication into the deployed tenant database.
- After reset, ordinary sign-in automatically rebuilds provider sources and Office observations. Agent CSV history cannot be rebuilt by provider sync: show the normal empty state and reimport genuine authorized files if available. Never make that import an Office prerequisite.
- Deployment feedback drives root fix, focused check, redeploy, and rerun. After the successful schema reset, subsequent ordinary fix-forward starts omit `-DbReset`; uncertain reset outcomes must be inspected, not blindly replayed.
- Clean exact campaign-created test resources; cleanup failures remain owned cost/security incidents, not reasons to abandon deployed-runtime convergence.
- Only real inability to perform authorized local control-plane actions leaves `deployment_pending`, with an exact resumable action. Unproven promised workflows remain `production_hardening_pending`, not a claimed success.

No deployment is performed by creating this plan. No commit, push, branch creation, secret disclosure, public package-feed access, or unrelated cleanup is authorized.

## Completion and verification policy

Each phase owns the tests for its changed contracts. Phase 03 reconciles their results and verifies the exact deployed revision and user journeys. Completion records must contain implemented/deleted behavior, API/schema/state contracts, decisions and simplifications, changed files by root, cross-root impact including justified no-change results, actual commands/environments/case counts, environment actions, residual handling, and next-phase preconditions.

Use the [existing disposable fixture owner](../../scripts/large-tenant-tests.ps1), its [SQL selectors](../../backend/scripts/largeTenantFixture.ts), and [browser/runtime owner](../../scripts/large-tenant-lifecycle.ps1), not another harness. Resolve a verified installed operator/dependency image matching all four current dependency manifests, preserve it under a separate campaign-owned baseline tag, and record that tag as `$baselineImage` plus its immutable image ID as `$baselineImageId` for the PowerShell commands below. Reverify both on resume; never accept the runner's historical default tag/digest. Reuse approved installed dependencies; a missing image/tool or changed manifests must be handled through the existing owner and approved feed, not an assumed public reinstall.

Phase 01 registers one focused `office-app-adoption` SQL selection in the existing owner. Phase 02 owns Office cases in the existing adoption browser files. Phase 03 owns Office additions to the existing scale, current-installation, and restore fixtures. Its `check` command is the full backend/frontend test, frontend lint/typecheck aggregate owner; do not separately rerun completed aggregates without invalidated evidence. If it stops early or is unavailable, attempt remaining independent checks and preserve the actual aggregate/database result. The browser owner runs focused and aggregate passes; reuse them at phase 03 when candidate source/artifact identity is unchanged. Record mock-browser, SQL/restore/scale, and real provider/browser evidence separately.

Use existing tooling. Install only for a changed dependency manifest or a genuine missing-tool failure, using `https://packagefeedproxy.microsoft.io/npm/` and, if Python installation is actually needed, `pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`. Preserve Docker registry alignment and observe the same restriction in subprocesses.

Plan preparation/review inspected source, docs, and the shared browser. Runtime identities above came from the earlier planning inspection's read-only Docker commands and must be reverified during execution. Plan review did not run application tests, write runtime code, reset data, deploy, or prove that the proposed feature exists.
