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

The first or incomplete start prompts for tenant ID, client ID, hidden client secret and port (default `3001`). State is fixed at repository-root `.local/<lowercase-project>/`; there is no custom location. Use `pwsh ./deploy-local.ps1 start -Project newCustomer` to onboard or reuse `.local/newcustomer/`. Later starts reuse all saved values, including the port, without prompting. Open `http://localhost:<saved-port>` (default `http://localhost:3001`). Every `start` builds images, migrates, tests and starts the app. Build, test, lint, browser automation, Node and npm all run in Docker.

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

- Package previews belong to the current Agents flow: navigation, session revalidation, or a newer request discards late responses. Accepted package jobs continue across ordinary tab navigation, but responses from a cleared session or unmounted app cannot restore job state or overwrite current controls.
- Package and Power Platform exports can finish across tabs in the same session. Clearing the session or unmounting the app prevents late downloads and stale error/progress updates; an in-flight Power Platform export stays busy across tabs to prevent duplicate requests.
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
