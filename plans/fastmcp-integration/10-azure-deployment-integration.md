# 10 - Azure infrastructure and deployment automation

## Mission

Extend existing deployment tooling to host the MCP image independently beside the current Node App Service, with exact approved resources, persistent encrypted OAuth state, streaming, secrets, observability, and bounded release containment.

## Prerequisites

Read [README](README.md), [03](03-api-auth-integration.md), [04C](04C-api-webapp-production-release.md), [05](05-fastmcp-service-and-auth.md), [08](08-local-container-integration.md), [09](09-client-workflows-and-evaluation.md), and their completion records, plus actual Part 1 acceptance. Extend the already deployed API/web tooling/receipt; 12 owns the second, MCP production release. This phase implements/validates tooling without live deployment.

## Read first

- [Azure entry point](../../deploy-azure.ps1), [deployment helpers](../../scripts/azure-deployment.ps1), [deployment tests](../../scripts/azure-deployment.tests.ps1).
- [Bicep](../../infra/main.bicep), [parameters](../../infra/main.bicepparam), [Key Vault access](../../infra/key-vault-access.bicep), [target example](../../infra/production-target.example.json), [recovery](../../infra/disaster-recovery.md).
- [Production guide](../../docs/azure-production-deployment.md), [operations](../../docs/operations.md), [qualification target example](../../infra/qualification-targets.example.json), MCP image/settings/storage/client requirements from 05/08/09.

## Required implementation

1. Preserve the Node App Service runtime/package deployment and existing PostgreSQL authority. Add a separate single-instance Linux custom-container App Service for MCP; do not migrate the API to Compose/Container Apps or replace unrelated resources.
2. Extend the existing target/approval contract with exact MCP resource/plan/image-registry/digest, HTTPS origin/callback, API binding, tenant/registration/scopes, persistent mount, secret versions, ingress/connectivity, resource/cost budget, and monitoring identities. Example targets remain `isApproval: false`.
3. Reuse an approved compatible App Service plan only after accounting for both services' capacity/cost; otherwise declare and require approval for a dedicated plan. No automatic unapproved SKU/region/resource substitution.
4. Provision or reference only explicitly approved registry/storage/network resources. Pin images by immutable digest; use managed identity for supported image/Key Vault access. Keep runtime secrets out of parameters, logs, templates, process arguments, artifacts, and receipts.
5. Configure dedicated persistent writable OAuth state with encryption keys from Key Vault and single-writer ownership. Prove custom-container filesystem persistence rather than assuming a read-only container survives restart. No autoscale until the storage/session contract is explicitly redesigned.
6. Validate public origin/forwarded-header trust, OAuth discovery/callback routes, Streamable HTTP buffering/timeouts, disconnect, request-size/resource limits, and authenticated API connectivity. No public API bypass, permissive callback wildcard, or browser-CSRF weakening.
7. Extend `Plan`/`Deploy` sequencing, artifact checksums/digests, target/approval digest, mock executor, idempotent/resumable receipts, secret rotation, and safe checkpoints. Wire containment through existing operational admission and the 05 server tool allowlist; record actual server exposure in receipts and reject direct calls to omitted tools. Separate hard target/identity/authorization safety validation from preproduction evidence/risk reconciliation so a failed optional test does not silently become a blanket deployment veto; never weaken the hard validation.
8. Keep deployments compatible with older non-MCP target files only as optional product configuration, not duplicate deployment logic. Explicit MCP configuration that is invalid fails; missing integration must not silently provision resources.
9. Add metrics/alerts for auth failures, API/tool errors, provider rejection/readback unknown, queue/authorization wait, dependency latency, OAuth disk/persistence failure, health, resource consumption, and spending. Document concrete thresholds/operator ownership and safe logging retention.
10. Update runbooks for Plan/Deploy, approved target preparation, MCP-only storage/key recovery, API worker reauthorization, image fix-forward, canary restoration, monitoring, and targeted disposable cleanup. Keep API tokens ephemeral and no broad database reset.
11. Extend 04C's released Plan/Deploy/resume upgrade contract for MCP rather than introducing the first audit migration here. Recognize the already-upgraded Part 1 schema, avoid replaying upgrades, preserve historical records, and pin accepted route/origin/schema/DTO compatibility plus both release receipts. Forward bounded attribution context through ingress; classification relies on API credentials, not proxy headers.

## Scope guard

No actual production deployment, change to existing approved targets, unapproved Azure resources, Entra grants/roles/consent mutations, new scheduler/policy engine, or credentials inferred from other campaigns.

## Validation

- Extend `scripts/azure-deployment.tests.ps1` and add `scripts/mcp-azure.tests.ps1`; test mock Plan/Deploy/resume/containment/rotation/recovery/cleanup and malformed/mismatched approval rejection.
- Build/validate Bicep with available existing tooling; inspect mocked exact resource/secret/network/image contracts.
- Attempt what-if against an explicitly approved target only; no credentials/target means `unavailable`, not a dry-run deployment claim.
- Test custom-container persistence/streaming/Key Vault/registry hypotheses in approved disposable infrastructure where available; 12 owns exact-production proof.
- Test historical audit/job preservation and interrupted/resumed upgrade; browser origin remains server-derived, authenticated MCP context survives ingress, absent/reported agent information stays honest, and stopping MCP does not disable existing web/API operations.
- Run deployment-contract/docs checks and `git diff --check`; use README package feeds for all build/subprocess work.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. Implement safe forward deployment with bounded MCP exposure and preserve the accepted API/web release. Part 1 target approval never authorizes new MCP resources; missing exact Part 2 approval/control-plane access is `deployment_pending`, never consent or permission to bypass target validation.

## Completion record

Write `completions/10-azure-deployment-integration.md`: exact new target/configuration/resource contracts, Bicep/scripts/receipt changes, persistence/streaming/budget/alerts, mock/live attempted evidence, root impacts, and executable 12 Plan/Deploy commands.

## Done and handoff

11 can qualify reproducible release artifacts against the accepted Part 1 baseline. 12 can add MCP beside the deployed API/web app under a separately approved exact change using existing tooling, with recoverable state and no guessed infrastructure.
