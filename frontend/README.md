# Agent Control

## Quick Brief

This React client is built into the combined Agent Control Express artifact. The supported local workflow is the repository-root Docker deployment; there is no separate production frontend origin or host Node/Vite requirement.

## What This App Does

Agent Control presents saved, explicitly refreshed Microsoft Graph package observations and saved Power Platform inventory. Package list/detail reads use least-privileged delegated or separately approved application read access. Provider actions are capability-gated and never run on navigation.

Admins can use the app to:

- Sign in with a work or school account through Microsoft Entra ID.
- View authorized saved Copilot package observations.
- Search and filter agents by name, description, publisher, host, ID, or blocked state.
- Block or unblock a single Copilot agent.
- Select multiple agents and run bulk block or unblock actions.
- Inspect Available to and Installed for assignments when authorized.
- See package access controls disabled with the missing conditional-write protection explained.
- See owner reassignment disabled with its missing owner-readback/conditional-write contract and Microsoft documentation link.
- Review bulk action results, including succeeded, skipped, and failed packages.

The browser does not call Microsoft Graph directly. It calls the local Express backend, and the backend calls Microsoft Graph on behalf of the signed-in user.

## Requirements

Use the host and identity prerequisites in the [root runbook](../README.md): PowerShell 7, Docker with Compose v2, a browser, and an approved single-tenant Entra application's tenant ID, client ID and client secret for initial onboarding. Provider permissions are requested per capability rather than granted as one baseline bundle. Microsoft Agent 365 licensing applies to package APIs.

## Run Locally

From the repository root:

```powershell
pwsh ./deploy-local.ps1 start
# Omitting start is equivalent:
pwsh ./deploy-local.ps1
```

The first or incomplete start prompts for tenant ID, client ID, hidden client secret and port (default `3001`). State is fixed at repository-root `.local/<lowercase-project>/`; there is no custom location. Use `pwsh ./deploy-local.ps1 start -Project newCustomer` to onboard or reuse `.local/newcustomer/`. Later starts reuse all saved values, including the port, without prompting. Open `http://localhost:<saved-port>` (default `http://localhost:3001`). Every `start` builds images, migrates, tests and starts the app. Build, test, lint, browser automation, Node and npm all run in Docker. The JSDOM suite uses at most two workers so the complete operator gate does not starve time-bound UI tests on shared machines; test assertions and deadlines remain unchanged.

The only public commands are positional `start` (default), `stop` and `edit-config`, plus `-Project` (default `agent-control`). `stop` preserves data and secrets. `edit-config` prompts for all four settings; Enter keeps each current value, and the current secret is never displayed. Unchanged settings are not rewritten and leave a running app untouched. Accepted client ID, client-secret or port changes safely stop the app and leave it stopped until an explicit `start`. A changed port requires the matching Entra Web callback `http://localhost:<saved-port>/api/auth/callback`. Input validation does not validate live credentials.

The tenant ID can change before a database volume exists, and a previously missing tenant ID can be filled in. Changing a nonempty saved tenant ID on an existing volume is rejected before stopping the app or writing settings. Edits do not migrate data between tenants; use a separate project for another tenant. See the [root runbook](../README.md) and [operator-only maintenance helpers](../docs/operations.md#operator-only-local-helpers) for recovery and isolated database tests.

Changing the saved client/application ID on an existing volume records `control/reauthenticate` while the app is stopped. The next `start` clears only persisted login sessions before reopening, requiring sign-in under the new app registration. The session-signing secret and all business data are preserved. Secret-only and port-only edits do not schedule this purge.

## How To Use The App

1. Open `http://localhost:<saved-port>` (default `http://localhost:3001`) and sign in when identity is configured.
2. Request only the package read capability needed for the selected delegated/application mode.
3. Explicitly refresh package observations; navigation itself never calls Microsoft Graph.
4. Search/filter saved rows and inspect package source, freshness, deployment, block state and assignments according to the current app role.
5. For block/unblock, review the exact targets and risk preview, confirm the change, then monitor the durable job and provider verification. Ready to try does not require a prior canary; Microsoft authorizes the actual operation.
6. Reconcile an inconclusive item by read only; a new write always requires a new preview and confirmation.
7. Sign out when finished.

## Notes

- Agents renders server-resolved logical rows without browser-side name deduplication. Canonical and exact source links resolve to the same saved detail; every linked package retains its own inspection, access, installation and block target. Opening unified details does not require a Graph package-detail read, and an unavailable auxiliary package catalog does not hide saved Power Platform rows.
- Unified details and quarantine confirmations stay open through React Strict Mode effect replay. Cancelling a quarantine confirmation dismisses only that confirmation; its Escape and Tab handling stays within the active dialog. Unified details dismiss on actual backdrop clicks, not interactions with the dialog border or scrollbar.
- Activity shows both the total exact audit/security associations and the number displayed. Each source lookup currently returns at most 20 rows; a larger total is not a complete displayed history. Unavailable, unauthorized and unmatched sources remain distinct from an authorized empty result.
- Agents focuses on search, filters and unified management, with only a compact Open Sync notice when inventory needs attention. **Sync > Advanced results**, collapsed by default, contains the backend's full saved-inventory verification receipt: Graph package and Power Platform agent targets, targets represented exactly once versus unique source targets, logical agent count, and separate source-scope, metadata and identity-link checks. These totals cover all unfiltered saved records, not the visible page or display filters. Verification proves saved collection/accounting/consistency; it does not prove all source-only rows are distinct physical agents or guarantee universal tenant visibility.
- Power Platform verification compares the provider total with stored rows and normalized unique resource identities, with the actual page count and persisted executed types (`verification.queriedTypes`). Requested and executed type counts are distinct: an AI-scoped request may execute fewer types, and later role hints or policies never expand the historical executed-type evidence into verified zeros. Scope is shown as All environments requested or the real requested environment. Optional directory-role hints are diagnostic only: absent hints show Not supplied, not failed collection, and neither supplied nor absent hints attest permissions. Not requested, outside-authorized-scope and genuinely unknown coverage remain distinct; missing snapshots are not reported as zero inventories.
- Saved inventory checks run automatically; no manual verification or administrator approval is required after sync. The optional **Verify saved inventory** action in **Sync > Advanced results** or the selected Explorer snapshot reloads existing saved APIs. Expanding Advanced results starts no work. Verification starts no provider collection or clearing, suppresses automatic identity backfill for that verification read (including page correction), and preserves revision/session fences. Pending and failed checks replace the prior green receipt explicitly; a concise attention notice remains visible while diagnostics are collapsed. Saved verification time (`checkedAt`) is separate from source collection time (`observedAt`); rechecking never renews native-control freshness.
- A missing saved source is not a verified empty inventory. Source-dependent checks report unavailable evidence rather than successful checks; verified empty snapshots retain explicit zero counts. Receipts needing attention label their timestamp as a check time, not a successful verification time.
- Microsoft Power Platform inventory excludes classic/V1 bots, and recent changes may take about 20 minutes to appear. This is a source-scope/propagation caveat, not a failed-sync condition or a 20-minute expiry for a verified saved snapshot. Real collection restrictions, pending/invalid metadata, and ambiguous/conflicting links remain visible and actionable.
- Agents exports server-generated `agents.csv`, with one row per logical agent retaining every package ID/state, native Power Platform configuration and `inventoryPartial`. Matching export uses the same environment, search, other filters and sorting as the list, across all pages rather than only visible rows. Server limits are 5,000 resolved agents, 8 MB and 15 seconds of CSV generation; narrow filters or reduce the selection if a limit is reached.
- Selected export uses the existing exact package/native selection across pages, preserves observed canonical IDs and sends source-qualified references for off-page targets. The server resolves aliases once per agent; current filters do not narrow the selection, but sorting is preserved. Selected reference counts are not agent counts. Pending restoration disables selected export only and can be canceled with Clear selection; exporting never updates native-control proof or selection snapshots.
- Unified export requires an authenticated Viewer session, CSRF protection and the current saved source revision, not Graph provider permissions or a package summary request. A missing/invalid revision or failed unified filter read disables export until a successful saved read. HTTP 409 stops the download and requires a saved-inventory reload, selection review and explicit retry; there is no automatic source-export fallback or provider refresh. Existing Power Platform explorer/source exports remain separate and unchanged. Unified exports are recorded under the Export agent inventory audit action.
- Invalid matching metadata triggers a compact attention notice on Agents. Detailed counts and explicit selected-package or full-inventory refresh instructions are available in **Sync > Advanced results** and the affected agent's detail. Checked package counts are not valid-metadata or matched-agent counts, and invalid counts alone never trigger automatic retry. Source-specific identity warnings remain in Technical details without changing the backend's link state.
- Manifest/schema/native and environment/application evidence remains source-declared metadata, not a Microsoft canonical identity guarantee or a CDS quarantine target. Graph-only canonical groups retain all exact package controls and any saved environment without inventing a Power Platform resource. Package details still derive Connected services from complete element definitions, including AgentMetadatas; identity normalization must not silently truncate that UI input.
- Uniquely anchored shared custom-engine bot evidence can list related exact package IDs in both Technical details evidence sections. Those IDs describe proof provenance; every opaque package keeps its own management target, and shared bot application identities never become CDS quarantine targets.
- Power Platform source details show the raw `createdIn` provider origin separately from normalized authoring, including unknown future origins. Empty outer element labels do not remove definition-backed details or identity evidence. Labels are diagnostic only; source association is current authorized saved-inventory correlation, not a Microsoft-guaranteed native foreign key, and never grants or renews native controls.
- Quarantine selection is keyed by exact environment/native resource identity, not the changing display-row identity. Canonical/source bookmarks resolve through saved inventory, including off-page targets, without promoting package or manifest IDs into CDS bot identities. Restored selections cannot silently switch inventory snapshots; unavailable, ambiguous or ineligible targets produce a visible explanation. Pending restoration can be canceled without a late response reselecting targets, and does not block saved details or individual package controls.
- Package previews belong to the current Agents flow: navigation, session revalidation, or a newer request discards late responses. Accepted package jobs continue across ordinary tab navigation, but responses from a cleared session or unmounted app cannot restore job state or overwrite current controls.
- Unified Agents and Power Platform exports can finish across tabs in the same session. Clearing the session or unmounting the app prevents late downloads and stale error/progress updates; in-flight exports stay busy across tabs to prevent duplicate requests.
- Power Platform agent refresh and resume submissions stay busy across tab and browser-history navigation in the same session. Accepted results and errors remain tracked away from Sync, and successful completion reloads saved inventory. Only visible-tab progress polling pauses on navigation; clearing the session or unmounting the app still discards late responses.
- Browser storage is optional for package-job continuity. Read, write, and removal failures produce a visible warning without preventing private-state cleanup or tracking an accepted durable job. Retained work remains recoverable through Jobs with current authorization.
- Sync preserves newer Power Platform refresh/resume and polling results when a saved-history read finishes late. A failed history read is reported explicitly without discarding successfully loaded saved agent inventory.
- Evidence-backed provider actions require a valid check timestamp at or before the UI clock and an expiry strictly after it, as well as current backend authorization and freshness. Missing, invalid, or future check timestamps cannot enable actions. An omitted verification level remains compatible with otherwise valid evidence but never claims provider verification.
- Delegated and application evidence continues to expire in the UI during catalog reloads and pending permission checks. Only delegated expiries trigger automatic checks; application evidence expires without starting an application operation. Failed catalog reloads expose an error and allow another Check status attempt, including when they replace the initial catalog request.
- A delayed expiry retry spends its one-attempt budget only when a check starts. If its deadline passes during another check, it remains due unless that check renews the expired evidence.
- On-demand readiness follows the registered delegated probe contract, including license assignments and Copilot usage reads as well as package and quarantine changes. These rows are Ready to try, not provider-verified, and require no check timestamps. Exact-target change confirmation applies to control operations, not read-only license or usage operations; viewing Permissions does not execute either.
- Microsoft Graph package list/detail use v1.0; block/unblock, access update and reassignment remain beta preview operations.
- HTTP `204` is acceptance, never mutation success without provider read-back.
- Access update fixtures prove exact payload preservation/readback, but product writes remain disabled because the endpoint has no documented `If-Match` or equivalent lost-update bound.
- Reassignment uses the documented beta `{ "userId": "<Entra user object ID>" }` adapter fixture but remains disabled because detail has no owner read-back field and the operation has no conditional-write header.
- Directory assignment IDs must be native Entra UUIDs and resolve exactly to current users, security groups or Microsoft 365 groups; deleted, duplicate, unresolved or redirected identities are rejected.
- In the access editor, specific users or groups require current directory access and completion of the initial assignment lookup. Restoring directory access preserves edits after initialization; cancelled lookups restart when access returns. Choosing No users does not depend on that lookup because the replacement contains no principals. Package capability checks and replacement confirmation still apply to both scopes.
- The access editor captures its initial scope and assignments when opened; parent rerenders cannot restore removed principals or change a pending confirmation. Close and reopen to load a new starting state. While an access submission or caller-reported busy operation is pending, target, mode, scope, and directory picker controls remain locked. A failed submission preserves the draft and requires replacement confirmation again before retrying.
- Package selections keep the 5,000-target authority. When inline selection would exceed the 4,096-byte route budget, the URL carries only a count marker and the complete non-authoritative UI selection is kept in principal-scoped browser session storage; an unavailable or mismatched session record restores no partial selection and is reported visibly.
- [Package mutation canaries](../docs/mutation-canaries.md) documents the fixture-proven restoration command. Phase 13 owns any real approved tenant execution.

## Disclaimer

This project is provided as-is, without warranty of any kind. Use it at your own discretion and validate it in your own environment before relying on it for administrative workflows.

For more information, visit https://candede.com.
