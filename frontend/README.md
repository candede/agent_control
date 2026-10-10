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

## Main user flows

- **Agents**: browse inventory, inspect details and usage, manage package access,
  and review activity.
- **Users**: review licenses, activity, and agent relationships.
- **Sync**: refresh provider data and import Microsoft 365 usage reports.

- **Audit**: review administrative actions made through Agent Control.
- **Permissions**: check app roles, Microsoft roles, API permissions, consent,
  licensing, and provider access.

Sync history keeps its Outcome filter beside Refresh history. During automatic
or manual history reads, the refresh icon animates without adding a visible
loading message or shifting the table. Loading status remains available to
screen readers; reduced-motion preferences disable the animation.

Users opens the unchanged **Users** view by default. **Adoption** shows
always-visible Company / Department sections with independent people and agent
lists; search matches company and department keywords. Group pages show five
groups at a time, without collapsed sections.

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

The compact `agents/responses` counts mean distinct organization-built agents
created or used, and reported agent responses in the selected report (not
lifetime usage). Up to three colleagues with creation or usage evidence are marked **Copilot Champ**,
ordered by verified agents created, then reported responses. This is a suggestion,
not a competition or an assigned role. Missing usage is shown as unavailable.

Group agents are the deduplicated union of verified creations and reported use by
group members, excluding identified first- and third-party agents. Agent entries
show name, the saved About text (long description preferred, short description
only as a fallback), and authoring type; clicking opens existing details.
About previews strip HTML using the agent modal's sanitizer and show at most
300 plain-text characters, including a trailing ellipsis when truncated.
Previews end at a word boundary where possible. Clicking the agent name opens
the existing details modal with the full About text; no expansion control is added.
Membership uses the saved directory, not a complete workforce census or
historical department membership. Agents use current authorized saved inventory;
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
selected report set. Inventory refresh retires unsent mutation previews, but
does not cancel independent Microsoft access verification or replay submitted
actions. Linked user profile and license evidence follows the current directory
identity; removing or changing that link retires the old profile.
Microsoft-confirmed changes appear locally
immediately; subsequent saved-data publications replace them. Actual read and
authorization failures remain visible.
Table CSV exports run on the backend using the selection captured at the click,
without holding the table against new publications or idle renewal. Export
progress and downloads survive table refreshes; later exports use the current
selection. Manually changing filters still clears the previous export controls.
Access denial or actual selection rejection still withdraws the
affected evidence.

## Frontend structure

- `src/components/`: reusable UI and feature components
- `src/pages/`: page-level views
- `src/api/`: Express API clients
- `src/types/`: shared frontend types
- `src/test/`: test setup and helpers
- `browser/`: browser and layout tests
