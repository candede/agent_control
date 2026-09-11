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

Use the host and identity prerequisites in the [root runbook](../README.md): PowerShell 7, Docker with Compose v2, a browser, and an approved single-tenant Entra application when sign-in is required. Provider permissions are requested per capability rather than granted as one baseline bundle. Microsoft Agent 365 licensing applies to package APIs.

## Run Locally

From the repository root:

```powershell
pwsh -NoProfile -File ./deploy-local.ps1
```

Open `http://localhost:3001`. Build, test, lint, browser automation, Node and npm all run in Docker. See the [root runbook](../README.md) for retained project names, restricted identity secret input, lifecycle actions and isolated database tests.

## How To Use The App

1. Open `http://localhost:3001` and sign in when identity is configured.
2. Request only the package read capability needed for the selected delegated/application mode.
3. Explicitly refresh package observations; navigation itself never calls Microsoft Graph.
4. Search/filter saved rows and inspect package source, freshness, deployment, block state and assignments according to the current app role.
5. Use a block/unblock action only when its separate preview qualification is current, review the risk preview, then monitor the durable job and provider verification.
6. Reconcile an inconclusive item by read only; a new write always requires a new preview and confirmation.
7. Sign out when finished.

## Notes

- Microsoft Graph package list/detail use v1.0; block/unblock, access update and reassignment remain beta preview operations.
- HTTP `204` is acceptance, never mutation success without provider read-back.
- Access update fixtures prove exact payload preservation/readback, but product writes remain disabled because the endpoint has no documented `If-Match` or equivalent lost-update bound.
- Reassignment uses the documented beta `{ "userId": "<Entra user object ID>" }` adapter fixture but remains disabled because detail has no owner read-back field and the operation has no conditional-write header.
- Directory assignment IDs must be native Entra UUIDs and resolve exactly to current users, security groups or Microsoft 365 groups; deleted, duplicate, unresolved or redirected identities are rejected.
- Package selections keep the 5,000-target authority. When inline selection would exceed the 4,096-byte route budget, the URL carries only a count marker and the complete non-authoritative UI selection is kept in principal-scoped browser session storage; an unavailable or mismatched session record restores no partial selection and is reported visibly.
- [Package mutation canaries](../docs/mutation-canaries.md) documents the fixture-proven restoration command. Phase 13 owns any real approved tenant execution.

## Disclaimer

This project is provided as-is, without warranty of any kind. Use it at your own discretion and validate it in your own environment before relying on it for administrative workflows.

For more information, visit https://candede.com.
