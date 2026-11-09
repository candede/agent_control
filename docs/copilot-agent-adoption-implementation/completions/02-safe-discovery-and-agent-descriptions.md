# Phase 02 — Safe discovery and agent descriptions

## Execution and decision

- Date: November 8, 2026. Phase 02 only; prerequisite phase 01 was accepted by the parent.
- Worker: explicitly launched `gpt-6.1-sol`, `xhigh`; no nested workers, questions, commits, pushes, branches, unrelated reverts, live deployment or reset.
- Repository: `/Users/candede/repos/agent365/agent_control`; initial revision `ebe238cd03acf51a377cd34b1cb9ea40b8fe63a8`. The initially dirty campaign work was preserved.
- Read the complete assigned prompt, README, CONTRACT, AGENTS, installed implement-folder skill and step-worker reference, campaign record and exact phase-01 completion.
- Immutable SHA-256: README `718dfaa8e18406a9d80b1315fdcd68b85b9b7af7210f498266bfdf0493ad32d8`; CONTRACT `17832cfa672dffb325c2ab8e4b5ca88b229ecf66b56b3b61cf00be5782c5d727`; phase 02 `3e753cb59980343b44531cb48306f9e4d5d8b2c4b34b2847287d45a610de6273`.
- Decision: **complete**. All owned phase-02 implementation, mandatory checks and affected real journeys are verified. Eight unrelated pre-existing provider/security browser cases remain explicitly `not_run`; future model/capacity/production proof is not claimed. No following phase has been advanced.

## Hypothesis, reproduction and canonical repair

Falsifiable hypothesis: eligibility filtering was incorrectly applied to individual descriptive sources, dropping a linked shared Graph package's already-saved About even when the canonical native candidate independently qualified.

The cheap query regression initially failed (one failed, six passed). The replacement removes that per-source origin filter, not source authorization. One local backend classification CTE is reused by search, detail, workplace popularity, created-here and the final eligibility fence. There is no second classifier, shadow catalog, generic provenance framework, origin registry, compatibility route or approval cache.

The controlled fixture uses canonical `91000000-0000-4000-8000-000000000001`, Graph package `Evidence-1`, and native resource `92000000-0000-4000-8000-000000000001`. Its native description is absent; the linked shared package contains 28,826 bytes of safe long About, ending `Complete Graph About tail.` The ordinary authorized staff inventory/About HTTP routes read its complete saved chunks. Employee search/detail and subject-bound preview must read the complete permitted Graph text while retaining native `absent` and native-backed organization origin independently. The similarly named, unlinked shared package `Evidence-2` cannot become eligible from that text.

Additional shared cases cover exact report-backed Graph-only Agent Builder `Evidence-4`, report-backed Microsoft `Evidence-19`, authoritative first-party packages without local maker metadata, same names, prefix-only names, unknown/conflicting publisher and report evidence, third-party packages, native-only and empty descriptions, duplicate text, unsafe/native privacy withholding, exact case-mismatched report IDs, source replacement and expiry.

Source generation and canonical publication UUIDs are generated independently per
isolated run. Tests compare every returned origin/excerpt membership to the actual
saved source rows and pinned selection; they are not historical fixed identities
or copied origin approvals.

Report-origin matching preserves exact opaque package IDs, current tenant/set/version/row membership and normal report-source validity. A retained report's null expiry is explicitly unbounded under the existing report owner; finite expiry uses `GREATEST(evaluated_at,clock_timestamp())`. Collection normalization already preserves complete About, package metadata and exact report `creatorType`/ID. No additional provider collection or normalization adapter was needed.

## Contracts, privacy and authorization

- Employee cards require `origin.kind` = `organization_created` or `microsoft`, with exact source, generation, identity, canonical publication revision and qualifying field; report evidence also names its set/version.
- Current native tenant-agent resource type, explicit custom/LOB package type, exact Microsoft publisher/first-party type, and exact supported report creator origin are the qualifying evidence. Sharing, names, prefixes, ownership and package presence are not origin. Competing explicit claims remain unknown.
- All exactly linked permitted sources can describe an independently eligible canonical candidate. Staff inventory/About keeps third-party and unknown coverage; employee catalog and staff EndUser preview do not become a general third-party catalog.
- Source descriptions name `longDescription`, `shortDescription` or `details.description`. Excerpts retain their exact contributing source membership. Missing, privacy-withheld, unsafe-withheld and byte-limit-withheld states are distinct.
- An unsafe or privacy-withheld native description cannot be reconstructed from a safe Graph description. Whole-description withholding prevents that fallback. Empty/absent native text is different and does not discard permitted linked Graph About.
- Existing raw field limit is 4 MiB; total description work remains 16 MiB. Overflow reports explicit `limit_withheld`, not malicious text or successful completeness. The test-only fixture injects extra legal chunks before ordinary publication; published source facts remain immutable and all row, writer, schema and ownership guards stay enabled.
- Existing actor authentication, role checks, subject binding, privacy flags, report/profile/association bindings, current source epoch locks, cursor/response bounds and normal errors remain.
- Supplied selections recheck every pinned source membership at the current clock. Returned description/origin contributors and canonical eligibility are rechecked before publication; each continuation rebuilds current permitted evidence rather than using copied descriptions.
- Canonical authority still expires with its earliest authoritative input. An independently unexpired native raw source does not authorize an expired combined canonical identity. Old access is denied; fresh ordinary source publication yields native-only honest absence. No integrity predicate was relaxed.
- Active roleless members with no saved profile retain automatic application-owned entry and catalog-only reads. The browser now normalizes their location to `/agents`, not a spurious `/permissions` visit. No Viewer grants, manual Sync, license/profile prerequisite, first-party enable switch or acceptance gate was added.
- No application schema or phase-03 content storage was introduced.

## Changed files and cross-root impact

| Root | Phase-02 implementation / verification | Unchanged evidence |
| --- | --- | --- |
| Backend | Discovery SQL/service/current DTOs; query/service/real route tests; shared description fixtures; independent source-expiry and staged-overflow fixtures; existing isolated suite registration and bounded SDK aggregate; restore fixture | Existing canonical source/report/Office owners, normal route policies and provider collectors are reused; no schema/migration/new data owner or HTTP operator exposure |
| MCP | `discovery_models.py`, `tools.py`, `projection.py`, discovery/model tests | Existing transport/tool registration and schema-generated wire fixture consume current types; no dependency or historical measurement baseline change |
| Frontend | Handoff copy/tests; actual `permissions.spec.ts`, `mcpSettings.spec.ts`; App's employee route normalization and session regression | API client already imports canonical backend discovery types; staff catalog implementation remains unchanged |
| Scripts | Backend's existing guarded fixture suite and its tests; corrected current-authority restore setup | Root `scripts/large-tenant-tests.ps1` retains accepted phase-01 changes; no new runner, deployment command or runtime prerequisite |
| Infra | Impact-checked deployment/Entra/DR roots | No service, provider permission, data owner, schema, endpoint, package or environment contract requiring infra changes |
| Root deployment | Docker/Compose/feed/manifests checked | No phase-02 changes to Dockerfiles, Compose, npm configuration, lockfiles, Python manifest/lock or deployment templates |
| Docs | Current data architecture and MCP reference; this record and campaign | Research report, six phase prompts, README, CONTRACT and phase-01 completion remain unchanged |

Principal phase-02 paths:

`backend/src/db/agentDiscoveryQueries.ts`, `backend/src/db/agentDiscoveryQueries.unit.test.ts`, `backend/src/db/agentUsageTestSupport.ts`, `backend/src/services/agentDiscovery.ts`, `backend/src/services/agentDiscovery.unit.test.ts`, `backend/src/types/agentDiscovery.ts`, `backend/src/routes/agentDiscovery.test.ts`, `backend/src/routes/auditOriginHttpTestSupport.ts`, `backend/scripts/discoveryEvidenceFixtures.ts`, `backend/scripts/largeTenantFixture.ts`, `backend/scripts/largeTenantFixture.test.ts`, `backend/scripts/largeTenantRestore.test.ts`;
`mcp/src/agent_control_mcp/{discovery_models.py,projection.py,tools.py}`, `mcp/tests/{test_discovery.py,test_discovery_models.py}`;
`frontend/src/{App.tsx,test/appSessionCases.tsx}`, `frontend/src/components/EmployeeDiscoveryHandoff{.tsx,.test.tsx}`, `frontend/browser/{permissions.spec.ts,mcpSettings.spec.ts}`;
`docs/{data-architecture.md,mcp-reference.md}`.

## Local checks and repaired attempts

| Command / evidence | True result |
| --- | --- |
| Mandated six backend selectors, including `mcpReadContracts.test.ts`, on the host | 95 passed / 5 failed. All five database cases rejected the non-isolated environment before connection. They are included in the guarded isolated run. |
| Five non-DB discovery/query/schema/service/auth selectors, final content | 96 passed, five files |
| Backend/frontend typechecks | Passed repeatedly on final application source |
| Handoff and MCP settings component selectors | 25 passed, two files; included in the larger final affected UI check |
| Handoff, MCP settings, App session/inventory/commands selectors | Final 714 passed, five files. Intermediate 713 passed / one failed exposed the old roleless settings location expectation; normalized the employee location to `/agents` without granting staff access. |
| Required MCP discovery/discovery_models/audience_projection/tools selectors | Final 535 passed; exact collection count 535. Repeated after the final fixture repair: 535 passing markers and successful exit, `artifacts/phase02-mcp-final.log`; Ruff and both mypy invocations passed again. |
| Ruff `check src tests`; mypy (required no-argument invocation and explicit `src`) | Passed; mypy checked 27 source files |
| Frontend lint; Knip; `git diff --check` | Passed. Initial Ruff line lengths and two unused exported helper types were repaired without dependency changes. |
| Final exact non-DB query/schema/service/route/MCP-access selectors | 74 passed, five files; backend typecheck passed after the staged fault repair |
| Last direct runner attempts | A wrong root-level Vitest invocation failed; its auto-truncated external output was not read. The corrected backend-workspace query/service/fixture selection had 82 passed / two failures, both fixture cases rejecting non-isolated host database access before connection. The guarded suites run those cases. No host database was connected. |

The final mandated five non-DB selectors were rerun exactly with
`src/routes/mcpApiAuth.test.ts`: 96 passed (`artifacts/phase02-final-required-five.log`).
Frontend typecheck/lint passed again. A misnamed `npm run knip` invocation failed
before execution; the existing correct `npm run check:unused` passed.

The first MCP attempt encountered one stale historical SDK metadata comparison: phase 01's thirteen approved new operations were absent from that historical baseline. The test now explicitly verifies exactly those thirteen additions while retaining exact historical comparisons for prior operations; the historical measurement file was not rewritten. Targeted SDK metadata/model checks then passed before the final 535-case run.

Isolated failures were retained, not hidden: incomplete new report fixture acceptance needed its Users stage; synthetic inventory selection credentials could not authorize a real staff HTTP About read, so the test now captures through the real authenticated route; an old restore test assumed a retired current Office snapshot remained readable, so it now proves supported current observation/weekly history, denies the retired current ID, and preserves frozen restore/isolation/accounting checks. A coupled import regression was restored. Over-budget fault attempts against a union view, restricted package table and inline non-chunked field failed safely. A subsequent isolated-operator attempt was correctly rejected by the immutable-record trigger; no trigger or grant was weakened. Final test setup injects 512 additional contiguous 8-KiB About chunks into its small synthetic record while staging, then uses normal bounded append, source validation and publication. It verifies the saved field exceeds 4 MiB with every payload below 262 KiB and the normal read returns `limit_withheld` without native fallback. The temporary operator exposure was removed from the HTTP fixture. Exact isolated test-database lifecycle owns cleanup; no published record is edited.

Real SDK aggregate attempts hit the checked runner's 600-second command deadline (`ETIMEDOUT`, no OOM), so full case counts for those interrupted attempts are unknown, not zero/passing. The existing isolated SDK aggregate now has the existing 1,740-second bounded capacity allowance; individual test, retrieval, auth, SQL, source and response limits were not relaxed. Its default non-SDK deadline remains 600 seconds, and process-group timeout cleanup remains guarded and tested.

The former single 480-second test bundled all sixteen role/privacy scenarios. An expanded real run reached that aggregate test deadline (170 passed / two failed, 172 cases; the other failure was the then-unfixed chunk fault setup). It is now parameterized into the same sixteen sequential scenarios, with identical assertions and stricter per-scenario 120-second bounds. No combination or assertion was dropped. Consequently the non-SDK SQL suite explicitly skips sixteen SDK-only scenarios instead of one bundled scenario; all sixteen run in the real SDK suite.

## Guarded verification commands

Baseline arguments for every isolated invocation:

```sh
pwsh -NoProfile -File scripts/large-tenant-tests.ps1 \
  -Suite <suite> -BaselineImage seha-operator:local \
  -BaselineImageId sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63
```

Suites attempted: `mcp-agent-discovery` (required SQL/route/auth/source/automatic-entry/schema/reset/restore checks), `mcp-end-to-end` (real SDK → API → SQL), and `cutover-browser-contract`. Browser arguments:

```sh
-BrowserFiles 'mcpSettings.spec.ts,permissions.spec.ts,agentCatalog.spec.ts' \
-BrowserImage agent-control-ltdp-f33a00de178240c3bfe968b1d1dcdaf2-permission-browser-test:local \
-BrowserImageId sha256:f3a6ff01d12c5d9846ee76f05ef0fcdef2b6ce55f21b8d63a50996b1f53548b3
```

The real browser checks verify both preview/catalog schemas and MCP origin instructions, unchanged staff inventory, roleless first-use handoff, automatic read-only collection without permission/manual Sync visits, current catalog organization origin/`shortDescription`, unavailable saved profile, and denied private inventory access.

Initial browser result: 88 passed / two failed / eight existing parked skips, desktop/mobile employee location mismatch. Two subsequent actual runs: 90 passed / zero failed / eight unchanged skips each. A later loaded run was 89 passed / one failed / eight skips: an existing MCP-instructions screenshot exceeded its 20-second test deadline after its text/visibility assertions. Another actual rerun was 89 passed / one failed / eight skips (226,152.58 ms); its desktop projected-catalog test exceeded the same 20-second bound. The original test bundled metadata projection, three screenshots, schema keyboard inspection, axe, refresh, reload and logout. It now has three independent real authenticated scenarios with the same 20-second per-test bound and every original assertion retained, plus visible-instructions disposal at sign-out. No route interception, runtime authorization, retrieval limit or screenshot deadline was weakened. The final exact three-file rerun executes without the concurrent SDK workload.

Final guarded SQL result: 1,380 passed / sixteen SDK-only skips, 1,396 cases in
36 files. Final actual SDK result: 187 passed in eight files, including all
sixteen role/privacy scenarios and the staged over-limit source. Final browser
result: 94 passed / zero failed / eight unchanged parked skips, 102 cases;
186,518.195 ms, zero flaky cases. The split adds four executed desktop/mobile cases
without dropping assertions. All three final runner commands exited zero.

## Exact content and unchanged-root proof

These hashes bind the final application/test inputs to retained fixture evidence.
Backend discovery, MCP models/guidance and App runtime content are unchanged since
the two passing browser runs. Later changes are isolated fixture setup and the
bounded browser assertion grouping described above. Final SQL, SDK and actual
current-browser-file reruns passed without longer individual deadlines.

| Path | SHA-256 |
| --- | --- |
| `backend/src/db/agentDiscoveryQueries.ts` | `ee561e4a912ad1138c40616ddaf3b43fe9913a6be620adc062d45a6d3238673d` |
| `backend/src/services/agentDiscovery.ts` | `fa3de44336a91198c36e51e32d998bcebddf4fa0b2a967d7c4ad2253ad44a600` |
| `backend/src/types/agentDiscovery.ts` | `27ba49a30732f718a2955b39f2a733f96b5d42fa53ca07376b903703edc89ed6` |
| `backend/src/routes/agentDiscovery.test.ts` | `d4a722f8b0e004da4a914c156734e54bad37394d9b40b4c1d34c516828f05b5a` |
| `backend/src/db/agentUsageTestSupport.ts` | `30fd8db802df75e58808fbfeadb523308f53c64ff7cdc0b20545473aa688f612` |
| `backend/scripts/discoveryEvidenceFixtures.ts` | `b7608ad15b94f414f4eb7bbde665fd2c5ea26f339b4b1dce857a86989a634bea` |
| `backend/scripts/largeTenantFixture.ts` | `4ecc4ef0da6e758a24034dc2d364dfaa04f6cbb9d2aeef4c38e4ee8f89fcbd40` |
| `frontend/src/App.tsx` | `df1607bf7d71d97661447d81db21c4891cf7c1d93096df5cae9dd2bff39db2e4` |
| `frontend/browser/permissions.spec.ts` | `0c6d254933ddd0dc8700cea9cbc68d4797baa2ad226e1ed9e2c8efb6b7a4745e` |
| `frontend/browser/mcpSettings.spec.ts` | `b1ae1c58e8ba6ad900485a41b4a5182eb50c07d548dbe008502c5115965fab5c` |
| `mcp/src/agent_control_mcp/discovery_models.py` | `afd075a1cf10e3527aee4ba9a3c3429c5ea1d9da7ef3edb74cf7ab924771c2c4` |
| `mcp/src/agent_control_mcp/projection.py` | `7b1a95d2bd3aaeb294595a2f3b76c7731c0a9da97ec5d6e87ba7c10f08e972ed` |
| `mcp/src/agent_control_mcp/tools.py` | `cefbeb0d83486add81848d376d9c8e7f74dfdcb5f5dfe2bad4ca6f1ea1980cc5` |
| `scripts/large-tenant-tests.ps1` (accepted phase 01, unchanged this phase) | `9ef66ae84fd42b3049eb0f10e0eb27950e4f7f412f4abc4a8cfde1c5d5c6c116` |
| `compose.yaml` | `dfc140b501be2215a782cc7eb591aab600c59aa29a6e94668718a440d7aed8d7` |
| `compose.mcp.yaml` | `77cb0d18be547fbcd2971ac3b732b09c814d17425c70668e4fbe4f500893d4cd` |
| `compose.mcp-metadata.yaml` | `d3a9413b7db61fa450b1ec3258a6c17e86d40631e97c21c153341ed3049129b8` |
| `compose.large-tenant-test.yaml` | `b8c10339b4ba7650c443b894ebbf91d7cb98737a2b50b97da9ee66c6395a9da5` |
| `Dockerfile` | `2872e4485b7d72f58b8b50702ef6be2b89f81eb6a8a200ace31a694e3cbd63a5` |
| `mcp/Dockerfile` | `a7bb39c0cb96b7e9d5ff200d76799b597a0c04c890ecda8075466fa9d281ba62` |
| `.npmrc` | `84be34acf35147adfefc880804932f02ce40d8459955358b701748ac4e5aca69` |

`git diff --name-only -- infra Dockerfile mcp/Dockerfile compose.yaml
compose.mcp.yaml compose.mcp-metadata.yaml compose.large-tenant-test.yaml .npmrc
package.json package-lock.json backend/package.json frontend/package.json
mcp/pyproject.toml mcp/uv.lock` returned no paths. These roots have no additional
origin/source/privacy DTO owner; canonical backend/MCP types remain the shared
consumer boundary.

## Environment, protected identities and ownership

- Host: macOS; Docker `desktop-linux`; Node 24.22.2; MCP `.venv` Python 3.14.10. Fixture Node is 24.20.0; SDK Python image is pinned 3.14.6. All are within declared supported ranges.
- Protected installed operator remains `seha-operator:local`, `sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63`, arm64. It was never overwritten.
- Pre-existing approved browser remains `sha256:f3a6ff01d12c5d9846ee76f05ef0fcdef2b6ce55f21b8d63a50996b1f53548b3`, arm64; runner verified actual locked Playwright/core/browser compatibility, version 1.58.2. It is not a phase-02 cleanup target.
- Four Node manifests matched the protected baseline before reuse: root package `289b6aa00bdea3224fcdedcd1a5eb5f768cacf4ade5b0547590b07ba94b6366f`; lock `26b9ad497e8766e1ce8a3da1852bbbdfe49b076a23ff910040894441e6201bc5`; backend `036fc5fc64e0e45aa15afec7b5c7cbc1a2eaa40eda6063c5ea44e21518abffd9`; frontend `aecde6451f83aa45e284fbeac06251f7be2bd5f64fb9aa75ccc2a6bb25999785`.
- Python manifest `3d874de6d80d18c84a7cc1ce493aa0bbf5f1dd599da18f9bb13aa3383630c6e8`; lock `7b1460caa5f3e48b511090817f27188b7a4f43c0145f3747ede7a1477d196bda`; no dependency change/host restore. All fixture subprocess/package access stays on the approved npm/Python proxy feeds; no public fallback or npm install.
- Live app/MCP/Postgres images remained respectively `sha256:f9f58d2d4b2cfa10af311d951cf8dbd50518722e16541ab1de6d2bbef6ddfe80`, `sha256:91a8bc2ff12f49ab4a652da7c5774cfe486a68c32a5b354652d24cc9c5dfc7d8`, `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`; read-only inspected running, not mutated. `automations-mcp-ui-dev` is untouched.
- Every integration project is uniquely campaign-owned `agent-control-ltdp-*`, with named isolated database/volume/network and guarded finally cleanup. Persistent evidence is under `artifacts/large-tenant-data-platform/<project suffix>/`; secrets are not copied into this record. Only exact newly owned image tags are eligible for removal; no broad prune/delete.

Completed intermediate projects below have zero exact project-labelled containers,
volumes or networks. Their one exact `-operator:local` or `-sdk:local` tag was
identity/arm64-verified and removed with `docker image rm --no-prune`; protected
operator/browser identities were rechecked unchanged. Artifact directories retain
the exact baseline, workload logs, state/resource observations and SDK/browser
identity proofs.

| Exact project suffix | Owned image SHA-256 | Outcome |
| --- | --- | --- |
| `1a203b9977eb4e38903750183c182c6d` | `af21eb4f3c9be9461246f75f615f4f77c44b0e893e64becf4dcec887b973a03d` | SQL: 1,374 passed / three failed / one skipped; cleaned |
| `6bf5f8c864384b2699c9b8797609a2de` | `20b0d8acc4261ad0ebb6a7974ee732274aeb0cb6ef033fefeba026cb074fa78e` | Browser: 88 passed / two failed / eight skipped; cleaned |
| `7165d1973ec24791b31d42968b030c4e` | `0e014115006916a065d674a79557a3db856cba4e4f4650e7a74f1366c2e4f83b` | SQL: 1,375 passed / three failed / one skipped; cleaned |
| `762db0eab29b478e86c98963005506ac` | `940dfc5631eac7b09af5d1f910b4838c5429b94653dee302fcef720abb0ebf84` | SDK: interrupted at 600 seconds, full counts unknown; cleaned |
| `805b7a125a844743b0bac5f065057872` | `1036713168b780dc19d1df20910b67e064feac33bd1162cfd9a5065b8bcc4b60` | Browser: 90 passed / zero failed / eight skipped; cleaned |
| `b6720fde055a44619567123706da2101` | `9da02daf42a57871af65fa914f39991710d46f374b1b919b33730a7a83e6f195` | SQL: 1,376 passed / four failed / one skipped; cleaned |
| `7ed373b22b4e4bd4845cac74361e444b` | `2ab1f43f24bd32a5f6e7585fb804b05ac88696469f9bf1fbf40edc725d3a6c38` | SDK: interrupted at 600 seconds, full counts unknown; cleaned |
| `2f52b32b91734586b343d24736589de8` | `5885c81cb729cb159ddb12b6599331f419d52b5fc17092705d97f1b3cddb457f` | Browser: 90 passed / zero failed / eight skipped; cleaned |
| `47afb9493086425cac0b022f6ad11089` | `e82e0988a1ef532c141ad15c34cd8bd38f9f651924ded45c66afe24a15eab137` | SQL: 1,376 passed / four failed / one skipped; cleaned |
| `b3f3bf014e6d4b85a5fcd5c56f099963` | `cd20d77a662e87261e5d8d658d9ac92b47e35add8e7f2ff9bcb438e7abe22a3b` | SDK: interrupted at 600 seconds, full counts unknown; cleaned |
| `f0bc3af2d22e486b9453b358636f392f` | `69f405e007d037e29065e3e8b2c1f27da505d185444e0e4d51ac89d291e53206` | SQL: 1,376 passed / four failed / one skipped; cleaned |
| `fbfef8c0edb249ff889e0f2bdae25a23` | `0dd2906156fb8d042a34899f5c9984771826b38b9042c3a54383ea99b54302a3` | SDK: interrupted at 600 seconds, full counts unknown; cleaned |
| `4fa64602d37845538cb31f574e47c3d8` | `b455fa3520de7bd694616d68ede075488f77080edd1c534f98123aed24961a14` | SQL: 1,376 passed / four failed / one skipped; cleaned |
| `5412c2adfbdc470eb9bd166158821942` | `29d84aae39ecddca714775693e7b9b920f30edb49b0ebcaca597b9dad30faa8b` | SDK: interrupted at 600 seconds, full counts unknown; cleaned |
| `c266cbf6e1814bd7977f665e5ee6b413` | `fc853200234f6d6537056acb265cd2f7482d593ecfda3245652680dab4abb835` | SQL: 1,379 passed / one failed / one skipped; cleaned |
| `001528a8b4b041e394e21a30ff41554b` | `aeaaa39c8d43b43072393fe44130dfc4a7d48de8137ef018bb024d8ecc0c89b2` | SDK: interrupted at 600 seconds, full counts unknown; cleaned |
| `ce949d116ad14b67baef0d2b201700e9` | `6ad4e0d388c6fb9744a1da40f45b8ec67df5441021cd158326ca00be0ea14674` | Browser: 89 passed / one screenshot timeout / eight skipped; cleaned |
| `83b18a4ac1fd4be8bbd1368972162d96` | `73118ed005f0f350b0c430f4874edbea24d14eff250c11d9070507702789fce4` | SQL: 1,379 passed / one failed / one skipped; cleaned |
| `6ab2d644ff1047bcba163680186e17e9` | `d27f945f56a340c988cf633c114161a5e7e7c480ac0be8ead3ca1ce699231271` | SDK: 170 passed / two failed, eight files; cleaned |
| `4315d8c153b245aaa590120e95aec8c4` | `701d25e74b9f148df4839f125c7a2e826d795573449adfa27ab0295167f63a05` | SQL: 1,379 passed / one immutable-fault failure / one skipped; cleaned |
| `c968fc0ca64446ebb767d79ccd2872c7` | `a944e3f41d526bbe1c32b347e887c49331fcb524b59474352d6b0d41d2b64715` | SDK: 170 passed / matrix deadline and immutable-fault failures; cleaned |
| `88cf767fb94744819d7cc221a6eda822` | `c6f18739e15542d1aa063b5ba513676298dee8ec29d526437b312aa94355d21b` | SQL: 1,379 passed / one immutable-fault failure / sixteen SDK-only skips; cleaned |
| `444bb09199fe4b37857b20257d5add2f` | `8d1a4bd85b99fe5204f667463392786740fb7dcb53d71f9a1b68275712df9560` | SDK: 186 passed / one immutable-fault failure, 187 cases; every parameterized role/privacy scenario passed; cleaned |
| `ab206340fc1a4933aa85d44ece9be80c` | `7220d6dc86de0d726678ae821d9b93e016e00ba53c98330c765ed4ecfb5c15b8` | Final SQL: 1,380 passed / sixteen SDK-only skips, 1,396 cases / 36 files; exit zero; cleaned |
| `86fdbe55d1614923bf8cc44aa2788de5` | `987d7b5cb88d4c25b75d189e026d572390fe4dc006160352c5838c7bc54d3e6b` | Final real SDK: 187 passed / eight files, zero skips/failures; exit zero; cleaned |
| `096e455055fb4db8b49c87a4ae513f15` | `5b50683223b3b68242fc18a8c0955ae9636cd4544515b8445b2197f9a9f0bb66` | Browser: 89 passed / one bundled-test timeout / eight skips; SDK companion cleaned |
| `1f65d95e026746d7bf498a56fbd8856a` | `e2a9fa2061bc19c4633cfd9d7563c49d1b806c6bd3c59b71fbdf8bf9ba7a377d` | Final browser: 94 passed / zero failed / eight unchanged skips; exit zero; SDK companion cleaned |

A broader exact-owner `io.agent-control.fixture` check found four completed
browser projects' additional operator companion tags that the initial SDK-tag
cleanup had missed. No container, volume or network remained. They were
name/identity/arm64/owner-verified and removed exactly with `--no-prune`; the next
exact-name and owner-label scan must be empty. The final SQL operator has no
optional image-label property: its successful guarded `result.json` and exact
generated project/tag identity establish ownership, not an invented label gate.
One inspection attempt stopped on that absent property; exact-tag removal then
completed and the protected installed identity was rechecked unchanged.

| Completed browser operator companion | SHA-256 | Outcome |
| --- | --- | --- |
| `6bf5f8c864384b2699c9b8797609a2de-operator:local` | `40809ff1cf978c3dbd87497c839e0daf91cec49afbe5442735e58b9177492267` | removed exactly |
| `805b7a125a844743b0bac5f065057872-operator:local` | `dac219f5c07728c18b95dc50cd77b27537fc438f91cd1f9f4327acaf9a2651d8` | removed exactly |
| `2f52b32b91734586b343d24736589de8-operator:local` | `6947b914eb2f5073455517fdfcbcb087241473fd6e2b42e67ec84a65df8e74e0` | removed exactly |
| `ce949d116ad14b67baef0d2b201700e9-operator:local` | `b3f068257460671b8686020ea459b6793712da83e203f9320668f57358723270` | removed exactly |
| `096e455055fb4db8b49c87a4ae513f15-operator:local` | `4ef9222c7ca4cf82aeb4b7280dec07ad8f07294b8422010a52bf2fc68ef354c2` | removed exactly |
| `1f65d95e026746d7bf498a56fbd8856a-operator:local` | `644650124a8a2f19a149d41abfc7498586c8dcdf581937269d7ab0fe2a5e39d8` | removed exactly |

The final exact-name scan additionally identified ten SDK dependency operator
tags whose optional image labels were absent. Their completed guarded project
records, exact generated names, identities and arm64 architecture were checked;
all ten were removed by exact tag with `--no-prune`. These cleanup incidents remain
owned here and are not hidden by a narrow label-only scan.

Final verification completed with exit zero: all **27 exact phase-02 projects**
have zero named or `io.agent-control.fixture`-labelled containers, volumes,
networks or images. All **43 exact owned image tags** are removed. Protected
`seha-operator:local` and the pre-existing approved browser still have their exact
original arm64 identities. All six Node/Python manifest/lock hashes and all eight
roadmap hashes were rechecked unchanged. Live SEHA app/MCP/Postgres retain the
recorded running image identities; all five `automations-mcp-ui-dev` containers
remain running and untouched. No broad prune, live mutation, reset or deployment.

| SDK dependency operator tag | SHA-256 | Outcome |
| --- | --- | --- |
| `762db0eab29b478e86c98963005506ac-operator:local` | `b646c5b3d2a589d6b3c85adb91893a8e9e0224d4280ace19d631f1836b98319c` | removed exactly |
| `7ed373b22b4e4bd4845cac74361e444b-operator:local` | `d27e0714387b5c623a0ce89eb3527da79cf9fec522d703413b3431deba12817b` | removed exactly |
| `b3f3bf014e6d4b85a5fcd5c56f099963-operator:local` | `a22ffc23c6bbd7eb1363f56b09f6300d697576c676193b501ae87bd984f54422` | removed exactly |
| `fbfef8c0edb249ff889e0f2bdae25a23-operator:local` | `29508bf934604883e5b97d4709295c771df14ea426817b718fde95e2ca519a7c` | removed exactly |
| `5412c2adfbdc470eb9bd166158821942-operator:local` | `698d8477cca0884f981df3b354fe4c5f810078309a48c03af661ecb1305c3f25` | removed exactly |
| `001528a8b4b041e394e21a30ff41554b-operator:local` | `c2246581a464704c6dee5ed17f793f08e9397dc8e49d04678ba550013dd561bd` | removed exactly |
| `6ab2d644ff1047bcba163680186e17e9-operator:local` | `b056c076148dd601371fcb2005a6dab3f6dc8d947b65066179c72fb15fc366f5` | removed exactly |
| `c968fc0ca64446ebb767d79ccd2872c7-operator:local` | `db0db1fa9b0c69af44a0b2ca9bbf8770db9392819b49c24cb6480c1ebe3c662f` | removed exactly |
| `444bb09199fe4b37857b20257d5add2f-operator:local` | `2c44a7f3f9e9945787739e797ab01da7128eb8d0fd58c8182b9e4c3de756f8a0` | removed exactly |
| `86fdbe55d1614923bf8cc44aa2788de5-operator:local` | `5c2df10fd8b30f48824c8ad03d5fd56271d74861d2fed938fb480eb1d6f2ebab` | removed exactly |

## Residuals and next action

| Scope | Existing containment and signal | Numeric threshold / owner / exact trigger |
| --- | --- | --- |
| Production rollout/actual provider journey | Phase 02 did not deploy/reset. Current live installation is unchanged; isolated success is not production proof. | Phase 06 owns authorized exact SEHA deployment/observation. Any one hidden disclosure, stale source access, fabricated origin or failed automatic first-use event requires root repair, exact redeploy and re-observation, not a release approval gate. |
| Configured consumer/model workflow | API owns origin, privacy, current source fences and explicit completeness; models cannot grant access or reconstruct withheld content. No real model/Studio interoperability/use/ROI proof claimed. | Phase 05 owns configured-consumer repetitions. One fabricated identity/access/count/outcome, hidden disclosure, source instruction execution, unrequested mutation or success-shaped incomplete retrieval requires fixing the canonical boundary/guidance and rerunning that scenario. |
| Representative capacity | Existing SQL/response/cursor/4-MiB-field/16-MiB-work limits and explicit states remain. Controlled saved-source behavior is new proof; broad Office fixture size is not warmed discovery p95 proof. | Phase 05: at least 10,000 people/500 groups and 20 warmed reads; p95 >2 seconds, compact page >128 KiB, or workflow >32 calls/4 MiB/180 seconds triggers exact plan/owner repair and rerun. Measurements not made here remain unknown. |
| Parked provider/security browser cases / fixture bounds | Eight pre-existing cases remain `not_run`: log setup/blocker links, selected identity resolution, Purview audit and fixed-template Defender hunting, each desktop/mobile. They are not phase-02 discovery/About implementation. Existing explicit/scoped/content-free provider permissions and operation controls remain; all 94 current executed browser cases and all 187 SDK cases pass. | Phase 05 verifier owns applicable provider-selector coverage. Any one affected assertion failure, hidden disclosure, automatic hunt or out-of-scope provider call triggers the exact root repair and selector rerun; SDK aggregate >1,740 seconds triggers focused fixture diagnosis without dropping privacy/cases. No runtime enable/approval gate. |

Phase 03's observable preconditions are accepted phase 01 plus verified current safe canonical discovery, honest privacy/absence/limit states and exact selected-source bindings from this phase. It may reuse those for card references/privacy, not copied origins/descriptions or approval tables. Phase 03 remains pending for the parent. Always-Deploy remains binding: phase 05 attempts integrated checks; phase 06 performs authorized actual SEHA convergence and fix-forward, with deployment/proven-journey uncertainty stated honestly.

## Phase 05 integrated capacity evidence

The current existing runner proves 10,000 frozen people, 500 exact groups,
duplicate company/department/display labels, ambiguous identity and overlapping
reports. Five warm-ups and twenty measured correct SQL/HTTP and native SDK reads
pass: HTTP nearest-rank p95 812.052 ms, SDK 1,072.719 ms, API 21,133 bytes,
MCP envelope 45,703 bytes. Complete three-peer/three-agent retrieval uses 15
calls/92,843 bytes/77.162 seconds; exact Microsoft/local origins, created/used
edges and full 7,022/372/372-byte descriptions are checked, not clipped text.
Explicit brief save completes at 16 calls/120,593 bytes/84.623 seconds.

The preserved original larger case achieved 100,000 people, 200,000 canonical
agents and 1,000,000 edges, but all four query shapes failed before any warm or
measured read with PostgreSQL `57014`; p95 is unknown, not zero. Its 1,703-second
guarded attempt and every failure are retained. No fixture size or performance
threshold was reduced. Existing statement/selection/source limits bound the
failure rather than inventing success. Backend discovery-query ownership must
fix forward on any `57014` or measured p95 above 2 seconds, using this same
source-fenced runner and query-plan evidence; this is a scoped higher-scale
performance residual, not a runtime enable or phase-06 deployment approval.
