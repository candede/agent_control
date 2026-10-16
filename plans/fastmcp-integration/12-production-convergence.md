# 12 - MCP production release and live hardening

## Mission and inputs

Deploy MCP beside the independent API/web app in current-host Compose project
`seha`, verify actual user journeys and repair defects forward. Read
[08](08-local-container-integration.md), [09](09-client-workflows-and-evaluation.md),
[11](11-release-qualification.md), [current contracts](../../docs/mcp-integration.md),
[operations](../../docs/operations.md) and
[security](../../docs/security-model.md).
Planning/source tests are not authority for live resource, ingress, tenant-grant
or provider changes. Obtain actual operator authorization for those boundaries.

## Release and observation

1. Verify exact host/context, project/services/networks, `seha_data`, dedicated
   OAuth volume, configured origins, artifact/image identities, registrations,
   scopes, protected secret references, resources and maintenance window.
   Never hardcode a customer tenant into product behavior.
2. Use the current-only API/schema and existing deployment owner from
   [04C](04C-api-webapp-production-release.md). Adding MCP does not authorize
   another reset, schema upgrade or uncertain write replay.
3. Deploy exact intended images/configuration through existing local start/
   resume tooling without `-DbReset`. Preserve data/settings/credentials.
   No Azure provisioning/registry publication is required for local release.
4. Verify actual served content, API/MCP health, OAuth discovery/callback/PKCE,
   encrypted persistence, correct delegated audiences, native/guest identity,
   Viewer/Admin/private scope, refresh/challenges and wrong-tenant denial.
   Local health is not remote-client OAuth proof.
5. Run actual client workflows for full agent/user relationships, descriptions,
   champions, explicit refresh/investigation, source gaps and valid/incomparable
   trends. Use authorized synthetic/isolated data; do not change customer report
   selection or introduce fixture-auth mode.
6. Attempt each supported client separately. Observe interactive preview/
   confirmation and externally scheduled execution without a human pause.
   Record unavailable accounts/clients honestly; SDK fixtures are not universal
   support evidence.
7. Test writes only on authorized disposable exact targets: prestate,
   confirmation/idempotency, provider effect/readback and restored prestate.
   Never run department-wide or arbitrary recent-agent bulk canaries.
8. Observe restart, OAuth continuity, ephemeral API credential loss, same-user
   recovery, revocation, unknown-write reconciliation, backpressure, audit,
   latency/resources and independent web behavior. Use a stated actual
   interval/workload and numeric operational thresholds; do not invent results.
9. For a defect, contain only the affected operation, fix current owning code/
   consumers, run focused regressions, redeploy a new exact artifact and repeat
   affected live checks. Do not add requalification, provider-CLOSED, acceptance
   files or feature-enable steps to ordinary supported flows.
10. Verify paired web/MCP method/route/domain behavior and audit attribution
    for the same authorized actor under restored matched prestate. Unknown
    historical events stay unknown; calling agents are not managed targets.
11. Clean only exact owned disposable resources and approved temporary grants.
    Production OAuth state and `seha_data` are not fixture output. Record failed
    cleanup as an owned operational issue rather than using global prune.
12. Hand over actual URL/revision, client setup, working journeys, concrete
    limitations, monitoring owners, protected key/state recovery, reconnect and
    fix-forward procedures. Update current docs, not a compatibility archive.

## Done

The authorized release is deployed and affected first-run/client/control/
recovery journeys are observed. All claims distinguish implemented, deployed,
tested and unavailable behavior. API/web remains independent of MCP; real
permissions and exact destructive confirmations remain, with no additional
runtime approval system. Source-only execution cannot claim this live outcome.
