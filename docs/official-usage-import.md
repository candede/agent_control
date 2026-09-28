# Official usage import

This runbook imports the Microsoft 365 admin-center Copilot Agents usage exports. These files are the only official per-agent and per-user usage authority in Agent Control. Do not substitute audit, Defender, telemetry, transcripts, package events or Microsoft 365 Copilot app-adoption Graph reports.

## One home for each workflow

The standalone **Official usage** page is retired. **Agents** owns agent usage and agent-scoped drilldowns; **Users** owns licensing and reported-user activity; **Sync** owns **Add CSV reports** and **Manage reports**. Importing is a focused upload dialog, not an approval wizard. Manage reports contains one saved-report list with viewing and confirmed deletion, displayed as stacked cards on narrow screens so actions remain visible without sideways scrolling. Use the report-set selector in Agents to explore an agent in different reports; there is no separate cross-import agent search in management. The read-only report inspector retains exact tenant totals, report-only rows, source-quality evidence, comparisons, and agent CSV exports.

| Workflow | Canonical bookmark |
| --- | --- |
| Retained report history and management | `/sync?reports=manage` |
| Add CSV reports | `/sync?reports=import`, optionally `&staging=ID` for explicit draft recovery |
| Read-only snapshot inspector within Manage reports | `/sync?reports=snapshot`, optionally `&snapshot=ID` and `&window=N` |

Old `/official-usage` bookmarks migrate automatically with this precedence:

1. A valid `staging=ID` opens Import reports for that draft, ahead of all other selectors.
2. Otherwise, `view=history` opens Manage reports even when `snapshot=ID` or `window=N` is also present.
3. Without `view=history`, `view=snapshot`, an exact `snapshot=ID`, or a valid `window=N` opens the snapshot inspector, preserving the relevant bounded snapshot/window values.
4. The default and `view=overview` without those selectors open Manage reports.

New accepted-import job links are not legacy history bookmarks: **View snapshot** emits `/sync?reports=snapshot&snapshot=ID` directly. A job without a retained snapshot opens `/sync?reports=manage`. Viewing a snapshot never selects it as current. These are navigation changes only: no source data is deleted, and the `/api/official-usage` APIs, import services, storage, authorization, and explicit selection/deletion confirmations remain unchanged.

## Export the three files

Use **Reports Reader** or another supported role with **user-level** Microsoft 365 usage-report access to download the original files. A summary-only reporting role is not sufficient for the Users and Users & agents files. This portal role is separate from **AgentControl.Admin**, which is required to import/manage the files in this app. **AgentControl.Viewer** is sufficient to read and export already accepted reports. See the [dedicated signed-in user role guide](user-roles-and-permissions.md#download-the-three-original-csvs-from-microsoft-365), including the separate report-name privacy requirement.

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

Agent IDs cannot contain embedded control characters, including tabs or line breaks: the import rejects them rather than stripping characters into a different identity. Quoted display names may still contain tabs and line breaks.

The CSVs do not contain reporting-period or source-as-of metadata columns. Agent Control imports **all rows**, derives the minimum and maximum available UTC last-activity dates, and labels that coverage `activity_range`. This is observed activity coverage, **not** the actual reporting window or proof of complete daily coverage. Different files may have different activity ranges; that does not make the bundle incompatible. Reports without dated activity remain importable with unknown coverage.

The source refresh time remains unknown. The app does not guess it from the filename, upload time, or last-activity date. Previously imported administrator-supplied periods remain labeled `operator_asserted`; API clients can still supply explicit metadata, but the import screen does not ask for it. Export all three files from the same Microsoft reporting selection: without period metadata, automatic import cannot prove that unrelated exports belong to the same reporting window.

Microsoft documents the following interpretation constraints:

- **Active users (licensed)** and **Active users (unlicensed)** are independent source categories. A license change can place one person in both categories during the selected period, so even one agent's distinct total can be less than their sum. Agent Control never adds them. Microsoft defines an active user as one who asks an agent a question and receives a response. Per-agent distinct active users come from exact, positive-response Users & agents identities; without companion rows for that agent the value is `Unknown`. Explicit zero-response rows remain reported relationships, but contribute zero active users. Tenant active-user totals deduplicate positive-response identities from Users and Users & agents without adding the two source counts.
- The drilldown's **Users with responses** metric follows the same per-agent evidence rule. It remains `Unknown` when the companion report is empty or contains only other agents, even though its reported relationship count is zero.
- Response values from Agents, Users & agents, and Users remain separate source totals. The headline response total uses Agents only and excludes bridge-only agents instead of creating a hybrid total.
- Computed report totals must fit the exact safe-integer range. If a total exceeds that range, the report returns an explicit `official_usage_total_limit` conflict rather than publishing a rounded number.
- In Users & agents, **Last activity date (UTC)** is when that agent was last used by anyone. It is preserved with that exact meaning and is not used as the named user's recency. User recency comes from the Users export and is `Unknown` when no Users row exists.
- Usernames can be anonymized according to Microsoft 365 report settings. They remain case-sensitive dataset-scoped identifiers and are never guessed back to people.

## Initial setup and retained history

The **Sync** page presents **CSV usage reports** separately from automatic sync and sync history. Its compact summary shows the saved-set count, **Observed activity dates (UTC)** across all retained complete sets, and last import time. The dates include all three CSV kinds and older reports, regardless of current selection or pagination; they are not administrator-supplied reporting windows. Undated reports show **No dates found in imported reports**. Dates are never inferred from import time, and the bounds do not imply continuous coverage or additive response totals.

The saved history API exposes the observed activity bounds as `summary.activityDateRange.earliestDateUtc` and `latestDateUtc`. It separately retains explicit reporting-window bounds as `summary.reportingWindows.earliestStartDateUtc` and `latestEndDateUtc`, both nullable `YYYY-MM-DD` values; inferred activity ranges do not contribute to those explicit bounds. Draft, incomplete, deleted and damaged sets are excluded, as are other tenants. The summary covers the whole retained history; per-bundle accounting is derived only from observations on the requested page. Imports and deletion update the compact summary automatically. A failed read hides unverified ranges and offers **Retry**; there is no routine refresh button. Viewers can inspect the summary and history; only Admins can import/delete.

Initial automatic sync collects Users, Graph packages, and Power Platform independently of manual CSV reports. Missing reports show **Import needed**, but do not keep a new automatic run or automatic-source setup incomplete. An Admin uploads the three companion exports; validation and publication then run automatically. Retained legacy four-source runs can still wait for their manual usage step; finish that import or cancel the waiting run before starting another sync. Saved-data browsing remains available while uploads or permissions are pending.

Ordinary uploads require no correction acknowledgement. Exact repeated content is deduplicated against non-deleted report sets; unchanged payloads can be reused while source associations and metadata remain available. Changed counts, names, activity values, or supplied source metadata create a new independent report set, even for an already imported reporting window. New sets become selected. The acceptance API preserves selection, revision, and original acceptance time for duplicates; the upload UI then uses the existing fenced selection API to show a reused older set. A concurrently changed selection requires an explicit **Use imported reports** recovery action rather than being silently overwritten. Content reuse does not establish cross-report user identity.

Deleting a report set does not prevent uploading those CSVs again. A fresh upload creates a new report set and import time without a restore or approval step; the previous record remains deleted. Retrying the original completed request cannot restore its deleted result or select a newer copy. The same rules apply before and after deleted data is purged by retention.

This preserves historical observations beyond Microsoft's rolling 7/30-day export window. It does not turn aggregate CSVs into event logs: adjacent exports overlap, and neither adding their response totals nor subtracting one snapshot from another establishes exact daily activity. Last-activity ranges do not establish report-window boundaries. Historical report views keep the original source metrics and lineage rather than presenting an invented all-time usage total.

Cross-import search is not presented in **Manage reports**. To compare an agent's usage across reports, open **Agents** and change its report-set selector. The retained overview API still unions exact, case-sensitive agent IDs from complete, accepted, non-deleted, integrity-valid bundles for API consumers, including agents absent from the latest import. Corrected/superseded sources do not contribute and do not revive when their replacement is deleted. Retention preserves a deleted correction's metadata while its original remains undeleted, even after purging unshared payloads; restore review also compares supersession state. Duplicate payloads and repeated memberships do not multiply counts, and no report username is joined across snapshots. Removing the management search UI does not change these storage or API contracts.

With no date filter, all retained activity evidence is considered. Start/end dates are inclusive UTC filters on each observation's agent last-activity date; older qualifying observations remain reachable even if the same agent has a newer observation outside the chosen range. The displayed date span is observed activity, not proof of continuous reporting coverage. The 30-day measure uses positive-response evidence with an agent activity date from UTC today minus 29 days through today, never the upload date. Stale/missing exports can understate current activity; missing history is shown as unknown, not zero tenant use.

Cross-import search matches literal text in retained agent IDs and names, ignoring case using the database locale, including non-ASCII letters in Unicode-aware locales. Case-distinct agent IDs remain separate identities, and `%` and `_` are ordinary search characters, not wildcards. Search and date filters affect the locator's agent list. This cross-report locator is historical evidence discovery, not an additive usage dashboard.

For example, response totals of 100 for June 1-30 and 120 for June 15-July 15 do not reveal the shared June 15-30 responses. The union could contain 120-220 responses. Removing identical CSV rows cannot resolve that ambiguity. Cumulative agent/activity evidence can span both imports, but exact response counts and exports stay in the **Manage reports** snapshot inspector. Exact interval totals require dated daily or event-level data, which these CSVs do not supply.

The Agents overview keeps four separate measures: agents in the saved repository and Power Platform inventory, including inaccessible agents; agents with a known unblocked package available to some/all users and no known native quarantine (across hosts, not only Teams); distinct report IDs with positive-response evidence **in the selected report set**; and IDs in that same set with positive-response evidence and last activity in the last 30 UTC calendar days. Changing the selected set updates the report cards, usage columns and user reporting together without merging snapshots. Creation or publication alone does not establish end-user access. Shared package versions count once per logical inventory agent. The first two cards clear table filters and show the matching repository/access list without navigating away. Missing access evidence has its own filter and is not labelled unavailable. Partial collection is noted inside the cards. The selected report's activity range, age and unknown-period status remain visible when usage columns are shown.

Full resync preserves accepted report history, including the Sync page's explicitly confirmed **Reset saved data** option. That option clears saved users and inventory, not official reports. Deleting reports remains a separate, explicitly confirmed Admin operation. Opening the uploader leaves Sync's jobs in place. **Cancel** returns to Sync; **OK** after a verified import closes the dialog and opens Agents with that report set selected.

## Add CSV reports

1. Sign in with `AgentControl.Admin`. Admin includes all Viewer access, including aggregate and user-level accepted report views.
2. Open **Sync > Add CSV reports** (`/sync?reports=import`). Every ordinary opening starts a fresh upload, even if a previous import finished or server-side drafts exist.
3. Drop the three original exports into the dialog or select **Choose CSV files**. Files must be CSVs, at most 8 MiB each. Companions may also be added in separate picker operations. No dates, correction checkbox, or approval step is required.
4. Validation starts immediately. Each filename shows checking, validated report type and row count, or an actionable error. Valid companions remain in the same bundle; **Add CSV files** or **Choose replacement CSVs** supplies missing/rejected reports. **Start over** removes this draft's unaccepted staging if a validated file needs replacing.
5. Once all three kinds validate and no selected file is rejected, the UI obtains a fresh bundle preview and imports automatically. The server still checks the content hash and selection revision and publishes all companions atomically. Hashes, parser versions, storage accounting, and informational source warnings are not an approval screen; source differences remain available in report details.
6. The UI verifies the exact saved report and its selection using fresh reads. It does not substitute a different report or call a failed read success. **Reports imported** (or **Reports already imported**) has one action: **OK**, which rechecks the destination, closes the dialog, and opens Agents. A deletion or another administrator's selection change while the success screen was open is reported rather than silently opening a different set. If verification fails after saving, **Retry** checks the saved result without uploading or importing twice.

The success screen includes a compact **Agents**, **Users**, and **Responses** summary from that exact report set. Agent and user counts are records in their respective CSVs, including zero-response records, not inventory or active-user totals. Responses use the Agents CSV only; overlapping totals from the three exports are never added. Statistics use the full saved reports, not the one-row verification page, and do not add another approval step.

**Cancel**, including Escape before publication, stops subsequent uploads/publication, cancels an in-flight upload, removes this draft's unaccepted staging, and restores focus to the opener. Cleanup failures remain visible and retryable. During publication or verification, cancellation is disabled because it cannot undo a committed import. For a saved or uncertain result, **Back to Sync** leaves the view without claiming to cancel saved data. Leaving the page stops follow-up requests; abandoned staging retains its server expiry. The compact dialog scrolls its body when needed rather than stretching an empty result to a fixed full-page height.

Changing account, losing import access, or opening a different staging link unmounts the old importer and stops follow-up uploads, reads, and refresh callbacks. An already submitted mutation may have completed server-side, so check saved reports before re-uploading. Authorization failures clear file evidence and import actions. Explicit staging links recover only their exact draft; a complete recovered draft requires **Continue import**, not publication merely by opening its link.

Successful companions survive a partial file failure; an entirely rejected upload does not look up a nonexistent bundle. Uploads send `rejectDuplicateKind=true`: a second file of a type is rejected before replacing existing data. Choose replacement files or start over; no import occurs while any chosen file is rejected. The server, not filenames, identifies report types. Without period metadata it cannot prove that three different types came from the same reporting window, so the prompt asks for exports from the same Microsoft selection.

An uncertain publication response offers **Retry**, which replays only the original hash/revision intent. A definite stale-fence rejection gets a fresh preview only on explicit retry. Resumed legacy corrections keep their original target with a concise warning. Start over to create an independent import. Supplied period/source metadata is inherited by new companions, never replaced with guessed dates.

## Choose the report set shown in Agents and Users

Admins have a **Report set** dropdown on Agents and on the usage cohorts in Users. On Agents it occupies the third position beside **Microsoft 365 catalog** and **Additional Power Platform agents**, replacing the Combined inventory shortcut. Choosing a retained three-file set applies it immediately, without Apply or Refresh buttons or persistent helper text. This changes the tenant-wide selection for all viewers, not a private local filter; inventory collection and directory licensing are unaffected. The selector labels known windows separately from observed activity dates and includes a short reference to distinguish identical ranges; import dates are omitted from the dropdown and its tooltip. Older/newer pages make every retained set reachable, including sets outside the first 100 admin metadata entries. Existing combined-inventory URLs remain readable.

Changing the dropdown obtains a fresh preview, checks the reviewed shared revision, then confirms that exact selection. The dropdown is disabled while saving. Stale selections, failed reads and uncertain mutation responses display an error with an on-demand **Retry** action that reloads authoritative state rather than repeating a consumed confirmation. Accepted selection invalidates agent/user report consumers even if the subsequent metadata refresh fails. Selection also exits any pinned historical Users link; merely inspecting a historical snapshot remains read-only.

## Manage retained reports

**Sync > Manage reports** (`/sync?reports=manage`) is one paginated list showing import time, activity dates, report/row counts, and current/saved status. **View report** is read-only for both roles. Only Admins see **Add CSV reports**, deletion, and any legacy incomplete-import recovery action. There are no import/management tabs, routine refresh buttons, current-snapshot shortcut, technical accounting accordions, or cross-import search. Selection belongs to the Agents/Users report-set dropdown. History reloads on opening, mutations, and window focus; failed reads offer **Retry** and disable actions on unverified rows. Deletion has a separate native confirmation explaining whether it clears the selected report.

Legacy browser data is never silently read, migrated, or deleted. **Remove old browser data** appears in Manage reports only when such data exists. It records an explicit discard acknowledgement before removing the exact legacy key; failed acknowledgements leave storage untouched.

Exact retries use a finite content-free receipt containing tenant, actor, bundle, original hash/revision and original result. They return that result after staging cleanup without republishing or reselecting anything; changed intent fails. Acceptance explicitly reports `reusedExistingSet`, and the UI verifies that exact set even outside the bounded admin list. Selecting it for viewing is a separate fenced request; uncertain selection responses are checked before retrying, not replayed against a consumed token. Legacy explicit corrections retain supersession semantics; ordinary imports never create corrections. Deleting the selected set clears selection without choosing an older set automatically.

## Inspect retained snapshots and source evidence

The read-only snapshot inspector inside **Sync > Manage reports** owns exact tenant-wide source reporting, not current inventory analysis or user profiles/license follow-up. It starts with one selected snapshot, three snapshot-scoped headline measures (Agents-export responses, distinct positive-response report identities, and reported agents), and one **Agent comparison** table. Raw report-only rows remain available even without an inventory match. Search and creator filters, plus most responses, most active users, fewest responses, latest activity, and name ordering, apply to the complete dataset before its 25-row pages. Unknown reach sorts after known counts, including explicit zero. Exact `snapshot` links and valid legacy `window` links keep their single-snapshot semantics; `/sync?reports=snapshot` opens the current snapshot when no exact selection is supplied. Catalog state remains an inventory concern, not an official usage measure.

Open an agent's name to inspect its exact report ID, separate licensed/unlicensed source categories, and reconciliation. **Report quality & sources** expands source authority, freshness, versions, file warnings, and interpretation limits; **Source totals differ** remains visible when totals disagree. Technical details do not expand automatically.

The **Manage reports** list omits storage accounting, duplicate payload counts, hashes, and lineage; these remain in API/storage contracts. **Report details** has one **Back to reports** action rather than refresh/current-snapshot shortcuts. Viewing a report pins subsequent queries and CSV export to that set without changing the tenant's selection. History and the inspector are readable by Viewers and Admins; importing, corrections, selection and deletion remain Admin operations. Failed reads remain explicit and disable unverified actions. A failed next-page read never relabels the previous page and offers a return to the first page.

Current agent usage belongs to **Agents**; person-level analytics, licensing, and user CSV export belong to **Users**. Use the primary navigation for those workspaces, Permissions, and Audit. Provider collection, **Import reports**, and **Manage reports** all belong to **Sync**. Exact contextual links from an agent or user to its retained source snapshot open the Sync inspector rather than another usage dashboard.

A snapshot dashboard includes all its rows, including undated and zero-response rows; the accumulated history preserves previous snapshots separately. Optional date filters are applied **after import** to the last-activity values. The CSVs are aggregate snapshots, not daily activity logs: filtering a row by its last-activity date does not turn its full-export response count into a count for the selected interval.

| Source | Information available for analysis |
| --- | --- |
| Agents | Every agent ID, name, creator type, licensed and unlicensed active-user category, response total, and agent-wide last-activity date |
| Users | Every reported username, display name, agent count, responses received, and the user's last-activity date |
| Users & agents | Each reported user-agent relationship, agent ID/name/creator, response count, and the agent-wide last-activity date |

Response totals and agent counts from the Users export are shown separately from the user-agent relationship totals when they disagree. A source discrepancy is a data-quality signal, not a reason to discard rows or overwrite one report with another. Identifiers seen in only one report remain available with their missing-source status.

### Explore adoption from Agents and Users

- **Sync > Manage reports** locates reported agents across imports and opens an exact report's response and user breakdown in the snapshot inspector, independently of saved inventory. A report identity never grants access-control targets.
- Inventory agent modals are strictly agent-scoped. Their Overview and **Usage & users** tabs never substitute tenant totals or unrelated report comparisons. Inventory usage automatically matches the active report's full Agent ID to a current authorized Graph package ID and its existing canonical agent (see below). Missing matches remain unknown, not zero; names and IDs from other namespaces are not fallback keys.
- **Users > Paid M365 Copilot users** is the default directory-backed roster, including paid users with zero or unavailable activity. The dropdown's second view, **Active users without paid Copilot**, contains only exactly verified current non-paid users with positive Users-report or Users & agents responses. Unknown licensing is excluded with a coverage notice; it is not treated as unpaid. Both views have searchable, paginated per-user agent drilldowns. There is no tenant-wide agent-column limit.
- An explicit zero is reported evidence. Missing relationships or Users-report totals remain unknown, not evidence of inactivity or blocked access. User responses and agents-used values come from the Users report; bridge totals remain separate in details. Missing Users-report metrics sort last in either direction, rather than silently ranking an alternate source.
- Drilldown links carry the report snapshot so changing the tenant's selected report cannot silently change their meaning. **Use current reports** is an explicit switch. The unpaid cohort always uses current saved license evidence, regardless of the report period; historical licensing is not tracked. Unmatched/ambiguous identities remain unknown. Rich directory details require an existing unique link for the same report set and versions, not a display-name heuristic.
- Saved report reads are bounded and do not call inventory providers: `GET /api/official-usage/overview` returns agent/activity counts and a filtered page, accepting `scope=history|selected` (default `history`), `search`, inclusive `startDate`/`endDate`, `sortBy=agentName|lastActivity`, `sortDirection`, `limit`, and `offset`. Agents uses `scope=selected`; the historical locator uses `history`. Selecting a legacy superseded set shows that exact set without reviving it in historical evidence. No selection yields no selected evidence, never a fallback to history. The response contains no cumulative response totals or cross-snapshot user joins. `GET /api/official-usage/agents/:agentId` accepts `setId`, user `search`, `sortBy`, `sortDirection`, `limit`, and `offset`. `GET /api/official-usage/users` and its CSV endpoint accept an optional exact, case-sensitive `agentId` and `licenseCohort=active_without_paid` before paging/export. The license cohort reads the signed-in principal's saved directory evidence; unfiltered report analytics remain unchanged. User-level totals remain all-agent totals even under these filters. Viewer and Admin use the existing report-read authorization.
- Aggregate JSON and CSV support `sortBy=activeUsers`, based on distinct positive-response companion identities, never the sum of licensed and unlicensed source categories. User `agentId`, `creatorType`, and `responsesOnly` filters must match the same relationship; activity on a different agent cannot qualify a selected zero-response relationship.
- Report detail, users, aggregate, history, and CSV queries reject unsupported, repeated, or structured parameters before reading saved data. A report selection is one exact `setId`, never the first value of an ambiguous query.

Filtered agent and user CSV downloads preserve these source distinctions and export all matching results, not just the visible page. User filters select people: the user download includes **all agent relationships of matching users**, even when an agent, creator, or response-producing relationship selected those users. It has one row per reported user-agent relationship, or one row with empty agent fields when the user has no relationship rows. User-level totals repeat on relationship rows; do not sum those repeated totals as though they were per-agent counts. Downloads use the exact displayed report set and applied filters; pending, failed, or superseded reads cannot export old results under new controls. Cancelling an agent export releases its busy state immediately, even if the superseded transport completes late; only a new export for the verified displayed result may download.

### Match inventory usage automatically

Saved Microsoft 365 exports and Graph package observations share a full package identifier, including prefixes such as `T_` and `P_`. Inventory usage compares the complete, case-sensitive report `agentId` with the Graph package `id` within the tenant and the viewer's current authorized saved source memberships. It does not strip prefixes, case-fold opaque IDs, compare names, or search arbitrary identifier fields. A report ID is not treated as an Entra application ID, manifest ID, canonical UUID or Power Platform native ID.

The identity chain is **report Agent ID -> exact Graph package ID -> existing canonical agent -> already established Power Platform membership**, when available. Package-to-native resolution continues to use its own source-declared metadata, environment scope and ambiguity checks; usage matching does not create or widen that link. For example, supported declarative-agent links use a package manifest ID corroborated by the native resource ID and schema name, not a report ID guessed from the native GUID. Multiple distinct package/report IDs on one logical agent are counted once each. Conflicting canonical owners of a source identity fail explicitly rather than arbitrarily receiving the report's metrics.

Matching is computed during saved inventory reads before filtering, sorting, pagination and export. It writes no associations, changes no inventory, calls no provider, and needs no per-agent setup. A newly selected snapshot is matched again using its own rows, not an inherited total from earlier imports. The modal and CSV expose `basis: "exact_package_id"` for automatic matches; no review timestamp or administrator verification is invented. Report-only browsing remains available for IDs not present in inventory.

#### Compatibility for existing reviewed associations

Previously stored administrator-reviewed mappings remain explicit overrides for their exact report ID and set, including when their source is temporarily unavailable. Automatic matching never silently reassigns them to another target. They retain `basis: "admin_reviewed"` and `reviewedAt`, and are distinguished from automatic matches. The modal no longer asks users to create an association as routine setup. The existing Admin-only, confirmed API remains available for reviewing or repairing legacy mappings:

| Route | Contract |
| --- | --- |
| `GET /api/agent-inventory/:recordId/usage-candidates` | Admin only; explicit candidate browsing, optional `search` (256 characters), `offset` (0–100,000), `limit` (1–250, default 50). Returns only Agents-export rows, an `associated` flag for stored reviewed mappings, and active report context. No user rows or provider calls. |
| `POST /api/agent-inventory/:recordId/usage-associations` | Admin and CSRF; exact `reportSetId`, case-sensitive `reportAgentId`, source-qualified `target`, `expectedInventoryRevision`, `expectedUsageRevision`, and literal `confirmed: true`. |
| `DELETE /api/agent-inventory/:recordId/usage-associations` | Admin and CSRF; the same confirmed revision/set/report identity fields, without `target`. Only an association resolving to this currently authorized agent can be removed. |

Graph targets are `{ source: "graph_packages", packageId }`; Power Platform targets are `{ source: "power_platform", nativeId, environmentId }`, with an explicit `null` for an absent environment. A canonical UUID is a navigation reference, **not** an association target. Unknown fields and malformed identifiers, revisions, confirmation values, or paging are rejected. Candidate searches and association identifiers must contain well-formed Unicode without C0/C1 control characters; malformed text is rejected before saved-data reads or auditing, never repaired into a different identity. Successful mutations return `{ context }` only after commit; refresh the inventory before another review.

The selected report set, versions and artifacts must remain unexpired through usage publication. Association mutations recheck the same active report after writing; an expired reread cannot commit a change with an unavailable report context. Association changes and their success audit commit together or roll back together. Saved-inventory reads recheck usage expiry after enrichment and transaction completion; CSV publication carries the report expiry through its final revision checks. The browser rejects responses that expired in transit instead of caching them as current.

Stored reviewed associations are shared within a tenant but bind to **one immutable report set and one exact native source**, never to the reviewer's private canonical UUID. Another viewer sees metrics only when that same native source is present in their current authorized saved inventory. Package IDs and opaque native IDs are case-sensitive; Power Platform GUIDs and environments follow the existing inventory identity normalization. Each reviewed report ID has one target per tenant/set; reassignment requires explicit removal first. Multiple distinct report identities may attach to one logical inventory agent. A new active report set does not inherit old reviewed associations; its automatic exact-package matches are evaluated independently.

Linked responses sum each associated Agents-export identity once, within the active set only. The latest Agents-export activity date is preserved. Active users are the union of exact, case-sensitive **positive-response** Users & agents identities, deduplicated across associated report identities. Licensed and unlicensed categories are never added. If any associated identity lacks companion evidence, its combined active-user metric is unknown; an explicit zero-response companion row yields zero. Unavailable reports and unlinked records use null metrics, not zero. Source lineage, stale status, unknown freshness, and `activity_range` provenance remain visible; no overlapping-period or all-time total is invented.

Associations never create, authorize, or alter native management targets, provider capability evidence, directory identities, or saved inventory. Candidates and writes read only saved data.

#### Atomicity, revision fences, and cleanup

Association operations take transaction-scoped locks in the same order as inventory reconciliation: `package-refresh:<tenant>:<principal>`, `power-platform:<tenant>:<principal>`, then `official-usage:<tenant>`. They validate current source membership, the exact active report set, usage revision, and combined inventory revision in that transaction. Report row locks additionally fence operator retention. The mutation and successful administrative audit receipt commit together; audit failure rolls the mutation back. Rejected attempts retain a failed audit receipt when the database remains available.

Usage revisions hash the active selection revision, report-set/lineage/content identities, freshness state, and tenant association revision. Association insert/delete advances a monotonic revision, including remove/re-add cycles. Combined inventory revisions include the private source revision and usage revision, so report replacement, deletion, expiry, and association edits invalidate old reviewed/export selections. Unexpected database failures fail explicitly rather than yielding an empty successful projection.

Inventory integration calls `agentUsage.project(scope, records, client)` once after canonical reconciliation and before filtering or paging. Export revalidation reads the base inventory revision and `agentUsage.revision(scope, client)` on the same locked inventory transaction, then compares `combineAgentInventoryRevision(base, usage)`. Separate unlocked base/report reads are not an atomic publication fence. Existing standalone official-report reads retain their accepted-history compatibility; the transaction-compatible read used by inventory associations explicitly enforces report-set, version, and artifact expiry.

Deleting a report set removes its associations immediately in the same transaction; physical set deletion also cascades. Bounded operator retention removes associations for expired/deleted sets. Accepted history has no default time expiry; associations on unselected but retained sets stay scoped to those sets and can reappear only if that exact set is selected again. Principal inventory cleanup does not delete another viewer's tenant report associations, but absent sources never receive metrics. Tenant association revision counters contain no report/user payload and remain to prevent revision reuse.

For IT license reviews:

1. Sort users by responses to see the most and least active reported users. Use a configurable low-response threshold to assemble a review cohort, and inspect each user's agent breakdown and creator types.
2. Review zero-response, low-response, and stale-activity signals separately. A blank last-activity date means unknown, not inactive. User recency must come from Users, never from the agent-wide date on a Users & agents row.
3. Inspect discrepancies before acting and retain the source totals in exported review data.
4. Confirm the person's paid Microsoft 365 Copilot service is enabled, not merely that a containing product is assigned, and review broader Copilot activity, role, and business need using your approved administration workflow before reclaiming or reallocating a license.

**These exports cannot identify every unused Microsoft 365 Copilot license.** They do not include a tenant license roster, per-person license assignment, or all Copilot use in Word, Excel, Teams, Outlook, and other apps. A user absent from the files cannot be classified as having zero usage. Even a reported user with zero agent responses may use Copilot elsewhere. The exports alone cannot establish a user's license status; the Users view adds separately saved directory context only through a verified user link. Low agent usage is a candidate for review, not an automatic unassignment recommendation. Licensed and unlicensed agent-level categories cannot be joined back to individual users.

## Export compatibility check

The three supplied September 12, 2026 exports were checked against the header registry: all 7 Agents columns, 6 Users & agents columns, and 5 Users columns match. UTF-8 BOMs, quoted English UTC dates, and quoted comma-grouped counts are supported. No additional CSV columns are silently ignored.

English dates accept complete month names and standard three-letter abbreviations (also `Sept`), case-insensitively; unrecognized names are rejected rather than matched by prefix. Users-export agent-count and response-count totals are checked independently against the safe-integer limit, never added together.

Agent IDs containing embedded carriage returns or line feeds are rejected during validation because they cannot be used by the report drilldown or agent filters. Quoted multiline agent names remain supported.

The supplied snapshot contains 244 agents, 517 user-agent relationships, and 300 users, with observed UTC last activity from August 14 through September 12. Agents and Users & agents each report 9,693 responses; Users reports 9,697. One user's source totals differ. There are 145 reported users with 1-5 responses and no zero-response rows in this Users export. This does **not** establish that the tenant has no inactive license holders.

## Limits and retention

Existing installations must apply schema migrations through 38 using the normal [deployment workflow](deployment-setup.md) before starting the updated runtime. Migration 29 backfills deduplicated report payloads and semantic content identities while preserving existing lineage; migration 30 adds private source-sync and saved user data; migration 31 adds explicitly admitted, principal-scoped clean resync while preserving accepted usage reports; migrations 32–33 add the canonical registry and saved-inventory verification; migration 34 adds reviewed reporting-only agent usage associations and audit actions. The pre-existing migration 35 adds saved agent-people data. Migration 36 permits clean-full source admission for the three automatic sources while preserving support for legacy four-source runs; it does not change cleanup scope or accepted-report retention. Migration 37 resets cached Users-sync data for a fresh Copilot service scan, without deleting imported reports or their associations. Migration 38 changes only package access-canary qualification uniqueness; reports and their associations are unaffected. Earlier migrations and their checksums are unchanged. Use the migration operator, not the restricted runtime database role. Runtime grants permit association insert/delete, not reassignment updates or revision-counter writes; readiness verifies that boundary. No in-app full resync applies migrations or wipes the database.

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

Run ordinary [operator retention](operations.md#retention) at least daily while the POC is active. Load the existing internal helper and use its exact project/database confirmation, preview and bounded-batch safeguards as documented there. Retention is not a `deploy-local.ps1` argument.

`OFFICIAL_USAGE_STALE_AFTER_DAYS` defaults to 35 and accepts 1 through 365. Staleness uses the age of the available coverage endpoint and the accepted-set age; an absent activity date is not evidence of a fresh source. Never treat `unknown` source freshness as current.

## Failure recovery

- A malformed, incompatible or schema-drift file is rejected without changing the active set. Correct the input and stage that kind again in the same bundle.
- A missing companion leaves the bundle unpublished. Choose the missing CSVs; import continues automatically once all three types validate.
- A stale bundle hash or active revision returns a conflict. **Retry** gets a fresh preview after a definite rejection; an uncertain response instead replays the original request.
- A partial cancellation failure remains visible. **Retry** cleans up only this draft's remaining staging before closing.
- Expired staging cannot be accepted. Re-export when freshness matters and stage the original files again.
- Upload timeout/disconnect cancels publication at the transaction boundary. If cleanup cannot be verified, the API returns `upload_cleanup_failed` when possible and emits only the value-free `official_usage_upload_cleanup_failed` operational event; inspect owned staging before retrying.
- If the legacy browser notice appears, its value was not read or migrated. Re-import the original files and acknowledge removal, or explicitly acknowledge discard. Only the exact legacy key is removed; unrelated browser storage remains.

## API availability review

The current Microsoft Graph [`copilotReportRoot`](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/reports/resources/copilotreportroot) lists exactly three `v1.0`/`beta` methods: `getMicrosoft365CopilotUserCountSummary`, `getMicrosoft365CopilotUserCountTrend`, and `getMicrosoft365CopilotUsageUserDetail`. They cover licensed Microsoft 365 Copilot app adoption/activity, not the Copilot Agents report's per-agent rows, user-agent bridge, licensed/unlicensed active-user categories and responses. The import feature does not call those methods. The separate [license usage dashboard](copilot-license-usage.md) requests `Reports.Read.All` and calls only the per-user D30 detail report on explicit snapshot load; it does not substitute that app activity for Copilot Agents metrics.