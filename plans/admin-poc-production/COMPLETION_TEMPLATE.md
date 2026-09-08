# Phase Completion Record Template

Supporting document only. Write the instantiated record to the exact path in the assigned numbered prompt. Do not create a completion record before implementation. Replace placeholders with observed facts; omit secrets, personal identifiers and source content.

## Status

```yaml
phase_file: <exact numbered filename>
phase_status: <in_progress or complete>
outcome: <completed, completed_with_disabled_capabilities, completed_with_residuals, deployment_pending, or unset while interrupted>
validated_at_utc: <timestamp>
execution_target: <local, approved isolated target, or approved production boundary>
```

`deployment_pending` remains `in_progress`. Complete outcomes require implemented requirements and attempted verification; an unimplemented feature is not an unavailable provider. Verify relevant delivered artifacts against the current worktree; do not calculate prompt/README/per-file hashes or create a separate campaign ledger.

## Delivered contracts

- Actual behavior and fulfilled phase requirements.
- Module, type/API, migration/schema, test and runbook paths; direct-cutover removals.
- Autonomous decisions and downstream constraints, including identities, states, visibility, retention and bounded defaults.
- Permission/role/configuration changes and activation versus disabled state.

## Changed files

List actual changed paths and their purpose, grouped by root only when helpful. Mention checked-but-unchanged contracts only when needed to explain a downstream decision. No per-file hash table.

## Validation evidence

| Check / exact command                   | Environment / revision             | Status                                           | Observed result and safe evidence location |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| <focused test>                          | <target>                           | <passed/failed/not_run/unavailable/inconclusive> | <exit code, relevant summary, timestamp>   |
| <aggregate command>                     | <target>                           | <real status>                                    | <observed result>                          |
| <live probe / canary, where applicable> | <approved opaque target reference> | <real status>                                    | <contract/coverage/freshness; no content>  |

Record repair/rerun evidence, not just the last passing label. Build success is not behavioral proof; unavailable credentials are not a successful provider test.

For applicable local changes, record the exact Docker invocation, test database/origin and cleanup. Phase 01 also records `deploy-local.ps1` fresh/rerun evidence, two-service health, persisted volume/secret recovery and image/ZIP output contracts. Later phases link that contract and record changed behavior rather than repeating the setup inventory. No host Node/Vite/PostgreSQL process is required by the delivered workflow.

## Open issues

| ID / originating phase | Affected scope / evidence status | Containment         | Signal / threshold     | Responsible operator or role | Exact fix-forward trigger / next action |
| ---------------------- | -------------------------------- | ------------------- | ---------------------- | ---------------------------- | --------------------------------------- |
| <stable residual ID>   | <precise uncertainty/defect>     | <enforced boundary> | <canary/alert/recheck> | <owner>                      | <resumable action>                      |

Use the table only for new issues. Link inherited unresolved issues to their origin record; do not copy their details or every prior risk table. Note changes or closure with observed proof. Distinguish disabled retained providers from broken core implementation. Uncompleted cleanup/restoration remains an owned incident. Future ideas are not campaign issues.

## Next session

- Exact next-phase artifacts/preconditions, checked against current code.
- Missing prerequisite or interrupted work and exact same-phase resume action.
- Copyable instruction to implement only the next manifest prompt, or resume this one. Stop here; do not run the next phase in this session.

For Phases 12/13 also record the `deploy-azure.ps1` invocation, approved target/budget and dated estimate source, actual managed resource SKUs, existing vault ID and selected secret-version references without values, the single deployed artifact revision/checksum/architecture, URL, schema/migration/backup receipt, runtime/admin separation, maintenance/recovery/canary results, cleanup state and production health. Release checksums are retained; ordinary phase paperwork does not expand into per-file evidence manifests. A build/upload alone is not a completed production deployment.
