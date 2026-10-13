# 03 - API authentication and asynchronous worker integration

## Mission

Atomically integrate 02's principal and credential foundation across approved API routes, all implicated service/provider operations, and asynchronous jobs. Preserve portal behavior and every existing authorization/data fence.

## Prerequisites

Read [README](README.md), [01](01-contracts-and-feasibility.md), [02](02-api-auth-foundation.md), and their exact completion records. Confirm foundation tests and interfaces exist. Preserve current changes and read repository/worker instructions.

## Read first

- [App](../../backend/src/app.ts), [authentication middleware](../../backend/src/middleware/auth.ts), [route policies](../../backend/src/routes/policy.ts), [auth routes](../../backend/src/routes/auth.ts), [API admission](../../backend/src/middleware/admission.ts).
- [Inventory routes](../../backend/src/routes/inventoryData.ts), [reports](../../backend/src/routes/officialReportData.ts), [refresh](../../backend/src/routes/dataSync.ts), [workbench](../../backend/src/routes/workbench.ts), [agent resolution](../../backend/src/routes/unifiedAgents.ts).
- [Package workers](../../backend/src/services/bulkJobs.ts), [Studio control](../../backend/src/services/copilotStudioQuarantineControl.ts), [Studio workers](../../backend/src/services/copilotStudioQuarantineJobs.ts), [capabilities](../../backend/src/services/capabilities.ts), [sessions](../../backend/src/db/sessions.ts).
- [HTTP regressions](../../backend/src/routes/authHttp.test.ts), [app regressions](../../backend/src/app.test.ts), [browser harness](../../scripts/permission-browser.tests.ps1), and the new 02 primitives/tests.

## Required implementation

1. Integrate the verified request principal into route policies and scope extraction. Declare exactly which existing operations accept bearer transport on the same canonical HTTP method/route used by the web app; sharing only a service behind separate MCP routes is insufficient. Public/browser-only routes remain explicitly classified. Omitted MCP client configuration keeps bearer admission explicitly disabled without disrupting cookie startup; invalid explicitly supplied configuration fails. Prove readiness with direct HTTP fixtures, not an MCP service.
2. Replace session-only assumptions in every affected handler and downstream caller with the common principal/credential interface. Audit `request.session.user`, `requireSession`, MSAL account lookups, provider capability validation, and job revalidation. Do not merely set `request.session.user` from JWT claims.
3. Preserve Origin/CSRF for cookie-authenticated browser requests. Bearer-only integration calls use token/scopes/roles instead; reject ambiguous mixed credentials and invalid tokens without browser/session fallback. OAuth callback/logout handling retains its own browser protections.
4. Preserve Viewer/Admin hierarchy, capability/provider-role evidence, maintenance admission, private reads, selected generation authorization, and account/session epoch invalidation. Revalidate bearer authority through the defined grant lifecycle, not an unrelated cached browser ID token.
5. Wire token acquisition/revalidation into refresh, directory enrichment, investigations, package/quarantine operations, and their worker paths. A user can use every supported delegated tool without a preceding portal sign-in.
6. Bind each worker to its initiating verified principal/credential authority; respect revocation between awaits and before provider dispatch/publication. Expiry/restart moves work to an honest authorization-wait state. A new same-user bearer call can explicitly resume unsent work, while sent-unknown items reconcile before any resend.
7. Keep saved GETs provider-free and do not start sync/canaries/hunting on token authentication. Permission readiness may be inspected independently; successful login alone is not provider authorization.
8. Remove superseded session-only integration plumbing in the same phase. Preserve browser sessions as supported input; no old/new credential fallback, duplicated route calculation, global CSRF exemption, or header-trusted user path.
9. Trace frontend assumptions and update directly affected API/error consumers to the canonical operation map. Add integration tests spanning HTTP entry, service authorization, DB scope, provider dispatch, jobs, disconnect, logout, and API restart. Preserve validated transport/application-client evidence for 03A's source derivation; no identity/origin headers become authority.
10. Update security and deployment/setup documentation with bearer boundaries, consent, mixed-auth policy, credential recovery, and role-revocation semantics.

## Scope guard

No new queries, MCP service, app-only customer access, approval policy, automatic scheduler, provider qualification gate, or production deployment. Existing optional canary workflows remain distinct from normal writes.

## Validation

- Add `src/routes/mcpApiAuth.test.ts` and select it with changed auth/app/service/job suites in one Vitest run.
- Run backend typecheck; run frontend build/lint only if consumers changed.
- Attempt the existing isolated DB/session/job checks and permission-browser harness. Record skipped/unavailable environments, not just the runner's exit code.
- Prove cookie protections, invalid bearer rejection, guest/native saved-data parity, bounded role/grant freshness and immediate internal epoch revocation fences, no portal-cache dependency, and no provider calls for saved reads.
- Capture method/route and normalized business inputs for matched web/bearer requests; prove one registered handler, equal domain defaults/results/errors, and no MCP-only route alias. Authentication and trace metadata are expected transport differences.
- Run `git diff --check`; all package/subprocess access follows README feeds.

## Production continuation

Apply README's Always-Deploy and two-part contracts. 04C deploys and observes API/web without MCP before the user-owned acceptance pause; 12 later proves actual MCP credentials. Repair reproducible scope/authentication regressions before affected admission opens. Browser behavior stays independently deployable while unsafe/unconfigured bearer admission is closed; no Part 1 consumer depends on 05.

## Completion record

Write `completions/03-api-auth-integration.md` with canonical route-policy/parity matrix, affected principal/token consumers, browser regression results, job/revocation/restart evidence, validated transport/client context for 03A, root impacts, residual containment, and 03A/04/05 prerequisites.

## Done and handoff

There is one active API authorization/credential mechanism with two supported transports. The approved saved and explicit-provider operations can run under a bearer user without a fabricated session or shared credential. All affected route/service/worker contracts are wired together.
