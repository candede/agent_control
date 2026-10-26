# 12 - Deployment-for-testing handoff and live-release status

## Outcome and authority

**Implementation and controlled local deployment-testing readiness are
verified. Actual live release remains `deployment_pending`.**

This parent-owned handoff completes the currently authorized preparation, not
the live outcome of [12](../12-production-convergence.md) or
[04C](04C-api-webapp-production-release.md). The roadmap's `seha` target is not
permission to act on it. No production deployment, database reset, cloud
provisioning, registry publication, registration/grant, public ingress, real
provider write or paid model call occurred. No actual served URL is claimed.

The application boundary is this repository's backend, frontend, MCP and
deployment owners. All implementation/repair subagents were explicitly launched
with `gpt-6.1-sol` and `xhigh`; the parent performed final integration review
and this handoff directly. No nested workers or commits were used. HEAD remains
`d3a82a8d7673cb55300b6ab30fc3848d40554015`; implementation is uncommitted.

## Verified flow and current deliverables

Previously the browser called the canonical API. MCP now adds:

```text
MCP client -> tenant-bound OAuth -> verified MCP-audience upstream assertion
  -> API-audience delegated OBO -> the same canonical API
  -> saved results or existing exact control receipts/jobs/audit
```

The API remains the domain/provider/SQL authority. The browser has no MCP
dependency. There are 124 typed tools, no arbitrary HTTP/SQL/KQL endpoint,
server scheduler, LLM workflow engine or additional runtime enable/acceptance
step. Interactive confirmation is client-owned; scheduled clients use the same
current receipt without a fabricated human-consent field.

Local OAuth state remains a protected encrypted dedicated volume. Optional
Azure tooling uses one encrypted state blob with server-enforced lease/ETag
fencing through maintained SDKs; the rejected NFS candidate was removed.
Transient TSX caches are excluded consistently from snapshots, Docker contexts,
ZIP packaging and production inspections, without deleting tracked originals.

The authoritative current local artifact ledger is
`artifacts/fastmcp-release-qualification-11-packaging-49d8df58c2ad/`.
Earlier phase11 artifact identities are historical, not current instructions.

| Deliverable | Exact identity |
| --- | --- |
| Source manifest, 917 inputs | `cdbfd6922afea37b2a6e651ffad4d529258e5728cbd2814e65a187560685f848` |
| Frozen build inputs | `artifacts/local-builds/51e2d084729f43cb8eecee53f68a4d13/source` |
| Application image | `sha256:59faddb782d6368a5edaf136b6b2a6608943be97792c0e25aad19564143c2633` |
| MCP image | `sha256:180e3a3fa2f8629346e45d7f614bc1686f81925a529d0361864f9e5b0e3de5df` |
| Image platform | `linux/arm64`, local testing; not an Azure/amd64 publication |
| Image owner | `ac-mcp-release11-packaging-49d8df58c2ad` |
| Image purpose | `fastmcp-phase11-source-packaging-deployment-testing` |

Parent verification independently matched all 917 current and frozen hashes,
the current deployment-input enumeration, both exact image identities and their
source/owner/purpose labels. Actual runtime layers, configuration except those
metadata labels, bytes, ownership, modes and symlinks match the qualified
runtime. Prior journeys are reused through that explicit equivalence, not
reported as new executions.

The images and one frozen snapshot are intentional retained deliverables.
Temporary SQL/Azurite/container fixtures and helper images were cleaned by
their exact ownership guards; original tracked caches and unrelated resources
were preserved. Final parent synthetic scratch is separately cleaned and
recorded in the campaign. Redacted diagnostic evidence remains available.

## Actual evidence and limitations

See [11](11-release-qualification.md) for commands, failures, repairs, full
content identities and cleanup receipts. Scopes overlap and must not be summed.

| Evidence | Observed result |
| --- | --- |
| Full Python/real SDK aggregate | 583 passed, zero skips; includes 21 real SDK/Azurite cases and stale-writer HTTP412 rejection |
| Registered canonical SQL reads / controls | 647 read cases; 695 control cases |
| Connected SDK -> HTTP -> SQL | 26 cases, 12 complete SDK receipts across matched transports |
| Full frontend / actual Chromium | 5,150 component/adapter cases; 60 browser cases |
| Origin / deployment-current / capacity-focused | 133 / 390 / 1,008 cases, overlapping suites |
| Final packaging-owner checks | 352 local-runtime, 1,375 local-deployment, 67 MCP and 302 Azure mock assertions; six actual ZIP cases |
| Static and content checks | Types, builds, lint/format, Knip, Bicep, approved feeds, dependency/license metadata, redaction and production contents passed |
| Complete connected A/B/C workflows | 16/8/2 calls; each below 32 calls, 4MiB and 180s |
| Largest connected C invocation | 511,186 bytes, below the unchanged 524,288-byte final MCP envelope limit |
| MCP load/recovery | 64 burst requests: 10 admitted, 54 explicit503; subsequent recovery passed |
| MCP resource sample | 147,230,720-byte peak under 512MiB; zero memory max/OOM events; 0.5 CPU/128 PID bounds inspected |
| Authenticated shutdown | 3.2639841 seconds in the synthetic container journey |

The 10k/100k query traversal verified all 100/1,000 pages and exact ordered
identities, but **100k PostgreSQL resource qualification failed**:
1,074,098,176-byte charged peak against 1,073,741,824 bytes, 8,607 memory-max
events, and failed 80%-memory/cache-pressure criteria. No OOM or restart does
not convert this to a pass. The broader production capacity profile remains
inconclusive. Do not use this handoff as 100k-scale or production-capacity
acceptance, increase caps to manufacture success, or block unrelated ordinary
reads with a new qualification gate.

Real Entra/native/guest/OBO, vendor/model-selected workflows, live provider
effects/readback and actual Azure/UAMI/network/persistence/streaming remain
unavailable without approved accounts and targets. Fixtures and SDK/emulator
success are not substitutes. Current onboarding separates each client surface;
it does not claim universal support.

## Operator preparation and ordinary commands

Use [setup](../../../docs/deployment-setup.md#optional-local-mcp-container),
[client onboarding](../../../docs/mcp-clients.md),
[operations](../../../docs/operations.md) and
[security](../../../docs/security-model.md).

Before any actual start, the operator selects and authorizes the exact local
test host, Docker context/socket, project, services, network, database/OAuth
volumes, loopback ports, source/artifacts and maintenance window. Do not
substitute `seha`, another existing project or an example default.

Prepare the normal tenant registry/integration, distinct MCP/API registrations,
exact scopes/audiences, HTTPS resource and origin-root `/auth/callback`, exact
client callbacks and independent protected client/signing/encryption files.
Keep values in the approved terminal/secret store, never chat or reports.
Supply a protected metadata import, not raw secret arguments. The existing
owner creates no DNS, tunnel, ingress, consent or registration.

These are **operator handoff examples only**, not executed commands or
authorization:

```powershell
./deploy-local.ps1 start -Project $authorizedProject -McpConfig $protectedMcpImport
./deploy-local.ps1 check -Project $authorizedProject
./deploy-local.ps1 stop -Project $authorizedProject
```

Normal start builds from a coherent current snapshot through the existing
owner. The retained images/manifest are verified reference artifacts, not a
configuration-bound `-Candidate` receipt. Do not invent candidate/preflight
identities or bypass the existing integrity checks to force their use.
There is no `-DbReset` in normal start or recovery.

## Test observation, recovery and remaining owners

The operator records the actual interval, workload, principals, targets and
signals for the separately authorized test deployment. Verify served identity,
independent web/API health, OAuth discovery/callback/PKCE, encrypted continuity,
roles/private scope and complete read workflows. Local readiness is not remote
OAuth proof. Observe current/unknown caller attribution without promoting
reported names to authenticated identity.

Verify bounded responses, explicit503/recovery, resource/queue signals and
current receipts. Interactive clients must pause before execution and
redisplay/reconfirm changed or expired receipts; external scheduled clients
must not acquire an artificial human pause. An accepted/partial/waiting job is
not verified provider success.

Stop the exact project before coherent local encrypted-state backup. Preserve
the recorded volume/binding identity and independently protected key ring.
Importing an encryption ring retains old keys until required record rewrites,
expiry/reconnect and recovery are satisfied. Signing rotation requires
reconnect. Restore the exact same-binding protected state; missing/corrupt
state must not silently recreate/reset. API credentials remain ephemeral.
Unknown sent writes require read-only reconciliation, never blind replay.

For a separately authorized provider canary, record one exact owned target,
known private prestate, current preview/receipt and stable operation key.
Restore only a verified own change with unchanged known prestate, through a
fresh reverse-action preview. Never invert uncertain, mixed or already-blocked
batches automatically.

| Open scope | Owner and next action |
| --- | --- |
| Actual 04C/12 release | Release operator: exact target/action/content/window authorization, existing start/check/recovery owner and observed live journeys |
| Real client/Entra proof | Client/identity owner: approved synthetic accounts and endpoint; per-surface callbacks, token lifecycle, scopes and principal mapping |
| Provider effects/restoration | Provider owner: exact disposable target/prestate/write/readback/reverse-action authorization |
| 100k/full-profile capacity | Capacity/operations owner: diagnose measured cache/resource pressure and test the intended complete workload on the approved tier; any material tier change needs separate authorization |
| Actual Azure qualification | Azure operator: approved amd64 publication/target, UAMI/RBAC/private network and real lease/replacement/persistence/recovery/transport checks |

There is no remaining source architecture decision or ordinary runtime
approval/enable system. The current preparation outcome is complete;
04C/12 live convergence remains explicitly open, not fabricated as deployed.
