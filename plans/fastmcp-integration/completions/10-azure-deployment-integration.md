# Phase 10 — optional Azure MCP deployment integration

## Phase Result and authority

**Final: source implementation, deployment mocks and real SDK/emulator
verification complete after the parent-resolved Blob-lease repair below.**
Actual Azure deployment/identity/network/durability qualification remains
unavailable. This is not a production release or campaign acceptance.
The initial candidate narrative through “External owners and11/12 handoff” is
retained historical evidence, **superseded by the final bounded repair record**.
Its NFS configuration and unresolved architecture are not current contracts.

- Assigned phase: [10](../10-azure-deployment-integration.md), position7/9.
- Repository/application root:
  `/Users/candede/repos/agent365/agent_control`, including backend, frontend,
  MCP, deployment and operations.
- HEAD: `d3a82a8d7673cb55300b6ab30fc3848d40554015`; no commit, push or branch.
- Worker: `bcd9e405-570d-4839-9f50-45f5986486f2`. The visible agent registry
  confirmed actual model `gpt-6.1-sol`. The parent supplied the explicit `xhigh`
  launch contract; the worker registry does not expose an independently
  introspectable effort field. Parent launch-tool arguments remain the effort
  evidence; no prompt-only runtime change or independent effort measurement is
  claimed. **No nested agents were launched.**
- Read root instructions, ordered README, implement-folder skill/worker contract,
  parent campaign,05/08/09 records, phase10 and its Azure/recovery owners.
  Existing uncommitted work, parent campaign and historical records were retained.
- Authorized actions were source edits, public product research and local
  synthetic/mock/static checks only. No Azure login/account/resource/secret read,
  cloud what-if, registry publication, resource/identity/grant/network/storage
  provisioning, public ingress, real Entra/provider action, paid model or
  production/settings/volume operation occurred. No real secret/environment file
  was read.

## Implemented flow and exact contracts

The existing version-2 target, command dispatcher, deployment operations,
artifact/receipt/resume and recovery owner remain authoritative.

1. Missing `mcp` provisions nothing. Supplied null/false/empty/partial/unknown,
   malformed, wrong-case or inconsistent configuration fails. The example is a
   non-authorizing fragment, with deliberately incomplete references/prices.
2. `-Component All|Application|Mcp` defaults toAll. Application cannot silently
   ignore supplied MCP configuration. MCP-only Plan/Deploy/Recover never builds,
   deploys or stops API/web, reads API secrets, consumes an API ZIP/authentication
   smoke receipt, or restores/switches PostgreSQL. Exact existing MCP `Stop`
   supports the approved backup/drain window without changing the application.
3. The MCP contract pins separate S1 site/plan, one worker, ACR repository/digest
   and existing digest, UAMI resource/client, tenant/API/client/origin/resource,
   callback and exact1–32 redirects, private NFS/share/marker identity, independent
   current/selected secret versions, ingress/egress, monitoring owner and
   separately itemized incremental cost within the existing approved budget.
4. The UAMI supports only exact-registry AcrPull and Key Vault Secrets User on
   the three exact MCP secret scopes. Both descendant and inherited
   subscription/management-group assignments include group membership.
   Broad/custom/API/SQL/tenant-secret access is rejected; enumeration failure is
   not treated as a clean identity. Registry repository-ABAC is outside this
   explicit AcrPull profile.
5. `infra/main.bicep` remains unchanged and API/PostgreSQL-only. One separate
   `infra/mcp.bicep` is applied through the existing owner after API/web reopens.
   It creates only MCP plan/site, per-secret runtime grants, diagnostics and four
   finite alerts, using existing prepared registry/UAMI/vault/network/storage/
   workspace/action-group identities. No second deployment path was retained.
6. Native immutable Key Vault references supply the three independent values in
   memory. MCP raw secrets/storage keys are not parameters, arguments, logs or
   receipts. Local protected-file mode remains the default; mixed/unresolved
   Azure/file settings fail, without plaintext or ephemeral-storage fallback.
7. Python's explicit Azure profile requires UID10001, the actual writable
   `nfs`/`nfs4` mount and exact source at `/mounts/mcp-oauth`, the prepared
   protected `/identity` GUID, and existing `/oauth`. Existing owned0700/0600
   protections, maintained FileTree/Fernet/MultiFernet encryption,24h retention,
   4096 files/64MiB/256KiB-record limits and binding remain intact.
8. Updates stop the exact MCP site, verify Stopped, wait75s, apply, independently
   start and verify. Receipts bind exact target/component/artifact/digest/
   versions/storage. Completed apply is not replayed; start is repeatable.
   Uncertain ARM apply stays non-replayable through repeated resume failures.
   Repeated MCP retries retain full API-success status and never enter API
   maintenance/containment. Even a post-MCP receipt write failure leaves the
   verified API/web online and emits an explicit reconciliation error.
9. Verification checks observed image, mount, native references, exact runtime
   API/resource/redirect/drain settings, ingress/egress, diagnostics/alerts,
   readiness and actual SDK issuer spelling. Authenticated API reachability,
   Azure persistence/restart and streaming remain explicitly `not_proven`.
10. Authenticated diagnostics adds bounded file/byte usage with redacted503
    failure. Existing normalized logs and runbooks assign concrete owners and
    limits for OAuth/auth, API/provider errors, unknown writes, authorization
    waits/queues, disk, latency/CPU/memory/restarts and actual/forecast spending.

No business DTO/tool route,124-tool catalog, browser CSRF/Origin policy, API
audience, provider credential owner, current schema, job/audit/receipt authority
or automatic first-sync behavior was changed. No compatibility layer,
migration/reset fallback, second domain store/queue/scheduler or runtime
qualification/feature-enable artifact was added.

## Design falsifier, decisions and necessary complexity

**Falsifiable hypothesis:** App Service's supported Linux storage can preserve
the existing protected encrypted file backend without weakening its POSIX guard.
Checking current primary Linux documentation/ARM schema before adding a backend
was cheaper than inventing a storage platform or assuming Compose proves Azure.

The Linux-specific guidance now explicitly supports **Azure Files NFS**, and
the2024-11-01 ARM schema exposes `protocol: Nfs` separately from `type: AzureFiles`.
NFS documents POSIX UID/GID semantics. Consequently this source profile reuses
the maintained encrypted backend instead of adding Redis, SQL, Blob/Table
orchestration, a distributed lock service or another dependency.

This is **not SMB or built-in `/home`**. The prepared same-region premium
FileStorage share must have RootSquash, public access disabled, a same-VNet
approved file private endpoint and delegated integration subnet. App Service's
current NFS requirements disable **Secure transfer required**. This requires
explicit exact-target private-transport acceptance, effective private DNS/NSG/
routing and a dedicated trusted network. NFS AUTH_SYS/UID is not managed-identity
user authentication. Encrypted records and Azure encryption at rest do not
magically supply transport authentication.

Primary product evidence:

- [Linux storage guidance](https://learn.microsoft.com/azure/app-service/configure-connect-to-azure-storage?pivots=container-linux)
  and its [Linux-specific source](https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/app-service/includes/configure-azure-storage/azure-storage-linux-container-pivot.md).
- [NFS POSIX/identity behavior](https://learn.microsoft.com/azure/storage/files/files-nfs-protocol).
- [ARM protocol definition](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/web/resource-manager/Microsoft.Web/AppService/stable/2024-11-01/CommonDefinitions.json).
- [Custom-container persistence and update behavior](https://learn.microsoft.com/azure/app-service/configure-custom-container?pivots=container-linux).
- [Health-check behavior](https://learn.microsoft.com/azure/app-service/monitor-instances-health-check)
  and [metric-unit clarification](https://learn.microsoft.com/en-us/answers/questions/1551682/what-is-the-unit-for-health-check-metric).

App Service warns against applications depending on persistent file handles/
locks. No filesystem lock or embedded database was added. Stop-before-update
avoids the documented owner-managed old/new container overlap; it does not
establish fencing during automatic platform replacement.

### Decision Needed — narrow Azure-only boundary

**Can the approved App Service hosting profile provide a supported exclusive
writer/no-overlap guarantee across platform-initiated worker replacement?**
One site/worker and no slots/autoscale are not fencing primitives. The current
public guidance does not establish that guarantee. A successful local mock,
Compose restart, Azure mount probe or one sampled restart cannot prove it.

Parent/hosting owner must obtain the supported platform contract, or explicitly
authorize a maintained fencing/backend adjustment inside the approved encrypted
connection-state architecture, before calling this Azure writer design qualified.
Do not weaken permissions/encryption, use ephemeral OAuth state, invent another
platform or add a “qualified” flag as a substitute. The implemented source
profile and prepared NFS candidate are not live certification. This decision is
not an API/web or later Compose release gate.

Necessary additions are limited to the separate template/target fragment,
existing-owner MCP operations, explicit native-reference/mount guards and usage
diagnostics. An initially considered optional module in main Bicep was removed,
leaving one actual MCP deployment path. A broken dependency on Bicep being
preinstalled in the cached Azure CLI container was replaced with the existing
owner invoking a standalone local compiler.

## Root impact and changed files

| Root/surface | Current result |
| --- | --- |
| Deployment | `deploy-azure.ps1`, `scripts/azure-deployment.ps1`, existing mocked test owner; optional component, exact contracts, contained/repeatable recovery |
| Infrastructure | New `infra/mcp.bicep`, `infra/mcp-target.example.json`; related `infra/disaster-recovery.md`; `infra/main.bicep` and existing per-secret grant module remain unchanged |
| MCP runtime/tests | `config.py`, `service.py`, `test_config_storage.py`, `test_oauth.py`; still19 production modules and unchanged dependency manifests/lock |
| Backend | One stale documentation assertion in `mcpContractFeasibility.test.ts` aligned to the current shared Jan→Apr unequal-window corpus; no runtime/SQL/schema/provider/identity edit |
| Frontend | No edit required: no browser consumer of Azure secret transport or MCP-only diagnostics; canonical API operation/DTO/browser authority unchanged; type/build/lint passed |
| Current contracts/runbooks | `README.md`, `docs/{azure-production-deployment,deployment-setup,mcp-integration,operations,security-model}.md`, recovery doc and this record |

Producer/consumer tracing covered target→preflight→Bicep→native settings→Python
mount/secret configuration, deployment→receipt→resume/rotation/recovery and
diagnostics→operator responses. Node's tenant-registry integration remains the
binding API owner. API-only/no-MCP behavior, current-only schema construction,
local container/file configuration and independent browser build remain tested.

## Actual validation

Host tools: Python3.14.6, existing MCP venv, Node24.18.1 and PowerShell7.
No npm/Python dependency installation or manifest/lock change occurred.
Approved feeds remain exclusively the Microsoft npm/Python proxies.

| Actual command/scope | Result |
| --- | --- |
| `pwsh -NoProfile -File scripts/azure-deployment.tests.ps1` | **282 command-level assertions passed**; original190 baseline passed before implementation. Mock Azure only |
| `pwsh -NoProfile -File scripts/local-deployment.tests.ps1` | **1,375 assertions passed** |
| `pwsh -NoProfile -File scripts/local-runtime.tests.ps1` | **315 assertions passed**, mocked Docker |
| `pwsh -NoProfile -File scripts/local-mcp.tests.ps1` | **67 assertions passed**, mocked Docker |
| `pwsh -NoProfile -File scripts/fresh-installation.tests.ps1` | **112 assertions passed**, mocked resources |
| `cd mcp && .venv/bin/pytest tests/test_config_storage.py tests/test_oauth.py tests/test_container_contract.py --basetemp=../.local/phase10-focused-final2` | **89 passed**,12.24s, no skips |
| `cd mcp && .venv/bin/pytest --basetemp=../.local/phase10-python-final2` | **561 passed**,198.60s, no skips; real pinned SDK with synthetic upstreams |
| `.venv/bin/ruff check src tests`; `.venv/bin/mypy src` | Passed;19 production source files |
| Ruff format check on the four changed Python files | Passed;4 already formatted |
| `UV_CACHE_DIR="$PWD/../.local/uv-cache" UV_PYTHON_DOWNLOADS=never uv lock --check --offline --index-url https://packagefeedproxy.microsoft.io/pypi/simple` from `mcp` | Passed;82 packages, no install/network fallback |
| `npm test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/delegatedCredentials.test.ts src/auth/requestPrincipal.test.ts src/auth/msal.test.ts src/routes/mcpContractFeasibility.test.ts --reporter=dot` with approved registry | **214 passed /5 files**,1.85s, no skips |
| `npm run check:unused`; both workspace typechecks; root `npm run build`; frontend lint | Passed. Vite's existing >500KiB chunk warning remains a warning, not a failed build |
| Standalone `bicep build infra/main.bicep --stdout` and `bicep build infra/mcp.bicep --stdout` | Both passed;0.48.1 `(cec7951cf6)` |
| Compiled-template assertions | Main has no MCP parameter/resource path; MCP only its own resource scope, one worker, native identity, no storage-account key or PostgreSQL resource |
| Editor diagnostics on changed runtime/test/deployment/template surfaces | No errors |
| Local Markdown file/anchor check | **82 links /8 affected documents**, zero failures; `artifacts/phase10-doc-links.json` |
| Public primary product URL checks | **10 passed**, zero HTTP/redirect failures; only public URLs sent, no workspace contents; `artifacts/phase10-public-links.json` |
| `git diff --check` and explicit changed/untracked-source whitespace checks | Passed |

PowerShell counts total **2,151 mocked assertions**, not cloud/container proof.
The new cases include absent/invalid targets, digest/tenant/redirect/secret/
network/storage/role mismatches, no API ZIP/secret/Docker dependence in MCP-only
CLI, all component sequencing, each independent rotation, stop/recovery,
repeated partial resume, uncertain apply and post-MCP receipt-write failure.
Python checks exercise actual SDK issuer/resource/forwarding behavior and both
old protected-file and explicit Azure configuration guards.

### Failures and repairs retained honestly

- Cached `mcr.microsoft.com/azure-cli:2.77.0`, exact image
  `sha256:d41153958a61392a4c9db1591e33b533ca8ab8b59529d212d06bb6ec7e9c1f25`,
  reported Bicep absent in an offline/network-none invocation. Host `az` and
  `bicep` were initially absent. After this genuine missing-tool failure, the
  official standalone macOS ARM64 compiler was downloaded to
  `.local/phase10-bicep/bicep`; both local compilations passed. No Azure
  authentication or resource access occurred.
- The existing mock serializer lost empty/singleton arrays through pipeline
  JSON serialization; repaired it to serialize the actual input object.
- A first issuer fixture omitted the real SDK's trailing slash; corrected from
  observed SDK discovery, without relaxing exact issuer equality.
- Resume initially skipped starting the contained service and could lose
  partial API-success identity across retries; separate repeatable start,
  preserved statuses/uncertainty and regressions repaired these findings.
- A receipt-failure fixture initially used a directory that PowerShell treated
  as a move destination; corrected to an actual unwritable parent-file
  condition. API/web-independence regression then passed.
- The backend selector initially produced213 passes/one stale Jan→Mar/Apr
  documentation assertion failure. Current shared corpus/document uses
  Jan→Apr; repaired the single owning assertion, then all214 passed.
- Full-repository `ruff format --check src tests` found two **pre-existing**
  formatting differences in unchanged `test_container_contract.py` (quote
  spelling/line wrap). They are not phase10 runtime defects and were not
  silently changed. All four phase10 Python files pass formatting; global Ruff
  lint, strict types and all561 cases pass. Parent may handle that unchanged
  cosmetic residual in the appropriate owner; no exclusion was added.

No actual SQL/container/client/provider journey was newly claimed here.
Phase09's647 read SQL/695 control SQL counts overlap and are not added; its
5,150 frontend cases and phase08's actual local lifecycle remain historical
source/environment-bound evidence only. **Changing two production Python
modules invalidates reuse of08's image digest as proof of the new contents.**
Phase11 must build/source-bind and exercise a current image/operator.

## Content identities and persistent evidence

`artifacts/phase10-source-hashes.json` freezes42 required/current input,
implementation, manifest and contract hashes, including the external skill/
worker contract and unchanged parent/05/08/09 records. It deliberately excludes
this record to avoid self-reference. Selected exact current identities:

| File | SHA-256 |
| --- | --- |
| Phase10 prompt | `c394f729d0575c70d420aa813dac4d3b3ff826d87d819c53d07885459f033cd0` |
| Plan README | `40fdb91510ba7d8a8c0c844bf3bf0405f87384aaf214c829cb0ccfee8561ad71` |
| Root AGENTS | `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e` |
| `README.md` | `e3b84f4dca8497158ce547f5e0d3bc71bc0ad91cb7e2d44af0cc23aa09ac6ff7` |
| `deploy-azure.ps1` | `ada95bb43607ea15ec112e3ae521b0be005c15307ad72d8c5e5f700cf00313dc` |
| `scripts/azure-deployment.ps1` | `0bc1566c7be72ae3a4308fd120a7b9cbb9889dcd788a1dc458dfddfb6042eebd` |
| `scripts/azure-deployment.tests.ps1` | `76253586966558198df1914f8cf7f7112fb162a1f212c9f4c3ff28d4e7357434` |
| `infra/mcp.bicep` | `7a5daf6d2a8d4d790f5c04f224ca684e691330fb0ee8d6aeef2269b3c8246a82` |
| `infra/mcp-target.example.json` | `7576a1cf968cd37f04f5ab88c12a74a0f3884a37b14a14089d39f67b6c25f90a` |
| `infra/disaster-recovery.md` | `908f4aa329b6d808853303fe3539c36d5dde9e2d337c7df59090275f7a94b82c` |
| `mcp/src/agent_control_mcp/config.py` | `5003d5c34eed6fed5c840d5c57b3678eb321f0c9c3d64768082bec42ae9af895` |
| `mcp/src/agent_control_mcp/service.py` | `fa466b2b184b711656d7ee2d1b1b83ff6e42991ac3fc66f5fd2825d832f7e89f` |
| `mcp/tests/test_config_storage.py` | `7880873b3cc0948375a8044c62650e09e8968c816bfaaaeb6c7cd9a6ebc9e43e` |
| `mcp/tests/test_oauth.py` | `63271b2a754159aee495584509c8ba269a03b82e2e0a37176a0a3a1e9d603c54` |
| `backend/src/routes/mcpContractFeasibility.test.ts` | `edde6ab08c4f8c3b2f4d37040d61cf9ccfee52263cecc8a6d328c75f77685545` |
| `docs/azure-production-deployment.md` | `bfd2e8646cd6e3869390ecc24e7257330a9d026e3ba54f9886b1f5712c9b748b` |
| `docs/deployment-setup.md` | `482052426c2b964b8ef4d1b93adb634e2442c84f788ac5b0d8a06b56a27a15a6` |
| `docs/mcp-integration.md` | `70f7addbf3a6ae03a265cf2d4819fd358681c7053b896343437e3040185f0e0e` |
| `docs/operations.md` | `2f170a849266bc6cd40b54d6a8a5c038f5b7c65cedd09ca6dcdbd0fc67e9f8a1` |
| `docs/security-model.md` | `5c99440bbd9d4ddd469d385c4eec04a2ffcc78244b1756023b21be61f8dfee5f` |
| `mcp/pyproject.toml` | `3a2f2047d79c94ba8e0e32102bc96ea8e36832c724f428e4b73859a814a5bf4b` |
| `mcp/uv.lock` | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |

Production-source aggregate:19 Python files,
`1e98d27abde149b0944139787443ddf8ca570eff6dc593a674e0aeb33c47fafb`.
Package aggregate:32 files (manifest,lock,all production Python and top-level
Python tests),
`607450a5e267e78e26dca901750c344f11372620bbf43b331faaf1b8ce444032`.
For each aggregate, sort relative POSIX paths and hash
`path + NUL + file bytes + NUL`.

Final mock logs are `artifacts/phase10-{azure,local-deployment,local-runtime,
local-mcp,fresh-installation}-tests.log`; backend log is
`artifacts/phase10-backend-focused.log`. Link/cleanup/final identity evidence
belongs to the same `artifacts/phase10-*` namespace, not runtime configuration.
The exact five worker-owned pytest/OAuth scratch directories were removed;
`artifacts/phase10-scratch-cleanup.json` records zero remaining synthetic
scratch. Existing mock runners cleaned their own command/credential fixtures.
No service/listener or task-owned cloud/container resource remains. The existing
venv/approved cache, ignored local Bicep compiler and compiled template outputs
are retained for reproducible parent checks. `artifacts/phase10-evidence.json`
binds the final record, source snapshot and validation/cleanup artifacts without
self-referential hashing.

## External owners and11/12 handoff

- **Parent/hosting owner:** resolve the narrow automatic-replacement
  single-writer question above; do not call it proved by readiness.
- **Exact Azure target/operator owners:** separately approve image contents/
  digest/publication, tenant registrations/callbacks, UAMI/effective grants,
  target/budget/change window, prepared share/UID/modes/marker, NFS private
  transport, DNS/NSG/routes and authenticated API egress. Then run actual
  authorized Plan and inspect its precise scope. No populated target exists
  here and examples grant no authority.
- **Azure observation owners:** verify exact running non-root image, resolved
  references, real encrypted persistence after restart/remount/host replacement,
  one writer, OAuth→OBO→saved read, revoked/expired/guest/reconnect behavior,
  each key/credential rotation, coherent backup/recovery without resurrected
  revoked references, exact callbacks/Host/Origin, bounded transport/cancellation/
  drain, delivered alerts and incremental billing. These are unavailable, not
  skipped successes.
- **Phase11:** use the current source identities and existing guarded fixtures,
  rebuild/source-verify current images/operators and run its aggregate. Do not
  bypass the mismatched/removed old baseline guard or reinterpret phase10 mocks
  as Docker/Azure proof. This phase did not implement11.
- **Phase12/parent:** preserve actual exact-target acceptance/action authority
  for the later Compose deployment-for-testing/production convergence. No Azure
  dependency, reset/migration fallback, generic qualification workflow or runtime
  read-enable flag was introduced. This phase did not deploy or implement12.

## Final bounded same-phase repair — parent decision implemented

### Authority, result and preserved boundaries

The parent resolved the replacement-overlap defect within the existing encrypted
OAuth-connection-state architecture: **one exact encrypted Azure Blob, leased
server-side on the data object itself**. The unreleased NFS target, mount,
UID/marker checks, private-transport waiver, runtime settings, examples, tests
and current documentation were deleted, not retained as an alternate cloud path.
Only this historical record and the parent decision retain the initial choice.

The repair used the parent-selected actual `gpt-6.1-sol` / `xhigh` launch contract;
no nested worker, commit, push or branch was created. The worker cannot
independently introspect the reasoning-effort field; parent launch arguments
remain its machine-enforced evidence. HEAD remains
`d3a82a8d7673cb55300b6ab30fc3848d40554015`. Prior work and the parent-owned
campaign file were preserved; this worker did not edit campaign state or
implement11/12. The phase prompt was tightened to this resolved, grounded
replacement. Original prompt/source hashes above remain historical, not reused
as current proof.

No Azure authentication, cloud API/resource/account/secret read, what-if,
provisioning, grant, publication, ingress, tunnel to a remote system, customer
data/provider action, production/`seha` setting/volume operation or paid model
call occurred. Only public product documentation was researched. The synthetic
test tunnel described below is local Docker exec/loopback, not public ingress.
No real environment/secret file was read for credentials.

### One bounded adapter and server-enforced authority

`mcp/src/agent_control_mcp/azure_storage.py` is a cohesive hosting adapter for
the existing AsyncKeyValue protocol, not a storage/lease/crypto platform.
It reuses existing retention/record/capacity constants and maintained
Fernet/MultiFernet. The local protected FileTree and strict encrypted-envelope
backend remain unchanged. Azure encrypts the **whole bounded map once**, rather
than adding a second record-encryption layer or unfenced per-key objects.

- Exactly one prepared Block Blob is both data and lease object. No runtime
  create/container/list/fallback path exists. Every persisted initialization,
  put/batch/delete/cull/rotation update uses its current SDK lease **and** ETag
  condition. The configured64MiB single-Put threshold prevents unleased staged
  block writes. Every read fetches/authenticates current encrypted data; there
  is no stale map/authorization cache.
- Startup acquires one finite15s lease; the second instance cannot start OAuth
  authority. A lifespan-owned task renews every4s, terminates on uncertainty,
  and never reacquires/retries. Each SDK I/O is bounded5s; SDK retries are zero.
  The conservative10s local ownership deadline is measured from request start,
  not a delayed response. Requests/serialized operations are bounded; shutdown
  cancels renewal and attempts bounded release. A crash cannot confer authority
  on an expired holder after a replacement acquires the lease.
- Any lost/expired/unknown lease, corrupt/binding-mismatched state, or ambiguous/
  cancelled storage operation permanently fails that process closed. Readiness,
  reads, issuance and response-start/body publication verify ownership. A lost
  lease after headers terminates rather than emits a cached successful body.
  Failures use redacted503/operator messages; no SDK exception text, tokens,
  keys or lease IDs are logged. No automatic replay or cached success exists.
- The authenticated encrypted map permanently binds tenant, MCP/API clients,
  public resource, account, container and blob. Lookup hashes conceal OAuth
  codes. Limits are4096 records,256KiB per record,24h TTL and expired-entry
  culling. A serialized-map cap below48MiB leaves authenticated ciphertext below
 64MiB; malformed/oversized input and persisted objects fail closed. Memory,
  serialization and network work are finite; no compression/unbounded listing.
  Diagnostics report actual downloaded ciphertext bytes, not an estimate.
- Existing upstream original-claims validation, same-account refresh barrier,
  durable client-bound revocation and local authorization-code critical section
  remain real execution guards. Authorization-code and refresh issuance also
  check lease authority before return. Real SDK OAuth/revocation/refresh cases
  ran over the real storage adapter, not only annotations or storage mocks.

Dependencies were necessary for this parent-resolved backend. After manifesting
the requirement, only the approved Microsoft Python feed was used:
`azure-storage-blob==12.31.0`, `azure-identity==1.26.0`,
`aiohttp==3.14.4`; lock now resolves99 packages. Explicit
`ManagedIdentityCredential(client_id=<exact UAMI>)` is used, never a default/
user/environment credential chain, storage key or SAS in the production profile.
Native versioned App Service Key Vault secret delivery is still separate.

### Deployment, recovery and cross-root convergence

The existing version2 target dispatcher/Plan/Deploy/artifact/receipt/resume/
rotation/recovery owner and separate MCP Bicep template remain the only
authorities. Missing optional MCP still provisions nothing. Node/PostgreSQL/
domain routes, current-only schema,124 tools and browser flows are unchanged.

The exact target now pins HTTPS account, dedicated container, fixed
`oauth-state.v1.fernet`, object URL identity, existing approved `blob` private
endpoint, private DNS zone/group/VNet link and UAMI. Preflight requires
StorageV2 Standard_LRS/ZRS, TLS1.2/HTTPS-only, shared-key and public Blob access
disabled, private container and public network disabled. The Bicep uses
`vnetRouteAllEnabled=true`; no filesystem mount is provisioned or accepted.
Prepared effective private DNS/firewall/NSG/routes and HTTPS egress to the exact
storage/API/identity/registry/vault dependencies remain explicit operator
network obligations, not a fabricated packet-level ARM proof.

RBAC enumeration accepts only exact-registry AcrPull, the three exact MCP
per-secret Key Vault grants, and **object-conditioned** Storage Blob Data
Contributor on only the exact dedicated container. ConditionVersion2.0 and the
exact blob-path equality are required; broad/unconditioned/inherited/custom
API/SQL/customer-secret access fails preflight. Storage/registry grants are
prepared by the existing authorized owner, not silently created by deployment.
Only native secret references/non-secret identities enter template parameters,
arguments, artifacts and receipts.

Receipt/resume binds the complete changed target, image and secret versions.
Added explicit mismatches for another container, UAMI, image and encryption
version are refused before operations. Existing partial-success/uncertain-apply/
API-independence regressions still pass. Stop/verified Stopped/75s drain is
retained as useful maintenance, **not the fencing primitive**.

Current Azure/setup/security/MCP/operations/recovery documentation and example
were replaced together. Backup/recovery now names the exact encrypted object,
ETag/version/checksum, independent key ring, same binding, finite lease release/
expiry, leased conditional restore and revocation-resurrection risk. Restoring
old state requires coherent revocation proof or signing rotation/reconnect;
uncertain provider writes remain non-replayable/API-owned. Monitoring covers
lease loss/readiness, logical-record/actual-byte limits, response errors and
bounded spending; Blob transactions, capacity, private endpoint/DNS/network,
registry, plan, monitoring and recovery stay separately costed/approved.

Impact check: MCP/auth/storage/config/HTTP publication and Azure owner/
template/tests/runbooks changed. Backend/frontend were checked: no DTO, domain
route, provider/state/database/schema/first-sync or browser consumer changes
were needed;214 focused backend cases, both typechecks and Knip pass. Existing
local deployment/runtime/MCP/current-installation mocks and local Python
FileTree/OAuth/container contracts pass. No prior image digest proves these
new Python/dependency contents;11 must build/source-bind current images.

### Actual final verification

| Actual command / scope | Final observed result |
| --- | --- |
| `pwsh -NoProfile -File scripts/azure-oauth-fixture.ps1 -Full` | **580 passed**,237.72s, zero skips/failures; final source, actual maintained SDK and isolated Azurite |
| `pytest tests/test_azure_storage.py --collect-only -q --basetemp=../.local/phase10-blob-collect` | **21 real SDK/emulator cases** included in580, not added again |
| Focused guarded fixture before added boundary cases | **103 passed**,50.62s; superseded by final580 aggregate |
| `pwsh -NoProfile -File scripts/azure-deployment.tests.ps1` | **300 command-level assertions passed**, including all no-MCP, Plan/Deploy, exact bindings, grants/TLS/DNS, rotation/recovery and resume mismatch/uncertainty |
| `pwsh -NoProfile -File scripts/local-deployment.tests.ps1` | **1,375 passed** |
| `pwsh -NoProfile -File scripts/local-runtime.tests.ps1` | **315 passed** |
| `pwsh -NoProfile -File scripts/local-mcp.tests.ps1` | **67 passed** |
| `pwsh -NoProfile -File scripts/fresh-installation.tests.ps1` | **112 passed** |
| `cd mcp && .venv/bin/ruff check src tests`; `.venv/bin/mypy src` | Passed;20 production modules |
| Ruff format on changed production/test files | Passed; no unrelated formatting rewrite |
| `uv lock --check --offline --index-url https://packagefeedproxy.microsoft.io/pypi/simple`; `uv sync --locked --offline --index-url ...` with repository `.local/uv-cache`, `UV_PYTHON_DOWNLOADS=never` | Passed;99 packages; final editable project metadata refreshed |
| Existing official `.local/phase10-bicep/bicep build infra/{main,mcp}.bicep --stdout` | Both passed; standalone0.48.1; compiled outputs retained with hashes |
| Focused backend auth/principal/route command from initial record, rerun | **214 passed /5 files** |
| `npm run check:unused`; both workspace `typecheck` commands | Passed |
| Current affected Markdown local link check | **89 links /8 documents**, zero failures |
| Four new public primary SDK/lease/ABAC/private-endpoint URLs | All HTTP200, public research only |
| Editor diagnostics; `git diff --check`; changed/untracked-source whitespace scan | Passed |

PowerShell results sum to **2,169 mocked assertions**, not Azure/container
journey evidence. Python580 includes21 actual SDK/storage-server cases and559
other existing synthetic/local cases; these are not live Entra/provider/Azure.
The storage server **actually rejected a stale lease write with HTTP412 on the
exact data blob** after16s crash/expiry/replacement. Other real cases cover
second-holder exclusion, renewal beyond initial lease, release, expired reads,
encrypted reload/rotation/revocation, binding/wrong keys/plaintext/corruption,
4096/4097 records, TTL/culling, record/serialized/ciphertext quotas, missing
prepared object, successful-write-then-timeout/cancellation, ambiguous renewal,
OAuth account-change/code-consumption, readiness/API denial and response
publication after lease loss.

Failures were repaired, not reclassified: the initial emulator options wrongly
combined in-memory storage with `--location`; Docker internal networks expose no
NAT ports; the image declares `/data` as an anonymous volume. The toolkit now
uses in-memory extents, disabled telemetry, an exact read-only project bind and
a bounded16-connection host127.0.0.1→Docker-exec→container127.0.0.1 test tunnel.
SDK errors revealed a duplicate-response handler after an ambiguous write; it
now emits one redacted503 and no successful token/client response. The async
test lifespan was repaired to enter/exit its AnyIO scope in one task.
A later post-header test initially used malformed GET `/token` and never
reached publication; corrected to the intended diagnostics path, then all580
passed. Intermediate101/579-pass failures and earlier579-pass pre-addition run
remain in retained redacted logs, not current passing proof.

### Environment identity, cleanup and evidence

Official emulator identity:
`mcr.microsoft.com/azure-storage/azurite@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37`
(3.35.0, ARM64). It was absent initially; only this genuinely required official
MCR image was fetched. Each run verified `desktop-linux`,
`unix:///Users/candede/.docker/run/docker.sock`, unique exact ownership labels,
internal network, no NAT/public ports,512MiB/1CPU/128PIDs, no writable data
mount and actual service responsiveness before testing. Emulator credentials
are synthetic only and have no production profile/acceptance mode.

Final580 evidence:
`artifacts/phase10-blob/ac-oauth-fixture-139cc9dd17c743c7a3279b4f/`
(`pytest.log`, `evidence.json`). Its exact container
`ff1de9103e92327c952969b09c26a0f0c089f9c988570b5ba4b5100d5960ee5f`
and network
`d4ba2d7a6f6bf8d23921134e039d8c912ea2c97549fb806a18795d2766e5850b`
were removed.
Every run removed its exact container/network and project scratch; final
evidence confirms prior containers preserved. Four early image-declared
anonymous `/data` volumes were recovered one-to-one from unique creation-second/
run-lifetime metadata, checked anonymous/unreferenced, then removed by exact ID;
`artifacts/phase10-blob/early-anonymous-volume-cleanup.json` retains the bounded
proof. No prune/name-based process stop/unrelated volume cleanup occurred.
The exact newly fetched official image was removed after validation; Docker
removing its only tag also removed the digest reference, so a redundant digest
removal initially returned “no such image.” Independent verification confirms
the image is absent and no task container/network/scratch remains.
`artifacts/phase10-blob-cleanup.json` records final cleanup. To rerun later, the
guarded fixture needs this exact official image restored after the genuine
missing-image check, not another tag/provider or an application-image bypass.

`artifacts/phase10-blob-source-hashes.json` freezes current changed contracts,
source/package aggregates, unchanged owners and preserved prior records.
`artifacts/phase10-blob-evidence.json` binds this final record, source snapshot,
compiled templates, final proof and cleanup without self-reference. Mock logs,
link checks and cleanup are in `artifacts/phase10-blob-*`; the original
`artifacts/phase10-source-hashes.json` remains initial-candidate history.

### Remaining external checks and exact handoff

**Source/SDK/emulator repair complete; actual Azure qualification unavailable.**
No authorized account/target/grants/secret versions/publication/private network
exists in this task. Emulator proves SDK/server lease behavior, not Azure
managed identity/ABAC/TLS/private DNS/egress, Azure persistence/host replacement,
App Service streaming/disconnect/drain, delivered alerts or incremental billing.
The authorized target/operator must prepare the exact resources/grants/object,
run existing Plan/Deploy and observe the documented OAuth→OBO→saved-read,
revocation/refresh, old/replacement exclusion, restart/rotation/backup/recovery,
transport and monitoring journeys. No acceptance/runtime-enable file is added.

Parent owns campaign/hash integration and11/12 sequencing. Use current hashes
and current build contents; do not reuse the superseded NFS target or phase08/
initial10 image proof. No remaining source architecture decision is deferred.
