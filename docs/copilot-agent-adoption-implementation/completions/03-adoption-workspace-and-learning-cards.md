# Phase 03 — Adoption workspace and learning cards

## November 9 scope correction: MCP-led content, no Adoption page

The user explicitly rejected the dedicated Adoption page and confirmed removal
of its navigation/manual editor and browser-only code/tests while retaining
MCP tools and backend persistence. The original implementation evidence below
is historical, not the current browser contract.

Removed the standalone workspace, route/view metadata and role-navigation entry,
manual browser content/opportunity adapters, analysis-copy helper, editor styles
and tests. Existing employee safe-learning discovery, current schema/content
objects, typed MCP operations and all backend evidence/authorization/lifecycle
owners remain. No replacement page, old-route alias or additional reset.

Current selective requalification: 367 frontend tests/eight files and 70 backend
tests/five files passed, including all staff roles having no Adoption page and
the metadata retaining Agents first. Types, lint, Knip and build passed.
The existing MCP wire bridge uses the generic report transport rather than the
deleted UI-only wrappers; 99 current MCP guidance/workflow tests passed.
The campaign manifest and binding phase contracts record the authorized amendment.

## Result and execution

- **Complete:** owned backend/schema/API/MCP/browser/lifecycle implementation and required local journeys are working and verified. No phase 04 kit or phase 06 live mutation was implemented.
- Worker launch: `gpt-6.1-sol`, `xhigh`; worker `e82429b8-caf1-484f-87e2-00a94d80e8cd`. No nested workers, questions, commits, pushes, branches or unrelated reverts.
- Repository: `/Users/candede/repos/agent365/agent_control`, macOS, Docker `desktop-linux`. Preserved all dirty phase-01/02 campaign work.
- Read the complete phase, README, CONTRACT, AGENTS, installed implement-folder skill/step-worker reference, campaign and exact prior completions.
- Parent owns campaign integration and advancement. There is no additional runtime acceptance, release, manual-start, role-assignment or card-certification gate.
- Live SEHA and `automations-mcp-ui-dev` were inspected read-only and left unchanged. Phase 06 still owns mandatory authorized checkpoint/reset/deployment/observation/fix-forward.

## Implemented contract

### One current content owner

`adoption_content` stores tenant-owned typed `brief`, `card` and `action` records;
`adoption_content_receipts` stores bounded content-free create identities;
`adoption_content_storage` measures their serialized tenant storage. There is no
copied telemetry, person/participant/champion registry, cursor archive, catalog
duplicate, CMS framework, hosted model, scheduler or messaging engine.

- Titles: 256 characters; eleven named narrative slots/progress: 2,048 characters.
- Whole normalized draft: 32 KiB; stored payload: 32 KiB; canonical aggregate and
  exact agent-source references: 16 KiB each; linked references: 2 KiB.
- At most eight unique canonical agent IDs and eight linked content IDs.
- Tenant records **plus receipts**: 20,000 rows and 128 MiB measured storage,
  serialized under the existing tenant advisory-lock pattern.
- Pages default ten/max twenty; staff/shared responses are bounded to 512 KiB.
  Browser page sizes 1/5/10/20 allow recovery without losing unsaved inputs.
- PostgreSQL's actual JSONB bound remains authoritative. Its four content-column
  bound violations return a known unsaved `413 adoption_payload_limit`, not a
  success or false unknown outcome; rollback leaves no orphan receipt or update.

Fixed employee-safe learning slots describe task, input class, prompt pattern,
expected output, review steps and known failures. Staff narrative/examples remain
separate untrusted business content. Generated/provided/confirmed evidence labels
are assertions, not privacy certification, successful-use evidence or expertise.

### Authorization and privacy

All actual same-tenant staff roles read content. Creators/Admins edit core content,
sharing and deletion. Assigned current staff update only action status/progress;
assignment neither grants a role/provider permission nor requires prior workspace
registration. Actions cannot be employee-shared.

Roleless active members read only explicitly `employees` cards through finite
discovery. Sharing is tenant-wide; optional company/department labels affect
relevance, not ACLs. Missing-profile members are not excluded.

Employee projection synthesizes `Learning: <task>` and returns finite slots,
exact IDs/revisions, withholding states and currently permitted agent references.
It never returns arbitrary staff title/narrative/example, contributor identity,
staff aggregate metrics or action data. Arbitrary labels/prose have insufficient
complete identity evidence and are withheld through the existing privacy renderer,
even when name/UPN flags are disabled. Email/GUID stripping or author assertions
are not treated as general prose safety.

Every shared read/continuation rechecks admission, current privacy, exact canonical
source membership and current record revision/visibility before publication.
Employee continuations discard the old cached projection before revalidation.
Unavailable source references retain their exact identity/state; no similarly
named or silently newer source is substituted.

Exactly the existing Entra roles/IDs remain, asserted against the actual manifest:

| Role | ID |
| --- | --- |
| `AgentControl.Viewer` | `8a02b7f3-bdbf-4193-8b29-4da05684fb5a` |
| `AgentControl.UsageReportUploader` | `fdc127ee-2377-4708-a5d4-0ddc4f46d83b` |
| `AgentControl.Admin` | `9feab889-b807-4a97-a504-944ab53a380b` |

### Evidence, retry identity and revisions

A measured save validates the actual caller's live Office/report selections,
optional inventory selection, exact nullable company/department and selected
group under current source locks. It persists only the bounded API-derived group
aggregate, definitions, exact observation/report set/version lineage and dates.
No selected-read lease, cursor, person list or original-participant claim persists.
Create/follow-up share one parser and the same selected-evidence query contract,
including Office baseline and optional inventory read fields.

Reload/follow-up obtains fresh reads for the current caller against the exact
saved sources. Expiry/deletion/correction is explicitly unavailable/superseded;
dated baseline values are not rewritten. Ordinary prose edits retain original
agent-source membership; only newly added exact IDs capture current sources.
Unavailable dated references do not prevent prose edits. Explicit replacement
means removing the old reference and intentionally adding it again.

Follow-up compares a separately selected current same-group aggregate with the
unchanged baseline. It returns `sameOriginalPeople: false` and explicit overlap,
non-additivity, denominator/membership/licensing drift, coverage and non-causal
ROI caveats, including the original source's unavailable/superseded state.
The real fixture preserves frozen **22 paid / 22 active / seven positive / exact
15 no-reported**, reusing phase-01 canonical calculations rather than recounting
people in the browser/MCP.

Create key format is `<13-digit epoch-ms>.<lowercase UUID>`. Tenant + actual actor
+ request + normalized canonical payload SHA-256 is the identity. Mismatches
conflict; another actor's same key is distinct. Existing receipts resolve before
expired supplied leases. Lost outcomes remain unknown; UI retains the exact
pending key/payload for retry. Resolution returns the original record identity's
current authorized record or explicit deleted outcome, not an archived payload.

Unmatched requests older than seven days, over 60 seconds in the future, or before
actual principal revocation/privacy cutoff cannot create. Content-free receipts
expire eight days after request time through existing bounded retention.
Expected revisions reject concurrent/lost updates; conflict reload retains the
unsaved draft for explicit review. Exact destructive body requires revision and
`delete:<record UUID>` with existing Origin/CSRF or allowlisted bearer policy.
These are business writes, not provider-control jobs.

### Lifecycle, reset and restore

Ordinary sign-out/session cleanup does not delete tenant content. Creator/Admin
delete removes the target payload and marks independent other-author references
removed, without cascading their actions/cards.

The existing guarded database operator owns real principal privacy erasure:
`erase-adoption-private <tenant> <actual-principal> <database>/<tenant>/<principal>`.
It requires current schema and `agentcontrol_admin`, tenant serialization and exact
confirmation; deletes authored payloads/receipts, clears private assignments/
progress and references in others, and retains/increments epoch/cutoff authority.
The existing confirmed database reset owns database-wide erasure.

Backup inventory/fingerprints include both tables. Native restore retains exact
current business payload/evidence/linked-ID membership, not old corrected/erased
payloads. Revision/time or automatic removed-marker changes alone do not discard
independent content. Missing targets stay removed.

Current receipts are transferred in the existing bounded restore review, including
content created/deleted after the snapshot; missing record targets become deleted
outcomes. Current **actual principal revocations** are merged monotonically at
preparation and fresh reopening, including post-snapshot privacy erasure. Ordinary
unrevoked post-snapshot registrations are not copied as a participant registry;
normal fresh-principal admission remains supported. Existing maintenance,
session/provider-authority invalidation and restore/reset protections remain.
Review pages stay 250 and the existing 100,000-row safe-review ceiling remains.

Current schema fingerprint:
`159105fb7d890f8888eb7f4f4536e9409a0c10104b8dd09670d1b50dc6d8b6f8`.
Current expectations: 109 tables, four views, 172 explicitly created indexes
(not a count of implicit primary-key/unique indexes). Effective runtime SELECT,
INSERT, UPDATE and DELETE are checked individually on both tables; runtime
TRUNCATE is denied and storage SELECT is required.

This changes the current fingerprint; no migration chain or old-schema adapter
was added. Approved fresh initialization/reset/restore was proved only in isolated
fixtures. A phase-06 live clean reset loses old business content, reports/CSV data
and caches; preserve revocation authority, attempt the installed-schema checkpoint,
let normal authenticated entry automatically repopulate available provider reads,
and perform genuine CSV reimport explicitly. Green health is not journey proof.

## Browser and MCP

`/adoption` is a normal staff workspace with manual create/edit/list, exact IDs,
assignment/progress, conflict/unknown-save recovery, bounded people drilldown,
measured baseline/follow-up and exact accessible delete confirmation. It is useful
before reports/inventory exist. The existing employee handoff automatically reads
shared learning; staff subject-bound preview uses the same safe discovery owner.

**Copy analysis prompt** is an honest external-consumer handoff, not “Generate AI.”
It includes durable source/filter intent, never cookies, credentials, tokens,
original selected-read IDs or cursors. A connected consumer must obtain its own
authorized reads; only explicit user-requested writes save content.

Current MCP catalog: **135 operations / 57 tools**; EndUser projection:
**five operations / four tools**. No historical counters remain as aliases.
New compact `adoption_content` actions: list/detail/create/update/progress/delete/
follow_up; `shared_learning` read; existing preview family gains learning.
Family annotations conservatively aggregate mutation/destruction/idempotence;
actual per-action API authorization remains authoritative.

## Changed owners and cross-root impact

- **Backend:** new `types/adoptionContent.ts`, `db/adoptionContentSchema.ts`,
  `services/adoptionContent.ts`, `routes/adoptionContent.ts`, focused unit/SQL/
  route tests and `adoptionContentTestSupport.ts`. Updated app/discovery registration,
  current schema/verifier/tests, retention, workbench metadata/types, canonical MCP
  route-policy/count tests, database operator/grants, backup inventory/restore/tests,
  fixture selectors/environment/registration and existing Office browser seed.
- **Frontend:** new typed API/transport tests, `AdoptionWorkspace`/tests,
  `SharedLearningCards`, analysis-prompt helper and actual browser spec. Updated
  App/CSS, routing/authorization, employee handoff/tests and affected session/
  permission request allowlists. Every JSON write/shared read uses the existing
  credential/CSRF owner with explicit JSON content type.
- **MCP:** new `content_models.py`/tests; updated finite operations/domains/
  instructions, typed wire contracts, generated current access profiles and
  tools/workflows/audience/discovery assertions. Required nullable business fields
  are narrowly accepted; optional-null and unknown-field rejection remains.
- **Scripts:** existing guarded `large-tenant-tests.ps1` now registers content,
  executes the actual SDK companion there, forwards its exact interpreter flag,
  copies infra into baseline-reuse fixtures and reuses installed PG17 clients/libs.
  No second harness or dependency installation workaround.
- **Docs:** operations, data architecture, roles/permissions, MCP reference, this
  completion and phase-03 campaign evidence.
- **Infra unchanged:** actual `infra/entra-app-manifest.json` still has precisely
  the three tested roles/IDs. Content assignment needs no Entra grant/schema owner.
- **Root deployment unchanged:** Docker/Compose/local operator already include
  current backend/frontend/MCP and existing database owners. No new service, feed,
  provider permission, scheduler, secret, feature switch or deployment prerequisite.
  All four npm manifests and Python manifests/lock remain unchanged; no host
  dependency installation or public registry access occurred. npm remains
  `https://packagefeedproxy.microsoft.io/npm/`; pip uses only the approved proxy.

Material simplifications: one content table, one existing privacy renderer,
one shared selected-query parser, content-free retry receipts and current restore
review. Removed duplicate unit registration by moving the manual fixture into
support code; no assertions were dropped. Never introduced a misleading AI-generation
path or hosted model. Necessary locks/receipts/fences are justified
by measured races, lost responses, delayed deletion retries and current privacy.

## Verification and failure repair

Final exact commands/results:

| Command | Observed result |
| --- | --- |
| `npm run typecheck --workspace backend` / `--workspace frontend` | passed on final source |
| `npm run test --workspace backend -- src/services/adoptionContent.unit.test.ts src/routes/adoptionContent.unit.test.ts` | 16 passed / two files |
| Same two selectors plus `src/db/schema.test.ts` | 254 passed / three files |
| `npm run test --workspace frontend -- src/api/adoptionContent.test.ts src/components/AdoptionWorkspace.test.tsx src/components/EmployeeDiscoveryHandoff.test.tsx` | 13 passed / three files |
| `npm run test --workspace frontend` | **5,752 passed / 138 files**, 125.21 seconds |
| `npm run lint --workspace frontend`; `npm run check:unused`; `git diff --check` | passed |
| MCP `.venv/bin/python -m ruff check src tests`; `.venv/bin/python -m mypy` | passed; 28 source files |
| MCP `.venv/bin/python -m pytest tests/test_tools.py tests/test_workflows.py tests/test_audience_projection.py tests/test_discovery.py tests/test_content_models.py -o addopts='' -q` | **443 passed**, 230.13 seconds |
| Guarded `adoption-content` runner, final source | **321 passed / ten files**, zero skips, 37.47 seconds |
| Guarded `mcp-end-to-end` matrix | **203 passed / ten files**, zero skips, 841.71 seconds |
| Guarded four-file Chromium/axe browser runner | **102 passed / eight pre-existing parked skips**, zero failures/flakies; 209.44-second wrapper |

All guarded commands used:

```sh
pwsh -NoProfile -File scripts/large-tenant-tests.ps1 \
  -Suite adoption-content \
  -BaselineImage seha-operator:local \
  -BaselineImageId sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63
```

The matrix substitutes `-Suite mcp-end-to-end`. Browser substitutes
`-Suite cutover-browser-contract` and adds:

```sh
-BrowserFiles 'adoptionWorkspace.spec.ts,agentCatalog.spec.ts,mcpSettings.spec.ts,permissions.spec.ts' \
-BrowserImage agent-control-ltdp-f33a00de178240c3bfe968b1d1dcdaf2-permission-browser-test:local \
-BrowserImageId sha256:f3a6ff01d12c5d9846ee76f05ef0fcdef2b6ce55f21b8d63a50996b1f53548b3
```

The 203-case broad matrix predates final query/grant/restore-bound refinements.
Those refinements are covered by the final **current-source** 321-case suite,
including the actual SDK create/retry/read/edit/delete HTTP journey, native
backup/restore, post-snapshot deletion/erasure replay and all required lifecycle
cases. This is explicit reused aggregate proof, not a claim every earlier image
contains the final refinement. Browser/frontend/Python final checks match their
unchanged final executable bytes.

Actual journeys cover same-tenant/cross-tenant/roleless authorization, creator/
Admin/assignee field controls, no-profile tenant-wide sharing, concurrent
idempotence/revision conflict, lost/replayed/deleted outcomes, exact Origin/bearer
delete, inert malicious text/unsafe prose withholding, current privacy/source
fences, Office expiry and report correction/deletion, cross-actor fresh reads,
drift/overlap, capacity/retention, effective CRUD grant loss, fresh reset and native
restore. Eight new workspace cases run at desktop/mobile widths with real API
JSON parsing, keyboard/focus/axe and measured Office baseline/follow-up.

Retained failed attempts are not passing evidence:

- First content SQL: 217 failed / 116 passed; sequential schema mocks and exact
  current counters were out of order, plus SQL deletion parameter casts. Repaired
  the owning mocks/casts/registration, preserving grants/guards.
- Earlier SQL counts included duplicated imported unit tests; extracted the
  fixture helper. SDK-only skips were eliminated by executing the actual SDK
  companion in content, not retained as deferral.
- Real browser JSON requests omitted content type; Express rejected writes/
  shared reads. Fixed every producer and added real transport regressions.
- Navigation overflow at 1,024 px: shortened only the nav label to “Adoption.”
  Exact actor-return URLs retain their fixture query; select locators use their
  actual accessible combobox names. Existing Office seed registration includes
  the new workspace; genuine waiting-source failures were not relabeled measured.
- Broad SDK initially 196 passed / five failed: fixed current selector/roleless
  route/count expectations and required-null business model validation.
- Content SDK initially rejected explicit `learning`/`assigneeId`/`dueDate` nulls;
  narrow validation repair retains optional-null/unknown-field denial.
- Native PG clients/libs were missing in the SDK fixture: reused the protected
  installed PG17 bundle and verified clients, without public package installation.
- Office expiry fixture first attempted immutable mutation; replaced it with the
  existing expiry hook and real clock expiry. No generation guard was weakened.
- Typed query falsifier reproduced rejected `officeBaseline`; aligned the MCP
  model and shared backend create/follow-up parser.
- Stored JSONB-space overflow now proves atomic known `413` for create/update,
  rather than an unexplained database failure/unknown outcome.
- Restore exposed deletion receipt loss and independent-card removal: reconcile
  exact business payload/linked identities and current bounded receipts. Added
  real pre/post-snapshot deleted-key and post-snapshot privacy-erasure tests.
- Restore's post-snapshot principal case exposed a zero cutoff. Preserve actual
  current revocations monotonically. An overly broad merge then failed the
  consistent-snapshot registration test; narrowed it to real epoch/cutoff
  revocations, retaining normal fresh-principal behavior and every original
  snapshot/fence assertion. Final 321 cases pass.
- One concurrent full frontend run: 5,751 passed / one import-heading focus
  assertion failure. Isolated unchanged import suite passed all 96; full unchanged
  rerun passed 5,752. No unrelated component/test was weakened or edited.

Every isolated attempt, exact project and observed counts is retained in
`artifacts/phase03-run-summary.json`; logs are the recorded `phase03-*.log` and
matching `artifacts/large-tenant-data-platform/<owned ID>` directories.

## Identities, unchanged roots and cleanup

- Final SQL target: `agent-control-ltdp-d3d4fc24cd694470864501ed0a49a743`.
  Operator: `sha256:970f6ee4c8b96b8e4a8994c68e84f2ffac2c4ada40161d830f2838534ef176b6`,
  arm64; SDK: `sha256:99812027ab4663421a8da87291e12a2ae477460527c9448db9d546aaa5b50ec2`.
  Passing workload: `3ac899de32cea82269ba966caf32454b4f2013a05d00a72c1cf8dc4069df12bc.log`.
- Final browser target: `agent-control-ltdp-9cfba2dda2ec4276a88af92652330ee6`;
  operator `sha256:6592dc28a07587b7921350fb875ca8a10747156bcbbca7e108b6d92c3dc59915`,
  arm64. Broad SDK target: `agent-control-ltdp-d4512e9a94df4459b2c8bc8138263e38`,
  operator `sha256:02778c47ec14dfe0882d6aebec4e4667668feedea1a4901eed1914cdbc1eb445`.
- Protected operator remains exact `sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63`,
  arm64; runner rechecks actual architecture/runtime and four npm manifests before
  reuse. Protected browser remains exact `sha256:f3a6ff01d12c5d9846ee76f05ef0fcdef2b6ce55f21b8d63a50996b1f53548b3`,
  arm64 / actual Playwright 1.58.2. Host Node 24.22.2/Python 3.14.10; installed
  operator Node 24.20.0. No unsupported Python ceiling or feed fallback introduced.
- Final **combined dirty campaign** executable/test snapshot: 89 files, SHA-256
  `6f694ac1b3cd9ea76873c5dc9a19ae77e956636598214d4874732915303a1747`.
  Formula: lexically sorted changed/untracked backend/frontend/MCP/scripts/infra
  path UTF-8 + NUL + exact bytes + NUL. This is not a phase-03-only delta.
  Per-file identities: `artifacts/phase03-source-snapshot.json`.
- Prompt `c68b626cf6efda6e292ff80854f055c26d3d6df05353c0f730e3c45b51d7a462`;
  README `718dfaa8e18406a9d80b1315fdcd68b85b9b7af7210f498266bfdf0493ad32d8`;
  CONTRACT `17832cfa672dffb325c2ab8e4b5ca88b229ecf66b56b3b61cf00be5782c5d727`.
- AGENTS `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e`;
  skill `6931110e9e65d050fada7b1ba92e1c4c5873aeea87a98c2402bee02b4cbc18c7`;
  worker reference `7b581abbc75a1218c6740ec82693dd4043fc0ff9c7202f62c6b26883589511e4`.
  Prior completion hashes: phase 01 `f685b10bd5dc8b6b5f338ad6ac33ed770ee924db38338d7d324d79d881fcd8cc`,
  phase 02 `135f2c3ebb00b4ee3e7ab5ad28d7531800eeefd1012e44e36455c1acb8baf6e9`.
- Unchanged infra manifest `6b9be15e309e16a1bff025d9e16f3ef2a22c91ca05b620931889bae06b7baebf`;
  Dockerfile `2872e4485b7d72f58b8b50702ef6be2b89f81eb6a8a200ace31a694e3cbd63a5`;
  Compose `dfc140b501be2215a782cc7eb591aab600c59aa29a6e94668718a440d7aed8d7`;
  local deployment `9fe58168ba7e8fccd77d9cbbef0d34ebf8ca60b8e9fc0d5dcfc5e9a45cba6a9d`;
  npm config `84be34acf35147adfefc880804932f02ce40d8459955358b701748ac4e5aca69`.
  `git diff` confirms no infra/root/dependency manifest edits.
- **23 exact created projects cleaned**, zero owned named containers/volumes/
  networks/images; **39 exact arm64 image tags** removed with `--no-prune`.
  Preserved protected browser/operator and all unrelated/prior project resources.
  Removed only owned ephemeral fixture credentials/launchers; retained redacted
  diagnostics. Exact identities/results: `artifacts/phase03-owned-projects.json`
  and `artifacts/phase03-cleanup.json`. No broad prune or live cleanup.

## Residuals, owner and next preconditions

No unresolved owned implementation defect or parent decision remains.

| Scope/status | Existing containment and numeric trigger | Owner / exact continuation |
| --- | --- | --- |
| Eight parked provider/security browser cases: `not_run` | Four existing scenarios at both widths: log setup/blocker links, selected identity resolution, Purview audit, fixed-template Defender hunting. Existing explicit scoped/content-free provider permissions/control remain. Any one hidden disclosure, automatic hunt, out-of-scope call or affected assertion failure requires root repair; SDK matrix >1,740 seconds requires fixture diagnosis without dropping cases. | Phase 05 attempts applicable selectors and repairs/reruns their exact owners. Not phase-03 discovery/workspace deferral or a runtime release veto. |
| Configured model/consumer broad interoperability and representative capacity: unmeasured/unknown | API privacy/auth/source bounds remain authoritative. One fabricated count/identity/access/outcome, unrequested mutation, source-instruction execution or success-shaped partial retrieval triggers repair. Prior contract targets: 10,000 people/500 groups, 20 warmed reads; p95 >2 seconds, compact read >128 KiB or workflow >32 calls/4 MiB/180 seconds triggers exact owning-boundary diagnosis. | Phase 05 measures configured-consumer/capacity scenarios; do not infer ROI or claim missing measurements passed. |
| Actual SEHA checkpoint/reset/deployment and promised live journeys: not_run in this phase | Current live installation untouched. No health-only or test-only production claim. Any one hidden disclosure, stale-source access, resurrected deletion, failed automatic first-use or failed workspace/share/progress/follow-up journey requires source repair, exact redeploy and re-observation. | Phase 06 owns approved installed-schema checkpoint, justified current reset, exact deployment and observation/fix-forward. Deployment inability is `deployment_pending`; deployed unproven promises are `production_hardening_pending`, never an invented approval gate. |

Phase 04 may rely on the actual finite read/write operations, normal browser
forms, safe shared-learning projection, exact durable evidence/retry/revision
contracts and verified fresh schema. Parent advances only the campaign phase;
the application itself requires no additional routine acceptance switch.

## Parent integration repair

Parent review checked storage/receipt bounds, tenant/object authorization,
canonical evidence/retry binding, employee projection/current sharing fences,
source-reference rendering, fresh follow-up reads and credential-free handoff.
It found a concrete independent-window defect: follow-up previously chose
report dates instead of Office dates, suppressing Office overlap when report
ranges were disjoint. The current owner now checks Office D28 and report
activity ranges separately and marks missing/partial report dates unknown.
No schema/API shape, authority or participant tracking was added.

Validation: backend typecheck passed; the two required content unit/route
selectors passed **21 tests**; `git diff --check` passed. The initial repair
typecheck caught nullable report dates; explicit complete-date guards and
missing/partial-date regressions resolved it. Phase 05 must include the changed
follow-up owner in its integrated current-source rerun; older source digests
above describe the worker boundary, not this later parent repair.

## Phase 05 integrated follow-through

Current real SQL follow-up regressions confirm independent Office D28/report
overlap caveats and unknown missing report dates; no Office window is borrowed
and `sameOriginalPeople` remains false. The current guarded content owner passes
334 cases, including explicit native SDK save/retry/delete, another signed
browser account, assignee progress/stale revision conflicts, source-bound
recovery, every sharing/privacy flag combination, guarded reset and native
current-schema restore. The whole cross-account lifecycle is measured at 26
caller API/MCP calls, 183,959 bytes and 114.595 seconds, with zero auth-wait
exclusions. Aggregate baseline survives exact content replay/deletion semantics;
no archived participant or inferred successful-work/ROI claim is introduced.
These are synthetic authenticated SQL/protocol/browser proofs, not customer
model evaluation or live SEHA deployment. Phase 05 owns final reruns/cleanup.
