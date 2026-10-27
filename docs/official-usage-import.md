# Microsoft 365 usage report import

Agent Control imports the three Microsoft 365 Copilot Agents usage reports:

- **Agents**
- **Users & agents**
- **Users**

Export all three files for the same reporting period.

## Required access

The Microsoft 365 account exporting the files needs a role that can download
user-level usage reports, such as **Reports Reader** or **AI Administrator**.

Importing and managing reports in Agent Control requires
`AgentControl.Admin`. `AgentControl.Viewer` can view accepted reports.

See [Microsoft roles and permissions](user-roles-and-permissions.md).

## Export the files

1. Open the Microsoft 365 admin center.
2. Go to **Reports > Usage > Microsoft Copilot > Agents**.
3. Select a 7-day or 30-day reporting period.
4. Export the **Agents**, **Users & agents**, and **Users** tables as CSV.
5. Keep the original files until Agent Control confirms the import.

If names are concealed, a Global Administrator can change the report privacy
setting under **Settings > Org settings > Services > Reports**. Export new files
after changing the setting.

## Import the files

1. In Agent Control, open **Sync**.
2. Select **Add CSV reports**.
3. Add all three CSV files.
4. Review the detected file types and row counts.
5. Select **Import reports**.
6. Review the saved-report summary, then select **Close** or **Add more reports**
   to start another upload.

The first complete report set imported for the tenant is selected automatically,
so its usage is available on Agents and Users immediately. Later imports save
reports without changing the selected report, including when no report is
selected. Deleting earlier reports does not reset this first-import behavior.
Closing the summary keeps you on Sync. To use a different saved report, select it
from the report dropdown on Agents or Users.

Invalid files show an actionable error and can be replaced without removing the
valid files already selected.

An exact duplicate reuses the accepted report set instead of creating another
copy.

## View and select reports

<a id="one-home-for-each-workflow"></a>

- Use **Agents** for agent usage and user drilldowns.
- Use **Users** for licensing and reported user activity.
- Use **Dashboard** for adoption changes across retained reports, independently of
  the report currently selected on Agents or Users.
- Use the report selector on Agents or Users to change the displayed report set.
- Use **Sync > Manage reports** to inspect or delete accepted report sets.

Deleting a report requires Admin confirmation. Importing a new report does not
delete earlier accepted reports.

## File requirements

Keep the original Microsoft CSV headers. Header matching ignores case and
surrounding whitespace.

| Export | Required headers |
| --- | --- |
| Agents | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) |
| Users & agents | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) |
| Users | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) |

Agent Control imports all rows and derives the available activity-date range.
The Microsoft files do not identify their reporting period, so the app cannot
verify that files exported at different times belong to the same period.

## Matching usage to inventory

Agent Control uses source identifiers and approved associations to connect report
rows to inventory agents. A report-only row remains visible when no inventory
agent can be matched.

Review suggested associations before accepting them. Report names alone do not
prove that two records represent the same agent.

## Troubleshooting

1. Sign in to the Microsoft 365 admin center with the required user-level report access.
2. Open **Reports** (use **Show all** if Reports is hidden), then **Usage**. Under **Reports**, select **Microsoft Copilot > Agents**.
3. Select one documented reporting window: 7 days or 30 days.
4. Select each **Agents**, **Users & agents**, and **Users** table/tab and use its **Export CSV** action for that same period.
5. Keep the original files until Agent Control displays **Reports imported** (or **Reports already imported**). An exact duplicate reuses the original report set; the upload flow selects it for viewing without creating another copy.

Microsoft says interaction usage can become visible within one hour. That is source latency, not proof that an exported or imported set is current. You do not need to record or enter dates to import the files.

Microsoft source: [Copilot Agents usage report](https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide), rechecked 2026-09-19; source page updated 2026-09-09.

## Supported schemas

Header matching is case/whitespace normalized but otherwise exact. These labels are both current Microsoft documentation and fixture-observed export evidence:

| Export | Schema | Required headers |
| --- | --- | --- |
| Agents | `m365-agents-observed-v1` | Agent ID; Agent name; Creator type; Active users (licensed); Active users (unlicensed); Responses sent to users; Last activity date (UTC) |
| Users & agents | `m365-users-agents-observed-v1` | Agent ID; Agent name; Creator type; Username; Responses sent to users; Last activity date (UTC) |
| Users | `m365-users-observed-v1` | Username; Display name; Number of agents used; Agent responses received; Last activity date (UTC) |

Agent IDs and usernames cannot contain embedded control characters, including tabs or line breaks: the import rejects them rather than stripping characters into a different identity. Quoted display names may still contain tabs and line breaks. Other unsupported controls and invalid Unicode are rejected. Text is whitespace-trimmed but never case-folded or compatibility-normalized into a different report identity.

Names and creator types may be blank; identifiers and counts may not. Counts are non-negative safe integers, optionally with comma-separated groups of three digits; blank and `null` are not zero. Blank activity dates remain unknown. Supported English month-name dates and year-first dates require real calendar dates and separators; mixed `-`/`/` separators and concatenated month/day/year components are rejected. Activity dates are UTC calendar dates, not inferred local-time instants. Validation errors identify logical CSV rows (header is row 1), not physical file lines; blank lines and quoted multiline fields do not advance that row number.

Exact creator-type filters preserve accepted embedded tabs and line breaks, including through saved selections. Unsupported controls and unpaired Unicode surrogates are rejected before selection capture; company and department filters also reject unpaired surrogates.

Optional API metadata must be omitted when absent, not sent as blank/null values. The browser API helper preserves explicitly supplied blank assertions so server validation rejects them instead of silently dropping them. Complete operator assertions are validated as real dates and timezone-qualified timestamps; invalid assertions return actionable HTTP 400 errors. The supported header schemas and parser version remain unchanged because valid source values retain their existing normalization and meaning.

The CSVs do not contain reporting-period or source-as-of metadata columns. Agent Control imports **all rows**, derives the minimum and maximum available UTC last-activity dates, and labels that coverage `activity_range`. This is observed activity coverage, **not** the actual reporting window or proof of complete daily coverage. Different files may have different activity ranges; that does not make the bundle incompatible. Reports without dated activity remain importable with unknown coverage.

The source refresh time remains unknown. The app does not guess it from the filename, upload time, or last-activity date. Previously imported administrator-supplied periods remain labeled `operator_asserted`; API clients can still supply explicit metadata, but the import screen does not ask for it. Export all three files from the same Microsoft reporting selection: without period metadata, automatic import cannot prove that unrelated exports belong to the same reporting window.

Microsoft documents the following interpretation constraints:

- **Active users (licensed)** and **Active users (unlicensed)** are independent source categories. A license change can place one person in both categories during the selected period, so even one agent's distinct total can be less than their sum. Agent Control never adds them. Microsoft defines an active user as one who asks an agent a question and receives a response. Per-agent distinct active users come from exact, positive-response Users & agents identities; without companion rows for that agent the value is `Unknown`. Explicit zero-response rows remain reported relationships, but contribute zero active users. Tenant active-user totals deduplicate positive-response identities from Users and Users & agents without adding the two source counts.
- Users-report **Number of agents used** is reconciled against distinct positive-response agents, not every reported relationship. Zero-response relationships remain visible and exportable without creating a false report-mismatch warning.
- The drilldown's **Users with responses** metric follows the same per-agent evidence rule. It remains `Unknown` when the companion report is empty or contains only other agents, even though its reported relationship count is zero.
- Response values from Agents, Users & agents, and Users remain separate source totals. The headline response total uses Agents only and excludes bridge-only agents instead of creating a hybrid total.
- Computed report totals must fit the exact safe-integer range. If a total exceeds that range, the report returns an explicit `official_usage_total_limit` conflict rather than publishing a rounded number.
- In Users & agents, **Last activity date (UTC)** is when that agent was last used by anyone. It is preserved with that exact meaning and is not used as the named user's recency. User recency comes from the Users export and is `Unknown` when no Users row exists.
- Usernames can be anonymized according to Microsoft 365 report settings. They remain case-sensitive dataset-scoped identifiers and are never guessed back to people.

## Initial setup and retained history

### Adoption dashboard

**Dashboard** (`/dashboard`) shows the progression of active users and active
agents across complete retained report sets, without limiting history to
Microsoft's rolling export window. It works for Viewers and Admins without
requiring current inventory or license synchronization. The Users **Adoption**
tab remains the company/department exploration view.

The dashboard loads every history page under one consistent saved selection
before displaying comparisons. The earliest dated observation is the default
baseline; selecting another baseline changes only this dashboard and preserves
the choice in its URL. Headline cards show the latest dated observation and its
absolute/percentage differences from the baseline and previous dated report.
Two aligned charts share the report timeline. A zero baseline shows the absolute
change without an undefined percentage. Unequal explicitly supplied reporting
windows and identical end dates do not receive a directional comparison.

Active users are distinct exact positive-response usernames from Users and
Users & agents within each report set. Active agents are distinct positive-response
agent IDs from Agents and Users & agents. Users are not joined across reports,
and report agent IDs are not silently replaced by current inventory identities.
Response volume uses the Agents export only. The snapshots table keeps the
independent user/relationship source counts and response totals visible; they
are not forced to reconcile or added together. **Inspect report** opens the
exact saved report in Sync.

Observed activity ranges remain labeled as observations, not verified reporting
windows. Import dates are provenance, not usage dates. Reports without activity
dates retain their counts in a separate table but do not establish chronological
direction. Recent direction describes snapshot movement, not a daily/monthly
growth rate or a forecast. Deleted, superseded, expired or damaged reports do not
contribute; missing reports are not zero-use periods. Creation/publication dates
and today's license/inventory populations do not substitute for usage or
historical adoption denominators.

The read-only `GET /api/official-usage/history/adoption` endpoint accepts the
existing saved `selectionId`, `cursor` and `limit` parameters and returns
cursor-paged snapshot metrics. It does not change the selected shared report or
call Microsoft providers.

### Retained report interpretation

The **Sync** page presents **CSV usage reports** separately from automatic sync and sync history. Its compact summary shows the saved-set count, **Observed activity dates (UTC)** across all retained complete sets, and last import time. The dates include all three CSV kinds and older reports, regardless of current selection or pagination; they are not administrator-supplied reporting windows. Undated reports show **No dates found in imported reports**. Dates are never inferred from import time, and the bounds do not imply continuous coverage or additive response totals.

The saved history API exposes the observed activity bounds as `summary.activityDateRange.earliestDateUtc` and `latestDateUtc`. It separately retains explicit reporting-window bounds as `summary.reportingWindows.earliestStartDateUtc` and `latestEndDateUtc`, both nullable `YYYY-MM-DD` values; inferred activity ranges do not contribute to those explicit bounds. Draft, incomplete, deleted and damaged sets are excluded, as are other tenants. The summary covers the whole retained history; per-bundle accounting is derived only from observations on the requested page. Imports and deletion update the compact summary automatically. A failed read hides unverified ranges and offers **Retry**; there is no routine refresh button. Viewers can inspect the summary and history; only Admins can import/delete.

Initial automatic sync collects Users, Graph packages and Power Platform independently of manual CSV reports. Missing reports show **Import needed** without blocking automatic-source setup. An Admin uploads the three companion exports, reviews the summary and selects **Import reports**. Saved-data browsing remains available while uploads or permissions are pending.

Ordinary uploads require no correction acknowledgement. Exact repeated content is deduplicated against non-deleted report sets; unchanged payloads can be reused while source associations and metadata remain available. Changed counts, names, activity values, or supplied source metadata create a new independent report set, even for an already imported reporting window. Newer sets become selected; a historical backfill with an earlier end/start range preserves the existing selection and its revision. An undated import also preserves a dated selection. First imports, newer/equal ranges and corrections to the active set retain their normal activation behavior. The acceptance API preserves selection, revision, and original acceptance time for duplicates. A saved non-active import offers **Keep current report** or an explicit **Use imported reports** confirmation. Content reuse does not establish cross-report user identity.

Deleting a report set does not prevent uploading those CSVs again. A fresh upload creates a new report set and import time without a restore or approval step; the previous record remains deleted. Retrying the original completed request cannot restore its deleted result or select a newer copy. The same rules apply before and after deleted data is purged by retention.

This preserves historical observations beyond Microsoft's rolling 7/30-day export window. It does not turn aggregate CSVs into event logs: adjacent exports overlap, and neither adding their response totals nor subtracting one snapshot from another establishes exact daily activity. Last-activity ranges do not establish report-window boundaries. Historical report views keep the original source metrics and lineage rather than presenting an invented all-time usage total.

Cross-import search is not presented in **Manage reports**. To compare an agent's usage across reports, open its **Usage** modal tab and inspect the read-only reported-usage trend and always-visible snapshots table. **Users** defaults to the newest retained reporting period's metrics and user list; when that report has no usage, discovery can open another reported period locally in Users. Changing the report-set selector remains a separate shared action. The retained overview API still unions exact, case-sensitive agent IDs from complete, accepted, non-deleted, integrity-valid bundles for API consumers, including agents absent from the latest import. Corrected/superseded sources do not contribute and do not revive when their replacement is deleted. Retention preserves a deleted correction's metadata while its original remains undeleted, even after purging unshared payloads; restore review also compares supersession state. Duplicate payloads and repeated memberships do not multiply counts, and no report username is joined across snapshots. Removing the management search UI does not change these storage or API contracts.

With no date filter, all retained activity evidence is considered. Start/end dates are inclusive UTC filters on each observation's agent last-activity date; older qualifying observations remain reachable even if the same agent has a newer observation outside the chosen range. The displayed date span is observed activity, not proof of continuous reporting coverage. The 30-day measure uses positive-response evidence with an agent activity date from UTC today minus 29 days through today, never the upload date. Stale/missing exports can understate current activity; missing history is shown as unknown, not zero tenant use.

Cross-import search matches literal text in retained agent IDs and names, ignoring case using the database locale, including non-ASCII letters in Unicode-aware locales. Case-distinct agent IDs remain separate identities, and `%` and `_` are ordinary search characters, not wildcards. Search and date filters affect the locator's agent list. This cross-report locator is historical evidence discovery, not an additive usage dashboard.

For example, response totals of 100 for June 1-30 and 120 for June 15-July 15 do not reveal the shared June 15-30 responses. The union could contain 120-220 responses. Removing identical CSV rows cannot resolve that ambiguity. Cumulative agent/activity evidence can span both imports, but exact response counts and exports stay in the **Manage reports** snapshot inspector. Exact interval totals require dated daily or event-level data, which these CSVs do not supply.

The Agents overview keeps four separate measures: agents in the saved repository and Power Platform inventory, including inaccessible agents; agents with a known unblocked package available to some/all users and no known native quarantine (across hosts, not only Teams); distinct report IDs with positive-response evidence **in the selected report set**; and IDs in that same set with positive-response evidence and last activity in the last 30 UTC calendar days. Changing the selected set updates the report cards, usage columns and user reporting together without merging snapshots. Creation or publication alone does not establish end-user access. Shared package versions count once per logical inventory agent. The first two cards clear table filters and show the matching repository/access list without navigating away. Missing access evidence has its own filter and is not labelled unavailable. Partial collection is noted inside the cards. The selected report's activity range, age and unknown-period status remain visible when usage columns are shown.

Full resync preserves accepted report history, including the Sync page's explicitly confirmed **Reset saved data** option. That option clears saved users and inventory, not official reports. Deleting reports remains a separate, explicitly confirmed Admin operation. Opening the uploader leaves Sync's jobs in place. **Cancel** returns to Sync; **OK** after a verified import closes the dialog and opens Agents with that report set selected.

## Add CSV reports

1. Sign in with `AgentControl.Admin`. Admin includes all Viewer access, including aggregate and user-level accepted report views.
2. Open **Sync > Add CSV reports** (`/sync?reports=import`). Every ordinary opening starts a fresh upload, even if a previous import finished or server-side drafts exist.
3. Drop the three original exports into the dialog or select **Choose CSV files**. Files must be CSVs, at most 256 MiB each. Companions may also be added in separate picker operations. No dates or source metadata need to be entered.
4. Validation starts immediately. Each compact file card shows its filename, report type and row count, or its checking/error status. Valid companions remain in the same bundle; **Choose CSV files** supplies missing/rejected reports. To replace the whole draft, cancel it and reopen **Add CSV reports**.
5. Once all three kinds validate, **Ready to import** shows the three file summaries and one **Import reports** action in the footer. The server still checks the content hash and selection revision and publishes all companions atomically. Hashes, parser versions, storage accounting, and informational source warnings stay out of this flow; source differences remain available in report details.
6. The UI verifies the exact saved report and its selection using fresh reads. It does not substitute a different report or call a failed read success. **Reports imported** has one action: **OK**, which rechecks the destination, closes the dialog, and opens Agents. A deletion or another administrator's selection change while the success screen was open is reported rather than silently opening a different set. If verification fails after saving, **Verify saved import** checks the saved result without uploading or importing twice.

The success screen includes a compact **Agents**, **Users**, and **Responses** summary from that exact report set. Agent and user counts are records in their respective CSVs, including zero-response records, not inventory or active-user totals. Responses use the Agents CSV only; overlapping totals from the three exports are never added. Statistics use the full saved reports, not the one-row verification page, and do not add another approval step.

**Cancel import**, including Escape before publication, asks for confirmation before discarding this draft's unaccepted staging or cancelling an upload. Cleanup failures remain visible and retryable. During acceptance or saved-result verification, cancellation is disabled. An uncertain acceptance must be verified before discarding staged files. Once an exact read verifies a saved backfill, duplicate or correction that is not the current report, **Keep current report** or Escape closes the dialog while retaining the saved import and leaving the tenant's current report unchanged. **Use imported reports** is a separate, explicitly confirmed selection action. The active success screen and **OK** still recheck the exact destination before opening it. Leaving the page stops follow-up requests; abandoned staging retains its server expiry. The compact dialog scrolls its body when needed rather than stretching an empty result to a fixed full-page height.

Source metadata remains available to API clients but is not an input in this dialog. Resumed drafts preserve any explicit reporting period and source-as-of metadata when adding missing companions.

Changing account, losing import access, or opening a different staging link unmounts the old importer and stops follow-up uploads, reads, and refresh callbacks. An already submitted mutation may have completed server-side, so check saved reports before re-uploading. Authorization failures clear file evidence and import actions. Explicit staging links recover only their exact draft; a complete recovered draft requires **Import reports** (or **Verify saved report set** if already accepted), not publication merely by opening its link.

Job, staging, correction and report-set UUID links use lowercase identities, so equivalent UUID casing does not replace an active read or draft. Account revalidation and sign-out remove active staging, correction and snapshot links before the next session.

Successful companions survive a partial file failure; an entirely rejected upload does not look up a nonexistent bundle. Uploads send `rejectDuplicateKind=true`: a second file of a type is rejected before replacing existing data. Choose the missing report files, or cancel and reopen to replace the draft. The server, not filenames, identifies report types. Without period metadata it cannot prove that three different types came from the same reporting window, so the prompt asks for exports from the same Microsoft selection.

An uncertain publication response offers **Verify acceptance**, which replays only the original hash/revision intent. A definite stale-fence rejection gets a fresh preview only through **Refresh bundle validation**. Resumed corrections keep their original target with a concise warning. Cancel and reopen the ordinary uploader to create an independent import. Supplied period/source metadata is inherited by new companions, never replaced with guessed dates.

## Choose the report set shown in Agents and Users

Admins have a **Report set** dropdown on Agents and on the usage cohorts in Users. On Agents it sits in the overview's **Report context** area; inventory scope stays beside the heading. Choosing a retained three-file set applies it immediately, without Apply or Refresh buttons or persistent helper text. This changes the tenant-wide selection for all viewers, not a private local filter; inventory collection and directory licensing are unaffected. The selector labels known windows separately from observed activity dates and includes a short reference to distinguish identical ranges; import dates are omitted from the dropdown and its tooltip. Dated options and Manage reports are ordered server-side by reporting end, reporting start, acceptance time and ID, newest first; undated ranges come last with a stable ID tie-breaker. Cursor pagination uses this same ordering rather than sorting a single browser page by upload time. **Older report sets...** and **Newer report sets...** entries inside the dropdown make every retained set reachable, one bounded page at a time, without a separate count/arrows row. Existing combined-inventory URLs remain readable.

Changing the dropdown obtains a fresh preview, checks the reviewed shared revision, then confirms that exact selection. The dropdown is disabled while saving. Stale selections, failed reads and uncertain mutation responses display an error with an on-demand **Retry** action that reloads authoritative state rather than repeating a consumed confirmation. Accepted selection invalidates agent/user report consumers even if the subsequent metadata refresh fails. Selection also exits any pinned historical Users link; merely inspecting a historical snapshot remains read-only.

Both Users cohorts retain search (`q`) and exact report (`snapshot`) beside user detail links. Returning preserves those filters and reuses still-current evidence. Pagination uses a selection-bound cursor.

The Agents filter retains **All agents**, **1st party agents**, **3rd party
agents**, **Shared in your organization**, and **Built by your org** labels. Its
toolbar has no extra options disclosure. Bounded facet paging stays inside the
dropdown. Report-evidence refresh announcements are screen-reader-only; the
existing inline refresh indicator does not add a row or move the table.

## Manage retained reports

**Sync > Manage reports** (`/sync?reports=manage`) is one paginated list showing import time, activity dates, report/row counts and current/saved status. **View report** is read-only for both roles. Only Admins see **Add CSV reports** and deletion. Selection belongs to the Agents/Users report-set dropdown. History reloads on opening, mutations and window focus; failed reads offer **Retry** and disable unverified actions. Deletion separately confirms whether it clears the selected report.

Exact retries use a finite content-free receipt containing tenant, actor, bundle, original hash/revision and original result. They return that result after staging cleanup without republishing/reselecting; changed intent fails. Acceptance reports `reusedExistingSet`, and the UI verifies that exact set even outside the bounded admin list. Viewing selection is a separate fenced request; uncertain selection responses are checked before retrying. Explicit corrections retain supersession semantics; ordinary imports do not create corrections. Deleting the selected set clears selection without choosing an older set.

## Inspect retained snapshots and source evidence

The read-only inspector in **Sync > Manage reports** shows exact tenant-wide source reporting, not current inventory or licensing. One selected snapshot supplies Agents-export responses, distinct positive-response identities, reported agents and an **Agent comparison** table. Report-only rows remain visible. Search/creator filters and response/user/activity/name sorting apply before 25-row paging; unknown reach sorts after known counts including zero. Exact `snapshot` or supported `window` links select one snapshot; `/sync?reports=snapshot` selects the current one when neither is supplied. Catalog state is not an official usage metric.

Open an agent's name to inspect its exact report ID, separate licensed/unlicensed source categories, and reconciliation. **Report quality & sources** expands source authority, freshness, versions, file warnings, and interpretation limits; **Source totals differ** remains visible when totals disagree. Technical details do not expand automatically.

The **Manage reports** list omits storage accounting, duplicate payload counts, hashes, and lineage; these remain in API/storage contracts. **Report details** has one **Back to reports** action rather than refresh/current-snapshot shortcuts. Viewing a report pins subsequent queries and CSV export to that set without changing the tenant's selection. History and the inspector are readable by Viewers and Admins; importing, corrections, selection and deletion remain Admin operations. Failed reads remain explicit and disable unverified actions. A failed next-page read never relabels the previous page and offers a return to the first page.

Current agent usage belongs to **Agents**; person-level analytics, licensing, and user CSV export belong to **Users**. Use the primary navigation for those workspaces, Permissions, and Audit. Provider collection, **Import reports**, and **Manage reports** all belong to **Sync**. Exact contextual links from an agent or user to its retained source snapshot open the Sync inspector rather than another usage dashboard.

A snapshot dashboard includes all its rows, including undated and zero-response rows; the accumulated history preserves previous snapshots separately. Optional date filters are applied **after import** to the last-activity values. The CSVs are aggregate snapshots, not daily activity logs: filtering a row by its last-activity date does not turn its full-export response count into a count for the selected interval.

| Source | Information available for analysis |
| --- | --- |
| A file type is not recognized | Confirm the file is one of the three Microsoft Copilot Agents exports and still has its original headers. |
| The three files cannot be imported together | Export all three again from the same report page and reporting period. |
| Names are concealed | Change the Microsoft 365 report privacy setting and export fresh files. |
| Rows appear only in the report | Refresh inventory and review report-to-inventory associations. |
| Import is denied | Confirm the signed-in user has `AgentControl.Admin`. |
| A report is no longer needed | Delete it from **Sync > Manage reports**. |

Response totals and agent counts from the Users export are shown separately from the user-agent relationship totals when they disagree. A source discrepancy is a data-quality signal, not a reason to discard rows or overwrite one report with another. Identifiers seen in only one report remain available with their missing-source status.

### Explore adoption from Agents and Users

- **Sync > Manage reports** locates reported agents across imports and opens an exact report's response and user breakdown in the snapshot inspector, independently of saved inventory. A report identity never grants access-control targets.
- Inventory agent modals are strictly agent-scoped. Their **Overview**, **Usage** and **Users** tabs never substitute tenant totals or unrelated report comparisons. Inventory usage automatically matches the active report's full Agent ID to a current authorized Graph package ID and its existing canonical agent (see below). Missing matches remain unknown, not zero; names and IDs from other namespaces are not fallback keys.
- **Users** defaults to the newest retained reporting period, independently of the shared report selector. **Latest report dates**, responses, active users, last reported activity and the searchable user list all use that same report. Reports are ranked by end date, start date and acceptance time; a later-uploaded older backfill does not become the latest period. Dated reports take precedence over undated reports; if every report is undated, the most recently accepted one is used and its date range remains unknown. The existing cached history read supplies this metadata without reparsing CSVs. Metrics wait for a validated latest-report lookup rather than briefly displaying the shared report, and a failed lookup offers an explicit retry rather than a silent fallback.
- When an agent is absent from the newest CSV, **Users** shows **Usage not reported** with no reload button, even if older reports include it. With no retained CSV reports, it asks the user to import a complete report in Sync. A shared report need not be selected to view retained usage. **Usage** instead shows the history-wide comparison and its missing points or empty state. **Reload usage** is reserved for failed reads or invalidated selections; rereading an unchanged CSV cannot supply missing usage.
- **Reported usage trend** on **Usage** compares response counts from retained report snapshots in chronological order. Its read-only line, full-range tooltips and always-visible table below the graph show individual counts and differences, never cumulative usage. Report dates are plain text and graph points are not selectable; selection instructions, viewing badges and the redundant CSV-date footer are omitted. The compact table fits the modal width and stacks each snapshot's metrics on narrow screens. Overlapping and inferred activity ranges can be compared as reported snapshots, not as exact daily activity. Missing counts break the line; zero remains a real point, and a zero baseline uses **New activity** instead of an infinite percentage. Different known window lengths and identical end dates do not receive growth percentages. Corrected/superseded sets do not contribute extra points.
- An automatic history lookup also identifies the latest report containing this exact agent, including a report beyond the displayed history page. In **Users**, **View this period** directly updates the visible metrics, **Historical report dates** and user list; **Return to latest report** restores the newest period. These local controls are not shown in Usage and do not change its chart or table. Local reads do not change the tenant-wide selection. Reviewed-link removal is offered only when the default latest period also matches the shared report's mutation context, never for a historical fallback or a different latest report.
- The agent dialog has **Overview**, **Usage**, **Users**, **Manage** and **Activity**. Overview shows configuration/published versions; Usage shows trend/snapshot comparisons; Users shows CSV dates and searchable user metrics. Usage/Users retain the modal period/history while user rows load only when Users is open. `/api/agent-inventory/:recordId/usage-users` pages 25 dialog rows across exact linked versions, grouping case-sensitive report usernames before paging. Leaving the tab retires unsent removal confirmations, not submitted writes. Submitted removals remain single-flight across remounts and invalidate evidence on successful/uncertain completion within their owning session. Leaving never implies rollback/resubmission. Current authorization/source/selection fences remain.
- **Users > Paid M365 Copilot users** is the default directory-backed roster, including paid users with zero or unavailable activity. The dropdown's second view, **Active users without paid Copilot**, contains only exactly verified current non-paid users with positive Users-report or Users & agents responses. Unknown licensing is excluded with a coverage notice; it is not treated as unpaid. Both views have searchable, paginated per-user agent drilldowns. There is no tenant-wide agent-column limit.
- An explicit zero is reported evidence. Missing relationships or Users-report totals remain unknown, not evidence of inactivity or blocked access. User responses and agents-used values come from the Users report; bridge totals remain separate in details. Missing Users-report metrics sort last in either direction, rather than silently ranking an alternate source.
- Drilldown links carry the report snapshot so changing the tenant's selected report cannot silently change their meaning. **Use current reports** is an explicit switch. The unpaid cohort always uses current saved license evidence, regardless of the report period; historical licensing is not tracked. Unmatched/ambiguous identities remain unknown. Rich directory details require an existing unique link for the same report set and versions, not a display-name heuristic.
- Saved report reads are bounded and provider-free. `GET /api/official-usage/overview` accepts `scope=history|selected` (default history), search, inclusive date bounds, sorting, selection and signed keyset paging. Explicit superseded selection shows that exact set without reviving it in historical analytics; no selected set is not fallback history. Responses do not invent cumulative totals/cross-snapshot users. Exact agent `/users` children page relationships independently. `/official-usage/users` applies exact case-sensitive `agentId` and saved-directory `licenseCohort=active_without_paid` before paging/export; row totals remain all-agent source totals. See [API contracts](mcp-integration.md#users-licensing-official-reports-cohorts-and-retained-history).
- Aggregate JSON and selected CSV exports support `sort=activeUsers`, based on distinct positive-response companion identities, never the sum of licensed and unlicensed source categories. User `agentId`, `creatorType`, and `responsesOnly` filters must match the same relationship; activity on a different agent cannot qualify a selected zero-response relationship.
- Report detail, users, aggregate, history, and CSV queries reject unsupported, repeated, or structured parameters before reading saved data. A report selection is one exact `setId`, never the first value of an ambiguous query.

Filtered agent and user CSV downloads use `POST /api/data-exports` with the displayed `selectionId` and dataset `kind`, then the export status and `/download` endpoints; there are no direct report `.csv` routes. Exports preserve these source distinctions and include all matching results, not just the visible page. User filters select people: the user download includes **all agent relationships of matching users**, even when an agent, creator, or response-producing relationship selected those users. It has one row per reported user-agent relationship, or one row with empty agent fields when the user has no relationship rows. User-level totals repeat on relationship rows; do not sum those repeated totals as though they were per-agent counts. Downloads use the exact displayed report set and applied filters; pending, failed, or superseded reads cannot export old results under new controls. Cancelling an agent export releases its busy state immediately, even if the superseded transport completes late; only a new export for the verified displayed result may download.

### Match inventory usage automatically

`GET /api/agent-inventory/:recordId/usage-history` uses the same saved inventory selection and per-report exact/reviewed matching rules as the current summary. It returns at most 100 points per page (50 in the UI), history counts, signed next/previous cursors, `latestReportSetId` (the newest retained report, even if this agent is absent) and `latestReported` (the latest point with agent usage). Both latest fields are independent of history pagination; paging comparisons cannot change the Users tab's default period. Start/end dates and provenance are read from persisted import metadata; CSVs are not reparsed. A single indexed query reads only Agents-report counters, not tenant-wide user relationships or one full summary per dataset. User details remain lazy, bounded reads for the viewed period. The summary, associations and users GET endpoints accept a local `setId` only within their pinned retained history.

Both latest lookups rank their eligible reports by end date, start date and acceptance time, with an exact report UUID tie-breaker. Dated evidence takes precedence; when no eligible report is dated, acceptance time determines the latest report, including zero-response evidence. Undated history pages retain their stable UUID ordering and cursor boundaries, so the latest lookup may identify a report beyond the displayed page.

The process-local history cache is bounded to 32 entries of at most 64 KiB, expires after five minutes or selection expiry, and includes selection/principal/authorization, inventory, history and reviewed-association evidence in its key. Empty results are cached too. Every hit still validates the exact inventory target and selection fences; correction, deletion, expiry, permission or identity changes cannot expose stale evidence. Normal new uploads remain outside already pinned history until inventory is recaptured.

Saved Microsoft 365 exports and Graph package observations share a full package identifier, including prefixes such as `T_` and `P_`. Inventory usage compares the complete, case-sensitive report `agentId` with the Graph package `id` within the tenant and the viewer's current authorized saved source memberships. It does not strip prefixes, case-fold opaque IDs, compare names, or search arbitrary identifier fields. A report ID is not treated as an Entra application ID, manifest ID, canonical UUID or Power Platform native ID.

The identity chain is **report Agent ID -> exact Graph package ID -> existing canonical agent -> already established Power Platform membership**, when available. Package-to-native resolution continues to use its own source-declared metadata, environment scope and ambiguity checks; usage matching does not create or widen that link. For example, supported declarative-agent links use a package manifest ID corroborated by the native resource ID and schema name, not a report ID guessed from the native GUID. Multiple distinct package/report IDs on one logical agent are counted once each. Conflicting canonical owners of a source identity fail explicitly rather than arbitrarily receiving the report's metrics.

Matching is computed during saved inventory reads before filtering, sorting, pagination and export. It writes no associations, changes no inventory, calls no provider, and needs no per-agent setup. A newly selected snapshot is matched again using its own rows, not an inherited total from earlier imports. The modal and CSV expose `basis: "exact_package_id"` for automatic matches; no review timestamp or administrator verification is invented. Report-only browsing remains available for IDs not present in inventory.

The agent modal's **Usage** and **Users** tabs read the same validated inventory selection
as the Agents table, including its retained report history, source memberships and association
revision. Users defaults to that history's newest report rather than the table's shared report set.
Catalog refresh, pending control publication and canonical
reconciliation do not turn a still-valid saved usage selection into a live-control
error. Metrics, reviewed links and paginated users all carry the inventory
selection as `inventorySelectionId` and the same local `setId` when viewing a different report.
New uploads do not enter an existing pin until the normal inventory recapture; no read bypasses that boundary.
Expired/deleted evidence and changed authorization still fail closed. The browser
requests one automatic inventory recapture for an invalidated selection, and
stops with an actionable error if that recapture also fails (no reload loop);
**Reload usage** also reloads saved inventory, rather than repeatedly retrying an
obsolete report or control reference. This is a saved-data read, not a provider
refresh. Association removal still validates current live source membership and
the active report in its locked mutation transaction.

#### Explicit reviewed associations

Administrator-reviewed mappings are explicit overrides for an exact report ID/set, including when their source is temporarily unavailable. Automatic matching never silently reassigns them. The paged API distinguishes `basis: "reviewed"` from `basis: "exact_package_id"` and returns exact source target/snapshot provenance. Routine setup uses automatic exact matching; the Admin-only confirmed API supports explicit review/repair:

| Route | Contract |
| --- | --- |
| `GET /api/agent-inventory/:recordId/usage-candidates` | Admin only; explicit candidate browsing, optional `search` (256 characters), `selectionId`, keyset `cursor`, `inventoryRevision`, and `limit` (1–100, default 50). Returns only Agents-export rows, an `associated` flag for stored reviewed mappings, and active report context. No user rows or provider calls. |
| `POST /api/agent-inventory/:recordId/usage-associations` | Admin and CSRF; exact `selectionId`, `reportSetId`, case-sensitive `reportAgentId`, source-qualified `target`, `inventoryRevision`, `usageRevision`, and literal `confirmed: true`. |
| `DELETE /api/agent-inventory/:recordId/usage-associations` | Admin and CSRF; the same confirmed revision/set/report identity fields, without `target`. The modal supplies an `inventorySelectionId` query parameter matching the body's `selectionId`. Only an association resolving to this currently authorized live agent can be removed. |

Graph targets are `{ source: "graph_packages", packageId }`; Power Platform targets are `{ source: "power_platform", nativeId, environmentId }`, with an explicit `null` for an absent environment in both association reads and writes (never the storage-only empty-string sentinel). A canonical UUID is a navigation reference, **not** an association target. Unknown fields and malformed identifiers, revisions, confirmation values, or paging are rejected. Candidate searches and association identifiers must contain well-formed Unicode without C0/C1 control characters; malformed text is rejected before saved-data reads or auditing, never repaired into a different identity. Successful mutations return the updated usage context only after commit; refresh the inventory before another review.

Mutation bodies and targets must be plain or null-prototype data objects with their required fields present as own properties; inherited fields, accessors, hidden unknown fields, and symbol keys cannot supply or extend the intent. A removal omits `target` entirely; explicit `null` or `undefined` is invalid. Mutations require a non-null report-set UUID, a selection UUID, two exact 64-character lowercase hexadecimal revisions, and unpadded report/native/environment identifiers of at most 512 characters. Selection and report-set UUIDs canonicalize to lowercase; report and package identities retain their exact spelling, while typed Power Platform identity normalization remains the inventory lookup authority.

Exact-ID summary batches reject duplicate decoded and normalized identities before reading saved data. Alternate UUID casing, equivalent percent encodings, and normalized Power Platform GUID/environment references do not identify distinct targets. Opaque package/native/environment IDs remain case-sensitive, and returned record IDs retain the caller's spelling.

The selected report set, versions and artifacts must remain unexpired through usage publication. Association mutations recheck the same active report after writing; an expired reread cannot commit a change with an unavailable report context. Association changes and their success audit commit together or roll back together. Saved-inventory reads recheck usage expiry after enrichment and transaction completion; CSV publication carries the report expiry through its final revision checks. The browser rejects responses that expired in transit instead of caching them as current.

Stored reviewed associations are shared within a tenant but bind to **one immutable report set and one exact native source**, never to the reviewer's private canonical UUID. Another viewer sees metrics only when that same native source is present in their current authorized saved inventory. Package IDs and opaque native IDs are case-sensitive; Power Platform GUIDs and environments follow the existing inventory identity normalization. Each reviewed report ID has one target per tenant/set; reassignment requires explicit removal first. Multiple distinct report identities may attach to one logical inventory agent. A new active report set does not inherit old reviewed associations; its automatic exact-package matches are evaluated independently.

Linked responses sum each associated Agents-export identity once, within the viewed retained set only. Mutations require that set to be active. The latest Agents-export activity date is preserved. Active users are the union of exact, case-sensitive **positive-response** Users & agents identities, deduplicated across associated report identities. Licensed and unlicensed categories are never added. If any associated identity lacks companion evidence, its combined active-user metric is unknown; an explicit zero-response companion row yields zero. Unavailable reports and unlinked records use null metrics, not zero. Source lineage, stale status, unknown freshness, and `activity_range` provenance remain visible; no overlapping-period or all-time total is invented.

Associations never create, authorize, or alter native management targets, provider capability evidence, directory identities, or saved inventory. Candidates and writes read only saved data.

#### Atomicity, revision fences, and cleanup

Association operations lock the principal's `data-sync:<tenant>:<principal>` reconciliation boundary and ordered saved/current source scopes before validating selection fences. The active report head is then locked before comparing usage revision and exact current source authority. The mutation and successful administrative audit receipt commit together; audit failure rolls the mutation back. Rejected attempts retain a failed audit receipt when the database remains available.

If reading or appending that failure receipt also fails, both the original mutation error and the receipt error are preserved. A durable successful receipt is never rewritten as failed after a transaction-completion error.

Usage revisions hash the frozen report metadata (including report-set/lineage/content identities and freshness) and tenant association revision. Exact usage `inventoryRevision` separately hashes tenant, principal, canonical agent and control generation. Association insert/delete advances a monotonic revision, including remove/re-add cycles, and invalidates saved inventory association evidence. Correction, deletion, expiry and authorization changes invalidate the affected selection fences. Ordinary new uploads do not replace reports in existing history pins. Unexpected database failures fail explicitly rather than yielding an empty successful projection.

Inventory queries capture report context with their source/history roots and association revision. `OfficialAgentUsage.inventorySummaries` reads bounded exact canonical IDs on that same selected transaction; modal history, summaries, associations and users reuse the validated inventory selection rather than obsolete whole-inventory projection helpers. Persisted exports revalidate those selection fences on each bounded read and publication. Report-set, version and artifact expiry are enforced by the retained-history and selected-report contracts.

Deleting a report set removes its associations immediately in the same transaction; physical set deletion also cascades. Bounded operator retention removes associations for expired/deleted sets. Accepted history has no default time expiry; associations on unselected but retained sets stay scoped to those sets and can reappear only if that exact set is selected again. Principal inventory cleanup does not delete another viewer's tenant report associations, but absent sources never receive metrics. Tenant association revision counters contain no report/user payload and remain to prevent revision reuse.

For IT license reviews:

1. Sort users by responses to see the most and least active reported users. Use a configurable low-response threshold to assemble a review cohort, and inspect each user's agent breakdown and creator types.
2. Review zero-response, low-response, and stale-activity signals separately. A blank last-activity date means unknown, not inactive. User recency must come from Users, never from the agent-wide date on a Users & agents row.
3. Inspect discrepancies before acting and retain the source totals in exported review data.
4. Confirm the person's paid Microsoft 365 Copilot service is enabled, not merely that a containing product is assigned, and review broader Copilot activity, role, and business need using your approved administration workflow before reclaiming or reallocating a license.

**These exports cannot identify every unused Microsoft 365 Copilot license.** They do not include a tenant license roster, per-person license assignment, or all Copilot use in Word, Excel, Teams, Outlook, and other apps. A user absent from the files cannot be classified as having zero usage. Even a reported user with zero agent responses may use Copilot elsewhere. The exports alone cannot establish a user's license status; the Users view adds separately saved directory context only through a verified user link. Low agent usage is a candidate for review, not an automatic unassignment recommendation. Licensed and unlicensed agent-level categories cannot be joined back to individual users.

## CSV schema validation

The three supplied September 12, 2026 exports were checked against the header registry: all 7 Agents columns, 6 Users & agents columns, and 5 Users columns match. UTF-8 BOMs, quoted English UTC dates, and quoted comma-grouped counts are supported. No additional CSV columns are silently ignored.

English dates accept complete month names and standard three-letter abbreviations (also `Sept`), case-insensitively; unrecognized names are rejected rather than matched by prefix. Users-export agent-count and response-count totals are checked independently against the safe-integer limit, never added together.

Agent IDs containing embedded carriage returns or line feeds are rejected during validation because they cannot be used by the report drilldown or agent filters. Quoted multiline agent names remain supported.

The supplied snapshot contains 244 agents, 517 user-agent relationships, and 300 users, with observed UTC last activity from August 14 through September 12. Agents and Users & agents each report 9,693 responses; Users reports 9,697. One user's source totals differ. There are 145 reported users with 1-5 responses and no zero-response rows in this Users export. This does **not** establish that the tenant has no inactive license holders.

## Limits and retention

Use the current [deployment workflow](deployment-setup.md): initialization accepts only an empty database or the exact compiled schema fingerprint. Incompatible development databases require explicit owned-target reset; no historical schema, report payload or receipt is upgraded. Use the operator identity for initialization, not the restricted runtime role. Current runtime grants permit association insert/delete, not reassignment updates or revision-counter writes; readiness verifies that boundary. In-app full resync does not initialize or reset the database. No database or deployment execution was performed for this code-only contract update.

| Boundary | Limit |
| --- | --- |
| File upload | 8 MiB, 50,000 rows, 4 KiB per field, valid UTF-8 |
| In-memory admission | Two concurrent uploads per application process; 15-second processing deadline |
| Actor staging | Nine retained rows, 150,000 parsed rows, 96 MiB; one kind per bundle intent |
| Tenant staging | 30 retained rows, 500,000 parsed rows, 256 MiB |
| Staging lifetime | 30 minutes; abandoned rows cleaned before admission, at startup and periodically |
| Atomic acceptance receipt | 180 days; content-free and independent of staging cleanup |
| Accepted content | Retained until explicit deletion; shared payloads remain while referenced by another retained report |
| Minimal import audit | 90 days |
| Operation confirmations | 10 minutes; at most 20 live per actor |

CSV parsing stops at the first row beyond the row limit and rejects the report without parsing the remaining records. Empty lines are ignored, and quoted multiline fields count as one CSV record.

Run [operator retention](operations.md#run-retention) using its exact project/database confirmation, preview and bounded slices. Retention is not a `deploy-local.ps1` argument.

`OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to 35 and accepts 1 through 365. Staleness uses the age of the available coverage endpoint and the accepted-set age; an absent activity date is not evidence of a fresh source. Never treat `unknown` source freshness as current.

## Failure recovery

- A malformed, incompatible or schema-drift file is rejected without changing the active set. Correct the input and stage that kind again in the same bundle.
- A missing companion leaves the bundle unpublished. Choose the missing CSVs; **Import reports** becomes available once all three types validate.
- A stale bundle hash or active revision returns a conflict. **Retry** gets a fresh preview after a definite rejection; an uncertain response instead replays the original request.
- A partial cancellation failure remains visible. **Retry** cleans up only this draft's remaining staging before closing.
- Expired staging cannot be accepted. Re-export when freshness matters and stage the original files again.
- Upload timeout/disconnect cancels publication at the transaction boundary. If cleanup cannot be verified, the API returns `upload_cleanup_failed` when possible and emits only the value-free `official_usage_upload_cleanup_failed` operational event; inspect owned staging before retrying.

## API availability review

The Microsoft Graph [Copilot report API](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/resources/copilotreportroot) describes app adoption/activity, not the manually exported Copilot Agents per-agent/bridge/response datasets. Import does not call Graph reports. The separate [license/activity source](copilot-license-usage.md) uses `Reports.Read.All` and the current D28/v2 per-user detail CSV during supported Users collection; that activity never substitutes for imported agent usage.