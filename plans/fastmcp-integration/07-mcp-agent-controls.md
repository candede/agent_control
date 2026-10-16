# 07 - Thin MCP control and job tools

## Mission and inputs

Wrap current shared control APIs using [05](05-fastmcp-service-and-auth.md)
and [06](06-mcp-read-tools.md). Read the
[canonical control contract](../../docs/mcp-integration.md),
[security](../../docs/security-model.md),
[mutation diagnostics](../../docs/mutation-canaries.md) and current package/
quarantine routes, services and jobs. No historical acceptance artifact is needed.

## Implementation

1. Add typed preview/execute/status/item/cancel/resume/reconcile adapters only
   where current canonical APIs support them. Reuse web methods, defaults,
   receipts, jobs and provider effects; no MCP-only route or execution state.
2. Forward exact discovered canonical/source/environment identity. API alone
   chooses supported provider effects. Generic Studio means quarantine/
   unquarantine; explicit package/Studio controls remain distinct.
3. Preserve prestate, target IDs/names, counts, ineligible/already-state reasons,
   source revision, expiry and opaque receipt. Changed authority/source/targets
   remain errors, not Python substitutions.
4. Submit stable operation/idempotency identity and poll bounded existing child
   outcomes. Accepted/final/verified are distinct; mixed providers are not
   atomic. Never automatically replay a sent-unknown write.
5. Interactive clients show the exact preview and ask for confirmation;
   scheduled clients obtain the same current receipt without a human pause.
   No server approval tasks, scheduler flag bypass or fabricated proof of consent.
6. Forward request-local origin automatically. API remains the audit writer;
   replay cannot replace the initiator and lifecycle requests have separate
   current attribution.
7. Document Admin/provider requirements, effects, bounds, expiry/recovery and
   client confirmation limitations. Optional canaries do not gate ordinary
   supported controls.

## Verification and handoff

Run protocol/catalog and HTTP-capture tests for both providers/directions,
multi-page discovery, unknown identity/dates, exact receipts, concurrency,
idempotency, partial children, revocation, restart/authorization wait and uncertain
readback. Reuse current shared-control/origin fixtures. Compare web/MCP domain
effects/errors under matched synthetic prestate, including audit/CSV parity.

Live writes belong only to explicitly authorized disposable exact targets during
[12](12-production-convergence.md). No broad canary, identity guessing, provider
bypass or new control schema. Fix shared defects in current owners, rerun affected
web contracts and update current documentation with observed results.
