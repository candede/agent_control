# Phase 03 - Permission Center and Feature Gating UX

## Mission

Build a first-class Permission Center and apply capability-aware disabled states throughout the existing UI so an administrator can see exactly which app permission, token mode, Microsoft role, internal app role, license, configuration, or rollout condition controls every feature.

## Prerequisites

- Read the roadmap and completion records for Phases 01-02.
- `GET /api/capabilities`, grouped requirements, remediation, and server-side route enforcement must be available.
- Do not deploy in this phase.

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

1. Add a top-level **Permissions** view that groups capabilities by Microsoft Graph, Power Platform, Purview, Office 365 Management Activity, Defender/Agent 365, Dataverse, official report import, and Agent Control internal roles.
2. Each capability row must show:
   - current state and last probe time;
   - exact delegated/application permission and resource audience;
   - required Microsoft Entra, Purview, Defender, Power Platform, or Dataverse roles;
   - required internal Agent Control app role;
   - licensing, cloud, preview, environment, and configuration prerequisites;
   - the exact feature set unlocked;
   - provider-safe evidence and remediation actions;
   - links to current Microsoft documentation.
3. Add actions for incremental consent, retry probe, open relevant admin portal, and copy setup instructions. Do not imply the app can self-assign admin roles, admin consent, licenses, Power Platform access, or Dataverse roles.
4. Apply one shared `CapabilityGate` pattern to navigation, toolbar actions, row actions, bulk actions, dialogs, and provider views. Server authorization remains mandatory; frontend gates are explanatory UX only.
5. Keep unavailable features visible and disabled when that visibility teaches the POC capability. The disabled control or adjacent status must say, for example: `Requires delegated CopilotStudio.AdminActions.Invoke and AI Administrator, Global Administrator, or Power Platform Administrator.` It must also distinguish missing app grant from missing user role when evidence supports that distinction.
6. For capabilities not yet implemented by later phases, do not advertise them as working. Render only capabilities registered by active backend adapters. The Permission Center grows as phases add adapters.
7. Add a compact global capability-health indicator that reports available/degraded/blocked counts and opens the Permission Center. Avoid noisy banners on every page.
8. Make preview badges and metadata consistent. Tooltips must state that preview APIs can change and may be disabled by configuration; do not hide that status in documentation only.
9. Handle loading, stale evidence, probe failure, consent cancellation, conditional access, unsupported cloud, and partial role visibility without layout shifts or generic `Forbidden` messages.
10. Meet keyboard, focus, screen-reader, mobile, overflow, and color-contrast requirements. Permission text must remain readable at narrow widths. Use existing Lucide icons and design language.

## UX state contract

- `available`: enabled, with optional preview warning.
- `missing_permission`: disabled; name exact app permission and token mode, and offer consent/admin instructions as appropriate.
- `missing_internal_role`: disabled; name exact Agent Control app role.
- `missing_role`: disabled; name provider roles only when probe evidence is conclusive.
- `missing_license`, `not_configured`, `unsupported`, `preview_disabled`: disabled with exact next action.
- `provider_error`, `unknown`, or stale evidence: disabled for mutations and sensitive content; read-only cached data may remain visible with freshness and uncertainty.

## Focused validation

- Component tests for every capability state and exact permission/role language.
- Interaction tests for consent, probe refresh, disabled action explanation, portal/document links, and stale cached results.
- Regression tests proving a hidden or disabled button cannot bypass server capability/app-role enforcement.
- Automated accessibility checks plus keyboard navigation and focus-return tests for Permission Center panels/dialogs.
- Responsive tests at representative mobile and desktop widths with longest permission names.

## Aggregate validation

Run the global validation baseline. Start the local app and exercise the Permission Center against fixture capability responses for every status.

## Production continuation

Visual or browser-test residuals do not stop the campaign. Contain only affected controls, preserve server enforcement, record viewport/accessibility evidence, and carry a fix-forward owner and trigger. Never enable a control whose capability state is unknown.

## Scope guard

Do not implement provider adapters or data views from later phases. Do not duplicate permission requirements in component constants; consume the backend contract. Do not deploy.

## Completion record

Create `plans/admin-poc-production/completions/03-permission-center-ui.md` with required evidence, screenshots only from synthetic data, accessibility results, and Phase 04 preconditions.

## Done conditions

- Every current privileged feature has an explanatory capability gate.
- Administrators can distinguish app permissions, Microsoft roles, internal roles, licenses, and configuration.
- All capability states are accessible, responsive, tested, and backed by server enforcement.
- Later integrations can register and render a capability without inventing new UX rules.
