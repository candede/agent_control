# MCP improvements and evidence gaps

## Scope

These are follow-up recommendations from the read-only investigation, not
implemented changes or runtime acceptance gates.

Prioritize better access to existing canonical evidence and more useful outputs
before adding another analytics architecture.

## 1. Expose existing Office and department analytics through MCP

The application already has canonical Office:

- Context, summaries, and comparisons.
- Department/group views.
- History.
- People drilldowns.

It also has agent-adoption summary, department, and history views. These
contracts are currently marked **HTTP-only** in the
[MCP reference](../mcp-reference.md).

### Adoption benefit

Exposing the existing contracts would make the **1,381-person Office-to-agent
opportunity** easier and safer to retrieve without client-side reconstruction.
It would also support department prioritization and more consistent Office-aware
starter packs.

### Design direction

- Reuse the existing authorized canonical APIs and calculations.
- Preserve observation/baseline context, cohort definitions, privacy, paging, and
  missing-source semantics.
- Do not add a second scheduler, catalog, data store, generic SQL proxy, or
  independent metric authority.

## 2. Improve safe discovery's description and first-party coverage

The investigation verified:

- Staff inventory/MCP returns the SEHA Budget Assistant's complete Graph About.
- Employee discovery returns the same canonical agent with its description
  marked **absent**.
- Native Power Platform descriptions are absent in the observed inventory.
- The current employee catalog excludes Microsoft first-party package discovery.

The current source eligibility and description selection are in
[agentDiscoveryQueries.ts](../../backend/src/db/agentDiscoveryQueries.ts).

### Adoption benefit

The data exists, but a beginner-facing retrieval path cannot fully explain or
discover the agent's declared task capabilities. The desired adoption experience
also explicitly includes Microsoft agents.

### Design direction

- Reuse permitted Graph About evidence for an exactly linked, verified
  organization-created canonical candidate when its native description is
  absent.
- Do not simply treat every shared package as organization-created.
- Consider appropriate first-party discovery coverage for the supported adoption
  goal.
- Preserve privacy rendering, source authority, safe provenance, complete
  description continuation, and the distinction between a candidate match and
  proof of access/execution.

A better prompt or skill cannot recover evidence that the current safe
retrieval path does not return.

## 3. Add compact, server-calculated adoption opportunity outputs

A department opportunity/agent-usage summary would avoid retrieving large nested
people lists merely to rank gaps and assemble starter packs.

### Useful output

- Company/department.
- Saved eligible cohort and known coverage.
- Positive agent participation.
- Office familiarity where supported by the pinned observation.
- Relevant agents and usage spread.
- Suggested peer references.
- Unknown counts and evidence/context metadata.

### Adoption benefit

Less context consumption, fewer round trips, and fewer mistakes in denominators,
identity joins, ranking, or incomplete pagination.

Use counts and coverage alongside rates. Tiny saved groups must not be presented
as strong organization-wide adoption comparisons.

Keep the API responsible for calculations. A retrieval optimization should not
introduce a second business-data owner or speculative scoring framework.

## 4. Capture lightweight, validated learning cards

Telemetry identifies candidates. It does not establish the successful workflow.

Useful contribution fields are:

- Actual business task.
- An appropriate anonymized example.
- Successful prompt or prompt pattern.
- Expected output and review steps.
- Known limitations and common failures.
- Real data/access context.
- Optional measured outcome or time evidence.
- Contributor-confirmed transfer guidance.

### Adoption benefit

These cards transform local experimentation into knowledge other colleagues can
actually use. They support starter packs, peer demonstrations, and function-level
transfer.

Reuse canonical agent identities and permitted contact evidence. Keep knowledge
capture lightweight and do not require approval, certification, or an interview
before normal supported agent use.

## 5. Strengthen evidence and navigation reliability

### Observed conditions

| Condition | Observation | Required interpretation |
| --- | --- | --- |
| MCP authorization | Intermittent `authorization_unavailable` responses; later reads succeeded | Report the actual failure and preserve partial evidence, rather than claiming no data or silently bypassing authorization. |
| Directory refresh | Latest attempt failed with `provider_count_mismatch`; preceding complete source retained 4,054 users | The retained population remains saved evidence, but the failed refresh and current freshness must be disclosed. |
| Office coverage | Partial, including **397 paid users with unknown evidence** | Participation is a confirmed lower bound. Unknown people are not an additional population to add to the 700 without recent Office evidence. |
| Office current-source readiness | Fresh current derivation was unavailable while the previously captured observation remained readable | Current-source readiness must not rewrite a frozen observation into zero or imply historical inactivity. |
| Response reconciliation | Agents and Users & agents each total **11,552** responses; Users totals **11,578**, a difference of **26** | Keep source totals separate; do not blend, add, or invent a reconciliation. |
| User relationships | Overall active report users are **296**; positive bridge identities are **294** | Missing per-agent relationships cannot be guessed for users whose positive evidence comes from Users. |
| Usage input semantics | `inventorySelectionId` requires the same `selectionId`; the corrected request succeeded | Document and test cross-field constraints, not just individual field types. |
| Read invalidation | A web inventory facet read surfaced `selection_invalidated` during inspection | Preserve the explicit error and selected-context recovery semantics. |

### Adoption benefit

Trustworthy recommendations are more important than confident-looking output.
Clear errors and tested recipes also reduce avoidable AI trial and error.

### Design direction

- Document semantic input constraints and meaningful recovery guidance.
- Test recipes against current typed contracts.
- Preserve codes, request IDs when returned, retry timing, and partial evidence.
- Keep unknown, missing, stale, withheld, ambiguous, and explicit zero distinct.
- Do not silently change selected periods or fallback to success-shaped values.
- Do not make capability checks or invented release approvals prerequisites to
  ordinary supported saved reads.

## Boundaries for all future work

- Preserve real authentication, permissions, role checks, and destructive-action
  confirmations.
- Keep initial read-only synchronization automatic.
- Use current canonical implementations and data owners.
- Do not fabricate verified use links or personal access.
- Do not classify employee productivity or expertise from response counts.
- Do not expose private conversations or clinical/personal data merely to
  produce adoption materials.
- Do not implement changes solely to make the recommendation appear executable;
  verify actual affected discovery and first-use journeys.

## Recommended sequence of value

First produce the three deliverables supported by the investigation:

1. Department activation briefs.
2. Peer-derived use-case playbooks.
3. Office-to-agent starter pathways.

Then prioritize tool coverage and safe description retrieval that demonstrably
improve those outputs. Validated successful-work knowledge remains the largest
gap between usage telemetry and high-quality adoption guidance.
