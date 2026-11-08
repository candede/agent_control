# Copilot agent adoption implementation campaign

## Purpose and status

Turn Agent Control's saved evidence into useful department activation briefs,
transferable learning cards, customer-ready AI guidance, and tracked adoption
actions. This is an **implementation plan**, not an implementation or a claim of
validated deployment.

Created on November 8, 2026. The
[previous analysis](../copilot-agent-adoption-intelligence/README.md) remains an
unchanged, point-in-time research report. Its tenant counts are not current
constants, acceptance thresholds, or customer-facing examples.

## Approved decisions

The user confirmed this folder and the following operating boundaries:

- Use existing app roles only. `AgentControl.Viewer`,
  `AgentControl.UsageReportUploader`, and `AgentControl.Admin` retain their
  hierarchy. A validated, active roleless tenant member is an EndUser; do not
  create an EndUser, Champion, Maker, or AdoptionManager role.
- Staff authors create adoption content; creators and assigned owners maintain
  it within the object-level policy in [CONTRACT](./CONTRACT.md). Admins manage
  all tenant adoption content. EndUsers see only explicitly shared,
  privacy-safe learning cards through the existing discovery boundary.
- Prefer the simplest complete, robust current implementation. No compatibility
  routes, aliases, duplicate data owners, migration chains, or speculative
  workflow/analytics platform.
- Schema changes and a clean database reset are authorized when needed for the
  optimal current solution. The user explicitly prefers starting over to
  preserving an inferior design for old stored data. Do not perform a reset
  merely because it is convenient.
- Future execution may update the existing local SEHA app/MCP deployment,
  change its schema, perform the justified clean reset, and observe recovery.
  This plan-authoring task performs none of those actions.
- Preserve real authentication, permissions, destructive-action confirmations,
  and integrity constraints. Never turn campaign bookkeeping or verification
  into runtime authorization.
- Do not commit, push, create branches, deploy to Azure, or modify unrelated
  installations as part of this campaign.

## Approach verdict and target flow

**Verdict: keep the consumer-led approach, with selective backend/MCP extensions.**

The current app already owns evidence, joins, metrics, source publication, and
authorization. Rewriting those in MCP or an AI client would add competing truth.
A prompt-only solution is also insufficient: Office tool coverage, safe
descriptions, cross-source cohorts, and durable adoption content need application
contracts.

The chosen runtime flow is:

1. Normal sign-in or authenticated MCP entry automatically admits initial
   read-only synchronization. Missing sources remain explicit.
2. The API selects saved report/Office/inventory contexts and calculates exact
   department opportunities.
3. Thin, typed MCP actions expose that evidence and complete permitted agent
   descriptions.
4. A customer-configured AI consumer uses focused instructions/skill guidance
   to produce a brief, draft exercises, and peer-learning suggestions.
5. On an explicit save request, MCP calls the same adoption-content API used by
   the browser. The app displays saved briefs, actions, and learning cards.
6. Authors can share suitable learning cards with employees. The discovery API
   applies current privacy and source rules on every read.
7. Teams capture real successful workflows and compare suitable follow-up
   evidence, without treating response counts as expertise or ROI.

No hosted LLM service, autonomous outreach scheduler, second catalog, champion
registry, generic SQL/HTTP tool, or sixteen use-case-specific tools are needed.
The tradeoff is deliberate: users configure their AI consumer; the web app does
not pretend it can generate AI output without one.

## Ordered executable manifest

Run these prompts in this exact order, one active phase at a time.
README and CONTRACT are support documents, not executable phases.

| Order | Prompt and implementation owner | Prerequisites | Exact completion record |
| --- | --- | --- | --- |
| 01 | [Evidence APIs and MCP reads](./01-evidence-apis-and-mcp-reads.md): canonical evidence, exact opportunity cohorts, read bindings and shared fixtures | None | `completions/01-evidence-apis-and-mcp-reads.md` |
| 02 | [Safe discovery and agent descriptions](./02-safe-discovery-and-agent-descriptions.md): linked descriptions, first-party coverage, staff/EndUser parity | 01 contexts and representative fixtures | `completions/02-safe-discovery-and-agent-descriptions.md` |
| 03 | [Adoption workspace and learning cards](./03-adoption-workspace-and-learning-cards.md): current schema, object authorization, API/MCP persistence, UI and employee-safe sharing | 01, 02 | `completions/03-adoption-workspace-and-learning-cards.md` |
| 04 | [MCP instructions and tool descriptions](./04-mcp-instructions-and-tool-descriptions.md): actual connection instructions, descriptions and executable recipes | 01, 02, 03 | `completions/04-mcp-instructions-and-tool-descriptions.md` |
| 05 | [Customer agent starter kit](./05-customer-agent-starter-kit.md): general/adoption instructions, skill package, Studio setup and sample prompts | 04 and its implemented contracts | `completions/05-customer-agent-starter-kit.md` |
| 06 | [End-to-end and capacity verification](./06-end-to-end-and-capacity-verification.md): integrated journeys, model/client evidence, scale, privacy and reset proof | 01-05 | `completions/06-end-to-end-and-capacity-verification.md` |
| 07 | [Deploy SEHA and observe](./07-deploy-seha-and-observe.md): exact local rollout, justified reset, live journeys, fix-forward and cleanup | 06 evidence and residuals | `completions/07-deploy-seha-and-observe.md` |

## Running a prompt in a fresh session

Open the repository in the new session and ask, for example:

```text
Implement docs/copilot-agent-adoption-implementation/01-evidence-apis-and-mcp-reads.md
end to end. Read the folder README and CONTRACT first, honor the approved
boundaries, run the required checks, and write the exact completion record.
Do not execute another phase or stop at recommendations.
```

For later phases, substitute the next manifest file. The phase must read its
prerequisite completion records and reconcile them with actual code.
Alternatively, run `implement-folder` on this folder for sequential execution.

The first phase creates
`completions/IMPLEMENTATION_CAMPAIGN.md`; subsequent sessions update it. Record
the stable manifest, SHA-256 hashes of prompts/shared contracts, actual targets,
completed work, true validation results, residuals, and the exact next action.
Do not create speculative phase-completion records before implementation.
Changed contracts invalidate only the affected prior proof.

Follow the installed `implement-folder` and step-worker contracts where
available. Every delegated worker uses `gpt-6.1-sol` with `xhigh` reasoning;
record actual launch settings rather than claiming prompt wording selects them.
Use direct execution when delegation is inappropriate. Do not nest workers or
create a reviewer pool. These are implementation settings, not a required
customer Copilot Studio model.

## Roots and current anchors

Resolve repository root from the current workspace; do not hard-code another
machine's filesystem path. The application boundaries are:

- [backend](../../backend/): Node API, PostgreSQL schema, evidence and authorization.
- [mcp](../../mcp/): FastMCP transport, typed actions, OAuth and server guidance.
- [frontend](../../frontend/): staff workspace, employee handoff and customer kit.
- [scripts](../../scripts/), [infra](../../infra/), and deployment files:
  current local lifecycle, images, grants and qualification.

Read [AGENTS](../../AGENTS.md), [CONTRACT](./CONTRACT.md),
[data architecture](../data-architecture.md), [MCP reference](../mcp-reference.md),
[roles](../user-roles-and-permissions.md), and [operations](../operations.md).
An unchanged root still needs a factual impact check in the completion record.

## Authorized environments

### Disposable integration

Use the existing local Docker engine and checked-in fixture runners. Resolve
their exact project/database/image safeguards before use. Create only named,
isolated campaign resources; no live credentials, fixture-auth production mode,
shared-database test tables, external test VM, or new cloud resources.

The current app uses Node 24 and the MCP manifest requires Python 3.14. Reuse
available project dependencies/images. Restore dependencies only after a
manifest change or genuine missing-tool failure, through the approved feeds in
CONTRACT. Do not install or probe public package registries.

### Live rollout

The authorized live target is the existing SEHA installation on this machine.
Read-only inspection on November 8 observed:

- Docker context: `desktop-linux`.
- **Compose project label: `seha`**, not the container-name prefix.
- Containers: `seha-agent-control-app-1`, `seha-agent-control-mcp-1`,
  `seha-agent-control-postgres-1`.
- App: `127.0.0.1:3002`; MCP: `127.0.0.1:3003`; PostgreSQL has no host mapping.
- Existing app browser origin:
  `https://mgzftq2n-3002.euw.devtunnels.ms`.

Recheck those exact identities at execution; the deployment uses immutable
source snapshots, so an observed snapshot path or image ID is not the next
release identity. Obtain the MCP public resource URL from current non-secret
configuration/metadata, not by guessing from the app tunnel.

Use [deploy-local](../../deploy-local.ps1) with `-Project seha` and its existing
runtime/MCP helpers. Never touch `automations-mcp-ui-dev` or other projects.
Reset only the verified `agentcontrol` application database through the
existing guarded reset operator when the implemented current schema requires it.
Do not delete PostgreSQL volumes, erase security revocation authority, or run
broad Docker cleanup.

## Always-Deploy Production Contract

This is the single binding campaign deployment policy. Every phase must obey it.

1. The campaign ends with authorized live deployment, observation, and
   fix-forward handling, not test-only readiness.
2. Applicable local, database, browser, model/client, restore and capacity checks
   are mandatory attempts. Repair reproducible defects and record actual
   `passed`, `failed`, `not_run`, `unavailable`, or `inconclusive` results.
   Missing measurements are unknown, never zero.
3. Non-passing evidence alone is not an invented release veto. Each residual
   needs affected scope, a concrete existing containment mechanism, signal or
   canary, numeric alert threshold, implementation owner, and exact fix-forward
   trigger. Unimplemented promised behavior is not a completed phase.
4. Unsafe disclosure or mutation remains denied by real existing authorization,
   privacy and integrity controls while safe/unaffected code and recovery
   deploy. Do not create feature-enable, approval, certification, canary-token,
   or release-acceptance requirements for ordinary saved reads or discovery.
5. Isolate synthetic qualification. Observe the exact deployed revision's
   genuine first-run and adoption journeys. Defects require containment, root
   fix, focused check, exact redeploy, and rerun; no revived legacy writer.
6. Cleanup failures remain owned cost/security incidents; they do not turn
   deployment into test-only success or justify broad deletion.
7. Only actual inability to execute authorized deployment actions may leave
   `deployment_pending`. Keep the campaign open with the exact resumable
   action. Deployed but unproven promised journeys remain
   `production_hardening_pending`, not complete.

Planning authorization does not broaden the target. Do not infer authority from
credentials, historical receipts, default project names, or an available cloud
subscription. The user has already authorized this local campaign's ordinary
implementation and justified reset; do not invent another routine approval.

## Completion and handoff

Each phase uses the factual record requirements in CONTRACT. Final completion
requires the useful whole flow, aligned current contracts, all seven records,
the deployed release identity, actual live observations, and owned residuals.
Builds, a successful MCP handshake, or green health endpoints alone do not
establish adoption usefulness or successful agent execution.
