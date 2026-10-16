# 11 - Integrated release, recovery and capacity verification

## Mission and inputs

Verify implemented MCP/API/web behavior before the authorized release.
Read [current API map](../../docs/mcp-integration.md),
[data architecture](../../docs/data-architecture.md),
[operations](../../docs/operations.md), the actual implementation from
[05](05-fastmcp-service-and-auth.md)–[10](10-azure-deployment-integration.md),
and current package/test/deployment runners. Superseded completion/acceptance
artifacts and old read qualification jobs are not prerequisites.

## Verification and repair

1. Reconcile actual requirements with current owners/tests; repair confirmed
   defects across API, web and MCP. Do not hide gaps with skipped tests, weakened
   assertions, documentation claims or Python domain calculations.
2. Run focused auth/read/control/protocol tests, then affected backend/frontend
   type/build/browser/deployment contracts. Record counts, skips and isolation,
   not just exit status.
3. Exercise empty/current installation, incompatible-schema refusal, API/MCP
   restarts/drain, key/client-secret rotation, encrypted OAuth recovery, API
   credential loss, same-user resume and sent-unknown reconciliation. No old
   schema upgrade or destructive replay.
4. Use fixed large synthetic cohorts for pagination, champion joins, complete
   descriptions, bounded SQL/fan-out/bytes/deadlines, backpressure, resource
   consumption and concurrent principal isolation. Missing measurements stay
   unknown; never increase caps to manufacture a pass.
5. Compare canonical web/MCP routes/results/effects/errors under matched
   principal/input/source/prestate. Verify independent web availability when
   MCP is absent and normal first-run without extra approval/enable steps.
6. Cover actor versus reported client/agent, current and unknown origin,
   append/projection/CSV/UI, mixed children, replay/resume attribution, restart,
   spoofed labels, retention and privacy.
7. Run the synthetic client corpus and separately attempt available real clients,
   provider/recovery/capacity evidence. SDK, local, live-client and live-provider
   outcomes must remain distinct.
8. Check existing dependency/license/redaction tooling, effective approved feeds,
   lock/image contents, non-root identity and absence of database/provider secrets
   in MCP. Preserve exact source/image identities without committing for an ID.
9. Record remaining case-specific limitations, operating owner, safe response and
   reproducible check. Failed optional evidence is not a new runtime approval
   system or a blanket block on unrelated supported operations.

## Handoff

Update current docs with exact commands/outcomes, actual artifact identity,
observed limits and unavailable proof. Run links/config/receipt/diff checks.
Use existing runners rather than another qualification framework.
No production deployment, broad reset or customer fixture data in this phase.

[12](12-production-convergence.md) receives exact local start/recovery commands,
authorized target constraints, provider-canary restoration procedures and
operator-selected observation workload/signals. Azure-tooling evidence remains
separate from the local production release.
