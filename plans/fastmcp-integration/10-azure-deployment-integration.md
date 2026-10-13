# 10 - Validated Azure hosting and deployment tooling

## Mission

Extend and validate existing Azure deployment tooling for a future MCP App Service beside the Node App Service, with persistent encrypted OAuth state, streaming, secrets, observability and bounded containment. Deliver hosting support, not a live Azure migration. Campaign production remains `seha` Compose.

## Prerequisites

Read [README](README.md), [03](03-api-auth-integration.md), [04C](04C-api-webapp-production-release.md), [05](05-fastmcp-service-and-auth.md), [08](08-local-container-integration.md), [09](09-client-workflows-and-evaluation.md), and their completion records, plus actual Part 1 acceptance. Reuse released schema/route/receipt contracts, not `seha` identifiers as cloud resource names. 12 owns the second Compose production release through 08; Azure approval/access is not its prerequisite.

## Read first

- [Azure entry point](../../deploy-azure.ps1), [deployment helpers](../../scripts/azure-deployment.ps1), [deployment tests](../../scripts/azure-deployment.tests.ps1).
- [Bicep](../../infra/main.bicep), [parameters](../../infra/main.bicepparam), [Key Vault access](../../infra/key-vault-access.bicep), [target example](../../infra/production-target.example.json), [recovery](../../infra/disaster-recovery.md).
- [Production guide](../../docs/azure-production-deployment.md), [operations](../../docs/operations.md), [qualification target example](../../infra/qualification-targets.example.json), MCP image/settings/storage/client requirements from 05/08/09.

## Required implementation

1. Preserve Azure's Node App Service runtime/package deployment and PostgreSQL authority in templates/tooling. Add support for a separate single-instance Linux custom-container App Service for MCP; do not migrate `seha`, redesign hosting or replace unrelated resources. Do not create live resources in this phase.
2. Extend the existing target/approval contract with exact MCP resource/plan/image-registry/digest, HTTPS origin/callback, API binding, tenant/registration/scopes, persistent mount, secret versions, ingress/connectivity, resource/cost budget, and monitoring identities. Example targets remain `isApproval: false`.
3. Reuse an approved compatible App Service plan only after accounting for both services' capacity/cost; otherwise declare and require approval for a dedicated plan. No automatic unapproved SKU/region/resource substitution.
4. Implement provisioning/reference contracts for only explicitly approved registry/storage/network resources. Future cloud deployment pins images by immutable registry digest and uses managed identity for supported image/Key Vault access. Local production pins built image IDs; no registry upload is needed for `seha`. Keep runtime secrets out of parameters, logs, templates, process arguments, artifacts and receipts.
5. Configure dedicated persistent writable OAuth state with encryption-key references from Key Vault and single-writer ownership in Azure tooling. Prove custom-container filesystem persistence in mocks/authorized fixtures and record unavailable live cloud proof separately; never call it proven from Compose restart alone. No autoscale until the storage/session contract is explicitly redesigned.
6. Validate public origin/forwarded-header trust, OAuth discovery/callback routes, Streamable HTTP buffering/timeouts, disconnect, request-size/resource limits, and authenticated API connectivity. No public API bypass, permissive callback wildcard, or browser-CSRF weakening.
7. Extend `Plan`/`Deploy` sequencing, artifact checksums/digests, target/approval digest, mock executor, idempotent/resumable receipts, secret rotation, and safe checkpoints. Wire containment through existing operational admission and the 05 server tool allowlist; record actual server exposure in receipts and reject direct calls to omitted tools. Separate hard target/identity/authorization safety validation from preproduction evidence/risk reconciliation so a failed optional test does not silently become a blanket deployment veto; never weaken the hard validation.
8. Keep deployments compatible with older non-MCP target files only as optional product configuration, not duplicate deployment logic. Explicit MCP configuration that is invalid fails; missing integration must not silently provision resources.
9. Add metrics/alerts for auth failures, API/tool errors, provider rejection/readback unknown, queue/authorization wait, dependency latency, OAuth disk/persistence failure, health, resource consumption, and spending. Document concrete thresholds/operator ownership and safe logging retention.
10. Update runbooks for Plan/Deploy, approved target preparation, MCP-only storage/key recovery, API worker reauthorization, image fix-forward, canary restoration, monitoring, and targeted disposable cleanup. Keep API tokens ephemeral and no broad database reset.
11. Reuse 04C/08's released upgrade/receipt semantics in Azure's existing Plan/Deploy/resume path rather than introducing another migration authority. Recognize already-upgraded Part 1 and known-baseline schemas, avoid replaying upgrades and preserve historical records. Pin accepted route/origin/schema/DTO compatibility. Keep cloud validation receipts separate from actual `seha` releases. Forward bounded attribution context through ingress; classification relies on API credentials, not proxy headers.

## Scope guard

No actual production deployment, change to existing approved targets, unapproved Azure resources, Entra grants/roles/consent mutations, new scheduler/policy engine, or credentials inferred from other campaigns.

## Validation

- Extend `scripts/azure-deployment.tests.ps1` and add `scripts/mcp-azure.tests.ps1`; test mock Plan/Deploy/resume/containment/rotation/recovery/cleanup and malformed/mismatched approval rejection.
- Build/validate Bicep with available existing tooling; inspect mocked exact resource/secret/network/image contracts.
- Attempt what-if only if a separately approved Azure target already exists; absent authorization/access means `unavailable`, not a dry-run deployment claim. Do not obtain cloud provisioning as a prerequisite to `seha` deployment.
- Attempt custom-container persistence/streaming/Key Vault/registry checks only in separately authorized disposable infrastructure where available. Record live Azure limitations honestly; 12 proves current-host Compose production, not App Service.
- Test historical audit/job preservation and interrupted/resumed upgrade; browser origin remains server-derived, authenticated MCP context survives ingress, absent/reported agent information stays honest, and stopping MCP does not disable existing web/API operations.
- Run deployment-contract/docs checks and `git diff --check`; use README package feeds for all build/subprocess work.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. The required production release is `seha` via 08/12; unavailable Azure evidence is a cloud-hosting residual, not `deployment_pending` for this campaign. Future cloud target approval never follows from Compose approval. Preserve safe target validation and truthful limitations rather than silently provisioning a second production environment.

## Completion record

Write `completions/10-azure-deployment-integration.md` under README's completion contract: future Azure target/configuration/resource contracts, Bicep/scripts/receipt changes, persistence/streaming/budget/alerts, mock/authorized-live attempted evidence, root impacts, unavailable cloud proofs and future Plan/Deploy commands. Reaffirm that 12 uses 08's local commands and does not require cloud provisioning.

## Done and handoff

11 can qualify Azure tooling alongside the actual Compose artifacts without mixing their evidence. 12 adds MCP to `seha` under a separately approved local change using 08's tools. A future Azure rollout has an exact validated contract and explicitly recorded unproven live boundaries, not an implied deployment receipt.
