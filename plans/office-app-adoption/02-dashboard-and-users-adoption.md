# 02 - Dashboard and Users adoption

## Mission

Deliver visually related agent and Office dashboards, plus grouped Office adoption within Users, using phase 01's real evidence. The user must be able to move from an Office department/app insight to the corresponding people and champions without losing the observation context.

## Prerequisites and read first

Read and obey [the roadmap README](README.md), especially metric, navigation, visual, and always-deploy local-runtime contracts, and the implementation worker contract. Read the completed phase record at `completions/01-office-evidence-and-adoption-api.md`; resolve actual backend payloads from its types, not guessed examples.

Read:

- [App](../../frontend/src/App.tsx), [routing](../../frontend/src/workbenchRouting.ts), and their relevant route/default/account/publication tests.
- [AdoptionDashboard](../../frontend/src/components/AdoptionDashboard.tsx), [DashboardInsights](../../frontend/src/components/DashboardInsights.tsx), [dashboard CSS](../../frontend/src/components/adoptionDashboard.css), [adoption trends](../../frontend/src/adoptionTrends.ts), and [history hook](../../frontend/src/useAdoptionHistory.ts).
- [CopilotUsersView](../../frontend/src/components/CopilotUsersView.tsx), [AdoptionView](../../frontend/src/components/AdoptionView.tsx), [group CSS](../../frontend/src/components/adoption.css), and [UserDetailModal](../../frontend/src/components/UserDetailModal.tsx).
- [Report paging](../../frontend/src/useReportPage.ts), [selected-read behavior](../../frontend/src/selectedRead.ts), [paging/status controls](../../frontend/src/components/ReportPageControls.tsx), [facets](../../frontend/src/components/ReportFacet.tsx), and their API/publication helpers.
- [Automatic refresh](../../frontend/src/useAutomaticRefresh.ts), [publication types](../../backend/src/types/dataSelection.ts), and the README's verified disposable fixture/baseline procedure.
- [Global styles](../../frontend/src/App.css), [dashboard browser tests](../../frontend/browser/adoptionDashboard.spec.ts), [group browser tests](../../frontend/browser/adoption.spec.ts), and [usage documentation](../../docs/copilot-license-usage.md).

## Scope and non-goals

Own frontend integration, shared concrete presentation, Office read hooks, URL/context behavior, grouped people/apps, detail links, component/browser tests, and UI documentation. Do not redefine backend metrics, add overall M365 prompt collection, redesign unrelated Users cohorts, or deploy/reset `seha` here.

## Concrete work

1. Add the Dashboard domain controls using the same visual interaction pattern as existing page view controls. Agent adoption remains default; Office selection is explicit and bookmarkable.
2. Reuse existing panel headings/styles and extract concrete duplicated card/chart/layout presentation only where both views need it. Do not require a new component layer for every header, context, or table. Keep source-specific hooks and metrics properly typed, and delete replaced duplicates in the owning edit; no copied agent dashboard or generic plugin framework.
3. Render Office **Active users** and **Active user-app pairs** trends over real retained observations, with latest/baseline/previous comparisons and the existing colors/layout. Do not create daily events, interpolate missing observations, compare to an agent baseline, or sum overlapping windows.
4. Match the existing department panel: company selection, participation ordering, bounded paging, exact counts, loading continuity, and group drill-down. Label its denominator as saved licensed people and disclose unknown coverage.
5. Match the **People and engagement** panel with Office-scoped paid participation, no-recent-evidence, and unknown-evidence measures. Explain their overlap and incomplete-evidence lower bound; do not sum them as disjoint populations, reuse the agent unpaid-activity card, or label blanks as unused licenses.
6. Match the **Apps and potential champions** panel with apps used, user-app pairs, suggested-champion count, and a compact seven-app active-user breakdown. App links open Office Users adoption with the app/context preserved.
7. Render one/zero observation states truthfully. Hide unsupported comparisons, not the whole functioning dashboard. Expired/current stale evidence retains its original context and explicit status; history is historical evidence, not today's license state.
8. Keep Users / Adoption controls. Add the approved **Agents / Office apps** dropdown within Adoption, defaulting to Agents. In Office mode retain summary/search/organization filters/chips/group cards, but replace agents with app participation and people metrics with apps used/latest qualifying Office date.
9. Show potential champions from backend ranking with honest labels/tooltips. Page large groups' people using phase 01's complete counts and bounded APIs. Keep group-level counts/champions/app totals stable across people pages.
10. Add Office snapshot context and optional app filtering. Domain changes reset incompatible filters/paging intentionally; browser Back/Forward, bookmarks, refresh, renewals, and dashboard-to-Users navigation preserve valid domain/source context. Do not overwrite the agent report pin or baseline.
11. Implement the README's `adoption`, `officeSnapshot`, and `officeBaseline` URL contract in route parsing/serialization, remembered page navigation, direct links, and sign-out/account cleanup. Invalid/removed pins get explicit recovery notices; no preference table or compatibility aliases.
12. Use the shared app mapping/classifier in relevant details. When opening a person from a historical Office observation, keep frozen Office facts visible and distinguish any newer current profile/licenses/agent information. Never recalculate the historical group/champion result from today's user details or require agent evidence to open the Office person view.
13. Wire phase 01's existing `users` publication signal and selected-read renewal into every new hook/read, including recovery-only Office publication. Do not add another polling owner or automatic provider source. Handle preparation, permission/source failures, partial coverage, retention/correction/clear, cancellation, sign-out, account switch, and stale results using repository-standard status/errors. Latest updates automatically; a valid historical pin stays fixed until its own evidence is corrected/removed.
14. Update UI sections of [licenses and usage](../../docs/copilot-license-usage.md) and directly related navigation/source documentation. Existing agent defaults, report selection, groups, champion ranking, and MCP behavior remain unchanged.

Use existing icons, dates/count helpers, React query/selection ownership, and CSS. At widths at or below 760px global buttons become full-width; explicitly accommodate that in new flex/tab/action rows. Do not add chart/design dependencies or a second dashboard stylesheet with duplicated layout rules.

## Focused verification

Use the existing frontend Vitest and Playwright runners. Combine directly affected selectors in one invocation and include the actual new tests. Commands are from repository root unless stated otherwise:

```bash
npm test --workspace frontend -- src/components/AdoptionDashboard.test.tsx src/components/DashboardInsights.test.tsx src/components/AdoptionView.test.tsx src/components/CopilotUsersView.test.tsx src/adoptionTrends.test.ts src/useAutomaticRefresh.test.tsx
npm run typecheck --workspace frontend
npm run lint --workspace frontend
npm run build --workspace frontend
git diff --check
```

Run the existing disposable browser owner using the README's verified baseline variables; it builds/serves the current artifact and owns origin, synthetic data, browser setup, and cleanup:

```powershell
pwsh ./scripts/large-tenant-tests.ps1 -Suite browser -BrowserFiles 'adoptionDashboard.spec.ts,adoption.spec.ts' -BaselineImage $baselineImage -BaselineImageId $baselineImageId
```

Add Office cases to those files. The owner runs focused and aggregate browser passes with both configured desktop/mobile projects; record each result and actual artifact identity, not screenshots alone. This is mock-browser/fixture proof, not permission to seed `seha` or a substitute for phase 03's real provider journey. Phase 03 reuses this evidence when its identity remains valid.

Required behavior:

- Current agent dashboard and Users/Adoption default remain unchanged in counts, context, links, and ranking.
- Office mode works when agent reports and inventory are absent, but directory/app evidence is available.
- Multi-app people, paid/unverified users, partial coverage, old/no-date data, one/zero observations, and no-app-use groups render accurately.
- Same selected Office observation produces matching dashboard department totals, Users group counts, app counts, and champions across navigation/paging; app-filtered people/rankings remain distinct from full-group licensed/app totals.
- Route parse/serialize, separate agent/Office pins and baselines, company/department/app links, Back/Forward, account isolation, deleted pins, and correction/retention recovery.
- Automatic source and recovery-only Office publications update Latest; unchanged historical pins and expired-selection renewal retain visible content without invalid actions, mixed observations, focus movement, or manual restart.
- Keyboard operation, pressed/selected states, screen-reader labels, focus restoration, loading/errors, long organization names, large groups, and 360px/760px/1440px layouts without horizontal overflow.
- Both domains visibly share the same panel/card/grid language; verify desktop/mobile captures against the current design, not merely element existence.

## Production continuation

Obey the README's always-deploy local-runtime policy. Phase 03 owns deployment and live first-run proof. Do not add runtime gates to hide an unimplemented or uncertain Office view. Record non-passing checks with honest status and the required residual handling; fix defects in the owning frontend/backend contract rather than mask errors with zeros.

## Completion record and done conditions

Write exactly `completions/02-dashboard-and-users-adoption.md`. Include actual shared/replaced components, domain/URL/context contracts, historical-detail behavior, publication/selection integration, backend/MCP/deployment impact, exact commands/results, visual evidence locations, accessibility/responsive findings, and residuals.

Done means both user journeys are implemented end to end and owned focused checks are attempted/repaired, not just that two buttons or a mock Office panel exist. Phase 03 receives working typed consumers and a truthful evidence inventory; no required historical, group, navigation, or unknown-state behavior remains deferred.
