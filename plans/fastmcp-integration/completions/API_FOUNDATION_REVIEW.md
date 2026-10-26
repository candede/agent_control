# Shared API foundation review

Date: 2026-10-17. Source: `d3a82a8d7673cb55300b6ab30fc3848d40554015`.
The initial worktree was clean. This is a quick prerequisite review, not a
historical completion certificate or live release receipt.

## Conclusion

The existing API/web integration foundation is implemented sufficiently to start
[05](../05-fastmcp-service-and-auth.md). Both transports use canonical registered
routes, common principal/credential authority, role and private-scope checks,
existing provider writers, and bounded audit-origin metadata. The browser does
not depend on MCP. No missing source prerequisite was identified in this scoped
review. Database-backed behavior and live Entra/provider journeys were not
requalified, so this conclusion does not certify them or complete 04C.

## Evidence

- `requestAuthentication.ts` verifies bearer credentials before shared policy,
  rejects mixed credentials, and binds the same authority context as browser
  authentication. `policy.ts` retains browser-only boundaries, roles and CSRF.
- `sharedAgentControls.ts` calls the existing `AgentControls` owner for both
  admitted transports; no MCP-only provider writer or route was introduced.
- Current canonical-map fixtures check registered method/path/policy parity
  and browser adapters. Existing saved-read fixtures exercise full About,
  private relationships, champions and comparison contracts on both transports.
- `actionOrigin.ts` derives channel/integration identity from verified authority,
  accepts only bounded reported labels, and never treats labels as permission.

## Actual local checks

The editor test tool reported no discovered tests; validation used the existing
Vitest runner instead.

```sh
npm test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/delegatedCredentials.test.ts src/auth/requestPrincipal.test.ts src/routes/mcpApiAuth.test.ts src/routes/mcpContractFeasibility.test.ts src/routes/policy.test.ts src/routes/actionOrigin.test.ts src/services/auditOrigin.test.ts
```

Result: seven suites passed, **176 tests passed**. The eighth suite
(`services/auditOrigin.test.ts`, six cases skipped by failed setup) was unavailable
because its guard requires a separately named `agentcontrol_test_*` database.
Overall runner exit was 1, not a full passing aggregate.

```sh
npm test --workspace backend -- src/routes/mcpReadContracts.test.ts src/routes/sharedAgentControls.test.ts src/routes/auditOriginHttp.test.ts
```

Result: unavailable. All three suites stopped at the same isolated-database
safeguard before useful SQL behavior evidence (runner: 28 failed cases, not
behavioral passes). No test database was provisioned,
production database accessed, Docker invoked, or credentials/configuration read.

The database-independent seven-suite selector was also run without the SQL
suite: **7 suites / 176 tests passed**, exit 0. `npm run typecheck --workspace
backend`, `npm run check:unused`, and `git diff --check` passed.

## Boundaries and next action

Only one repository/application boundary was declared:
`candede/agent_control` at the current workspace root. Backend and browser
contracts were checked; this review required no application-source edits.

Implement phase 05 locally with synthetic auth/API/storage fixtures. Preserve the
current canonical methods/routes and API ownership. The independent 04C live
release remains unverified/deployment pending; it is not a runtime or MCP coding
approval gate. Live native/guest consent, real SQL parity and production release
remain separate evidence obligations for an authorized operator.
