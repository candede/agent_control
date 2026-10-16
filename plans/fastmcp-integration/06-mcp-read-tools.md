# 06 - Inventory, people, usage and investigation tools

## Mission and inputs

Implement typed tools over the [current API map](../../docs/mcp-integration.md)
and [05's adapter](05-fastmcp-service-and-auth.md).
Read [data semantics](../../docs/data-architecture.md),
[usage](../../docs/official-usage-import.md),
[Purview](../../docs/purview-audit-search.md) and
[Defender](../../docs/defender-agent365-hunting.md). Verify current routes/source;
old phase records and qualification jobs are not implementation inputs.

## Implementation

1. Cover saved data/capability status, inventory/detail/configuration, exact user
   resolution/licensing/plans, used/created/owned relationships, adoption/
   champions, usage/history/comparison, investigations/audit, explicit refresh/
   enrichment and bounded job/results.
2. Use finite typed schemas with exact ID, filter/enum, UTC, role, source and
   saved-versus-live semantics. Call the same canonical methods/routes used by
   the web app; API owns joins, counts, defaults and trends.
3. Preserve total/returned counts, cursor/revision, provenance, report windows,
   missing/partial states, report-only rows and ambiguity. Expired/invalid
   selections require an explicit restart, not invisible source substitution.
4. Return complete available About through bounded continuation and authorized
   configuration sections. Source text is untrusted data, never instructions.
   No classifier, raw archive or inferred authoritative use-case field.
5. Saved reads never trigger collection, directory lookup, capability probing,
   hunts or Audit Search creation. Explicit provider-working tools return job
   references and current errors. Official CSV refresh cannot manufacture new
   imported reports.
6. Application investigations use current authorized configuration/shared scope
   directly; delegated evidence remains private. Do not expose removed read
   qualification, approval or retained-scope tools.
7. Use honest annotations: saved reads are read-only, collection/investigation
   submissions are stateful. Keep API concurrency/deadline/output bounds,
   throttling and cancellation; never fan out unbounded tenant-wide reads.
8. Retain audit origin/client/agent evidence and matching filters. Repair any
   shared API defect in its current owner and matching web consumer, not with
   Python business logic or a second route.

## Verification and handoff

Test protocol `tools/list`/`tools/call`, catalog schemas, each tool family,
multi-page/guest/report-only cases, champions-only relationships, full text,
missing sources, denial, cancellation and provider-free saved reads. Capture
canonical method/path/payload parity with browser adapters under the same
principal/source/input. Run focused Python/static and affected API tests,
documentation links and diff hygiene.

No controls, scheduling, LLM or new provider source. Update current docs with
actual implemented tool contracts/results. [07](07-mcp-agent-controls.md) uses
these exact identities; [09](09-client-workflows-and-evaluation.md) verifies
analytical client workflows.
