# 04C - Live API/web release status

## Status: deployment_pending

The shared API/web prerequisite was reviewed and the subsequent MCP integration
was implemented and verified in isolated environments. The actual release
required by [04C](../04C-api-webapp-production-release.md) was **not executed**.
This record is not a deployment or reset receipt.

The current user request authorizes completing implementation and making the
application ready to deploy for testing. It does not authorize operations on the
roadmap's current-host `seha` project, its PostgreSQL database, `seha_data`,
protected configuration, registrations, public ingress or provider targets.
No historical plan wording is substituted for exact current authorization.

The [foundation review](API_FOUNDATION_REVIEW.md) preserves the initial scoped
review. Its corresponding SQL-unavailable checks were subsequently exercised
through the isolated owners documented in
[09](09-client-workflows-and-evaluation.md) and
[11](11-release-qualification.md). Browser/API authentication, current/empty
installation, incompatible-schema refusal, automatic synthetic collection,
recovery and origin/audit were tested; those are not live production journeys.

## Exact next action and owner

The release operator must obtain the exact host/context/project/resource,
content, action and maintenance-window authorization before running the
existing deployment owner. Preserve the existing volume, configuration and
backups. An incompatible schema must fail closed; a reset requires its own
explicit destructive authorization and must never be inferred or replayed.

Use the [current testing handoff](12-production-convergence.md) and
[operations](../../../docs/operations.md), then separately observe actual served
revision, sign-in, automatic first sync, permissions, saved reads, jobs, audit
and recovery. Real provider changes require separately authorized exact
disposable targets and restoration. This phase remains open until that live
outcome is observed.
