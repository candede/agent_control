# Phase 03 - Permission Center and Feature Gating UX

## Mission

Build a first-class Permission Center and apply capability-aware disabled states throughout the existing UI so an administrator can see exactly which app permission, token mode, Microsoft role, internal app role, license, configuration, or rollout condition controls every feature.

## Prerequisites

- Follow the roadmap's manual fresh-session contract; read Phase 02's completion record and its shared capability/security types. Consume Phase 01's container/test-origin/database commands and consult its affected persistence/job contracts.
- `GET /api/capabilities`, grouped requirements, remediation, and server-side route enforcement must be available.
- Do not deploy to Azure in this phase; local Docker deployment/validation is required.

## Read first

- `frontend/src/App.tsx`
- `frontend/src/App.css`
- `frontend/src/index.css`
- `frontend/src/api/client.ts`
- `frontend/src/components/AgentTable.tsx`
- `frontend/src/components/BulkActions.tsx`
- `frontend/src/components/AccessAssignmentModal.tsx`
- Existing frontend tests and capability API types

## Required implementation

1. Add a **Permissions** view for package/directory Graph access, Power Platform inventory/quarantine, Purview search, Defender hunting, official report import and internal app roles. Deferred features are absent, not disabled teasers.
2. Each capability row must show:
   - current state and last probe time;
   - exact delegated/application permission and resource audience;
   - required Microsoft Entra, Purview, Defender or Power Platform roles;
   - required internal Agent Control app role;
   - licensing, cloud, preview, environment, and configuration prerequisites;
   - the exact feature set unlocked;
   - provider-safe evidence and remediation actions;
   - links to current Microsoft documentation.
3. Add consent, explicit retry-probe, admin-portal and setup-instruction actions. Never imply the app can self-assign roles, consent, licenses or provider access. No automatic recurring provider probes or refresh-on-navigation loops.
4. Apply one shared `CapabilityGate` pattern to navigation, toolbar actions, row actions, bulk actions, dialogs, and provider views. Server authorization remains mandatory; frontend gates are explanatory UX only.
5. Keep unavailable features visible and disabled when that visibility teaches the POC capability. The disabled control or adjacent status must say, for example: `Requires delegated CopilotStudio.AdminActions.Invoke and AI Administrator, Global Administrator, or Power Platform Administrator.` It must also distinguish missing app grant from missing user role when evidence supports that distinction.
6. For capabilities not yet implemented by later phases, do not advertise them as working. Render only capabilities registered by active backend adapters. The Permission Center grows as phases add adapters.
   Keep backend status values and local-role versus provider-action decisions distinct. Never disable the Permission Center, consent initiation, or current-principal probe refresh because the provider capability is unavailable. Authorized cached-data views stay readable with freshness labels; provider actions still fail closed.
7. Add a compact global capability-health indicator that reports available/degraded/blocked counts and opens the Permission Center. Avoid noisy banners on every page.
8. Make preview badges and metadata consistent. Tooltips must explain that preview APIs can change and disclose absent conditional-write protection where applicable. Implemented Admin-confirmed package access/block and quarantine controls run on demand, not behind a preview configuration switch or prior-canary requirement. Optional qualification is not provider authorization or proof of an ordinary write's success.
9. Handle loading, stale evidence, probe failure, consent cancellation, conditional access, unsupported cloud, and partial role visibility without layout shifts or generic `Forbidden` messages.
10. Meet keyboard, focus, screen-reader, mobile, overflow, and color-contrast requirements. Permission text must remain readable at narrow widths. Use existing Lucide icons and design language.
11. Establish missing frontend test infrastructure now: React Testing Library with a DOM environment for component tests, Playwright for browser workflows, and axe integration for accessibility. Install browsers/dependencies in a disposable Docker test target extending Phase 01's build/test contract, never on the host or in the production runtime. Publish exact container commands, network/base URL, isolated PostgreSQL setup and cleanup. Use a separate fixture-configured test app/database, not the running demo or Azure data; production artifacts reject fixture auth modes. Add checked-in scripts/configuration and deterministic HTTP fixtures without calling live providers. Reuse these suites in later UI phases; test through the existing API client rather than duplicating server policy. Temporary browser/test app containers exit after tests, leaving only the two normal services.

## UX state contract

- `available`: enabled, with optional preview warning.
- `missing_permission`: disabled; name exact app permission and token mode, and offer consent/admin instructions as appropriate.
- `missing_internal_role`: disabled; name exact Agent Control app role.
- `missing_role`: disabled; name provider roles only when probe evidence is conclusive.
- `missing_license`, `not_configured`, `unsupported`, `preview_disabled`: disabled with exact next action.
- `provider_error`, `unknown`, or stale evidence: disable provider mutations; authorized saved data stays readable with freshness and an explicit refresh action.

## Focused validation

- Component tests for every capability state and exact permission/role language.
- Interaction tests for consent, probe refresh, disabled action explanation, portal/document links, and stale cached results.
- Regression tests proving a hidden or disabled button cannot bypass server capability/app-role enforcement.
- Automated accessibility checks plus keyboard navigation and focus-return tests for Permission Center panels/dialogs.
- Responsive tests at representative mobile and desktop widths with longest permission names.

## Aggregate validation

Run the global validation baseline and new component/browser/axe commands inside Docker. Exercise every Permission Center state against the isolated fixture app; verify normal local startup still uses `deploy-local.ps1` with two services and no host Vite/Node process.

## Production continuation

Visual or browser-test residuals do not stop the campaign. Contain only affected controls, preserve server enforcement, record viewport/accessibility evidence, and carry a fix-forward owner and trigger. Never enable a control whose capability state is unknown.

## Scope guard

Do not implement provider adapters or data views from later phases. Do not duplicate permission requirements in component constants; consume the backend contract. Do not deploy to Azure.

## Completion record

Create `plans/admin-poc-production/completions/03-permission-center-ui.md` with required evidence, screenshots only from synthetic data, accessibility results, and Phase 04 preconditions.

## Done conditions

- Every current privileged feature has an explanatory capability gate.
- Administrators can distinguish app permissions, Microsoft roles, internal roles, licenses, and configuration.
- All capability states are accessible, responsive, tested, and backed by server enforcement.
- Later integrations can register and render a capability without inventing new UX rules.
