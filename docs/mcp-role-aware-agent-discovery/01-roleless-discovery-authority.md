# 01 - Roleless discovery authority and first-run onboarding

## Mission and prerequisites

Implement verified default employee access without creating an EndUser app role,
weakening staff authorization or leaving an employee-first installation empty.
Keep authorized read-only staff preview separate from actual user identity.
Own deployment configuration for the two README contract C privacy settings;
phase 02 owns their safe-output enforcement.
Prerequisites: none.

Read and obey [README](README.md), especially contracts A/B and the binding
always-deploy production contract. This is executable only after the user
explicitly starts the future campaign.

## Read first

- [Repository instructions](../../AGENTS.md), installed implementation/worker
  contracts and `completions/IMPLEMENTATION_CAMPAIGN.md` when resuming.
- [Role hierarchy](../../backend/src/types/capability.ts),
  [bearer admission](../../backend/src/auth/mcpBearer.ts),
  [principal mapping](../../backend/src/auth/requestPrincipal.ts),
  [MSAL](../../backend/src/auth/msal.ts),
  [session middleware](../../backend/src/middleware/auth.ts),
  [route policy](../../backend/src/routes/policy.ts) and
  [auth routes](../../backend/src/routes/auth.ts).
- [MCP auth](../../mcp/src/agent_control_mcp/auth.py),
  [API exchange](../../mcp/src/agent_control_mcp/api.py),
  [request authentication](../../backend/src/middleware/requestAuthentication.ts),
  [directory fields](../../backend/src/services/userSourceGraphFields.ts),
  [directory principals](../../backend/src/services/directoryPrincipals.ts).
- [Automatic collection](../../backend/src/services/dataSync.ts),
  [sync routes](../../backend/src/routes/dataSync.ts),
  [capability ownership](../../backend/src/services/capabilityRegistry.ts),
  [user collection](../../backend/src/services/userSourceProvider.ts).
- [Browser authorization](../../frontend/src/authorization.ts),
  [application](../../frontend/src/App.tsx),
  [signed-in role explanation](../../frontend/src/components/SignedInUserRoles.tsx),
  [registration guide](../../infra/entra-id-api-mcp-app-registrations.md),
  [manifest](../../infra/entra-app-manifest.json) and
  [role guide](../user-roles-and-permissions.md).
- [API configuration](../../backend/src/config.ts),
  [local MCP settings owner](../../scripts/local-mcp.ps1),
  [local deployment owner](../../scripts/local-deployment.ps1),
  [Compose metadata overlay](../../compose.mcp-metadata.yaml),
  [Azure deployment owner](../../scripts/azure-deployment.ps1),
  [API infrastructure](../../infra/main.bicep) and
  [MCP infrastructure](../../infra/mcp.bicep).

## Concrete work

1. Capture the actual current operation-to-route/role baseline from the finite
   MCP catalog and API policy. Establish a falsifiable case: a valid roleless
   member can reach a minimal discovery access profile but cannot read adoption
   or invoke any existing control, sync, job or directory enumeration route.
2. Accept absent/empty roles only after existing signed delegated-token,
   tenant/audience/client/scope/time and same-user checks. Preserve unknown-role,
   malformed-role, workload-token, revocation and failed-revalidation rejection
   across Python exchange, API bearer mapping, browser/session types and tests.
   Keep the three existing AppRole values; derive the effective audience in one
   API owner instead of inventing an EndUser claim or changing `hasAppRole`.
3. Implement bounded exact active-member eligibility verification using the actual
   tenant-local `oid`, including employees absent from licensed/reported user
   snapshots. Reuse existing application token, directory parsers and cancellation
   owners. No Copilot license or manual directory sync requirement. Cache only
   within current identity/expiry bounds; provider failure is explicit.
   Personal workplace fields come from the canonical stored account, not this
   lookup's live fields, token claims or guessed email-domain affiliation.
4. Provide one authenticated, bounded MCP access-profile endpoint backed by the
   authoritative route/operation policy. Return the effective audience and allowed
   canonical method/route keys and existing finite role-controlled input choices
   needed for projection, not provider diagnostics, role assignments of other
   people or a copied Python tool registry. Reuse finer-grained authoritative
   guards/registries rather than assuming route admission authorizes every
   capability ID. Enforce current principal authority, no-store and
   tenant/account isolation.
   The existing Viewer hierarchy authorizes phase 02's staff preview entry
   points; EndUser does not. Preserve the real actor's principal/roles/token and
   attribution when a preview subject is supplied. Never implement preview by
   changing request/session identity or granting the target's roles.
   Include the API-owned effective privacy booleans in this bounded contract;
   clients and preview targets cannot override them.
5. Audit every currently authenticated route that could become reachable with
   roleless admission, not just the new endpoint. Add explicit correct policy
   for any sensitive route currently relying on blanket token rejection.
   Preserve public auth/health behavior and legitimate account-only endpoints.
   Existing adoption, raw inventory/reports, capability/probe, operational
   metadata, controls, jobs and manual collection APIs stay unavailable to
   roleless callers. Do not broadly relax `requireSession`, roles or capabilities.
6. Wire README contract B in the existing automatic collection/sign-in owner.
   A first roleless employee browser/MCP sign-in schedules due permitted
   application-only reads with real actor attribution and existing idempotent
   jobs, without lending Viewer authority or enabling manual sync endpoints.
   Keep existing Viewer automatic application/delegated collection intact.
   No extra scheduler or MCP-side provider writer; no source dispatch from
   normal tool/catalog reads. Implement the API authenticated-entry/due-admission
   contract and browser hook: the existing browser polling hook alone cannot
   bootstrap an MCP-only caller. Phase 03 owns calling this API entry during
   native initialize/list, not another scheduler. Verify first bearer entry,
   reconnect, token refresh, concurrent identities and worker restart against
   this API contract. Collection runs asynchronously; provider collection failure
   must not become a new sign-in/catalog gate. Record delegated-only gaps honestly.
7. Make a roleless browser sign-in a clear discovery-only handoff with sign-out
   and account information, not an error telling the user to obtain an EndUser
   role. Hide adoption/admin pages, provider checks and their background fetches.
   Do not build a browser catalog. Remove/replace the superseded
   `roleAssignmentRequired` contract where it wrongly describes valid default
   users; update its producers, consumers, types, fixtures and explanations
   together, without an alias retained for old clients.
8. Update setup/deployment guidance for assignment-required No on the existing
   enterprise applications where necessary for the documented OAuth flow.
   Retain explicit privileged assignments, admin consent and tenant-only scopes.
   Identify the exact control-plane changes for phase 04; do not grant the MCP
   application Entra write permission or re-create registrations.
9. Wire `hide_employee_details` and `hide_champion_employee` as independent
   deployment MCP settings, both default `false`, through the current settings
   wizard/input validation, persisted project configuration, generated app
   environment, container and supported Azure producers. Keep one API runtime
   policy owner; MCP consumes the effective profile, not a second local policy.
   Preserve explicit booleans across edit/redeploy/restart, reject malformed
   values and document the exact deployment keys/environment mapping.
   These settings change identity disclosure only, never automatic source
   collection, role grants, feature availability, OAuth keys or saved source data.

Do not design an alternate schema or an employee-profile store here. Phase 02
owns the approved current-schema replacement/reset and must retain these identity,
source-admission and configuration contracts. In particular, membership lookup
does not promise a saved workplace row for every unlicensed caller.

## Focused verification

Add focused authority/profile/route tests in the existing backend test layout.
Use a single combined selection, including new `mcpAccess`/employee-profile
tests and the existing affected owners:

```sh
npm run test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/requestPrincipal.test.ts src/auth/msal.test.ts src/middleware/auth.test.ts src/routes/policy.test.ts src/services/mcpAccess.unit.test.ts src/services/employeeProfile.unit.test.ts
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
npm run test --workspace frontend -- src/authorization.test.ts src/components/PermissionCenter.test.tsx
cd mcp
.venv/bin/python -m pytest tests/test_oauth.py tests/test_api_origin.py tests/test_onboarding.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

New test selectors are implementation outputs; integrate their final names with
the existing runner rather than silently omitting cases. Run database-dependent
auth/route/first-run checks through the existing isolated fixture, not production
credentials; record the exact command in the completion record.

Required cases: valid absent/empty roles; existing single/multiple role
inheritance; unlicensed employee; missing member snapshot; guest/disabled
account; wrong tenant/oid; malformed/unknown roles; directory timeout;
reauthorization/demotion/revocation; concurrent identities; and all sensitive
routes denied to roleless users. Verify that staff-preview authority is based on
the actor's current Viewer hierarchy, not a client-selected subject/role, and
that stored workplace fields are not overwritten by identity-provider claims.
Add API configuration and existing PowerShell deployment-owner tests for absent
settings/default false, explicit false/true, all four combinations, malformed
values, persisted round trips and emitted runtime values. Validate affected
Azure templates with existing tooling; record unavailable tooling honestly.
No new secret, per-user preference or independent MCP policy value is needed.

Prove fresh isolated deployment/reset followed by employee-first sign-in starts
application reads with no Permissions visit, Check status, privileged sign-in
or Sync click. Assert automatic dispatch identity/source set and zero manual
collection/control authority. Repeat existing Viewer/Admin first-run journeys.
An unavailable Power Platform source is not a failure of application Graph
bootstrap and is not a fictitious success.
Exercise the first authenticated API entry that phase 03's MCP initialize/list
will call, without requiring the future projected tool surface in this phase.
Include duplicate/retried sign-ins, expired membership evidence and a catalog-only
unlicensed caller whose saved workplace stays absent after sync. Pin source
dispatch count/identity to due admission, not access-profile/catalog request count.

## Production continuation

Obey the README always-deploy contract. This phase owns code, tests and precise
configuration instructions; phase 04 applies the coordinated production change.
Keep existing staff flows usable. Failed member verification must fail closed
for the default audience without fabricating roles or disabling staff access.
Record every residual with the README-required containment and live trigger.

## Completion record and done conditions

Write `completions/01-roleless-discovery-authority.md` with the README completion
content, baseline and exact access-profile/preview-authority contract,
privacy defaults/persistence/environment mapping, roleless/guest outcomes,
first-run source dispatch evidence, browser/API contract deletions, configuration
changes, exact authenticated-entry hooks/deduplication and affected/unchanged roots.

Done when verified roleless members have a bounded discovery authority contract,
sensitive existing routes remain protected, normal first-run app reads are
automatic at API/browser entry, browser handoff is truthful and existing staff
behavior is preserved. Phase 03 must wire the native MCP entry to this contract.
Phase 02 can consume a current verified identity, canonical saved-account
mapping and access policy without a new role, manual source initialization or
guessed user. Preview must preserve that real identity while resolving a
separate authorized subject.
