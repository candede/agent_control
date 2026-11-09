# Phase 01 — evidence APIs and MCP reads

## Result and execution identity

- State: `complete` — implemented and verified in the authorized isolated stack;
  live deployment remains phase 06, not a runtime approval prerequisite.
- Actual worker launch: `gpt-6.1-sol`, `reasoning_effort=xhigh`; no nested workers.
- Repository: `/Users/candede/repos/agent365/agent_control`; initial revision
  `ebe238cd03acf51a377cd34b1cb9ea40b8fe63a8`.
- Read the assigned prompt, README, CONTRACT, repository AGENTS, installed
  implement-folder skill and step-worker reference. Manifest order and all
  binding hashes remain unchanged. No earlier phase was assumed.
- No commit, push, branch creation, live SEHA update/reset, or modification of
  `automations-mcp-ui-dev`.

## Implemented contracts and one-owner decisions

The falsifiable hypothesis was that existing exact report-identity SQL could
classify a complete frozen Office audience independently of newer directory
assignment/licensing and provider-read permission. Real publication/import,
SQL, authenticated browser/bearer, and OAuth SDK cases establish that behavior.

- Added `GET /api/copilot-usage/adoption/opportunities` and its exact
  `:groupId/people` child in the existing report/adoption router.
- Aggregate output contains exact nullable company/department, rank, existing
  Office metrics, separately defined Office-paid/Office-active/current-directory/
  current-agent-paid denominators, positive/noReported/unknown counts, explicit
  coverage, independent contexts, and actual drilldown paths.
- Aggregates allow 1–10 groups and at most 131,072 UTF-8 bytes. Ranking/totals
  precede pagination over the complete matching population. Current-directory
  enrichment returns only the selected at-most-ten groups from SQL.
- Audiences allow 1–100 people and at most 524,288 HTTP bytes. Cohorts are
  `positive`, `no_reported`, `unknown`; signed continuations bind actor,
  authorization/session, both selections, group, cohort, query and limit.
- Extracted the existing exact report identity relations/row SQL, rather than
  copying reconciliation. The **whole frozen Office observation** supplies
  identity aliases before filtering. Positive Users responses/agents-used count
  without companion agent edges. Unresolved/ambiguous identities and missing
  required user-report lineages prevent false negatives. Categories reconcile
  directly to the captured Office-active paid audience; no subtraction surrogate.
- Reused Office context construction and the report selected-read owner. One
  repeatable-read transaction locks the union of owned scopes in common order
  and reasserts all contributing selections/current-clock authority after work.
  Inventory enrichment is optional; report capture can exclude its dependencies.
  Supplied incompatible selections remain denied, not silently rebound.
- Frozen licensing/affiliation/UPN remain authoritative after newer valid
  directory facts change. Real Office clear/invalidation remains authoritative;
  it is **not** an optional-source condition to bypass. Missing Office summary
  values are null, not invented zero. Weekly aggregates work; weekly people
  return `office_history_aggregate_only`.
- Existing exact adoption/champion endpoints supply top-three used/created
  edges, linked packages and report-only agents. No department-wide agents are
  substituted for champions, and no large people/About payload is embedded.
- Added compact `office_adoption` actions: context, summary, comparison, history,
  groups, departments, facets, people. Extended `adoption` with summary,
  departments, history, opportunities, opportunity_people. There are now
  **126 canonical operations / 55 business tools**; Viewer has 39, EndUser 3.
  Stale corpus counts were reconciled to actual metadata, not treated as API
  aliases. Every operation has minimal/full-optional SDK shape coverage.
- Backend DTOs, finite Pydantic inputs/output models, domain registration,
  access-profile fixtures, and typed browser `readDepartmentOpportunities` /
  `readOpportunityPeople` share the same contract. MCP preserves canonical
  results and its 524,288-byte final envelope limit; oversize Office operations
  return explicit `output_limit`, never clipped evidence.
- No new schema, dependency manifest, app role, content store, analytics owner,
  generic coordinator, compatibility route, participant registry, approval,
  enable switch, or manual-start prerequisite. Existing automatic authenticated
  read-only entry, Viewer/Uploader/Admin hierarchy, provider permissions and
  destructive confirmation are unchanged.
- Removed only unused export visibility: two local opportunity types and the
  Office metric-projection/reason constants. Algorithms/current operations were
  not removed or duplicated.

## Cross-root producer/consumer impact

| Root | Changed owners/consumers and evidence |
| --- | --- |
| backend | `db/officialReportQueries.ts`; `services/officeAppAdoptionReads.ts`, `largeTenantUsersReports.ts`, new `departmentOpportunity.ts`; new DTO; `routes/officialReportData.ts`; Office local exports; policy/feasibility tests; new unit/SQL/route tests; real shared department fixtures/corpus and existing guarded runner registration. Existing Office lifecycle expiry test now waits on the actual selected timeline lease. `dataPages.test.ts` now supplies actual tenant-local account IDs/cache and bounded active-member Graph evidence instead of an invalid roleless synthetic session. |
| mcp | `domains.py`, `inputs.py`, `tools.py`, `report_models.py`, new `office_models.py`; backend wire-DTO fixtures, every-operation/boundary tests, browser replay, workflow/corpus use, actual access-profile generation and audience projection parity. No independent calculations. |
| frontend | Existing `api/reportData.ts` gained typed reads and shared literal-null serialization; `reportData.test.ts` checks both selections, cohort and cursor. Existing request/session authority is reused. No workspace/content UI is prematurely added; phase 03 owns it. |
| scripts | `large-tenant-tests.ps1` registers `department-evidence`; the existing backend runner registers all new selectors, frontend tests/typecheck, and the new route in `mcp-end-to-end`. No deployment workflow/runtime authorization changes. |
| infra | Unchanged, verified by scoped git diff. No service/environment/schema prerequisite introduced. |
| root deployment/manifests | Dockerfile, Compose, `.npmrc`, npm manifests/lock, MCP pyproject/uv.lock unchanged by scoped diff. Actual baseline manifest hashes and runtime/architecture were checked; no inferred matching image. |
| docs | MCP operation map and data architecture updated; this exact record and campaign state. Phase prompt/README/CONTRACT bytes unchanged. |

## Validation commands and true results

Host: macOS; Node **24.22.2**, npm **11.19.1**, MCP Python **3.14.10**.
The mandated `.venv/bin/python` command worked; no host restore was required.

| Check | Result |
| --- | --- |
| Baseline named backend four-file command | `passed`: 102 tests |
| Baseline mandated MCP four-file command | `passed`: 392 tests, 144.06 s |
| `npm run test --workspace backend -- src/services/officeAppAdoptionReads.unit.test.ts src/services/adoptionGroups.unit.test.ts src/services/adoptionDepartments.unit.test.ts src/routes/mcpContractFeasibility.test.ts src/services/departmentOpportunity.unit.test.ts` | `passed`: 111 tests / 5 files; final host rerun |
| `npm run typecheck --workspace backend` and `npm run typecheck --workspace frontend` | `passed` |
| `npm run lint --workspace frontend`; `npm run check:unused`; `git diff --check` | `passed`; unused check initially reported four export-only findings, then passed after localizing them |
| `npm run test --workspace frontend -- src/api/reportData.test.ts` | `passed`: 32 tests |
| From MCP: `.venv/bin/python -m ruff check src tests`; `.venv/bin/python -m mypy` | `passed`: mypy 27 source files |
| `.venv/bin/python -m pytest tests/test_tools.py tests/test_report_models.py tests/test_workflows.py tests/test_service.py tests/test_audience_projection.py` | `passed`: final 456 tests, 174.36 s |
| `.venv/bin/python -m pytest tests/test_workflows.py -s` | `passed`: 22 tests; final coherent department workflow measured separately |
| `pwsh -NoProfile -File scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end -BaselineImage seha-operator:local -BaselineImageId sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63` | `passed`: 168 tests / 8 files, backend typecheck, real OAuth SDK→HTTP→SQL including the five-call department audience |
| Same guarded command with `-Suite office-app-adoption` | `passed`: final 1,190 backend tests / 26 files, 32 frontend tests / 1 file, both typechecks; result has no failures. |

Existing runner selectors include new opportunity unit/SQL/route files, Office,
adoption, selection, role/policy, automatic-entry, schema/backup and frontend
regressions. The `department-evidence` runner also includes actual selected-report
and champion SQL owners. DB-dependent cases ran through exact isolated resources.
One host invocation returned 4 failed / 135 passed, including two stale runner
registration expectations subsequently repaired and two DB-bearing fixture tests.
Both DB-bearing tests refused the non-isolated identity before any DB connection;
they were subsequently
covered by the guarded isolated runner. No host/live DB proof is claimed.

### Measured retrieval and capacity

- Real SQL/API controlled fixture: **22 paid / 22 Office-active / 7 positive /
  exactly 15 no-reported / 0 unknown**. Five reads return 40,031 bytes; aggregate
  6,538 bytes; measured **126.106 ms** in the final aggregate run.
- Whole-observation duplicate UPN outside the filtered company: 6 positive /
  0 no-reported / 16 unknown, not false 22−7 arithmetic. Positive Users-only,
  concealed/multiple aliases, moved/renamed/unlicensed current directory,
  overlapping independently selected sets, literal null groups, >10-group
  ranking/paging, correction/deletion, Office clear and awaited expiry are covered.
- Real OAuth SDK→SQL five-call journey: **88,066 returned envelope bytes**,
  **0.449312 s**, exact 15 distinct negatives and seven disjoint positives
  including Users-only. Deterministic browser preflight supplies signed cursors;
  it is fixture setup, not an AI/model interoperability claim.
- Real SDK/browser-adapter fixture workflow: **5 tool/API calls**, **85,124 bytes**,
  **0.342524 s**. Shape fixtures contain coherent Office metrics, distinct
  identities and independent selected IDs; they do not calculate business joins.
- Real isolated capacity: **10,000 people / 500 groups / 20 warmed requests**,
  nearest-rank p95 **287.146 ms**, maximum aggregate **20,293 bytes**; all totals
  and ten-row scalar bounds asserted. This is the phase-01 compact-read target,
  not final application/restore/model capacity qualification.
- Hardware: local Docker `desktop-linux`, aarch64, 18 available CPUs,
  8,317,267,968 bytes VM memory. Existing test-worker limit 1.5 CPUs/1,536 MiB;
  PostgreSQL limit 0.5 CPU/1 GiB and shared_buffers 32 MiB. Environment is shared.

### Failed attempts and practical repairs

All failures were retained, not renamed passing:

- First aggregate: 30 failed / 1,154 passed (1,184 total). Fixed reserved SQL `$3`
  typing, explicit pool max four, and Vitest role-array spreading.
- Next department runner: 1 failed / 258 passed. A byte-identical correction
  correctly reused the original set; the fixture now imports a genuinely changed
  correction and asserts its different identity.
- Subsequent aggregate: 11 failed / 1,178 passed. Repaired ten invalid roleless
  cookie expectations by providing real synthetic account/member evidence,
  **without changing 401/403 expectations or bypassing authentication**.
- Existing timeline-expiry test used the earlier current observation's expiry,
  not the independently created weekly timeline lease; it now waits on the actual
  selected expiry, retaining all invalidation/GC assertions.
- Optional expiry fixture initially attempted to update a derived view, then an
  immutable generation intent; both correctly failed. It now creates a genuine
  short-lived inventory source and waits for actual clock expiry. A later attempt
  to also clear directory authority correctly removed Office evidence; that
  incorrect expectation was removed, **not** the real clear control.
- SDK workflow first lacked a browser adapter, then reused a mutable request
  dictionary; added the typed current adapter and copied requests. Coherent
  metrics/identities were retained, not silently clipped or fabricated.

## Environment/image/resource evidence

All projects are exactly owned `agent-control-ltdp-*` disposable fixtures:
`442036520f6b4bebaf5873773ee1b5be`, `ee93eea0244d4d3aa9ff2bdd08074e93`,
`61591b0b1377452b889e23d87ed4f37e`, `6c63f62b24c4403f8c5b0d109dff2696`,
`f0ada685de504544877e247b94a46399`, `63a14fb8e6b142dd90d47f78f10a4041`,
`e7ada938bf17485bbd29932523413acf`.
Diagnostics/results are under `artifacts/large-tenant-data-platform/<id>`.
Runner finally blocks cleaned exact resources. Final explicit inspection found
**zero containers, volumes and networks for all seven projects**; removed only
their **eight exact owned image tags**, with no broad deletion/prune or live tag
replacement. Retained diagnostics/results remain in the project artifact folders.

- Preserved/rechecked installed operator:
  `sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63`,
  arm64. Four npm manifests matched its actual hashes; Docker Node 24.20.0 satisfies
  the declared Node 24 engine.
- Live MCP runtime candidate was checked read-only:
  `sha256:91a8bc2ff12f49ab4a652da7c5774cfe486a68c32a5b354652d24cc9c5dfc7d8`,
  arm64 / Python 3.14.6. It lacks dependency manifests and pytest, so it was **not**
  assumed to be a matching test baseline. Actual Linux `python -m pytest --version`
  failed with `No module named pytest`, authorizing the needed declared test-runtime
  restoration through the existing guarded Docker test target.
- Built isolated SDK image:
  `sha256:88b4146caa8c01f4be716ca5668f2a54e735f0afb45f717a614700af8a5a2256`;
  actual Python 3.14.6 and matching pyproject
  `3d874de6d80d18c84a7cc1ce493aa0bbf5f1dd599da18f9bb13aa3383630c6e8`
  / uv.lock `7b1460caa5f3e48b511090817f27188b7a4f43c0145f3747ede7a1477d196bda`.
- Final isolated operator image before exact tag cleanup:
  `sha256:ad37882b7eabcdddcc07d193a14b9ea35da5d183edba9ec753a5c2c6b00f658f`,
  arm64. Final passing log:
  `e7ada938bf17485bbd29932523413acf/2178803bb405f0b4429ee3d19ccb434d07097e8fbd75b956c09e1abcd4116982.log`.
- Final changed executable/test content: **33 files**, SHA-256
  `d2640d74f4322f23290b5cf8d1c6875567185b8478b6174870ba5ef857efcbd8`.
  Fingerprint is SHA-256 of lexically sorted changed paths under backend/MCP/
  frontend/scripts, each path + NUL + current file bytes + NUL; documentation
  and ignored build/test artifacts are excluded.
- No npm install; Python restoration used only
  `https://packagefeedproxy.microsoft.io/pypi/simple`. npm project/container feed
  remains exclusively `https://packagefeedproxy.microsoft.io/npm/`.

## Residual ownership and downstream preconditions

No unresolved phase-01 implementation or focused/aggregate test defect remains.
Final verification and exact cleanup are complete.
Production is **not deployed by this phase**.

| Remaining campaign evidence | Scope and existing containment | Numeric signal, owner and exact trigger |
| --- | --- | --- |
| Actual configured customer/model/Studio use: `not_run` here | OAuth/current caller, existing role/provider/privacy checks and explicit mutations remain enforced; deterministic SDK fixtures are not model proof. | Phase 04/05: execute supported connected consumer; one fabricated count/identity/access/outcome, disclosure, unrequested mutation or success-shaped incomplete retrieval fails its scenario. Repair guidance/canonical root and rerun; no runtime enable/approval gate. |
| Complete application/browser/restore/reset capacity: `not_run` here, except named isolated schema/backup/automatic-entry regressions and measured compact-read target | Existing bounded SQL/response/admission/retention/operator controls remain; no compatibility writer, person archive or copied About. | Phase 05: run full authorized fixture/browser/model/restore/capacity cases. At least 1 integrity mismatch or scenario breach triggers scoped root repair/rerun with residual evidence, not invented runtime authorization. |
| Exact SEHA deployment/observation: phase 06, `not_run` here | Existing local deployment/backup/revocation/real destructive confirmation remains; synthetic fixtures never touch SEHA. | Phase 06: ordinary exact authorized update, justified reset only if required by the current schema, then actual journey observation. At least 1 affected authenticated read failure or incorrect cohort triggers containment → root fix → focused check → exact redeploy → observation. |

Phase 02 consumes the current typed evidence/context/navigation surface while
owning source-qualified discovery/About changes. Phase 03 must persist durable
set/version/observation/source references and defined aggregate context, **not**
reusable leases, archived participants or copied source content. Parent owns
advancing phases; phase 02 remains pending. Deployment/verification bookkeeping
does not become an application-owned approval prerequisite.

## Phase 05 integrated capture consumer repair

The first complete actual SDK department journey exposed an existing capture
wire defect: `InventoryQueries.capture` returned an internal `Selection`
(including endpoint/queryHash) without the declared publication revisions.
The strict native MCP capture decoder correctly rejected that API response as
502 `invalid_api_response`. Phase 05 repaired the current producer to retain
publication revisions from the same selected transaction and both inventory/
package route projections to emit exactly the existing canonical contract.
No schema, compatibility adapter or authorization/provider prerequisite was
added. Two exact-field regressions and all 123 focused inventory/capture/boundary
owner cases pass. The repaired real SDK capture, all source members/full About,
explicit save and cross-account lifecycle pass in the current integrated
adoption-content runner. Phase 05 owns the final aggregate/identity record;
the original phase-01 source digests remain historical, not current proof.
