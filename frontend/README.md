# Agent Control frontend

The React frontend is built into the Agent Control Express application. The
browser calls the Express API; it does not call Microsoft Graph or Power
Platform directly.

## Run locally

Use the repository-root workflow:

```powershell
pwsh ./deploy-local.ps1 start
```

The first start collects the Entra and port settings. Open the configured local
URL, which defaults to:

```text
http://localhost:3001
```

See the root [README](../README.md) and
[deployment setup](../docs/deployment-setup.md).

## Validate changes

Run the complete containerized software checks from the repository root:

```powershell
pwsh ./deploy-local.ps1 check
```

The check includes frontend lint, type checking, tests, and production builds.
No host Node.js installation is required.

When validating source locally, `npm run check:unused` at the repository root
runs the configured Knip dead-code/dependency check. It complements tests and
does not establish live browser or provider behavior.

## Main user flows

- **Agents**: browse inventory, inspect details and usage, manage package access,
  and review activity.
- **Users**: review licenses, activity, and agent relationships.
- **Sync**: refresh provider data and import Microsoft 365 usage reports.

- **Audit**: review administrative actions made through Agent Control.
- **Permissions**: check app roles, Microsoft roles, API permissions, consent,
  licensing, and provider access.

Initial read-only sync starts automatically after sign-in while visible and
online. Permissions is recovery guidance after an actual failure, not a setup
approval step. Purview/Defender searches run explicitly under current real
authorization; configured application reads need no prior qualification query.

Sync history keeps its Outcome filter beside Refresh history. During automatic
or manual history reads, the refresh icon animates without adding a visible
loading message or shifting the table. Loading status remains available to
screen readers; reduced-motion preferences disable the animation.

Users opens the unchanged **Users** view by default. **Adoption** shows
always-visible Company / Department sections with independent people and agent
lists; search matches company and department keywords. Group pages show five
groups at a time, without collapsed sections.
Compact previous/next arrows and a current/total page indicator sit at the right
of the existing Adoption results heading, so paging does not require scrolling
past the groups. They share the full bottom pager's selection and loading state;
the bottom page buttons, range summary, and direct page jump remain unchanged.
On narrow screens the subtitle spans below the title and compact controls.

Users and Adoption share the Agents header layout, with the view selectors next
to the title and summary cards starting at the same height. Adoption uses the
same search bar and Filters popover. Company and Department options are read
from all matching saved groups, not just the visible page; missing values can
also be selected. Copilot Champs and Group agents filters each offer all groups,
groups with evidence, or groups without evidence. Filters combine before group
paging and survive reloads in the URL. Summary counts reflect all matching
groups, and the agent count deduplicates agents shared across groups.
Company and Department option searches stay visible while filters change;
dropdowns keep their normal height instead of stretching to match adjacent fields.

In user details, Company links to Adoption filtered by that company, and
Department links to Adoption filtered by both the user's company and department.
The links keep the user's selected report set, clear unrelated filters, and close
the details overlays on normal navigation. They also support opening in a new tab.
Missing values stay as plain "Not reported" text; a department without a reported
company links to that department under the explicit missing-company filter.

Independently opened directory and reported-user details automatically renew
their saved selection while visible and online, retaining any selected report
set. Rejected evidence offers a local restart when no parent selection owns the
read. A direct directory user missing during initial collection is read again
when Users publishes new data, without closing the modal or manually starting sync.

The compact `agents/responses` counts mean distinct report agents with positive
responses, and total reported agent responses in the selected report (not
lifetime usage). Up to three colleagues with reported usage are marked **Copilot
Champ**, ordered by reported responses, agents used, name and exact identity.
Creation does not qualify or boost a person. This is a suggestion, not a
competition or an assigned role. Missing relationship reports show unknown agent
counts; an empty report shows zero. Group usage filters do not classify unknown
usage as measured zero.

Group agents are deduplicated by exact report agent ID across positively used
relationships, including organization-built, Microsoft and third-party agents.
Created-but-unused agents remain in inventory, not Adoption. Agent entries
show name, the saved About text (long description preferred, short description
only as a fallback), and reported creator category. Inventory is optional
enrichment, not a requirement for an agent to appear. A verified, unambiguous
inventory match provides the existing detail link; report-only agents remain
visible with an explicit inventory-details-unavailable note.
About previews strip HTML using the agent modal's sanitizer and show at most
300 plain-text characters, including a trailing ellipsis when truncated.
Previews end at a word boundary where possible. Clicking the agent name opens
the existing details modal with the full About text; no expansion control is added.
Membership uses the saved directory, not a complete workforce census or
historical department membership. Optional agent metadata uses pinned authorized
saved inventory;
appearing in a group does not imply access for every group member. No groups,
champion assignments, or additional synchronization state are persisted.

Opening an agent from a user's **Responsibility** or **Usage & agents** tab keeps the Users URL and
opens agent details above the user details. Closing the agent returns to the
same user, selected tab, and agent link without resetting the user's context.
Usage links use the report's exact package ID, never a display-name match. If
that package is absent from saved inventory, the details overlay shows an error
without closing the user. The report activity view retains a separate
**Active users without paid Copilot** action for filtering the user cohort.

Provider changes require an Agent Control Admin, current provider authorization,
explicit confirmation, and post-change verification.

On Agents and both Users cohorts, **Clear search** appears inside the search field whenever it contains
text, even when the field is not focused or results are updating. It clears only
the search and returns keyboard focus to the input; other filters remain applied.
Filter-chip remove buttons clear individual filters, while **Clear filters**
resets both search and filters.

Package changes use a compact **Access and availability** panel that stays visible
while the inventory updates. During processing, the current agent appears beside
the progress count (long names are truncated visually, with the full name on hover).
Completed jobs show only their status and outcome counts, without result lists or
pagination. Use **Close job summary** in the top-right corner to dismiss finished
feedback; selected agents remain selected. Jobs still running or requiring sign-in,
resume, or reconciliation keep their recovery controls until resolved.
When selected agents and a retained job result are shown together, selection
actions use a separate bounded row rather than the narrow heading column. Agent
and published-version selection counts remain separated and wrap on small screens.

When an uploaded report becomes active or the shared report selection changes,
automatic refresh checks report users' licenses through the existing Users sync,
even if the previous sync was recent. It joins an active sync and checks again
afterward if that sync started before the report changed. Fresh app-activity data
is reused, and the unpinned Users view updates when the new directory is published.
Users whose licensing remains unknown are excluded from **Active users without
paid Copilot**, without a repeated "Run Users sync" prompt. Actual collection or
authorization failures remain visible in Sync. Pausing automatic refresh also
pauses this background work.
When saved user evidence is incomplete and Users sync is queued or running,
Users shows a neutral in-progress notice and **Updating...** for pending summary
counts, rather than asking for manual sync. Known counts and rows remain visible.
The first automatic check is described as a check, not as confirmed sync work.
Failed, cancelled, and permission-blocked reads retain their recovery guidance;
unrelated inventory refreshes do not hide user-data problems.
Incomplete automatic Users syncs explicitly show that the latest attempt failed
and that saved data remains available. Automatic checks settle finished runs even
when the saved aggregate state is stale; collection failures retry after the
existing 15-minute cooldown (authorization failures retain their one-hour
cooldown or require a fresh sign-in).

Tables, report dropdowns and open details adopt new saved-data publications.
Short-lived selections renew automatically while the page is visible and online.
Existing labels, rows and valid details stay visible during renewal, without
routine reload/restart warnings. Open details keep the selected identity, tab and
search draft, then adopt the replacement evidence. Renewal reads saved data only;
it does not start provider collection. Paged views restart at the first page with
the same filters rather than mix cursor generations. Historical reports keep the
selected report set, including user details opened from Adoption or a direct user
link. Changing that report set retires the previous detail evidence.
Retained Users rows and coverage remain visible during a replacement read, but
new detail and unresolved-identity reads wait for the current selection; already
open details retain their identity and tab while refreshing.
Agent Users retains its search draft and locally selected
historical period across inventory renewal; account, role or agent changes clear
that navigation and any open user investigation. An expired selected-group count
also renews saved inventory without removing the displayed rows or starting provider collection; the old
group selection is retired before further actions. Inventory refresh retires unsent mutation previews, but
does not cancel independent Microsoft access verification or replay submitted
actions. Linked user profile and license evidence follows the current directory
identity; removing or changing that link retires the old profile.
Microsoft-confirmed changes appear locally
immediately; subsequent saved-data publications replace them. Actual read and
authorization failures remain visible.
In agent details, a cancelled saved-detail read resumes automatically once the
inventory is ready; a failed read still requires an explicit retry. Automatic
saved-detail reads and both saved inventory reload controls pause during package
management, bulk preview preparation and confirmation.
Table CSV exports run on the backend using the selection captured at the click,
without holding the table against new publications or idle renewal. Export
progress and downloads survive table refreshes; later exports use the current
selection. Manually changing filters still clears the previous export controls.
Access denial or actual selection rejection still withdraws the
affected evidence.
If a failed page's selection expires, its error remains visible and recovery
restarts the selection (or its parent) instead of retrying expired evidence.
Expiry notices describe previously loaded data only when that data is displayed.

## Frontend structure

- `src/components/`: reusable UI and feature components
- `src/pages/`: page-level views
- `src/api/`: Express API clients
- `src/types/`: shared frontend types
- `src/test/`: test setup and helpers
- `browser/`: browser and layout tests
