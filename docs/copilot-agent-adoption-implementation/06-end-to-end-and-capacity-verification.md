# 06 - End-to-end and capacity verification

## Mission and prerequisites

Prove the complete adoption flow, including the actual AI consumer, safe
employee learning, new content, current schema/reset and bounded large-tenant
retrieval. Repair coupled defects in their owning contracts; do not wrap them
with a final workaround or stop at green builds.

Prerequisites: phases 01-05 and all five exact completion records. Read them,
campaign state, [README](./README.md), and [CONTRACT](./CONTRACT.md).

## Read first

- [Validation runbook](../operations.md#validation),
  [large-tenant runner](../../scripts/large-tenant-tests.ps1),
  [fixture](../../backend/scripts/largeTenantFixture.ts),
  [fixture safeguards](../../backend/scripts/fixtureSupport.ts).
- [MCP fixture runner](../../scripts/local-mcp-fixture.ps1),
  [container journey](../../mcp/tests/container_journey.py),
  [browser fixture](../../backend/scripts/browser-fixture.browser.ts),
  [browser config](../../frontend/playwright.config.ts).
- [Compose scale override](../../compose.large-tenant-test.yaml),
  [build packaging](../../Dockerfile),
  [MCP check commands](../mcp-reference.md#verification).
- [Guarded reset](../../backend/scripts/databaseReset.ts),
  [operator](../../backend/scripts/database.ts),
  [operations/reset and recovery](../operations.md).
- Actual new APIs/UI tests and the **distributed** phase-05 customer assets.

Resolve exact approved dependency/browser image tags and immutable IDs.
Use current backend, frontend and MCP source mounts/images; do not accidentally
exercise stale frontend helpers from a reused test image.

## Integrated journey matrix

Implement these cases in existing fixture/browser/MCP runners:

1. **Staff department brief:** exact company/department, pinned independent
   windows, exact opportunity/unknown counts, Microsoft/local candidates, exact
   champion edges, complete About, generated starter tasks and evidence caveats.
2. **Save and follow-through:** consumer explicitly saves brief/actions through
   MCP; another authorized staff account sees the same records in the app;
   creator/assignee update behavior, concurrency conflict, retry idempotence
   and exact delete work.
3. **Peer knowledge transfer:** a contributor-provided anonymized workflow is
   saved, its sharing is changed, and an EndUser retrieves only the safe card.
   A generated draft never acquires successful-work/ROI status by inference.
4. **Real member boundaries:** Viewer/Uploader/Admin share saved evidence;
   roleless active members have discovery/cards only; cross-tenant and revoked
   members are denied; missing saved workplace/licensing does not prevent
   permitted catalog discovery. Do not create a new role.
5. **Staff preview:** explicitly selected subject stays labelled and subject-
   bound; actual staff actor never becomes the subject; no staff count leakage;
   subsequent self-service returns to the actual caller.
6. **First run/reset:** fresh current schema and isolated guarded reset, ordinary
   browser sign-in and MCP authenticated entry, automatic initial read-only
   sync, explicit missing CSV/source states, and useful catalog/workspace access
   without Permissions/check/enable/approval visits.
7. **Privacy/injection:** all flag combinations, flags changing after save,
   hidden identifiers in About/card prose, malicious embedded instructions,
   stale source authority and removed agent references across list/detail/
   continuation/copy/download/MCP/UI paths.
8. **Evidence failure:** missing/partial/ambiguous Office/report data, source
   total differences, duplicate agent names, aggregate-only Office history,
   overlap, selection invalidation, provider/backoff/auth errors and limit
   responses never become false zero, inferred joins or success-shaped output.
9. **Actual first-use guidance:** candidate capabilities/access are correctly
   labelled; verified returned use links work where genuinely available; no
   launch URL or provider execution is invented.
10. **Usability:** empty/error/loading states, keyboard/focus, mobile layout,
    copy/download, action feedback, cancelled requests and principal-scoped
    caches. No browser call to MCP or fake AI-generation button.

## Customer/model qualification

Use the phase-05 assets as customers receive them, not a privileged internal
prompt. Attempt:

- One existing authenticated skill-capable client.
- Copilot Studio with its actual configured harness/OAuth connection where
  available; verify real tool selection and connection identity, not just HTTP.
- The supported instruction-only path where a skill cannot be imported.

Run representative department, beginner discovery, peer-learning/save and
error/privacy prompts. Use at most three attempts per representative scenario;
record model/host, actual tools, source support, completeness and false claims.
Do not provision new paid models or send private data to unauthorized services.

Automated schema/protocol fixtures and lexical assertions are not semantic/model
proof. No mandatory LLM judge/evaluator service. When real client/authentication
is unavailable, record the exact limitation and resume action rather than
calling interoperability passed.

## Exact capacity checks

Use the checked-in synthetic scale fixture in an isolated project/database:

- At least 10,000 people and 500 company/department groups, multiple companies
  sharing department names, overlapping reports and ambiguous/unknown identities.
- Compact opportunity page: at most ten groups and **128 KiB UTF-8**.
- At least twenty warmed compact reads: **p95 at most two seconds**; record
  actual SQL/HTTP timing and achieved scale on this host.
- Representative complete brief retrieval: **at most 32 calls, 4 MiB, 180
  seconds** excluding actual auth waits.
- Controlled three-peer/three-agent case with descriptions at most 16 KiB:
  target **at most 16 calls and 1 MiB**, without clipped About or omitted edges.
- Large-description/limit test: explicit partial/unavailable output if the
  supported budget cannot retrieve all required text; never fabricated completion.

Measure traces/counters without logging sensitive content. Do not reduce fixture
size, skip pages, widen bounds silently or weaken thresholds to manufacture a
pass. Repair query/shape/recipe issues, or retain honest residual evidence with
production containment and fix-forward ownership.

## Commands and environment

Run appropriate aggregate checks once against current content, reusing valid
phase-specific proof:

```sh
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
npm run test --workspace frontend
npm run lint --workspace frontend
npm run check:unused
npm run build
git diff --check
```

From `mcp/`:

```sh
.venv/bin/python -m pytest
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

Combine affected backend non-DB selectors. Run DB/browser/image suites through
the existing isolated runner after reading its current help/parameters:

```powershell
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-container
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end -BaselineImage <verified-image> -BaselineImageId <verified-sha256>
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite cutover-browser-contract -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts,dataSync.spec.ts" -BaselineImage <verified-image> -BaselineImageId <verified-sha256> -BrowserImage <verified-browser-image> -BrowserImageId <verified-sha256>
```

Add the new workspace/discovery/kit cases to those runner selections. Resolve
placeholders to verified existing image IDs; they are not literal commands.
Use the scale compose override when the default PostgreSQL tmpfs is too small.
Attempt current-schema backup/restore into an isolated target; never restore a
fixture or old schema into live SEHA.

Record every exact test project/container/database/image and clean only
campaign-owned resources. Do not touch the live SEHA or unrelated automations
stack, use broad `prune`, delete volumes, or kill by process name.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
Repair practical defects and attempt every applicable check. Non-passing
evidence does not invent a release acceptance gate: attach scope, real
containment, numeric signals, owner and exact fix-forward trigger for phase 07.
No claimed complete implementation with missing owned code or false evidence.

## Completion and next phase

Write `completions/06-end-to-end-and-capacity-verification.md` and update campaign
state. Include the requirement/journey matrix, true commands/case counts,
model/client evidence, measured bounds, reset/restore proof, cleanup baseline,
exact candidate identity and all production residuals.

Done means the implemented whole flow was tested to the best actually available
evidence and reproducible issues were repaired as far as practical. Phase 07
receives deployable current source plus truthful residuals, not a GO/NO-GO verdict
or a test-only completion claim.
