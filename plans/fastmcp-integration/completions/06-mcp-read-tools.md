# Phase 06 — Inventory, people, usage and investigation tools

## Phase Result

**Complete for the authorized local-source/synthetic-validation scope.**
Position **3 of9** in the remaining manifest, assigned absolute prompt
`/Users/candede/repos/agent365/agent_control/plans/fastmcp-integration/06-mcp-read-tools.md`.
Confirmed worker launch: **GPT-6.1 Sol (`gpt-6.1-sol`), `xhigh`**.
No nested agents were used.

Application/repository boundary:
`/Users/candede/repos/agent365/agent_control` (backend, frontend and MCP).
Baseline/current HEAD: `d3a82a8d7673cb55300b6ab30fc3848d40554015`.
Validation occurred on2026-10-17 local time. Existing uncommitted phase05
implementation was preserved. The parent-owned `IMPLEMENTATION_CAMPAIGN.md`,
prior completion and `API_FOUNDATION_REVIEW.md` were not edited.

This implements06, not07+. There is no Always-Deploy contract. Independent04C
and12 live/deployment outcomes remain pending and are **not runtime gates**.
No production, `seha`, real provider, tenant grant, Docker/database provisioning,
remote mutation, deployment, paid/model call, git commit/push or branch action
was performed. No `.env` or real secret was read.

## Implemented

- Ordinary configured service construction registers **96 concrete tools**:
  **68 GET,26 POST,2 DELETE**, with19 explicitly provider-working operations.
  The two DELETE tools remove only exact confirmed local investigation caches.
  No extra feature-enable or business-approval ceremony was introduced.
- One static catalog in `tools.py` binds names, canonical methods/routes,
  concrete input models, nested output schemas and honest annotations. There
  is no arbitrary endpoint/SQL/KQL input or second API authorization-policy map.
  Registration uses the actual installed FastMCP4.1.0/MCP SDK2.3.0, not stubs.
- Saved workspace jobs/capabilities/check progress; inventory capture/list,
  health/summary/facets/detail/members/children/sections/full About; saved
  package/native detail and native target resolution.
- Exact saved username/directory resolution, licensing and plans, unresolved
  identities, used/created/owned/modified relationships and responsibility;
  adoption groups and exact top-champion associations without Python ranking.
- Official report users/agents/relationships/facets, retained history/options/
  observations/overview, source/report metadata, usage summaries/users/
  associations/candidates/history and explicit comparability evidence.
- Saved agent investigations, Purview records, Defender results and
  administrative audit with origin/client/calling-agent filters.
- Explicit capability checks/probes, directory picker lookup/resolution,
  agent-people enrichment, identity resolution, delegated package/Studio
  refresh, bounded synchronization, curated Audit Search/hunting submissions
  and their existing job/status/results/cancel/retry/resume/cache recovery.
- Every call uses `CanonicalApi.invocation(ctx)` and SDK request-local auth/
  attribution. The API still owns source authorization, joins, counts, ranks,
  calculations, provider work, durable jobs and audit. Python never imports
  browser/backend runtime configuration, collects directly or invents facts.

## Contracts and preserved behavior

Each tool accepts one typed `request` object; empty-input tools accept
`{"request":{}}`. Models are strict/frozen and reject extra fields.
Nested inventory configuration, provenance, observations, service plans,
report windows/lineage, comparisons, principals, jobs, audit and minimized
investigation evidence retain actual wire fields rather than untyped row maps.
Dynamic provenance/count/metadata maps remain typed where the source requires
them. Explicitly absent versus null fields are preserved with `exclude_unset`.

Unspecified defaults stay API-owned. Inventory capture retains the canonical
string-valued query body. Facet null, literal `"~null"` and the available-to
special value remain distinct. Other optional fields must be omitted, not
silently null. Exact opaque source/report/package identities preserve case;
UUIDs normalize to lowercase. Canonical/source-qualified agent references
reject malformed UUIDs/percent encoding and missing native components.
Endpoint-specific filters, UTC/calendar syntax, paired dates/comparison IDs,
page bounds, source pairs and job cursor/revision pairs are finite.

All reads return one explicit bounded page. Continuation retains the exact
selection/source/revision; expiration or cross-principal denial never causes
recapture, source substitution or retrying a stateful submission. About returns
up to16384 Unicode characters per call and exposes the exact next cursor until
all available text is read. Source text is untrusted inert data, not instructions.
No truncation, implicit source fallback or hidden full-dataset loop exists.

Missing/partial/unknown/report-only/ambiguous evidence remains explicit.
License unknown is not unpaid; report occurrence totals remain non-additive.
Incomparable/missing report windows retain reasons and null metrics. No
calculation, join, catch-to-empty success or authority inference moved to Python.

The existing60s invocation, four concurrent API requests, eight physical API
requests, two OBO exchanges,30s API and10s exchange limits are preserved.
The524288-byte output ceiling now also accounts for the actual final SDK
text-plus-structured envelope; oversized output fails rather than shortening
data. Only safe GET429/503 may retry once within bounded cooldown/deadline.
POST/DELETE never replay automatically. Real SDK cancellation reaches the
in-flight canonical API transport. Safe status/code/correlation/cooldown and
sanitized error details survive; raw provider/secret diagnostics do not.

MCP submissions remain **delegated-only**, matching current bearer policy.
Browser application-mode investigation configuration/shared-scope semantics
remain unchanged. No provider-control tool, application fallback, import,
configuration writer, download/export or automatic browser refresh is exposed.

## Deleted and simplified

- Removed the obsolete phase05 three-endpoint `SavedEndpoint` enum and separate
  `AboutRequest`; named adapter calls now use the one current typed catalog and
  `AboutInput`.
- Replaced empty-business-catalog diagnostics/tests and current documentation,
  including the owning backend prose assertion, with actual registration facts.
  Historical phase05 completion evidence was deliberately not rewritten.
- Reused existing OAuth/storage/origin/error/resource owners. No dependency,
  state store, queue, scheduler, provider client, compatibility alias, separate
  policy registry or business-calculation framework was added.
- Necessary complexity is explicit wire DTOs and a small registration helper:
 96 routes have different typed contracts. A test-only TypeScript compiler
  fixture reads49 current backend DTO families, minimal and with nested optional
  evidence; it imports no application runtime and is not a second production map.
  SQL/service-only projections without exported DTOs have pinned wire fixtures.

## Autonomous Decisions

- Followed the source/API map exactly, including `capture_agent_inventory` and
  `list_agent_usage_history`, rather than creating aliases.
- Kept application investigations in browser scope and delegated-only MCP
  inputs, as explicitly directed; did not widen bearer admission.
- Distinguished provider-free selection capture from read-only GETs, and live
  directory search from saved reads. Local cache deletion is destructive and
  requires the existing exact-ID confirmation.
- Counted the final SDK result envelope after a regression proved that a
  canonical body below524288 bytes can exceed the delivered bound when also
  represented as text. No truncation or lower-domain-data substitute was added.
- Source-derived fixtures exposed native activity's string identifier kind;
  the DTO now follows that producer rather than imposing an unrelated enum.
  Fixture HTTP statuses/template-string links and package route envelopes were
  corrected without weakening runtime validation.
- Did not rerun provisioning SQL harnesses or unchanged baseline live checks.
  Those actions are outside the authorized source-only scope; unavailable
  prerequisite evidence remains unavailable, not passed.

## Changed files and cross-application impact

**MCP added:** `inputs.py`, `inventory_models.py`, `report_models.py`,
`job_models.py`, `tools.py`, `tests/test_tools.py`,
`tests/wire_contracts.ts`, `tests/wire_contracts.mjs`.

**MCP updated:** `api.py`, `auth.py` (cookie-free JSON dispatch),
`models.py`, `service.py`, `tests/conftest.py`,
`tests/test_api_origin.py`, `tests/test_oauth.py`.
All are under `mcp/src/agent_control_mcp` or `mcp/tests`.

**Backend:** only `backend/src/routes/mcpContractFeasibility.test.ts` changed,
to replace obsolete catalog prose assertions while preserving auth/origin
guarantees. Current inventory/report/sync/capability/directory/investigation/
audit routes, DTO producers, selected-read repositories, identity parsers,
fact projections and policy were traced. No shared runtime/schema defect or
changed wire contract required a backend edit. The canonical route-map/auth
suites and source-derived DTO fixtures verify this boundary.

**Frontend:** no runtime or DTO edits required. `api/client.ts`,
`api/reportData.ts`, saved-query adapters and About/Adoption consumers use the
same canonical routes/types/defaults. Their existing473 tests and typecheck
passed; browser automatic complete About loading and saved query behavior
remain intact. The browser does not call MCP.

**Current docs:** root `README.md`, `docs/mcp-integration.md`,
`docs/deployment-setup.md`, `docs/security-model.md`.
Added this required completion record only; parent campaign state is untouched.
Prior-phase `.dockerignore`, `.gitignore`, package/lock and other unrelated
uncommitted work were preserved.

## Validation

No dependencies were installed or restored. Python runs used the existing3.14
`.venv`; Node used existing workspace dependencies. All registry contracts remain
the approved Microsoft proxy; the offline lock check made no network request.
Editor test discovery found no tests, so existing CLI runners were used.

| Status | Command / evidence | Result |
| --- | --- | --- |
| passed | `cd mcp && .venv/bin/python -m pytest tests/test_api_origin.py tests/test_oauth.py --tb=short` |75 existing adapter/auth tests after catalog integration |
| passed | `cd mcp && .venv/bin/python -m pytest tests/test_tools.py -k 'finite_inputs or source_references or final_protocol or delegated_search_hunt' --tb=short` |27 focused cases;208 deselected |
| passed | `cd mcp && .venv/bin/ruff check src tests --output-format concise` | clean |
| passed | `cd mcp && .venv/bin/ruff format --check src tests` |20 files formatted |
| passed | `cd mcp && .venv/bin/mypy src` | strict,15 source files clean |
| passed | `cd mcp && .venv/bin/python -m pytest --tb=short` | **339 passed**,112.68s; no skips |
| passed | `cd mcp && UV_PYTHON_DOWNLOADS=never uv lock --check --offline --index-url https://packagefeedproxy.microsoft.io/pypi/simple` |82 locked packages checked offline |
| passed | `npm test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/delegatedCredentials.test.ts src/auth/requestPrincipal.test.ts src/routes/mcpApiAuth.test.ts src/routes/mcpContractFeasibility.test.ts src/routes/policy.test.ts src/routes/actionOrigin.test.ts --reporter=dot` | **176 passed**,7 suites |
| passed | `npm test --workspace backend -- src/routes/mcpContractFeasibility.test.ts --reporter=dot` | final documentation/map recheck:20 passed |
| passed | `npm test --workspace frontend -- src/api/reportData.test.ts src/api/client.test.ts src/components/SavedAgentAbout.test.tsx src/components/AdoptionView.test.tsx src/savedQueries.test.tsx --reporter=dot` | **473 passed**,5 suites |
| passed | `npm run typecheck --workspace backend && npm run typecheck --workspace frontend && npm run check:unused` | both typechecks and Knip clean |
| passed | editor Problems on affected source/tests | no reported errors |
| passed | local documentation targets/anchors and `git diff --check` |47 targets/anchors across5 current files; no broken links or whitespace errors |

The real SDK matrix calls every registered tool with both minimal and optional
nested source evidence, and checks discovery schemas/annotations/omissions.
Additional cases exercise exact methods/encoded paths/query/body/defaults,
idempotency, delegated search/hunt bodies, full Unicode About continuation,
guest/report-only/champion pages, native configuration, partial/missing sources,
incomparable history, denial/expired/cross-principal selection errors, throttle/
cooldown, no stateful replay, malformed/extra response rejection, final-envelope
output bounds, request-local attribution, cancellation and provider-free saved
reads. API/provider authority is not replaced by the synthetic transport.

Owned project-relative `.local/mcp-tests` synthetic fixture scratch was removed
after final tests and absence verified. No `/tmp`/temporary-directory scratch
was created. Installed development environments/caches remain available.

### Unavailable / not run

- **Unavailable, reused prerequisite evidence:** `mcpReadContracts`,
  `sharedAgentControls`, `auditOriginHttp` and SQL `auditOrigin` lack the required
  isolated `agentcontrol_test_*` database, as recorded by the parent phase05
  review. Their harness provisions databases after its safeguard, so it was not
  rerun under this worker's explicit no-provisioning boundary. No SQL pass,
  real database roundtrip or newly measured availability is claimed.
- **Not run / unauthorized:** live Entra/native/guest consent, external host
  client recovery, real provider results, tenant grants, application identity,
  HTTPS ingress, container/volume lifecycle, deployment and04C/12 live outcomes.
  Synthetic transports do not prove those outcomes.
- No reproducible owned implementation defect remains after focused and full
  reruns. Actual SQL/live verification remains a separate authorized activity,
  not a hidden runtime enable gate.

## Content identities

SHA256 of final local content, not a deployed/accepted revision:

| Content | SHA256 |
| --- | --- |
| `mcp/pyproject.toml` (unchanged05) | `3a2f2047d79c94ba8e0e32102bc96ea8e36832c724f428e4b73859a814a5bf4b` |
| `mcp/uv.lock` (unchanged05) | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |
| Assigned06 prompt | `e1e3e8a6b85b55906c99bd82075653d6bf8779bfe47a149ef2e13abe264caf0e` |
| Roadmap `README.md` (unchanged) | `40fdb91510ba7d8a8c0c844bf3bf0405f87384aaf214c829cb0ccfee8561ad71` |
| `API_FOUNDATION_REVIEW.md` (unchanged) | `9a9b761b6f76e50edaad66d83a634c98d7de19dd6a3f4cb0f28e5d61302294b3` |
| `docs/mcp-integration.md` | `bbac7e1e28a30c5e8402936f00abb34c78289278530f39906940adba6053fb8b` |
| `docs/deployment-setup.md` | `f0c1e48afcc4c5b54f595a885b92050f14b823655f20474a3979bbfd37aef0e8` |
| `docs/security-model.md` | `05bcc87806f81085db3d3ba718a90f67af4c58083350d692122331aa1fd22768` |
| MCP aggregate (24 files) | `0fa1d8a7b72f88f8b6548956afc03989c8a1b0e80371a64d5dd51c15f5da8a6c` |

Aggregate algorithm: sort relative POSIX paths of manifest, lock,
`mcp/src/**/*.py`, `mcp/tests/*.py` and `mcp/tests/wire_contracts.*`;
feed each `path + NUL + file bytes + NUL` to SHA256.
Exclude environments, caches, scratch, docs and completions.

## Decision Needed / Next Preconditions

**No unsettled parent decision for06.** The parent may advance07 using this
registered catalog, exact canonical/source/report identities, selected paging,
delegated invocation and existing source API control contracts.07 must add only
its named control preview/execute/outcome adapters, preserve live prestate/
confirmation/readback and uncertain-outcome recovery, and must not introduce
another writer or replay provider effects. Source/schema/auth tests and the
current operation map are executable prerequisites, not deployment acceptance.
Container/client/deployment phases and actual04C/12 proof remain parent-owned.
